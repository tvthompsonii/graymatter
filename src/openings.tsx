import type { Square } from 'chess.js'
import { Chess, type Move } from 'chess.js'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Chessboard } from 'react-chessboard'
import type {
    Arrow,
    PieceDropHandlerArgs,
    PieceHandlerArgs,
    SquareHandlerArgs,
} from 'react-chessboard'

import {
    boardChrome,
    CORRECT_MOVE_DISPLAY_MS,
    customPieces,
    HINT_SQUARE_STYLE,
    MOVE_ANIMATION_MS,
    SELECTED_SQUARE_STYLE,
    SOLUTION_ARROW_COLOR,
    withSquareOutlines,
    WRONG_MOVE_DISPLAY_MS,
    WRONG_SQUARE_STYLE,
} from './boardTheme'
import type { GraymatterPaths } from './graymatter'
import { fenSig, formatLine, logRepertoireTreeDfs, normalizeSan } from './moveTree'
import { ExploreView } from './openingExplorer'
import { parsePgnToRepertoire, type ParsedRepertoire } from './pgnPaths'
import { buildCardDeck, pickSetupPath, type Card, type CardDeck } from './repertoireCards'
import { NEW_CARDS_PER_DAY_MAX, NEW_CARDS_PER_DAY_MIN, type AppSettings, type TrainMode } from './settings'
import {
    deckStats,
    formatWait,
    CHAIN_MAX_NEW,
    gradeCard,
    missPracticeCard,
    pickChainPath,
    pickNextCard,
    type ChainPick,
    type PickOptions,
    type Schedule,
} from './srs'
import { mergeSchedules, parseTrainingFileJson, serializeTrainingFile } from './trainingExport'
import { Button, RangeSlider, SegmentedControl, ValueBadge } from './ui/controls'
import { LightbulbIcon, ResetIcon } from './ui/icons'
import {
    BoardPage,
    Card as PanelCard,
    ErrorNote,
    PanelHeader,
    ProgressBar,
    Section,
    SideMarker,
    StatTile,
    StatusBanner,
} from './ui/layout'

export type Side = 'w' | 'b'

export type CardChessboardProps = {
    /** The active side's deck; null while loading. */
    deck: CardDeck | null
    playerSide: Side
    /** Card to set up when `lessonKey` changes; null shows the start position, locked. */
    card: Card | null
    /** Moves from the start that reach `card`'s position. */
    setupPath: readonly string[] | null
    /** Bump to jump to `card`. */
    lessonKey: number
    /** Bump to outline the square of the piece the trainee should move (grades the card a fail). */
    hintTrigger: number
    /** SAN moves played so far; owned by the page for the status line. */
    historySansRef: { current: string[] }
    /** Called with a copy of historySansRef whenever the position changes. */
    onHistoryChange?: (sans: string[]) => void
    /** The card now waiting for the trainee (after a jump or a chained reply); `practice` when it isn't graded. */
    onCardShown: (card: Card, practice: boolean) => void
    /** True for a card never reviewed: its first showing draws the answer as an arrow. */
    isNewCard: (card: Card) => boolean
    /** Called once per showing: on the first wrong move or hint (fail), or the correct move (pass). */
    onCardAnswered: (card: Card, pass: boolean, practice: boolean) => void
    /** The trainee played a different book move for this position; taken back with no penalty. */
    onAlternateBookMove: () => void
    /** Opponent replies from this position (after the trainee's correct answer to `answeredId`) to the chain's next card. */
    pickChain: (positionKey: string, answeredId: string) => ChainPick | null
    /** The chain ended (no continuation leads to a card to test); the page jumps to the next card. */
    onChainEnd: () => void
}

function wait(ms: number): Promise<void> {
    return new Promise((resolve) => window.setTimeout(resolve, ms))
}

/** FEN after playing from→to (trying promotions), or null when the move is illegal. */
function fenAfterAttempt(game: Chess, from: Square, to: Square): string | null {
    const piece = game.get(from)
    const tries: Array<'q' | 'r' | 'b' | 'n' | undefined> =
        piece?.type === 'p'
        && ((piece.color === 'w' && to[1] === '8')
            || (piece.color === 'b' && to[1] === '1'))
            ? ['q', 'r', 'b', 'n']
            : [undefined]

    for (const promotion of tries) {
        const trial = new Chess(game.fen())
        try {
            const move = trial.move(
                promotion ? { from, to, promotion } : { from, to },
                { strict: false },
            )
            if (move) return trial.fen()
        }
        catch {
            // Try the next promotion choice.
        }
    }
    return null
}

function findMatchingOutcome(
    game: Chess,
    from: Square,
    to: Square,
    allowedSans: readonly string[],
): { promotion?: 'q' | 'r' | 'b' | 'n' } | null {
    const allowed = new Set(allowedSans.map(normalizeSan))
    const piece = game.get(from)
    const promotions: Array<'q' | 'r' | 'b' | 'n' | undefined> =
        piece?.type === 'p'
        && ((piece.color === 'w' && to[1] === '8')
            || (piece.color === 'b' && to[1] === '1'))
            ? ['q', 'r', 'b', 'n']
            : [undefined]

    for (const promotion of promotions) {
        const trial = new Chess(game.fen())
        try {
            const move = trial.move(
                promotion ? { from, to, promotion } : { from, to },
                { strict: false },
            )
            if (move && allowed.has(normalizeSan(move.san)))
                return promotion ? { promotion } : {}
        }
        catch {
            // Continue through promotion choices.
        }
    }
    return null
}

