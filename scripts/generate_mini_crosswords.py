#!/usr/bin/env python3
"""
Generates 5x5 mini crossword puzzles with NYT-style black squares.

Uses:
- Handcrafted 5x5 grid patterns with rotational symmetry
- Words from MsFit Crossword Dataset
- Clues from xd-clues dataset

Features:
- CSP solver with bitset indices (ported from generate_crosswords.py)
- Clue rotation: spreads clue usage evenly across puzzles
- Data integrity validation: no duplicate words or clues per puzzle
- Multiprocessing with checkpoint/resume

Usage:
    python3 scripts/generate_mini_crosswords.py [--target 3000] [--pack-size 100] [--workers N]

Output:
    games/mini-crossword/puzzles/pack-001.js ... pack-NNN.js
    games/mini-crossword/puzzles/index.js
"""

import argparse
import json
import math
import multiprocessing as mp
import os
import random
import re
import shutil
import signal
import ssl
import sys
import time
import urllib.request
import zipfile
from collections import defaultdict
from pathlib import Path

# ── Config ────────────────────────────────────────────────────────────

GRID_SIZE = 5
MAX_BACKTRACKS = 50_000
CANDIDATE_LIMIT = 80
CHECKPOINT_FILE = "mini_crossword_checkpoint.json"
MAX_CLUES_PER_WORD = 30

# ── Globals (populated once, shared via fork or worker init) ──────────

words_by_len: dict[int, list[str]] = {}
clue_map: dict[str, list[str]] = {}
letter_bits: dict[int, dict[int, dict[str, int]]] = {}
all_bits: dict[int, int] = {}


def parse_args():
    p = argparse.ArgumentParser(description="Generate 5x5 mini crossword puzzles")
    p.add_argument("--target", type=int, default=3000, help="Number of puzzles to generate")
    p.add_argument("--pack-size", type=int, default=100, help="Puzzles per pack file")
    p.add_argument("--workers", type=int, default=None, help="Worker processes (default: all cores)")
    p.add_argument("--max-backtracks", type=int, default=MAX_BACKTRACKS, help="Max backtracks per solve attempt")
    p.add_argument("--resume", action="store_true", help="Resume from checkpoint if available")
    p.add_argument("--append", action="store_true", help="Keep existing puzzles and add more to reach target")
    return p.parse_args()


# ── 5x5 Grid Pattern Generator ────────────────────────────────────────
# Algorithmically enumerates all valid 5x5 patterns with 180-degree
# rotational symmetry. Filters by connectivity, slot length, and black
# square count. Scores patterns by quality for weighted selection.

# Allowed black square range (NYT Mini typically has 0-6)
MIN_BLACKS = 0
MAX_BLACKS = 6


def _pattern_to_flat(pattern: tuple[str, ...]) -> tuple[str, ...]:
    """Convert a pattern (tuple of row strings) to a flat tuple of characters."""
    return tuple(c for row in pattern for c in row)


def _is_connected(flat: tuple[str, ...]) -> bool:
    """Check that all white cells form a single connected component."""
    white_cells = {(r, c) for r in range(GRID_SIZE) for c in range(GRID_SIZE) if flat[r * GRID_SIZE + c] == "."}
    if not white_cells:
        return False
    start = next(iter(white_cells))
    visited = {start}
    queue = [start]
    while queue:
        r, c = queue.pop()
        for dr, dc in [(-1, 0), (1, 0), (0, -1), (0, 1)]:
            nr, nc = r + dr, c + dc
            if (nr, nc) in white_cells and (nr, nc) not in visited:
                visited.add((nr, nc))
                queue.append((nr, nc))
    return visited == white_cells


def _get_slots_from_flat(flat: tuple[str, ...]) -> list[tuple[str, int]]:
    """Extract all slots (direction, length) from a flat pattern. Returns empty list if any slot has length 2."""
    slots = []
    for r in range(GRID_SIZE):
        c = 0
        while c < GRID_SIZE:
            if flat[r * GRID_SIZE + c] == "#":
                c += 1
                continue
            end = c
            while end < GRID_SIZE and flat[r * GRID_SIZE + end] != "#":
                end += 1
            length = end - c
            if length == 2:
                return []  # invalid
            if length >= 3:
                slots.append(("across", length))
            c = end
    for c in range(GRID_SIZE):
        r = 0
        while r < GRID_SIZE:
            if flat[r * GRID_SIZE + c] == "#":
                r += 1
                continue
            end = r
            while end < GRID_SIZE and flat[end * GRID_SIZE + c] != "#":
                end += 1
            length = end - r
            if length == 2:
                return []  # invalid
            if length >= 3:
                slots.append(("down", length))
            r = end
    return slots


