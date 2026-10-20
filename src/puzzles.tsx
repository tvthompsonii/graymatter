import { Chess } from 'chess.js'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Chessboard } from 'react-chessboard'

import { boardChrome, customPieces } from './boardTheme'
import type { PuzzleCursor } from './graymatter'
import { playerColorForPuzzle, PuzzleChessboard } from './puzzleBoard'
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
import { Button, Chip, DualRangeSlider, SegmentedControl, ValueBadge } from './ui/controls'
import {
    ExternalLinkIcon,
    LightbulbIcon,
    LockIcon,
    PlayIcon,
    ResetIcon,
    SkipIcon,
    XIcon,
} from './ui/icons'
import {
    BoardPage,
    Card,
    ErrorNote,
    PanelHeader,
    ProgressBar,
    Section,
    SideMarker,
    StatusBanner,
    StrikeMarker,
} from './ui/layout'

type SurvivalPhase = 'idle' | 'collecting' | 'playing' | 'over'

const START_FEN = new Chess().fen()

const PUZZLE_MODE_OPTIONS = [
    { value: 'practice', label: 'Practice' },
    { value: 'survival', label: 'Survival' },
] as const satisfies ReadonlyArray<{ value: PuzzleMode; label: string }>

/** Lichess theme ids are camelCase ("discoveredAttack"); show them as "Discovered attack". */
function themeLabel(theme: string): string {
    const words = theme.replace(/([a-z])([A-Z0-9])/g, '$1 $2').toLowerCase()
    return words.charAt(0).toUpperCase() + words.slice(1)
}

