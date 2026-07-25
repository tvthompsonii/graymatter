const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('graymatter', {
    platform: process.platform,
    getPaths: () => ipcRenderer.invoke('graymatter:getPaths'),
    readTextFile: (filePath) => ipcRenderer.invoke('graymatter:readTextFile', filePath),
    writeTextFile: (filePath, contents) =>
        ipcRenderer.invoke('graymatter:writeTextFile', filePath, contents),
    pickRandomPuzzle: (filters) => ipcRenderer.invoke('graymatter:fetchNextPuzzle', filters),
    fetchNextPuzzle: (filters) => ipcRenderer.invoke('graymatter:fetchNextPuzzle', filters),
})
