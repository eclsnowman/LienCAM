// @vitest-environment jsdom
// WO-3290 (alpha.3.1 finding 15): a Linux fresh install waits for the
// operator's first Connect; every computer that ran LienCAM before starts the
// bridge at launch exactly as main does. electron/main.cjs runs in a VM with
// only the OS faked (the WO-3088/WO-3072 harness shape). The fake app mirrors
// the Electron behaviour the decision rests on, measured on Electron 44
// (src/tests/evidence/WO-3290/electron-user-data-probe.txt): the user-data
// folder does not exist on a computer that never ran the app, and the first
// app.getPath('userData') creates it. The renderer reaches main through the
// real electron/preload.cjs; opening Control runs the production
// ensureBridgeForControl -> bridgeHost -> preload -> main chain (astra audit).
import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import * as fsPromises from 'node:fs/promises'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { electronMainRequire } from '../support/electronMainRequire'
import { ensureBridgeForControl } from '../../components/machine/definition/useMachineDefinitionPanel'
import { prepareHostedBridgeForConnect } from '../../lib/machine/bridgeHost'
import { useCamStore } from '../../store'
import { useMachineControl } from '../../store/machineControlStore'

class Child extends EventEmitter {
  pid = 3290
  exitCode: number | null = null
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  kill = vi.fn(() => { void Promise.resolve().then(() => { this.exitCode = 0; this.emit('exit', 0, null) }); return true })
}
interface MainApi {
  initializeMachineBridge(): Promise<Child | null>
  restartMachineBridge(settings?: object, options?: { operatorPress?: boolean }): Promise<{ ok: boolean; reason?: string }>
  machineBridgeStatus(): { configured: boolean; running: boolean; setup: { state: string } }
  stopMachineBridge(): Promise<boolean>
}

const posix = path.posix
const root = '/liencam-wo3290'
const appData = posix.join(root, 'config')
const defaultUserData = posix.join(appData, 'LienCAM')
const hostRoots: string[] = []
afterEach(() => { for (const hostRoot of hostRoots.splice(0)) rmSync(hostRoot, { recursive: true, force: true }) })

interface Computer {
  /** What this computer holds before the launch: nothing (never ran LienCAM),
   *  an empty user-data folder, or saved launch settings (an earlier build). */
  before?: 'nothing' | 'empty-folder' | { settings: unknown }
  platform?: 'linux' | 'win32'
  env?: Record<string, string>
  /** Launch again on the same computer. */
  hostRoot?: string
}

