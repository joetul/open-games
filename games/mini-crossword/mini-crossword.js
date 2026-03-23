import { formatTime, saveToStorage, loadFromStorage } from '../../shared/js/utils.js';
import { getRandomPuzzle, getPuzzleById, markPlayed } from './puzzle-loader.js';

// ─── State ───────────────────────────────────────────────────────────────────

let currentPuzzle = null;
let gridSize = 5;
let solutionGrid = [];   // 2D: solutionGrid[r][c] = 'A'-'Z'
let playerGrid = [];     // 2D: playerGrid[r][c] = '' or 'A'-'Z' or '#'
let revealedCells = [];  // 2D: true if cell was revealed
let selectedCell = null; // { row, col }
let direction = 'across';
let activeClue = null;
let cellToClue = [];     // 2D: cellToClue[r][c] = { across: clue|null, down: clue|null }
let numberMap = {};      // "r,c" -> clue number
let timerSeconds = 0;
let timerInterval = null;
let timerPaused = false;
let gameWon = false;

// ─── DOM References ─────────────────────────────────────────────────────────

const gridEl = document.getElementById('crossword-grid');
const acrossListEl = document.getElementById('clues-across');
const downListEl = document.getElementById('clues-down');
const timerDisplay = document.getElementById('timer-display');
const timerEl = document.getElementById('timer');
const pauseIcon = document.getElementById('pause-icon');
const playIcon = document.getElementById('play-icon');
const clueLabelEl = document.getElementById('clue-label');
const clueTextEl = document.getElementById('clue-text');
const toastContainer = document.getElementById('toast-container');
const loadingOverlay = document.getElementById('loading-overlay');

// ─── Toast ──────────────────────────────────────────────────────────────────

function showToast(message, duration = 2000) {
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  toastContainer.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('fade-out');
    setTimeout(() => toast.remove(), 400);
  }, duration);
}

// ─── Puzzle Loading ─────────────────────────────────────────────────────────

function buildCellToClue(puzzle) {
  const size = puzzle.size;
  cellToClue = Array.from({ length: size }, () =>
    Array.from({ length: size }, () => ({ across: null, down: null }))
  );

  for (const clue of puzzle.clues.across) {
    for (let i = 0; i < clue.length; i++) {
      cellToClue[clue.row][clue.col + i].across = clue;
    }
  }
  for (const clue of puzzle.clues.down) {
    for (let i = 0; i < clue.length; i++) {
      cellToClue[clue.row + i][clue.col].down = clue;
    }
  }
}

function buildNumberMap(puzzle) {
  numberMap = {};
  for (const clue of puzzle.clues.across) {
    numberMap[`${clue.row},${clue.col}`] = clue.number;
  }
  for (const clue of puzzle.clues.down) {
    numberMap[`${clue.row},${clue.col}`] = clue.number;
  }
}

function loadPuzzle(puzzle) {
  currentPuzzle = puzzle;
  gridSize = puzzle.size;
  gameWon = false;

  // Parse grid
  solutionGrid = puzzle.grid.map(row => row.split(''));
  playerGrid = solutionGrid.map(row => row.map(c => c === '#' ? '#' : ''));
  revealedCells = solutionGrid.map(row => row.map(() => false));

  buildCellToClue(puzzle);
  buildNumberMap(puzzle);

  // Try to restore progress
  const saved = loadFromStorage(`mini-crossword-progress-${puzzle.id}`);
  const validSave = saved
    && Array.isArray(saved.playerGrid)
    && saved.playerGrid.length === gridSize
    && saved.playerGrid.every(row => Array.isArray(row) && row.length === gridSize);
  const validRevealed = validSave
    && Array.isArray(saved.revealedCells)
    && saved.revealedCells.length === gridSize
    && saved.revealedCells.every(row => Array.isArray(row) && row.length === gridSize);
  if (validSave) {
    playerGrid = saved.playerGrid;
    revealedCells = validRevealed ? saved.revealedCells : revealedCells;
    timerSeconds = saved.timerSeconds ?? 0;
    if (saved.selectedCell) selectedCell = saved.selectedCell;
    if (saved.direction) direction = saved.direction;
  } else {
    selectedCell = null;
    direction = 'across';
    timerSeconds = 0;
  }

  timerPaused = false;
  renderGrid();
  renderClues();

  // Select first cell if none saved
  if (!selectedCell) {
    selectFirstCell();
  } else {
    updateActiveClue();
    updateHighlights();
  }

  if (checkWin()) { onWin(); return; }
  startTimer();
  markPlayed(puzzle.id);
  saveToStorage('mini-crossword-last-id', puzzle.id);
}

