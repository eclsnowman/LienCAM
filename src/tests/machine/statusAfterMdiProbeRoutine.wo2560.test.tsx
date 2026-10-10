// @vitest-environment jsdom
//
// WO-2140 - after an MDI line or a probe routine the header does not say
// "A toolpath program has no re-arm control".
//
// Rehearsal 2026-09-28 (.planning/rehearsal-2026-09-28/REPORT.md, "Would bite
// Operator" 9): on the native route the header read "Cycle complete. A toolpath
// program has no re-arm control - load the toolpath again to run it." after MDI
// moves and after probe routines. Cause: a typed MDI line is staged through the
// toolpath door (its name, no program text), so its completion was read as a
// finished toolpath; a probe routine moves by jog and probe calls, leaves the job
// as the MDI line left it, and the sentence stayed.
//
// Driven on the real session singleton talking to a real UccncController over a
// fake bridge board: the MDI line through sendMdiLine (the MDI box's call), the
// probe routine through runFeatureProbeCycle (the Probing screen's Edge), the
// file through loadGcodeFile (Open) and CYCLE START through
// executeOperatorCycleStart. The header is read off the mounted
// ControlTransportBar. The control: a loaded toolpath file that finishes still
// says the toolpath sentence - that is the one place it belongs.

import { createElement } from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  BridgeCallMessage,
  BridgeMessage,
  BridgeTransportEvents,
} from '../../lib/machine/bridgeTransport'
import type { ControllerCapabilities, MachineStatus } from '../../lib/machine/controller'
import type { MachineVec3 } from '../../lib/machine/types'
import { typedMock } from '../support/typedMock'

const mem = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    get length() { return mem.size },
    clear: () => mem.clear(),
    getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
    key: (i: number) => Array.from(mem.keys())[i] ?? null,
    removeItem: (k: string) => { mem.delete(k) },
    setItem: (k: string, v: string) => { mem.set(k, String(v)) },
  } satisfies Storage,
})

const BRIDGE_CAPABILITIES: ControllerCapabilities = {
  geometryQueue: true,
  executingMoveId: true,
  bufferSeconds: true,
  gcodeText: false,
  machineProgram: true,
  perAxisHoming: true,
  ownsSpindle: false,
  spindleCommands: false,
}

const TIP_R = 1.5
const EPS = 1e-7
/** The WO-2071 board's part (as WO-2103's board): 200 x 150, top at machine Z 30. */
function partHit(p: MachineVec3): boolean {
  const dx = Math.max(200 - p.x, 0, p.x - 400)
  const dy = Math.max(200 - p.y, 0, p.y - 350)
  return p.z > EPS && p.z < 30 + EPS && Math.hypot(dx, dy) < TIP_R - EPS
}

function lerp(a: MachineVec3, b: MachineVec3, t: number): MachineVec3 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t }
}

function firstHit(a: MachineVec3, b: MachineVec3): number | null {
  const length = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z)
  const steps = Math.max(1, Math.ceil(length / 0.05))
  for (let i = 1; i <= steps; i++) {
    if (!partHit(lerp(a, b, i / steps))) continue
    let lo = (i - 1) / steps
    let hi = i / steps
    for (let k = 0; k < 40; k++) {
      const mid = (lo + hi) / 2
      if (partHit(lerp(a, b, mid))) hi = mid
      else lo = mid
    }
    return lo
  }
  return null
}

const round4 = (v: number) => Number(v.toFixed(4))
const r4 = (p: MachineVec3): MachineVec3 => ({ x: round4(p.x), y: round4(p.y), z: round4(p.z) })

let bridgeEvents: BridgeTransportEvents | null = null
let g54: MachineVec3 = { x: 200, y: 200, z: 30 }
let machinePos: MachineVec3 = { x: 205, y: 275, z: 40 }
let motion: Array<{ state: 'run' | 'idle'; pos: MachineVec3 }> = []
let verbs: string[] = []
let reportsG55 = true

