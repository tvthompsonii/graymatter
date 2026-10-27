import { useEffect, useRef } from 'react'

/**
 * Move list in a box, one move pair per line, with the last move highlighted. It fills the
 * height its parent gives it and scrolls, keeping the latest move in view.
 */
export function MoveList({ moves, emptyText = 'No moves yet.' }: { moves: readonly string[]; emptyText?: string }) {
    const listRef = useRef<HTMLOListElement>(null)
    useEffect(() => {
        const list = listRef.current
        if (list) list.scrollTop = list.scrollHeight
    }, [moves.length])

    const rows: Array<[string, string | undefined]> = []
    for (let i = 0; i < moves.length; i += 2) rows.push([moves[i]!, moves[i + 1]])
    const last = moves.length - 1

    return (
        <ol
            ref={listRef}
            className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto rounded-[10px] border border-line bg-rail p-1.5 font-mono text-[13px]"
        >
            {rows.length === 0 && <li className="px-1.5 py-1 text-dim">{emptyText}</li>}
            {rows.map(([white, black], row) => (
                <li
                    key={row}
                    className={`grid grid-cols-[2rem_1fr_1fr] rounded-md px-1.5 py-1 ${
                        Math.floor(last / 2) === row ? 'bg-raised' : ''
                    }`}
                >
                    <span className="text-dim">{row + 1}.</span>
                    <span className={row * 2 === last ? 'font-semibold text-accent-ink' : 'text-body'}>{white}</span>
                    <span className={row * 2 + 1 === last ? 'font-semibold text-accent-ink' : 'text-body'}>{black ?? ''}</span>
                </li>
            ))}
        </ol>
    )
}