function selectFirstCell() {
  if (currentPuzzle.clues.across.length > 0) {
    const first = currentPuzzle.clues.across[0];
    selectedCell = { row: first.row, col: first.col };
    direction = 'across';
    updateActiveClue();
    updateHighlights();
  }
}

// ─── Grid Rendering ─────────────────────────────────────────────────────────

function renderGrid() {
  gridEl.innerHTML = '';
  gridEl.style.gridTemplateColumns = `repeat(${gridSize}, 1fr)`;

  for (let r = 0; r < gridSize; r++) {
    const rowDiv = document.createElement('div');
    rowDiv.setAttribute('role', 'row');
    rowDiv.style.display = 'contents';

    for (let c = 0; c < gridSize; c++) {
      const cell = document.createElement('div');
      cell.className = 'cw-cell';
      cell.dataset.row = r;
      cell.dataset.col = c;

      cell.setAttribute('role', 'gridcell');

      if (solutionGrid[r][c] === '#') {
        cell.classList.add('black');
        cell.setAttribute('aria-hidden', 'true');
      } else {
        // Number
        const num = numberMap[`${r},${c}`];
        if (num) {
          const numSpan = document.createElement('span');
          numSpan.className = 'cell-number';
          numSpan.textContent = num;
          cell.appendChild(numSpan);
        }

        // Letter
        const letterSpan = document.createElement('span');
        letterSpan.className = 'cell-letter';
        letterSpan.textContent = playerGrid[r][c];
        cell.appendChild(letterSpan);

        const letter = playerGrid[r][c] || 'empty';
        cell.setAttribute('aria-label', `Row ${r + 1}, Column ${c + 1}, ${letter}`);

        if (revealedCells[r][c]) cell.classList.add('revealed');

        cell.addEventListener('click', () => onCellClick(r, c));
      }

      rowDiv.appendChild(cell);
    }

    gridEl.appendChild(rowDiv);
  }
}

function getCell(r, c) {
  return gridEl.children[r]?.children[c] ?? null;
}

function updateCellDisplay(r, c) {
  const cell = getCell(r, c);
  if (!cell || solutionGrid[r][c] === '#') return;

  const letterSpan = cell.querySelector('.cell-letter');
  if (letterSpan) letterSpan.textContent = playerGrid[r][c];

  const letter = playerGrid[r][c] || 'empty';
  cell.setAttribute('aria-label', `Row ${r + 1}, Column ${c + 1}, ${letter}`);

  cell.classList.toggle('revealed', revealedCells[r][c]);
}

// ─── Clue Rendering ─────────────────────────────────────────────────────────

function renderClues() {
  acrossListEl.innerHTML = '';
  downListEl.innerHTML = '';

  for (const clue of currentPuzzle.clues.across) {
    const li = createClueItem(clue, 'across');
    acrossListEl.appendChild(li);
  }

  for (const clue of currentPuzzle.clues.down) {
    const li = createClueItem(clue, 'down');
    downListEl.appendChild(li);
  }
}

function createClueItem(clue, dir) {
  const li = document.createElement('li');
  li.dataset.direction = dir;
  li.dataset.number = clue.number;

  const numSpan = document.createElement('span');
  numSpan.className = 'clue-num';
  numSpan.textContent = clue.number;

  li.appendChild(numSpan);
  li.appendChild(document.createTextNode(clue.clue));

  li.addEventListener('click', () => {
    if (gameWon || timerPaused) return;
    direction = dir;
    selectClue(clue);
  });

  return li;
}

// ─── Selection & Navigation ─────────────────────────────────────────────────

function onCellClick(r, c) {
  if (gameWon || timerPaused) return;

  // If clicking the already-selected cell, toggle direction
  if (selectedCell && selectedCell.row === r && selectedCell.col === c) {
    const cc = cellToClue[r][c];
    if (cc.across && cc.down) {
      direction = direction === 'across' ? 'down' : 'across';
    }
  } else {
    selectedCell = { row: r, col: c };
    // If cell only has one direction, use that
    const cc = cellToClue[r][c];
    if (cc.across && !cc.down) direction = 'across';
    else if (!cc.across && cc.down) direction = 'down';
  }

  updateActiveClue();
  updateHighlights();
  focusHiddenInput();
}

