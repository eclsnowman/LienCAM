// @vitest-environment jsdom

import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import net from 'node:net'
import nodePath from 'node:path'
import nodeProcess from 'node:process'
import vm from 'node:vm'
import { createElement, type ComponentType } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  bridgeHostCapability,
  bridgeProcessStatus,
  restartBridge,
  type BridgeProcessStatus,
  type BridgeRestartResult,
} from '../../lib/machine/bridgeHost'

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

// WO-1213: keep browser-host detection away from the shared 8326 supervisor.
// The pid and file salt allocate this file its own per-worker bridge port.
const TEST_BRIDGE_PORT = 20_000 + ((nodeProcess.pid * 17 + 1132) % 20_000)

interface TestHost {
  machineBridgeStatus?: () => Promise<BridgeProcessStatus>
  machineBridgeRestart?: () => Promise<BridgeRestartResult>
}

function setHost(host: TestHost | undefined): void {
  if (host === undefined) {
    Reflect.deleteProperty(window, 'liencamHost')
    return
  }
  Object.defineProperty(window, 'liencamHost', {
    configurable: true,
    value: host,
  })
}

function configuredStatus(configured = true): BridgeProcessStatus {
  return {
    configured,
    running: configured,
    pid: configured ? 7312 : null,
    lastExit: null,
    respawn: { attempts: 0, gaveUp: false, lastAttemptAt: null },
  }
}

class FakeChild extends EventEmitter {
  exitCode: number | null = null
  killed = false
  pid: number
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  private readonly stopsOnKill: boolean
  kill = vi.fn((_signal?: string) => {
    this.killed = true
    if (this.stopsOnKill) queueMicrotask(() => this.crash(0, null))
    return true
  })

  constructor(pid: number, stopsOnKill: boolean) {
    super()
    this.pid = pid
    this.stopsOnKill = stopsOnKill
  }

  crash(code: number | null = 1, signal: string | null = null): void {
    if (this.exitCode !== null) return
    this.exitCode = code
    this.emit('exit', code, signal)
  }

  writeStdout(line: string): void {
    this.stdout.emit('data', `${line}\n`)
  }
}

interface MainRuntime {
  api: {
    machineBridgeRespawnDecision: (attempts: number) => {
      respawn: boolean
      delayMs: number | null
      gaveUp: boolean
    }
    machineBridgeSocketListening: (port: number, timeoutMs?: number) => Promise<boolean>
    machineBridgePort: (spec: { args: string[] }) => number
    machineBridgeStatus: () => BridgeProcessStatus
    restartMachineBridge: () => Promise<BridgeRestartResult>
    startMachineBridge: () => FakeChild | null
    stopMachineBridge: () => Promise<boolean>
  }
  children: FakeChild[]
  ipcHandlers: Map<string, (event: { sender: unknown }) => unknown>
  windows: Array<{ webContents: object }>
}

function refusingNet() {
  return {
    createConnection() {
      const socket = new EventEmitter() as EventEmitter & {
        destroy: () => void
        setTimeout: (timeout: number, listener: () => void) => void
      }
      socket.destroy = () => {}
      socket.setTimeout = (_timeout, _listener) => {}
      queueMicrotask(() => socket.emit('error', new Error('ECONNREFUSED')))
      return socket
    },
  }
}

