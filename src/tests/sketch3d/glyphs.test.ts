// Criterion 5: canvas constraint glyphs, PER-KIND completeness (Architect ruling 2) - every
// constraint kind in criterion 1's vocabulary gets its own render/hover/select/delete proof in
// ONE test, so the checklist table in coordination/reports/SKC-3.report.json can point every
// cell at a real, passing test name (not "works for lines" standing in for the rest).
//
// Glyph computation is pure geometry over the document as authored - no solver/service needed
// here (that's the point of criterion 6: glyphs never enter the solve loop).
import { afterEach, describe, expect, it } from 'vitest'
import {
  computeConstraintGlyphs,
  createSketch3dSolveService,
  deleteConstraintGlyph,
  hoverConstraintGlyph,
  selectConstraintGlyph,
} from '../../sketch3d'
import type { Sketch3dConstraint, Sketch3dDocument, Sketch3dEntity } from '../../sketch3d'

const openServices: { dispose: () => void }[] = []

afterEach(() => {
  while (openServices.length > 0) openServices.pop()?.dispose()
})

async function checkGlyphLifecycle(
  document: Sketch3dDocument,
  constraintId: string,
  kind: Sketch3dConstraint['kind'],
): Promise<void> {
  // RENDER
  const glyphs = computeConstraintGlyphs(document)
  const glyph = glyphs.find((candidate) => candidate.constraintId === constraintId)
  expect(glyph, `render: expected a glyph for ${kind} constraint '${constraintId}'`).toBeDefined()
  expect(glyph!.kind).toBe(kind)
  expect(glyph!.entityIds.length).toBeGreaterThan(0)

  // HOVER
  const hovered = hoverConstraintGlyph(glyphs, glyph!.anchor)
  expect(hovered?.constraintId, `hover: expected to hit ${kind} glyph at its own anchor`).toBe(constraintId)

  // SELECT
  const selected = selectConstraintGlyph(glyphs, glyph!.anchor)
  expect(selected?.constraintId, `select: expected to hit ${kind} glyph at its own anchor`).toBe(constraintId)

  // DELETE
  const afterDelete = deleteConstraintGlyph(document, glyph!)
  expect(afterDelete.constraints.some((c) => c.id === constraintId), `delete: expected ${kind} constraint removed`).toBe(false)
  expect(afterDelete.constraints.length).toBe(document.constraints.length - 1)

  // DELETE RESOLVES: criterion 5 requires "delete removes constraint + resolves", not just
  // array surgery - prove the solver accepts the post-delete document cleanly and that the
  // removed constraint no longer lingers in its conflicting/redundant sets, for every kind.
  const service = await createSketch3dSolveService()
  openServices.push(service)
  const result = service.solve(afterDelete)
  expect(result.status, `delete: expected ${kind}'s post-delete document to resolve, got '${result.status}'`).not.toBe('failed')
  expect(result.status, `delete: expected ${kind}'s post-delete document to resolve, got '${result.status}'`).not.toBe('invalid_sketch')
  expect(result.conflicting, `delete: deleted ${kind} constraint must not linger in the solver's conflicting set`).not.toContain(constraintId)
  expect(result.redundant, `delete: deleted ${kind} constraint must not linger in the solver's redundant set`).not.toContain(constraintId)
}

function doc(entities: Sketch3dEntity[], constraints: Sketch3dConstraint[]): Sketch3dDocument {
  return { id: 'glyphs', entities, constraints }
}

