import { Chess } from 'chess.js'

/**
 * One position in the repertoire trie. Prefixes are shared; `children` holds outgoing SANs.
 */
export type Node = {
  fen: string
  /** SAN played from the parent position; empty at the start position. */
  moveFromPrevious: string
  needsPractice: boolean
  children: Map<string, Node>
}

// Builds a stable string key for a move list so we can compare paths and store training rows.
// Arguments: sans — ordered SANs from the start position to the node (empty array at root).
export function canonicalPathKey(sans: readonly string[]): string {
  return JSON.stringify([...sans])
}

// Collapses FEN to piece placement (and related fields) so we can bucket drills by position without clock noise.
// Arguments: fen — full FEN string from chess.js.
export function fenSig(fen: string): string {
  return fen.split(/\s+/).slice(0, 4).join(' ')
}

// Allocates the empty start node for a new repertoire trie (no moves yet).
// Arguments: none.
export function newTreeRoot(): Node {
  return {
    fen: new Chess().fen(),
    moveFromPrevious: '',
    needsPractice: true,
    children: new Map(),
  }
}

// Inserts one full SAN sequence into the trie, creating nodes only where missing so prefixes stay shared.
// Arguments: root — trie root; sans — iterable of SANs forming one variation from the start position.
export function insertPath(root: Node, sans: Iterable<string>): void {
  let n = root
  for (const san of sans) {
    let c = n.children.get(san)
    if (!c) {
      const g = new Chess(n.fen)
      if (!applySan(g, san)) return
      c = {
        fen: g.fen(),
        moveFromPrevious: san,
        needsPractice: true,
        children: new Map(),
      }
      n.children.set(san, c)
    }
    n = c
  }
}

// Walks the trie along a SAN list so the trainer can know which repertoire node matches the current game.
// Arguments: root — trie root; sans — played moves in order from the start (empty means stay at root).
export function walkToNode(root: Node, sans: Iterable<string>): Node | null {
  let n = root
  for (const san of sans) {
    const c = n.children.get(san)
    if (!c) return null
    n = c
  }
  return n
}

// Applies one SAN on a scratch board without throwing, so parsers and trainers can probe moves safely.
// Arguments: game — mutates in place; san — standard algebraic notation string.
export function applySan(game: Chess, san: string): boolean {
  try {
    game.move(san, { strict: false })
    return true
  }
  catch {
    return false
  }
}

// Intersects repertoire edges with chess.js legals so we never suggest an illegal book move at this FEN.
// Arguments: game — current position; node — trie node matching that position’s SAN prefix.
export function legalChildSans(game: Chess, node: Node): string[] {
  const legal = new Set(game.moves({ verbose: false }))
  const out: string[] = []
  for (const san of node.children.keys()) {
    if (legal.has(san)) out.push(san)
  }
  return out
}

// Visits every trie node once in deterministic DFS order (sorted child SANs) for exports, resets, and debug logs.
// Arguments: root — trie root; fn — callback receiving each node and the SAN path from root to that node.
export function forEachNodeDepthFirst(root: Node, fn: (n: Node, pathSans: readonly string[]) => void): void {
  // Recursive step: extend pathSans by one SAN when descending an edge.
  // Arguments: n — current node; pathSans — SANs from root to parent of n (empty at root).
  function dfs(n: Node, pathSans: string[]): void {
    fn(n, pathSans)
    for (const san of [...n.children.keys()].sort()) {
      const c = n.children.get(san)
      if (c) dfs(c, [...pathSans, san])
    }
  }
  dfs(root, [])
}

// Clears practice flags for a fresh session while keeping the same shape of the tree.
// Arguments: root — trie root whose every node will get needsPractice = true.
export function resetNeedsPractice(root: Node): void {
  forEachNodeDepthFirst(root, (n) => {
    n.needsPractice = true
  })
}

// Prints the whole repertoire to the browser console after PGN import to verify structure and path keys.
// Arguments: root — trie root to dump.
export function logRepertoireTreeDfs(root: Node): void {
  console.log('[repertoire tree DFS]')
  forEachNodeDepthFirst(root, (n, pathSans) => {
    const depth = pathSans.length
    const indent = '  '.repeat(depth)
    const label = depth === 0 ? '<root>' : pathSans[depth - 1]
    const pk = canonicalPathKey(pathSans)
    const fenShort = n.fen.split(/\s+/).slice(0, 4).join(' ')
    console.log(
      `${indent}${label}  pathKey=${pk}  fen=${fenShort}  needsPractice=${n.needsPractice}  branches=${n.children.size}`,
    )
  })
  console.log('[end repertoire tree DFS]')
}
