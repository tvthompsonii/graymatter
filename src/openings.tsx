import type { Square } from 'chess.js'
import { Chess, type Move } from 'chess.js'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Chessboard } from 'react-chessboard'
import type {
    PieceDropHandlerArgs,
    PieceHandlerArgs,
    SquareHandlerArgs,
} from 'react-chessboard'

import {
    boardChrome,
    customPieces,
    HINT_SQUARE_STYLE,
    MOVE_ANIMATION_MS,
    SELECTED_SQUARE_STYLE,
    withSquareOutlines,
    WRONG_MOVE_DISPLAY_MS,
    WRONG_SQUARE_STYLE,
} from './boardTheme'
import type { GraymatterPaths } from './graymatter'
import {
    collectPracticeTerminalPaths,
    countPlayerMoves,
    fenSig,
    legalChildSans,
    logRepertoireTreeDfs,
    pathHasPracticeAhead,
    pickRandomPracticePath,
    resetNeedsPractice,
    treeHasPracticeRemaining,
    walkToNode,
    type Node,
} from './moveTree'
import { parsePgnToRepertoire, type ParsedRepertoire } from './pgnPaths'
import type { AppSettings, TrainMode } from './settings'
import {
    applyDualTrainingStatus,
    parseTrainingFileJson,
    serializeDualTrainingStatus,
} from './trainingExport'

export type Side = 'w' | 'b'

export type TrainerChessboardProps = {
    root: Node | null
    /** Progress summary shown in the status line, e.g. "Lines left: 54 · Finished this session: 3". */
    progressText: string
    playerSide: Side
    /** Exact SAN path for the current drill line; null when nothing left to practice. */
    targetPath: readonly string[] | null
    trainingDepth: number
    sessionResetKey: number
    lessonKey: number
    trainingRevision: number
    /** Bump to outline the square of the piece the trainee should move next. */
    hintTrigger: number
    /** SAN moves played so far in the current line; owned by the page so a depth change can inspect it. */
    historySansRef: { current: string[] }
    onStatusChange: (status: string) => void
    onLessonComplete: () => void
    onTrainingChanged: () => void
}

function wait(ms: number): Promise<void> {
    return new Promise((resolve) => window.setTimeout(resolve, ms))
}

