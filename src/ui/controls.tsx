import { useEffect, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react'

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'

const BUTTON_BASE =
    'inline-flex h-10 items-center justify-center gap-2 rounded-[10px] px-4 text-sm transition '
    + 'disabled:cursor-not-allowed disabled:opacity-40'

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
    primary: 'bg-accent font-semibold text-on-accent enabled:hover:bg-amber-400',
    secondary: 'border border-line-strong bg-raised font-medium text-body enabled:hover:border-faint',
    ghost: 'font-medium text-soft enabled:hover:bg-raised enabled:hover:text-ink',
    danger: 'px-3 font-medium text-red-300 enabled:hover:bg-red-500/10 enabled:hover:text-red-200',
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: ButtonVariant
    icon?: ReactNode
    /** Icon after the label instead of before it. */
    trailingIcon?: ReactNode
}

export function Button({
    variant = 'secondary',
    icon,
    trailingIcon,
    className = '',
    children,
    ...props
}: ButtonProps) {
    return (
        <button
            type="button"
            className={`${BUTTON_BASE} ${BUTTON_VARIANTS[variant]} ${className}`}
            {...props}
        >
            {icon}
            {children}
            {trailingIcon}
        </button>
    )
}

/** Small icon-only button, e.g. the ⓘ in a panel header. */
export function IconButton({
    label,
    className = '',
    children,
    ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
    return (
        <button
            type="button"
            aria-label={label}
            className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-line text-muted transition hover:border-line-strong hover:text-body ${className}`}
            {...props}
        >
            {children}
        </button>
    )
}

type SegmentedOption<T extends string> = { value: T; label: string }

/** A row of mutually exclusive choices (radio semantics), e.g. Both / White / Black. */
export function SegmentedControl<T extends string>({
    options,
    value,
    onChange,
    label,
    disabled = false,
}: {
    options: readonly SegmentedOption<T>[]
    value: T
    onChange: (value: T) => void
    label: string
    disabled?: boolean
}) {
    return (
        <div
            role="radiogroup"
            aria-label={label}
            className="grid gap-0.5 rounded-[10px] border border-line bg-rail p-[3px]"
            style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
        >
            {options.map((option) => {
                const selected = option.value === value
                return (
                    <button
                        key={option.value}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        disabled={disabled}
                        onClick={() => onChange(option.value)}
                        className={`h-8 rounded-[7px] text-[13px] transition disabled:cursor-not-allowed disabled:opacity-50 ${
                            selected
                                ? 'bg-accent/15 font-semibold text-accent-ink'
                                : 'font-medium text-muted enabled:hover:text-body'
                        }`}
                    >
                        {option.label}
                    </button>
                )
            })}
        </div>
    )
}

/** Toggle pill for multi-select filters (puzzle themes). */
export function Chip({
    pressed,
    onToggle,
    disabled = false,
    children,
}: {
    pressed: boolean
    onToggle: () => void
    disabled?: boolean
    children: ReactNode
}) {
    return (
        <button
            type="button"
            aria-pressed={pressed}
            disabled={disabled}
            onClick={onToggle}
            className={`h-[30px] rounded-full border px-3 text-[13px] transition disabled:cursor-not-allowed ${
                pressed
                    ? 'border-accent/45 bg-accent/15 font-semibold text-accent-ink'
                    : 'border-line-strong font-medium text-soft enabled:hover:border-faint enabled:hover:text-body'
            }`}
        >
            {children}
        </button>
    )
}

/** Amber value readout next to a setting label, e.g. "7 moves" or "1700–1900". */
export function ValueBadge({ children }: { children: ReactNode }) {
    return (
        <span className="rounded-md bg-accent/15 px-2 py-0.5 font-mono text-xs font-medium text-accent-ink">
            {children}
        </span>
    )
}

/**
 * Call `onCommit` from the native `change` event of every range input under `ref`. React's
 * onChange fires on every drag step; the native event fires when the thumb is released (or on
 * each keyboard step), which is when a slider's value should be saved.
 */
function useCommitOnRelease(ref: { current: HTMLElement | null }, onCommit: (values: number[]) => void) {
    const onCommitRef = useRef(onCommit)
    onCommitRef.current = onCommit
    useEffect(() => {
        const inputs = [...(ref.current?.querySelectorAll('input') ?? [])]
        const commit = () => onCommitRef.current(inputs.map((input) => Number(input.value)))
        for (const input of inputs) input.addEventListener('change', commit)
        return () => {
            for (const input of inputs) input.removeEventListener('change', commit)
        }
    }, [ref])
}

function percent(value: number, min: number, max: number): number {
    return ((value - min) / (max - min)) * 100
}

/** Thumb width in rem (see `.range-thumb` in index.css). */
const THUMB_REM = 1.125

/** Offset from the track's left edge of a thumb centered at `pct`; the thumb never overhangs the ends. */
function thumbCenter(pct: number): string {
    return `calc(${pct}% + ${THUMB_REM / 2 - (pct / 100) * THUMB_REM}rem)`
}

/** Fill runs between thumb centers; `left` null fills from the start of the track. */
function Track({ left, right }: { left: number | null; right: number }) {
    return (
        <>
            <div className="absolute inset-x-0 top-[9px] h-1.5 rounded-full bg-line" />
            <div
                className="absolute top-[9px] h-1.5 rounded-full bg-accent-strong"
                style={{
                    left: left === null ? 0 : thumbCenter(left),
                    width: `calc(${thumbCenter(right)} - ${left === null ? '0px' : thumbCenter(left)})`,
                }}
            />
        </>
    )
}

type RangeSliderProps = {
    min: number
    max: number
    step?: number
    value: number
    /** Every step while dragging (updates the display only). */
    onDraft: (value: number) => void
    /** The value once the thumb is released. */
    onCommit: (value: number) => void
    label: string
}

export function RangeSlider({ min, max, step = 1, value, onDraft, onCommit, label }: RangeSliderProps) {
    const trackRef = useRef<HTMLDivElement>(null)
    useCommitOnRelease(trackRef, ([v]) => onCommit(v!))
    return (
        <div ref={trackRef} className="relative h-6">
            <Track left={null} right={percent(value, min, max)} />
            <input
                type="range"
                min={min}
                max={max}
                step={step}
                value={value}
                onChange={(event) => onDraft(Number(event.target.value))}
                // A single slider wants track clicks; only the dual slider needs thumb-only input.
                style={{ pointerEvents: 'auto' }}
                className="range-thumb absolute inset-0 w-full cursor-pointer"
                aria-label={label}
            />
        </div>
    )
}

type DualRangeSliderProps = {
    min: number
    max: number
    step?: number
    low: number
    high: number
    onDraft: (low: number, high: number) => void
    onCommit: (low: number, high: number) => void
    labels: [string, string]
}

export function DualRangeSlider({
    min,
    max,
    step = 1,
    low,
    high,
    onDraft,
    onCommit,
    labels,
}: DualRangeSliderProps) {
    const lo = Math.min(low, high)
    const hi = Math.max(low, high)
    const trackRef = useRef<HTMLDivElement>(null)
    useCommitOnRelease(trackRef, ([a, b]) => onCommit(Math.min(a!, b!), Math.max(a!, b!)))
    return (
        <div ref={trackRef} className="relative h-6">
            <Track left={percent(lo, min, max)} right={percent(hi, min, max)} />
            <input
                type="range"
                min={min}
                max={max}
                step={step}
                value={lo}
                onChange={(event) => onDraft(Math.min(Number(event.target.value), hi), hi)}
                className="range-thumb absolute inset-0 z-10 w-full"
                aria-label={labels[0]}
            />
            <input
                type="range"
                min={min}
                max={max}
                step={step}
                value={hi}
                onChange={(event) => onDraft(lo, Math.max(Number(event.target.value), lo))}
                className="range-thumb absolute inset-0 z-20 w-full"
                aria-label={labels[1]}
            />
        </div>
    )
}
