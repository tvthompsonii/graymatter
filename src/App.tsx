import { useCallback, useEffect, useRef, useState } from 'react'

import { APP_VERSION } from './appVersion'
import { TrainerChessboard, type Side } from './chessboard'
import type { GraymatterPaths } from './graymatter'
import {
    logRepertoireTreeDfs,
    pickRandomPracticePath,
    resetNeedsPractice,
    treeHasPracticeRemaining,
} from './moveTree'
import { parsePgnToRepertoire, type ParsedRepertoire } from './pgnPaths'
import {
    applyDualTrainingStatus,
    parseTrainingFileJson,
    serializeDualTrainingStatus,
} from './trainingExport'

const EMPTY_PATH_KEYS: ReadonlySet<string> = new Set()

export type TrainMode = 'both' | 'white' | 'black'

function pickActiveSide(
    mode: TrainMode,
    white: ParsedRepertoire | null,
    black: ParsedRepertoire | null,
): Side | null {
    const whiteOk = mode !== 'black' && !!white && treeHasPracticeRemaining(white.root, 'w')
    const blackOk = mode !== 'white' && !!black && treeHasPracticeRemaining(black.root, 'b')

    if (mode === 'white') return white ? 'w' : null
    if (mode === 'black') return black ? 'b' : null

    const candidates: Side[] = []
    if (whiteOk) candidates.push('w')
    if (blackOk) candidates.push('b')
    if (candidates.length) {
        return candidates[Math.floor(Math.random() * candidates.length)]!
    }

    if (white) return 'w'
    if (black) return 'b'
    return null
}

function modeHasPracticeRemaining(
    mode: TrainMode,
    white: ParsedRepertoire | null,
    black: ParsedRepertoire | null,
): boolean {
    if (mode !== 'black' && white && treeHasPracticeRemaining(white.root, 'w')) return true
    if (mode !== 'white' && black && treeHasPracticeRemaining(black.root, 'b')) return true
    return false
}

