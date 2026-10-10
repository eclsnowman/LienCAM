// @vitest-environment jsdom

import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { typedMock } from '../support/typedMock'

const harness = vi.hoisted(() => ({
  instances: [] as Array<{
    setActiveToolpathSegment: ReturnType<typeof vi.fn>
    setToolpathDoneBoundary: ReturnType<typeof vi.fn>
  }>,
}))

// CNCViewport's private members make its class nominally untypeable from a
// test mock. This seam records only the public calls ProgramPreview owns.
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

const frames: FrameRequestCallback[] = []
Object.defineProperty(globalThis, 'requestAnimationFrame', {
  value: vi.fn((callback: FrameRequestCallback) => {
    frames.push(callback)
    return frames.length
  }),
  configurable: true,
})
Object.defineProperty(globalThis, 'cancelAnimationFrame', { value: vi.fn(), configurable: true })

const {
  ProgramPreview,
  currentMoveTrailPoints,
  CURRENT_TRAIL_MM,
  CURRENT_TRAIL_UPDATE_MS,
  CURRENT_TRAIL_MAX_POINTS,
  firstRemainingMoveIndex,
} = await import('../../components/machine/ProgramPreview')
const { useMachineControl } = await import('../../store/machineControlStore')
const { buildProgramPath } = await import('../../lib/machine/programPath')

// A dense run: line 1 is the modal header, line 2 the rapid to the start,
// line 3 the plunge, then 40 one-millimetre feeds along X on lines 4..43.
const DENSE_STEPS = 40
const PROGRAM = [
  'G21 G90',
  'G0 X0 Y0 Z5',
  'G1 X0 Y0 Z-1 F100',
  ...Array.from({ length: DENSE_STEPS }, (_, i) => `G1 X${i + 1} Y0 Z-1`),
  'M30',
].join('\n')
/** Source line of the feed that ends at X = n. */
const lineEndingAtX = (n: number) => 3 + n

function runFrame(time: number) {
  const frame = frames.shift()
  expect(frame).toBeDefined()
  act(() => frame!(time))
}

function setPreviewState(
  phase: 'ready' | 'streaming' | 'paused' = 'streaming',
  line = lineEndingAtX(30),
) {
  const current = useMachineControl.getState()
  useMachineControl.setState({
    programText: PROGRAM,
    connectionPhase: 'connected',
    connectionKind: 'simulator',
    activeWcs: 'G54',
    offsets: { G54: [100, 50, 0] },
    settings: { 130: '300.000', 131: '200.000', 132: '100.000' },
    homed: true,
    wpos: { x: 30, y: 0, z: -1 },
    job: {
      ...current.job,
      phase,
      ackedSourceLine: line,
      sentSourceLine: line,
    },
  })
}

type Pt = { x: number; y: number; z: number }
const lastSegment = (): Pt[] | null =>
  harness.instances[0].setActiveToolpathSegment.mock.calls.at(-1)?.[0] ?? null
const polylineLength = (pts: Pt[]) => pts.slice(1).reduce(
  (sum, p, i) => sum + Math.hypot(p.x - pts[i].x, p.y - pts[i].y, p.z - pts[i].z),
  0,
)

beforeEach(() => {
  cleanup()
  frames.length = 0
  harness.instances.length = 0
  localStorage.clear()
  setPreviewState()
})

afterEach(cleanup)

