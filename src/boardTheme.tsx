import type { Chess } from 'chess.js'
import type { CSSProperties } from 'react'
import type { PieceRenderObject } from 'react-chessboard'

export const MOVE_ANIMATION_MS = 350

/** How long a wrong move stays on the board (outlined in red) before it is taken back. */
export const WRONG_MOVE_DISPLAY_MS = 2000

/** How long the trainee's last correct move stays outlined in green before the drill moves on. */
export const CORRECT_MOVE_DISPLAY_MS = 2000

/** Square outlines shared by the trainer and puzzle boards. */
export const SELECTED_SQUARE_STYLE: CSSProperties = { boxShadow: 'inset 0 0 0 4px rgba(245, 158, 11, 0.75)' }
export const HINT_SQUARE_STYLE: CSSProperties = { boxShadow: 'inset 0 0 0 4px rgba(34, 197, 94, 0.85)' }
/** Arrow showing the answer the first time a new opening card comes up. */
export const SOLUTION_ARROW_COLOR = 'rgba(34, 197, 94, 0.85)'

export const WRONG_SQUARE_STYLE: CSSProperties = { boxShadow: 'inset 0 0 0 4px rgba(239, 68, 68, 0.9)' }

/** Soft red disc behind a checkmated king (Lichess-style). */
export const CHECKMATE_KING_STYLE: CSSProperties = {
    background:
        'radial-gradient(ellipse at center, rgba(235, 60, 60, 0.90) 0%, rgba(235, 60, 60, 0.75) 45%, transparent 70%)',
}

export function findKingSquare(game: Chess, color: 'w' | 'b'): string | null {
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

/** The checkmated king's square, or null when the side to move isn't mated. */
export function checkmatedKingSquare(game: Chess): string | null {
    return game.isCheckmate() ? findKingSquare(game, game.turn()) : null
}

/**
 * While a piece is dragged, the square under it sets this CSS variable (via `dropSquareStyle`);
 * legal target squares draw it through `LEGAL_TARGET_STYLE`, so only a legal square under the
 * piece is outlined. Other squares just get the variable, which nothing reads.
 */
const DROP_OUTLINE_VAR = '--gm-drop-outline'
export const LEGAL_TARGET_STYLE: CSSProperties = { boxShadow: `var(${DROP_OUTLINE_VAR}, none)` }

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
    // No lift-and-grow while dragging, and no thin black outline on every square passed over.
    draggingPieceStyle: { transform: 'none' },
    dropSquareStyle: {
        boxShadow: 'none',
        [DROP_OUTLINE_VAR]: SELECTED_SQUARE_STYLE.boxShadow,
    } as CSSProperties,
} as const
