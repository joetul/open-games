import { formatTime } from '../../shared/js/utils.js';
import { getRandomPuzzle, markPlayed } from './puzzle-loader.js';

// ─── State ───────────────────────────────────────────────────────────────────

let currentPuzzleId = null;
let lastPuzzleByDifficulty = {};
let solution = [];    // 9x9 solved grid
let puzzle = [];      // 9x9 puzzle (0 = empty)
let board = [];       // 9x9 current player state
let pencilMarks = []; // 9x9 array of Sets
let selectedCell = null; // { row, col }
let pencilMode = false;
let undoStack = [];
let difficulty = 'easy';
let timerSeconds = 0;
let timerInterval = null;
let timerPaused = false;
let gameWon = false;
let errorsShown = true;
let loadId = 0;

// ─── DOM References ──────────────────────────────────────────────────────────

const gridEl = document.getElementById('sudoku-grid');
const timerDisplay = document.getElementById('timer-display');
const timerPauseBtn = document.getElementById('timer-pause');
const newGameBtn = document.getElementById('new-game-btn');
const undoBtn = document.getElementById('undo-btn');
const pencilBtn = document.getElementById('pencil-btn');
const eraseBtn = document.getElementById('erase-btn');
const checkBtn = document.getElementById('check-btn');
const winModal = document.getElementById('win-modal');
const winMessage = document.getElementById('win-message');
const winNewGame = document.getElementById('win-new-game');
const pauseModal = document.getElementById('pause-modal');
const pauseTime = document.getElementById('pause-time');
const pauseResume = document.getElementById('pause-resume');

// ─── Rendering ───────────────────────────────────────────────────────────────

function renderGrid() {
  gridEl.innerHTML = '';

  for (let row = 0; row < 9; row++) {
    for (let col = 0; col < 9; col++) {
      const cell = document.createElement('div');
      cell.className = 'cell';
      cell.dataset.row = row;
      cell.dataset.col = col;
      cell.setAttribute('role', 'gridcell');
      cell.setAttribute('tabindex', '-1');

      if (puzzle[row][col] !== 0) {
        cell.textContent = puzzle[row][col];
        cell.classList.add('given');
        cell.setAttribute('aria-label', `Row ${row + 1}, Column ${col + 1}, given ${puzzle[row][col]}`);
      } else {
        cell.setAttribute('aria-label', `Row ${row + 1}, Column ${col + 1}, empty`);
        // Pencil marks container
        const marksDiv = document.createElement('div');
        marksDiv.className = 'pencil-marks';
        for (let n = 1; n <= 9; n++) {
          const span = document.createElement('span');
          span.dataset.mark = n;
          marksDiv.appendChild(span);
        }
        cell.appendChild(marksDiv);
      }

      cell.addEventListener('click', () => selectCell(row, col));
      gridEl.appendChild(cell);
    }
  }

  updateAllCells();
}

function updateAllCells() {
  for (let row = 0; row < 9; row++) {
    for (let col = 0; col < 9; col++) {
      updateCell(row, col);
    }
  }
  updateHighlights();
  updateNumpadCounts();
}

function updateCell(row, col) {
  const cell = getCellElement(row, col);
  if (!cell || puzzle[row][col] !== 0) return;

  const value = board[row][col];
  const marks = pencilMarks[row][col];

  // Clear classes
  cell.classList.remove('user-input', 'error');

  if (value !== 0) {
    // Show number, hide pencil marks
    cell.childNodes.forEach(child => {
      if (child.classList && child.classList.contains('pencil-marks')) {
        child.style.display = 'none';
      }
    });

    // Find or create value display
    let valueSpan = cell.querySelector('.cell-value');
    if (!valueSpan) {
      valueSpan = document.createElement('span');
      valueSpan.className = 'cell-value';
      cell.appendChild(valueSpan);
    }
    valueSpan.textContent = value;
    cell.classList.add('user-input');
    cell.setAttribute('aria-label', `Row ${row + 1}, Column ${col + 1}, ${value}`);

    // Error checking
    if (errorsShown && value !== solution[row][col]) {
      cell.classList.add('error');
    }
  } else {
    // Remove value display
    const valueSpan = cell.querySelector('.cell-value');
    if (valueSpan) valueSpan.remove();

    // Show pencil marks
    const marksDiv = cell.querySelector('.pencil-marks');
    if (marksDiv) {
      marksDiv.style.display = 'grid';
      for (let n = 1; n <= 9; n++) {
        const span = marksDiv.querySelector(`[data-mark="${n}"]`);
        if (span) {
          span.textContent = marks.has(n) ? n : '';
        }
      }
    }
    cell.setAttribute('aria-label', `Row ${row + 1}, Column ${col + 1}, empty`);
  }
}

