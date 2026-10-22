// WO-3006 (WO-2750 Slice E): the annotation layer as plain functions -
// docs/design/ASSOCIATIVE-TECHNICAL-DRAWINGS.md section 8 rows owned here:
//   - "Edit native box 100 to 120 mm" (value recomputed from current geometry,
//     tolerance and place kept) and "Delete dimensioned hole beside identical
//     hole" (missing, never the neighbour) at the resolver seam;
//   - "Aligned, float, detail, balloon": detail magnification changes paper
//     geometry only; balloon numbers; a detail is cropped in source space.
// The real-kernel, real-page versions of the same rows are in
// src/tests/model3d/drawingRepair.wo2750.test.tsx.

import { describe, expect, it } from 'vitest'
import { ElementMap } from '../../doc/element-map'
import type { GeometrySnapshot } from '../../geom/geom-service'
import {
  addBalloon,
  addDetailView,
  addDimension,
  bodyFacesFromTess,
  brepSourceForBody,
  detailCircle,
  detailCircleOnParent,
  dimensionGraphic,
  faceFacts,
  fitCircle,
  formatDimensionText,
  makeFaceReference,
  measureFaces,
  modelToSheet,
  nextBalloonNumber,
  nextDetailLabel,
  pickFace,
  reassociateDimension,
  removeAnnotations,
  removeDetailView,
  resolveDimension,
  restoreDrawingEdit,
  setDetailMagnification,
  withLastGood,
  type BodyFaces,
  type FaceFacts,
} from '../../lib/drawing/annotations'
import { createDrawingDocument, layoutStandardViews, type DrawingDimension, type DrawingDocument } from '../../lib/drawing/document'
import { standardViewFrame } from '../../lib/drawing/project'
import type { DrawingVec3, SourceRevision } from '../../lib/drawing/types'

const REV: SourceRevision = { geometryFingerprint: 'g1', frameFingerprint: 'body-local', producerVersion: 'p' }
const REV2: SourceRevision = { ...REV, geometryFingerprint: 'g2' }

function plane(c: DrawingVec3, n: DrawingVec3, area: number): GeometrySnapshot {
  return { surfaceType: 'plane', centroid: { x: c[0], y: c[1], z: c[2] }, area, normal: { x: n[0], y: n[1], z: n[2] } }
}
function cylinder(c: DrawingVec3, area: number): GeometrySnapshot {
  return { surfaceType: 'cylinder', centroid: { x: c[0], y: c[1], z: c[2] }, area, axis: { x: 0, y: 0, z: 1 } }
}

/** Triangles of an axis-aligned rectangle in a Z plane. */
function zRect(x0: number, y0: number, x1: number, y1: number, z: number): number[] {
  return [x0, y0, z, x1, y0, z, x1, y1, z, x0, y0, z, x1, y1, z, x0, y1, z]
}
/** A side wall (Y = y) of a block, X x0..x1, Z z0..z1. */
function yRect(x0: number, x1: number, y: number, z0: number, z1: number): number[] {
  return [x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z0, x1, y, z1, x0, y, z1]
}
/** A cylinder wall of radius r about the Z line through (cx, cy), Z z0..z1, `n` facets. */
function ring(cx: number, cy: number, r: number, z0: number, z1: number, n = 24, squash = 1): number[] {
  const out: number[] = []
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2
    const p = (a: number, z: number) => [cx + r * Math.cos(a), cy + r * squash * Math.sin(a), z]
    out.push(...p(a0, z0), ...p(a1, z0), ...p(a1, z1), ...p(a0, z0), ...p(a1, z1), ...p(a0, z1))
  }
  return out
}

/** A 60 x 40 x `h` block with two identical 8 mm holes (A at X 15, B at X 45) 12 deep from the bottom. */
function block(h: number, withB = true): { faces: BodyFaces; map: ElementMap } {
  const tris = new Map<string, number[]>([
    ['BOT', zRect(0, 0, 60, 40, 0)],
    ['TOP', zRect(0, 0, 60, 40, h)],
    ['FRONT', yRect(0, 60, 0, 0, h)],
    ['HA', ring(15, 20, 4, 0, 12)],
  ])
  if (withB) tris.set('HB', ring(45, 20, 4, 0, 12))
  const map = new ElementMap()
  map.applyDelta({
    featureId: 'F1', modified: {}, deleted: [], generated: ['BOT', 'TOP', 'FRONT'],
    geometry: { BOT: plane([30, 20, 0], [0, 0, -1], 2400), TOP: plane([30, 20, h], [0, 0, 1], 2400), FRONT: plane([30, 0, h / 2], [0, -1, 0], 60 * h) },
  })
  map.applyDelta({ featureId: 'F2', modified: {}, deleted: [], generated: ['HA'], geometry: { HA: cylinder([15, 20, 6], 301.59) } })
  map.applyDelta({ featureId: 'F3', modified: {}, deleted: [], generated: ['HB'], geometry: { HB: cylinder([45, 20, 6], 301.59) } })
  return { faces: { triangles: tris, bboxDiagMm: Math.hypot(60, 40, h) }, map }
}

