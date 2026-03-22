import { TOTAL_PACKS, PACK_SIZE, TOTAL_PUZZLES } from './puzzles/index.js';
import { loadFromStorage, saveToStorage } from '../../shared/js/utils.js';

const PLAYED_KEY = 'mini-crossword-played-ids';

function getPlayedIds() {
  return new Set(loadFromStorage(PLAYED_KEY) || []);
}

export function markPlayed(id) {
  const played = getPlayedIds();
  played.add(id);
  const arr = [...played];
  if (arr.length > 500) arr.splice(0, arr.length - 500);
  saveToStorage(PLAYED_KEY, arr);
}

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