function launch(computer: Computer = {}) {
  const relaunch = computer.hostRoot !== undefined
  const hostRoot = computer.hostRoot ?? mkdtempSync(path.join(tmpdir(), 'liencam-wo3290-'))
  if (!relaunch) hostRoots.push(hostRoot)
  const hostPath = (value: string) => {
    const relative = posix.relative(root, value)
    if (relative === '..' || relative.startsWith('../') || !posix.isAbsolute(value)) throw new Error(`Outside fixture: ${value}`)
    return path.join(hostRoot, ...relative.split('/'))
  }
  const mapFs = <T extends object>(source: T, counts: Record<string, number>): T => new Proxy(source, {
    get(target, key) {
      const original = Reflect.get(target, key)
      const count = counts[String(key)]
      if (!count || typeof original !== 'function') return original
      return (...args: unknown[]) => Reflect.apply(original, target, args.map((v, i) => i < count ? hostPath(String(v)) : v))
    },
  })
  const disk = mapFs(fs, { existsSync: 1, mkdirSync: 1, readFileSync: 1, readdirSync: 1, statSync: 1, rmSync: 1, writeFileSync: 1, chmodSync: 1 })
  const asyncDisk = mapFs(fsPromises, { appendFile: 1, cp: 2, mkdir: 1, readFile: 1, readdir: 1, rename: 2, rm: 1, writeFile: 1, stat: 1 })
  const resources = posix.join(root, 'resources')
  const native = posix.join(resources, 'pendant', 'uccnc-bridge', 'native', 'linux-x64', 'liencam-bridge')
  disk.mkdirSync(posix.dirname(native), { recursive: true })
  disk.writeFileSync(native, 'native executable')
  disk.writeFileSync(posix.join(posix.dirname(native), 'liencam-bridge.dll'), 'native assembly')
  disk.mkdirSync(appData, { recursive: true })
  const before = computer.before ?? 'nothing'
  if (!relaunch && before !== 'nothing') {
    disk.mkdirSync(defaultUserData, { recursive: true })
    if (typeof before === 'object') {
      disk.writeFileSync(posix.join(defaultUserData, 'machine-bridge-launch-settings.json'), JSON.stringify(before.settings))
    }
  }
  let userData = defaultUserData
  const spawned: Array<{ executable: string; args: string[] }> = []
  const processValue = { ...process, platform: computer.platform ?? 'linux', arch: 'x64', argv: [], resourcesPath: resources,
    env: { ...process.env, LIENCAM_BRIDGE_EXECUTABLE: '', LIENCAM_BRIDGE_ARGS_JSON: '', LIENCAM_USER_DATA_DIR: '',
      LIENCAM_BRIDGE_NATIVE: '', LIENCAM_BRIDGE_WINE: '', WINEPREFIX: '', LIENCAM_UCCNC_SEARCH_ROOT: '', ...computer.env } }
  const app = { isPackaged: true, name: 'LienCAM', on: vi.fn(), quit: vi.fn(), whenReady: () => ({ then: () => Promise.resolve() }),
    // Electron: getPath('userData') creates the folder; setPath only names it.
    getPath: (name: string) => {
      if (name === 'appData') return appData
      if (name === 'userData') { disk.mkdirSync(userData, { recursive: true }); return userData }
      return posix.join(root, name)
    },
    setPath: (name: string, value: string) => { if (name === 'userData') userData = value } }
  const module = { exports: {} as MainApi }
  const ipcMain = { handle: vi.fn(), on: vi.fn() }
  const context = vm.createContext({ module, exports: module.exports, process: processValue, __dirname: posix.join(resources, 'electron'),
    AbortSignal, Buffer, Date, Promise, Response, URL, clearTimeout, setTimeout, queueMicrotask, fetch,
    console: { ...console, warn: vi.fn(), error: vi.fn(), info: vi.fn() },
    require: (id: string) => {
      if (id === 'node:path') return posix
      if (id === 'node:fs') return disk
      if (id === 'node:fs/promises') return asyncDisk
      if (id === 'electron') return { app, ipcMain, protocol: { registerSchemesAsPrivileged: vi.fn() } }
      if (id === 'node:net') return { createConnection: () => {
        // The started bridge answers on its port at once.
        const socket = Object.assign(new EventEmitter(), { destroy: vi.fn(), setTimeout: vi.fn() })
        void Promise.resolve().then(() => socket.emit('connect'))
        return socket
      } }
      if (id === 'node:child_process') return {
        spawn: (executable: string, args: string[]) => { spawned.push({ executable, args }); return new Child() },
        execFile: (_e: string, _a: string[], _o: object, done: (error: Error | null) => void) => { void Promise.resolve().then(() => done(null)) },
      }
      return electronMainRequire(id)
    } })
  vm.runInContext(fs.readFileSync(path.resolve('electron/main.cjs'), 'utf8'), context)
  // app ready (main.cjs app.whenReady): read the saved settings, then start up.
  vm.runInContext('machineBridgeLaunchSettings = readMachineBridgeLaunchSettings()', context)
  const file = (name: string) => posix.join(userData, name)
  const readText = (name: string) => disk.existsSync(file(name)) ? String(disk.readFileSync(file(name), 'utf8')) : null
  const ipcOn = (channel: string) => ipcMain.on.mock.calls.find((call) => call[0] === channel)?.[1] as (event: object, settings: unknown) => void
  const ipcHandle = (channel: string) => ipcMain.handle.mock.calls.find((call) => call[0] === channel)?.[1] as (event: object, ...args: unknown[]) => Promise<{ ok: boolean }>
  const writes = () => vm.runInContext('machineBridgeSettingsWriteChain', context) as Promise<void>
  // The desktop preload, wired to this main process.
  let preloadHost: Record<string, unknown> = {}
  vm.runInNewContext(fs.readFileSync(path.resolve('electron/preload.cjs'), 'utf8'), {
    Object,
    process: { platform: processValue.platform, versions: { chrome: '1', electron: '1' } },
    require: (id: string) => {
      if (id !== 'electron') throw new Error(`preload required ${id}`)
      return {
        contextBridge: { exposeInMainWorld: (name: string, api: Record<string, unknown>) => { if (name === 'liencamHost') preloadHost = api } },
        ipcRenderer: {
          invoke: (channel: string, ...args: unknown[]) => Promise.resolve(ipcHandle(channel)({ sender: null }, ...args)),
          send: (channel: string, ...args: unknown[]) => ipcOn(channel)({ sender: null }, args[0]),
          on: vi.fn(), removeListener: vi.fn(),
        },
      }
    },
  })
  return {
    api: module.exports, spawned, hostRoot, writes, preloadHost,
    savedSettings: () => readText('machine-bridge-launch-settings.json'),
    firstConnectRecord: () => readText('machine-bridge-first-connect.json'),
    /** The renderer's Connect press (bridgeHost.ts -> preload -> this handler). */
    connect: async (settings?: unknown) => {
      const restart = preloadHost.machineBridgeRestart as (settings: unknown, options: object) => Promise<{ ok: boolean }>
      const result = await restart(settings, { operatorPress: true })
      await writes()
      return result
    },
    /** Boot hydration (uiPrefs supplyMachineBridgeSettingsOnBoot): machineLinks[machineId],
     *  undefined until a port is set, which main saves as null launch settings. */
    hydrate: async (settings?: unknown) => {
      ipcOn('liencam:machine-bridge-ready')({ sender: null }, settings)
      await new Promise((resolve) => setTimeout(resolve, 100))
      await writes()
    },
    /** A failed update: its shutdown stopped the bridge, resumeAfterUpdate starts what it stopped. */
    failedUpdate: async () => {
      await vm.runInContext('shutdownForUpdate()', context)
      vm.runInContext('resumeAfterUpdate()', context)
      await new Promise((resolve) => setTimeout(resolve, 100))
      await writes()
    },
  }
}

