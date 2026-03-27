#!/usr/bin/env python3

"""
Converts puzzles from the Sudoku Exchange Puzzle Bank into puzzle packs.

Source: https://github.com/grantm/sudoku-exchange-puzzle-bank (Public Domain)
Puzzles are graded by Sukaku Explainer using technique-based difficulty ratings.

Usage:
  python scripts/convert-sudoku.py <puzzle-bank-dir> [puzzles-per-difficulty] [pack-size]

Example:
  python scripts/convert-sudoku.py /tmp/sudoku-bank 500 100

Output:
  games/sudoku/puzzles/pack-001.js ... pack-NNN.js
  games/sudoku/puzzles/index.js
"""

import json
import os
import random
import re
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(SCRIPT_DIR, '..', 'games', 'sudoku', 'puzzles')


def solve(grid):
    """Solve a sudoku puzzle using backtracking, return the solution grid or None."""
    board = [row[:] for row in grid]

    def is_valid(row, col, num):
        for i in range(9):
            if board[row][i] == num:
                return False
            if board[i][col] == num:
                return False
        br = (row // 3) * 3
        bc = (col // 3) * 3
        for r in range(br, br + 3):
            for c in range(bc, bc + 3):
                if board[r][c] == num:
                    return False
        return True

    def fill(pos):
        if pos == 81:
            return True
        r = pos // 9
        c = pos % 9
        if board[r][c] != 0:
            return fill(pos + 1)
        for n in range(1, 10):
            if is_valid(r, c, n):
                board[r][c] = n
                if fill(pos + 1):
                    return True
                board[r][c] = 0
        return False

    if not fill(0):
        return None
    return board


def parse_grid(digits):
    """Parse an 81-char digit string into a 9x9 grid."""
    grid = []
    for r in range(9):
        row = []
        for c in range(9):
            row.append(int(digits[r * 9 + c]))
        grid.append(row)
    return grid


def main():
    if len(sys.argv) < 2:
        print('Usage: python scripts/convert-sudoku.py <puzzle-bank-dir> [puzzles-per-difficulty] [pack-size]',
              file=sys.stderr)
        sys.exit(1)

    bank_dir = sys.argv[1]
    per_difficulty = int(sys.argv[2]) if len(sys.argv) > 2 else 500
    pack_size = int(sys.argv[3]) if len(sys.argv) > 3 else 100

    os.makedirs(OUT_DIR, exist_ok=True)

    # ─── Step 1: Parse puzzle files ─────────────────────────────────────────────

    difficulty_map = {
        'easy.txt': 'easy',
        'medium.txt': 'medium',
        'hard.txt': 'hard',
        'diabolical.txt': 'expert',
    }

    all_puzzles = []
    global_id = 1

    for filename, diff in difficulty_map.items():
        filepath = os.path.join(bank_dir, filename)
        print(f'Reading {filename}...')

        with open(filepath, 'r') as f:
            lines = f.read().strip().split('\n')

        # Shuffle lines to get a random sample
        random.shuffle(lines)

        count = 0
        for line in lines:
            if count >= per_difficulty:
                break

            # Format: 12-byte hash, space, 81-byte digits, space, rating
            parts = line.strip().split()
            if len(parts) < 3:
                continue

            digits = parts[1]
            try:
                rating = float(parts[2])
            except ValueError:
                continue

            if len(digits) != 81 or not re.match(r'^[0-9]+$', digits):
                continue

            puzzle_grid = parse_grid(digits)
            solution_grid = solve(puzzle_grid)
            if solution_grid is None:
                print(f'  Skipping unsolvable puzzle: {digits[:12]}...')
                continue

            all_puzzles.append({
                'id': global_id,
                'difficulty': diff,
                'rating': rating,
                'puzzle': puzzle_grid,
                'solution': solution_grid,
            })
            global_id += 1
            count += 1

            if count % 100 == 0:
                print(f'  {diff}: {count}/{per_difficulty} puzzles solved...')

        print(f'  {diff}: {count} puzzles converted')

    print(f'\nTotal puzzles: {len(all_puzzles)}')

    # ─── Step 2: Write puzzle packs ─────────────────────────────────────────────

    total_packs = (len(all_puzzles) + pack_size - 1) // pack_size

    count_by_difficulty = {}
    for p in all_puzzles:
        count_by_difficulty[p['difficulty']] = count_by_difficulty.get(p['difficulty'], 0) + 1

    for p in range(total_packs):
        start = p * pack_size
        end = min(start + pack_size, len(all_puzzles))
        pack = all_puzzles[start:end]
        padded = str(p + 1).zfill(3)

        # Write as ES6 module with compact JSON (no spaces after separators)
        js = f'export const PUZZLES = {json.dumps(pack, separators=(",", ":"))};\n'
        pack_path = os.path.join(OUT_DIR, f'pack-{padded}.js')
        with open(pack_path, 'w') as f:
            f.write(js)
        print(f'  pack-{padded}.js: {len(pack)} puzzles')

    # Remove stale pack files from previous runs
    for file in os.listdir(OUT_DIR):
        if re.match(r'^pack-\d+\.js$', file):
            num = int(re.search(r'\d+', file).group())
            if num > total_packs:
                os.unlink(os.path.join(OUT_DIR, file))
                print(f'  Removed stale {file}')

    # Write index
    index_js = (
        f'export const TOTAL_PACKS = {total_packs};\n'
        f'export const PACK_SIZE = {pack_size};\n'
        f'export const TOTAL_PUZZLES = {len(all_puzzles)};\n'
        f'export const PUZZLES_PER_DIFFICULTY = {json.dumps(count_by_difficulty, separators=(",", ":"))};\n'
    )
    with open(os.path.join(OUT_DIR, 'index.js'), 'w') as f:
        f.write(index_js)

    print(f'\nDone! {total_packs} packs written to {OUT_DIR}')
    print('Puzzles per difficulty:', count_by_difficulty)


if __name__ == '__main__':
    main()
