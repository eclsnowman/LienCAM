// @vitest-environment jsdom

// WO-2029 (Operator's 8 AM machine session 09-26, finding F1): the desktop app was
// launched with the controller OFF. The bridge logged "GIVING UP ... board 1
// did not become enumerable", its respawns ran out, and pressing Connect at
// 07:58 did nothing - no console row, no bridge spawn, no error - twice.
//
// These tests drive the production connect path end to end: the real
// electron/main.cjs (loaded in a VM with a fake child process and TCP probe),
// its real IPC handlers behind a desktop preload shape, the real ControlPage
// Connect button (with the Machine definition panel's Connect pre-flight
// installed, as in the app), and the real BridgeTransport/UccncController over
// a fake WebSocket. The fakes are only the OS boundary: the bridge executable,
// its TCP port and the socket.

import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { electronMainRequire } from '../support/electronMainRequire'
import nodePath from 'node:path'
import nodeProcess from 'node:process'
import vm from 'node:vm'
import { createElement } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BridgeProcessStatus, BridgeRestartResult } from '../../lib/machine/bridgeHost'
import type { ControllerCapabilities } from '../../lib/machine/controller'

const mem = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    get length() { return mem.size },
    clear: () => mem.clear(),
    getItem: (key: string) => mem.get(key) ?? null,
    key: (index: number) => [...mem.keys()][index] ?? null,
    removeItem: (key: string) => { mem.delete(key) },
    setItem: (key: string, value: string) => { mem.set(key, String(value)) },
  } satisfies Storage,
})

const TEST_BRIDGE_PORT = 20_000 + ((nodeProcess.pid * 23 + 2029) % 20_000)
const GIVE_UP_LINE = 'GIVING UP after 10 s: board 1 did not become enumerable'

const CAPABILITIES: ControllerCapabilities = {
  geometryQueue: true,
  executingMoveId: true,
  bufferSeconds: true,
  gcodeText: false,
  perAxisHoming: true,
  ownsSpindle: false,
  spindleCommands: false,
}

/** The physical world: is the controller powered, and is a bridge up - the
 * app's own child, or one the operator started outside the app? */
const world = { controllerOn: false, children: [] as FakeChild[], externalBridge: false }

function bridgeListening(): boolean {
  return world.controllerOn
    && (world.externalBridge || world.children.some((child) => child.exitCode === null))
}

class FakeChild extends EventEmitter {
  exitCode: number | null = null
  pid: number
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  kill = vi.fn((_signal?: string) => {
    queueMicrotask(() => this.crash(0))
    return true
  })

  constructor(pid: number) {
    super()
    this.pid = pid
  }

  crash(code: number | null = 2): void {
    if (this.exitCode !== null) return
    this.exitCode = code
    this.emit('exit', code, null)
  }
}

/** Bridge.cs with the controller off: prints why and exits(2) at once. */
function spawnBridge(): FakeChild {
  const child = new FakeChild(5100 + world.children.length)
  world.children.push(child)
  if (!world.controllerOn) {
    queueMicrotask(() => {
      child.stdout.emit('data', `${GIVE_UP_LINE}\n`)
      child.crash(2)
    })
  }
  return child
}

/** node:net for main.cjs's socket probe: the port answers while a bridge is up. */
const fakeNet = {
  createConnection() {
    const socket = new EventEmitter() as EventEmitter & {
      destroy: () => void
      setTimeout: (timeout: number, listener: () => void) => void
    }
    socket.destroy = () => {}
    socket.setTimeout = () => {}
    queueMicrotask(() => {
      if (bridgeListening()) socket.emit('connect')
      else socket.emit('error', new Error('ECONNREFUSED'))
    })
    return socket
  },
}

