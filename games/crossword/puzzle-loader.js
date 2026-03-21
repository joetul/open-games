import { TOTAL_PACKS, PACK_SIZE, TOTAL_PUZZLES } from './puzzles/index.js';
import { loadFromStorage, saveToStorage } from '../../shared/js/utils.js';

const PLAYED_KEY = 'crossword-played-ids';

/** Get set of previously played puzzle IDs */
function getPlayedIds() {
  return new Set(loadFromStorage(PLAYED_KEY) || []);
}

/** Mark a puzzle ID as played */
export function markPlayed(id) {
  const played = getPlayedIds();
  played.add(id);
  // Keep only last 500 to avoid localStorage bloat
  const arr = [...played];
  if (arr.length > 500) arr.splice(0, arr.length - 500);
  saveToStorage(PLAYED_KEY, arr);
}

/** Load a random puzzle, avoiding recently played ones */
export async function getRandomPuzzle(excludeId) {
  const packNum = Math.floor(Math.random() * TOTAL_PACKS) + 1;
  const pad = String(packNum).padStart(3, '0');
  const { PUZZLES } = await import(`./puzzles/pack-${pad}.js`);

  const played = getPlayedIds();

  // Prefer unplayed puzzles
  let candidates = PUZZLES.filter(p => p.id !== excludeId && !played.has(p.id));
  if (candidates.length === 0) {
    candidates = PUZZLES.filter(p => p.id !== excludeId);
  }
  if (candidates.length === 0) {
    candidates = PUZZLES;
  }

  return candidates[Math.floor(Math.random() * candidates.length)];
}

/** Load a specific puzzle by ID */
export async function getPuzzleById(id) {
  const packIndex = Math.ceil(id / PACK_SIZE);
  const pad = String(packIndex).padStart(3, '0');
  const { PUZZLES } = await import(`./puzzles/pack-${pad}.js`);
  return PUZZLES.find(p => p.id === id) || null;
}

export { TOTAL_PUZZLES };
