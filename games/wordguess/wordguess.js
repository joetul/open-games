import { ANSWERS as RAW_ANSWERS } from './answers.js';
import { VALID_GUESSES } from './valid.js';

// ─── State ───────────────────────────────────────────────────────────────────

const MAX_GUESSES = 6;
const WORD_LENGTH = 5;

// Filter out censored placeholder entries (e.g. "*****")
const ANSWERS = RAW_ANSWERS.filter(w => /^[a-z]+$/.test(w));

let targetWord = '';
let guesses = [];       // submitted guesses
let currentGuess = '';   // current typing
let gameOver = false;
let currentRow = 0;
let letterStates = {};   // letter → 'correct' | 'present' | 'absent'
let revealInProgress = false;

// Build a Set for O(1) lookup
const validSet = new Set([...VALID_GUESSES, ...ANSWERS]);

// ─── DOM References ──────────────────────────────────────────────────────────

const boardEl = document.getElementById('board');
const keyboardEl = document.getElementById('keyboard');
const toastContainer = document.getElementById('toast-container');
const endModal = document.getElementById('end-modal');
const endTitle = document.getElementById('end-title');
const endMessage = document.getElementById('end-message');
const endNewGame = document.getElementById('end-new-game');

// ─── Game Logic ──────────────────────────────────────────────────────────────

function newGame() {
  targetWord = ANSWERS[Math.floor(Math.random() * ANSWERS.length)];
  guesses = [];
  currentGuess = '';
  gameOver = false;
  currentRow = 0;
  letterStates = {};
  revealInProgress = false;
  endModal.classList.remove('active');
  clearBoard();
  clearKeyboard();
}

function clearBoard() {
  boardEl.querySelectorAll('.tile').forEach(tile => {
    tile.textContent = '';
    tile.className = 'tile';
    tile.style.transform = '';
  });
  boardEl.querySelectorAll('.row').forEach(row => {
    row.classList.remove('shake');
  });
}

function clearKeyboard() {
  keyboardEl.querySelectorAll('.key').forEach(key => {
    key.classList.remove('correct', 'present', 'absent');
  });
}

function handleKeyPress(key) {
  if (gameOver || revealInProgress) return;

  if (key === 'Enter') {
    submitGuess();
  } else if (key === 'Backspace') {
    deleteLetter();
  } else if (/^[a-z]$/i.test(key) && key.length === 1) {
    addLetter(key.toLowerCase());
  }
}

function addLetter(letter) {
  if (currentGuess.length >= WORD_LENGTH) return;

  currentGuess += letter;
  const col = currentGuess.length - 1;
  const tile = getTile(currentRow, col);
  tile.textContent = letter;
  tile.classList.add('filled');

  // Pop animation
  tile.classList.remove('pop');
  void tile.offsetWidth; // force reflow
  tile.classList.add('pop');
}

function deleteLetter() {
  if (currentGuess.length === 0) return;

  const col = currentGuess.length - 1;
  const tile = getTile(currentRow, col);
  tile.textContent = '';
  tile.classList.remove('filled', 'pop');
  currentGuess = currentGuess.slice(0, -1);
}

function submitGuess() {
  if (currentGuess.length < WORD_LENGTH) {
    shakeRow(currentRow);
    showToast('Not enough letters');
    return;
  }

  if (!validSet.has(currentGuess)) {
    shakeRow(currentRow);
    showToast('Not in word list');
    return;
  }

  const guess = currentGuess;
  guesses.push(guess);

  // Calculate letter states for this guess
  const states = evaluateGuess(guess);

  // Reveal tiles with animation
  revealInProgress = true;
  const revealedRow = currentRow;
  revealRow(currentRow, guess, states, () => {
    revealInProgress = false;

    // Update keyboard
    updateKeyboard(guess, states);

    // Check win/lose
    if (guess === targetWord) {
      gameOver = true;
      bounceRow(revealedRow);
      setTimeout(() => {
        endTitle.textContent = 'Congratulations!';
        endMessage.textContent = `You got it in ${guesses.length} ${guesses.length === 1 ? 'guess' : 'guesses'}!`;
        endModal.classList.add('active');
        endNewGame.focus();
      }, 600);
    } else if (guesses.length >= MAX_GUESSES) {
      gameOver = true;
      setTimeout(() => {
        endTitle.textContent = 'Game Over';
        endMessage.textContent = `The word was "${targetWord.toUpperCase()}"`;
        endModal.classList.add('active');
        endNewGame.focus();
      }, 400);
    }
  });

  currentGuess = '';
  if (currentRow < MAX_GUESSES - 1) currentRow++;
}

