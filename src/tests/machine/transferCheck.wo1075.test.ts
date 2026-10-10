// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { createDefaultControllerDefinition, type MachineConfig } from '../../types'
import { makeMachine } from '../post/helpers'
import { typedMock } from '../support/typedMock'
import {
  checkJobAgainstMachine,
  type TransferCheckJob,
} from '../../lib/machine/transferCheck'
import {
  computeMotionDigest,
  PROGRAM_CONTEXT_SCHEMA,
  PROGRAM_CONTEXT_VERSION,
  transferCheckJobFromProgram,
  type ProgramContextV1,
} from '../../lib/machine/programContext'
import { fingerprintProgram, type SurfaceMeshMap } from '../../lib/machine/zSurfaceMesh'
import {
  boundsOfPoints,
  deriveAxisEnvelopeFromHome,
  deriveMachineEnvelopeFromConvention,
  fitProgramToEnvelope,
  type Bounds3,
  type MachineEnvelope,
} from '../../lib/machine/machineEnvelope'
import { axisSoftLimitStatementKey } from '../../lib/machine/resolvedMachineMotion'

vi.mock('../../components/machine/ProgramPreview', () => typedMock<typeof import('../../components/machine/ProgramPreview')>({
  ProgramPreview: () => createElement('div', { 'data-testid': 'program-preview-stub' }),
}))

const { controlMachine, useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const {
  __reportWorkOffsetsForTest,
  __resetEstopInterlockForTest,
  acknowledgeTransferWarnings,
  connectMachine,
  disconnectMachine,
  getMachineController,
  loadMachineProgram,
  setWorkOffsetValue,
  startMachineJob,
  transferReview,
  zeroWorkAxes,
} = await import('../../lib/machine/machineSession')
const { ProgramPanel } = await import('../../components/machine/ProgramPanel')

function machine(overrides: Partial<MachineConfig> = {}): MachineConfig {
  const controllerDefinition = createDefaultControllerDefinition()
  controllerDefinition.axes = controllerDefinition.axes.map((axis) => ({
    ...axis,
    maxVelocity: axis.axis === 'X' ? 1000 : axis.axis === 'Y' ? 900 : 500,
    softLimitMin: 0,
    softLimitMax: axis.axis === 'X' ? 100 : axis.axis === 'Y' ? 80 : 50,
  }))
  controllerDefinition.stated = controllerDefinition.axes.flatMap((axis) => (['min', 'max'] as const).map((end) => ({
    controller: 'grbl' as const,
    key: axisSoftLimitStatementKey(axis.axis, end),
  })))
  return makeMachine({
    id: 'control-machine',
    name: 'Spare',
    controller: 'grbl',
    travel: { x: 100, y: 80, z: 50 },
    homeConvention: {
      x: { homesToward: 'min', machineZeroAt: 'min' },
      y: { homesToward: 'min', machineZeroAt: 'min' },
      z: { homesToward: 'min', machineZeroAt: 'min' },
    },
    axisLimits: {
      x: { maxCutting: 1000, maxRapid: 3000 },
      y: { maxCutting: 900, maxRapid: 3000 },
      z: { maxCutting: 500, maxRapid: 1200 },
    },
    controllerDefinition,
    maxSpindleRpm: 24000,
    ...overrides,
  })
}

function simulatorEnvelopeMismatchMachine(): MachineConfig {
  const target = machine({
    travel: { x: 738, y: 80, z: 50 },
    homeConvention: {
      x: { homesToward: 'max', machineZeroAt: 'min' },
      y: { homesToward: 'min', machineZeroAt: 'min' },
      z: { homesToward: 'min', machineZeroAt: 'min' },
    },
  })
  target.controllerDefinition!.axes = target.controllerDefinition!.axes.map((axis) => axis.axis === 'X'
    ? { ...axis, softLimitMin: 0, softLimitMax: 738 }
    : axis)
  return target
}

function reportedUccncMachine(): MachineConfig {
  const target = machine({
    name: 'Reported UCCNC router',
    controller: 'uccnc',
    travel: { x: 738, y: 724.5, z: 128.9 },
    homeConvention: {
      x: { homesToward: 'max', machineZeroAt: 'min' },
      y: { homesToward: 'max', machineZeroAt: 'min' },
      z: { homesToward: 'max', machineZeroAt: 'min' },
    },
  })
  target.controllerDefinition!.axes = target.controllerDefinition!.axes.map((axis) => ({
    ...axis,
    softLimitMin: 0,
    softLimitMax: axis.axis === 'X' ? 738 : axis.axis === 'Y' ? 724.5 : 128.9,
  }))
  return target
}

function job(programText: string, controller: 'grbl' | 'uccnc' = 'grbl'): TransferCheckJob {
  return transferCheckJobFromProgram(
    programText,
    { id: 'cam-machine', name: 'LienCNC V2', controller },
  )
}

/** The extent of the job's shared move list - what the check itself fits. */
function movesBounds(prepared: TransferCheckJob): Bounds3 | null {
  return boundsOfPoints(prepared.moves.flatMap((move) => [move.from, move.to]))
}

function contextFor(programText: string, controller: 'grbl' | 'uccnc' = 'grbl'): ProgramContextV1 {
  const digest = `sha256:${'0'.repeat(64)}`
  return {
    version: PROGRAM_CONTEXT_VERSION,
    schemaName: PROGRAM_CONTEXT_SCHEMA,
    source: 'live-setup',
    project: { id: 'project', name: 'Transfer fixture' },
    setup: { id: 'setup', name: 'Top' },
    units: 'mm',
    wcs: { id: 'wcs', label: 'G54', fixtureOffset: 54, origin: { x: 0, y: 0, z: 0 } },
    stock: {
      provenance: 'authored',
      coordinateSpace: 'setup-wcs',
      id: 'stock',
      name: 'Stock',
      mode: 'authored',
      primitive: 'rectangular',
      material: '',
      position: { x: 0, y: 0, z: 0 },
      bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 20, y: 20, z: 10 } },
      fixtureOffset: 54,
      authored: {
        type: 'rectangular', width: 20, height: 20, depth: 10,
        diameter: null, length: null, offsetX: 0, offsetY: 0, offsetZTop: 0, offsetZBottom: 0,
      },
      fingerprint: digest,
    },
    targetParts: [],
    notes: '',
    operations: [],
    post: { id: controller, label: controller.toUpperCase() },
    motionDigest: computeMotionDigest(programText),
    projectFingerprint: digest,
    generatedAt: 1,
  }
}

