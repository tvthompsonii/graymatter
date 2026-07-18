import { parseGame, parseGames, split } from '@jackstenglein/pgn-parser'
import type { PgnMove } from '@jackstenglein/pgn-parser'

import type { Node } from './moveTree'
import { applySan as applySanUnsafe, canonicalPathKey, insertPath, newTreeRoot } from './moveTree'
import type { Chess } from 'chess.js'
import { Chess as ChessCtor } from 'chess.js'

// Reads the parser’s SAN text for one move so we can feed chess.js and our trie consistently.
// Arguments: move — jackstenglein move node.
function sanOf(move: PgnMove): string {
    return move.notation.notation.trim()
}

// Tells whether a parenthesized variation replaces the main move or continues after it, because parser turn flags can lie.
// Arguments: fenBeforeHead — FEN before the main move; head — main-line move node; variation — first line of the variation.
function classifyVariation(
    fenBeforeHead: string,
    head: PgnMove,
    variation: PgnMove[],
): 'alternate' | 'continuation' {
    const vm = variation[0]
    if (!vm) return 'continuation'

    const mainSan = sanOf(head)
    const gAfterMain = new ChessCtor(fenBeforeHead)
    try {
        gAfterMain.move(mainSan, { strict: false })
    }
    catch {
        return 'alternate'
    }

    const vSan = sanOf(vm)
    try {
        const testCont = new ChessCtor(gAfterMain.fen())
        testCont.move(vSan, { strict: false })
        return 'continuation'
    }
    catch {
        /* not legal after head */
    }

    try {
        const testAlt = new ChessCtor(fenBeforeHead)
        testAlt.move(vSan, { strict: false })
        return 'alternate'
    }
    catch {
        return 'continuation'
    }
}

// Splices a variation fragment onto the remaining main-line tail so one recursive walk sees the full order.
// Arguments: line — variation head moves; tail — remaining main move list after the current head.
function mergeContinuation(line: PgnMove[], tail: PgnMove[]): PgnMove[] {
    return line.concat(tail)
}

// Depth-first walk of the parser’s move tree to collect every leaf SAN sequence (full variations).
// Arguments: moveList — remaining moves from this position; gameBeforeFirst — board before moveList[0]; pathAccum — SANs played to get here; outPaths — collector for completed SAN arrays.
function traverseMoveList(
    moveList: PgnMove[],
    gameBeforeFirst: Chess,
    pathAccum: string[],
    outPaths: string[][],
): void {
    if (moveList.length === 0) {
        if (pathAccum.length) outPaths.push([...pathAccum])
        return
    }

    const head = moveList[0]
    const tail = moveList.slice(1)
    const fenBefore = gameBeforeFirst.fen()

    const continuationVars: PgnMove[][] = []
    const alternateVars: PgnMove[][] = []

    for (const v of head.variations ?? []) {
        if (!v?.length) continue
        const kind = classifyVariation(fenBefore, head, v)
        ;(kind === 'alternate' ? alternateVars : continuationVars).push(v)
    }

    const headSan = sanOf(head)

    /* --- Main line applies `headSan` --- */
    const gameAfterMain = new ChessCtor(gameBeforeFirst.fen())
    if (!applySanUnsafe(gameAfterMain, headSan)) return

    const pathAfterMain = [...pathAccum, headSan]

    if (continuationVars.length > 0) {
        for (const cv of continuationVars)
            traverseMoveList(
                mergeContinuation(cv, tail),
                gameAfterMain,
                pathAfterMain,
                outPaths,
            )
    }
    /* Continue the main-line tail even when parentheses add longer sidelines (optional stops). */
    traverseMoveList(tail, gameAfterMain, pathAfterMain, outPaths)

    /* --- Alternatives that replace `headSan` (same turn as head, e.g. ...a5 vs ...h5) --- */
    /* Do not merge `tail`: those moves belong only after the main-line `head`, not after the RAV. */
    for (const av of alternateVars) {
        const gm = new ChessCtor(fenBefore)
        const altSan = sanOf(av[0]!)
        if (!applySanUnsafe(gm, altSan)) continue
        const pathAlt = [...pathAccum, altSan]
        traverseMoveList(av.slice(1), gm, pathAlt, outPaths)
    }
}

export type ParsedRepertoire = {
    paths: string[][]
    root: Node
    terminalLineCount: number
    terminalPathKeys: ReadonlySet<string>
    error?: string
}

