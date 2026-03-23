#!/usr/bin/env python3
"""
Generates 15x15 crossword puzzles for the Open Games project.

Uses:
- Grid patterns from XD Puzzles dataset
- Words from MsFit Crossword Dataset
- Clues from xd-clues dataset

Optimized for Apple Silicon (M4):
- int.bit_count() for fast popcount
- Efficient multiprocessing with fork-safe initialization
- Checkpoint/resume for long overnight runs
- Pattern reuse to reach high puzzle targets

Usage:
    python3 scripts/generate_crosswords.py [--target 3000] [--pack-size 100] [--workers N] [--append]

Output:
    games/crossword/puzzles/pack-001.js ... pack-NNN.js
    games/crossword/puzzles/index.js
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

GRID_SIZE = 15
MAX_BACKTRACKS = 200_000
CANDIDATE_LIMIT = 120
CHECKPOINT_FILE = "crossword_checkpoint.json"

# ── Globals (populated once, shared via fork or worker init) ──────────

words_by_len: dict[int, list[str]] = {}
clue_map: dict[str, list[str]] = {}
letter_bits: dict[int, dict[int, dict[str, int]]] = {}
all_bits: dict[int, int] = {}


def parse_args():
    p = argparse.ArgumentParser(description="Generate 15x15 crossword puzzles")
    p.add_argument("--target", type=int, default=3000, help="Number of puzzles to generate")
    p.add_argument("--pack-size", type=int, default=100, help="Puzzles per pack file")
    p.add_argument("--workers", type=int, default=None, help="Worker processes (default: all cores)")
    p.add_argument("--max-backtracks", type=int, default=MAX_BACKTRACKS, help="Max backtracks per solve attempt")
    p.add_argument("--resume", action="store_true", help="Resume from checkpoint if available")
    p.add_argument("--append", action="store_true", help="Keep existing puzzles and add more to reach target")
    return p.parse_args()


# ── Data Download ─────────────────────────────────────────────────────

def _make_ssl_context() -> ssl.SSLContext:
    """Create an SSL context that works with brew Python on macOS."""
    # Brew Python often can't find certs. Check common brew locations.
    candidates = [
        Path("/opt/homebrew/etc/ca-certificates/cert.pem"),
        Path("/usr/local/etc/ca-certificates/cert.pem"),
    ]
    # Detect non-standard brew prefix from the Python binary path
    # e.g. /Users/code/homebrew/Cellar/python@3.13/... -> /Users/code/homebrew
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
    """Download a URL to a file."""
    global _ssl_ctx
    if _ssl_ctx is None:
        _ssl_ctx = _make_ssl_context()
    with urllib.request.urlopen(url, context=_ssl_ctx) as resp, open(dest, "wb") as f:
        shutil.copyfileobj(resp, f)


def download_data(cache_dir: Path):
    """Download clues and xd-puzzles to cache_dir if not already present.

    Word lists are in the project data/ directory (checked into git).
    Downloaded files (clues.tsv, xd-puzzles/) go to scripts/data/ (gitignored, too large for git).
    """
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

    xd_dir = cache_dir / "xd-puzzles"
    if not xd_dir.exists():
        print("  Downloading xd-puzzles (12 MB)...")
        zip_path = cache_dir / "xd-puzzles.zip"
        _urlretrieve("https://xd.saul.pw/xd-puzzles.zip", zip_path)
        with zipfile.ZipFile(zip_path) as z:
            z.extractall(xd_dir)
        zip_path.unlink()

    print("Data ready.")
    return clues_path


# ── Load Words + Clues + Build Indices ────────────────────────────────

def load_words(filepath: Path) -> set[str]:
    words = set()
    with open(filepath) as f:
        for line in f:
            w = line.strip().replace("_", "").upper()
            if 3 <= len(w) <= 15 and re.match(r"^[A-Z]+$", w):
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
    print(f"MsFit words: {len(word_set)}")

    # Load clues
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
            if len(lst) < 5 and clue not in lst:
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
    for length in range(3, 16):
        count = len(words_by_len.get(length, []))
        if count:
            print(f"  {length:2d} letters: {count:5d}")

    # Build bitset indices
    # For each (length, position, letter): a Python int used as a bitset
    # where bit i is set if words_by_len[length][i] has that letter at that position.
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


# ── Grid Patterns ────────────────────────────────────────────────────

def extract_pattern(filepath: str) -> tuple[str, ...] | None:
    try:
        with open(filepath, encoding="utf-8", errors="ignore") as f:
            content = f.read().replace("\r\n", "\n")
    except Exception:
        return None
    lines = content.split("\n")
    i = 0
    while i < len(lines) and lines[i].strip():
        i += 1
    i += 1
    while i < len(lines) and not lines[i].strip():
        i += 1
    rows = []
    while i < len(lines) and lines[i].strip():
        rows.append(lines[i].strip())
        i += 1
    if len(rows) != GRID_SIZE:
        return None
    if any(len(r) != GRID_SIZE for r in rows):
        return None
    return tuple("#" if c == "#" else "." for row in rows for c in row)


def get_slot_lengths(pattern: tuple[str, ...]) -> list[int]:
    lengths = []
    for r in range(GRID_SIZE):
        c = 0
        while c < GRID_SIZE:
            if pattern[r * GRID_SIZE + c] == "#":
                c += 1
                continue
            end = c
            while end < GRID_SIZE and pattern[r * GRID_SIZE + end] != "#":
                end += 1
            if end - c >= 3:
                lengths.append(end - c)
            c = end
    for c in range(GRID_SIZE):
        r = 0
        while r < GRID_SIZE:
            if pattern[r * GRID_SIZE + c] == "#":
                r += 1
                continue
            end = r
            while end < GRID_SIZE and pattern[end * GRID_SIZE + c] != "#":
                end += 1
            if end - r >= 3:
                lengths.append(end - r)
            r = end
    return lengths


def load_patterns(data_dir: Path) -> list[tuple[str, ...]]:
    xd_dir = data_dir / "xd-puzzles"
    xd_files = []
    for root, _dirs, files in os.walk(xd_dir):
        for fn in files:
            if fn.endswith(".xd"):
                xd_files.append(os.path.join(root, fn))

    seen = set()
    patterns = []
    for fp in xd_files:
        p = extract_pattern(fp)
        if p and p not in seen:
            seen.add(p)
            patterns.append(p)

    # Filter to patterns we can actually fill
    valid = []
    for p in patterns:
        lengths = get_slot_lengths(p)
        if lengths and all(len(words_by_len.get(l, [])) >= 5 for l in lengths):
            min_pool = min(len(words_by_len[l]) for l in lengths)
            valid.append((min_pool, p))

    random.shuffle(valid)
    valid.sort(key=lambda x: -x[0])  # easiest first
    result = [p for _, p in valid]
    print(f"{len(result)} valid grid patterns")
    return result


# ── Solver ────────────────────────────────────────────────────────────

def get_slots(pattern: tuple[str, ...]) -> list[dict]:
    slots = []
    for r in range(GRID_SIZE):
        c = 0
        while c < GRID_SIZE:
            if pattern[r * GRID_SIZE + c] == "#":
                c += 1
                continue
            end = c
            while end < GRID_SIZE and pattern[r * GRID_SIZE + end] != "#":
                end += 1
            length = end - c
            if length >= 3:
                cells = [(r, c + i) for i in range(length)]
                slots.append({"dir": "across", "row": r, "col": c, "length": length, "cells": cells})
            c = end
    for c in range(GRID_SIZE):
        r = 0
        while r < GRID_SIZE:
            if pattern[r * GRID_SIZE + c] == "#":
                r += 1
                continue
            end = r
            while end < GRID_SIZE and pattern[end * GRID_SIZE + c] != "#":
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
    """Solve a single grid pattern. Returns puzzle dict or None."""
    slots = get_slots(pattern)
    if not slots:
        return None

    n_slots = len(slots)
    lengths = [s["length"] for s in slots]
    crossings = [s["crossings"] for s in slots]

    for l in lengths:
        if not words_by_len.get(l):
            return None

    # Candidate bitsets per slot
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
            cnt = candidates[si].bit_count()  # fast C-level popcount
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

        # Sample up to CANDIDATE_LIMIT random candidates from bitset
        trial_indices = _sample_bits(cand_bs, CANDIDATE_LIMIT)

        for wi in trial_indices:
            word = words[wi]
            if word in used_words:
                continue

            assignment[si] = wi
            used_words.add(word)

            # Forward-check: propagate constraints to crossing slots
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
    grid = [
        ["#" if pattern[r * GRID_SIZE + c] == "#" else "." for c in range(GRID_SIZE)]
        for r in range(GRID_SIZE)
    ]
    word_strings = []
    for si, slot in enumerate(slots):
        w = words_by_len[lengths[si]][assignment[si]]
        word_strings.append(w)
        for i, (r, c) in enumerate(slot["cells"]):
            grid[r][c] = w[i]
    grid_rows = ["".join(row) for row in grid]

    # Numbering
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
        if not n or w not in clue_map:
            return None
        entry = {
            "number": n,
            "clue": random.choice(clue_map[w]),
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

    return {"size": GRID_SIZE, "grid": grid_rows, "clues": {"across": across_clues, "down": down_clues}}


def _sample_bits(bs: int, limit: int) -> list[int]:
    """Efficiently sample up to `limit` random set-bit positions from a bitset."""
    count = bs.bit_count()
    if count <= limit:
        # Extract all bits — faster than random sampling for small sets
        indices = []
        tmp = bs
        while tmp:
            lsb = tmp & (-tmp)
            indices.append(lsb.bit_length() - 1)
            tmp ^= lsb
        random.shuffle(indices)
        return indices

    # For large bitsets, extract all then sample (still fast for typical sizes)
    indices = []
    tmp = bs
    while tmp:
        lsb = tmp & (-tmp)
        indices.append(lsb.bit_length() - 1)
        tmp ^= lsb
    return random.sample(indices, limit)


# ── Worker Process ────────────────────────────────────────────────────

_worker_max_backtracks = MAX_BACKTRACKS


def _worker_init(word_dir_str: str, clues_tsv_str: str, max_bt: int):
    """Initialize worker: load all data into process globals, ignore SIGINT."""
    global _worker_max_backtracks
    _worker_max_backtracks = max_bt
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    random.seed()
    # Suppress per-worker print noise
    import io
    sys.stdout = io.StringIO()
    build_data(Path(word_dir_str), Path(clues_tsv_str))
    sys.stdout = sys.__stdout__


def _worker_solve(pattern: tuple[str, ...]) -> dict | None:
    try:
        return solve_one(pattern, _worker_max_backtracks)
    except Exception as exc:
        import traceback
        sys.__stderr__.write(f"Worker error: {exc}\n{traceback.format_exc()}\n")
        return None


# ── Checkpoint ────────────────────────────────────────────────────────

def save_checkpoint(puzzles: list[dict], checkpoint_path: Path):
    tmp = checkpoint_path.with_suffix(".tmp")
    with open(tmp, "w") as f:
        json.dump(puzzles, f)
    tmp.rename(checkpoint_path)


def load_checkpoint(checkpoint_path: Path) -> list[dict]:
    if checkpoint_path.exists():
        with open(checkpoint_path) as f:
            puzzles = json.load(f)
        print(f"Resumed from checkpoint: {len(puzzles)} puzzles")
        return puzzles
    return []


# ── Pack Writer ───────────────────────────────────────────────────────

def load_existing_packs(out_dir: Path) -> list[dict]:
    """Load all puzzles from existing pack files."""
    puzzles = []
    for pack_file in sorted(out_dir.glob("pack-*.js")):
        content = pack_file.read_text()
        # Strip "export const PUZZLES = " prefix and ";\n" suffix
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

    # Remove any leftover pack files from old datasets
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
    cache_dir = script_dir / "data"               # downloaded data (gitignored, too large)
    out_dir = project_dir / "games" / "crossword" / "puzzles"
    checkpoint_path = script_dir / CHECKPOINT_FILE

    print("=" * 60)
    print(f"Crossword Generator — target: {target}, workers: {n_workers}")
    print("=" * 60)

    # Download clues and xd-puzzles (word lists already in data/)
    print("\nChecking data files...")
    clues_tsv = download_data(cache_dir)

    # Build indices in main process (needed for pattern loading)
    print("\nBuilding word/clue indices...")
    build_data(word_dir, clues_tsv)

    # Load patterns
    print("\nLoading grid patterns...")
    patterns = load_patterns(cache_dir)

    if not patterns:
        print("ERROR: No valid grid patterns found!")
        sys.exit(1)

    # Load existing puzzles if appending, or resume from checkpoint
    puzzles = []
    if args.append:
        puzzles = load_existing_packs(out_dir)
    if args.resume:
        checkpoint_puzzles = load_checkpoint(checkpoint_path)
        if len(checkpoint_puzzles) > len(puzzles):
            puzzles = checkpoint_puzzles

    # Graceful shutdown on Ctrl+C
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

    # Generate puzzles
    attempted = 0
    start_time = time.time()
    pass_num = 0

    print(f"\nGenerating {target} puzzles...\n")

    # We may need multiple passes through patterns to reach the target.
    # Each pass shuffles patterns for different random fills.
    # Pool is created once to avoid re-loading data in workers each pass.
    try:
        with mp.Pool(n_workers, initializer=_worker_init, initargs=(str(word_dir), str(clues_tsv), max_bt)) as pool:
            while len(puzzles) < target and not shutdown:
                pass_num += 1
                work_patterns = list(patterns)
                random.shuffle(work_patterns)

                if pass_num > 1:
                    print(f"\n--- Pass {pass_num} (reshuffled patterns) ---")

                last_checkpoint = len(puzzles)
                for result in pool.imap_unordered(_worker_solve, work_patterns, chunksize=1):
                    if len(puzzles) >= target or shutdown:
                        break

                    attempted += 1
                    if result is not None:
                        result["id"] = len(puzzles) + 1
                        puzzles.append(result)
                        elapsed = time.time() - start_time
                        rate = len(puzzles) / elapsed * 60 if elapsed > 0 else 0
                        print(
                            f"  Puzzle {len(puzzles):3d}/{target} | "
                            f"{attempted} attempted | "
                            f"{elapsed:.0f}s | "
                            f"{rate:.1f}/min"
                        )

                        # Checkpoint every 10 puzzles
                        if len(puzzles) - last_checkpoint >= 10:
                            save_checkpoint(puzzles, checkpoint_path)
                            last_checkpoint = len(puzzles)

                # If we've gone through all patterns 5 times without reaching target, stop
                if pass_num >= 5:
                    print(f"\nReached {pass_num} passes through all patterns. Stopping.")
                    break
    except KeyboardInterrupt:
        shutdown = True
        print(f"\nInterrupted. Saving {len(puzzles)} puzzles...")
        if puzzles:
            save_checkpoint(puzzles, checkpoint_path)

    elapsed = time.time() - start_time
    success_pct = len(puzzles) / attempted * 100 if attempted else 0
    print(f"\nDone! {len(puzzles)} puzzles in {elapsed:.0f}s")
    print(f"  {attempted} patterns attempted ({success_pct:.0f}% success rate)")

    if not puzzles:
        print("No puzzles generated. Check data files and patterns.")
        sys.exit(1)

    # Write pack files
    print(f"\nWriting packs to {out_dir}...")
    write_packs(puzzles, out_dir, pack_size)

    # Clean up checkpoint
    if checkpoint_path.exists():
        checkpoint_path.unlink()

    print("\nAll done!")


if __name__ == "__main__":
    main()
