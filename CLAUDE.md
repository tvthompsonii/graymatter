# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

GrayMatter — a chess opening trainer and puzzle trainer, shipped as an Electron desktop app (Vite + React 19 + TypeScript renderer, CommonJS Electron main process). Three modes: **Openings** (drill your own PGN repertoires), **Puzzles** (drill from a local Lichess puzzle CSV), **Play** (casual game vs. a simple heuristic bot).

## Commands

- `npm run dev` — run Vite dev server + Electron together (main dev workflow; opens the actual app window)
- `npm run dev:web` — Vite only, in a browser (no `window.graymatter` API available, so file-backed features degrade — see below)
- `npm run build` — `tsc -b` (project references, no emit) then `vite build`
- `npm run preview` — preview the built web bundle
- `npm run package` — build then `electron-builder --win` (produces an NSIS installer under `release/`)

There is no test suite and no lint script configured. Type-checking via `tsc -b` (part of `npm run build`) is the only automated check.

## Architecture

### Process split

- `electron/main.cjs` — Electron main process. Owns all filesystem access and exposes it over `ipcMain.handle`. Resolves a fixed set of file paths under `Documents/GrayMatter/` (`PATHS` constant): white/black repertoire PGNs, `TrainingStatus.json`, `settings.json`, the puzzle CSV, `PuzzleStatus.json`. Nothing in the renderer touches the filesystem directly.
- `electron/preload.cjs` — context-bridges `window.graymatter` (`getPaths`, `readTextFile`, `writeTextFile`, `fetchNextPuzzle`) into the renderer with `contextIsolation: true` / `nodeIntegration: false` / `sandbox: true`.
- `electron/puzzleStream.cjs` — streams the (large) Lichess puzzle CSV line-by-line with `readline` rather than loading it into memory, so puzzle lookups stay cheap regardless of file size. Tracks a `lastLineNumber` cursor in `PuzzleStatus.json` and wraps around to the start when it runs off the end of the file.
- `src/graymatter.d.ts` — the renderer-side type contract for `window.graymatter`; keep this in sync with `preload.cjs` any time the IPC surface changes (three places to update together: `main.cjs` handler, `preload.cjs` bridge, `graymatter.d.ts` types).

Renderer code always checks `window.graymatter` before using it, since `npm run dev:web` runs without Electron and that global won't exist — the affected pages show a "run this app in Electron" error state instead of crashing.

### Repertoire trie (Openings mode)

This is the core data structure of the app, spread across three files:

- `src/pgnPaths.ts` — parses PGN text (via `@jackstenglein/pgn-parser`) into a flat list of SAN move sequences (one per line/variation). Handles the tricky part of PGN RAVs: distinguishing a variation that **replaces** the main move (alternate, e.g. `1.e4 (1...c5) e5`) from one that **continues after** it, by replaying both candidates through `chess.js` and seeing which one is legal. Also drops any path that's a strict prefix of a longer path in the same file, so an accidentally-short "stop" line doesn't shadow the real continuation.
- `src/moveTree.ts` — builds/walks the trie (`Node = { fen, moveFromPrevious, needsPractice, children }`) from those SAN paths. `canonicalPathKey(sans)` (comma-joined SAN list from root) is the stable identity used everywhere — as the trie edge key, the training-status persistence key, and the "which line is this" comparison.
- `src/trainingExport.ts` — serializes/deserializes per-node `needsPractice` flags to/from `TrainingStatus.json` (schema-versioned: `version: 3`, `keyKind: 'canonicalPathKey'`), keyed by `canonicalPathKey`.

Flow: `openings.tsx` loads both PGNs on mount → parses each into a `ParsedRepertoire` (paths + trie root) → overlays saved `needsPractice` state from `TrainingStatus.json` → picks a random still-needs-practice line (`pickRandomPracticePath`, bounded by the `trainingDepth` setting = max trainee moves per line) → `TrainerChessboard` plays it out, auto-advancing book/opponent moves and waiting for the trainee's moves at their plies, marking nodes practiced as it goes, and persisting to disk after each change (`persistTraining`, chained through a promise so writes serialize).

### Puzzles mode

`src/puzzles.tsx` (rating range + theme filter UI) → IPC `fetchNextPuzzle` → `electron/puzzleStream.cjs` streams `lichess_db_puzzles.csv` starting after the last-seen line, returns the first match, advances the cursor, wraps to line 0 if it reaches EOF without a match. `src/puzzleBoard.tsx` plays the puzzle's setup move automatically, then the trainee must match the CSV's expected UCI move at each of their turns (wrong moves that aren't checkmate just revert); supports hint (highlights the from-square) and "play solution" (auto-plays out the remaining line).

### Play mode

`src/play.tsx` (`PlayChessboard`) and `src/freePlayBoard.tsx` (`FreePlayChessboard`) are both simple non-persisted vs-bot boards — no repertoire, no puzzle file, nothing saved to disk. `PlayChessboard`'s bot prefers captures (by lowest-value capturing piece), then checks, then a random legal move; `FreePlayChessboard`'s bot is pure random. `freePlayBoard.tsx` currently looks unused by `App.tsx` — check before assuming it's wired in.

### Shared board plumbing

All three board components (`TrainerChessboard`, `PuzzleChessboard`, `PlayChessboard`/`FreePlayChessboard`) duplicate the same `react-chessboard` wiring pattern: a `gameRef` holding a `chess.js` instance as the source of truth, `fen` state driving the rendered position, click-to-move and drag-to-move handlers that converge on one `attempt*Move` function, and square-highlight state for move options / last move / selection. `src/boardTheme.tsx` centralizes the shared visual chrome (`boardChrome`, `customPieces` — SVGs served from `public/staunty/`, `MOVE_ANIMATION_MS`). When touching move-input logic, check whether the fix applies to all three boards, since the logic isn't factored into a shared hook.

### Settings

`src/settings.ts` defines `AppSettings` (currently just `trainingDepth`) with JSON parse/serialize + validation. `App.tsx` loads/saves it via `window.graymatter.readTextFile`/`writeTextFile` against `paths.settings`, falling back to `DEFAULT_SETTINGS` and rewriting the file if it's missing or invalid.

### Versioning convention

`src/appVersion.ts` exports `APP_VERSION`, a hand-maintained `0.<n>-<ISO date>` string shown in each page header. Bump `<n>` and refresh the date when cutting a build — it's the on-screen way to confirm which build is running.
