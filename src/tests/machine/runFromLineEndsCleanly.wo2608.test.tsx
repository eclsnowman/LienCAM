// @vitest-environment jsdom
// WO-2598: production setup load and session arming on the real UCCNC class.
// The bridge is a protocol double; this is not hardware evidence.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { QueuedMove } from '../../lib/machine/controller'
import type { BridgeCallMessage, BridgeMessage, BridgeTransportEvents } from '../../lib/machine/bridgeTransport'
import type { Project, Setup } from '../../types'
import { makeMachine, makeOp, makeStock, makeTool, makeWcs, stampGenerationCurrent } from '../post/helpers'
import { typedMock } from '../support/typedMock'
import { positionMacroBody } from '../../types'

const memory = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    get length() { return memory.size },
    clear: () => memory.clear(),
    getItem: (key: string) => memory.get(key) ?? null,
    key: (index: number) => [...memory.keys()][index] ?? null,
    removeItem: (key: string) => { memory.delete(key) },
    setItem: (key: string, value: string) => { memory.set(key, value) },
  } satisfies Storage,
})

vi.mock('../../lib/viewport/CNCViewport', () => typedMock<typeof import('../../lib/viewport/CNCViewport')>({
  CNCViewport: class {
    setIntendedStock = vi.fn()
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
  } as never,
}))

let bridgeEvents: BridgeTransportEvents | null = null
const frames: BridgeCallMessage[] = []
let refuseSelect = false
let refuseLoad = false
let autoRun = false
let delayRunStatus = false
let emitStatus: (state: 'idle' | 'run') => void
vi.mock('../../lib/machine/bridgeTransport', async importOriginal => {
  const actual = await importOriginal<typeof import('../../lib/machine/bridgeTransport')>()
  class FakeBridge extends actual.BridgeTransport {
    static isSupported() { return true }
    fakeEvents: BridgeTransportEvents | null = null
    loaded: QueuedMove[] = []
    position = { x: 10, y: 5, z: 12 }
    offsetZ = 2
    status(state: 'idle' | 'run') {
      this.fakeEvents?.onMessage({ t: 'status', v: {
        state, subState: null, machinePos: { ...this.position },
        workPos: { x: this.position.x - 10, y: this.position.y - 5, z: this.position.z - this.offsetZ },
        feedMmMin: 0, spindleRpm: null, overrides: null, executingMoveId: this.loaded.at(-1)?.id ?? 0,
        buffer: { moves: 0, capacitySeconds: null }, inputs: null, homed: { X: true, Y: true, Z: true }, spindle: null,
      } })
    }
    async start(events: BridgeTransportEvents) {
      this.fakeEvents = events
      bridgeEvents = events
      emitStatus = state => this.status(state)
      const offsets = Object.fromEntries(['G54', 'G55', 'G56', 'G57', 'G58', 'G59']
        .map(wcs => [wcs, { x: 10, y: 5, z: 2 }]))
      events.onMessage({ t: 'hello', v: {
        protocol: 1, bridge: 'WO-2598 protocol double', readOnly: false,
        capabilities: { geometryQueue: true, executingMoveId: true, bufferSeconds: true,
          gcodeText: false, machineProgram: true, perAxisHoming: true,
          ownsSpindle: false, spindleCommands: false },
        workOffsets: { current: offsets, profile: offsets },
      } } as BridgeMessage)
    }
    send(message: BridgeCallMessage) {
      frames.push(message)
      if (message.m === 'loadMoves') this.loaded = (message.a as { moves: QueuedMove[] }).moves
      if (message.m === 'startJob' && autoRun) {
        this.fakeEvents?.onMessage({ t: 'jobEvent', v: { event: 'started', fault: null } })
        if (delayRunStatus) setTimeout(() => this.status('run'), 200)
        else this.status('run')
        setTimeout(() => {
          for (const move of this.loaded) if (move.kind === 'line' || move.kind === 'arc') {
            for (const axis of ['x', 'y', 'z'] as const) if (move.to[axis] !== undefined) {
              this.position[axis] = move.to[axis]! + ({ x: 10, y: 5, z: this.offsetZ })[axis]
            }
          }
          this.status('idle')
          this.fakeEvents?.onMessage({ t: 'jobEvent', v: { event: 'completed', fault: null } })
        }, delayRunStatus ? 220 : 20)
      }
      if (message.m === 'probe') this.position.z = 11
      if (message.m === 'jogToMachineZ') this.position.z = (message.a as { z: number }).z
      if (message.m === 'jogToMachineXY') Object.assign(this.position, message.a)
      if (message.m === 'setWorkOffset') this.offsetZ = (message.a as { z?: number }).z ?? this.offsetZ
      const v = message.m === 'probe' ? { ok: true, at: { ...this.position } }
        : message.m === 'setWorkOffset' ? { ok: true, offset: { x: 10, y: 5, z: this.offsetZ } }
        : message.m === 'selectWcs' && refuseSelect ? false
        : message.m === 'loadMoves' && refuseLoad ? { ok: false, reason: 'WO-2598 refused load' } : true
      const reply = () => this.fakeEvents?.onMessage({ t: 'reply', seq: message.seq, ok: true, v })
      reply()
      if (['probe', 'jogToMachineZ', 'jogToMachineXY', 'queryStatus', 'refreshState', 'setWorkOffset'].includes(message.m)) this.status('idle')
    }
    async close() { this.fakeEvents?.onClose('closed') }
  }
  return typedMock<typeof import('../../lib/machine/bridgeTransport')>({ ...actual, BridgeTransport: FakeBridge })
})

