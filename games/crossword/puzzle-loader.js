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
  const played = getPlayedIds();

  // Try multiple random packs to find an unplayed puzzle
  const tried = new Set();
  for (let attempt = 0; attempt < 3 && tried.size < TOTAL_PACKS; attempt++) {
    let packNum;
    do { packNum = Math.floor(Math.random() * TOTAL_PACKS) + 1; } while (tried.has(packNum));
    tried.add(packNum);

    const pad = String(packNum).padStart(3, '0');
    const { PUZZLES } = await import(`./puzzles/pack-${pad}.js`);

    const candidates = PUZZLES.filter(p => p.id !== excludeId && !played.has(p.id));
    if (candidates.length > 0) {
      return candidates[Math.floor(Math.random() * candidates.length)];
    }
  }

  // Fallback: pick any non-excluded puzzle from the last tried pack
  const fallbackPad = String([...tried][tried.size - 1]).padStart(3, '0');
  const { PUZZLES } = await import(`./puzzles/pack-${fallbackPad}.js`);
  let candidates = PUZZLES.filter(p => p.id !== excludeId);
  if (candidates.length === 0) candidates = PUZZLES;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

/** Load a specific puzzle by ID */
export async function getPuzzleById(id) {
  const packIndex = Math.ceil(id / PACK_SIZE);
  if (packIndex < 1 || packIndex > TOTAL_PACKS) return null;
  try {
    const pad = String(packIndex).padStart(3, '0');
    const { PUZZLES } = await import(`./puzzles/pack-${pad}.js`);
    return PUZZLES.find(p => p.id === id) || null;
  } catch {
    return null;
  }
}

export { TOTAL_PUZZLES };
