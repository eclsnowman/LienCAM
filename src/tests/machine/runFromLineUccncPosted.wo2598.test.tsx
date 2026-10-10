// @vitest-environment jsdom
// WO-2598: production setup load and session arming on the real UCCNC class.
// The bridge is a protocol double; this is not hardware evidence.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { writeFileSync } from 'node:fs'
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
let holdSelect = false
let answerSelect: (() => void) | null = null
let autoRun = false
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
        this.status('run')
        setTimeout(() => {
          for (const move of this.loaded) if (move.kind === 'line' || move.kind === 'arc') {
            for (const axis of ['x', 'y', 'z'] as const) if (move.to[axis] !== undefined) {
              this.position[axis] = move.to[axis]! + ({ x: 10, y: 5, z: this.offsetZ })[axis]
            }
          }
          this.status('idle')
          this.fakeEvents?.onMessage({ t: 'jobEvent', v: { event: 'completed', fault: null } })
        }, 20)
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
      if (message.m === 'selectWcs' && holdSelect) answerSelect = reply
      else reply()
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
const { buildRunFromLinePlan } = await import('../../lib/machine/runFromLine')
const {
  __resetEstopInterlockForTest, armProgramFromLine, connectMachine, disconnectMachine, getMachineController,
  loadSetupToolpathProgram, loadedProgramText, restageLoadedProgram, stagedProgramContext, sendMdiLine,
  continueGuidedToolChange, applyToolLengthOffset, clearToolLengthOffset, cancelGuidedToolChange,
} = await import('../../lib/machine/machineSession')

let originalProject: Project
let originalTools: ReturnType<typeof useCamStore.getState>['toolLibrary']

