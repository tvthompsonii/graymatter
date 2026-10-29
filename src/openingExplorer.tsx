import type { Square } from 'chess.js'
import { Chess } from 'chess.js'
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Chessboard } from 'react-chessboard'
import type {
    Arrow,
    PieceDropHandlerArgs,
    PieceHandlerArgs,
    SquareHandlerArgs,
} from 'react-chessboard'

import {
    boardChrome,
    checkmatedKingSquare,
    CHECKMATE_KING_STYLE,
    customPieces,
    HINT_SQUARE_STYLE,
    LEGAL_TARGET_STYLE,
    MOVE_ANIMATION_MS,
    SELECTED_SQUARE_STYLE,
    SOLUTION_ARROW_COLOR,
    withSquareOutlines,
    WRONG_MOVE_DISPLAY_MS,
    WRONG_SQUARE_STYLE,
} from './boardTheme'
import { repertoireSanForPlayed, walkToNode, type Node } from './moveTree'
import type { LoadedRepertoires } from './openings'
import { Button, SegmentedControl } from './ui/controls'
import { ResetIcon, UndoIcon } from './ui/icons'
import { BoardPage, ErrorNote, PanelHeader, Section, SideMarker, StatusBanner } from './ui/layout'
import { MoveList } from './ui/moveList'

type Side = 'w' | 'b'

/** Arrow colors: the explored repertoire's own moves vs. the opponent's book replies. */
const OWN_ARROW_COLOR = 'rgba(245, 158, 11, 0.85)'
const OPPONENT_ARROW_COLOR = 'rgba(125, 145, 180, 0.85)'

const LAST_MOVE_STYLE: CSSProperties = { backgroundColor: 'rgba(179, 197, 18, 0.4)' }

const SIDE_OPTIONS = [
    { value: 'w', label: 'White' },
    { value: 'b', label: 'Black' },
] as const satisfies ReadonlyArray<{ value: Side; label: string }>

/** From/to squares of `san` played from `fen`, or null if it isn't legal there. */
function moveSquares(fen: string, san: string): { from: Square; to: Square } | null {
    try {
        const move = new Chess(fen).move(san, { strict: false })
        return move ? { from: move.from, to: move.to } : null
    }
    catch {
        return null
    }
}

type ExploreChessboardProps = {
    root: Node
    /** The explored repertoire; this side is at the bottom and gets the amber arrows. */
    side: Side
    /** SAN moves from the start position to the shown position. */
    path: readonly string[]
    /** A book move was played (on the board); the page appends it to `path`. */
    onPlay: (san: string) => void
    /** The book move whose panel button is hovered; an opponent move's arrow turns green. */
    hoveredSan?: string | null
}

/**
 * Board for Explore: shows the position at `path`, draws an arrow for every book move from it,
 * and accepts only those moves (for whichever side is to move). Nothing plays automatically.
 */