def _score_pattern(flat: tuple[str, ...], slots: list[tuple[str, int]]) -> float:
    """Score a pattern for quality. Higher is better.

    Prefers:
    - More word slots (more clues = more interesting)
    - Mix of word lengths (not all the same)
    - 4-6 black squares (NYT Mini sweet spot)
    - Every white cell participates in both an across and down word (fully checked)
    """
    n_blacks = sum(1 for c in flat if c == "#")
    n_words = len(slots)
    lengths = [l for _, l in slots]

    if n_words < 6:
        return 0.0  # too few words

    # Length variety: number of distinct lengths
    length_variety = len(set(lengths))

    # Check that every white cell is in both an across and a down slot
    across_cells = set()
    down_cells = set()
    for r in range(GRID_SIZE):
        c = 0
        while c < GRID_SIZE:
            if flat[r * GRID_SIZE + c] == "#":
                c += 1
                continue
            end = c
            while end < GRID_SIZE and flat[r * GRID_SIZE + end] != "#":
                end += 1
            if end - c >= 3:
                for i in range(c, end):
                    across_cells.add((r, i))
            c = end
    for c in range(GRID_SIZE):
        r = 0
        while r < GRID_SIZE:
            if flat[r * GRID_SIZE + c] == "#":
                r += 1
                continue
            end = r
            while end < GRID_SIZE and flat[end * GRID_SIZE + c] != "#":
                end += 1
            if end - r >= 3:
                for i in range(r, end):
                    down_cells.add((i, c))
            r = end

    white_cells = {(r, c) for r in range(GRID_SIZE) for c in range(GRID_SIZE) if flat[r * GRID_SIZE + c] == "."}
    fully_checked = across_cells & down_cells == white_cells

    # Scoring
    score = 0.0
    score += n_words * 2.0                        # more words is better
    score += length_variety * 3.0                  # variety in word lengths
    score += 5.0 if fully_checked else 0.0         # fully checked grid bonus
    # Prefer 4-6 blacks (NYT sweet spot)
    if 4 <= n_blacks <= 6:
        score += 4.0
    elif 2 <= n_blacks <= 8:
        score += 1.0

    return score


def generate_patterns() -> list[tuple[str, ...]]:
    """Enumerate all valid 5x5 patterns with 180-degree rotational symmetry.

    For a 5x5 grid, cell (r,c) maps to (4-r, 4-c) under 180-degree rotation.
    The 25 cells form 12 symmetric pairs + 1 center cell (2,2) = 13 independent choices.
    2^13 = 8192 total candidates — easily exhaustive.
    """
    # Map each cell to its independent index
    # Pairs: (0,0)↔(4,4), (0,1)↔(4,3), (0,2)↔(4,2), (0,3)↔(4,1), (0,4)↔(4,0),
    #        (1,0)↔(3,4), (1,1)↔(3,3), (1,2)↔(3,2), (1,3)↔(3,1), (1,4)↔(3,0),
    #        (2,0)↔(2,4), (2,1)↔(2,3)
    # Center: (2,2)
    independent_cells = [
        ((0, 0), (4, 4)),
        ((0, 1), (4, 3)),
        ((0, 2), (4, 2)),
        ((0, 3), (4, 1)),
        ((0, 4), (4, 0)),
        ((1, 0), (3, 4)),
        ((1, 1), (3, 3)),
        ((1, 2), (3, 2)),
        ((1, 3), (3, 1)),
        ((1, 4), (3, 0)),
        ((2, 0), (2, 4)),
        ((2, 1), (2, 3)),
        ((2, 2),),  # center — maps to itself
    ]

    valid_patterns = []

    for bits in range(1 << 13):
        # Build flat grid
        grid = ["."] * 25
        n_blacks = 0
        for i, cells in enumerate(independent_cells):
            if bits & (1 << i):
                for r, c in cells:
                    grid[r * GRID_SIZE + c] = "#"
                n_blacks += len(cells)

        if n_blacks < MIN_BLACKS or n_blacks > MAX_BLACKS:
            continue

        flat = tuple(grid)

        # Connectivity
        if not _is_connected(flat):
            continue

        # Slot validity (no 2-letter slots)
        slots = _get_slots_from_flat(flat)
        if not slots:
            continue

        # Score
        score = _score_pattern(flat, slots)
        if score <= 0:
            continue

        # Convert flat to row-tuple format
        pattern = tuple("".join(flat[r * GRID_SIZE:(r + 1) * GRID_SIZE]) for r in range(GRID_SIZE))
        valid_patterns.append((score, n_blacks, pattern))

    # Sort by score descending
    valid_patterns.sort(key=lambda x: -x[0])

    patterns = [p for _, _, p in valid_patterns]
    # Print summary
    from collections import Counter
    black_counts = Counter(nb for _, nb, _ in valid_patterns)
    print(f"Generated {len(patterns)} valid grid patterns:")
    for nb in sorted(black_counts):
        print(f"  {nb} blacks: {black_counts[nb]} patterns")

    return patterns


