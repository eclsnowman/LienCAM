// @vitest-environment jsdom

import { EventEmitter } from 'node:events'
import { spawn, type ChildProcess } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import vm from 'node:vm'
import { createElement, type ComponentType } from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BridgeProcessStatus } from '../../lib/machine/bridgeHost'
import { electronMainRequire } from '../support/electronMainRequire'

const WINDOWS_TEMP_RM_OPTIONS = {
  recursive: true,
  force: true,
  maxRetries: 10,
  retryDelay: 100,
} as const

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

const { MachineDefinitionPanel } = await import('../../components/machine/MachineDefinitionPanel')
type MachineDefinitionPanelProps =
  import('../../components/machine/MachineDefinitionPanel').MachineDefinitionPanelProps
const ControllerSetupPanel = MachineDefinitionPanel as ComponentType<MachineDefinitionPanelProps>
const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useUiPrefs } = await import('../../store/uiPrefs')

const BRIDGE_SOURCE = `
using System;
using System.Net;
using System.Net.Sockets;
using System.Threading;

internal static class FirstRunBridge
{
    public static void Main(string[] args)
    {
        int port = 8325;
        for (int i = 0; i + 1 < args.Length; i++)
        {
            if (args[i] == "--port") int.TryParse(args[i + 1], out port);
        }
        TcpListener listener = new TcpListener(IPAddress.Loopback, port);
        listener.Start();
        while (true) Thread.Sleep(100);
    }
}
`

interface MainApi {
  initializeMachineBridge: () => Promise<ChildProcess | null>
  machineBridgeSocketListening: (port: number, timeoutMs?: number) => Promise<boolean>
  machineBridgeStatus: () => BridgeProcessStatus
}

// WO-1786 sidecar contract: the managed executable keeps one stable name and
// the build identity (fingerprint plus source/wrapper/compiler inputs) lives
// in machine-bridge-build.json.
interface ManagedBuildManifest {
  schemaVersion: number
  fingerprint: string
  executable: string
  inputs: {
    installRoot: string
    wrapper: { path: string; sha256: string }
    sourceFiles: Array<{ name: string; sha256: string }>
    boardFiles: Array<{ name: string; sha256: string }>
  }
}

interface MainHarness {
  api: MainApi
  spawnCalls: Array<{ executable: string; args: string[]; options: Record<string, unknown>; child: ChildProcess }>
  errors: ReturnType<typeof vi.fn>
  warnings: ReturnType<typeof vi.fn>
}

function createFixture(): {
  root: string
  resources: string
  searchRoot: string
  installRoot: string
  userData: string
} {
  const root = mkdtempSync(path.join(os.tmpdir(), 'liencam-wo1183-'))
  const resources = path.join(root, 'resources')
  const searchRoot = path.join(root, 'installs')
  const installRoot = path.join(searchRoot, 'UCCNC12115')
  const userData = path.join(root, 'user-data')
  const sources = path.join(resources, 'pendant', 'uccnc-bridge')
  const wrapper = path.join(installRoot, 'API', 'Interface')
  mkdirSync(sources, { recursive: true })
  mkdirSync(wrapper, { recursive: true })
  mkdirSync(userData, { recursive: true })
  writeFileSync(path.join(sources, 'Bridge.cs'), BRIDGE_SOURCE)
  for (const name of ['Machine.cs', 'Json.cs', 'Vfd.cs']) {
    writeFileSync(path.join(sources, name), `// bundled ${name}\n`)
  }
  writeFileSync(
    path.join(wrapper, 'UC100_wrapper.cs'),
    'namespace FakeUccnc { public sealed class WrapperStub {} }\n',
  )
  return { root, resources, searchRoot, installRoot, userData }
}

