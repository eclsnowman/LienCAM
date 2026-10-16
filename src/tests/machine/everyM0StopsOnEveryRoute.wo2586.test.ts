// @vitest-environment jsdom
//
// Production file/text doors and ProgramPanel Continue, with readbacks from
// the simulator and real UccncController over a fake geometry bridge.

import { mkdirSync, writeFileSync } from 'node:fs'
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
      this.emit({ t: 'hello', v: { protocol: 1, bridge: 'WO-2586 desk fake', readOnly: false,
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

// Real GRBL controller, fake byte bridge: M0 acknowledges only after resume.
let serial: { sent: string[]; received: string[]; x: number; held: boolean; feed: (text: string) => void } | null = null
vi.mock('../../lib/machine/webSerialTransport', async importOriginal => {
  const actual = await importOriginal<typeof import('../../lib/machine/webSerialTransport')>()
  class FakeSerial extends actual.WebSerialTransport {
    static isSupported() { return true }
    static async requestPort() { return {} as SerialPort }
    static async grantedPorts(): Promise<SerialPort[]> { return [] }
    sent: string[] = []
    received: string[] = []
    x = 0
    held = false
    pending: string[] = []
    fakeEvents: import('../../lib/machine/types').TransportEvents | null = null
    constructor() { super({} as SerialPort); serial = this }
    feed(text: string) { this.received.push(text); this.fakeEvents?.onChunk(new TextEncoder().encode(text)) }
    status() { this.feed(`<${this.held ? 'Hold:0' : 'Idle'}|MPos:${this.x},0,-1|WCO:0,0,-10>\n`) }
    async start(events: import('../../lib/machine/types').TransportEvents) {
      this.fakeEvents = events
      setTimeout(() => { this.feed("Grbl 1.1h ['$' for help]\n"); this.status() }, 1)
    }
    async write(bytes: Uint8Array) {
      const text = new TextDecoder().decode(bytes)
      this.sent.push(text)
      if (text === '?') { this.status(); return }
      if (text === '~') {
        this.held = false; this.feed('ok\n')
        const pending = this.pending.splice(0)
        for (const line of pending) {
          const x = /(?:^|\s)X(-?[\d.]+)/i.exec(line)
          if (x) this.x = Number(x[1])
          this.feed('ok\n')
        }
        this.status(); return
      }
      if (!text.endsWith('\n')) return
      if (this.held) { this.pending.push(text); return }
      if (/(?:^|\s)M0(?:\s|$)/i.test(text.trim())) { this.held = true; this.status(); return }
      const x = /(?:^|\s)X(-?[\d.]+)/i.exec(text)
      if (x) this.x = Number(x[1])
      setTimeout(() => { this.feed('ok\n'); this.status() }, 1)
    }
    async close() { this.fakeEvents?.onClose(null) }
  }
  return typedMock<typeof import('../../lib/machine/webSerialTransport')>({ ...actual, WebSerialTransport: FakeSerial })
})

const { useCamStore } = await import('../../store')
const { ProgramPanel } = await import('../../components/machine/ProgramPanel')
const { useMachineActions } = await import('../../store/machineActionsStore')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useMachineToolTable } = await import('../../store/machineToolTableStore')
const { executeOperatorCycleStart } = await import('../../lib/machine/operatorTransport')
const { createDefaultControllerDefinition, positionMacroBody } = await import('../../types')
const {
  __resetEstopInterlockForTest,
  cancelGuidedToolChange,
  connectMachine,
  continueClampPause,
  disconnectMachine,
  getMachineController,
  loadGcodeTextToolpathProgram,
  loadMachineProgram,
  setWorkOffsetValue,
  armRunFromLine,
} = await import('../../lib/machine/machineSession')

const { axisSoftLimitStatementKey } = await import('../../lib/machine/resolvedMachineMotion')
const { buildResumeAtPointPlan } = await import('../../lib/machine/runFromLine')

const MACHINE_ID = 'wo2586-simulator'
const PARK = { id: 'm6-pad', label: 'Fixed tool probe', x: 5, y: 5, z: -2 }

function configureMachine(_backend: string): void {
  const machine = useCamStore.getState().project.machine
  useCamStore.getState().setProjectMachine({
    ...machine,
    id: MACHINE_ID,
    name: 'WO-2586 simulator',
    controller: 'uccnc',
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
  const directory = join(process.cwd(), 'src/tests/evidence/WO-2586')
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
        heldAtLine: /(?:^|\s)M0?6(?:\s|$)/i.test(s.programText?.split(/\r?\n/)[s.toolChange.resumeLine - 1] ?? '') ? s.toolChange.resumeLine : s.toolChange.resumeLine - 1,
      })
      expect(s.toolChange.message.split(/(?<=[.!?])\s+/).length).toBeLessThanOrEqual(2)
      fireEvent.click(screen.getByTestId('control-tc-continue'))
      await advance(20000)
    } else if ((s.machineState === 'hold' || s.job.phase === 'paused') && s.toolChange === null) {
      record.plainHolds.push({ ackedSourceLine: s.job.ackedSourceLine })
      const heldPosition = { ...getMachineController().status().machinePos! }
      const motionFrames = () => bridge?.sent.filter(frame => ['loadMoves', 'startJob', 'jogToMachineZ', 'jogToWorkXY', 'probe'].includes(frame.m)).length
      const heldFrames = motionFrames()
      await advance(1000)
      expect(motionFrames()).toBe(heldFrames)
      expect(getMachineController().status().machinePos).toEqual(heldPosition)
      await act(async () => { expect(await executeOperatorCycleStart(), useMachineControl.getState().consoleLines.map(l => l.text).join('\n')).toBe(true) })
    }
  }
  const end = useMachineControl.getState()
  record.phase = end.job.phase
  record.finalMachineX = end.mpos?.x
  return record
}