# Generated at startup
PATTERNS: list[tuple[str, ...]] = []


# ── Data Download ─────────────────────────────────────────────────────

def _make_ssl_context() -> ssl.SSLContext:
    """Create an SSL context that works with brew Python on macOS."""
    candidates = [
        Path("/opt/homebrew/etc/ca-certificates/cert.pem"),
        Path("/usr/local/etc/ca-certificates/cert.pem"),
    ]
    exe = Path(sys.executable).resolve()
    for parent in exe.parents:
        cert = parent / "etc" / "ca-certificates" / "cert.pem"
        if cert.exists():
            candidates.insert(0, cert)
            break
    for cafile in candidates:
        if cafile.exists():
            return ssl.create_default_context(cafile=str(cafile))
    return ssl.create_default_context()


_ssl_ctx = None


def _urlretrieve(url: str, dest: Path):
    global _ssl_ctx
    if _ssl_ctx is None:
        _ssl_ctx = _make_ssl_context()
    with urllib.request.urlopen(url, context=_ssl_ctx) as resp, open(dest, "wb") as f:
        shutil.copyfileobj(resp, f)


def download_clues(cache_dir: Path):
    """Download clues.tsv to cache_dir if not already present."""
    cache_dir.mkdir(parents=True, exist_ok=True)
    clues_path = cache_dir / "clues.tsv"
    if not clues_path.exists():
        print("  Downloading xd-clues (67 MB)...")
        zip_path = cache_dir / "xd-clues.zip"
        _urlretrieve("https://xd.saul.pw/xd-clues.zip", zip_path)
        with zipfile.ZipFile(zip_path) as z:
            for member in z.namelist():
                if member.endswith("clues.tsv"):
                    with z.open(member) as src, open(clues_path, "wb") as dst:
                        shutil.copyfileobj(src, dst)
        zip_path.unlink()
        print(f"  clues.tsv: {clues_path.stat().st_size // 1024 // 1024} MB")
    return clues_path


# ── Load Words + Clues + Build Indices ────────────────────────────────

def load_words(filepath: Path) -> set[str]:
    words = set()
    with open(filepath) as f:
        for line in f:
            w = line.strip().replace("_", "").upper()
            if 3 <= len(w) <= 5 and re.match(r"^[A-Z]+$", w):
                words.add(w)
    return words


def build_data(word_dir: Path, clues_tsv: Path):
    """Load words, clues, and build bitset indices into module globals.

    Args:
        word_dir: Directory containing crossword-core.txt and crossword-contemporary.txt
        clues_tsv: Path to the xd-clues clues.tsv file
    """
    global words_by_len, clue_map, letter_bits, all_bits

    word_set = load_words(word_dir / "crossword-core.txt") | load_words(word_dir / "crossword-contemporary.txt")
    print(f"MsFit words (3-5 letters): {len(word_set)}")

    # Load clues — store up to MAX_CLUES_PER_WORD distinct clues per word
    _clue_map = defaultdict(list)
    with open(clues_tsv) as f:
        next(f)  # skip header
        for line in f:
            parts = line.rstrip("\n").split("\t")
            if len(parts) < 4:
                continue
            ans, clue = parts[2], parts[3]
            if not ans or not clue or len(clue) < 3:
                continue
            if not re.match(r"^[A-Z]+$", ans):
                continue
            if ans not in word_set:
                continue
            lst = _clue_map[ans]
            if len(lst) < MAX_CLUES_PER_WORD and clue not in lst:
                lst.append(clue)
    clue_map = dict(_clue_map)

    # Only keep words with clues, grouped by length
    _words_by_len = defaultdict(list)
    for w in sorted(word_set):
        if w in clue_map:
            _words_by_len[len(w)].append(w)
    words_by_len = dict(_words_by_len)

    total = sum(len(v) for v in words_by_len.values())
    print(f"Words with clues: {total}")
    for length in range(3, 6):
        count = len(words_by_len.get(length, []))
        if count:
            print(f"  {length} letters: {count:5d}")

    # Build bitset indices
    _letter_bits = {}
    _all_bits = {}

    for length, words in words_by_len.items():
        n = len(words)
        _all_bits[length] = (1 << n) - 1
        _letter_bits[length] = {}
        for pos in range(length):
            by_letter = defaultdict(int)
            for i, w in enumerate(words):
                by_letter[w[pos]] |= 1 << i
            _letter_bits[length][pos] = dict(by_letter)

    letter_bits = _letter_bits
    all_bits = _all_bits
    print("Bitset indices built.")