function applyUserMove(
    game: Chess,
    from: Square,
    to: Square,
    match: { promotion?: 'q' | 'r' | 'b' | 'n' },
): Move | null {
    try {
        return game.move(
            match.promotion
                ? { from, to, promotion: match.promotion }
                : { from, to },
            { strict: false },
        )
    }
    catch {
        return null
    }
}

/**
 * Tests one card at a time: sets up its position, waits for the trainee's move, then chains
 * on through the book (opponent replies plus any of the trainee's not-due moves) to the next
 * card worth testing, when there is one.
 */
export function CardChessboard({
    deck,
    playerSide,
    card,
    setupPath,
    lessonKey,
    hintTrigger,
    historySansRef,
    onHistoryChange,
    onCardShown,
    isNewCard,
    onCardAnswered,
    onAlternateBookMove,
    pickChain,
    onChainEnd,
}: CardChessboardProps) {
    const gameRef = useRef(new Chess())
    const runIdRef = useRef(0)
    // Read the jump target through refs so only a lessonKey bump sets the board up again.
    const cardRef = useRef(card)
    cardRef.current = card
    const setupPathRef = useRef(setupPath)
    setupPathRef.current = setupPath
    /** The card waiting for the trainee, or null while book moves are being played. */
    const currentCardRef = useRef<Card | null>(null)
    /** True once the current card has been graded this showing. */
    const gradedRef = useRef(false)
    /** The current card is a practice move (a review card that isn't due). */
    const practiceRef = useRef(false)
    // True while a wrong move is displayed; blocks input until it is taken back.
    const showingWrongMoveRef = useRef(false)

    const [fen, setFen] = useState(() => gameRef.current.fen())
    const [boardKey, setBoardKey] = useState(0)
    const [selectedSquare, setSelectedSquare] = useState<string | null>(null)
    const [optionSquares, setOptionSquares] = useState({});
    const [lastMoveSquares, setLastMoveSquares] = useState<{ from?: string; to?: string }>({});
    const [hintSquare, setHintSquare] = useState<string | null>(null)
    const [wrongSquare, setWrongSquare] = useState<string | null>(null)
    /** The answer arrow while a new card is being introduced; wrong moves and Hint don't grade it. */
    const [solutionArrow, setSolutionArrow] = useState<Arrow | null>(null)
    const introducingRef = useRef(false)

    const callbacksRef = useRef({ onCardShown, isNewCard, onCardAnswered, onAlternateBookMove, pickChain, onChainEnd })
    callbacksRef.current = { onCardShown, isNewCard, onCardAnswered, onAlternateBookMove, pickChain, onChainEnd }

    // True while a jump's setup moves are being played; the full line was already reported.
    const settingUpRef = useRef(false)

    // Every history change is followed by a position change, so report the line on each new fen
    // (except during setup, so the panel doesn't step through the moves it already shows).
    const onHistoryChangeRef = useRef(onHistoryChange)
    onHistoryChangeRef.current = onHistoryChange
    useEffect(() => {
        if (settingUpRef.current) return
        onHistoryChangeRef.current?.([...historySansRef.current])
    }, [fen, historySansRef])

    const applyBookMove = useCallback(async (san: string, runId: number): Promise<boolean> => {
        try {
            const move = gameRef.current.move(san, { strict: false })
            historySansRef.current.push(move.san)
            setFen(gameRef.current.fen())
            setLastMoveSquares({ from: move.from, to: move.to })
            await wait(MOVE_ANIMATION_MS)
            return runId === runIdRef.current
        }
        catch {
            return false
        }
    }, [historySansRef])

    const showCard = useCallback((next: Card, practice: boolean) => {
        currentCardRef.current = next
        gradedRef.current = false
        practiceRef.current = practice
        introducingRef.current = callbacksRef.current.isNewCard(next)
        setSolutionArrow(introducingRef.current
            ? { startSquare: next.uci.slice(0, 2), endSquare: next.uci.slice(2, 4), color: SOLUTION_ARROW_COLOR }
            : null)
        callbacksRef.current.onCardShown(next, practice)
    }, [])

    const grade = useCallback((pass: boolean) => {
        const current = currentCardRef.current
        if (!current || gradedRef.current) return
        gradedRef.current = true
        callbacksRef.current.onCardAnswered(current, pass, practiceRef.current)
    }, [])

    /** Hint pressed while setup moves were still playing; shown once the card is up. */
    const pendingHintRef = useRef(false)

    const showHint = useCallback(() => {
        const current = currentCardRef.current
        // A new card's answer is already drawn.
        if (!current || introducingRef.current) return
        grade(false)
        setHintSquare(current.uci.slice(0, 2))
    }, [grade])

    // Jump: report the whole setup line up front, then play it out from the start position one
    // book move at a time (MOVE_ANIMATION_MS apart) and wait for the trainee.
    useEffect(() => {
        const runId = ++runIdRef.current
        const target = cardRef.current
        const setup = setupPathRef.current ?? []
        currentCardRef.current = null
        pendingHintRef.current = false
        showingWrongMoveRef.current = false
        introducingRef.current = false
        setSolutionArrow(null)
        setSelectedSquare(null)
        setOptionSquares({})
        setHintSquare(null)
        setWrongSquare(null)
        setLastMoveSquares({})

        gameRef.current = new Chess()
        historySansRef.current = []
        setFen(gameRef.current.fen())
        setBoardKey((key) => key + 1)

        settingUpRef.current = !!target && !!deck
        if (!target || !deck) return

        const setupSans = setupLineSans(setup)
        onHistoryChangeRef.current?.(setupSans)

        void (async () => {
            // Let the remounted board render the start position before the first move animates.
            await wait(100)
            for (const san of setupSans) {
                if (runId !== runIdRef.current) return
                if (!(await applyBookMove(san, runId))) return
            }
            if (runId !== runIdRef.current) return
            settingUpRef.current = false
            showCard(target, false)
            if (pendingHintRef.current) {
                pendingHintRef.current = false
                showHint()
            }
        })()
    }, [applyBookMove, deck, historySansRef, lessonKey, playerSide, showCard, showHint])

    const handledHintTriggerRef = useRef(hintTrigger)
    useEffect(() => {
        // Respond only to new Hint presses, not to lesson changes re-creating the callback.
        if (hintTrigger === handledHintTriggerRef.current) return
        handledHintTriggerRef.current = hintTrigger
        if (settingUpRef.current) {
            pendingHintRef.current = true
            return
        }
        if (showingWrongMoveRef.current) return
        showHint()
    }, [hintTrigger, showHint])

    const canDragPiece = useCallback(({ piece }: PieceHandlerArgs): boolean => {
        if (showingWrongMoveRef.current || !currentCardRef.current) return false
        return piece.pieceType[0] === playerSide
    }, [playerSide])

    const attemptPlayerMove = useCallback((
        sourceSquare: string,
        targetSquare: string | null,
    ): boolean => {
        const current = currentCardRef.current
        if (!deck || !current || !targetSquare || showingWrongMoveRef.current) return false
        if (sourceSquare === targetSquare) {
            setSelectedSquare(null)
            return true
        }

        const from = sourceSquare as Square
        const to = targetSquare as Square
        const game = gameRef.current
        const piece = game.get(from)
        if (!piece || piece.color !== playerSide || game.turn() !== playerSide)
            return false

        const match = findMatchingOutcome(game, from, to, [current.san])
        if (!match) {
            // Illegal moves just snap back. A legal but wrong move stays on the board,
            // outlined in red, then is taken back; the real game state is never touched.
            const wrongFen = fenAfterAttempt(game, from, to)
            if (!wrongFen) return false

            const otherBookSans = (deck.cardsAt.get(current.posKey) ?? [])
                .filter((c) => c.id !== current.id)
                .map((c) => c.san)
            if (findMatchingOutcome(game, from, to, otherBookSans))
                callbacksRef.current.onAlternateBookMove()
            else if (!introducingRef.current)
                grade(false)

            showingWrongMoveRef.current = true
            setSelectedSquare(null)
            setOptionSquares({})
            setWrongSquare(to)
            setFen(wrongFen)
            const runId = runIdRef.current
            void (async () => {
                await wait(WRONG_MOVE_DISPLAY_MS)
                if (runId !== runIdRef.current) return
                showingWrongMoveRef.current = false
                setWrongSquare(null)
                setFen(gameRef.current.fen())
            })()
            return true
        }

        const move = applyUserMove(game, from, to, match)
        if (!move) return false

        grade(true)
        currentCardRef.current = null
        introducingRef.current = false
        setSolutionArrow(null)
        historySansRef.current.push(move.san)
        setSelectedSquare(null)
        setHintSquare(null)
        setFen(game.fen())
        setLastMoveSquares({ from: move.from, to: move.to })

        // The schedule was just updated by grade(), so the chain choice can be made right away.
        const chain = callbacksRef.current.pickChain(fenSig(game.fen()), current.id)
        const runId = runIdRef.current
        if (!chain) {
            // Last move of the chain: hold it outlined in green before jumping to the next card.
            setHintSquare(move.to)
            void (async () => {
                await wait(CORRECT_MOVE_DISPLAY_MS)
                if (runId !== runIdRef.current) return
                setHintSquare(null)
                callbacksRef.current.onChainEnd()
            })()
            return true
        }
        void (async () => {
            await wait(MOVE_ANIMATION_MS)
            for (const san of chain.sans) {
                if (runId !== runIdRef.current) return
                if (!(await applyBookMove(san, runId))) return
            }
            if (runId === runIdRef.current) showCard(chain.card, chain.practice)
        })()
        return true
    }, [applyBookMove, deck, grade, historySansRef, playerSide, showCard])

    const getMoveOptions = useCallback((square: Square) => {
        const moves = gameRef.current.moves({ square, verbose: true });
        if (moves.length === 0) {
                setOptionSquares({});
                return false;
        }

        const newSquares: Record<string, React.CSSProperties> = {};
        moves.forEach((move) => {
                newSquares[move.to] = {
                        background: gameRef.current.get(move.to) && gameRef.current.get(move.to)?.color !== gameRef.current.get(square)?.color
                                ? 'radial-gradient(circle, transparent 70%, rgba(0,0,0,.1) 70%)'   // larger circle for capturing
                                : 'radial-gradient(circle, rgba(0,0,0,.1) 25%, transparent 25%)'  // smaller circle for open square
                };
        });
        setOptionSquares(newSquares);
        return true;
    }, [])

    const onPieceDrag = useCallback(({ square }: PieceHandlerArgs) => {
        if (!square) return
        setSelectedSquare(square)
        getMoveOptions(square as Square)
    }, [getMoveOptions])

    const onPieceDrop = useCallback(({
        sourceSquare,
        targetSquare,
    }: PieceDropHandlerArgs): boolean => {
        setSelectedSquare(null)
        setOptionSquares({});
        return attemptPlayerMove(sourceSquare, targetSquare)
    }, [attemptPlayerMove])

    const onSquareClick = useCallback(({ piece, square }: SquareHandlerArgs) => {
        if (showingWrongMoveRef.current) return
        if (!selectedSquare) {
            if (piece?.pieceType[0] === playerSide) {
                const hasMoves = getMoveOptions(square as Square)
                if (hasMoves) {
                    setSelectedSquare(square)
                } else {
                    setSelectedSquare(null)
                    setOptionSquares({});
                }
            }
            return
        }

        if (selectedSquare === square) {
            setSelectedSquare(null)
            setOptionSquares({});
            return
        }

        setOptionSquares({});
        if (!attemptPlayerMove(selectedSquare, square)) {
            if (piece?.pieceType[0] === playerSide) setSelectedSquare(square)
            else setSelectedSquare(null)
        }
    }, [attemptPlayerMove, playerSide, selectedSquare, getMoveOptions])

    // Combine options highlights, history highlights, then outlines (hint < selection < wrong move).
    const highlights = withSquareOutlines(
        {
            ...optionSquares,
            ...(lastMoveSquares.from && {
                [lastMoveSquares.from]: { backgroundColor: "rgba(179, 197, 18, 0.4)" }
            }),
            ...(lastMoveSquares.to && {
                [lastMoveSquares.to]: { backgroundColor: "rgba(179, 197, 18, 0.4)" }
            }),
        },
        [
            [hintSquare, HINT_SQUARE_STYLE],
            [selectedSquare, SELECTED_SQUARE_STYLE],
            [wrongSquare, WRONG_SQUARE_STYLE],
        ],
    )

    return (
        <Chessboard
            key={boardKey}
            options={{
                id: 'OpeningTrainerBoard',
                position: fen,
                boardOrientation: playerSide === 'w' ? 'white' : 'black',
                pieces: customPieces,
                animationDurationInMs: MOVE_ANIMATION_MS,
                canDragPiece,
                onPieceDrag,
                onPieceDrop,
                onSquareClick,
                squareStyles: highlights,
                arrows: solutionArrow && !wrongSquare ? [solutionArrow] : [],
                ...boardChrome,
            }}
        />
    )
}

