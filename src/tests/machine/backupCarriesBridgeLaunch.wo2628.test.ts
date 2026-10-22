// @vitest-environment jsdom

// WO-2628 (Operator ruling 2026-10-06: "I better not be hand editing bat files. And is
// there any reason a backup cannot carry some of this"). The machine
// connection's launch settings - UCCNC folder, profile, board, spindle file
// and the Bridge port - must survive backup -> new PC -> Restore bundle, and
// the installed app started from its own shortcut (no LIENCAM_BRIDGE_*
// environment, no .bat) must launch the managed connection from them.
//
// Every hop is production code: the uiPrefs store actions write the record,
// createShopDataBackup / restoreShopDataBackup move it, a fresh module graph
// (the page reload) runs the boot supply over the preload's
// `liencam:machine-bridge-ready` channel into electron/main.cjs, and a second
// main.cjs instance runs its real app-ready path against the same userData.

import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { electronMainRequire } from '../support/electronMainRequire'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import vm from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (key) => mem.get(key) ?? null,
  key: (index) => [...mem.keys()][index] ?? null,
  removeItem: (key) => { mem.delete(key) },
  setItem: (key, value) => { mem.set(key, String(value)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

const RM_OPTIONS = { recursive: true, force: true, maxRetries: 10, retryDelay: 100 } as const
const BRIDGE_ENV = ['LIENCAM_BRIDGE_EXECUTABLE', 'LIENCAM_BRIDGE_ARGS_JSON'] as const

interface Fixture {
  root: string
  resources: string
  installRoot: string
  compiler: string
  oldPcUserData: string
  newPcUserData: string
}

function createFixture(): Fixture {
  const root = mkdtempSync(path.join(os.tmpdir(), 'liencam-wo2628-'))
  const resources = path.join(root, 'resources')
  const installRoot = path.join(root, 'UCCNC12115')
  const sources = path.join(resources, 'pendant', 'uccnc-bridge')
  const wrapper = path.join(installRoot, 'API', 'Interface')
  mkdirSync(sources, { recursive: true })
  mkdirSync(wrapper, { recursive: true })
  for (const name of ['Bridge.cs', 'Machine.cs', 'Json.cs', 'Vfd.cs']) {
    writeFileSync(path.join(sources, name), `// bundled ${name}\n`)
  }
  writeFileSync(path.join(wrapper, 'UC100_wrapper.cs'), '// vendor wrapper\n')
  const compiler = path.join(root, 'csc.exe')
  writeFileSync(compiler, 'fake compiler')
  const oldPcUserData = path.join(root, 'old-pc')
  const newPcUserData = path.join(root, 'new-pc')
  mkdirSync(oldPcUserData)
  mkdirSync(newPcUserData)
  return { root, resources, installRoot, compiler, oldPcUserData, newPcUserData }
}

interface FakeChild extends EventEmitter {
  pid: number
  exitCode: number | null
  stdout: EventEmitter
  stderr: EventEmitter
  kill: () => boolean
}

function fakeChild(pid: number): FakeChild {
  const child = new EventEmitter() as FakeChild
  child.pid = pid
  child.exitCode = null
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = () => {
    if (child.exitCode === null) {
      child.exitCode = 0
      setImmediate(() => child.emit('exit', 0, null))
    }
    return true
  }
  return child
}

interface MainApi {
  machineBridgeStatus: () => { configured: boolean; overrides?: { executable: boolean; args: boolean } }
  stopMachineBridge: () => Promise<boolean>
}

interface MainHarness {
  api: MainApi
  ipcOn: Map<string, (event: unknown, ...args: unknown[]) => void>
  ready: () => Promise<void>
  bridgeLaunches: Array<{ executable: string; args: string[]; env: NodeJS.ProcessEnv }>
  warnings: ReturnType<typeof vi.fn>
}

/** One Electron main process: the desktop host as an installed app runs it. */
function loadMain(
  fixture: Fixture,
  userData: string,
  { platform = 'win32', env = {} }: { platform?: string; env?: Record<string, string> } = {},
): MainHarness {
  const ipcOn = new Map<string, (event: unknown, ...args: unknown[]) => void>()
  const bridgeLaunches: MainHarness['bridgeLaunches'] = []
  const warnings = vi.fn()
  let readyCallback: (() => Promise<void>) | null = null
  let nextPid = 4000
  class FakeWindow extends EventEmitter {
    static getAllWindows = () => []
    webContents = { setWindowOpenHandler: vi.fn(), on: vi.fn() }
    show = vi.fn()
    loadURL = vi.fn(async () => {})
  }
  const electron = {
    app: {
      isPackaged: true,
      getPath: (name: string) => name === 'userData' ? userData : fixture.root,
      setPath: vi.fn(),
      on: vi.fn(),
      quit: vi.fn(),
      whenReady: () => ({ then: (callback: () => Promise<void>) => { readyCallback = callback } }),
    },
    BrowserWindow: FakeWindow,
    dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
    ipcMain: {
      handle: vi.fn(),
      on: (channel: string, listener: (event: unknown, ...args: unknown[]) => void) => {
        ipcOn.set(channel, listener)
      },
    },
    Menu: { setApplicationMenu: vi.fn() },
    powerSaveBlocker: { isStarted: vi.fn(() => false), start: vi.fn(() => 1), stop: vi.fn() },
    protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
    screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 } }) },
  }
  // The operator's PC: nothing but what Windows and the installer provide.
  const cleanEnv: NodeJS.ProcessEnv = { ...process.env }
  for (const name of BRIDGE_ENV) delete cleanEnv[name]
  delete cleanEnv.LIENCAM_USER_DATA_DIR
  delete cleanEnv.LIENCAM_UCCNC_SEARCH_ROOT
  delete cleanEnv.LIENCAM_EVIDENCE_TRACE
  const processValue = {
    ...process,
    argv: [],
    // The compiler location is the only test seam: the real one is the
    // .NET Framework csc.exe Windows ships, which this test does not run.
    env: { ...cleanEnv, LIENCAM_CSC_EXECUTABLE: fixture.compiler, ...env },
    platform,
    resourcesPath: fixture.resources,
  }
  const spawn = (executable: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
    const child = fakeChild(nextPid++)
    const out = args.find((arg) => arg.startsWith('/out:'))
    if (out !== undefined) {
      writeFileSync(out.slice('/out:'.length), 'MZ fake managed bridge')
      setImmediate(() => {
        child.exitCode = 0
        child.emit('exit', 0, null)
      })
    } else {
      bridgeLaunches.push({ executable, args, env: options.env ?? {} })
    }
    return child
  }
  const moduleValue = { exports: {} as MainApi }
  const realRequire = electronMainRequire
  vm.runInNewContext(readFileSync(path.resolve('electron/main.cjs'), 'utf8'), {
    AbortSignal, Buffer, Date, Promise, Response, URL,
    __dirname: path.resolve('electron'),
    clearTimeout,
    console: { error: vi.fn(), info: vi.fn(), log: vi.fn(), warn: warnings },
    exports: moduleValue.exports,
    fetch,
    module: moduleValue,
    process: processValue,
    queueMicrotask,
    require: (id: string) => {
      if (id === 'electron') return electron
      if (id === 'node:child_process') return { spawn, execFile: vi.fn() }
      return realRequire(id)
    },
    setImmediate,
    setTimeout,
  })
  return {
    api: moduleValue.exports,
    ipcOn,
    ready: async () => {
      if (readyCallback === null) throw new Error('main.cjs registered no app-ready path')
      await readyCallback()
    },
    bridgeLaunches,
    warnings,
  }
}

