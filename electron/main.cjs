'use strict'

const { app, BrowserWindow, dialog, ipcMain, Menu, powerSaveBlocker, protocol, screen, shell } = require('electron')
const { execFile, spawn } = require('node:child_process')
const { createHash } = require('node:crypto')
const { accessSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } = require('node:fs')
const { appendFile, cp, mkdir, readFile, readdir, rename, rm, writeFile } = require('node:fs/promises')
const net = require('node:net')
const path = require('node:path')
const { net: electronNet } = require('electron')
const { createAgentChannel } = require('./agentChannel.cjs')
const { createMcpServer } = require('./mcp/server.cjs')

const APP_SCHEME = 'liencam'
const APP_HOST = 'app'
const PENDANT_PORT = 8324
const traceEnabled = process.env.LIENCAM_EVIDENCE_TRACE === '1'
const trace = (message) => { if (traceEnabled) console.error(`[LienCAM trace] ${message}`) }

// WO-3071 helper start
// Kept in main.cjs because the desktop package explicitly includes this file.
// No shell, sudo, packet capture or controller commands are involved.
function createLinuxControllerNetwork({ platform, run, stat, access, dialoutGid, username }) {
  const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'"
  const command = args => 'nmcli ' + args.map(quote).join(' ')
  const oneLine = error => String(error.message || error).replace(/[\r\n]+/g, ' ').trim()
  const supported = platform === 'linux'
  return {
    async ports() {
      if (!supported) return { ports: [] }
      try {
        const output = await run(['--terse', '--escape', 'no', '--fields', 'DEVICE,TYPE', 'device', 'status'])
        return { ports: output.trim().split('\n').filter(line => line.endsWith(':ethernet')).map(line => line.slice(0, -9)) }
      } catch (error) {
        return { ports: [], message: `NetworkManager could not list wired ports: ${oneLine(error)}; enter the wired port name below.` }
      }
    },
    async setup(input) {
      if (!supported) return { ok: false, message: 'Controller network setup is available on Linux.' }
      const port = input?.port
      const address = input?.address || '10.10.10.20/24'
      if (typeof port !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,14}$/.test(port)) {
        return { ok: false, message: 'Choose the wired port connected to the controller.' }
      }
      // This action configures the AXBB-E default subnet, not the desktop's
      // Internet route. .10 is permitted when the operator explicitly asks.
      if (typeof address !== 'string' || !/^10\.10\.10\.(\d{1,3})\/24$/.test(address)
        || Number(address.split('.')[3].split('/')[0]) < 1
        || Number(address.split('.')[3].split('/')[0]) > 254
        || Number(address.split('.')[3].split('/')[0]) === 11) {
        return { ok: false, message: 'Use a free host address from 10.10.10.1/24 to 10.10.10.254/24, other than the controller at 10.10.10.11.' }
      }
      const name = `liencam-controller-${port}`
      const properties = ['ipv4.method', 'manual', 'ipv4.addresses', address, 'ipv4.never-default', 'yes',
        'ipv6.method', 'disabled', 'connection.autoconnect', 'yes', 'connection.autoconnect-priority', '999']
      const show = ['--get-values', 'connection.uuid', 'connection', 'show', 'id', name]
      const add = ['connection', 'add', 'type', 'ethernet', 'ifname', port, 'con-name', name, ...properties]
      const modify = ['connection', 'modify', 'id', name, 'connection.interface-name', port, ...properties]
      const up = ['connection', 'up', 'id', name, 'ifname', port]
      const commands = `if ${command(show)} >/dev/null 2>&1; then\n  ${command(modify)}\nelse\n  ${command(add)}\nfi\n${command(up)}`
      try {
        let exists = true
        try { await run(show) } catch (error) {
          // nmcli 10 means this connection does not exist. A permission or
          // service failure must not be mistaken for permission to add one.
          if (error.code !== 10) throw error
          exists = false
        }
        await run(exists ? modify : add)
        await run(up)
        return { ok: true, message: `Set ${port} to ${address}; ${name} reconnects automatically after a cable or controller power drop.` }
      } catch (error) {
        return { ok: false, message: `NetworkManager could not finish controller setup: ${oneLine(error)}; run the commands below in a terminal (install NetworkManager if nmcli is missing; an administrator can use sudo nmcli if authorization is refused).`, commands }
      }
    },
    async serialPermission(port) {
      if (!supported || typeof port !== 'string' || !port.startsWith('/dev/')) return null
      try {
        const info = await stat(port)
        if (!info.isCharacterDevice()) return null
        try { await access(port); return null } catch (error) {
          if (error.code !== 'EACCES') return null
        }
        if (info.gid !== await dialoutGid()) return null
        return `This user cannot open ${port}; run sudo usermod -aG dialout ${quote(username())}, then log out and log in again.`
      } catch { return null }
    },
  }
}
// WO-3071 helper end

const linuxControllerNetwork = createLinuxControllerNetwork({
  platform: process.platform,
  run: args => new Promise((resolve, reject) => {
    execFile('nmcli', args, { timeout: 20000, windowsHide: true, env: { ...process.env, LC_ALL: 'C' } },
      (error, stdout, stderr) => error ? reject(Object.assign(error, { message: stderr?.trim() || error.message })) : resolve(stdout))
  }),
  stat: file => require('node:fs/promises').stat(file),
  access: file => require('node:fs/promises').access(file, require('node:fs').constants.R_OK | require('node:fs').constants.W_OK),
  dialoutGid: () => new Promise((resolve, reject) => {
    execFile('getent', ['group', 'dialout'], { timeout: 3000, windowsHide: true },
      (error, stdout) => error ? reject(error) : resolve(Number(stdout.split(':')[2])))
  }),
  username: () => require('node:os').userInfo().username,
})

// A rehearsal must select its profile before Chromium opens localStorage,
// IndexedDB or OPFS and before either machine-bridge path below is read. With
// no override this does nothing, preserving Electron's existing default.
const userDataOverride = process.env.LIENCAM_USER_DATA_DIR?.trim()
// WO-3290: whether this computer has run LienCAM before, read before anything
// of this run can create the user-data folder. Electron creates it on the first
// app.getPath('userData') and Chromium writes Crashpad into it before ready
// (measured, src/tests/evidence/WO-3290/). A folder that is already there is a
// computer that ran LienCAM before; only one that is not there is fresh.
const machineBridgeFreshInstallProbe = (() => {
  try {
    const folder = userDataOverride
      ? path.resolve(userDataOverride)
      : typeof app.name === 'string' && app.name ? path.join(app.getPath('appData'), app.name) : null
    return folder === null ? null : { folder, existed: existsSync(folder) }
  } catch {
    return null
  }
})()
if (userDataOverride) {
  const userDataPath = path.resolve(userDataOverride)
  mkdirSync(userDataPath, { recursive: true })
  app.setPath('userData', userDataPath)
}

protocol.registerSchemesAsPrivileged([{
  scheme: APP_SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true,
    stream: true,
    codeCache: true,
  },
}])

let mainWindow = null
// WO-2995: request channel to the page's model registry. Order D (the MCP server)
// is its caller; nothing listens on a port here.
const agentChannel = createAgentChannel({ ipcMain, getWindow: () => mainWindow })
// In-process handle only (no port, no IPC channel): Order D's server and the
// WO-2995 Playwright journey (app.evaluate) call it; the page cannot reach it.
app.agentRequest = agentChannel.request
// WO-3010: the MCP server (WO-2951 Order D). Off until the page's Settings switch
// turns it on; it answers only through agentChannel.request above.
let mcpServer = null
function mcpState() {
  return mcpServer === null ? Object.freeze({ running: false, port: null, clientName: null }) : mcpServer.state()
}
function reportMcpState(state) {
  if (mainWindow !== null && !mainWindow.isDestroyed()) mainWindow.webContents.send('liencam:mcp-state-changed', state)
}
function mcpServerInstance() {
  if (mcpServer === null) {
    mcpServer = createMcpServer({
      request: agentChannel.request,
      endpointDir: path.join(app.getPath('userData'), 'mcp'),
      version: app.getVersion(),
      onState: reportMcpState,
    })
  }
  return mcpServer
}
let pendantProcess = null
// WO-2883: the pendant an update stopped, so a failed install can start it again.
let pendantStoppedForUpdate = false
let machineBridgeProcess = null
let machineBridgeLastExit = null
let machineBridgeIntentionalProcess = null
let machineBridgeRestartProcess = null
let machineBridgeRespawnAttempts = 0
let machineBridgeRespawnGaveUp = false
let machineBridgeLastAttemptAt = null
let machineBridgeRespawnTimer = null
let machineBridgeStableTimer = null
let machineBridgeLaunchSettings = null
let machineBridgeBuiltExecutable = null
let machineBridgeBuildPromise = null
let machineBridgeWinePrefix = null
let machineBridgeLinuxNative = false
let machineBridgeMacNativeReady = false
let machineBridgeWineCleanup = null
let machineBridgeWineCleanupFailed = null
const machineBridgeWineRuns = new WeakMap()
let machineBridgeMissingInstallReportedFor = null
let machineBridgeFirmwareUpdate = null
// WO-2847 fix round 2: the firmware-update lines the bridge could not say to a
// live session, newest last. They belong to this app run, not to one child, so
// a failed startup update (the child exits 11 before it listens) and the
// operator's later Connect (which clears lastExit) do not lose them.
const machineBridgeConsoleLines = []
const machineBridgeConsoleRun = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
let machineBridgeConsoleSeq = 0
// WO-2847 fix round 3: the outcome event a child handed over last, so its
// exit 11 names the event that already carries the outcome (lastExit
// consoleLineId) and Connect does not say the outcome a second time.
let machineBridgeOutcomeEvent = null
// WO-1259: only the `missing` verdict is settled at launch (one existsSync).
// The real verdict needs the running bundle's own build provenance, so it is
// computed when the renderer asks for it - off the cold-start path entirely.
let rendererBuildStatus = Object.freeze({ state: 'unknown', message: null })
let machineBridgeSetup = {
  state: 'idle',
  installRoot: null,
  lookedFor: null,
  logPath: null,
  error: null,
}
let jobWakeLockId = null
// WO-2883: the update route needs the job state itself (the wake-lock id can stay null).
let jobRunning = false

const MACHINE_BRIDGE_DEFAULT_PORT = 8325
const MACHINE_BRIDGE_RESPAWN_DELAYS_MS = Object.freeze([1_000, 2_000, 4_000])
const MACHINE_BRIDGE_STABLE_MS = 60_000
const MACHINE_BRIDGE_STOP_TIMEOUT_MS = 5_000
const MACHINE_BRIDGE_HARD_STOP_TIMEOUT_MS = 1_000
const MACHINE_BRIDGE_SOCKET_INTERVAL_MS = 250
// WO-2847 (ADR-0058 V6): UC100.dll can start a controller firmware update by
// itself inside Open. The bridge waits it out the way UCCNC does and says so on
// these line prefixes (Machine.cs ControllerFirmwareUpdateWait). While one runs
// this process does not restart the bridge, and an update that ended in an
// error exits with this code, which is not respawned: a respawn calls Open
// again, the retry loop that interrupted updates before.
const MACHINE_BRIDGE_FIRMWARE_UPDATE_IN_PROGRESS = '[bridge] CONTROLLER FIRMWARE UPDATE IN PROGRESS'
const MACHINE_BRIDGE_FIRMWARE_UPDATE_FINISHED = '[bridge] CONTROLLER FIRMWARE UPDATE FINISHED'
const MACHINE_BRIDGE_FIRMWARE_UPDATE_ENDED = '[bridge] CONTROLLER FIRMWARE UPDATE ENDED'
const MACHINE_BRIDGE_FIRMWARE_UPDATE_ENDED_EXIT_CODE = 11
// WO-2845 (ADR-0058 D4): the bridge found a UC100.dll other than the one the
// board last connected with, said so in one line and did not open the board
// (Machine.cs DllPin). Not respawned; the operator's next Connect press starts
// it with the flag below, which opens with that DLL. A respawn never passes it.
const MACHINE_BRIDGE_DLL_CHANGED_EXIT_CODE = 12
const MACHINE_BRIDGE_CONNECT_WITH_CHANGED_DLL = '--connect-with-changed-dll'
const MACHINE_BRIDGE_DLL_PINS_FILE = 'liencam-bridge.dll-pins.json'
// Machine.cs ReportFirmwareUpdate: with LIENCAM_BRIDGE_HOST_CONSOLE=1 a line no
// session heard comes as `<prefix><severity> <text>`, for the Control console.
const MACHINE_BRIDGE_HOST_CONSOLE_PREFIX = '[bridge] FOR THE CONTROL CONSOLE '
const MACHINE_BRIDGE_CONSOLE_LINES_KEPT = 20
// The bridge may spend up to 10 seconds waiting for a released controller to
// enumerate before it opens the board, clears stale motion, reads every axis,
// applies the cached definition, opens the VFD, and finally starts listening.
// Keep real startup headroom beyond that bridge-owned wait ceiling.
const MACHINE_BRIDGE_SOCKET_DEADLINE_MS = 25_000
const MACHINE_BRIDGE_SETTINGS_FILE = 'machine-bridge-launch-settings.json'
const MACHINE_BRIDGE_BUILD_FILE = 'machine-bridge-build.json'
const MACHINE_BRIDGE_BUILD_LOG = 'machine-bridge-build.log'
const MACHINE_BRIDGE_EXECUTABLE = 'liencam-bridge.exe'
const MACHINE_BRIDGE_BOARDS_DIRECTORY = 'boards'
const MACHINE_BRIDGE_BUILD_SCHEMA = 3
const MACHINE_BRIDGE_SOURCE_FILES = Object.freeze(['Bridge.cs', 'Machine.cs', 'Json.cs', 'Vfd.cs'])
let machineBridgeSettingsWriteChain = Promise.resolve()

