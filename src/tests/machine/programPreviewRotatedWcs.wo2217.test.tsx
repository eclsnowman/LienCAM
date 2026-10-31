// @vitest-environment jsdom

// WO-2217: the Control preview draws a program run in a rotated work offset
// where the machine runs it. Operator ruling 2026-09-29: "It depends upon which viewpoint
// you're in." Machine grid -> the program is turned about its offset's origin;
// G55 grid (G55 rotated) -> the program is square to its grid and the machine
// travel box is drawn turned by -R.
//
// Through the production preview (ProgramPreview) with the real
// CNCViewport.setMachinePreviewCoordinateFrame and its real grid / travel
// border / WCS-origin builders on real THREE groups. Only rendering (WebGL) is
// stubbed; the drawn position of a path point is its world position under the
// viewport's program group, exactly as the real viewport parents it. The
// rotation is the session's reported workRotations() - the one app seam the
// controller's report arrives through.
//
// The numbers are the desk rehearsal's (.planning/rehearsal-2026-09-29-rotation,
// step 3): G55 = X400 Y400 Z60, rotated 30 deg, square-g55.nc; the machine ran
//   (400,400) (390,417.3205) G2 to (397.3205,444.641) centre (407.3205,427.3205)
//   (414.641,454.641) (434.641,420) (400,400).

import { act } from 'react'
import * as THREE from 'three'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { typedMock } from '../support/typedMock'
import type { ToolpathMove } from '../../types'

type FakeViewport = {
  programFrameGroup: THREE.Group
  gridGroup: THREE.Group
  machineTravelBorderGroup: THREE.Group
  wcsGroup: THREE.Group
  setMachinePreviewCoordinateFrame: ReturnType<typeof vi.fn>
  renderToolpath: ReturnType<typeof vi.fn>
  setToolMarkerPosition: ReturnType<typeof vi.fn>
  setActiveToolpathSegment: ReturnType<typeof vi.fn>
}

const harness = vi.hoisted(() => ({
  instances: [] as unknown[],
  rotations: {} as Record<string, number>,
  listeners: new Set<() => void>(),
}))

vi.mock('../../lib/viewport/CNCViewport', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../lib/viewport/CNCViewport')>()
  const three = await import('three')
  class PreviewViewport {
    constructor() {
      // The real class's frame/grid/border/origin code on real THREE groups;
      // WebGL, camera and scene furniture are stubs.
      const vp = Object.create(real.CNCViewport.prototype) as Record<string, unknown>
      const frameSpy = vi.fn(real.CNCViewport.prototype.setMachinePreviewCoordinateFrame)
      Object.assign(vp, {
        programFrameGroup: new three.Group(),
        gridGroup: new three.Group(),
        machineTravelBorderGroup: new three.Group(),
        wcsGroup: new three.Group(),
        gridSpacing: 25,
        machineTravelX: 800,
        machineTravelY: 600,
        machinePreviewFrame: null,
        setMachinePreviewCoordinateFrame: frameSpy,
        renderToolpath: vi.fn(),
        setToolMarkerPosition: vi.fn(),
        setActiveToolpathSegment: vi.fn(),
        setToolpathDoneBoundary: vi.fn(),
        setSimulationToolpathPreview: vi.fn(),
        setIntendedStock: vi.fn(),
        setOrbitFocus: vi.fn(),
        setStockVisible: vi.fn(),
        setWorkpieceVisible: vi.fn(),
        setMachineVisible: vi.fn(),
        showToolMarker: vi.fn(),
        fitToolpath: vi.fn(),
        fitToolpathPreservingView: vi.fn(),
        fitBoundsPreservingView: vi.fn(),
        // WO-3265's automatic fit at Load asks for this before it falls back
        // to fitToolpath; the stub keeps the real camera code (this fixture has
        // no camera) out of the render, as its fit neighbours above do.
        fitProgramPointsIso: vi.fn(() => true),
        setCameraView: vi.fn(),
        dispose: vi.fn(),
      })
      harness.instances.push(vp)
      return vp
    }
  }
  return typedMock<typeof import('../../lib/viewport/CNCViewport')>({
    ...real,
    CNCViewport: PreviewViewport as unknown as typeof real.CNCViewport,
  })
})

