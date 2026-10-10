import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import * as fsPromises from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import vm from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'

const MANAGED_EXE = 'liencam-bridge.exe'
const MANIFEST = 'machine-bridge-build.json'
const WINDOWS_TEMP_RM_OPTIONS = {
  recursive: true,
  force: true,
  maxRetries: 10,
  retryDelay: 100,
} as const

class FakeChild extends EventEmitter {
  exitCode: number | null = null
  pid: number
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  kill = vi.fn(() => {
    queueMicrotask(() => this.finish(0))
    return true
  })

  constructor(pid: number) {
    super()
    this.pid = pid
  }

  finish(code: number | null, signal: string | null = null): void {
    if (this.exitCode !== null) return
    this.exitCode = code
    this.emit('exit', code, signal)
  }
}

interface Fixture {
  root: string
  resources: string
  sourceDirectory: string
  sourceBoardsDirectory: string
  searchRoot: string
  installRoot: string
  wrapper: string
  compiler: string
  userData: string
  managedDirectory: string
  managedBoardsDirectory: string
  executable: string
  manifest: string
}

interface MainApi {
  initializeMachineBridge: () => Promise<FakeChild | null>
  machineBridgeStatus: () => {
    configured: boolean
    running: boolean
    lastExit: { error: string | null } | null
    respawn: { gaveUp: boolean }
    setup: { state: string; error: string | null; logPath: string | null }
  }
  restartMachineBridge: (settings?: Record<string, unknown>) => Promise<Record<string, unknown>>
  stopMachineBridge: () => Promise<boolean>
}

interface LoadOptions {
  compilerMode?: 'success' | 'missing-output' | 'failure'
  failReplacement?: boolean
  failBoardReplacement?: boolean
  removeAfterReplacement?: boolean
  explicitExecutable?: string
  board?: number | 'auto'
  backgroundWriteGate?: Promise<void>
}

function createFixture(): Fixture {
  const root = mkdtempSync(path.join(os.tmpdir(), 'liencam-wo1786-'))
  const resources = path.join(root, 'resources')
  const sourceDirectory = path.join(resources, 'pendant', 'uccnc-bridge')
  const sourceBoardsDirectory = path.join(sourceDirectory, 'boards')
  const searchRoot = path.join(root, 'installs')
  const installRoot = path.join(searchRoot, 'UCCNC12115')
  const wrapper = path.join(installRoot, 'API', 'Interface', 'UC100_wrapper.cs')
  const compiler = path.join(root, 'compiler-fixture.exe')
  const userData = path.join(root, 'user-data')
  const managedDirectory = path.join(userData, 'machine-bridge')
  const managedBoardsDirectory = path.join(managedDirectory, 'boards')
  mkdirSync(sourceBoardsDirectory, { recursive: true })
  mkdirSync(path.dirname(wrapper), { recursive: true })
  mkdirSync(userData, { recursive: true })
  for (const name of ['Bridge.cs', 'Machine.cs', 'Json.cs', 'Vfd.cs']) {
    writeFileSync(path.join(sourceDirectory, name), `// ${name} fixture v1\n`)
  }
  writeFileSync(wrapper, '// wrapper fixture v1\n')
  writeFileSync(compiler, 'compiler fixture v1\n')
  writeFileSync(path.join(sourceBoardsDirectory, 'fixture-board.json'), '{"version":1}\n')
  return {
    root,
    resources,
    sourceDirectory,
    sourceBoardsDirectory,
    searchRoot,
    installRoot,
    wrapper,
    compiler,
    userData,
    managedDirectory,
    managedBoardsDirectory,
    executable: path.join(managedDirectory, MANAGED_EXE),
    manifest: path.join(managedDirectory, MANIFEST),
  }
}

function listeningNet() {
  return {
    createConnection() {
      const socket = new EventEmitter() as EventEmitter & {
        destroy: () => void
        setTimeout: (_timeout: number, _listener: () => void) => void
      }
      socket.destroy = () => {}
      socket.setTimeout = () => {}
      queueMicrotask(() => socket.emit('connect'))
      return socket
    },
  }
}