describe('sketch3d constraint glyphs (criterion 5, per-kind checklist)', () => {
  it('coincident: render/hover/select/delete', async () => {
    await checkGlyphLifecycle(doc(
      [
        { id: 'l1', kind: 'line', start: { x: 0, y: 0 }, end: { x: 10, y: 0 } },
        { id: 'l2', kind: 'line', start: { x: 10, y: 0 }, end: { x: 10, y: 10 } },
      ],
      [{ id: 'c1', kind: 'coincident', a: { entityId: 'l1', site: 'end' }, b: { entityId: 'l2', site: 'start' } }],
    ), 'c1', 'coincident')
  })

  it('horizontal: render/hover/select/delete', async () => {
    await checkGlyphLifecycle(doc(
      [{ id: 'l1', kind: 'line', start: { x: 0, y: 0 }, end: { x: 10, y: 0 } }],
      [{ id: 'c1', kind: 'horizontal', line: 'l1' }],
    ), 'c1', 'horizontal')
  })

  it('vertical: render/hover/select/delete', async () => {
    await checkGlyphLifecycle(doc(
      [{ id: 'l1', kind: 'line', start: { x: 0, y: 0 }, end: { x: 0, y: 10 } }],
      [{ id: 'c1', kind: 'vertical', line: 'l1' }],
    ), 'c1', 'vertical')
  })

  it('parallel: render/hover/select/delete', async () => {
    await checkGlyphLifecycle(doc(
      [
        { id: 'l1', kind: 'line', start: { x: 0, y: 0 }, end: { x: 10, y: 0 } },
        { id: 'l2', kind: 'line', start: { x: 0, y: 5 }, end: { x: 10, y: 5 } },
      ],
      [{ id: 'c1', kind: 'parallel', a: 'l1', b: 'l2' }],
    ), 'c1', 'parallel')
  })

  it('perpendicular: render/hover/select/delete', async () => {
    await checkGlyphLifecycle(doc(
      [
        { id: 'l1', kind: 'line', start: { x: 0, y: 0 }, end: { x: 10, y: 0 } },
        { id: 'l2', kind: 'line', start: { x: 5, y: -5 }, end: { x: 5, y: 5 } },
      ],
      [{ id: 'c1', kind: 'perpendicular', a: 'l1', b: 'l2' }],
    ), 'c1', 'perpendicular')
  })

  it('tangent: render/hover/select/delete', async () => {
    await checkGlyphLifecycle(doc(
      [
        { id: 'c0', kind: 'circle', center: { x: 0, y: 0 }, radius: 5 },
        { id: 'l1', kind: 'line', start: { x: 5, y: -10 }, end: { x: 5, y: 10 } },
      ],
      [{ id: 'c1', kind: 'tangent', a: 'l1', b: 'c0' }],
    ), 'c1', 'tangent')
  })

  it('equal: render/hover/select/delete', async () => {
    await checkGlyphLifecycle(doc(
      [
        { id: 'l1', kind: 'line', start: { x: 0, y: 0 }, end: { x: 10, y: 0 } },
        { id: 'l2', kind: 'line', start: { x: 0, y: 5 }, end: { x: 10, y: 5 } },
      ],
      [{ id: 'c1', kind: 'equal', a: 'l1', b: 'l2' }],
    ), 'c1', 'equal')
  })

  it('midpoint: render/hover/select/delete', async () => {
    await checkGlyphLifecycle(doc(
      [
        { id: 'l1', kind: 'line', start: { x: 0, y: 0 }, end: { x: 10, y: 0 } },
        { id: 'p1', kind: 'point', at: { x: 5, y: 0 } },
      ],
      [{ id: 'c1', kind: 'midpoint', point: { entityId: 'p1', site: 'self' }, line: 'l1' }],
    ), 'c1', 'midpoint')
  })

  it('distance (point-point): render/hover/select/delete', async () => {
    await checkGlyphLifecycle(doc(
      [
        { id: 'a', kind: 'point', at: { x: 0, y: 0 } },
        { id: 'b', kind: 'point', at: { x: 10, y: 0 } },
      ],
      [{ id: 'c1', kind: 'distance', a: { entityId: 'a', site: 'self' }, b: { entityId: 'b', site: 'self' }, value: 10 }],
    ), 'c1', 'distance')
  })

  it('distance (point-line): render/hover/select/delete', async () => {
    await checkGlyphLifecycle(doc(
      [
        { id: 'a', kind: 'point', at: { x: 0, y: 5 } },
        { id: 'l1', kind: 'line', start: { x: 10, y: -5 }, end: { x: 10, y: 5 } },
      ],
      [{ id: 'c1', kind: 'distance', a: { entityId: 'a', site: 'self' }, line: 'l1', value: 7 }],
    ), 'c1', 'distance')
  })

  it('angle: render/hover/select/delete', async () => {
    await checkGlyphLifecycle(doc(
      [
        { id: 'l1', kind: 'line', start: { x: 0, y: 0 }, end: { x: 10, y: 0 } },
        { id: 'l2', kind: 'line', start: { x: 0, y: 5 }, end: { x: 10, y: 6 } },
      ],
      [{ id: 'c1', kind: 'angle', a: 'l1', b: 'l2', value: 0.1 }],
    ), 'c1', 'angle')
  })

  it('radius: render/hover/select/delete', async () => {
    await checkGlyphLifecycle(doc(
      [{ id: 'c0', kind: 'circle', center: { x: 0, y: 0 }, radius: 5 }],
      [{ id: 'c1', kind: 'radius', entityId: 'c0', value: 9 }],
    ), 'c1', 'radius')
  })

  it('diameter: render/hover/select/delete', async () => {
    await checkGlyphLifecycle(doc(
      [{ id: 'c0', kind: 'circle', center: { x: 0, y: 0 }, radius: 5 }],
      [{ id: 'c1', kind: 'diameter', entityId: 'c0', value: 20 }],
    ), 'c1', 'diameter')
  })
})
