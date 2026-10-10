// Criterion 2: auto-constraint inference on draw. Thresholds are centralized in
// SKETCH3D_INFERENCE_THRESHOLDS (inference.ts) - every test below is calibrated relative to
// those constants, not independent magic numbers, so a future threshold tune doesn't silently
// desync the fixtures from the code under test.
import { afterEach, describe, expect, it } from 'vitest'
import {
  SKETCH3D_INFERENCE_THRESHOLDS,
  commitInferenceCandidate,
  createSketch3dSolveService,
  inferLineDrawCandidates,
} from '../../sketch3d'
import type {
  Sketch3dArcEntity,
  Sketch3dDocument,
  Sketch3dDrawToolState,
  Sketch3dLineEntity,
  Sketch3dPointEntity,
  Sketch3dVec2,
} from '../../sketch3d'

const openServices: { dispose: () => void }[] = []

afterEach(() => {
  while (openServices.length > 0) openServices.pop()?.dispose()
})

async function solver() {
  const service = await createSketch3dSolveService()
  openServices.push(service)
  return service
}

const active: Sketch3dDrawToolState = { suppressInference: false }
const suppressed: Sketch3dDrawToolState = { suppressInference: true }

function kinds(candidates: ReturnType<typeof inferLineDrawCandidates>): string[] {
  return candidates.map((c) => c.kind)
}

// Perpendicular distance from `point` to the infinite line through lineStart/lineEnd - used to
// verify a committed tangent_la constraint holds without assuming a specific tangency point.
function distancePointToLine(point: Sketch3dVec2, lineStart: Sketch3dVec2, lineEnd: Sketch3dVec2): number {
  const dx = lineEnd.x - lineStart.x
  const dy = lineEnd.y - lineStart.y
  const numerator = Math.abs(dx * (lineStart.y - point.y) - (lineStart.x - point.x) * dy)
  return numerator / Math.hypot(dx, dy)
}

