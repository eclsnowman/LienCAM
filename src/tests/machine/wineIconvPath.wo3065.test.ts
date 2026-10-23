import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import * as fsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { electronMainRequire } from '../support/electronMainRequire'
import nativePath from 'node:path'
import vm from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'

class Child extends EventEmitter {
  pid = 2894
  exitCode: number | null = null
  killed = false
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  signalStop = () => {}
  kill = vi.fn(() => { this.signalStop(); this.killed = true; void Promise.resolve().then(() => this.exit()); return true })
  exit(code = 0) { this.exitCode = code; this.emit('exit', code, null) }
}
const MINGW = '/usr/x86_64-w64-mingw32/sys-root/mingw/bin'
const MINGW_WINE = 'Z:\\usr\\x86_64-w64-mingw32\\sys-root\\mingw\\bin'
type Spec = { executable: string; args: string[]; winePrefix?: string }
type Status = { lastExit?: { error?: string | null } | null; configured: boolean; running: boolean; setup: { state: string; error: string | null }; respawn: { gaveUp: boolean } }
interface Api {
  initializeMachineBridge(): Promise<Child | null>
  machineBridgeSpec(settings?: object): Spec | null
  machineBridgeStatus(): Status
  startMachineBridge(spec?: Spec): Child | null
  stopMachineBridge(): Promise<boolean>
  restartMachineBridge(settings?: object): Promise<unknown>
}
const path = nativePath.posix
const roots: string[] = []
afterEach(() => { vi.useRealTimers(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

function harness(options: { mingw?: boolean; platform?: string; arch?: string; prefix?: string; env?: Record<string, string>; settings?: object; packaged?: boolean; cleanupError?: boolean; holdCleanup?: boolean } = {}) {
  const hostRoot = fs.mkdtempSync(nativePath.join(tmpdir(), 'liencam-wo3065-'))
  roots.push(hostRoot)
  // The VM is Linux even on a Windows judge. Only the backing filesystem sees
  // host paths; production path/argv/settings all see the same POSIX namespace.
  const root = '/liencam-wo3065'
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
      return (...args: unknown[]) => Reflect.apply(original, target,
        args.map((value, index) => index < count ? hostPath(String(value)) : value))
    },
  })
  const mapped = mapFs(fs, { existsSync: 1, mkdirSync: 1, readFileSync: 1, readdirSync: 1, statSync: 1, rmSync: 1, writeFileSync: 1 })
  // The MinGW folder lives outside the fixture root; the fixture decides whether it exists.
  const disk = new Proxy(mapped, { get(target, key) {
    if (key !== 'accessSync') return Reflect.get(target, key)
    return (value: string) => { if (value !== MINGW || !options.mingw) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) }
  } })
  const asyncDisk = mapFs(fsPromises, { appendFile: 1, cp: 2, mkdir: 1, readFile: 1, readdir: 1, rename: 2, rm: 1, writeFile: 1 })
  const resources = path.join(root, 'resources')
  const userData = path.join(root, 'user-data')
  const prefix = options.prefix ?? path.join(root, 'wine prefix')
  const installRoot = path.join(prefix, 'drive_c', 'UCCNC12115')
  const bundled = path.join(resources, 'pendant', 'uccnc-bridge', 'bin', 'liencam-bridge.exe')
  const boards = path.join(resources, 'pendant', 'uccnc-bridge', 'boards')
  disk.mkdirSync(path.dirname(bundled), { recursive: true })
  disk.mkdirSync(path.join(installRoot, 'Profiles'), { recursive: true })
  disk.mkdirSync(userData, { recursive: true })
  disk.mkdirSync(boards, { recursive: true })
  disk.writeFileSync(bundled, 'prebuilt bridge')
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
    env: { ...process.env, LIENCAM_BRIDGE_EXECUTABLE: '', LIENCAM_BRIDGE_ARGS_JSON: '', LIENCAM_USER_DATA_DIR: '', LIENCAM_UCCNC_SEARCH_ROOT: '', WINEPREFIX: prefix, ...options.env } }
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
  return { api: module.exports, disk, root, userData, prefix, installRoot, bundled, boards, calls, cleanups, callbacks, cleanupRequested, stopRequested, processValue, events, app }
}
const flush = async () => { for (let n = 0; n < 12; n++) await Promise.resolve() }
async function launch(options: Parameters<typeof harness>[0]) {
  const h = harness(options)
  expect(await h.api.initializeMachineBridge(), 'the bridge must launch').not.toBeNull()
  expect(h.calls).toHaveLength(1)
  const env = h.calls[0].options.env
  await h.api.stopMachineBridge()
  return { h, env }
}

