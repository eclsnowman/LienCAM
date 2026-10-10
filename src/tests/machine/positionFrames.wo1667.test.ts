// @vitest-environment jsdom
//
// WO-1667: EVERY POSITION IN A ROW NAMES ITS COORDINATE SYSTEM.
//
// Operator, 2026-09-17 at the machine: "When you're describing dimensions, I need
// you to tell me what coordinate system you're describing them in." The
// `G28 Z18` row said "ending at ... Z-110 in work coordinates" - true, and it
// was machine Z 0, the bottom of travel. On his definition (G54 Z 110) every
// row that lands the tool there now reads "G54 Z -110.00 mm (machine Z 0.00 mm)".
//
// The MDI rows are driven through `sendMdiLine` - the MDI box's own entry
// point - on the simulator with its text route turned off, which is the
// geometry route Operator's AXBB-E takes. The probe row goes through
// `runProbeRoutine`, the path-check line through `analysePathFidelity`.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDefaultControllerDefinition, type MachineConfig, type Project } from '../../types'
import { makeMachine } from '../post/helpers'
import { formatPosition, movedAxes } from '../../lib/machine/positionFrames'
import { analysePathFidelity, describePathFidelity } from '../../lib/machine/pathFidelity'
import type { JogAxis, MachineController, QueuedMove } from '../../lib/machine/controller'
import { deriveMachineEnvelopeFromConvention } from '../../lib/machine/machineEnvelope'
import { expandProbeRoutine } from '../../lib/machine/probeRoutineExpand'
import { FACTORY_BOSS_CENTRE } from '../../lib/machine/probeRoutineFactory'
import { resolveProbeConfig } from '../../lib/machine/toolTable'

const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const {
  __resetEstopInterlockForTest,
  __reportWorkOffsetsForTest,
  connectMachine,
  disconnectMachine,
  getMachineController,
  runProbeRoutine,
  sendMdiLine,
} = await import('../../lib/machine/machineSession')

/** Operator's definition: G54 work Z 0 sits 110 mm above machine Z 0. */
const SAMPLE_MACHINE_G54 = { x: 0, y: 0, z: 110 }

describe('WO-1667 the one formatter', () => {
  it("states a Z move in both frames: 'G54 Z -110 (machine Z 0)'", () => {
    expect(formatPosition({ wcs: 'G54', work: { z: -110 }, offset: SAMPLE_MACHINE_G54 })).toBe('G54 Z -110 (machine Z 0)')
    expect(formatPosition({ wcs: 'G54', machine: { z: 0 }, offset: SAMPLE_MACHINE_G54 })).toBe('G54 Z -110 (machine Z 0)')
  })

  it('groups several axes, drops the machine value only when told, and never prints -0', () => {
    expect(formatPosition({ wcs: 'G55', work: { x: 10, y: -0.00001, z: 5 }, offset: { x: 100, y: 50, z: 110 } }))
      .toBe('G55 X 10 Y 0 Z 5 (machine X 110 Y 50 Z 115)')
    expect(formatPosition({ wcs: 'G54', work: { x: 10, y: 20 }, offset: SAMPLE_MACHINE_G54, withMachine: false }))
      .toBe('G54 X 10 Y 20')
  })

  it('names the machine frame alone when no work frame is known', () => {
    expect(formatPosition({ machine: { x: 1.23456, z: 128.9 } })).toBe('machine X 1.2346 Z 128.9')
    expect(formatPosition({ wcs: 'G54', machine: { z: 5 } })).toBe('machine Z 5')
    expect(formatPosition({ machine: {} })).toBe('')
  })

  it('names only the axes a move travels along', () => {
    expect(movedAxes([{ x: 1, y: 2, z: 3 }, { x: 1, y: 2, z: -110 }])).toEqual(['z'])
    expect(movedAxes([{ x: 1, y: 2, z: 3 }])).toEqual(['x', 'y', 'z'])
  })
})

