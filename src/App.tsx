import type { Square } from 'chess.js'
import { Chess, type Move } from 'chess.js'
import type { ChangeEvent } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Chessboard } from 'react-chessboard'
import type { PieceDropHandlerArgs, PieceHandlerArgs } from 'react-chessboard'

import {
  applySan,
  canonicalPathKey,
  fenSig,
  legalChildSans,
  logRepertoireTreeDfs,
  resetNeedsPractice,
  walkToNode,
  type Node,
} from './moveTree'
import { parsePgnToRepertoire } from './pgnPaths'
import {
  applyTrainingStatus,
  parseTrainingFileJson,
  serializeTrainingStatus,
  triggerJsonDownload,
} from './trainingExport'
import { APP_VERSION } from './appVersion'

type Side = 'w' | 'b'

// Strips check/mate decorations so we can match user drags to repertoire SAN lists that omit +/#.
// Arguments: san — SAN from chess.js or the file.
function normalizeSan(san: string): string {
  return san.replace(/[+#]+$/, '').trim()
}

// Figures out what SAN a drag-from-to would produce so error messages can name the illegal attempt.
// Arguments: game — current position; from, to — board squares for the drag.
function describeDragAttempt(game: Chess, from: Square, to: Square): string | null {
  const piece = game.get(from)
  const tries: Array<'q' | 'r' | 'b' | 'n' | undefined> =
    piece?.type === 'p' &&
    ((piece.color === 'w' && to[1] === '8') ||
      (piece.color === 'b' && to[1] === '1'))
      ? ['q', 'r', 'b', 'n']
      : [undefined]

  for (const promotion of tries) {
    const trial = new Chess(game.fen())
    try {
      const mv = trial.move(
        promotion
          ? { from, to, promotion }
          : { from, to },
        { strict: false },
      )
      if (mv) return mv.san
    }
    catch {
      /* next */
    }
  }
  return null
}

// Finds promotion choice (if any) so a pawn drag to the last rank still matches the book SAN (Q/R/B/N).
// Arguments: game — current position; from, to — drag endpoints; allowedSans — repertoire replies at this node.
function findMatchingAmongOutcomes(
  game: Chess,
  from: Square,
  to: Square,
  allowedSans: readonly string[],
): { promotion?: 'q' | 'r' | 'b' | 'n' } | null {
  const norms = new Set(allowedSans.map(normalizeSan))
  const piece = game.get(from)
  const promotions: Array<'q' | 'r' | 'b' | 'n' | undefined> =
    piece?.type === 'p' &&
    ((piece.color === 'w' && to[1] === '8') ||
      (piece.color === 'b' && to[1] === '1'))
      ? ['q', 'r', 'b', 'n']
      : [undefined]

  for (const promotion of promotions) {
    const trial = new Chess(game.fen())
    try {
      const mv = trial.move(
        promotion
          ? { from, to, promotion }
          : { from, to },
        { strict: false },
      )
      if (mv && norms.has(normalizeSan(mv.san)))
        return promotion ? { promotion } : {}
    }
    catch {
      /* continue */
    }
  }
  return null
}

// Applies a user drag that was already validated against allowedSans, returning the verbose move or null on failure.
// Arguments: game — mutates in place; from, to — squares; match — optional underpromotion letter from findMatchingAmongOutcomes.
function applyUserMove(
  game: Chess,
  from: Square,
  to: Square,
  match: { promotion?: 'q' | 'r' | 'b' | 'n' },
): Move | null {
  try {
    const mv = game.move(
      match.promotion
        ? { from, to, promotion: match.promotion }
        : { from, to },
      { strict: false },
    )
    return mv
  }
  catch {
    return null
  }
}

// Root UI: file loaders, side toggle, chessboard, and the opening drill loop driven by refs (tree + game + history).
// Arguments: none (React component).
export default function App() {
  const [pgnName, setPgnName] = useState<string | null>(null)
  const [parseError, setParseError] = useState<string | null>(null)
  const [hasTree, setHasTree] = useState(false)
  const [playerSide, setPlayerSide] = useState<Side>('w')
  const [fen, setFen] = useState(() => new Chess().fen())
  const [status, setStatus] = useState<string>('Load a PGN to start.')
  const [boardResetKey, setBoardResetKey] = useState(0)

  const treeRef = useRef<Node | null>(null)
  const terminalLineCountRef = useRef(0)
  const terminalPathKeysRef = useRef<ReadonlySet<string>>(new Set())

  const gameRef = useRef(new Chess())
  const historySansRef = useRef<string[]>([])
  const completedPathKeysRef = useRef(new Set<string>())
  const branchDrillsRef = useRef(new Map<string, Set<string>>())

  const fileInputRef = useRef<HTMLInputElement>(null)
  const trainingInputRef = useRef<HTMLInputElement>(null)

  // Pushes terminal-line progress into the on-screen status string whenever refs change.
  // Arguments: none (reads completedPathKeysRef, terminalLineCountRef).
  const rebuildStatus = useCallback(() => {
    const done = completedPathKeysRef.current.size
    const tot = terminalLineCountRef.current
    if (tot > 0 && done >= tot)
      setStatus(`All ${tot} terminal lines have been reached at least once. Load another file or Reset session.`)
    else
      setStatus(`Progress: ${done}/${tot} terminal lines reached. Drag when it is your move.`)
  }, [])

  // If the SAN history is a repertoire leaf, records that terminal path as done and flips needsPractice on that node.
  // Returns true when this call newly added the path to completedPathKeysRef (first time finishing that line).
  // Arguments: none (uses treeRef, historySansRef, terminalPathKeysRef).
  const tryMarkLeafCompleted = (): boolean => {
    const root = treeRef.current
    if (!root) return false
    const keys = terminalPathKeysRef.current
    const hist = historySansRef.current
    const k = canonicalPathKey(hist)
    const already = completedPathKeysRef.current.has(k)
    const n = walkToNode(root, hist)
    if (n && n.children.size === 0 && (!keys.size || keys.has(k))) {
      completedPathKeysRef.current.add(k)
      n.needsPractice = false
      rebuildStatus()
      return !already
    }
    rebuildStatus()
    return false
  }

  // Puts the drill back at the start position (and White’s first move when training as Black), without clearing session progress.
  // Arguments: none (uses treeRef, playerSide).
  const applyLessonStartPosition = () => {
    const root = treeRef.current
    if (!root) return
    const g = new Chess()
    gameRef.current = g
    historySansRef.current = []
    if (playerSide === 'b') {
      const rootNode = walkToNode(root, [])
      if (!rootNode) return
      const firstChoices = legalChildSans(g, rootNode).sort()
      const first = firstChoices[0]
      if (!first) return
      applySan(g, first)
      historySansRef.current.push(first)
    }
    setFen(g.fen())
  }

  // After any half-move, auto-plays forced opponent moves, handles multi-reply drill branches, and marks completed leaves.
  // Arguments: none (reads tree/game/history/playerSide refs and state).
  const settleAfterChange = useCallback(async () => {
    const root = treeRef.current
    if (!root) return

    const g = gameRef.current

    while (true) {
      const newlyCompletedLine = tryMarkLeafCompleted()
      const hist = historySansRef.current

      const node = walkToNode(root, hist)
      if (!node || node.children.size === 0) {
        if (
          newlyCompletedLine
          && completedPathKeysRef.current.size < terminalLineCountRef.current
        ) {
          applyLessonStartPosition()
          setBoardResetKey((k) => k + 1)
          await settleAfterChange()
          return
        }
        break
      }

      const outs = legalChildSans(g, node)
      if (outs.length === 0) break

      if (g.turn() === playerSide) break

      if (outs.length > 1) {
        const branchSig = fenSig(g.fen())
        const g2 = gameRef.current
        const restoredNode = walkToNode(root, historySansRef.current)
        if (!restoredNode) {
          rebuildStatus()
          setFen(g2.fen())
          return
        }

        const nextOuts = legalChildSans(g2, restoredNode)
        if (!nextOuts.length) {
          rebuildStatus()
          setFen(g2.fen())
          return
        }

        let used = branchDrillsRef.current.get(branchSig)
        if (!used) {
          used = new Set()
          branchDrillsRef.current.set(branchSig, used)
        }

        let pickList = nextOuts.filter((s) => !used!.has(s))
        if (!pickList.length) {
          used!.clear()
          pickList = nextOuts
        }

        const nextSan = pickList[Math.floor(Math.random() * pickList.length)]!
        used!.add(nextSan)

        applySan(g2, nextSan)
        historySansRef.current.push(nextSan)
        rebuildStatus()
        setFen(gameRef.current.fen())

        await settleAfterChange()
        setFen(gameRef.current.fen())
        return
      }

      const san = outs[0]!
      applySan(g, san)
      historySansRef.current.push(san)
      setFen(g.fen())
    }

    tryMarkLeafCompleted()
    setFen(g.fen())
  }, [playerSide, rebuildStatus])

  // Resets the session board from the start (and plays White’s first move when training as Black if needed).
  // Arguments: none (uses treeRef, playerSide, settleAfterChange).
  const bootstrap = useCallback(async () => {
    const root = treeRef.current
    if (!root) {
      gameRef.current = new Chess()
      historySansRef.current = []
      setFen(gameRef.current.fen())
      setStatus('Load a PGN to start.')
      return
    }

    const g = new Chess()
    if (playerSide === 'b') {
      const rootNode = walkToNode(root, [])
      if (!rootNode) {
        setParseError('Could not read repertoire root.')
        return
      }
      const firstChoices = legalChildSans(g, rootNode).sort()
      const first = firstChoices[0]
      if (!first) {
        setParseError('No White first move in repertoire.')
        return
      }
    }

    applyLessonStartPosition()
    await settleAfterChange()
  }, [playerSide, settleAfterChange])

  // Re-mounts the drill from a clean board when the player switches White/Black (or after bootstrap definition changes).
  // Arguments: none (dependencies: playerSide, bootstrap).
  useEffect(() => {
    if (!treeRef.current) {
      gameRef.current = new Chess()
      historySansRef.current = []
      setFen(gameRef.current.fen())
      return
    }
    void (async () => {
      await bootstrap()
      setBoardResetKey((k) => k + 1)
    })()
  }, [playerSide, bootstrap])

  // Parses PGN text into the trie, resets session refs, logs the tree, downloads training JSON, and starts bootstrap.
  // Arguments: text — PGN contents; name — original filename for display and default export basename.
  const loadRepertoire = useCallback(
    (text: string, name: string | null) => {
      const res = parsePgnToRepertoire(text)
      if ('error' in res) {
        setParseError(res.error ?? 'Could not parse PGN.')
        treeRef.current = null
        terminalLineCountRef.current = 0
        terminalPathKeysRef.current = new Set()
        completedPathKeysRef.current = new Set()
        branchDrillsRef.current = new Map()
        setPgnName(null)
        setHasTree(false)
        gameRef.current = new Chess()
        historySansRef.current = []
        setFen(gameRef.current.fen())
        setStatus('Load a PGN to start.')
        return
      }
      setParseError(null)
      setPgnName(name)
      treeRef.current = res.root
      terminalLineCountRef.current = res.terminalLineCount
      terminalPathKeysRef.current = res.terminalPathKeys
      completedPathKeysRef.current = new Set()
      branchDrillsRef.current = new Map()
      setHasTree(true)

      logRepertoireTreeDfs(res.root)
      const base = (name ?? 'repertoire').replace(/\.[^.]+$/, '')
      triggerJsonDownload(serializeTrainingStatus(res.root), `${base}-training.json`)

      void (async () => {
        await bootstrap()
        setBoardResetKey((k) => k + 1)
      })()
    },
    [bootstrap],
  )

  // Reads a previously exported training JSON and merges needsPractice flags into the trie already loaded from PGN.
  // Arguments: event — file input change carrying the chosen .json file.
  const onTrainingFilePick = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    const root = treeRef.current
    if (!root) {
      setParseError('Load a PGN first, then load training status.')
      return
    }
    try {
      const text = await file.text()
      const parsed = parseTrainingFileJson(text)
      if ('error' in parsed) {
        setParseError(parsed.error)
        return
      }
      applyTrainingStatus(root, parsed)
      setParseError(null)
      rebuildStatus()
    }
    catch {
      setParseError('Could not read the training file.')
    }
  }

  // Validates a drag against the repertoire at the current node, applies it, then runs opponent autoplay logic.
  // Arguments: v5 `PieceDropHandlerArgs` — piece.pieceType is like `wP`; targetSquare is null when dropped off the board.
  const onPieceDrop = useCallback(
    ({ piece, sourceSquare, targetSquare }: PieceDropHandlerArgs): boolean => {
      if (!treeRef.current || !targetSquare) return false

      const pieceType = piece.pieceType
      const colorLetter = pieceType[0] === 'w' ? ('w' as const) : ('b' as const)
      if (colorLetter !== playerSide) return false

      const g = gameRef.current
      if (g.turn() !== playerSide) return false

      const root = treeRef.current
      const node = walkToNode(root, historySansRef.current)
      if (!node) return false

      const outs = legalChildSans(g, node)
      if (outs.length === 0) return false

      const from = sourceSquare as Square
      const to = targetSquare as Square

      const match = findMatchingAmongOutcomes(g, from, to, outs)
      if (!match) {
        const attempt = describeDragAttempt(g, from, to)
        window.alert(
          attempt
            ? `That move is not in the repertoire here.\nPlayed: ${attempt}\nAllowed: ${outs.join(', ')}`
            : `Illegal move.\nAllowed from the file: ${outs.join(', ')}`,
        )
        return false
      }

      const mv = applyUserMove(g, from, to, match)
      if (!mv) return false

      historySansRef.current.push(mv.san)

      setFen(gameRef.current.fen())
      void settleAfterChange()
      return true
    },
    [playerSide, settleAfterChange],
  )

  // v5: only allow dragging when the repertoire still has a legal reply here (no grab cursor at true line ends).
  // Arguments: v5 `PieceHandlerArgs` — `piece.pieceType` is e.g. `wP`; `square` is the source square (or null for spare pieces).
  const canDragFromRepertoire = useCallback(
    ({ piece: p }: PieceHandlerArgs) => {
      if (p.pieceType[0] !== playerSide) return false
      const root = treeRef.current
      if (!root) return false
      const g = gameRef.current
      if (g.turn() !== playerSide) return false
      const n = walkToNode(root, historySansRef.current)
      if (!n || n.children.size === 0) return false
      return legalChildSans(g, n).length > 0
    },
    [playerSide],
  )

  // Reads the user’s PGN file from disk and hands the text to loadRepertoire (clears input value so same file can re-pick).
  // Arguments: event — file input change for .pgn upload.
  const onFilePick = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    try {
      const text = await file.text()
      loadRepertoire(text, file.name)
    }
    catch {
      setParseError('Could not read the file.')
    }
  }

  // Clears per-session completion and practice flags, then re-bootstrap the board from the same tree.
  // Arguments: none.
  const resetOpening = () => {
    if (!treeRef.current) return
    completedPathKeysRef.current = new Set()
    branchDrillsRef.current = new Map()
    resetNeedsPractice(treeRef.current)
    void (async () => {
      await bootstrap()
      setBoardResetKey((k) => k + 1)
    })()
  }

  return (
    <div className="min-h-screen bg-slate-950 bg-[radial-gradient(ellipse_at_top,_#1e293b_0%,_#020617_55%)]">
      <div className="mx-auto flex max-w-5xl flex-col gap-8 px-4 py-10 md:flex-row md:items-start">
        <section className="flex-1 space-y-5">
          <header>
            <h1 className="text-3xl font-semibold tracking-tight text-amber-100">
              Chess opening trainer
            </h1>
            <p className="mt-2 text-sm leading-relaxed text-slate-400">
              Variations merge into one SAN trie of <code className="text-slate-300">Node</code> values. After a
              PGN loads, the trie is printed depth-first in the console, and a JSON file is downloaded mapping each
              node&apos;s <code className="text-slate-300">canonicalPathKey</code> (SAN path from the root) to{' '}
              <code className="text-slate-300">needsPractice</code>. You can load that file later to restore flags
              on the current tree. Where the repertoire branches, opponents cycle sidelines so you practise each
              path; progress counts when your move list reaches a terminal line yourself. Finishing a line while others
              remain returns the board to the start for the next one (session progress is kept).
            </p>
            <p className="mt-2 font-mono text-xs text-slate-500">
              Version {APP_VERSION}
            </p>
          </header>

          <div className="flex flex-wrap items-center gap-3">
            <input
              ref={fileInputRef}
              type="file"
              accept=".pgn,.PGN,text/plain"
              className="hidden"
              onChange={onFilePick}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="rounded-lg bg-amber-500 px-4 py-2 text-sm font-medium text-slate-950 shadow transition hover:bg-amber-400"
            >
              Upload PGN
            </button>

            <input
              ref={trainingInputRef}
              type="file"
              accept=".json,application/json"
              className="hidden"
              onChange={onTrainingFilePick}
            />
            <button
              type="button"
              onClick={() => trainingInputRef.current?.click()}
              disabled={!hasTree}
              className="rounded-lg border border-slate-600 px-4 py-2 text-sm text-slate-200 transition enabled:hover:border-amber-500/60 enabled:hover:text-amber-100 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Load training JSON
            </button>

            <span className="text-sm text-slate-500">
              {pgnName ? pgnName : 'No file selected'}
            </span>
          </div>

          <fieldset className="space-y-2 rounded-xl border border-slate-700/80 bg-slate-900/50 p-4">
            <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
              Side
            </legend>
            <div className="flex flex-wrap gap-4">
              <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-200">
                <input
                  type="radio"
                  name="side"
                  checked={playerSide === 'w'}
                  onChange={() => setPlayerSide('w')}
                  className="accent-amber-500"
                />
                White
              </label>
              <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-200">
                <input
                  type="radio"
                  name="side"
                  checked={playerSide === 'b'}
                  onChange={() => setPlayerSide('b')}
                  className="accent-amber-500"
                />
                Black
              </label>
            </div>
            <p className="text-xs text-slate-500">
              As Black, if White has multiple first moves, the alphabetically first SAN is used to start each
              session.
            </p>
          </fieldset>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={resetOpening}
              disabled={!hasTree}
              className="rounded-lg border border-slate-600 px-3 py-1.5 text-sm text-slate-200 transition enabled:hover:border-amber-500/60 enabled:hover:text-amber-100 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Reset session
            </button>
          </div>

          {parseError && (
            <p className="rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-200">
              {parseError}
            </p>
          )}

          <p className="rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2 text-sm text-slate-300">
            {status}
          </p>
        </section>

        <div className="w-full max-w-[min(100%,28rem)] shrink-0 self-center md:self-start">
          <Chessboard
            key={boardResetKey}
            options={{
              id: 'OpeningTrainerBoard',
              position: fen,
              boardOrientation: playerSide === 'w' ? 'white' : 'black',
              onPieceDrop,
              canDragPiece: canDragFromRepertoire,
              boardStyle: {
                borderRadius: '0.75rem',
                boxShadow: '0 25px 50px -12px rgba(0,0,0,0.65)',
              },
              darkSquareStyle: { backgroundColor: '#64748b' },
              lightSquareStyle: { backgroundColor: '#cbd5e1' },
            }}
          />
        </div>
      </div>
    </div>
  )
}