for (const backend of ['simulator', 'bridge'] as const) for (const route of (backend === 'bridge' ? ['staged'] : ['text', 'staged']) as ('text' | 'staged')[]) describe(`WO-2586 ${backend} ${route} stop family`, () => {
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



  it('same-line M6 and M0 require the tool answer and then a separate Cycle Start', async () => {
    const text = 'G21 G90 G54\nT1\nG0 X10 Y0 Z-1\nT2 M6 M0\nG0 X35\nM30'
    render(createElement(ProgramPanel))
    if (route === 'text') loadMachineProgram('same-line.nc', text)
    else expect(loadGcodeTextToolpathProgram('same-line.nc', text, { publishListing: true }).ok).toBe(true)
    await advance(300)
    const record = await runToEnd()
    writeEvidence(`${backend}-${route}-same-line.json`, { text, record, console: useMachineControl.getState().consoleLines, wire: bridge })
    expect(record.phase).toBe('complete')
    expect(record.guidedStops.map(s => s.tool)).toEqual([2])
    expect(record.plainHolds).toHaveLength(1)
    expect(record.finalMachineX).toBeCloseTo(35, 1)
  })

  if (route === 'text') it('same-line M0 also stops separately without a guided tool change', async () => {
    useCamStore.getState().setProjectMachine({ ...useCamStore.getState().project.machine, macros: [] })
    const text = 'G21 G90 G54\nT1\nG0 X10 Y0 Z-1\nT2 M6 M0\nG0 X35\nM30'
    render(createElement(ProgramPanel))
    loadMachineProgram('manual.nc', text)
    await advance(300)
    const record = await runToEnd()
    writeEvidence('simulator-manual-same-line.json', { text, record, console: useMachineControl.getState().consoleLines })
    expect(record.phase).toBe('complete')
    expect(record.plainHolds).toHaveLength(2)
    expect(record.finalMachineX).toBeCloseTo(35, 1)
  })

  if (route === 'text') it('legacy M0 change-tool hold is answered once and does not gain a second stop', async () => {
    const text = 'G21 G90 G54\nT1\nG0 X10 Y0 Z-1\nT2\nM0 (change tool)\nG0 X35\nM30'
    render(createElement(ProgramPanel))
    loadMachineProgram('legacy-change.nc', text)
    await advance(300)
    expect(await executeOperatorCycleStart()).toBe(true)
    await advance(3000)
    expect(useMachineControl.getState().machineState).toBe('hold')
    fireEvent.click(screen.getByTestId('control-guided-toolchange'))
    await advance(20_000)
    expect(useMachineControl.getState().toolChange?.step).toBe('awaiting-swap')
    fireEvent.click(screen.getByTestId('control-tc-continue'))
    await advance(20_000)
    expect(useMachineControl.getState().toolChange?.step).toBe('ready')
    expect(await executeOperatorCycleStart(), useMachineControl.getState().consoleLines.map(l => l.text).join('\n')).toBe(true)
    await advance(3000)
    expect(useMachineControl.getState().job.phase).toBe('complete')
    expect(useMachineControl.getState().mpos?.x).toBeCloseTo(35, 1)
    writeEvidence('legacy-single-stop.json', { text, console: useMachineControl.getState().consoleLines, status: getMachineController().status() })
  })

  if (route === 'staged') it('M0 before a bound macro holds before any macro park motion', async () => {
    useCamStore.getState().setProjectMachine({ ...useCamStore.getState().project.machine, macros: [{
      id: 'clamp', name: 'Clamp pause', mCode: 2001, body: 'clampPause()',
    }, { id: 'park', name: 'Park', usedForToolChange: true, body: positionMacroBody({ x: 25, y: 0, z: -2, zFirst: true }),
    }] })
    const text = 'G21 G90 G54\nT1\nG0 X10 Y0 Z-1\nM5\nM0\nM2001\nG0 X35\nM30'
    expect(loadGcodeTextToolpathProgram('before-macro.nc', text, { publishListing: true }).ok).toBe(true)
    await advance(300)
    expect(await executeOperatorCycleStart(), useMachineControl.getState().consoleLines.map(l => l.text).join('\n')).toBe(true)
    await advance(3000)
    expect(useMachineControl.getState().job.phase).toBe('paused')
    expect(useMachineControl.getState().mpos?.x).toBeCloseTo(10, 1)
    const held = getMachineController().status().machinePos
    const motionFrames = () => bridge?.sent.filter(f => ['loadMoves', 'startJob', 'jogToMachineZ', 'jogToWorkXY'].includes(f.m))
    const frames = motionFrames()?.length
    await advance(2000)
    expect(getMachineController().status().machinePos).toEqual(held)
    expect(motionFrames()?.length).toBe(frames)
    expect(useMachineControl.getState().consoleLines.map(l => l.text).join('\n')).not.toContain('running this machine')
    expect(await executeOperatorCycleStart(), useMachineControl.getState().consoleLines.map(l => l.text).join('\n')).toBe(true)
    await advance(5000)
    expect(useMachineControl.getState().consoleLines.map(l => l.text).join('\n')).toContain('running this machine')
    expect(useMachineControl.getState().mpos?.x).toBeCloseTo(25, 1)
    // WO-2773: the clamp card's Continue is its one door.
    expect(continueClampPause(), useMachineControl.getState().consoleLines.map(l => l.text).join('\n')).toBe(true)
    await advance(5000)
    expect(useMachineControl.getState().job.phase).toBe('complete')
    expect(useMachineControl.getState().mpos?.x).toBeCloseTo(35, 1)
    writeEvidence(`${backend}-before-macro.json`, { text, held, frames, console: useMachineControl.getState().consoleLines, wire: bridge })
  })

  if (route === 'text') it.each(['M0', 'M00', 'N50 M0'])('fitted kept-stop return preserves the following %s at its source line', async stop => {
    const text = `G21 G90 G54\nT1\nG0 X10 Y0 Z-1\nT2 M6\n(comment)\n${stop}\nG0 X35\nM30`
    const planned = buildResumeAtPointPlan(text, 4, { x: 10, y: 0, z: -1 }, { toolNow: 2 })
    expect(planned.ok).toBe(true)
    if (!planned.ok) return
    expect(planned.plan.resumeAt?.toolChange?.done).toBe(true)
    loadMachineProgram('kept.nc', text)
    expect(armRunFromLine(planned.plan.startLine).ok).toBe(true)
    await advance(300)
    expect(await executeOperatorCycleStart(), useMachineControl.getState().consoleLines.map(l => l.text).join('\n')).toBe(true)
    await advance(3000)
    expect(useMachineControl.getState().machineState).toBe('hold')
    const held = getMachineController().status().machinePos
    await advance(2000)
    expect(getMachineController().status().machinePos).toEqual(held)
    expect(useMachineControl.getState().mpos?.x).toBeCloseTo(10, 1)
    expect(await executeOperatorCycleStart(), useMachineControl.getState().consoleLines.map(l => l.text).join('\n')).toBe(true)
    await advance(3000)
    expect(useMachineControl.getState().job.phase).toBe('complete')
    expect(useMachineControl.getState().mpos?.x).toBeCloseTo(35, 1)
    writeEvidence(`kept-${stop.replaceAll(' ', '-')}.json`, { text, planned, held, console: useMachineControl.getState().consoleLines })
  })
})