function newDoc(): DrawingDocument {
  const centre: DrawingVec3 = [30, 20, 50]
  return createDrawingDocument({
    id: 'drawing-1',
    name: 'Drawing of Block',
    source: { modelItemId: 'legacy', documentId: 'doc', lineageId: 'F1', kind: 'model-brep', observedRevision: REV },
    frames: { front: standardViewFrame('front', centre), top: standardViewFrame('top', centre), right: standardViewFrame('right', centre), iso: standardViewFrame('iso', centre) },
    box: { min: [0, 0, 0], max: [60, 40, 100] },
    now: '2026-10-21T04:00:00.000Z',
  })
}

function facts(b: { faces: BodyFaces; map: ElementMap }, id: string): FaceFacts {
  const f = faceFacts(b.map, b.faces, id)
  if (f === undefined) throw new Error(`no facts for ${id}`)
  return f
}

/** Place a dimension of `kind` on faces `ids` in view `viewId`. */
function place(doc: DrawingDocument, b: { faces: BodyFaces; map: ElementMap }, kind: DrawingDimension['measurement'], ids: string[], viewId = 'view-front'): { doc: DrawingDocument; id: string } {
  let scratch = doc
  const refs = ids.map((fid, i) => {
    const ref = makeFaceReference(`ref-${doc.references.length + i + 1}`, doc, REV, facts(b, fid))
    scratch = { ...scratch, references: [...scratch.references, ref] }
    return ref
  })
  const m = measureFaces(kind, ids.map((fid) => facts(b, fid)))
  if (!m.ok) throw new Error(m.problem)
  return addDimension(doc, { kind, viewId, references: refs, labelSheetMm: [20, 40], value: m.value, revision: REV }, '2026-10-21T04:01:00.000Z')
}

function resolveIn(doc: DrawingDocument, b: { faces: BodyFaces; map: ElementMap }, dimId: string, revision = REV) {
  const dim = doc.annotations.find((a): a is DrawingDimension => a.kind === 'dimension' && a.id === dimId)!
  return resolveDimension(dim, doc, { source: brepSourceForBody(doc, revision, b.map, b.faces), facts: (id) => faceFacts(b.map, b.faces, id) })
}

