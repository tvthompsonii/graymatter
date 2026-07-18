const { app, BrowserWindow, shell } = require('electron')
const path = require('path')

const isDev = !app.isPackaged

function createWindow() {
    const win = new BrowserWindow({
        width: 1280,
        height: 860,
        minWidth: 900,
        minHeight: 640,
        show: false,
        autoHideMenuBar: true,
        backgroundColor: '#020617',
        title: 'Chess Opening Trainer',
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