/** The renderer's WebSocket: opens and says hello only if a bridge is up. */
class FakeSocket {
  static OPEN = 1
  static instances: FakeSocket[] = []
  readyState = 0
  onopen: (() => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: (() => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  readonly url: string

  constructor(url: string) {
    this.url = url
    FakeSocket.instances.push(this)
    queueMicrotask(() => {
      if (!bridgeListening()) {
        this.onerror?.()
        this.onclose?.({ code: 1006, reason: '' } as CloseEvent)
        return
      }
      this.readyState = FakeSocket.OPEN
      this.onopen?.()
      this.frame({
        t: 'hello',
        v: { protocol: 1, bridge: 'wo2029-fake-bridge', capabilities: CAPABILITIES, readOnly: false },
      })
    })
  }

  send(raw: string): void {
    const call = JSON.parse(raw) as { seq: number; m: string }
    queueMicrotask(() => this.frame({
      t: 'reply',
      seq: call.seq,
      ok: true,
      v: call.m === 'applyMachineDefinition'
        ? { ok: false, error: 'a program is loaded', reHome: [], configuredThisSession: false, lines: [] }
        : true,
    }))
  }

  close(): void {
    if (this.readyState !== FakeSocket.OPEN) return
    this.readyState = 3
    queueMicrotask(() => this.onclose?.({ code: 1000, reason: '' } as CloseEvent))
  }

  private frame(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent)
  }
}

interface MainApi {
  initializeMachineBridge: () => Promise<FakeChild | null>
  machineBridgeStatus: () => BridgeProcessStatus
  stopMachineBridge: () => Promise<boolean>
}

type IpcHandler = (event: { sender: unknown }, ...args: unknown[]) => unknown

/** The real electron/main.cjs, with the Electron and OS modules faked. */
function loadMain(): { api: MainApi; ipc: Map<string, IpcHandler> } {
  const ipc = new Map<string, IpcHandler>()
  const electron = {
    app: {
      isPackaged: false,
      on: vi.fn(),
      quit: vi.fn(),
      whenReady: () => ({ then: () => Promise.resolve() }),
    },
    BrowserWindow: class { static getAllWindows = () => [] },
    dialog: {},
    ipcMain: {
      handle: (channel: string, listener: IpcHandler) => { ipc.set(channel, listener) },
      on: vi.fn(),
    },
    Menu: { setApplicationMenu: vi.fn() },
    powerSaveBlocker: { isStarted: vi.fn(() => false), start: vi.fn(() => 1), stop: vi.fn() },
    protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
  }
  const moduleValue = { exports: {} as MainApi }
  const realRequire = electronMainRequire
  vm.runInNewContext(readFileSync(nodePath.resolve('electron/main.cjs'), 'utf8'), {
    AbortSignal,
    Buffer,
    Date,
    Promise,
    Response,
    URL,
    __dirname: nodePath.resolve('electron'),
    // Delegate so fake timers can run the respawn ladder, then real ones resume.
    clearTimeout: (id: ReturnType<typeof setTimeout>) => globalThis.clearTimeout(id),
    console,
    exports: moduleValue.exports,
    fetch,
    module: moduleValue,
    process: {
      ...nodeProcess,
      argv: [],
      env: {
        ...nodeProcess.env,
        LIENCAM_BRIDGE_EXECUTABLE: 'C:\\fake\\liencam-bridge.exe',
        LIENCAM_BRIDGE_ARGS_JSON: JSON.stringify(['--port', String(TEST_BRIDGE_PORT)]),
      },
      platform: 'win32',
      resourcesPath: nodePath.resolve('.tmp-wo2029-resources'),
    },
    queueMicrotask,
    require: (id: string) => {
      if (id === 'electron') return electron
      if (id === 'node:child_process') return { spawn: vi.fn(spawnBridge) }
      if (id === 'node:net') return fakeNet
      return realRequire(id)
    },
    setTimeout: (listener: () => void, delay?: number) => globalThis.setTimeout(listener, delay),
  })
  return { api: moduleValue.exports, ipc }
}

const { ControlPage } = await import('../../components/machine/ControlPage')
const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useUiPrefs } = await import('../../store/uiPrefs')
const { createDefaultControllerDefinition } = await import('../../types')
const session = await import('../../lib/machine/machineSession')
const { BRIDGE_INITIAL_CONNECT_RETRY_MS } = await import('../../lib/machine/bridgeTransport')

let main: ReturnType<typeof loadMain>
let originalWebSocket: unknown

