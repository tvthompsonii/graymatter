import { Chess } from 'chess.js'

import { fenSig, walkToNode, type Node } from './moveTree'
import { cardId, type CardDeck } from './repertoireCards'
import type { ReviewRecord, Schedule } from './srs'

/** One move of the repertoire trie, for the Progress view. */
export type ProgressNode = {
    /** The SANs from the start joined by spaces ('' for the start position). */
    id: string
    san: string
    path: string[]
    isTrainee: boolean
    /** The trainee's card for this move; null for opponent moves and the start node. */
    cardId: string | null
    /** The card's position is reached by more than one written route, so this card shows up in several places. */
    transposed: boolean
    /** A leaf whose position continues elsewhere in the book: the written route to that continuation. */
    transposesTo: string[] | null
    children: ProgressNode[]
    /** Distinct card ids in this subtree, this node included (a transposed card counts once). */
    subtreeCards: string[]
}

/** Builds the Progress tree from a repertoire trie; `deck` is the same side's card deck. */
export function buildProgressTree(root: Node, deck: CardDeck): ProgressNode {
    function build(n: Node, path: string[], parentFen: string | null): ProgressNode {
        const san = path[path.length - 1] ?? ''
        let id: string | null = null
        let transposed = false
        if (parentFen) {
            const parentKey = fenSig(parentFen)
            if (parentFen.split(' ')[1] === deck.side) {
                const move = new Chess(parentFen).move(san, { strict: false })
                id = cardId(parentKey, `${move.from}${move.to}${move.promotion ?? ''}`)
                transposed = (deck.positions.get(parentKey)?.reachPaths.length ?? 0) > 1
            }
        }

        const children = [...n.children.keys()].sort().map((childSan) => build(n.children.get(childSan)!, [...path, childSan], n.fen))

        let transposesTo: string[] | null = null
        if (!children.length) {
            const pos = deck.positions.get(fenSig(n.fen))
            if (pos && pos.edges.size > 0)
                transposesTo = pos.reachPaths.find((p) => (walkToNode(root, p)?.children.size ?? 0) > 0) ?? null
        }

        const cards = new Set<string>(id ? [id] : [])
        for (const child of children) for (const c of child.subtreeCards) cards.add(c)

        return {
            id: path.join(' '),
            san,
            path,
            isTrainee: id !== null,
            cardId: id,
            transposed,
            transposesTo,
            children,
            subtreeCards: [...cards],
        }
    }
    return build(root, [], null)
}

export type CardStatus = 'untrained' | 'learning' | 'review' | 'relearning'

export function cardStatus(record: ReviewRecord | undefined): CardStatus {
    return record ? record.state : 'untrained'
}

export type SubtreeCounts = Record<CardStatus, number> & { total: number; due: number }

/** Counts by status of the given cards, only those within `maxDepth`. */
export function countCards(ids: Iterable<string>, deck: CardDeck, schedule: Schedule, maxDepth: number, nowMs: number): SubtreeCounts {
    const counts: SubtreeCounts = { total: 0, due: 0, untrained: 0, learning: 0, review: 0, relearning: 0 }
    for (const id of ids) {
        const card = deck.cards.get(id)
        if (!card || card.depth > maxDepth) continue
        const r = schedule.get(id)
        counts.total++
        counts[cardStatus(r)]++
        if (r && Date.parse(r.due) <= nowMs) counts.due++
    }
    return counts
}

export type PlacedNode = { node: ProgressNode; x: number; y: number }
export type TreeLayout = {
    nodes: PlacedNode[]
    edges: { from: PlacedNode; to: PlacedNode }[]
    /** Size in grid units: columns (plies) and rows (visible leaves). */
    columns: number
    rows: number
}

/**
 * Left-to-right tidy layout in grid units: x is the ply, each visible leaf takes the next row,
 * and a parent sits centered on its visible children. Only expanded nodes show their children.
 */
export function layoutTree(root: ProgressNode, expanded: ReadonlySet<string>): TreeLayout {
    const nodes: PlacedNode[] = []
    const edges: TreeLayout['edges'] = []
    let nextRow = 0
    let columns = 0

    function place(n: ProgressNode): PlacedNode {
        const x = n.path.length
        columns = Math.max(columns, x + 1)
        const open = n.children.length > 0 && (n.id === '' || expanded.has(n.id))
        let placed: PlacedNode
        if (open) {
            const kids = n.children.map(place)
            placed = { node: n, x, y: (kids[0]!.y + kids[kids.length - 1]!.y) / 2 }
            for (const kid of kids) edges.push({ from: placed, to: kid })
        }
        else {
            placed = { node: n, x, y: nextRow++ }
        }
        nodes.push(placed)
        return placed
    }

    place(root)
    return { nodes, edges, columns, rows: nextRow }
}

/** Every node id along `path` (the start excluded), i.e. what must be expanded to show its last move. */
export function prefixIds(path: readonly string[]): string[] {
    const ids: string[] = []
    for (let i = 1; i < path.length; i++) ids.push(path.slice(0, i).join(' '))
    return ids
}

/** Expanded ids showing every node up to `plies` moves from the start. */
export function expandToDepth(root: ProgressNode, plies: number): Set<string> {
    const out = new Set<string>()
    function walk(n: ProgressNode) {
        if (n.path.length >= plies) return
        if (n.id) out.add(n.id)
        for (const c of n.children) walk(c)
    }
    walk(root)
    return out
}