vi.mock('../../lib/machine/machineSession', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/machineSession')>()
  return typedMock<typeof import('../../lib/machine/machineSession')>({
    ...actual,
    workRotations: () => harness.rotations,
    subscribeWorkRotations: (listener: () => void) => {
      harness.listeners.add(listener)
      return () => harness.listeners.delete(listener)
    },
  })
})

const mem = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    get length() { return mem.size },
    clear: () => mem.clear(),
    getItem: (key: string) => mem.get(key) ?? null,
    key: (index: number) => Array.from(mem.keys())[index] ?? null,
    removeItem: (key: string) => { mem.delete(key) },
    setItem: (key: string, value: string) => { mem.set(key, String(value)) },
  } satisfies Storage,
  configurable: true,
})

const frames: FrameRequestCallback[] = []
Object.defineProperty(globalThis, 'requestAnimationFrame', {
  value: vi.fn((callback: FrameRequestCallback) => {
    frames.push(callback)
    return frames.length
  }),
  configurable: true,
})
Object.defineProperty(globalThis, 'cancelAnimationFrame', { value: vi.fn(), configurable: true })

const { ProgramPreview } = await import('../../components/machine/ProgramPreview')
const { useMachineControl } = await import('../../store/machineControlStore')

// square-g55.nc from the rehearsal (logs/square.nc), byte for byte.
const SQUARE_G55 = [
  'G21 G90 G55',
  'G0 Z20',
  'G0 X0 Y0',
  'G1 Z5 F1000',
  'G1 X0 Y20 F1500',
  'G2 X20 Y40 I20 J0',
  'G1 X40 Y40',
  'G1 X40 Y0',
  'G1 X0 Y0',
  'G0 Z20',
  'M30',
].join('\n')

// The rehearsal's recorded machine corners at G55 30 deg (step 3).
const REHEARSAL_30 = [
  { work: [0, 20], machine: [390, 417.3205] },
  { work: [20, 40], machine: [397.3205, 444.641] },
  { work: [40, 40], machine: [414.641, 454.641] },
  { work: [40, 0], machine: [434.641, 420] },
  { work: [0, 0], machine: [400, 400] },
] as const
const ARC_CENTRE_30 = [407.3205, 427.3205] as const

function setRotations(next: Record<string, number>) {
  act(() => {
    harness.rotations = Object.freeze({ ...next })
    for (const listener of [...harness.listeners]) listener()
  })
}

function viewport(): FakeViewport {
  return harness.instances.at(-1) as FakeViewport
}

/** Every drawn path point in world (scene) coordinates, as the viewport draws
 *  it: renderToolpath's work-coordinate moves under the program group. */
function drawnPoints(vp: FakeViewport) {
  const moves = vp.renderToolpath.mock.calls.at(-1)![0] as ToolpathMove[]
  vp.programFrameGroup.updateMatrixWorld(true)
  return moves.map((m) => ({
    work: m,
    world: new THREE.Vector3(m.x, m.y, m.z).applyMatrix4(vp.programFrameGroup.matrixWorld),
  }))
}

function drawnAtWork(vp: FakeViewport, x: number, y: number, z = 5) {
  const hit = drawnPoints(vp).find((p) =>
    Math.abs(p.work.x - x) < 1e-9 && Math.abs(p.work.y - y) < 1e-9 && Math.abs(p.work.z - z) < 1e-9)
  expect(hit, `a drawn point at work ${x},${y},${z}`).toBeTruthy()
  return hit!.world
}

/** The dashed travel border's four corners as drawn in the scene. */
function borderCorners(vp: FakeViewport) {
  vp.machineTravelBorderGroup.updateMatrixWorld(true)
  const line = vp.machineTravelBorderGroup.children[0] as THREE.Line
  const pos = line.geometry.getAttribute('position')
  const out: THREE.Vector3[] = []
  for (let i = 0; i < 4; i++) out.push(new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(line.matrixWorld))
  return out
}