// ---------------------------------------------------------------------------
// MDI rows, through the MDI box's entry point.

let originalProject: Project
let originalLibrary: MachineConfig[]
let originalControl: ReturnType<typeof useCamStore.getState>['control']

function sampleMachineLikeMachine(): MachineConfig {
  const controllerDefinition = createDefaultControllerDefinition()
  for (const [index, axis] of controllerDefinition.axes.entries()) {
    axis.softLimitMin = 0
    axis.softLimitMax = axis.axis === 'Z' ? 200 : 800
    axis.homePin = { port: 1, pin: index + 1, negate: false }
  }
  return makeMachine({
    id: 'wo-1667-machine',
    name: 'WO-1667 machine',
    controller: 'uccnc',
    travel: { x: 800, y: 800, z: 200 },
    rapidRate: 3000,
    noHomingSwitches: false,
    homeConvention: {
      x: { homesToward: 'min', machineZeroAt: 'min' },
      y: { homesToward: 'min', machineZeroAt: 'min' },
      z: { homesToward: 'min', machineZeroAt: 'min' },
    },
    controllerDefinition,
    referencePositions: { 1: { x: 0, y: 0, z: 0 } },
  })
}

function install(target: MachineConfig): void {
  const state = useCamStore.getState()
  useCamStore.setState({
    machineLibrary: [target],
    project: { ...state.project, machine: target },
    control: {
      ...state.control,
      activeMachineId: target.id,
      sessionMachine: null,
      appliedMachine: null,
      sessionActiveMachineId: undefined,
    },
  })
}

async function connectGeometrySimulator(): Promise<void> {
  const pending = connectMachine('simulator')
  await vi.advanceTimersByTimeAsync(300)
  await pending
  act(() => { __resetEstopInterlockForTest() })
  const ctrl = getMachineController()
  if (!ctrl.home()) throw new Error('simulator refused home')
  await vi.advanceTimersByTimeAsync(2_000)
  act(() => { __reportWorkOffsetsForTest({ G54: { ...SAMPLE_MACHINE_G54 } }) })
  // The geometry route: Operator's AXBB-E takes no G-code text.
  Object.defineProperty(ctrl, 'capabilities', {
    configurable: true,
    value: { ...ctrl.capabilities, gcodeText: false },
  })
}

function mdiRow(line: string): string {
  const row = useMachineControl.getState().consoleLines
    .map((entry) => entry.text)
    .filter((text) => text.startsWith(`MDI ${line}:`))
    .at(-1)
  if (row === undefined) {
    throw new Error(`no MDI row for ${line}:\n${useMachineControl.getState().consoleLines.map((e) => e.text).join('\n')}`)
  }
  return row
}

describe('WO-1667 MDI rows on the geometry route (G54 Z 110)', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    originalProject = useCamStore.getState().project
    originalLibrary = useCamStore.getState().machineLibrary
    originalControl = useCamStore.getState().control
    install(sampleMachineLikeMachine())
    useMachineControl.setState({ consoleLines: [] })
    await connectGeometrySimulator()
  })

  afterEach(async () => {
    const ctrl = getMachineController()
    Reflect.deleteProperty(ctrl, 'capabilities')
    if (ctrl.connectionPhase() !== 'disconnected') {
      const pending = disconnectMachine()
      await vi.advanceTimersByTimeAsync(300)
      await pending
    }
    useCamStore.setState({ project: originalProject, machineLibrary: originalLibrary, control: originalControl })
    useMachineControl.setState({ consoleLines: [] })
    vi.useRealTimers()
  })

  it("G53 G0 Z0 ends at 'G54 Z -110.00 mm (machine Z 0.00 mm)'", () => {
    expect(sendMdiLine('G53 G0 Z0')).toBe(true)
    const row = mdiRow('G53 G0 Z0')
    expect(row).toContain('ending at G54 Z -110.00 mm (machine Z 0.00 mm)')
    expect(row).not.toContain('in work coordinates')
  })

  it("G28 Z18 ends at 'G54 Z -110.00 mm (machine Z 0.00 mm)' - the row that hid the bottom of travel", () => {
    expect(sendMdiLine('G28 Z18')).toBe(true)
    expect(mdiRow('G28 Z18')).toContain('ending at G54 Z -110.00 mm (machine Z 0.00 mm)')
  })

  it('G30 ends at reference point 1 in both frames', () => {
    expect(sendMdiLine('G30')).toBe(true)
    expect(mdiRow('G30')).toMatch(/ending at G54 (X -?[\d.]+ mm )?(Y -?[\d.]+ mm )?Z -110\.00 mm \(machine (X 0\.00 mm )?(Y 0\.00 mm )?Z 0\.00 mm\)/)
  })

  it('an ordinary G1 feed move names its WCS and leaves the machine value out', () => {
    expect(sendMdiLine('G1 Z-100 F500')).toBe(true)
    const row = mdiRow('G1 Z-100 F500')
    expect(row).toContain('ending at G54 Z -100.00 mm,')
    expect(row).not.toContain('(machine')
  })
})