function raisedSurfaceMesh(programText: string): SurfaceMeshMap {
  return {
    bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
    cutBounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
    pointsX: 3,
    pointsY: 3,
    fadeMm: 5,
    referenceMachineZ: 0,
    samples: Array.from({ length: 9 }, (_, index) => ({
      row: Math.floor(index / 3),
      column: index % 3,
      x: (index % 3) * 5,
      y: Math.floor(index / 3) * 5,
      machineZ: 3,
    })),
    sourceFingerprint: fingerprintProgram(programText),
    sourceName: 'mesh-overtravel.nc',
    workOffset: 'G54',
    probedAt: 1,
    active: true,
  }
}

describe('WO-1075 pure CAM -> Control transfer check', () => {
  it('refuses over-travel with the axis, program range, and soft-limit range', () => {
    const result = checkJobAgainstMachine(
      job('G21 G90\nG0 X20 Y10 Z5\nM30'),
      machine(),
      { x: 90, y: 0, z: 0 },
    )
    expect(result.refusals).toContain('X program range 90..110 mm exceeds soft limits 0..100 mm.')
  })

  it('refuses a controller-kind mismatch', () => {
    const result = checkJobAgainstMachine(job('G21 G90\nG0 X1', 'uccnc'), machine(), { x: 0, y: 0, z: 0 })
    expect(result.refusals).toEqual([
      'Controller mismatch: the job was posted for uccnc, but Spare runs grbl.',
    ])
  })

  it('warns with the measured axis feed and spindle RPM', () => {
    const result = checkJobAgainstMachine(
      job('G21 G90\nM3 S25000\nG1 X10 F1200\nM30'),
      machine(),
      { x: 0, y: 0, z: 0 },
    )
    expect(result.warnings).toEqual([
      'X feed reaches 1200 mm/min; Spare allows 1000 mm/min.',
      'Spindle speed reaches 25000 RPM; Spare allows 24000 RPM.',
    ])
  })

  it.each([
    ['G81', ''],
    ['G82', ' P500'],
    ['G83', ' Q2'],
  ])('%s checks its drilling feed against the Z-axis velocity limit', (cycle, cycleWord) => {
    const prepared = job(`G21 G90\nG0 Z10\nG98 ${cycle} X5 Y5 Z-5 R2${cycleWord} F900\nG80\nM30`)

    expect(checkJobAgainstMachine(prepared, machine(), { x: 0, y: 0, z: 0 }).warnings).toEqual([
      'Z feed reaches 900 mm/min; Spare allows 500 mm/min.',
    ])
  })

  it('G99 leaves the tool at the retract plane, so the next move measures its true feed', () => {
    // The private feed walk this order deleted left Z at the pre-cycle
    // clearance plane after a G99 return, so a pure X move afterwards was
    // measured as a diagonal and its axis feed came out too low to warn.
    const prepared = job([
      'G21 G90',
      'G0 Z10',
      'G99 G81 X5 Y5 Z-5 R2 F900',
      'G80',
      'G1 X20 Z2 F1100',
      'M30',
    ].join('\n'))

    const move = prepared.moves.at(-1)!
    expect([move.from, move.to, move.feedMmMin]).toEqual([
      { x: 5, y: 5, z: 2 }, { x: 20, y: 5, z: 2 }, 1100,
    ])
    expect(checkJobAgainstMachine(prepared, machine(), { x: 0, y: 0, z: 20 })).toEqual({
      refusals: [],
      warnings: [
        'X feed reaches 1100 mm/min; Spare allows 1000 mm/min.',
        'Z feed reaches 900 mm/min; Spare allows 500 mm/min.',
      ],
      notes: [],
    })
  })

  it('G99 drilling keeps its own over-speed warning', () => {
    const prepared = job('G21 G90\nG0 Z10\nG99 G81 X5 Y5 Z-5 R2 F900\nX15 Y5\nG80\nM30')
    expect(checkJobAgainstMachine(prepared, machine(), { x: 0, y: 0, z: 20 }).warnings).toEqual([
      'Z feed reaches 900 mm/min; Spare allows 500 mm/min.',
    ])
  })

  it('refuses a canned cycle whose R plane leaves the Control travel', () => {
    const prepared = job('G21 G90\nG0 Z10\nG98 G81 X5 Y5 Z1 R60 F100\nG80\nM30')
    const envelope: MachineEnvelope = {
      x: deriveAxisEnvelopeFromHome({ travelMm: 100, homesToward: 'min', homePositionMm: 0 }),
      y: deriveAxisEnvelopeFromHome({ travelMm: 80, homesToward: 'min', homePositionMm: 0 }),
      z: deriveAxisEnvelopeFromHome({ travelMm: 50, homesToward: 'min', homePositionMm: 0 }),
    }

    expect(checkJobAgainstMachine(prepared, machine(), { x: 0, y: 0, z: 0 }).refusals).toEqual([
      'Z program range 0..60 mm exceeds soft limits 0..50 mm.',
    ])
    // One truth, two readers: the preview's own envelope fit offends on Z too.
    expect(fitProgramToEnvelope(movesBounds(prepared), { x: 0, y: 0, z: 0 }, envelope)
      ?.offending.map((finding) => finding.axis)).toEqual(['z'])
  })

  it('still checks speed when Control does not know the current work offset yet', () => {
    const result = checkJobAgainstMachine(job('G21 G90\nG1 X10 F1200\nM30'), machine(), null)
    expect(result.refusals).toEqual([])
    // The unchecked axes are notes, not flagged checks: nothing gates on them.
    expect(result.warnings).toEqual([
      'X feed reaches 1200 mm/min; Spare allows 1000 mm/min.',
    ])
    expect(result.notes).toEqual([
      'Work zero not set on X - travel on X is unchecked until you set it.',
    ])
  })

  it('says nothing for a clean same-controller job', () => {
    expect(checkJobAgainstMachine(
      job('G21 G90\nM3 S12000\nG1 X10 Y10 Z5 F500\nM30'),
      machine(),
      { x: 0, y: 0, z: 0 },
    )).toEqual({ refusals: [], warnings: [], notes: [] })
  })

  it('refuses inch-program travel after converting the shared path to millimetres', () => {
    const prepared = job('G20 G90 G54\nG1 X40 Y30 Z1 F100\nM30')
    expect(movesBounds(prepared)).toEqual({
      min: { x: 0, y: 0, z: 0 },
      max: { x: 1016, y: 762, z: 25.4 },
    })

    const result = checkJobAgainstMachine(prepared, machine(), { x: 0, y: 0, z: 0 })
    expect(result.refusals).toEqual([
      'X program range 0..1016 mm exceeds soft limits 0..100 mm.',
      'Y program range 0..762 mm exceeds soft limits 0..80 mm.',
    ])
  })

  it('checks G53 in machine coordinates without adding the work offset', () => {
    const safe = job('G21 G90 G54\nG1 X10 Y10 Z-5 F100\nG53 G0 X5 Y5 Z49\nM30')
    expect(checkJobAgainstMachine(safe, machine(), { x: 10, y: 10, z: 40 }).refusals).toEqual([])

    const unsafe = job('G21 G90 G54\nG1 X10 Y10 Z-5 F100\nG53 G0 X5 Y5 Z60\nM30')
    expect(checkJobAgainstMachine(unsafe, machine(), { x: 10, y: 10, z: 40 }).refusals).toEqual([
      'Z program range 35..60 mm exceeds soft limits 0..50 mm.',
    ])
  })

  const planeFixtures = [
    {
      plane: 'G17',
      program: 'G21 G90\nG0 X40 Y80 Z10\nG17\nG2 X60 Y80 I10 J0 F100\nM30',
      axis: 'Y',
      range: '0..90',
    },
    {
      plane: 'G18',
      program: 'G21 G90\nG0 X40 Y10 Z50\nG18\nG2 X60 Z50 I10 K0 F100\nM30',
      axis: 'Z',
      range: '0..60',
    },
    {
      plane: 'G19',
      program: 'G21 G90\nG0 X10 Y40 Z50\nG19\nG2 Y60 Z50 J10 K0 F100\nM30',
      axis: 'Z',
      range: '0..60',
    },
  ] as const

  it.each(planeFixtures)(
    '$plane refuses when the arc bulge, not its endpoints, crosses $axis travel',
    ({ program, axis, range }) => {
      const result = checkJobAgainstMachine(job(program), machine(), { x: 0, y: 0, z: 0 })
      const limit = axis === 'Y' ? '0..80' : '0..50'
      expect(result.refusals).toContain(
        `${axis} program range ${range} mm exceeds soft limits ${limit} mm.`,
      )
    },
  )

  it.each(planeFixtures)(
    '$plane gives the shared preview fit and transfer gate the same offending axis',
    ({ program, axis }) => {
      const prepared = job(program)
      const target = machine()
      const envelope: MachineEnvelope = {
        x: deriveAxisEnvelopeFromHome({ travelMm: 100, homesToward: 'min', homePositionMm: 0 }),
        y: deriveAxisEnvelopeFromHome({ travelMm: 80, homesToward: 'min', homePositionMm: 0 }),
        z: deriveAxisEnvelopeFromHome({ travelMm: 50, homesToward: 'min', homePositionMm: 0 }),
      }
      const previewFit = fitProgramToEnvelope(movesBounds(prepared), { x: 0, y: 0, z: 0 }, envelope)
      const transfer = checkJobAgainstMachine(prepared, target, { x: 0, y: 0, z: 0 })

      expect(previewFit?.offending.map((finding) => finding.axis.toUpperCase())).toContain(axis)
      expect(transfer.refusals.some((finding) => finding.startsWith(`${axis} program range`))).toBe(true)
    },
  )
})

