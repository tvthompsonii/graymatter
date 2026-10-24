import { sideOfCardId } from './repertoireCards'
import type { ReviewRecord, ReviewState, Schedule } from './srs'

/**
 * TrainingStatus.json: one row per reviewed card, split by side and sorted by `due` so the next
 * reviews are at the top. Cards that have never been reviewed have no row.
 */
export type TrainingFile = {
    version: 4
    keyKind: 'positionMove'
    white: ReviewRecord[]
    black: ReviewRecord[]
}

const REVIEW_STATES: readonly ReviewState[] = ['learning', 'review', 'relearning']

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value)
}

function parseRecord(raw: unknown): ReviewRecord | null {
    if (!raw || typeof raw !== 'object') return null
    const o = raw as Record<string, unknown>
    if (
        typeof o.id !== 'string'
        || !REVIEW_STATES.includes(o.state as ReviewState)
        || typeof o.due !== 'string' || Number.isNaN(Date.parse(o.due))
        || typeof o.lastReviewed !== 'string' || Number.isNaN(Date.parse(o.lastReviewed))
        || !isFiniteNumber(o.intervalDays)
        || !isFiniteNumber(o.ease)
        || !isFiniteNumber(o.reps)
        || !isFiniteNumber(o.lapses)
    ) {
        return null
    }
    return {
        id: o.id,
        san: typeof o.san === 'string' ? o.san : '',
        line: typeof o.line === 'string' ? o.line : '',
        state: o.state as ReviewState,
        due: o.due,
        intervalDays: o.intervalDays,
        ease: o.ease,
        reps: o.reps,
        lapses: o.lapses,
        step: isFiniteNumber(o.step) ? o.step : 0,
        introduced: typeof o.introduced === 'string' ? o.introduced : o.lastReviewed.slice(0, 10),
        lastReviewed: o.lastReviewed,
        attempts: isFiniteNumber(o.attempts) ? o.attempts : 0,
        correct: isFiniteNumber(o.correct) ? o.correct : 0,
    }
}

/**
 * Reads the schedule from TrainingStatus.json text. Anything that isn't a v4 file (an older
 * line-based v3 file, or bad JSON) reads as an empty schedule and is replaced on the next save.
 */
export function parseTrainingFileJson(text: string): Schedule {
    const schedule: Schedule = new Map()
    try {
        const raw = JSON.parse(text) as Partial<TrainingFile> | null
        if (!raw || raw.version !== 4 || raw.keyKind !== 'positionMove') return schedule
        for (const list of [raw.white, raw.black]) {
            if (!Array.isArray(list)) continue
            for (const row of list) {
                const r = parseRecord(row)
                if (r) schedule.set(r.id, r)
            }
        }
    }
    catch {
        // Not JSON: start with an empty schedule.
    }
    return schedule
}

/** Reads TrainingStatus.json; a missing or unreadable file is an empty schedule. */
export async function readSchedule(path: string): Promise<Schedule> {
    try {
        return parseTrainingFileJson(await window.graymatter.readTextFile(path))
    }
    catch {
        return new Map()
    }
}

export function serializeTrainingFile(schedule: Schedule): string {
    const bySide = (side: 'w' | 'b') => [...schedule.values()]
        .filter((r) => sideOfCardId(r.id) === side)
        .sort((a, b) => Date.parse(a.due) - Date.parse(b.due) || a.id.localeCompare(b.id))
    const file: TrainingFile = {
        version: 4,
        keyKind: 'positionMove',
        white: bySide('w'),
        black: bySide('b'),
    }
    return JSON.stringify(file, null, 4)
}

/** Union of two schedules; where both have a card, the more recently reviewed record wins. */
export function mergeSchedules(a: Schedule, b: Schedule): Schedule {
    const merged: Schedule = new Map(a)
    for (const [id, r] of b) {
        const other = merged.get(id)
        if (!other || Date.parse(r.lastReviewed) >= Date.parse(other.lastReviewed)) merged.set(id, r)
    }
    return merged
}
