import { PUZZLE_THEME_OPTIONS, type PuzzleThemeId } from './puzzleCsv'

export type TrainMode = 'both' | 'white' | 'black'

/** Bounds of the puzzle rating slider (the Lichess puzzle DB spans roughly 400-3300). */
export const PUZZLE_RATING_MIN = 300
export const PUZZLE_RATING_MAX = 3400

export type AppSettings = {
    trainingDepth: number
    openingsTrainMode: TrainMode
    puzzleThemes: PuzzleThemeId[]
    puzzleRatingMin: number
    puzzleRatingMax: number
}

export const DEFAULT_SETTINGS: AppSettings = {
    trainingDepth: 7,
    openingsTrainMode: 'both',
    puzzleThemes: [],
    puzzleRatingMin: 1700,
    puzzleRatingMax: 1900,
}

const TRAIN_MODES: readonly TrainMode[] = ['both', 'white', 'black']
const PUZZLE_THEME_IDS: readonly string[] = PUZZLE_THEME_OPTIONS.map((option) => option.id)

function parseRating(value: unknown, fallback: number): number {
    const n = Number(value)
    if (!Number.isFinite(n)) return fallback
    return Math.min(PUZZLE_RATING_MAX, Math.max(PUZZLE_RATING_MIN, Math.round(n)))
}

export function parseSettingsJson(text: string): AppSettings | { error: string } {
    try {
        const raw = JSON.parse(text) as unknown
        if (!raw || typeof raw !== 'object') return { error: 'Invalid settings JSON.' }
        const o = raw as Partial<Record<keyof AppSettings, unknown>>
        const trainingDepth = Number(o.trainingDepth)
        if (!Number.isFinite(trainingDepth) || trainingDepth < 1 || !Number.isInteger(trainingDepth)) {
            return { error: 'trainingDepth must be a positive integer.' }
        }

        // Fields added after trainingDepth fall back to their defaults when missing or invalid,
        // so older settings files keep working instead of being reset.
        const openingsTrainMode = TRAIN_MODES.includes(o.openingsTrainMode as TrainMode)
            ? o.openingsTrainMode as TrainMode
            : DEFAULT_SETTINGS.openingsTrainMode
        const puzzleThemes = Array.isArray(o.puzzleThemes)
            ? o.puzzleThemes.filter((id): id is PuzzleThemeId => PUZZLE_THEME_IDS.includes(id as string))
            : DEFAULT_SETTINGS.puzzleThemes
        const ratingA = parseRating(o.puzzleRatingMin, DEFAULT_SETTINGS.puzzleRatingMin)
        const ratingB = parseRating(o.puzzleRatingMax, DEFAULT_SETTINGS.puzzleRatingMax)

        return {
            trainingDepth,
            openingsTrainMode,
            puzzleThemes,
            puzzleRatingMin: Math.min(ratingA, ratingB),
            puzzleRatingMax: Math.max(ratingA, ratingB),
        }
    }
    catch {
        return { error: 'Could not parse settings JSON.' }
    }
}

export function serializeSettings(settings: AppSettings): string {
    return JSON.stringify(settings, null, 4)
}