function loadMain(fixture: ReturnType<typeof createFixture>): MainHarness {
  const errors = vi.fn()
  const warnings = vi.fn()
  const spawnCalls: MainHarness['spawnCalls'] = []
  class FakeWindow extends EventEmitter {
    static getAllWindows = () => []
    webContents = { setWindowOpenHandler: vi.fn(), on: vi.fn() }
    show = vi.fn()
    loadURL = vi.fn(async () => {})
  }
  const electron = {
    app: {
      isPackaged: true,
      getPath: (name: string) => name === 'userData' ? fixture.userData : fixture.root,
      on: vi.fn(),
      quit: vi.fn(),
      whenReady: () => ({ then: () => Promise.resolve() }),
    },
    BrowserWindow: FakeWindow,
    dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) },
    ipcMain: {
      handle: vi.fn(),
      on: vi.fn(),
    },
    Menu: { setApplicationMenu: vi.fn() },
    powerSaveBlocker: { isStarted: vi.fn(() => false), start: vi.fn(() => 1), stop: vi.fn() },
    protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
  }
  const compiler = path.join(
    process.env.WINDIR ?? 'C:\\Windows',
    'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe',
  )
  const processValue = {
    ...process,
    argv: [],
    env: {
      ...process.env,
      LIENCAM_BRIDGE_EXECUTABLE: '',
      LIENCAM_BRIDGE_ARGS_JSON: '',
      LIENCAM_CSC_EXECUTABLE: compiler,
      LIENCAM_UCCNC_SEARCH_ROOT: fixture.searchRoot,
    },
    platform: 'win32',
    resourcesPath: fixture.resources,
  }
  const moduleValue = { exports: {} as MainApi }
  // WO-3059: main.cjs's sibling requires (./agentChannel.cjs) resolve against electron/.
  const realRequire = electronMainRequire
  vm.runInNewContext(readFileSync(path.resolve('electron/main.cjs'), 'utf8'), {
    AbortSignal, Buffer, Date, Promise, Response, URL,
    __dirname: path.resolve('electron'),
    clearTimeout,
    console: {
      error: errors,
      info: console.info,
      log: console.log,
      warn: warnings,
    },
    exports: moduleValue.exports,
    fetch,
    module: moduleValue,
    process: processValue,
    queueMicrotask,
    require: (id: string) => {
      if (id === 'electron') return electron
      if (id === 'node:child_process') {
        return {
          spawn: (executable: string, args: string[], options: Record<string, unknown>) => {
            const child = spawn(executable, args, options)
            spawnCalls.push({ executable, args, options, child })
            return child
          },
        }
      }
      return realRequire(id)
    },
    setTimeout,
  })
  return { api: moduleValue.exports, spawnCalls, errors, warnings }
}

async function waitForListening(api: MainApi, port = 8325): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (await api.machineBridgeSocketListening(port, 100)) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`compiled bridge did not listen on ${port}`)
}

async function stopChild(child: ChildProcess | null): Promise<void> {
  if (child === null || child.exitCode !== null) return
  await new Promise<void>((resolve) => {
    // Test teardown is intentional; do not let the app's crash supervisor respawn it.
    child.removeAllListeners('exit')
    child.once('exit', () => resolve())
    child.kill()
    setTimeout(resolve, 2_000)
  })
}

function setHost(status: BridgeProcessStatus): void {
  Object.defineProperty(window, 'liencamHost', {
    configurable: true,
    value: {
      machineBridgeStatus: async () => status,
      machineBridgeRestart: async () => ({ ok: false, reason: 'not-configured' }),
    },
  })
}

beforeEach(() => {
  mem.clear()
  useCamStore.getState().newProject()
  useCamStore.setState({ consoleEvents: [], consoleReadThroughId: 0 })
  useUiPrefs.setState({ machineLinks: {} })
  useMachineControl.getState().setConnection('disconnected', null)
  useMachineControl.getState().setBridgeHello(null)
  Reflect.deleteProperty(window, 'liencamHost')
})

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'liencamHost')
})

