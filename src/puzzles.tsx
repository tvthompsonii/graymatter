import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { PuzzleChessboard } from './puzzleBoard'
import {
    PUZZLE_THEME_OPTIONS,
    type Puzzle,
    type PuzzleThemeId,
} from './puzzleCsv'
import {
    PUZZLE_RATING_MAX as RATING_MAX,
    PUZZLE_RATING_MIN as RATING_MIN,
    type AppSettings,
} from './settings'

function DualRatingSlider({
    minRating,
    maxRating,
    onChange,
    onCommit,
}: {
    minRating: number
    maxRating: number
    /** Every step while dragging (updates the display only). */
    onChange: (lo: number, hi: number) => void
    /** The range once a thumb is released. */
    onCommit: (lo: number, hi: number) => void
}) {
    const lo = Math.min(minRating, maxRating)
    const hi = Math.max(minRating, maxRating)

    // The native `change` event fires when a thumb is released (React's onChange fires on every
    // step), so the range is only saved once the user lets go.
    const trackRef = useRef<HTMLDivElement>(null)
    const onCommitRef = useRef(onCommit)
    onCommitRef.current = onCommit
    useEffect(() => {
        const inputs = [...(trackRef.current?.querySelectorAll('input') ?? [])]
        const commit = () => {
            const [a, b] = inputs.map((input) => Number(input.value))
            onCommitRef.current(Math.min(a!, b!), Math.max(a!, b!))
        }
        for (const input of inputs) input.addEventListener('change', commit)
        return () => {
            for (const input of inputs) input.removeEventListener('change', commit)
        }
    }, [])

    return (
        <div>
            <div ref={trackRef} className="relative h-8">
                <div className="absolute top-1/2 h-1.5 w-full -translate-y-1/2 rounded-full bg-slate-700" />
                <div
                    className="absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-amber-500/70"
                    style={{
                        left: `${((lo - RATING_MIN) / (RATING_MAX - RATING_MIN)) * 100}%`,
                        right: `${100 - ((hi - RATING_MIN) / (RATING_MAX - RATING_MIN)) * 100}%`,
                    }}
                />
                <input
                    type="range"
                    min={RATING_MIN}
                    max={RATING_MAX}
                    step={50}
                    value={lo}
                    onChange={(event) => {
                        const nextLo = Number(event.target.value)
                        onChange(Math.min(nextLo, hi), hi)
                    }}
                    className="rating-slider-thumb absolute inset-0 z-20 w-full cursor-pointer appearance-none bg-transparent"
                    aria-label="Minimum puzzle rating"
                />
                <input
                    type="range"
                    min={RATING_MIN}
                    max={RATING_MAX}
                    step={50}
                    value={hi}
                    onChange={(event) => {
                        const nextHi = Number(event.target.value)
                        onChange(lo, Math.max(nextHi, lo))
                    }}
                    className="rating-slider-thumb absolute inset-0 z-30 w-full cursor-pointer appearance-none bg-transparent"
                    aria-label="Maximum puzzle rating"
                />
            </div>
        </div>
    )
}

type PuzzlesPageProps = {
    settings: AppSettings
    onSettingsChange: (patch: Partial<AppSettings>) => void
}