// ---------------------------------------------------------------------------
// The path check.

describe('WO-1667 path check names the frame of the positions it reports', () => {
  const moves: QueuedMove[] = [{ id: 1, kind: 'line', to: { x: 0, y: 0, z: -110 }, feedMmMin: 600 }]
  const frame = (atMs: number, workZ: number, workX = 0) => ({
    atMs,
    machinePos: { x: workX + SAMPLE_MACHINE_G54.x, y: SAMPLE_MACHINE_G54.y, z: workZ + SAMPLE_MACHINE_G54.z },
    workPos: { x: workX, y: 0, z: workZ },
    executingMoveId: 1,
  })

  it('the clean summary states the worst position in G54 and machine coordinates', () => {
    const samples = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) => frame(i * 33, -11 * i, i === 10 ? 0.01 : 0))
    const report = analysePathFidelity({
      moves,
      startPos: { x: 0, y: 0, z: 0 },
      samples,
      reportsExecutingMoveId: true,
      toleranceMm: 0.03,
      commandedFrame: 'work',
      workFrame: 'G54',
    })
    expect(report.verdict).toBe('clean')
    expect(report.headline).toContain('at G54 X 0.01 Y 0 Z -110 (machine X 0.01 Y 0 Z 0)')
  })

  it('a departure names where its peak was, in both frames', () => {
    const samples = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) => frame(i * 33, -11 * i, i >= 6 ? 2 + (i === 8 ? 1 : 0) : 0))
    const report = analysePathFidelity({
      moves,
      startPos: { x: 0, y: 0, z: 0 },
      samples,
      reportsExecutingMoveId: true,
      toleranceMm: 0.03,
      commandedFrame: 'work',
      workFrame: 'G54',
    })
    expect(report.verdict).toBe('divergence')
    expect(report.headline).toContain('at G54 X 3 Y 0 Z -88 (machine X 3 Y 0 Z 22)')
    expect(describePathFidelity(report).join('\n')).toContain('near move 1 at G54 X 3 Y 0 Z -88 (machine X 3 Y 0 Z 22)')
  })
})

// ---------------------------------------------------------------------------
// A probe cycle's target row, through `runProbeRoutine` - the run panel states
// each move's target from the event's machine target and work frame.

