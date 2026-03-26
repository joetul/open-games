import { saveToStorage, loadFromStorage } from '../../shared/js/utils.js';

// ─── Constants ───────────────────────────────────────────────────────────────

const SIZE = 4;
const SLIDE_DURATION = 120;

// ─── State ───────────────────────────────────────────────────────────────────

let grid = [];
let score = 0;
let bestScore = 0;
let won = false;
let keepPlaying = false;
let moving = false;
let tileIdCounter = 0;
let tiles = [];

// ─── DOM References ──────────────────────────────────────────────────────────

const tileLayer = document.getElementById('tile-layer');
const scoreEl = document.getElementById('score');
const bestScoreEl = document.getElementById('best-score');
const newGameBtn = document.getElementById('new-game-btn');
const gridContainer = document.getElementById('grid-container');
const winModal = document.getElementById('win-modal');
const winMessage = document.getElementById('win-message');
const keepPlayingBtn = document.getElementById('keep-playing-btn');
const winNewGameBtn = document.getElementById('win-new-game-btn');
const gameOverModal = document.getElementById('game-over-modal');
const gameOverScore = document.getElementById('game-over-score');
const gameOverNewGameBtn = document.getElementById('game-over-new-game-btn');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function emptyGrid() {
  return Array.from({ length: SIZE }, () => Array(SIZE).fill(0));
}

function getEmptyCells() {
  const cells = [];
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (grid[r][c] === 0) cells.push({ r, c });
    }
  }
  return cells;
}

function buildTraversal(direction) {
  const rows = [...Array(SIZE).keys()];
  const cols = [...Array(SIZE).keys()];

  if (direction === 'down') rows.reverse();
  if (direction === 'right') cols.reverse();

  return { rows, cols };
}

function getVector(direction) {
  const vectors = {
    up: { dr: -1, dc: 0 },
    down: { dr: 1, dc: 0 },
    left: { dr: 0, dc: -1 },
    right: { dr: 0, dc: 1 },
  };
  return vectors[direction];
}

function inBounds(r, c) {
  return r >= 0 && r < SIZE && c >= 0 && c < SIZE;
}

function findTileAt(r, c) {
  return tiles.find(t => t.row === r && t.col === c);
}

// ─── Game Logic ──────────────────────────────────────────────────────────────

function newGame() {
  grid = emptyGrid();
  score = 0;
  won = false;
  keepPlaying = false;
  tiles = [];
  tileIdCounter = 0;
  tileLayer.innerHTML = '';

  addRandomTile();
  addRandomTile();
  renderScore();
  saveState();
}

function addRandomTile() {
  const empty = getEmptyCells();
  if (empty.length === 0) return;

  const { r, c } = empty[Math.floor(Math.random() * empty.length)];
  const value = Math.random() < 0.9 ? 2 : 4;
  grid[r][c] = value;

  const tile = { id: tileIdCounter++, value, row: r, col: c, isNew: true, isMerged: false };
  tiles.push(tile);
  createTileElement(tile);
}

function move(direction) {
  if (moving) return;

  const vector = getVector(direction);
  const { rows, cols } = buildTraversal(direction);
  const merged = emptyGrid();
  let moved = false;
  let scoreGain = 0;
  const mergedTiles = [];
  const removedTiles = [];

  // Clear animation classes from previous move
  tiles.forEach(t => {
    t.isNew = false;
    t.isMerged = false;
    const el = document.getElementById('tile-' + t.id);
    if (el) el.classList.remove('tile-new', 'tile-merged');
  });

  for (const r of rows) {
    for (const c of cols) {
      if (grid[r][c] === 0) continue;

      const tile = findTileAt(r, c);
      if (!tile) continue;

      // Find farthest empty position
      let nextR = r;
      let nextC = c;
      while (true) {
        const newR = nextR + vector.dr;
        const newC = nextC + vector.dc;
        if (!inBounds(newR, newC)) break;
        if (grid[newR][newC] !== 0) break;
        nextR = newR;
        nextC = newC;
      }

      // Check for merge
      const mergeR = nextR + vector.dr;
      const mergeC = nextC + vector.dc;
      if (
        inBounds(mergeR, mergeC) &&
        grid[mergeR][mergeC] === tile.value &&
        !merged[mergeR][mergeC]
      ) {
        // Merge
        const targetTile = findTileAt(mergeR, mergeC);
        const newValue = tile.value * 2;

        grid[r][c] = 0;
        grid[mergeR][mergeC] = newValue;
        merged[mergeR][mergeC] = 1;

        targetTile.value = newValue;
        targetTile.isMerged = true;
        mergedTiles.push(targetTile);

        // Move consumed tile to merge position then remove
        tile.row = mergeR;
        tile.col = mergeC;
        removedTiles.push(tile);

        scoreGain += newValue;
        moved = true;

        if (newValue === 2048 && !won) {
          won = true;
        }
      } else if (nextR !== r || nextC !== c) {
        // Just move
        grid[r][c] = 0;
        grid[nextR][nextC] = tile.value;
        tile.row = nextR;
        tile.col = nextC;
        moved = true;
      }
    }
  }

  if (!moved) return;

  moving = true;
  score += scoreGain;

  // Animate slides
  tiles.forEach(t => updateTilePosition(t));

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const delay = reducedMotion ? 0 : SLIDE_DURATION;

  setTimeout(() => {
    // Remove consumed tiles
    removedTiles.forEach(t => {
      const el = document.getElementById('tile-' + t.id);
      if (el) el.remove();
      tiles = tiles.filter(x => x !== t);
    });

    // Update merged tile elements
    mergedTiles.forEach(t => {
      const el = document.getElementById('tile-' + t.id);
      if (el) {
        el.setAttribute('data-value', t.value);
        el.textContent = t.value;
        el.classList.toggle('tile-super', t.value > 2048);
        el.classList.add('tile-merged');
      }
    });

    renderScore();

    // Add new tile
    addRandomTile();
    saveState();

    // Check win/lose after a brief pause
    setTimeout(() => {
      moving = false;

      if (won && !keepPlaying) {
        showWinModal();
      } else if (!canMove()) {
        showGameOverModal();
      }
    }, reducedMotion ? 0 : 150);
  }, delay);
}

