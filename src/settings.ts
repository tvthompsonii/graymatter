export type AppSettings = {
    trainingDepth: number
}

export const DEFAULT_SETTINGS: AppSettings = {
    trainingDepth: 7,
}

export function parseSettingsJson(text: string): AppSettings | { error: string } {
    try {
        const raw = JSON.parse(text) as unknown
        if (!raw || typeof raw !== 'object') return { error: 'Invalid settings JSON.' }
        const o = raw as Partial<AppSettings>
        const trainingDepth = Number(o.trainingDepth)
        if (!Number.isFinite(trainingDepth) || trainingDepth < 1 || !Number.isInteger(trainingDepth)) {
            return { error: 'trainingDepth must be a positive integer.' }
        }
        return { trainingDepth }
    }
    catch {
        return { error: 'Could not parse settings JSON.' }
    }
}

export function serializeSettings(settings: AppSettings): string {
    return JSON.stringify(settings, null, 4)
}