describe('WO-3006 measuring faces', () => {
  it('fits a hole radius to its nodes exactly, and calls a squashed wall not round', () => {
    const pts: DrawingVec3[] = []
    const r = ring(15, 20, 4, 0, 12, 36)
    for (let i = 0; i < r.length; i += 3) pts.push([r[i], r[i + 1], r[i + 2]])
    const fit = fitCircle(pts, [0, 0, 1])!
    expect(fit.radius).toBeCloseTo(4, 9)
    expect(fit.center[0]).toBeCloseTo(15, 9)
    expect(fit.maxDeviation).toBeLessThan(1e-9)

    const b = block(100)
    expect(measureFaces('diameter', [facts(b, 'HA')])).toEqual({ ok: true, value: expect.closeTo(8, 9), unit: 'mm' })
    expect(measureFaces('radius', [facts(b, 'HA')])).toEqual({ ok: true, value: expect.closeTo(4, 9), unit: 'mm' })
    b.faces.triangles.set('HA', ring(15, 20, 4, 0, 12, 24, 0.9))
    expect(measureFaces('diameter', [facts(b, 'HA')])).toEqual({ ok: false, problem: 'not-round' })
  })

  it('reads linear and angle values from the current planes and names every refusal', () => {
    const b = block(100)
    expect(measureFaces('linear', [facts(b, 'BOT'), facts(b, 'TOP')])).toEqual({ ok: true, value: 100, unit: 'mm' })
    expect(measureFaces('angle', [facts(b, 'BOT'), facts(b, 'FRONT')])).toEqual({ ok: true, value: expect.closeTo(90, 9), unit: 'deg' })
    expect(measureFaces('linear', [facts(b, 'BOT'), facts(b, 'FRONT')])).toEqual({ ok: false, problem: 'not-parallel' })
    expect(measureFaces('angle', [facts(b, 'BOT'), facts(b, 'TOP')])).toEqual({ ok: false, problem: 'parallel' })
    expect(measureFaces('linear', [facts(b, 'BOT'), facts(b, 'BOT')])).toEqual({ ok: false, problem: 'same-face' })
    expect(measureFaces('linear', [facts(b, 'BOT'), facts(b, 'HA')])).toEqual({ ok: false, problem: 'needs-plane' })
    expect(measureFaces('diameter', [facts(b, 'TOP')])).toEqual({ ok: false, problem: 'needs-round' })
    expect(measureFaces('diameter', [undefined])).toEqual({ ok: false, problem: 'no-geometry' })
  })

  it('fix round 2: a small angle is measured (1 degree of draft), only truly parallel faces are refused', () => {
    const plane = (id: string, normal: DrawingVec3): FaceFacts => ({
      id, surfaceType: 'plane', centroid: [0, 0, 0], normal, points: [], snapshot: { surfaceType: 'plane' } as GeometrySnapshot,
    })
    const rad = Math.PI / 180
    for (const deg of [1, 0.1, 0.01]) {
      const m = measureFaces('angle', [plane('A', [1, 0, 0]), plane('B', [Math.cos(deg * rad), Math.sin(deg * rad), 0])])
      expect(m, `${deg} degrees`).toEqual({ ok: true, value: expect.closeTo(deg, 6), unit: 'deg' })
    }
    expect(measureFaces('angle', [plane('A', [1, 0, 0]), plane('B', [-1, 0, 0])])).toEqual({ ok: false, problem: 'parallel' })
  })

  it('fix round 2: a balloon placed on a detail view is deleted with that detail', () => {
    const doc0 = newDoc()
    const made = addDetailView(doc0, 'sheet-1', { parentViewId: 'view-front', centerSheetMm: [40, 120], radiusSheetMm: 6, placeSheetMm: [200, 60], magnification: { numerator: 2, denominator: 1 } })
    const onDetail = addBalloon(made.doc, { anchorSheetMm: [200, 60], labelSheetMm: [210, 50], viewId: made.id })
    const onSheet = addBalloon(onDetail.doc, { anchorSheetMm: [20, 20], labelSheetMm: [30, 10] })
    expect(onSheet.doc.annotations.find((a) => a.id === onDetail.id)).toMatchObject({ kind: 'balloon', viewId: made.id })
    const removed = removeDetailView(onSheet.doc, made.id)
    expect(removed.annotations.map((a) => a.id)).toEqual([onSheet.id])
  })

  it('picks the face seen edge-on under the click before the face behind it', () => {
    const b = block(100)
    const doc = newDoc()
    const front = doc.sheets[0].views.find((v) => v.id === 'view-front')!
    const top = doc.sheets[0].views.find((v) => v.id === 'view-top')!
    expect(pickFace(front, b.faces, modelToSheet(front, [30, 0, 0]))).toBe('BOT')
    expect(pickFace(front, b.faces, modelToSheet(front, [30, 0, 100]))).toBe('TOP')
    expect(pickFace(front, b.faces, modelToSheet(front, [30, 0, 50]))).toBe('FRONT')
    // Down the hole's axis its wall is a ring: picked on the ring, over the top face.
    expect(pickFace(top, b.faces, modelToSheet(top, [19, 20, 100]))).toBe('HA')
    expect(pickFace(top, b.faces, modelToSheet(top, [49, 20, 100]))).toBe('HB')
    expect(pickFace(front, b.faces, [5, 5])).toBe(null)
  })
})