function getCellElement(row, col) {
  return gridEl.querySelector(`[data-row="${row}"][data-col="${col}"]`);
}

function updateHighlights() {
  // Clear all highlights
  gridEl.querySelectorAll('.cell').forEach(c => {
    c.classList.remove('selected', 'highlighted', 'same-number');
  });
  gridEl.querySelectorAll('.pencil-marks span').forEach(s => {
    s.classList.remove('mark-highlighted');
  });

  if (!selectedCell) return;

  const { row, col } = selectedCell;
  const selectedValue = board[row][col] || puzzle[row][col];
  const boxRow = Math.floor(row / 3) * 3;
  const boxCol = Math.floor(col / 3) * 3;

  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      const cell = getCellElement(r, c);
      if (!cell) continue;

      // Highlight same row, column, or box
      if (r === row || c === col || (r >= boxRow && r < boxRow + 3 && c >= boxCol && c < boxCol + 3)) {
        cell.classList.add('highlighted');
      }

      // Highlight same number
      if (selectedValue && (board[r][c] === selectedValue || puzzle[r][c] === selectedValue)) {
        cell.classList.add('same-number');
      }

      // Highlight matching pencil marks
      if (selectedValue && board[r][c] === 0 && puzzle[r][c] === 0 && pencilMarks[r][c].has(selectedValue)) {
        const mark = cell.querySelector(`.pencil-marks [data-mark="${selectedValue}"]`);
        if (mark) mark.classList.add('mark-highlighted');
      }
    }
  }

  // Selected cell on top
  const selectedEl = getCellElement(row, col);
  if (selectedEl) {
    selectedEl.classList.remove('highlighted', 'same-number');
    selectedEl.classList.add('selected');
  }
}

function updateNumpadCounts() {
  document.querySelectorAll('.numpad-btn').forEach(btn => {
    const num = parseInt(btn.dataset.num);
    let count = 0;
    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        const val = puzzle[r][c] !== 0 ? puzzle[r][c] : board[r][c];
        if (val === num) count++;
      }
    }
    btn.classList.toggle('completed', count >= 9);
  });
}

// ─── Interaction ─────────────────────────────────────────────────────────────

function selectCell(row, col) {
  if (gameWon || timerPaused) return;
  selectedCell = { row, col };
  updateHighlights();
  const cell = getCellElement(row, col);
  if (cell) cell.focus();
}

function placeNumber(num) {
  if (!selectedCell || gameWon || timerPaused) return;
  const { row, col } = selectedCell;

  // Can't modify given cells
  if (puzzle[row][col] !== 0) return;

  if (pencilMode) {
    // Toggle pencil mark
    const marks = pencilMarks[row][col];
    const prevMarks = new Set(marks);

    // Save undo state
    undoStack.push({ type: 'pencil', row, col, marks: prevMarks, prevValue: board[row][col] });

    if (marks.has(num)) {
      marks.delete(num);
    } else {
      marks.add(num);
    }

    // Clear value if there was one
    if (board[row][col] !== 0) {
      board[row][col] = 0;
    }
  } else {
    // Place number
    const prevValue = board[row][col];
    const prevMarks = new Set(pencilMarks[row][col]);

    board[row][col] = num;
    pencilMarks[row][col] = new Set();

    // Remove this number from pencil marks in same row/col/box
    const clearedMarks = clearRelatedPencilMarks(row, col, num);

    undoStack.push({ type: 'number', row, col, prevValue, prevMarks, clearedMarks });
  }

  updateAllCells();
  startTimer();
  checkWin();
}