async function until<T>(read: () => T | undefined | null | false, what: string): Promise<T> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const value = read()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`timed out waiting for ${what}`)
}

/** A file the host is still writing reads as not-yet-there. */
function readJson(filePath: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

/** The preload's bridge (electron/preload.cjs) wired to one main process. */
function installHost(main: MainHarness): void {
  const send = (channel: string) => (settings: unknown) => {
    const listener = main.ipcOn.get(channel)
    if (listener === undefined) throw new Error(`main.cjs does not listen on ${channel}`)
    listener({ sender: null }, settings)
  }
  Object.defineProperty(globalThis, 'liencamHost', {
    configurable: true,
    value: {
      machineBridgeReady: send('liencam:machine-bridge-ready'),
      machineBridgeRemember: send('liencam:machine-bridge-remember'),
    },
  })
}

let fixture: Fixture | null = null

afterEach(async () => {
  Reflect.deleteProperty(globalThis, 'liencamHost')
  mem.clear()
  vi.resetModules()
  if (fixture !== null) await rm(fixture.root, RM_OPTIONS)
  fixture = null
})

describe('WO-2628 a reinstall reaches the machine with no hand-edited file', () => {
  it('backup -> new PC -> Restore bundle -> shortcut launch starts the bridge from the saved settings', async () => {
    fixture = createFixture()
    const profile = 'C:/UCCNC12115/Profiles/LienCNCV2.pro'
    const vfdDefinition = 'C:/LienCAM/huanyang-gt.json'
    const bridgePort = 18_325

    // ---- The old PC: the operator set the connection up on the Machine page.
    vi.resetModules()
    const oldPc = loadMain(fixture, fixture.oldPcUserData, { platform: 'linux' })
    const oldStore = await import('../../store')
    const { useUiPrefs: oldPrefs, supplyMachineBridgeSettingsOnBoot: oldBoot } = await import('../../store/uiPrefs')
    const storage = await import('../../store/userSpaceStorage')
    installHost(oldPc)
    await oldBoot()
    const machineId = oldStore.controlMachine(oldStore.useCamStore.getState()).id
    oldPrefs.getState().setMachineBridgeLaunchSetting(machineId, 'installRoot', fixture.installRoot)
    oldPrefs.getState().setMachineBridgeLaunchSetting(machineId, 'profile', profile)
    oldPrefs.getState().setMachineBridgeLaunchSetting(machineId, 'board', 1)
    oldPrefs.getState().setMachineBridgeLaunchSetting(machineId, 'vfdDefinition', vfdDefinition)
    oldPrefs.getState().setMachineBridgePort(machineId, bridgePort)

    const backup = await storage.createShopDataBackup({ durableStorage: null })
    const bundle = JSON.parse(backup.text) as { content: { localRecords: Record<string, string> } }
    const carried = JSON.parse(bundle.content.localRecords['liencam-ui-prefs']) as {
      state: { machineLinks: Record<string, unknown> }
    }
    expect(carried.state.machineLinks[machineId]).toEqual({
      installRoot: fixture.installRoot, profile, board: 1, vfdDefinition, bridgePort,
    })

    // ---- The new PC: a fresh install, nothing in browser storage or userData.
    mem.clear()
    Reflect.deleteProperty(globalThis, 'liencamHost')
    await storage.restoreShopDataBackup(backup.text, { durableStorage: null })

    // Restore reloads the page. The reloaded page's boot supplies the restored
    // record to the desktop host through the existing settings path.
    // (The module's own boot call runs before vitest finishes the store's
    // import cycle, so the test makes that same call once the graph is loaded,
    // which is the order the bundled app already guarantees.)
    const newPc = loadMain(fixture, fixture.newPcUserData, { platform: 'linux' })
    vi.resetModules()
    const newStore = await import('../../store')
    const { supplyMachineBridgeSettingsOnBoot: newBoot } = await import('../../store/uiPrefs')
    installHost(newPc)
    await newBoot()
    expect(newStore.controlMachine(newStore.useCamStore.getState()).id).toBe(machineId)
    const mirror = path.join(fixture.newPcUserData, 'machine-bridge-launch-settings.json')
    const written = await until(
      () => readJson(mirror),
      'the restored settings to reach Electron userData',
    )
    expect(written).toEqual({
      installRoot: fixture.installRoot, profile, board: 1, vfdDefinition, bridgePort,
    })

    // ---- The operator closes LienCAM and opens it from its own shortcut.
    const relaunch = loadMain(fixture, fixture.newPcUserData)
    await relaunch.ready()
    const launch = await until(() => relaunch.bridgeLaunches[0], 'the managed bridge launch')
    try {
      expect(launch.executable).toBe(path.join(fixture.newPcUserData, 'machine-bridge', 'liencam-bridge.exe'))
      expect(launch.args).toEqual([
        '--install-root', fixture.installRoot,
        '--profile', profile,
        '--board', '1',
        '--vfd', vfdDefinition,
        '--port', String(bridgePort),
      ])
      for (const name of BRIDGE_ENV) expect(launch.env[name]).toBeUndefined()
      expect(relaunch.api.machineBridgeStatus()).toMatchObject({
        configured: true,
        overrides: { executable: false, args: false },
      })
      expect(relaunch.warnings.mock.calls.flat().join(' ')).not.toContain('Developer override')
    } finally {
      await relaunch.api.stopMachineBridge()
    }
  }, 30_000)

  it('names a developer override in force instead of running it silently', async () => {
    fixture = createFixture()
    const args = JSON.stringify(['--board', '-19'])
    const main = loadMain(fixture, fixture.newPcUserData, {
      env: { LIENCAM_BRIDGE_ARGS_JSON: args, LIENCAM_UCCNC_SEARCH_ROOT: fixture.root },
    })
    await main.ready()
    try {
      expect(main.api.machineBridgeStatus().overrides).toEqual({ executable: false, args: true })
      const warned = main.warnings.mock.calls.flat().join(' ')
      expect(warned).toContain('Developer override in force: LIENCAM_BRIDGE_ARGS_JSON replaces')
      expect(warned).toContain('Start LienCAM from its own shortcut')
    } finally {
      await main.api.stopMachineBridge()
    }
  })
})

describe('WO-2628 Help: moving LienCAM to a new or rebuilt PC', () => {
  it('gives the steps with no AI help and names the two things a backup cannot carry, with why', async () => {
    const { topics } = await import('../../help/topics/machine')
    const topic = topics.find((candidate) => candidate.id === 'moving-to-a-new-pc')
    expect(topic?.title).toBe('Moving LienCAM to a new or rebuilt PC')
    const prose = topic!.sections.flatMap((section) =>
      'text' in section ? [section.text] : section.kind === 'steps' ? section.steps : [],
    ).join(' ')
    for (const step of [
      'run the LienCAM installer',
      'Install UCCNC 1.2115 with its own installer',
      'Copy your UCCNC profile (.pro file)',
      'Click Inspect backup... and pick your backup file',
      'click Confirm restore',
      'On the Control tab, click Connect',
      'no .bat file and no environment variable',
      'Bridge port',
    ]) expect(prose).toContain(step)
    expect(prose).toContain('What a backup cannot carry, and why')
    // (a) the controller vendor's own software, drivers and profile.
    expect(prose).toContain("another company's licensed software, put in place by its own installer")
    expect(prose).toContain('it does not keep a copy of the .pro file')
    // (b) the antivirus exclusion.
    expect(prose).toContain('administrator setting of Windows itself, and no app can grant itself one')
    expect(prose).toContain(String.raw`%APPDATA%\LienCAM\machine-bridge`)
  })
})