describe('WO-3006 dimensions follow the part, and never move to a neighbour', () => {
  it('a 100 -> 120 edit recomputes the length; the tolerance, place and the hole are kept', () => {
    const b100 = block(100)
    let { doc, id } = place(newDoc(), b100, 'linear', ['BOT', 'TOP'])
    const hole = place(doc, b100, 'diameter', ['HA'], 'view-top')
    doc = hole.doc
    doc = { ...doc, annotations: doc.annotations.map((a) => (a.id === id && a.kind === 'dimension' ? { ...a, tolerance: { kind: 'bilateral' as const, upper: 0.1, lower: -0.05 } } : a)) }
    expect(resolveIn(doc, b100, id)).toMatchObject({ state: 'current', value: 100 })

    const b120 = block(120)
    const st = resolveIn(doc, b120, id, REV2)
    expect(st).toMatchObject({ state: 'current', value: 120 })
    expect(st.references.map((r) => r.resolvedIds[0])).toEqual(['BOT', 'TOP'])
    expect(resolveIn(doc, b120, hole.id, REV2)).toMatchObject({ state: 'current', value: expect.closeTo(8, 9) })
    // The last-good cache moves with the proof; editedAt does not (not a drawing edit).
    const cached = withLastGood(doc, [{ id, value: 120, unit: 'mm', measuredAt: REV2 }])
    const dim = cached.annotations.find((a) => a.id === id) as DrawingDimension
    expect(dim.lastGood).toEqual({ value: 120, unit: 'mm', measuredAt: REV2 })
    expect(dim.tolerance).toEqual({ kind: 'bilateral', upper: 0.1, lower: -0.05 })
    expect(dim.labelSheetMm).toEqual([20, 40])
    expect(cached.editedAt).toBe(doc.editedAt)
  })

  it('a deleted hole is missing with its last value, even though the map still lists it and an identical hole stands beside it', () => {
    const b = block(100)
    const placed = place(newDoc(), b, 'diameter', ['HB'], 'view-top')
    const deleted = block(100, false)
    // The document's map still carries HB (a deleted feature's faces stay listed); the body does not.
    expect(deleted.map.has('HB')).toBe(true)
    const st = resolveIn(placed.doc, deleted, placed.id, REV2)
    expect(st.state).toBe('missing')
    expect(st.reason).toBe('deleted')
    expect(st.value).toBeUndefined()
    expect(st.candidates).not.toContain('HA')
    expect((placed.doc.annotations[0] as DrawingDimension).lastGood?.value).toBeCloseTo(8, 9)
    // The neighbour's own dimension is untouched.
    const other = place(placed.doc, b, 'diameter', ['HA'], 'view-top')
    expect(resolveIn(other.doc, deleted, other.id, REV2)).toMatchObject({ state: 'current', value: expect.closeTo(8, 9) })
  })

  it('two ends that land on one face are stale, never a fresh zero', () => {
    const b = block(100)
    const placed = place(newDoc(), b, 'linear', ['BOT', 'TOP'])
    b.map.applyDelta({ featureId: 'MERGE', modified: { TOP: ['BOT'] }, generated: [], deleted: [] })
    b.faces.triangles.delete('TOP')
    const st = resolveIn(placed.doc, b, placed.id, REV2)
    expect(st.state).toBe('stale')
    expect(st.value).toBeUndefined()
  })

  it('reassociate changes one end of one dimension, records it, and Undo-restore puts the old face back', () => {
    const b = block(100)
    let doc = place(newDoc(), b, 'diameter', ['HB'], 'view-top').doc
    const holeB = doc.annotations[0].id
    const other = place(doc, b, 'linear', ['BOT', 'TOP'])
    doc = other.doc
    doc = { ...doc, annotations: doc.annotations.map((a) => (a.id === holeB && a.kind === 'dimension' ? { ...a, tolerance: { kind: 'limits' as const, lower: 7.98, upper: 8.05 } } : a)) }
    const before = doc
    const newRef = makeFaceReference('ref-9', doc, REV2, facts(b, 'HA'))
    const after = reassociateDimension(doc, holeB, 0, newRef, '2026-10-21T05:00:00.000Z')
    const dim = after.annotations.find((a) => a.id === holeB) as DrawingDimension
    expect(dim.referenceIds).toEqual(['ref-9'])
    expect(dim.tolerance).toEqual({ kind: 'limits', lower: 7.98, upper: 8.05 })
    expect(dim.labelSheetMm).toEqual([20, 40])
    expect(dim.repairs).toEqual([{ at: '2026-10-21T05:00:00.000Z', referenceIndex: 0, oldReferenceId: 'ref-1', newReferenceId: 'ref-9', oldSelector: { kind: 'face', stableId: 'HB' }, newSelector: { kind: 'face', stableId: 'HA' }, revision: REV2 }])
    // The old reference record went with it; the other dimension's did not.
    expect(after.references.map((r) => r.id).sort()).toEqual(['ref-2', 'ref-3', 'ref-9'])
    expect(after.annotations.find((a) => a.id === other.id)).toEqual(before.annotations.find((a) => a.id === other.id))
    expect(after.editedAt).toBe('2026-10-21T05:00:00.000Z')
    // Undo: the target's content with the part's caches of now.
    const undone = restoreDrawingEdit(before, after)
    expect((undone.annotations.find((a) => a.id === holeB) as DrawingDimension).referenceIds).toEqual(['ref-1'])
    expect(undone.references.map((r) => r.id).sort()).toEqual(['ref-1', 'ref-2', 'ref-3'])
  })
})