export function ExploreChessboard({ root, side, path, onPlay, hoveredSan = null }: ExploreChessboardProps) {
    const node = walkToNode(root, path) ?? root
    const turn: Side = new Chess(node.fen).turn()
    const bookSans = useMemo(() => [...node.children.keys()], [node])
    const endOfLine = path.length > 0 && bookSans.length === 0

    const [selectedSquare, setSelectedSquare] = useState<string | null>(null)
    const [optionSquares, setOptionSquares] = useState<Record<string, CSSProperties>>({})
    // A legal off-book move stays on the board (outlined in red) for a moment, then the
    // position at `path` comes back. Input is blocked meanwhile.
    const [wrong, setWrong] = useState<{ fen: string; square: string } | null>(null)
    const wrongTimerRef = useRef<number | null>(null)

    const clearSelection = useCallback(() => {
        setSelectedSquare(null)
        setOptionSquares({})
    }, [])

    const clearWrong = useCallback(() => {
        if (wrongTimerRef.current !== null) window.clearTimeout(wrongTimerRef.current)
        wrongTimerRef.current = null
        setWrong(null)
    }, [])

    // A new position (move, Back, Reset, side switch) drops any selection or wrong-move display.
    useEffect(() => {
        clearSelection()
        clearWrong()
    }, [node, clearSelection, clearWrong])

    useEffect(() => clearWrong, [clearWrong])

    const arrows = useMemo<Arrow[]>(() => {
        const own = turn === side
        // The hovered move goes last so its arrow is drawn on top.
        const ordered = [...bookSans.filter((san) => san !== hoveredSan), ...bookSans.filter((san) => san === hoveredSan)]
        return ordered.flatMap((san) => {
            const squares = moveSquares(node.fen, san)
            // Your side has a single book move, so only the opponent's hovered reply needs picking out.
            const color = own ? OWN_ARROW_COLOR : san === hoveredSan ? SOLUTION_ARROW_COLOR : OPPONENT_ARROW_COLOR
            return squares ? [{ startSquare: squares.from, endSquare: squares.to, color }] : []
        })
    }, [bookSans, hoveredSan, node, side, turn])

    const lastMove = useMemo(() => {
        if (!path.length) return null
        const parent = walkToNode(root, path.slice(0, -1))
        return parent ? moveSquares(parent.fen, path[path.length - 1]!) : null
    }, [path, root])

    const getMoveOptions = useCallback((square: Square) => {
        const game = new Chess(node.fen)
        const moves = game.moves({ square, verbose: true })
        if (moves.length === 0) {
            setOptionSquares({})
            return false
        }
        const source = game.get(square)
        const next: Record<string, CSSProperties> = {}
        for (const move of moves) {
            const target = game.get(move.to)
            next[move.to] = {
                ...LEGAL_TARGET_STYLE,
                background: target && target.color !== source?.color
                    ? 'radial-gradient(circle, transparent 70%, rgba(0,0,0,.1) 70%)'
                    : 'radial-gradient(circle, rgba(0,0,0,.1) 25%, transparent 25%)',
            }
        }
        setOptionSquares(next)
        return true
    }, [node])

    const attemptMove = useCallback((sourceSquare: string, targetSquare: string | null): boolean => {
        if (wrong || !targetSquare) return false
        if (sourceSquare === targetSquare) {
            clearSelection()
            return true
        }

        const game = new Chess(node.fen)
        const piece = game.get(sourceSquare as Square)
        if (!piece || piece.color !== turn) return false

        let move
        try {
            move = game.move({ from: sourceSquare, to: targetSquare, promotion: 'q' })
        }
        catch {
            return false
        }
        if (!move) return false
        clearSelection()

        const bookSan = repertoireSanForPlayed(bookSans, move.san)
        if (bookSan) {
            onPlay(bookSan)
            return true
        }

        setWrong({ fen: game.fen(), square: targetSquare })
        wrongTimerRef.current = window.setTimeout(() => {
            wrongTimerRef.current = null
            setWrong(null)
        }, WRONG_MOVE_DISPLAY_MS)
        return true
    }, [bookSans, clearSelection, node, onPlay, turn, wrong])

    const canDragPiece = useCallback(({ piece }: PieceHandlerArgs): boolean => (
        !wrong && piece.pieceType[0] === turn
    ), [turn, wrong])

    const onPieceDrag = useCallback(({ square }: PieceHandlerArgs) => {
        if (!square) return
        setSelectedSquare(square)
        getMoveOptions(square as Square)
    }, [getMoveOptions])

    const onPieceDrop = useCallback(({ sourceSquare, targetSquare }: PieceDropHandlerArgs): boolean => {
        clearSelection()
        return attemptMove(sourceSquare, targetSquare)
    }, [attemptMove, clearSelection])

    const onSquareClick = useCallback(({ piece, square }: SquareHandlerArgs) => {
        if (wrong) return
        const ownPiece = piece?.pieceType[0] === turn

        if (!selectedSquare) {
            if (ownPiece && getMoveOptions(square as Square)) setSelectedSquare(square)
            else clearSelection()
            return
        }
        if (selectedSquare === square) {
            clearSelection()
            return
        }
        if (!attemptMove(selectedSquare, square)) {
            if (ownPiece && getMoveOptions(square as Square)) setSelectedSquare(square)
            else clearSelection()
        }
    }, [attemptMove, clearSelection, getMoveOptions, selectedSquare, turn, wrong])

    const highlights = withSquareOutlines(
        {
            ...optionSquares,
            // A legal target that is also a last-move square keeps its drag outline.
            ...(lastMove && !wrong && {
                [lastMove.from]: { ...LAST_MOVE_STYLE, ...(optionSquares[lastMove.from] && LEGAL_TARGET_STYLE) },
                [lastMove.to]: { ...LAST_MOVE_STYLE, ...(optionSquares[lastMove.to] && LEGAL_TARGET_STYLE) },
            }),
        },
        [
            [wrong ? null : checkmatedKingSquare(new Chess(node.fen)), CHECKMATE_KING_STYLE],
            [endOfLine && lastMove && !wrong ? lastMove.to : null, HINT_SQUARE_STYLE],
            [selectedSquare, SELECTED_SQUARE_STYLE],
            [wrong?.square ?? null, WRONG_SQUARE_STYLE],
        ],
    )

    return (
        <Chessboard
            options={{
                id: 'ExploreBoard',
                position: wrong?.fen ?? node.fen,
                boardOrientation: side === 'w' ? 'white' : 'black',
                pieces: customPieces,
                animationDurationInMs: MOVE_ANIMATION_MS,
                arrows: wrong ? [] : arrows,
                allowDrawingArrows: false,
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

type ExploreViewProps = {
    loaded: LoadedRepertoires
    /** The Explore | Drill | Progress switch, placed under the panel header. */
    viewSwitch: ReactNode
    /** Where to start (e.g. a move double-clicked in Progress); the start position by default. */
    initialSide?: Side
    initialPath?: string[]
}

/** Explore: walk either repertoire move by move, choosing every move yourself. */
export function ExploreView({ loaded, viewSwitch, initialSide = 'w', initialPath = [] }: ExploreViewProps) {
    const { whiteRepertoire, blackRepertoire, ready, loadError } = loaded
    const [side, setSide] = useState<Side>(initialSide)
    const [path, setPath] = useState<string[]>(initialPath)
    const [hoveredSan, setHoveredSan] = useState<string | null>(null)
    // Buttons are replaced when the position changes, so no mouseleave clears the old hover.
    useEffect(() => setHoveredSan(null), [path, side])

    const repertoire = side === 'w' ? whiteRepertoire : blackRepertoire
    const root = ready ? (repertoire?.root ?? null) : null
    const node = root ? (walkToNode(root, path) ?? root) : null
    const bookSans = node ? [...node.children.keys()].sort() : []
    const turn: Side = path.length % 2 === 0 ? 'w' : 'b'
    const endOfLine = !!node && path.length > 0 && bookSans.length === 0

    const play = useCallback((san: string) => setPath((prev) => [...prev, san]), [])

    const changeSide = (next: Side) => {
        setSide(next)
        setPath([])
    }

    let banner: ReactNode
    if (!node) {
        banner = <StatusBanner tone="info" title={loadError ? 'Repertoires not loaded' : 'Loading repertoires…'} />
    }
    else if (endOfLine) {
        banner = <StatusBanner tone="success" title="End of line" text="Go back or reset to explore another branch" />
    }
    else if (!bookSans.length) {
        banner = <StatusBanner tone="info" title="No book moves" text="This repertoire is empty" />
    }
    else {
        banner = (
            <StatusBanner
                title={turn === side ? 'Your move' : "Opponent's move"}
                text={`Pick one of ${bookSans.length} book move${bookSans.length === 1 ? '' : 's'}`}
                marker={<SideMarker side={turn} />}
            />
        )
    }

    return (
        <BoardPage
            label="Explore controls"
            footer={(
                <div className="flex gap-2">
                    <Button
                        className="flex-1"
                        icon={<UndoIcon />}
                        onClick={() => setPath((prev) => prev.slice(0, -1))}
                        disabled={!path.length}
                    >
                        Back
                    </Button>
                    <Button
                        variant="ghost"
                        icon={<ResetIcon />}
                        onClick={() => setPath([])}
                        disabled={!path.length}
                    >
                        Reset
                    </Button>
                </div>
            )}
            board={(
                <div className="board-panel">
                    {root
                        ? <ExploreChessboard root={root} side={side} path={path} onPlay={play} hoveredSan={hoveredSan} />
                        : (
                            <Chessboard
                                options={{
                                    id: 'ExploreBoardIdle',
                                    pieces: customPieces,
                                    allowDragging: false,
                                    boardOrientation: side === 'w' ? 'white' : 'black',
                                    ...boardChrome,
                                }}
                            />
                        )}
                </div>
            )}
        >
            <PanelHeader
                title="Openings"
                subtitle="Walk through your repertoire move by move."
                info={'Arrows show every book move from the current position: amber for your side, '
                    + 'blue-gray for the opponent. You choose every move; nothing plays automatically. '
                    + 'Exploring does not change your Drill progress.'}
            />

            {viewSwitch}

            <Section label="Repertoire">
                <SegmentedControl label="Repertoire" options={SIDE_OPTIONS} value={side} onChange={changeSide} />
            </Section>

            {banner}

            <Section label="Line" className="min-h-0 flex-1">
                <MoveList moves={path} emptyText="Start position" />
            </Section>

            {/* Always shown, with room for two rows of buttons, so the line box doesn't jump as the count changes. */}
            <Section label="Book moves">
                <div className="flex min-h-[66px] flex-wrap content-start gap-1.5">
                    {bookSans.map((san) => (
                        <button
                            key={san}
                            type="button"
                            onClick={() => play(san)}
                            onMouseEnter={() => setHoveredSan(san)}
                            onMouseLeave={() => setHoveredSan((h) => (h === san ? null : h))}
                            onFocus={() => setHoveredSan(san)}
                            onBlur={() => setHoveredSan((h) => (h === san ? null : h))}
                            className={`h-[30px] rounded-full border px-3 font-mono text-[13px] font-semibold transition ${
                                turn === side
                                    ? 'border-accent/45 bg-accent/15 text-accent-ink hover:bg-accent/25'
                                    : 'border-[#4a5a76] bg-[#7d91b4]/15 text-[#c3cfe2] hover:bg-[#7d91b4]/25'
                            }`}
                        >
                            {san}
                        </button>
                    ))}
                </div>
            </Section>

            {loadError && <ErrorNote>{loadError}</ErrorNote>}
        </BoardPage>
    )
}