describe('WO-2048 current move and live tool emphasis', () => {
  it('lights a short trail of path ending at the current move, not one sub-millimetre move', () => {
    const trail = currentMoveTrailPoints(buildProgramPath(PROGRAM), lineEndingAtX(30))
    expect(trail).not.toBeNull()
    // Ends where the current move ends, runs back along what was just cut.
    expect(trail!.at(-1)).toEqual({ x: 30, y: 0, z: -1 })
    expect(trail![0].x).toBeLessThan(30 - CURRENT_TRAIL_MM + 1e-9)
    const length = polylineLength(trail!)
    expect(length).toBeGreaterThanOrEqual(CURRENT_TRAIL_MM)
    expect(length).toBeLessThanOrEqual(CURRENT_TRAIL_MM + 1 + 1e-9)

    // Near the program start the trail is whatever path exists behind it.
    const path = buildProgramPath(PROGRAM)
    const early = currentMoveTrailPoints(path, lineEndingAtX(2))
    expect(early!.at(-1)).toEqual({ x: 2, y: 0, z: -1 })
    const { x, y, z } = path.moves[0]
    expect(early![0]).toEqual({ x, y, z })

    // A line with no geometry lights nothing rather than the wrong move.
    expect(currentMoveTrailPoints(buildProgramPath(PROGRAM), 1)).toBeNull()
  })

  it('bounds the trail by point count on very dense code', () => {
    // 0.05 mm feeds: 15 mm of trail would be 300 points.
    const fine = [
      'G21 G90',
      'G0 X0 Y0 Z5',
      'G1 X0 Y0 Z-1 F100',
      ...Array.from({ length: 400 }, (_, i) => `G1 X${((i + 1) * 0.05).toFixed(2)} Y0 Z-1`),
      'M30',
    ].join('\n')
    const trail = currentMoveTrailPoints(buildProgramPath(fine), 3 + 400)
    expect(trail).not.toBeNull()
    expect(trail!.at(-1)).toEqual({ x: 20, y: 0, z: -1 })
    // The current line's own two points plus the capped run behind it.
    expect(trail!.length).toBe(CURRENT_TRAIL_MAX_POINTS + 2)
  })

  it('draws the trail in the viewport\'s own line and adds no screen-space overlay or crosshair', () => {
    render(<ProgramPreview />)
    runFrame(16)

    const segment = lastSegment()
    expect(segment).not.toBeNull()
    expect(segment!.at(-1)).toEqual({ x: 30, y: 0, z: -1 })
    expect(polylineLength(segment!)).toBeGreaterThanOrEqual(CURRENT_TRAIL_MM)
    expect(screen.queryByTestId('program-preview-live-emphasis')).toBeNull()
    expect(screen.queryByTestId('program-preview-current-move')).toBeNull()
    expect(screen.queryByTestId('program-preview-current-tool')).toBeNull()
    expect(screen.getByTestId('control-preview').querySelector('svg polyline')).toBeNull()
  })

  // WO-2580 (Operator ruling 2026-10-04: the controller's executing move is the ground
  // truth): the trail moves on the frame the controller's report names a new
  // move - never paced behind it. WO-2048's 100 ms pacing held the trail up
  // to a move behind the controller; the 15 mm trail is what keeps dense code
  // from reading as a flicker.
  it('moves the trail on the frame each new line is reported while dense lines arrive every frame', () => {
    render(<ProgramPreview />)
    const viewport = harness.instances[0]
    runFrame(0)
    const afterFirst = viewport.setActiveToolpathSegment.mock.calls.length

    // One new line per 60 Hz frame for ~0.4 s: 25 lines reported.
    let time = 0
    let x = 10
    setPreviewState('streaming', lineEndingAtX(x))
    for (let frame = 0; frame < 25; frame++) {
      time += 16
      x++
      act(() => setPreviewState('streaming', lineEndingAtX(x)))
      runFrame(time)
      expect(lastSegment()!.at(-1)).toEqual({ x, y: 0, z: -1 })
    }
    expect(viewport.setActiveToolpathSegment.mock.calls.length - afterFirst).toBe(25)
  })

  it('clears at once when the job stops on the same line and shows at once when paused', () => {
    render(<ProgramPreview />)
    const viewport = harness.instances[0]
    runFrame(16)
    expect(lastSegment()).not.toBeNull()

    // Stopping is never delayed by the display-rate pacing.
    act(() => setPreviewState('ready'))
    runFrame(20)
    expect(viewport.setActiveToolpathSegment).toHaveBeenLastCalledWith(null)

    act(() => setPreviewState('paused'))
    runFrame(24)
    expect(lastSegment()).not.toBeNull()
    expect(lastSegment()!.at(-1)).toEqual({ x: 30, y: 0, z: -1 })
  })

  it('dims the moves already run and restores the full path when the job stops', () => {
    const path = buildProgramPath(PROGRAM)
    const boundary = firstRemainingMoveIndex(path, lineEndingAtX(30))
    // The boundary is the current line's first move: everything before it,
    // ending at X29, is done; the current move to X30 and after are not.
    expect(path.moves[boundary - 1]).toMatchObject({ x: 29, y: 0, z: -1 })
    expect(path.moves[boundary]).toMatchObject({ x: 30, y: 0, z: -1 })
    expect(path.moveLines[boundary]).toBe(lineEndingAtX(30))
    expect(firstRemainingMoveIndex(path, 0)).toBe(0)
    expect(firstRemainingMoveIndex(path, 999)).toBe(path.moves.length)

    render(<ProgramPreview />)
    const viewport = harness.instances[0]
    // A newly loaded program starts with nothing dimmed.
    expect(viewport.setToolpathDoneBoundary).toHaveBeenCalledWith(null)
    runFrame(16)
    expect(viewport.setToolpathDoneBoundary).toHaveBeenLastCalledWith(boundary)

    // It advances on the same paced update as the trail.
    act(() => setPreviewState('streaming', lineEndingAtX(35)))
    runFrame(16 + CURRENT_TRAIL_UPDATE_MS)
    expect(viewport.setToolpathDoneBoundary)
      .toHaveBeenLastCalledWith(firstRemainingMoveIndex(path, lineEndingAtX(35)))

    act(() => setPreviewState('paused', lineEndingAtX(35)))
    runFrame(20 + CURRENT_TRAIL_UPDATE_MS)
    expect(viewport.setToolpathDoneBoundary)
      .toHaveBeenLastCalledWith(firstRemainingMoveIndex(path, lineEndingAtX(35)))

    act(() => setPreviewState('ready', lineEndingAtX(35)))
    runFrame(24 + CURRENT_TRAIL_UPDATE_MS)
    expect(viewport.setToolpathDoneBoundary).toHaveBeenLastCalledWith(null)
  })
})