// Fixed slider range, so the track renders correctly before the repertoires have loaded.
const MIN_TRAINING_DEPTH = 3
const MAX_TRAINING_DEPTH = 20

const TRAIN_MODE_OPTIONS = [
    { value: 'both', label: 'Both' },
    { value: 'white', label: 'White' },
    { value: 'black', label: 'Black' },
] as const satisfies ReadonlyArray<{ value: TrainMode; label: string }>

type OpeningsPageProps = {
    settings: AppSettings
    onSettingsChange: (patch: Partial<AppSettings>) => void
}

type OpeningsView = 'explore' | 'drill'

const VIEW_OPTIONS = [
    { value: 'explore', label: 'Explore' },
    { value: 'drill', label: 'Drill' },
] as const satisfies ReadonlyArray<{ value: OpeningsView; label: string }>

/** Repertoires as loaded once by OpeningsPage and shared by both views. */
export type LoadedRepertoires = {
    paths: GraymatterPaths | null
    whiteRepertoire: ParsedRepertoire | null
    blackRepertoire: ParsedRepertoire | null
    /** True once both PGNs are parsed. */
    ready: boolean
    loadError: string | null
}

/**
 * Loads both repertoires once, then shows Explore (the default every time the tab opens) or
 * Drill. Each view puts the Explore | Drill switch in its own panel.
 */