function offsets(): Record<string, MachineVec3> {
  const zero = { x: 0, y: 0, z: 0 }
  return { G54: { ...g54 }, ...(reportsG55 ? { G55: zero } : {}), G56: zero, G57: zero, G58: zero, G59: zero }
}

let loadedMoves: { id: number }[] = []
let executingMoveId: number | null = null
let boardState: 'run' | 'idle' = 'idle'
let touching = false

function boardStatus(state: 'run' | 'idle', pos: MachineVec3): MachineStatus {
  return {
    state,
    subState: null,
    machinePos: { ...pos },
    workPos: { x: round4(pos.x - g54.x), y: round4(pos.y - g54.y), z: round4(pos.z - g54.z) },
    feedMmMin: 0,
    spindleRpm: 0,
    overrides: null,
    executingMoveId,
    buffer: { moves: 0, capacitySeconds: 0.1 },
    inputs: { probe: touching },
    homed: { X: true, Y: true, Z: true },
    spindle: null,
  } as MachineStatus
}

function pushStatus(state: 'run' | 'idle'): void {
  boardState = state
  bridgeEvents?.onMessage({ t: 'status', v: boardStatus(state, machinePos) } as BridgeMessage)
}

function runTo(to: MachineVec3): void {
  const from = { ...machinePos }
  motion = [
    { state: 'run', pos: lerp(from, to, 0.5) },
    { state: 'idle', pos: { ...to } },
    { state: 'idle', pos: { ...to } },
  ]
}

vi.mock('../../lib/machine/bridgeTransport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/bridgeTransport')>()
  return typedMock<typeof import('../../lib/machine/bridgeTransport')>({
    ...actual,
    BridgeTransport: class extends actual.BridgeTransport {
      static isSupported(): boolean { return true }
      async start(events: BridgeTransportEvents): Promise<void> {
        bridgeEvents = events
        events.onMessage({
          t: 'hello',
          v: {
            protocol: 1,
            bridge: 'liencam-uccnc-bridge/0.4',
            capabilities: BRIDGE_CAPABILITIES,
            readOnly: false,
            workOffsets: { current: offsets(), profile: offsets() },
          },
        } as BridgeMessage)
      }
      send(message: BridgeCallMessage): void {
        verbs.push(message.m)
        const reply = (v: unknown) => bridgeEvents?.onMessage({ t: 'reply', seq: message.seq, ok: true, v })
        switch (message.m) {
          case 'queryStatus': {
            const frame = motion.shift()
            if (frame) machinePos = { ...frame.pos }
            pushStatus(frame?.state ?? boardState)
            reply(true)
            return
          }
          case 'jogToMachineZ': {
            const a = message.a as { z: number }
            reply(true)
            runTo({ ...machinePos, z: a.z })
            return
          }
          case 'jogToWorkXY': {
            const a = message.a as { x: number; y: number }
            reply(true)
            runTo({ x: a.x + g54.x, y: a.y + g54.y, z: machinePos.z })
            return
          }
          case 'probe': {
            const a = message.a as { axis: 'X' | 'Y' | 'Z'; targetMm: number }
            const key = a.axis.toLowerCase() as keyof MachineVec3
            const from = { ...machinePos }
            const end = { ...machinePos, [key]: a.targetMm }
            const t = firstHit(from, end)
            const stop = t !== null ? r4(lerp(from, end, t)) : end
            machinePos = { ...stop }
            motion = []
            pushStatus('idle')
            reply(t !== null ? { ok: true, at: { ...stop } } : { ok: false, at: null })
            return
          }
          // The staged-program verbs a typed line and a file take. The bridge
          // answers the load, and raises `started` for the start; the test
          // raises `completed` when the board has run it (finishJob).
          case 'loadMoves':
            loadedMoves = (message.a as { moves: { id: number }[] }).moves
            reply(true)
            return
          case 'startJob':
            reply(true)
            bridgeEvents?.onMessage({ t: 'jobEvent', v: { event: 'started', fault: null } } as BridgeMessage)
            return
          case 'selectWcs':
          case 'refreshState':
          case 'querySettings':
            reply(true)
            return
          case 'setSingleBlockMode':
            reply(null)
            return
          case 'setWorkOffset': {
            const a = message.a as { wcs: string; x?: number; y?: number; z?: number }
            if (a.wcs === 'G54') g54 = { x: a.x ?? g54.x, y: a.y ?? g54.y, z: a.z ?? g54.z }
            reply({ ok: true, reason: null, offset: a.wcs === 'G54' ? { ...g54 } : { x: 0, y: 0, z: 0 } })
            return
          }
        }
      }
      async close(): Promise<void> {
        bridgeEvents?.onClose('closed')
        bridgeEvents = null
      }
    },
  })
})

