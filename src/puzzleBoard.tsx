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
import type { Puzzle } from './puzzleCsv'

function wait(ms: number): Promise<void> {
    return new Promise((resolve) => window.setTimeout(resolve, ms))
}

type UciMove = {
    from: Square
    to: Square
    promotion?: 'q' | 'r' | 'b' | 'n'
}

function parseUci(uci: string): UciMove | null {
    if (uci.length < 4) return null
    const from = uci.slice(0, 2) as Square
    const to = uci.slice(2, 4) as Square
    const promo = uci.length > 4 ? uci[4] : undefined
    if (promo && !['q', 'r', 'b', 'n'].includes(promo)) return null
    return {
        from,
        to,
        promotion: promo as UciMove['promotion'],
    }
}

function uciMatchesMove(uci: string, move: { from: string; to: string; promotion?: string }): boolean {
    const parsed = parseUci(uci)
    if (!parsed) return false
    if (parsed.from !== move.from || parsed.to !== move.to) return false
    if (parsed.promotion) return parsed.promotion === move.promotion
    return !move.promotion
}

function applyUci(game: Chess, uci: string): boolean {
    const parsed = parseUci(uci)
    if (!parsed) return false
    try {
        const move = game.move(
            parsed.promotion
                ? { from: parsed.from, to: parsed.to, promotion: parsed.promotion }
                : { from: parsed.from, to: parsed.to },
            { strict: false },
        )
        return !!move
    }
    catch {
        return false
    }
}

/** Player color is whoever moves after the opponent's setup move. */
export function playerColorForPuzzle(puzzle: Puzzle): 'w' | 'b' {
    const game = new Chess(puzzle.fen)
    const first = parseUci(puzzle.moves[0]!)
    if (!first) return 'w'
    applyUci(game, puzzle.moves[0]!)
    return game.turn()
}

type PuzzleChessboardProps = {
    puzzle: Puzzle
    onSolved: () => void
    onStatusChange?: (status: string) => void
}