export function PuzzlesPage({ settings, onSettingsChange }: PuzzlesPageProps) {
    const [loadError, setLoadError] = useState<string | null>(null)
    const selectedThemes = useMemo(() => new Set(settings.puzzleThemes), [settings.puzzleThemes])
    // The slider moves a local draft; the range is saved to settings when a thumb is released.
    const [ratingLo, setRatingLo] = useState(settings.puzzleRatingMin)
    const [ratingHi, setRatingHi] = useState(settings.puzzleRatingMax)
    const [activePuzzle, setActivePuzzle] = useState<Puzzle | null>(null)
    const [puzzleKey, setPuzzleKey] = useState(0)
    const [loading, setLoading] = useState(false)
    const [ready, setReady] = useState(false)
    const [hintTrigger, setHintTrigger] = useState(0)
    const [playSolutionTrigger, setPlaySolutionTrigger] = useState(0)
    const [solutionPlaying, setSolutionPlaying] = useState(false)

    const fetchGenerationRef = useRef(0)
    const filtersRef = useRef({ ratingLo, ratingHi, selectedThemes })
    filtersRef.current = { ratingLo, ratingHi, selectedThemes }

    const fetchNextPuzzle = useCallback(async () => {
        const api = window.graymatter?.fetchNextPuzzle
        if (!api) {
            setLoadError('GrayMatter puzzle API is unavailable. Run this app in Electron.')
            return
        }

        const generation = ++fetchGenerationRef.current
        const { ratingLo: lo, ratingHi: hi, selectedThemes: themes } = filtersRef.current

        setLoading(true)
        setLoadError(null)

        try {
            const result = await api({
                minRating: lo,
                maxRating: hi,
                themes: [...themes],
            })

            if (generation !== fetchGenerationRef.current) return

            if (!result.puzzle) {
                setActivePuzzle(null)
                setLoadError(
                    'No puzzles in the database match the current filters. '
                    + 'Try widening the rating range or changing themes.',
                )
                return
            }

            setActivePuzzle(result.puzzle)
            setPuzzleKey((key) => key + 1)
        }
        catch (err) {
            if (generation !== fetchGenerationRef.current) return
            const message = err instanceof Error ? err.message : String(err)
            setLoadError(`Could not read lichess_db_puzzles.csv: ${message}`)
            setActivePuzzle(null)
        }
        finally {
            if (generation === fetchGenerationRef.current) setLoading(false)
        }
    }, [])

    useEffect(() => {
        if (!window.graymatter) return
        setReady(true)
        void fetchNextPuzzle()
    }, [fetchNextPuzzle])

    const toggleTheme = (themeId: PuzzleThemeId) => {
        const next = selectedThemes.has(themeId)
            ? settings.puzzleThemes.filter((id) => id !== themeId)
            : [...settings.puzzleThemes, themeId]
        onSettingsChange({ puzzleThemes: next })
    }

    const onRatingChange = (lo: number, hi: number) => {
        setRatingLo(lo)
        setRatingHi(hi)
    }

    const onRatingCommit = (lo: number, hi: number) => {
        if (lo !== settings.puzzleRatingMin || hi !== settings.puzzleRatingMax) {
            onSettingsChange({ puzzleRatingMin: lo, puzzleRatingMax: hi })
        }
    }

    const handleNextPuzzle = () => {
        if (!activePuzzle) {
            void fetchNextPuzzle()
            return
        }
        setSolutionPlaying(true)
        setPlaySolutionTrigger((trigger) => trigger + 1)
    }

    const handlePlaySolutionComplete = (success: boolean) => {
        setSolutionPlaying(false)
        if (success) void fetchNextPuzzle()
    }

    return (
        <div className="mx-auto flex max-w-5xl flex-col gap-8 px-4 py-10 md:flex-row md:items-start">
            <section className="flex-1 space-y-5">
                <header>
                    <p className="mt-2 text-sm leading-relaxed text-slate-400">
                        Choose themes and a rating range, then solve puzzles from your Lichess
                        database. The computer plays the setup move; you find the winning
                        continuation. Progress is saved in PuzzleStatus.json.
                    </p>
                </header>

                <div className="space-y-3 rounded-xl border border-slate-700/80 bg-slate-900/50 p-4">
                    <fieldset className="space-y-2">
                        <legend className="text-sm font-medium text-slate-200">Themes</legend>
                        <div className="space-y-2 pl-4">
                            <div className="flex flex-wrap gap-4">
                                {PUZZLE_THEME_OPTIONS.map(({ id, label }) => (
                                    <label
                                        key={id}
                                        className="flex cursor-pointer items-center gap-2 text-sm text-slate-200"
                                    >
                                        <input
                                            type="checkbox"
                                            checked={selectedThemes.has(id)}
                                            onChange={() => toggleTheme(id)}
                                            className="accent-amber-500"
                                        />
                                        {label}
                                    </label>
                                ))}
                            </div>
                            <p className="text-xs text-slate-500">
                                Leave all unchecked to include any theme.
                            </p>
                        </div>
                    </fieldset>
                    <div className="space-y-1 border-t border-slate-700/60 pt-3">
                        <div className="flex items-center justify-between">
                            <span className="text-sm font-medium text-slate-200">Rating range</span>
                            <span className="rounded-md bg-amber-500/15 px-2 py-0.5 font-mono text-sm text-amber-200">
                                {Math.min(ratingLo, ratingHi)}-{Math.max(ratingLo, ratingHi)}
                            </span>
                        </div>
                        <div className="pl-4">
                            <DualRatingSlider
                                minRating={ratingLo}
                                maxRating={ratingHi}
                                onChange={onRatingChange}
                                onCommit={onRatingCommit}
                            />
                            <p className="mt-1 text-xs text-slate-500">
                                Only puzzles rated within this range are served.
                            </p>
                        </div>
                    </div>
                </div>

                <div className="flex flex-wrap gap-2">
                    <button
                        type="button"
                        onClick={() => setHintTrigger((trigger) => trigger + 1)}
                        disabled={loading || !ready || !activePuzzle || solutionPlaying}
                        className="rounded-lg border border-slate-600 px-3 py-1.5 text-sm text-slate-200 transition enabled:hover:border-emerald-500/60 enabled:hover:text-emerald-100 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                        Hint
                    </button>
                    <button
                        type="button"
                        onClick={handleNextPuzzle}
                        disabled={loading || !ready || solutionPlaying}
                        className="rounded-lg border border-slate-600 px-3 py-1.5 text-sm text-slate-200 transition enabled:hover:border-amber-500/60 enabled:hover:text-amber-100 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                        Next puzzle
                    </button>
                </div>

                {loadError && (
                    <p className="rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-200">
                        {loadError}
                    </p>
                )}
            </section>

            <div className="w-full max-w-[min(100%,28rem)] shrink-0 space-y-2 self-center md:self-start">
                <div className="board-panel">
                    {activePuzzle && !loading ? (
                        <PuzzleChessboard
                            key={puzzleKey}
                            puzzle={activePuzzle}
                            hintTrigger={hintTrigger}
                            playSolutionTrigger={playSolutionTrigger}
                            onPlaySolutionComplete={handlePlaySolutionComplete}
                            onSolved={() => void fetchNextPuzzle()}
                        />
                    ) : (
                        <div className="flex aspect-square items-center justify-center rounded-xl bg-slate-900/60 text-sm text-slate-500">
                            {loading ? 'Loading next puzzle…' : 'Press Next puzzle to start.'}
                        </div>
                    )}
                </div>
                {activePuzzle && !loading && (
                    <p className="font-mono text-xs text-slate-500">
                        puzzle #{activePuzzle.id} · rating {activePuzzle.rating} ·{' '}
                        {activePuzzle.nbPlays.toLocaleString()} plays
                    </p>
                )}
            </div>
        </div>
    )
}
