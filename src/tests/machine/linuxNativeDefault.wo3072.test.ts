import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import * as fsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { electronMainRequire } from '../support/electronMainRequire'
import nativePath from 'node:path'
import vm from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
// Use the installed runtime without adding an out-of-lane @types dependency.
const { JSDOM } = electronMainRequire('jsdom') as { JSDOM: new (html: string) => { window: Window & typeof globalThis } }
import { createElement, act } from 'react'
import { createRoot } from 'react-dom/client'
import { rememberedVfdPort } from '../../lib/machine/bridgeTransport'
import { ControllerSetupSection } from '../../components/machine/definition/ControllerSetupSection'

class Child extends EventEmitter {
  pid = 2895
  exitCode: number | null = null
  killed = false
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  signalStop = () => {}
  kill = vi.fn(() => { this.signalStop(); this.killed = true; void Promise.resolve().then(() => this.exit()); return true })
  exit(code = 0) { this.exitCode = code; this.emit('exit', code, null) }
}
type Spec = { executable: string; args: string[]; winePrefix?: string }
type Status = { configured: boolean; running: boolean; setup: { state: string; error: string | null }; respawn: { gaveUp: boolean } }
interface Api {
  initializeMachineBridge(): Promise<Child | null>
  machineBridgeSpec(settings?: object): Spec | null
  machineBridgeStatus(): Status
  startMachineBridge(): Child | null
  stopMachineBridge(): Promise<boolean>
  restartMachineBridge(settings?: object): Promise<unknown>
}
const path = nativePath.posix
const roots: string[] = []
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

