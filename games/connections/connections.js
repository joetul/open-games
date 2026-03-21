import { shuffleArray, saveToStorage, loadFromStorage } from '../../shared/js/utils.js';
import { PUZZLES } from './puzzles.js';

// ─── State ───────────────────────────────────────────────────────────────────

const MAX_MISTAKES = 4;

let puzzle = null;
let solvedGroups = [];
let selectedWords = [];
let remainingWords = [];
let mistakes = 0;
let gameOver = false;
let guessedSets = [];
let isAnimating = false;

// ─── DOM References ──────────────────────────────────────────────────────────

const gridEl = document.getElementById('word-grid');
const solvedEl = document.getElementById('solved-groups');
const mistakeDots = document.getElementById('mistake-dots');
const submitBtn = document.getElementById('submit-btn');
const shuffleBtn = document.getElementById('shuffle-btn');
const deselectBtn = document.getElementById('deselect-btn');
const toastContainer = document.getElementById('toast-container');
const endModal = document.getElementById('end-modal');
const endTitle = document.getElementById('end-title');
const endMessage = document.getElementById('end-message');
const modalResults = document.getElementById('modal-results');
const endNewGame = document.getElementById('end-new-game');

// ─── Game Logic ──────────────────────────────────────────────────────────────

function newGame() {
  const lastIdx = loadFromStorage('connections-last');
  let idx;
  do {
    idx = Math.floor(Math.random() * PUZZLES.length);
  } while (PUZZLES.length > 1 && idx === lastIdx);
  saveToStorage('connections-last', idx);

  puzzle = PUZZLES[idx];
  solvedGroups = [];
  selectedWords = [];
  mistakes = 0;
  gameOver = false;
  guessedSets = [];
  isAnimating = false;

  remainingWords = shuffleArray(
    puzzle.groups.flatMap(g => g.words)
  );

  endModal.classList.remove('active');
  solvedEl.innerHTML = '';
  renderGrid();
  renderMistakes();
  updateButtons();
}

function toggleWord(word) {
  if (gameOver || isAnimating) return;

  const idx = selectedWords.indexOf(word);
  if (idx !== -1) {
    selectedWords.splice(idx, 1);
  } else if (selectedWords.length < 4) {
    selectedWords.push(word);
  }

  // Just toggle classes, no full re-render
  const tiles = gridEl.querySelectorAll('.word-tile');
  tiles.forEach(tile => {
    tile.classList.toggle('selected', selectedWords.includes(tile.dataset.word));
  });
  updateButtons();
}

function deselectAll() {
  if (isAnimating) return;
  selectedWords = [];
  const tiles = gridEl.querySelectorAll('.word-tile');
  tiles.forEach(tile => tile.classList.remove('selected'));
  updateButtons();
}

function shuffleRemaining() {
  if (isAnimating) return;
  remainingWords = shuffleArray(remainingWords);
  renderGrid();
}

function submitGuess() {
  if (selectedWords.length !== 4 || gameOver || isAnimating) return;

  const sortedGuess = [...selectedWords].sort().join(',');
  if (guessedSets.includes(sortedGuess)) {
    showToast('Already guessed!');
    return;
  }
  guessedSets.push(sortedGuess);

  const matchedGroup = puzzle.groups.find(g => {
    if (solvedGroups.includes(g)) return false;
    const groupWords = new Set(g.words);
    return selectedWords.every(w => groupWords.has(w));
  });

  if (matchedGroup) {
    animateCorrectGuess(matchedGroup);
  } else {
    animateWrongGuess();
  }
}

// ─── Animations ──────────────────────────────────────────────────────────────

function animateCorrectGuess(group) {
  isAnimating = true;
  const selectedSet = new Set(selectedWords);
  const allTiles = gridEl.querySelectorAll('.word-tile');

  // Step 1: Bounce selected tiles (one by one, staggered)
  const selectedTiles = [];
  allTiles.forEach(tile => {
    if (selectedSet.has(tile.dataset.word)) {
      selectedTiles.push(tile);
    }
  });

  selectedTiles.forEach((tile, i) => {
    setTimeout(() => {
      tile.classList.add('bounce');
    }, i * 80);
  });

  // Step 2: After bounce, flip out selected tiles
  const bounceEnd = selectedTiles.length * 80 + 400;
  setTimeout(() => {
    selectedTiles.forEach((tile, i) => {
      setTimeout(() => {
        tile.classList.add('flip-out');
      }, i * 60);
    });
  }, bounceEnd);

  // Step 3: After flip, update state and reveal group bar
  const flipEnd = bounceEnd + selectedTiles.length * 60 + 350;
  setTimeout(() => {
    solvedGroups.push(group);
    remainingWords = remainingWords.filter(w => !selectedSet.has(w));
    selectedWords = [];

    renderSolved(true);
    renderGrid();
    updateButtons();
    isAnimating = false;

    if (solvedGroups.length === 4) {
      gameOver = true;
      setTimeout(() => {
        endTitle.textContent = 'Congratulations!';
        endMessage.textContent = 'You found all four groups!';
        showEndModal();
      }, 500);
    }
  }, flipEnd);
}