function evaluateGuess(guess) {
  const states = Array(WORD_LENGTH).fill('absent');
  const targetLetters = targetWord.split('');
  const guessLetters = guess.split('');

  // First pass: find correct letters
  for (let i = 0; i < WORD_LENGTH; i++) {
    if (guessLetters[i] === targetLetters[i]) {
      states[i] = 'correct';
      targetLetters[i] = null; // mark as used
      guessLetters[i] = null;
    }
  }

  // Second pass: find present letters
  for (let i = 0; i < WORD_LENGTH; i++) {
    if (guessLetters[i] === null) continue;

    const idx = targetLetters.indexOf(guessLetters[i]);
    if (idx !== -1) {
      states[i] = 'present';
      targetLetters[idx] = null;
    }
  }

  return states;
}

// ─── Animations & UI ─────────────────────────────────────────────────────────

function revealRow(rowIdx, guess, states, onComplete) {
  const row = boardEl.querySelector(`[data-row="${rowIdx}"]`);
  const tiles = row.querySelectorAll('.tile');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const STAGGER = reducedMotion ? 60 : 500;
  const FLIP_DUR = reducedMotion ? 0 : 300;

  tiles.forEach((tile, i) => {
    const delay = i * STAGGER;

    setTimeout(() => {
      // Stage 1: squash tile flat (flip out)
      tile.classList.add('flip-out');

      // Stage 2: when flat, change color and flip back in
      setTimeout(() => {
        tile.classList.add(states[i]);
        tile.classList.remove('filled', 'flip-out');
        tile.classList.add('flip-in');
        tile.setAttribute('aria-label', `${guess[i].toUpperCase()}, ${states[i]}`);
      }, FLIP_DUR);
    }, delay);
  });

  // Call onComplete after all tiles done
  const totalTime = (WORD_LENGTH - 1) * STAGGER + FLIP_DUR * 2 + 100;
  setTimeout(onComplete, totalTime);
}

function bounceRow(rowIdx) {
  const row = boardEl.querySelector(`[data-row="${rowIdx}"]`);
  if (!row) return;
  const tiles = row.querySelectorAll('.tile');

  tiles.forEach((tile, i) => {
    setTimeout(() => {
      tile.classList.add('bounce');
    }, i * 100);
  });
}

function shakeRow(rowIdx) {
  const row = boardEl.querySelector(`[data-row="${rowIdx}"]`);
  row.classList.remove('shake');
  void row.offsetWidth;
  row.classList.add('shake');
}

function updateKeyboard(guess, states) {
  for (let i = 0; i < WORD_LENGTH; i++) {
    const letter = guess[i];
    const state = states[i];

    // Only upgrade: absent → present → correct
    const priority = { absent: 0, present: 1, correct: 2 };
    const current = letterStates[letter];
    if (!current || priority[state] > priority[current]) {
      letterStates[letter] = state;
    }

    const keyEl = keyboardEl.querySelector(`[data-key="${letter}"]`);
    if (keyEl) {
      keyEl.classList.remove('correct', 'present', 'absent');
      keyEl.classList.add(letterStates[letter]);
    }
  }
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

function getTile(row, col) {
  return boardEl.querySelector(`[data-row="${row}"] [data-col="${col}"]`);
}

// ─── Event Listeners ─────────────────────────────────────────────────────────

// Physical keyboard
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;

  if (e.key === 'Enter' || e.key === 'Backspace' || /^[a-zA-Z]$/.test(e.key)) {
    e.preventDefault();
    handleKeyPress(e.key);
  }
});

// On-screen keyboard
keyboardEl.addEventListener('click', (e) => {
  const key = e.target.closest('.key');
  if (!key) return;
  handleKeyPress(key.dataset.key);
});

// New game buttons
endNewGame.addEventListener('click', newGame);

// Any modal close path (X button, Escape, backdrop click) starts a new game
endModal.addEventListener('modal-closed', newGame);

// ─── Init ────────────────────────────────────────────────────────────────────

newGame();
