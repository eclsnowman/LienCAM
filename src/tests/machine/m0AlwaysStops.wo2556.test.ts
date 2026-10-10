// @vitest-environment jsdom
//
// Production file/text doors and ProgramPanel Continue, with readbacks from
// the simulator and real UccncController over a fake geometry bridge.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

const memory = new Map<string, string>()
const storage: Storage = {
  get length() { return memory.size },
  clear: () => memory.clear(),
  getItem: (key) => memory.get(key) ?? null,
  key: (index) => [...memory.keys()][index] ?? null,
  removeItem: (key) => { memory.delete(key) },
  setItem: (key, value) => { memory.set(key, String(value)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true })

import type { BridgeCallMessage, BridgeMessage, BridgeTransportEvents } from '../../lib/machine/bridgeTransport'
import type { MachineStatus, QueuedMove } from '../../lib/machine/controller'
import { typedMock } from '../support/typedMock'

let bridge: {
  sent: BridgeCallMessage[]
  received: BridgeMessage[]
  emit: (message: BridgeMessage) => void
  emitStatus: () => void
} | null = null
vi.mock('../../lib/machine/bridgeTransport', async importOriginal => {
  const actual = await importOriginal<typeof import('../../lib/machine/bridgeTransport')>()
  class FakeBridge extends actual.BridgeTransport {
    static isSupported() { return true }
    sent: BridgeCallMessage[] = []
    received: BridgeMessage[] = []
    fakeEvents: BridgeTransportEvents | null = null
    pos = { x: 0, y: 0, z: -1 }
    offset = { x: 0, y: 0, z: -10 }
    moves: QueuedMove[] = []
    state: MachineStatus['state'] = 'idle'
    constructor() { super(); bridge = this }
    emit(message: BridgeMessage) { this.received.push(message); this.fakeEvents?.onMessage(message) }
    emitStatus() {
      this.emit({ t: 'status', v: {
        state: this.state, subState: null, machinePos: { ...this.pos },
        workPos: { x: this.pos.x - this.offset.x, y: this.pos.y - this.offset.y, z: this.pos.z - this.offset.z },
        feedMmMin: 0, spindleRpm: null, overrides: null, executingMoveId: 0,
        buffer: { moves: 0, capacitySeconds: null }, inputs: null, homed: null, spindle: null,
      } })
    }
    async start(events: BridgeTransportEvents) {
      this.fakeEvents = events
      const offsets = Object.fromEntries(['G54', 'G55', 'G56', 'G57', 'G58', 'G59'].map(wcs => [wcs, this.offset]))
      this.emit({ t: 'hello', v: { protocol: 1, bridge: 'WO-2556 desk fake', readOnly: false,
        capabilities: { geometryQueue: true, executingMoveId: true, bufferSeconds: true, machineProgram: true,
          perAxisHoming: true, gcodeText: false, spindleCommands: false, ownsSpindle: false },
        workOffsets: { current: offsets, profile: offsets },
      } } as BridgeMessage)
    }
    send(message: BridgeCallMessage) {
      this.sent.push(message)
      const a = message.a as Record<string, number>
      let value: unknown = true
      if (message.m === 'setWorkOffset') {
        for (const axis of ['x', 'y', 'z'] as const) if (a[axis] !== undefined) this.offset[axis] = a[axis]
        value = { ok: true, offset: { ...this.offset } }
        this.emitStatus()
      }
      if (message.m === 'loadMoves') this.moves = (message.a as { moves: QueuedMove[] }).moves
      if (message.m === 'startJob') {
        this.state = 'run'; this.emitStatus()
        setTimeout(() => {
          for (const move of this.moves) if (move.kind === 'line' || move.kind === 'arc') {
            for (const axis of ['x', 'y', 'z'] as const) if (move.to[axis] !== undefined) this.pos[axis] = move.to[axis]! + this.offset[axis]
          }
          this.state = 'idle'; this.emitStatus()
          this.emit({ t: 'jobEvent', v: { event: 'completed', fault: null } })
        }, 20)
      }
      if (message.m === 'jogToMachineZ') this.pos.z = a.z
      if (message.m === 'jogToWorkXY') { this.pos.x = a.x + this.offset.x; this.pos.y = a.y + this.offset.y }
      if (message.m === 'probe') {
        this.pos.z = -40
        value = { ok: true, at: { ...this.pos } }
      }
      if (['jogToMachineZ', 'jogToWorkXY', 'probe'].includes(message.m)) {
        setTimeout(() => this.emitStatus(), 1)
      }
      this.emit({ t: 'reply', seq: message.seq, ok: true, v: value })
    }
    async close() { this.fakeEvents?.onClose('closed') }
  }
  return typedMock<typeof import('../../lib/machine/bridgeTransport')>({ ...actual, BridgeTransport: FakeBridge })
})

const { useCamStore } = await import('../../store')
const { ProgramPanel } = await import('../../components/machine/ProgramPanel')
const { useMachineActions } = await import('../../store/machineActionsStore')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useMachineToolTable } = await import('../../store/machineToolTableStore')
const { executeOperatorCycleStart } = await import('../../lib/machine/operatorTransport')
const { positionMacroBody } = await import('../../types')
const {
  __resetEstopInterlockForTest,
  cancelGuidedToolChange,
  connectMachine,
  disconnectMachine,
  getMachineController,
  loadGcodeTextToolpathProgram,
  loadMachineProgram,
  setWorkOffsetValue,
  armProgramFromLine,
} = await import('../../lib/machine/machineSession')