const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useMachineToolTable } = await import('../../store/machineToolTableStore')
const { ProgramPanel } = await import('../../components/machine/ProgramPanel')
const { UccncController } = await import('../../lib/machine/uccncController')
const { executeOperatorCycleStart } = await import('../../lib/machine/operatorTransport')
const {
  __resetEstopInterlockForTest, armProgramFromLine, connectMachine, disconnectMachine, getMachineController,
  loadSetupToolpathProgram, stagedProgramContext, restageLoadedProgram, sendMdiLine,
  loadGcodeTextToolpathProgram,
  continueGuidedToolChange, applyToolLengthOffset, clearToolLengthOffset, cancelGuidedToolChange,
} = await import('../../lib/machine/machineSession')

let originalProject: Project
let originalTools: ReturnType<typeof useCamStore.getState>['toolLibrary']

beforeEach(async () => {
  vi.useFakeTimers()
  frames.length = 0
  refuseSelect = false
  refuseLoad = false
  autoRun = false
  delayRunStatus = false
  useMachineControl.setState({ activeTool: 1, toolChange: null })
  useMachineToolTable.setState({ byMachine: {} })
  originalProject = useCamStore.getState().project
  originalTools = useCamStore.getState().toolLibrary
  // The post preselects the first tool without M6. Starting on T2 makes its
  // first actual change T1, matching the order's restart-after-T1 case.
  const tools = [makeTool({ id: 't2', toolNumber: 2 }), makeTool({ id: 't1', toolNumber: 1 })]
  const laterHolds = expect.getState().currentTestName?.includes('later tool change')
  const opTools = laterHolds ? [tools[0], tools[1], tools[0]] : tools
  const setup: Setup = {
    id: 'wo2598-setup', name: 'WO-2598 two tools',
    wcs: makeWcs({ id: 'wo2598-wcs', label: 'G54', fixtureOffset: 54 }),
    stock: makeStock(), notes: '',
    operations: opTools.map((tool, index) => makeOp({
      id: `wo2598-op-${index}`, name: `Tool ${tool.toolNumber}`, toolId: tool.id,
      toolpathMoves: [
        { type: 'rapid', x: 20 + index * 40, y: 10, z: 10 },
        { type: 'feed', x: 20 + index * 40, y: 10, z: -1, feed: 300 },
        { type: 'feed', x: 30 + index * 40, y: 10, z: -1, feed: 900 },
        { type: 'rapid', x: 30 + index * 40, y: 10, z: 10 },
      ],
    })),
  }
  const project: Project = {
    ...originalProject, id: 'wo2598-project', setups: [setup], activeSetupId: setup.id,
    toolLibrary: tools,
    machine: makeMachine({ id: 'wo2598-machine', controller: 'uccnc', rapidRate: 5000, safeZMachine: 80 }),
  }
  setup.operations.forEach((op, index) => stampGenerationCurrent(project, setup, op, opTools[index]))
  useCamStore.setState({ project, toolLibrary: tools, modelRefsVerifiedSinceLoad: true })
  const connecting = connectMachine('bridge')
  await vi.advanceTimersByTimeAsync(300)
  await connecting
  __resetEstopInterlockForTest()
  useMachineControl.getState().clearConsole()
  bridgeEvents!.onMessage({ t: 'status', v: {
    state: 'idle', subState: null, machinePos: { x: 10, y: 5, z: 12 },
    workPos: { x: 0, y: 0, z: 10 }, feedMmMin: 0, spindleRpm: null,
    overrides: null, executingMoveId: 0, buffer: { moves: 0, capacitySeconds: null },
    inputs: null, homed: { X: true, Y: true, Z: true }, spindle: null,
  } })
  bridgeEvents!.onMessage({ t: 'homed', v: { axes: ['X', 'Y', 'Z'] } })
  expect(getMachineController()).toBeInstanceOf(UccncController)
  expect(getMachineController().capabilities.gcodeText).toBe(false)
  const loaded = await loadSetupToolpathProgram(setup.id)
  await vi.advanceTimersByTimeAsync(100)
  expect(loaded.ok, loaded.reason ?? undefined).toBe(true)
  expect(useMachineControl.getState().programText).toBeNull()
  expect(useMachineControl.getState().stagedProgram).not.toBeNull()
  expect(stagedProgramContext()).not.toBeNull()

})

