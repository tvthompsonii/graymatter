import { useCallback, useEffect, useState } from 'react'

import { OpeningsPage } from './openings'
import { PlayPage } from './play'
import { PuzzlesPage } from './puzzles'
import {
    DEFAULT_SETTINGS,
    parseSettingsJson,
    serializeSettings,
    type AppSettings,
} from './settings'
import { SettingsPage } from './settingsPage'

export type AppMode = 'openings' | 'puzzles' | 'play' | 'settings'

const NAV_ITEMS: Array<{ id: Exclude<AppMode, 'settings'>; label: string }> = [
    { id: 'openings', label: 'Openings' },
    { id: 'puzzles', label: 'Puzzles' },
    { id: 'play', label: 'Play' },
]

function navClass(active: boolean): string {
    return [
        'text-3xl font-semibold tracking-tight transition',
        active
            ? 'border-b-2 border-amber-400 pb-1 text-amber-100'
            : 'border-b-2 border-transparent pb-1 text-slate-500 hover:text-slate-300',
    ].join(' ')
}

export default function App() {
    const [mode, setMode] = useState<AppMode>('openings')
    const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS)
    const [settingsPath, setSettingsPath] = useState<string | null>(null)
    const [settingsError, setSettingsError] = useState<string | null>(null)

    useEffect(() => {
        let cancelled = false

        void (async () => {
            try {
                if (!window.graymatter) return
                const paths = await window.graymatter.getPaths()
                if (cancelled) return
                setSettingsPath(paths.settings)

                try {
                    const text = await window.graymatter.readTextFile(paths.settings)
                    const parsed = parseSettingsJson(text)
                    if ('error' in parsed) {
                        setSettingsError(parsed.error)
                        await window.graymatter.writeTextFile(
                            paths.settings,
                            serializeSettings(DEFAULT_SETTINGS),
                        )
                        setSettings(DEFAULT_SETTINGS)
                    }
                    else {
                        setSettings(parsed)
                    }
                }
                catch {
                    await window.graymatter.writeTextFile(
                        paths.settings,
                        serializeSettings(DEFAULT_SETTINGS),
                    )
                    if (!cancelled) setSettings(DEFAULT_SETTINGS)
                }
            }
            catch (err) {
                if (!cancelled) {
                    setSettingsError(
                        err instanceof Error ? err.message : 'Could not load settings.',
                    )
                }
            }
        })()

        return () => {
            cancelled = true
        }
    }, [])

    const saveSettings = useCallback(async (next: AppSettings) => {
        if (!settingsPath) throw new Error('Settings path is not ready yet.')
        await window.graymatter.writeTextFile(settingsPath, serializeSettings(next))
        setSettings(next)
        setSettingsError(null)
    }, [settingsPath])

    return (
        <div className="min-h-screen bg-slate-950 bg-[radial-gradient(ellipse_at_top,_#1e293b_0%,_#020617_55%)]">
            <div className="mx-auto max-w-5xl px-4 pt-10">
                <nav className="flex flex-wrap items-end justify-between gap-6" aria-label="Main">
                    <div className="flex flex-wrap items-end gap-6">
                        {NAV_ITEMS.map(({ id, label }) => (
                            <button
                                key={id}
                                type="button"
                                onClick={() => setMode(id)}
                                className={navClass(mode === id)}
                            >
                                {label}
                            </button>
                        ))}
                    </div>
                    <button
                        type="button"
                        onClick={() => setMode('settings')}
                        className={navClass(mode === 'settings')}
                    >
                        Settings
                    </button>
                </nav>
                {settingsError && (
                    <p className="mt-3 text-sm text-red-300">{settingsError}</p>
                )}
            </div>

            {mode === 'openings' && (
                <OpeningsPage trainingDepth={settings.trainingDepth} />
            )}
            {mode === 'puzzles' && <PuzzlesPage />}
            {mode === 'play' && <PlayPage />}
            {mode === 'settings' && (
                <SettingsPage settings={settings} onSave={saveSettings} />
            )}
        </div>
    )
}
