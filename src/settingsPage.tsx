import { useEffect, useState } from 'react'

import { APP_VERSION } from './appVersion'
import type { AppSettings } from './settings'

type SettingsPageProps = {
    settings: AppSettings
    onSave: (next: AppSettings) => Promise<void>
}

export function SettingsPage({ settings, onSave }: SettingsPageProps) {
    const [trainingDepth, setTrainingDepth] = useState(String(settings.trainingDepth))
    const [error, setError] = useState<string | null>(null)
    const [savedHint, setSavedHint] = useState<string | null>(null)
    const [saving, setSaving] = useState(false)

    useEffect(() => {
        setTrainingDepth(String(settings.trainingDepth))
    }, [settings.trainingDepth])

    const save = async () => {
        const parsed = Number(trainingDepth)
        if (!Number.isInteger(parsed) || parsed < 1) {
            setError('Training depth must be a whole number of at least 1.')
            setSavedHint(null)
            return
        }

        setSaving(true)
        setError(null)
        try {
            await onSave({ trainingDepth: parsed })
            setSavedHint('Settings saved.')
        }
        catch (err) {
            setError(err instanceof Error ? err.message : 'Could not save settings.')
            setSavedHint(null)
        }
        finally {
            setSaving(false)
        }
    }

    return (
        <div className="mx-auto flex max-w-5xl flex-col gap-8 px-4 py-10">
            <section className="max-w-xl space-y-5">
                <header>
                    <p className="mt-2 text-sm leading-relaxed text-slate-400">
                        Adjust how GrayMatter trains and plays. Settings are stored in
                        Documents/GrayMatter/settings.json.
                    </p>
                    <p className="mt-2 font-mono text-xs text-slate-500">
                        Version {APP_VERSION}
                    </p>
                </header>

                <fieldset className="space-y-3 rounded-xl border border-slate-700/80 bg-slate-900/50 p-4">
                    <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Openings
                    </legend>
                    <label className="block space-y-1.5 text-sm text-slate-200">
                        <span className="font-medium">Training depth</span>
                        <input
                            type="number"
                            min={1}
                            step={1}
                            value={trainingDepth}
                            onChange={(event) => {
                                setTrainingDepth(event.target.value)
                                setSavedHint(null)
                            }}
                            className="w-full rounded-lg border border-slate-600 bg-slate-950 px-3 py-2 text-slate-100 outline-none focus:border-amber-500/60"
                        />
                    </label>
                    <p className="text-xs text-slate-500">
                        Maximum number of your moves to train on each line. After you play that many
                        moves, GrayMatter advances to the next line.
                    </p>
                </fieldset>

                <div className="flex flex-wrap items-center gap-3">
                    <button
                        type="button"
                        onClick={() => void save()}
                        disabled={saving}
                        className="rounded-lg border border-slate-600 px-3 py-1.5 text-sm text-slate-200 transition enabled:hover:border-amber-500/60 enabled:hover:text-amber-100 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                        Save settings
                    </button>
                    {savedHint && (
                        <span className="text-sm text-emerald-300/90">{savedHint}</span>
                    )}
                </div>

                {error && (
                    <p className="rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-200">
                        {error}
                    </p>
                )}
            </section>
        </div>
    )
}
