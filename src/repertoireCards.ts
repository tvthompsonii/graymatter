import { Chess } from 'chess.js'

import { fenSig, forEachNodeDepthFirst, formatLine, type Node } from './moveTree'

/** One book move out of a position, keyed by UCI so SAN spelling (e.g. a missing "+") can't split it. */
export type BookEdge = {
    san: string
    uci: string
    /** `fenSig` of the position after the move. */
    toKey: string
}

/**
 * A repertoire position with every trie node that reaches it merged in, so transpositions share
 * one node and one set of outgoing book moves.
 */
export type PositionNode = {
    key: string
    fen: string
    sideToMove: 'w' | 'b'
    edges: Map<string, BookEdge>
    /** Every trie prefix (SANs from the start) written in the PGN that arrives here (Progress uses these; Drill doesn't). */
    reachPaths: string[][]
}

/** One spaced-repetition card: the trainee's book move from one position. */
export type Card = {
    /** `${posKey} | ${uci}`; also the row id in TrainingStatus.json. */
    id: string
    side: 'w' | 'b'
    posKey: string
    fen: string
    san: string
    uci: string
    /** The trainee's move number for this card along the shortest book route to it (1 = first move). */
    depth: number
    /** Position in the sorted order of canonical routes (so branches stay together); the tie-breaker for introducing new cards. */
    order: number
    /** The canonical route ending in this card's move, e.g. "1. d4 d5 2. c4". */
    line: string
}

/** A book move into a position, for walking the graph backwards. */
export type InEdge = { fromKey: string; san: string; uci: string }

/**
 * Drill reads only the graph (positions, edges, `incoming`, `dist`), never the PGN's written
 * routes, so a normalized PGN (a transposition's continuation written once) and a denormalized
 * one (written after every route) give the same deck.
 */
export type CardDeck = {
    side: 'w' | 'b'
    positions: Map<string, PositionNode>
    cards: Map<string, Card>
    cardsAt: Map<string, Card[]>
    startKey: string
    /** Plies from the start along the shortest book route. */
    dist: Map<string, number>
    /** Book moves into each position from one ply closer to the start (shortest routes only). */
    incoming: Map<string, InEdge[]>
    /** Each position's canonical route: the lexicographically smallest of its shortest book routes. */
    canonical: Map<string, string[]>
}

/** Elementwise compare of SAN arrays (code-unit order, like the trie's sorted DFS). */
function compareRoutes(a: readonly string[], b: readonly string[]): number {
    for (let i = 0; i < Math.min(a.length, b.length); i++)
        if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1
    return a.length - b.length
}

export function cardId(posKey: string, uci: string): string {
    return `${posKey} | ${uci}`
}

/** The trainee side encoded in a card id (its position's side to move). */
export function sideOfCardId(id: string): 'w' | 'b' | null {
    const side = id.split(' ')[1]
    return side === 'w' || side === 'b' ? side : null
}

/**
 * Folds a repertoire trie into a position graph and makes one card per trainee move. Cards are
 * keyed by position, so a move reached by several move orders is a single card.
 */
