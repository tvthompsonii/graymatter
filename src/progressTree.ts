import { cardId, type CardDeck } from './repertoireCards'
import type { ReviewRecord, Schedule } from './srs'

/** One book move in the Progress tree. */
export type ProgressNode = {
    /** The SANs from the start joined by spaces ('' for the start position). */
    id: string
    san: string
    path: string[]
    /** `fenSig` of the position after this move. */
    posKey: string
    isTrainee: boolean
    /** The trainee's card for this move; null for opponent moves and the start node. */
    cardId: string | null
    /** This node shows the continuation of a position that other move orders also reach. */
    transposed: boolean
    /** Another move order into a position whose continuation is shown elsewhere: that position's main route. */
    transposesTo: string[] | null
    children: ProgressNode[]
    /** Distinct card ids in this subtree, this node included. */
    subtreeCards: string[]
}

/**
 * Builds the Progress tree from the deck's position graph, so each position's continuation is
 * drawn once, under its main (canonical) route: the shortest, then alphabetically first. Every
 * other move order into it ends in a `transposesTo` leaf. Built from the graph rather than the
 * PGN, a normalized and a denormalized repertoire draw the same tree.
 */
export function buildProgressTree(deck: CardDeck): ProgressNode {
    // How many book moves lead into each position, over every route.
    const inDegree = new Map<string, number>()
    for (const pos of deck.positions.values())
        for (const edge of pos.edges.values()) inDegree.set(edge.toKey, (inDegree.get(edge.toKey) ?? 0) + 1)

    function build(key: string, path: string[], card: string | null): ProgressNode {
        const pos = deck.positions.get(key)
        const id = path.join(' ')
        const main = deck.canonical.get(key)
        const isMain = !!main && main.join(' ') === id
        const hasMoves = !!pos && pos.edges.size > 0

        const children = isMain && pos
            ? [...pos.edges.values()]
                .sort((a, b) => (a.san < b.san ? -1 : a.san > b.san ? 1 : 0))
                .map((edge) => build(
                    edge.toKey,
                    [...path, edge.san],
                    pos.sideToMove === deck.side ? cardId(key, edge.uci) : null,
                ))
            : []

        const cards = new Set<string>(card ? [card] : [])
        for (const child of children) for (const c of child.subtreeCards) cards.add(c)

        return {
            id,
            san: path[path.length - 1] ?? '',
            path,
            posKey: key,
            isTrainee: card !== null,
            cardId: card,
            transposed: isMain && hasMoves && (inDegree.get(key) ?? 0) > 1,
            transposesTo: !isMain && hasMoves && main ? main : null,
            children,
            subtreeCards: [...cards],
        }
    }
    return build(deck.startKey, [], null)
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