function selectClue(clue) {
  direction = currentPuzzle.clues.across.includes(clue) ? 'across' : 'down';

  // Find first empty cell in word, or first cell if all filled
  let target = null;
  for (let i = 0; i < clue.length; i++) {
    const r = direction === 'across' ? clue.row : clue.row + i;
    const c = direction === 'across' ? clue.col + i : clue.col;
    if (playerGrid[r][c] === '') {
      target = { row: r, col: c };
      break;
    }
  }
  if (!target) target = { row: clue.row, col: clue.col };

  selectedCell = target;
  updateActiveClue();
  updateHighlights();
  focusHiddenInput();
}

function updateActiveClue() {
  if (!selectedCell) return;
  const cc = cellToClue[selectedCell.row][selectedCell.col];

  // Use current direction if available, otherwise flip
  if (cc[direction]) {
    activeClue = cc[direction];
  } else {
    const other = direction === 'across' ? 'down' : 'across';
    if (cc[other]) {
      direction = other;
      activeClue = cc[other];
    } else {
      activeClue = null;
    }
  }

  // Update clue bar
  if (activeClue) {
    const dirLabel = direction === 'across' ? 'A' : 'D';
    clueLabelEl.textContent = `${activeClue.number}${dirLabel}`;
    clueTextEl.textContent = activeClue.clue;
  } else {
    clueLabelEl.textContent = '';
    clueTextEl.textContent = '';
  }
}

// ─── Highlights ─────────────────────────────────────────────────────────────

function updateHighlights() {
  // Clear all highlights
  for (const cell of gridEl.querySelectorAll('.cw-cell')) {
    cell.classList.remove('selected', 'active-word');
  }

  // Clear clue list highlights
  for (const li of acrossListEl.children) li.classList.remove('active');
  for (const li of downListEl.children) li.classList.remove('active');

  if (!selectedCell || !activeClue) return;

  // Highlight active word cells
  for (let i = 0; i < activeClue.length; i++) {
    const r = direction === 'across' ? activeClue.row : activeClue.row + i;
    const c = direction === 'across' ? activeClue.col + i : activeClue.col;
    getCell(r, c)?.classList.add('active-word');
  }

  // Highlight selected cell
  getCell(selectedCell.row, selectedCell.col)?.classList.add('selected');

  // Highlight active clue in list
  const listEl = direction === 'across' ? acrossListEl : downListEl;
  for (const li of listEl.children) {
    if (parseInt(li.dataset.number) === activeClue.number) {
      li.classList.add('active');
      li.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      break;
    }
  }
}

// ─── Keyboard Input ─────────────────────────────────────────────────────────

function handleKeydown(e) {
  if (gameWon || timerPaused || !selectedCell) return;

  const key = e.key;

  // Letter input
  if (/^[a-zA-Z]$/.test(key)) {
    e.preventDefault();
    placeLetter(key.toUpperCase());
    return;
  }

  switch (key) {
    case 'Backspace':
      e.preventDefault();
      handleBackspace();
      break;
    case 'Delete':
      e.preventDefault();
      deleteCurrent();
      break;
    case 'ArrowLeft':
      e.preventDefault();
      moveSelection(0, -1);
      break;
    case 'ArrowRight':
      e.preventDefault();
      moveSelection(0, 1);
      break;
    case 'ArrowUp':
      e.preventDefault();
      moveSelection(-1, 0);
      break;
    case 'ArrowDown':
      e.preventDefault();
      moveSelection(1, 0);
      break;
    case 'Tab':
      e.preventDefault();
      moveToNextClue(e.shiftKey);
      break;
    case ' ':
      e.preventDefault();
      clearCellDisplay(selectedCell.row, selectedCell.col);
      saveProgress();
      moveToNextInWord();
      break;
  }
}

function placeLetter(letter) {
  const { row, col } = selectedCell;
  if (solutionGrid[row][col] === '#') return;

  // Clear error/correct state
  getCell(row, col)?.classList.remove('error', 'correct');

  playerGrid[row][col] = letter;
  revealedCells[row][col] = false;
  updateCellDisplay(row, col);
  getCell(row, col)?.classList.remove('revealed');

  saveProgress();
  moveToNextInWord();

  if (checkWin()) {
    onWin();
  }
}

