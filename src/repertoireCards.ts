import { Chess } from 'chess.js'

import { countPlayerMoves, fenSig, forEachNodeDepthFirst, formatLine, type Node } from './moveTree'

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
    /** Every trie prefix (SANs from the start) that arrives here; used to set the position up. */
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
    /** The trainee's move number for this card along the shortest route to it (1 = first move). */
    depth: number
    /** Deterministic build order (sorted DFS), the tie-breaker for introducing new cards. */
    order: number
    /** A readable sample route ending in this card's move, e.g. "1. d4 d5 2. c4". */
    line: string
}

export type CardDeck = {
    side: 'w' | 'b'
    positions: Map<string, PositionNode>
    cards: Map<string, Card>
    cardsAt: Map<string, Card[]>
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

    const cards = new Map<string, Card>()
    const cardsAt = new Map<string, Card[]>()
    const conflicts: string[] = []
    let order = 0

    for (const pos of positions.values()) {
        if (pos.sideToMove !== side || pos.edges.size === 0) continue
        const shortest = pos.reachPaths.reduce((a, b) => (b.length < a.length ? b : a))
        const depth = countPlayerMoves(shortest, side) + 1
        const here: Card[] = []
        for (const edge of pos.edges.values()) {
            const card: Card = {
                id: cardId(pos.key, edge.uci),
                side,
                posKey: pos.key,
                fen: pos.fen,
                san: edge.san,
                uci: edge.uci,
                depth,
                order: order++,
                line: formatLine([...shortest, edge.san]).join(' '),
            }
            cards.set(card.id, card)
            here.push(card)
        }
        cardsAt.set(pos.key, here)
        if (here.length > 1)
            conflicts.push(`${formatLine(shortest).join(' ') || '<start>'} → ${here.map((c) => c.san).join(' / ')}`)
    }

    console.log(
        `[cards ${side === 'w' ? 'White' : 'Black'}] trie nodes=${trieNodes} positions=${positions.size} cards=${cards.size}`,
    )
    if (conflicts.length) {
        console.warn(
            `[cards ${side === 'w' ? 'White' : 'Black'}] positions with more than one book move for you:\n  ${conflicts.join('\n  ')}`,
        )
    }

    return { side, positions, cards, cardsAt }
}

/**
 * A route from the start position to this card's position (empty for White's first move):
 * random among the routes passing the fewest of the trainee's cards that `isLearning`, so
 * setup shows as few still-being-learned answers as possible.
 */
export function pickSetupPath(deck: CardDeck, card: Card, isLearning: (id: string) => boolean): string[] {
    const paths = deck.positions.get(card.posKey)?.reachPaths ?? [[]]
    if (paths.length === 1) return [...paths[0]!]
    let fewest = Infinity
    let best: string[][] = []
    for (const path of paths) {
        const game = new Chess()
        let learning = 0
        for (const san of path) {
            const key = fenSig(game.fen())
            const isTrainee = game.turn() === deck.side
            const move = game.move(san, { strict: false })
            if (isTrainee && isLearning(cardId(key, `${move.from}${move.to}${move.promotion ?? ''}`))) learning++
        }
        if (learning < fewest) {
            fewest = learning
            best = []
        }
        if (learning === fewest) best.push(path)
    }
    return [...best[Math.floor(Math.random() * best.length)]!]
}
