import type { Square } from 'chess.js'
import { Chess, type Move } from 'chess.js'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Chessboard } from 'react-chessboard'
import type {
  PieceDropHandlerArgs,
  PieceHandlerArgs,
  PieceRenderObject,
  SquareHandlerArgs,
} from 'react-chessboard'

import {
  canonicalPathKey,
  fenSig,
  legalChildSans,
  walkToNode,
  type Node,
} from './moveTree'

export type Side = 'w' | 'b'

export type TrainerChessboardProps = {
  root: Node | null
  terminalLineCount: number
  terminalPathKeys: ReadonlySet<string>
  playerSide: Side
  sessionResetKey: number
  trainingRevision: number
  onStatusChange: (status: string) => void
}

const MOVE_ANIMATION_MS = 350
const PIECE_CODES = [
  'wK', 'wQ', 'wR', 'wB', 'wN', 'wP',
  'bK', 'bQ', 'bR', 'bB', 'bN', 'bP',
] as const

const customPieces = Object.fromEntries(
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
  sessionResetKey,
  trainingRevision,
  onStatusChange,
}: TrainerChessboardProps) {
  const gameRef = useRef(new Chess())
  const historySansRef = useRef<string[]>([])
  const completedPathKeysRef = useRef(new Set<string>())
  const branchDrillsRef = useRef(new Map<string, Set<string>>())
  const settlingRef = useRef(false)
  const runIdRef = useRef(0)
  const previousRootRef = useRef<Node | null>(null)
  const previousSessionResetKeyRef = useRef(sessionResetKey)

  const [fen, setFen] = useState(() => gameRef.current.fen())
  const [boardKey, setBoardKey] = useState(0)
  const [selectedSquare, setSelectedSquare] = useState<string | null>(null)
  const [optionSquares, setOptionSquares] = useState({});
  const [lastMoveSquares, setLastMoveSquares] = useState<{ from?: string; to?: string }>({});

  const rebuildStatus = useCallback(() => {
    const done = completedPathKeysRef.current.size
    if (!root) {
      onStatusChange('Load a PGN to start.')
    }
    else if (terminalLineCount > 0 && done >= terminalLineCount) {
      onStatusChange(
        `All ${terminalLineCount} terminal lines have been reached at least once. Load another file or Reset session.`,
      )
    }
    else {
      onStatusChange(
        `Progress: ${done}/${terminalLineCount} terminal lines reached. Drag when it is your move.`,
      )
    }
  }, [onStatusChange, root, terminalLineCount])

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
    gameRef.current = new Chess()
    historySansRef.current = []
    setSelectedSquare(null)
    setLastMoveSquares({})
    setOptionSquares({})

    if (root && playerSide === 'b') {
      const first = legalChildSans(gameRef.current, root).sort()[0]
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
  }, [playerSide, rebuildStatus, root])

  const settleAfterChange = useCallback(async () => {
    if (!root || settlingRef.current) return
    const runId = runIdRef.current
    settlingRef.current = true

    try {
      while (runId === runIdRef.current) {
        const game = gameRef.current
        const newlyCompleted = tryMarkLeafCompleted()
        const node = walkToNode(root, historySansRef.current)

        if (!node || node.children.size === 0) {
          if (
            newlyCompleted
            && completedPathKeysRef.current.size < terminalLineCount
          ) {
            settlingRef.current = false
            await startLesson(false)
            await settleAfterChange()
            return
          }
          break
        }

        const outs = legalChildSans(game, node)
        if (!outs.length) break

        if (game.turn() === playerSide) {
          const needsPractice = outs.filter(
            (san) => node.children.get(san)?.needsPractice === true,
          )
          if (needsPractice.length) break

          const practicedMove = [...outs].sort()[0]!
          if (!(await applyBookMove(practicedMove, runId))) break
          continue
        }

        let opponentMove: string
        if (outs.length === 1) {
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
    }
    finally {
      settlingRef.current = false
    }
  }, [
    applyBookMove,
    playerSide,
    root,
    startLesson,
    terminalLineCount,
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
  }, [playerSide, root, sessionResetKey, startLesson, settleAfterChange])

  useEffect(() => {
    if (!root) return
    void settleAfterChange()
  }, [root, settleAfterChange, trainingRevision])

  const legalPlayerSansNeedingPractice = useCallback((): string[] => {
    if (!root || gameRef.current.turn() !== playerSide) return []
    const node = walkToNode(root, historySansRef.current)
    if (!node) return []
    return legalChildSans(gameRef.current, node).filter(
      (san) => node.children.get(san)?.needsPractice === true,
    )
  }, [playerSide, root])

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
    if (playedNode) playedNode.needsPractice = false

    setSelectedSquare(null)
    setFen(game.fen())
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
        boardStyle: {
          borderRadius: '0.75rem',
          boxShadow: '0 25px 50px -12px rgba(0,0,0,0.65)',
        },
        darkSquareStyle: { backgroundColor: '#64748b' },
        lightSquareStyle: { backgroundColor: '#cbd5e1' },
      }}
    />
  )
}
