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

/** Load a random puzzle for the given difficulty, avoiding recently played ones */
export async function getRandomPuzzle(difficulty, excludeId) {
  // Try up to 3 random packs to find puzzles matching difficulty
  const played = getPlayedIds();

  for (let attempt = 0; attempt < 5; attempt++) {
    const packNum = Math.floor(Math.random() * TOTAL_PACKS) + 1;
    const pad = String(packNum).padStart(3, '0');
    const { PUZZLES } = await import(`./puzzles/pack-${pad}.js`);

    // Filter by difficulty
    const matching = PUZZLES.filter(p => p.difficulty === difficulty);
    if (matching.length === 0) continue;

    // Prefer unplayed
    let candidates = matching.filter(p => p.id !== excludeId && !played.has(p.id));
    if (candidates.length === 0) {
      candidates = matching.filter(p => p.id !== excludeId);
    }
    if (candidates.length === 0) {
      candidates = matching;
    }

    return candidates[Math.floor(Math.random() * candidates.length)];
  }

  // Fallback: load pack 1 and find any matching puzzle
  const { PUZZLES } = await import('./puzzles/pack-001.js');
  const matching = PUZZLES.filter(p => p.difficulty === difficulty);
  return matching[Math.floor(Math.random() * matching.length)];
}

/** Load a specific puzzle by ID */
export async function getPuzzleById(id) {
  const packIndex = Math.ceil(id / PACK_SIZE);
  const pad = String(packIndex).padStart(3, '0');
  const { PUZZLES } = await import(`./puzzles/pack-${pad}.js`);
  return PUZZLES.find(p => p.id === id) || null;
}

export { TOTAL_PUZZLES, PUZZLES_PER_DIFFICULTY };