function harness(options: { platform?: string; arch?: string; prefix?: string; env?: Record<string, string>; settings?: object; packaged?: boolean; cleanupError?: boolean; holdCleanup?: boolean; native?: boolean; serial?: Record<string, string[]> } = {}) {
  const hostRoot = fs.mkdtempSync(nativePath.join(tmpdir(), 'liencam-wo2895-'))
  roots.push(hostRoot)
  // The VM is Linux even on a Windows judge. Only the backing filesystem sees
  // host paths; production path/argv/settings all see the same POSIX namespace.
  const root = '/liencam-wo2895'
  const hostPath = (value: string) => {
    const relative = path.relative(root, value)
    if (relative === '..' || relative.startsWith('../') || !path.isAbsolute(value)) throw new Error(`Outside fixture: ${value}`)
    return nativePath.join(hostRoot, ...relative.split('/'))
  }
  const mapFs = <T extends object>(source: T, pathCounts: Record<string, number>): T => new Proxy(source, {
    get(target, key) {
      const original = Reflect.get(target, key)
      const count = pathCounts[String(key)]
      if (!count || typeof original !== 'function') return original
      return (...args: unknown[]) => {
        if (key === 'readdirSync' && options.serial?.[String(args[0])]) return options.serial[String(args[0])]
        return Reflect.apply(original, target, args.map((value, index) => index < count ? hostPath(String(value)) : value))
      }
    },
  })
  const disk = mapFs(fs, { existsSync: 1, mkdirSync: 1, readFileSync: 1, readdirSync: 1, statSync: 1, rmSync: 1, writeFileSync: 1, chmodSync: 1 })
  const asyncDisk = mapFs(fsPromises, { appendFile: 1, cp: 2, mkdir: 1, readFile: 1, readdir: 1, rename: 2, rm: 1, writeFile: 1 })
  const resources = path.join(root, 'resources')
  const userData = path.join(root, 'user-data')
  const prefix = options.prefix ?? path.join(root, 'wine prefix')
  const installRoot = path.join(prefix, 'drive_c', 'UCCNC12115')
  const bundled = path.join(resources, 'pendant', 'uccnc-bridge', 'bin', 'liencam-bridge.exe')
  const native = path.join(resources, 'pendant', 'uccnc-bridge', 'native', `linux-${options.arch ?? 'x64'}`, 'liencam-bridge')
  const boards = path.join(resources, 'pendant', 'uccnc-bridge', 'boards')
  disk.mkdirSync(path.dirname(bundled), { recursive: true })
  disk.mkdirSync(path.join(installRoot, 'Profiles'), { recursive: true })
  disk.mkdirSync(userData, { recursive: true })
  disk.mkdirSync(boards, { recursive: true })
  disk.writeFileSync(bundled, 'prebuilt bridge')
  if (options.native !== false) {
    disk.mkdirSync(path.dirname(native), { recursive: true })
    disk.writeFileSync(native, 'native executable')
    disk.writeFileSync(path.join(path.dirname(native), 'libcoreclr.so'), 'native runtime')
    disk.writeFileSync(path.join(path.dirname(native), 'liencam-bridge.dll'), 'native assembly')
    disk.chmodSync(native, 0o755)
  }
  disk.writeFileSync(path.join(boards, 'uc300.json'), '{"board":1}')
  disk.writeFileSync(path.join(installRoot, 'UC100.dll'), 'operator-owned DLL')
  disk.writeFileSync(path.join(userData, 'machine-bridge-launch-settings.json'), JSON.stringify(options.settings ?? { installRoot, board: 'auto', bridgePort: 9235 }))
  const calls: Array<{ executable: string; args: string[]; options: { env: Record<string, string>; windowsHide?: boolean; stdio?: string[] }; child: Child }> = []
  const cleanups: Array<{ executable: string; args: string[]; options: { env: Record<string, string> } }> = []
  const callbacks: Array<() => void> = []
  let signalStop!: () => void
  const stopRequested = new Promise<void>((resolve) => { signalStop = resolve })
  let signalCleanup!: () => void
  const cleanupRequested = new Promise<void>((resolve) => { signalCleanup = resolve })
  const processValue = { ...process, platform: options.platform ?? 'linux', arch: options.arch ?? 'x64', argv: [], resourcesPath: resources,
    env: { ...process.env, LIENCAM_BRIDGE_EXECUTABLE: '', LIENCAM_BRIDGE_ARGS_JSON: '', LIENCAM_USER_DATA_DIR: '', LIENCAM_UCCNC_SEARCH_ROOT: '', LIENCAM_BRIDGE_NATIVE: '', LIENCAM_BRIDGE_WINE: '', WINEPREFIX: prefix, ...options.env } }
  const events = new Map<string, (event: { preventDefault: () => void }) => unknown>()
  const app = { isPackaged: options.packaged ?? true, getPath: () => userData, on: (event: string, fn: (event: { preventDefault: () => void }) => unknown) => events.set(event, fn), quit: vi.fn(), whenReady: () => ({ then: () => Promise.resolve() }) }
  const module = { exports: {} as Api }
  const realRequire = electronMainRequire
  const context = vm.createContext({ module, exports: module.exports, process: processValue, __dirname: path.join(resources, 'electron'),
    AbortSignal, Buffer, Date, Promise, Response, URL, clearTimeout, setTimeout, queueMicrotask, console: { ...console, warn: vi.fn(), error: vi.fn() }, fetch,
    require: (id: string) => {
      if (id === 'node:path') return path
      if (id === 'node:fs') return disk
      if (id === 'node:fs/promises') return asyncDisk
      if (id === 'electron') return { app, ipcMain: { handle: vi.fn(), on: vi.fn() }, protocol: { registerSchemesAsPrivileged: vi.fn() } }
      if (id === 'node:net') return { createConnection: () => {
        const socket = Object.assign(new EventEmitter(), { destroy: vi.fn(), setTimeout: vi.fn() })
        void Promise.resolve().then(() => socket.emit('error', new Error('ECONNREFUSED')))
        return socket
      } }
      if (id === 'node:child_process') return {
        spawn: (executable: string, args: string[], options: (typeof calls)[number]['options']) => {
          const child = new Child(); child.signalStop = signalStop; calls.push({ executable, args, options, child }); return child
        },
        execFile: (executable: string, args: string[], execOptions: (typeof cleanups)[number]['options'], done: (error: Error | null) => void) => {
          cleanups.push({ executable, args, options: execOptions })
          signalCleanup()
          const complete = () => done(options.cleanupError ? new Error('cleanup failed') : null)
          if (options.holdCleanup) callbacks.push(complete); else void Promise.resolve().then(complete)
        },
      }
      return realRequire(id)
    } })
  vm.runInContext(fs.readFileSync(nativePath.resolve('electron/main.cjs'), 'utf8'), context)
  // Production startup reads the persisted settings before initializeMachineBridge.
  vm.runInContext('machineBridgeLaunchSettings = readMachineBridgeLaunchSettings()', context)
  return { api: module.exports, disk, root, userData, prefix, installRoot, bundled, native, boards, calls, cleanups, callbacks, cleanupRequested, stopRequested, processValue, events, app }
}

