import { FreePlayChessboard } from './freePlayBoard'
import { APP_VERSION } from './appVersion'

export function PuzzlesPage() {
    return (
        <div className="mx-auto flex max-w-5xl flex-col gap-8 px-4 py-10 md:flex-row md:items-start">
            <section className="flex-1 space-y-5">
                <header>
                    <p className="mt-2 text-sm leading-relaxed text-slate-400">
                        Choose a filter for the themes desired and solve the provided puzzles.
                        Puzzle training will be wired up here later; for now you can move the white
                        pieces and Black replies with a random legal move.
                    </p>
                    <p className="mt-2 font-mono text-xs text-slate-500">
                        Version {APP_VERSION}
                    </p>
                </header>

                <p className="rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2 text-sm text-slate-300">
                    Puzzle mode stub — play freely as White.
                </p>
            </section>

            <div className="board-panel w-full max-w-[min(100%,28rem)] shrink-0 self-center md:self-start">
                <FreePlayChessboard boardId="PuzzlesBoard" />
            </div>
        </div>
    )
}