afterEach(async () => {
  cleanup()
  cancelGuidedToolChange()
  clearToolLengthOffset()
  await vi.advanceTimersByTimeAsync(100)
  const disconnecting = disconnectMachine()
  await vi.advanceTimersByTimeAsync(300)
  await disconnecting
  useCamStore.setState({ project: originalProject, toolLibrary: originalTools })
  useMachineControl.getState().setProgram(null, null, [])
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function target() {
  const text = stagedProgramContext()!.text
  const lines = text.split(/\r?\n/)
  const line = lines.findIndex(raw => /^X70(?:\.0+)?(?:\s|$)/.test(raw)) + 1
  expect(line).toBeGreaterThan(1)
  return { text, line }
}

describe('WO-2608 restart finishes like a run from the top', () => {
  it.each(['lifecycle first', 'status first'] as const)('WO-2609: %s never offers a fresh start while the native run begins', async order => {
    // Kit K4: status and lifecycle travel separately. Exercise each arrival
    // order through the real UCCNC adapter and production file door.
    expect(loadGcodeTextToolpathProgram('poll-gap.nc', [
      'G90 G21 G54 T1', 'G0 X10 Z10', 'G1 X20 F600', 'M0',
      'G1 X30 F600', 'M30',
    ].join('\n'), { publishListing: true }).ok).toBe(true)
    await vi.advanceTimersByTimeAsync(300)
    const { ControlTransportBar } = await import('../../components/machine/ControlTransportBar')
    render(<><ProgramPanel /><ControlTransportBar /></>)
    if (order === 'lifecycle first') {
      autoRun = true
      delayRunStatus = true
      await act(async () => {
        expect(await executeOperatorCycleStart()).toBe(true)
        await vi.advanceTimersByTimeAsync(32)
      })
      expect(useMachineControl.getState().job.phase).toBe('streaming')
      expect(useMachineControl.getState().machineState).toBe('idle')
      expect(screen.getByTestId('control-program-context').textContent).toMatch(/ running$/)
      expect(screen.getByTestId('control-state-chip').textContent).toBe('Running')
    } else {
      // A Run status is attributed only after this file was started. The
      // fixture withholds the lifecycle edge, as the real poll gap does.
      const readyReceipt = useMachineControl.getState().job
      await act(async () => {
        expect(await executeOperatorCycleStart()).toBe(true)
        emitStatus('run')
        await vi.advanceTimersByTimeAsync(32)
        // The adapter's progress already says streaming. Retain the ready
        // receipt explicitly to exercise the transport's stale-store route,
        // rather than pretending an unstarted queue is the running program.
        expect(getMachineController().jobProgress().phase).toBe('streaming')
        useMachineControl.setState({ job: readyReceipt })
      })
      expect(useMachineControl.getState().job.phase).toBe('ready')
      expect(useMachineControl.getState().machineState).toBe('run')
    }
    expect(screen.getByTestId('control-next-action').textContent).toMatch(/Program is running/)
    expect(screen.getByTestId('control-next-action').textContent).not.toMatch(/checks passed|begins the program/)
    expect(screen.getByTestId('control-cyclestart').hasAttribute('disabled')).toBe(true)
  })

  it('WO-2609: a jog beside a ready file cannot borrow a stale executing id as a program start', async () => {
    expect(loadGcodeTextToolpathProgram('jog-beside-ready.nc', [
      'G90 G21 G54 T1', 'G0 X10 Z10', 'G1 X20 F600', 'M30',
    ].join('\n'), { publishListing: true }).ok).toBe(true)
    await vi.advanceTimersByTimeAsync(300)
    const { ControlTransportBar } = await import('../../components/machine/ControlTransportBar')
    render(<><ProgramPanel /><ControlTransportBar /></>)
    await act(async () => {
      expect(getMachineController().jog('X', 1, 600)).toBe(true)
      emitStatus('run')
      await vi.advanceTimersByTimeAsync(32)
    })
    expect(frames.some(frame => frame.m === 'startJob')).toBe(false)
    expect(useMachineControl.getState().executingMoveId).toBeGreaterThan(0)
    expect(useMachineControl.getState().job.phase).toBe('ready')
    expect(screen.getByTestId('control-cyclestart').getAttribute('data-tooltip')).toBe('Machine must be idle.')
    expect(screen.getByTestId('control-next-action').textContent).toBe('Wait for the machine to become idle.')
    expect(screen.getByTestId('control-cyclestart').hasAttribute('disabled')).toBe(true)
  })

  it('WO-2609: Stop at a posted M6 retains From line planning and resets progress before the chosen line runs', async () => {
    const project = useCamStore.getState().project
    const machine = { ...project.machine!, macros: [{ id: 'setter', name: 'Tool change', usedForToolChange: true,
      body: positionMacroBody({ x: 10, y: 5, z: 12, zFirst: true }) }] }
    useCamStore.setState({ project: { ...project, machine } })
    const table = useMachineToolTable.getState()
    table.recordProbedZ(machine.id, 2, 12, 1)
    table.setReference(machine.id, 2)
    useMachineControl.setState({ activeTool: 2 })
    expect(restageLoadedProgram()).toBe(true)
    await vi.advanceTimersByTimeAsync(300)
    autoRun = true
    render(<ProgramPanel />)
    await act(async () => { expect(await executeOperatorCycleStart()).toBe(true); await vi.advanceTimersByTimeAsync(2000) })
    if (useMachineControl.getState().toolChange === null) {
      await act(async () => { expect(await executeOperatorCycleStart()).toBe(true); await vi.advanceTimersByTimeAsync(2000) })
    }
    expect(useMachineControl.getState().toolChange, useMachineControl.getState().consoleLines.map(row => row.text).join('\n')).toMatchObject({ step: 'awaiting-swap', tool: 1 })
    await act(async () => { fireEvent.click(screen.getByTestId('control-tc-cancel')); await vi.advanceTimersByTimeAsync(1000) })
    expect(useMachineControl.getState().job.phase).toBe('ready')
    expect(screen.getByTestId('control-progress-text').textContent).toMatch(/^0\/\d+ \(0%\)/)
    expect(screen.getByTestId('control-progress-fill').style.width).toBe('0%')
    const line = stagedProgramContext()!.text.split(/\r?\n/).findIndex(raw => /^X30(?:\.0+)?(?:\s|$)/.test(raw)) + 1
    expect(line).toBeGreaterThan(1)
    await act(async () => {
      fireEvent.change(screen.getByTestId('control-runfrom-input'), { target: { value: String(line) } })
    })
    await act(async () => { fireEvent.click(screen.getByTestId('control-runfrom-plan')); await vi.advanceTimersByTimeAsync(1000) })
    expect(useMachineControl.getState().armedFromLine).toBe(line)
    const mark = frames.length
    await act(async () => { expect(await executeOperatorCycleStart()).toBe(true); await vi.advanceTimersByTimeAsync(2000) })
    if (useMachineControl.getState().toolChange === null) {
      await act(async () => { expect(await executeOperatorCycleStart()).toBe(true); await vi.advanceTimersByTimeAsync(2000) })
    }
    expect(frames.slice(mark).some(frame => frame.m === 'startJob')).toBe(true)
    expect(getMachineController().status().workPos?.x).toBe(30)
    expect(useMachineControl.getState().toolChange).toMatchObject({ step: 'awaiting-swap', tool: 1 })
  })

  it('no spindle link: one tool-change card owns the prelude spindle start, then the restart finishes without another hold', async () => {
    const { line } = target()
    const project = useCamStore.getState().project
    const machine = { ...project.machine!, macros: [{ id: 'setter', name: 'Tool change', usedForToolChange: true,
      body: positionMacroBody({ x: 10, y: 5, z: 12, zFirst: true }) }] }
    useCamStore.setState({ project: { ...project, machine } })
    const table = useMachineToolTable.getState()
    table.recordProbedZ(machine.id, 2, 12, 1)
    table.setReference(machine.id, 2)
    useMachineControl.setState({ activeTool: 2 })
    expect((await armProgramFromLine(line)).ok).toBe(true)
    autoRun = true
    expect(await executeOperatorCycleStart()).toBe(true)
    await vi.advanceTimersByTimeAsync(2000)
    expect(useMachineControl.getState().toolChange).toMatchObject({ step: 'awaiting-swap', tool: 1 })
    expect(useMachineControl.getState().toolChange!.message).toMatch(/Start the spindle.*RPM/)
    const measured = continueGuidedToolChange({ positioningFeed: 1000, fastFeed: 400, slowFeed: 50,
      retract: 2, maxTravel: 30, surfaceClearance: 5, overtravel: 5, crossOverLift: 10, padThickness: 10 },
      z => { table.recordProbedZ(machine.id, 1, z, 2); return { ok: applyToolLengthOffset(z - 12) } })
    let result: boolean | undefined
    void measured.then(value => { result = value })
    for (let i = 0; i < 800 && result === undefined; i++) await vi.advanceTimersByTimeAsync(50)
    expect(result).toBe(true)
    await vi.advanceTimersByTimeAsync(3000)
    expect(useMachineControl.getState().job.phase).toBe('complete')
    expect(useMachineControl.getState().consoleLines.map(row => row.text).join('\n')).not.toMatch(/asks for the spindle.*press CYCLE START/)
  })

  it('a finished program reports finished once; subsequent MDI and duplicate terminal events do not repeat it', async () => {
    const { line } = target()
    expect((await armProgramFromLine(line)).ok).toBe(true)
    autoRun = true
    expect(await executeOperatorCycleStart()).toBe(true)
    await vi.advanceTimersByTimeAsync(1000)
    expect(await executeOperatorCycleStart()).toBe(true)
    await vi.advanceTimersByTimeAsync(2000)
    expect(useMachineControl.getState().job.phase).toBe('complete')
    const finished = () => useMachineControl.getState().consoleLines.filter(row => / finished\.$/.test(row.text))
    expect(finished()).toHaveLength(1)
    expect(sendMdiLine('G53 G0 Z12')).toBe(true)
    await vi.advanceTimersByTimeAsync(2000)
    expect(finished()).toHaveLength(1)
    bridgeEvents!.onMessage({ t: 'jobEvent', v: { event: 'completed', fault: null } })
    expect(finished()).toHaveLength(1)
  })

  it('the completed posted route names From line and Plan, matching the controls on screen', async () => {
    const { line } = target()
    expect((await armProgramFromLine(line)).ok).toBe(true)
    autoRun = true
    expect(await executeOperatorCycleStart()).toBe(true)
    await vi.advanceTimersByTimeAsync(1000)
    expect(await executeOperatorCycleStart()).toBe(true)
    await vi.advanceTimersByTimeAsync(2000)
    const { ControlTransportBar } = await import('../../components/machine/ControlTransportBar')
    render(<><ProgramPanel /><ControlTransportBar /></>)
    expect(screen.getByTestId('control-runfrom-input')).toBeTruthy()
    // WO-2686 (the operator, 10-08): the end sentence names CYCLE START, which runs it from line 1.
    expect(screen.getByTestId('control-next-action').textContent).toContain('CYCLE START runs the program from line 1.')
    expect(screen.getByTestId('control-next-action').textContent).not.toContain('load the toolpath again')
  })
})
