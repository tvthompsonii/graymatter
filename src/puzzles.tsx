import { Chess } from 'chess.js'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Chessboard } from 'react-chessboard'

import { boardChrome, customPieces } from './boardTheme'
import type { PuzzleCursor } from './graymatter'
import { PuzzleChessboard } from './puzzleBoard'
import {
    PUZZLE_THEME_OPTIONS,
    type Puzzle,
    type PuzzleThemeId,
} from './puzzleCsv'
import {
    SURVIVAL_BUCKET_RADIUS,
    SURVIVAL_BUCKETS,
    SURVIVAL_MAX_MISSES,
    SURVIVAL_MISS_HOLD_MS,
} from './puzzleSurvival'
import {
    PUZZLE_RATING_MAX as RATING_MAX,
    PUZZLE_RATING_MIN as RATING_MIN,
    type AppSettings,
    type PuzzleMode,
} from './settings'

type SurvivalPhase = 'idle' | 'collecting' | 'playing' | 'over'

const START_FEN = new Chess().fen()

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

    const puzzleMode = settings.puzzleMode
    const [survivalPhase, setSurvivalPhase] = useState<SurvivalPhase>('idle')
    const [survivalQueue, setSurvivalQueue] = useState<Puzzle[]>([])
    const [survivalIndex, setSurvivalIndex] = useState(0)
    const [survivalScore, setSurvivalScore] = useState(0)
    // Puzzles missed this run, in order; after the run each one can be reopened for review.
    const [survivalMissed, setSurvivalMissed] = useState<Puzzle[]>([])
    const survivalMisses = survivalMissed.length
    // Index into survivalMissed of the puzzle being reviewed after the run, if any.
    const [reviewIndex, setReviewIndex] = useState<number | null>(null)
    // Bumped to cancel a run's pending fetch and miss timer (Restart, mode switch, unmount).
    const survivalRunRef = useRef(0)
    const survivalState = {
        queue: survivalQueue,
        index: survivalIndex,
        score: survivalScore,
        missed: survivalMissed,
    }
    const survivalRef = useRef(survivalState)
    survivalRef.current = survivalState

    const fetchGenerationRef = useRef(0)
    // Where the cursor goes once the current Practice puzzle is solved or skipped.
    const practiceCursorRef = useRef<PuzzleCursor | null>(null)
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

            practiceCursorRef.current = result.nextByteOffset === undefined
                ? null
                : { nextByteOffset: result.nextByteOffset, lastPuzzleId: result.puzzle.id }
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

    /**
     * Move the saved cursor past the current Practice puzzle (solved or skipped), then load the
     * next one. Fetching alone never moves the cursor, so an unfinished puzzle comes back.
     */
    const advanceAndFetchNextPuzzle = useCallback(async () => {
        const cursor = practiceCursorRef.current
        const generation = fetchGenerationRef.current
        practiceCursorRef.current = null
        if (cursor) {
            try {
                await window.graymatter.advancePuzzleCursor(cursor)
            }
            catch (err) {
                const message = err instanceof Error ? err.message : String(err)
                setLoadError(`Could not save PuzzleStatus.json: ${message}`)
            }
        }
        // A mode switch while saving owns the board now.
        if (generation !== fetchGenerationRef.current) return
        await fetchNextPuzzle()
    }, [fetchNextPuzzle])

    const initialModeRef = useRef(puzzleMode)
    useEffect(() => {
        if (!window.graymatter) return
        setReady(true)
        if (initialModeRef.current === 'practice') void fetchNextPuzzle()
    }, [fetchNextPuzzle])

    useEffect(() => () => {
        survivalRunRef.current++
    }, [])

    const showPuzzle = (puzzle: Puzzle) => {
        setActivePuzzle(puzzle)
        setPuzzleKey((key) => key + 1)
    }

    const startSurvivalRun = async () => {
        const api = window.graymatter?.fetchSurvivalSet
        if (!api) {
            setLoadError('GrayMatter puzzle API is unavailable. Run this app in Electron.')
            return
        }

        const run = ++survivalRunRef.current
        setActivePuzzle(null)
        setLoadError(null)
        setSurvivalQueue([])
        setSurvivalIndex(0)
        setSurvivalScore(0)
        setSurvivalMissed([])
        setReviewIndex(null)
        setSurvivalPhase('collecting')

        try {
            const { puzzles } = await api({
                buckets: [...SURVIVAL_BUCKETS],
                radius: SURVIVAL_BUCKET_RADIUS,
                themes: [...selectedThemes],
            })
            if (run !== survivalRunRef.current) return

            if (!puzzles.length) {
                setSurvivalPhase('idle')
                setLoadError(
                    'No puzzles in the database match the current themes. '
                    + 'Try changing the theme selection.',
                )
                return
            }

            setSurvivalQueue(puzzles)
            setSurvivalPhase('playing')
            showPuzzle(puzzles[0]!)
        }
        catch (err) {
            if (run !== survivalRunRef.current) return
            const message = err instanceof Error ? err.message : String(err)
            setLoadError(`Could not read lichess_db_puzzles.csv: ${message}`)
            setSurvivalPhase('idle')
        }
    }

    const advanceSurvival = () => {
        const { queue, index } = survivalRef.current
        const next = index + 1
        if (next >= queue.length) {
            setActivePuzzle(null)
            setSurvivalPhase('over')
            return
        }
        setSurvivalIndex(next)
        showPuzzle(queue[next]!)
    }

    const handleSurvivalSolved = () => {
        const score = survivalRef.current.score + 1
        setSurvivalScore(score)
        // Saved as soon as it's beaten, so an abandoned run still keeps its best.
        if (score > settings.puzzleSurvivalBest) onSettingsChange({ puzzleSurvivalBest: score })
        advanceSurvival()
    }

    const handleSurvivalMiss = () => {
        const run = survivalRunRef.current
        const { queue, index, missed } = survivalRef.current
        const nextMissed = [...missed, queue[index]!]
        setSurvivalMissed(nextMissed)
        // The board holds the wrong move (outlined in red) until the next puzzle replaces it.
        window.setTimeout(() => {
            if (run !== survivalRunRef.current) return
            if (nextMissed.length >= SURVIVAL_MAX_MISSES) {
                setActivePuzzle(null)
                setSurvivalPhase('over')
                return
            }
            advanceSurvival()
        }, SURVIVAL_MISS_HOLD_MS)
    }

    const reviewMissedPuzzle = (index: number) => {
        const puzzle = survivalMissed[index]
        if (!puzzle) return
        setReviewIndex(index)
        showPuzzle(puzzle)
    }

    /** Back to the start-position board once a reviewed puzzle is solved. */
    const handleReviewSolved = () => {
        setReviewIndex(null)
        setActivePuzzle(null)
    }

    const changePuzzleMode = (mode: PuzzleMode) => {
        if (mode === puzzleMode) return
        // Abandon whatever the other mode had in flight.
        survivalRunRef.current++
        fetchGenerationRef.current++
        setLoading(false)
        setLoadError(null)
        setSolutionPlaying(false)
        setActivePuzzle(null)
        setSurvivalPhase('idle')
        setReviewIndex(null)
        onSettingsChange({ puzzleMode: mode })
        if (mode === 'practice') void fetchNextPuzzle()
    }

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
        if (success) void advanceAndFetchNextPuzzle()
    }

    const survival = puzzleMode === 'survival'
    const survivalRunning = survival && (survivalPhase === 'collecting' || survivalPhase === 'playing')
    const survivalOver = survival && survivalPhase === 'over'
    const reviewing = survivalOver && reviewIndex !== null

    const placeholder = loading ? 'Loading next puzzle…' : 'Press Next puzzle to start.'

    // Before a run the prompt lives in the description; the board shows the start position.
    let survivalPrompt = ''
    if (survivalPhase === 'idle') survivalPrompt = ' Press Start run to begin.'
    else if (survivalPhase === 'collecting') survivalPrompt = ' Finding puzzles…'

    let survivalResult: string | null = null
    if (survivalOver) {
        survivalResult = survivalMisses >= SURVIVAL_MAX_MISSES
            ? `Game over: score ${survivalScore} (best ${settings.puzzleSurvivalBest}).`
            : `You cleared all ${survivalQueue.length} puzzles! Score ${survivalScore} `
                + `(best ${settings.puzzleSurvivalBest}).`
        if (survivalMisses > 0) survivalResult += ' Click a ✕ to review a missed puzzle.'
    }

    return (
        <div className="mx-auto flex max-w-5xl flex-col gap-8 px-4 py-10 md:flex-row md:items-start">
            <section className="flex-1 space-y-5">
                <header>
                    <p className="mt-2 text-sm leading-relaxed text-slate-400">
                        {survival
                            ? 'Solve puzzles of rising difficulty from your Lichess database. '
                                + `Any wrong move is a miss; ${SURVIVAL_MAX_MISSES} misses end the run.`
                                + survivalPrompt
                            : 'Choose themes and a rating range, then solve puzzles from the Lichess '
                                + 'database. The computer plays the setup move; you find the winning '
                                + 'continuation.'}
                    </p>
                </header>

                <div className="space-y-3 rounded-xl border border-slate-700/80 bg-slate-900/50 p-4">
                    <fieldset className="space-y-2">
                        <legend className="text-sm font-medium text-slate-200">Mode</legend>
                        <div className="flex flex-wrap gap-4 pl-4">
                            {([['practice', 'Practice'], ['survival', 'Survival']] as const).map(([mode, label]) => (
                                <label
                                    key={mode}
                                    className="flex cursor-pointer items-center gap-2 text-sm text-slate-200"
                                >
                                    <input
                                        type="radio"
                                        name="puzzle-mode"
                                        checked={puzzleMode === mode}
                                        onChange={() => changePuzzleMode(mode)}
                                        className="accent-amber-500"
                                    />
                                    {label}
                                </label>
                            ))}
                        </div>
                    </fieldset>
                    <fieldset
                        disabled={survivalRunning}
                        className="space-y-2 border-t border-slate-700/60 pt-3 disabled:opacity-50"
                    >
                        <div className="text-sm font-medium text-slate-200">Themes</div>
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
                    {survival ? (
                        <div className="space-y-2 border-t border-slate-700/60 pt-3">
                            <div className="flex items-center justify-between">
                                <span className="text-sm font-medium text-slate-200">Score</span>
                                <span className="rounded-md bg-amber-500/15 px-2 py-0.5 font-mono text-sm text-amber-200">
                                    {survivalScore}
                                </span>
                            </div>
                            <div className="space-y-1 pl-4 text-sm text-slate-300">
                                <div className="flex items-center justify-between">
                                    <span>Misses</span>
                                    <span
                                        className="flex gap-1.5"
                                        aria-label={`${survivalMisses} of ${SURVIVAL_MAX_MISSES} misses`}
                                    >
                                        {Array.from({ length: SURVIVAL_MAX_MISSES }, (_, i) => {
                                            const missedPuzzle = survivalMissed[i]
                                            const color = missedPuzzle ? 'text-red-400' : 'text-slate-600'
                                            if (!survivalOver || !missedPuzzle) {
                                                return <span key={i} className={color}>✕</span>
                                            }
                                            return (
                                                <button
                                                    key={i}
                                                    type="button"
                                                    onClick={() => reviewMissedPuzzle(i)}
                                                    title={`Review missed puzzle #${missedPuzzle.id} (rating ${missedPuzzle.rating})`}
                                                    className={`rounded px-1 transition hover:bg-red-500/20 hover:text-red-200 ${color} ${
                                                        reviewIndex === i ? 'ring-1 ring-red-400' : ''
                                                    }`}
                                                >
                                                    ✕
                                                </button>
                                            )
                                        })}
                                    </span>
                                </div>
                                <div className="flex items-center justify-between">
                                    <span>Best</span>
                                    <span className="font-mono">{settings.puzzleSurvivalBest}</span>
                                </div>
                                {survivalQueue.length > 0 && (
                                    <div className="flex items-center justify-between">
                                        <span>Puzzle</span>
                                        <span className="font-mono">
                                            {survivalIndex + 1} / {survivalQueue.length}
                                        </span>
                                    </div>
                                )}
                            </div>
                        </div>
                    ) : (
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
                    )}
                </div>

                <div className="flex flex-wrap gap-2">
                    {survival ? (
                        <button
                            type="button"
                            onClick={() => void startSurvivalRun()}
                            disabled={!ready || survivalPhase === 'collecting'}
                            className="rounded-lg border border-slate-600 px-3 py-1.5 text-sm text-slate-200 transition enabled:hover:border-amber-500/60 enabled:hover:text-amber-100 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                            {survivalPhase === 'playing' ? 'Restart' : 'Start run'}
                        </button>
                    ) : (
                        <>
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
                        </>
                    )}
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
                            hintTrigger={survival ? 0 : hintTrigger}
                            playSolutionTrigger={survival ? 0 : playSolutionTrigger}
                            onPlaySolutionComplete={handlePlaySolutionComplete}
                            onSolved={reviewing
                                ? handleReviewSolved
                                : survival ? handleSurvivalSolved : () => void advanceAndFetchNextPuzzle()}
                            onMiss={survival && !reviewing ? handleSurvivalMiss : undefined}
                        />
                    ) : survival ? (
                        <Chessboard
                            options={{
                                id: 'PuzzlesBoardIdle',
                                position: START_FEN,
                                pieces: customPieces,
                                allowDragging: false,
                                ...boardChrome,
                            }}
                        />
                    ) : (
                        <div className="flex aspect-square items-center justify-center rounded-xl bg-slate-900/60 px-6 text-center text-sm text-slate-500">
                            {placeholder}
                        </div>
                    )}
                </div>
                {activePuzzle && !loading && (
                    <p className="font-mono text-xs text-slate-500">
                        {reviewing && 'review · '}
                        puzzle #{activePuzzle.id} · rating {activePuzzle.rating} ·{' '}
                        {activePuzzle.nbPlays.toLocaleString()} plays
                    </p>
                )}
                {survivalResult && !activePuzzle && (
                    <p className="text-sm text-slate-300">{survivalResult}</p>
                )}
            </div>
        </div>
    )
}
