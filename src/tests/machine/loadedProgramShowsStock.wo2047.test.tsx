// @vitest-environment jsdom
//
// WO-2047 - A LOADED POSTED PROGRAM SHOWS ITS STOCK ON CONTROL.
//
// Operator's end-of-session notes, 2026-09-26, item 3: "He did not see the stock
// box in the machining/Control view." With Setup 1 posted and loaded, Control's
// badge read "Intended stock - NONE" (load-Setup1.png, machine/2026-09-25).
//
// THE ROUTE THAT LOST IT: his LienCNC is a controller that runs STAGED programs
// (no G-code interpreter), so every load - the exported file opened on Control,
// the same bytes from Recent, Load > Setup - goes through the program door.
// That door stores no program text and passed a null context to the store, so
// the LCX1 block the post writes after M30 was read, verified and dropped.
//
// WHAT IS PROVEN HERE, THROUGH THE APPLICATION'S OWN ENTRY POINTS (rule 6): a
// real `UccncController` over a fake bridge socket that reports Operator's board's
// capabilities (gcodeText false, machineProgram true); the Post Process modal
// RENDERED and its "Export .nc" CLICKED with the desktop app's native save host
// installed; the bytes that host received opened through Control's own file
// input; Control's Load menu CLICKED for the setup. Each route shows the
// intended stock line with the setup's name and a box drawn in the scene, and
// the program that reached the board is unchanged. A file from another CAM
// system still loads with no stock and no console nag.
//
// NOT CLAIMED: hardware. Nothing here touches the real board.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type {
  BridgeCallMessage,
  BridgeMessage,
  BridgeTransport,
  BridgeTransportEvents,
} from '../../lib/machine/bridgeTransport'
import type { ControllerCapabilities, MachineStatus } from '../../lib/machine/controller'
import type { RecentProgramMeta } from '../../lib/machine/programLibrary'
import {
  createDefaultControllerDefinition,
  type MachineConfig,
  type Operation,
  type Project,
  type Setup,
  type ToolpathMove,
} from '../../types'
import { makeMachine, makeOp, makeStock, makeTool, makeWcs, stampGenerationCurrent } from '../post/helpers'
import { axisSoftLimitStatementKey } from '../../lib/machine/resolvedMachineMotion'
import { typedMock } from '../support/typedMock'

