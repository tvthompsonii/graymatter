import type { Square } from 'chess.js'
import { Chess } from 'chess.js'
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { Chessboard } from 'react-chessboard'
import type {
    PieceDropHandlerArgs,
    PieceHandlerArgs,
    SquareHandlerArgs,
} from 'react-chessboard'

import { boardChrome, customPieces, MOVE_ANIMATION_MS } from './boardTheme'
import { Button } from './ui/controls'
import { BotIcon, PlusIcon } from './ui/icons'
import { BoardPage, Card, PanelHeader, Section, SideMarker, StatusBanner } from './ui/layout'

function wait(ms: number): Promise<void> {
    return new Promise((resolve) => window.setTimeout(resolve, ms))
}

const CAPTURE_PIECE_WEIGHT: Record<string, number> = {
    p: 1,
    n: 3,
    b: 3,
    r: 5,
    q: 9,
}

type VerboseMove = ReturnType<Chess['moves']>[number] & {
    from: string
    to: string
    piece: string
    captured?: string
    san: string
}

function pickRandom<T>(items: T[]): T {
    return items[Math.floor(Math.random() * items.length)]!
}

/** Prefer captures (lowest-value capturing piece), then checks, then random. */
function pickBlackMove(game: Chess, moves: VerboseMove[]): VerboseMove {
    const captures = moves.filter((move) => move.captured)
    if (captures.length) {
        const minWeight = Math.min(
            ...captures.map((move) => CAPTURE_PIECE_WEIGHT[move.piece] ?? Number.MAX_SAFE_INTEGER),
        )
        const candidates = captures.filter(
            (move) => (CAPTURE_PIECE_WEIGHT[move.piece] ?? Number.MAX_SAFE_INTEGER) === minWeight,
        )
        return pickRandom(candidates)
    }

    const checks = moves.filter((move) => {
        const copy = new Chess(game.fen())
        copy.move({ from: move.from, to: move.to, promotion: move.promotion })
        return copy.inCheck()
    })
    if (checks.length) return pickRandom(checks)

    return pickRandom(moves)
}

function findKingSquare(game: Chess, color: 'w' | 'b'): string | null {
    const board = game.board()
    for (let rank = 0; rank < 8; rank++) {
        for (let file = 0; file < 8; file++) {
            const piece = board[rank]?.[file]
            if (piece?.type === 'k' && piece.color === color) {
                return `${String.fromCharCode(97 + file)}${8 - rank}`
            }
        }
    }
    return null
}

/** Soft red disc behind a checkmated king (Lichess-style). */
const CHECKMATE_KING_STYLE: CSSProperties = {
    background:
        'radial-gradient(ellipse at center, rgba(235, 60, 60, 0.90) 0%, rgba(235, 60, 60, 0.75) 45%, transparent 70%)',
}


export type PlayStatus = {
    kind: 'your-move' | 'check' | 'bot' | 'checkmate' | 'draw'
    /** Set when kind is 'checkmate'. */
    winner?: 'w' | 'b'
    /** Set when kind is 'draw', e.g. "Stalemate". */
    reason?: string
    /** SAN moves played so far. */
    moves: string[]
}

function playStatusFor(game: Chess): PlayStatus {
    const moves = game.history()
    if (game.isCheckmate()) return { kind: 'checkmate', winner: game.turn() === 'w' ? 'b' : 'w', moves }
    if (game.isDraw() || game.isStalemate()) {
        const reason = game.isStalemate()
            ? 'Stalemate'
            : game.isInsufficientMaterial()
                ? 'Insufficient material'
                : game.isThreefoldRepetition() ? 'Threefold repetition' : 'Fifty-move rule'
        return { kind: 'draw', reason, moves }
    }
    if (game.turn() === 'b') return { kind: 'bot', moves }
    return { kind: game.inCheck() ? 'check' : 'your-move', moves }
}

type PlayChessboardProps = {
    boardId: string
    /** Called after every position change with the game state and move list. */
    onStatusChange?: (status: PlayStatus) => void
}