function normalizeMachineBridgeLaunchSettings(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const settings = {}
  for (const key of ['installRoot', 'profile', 'vfdDefinition']) {
    if (typeof value[key] === 'string') settings[key] = value[key]
  }
  if (value.board === 'auto' || Number.isInteger(value.board)) settings.board = value.board
  // WO-2628: the port the app dials is part of how this computer reaches the
  // machine. Without it a restored or changed Bridge port started the managed
  // connection on the default while Connect dialled the chosen one.
  if (Number.isInteger(value.bridgePort) && value.bridgePort >= 1 && value.bridgePort <= 65_535) {
    settings.bridgePort = value.bridgePort
  }
  return settings
}

function machineBridgeSettingsPath() {
  return typeof app.getPath === 'function'
    ? path.join(app.getPath('userData'), MACHINE_BRIDGE_SETTINGS_FILE)
    : null
}

function readMachineBridgeLaunchSettings() {
  const filePath = machineBridgeSettingsPath()
  if (filePath === null) return null
  try {
    return normalizeMachineBridgeLaunchSettings(JSON.parse(readFileSync(filePath, 'utf8')))
  } catch {
    return null
  }
}

function persistMachineBridgeLaunchSettings(settings) {
  const filePath = machineBridgeSettingsPath()
  if (filePath === null) return Promise.resolve()
  machineBridgeSettingsWriteChain = machineBridgeSettingsWriteChain
    .then(() => writeFile(filePath, JSON.stringify(settings), 'utf8'))
    .catch((error) => {
      console.warn('[LienCAM] Could not persist machine bridge launch settings:', error)
    })
  return machineBridgeSettingsWriteChain
}

// WO-3290 (alpha.3.1 finding 15): a fresh Linux install prepares the bridge at
// launch and starts it on the operator's first Connect, instead of running
// board discovery before he asks. Fresh comes only from the probe above (no
// user-data folder before this run); that launch leaves a record saying it is
// waiting, so a relaunch before the first Connect waits too, and the first
// Connect rewrites it. Saved launch settings play no part: boot hydration can
// null them on any computer. No folder-less launch and no waiting record means
// the bridge starts at launch, as it always has. Decided once per run.
const MACHINE_BRIDGE_FIRST_CONNECT_FILE = 'machine-bridge-first-connect.json'
let machineBridgeWaitsForConnect = null

function machineBridgeFirstConnectPath() {
  return typeof app.getPath === 'function'
    ? path.join(app.getPath('userData'), MACHINE_BRIDGE_FIRST_CONNECT_FILE)
    : null
}

function persistMachineBridgeFirstConnect(awaitingFirstConnect) {
  const filePath = machineBridgeFirstConnectPath()
  if (filePath === null) return Promise.resolve()
  machineBridgeSettingsWriteChain = machineBridgeSettingsWriteChain
    .then(() => writeFile(filePath, JSON.stringify({ awaitingFirstConnect }), 'utf8'))
    .catch((error) => {
      console.warn('[LienCAM] Could not record the first Connect:', error)
    })
  return machineBridgeSettingsWriteChain
}

function machineBridgeWaitingForConnect() {
  if (machineBridgeWaitsForConnect !== null) return machineBridgeWaitsForConnect
  machineBridgeWaitsForConnect = false
  if (process.platform !== 'linux') return false
  const filePath = machineBridgeFirstConnectPath()
  if (filePath === null) return false
  const probe = machineBridgeFreshInstallProbe
  if (probe !== null && !probe.existed && path.resolve(probe.folder) === path.resolve(path.dirname(filePath))) {
    machineBridgeWaitsForConnect = true
    void persistMachineBridgeFirstConnect(true)
    return true
  }
  try {
    machineBridgeWaitsForConnect = JSON.parse(readFileSync(filePath, 'utf8'))?.awaitingFirstConnect === true
  } catch {
    // No record: this computer was never a waiting fresh install.
  }
  return machineBridgeWaitsForConnect
}

/** The operator's press ends the wait for this run and every later launch. */
function recordMachineBridgeOperatorConnect() {
  if (!machineBridgeWaitingForConnect()) return
  machineBridgeWaitsForConnect = false
  void persistMachineBridgeFirstConnect(false)
}

// WO-3290 audit (astra 10-29): opening Control asks the host to start a
// stopped bridge (useMachineDefinitionPanel ensureBridgeForControl, no press).
// On a waiting fresh install that request is not a Connect: it starts nothing,
// records nothing, and is answered with the first Connect's own result.
let machineBridgeFirstConnectWaiters = []

function waitForMachineBridgeFirstConnect() {
  return new Promise((resolve) => { machineBridgeFirstConnectWaiters.push(resolve) })
}

function answerMachineBridgeFirstConnectWaiters(result) {
  const waiters = machineBridgeFirstConnectWaiters
  machineBridgeFirstConnectWaiters = []
  for (const resolve of waiters) resolve(result)
}

function holdJobWakeLock() {
  if (jobWakeLockId !== null && powerSaveBlocker.isStarted(jobWakeLockId)) return
  jobWakeLockId = null
  try {
    jobWakeLockId = powerSaveBlocker.start('prevent-app-suspension')
    console.info('LienCAM: keeping this PC awake while the job runs.')
  } catch (error) {
    console.warn('[LienCAM] Could not keep this PC awake while the job runs:', error)
  }
}

function releaseJobWakeLock() {
  if (jobWakeLockId === null) return
  const id = jobWakeLockId
  jobWakeLockId = null
  try {
    if (powerSaveBlocker.isStarted(id)) {
      powerSaveBlocker.stop(id)
      console.info('LienCAM: no longer keeping this PC awake; the job is not running.')
    }
  } catch (error) {
    console.warn('[LienCAM] Could not release the job wake lock:', error)
  }
}

// WHAT ACTUALLY FEEDS THE RENDERER BUILD (WO-1259).
//
// A git pathspec, not a JS filter: `:(exclude)src/tests` keeps the whole test
// tree out of git's own answer, so a docs-, evidence-, pendant- or profile-only
// afternoon produces no difference and therefore no warning. That criterion -
// never crying wolf - is what decides whether this check survives a week.
const RENDERER_BUILD_INPUTS = Object.freeze([
  'src',
  'public',
  'index.html',
  'package.json',
  'package-lock.json',
  'vite.config.mts',
  'tsconfig.json',
  'tsconfig.app.json',
  'tsconfig.node.json',
  ':(exclude)src/tests',
])

const UNVERIFIED_TAIL = 'Treat this build as unverified.'

function unverifiedRendererBuild(reason) {
  return Object.freeze({
    state: 'unknown',
    message: `LienCAM could not verify whether this build matches the source (${reason}). ${UNVERIFIED_TAIL}`,
  })
}

function appRoot() {
  return path.resolve(__dirname, '..', 'dist')
}

function rendererSourceRoot() {
  return path.resolve(__dirname, '..')
}

function runGit(root, args) {
  return new Promise((resolve) => {
    execFile('git', ['-C', root, ...args], {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
    }, (error, stdout) => {
      if (error) resolve({ ok: false, lines: [], detail: String(error.message ?? error).split(/\r?\n/, 1)[0] })
      else resolve({ ok: true, lines: String(stdout).split(/\r?\n/).filter(Boolean), detail: '' })
    })
  })
}

function rendererBuildFiles(root) {
  const files = []
  const visit = (relativePath) => {
    if (relativePath.replaceAll('\\', '/') === 'src/tests') return
    const absolutePath = path.join(root, relativePath)
    const stat = statSync(absolutePath)
    if (!stat.isDirectory()) {
      files.push(relativePath.replaceAll('\\', '/'))
      return
    }
    for (const name of readdirSync(absolutePath).sort()) visit(path.join(relativePath, name))
  }
  for (const input of RENDERER_BUILD_INPUTS.filter(input => !input.startsWith(':('))) visit(input)
  return files.sort()
}

function rendererBuildContentIdentity(root) {
  const hash = createHash('sha256')
  for (const relativePath of rendererBuildFiles(root)) {
    const bytes = readFileSync(path.join(root, relativePath))
    hash.update(`${relativePath.length}:${relativePath}:${bytes.length}:`)
    hash.update(bytes)
  }
  return `sha256-${hash.digest('hex')}`
}

/**
 * WO-1259: decide whether the RUNNING renderer bundle was built from the bytes
 * that are on disk now.
 *
 * `options.commit` is the build provenance the running bundle carries - Vite
 * bakes `__APP_GIT_COMMIT__` into the bundle at build time (vite.config.mts
 * `define`, surfaced as GIT_COMMIT in src/version.ts), so it is a property of
 * the artifact that is actually executing, not of a file sitting next to it.
 * The verdict is then a CONTENT comparison: `git diff <that commit> -- <inputs>`
 * asks git whether any renderer input's bytes differ from the bytes the build
 * recorded. No timestamp takes part in the verdict.
 *
 * Timestamps are unsound in both directions and this order carries the proof:
 * the machine seat reasoned that a 19:38 `dist` "must" contain a 19:01 fix
 * because it was newer, and it did not. A newer mtime says nothing about what
 * went INTO a build; the commit the build records does.
 *
 * Where the answer cannot be known - no provenance, a commit this checkout does
 * not have, uncommitted edits to renderer inputs that may or may not have been
 * compiled in, git unavailable - the verdict is `unknown`, never `current`.
 */
async function inspectRendererBuild(options = {}) {
  const root = options.root ?? rendererSourceRoot()
  const distIndex = options.distIndex ?? path.join(root, 'dist', 'index.html')
  const packaged = options.packaged ?? app.isPackaged
  if (!existsSync(distIndex)) {
    return Object.freeze({
      state: 'missing',
      message: 'LienCAM cannot start because the built app is missing. Run npm run build, then open LienCAM again.',
    })
  }

  // A packaged application is itself the build artifact. Its source tree is
  // deliberately absent, so there is no adjacent editable source to outrun it.
  if (packaged && !existsSync(path.join(root, 'src'))) {
    return Object.freeze({ state: 'current', message: null })
  }

  const provenance = typeof options.commit === 'string' ? options.commit.trim() : ''
  const identityMatch = provenance.match(/:((?:sha256-)[0-9a-f]{64})$/i)
  if (identityMatch) {
    try {
      const currentIdentity = rendererBuildContentIdentity(root)
      if (currentIdentity === identityMatch[1]) return Object.freeze({ state: 'current', message: null })
      return Object.freeze({
        state: 'stale',
        message: 'LienCAM is running a build made from different renderer source bytes; run npm run build when you want the latest code.',
      })
    } catch (error) {
      return unverifiedRendererBuild(`the current renderer source bytes could not be read: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // Legacy bundles carried only a commit. Keep their conservative git-backed
  // verdict until a new content-identified build replaces them.
  const commit = provenance
  if (commit === '' || commit === 'dev' || commit === 'unknown') {
    return unverifiedRendererBuild('this build does not record which source it was made from')
  }
  if (!/^[0-9a-f]{7,40}$/i.test(commit)) {
    return unverifiedRendererBuild('this build records an unreadable source revision')
  }

  const known = await runGit(root, ['cat-file', '-e', `${commit}^{commit}`])
  if (!known.ok) {
    return unverifiedRendererBuild(`the source revision this build was made from (${commit}) is not in this checkout`)
  }

  // Uncommitted or untracked renderer inputs cannot be attributed to a commit,
  // so nothing here can prove whether they were compiled in. Say so rather than
  // guess in either direction.
  const dirty = await runGit(root, ['status', '--porcelain', '--', ...RENDERER_BUILD_INPUTS])
  if (!dirty.ok) return unverifiedRendererBuild(dirty.detail || 'git is unavailable')
  if (dirty.lines.length > 0) {
    const first = dirty.lines[0].slice(3).trim()
    return unverifiedRendererBuild(
      `${dirty.lines.length} renderer file${dirty.lines.length === 1 ? '' : 's'} (${first}) `
      + 'have uncommitted changes, so LienCAM cannot tell whether they were built in',
    )
  }

  const changed = await runGit(root, ['diff', '--name-only', commit, '--', ...RENDERER_BUILD_INPUTS])
  if (!changed.ok) return unverifiedRendererBuild(changed.detail || 'git is unavailable')
  if (changed.lines.length > 0) {
    const count = changed.lines.length
    return Object.freeze({
      state: 'stale',
      message: `LienCAM is running an older build than the source. ${count} renderer file${count === 1 ? '' : 's'} `
        + `changed since this build was made (${changed.lines.slice(0, 3).join(', ')}`
        + `${count > 3 ? `, and ${count - 3} more` : ''}); run npm run build when you want the latest code.`,
    })
  }
  return Object.freeze({ state: 'current', message: null })
}

function reportRendererBuildStatus(status) {
  if (status.state === 'stale' || status.state === 'unknown') console.warn(`[LienCAM] ${status.message}`)
  if (status.state === 'missing') console.error(`[LienCAM] ${status.message}`)
}

function missingRendererHtml(message) {
  const safeMessage = String(message).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character])
  return `<!doctype html><html lang="en"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LienCAM build missing</title><body style="margin:0;background:#111827;color:#e5e7eb;font:16px system-ui;display:grid;place-items:center;min-height:100vh"><main style="max-width:42rem;padding:2rem"><h1 style="color:#f59e0b">LienCAM build missing</h1><p>${safeMessage}</p></main></body></html>`
}

function resourceRoot() {
  return app.isPackaged ? process.resourcesPath : path.resolve(__dirname, '..')
}

function responseHeaders(contentType) {
  return {
    'Content-Type': contentType,
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Cache-Control': 'no-cache',
  }
}

const MIME_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.wasm', 'application/wasm'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
])

function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: responseHeaders('application/json; charset=utf-8'),
  })
}

async function pendantHealthy() {
  try {
    const response = await fetch(`http://127.0.0.1:${PENDANT_PORT}/api/bridge/status`, {
      signal: AbortSignal.timeout(500),
    })
    if (!response.ok) return false
    const payload = await response.json()
    return payload.ok === true && payload.service === 'liencam-pendant-bridge'
  } catch {
    return false
  }
}