beforeEach(async () => {
  vi.useFakeTimers()
  frames.length = 0
  refuseSelect = false
  refuseLoad = false
  holdSelect = false
  answerSelect = null
  autoRun = false
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
  if (!laterHolds) {
    writeFileSync('src/tests/evidence/WO-2598/posted.nc', stagedProgramContext()!.text)
    writeFileSync('src/tests/evidence/WO-2598/fixture.json', JSON.stringify({ project, tools }, null, 2))
  }
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

describe('WO-2598 UCCNC posted setup run from line', () => {
  it.each([2, null])('fits the restart tool through the guided M6 before releasing the prelude (reported %s)', async fitted => {
    const { line } = target()
    const project = useCamStore.getState().project
    const machine = { ...project.machine!, macros: [{
      id: 'wo2598-setter', name: 'Tool change', usedForToolChange: true,
      body: positionMacroBody({ x: 10, y: 5, z: 12, zFirst: true }),
    }] }
    useCamStore.setState({ project: { ...project, machine } })
    useMachineToolTable.setState({ byMachine: {} })
    const table = useMachineToolTable.getState()
    table.recordProbedZ(machine.id, 2, 12, 1)
    table.setReference(machine.id, 2)
    useMachineControl.setState({ activeTool: fitted })
    const loaded = vi.spyOn(UccncController.prototype, 'loadProgram')
    expect((await armProgramFromLine(line)).ok).toBe(true)
    // The only initial queue is the existing zero-motion completion fence.
    expect(loaded.mock.calls[0][0].steps.every(step => step.kind === 'dwell')).toBe(true)
    autoRun = true
    expect(await executeOperatorCycleStart()).toBe(true)
    await vi.advanceTimersByTimeAsync(2000)
    expect(useMachineControl.getState().toolChange).toMatchObject({ mode: 'toolChange', tool: 1, step: 'awaiting-swap' })
    expect(useMachineControl.getState().activeTool).toBe(fitted)
    const before = frames.filter(frame => frame.m === 'startJob').length
    expect(await executeOperatorCycleStart()).toBe(false)
    await vi.advanceTimersByTimeAsync(200)
    expect(frames.filter(frame => frame.m === 'startJob').length).toBe(before)
    const applies: number[] = []
    const measured = continueGuidedToolChange({ positioningFeed: 1000, fastFeed: 400, slowFeed: 50,
      retract: 2, maxTravel: 30, surfaceClearance: 5, overtravel: 5, crossOverLift: 10, padThickness: 10,
    }, z => {
      applies.push(z)
      table.recordProbedZ(machine.id, 1, z, 2)
      return { ok: applyToolLengthOffset(z - 12) }
    })
    let measureResult: boolean | undefined
    void measured.then(value => { measureResult = value })
    for (let tick = 0; tick < 800 && measureResult === undefined; tick++) await vi.advanceTimersByTimeAsync(50)
    expect(measureResult, JSON.stringify({ card: useMachineControl.getState().toolChange,
      calls: frames.filter(frame => frame.m !== 'queryStatus').slice(-8),
    })).toBe(true)
    expect(applies).toEqual([11])
    expect(useMachineControl.getState().activeTool).toBe(1)
    expect(frames.filter(frame => frame.m === 'probe')).toHaveLength(2)
    expect(frames.some(frame => frame.m === 'setWorkOffset' && (frame.a as { z?: number }).z === 1)).toBe(true)
    writeFileSync(`src/tests/evidence/WO-2598/fix-guided-${fitted ?? 'unknown'}.json`, JSON.stringify({ fitted, applies, state: useMachineControl.getState().toolChange, frames }, null, 2))
  })

  it('completes the restarted file, unlocks MDI and announces the original section', async () => {
    const { line } = target()
    const context = stagedProgramContext()!
    const listing = useMachineControl.getState().stagedProgram!
    const section = listing.setups.filter(setup => (context.lineOfStep(setup.firstStepId) ?? Infinity) <= line).at(-1)!
    expect(section.setupName).not.toBe('File section 1')
    expect((await armProgramFromLine(line)).ok).toBe(true)
    autoRun = true
    expect(await executeOperatorCycleStart()).toBe(true)
    await vi.advanceTimersByTimeAsync(1000)
    // Answer the existing manual-spindle hold, then run to M30.
    expect(await executeOperatorCycleStart()).toBe(true)
    await vi.advanceTimersByTimeAsync(2000)
    const state = useMachineControl.getState()
    expect(state.job.phase).toBe('complete')
    expect(sendMdiLine('G4 P0')).toBe(true)
    writeFileSync('src/tests/evidence/WO-2598/fix-completion.json', JSON.stringify({ section, job: state.job, console: state.consoleLines, frames }, null, 2))
  })

  it('announces the original section for the restarted queue', async () => {
    const { line } = target()
    const context = stagedProgramContext()!
    const section = useMachineControl.getState().stagedProgram!.setups
      .filter(setup => (context.lineOfStep(setup.firstStepId) ?? Infinity) <= line).at(-1)!
    expect(section.setupName).toBe('File section 3')
    expect((await armProgramFromLine(line)).ok).toBe(true)
    autoRun = true
    expect(await executeOperatorCycleStart()).toBe(true)
    await vi.advanceTimersByTimeAsync(1000)
    const rows = useMachineControl.getState().consoleLines.map(row => row.text)
    expect(rows).toContain(`${section.setupName} (G54) started.`)
    expect(rows).not.toContain('File section 1 (G54) started.')
  })
  it('the shared planner identifies T1 and reconstructs work offset, spindle and safe Z', () => {
    const { text, line } = target()
    const planned = buildRunFromLinePlan(text, line, { safeZMachine: 140 })
    expect(planned.ok).toBe(true)
    if (!planned.ok) throw new Error(planned.reason)
    expect(planned.plan.tool?.number).toBe(1)
    writeFileSync('src/tests/evidence/WO-2598/planner.json', JSON.stringify(planned, null, 2))
    expect(planned.plan.prelude).toContain('G54')
    expect(planned.plan.prelude.some(raw => /M3/.test(raw))).toBe(true)
    const lift = planned.plan.prelude.findIndex(raw => raw === 'G53 G0 Z140')
    const xy = planned.plan.prelude.findIndex(raw => /[XY]-?\d/.test(raw))
    expect(lift).toBeGreaterThanOrEqual(0)
    expect(xy).toBeGreaterThan(lift)
  })

  it('shows From line for a loaded posted two-tool setup', () => {
    render(<ProgramPanel />)
    expect(screen.queryByTestId('control-runfrom-input')).not.toBeNull()
  })

  it('arms the chosen line through the existing session entry point', async () => {
    const { line } = target()
    const listing = useMachineControl.getState().stagedProgram
    const original = loadedProgramText()
    const load = vi.spyOn(UccncController.prototype, 'loadProgram')
    frames.length = 0
    let armed: Awaited<ReturnType<typeof armProgramFromLine>> | undefined
    await act(async () => { armed = await armProgramFromLine(line) })
    writeFileSync('src/tests/evidence/WO-2598/session-arm.json', JSON.stringify({ line, armed }, null, 2))
    expect(armed).toMatchObject({ ok: true, from: 'line', plan: { startLine: line, tool: { number: 1 } } })
    expect(armed && armed.ok && armed.from === 'line' && armed.plan.prelude[0]).toBe('T1')
    expect(armed && armed.ok && armed.from === 'line' && armed.plan.prelude).toContain('G53 G0 Z80')
    expect(load).toHaveBeenCalledTimes(1)
    const moves = load.mock.calls[0][0].steps.filter(step => step.kind === 'line')
    // G53 safe Z is resolved into G54 work coordinates using the reported Z2 offset.
    expect(moves[0].to).toEqual({ z: 78 })
    expect(moves).toHaveLength(1)
    expect(moves[0].rapid).toBe(true)
    expect(frames.some(frame => frame.m === 'startJob')).toBe(false)
    expect(useMachineControl.getState().programText).toBeNull()
    expect(useMachineControl.getState().stagedProgram).toBe(listing)
    expect(loadedProgramText()).toBe(original)
    expect(useMachineControl.getState().armedFromLine).toBe(line)
    const numbering = useMachineControl.getState().stagedNumbering!
    expect(numbering.fileTotal).toBe(listing!.program.steps.length)
    expect(numbering.stepOf?.(moves[0].id)).toBe(listing!.program.steps.find(step => stagedProgramContext()!.lineOfStep(step.id) === line)?.id)
    writeFileSync('src/tests/evidence/WO-2598/staged-arm.json', JSON.stringify({ armed, staged: load.mock.calls[0][0], frames }, null, 2))
  })

  it('plans in the UI using source lines and Cancel restores the whole posted program', async () => {
    const { line } = target()
    const text = loadedProgramText()
    render(<ProgramPanel />)
    fireEvent.change(screen.getByTestId('control-runfrom-input'), { target: { value: String(line) } })
    await act(async () => { fireEvent.click(screen.getByTestId('control-runfrom-plan')) })
    expect(screen.getByTestId('control-runfrom-target').textContent).toBe(`${line}: X70 F900`)
    expect(screen.getByTestId('control-runfrom-tool').textContent).toContain('T1')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Cancel$/ }))
      await vi.advanceTimersByTimeAsync(100)
    })
    expect(screen.queryByTestId('control-runfrom-planbox')).toBeNull()
    expect(useMachineControl.getState().armedFromLine).toBeNull()
    expect(useMachineControl.getState().stagedNumbering).toBeNull()
    expect(loadedProgramText()).toBe(text)
    expect(getMachineController().jobProgress().phase).toBe('ready')
  })

  it('maps a staged row gesture to the original posted source line', async () => {
    const { line } = target()
    render(<ProgramPanel />)
    const row = [...document.querySelectorAll('.gcode-line')].find(el => el.textContent?.includes('X70'))!
    expect(row).toBeTruthy()
    fireEvent.click(row)
    expect((screen.getByTestId('control-runfrom-input') as HTMLInputElement).value).toBe(String(line))
    await act(async () => { fireEvent.contextMenu(row) })
    await act(async () => { fireEvent.click(screen.getByTestId('control-line-menu-runfrom')) })
    expect(screen.getByTestId('control-runfrom-target').textContent).toBe(`${line}: X70 F900`)
  })

  it('restores the whole program after an invalid replan and accepts the first line', async () => {
    const { line, text } = target()
    expect((await armProgramFromLine(line)).ok).toBe(true)
    expect(await armProgramFromLine(999)).toMatchObject({ ok: false, reason: expect.stringContaining('outside') })
    await vi.advanceTimersByTimeAsync(100)
    expect(useMachineControl.getState().stagedNumbering).toBeNull()
    expect(loadedProgramText()).toBe(text)
    expect(await armProgramFromLine(1)).toEqual({ ok: true, from: 'top' })
    expect(useMachineControl.getState().programReadiness.ready).toBe(true)
    expect(useMachineControl.getState().armedFromLine).toBeNull()
  })

  it('a second line start still uses the full source and original numbering', async () => {
    const { line, text } = target()
    expect((await armProgramFromLine(line)).ok).toBe(true)
    expect((await armProgramFromLine(line - 1)).ok).toBe(true)
    expect(useMachineControl.getState().armedFromLine).toBe(line - 1)
    expect(loadedProgramText()).toBe(text)
    expect(useMachineControl.getState().stagedNumbering?.fileTotal).toBe(useMachineControl.getState().stagedProgram!.program.steps.length)
  })

  it('returns an asynchronous frame refusal and restores a previously armed slice', async () => {
    const { line } = target()
    expect((await armProgramFromLine(line)).ok).toBe(true)
    refuseSelect = true
    expect(await armProgramFromLine(line - 1)).toMatchObject({ ok: false, reason: expect.stringContaining('did not confirm G54') })
    refuseSelect = false
    expect(restageLoadedProgram()).toBe(true)
    await vi.advanceTimersByTimeAsync(100)
    expect(useMachineControl.getState().stagedNumbering).toBeNull()
  })

  it('reports a bridge load refusal instead of claiming an armed line', async () => {
    refuseLoad = true
    expect(await armProgramFromLine(target().line)).toMatchObject({ ok: false, reason: 'WO-2598 refused load' })
    expect(useMachineControl.getState().programReadiness.ready).toBe(false)
    expect(frames.some(frame => frame.m === 'startJob')).toBe(false)
  })

  it('a pending frame blocks Cycle Start and a superseding load abandons the arm', async () => {
    holdSelect = true
    const armed = armProgramFromLine(target().line)
    expect(useMachineControl.getState().programReadiness.ready).toBe(false)
    const answer = answerSelect!
    holdSelect = false
    expect(restageLoadedProgram()).toBe(true)
    answer()
    expect(await armed).toMatchObject({ ok: false, reason: expect.stringContaining('Another program') })
    await vi.advanceTimersByTimeAsync(100)
    expect(useMachineControl.getState().armedFromLine).toBeNull()
  })

  it('refuses an alarm or live program without changing the staged queue', async () => {
    const load = vi.spyOn(UccncController.prototype, 'loadProgram')
    useMachineControl.setState({ machineState: 'alarm' })
    expect(await armProgramFromLine(target().line)).toMatchObject({ ok: false, reason: expect.stringContaining('alarm') })
    useMachineControl.setState({ machineState: 'idle' })
    vi.spyOn(getMachineController(), 'hasActiveJob').mockReturnValue(true)
    expect(await armProgramFromLine(target().line)).toMatchObject({ ok: false, reason: expect.stringContaining('still running') })
    expect(load).not.toHaveBeenCalled()
  })


  it('keeps a later tool change held at its original M6 line', async () => {
    const { line, text } = target()
    const laterM6 = text.split(/\r?\n/).findIndex((raw, index) => index > line && /T2 M6/.test(raw)) + 1
    expect(laterM6).toBeGreaterThan(line)
    const armed = await armProgramFromLine(line)
    expect(armed.ok).toBe(true)
    frames.length = 0
    autoRun = true
    expect(await executeOperatorCycleStart(), useMachineControl.getState().consoleLines.map(row => row.text).join('\n')).toBe(true)
    await vi.advanceTimersByTimeAsync(1000)
    // This desk double has no spindle link: answer its existing manual-spindle hold.
    expect(await executeOperatorCycleStart()).toBe(true)
    await vi.advanceTimersByTimeAsync(1000)
    const state = useMachineControl.getState()
    writeFileSync('src/tests/evidence/WO-2598/later-holds.json', JSON.stringify({ text, line, laterM6, state, frames }, null, 2))
    expect(state.job.phase).toBe('paused')
    expect(state.consoleLines.some(row => row.text.includes(`line ${laterM6}`)), state.consoleLines.map(row => row.text).join('\n')).toBe(true)
    const before = frames.filter(frame => frame.m === 'startJob').length
    await vi.advanceTimersByTimeAsync(1000)
    expect(frames.filter(frame => frame.m === 'startJob').length).toBe(before)
    expect(state.stagedNumbering?.fileTotal).toBe(state.stagedProgram!.program.steps.length)
    writeFileSync('src/tests/evidence/WO-2598/later-holds.json', JSON.stringify({ text, line, laterM6, toolChange: state.toolChange, console: state.consoleLines, frames }, null, 2))
  })

})