export function OpeningsPage({ settings, onSettingsChange }: OpeningsPageProps) {
    const [view, setView] = useState<OpeningsView>('explore')
    const [loaded, setLoaded] = useState<LoadedRepertoires>({
        paths: null,
        whiteRepertoire: null,
        blackRepertoire: null,
        ready: false,
        loadError: null,
    })

    useEffect(() => {
        let cancelled = false
        const fail = (loadError: string) => {
            if (!cancelled) setLoaded((prev) => ({ ...prev, loadError }))
        }

        void (async () => {
            try {
                if (!window.graymatter) {
                    fail('GrayMatter file API is unavailable. Run this app in Electron.')
                    return
                }

                const resolvedPaths = await window.graymatter.getPaths()
                if (cancelled) return
                setLoaded((prev) => ({ ...prev, paths: resolvedPaths }))

                const [whiteText, blackText] = await Promise.all([
                    window.graymatter.readTextFile(resolvedPaths.whitePgn),
                    window.graymatter.readTextFile(resolvedPaths.blackPgn),
                ])
                if (cancelled) return

                const whiteParsed = parsePgnToRepertoire(whiteText)
                const blackParsed = parsePgnToRepertoire(blackText)

                if ('error' in whiteParsed) {
                    fail(`White PGN: ${whiteParsed.error ?? 'Could not parse.'}`)
                    return
                }
                if ('error' in blackParsed) {
                    fail(`Black PGN: ${blackParsed.error ?? 'Could not parse.'}`)
                    return
                }

                logRepertoireTreeDfs(whiteParsed.root)
                logRepertoireTreeDfs(blackParsed.root)
                setLoaded({
                    paths: resolvedPaths,
                    whiteRepertoire: whiteParsed,
                    blackRepertoire: blackParsed,
                    ready: true,
                    loadError: null,
                })
            }
            catch (err) {
                const message = err instanceof Error ? err.message : String(err)
                fail(`Could not load repertoire files: ${message}`)
            }
        })()

        return () => {
            cancelled = true
        }
    }, [])

    const viewSwitch = (
        <SegmentedControl label="Openings mode" options={VIEW_OPTIONS} value={view} onChange={setView} />
    )

    return view === 'explore'
        ? <ExploreView loaded={loaded} viewSwitch={viewSwitch} />
        : (
            <DrillView
                settings={settings}
                onSettingsChange={onSettingsChange}
                loaded={loaded}
                viewSwitch={viewSwitch}
            />
        )
}