async function startPendant() {
  if (await pendantHealthy()) {
    return { brokerUrl: `ws://127.0.0.1:${PENDANT_PORT}/bridge`, port: PENDANT_PORT }
  }
  if (pendantProcess && pendantProcess.exitCode === null) {
    throw new Error('The pendant service is starting but is not ready yet.')
  }
  const serverPath = path.join(resourceRoot(), 'pendant', 'server.mjs')
  if (!existsSync(serverPath)) throw new Error(`The packaged pendant service is missing: ${serverPath}`)
  let stderr = ''
  const child = spawn(process.execPath, [serverPath, '--bridge', '--port', String(PENDANT_PORT)], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  pendantProcess = child
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-2000) })
  child.once('exit', () => { if (pendantProcess === child) pendantProcess = null })
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await pendantHealthy()) {
      return { brokerUrl: `ws://127.0.0.1:${PENDANT_PORT}/bridge`, port: PENDANT_PORT }
    }
    if (child.exitCode !== null) break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  stopChild(child)
  throw new Error(stderr.trim() || 'The pendant service did not become ready.')
}

function stopChild(child) {
  if (!child || child.exitCode !== null || child.killed) return
  child.kill()
}

function stopPendant() {
  const child = pendantProcess
  pendantProcess = null
  stopChild(child)
}

function machineBridgeDataDirectory() {
  return typeof app.getPath === 'function'
    ? path.join(app.getPath('userData'), 'machine-bridge')
    : null
}

function machineBridgeSourceDirectory() {
  return path.join(resourceRoot(), 'pendant', 'uccnc-bridge')
}

function machineBridgeWrapperPath(installRoot) {
  return path.join(installRoot, 'API', 'Interface', 'UC100_wrapper.cs')
}

function configuredMachineBridgeInstallRoot(settings) {
  return typeof settings?.installRoot === 'string' ? settings.installRoot.trim() : ''
}

// WO-3088: a search root that is set but empty searches nowhere. It used to
// fall back to C:\, so a rehearsal that pointed it at nothing found the
// operator's own UCCNC installs.
function machineBridgeSearchRoot() {
  const configured = process.env.LIENCAM_UCCNC_SEARCH_ROOT
  return configured === undefined ? 'C:\\' : configured.trim()
}

// WO-2894: route A uses the operator's existing prefix and DLL. Never discover
// another prefix or choose the newest install: that can change the DLL/firmware
// pairing (ADR-0058). The prebuilt bridge needs no developer wrapper sources.
function machineBridgeWineInstallPath(value, prefix) {
  if (/^[cC]:[\\/]/.test(value)) return path.join(prefix, 'drive_c', ...value.slice(3).split(/[\\/]/))
  if (/^[zZ]:[\\/]/.test(value)) return '/' + value.slice(3).replaceAll('\\', '/')
  return path.isAbsolute(value) ? value : null
}

function machineBridgeWineDllExists(root) {
  return ['API/DLL/UC100.dll', 'UC100.dll', 'DLL/UC100.dll']
    .some((relative) => existsSync(path.join(root, relative)))
}