function handleBackspace() {
  const { row, col } = selectedCell;
  if (playerGrid[row][col] !== '') {
    // Delete current cell's letter
    clearCellDisplay(row, col);
    saveProgress();
  } else {
    // Move back and delete that cell's letter
    moveToPrevInWord();
    const { row: nr, col: nc } = selectedCell;
    if (nr !== row || nc !== col) {
      clearCellDisplay(nr, nc);
      saveProgress();
    }
  }
}

function clearCellDisplay(r, c) {
  playerGrid[r][c] = '';
  revealedCells[r][c] = false;
  updateCellDisplay(r, c);
  getCell(r, c)?.classList.remove('error', 'correct', 'revealed');
}

function deleteCurrent() {
  const { row, col } = selectedCell;
  clearCellDisplay(row, col);
  saveProgress();
}

function moveToNextInWord() {
  if (!activeClue) return;
  const { row, col } = selectedCell;

  // Find next empty cell in the word
  const start = direction === 'across' ? col - activeClue.col : row - activeClue.row;
  for (let i = start + 1; i < activeClue.length; i++) {
    const r = direction === 'across' ? activeClue.row : activeClue.row + i;
    const c = direction === 'across' ? activeClue.col + i : activeClue.col;
    if (playerGrid[r][c] === '') {
      selectedCell = { row: r, col: c };
      updateActiveClue();
      updateHighlights();
      return;
    }
  }

  // No empty cells ahead — check if word is fully filled, auto-advance to next clue
  let wordFilled = true;
  for (let i = 0; i < activeClue.length; i++) {
    const r = direction === 'across' ? activeClue.row : activeClue.row + i;
    const c = direction === 'across' ? activeClue.col + i : activeClue.col;
    if (playerGrid[r][c] === '') {
      wordFilled = false;
      break;
    }
  }

  if (wordFilled) {
    // Auto-advance to next clue
    moveToNextClue(false);
  } else {
    // Stay at the next sequential cell (even if filled) so cursor doesn't jump unexpectedly
    if (direction === 'across') {
      const end = activeClue.col + activeClue.length;
      if (col + 1 < end) {
        selectedCell = { row, col: col + 1 };
      }
    } else {
      const end = activeClue.row + activeClue.length;
      if (row + 1 < end) {
        selectedCell = { row: row + 1, col };
      }
    }
    updateActiveClue();
    updateHighlights();
  }
}

function moveToPrevInWord() {
  if (!activeClue) return;
  const { row, col } = selectedCell;

  if (direction === 'across') {
    if (col > activeClue.col) {
      selectedCell = { row, col: col - 1 };
    }
  } else {
    if (row > activeClue.row) {
      selectedCell = { row: row - 1, col };
    }
  }

  updateActiveClue();
  updateHighlights();
}

function moveSelection(dr, dc) {
  const newDir = dc !== 0 ? 'across' : 'down';

  // If arrow axis differs from current direction, switch direction only if
  // the current cell actually has a clue in that direction; otherwise just move
  if (newDir !== direction) {
    const cc = cellToClue[selectedCell.row]?.[selectedCell.col];
    if (cc && cc[newDir]) {
      direction = newDir;
      updateActiveClue();
      updateHighlights();
      return;
    }
  }

  let r = selectedCell.row + dr;
  let c = selectedCell.col + dc;

  // Skip black squares
  while (r >= 0 && r < gridSize && c >= 0 && c < gridSize) {
    if (solutionGrid[r][c] !== '#') {
      selectedCell = { row: r, col: c };
      updateActiveClue();
      updateHighlights();
      return;
    }
    r += dr;
    c += dc;
  }

  // If couldn't move, at least update direction highlight
  updateActiveClue();
  updateHighlights();
}