# ── Solver ────────────────────────────────────────────────────────────

def get_slots(pattern: tuple[str, ...]) -> list[dict]:
    flat = _pattern_to_flat(pattern)
    slots = []
    for r in range(GRID_SIZE):
        c = 0
        while c < GRID_SIZE:
            if flat[r * GRID_SIZE + c] == "#":
                c += 1
                continue
            end = c
            while end < GRID_SIZE and flat[r * GRID_SIZE + end] != "#":
                end += 1
            length = end - c
            if length >= 3:
                cells = [(r, c + i) for i in range(length)]
                slots.append({"dir": "across", "row": r, "col": c, "length": length, "cells": cells})
            c = end
    for c in range(GRID_SIZE):
        r = 0
        while r < GRID_SIZE:
            if flat[r * GRID_SIZE + c] == "#":
                r += 1
                continue
            end = r
            while end < GRID_SIZE and flat[end * GRID_SIZE + c] != "#":
                end += 1
            length = end - r
            if length >= 3:
                cells = [(r + i, c) for i in range(length)]
                slots.append({"dir": "down", "row": r, "col": c, "length": length, "cells": cells})
            r = end

    cell_map: dict[tuple[int, int], list[tuple[int, int]]] = {}
    for si, slot in enumerate(slots):
        for pi, cell in enumerate(slot["cells"]):
            cell_map.setdefault(cell, []).append((si, pi))

    for si, slot in enumerate(slots):
        crossings = []
        for pi, cell in enumerate(slot["cells"]):
            for osi, opi in cell_map[cell]:
                if osi != si:
                    crossings.append((pi, osi, opi))
        slot["crossings"] = crossings

    return slots


def solve_one(pattern: tuple[str, ...], max_backtracks: int = MAX_BACKTRACKS) -> dict | None:
    """Solve a single grid pattern. Returns result dict or None."""
    slots = get_slots(pattern)
    if not slots:
        return None

    n_slots = len(slots)
    lengths = [s["length"] for s in slots]
    crossings = [s["crossings"] for s in slots]

    for l in lengths:
        if not words_by_len.get(l):
            return None

    candidates = [all_bits[l] for l in lengths]
    assignment: list[int | None] = [None] * n_slots
    used_words: set[str] = set()
    backtracks = 0

    def solve() -> bool:
        nonlocal backtracks
        if backtracks > max_backtracks:
            return False

        # MCV: pick unassigned slot with fewest candidates
        best_slot = -1
        best_count = float("inf")
        for si in range(n_slots):
            if assignment[si] is not None:
                continue
            cnt = candidates[si].bit_count()
            if cnt == 0:
                return False
            if cnt < best_count:
                best_count = cnt
                best_slot = si

        if best_slot == -1:
            return True

        si = best_slot
        length = lengths[si]
        words = words_by_len[length]
        cand_bs = candidates[si]

        trial_indices = _sample_bits(cand_bs, CANDIDATE_LIMIT)

        for wi in trial_indices:
            word = words[wi]
            if word in used_words:
                continue

            assignment[si] = wi
            used_words.add(word)

            saved: list[tuple[int, int]] = []
            viable = True
            for pos_in_this, osi, pos_in_other in crossings[si]:
                if assignment[osi] is not None:
                    continue
                letter = word[pos_in_this]
                other_len = lengths[osi]
                mask = letter_bits[other_len][pos_in_other].get(letter, 0)
                old = candidates[osi]
                new = old & mask
                if new == 0:
                    viable = False
                    for s_idx, s_val in saved:
                        candidates[s_idx] = s_val
                    break
                if new != old:
                    saved.append((osi, old))
                    candidates[osi] = new

            if viable and solve():
                return True

            backtracks += 1
            assignment[si] = None
            used_words.discard(word)
            for s_idx, s_val in saved:
                candidates[s_idx] = s_val

            if backtracks > max_backtracks:
                return False

        return False

    if not solve():
        return None

    # Build result
    flat = _pattern_to_flat(pattern)
    grid = [
        ["#" if flat[r * GRID_SIZE + c] == "#" else "." for c in range(GRID_SIZE)]
        for r in range(GRID_SIZE)
    ]
    word_strings = []
    for si, slot in enumerate(slots):
        w = words_by_len[lengths[si]][assignment[si]]
        word_strings.append(w)
        for i, (r, c) in enumerate(slot["cells"]):
            grid[r][c] = w[i]
    grid_rows = ["".join(row) for row in grid]

    return {
        "pattern": pattern,
        "grid_rows": grid_rows,
        "slots": slots,
        "word_strings": word_strings,
    }


