import type { ReactNode } from 'react'

import { IconButton } from './controls'
import { CheckIcon, InfoIcon, XIcon } from './icons'

/**
 * Board-first page: the board (sized by `.board-slot` from the window height) on the left and
 * the mode's side panel filling the rest of the row. The panel body scrolls when it runs out of
 * room; `footer` (e.g. the main action buttons) stays pinned below it so it is always reachable.
 */
export function BoardPage({
    board,
    children,
    label,
    footer,
}: {
    board: ReactNode
    children: ReactNode
    label: string
    footer?: ReactNode
}) {
    return (
        <div className="board-page flex h-full gap-6 p-6">
            <div className="board-slot">{board}</div>
            <section
                aria-label={label}
                className="flex h-full min-w-0 flex-1 flex-col rounded-[14px] border border-edge bg-panel"
            >
                <div className={`flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-5 ${footer ? 'pb-4' : ''}`}>
                    {children}
                </div>
                {footer && <div className="shrink-0 px-5 pb-5">{footer}</div>}
            </section>
        </div>
    )
}

/** Mode title with a one-line subtitle; longer explanations go in the ⓘ tooltip. */
export function PanelHeader({ title, subtitle, info }: { title: string; subtitle: string; info?: string }) {
    return (
        <div className="flex items-start justify-between gap-3">
            <div>
                <h1 className="text-xl font-semibold tracking-tight text-ink">{title}</h1>
                <p className="mt-1 text-[13px] leading-snug text-muted">{subtitle}</p>
            </div>
            {info && (
                <IconButton label={`About ${title}`} title={info}>
                    <InfoIcon />
                </IconButton>
            )}
        </div>
    )
}

/** A labelled block of settings: small caps label, optional value badge on the right. */
export function Section({
    label,
    htmlFor,
    aside,
    children,
    className = '',
}: {
    label: ReactNode
    htmlFor?: string
    aside?: ReactNode
    children: ReactNode
    className?: string
}) {
    const labelClass = 'flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-faint'
    return (
        <div className={`flex flex-col gap-2 ${className}`}>
            <div className="flex items-center justify-between">
                {htmlFor
                    ? <label htmlFor={htmlFor} className={labelClass}>{label}</label>
                    : <span className={labelClass}>{label}</span>}
                {aside}
            </div>
            {children}
        </div>
    )
}

/** Raised card inside a panel (progress, current puzzle, score). */
export function Card({ children, row = false, className = '' }: { children: ReactNode; row?: boolean; className?: string }) {
    return (
        <div className={`flex gap-3 rounded-xl border border-line bg-raised p-3.5 ${row ? 'flex-row items-center' : 'flex-col'} ${className}`}>
            {children}
        </div>
    )
}

export type StatusTone = 'turn' | 'success' | 'error' | 'info'

/**
 * The panel's live feedback line. `title` is bold; `text` follows it as its own sentence (no
 * separator), so both wrap cleanly in a narrow panel. `marker` replaces the default tone marker,
 * e.g. a white or black square for the side to move.
 */
export function StatusBanner({
    tone = 'turn',
    title,
    text,
    marker,
    children,
}: {
    tone?: StatusTone
    title: string
    text?: string
    marker?: ReactNode
    children?: ReactNode
}) {
    const toneClass = {
        turn: 'border-line bg-raised',
        info: 'border-line bg-raised',
        success: 'border-success/40 bg-success/10',
        error: 'border-danger/40 bg-danger/10',
    }[tone]
    const titleClass = { turn: 'text-ink', info: 'text-ink', success: 'text-green-200', error: 'text-red-200' }[tone]
    const textClass = { turn: 'text-muted', info: 'text-muted', success: 'text-green-300', error: 'text-red-300' }[tone]
    const defaultMarker = {
        turn: <span className="h-2 w-2 shrink-0 rounded-full bg-accent" />,
        info: <span className="h-2 w-2 shrink-0 rounded-full bg-slate-500" />,
        success: <CheckIcon className="shrink-0 text-success" strokeWidth={2.5} />,
        error: <XIcon className="shrink-0 text-danger" strokeWidth={2.5} />,
    }[tone]

    return (
        <div role="status" className={`flex flex-col gap-1.5 rounded-[10px] border px-3 py-2.5 ${toneClass}`}>
            <div className="flex items-center gap-2 text-[13px]">
                <span aria-hidden="true" className="flex shrink-0 items-center">{marker ?? defaultMarker}</span>
                <span className={`font-semibold ${titleClass}`}>{title}</span>
                {text && <span className={textClass}>{text}</span>}
            </div>
            {children}
        </div>
    )
}

/** Square marker for the side to move, used in status banners. */
export function SideMarker({ side }: { side: 'w' | 'b' }) {
    return (
        <span
            className={`h-3 w-3 rounded-[3px] border ${side === 'w' ? 'border-slate-300 bg-slate-100' : 'border-slate-500 bg-slate-950'}`}
        />
    )
}

export function StatTile({ label, value, accent = false }: { label: string; value: ReactNode; accent?: boolean }) {
    return (
        <div className="rounded-lg bg-panel px-2.5 py-2">
            <div className="text-[11px] text-faint">{label}</div>
            <div className={`font-mono text-[15px] font-semibold ${accent ? 'text-success' : 'text-ink'}`}>{value}</div>
        </div>
    )
}

export function ProgressBar({
    value,
    max,
    label,
    tone = 'accent',
}: {
    value: number
    max: number
    label: string
    tone?: 'accent' | 'success'
}) {
    const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0
    return (
        <div
            role="progressbar"
            aria-label={label}
            aria-valuenow={value}
            aria-valuemin={0}
            aria-valuemax={max}
            className="h-1.5 overflow-hidden rounded-full bg-rail"
        >
            <div
                className={`h-full rounded-full ${tone === 'success' ? 'bg-success' : 'bg-accent'}`}
                style={{ width: `${pct}%` }}
            />
        </div>
    )
}

/** One Survival strike: dashed when unused, a red ✕ once missed. */
export function StrikeMarker({ missed, size = 28 }: { missed: boolean; size?: number }) {
    return missed
        ? (
            <span
                className="flex items-center justify-center rounded-full border border-danger bg-danger/20 text-danger"
                style={{ width: size, height: size }}
            >
                <XIcon size={Math.round(size / 2)} strokeWidth={3} />
            </span>
        )
        : <span className="rounded-full border-[1.5px] border-dashed border-[#3a4760]" style={{ width: size, height: size }} />
}

/** Error line shown at the bottom of a panel (file problems, no matching puzzles). */
export function ErrorNote({ children }: { children: ReactNode }) {
    return (
        <p className="rounded-[10px] border border-danger/40 bg-danger/10 px-3 py-2 text-[13px] text-red-200">
            {children}
        </p>
    )
}
