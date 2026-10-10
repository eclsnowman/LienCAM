// @vitest-environment jsdom
//
// MATERIAL-FIT TRACE (Operator's M20002): cutting-move bounds math, the command
// sequence contract, the homing-guarded runner end to end against the
// simulator (work coordinates honored, ends at the first corner at safe Z),
// and the ProgramPanel card + canonical fixed operator transport.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, render, screen, cleanup, fireEvent } from '@testing-library/react'

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

const { buildFitTraceSequence, computeCutBounds, defaultTraceFeed } = await import(
  '../../lib/machine/materialFit'
)
const { buildPreviewModel } = await import('../../lib/machine/previewGeometry')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useMachineActions } = await import('../../store/machineActionsStore')
const { useCamStore } = await import('../../store')
const { ProgramPanel } = await import('../../components/machine/ProgramPanel')
const { ControlTransportBar } = await import('../../components/machine/ControlTransportBar')
const {
  __resetEstopInterlockForTest,
  cancelMaterialFitTrace,
  connectMachine,
  disconnectMachine,
  getMachineController,
  loadMachineProgram,
  prepareMaterialFitTrace,
  startMaterialFitTrace,
} = await import('../../lib/machine/machineSession')

/** A square cut 10..20 with a rapid escapade to X100 Y100 that must NOT count. */
const PROGRAM = [
  'G21',
  'G90',
  'G0 X100 Y100',
  'G0 X10 Y10',
  'G1 X20 Y10 F600',
  'G1 X20 Y20',
  'G1 X10 Y20',
  'G1 X10 Y10',
].join('\n')

/** The trace applies a positive G54 XY shift and parks at negative machine Z.
 * Pin a machine whose declared travel contains that complete sequence. */
function selectFitTraceMachineFixture(): void {
  const machine = useCamStore.getState().project.machine
  useCamStore.getState().setProjectMachine({
    ...machine,
    id: 'material-fit-trace-machine',
    name: 'Material fit trace fixture',
    controller: 'grbl',
    controllerDefinition: undefined,
    unsentSettings: undefined,
    travel: { x: 200, y: 200, z: 100 },
    rapidRate: 60000,
    homeConvention: {
      x: { homesToward: 'min', machineZeroAt: 'min' },
      y: { homesToward: 'min', machineZeroAt: 'min' },
      z: { homesToward: 'max', machineZeroAt: 'max' },
    },
  })
}

/** Drive a runner promise under fake timers until it settles. */
async function finish<T>(p: Promise<T>, ms = 120000): Promise<T> {
  let out: T | undefined
  let done = false
  void p.then((v) => {
    out = v
    done = true
  })
  await vi.advanceTimersByTimeAsync(ms)
  expect(done).toBe(true)
  return out!
}

function ft() {
  return useMachineControl.getState().fitTrace
}

describe('computeCutBounds', () => {
  it('bounds only the cutting moves - rapids are excluded', () => {
    const out = computeCutBounds(buildPreviewModel(PROGRAM))
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.bounds).toEqual({ minX: 10, minY: 10, maxX: 20, maxY: 20 })
  })

  it('refuses a rapid-only program instead of tracing a lie', () => {
    const out = computeCutBounds(buildPreviewModel('G21\nG90\nG0 X50 Y50\nG0 X0 Y0'))
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason).toContain('no cutting moves')
  })

  it('arc extents count as cutting geometry', () => {
    // Half circle from X0 to X20 bulging up to Y10 (center X10 Y0, CW).
    const out = computeCutBounds(buildPreviewModel('G21\nG90\nG1 X0 Y0 F600\nG2 X20 Y0 I10 J0'))
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.bounds.maxY).toBeCloseTo(10, 1)
  })

  it('honors G91 - the WO-022 audit repro traces X10..15/Y10..15, not X0..10', () => {
    // Before the fix these incremental words were re-read as absolute, so the
    // physical fit trace missed the real right/top edges of the job.
    const repro = ['G90', 'G0 X10 Y10', 'G91', 'G1 X5 Y0 F600', 'G1 X0 Y5'].join('\n')
    const out = computeCutBounds(buildPreviewModel(repro))
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.bounds).toEqual({ minX: 10, minY: 10, maxX: 15, maxY: 15 })
  })

  it('mixed G90/G91 program bounds cover moves from both modes', () => {
    const mixed = ['G90', 'G0 X10 Y10', 'G91', 'G1 X5 Y5 F600', 'G90', 'G1 X2 Y2'].join('\n')
    const out = computeCutBounds(buildPreviewModel(mixed))
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.bounds).toEqual({ minX: 2, minY: 2, maxX: 15, maxY: 15 })
  })
})