const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  key: (i: number) => Array.from(mem.keys())[i] ?? null,
  removeItem: (k: string) => { mem.delete(k) },
  setItem: (k: string, v: string) => { mem.set(k, String(v)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

/** Every intended-stock box the preview pushed into the 3D scene. */
const sceneStockCalls: unknown[] = []

// CNCViewport needs WebGL; the preview's scene calls are recorded instead.
vi.mock('../../lib/viewport/CNCViewport', () => typedMock<typeof import('../../lib/viewport/CNCViewport')>({
  CNCViewport: class {
    setIntendedStock = vi.fn((box: unknown) => { sceneStockCalls.push(box) })
    setMachinePreviewCoordinateFrame = vi.fn()
    renderToolpath = vi.fn()
    setActiveToolpathSegment = vi.fn()
    setToolMarkerPosition = vi.fn()
    showToolMarker = vi.fn()
    setStockVisible = vi.fn()
    setWorkpieceVisible = vi.fn()
    setMachineVisible = vi.fn()
    fitToolpath = vi.fn()
    fitToolpathPreservingView = vi.fn()
    fitBoundsPreservingView = vi.fn()
    setCameraView = vi.fn()
    setOrbitFocus = vi.fn()
    dispose = vi.fn()
  } as unknown as typeof import('../../lib/viewport/CNCViewport').CNCViewport,
}))

let recentText = ''
const recentEntry: RecentProgramMeta = { id: 'rec2047', name: 'Setup 1.nc', size: 0, savedAt: 1000 }
vi.mock('../../lib/machine/programLibrary', () =>
  typedMock<typeof import('../../lib/machine/programLibrary')>({
    programLibrarySupported: () => true,
    listPrograms: vi.fn(() => Promise.resolve([recentEntry])),
    saveProgram: vi.fn(() => Promise.resolve()),
    readProgram: vi.fn((id: string) => Promise.resolve(id === recentEntry.id ? recentText : null)),
  }))

/** Operator's AXBB-E bridge: no G-code interpreter, a staged-program route. */
const PROGRAM_BRIDGE_CAPABILITIES: ControllerCapabilities = {
  geometryQueue: true,
  executingMoveId: true,
  bufferSeconds: true,
  gcodeText: false,
  machineProgram: true,
  perAxisHoming: true,
  ownsSpindle: false,
  spindleCommands: false,
}

interface FakeBridgeTransport extends BridgeTransport {
  sent: BridgeCallMessage[]
  emit(message: BridgeMessage): void
  loadMovesFrames(): { moves: unknown[]; frame?: string }[]
}
const bridgeSockets: FakeBridgeTransport[] = []

vi.mock('../../lib/machine/bridgeTransport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/bridgeTransport')>()
  class FakeBridgeTransport extends actual.BridgeTransport {
    static isSupported(): boolean { return true }
    sent: BridgeCallMessage[] = []
    private fakeEvents: BridgeTransportEvents | null = null

    constructor() {
      super()
      bridgeSockets.push(this)
    }

    async start(events: BridgeTransportEvents): Promise<void> {
      this.fakeEvents = events
      const offsets = {
        G54: { x: 10, y: 5, z: 2 },
        G55: { x: 110, y: 5, z: 2 },
        G56: { x: 0, y: 0 },
        G57: { x: 0, y: 0 },
        G58: { x: 0, y: 0 },
        G59: { x: 0, y: 0 },
      }
      this.fakeEvents.onMessage({
        t: 'hello',
        v: {
          protocol: 1,
          bridge: 'wo-2047-fake 0.0',
          capabilities: PROGRAM_BRIDGE_CAPABILITIES,
          readOnly: false,
          vfd: { present: false, verified: false, name: null },
          workOffsets: { current: offsets, profile: offsets },
        },
      } as BridgeMessage)
    }

    send(message: BridgeCallMessage): void {
      this.sent.push(message)
      if (message.m === 'selectWcs') {
        this.fakeEvents?.onMessage({ t: 'reply', seq: message.seq, ok: true, v: true })
      }
    }

    async close(): Promise<void> {
      this.fakeEvents?.onClose('closed')
    }

    emit(message: BridgeMessage): void {
      this.fakeEvents?.onMessage(message)
    }

    loadMovesFrames(): { moves: unknown[]; frame?: string }[] {
      return this.sent
        .filter((m) => m.m === 'loadMoves')
        .map((m) => m.a as { moves: unknown[]; frame?: string })
    }
  }
  return typedMock<typeof import('../../lib/machine/bridgeTransport')>({
    ...actual,
    BridgeTransport: FakeBridgeTransport,
  })
})

const { useMachineControl } = await import('../../store/machineControlStore')
const { useCamStore } = await import('../../store')
const { ProgramPanel } = await import('../../components/machine/ProgramPanel')
const { PostProcessModal } = await import('../../components/modals/PostProcessModal')
const {
  __resetEstopInterlockForTest,
  clearPathFidelity,
  connectMachine,
  controllerNeedsToolpathProgram,
  disconnectMachine,
  getMachineController,
  stagedProgramContext,
} = await import('../../lib/machine/machineSession')

function machine(): MachineConfig {
  const controllerDefinition = createDefaultControllerDefinition()
  for (const axis of controllerDefinition.axes) {
    axis.softLimitMin = axis.axis === 'Z' ? -50 : 0
    axis.softLimitMax = axis.axis === 'X' ? 600 : axis.axis === 'Y' ? 400 : 50
  }
  controllerDefinition.stated = controllerDefinition.axes.flatMap((axis) =>
    (['min', 'max'] as const).map((end) => ({
      controller: 'uccnc' as const,
      key: axisSoftLimitStatementKey(axis.axis, end),
    })),
  )
  return makeMachine({
    id: 'wo2047-machine',
    name: 'WO-2047 Test Machine',
    controller: 'uccnc',
    travel: { x: 600, y: 400, z: 100 },
    homeConvention: {
      x: { homesToward: 'min', machineZeroAt: 'min' },
      y: { homesToward: 'min', machineZeroAt: 'min' },
      z: { homesToward: 'min', homePositionMm: -50 },
    },
    rapidRate: 5000,
    controllerDefinition,
  })
}