describe('WO-1667 a probe routine names each move target in both frames', () => {
  const envelope = deriveMachineEnvelopeFromConvention(
    {
      x: { homesToward: 'min', machineZeroAt: 'min' },
      y: { homesToward: 'min', machineZeroAt: 'min' },
      z: { homesToward: 'min', machineZeroAt: 'min' },
    },
    { x: 300, y: 300, z: 100 },
  )
  const rawConfig = {
    positioningFeed: 1200, fastFeed: 300, slowFeed: 40, retract: 2, maxTravel: 30,
    surfaceClearance: 5, overtravel: 5, crossOverLift: 10, padThickness: 10,
  }
  // WO-2065: the boss starts over its middle, at machine Z 30. Boss centre
  // (116.5, 100), 20 mm across, its top at machine Z 5, 1.5 mm tip. Safe height
  // is top + 5 = machine Z 10 (Operator's G54 Z -100); probing depth top - 5 =
  // machine Z 0, which on Operator's G54 is work Z -110.
  const start = { x: 116.5, y: 100, z: 30 }
  const BOSS_TOP_Z = 5
  let machinePos = { ...start }
  let capabilities: MachineController['capabilities'] | null = null

  beforeEach(() => {
    __resetEstopInterlockForTest()
    useMachineControl.setState({ probe: null, parserModal: null, activeWcs: 'G54', offsets: { G54: [0, 0, 110] } })
    __reportWorkOffsetsForTest({ G54: { ...SAMPLE_MACHINE_G54 } })
    machinePos = { ...start }
    const ctrl = getMachineController()
    const baseStatus = ctrl.status()
    // The typed probe call route (the AXBB shape): a descent that stops on contact is a probe call.
    capabilities = ctrl.capabilities
    Object.defineProperty(ctrl, 'capabilities', { configurable: true, value: { ...capabilities, gcodeText: false } })
    vi.spyOn(ctrl, 'connectionPhase').mockReturnValue('connected')
    vi.spyOn(ctrl, 'hasActiveJob').mockReturnValue(false)
    vi.spyOn(ctrl, 'machineState').mockReturnValue('idle')
    vi.spyOn(ctrl, 'homedThisSession').mockReturnValue(true)
    vi.spyOn(
      ctrl as MachineController & { homedAxesThisSession(): Partial<Record<JogAxis, boolean>> },
      'homedAxesThisSession',
    ).mockReturnValue({ X: true, Y: true, Z: true })
    vi.spyOn(ctrl, 'verifiedIdle').mockReturnValue(true)
    vi.spyOn(ctrl, 'refreshState').mockReturnValue(true)
    vi.spyOn(ctrl, 'queryStatus').mockReturnValue(undefined)
    vi.spyOn(ctrl, 'status').mockImplementation(() => ({
      ...baseStatus,
      state: 'idle',
      machinePos: { ...machinePos },
      workPos: { x: machinePos.x - SAMPLE_MACHINE_G54.x, y: machinePos.y - SAMPLE_MACHINE_G54.y, z: machinePos.z - SAMPLE_MACHINE_G54.z },
    }))
    vi.spyOn(ctrl, 'jogToWorkXY').mockImplementation((x, y) => {
      machinePos = { ...machinePos, x: x + SAMPLE_MACHINE_G54.x, y: y + SAMPLE_MACHINE_G54.y }
      return true
    })
    vi.spyOn(ctrl, 'jogToMachineZ').mockImplementation((z) => {
      machinePos = { ...machinePos, z }
      return true
    })
    vi.spyOn(ctrl, 'jog').mockImplementation((axis, delta) => {
      const key = axis.toLowerCase() as 'x' | 'y' | 'z'
      machinePos = { ...machinePos, [key]: machinePos[key] + delta }
      return true
    })
    const surface: Record<string, number> = { 'X+': 105, 'X-': 128, 'Y+': 88.5, 'Y-': 111.5 }
    vi.spyOn(ctrl, 'probe').mockImplementation(async (axis, target) => {
      const key = axis.toLowerCase() as 'x' | 'y' | 'z'
      if (axis === 'Z') {
        // Over the boss the probe meets its top; beside it, nothing to the target.
        if (Math.hypot(machinePos.x - 116.5, machinePos.y - 100) <= 10) {
          machinePos = { ...machinePos, z: Math.max(BOSS_TOP_Z, target) }
          return { ok: true, at: { ...machinePos } }
        }
        machinePos = { ...machinePos, z: target }
        return { ok: false, at: null }
      }
      const direction = target > machinePos[key] ? '+' : '-'
      machinePos = { ...machinePos, [key]: surface[`${axis}${direction}`] ?? target }
      return { ok: true, at: { ...machinePos } }
    })
  })
  afterEach(() => {
    vi.restoreAllMocks()
    if (capabilities) Object.defineProperty(getMachineController(), 'capabilities', { configurable: true, value: capabilities })
  })

  it("safe height reads 'G54 Z -100 (machine Z 10)' and the descent to depth 'G54 Z -110 (machine Z 0)'", async () => {
    const expanded = expandProbeRoutine(FACTORY_BOSS_CENTRE, { diameter: 20 }, {
      start, envelope, probe: resolveProbeConfig(null, rawConfig), tipRadiusMm: 1.5, activeWcs: 'G54',
    })
    if (!expanded.ok) throw new Error(expanded.errors.map((e) => e.sentence).join(' | '))
    const rows: string[] = []
    const run = await runProbeRoutine(expanded.expanded, rawConfig, true, expanded.expanded.hash, {
      envelope,
      onStep: (event) => {
        // The run panel's own sentence for this event.
        if (event.kind === 'moving') {
          rows.push(`${event.step.label}: moving to ${formatPosition({ ...event.frame, machine: event.target })}`)
        }
      },
    })
    expect(run.ok, run.message).toBe(true)
    expect(rows).toContain("riseToSafe: moving to G54 Z -100 (machine Z 10)")
    expect(rows).toContain("riseAfterLeft: moving to G54 Z -100 (machine Z 10)")
    expect(rows).toContain("descentRight: moving to G54 Z -110 (machine Z 0)")
  })
})

