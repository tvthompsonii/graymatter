import type { Square } from 'chess.js'
import { Chess, type Move } from 'chess.js'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Chessboard } from 'react-chessboard'
import type {
    PieceDropHandlerArgs,
    PieceHandlerArgs,
    SquareHandlerArgs,
} from 'react-chessboard'

import { APP_VERSION } from './appVersion'
import { boardChrome, customPieces, MOVE_ANIMATION_MS } from './boardTheme'
import type { GraymatterPaths } from './graymatter'
import {
    canonicalPathKey,
    countPlayerMoves,
    fenSig,
    legalChildSans,
    logRepertoireTreeDfs,
    pickRandomPracticePath,
    resetNeedsPractice,
    treeHasPracticeRemaining,
    walkToNode,
    type Node,
} from './moveTree'
import { parsePgnToRepertoire, type ParsedRepertoire } from './pgnPaths'
import {
    applyDualTrainingStatus,
    parseTrainingFileJson,
    serializeDualTrainingStatus,
} from './trainingExport'

export type Side = 'w' | 'b'
export type TrainMode = 'both' | 'white' | 'black'

export type TrainerChessboardProps = {
    root: Node | null
    terminalLineCount: number
    terminalPathKeys: ReadonlySet<string>
    playerSide: Side
    /** Exact SAN path for the current drill line; null when nothing left to practice. */
    targetPath: readonly string[] | null
    trainingDepth: number
    sessionResetKey: number
    lessonKey: number
    trainingRevision: number
    onStatusChange: (status: string) => void
    onLessonComplete: () => void
    onTrainingChanged: () => void
}

const EMPTY_PATH_KEYS: ReadonlySet<string> = new Set()

function wait(ms: number): Promise<void> {
    return new Promise((resolve) => window.setTimeout(resolve, ms))
}