describe('WO-1183 packaged desktop first run', () => {
  it('builds from bundled source and the installed wrapper, places it in user data, and hosts it', async () => {
    const fixture = createFixture()
    const main = loadMain(fixture)
    let bridge: ChildProcess | null = null
    try {
      bridge = await main.api.initializeMachineBridge()
      expect(bridge).not.toBeNull()
      await waitForListening(main.api)

      expect(main.spawnCalls).toHaveLength(2)
      const compile = main.spawnCalls[0]
      expect(compile.executable.toLowerCase()).toContain('framework64')
      expect(compile.args).toContain('/target:winexe')
      expect(compile.args).toContain(path.join(
        fixture.installRoot, 'API', 'Interface', 'UC100_wrapper.cs',
      ))
      expect(compile.options).toMatchObject({
        cwd: path.join(fixture.userData, 'machine-bridge'),
        windowsHide: true,
      })

      const hosted = main.spawnCalls[1]
      // WO-1786 replaced the fingerprinted filename with one stable
      // liencam-bridge.exe in the same machine-bridge directory.
      expect(hosted.executable).toMatch(new RegExp(
        `${path.basename(fixture.userData)}[\\\\/]machine-bridge[\\\\/]liencam-bridge\\.exe$`,
        'i',
      ))
      expect(hosted.args).toEqual(['--install-root', fixture.installRoot, '--board', 'auto'])
      expect(hosted.options).toMatchObject({
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      expect(existsSync(hosted.executable)).toBe(true)
      expect(existsSync(path.join(fixture.userData, 'machine-bridge', 'machine-bridge-build.json'))).toBe(true)
      expect(existsSync(path.join(fixture.userData, 'machine-bridge', 'machine-bridge-build.log'))).toBe(true)
      const firstManifest = JSON.parse(readFileSync(
        path.join(fixture.userData, 'machine-bridge', 'machine-bridge-build.json'), 'utf8',
      )) as ManagedBuildManifest
      expect(firstManifest).toMatchObject({
        schemaVersion: 3,
        executable: 'liencam-bridge.exe',
        inputs: { installRoot: path.resolve(fixture.installRoot) },
      })
      expect(firstManifest.fingerprint).toMatch(/^[a-f0-9]{64}$/)

      const image = readFileSync(hosted.executable)
      const peHeader = image.readUInt32LE(0x3c)
      expect(image.readUInt16LE(peHeader + 24 + 68)).toBe(2)
      expect(main.api.machineBridgeStatus()).toMatchObject({
        configured: true,
        running: true,
        setup: { state: 'ready', installRoot: fixture.installRoot },
      })
    } finally {
      await stopChild(bridge)
      await rm(fixture.root, WINDOWS_TEMP_RM_OPTIONS)
    }
  }, 15_000)

  it('reuses an unchanged build and rebuilds for a new UCCNC folder or changed bundled source', async () => {
    const fixture = createFixture()
    const manifestPath = path.join(fixture.userData, 'machine-bridge', 'machine-bridge-build.json')
    const readManifest = (): ManagedBuildManifest =>
      JSON.parse(readFileSync(manifestPath, 'utf8')) as ManagedBuildManifest
    const sourceSha = (manifest: ManagedBuildManifest, name: string): string | undefined =>
      manifest.inputs.sourceFiles.find((entry) => entry.name === name)?.sha256
    let firstChild: ChildProcess | null = null
    let secondChild: ChildProcess | null = null
    let thirdChild: ChildProcess | null = null
    let fourthChild: ChildProcess | null = null
    try {
      const first = loadMain(fixture)
      firstChild = await first.api.initializeMachineBridge()
      expect(first.spawnCalls).toHaveLength(2)
      const firstExecutable = first.spawnCalls[1].executable
      const firstManifest = readManifest()
      await stopChild(firstChild)
      firstChild = null

      const second = loadMain(fixture)
      secondChild = await second.api.initializeMachineBridge()
      expect(second.spawnCalls).toHaveLength(1)
      expect(second.spawnCalls[0].executable).toBe(firstExecutable)
      await stopChild(secondChild)
      secondChild = null

      const nextInstall = path.join(fixture.searchRoot, 'UCCNC13000')
      const nextWrapper = path.join(nextInstall, 'API', 'Interface')
      mkdirSync(nextWrapper, { recursive: true })
      writeFileSync(
        path.join(nextWrapper, 'UC100_wrapper.cs'),
        'namespace FakeUccnc { public sealed class NewWrapperStub {} }\n',
      )
      writeFileSync(
        path.join(fixture.userData, 'machine-bridge-launch-settings.json'),
        JSON.stringify({ installRoot: nextInstall }),
      )
      const third = loadMain(fixture)
      thirdChild = await third.api.initializeMachineBridge()
      expect(third.spawnCalls).toHaveLength(2)
      // WO-1786: the rebuild lands on the SAME stable executable path; the
      // sidecar proves the new UCCNC folder (wrapper + install root identity)
      // invalidated the cached build instead of a filename change.
      expect(third.spawnCalls[1].executable).toBe(firstExecutable)
      expect(third.spawnCalls[1].args).toContain(nextInstall)
      const folderManifest = readManifest()
      expect(folderManifest.fingerprint).not.toBe(firstManifest.fingerprint)
      expect(folderManifest.inputs.wrapper.path).toBe(path.join(nextWrapper, 'UC100_wrapper.cs'))
      expect(folderManifest.inputs.wrapper.sha256).not.toBe(firstManifest.inputs.wrapper.sha256)
      expect(folderManifest.inputs.installRoot).toBe(path.resolve(nextInstall))
      await stopChild(thirdChild)
      thirdChild = null

      writeFileSync(
        path.join(fixture.resources, 'pendant', 'uccnc-bridge', 'Json.cs'),
        '// changed bundled Json.cs\n',
      )
      const fourth = loadMain(fixture)
      fourthChild = await fourth.api.initializeMachineBridge()
      expect(fourth.spawnCalls).toHaveLength(2)
      expect(fourth.spawnCalls[1].executable).toBe(firstExecutable)
      const changedSourceManifest = readManifest()
      expect(changedSourceManifest.fingerprint).not.toBe(folderManifest.fingerprint)
      expect(sourceSha(changedSourceManifest, 'Json.cs'))
        .not.toBe(sourceSha(folderManifest, 'Json.cs'))
      expect(sourceSha(changedSourceManifest, 'Bridge.cs'))
        .toBe(sourceSha(folderManifest, 'Bridge.cs'))
    } finally {
      await stopChild(firstChild)
      await stopChild(secondChild)
      await stopChild(thirdChild)
      await stopChild(fourthChild)
      await rm(fixture.root, WINDOWS_TEMP_RM_OPTIONS)
    }
  }, 20_000)

  it('reports the compiler first error and writes the build log path', async () => {
    const fixture = createFixture()
    writeFileSync(
      path.join(fixture.resources, 'pendant', 'uccnc-bridge', 'Bridge.cs'),
      'this is not C sharp',
    )
    try {
      const main = loadMain(fixture)
      await expect(main.api.initializeMachineBridge()).resolves.toBeNull()
      expect(main.spawnCalls).toHaveLength(1)
      expect(main.errors).toHaveBeenCalledTimes(1)
      const line = String(main.errors.mock.calls[0][0])
      const logPath = path.join(fixture.userData, 'machine-bridge', 'machine-bridge-build.log')
      expect(line).toMatch(/error CS\d+/i)
      expect(line).toContain(logPath)
      expect(existsSync(logPath)).toBe(true)
      expect(main.api.machineBridgeStatus()).toMatchObject({
        configured: false,
        setup: { state: 'failed', logPath },
      })
    } finally {
      await rm(fixture.root, WINDOWS_TEMP_RM_OPTIONS)
    }
  })

  it('reports one missing-folder console line naming the search and does not invoke the compiler', async () => {
    const fixture = createFixture()
    await rm(fixture.installRoot, WINDOWS_TEMP_RM_OPTIONS)
    try {
      const main = loadMain(fixture)
      await expect(main.api.initializeMachineBridge()).resolves.toBeNull()
      await expect(main.api.initializeMachineBridge()).resolves.toBeNull()
      expect(main.spawnCalls).toHaveLength(0)
      expect(main.warnings).toHaveBeenCalledTimes(1)
      expect(main.warnings.mock.calls[0][0]).toContain(path.join(fixture.searchRoot, 'UCCNC*'))
      expect(main.api.machineBridgeStatus()).toMatchObject({
        configured: false,
        running: false,
        setup: { state: 'missing-install', lookedFor: path.join(fixture.searchRoot, 'UCCNC*') },
      })
    } finally {
      await rm(fixture.root, WINDOWS_TEMP_RM_OPTIONS)
    }
  })
})

describe('WO-1183 Machine page and package contract', () => {
  it('shows the one-time build sentence and the detected install folder', async () => {
    setHost({
      configured: false,
      running: false,
      pid: null,
      lastExit: null,
      respawn: { attempts: 0, gaveUp: false, lastAttemptAt: null },
      setup: {
        state: 'building',
        installRoot: 'C:\\UCCNC12115',
        lookedFor: 'C:\\UCCNC*',
        logPath: 'C:\\workspace\\machine-bridge-build.log',
        error: null,
      },
    })
    render(createElement(ControllerSetupPanel, { connectionKind: 'bridge' }))

    await waitFor(() => expect(screen.getByTestId('machine-controller-bridge-state').textContent).toContain(
      'Building the machine connection for your UCCNC install...',
    ))
    expect((screen.getByTestId('machine-controller-uccnc-install-input') as HTMLInputElement).value)
      .toBe('C:\\UCCNC12115')
  })

  it('shows the editable folder field and no automatic dialog when UCCNC is missing', async () => {
    setHost({
      configured: false,
      running: false,
      pid: null,
      lastExit: null,
      respawn: { attempts: 0, gaveUp: false, lastAttemptAt: null },
      setup: {
        state: 'missing-install', installRoot: null, lookedFor: 'C:\\UCCNC*',
        logPath: null, error: null,
      },
    })
    render(createElement(ControllerSetupPanel, { connectionKind: 'bridge' }))

    await waitFor(() => expect(screen.getByTestId('machine-controller-bridge-state').textContent).toContain(
      'UCCNC was not found. Choose its install folder below.',
    ))
    expect(screen.getByTestId('machine-controller-uccnc-install-input')).toBeInstanceOf(HTMLInputElement)
    expect(screen.getByTestId('machine-controller-restart-bridge').textContent)
      .toContain('Build machine connection')
  })

  it('packages the bridge source tree while excluding bridge binaries', () => {
    const config = readFileSync(path.resolve('electron-builder.yml'), 'utf8')
    expect(config).toContain('from: pendant')
    expect(config).toContain('!uccnc-bridge/bin/**/*')
    expect(config).toContain('!uccnc-bridge/**/*.exe')
    expect(config).toContain('!uccnc-bridge/**/*.dll')
  })
})
