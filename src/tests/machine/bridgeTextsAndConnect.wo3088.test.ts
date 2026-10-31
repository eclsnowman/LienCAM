// @vitest-environment jsdom
// WO-3088: bridge texts and Connect behaviour - the alpha.3.1 findings 8, 9,
// 16, 18 and 19, each through the production code it was seen in. Finding 15
// moved to WO-3290 (launch is pinned to main's here); 17 moved to WO-3277.
import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as fsPromises from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { electronMainRequire } from '../support/electronMainRequire'
import type { BridgeCallMessage, BridgeDefinitionSource, BridgeTransportEvents } from '../../lib/machine/bridgeTransport'
import { typedMock } from '../support/typedMock'

// The bridge socket, faked at the transport: hello, and a reply to every
// applyMachineDefinition. Everything above it is the production session.
const bridgeFixture = vi.hoisted(() => ({
  source: 'none' as BridgeDefinitionSource,
  events: null as BridgeTransportEvents | null,
  sent: [] as BridgeCallMessage[],
}))
vi.mock('../../lib/machine/bridgeTransport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/bridgeTransport')>()
  class SessionTransport extends actual.BridgeTransport {
    static isSupported(): boolean { return true }
    async start(events: BridgeTransportEvents): Promise<void> {
      bridgeFixture.events = events
      events.onMessage({ t: 'hello', v: {
        protocol: 1, bridge: 'liencam-uccnc-bridge/WO-3088', readOnly: false,
        capabilities: { geometryQueue: true, executingMoveId: true, bufferSeconds: true, gcodeText: false,
          perAxisHoming: true, ownsSpindle: false, spindleCommands: false },
        definitionSource: bridgeFixture.source, definitionDrift: [],
      } })
    }
    send(message: BridgeCallMessage): void {
      bridgeFixture.sent.push(message)
      if (message.m !== 'applyMachineDefinition') return
      void Promise.resolve().then(() => bridgeFixture.events?.onMessage({ t: 'reply', seq: message.seq, ok: true,
        v: { ok: true, error: null, configuredThisSession: true, reHome: [], lines: [] } }))
    }
    async close(): Promise<void> { bridgeFixture.events = null }
  }
  return typedMock<typeof import('../../lib/machine/bridgeTransport')>({ ...actual, BridgeTransport: SessionTransport })
})

const machineSource = readFileSync('pendant/uccnc-bridge/Machine.cs', 'utf8').replace(/\r\n/g, '\n')
const bridgeSource = readFileSync('pendant/uccnc-bridge/Bridge.cs', 'utf8').replace(/\r\n/g, '\n')

function region(source: string, name: string): string {
  const begin = source.indexOf(`// BEGIN ${name}`)
  const end = source.indexOf(`// END ${name}`)
  if (begin < 0 || end < begin) throw new Error(`${name} seam is missing`)
  return source.slice(begin + `// BEGIN ${name}`.length, end)
}

// ---- a C# compiler: csc.exe on a Windows desk, the .NET SDK's csc on Linux ----
const WINDOWS_CSC = path.join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')

function dotnetCompiler(): { dotnet: string; csc: string; refs: string[]; runtime: string } | null {
  const roots = [process.env.DOTNET_ROOT, path.join(homedir(), '.dotnet'), '/usr/share/dotnet', '/usr/lib/dotnet']
  for (const root of roots) {
    if (!root || !existsSync(path.join(root, 'dotnet'))) continue
    const newest = (dir: string) => existsSync(dir) ? readdirSync(dir).sort().reverse()[0] ?? null : null
    const sdk = newest(path.join(root, 'sdk'))
    const pack = newest(path.join(root, 'packs', 'Microsoft.NETCore.App.Ref'))
    const runtime = newest(path.join(root, 'shared', 'Microsoft.NETCore.App'))
    if (!sdk || !pack || !runtime) continue
    const csc = path.join(root, 'sdk', sdk, 'Roslyn', 'bincore', 'csc.dll')
    const refDir = path.join(root, 'packs', 'Microsoft.NETCore.App.Ref', pack, 'ref')
    const tfm = existsSync(refDir) ? readdirSync(refDir)[0] : undefined
    if (!existsSync(csc) || !tfm) continue
    const refs = readdirSync(path.join(refDir, tfm)).filter((f) => f.endsWith('.dll')).map((f) => path.join(refDir, tfm, f))
    return { dotnet: path.join(root, 'dotnet'), csc, refs, runtime }
  }
  return null
}

const dotnet = process.platform === 'win32' ? null : dotnetCompiler()
const canCompile = existsSync(WINDOWS_CSC) || dotnet !== null

