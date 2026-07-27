import type { Square } from 'chess.js'
import { Chess } from 'chess.js'
import { useCallback, useRef, useState, type CSSProperties } from 'react'
import { Chessboard } from 'react-chessboard'
import type {
    PieceDropHandlerArgs,
    PieceHandlerArgs,
    SquareHandlerArgs,
} from 'react-chessboard'

import { APP_VERSION } from './appVersion'
import { boardChrome, customPieces, MOVE_ANIMATION_MS } from './boardTheme'

function wait(ms: number): Promise<void> {
    return new Promise((resolve) => window.setTimeout(resolve, ms))
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


type PlayChessboardProps = {
    boardId: string
}

/** Simple board: White moves freely; Black replies with a random legal move. */
export function PlayChessboard({ boardId }: PlayChessboardProps) {
    const gameRef = useRef(new Chess())
    const [fen, setFen] = useState(() => gameRef.current.fen())
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

    const playBlackRandom = useCallback(async () => {
        const game = gameRef.current
        if (game.isGameOver() || game.turn() !== 'b') return

        const moves = game.moves({ verbose: true })
        if (!moves.length) return

        const pick = moves[Math.floor(Math.random() * moves.length)]!
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
            await playBlackRandom()
            busyRef.current = false
        })()

        return true
    }, [clearSelection, playBlackRandom])

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

export function PlayPage() {
    const [gameKey, setGameKey] = useState(0)

    const startNewGame = () => {
        setGameKey((key) => key + 1)
    }

    return (
        <div className="mx-auto flex max-w-5xl flex-col gap-8 px-4 py-10 md:flex-row md:items-start">
            <section className="flex-1 space-y-5">
                <header>
                    <p className="mt-2 text-sm leading-relaxed text-slate-400">
                        Play against a bot. Engine strength and openings will come later; for now you
                        move White and Black answers with a random legal move.
                    </p>
                    <p className="mt-2 font-mono text-xs text-slate-500">
                        Version {APP_VERSION}
                    </p>
                </header>

                <div className="flex flex-wrap gap-2">
                    <button
                        type="button"
                        onClick={startNewGame}
                        className="rounded-lg border border-slate-600 px-3 py-1.5 text-sm text-slate-200 transition enabled:hover:border-amber-500/60 enabled:hover:text-amber-100 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                        New Game
                    </button>
                </div>

                <p className="rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2 text-sm text-slate-300">
                    Your move as White.
                </p>
            </section>

            <div className="board-panel w-full max-w-[min(100%,28rem)] shrink-0 self-center md:self-start">
                <PlayChessboard key={gameKey} boardId="PlayBoard" />
            </div>
        </div>
    )
}