function compiledBytes(fixture: Fixture): Buffer {
  const hash = createHash('sha256')
  for (const name of ['Bridge.cs', 'Machine.cs', 'Json.cs', 'Vfd.cs']) {
    hash.update(readFileSync(path.join(fixture.sourceDirectory, name)))
  }
  hash.update(readFileSync(fixture.wrapper))
  hash.update(readFileSync(fixture.compiler))
  return Buffer.from(`isolated bridge fixture ${hash.digest('hex')}\n`)
}

function loadMain(fixture: Fixture, options: LoadOptions = {}): {
  api: MainApi
  compileCalls: Array<{ args: string[] }>
  launchCalls: Array<{ executable: string; args: string[]; child: FakeChild }>
  errors: ReturnType<typeof vi.fn>
  warnings: ReturnType<typeof vi.fn>
  drainWrites: () => Promise<void>
} {
  const pendingWrites = new Set<Promise<void>>()
  function trackWrite(write: () => Promise<void>): Promise<void> {
    const pending = write()
    pendingWrites.add(pending)
    void pending.then(
      () => pendingWrites.delete(pending),
      () => pendingWrites.delete(pending),
    )
    return pending
  }
  async function drainWrites(): Promise<void> {
    do {
      await Promise.allSettled([...pendingWrites])
      // Let the settings chain enqueue its next write before checking again.
      await new Promise<void>((resolve) => setImmediate(resolve))
    } while (pendingWrites.size > 0)
  }
  const compileCalls: Array<{ args: string[] }> = []
  const launchCalls: Array<{ executable: string; args: string[]; child: FakeChild }> = []
  const errors = vi.fn()
  const warnings = vi.fn()
  let childId = 7000
  let removedAfterReplacement = false

  const electron = {
    app: {
      isPackaged: true,
      getPath: (name: string) => name === 'userData' ? fixture.userData : fixture.root,
      on: vi.fn(),
      quit: vi.fn(),
      whenReady: () => ({ then: () => Promise.resolve() }),
    },
    BrowserWindow: class { static getAllWindows = () => [] },
    dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) },
    ipcMain: { handle: vi.fn(), on: vi.fn() },
    Menu: { setApplicationMenu: vi.fn() },
    powerSaveBlocker: { isStarted: vi.fn(() => false), start: vi.fn(() => 1), stop: vi.fn() },
    protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
  }
  const realRequire = createRequire(import.meta.url)
  const processValue = {
    ...process,
    argv: [],
    env: {
      ...process.env,
      LIENCAM_BRIDGE_EXECUTABLE: options.explicitExecutable ?? '',
      LIENCAM_BRIDGE_ARGS_JSON: '',
      LIENCAM_CSC_EXECUTABLE: fixture.compiler,
      LIENCAM_UCCNC_SEARCH_ROOT: fixture.searchRoot,
    },
    platform: 'win32',
    resourcesPath: fixture.resources,
  }
  const wrappedPromises = {
    ...fsPromises,
    writeFile: (...args: Parameters<typeof fsPromises.writeFile>) => trackWrite(async () => {
      if (path.basename(String(args[0])) === 'machine-bridge-launch-settings.json') {
        await options.backgroundWriteGate
      }
      await fsPromises.writeFile(...args)
    }),
    appendFile: (...args: Parameters<typeof fsPromises.appendFile>) => trackWrite(async () => {
      await options.backgroundWriteGate
      await fsPromises.appendFile(...args)
    }),
    rename: async (from: string, to: string) => {
      const fromPath = String(from)
      const toPath = String(to)
      if (options.failReplacement
          && fromPath.includes('liencam-bridge.pending-')
          && toPath === fixture.executable) {
        throw new Error('injected atomic replacement failure')
      }
      if (options.failBoardReplacement
          && fromPath.includes('boards.pending-')
          && toPath === fixture.managedBoardsDirectory) {
        throw new Error('injected board replacement failure')
      }
      await fsPromises.rename(from, to)
      if (options.removeAfterReplacement
          && !removedAfterReplacement
          && toPath === fixture.executable) {
        removedAfterReplacement = true
        queueMicrotask(() => rmSync(fixture.executable, { force: true }))
      }
    },
  }
  const moduleValue = { exports: {} as MainApi }
  vm.runInNewContext(readFileSync(path.resolve('electron/main.cjs'), 'utf8'), {
    AbortSignal,
    Buffer,
    Date,
    Promise,
    Response,
    URL,
    __dirname: path.resolve('electron'),
    clearTimeout,
    console: { error: errors, info: vi.fn(), log: vi.fn(), warn: warnings },
    exports: moduleValue.exports,
    fetch,
    module: moduleValue,
    process: processValue,
    queueMicrotask,
    require: (id: string) => {
      if (id === 'electron') return electron
      if (id === 'node:fs/promises') return wrappedPromises
      if (id === 'node:net') return listeningNet()
      if (id === 'node:child_process') {
        return {
          execFile: vi.fn(),
          spawn: (executable: string, args: string[]) => {
            const child = new FakeChild(childId++)
            if (executable === fixture.compiler) {
              compileCalls.push({ args: [...args] })
              queueMicrotask(() => {
                const output = args.find((arg) => arg.startsWith('/out:'))?.slice(5)
                if (options.compilerMode === 'failure') {
                  child.stderr.emit('data', 'error CS9999: fixture compiler failure\n')
                  child.finish(1)
                  return
                }
                if (options.compilerMode !== 'missing-output' && output) {
                  writeFileSync(output, compiledBytes(fixture))
                }
                child.finish(0)
              })
              return child
            }
            launchCalls.push({ executable, args: [...args], child })
            return child
          },
        }
      }
      return realRequire(id)
    },
    setTimeout,
  })
  const runtime = { api: moduleValue.exports, compileCalls, launchCalls, errors, warnings, drainWrites }
  runtimes.push(runtime)
  return runtime
}