/** Compiles one harness and returns its stdout lines. `defines` reach both compilers. */
function runHarness(source: string, defines: string[] = []): string[] {
  const root = mkdtempSync(path.join(tmpdir(), 'liencam-wo3088-'))
  try {
    const file = path.join(root, 'Harness.cs')
    writeFileSync(file, source)
    if (dotnet === null) {
      const exe = path.join(root, 'Harness.exe')
      execFileSync(WINDOWS_CSC, ['/nologo', ...defines.map((d) => `/define:${d}`), `/out:${exe}`, file], { stdio: 'pipe' })
      return execFileSync(exe, { encoding: 'utf8' }).trim().split(/\r?\n/)
    }
    const dll = path.join(root, 'Harness.dll')
    execFileSync(dotnet.dotnet, [dotnet.csc, '-nologo', ...defines.map((d) => `-define:${d}`), `-out:${dll}`,
      ...dotnet.refs.map((r) => `-r:${r}`), file], { stdio: 'pipe' })
    writeFileSync(path.join(root, 'Harness.runtimeconfig.json'), JSON.stringify({ runtimeOptions: {
      tfm: 'net10.0', framework: { name: 'Microsoft.NETCore.App', version: dotnet.runtime } } }))
    return execFileSync(dotnet.dotnet, [dll], { encoding: 'utf8' }).trim().split(/\r?\n/)
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

// ---------------------------------------------------------------------------
// 8. GIVING UP names the board's real link
// ---------------------------------------------------------------------------
function givingUpHarness(expected: number): string {
  return `
using System;
using System.Collections.Generic;
namespace LienCAM {
${region(machineSource, 'WO-1306 CONTROLLER STARTUP WAIT')}
public static class Harness {
  public static void Main() {
    ControllerStartupWait.ExpectedDeviceType = ${expected};
    ControllerEnumeration last;
    ControllerStartupWait.UntilEnumerable("board 1",
      delegate { return new ControllerEnumeration(0, 0); },
      delegate(int ms) {},
      delegate(string line) { if (line.Contains("GIVING UP")) Console.WriteLine(line); },
      out last);
  }
}}
`
}

describe('WO-3088 item 8: GIVING UP names the board link', () => {
  it.skipIf(!canCompile)('an Ethernet board (AXBB-E) is pointed at its Ethernet cable and network, not USB', () => {
    const [line] = runHarness(givingUpHarness(19))
    expect(line).toContain('GIVING UP: controller board 1 did not become enumerable')
    expect(line).toContain('Check its power, its Ethernet cable and that this computer is on the controller\'s network')
    expect(line).not.toContain('USB')
  })

  it.skipIf(!canCompile)('a USB board (UC100) keeps the USB words; an unknown board names both cables', () => {
    expect(runHarness(givingUpHarness(1))[0]).toContain('Check its power and USB connection, then try Reconnect again.')
    expect(runHarness(givingUpHarness(-1))[0]).toContain('Check its power and its USB or Ethernet cable, then try Reconnect again.')
  })

  it.skipIf(!canCompile)('the native Linux bridge (Uc100Net, network only) always names Ethernet', () => {
    const [line] = runHarness(givingUpHarness(-1), ['UC100NET'])
    expect(line).toContain('its Ethernet cable')
    expect(line).not.toContain('USB')
  })

  it('production wiring: the bridge seeds the expectation from the last board, and each Open records its own', () => {
    const seed = bridgeSource.indexOf('ControllerStartupWait.ExpectedDeviceType = DllPin.LastConnectedDeviceType();')
    expect(seed).toBeGreaterThan(0)
    expect(seed).toBeLessThan(bridgeSource.indexOf('found = DiscoverBoard('))
    expect(machineSource).toContain('ControllerStartupWait.ExpectedDeviceType = type;')
    expect(machineSource).toContain('+ last.Count + " device(s). " + CheckAdvice(ExpectedDeviceType));')
    expect(machineSource).not.toContain('Check its power and USB connection, then try Reconnect again.");')
  })
})

// ---------------------------------------------------------------------------
// 9. homeBackOff prints 0, never -0
// ---------------------------------------------------------------------------
describe('WO-3088 item 9: a zero back-off prints as 0', () => {
  it.skipIf(!canCompile)('ConsoleNumber.Plain turns a negative zero into 0 and leaves real values alone', () => {
    const lines = runHarness(`
using System;
namespace LienCAM {
${region(machineSource, 'WO-3088 CONSOLE NUMBER')}
public static class Harness {
  public static void Main() {
    double negativeZero = -0.0;
    Console.WriteLine("raw homeBackOff=" + negativeZero);
    Console.WriteLine("plain homeBackOff=" + ConsoleNumber.Plain(negativeZero));
    Console.WriteLine("real homeBackOff=" + ConsoleNumber.Plain(-2.5) + "," + ConsoleNumber.Plain(3));
  }
}}
`)
    // The raw line is the defect on .NET (the native bridge); .NET Framework already printed 0.
    if (dotnet !== null) expect(lines[0]).toBe('raw homeBackOff=-0')
    expect(lines[1]).toBe('plain homeBackOff=0')
    expect(lines[2]).toBe('real homeBackOff=-2.5,3')
  })

  it('every homeBackOff the console prints goes through it (the five places named)', () => {
    const printed = machineSource.match(/homeBackOff=" \+ [^\n]*/g) ?? []
    expect(printed).toHaveLength(5)
    for (const line of printed) expect(line).toMatch(/^homeBackOff=" \+ ConsoleNumber\.Plain\(\w+\.HomeBackOff\)/)
  })
})

// ---------------------------------------------------------------------------
// electron/main.cjs in a VM - the WO-3072 harness shape, only the OS faked
// ---------------------------------------------------------------------------
class Child extends EventEmitter {
  pid = 3088
  exitCode: number | null = null
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  kill = vi.fn(() => { void Promise.resolve().then(() => { this.exitCode = 0; this.emit('exit', 0, null) }); return true })
}
interface MainApi {
  initializeMachineBridge(): Promise<Child | null>
  restartMachineBridge(settings?: object, options?: { operatorPress?: boolean }): Promise<{ ok: boolean; reason?: string }>
  machineBridgeStatus(): { configured: boolean; running: boolean; setup: { state: string; lookedFor: string | null } }
  stopMachineBridge(): Promise<boolean>
}
const posix = path.posix
const hostRoots: string[] = []
afterEach(() => { for (const root of hostRoots.splice(0)) rmSync(root, { recursive: true, force: true }) })

// hostRoot: launch again on the same computer (its user data kept from before).
function mainHarness(options: { platform: 'linux' | 'win32'; settings?: object | null; env?: Record<string, string>; hostRoot?: string }) {
  const relaunch = options.hostRoot !== undefined
  const hostRoot = options.hostRoot ?? mkdtempSync(path.join(tmpdir(), 'liencam-wo3088-main-'))
  if (!relaunch) hostRoots.push(hostRoot)
  const root = '/liencam-wo3088'
  const touched: string[] = []
  const hostPath = (value: string) => {
    touched.push(value)
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
  const userData = posix.join(root, 'user-data')
  const native = posix.join(resources, 'pendant', 'uccnc-bridge', 'native', 'linux-x64', 'liencam-bridge')
  disk.mkdirSync(posix.dirname(native), { recursive: true })
  disk.writeFileSync(native, 'native executable')
  disk.writeFileSync(posix.join(posix.dirname(native), 'liencam-bridge.dll'), 'native assembly')
  disk.mkdirSync(userData, { recursive: true })
  const settingsFile = posix.join(userData, 'machine-bridge-launch-settings.json')
  if (!relaunch && options.settings !== null) disk.writeFileSync(settingsFile, JSON.stringify(options.settings ?? { board: 'auto' }))
  const spawned: Array<{ executable: string; args: string[] }> = []
  const processValue = { ...process, platform: options.platform, arch: 'x64', argv: [], resourcesPath: resources,
    env: { ...process.env, LIENCAM_BRIDGE_EXECUTABLE: '', LIENCAM_BRIDGE_ARGS_JSON: '', LIENCAM_USER_DATA_DIR: '',
      LIENCAM_BRIDGE_NATIVE: '', LIENCAM_BRIDGE_WINE: '', WINEPREFIX: '', LIENCAM_UCCNC_SEARCH_ROOT: undefined, ...options.env } }
  const app = { isPackaged: true, getPath: () => userData, on: vi.fn(), quit: vi.fn(), whenReady: () => ({ then: () => Promise.resolve() }) }
  const module = { exports: {} as MainApi }
  const warnings: string[] = []
  const ipcMain = { handle: vi.fn(), on: vi.fn() }
  const context = vm.createContext({ module, exports: module.exports, process: processValue, __dirname: posix.join(resources, 'electron'),
    AbortSignal, Buffer, Date, Promise, Response, URL, clearTimeout, setTimeout, queueMicrotask, fetch,
    console: { ...console, warn: (...a: unknown[]) => warnings.push(a.join(' ')), error: vi.fn(), info: vi.fn() },
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
  vm.runInContext('machineBridgeLaunchSettings = readMachineBridgeLaunchSettings()', context)
  return { api: module.exports, spawned, touched, warnings, hostRoot, settingsExists: () => disk.existsSync(settingsFile),
    savedSettings: () => disk.readFileSync(settingsFile, 'utf8'),
    // The handler main.cjs registered for a channel, as the renderer's send reaches it.
    ipcOn: (channel: string) => ipcMain.on.mock.calls.find((call) => call[0] === channel)?.[1] as (event: object, settings: unknown) => void,
    // Pending launch-settings writes.
    writes: () => vm.runInContext('machineBridgeSettingsWriteChain', context) as Promise<void>,
    run: (code: string): unknown => vm.runInContext(code, context) }
}

// ---------------------------------------------------------------------------
// 15. Moved to WO-3290 (architect 2026-10-29 12:40 AM CT). Linux launch is
// main's: every launch sequence the three judges used starts the bridge.
// ---------------------------------------------------------------------------
describe('WO-3088 item 15 (moved to WO-3290): every Linux launch starts the bridge as on main', () => {
  // Boot hydration (uiPrefs supplyMachineBridgeSettingsOnBoot -> liencam:machine-bridge-ready)
  // sends machineLinks[machineId], undefined until a port is set, and main saves
  // that as null launch settings. Let its async body and write settle.
  async function hydrateWithNoLink(h: ReturnType<typeof mainHarness>) {
    h.ipcOn('liencam:machine-bridge-ready')({ sender: null }, undefined)
    await new Promise((resolve) => setTimeout(resolve, 100))
    await h.writes()
  }

  it('a fresh install (nothing saved) starts the bridge at launch; Connect restarts it', async () => {
    const h = mainHarness({ platform: 'linux', settings: null })
    expect(await h.api.initializeMachineBridge()).not.toBeNull()
    expect(h.spawned).toHaveLength(1)
    expect(h.spawned[0].args).toEqual(['--board', 'auto'])
    expect(await h.api.restartMachineBridge({ board: 'auto' }, { operatorPress: true })).toMatchObject({ ok: true })
    expect(h.spawned).toHaveLength(2)
    await h.api.stopMachineBridge()
  })

  it('a failed update\'s resume (resumeAfterUpdate) starts the bridge again on a fresh install', async () => {
    const h = mainHarness({ platform: 'linux', settings: null })
    expect(await h.api.initializeMachineBridge()).not.toBeNull()
    // The update's shutdown stops the bridge; resumeAfterUpdate is fire-and-forget.
    await h.api.stopMachineBridge()
    h.run('resumeAfterUpdate()')
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(h.spawned).toHaveLength(2)
    await h.api.stopMachineBridge()
  })

  it('Connect pressed, no port ever set: every later launch starts the bridge after hydration saved no link', async () => {
    const first = mainHarness({ platform: 'linux', settings: null })
    expect(await first.api.initializeMachineBridge()).not.toBeNull()
    expect(await first.api.restartMachineBridge(undefined, { operatorPress: true })).toMatchObject({ ok: true })
    await first.writes()
    await first.api.stopMachineBridge()
    for (const launch of ['second', 'third']) {
      const h = mainHarness({ platform: 'linux', hostRoot: first.hostRoot })
      expect(await h.api.initializeMachineBridge(), `${launch} launch started the bridge`).not.toBeNull()
      expect(h.spawned, `${launch} launch spawned`).toHaveLength(1)
      await hydrateWithNoLink(h)
      expect(h.savedSettings()).toBe('null')
      await h.api.stopMachineBridge()
    }
  })

  it('a computer set up by an earlier build (settings saved) still starts the bridge after hydration saved no link', async () => {
    const first = mainHarness({ platform: 'linux', settings: {} })
    expect(await first.api.initializeMachineBridge()).not.toBeNull()
    await hydrateWithNoLink(first)
    expect(first.savedSettings()).toBe('null')
    await first.api.stopMachineBridge()

    const second = mainHarness({ platform: 'linux', hostRoot: first.hostRoot })
    expect(await second.api.initializeMachineBridge(), 'second launch started the bridge').not.toBeNull()
    expect(second.spawned).toHaveLength(1)
    await second.api.stopMachineBridge()
  })

})

// ---------------------------------------------------------------------------
// 19. An empty LIENCAM_UCCNC_SEARCH_ROOT searches nowhere, never C:\
// ---------------------------------------------------------------------------
describe('WO-3088 item 19: an empty search root does not fall back to C:\\', () => {
  it('set but empty: nothing is searched and the setup says where it looked', async () => {
    const h = mainHarness({ platform: 'win32', settings: {}, env: { LIENCAM_UCCNC_SEARCH_ROOT: '' } })
    expect(await h.api.initializeMachineBridge()).toBeNull()
    expect(h.touched.filter((p) => /^C:/i.test(p))).toEqual([])
    expect(h.api.machineBridgeStatus().setup).toMatchObject({
      state: 'missing-install', lookedFor: 'nowhere (LIENCAM_UCCNC_SEARCH_ROOT is set but empty)',
    })
    expect(h.spawned).toHaveLength(0)
  })

  it('unset: the installed app still searches C:\\ for UCCNC', async () => {
    const h = mainHarness({ platform: 'win32', settings: {} })
    expect(await h.api.initializeMachineBridge()).toBeNull()
    expect(h.touched).toContain('C:\\')
    expect(h.api.machineBridgeStatus().setup.lookedFor).toBe(posix.join('C:\\', 'UCCNC*'))
  })
})

// ---------------------------------------------------------------------------
// 16. Connect sends the machine definition on a fresh install
// ---------------------------------------------------------------------------
describe('WO-3088 item 16: Connect sends the definition a fresh bridge does not hold', () => {
  async function connectWith(source: BridgeDefinitionSource, withDefinition: boolean) {
    const session = await import('../../lib/machine/machineSession')
    const { useCamStore } = await import('../../store')
    const { useMachineControl } = await import('../../store/machineControlStore')
    const { importUccncProfile } = await import('../../lib/machine/uccncProfileImport')
    const definition = importUccncProfile(readFileSync('docs/machine/profiles/LienCNCV2.pro', 'utf8')).definition
    if (!definition) throw new Error('the LienCNC V2 profile did not import')
    useCamStore.getState().newProject()
    useCamStore.setState((state) => ({ project: { ...state.project, machine: { ...state.project.machine, controller: 'uccnc',
      ...(withDefinition ? { controllerDefinition: definition } : {}) } } }))
    useMachineControl.setState({ consoleLines: [] })
    bridgeFixture.source = source
    bridgeFixture.sent = []
    await session.connectMachine('bridge')
    await vi.waitFor(() => {
      if (withDefinition && source !== 'cache-baseline') expect(useMachineControl.getState().consoleLines.map((l) => l.text).join('\n')).toContain('Machine definition applied')
    })
    const lines = useMachineControl.getState().consoleLines.map((l) => l.text)
    const applies = bridgeFixture.sent.filter((m) => m.m === 'applyMachineDefinition')
    await session.disconnectMachine()
    return { lines, applies, definition }
  }

  it('a bridge holding none (native Linux, nothing cached) is sent this machine\'s definition, and says so', async () => {
    const { lines, applies, definition } = await connectWith('none', true)
    expect(applies).toHaveLength(1)
    expect((applies[0].a as { definition: { axes: unknown } }).definition.axes).toEqual(definition.axes)
    expect(lines).toContain("The bridge holds no definition - Connect is sending this machine's definition.")
    expect(lines).toContain('Machine definition applied: the controller accepted and read back every value.')
    expect(lines).not.toContain('The bridge holds no definition - nothing configured; apply one.')
  })

  it('a first start configured from the .pro is sent the definition too, so this computer becomes the source', async () => {
    const { lines, applies } = await connectWith('profile', true)
    expect(applies).toHaveLength(1)
    expect(lines).toContain("Machine configured from the .pro, once - the first start under this bridge; Connect is sending this machine's definition to make this computer the source.")
  })

  it('a bridge already configured from this computer is not sent anything; with no definition nothing is sent', async () => {
    const cached = await connectWith('cache-baseline', true)
    expect(cached.applies).toHaveLength(0)
    expect(cached.lines).toContain("Machine configured from this computer's data (the .pro was not opened).")
    const none = await connectWith('none', false)
    expect(none.applies).toHaveLength(0)
    expect(none.lines).toContain('The bridge holds no definition - nothing configured; apply one.')
  })
})

// ---------------------------------------------------------------------------
// 16 (audit fix). Connect's send keeps the operator's edits across a restart
// ---------------------------------------------------------------------------
// The bridge caches exactly the provenance map an apply sends (Machine.cs
// SaveDefinitionCache) and, at its next start, puts back to the imported
// settings every value that differs and is not in that map (RecordDrift).
// The app's two Connect frames go through the REAL bridge: its own
// ApplyDefinition entry on a fresh process, then a restart from the cache it
// wrote (Machine.Open -> ApplyCachedDefinition -> ReconcileCacheWithProfile),
// against the fake board WO-1326 compiles in place of CNCdrive's wrapper.
const BRIDGE_SOURCES = ['Bridge.cs', 'Machine.cs', 'Json.cs', 'Vfd.cs'].map((f) => path.join('pendant/uccnc-bridge', f))
const FAKE_BOARD = 'src/tests/evidence/WO-1326/FakeUC100.cs'

/** System.IO.Ports for the .NET SDK compile (the native build's NuGet package);
 *  .NET Framework's csc.exe has it in System.dll. */
function serialPortsAssembly(): string | null {
  const root = path.join(process.env.NUGET_PACKAGES ?? path.join(homedir(), '.nuget', 'packages'), 'system.io.ports')
  if (!existsSync(root)) return null
  for (const version of readdirSync(root).sort().reverse()) {
    const lib = path.join(root, version, 'lib')
    if (!existsSync(lib)) continue
    const tfm = readdirSync(lib).filter((t) => /^net\d+\.\d+$/.test(t)).sort((a, b) => parseFloat(b.slice(3)) - parseFloat(a.slice(3)))[0]
    const dll = tfm && path.join(lib, tfm, 'System.IO.Ports.dll')
    if (dll && existsSync(dll)) return dll
  }
  return null
}
const serialPorts = dotnet === null ? null : serialPortsAssembly()
const canCompileBridge = existsSync(WINDOWS_CSC) || serialPorts !== null

/** Compiles the shipping bridge with the fake board and a harness; `files` are
 *  written beside the program, where the bridge also keeps its cache. */
function runBridgeHarness(source: string, files: Record<string, string>): string[] {
  const root = mkdtempSync(path.join(tmpdir(), 'liencam-wo3088-bridge-'))
  try {
    const file = path.join(root, 'Harness.cs')
    writeFileSync(file, source)
    for (const [name, text] of Object.entries(files)) writeFileSync(path.join(root, name), text)
    // UC100 made partial, so the harness can add the calls the fake predates.
    const fakeBoard = path.join(root, 'FakeUC100.cs')
    writeFileSync(fakeBoard, readFileSync(FAKE_BOARD, 'utf8').replace(/public class UC100(\r?\n)/, 'public partial class UC100$1'))
    const inputs = [...BRIDGE_SOURCES.map((f) => path.resolve(f)), fakeBoard]
    const run = (command: string, args: string[]) => {
      try {
        return execFileSync(command, args, { encoding: 'utf8', stdio: 'pipe' })
      } catch (error) {
        const failed = error as { stdout?: string, stderr?: string }
        throw new Error(`${failed.stdout ?? ''}${failed.stderr ?? ''}`, { cause: error })
      }
    }
    if (dotnet === null) {
      const exe = path.join(root, 'Harness.exe')
      run(WINDOWS_CSC, ['/nologo', '/unsafe', '/main:LienCAM.Harness', `/out:${exe}`, ...inputs, file])
      return run(exe, []).trim().split(/\r?\n/)
    }
    const dll = path.join(root, 'Harness.dll')
    run(dotnet.dotnet, [dotnet.csc, '-nologo', '-unsafe', '-main:LienCAM.Harness', `-out:${dll}`,
      ...dotnet.refs.map((r) => `-r:${r}`), `-r:${serialPorts}`, ...inputs, file])
    writeFileSync(path.join(root, 'System.IO.Ports.dll'), readFileSync(serialPorts as string))
    writeFileSync(path.join(root, 'Harness.runtimeconfig.json'), JSON.stringify({ runtimeOptions: {
      tfm: 'net10.0', framework: { name: 'Microsoft.NETCore.App', version: dotnet.runtime } } }))
    return run(dotnet.dotnet, [dll]).trim().split(/\r?\n/)
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

// The imported LienCNC V2 definition states a charge pump, which the bridge
// applies only through the wrapper's two charge-pump calls; FakeUC100 predates
// them. Exactly those two calls, as unhomedBridgeStep.wo1790 adds them.
//
// Each route runs from no cache: a fresh process (start-up source none) is
// sent the Connect frame, then the reconnect frame, and is restarted. The
// harness prints what the restarted bridge decided for X acceleration, what
// the board then holds, and the authorship its cache keeps for that value.
const RESTART_HARNESS = `
using System;
using System.IO;
public partial class UC100 {
  static int pumpPin1, pumpPin2; static bool pumpNeg1, pumpNeg2, pumpAlwaysOn;
  public static int SetChargePumpSetting(int pin1, bool neg1, int pin2, bool neg2, bool alwaysOn) {
    pumpPin1 = pin1; pumpNeg1 = neg1; pumpPin2 = pin2; pumpNeg2 = neg2; pumpAlwaysOn = alwaysOn; return 0;
  }
  public static int GetChargePumpSetting(ref int pin1, ref bool neg1, ref int pin2, ref bool neg2, ref bool alwaysOn) {
    pin1 = pumpPin1; neg1 = pumpNeg1; pin2 = pumpPin2; neg2 = pumpNeg2; alwaysOn = pumpAlwaysOn; return 0;
  }
}
namespace LienCAM {
public static class Harness {
  static string Here(string name) { return Path.Combine(AppDomain.CurrentDomain.BaseDirectory, name); }
  static T Quietly<T>(Func<T> body) {
    var priorOut = Console.Out;
    try { Console.SetOut(new StringWriter()); return body(); } finally { Console.SetOut(priorOut); }
  }
  static Machine OpenBridge(string label) {
    var machine = new Machine();
    bool opened = false;
    string refusal = null;
    bool ran = Quietly(delegate { return BoardOwner.Run(BoardOwner.Class.Normal, "opening " + label,
      delegate { opened = machine.Open(-19, null); }, 10000, out refusal); });
    Console.WriteLine(label + "-open=" + (ran && opened) + ",source=" + machine.DefinitionSourceLabel);
    return machine;
  }
  // The bridge's applyMachineDefinition case (Bridge.cs): parse the frame's
  // definition, pass its provenance through verbatim.
  static void Apply(Machine machine, string label) {
    object frame;
    if (!Json.TryParse(File.ReadAllText(Here(label + ".json")), out frame)) throw new Exception(label + " frame is not JSON");
    Machine.DefinitionPlan plan;
    string error;
    if (!Machine.ParseDefinition(Json.Get(frame, "definition"), out plan, out error)) throw new Exception(error);
    Machine.ApplyResult result = null;
    string refusal = null;
    Quietly(delegate { return BoardOwner.Run(BoardOwner.Class.Long, "applyMachineDefinition",
      delegate { result = machine.ApplyDefinition(plan, "the app", Json.Get(frame, "provenance")); }, 10000, out refusal); });
    Console.WriteLine(label + "-apply=" + (result != null && result.Ok));
    if (result == null) Console.WriteLine(label + "-said=" + refusal);
    else if (!result.Ok) Console.WriteLine(label + "-said=" + result.Error);
  }
  static void Run(string route) {
    File.Delete(Machine.DefinitionCachePath());
    FakeBoard.Reset();
    var bridge = OpenBridge(route + "-fresh");
    Apply(bridge, route + "-connect");
    Apply(bridge, route + "-reconnect");
    // The board keeps nothing across a close/open; the restarted bridge
    // configures it from its cache alone.
    FakeBoard.Reset();
    var restarted = OpenBridge(route + "-restart");
    foreach (Machine.DriftLine d in restarted.Drift)
      if (d.Key == "axes.X.acceleration")
        Console.WriteLine(route + "-drift=" + d.Cache + "->" + d.Profile + ",kept=" + d.Kept + ",kind=" + d.Kind + ",source=" + d.Source);
    UC100.AxisSetting x = new UC100.AxisSetting();
    x.Axis = 0;
    UC100.GetAxisSetting(ref x);
    Console.WriteLine(route + "-board-x-acceleration=" + x.MaxAccel);
    object cache;
    Json.TryParse(File.ReadAllText(Machine.DefinitionCachePath()), out cache);
    object provenance = Json.Get(cache, "provenance");
    object one = provenance == null ? null : Json.Get(provenance, "axes.X.acceleration");
    Console.WriteLine(route + "-cache-authorship=" + (one == null ? "none" : Json.Str(one, "kind") + "," + Json.Str(one, "source")));
  }
  public static void Main() {
    BoardOwner.Start();
    Run("import");
    Run("control");
  }
}}
`

type ApplyFrame = { definition: { settings?: unknown[] }; provenance: Record<string, { kind: string; source: string }> }

describe('WO-3088 item 16: Connect\'s send keeps the operator\'s saved edits across a bridge restart', () => {
  afterEach(() => { vi.useRealTimers() })

  it.skipIf(!canCompileBridge)('Connect declares an edited X acceleration as the panel Apply does; after a restart the bridge keeps the value and its authorship', async () => {
    const session = await import('../../lib/machine/machineSession')
    const { useCamStore } = await import('../../store')
    const { useMachineControl } = await import('../../store/machineControlStore')
    const { importUccncProfile } = await import('../../lib/machine/uccncProfileImport')
    const imported = importUccncProfile(readFileSync('docs/machine/profiles/LienCNCV2.pro', 'utf8')).definition
    if (!imported) throw new Error('the LienCNC V2 profile did not import')
    const importedX = imported.axes.find((axis) => axis.axis === 'X')
    if (!importedX) throw new Error('the LienCNC V2 profile has no X axis')
    const editedAcceleration = importedX.acceleration + 250
    // The operator's edit, saved the way the definition panel's Save stores it,
    // to the library and the project alike.
    const saved = session.withMachineDefinitionProfileBaseline(imported, { ...imported,
      axes: imported.axes.map((axis) => axis.axis === 'X' ? { ...axis, acceleration: editedAcceleration } : axis) })
    useCamStore.getState().newProject()
    useCamStore.setState((state) => {
      const machine = { ...state.project.machine, name: 'LienCNC V2', controller: 'uccnc' as const, controllerDefinition: saved }
      return { project: { ...state.project, machine },
        machineLibrary: [...state.machineLibrary.filter((m) => m.id !== machine.id), machine] }
    })

    // Connect to a fresh bridge, then reconnect a day later to the same
    // process, which still reports its start-up label.
    vi.useFakeTimers({ toFake: ['Date'] })
    const frames: ApplyFrame[] = []
    for (const day of ['2026-10-28T09:00:00Z', '2026-10-29T15:30:00Z']) {
      vi.setSystemTime(new Date(day))
      useMachineControl.setState({ consoleLines: [] })
      bridgeFixture.source = 'none'
      bridgeFixture.sent = []
      await session.connectMachine('bridge')
      await vi.waitFor(() => expect(useMachineControl.getState().consoleLines.map((l) => l.text))
        .toContain('Machine definition applied: the controller accepted and read back every value.'))
      const applies = bridgeFixture.sent.filter((m) => m.m === 'applyMachineDefinition')
      expect(applies).toHaveLength(1)
      frames.push(applies[0].a as ApplyFrame)
      await session.disconnectMachine()
    }
    vi.useRealTimers()

    const [connect, reconnect] = frames

    // Control: the importer keeps definition-owned keys out of `settings`, so
    // the import route's restart has nothing to compare X acceleration with.
    // A cache whose imported settings DO name it (the shape the audit traced)
    // shows the revert decision itself - a hand-built row, never app truth.
    const owned = { controller: 'uccnc', key: 'axessettingscontrolX.Acceleration', value: { kind: 'number', value: importedX.acceleration } }
    const withOwnedRow = (frame: ApplyFrame) => JSON.stringify({ ...frame,
      definition: { ...frame.definition, settings: [...(frame.definition.settings ?? []), owned] } })
    const lines = runBridgeHarness(RESTART_HARNESS, {
      'import-connect.json': JSON.stringify(connect), 'import-reconnect.json': JSON.stringify(reconnect),
      'control-connect.json': withOwnedRow(connect), 'control-reconnect.json': withOwnedRow(reconnect),
    })
    // The authorship the panel's Apply declares for this edit on the first day.
    const stamp = session.machineDefinitionApplyProvenance(saved, saved, 'LienCNC V2', new Date('2026-10-28T09:00:00Z'))
    expect(stamp['axes.X.acceleration']).toMatchObject({ kind: 'liencam-ui' })
    const authorship = `liencam-ui,${stamp['axes.X.acceleration'].source}`
    for (const route of ['import', 'control']) {
      expect(lines).toContain(`${route}-fresh-open=True,source=none`)
      expect(lines).toContain(`${route}-connect-apply=True`)
      expect(lines).toContain(`${route}-reconnect-apply=True`)
      expect(lines).toContain(`${route}-restart-open=True,source=cache-baseline`)
      expect(lines).toContain(`${route}-cache-authorship=${authorship}`)
      expect(lines).toContain(`${route}-board-x-acceleration=${editedAcceleration}`)
    }
    expect(lines).toContain(`control-drift=${editedAcceleration}->${importedX.acceleration},kept=True,kind=${authorship.replace(',', ',source=')}`)

    // The frame declares the edit exactly as the panel's Apply would, and the
    // reconnect restates that authorship rather than stamping a new date.
    expect(connect.provenance).toEqual(stamp)
    expect(reconnect.provenance).toEqual(connect.provenance)
  }, 120_000)
})

// ---------------------------------------------------------------------------
// 18. The spindle port field saves on Enter, and a save says where it went
// ---------------------------------------------------------------------------
describe('WO-3088 item 18: spindle link field saves on Enter and says what happened', () => {
  it('Enter in a spindle link box commits it once (the port no longer waits for a click away)', async () => {
    const { createElement } = await import('react')
    const { cleanup, fireEvent, render, screen } = await import('@testing-library/react')
    const { VfdReadout } = await import('../../components/machine/definition/SpindleLinkSection')
    const commits: Array<[string, string]> = []
    const edit = {
      pending: {} as Record<string, string>, disabled: false,
      onType: () => {},
      onCommit: (path: readonly (string | number)[], value: string) => { commits.push([path.join('.'), value]) },
      onDirectionChange: () => {},
    }
    try {
      render(createElement(VfdReadout, { label: 'port', value: '/dev/ttyUSB0', testId: 'port', path: ['link', 'port'], edit }))
      const input = screen.getByTestId('port').querySelector('input') as HTMLInputElement
      input.focus()
      fireEvent.keyDown(input, { key: 'Enter' })
      expect(commits).toEqual([['link.port', '/dev/ttyUSB0']])
      expect(document.activeElement).not.toBe(input)
      // Other keys type; they do not commit.
      input.focus()
      fireEvent.keyDown(input, { key: 'a' })
      expect(commits).toHaveLength(1)
    } finally {
      cleanup()
    }
  })

  it('a saved edit with no bridge connected says it was saved and that Connect sends it', async () => {
    const session = await import('../../lib/machine/machineSession')
    const { useCamStore } = await import('../../store')
    const { HUANYANG_GT } = await import('../../lib/machine/vfd/huanyangGt')
    useCamStore.getState().newProject()
    useCamStore.setState({ consoleEvents: [] })
    const machineId = useCamStore.getState().project.machine.id
    const definition = { ...HUANYANG_GT, link: { ...HUANYANG_GT.link, port: '/dev/ttyUSB0' },
      verified: false, provenance: { kind: 'edited-here', source: 'WO-3088 test' } }
    const outcome = await session.applyMachineSpindleLinkDefinition(machineId,
      definition as unknown as Parameters<typeof session.applyMachineSpindleLinkDefinition>[1])
    expect(outcome).toMatchObject({ ok: true, stored: true, sent: false })
    expect(useCamStore.getState().project.machine.spindleLinkDefinition?.link).toMatchObject({ port: '/dev/ttyUSB0' })
    expect(useCamStore.getState().consoleEvents.map((event) => event.message)).toContain(
      'Spindle link saved on this computer - no machine bridge is connected for this machine, so Connect sends it.')
  })
})