describe('WO-3006 detail views and balloons', () => {
  it('a detail crops in source space; magnification changes paper geometry, never the value', () => {
    const b = block(100)
    const doc0 = newDoc()
    const front = doc0.sheets[0].views.find((v) => v.id === 'view-front')!
    const kp = front.scale.numerator / front.scale.denominator
    const centre = modelToSheet(front, [5, 0, 5])
    const made = addDetailView(doc0, 'sheet-1', { parentViewId: 'view-front', centerSheetMm: centre, radiusSheetMm: 6, placeSheetMm: [200, 60], magnification: { numerator: 2, denominator: 1 } }, '2026-10-21T04:02:00.000Z')
    const detail = made.doc.sheets[0].views.find((v) => v.id === made.id)!
    expect(detail.label).toBe('A')
    expect(detail.frame.name).toBeUndefined()
    expect(detail.detail!.centerLocalMm[0]).toBeCloseTo(5, 9)
    expect(detail.detail!.centerLocalMm[2]).toBeCloseTo(5, 9)
    expect(detail.detail!.radiusMm).toBeCloseTo(6 / kp, 9)
    expect(detail.scale.numerator / detail.scale.denominator).toBeCloseTo(2 * kp, 9)
    expect(detailCircle(detail)!.center).toEqual([expect.closeTo(200, 9), expect.closeTo(60, 9)])
    expect(detailCircleOnParent(detail, front)!.center).toEqual([expect.closeTo(centre[0], 9), expect.closeTo(centre[1], 9)])

    // A 12 mm feature: 12 * scale on paper in the detail, 12 in value.
    const floor = { ...facts(b, 'BOT') }
    const hfloor: FaceFacts = { ...floor, id: 'HF', centroid: [15, 20, 12], points: [[11, 20, 12], [19, 20, 12]] }
    expect(measureFaces('linear', [floor, hfloor])).toEqual({ ok: true, value: 12, unit: 'mm' })
    const g2 = dimensionGraphic('linear', detail, [floor, hfloor], [200, 50])
    if ('problem' in g2) throw new Error(g2.problem)
    const len = (g: typeof g2) => Math.hypot(g.lines[2][1][0] - g.lines[2][0][0], g.lines[2][1][1] - g.lines[2][0][1])
    expect(len(g2)).toBeCloseTo(12 * 2 * kp, 9)
    const at4 = setDetailMagnification(made.doc, made.id, { numerator: 4, denominator: 1 })
    const d4 = at4.sheets[0].views.find((v) => v.id === made.id)!
    expect(detailCircle(d4)!.center).toEqual([expect.closeTo(200, 9), expect.closeTo(60, 9)])
    const g4 = dimensionGraphic('linear', d4, [floor, hfloor], [200, 50])
    if ('problem' in g4) throw new Error(g4.problem)
    expect(len(g4)).toBeCloseTo(2 * len(g2), 9)
    expect(measureFaces('linear', [floor, hfloor])).toEqual({ ok: true, value: 12, unit: 'mm' })

    // Laying the sheet out again keeps the detail where the operator put it, at parent x magnification.
    const relaid = layoutStandardViews(at4.sheets[0].views, [297, 210], 'third-angle', { min: [0, 0, 0], max: [60, 40, 100] })
    const rd = relaid.find((v) => v.id === made.id)!
    const rf = relaid.find((v) => v.id === 'view-front')!
    expect(rd.sheetOriginMm).toEqual(d4.sheetOriginMm)
    expect(rd.scale.numerator / rd.scale.denominator).toBeCloseTo(4 * rf.scale.numerator / rf.scale.denominator, 9)

    expect(nextDetailLabel(made.doc)).toBe('B')
    // Deleting the detail removes what was drawn in it, in one edit.
    const withDim = { ...made.doc, annotations: [...made.doc.annotations, { kind: 'dimension' as const, id: 'dim-9', measurement: 'linear' as const, referenceIds: [], tolerance: { kind: 'none' as const }, viewId: made.id }] }
    const removed = removeDetailView(withDim, made.id, '2026-10-21T04:03:00.000Z')
    expect(removed.sheets[0].views.map((v) => v.id)).not.toContain(made.id)
    expect(removed.annotations.map((a) => a.id)).not.toContain('dim-9')
  })

  it('balloons number 1, 2, 3 and keep a typed number', () => {
    let doc = newDoc()
    expect(nextBalloonNumber(doc)).toBe(1)
    doc = addBalloon(doc, { anchorSheetMm: [50, 50], labelSheetMm: [60, 40] }).doc
    doc = addBalloon(doc, { anchorSheetMm: [70, 50], labelSheetMm: [80, 40] }).doc
    expect(doc.annotations.map((a) => (a.kind === 'balloon' ? a.number : 0))).toEqual([1, 2])
    doc = { ...doc, annotations: doc.annotations.map((a) => (a.kind === 'balloon' && a.number === 2 ? { ...a, number: 7 } : a)) }
    expect(nextBalloonNumber(doc)).toBe(8)
    doc = removeAnnotations(doc, [doc.annotations[0].id])
    expect(doc.annotations.map((a) => (a.kind === 'balloon' ? a.number : 0))).toEqual([7])
  })
})

