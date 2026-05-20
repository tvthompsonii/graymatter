/** Minimal types for @chrisoakman/chessboardjs loaded from index.html. */
type ChessboardOrientation = 'white' | 'black'
type ChessboardSquare = string
type ChessboardPiece = string
type ChessboardPosition = Record<string, ChessboardPiece | undefined>

interface ChessboardConfig {
  position?: string | ChessboardPosition
  orientation?: ChessboardOrientation
  draggable?: boolean
  pieceTheme?: string
  showNotation?: boolean
  appearSpeed?: number
  moveSpeed?: number
  snapSpeed?: number
  trashSpeed?: number
  onDragStart?: (
    source: ChessboardSquare,
    piece: ChessboardPiece,
    position: ChessboardPosition,
    orientation: ChessboardOrientation,
  ) => boolean | void
  onDrop?: (
    source: ChessboardSquare,
    target: ChessboardSquare,
    piece: ChessboardPiece,
    newPos: ChessboardPosition,
    oldPos: ChessboardPosition,
  ) => 'snapback' | 'trash' | void
  onSnapEnd?: (
    source: ChessboardSquare,
    target: ChessboardSquare,
    piece: ChessboardPiece,
  ) => void
}

interface ChessboardInstance {
  /** Second argument `false` updates the board instantly without tweening pieces. */
  position(fen?: string | ChessboardPosition, useAnimation?: boolean): void
  /** Animate one or more piece slides, e.g. `move('e7-e5')` or `move('e1-g1', 'h1-f1')`. */
  move(...moves: (string | false)[]): ChessboardPosition
  orientation(side?: ChessboardOrientation): ChessboardOrientation
  destroy(): void
  clear(): void
  start(): void
}

declare function Chessboard(
  container: string | HTMLElement,
  config?: ChessboardConfig | string,
): ChessboardInstance