describe('buildFitTraceSequence', () => {
  const BOUNDS = { minX: 0, minY: 0, maxX: 50, maxY: 30 }

  it('refuses without a safe Z and never guesses one', () => {
    const out = buildFitTraceSequence(BOUNDS, null, 1000)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason).toMatch(/Safe Z on the Machine tab/)
  })

  it('raises to safe Z first, then feeds the four corners with dwells, closing the loop', () => {
    const out = buildFitTraceSequence(BOUNDS, -2, 1000)
    expect(out).toEqual({
      ok: true,
      lines: [
        'G21 G90',
        'G53 G0 Z-2',
        'G1 X0 Y0 F1000',
        'G4 P0.5',
        'G1 X50 Y0',
        'G4 P0.5',
        'G1 X50 Y30',
        'G4 P0.5',
        'G1 X0 Y30',
        'G4 P0.5',
        'G1 X0 Y0',
      ],
    })
  })

  it('defaultTraceFeed is half the rapid rate clamped to a watchable band', () => {
    expect(defaultTraceFeed(3000)).toBe(1500)
    expect(defaultTraceFeed(10000)).toBe(2000)
    expect(defaultTraceFeed(100)).toBe(300)
    expect(defaultTraceFeed(null)).toBe(1500)
  })
})

describe('material-fit trace end to end (simulator)', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    useCamStore.getState().newProject()
    selectFitTraceMachineFixture()
    const pending = connectMachine('simulator', 115200)
    await vi.advanceTimersByTimeAsync(300)
    await pending
    await vi.advanceTimersByTimeAsync(50)
    // WO-328 (47b49e15/d9557456): a session starts E-STOP-latched and
    // refuses all motion until reset, per controlTabRegrid.test.tsx.
    act(() => { __resetEstopInterlockForTest() })
  })

  afterEach(async () => {
    cancelMaterialFitTrace()
    const pending = disconnectMachine()
    await vi.advanceTimersByTimeAsync(100)
    await pending
    vi.useRealTimers()
  })

  it('refuses unhomed - safe Z is a machine coordinate', () => {
    loadMachineProgram('fit.nc', PROGRAM)
    const out = prepareMaterialFitTrace(-2, 1000)
    expect(out.ok).toBe(false)
    expect(out.reason).toContain('Home')
    expect(ft()).toBeNull()
  })

  it('traces the cutting outline in WORK coordinates and ends at the first corner at safe Z', async () => {
    getMachineController().home()
    await vi.advanceTimersByTimeAsync(2000)
    // A non-zero G54 must SHIFT the traced rectangle (work frame, not machine).
    getMachineController().sendCommand('G10 L2 P1 X100 Y50 Z0')
    await vi.advanceTimersByTimeAsync(50)

    loadMachineProgram('fit.nc', PROGRAM)
    const prepared = prepareMaterialFitTrace(-2, 1000)
    expect(prepared.ok).toBe(true)
    expect(ft()?.step).toBe('confirm')
    expect(ft()?.bounds).toEqual({ minX: 10, minY: 10, maxX: 20, maxY: 20 })

    const ok = await finish(startMaterialFitTrace())
    expect(ok).toBe(true)
    expect(ft()?.step).toBe('done')
    const s = useMachineControl.getState()
    expect(s.machineState).toBe('idle')
    expect(s.mpos?.x).toBeCloseTo(110, 1) // work X10 + G54 X100
    expect(s.mpos?.y).toBeCloseTo(60, 1) // work Y10 + G54 Y50
    expect(s.mpos?.z).toBeCloseTo(-2, 1) // parked at safe Z the whole time
  })

  it('refuses a rapid-only program with a plain reason', async () => {
    getMachineController().home()
    await vi.advanceTimersByTimeAsync(2000)
    loadMachineProgram('rapids.nc', 'G21\nG90\nG0 X50 Y50')
    const out = prepareMaterialFitTrace(-2, 1000)
    expect(out.ok).toBe(false)
    expect(out.reason).toContain('no cutting moves')
  })
})

