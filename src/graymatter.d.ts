export type GraymatterPaths = {
    whitePgn: string
    blackPgn: string
    trainingStatus: string
}

export type GraymatterApi = {
    platform: NodeJS.Platform
    getPaths: () => Promise<GraymatterPaths>
    readTextFile: (filePath: string) => Promise<string>
    writeTextFile: (filePath: string, contents: string) => Promise<void>
}

declare global {
    interface Window {
        graymatter: GraymatterApi
    }
}

export {}
