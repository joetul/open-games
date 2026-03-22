import { TOTAL_PACKS, PACK_SIZE, TOTAL_PUZZLES, PUZZLES_PER_DIFFICULTY } from './puzzles/index.js';
import { loadFromStorage, saveToStorage } from '../../shared/js/utils.js';

const PLAYED_KEY = 'sudoku-played-ids';

/** Get set of previously played puzzle IDs */
function getPlayedIds() {
  return new Set(loadFromStorage(PLAYED_KEY) || []);
}

/** Mark a puzzle ID as played */
export function markPlayed(id) {
  const played = getPlayedIds();
  played.add(id);
  const arr = [...played];
  if (arr.length > 500) arr.splice(0, arr.length - 500);
  saveToStorage(PLAYED_KEY, arr);
}

/** Map difficulty to pack number ranges */
const DIFFICULTY_PACKS = {
  easy:   { start: 1, end: 5 },
  medium: { start: 6, end: 10 },
  hard:   { start: 11, end: 15 },
  expert: { start: 16, end: 20 },
};

/** Load a random puzzle for the given difficulty, avoiding recently played ones */
export async function getRandomPuzzle(difficulty, excludeId) {
  const played = getPlayedIds();
  const range = DIFFICULTY_PACKS[difficulty];
  const rangeSize = range.end - range.start + 1;

  // Try multiple random packs within the difficulty range to find an unplayed puzzle
  const tried = new Set();
  for (let attempt = 0; attempt < 3 && tried.size < rangeSize; attempt++) {
    let packNum;
    do { packNum = range.start + Math.floor(Math.random() * rangeSize); } while (tried.has(packNum));
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

export { TOTAL_PUZZLES, PUZZLES_PER_DIFFICULTY };
