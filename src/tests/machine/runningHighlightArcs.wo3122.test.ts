// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  CURRENT_TRAIL_MAX_POINTS,
  currentMoveTrailPoints,
  firstRemainingMoveIndex,
  remainingProgramPath,
  stagedListingProgramPath,
} from '../../components/machine/ProgramPreview'
import { sampleArcMovesForLinearConsumers } from '../../lib/cam/toolpathArcSampling'
import { buildProgramPath, type ProgramPath } from '../../lib/machine/programPath'
import type { StagedProgramView } from '../../store/machineControlStore'

function geometry(clockwise = false, endZ = 0, fullCircle = false): ProgramPath {
  // Nonmonotonic ids deliberately preserve the executing-step identity.
  const view: StagedProgramView = {
    program: {
      frame: 'work', units: 'mm', index: {},
      steps: [
        { id: 90, kind: 'line', rapid: true, to: { x: 10, y: 0, z: 0 }, feedMmMin: 1000 },
        { id: 7, kind: 'arc', to: { x: fullCircle ? 10 : 0, y: fullCircle ? 0 : clockwise ? -10 : 10, z: endZ },
          centre: { x: 0, y: 0, z: endZ }, clockwise, plane: 'xy', feedMmMin: 100 },
      ],
    }, setups: [],
  }
  return stagedListingProgramPath(view, null)
}

const xyz = ({ x, y, z }: { x: number; y: number; z: number }) => ({ x, y, z })

describe('WO-3122 running geometry highlight', () => {
  it.each([
    [false, 0, false], [true, 0, false], [false, -4, false], [true, -4, true],
  ])('samples the executing arc on its radius (clockwise=%s, endZ=%s, fullCircle=%s)', (clockwise, endZ, fullCircle) => {
    const path = geometry(clockwise, endZ, fullCircle)
    const original = JSON.stringify(path)
    const points = currentMoveTrailPoints(path, 7, 0)!
    expect(points).not.toBeNull()
    for (let i = 1; i < points.length; i++) {
      const midpointRadius = Math.hypot((points[i - 1].x + points[i].x) / 2, (points[i - 1].y + points[i].y) / 2)
      expect(Math.abs(midpointRadius - 10)).toBeLessThan(0.01)
    }
    expect(points.length).toBeGreaterThan(3)
    for (const p of points) expect(Math.hypot(p.x, p.y)).toBeCloseTo(10, 6)
    // Same samples and helical Z as the static path, with no second tessellation.
    expect(points).toEqual(sampleArcMovesForLinearConsumers(path.moves).map(xyz))
    for (let i = 0; i < points.length; i++) {
      expect(points[i].z).toBeCloseTo(endZ * i / (points.length - 1), 8)
    }
    expect(JSON.stringify(path)).toBe(original)
    expect(firstRemainingMoveIndex(path, 7)).toBe(1)
    expect(remainingProgramPath(path, 7)).toEqual(path)
  })

  it('walks the previous arc backwards along its samples for the bounded trail', () => {
    const path = geometry()
    path.moves.push({ type: 'feed', x: 0, y: 11, z: 0 })
    path.moveLines.push(3)
    const points = currentMoveTrailPoints(path, 3, 2)!
    const arc = points.slice(0, -1)
    expect(arc.length).toBeGreaterThan(3)
    for (const p of arc) expect(Math.hypot(p.x, p.y)).toBeCloseTo(10, 6)
    const length = arc.slice(1).reduce((sum, p, i) => sum + Math.hypot(p.x - arc[i].x, p.y - arc[i].y), 0)
    expect(length).toBeGreaterThanOrEqual(2)
    expect(length).toBeLessThan(2.35)
    expect(points.at(-1)).toEqual({ x: 0, y: 11, z: 0 })
    const circle = geometry(false, 0, true)
    circle.moves.push({ type: 'feed', x: 11, y: 0, z: 0 })
    circle.moveLines.push(3)
    expect(currentMoveTrailPoints(circle, 3, 1000)!.length).toBe(CURRENT_TRAIL_MAX_POINTS + 2)
  })

  it('samples a first arc from the live tool while retaining first line and rapid behavior', () => {
    const path = geometry()
    const start = xyz(path.moves.shift()!)
    path.moveLines.shift()
    expect(currentMoveTrailPoints(path, 7, 15, start)).toEqual(
      sampleArcMovesForLinearConsumers([{ type: 'feed', ...start }, ...path.moves]).map(xyz),
    )
    const rapid: ProgramPath = { moves: [{ type: 'rapid', x: 1, y: 2, z: 3 }], moveLines: [9] }
    expect(currentMoveTrailPoints(rapid, 9, 15, start)).toEqual([start, { x: 1, y: 2, z: 3 }])
    expect(currentMoveTrailPoints(rapid, 9)).toBeNull()
  })

  it('keeps already sampled text, nonmotion cursors, lines and rapids unchanged', () => {
    const path = buildProgramPath('G21 G90\nG0 X10 Y0 Z0\nG3 X0 Y10 I-10 J0 F100\nG0 Z5')
    expect(currentMoveTrailPoints(path, 3, 0)).toEqual(path.moves.slice(1, -1).map(xyz))
    expect(currentMoveTrailPoints(path, 0)).toBeNull()
    expect(currentMoveTrailPoints(path, 99)).toBeNull()
    expect(currentMoveTrailPoints({ moves: [], moveLines: [] }, 7)).toBeNull()
  })
})
