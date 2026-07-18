import type { ChangeEvent } from 'react'
import { useCallback, useRef, useState } from 'react'

import { APP_VERSION } from './appVersion'
import { TrainerChessboard, type Side } from './chessboard'
import { logRepertoireTreeDfs, resetNeedsPractice } from './moveTree'
import { parsePgnToRepertoire, type ParsedRepertoire } from './pgnPaths'
import {
    applyTrainingStatus,
    parseTrainingFileJson,
    serializeTrainingStatus,
    triggerJsonDownload,
} from './trainingExport'

const EMPTY_PATH_KEYS: ReadonlySet<string> = new Set()

export default function App() {
    const [repertoire, setRepertoire] = useState<ParsedRepertoire | null>(null)
    const [pgnName, setPgnName] = useState<string | null>(null)
    const [parseError, setParseError] = useState<string | null>(null)
    const [playerSide, setPlayerSide] = useState<Side>('w')
    const [status, setStatus] = useState('Load a PGN to start.')
    const [sessionResetKey, setSessionResetKey] = useState(0)
    const [trainingRevision, setTrainingRevision] = useState(0)

    const pgnInputRef = useRef<HTMLInputElement>(null)
    const trainingInputRef = useRef<HTMLInputElement>(null)

    const onStatusChange = useCallback((nextStatus: string) => {
        setStatus(nextStatus)
    }, [])

    const loadRepertoire = useCallback((text: string, name: string | null) => {
        const parsed = parsePgnToRepertoire(text)
        if ('error' in parsed) {
            setParseError(parsed.error ?? 'Could not parse PGN.')
            setRepertoire(null)
            setPgnName(null)
            setStatus('Load a PGN to start.')
            return
        }

        setParseError(null)
        setPgnName(name)
        setRepertoire(parsed)
        setSessionResetKey((key) => key + 1)
        logRepertoireTreeDfs(parsed.root)
    }, [])

    const onPgnFilePick = async (event: ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0]
        event.target.value = ''
        if (!file) return

        try {
            loadRepertoire(await file.text(), file.name)
        }
        catch {
            setParseError('Could not read the file.')
        }
    }

    const onTrainingFilePick = async (event: ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0]
        event.target.value = ''
        if (!file) return
        if (!repertoire) {
            setParseError('Load a PGN first, then load training status.')
            return
        }

        try {
            const parsed = parseTrainingFileJson(await file.text())
            if ('error' in parsed) {
                setParseError(parsed.error)
                return
            }

            applyTrainingStatus(repertoire.root, parsed)
            setParseError(null)
            setTrainingRevision((revision) => revision + 1)
        }
        catch {
            setParseError('Could not read the training file.')
        }
    }

    const downloadTrainingJson = () => {
        if (!repertoire) return
        const base = (pgnName ?? 'repertoire').replace(/\.[^.]+$/, '')
        triggerJsonDownload(
            serializeTrainingStatus(repertoire.root),
            `${base}-training.json`,
        )
    }

    const resetSession = () => {
        if (!repertoire) return
        resetNeedsPractice(repertoire.root)
        setSessionResetKey((key) => key + 1)
    }

    return (
        <div className="min-h-screen bg-slate-950 bg-[radial-gradient(ellipse_at_top,_#1e293b_0%,_#020617_55%)]">
            <div className="mx-auto flex max-w-5xl flex-col gap-8 px-4 py-10 md:flex-row md:items-start">
                <section className="flex-1 space-y-5">
                    <header>
                        <h1 className="text-3xl font-semibold tracking-tight text-amber-100">
                            Chess opening trainer
                        </h1>
                        <p className="mt-2 text-sm leading-relaxed text-slate-400">
                            Variations merge into one SAN trie of <code className="text-slate-300">Node</code> values. After a
                            PGN loads, the trie is printed depth-first in the console. Use Download training JSON to save each
                            node&apos;s <code className="text-slate-300">canonicalPathKey</code> (SAN path from the root) and{' '}
                            <code className="text-slate-300">needsPractice</code>. You can load that file later to restore flags
                            on the current tree. Where the repertoire branches, opponents cycle sidelines so you practise each
                            path; progress counts when your move list reaches a terminal line yourself. Finishing a line while others
                            remain returns the board to the start for the next one (session progress is kept).
                        </p>
                        <p className="mt-2 font-mono text-xs text-slate-500">
                            Version {APP_VERSION}
                        </p>
                    </header>

                    <div className="flex flex-wrap items-center gap-3">
                        <input
                            ref={pgnInputRef}
                            type="file"
                            accept=".pgn,.PGN,text/plain"
                            className="hidden"
                            onChange={onPgnFilePick}
                        />
                        <button
                            type="button"
                            onClick={() => pgnInputRef.current?.click()}
                            className="rounded-lg bg-amber-500 px-4 py-2 text-sm font-medium text-slate-950 shadow transition hover:bg-amber-400"
                        >
                            Upload PGN
                        </button>

                        <input
                            ref={trainingInputRef}
                            type="file"
                            accept=".json,application/json"
                            className="hidden"
                            onChange={onTrainingFilePick}
                        />
                        <button
                            type="button"
                            onClick={() => trainingInputRef.current?.click()}
                            disabled={!repertoire}
                            className="rounded-lg border border-slate-600 px-4 py-2 text-sm text-slate-200 transition enabled:hover:border-amber-500/60 enabled:hover:text-amber-100 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                            Load training JSON
                        </button>

                        <button
                            type="button"
                            onClick={downloadTrainingJson}
                            disabled={!repertoire}
                            className="rounded-lg border border-slate-600 px-4 py-2 text-sm text-slate-200 transition enabled:hover:border-amber-500/60 enabled:hover:text-amber-100 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                            Download training JSON
                        </button>

                        <span className="text-sm text-slate-500">
                            {pgnName ?? 'No file selected'}
                        </span>
                    </div>

                    <fieldset className="space-y-2 rounded-xl border border-slate-700/80 bg-slate-900/50 p-4">
                        <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
                            Side
                        </legend>
                        <div className="flex flex-wrap gap-4">
                            <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-200">
                                <input
                                    type="radio"
                                    name="side"
                                    checked={playerSide === 'w'}
                                    onChange={() => setPlayerSide('w')}
                                    className="accent-amber-500"
                                />
                                White
                            </label>
                            <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-200">
                                <input
                                    type="radio"
                                    name="side"
                                    checked={playerSide === 'b'}
                                    onChange={() => setPlayerSide('b')}
                                    className="accent-amber-500"
                                />
                                Black
                            </label>
                        </div>
                        <p className="text-xs text-slate-500">
                            As Black, if White has multiple first moves, the alphabetically first SAN is used to start each
                            session.
                        </p>
                    </fieldset>

                    <div className="flex flex-wrap gap-2">
                        <button
                            type="button"
                            onClick={resetSession}
                            disabled={!repertoire}
                            className="rounded-lg border border-slate-600 px-3 py-1.5 text-sm text-slate-200 transition enabled:hover:border-amber-500/60 enabled:hover:text-amber-100 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                            Reset session
                        </button>
                    </div>

                    {parseError && (
                        <p className="rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-200">
                            {parseError}
                        </p>
                    )}

                    <p className="rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2 text-sm text-slate-300">
                        {status}
                    </p>
                </section>

                <div className="board-panel w-full max-w-[min(100%,28rem)] shrink-0 self-center md:self-start">
                    <TrainerChessboard
                        root={repertoire?.root ?? null}
                        terminalLineCount={repertoire?.terminalLineCount ?? 0}
                        terminalPathKeys={repertoire?.terminalPathKeys ?? EMPTY_PATH_KEYS}
                        playerSide={playerSide}
                        sessionResetKey={sessionResetKey}
                        trainingRevision={trainingRevision}
                        onStatusChange={onStatusChange}
                    />
                </div>
            </div>
        </div>
    )
}
