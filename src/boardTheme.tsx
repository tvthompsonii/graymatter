import type { CSSProperties } from 'react'
import type { PieceRenderObject } from 'react-chessboard'

export const MOVE_ANIMATION_MS = 350

/** How long a wrong move stays on the board (outlined in red) before it is taken back. */
export const WRONG_MOVE_DISPLAY_MS = 2000

/** Square outlines shared by the trainer and puzzle boards. */
export const SELECTED_SQUARE_STYLE: CSSProperties = { boxShadow: 'inset 0 0 0 4px rgba(245, 158, 11, 0.75)' }
export const HINT_SQUARE_STYLE: CSSProperties = { boxShadow: 'inset 0 0 0 4px rgba(34, 197, 94, 0.85)' }
export const WRONG_SQUARE_STYLE: CSSProperties = { boxShadow: 'inset 0 0 0 4px rgba(239, 68, 68, 0.9)' }

/**
 * Layer outlines over base square styles, later entries winning (e.g. hint < selection < wrong move).
 * Each outline merges into the square's existing style so it keeps any last-move tint.
 */
export function withSquareOutlines(
    base: Record<string, CSSProperties>,
    outlines: Array<[string | null, CSSProperties]>,
): Record<string, CSSProperties> {
    const styles = { ...base }
    for (const [square, style] of outlines) {
        if (square) styles[square] = { ...styles[square], ...style }
    }
    return styles
}

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