function moveToNextClue(reverse) {
  const clues = direction === 'across'
    ? currentPuzzle.clues.across
    : currentPuzzle.clues.down;

  if (!activeClue || clues.length === 0) return;

  const currentIdx = clues.indexOf(activeClue);
  let nextIdx;

  if (reverse) {
    nextIdx = currentIdx - 1;
    if (nextIdx < 0) {
      // Switch direction and go to last clue
      direction = direction === 'across' ? 'down' : 'across';
      const otherClues = direction === 'across'
        ? currentPuzzle.clues.across
        : currentPuzzle.clues.down;
      nextIdx = otherClues.length - 1;
      selectClue(otherClues[nextIdx]);
      return;
    }
  } else {
    nextIdx = currentIdx + 1;
    if (nextIdx >= clues.length) {
      // Switch direction and go to first clue
      direction = direction === 'across' ? 'down' : 'across';
      const otherClues = direction === 'across'
        ? currentPuzzle.clues.across
        : currentPuzzle.clues.down;
      nextIdx = 0;
      selectClue(otherClues[nextIdx]);
      return;
    }
  }

  selectClue(clues[nextIdx]);
}

// ─── Check / Reveal / Clear ─────────────────────────────────────────────────

function checkPuzzle() {
  if (gameWon || timerPaused) return;
  let errors = 0;
  let filled = 0;

  for (let r = 0; r < gridSize; r++) {
    for (let c = 0; c < gridSize; c++) {
      if (solutionGrid[r][c] === '#') continue;
      const cell = getCell(r, c);
      if (!cell) continue;

      cell.classList.remove('error', 'correct');

      if (playerGrid[r][c] === '') continue;
      filled++;

      if (playerGrid[r][c] === solutionGrid[r][c]) {
        cell.classList.add('correct');
      } else {
        cell.classList.add('error');
        errors++;
      }
    }
  }

  if (filled === 0) {
    showToast('Fill in some letters first');
  } else if (errors === 0) {
    showToast('No errors found!');
  } else {
    showToast(`${errors} error${errors > 1 ? 's' : ''} found`);
  }
}

function revealWord() {
  if (gameWon || timerPaused || !activeClue) return;

  for (let i = 0; i < activeClue.length; i++) {
    const r = direction === 'across' ? activeClue.row : activeClue.row + i;
    const c = direction === 'across' ? activeClue.col + i : activeClue.col;

    playerGrid[r][c] = solutionGrid[r][c];
    revealedCells[r][c] = true;
    updateCellDisplay(r, c);

    getCell(r, c)?.classList.remove('error', 'correct');
    getCell(r, c)?.classList.add('revealed');
  }

  saveProgress();

  if (checkWin()) {
    onWin();
  }
}

function clearGrid() {
  if (gameWon || timerPaused) return;
  const modal = document.getElementById('clear-modal');
  modal.classList.add('active');
  document.getElementById('clear-cancel').focus();
}

function doClearGrid() {
  for (let r = 0; r < gridSize; r++) {
    for (let c = 0; c < gridSize; c++) {
      if (solutionGrid[r][c] === '#') continue;
      if (revealedCells[r][c]) continue;

      playerGrid[r][c] = '';
      updateCellDisplay(r, c);

      getCell(r, c)?.classList.remove('error', 'correct');
    }
  }

  saveProgress();
}

// ─── Win Detection ──────────────────────────────────────────────────────────

function checkWin() {
  for (let r = 0; r < gridSize; r++) {
    for (let c = 0; c < gridSize; c++) {
      if (solutionGrid[r][c] === '#') continue;
      if (playerGrid[r][c] !== solutionGrid[r][c]) return false;
    }
  }
  return true;
}

function onWin() {
  gameWon = true;
  stopTimer();

  // Clear saved progress
  try { localStorage.removeItem(`mini-crossword-progress-${currentPuzzle.id}`); } catch { /* storage unavailable */ }

  const msg = document.getElementById('win-message');
  msg.textContent = `You solved it in ${formatTime(timerSeconds)}!`;

  const modal = document.getElementById('win-modal');
  modal.classList.add('active');
  document.getElementById('win-new-game').focus();
}

// ─── Timer ──────────────────────────────────────────────────────────────────

function startTimer() {
  stopTimer();
  timerDisplay.textContent = formatTime(timerSeconds);
  timerInterval = setInterval(() => {
    if (!timerPaused) {
      timerSeconds++;
      timerDisplay.textContent = formatTime(timerSeconds);
    }
  }, 1000);
}

function stopTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

