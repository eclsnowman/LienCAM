// @vitest-environment jsdom
//
// WO-3263: A PROGRAM OF G53 FEED MOVES IS DRAWN IN THE PREVIEW AND ASSESSED BY
// THE PATH CHECK.
//
// The machine seat's simulator run (finding b): a program made only of
// `G53 G1` moves read "Path check: CANNOT ASSESS - this program commands no
// motion this check can model", and the Control preview said "Path preview
// appears when a program is loaded" while one was loaded.
//
// Proven through the application's own entry points (rule 6): the session's
// file Load (`loadGcodeFile`, the door the Load button calls) on the real
// simulator, the real ProgramPreview mounted on the session's store, and the
// session's own path check after CYCLE START. Only the WebGL viewport is a
// seam, recording what ProgramPreview hands it to draw.
//
// Measured against: the simulator's own status frames. The work offset the
// preview places the G53 targets by is the one the controller reports, and the
// machine positions it reports while flying the program are the G53 targets.

import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { createElement } from 'react'
import type { MachineConfig, ToolpathMove } from '../../types'
import { createDefaultControllerDefinition } from '../../types'
import { typedMock } from '../support/typedMock'

const harness = vi.hoisted(() => ({
  instances: [] as Array<{
    renderToolpath: ReturnType<typeof vi.fn>
    setMachinePreviewCoordinateFrame: ReturnType<typeof vi.fn>
  }>,
}))

vi.mock('../../lib/viewport/CNCViewport', () => typedMock<typeof import('../../lib/viewport/CNCViewport')>({
  CNCViewport: class {
    setMachinePreviewCoordinateFrame = vi.fn()
    renderToolpath = vi.fn()
    setToolMarkerPosition = vi.fn()
    dispose = vi.fn()
    setStockVisible = vi.fn()
    setWorkpieceVisible = vi.fn()
    setMachineVisible = vi.fn()
    showToolMarker = vi.fn()
    setActiveToolpathSegment = vi.fn()
    setToolpathDoneBoundary = vi.fn()
    fitToolpath = vi.fn()
    setOrbitFocus = vi.fn()
    worldToScreen = vi.fn((x: number, y: number) => ({ x, y }))
    constructor() { harness.instances.push(this) }
  } as unknown as typeof import('../../lib/viewport/CNCViewport').CNCViewport,
}))

// The viewport's frame loop is not under test; fake timers own the rest.
Object.defineProperty(globalThis, 'requestAnimationFrame', { value: vi.fn(() => 1), configurable: true, writable: true })
Object.defineProperty(globalThis, 'cancelAnimationFrame', { value: vi.fn(), configurable: true, writable: true })

const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const {
  __resetEstopInterlockForTest, clearPathFidelity, connectMachine, disconnectMachine,
  getMachineController, loadGcodeFile, pathFidelityReport, setPathToleranceMm,
  setWorkOffsetValue, startMachineJob,
} = await import('../../lib/machine/machineSession')
const { ProgramPreview } = await import('../../components/machine/ProgramPreview')

/** G54 as the controller will report it: machine = work + offset. */
const G54 = { x: 10, y: 5, z: -2 }
/** Only G53 feed moves, in MACHINE coordinates. */
const G53_ONLY = [
  'G21 G90 G54',
  'G53 G1 X20 Y20 Z-5 F600',
  'G53 G1 X40 Y20',
  'G53 G1 X40 Y40',
  'M30',
].join('\n')
/** G55 selected by the program, G53 feeds in MACHINE coordinates. */
const G55_G53 = [
  'G21 G90 G55',
  'G53 G1 X120 Y20 Z-5 F600',
  'G53 G1 X140 Y20',
  'M30',
].join('\n')
/** Another work system, reported by the controller but not active at Load. */
const G55 = { x: 110, y: 5, z: -2 }
/** Work moves, a G53 feed between them, and a G53 park at the end. */
const MIXED = [
  'G21 G90 G54',
  'G0 X0 Y0 Z2',
  'G1 Z-1 F600',
  'G1 X10',
  'G53 G1 Z-10',
  'G1 Y10',
  'G53 G0 Z0',
  'M30',
].join('\n')