export default function App() {
    const [paths, setPaths] = useState<GraymatterPaths | null>(null)
    const [whiteRepertoire, setWhiteRepertoire] = useState<ParsedRepertoire | null>(null)
    const [blackRepertoire, setBlackRepertoire] = useState<ParsedRepertoire | null>(null)
    const [parseError, setParseError] = useState<string | null>(null)
    const [trainMode, setTrainMode] = useState<TrainMode>('both')
    const [activeSide, setActiveSide] = useState<Side>('w')
    const [targetPath, setTargetPath] = useState<string[] | null>(null)
    const [status, setStatus] = useState('Loading repertoires…')
    const [sessionResetKey, setSessionResetKey] = useState(0)
    const [lessonKey, setLessonKey] = useState(0)
    const [trainingRevision, setTrainingRevision] = useState(0)
    const [ready, setReady] = useState(false)

    const whiteRef = useRef<ParsedRepertoire | null>(null)
    const blackRef = useRef<ParsedRepertoire | null>(null)
    const pathsRef = useRef<GraymatterPaths | null>(null)
    const saveChainRef = useRef(Promise.resolve())

    whiteRef.current = whiteRepertoire
    blackRef.current = blackRepertoire
    pathsRef.current = paths

    const activeRepertoire =
        activeSide === 'w' ? whiteRepertoire : blackRepertoire

    const persistTraining = useCallback(() => {
        const currentPaths = pathsRef.current
        const white = whiteRef.current
        const black = blackRef.current
        if (!currentPaths || !white || !black) return

        const payload = serializeDualTrainingStatus(white.root, black.root)
        const text = JSON.stringify(payload, null, 4)
        saveChainRef.current = saveChainRef.current
            .then(() => window.graymatter.writeTextFile(currentPaths.trainingStatus, text))
            .catch((err: unknown) => {
                console.error('Failed to save training status', err)
                setParseError('Could not save TrainingStatus.json.')
            })
    }, [])

    const onStatusChange = useCallback((nextStatus: string) => {
        setStatus(nextStatus)
    }, [])

    const onTrainingChanged = useCallback(() => {
        persistTraining()
    }, [persistTraining])

    const beginLesson = useCallback((
        mode: TrainMode,
        white: ParsedRepertoire | null,
        black: ParsedRepertoire | null,
        opts?: { resetSession?: boolean },
    ) => {
        const side = pickActiveSide(mode, white, black)
        if (!side) return

        const rep = side === 'w' ? white : black
        if (!rep || !modeHasPracticeRemaining(mode, white, black)) {
            setActiveSide(side)
            setTargetPath(null)
            setStatus('All lines practiced. Reset training progress to start over.')
            return
        }

        const path = pickRandomPracticePath(rep.root, side)
        if (!path) {
            setActiveSide(side)
            setTargetPath(null)
            setStatus('All lines practiced. Reset training progress to start over.')
            return
        }

        setActiveSide(side)
        setTargetPath(path)
        if (opts?.resetSession) setSessionResetKey((key) => key + 1)
        setLessonKey((key) => key + 1)
    }, [])

    const onLessonComplete = useCallback(() => {
        beginLesson(trainMode, whiteRef.current, blackRef.current)
    }, [beginLesson, trainMode])

    const onTrainModeChange = (mode: TrainMode) => {
        setTrainMode(mode)
        beginLesson(mode, whiteRef.current, blackRef.current, { resetSession: true })
    }

    const resetTrainingProgress = () => {
        if (whiteRepertoire) resetNeedsPractice(whiteRepertoire.root)
        if (blackRepertoire) resetNeedsPractice(blackRepertoire.root)
        persistTraining()
        setTrainingRevision((revision) => revision + 1)
        beginLesson(trainMode, whiteRepertoire, blackRepertoire, { resetSession: true })
    }

    useEffect(() => {
        let cancelled = false

        void (async () => {
            try {
                if (!window.graymatter) {
                    setParseError('GrayMatter file API is unavailable. Run this app in Electron.')
                    return
                }

                const resolvedPaths = await window.graymatter.getPaths()
                if (cancelled) return
                setPaths(resolvedPaths)

                const [whiteText, blackText] = await Promise.all([
                    window.graymatter.readTextFile(resolvedPaths.whitePgn),
                    window.graymatter.readTextFile(resolvedPaths.blackPgn),
                ])
                if (cancelled) return

                const whiteParsed = parsePgnToRepertoire(whiteText)
                const blackParsed = parsePgnToRepertoire(blackText)

                if ('error' in whiteParsed) {
                    setParseError(`White PGN: ${whiteParsed.error ?? 'Could not parse.'}`)
                    return
                }
                if ('error' in blackParsed) {
                    setParseError(`Black PGN: ${blackParsed.error ?? 'Could not parse.'}`)
                    return
                }

                try {
                    const trainingText = await window.graymatter.readTextFile(
                        resolvedPaths.trainingStatus,
                    )
                    const training = parseTrainingFileJson(trainingText)
                    if (!('error' in training)) {
                        applyDualTrainingStatus(
                            whiteParsed.root,
                            blackParsed.root,
                            training,
                        )
                    }
                }
                catch {
                    // No training file yet — start with needsPractice defaults.
                }

                if (cancelled) return

                setWhiteRepertoire(whiteParsed)
                setBlackRepertoire(blackParsed)
                setParseError(null)
                logRepertoireTreeDfs(whiteParsed.root)
                logRepertoireTreeDfs(blackParsed.root)
                setReady(true)
                beginLesson('both', whiteParsed, blackParsed)
            }
            catch (err) {
                if (cancelled) return
                const message = err instanceof Error ? err.message : String(err)
                setParseError(`Could not load repertoire files: ${message}`)
            }
        })()

        return () => {
            cancelled = true
        }
    }, [beginLesson])

    return (
        <div className="min-h-screen bg-slate-950 bg-[radial-gradient(ellipse_at_top,_#1e293b_0%,_#020617_55%)]">
            <div className="mx-auto flex max-w-5xl flex-col gap-8 px-4 py-10 md:flex-row md:items-start">
                <section className="flex-1 space-y-5">
                    <header>
                        <h1 className="text-3xl font-semibold tracking-tight text-amber-100">
                            Chess opening trainer
                        </h1>
                        <p className="mt-2 text-sm leading-relaxed text-slate-400">
                            White and black repertoires load automatically from Documents/GrayMatter.
                            Progress is saved to TrainingStatus.json after each practiced move. Choose
                            Train Both to alternate randomly between the two books, or lock training to
                            one side. Only lines with unpracticed moves for your side are selected.
                        </p>
                        <p className="mt-2 font-mono text-xs text-slate-500">
                            Version {APP_VERSION}
                        </p>
                    </header>

                    <fieldset className="space-y-2 rounded-xl border border-slate-700/80 bg-slate-900/50 p-4">
                        <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
                            Train
                        </legend>
                        <div className="flex flex-wrap gap-4">
                            <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-200">
                                <input
                                    type="radio"
                                    name="train"
                                    checked={trainMode === 'both'}
                                    onChange={() => onTrainModeChange('both')}
                                    className="accent-amber-500"
                                />
                                Both
                            </label>
                            <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-200">
                                <input
                                    type="radio"
                                    name="train"
                                    checked={trainMode === 'white'}
                                    onChange={() => onTrainModeChange('white')}
                                    className="accent-amber-500"
                                />
                                White
                            </label>
                            <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-200">
                                <input
                                    type="radio"
                                    name="train"
                                    checked={trainMode === 'black'}
                                    onChange={() => onTrainModeChange('black')}
                                    className="accent-amber-500"
                                />
                                Black
                            </label>
                        </div>
                        <p className="text-xs text-slate-500">
                            Both picks the next unpracticed line at random from either repertoire. White
                            and Black only train that side&apos;s book.
                        </p>
                    </fieldset>

                    <div className="flex flex-wrap gap-2">
                        <button
                            type="button"
                            onClick={resetTrainingProgress}
                            disabled={!ready}
                            className="rounded-lg border border-slate-600 px-3 py-1.5 text-sm text-slate-200 transition enabled:hover:border-amber-500/60 enabled:hover:text-amber-100 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                            Reset training progress
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
                        root={ready ? (activeRepertoire?.root ?? null) : null}
                        terminalLineCount={activeRepertoire?.terminalLineCount ?? 0}
                        terminalPathKeys={activeRepertoire?.terminalPathKeys ?? EMPTY_PATH_KEYS}
                        playerSide={activeSide}
                        targetPath={targetPath}
                        sessionResetKey={sessionResetKey}
                        lessonKey={lessonKey}
                        trainingRevision={trainingRevision}
                        onStatusChange={onStatusChange}
                        onLessonComplete={onLessonComplete}
                        onTrainingChanged={onTrainingChanged}
                    />
                </div>
            </div>
        </div>
    )
}