async function findMachineBridgeInstall(settings) {
  if (process.platform === 'linux') {
    const prefix = process.env.WINEPREFIX?.trim()
    const configured = configuredMachineBridgeInstallRoot(settings)
    if (configured) {
      const root = machineBridgeWineInstallPath(configured, prefix)
      return { installRoot: root && machineBridgeWineDllExists(root) ? root : null, lookedFor: configured }
    }
    const searchRoot = path.join(prefix, 'drive_c')
    try {
      const candidates = (await readdir(searchRoot, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && /^UCCNC/i.test(entry.name))
        .map((entry) => path.join(searchRoot, entry.name))
        .filter(machineBridgeWineDllExists)
      return { installRoot: candidates.length === 1 ? candidates[0] : null,
        lookedFor: searchRoot, multiple: candidates.length > 1 }
    } catch {
      return { installRoot: null, lookedFor: searchRoot }
    }
  }
  const configured = configuredMachineBridgeInstallRoot(settings)
  if (configured) {
    return {
      installRoot: existsSync(machineBridgeWrapperPath(configured)) ? configured : null,
      lookedFor: machineBridgeWrapperPath(configured),
    }
  }

  const searchRoot = machineBridgeSearchRoot()
  if (searchRoot === '') return { installRoot: null, lookedFor: 'nowhere (LIENCAM_UCCNC_SEARCH_ROOT is set but empty)' }
  const lookedFor = path.join(searchRoot, 'UCCNC*')
  try {
    const candidates = (await readdir(searchRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && /^UCCNC/i.test(entry.name))
      .map((entry) => path.join(searchRoot, entry.name))
      .filter((candidate) => existsSync(machineBridgeWrapperPath(candidate)))
    return { ...pickMachineBridgeInstall(candidates, await machineBridgePinnedInstallRoots()), lookedFor }
  } catch {
    return { installRoot: null, lookedFor }
  }
}

// WO-2845 (ADR-0058 D4): NEVER THE NEWEST INSTALL. Another UCCNC install is
// another UC100.dll, which can update the controller's firmware inside Open.
// One install: that one. Several, none chosen: the one the board last
// connected with (the bridge's liencam-bridge.dll-pins.json), else none - the
// operator chooses on the Machine page, as the bridge's own "NOT guessing
// between them" rule says.
function pickMachineBridgeInstall(candidates, pinnedInstallRoots) {
  if (candidates.length <= 1) return { installRoot: candidates[0] ?? null }
  const key = (value) => path.resolve(value).toLowerCase()
  const pinned = new Set(pinnedInstallRoots.map(key))
  const recorded = candidates.filter((candidate) => pinned.has(key(candidate)))
  if (recorded.length === 1) return { installRoot: recorded[0] }
  return { installRoot: null, multiple: true, candidates: [...candidates] }
}

async function machineBridgePinnedInstallRoots() {
  const dataDirectory = machineBridgeDataDirectory()
  if (dataDirectory === null) return []
  try {
    const record = JSON.parse(await readFile(path.join(dataDirectory, MACHINE_BRIDGE_DLL_PINS_FILE), 'utf8'))
    if (record?.format !== 'liencam-dll-pins' || !Array.isArray(record.boards)) return []
    return record.boards
      .map((board) => (typeof board?.installRoot === 'string' ? board.installRoot.trim() : ''))
      .filter((root) => root !== '')
  } catch {
    return []
  }
}

function machineBridgeCompilerPath() {
  if (process.env.LIENCAM_CSC_EXECUTABLE) return process.env.LIENCAM_CSC_EXECUTABLE
  const windowsRoot = process.env.WINDIR || 'C:\\Windows'
  const candidates = [
    path.join(windowsRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.join(windowsRoot, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ]
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]
}

function machineBridgeHash(contents) {
  return createHash('sha256').update(contents).digest('hex')
}

async function machineBridgeFileIdentity(filePath, name = path.basename(filePath)) {
  const contents = await readFile(filePath)
  return {
    name,
    path: path.resolve(filePath),
    bytes: contents.byteLength,
    sha256: machineBridgeHash(contents),
  }
}

async function machineBridgeBoardFileIdentities(sourceDirectory) {
  const boardsDirectory = path.join(sourceDirectory, MACHINE_BRIDGE_BOARDS_DIRECTORY)
  let names
  try {
    names = (await readdir(boardsDirectory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && /\.json$/i.test(entry.name))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right))
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const identities = []
  for (const name of names) {
    identities.push(await machineBridgeFileIdentity(path.join(boardsDirectory, name), name))
  }
  return identities
}

async function machineBridgeBuildIdentity(sourceDirectory, wrapperPath, installRoot, compiler) {
  const sourceFiles = []
  for (const name of MACHINE_BRIDGE_SOURCE_FILES) {
    sourceFiles.push(await machineBridgeFileIdentity(path.join(sourceDirectory, name), name))
  }
  const wrapper = await machineBridgeFileIdentity(wrapperPath, path.basename(wrapperPath))
  const compilerIdentity = await machineBridgeFileIdentity(compiler, path.basename(compiler))
  const inputs = {
    installRoot: path.resolve(installRoot),
    sourceFiles,
    boardFiles: await machineBridgeBoardFileIdentities(sourceDirectory),
    wrapper,
    compiler: compilerIdentity,
    compilerArguments: ['/nologo', '/unsafe', '/platform:x64', '/target:winexe'],
  }
  const fingerprint = machineBridgeHash(JSON.stringify(inputs))
  return { fingerprint, inputs }
}

function machineBridgeOwnedBoardNames(manifest) {
  if (!Array.isArray(manifest?.inputs?.boardFiles)) return []
  return manifest.inputs.boardFiles
    .map((entry) => entry?.name)
    .filter((name) => typeof name === 'string'
      && path.basename(name) === name
      && /\.json$/i.test(name))
}

async function machineBridgeBoardFilesMatch(boardFiles, boardsDirectory) {
  for (const expected of boardFiles) {
    try {
      const actual = await machineBridgeFileIdentity(
        path.join(boardsDirectory, expected.name), expected.name,
      )
      if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) return false
    } catch {
      return false
    }
  }
  return true
}

async function stageMachineBridgeBoards({
  boardsDirectory, stagedBoardsDirectory, boardFiles, previousManifest,
}) {
  await rm(stagedBoardsDirectory, { recursive: true, force: true })
  if (existsSync(boardsDirectory)) {
    await cp(boardsDirectory, stagedBoardsDirectory, { recursive: true })
  } else {
    await mkdir(stagedBoardsDirectory, { recursive: true })
  }
  const currentNames = new Set(boardFiles.map((entry) => entry.name))
  for (const name of machineBridgeOwnedBoardNames(previousManifest)) {
    if (!currentNames.has(name)) {
      await rm(path.join(stagedBoardsDirectory, name), { recursive: true, force: true })
    }
  }
  for (const expected of boardFiles) {
    const destination = path.join(stagedBoardsDirectory, expected.name)
    await rm(destination, { recursive: true, force: true })
    const contents = await readFile(expected.path)
    if (contents.byteLength !== expected.bytes || machineBridgeHash(contents) !== expected.sha256) {
      throw new Error(`shipped board data changed while staging ${expected.name}`)
    }
    await writeFile(destination, contents)
  }
}

async function replaceMachineBridgeBoards(stagedBoardsDirectory, boardsDirectory) {
  const boardsBackup = `${boardsDirectory}.previous`
  const hadBoards = existsSync(boardsDirectory)
  let installedBoards = false
  await rm(boardsBackup, { recursive: true, force: true })
  try {
    if (hadBoards) await rename(boardsDirectory, boardsBackup)
    await rename(stagedBoardsDirectory, boardsDirectory)
    installedBoards = true
  } catch (error) {
    if (installedBoards) await rm(boardsDirectory, { recursive: true, force: true })
    if (hadBoards && existsSync(boardsBackup)) await rename(boardsBackup, boardsDirectory)
    throw error
  }
  await rm(boardsBackup, { recursive: true, force: true }).catch(() => {})
}

async function readMachineBridgeManifest(manifestPath) {
  try {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    return manifest !== null && typeof manifest === 'object' ? manifest : null
  } catch {
    return null
  }
}

async function writeMachineBridgeManifestAtomically(manifestPath, manifest) {
  const pending = `${manifestPath}.pending`
  const backup = `${manifestPath}.previous`
  const hadManifest = existsSync(manifestPath)
  let installed = false
  await rm(pending, { force: true })
  await rm(backup, { force: true })
  try {
    await writeFile(pending, JSON.stringify(manifest, null, 2), 'utf8')
    if (hadManifest) await rename(manifestPath, backup)
    await rename(pending, manifestPath)
    installed = true
  } catch (error) {
    if (installed) await rm(manifestPath, { force: true })
    if (hadManifest && existsSync(backup)) await rename(backup, manifestPath)
    await rm(pending, { force: true })
    throw error
  }
  await rm(backup, { force: true }).catch(() => {})
}

async function replaceMachineBridgeFiles({
  stagedExecutable, executablePath, stagedBoardsDirectory, boardsDirectory,
  manifestPath, manifest,
}) {
  const executableBackup = `${executablePath}.previous`
  const manifestBackup = `${manifestPath}.previous`
  const manifestPending = `${manifestPath}.pending`
  const boardsBackup = `${boardsDirectory}.previous`
  const hadExecutable = existsSync(executablePath)
  const hadManifest = existsSync(manifestPath)
  const hadBoards = existsSync(boardsDirectory)
  let installedExecutable = false
  let installedBoards = false
  let installedManifest = false

  await rm(executableBackup, { force: true })
  await rm(manifestBackup, { force: true })
  await rm(manifestPending, { force: true })
  await rm(boardsBackup, { recursive: true, force: true })
  try {
    await writeFile(manifestPending, JSON.stringify(manifest, null, 2), 'utf8')
    if (hadExecutable) await rename(executablePath, executableBackup)
    if (hadManifest) await rename(manifestPath, manifestBackup)
    if (hadBoards) await rename(boardsDirectory, boardsBackup)
    await rename(stagedExecutable, executablePath)
    installedExecutable = true
    await rename(stagedBoardsDirectory, boardsDirectory)
    installedBoards = true
    await rename(manifestPending, manifestPath)
    installedManifest = true
  } catch (error) {
    if (installedManifest) await rm(manifestPath, { force: true })
    if (installedBoards) await rm(boardsDirectory, { recursive: true, force: true })
    if (installedExecutable) await rm(executablePath, { force: true })
    if (hadExecutable && existsSync(executableBackup)) await rename(executableBackup, executablePath)
    if (hadManifest && existsSync(manifestBackup)) await rename(manifestBackup, manifestPath)
    if (hadBoards && existsSync(boardsBackup)) await rename(boardsBackup, boardsDirectory)
    await rm(manifestPending, { force: true })
    throw error
  }
  await rm(executableBackup, { force: true }).catch(() => {})
  await rm(manifestBackup, { force: true }).catch(() => {})
  await rm(boardsBackup, { recursive: true, force: true }).catch(() => {})
}

function machineBridgeArtifactMessage(kind, executablePath, logPath) {
  const observation = kind === 'missing'
    ? `The managed machine connection executable is missing at ${executablePath}.`
    : `The managed machine connection executable at ${executablePath} no longer matches its recorded build identity.`
  return `${observation} It was not rebuilt automatically because this unchanged build was previously created successfully. Use Build again or Reconnect for one deliberate recovery attempt. No antivirus cause was inferred. Build and launch log: ${logPath}`
}

async function recordMachineBridgeArtifactFailure(manifestPath, manifest, kind, executablePath, logPath) {
  const error = machineBridgeArtifactMessage(kind, executablePath, logPath)
  machineBridgeBuiltExecutable = null
  machineBridgeSetup = {
    state: 'failed', installRoot: manifest.installRoot ?? null, lookedFor: null,
    logPath, error,
  }
  try {
    await writeMachineBridgeManifestAtomically(manifestPath, {
      ...manifest,
      artifactState: kind,
      lastFailure: { kind, observedAt: new Date().toISOString(), executablePath },
    })
  } catch (writeError) {
    console.warn(`[LienCAM] Could not record the missing machine connection artifact: ${writeError instanceof Error ? writeError.message : String(writeError)}`)
  }
  console.error(`[LienCAM] ${error}`)
}

function runMachineBridgeCompiler(executable, args, workingDirectory) {
  return new Promise((resolve) => {
    let output = ''
    let settled = false
    let child
    try {
      child = spawn(executable, args, {
        cwd: workingDirectory,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolve({ code: null, error, output })
      return
    }
    const append = (chunk) => { output = `${output}${String(chunk)}` }
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)
    const finish = (code, error) => {
      if (settled) return
      settled = true
      resolve({ code, error, output })
    }
    child.once('error', (error) => finish(null, error))
    child.once('exit', (code) => finish(code, null))
  })
}

function firstMachineBridgeBuildError(output, error) {
  const lines = String(output).split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  return lines.find((line) => /\berror\s+CS\d+/i.test(line))
    ?? lines[0]
    ?? error?.message
    ?? 'the compiler exited without producing the bridge'
}

function configuredMachineBridgeExecutable(settings) {
  if (process.platform === 'linux' || process.platform === 'darwin') return null // prepare and validate platform routes first
  if (!process.env.LIENCAM_BRIDGE_EXECUTABLE) return null
  machineBridgeBuiltExecutable = process.env.LIENCAM_BRIDGE_EXECUTABLE
  machineBridgeSetup = {
    state: 'ready', installRoot: configuredMachineBridgeInstallRoot(settings) || null,
    lookedFor: null, logPath: null, error: null,
  }
  return settings ?? {}
}

function failMachineBridgeWine(error, lookedFor = null) {
  machineBridgeMacNativeReady = false
  machineBridgeBuiltExecutable = null
  machineBridgeWinePrefix = null
  machineBridgeLinuxNative = false
  machineBridgeSetup = { state: 'failed', installRoot: null, lookedFor, logPath: null, error }
  console.error(`[LienCAM] ${error}`)
  return null
}

async function prepareMachineBridgeWine(settings) {
  machineBridgeLinuxNative = false
  if (process.arch !== 'x64') return failMachineBridgeWine('The Wine UCCNC bridge requires x86-64 Linux; this route cannot run on ARM.')
  const prefix = process.env.WINEPREFIX?.trim()
  if (!prefix || !path.isAbsolute(prefix) || !existsSync(path.join(prefix, 'drive_c'))) {
    return failMachineBridgeWine('Set WINEPREFIX to an existing absolute path for the UCCNC Wine prefix.')
  }
  const source = process.env.LIENCAM_BRIDGE_EXECUTABLE
    || path.join(machineBridgeSourceDirectory(), 'bin', MACHINE_BRIDGE_EXECUTABLE)
  if (!existsSync(source)) return failMachineBridgeWine(`The prebuilt Wine bridge is missing at ${source}.`, source)
  const found = await findMachineBridgeInstall(settings)
  if (!found.installRoot) return failMachineBridgeWine(found.multiple
    ? 'Several UCCNC installs exist in the Wine prefix; choose the install folder on the Machine page.'
    : `UCCNC UC100.dll was not found at ${found.lookedFor}; choose its Linux install folder on the Machine page.`, found.lookedFor)
  try {
    let executable = source
    if (!process.env.LIENCAM_BRIDGE_EXECUTABLE) {
      const destination = machineBridgeDataDirectory()
      executable = path.join(destination, MACHINE_BRIDGE_EXECUTABLE)
      const bytes = await readFile(source)
      // An AppImage's resources are read-only. Bridge.cs copies the operator's
      // DLLs beside its exe and writes its runtime records there, so stage our
      // exe (and board tables) in app data, never in the mounted package.
      const unchanged = existsSync(executable) && bytes.equals(await readFile(executable))
      if (machineBridgeProcess && !unchanged && !await stopMachineBridge()) return null
      await mkdir(destination, { recursive: true })
      if (!unchanged) await writeFile(executable, bytes)
      const boards = path.join(machineBridgeSourceDirectory(), MACHINE_BRIDGE_BOARDS_DIRECTORY)
      if (existsSync(boards)) await cp(boards, path.join(destination, MACHINE_BRIDGE_BOARDS_DIRECTORY), { recursive: true })
    }
    machineBridgeBuiltExecutable = executable
    machineBridgeWinePrefix = prefix
    machineBridgeSetup = { state: 'ready', installRoot: found.installRoot, lookedFor: found.lookedFor, logPath: null, error: null }
    return { ...(settings ?? {}), installRoot: found.installRoot }
  } catch (error) {
    return failMachineBridgeWine(`The Wine bridge could not be prepared: ${error.message}`, source)
  }
}

function machineBridgeNativeSource() {
  const override = process.env.LIENCAM_BRIDGE_EXECUTABLE
  if (override) return /\.exe$/i.test(override) ? null : override
  // WO-3072: O61 passed; Wine is parked behind an explicit operator opt-in.
  if (process.env.LIENCAM_BRIDGE_WINE === '1') return null
  const executable = path.join(machineBridgeSourceDirectory(), 'native', `linux-${process.arch}`, 'liencam-bridge')
  return executable
}

async function machineBridgeNativeBundleMatches(source, destination) {
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name)
    const to = path.join(destination, entry.name)
    if (entry.isDirectory()) {
      if (!await machineBridgeNativeBundleMatches(from, to)) return false
    } else if (!existsSync(to) || !(await readFile(from)).equals(await readFile(to))) return false
  }
  return true
}

async function prepareMachineBridgeNative(settings, source, rid = `linux-${process.arch}`) {
  machineBridgeWinePrefix = null
  machineBridgeLinuxNative = false
  const installRoot = configuredMachineBridgeInstallRoot(settings)
  // Let Bridge.cs validate a selected .pro. A saved machine definition can
  // configure it without Profiles, even if an old installRoot is still saved.
  try {
    if (!existsSync(source)) throw new Error(`native executable is missing at ${source}`)
    let executable = source
    if (!process.env.LIENCAM_BRIDGE_EXECUTABLE) {
      // Separate runtime records from route A; it must never load a cached
      // vendor DLL, and the app's mounted resources cannot be written to.
      const nativeDirectory = path.join(path.dirname(machineBridgeDataDirectory()), 'machine-bridge-native', rid)
      executable = path.join(nativeDirectory, 'liencam-bridge')
      const unchanged = await machineBridgeNativeBundleMatches(path.dirname(source), nativeDirectory)
      if (!unchanged) {
        if (machineBridgeProcess && !await stopMachineBridge()) return null
        await mkdir(nativeDirectory, { recursive: true })
        await cp(path.dirname(source), nativeDirectory, { recursive: true })
      }
    }
    machineBridgeBuiltExecutable = executable
    machineBridgeLinuxNative = true
    machineBridgeSetup = { state: 'ready', installRoot: installRoot || null, lookedFor: source, logPath: null, error: null }
    return settings ?? {}
  } catch (error) {
    return failMachineBridgeWine(`The native bridge could not be prepared: ${error.message}`, source)
  }
}

// WO-2897: Mac has one native route; a missing/unsupported bundle must not
// reach the generic executable shortcut, Windows compiler, Wine or demo.
async function prepareMachineBridgeMac(settings) {
  machineBridgeMacNativeReady = false
  const label = 'macOS AXBB-E bridge (alpha, untested on macOS)'
  if (process.arch !== 'arm64') return failMachineBridgeWine(`${label} is unsupported on Intel Macs; requires Apple Silicon.`)
  const source = process.env.LIENCAM_BRIDGE_EXECUTABLE
    || path.join(machineBridgeSourceDirectory(), 'native', 'osx-arm64', 'liencam-bridge')
  if (/\.exe$/i.test(source)) return failMachineBridgeWine(`${label} requires a native osx-arm64 executable; Windows executables are unsupported.`, source)
  for (const name of ['liencam-bridge.dll', 'liencam-bridge.deps.json', 'liencam-bridge.runtimeconfig.json', 'libcoreclr.dylib', 'libhostfxr.dylib', 'libhostpolicy.dylib', MACHINE_BRIDGE_BOARDS_DIRECTORY]) {
    if (!existsSync(path.join(path.dirname(source), name))) return failMachineBridgeWine(`${label} runtime is missing ${name}.`, source)
  }
  const prepared = await prepareMachineBridgeNative(settings, source, 'osx-arm64')
  machineBridgeMacNativeReady = prepared !== null
  if (prepared !== null) console.log(`[LienCAM] ${label}`)
  return prepared
}

async function buildMachineBridge(settings, { recoverArtifact = false } = {}) {
  if (process.platform === 'darwin') return prepareMachineBridgeMac(settings)
  if (process.platform === 'linux') {
    const native = machineBridgeNativeSource()
    return native ? prepareMachineBridgeNative(settings, native) : prepareMachineBridgeWine(settings)
  }
  const configuredExecutable = configuredMachineBridgeExecutable(settings)
  if (configuredExecutable !== null) return configuredExecutable
  if (process.platform !== 'win32') return null

  const found = await findMachineBridgeInstall(settings)
  if (found.installRoot === null && found.multiple) {
    // WO-2845: several installs, none chosen and none on record for the board.
    machineBridgeBuiltExecutable = null
    const error = `Several UCCNC installs were found (${found.candidates.join(', ')}) and none is chosen. `
      + 'LienCAM does not pick one for you, because a different UCCNC can update the controller\'s firmware. '
      + 'Choose the UCCNC install folder on the Machine page.'
    machineBridgeSetup = { state: 'failed', installRoot: null, lookedFor: found.lookedFor, logPath: null, error }
    if (machineBridgeMissingInstallReportedFor !== error) {
      machineBridgeMissingInstallReportedFor = error
      console.warn(`[LienCAM] ${error}`)
    }
    return null
  }
  if (found.installRoot === null) {
    machineBridgeBuiltExecutable = null
    machineBridgeSetup = {
      state: 'missing-install', installRoot: null, lookedFor: found.lookedFor,
      logPath: null, error: null,
    }
    if (machineBridgeMissingInstallReportedFor !== found.lookedFor) {
      machineBridgeMissingInstallReportedFor = found.lookedFor
      console.warn(`[LienCAM] UCCNC was not found. Looked for ${found.lookedFor}. Choose its install folder on the Machine page.`)
    }
    return null
  }

  machineBridgeMissingInstallReportedFor = null
  const installRoot = found.installRoot
  const effectiveSettings = { ...(settings ?? {}), installRoot }
  const destinationDirectory = machineBridgeDataDirectory()
  if (destinationDirectory === null) return null
  const sourceDirectory = machineBridgeSourceDirectory()
  const wrapperPath = machineBridgeWrapperPath(installRoot)
  const manifestPath = path.join(destinationDirectory, MACHINE_BRIDGE_BUILD_FILE)
  const logPath = path.join(destinationDirectory, MACHINE_BRIDGE_BUILD_LOG)
  const executablePath = path.join(destinationDirectory, MACHINE_BRIDGE_EXECUTABLE)
  const stagedExecutable = path.join(destinationDirectory, `liencam-bridge.pending-${process.pid}.exe`)
  const boardsDirectory = path.join(destinationDirectory, MACHINE_BRIDGE_BOARDS_DIRECTORY)
  const stagedBoardsDirectory = path.join(destinationDirectory, `boards.pending-${process.pid}`)
  machineBridgeSetup = {
    state: 'building', installRoot, lookedFor: found.lookedFor, logPath, error: null,
  }

  try {
    await mkdir(destinationDirectory, { recursive: true })
    const compiler = machineBridgeCompilerPath()
    const identity = await machineBridgeBuildIdentity(
      sourceDirectory, wrapperPath, installRoot, compiler,
    )
    const manifest = await readMachineBridgeManifest(manifestPath)
    const matchingManifest = manifest?.schemaVersion === MACHINE_BRIDGE_BUILD_SCHEMA
      && manifest.fingerprint === identity.fingerprint
      && manifest.executable === MACHINE_BRIDGE_EXECUTABLE
    if (matchingManifest) {
      if (!existsSync(executablePath)) {
        if (!recoverArtifact) {
          await recordMachineBridgeArtifactFailure(
            manifestPath, manifest, 'missing', executablePath, logPath,
          )
          return null
        }
      } else {
        const executableIdentity = await machineBridgeFileIdentity(
          executablePath, MACHINE_BRIDGE_EXECUTABLE,
        )
        if (executableIdentity.sha256 === manifest.executableIdentity?.sha256) {
          if (!await machineBridgeBoardFilesMatch(identity.inputs.boardFiles, boardsDirectory)) {
            await stageMachineBridgeBoards({
              boardsDirectory, stagedBoardsDirectory,
              boardFiles: identity.inputs.boardFiles,
              previousManifest: manifest,
            })
            await replaceMachineBridgeBoards(stagedBoardsDirectory, boardsDirectory)
          }
          machineBridgeBuiltExecutable = executablePath
          machineBridgeSetup = {
            state: 'ready', installRoot, lookedFor: found.lookedFor, logPath, error: null,
          }
          return effectiveSettings
        }
        if (!recoverArtifact) {
          await recordMachineBridgeArtifactFailure(
            manifestPath, manifest, 'identity-mismatch', executablePath, logPath,
          )
          return null
        }
      }
    }

    await rm(stagedExecutable, { force: true })
    const args = [
      '/nologo', '/unsafe', '/platform:x64', '/target:winexe',
      `/out:${stagedExecutable}`,
      ...MACHINE_BRIDGE_SOURCE_FILES.map((name) => path.join(sourceDirectory, name)),
      wrapperPath,
    ]
    const result = await runMachineBridgeCompiler(compiler, args, destinationDirectory)
    const outputPresent = existsSync(stagedExecutable)
    const executableIdentity = outputPresent
      ? await machineBridgeFileIdentity(stagedExecutable, MACHINE_BRIDGE_EXECUTABLE)
      : null
    await stageMachineBridgeBoards({
      boardsDirectory, stagedBoardsDirectory,
      boardFiles: identity.inputs.boardFiles,
      previousManifest: manifest,
    })
    await writeFile(logPath, [
      `schema: ${MACHINE_BRIDGE_BUILD_SCHEMA}`,
      `fingerprint: ${identity.fingerprint}`,
      `compiler: ${compiler}`,
      `compiler sha256: ${identity.inputs.compiler.sha256}`,
      `wrapper: ${wrapperPath}`,
      `wrapper sha256: ${identity.inputs.wrapper.sha256}`,
      ...identity.inputs.sourceFiles.map((source) => `${source.name} sha256: ${source.sha256}`),
      ...identity.inputs.boardFiles.map((board) => `boards/${board.name} sha256: ${board.sha256}`),
      `install root: ${installRoot}`,
      `staged output: ${stagedExecutable}`,
      `managed output: ${executablePath}`,
      `output sha256: ${executableIdentity?.sha256 ?? 'missing'}`,
      '',
      result.output,
      result.error ? String(result.error.stack || result.error.message || result.error) : '',
    ].join('\r\n'), 'utf8')
    if (result.code !== 0 || result.error !== null || !outputPresent) {
      throw new Error(firstMachineBridgeBuildError(result.output, result.error))
    }

    if (machineBridgeProcess && machineBridgeProcess.exitCode === null) {
      trace('managed bridge replacement is stopping the running managed process')
      if (!await stopMachineBridge()) {
        throw new Error('the running machine connection could not be stopped for safe replacement')
      }
    }
    await replaceMachineBridgeFiles({
      stagedExecutable,
      executablePath,
      stagedBoardsDirectory,
      boardsDirectory,
      manifestPath,
      manifest: {
        schemaVersion: MACHINE_BRIDGE_BUILD_SCHEMA,
        fingerprint: identity.fingerprint,
        executable: MACHINE_BRIDGE_EXECUTABLE,
        executableIdentity,
        installRoot,
        inputs: identity.inputs,
        artifactState: 'ready',
        builtAt: new Date().toISOString(),
      },
    })
    machineBridgeBuiltExecutable = executablePath
    machineBridgeSetup = {
      state: 'ready', installRoot, lookedFor: found.lookedFor, logPath, error: null,
    }
    trace(`managed bridge build ready at ${executablePath} (${identity.fingerprint})`)
    return effectiveSettings
  } catch (error) {
    await rm(stagedExecutable, { force: true }).catch(() => {})
    await rm(stagedBoardsDirectory, { recursive: true, force: true }).catch(() => {})
    const message = error instanceof Error ? error.message : String(error)
    machineBridgeBuiltExecutable = null
    machineBridgeSetup = {
      state: 'failed', installRoot, lookedFor: found.lookedFor, logPath, error: message,
    }
    console.error(`[LienCAM] Machine connection build failed: ${message}. Full log: ${logPath}`)
    return null
  }
}

async function ensureMachineBridge(settings, options) {
  if (machineBridgeBuildPromise !== null) await machineBridgeBuildPromise
  machineBridgeBuildPromise = buildMachineBridge(settings, options)
  try {
    return await machineBridgeBuildPromise
  } finally {
    machineBridgeBuildPromise = null
  }
}

function machineBridgeSpec(settings = machineBridgeLaunchSettings) {
  const executable = process.env.LIENCAM_BRIDGE_EXECUTABLE || machineBridgeBuiltExecutable
  if (!executable || (process.platform === 'linux' && !machineBridgeWinePrefix && !machineBridgeLinuxNative)) return null
  if (process.platform === 'darwin' && !machineBridgeMacNativeReady) return null
  // 2026-09-03: this defaulted to NO arguments, and that made the operator's machine
  // unusable. With no `--board`, Bridge.cs falls back to
  // liencam-bridge.config.json, whose board default is the DEMO board (-19).
  // The demo controller accepts every call and simulates the reply, so Connect
  // succeeded, Home "completed" for Z, X and Y in milliseconds, the UI flashed
  // the whole cycle green - and nothing was on the other end. His desktop
  // shortcut sets LIENCAM_BRIDGE_EXECUTABLE but not the args, so the one path
  // he actually uses got the stale demo config.
  //
  // `auto` asks Bridge.cs to discover the real controller (Bridge.cs:912), and
  // when it finds none it logs and EXITS(2) rather than starting (:996). A
  // bridge that refuses to start is visible on the Machine page; a simulator
  // wearing the machine's face is not. LIENCAM_BRIDGE_ARGS_JSON still wins
  // outright, so the demo board stays reachable - but only on purpose.
  const stringSetting = (key) => typeof settings?.[key] === 'string' ? settings[key].trim() : ''
  const installRoot = stringSetting('installRoot')
  const profile = stringSetting('profile')
  const vfdDefinition = stringSetting('vfdDefinition')
  const board = settings?.board === 'auto' || Number.isInteger(settings?.board)
    ? String(settings.board)
    : 'auto'
  const bridgePort = normalizeMachineBridgeLaunchSettings(settings)?.bridgePort
  let args = [
    ...(installRoot ? ['--install-root', installRoot] : []),
    ...(profile ? ['--profile', profile] : []),
    '--board', board,
    ...(vfdDefinition ? ['--vfd', vfdDefinition] : []),
    ...(bridgePort === undefined ? [] : ['--port', String(bridgePort)]),
  ]
  if (process.env.LIENCAM_BRIDGE_ARGS_JSON) {
    const parsed = JSON.parse(process.env.LIENCAM_BRIDGE_ARGS_JSON)
    if (!Array.isArray(parsed) || !parsed.every((arg) => typeof arg === 'string')) {
      throw new Error('LIENCAM_BRIDGE_ARGS_JSON must be a JSON array of strings.')
    }
    args = parsed
  }
  if (process.platform === 'linux' && machineBridgeWinePrefix) {
    // Keep relative profile names and explicit Wine drive paths intact. This
    // also covers path-valued developer overrides without shell quoting.
    for (let index = 0; index < args.length - 1; index += 1) {
      if (['--install-root', '--profile', '--vfd'].includes(args[index]) && args[index + 1].startsWith('/')) {
        args[index + 1] = 'Z:' + args[index + 1].replaceAll('/', '\\')
      }
    }
    return { executable, args, winePrefix: machineBridgeWinePrefix }
  }
  return { executable, args }
}

function sameMachineBridgeSpec(left, right) {
  return left?.executable === right?.executable
    && left?.winePrefix === right?.winePrefix
    && JSON.stringify(left?.args ?? null) === JSON.stringify(right?.args ?? null)
}

function machineBridgePort(spec) {
  const portAt = spec.args.indexOf('--port')
  if (portAt === -1) return MACHINE_BRIDGE_DEFAULT_PORT
  const parsed = Number(spec.args[portAt + 1])
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65_535
    ? parsed
    : MACHINE_BRIDGE_DEFAULT_PORT
}

/** Pure policy seam: attempts counts respawns already made for this crash run. */
function machineBridgeRespawnDecision(attempts) {
  if (attempts >= MACHINE_BRIDGE_RESPAWN_DELAYS_MS.length) {
    return { respawn: false, delayMs: null, gaveUp: true }
  }
  return {
    respawn: true,
    delayMs: MACHINE_BRIDGE_RESPAWN_DELAYS_MS[attempts],
    gaveUp: false,
  }
}

function clearMachineBridgeRespawnTimer() {
  if (machineBridgeRespawnTimer === null) return
  clearTimeout(machineBridgeRespawnTimer)
  machineBridgeRespawnTimer = null
}

function clearMachineBridgeStableTimer() {
  if (machineBridgeStableTimer === null) return
  clearTimeout(machineBridgeStableTimer)
  machineBridgeStableTimer = null
}

function armMachineBridgeStabilityReset(child) {
  clearMachineBridgeStableTimer()
  machineBridgeStableTimer = setTimeout(() => {
    machineBridgeStableTimer = null
    if (machineBridgeProcess !== child || child.exitCode !== null) return
    machineBridgeRespawnAttempts = 0
    machineBridgeRespawnGaveUp = false
  }, MACHINE_BRIDGE_STABLE_MS)
}

function scheduleMachineBridgeRespawn() {
  clearMachineBridgeRespawnTimer()
  const decision = machineBridgeRespawnDecision(machineBridgeRespawnAttempts)
  if (!decision.respawn) {
    machineBridgeRespawnGaveUp = true
    return
  }
  machineBridgeRespawnGaveUp = false
  machineBridgeRespawnTimer = setTimeout(() => {
    machineBridgeRespawnTimer = null
    if (machineBridgeProcess && machineBridgeProcess.exitCode === null) return
    machineBridgeRespawnAttempts += 1
    machineBridgeLastAttemptAt = Date.now()
    if (startMachineBridge() === null && !machineBridgeRespawnGaveUp) scheduleMachineBridgeRespawn()
  }, decision.delayMs)
}

function settleMachineBridgeExit(child, lastExit, allowRespawn = true) {
  const wasCurrent = machineBridgeProcess === child
  const wasIntentional = machineBridgeIntentionalProcess === child
  const wasRestartStart = machineBridgeRestartProcess === child
  if (wasCurrent) machineBridgeProcess = null
  if (wasIntentional) machineBridgeIntentionalProcess = null
  if (machineBridgeFirmwareUpdate?.child === child) machineBridgeFirmwareUpdate = null
  clearMachineBridgeStableTimer()
  const saidThenExited = lastExit?.code === MACHINE_BRIDGE_FIRMWARE_UPDATE_ENDED_EXIT_CODE
    || lastExit?.code === MACHINE_BRIDGE_DLL_CHANGED_EXIT_CODE
  // Only a firmware update's outcome is linked: bridgeHost.ts then points at
  // "the firmware update line above". WO-2845's press quotes the bridge's own
  // last line instead (Machine.cs DllPin.HostedExitLine).
  if (lastExit?.code === MACHINE_BRIDGE_FIRMWARE_UPDATE_ENDED_EXIT_CODE && machineBridgeOutcomeEvent?.child === child) {
    lastExit = { ...lastExit, consoleLineId: machineBridgeOutcomeEvent.id }
  }
  machineBridgeLastExit = lastExit
  if (wasIntentional || wasRestartStart || !wasCurrent || !allowRespawn) return
  if (saidThenExited) {
    // WO-2847: the bridge has said in one line how the update ended. WO-2845:
    // or that the DLL changed. The operator's Connect starts it again; this
    // process does not.
    clearMachineBridgeRespawnTimer()
    machineBridgeRespawnGaveUp = true
    return
  }
  scheduleMachineBridgeRespawn()
}

/** WO-2847: true while the running bridge is waiting out a firmware update. */
function machineBridgeUpdatingFirmware() {
  const update = machineBridgeFirmwareUpdate
  return update !== null
    && machineBridgeProcess === update.child
    && update.child.exitCode === null
}

function watchMachineBridgeFirmwareUpdate(child) {
  const stream = child.stdout
  if (!stream || typeof stream.on !== 'function') return
  let pending = ''
  stream.on('data', (chunk) => {
    pending += String(chunk)
    const lines = pending.split(/\r?\n/)
    pending = lines.pop() ?? ''
    for (const raw of lines) {
      const line = raw.trim()
      if (line.startsWith(MACHINE_BRIDGE_HOST_CONSOLE_PREFIX)) {
        const rest = line.slice(MACHINE_BRIDGE_HOST_CONSOLE_PREFIX.length)
        const space = rest.indexOf(' ')
        const severity = rest.slice(0, space)
        const text = rest.slice(space + 1)
        if (space < 1 || !['info', 'warn', 'error'].includes(severity)) continue
        const id = `${machineBridgeConsoleRun}-${++machineBridgeConsoleSeq}`
        const progress = text.startsWith(MACHINE_BRIDGE_FIRMWARE_UPDATE_IN_PROGRESS)
        machineBridgeConsoleLines.push({ id, severity, text, progress })
        if (machineBridgeConsoleLines.length > MACHINE_BRIDGE_CONSOLE_LINES_KEPT) machineBridgeConsoleLines.shift()
        // Its human copy follows on the next line and is then skipped below.
        if (progress) machineBridgeFirmwareUpdate = { child, since: Date.now(), line: text, eventId: id }
        else machineBridgeOutcomeEvent = { child, id }
        continue
      }
      if (line.startsWith(MACHINE_BRIDGE_FIRMWARE_UPDATE_IN_PROGRESS)) {
        if (machineBridgeFirmwareUpdate?.child === child) continue
        machineBridgeFirmwareUpdate = { child, since: Date.now(), line, eventId: null }
        console.warn(`[LienCAM] ${line}`)
      } else if (line.startsWith(MACHINE_BRIDGE_FIRMWARE_UPDATE_FINISHED)
          || line.startsWith(MACHINE_BRIDGE_FIRMWARE_UPDATE_ENDED)) {
        if (machineBridgeFirmwareUpdate?.child === child) machineBridgeFirmwareUpdate = null
        console.warn(`[LienCAM] ${line}`)
      }
    }
  })
}

function markMachineBridgeLaunchArtifactMissing(executable, route) {
  const managed = !process.env.LIENCAM_BRIDGE_EXECUTABLE
  const dataDirectory = managed ? machineBridgeDataDirectory() : null
  const logPath = dataDirectory === null ? null : path.join(dataDirectory, MACHINE_BRIDGE_BUILD_LOG)
  const error = managed
    ? machineBridgeArtifactMessage('missing', executable, logPath)
    : `The configured machine connection executable is missing at ${executable}. Check LIENCAM_BRIDGE_EXECUTABLE; the app did not replace it or infer why it is absent.`
  if (managed) machineBridgeBuiltExecutable = null
  machineBridgeRespawnGaveUp = true
  machineBridgeSetup = {
    state: 'failed', installRoot: machineBridgeSetup.installRoot,
    lookedFor: machineBridgeSetup.lookedFor, logPath, error,
  }
  machineBridgeLastExit = { code: null, signal: null, error }
  trace(`machine bridge ${route} observed a missing executable: ${executable}`)
  console.error(`[LienCAM] ${error}`)
  if (logPath === null) return
  void appendFile(logPath, [
    '',
    `artifact observation: ${new Date().toISOString()}`,
    `route: ${route}`,
    `missing executable: ${executable}`,
    'cause: not inferred',
  ].join('\r\n'), 'utf8').catch((writeError) => {
    console.warn(`[LienCAM] Could not append the missing machine connection observation: ${writeError instanceof Error ? writeError.message : String(writeError)}`)
  })
}

function captureMachineBridgeLastLine(child) {
  let lastLine = null
  const attach = (stream) => {
    if (!stream || typeof stream.on !== 'function') return
    let pending = ''
    stream.on('data', (chunk) => {
      pending += String(chunk)
      const lines = pending.split(/\r?\n/)
      pending = lines.pop() ?? ''
      for (const line of lines) {
        if (line.trim()) lastLine = line.trim()
      }
    })
    child.once('exit', () => {
      if (pending.trim()) lastLine = pending.trim()
    })
  }
  attach(child.stdout)
  attach(child.stderr)
  return () => lastLine
}

// Cleanup is tied to the child's original prefix, never mutable settings. A
// replacement must wait for both the kill request and wineserver's exit; -k
// alone can return before the server releases the board and socket.
function cleanupMachineBridgeWine(child) {
  const run = machineBridgeWineRuns.get(child)
  if (!run) return Promise.resolve(true)
  if (run.cleanup) return run.cleanup
  const command = (args) => new Promise((resolve, reject) => {
    execFile('wineserver', args, { env: run.env, timeout: 5_000, windowsHide: true },
      (error) => error ? reject(error) : resolve())
  })
  run.cleanup = command(['-k']).then(() => command(['-w'])).then(() => true).catch((error) => {
    machineBridgeWineCleanupFailed = child
    machineBridgeRespawnGaveUp = true
    machineBridgeSetup = { ...machineBridgeSetup, state: 'failed', error: `Wine prefix cleanup failed: ${error.message}` }
    console.error(`[LienCAM] ${machineBridgeSetup.error}`)
    return false
  }).finally(() => { machineBridgeWineCleanup = null })
  machineBridgeWineCleanup = run.cleanup
  return run.cleanup
}

// WO-3065: Fedora's unbundled wine-mono needs iconv.dll, which `mingw64-win-iconv`
// installs here and Wine does not search. Wine route only: the native route and
// Windows/macOS never see this.
const MACHINE_BRIDGE_MINGW_BIN = '/usr/x86_64-w64-mingw32/sys-root/mingw/bin'

function machineBridgeMingwBinExists() {
  try { accessSync(MACHINE_BRIDGE_MINGW_BIN); return true } catch { return false }
}

function machineBridgeWineEnv(prefix) {
  const env = { ...process.env, LIENCAM_BRIDGE_HOST_CONSOLE: '1', WINEPREFIX: prefix }
  if (process.platform !== 'linux' || !machineBridgeMingwBinExists()) return env
  const folder = 'Z:' + MACHINE_BRIDGE_MINGW_BIN.replaceAll('/', '\\')
  const current = typeof env.WINEPATH === 'string' ? env.WINEPATH : ''
  const normalize = (entry) => entry.trim().replace(/\\+$/, '').toLowerCase()
  if (current.split(';').some((entry) => normalize(entry) === normalize(folder))) return env
  env.WINEPATH = current.trim() ? `${current.replace(/;+$/, '')};${folder}` : folder
  return env
}

// The bridge's last line when Mono cannot load names the missing package.
function machineBridgeWineExitLine(line) {
  if (process.platform !== 'linux' || !line || !/iconv\.dll|Could not load Mono/i.test(line)) return line
  if (machineBridgeMingwBinExists()) return line
  return `${line} On Fedora, install the mingw64-win-iconv package.`
}

function startMachineBridge(specOverride = null) {
  if (process.platform === 'linux' && (machineBridgeWineCleanup || machineBridgeWineCleanupFailed)) return null
  if (machineBridgeProcess && machineBridgeProcess.exitCode === null) return machineBridgeProcess
  const spec = specOverride ?? machineBridgeSpec()
  if (!spec) return null
  const managedExecutable = !process.env.LIENCAM_BRIDGE_EXECUTABLE
  if (managedExecutable && !existsSync(spec.executable)) {
    markMachineBridgeLaunchArtifactMissing(spec.executable, 'before spawn')
    return null
  }
  machineBridgeLastExit = null
  let child
  try {
    child = spawn(spec.winePrefix ? 'wine' : spec.executable, spec.winePrefix ? [spec.executable, ...spec.args] : spec.args, {
      // WO-2847: this process carries the bridge's unsaid firmware-update
      // lines to the Control console (machineBridgeStatus consoleLines).
      env: spec.winePrefix
        ? machineBridgeWineEnv(spec.winePrefix)
        : { ...process.env, LIENCAM_BRIDGE_HOST_CONSOLE: '1' },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    machineBridgeLastExit = { code: null, signal: null, error: message }
    machineBridgeSetup = {
      ...machineBridgeSetup,
      state: 'failed',
      error: `The machine connection could not launch: ${message}`,
    }
    console.error(`[LienCAM] Machine connection launch failed: ${message}`)
    return null
  }
  if (spec.winePrefix) machineBridgeWineRuns.set(child, { env: { ...process.env, WINEPREFIX: spec.winePrefix }, cleanup: null })
  const machineBridgeLastLine = captureMachineBridgeLastLine(child)
  watchMachineBridgeFirmwareUpdate(child)
  machineBridgeProcess = child
  machineBridgeRespawnGaveUp = false
  let settled = false
  const settle = (lastExit, allowRespawn = true) => {
    if (settled) return
    settled = true
    if (spec.winePrefix) {
      void cleanupMachineBridgeWine(child).then((clean) => settleMachineBridgeExit(child, lastExit, allowRespawn && clean))
    } else settleMachineBridgeExit(child, lastExit, allowRespawn)
  }
  child.once('error', (error) => {
    const executableMissing = (!spec.winePrefix && error?.code === 'ENOENT')
      || (managedExecutable && !existsSync(spec.executable))
    if (executableMissing) markMachineBridgeLaunchArtifactMissing(spec.executable, 'spawn')
    else if (spec.winePrefix) {
      machineBridgeSetup = { ...machineBridgeSetup, state: 'failed', error: `The Wine bridge could not launch: ${error.message}` }
      machineBridgeRespawnGaveUp = true
    }
    settle(executableMissing
      ? machineBridgeLastExit
      : { code: null, signal: null, error: error.message }, !executableMissing && !spec.winePrefix)
  })
  child.once('exit', (code, signal) => {
    const executableMissing = managedExecutable && !existsSync(spec.executable)
    if (executableMissing) markMachineBridgeLaunchArtifactMissing(spec.executable, 'process exit')
    settle(executableMissing
      ? machineBridgeLastExit
      : { code, signal, error: spec.winePrefix ? machineBridgeWineExitLine(machineBridgeLastLine()) : machineBridgeLastLine() }, !executableMissing)
  })
  armMachineBridgeStabilityReset(child)
  return child
}

function waitForMachineBridgeExit(child, timeoutMs) {
  if (child.exitCode !== null) return Promise.resolve(true)
  return new Promise((resolve) => {
    let settled = false
    const finish = (exited) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.removeListener('exit', onExit)
      resolve(exited)
    }
    const onExit = () => finish(true)
    const timer = setTimeout(() => finish(false), timeoutMs)
    child.once('exit', onExit)
    if (child.exitCode !== null) finish(true)
  })
}

async function stopMachineBridge() {
  clearMachineBridgeRespawnTimer()
  clearMachineBridgeStableTimer()
  const child = machineBridgeProcess
  machineBridgeProcess = null
  if (!child) {
    if (machineBridgeWineCleanup) return machineBridgeWineCleanup
    if (!machineBridgeWineCleanupFailed) return true
    // Only a deliberate stop/reconnect retries a failed cleanup. Automatic
    // respawn stays stopped; retry the original prefix, never the new settings.
    const failedChild = machineBridgeWineCleanupFailed
    machineBridgeWineRuns.get(failedChild).cleanup = null
    machineBridgeWineCleanupFailed = null
    return cleanupMachineBridgeWine(failedChild)
  }
  machineBridgeIntentionalProcess = child
  const exited = waitForMachineBridgeExit(child, MACHINE_BRIDGE_STOP_TIMEOUT_MS)
  stopChild(child)
  if (await exited) return cleanupMachineBridgeWine(child)

  const hardExit = waitForMachineBridgeExit(child, MACHINE_BRIDGE_HARD_STOP_TIMEOUT_MS)
  try { child.kill('SIGKILL') } catch {}
  if (await hardExit) return cleanupMachineBridgeWine(child)

  // Wine's loader and wineserver are separate processes. Even if the loader
  // ignores the kill, release its server before reporting that stop failed.
  if (machineBridgeWineRuns.has(child)) {
    const cleaned = await cleanupMachineBridgeWine(child)
    if (cleaned && child.exitCode !== null) return true
  }
  if (machineBridgeIntentionalProcess === child) machineBridgeIntentionalProcess = null
  machineBridgeLastExit = {
    code: null,
    signal: 'SIGKILL',
    error: 'The previous bridge did not exit after it was killed.',
  }
  return false
}

function machineBridgeSocketListening(port, timeoutMs = MACHINE_BRIDGE_SOCKET_INTERVAL_MS) {
  return new Promise((resolve) => {
    let settled = false
    const socket = net.createConnection({ host: '127.0.0.1', port })
    const finish = (listening) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(listening)
    }
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.setTimeout(timeoutMs, () => finish(false))
  })
}

function waitForMachineBridgeSocket(child, port) {
  const deadline = Date.now() + MACHINE_BRIDGE_SOCKET_DEADLINE_MS
  return new Promise((resolve) => {
    const check = async () => {
      if (machineBridgeProcess !== child || child.exitCode !== null) {
        resolve({ listening: false, exited: true })
        return
      }
      const nextAttemptAt = Date.now() + MACHINE_BRIDGE_SOCKET_INTERVAL_MS
      if (await machineBridgeSocketListening(port)) {
        if (machineBridgeProcess !== child || child.exitCode !== null) {
          resolve({ listening: false, exited: true })
        } else {
          resolve({ listening: true, exited: false })
        }
        return
      }
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        resolve({ listening: false, exited: false })
        return
      }
      setTimeout(check, Math.min(Math.max(0, nextAttemptAt - Date.now()), remaining))
    }
    void check()
  })
}