describe('WO-3006 dimension text', () => {
  it('formats symbols, tolerances and inches without changing what is stored', () => {
    expect(formatDimensionText('linear', 120, 'mm', 2, { kind: 'bilateral', upper: 0.1, lower: -0.05 })).toEqual({ main: '120.00', upper: '+0.10', lower: '-0.05' })
    expect(formatDimensionText('linear', 120, 'mm', 2, { kind: 'bilateral', upper: 0.05, lower: -0.05 })).toEqual({ main: '120.00 ±0.05' })
  })

  it('fix round 1, finding 1: a general dimension prints its pinned tolerance whenever the table row it shows under says something else', () => {
    const pinned = { kind: 'general', tableKey: '2', templateRevision: '1', value: 0.05 } as const
    // The table still says 0.05 at two decimals: the table carries the meaning.
    expect(formatDimensionText('linear', 12, 'mm', 2, pinned, '', '', 0.05)).toEqual({ main: '12.00' })
    // The table row now says 0.02: the sheet shows what the dimension really holds.
    expect(formatDimensionText('linear', 12, 'mm', 2, pinned, '', '', 0.02)).toEqual({ main: '12.00 ±0.05' })
    // Three decimals shown: that row says 0.01, so again the pin is printed.
    expect(formatDimensionText('linear', 12, 'mm', 3, pinned, '', '', 0.01)).toEqual({ main: '12.000 ±0.050' })
    // A diameter and an angle follow the same rule.
    expect(formatDimensionText('diameter', 8, 'mm', 2, pinned, '', '', 0.1)).toEqual({ main: '⌀8.00 ±0.05' })
    expect(formatDimensionText('angle', 90, 'mm', 1, { kind: 'general', tableKey: 'angle', templateRevision: '1', value: 0.5 }, '', '', 1)).toEqual({ main: '90.0° ±0.5°' })
    expect(formatDimensionText('diameter', 8, 'mm', 2, { kind: 'limits', lower: 7.98, upper: 8.05 })).toEqual({ main: '⌀', upper: '8.05', lower: '7.98' })
    expect(formatDimensionText('radius', 4, 'mm', 1, { kind: 'none' })).toEqual({ main: 'R4.0' })
    expect(formatDimensionText('angle', 90, 'inch', 1, { kind: 'reference' })).toEqual({ main: '(90.0°)' })
    expect(formatDimensionText('linear', 25.4, 'inch', 3, { kind: 'general', tableKey: '3', templateRevision: '1', value: 0.01 }, '', '', 0.01)).toEqual({ main: '1.000' })
    expect(formatDimensionText('linear', 120, 'mm', 2, { kind: 'bilateral', upper: 0.125, lower: -0.05 })).toEqual({ main: '120.00', upper: '+0.125', lower: '-0.050' })
  })

  it('lays the body faces out from a tessellation the way the kernel hands them over', () => {
    const tess = {
      position: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]),
      index: new Uint32Array([0, 1, 2, 0, 1, 3]),
      triFace: new Uint32Array([0, 1]),
      faceIds: ['A', 'B'],
    }
    const faces = bodyFacesFromTess(tess)
    expect([...faces.triangles.keys()]).toEqual(['A', 'B'])
    expect(faces.triangles.get('B')).toEqual([0, 0, 0, 1, 0, 0, 0, 0, 1])
    expect(faces.bboxDiagMm).toBeCloseTo(Math.sqrt(3), 6)
  })
})