describe('ProgramPanel fit-trace card + button', () => {
  beforeEach(() => {
    useCamStore.getState().newProject()
    useMachineActions.setState({ byMachine: {} })
    useMachineControl.setState({
      connectionPhase: 'connected',
      machineState: 'idle',
      homed: true,
      fitTrace: null,
      toolChange: null,
    })
    // WO-328 (47b49e15/d9557456): a session starts E-STOP-latched, and
    // ControlTransportBar's CYCLE START button stays disabled on that alone
    // until reset, per controlTabRegrid.test.tsx.
    act(() => { __resetEstopInterlockForTest() })
  })

  afterEach(() => cleanup())

  it('button is disabled without a program, and the confirm card shows bounds + commands', () => {
    render(<><ControlTransportBar /><ProgramPanel /></>)
    const btn = screen.getByTestId('control-fittrace') as HTMLButtonElement
    expect(btn.disabled).toBe(true) // no program loaded

    act(() =>
      useMachineControl.getState().setFitTrace({
        step: 'confirm',
        message: 'The machine will raise to safe Z, then trace.',
        bounds: { minX: 10, minY: 10, maxX: 20, maxY: 20 },
        lines: ['G21 G90', 'G53 G0 Z-2', 'G1 X10 Y10 F1000'],
      }),
    )
    const card = screen.getByTestId('control-fittrace-card')
    expect(card.textContent).toContain('Material fit trace')
    expect(screen.getByTestId('control-fittrace-bounds').textContent).toContain('10.00')
    expect(card.textContent).toContain('G53 G0 Z-2')
    expect(screen.queryByTestId('control-fittrace-start')).toBeNull()
    expect(screen.getAllByRole('button', { name: 'CYCLE START' })).toHaveLength(1)
    expect((screen.getByTestId('control-cyclestart') as HTMLButtonElement).disabled).toBe(false)
    expect(screen.getByTestId('control-next-action').textContent).toMatch(/material-fit outline/i)

    fireEvent.click(screen.getByTestId('control-fittrace-cancel'))
    expect(useMachineControl.getState().fitTrace).toBeNull()
  })

  it('tracing step hides Start and Cancel; done shows Close', () => {
    render(<><ControlTransportBar /><ProgramPanel /></>)
    act(() =>
      useMachineControl.getState().setFitTrace({
        step: 'tracing',
        message: 'Tracing the outline.',
        bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
        lines: [],
      }),
    )
    expect(screen.queryByTestId('control-fittrace-start')).toBeNull()
    expect(screen.queryByTestId('control-fittrace-cancel')).toBeNull()
    expect((screen.getByTestId('control-cyclestart') as HTMLButtonElement).disabled).toBe(true)
    act(() =>
      useMachineControl.getState().setFitTrace({
        step: 'done',
        message: 'Outline traced.',
        bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
        lines: [],
      }),
    )
    expect(screen.getByTestId('control-fittrace-cancel').textContent).toContain('Close')
  })
})