// Normalizes line endings so multi-line PGNs parse the same on Windows and Unix exports.
// Arguments: raw — raw file text before parsing.
function normalizePgnText(raw: string): string {
    return raw.trim().replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

// Pulls every game’s move array out of odd PGN exports by trying multi-game parse first, then physical splits.
// Arguments: trimmedText — already trimmed PGN string.
function extractMoveListsAllStrategies(trimmedText: string): PgnMove[][] {
    const out: PgnMove[][] = []

    try {
        for (const g of parseGames(trimmedText)) {
            if (g.moves?.length) out.push(g.moves)
        }
    }
    catch {
        /* ignore */
    }

    try {
        for (const seg of split(trimmedText)) {
            try {
                const body
                    = seg.all?.trim()?.length ? seg.all.trim() : [seg.tags, seg.pgn].filter(Boolean).join('\n\n')
                if (!body.trim()) continue
                const tree = parseGame(body.trim())
                if (tree.moves?.length) out.push(tree.moves)
            }
            catch {
                /* skip bad segment */
            }
        }
    }
    catch {
        /* ignore */
    }

    return out
}

// End-to-end PGN string parse: normalize text, gather move lists, build trie, or return a human-readable error.
// Arguments: pgnText — full PGN file contents.
export function parsePgnToRepertoire(pgnText: string): ParsedRepertoire | { error: string } {
    try {
        const trimmed = normalizePgnText(pgnText)
        const moveLists = extractMoveListsAllStrategies(trimmed)
        if (!moveLists.length) return { error: 'No games or moves found in PGN.' }
        const r = repertoireFromGamesMoveLists(moveLists)
        if (!r.paths.length) return { error: 'Could not derive any moves from this PGN.' }
        return r
    }
    catch {
        return { error: 'Could not parse PGN.' }
    }
}

// Merges every parsed game’s variations into deduped SAN paths, drops redundant short stops, then fills one trie.
// Arguments: moveLists — one parser move array per game or segment found in the file.
export function repertoireFromGamesMoveLists(moveLists: PgnMove[][]): ParsedRepertoire {
    const outPaths: string[][] = []

    const start = new ChessCtor()
    for (const roots of moveLists) {
        if (!roots?.length) continue
        traverseMoveList(roots, start, [], outPaths)
    }

    const merged = dedupeSanPaths(outPaths)
    const dedupe = dropPathsStrictlyExtendedByOthers(merged)
    if (!dedupe.length) {
        return {
            paths: [],
            root: newTreeRoot(),
            terminalLineCount: 0,
            terminalPathKeys: new Set(),
        }
    }

    const terminalPathKeys = new Set<string>(dedupe.map((p) => canonicalPathKey(p)))

    const root = newTreeRoot()
    for (const p of dedupe) insertPath(root, p)

    return {
        paths: dedupe,
        root,
        terminalLineCount: dedupe.length,
        terminalPathKeys,
    }
}

// Removes exact duplicate terminal paths so the trie and progress counters do not double-count the same line.
// Arguments: paths — raw SAN sequences collected from the PGN walk.
function dedupeSanPaths(paths: string[][]): string[][] {
    const seen = new Set<string>()
    const out: string[][] = []
    for (const p of paths) {
        const k = canonicalPathKey(p)
        if (!p.length || seen.has(k)) continue
        seen.add(k)
        out.push([...p])
    }
    return out
}

// True when prefix is a strict initial segment of full (same moves in order, shorter length).
// Arguments: prefix — candidate prefix; full — candidate extension line.
function isStrictPrefix(prefix: readonly string[], full: readonly string[]): boolean {
    if (prefix.length >= full.length) return false
    for (let i = 0; i < prefix.length; i++) {
        if (prefix[i] !== full[i])
            return false
    }
    return true
}

// Removes “stop early” paths when a longer line in the same file continues the same moves, so training targets real leaves.
// Arguments: paths — deduped SAN paths before prefix suppression.
function dropPathsStrictlyExtendedByOthers(paths: string[][]): string[][] {
    const sorted = [...paths].sort((a, b) => b.length - a.length)
    const keep: string[][] = []
    for (const p of sorted) {
        if (keep.some((longer) => isStrictPrefix(p, longer)))
            continue
        keep.push(p)
    }
    return keep
}