async function restartMachineBridge(settings = null, { operatorPress = false } = {}) {
  trace('machine bridge deliberate restart requested')
  // WO-2845: the operator's press right after the changed-DLL line is the
  // second Connect. Read before the stop below clears the last exit.
  const connectWithChangedDll = operatorPress
    && machineBridgeLastExit?.code === MACHINE_BRIDGE_DLL_CHANGED_EXIT_CODE
    && (machineBridgeProcess === null || machineBridgeProcess.exitCode !== null)
  if (machineBridgeUpdatingFirmware()) {
    // WO-2847: stopping it now would interrupt the update. The bridge keeps
    // running and connects by itself when the update finishes.
    console.warn('[LienCAM] The machine connection was not restarted: the controller is updating its firmware. Do not close LienCAM or power off the controller.')
    return {
      ok: false,
      reason: 'no-socket',
      pid: machineBridgeProcess.pid,
      port: machineBridgePort(machineBridgeSpec() ?? { args: [] }),
      firmwareUpdate: true,
    }
  }
  const normalizedSettings = normalizeMachineBridgeLaunchSettings(settings)
  const configuredExecutable = configuredMachineBridgeExecutable(normalizedSettings)
  const preparedSettings = configuredExecutable ?? await ensureMachineBridge(
    normalizedSettings, { recoverArtifact: true },
  )
  if (preparedSettings !== null) {
    machineBridgeLaunchSettings = preparedSettings
    void persistMachineBridgeLaunchSettings(machineBridgeLaunchSettings)
  }
  const preparedSpec = preparedSettings === null ? null : machineBridgeSpec(preparedSettings)
  if (!preparedSpec) return { ok: false, reason: 'not-configured' }
  const spec = connectWithChangedDll
    ? { ...preparedSpec, args: [...preparedSpec.args, MACHINE_BRIDGE_CONNECT_WITH_CHANGED_DLL] }
    : preparedSpec

  machineBridgeRespawnAttempts = 0
  machineBridgeRespawnGaveUp = false
  machineBridgeLastAttemptAt = null
  machineBridgeRestartProcess = null
  if (!await stopMachineBridge()) {
    return { ok: false, reason: 'exited', lastExit: machineBridgeLastExit }
  }

  const port = machineBridgePort(spec)
  const child = startMachineBridge(spec)
  if (child === null) {
    return { ok: false, reason: 'exited', lastExit: machineBridgeLastExit }
  }
  machineBridgeRestartProcess = child
  const ready = await waitForMachineBridgeSocket(child, port)
  if (machineBridgeRestartProcess === child) machineBridgeRestartProcess = null
  if (ready.listening) return { ok: true, pid: child.pid, port }
  if (ready.exited) {
    return { ok: false, reason: 'exited', lastExit: machineBridgeLastExit }
  }
  // WO-2847: a child still waiting out an update is not a silent one.
  if (machineBridgeUpdatingFirmware()) return { ok: false, reason: 'no-socket', pid: child.pid, port, firmwareUpdate: true }
  return { ok: false, reason: 'no-socket', pid: child.pid, port }
}