describe('WO-3072 Linux default', () => {
  it.each(['x64', 'arm64'])('starts native by default on %s without Wine', async (arch) => {
    const h = harness({ arch, env: { WINEPREFIX: '' } })
    expect(await h.api.initializeMachineBridge()).not.toBeNull()
    expect(h.calls[0].executable).toContain('machine-bridge-native')
    expect(h.calls[0].args).toEqual(['--install-root', h.installRoot, '--board', 'auto', '--port', '9235'])
    await h.api.stopMachineBridge()
    expect(h.cleanups).toHaveLength(0)
  })
  it('parks Wine behind explicit opt-in even with native present', async () => {
    const h = harness({ env: { LIENCAM_BRIDGE_WINE: '1' } })
    expect(await h.api.initializeMachineBridge()).not.toBeNull()
    expect(h.calls[0].executable).toBe('wine')
    await h.api.stopMachineBridge()
  })
  it('keeps the macOS native-only validation route', async () => {
    const h = harness({ platform: 'darwin', arch: 'arm64' })
    expect(await h.api.initializeMachineBridge()).toBeNull()
    expect(h.calls).toHaveLength(0)
    expect(h.api.machineBridgeStatus().setup.error).toMatch(/macOS AXBB-E bridge.*runtime is missing/)
  })
  it('refuses a missing native bundle without spawning Wine', async () => {
    const h = harness({ native: false })
    expect(await h.api.initializeMachineBridge()).toBeNull()
    expect(h.calls).toHaveLength(0)
    expect(h.api.machineBridgeStatus().setup.error).toMatch(/native executable is missing/)
    expect(h.api.machineBridgeStatus().setup.error).not.toMatch(/[\r\n]/)
  })
})

describe('WO-3072 serial setup', () => {
  it('lists Linux USB, ACM and by-id names from fs before a bridge is started', () => {
    const h = harness({ serial: { '/dev': ['ttyUSB0', 'ttyACM2', 'ttyS0', 'random'], '/dev/serial/by-id': ['usb-adapter'] } })
    expect(h.api.machineBridgeStatus()).toMatchObject({ serialPorts: ['/dev/serial/by-id/usb-adapter', '/dev/ttyACM2', '/dev/ttyUSB0'] })
    expect(h.calls).toHaveLength(0)
  })
  it.each([['Linux x86_64', '/dev/ttyUSB0'], ['Win32', 'COM3'], ['MacIntel', 'COM3']])('seeds fresh definitions on %s without modifying saved definitions', async (platform, port) => {
    vi.stubGlobal('navigator', { platform })
    vi.resetModules()
    const { HUANYANG_GT } = await import('../../lib/machine/vfd/huanyangGt')
    expect(HUANYANG_GT.link).toMatchObject({ port })
    const saved = { ...HUANYANG_GT, link: { ...HUANYANG_GT.link, port: 'COM7' } }
    expect(saved.link.port).toBe('COM7')
  })
  it('renders discovered ports and keeps a saved choice with no VFD link', async () => {
    const dom = new JSDOM('<div id="root"></div>')
    vi.stubGlobal('window', dom.window)
    vi.stubGlobal('document', dom.window.document)
    vi.stubGlobal('navigator', { platform: 'Linux x86_64' })
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    Object.assign(dom.window, { liencamHost: {
      machineBridgeRestart: vi.fn(),
      machineBridgeStatus: async () => ({ serialPorts: ['/dev/ttyUSB0', '/dev/ttyACM2', '/dev/serial/by-id/usb-adapter'] }),
    } })
    const props = {
      setupKind: 'bridge', bridgeProcessState: { kind: 'not-running' }, bridgeCapability: 'hosted',
      bridgeAction: null, source: { id: 'linux-test' }, draft: {}, def: {},
      localLink: { vfdPort: '/dev/ttyUSB9' }, spindleLink: { connected: false, linkPresent: false },
    } as unknown as Parameters<typeof ControllerSetupSection>[0]
    const root = createRoot(dom.window.document.getElementById('root')!)
    try {
      await act(async () => { root.render(createElement(ControllerSetupSection, props)) })
      const select = dom.window.document.querySelector<HTMLSelectElement>('[data-testid="machine-controller-vfd-port"]')!
      expect(select.disabled).toBe(false)
      expect(select.value).toBe('/dev/ttyUSB9')
      expect(Array.from(select.options).map(option => option.value)).toEqual(['', '/dev/ttyUSB0', '/dev/ttyACM2', '/dev/serial/by-id/usb-adapter', '/dev/ttyUSB9'])
      await act(async () => {
        select.value = '/dev/ttyACM2'
        select.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
      })
      expect(rememberedVfdPort('linux-test')).toBe('/dev/ttyACM2')
      await act(async () => root.render(createElement(ControllerSetupSection, {
        ...props, spindleLink: { ...props.spindleLink, spindleRunning: true },
      })))
      expect(select.disabled).toBe(true)
    } finally {
      await act(async () => root.unmount())
      dom.window.close()
    }
  })
})
