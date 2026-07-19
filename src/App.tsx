import { useState } from 'react'

import { OpeningsPage } from './openings'
import { PlayPage } from './play'
import { PuzzlesPage } from './puzzles'

export type AppMode = 'openings' | 'puzzles' | 'play'

const NAV_ITEMS: Array<{ id: AppMode; label: string }> = [
    { id: 'openings', label: 'Openings' },
    { id: 'puzzles', label: 'Puzzles' },
    { id: 'play', label: 'Play' },
]

export default function App() {
    const [mode, setMode] = useState<AppMode>('openings')

    return (
        <div className="min-h-screen bg-slate-950 bg-[radial-gradient(ellipse_at_top,_#1e293b_0%,_#020617_55%)]">
            <div className="mx-auto max-w-5xl px-4 pt-10">
                <nav className="flex flex-wrap items-end gap-6" aria-label="Main">
                    {NAV_ITEMS.map(({ id, label }) => {
                        const active = mode === id
                        return (
                            <button
                                key={id}
                                type="button"
                                onClick={() => setMode(id)}
                                className={[
                                    'text-3xl font-semibold tracking-tight transition',
                                    active
                                        ? 'border-b-2 border-amber-400 pb-1 text-amber-100'
                                        : 'border-b-2 border-transparent pb-1 text-slate-500 hover:text-slate-300',
                                ].join(' ')}
                            >
                                {label}
                            </button>
                        )
                    })}
                </nav>
            </div>

            {mode === 'openings' && <OpeningsPage />}
            {mode === 'puzzles' && <PuzzlesPage />}
            {mode === 'play' && <PlayPage />}
        </div>
    )
}
