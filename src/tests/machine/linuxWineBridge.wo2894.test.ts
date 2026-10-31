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
  pid = 2894
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

function harness(options: { platform?: string; arch?: string; prefix?: string; env?: Record<string, string>; settings?: object; packaged?: boolean; cleanupError?: boolean; holdCleanup?: boolean } = {}) {
  const hostRoot = fs.mkdtempSync(nativePath.join(tmpdir(), 'liencam-wo2894-'))
  roots.push(hostRoot)
  // The VM is Linux even on a Windows judge. Only the backing filesystem sees
  // host paths; production path/argv/settings all see the same POSIX namespace.
  const root = '/liencam-wo2894'
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
  const disk = mapFs(fs, { existsSync: 1, mkdirSync: 1, readFileSync: 1, readdirSync: 1, statSync: 1, rmSync: 1, writeFileSync: 1 })
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
    env: { ...process.env, LIENCAM_BRIDGE_EXECUTABLE: '', LIENCAM_BRIDGE_ARGS_JSON: '', LIENCAM_USER_DATA_DIR: '', LIENCAM_UCCNC_SEARCH_ROOT: '', LIENCAM_BRIDGE_WINE: '1', WINEPREFIX: prefix, ...options.env } }
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

describe('WO-2894 Linux Wine bridge', () => {
  it('launches the packaged bridge under Wine with translated install root and a writable copy', async () => {
    const h = harness()
    const child = await h.api.initializeMachineBridge()
    expect(child, 'Linux must launch its prebuilt bridge rather than return no bridge').not.toBeNull()
    expect(h.calls).toHaveLength(1)
    const call = h.calls[0]
    expect(call.executable).toBe('wine')
    expect(call.args).toEqual([path.join(h.userData, 'machine-bridge', 'liencam-bridge.exe'), '--install-root', `Z:${h.installRoot.replaceAll('/', '\\')}`, '--board', 'auto', '--port', '9235'])
    expect(call.options.env.WINEPREFIX).toBe(h.prefix)
    expect(call.options.env.LIENCAM_BRIDGE_HOST_CONSOLE).toBe('1')
    expect(h.disk.readFileSync(call.args[0], 'utf8')).toBe('prebuilt bridge')
    expect(h.disk.readFileSync(path.join(path.dirname(call.args[0]), 'boards', 'uc300.json'), 'utf8')).toBe('{"board":1}')
    expect(h.api.machineBridgeStatus().setup.state).toBe('ready')
    await h.api.stopMachineBridge()
  })
  it('discovers one install in the configured prefix without requiring developer wrapper sources', async () => {
    const h = harness({ settings: {} })
    expect(await h.api.initializeMachineBridge()).not.toBeNull()
    expect(h.calls[0].args).toContain(`Z:${h.installRoot.replaceAll('/', '\\')}`)
    await h.api.stopMachineBridge()
  })
  it('does not guess between multiple UCCNC installs', async () => {
    const h = harness({ settings: {} })
    h.disk.mkdirSync(path.join(h.prefix, 'drive_c', 'UCCNC-new'), { recursive: true })
    h.disk.writeFileSync(path.join(h.prefix, 'drive_c', 'UCCNC-new', 'UC100.dll'), 'other DLL')
    expect(await h.api.initializeMachineBridge()).toBeNull()
    expect(h.calls).toHaveLength(0)
    expect(h.api.machineBridgeStatus().setup.error).toMatch(/multiple|several|choose/i)
  })
  it.each([{ env: { WINEPREFIX: '' } }, { prefix: 'relative-prefix' }, { arch: 'arm64' }])('reports an unsupported or unconfigured Wine route without launching: %j', async (options) => {
    // Relative prefix is injected after fixture creation, avoiding writes outside the temp root.
    const h = harness('prefix' in options ? {} : options)
    if ('prefix' in options) h.processValue.env.WINEPREFIX = options.prefix!
    expect(await h.api.initializeMachineBridge()).toBeNull()
    expect(h.calls).toHaveLength(0)
    expect(h.api.machineBridgeStatus().setup.error).toMatch(/Wine|WINEPREFIX|x86/i)
  })
  it('reports a missing packaged executable without invoking a compiler or simulator', async () => {
    const h = harness(); h.disk.rmSync(h.bundled)
    expect(await h.api.initializeMachineBridge()).toBeNull()
    expect(h.calls).toHaveLength(0)
    expect(h.api.machineBridgeStatus().setup.error).toContain('prebuilt')
  })
  it('accepts an explicitly chosen install outside the prefix and translates path-valued arguments', async () => {
    const h = harness()
    await h.api.initializeMachineBridge()
    const spec = h.api.machineBridgeSpec({ installRoot: '/opt/UCCNC space', profile: '/home/operator/a.pro', vfdDefinition: '/home/operator/vfd.json' })!
    expect(spec.args).toEqual(['--install-root', 'Z:\\opt\\UCCNC space', '--profile', 'Z:\\home\\operator\\a.pro', '--board', 'auto', '--vfd', 'Z:\\home\\operator\\vfd.json'])
    await h.api.stopMachineBridge()
  })
  it('uses the same Wine route for explicit executable and argument overrides', async () => {
    const h = harness()
    h.processValue.env.LIENCAM_BRIDGE_EXECUTABLE = h.bundled
    h.processValue.env.LIENCAM_BRIDGE_ARGS_JSON = JSON.stringify(['--install-root', h.installRoot, '--board', '19', '--port', '9333'])
    expect(await h.api.initializeMachineBridge()).not.toBeNull()
    expect(h.calls[0].executable).toBe('wine')
    expect(h.calls[0].args).toEqual([h.bundled, '--install-root', `Z:${h.installRoot.replaceAll('/', '\\')}`, '--board', '19', '--port', '9333'])
    await h.api.stopMachineBridge()
  })
  it('kills and waits for only this Wine prefix on an intentional stop', async () => {
    const h = harness(); await h.api.initializeMachineBridge()
    expect(await h.api.stopMachineBridge()).toBe(true)
    expect(h.cleanups.map(call => [call.executable, call.args])).toEqual([['wineserver', ['-k']], ['wineserver', ['-w']]])
    for (const call of h.cleanups) expect(call.options.env.WINEPREFIX).toBe(h.prefix)
  })
  it('finishes cleanup before respawning a crashed bridge and cleans each child only once', async () => {
    vi.useFakeTimers()
    const h = harness({ holdCleanup: true }); await h.api.initializeMachineBridge()
    h.calls[0].child.exit(3)
    expect(h.api.startMachineBridge()).toBeNull()
    await vi.advanceTimersByTimeAsync(2000)
    expect(h.calls).toHaveLength(1)
    h.callbacks.shift()!(); await flush(); h.callbacks.shift()!(); await flush()
    await vi.advanceTimersByTimeAsync(1000)
    expect(h.calls).toHaveLength(2)
    expect(h.cleanups).toHaveLength(2)
    h.calls[1].child.exit(11); h.callbacks.shift()!(); await flush(); h.callbacks.shift()!(); await flush()
  })
  it('does not respawn a failed firmware update under Wine', async () => {
    vi.useFakeTimers()
    const h = harness(); await h.api.initializeMachineBridge(); h.calls[0].child.exit(11)
    await flush(); await vi.advanceTimersByTimeAsync(10000)
    expect(h.calls).toHaveLength(1)
    expect(h.cleanups).toHaveLength(2)
    expect(h.api.machineBridgeStatus().respawn.gaveUp).toBe(true)
  })
  it('does not replace a bridge when prefix cleanup fails', async () => {
    const h = harness({ cleanupError: true }); await h.api.initializeMachineBridge()
    expect(await h.api.stopMachineBridge()).toBe(false)
    expect(h.api.startMachineBridge()).toBeNull()
    expect(h.api.machineBridgeStatus().setup.error).toContain('cleanup')
  })
  it('reports a missing wine runtime without claiming the bridge exe is absent', async () => {
    const h = harness(); await h.api.initializeMachineBridge()
    h.calls[0].child.emit('error', Object.assign(new Error('spawn wine ENOENT'), { code: 'ENOENT' }))
    await flush()
    expect(h.api.machineBridgeStatus().setup.error).toMatch(/wine/i)
    expect(h.api.machineBridgeStatus().setup.error).not.toMatch(/executable is missing|artifact is missing/i)
    expect(h.api.machineBridgeStatus().running).toBe(false)
  })
  it('awaits prefix cleanup when Electron quits', async () => {
    const h = harness(); await h.api.initializeMachineBridge()
    const preventDefault = vi.fn(); h.events.get('will-quit')!({ preventDefault })
    expect(preventDefault).toHaveBeenCalledOnce()
    await flush()
    expect(h.cleanups).toHaveLength(2)
    expect(h.app.quit).toHaveBeenCalledOnce()
  })
  it('uses the original prefix for cleanup even if future launch settings change', async () => {
    const h = harness(); await h.api.initializeMachineBridge()
    h.processValue.env.WINEPREFIX = path.join(h.root, 'other-prefix')
    await h.api.stopMachineBridge()
    for (const call of h.cleanups) expect(call.options.env.WINEPREFIX).toBe(h.prefix)
  })
  it('allows a deliberate reconnect to retry failed cleanup before starting a replacement', async () => {
    const options = { cleanupError: true }
    const h = harness(options); await h.api.initializeMachineBridge()
    expect(await h.api.stopMachineBridge()).toBe(false)
    options.cleanupError = false
    expect(await h.api.stopMachineBridge()).toBe(true)
    expect(h.api.startMachineBridge()).not.toBeNull()
    expect(h.calls).toHaveLength(2)
    await h.api.stopMachineBridge()
  })
  it('does not start an explicit restart until prefix cleanup completes', async () => {
    vi.useFakeTimers()
    const h = harness({ holdCleanup: true }); await h.api.initializeMachineBridge()
    const restart = h.api.restartMachineBridge({ installRoot: h.installRoot })
    // Preparation performs real file I/O; await the actual cleanup request.
    await h.cleanupRequested
    expect(h.callbacks).toHaveLength(1)
    expect(h.calls).toHaveLength(1)
    h.callbacks.shift()!(); await flush()
    expect(h.calls).toHaveLength(1)
    h.callbacks.shift()!(); await flush()
    expect(h.calls).toHaveLength(2)
    h.calls[1].child.exit(11)
    h.callbacks.shift()!(); await flush(); h.callbacks.shift()!(); await flush()
    await vi.advanceTimersByTimeAsync(250)
    await expect(restart).resolves.toMatchObject({ ok: false, reason: 'exited' })
  })
  it('accepts the prefix C drive install path and keeps relative profile names', async () => {
    const h = harness({ settings: { installRoot: 'C:\\UCCNC12115', profile: 'LienCNC.pro' } })
    expect(await h.api.initializeMachineBridge()).not.toBeNull()
    expect(h.calls[0].args).toContain('LienCNC.pro')
    await h.api.stopMachineBridge()
  })
  it('reports a missing vendor DLL without substituting a simulator', async () => {
    const h = harness(); h.disk.rmSync(path.join(h.installRoot, 'UC100.dll'))
    expect(await h.api.initializeMachineBridge()).toBeNull()
    expect(h.calls).toHaveLength(0)
    expect(h.api.machineBridgeStatus().setup.error).toContain('UC100.dll')
  })
  it('includes only the prebuilt executable as a Linux-specific packaged resource', () => {
    const require = createRequire(import.meta.url)
    const config = require('js-yaml').load(fs.readFileSync(nativePath.resolve('electron-builder.yml'), 'utf8'))
    const { getFileMatchers } = require('app-builder-lib/out/fileMatcher.js')
    const destination = nativePath.resolve('/tmp/liencam-wo2894-package-resources')
    const matchersFor = (platform: string) => getFileMatchers(config, 'extraResources', destination, {
      defaultSrc: process.cwd(), macroExpander: (value: string) => value,
      customBuildOptions: config[platform], globalOutDir: nativePath.resolve('release'),
    }) as Array<{ from: string; to: string }>
    const bridge = nativePath.resolve('pendant/uccnc-bridge/bin/liencam-bridge.exe')
    expect(matchersFor('linux').filter(matcher => matcher.from === bridge).map(matcher => matcher.to))
      .toEqual([nativePath.join(destination, 'pendant/uccnc-bridge/bin/liencam-bridge.exe')])
    for (const platform of ['win', 'mac']) expect(matchersFor(platform).some(matcher => matcher.from === bridge)).toBe(false)
    expect(config.linux.extraResources).toEqual([
      { from: 'pendant/uccnc-bridge/bin/liencam-bridge.exe', to: 'pendant/uccnc-bridge/bin/liencam-bridge.exe' },
      { from: 'pendant/uc100net/publish/linux-${arch}', to: 'pendant/uccnc-bridge/native/linux-${arch}' },
    ])
  })
  it('cleans up wineserver even when the Wine loader survives both stop signals', async () => {
    vi.useFakeTimers()
    const h = harness(); await h.api.initializeMachineBridge()
    h.calls[0].child.kill.mockImplementation(() => true)
    const stopping = h.api.stopMachineBridge()
    await vi.advanceTimersByTimeAsync(6000)
    expect(await stopping).toBe(false)
    expect(h.cleanups.map(call => call.args)).toEqual([['-k'], ['-w']])
    expect(h.calls).toHaveLength(1)
  })
  it('waits for wineserver cleanup after a loader timeout before completing an explicit restart', async () => {
    vi.useFakeTimers()
    const h = harness({ holdCleanup: true }); await h.api.initializeMachineBridge()
    h.calls[0].child.kill.mockImplementation(() => { h.calls[0].child.signalStop(); return true })
    let completed = false
    const restart = h.api.restartMachineBridge({ installRoot: h.installRoot }).then(result => { completed = true; return result })
    // Let asynchronous preparation reach stop before advancing its two deadlines.
    await h.stopRequested
    await vi.advanceTimersByTimeAsync(6000)
    expect(h.calls[0].child.kill.mock.calls).toHaveLength(2)
    expect(h.cleanups.map(call => call.args), 'Timed-out restart must still request wineserver cleanup').toEqual([['-k']])
    expect(completed).toBe(false)
    expect(h.calls).toHaveLength(1)
    h.callbacks.shift()!(); await flush()
    expect(h.cleanups.map(call => call.args)).toEqual([['-k'], ['-w']])
    expect(completed).toBe(false)
    expect(h.calls).toHaveLength(1)
    h.callbacks.shift()!(); await flush()
    await expect(restart).resolves.toMatchObject({ ok: false, reason: 'exited' })
    expect(h.calls).toHaveLength(1)
    for (const call of h.cleanups) expect(call.options.env.WINEPREFIX).toBe(h.prefix)
  })
  it('keeps the Windows executable, argument bytes, environment and stop behavior unchanged', async () => {
    const h = harness({ platform: 'win32', env: { LIENCAM_BRIDGE_EXECUTABLE: 'C:\\bridge\\liencam-bridge.exe' }, settings: { installRoot: 'C:\\UCCNC12115', profile: 'LienCNC.pro', board: 'auto', bridgePort: 9235 } })
    expect(await h.api.initializeMachineBridge()).not.toBeNull()
    expect(h.calls[0].executable).toBe('C:\\bridge\\liencam-bridge.exe')
    expect(h.calls[0].args).toEqual(['--install-root', 'C:\\UCCNC12115', '--profile', 'LienCNC.pro', '--board', 'auto', '--port', '9235'])
    expect(h.calls[0].options).toEqual({ env: { ...h.processValue.env, LIENCAM_BRIDGE_HOST_CONSOLE: '1' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    expect(await h.api.stopMachineBridge()).toBe(true)
    expect(h.cleanups).toHaveLength(0)
  })
})