/** The desktop preload (electron/preload.cjs) exposes exactly these doors. */
function installDesktopPreload(): void {
  const sender = {}
  Object.defineProperty(window, 'liencamHost', {
    configurable: true,
    value: {
      machineBridgeStatus: () => Promise.resolve(
        main.ipc.get('liencam:machine-bridge-status')!({ sender }) as BridgeProcessStatus,
      ),
      machineBridgeRestart: (settings?: unknown) => Promise.resolve(
        main.ipc.get('liencam:machine-bridge-restart')!({ sender }, settings) as Promise<BridgeRestartResult>,
      ),
    },
  })
}

/** The desktop preload on a PC where the app's own bridge is not set up (no
 * UCCNC install found, no LIENCAM_BRIDGE_EXECUTABLE): electron/main.cjs's
 * status and restart answers for that case. */
function installUnsetDesktopPreload(): void {
  Object.defineProperty(window, 'liencamHost', {
    configurable: true,
    value: {
      machineBridgeStatus: () => Promise.resolve({
        ...main.api.machineBridgeStatus(),
        configured: false,
        running: false,
        pid: null,
        lastExit: null,
        setup: { state: 'missing-install', installRoot: null, lookedFor: null, logPath: null, error: null },
      } satisfies BridgeProcessStatus),
      machineBridgeRestart: () => Promise.resolve({ ok: false, reason: 'not-configured' } satisfies BridgeRestartResult),
    },
  })
}

/** App launch with the controller OFF: start, then let every respawn fail. */
async function launchAppWithControllerOff(): Promise<void> {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    await main.api.initializeMachineBridge()
    for (let step = 0; step < 4; step += 1) await vi.advanceTimersByTimeAsync(5_000)
  } finally {
    vi.useRealTimers()
  }
  const status = main.api.machineBridgeStatus()
  expect(status.respawn.gaveUp).toBe(true)
  expect(status.running).toBe(false)
  expect(status.lastExit?.error).toBe(GIVE_UP_LINE)
}

function consoleTexts(): string[] {
  return useMachineControl.getState().consoleLines.map((line) => line.text)
}

beforeEach(() => {
  mem.clear()
  world.controllerOn = false
  world.children = []
  world.externalBridge = false
  FakeSocket.instances = []
  originalWebSocket = globalThis.WebSocket
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, writable: true, value: FakeSocket })
  useCamStore.getState().newProject()
  const machine = useCamStore.getState().project.machine!
  const definition = createDefaultControllerDefinition()
  definition.axes.forEach((axis, index) => {
    axis.stepPin = { port: 1, pin: 2 + index * 3, negate: false }
    axis.dirPin = { port: 1, pin: 3 + index * 3, negate: false }
    axis.homePin = { port: 1, pin: 4 + index * 3, negate: false }
  })
  useCamStore.getState().updateMachine({
    ...machine,
    controller: 'uccnc',
    noHomingSwitches: false,
    controllerDefinition: definition,
  })
  useUiPrefs.setState({ machineLinks: { [machine.id]: { bridgePort: TEST_BRIDGE_PORT } } })
  useMachineControl.setState({ consoleLines: [] })
  useMachineControl.getState().setConnection('disconnected', null)
  main = loadMain()
  installDesktopPreload()
})

afterEach(async () => {
  cleanup()
  await session.disconnectMachine()
  await main.api.stopMachineBridge()
  Reflect.deleteProperty(window, 'liencamHost')
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, writable: true, value: originalWebSocket })
})