function gridSegmentsAxisAligned(vp: FakeViewport) {
  for (const child of vp.gridGroup.children) {
    const pos = (child as THREE.LineSegments).geometry.getAttribute('position')
    for (let i = 0; i < pos.count; i += 2) {
      const dx = pos.getX(i + 1) - pos.getX(i)
      const dy = pos.getY(i + 1) - pos.getY(i)
      if (Math.abs(dx) > 1e-6 && Math.abs(dy) > 1e-6) return false
    }
  }
  return vp.gridGroup.children.length > 0
}

function setMachineState(overrides: Record<string, unknown> = {}) {
  useMachineControl.setState({
    programText: SQUARE_G55,
    connectionPhase: 'connected',
    activeWcs: 'G55',
    offsets: { G54: [81.228, 61.322, 12.16], G55: [400, 400, 60] },
    settings: { 130: '800.000', 131: '800.000' },
    homed: true,
    wpos: { x: 20, y: 20, z: 20 },
    ...overrides,
  })
}

function chooseGrid(value: string) {
  fireEvent.change(screen.getByLabelText('Preview coordinate grid'), { target: { value } })
}

beforeEach(() => {
  cleanup()
  mem.clear()
  frames.length = 0
  harness.instances.length = 0
  harness.rotations = {}
  harness.listeners.clear()
  setMachineState()
})

afterEach(cleanup)