def _sample_bits(bs: int, limit: int) -> list[int]:
    """Sample up to `limit` random set-bit positions from a bitset."""
    indices = []
    tmp = bs
    while tmp:
        lsb = tmp & (-tmp)
        indices.append(lsb.bit_length() - 1)
        tmp ^= lsb
    if len(indices) <= limit:
        random.shuffle(indices)
        return indices
    return random.sample(indices, limit)


# ── Clue Assignment with Rotation ─────────────────────────────────────

def assign_clues(word_strings: list[str], clue_usage_counts: dict[str, dict[str, int]]) -> dict[str, str] | None:
    """
    Pick one clue per word, minimizing reuse and ensuring no duplicate clue text within the puzzle.

    Returns a dict mapping word -> chosen clue text, or None if constraints can't be satisfied.
    """
    assigned: dict[str, str] = {}
    used_clue_texts: set[str] = set()

    # Sort unique words by fewest available clues (most constrained first)
    unique_words = list(dict.fromkeys(word_strings))  # preserves order, deduplicates
    unique_words.sort(key=lambda w: len(clue_map.get(w, [])))

    for word in unique_words:
        available = clue_map.get(word, [])
        if not available:
            return None

        # Filter out clue texts already used in this puzzle
        candidates = [c for c in available if c not in used_clue_texts]

        if not candidates:
            return None  # cannot satisfy no-duplicate-clue constraint

        # Among candidates, pick the least-used one globally
        usage = clue_usage_counts.get(word, {})
        candidates.sort(key=lambda c: usage.get(c, 0))
        min_usage = usage.get(candidates[0], 0)
        tied = [c for c in candidates if usage.get(c, 0) == min_usage]
        chosen = random.choice(tied)

        assigned[word] = chosen
        used_clue_texts.add(chosen)

        # Update global counts
        if word not in clue_usage_counts:
            clue_usage_counts[word] = {}
        clue_usage_counts[word][chosen] = clue_usage_counts[word].get(chosen, 0) + 1

    return assigned


def build_puzzle(result: dict, clue_assignments: dict[str, str]) -> dict:
    """Build a puzzle dict from solver result and clue assignments."""
    grid_rows = result["grid_rows"]
    slots = result["slots"]
    word_strings = result["word_strings"]

    # Standard crossword numbering
    number_map = {}
    num = 0
    for r in range(GRID_SIZE):
        for c in range(GRID_SIZE):
            if grid_rows[r][c] == "#":
                continue
            starts_across = (
                (c == 0 or grid_rows[r][c - 1] == "#")
                and c + 1 < GRID_SIZE
                and grid_rows[r][c + 1] != "#"
            )
            starts_down = (
                (r == 0 or grid_rows[r - 1][c] == "#")
                and r + 1 < GRID_SIZE
                and grid_rows[r + 1][c] != "#"
            )
            if starts_across or starts_down:
                num += 1
                number_map[(r, c)] = num

    across_clues, down_clues = [], []
    for si, slot in enumerate(slots):
        w = word_strings[si]
        n = number_map.get((slot["row"], slot["col"]))
        if not n:
            return None
        entry = {
            "number": n,
            "clue": clue_assignments[w],
            "row": slot["row"],
            "col": slot["col"],
            "length": slot["length"],
        }
        if slot["dir"] == "across":
            across_clues.append(entry)
        else:
            down_clues.append(entry)

    across_clues.sort(key=lambda x: x["number"])
    down_clues.sort(key=lambda x: x["number"])

    return {
        "size": GRID_SIZE,
        "grid": grid_rows,
        "clues": {"across": across_clues, "down": down_clues},
    }


# ── Data Integrity Validation ─────────────────────────────────────────

