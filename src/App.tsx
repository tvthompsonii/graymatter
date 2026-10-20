import { useCallback, useEffect, useRef, useState, type ComponentType } from 'react'

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
import { BookIcon, PuzzleIcon, SwordsIcon, XIcon } from './ui/icons'

export type AppMode = 'openings' | 'puzzles' | 'play'

const NAV_ITEMS: Array<{ id: AppMode; label: string; Icon: ComponentType<{ size?: number }> }> = [
    { id: 'openings', label: 'Openings', Icon: BookIcon },
    { id: 'puzzles', label: 'Puzzles', Icon: PuzzleIcon },
    { id: 'play', label: 'Play', Icon: SwordsIcon },
]

/** `0.<n>-<date>` → ["v0.<n>", "<date>"] for the two-line label at the foot of the rail. */
function versionLines(version: string): [string, string] {
    const dash = version.indexOf('-')
    return dash < 0 ? [`v${version}`, ''] : [`v${version.slice(0, dash)}`, version.slice(dash + 1)]
}

function NavRail({ mode, onSelect }: { mode: AppMode; onSelect: (mode: AppMode) => void }) {
    const [versionNumber, versionDate] = versionLines(APP_VERSION)
    return (
        <nav
            aria-label="Main"
            className="flex w-[76px] shrink-0 flex-col items-center gap-1.5 border-r border-[#1c2536] bg-rail pb-3.5 pt-[18px]"
        >
            <svg width="40" height="40" viewBox="0 0 40 40" role="img" aria-label="GrayMatter" className="mb-3.5">
                <rect width="40" height="40" rx="11" fill="var(--color-accent)" />
                <text
                    x="20"
                    y="25.5"
                    textAnchor="middle"
                    fontSize="15"
                    fontWeight="700"
                    fill="var(--color-on-accent)"
                    style={{ fontFamily: 'var(--font-sans)' }}
                >
                    GM
                </text>
            </svg>
            {NAV_ITEMS.map(({ id, label, Icon }) => {
                const active = mode === id
                return (
                    <button
                        key={id}
                        type="button"
                        aria-current={active ? 'page' : undefined}
                        onClick={() => onSelect(id)}
                        className={`flex h-[58px] w-[60px] flex-col items-center justify-center gap-[5px] rounded-xl text-[11px] transition ${
                            active
                                ? 'bg-accent/15 font-semibold text-accent-ink'
                                : 'font-medium text-faint hover:bg-raised hover:text-body'
                        }`}
                    >
                        <Icon size={20} />
                        {label}
                    </button>
                )
            })}
            <div className="mt-auto text-center font-mono text-[10px] leading-snug text-dim" title={`Version ${APP_VERSION}`}>
                {versionNumber}
                {versionDate && <><br />{versionDate}</>}
            </div>
        </nav>
    )
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
        <div className="flex h-screen overflow-hidden bg-bg">
            <NavRail mode={mode} onSelect={setMode} />
            <main className="relative min-w-0 flex-1 overflow-y-auto">
                {settingsError && (
                    <div
                        role="alert"
                        className="absolute left-1/2 top-3 z-50 flex max-w-md -translate-x-1/2 items-center gap-2 rounded-[10px] border border-danger/40 bg-[#2a1215] px-3 py-2 text-[13px] text-red-200 shadow-lg"
                    >
                        <span>{settingsError}</span>
                        <button
                            type="button"
                            aria-label="Dismiss"
                            onClick={() => setSettingsError(null)}
                            className="rounded p-0.5 text-red-300 hover:bg-danger/20"
                        >
                            <XIcon size={14} />
                        </button>
                    </div>
                )}

                {mode === 'openings' && settingsLoaded && (
                    <OpeningsPage settings={settings} onSettingsChange={updateSettings} />
                )}
                {mode === 'puzzles' && settingsLoaded && (
                    <PuzzlesPage settings={settings} onSettingsChange={updateSettings} />
                )}
                {mode === 'play' && <PlayPage />}
            </main>
        </div>
    )
}
