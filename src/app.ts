import type { Square } from 'chess.js'
import { Chess, type Move } from 'chess.js'

import { APP_VERSION } from './appVersion'
import {
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

type Side = 'w' | 'b'

const PIECE_THEME = '/staunty/{piece}.svg'
  //'https://chessboardjs.com/img/chesspieces/wikipedia/{piece}.png'

// Strips check/mate decorations so we can match user drags to repertoire SAN lists that omit +/#.
function normalizeSan(san: string): string {
  return san.replace(/[+#]+$/, '').trim()
}

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
        promotion ? { from, to, promotion } : { from, to },
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
        promotion ? { from, to, promotion } : { from, to },
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
  const norm = normalizeSan(playedSan)
  for (const san of allowedSans) {
    if (normalizeSan(san) === norm) return san
  }
  return null
}

// Rook half of a castling move for chessboard.js `move('h1-f1')` style updates.
function companionRookCastleMove(mv: Move): string | null {
  if (mv.flags.includes('k')) return mv.color === 'w' ? 'h1-f1' : 'h8-f8'
  if (mv.flags.includes('q')) return mv.color === 'w' ? 'a1-d1' : 'a8-d8'
  return null
}

// Opening-trainer UI and drill loop (PGN load, chessboard.js, autoplay).
export class OpeningTrainer {
  private tree: Node | null = null
  private terminalLineCount = 0
  private terminalPathKeys: ReadonlySet<string> = new Set()

  private game = new Chess()
  private historySans: string[] = []
  private completedPathKeys = new Set<string>()
  private branchDrills = new Map<string, Set<string>>()

  private playerSide: Side = 'w'
  private pgnName: string | null = null
  private hasTree = false
  private board: ChessboardInstance | null = null
  /** Run opponent autoplay after the user’s drop snap finishes (onSnapEnd). */
  private settleAfterSnap = false

  private readonly els = {
    version: document.getElementById('app-version')!,
    pgnFileInput: document.getElementById('pgn-file-input') as HTMLInputElement,
    uploadPgnBtn: document.getElementById('upload-pgn-btn')!,
    trainingFileInput: document.getElementById('training-file-input') as HTMLInputElement,
    loadTrainingBtn: document.getElementById('load-training-btn') as HTMLButtonElement,
    downloadTrainingBtn: document.getElementById('download-training-btn') as HTMLButtonElement,
    pgnName: document.getElementById('pgn-name')!,
    sideRadios: document.querySelectorAll<HTMLInputElement>('input[name="side"]'),
    resetSessionBtn: document.getElementById('reset-session-btn') as HTMLButtonElement,
    parseError: document.getElementById('parse-error')!,
    status: document.getElementById('status')!,
    boardHost: document.getElementById('board')!,
  }

  init(): void {
    this.els.version.textContent = `Version ${APP_VERSION}`
    this.bindEvents()
    this.createBoard()
  }

  private bindEvents(): void {
    this.els.uploadPgnBtn.addEventListener('click', () => this.els.pgnFileInput.click())
    this.els.pgnFileInput.addEventListener('change', (e) => void this.onPgnFilePick(e))

    this.els.loadTrainingBtn.addEventListener('click', () => this.els.trainingFileInput.click())
    this.els.trainingFileInput.addEventListener('change', (e) => void this.onTrainingFilePick(e))
    this.els.downloadTrainingBtn.addEventListener('click', () => this.downloadTrainingJson())

    this.els.resetSessionBtn.addEventListener('click', () => void this.resetOpening())

    for (const radio of this.els.sideRadios) {
      radio.addEventListener('change', () => {
        if (!radio.checked) return
        this.playerSide = radio.value as Side
        void this.onSideChange()
      })
    }
  }

  private createBoard(): void {
    if (this.board) this.board.destroy()

    this.board = Chessboard(this.els.boardHost, {
      position: this.game.fen(),
      orientation: this.playerSide === 'w' ? 'white' : 'black',
      draggable: true,
      pieceTheme: PIECE_THEME,
      onDragStart: (source, piece) => this.onDragStart(source, piece),
      onDrop: (source, target) => this.onDrop(source, target),
      onSnapEnd: (source, target) => this.onSnapEnd(source, target),
    })
  }

  // Full-board snap — only when returning to the lesson start (not after user drags or opponent plies).
  private resetBoardFromGame(): void {
    this.board?.position(this.game.fen(), false)
  }

  // Opponent / book plies: chessboard.js move() only (never position()).
  private playMoveOnBoard(mv: Move): void {
    if (!this.board) return
    const rook = companionRookCastleMove(mv)
    if (rook) this.board.move(`${mv.from}-${mv.to}`, rook)
    else this.board.move(`${mv.from}-${mv.to}`)
  }

  // Applies SAN to chess.js, then animates that single ply on the board.
  private applyBookSanAnimated(san: string): boolean {
    try {
      const mv = this.game.move(san, { strict: false })
      if (!mv) return false
      this.historySans.push(mv.san)
      this.playMoveOnBoard(mv)
      return true
    }
    catch {
      return false
    }
  }

  private onSnapEnd(_source: string, _target: string): void {
    if (!this.settleAfterSnap) return
    this.settleAfterSnap = false
    void this.settleAfterChange()
  }

  private setStatus(text: string): void {
    this.els.status.textContent = text
  }

  private setParseError(message: string | null): void {
    if (message) {
      this.els.parseError.textContent = message
      this.els.parseError.classList.remove('hidden')
    }
    else {
      this.els.parseError.textContent = ''
      this.els.parseError.classList.add('hidden')
    }
  }

  private updateChrome(): void {
    this.els.pgnName.textContent = this.pgnName ?? 'No file selected'
    this.els.loadTrainingBtn.disabled = !this.hasTree
    this.els.downloadTrainingBtn.disabled = !this.hasTree
    this.els.resetSessionBtn.disabled = !this.hasTree
  }

  private downloadTrainingJson(): void {
    const root = this.tree
    if (!root) return
    const base = (this.pgnName ?? 'repertoire').replace(/\.[^.]+$/, '')
    triggerJsonDownload(serializeTrainingStatus(root), `${base}-training.json`)
  }

  private rebuildStatus(): void {
    const done = this.completedPathKeys.size
    const tot = this.terminalLineCount
    if (tot > 0 && done >= tot)
      this.setStatus(`All ${tot} terminal lines have been reached at least once. Load another file or Reset session.`)
    else
      this.setStatus(`Progress: ${done}/${tot} terminal lines reached. Drag when it is your move.`)
  }

  private tryMarkLeafCompleted(): boolean {
    const root = this.tree
    if (!root) return false
    const keys = this.terminalPathKeys
    const hist = this.historySans
    const k = canonicalPathKey(hist)
    const already = this.completedPathKeys.has(k)
    const n = walkToNode(root, hist)
    if (n && n.children.size === 0 && (!keys.size || keys.has(k))) {
      this.completedPathKeys.add(k)
      n.needsPractice = false
      this.rebuildStatus()
      return !already
    }
    this.rebuildStatus()
    return false
  }

  private applyLessonStartPosition(): void {
    const root = this.tree
    if (!root) return
    const g = new Chess()
    this.game = g
    this.historySans = []
    if (this.playerSide === 'b') {
      const rootNode = walkToNode(root, [])
      if (!rootNode) return
      const firstChoices = legalChildSans(g, rootNode).sort()
      const first = firstChoices[0]
      if (!first) return
      if (!this.applyBookSanAnimated(first)) return
    }
    else {
      this.resetBoardFromGame()
    }
  }

  private async settleAfterChange(): Promise<void> {
    const root = this.tree
    if (!root) return

    const g = this.game

    while (true) {
      const newlyCompletedLine = this.tryMarkLeafCompleted()
      const hist = this.historySans

      const node = walkToNode(root, hist)
      if (!node || node.children.size === 0) {
        if (
          newlyCompletedLine
          && this.completedPathKeys.size < this.terminalLineCount
        ) {
          this.applyLessonStartPosition()
          this.createBoard()
          await this.settleAfterChange()
          return
        }
        break
      }

      const outs = legalChildSans(g, node)
      if (outs.length === 0) break

      if (g.turn() === this.playerSide) break

      if (outs.length > 1) {
        const branchSig = fenSig(g.fen())
        const g2 = this.game
        const restoredNode = walkToNode(root, this.historySans)
        if (!restoredNode) {
          this.rebuildStatus()
          return
        }

        const nextOuts = legalChildSans(g2, restoredNode)
        if (!nextOuts.length) {
          this.rebuildStatus()
          return
        }

        let used = this.branchDrills.get(branchSig)
        if (!used) {
          used = new Set()
          this.branchDrills.set(branchSig, used)
        }

        let pickList = nextOuts.filter((s) => !used!.has(s))
        if (!pickList.length) {
          used.clear()
          pickList = nextOuts
        }

        const nextSan = pickList[Math.floor(Math.random() * pickList.length)]!
        used.add(nextSan)

        if (!this.applyBookSanAnimated(nextSan)) break
        this.rebuildStatus()

        await this.settleAfterChange()
        return
      }

      const san = outs[0]!
      if (!this.applyBookSanAnimated(san)) break
    }

    this.tryMarkLeafCompleted()
  }

  private async bootstrap(): Promise<void> {
    const root = this.tree
    if (!root) {
      this.game = new Chess()
      this.historySans = []
      this.resetBoardFromGame()
      this.setStatus('Load a PGN to start.')
      return
    }

    const g = new Chess()
    if (this.playerSide === 'b') {
      const rootNode = walkToNode(root, [])
      if (!rootNode) {
        this.setParseError('Could not read repertoire root.')
        return
      }
      const firstChoices = legalChildSans(g, rootNode).sort()
      const first = firstChoices[0]
      if (!first) {
        this.setParseError('No White first move in repertoire.')
        return
      }
    }

    this.applyLessonStartPosition()
    await this.settleAfterChange()
  }

  private async onSideChange(): Promise<void> {
    if (!this.tree) {
      this.game = new Chess()
      this.historySans = []
      this.resetBoardFromGame()
      return
    }
    await this.bootstrap()
    this.createBoard()
  }

  private loadRepertoire(text: string, name: string | null): void {
    const res = parsePgnToRepertoire(text)
    if ('error' in res) {
      this.setParseError(res.error ?? 'Could not parse PGN.')
      this.tree = null
      this.terminalLineCount = 0
      this.terminalPathKeys = new Set()
      this.completedPathKeys = new Set()
      this.branchDrills = new Map()
      this.pgnName = null
      this.hasTree = false
      this.game = new Chess()
      this.historySans = []
      this.resetBoardFromGame()
      this.setStatus('Load a PGN to start.')
      this.updateChrome()
      return
    }

    this.setParseError(null)
    this.pgnName = name
    this.tree = res.root
    this.terminalLineCount = res.terminalLineCount
    this.terminalPathKeys = res.terminalPathKeys
    this.completedPathKeys = new Set()
    this.branchDrills = new Map()
    this.hasTree = true

    logRepertoireTreeDfs(res.root)

    void (async () => {
      await this.bootstrap()
      this.createBoard()
      this.updateChrome()
    })()
  }

  private async onPgnFilePick(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement
    const file = input.files?.[0]
    input.value = ''
    if (!file) return
    try {
      const text = await file.text()
      this.loadRepertoire(text, file.name)
    }
    catch {
      this.setParseError('Could not read the file.')
    }
  }

  private async onTrainingFilePick(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement
    const file = input.files?.[0]
    input.value = ''
    if (!file) return
    const root = this.tree
    if (!root) {
      this.setParseError('Load a PGN first, then load training status.')
      return
    }
    try {
      const text = await file.text()
      const parsed = parseTrainingFileJson(text)
      if ('error' in parsed) {
        this.setParseError(parsed.error)
        return
      }
      applyTrainingStatus(root, parsed)
      this.setParseError(null)
      this.rebuildStatus()
    }
    catch {
      this.setParseError('Could not read the training file.')
    }
  }

  private onDragStart(_source: string, piece: string): boolean {
    if (piece[0] !== this.playerSide) return false
    if (!this.tree) return false
    const g = this.game
    if (g.turn() !== this.playerSide) return false
    const n = walkToNode(this.tree, this.historySans)
    if (!n || n.children.size === 0) return false
    return legalChildSans(g, n).length > 0
  }

  private onDrop(source: string, target: string): 'snapback' | void {
    if (!this.tree) return 'snapback'
    if (target === 'offboard') return 'snapback'

    const from = source as Square
    const to = target as Square

    // Pick up and put back on the same square — not a move.
    if (from === to) return

    const piece = this.game.get(from)
    if (!piece || piece.color !== this.playerSide) return 'snapback'
    if (this.game.turn() !== this.playerSide) return 'snapback'

    const root = this.tree
    const node = walkToNode(root, this.historySans)
    if (!node) return 'snapback'

    const outs = legalChildSans(this.game, node)
    if (outs.length === 0) return 'snapback'

    const match = findMatchingAmongOutcomes(this.game, from, to, outs)
    if (!match) {
      const attempt = describeDragAttempt(this.game, from, to)
      window.alert(
        attempt
          ? `That move is not in the repertoire here.\nPlayed: ${attempt}\nAllowed: ${outs.join(', ')}`
          : `Illegal move.\nAllowed from the file: ${outs.join(', ')}`,
      )
      return 'snapback'
    }

    const mv = applyUserMove(this.game, from, to, match)
    if (!mv) return 'snapback'

    const repSan = repertoireSanForPlayed(outs, mv.san)
    this.historySans.push(repSan ?? mv.san)

    // chessboard.js applies our drop visually in onSnapEnd; do not call position() here.
    this.settleAfterSnap = true
  }

  private async resetOpening(): Promise<void> {
    if (!this.tree) return
    this.completedPathKeys = new Set()
    this.branchDrills = new Map()
    resetNeedsPractice(this.tree)
    await this.bootstrap()
    this.createBoard()
  }
}