function normalizeSan(san: string): string {
    return san.replace(/[+#]+$/, '').trim()
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

function repertoireSanForPlayed(
    allowedSans: readonly string[],
    playedSan: string,
): string | null {
    const normalized = normalizeSan(playedSan)
    return allowedSans.find((san) => normalizeSan(san) === normalized) ?? null
}

export function TrainerChessboard({
    root,
    progressText,
    playerSide,
    targetPath,
    trainingDepth,
    sessionResetKey,
    lessonKey,
    trainingRevision,
    hintTrigger,
    historySansRef,
    onStatusChange,
    onLessonComplete,
    onTrainingChanged,
}: TrainerChessboardProps) {
    const gameRef = useRef(new Chess())
    const targetPathRef = useRef(targetPath)
    targetPathRef.current = targetPath
    // Read through a ref so a depth change alone doesn't re-settle the board; the page decides
    // whether the current line survives a new depth (and swaps targetPath or starts a new lesson).
    const trainingDepthRef = useRef(trainingDepth)
    trainingDepthRef.current = trainingDepth
    const branchDrillsRef = useRef(new Map<string, Set<string>>())
    const settlingRef = useRef(false)
    const runIdRef = useRef(0)
    const leafHandledRef = useRef(false)
    const previousRootRef = useRef<Node | null>(null)
    const previousSessionResetKeyRef = useRef(sessionResetKey)

    const [fen, setFen] = useState(() => gameRef.current.fen())
    const [boardKey, setBoardKey] = useState(0)
    const [selectedSquare, setSelectedSquare] = useState<string | null>(null)
    const [optionSquares, setOptionSquares] = useState({});
    const [lastMoveSquares, setLastMoveSquares] = useState<{ from?: string; to?: string }>({});
    const [hintSquare, setHintSquare] = useState<string | null>(null)
    const [wrongSquare, setWrongSquare] = useState<string | null>(null)
    // True while a wrong move is displayed; blocks input until it is taken back.
    const showingWrongMoveRef = useRef(false)

    const rebuildStatus = useCallback(() => {
        if (!root) {
            onStatusChange('Loading repertoires…')
        }
        else if (!targetPath) {
            onStatusChange('All lines practiced. Reset training progress to start over.')
        }
        else {
            onStatusChange(progressText)
        }
    }, [onStatusChange, progressText, root, targetPath])

    useEffect(() => {
        rebuildStatus()
    }, [rebuildStatus])

    const onLessonCompleteRef = useRef(onLessonComplete)
    onLessonCompleteRef.current = onLessonComplete
    const onTrainingChangedRef = useRef(onTrainingChanged)
    onTrainingChangedRef.current = onTrainingChanged

    const finishLineAndAdvance = useCallback(() => {
        if (leafHandledRef.current) return
        leafHandledRef.current = true
        settlingRef.current = false
        onLessonCompleteRef.current()
    }, [])

    const applyBookMove = useCallback(async (
        san: string,
        runId: number,
    ): Promise<boolean> => {
        try {
            const move = gameRef.current.move(san, { strict: false })
            if (!move) return false
            historySansRef.current.push(san)
            setFen(gameRef.current.fen())
            setLastMoveSquares({ from: move.from, to: move.to });
            await wait(MOVE_ANIMATION_MS)
            return runId === runIdRef.current
        }
        catch {
            return false
        }
    }, [])

    const startLesson = useCallback(async (animateFirstMove: boolean) => {
        const runId = ++runIdRef.current
        settlingRef.current = false
        leafHandledRef.current = false
        gameRef.current = new Chess()
        historySansRef.current = []
        showingWrongMoveRef.current = false
        setSelectedSquare(null)
        setLastMoveSquares({})
        setOptionSquares({})
        setHintSquare(null)
        setWrongSquare(null)

        if (root && playerSide === 'b') {
            const first = targetPathRef.current?.[0]
                ?? legalChildSans(gameRef.current, root).sort()[0]
            if (first) {
                gameRef.current.move(first, { strict: false })
                historySansRef.current.push(first)
            }
        }

        setFen(gameRef.current.fen())
        setBoardKey((key) => key + 1)

        if (animateFirstMove && playerSide === 'b')
            await wait(MOVE_ANIMATION_MS)

        return runId
    }, [historySansRef, playerSide, root])

    const settleAfterChange = useCallback(async () => {
        if (!root || settlingRef.current) return
        const runId = runIdRef.current
        settlingRef.current = true

        try {
            while (runId === runIdRef.current) {
                const history = historySansRef.current

                if (countPlayerMoves(history, playerSide) >= trainingDepthRef.current) {
                    finishLineAndAdvance()
                    return
                }

                // The trainee's move must be the last one played: once none of their remaining
                // moves on this line need practice, stop instead of auto-playing further book moves.
                if (targetPath && !pathHasPracticeAhead(root, targetPath, history.length, playerSide)) {
                    finishLineAndAdvance()
                    return
                }

                const node = walkToNode(root, history)

                if (!node || node.children.size === 0) {
                    // End of line — always advance, whether trainee or book played the last move.
                    finishLineAndAdvance()
                    return
                }

                const outs = legalChildSans(gameRef.current, node)
                if (!outs.length) {
                    finishLineAndAdvance()
                    return
                }

                const nextOnPath = targetPath?.[historySansRef.current.length]
                const game = gameRef.current

                if (game.turn() === playerSide) {
                    if (nextOnPath && outs.includes(nextOnPath)) {
                        const child = node.children.get(nextOnPath)
                        if (child?.needsPractice) break
                        if (!(await applyBookMove(nextOnPath, runId))) break
                        continue
                    }

                    const needsPractice = outs.filter(
                        (san) => node.children.get(san)?.needsPractice === true,
                    )
                    if (needsPractice.length) break

                    const practicedMove = nextOnPath && outs.includes(nextOnPath)
                        ? nextOnPath
                        : [...outs].sort()[0]!
                    if (!(await applyBookMove(practicedMove, runId))) break
                    continue
                }

                let opponentMove: string
                if (nextOnPath && outs.includes(nextOnPath)) {
                    opponentMove = nextOnPath
                }
                else if (outs.length === 1) {
                    opponentMove = outs[0]!
                }
                else {
                    const signature = fenSig(game.fen())
                    let used = branchDrillsRef.current.get(signature)
                    if (!used) {
                        used = new Set()
                        branchDrillsRef.current.set(signature, used)
                    }

                    let choices = outs.filter((san) => !used.has(san))
                    if (!choices.length) {
                        used.clear()
                        choices = outs
                    }
                    opponentMove = choices[Math.floor(Math.random() * choices.length)]!
                    used.add(opponentMove)
                }

                if (!(await applyBookMove(opponentMove, runId))) break
            }

            const endHistory = historySansRef.current
            if (countPlayerMoves(endHistory, playerSide) >= trainingDepthRef.current) {
                finishLineAndAdvance()
                return
            }
            const endNode = walkToNode(root, endHistory)
            if (!endNode || endNode.children.size === 0) {
                finishLineAndAdvance()
            }
        }
        finally {
            settlingRef.current = false
        }
    }, [
        applyBookMove,
        finishLineAndAdvance,
        playerSide,
        root,
        targetPath,
    ])

    // Restart the board only for a new lesson (or side/repertoire/session change). A targetPath or
    // depth change alone keeps the current position; the effect below re-settles against it.
    const startLessonRef = useRef(startLesson)
    startLessonRef.current = startLesson
    const settleAfterChangeRef = useRef(settleAfterChange)
    settleAfterChangeRef.current = settleAfterChange

    useEffect(() => {
        const rootChanged = previousRootRef.current !== root
        const sessionWasReset =
            previousSessionResetKeyRef.current !== sessionResetKey
        previousRootRef.current = root
        previousSessionResetKeyRef.current = sessionResetKey
        if (rootChanged || sessionWasReset) {
            branchDrillsRef.current = new Map()
        }

        void (async () => {
            await startLessonRef.current(false)
            await settleAfterChangeRef.current()
        })()
    }, [playerSide, root, sessionResetKey, lessonKey])

    useEffect(() => {
        if (!root) return
        void settleAfterChange()
    }, [root, settleAfterChange, trainingRevision])

    const legalPlayerSansNeedingPractice = useCallback((): string[] => {
        if (!root || gameRef.current.turn() !== playerSide) return []
        const node = walkToNode(root, historySansRef.current)
        if (!node) return []

        const nextOnPath = targetPath?.[historySansRef.current.length]
        if (nextOnPath) {
            const child = node.children.get(nextOnPath)
            if (child?.needsPractice) return [nextOnPath]
            return []
        }

        return legalChildSans(gameRef.current, node).filter(
            (san) => node.children.get(san)?.needsPractice === true,
        )
    }, [playerSide, root, targetPath])

    const handledHintTriggerRef = useRef(hintTrigger)
    useEffect(() => {
        // Respond only to new Hint presses, not to lesson changes re-creating the callback.
        if (hintTrigger === handledHintTriggerRef.current) return
        handledHintTriggerRef.current = hintTrigger
        if (showingWrongMoveRef.current) return

        const san = legalPlayerSansNeedingPractice()[0]
        if (!san) return
        try {
            const move = new Chess(gameRef.current.fen()).move(san, { strict: false })
            if (move) setHintSquare(move.from)
        }
        catch {
            // Repertoire move not playable here; no hint to show.
        }
    }, [hintTrigger, legalPlayerSansNeedingPractice])

    const canDragPiece = useCallback(({ piece }: PieceHandlerArgs): boolean => {
        if (showingWrongMoveRef.current) return false
        if (piece.pieceType[0] !== playerSide) return false
        return legalPlayerSansNeedingPractice().length > 0
    }, [legalPlayerSansNeedingPractice, playerSide])

    const attemptPlayerMove = useCallback((
        sourceSquare: string,
        targetSquare: string | null,
    ): boolean => {
        if (!root || !targetSquare || showingWrongMoveRef.current) return false
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

        const allowed = legalPlayerSansNeedingPractice()
        if (!allowed.length) return false

        const match = findMatchingOutcome(game, from, to, allowed)
        if (!match) {
            // Illegal moves just snap back. A legal but wrong move stays on the board,
            // outlined in red, then is taken back; the real game state is never touched.
            const wrongFen = fenAfterAttempt(game, from, to)
            if (!wrongFen) return false

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

        const repertoireSan = repertoireSanForPlayed(allowed, move.san) ?? move.san
        historySansRef.current.push(repertoireSan)
        const playedNode = walkToNode(root, historySansRef.current)
        if (playedNode) {
            playedNode.needsPractice = false
            onTrainingChangedRef.current()
        }

        setSelectedSquare(null)
        setHintSquare(null)
        setFen(game.fen())
        setLastMoveSquares({ from: move.from, to: move.to })
        const runId = runIdRef.current
        void (async () => {
            await wait(MOVE_ANIMATION_MS)
            if (runId === runIdRef.current) await settleAfterChange()
        })()
        return true
    }, [
        legalPlayerSansNeedingPractice,
        playerSide,
        root,
        settleAfterChange,
    ])

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
                ...boardChrome,
            }}
        />
    )
}

function pickActiveSide(
    mode: TrainMode,
    white: ParsedRepertoire | null,
    black: ParsedRepertoire | null,
    trainingDepth: number,
): Side | null {
    const whiteOk = mode !== 'black' && !!white && treeHasPracticeRemaining(white.root, 'w', trainingDepth)
    const blackOk = mode !== 'white' && !!black && treeHasPracticeRemaining(black.root, 'b', trainingDepth)

    if (mode === 'white') return white ? 'w' : null
    if (mode === 'black') return black ? 'b' : null

    const candidates: Side[] = []
    if (whiteOk) candidates.push('w')
    if (blackOk) candidates.push('b')
    if (candidates.length) {
        return candidates[Math.floor(Math.random() * candidates.length)]!
    }

    if (white) return 'w'
    if (black) return 'b'
    return null
}

function modeHasPracticeRemaining(
    mode: TrainMode,
    white: ParsedRepertoire | null,
    black: ParsedRepertoire | null,
    trainingDepth: number,
): boolean {
    if (mode !== 'black' && white && treeHasPracticeRemaining(white.root, 'w', trainingDepth)) return true
    if (mode !== 'white' && black && treeHasPracticeRemaining(black.root, 'b', trainingDepth)) return true
    return false
}

// Fixed slider range, so the track renders correctly before the repertoires have loaded.
const MIN_TRAINING_DEPTH = 3
const MAX_TRAINING_DEPTH = 20

/** CSS `left` for a point at `percent` along a range input, matching where its 1rem thumb centers. */
function rangeThumbLeft(percent: number): string {
    return `calc(${percent}% + ${0.5 - percent / 100}rem)`
}

function DepthSlider({
    value,
    min,
    max,
    onDraftChange,
    onCommit,
}: {
    value: number
    min: number
    max: number
    /** Every step while dragging (updates the display only). */
    onDraftChange: (value: number) => void
    /** The value the slider was released on. */
    onCommit: (value: number) => void
}) {
    const span = Math.max(1, max - min)
    const percentFor = (v: number) => ((v - min) / span) * 100
    const ticks = Array.from({ length: max - min + 1 }, (_, i) => min + i)

    // React's onChange fires on every input step; the native `change` event fires only when the
    // thumb is released (or on each keyboard step), which is when the depth should actually apply.
    const inputRef = useRef<HTMLInputElement>(null)
    const onCommitRef = useRef(onCommit)
    onCommitRef.current = onCommit
    useEffect(() => {
        const input = inputRef.current
        if (!input) return
        const commit = () => onCommitRef.current(Number(input.value))
        input.addEventListener('change', commit)
        return () => input.removeEventListener('change', commit)
    }, [])

    return (
        <div>
            <div className="relative h-8">
                <div className="absolute top-1/2 h-1.5 w-full -translate-y-1/2 rounded-full bg-slate-700" />
                <div
                    className="absolute left-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-amber-500/70"
                    style={{ width: rangeThumbLeft(percentFor(value)) }}
                />
                {ticks.map((tick) => (
                    <span
                        key={tick}
                        className={`absolute top-1/2 h-1 w-1 -translate-x-1/2 translate-y-2 rounded-full ${tick <= value ? 'bg-amber-400/70' : 'bg-slate-600'}`}
                        style={{ left: rangeThumbLeft(percentFor(tick)) }}
                    />
                ))}
                <input
                    ref={inputRef}
                    type="range"
                    min={min}
                    max={max}
                    step={1}
                    value={value}
                    onChange={(event) => onDraftChange(Number(event.target.value))}
                    className="rating-slider-thumb absolute inset-0 z-10 w-full cursor-pointer appearance-none bg-transparent"
                    // The shared thumb class disables track clicks (for the dual slider); a single slider wants them.
                    style={{ pointerEvents: 'auto' }}
                    aria-label="Training depth"
                />
            </div>
        </div>
    )
}

type OpeningsPageProps = {
    settings: AppSettings
    onSettingsChange: (patch: Partial<AppSettings>) => void
}

export function OpeningsPage({ settings, onSettingsChange }: OpeningsPageProps) {
    const [paths, setPaths] = useState<GraymatterPaths | null>(null)
    const [whiteRepertoire, setWhiteRepertoire] = useState<ParsedRepertoire | null>(null)
    const [blackRepertoire, setBlackRepertoire] = useState<ParsedRepertoire | null>(null)
    const [parseError, setParseError] = useState<string | null>(null)
    const trainMode = settings.openingsTrainMode
    const [activeSide, setActiveSide] = useState<Side>('w')
    const [targetPath, setTargetPath] = useState<string[] | null>(null)
    const [status, setStatus] = useState('Loading repertoires…')
    const [sessionResetKey, setSessionResetKey] = useState(0)
    const [lessonKey, setLessonKey] = useState(0)
    const [trainingRevision, setTrainingRevision] = useState(0)
    const [ready, setReady] = useState(false)
    const [linesFinished, setLinesFinished] = useState(0)
    const [hintTrigger, setHintTrigger] = useState(0)
    // needsPractice flags are mutated in place on the trie; bump this to re-render the lines-left count.
    const [, setProgressTick] = useState(0)

    const trainingDepth = Math.min(
        MAX_TRAINING_DEPTH,
        Math.max(MIN_TRAINING_DEPTH, settings.trainingDepth),
    )

    // Dragging the slider only moves this draft; the depth is saved when the thumb is released.
    const [depthDraft, setDepthDraft] = useState(trainingDepth)
    useEffect(() => {
        setDepthDraft(trainingDepth)
    }, [trainingDepth])
    const commitDepth = (value: number) => {
        if (value !== trainingDepth) onSettingsChange({ trainingDepth: value })
    }

    const whiteRef = useRef<ParsedRepertoire | null>(null)
    const blackRef = useRef<ParsedRepertoire | null>(null)
    const pathsRef = useRef<GraymatterPaths | null>(null)
    const targetPathRef = useRef<string[] | null>(null)
    const trainingDepthRef = useRef(trainingDepth)
    const historySansRef = useRef<string[]>([])
    const saveChainRef = useRef(Promise.resolve())

    whiteRef.current = whiteRepertoire
    blackRef.current = blackRepertoire
    pathsRef.current = paths
    targetPathRef.current = targetPath
    trainingDepthRef.current = trainingDepth

    const activeRepertoire =
        activeSide === 'w' ? whiteRepertoire : blackRepertoire

    const whiteLinesLeft = trainMode !== 'black' && whiteRepertoire
        ? collectPracticeTerminalPaths(whiteRepertoire.root, 'w', trainingDepth).length
        : 0
    const blackLinesLeft = trainMode !== 'white' && blackRepertoire
        ? collectPracticeTerminalPaths(blackRepertoire.root, 'b', trainingDepth).length
        : 0
    const linesLeftText = trainMode === 'both'
        ? `Lines left: ${whiteLinesLeft + blackLinesLeft} (White ${whiteLinesLeft}, Black ${blackLinesLeft})`
        : `Lines left: ${trainMode === 'white' ? whiteLinesLeft : blackLinesLeft}`
    const progressText = `${linesLeftText} · Finished this session: ${linesFinished}`

    const persistTraining = useCallback(() => {
        const currentPaths = pathsRef.current
        const white = whiteRef.current
        const black = blackRef.current
        if (!currentPaths || !white || !black) return

        const payload = serializeDualTrainingStatus(white.root, black.root)
        const text = JSON.stringify(payload, null, 4)
        saveChainRef.current = saveChainRef.current
            .then(() => window.graymatter.writeTextFile(currentPaths.trainingStatus, text))
            .catch((err: unknown) => {
                console.error('Failed to save training status', err)
                setParseError('Could not save TrainingStatus.json.')
            })
    }, [])

    const onStatusChange = useCallback((nextStatus: string) => {
        setStatus(nextStatus)
    }, [])

    const onTrainingChanged = useCallback(() => {
        persistTraining()
        setProgressTick((tick) => tick + 1)
    }, [persistTraining])

    const beginLesson = useCallback((
        mode: TrainMode,
        white: ParsedRepertoire | null,
        black: ParsedRepertoire | null,
        opts?: { resetSession?: boolean },
    ) => {
        // Read depth from a ref so this callback stays stable: a depth change must not restart
        // the lesson by itself (see the depth-change effect below).
        const trainingDepth = trainingDepthRef.current
        const side = pickActiveSide(mode, white, black, trainingDepth)
        if (!side) return

        const rep = side === 'w' ? white : black
        if (!rep || !modeHasPracticeRemaining(mode, white, black, trainingDepth)) {
            setActiveSide(side)
            setTargetPath(null)
            setStatus('All lines practiced. Reset training progress to start over.')
            return
        }

        const path = pickRandomPracticePath(rep.root, side, trainingDepth)
        if (!path) {
            setActiveSide(side)
            setTargetPath(null)
            setStatus('All lines practiced. Reset training progress to start over.')
            return
        }

        setActiveSide(side)
        setTargetPath(path)
        if (opts?.resetSession) setSessionResetKey((key) => key + 1)
        setLessonKey((key) => key + 1)
    }, [])

    const onLessonComplete = useCallback(() => {
        if (targetPathRef.current) setLinesFinished((count) => count + 1)
        beginLesson(trainMode, whiteRef.current, blackRef.current)
    }, [beginLesson, trainMode])

    // Start a fresh line once repertoires are ready, and again whenever the mode changes.
    useEffect(() => {
        if (!ready) return
        beginLesson(trainMode, whiteRef.current, blackRef.current, { resetSession: true })
    }, [beginLesson, ready, trainMode])

    // On a depth change, keep the current position unless the trainee has already made as many
    // moves as the new depth allows; then start a new line.
    const appliedDepthRef = useRef<number | null>(null)
    useEffect(() => {
        if (!ready) return
        if (appliedDepthRef.current === null || appliedDepthRef.current === trainingDepth) {
            // First lesson is started by the effect above.
            appliedDepthRef.current = trainingDepth
            return
        }
        appliedDepthRef.current = trainingDepth

        const rep = activeSide === 'w' ? whiteRef.current : blackRef.current
        const current = targetPathRef.current
        const history = historySansRef.current
        if (!rep || !current || countPlayerMoves(history, activeSide) >= trainingDepth) {
            beginLesson(trainMode, whiteRef.current, blackRef.current)
            return
        }

        // Continue along a practice line at the new depth that passes through this position. If
        // none does, nothing is left to practice here at this depth, so move on to a new line.
        const continuing = collectPracticeTerminalPaths(rep.root, activeSide, trainingDepth)
            .filter((path) => history.every((san, i) => path[i] === san))
        if (!continuing.length) {
            beginLesson(trainMode, whiteRef.current, blackRef.current)
            return
        }
        setTargetPath(continuing[Math.floor(Math.random() * continuing.length)]!)
    }, [activeSide, beginLesson, ready, trainMode, trainingDepth])

    const onTrainModeChange = (mode: TrainMode) => {
        onSettingsChange({ openingsTrainMode: mode })
    }

    const resetTrainingProgress = () => {
        if (whiteRepertoire) resetNeedsPractice(whiteRepertoire.root)
        if (blackRepertoire) resetNeedsPractice(blackRepertoire.root)
        persistTraining()
        setTrainingRevision((revision) => revision + 1)
        setLinesFinished(0)
        beginLesson(trainMode, whiteRepertoire, blackRepertoire, { resetSession: true })
    }

    useEffect(() => {
        let cancelled = false

        void (async () => {
            try {
                if (!window.graymatter) {
                    setParseError('GrayMatter file API is unavailable. Run this app in Electron.')
                    return
                }

                const resolvedPaths = await window.graymatter.getPaths()
                if (cancelled) return
                setPaths(resolvedPaths)

                const [whiteText, blackText] = await Promise.all([
                    window.graymatter.readTextFile(resolvedPaths.whitePgn),
                    window.graymatter.readTextFile(resolvedPaths.blackPgn),
                ])
                if (cancelled) return

                const whiteParsed = parsePgnToRepertoire(whiteText)
                const blackParsed = parsePgnToRepertoire(blackText)

                if ('error' in whiteParsed) {
                    setParseError(`White PGN: ${whiteParsed.error ?? 'Could not parse.'}`)
                    return
                }
                if ('error' in blackParsed) {
                    setParseError(`Black PGN: ${blackParsed.error ?? 'Could not parse.'}`)
                    return
                }

                try {
                    const trainingText = await window.graymatter.readTextFile(
                        resolvedPaths.trainingStatus,
                    )
                    const training = parseTrainingFileJson(trainingText)
                    if (!('error' in training)) {
                        applyDualTrainingStatus(
                            whiteParsed.root,
                            blackParsed.root,
                            training,
                        )
                    }
                }
                catch {
                    // No training file yet — start with needsPractice defaults.
                }

                if (cancelled) return

                setWhiteRepertoire(whiteParsed)
                setBlackRepertoire(blackParsed)
                setParseError(null)
                logRepertoireTreeDfs(whiteParsed.root)
                logRepertoireTreeDfs(blackParsed.root)
                setReady(true)
            }
            catch (err) {
                if (cancelled) return
                const message = err instanceof Error ? err.message : String(err)
                setParseError(`Could not load repertoire files: ${message}`)
            }
        })()

        return () => {
            cancelled = true
        }
    }, [])

    return (
        <div className="mx-auto flex max-w-5xl flex-col gap-8 px-4 py-10 md:flex-row md:items-start">
            <section className="flex-1 space-y-5">
                <header>
                    <p className="mt-2 text-sm leading-relaxed text-slate-400">
                        White and black repertoires load automatically from Google Drive.
                        Progress is saved to TrainingStatus.json after each practiced move. Choose
                        Both to alternate randomly between the two books, or lock training to
                        one side. Only lines with unpracticed moves for your side are selected.
                    </p>
                </header>

                <div className="space-y-3 rounded-xl border border-slate-700/80 bg-slate-900/50 p-4">
                    <fieldset className="space-y-2">
                        <legend className="text-sm font-medium text-slate-200">Repertoire</legend>
                        <div className="space-y-2 pl-4">
                            <div className="flex flex-wrap gap-4">
                                <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-200">
                                    <input
                                        type="radio"
                                        name="train"
                                        checked={trainMode === 'both'}
                                        onChange={() => onTrainModeChange('both')}
                                        className="accent-amber-500"
                                    />
                                    Both
                                </label>
                                <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-200">
                                    <input
                                        type="radio"
                                        name="train"
                                        checked={trainMode === 'white'}
                                        onChange={() => onTrainModeChange('white')}
                                        className="accent-amber-500"
                                    />
                                    White
                                </label>
                                <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-200">
                                    <input
                                        type="radio"
                                        name="train"
                                        checked={trainMode === 'black'}
                                        onChange={() => onTrainModeChange('black')}
                                        className="accent-amber-500"
                                    />
                                    Black
                                </label>
                            </div>
                            <p className="text-xs text-slate-500">
                                Which opening repertoire to train.
                            </p>
                        </div>
                    </fieldset>
                    <div className="space-y-1 border-t border-slate-700/60 pt-3">
                        <div className="flex items-center justify-between">
                            <span className="text-sm font-medium text-slate-200">Training depth</span>
                            <span className="rounded-md bg-amber-500/15 px-2 py-0.5 font-mono text-sm text-amber-200">
                                {depthDraft} moves
                            </span>
                        </div>
                        <div className="pl-4">
                            <DepthSlider
                                value={depthDraft}
                                min={MIN_TRAINING_DEPTH}
                                max={MAX_TRAINING_DEPTH}
                                onDraftChange={setDepthDraft}
                                onCommit={commitDepth}
                            />
                            <p className="mt-1 text-xs text-slate-500">
                                How many of your moves to train on each line before moving to the next.
                            </p>
                        </div>
                    </div>
                </div>

                <div className="flex flex-wrap gap-2">
                    <button
                        type="button"
                        onClick={() => setHintTrigger((trigger) => trigger + 1)}
                        disabled={!ready || !targetPath}
                        className="rounded-lg border border-slate-600 px-3 py-1.5 text-sm text-slate-200 transition enabled:hover:border-emerald-500/60 enabled:hover:text-emerald-100 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                        Hint
                    </button>
                    <button
                        type="button"
                        onClick={resetTrainingProgress}
                        disabled={!ready}
                        className="rounded-lg border border-slate-600 px-3 py-1.5 text-sm text-slate-200 transition enabled:hover:border-amber-500/60 enabled:hover:text-amber-100 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                        Reset training progress
                    </button>
                </div>

                {parseError && (
                    <p className="rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-200">
                        {parseError}
                    </p>
                )}
            </section>

            <div className="w-full max-w-[min(100%,28rem)] shrink-0 space-y-2 self-center md:self-start">
                <div className="board-panel">
                    <TrainerChessboard
                        root={ready ? (activeRepertoire?.root ?? null) : null}
                        progressText={progressText}
                        playerSide={activeSide}
                        targetPath={targetPath}
                        trainingDepth={trainingDepth}
                        sessionResetKey={sessionResetKey}
                        lessonKey={lessonKey}
                        trainingRevision={trainingRevision}
                        hintTrigger={hintTrigger}
                        historySansRef={historySansRef}
                        onStatusChange={onStatusChange}
                        onLessonComplete={onLessonComplete}
                        onTrainingChanged={onTrainingChanged}
                    />
                </div>
                <p className="font-mono text-xs text-slate-500">{status}</p>
            </div>
        </div>
    )
}