const MACHINE_ID = 'wo2556-simulator'
const PARK = { id: 'm6-pad', label: 'Fixed tool probe', x: 5, y: 5, z: -2 }

function configureMachine(backend: string): void {
  const machine = useCamStore.getState().project.machine
  useCamStore.getState().setProjectMachine({
    ...machine,
    id: MACHINE_ID,
    name: 'WO-2556 simulator',
    controller: backend === 'bridge' || expect.getState().currentTestName?.includes('four-section') ? 'uccnc' : 'grbl',
    spindleDirection: expect.getState().currentTestName?.includes('spindle reverses') ? 'ccw' : 'cw',
    controllerDefinition: undefined,
    unsentSettings: undefined,
    travel: { x: 100, y: 100, z: 100 },
    rapidRate: 60000,
    homeConvention: {
      x: { homesToward: 'min', machineZeroAt: 'min' },
      y: { homesToward: 'min', machineZeroAt: 'min' },
      z: { homesToward: 'max', homePositionMm: 5 },
    },
    macros: [{
      id: PARK.id,
      name: PARK.label,
      body: positionMacroBody({ x: PARK.x, y: PARK.y, z: PARK.z, zFirst: true }),
      usedForToolChange: true,
    }],
    safeZMachine: PARK.z,
  })
}

async function advance(ms: number): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

function writeEvidence(name: string, evidence: unknown): void {
  if (process.env.WRITE_EVIDENCE !== '1') return
  const directory = join(process.cwd(), 'src/tests/evidence/WO-2556')
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, name), `${JSON.stringify(evidence, null, 2)}\n`)
}

interface RunRecord {
  guidedStops: { tool: number | null; resumeLine: number; heldAtLine: number }[]
  plainHolds: { ackedSourceLine: number }[]
  phase: string
  finalMachineX: number | undefined
  loopGuardTripped: boolean
}

/** Start the program and play the operator: Continue on every tool-change card
 * (the probe measures the fitted tool), CYCLE START on a plain hold. Stops at
 * program end, or after more stops than the program has changes (the loop). */
async function runToEnd(): Promise<RunRecord> {
  const record: RunRecord = { guidedStops: [], plainHolds: [], phase: '', finalMachineX: undefined, loopGuardTripped: false }
  await act(async () => { expect(await executeOperatorCycleStart(), useMachineControl.getState().consoleLines.map(l => l.text).join('\n')).toBe(true) })
  for (let tick = 0; tick < 120; tick++) {
    await advance(500)
    const s = useMachineControl.getState()
    if (s.job.phase === 'complete' && s.machineState === 'idle' && s.toolChange === null) break
    if (record.guidedStops.length > 6) {
      record.loopGuardTripped = true
      break
    }
    if (s.toolChange?.step === 'awaiting-swap') {
      record.guidedStops.push({
        tool: s.toolChange.tool,
        resumeLine: s.toolChange.resumeLine,
        heldAtLine: s.toolChange.resumeLine - 1,
      })
      expect(s.toolChange.message.split(/(?<=[.!?])\s+/).length).toBeLessThanOrEqual(2)
      fireEvent.click(screen.getByTestId('control-tc-continue'))
      await advance(20000)
    } else if ((s.machineState === 'hold' || s.job.phase === 'paused') && s.toolChange === null) {
      record.plainHolds.push({ ackedSourceLine: s.job.ackedSourceLine })
      const heldPosition = { ...getMachineController().status().machinePos! }
      await advance(1000)
      expect(getMachineController().status().machinePos).toEqual(heldPosition)
      await act(async () => { expect(await executeOperatorCycleStart(), useMachineControl.getState().consoleLines.map(l => l.text).join('\n')).toBe(true) })
    }
  }
  const end = useMachineControl.getState()
  record.phase = end.job.phase
  record.finalMachineX = end.mpos?.x
  return record
}