function pauseGame() {
  timerPaused = true;
  timerEl.classList.add('paused');
  pauseIcon.style.display = 'none';
  playIcon.style.display = '';
  document.getElementById('timer-pause').setAttribute('aria-label', 'Resume timer');
  document.getElementById('pause-modal').classList.add('active');
  document.getElementById('resume-btn').focus();
}

function resumeGame() {
  timerPaused = false;
  timerEl.classList.remove('paused');
  pauseIcon.style.display = '';
  playIcon.style.display = 'none';
  document.getElementById('timer-pause').setAttribute('aria-label', 'Pause timer');
  document.getElementById('pause-modal').classList.remove('active');
}

// ─── Persistence ────────────────────────────────────────────────────────────

function saveProgress() {
  if (!currentPuzzle || gameWon) return;
  saveToStorage(`mini-crossword-progress-${currentPuzzle.id}`, {
    playerGrid,
    revealedCells,
    timerSeconds,
    selectedCell,
    direction
  });
}

// ─── New Puzzle ─────────────────────────────────────────────────────────────

async function newPuzzle() {
  loadingOverlay.classList.add('active');

  try {
    const excludeId = currentPuzzle ? currentPuzzle.id : null;
    const puzzle = await getRandomPuzzle(excludeId);
    loadPuzzle(puzzle);
  } catch (err) {
    showToast('Error loading puzzle');
    console.error(err);
  }

  loadingOverlay.classList.remove('active');
}

// ─── Hidden Input (mobile keyboard support) ─────────────────────────────────

let hiddenInput = null;

function createHiddenInput() {
  hiddenInput = document.createElement('input');
  hiddenInput.className = 'hidden-input';
  hiddenInput.type = 'text';
  hiddenInput.autocomplete = 'off';
  hiddenInput.autocapitalize = 'characters';
  hiddenInput.setAttribute('aria-hidden', 'true');
  document.body.appendChild(hiddenInput);

  hiddenInput.addEventListener('input', (e) => {
    const val = e.data;
    if (val && /^[a-zA-Z]$/.test(val)) {
      placeLetter(val.toUpperCase());
    }
    hiddenInput.value = '';
  });

  hiddenInput.addEventListener('keydown', (e) => {
    // Let the main handler deal with special keys, but stop propagation
    // so the document-level listener doesn't fire a second time
    if (e.key === 'Backspace' || e.key === 'Delete' || e.key.startsWith('Arrow') || e.key === 'Tab' || e.key === ' ') {
      e.stopPropagation();
      handleKeydown(e);
    }
  });
}

function focusHiddenInput() {
  if (hiddenInput) {
    hiddenInput.focus({ preventScroll: true });
  }
}

// ─── Init ───────────────────────────────────────────────────────────────────

async function init() {
  loadingOverlay.classList.add('active');
  createHiddenInput();

  // Event listeners
  document.addEventListener('keydown', handleKeydown);
  document.getElementById('new-game-btn').addEventListener('click', newPuzzle);
  document.getElementById('timer-pause').addEventListener('click', () => {
    timerPaused ? resumeGame() : pauseGame();
  });
  document.getElementById('resume-btn').addEventListener('click', resumeGame);
  document.getElementById('pause-modal').addEventListener('modal-closed', resumeGame);
  document.getElementById('check-btn').addEventListener('click', checkPuzzle);
  document.getElementById('reveal-word-btn').addEventListener('click', revealWord);
  document.getElementById('clear-btn').addEventListener('click', clearGrid);
  document.getElementById('clear-confirm').addEventListener('click', () => {
    document.getElementById('clear-modal').classList.remove('active');
    doClearGrid();
  });
  document.getElementById('clear-cancel').addEventListener('click', () => {
    document.getElementById('clear-modal').classList.remove('active');
  });
  document.getElementById('win-new-game').addEventListener('click', () => {
    document.getElementById('win-modal').classList.remove('active');
    newPuzzle();
  });

  // Load last puzzle or random one
  try {
    const lastId = loadFromStorage('mini-crossword-last-id');
    let puzzle = null;

    if (lastId) {
      puzzle = await getPuzzleById(lastId);
    }

    if (!puzzle) {
      puzzle = await getRandomPuzzle();
    }

    loadPuzzle(puzzle);
  } catch (err) {
    showToast('Error loading puzzle');
    console.error(err);
  }

  loadingOverlay.classList.remove('active');
}

init();
