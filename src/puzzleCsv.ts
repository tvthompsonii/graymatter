export type Puzzle = {
    id: string
    fen: string
    moves: string[]
    rating: number
    nbPlays: number
    themes: string[]
}

export const PUZZLE_THEME_OPTIONS = [
    { label: 'Pin', id: 'pin' },
    { label: 'Fork', id: 'fork' },
    { label: 'Discovered Attack', id: 'discoveredAttack' },
    { label: 'Skewer', id: 'skewer' },
] as const

export type PuzzleThemeId = (typeof PUZZLE_THEME_OPTIONS)[number]['id']

function parseCsvLine(line: string): string[] {
    const result: string[] = []
    let current = ''
    let inQuotes = false
    for (let i = 0; i < line.length; i++) {
        const ch = line[i]!
        if (ch === '"') {
            inQuotes = !inQuotes
        }
        else if (ch === ',' && !inQuotes) {
            result.push(current)
            current = ''
        }
        else {
            current += ch
        }
    }
    result.push(current)
    return result
}

export function parseLichessPuzzleCsv(text: string): Puzzle[] | { error: string } {
    const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0)
    if (lines.length < 2) return { error: 'Puzzle CSV is empty or missing data rows.' }

    const header = parseCsvLine(lines[0]!)
    const idIdx = header.indexOf('PuzzleId')
    const fenIdx = header.indexOf('FEN')
    const movesIdx = header.indexOf('Moves')
    const ratingIdx = header.indexOf('Rating')
    const nbPlaysIdx = header.indexOf('NbPlays')
    const themesIdx = header.indexOf('Themes')

    if (idIdx < 0 || fenIdx < 0 || movesIdx < 0 || ratingIdx < 0 || themesIdx < 0) {
        return { error: 'Puzzle CSV header is missing required columns.' }
    }

    const puzzles: Puzzle[] = []
    for (let i = 1; i < lines.length; i++) {
        const cols = parseCsvLine(lines[i]!)
        const id = cols[idIdx]?.trim()
        const fen = cols[fenIdx]?.trim()
        const movesRaw = cols[movesIdx]?.trim()
        const rating = Number(cols[ratingIdx])
        const nbPlays = nbPlaysIdx >= 0 ? Number(cols[nbPlaysIdx]) : 0
        const themesRaw = cols[themesIdx]?.trim() ?? ''

        if (!id || !fen || !movesRaw || !Number.isFinite(rating)) continue

        const moves = movesRaw.split(/\s+/).filter(Boolean)
        if (!moves.length) continue

        puzzles.push({
            id,
            fen,
            moves,
            rating,
            nbPlays: Number.isFinite(nbPlays) ? nbPlays : 0,
            themes: themesRaw.split(/\s+/).filter(Boolean),
        })
    }

    if (!puzzles.length) return { error: 'No puzzles could be parsed from the CSV.' }
    return puzzles
}

export function filterPuzzles(
    puzzles: Puzzle[],
    minRating: number,
    maxRating: number,
    selectedThemes: readonly PuzzleThemeId[],
): Puzzle[] {
    const lo = Math.min(minRating, maxRating)
    const hi = Math.max(minRating, maxRating)
    const themeSet = new Set(selectedThemes)

    return puzzles.filter((puzzle) => {
        if (puzzle.rating < lo || puzzle.rating > hi) return false
        if (themeSet.size === 0) return true
        return puzzle.themes.some((theme) => themeSet.has(theme as PuzzleThemeId))
    })
}

export function pickRandomPuzzle(puzzles: Puzzle[]): Puzzle | null {
    if (!puzzles.length) return null
    return puzzles[Math.floor(Math.random() * puzzles.length)]!
}
