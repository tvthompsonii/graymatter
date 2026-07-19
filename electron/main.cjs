const { app, BrowserWindow, ipcMain, shell } = require('electron')
const fs = require('fs')
const path = require('path')

const isDev = !app.isPackaged

const GRAYMATTER_DIR = path.join(
    app.getPath('documents'),
    'GrayMatter',
)

const PATHS = {
    whitePgn: path.join(GRAYMATTER_DIR, 'WhiteDenormalized.pgn'),
    blackPgn: path.join(GRAYMATTER_DIR, 'BlackDenormalized.pgn'),
    trainingStatus: path.join(GRAYMATTER_DIR, 'TrainingStatus.json'),
}

ipcMain.handle('graymatter:getPaths', () => PATHS)

ipcMain.handle('graymatter:readTextFile', async (_event, filePath) => {
    return fs.promises.readFile(filePath, 'utf8')
})

ipcMain.handle('graymatter:writeTextFile', async (_event, filePath, contents) => {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true })
    await fs.promises.writeFile(filePath, contents, 'utf8')
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