/** A rapid to the clearance plane and three feeds, in WORLD coordinates. */
function toolpath(dx = 0): ToolpathMove[] {
  return [
    { type: 'rapid', x: 10 + dx, y: 5, z: 12 },
    { type: 'feed', x: 10 + dx, y: 5, z: 1, feed: 300 },
    { type: 'feed', x: 60 + dx, y: 5, z: 1, feed: 900 },
    { type: 'feed', x: 60 + dx, y: 45, z: 1, feed: 900 },
  ]
}

function op(id: string, toolId: string, dx = 0): Operation {
  return makeOp({ id, name: `Op ${id}`, type: 'contour_2d', toolId, status: 'ready', toolpathMoves: toolpath(dx) })
}

const TOOLS = [makeTool({ id: 't1', toolNumber: 1 }), makeTool({ id: 't2', toolNumber: 2 })]

/** "Setup 1" on G54 with the given operations, stamped generation-current as a
 *  real regenerate leaves them. */
function applyProject(operations: Operation[]): Setup {
  const setup: Setup = {
    id: 'setup1',
    name: 'Setup 1',
    wcs: makeWcs({ id: 'w1', label: 'G54', fixtureOffset: 54, origin: { x: 10, y: 5, z: 2 } }),
    stock: makeStock({ material: 'aluminum' }),
    operations,
    notes: '',
  }
  const project: Project = {
    ...useCamStore.getState().project,
    id: 'p-wo2047',
    name: 'WO-2047 Part',
    machine: machine(),
    setups: [setup],
    activeSetupId: 'setup1',
    toolLibrary: TOOLS,
  }
  for (const operation of setup.operations) {
    stampGenerationCurrent(project, setup, operation, TOOLS.find((t) => t.id === operation.toolId) ?? TOOLS[0])
  }
  useCamStore.setState({ project, toolLibrary: TOOLS, modelRefsVerifiedSinceLoad: true } as never)
  return setup
}

function idleBridgeStatus(): MachineStatus {
  return {
    state: 'idle',
    subState: null,
    machinePos: { x: 0, y: 0, z: 0 },
    workPos: { x: 0, y: 0, z: 0 },
    feedMmMin: 0,
    spindleRpm: null,
    overrides: null,
    executingMoveId: 0,
    buffer: { moves: null, capacitySeconds: null },
    inputs: null,
    homed: null,
    spindle: null,
  }
}

function socket(): FakeBridgeTransport {
  return bridgeSockets[bridgeSockets.length - 1]
}

async function flush(ms = 50): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

/** Everything the desktop app's native save host was handed. */
const nativeSaves: { filename: string; data: string | Uint8Array }[] = []

let originalProject: Project
let originalToolLibrary: ReturnType<typeof useCamStore.getState>['toolLibrary']

beforeEach(async () => {
  // WO-2066: the bridge is UCCNC's route only, so this bridge test's machine declares UCCNC.
  useCamStore.setState((state) => ({
    project: { ...state.project, machine: { ...state.project.machine, controller: 'uccnc' } },
  }))
  vi.useFakeTimers()
  bridgeSockets.length = 0
  sceneStockCalls.length = 0
  nativeSaves.length = 0
  originalProject = useCamStore.getState().project
  originalToolLibrary = useCamStore.getState().toolLibrary
  ;(globalThis as { liencamHost?: unknown }).liencamHost = {
    saveFile: async (filename: string, data: string | Uint8Array) => {
      nativeSaves.push({ filename, data })
      return `C:\\workspace\\Documents\\${filename}`
    },
  }
  const pending = connectMachine('bridge')
  await vi.advanceTimersByTimeAsync(300)
  await pending
  act(() => { __resetEstopInterlockForTest() })
  act(() => {
    socket().emit({ t: 'status', v: idleBridgeStatus() } as BridgeMessage)
    socket().emit({ t: 'homed', v: { axes: ['X', 'Y', 'Z'] } } as BridgeMessage)
  })
})

