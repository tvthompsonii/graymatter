import type { Square } from 'chess.js'
import { Chess } from 'chess.js'
import { useCallback, useRef, useState } from 'react'
import { Chessboard } from 'react-chessboard'
import type {
    PieceDropHandlerArgs,
    PieceHandlerArgs,
    SquareHandlerArgs,
} from 'react-chessboard'

import { boardChrome, customPieces, MOVE_ANIMATION_MS } from './boardTheme'

function wait(ms: number): Promise<void> {
    return new Promise((resolve) => window.setTimeout(resolve, ms))
}

type FreePlayChessboardProps = {
    boardId: string
}

/** Simple board: White moves freely; Black replies with a random legal move. */
export function FreePlayChessboard({ boardId }: FreePlayChessboardProps) {
    const gameRef = useRef(new Chess())
    const [fen, setFen] = useState(() => gameRef.current.fen())
    const [selectedSquare, setSelectedSquare] = useState<string | null>(null)
    const [optionSquares, setOptionSquares] = useState<Record<string, React.CSSProperties>>({})
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

        const newSquares: Record<string, React.CSSProperties> = {}
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
