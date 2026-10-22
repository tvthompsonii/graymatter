import type { Card, CardDeck } from './repertoireCards'

export type ReviewState = 'learning' | 'review' | 'relearning'

/** Saved schedule for one card. A card with no record is new. */
export type ReviewRecord = {
    id: string
    /** Copied from the card for reading TrainingStatus.json by eye; not used for scheduling. */
    san: string
    line: string
    state: ReviewState
    /** ISO timestamp the card is next due. */
    due: string
    /** Review interval; while (re)learning, the interval to use once the card graduates. */
    intervalDays: number
    ease: number
    reps: number
    lapses: number
    /** Index into the current learning steps while learning or relearning. */
    step: number
    /** Local date (YYYY-MM-DD) of the first review, for the new-cards-per-day cap. */
    introduced: string
    lastReviewed: string
}

/** Every card's record by id, both sides together (the id encodes the side). */
export type Schedule = Map<string, ReviewRecord>

const LEARNING_STEPS_MIN = [1, 10]
const RELEARNING_STEPS_MIN = [10]
const STARTING_EASE = 2.5
const MIN_EASE = 1.3
const LAPSE_EASE_PENALTY = 0.2
/** When nothing is due or new, learning cards due within this window are shown early. */
const LEARN_AHEAD_MS = 20 * 60_000

const MINUTE_MS = 60_000
const DAY_MS = 24 * 60 * MINUTE_MS