/** Status line for the side to move in a loaded puzzle. */
function toMoveBanner(puzzle: Puzzle): ReactNode {
    const side = playerColorForPuzzle(puzzle)
    return (
        <StatusBanner
            title={side === 'w' ? 'White to move' : 'Black to move'}
            text="Find the best continuation"
            marker={<SideMarker side={side} />}
        />
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
    // True while a missed puzzle's wrong move is held on the board, before the next one loads.
    const [justMissed, setJustMissed] = useState(false)
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
        setJustMissed(false)
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
        setJustMissed(false)
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
        setJustMissed(true)
        // The board holds the wrong move (outlined in red) until the next puzzle replaces it.
        window.setTimeout(() => {
            if (run !== survivalRunRef.current) return
            if (nextMissed.length >= SURVIVAL_MAX_MISSES) {
                setJustMissed(false)
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
        setJustMissed(false)
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

    const board = activePuzzle && !loading
        ? (
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
        )
        : survival
            ? (
                <Chessboard
                    options={{
                        id: 'PuzzlesBoardIdle',
                        position: START_FEN,
                        pieces: customPieces,
                        allowDragging: false,
                        ...boardChrome,
                    }}
                />
            )
            : (
                <div className="flex aspect-square items-center justify-center bg-panel px-6 text-center text-sm text-dim">
                    {loading ? 'Loading next puzzle…' : 'Press Next puzzle to start.'}
                </div>
            )

    const themeChips = (
        <div className="flex flex-wrap gap-1.5">
            {PUZZLE_THEME_OPTIONS.map(({ id, label }) => (
                <Chip
                    key={id}
                    pressed={selectedThemes.has(id)}
                    onToggle={() => toggleTheme(id)}
                    disabled={survivalRunning}
                >
                    {label}
                </Chip>
            ))}
        </div>
    )

    return (
        <BoardPage label={survival ? 'Survival controls' : 'Puzzle controls'} board={<div className="board-panel">{board}</div>}>
            <PanelHeader
                title="Puzzles"
                subtitle={survival
                    ? 'Rising difficulty. Three misses ends the run.'
                    : 'Positions from your Lichess puzzle file.'}
                info={survival
                    ? 'Each run collects puzzles from about 800 to 1900 and plays them in rating order. '
                        + 'Any wrong move is a miss. After a run, click a missed puzzle to review it.'
                    : 'The computer plays the setup move; you find the winning continuation. Next puzzle '
                        + 'plays out the solution first. Progress is saved in PuzzleStatus.json.'}
            />

            <SegmentedControl
                label="Puzzle mode"
                options={PUZZLE_MODE_OPTIONS}
                value={puzzleMode}
                onChange={changePuzzleMode}
            />

            {survival
                ? (
                    <SurvivalPanel
                        phase={survivalPhase}
                        activePuzzle={activePuzzle}
                        justMissed={justMissed}
                        reviewIndex={reviewIndex}
                        score={survivalScore}
                        best={settings.puzzleSurvivalBest}
                        missed={survivalMissed}
                        queue={survivalQueue}
                        index={survivalIndex}
                        themeChips={themeChips}
                        onReview={reviewMissedPuzzle}
                    />
                )
                : (
                    <>
                        {loading
                            ? <StatusBanner tone="info" title="Loading next puzzle…" />
                            : solutionPlaying
                                ? <StatusBanner tone="info" title="Playing the solution" />
                                : activePuzzle
                                    ? toMoveBanner(activePuzzle)
                                    : <StatusBanner tone="info" title="No puzzle loaded" />}

                        <Section label="Themes">
                            {themeChips}
                            <span className="text-xs text-faint">None selected = any theme.</span>
                        </Section>

                        <Section
                            label="Rating"
                            aside={<ValueBadge>{Math.min(ratingLo, ratingHi)}–{Math.max(ratingLo, ratingHi)}</ValueBadge>}
                        >
                            <DualRangeSlider
                                min={RATING_MIN}
                                max={RATING_MAX}
                                step={50}
                                low={ratingLo}
                                high={ratingHi}
                                onDraft={onRatingChange}
                                onCommit={onRatingCommit}
                                labels={['Minimum puzzle rating', 'Maximum puzzle rating']}
                            />
                        </Section>

                        {activePuzzle && !loading && <PuzzleCard puzzle={activePuzzle} />}
                    </>
                )}

            {loadError && <ErrorNote>{loadError}</ErrorNote>}

            <div className="mt-auto flex gap-2">
                {survival
                    ? survivalPhase === 'playing'
                        ? (
                            <Button className="flex-1" icon={<ResetIcon />} onClick={() => void startSurvivalRun()}>
                                Restart run
                            </Button>
                        )
                        : (
                            <Button
                                variant="primary"
                                className="flex-1"
                                icon={<PlayIcon size={15} />}
                                onClick={() => void startSurvivalRun()}
                                disabled={!ready || survivalPhase === 'collecting'}
                            >
                                {survivalPhase === 'collecting' ? 'Finding puzzles…' : 'Start run'}
                            </Button>
                        )
                    : (
                        <>
                            <Button
                                className="flex-1"
                                icon={<LightbulbIcon className="text-success" />}
                                onClick={() => setHintTrigger((trigger) => trigger + 1)}
                                disabled={loading || !ready || !activePuzzle || solutionPlaying}
                            >
                                Hint
                            </Button>
                            <Button
                                variant="primary"
                                className="flex-[1.4]"
                                trailingIcon={<SkipIcon strokeWidth={2.2} />}
                                onClick={handleNextPuzzle}
                                disabled={loading || !ready || solutionPlaying}
                            >
                                Next puzzle
                            </Button>
                        </>
                    )}
            </div>
        </BoardPage>
    )
}

function PuzzleCard({ puzzle, label = 'Puzzle rating' }: { puzzle: Puzzle; label?: string }) {
    const themes = puzzle.themes.slice(0, 2).map(themeLabel)
    return (
        <Card className="gap-2">
            <div className="flex items-baseline justify-between">
                <span className="text-[13px] text-soft">{label}</span>
                <span className="font-mono text-xl font-semibold text-ink">{puzzle.rating}</span>
            </div>
            <div className="flex items-center justify-between gap-2 text-xs text-muted">
                <span className="truncate">
                    {[...themes, `${puzzle.nbPlays.toLocaleString()} plays`].join(' · ')}
                </span>
                <a
                    href={`https://lichess.org/training/${puzzle.id}`}
                    target="_blank"
                    rel="noreferrer"
                    title="Open on Lichess"
                    className="inline-flex shrink-0 items-center gap-1 font-mono text-accent-ink hover:text-amber-200"
                >
                    #{puzzle.id}
                    <ExternalLinkIcon size={12} />
                </a>
            </div>
        </Card>
    )
}

type SurvivalPanelProps = {
    phase: SurvivalPhase
    activePuzzle: Puzzle | null
    justMissed: boolean
    reviewIndex: number | null
    score: number
    best: number
    missed: Puzzle[]
    queue: Puzzle[]
    index: number
    themeChips: ReactNode
    onReview: (index: number) => void
}

function SurvivalPanel({
    phase,
    activePuzzle,
    justMissed,
    reviewIndex,
    score,
    best,
    missed,
    queue,
    index,
    themeChips,
    onReview,
}: SurvivalPanelProps) {
    const running = phase === 'collecting' || phase === 'playing'
    const reviewing = phase === 'over' && reviewIndex !== null && !!activePuzzle

    let banner: ReactNode
    if (phase === 'collecting') banner = <StatusBanner tone="info" title="Finding puzzles…" text="Collecting this run's set" />
    else if (justMissed) banner = <StatusBanner tone="error" title="Wrong move" text="Next puzzle in a moment" />
    else if (reviewing) banner = <StatusBanner tone="error" title="Review" text="Retry this miss, it will not change your score" />
    else if (phase === 'playing' && activePuzzle) banner = toMoveBanner(activePuzzle)
    else if (phase === 'over') {
        banner = missed.length
            ? <StatusBanner tone="info" title="Run over" text="Review your misses or start a new run" />
            : <StatusBanner tone="success" title="Run cleared" text={`You solved all ${queue.length} puzzles`} />
    }
    else banner = <StatusBanner tone="info" title="Ready" text="Press Start run to begin" />

    return (
        <>
            {banner}

            {phase === 'over'
                ? (
                    <Card className="gap-3.5 p-4">
                        <div className="flex items-end justify-between">
                            <div className="flex flex-col gap-0.5">
                                <span className="text-xs text-muted">Game over · final score</span>
                                <span className="font-mono text-[44px] font-semibold leading-none text-ink">{score}</span>
                            </div>
                            <div className="text-right text-xs leading-relaxed text-muted">
                                <div>Best <span className="font-mono text-accent-ink">{best}</span></div>
                                {queue[index] && (
                                    <div>Reached <span className="font-mono text-body">{queue[index].rating}</span></div>
                                )}
                            </div>
                        </div>
                        {missed.length > 0 && (
                            <div className="flex flex-col gap-2">
                                <span className="text-xs text-muted">Missed puzzles · click to review</span>
                                <div className="grid grid-cols-3 gap-2">
                                    {missed.map((puzzle, i) => (
                                        <button
                                            key={puzzle.id}
                                            type="button"
                                            onClick={() => onReview(i)}
                                            aria-pressed={reviewIndex === i}
                                            aria-label={`Review missed puzzle rated ${puzzle.rating}`}
                                            title={`#${puzzle.id}`}
                                            className={`flex flex-col items-center gap-1 rounded-[10px] border px-1 py-2.5 transition ${
                                                reviewIndex === i
                                                    ? 'border-danger bg-danger/10'
                                                    : 'border-line-strong bg-panel hover:border-danger/60'
                                            }`}
                                        >
                                            <span className="flex h-[30px] w-[30px] items-center justify-center rounded-full border border-danger bg-danger/20 text-danger">
                                                <XIcon size={14} strokeWidth={3} />
                                            </span>
                                            <span className="font-mono text-[13px] font-semibold text-ink">{puzzle.rating}</span>
                                            <span className="text-[11px] text-muted">{themeLabel(puzzle.themes[0] ?? 'puzzle')}</span>
                                        </button>
                                    ))}
                                </div>
                            </div>
                        )}
                    </Card>
                )
                : (
                    <Card row className="items-stretch p-4">
                        <div className="flex flex-1 flex-col gap-0.5">
                            <span className="text-xs text-muted">Score</span>
                            <span className="font-mono text-[44px] font-semibold leading-none text-ink">{score}</span>
                            <span className="text-xs text-muted">
                                Best <span className="font-mono text-accent-ink">{best}</span>
                            </span>
                        </div>
                        <div className="flex flex-col items-end justify-between">
                            <span className="text-xs text-muted">Misses</span>
                            <div className="flex gap-1.5" aria-label={`${missed.length} of ${SURVIVAL_MAX_MISSES} misses`}>
                                {Array.from({ length: SURVIVAL_MAX_MISSES }, (_, i) => (
                                    <StrikeMarker key={i} missed={i < missed.length} />
                                ))}
                            </div>
                        </div>
                    </Card>
                )}

            {phase === 'playing' && queue.length > 0 && (
                <div className="flex flex-col gap-2">
                    <div className="flex justify-between text-xs text-muted">
                        <span>Puzzle <span className="font-mono text-body">{index + 1} / {queue.length}</span></span>
                        {queue[index] && <span>Rated <span className="font-mono text-body">{queue[index].rating}</span></span>}
                    </div>
                    <ProgressBar label="Run progress" value={index + 1} max={queue.length} />
                </div>
            )}

            <Section
                label={running
                    ? <>Themes <LockIcon size={12} /> <span className="font-normal normal-case tracking-normal">locked during a run</span></>
                    : phase === 'over' ? 'Themes for the next run' : 'Themes'}
                className={running ? 'opacity-55' : ''}
            >
                {themeChips}
            </Section>

            {reviewing && activePuzzle && <PuzzleCard puzzle={activePuzzle} label="Reviewing" />}
        </>
    )
}