afterEach(async () => {
  cleanup()
  delete (globalThis as { liencamHost?: unknown }).liencamHost
  if (getMachineController().connectionPhase() !== 'disconnected') {
    const pending = disconnectMachine()
    await vi.advanceTimersByTimeAsync(300)
    await pending
  }
  useCamStore.setState({ project: originalProject, toolLibrary: originalToolLibrary })
  act(() => { useMachineControl.getState().setProgram(null, null, [], null) })
  clearPathFidelity()
  useMachineControl.setState({ consoleLines: [] })
  vi.useRealTimers()
})

/** Post Process > Export .nc, in the desktop app: the bytes the native save
 *  host was given - exactly what lands on disk. */
async function exportFromPostProcess(): Promise<{ filename: string; text: string }> {
  const modal = render(<PostProcessModal />)
  act(() => { useCamStore.getState().openModal('post-process') })
  fireEvent.click(screen.getByRole('button', { name: /Export \.nc/i }))
  await flush(200)
  expect(nativeSaves).toHaveLength(1)
  const saved = nativeSaves[0]
  const text = typeof saved.data === 'string' ? saved.data : new TextDecoder().decode(saved.data)
  modal.unmount()
  act(() => { useCamStore.getState().closeModal() })
  return { filename: saved.filename, text }
}

async function openOnControl(name: string, text: string): Promise<void> {
  const input = screen.getByTestId('control-file-input') as HTMLInputElement
  const file = new File([text], name, { type: 'text/plain' })
  Object.defineProperty(file, 'text', { value: () => Promise.resolve(text) })
  await act(async () => {
    fireEvent.change(input, { target: { files: [file] } })
    await Promise.resolve()
  })
  await flush()
}

async function openRecentOnControl(text: string): Promise<void> {
  recentText = text
  fireEvent.click(screen.getByTestId('control-load-menu'))
  await flush()
  await act(async () => {
    fireEvent.click(screen.getByTestId(`control-recent-item-${recentEntry.id}`))
    await Promise.resolve()
  })
  await flush()
}

async function loadSetupOnControl(): Promise<void> {
  act(() => { fireEvent.click(screen.getByTestId('control-load-menu')) })
  await act(async () => {
    fireEvent.click(screen.getByTestId('control-load-setup-item-setup1'))
    await Promise.resolve()
  })
  await flush()
}

const stockCard = () => screen.getByTestId('program-preview-intended-stock')
const stockSummary = () => screen.getByTestId('program-preview-intended-stock-summary').textContent ?? ''
const lastSceneStock = () => sceneStockCalls[sceneStockCalls.length - 1] ?? null

/** The one claim the operator reads: the setup's stock, current, with a box. */
function expectIntendedStockShown(): void {
  expect(stockSummary()).toBe('Intended stock - CURRENT - Setup 1 (G54)')
  expect(stockCard().getAttribute('data-context-state')).toBe('current')
  expect(lastSceneStock()).toMatchObject({ stale: false })
  // Open the facts: the stock and its size, read from the envelope.
  fireEvent.click(screen.getByTestId('program-preview-intended-stock-summary'))
  expect(screen.getByTestId('program-preview-intended-stock-setup').textContent).toBe('Setup 1')
  expect(screen.getByTestId('program-preview-intended-stock-size').textContent).not.toBe('no volume (not drawn)')
  expect(screen.getByTestId('program-preview-intended-stock-wcs').textContent).toBe('G54')
  fireEvent.click(screen.getByTestId('program-preview-intended-stock-summary'))
}

