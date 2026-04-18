import { saveToStorage, loadFromStorage, shuffleArray } from '../../shared/js/utils.js';

const BEST_KEY = 'visual-memory-best';
const MAX_GRID = 7;
const MIN_GRID = 3;
const STARTING_LIVES = 3;

const els = {
  level: document.getElementById('vm-level'),
  lives: document.getElementById('vm-lives'),
  best: document.getElementById('vm-best'),
  status: document.getElementById('vm-status'),
  grid: document.getElementById('vm-grid'),
  startBtn: document.getElementById('vm-start-btn'),
  gameOverModal: document.getElementById('game-over-modal'),
  gameOverMessage: document.getElementById('game-over-message'),
  tryAgainBtn: document.getElementById('game-over-try-again-btn'),
};

const state = {
  level: 1,
  lives: STARTING_LIVES,
  pattern: new Set(),
  found: new Set(),
  phase: 'idle',
  best: loadFromStorage(BEST_KEY) || 0,
  pendingTimers: [],
};

function levelConfig(level) {
  const gridSize = Math.min(MAX_GRID, MIN_GRID + Math.floor((level - 1) / 2));
  const cap = Math.floor((gridSize * gridSize) / 2);
  const tileCount = Math.min(cap, level + 2);
  return { gridSize, tileCount };
}

function flashDuration(tileCount) {
  return Math.min(2000, 900 + tileCount * 100);
}

function clearTimers() {
  for (const t of state.pendingTimers) clearTimeout(t);
  state.pendingTimers = [];
}

function later(fn, ms) {
  const id = setTimeout(() => {
    state.pendingTimers = state.pendingTimers.filter((x) => x !== id);
    fn();
  }, ms);
  state.pendingTimers.push(id);
}

const HEART_PATH =
  'M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z';

function heartSvg(filled) {
  const cls = filled ? '' : ' class="heart-empty"';
  const fill = filled ? 'currentColor' : 'none';
  return `<svg${cls} viewBox="0 0 24 24" fill="${fill}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${HEART_PATH}"/></svg>`;
}

function renderScores() {
  els.level.textContent = String(state.level);
  els.lives.innerHTML = Array.from(
    { length: STARTING_LIVES },
    (_, i) => heartSvg(i < state.lives)
  ).join('');
  els.best.textContent = String(state.best);
}

function renderGrid(size) {
  els.grid.style.setProperty('--cols', String(size));
  els.grid.innerHTML = '';
  const total = size * size;
  const frag = document.createDocumentFragment();
  for (let i = 0; i < total; i++) {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'vm-tile is-locked';
    tile.dataset.index = String(i);
    tile.setAttribute('aria-label', `Tile ${i + 1}`);
    frag.appendChild(tile);
  }
  els.grid.appendChild(frag);
}

function setStatus(text) {
  els.status.textContent = text;
}

function startGame() {
  clearTimers();
  state.level = 1;
  state.lives = STARTING_LIVES;
  state.phase = 'idle';
  renderScores();
  nextLevel();
}

function nextLevel() {
  clearTimers();
  state.found = new Set();
  state.phase = 'between';
  if (state.level > state.best) {
    state.best = state.level;
    saveToStorage(BEST_KEY, state.best);
  }
  const { gridSize, tileCount } = levelConfig(state.level);
  renderGrid(gridSize);
  renderScores();

  const total = gridSize * gridSize;
  const indices = shuffleArray([...Array(total).keys()]).slice(0, tileCount);
  state.pattern = new Set(indices);

  setStatus(`Level ${state.level} — memorize ${tileCount} tile${tileCount === 1 ? '' : 's'}.`);

  later(() => showPattern(), 500);
}

function showPattern() {
  if (document.hidden) {
    later(showPattern, 400);
    return;
  }
  state.phase = 'showing';
  const tiles = els.grid.children;
  for (const i of state.pattern) {
    tiles[i].classList.add('is-flash');
  }
  later(() => {
    for (const i of state.pattern) tiles[i].classList.remove('is-flash');
    enterInputPhase();
  }, flashDuration(state.pattern.size));
}

function enterInputPhase() {
  state.phase = 'input';
  for (const tile of els.grid.children) tile.classList.remove('is-locked');
  setStatus(`Find the ${state.pattern.size} tile${state.pattern.size === 1 ? '' : 's'}.`);
}

function lockGrid() {
  for (const tile of els.grid.children) tile.classList.add('is-locked');
}

function handleTileClick(event) {
  if (state.phase !== 'input') return;
  const tile = event.target.closest('.vm-tile');
  if (!tile || !els.grid.contains(tile)) return;
  if (tile.classList.contains('is-correct') || tile.classList.contains('is-wrong')) return;

  const idx = Number(tile.dataset.index);
  if (state.pattern.has(idx)) {
    tile.classList.add('is-correct');
    state.found.add(idx);
    if (state.found.size === state.pattern.size) {
      advanceLevel();
    }
  } else {
    tile.classList.add('is-wrong');
    state.lives -= 1;
    renderScores();
    later(() => tile.classList.remove('is-wrong'), 350);
    if (state.lives <= 0) {
      gameOver();
    }
  }
}

function advanceLevel() {
  state.phase = 'between';
  lockGrid();
  setStatus(`Level ${state.level} cleared!`);
  later(() => {
    state.level += 1;
    nextLevel();
  }, 700);
}

function gameOver() {
  clearTimers();
  state.phase = 'over';
  lockGrid();
  for (const i of state.pattern) {
    if (!state.found.has(i)) {
      els.grid.children[i].classList.add('is-flash');
    }
  }
  setStatus(`Game over — level ${state.level}.`);
  els.gameOverMessage.textContent =
    `You reached level ${state.level}. Best: ${state.best}.`;
  els.gameOverModal.classList.add('active');
}

function init() {
  renderScores();
  renderGrid(MIN_GRID);
  els.grid.addEventListener('click', handleTileClick);
  els.startBtn.addEventListener('click', startGame);
  els.tryAgainBtn.addEventListener('click', () => {
    els.gameOverModal.classList.remove('active');
    startGame();
  });
}

init();