const original = useCamStore.getState()

function selectMachine(): void {
  const machine: MachineConfig = {
    ...original.project.machine,
    id: 'wo3263-machine', name: 'WO-3263 Router', controller: 'grbl',
    controllerDefinition: createDefaultControllerDefinition(),
  }
  useCamStore.setState((s) => ({
    machineLibrary: [machine], project: { ...s.project, machine, setups: [], activeSetupId: null },
    control: { ...s.control, activeMachineId: machine.id, sessionMachine: null },
  }))
}

async function connectWithG54(): Promise<void> {
  const pending = connectMachine('simulator', 115200)
  await vi.advanceTimersByTimeAsync(500)
  await pending
  __resetEstopInterlockForTest()
  getMachineController().home()
  await vi.advanceTimersByTimeAsync(2000)
  for (const [axis, value] of [['X', G54.x], ['Y', G54.y], ['Z', G54.z]] as const) {
    expect(setWorkOffsetValue('G54', axis, value)).toBe(true)
    await vi.advanceTimersByTimeAsync(100)
  }
  expect(useMachineControl.getState().offsets.G54?.slice(0, 3)).toEqual([G54.x, G54.y, G54.z])
}

function load(name: string, text: string): void {
  const outcome = loadGcodeFile(name, text, null)
  expect(outcome.door).toBe('text')
  expect(useMachineControl.getState().programText).toBe(text)
}

async function runToEnd(): Promise<void> {
  useMachineControl.getState().clearConsole()
  expect(startMachineJob(), consoleText().join('\n')).toBe(true)
  await vi.advanceTimersByTimeAsync(20_000)
  expect(useMachineControl.getState().job.phase).toBe('complete')
}

const consoleText = (): string[] => useMachineControl.getState().consoleLines.map((line) => line.text)
const drawn = (): ToolpathMove[] => harness.instances.at(-1)?.renderToolpath.mock.calls.at(-1)?.[0] ?? []
const near = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): boolean =>
  Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) < 1e-9

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] })
  harness.instances.length = 0
  useCamStore.getState().newProject()
  useMachineControl.setState({ consoleLines: [], parserModal: null, toolChange: null })
  clearPathFidelity()
  setPathToleranceMm(null)
  selectMachine()
})

afterEach(async () => {
  cleanup()
  if (getMachineController().connectionPhase() !== 'disconnected') {
    const pending = disconnectMachine()
    await vi.advanceTimersByTimeAsync(300)
    await pending
  }
  clearPathFidelity()
  setPathToleranceMm(null)
  useCamStore.setState({ machineLibrary: original.machineLibrary, project: original.project, control: original.control })
  vi.useRealTimers()
})

