import { useCallback, useEffect, useRef, useState } from 'react'

import { APP_VERSION } from './appVersion'
import { OpeningsPage } from './openings'
import { PlayPage } from './play'
import { PuzzlesPage } from './puzzles'
import {
    DEFAULT_SETTINGS,
    parseSettingsJson,
    serializeSettings,
    type AppSettings,
} from './settings'

export type AppMode = 'openings' | 'puzzles' | 'play'

const NAV_ITEMS: Array<{ id: AppMode; label: string }> = [
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
    const [settingsLoaded, setSettingsLoaded] = useState(false)
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
            finally {
                if (!cancelled) setSettingsLoaded(true)
            }
        })()

        return () => {
            cancelled = true
        }
    }, [])

    const settingsRef = useRef(settings)
    settingsRef.current = settings

    const updateSettings = useCallback((patch: Partial<AppSettings>) => {
        const next = { ...settingsRef.current, ...patch }
        settingsRef.current = next
        setSettings(next)
        if (!settingsPath) return
        window.graymatter.writeTextFile(settingsPath, serializeSettings(next))
            .then(() => setSettingsError(null))
            .catch((err: unknown) => {
                setSettingsError(
                    err instanceof Error ? err.message : 'Could not save settings.',
                )
            })
    }, [settingsPath])

    return (
        <div className="min-h-screen bg-slate-950 bg-[radial-gradient(ellipse_at_top,_#1e293b_0%,_#020617_55%)]">
            <p className="fixed right-4 top-3 font-mono text-xs text-slate-500">
                Version {APP_VERSION}
            </p>
            <div className="mx-auto max-w-5xl px-4 pt-10">
                <nav className="flex flex-wrap items-end gap-6" aria-label="Main">
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
                </nav>
                {settingsError && (
                    <p className="mt-3 text-sm text-red-300">{settingsError}</p>
                )}
            </div>

            {mode === 'openings' && settingsLoaded && (
                <OpeningsPage settings={settings} onSettingsChange={updateSettings} />
            )}
            {mode === 'puzzles' && settingsLoaded && (
                <PuzzlesPage settings={settings} onSettingsChange={updateSettings} />
            )}
            {mode === 'play' && <PlayPage />}
        </div>
    )
}
