#!/usr/bin/env node

/**
 * Generates 5x5 mini crossword puzzles.
 *
 * Words are sourced from the MsFit Crossword Dataset (https://github.com/nzfeng/crossword-dataset),
 * and clues are sourced from the xd-clues dataset (https://xd.saul.pw/data/).
 *
 * Usage:
 *   node scripts/generate-mini.js <clues.tsv> [target-count] [pack-size]
 *
 * Example:
 *   node scripts/generate-mini.js /tmp/xd-clues/xd/clues.tsv 3000 100
 *
 * Output:
 *   games/mini-crossword/puzzles/pack-001.js ... pack-NNN.js
 *   games/mini-crossword/puzzles/index.js
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';

const cluesFile = process.argv[2];
const TARGET = parseInt(process.argv[3]) || 3000;
const PACK_SIZE = parseInt(process.argv[4]) || 100;

if (!cluesFile) {
  console.error('Usage: node scripts/generate-mini.js <clues.tsv> [target-count] [pack-size]');
  process.exit(1);
}

const outDir = resolve(import.meta.dirname, '..', 'games', 'mini-crossword', 'puzzles');
const dataDir = resolve(import.meta.dirname, '..', 'data');
mkdirSync(outDir, { recursive: true });

// ─── Step 1: Load allowed words from MsFit Crossword Dataset ────────────────

console.log('Loading MsFit Crossword Dataset word lists...');

function loadWordList(filename) {
  const filepath = resolve(dataDir, filename);
  const content = readFileSync(filepath, 'utf-8');
  const words = new Set();
  for (const line of content.split('\n')) {
    const word = line.trim().toUpperCase();
    if (word.length === 5 && /^[A-Z]+$/.test(word)) {
      words.add(word);
    }
  }
  return words;
}

const allowedWords = loadWordList('crossword-core.txt');
// Also include contemporary words
for (const word of loadWordList('crossword-contemporary.txt')) {
  allowedWords.add(word);
}

console.log(`Loaded ${allowedWords.size} allowed 5-letter words from MsFit dataset`);

// ─── Step 2: Parse clues from xd-clues dataset ─────────────────────────────

console.log('Parsing xd-clues database for clues...');
const raw = readFileSync(cluesFile, 'utf-8');
const lines = raw.split('\n');

const allClues = new Map(); // word → [clue1, clue2, ...]

for (let i = 1; i < lines.length; i++) {
  const parts = lines[i].split('\t');
  if (parts.length < 4) continue;

  const answer = parts[2];
  const clue = parts[3];

  if (!answer || answer.length !== 5 || !/^[A-Z]+$/.test(answer)) continue;
  if (!clue || clue.length < 3) continue;

  // Only collect clues for words in our allowed set
  if (!allowedWords.has(answer)) continue;

  if (!allClues.has(answer)) {
    allClues.set(answer, []);
  }

  const clueList = allClues.get(answer);
  if (clueList.length < 5 && !clueList.includes(clue)) {
    clueList.push(clue);
  }
}

// Final word list: must be in allowed set AND have at least one clue
const wordClues = new Map();
for (const [word, clues] of allClues) {
  if (clues.length > 0) {
    wordClues.set(word, clues);
  }
}

const wordList = [...wordClues.keys()];
const wordSet = new Set(wordList);

console.log(`${wordList.length} words have both allowed status and available clues`);

if (wordList.length < 500) {
  console.error('Too few words to generate puzzles. Check that data files are present.');
  process.exit(1);
}

// ─── Step 3: Build prefix index for fast lookups ────────────────────────────

// prefixes[length][prefix] = true
// For a 5-letter word "CRANE": prefixes for "C", "CR", "CRA", "CRAN", "CRANE"
const prefixSets = [null, new Set(), new Set(), new Set(), new Set(), wordSet];

for (const word of wordList) {
  for (let len = 1; len <= 4; len++) {
    prefixSets[len].add(word.slice(0, len));
  }
}

function hasPrefix(partial) {
  return prefixSets[partial.length].has(partial);
}

// ─── Step 4: Grid generator with backtracking ───────────────────────────────

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function generateGrid() {
  // Try multiple starting words
  const starters = shuffle([...wordList]).slice(0, 200);

  for (const startWord of starters) {
    const rows = [startWord];
    if (fillGrid(rows, 1)) {
      return rows;
    }
  }
  return null;
}

function fillGrid(rows, rowIdx) {
  if (rowIdx === 5) {
    // Verify all columns are valid words
    for (let c = 0; c < 5; c++) {
      const col = rows[0][c] + rows[1][c] + rows[2][c] + rows[3][c] + rows[4][c];
      if (!wordSet.has(col)) return false;
    }
    return true;
  }

  // Build column prefixes so far
  const colPrefixes = [];
  for (let c = 0; c < 5; c++) {
    let prefix = '';
    for (let r = 0; r < rowIdx; r++) {
      prefix += rows[r][c];
    }
    colPrefixes.push(prefix);
  }

  // Find candidate words: each letter must extend a valid column prefix
  const candidates = [];
  for (const word of wordList) {
    let valid = true;
    for (let c = 0; c < 5; c++) {
      if (!hasPrefix(colPrefixes[c] + word[c])) {
        valid = false;
        break;
      }
    }
    if (valid) candidates.push(word);
  }

  // Shuffle and try candidates (limit attempts for speed)
  shuffle(candidates);
  const limit = rowIdx <= 2 ? 80 : 40;

  for (let i = 0; i < Math.min(candidates.length, limit); i++) {
    rows.push(candidates[i]);
    if (fillGrid(rows, rowIdx + 1)) return true;
    rows.pop();
  }

  return false;
}

// ─── Step 5: Generate puzzles ───────────────────────────────────────────────

console.log(`Generating up to ${TARGET} puzzles...`);

const puzzles = [];
const usedGrids = new Set(); // Avoid duplicates
let attempts = 0;
const maxAttempts = TARGET * 5;

while (puzzles.length < TARGET && attempts < maxAttempts) {
  attempts++;
  const grid = generateGrid();
  if (!grid) continue;

  const gridKey = grid.join('');
  if (usedGrids.has(gridKey)) continue;
  usedGrids.add(gridKey);

  // Build columns
  const cols = [];
  for (let c = 0; c < 5; c++) {
    cols.push(grid[0][c] + grid[1][c] + grid[2][c] + grid[3][c] + grid[4][c]);
  }

  // Verify all words (rows + columns) have clues
  let allHaveClues = true;
  for (const word of [...grid, ...cols]) {
    if (!wordClues.has(word)) {
      allHaveClues = false;
      break;
    }
  }
  if (!allHaveClues) continue;

  // Pick clues (random from available)
  const pickClue = (word) => {
    const clues = wordClues.get(word);
    return clues[Math.floor(Math.random() * clues.length)];
  };

  // Standard crossword numbering for 5x5 no-black-squares:
  // 1-5 across top row + down columns, then 6-9 for remaining across rows
  const puzzle = {
    id: puzzles.length + 1,
    size: 5,
    grid: [...grid],
    clues: {
      across: [
        { number: 1, clue: pickClue(grid[0]), row: 0, col: 0, length: 5 },
        { number: 6, clue: pickClue(grid[1]), row: 1, col: 0, length: 5 },
        { number: 7, clue: pickClue(grid[2]), row: 2, col: 0, length: 5 },
        { number: 8, clue: pickClue(grid[3]), row: 3, col: 0, length: 5 },
        { number: 9, clue: pickClue(grid[4]), row: 4, col: 0, length: 5 },
      ],
      down: [
        { number: 1, clue: pickClue(cols[0]), row: 0, col: 0, length: 5 },
        { number: 2, clue: pickClue(cols[1]), row: 0, col: 1, length: 5 },
        { number: 3, clue: pickClue(cols[2]), row: 0, col: 2, length: 5 },
        { number: 4, clue: pickClue(cols[3]), row: 0, col: 3, length: 5 },
        { number: 5, clue: pickClue(cols[4]), row: 0, col: 4, length: 5 },
      ]
    }
  };

  puzzles.push(puzzle);

  if (puzzles.length % 50 === 0) {
    console.log(`  Generated ${puzzles.length} puzzles (${attempts} attempts)...`);
  }
}

console.log(`\nGenerated ${puzzles.length} puzzles in ${attempts} attempts`);

// ─── Step 6: Write puzzle packs ─────────────────────────────────────────────

const totalPacks = Math.ceil(puzzles.length / PACK_SIZE);

for (let p = 0; p < totalPacks; p++) {
  const start = p * PACK_SIZE;
  const end = Math.min(start + PACK_SIZE, puzzles.length);
  const pack = puzzles.slice(start, end);
  const padded = String(p + 1).padStart(3, '0');

  const js = `export const PUZZLES = ${JSON.stringify(pack)};\n`;
  writeFileSync(`${outDir}/pack-${padded}.js`, js);
  console.log(`  pack-${padded}.js: ${pack.length} puzzles`);
}

const indexJs = `export const TOTAL_PACKS = ${totalPacks};
export const PACK_SIZE = ${PACK_SIZE};
export const TOTAL_PUZZLES = ${puzzles.length};
`;
writeFileSync(`${outDir}/index.js`, indexJs);

console.log(`\nDone! ${totalPacks} packs written to ${outDir}`);
