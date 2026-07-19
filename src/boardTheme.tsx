import type { PieceRenderObject } from 'react-chessboard'

export const MOVE_ANIMATION_MS = 350

const PIECE_CODES = [
    'wK', 'wQ', 'wR', 'wB', 'wN', 'wP',
    'bK', 'bQ', 'bR', 'bB', 'bN', 'bP',
] as const

export const customPieces = Object.fromEntries(
    PIECE_CODES.map((piece) => [
        piece,
        () => (
            <img
                src={`/staunty/${piece}.svg`}
                alt={piece}
                draggable={false}
                style={{ width: '100%', height: '100%' }}
            />
        ),
    ]),
) as PieceRenderObject

export const boardChrome = {
    boardStyle: {
        borderRadius: '0.75rem',
        boxShadow: '0 25px 50px -12px rgba(0,0,0,0.65)',
    },
    darkSquareStyle: { backgroundColor: '#64748b' },
    lightSquareStyle: { backgroundColor: '#cbd5e1' },
} as const