for (const backend of ['simulator', 'bridge'] as const) for (const route of (backend === 'bridge' ? ['staged'] : ['text', 'staged']) as ('text' | 'staged')[]) describe(`WO-2556 ${backend} ${route} stop family`, () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    memory.clear()
    useCamStore.getState().newProject()
    useMachineActions.setState({ byMachine: {}, macroArrangementByMachine: {} })
    useMachineToolTable.setState({ byMachine: {} })
    configureMachine(backend)
    useMachineControl.setState({ activeTool: null })
    const connected = connectMachine(backend, 115200)
    await vi.advanceTimersByTimeAsync(300)
    await connected
    useMachineControl.getState().clearConsole()
    act(() => { __resetEstopInterlockForTest() })
    if (backend === 'bridge') {
      bridge!.emitStatus()
      bridge!.emit({ t: 'homed', v: { axes: ['X', 'Y', 'Z'] } })
    } else {
      getMachineController().home()
      await vi.advanceTimersByTimeAsync(2000)
    }
    // WO-2037: work Z 0 sits 10 mm below the top of Z travel. T2..T4 measure
    // 2 mm longer than T1, and the simulator now applies that length to the
    // program's Z as the machine does - with work Z 0 AT the top, the program's
    // G0 Z-1 would put the spindle 1 mm above Z max and the start is refused.
    for (const [axis, mm] of [['X', 0], ['Y', 0], ['Z', expect.getState().currentTestName?.includes('four-section') ? -25 : -10]] as const) {
      expect(setWorkOffsetValue('G54', axis, mm)).toBe(true)
      await vi.advanceTimersByTimeAsync(50)
    }
    if (route === 'staged' && backend === 'simulator') {
      const ctrl = getMachineController() as unknown as { capabilities: { gcodeText: boolean }; wco: Record<string, Record<string, number>>; setWorkOffset: (wcs: string, offset: Record<string, number>) => Promise<unknown> }
      ctrl.capabilities.gcodeText = false
      ctrl.setWorkOffset = async (wcs, offset) => {
        ctrl.wco = { ...ctrl.wco, [wcs]: { ...ctrl.wco[wcs], ...offset } }
        return { ok: true, reason: null, offset: { ...ctrl.wco[wcs] } }
      }
    }
    const tools = useMachineToolTable.getState()
    tools.recordProbedZ(MACHINE_ID, 1, -42, 1)
    tools.setReference(MACHINE_ID, 1)
    tools.setProbeConfig(MACHINE_ID, { maxTravel: 50 })
  })

  afterEach(async () => {
    cleanup()
    cancelGuidedToolChange()
    const disconnected = disconnectMachine()
    await vi.advanceTimersByTimeAsync(100)
    await disconnected
    vi.useRealTimers()
  })


  // owner ruling 10-04: "if it's there it stops the machine" - an M0/M1 right after a tool change
  // is its own stop, never cleared by the tool change's Continue.
  const shapes = [
    { name: 'adjacent M0', gap: '', stop: 'M0', plain: 1 },
    { name: 'adjacent M1', gap: '', stop: 'M1', plain: 1 },
    { name: 'zero padded optional stop', gap: '', stop: 'M01', plain: 1 },
    { name: 'comments and blanks', gap: '(fit tool)\n\n(continued)', stop: 'M0', plain: 1 },
    { name: 'M5 and M9 off words', gap: 'M5\nM9\nT3', stop: 'M0', plain: 1 },
    { name: 'dwell executes', gap: 'G4 P0.1', stop: 'M0', plain: 1 },
    { name: 'motion executes', gap: 'G0 X25', stop: 'M0', plain: 1 },
    { name: 'spindle starts', gap: 'S12000 M3', stop: 'M0', plain: 1 },
    { name: 'spindle reverses', gap: 'S12000 M4', stop: 'M1', plain: 1 },
    { name: 'flood starts', gap: 'M8', stop: 'M0', plain: 1 },
    { name: 'mist starts', gap: 'M7', stop: 'M1', plain: 1 },
  ]
  it.each(shapes)('$name: exactly one tool hold and $plain independent stops', async ({ name, gap, stop, plain }) => {
    const text = ['G21 G90 G54', 'T1 M6', 'G0 X10 Z-1', 'T2 M6', gap, stop, 'G0 X35', 'M30'].join('\n')
    if (name === 'spindle reverses') useCamStore.getState().setProjectMachine({ ...useCamStore.getState().project.machine, spindleDirection: 'ccw' })
    render(createElement(ProgramPanel))
    if (route === 'text') loadMachineProgram('shape.nc', text)
    else expect(loadGcodeTextToolpathProgram('shape.nc', text, { publishListing: true }).ok).toBe(true)
    await advance(300)
    const record = await runToEnd()
    const console = useMachineControl.getState().consoleLines.map(l => l.text)
    writeEvidence(`${backend}-${route}-${name.replaceAll(' ', '-')}.json`, { program: text, record, console, wire: backend === 'bridge' ? { sent: bridge!.sent, received: bridge!.received } : undefined })
    expect(record.phase, JSON.stringify({ record, console })).toBe('complete')
    expect(record.guidedStops.map(s => s.tool)).toEqual([2])
    expect(record.plainHolds.length, console.join('\n')).toBe(plain)
    expect(record.finalMachineX).toBeCloseTo(35, 1)
    expect(console.join('\n')).not.toContain('satisfied by the tool change')
  })

  it.each([
    { name: 'spindle starts', words: 'S12000 M3' },
    { name: 'spindle reverses', words: 'S12000 M4' },
    { name: 'flood starts', words: 'M8' },
    { name: 'mist starts', words: 'M7' },
    { name: 'coolant before spindle', words: 'M8\nS12000 M3' },
  ])('$name before G55 with no M0 adds no stop', async ({ name, words }) => {
    for (const [axis, mm] of [['X', 0], ['Y', 0], ['Z', -10]] as const) {
      expect(setWorkOffsetValue('G55', axis, mm)).toBe(true)
      await advance(50)
    }
    const text = ['G21 G90 G54', 'T1', 'G0 X10 Z-1', 'M5', 'T2 M6', words, 'G55', 'G0 X35', 'M5', 'M30'].join('\n')
    render(createElement(ProgramPanel))
    if (route === 'text') loadMachineProgram('no-stop.nc', text)
    else expect(loadGcodeTextToolpathProgram('no-stop.nc', text, { publishListing: true }).ok).toBe(true)
    await advance(300)
    const record = await runToEnd()
    const console = useMachineControl.getState().consoleLines.map(l => l.text)
    writeEvidence(`fix-${backend}-${route}-${name.replaceAll(' ', '-')}.json`, { program: text, record, console, wire: backend === 'bridge' ? { sent: bridge!.sent, received: bridge!.received } : undefined })
    expect(record.phase, JSON.stringify({ record, console })).toBe('complete')
    expect(record.guidedStops.map(s => s.tool)).toEqual([2])
    expect(record.plainHolds, console.join('\n')).toHaveLength(0)
    expect(record.finalMachineX).toBeCloseTo(35, 1)
  })

  for (const stop of ['M0', 'M1']) it(`${stop} after motion and at the end each waits for Cycle Start`, async () => {
    const text = ['G21 G90 G54', 'T1', 'G0 X10 Z-1', stop, 'G0 X35', stop, 'M30'].join('\n')
    render(createElement(ProgramPanel))
    if (route === 'text') loadMachineProgram('stops.nc', text)
    else expect(loadGcodeTextToolpathProgram('stops.nc', text, { publishListing: true }).ok).toBe(true)
    await advance(300)
    const record = await runToEnd()
    expect(record.phase).toBe('complete')
    expect(record.guidedStops).toHaveLength(0)
    expect(record.plainHolds).toHaveLength(2)
  })

  it('first-line stop holds until the initial Cycle Start', async () => {
    const text = 'M0\nG21 G90 G54\nG0 X35 Z-1\nM30'
    render(createElement(ProgramPanel))
    if (route === 'text') loadMachineProgram('first.nc', text)
    else expect(loadGcodeTextToolpathProgram('first.nc', text, { publishListing: true }).ok).toBe(true)
    await advance(3000)
    expect(useMachineControl.getState().job.phase).toBe('ready')
    expect(useMachineControl.getState().mpos?.x).toBe(0)
    const record = await runToEnd()
    expect(record.phase).toBe('complete')
    expect(record.plainHolds).toHaveLength(route === 'text' ? 1 : 0)
  })
  if (route === 'text') it('run from line keeps the later M0 and the M0 after the M6 as stops of their own', async () => {
    const text = ['G21 G90 G54', 'T1', 'G0 X10 Z-1', 'G0 X15', 'M0', 'G0 X20', 'T2 M6', 'M0', 'G0 X35', 'M30'].join('\n')
    render(createElement(ProgramPanel))
    if (route === 'text') loadMachineProgram('from-line.nc', text)
    else expect(loadGcodeTextToolpathProgram('from-line.nc', text, { publishListing: true }).ok).toBe(true)
    await advance(300)
    const armed = await armProgramFromLine(4)
    expect(armed.ok, JSON.stringify(armed)).toBe(true)
    await advance(300)
    const record = await runToEnd()
    expect(record.phase).toBe('complete')
    expect(record.plainHolds).toHaveLength(2)
    expect(record.guidedStops.map(s => s.tool)).toEqual([2])
    expect(record.finalMachineX).toBeCloseTo(35, 1)
  })

  it('replays the four-section rehearsal: M0 11, M0 20, the M6 28 hold, then M0 29 stops too', async () => {
    const text = readFileSync(join(process.cwd(), '.planning/rehearsal-2026-10-04-pin-e2b9ec87e/programs/wo2256-air-two-tools.nc'), 'utf8')
    render(createElement(ProgramPanel))
    if (route === 'text') loadMachineProgram('wo2256-air-two-tools.nc', text)
    else expect(loadGcodeTextToolpathProgram('wo2256-air-two-tools.nc', text, { publishListing: true }).ok).toBe(true)
    await advance(300)
    const record = await runToEnd()
    const console = useMachineControl.getState().consoleLines.map(l => l.text)
    writeEvidence(`${backend}-${route}-four-section.json`, { program: text, record, console, wire: backend === 'bridge' ? { sent: bridge!.sent, received: bridge!.received } : undefined })
    expect(record.phase, JSON.stringify({ record, console })).toBe('complete')
    expect(record.plainHolds).toHaveLength(3)
    expect(record.guidedStops.map(s => s.heldAtLine)).toEqual([28])
    expect(record.finalMachineX).toBeCloseTo(70, 1)
    expect(console.join('\n')).not.toContain('satisfied by the tool change')
  })

  it('a stop BEFORE M6 is independent of the tool-change hold', async () => {
    const text = 'G21 G90 G54\nT1\nG0 X10 Z-1\nM0\nT2 M6\nG0 X35\nM30'
    render(createElement(ProgramPanel))
    if (route === 'text') loadMachineProgram('before-m6.nc', text)
    else expect(loadGcodeTextToolpathProgram('before-m6.nc', text, { publishListing: true }).ok).toBe(true)
    await advance(300)
    const record = await runToEnd()
    expect(record.phase).toBe('complete')
    expect(record.plainHolds).toHaveLength(1)
    expect(record.guidedStops.map(s => s.tool)).toEqual([2])
  })

  it('each setup keeps its own M0 even when offset changes run through', async () => {
    for (const [axis, mm] of [['X', 0], ['Y', 0], ['Z', -10]] as const) {
      expect(setWorkOffsetValue('G55', axis, mm)).toBe(true)
      await advance(50)
    }
    const text = 'G21 G90 G54\nT1\nG0 X10 Z-1\nM0\nG55\nG0 X20\nM0\nG0 X35\nM30'
    render(createElement(ProgramPanel))
    if (route === 'text') loadMachineProgram('setups.nc', text)
    else expect(loadGcodeTextToolpathProgram('setups.nc', text, { publishListing: true, runThroughOffsetChanges: true }).ok).toBe(true)
    await advance(300)
    const record = await runToEnd()
    expect(record.phase).toBe('complete')
    expect(record.plainHolds).toHaveLength(2)
    expect(record.guidedStops).toHaveLength(0)
    expect(record.finalMachineX).toBeCloseTo(35, 1)
  })

  it('M0 after the final M6 stops on its own even without a following move', async () => {
    const text = 'G21 G90 G54\nT1\nG0 X10 Z-1\nT2 M6\nM0\nM30'
    render(createElement(ProgramPanel))
    if (route === 'text') loadMachineProgram('final-change.nc', text)
    else expect(loadGcodeTextToolpathProgram('final-change.nc', text, { publishListing: true }).ok).toBe(true)
    await advance(300)
    const record = await runToEnd()
    expect(record.phase).toBe('complete')
    expect(record.plainHolds).toHaveLength(1)
    expect(record.guidedStops.map(s => s.tool)).toEqual([2])
    expect(useMachineControl.getState().consoleLines.map(l => l.text).join('\n')).not.toContain('satisfied by the tool change')
  })

})
