const { contextBridge } = require('electron')

contextBridge.exposeInMainWorld('graymatter', {
    platform: process.platform,
})