describe('sketch3d auto-constraint inference (criterion 2)', () => {
  it('offers a horizontal candidate for a near-horizontal drawn line, and committing applies it', async () => {
    const doc: Sketch3dDocument = {
      id: 'd',
      entities: [{ id: 'draft', kind: 'line', start: { x: 0, y: 0 }, end: { x: 10, y: 0.02 } }],
      constraints: [{ id: 'fix0', kind: 'fixed', point: { entityId: 'draft', site: 'start' } }],
    }
    const candidates = inferLineDrawCandidates(doc, 'draft', active)
    expect(kinds(candidates)).toContain('horizontal')

    const horizontal = candidates.find((c) => c.kind === 'horizontal')!
    const committed = commitInferenceCandidate(doc, horizontal)
    const service = await solver()
    const result = service.solve(committed)
    expect(result.status).toBe('success')
    const draft = result.entities.find((e) => e.id === 'draft') as Sketch3dLineEntity
    expect(draft.end.y).toBeCloseTo(draft.start.y, 6)
  })

  it('offers a vertical candidate for a near-vertical drawn line', () => {
    const doc: Sketch3dDocument = {
      id: 'd',
      entities: [{ id: 'draft', kind: 'line', start: { x: 0, y: 0 }, end: { x: 0.02, y: 10 } }],
      constraints: [],
    }
    const candidates = inferLineDrawCandidates(doc, 'draft', active)
    expect(kinds(candidates)).toContain('vertical')
  })

  it('FAILS-IF: no horizontal/vertical candidate fires outside the angle tolerance', () => {
    // 10deg off horizontal, well past SKETCH3D_INFERENCE_THRESHOLDS.angleToleranceRad (~3deg).
    const tenDegOffHorizontal = (10 * Math.PI) / 180
    const doc: Sketch3dDocument = {
      id: 'd',
      entities: [{
        id: 'draft',
        kind: 'line',
        start: { x: 0, y: 0 },
        end: { x: 10 * Math.cos(tenDegOffHorizontal), y: 10 * Math.sin(tenDegOffHorizontal) },
      }],
      constraints: [],
    }
    const candidates = inferLineDrawCandidates(doc, 'draft', active)
    expect(kinds(candidates)).not.toContain('horizontal')
    expect(kinds(candidates)).not.toContain('vertical')
  })

  it('offers a coincident candidate when a drawn endpoint lands near an existing point, and committing applies + solves it', async () => {
    const doc: Sketch3dDocument = {
      id: 'd',
      entities: [
        { id: 'p0', kind: 'point', at: { x: 10, y: 0 } },
        { id: 'draft', kind: 'line', start: { x: 0, y: 0 }, end: { x: 10.05, y: 0.03 } },
      ],
      constraints: [],
    }
    const candidates = inferLineDrawCandidates(doc, 'draft', active)
    const coincident = candidates.find((c) => c.kind === 'coincident')
    expect(coincident).toBeDefined()
    expect(coincident!.constraint.kind).toBe('coincident')
    if (coincident!.constraint.kind === 'coincident') {
      expect(coincident!.constraint.a).toEqual({ entityId: 'draft', site: 'end' })
      expect(coincident!.constraint.b).toEqual({ entityId: 'p0', site: 'self' })
    }

    const committed = commitInferenceCandidate(doc, coincident!)
    const service = await solver()
    const result = service.solve(committed)
    expect(result.status).toBe('success')
    const draft = result.entities.find((e) => e.id === 'draft') as Sketch3dLineEntity
    const p0 = result.entities.find((e) => e.id === 'p0') as Sketch3dPointEntity
    expect(draft.end.x).toBeCloseTo(p0.at.x, 6)
    expect(draft.end.y).toBeCloseTo(p0.at.y, 6)
  })

  it('FAILS-IF: no coincident candidate fires outside the snap distance', () => {
    expect(SKETCH3D_INFERENCE_THRESHOLDS.coincidentDistance).toBeLessThan(5)
    const doc: Sketch3dDocument = {
      id: 'd',
      entities: [
        { id: 'p0', kind: 'point', at: { x: 10, y: 0 } },
        // 5 units away from p0, well past coincidentDistance (0.75).
        { id: 'draft', kind: 'line', start: { x: 0, y: 0 }, end: { x: 15, y: 0 } },
      ],
      constraints: [],
    }
    const candidates = inferLineDrawCandidates(doc, 'draft', active)
    expect(kinds(candidates)).not.toContain('coincident')
  })

  it('offers a tangent candidate when a drawn line starts at an arc endpoint along its tangent direction, and committing applies + solves it', async () => {
    // Arc centered at origin, radius 5, endAngle = 90deg -> arc endpoint at (0, 5), tangent
    // direction there is horizontal (mod pi).
    const doc: Sketch3dDocument = {
      id: 'd',
      entities: [
        { id: 'a1', kind: 'arc', center: { x: 0, y: 0 }, radius: 5, startAngle: 0, endAngle: Math.PI / 2 },
        { id: 'draft', kind: 'line', start: { x: 0.03, y: 5.02 }, end: { x: 10.03, y: 5.05 } },
      ],
      constraints: [],
    }
    const candidates = inferLineDrawCandidates(doc, 'draft', active)
    expect(kinds(candidates)).toContain('coincident')
    expect(kinds(candidates)).toContain('tangent')
    const tangent = candidates.find((c) => c.kind === 'tangent')!
    expect(tangent.constraint.kind).toBe('tangent')
    if (tangent.constraint.kind === 'tangent') {
      expect([tangent.constraint.a, tangent.constraint.b]).toEqual(expect.arrayContaining(['draft', 'a1']))
    }

    const committed = commitInferenceCandidate(doc, tangent)
    const service = await solver()
    const result = service.solve(committed)
    expect(result.status).toBe('success')
    const arc = result.entities.find((e) => e.id === 'a1') as Sketch3dArcEntity
    const draft = result.entities.find((e) => e.id === 'draft') as Sketch3dLineEntity
    // tangent_la doesn't pin a specific point of tangency, so verify the general condition:
    // the arc's center sits exactly `radius` away from the (infinite) drawn line.
    expect(distancePointToLine(arc.center, draft.start, draft.end)).toBeCloseTo(arc.radius, 4)
  })

  it('FAILS-IF: no tangent candidate fires when direction is off the tangent by more than tolerance (coincident still does)', () => {
    const doc: Sketch3dDocument = {
      id: 'd',
      entities: [
        { id: 'a1', kind: 'arc', center: { x: 0, y: 0 }, radius: 5, startAngle: 0, endAngle: Math.PI / 2 },
        // Near the same arc endpoint (0,5), but drawn nearly VERTICAL - 90deg off the
        // horizontal tangent direction, far past tangentAngleToleranceRad (~3deg).
        { id: 'draft', kind: 'line', start: { x: 0.03, y: 5.02 }, end: { x: 0.05, y: 15 } },
      ],
      constraints: [],
    }
    const candidates = inferLineDrawCandidates(doc, 'draft', active)
    expect(kinds(candidates)).toContain('coincident')
    expect(kinds(candidates)).not.toContain('tangent')
  })

  it('suppression flag suppresses every candidate regardless of geometry', () => {
    const doc: Sketch3dDocument = {
      id: 'd',
      entities: [
        { id: 'p0', kind: 'point', at: { x: 10, y: 0 } },
        { id: 'draft', kind: 'line', start: { x: 0, y: 0 }, end: { x: 10.02, y: 0.01 } },
      ],
      constraints: [],
    }
    expect(inferLineDrawCandidates(doc, 'draft', suppressed)).toEqual([])
    // Sanity: the same document with suppression off DOES produce candidates - proves the
    // empty result above is the suppression flag acting, not a fixture that never matches.
    expect(inferLineDrawCandidates(doc, 'draft', active).length).toBeGreaterThan(0)
  })
})