export function PuzzleChessboard({
    puzzle,
    onSolved,
    onStatusChange,
}: PuzzleChessboardProps) {
    const playerColor = playerColorForPuzzle(puzzle)
    const gameRef = useRef(new Chess())
    const moveIndexRef = useRef(0)
    const runIdRef = useRef(0)
    const busyRef = useRef(false)
    const onSolvedRef = useRef(onSolved)
    onSolvedRef.current = onSolved

    const [fen, setFen] = useState(() => new Chess().fen())
    const [boardKey, setBoardKey] = useState(0)
    const [selectedSquare, setSelectedSquare] = useState<string | null>(null)
    const [optionSquares, setOptionSquares] = useState<Record<string, CSSProperties>>({})
    const [lastMoveSquares, setLastMoveSquares] = useState<{ from?: string; to?: string }>({})

    const clearSelection = useCallback(() => {
        setSelectedSquare(null)
        setOptionSquares({})
    }, [])

    const syncBoard = useCallback((game: Chess, last?: { from: string; to: string }) => {
        setFen(game.fen())
        if (last) setLastMoveSquares(last)
    }, [])

    const playComputerUci = useCallback(async (
        uci: string,
        runId: number,
    ): Promise<boolean> => {
        const parsed = parseUci(uci)
        if (!parsed) return false
        try {
            const move = gameRef.current.move(
                parsed.promotion
                    ? { from: parsed.from, to: parsed.to, promotion: parsed.promotion }
                    : { from: parsed.from, to: parsed.to },
                { strict: false },
            )
            if (!move) return false
            moveIndexRef.current++
            syncBoard(gameRef.current, { from: move.from, to: move.to })
            await wait(MOVE_ANIMATION_MS)
            return runId === runIdRef.current
        }
        catch {
            return false
        }
    }, [syncBoard])

    const finishPuzzle = useCallback(async (runId: number) => {
        onStatusChange?.('Correct! Next puzzle…')
        await wait(1000)
        if (runId === runIdRef.current) onSolvedRef.current()
    }, [onStatusChange])

    const continueAfterPlayerMove = useCallback(async (runId: number) => {
        const { moves } = puzzle
        while (moveIndexRef.current < moves.length) {
            const nextUci = moves[moveIndexRef.current]!
            if (gameRef.current.turn() !== playerColor) {
                if (!(await playComputerUci(nextUci, runId))) return
                continue
            }
            onStatusChange?.('Your move — find the best continuation.')
            return
        }
        busyRef.current = false
        await finishPuzzle(runId)
    }, [finishPuzzle, onStatusChange, playComputerUci, playerColor, puzzle])

    const startPuzzle = useCallback(async () => {
        const runId = ++runIdRef.current
        busyRef.current = true
        clearSelection()
        setLastMoveSquares({})

        gameRef.current = new Chess(puzzle.fen)
        moveIndexRef.current = 0
        syncBoard(gameRef.current)
        setBoardKey((key) => key + 1)

        onStatusChange?.('Loading puzzle…')

        if (!puzzle.moves.length) {
            busyRef.current = false
            onStatusChange?.('Invalid puzzle — no moves.')
            return
        }

        if (!(await playComputerUci(puzzle.moves[0]!, runId))) {
            busyRef.current = false
            return
        }

        busyRef.current = false
        await continueAfterPlayerMove(runId)
    }, [clearSelection, continueAfterPlayerMove, onStatusChange, playComputerUci, puzzle, syncBoard])

    useEffect(() => {
        void startPuzzle()
    }, [startPuzzle])

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

    const attemptPlayerMove = useCallback((
        sourceSquare: string,
        targetSquare: string | null,
    ): boolean => {
        if (busyRef.current || !targetSquare) return false
        if (sourceSquare === targetSquare) {
            clearSelection()
            return true
        }

        const game = gameRef.current
        if (game.turn() !== playerColor) return false

        const piece = game.get(sourceSquare as Square)
        if (!piece || piece.color !== playerColor) return false

        const fenBefore = game.fen()
        const expectedUci = puzzle.moves[moveIndexRef.current]

        let move
        try {
            move = game.move(
                { from: sourceSquare, to: targetSquare, promotion: 'q' },
                { strict: false },
            )
        }
        catch {
            return false
        }
        if (!move) return false

        const isCorrect = expectedUci ? uciMatchesMove(expectedUci, move) : false
        const isMate = game.isCheckmate()

        if (!isCorrect && !isMate) {
            game.load(fenBefore)
            clearSelection()
            syncBoard(game)
            onStatusChange?.('Not the best move — try again.')
            return false
        }

        moveIndexRef.current++
        clearSelection()
        syncBoard(game, { from: move.from, to: move.to })

        const runId = runIdRef.current
        busyRef.current = true
        void (async () => {
            await wait(MOVE_ANIMATION_MS)
            if (runId !== runIdRef.current) return
            await continueAfterPlayerMove(runId)
            busyRef.current = false
        })()

        return true
    }, [
        clearSelection,
        continueAfterPlayerMove,
        onStatusChange,
        playerColor,
        puzzle.moves,
        syncBoard,
    ])

    const canDragPiece = useCallback(({ piece }: PieceHandlerArgs): boolean => {
        if (busyRef.current) return false
        return piece.pieceType[0] === playerColor && gameRef.current.turn() === playerColor
    }, [playerColor])

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
        return attemptPlayerMove(sourceSquare, targetSquare)
    }, [attemptPlayerMove, clearSelection])

    const onSquareClick = useCallback(({ piece, square }: SquareHandlerArgs) => {
        if (busyRef.current) return

        if (!selectedSquare) {
            if (piece?.pieceType[0] === playerColor && gameRef.current.turn() === playerColor) {
                if (getMoveOptions(square as Square)) setSelectedSquare(square)
                else clearSelection()
            }
            return
        }

        if (selectedSquare === square) {
            clearSelection()
            return
        }

        if (!attemptPlayerMove(selectedSquare, square)) {
            if (piece?.pieceType[0] === playerColor && gameRef.current.turn() === playerColor) {
                if (getMoveOptions(square as Square)) setSelectedSquare(square)
                else clearSelection()
            }
            else clearSelection()
        }
    }, [attemptPlayerMove, clearSelection, getMoveOptions, playerColor, selectedSquare])

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
            key={boardKey}
            options={{
                id: 'PuzzlesBoard',
                position: fen,
                boardOrientation: playerColor === 'w' ? 'white' : 'black',
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
