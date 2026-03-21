# Open Games

A collection of free, open-source browser-based puzzle games inspired by the NY Times Games section. Built with vanilla HTML, CSS, and JavaScript — no frameworks, no build tools.

**[Play it live](https://joetul.github.io/open-games/)**

## Games

- **Sudoku** — Fill the 9x9 grid so every row, column, and 3x3 box contains the digits 1–9. Multiple difficulty levels from easy to expert.
- **Word Guess** — Guess the 5-letter word in 6 tries. Each guess reveals which letters are correct, misplaced, or absent.
- **Connections** — Group 16 words into 4 categories of 4. Find the hidden connections between the words.
- **Crossword** — Classic 15x15 crossword puzzles with across and down clues. 3,000 puzzles available.
- **Mini Crossword** — A quick 5x5 crossword puzzle — perfect for a short break. 3,000 puzzles available.

## Features

- Dark and light themes
- Timer with pause/resume (Sudoku, Crossword, Mini Crossword)
- Keyboard navigation (Sudoku, Word Guess, Crossword, Mini Crossword)
- Mobile-friendly with responsive layouts
- No accounts, no tracking, no ads

## Running Locally

Since this project uses ES modules, you need a local server:

```bash
python3 -m http.server
```

Then open [http://localhost:8000](http://localhost:8000) in your browser.


## Data Sources

| Game | Source |
|------|--------|
| **Sudoku** | 2,000 puzzles from the [Sudoku Exchange Puzzle Bank](https://github.com/grantm/sudoku-exchange-puzzle-bank) (Public Domain) — difficulty rated by [Sukaku Explainer](https://github.com/SudokuMonster/SukakuExplainer) based on solving techniques required. |
| **Word Guess** | Word lists from [lynn/hello-wordl](https://github.com/lynn/hello-wordl) (MIT) — answers curated from Peter Norvig's word frequency list, valid guesses from the Scrabble tournament word list. |
| **Connections** | Puzzles are AI-generated. |
| **Crossword** | 3,000 puzzles converted from the [XD Puzzles](https://xd.saul.pw/) dataset — pre-1965 NY Times crosswords (public domain). |
| **Mini Crossword** | 3,000 puzzles generated using a backtracking grid builder with clues from the [xd-clues](https://xd.saul.pw/data/) dataset (6M+ clue-answer pairs from published crosswords). |

## License

MIT
