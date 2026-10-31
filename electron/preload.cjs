'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('liencamHost', Object.freeze({
  platform: process.platform,
  ...(process.platform === 'linux' ? {
    controllerNetworkPorts: () => ipcRenderer.invoke('liencam:linux-controller-ports'),
    setupControllerNetwork: (input) => ipcRenderer.invoke('liencam:linux-controller-network', input),
    serialPermission: (port) => ipcRenderer.invoke('liencam:linux-serial-permission', port),
  } : {}),
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
  // WO-3290: the operator's press reaches main, which ends a fresh Linux
  // install's wait for the first Connect only on a press.
  machineBridgeRestart: (settings, options) => options?.operatorPress === true
    ? ipcRenderer.invoke('liencam:machine-bridge-restart', settings, { operatorPress: true })
    : settings === undefined
      ? ipcRenderer.invoke('liencam:machine-bridge-restart')
      : ipcRenderer.invoke('liencam:machine-bridge-restart', settings),
  chooseMachinePath: (kind) => ipcRenderer.invoke('liencam:choose-machine-path', kind),
  setJobWakeLock: (active) => ipcRenderer.send('liencam:set-job-wake-lock', active === true),
  saveFile: (filename, data) => ipcRenderer.invoke('liencam:save-file', filename, data),
  recentProjects: () => ipcRenderer.invoke('liencam:recent-projects'),
  openProjectFile: (path) => ipcRenderer.invoke('liencam:open-project-file', path),
  rememberProject: (project) => ipcRenderer.invoke('liencam:remember-project', project),
  removeRecentProject: (path) => ipcRenderer.invoke('liencam:remove-recent-project', path),
  openProjectLink: (url) => ipcRenderer.invoke('liencam:open-project-link', url),
  openIssueForm: (url) => ipcRenderer.invoke('liencam:open-issue-form', url),
  // WO-2883: the update route (electron/update/updater.cjs).
  update: Object.freeze({
    check: () => ipcRenderer.invoke('liencam:update-check'),
    download: (tag) => ipcRenderer.invoke('liencam:update-download', tag),
    install: () => ipcRenderer.invoke('liencam:update-install'),
    onProgress: (listener) => {
      const handler = (_event, progress) => listener(progress)
      ipcRenderer.on('liencam:update-progress', handler)
      return () => ipcRenderer.removeListener('liencam:update-progress', handler)
    },
  }),
  // WO-2911: a picture of this window for Report this problem; no arguments.
  captureApp: () => ipcRenderer.invoke('liencam:capture-app'),
  // WO-2995: the agent request channel. Main sends a request, the page runs it on
  // the model registry and answers by id. Only these two functions cross; the
  // renderer never sees the IPC event object.
  agent: Object.freeze({
    onRequest: (callback) => {
      if (typeof callback !== 'function') return () => {}
      const listener = (_event, request) => callback(request)
      ipcRenderer.on('liencam:agent-request', listener)
      return () => ipcRenderer.removeListener('liencam:agent-request', listener)
    },
    respond: (id, result) => ipcRenderer.invoke('liencam:agent-response', id, result),
  }),
  // WO-3010: the MCP server switch (Settings) and its state for the toolbar
  // indicator: { running, port, clientName }. The token never crosses.
  mcp: Object.freeze({
    getState: () => ipcRenderer.invoke('liencam:mcp-state'),
    setEnabled: (enabled) => ipcRenderer.invoke('liencam:mcp-set-enabled', enabled === true),
    onState: (callback) => {
      if (typeof callback !== 'function') return () => {}
      const listener = (_event, state) => callback(state)
      ipcRenderer.on('liencam:mcp-state-changed', listener)
      return () => ipcRenderer.removeListener('liencam:mcp-state-changed', listener)
    },
  }),
}))