// Read-only desktop discovery also works before the bridge holds a VFD link.
function linuxSpindlePorts() {
  if (process.platform !== 'linux') return []
  const names = directory => { try { return readdirSync(directory) } catch { return [] } }
  return [...names('/dev').filter(name => /^tty(?:USB|ACM)\d+$/.test(name)).map(name => `/dev/${name}`),
    ...names('/dev/serial/by-id').map(name => `/dev/serial/by-id/${name}`)].sort()
}

function machineBridgeStatus() {
  trace(`machine bridge status: setup=${machineBridgeSetup.state} running=${machineBridgeProcess !== null && machineBridgeProcess.exitCode === null}`)
  return {
    configured: machineBridgeSpec() !== null,
    running: !machineBridgeRespawnGaveUp
      && machineBridgeProcess !== null
      && machineBridgeProcess.exitCode === null,
    pid: machineBridgeProcess?.pid ?? null,
    lastExit: machineBridgeLastExit,
    respawn: {
      attempts: machineBridgeRespawnAttempts,
      gaveUp: machineBridgeRespawnGaveUp,
      lastAttemptAt: machineBridgeLastAttemptAt,
    },
    firmwareUpdate: machineBridgeUpdatingFirmware()
      ? { since: machineBridgeFirmwareUpdate.since, line: machineBridgeFirmwareUpdate.line }
      : null,
    // WO-2847: each line once, by id (bridgeHost.ts takeBridgeConsoleLines).
    // An outcome stays until it is said; a progress line only while its
    // update still runs - after that it would be a stale "in progress".
    consoleLines: machineBridgeConsoleLines
      .filter((line) => !line.progress
        || (machineBridgeUpdatingFirmware() && machineBridgeFirmwareUpdate.eventId === line.id))
      .map(({ id, severity, text }) => ({ id, severity, text })),
    ...(process.platform === 'linux' ? { serialPorts: linuxSpindlePorts() } : {}),
    setup: { ...machineBridgeSetup },
    overrides: machineBridgeOverrides(),
  }
}

