const { app, BrowserWindow, ipcMain, shell } = require('electron')
const fs = require('fs')
const path = require('path')
const { findNextPuzzleFromCsv, readPuzzleStatus, writePuzzleStatus } = require('./puzzleStream.cjs')

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

    if (puzzle) {
        await writePuzzleStatus(PATHS.puzzleStatus, {
            nextByteOffset: puzzle.nextByteOffset,
            lastPuzzleId: puzzle.id,
        })
        const { nextByteOffset: _offset, ...payload } = puzzle
        return { puzzle: payload }
    }

    return { puzzle: null, noMatches: true }
})

function createWindow() {
    const win = new BrowserWindow({
        width: 1280,
        height: 860,
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
