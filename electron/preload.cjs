'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('liencamHost', Object.freeze({
  platform: process.platform,
  versions: Object.freeze({
    chrome: process.versions.chrome,
    electron: process.versions.electron,
  }),
  // WO-1259: the renderer passes the build provenance compiled INTO this bundle
  // so the main process can compare the renderer inputs' contents against the
  // revision this running code was actually built from.
  rendererBuildStatus: (provenance) => ipcRenderer.invoke('liencam:renderer-build-status', provenance),
  machineBridgeStatus: () => ipcRenderer.invoke('liencam:machine-bridge-status'),
  machineBridgeReady: (settings) => ipcRenderer.send('liencam:machine-bridge-ready', settings),
  machineBridgeRemember: (settings) => ipcRenderer.send('liencam:machine-bridge-remember', settings),
  machineBridgeRestart: (settings) => settings === undefined
    ? ipcRenderer.invoke('liencam:machine-bridge-restart')
    : ipcRenderer.invoke('liencam:machine-bridge-restart', settings),
  chooseMachinePath: (kind) => ipcRenderer.invoke('liencam:choose-machine-path', kind),
  setJobWakeLock: (active) => ipcRenderer.send('liencam:set-job-wake-lock', active === true),
  saveFile: (filename, data) => ipcRenderer.invoke('liencam:save-file', filename, data),
}))