describe('WO-3065 Wine bridge finds Fedora MinGW iconv.dll', () => {
  it('adds the MinGW bin folder in Wine form when it exists and WINEPATH is unset', async () => {
    const { env } = await launch({ mingw: true })
    expect(env.WINEPATH).toBe(MINGW_WINE)
  })
  it('appends to an existing WINEPATH with a semicolon', async () => {
    const { env } = await launch({ mingw: true, env: { WINEPATH: 'Z:\\opt\\tools' } })
    expect(env.WINEPATH).toBe(`Z:\\opt\\tools;${MINGW_WINE}`)
  })
  it('leaves WINEPATH alone when it already contains the folder', async () => {
    const own = `${MINGW_WINE}\\;Z:\\opt\\tools`
    const { env } = await launch({ mingw: true, env: { WINEPATH: own } })
    expect(env.WINEPATH).toBe(own)
  })
  it('does not invent WINEPATH when the folder is absent', async () => {
    const { env } = await launch({ mingw: false, env: { WINEPATH: '' } })
    expect(env.WINEPATH ?? '').toBe('')
    const kept = await launch({ mingw: false, env: { WINEPATH: 'Z:\\opt\\tools' } })
    expect(kept.env.WINEPATH).toBe('Z:\\opt\\tools')
  })
  it('never changes WINEPATH on the native route (no Wine prefix in the spec)', () => {
    const h = harness({ mingw: true, env: { LIENCAM_BRIDGE_EXECUTABLE: '/opt/liencam/native-bridge', WINEPATH: 'Z:\\opt\\tools' } })
    expect(h.api.startMachineBridge({ executable: '/opt/liencam/native-bridge', args: [] } as Spec)).not.toBeNull()
    expect(h.calls[0].executable).toBe('/opt/liencam/native-bridge')
    expect(h.calls[0].options.env.WINEPATH).toBe('Z:\\opt\\tools')
  })
  it.each(['win32', 'darwin'])('never changes WINEPATH on %s even with a Wine prefix', async (platform) => {
    const h = harness({ mingw: true, platform, env: { LIENCAM_BRIDGE_EXECUTABLE: 'bridge.exe', WINEPATH: 'Z:\\opt\\tools' } })
    const child = h.api.startMachineBridge({ executable: 'bridge.exe', args: [], winePrefix: h.prefix } as Spec)
    expect(child).not.toBeNull()
    expect(h.calls[0].options.env.WINEPATH).toBe('Z:\\opt\\tools')
  })
  it('names mingw64-win-iconv when Mono cannot load and the folder is missing', async () => {
    const h = harness({ mingw: false })
    const child = await h.api.initializeMachineBridge()
    child!.stderr.emit('data', 'Library iconv.dll (which is needed by libmono-2.0-x86_64.dll) not found\n')
    child!.exit(1)
    await flush()
    expect(h.api.machineBridgeStatus().lastExit?.error ?? '').toMatch(/mingw64-win-iconv/)
  })
  it('does not add that sentence when the folder exists', async () => {
    const h = harness({ mingw: true })
    const child = await h.api.initializeMachineBridge()
    child!.stderr.emit('data', 'Library iconv.dll (which is needed by libmono-2.0-x86_64.dll) not found\n')
    child!.exit(1)
    await flush()
    expect(h.api.machineBridgeStatus().lastExit?.error ?? '').not.toMatch(/mingw64-win-iconv/)
  })
})