function canMove() {
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (grid[r][c] === 0) return true;
      if (c < SIZE - 1 && grid[r][c] === grid[r][c + 1]) return true;
      if (r < SIZE - 1 && grid[r][c] === grid[r + 1][c]) return true;
    }
  }
  return false;
}

// ─── Rendering ───────────────────────────────────────────────────────────────

function createTileElement(tile) {
  const el = document.createElement('div');
  el.id = 'tile-' + tile.id;
  el.className = 'tile';
  el.setAttribute('data-value', tile.value);
  el.textContent = tile.value;
  el.style.setProperty('--row', tile.row);
  el.style.setProperty('--col', tile.col);

  if (tile.value > 2048) el.classList.add('tile-super');
  if (tile.isNew) el.classList.add('tile-new');

  tileLayer.appendChild(el);
}

function updateTilePosition(tile) {
  const el = document.getElementById('tile-' + tile.id);
  if (!el) return;
  el.style.setProperty('--row', tile.row);
  el.style.setProperty('--col', tile.col);
}

function renderScore() {
  scoreEl.textContent = score;
  if (score > bestScore) {
    bestScore = score;
    saveToStorage('2048-best', bestScore);
  }
  bestScoreEl.textContent = bestScore;
}

// ─── Modals ──────────────────────────────────────────────────────────────────

function showWinModal() {
  winMessage.textContent = 'You reached 2048! Score: ' + score;
  winModal.classList.add('active');
}

function showGameOverModal() {
  gameOverScore.textContent = 'Final score: ' + score;
  gameOverModal.classList.add('active');
}

// ─── Persistence ─────────────────────────────────────────────────────────────

function saveState() {
  const serializedTiles = tiles.map(t => ({
    id: t.id,
    value: t.value,
    row: t.row,
    col: t.col,
  }));

  saveToStorage('2048-state', {
    grid,
    score,
    won,
    keepPlaying,
    tiles: serializedTiles,
    tileIdCounter,
  });
}

function restoreState(state) {
  grid = state.grid;
  score = state.score;
  won = state.won || false;
  keepPlaying = state.keepPlaying || false;
  tileIdCounter = state.tileIdCounter || 0;
  tiles = [];
  tileLayer.innerHTML = '';

  if (state.tiles) {
    state.tiles.forEach(t => {
      const tile = { id: t.id, value: t.value, row: t.row, col: t.col, isNew: false, isMerged: false };
      tiles.push(tile);
      createTileElement(tile);
    });
  }

  renderScore();
}

// ─── Touch / Swipe ───────────────────────────────────────────────────────────

let touchStartX = 0;
let touchStartY = 0;
let touchStartTime = 0;

gridContainer.addEventListener('touchstart', (e) => {
  const touch = e.touches[0];
  touchStartX = touch.clientX;
  touchStartY = touch.clientY;
  touchStartTime = Date.now();
}, { passive: true });

gridContainer.addEventListener('touchend', (e) => {
  const touch = e.changedTouches[0];
  const dx = touch.clientX - touchStartX;
  const dy = touch.clientY - touchStartY;
  const elapsed = Date.now() - touchStartTime;

  const MIN_SWIPE = 30;
  const MAX_TIME = 500;

  if (elapsed > MAX_TIME) return;
  if (Math.abs(dx) < MIN_SWIPE && Math.abs(dy) < MIN_SWIPE) return;

  if (Math.abs(dx) > Math.abs(dy)) {
    move(dx > 0 ? 'right' : 'left');
  } else {
    move(dy > 0 ? 'down' : 'up');
  }
});

// ─── Keyboard ────────────────────────────────────────────────────────────────

document.addEventListener('keydown', (e) => {
  const keyMap = {
    ArrowUp: 'up',
    ArrowDown: 'down',
    ArrowLeft: 'left',
    ArrowRight: 'right',
    w: 'up',
    W: 'up',
    s: 'down',
    S: 'down',
    a: 'left',
    A: 'left',
    d: 'right',
    D: 'right',
  };

  const direction = keyMap[e.key];
  if (direction) {
    e.preventDefault();
    if (!winModal.classList.contains('active') && !gameOverModal.classList.contains('active')) {
      move(direction);
    }
  }
});

// ─── Button Events ───────────────────────────────────────────────────────────

newGameBtn.addEventListener('click', () => {
  saveToStorage('2048-state', null);
  newGame();
});

winNewGameBtn.addEventListener('click', () => {
  winModal.classList.remove('active');
  saveToStorage('2048-state', null);
  newGame();
});

keepPlayingBtn.addEventListener('click', () => {
  keepPlaying = true;
  winModal.classList.remove('active');
  saveState();
});

gameOverNewGameBtn.addEventListener('click', () => {
  gameOverModal.classList.remove('active');
  saveToStorage('2048-state', null);
  newGame();
});

winModal.addEventListener('modal-closed', () => {
  keepPlaying = true;
  saveState();
});

// ─── Init ────────────────────────────────────────────────────────────────────

bestScore = loadFromStorage('2048-best') || 0;
bestScoreEl.textContent = bestScore;

const saved = loadFromStorage('2048-state');
if (saved && saved.grid && saved.tiles) {
  restoreState(saved);
} else {
  newGame();
}
