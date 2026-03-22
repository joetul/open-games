#!/usr/bin/env node

/**
 * Converts puzzles from the Sudoku Exchange Puzzle Bank into puzzle packs.
 *
 * Source: https://github.com/grantm/sudoku-exchange-puzzle-bank (Public Domain)
 * Puzzles are graded by Sukaku Explainer using technique-based difficulty ratings.
 *
 * Usage:
 *   node scripts/convert-sudoku.js <puzzle-bank-dir> [puzzles-per-difficulty] [pack-size]
 *
 * Example:
 *   node scripts/convert-sudoku.js /tmp/sudoku-bank 500 100
 *
 * Output:
 *   games/sudoku/puzzles/pack-001.js ... pack-NNN.js
 *   games/sudoku/puzzles/index.js
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from 'fs';
import { resolve } from 'path';

const bankDir = process.argv[2];
const PER_DIFFICULTY = parseInt(process.argv[3], 10) || 500;
const PACK_SIZE = parseInt(process.argv[4], 10) || 100;

if (!bankDir) {
  console.error('Usage: node scripts/convert-sudoku.js <puzzle-bank-dir> [puzzles-per-difficulty] [pack-size]');
  process.exit(1);
}

const outDir = resolve(import.meta.dirname, '..', 'games', 'sudoku', 'puzzles');
mkdirSync(outDir, { recursive: true });

// ─── Step 1: Parse puzzle files ─────────────────────────────────────────────

const DIFFICULTY_MAP = {
  'easy.txt': 'easy',
  'medium.txt': 'medium',
  'hard.txt': 'hard',
  'diabolical.txt': 'expert',
};

/** Solve a sudoku puzzle using backtracking, return the solution grid */
function solve(grid) {
  const board = grid.map(row => [...row]);

  function isValid(row, col, num) {
    for (let i = 0; i < 9; i++) {
      if (board[row][i] === num) return false;
      if (board[i][col] === num) return false;
    }
    const br = Math.floor(row / 3) * 3;
    const bc = Math.floor(col / 3) * 3;
    for (let r = br; r < br + 3; r++) {
      for (let c = bc; c < bc + 3; c++) {
        if (board[r][c] === num) return false;
      }
    }
    return true;
  }

  function fill(pos) {
    if (pos === 81) return true;
    const r = Math.floor(pos / 9);
    const c = pos % 9;
    if (board[r][c] !== 0) return fill(pos + 1);
    for (let n = 1; n <= 9; n++) {
      if (isValid(r, c, n)) {
        board[r][c] = n;
        if (fill(pos + 1)) return true;
        board[r][c] = 0;
      }
    }
    return false;
  }

  if (!fill(0)) return null;
  return board;
}

/** Parse an 81-char digit string into a 9x9 grid */
function parseGrid(digits) {
  const grid = [];
  for (let r = 0; r < 9; r++) {
    const row = [];
    for (let c = 0; c < 9; c++) {
      row.push(parseInt(digits[r * 9 + c], 10));
    }
    grid.push(row);
  }
  return grid;
}

const allPuzzles = [];
let globalId = 1;

for (const [filename, diff] of Object.entries(DIFFICULTY_MAP)) {
  const filepath = resolve(bankDir, filename);
  console.log(`Reading ${filename}...`);

  const raw = readFileSync(filepath, 'utf-8');
  const lines = raw.trim().split('\n');

  // Shuffle lines to get a random sample
  for (let i = lines.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [lines[i], lines[j]] = [lines[j], lines[i]];
  }

  let count = 0;
  for (const line of lines) {
    if (count >= PER_DIFFICULTY) break;

    // Format: 12-byte hash, space, 81-byte digits, space, rating
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;

    const digits = parts[1];
    const rating = parseFloat(parts[2]);
    if (digits.length !== 81 || !/^[0-9]+$/.test(digits)) continue;

    const puzzleGrid = parseGrid(digits);
    const solutionGrid = solve(puzzleGrid);
    if (!solutionGrid) {
      console.warn(`  Skipping unsolvable puzzle: ${digits.slice(0, 12)}...`);
      continue;
    }

    allPuzzles.push({
      id: globalId++,
      difficulty: diff,
      rating,
      puzzle: puzzleGrid,
      solution: solutionGrid,
    });

    count++;
    if (count % 100 === 0) {
      console.log(`  ${diff}: ${count}/${PER_DIFFICULTY} puzzles solved...`);
    }
  }

  console.log(`  ${diff}: ${count} puzzles converted`);
}

console.log(`\nTotal puzzles: ${allPuzzles.length}`);

// ─── Step 2: Write puzzle packs ─────────────────────────────────────────────

// Group by difficulty for the index, but pack sequentially
const totalPacks = Math.ceil(allPuzzles.length / PACK_SIZE);

const countByDifficulty = {};
for (const p of allPuzzles) {
  countByDifficulty[p.difficulty] = (countByDifficulty[p.difficulty] || 0) + 1;
}

for (let p = 0; p < totalPacks; p++) {
  const start = p * PACK_SIZE;
  const end = Math.min(start + PACK_SIZE, allPuzzles.length);
  const pack = allPuzzles.slice(start, end);
  const padded = String(p + 1).padStart(3, '0');

  const js = `export const PUZZLES = ${JSON.stringify(pack)};\n`;
  writeFileSync(`${outDir}/pack-${padded}.js`, js);
  console.log(`  pack-${padded}.js: ${pack.length} puzzles`);
}

// Remove stale pack files from previous runs
for (const file of readdirSync(outDir)) {
  if (/^pack-\d+\.js$/.test(file)) {
    const num = parseInt(file.match(/\d+/)[0], 10);
    if (num > totalPacks) {
      unlinkSync(`${outDir}/${file}`);
      console.log(`  Removed stale ${file}`);
    }
  }
}

// Write index
const indexJs = `export const TOTAL_PACKS = ${totalPacks};
export const PACK_SIZE = ${PACK_SIZE};
export const TOTAL_PUZZLES = ${allPuzzles.length};
export const PUZZLES_PER_DIFFICULTY = ${JSON.stringify(countByDifficulty)};
`;
writeFileSync(`${outDir}/index.js`, indexJs);

console.log(`\nDone! ${totalPacks} packs written to ${outDir}`);
console.log('Puzzles per difficulty:', countByDifficulty);