type DrillViewProps = OpeningsPageProps & {
    loaded: LoadedRepertoires
    viewSwitch: ReactNode
}

/** Setup moves in chess.js SAN (as the board reports them), for the panel's line. */
function setupLineSans(setup: readonly string[]): string[] {
    const game = new Chess()
    const sans: string[] = []
    for (const san of setup) {
        try {
            sans.push(game.move(san, { strict: false }).san)
        }
        catch {
            break
        }
    }
    return sans
}

/** How often the panel's due counts refresh, and an idle drill re-checks for due cards. */
const DRILL_TICK_MS = 30_000

/**
 * Drill: spaced repetition over the trainee's moves. Each card is one (position, book move);
 * the schedule lives in TrainingStatus.json and is merged with the copy on disk on every save.
 */
function DrillView({ settings, onSettingsChange, loaded, viewSwitch }: DrillViewProps) {
    const { paths, whiteRepertoire, blackRepertoire, ready, loadError } = loaded
    const [saveError, setSaveError] = useState<string | null>(null)
    const parseError = saveError ?? loadError
    const trainMode = settings.openingsTrainMode
    const newPerDay = settings.openingsNewPerDay
    const [activeSide, setActiveSide] = useState<Side>('w')
    const [jumpCard, setJumpCard] = useState<Card | null>(null)
    const [setupPath, setSetupPath] = useState<string[] | null>(null)
    const [lessonKey, setLessonKey] = useState(0)
    const [currentCard, setCurrentCard] = useState<Card | null>(null)
    const [currentIsPractice, setCurrentIsPractice] = useState(false)
    const [scheduleReady, setScheduleReady] = useState(false)
    // The schedule is mutated in place; bump this to re-render the counts.
    const [, setScheduleRevision] = useState(0)
    const [sessionReviews, setSessionReviews] = useState(0)
    const [hintTrigger, setHintTrigger] = useState(0)
    const [showAlternateNotice, setShowAlternateNotice] = useState(false)
    // The current line as the board reports it, for the status card.
    const [lineSans, setLineSans] = useState<string[]>([])
    const [confirmingReset, setConfirmingReset] = useState(false)

    const trainingDepth = Math.min(
        MAX_TRAINING_DEPTH,
        Math.max(MIN_TRAINING_DEPTH, settings.openingsTrainDepth),
    )

    // Dragging a slider only moves its draft; the value is saved when the thumb is released.
    const [depthDraft, setDepthDraft] = useState(trainingDepth)
    useEffect(() => {
        setDepthDraft(trainingDepth)
    }, [trainingDepth])
    const [newPerDayDraft, setNewPerDayDraft] = useState(newPerDay)
    useEffect(() => {
        setNewPerDayDraft(newPerDay)
    }, [newPerDay])

    const whiteDeck = useMemo(
        () => (whiteRepertoire ? buildCardDeck(whiteRepertoire.root, 'w') : null),
        [whiteRepertoire],
    )
    const blackDeck = useMemo(
        () => (blackRepertoire ? buildCardDeck(blackRepertoire.root, 'b') : null),
        [blackRepertoire],
    )
    const decksForMode = useCallback((mode: TrainMode): CardDeck[] => {
        const decks: CardDeck[] = []
        if (mode !== 'black' && whiteDeck) decks.push(whiteDeck)
        if (mode !== 'white' && blackDeck) decks.push(blackDeck)
        return decks
    }, [blackDeck, whiteDeck])

    const scheduleRef = useRef<Schedule>(new Map())
    const pathsRef = useRef<GraymatterPaths | null>(null)
    const saveChainRef = useRef(Promise.resolve())
    const historySansRef = useRef<string[]>([])
    const currentCardRef = useRef<Card | null>(null)
    const jumpCardRef = useRef<Card | null>(null)
    pathsRef.current = paths
    currentCardRef.current = currentCard
    jumpCardRef.current = jumpCard
    // The running chain (since the last jump): new cards shown and positions passed through.
    const chainNewCountRef = useRef(0)
    const chainVisitedRef = useRef(new Set<string>())

    // Settings read inside stable callbacks, so changing them doesn't restart the current card.
    const pickOptionsRef = useRef<Omit<PickOptions, 'now'>>({ maxDepth: trainingDepth, newPerDay })
    pickOptionsRef.current = { maxDepth: trainingDepth, newPerDay }
    const pickOptions = (): PickOptions => ({ ...pickOptionsRef.current, now: new Date() })

    // Re-read the schedule every time Drill opens, so reviews from the other client show up.
    useEffect(() => {
        if (!paths) return
        let cancelled = false
        void (async () => {
            let schedule: Schedule = new Map()
            try {
                schedule = parseTrainingFileJson(await window.graymatter.readTextFile(paths.trainingStatus))
            }
            catch {
                // No training file yet — every card starts new.
            }
            if (cancelled) return
            scheduleRef.current = schedule
            setScheduleReady(true)
        })()
        return () => {
            cancelled = true
        }
    }, [paths])

    /** Saves the schedule, first merging in the copy on disk unless `replace` (used by reset). */
    const persistSchedule = useCallback((opts?: { replace?: boolean }) => {
        const currentPaths = pathsRef.current
        if (!currentPaths) return
        saveChainRef.current = saveChainRef.current
            .then(async () => {
                if (!opts?.replace) {
                    let onDisk: Schedule = new Map()
                    try {
                        onDisk = parseTrainingFileJson(await window.graymatter.readTextFile(currentPaths.trainingStatus))
                    }
                    catch {
                        // Missing file: nothing to merge.
                    }
                    // Merge after the read so a review made while it was in flight isn't lost.
                    scheduleRef.current = mergeSchedules(onDisk, scheduleRef.current)
                    setScheduleRevision((revision) => revision + 1)
                }
                await window.graymatter.writeTextFile(
                    currentPaths.trainingStatus,
                    serializeTrainingFile(scheduleRef.current),
                )
            })
            .catch((err: unknown) => {
                console.error('Failed to save training status', err)
                setSaveError('Could not save TrainingStatus.json.')
            })
    }, [])

    /** Jumps to the next card to study, or to the idle start position when nothing is due. */
    const beginNextCard = useCallback(() => {
        const picked = pickNextCard(decksForMode(trainMode), scheduleRef.current, {
            ...pickOptions(),
            excludeId: currentCardRef.current?.id,
        })
        if (!picked) {
            // Already idle: leave the board alone instead of re-mounting it on every tick.
            if (!currentCardRef.current && !jumpCardRef.current) return
            setCurrentCard(null)
            setJumpCard(null)
            setSetupPath(null)
            setLessonKey((key) => key + 1)
            return
        }
        const deck = picked.card.side === 'w' ? whiteDeck : blackDeck
        if (!deck) return
        const setup = pickSetupPath(deck, picked.card, (id) => {
            const r = scheduleRef.current.get(id)
            return !!r && r.state !== 'review'
        })
        chainNewCountRef.current = 0
        chainVisitedRef.current = new Set()
        setActiveSide(picked.card.side)
        setCurrentCard(null)
        setJumpCard(picked.card)
        setSetupPath(setup)
        // The board reports this line too, but setting it in the same batch avoids a frame
        // showing the old line beside the new card.
        setLineSans(setupLineSans(setup))
        setLessonKey((key) => key + 1)
    }, [blackDeck, decksForMode, trainMode, whiteDeck])

    // Start once the decks and schedule are ready, and again whenever the mode changes.
    useEffect(() => {
        if (!ready || !scheduleReady) return
        beginNextCard()
    }, [beginNextCard, ready, scheduleReady])

    // A new max depth only interrupts a card that's now too deep; when idle it may unlock cards.
    useEffect(() => {
        if (!ready || !scheduleReady) return
        const current = currentCardRef.current
        if (!current || current.depth > trainingDepth) beginNextCard()
        // beginNextCard is left out on purpose: the effect above handles mode changes.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [newPerDay, trainingDepth])

    // Refresh due counts, and pick up cards that come due while idle.
    const [, setTick] = useState(0)
    const beginNextCardRef = useRef(beginNextCard)
    beginNextCardRef.current = beginNextCard
    useEffect(() => {
        const id = window.setInterval(() => {
            setTick((tick) => tick + 1)
            if (!currentCardRef.current && !jumpCardRef.current) beginNextCardRef.current()
        }, DRILL_TICK_MS)
        return () => window.clearInterval(id)
    }, [])

    const onCardShown = useCallback((card: Card, practice: boolean) => {
        if (!scheduleRef.current.has(card.id)) chainNewCountRef.current++
        chainVisitedRef.current.add(card.posKey)
        setCurrentCard(card)
        setCurrentIsPractice(practice)
        setShowAlternateNotice(false)
    }, [])

    const onCardAnswered = useCallback((card: Card, pass: boolean, practice: boolean) => {
        const previous = scheduleRef.current.get(card.id)
        if (practice) {
            // A correct practice move leaves the schedule alone; only a miss counts.
            if (pass || !previous) return
            scheduleRef.current.set(card.id, missPracticeCard(card, previous, new Date()))
        }
        else {
            scheduleRef.current.set(card.id, gradeCard(card, previous, pass, new Date()))
            setSessionReviews((count) => count + 1)
        }
        setScheduleRevision((revision) => revision + 1)
        persistSchedule()
    }, [persistSchedule])

    const isNewCard = useCallback((card: Card) => !scheduleRef.current.has(card.id), [])

    const onAlternateBookMove = useCallback(() => {
        setShowAlternateNotice(true)
        window.setTimeout(() => setShowAlternateNotice(false), WRONG_MOVE_DISPLAY_MS)
    }, [])

    const activeDeck = activeSide === 'w' ? whiteDeck : blackDeck
    const onPickChain = useCallback((positionKey: string, answeredId: string) => {
        if (!activeDeck) return null
        const options = { ...pickOptions(), excludeId: answeredId }
        chainVisitedRef.current.add(positionKey)
        // Chain into a learning card due soon only when a jump would pick one anyway (nothing
        // due or new anywhere), so due cards elsewhere aren't held up.
        const jump = pickNextCard(decksForMode(trainMode), scheduleRef.current, options)
        return pickChainPath(activeDeck, scheduleRef.current, positionKey, {
            ...options,
            allowAhead: jump?.kind === 'ahead',
            newLeft: CHAIN_MAX_NEW - chainNewCountRef.current,
            visited: chainVisitedRef.current,
        })
    }, [activeDeck, decksForMode, trainMode])

    const onTrainModeChange = (mode: TrainMode) => {
        onSettingsChange({ openingsTrainMode: mode })
    }

    const resetSchedule = () => {
        scheduleRef.current = new Map()
        persistSchedule({ replace: true })
        setScheduleRevision((revision) => revision + 1)
        setSessionReviews(0)
        setCurrentCard(null)
        currentCardRef.current = null
        beginNextCard()
    }

    const loading = !ready || !scheduleReady
    const stats = deckStats(decksForMode(trainMode), scheduleRef.current, pickOptions())
    // While a jump's setup moves play out, the panel already shows the card they lead to.
    const shownCard = currentCard ?? jumpCard
    const currentRecord = shownCard ? scheduleRef.current.get(shownCard.id) : undefined
    const sideName = activeSide === 'w' ? 'White' : 'Black'
    const sideToMove: Side = lineSans.length % 2 === 0 ? 'w' : 'b'
    const traineeToMove = !!shownCard && sideToMove === activeSide
    // Only a chained card can be practice, and only once it's waiting for the trainee.
    const practicing = !!currentCard && currentIsPractice
    const lineTokens = formatLine(lineSans)

    let banner
    if (loading) {
        banner = <StatusBanner tone="info" title={parseError ? 'Repertoires not loaded' : 'Loading repertoires…'} />
    }
    else if (!shownCard) {
        banner = stats.total === 0
            ? <StatusBanner tone="info" title="No cards" text="No moves within the max depth for this repertoire." />
            : (
                <StatusBanner
                    tone="success"
                    title="All caught up"
                    text={stats.nextDueMs === null
                        ? 'No reviews scheduled.'
                        : `Next review in ${formatWait(stats.nextDueMs - Date.now())}.`}
                />
            )
    }
    else if (showAlternateNotice) {
        banner = <StatusBanner tone="info" title="Also in your book" text="Play the other move for this position." />
    }
    else {
        banner = (
            <StatusBanner
                title={traineeToMove ? (practicing ? 'Practice' : currentRecord ? 'Your move' : 'New move') : 'Book move'}
                text={`· ${sideName} repertoire${traineeToMove && practicing ? ' · not graded' : ''}`}
                marker={traineeToMove ? undefined : <SideMarker side={sideToMove} />}
            >
                <div className="font-mono text-xs text-soft">
                    {lineTokens.join(' ')}
                    {traineeToMove && (
                        <>
                            {lineTokens.length ? ' ' : ''}
                            {sideToMove === 'w' && `${lineSans.length / 2 + 1}. `}
                            <span className="text-accent-ink">?</span>
                        </>
                    )}
                </div>
            </StatusBanner>
        )
    }

    let cardScheduleText = ''
    if (shownCard) {
        cardScheduleText = currentRecord
            ? `${practicing ? 'Practice · ' : ''}Next review ${formatWait(Date.parse(currentRecord.due) - Date.now())} · ease ${currentRecord.ease} · lapses ${currentRecord.lapses}`
            : 'New card · play the arrow'
    }

    return (
        <BoardPage
            label="Openings controls"
            board={(
                <div className="board-panel">
                    <CardChessboard
                        deck={loading ? null : activeDeck}
                        playerSide={activeSide}
                        card={jumpCard}
                        setupPath={setupPath}
                        lessonKey={lessonKey}
                        hintTrigger={hintTrigger}
                        historySansRef={historySansRef}
                        onHistoryChange={setLineSans}
                        onCardShown={onCardShown}
                        isNewCard={isNewCard}
                        onCardAnswered={onCardAnswered}
                        onAlternateBookMove={onAlternateBookMove}
                        pickChain={onPickChain}
                        onChainEnd={beginNextCard}
                    />
                </div>
            )}
            footer={confirmingReset
                ? (
                    <div
                        role="alertdialog"
                        aria-label="Confirm reset"
                        className="flex flex-col gap-2.5 rounded-[10px] border border-danger/35 bg-danger/10 p-3"
                    >
                        <span className="text-[13px] text-red-200">Clear the review schedule for every card?</span>
                        <div className="flex justify-end gap-2">
                            <Button className="h-8 px-3 text-[13px]" onClick={() => setConfirmingReset(false)}>
                                Cancel
                            </Button>
                            <button
                                type="button"
                                onClick={() => {
                                    setConfirmingReset(false)
                                    resetSchedule()
                                }}
                                className="h-8 rounded-lg bg-red-600 px-3 text-[13px] font-semibold text-white transition hover:bg-red-500"
                            >
                                Clear schedule
                            </button>
                        </div>
                    </div>
                )
                : (
                    <div className="flex items-center gap-2">
                        <Button
                            className="flex-1"
                            icon={<LightbulbIcon className="text-success" />}
                            onClick={() => setHintTrigger((trigger) => trigger + 1)}
                            disabled={loading || !shownCard || !currentRecord}
                        >
                            Hint
                        </Button>
                        <Button
                            variant="danger"
                            icon={<ResetIcon size={15} />}
                            onClick={() => setConfirmingReset(true)}
                            disabled={loading}
                        >
                            Reset…
                        </Button>
                    </div>
                )}
        >
            <PanelHeader
                title="Openings"
                subtitle="Spaced repetition over your repertoire moves."
                info={'Each of your book moves is a card, keyed by position, so transpositions share one card. '
                    + 'A correct first try schedules it further out; a wrong move or a hint brings it back soon. '
                    + 'The schedule is saved to TrainingStatus.json on Google Drive after every answer.'}
            />

            {viewSwitch}

            {banner}

            <Section label="Repertoire">
                <SegmentedControl
                    label="Repertoire"
                    options={TRAIN_MODE_OPTIONS}
                    value={trainMode}
                    onChange={onTrainModeChange}
                />
            </Section>

            <Section label="Max depth" aside={<ValueBadge>{depthDraft} moves</ValueBadge>}>
                <RangeSlider
                    label="Max depth"
                    min={MIN_TRAINING_DEPTH}
                    max={MAX_TRAINING_DEPTH}
                    value={depthDraft}
                    onDraft={setDepthDraft}
                    onCommit={(value) => {
                        if (value !== trainingDepth) onSettingsChange({ openingsTrainDepth: value })
                    }}
                />
            </Section>

            <Section label="New cards per day" aside={<ValueBadge>{newPerDayDraft}</ValueBadge>}>
                <RangeSlider
                    label="New cards per day"
                    min={NEW_CARDS_PER_DAY_MIN}
                    max={NEW_CARDS_PER_DAY_MAX}
                    value={newPerDayDraft}
                    onDraft={setNewPerDayDraft}
                    onCommit={(value) => {
                        if (value !== newPerDay) onSettingsChange({ openingsNewPerDay: value })
                    }}
                />
            </Section>

            <PanelCard>
                <div className="flex items-baseline justify-between">
                    <span className="text-[13px] text-soft">Due now</span>
                    <span className="font-mono text-[22px] font-semibold text-ink">{loading ? '–' : stats.dueNow}</span>
                </div>
                <ProgressBar
                    label="Cards learned"
                    value={stats.learned}
                    max={stats.total}
                    tone="success"
                />
                <div className="grid grid-cols-3 gap-2">
                    <StatTile label="New today" value={loading ? '–' : stats.newLeftToday} />
                    <StatTile label="Learned" value={loading ? '–' : `${stats.learned}/${stats.total}`} />
                    <StatTile label="Session" value={sessionReviews} accent />
                </div>
                {cardScheduleText && <div className="font-mono text-[11px] text-faint">{cardScheduleText}</div>}
            </PanelCard>

            {parseError && <ErrorNote>{parseError}</ErrorNote>}
        </BoardPage>
    )
}