describe('WO-2029 Connect after the desktop bridge gave up', () => {
  it('one press starts the bridge again and connects once the controller is on', async () => {
    await launchAppWithControllerOff()
    const spawnsBeforeConnect = world.children.length
    render(createElement(ControlPage))
    // The page reads the child it launched as gave-up, not 'unknown'.
    await waitFor(() => expect(useMachineControl.getState().bridgeProcessPresence).toBe('gave-up'))

    world.controllerOn = true
    const before = consoleTexts().length
    await act(async () => { fireEvent.click(screen.getByTestId('control-connect')) })

    await waitFor(() => expect(useMachineControl.getState().connectionPhase).toBe('connected'))
    expect(world.children).toHaveLength(spawnsBeforeConnect + 1)
    expect(main.api.machineBridgeStatus()).toMatchObject({
      running: true,
      respawn: { gaveUp: false },
    })
    const added = consoleTexts().slice(before)
    expect(added.filter((text) => text === 'Restarted the machine connection.')).toHaveLength(1)
    expect(added.join('\n')).not.toMatch(/Connect failed|Not connected/)
    await waitFor(() => expect(useMachineControl.getState().bridgeProcessPresence).toBe('running'))
  })

  it('a press while the bridge still cannot start prints the bridge\'s own last line once', async () => {
    await launchAppWithControllerOff()
    const spawnsBeforeConnect = world.children.length
    render(createElement(ControlPage))
    await waitFor(() => expect(useMachineControl.getState().bridgeProcessPresence).toBe('gave-up'))

    const before = consoleTexts().length
    await act(async () => { fireEvent.click(screen.getByTestId('control-connect')) })

    await waitFor(() => expect(consoleTexts().length).toBeGreaterThan(before))
    // The press tried: one fresh bridge spawn, which exited with its reason.
    expect(world.children).toHaveLength(spawnsBeforeConnect + 1)
    const added = consoleTexts().slice(before)
    expect(added).toEqual([
      'Not connected: the machine connection stopped at start '
      + '(GIVING UP after 10 s: board 1 did not become enumerable).',
    ])
    expect(FakeSocket.instances).toHaveLength(0)
    expect(useMachineControl.getState().connectionPhase).toBe('disconnected')
    await waitFor(() => expect(
      (screen.getByTestId('control-connect') as HTMLButtonElement).disabled,
    ).toBe(false))

    // The controller comes on: the very next press starts the bridge and connects.
    world.controllerOn = true
    await act(async () => { fireEvent.click(screen.getByTestId('control-connect')) })
    await waitFor(() => expect(useMachineControl.getState().connectionPhase).toBe('connected'))
    expect(consoleTexts().filter((text) => text === 'Restarted the machine connection.')).toHaveLength(1)
  })

  it("with the app's own bridge not set up, a press still connects to a bridge serving the port", async () => {
    // Review FAIL 09-26: 'not set up' says nothing about whether a bridge is
    // answering. Main connected here; the press must not invent a refusal.
    installUnsetDesktopPreload()
    world.controllerOn = true
    world.externalBridge = true
    render(createElement(ControlPage))
    const before = consoleTexts().length
    await act(async () => { fireEvent.click(screen.getByTestId('control-connect')) })

    await waitFor(() => expect(useMachineControl.getState().connectionPhase).toBe('connected'))
    expect(FakeSocket.instances).toHaveLength(1)
    expect(world.children).toHaveLength(0)
    expect(consoleTexts().slice(before).join('\n')).not.toMatch(/Connect failed|Not connected/)
  })

  it("with the app's own bridge not set up and nothing serving, a press says so once", async () => {
    installUnsetDesktopPreload()
    world.controllerOn = true
    render(createElement(ControlPage))
    const before = consoleTexts().length
    // The socket attempt keeps its one initial-connect retry; run past it.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      await act(async () => { fireEvent.click(screen.getByTestId('control-connect')) })
      await act(async () => { await vi.advanceTimersByTimeAsync(BRIDGE_INITIAL_CONNECT_RETRY_MS + 1_000) })
    } finally {
      vi.useRealTimers()
    }

    await waitFor(() => expect(
      (screen.getByTestId('control-connect') as HTMLButtonElement).disabled,
    ).toBe(false))
    expect(FakeSocket.instances.length).toBeGreaterThan(0)
    // The failed socket keeps the transport's own lines; the press's answer is
    // the setup sentence, once and last, in place of a bare "Connect failed".
    const added = consoleTexts().slice(before)
    const sentence = 'Not connected: the machine connection is not set up on this computer.'
    expect(added.filter((text) => text === sentence)).toHaveLength(1)
    expect(added.at(-1)).toBe(sentence)
    expect(added.join('\n')).not.toMatch(/Connect failed/)
    expect(useMachineControl.getState().connectionPhase).toBe('disconnected')
  })

  it('a single Connect press runs exactly one pre-flight', async () => {
    // Connect has one owner in the desktop app: ControlPage's handler. The
    // Machine definition panel's pre-flight cancels a bridge press, runs its
    // own status check and re-clicks the button; in the desktop app it must
    // stand aside, or one press becomes two passes over the bridge.
    const host = (window as typeof window & {
      liencamHost: { machineBridgeRestart: (settings?: unknown) => Promise<BridgeRestartResult> }
    }).liencamHost
    const restartBridge = host.machineBridgeRestart
    let restarts = 0
    host.machineBridgeRestart = (settings?: unknown) => { restarts += 1; return restartBridge(settings) }
    let presses = 0
    const countPress = (event: MouseEvent) => {
      if (event.target instanceof Element && event.target.closest('[data-testid="control-connect"]')) presses += 1
    }
    window.addEventListener('click', countPress, true)
    try {
      await launchAppWithControllerOff()
      render(createElement(ControlPage))
      await waitFor(() => expect(useMachineControl.getState().bridgeProcessPresence).toBe('gave-up'))
      const bottomBefore = useCamStore.getState().consoleEvents.length

      // Gave-up child: one press, one click, one restart, one Control line.
      world.controllerOn = true
      const before = consoleTexts().length
      await act(async () => { fireEvent.click(screen.getByTestId('control-connect')) })
      await waitFor(() => expect(useMachineControl.getState().connectionPhase).toBe('connected'))
      expect(presses).toBe(1)
      expect(restarts).toBe(1)
      expect(consoleTexts().slice(before).filter((text) => text === 'Restarted the machine connection.'))
        .toHaveLength(1)
      expect(useCamStore.getState().consoleEvents.slice(bottomBefore)
        .filter((event) => /bridge/i.test(event.message))).toEqual([])

      // Running child: one press, one click, no restart, connected.
      await act(async () => { await session.disconnectMachine() })
      await waitFor(() => expect(
        (screen.getByTestId('control-connect') as HTMLButtonElement).disabled,
      ).toBe(false))
      presses = 0
      restarts = 0
      await act(async () => { fireEvent.click(screen.getByTestId('control-connect')) })
      await waitFor(() => expect(useMachineControl.getState().connectionPhase).toBe('connected'))
      expect(presses).toBe(1)
      expect(restarts).toBe(0)
    } finally {
      window.removeEventListener('click', countPress, true)
    }
  })

  it('a LinuxCNC-declared machine is never offered the bridge, so its press never restarts it', async () => {
    // WO-2066 (Operator ruling 2026-09-26: "UCCNC and LinuxCNC are completely different
    // software"): only a UCCNC machine has a bridge route. A LinuxCNC press
    // connects its simulator and never spawns or restarts the UCCNC bridge.
    await launchAppWithControllerOff()
    const spawnsBeforeConnect = world.children.length
    const machine = useCamStore.getState().project.machine!
    useCamStore.getState().updateMachine({ ...machine, controller: 'linuxcnc' })
    render(createElement(ControlPage))
    const kinds = screen.getByTestId('control-kind-select') as HTMLSelectElement
    // WO-1987: LinuxCNC's own gateway is its first choice; this press is on
    // its simulator, so the test world needs no LinuxCNC gateway.
    expect(kinds.value).toBe('gateway')
    expect([...kinds.options].map((option) => option.value)).toEqual(['gateway', 'simulator'])
    fireEvent.change(kinds, { target: { value: 'simulator' } })

    world.controllerOn = true
    const before = consoleTexts().length
    await act(async () => { fireEvent.click(screen.getByTestId('control-connect')) })

    await waitFor(() => expect(useMachineControl.getState().connectionPhase).toBe('connected'))
    expect(useMachineControl.getState().connectionKind).toBe('simulator')
    expect(world.children).toHaveLength(spawnsBeforeConnect)
    expect(consoleTexts().slice(before).filter((text) => text === 'Restarted the machine connection.'))
      .toHaveLength(0)
  })
})