// ---------------------------------------------------------------------------
// The audit: no route builds its own position sentence.

describe('WO-1667 audit: every position sentence goes through the formatter', () => {
  const FILES = [
    'src/lib/machine/machineSession.ts',
    'src/lib/machine/pathFidelity.ts',
    'src/lib/machine/probeRoutineExpand.ts',
    'src/lib/machine/previewGeometry.ts',
    'src/lib/machine/machineEnvelope.ts',
    'src/components/machine/ProbingPanel.tsx',
    'src/components/machine/ProbeRoutineRunPanel.tsx',
    'src/components/machine/ProbeRoutinePreview.tsx',
    'src/components/machine/ProbeRoutineEditor.tsx',
  ]
  // An axis letter followed by an interpolated number, the shape of "X 10" or
  // "machine Z 5" built by hand. G-code wire text ("G53 G0 Z${...}") is not a
  // sentence, a probe DIRECTION ("X${'-'}") is not a position, a measured
  // DIAMETER or WIDTH is a length, and a routine EXPRESSION the editor shows as
  // written ("machine Z ${exprText(...)}") is the operator's source text.
  const POSITION = /\b[XYZ] ?\$\{(?!exprText\(|fmt(?:Dim|MachineLength)\(result\.diameter)/
  const WIRE = /`[^`]*\b[GM]\d+(\.\d+)?\b[^`]*[XYZ] ?\$\{/
  const DIRECTION = /[XYZ]\$\{(xDirection|yDirection|cornerXDirection|cornerYDirection|step\.direction|input\.[xy]\.direction)\}/g

  it('finds none outside positionFrames.ts', () => {
    const offenders: string[] = []
    for (const file of FILES) {
      const lines = readFileSync(resolve(file), 'utf-8').split(/\r?\n/)
      lines.forEach((line, index) => {
        const trimmed = line.trim()
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) return
        const scrubbed = line.replace(DIRECTION, '')
        if (POSITION.test(scrubbed) && !WIRE.test(scrubbed)) offenders.push(`${file}:${index + 1}: ${trimmed}`)
      })
    }
    expect(offenders).toEqual([])
  })
})