function loadMain({
  args = [],
  autoReady = false,
  childStopsOnKill = true,
  configured = true,
  netModule,
}: {
  args?: string[]
  autoReady?: boolean
  childStopsOnKill?: boolean
  configured?: boolean
  netModule?: ReturnType<typeof refusingNet>
} = {}): MainRuntime {
  const children: FakeChild[] = []
  const ipcHandlers = new Map<string, (event: { sender: unknown }) => unknown>()
  const windows: Array<{ webContents: object }> = []
  class FakeWindow {
    webContents = {
      setWindowOpenHandler: vi.fn(),
      on: vi.fn(),
    }
    constructor(_options: unknown) { windows.push(this) }
    once = vi.fn()
    show = vi.fn()
    loadURL = vi.fn(async () => {})
    static getAllWindows = () => windows
  }
  const electron = {
    app: {
      isPackaged: false,
      on: vi.fn(),
      quit: vi.fn(),
      whenReady: () => ({
        then: (listener: () => void) => {
          if (autoReady) listener()
          return Promise.resolve()
        },
      }),
    },
    BrowserWindow: FakeWindow,
    ipcMain: {
      handle: (channel: string, listener: (event: { sender: unknown }) => unknown) => {
        ipcHandlers.set(channel, listener)
      },
      on: vi.fn(),
    },
    Menu: { setApplicationMenu: vi.fn() },
    powerSaveBlocker: { isStarted: vi.fn(() => false), start: vi.fn(() => 1), stop: vi.fn() },
    protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
  }
  const processValue = {
    ...nodeProcess,
    argv: [],
    env: {
      ...nodeProcess.env,
      LIENCAM_BRIDGE_EXECUTABLE: configured ? 'C:\\fake\\liencam-bridge.exe' : '',
      LIENCAM_BRIDGE_ARGS_JSON: JSON.stringify(args),
    },
    platform: 'win32',
    resourcesPath: nodePath.resolve('.tmp-wo1132-resources'),
  }
  const moduleValue = { exports: {} as MainRuntime['api'] }
  const realRequire = createRequire(import.meta.url)
  const code = readFileSync(nodePath.resolve('electron/main.cjs'), 'utf8')
  vm.runInNewContext(code, {
    AbortSignal,
    Buffer,
    Date,
    Promise,
    Response,
    URL,
    __dirname: nodePath.resolve('electron'),
    clearTimeout,
    console,
    exports: moduleValue.exports,
    fetch,
    module: moduleValue,
    process: processValue,
    queueMicrotask,
    require: (id: string) => {
      if (id === 'electron') return electron
      if (id === 'node:child_process') {
        return {
          spawn: vi.fn(() => {
            const child = new FakeChild(4100 + children.length, childStopsOnKill)
            children.push(child)
            return child
          }),
        }
      }
      if (id === 'node:net' && netModule) return netModule
      return realRequire(id)
    },
    setTimeout,
  })
  return { api: moduleValue.exports, children, ipcHandlers, windows }
}

async function listeningServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = net.createServer((socket) => socket.end())
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('TCP server has no numeric port')
  return {
    port: address.port,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    }),
  }
}

beforeEach(() => {
  mem.clear()
  useCamStore.getState().newProject()
  useCamStore.setState({ consoleEvents: [], consoleReadThroughId: 0 })
  const machineId = useCamStore.getState().project.machine.id
  useUiPrefs.setState({ machineLinks: { [machineId]: { bridgePort: TEST_BRIDGE_PORT } } })
  useMachineControl.getState().setConnection('disconnected', null)
  useMachineControl.getState().setBridgeHello(null)
  setHost(undefined)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  setHost(undefined)
})

describe('WO-1132 renderer host capability', () => {
  it('treats a missing host and an old preload without restart as unhosted', async () => {
    expect(bridgeHostCapability()).toBe('unhosted')
    expect(await bridgeProcessStatus(TEST_BRIDGE_PORT)).toBeNull()
    await expect(restartBridge(TEST_BRIDGE_PORT)).resolves.toEqual({ ok: false, reason: 'unhosted' })

    setHost({ machineBridgeStatus: async () => configuredStatus() })
    expect(bridgeHostCapability()).toBe('unhosted')
    expect(await bridgeProcessStatus(TEST_BRIDGE_PORT)).toBeNull()
    await expect(restartBridge(TEST_BRIDGE_PORT)).resolves.toEqual({ ok: false, reason: 'unhosted' })
  })

  it('uses the feature-detected restart method as the one hosted door', async () => {
    const status = configuredStatus()
    const result = { ok: true as const, pid: 9001, port: 8325 }
    const machineBridgeStatus = vi.fn(async () => status)
    const machineBridgeRestart = vi.fn(async () => result)
    setHost({ machineBridgeStatus, machineBridgeRestart })

    expect(bridgeHostCapability()).toBe('hosted')
    await expect(bridgeProcessStatus()).resolves.toEqual(status)
    await expect(restartBridge()).resolves.toEqual(result)
    expect(machineBridgeStatus).toHaveBeenCalledTimes(1)
    expect(machineBridgeRestart).toHaveBeenCalledTimes(1)
  })
})