async function stop(runtime: ReturnType<typeof loadMain>): Promise<void> {
  await runtime.api.stopMachineBridge()
  await runtime.drainWrites()
}

const fixtures: string[] = []
const runtimes: ReturnType<typeof loadMain>[] = []
afterEach(async () => {
  // stopMachineBridge clears process timers but does not await the settings
  // write (main.cjs:117) or missing-artifact log append (main.cjs:1047).
  for (const runtime of runtimes.splice(0)) await stop(runtime)
  for (const fixture of fixtures.splice(0)) rmSync(fixture, WINDOWS_TEMP_RM_OPTIONS)
  vi.restoreAllMocks()
})

function fixture(): Fixture {
  const value = createFixture()
  fixtures.push(value.root)
  return value
}

describe('WO-1786 managed bridge distribution integrity', () => {
  it.each(['settings', 'before spawn', 'process exit'] as const)(
    'drains delayed background writes from the %s route before cleanup', async (route) => {
      const files = fixture()
      let release!: () => void
      const backgroundWriteGate = new Promise<void>((resolve) => { release = resolve })
      const runtime = loadMain(files, {
        backgroundWriteGate,
        removeAfterReplacement: route === 'before spawn',
      })
      let drained = false
      let draining: Promise<void> | undefined
      try {
        const child = await runtime.api.initializeMachineBridge()
        if (route === 'process exit') {
          rmSync(files.executable)
          child!.finish(9)
        } else if (route === 'settings') {
          // Queue a second persistence behind the still-blocked startup write.
          await runtime.api.restartMachineBridge({ installRoot: files.installRoot, board: 7 })
        }
        draining = stop(runtime).then(() => { drained = true })
        await new Promise<void>((resolve) => setImmediate(resolve))
        expect(drained).toBe(false)
        expect(existsSync(files.userData)).toBe(true)
      } finally {
        release()
        await draining
      }
      if (route === 'settings') {
        expect(JSON.parse(readFileSync(path.join(files.userData, 'machine-bridge-launch-settings.json'), 'utf8')))
          .toMatchObject({ installRoot: files.installRoot, board: 7 })
      } else {
        expect(readFileSync(path.join(files.managedDirectory, 'machine-bridge-build.log'), 'utf8'))
          .toContain(`route: ${route}`)
      }
      expect(runtime.warnings).not.toHaveBeenCalled()
    },
  )

  it('uses the real no-env startup route, one stable path, and attributable identities', async () => {
    const files = fixture()
    const runtime = loadMain(files)
    const child = await runtime.api.initializeMachineBridge()
    expect(child).not.toBeNull()
    expect(runtime.compileCalls).toHaveLength(1)
    expect(runtime.launchCalls).toHaveLength(1)
    expect(runtime.launchCalls[0]).toMatchObject({
      executable: files.executable,
      args: ['--install-root', files.installRoot, '--board', 'auto'],
    })
    const compileArgs = runtime.compileCalls[0].args
    expect(compileArgs).toContain('/unsafe')
    expect(compileArgs).toContain('/platform:x64')
    expect(compileArgs).toContain('/target:winexe')
    expect(compileArgs).toContain(files.wrapper)

    const manifest = JSON.parse(readFileSync(files.manifest, 'utf8'))
    expect(manifest).toMatchObject({
      schemaVersion: 3,
      executable: MANAGED_EXE,
      installRoot: files.installRoot,
      artifactState: 'ready',
      inputs: {
        wrapper: { path: files.wrapper },
        compiler: { path: files.compiler },
      },
    })
    expect(manifest.inputs.sourceFiles.map((entry: { name: string }) => entry.name)).toEqual([
      'Bridge.cs', 'Machine.cs', 'Json.cs', 'Vfd.cs',
    ])
    expect(manifest.inputs.boardFiles).toMatchObject([
      { name: 'fixture-board.json', path: path.join(files.sourceBoardsDirectory, 'fixture-board.json') },
    ])
    expect(readFileSync(path.join(files.managedBoardsDirectory, 'fixture-board.json'), 'utf8'))
      .toBe('{"version":1}\n')
    expect(manifest.fingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(manifest.executableIdentity.sha256).toBe(
      createHash('sha256').update(readFileSync(files.executable)).digest('hex'),
    )
    await stop(runtime)
  })

  it('reuses unchanged output and invalidates on source, wrapper, and compiler changes', async () => {
    const files = fixture()
    const first = loadMain(files)
    await first.api.initializeMachineBridge()
    const identities = [JSON.parse(readFileSync(files.manifest, 'utf8')).fingerprint]
    await stop(first)

    writeFileSync(path.join(files.managedBoardsDirectory, 'fixture-board.json'), '{"stale":true}\n')
    const unchanged = loadMain(files)
    await unchanged.api.initializeMachineBridge()
    expect(unchanged.compileCalls).toHaveLength(0)
    expect(unchanged.launchCalls[0].executable).toBe(files.executable)
    expect(readFileSync(path.join(files.managedBoardsDirectory, 'fixture-board.json'), 'utf8'))
      .toBe('{"version":1}\n')
    await stop(unchanged)

    for (const changedPath of [
      path.join(files.sourceBoardsDirectory, 'fixture-board.json'),
      path.join(files.sourceDirectory, 'Json.cs'),
      files.wrapper,
      files.compiler,
    ]) {
      writeFileSync(changedPath, `${readFileSync(changedPath, 'utf8')}changed\n`)
      const changed = loadMain(files)
      await changed.api.initializeMachineBridge()
      expect(changed.compileCalls).toHaveLength(1)
      expect(changed.launchCalls[0].executable).toBe(files.executable)
      identities.push(JSON.parse(readFileSync(files.manifest, 'utf8')).fingerprint)
      await stop(changed)
    }
    expect(new Set(identities).size).toBe(5)
    expect(readFileSync(path.join(files.managedBoardsDirectory, 'fixture-board.json'), 'utf8'))
      .toContain('changed')
  })

  it('refreshes added, changed, and removed shipped boards while preserving user files', async () => {
    const files = fixture()
    writeFileSync(path.join(files.sourceBoardsDirectory, 'removed-board.json'), '{"remove":true}\n')
    const built = loadMain(files)
    await built.api.initializeMachineBridge()
    await stop(built)
    writeFileSync(path.join(files.managedBoardsDirectory, 'custom-board.json'), '{"custom":true}\n')

    writeFileSync(path.join(files.sourceBoardsDirectory, 'fixture-board.json'), '{"version":2}\n')
    rmSync(path.join(files.sourceBoardsDirectory, 'removed-board.json'))
    writeFileSync(path.join(files.sourceBoardsDirectory, 'added-board.json'), '{"added":true}\n')
    const refreshed = loadMain(files)
    await refreshed.api.initializeMachineBridge()
    expect(refreshed.compileCalls).toHaveLength(1)
    expect(readFileSync(path.join(files.managedBoardsDirectory, 'fixture-board.json'), 'utf8'))
      .toBe('{"version":2}\n')
    expect(readFileSync(path.join(files.managedBoardsDirectory, 'added-board.json'), 'utf8'))
      .toBe('{"added":true}\n')
    expect(existsSync(path.join(files.managedBoardsDirectory, 'removed-board.json'))).toBe(false)
    expect(readFileSync(path.join(files.managedBoardsDirectory, 'custom-board.json'), 'utf8'))
      .toBe('{"custom":true}\n')
    await stop(refreshed)
  })

  it('keeps the built-in board route available when no shipped boards directory exists', async () => {
    const files = fixture()
    rmSync(files.sourceBoardsDirectory, { recursive: true })
    const runtime = loadMain(files)
    await runtime.api.initializeMachineBridge()
    expect(runtime.compileCalls).toHaveLength(1)
    expect(runtime.launchCalls[0].args).toEqual([
      '--install-root', files.installRoot, '--board', 'auto',
    ])
    expect(JSON.parse(readFileSync(files.manifest, 'utf8')).inputs.boardFiles).toEqual([])
    await stop(runtime)
  })

  it('does not auto-rebuild an unchanged missing artifact, then permits one deliberate recovery', async () => {
    const files = fixture()
    const built = loadMain(files)
    await built.api.initializeMachineBridge()
    await stop(built)
    rmSync(files.executable)

    const automatic = loadMain(files)
    await expect(automatic.api.initializeMachineBridge()).resolves.toBeNull()
    expect(automatic.compileCalls).toHaveLength(0)
    expect(automatic.launchCalls).toHaveLength(0)
    expect(automatic.api.machineBridgeStatus().setup).toMatchObject({
      state: 'failed',
      logPath: path.join(files.managedDirectory, 'machine-bridge-build.log'),
    })
    expect(automatic.api.machineBridgeStatus().setup.error).toContain('No antivirus cause was inferred')
    expect(JSON.parse(readFileSync(files.manifest, 'utf8')).artifactState).toBe('missing')

    await expect(automatic.api.restartMachineBridge({
      installRoot: files.installRoot,
      board: 7,
    })).resolves.toMatchObject({ ok: true })
    expect(automatic.compileCalls).toHaveLength(1)
    expect(automatic.launchCalls[0]).toMatchObject({
      executable: files.executable,
      args: ['--install-root', files.installRoot, '--board', '7'],
    })
    await stop(automatic)
  })

  it('detects unexpected executable bytes without launching or silently trusting them', async () => {
    const files = fixture()
    const built = loadMain(files)
    await built.api.initializeMachineBridge()
    await stop(built)
    writeFileSync(files.executable, 'unattributed replacement\n')

    const automatic = loadMain(files)
    await expect(automatic.api.initializeMachineBridge()).resolves.toBeNull()
    expect(automatic.compileCalls).toHaveLength(0)
    expect(automatic.launchCalls).toHaveLength(0)
    expect(automatic.api.machineBridgeStatus().setup.error).toContain(
      'no longer matches its recorded build identity',
    )
    expect(JSON.parse(readFileSync(files.manifest, 'utf8')).artifactState)
      .toBe('identity-mismatch')
  })

  it('keeps the old executable and manifest when atomic replacement fails', async () => {
    const files = fixture()
    const built = loadMain(files)
    await built.api.initializeMachineBridge()
    await stop(built)
    const oldExecutable = readFileSync(files.executable)
    const oldManifest = readFileSync(files.manifest)
    writeFileSync(path.join(files.sourceDirectory, 'Bridge.cs'), '// changed source\n')

    const failed = loadMain(files, { failReplacement: true })
    await expect(failed.api.initializeMachineBridge()).resolves.toBeNull()
    expect(failed.compileCalls).toHaveLength(1)
    expect(failed.launchCalls).toHaveLength(0)
    expect(readFileSync(files.executable)).toEqual(oldExecutable)
    expect(readFileSync(files.manifest)).toEqual(oldManifest)
    expect(failed.api.machineBridgeStatus().setup.error).toContain(
      'injected atomic replacement failure',
    )
  })

  it('rolls back executable, manifest, and managed boards when board replacement fails', async () => {
    const files = fixture()
    const built = loadMain(files)
    await built.api.initializeMachineBridge()
    await stop(built)
    const oldExecutable = readFileSync(files.executable)
    const oldManifest = readFileSync(files.manifest)
    const oldBoard = readFileSync(path.join(files.managedBoardsDirectory, 'fixture-board.json'))
    writeFileSync(path.join(files.sourceBoardsDirectory, 'fixture-board.json'), '{"version":2}\n')

    const failed = loadMain(files, { failBoardReplacement: true })
    await expect(failed.api.initializeMachineBridge()).resolves.toBeNull()
    expect(failed.compileCalls).toHaveLength(1)
    expect(failed.launchCalls).toHaveLength(0)
    expect(readFileSync(files.executable)).toEqual(oldExecutable)
    expect(readFileSync(files.manifest)).toEqual(oldManifest)
    expect(readFileSync(path.join(files.managedBoardsDirectory, 'fixture-board.json')))
      .toEqual(oldBoard)
    expect(failed.api.machineBridgeStatus().setup.error).toContain(
      'injected board replacement failure',
    )
  })

  it('reports a compiler success with no output and never launches an old or absent binary', async () => {
    const files = fixture()
    const runtime = loadMain(files, { compilerMode: 'missing-output' })
    await expect(runtime.api.initializeMachineBridge()).resolves.toBeNull()
    expect(runtime.compileCalls).toHaveLength(1)
    expect(runtime.launchCalls).toHaveLength(0)
    expect(existsSync(files.executable)).toBe(false)
    expect(runtime.api.machineBridgeStatus().setup).toMatchObject({ state: 'failed' })
    expect(runtime.errors.mock.calls.at(-1)?.[0]).toContain('build failed')
  })

  it('catches disappearance after replacement but before spawn and does not loop', async () => {
    const files = fixture()
    const runtime = loadMain(files, { removeAfterReplacement: true })
    await expect(runtime.api.initializeMachineBridge()).resolves.toBeNull()
    expect(runtime.compileCalls).toHaveLength(1)
    expect(runtime.launchCalls).toHaveLength(0)
    expect(runtime.api.machineBridgeStatus()).toMatchObject({
      configured: false,
      running: false,
      respawn: { gaveUp: true },
      setup: { state: 'failed' },
    })
    expect(runtime.api.machineBridgeStatus().lastExit?.error).toContain('is missing at')
  })

  it('stops respawn when the managed executable disappears before process exit', async () => {
    const files = fixture()
    const runtime = loadMain(files)
    const child = await runtime.api.initializeMachineBridge()
    expect(child).not.toBeNull()
    rmSync(files.executable)
    child!.finish(9)
    await Promise.resolve()
    expect(runtime.launchCalls).toHaveLength(1)
    expect(runtime.api.machineBridgeStatus()).toMatchObject({
      running: false,
      respawn: { gaveUp: true },
      setup: { state: 'failed' },
    })
    expect(runtime.api.machineBridgeStatus().lastExit?.error).toContain('is missing at')
  })

  it('preserves the explicit executable override and deliberate board selection', async () => {
    const files = fixture()
    const explicit = path.join(files.root, 'canonical-bridge.exe')
    writeFileSync(explicit, 'explicit fixture\n')
    const runtime = loadMain(files, { explicitExecutable: explicit })
    await expect(runtime.api.restartMachineBridge({
      installRoot: files.installRoot,
      board: 12,
    })).resolves.toMatchObject({ ok: true })
    expect(runtime.compileCalls).toHaveLength(0)
    expect(runtime.launchCalls[0]).toMatchObject({
      executable: explicit,
      args: ['--install-root', files.installRoot, '--board', '12'],
    })
    await stop(runtime)
  })
})