/** WO-2628: the developer environment overrides that replace the saved
 * settings. An installed LienCAM sets neither; when one is in force the
 * operator is told, because the Machine page settings are then not what runs. */
function machineBridgeOverrides() {
  return {
    executable: Boolean(process.env.LIENCAM_BRIDGE_EXECUTABLE),
    args: Boolean(process.env.LIENCAM_BRIDGE_ARGS_JSON),
  }
}

function reportMachineBridgeOverrides() {
  const overrides = machineBridgeOverrides()
  const names = [
    ...(overrides.executable ? ['LIENCAM_BRIDGE_EXECUTABLE'] : []),
    ...(overrides.args ? ['LIENCAM_BRIDGE_ARGS_JSON'] : []),
  ]
  if (names.length === 0) return
  console.warn(`[LienCAM] Developer override in force: ${names.join(' and ')} ${names.length === 1 ? 'replaces' : 'replace'} the machine connection settings saved on the Machine page. Start LienCAM from its own shortcut to use the saved settings.`)
}

/**
 * WO-2883: the shutdown an update takes before it replaces or restarts this copy. It
 * stops the pendant and waits for the machine bridge (and its Wine cleanup) to exit;
 * false when the bridge would not stop. A bridge mid firmware update is never stopped.
 */
async function shutdownForUpdate() {
  if (machineBridgeUpdatingFirmware()) throw new Error('the controller is updating its firmware; install again when it finishes')
  if (pendantProcess && pendantProcess.exitCode === null) pendantStoppedForUpdate = true
  stopPendant()
  return stopMachineBridge()
}

/** After a replace that failed, this copy keeps running: start what the shutdown stopped. */
function resumeAfterUpdate() {
  initializeMachineBridge().catch((error) => console.warn('[LienCAM] update: the machine bridge did not start again:', error))
  if (!pendantStoppedForUpdate) return
  pendantStoppedForUpdate = false
  startPendant().catch((error) => console.warn('[LienCAM] update: the pendant did not start again:', error))
}

async function initializeMachineBridge() {
  trace('machine bridge automatic startup requested')
  machineBridgeWaitingForConnect()
  const startingSettings = machineBridgeLaunchSettings
  const configuredExecutable = configuredMachineBridgeExecutable(machineBridgeLaunchSettings)
  const preparedSettings = configuredExecutable ?? await ensureMachineBridge(machineBridgeLaunchSettings)
  if (preparedSettings === null) return null
  machineBridgeLaunchSettings = preparedSettings
  if (configuredExecutable === null
      && JSON.stringify(startingSettings) !== JSON.stringify(preparedSettings)) {
    void persistMachineBridgeLaunchSettings(machineBridgeLaunchSettings)
  }
  // WO-3290: prepared, and started by the operator's first Connect.
  if (machineBridgeWaitsForConnect) {
    trace('machine bridge waits for the first Connect (fresh install)')
    return null
  }
  return startMachineBridge()
}

if (typeof module !== 'undefined') {
  module.exports = {
    RENDERER_BUILD_INPUTS,
    rendererBuildContentIdentity,
    inspectRendererBuild,
    missingRendererHtml,
    reportRendererBuildStatus,
    machineBridgeSpec,
    machineBridgePort,
    machineBridgeRespawnDecision,
    machineBridgeSocketListening,
    machineBridgeStatus,
    initializeMachineBridge,
    restartMachineBridge,
    startMachineBridge,
    stopMachineBridge,
  }
}

async function handleHostRequest(request, pathname) {
  if (request.method !== 'POST') return jsonResponse(405, { ok: false, error: 'POST required.' })
  try {
    if (pathname === '/__liencam/pendant-broker/start') {
      return jsonResponse(200, { ok: true, ...(await startPendant()) })
    }
    if (pathname === '/__liencam/pendant-broker/stop') {
      stopPendant()
      return jsonResponse(200, { ok: true })
    }
    return jsonResponse(404, { ok: false, error: 'Unknown host action.' })
  } catch (error) {
    return jsonResponse(503, { ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}

async function handleAppRequest(request) {
  const url = new URL(request.url)
  trace(`protocol request ${request.method} ${url.href}`)
  if (url.host !== APP_HOST) return new Response('Not found', { status: 404 })
  if (url.pathname.startsWith('/__liencam/')) return handleHostRequest(request, url.pathname)

  let relativePath
  try {
    relativePath = path.posix.normalize(decodeURIComponent(url.pathname)).replace(/^\/+/, '')
  } catch {
    return new Response('Bad request', { status: 400 })
  }
  if (!relativePath) relativePath = 'index.html'
  if (relativePath === '..' || relativePath.startsWith('../')) {
    return new Response('Forbidden', { status: 403 })
  }
  const root = appRoot()
  if (relativePath === 'index.html' && rendererBuildStatus.state === 'missing') {
    return new Response(missingRendererHtml(rendererBuildStatus.message), {
      status: 200,
      headers: responseHeaders('text/html; charset=utf-8'),
    })
  }
  const filePath = path.resolve(root, ...relativePath.split('/'))
  if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) {
    return new Response('Forbidden', { status: 403 })
  }
  try {
    const body = await readFile(filePath)
    trace(`read ${filePath} (${body.byteLength} bytes)`)
    const contentType = MIME_TYPES.get(path.extname(filePath).toLowerCase()) || 'application/octet-stream'
    return new Response(body, { status: 200, headers: responseHeaders(contentType) })
  } catch (error) {
    return new Response(error && error.code === 'ENOENT' ? 'Not found' : 'Read failed', {
      status: error && error.code === 'ENOENT' ? 404 : 500,
    })
  }
}

function createWindow() {
  trace('creating BrowserWindow')
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    backgroundColor: '#111827',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`${APP_SCHEME}://${APP_HOST}/`)) event.preventDefault()
  })
  window.webContents.on('did-fail-load', (_event, code, description, url) => {
    console.error(`[LienCAM] renderer load failed (${code} ${description}): ${url}`)
  })
  window.webContents.on('render-process-gone', (_event, details) => {
    releaseJobWakeLock()
    jobRunning = false
    console.error(`[LienCAM] renderer process gone: ${details.reason} (${details.exitCode})`)
  })
  window.once('ready-to-show', () => {
    const { width, height } = screen.getPrimaryDisplay().workAreaSize
    window.setSize(Math.min(1440, width), Math.min(900, height))
    window.center()
    // Maximize while hidden so the first visible frame fills the work area.
    // The clamped normal size remains the restore-down size; later capture sizing
    // stays under the harness's control (there is no resize/maximize listener).
    window.maximize()
    window.show()
  })
  const entry = process.argv.includes('--wo958-evidence')
    ? `${APP_SCHEME}://${APP_HOST}/electron/evidence.html`
    : `${APP_SCHEME}://${APP_HOST}/index.html`
  trace(`loading ${entry}`)
  void window.loadURL(entry).catch((error) => {
    console.error(`[LienCAM] could not load ${entry}:`, error)
  })
  window.once('closed', () => {
    releaseJobWakeLock()
    jobRunning = false
    if (mainWindow === window) mainWindow = null
  })
  mainWindow = window
}

