import { EventEmitter } from 'node:events'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as fsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { electronMainRequire } from '../support/electronMainRequire'
import nativePath from 'node:path'
import vm from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'

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
afterEach(() => { vi.useRealTimers(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

function harness(options: { platform?: string; arch?: string; prefix?: string; env?: Record<string, string>; settings?: object; packaged?: boolean; cleanupError?: boolean; holdCleanup?: boolean; native?: boolean } = {}) {
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

describe('WO-2895 native Linux bridge', () => {
  // WO-3059: route B is opt-in until its real-board check (O61) passes.
  it('uses Wine by default even when the native bundle is present', async () => {
    const h = harness()
    expect(await h.api.initializeMachineBridge()).not.toBeNull()
    expect(h.calls[0].executable, 'The unproven native bridge must not be the default route').toBe('wine')
    expect(h.calls[0].args).toContain(`Z:${h.installRoot.replaceAll('/', '\\')}`)
    await h.api.stopMachineBridge()
    expect(h.cleanups.map(c => c.args)).toEqual([['-k'], ['-w']])
  })
  it('does not select native without opt-in on ARM, where Wine cannot run', async () => {
    const h = harness({ arch: 'arm64' })
    expect(await h.api.initializeMachineBridge()).toBeNull()
    expect(h.calls).toHaveLength(0)
    expect(h.api.machineBridgeStatus().setup.error).toMatch(/requires x86-64 Linux/)
  })
  it.each(['x64', 'arm64'])('selects native over Wine on %s when opted in, with profile-only install and POSIX arguments', async (arch) => {
    const h = harness({ arch, env: { WINEPREFIX: '', LIENCAM_BRIDGE_NATIVE: '1' } })
    h.disk.rmSync(path.join(h.installRoot, 'UC100.dll'))
    expect(await h.api.initializeMachineBridge(), 'Native Linux must start without Wine or vendor DLLs').not.toBeNull()
    const call = h.calls[0]
    expect(call.executable).toBe(path.join(h.userData, 'machine-bridge-native', `linux-${arch}`, 'liencam-bridge'))
    expect(call.args).toEqual(['--install-root', h.installRoot, '--board', 'auto', '--port', '9235'])
    expect(h.disk.readFileSync(call.executable, 'utf8')).toBe('native executable')
    // The backing Windows filesystem has no POSIX execute bits.
    if (process.platform !== 'win32') expect(h.disk.statSync(call.executable).mode & 0o111).toBeTruthy()
    expect(h.disk.readFileSync(path.join(path.dirname(call.executable), 'libcoreclr.so'), 'utf8')).toBe('native runtime')
    expect(h.api.machineBridgeSpec({ installRoot: '/opt/UCCNC', profile: '/home/operator/a.pro', vfdDefinition: '/home/operator/vfd.json' })!.args)
      .toEqual(['--install-root', '/opt/UCCNC', '--profile', '/home/operator/a.pro', '--board', 'auto', '--vfd', '/home/operator/vfd.json'])
    await h.api.stopMachineBridge()
    expect(h.cleanups).toHaveLength(0)
  })
  it('allows a saved machine definition without requiring an install folder', async () => {
    const h = harness({ settings: {}, env: { WINEPREFIX: '', LIENCAM_BRIDGE_NATIVE: '1' } })
    expect(await h.api.initializeMachineBridge()).not.toBeNull()
    expect(h.calls[0].executable).toContain('machine-bridge-native')
    expect(h.calls[0].args).toEqual(['--board', 'auto'])
    await h.api.stopMachineBridge()
  })
  it('does not require Profiles when the bridge has a saved machine definition', async () => {
    const h = harness({ env: { WINEPREFIX: '', LIENCAM_BRIDGE_NATIVE: '1' } })
    h.disk.rmSync(path.join(h.installRoot, 'Profiles'), { recursive: true })
    const target = path.join(h.userData, 'machine-bridge-native', 'linux-x64')
    h.disk.mkdirSync(target, { recursive: true })
    h.disk.writeFileSync(path.join(target, 'liencam-bridge.definition.json'), 'saved definition')
    expect(await h.api.initializeMachineBridge(), 'A saved definition must not require a Profiles folder').not.toBeNull()
    expect(h.calls[0].args).toContain(h.installRoot)
    expect(h.disk.readFileSync(path.join(target, 'liencam-bridge.definition.json'), 'utf8')).toBe('saved definition')
    await h.api.stopMachineBridge()
  })
  it('uses Wine when the matching native bundle is absent', async () => {
    const h = harness({ native: false })
    expect(await h.api.initializeMachineBridge()).not.toBeNull()
    expect(h.calls[0].executable).toBe('wine')
    expect(h.calls[0].args).toContain(`Z:${h.installRoot.replaceAll('/', '\\')}`)
    await h.api.stopMachineBridge()
    expect(h.cleanups.map(c => c.args)).toEqual([['-k'], ['-w']])
  })
  it('honors an explicit Wine executable even when a native bundle exists and native is opted in', async () => {
    const h = harness({ env: { LIENCAM_BRIDGE_NATIVE: '1' } })
    h.processValue.env.LIENCAM_BRIDGE_EXECUTABLE = h.bundled
    expect(await h.api.initializeMachineBridge()).not.toBeNull()
    expect(h.calls[0].executable).toBe('wine')
    await h.api.stopMachineBridge()
  })
  it('honors an explicit native executable and verbatim override args without Wine', async () => {
    const h = harness({ env: { WINEPREFIX: '' } })
    h.processValue.env.LIENCAM_BRIDGE_EXECUTABLE = h.native
    h.processValue.env.LIENCAM_BRIDGE_ARGS_JSON = JSON.stringify(['--profile', '/home/operator/a.pro', '--board', 'auto'])
    expect(await h.api.initializeMachineBridge()).not.toBeNull()
    expect(h.calls[0].executable).toBe(h.native)
    expect(h.calls[0].args).toEqual(['--profile', '/home/operator/a.pro', '--board', 'auto'])
    await h.api.stopMachineBridge()
    expect(h.cleanups).toHaveLength(0)
  })
  it('does not fall back to Wine or demo when native preparation fails', async () => {
    const h = harness()
    h.disk.rmSync(h.native)
    h.processValue.env.LIENCAM_BRIDGE_EXECUTABLE = h.native
    expect(await h.api.initializeMachineBridge()).toBeNull()
    expect(h.calls).toHaveLength(0)
    expect(h.api.machineBridgeStatus().setup.error).toMatch(/native executable is missing/)
  })
  it('does not change routes after a selected native executable fails to spawn', async () => {
    vi.useFakeTimers()
    const h = harness({ env: { LIENCAM_BRIDGE_NATIVE: '1' } })
    await h.api.initializeMachineBridge()
    h.calls[0].child.emit('error', Object.assign(new Error('native failed'), { code: 'ENOENT' }))
    await flush()
    await vi.advanceTimersByTimeAsync(3000)
    expect(h.calls.every(c => c.executable.endsWith('/liencam-bridge'))).toBe(true)
    expect(h.cleanups).toHaveLength(0)
    h.calls.at(-1)?.child.exit(11)
  })
  it('refreshes a changed runtime library and preserves bridge runtime records', async () => {
    const h = harness({ env: { LIENCAM_BRIDGE_NATIVE: '1' } })
    await h.api.initializeMachineBridge()
    const target = path.dirname(h.calls[0].executable)
    h.disk.writeFileSync(path.join(target, 'liencam-bridge.definition.json'), 'operator definition')
    h.disk.writeFileSync(path.join(path.dirname(h.native), 'libcoreclr.so'), 'updated runtime')
    await h.api.initializeMachineBridge()
    expect(h.disk.readFileSync(path.join(target, 'libcoreclr.so'), 'utf8')).toBe('updated runtime')
    expect(h.disk.readFileSync(path.join(target, 'liencam-bridge.definition.json'), 'utf8')).toBe('operator definition')
    await h.api.stopMachineBridge()
  })
  it('preserves the Windows executable and argument route', async () => {
    const h = harness({ platform: 'win32', env: { LIENCAM_BRIDGE_EXECUTABLE: 'C:\\bridge\\liencam-bridge.exe' }, settings: { installRoot: 'C:\\UCCNC12115', profile: 'LienCNC.pro', board: 'auto', bridgePort: 9235 } })
    expect(await h.api.initializeMachineBridge()).not.toBeNull()
    expect(h.calls[0].executable).toBe('C:\\bridge\\liencam-bridge.exe')
    expect(h.calls[0].args).toEqual(['--install-root', 'C:\\UCCNC12115', '--profile', 'LienCNC.pro', '--board', 'auto', '--port', '9235'])
    await h.api.stopMachineBridge()
    expect(h.cleanups).toHaveLength(0)
  })
})

describe('WO-2895 packaging', () => {
  it('stages the full native runtime for the package CPU only on Linux', () => {
    const require = createRequire(import.meta.url)
    const config = require('js-yaml').load(fs.readFileSync(nativePath.resolve('electron-builder.yml'), 'utf8'))
    const { getFileMatchers } = require('app-builder-lib/out/fileMatcher.js')
    const destination = nativePath.resolve('/tmp/liencam-wo2895-package-resources')
    for (const arch of ['x64', 'arm64']) {
      const from = nativePath.resolve(`pendant/uc100net/publish/linux-${arch}`)
      for (const platform of ['linux', 'win', 'mac']) {
        const matchers = getFileMatchers(config, 'extraResources', destination, {
          defaultSrc: process.cwd(), macroExpander: (value: string) => value.replaceAll('${arch}', arch),
          customBuildOptions: config[platform], globalOutDir: nativePath.resolve('release'),
        }) as Array<{ from: string; to: string }>
        expect(matchers.filter(m => m.from === from).map(m => m.to)).toEqual(platform === 'linux'
          ? [nativePath.join(destination, `pendant/uccnc-bridge/native/linux-${arch}`)] : [])
      }
    }
    expect(config.extraResources.find((r: { from: string }) => r.from === 'pendant').filter)
      .toContain('!uc100net/**/*')
  })
})


describe('WO-2895 public release integration', () => {
  const require = createRequire(import.meta.url)
  const yaml = require('js-yaml')
  const workflow = () => yaml.load(fs.readFileSync(nativePath.resolve('release/github-workflows/release.yml'), 'utf8'))

  it('exports the native project reference and excludes generated native state', () => {
    const manifest = JSON.parse(fs.readFileSync(nativePath.resolve('tools/release/manifest.json'), 'utf8'))
    const exported = (file: string) => {
      const rule = manifest.selection.findLast((entry: { path: string }) => file === entry.path || file.startsWith(entry.path.endsWith('/') ? entry.path : `${entry.path}/`))
      return rule?.action === 'include'
    }
    for (const file of ['LICENSE', '.gitignore', 'src/Uc100Net/Uc100Net.csproj', 'src/Uc100Net/Compat/UC100.cs', 'src/Uc100Net.Tests/OracleDifferentialTests.cs']) {
      expect(exported(`pendant/uc100net/${file}`), `Public native build input missing: ${file}`).toBe(true)
    }
    for (const file of ['publish/linux-x64/liencam-bridge', 'work/private.json', 'src/Uc100Net/bin/Release/Uc100Net.dll', 'src/Uc100Net/obj/project.assets.json', 'src/Uc100Net.Tests/bin/Release/test.dll', 'src/Uc100Net.Tests/obj/project.assets.json']) {
      expect(exported(`pendant/uc100net/${file}`), `Generated native state exported: ${file}`).toBe(false)
    }
  })

  it('builds both native bundles before Linux packaging and attaches them to the draft', () => {
    const release = workflow()
    expect(release.jobs['native-bridge'], 'The draft release must build native bridge artifacts').toMatchObject({ uses: './.github/workflows/native-linux-bridge.yml' })
    const native = yaml.load(fs.readFileSync(nativePath.resolve('.github/workflows/native-linux-bridge.yml'), 'utf8'))
    expect(native.jobs['native-bridge'].strategy.matrix.rid).toEqual(['linux-x64', 'linux-arm64'])
    expect(release.jobs.linux.needs).toContain('native-bridge')
    const steps = release.jobs.linux.steps as Array<{ name: string; run?: string; with?: Record<string, string> }>
    const download = steps.findIndex(step => step.with?.name === 'native-bridge-linux-${{ matrix.arch }}')
    const stage = steps.findIndex(step => step.name === 'Stage native runtime')
    const wine = steps.findIndex(step => step.name === 'Stage reviewed Wine bridge executable')
    const pack = steps.findIndex(step => step.run?.includes('electron-builder --linux'))
    expect(download).toBeGreaterThan(-1)
    expect(stage).toBeGreaterThan(download)
    expect(wine).toBeGreaterThan(stage)
    expect(pack).toBeGreaterThan(wine)
    expect(release.jobs.release.needs).toContain('native-bridge')
    const releaseSteps = release.jobs.release.steps as Array<{ name: string; run?: string; with?: Record<string, string> }>
    expect(releaseSteps.find(step => step.with?.pattern === 'native-bridge-*')?.with?.path).toBe('release-assets')
    expect(releaseSteps.at(-1)?.run).toContain('release-assets/*')
    expect(releaseSteps.at(-1)?.run).toContain('--draft --prerelease')
  })

  // The Ubuntu release commands assert tar-preserved POSIX mode with test -x;
  // a Windows backing filesystem cannot verify that permission contract.
  it.runIf(process.platform === 'linux')('stages a complete runtime and verifies both standalone archive checksums using the release commands', () => {
    const release = workflow()
    const stage = release.jobs.linux.steps.find((step: { name: string }) => step.name === 'Stage native runtime')
    const checksums = release.jobs.release.steps.find((step: { name: string }) => step.name === 'Verify native bridge download checksums')
    expect(stage, 'Linux packaging needs the complete native runtime').toBeDefined()
    expect(checksums, 'Both native downloads need checked SHA-256 sums').toBeDefined()
    const root = fs.mkdtempSync(nativePath.join(tmpdir(), 'liencam-wo2895-release-'))
    roots.push(root)
    fs.mkdirSync(nativePath.join(root, 'payload'))
    fs.mkdirSync(nativePath.join(root, 'release-assets'))
    for (const [name, contents] of [['liencam-bridge', 'native app'], ['libcoreclr.so', 'runtime'], ['liencam-bridge.dll', 'assembly']]) {
      fs.writeFileSync(nativePath.join(root, 'payload', name), contents)
    }
    fs.chmodSync(nativePath.join(root, 'payload/liencam-bridge'), 0o755)
    for (const rid of ['linux-x64', 'linux-arm64']) execFileSync('tar', ['-C', 'payload', '-czf', `release-assets/liencam-bridge-${rid}.tar.gz`, '.'], { cwd: root })
    fs.mkdirSync(nativePath.join(root, 'native-bridge-artifact'))
    fs.copyFileSync(nativePath.join(root, 'release-assets/liencam-bridge-linux-x64.tar.gz'), nativePath.join(root, 'native-bridge-artifact/liencam-bridge-linux-x64.tar.gz'))
    const bash = '/bin/bash'
    execFileSync(bash, ['-e', '-o', 'pipefail', '-c', stage.run.replaceAll('${{ matrix.arch }}', 'x64')], { cwd: root })
    for (const name of ['liencam-bridge', 'libcoreclr.so', 'liencam-bridge.dll']) expect(fs.readFileSync(nativePath.join(root, 'pendant/uc100net/publish/linux-x64', name), 'utf8')).toBe(fs.readFileSync(nativePath.join(root, 'payload', name), 'utf8'))
    expect(fs.statSync(nativePath.join(root, 'pendant/uc100net/publish/linux-x64/liencam-bridge')).mode & 0o111).not.toBe(0)
    execFileSync(bash, ['-e', '-o', 'pipefail', '-c', checksums.run], { cwd: root })
    const sums = fs.readFileSync(nativePath.join(root, 'release-assets/native-bridge-SHA256SUMS.txt'), 'utf8')
    expect(sums.trim().split('\n')).toHaveLength(2)
    expect(sums).toContain('liencam-bridge-linux-x64.tar.gz')
    expect(sums).toContain('liencam-bridge-linux-arm64.tar.gz')
  })
})