/** YYYY-MM-DD in local time. */
export function localDate(date: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function roundDays(days: number): number {
    return Math.round(days * 100) / 100
}

/** ±5% so cards learned together don't all come due on the same day. */
function fuzz(days: number): number {
    if (days < 2) return days
    return days * (0.95 + Math.random() * 0.1)
}

/** SM-2 with pass/fail grading (a pass is SM-2's q=4, so ease only changes on a lapse). */
export function gradeCard(card: Card, previous: ReviewRecord | undefined, pass: boolean, now: Date): ReviewRecord {
    const r: ReviewRecord = previous
        ? { ...previous }
        : {
            id: card.id,
            san: card.san,
            line: card.line,
            state: 'learning',
            due: now.toISOString(),
            intervalDays: 0,
            ease: STARTING_EASE,
            reps: 0,
            lapses: 0,
            step: 0,
            introduced: localDate(now),
            lastReviewed: now.toISOString(),
        }
    r.san = card.san
    r.line = card.line
    r.lastReviewed = now.toISOString()
    let dueMs: number

    if (r.state === 'review') {
        if (pass) {
            r.intervalDays = roundDays(fuzz(r.reps <= 1 ? Math.max(6, r.intervalDays) : r.intervalDays * r.ease))
            r.reps++
            dueMs = r.intervalDays * DAY_MS
        }
        else {
            r.lapses++
            r.ease = roundDays(Math.max(MIN_EASE, r.ease - LAPSE_EASE_PENALTY))
            r.intervalDays = roundDays(Math.max(1, r.intervalDays * 0.5))
            r.state = 'relearning'
            r.step = 0
            dueMs = RELEARNING_STEPS_MIN[0]! * MINUTE_MS
        }
    }
    else {
        const steps = r.state === 'learning' ? LEARNING_STEPS_MIN : RELEARNING_STEPS_MIN
        r.step = pass ? r.step + 1 : 0
        if (r.step >= steps.length) {
            // Graduate: a new card starts at 1 day, a relearned card keeps its reduced interval.
            if (r.state === 'learning') r.intervalDays = 1
            r.state = 'review'
            r.reps = Math.max(1, r.reps)
            r.step = 0
            dueMs = r.intervalDays * DAY_MS
        }
        else {
            dueMs = steps[r.step]! * MINUTE_MS
        }
    }

    r.due = new Date(now.getTime() + dueMs).toISOString()
    return r
}

export type PickOptions = {
    now: Date
    maxDepth: number
    newPerDay: number
    /** The card just answered; not shown again before it's really due. */
    excludeId?: string | null
}

export type PickedCard = { card: Card; kind: 'due' | 'new' | 'ahead' }

/** Number of cards first reviewed today, across both sides (and every client, via the file). */
export function introducedToday(schedule: Schedule, now: Date): number {
    const today = localDate(now)
    let count = 0
    for (const r of schedule.values()) if (r.introduced === today) count++
    return count
}

function eligibleCards(decks: readonly CardDeck[], maxDepth: number): Card[] {
    const out: Card[] = []
    for (const deck of decks)
        for (const card of deck.cards.values())
            if (card.depth <= maxDepth) out.push(card)
    return out
}

function dueMsOf(r: ReviewRecord): number {
    return Date.parse(r.due)
}

/** Due cards most-overdue first, then new cards shallowest first, then learning cards due soon. */
export function pickNextCard(
    decks: readonly CardDeck[],
    schedule: Schedule,
    { now, maxDepth, newPerDay, excludeId }: PickOptions,
): PickedCard | null {
    const nowMs = now.getTime()
    const cards = eligibleCards(decks, maxDepth)

    const due = cards
        .filter((c) => {
            const r = schedule.get(c.id)
            return r && dueMsOf(r) <= nowMs
        })
        .map((card) => ({ card, dueMs: dueMsOf(schedule.get(card.id)!), tie: Math.random() }))
        .sort((a, b) => a.dueMs - b.dueMs || a.tie - b.tie)
    if (due.length) return { card: due[0]!.card, kind: 'due' }

    if (introducedToday(schedule, now) < newPerDay) {
        const fresh = cards
            .filter((c) => !schedule.has(c.id))
            .sort((a, b) => a.depth - b.depth || a.order - b.order)
        if (fresh.length) return { card: fresh[0]!, kind: 'new' }
    }

    const ahead = cards
        .filter((c) => {
            const r = schedule.get(c.id)
            return r && r.state !== 'review' && c.id !== excludeId && dueMsOf(r) <= nowMs + LEARN_AHEAD_MS
        })
        .sort((a, b) => dueMsOf(schedule.get(a.id)!) - dueMsOf(schedule.get(b.id)!))
    if (ahead.length) return { card: ahead[0]!, kind: 'ahead' }

    return null
}

/** Book moves to play from the current position (opponent replies and any not-due trainee moves) to reach `card`. */
export type ChainPick = { sans: string[]; card: Card }

/**
 * After the trainee's move, the book continuation to the nearest card worth testing now, so the
 * drill keeps playing the line instead of jumping. The trainee's own moves along the way whose
 * cards aren't due are auto-played. The nearest testable card wins: due, new (within today's
 * cap), or, only with `allowAhead` (when a jump would pick one too), a learning card due soon;
 * at equal distance due beats new. Null ends the chain.
 */
export function pickChainPath(
    deck: CardDeck,
    schedule: Schedule,
    positionKey: string,
    { now, maxDepth, newPerDay, excludeId }: PickOptions,
    allowAhead: boolean,
): ChainPick | null {
    const nowMs = now.getTime()
    const newAllowed = introducedToday(schedule, now) < newPerDay

    // 0 = due, 1 = new, 2 = learning and due soon; null = not worth testing now.
    const tierOf = (card: Card): number | null => {
        if (card.depth > maxDepth || card.id === excludeId) return null
        const r = schedule.get(card.id)
        if (!r) return newAllowed ? 1 : null
        const dueMs = dueMsOf(r)
        if (dueMs <= nowMs) return 0
        if (allowAhead && r.state !== 'review' && dueMs <= nowMs + LEARN_AHEAD_MS) return 2
        return null
    }

    let best: { tier: number; length: number; picks: ChainPick[] } | null = null
    const visited = new Set<string>([positionKey])
    const queue: { key: string; sans: string[] }[] = [{ key: positionKey, sans: [] }]
    while (queue.length) {
        const { key, sans } = queue.shift()!
        // Breadth-first, so once a pick is found nothing longer can tie with it.
        if (best && sans.length > best.length) break
        const pos = deck.positions.get(key)
        if (!pos) continue

        const next: { san: string; toKey: string }[] = []
        if (pos.sideToMove === deck.side && sans.length > 0) {
            const here = deck.cardsAt.get(key) ?? []
            let found = false
            for (const card of here) {
                const tier = tierOf(card)
                if (tier === null) continue
                found = true
                if (!best || tier < best.tier) best = { tier, length: sans.length, picks: [] }
                if (tier === best.tier) best.picks.push({ sans, card })
            }
            // Stop this branch at a card to test; otherwise auto-play the trainee's book moves.
            if (found) continue
            for (const card of here) {
                const edge = pos.edges.get(card.uci)
                if (edge && card.depth <= maxDepth) next.push(edge)
            }
        }
        else if (pos.sideToMove !== deck.side) {
            next.push(...pos.edges.values())
        }

        for (const edge of next) {
            if (visited.has(edge.toKey)) continue
            visited.add(edge.toKey)
            queue.push({ key: edge.toKey, sans: [...sans, edge.san] })
        }
    }

    if (!best) return null
    return best.picks[Math.floor(Math.random() * best.picks.length)]!
}

export type DeckStats = {
    total: number
    learned: number
    dueNow: number
    newLeftToday: number
    /** Earliest due time among scheduled cards, or null when none are scheduled. */
    nextDueMs: number | null
}

export function deckStats(
    decks: readonly CardDeck[],
    schedule: Schedule,
    { now, maxDepth, newPerDay }: PickOptions,
): DeckStats {
    const nowMs = now.getTime()
    let learned = 0
    let dueNow = 0
    let unseen = 0
    let nextDueMs: number | null = null
    for (const card of eligibleCards(decks, maxDepth)) {
        const r = schedule.get(card.id)
        if (!r) {
            unseen++
            continue
        }
        learned++
        const ms = dueMsOf(r)
        if (ms <= nowMs) dueNow++
        if (nextDueMs === null || ms < nextDueMs) nextDueMs = ms
    }
    const quota = Math.max(0, newPerDay - introducedToday(schedule, now))
    return { total: learned + unseen, learned, dueNow, newLeftToday: Math.min(quota, unseen), nextDueMs }
}

/** "now", "8 min", "3 h", "6 d". */
export function formatWait(ms: number): string {
    if (ms <= 30_000) return 'now'
    const minutes = Math.round(ms / MINUTE_MS)
    if (minutes < 60) return `${Math.max(1, minutes)} min`
    const hours = Math.round(ms / (60 * MINUTE_MS))
    if (hours < 24) return `${hours} h`
    return `${Math.round(ms / DAY_MS)} d`
}