describe('WO-2047: a program posted by LienCAM shows its stock on Control, whichever way it was loaded', () => {
  it('the board is Operator\'s kind: it runs staged programs, so every load goes through the program door', () => {
    expect(controllerNeedsToolpathProgram()).toBe(true)
  })

  it('Post Process > Export .nc (native save) > Control Open file: the stock box and CURRENT badge show, the board got the program', async () => {
    applyProject([op('op1', 't1')])
    const exported = await exportFromPostProcess()
    expect(exported.filename).toMatch(/\.nc$/)
    expect(exported.text).toMatch(/LCX1 end/)

    render(<ProgramPanel />)
    await openOnControl(exported.filename, exported.text)

    expect(useMachineControl.getState().programText).toBeNull()
    expect(useMachineControl.getState().stagedProgram).not.toBeNull()
    expect(socket().loadMovesFrames().length).toBeGreaterThan(0)
    expect(stagedProgramContext()?.context.source).toBe('verified-export')
    expectIntendedStockShown()
  })

  it('the same saved bytes reopened from Recent show the same stock', async () => {
    applyProject([op('op1', 't1')])
    const exported = await exportFromPostProcess()
    render(<ProgramPanel />)
    await openRecentOnControl(exported.text)

    expect(useMachineControl.getState().job.name).toBe(recentEntry.name)
    expectIntendedStockShown()
  })

  it('Control > Load > Setup 1 with a tool change (the posted route Operator used) shows the stock', async () => {
    applyProject([op('op1', 't1'), op('op2', 't2', 5)])
    render(<ProgramPanel />)
    await loadSetupOnControl()

    expect(useMachineControl.getState().job.name).toBe('Setup 1 (posted)')
    expect(socket().loadMovesFrames().length).toBeGreaterThan(0)
    expect(stagedProgramContext()?.context.source).toBe('live-setup')
    expectIntendedStockShown()
  })

  it('Control > Load > Setup 1 on one tool (the toolpath route) shows the stock', async () => {
    applyProject([op('op1', 't1')])
    render(<ProgramPanel />)
    await loadSetupOnControl()

    expect(useMachineControl.getState().job.name).toBe('Setup 1 (toolpath)')
    expect(socket().loadMovesFrames().length).toBeGreaterThan(0)
    expectIntendedStockShown()
  })

  it('an edit to the setup after loading reads STALE, not CURRENT', async () => {
    applyProject([op('op1', 't1')])
    const exported = await exportFromPostProcess()
    render(<ProgramPanel />)
    await openOnControl(exported.filename, exported.text)
    expect(stockCard().getAttribute('data-context-state')).toBe('current')

    act(() => {
      const project = useCamStore.getState().project
      useCamStore.setState({
        project: {
          ...project,
          setups: project.setups.map((s) => ({ ...s, stock: makeStock({ material: 'aluminum', width: 321 } as never) })),
        },
      })
    })
    await flush()
    expect(stockCard().getAttribute('data-context-state')).toBe('project-changed')
    expect(stockSummary()).toMatch(/^Intended stock - STALE - Setup 1 \(G54\)$/)
  })

  it('a file from another CAM system loads with no stock and no nag', async () => {
    applyProject([op('op1', 't1')])
    render(<ProgramPanel />)
    const foreign = ['%', 'G90 G21 G54', 'G0 X0 Y0 Z10', 'G1 Z1 F300', 'G1 X50 F900', 'G0 Z10', 'M30', '%'].join('\n')
    // Only what the LOAD writes: the fake bridge's connect-time notes are not this order's.
    act(() => { useMachineControl.setState({ consoleLines: [] }) })
    await openOnControl('fusion.nc', foreign)

    expect(useMachineControl.getState().stagedProgram).not.toBeNull()
    expect(stagedProgramContext()).toBeNull()
    expect(stockSummary()).toBe('Intended stock - NONE')
    expect(lastSceneStock()).toBeNull()
    const warnings = useMachineControl.getState().consoleLines.filter((l) => l.severity === 'warn' || l.severity === 'error')
    expect(warnings).toEqual([])
  })

  it('a later load of another file clears the previous program\'s stock', async () => {
    applyProject([op('op1', 't1')])
    const exported = await exportFromPostProcess()
    render(<ProgramPanel />)
    await openOnControl(exported.filename, exported.text)
    expect(stockSummary()).toBe('Intended stock - CURRENT - Setup 1 (G54)')

    const foreign = ['G90 G21 G54', 'G0 X0 Y0 Z10', 'G1 Z1 F300', 'G1 X40 F900', 'G0 Z10', 'M30'].join('\n')
    await openOnControl('other.nc', foreign)
    expect(stockSummary()).toBe('Intended stock - NONE')
    expect(lastSceneStock()).toBeNull()
  })
})