vi.mock('../../lib/viewport/CNCViewport', () => typedMock<typeof import('../../lib/viewport/CNCViewport')>({
  CNCViewport: class {
    setMachinePreviewCoordinateFrame() {} renderToolpath() {} setToolMarkerPosition() {}
    dispose() {} setStockVisible() {} setWorkpieceVisible() {} setMachineVisible() {}
    showToolMarker() {} setActiveToolpathSegment() {} fitToolpath() {} setIntendedStock() {}
  } as never,
}))

const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const session = await import('../../lib/machine/machineSession')
const { currentOperatorTransport, executeOperatorCycleStart } = await import('../../lib/machine/operatorTransport')
const { ProgramPanel } = await import('../../components/machine/ProgramPanel')
const { ControlTransportBar } = await import('../../components/machine/ControlTransportBar')
const { planFeatureProbeCycle } = await import('../../lib/machine/probeFeatureCycle')
const { deriveMachineEnvelopeFromConvention } = await import('../../lib/machine/machineEnvelope')
const { DEFAULT_ZPROBE_CONFIG, resolveProbeConfig } = await import('../../lib/machine/toolTable')

type PlanInput = Parameters<typeof planFeatureProbeCycle>[0]

const CONFIG = resolveProbeConfig(null, DEFAULT_ZPROBE_CONFIG)
const SCREEN_DEFAULTS = {
  edgeAxis: 'X',
  edgeDirection: '-',
  cornerXDirection: '-',
  cornerYDirection: '-',
  angleNominalAxis: 'X',
  angleProbeDirection: '-',
  angleAlongDirection: '+',
  angleSpacingMm: 25,
  nominalSizeXmm: 25,
  nominalSizeYmm: 25,
  tipRadiusMm: TIP_R,
} as const
const ENVELOPE = deriveMachineEnvelopeFromConvention(
  {
    x: { homesToward: 'min', machineZeroAt: 'min' },
    y: { homesToward: 'min', machineZeroAt: 'min' },
    z: { homesToward: 'min', machineZeroAt: 'min' },
  },
  { x: 738, y: 724.5, z: 128.9 },
)
const EDGE_START: MachineVec3 = { x: 205, y: 275, z: 40 }

function edgePlan() {
  const planned = planFeatureProbeCycle({
    ...SCREEN_DEFAULTS, kind: 'edge', edgeAxis: 'X', edgeDirection: '+',
    start: { ...EDGE_START }, envelope: ENVELOPE, config: CONFIG, tipRadiusMm: TIP_R,
  } as PlanInput)
  if (!planned.ok) throw new Error(planned.reason)
  return planned.plan
}

async function advance(ms: number): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

async function bridgeAt(p: MachineVec3): Promise<void> {
  const pending = session.connectMachine('bridge')
  await advance(300)
  await pending
  act(() => { session.__resetEstopInterlockForTest() })
  machinePos = { ...p }
  motion = []
  act(() => { pushStatus('idle') })
  await advance(50)
  act(() => { useMachineControl.setState({ activeWcs: 'G54', consoleLines: [] }) })
  verbs = []
}

/** The board ran the staged job to the end: the bridge's terminal push. */
async function finishJob(): Promise<void> {
  act(() => {
    bridgeEvents?.onMessage({ t: 'jobEvent', v: { event: 'completed', fault: null } } as BridgeMessage)
    pushStatus('idle')
  })
  await advance(50)
}

