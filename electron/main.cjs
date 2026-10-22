const { app, BrowserWindow, ipcMain, shell } = require('electron')
const fs = require('fs')
const path = require('path')
const {
    collectSurvivalSet,
    findNextPuzzleFromCsv,
    readPuzzleStatus,
    writePuzzleStatus,
} = require('./puzzleStream.cjs')

const isDev = !app.isPackaged

// Data lives in Google Drive (synced locally, "Available offline") so desktop and
// laptop share the same repertoires, settings, and progress.
const GRAYMATTER_DIR = 'G:/My Drive/Tom/Chess/GrayMatter'

const PATHS = {
    whitePgn: path.join(GRAYMATTER_DIR, 'WhiteDenormalized.pgn'),
    blackPgn: path.join(GRAYMATTER_DIR, 'BlackDenormalized.pgn'),
    trainingStatus: path.join(GRAYMATTER_DIR, 'TrainingStatus.json'),
    settings: path.join(GRAYMATTER_DIR, 'settings.json'),
    puzzlesCsv: path.join(GRAYMATTER_DIR, 'lichess_db_puzzles.csv'),
    puzzleStatus: path.join(GRAYMATTER_DIR, 'PuzzleStatus.json'),
}

ipcMain.handle('graymatter:getPaths', () => PATHS)

ipcMain.handle('graymatter:readTextFile', async (_event, filePath) => {
    return fs.promises.readFile(filePath, 'utf8')
})

ipcMain.handle('graymatter:writeTextFile', async (_event, filePath, contents) => {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true })
    await fs.promises.writeFile(filePath, contents, 'utf8')
})

ipcMain.handle('graymatter:fetchNextPuzzle', async (_event, filters) => {
    const status = await readPuzzleStatus(PATHS.puzzleStatus)
    let puzzle = await findNextPuzzleFromCsv(
        PATHS.puzzlesCsv,
        status.nextByteOffset,
        filters,
    )

    if (!puzzle && status.nextByteOffset > 0) {
        puzzle = await findNextPuzzleFromCsv(
            PATHS.puzzlesCsv,
            0,
            filters,
            status.nextByteOffset,
        )
    }

    // The cursor is left alone: the same puzzle comes back (across mode switches and restarts)
    // until the renderer reports it solved or skipped through advancePuzzleCursor.
    if (puzzle) {
        const { nextByteOffset, ...payload } = puzzle
        return { puzzle: payload, nextByteOffset }
    }

    return { puzzle: null, noMatches: true }
})

ipcMain.handle('graymatter:advancePuzzleCursor', async (_event, { nextByteOffset, lastPuzzleId }) => {
    await writePuzzleStatus(PATHS.puzzleStatus, { nextByteOffset, lastPuzzleId })
})

ipcMain.handle('graymatter:fetchSurvivalSet', async (_event, request) => {
    const status = await readPuzzleStatus(PATHS.puzzleStatus)
    const result = await collectSurvivalSet(PATHS.puzzlesCsv, status.nextByteOffset, request)

    // Advance the shared cursor past everything scanned, so Practice also serves new puzzles.
    if (result.nextByteOffset !== null) {
        await writePuzzleStatus(PATHS.puzzleStatus, {
            nextByteOffset: result.nextByteOffset,
            lastPuzzleId: result.lastPuzzleId,
        })
    }

    return { puzzles: result.puzzles }
})

function createWindow() {
    const win = new BrowserWindow({
        // Content size (not including the frame). The board is sized from the window height
        // (`.board-slot` in index.css): at 859px tall it is 811px, leaving ~362px for the side
        // panel next to the 76px nav rail. The minimums keep at least 18rem for the panel.
        useContentSize: true,
        width: 1321,
        height: 859,
        minWidth: 900,
        minHeight: 640,
        show: false,
        autoHideMenuBar: true,
        backgroundColor: '#020617',
        title: 'GrayMatter',
        webPreferences: {
            preload: path.join(__dirname, 'preload.cjs'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
        },
    })

    win.once('ready-to-show', () => {
        win.show()
    })

    win.webContents.setWindowOpenHandler(({ url }) => {
        void shell.openExternal(url)
        return { action: 'deny' }
    })

    if (isDev) {
        void win.loadURL(process.env.VITE_DEV_SERVER_URL ?? 'http://127.0.0.1:5173')
    }
    else {
        void win.loadFile(path.join(__dirname, '../dist/index.html'))
    }
}

app.whenReady().then(() => {
    createWindow()

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
})

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
})