function normalizeSan(san: string): string {
    return san.replace(/[+#]+$/, '').trim()
}

function describeDragAttempt(game: Chess, from: Square, to: Square): string | null {
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
            if (move) return move.san
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
    terminalLineCount,
    terminalPathKeys,
    playerSide,
    targetPath,
    trainingDepth,
    sessionResetKey,
    lessonKey,
    trainingRevision,
    onStatusChange,
    onLessonComplete,
    onTrainingChanged,
}: TrainerChessboardProps) {
    const gameRef = useRef(new Chess())
    const historySansRef = useRef<string[]>([])
    const completedPathKeysRef = useRef(new Set<string>())
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

    const rebuildStatus = useCallback(() => {
        const done = completedPathKeysRef.current.size
        const sideLabel = playerSide === 'w' ? 'White' : 'Black'
        if (!root) {
            onStatusChange('Loading repertoires…')
        }
        else if (!targetPath) {
            onStatusChange('All lines practiced. Reset training progress to start over.')
        }
        else {
            onStatusChange(
                `Training ${sideLabel}. Session lines: ${done}/${terminalLineCount}. Drag when it is your move.`,
            )
        }
    }, [onStatusChange, playerSide, root, targetPath, terminalLineCount])

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

    const tryMarkLeafCompleted = useCallback((): boolean => {
        if (!root) return false
        const history = historySansRef.current
        const pathKey = canonicalPathKey(history)
        const alreadyCompleted = completedPathKeysRef.current.has(pathKey)
        const node = walkToNode(root, history)

        if (
            node
            && node.children.size === 0
            && (!terminalPathKeys.size || terminalPathKeys.has(pathKey))
        ) {
            completedPathKeysRef.current.add(pathKey)
            node.needsPractice = false
            onTrainingChangedRef.current()
            rebuildStatus()
            return !alreadyCompleted
        }

        rebuildStatus()
        return false
    }, [rebuildStatus, root, terminalPathKeys])

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
        setSelectedSquare(null)
        setLastMoveSquares({})
        setOptionSquares({})

        if (root && playerSide === 'b') {
            const first = targetPath?.[0]
                ?? legalChildSans(gameRef.current, root).sort()[0]
            if (first) {
                gameRef.current.move(first, { strict: false })
                historySansRef.current.push(first)
            }
        }

        setFen(gameRef.current.fen())
        setBoardKey((key) => key + 1)
        rebuildStatus()

        if (animateFirstMove && playerSide === 'b')
            await wait(MOVE_ANIMATION_MS)

        return runId
    }, [playerSide, rebuildStatus, root, targetPath])

    const settleAfterChange = useCallback(async () => {
        if (!root || settlingRef.current) return
        const runId = runIdRef.current
        settlingRef.current = true

        try {
            while (runId === runIdRef.current) {
                tryMarkLeafCompleted()
                const history = historySansRef.current

                if (countPlayerMoves(history, playerSide) >= trainingDepth) {
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

            tryMarkLeafCompleted()
            const endHistory = historySansRef.current
            if (countPlayerMoves(endHistory, playerSide) >= trainingDepth) {
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
        trainingDepth,
        tryMarkLeafCompleted,
    ])

    useEffect(() => {
        const rootChanged = previousRootRef.current !== root
        const sessionWasReset =
            previousSessionResetKeyRef.current !== sessionResetKey
        previousRootRef.current = root
        previousSessionResetKeyRef.current = sessionResetKey
        if (rootChanged || sessionWasReset) {
            completedPathKeysRef.current = new Set()
            branchDrillsRef.current = new Map()
        }

        void (async () => {
            await startLesson(false)
            await settleAfterChange()
        })()
    }, [playerSide, root, sessionResetKey, lessonKey, startLesson, settleAfterChange])

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

    const canDragPiece = useCallback(({ piece }: PieceHandlerArgs): boolean => {
        if (piece.pieceType[0] !== playerSide) return false
        return legalPlayerSansNeedingPractice().length > 0
    }, [legalPlayerSansNeedingPractice, playerSide])

    const attemptPlayerMove = useCallback((
        sourceSquare: string,
        targetSquare: string | null,
    ): boolean => {
        if (!root || !targetSquare) return false
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
            const attempt = describeDragAttempt(game, from, to)
            window.alert(
                attempt
                    ? `That move is not in the repertoire here.\nPlayed: ${attempt}\nAllowed: ${allowed.join(', ')}`
                    : `Illegal move.\nAllowed from the file: ${allowed.join(', ')}`,
            )
            return false
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

    // Combine options highlights, history highlights & selected-square highlight
    const highlights = {
        ...optionSquares,
        ...(lastMoveSquares.from && {
            [lastMoveSquares.from]: { backgroundColor: "rgba(179, 197, 18, 0.4)" }
        }),
        ...(lastMoveSquares.to && {
            [lastMoveSquares.to]: { backgroundColor: "rgba(179, 197, 18, 0.4)" }
        }),
        ...(selectedSquare && {
            [selectedSquare]: { boxShadow: 'inset 0 0 0 4px rgba(245, 158, 11, 0.75)' }
        }),
    };

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

export function OpeningsPage({ trainingDepth }: { trainingDepth: number }) {
    const [paths, setPaths] = useState<GraymatterPaths | null>(null)
    const [whiteRepertoire, setWhiteRepertoire] = useState<ParsedRepertoire | null>(null)
    const [blackRepertoire, setBlackRepertoire] = useState<ParsedRepertoire | null>(null)
    const [parseError, setParseError] = useState<string | null>(null)
    const [trainMode, setTrainMode] = useState<TrainMode>('both')
    const [activeSide, setActiveSide] = useState<Side>('w')
    const [targetPath, setTargetPath] = useState<string[] | null>(null)
    const [status, setStatus] = useState('Loading repertoires…')
    const [sessionResetKey, setSessionResetKey] = useState(0)
    const [lessonKey, setLessonKey] = useState(0)
    const [trainingRevision, setTrainingRevision] = useState(0)
    const [ready, setReady] = useState(false)

    const whiteRef = useRef<ParsedRepertoire | null>(null)
    const blackRef = useRef<ParsedRepertoire | null>(null)
    const pathsRef = useRef<GraymatterPaths | null>(null)
    const saveChainRef = useRef(Promise.resolve())

    whiteRef.current = whiteRepertoire
    blackRef.current = blackRepertoire
    pathsRef.current = paths

    const activeRepertoire =
        activeSide === 'w' ? whiteRepertoire : blackRepertoire

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
    }, [persistTraining])

    const beginLesson = useCallback((
        mode: TrainMode,
        white: ParsedRepertoire | null,
        black: ParsedRepertoire | null,
        opts?: { resetSession?: boolean },
    ) => {
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
    }, [trainingDepth])

    const onLessonComplete = useCallback(() => {
        beginLesson(trainMode, whiteRef.current, blackRef.current)
    }, [beginLesson, trainMode])

    const onTrainModeChange = (mode: TrainMode) => {
        setTrainMode(mode)
        beginLesson(mode, whiteRef.current, blackRef.current, { resetSession: true })
    }

    const resetTrainingProgress = () => {
        if (whiteRepertoire) resetNeedsPractice(whiteRepertoire.root)
        if (blackRepertoire) resetNeedsPractice(blackRepertoire.root)
        persistTraining()
        setTrainingRevision((revision) => revision + 1)
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
                beginLesson('both', whiteParsed, blackParsed)
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
    }, [beginLesson])

    return (
        <div className="mx-auto flex max-w-5xl flex-col gap-8 px-4 py-10 md:flex-row md:items-start">
            <section className="flex-1 space-y-5">
                <header>
                    <p className="mt-2 text-sm leading-relaxed text-slate-400">
                        White and black repertoires load automatically from Documents/GrayMatter.
                        Progress is saved to TrainingStatus.json after each practiced move. Choose
                        Train Both to alternate randomly between the two books, or lock training to
                        one side. Only lines with unpracticed moves for your side are selected.
                    </p>
                    <p className="mt-2 font-mono text-xs text-slate-500">
                        Version {APP_VERSION}
                    </p>
                </header>

                <fieldset className="space-y-2 rounded-xl border border-slate-700/80 bg-slate-900/50 p-4">
                    <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Train
                    </legend>
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
                        Both picks the next unpracticed line at random from either repertoire. White
                        and Black only train that side&apos;s book.
                    </p>
                </fieldset>

                <div className="flex flex-wrap gap-2">
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

                <p className="rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2 text-sm text-slate-300">
                    {status}
                </p>
            </section>

            <div className="board-panel w-full max-w-[min(100%,28rem)] shrink-0 self-center md:self-start">
                <TrainerChessboard
                    root={ready ? (activeRepertoire?.root ?? null) : null}
                    terminalLineCount={activeRepertoire?.terminalLineCount ?? 0}
                    terminalPathKeys={activeRepertoire?.terminalPathKeys ?? EMPTY_PATH_KEYS}
                    playerSide={activeSide}
                    targetPath={targetPath}
                    trainingDepth={trainingDepth}
                    sessionResetKey={sessionResetKey}
                    lessonKey={lessonKey}
                    trainingRevision={trainingRevision}
                    onStatusChange={onStatusChange}
                    onLessonComplete={onLessonComplete}
                    onTrainingChanged={onTrainingChanged}
                />
            </div>
        </div>
    )
}

