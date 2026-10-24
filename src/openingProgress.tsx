import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import { formatLine } from './moveTree'
import type { LoadedRepertoires } from './openings'
import {
    buildProgressTree,
    cardStatus,
    countCards,
    expandToDepth,
    layoutTree,
    prefixIds,
    type CardStatus,
    type PlacedNode,
    type ProgressNode,
} from './progressTree'
import { buildCardDeck, type CardDeck } from './repertoireCards'
import type { AppSettings } from './settings'
import { deckStats, formatWait, localDate, type ReviewRecord, type Schedule } from './srs'
import { readSchedule } from './trainingExport'
import { Button, SegmentedControl } from './ui/controls'
import { ResetIcon } from './ui/icons'
import { BoardPage, Card as PanelCard, ErrorNote, PanelHeader, ProgressBar, Section, StatTile } from './ui/layout'

type Side = 'w' | 'b'

const SIDE_OPTIONS = [
    { value: 'w', label: 'White' },
    { value: 'b', label: 'Black' },
] as const satisfies ReadonlyArray<{ value: Side; label: string }>

/** Grid spacing and node sizes, in SVG units (1 unit = 1px at zoom 1). */
const COL_W = 92
const ROW_H = 34
const PAD = 24
const TRAINEE_W = 64
const TRAINEE_H = 24
const OPPONENT_W = 50
const OPPONENT_H = 20
const MIN_ZOOM = 0.2
const MAX_ZOOM = 2.5
/** Full moves (both sides) shown expanded when the view opens or the side changes. */
const INITIAL_EXPAND_MOVES = 3
/** Attempts before accuracy, rather than ease alone, drives a card's difficulty tint. */
const MIN_ATTEMPTS_FOR_ACCURACY = 5
const REFRESH_MS = 30_000

/** Border colors by card state (the theme's line/accent/success/danger tokens). */
const STATUS_STROKE: Record<CardStatus, string> = {
    untrained: '#cbd5e1',
    learning: '#f59e0b',
    review: '#34d399',
    relearning: '#f87171',
}
const STATUS_LABEL: Record<CardStatus, string> = {
    untrained: 'Not yet trained',
    learning: 'Learning',
    review: 'Learned',
    relearning: 'Missed · relearning',
}
const BASE_FILL = '#161e2e'
const HARD_FILL = '#7c2d12'

function mixHex(a: string, b: string, t: number): string {
    const channel = (hex: string, i: number) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16)
    const out = [0, 1, 2].map((i) => Math.round(channel(a, i) + (channel(b, i) - channel(a, i)) * t))
    return `#${out.map((v) => v.toString(16).padStart(2, '0')).join('')}`
}

function clamp01(n: number): number {
    return Math.min(1, Math.max(0, n))
}

/** 0 = easy, 1 = hardest: from ease (2.5 → 1.3), or accuracy once there are enough attempts and it's worse. */
function difficulty(r: ReviewRecord): number {
    let d = clamp01((2.5 - r.ease) / 1.2)
    if (r.attempts >= MIN_ATTEMPTS_FOR_ACCURACY) d = Math.max(d, clamp01((0.95 - r.correct / r.attempts) / 0.55))
    return d
}

function accuracyText(r: ReviewRecord | undefined): string {
    if (!r || !r.attempts) return '–'
    return `${Math.round((r.correct / r.attempts) * 100)}% (${r.correct}/${r.attempts})`
}

function nodeCenter(p: PlacedNode): { cx: number; cy: number } {
    return { cx: PAD + p.x * COL_W + TRAINEE_W / 2, cy: PAD + p.y * ROW_H + TRAINEE_H / 2 }
}

type Hover = { node: ProgressNode; x: number; y: number }
type View = { tx: number; ty: number; k: number }

type ProgressViewProps = {
    loaded: LoadedRepertoires
    viewSwitch: ReactNode
    settings: AppSettings
    /** Opens Explore at this line. */
    onOpenInExplore: (side: Side, path: string[]) => void
}

