export type GraymatterPaths = {
    whitePgn: string
    blackPgn: string
    trainingStatus: string
    settings: string
    puzzlesCsv: string
    puzzleStatus: string
}

export type PuzzlePickFilters = {
    minRating: number
    maxRating: number
    themes: string[]
}

export type PuzzleRow = {
    id: string
    fen: string
    moves: string[]
    rating: number
    nbPlays: number
    themes: string[]
}

export type PuzzlePickResult = {
    puzzle: PuzzleRow | null
    /** Where the cursor goes once this puzzle is solved or skipped (see advancePuzzleCursor). */
    nextByteOffset?: number
    noMatches?: boolean
}

export type PuzzleCursor = {
    nextByteOffset: number
    lastPuzzleId: string
}

export type SurvivalSetRequest = {
    /** Each bucket takes up to `count` puzzles rated within `radius` of `rating`. */
    buckets: { rating: number; count: number }[]
    radius: number
    themes: string[]
}

export type SurvivalSetResult = {
    /** Sorted by rating ascending. */
    puzzles: PuzzleRow[]
}

export type GraymatterApi = {
    platform: NodeJS.Platform
    getPaths: () => Promise<GraymatterPaths>
    readTextFile: (filePath: string) => Promise<string>
    writeTextFile: (filePath: string, contents: string) => Promise<void>
    /** Returns the first match at or after the saved cursor, without moving it. */
    fetchNextPuzzle: (filters: PuzzlePickFilters) => Promise<PuzzlePickResult>
    /** Moves the saved cursor past a solved or skipped puzzle. */
    advancePuzzleCursor: (cursor: PuzzleCursor) => Promise<void>
    fetchSurvivalSet: (request: SurvivalSetRequest) => Promise<SurvivalSetResult>
}

declare global {
    interface Window {
        graymatter: GraymatterApi
    }
}

export {}