def validate_puzzles(puzzles: list[dict]):
    """Run comprehensive data integrity checks on all generated puzzles."""
    errors = 0
    clue_reuse_stats = defaultdict(int)  # tracks how many times each clue text appears across all puzzles

    for i, puzzle in enumerate(puzzles):
        pid = puzzle.get("id", i + 1)
        grid = puzzle["grid"]

        # Grid dimensions
        if len(grid) != GRID_SIZE:
            print(f"  ERROR puzzle {pid}: grid has {len(grid)} rows, expected {GRID_SIZE}")
            errors += 1
            continue
        for r, row in enumerate(grid):
            if len(row) != GRID_SIZE:
                print(f"  ERROR puzzle {pid}: row {r} has {len(row)} chars, expected {GRID_SIZE}")
                errors += 1

        # Valid characters
        for r, row in enumerate(grid):
            for c, ch in enumerate(row):
                if ch != "#" and not ("A" <= ch <= "Z"):
                    print(f"  ERROR puzzle {pid}: invalid char '{ch}' at ({r},{c})")
                    errors += 1

        # No duplicate words within puzzle
        all_words = []
        for direction in ("across", "down"):
            for clue_entry in puzzle["clues"][direction]:
                r, c, length = clue_entry["row"], clue_entry["col"], clue_entry["length"]
                if direction == "across":
                    word = grid[r][c:c + length]
                else:
                    word = "".join(grid[r + i][c] for i in range(length))
                all_words.append(word)

        if len(all_words) != len(set(all_words)):
            dupes = [w for w in all_words if all_words.count(w) > 1]
            print(f"  ERROR puzzle {pid}: duplicate words: {set(dupes)}")
            errors += 1

        # No duplicate clue text within puzzle
        all_clue_texts = []
        for direction in ("across", "down"):
            for clue_entry in puzzle["clues"][direction]:
                all_clue_texts.append(clue_entry["clue"])
                clue_reuse_stats[clue_entry["clue"]] += 1

        if len(all_clue_texts) != len(set(all_clue_texts)):
            dupes = [t for t in all_clue_texts if all_clue_texts.count(t) > 1]
            print(f"  ERROR puzzle {pid}: duplicate clue texts: {dupes[:3]}")
            errors += 1

        # All words exist in word list
        for w in all_words:
            wlen = len(w)
            if wlen not in words_by_len or w not in words_by_len[wlen]:
                # Word might still be valid if not loaded — skip this check if word data not available
                if words_by_len:
                    print(f"  ERROR puzzle {pid}: word '{w}' not in word list")
                    errors += 1

        # Verify clue numbering
        number_map = {}
        num = 0
        for r in range(GRID_SIZE):
            for c in range(GRID_SIZE):
                if grid[r][c] == "#":
                    continue
                starts_across = (
                    (c == 0 or grid[r][c - 1] == "#")
                    and c + 1 < GRID_SIZE
                    and grid[r][c + 1] != "#"
                )
                starts_down = (
                    (r == 0 or grid[r - 1][c] == "#")
                    and r + 1 < GRID_SIZE
                    and grid[r + 1][c] != "#"
                )
                if starts_across or starts_down:
                    num += 1
                    number_map[(r, c)] = num

        for direction in ("across", "down"):
            for clue_entry in puzzle["clues"][direction]:
                expected_num = number_map.get((clue_entry["row"], clue_entry["col"]))
                if expected_num != clue_entry["number"]:
                    print(f"  ERROR puzzle {pid}: clue {direction} at ({clue_entry['row']},{clue_entry['col']}) "
                          f"has number {clue_entry['number']}, expected {expected_num}")
                    errors += 1

    # Summary
    if errors:
        print(f"\nVALIDATION FAILED: {errors} errors found!")
        sys.exit(1)
    else:
        print(f"  All {len(puzzles)} puzzles passed validation.")

    # Clue reuse stats
    if clue_reuse_stats:
        max_reuse = max(clue_reuse_stats.values())
        reused = sum(1 for v in clue_reuse_stats.values() if v > 1)
        print(f"  Unique clue texts: {len(clue_reuse_stats)}")
        print(f"  Clues reused across puzzles: {reused}")
        print(f"  Max reuse count: {max_reuse}")

    # Pattern distribution
    pattern_counts = defaultdict(int)
    for puzzle in puzzles:
        black_positions = tuple(
            (r, c) for r in range(GRID_SIZE) for c in range(GRID_SIZE)
            if puzzle["grid"][r][c] == "#"
        )
        pattern_counts[black_positions] += 1
    print(f"  Pattern distribution ({len(pattern_counts)} distinct patterns):")
    for pat, count in sorted(pattern_counts.items(), key=lambda x: -x[1]):
        label = "solid" if not pat else str(pat)
        print(f"    {label}: {count} puzzles")


# ── Worker Process ────────────────────────────────────────────────────

_worker_max_backtracks = MAX_BACKTRACKS


