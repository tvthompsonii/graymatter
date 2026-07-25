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

export type PuzzlePickResult = {
    puzzle: {
        id: string
        fen: string
        moves: string[]
        rating: number
        nbPlays: number
        themes: string[]
    } | null
    noMatches?: boolean
}

export type GraymatterApi = {
    platform: NodeJS.Platform
    getPaths: () => Promise<GraymatterPaths>
    readTextFile: (filePath: string) => Promise<string>
    writeTextFile: (filePath: string, contents: string) => Promise<void>
    /** @deprecated Use fetchNextPuzzle */
    pickRandomPuzzle: (filters: PuzzlePickFilters) => Promise<PuzzlePickResult>
    fetchNextPuzzle: (filters: PuzzlePickFilters) => Promise<PuzzlePickResult>
}

declare global {
    interface Window {
        graymatter: GraymatterApi
    }
}

export {}