describe('WO-3290: a Linux fresh install waits for the first Connect', () => {
  it('a computer that never ran LienCAM prepares the bridge, starts nothing, and the first Connect starts it once', async () => {
    const h = launch({ before: 'nothing' })
    expect(await h.api.initializeMachineBridge(), 'fresh launch started the bridge').toBeNull()
    expect(h.spawned).toHaveLength(0)
    // Prepared: Connect has a bridge to start.
    expect(h.api.machineBridgeStatus()).toMatchObject({ configured: true, running: false })
    await h.writes()
    expect(h.firstConnectRecord()).toBe('{"awaitingFirstConnect":true}')
    expect(await h.connect()).toMatchObject({ ok: true })
    expect(h.spawned).toHaveLength(1)
    expect(h.spawned[0].args).toEqual(['--board', 'auto'])
    expect(h.firstConnectRecord()).toBe('{"awaitingFirstConnect":false}')
    await h.api.stopMachineBridge()

    // The fable 10-28 review's sequence from a fresh install: hydration with
    // no port saves null settings; every later launch still starts the bridge.
    for (const name of ['second', 'third']) {
      const next = launch({ hostRoot: h.hostRoot })
      expect(await next.api.initializeMachineBridge(), `${name} launch started the bridge`).not.toBeNull()
      expect(next.spawned).toHaveLength(1)
      await next.hydrate(undefined)
      expect(next.savedSettings()).toBe('null')
      await next.api.stopMachineBridge()
    }
  })

  it('closed before the first Connect: the next launch still waits, then Connect ends the wait for good', async () => {
    const first = launch({ before: 'nothing' })
    expect(await first.api.initializeMachineBridge()).toBeNull()
    await first.hydrate(undefined)
    expect(first.spawned).toHaveLength(0)

    const second = launch({ hostRoot: first.hostRoot })
    expect(await second.api.initializeMachineBridge(), 'second launch before any Connect').toBeNull()
    expect(second.spawned).toHaveLength(0)
    expect(await second.connect()).toMatchObject({ ok: true })
    expect(second.spawned).toHaveLength(1)
    await second.api.stopMachineBridge()

    for (const name of ['third', 'fourth']) {
      const h = launch({ hostRoot: first.hostRoot })
      expect(await h.api.initializeMachineBridge(), `${name} launch started the bridge`).not.toBeNull()
      expect(h.spawned).toHaveLength(1)
      await h.hydrate(undefined)
      expect(h.savedSettings()).toBe('null')
      await h.api.stopMachineBridge()
    }
  })

  it('boot hydration on a waiting fresh install starts nothing, whatever link it supplies', async () => {
    const h = launch({ before: 'nothing' })
    expect(await h.api.initializeMachineBridge()).toBeNull()
    await h.hydrate(undefined)
    await h.hydrate({ board: 'auto', bridgePort: 8411 })
    expect(h.spawned).toHaveLength(0)
    expect(await h.connect({ board: 'auto', bridgePort: 8411 })).toMatchObject({ ok: true })
    expect(h.spawned).toHaveLength(1)
    expect(h.spawned[0].args).toContain('8411')
    await h.api.stopMachineBridge()
  })

  it('a failed update before the first Connect keeps waiting; after Connect it starts the bridge again', async () => {
    const h = launch({ before: 'nothing' })
    expect(await h.api.initializeMachineBridge()).toBeNull()
    await h.failedUpdate()
    expect(h.spawned, 'resumeAfterUpdate before Connect').toHaveLength(0)
    expect(await h.connect()).toMatchObject({ ok: true })
    expect(h.spawned).toHaveLength(1)
    await h.failedUpdate()
    expect(h.spawned, 'resumeAfterUpdate after Connect').toHaveLength(2)
    await h.api.stopMachineBridge()
  })

  it('a rehearsal profile (LIENCAM_USER_DATA_DIR) that does not exist yet is a fresh install', async () => {
    const env = { LIENCAM_USER_DATA_DIR: posix.join(root, 'rehearsal') }
    const h = launch({ before: 'nothing', env })
    expect(await h.api.initializeMachineBridge()).toBeNull()
    expect(h.spawned).toHaveLength(0)
    await h.api.stopMachineBridge()
    // The same profile again, once Connect was pressed: starts at launch.
    const again = launch({ hostRoot: h.hostRoot, env })
    expect(await again.api.initializeMachineBridge()).toBeNull()
    expect(await again.connect()).toMatchObject({ ok: true })
    await again.api.stopMachineBridge()
    const third = launch({ hostRoot: h.hostRoot, env })
    expect(await third.api.initializeMachineBridge()).not.toBeNull()
    await third.api.stopMachineBridge()
  })
})