describe('WO-1075 load gate and acknowledgement', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    const target = machine()
    const camMachine = machine({ id: 'cam-machine', name: 'LienCNC V2' })
    useCamStore.setState((state) => ({
      project: { ...state.project, machine: camMachine },
      machineLibrary: [camMachine, target],
      control: { activeMachineId: target.id },
    }))
    useMachineControl.setState({
      activeWcs: 'G54',
      offsets: { G54: [0, 0, 0] },
      consoleLines: [],
    })
    const pending = connectMachine('simulator', 115200)
    await vi.advanceTimersByTimeAsync(350)
    await pending
    await vi.advanceTimersByTimeAsync(50)
  })

  /** WO-1042: an offset is established by the controller's RECEIPT, not by the
   *  call, so a work zero lands one microtask later and the transfer review
   *  recomputes off the refreshed state. Flush both before asserting on
   *  anything a work zero gates - the same wait the real UI does behind its
   *  in-flight disable. */
  async function settleWorkOffsets(): Promise<void> {
    await act(async () => { await vi.advanceTimersByTimeAsync(50) })
  }

  async function reconnectSimulatorWith(target: MachineConfig): Promise<void> {
    const disconnecting = disconnectMachine()
    await vi.advanceTimersByTimeAsync(100)
    await disconnecting
    useCamStore.setState((state) => ({
      machineLibrary: state.machineLibrary.map((entry) => entry.id === target.id ? target : entry),
    }))
    const connecting = connectMachine('simulator', 115200)
    await vi.advanceTimersByTimeAsync(350)
    await connecting
    await vi.advanceTimersByTimeAsync(50)
  }

  afterEach(async () => {
    cleanup()
    getMachineController().emergencyStop()
    const pending = disconnectMachine()
    await vi.advanceTimersByTimeAsync(100)
    await pending
    vi.useRealTimers()
  })

  it('WO-1182: a warning is a console line and never gates Cycle Start', async () => {
    act(() => { zeroWorkAxes(['X', 'Y', 'Z']) })
    await settleWorkOffsets()
    const text = 'G21 G90 G54\nM3 S25000\nG1 X1 F100\nM30'
    act(() => { loadMachineProgram('warning.nc', text, contextFor(text)) })

    expect(transferReview().result.warnings).toEqual([
      'Spindle speed reaches 25000 RPM; Spare allows 24000 RPM.',
    ])
    expect(transferReview().acknowledgementRequired).toBe(false)
    expect(useMachineControl.getState().programReadiness.ready).toBe(true)
    expect(useMachineControl.getState().consoleLines.some(
      (line) => line.text === 'Spindle speed reaches 25000 RPM; Spare allows 24000 RPM.',
    )).toBe(true)
    render(createElement(ProgramPanel))
    expect(screen.queryByTestId('control-transfer-summary')).toBeNull()
    expect(screen.queryByTestId('control-transfer-acknowledge')).toBeNull()
  })

  it('never offers acknowledgement for a refusal and cannot acknowledge it by API', () => {
    const text = 'G21 G90 G54\nM3 S12000\nG1 X1 F100\nM30'
    act(() => { loadMachineProgram('refusal.nc', text, contextFor(text, 'uccnc')) })

    expect(transferReview().result.refusals).toHaveLength(1)
    expect(useMachineControl.getState().programReadiness.ready).toBe(false)
    expect(acknowledgeTransferWarnings()).toBe(false)
    render(createElement(ProgramPanel))
    expect(screen.queryByTestId('control-transfer-summary')).toBeNull()
    expect(screen.queryByTestId('control-transfer-acknowledge')).toBeNull()
  })

  it('refuses context-less direct loads that exceed Control travel and speed limits', async () => {
    act(() => {
      setWorkOffsetValue('G54', 'X', 0)
      setWorkOffsetValue('G54', 'Y', 0)
      setWorkOffsetValue('G54', 'Z', 0)
    })
    await settleWorkOffsets()
    const text = 'G21 G90 G54\nM3 S40000\nG1 X900 Y700 Z400 F9000\nM30'
    act(() => { loadMachineProgram('direct-post.nc', text, null) })

    expect(transferReview().result).toEqual({
      refusals: [
        'X program range 0..900 mm exceeds soft limits 0..100 mm.',
        'Y program range 0..700 mm exceeds soft limits 0..80 mm.',
        'Z program range 0..400 mm exceeds soft limits 0..50 mm.',
      ],
      warnings: [
        'X feed reaches 6703.61 mm/min; Spare allows 1000 mm/min.',
        'Y feed reaches 5213.92 mm/min; Spare allows 900 mm/min.',
        'Z feed reaches 2979.38 mm/min; Spare allows 500 mm/min.',
        'Spindle speed reaches 40000 RPM; Spare allows 24000 RPM.',
      ],
      notes: [],
    })
    expect(transferReview().summary).toBe(
      'Job posted for an unspecified machine; Control is running Spare - 7 checks flagged',
    )
    expect(useMachineControl.getState().programReadiness).toEqual({
      ready: false,
      reason: 'X program range 0..900 mm exceeds soft limits 0..100 mm.',
    })

    expect(startMachineJob()).toBe(false)
    expect(useMachineControl.getState().consoleLines.at(-1)?.text).toBe(
      'Cycle Start: refused - X program range 0..900 mm exceeds soft limits 0..100 mm.',
    )
  })

  it('refuses an inch-posted direct load using its millimetre travel extent', async () => {
    act(() => {
      setWorkOffsetValue('G54', 'X', 0)
      setWorkOffsetValue('G54', 'Y', 0)
      setWorkOffsetValue('G54', 'Z', 0)
    })
    await settleWorkOffsets()
    const text = 'G20 G90 G54\nG1 X40 Y30 Z1 F10\nM30'
    act(() => { loadMachineProgram('inch-direct-post.nc', text, null) })

    expect(transferReview().result.refusals).toEqual([
      'X program range 0..1016 mm exceeds soft limits 0..100 mm.',
      'Y program range 0..762 mm exceeds soft limits 0..80 mm.',
    ])
    expect(useMachineControl.getState().programReadiness).toEqual({
      ready: false,
      reason: 'X program range 0..1016 mm exceeds soft limits 0..100 mm.',
    })
  })

  it('does not add a false transfer refusal for a safe G53 program-end park', async () => {
    act(() => {
      setWorkOffsetValue('G54', 'X', 10)
      setWorkOffsetValue('G54', 'Y', 10)
      setWorkOffsetValue('G54', 'Z', 40)
    })
    await settleWorkOffsets()
    const text = 'G21 G90 G54\nG1 X10 Y10 Z-5 F100\nG53 G0 X5 Y5 Z49\nM30'
    act(() => { loadMachineProgram('safe-g53-park.nc', text, contextFor(text)) })

    expect(transferReview().result).toEqual({ refusals: [], warnings: [], notes: [] })
    expect(transferReview().summary).toBeNull()
  })

  it('uses the declared envelope when the simulator settings describe the opposite sign', async () => {
    const target = simulatorEnvelopeMismatchMachine()
    await reconnectSimulatorWith(target)
    act(() => { setWorkOffsetValue('G54', 'X', 0) })
    await settleWorkOffsets()

    const text = 'G21 G90 G54\nG1 X100 F100\nM30'
    const previewFit = fitProgramToEnvelope(
      movesBounds(job(text)),
      { x: 0 },
      deriveMachineEnvelopeFromConvention(target.homeConvention!, target.travel),
    )
    act(() => { loadMachineProgram('reported-envelope.nc', text, contextFor(text)) })

    expect(previewFit).toMatchObject({ state: 'inside', offending: [] })
    expect(previewFit?.axes).toEqual([
      expect.objectContaining({ axis: 'x', programMin: 0, programMax: 100, machineMin: 0, machineMax: 738 }),
    ])
    expect(transferReview().result).toEqual({ refusals: [], warnings: [], notes: [] })
    expect(useMachineControl.getState().programReadiness).toEqual({
      ready: true,
      reason: 'Program checks passed.',
    })
  })

  it('accepts the reported UCCNC job after G54 and refuses a genuine positive-bound crossing', async () => {
    const target = reportedUccncMachine()
    await reconnectSimulatorWith(target)
    act(() => {
      setWorkOffsetValue('G54', 'X', 20)
      setWorkOffsetValue('G54', 'Y', 20)
      setWorkOffsetValue('G54', 'Z', 7)
    })
    await settleWorkOffsets()

    const valid = [
      'G21 G90 G54',
      'G0 X0 Y0 Z14',
      'G1 X63.955998 Y65.479999 Z-5.5 F100',
      'M30',
    ].join('\n')
    const prepared = job(valid, 'uccnc')
    expect(movesBounds(prepared)).toEqual({
      min: { x: 0, y: 0, z: -5.5 },
      max: { x: 63.955998, y: 65.479999, z: 14 },
    })
    act(() => { loadMachineProgram('reported-uccnc-valid.nc', valid, contextFor(valid, 'uccnc')) })

    expect(transferReview().result).toEqual({ refusals: [], warnings: [], notes: [] })
    expect(useMachineControl.getState().programReadiness).toEqual({
      ready: true,
      reason: 'Program checks passed.',
    })

    const outside = [
      'G21 G90 G54',
      'G0 X0 Y0 Z14',
      'G1 X718.1 Y65.479999 Z-5.5 F100',
      'M30',
    ].join('\n')
    act(() => { loadMachineProgram('reported-uccnc-outside.nc', outside, contextFor(outside, 'uccnc')) })
    expect(transferReview().result.refusals).toEqual([
      'X program range 20..738.1 mm exceeds soft limits 0..738 mm.',
    ])
  })

  it('still refuses declared-envelope overtravel and keeps G53 in the machine frame', async () => {
    await reconnectSimulatorWith(simulatorEnvelopeMismatchMachine())
    act(() => { setWorkOffsetValue('G54', 'X', 100) })
    await settleWorkOffsets()

    const workOvertravel = 'G21 G90 G54\nG1 X639 F100\nM30'
    act(() => { loadMachineProgram('work-overtravel.nc', workOvertravel, contextFor(workOvertravel)) })
    expect(transferReview().result.refusals).toEqual([
      'X program range 100..739 mm exceeds soft limits 0..738 mm.',
    ])

    const safeMachineMove = 'G21 G90 G54\nG1 X600 F100\nG53 G0 X738\nM30'
    act(() => { loadMachineProgram('safe-machine-move.nc', safeMachineMove, contextFor(safeMachineMove)) })
    expect(transferReview().result.refusals).toEqual([])

    const unsafeMachineMove = 'G21 G90 G54\nG1 X600 F100\nG53 G0 X739\nM30'
    act(() => { loadMachineProgram('unsafe-machine-move.nc', unsafeMachineMove, contextFor(unsafeMachineMove)) })
    expect(transferReview().result.refusals).toEqual([
      'X program range 100..739 mm exceeds soft limits 0..738 mm.',
    ])
  })

  it('keeps bridge on UCCNC coordinates while serial GRBL follows live settings', async () => {
    await reconnectSimulatorWith(simulatorEnvelopeMismatchMachine())
    act(() => { setWorkOffsetValue('G54', 'X', 0) })
    await settleWorkOffsets()
    const text = 'G21 G90 G54\nG1 X100 F100\nM30'

    const snapshots = Object.fromEntries((['bridge', 'serial'] as const).map((connectionKind) => {
      act(() => {
        useMachineControl.setState({ connectionKind })
        loadMachineProgram(`${connectionKind}-envelope.nc`, text, contextFor(text))
      })
      return [connectionKind, {
        result: transferReview().result,
        summary: transferReview().summary,
        readiness: useMachineControl.getState().programReadiness,
      }]
    }))

    expect(snapshots.bridge).toEqual({
      result: { refusals: [], warnings: [], notes: [] },
      summary: null,
      readiness: { ready: true, reason: 'Program checks passed.' },
    })
    expect(snapshots.serial).toEqual({
      result: {
        refusals: ['X program range 0..100 mm exceeds soft limits -738..0 mm.'],
        warnings: [],
        notes: [],
      },
      summary: 'Job posted for LienCNC V2; Control is running Spare - 1 check flagged',
      readiness: {
        ready: false,
        reason: 'X program range 0..100 mm exceeds soft limits -738..0 mm.',
      },
    })
  })

  it('checks the surface-mesh-compensated program staged in Control for over-travel', async () => {
    act(() => {
      setWorkOffsetValue('G54', 'X', 0)
      setWorkOffsetValue('G54', 'Y', 0)
      setWorkOffsetValue('G54', 'Z', 0)
    })
    await settleWorkOffsets()
    const text = 'G21 G90 G54\nG1 X0 Y0 Z48 F100\nG1 X10 Y10 Z48\nM30'
    act(() => { loadMachineProgram('mesh-overtravel.nc', text, contextFor(text)) })
    expect(transferReview().result.refusals).toEqual([])

    act(() => {
      useMachineControl.getState().setSurfaceMesh(raisedSurfaceMesh(text))
      loadMachineProgram('mesh-overtravel.nc', text, contextFor(text))
    })

    expect(useMachineControl.getState().programText).toBe(text)
    expect(useMachineControl.getState().job.totalLines).toBeGreaterThan(text.split('\n').length)
    expect(transferReview().result.refusals).toEqual([
      'Z program range 0..51 mm exceeds soft limits 0..50 mm.',
    ])
    expect(useMachineControl.getState().programReadiness).toEqual({
      ready: false,
      reason: 'Z program range 0..51 mm exceeds soft limits 0..50 mm.',
    })
    expect(startMachineJob()).toBe(false)
  })

  it('recomputes a still-loaded refused program across disconnect and reconnect', async () => {
    act(() => { zeroWorkAxes(['X', 'Y', 'Z']) })
    await settleWorkOffsets()
    const text = 'G21 G90 G54\nM3 S40000\nG1 X900 F100\nM30'
    act(() => { loadMachineProgram('reconnect-refusal.nc', text, contextFor(text, 'uccnc')) })

    expect(transferReview().result.refusals).toEqual([
      'Controller mismatch: the job was posted for uccnc, but Spare runs grbl.',
      'X program range 5..905 mm exceeds soft limits 0..100 mm.',
    ])

    const disconnecting = disconnectMachine()
    await vi.advanceTimersByTimeAsync(100)
    await disconnecting
    const connecting = connectMachine('simulator', 115200)
    await vi.advanceTimersByTimeAsync(350)
    await connecting
    await vi.advanceTimersByTimeAsync(50)

    expect(useMachineControl.getState().programText).toBe(text)
    expect(transferReview().result).toEqual({
      refusals: [
        'Controller mismatch: the job was posted for uccnc, but Spare runs grbl.',
      ],
      warnings: [
        'Spindle speed reaches 40000 RPM; Spare allows 24000 RPM.',
      ],
      notes: [
        'Work zero not set on X - travel on X is unchecked until you set it.',
      ],
    })
    expect(useMachineControl.getState().programReadiness).toEqual({
      ready: false,
      reason: 'Controller mismatch: the job was posted for uccnc, but Spare runs grbl.',
    })

    act(() => { useMachineControl.setState({ consoleLines: [] }) })
    expect(startMachineJob()).toBe(false)
    expect(useMachineControl.getState().consoleLines.at(-1)?.text).toBe(
      'Cycle Start: refused - Controller mismatch: the job was posted for uccnc, but Spare runs grbl.',
    )

    act(() => { setWorkOffsetValue('G54', 'X', 0) })
    await settleWorkOffsets()
    expect(transferReview().result.refusals).toEqual([
      'Controller mismatch: the job was posted for uccnc, but Spare runs grbl.',
      'X program range 0..900 mm exceeds soft limits 0..100 mm.',
    ])
  })

  it('keeps a refused review when a program is loaded before connecting', async () => {
    const disconnecting = disconnectMachine()
    await vi.advanceTimersByTimeAsync(100)
    await disconnecting

    const text = 'G21 G90 G54\nG1 X1 F100\nM30'
    act(() => { loadMachineProgram('load-before-connect.nc', text, contextFor(text, 'uccnc')) })
    expect(transferReview().result.refusals).toEqual([
      'Controller mismatch: the job was posted for uccnc, but Spare runs grbl.',
    ])

    const connecting = connectMachine('simulator', 115200)
    await vi.advanceTimersByTimeAsync(350)
    await connecting
    await vi.advanceTimersByTimeAsync(50)

    expect(useMachineControl.getState().programText).toBe(text)
    expect(transferReview().result.refusals).toEqual([
      'Controller mismatch: the job was posted for uccnc, but Spare runs grbl.',
    ])
    expect(useMachineControl.getState().programReadiness).toEqual({
      ready: false,
      reason: 'Controller mismatch: the job was posted for uccnc, but Spare runs grbl.',
    })
  })

  it('makes a commanded disabled axis an unacknowledgeable Cycle Start refusal', async () => {
    const disconnecting = disconnectMachine()
    await vi.advanceTimersByTimeAsync(100)
    await disconnecting

    const disabled = machine()
    const x = disabled.controllerDefinition!.axes.find((axis) => axis.axis === 'X')!
    x.enabled = false
    useCamStore.setState((state) => ({
      machineLibrary: state.machineLibrary.map((entry) => entry.id === disabled.id ? disabled : entry),
    }))

    const connecting = connectMachine('simulator', 115200)
    await vi.advanceTimersByTimeAsync(350)
    await connecting
    await vi.advanceTimersByTimeAsync(50)

    const text = 'G21 G90\nG1 X10 F100\nM30'
    act(() => { loadMachineProgram('disabled-x.nc', text, null) })

    const refusal = 'X is commanded on line 2, but Spare defines X as disabled.'
    expect(transferReview().result.refusals).toEqual([refusal])
    expect(useMachineControl.getState().programReadiness).toEqual({ ready: false, reason: refusal })
    expect(acknowledgeTransferWarnings()).toBe(false)
    expect(startMachineJob()).toBe(false)
    expect(useMachineControl.getState().consoleLines.at(-1)?.text).toBe(
      `Cycle Start: refused - ${refusal}`,
    )
  })

  it('checks a machine without a controller definition against its Machine-page travel', async () => {
    const disconnecting = disconnectMachine()
    await vi.advanceTimersByTimeAsync(100)
    await disconnecting

    const undefinedMachine = machine({ controllerDefinition: undefined })
    useCamStore.setState((state) => ({
      machineLibrary: state.machineLibrary.map((entry) => entry.id === undefinedMachine.id ? undefinedMachine : entry),
    }))

    const connecting = connectMachine('simulator', 115200)
    await vi.advanceTimersByTimeAsync(350)
    await connecting
    await vi.advanceTimersByTimeAsync(50)
    // This case isolates transfer-envelope behavior after an operator CLEAR.
    __resetEstopInterlockForTest()
    expect(getMachineController().home()).toBe(true)
    await vi.advanceTimersByTimeAsync(2_000)
    act(() => { setWorkOffsetValue('G54', 'X', 0) })
    await settleWorkOffsets()

    const text = 'G21 G90 G54\nG1 X10 F100\nM30'
    act(() => { loadMachineProgram('undefined-machine.nc', text, null) })

    expect(transferReview().result).toEqual({ refusals: [], warnings: [], notes: [] })
    expect(useMachineControl.getState().programReadiness).toEqual({ ready: true, reason: 'Program checks passed.' })
    expect(acknowledgeTransferWarnings()).toBe(false)
    expect(startMachineJob()).toBe(true)

    const outside = 'G21 G90 G54\nG1 X100.1 F100\nM30'
    act(() => { loadMachineProgram('undefined-machine-outside.nc', outside, null) })
    expect(transferReview().result.refusals).toEqual([
      'X program range 0..100.1 mm exceeds soft limits 0..100 mm.',
    ])
    expect(startMachineJob()).toBe(false)
  })

  it('refuses travel when both controller and Machine-page envelopes are unavailable', async () => {
    const disconnecting = disconnectMachine()
    await vi.advanceTimersByTimeAsync(100)
    await disconnecting

    const undefinedMachine = machine({ controllerDefinition: undefined, homeConvention: undefined })
    useCamStore.setState((state) => ({
      machineLibrary: state.machineLibrary.map((entry) => entry.id === undefinedMachine.id ? undefinedMachine : entry),
    }))

    const connecting = connectMachine('simulator', 115200)
    await vi.advanceTimersByTimeAsync(350)
    await connecting
    await vi.advanceTimersByTimeAsync(50)

    const text = 'G21 G90\nM3 S25000\nG1 X10 F100\nM30'
    act(() => { loadMachineProgram('undefined-machine-warning.nc', text, null) })

    const refusal = 'X is commanded on line 3, but Spare has no controller definition or resolved X Machine-page travel envelope.'
    expect(transferReview().result.refusals).toEqual([refusal])
    expect(transferReview().result.notes).toEqual([])
    expect(transferReview().result.warnings).toEqual([
      'Spindle speed reaches 25000 RPM; Spare allows 24000 RPM.',
    ])
    expect(useMachineControl.getState().programReadiness.ready).toBe(false)
    expect(acknowledgeTransferWarnings()).toBe(false)
    expect(useMachineControl.getState().programReadiness).toEqual({ ready: false, reason: refusal })
  })

  it('reports unchecked travel as a note - never flagged, never gating, always shown', () => {
    const text = 'G21 G90 G54\nG1 X10 Y10 Z5 F100\nM30'
    act(() => { loadMachineProgram('fresh-offset.nc', text, contextFor(text)) })

    // An unestablished offset is not a finding about the job: there is nothing
    // for the operator to accept, so it is not counted and does not gate.
    expect(transferReview().result).toEqual({
      refusals: [],
      warnings: [],
      notes: [
        'Work zero not set on X - travel on X is unchecked until you set it.',
        'Work zero not set on Y - travel on Y is unchecked until you set it.',
        'Work zero not set on Z - travel on Z is unchecked until you set it.',
      ],
    })
    expect(transferReview().summary).toBeNull()
    expect(transferReview().acknowledgementRequired).toBe(false)
    expect(useMachineControl.getState().programReadiness).toEqual({
      ready: true,
      reason: 'Program checks passed.',
    })

    // It is still told to the operator - in the console, and only there (WO-1182).
    render(createElement(ProgramPanel))
    expect(screen.queryByTestId('control-transfer-acknowledge')).toBeNull()
    expect(screen.queryByTestId('control-transfer-notes')).toBeNull()
    expect(useMachineControl.getState().consoleLines.map((line) => line.text)).toEqual(
      expect.arrayContaining([
        'Work zero not set on X - travel on X is unchecked until you set it.',
      ]),
    )
  })

  it('WO-1182: warnings and notes are counted in the summary but never gate Cycle Start', () => {
    const text = 'G21 G90 G54\nM3 S25000\nG1 X10 Y10 Z5 F100\nM30'
    act(() => { loadMachineProgram('flagged-and-unchecked.nc', text, contextFor(text)) })

    const { result, summary, acknowledgementRequired } = transferReview()
    expect(result.warnings).toEqual([
      'Spindle speed reaches 25000 RPM; Spare allows 24000 RPM.',
    ])
    expect(result.notes).toHaveLength(3)
    expect(summary).toBe('Job posted for LienCNC V2; Control is running Spare - 1 check flagged')
    expect(acknowledgementRequired).toBe(false)
    expect(useMachineControl.getState().programReadiness).toEqual({
      ready: true,
      reason: 'Program checks passed.',
    })
    render(createElement(ProgramPanel))
    expect(screen.queryByTestId('control-transfer-acknowledge')).toBeNull()
    expect(screen.queryByTestId('control-transfer-notes')).toBeNull()
  })

  it('needs no acknowledge once every soft-limited axis has a work zero', async () => {
    act(() => { zeroWorkAxes(['X', 'Y', 'Z']) })
    await settleWorkOffsets()
    const text = 'G21 G90 G54\nG1 X10 Y10 Z5 F100\nM30'
    act(() => { loadMachineProgram('all-zeroed.nc', text, contextFor(text)) })

    expect(transferReview().result).toEqual({ refusals: [], warnings: [], notes: [] })
    expect(transferReview().acknowledgementRequired).toBe(false)
    expect(useMachineControl.getState().programReadiness).toEqual({
      ready: true,
      reason: 'Program checks passed.',
    })
    render(createElement(ProgramPanel))
    expect(screen.queryByTestId('control-transfer-acknowledge')).toBeNull()
  })

  it('recomputes after touch-off and checks each established axis without a reload', async () => {
    const text = 'G21 G90 G54\nG1 X10 Y10 Z5 F100\nM30'
    act(() => { loadMachineProgram('touch-off.nc', text, contextFor(text)) })
    const loadedRevision = transferReview().revision

    act(() => { zeroWorkAxes(['X', 'Y']) })
    await settleWorkOffsets()

    expect(transferReview().revision).toBeGreaterThan(loadedRevision)
    expect(transferReview().result).toEqual({
      refusals: [],
      warnings: [],
      notes: [
        'Work zero not set on Z - travel on Z is unchecked until you set it.',
      ],
    })
    expect(useMachineControl.getState().programReadiness.ready).toBe(true)

    act(() => { zeroWorkAxes(['Z']) })
    await settleWorkOffsets()

    expect(transferReview().result).toEqual({ refusals: [], warnings: [], notes: [] })
    expect(useMachineControl.getState().programReadiness.ready).toBe(true)
  })

  it('accepts zero offsets reported by a bridge without a local touch-off', () => {
    const text = 'G21 G90 G54\nG1 X10 Y10 Z5 F100\nM30'
    act(() => { loadMachineProgram('bridge-offset.nc', text, contextFor(text)) })

    act(() => {
      useMachineControl.setState({ connectionKind: 'bridge' })
      // A reported zero is a set axis; this is not a local touch-off grant.
      __reportWorkOffsetsForTest({ G54: { x: 0, y: 0, z: 0 } })
    })

    expect(transferReview().result).toEqual({ refusals: [], warnings: [], notes: [] })
    expect(useMachineControl.getState().programReadiness.ready).toBe(true)
  })

  it('accepts non-zero offsets reported by a bridge without a local touch-off', () => {
    const text = 'G21 G90 G54\nG1 X10 Y10 Z5 F100\nM30'
    act(() => { loadMachineProgram('bridge-non-zero-offset.nc', text, contextFor(text)) })

    act(() => {
      useMachineControl.setState({ connectionKind: 'bridge' })
      __reportWorkOffsetsForTest({ G54: { x: 81.2275, y: 61.3225, z: 12.16 } })
    })

    expect(transferReview().result).toEqual({ refusals: [], warnings: [], notes: [] })
    expect(useMachineControl.getState().programReadiness.ready).toBe(true)
  })

  it('clears a derived over-travel refusal when touch-off moves the job inside the limits', async () => {
    act(() => { setWorkOffsetValue('G54', 'X', 90) })
    await settleWorkOffsets()
    const text = 'G21 G90 G54\nG1 X20 F100\nM30'
    act(() => { loadMachineProgram('move-inside.nc', text, contextFor(text)) })
    expect(transferReview().result.refusals).toEqual([
      'X program range 90..110 mm exceeds soft limits 0..100 mm.',
    ])
    expect(useMachineControl.getState().programReadiness.ready).toBe(false)

    act(() => { setWorkOffsetValue('G54', 'X', 50) })
    await settleWorkOffsets()

    expect(transferReview().result.refusals).toEqual([])
    expect(transferReview().result.warnings).toEqual([])
    expect(transferReview().result.notes).toEqual([])
    expect(useMachineControl.getState().programReadiness).toEqual({
      ready: true,
      reason: 'Program checks passed.',
    })
  })

  it('keeps a same-id saved Control edit pending while the connected session still owns authority', () => {
    act(() => { zeroWorkAxes(['X', 'Y', 'Z']) })
    const text = 'G21 G90 G54\nG1 X10 F100\nM30'
    act(() => { loadMachineProgram('machine-change.nc', text, contextFor(text)) })
    expect(transferReview().result.refusals).toEqual([])

    act(() => {
      useCamStore.setState((state) => ({
        machineLibrary: state.machineLibrary.map((entry) => entry.id === 'control-machine'
          ? machine({ controller: 'uccnc' })
          : entry),
      }))
    })

    // WO-1147: Save is future intent. The installed simulator/backend and all
    // transfer readers remain on the connection-start GRBL definition until a
    // confirmed Apply (controllerDefinition only) or reconnect.
    expect(transferReview().result.refusals).toEqual([])
    expect(controlMachine(useCamStore.getState()).controller).toBe('grbl')
    expect(useMachineControl.getState().programReadiness.ready).toBe(true)
  })

  it('does not churn the multi-WCS verdict when only the active WCS changes', () => {
    act(() => {
      useMachineControl.setState({
        connectionKind: 'bridge',
        activeWcs: 'G54',
      })
      // Both complete reported rows are set even where an axis equals zero.
      __reportWorkOffsetsForTest({
        G54: { x: 0, y: 0, z: 0 },
        G55: { x: 90, y: 0, z: 0 },
      })
    })
    const text = 'G21 G90\nG54\nG1 X20 F100\nG55\nG1 X20 F100\nM30'
    act(() => { loadMachineProgram('wcs-change.nc', text, contextFor(text)) })
    expect(transferReview().result.refusals).toEqual([
      'G55 X program range 110..110 mm exceeds soft limits 0..100 mm.',
    ])
    const loadedRevision = transferReview().revision
    const loadedReadiness = useMachineControl.getState().programReadiness

    act(() => { useMachineControl.setState({ activeWcs: 'G55' }) })

    expect(transferReview().revision).toBe(loadedRevision)
    expect(transferReview().result.refusals).toEqual([
      'G55 X program range 110..110 mm exceeds soft limits 0..100 mm.',
    ])
    expect(useMachineControl.getState().programReadiness).toEqual(loadedReadiness)
  })

  it('rechecks a WCS-less direct program when its controller modal frame changes', () => {
    act(() => {
      useMachineControl.setState({
        connectionKind: 'bridge',
        activeWcs: 'G54',
      })
      // Modal-frame recomputation consumes reported zeros as real offsets.
      __reportWorkOffsetsForTest({
        G54: { x: 0, y: 0, z: 0 },
        G55: { x: 90, y: 0, z: 0 },
      })
    })
    const text = 'G21 G90\nG1 X20 F100\nM30'
    act(() => { loadMachineProgram('modal-wcs-change.nc', text, contextFor(text)) })
    expect(transferReview().result.refusals).toEqual([])

    act(() => { useMachineControl.setState({ activeWcs: 'G55' }) })

    expect(transferReview().result.refusals).toEqual([
      'X program range 90..110 mm exceeds soft limits 0..100 mm.',
    ])
  })

  it('WO-1182: a warning stays a warning across a reload; readiness is never held by it', async () => {
    act(() => { zeroWorkAxes(['X', 'Y', 'Z']) })
    await settleWorkOffsets()
    const first = 'G21 G90 G54\nM3 S25000\nG1 X1 F100\nM30'
    act(() => { loadMachineProgram('first-warning.nc', first, contextFor(first)) })
    expect(acknowledgeTransferWarnings()).toBe(false)
    expect(useMachineControl.getState().programReadiness.ready).toBe(true)

    act(() => { setWorkOffsetValue('G54', 'X', 10) })
    await settleWorkOffsets()
    expect(useMachineControl.getState().programReadiness.ready).toBe(true)

    const second = 'G21 G90 G54\nM3 S25000\nG1 X2 F100\nM30'
    act(() => { loadMachineProgram('second-warning.nc', second, contextFor(second)) })
    expect(useMachineControl.getState().programReadiness.ready).toBe(true)

    act(() => {
      useCamStore.setState((state) => ({
        machineLibrary: state.machineLibrary.map((entry) => entry.id === 'control-machine'
          ? machine({ maxSpindleRpm: 30000 })
          : entry),
      }))
    })
    // WO-1147: the saved higher limit is pending reconnect, so it cannot erase
    // the connected session's warning or its already matching acknowledgement.
    expect(transferReview().result).toEqual({
      refusals: [],
      warnings: ['Spindle speed reaches 25000 RPM; Spare allows 24000 RPM.'],
      notes: [],
    })
    expect(useMachineControl.getState().programReadiness.ready).toBe(true)
  })
})
