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