// Every one of these is main's behaviour, byte for byte in what it starts:
// the same file passes them against main's electron/main.cjs.
describe('WO-3290: every computer that ran LienCAM before starts the bridge at launch, as main does', () => {
  it('connected before WO-3088 (settings saved, no Connect record): starts at launch, after hydration nulls the settings too (astra 10-29 audit)', async () => {
    const first = launch({ before: { settings: {} } })
    expect(await first.api.initializeMachineBridge()).not.toBeNull()
    await first.hydrate(undefined)
    expect(first.savedSettings()).toBe('null')
    expect(first.firstConnectRecord()).toBeNull()
    await first.api.stopMachineBridge()

    const second = launch({ hostRoot: first.hostRoot })
    expect(await second.api.initializeMachineBridge(), 'second launch started the bridge').not.toBeNull()
    expect(second.spawned).toHaveLength(1)
    await second.api.stopMachineBridge()
  })

  it('hydration nulls the settings after a Connect with no port ever set: every later launch starts (fable 10-28 review)', async () => {
    const first = launch({ before: 'empty-folder' })
    expect(await first.api.initializeMachineBridge()).not.toBeNull()
    expect(await first.connect()).toMatchObject({ ok: true })
    expect(first.savedSettings()).toBe('{}')
    await first.api.stopMachineBridge()
    for (const name of ['second', 'third']) {
      const h = launch({ hostRoot: first.hostRoot })
      expect(await h.api.initializeMachineBridge(), `${name} launch started the bridge`).not.toBeNull()
      expect(h.spawned).toHaveLength(1)
      await h.hydrate(undefined)
      expect(h.savedSettings()).toBe('null')
      await h.api.stopMachineBridge()
    }
  })

  it('no port ever set and nothing saved (only the user-data folder): two consecutive launches both start', async () => {
    const first = launch({ before: 'empty-folder' })
    expect(await first.api.initializeMachineBridge()).not.toBeNull()
    expect(first.spawned).toHaveLength(1)
    await first.hydrate(undefined)
    await first.api.stopMachineBridge()
    const second = launch({ hostRoot: first.hostRoot })
    expect(await second.api.initializeMachineBridge()).not.toBeNull()
    expect(second.spawned).toHaveLength(1)
    await second.api.stopMachineBridge()
  })

  it('saved settings that hydration rewrites to null on every launch: launch after launch still starts', async () => {
    const first = launch({ before: { settings: null } })
    expect(await first.api.initializeMachineBridge()).not.toBeNull()
    await first.api.stopMachineBridge()
    const second = launch({ hostRoot: first.hostRoot })
    expect(await second.api.initializeMachineBridge()).not.toBeNull()
    await second.hydrate(undefined)
    await second.api.stopMachineBridge()
    const third = launch({ hostRoot: first.hostRoot })
    expect(await third.api.initializeMachineBridge()).not.toBeNull()
    await third.api.stopMachineBridge()
  })

  it('after an update: resumeAfterUpdate starts the bridge again (first audit\'s resume route, existing install)', async () => {
    const h = launch({ before: 'empty-folder' })
    expect(await h.api.initializeMachineBridge()).not.toBeNull()
    await h.failedUpdate()
    expect(h.spawned).toHaveLength(2)
    await h.api.stopMachineBridge()
  })

  it('Windows: a computer that never ran LienCAM launches exactly as one that did, and nothing is recorded', async () => {
    const env = { LIENCAM_UCCNC_SEARCH_ROOT: posix.join(root, 'uccnc') }
    const fresh = launch({ platform: 'win32', before: 'nothing', env })
    const existing = launch({ platform: 'win32', before: 'empty-folder', env })
    const freshStart = await fresh.api.initializeMachineBridge()
    const existingStart = await existing.api.initializeMachineBridge()
    expect(freshStart === null).toBe(existingStart === null)
    expect(fresh.spawned).toEqual(existing.spawned)
    expect(fresh.api.machineBridgeStatus().setup).toEqual(existing.api.machineBridgeStatus().setup)
    expect(await fresh.connect()).toEqual(await existing.connect())
    await fresh.writes()
    expect(fresh.firstConnectRecord()).toBeNull()
  })
})