describe('WO-2586 real GRBL text controller over a fake byte bridge', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    memory.clear()
    useCamStore.getState().newProject()
    configureMachine('simulator')
    const definition = createDefaultControllerDefinition()
    definition.axes = definition.axes.map(axis => ({ ...axis, softLimitMin: axis.axis === 'Z' ? -100 : 0, softLimitMax: axis.axis === 'Z' ? 0 : 100 }))
    definition.stated = ['X', 'Y', 'Z'].flatMap(axis => [axisSoftLimitStatementKey(axis as 'X' | 'Y' | 'Z', 'min'), axisSoftLimitStatementKey(axis as 'X' | 'Y' | 'Z', 'max')]).map(key => ({ controller: 'grbl', key }))
    useCamStore.getState().setProjectMachine({ ...useCamStore.getState().project.machine, controller: 'grbl', controllerDefinition: definition, macros: [] })
    useMachineActions.setState({ byMachine: {}, macroArrangementByMachine: {} })
    const connected = connectMachine('serial', 115200)
    await vi.advanceTimersByTimeAsync(300)
    await connected
    __resetEstopInterlockForTest()
    getMachineController().home()
    await advance(300)
    useMachineControl.setState({ homed: true, activeTool: 1 })
  })
  afterEach(async () => {
    cleanup()
    const disconnected = disconnectMachine()
    await vi.advanceTimersByTimeAsync(100)
    await disconnected
    vi.useRealTimers()
  })
  it('M6 then same-line M0 require two Cycle Starts with zero motion frames while stopped', async () => {
    const text = 'G21 G90 G54\nT1\nG0 X10 Y0 Z-1\nT2 M6 M0\nG0 X35\nM30'
    render(createElement(ProgramPanel))
    loadMachineProgram('grbl-same-line.nc', text)
    await advance(300)
    expect(await executeOperatorCycleStart(), useMachineControl.getState().consoleLines.map(l => l.text).join('\n')).toBe(true)
    await advance(1000)
    expect(serial!.held).toBe(true)
    expect(serial!.x).toBe(10)
    const first = serial!.sent.length
    expect(await executeOperatorCycleStart(), useMachineControl.getState().consoleLines.map(l => l.text).join('\n')).toBe(true)
    await advance(1000)
    expect(serial!.held).toBe(true)
    expect(serial!.x).toBe(10)
    expect(serial!.sent.slice(first).filter(line => /G[01] .*X|~/.test(line))).toHaveLength(0)
    expect(await executeOperatorCycleStart(), useMachineControl.getState().consoleLines.map(l => l.text).join('\n')).toBe(true)
    await advance(1000)
    expect(serial!.x).toBe(35)
    expect(serial!.held).toBe(false)
    expect(serial!.sent).toContain('T2 M0\n')
    expect(serial!.sent.join('')).not.toContain('M0 M0')
    writeEvidence('grbl-same-line.json', { text, sent: serial!.sent, received: serial!.received, console: useMachineControl.getState().consoleLines })
  })
})