describe('WO-2217 Control preview draws a rotated program where the machine runs it', () => {
  it('Machine grid, G55 rotated 30 deg: the drawn corners are the rehearsal machine corners; the table stays square', async () => {
    harness.rotations = { G55: 30 }
    render(<ProgramPreview />)
    const vp = viewport()
    await waitFor(() => expect(vp.renderToolpath).toHaveBeenCalled())

    for (const { work, machine } of REHEARSAL_30) {
      const drawn = drawnAtWork(vp, work[0], work[1])
      expect(Math.abs(drawn.x - machine[0]), `X at work ${work}`).toBeLessThan(0.01)
      expect(Math.abs(drawn.y - machine[1]), `Y at work ${work}`).toBeLessThan(0.01)
      // Z is never rotated: G55 Z60 + work Z5 = machine Z65 (the rehearsal's air cut).
      expect(drawn.z).toBeCloseTo(65, 9)
    }
    // The G2 arc bulges about the rehearsal's recorded machine centre.
    const arc = drawnPoints(vp).filter((p) =>
      p.work.z === 5 && p.work.x > 0.5 && p.work.x < 19.5 && p.work.y > 20.5)
    expect(arc.length).toBeGreaterThan(4)
    for (const p of arc) {
      expect(Math.hypot(p.world.x - ARC_CENTRE_30[0], p.world.y - ARC_CENTRE_30[1])).toBeCloseTo(20, 2)
    }

    // The live cutter rides the same frame: the DRO's work X20 Y20 (rehearsal
    // step 5) is drawn at machine X407.3205 Y427.3205.
    act(() => { frames.shift()?.(0) })
    expect(vp.setToolMarkerPosition).toHaveBeenLastCalledWith(20, 20, 20)
    const cutter = new THREE.Vector3(20, 20, 20).applyMatrix4(vp.programFrameGroup.matrixWorld)
    expect(cutter.x).toBeCloseTo(407.3205, 3)
    expect(cutter.y).toBeCloseTo(427.3205, 3)

    // The machine frame is untouched: grid from machine zero, square border
    // on the true travel box, no turn on it.
    expect(vp.setMachinePreviewCoordinateFrame).toHaveBeenLastCalledWith({
      programOriginMachine: { x: 400, y: 400, z: 60 },
      grid: {
        travel: { x: 800, y: 800 },
        originMachine: { x: 0, y: 0, z: 0 },
        extentMachine: { x: { min: -800, max: 0 }, y: { min: -800, max: 0 } },
      },
    })
    expect(gridSegmentsAxisAligned(vp)).toBe(true)
    const border = borderCorners(vp).map((c) => [c.x, c.y])
    expect(border).toEqual([[-800, -800], [0, -800], [0, 0], [-800, 0]])
  })

  it('G55 grid, G55 rotated 30 deg: the program is square to its grid and the travel box is drawn turned by -30 deg', async () => {
    harness.rotations = { G55: 30 }
    render(<ProgramPreview />)
    chooseGrid('G55')
    const vp = viewport()
    await waitFor(() => expect(vp.setMachinePreviewCoordinateFrame).toHaveBeenLastCalledWith(
      expect.objectContaining({ grid: expect.objectContaining({ originMachine: { x: 400, y: 400, z: 60 } }) }),
    ))

    // Square: every corner sits at G55 origin + work, on the grid's own axes.
    for (const [x, y] of [[0, 0], [0, 20], [20, 40], [40, 40], [40, 0]]) {
      const drawn = drawnAtWork(vp, x, y)
      expect(drawn.x).toBeCloseTo(400 + x, 9)
      expect(drawn.y).toBeCloseTo(400 + y, 9)
    }
    expect(gridSegmentsAxisAligned(vp)).toBe(true)
    // The grid's origin marker is G55's origin.
    expect(vp.wcsGroup.children.at(-1)!.position.toArray()).toEqual([400, 400, 60])

    // The machine-fixed travel box: the true box (-800..0 both axes), turned
    // by -30 deg about G55's origin.
    const turn = (x: number, y: number) => {
      const a = (-30 * Math.PI) / 180
      return [400 + (x - 400) * Math.cos(a) - (y - 400) * Math.sin(a), 400 + (x - 400) * Math.sin(a) + (y - 400) * Math.cos(a)]
    }
    const expected = [[-800, -800], [0, -800], [0, 0], [-800, 0]].map(([x, y]) => turn(x, y))
    const drawn = borderCorners(vp)
    drawn.forEach((c, i) => {
      // The border's vertices are Float32 buffer data: 0.001 mm.
      expect(c.x).toBeCloseTo(expected[i][0], 3)
      expect(c.y).toBeCloseTo(expected[i][1], 3)
    })
    const edge = Math.atan2(drawn[1].y - drawn[0].y, drawn[1].x - drawn[0].x) * 180 / Math.PI
    expect(edge).toBeCloseTo(-30, 5)
    // ...and the grid covers all of it.
    const frame = vp.setMachinePreviewCoordinateFrame.mock.calls.at(-1)![0] as {
      grid: { extentMachine: { x: { min: number; max: number }; y: { min: number; max: number } } }
    }
    for (const c of drawn) {
      expect(c.x).toBeGreaterThanOrEqual(frame.grid.extentMachine.x.min - 1e-3)
      expect(c.x).toBeLessThanOrEqual(frame.grid.extentMachine.x.max + 1e-3)
      expect(c.y).toBeGreaterThanOrEqual(frame.grid.extentMachine.y.min - 1e-3)
      expect(c.y).toBeLessThanOrEqual(frame.grid.extentMachine.y.max + 1e-3)
    }

    // Back to Machine: the program turns to where the machine runs it again,
    // and the border is the square travel box again.
    chooseGrid('machine')
    await waitFor(() => {
      const d = drawnAtWork(vp, 40, 0)
      expect(d.x).toBeCloseTo(434.641, 2)
      expect(d.y).toBeCloseTo(420, 2)
    })
    expect(borderCorners(vp).map((c) => [c.x, c.y])).toEqual([[-800, -800], [0, -800], [0, 0], [-800, 0]])
  })

  it('another work offset or Off: the program is drawn at its true machine position, the view framed by the chosen grid', async () => {
    harness.rotations = { G55: 30 }
    render(<ProgramPreview />)
    const vp = viewport()

    // G54 grid (G54 not rotated): the view is square to G54 = to the machine.
    chooseGrid('G54')
    await waitFor(() => expect(vp.setMachinePreviewCoordinateFrame).toHaveBeenLastCalledWith(
      expect.objectContaining({ grid: expect.objectContaining({ originMachine: { x: 81.228, y: 61.322, z: 12.16 } }) }),
    ))
    for (const { work, machine } of REHEARSAL_30) {
      const drawn = drawnAtWork(vp, work[0], work[1])
      expect(Math.abs(drawn.x - machine[0])).toBeLessThan(0.01)
      expect(Math.abs(drawn.y - machine[1])).toBeLessThan(0.01)
    }

    // Off: no grid, same true machine position.
    chooseGrid('off')
    await waitFor(() => expect(vp.setMachinePreviewCoordinateFrame).toHaveBeenLastCalledWith({
      programOriginMachine: { x: 400, y: 400, z: 60 },
      grid: null,
    }))
    const d = drawnAtWork(vp, 20, 40)
    expect(Math.abs(d.x - 397.3205)).toBeLessThan(0.01)
    expect(Math.abs(d.y - 444.641)).toBeLessThan(0.01)

    // A G54 program seen from the rotated G55 grid: still at its true machine
    // position, turned INTO the G55 view (-30 deg about G55's origin).
    setMachineState({ activeWcs: 'G54', programText: 'G21 G90\nG0 X0 Y0 Z5\nG1 X10 Y0 Z5 F100' })
    chooseGrid('G55')
    await waitFor(() => {
      const p = drawnAtWork(vp, 10, 0)
      const a = (-30 * Math.PI) / 180
      const mx = 81.228 + 10 - 400
      const my = 61.322 - 400
      expect(p.x).toBeCloseTo(400 + mx * Math.cos(a) - my * Math.sin(a), 6)
      expect(p.y).toBeCloseTo(400 + mx * Math.sin(a) + my * Math.cos(a), 6)
    })
  })

  it('follows the controller report live and never rotates the program itself (display only)', async () => {
    render(<ProgramPreview />)
    const vp = viewport()
    await waitFor(() => expect(vp.renderToolpath).toHaveBeenCalled())
    const before = drawnAtWork(vp, 40, 0)
    expect([before.x, before.y]).toEqual([440, 400])

    setRotations({ G55: 30 })
    await waitFor(() => {
      const after = drawnAtWork(vp, 40, 0)
      expect(after.x).toBeCloseTo(434.641, 2)
      expect(after.y).toBeCloseTo(420, 2)
    })
    // The program handed to the viewport is the file's own work coordinates,
    // and the loaded text is unchanged: the controller rotates what it runs.
    const moves = vp.renderToolpath.mock.calls.at(-1)![0] as ToolpathMove[]
    expect(moves.some((m) => m.x === 40 && m.y === 0 && m.z === 5)).toBe(true)
    expect(useMachineControl.getState().programText).toBe(SQUARE_G55)

    setRotations({})
    await waitFor(() => {
      const cleared = drawnAtWork(vp, 40, 0)
      expect([cleared.x, cleared.y]).toEqual([440, 400])
    })
    expect(vp.programFrameGroup.rotation.z).toBe(0)
    expect(vp.machineTravelBorderGroup.matrixAutoUpdate).toBe(true)
  })

  it('no rotation: the viewport receives exactly what it always did, on every grid', async () => {
    render(<ProgramPreview />)
    const vp = viewport()
    await waitFor(() => expect(vp.setMachinePreviewCoordinateFrame).toHaveBeenLastCalledWith({
      programOriginMachine: { x: 400, y: 400, z: 60 },
      grid: {
        travel: { x: 800, y: 800 },
        originMachine: { x: 0, y: 0, z: 0 },
        extentMachine: { x: { min: -800, max: 0 }, y: { min: -800, max: 0 } },
      },
    }))
    chooseGrid('G55')
    await waitFor(() => expect(vp.setMachinePreviewCoordinateFrame).toHaveBeenLastCalledWith({
      programOriginMachine: { x: 400, y: 400, z: 60 },
      grid: {
        travel: { x: 800, y: 800 },
        originMachine: { x: 400, y: 400, z: 60 },
        extentMachine: { x: { min: -800, max: 0 }, y: { min: -800, max: 0 } },
      },
    }))
    expect(vp.programFrameGroup.rotation.z).toBe(0)
    expect(vp.programFrameGroup.matrixWorld.equals(
      new THREE.Matrix4().makeTranslation(400, 400, 60),
    )).toBe(true)
    expect(vp.machineTravelBorderGroup.matrixWorld.equals(new THREE.Matrix4())).toBe(true)
    expect(borderCorners(vp).map((c) => [c.x, c.y])).toEqual([[-800, -800], [0, -800], [0, 0], [-800, 0]])
  })
})