/** Progress: the repertoire as a left-to-right tree, each of your moves colored by how well you know it. */
export function ProgressView({ loaded, viewSwitch, settings, onOpenInExplore }: ProgressViewProps) {
    const { paths, whiteRepertoire, blackRepertoire, ready, loadError } = loaded
    const [side, setSide] = useState<Side>('w')
    const [schedule, setSchedule] = useState<Schedule>(new Map())
    const [nowMs, setNowMs] = useState(() => Date.now())
    const maxDepth = settings.openingsTrainDepth

    // Read-only: the schedule is read once when the view opens and never written here.
    useEffect(() => {
        if (!paths) return
        let cancelled = false
        void readSchedule(paths.trainingStatus).then((s) => {
            if (!cancelled) setSchedule(s)
        })
        return () => {
            cancelled = true
        }
    }, [paths])

    useEffect(() => {
        const id = window.setInterval(() => setNowMs(Date.now()), REFRESH_MS)
        return () => window.clearInterval(id)
    }, [])

    const repertoire = side === 'w' ? whiteRepertoire : blackRepertoire
    const deck = useMemo<CardDeck | null>(
        () => (ready && repertoire ? buildCardDeck(repertoire.root, side) : null),
        [ready, repertoire, side],
    )
    const tree = useMemo(
        () => (deck && repertoire ? buildProgressTree(repertoire.root, deck) : null),
        [deck, repertoire],
    )
    /** First place in the tree each card appears, for jumping to it. */
    const firstNodeOfCard = useMemo(() => {
        const map = new Map<string, ProgressNode>()
        const walk = (n: ProgressNode) => {
            if (n.cardId && !map.has(n.cardId)) map.set(n.cardId, n)
            n.children.forEach(walk)
        }
        if (tree) walk(tree)
        return map
    }, [tree])

    const [expanded, setExpanded] = useState<Set<string>>(new Set())
    const [view, setView] = useState<View>({ tx: PAD, ty: PAD, k: 1 })
    const [hover, setHover] = useState<Hover | null>(null)
    const [focusId, setFocusId] = useState<string | null>(null)
    const containerRef = useRef<HTMLDivElement | null>(null)
    /** Node id to center once the next layout is ready (after expanding toward it). */
    const pendingCenterRef = useRef<string | null>(null)

    const layout = useMemo(() => (tree ? layoutTree(tree, expanded) : null), [tree, expanded])

    // A new tree (side change or first load) starts expanded a few plies, with the start centered.
    useEffect(() => {
        if (!tree) return
        setExpanded(expandToDepth(tree, INITIAL_EXPAND_MOVES * 2))
        setHover(null)
        pendingCenterRef.current = ''
    }, [tree])

    useLayoutEffect(() => {
        const target = pendingCenterRef.current
        const el = containerRef.current
        if (target === null || !layout || !el) return
        const placed = layout.nodes.find((p) => p.node.id === target)
        if (!placed) return
        pendingCenterRef.current = null
        const { width, height } = el.getBoundingClientRect()
        const { cx, cy } = nodeCenter(placed)
        setView((v) => ({
            ...v,
            // The start node goes at the left edge; anything else in the middle.
            tx: target === '' ? PAD : width / 2 - cx * v.k,
            ty: height / 2 - cy * v.k,
        }))
    }, [layout])

    /** Expands the tree down to `path`'s node and centers it, outlining it for a moment. */
    const reveal = useCallback((path: string[]) => {
        const id = path.join(' ')
        setExpanded((prev) => new Set([...prev, ...prefixIds(path)]))
        pendingCenterRef.current = id
        setFocusId(id)
    }, [])
    useEffect(() => {
        if (focusId === null) return
        const timer = window.setTimeout(() => setFocusId(null), 2000)
        return () => window.clearTimeout(timer)
    }, [focusId])

    const toggle = (node: ProgressNode) => {
        if (!node.children.length || !node.id) return
        setExpanded((prev) => {
            const next = new Set(prev)
            if (next.has(node.id)) next.delete(node.id)
            else next.add(node.id)
            return next
        })
    }

    // Pan by dragging anywhere; a drag that moved doesn't count as a click on the node under it.
    const dragRef = useRef<{ x: number; y: number; tx: number; ty: number; moved: boolean } | null>(null)
    const draggedRef = useRef(false)
    const onPointerDown = (e: React.PointerEvent) => {
        if (e.button !== 0) return
        dragRef.current = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty, moved: false }
        draggedRef.current = false
        const move = (ev: PointerEvent) => {
            const d = dragRef.current
            if (!d) return
            const dx = ev.clientX - d.x
            const dy = ev.clientY - d.y
            if (!d.moved && Math.hypot(dx, dy) < 4) return
            d.moved = true
            draggedRef.current = true
            setHover(null)
            setView((v) => ({ ...v, tx: d.tx + dx, ty: d.ty + dy }))
        }
        const up = () => {
            dragRef.current = null
            window.removeEventListener('pointermove', move)
            window.removeEventListener('pointerup', up)
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
    }

    // Zoom around the cursor. Registered directly so it can be non-passive and stop the page scrolling.
    useEffect(() => {
        const el = containerRef.current
        if (!el) return
        const onWheel = (e: WheelEvent) => {
            e.preventDefault()
            const rect = el.getBoundingClientRect()
            const px = e.clientX - rect.left
            const py = e.clientY - rect.top
            setView((v) => {
                const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.k * Math.exp(-e.deltaY * 0.0015)))
                return { k, tx: px - (px - v.tx) * (k / v.k), ty: py - (py - v.ty) * (k / v.k) }
            })
        }
        el.addEventListener('wheel', onWheel, { passive: false })
        return () => el.removeEventListener('wheel', onWheel)
    }, [])

    const onHover = (node: ProgressNode, e: React.PointerEvent) => {
        if (dragRef.current?.moved) return
        const rect = containerRef.current?.getBoundingClientRect()
        if (!rect) return
        setHover({ node, x: e.clientX - rect.left, y: e.clientY - rect.top })
    }

    const resetView = () => {
        if (!tree) return
        setView({ tx: PAD, ty: PAD, k: 1 })
        setExpanded(expandToDepth(tree, INITIAL_EXPAND_MOVES * 2))
        pendingCenterRef.current = ''
    }

    // ----- Panel stats -----
    const deckCards = useMemo(() => (deck ? [...deck.cards.keys()] : []), [deck])
    const counts = deck ? countCards(deckCards, deck, schedule, maxDepth, nowMs) : null
    const newLeftToday = deck
        ? deckStats([deck], schedule, { now: new Date(nowMs), maxDepth, newPerDay: settings.openingsNewPerDay }).newLeftToday
        : 0

    const sideRecords = useMemo(() => {
        if (!deck) return []
        const out: { record: ReviewRecord; san: string; line: string }[] = []
        for (const card of deck.cards.values()) {
            const record = schedule.get(card.id)
            if (record && card.depth <= maxDepth) out.push({ record, san: card.san, line: card.line })
        }
        return out
    }, [deck, maxDepth, schedule])

    let attempts = 0
    let correct = 0
    for (const { record } of sideRecords) {
        attempts += record.attempts
        correct += record.correct
    }

    // Reviews due on each of the next 7 local days; today includes anything overdue.
    const forecast = useMemo(() => {
        const days = Array.from({ length: 7 }, (_, i) => {
            const d = new Date(nowMs)
            d.setDate(d.getDate() + i)
            return { key: localDate(d), label: i === 0 ? 'Today' : d.toLocaleDateString(undefined, { weekday: 'short' }), count: 0 }
        })
        const today = days[0]!.key
        for (const { record } of sideRecords) {
            const key = localDate(new Date(record.due))
            const day = key <= today ? days[0] : days.find((x) => x.key === key)
            if (day) day.count++
        }
        return days
    }, [nowMs, sideRecords])
    const forecastMax = Math.max(1, ...forecast.map((d) => d.count))

    const hardest = useMemo(() => sideRecords
        .filter(({ record: r }) => r.ease < 2.5 || r.lapses > 0 || r.correct < r.attempts)
        .sort((a, b) => a.record.ease - b.record.ease
            || b.record.lapses - a.record.lapses
            || (a.record.attempts ? a.record.correct / a.record.attempts : 1) - (b.record.attempts ? b.record.correct / b.record.attempts : 1))
        .slice(0, 5), [sideRecords])

    // ----- Tree rendering -----
    const renderNode = (p: PlacedNode) => {
        const { node } = p
        const x = PAD + p.x * COL_W
        const y = PAD + p.y * ROW_H
        const isOpen = node.id === '' || expanded.has(node.id)
        const collapsedKids = node.children.length > 0 && !isOpen
        const focused = focusId === node.id
        const common = {
            onPointerMove: (e: React.PointerEvent) => onHover(node, e),
            onPointerLeave: () => setHover((h) => (h?.node === node ? null : h)),
            onClick: () => {
                if (!draggedRef.current) toggle(node)
            },
            onDoubleClick: () => {
                if (node.id) onOpenInExplore(side, node.path)
            },
            style: { cursor: node.children.length ? 'pointer' : 'default' },
        }

        let subtreeBar: ReactNode = null
        if (collapsedKids && deck) {
            const c = countCards(node.subtreeCards, deck, schedule, maxDepth, nowMs)
            if (c.total) {
                const w = node.isTrainee ? TRAINEE_W : OPPONENT_W
                subtreeBar = (
                    <g>
                        <rect x={0} y={(node.isTrainee ? TRAINEE_H : OPPONENT_H) + 3} width={w} height={3} rx={1.5} fill="#232d40" />
                        <rect x={0} y={(node.isTrainee ? TRAINEE_H : OPPONENT_H) + 3} width={(w * c.review) / c.total} height={3} rx={1.5} fill="#34d399" />
                    </g>
                )
            }
        }
        const more = collapsedKids
            ? (
                <text x={(node.isTrainee ? TRAINEE_W : OPPONENT_W) + 5} y={(node.isTrainee ? TRAINEE_H : OPPONENT_H) / 2 + 4} className="font-mono" fontSize={10} fill="#7c8aa0">
                    +{node.children.length}
                </text>
            )
            : null
        const transposeBadge = node.transposesTo
            ? (
                <g
                    transform={`translate(${(node.isTrainee ? TRAINEE_W : OPPONENT_W) + 4}, ${(node.isTrainee ? TRAINEE_H : OPPONENT_H) / 2 - 8})`}
                    style={{ cursor: 'pointer' }}
                    onClick={(e) => {
                        e.stopPropagation()
                        if (!draggedRef.current && node.transposesTo) reveal(node.transposesTo)
                    }}
                >
                    <rect width={18} height={16} rx={4} fill="#161e2e" stroke="#f59e0b" strokeWidth={1} />
                    <text x={9} y={12} textAnchor="middle" fontSize={11} fill="#fcd34d">⇄</text>
                </g>
            )
            : null

        if (!node.id) {
            return (
                <g key="start" transform={`translate(${x}, ${y})`} {...common}>
                    <rect width={TRAINEE_W} height={TRAINEE_H} rx={6} fill="#0a0f1a" stroke="#2b3850" />
                    <text x={TRAINEE_W / 2} y={16} textAnchor="middle" fontSize={11} fill="#94a3b8">Start</text>
                </g>
            )
        }

        if (!node.isTrainee) {
            const oy = (TRAINEE_H - OPPONENT_H) / 2
            return (
                <g key={node.id} transform={`translate(${x + (TRAINEE_W - OPPONENT_W) / 2}, ${y + oy})`} {...common}>
                    <rect width={OPPONENT_W} height={OPPONENT_H} rx={OPPONENT_H / 2} fill="#0f1522" stroke={focused ? '#fcd34d' : '#2b3850'} strokeWidth={focused ? 2 : 1} />
                    <text x={OPPONENT_W / 2} y={14} textAnchor="middle" className="font-mono" fontSize={11} fill="#94a3b8">{node.san}</text>
                    {subtreeBar}
                    {more}
                    {transposeBadge}
                </g>
            )
        }

        const card = deck?.cards.get(node.cardId!)
        const record = schedule.get(node.cardId!)
        const status = cardStatus(record)
        const beyond = !!card && card.depth > maxDepth
        const due = !!record && Date.parse(record.due) <= nowMs
        return (
            <g key={node.id} transform={`translate(${x}, ${y})`} opacity={beyond ? 0.35 : 1} {...common}>
                {focused && <rect x={-4} y={-4} width={TRAINEE_W + 8} height={TRAINEE_H + 8} rx={9} fill="none" stroke="#fcd34d" strokeWidth={2} />}
                <rect
                    width={TRAINEE_W}
                    height={TRAINEE_H}
                    rx={6}
                    fill={record ? mixHex(BASE_FILL, HARD_FILL, difficulty(record)) : BASE_FILL}
                    stroke={STATUS_STROKE[status]}
                    strokeWidth={status === 'untrained' ? 1 : 2}
                />
                <text x={TRAINEE_W / 2} y={16} textAnchor="middle" className="font-mono" fontSize={12} fontWeight={600} fill="#f8fafc">{node.san}</text>
                {node.transposed && <text x={3} y={9} fontSize={8} fill="#94a3b8">⇄</text>}
                {due && <circle cx={TRAINEE_W - 4} cy={4} r={3.5} fill="#fcd34d" stroke="#070b14" strokeWidth={1} />}
                {subtreeBar}
                {more}
                {transposeBadge}
            </g>
        )
    }

    const edgePath = (from: PlacedNode, to: PlacedNode) => {
        const x1 = PAD + from.x * COL_W + TRAINEE_W - (from.node.isTrainee || !from.node.id ? 0 : (TRAINEE_W - OPPONENT_W) / 2)
        const x2 = PAD + to.x * COL_W + (to.node.isTrainee ? 0 : (TRAINEE_W - OPPONENT_W) / 2)
        const y1 = PAD + from.y * ROW_H + TRAINEE_H / 2
        const y2 = PAD + to.y * ROW_H + TRAINEE_H / 2
        const mx = (x1 + x2) / 2
        return `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`
    }

    // ----- Tooltip -----
    let tooltip: ReactNode = null
    if (hover && deck) {
        const { node } = hover
        const record = node.cardId ? schedule.get(node.cardId) : undefined
        const card = node.cardId ? deck.cards.get(node.cardId) : undefined
        const rows: [string, string][] = []
        if (node.isTrainee) {
            rows.push(['State', STATUS_LABEL[cardStatus(record)]])
            if (record) {
                const wait = Date.parse(record.due) - nowMs
                rows.push(['Next review', wait <= 0 ? 'due now' : `in ${formatWait(wait)}`])
                rows.push(['Interval', `${record.intervalDays} d`])
                rows.push(['Ease', String(record.ease)])
                rows.push(['Passes / lapses', `${record.reps} / ${record.lapses}`])
                rows.push(['Accuracy', accuracyText(record)])
                rows.push(['Introduced', record.introduced])
                rows.push(['Last reviewed', localDate(new Date(record.lastReviewed))])
            }
            if (card && card.depth > maxDepth) rows.push(['Depth', `move ${card.depth}, beyond Max depth`])
        }
        else if (node.id) {
            rows.push(['Opponent move', node.children.length ? `${node.children.length} answer${node.children.length === 1 ? '' : 's'} in book` : 'end of line'])
        }
        const isOpen = node.id === '' || expanded.has(node.id)
        if (node.children.length && !isOpen) {
            const c = countCards(node.subtreeCards, deck, schedule, maxDepth, nowMs)
            rows.push(['Below here', `${c.review}/${c.total} learned · ${c.due} due`])
        }
        if (node.transposed) rows.push(['Transposition', 'also reached by another move order'])
        if (node.transposesTo) rows.push(['Continues at', formatLine(node.transposesTo).join(' ')])

        const width = containerRef.current?.clientWidth ?? 0
        const flip = hover.x > width - 280
        tooltip = (
            <div
                className="pointer-events-none absolute z-10 w-64 rounded-[10px] border border-line-strong bg-raised px-3 py-2.5 text-[12px] shadow-xl"
                style={{ left: flip ? hover.x - 270 : hover.x + 14, top: hover.y + 14 }}
            >
                <div className="mb-1.5 font-mono text-[11px] leading-snug text-soft">
                    {node.id ? formatLine(node.path).join(' ') : 'Start position'}
                </div>
                {rows.map(([k, v]) => (
                    <div key={k} className="flex justify-between gap-3">
                        <span className="text-faint">{k}</span>
                        <span className="text-right text-body">{v}</span>
                    </div>
                ))}
            </div>
        )
    }

    const legendSwatch = (stroke: string, label: string, fill = BASE_FILL) => (
        <div className="flex items-center gap-2">
            <span className="h-3.5 w-5 rounded-[4px] border-2" style={{ borderColor: stroke, background: fill }} />
            <span className="text-[12px] text-soft">{label}</span>
        </div>
    )

    const loading = !ready || !tree

    return (
        <BoardPage
            wide
            label="Progress controls"
            board={(
                <div
                    ref={containerRef}
                    className="relative h-full w-full touch-none select-none overflow-hidden rounded-[14px] border border-edge bg-rail"
                    onPointerDown={onPointerDown}
                    style={{ cursor: dragRef.current?.moved ? 'grabbing' : 'grab' }}
                >
                    {layout && (
                        <svg className="h-full w-full">
                            <g transform={`translate(${view.tx}, ${view.ty}) scale(${view.k})`}>
                                {layout.edges.map(({ from, to }) => (
                                    <path key={`${from.node.id}>${to.node.id}`} d={edgePath(from, to)} fill="none" stroke="#2b3850" strokeWidth={1.25} />
                                ))}
                                {layout.nodes.map(renderNode)}
                            </g>
                        </svg>
                    )}
                    {loading && (
                        <div className="absolute inset-0 grid place-items-center text-[13px] text-faint">
                            {loadError ? 'Repertoires not loaded' : 'Loading repertoires…'}
                        </div>
                    )}
                    {tooltip}
                </div>
            )}
            footer={(
                <Button className="w-full" icon={<ResetIcon size={15} />} onClick={resetView} disabled={loading}>
                    Reset view
                </Button>
            )}
        >
            <PanelHeader
                title="Openings"
                subtitle="How well you know each move."
                info={'Your moves are outlined by state: white not yet trained, amber learning, green learned, '
                    + 'red missed and relearning. A warmer fill means a move has been harder for you (lower ease '
                    + 'or accuracy). A yellow dot means it is due now. Click a move to expand or collapse it, '
                    + 'double-click to open it in Explore, drag to pan and scroll to zoom. ⇄ marks transpositions.'}
            />

            {viewSwitch}

            <Section label="Repertoire">
                <SegmentedControl label="Repertoire" options={SIDE_OPTIONS} value={side} onChange={setSide} />
            </Section>

            <PanelCard>
                <ProgressBar label="Cards learned" value={counts?.review ?? 0} max={counts?.total ?? 0} tone="success" />
                <div className="grid grid-cols-3 gap-2">
                    <StatTile label="Learned" value={loading ? '–' : `${counts?.review ?? 0}/${counts?.total ?? 0}`} accent />
                    <StatTile label="Learning" value={loading ? '–' : counts?.learning ?? 0} />
                    <StatTile label="Missed" value={loading ? '–' : counts?.relearning ?? 0} />
                    <StatTile label="Untrained" value={loading ? '–' : counts?.untrained ?? 0} />
                    <StatTile label="Due now" value={loading ? '–' : counts?.due ?? 0} />
                    <StatTile label="New today" value={loading ? '–' : newLeftToday} />
                </div>
                <div className="flex items-baseline justify-between">
                    <span className="text-[13px] text-soft">Accuracy</span>
                    <span className="font-mono text-[15px] font-semibold text-ink">
                        {attempts ? `${Math.round((correct / attempts) * 100)}%` : '–'}
                        <span className="ml-1.5 text-[11px] font-normal text-faint">{attempts ? `${correct}/${attempts}` : ''}</span>
                    </span>
                </div>
            </PanelCard>

            <Section label="Due, next 7 days">
                <div className="flex h-20 items-end gap-1.5">
                    {forecast.map((day) => (
                        <div key={day.key} className="flex flex-1 flex-col items-center gap-1" title={`${day.count} due`}>
                            <span className="font-mono text-[10px] text-faint">{day.count || ''}</span>
                            <div
                                className="w-full rounded-t-[3px] bg-accent/70"
                                style={{ height: `${Math.max(2, (day.count / forecastMax) * 44)}px`, opacity: day.count ? 1 : 0.25 }}
                            />
                            <span className="text-[10px] text-dim">{day.label}</span>
                        </div>
                    ))}
                </div>
            </Section>

            <Section label="Hardest moves">
                {hardest.length
                    ? (
                        <div className="flex flex-col gap-1.5">
                            {hardest.map(({ record, san, line }) => (
                                <button
                                    key={record.id}
                                    type="button"
                                    onClick={() => {
                                        const node = firstNodeOfCard.get(record.id)
                                        if (node) reveal(node.path)
                                    }}
                                    className="flex flex-col items-start rounded-lg border border-line bg-rail px-2.5 py-1.5 text-left transition hover:border-line-strong"
                                >
                                    <span className="font-mono text-[12px] text-ink">{san}</span>
                                    <span className="w-full truncate font-mono text-[10px] text-faint">{line}</span>
                                    <span className="text-[11px] text-soft">
                                        ease {record.ease} · {record.lapses} lapse{record.lapses === 1 ? '' : 's'} · {accuracyText(record)}
                                    </span>
                                </button>
                            ))}
                        </div>
                    )
                    : <div className="text-[12px] text-faint">Nothing has given you trouble yet.</div>}
            </Section>

            <Section label="Legend">
                <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
                    {legendSwatch(STATUS_STROKE.untrained, 'Not trained')}
                    {legendSwatch(STATUS_STROKE.learning, 'Learning')}
                    {legendSwatch(STATUS_STROKE.review, 'Learned')}
                    {legendSwatch(STATUS_STROKE.relearning, 'Missed')}
                    {legendSwatch(STATUS_STROKE.review, 'Hard for you', mixHex(BASE_FILL, HARD_FILL, 0.9))}
                    <div className="flex items-center gap-2">
                        <span className="h-2.5 w-2.5 rounded-full bg-accent-ink" />
                        <span className="text-[12px] text-soft">Due now</span>
                    </div>
                </div>
            </Section>

            {loadError && <ErrorNote>{loadError}</ErrorNote>}
        </BoardPage>
    )
}