/** Simple board: White moves freely; Black replies with a simple heuristic. */
export function PlayChessboard({ boardId, onStatusChange }: PlayChessboardProps) {
    const gameRef = useRef(new Chess())
    const [fen, setFen] = useState(() => gameRef.current.fen())
    const onStatusChangeRef = useRef(onStatusChange)
    onStatusChangeRef.current = onStatusChange
    useEffect(() => {
        onStatusChangeRef.current?.(playStatusFor(gameRef.current))
    }, [fen])
    const [selectedSquare, setSelectedSquare] = useState<string | null>(null)
    const [optionSquares, setOptionSquares] = useState<Record<string, CSSProperties>>({})
    const [lastMoveSquares, setLastMoveSquares] = useState<{ from?: string; to?: string }>({})
    const busyRef = useRef(false)

    const clearSelection = useCallback(() => {
        setSelectedSquare(null)
        setOptionSquares({})
    }, [])

    const getMoveOptions = useCallback((square: Square) => {
        const moves = gameRef.current.moves({ square, verbose: true })
        if (moves.length === 0) {
            setOptionSquares({})
            return false
        }

        const newSquares: Record<string, CSSProperties> = {}
        for (const move of moves) {
            const target = gameRef.current.get(move.to)
            const source = gameRef.current.get(square)
            newSquares[move.to] = {
                background: target && target.color !== source?.color
                    ? 'radial-gradient(circle, transparent 70%, rgba(0,0,0,.1) 70%)'
                    : 'radial-gradient(circle, rgba(0,0,0,.1) 25%, transparent 25%)',
            }
        }
        setOptionSquares(newSquares)
        return true
    }, [])

    const playBlackMove = useCallback(async () => {
        const game = gameRef.current
        if (game.isGameOver() || game.turn() !== 'b') return

        const moves = game.moves({ verbose: true }) as VerboseMove[]
        if (!moves.length) return

        const pick = pickBlackMove(game, moves)
        game.move(pick)
        setFen(game.fen())
        setLastMoveSquares({ from: pick.from, to: pick.to })
        await wait(MOVE_ANIMATION_MS)
    }, [])

    const attemptWhiteMove = useCallback((
        sourceSquare: string,
        targetSquare: string | null,
    ): boolean => {
        if (busyRef.current || !targetSquare) return false
        if (sourceSquare === targetSquare) {
            clearSelection()
            return true
        }

        const game = gameRef.current
        if (game.turn() !== 'w') return false

        const piece = game.get(sourceSquare as Square)
        if (!piece || piece.color !== 'w') return false

        let move
        try {
            move = game.move({
                from: sourceSquare,
                to: targetSquare,
                promotion: 'q',
            })
        }
        catch {
            return false
        }
        if (!move) return false

        clearSelection()
        setFen(game.fen())
        setLastMoveSquares({ from: move.from, to: move.to })

        busyRef.current = true
        void (async () => {
            await wait(MOVE_ANIMATION_MS)
            await playBlackMove()
            busyRef.current = false
        })()

        return true
    }, [clearSelection, playBlackMove])

    const canDragPiece = useCallback(({ piece }: PieceHandlerArgs): boolean => {
        if (busyRef.current) return false
        return piece.pieceType[0] === 'w' && gameRef.current.turn() === 'w'
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
        clearSelection()
        return attemptWhiteMove(sourceSquare, targetSquare)
    }, [attemptWhiteMove, clearSelection])

    const onSquareClick = useCallback(({ piece, square }: SquareHandlerArgs) => {
        if (busyRef.current) return

        if (!selectedSquare) {
            if (piece?.pieceType[0] === 'w' && gameRef.current.turn() === 'w') {
                if (getMoveOptions(square as Square)) setSelectedSquare(square)
                else clearSelection()
            }
            return
        }

        if (selectedSquare === square) {
            clearSelection()
            return
        }

        if (!attemptWhiteMove(selectedSquare, square)) {
            if (piece?.pieceType[0] === 'w' && gameRef.current.turn() === 'w') {
                if (getMoveOptions(square as Square)) setSelectedSquare(square)
                else clearSelection()
            }
            else clearSelection()
        }
    }, [attemptWhiteMove, clearSelection, getMoveOptions, selectedSquare])

    const checkmateKingSquare = gameRef.current.isCheckmate()
        ? findKingSquare(gameRef.current, gameRef.current.turn())
        : null

    const highlights = {
        ...optionSquares,
        ...(lastMoveSquares.from && {
            [lastMoveSquares.from]: { backgroundColor: 'rgba(179, 197, 18, 0.4)' },
        }),
        ...(lastMoveSquares.to && {
            [lastMoveSquares.to]: { backgroundColor: 'rgba(179, 197, 18, 0.4)' },
        }),
        ...(selectedSquare && {
            [selectedSquare]: { boxShadow: 'inset 0 0 0 4px rgba(245, 158, 11, 0.75)' },
        }),
        ...(checkmateKingSquare && {
            [checkmateKingSquare]: CHECKMATE_KING_STYLE,
        }),
    }

    return (
        <Chessboard
            options={{
                id: boardId,
                position: fen,
                boardOrientation: 'white',
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

function PlayStatusBanner({ status }: { status: PlayStatus }) {
    switch (status.kind) {
        case 'checkmate':
            return status.winner === 'w'
                ? <StatusBanner tone="success" title="Checkmate" text="You win" />
                : <StatusBanner tone="error" title="Checkmate" text="The bot wins" />
        case 'draw':
            return <StatusBanner tone="info" title="Draw" text={status.reason} />
        case 'bot':
            return <StatusBanner title="Bot is thinking" marker={<SideMarker side="b" />} />
        case 'check':
            return <StatusBanner tone="error" title="Check" text="Your move" marker={<SideMarker side="w" />} />
        default:
            return <StatusBanner title="Your move" text="You play White" marker={<SideMarker side="w" />} />
    }
}

function MoveList({ moves }: { moves: string[] }) {
    const listRef = useRef<HTMLOListElement>(null)
    useEffect(() => {
        const list = listRef.current
        if (list) list.scrollTop = list.scrollHeight
    }, [moves.length])

    const rows: Array<[string, string | undefined]> = []
    for (let i = 0; i < moves.length; i += 2) rows.push([moves[i]!, moves[i + 1]])
    const last = moves.length - 1

    return (
        <ol
            ref={listRef}
            className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto rounded-[10px] border border-line bg-rail p-1.5 font-mono text-[13px]"
        >
            {rows.length === 0 && <li className="px-1.5 py-1 text-dim">No moves yet.</li>}
            {rows.map(([white, black], row) => (
                <li
                    key={row}
                    className={`grid grid-cols-[2rem_1fr_1fr] rounded-md px-1.5 py-1 ${
                        Math.floor(last / 2) === row ? 'bg-raised' : ''
                    }`}
                >
                    <span className="text-dim">{row + 1}.</span>
                    <span className={row * 2 === last ? 'font-semibold text-accent-ink' : 'text-body'}>{white}</span>
                    <span className={row * 2 + 1 === last ? 'font-semibold text-accent-ink' : 'text-body'}>{black ?? ''}</span>
                </li>
            ))}
        </ol>
    )
}

export function PlayPage() {
    const [gameKey, setGameKey] = useState(0)
    const [status, setStatus] = useState<PlayStatus>({ kind: 'your-move', moves: [] })

    const startNewGame = () => {
        setGameKey((key) => key + 1)
    }

    return (
        <BoardPage
            label="Game controls"
            board={(
                <div className="board-panel">
                    <PlayChessboard key={gameKey} boardId="PlayBoard" onStatusChange={setStatus} />
                </div>
            )}
        >
            <PanelHeader title="Play" subtitle="A casual game against a simple bot." />

            <Card row>
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] border border-line-strong bg-rail text-soft">
                    <BotIcon size={18} />
                </span>
                <div className="min-w-0">
                    <div className="text-sm font-semibold text-ink">Bot · Black</div>
                    <div className="text-xs text-muted">Looks for captures first, then checks, else plays a random move.</div>
                </div>
            </Card>

            <PlayStatusBanner status={status} />

            <Section label="Moves" className="min-h-0 flex-1">
                <MoveList moves={status.moves} />
            </Section>

            <Button variant="primary" icon={<PlusIcon strokeWidth={2.4} />} onClick={startNewGame}>
                New game
            </Button>
        </BoardPage>
    )
}