function header(): string {
  return screen.getByTestId('control-next-action').textContent ?? ''
}

/** Type a line into MDI where the tool already stands, and let the board run it. */
async function mdiInPlace(): Promise<void> {
  const w = { x: round4(machinePos.x - g54.x), y: round4(machinePos.y - g54.y), z: round4(machinePos.z - g54.z) }
  let ok = false
  act(() => { ok = session.sendMdiLine(`G0 X${w.x} Y${w.y} Z${w.z}`) })
  expect(ok, 'the MDI line did not stage and start').toBe(true)
  await advance(50)
  expect(verbs).toContain('loadMoves')
  expect(verbs).toContain('startJob')
  await finishJob()
}

afterEach(async () => {
  cleanup()
  if (session.getMachineController().connectionPhase() !== 'disconnected') {
    const pending = session.disconnectMachine()
    await vi.advanceTimersByTimeAsync(300)
    await pending
  }
  act(() => { useMachineControl.getState().setProgram(null, null, [], null) })
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('WO-2560 non-program action readouts on the real native controller route', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    verbs = []; motion = []; touching = false; executingMoveId = null; loadedMoves = []; boardState = 'idle'
    reportsG55 = true
    g54 = { x: 200, y: 200, z: 30 }; machinePos = { ...EDGE_START }
    mem.clear(); useCamStore.getState().newProject()
    useCamStore.setState((state) => ({ project: { ...state.project, machine: { ...state.project.machine, controller: 'uccnc' } } }))
    useCamStore.setState({ machineWorkOffsets: {} })
    useMachineControl.setState({ consoleLines: [], parserModal: null, offsets: {} })
  })
  function mount() { render(createElement('div', null, createElement(ControlTransportBar), createElement(ProgramPanel))) }
  function noProgram() {
    expect.soft(header()).not.toMatch(/Cycle complete|Load a checked program|re-arm|toolpath program/i)
    for (const id of ['control-program-name', 'control-program-context', 'control-progress-text', 'program-preview-intended-stock']) {
      expect.soft(screen.queryByTestId(id), id).toBeNull()
    }
    expect.soft(currentOperatorTransport().cycleStartEnabled).toBe(false)
  }
  it('shows a completed G53 move as a move with no program header or progress', async () => {
    await bridgeAt(EDGE_START); mount()
    act(() => { expect(session.sendMdiLine('G53 G0 X300 Y300')).toBe(true) })
    await advance(50); await finishJob()
    noProgram(); expect(header()).toBe('Move finished. Ready.')
  })
  it('reports an already-touching probe without reviving the previous move', async () => {
    await bridgeAt(EDGE_START); mount(); await mdiInPlace()
    touching = true; act(() => pushStatus('idle'))
    let result: Awaited<ReturnType<typeof session.runZProbeCycle>> | null = null
    await act(async () => { result = await session.runZProbeCycle('workZero', CONFIG) })
    expect(result).toMatchObject({ ok: false })
    expect(result!.message).toMatch(/already touching/)
    noProgram(); expect(header()).toMatch(/did not start.*already touching/i)
    expect(verbs).not.toContain('probe')
  })
  it('reports the finished Edge routine after MDI without a program header', async () => {
    await bridgeAt(EDGE_START); mount(); await mdiInPlace()
    let result: Awaited<ReturnType<typeof session.runFeatureProbeCycle>> | null = null
    act(() => { void session.runFeatureProbeCycle(edgePlan(), CONFIG, true).then((r) => { result = r }) })
    for (let t = 0; t < 20_000 && result === null; t += 50) await advance(50)
    expect(result).toMatchObject({ ok: true })
    noProgram(); expect(header()).toBe('Edge probe finished. Ready.')
  })
  it('keeps a loaded file header and progress through MDI', async () => {
    await bridgeAt(EDGE_START); mount()
    act(() => { expect(session.loadGcodeFile('part.nc', 'G21 G90 G54\nG0 X0 Y0 Z10\nG1 X5 F500\nM30\n', null)).toMatchObject({ ok: true }) })
    await advance(50)
    const context = screen.getByTestId('control-program-context').textContent
    const progress = screen.getByTestId('control-progress-text').textContent
    await mdiInPlace()
    expect(screen.getByTestId('control-program-context').textContent).toBe(context)
    expect(screen.getByTestId('control-progress-text').textContent).toBe(progress)
  })
  it.each([
    { afterMdi: false, progress: 'no program' },
    { afterMdi: true, progress: '1/1 (100%)' },
  ])('keeps the main header, context, progress and stock for a file awaiting offsets (after MDI: $afterMdi)', async ({ afterMdi, progress }) => {
    reportsG55 = false
    await bridgeAt(EDGE_START); mount()
    // Go through both real load doors: a new file must retire an old MDI
    // identity even though the kept file publishes neither text nor listing.
    if (afterMdi) await mdiInPlace()
    act(() => {
      expect(session.loadGcodeFile('waiting55.nc', 'G21 G90 G55\nG0 X0 Y0 Z10\nG1 X5 F500\nM30\n', null)).toMatchObject({ ok: true })
    })
    await advance(50)
    const s = useMachineControl.getState()
    expect(s.programText).toBeNull()
    expect(s.stagedProgram).toBeNull()
    expect(s.programReadiness).toEqual({ ready: false, reason: '"waiting55.nc" waits for G55 - set G55 first.' })
    expect(session.standaloneMdiJob()).toBe(false)
    expect(screen.getByTestId('control-program-name').textContent).toBe('waiting55.nc')
    expect(screen.getByTestId('control-program-context').textContent).toBe('No setup information')
    expect(screen.getByTestId('control-progress-text').textContent).toBe(progress)
    expect(screen.getByTestId('program-preview-intended-stock')).toBeTruthy()
    expect(currentOperatorTransport().cycleStartEnabled).toBe(false)
  })
  it('names the current section at each start and M0 hold, sampling every 50ms', async () => {
    await bridgeAt(EDGE_START); mount()
    const file = ['G21 G90 G54', 'G0 X5 Y75 Z10', 'G1 X6 F500', 'M0',
      'G0 X7', 'G1 X8 F500', 'M0', 'G0 X9', 'G1 X10 F500', 'M0',
      'G0 X11', 'G1 X12 F500', 'M30', ''].join('\n')
    act(() => { expect(session.loadGcodeFile('four.nc', file, null)).toMatchObject({ ok: true }) })
    await advance(50)
    await act(async () => { expect(await executeOperatorCycleStart()).toBe(true) })
    for (let section = 1; section <= 4; section++) {
      act(() => { executingMoveId = loadedMoves[0].id; pushStatus('run') })
      await advance(50)
      const chip = () => screen.getByTestId('control-program-context').textContent ?? ''
      expect(chip()).toMatch(new RegExp(`section ${section}.*running`, 'i'))
      if (section > 1) {
        const latest = useMachineControl.getState().consoleLines.at(-1)?.text ?? ''
        expect.soft(latest).toMatch(new RegExp(`section ${section}.*started`, 'i'))
        expect.soft(latest).not.toContain('is selected and the tool is clear')
      }
      for (let tick = 0; tick < 3; tick++) {
        await advance(50)
        expect(chip()).not.toContain('is selected and the tool is clear')
        expect(chip()).toMatch(new RegExp(`section ${section}`, 'i'))
      }
      act(() => { executingMoveId = loadedMoves.at(-1)!.id })
      await finishJob()
      if (section < 4) {
        expect(useMachineControl.getState().job.phase).toBe('paused')
        expect.soft(chip()).toMatch(new RegExp(`section ${section}.*held`, 'i'))
        expect.soft(chip()).not.toContain('running')
        await act(async () => { expect(await executeOperatorCycleStart()).toBe(true) })
        await advance(50)
      } else {
        expect(useMachineControl.getState().job.phase).toBe('complete')
        expect.soft(chip()).toMatch(/section 4.*finished/i)
        expect.soft(chip()).not.toContain('running')
      }
    }
  })

})