def _worker_init(word_dir_str: str, clues_tsv_str: str, max_bt: int):
    global _worker_max_backtracks
    _worker_max_backtracks = max_bt
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    random.seed()
    import io
    sys.stdout = io.StringIO()
    build_data(Path(word_dir_str), Path(clues_tsv_str))
    sys.stdout = sys.__stdout__


def _worker_solve(pattern: tuple[str, ...]) -> dict | None:
    try:
        result = solve_one(pattern, _worker_max_backtracks)
        if result is None:
            return None
        # Don't send slots back (not picklable-friendly complex dicts), rebuild in main
        return {
            "pattern": result["pattern"],
            "grid_rows": result["grid_rows"],
            "word_strings": result["word_strings"],
        }
    except Exception as exc:
        import traceback
        sys.__stderr__.write(f"Worker error: {exc}\n{traceback.format_exc()}\n")
        return None


# ── Checkpoint ────────────────────────────────────────────────────────

def save_checkpoint(puzzles: list[dict], clue_usage_counts: dict, checkpoint_path: Path):
    tmp = checkpoint_path.with_suffix(".tmp")
    with open(tmp, "w") as f:
        json.dump({"puzzles": puzzles, "clue_usage_counts": clue_usage_counts}, f)
    tmp.rename(checkpoint_path)


def load_checkpoint(checkpoint_path: Path) -> tuple[list[dict], dict]:
    if checkpoint_path.exists():
        with open(checkpoint_path) as f:
            data = json.load(f)
        puzzles = data.get("puzzles", [])
        clue_usage_counts = data.get("clue_usage_counts", {})
        print(f"Resumed from checkpoint: {len(puzzles)} puzzles")
        return puzzles, clue_usage_counts
    return [], {}


# ── Pack Writer ───────────────────────────────────────────────────────

def load_existing_packs(out_dir: Path) -> list[dict]:
    puzzles = []
    for pack_file in sorted(out_dir.glob("pack-*.js")):
        content = pack_file.read_text()
        json_str = content.split("=", 1)[1].rstrip().rstrip(";").strip()
        pack = json.loads(json_str)
        puzzles.extend(pack)
    if puzzles:
        print(f"Loaded {len(puzzles)} existing puzzles from {out_dir}")
    return puzzles


def write_packs(puzzles: list[dict], out_dir: Path, pack_size: int):
    out_dir.mkdir(parents=True, exist_ok=True)
    total_packs = math.ceil(len(puzzles) / pack_size) if puzzles else 0

    for p in range(total_packs):
        start = p * pack_size
        end = min(start + pack_size, len(puzzles))
        pack = puzzles[start:end]
        padded = str(p + 1).zfill(3)
        with open(out_dir / f"pack-{padded}.js", "w") as f:
            f.write(f"export const PUZZLES = {json.dumps(pack)};\n")
        print(f"  pack-{padded}.js: {len(pack)} puzzles")

    # Remove leftover pack files from old datasets
    for existing in sorted(out_dir.glob("pack-*.js")):
        num = int(existing.stem.split("-")[1])
        if num > total_packs:
            existing.unlink()
            print(f"  Removed old {existing.name}")

    with open(out_dir / "index.js", "w") as f:
        f.write(f"export const TOTAL_PACKS = {total_packs};\n")
        f.write(f"export const PACK_SIZE = {pack_size};\n")
        f.write(f"export const TOTAL_PUZZLES = {len(puzzles)};\n")

    print(f"\n{total_packs} packs written to {out_dir}")


# ── Main ──────────────────────────────────────────────────────────────