describe('WO-3263 a program of G53 feed moves', () => {
  it('is drawn in the Control preview at its machine targets, placed by the reported G54', async () => {
    await connectWithG54()
    load('g53-only.nc', G53_ONLY)
    const view = render(createElement(ProgramPreview))
    await act(async () => { await vi.advanceTimersByTimeAsync(50) })

    // No "Path preview appears when a program is loaded" while one is.
    expect(view.container.querySelector('.control-preview-empty')).toBeNull()
    const moves = drawn()
    expect(moves.length).toBeGreaterThan(0)
    // Each G53 target, less the G54 the controller reports, is a drawn point.
    for (const machine of [{ x: 20, y: 20, z: -5 }, { x: 40, y: 20, z: -5 }, { x: 40, y: 40, z: -5 }]) {
      const work = { x: machine.x - G54.x, y: machine.y - G54.y, z: machine.z - G54.z }
      expect(moves.some((move) => near(move, work)), JSON.stringify({ work, moves })).toBe(true)
    }
    expect(moves.at(-1)?.type).toBe('feed')
  })

  it('is assessed by the path check after it runs on the simulator', async () => {
    await connectWithG54()
    load('g53-only.nc', G53_ONLY)
    await runToEnd()

    // The simulator flew the G53 targets in machine coordinates.
    const status = getMachineController().status()
    expect(status.machinePos).toEqual({ x: 40, y: 40, z: -5 })

    const report = pathFidelityReport()
    expect(report).not.toBeNull()
    expect(report!.headline).not.toContain('commands no motion')
    expect(report!.verdict).not.toBe('unknown')
    expect(report!.verdict).toBe('clean')
    expect(report!.samples.attributed).toBeGreaterThan(3)
    // Its G53 feed moves were measured, not counted out as unmodelled.
    expect(report!.samples.unmodelled).toBe(0)
    const measured = new Set(report!.evidence?.map((row) => row.commandedMoveId))
    for (const line of [2, 3, 4]) expect(measured.has(line)).toBe(true)
  })

  it('a mixed work + G53 program keeps its verdict on the work moves, and the G53 park stays excluded', async () => {
    await connectWithG54()
    load('mixed.nc', MIXED)
    await runToEnd()

    const report = pathFidelityReport()
    expect(report!.verdict).toBe('clean')
    const measured = new Set(report!.evidence?.map((row) => row.commandedMoveId))
    // The work moves either side of the G53 feed, and the feed itself.
    for (const line of [3, 4, 5, 6]) expect(measured.has(line)).toBe(true)
    // The G53 G0 park is still not modelled (WO-2437 park handling).
    expect(measured.has(7)).toBe(false)
  })

  it('with no work offset reported yet, the preview says why it is not drawn - never that no program is loaded', async () => {
    // Nothing connected: the controller has reported no offset to place by.
    useMachineControl.setState({ programText: G53_ONLY, offsets: {}, activeWcs: 'G54' })
    const view = render(createElement(ProgramPreview))
    await act(async () => { await vi.advanceTimersByTimeAsync(50) })
    const empty = view.container.querySelector('.control-preview-empty')
    expect(empty?.textContent).toBe(
      'This program moves in machine coordinates (G53); the preview draws it once the controller reports the work offset.',
    )
    expect(empty?.textContent).not.toContain('appears when a program is loaded')
  })

  it('with another work system active than the program selects, each G53 target is drawn at its machine position', async () => {
    await connectWithG54()
    for (const [axis, value] of [['X', G55.x], ['Y', G55.y], ['Z', G55.z]] as const) {
      expect(setWorkOffsetValue('G55', axis, value)).toBe(true)
      await vi.advanceTimersByTimeAsync(100)
    }
    load('g55-g53.nc', G55_G53)
    // The program selects G55; before CYCLE START the active frame is still G54.
    expect(useMachineControl.getState().activeWcs).toBe('G54')
    const view = render(createElement(ProgramPreview))
    await act(async () => { await vi.advanceTimersByTimeAsync(50) })
    expect(view.container.querySelector('.control-preview-empty')).toBeNull()

    // Where the viewport puts the program's work origin - the frame it draws in.
    const frame = harness.instances.at(-1)?.setMachinePreviewCoordinateFrame.mock.calls.at(-1)?.[0]
    const origin = frame?.programOriginMachine as { x: number; y: number; z: number }
    expect(origin).toEqual(G54)
    const drawnMachine = drawn().map((move) => ({ x: origin.x + move.x, y: origin.y + move.y, z: origin.z + move.z }))
    for (const machine of [{ x: 120, y: 20, z: -5 }, { x: 140, y: 20, z: -5 }]) {
      expect(drawnMachine.some((point) => near(point, machine)), JSON.stringify({ machine, drawnMachine })).toBe(true)
    }
  })
})