function animateWrongGuess() {
  isAnimating = true;

  const oneAway = puzzle.groups.some(g => {
    if (solvedGroups.includes(g)) return false;
    const groupWords = new Set(g.words);
    const overlap = selectedWords.filter(w => groupWords.has(w));
    return overlap.length === 3;
  });

  if (oneAway) {
    showToast('One away!');
  }

  const tiles = gridEl.querySelectorAll('.word-tile.selected');
  tiles.forEach(tile => {
    tile.classList.remove('shake');
    void tile.offsetWidth;
    tile.classList.add('shake');
  });

  mistakes++;
  renderMistakes();

  setTimeout(() => {
    selectedWords = [];
    const allTiles = gridEl.querySelectorAll('.word-tile');
    allTiles.forEach(tile => tile.classList.remove('selected', 'shake'));
    updateButtons();
    isAnimating = false;

    if (mistakes >= MAX_MISTAKES) {
      gameOver = true;
      setTimeout(() => {
        revealRemaining(() => {
          endTitle.textContent = 'Game Over';
          endMessage.textContent = 'Better luck next time!';
          showEndModal();
        });
      }, 400);
    }
  }, 500);
}

function revealRemaining(onComplete) {
  const unsolved = puzzle.groups.filter(g => !solvedGroups.includes(g));
  let delay = 0;

  unsolved.forEach(group => {
    setTimeout(() => {
      solvedGroups.push(group);
      remainingWords = remainingWords.filter(w => !group.words.includes(w));
      selectedWords = [];
      renderSolved(true);
      renderGrid();
    }, delay);
    delay += 550;
  });

  setTimeout(onComplete, delay + 350);
}

// ─── Rendering ───────────────────────────────────────────────────────────────

function renderGrid() {
  gridEl.innerHTML = '';

  remainingWords.forEach(word => {
    const tile = document.createElement('button');
    tile.className = 'word-tile';
    tile.textContent = word;
    tile.dataset.word = word;
    if (selectedWords.includes(word)) {
      tile.classList.add('selected');
    }
    tile.addEventListener('click', () => toggleWord(word));
    gridEl.appendChild(tile);
  });
}

function renderSolved(animateLatest = false) {
  solvedEl.innerHTML = '';
  const sorted = [...solvedGroups].sort((a, b) => a.difficulty - b.difficulty);

  sorted.forEach((group, i) => {
    const bar = document.createElement('div');
    bar.className = `solved-group diff-${group.difficulty}`;
    if (animateLatest && i === sorted.length - 1) {
      bar.classList.add('reveal');
    }

    const catEl = document.createElement('div');
    catEl.className = 'group-category';
    catEl.textContent = group.category;

    const wordsEl = document.createElement('div');
    wordsEl.className = 'group-words';
    wordsEl.textContent = group.words.join(', ');

    bar.appendChild(catEl);
    bar.appendChild(wordsEl);
    solvedEl.appendChild(bar);
  });
}

function renderMistakes() {
  const dots = mistakeDots.querySelectorAll('.dot');
  const total = dots.length;
  dots.forEach((dot, i) => {
    dot.classList.toggle('used', i >= total - mistakes);
  });
}

function updateButtons() {
  submitBtn.disabled = selectedWords.length !== 4;
}

function showEndModal() {
  modalResults.innerHTML = '';
  const sorted = [...puzzle.groups].sort((a, b) => a.difficulty - b.difficulty);
  sorted.forEach(group => {
    const row = document.createElement('div');
    row.className = `modal-result-row diff-${group.difficulty}`;
    row.textContent = `${group.category}: ${group.words.join(', ')}`;
    modalResults.appendChild(row);
  });
  endModal.classList.add('active');
}

function showToast(message, duration = 1500) {
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('fade-out');
    setTimeout(() => toast.remove(), 400);
  }, duration);
}

// ─── Event Listeners ─────────────────────────────────────────────────────────

submitBtn.addEventListener('click', submitGuess);
shuffleBtn.addEventListener('click', shuffleRemaining);
deselectBtn.addEventListener('click', deselectAll);
endNewGame.addEventListener('click', newGame);

endModal.addEventListener('click', (e) => {
  if (e.target === endModal) endModal.classList.remove('active');
});

// ─── Init ────────────────────────────────────────────────────────────────────

newGame();