describe('WO-1132 Electron bridge lifecycle', () => {
  it('derives the bridge port from spawn args and proves a real listening TCP socket', async () => {
    const runtime = loadMain()
    const server = await listeningServer()
    try {
      expect(runtime.api.machineBridgePort({ args: ['--port', String(server.port)] })).toBe(server.port)
      expect(runtime.api.machineBridgePort({ args: [] })).toBe(8325)
      await expect(runtime.api.machineBridgeSocketListening(server.port, 250)).resolves.toBe(true)
    } finally {
      await server.close()
    }
    await expect(runtime.api.machineBridgeSocketListening(server.port, 50)).resolves.toBe(false)
  })

  it('reports restart success only after the configured port really listens', async () => {
    const server = await listeningServer()
    try {
      const runtime = loadMain({ args: ['--port', String(server.port)] })
      await expect(runtime.api.restartMachineBridge()).resolves.toEqual({
        ok: true,
        pid: 4100,
        port: server.port,
      })
      expect(runtime.children).toHaveLength(1)
    } finally {
      await server.close()
    }
  })

  it('reports not-configured without spawning or claiming a restart', async () => {
    const runtime = loadMain({ configured: false })
    await expect(runtime.api.restartMachineBridge()).resolves.toEqual({
      ok: false,
      reason: 'not-configured',
    })
    expect(runtime.children).toHaveLength(0)
  })

  it('reports no-socket after the deadline and never turns that into success', async () => {
    vi.useFakeTimers()
    const runtime = loadMain({ args: ['--port', '63251'], netModule: refusingNet() })
    const pending = runtime.api.restartMachineBridge()
    let settled = false
    void pending.then(() => { settled = true })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(15_000)
    await expect(pending).resolves.toEqual({
      ok: false,
      reason: 'no-socket',
      pid: 4100,
      port: 63251,
    })
    expect(runtime.children).toHaveLength(1)
  })

  it('reports an immediate restart exit with lastExit and does not respawn it', async () => {
    const runtime = loadMain({ netModule: refusingNet() })
    const pending = runtime.api.restartMachineBridge()
    await Promise.resolve()
    runtime.children[0].crash(23, null)
    await expect(pending).resolves.toEqual({
      ok: false,
      reason: 'exited',
      lastExit: { code: 23, signal: null, error: null },
    })
    await new Promise((resolve) => setTimeout(resolve, 1_100))
    expect(runtime.children).toHaveLength(1)
  })

  it('reports an immediate restart exit with the bridge own last line', async () => {
    const runtime = loadMain({ netModule: refusingNet() })
    const pending = runtime.api.restartMachineBridge()
    await Promise.resolve()
    runtime.children[0].writeStdout('[bridge] could not open the controller - exiting')
    runtime.children[0].crash(2, null)

    await expect(pending).resolves.toEqual({
      ok: false,
      reason: 'exited',
      lastExit: {
        code: 2,
        signal: null,
        error: '[bridge] could not open the controller - exiting',
      },
    })
  })

  it('stops an existing bridge intentionally and starts exactly one replacement', async () => {
    vi.useFakeTimers()
    const runtime = loadMain({ args: ['--port', '63252'], netModule: refusingNet() })
    runtime.api.startMachineBridge()
    const original = runtime.children[0]

    const pending = runtime.api.restartMachineBridge()
    await vi.advanceTimersByTimeAsync(25_000)
    await expect(pending).resolves.toMatchObject({ ok: false, reason: 'no-socket', port: 63252 })
    expect(original.kill).toHaveBeenCalledTimes(1)
    expect(runtime.children).toHaveLength(2)

    await vi.advanceTimersByTimeAsync(20_000)
    expect(runtime.children).toHaveLength(2)
  })

  it('refuses to start a replacement if the previous bridge survives the hard stop', async () => {
    vi.useFakeTimers()
    const runtime = loadMain({ childStopsOnKill: false })
    runtime.api.startMachineBridge()

    const pending = runtime.api.restartMachineBridge()
    await vi.advanceTimersByTimeAsync(6_000)
    await expect(pending).resolves.toEqual({
      ok: false,
      reason: 'exited',
      lastExit: {
        code: null,
        signal: 'SIGKILL',
        error: 'The previous bridge did not exit after it was killed.',
      },
    })
    expect(runtime.children).toHaveLength(1)
    expect(runtime.children[0].kill).toHaveBeenCalledTimes(2)
  })

  it('respawns unintentional exits after 1s, 2s, and 4s, then gives up', async () => {
    vi.useFakeTimers()
    const runtime = loadMain()
    expect(runtime.api.machineBridgeRespawnDecision(0)).toEqual({
      respawn: true, delayMs: 1_000, gaveUp: false,
    })
    expect(runtime.api.machineBridgeRespawnDecision(3)).toEqual({
      respawn: false, delayMs: null, gaveUp: true,
    })

    runtime.api.startMachineBridge()
    runtime.children[0].crash(1)
    await vi.advanceTimersByTimeAsync(999)
    expect(runtime.children).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(runtime.children).toHaveLength(2)

    runtime.children[1].crash(2)
    await vi.advanceTimersByTimeAsync(1_999)
    expect(runtime.children).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(runtime.children).toHaveLength(3)

    runtime.children[2].crash(3)
    await vi.advanceTimersByTimeAsync(3_999)
    expect(runtime.children).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(1)
    expect(runtime.children).toHaveLength(4)

    runtime.children[3].crash(4)
    expect(runtime.api.machineBridgeStatus().respawn).toMatchObject({ attempts: 3, gaveUp: true })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(runtime.children).toHaveLength(4)
  })

  it('resets old attempts after a stable 60s run and never respawns a deliberate stop', async () => {
    vi.useFakeTimers()
    const runtime = loadMain()
    runtime.api.startMachineBridge()
    runtime.children[0].crash(1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(runtime.api.machineBridgeStatus().respawn.attempts).toBe(1)

    await vi.advanceTimersByTimeAsync(60_000)
    expect(runtime.api.machineBridgeStatus().respawn.attempts).toBe(0)
    runtime.children[1].crash(2)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(runtime.children).toHaveLength(3)

    await runtime.api.stopMachineBridge()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(runtime.children).toHaveLength(3)
    expect(runtime.api.machineBridgeStatus().running).toBe(false)
  })

  it('preload exposes restart over invoke and main refuses a foreign renderer', async () => {
    const invoke = vi.fn(async () => ({ ok: true }))
    let exposed: Record<string, unknown> | null = null
    const preload = readFileSync(nodePath.resolve('electron/preload.cjs'), 'utf8')
    vm.runInNewContext(preload, {
      Object,
      process: { platform: 'win32', versions: { chrome: '1', electron: '1' } },
      require: (id: string) => id === 'electron'
        ? {
            contextBridge: {
              exposeInMainWorld: (_name: string, api: Record<string, unknown>) => { exposed = api },
            },
            ipcRenderer: { invoke, send: vi.fn() },
          }
        : createRequire(import.meta.url)(id),
    })
    await (exposed!.machineBridgeRestart as () => Promise<unknown>)()
    expect(invoke).toHaveBeenCalledWith('liencam:machine-bridge-restart')

    const runtime = loadMain({ autoReady: true })
    const handler = runtime.ipcHandlers.get('liencam:machine-bridge-restart')
    expect(handler).toBeTypeOf('function')
    await expect(handler!({ sender: {} })).resolves.toBeUndefined()
    expect(runtime.children).toHaveLength(1)
  })
})

function bridgeConsoleLines(): string[] {
  return useCamStore.getState().consoleEvents
    .filter((event) => event.source === 'machine' && /bridge/i.test(event.message))
    .map((event) => event.message)
}

describe('WO-1132 Definition page control', () => {
  it('renders no button for unhosted/old preload and states the supported boundary', () => {
    setHost({ machineBridgeStatus: async () => configuredStatus() })
    render(createElement(ControllerSetupPanel, { connectionKind: 'bridge' }))

    expect(screen.queryByTestId('machine-controller-restart-bridge')).toBeNull()
    expect(screen.getByTestId('machine-controller-bridge-unhosted').textContent).toContain(
      'Started outside the app - the desktop app can restart it.',
    )
  })

  it('renders hosted but not configured as disabled with an honest title', async () => {
    setHost({
      machineBridgeStatus: async () => configuredStatus(false),
      machineBridgeRestart: vi.fn(),
    })
    render(createElement(ControllerSetupPanel, { connectionKind: 'bridge' }))

    const button = await screen.findByTestId('machine-controller-restart-bridge') as HTMLButtonElement
    await waitFor(() => expect(button.disabled).toBe(true))
    expect(button.title).toContain('not configured')
    expect(screen.getByTestId('machine-controller-bridge-state').textContent).toContain(
      'liencam-bridge.exe is missing or not configured on this computer.',
    )
  })

  it('makes an in-flight double press impossible and narrates success exactly once with re-homing', async () => {
    let resolveRestart!: (result: BridgeRestartResult) => void
    const machineBridgeRestart = vi.fn(() => new Promise<BridgeRestartResult>((resolve) => {
      resolveRestart = resolve
    }))
    setHost({ machineBridgeStatus: async () => configuredStatus(), machineBridgeRestart })
    render(createElement(ControllerSetupPanel, { connectionKind: 'bridge' }))
    const button = await screen.findByTestId('machine-controller-restart-bridge') as HTMLButtonElement
    await waitFor(() => expect(button.disabled).toBe(false))

    fireEvent.click(button)
    fireEvent.click(button)
    expect(button.disabled).toBe(true)
    expect(button.textContent).toContain('Restarting...')
    expect(machineBridgeRestart).toHaveBeenCalledTimes(1)
    expect(bridgeConsoleLines()).toEqual(['Restarting the bridge...'])

    resolveRestart({ ok: true, pid: 9001, port: 8325 })
    await waitFor(() => expect(button.textContent).toContain('Restart bridge'))
    expect(bridgeConsoleLines()).toEqual([
      'Restarting the bridge...',
      'The bridge is running again. Home the machine before you jog - a restart loses the position counter.',
    ])
  })

  it.each([
    [
      { ok: false, reason: 'no-socket', pid: 9001, port: 9123 } as const,
      'The bridge started but is not answering on port 9123.',
    ],
    [
      { ok: false, reason: 'exited', lastExit: { code: 23, signal: null, error: null } } as const,
      'The bridge did not come back: it stopped again straight away.',
    ],
  ])('narrates the %s terminal outcome exactly once', async (result, line) => {
    setHost({
      machineBridgeStatus: async () => configuredStatus(),
      machineBridgeRestart: vi.fn(async () => result),
    })
    render(createElement(ControllerSetupPanel, { connectionKind: 'bridge' }))
    const button = await screen.findByTestId('machine-controller-restart-bridge') as HTMLButtonElement
    await waitFor(() => expect(button.disabled).toBe(false))

    fireEvent.click(button)
    await waitFor(() => expect(bridgeConsoleLines()).toHaveLength(2))
    expect(bridgeConsoleLines()).toEqual(['Restarting the bridge...', line])
  })
})
