import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import * as fsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { electronMainRequire } from '../support/electronMainRequire'
import nativePath from 'node:path'
import vm from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'

class Child extends EventEmitter {
  pid = 2897
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
afterEach(() => { vi.useRealTimers(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

function harness(options: { platform?: string; arch?: string; prefix?: string; env?: Record<string, string>; settings?: object; packaged?: boolean; cleanupError?: boolean; holdCleanup?: boolean; native?: boolean } = {}) {
  const hostRoot = fs.mkdtempSync(nativePath.join(tmpdir(), 'liencam-wo2897-'))
  roots.push(hostRoot)
  // The VM uses macOS paths even on a Windows judge. Only the backing filesystem sees
  // host paths; production path/argv/settings all see the same POSIX namespace.
  const root = '/liencam-wo2897'
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
  const disk = mapFs(fs, { existsSync: 1, mkdirSync: 1, readFileSync: 1, readdirSync: 1, statSync: 1, rmSync: 1, writeFileSync: 1, chmodSync: 1 })
  const asyncDisk = mapFs(fsPromises, { appendFile: 1, cp: 2, mkdir: 1, readFile: 1, readdir: 1, rename: 2, rm: 1, writeFile: 1 })
  const resources = path.join(root, 'resources')
  const userData = path.join(root, 'user-data')
  const prefix = options.prefix ?? path.join(root, 'wine prefix')
  const installRoot = path.join(prefix, 'drive_c', 'UCCNC12115')
  const bundled = path.join(resources, 'pendant', 'uccnc-bridge', 'bin', 'liencam-bridge.exe')
  const native = path.join(resources, 'pendant', 'uccnc-bridge', 'native', 'osx-arm64', 'liencam-bridge')
  const boards = path.join(resources, 'pendant', 'uccnc-bridge', 'boards')
  disk.mkdirSync(path.dirname(bundled), { recursive: true })
  disk.mkdirSync(path.join(installRoot, 'Profiles'), { recursive: true })
  disk.mkdirSync(userData, { recursive: true })
  disk.mkdirSync(boards, { recursive: true })
  disk.writeFileSync(bundled, 'prebuilt bridge')
  if (options.native !== false) {
    disk.mkdirSync(path.dirname(native), { recursive: true })
    disk.writeFileSync(native, 'native executable')
    disk.writeFileSync(path.join(path.dirname(native), 'libcoreclr.dylib'), 'native runtime')
    disk.writeFileSync(path.join(path.dirname(native), 'liencam-bridge.dll'), 'native assembly')
    for (const name of ['liencam-bridge.deps.json', 'liencam-bridge.runtimeconfig.json', 'libhostfxr.dylib', 'libhostpolicy.dylib']) disk.writeFileSync(path.join(path.dirname(native), name), 'runtime input')
    disk.mkdirSync(path.join(path.dirname(native), 'boards'), { recursive: true })
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
  const processValue = { ...process, platform: options.platform ?? 'darwin', arch: options.arch ?? 'arm64', argv: [], resourcesPath: resources,
    env: { ...process.env, LIENCAM_BRIDGE_EXECUTABLE: '', LIENCAM_BRIDGE_ARGS_JSON: '', LIENCAM_USER_DATA_DIR: '', LIENCAM_UCCNC_SEARCH_ROOT: '', LIENCAM_BRIDGE_NATIVE: '', WINEPREFIX: prefix, ...options.env } }
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
const flush = async () => { for (let n = 0; n < 12; n++) await Promise.resolve() }

describe('WO-2897 Mac native bridge', () => {
  it.each([true, false])('prepares Apple Silicon full runtime without Wine (packaged=%s)', async (packaged) => {
    const h = harness({ packaged, settings: {} })
    expect(await h.api.initializeMachineBridge(), 'Apple Silicon must prepare the native bridge').not.toBeNull()
    const call = h.calls[0]
    expect(call.executable).toBe(path.join(h.userData, 'machine-bridge-native', 'osx-arm64', 'liencam-bridge'))
    expect(call.args).toEqual(['--board', 'auto'])
    expect(h.disk.readFileSync(path.join(path.dirname(call.executable), 'libcoreclr.dylib'), 'utf8')).toBe('native runtime')
    expect(h.api.machineBridgeStatus().setup.error).toBeNull()
    await h.api.stopMachineBridge()
    expect(h.cleanups).toHaveLength(0)
  })
  it.each([{ native: false }, { arch: 'x64' }, { env: { LIENCAM_BRIDGE_EXECUTABLE: '/Windows/bridge.exe' } }])('reports an unavailable route and never substitutes Wine or demo: %j', async (options) => {
    const h = harness(options)
    expect(await h.api.initializeMachineBridge()).toBeNull()
    expect(h.api.machineBridgeStatus().setup.error).toMatch(/macOS.*(missing|unsupported|requires)/)
    expect(h.api.machineBridgeSpec()).toBeNull()
    expect(h.calls).toHaveLength(0)
  })
  it('refuses an incomplete runtime without trying another route', async () => {
    const h = harness()
    h.disk.rmSync(path.join(path.dirname(h.native), 'libhostpolicy.dylib'))
    expect(await h.api.initializeMachineBridge()).toBeNull()
    expect(h.api.machineBridgeStatus().setup.error).toContain('missing libhostpolicy.dylib')
    expect(h.calls).toHaveLength(0)
    expect(h.api.machineBridgeSpec()).toBeNull()
  })
  it('validates explicit native overrides and preserves explicit arguments', async () => {
    const h = harness()
    h.processValue.env.LIENCAM_BRIDGE_EXECUTABLE = h.native
    h.processValue.env.LIENCAM_BRIDGE_ARGS_JSON = JSON.stringify(['--board', 'auto', '--profile', '/operator/a.pro'])
    expect(await h.api.initializeMachineBridge()).not.toBeNull()
    expect(h.calls[0].executable).toBe(h.native)
    expect(h.calls[0].args).toEqual(['--board', 'auto', '--profile', '/operator/a.pro'])
    await h.api.stopMachineBridge()
    h.disk.rmSync(h.native)
    expect(await h.api.initializeMachineBridge()).toBeNull()
    expect(h.api.machineBridgeSpec()).toBeNull()
    expect(h.calls).toHaveLength(1)
  })
  it('refreshes a running runtime while preserving saved records and POSIX launch settings', async () => {
    const h = harness()
    await h.api.initializeMachineBridge()
    const target = path.dirname(h.calls[0].executable)
    h.disk.writeFileSync(path.join(target, 'liencam-bridge.definition.json'), 'operator definition')
    h.disk.writeFileSync(path.join(path.dirname(h.native), 'libcoreclr.dylib'), 'new runtime')
    await h.api.initializeMachineBridge()
    expect(h.calls[0].child.killed).toBe(true)
    expect(h.disk.readFileSync(path.join(target, 'libcoreclr.dylib'), 'utf8')).toBe('new runtime')
    expect(h.disk.readFileSync(path.join(target, 'liencam-bridge.definition.json'), 'utf8')).toBe('operator definition')
    expect(h.api.machineBridgeSpec({ installRoot: '/operator/UCCNC', profile: '/operator/a.pro', vfdDefinition: '/operator/vfd.json' })!.args)
      .toEqual(['--install-root', '/operator/UCCNC', '--profile', '/operator/a.pro', '--board', 'auto', '--vfd', '/operator/vfd.json'])
    await h.api.stopMachineBridge()
  })
  it('waits for native child shutdown on explicit Mac quit', async () => {
    const h = harness()
    await h.api.initializeMachineBridge()
    const event = { preventDefault: vi.fn() }
    h.events.get('will-quit')!(event)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    await h.stopRequested
    await flush()
    expect(h.calls[0].child.killed).toBe(true)
    expect(h.app.quit).toHaveBeenCalledOnce()
    expect(h.cleanups).toHaveLength(0)
  })
  it('never changes to Wine after a native spawn failure', async () => {
    vi.useFakeTimers()
    const h = harness()
    await h.api.initializeMachineBridge()
    h.calls[0].child.emit('error', Object.assign(new Error('native failed'), { code: 'ENOENT' }))
    await flush()
    await vi.advanceTimersByTimeAsync(3000)
    expect(h.calls.every(c => c.executable.endsWith('/osx-arm64/liencam-bridge'))).toBe(true)
    expect(h.cleanups).toHaveLength(0)
    h.calls.at(-1)?.child.exit(11)
  })
})

describe('WO-2897 Mac packaging and release', () => {
  const require = createRequire(import.meta.url)
  const yaml = require('js-yaml')
  it('copies full arm64 resources and keeps Intel free of an arm64 bridge using the production packager', async () => {
    const config = yaml.load(fs.readFileSync(nativePath.resolve('electron-builder.yml'), 'utf8'))
    const { getFileMatchers, copyFiles } = require('app-builder-lib/out/fileMatcher.js')
    const root = fs.mkdtempSync(nativePath.join(tmpdir(), 'liencam-wo2897-package-'))
    roots.push(root)
    const source = nativePath.join(root, 'pendant/uc100net/publish/osx-arm64')
    fs.mkdirSync(nativePath.join(source, 'boards'), { recursive: true })
    for (const file of ['liencam-bridge', 'libcoreclr.dylib', 'libhostfxr.dylib', 'libhostpolicy.dylib', 'liencam-bridge.dll', 'liencam-bridge.deps.json', 'liencam-bridge.runtimeconfig.json', 'boards/axbb-e.json']) {
      fs.writeFileSync(nativePath.join(source, file), `payload ${file}`)
    }
    for (const arch of ['arm64', 'x64']) {
      const destination = nativePath.join(root, `resources-${arch}`)
      const matchers = getFileMatchers(config, 'extraResources', destination, {
        defaultSrc: root, macroExpander: (value: string) => value.replaceAll('${arch}', arch),
        customBuildOptions: config.mac, globalOutDir: nativePath.join(root, 'release'),
      }).filter((m: { from: string }) => m.from.includes('osx-'))
      await copyFiles(matchers)
      const bridge = nativePath.join(destination, 'pendant/uccnc-bridge/native/osx-arm64')
      expect(fs.existsSync(bridge)).toBe(arch === 'arm64')
      expect(fs.existsSync(nativePath.join(destination, 'pendant/uccnc-bridge/native/osx-x64'))).toBe(false)
      if (arch === 'arm64') {
        for (const file of ['liencam-bridge', 'libcoreclr.dylib', 'libhostfxr.dylib', 'boards/axbb-e.json']) expect(fs.readFileSync(nativePath.join(bridge, file), 'utf8')).toBe(`payload ${file}`)
      }
    }
  })
  it('wires native Mac artifacts, staging, CPU checks, checksums and untested labels before release', () => {
    const workflow = yaml.load(fs.readFileSync(nativePath.resolve('release/github-workflows/release.yml'), 'utf8'))
    const producer = yaml.load(fs.readFileSync(nativePath.resolve('.github/workflows/native-macos-bridge.yml'), 'utf8'))
    expect(workflow.jobs['native-macos-bridge'].uses).toBe('./.github/workflows/native-macos-bridge.yml')
    expect(workflow.jobs.macos.needs).toContain('native-macos-bridge')
    expect(workflow.jobs.release.needs).toContain('native-macos-bridge')
    const steps = workflow.jobs.macos.steps as Array<{ name: string; run?: string; if?: string; with?: Record<string, string> }>
    const download = steps.findIndex(s => s.with?.name === 'native-bridge-osx-arm64')
    const stage = steps.findIndex(s => s.name.startsWith('Stage Apple Silicon'))
    const pack = steps.findIndex(s => s.run?.includes('electron-builder --mac'))
    expect(download).toBeGreaterThan(-1)
    expect(stage).toBeGreaterThan(download)
    expect(pack).toBeGreaterThan(stage)
    expect(steps[download].if).toBe("matrix.arch == 'arm64'")
    expect(steps[stage].if).toBe("matrix.arch == 'arm64'")
    expect(steps.find(s => s.name.startsWith('Verify packaged bridge'))?.run).toContain('test ! -e "$root/osx-arm64"')
    const build = producer.jobs['native-bridge'].steps.find((s: { run?: string }) => s.run?.includes('dotnet publish')).run
    expect(build).toContain('-r osx-arm64 --self-contained true')
    expect(build).toContain('libhostpolicy.dylib')
    expect(build).toContain('boards')
    const release = workflow.jobs.release.steps as Array<{ name: string; run?: string }>
    expect(release.find(s => s.name.startsWith('Verify Mac native bridge download checksum'))?.run).toContain('liencam-bridge-osx-arm64.tar.gz')
    expect(release.find(s => s.name.startsWith('Write release notes'))?.run).toContain('alpha, untested on macOS')
  })
})