function clearRelatedPencilMarks(row, col, num) {
  const cleared = []; // track what we remove so undo can restore
  const boxRow = Math.floor(row / 3) * 3;
  const boxCol = Math.floor(col / 3) * 3;

  const seen = new Set();
  const tryRemove = (r, c) => {
    const key = `${r},${c}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (pencilMarks[r][c].has(num)) {
      pencilMarks[r][c].delete(num);
      cleared.push({ row: r, col: c, num });
    }
  };

  for (let i = 0; i < 9; i++) {
    tryRemove(row, i);
    tryRemove(i, col);
  }
  for (let r = boxRow; r < boxRow + 3; r++) {
    for (let c = boxCol; c < boxCol + 3; c++) {
      tryRemove(r, c);
    }
  }
  return cleared;
}

function eraseCell() {
  if (!selectedCell || gameWon || timerPaused) return;
  const { row, col } = selectedCell;
  if (puzzle[row][col] !== 0) return;

  const prevValue = board[row][col];
  const prevMarks = new Set(pencilMarks[row][col]);

  if (prevValue === 0 && prevMarks.size === 0) return;

  undoStack.push({ type: 'erase', row, col, prevValue, prevMarks });

  board[row][col] = 0;
  pencilMarks[row][col] = new Set();

  updateAllCells();
}

function undo() {
  if (undoStack.length === 0 || gameWon || timerPaused) return;

  const action = undoStack.pop();
  const { row, col } = action;

  board[row][col] = action.prevValue || 0;
  pencilMarks[row][col] = action.prevMarks || new Set();

  // Restore pencil marks cleared from related cells
  if (action.clearedMarks) {
    for (const { row: r, col: c, num } of action.clearedMarks) {
      pencilMarks[r][c].add(num);
    }
  }

  // Re-select the cell that was undone
  selectedCell = { row, col };
  updateAllCells();
}

function checkErrors() {
  errorsShown = !errorsShown;
  checkBtn.classList.toggle('active', errorsShown);
  updateAllCells();
}

function checkWin() {
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      const val = puzzle[r][c] !== 0 ? puzzle[r][c] : board[r][c];
      if (val !== solution[r][c]) return;
    }
  }

  // Winner!
  gameWon = true;
  stopTimer();
  winMessage.textContent = `You solved it in ${formatTime(timerSeconds)}!`;
  winModal.classList.add('active');
  winNewGame.focus();
}

// ─── Timer ───────────────────────────────────────────────────────────────────

function startTimer() {
  if (timerInterval || timerPaused) return;
  timerInterval = setInterval(() => {
    timerSeconds++;
    timerDisplay.textContent = formatTime(timerSeconds);
  }, 1000);
}

function stopTimer() {
  clearInterval(timerInterval);
  timerInterval = null;
}

function pauseGame() {
  if (gameWon) return;
  if (timerPaused) { resumeGame(); return; }
  timerPaused = true;
  stopTimer();
  timerPauseBtn.closest('.timer').classList.add('paused');
  timerPauseBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>';
  timerPauseBtn.setAttribute('aria-label', 'Resume timer');
  pauseTime.textContent = formatTime(timerSeconds);
  pauseModal.classList.add('active');
  pauseResume.focus();
}

function resumeGame() {
  timerPaused = false;
  timerPauseBtn.closest('.timer').classList.remove('paused');
  timerPauseBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>';
  timerPauseBtn.setAttribute('aria-label', 'Pause timer');
  pauseModal.classList.remove('active');
  startTimer();
}

// ─── New Game ────────────────────────────────────────────────────────────────

async function newGame() {
  const thisLoad = ++loadId;

  // Reset state
  gameWon = false;
  errorsShown = true;
  checkBtn.classList.add('active');
  selectedCell = null;
  undoStack = [];
  pencilMode = false;
  pencilBtn.classList.remove('active');
  stopTimer();
  timerSeconds = 0;
  timerPaused = false;
  timerPauseBtn.closest('.timer').classList.remove('paused');
  timerPauseBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>';
  timerDisplay.textContent = '00:00';
  winModal.classList.remove('active');
  pauseModal.classList.remove('active');

  // Load puzzle from pack
  try {
    const excludeId = lastPuzzleByDifficulty[difficulty] ?? null;
    const puzzleData = await getRandomPuzzle(difficulty, excludeId);
    // If another newGame() was called while we were loading, discard this result
    if (thisLoad !== loadId) return;
    currentPuzzleId = puzzleData.id;
    lastPuzzleByDifficulty[difficulty] = puzzleData.id;
    solution = puzzleData.solution;
    puzzle = puzzleData.puzzle;
    board = puzzle.map(row => [...row]);
    pencilMarks = Array.from({ length: 9 }, () =>
      Array.from({ length: 9 }, () => new Set())
    );
    markPlayed(puzzleData.id);
    renderGrid();
    gridEl.classList.add('loaded');
  } catch (err) {
    console.error('Error loading puzzle:', err);
  }
}

// ─── Keyboard Input ──────────────────────────────────────────────────────────

document.addEventListener('keydown', (e) => {
  // Escape closes any active modal
  if (e.key === 'Escape') {
    if (pauseModal.classList.contains('active')) { resumeGame(); return; }
    if (winModal.classList.contains('active')) { winModal.classList.remove('active'); return; }
  }

  if (gameWon || timerPaused) return;

  // Number keys
  if (e.key >= '1' && e.key <= '9') {
    placeNumber(parseInt(e.key));
    return;
  }

  // Delete / Backspace
  if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    eraseCell();
    return;
  }

  // Ctrl+Z for undo
  if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
    e.preventDefault();
    undo();
    return;
  }

  // Arrow keys
  if (selectedCell && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
    e.preventDefault();
    let { row, col } = selectedCell;
    if (e.key === 'ArrowUp') row = Math.max(0, row - 1);
    if (e.key === 'ArrowDown') row = Math.min(8, row + 1);
    if (e.key === 'ArrowLeft') col = Math.max(0, col - 1);
    if (e.key === 'ArrowRight') col = Math.min(8, col + 1);
    selectCell(row, col);
    return;
  }

  // Toggle pencil mode with 'p'
  if (e.key === 'p' || e.key === 'P') {
    togglePencilMode();
    return;
  }
});

function togglePencilMode() {
  pencilMode = !pencilMode;
  pencilBtn.classList.toggle('active', pencilMode);
}

// ─── Event Listeners ─────────────────────────────────────────────────────────

newGameBtn.addEventListener('click', newGame);
winNewGame.addEventListener('click', newGame);
undoBtn.addEventListener('click', undo);
pencilBtn.addEventListener('click', togglePencilMode);
eraseBtn.addEventListener('click', eraseCell);
checkBtn.addEventListener('click', checkErrors);
timerPauseBtn.addEventListener('click', pauseGame);
pauseResume.addEventListener('click', resumeGame);

// Difficulty buttons
document.querySelectorAll('.difficulty-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.difficulty-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    difficulty = btn.dataset.difficulty;
    newGame();
  });
});

// Number pad
document.querySelectorAll('.numpad-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    placeNumber(parseInt(btn.dataset.num));
  });
});

// Close modal on overlay click
winModal.addEventListener('click', (e) => {
  if (e.target === winModal) winModal.classList.remove('active');
});
pauseModal.addEventListener('click', (e) => {
  if (e.target === pauseModal) resumeGame();
});

// ─── Init ────────────────────────────────────────────────────────────────────

newGame();