ipcMain.handle('liencam:machine-bridge-status', () => machineBridgeStatus())
ipcMain.handle('liencam:linux-controller-ports', event => {
  if (mainWindow === null || event.sender !== mainWindow.webContents) return undefined
  return linuxControllerNetwork.ports()
})
ipcMain.handle('liencam:linux-controller-network', (event, input) => {
  if (mainWindow === null || event.sender !== mainWindow.webContents) return undefined
  return linuxControllerNetwork.setup(input)
})
ipcMain.handle('liencam:linux-serial-permission', (event, port) => {
  if (mainWindow === null || event.sender !== mainWindow.webContents) return null
  return linuxControllerNetwork.serialPermission(port)
})
// WO-1259: the renderer hands over the build provenance BAKED INTO the bundle
// that is executing (src/version.ts GIT_COMMIT), and the main process answers
// with a content comparison against it. Asking the running bundle beats reading
// a manifest beside `dist/`, because a file beside the output can be stale, hand
// written or left over from a different build - the constant inside the bundle
// can only have come from the build that produced the code now on screen.
ipcMain.handle('liencam:renderer-build-status', async (_event, provenance) => {
  if (rendererBuildStatus.state === 'missing') return rendererBuildStatus
  // Capture-harness override (src/tests/evidence/WO-1259/shoot.mjs). It can only
  // change WHICH revision the real content comparison runs against, never the
  // comparison itself, and a packaged build ignores it outright.
  const override = !app.isPackaged ? process.env.LIENCAM_BUILD_CHECK_COMMIT : undefined
  const commit = override || (provenance && typeof provenance.commit === 'string' ? provenance.commit : '')
  rendererBuildStatus = await inspectRendererBuild({ commit })
  reportRendererBuildStatus(rendererBuildStatus)
  return rendererBuildStatus
})
ipcMain.on('liencam:machine-bridge-ready', (event, settings) => {
  if (mainWindow !== null && event.sender !== mainWindow.webContents) return
  // Reconcile the first run after an upgrade (or a changed active project)
  // with the renderer-owned authority. Later edits use the remember-only
  // channel below and still require the operator's explicit Restart action.
  const suppliedSettings = normalizeMachineBridgeLaunchSettings(settings)
  void (async () => {
    if (machineBridgeBuildPromise !== null) await machineBridgeBuildPromise
    const hydratedSettings = suppliedSettings?.installRoot || !machineBridgeSetup.installRoot
      ? suppliedSettings
      : { ...(suppliedSettings ?? {}), installRoot: machineBridgeSetup.installRoot }
    const runningSpec = machineBridgeSpec()
    const hydratedSpec = machineBridgeSpec(hydratedSettings)
    machineBridgeLaunchSettings = hydratedSettings
    void persistMachineBridgeLaunchSettings(machineBridgeLaunchSettings)
    if (sameMachineBridgeSpec(runningSpec, hydratedSpec)) return
    // WO-3290: a fresh install's bridge is not running; Connect starts it.
    if (machineBridgeWaitsForConnect) return
    void restartMachineBridge(machineBridgeLaunchSettings)
  })()
})
ipcMain.on('liencam:machine-bridge-remember', (event, settings) => {
  if (mainWindow !== null && event.sender !== mainWindow.webContents) return
  void persistMachineBridgeLaunchSettings(normalizeMachineBridgeLaunchSettings(settings))
})
ipcMain.handle('liencam:machine-bridge-restart', async (event, settings, request) => {
  if (mainWindow !== null && event.sender !== mainWindow.webContents) return undefined
  // WO-3290: only the operator's press (preload passes it) is the first Connect.
  const pressed = request?.operatorPress === true
  if (!pressed && machineBridgeWaitingForConnect()) return waitForMachineBridgeFirstConnect()
  if (pressed) recordMachineBridgeOperatorConnect()
  const result = restartMachineBridge(settings, { operatorPress: true })
  if (pressed) answerMachineBridgeFirstConnectWaiters(result)
  return result
})
ipcMain.handle('liencam:choose-machine-path', async (event, kind) => {
  if (mainWindow !== null && event.sender !== mainWindow.webContents) return undefined
  if (kind !== 'install-root' && kind !== 'vfd-definition') return undefined
  const result = await dialog.showOpenDialog(mainWindow ?? undefined, {
    title: kind === 'install-root' ? 'Choose the UCCNC install folder' : 'Choose the spindle definition',
    properties: [kind === 'install-root' ? 'openDirectory' : 'openFile'],
    ...(kind === 'vfd-definition'
      ? { filters: [{ name: 'JSON spindle definitions', extensions: ['json'] }] }
      : {}),
  })
  return result.canceled ? null : result.filePaths[0] ?? null
})
ipcMain.handle('liencam:open-project-link', async (event, url) => {
  if (mainWindow === null || event.sender !== mainWindow.webContents) return
  if (!['https://github.com/eclsnowman/LienCAM', 'https://github.com/eclsnowman/LienCAM/releases'].includes(url)) {
    throw new Error('Unknown project link.')
  }
  await shell.openExternal(url)
})
// WO-2759 Help > Report a problem: open the bug-report form only, and only with
// the prefill fields the renderer showed the user (version, os, controller).
// Anything else in the address is refused rather than passed to the browser.
const ISSUE_FORM_FIELDS = new Set(['template', 'version', 'os', 'controller'])
ipcMain.handle('liencam:open-issue-form', async (event, url) => {
  if (mainWindow === null || event.sender !== mainWindow.webContents) return
  let parsed
  try { parsed = new URL(url) } catch { throw new Error('Unknown issue form address.') }
  if (parsed.origin !== 'https://github.com' || parsed.pathname !== '/eclsnowman/LienCAM/issues/new' || parsed.hash !== ''
    || parsed.username !== '' || parsed.password !== ''
    || [...parsed.searchParams.keys()].some((key) => !ISSUE_FORM_FIELDS.has(key))
    || [...parsed.searchParams.values()].some((value) => value.length > 120)) {
    throw new Error('Unknown issue form address.')
  }
  await shell.openExternal(parsed.href)
})
// WO-2911 Report this problem: a picture of LienCAM's own window for the report
// preview, where the operator sees it and can remove it. Only the main window
// may ask, only that window is captured, and the PNG goes back to it alone.
const APP_CAPTURE_MAX_PIXELS = 16_000_000
ipcMain.handle('liencam:capture-app', async (event) => {
  if (mainWindow === null || event.sender !== mainWindow.webContents) return null
  let image = await mainWindow.webContents.capturePage()
  const { width, height } = image.getSize()
  if (width * height > APP_CAPTURE_MAX_PIXELS) {
    const scale = Math.sqrt(APP_CAPTURE_MAX_PIXELS / (width * height))
    image = image.resize({ width: Math.floor(width * scale), height: Math.floor(height * scale) })
  }
  return new Uint8Array(image.toPNG())
})
// WO-2725 desktop recent projects. Only dialog-selected/saved or already-recent
// paths may be read by the renderer; listing uses stat, never project-file reads.
const selectedProjectPaths = new Set()
let recentProjectWrites = Promise.resolve()
function recentProjectsPath() { return path.join(app.getPath('userData'), 'recent-projects.json') }
function projectPathKey(value) { return process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value) }
function cleanProjectThumbnail(value) {
  return typeof value === 'string' && value.length <= 400000 && /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value) ? value : undefined
}
async function readRecentProjects() {
  try {
    const saved = JSON.parse(await readFile(recentProjectsPath(), 'utf8'))
    return Array.isArray(saved) ? saved.filter((item) => item && typeof item.path === 'string' && path.isAbsolute(item.path) && /\.camproject$/i.test(item.path) && typeof item.name === 'string' && typeof item.openedAt === 'string')
      .slice(0, 10).map((item) => ({ path: item.path, name: item.name, openedAt: item.openedAt, thumbnail: cleanProjectThumbnail(item.thumbnail) })) : []
  } catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return []; throw error }
}
function updateRecentProjects(update) {
  const write = recentProjectWrites.catch(() => {}).then(async () => {
    const next = update(await readRecentProjects())
    const target = recentProjectsPath()
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(`${target}.tmp`, JSON.stringify(next), 'utf8')
    await rename(`${target}.tmp`, target)
  })
  recentProjectWrites = write
  return write
}
ipcMain.handle('liencam:recent-projects', async (event) => {
  if (mainWindow === null || event.sender !== mainWindow.webContents) return []
  await recentProjectWrites.catch(() => {})
  return (await readRecentProjects()).map((item) => {
    let missing = false
    try { missing = !statSync(item.path).isFile() } catch { missing = true }
    return { ...item, missing }
  })
})
ipcMain.handle('liencam:open-project-file', async (event, requestedPath) => {
  if (mainWindow === null || event.sender !== mainWindow.webContents) return null
  let selected = requestedPath
  if (selected === undefined) {
    const result = await dialog.showOpenDialog(mainWindow, { title: 'Open a project', properties: ['openFile'], filters: [{ name: 'LienCAM projects', extensions: ['camproject'] }] })
    if (result.canceled || !result.filePaths[0]) return null
    selected = result.filePaths[0]
    selectedProjectPaths.add(projectPathKey(selected))
  } else {
    if (typeof selected !== 'string') throw new Error('Invalid project path.')
    await recentProjectWrites.catch(() => {})
    if (!(await readRecentProjects()).some((item) => projectPathKey(item.path) === projectPathKey(selected))) throw new Error('Choose this project with Browse first.')
  }
  return { path: selected, text: await readFile(selected, 'utf8') }
})
ipcMain.handle('liencam:remember-project', async (event, item) => {
  if (mainWindow === null || event.sender !== mainWindow.webContents) return
  if (!item || typeof item.path !== 'string' || !path.isAbsolute(item.path) || !/\.camproject$/i.test(item.path) || typeof item.name !== 'string') throw new Error('Invalid recent project.')
  return updateRecentProjects((entries) => {
    const key = projectPathKey(item.path)
    if (!selectedProjectPaths.has(key) && !entries.some((entry) => projectPathKey(entry.path) === key)) throw new Error('Choose this project with Browse first.')
    return [{ path: item.path, name: item.name.slice(0, 500), openedAt: new Date().toISOString(), thumbnail: cleanProjectThumbnail(item.thumbnail) },
      ...entries.filter((entry) => projectPathKey(entry.path) !== key)].slice(0, 10)
  })
})
ipcMain.handle('liencam:remove-recent-project', async (event, selected) => {
  if (mainWindow === null || event.sender !== mainWindow.webContents || typeof selected !== 'string') return
  return updateRecentProjects((entries) => entries.filter((entry) => projectPathKey(entry.path) !== projectPathKey(selected)))
})
// End WO-2725 recent projects.

// the operator 09-25 at the machine: Export .nc, project Save and every other download
// did nothing in the desktop app. The renderer hands the bytes here; the operator
// picks where they go. Answers the saved path, or null when the operator cancels.
ipcMain.handle('liencam:save-file', async (event, filename, data) => {
  if (mainWindow !== null && event.sender !== mainWindow.webContents) return null
  if (typeof filename !== 'string' || filename.length === 0) throw new Error('Save needs a file name.')
  if (typeof data !== 'string' && !(data instanceof Uint8Array)) throw new Error('Save needs text or bytes.')
  const extension = path.extname(filename).slice(1)
  const result = await dialog.showSaveDialog(mainWindow ?? undefined, {
    title: 'Save',
    defaultPath: path.join(app.getPath('downloads'), path.basename(filename)),
    ...(extension ? { filters: [{ name: `.${extension} files`, extensions: [extension] }, { name: 'All files', extensions: ['*'] }] } : {}),
  })
  if (result.canceled || !result.filePath) return null
  await writeFile(result.filePath, data)
  if (/\.camproject$/i.test(result.filePath)) selectedProjectPaths.add(projectPathKey(result.filePath))
  return result.filePath
})
ipcMain.on('liencam:set-job-wake-lock', (event, active) => {
  if (typeof active !== 'boolean') {
    console.warn('[LienCAM] Ignored an invalid job wake lock request.')
    return
  }
  if (mainWindow !== null && event.sender !== mainWindow.webContents) return
  jobRunning = active
  if (active) holdJobWakeLock()
  else releaseJobWakeLock()
})

// WO-3010: the Settings switch and the toolbar indicator. Only the main window may
// ask; the answer is the server's state (running, port, connected client name).
ipcMain.handle('liencam:mcp-state', (event) => {
  if (mainWindow === null || event.sender !== mainWindow.webContents) return null
  return mcpState()
})
ipcMain.handle('liencam:mcp-set-enabled', async (event, enabled) => {
  if (mainWindow === null || event.sender !== mainWindow.webContents) return null
  try {
    return enabled === true ? await mcpServerInstance().start() : await mcpServerInstance().stop()
  } catch (error) {
    console.warn(`[LienCAM] The MCP server could not start: ${error?.message ?? error}`)
    return mcpState()
  }
})

app.whenReady().then(async () => {
  trace('app ready')
  if (!existsSync(path.join(appRoot(), 'index.html'))) {
    rendererBuildStatus = Object.freeze({
      state: 'missing',
      message: 'LienCAM cannot start because the built app is missing. Run npm run build, then open LienCAM again.',
    })
    reportRendererBuildStatus(rendererBuildStatus)
  }
  protocol.handle(APP_SCHEME, handleAppRequest)
  trace('protocol registered')
  Menu.setApplicationMenu(null)
  machineBridgeLaunchSettings = readMachineBridgeLaunchSettings()
  reportMachineBridgeOverrides()
  void initializeMachineBridge()
  createWindow()
  // WO-2883: the desktop app updates itself from the published releases. A failure to set
  // updates up is logged and never stops LienCAM from starting.
  try {
    const { createUpdateRoute, registerUpdateIpc } = require(path.join(__dirname, 'update', 'updater.cjs'))
    const updateRoute = createUpdateRoute({
      currentVersion: app.getVersion(), platform: process.platform, arch: process.arch, packaged: app.isPackaged,
      portableFile: process.env.PORTABLE_EXECUTABLE_FILE, appImage: process.env.APPIMAGE,
      updatesDir: path.join(app.getPath('temp'), 'LienCAM-updates'),
      fetch: (url, init) => electronNet.fetch(url, init),
      isJobRunning: () => jobRunning,
      spawn,
      // Every install-and-restart path takes the one shutdown first: the updater awaits it
      // before the installer starts or the AppImage is swapped, and the quit and relaunch
      // take it again, because app.exit skips will-quit and its cleanup.
      shutdown: shutdownForUpdate,
      resume: resumeAfterUpdate,
      quit: () => { void shutdownForUpdate().catch(() => false).then(() => app.quit()) },
      relaunch: (execPath) => {
        void shutdownForUpdate().catch(() => false).then(() => { app.relaunch({ execPath }); app.exit(0) })
      },
      showItemInFolder: (file) => shell.showItemInFolder(file),
      openPath: (file) => shell.openPath(file),
      emitProgress: (progress) => { if (mainWindow) mainWindow.webContents.send('liencam:update-progress', progress) },
    })
    registerUpdateIpc({ ipcMain, route: updateRoute, isTrustedSender: (sender) => mainWindow !== null && sender === mainWindow.webContents })
  } catch (error) {
    console.error('[LienCAM] update check unavailable:', error)
  }
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', (event) => {
  if ((process.platform === 'linux' && (machineBridgeProcess || machineBridgeWineCleanup))
      || (process.platform === 'darwin' && machineBridgeProcess)) {
    event.preventDefault()
    releaseJobWakeLock()
    stopPendant()
    void stopMachineBridge().then(() => app.quit())
    return
  }
  releaseJobWakeLock()
  stopPendant()
  void stopMachineBridge()
  // WO-3010: the endpoint file names a token that dies with this run.
  if (mcpServer !== null) void mcpServer.stop()
})