def main():
    args = parse_args()
    target = args.target
    pack_size = args.pack_size
    n_workers = args.workers or mp.cpu_count()
    max_bt = args.max_backtracks

    script_dir = Path(__file__).resolve().parent
    project_dir = script_dir.parent
    word_dir = project_dir / "data"               # word lists (checked into git)
    cache_dir = script_dir / "data"               # downloaded clues (gitignored, too large)
    out_dir = project_dir / "games" / "mini-crossword" / "puzzles"
    checkpoint_path = script_dir / CHECKPOINT_FILE

    print("=" * 60)
    print(f"Mini Crossword Generator — target: {target}, workers: {n_workers}")
    print("=" * 60)

    # Generate valid grid patterns
    print("\nGenerating grid patterns...")
    global PATTERNS
    PATTERNS = generate_patterns()
    if not PATTERNS:
        print("ERROR: No valid grid patterns found!")
        sys.exit(1)

    # Download clues (word lists already in data/)
    print("\nChecking data files...")
    clues_tsv = download_clues(cache_dir)

    # Build indices in main process
    print("\nBuilding word/clue indices...")
    build_data(word_dir, clues_tsv)

    # Load existing puzzles if appending, or resume from checkpoint
    puzzles = []
    clue_usage_counts: dict[str, dict[str, int]] = {}
    if args.append:
        puzzles = load_existing_packs(out_dir)
    if args.resume:
        checkpoint_puzzles, checkpoint_clue_usage = load_checkpoint(checkpoint_path)
        if len(checkpoint_puzzles) > len(puzzles):
            puzzles = checkpoint_puzzles
            clue_usage_counts = checkpoint_clue_usage

    # Track used grids to avoid duplicates
    used_grids: set[str] = {"".join(p["grid"]) for p in puzzles}

    # Graceful shutdown
    shutdown = False

    def handle_signal(sig, frame):
        nonlocal shutdown
        if shutdown:
            print("\nForce quit.")
            sys.exit(1)
        shutdown = True
        print(f"\nShutting down gracefully... ({len(puzzles)} puzzles saved)")

    signal.signal(signal.SIGINT, handle_signal)
    signal.signal(signal.SIGTERM, handle_signal)

    # Prepare work items: each pattern repeated multiple times per pass
    repeats_per_pattern = max(1, target // len(PATTERNS) // 3)

    attempted = 0
    start_time = time.time()
    pass_num = 0

    print(f"\nGenerating {target} puzzles...\n")

    try:
        with mp.Pool(n_workers, initializer=_worker_init, initargs=(str(word_dir), str(clues_tsv), max_bt)) as pool:
            while len(puzzles) < target and not shutdown:
                pass_num += 1
                # Create work batch: each pattern repeated, shuffled
                work_items = list(PATTERNS) * repeats_per_pattern
                random.shuffle(work_items)

                if pass_num > 1:
                    print(f"\n--- Pass {pass_num} ---")

                last_checkpoint = len(puzzles)
                for worker_result in pool.imap_unordered(_worker_solve, work_items, chunksize=1):
                    if len(puzzles) >= target or shutdown:
                        break

                    attempted += 1
                    if worker_result is None:
                        continue

                    # Check for duplicate grid
                    grid_key = "".join(worker_result["grid_rows"])
                    if grid_key in used_grids:
                        continue
                    used_grids.add(grid_key)

                    # Rebuild slots for clue assignment (not sent from worker)
                    slots = get_slots(worker_result["pattern"])
                    worker_result["slots"] = slots

                    # Assign clues with rotation
                    clue_assignments = assign_clues(worker_result["word_strings"], clue_usage_counts)
                    if clue_assignments is None:
                        continue

                    puzzle = build_puzzle(worker_result, clue_assignments)
                    if puzzle is None:
                        continue

                    puzzle["id"] = len(puzzles) + 1
                    puzzles.append(puzzle)

                    elapsed = time.time() - start_time
                    rate = len(puzzles) / elapsed * 60 if elapsed > 0 else 0
                    print(
                        f"  Puzzle {len(puzzles):4d}/{target} | "
                        f"{attempted} attempted | "
                        f"{elapsed:.0f}s | "
                        f"{rate:.1f}/min"
                    )

                    # Checkpoint every 50 puzzles
                    if len(puzzles) - last_checkpoint >= 50:
                        save_checkpoint(puzzles, clue_usage_counts, checkpoint_path)
                        last_checkpoint = len(puzzles)

                if pass_num >= 10:
                    print(f"\nReached {pass_num} passes. Stopping.")
                    break
    except KeyboardInterrupt:
        shutdown = True
        print(f"\nInterrupted. Saving {len(puzzles)} puzzles...")
        if puzzles:
            save_checkpoint(puzzles, clue_usage_counts, checkpoint_path)

    elapsed = time.time() - start_time
    success_pct = len(puzzles) / attempted * 100 if attempted else 0
    print(f"\nDone! {len(puzzles)} puzzles in {elapsed:.0f}s")
    print(f"  {attempted} patterns attempted ({success_pct:.0f}% success rate)")

    if not puzzles:
        print("No puzzles generated. Check data files and patterns.")
        sys.exit(1)

    # Validate all puzzles
    print("\nValidating puzzles...")
    validate_puzzles(puzzles)

    # Write pack files
    print(f"\nWriting packs to {out_dir}...")
    write_packs(puzzles, out_dir, pack_size)

    # Clean up checkpoint
    if checkpoint_path.exists():
        checkpoint_path.unlink()

    print("\nAll done!")


if __name__ == "__main__":
    main()