// The astra 10-29 audit: opening Control (useMachineDefinitionPanel.tsx, the
// mode-tab click and first mount) calls ensureBridgeForControl() with no press.
// The renderer is the production module on the preload above; only the
// controller kind is chosen (the operator picked the bridge).
function controlWindow(h: ReturnType<typeof launch>) {
  Object.assign(window, { liencamHost: h.preloadHost })
  useMachineControl.setState({ connectionKind: 'bridge' })
  useCamStore.setState({ consoleEvents: [] })
  return {
    errors: () => useCamStore.getState().consoleEvents.filter((event) => event.severity === 'error').map((event) => event.message),
    /** Opening Control: the automatic start, never a press. */
    openControl: () => ensureBridgeForControl(),
    /** ControlPage's hosted Connect press (onConnect). */
    pressConnect: () => prepareHostedBridgeForConnect(undefined),
    /** What opening Control sends main when it finds the bridge stopped (startBridge, no press). */
    openControlRequest: async () => {
      const restart = h.preloadHost.machineBridgeRestart as (settings?: unknown) => Promise<{ ok: boolean }>
      return restart(undefined)
    },
  }
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 100))

describe('WO-3290: opening Control is not Connect (astra 10-29 audit)', () => {
  afterEach(() => {
    Reflect.deleteProperty(window, 'liencamHost')
    useMachineControl.setState({ connectionKind: null })
  })

  it('a fresh install: opening Control starts nothing and records nothing; Connect starts it once and answers the open', async () => {
    const h = launch({ before: 'nothing' })
    expect(await h.api.initializeMachineBridge()).toBeNull()
    const renderer = controlWindow(h)
    let opened: boolean | null = null
    void renderer.openControl().then((ready) => { opened = ready })
    await settle()
    await h.writes()
    expect(h.spawned, 'opening Control started the bridge').toHaveLength(0)
    expect(h.firstConnectRecord(), 'opening Control recorded the first Connect').toBe('{"awaitingFirstConnect":true}')
    expect(opened).toBeNull()
    void renderer.openControl()
    await settle()
    expect(h.spawned).toHaveLength(0)

    expect(await renderer.pressConnect()).toMatchObject({ kind: 'started' })
    await settle()
    await h.writes()
    expect(h.spawned).toHaveLength(1)
    expect(h.firstConnectRecord()).toBe('{"awaitingFirstConnect":false}')
    expect(opened, 'the open is answered by the Connect it waited for').toBe(true)
    expect(renderer.errors()).toEqual([])
    await h.api.stopMachineBridge()
  })

  it('a fresh install opened Control and closed before Connect: the next launch still waits through Control opens', async () => {
    const first = launch({ before: 'nothing' })
    expect(await first.api.initializeMachineBridge()).toBeNull()
    // This window closes with its open unanswered (the app quit before Connect).
    void controlWindow(first).openControlRequest()
    await settle()
    await first.writes()
    expect(first.spawned).toHaveLength(0)
    expect(first.firstConnectRecord()).toBe('{"awaitingFirstConnect":true}')

    const second = launch({ hostRoot: first.hostRoot })
    expect(await second.api.initializeMachineBridge(), 'launch after a Control open, before any Connect').toBeNull()
    const renderer = controlWindow(second)
    let opened: boolean | null = null
    void renderer.openControl().then((ready) => { opened = ready })
    await settle()
    await second.writes()
    expect(second.spawned, 'second launch: opening Control started the bridge').toHaveLength(0)
    expect(second.firstConnectRecord()).toBe('{"awaitingFirstConnect":true}')
    expect(await renderer.pressConnect()).toMatchObject({ kind: 'started' })
    await settle()
    expect(second.spawned).toHaveLength(1)
    expect(opened).toBe(true)
    await second.api.stopMachineBridge()

    const third = launch({ hostRoot: first.hostRoot })
    expect(await third.api.initializeMachineBridge(), 'launch after Connect').not.toBeNull()
    await third.api.stopMachineBridge()
  })

  it('an existing install: opening Control finds the launch-started bridge, and its stopped-bridge request restarts it as main does', async () => {
    const h = launch({ before: 'empty-folder' })
    expect(await h.api.initializeMachineBridge()).not.toBeNull()
    const renderer = controlWindow(h)
    expect(await renderer.openControl()).toBe(true)
    expect(h.spawned).toHaveLength(1)
    expect(await renderer.openControlRequest()).toMatchObject({ ok: true })
    expect(h.spawned).toHaveLength(2)
    expect(renderer.errors()).toEqual([])
    await h.writes()
    expect(h.firstConnectRecord()).toBeNull()
    await h.api.stopMachineBridge()
  })
})
