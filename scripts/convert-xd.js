#!/usr/bin/env node

/**
 * Converts .xd crossword puzzle files into JS module puzzle packs.
 *
 * Usage:
 *   node scripts/convert-xd.js <xd-directory> [max-puzzles] [pack-size]
 *
 * Example:
 *   node scripts/convert-xd.js /tmp/xd-puzzles/gxd 3000 100
 *
 * Output:
 *   games/crossword/puzzles/pack-001.js ... pack-NNN.js
 *   games/crossword/puzzles/index.js
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'fs';
import { join, resolve } from 'path';

const GRID_SIZE = 15;
const MAX_PUZZLES = parseInt(process.argv[3]) || 3000;
const PACK_SIZE = parseInt(process.argv[4]) || 100;
const xdDir = process.argv[2];

if (!xdDir) {
  console.error('Usage: node scripts/convert-xd.js <xd-directory> [max-puzzles] [pack-size]');
  process.exit(1);
}

const outDir = resolve(import.meta.dirname, '..', 'games', 'crossword', 'puzzles');
mkdirSync(outDir, { recursive: true });

// Collect all .xd files recursively
function collectFiles(dir) {
  let files = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      files = files.concat(collectFiles(full));
    } else if (entry.endsWith('.xd')) {
      files.push(full);
    }
  }
  return files;
}

// Compute standard crossword numbering from grid
function computeNumbering(grid, size) {
  const numberMap = {}; // "row,col" -> number
  let num = 0;

  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (grid[r][c] === '#') continue;

      const startsAcross =
        (c === 0 || grid[r][c - 1] === '#') &&
        c + 1 < size && grid[r][c + 1] !== '#';

      const startsDown =
        (r === 0 || grid[r - 1][c] === '#') &&
        r + 1 < size && grid[r + 1][c] !== '#';

      if (startsAcross || startsDown) {
        num++;
        numberMap[`${r},${c}`] = num;
      }
    }
  }
  return numberMap;
}

// Get word length starting at (r,c) in given direction
function wordLength(grid, size, r, c, dir) {
  let len = 0;
  if (dir === 'across') {
    while (c + len < size && grid[r][c + len] !== '#') len++;
  } else {
    while (r + len < size && grid[r + len][c] !== '#') len++;
  }
  return len;
}

// Parse a single .xd file
function parseXD(content, filePath) {
  const lines = content.replace(/\r\n/g, '\n').split('\n');

  // Parse metadata
  let title = '';
  let metaEnd = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '') {
      metaEnd = i;
      break;
    }
    if (line.startsWith('Title:')) title = line.slice(6).trim();
  }

  // Find grid: first non-empty block after metadata
  let gridStart = metaEnd + 1;
  while (gridStart < lines.length && lines[gridStart].trim() === '') gridStart++;

  const gridRows = [];
  let i = gridStart;
  while (i < lines.length && lines[i].trim() !== '') {
    gridRows.push(lines[i].trim());
    i++;
  }

  // Validate grid size
  if (gridRows.length !== GRID_SIZE) return null;
  for (const row of gridRows) {
    if (row.length !== GRID_SIZE) return null;
  }

  // Validate grid contains only uppercase letters and #
  for (const row of gridRows) {
    if (!/^[A-Z#]+$/.test(row)) return null;
  }

  // Parse grid into 2D array
  const grid = gridRows.map(row => row.split(''));

  // Compute numbering
  const numberMap = computeNumbering(grid, GRID_SIZE);
  // Reverse map: number -> {row, col}
  const numToPos = {};
  for (const [key, num] of Object.entries(numberMap)) {
    const [r, c] = key.split(',').map(Number);
    numToPos[num] = { row: r, col: c };
  }

  // Parse clues
  const acrossClues = [];
  const downClues = [];

  // Find clues section (after grid, skip blank lines)
  let clueStart = i;
  while (clueStart < lines.length && lines[clueStart].trim() === '') clueStart++;

  for (let j = clueStart; j < lines.length; j++) {
    const line = lines[j].trim();
    if (!line) continue;

    // Match: A1. clue text ~ ANSWER or D1. clue text ~ ANSWER
    const match = line.match(/^([AD])(\d+)\.\s+(.+?)\s*~\s*(.+)$/);
    if (!match) continue;

    const [, dir, numStr, clueText, answer] = match;
    const num = parseInt(numStr);
    const pos = numToPos[num];
    if (!pos) continue;

    const direction = dir === 'A' ? 'across' : 'down';
    const len = wordLength(grid, GRID_SIZE, pos.row, pos.col, direction);

    // Verify answer length matches grid
    if (answer.length !== len) continue;

    const clue = {
      number: num,
      clue: clueText,
      row: pos.row,
      col: pos.col,
      length: len
    };

    if (dir === 'A') {
      acrossClues.push(clue);
    } else {
      downClues.push(clue);
    }
  }

  // Must have at least some clues
  if (acrossClues.length < 5 || downClues.length < 5) return null;

  // Sort clues by number
  acrossClues.sort((a, b) => a.number - b.number);
  downClues.sort((a, b) => a.number - b.number);

  return {
    title: title || filePath.split('/').pop().replace('.xd', ''),
    size: GRID_SIZE,
    grid: gridRows,
    clues: {
      across: acrossClues,
      down: downClues
    }
  };
}

// Main
console.log(`Scanning ${xdDir} for .xd files...`);
const allFiles = collectFiles(resolve(xdDir));
console.log(`Found ${allFiles.length} .xd files`);

// Shuffle files to get a diverse selection
for (let i = allFiles.length - 1; i > 0; i--) {
  const j = Math.floor(Math.random() * (i + 1));
  [allFiles[i], allFiles[j]] = [allFiles[j], allFiles[i]];
}

const puzzles = [];
let skipped = 0;

for (const file of allFiles) {
  if (puzzles.length >= MAX_PUZZLES) break;

  try {
    const content = readFileSync(file, 'utf-8');
    const puzzle = parseXD(content, file);
    if (puzzle) {
      puzzle.id = puzzles.length + 1;
      puzzles.push(puzzle);
    } else {
      skipped++;
    }
  } catch {
    skipped++;
  }
}

console.log(`Parsed ${puzzles.length} valid 15x15 puzzles (skipped ${skipped})`);

// Write packs
const totalPacks = Math.ceil(puzzles.length / PACK_SIZE);

for (let p = 0; p < totalPacks; p++) {
  const start = p * PACK_SIZE;
  const end = Math.min(start + PACK_SIZE, puzzles.length);
  const pack = puzzles.slice(start, end);
  const padded = String(p + 1).padStart(3, '0');

  const js = `export const PUZZLES = ${JSON.stringify(pack)};\n`;
  writeFileSync(join(outDir, `pack-${padded}.js`), js);
  console.log(`  pack-${padded}.js: ${pack.length} puzzles`);
}

// Write index
const indexJs = `export const TOTAL_PACKS = ${totalPacks};
export const PACK_SIZE = ${PACK_SIZE};
export const TOTAL_PUZZLES = ${puzzles.length};
`;
writeFileSync(join(outDir, 'index.js'), indexJs);

console.log(`\nDone! ${totalPacks} packs written to ${outDir}`);