export function buildCardDeck(root: Node, side: 'w' | 'b'): CardDeck {
    const positions = new Map<string, PositionNode>()
    let trieNodes = 0

    forEachNodeDepthFirst(root, (n, pathSans) => {
        trieNodes++
        const key = fenSig(n.fen)
        let pos = positions.get(key)
        if (!pos) {
            pos = {
                key,
                fen: n.fen,
                sideToMove: n.fen.split(' ')[1] === 'b' ? 'b' : 'w',
                edges: new Map(),
                reachPaths: [],
            }
            positions.set(key, pos)
        }
        pos.reachPaths.push([...pathSans])

        for (const [san, child] of n.children) {
            try {
                const move = new Chess(n.fen).move(san, { strict: false })
                const uci = `${move.from}${move.to}${move.promotion ?? ''}`
                if (!pos.edges.has(uci))
                    pos.edges.set(uci, { san: move.san, uci, toKey: fenSig(child.fen) })
            }
            catch {
                // insertPath only keeps legal moves, so this can't happen; skip it if it does.
            }
        }
    })

    // Breadth-first from the start: shortest distances, the shortest-route predecessors of each
    // position, and a canonical route (the lexicographically smallest shortest route).
    const startKey = fenSig(root.fen)
    const dist = new Map<string, number>([[startKey, 0]])
    const incoming = new Map<string, InEdge[]>()
    const canonical = new Map<string, string[]>([[startKey, []]])
    const queue = [startKey]
    for (let head = 0; head < queue.length; head++) {
        const key = queue[head]!
        const d = dist.get(key)!
        for (const edge of positions.get(key)!.edges.values()) {
            const known = dist.get(edge.toKey)
            if (known === undefined) {
                dist.set(edge.toKey, d + 1)
                incoming.set(edge.toKey, [])
                queue.push(edge.toKey)
            }
            else if (known !== d + 1) {
                continue
            }
            incoming.get(edge.toKey)!.push({ fromKey: key, san: edge.san, uci: edge.uci })
            const route = [...canonical.get(key)!, edge.san]
            const best = canonical.get(edge.toKey)
            if (!best || compareRoutes(route, best) < 0) canonical.set(edge.toKey, route)
        }
    }

    const built: Card[] = []
    for (const pos of positions.values()) {
        if (pos.sideToMove !== side || pos.edges.size === 0) continue
        const route = canonical.get(pos.key) ?? []
        for (const edge of pos.edges.values()) {
            built.push({
                id: cardId(pos.key, edge.uci),
                side,
                posKey: pos.key,
                fen: pos.fen,
                san: edge.san,
                uci: edge.uci,
                // The trainee to move after `route.length` plies has made floor(plies / 2) moves.
                depth: Math.floor(route.length / 2) + 1,
                order: 0,
                line: formatLine([...route, edge.san]).join(' '),
            })
        }
    }
    const routeOf = (c: Card) => [...(canonical.get(c.posKey) ?? []), c.san]
    built.sort((a, b) => compareRoutes(routeOf(a), routeOf(b)))

    const cards = new Map<string, Card>()
    const cardsAt = new Map<string, Card[]>()
    built.forEach((card, order) => {
        card.order = order
        cards.set(card.id, card)
        const here = cardsAt.get(card.posKey)
        if (here) here.push(card)
        else cardsAt.set(card.posKey, [card])
    })
    const conflicts: string[] = []
    for (const [key, here] of cardsAt) {
        if (here.length > 1)
            conflicts.push(`${formatLine(canonical.get(key) ?? []).join(' ') || '<start>'} → ${here.map((c) => c.san).join(' / ')}`)
    }

    console.log(
        `[cards ${side === 'w' ? 'White' : 'Black'}] trie nodes=${trieNodes} positions=${positions.size} cards=${cards.size}`,
    )
    if (conflicts.length) {
        console.warn(
            `[cards ${side === 'w' ? 'White' : 'Black'}] positions with more than one book move for you:\n  ${conflicts.join('\n  ')}`,
        )
    }

    return { side, positions, cards, cardsAt, startKey, dist, incoming, canonical }
}

/**
 * A book route from the start position to this card's position (empty for White's first move),
 * built from the graph, so every move order that reaches a transposition is possible even if the
 * PGN writes the continuation after only one of them. Among the shortest routes it keeps those
 * passing the fewest of the trainee's cards that `isLearning` (so setup shows as few
 * still-being-learned answers as possible), and picks one of those uniformly at random.
 */
export function pickSetupPath(deck: CardDeck, card: Card, isLearning: (id: string) => boolean): string[] {
    // The positions on some shortest route to the card, nearest the start first.
    const ancestors = new Set<string>([card.posKey])
    const stack = [card.posKey]
    while (stack.length) {
        for (const e of deck.incoming.get(stack.pop()!) ?? []) {
            if (ancestors.has(e.fromKey)) continue
            ancestors.add(e.fromKey)
            stack.push(e.fromKey)
        }
    }
    const ordered = [...ancestors].sort((a, b) => (deck.dist.get(a) ?? 0) - (deck.dist.get(b) ?? 0))

    const cost = (e: InEdge) =>
        deck.positions.get(e.fromKey)?.sideToMove === deck.side && isLearning(cardId(e.fromKey, e.uci)) ? 1 : 0
    // Fewest learning moves to reach each position, and how many routes achieve it.
    const fewest = new Map<string, number>([[deck.startKey, 0]])
    const routes = new Map<string, number>([[deck.startKey, 1]])
    for (const key of ordered) {
        if (key === deck.startKey) continue
        let best = Infinity
        let count = 0
        for (const e of deck.incoming.get(key) ?? []) {
            const n = (fewest.get(e.fromKey) ?? Infinity) + cost(e)
            if (n < best) {
                best = n
                count = 0
            }
            if (n === best) count += routes.get(e.fromKey) ?? 0
        }
        fewest.set(key, best)
        routes.set(key, count)
    }

    // Walk back from the card, choosing each step in proportion to the best routes behind it.
    const sans: string[] = []
    let key = card.posKey
    while (key !== deck.startKey) {
        const target = fewest.get(key)!
        const options = (deck.incoming.get(key) ?? [])
            .filter((e) => (fewest.get(e.fromKey) ?? Infinity) + cost(e) === target)
        const total = options.reduce((sum, e) => sum + (routes.get(e.fromKey) ?? 0), 0)
        let pick = Math.random() * total
        let chosen = options[options.length - 1]!
        for (const e of options) {
            pick -= routes.get(e.fromKey) ?? 0
            if (pick < 0) {
                chosen = e
                break
            }
        }
        sans.push(chosen.san)
        key = chosen.fromKey
    }
    return sans.reverse()
}
