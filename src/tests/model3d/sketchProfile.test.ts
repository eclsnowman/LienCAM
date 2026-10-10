// WO SKC-15, acceptance criterion 4 (profile refusal enumeration) + the profile half of criterion 2.
//
// "Data validity at the accept point: loop extraction validates finite coordinates and closed loops;
//  an open or degenerate sketch refuses profile production BY NAME (the sketch still saves; the
//  feature dialog reports no profile) -- never NaN into the kernel."
//
// Every refusal code is asserted BY NAME. A test that only asserted `ok === false` would pass even
// if the wrong guard fired -- and would still pass after mutation proof (b) deletes the open-loop
// arm, because `no-geometry` would catch the leftovers. So each case pins `refusal.code`.
import { describe, it, expect } from 'vitest'
import { extractSketchProfile, validateSketchForProfile } from '../../components/model3d/workbench/sketchProfile'
import { BASE_PLANE_FRAMES } from '../../components/model3d/workbench/basePlanes'
import { bakeSketch } from '../../lib/sketch/bake'
import { groupIntoBlock } from '../../lib/sketch/blocks'
import type { Sketch, SketchEntity } from '../../lib/sketch/sketcher'

function sketch(entities: SketchEntity[]): Sketch {
  return { id: 'S1', layerId: 'L1', entities, constraints: [], dimensions: [], solveStatus: null }
}

const line = (id: string, ax: number, ay: number, bx: number, by: number, construction = false): SketchEntity => ({
  id, kind: 'line', construction, start: { x: ax, y: ay }, end: { x: bx, y: by },
})

/** A closed 10x10 square: four lines meeting exactly at their corners (the coincident-solved state
 *  chainEntitiesIntoLoops chains by shared endpoints). */
const SQUARE: SketchEntity[] = [
  line('e0', 0, 0, 10, 0),
  line('e1', 10, 0, 10, 10),
  line('e2', 10, 10, 0, 10),
  line('e3', 0, 10, 0, 0),
]

const circle = (id: string, r: number, cx = 0, cy = 0, construction = false): SketchEntity => ({
  id, kind: 'circle', construction, center: { x: cx, y: cy }, radius: r,
})

// SKC-47 ellipse factories -- REAL entity shapes (majorRadius/minorRadius/rotation), not the guessed
// rx/ry the SKC-15 placeholder used.
const ellipse = (
  id: string, majorRadius: number, minorRadius: number, cx = 0, cy = 0, rotation = 0, construction = false,
): SketchEntity => ({ id, kind: 'ellipse', construction, center: { x: cx, y: cy }, majorRadius, minorRadius, rotation })

const ellipticalArc = (
  id: string, majorRadius: number, minorRadius: number, startParam: number, endParam: number,
  cx = 0, cy = 0, rotation = 0, construction = false,
): SketchEntity => ({
  id, kind: 'elliptical-arc', construction,
  center: { x: cx, y: cy }, majorRadius, minorRadius, rotation, startParam, endParam,
})

// The point on an ellipse at eccentric parameter t, in world coords -- used to place a chord line
// whose endpoints coincide EXACTLY with an elliptical arc's endpoints (the chaining contract). Mirrors
// src/lib/sketch/ellipse.ts ellipsePointAt so the fixtures don't depend on importing it.
function ellipsePt(majorRadius: number, minorRadius: number, rotation: number, cx: number, cy: number, t: number): { x: number; y: number } {
  const c = Math.cos(rotation), s = Math.sin(rotation)
  const x = majorRadius * Math.cos(t), y = minorRadius * Math.sin(t)
  return { x: cx + x * c - y * s, y: cy + x * s + y * c }
}

/** Absolute polygon area of a loop of line segments, by the shoelace formula over segment start
 *  points (consecutive `a` vertices trace the closed ring). */
function shoelaceArea(loop: { kind: string }[]): number {
  const pts = loop.map((seg) => (seg as { kind: 'line'; a: [number, number] }).a)
  let area = 0
  for (let i = 0; i < pts.length; i++) {
    const [ax, ay] = pts[i]
    const [bx, by] = pts[(i + 1) % pts.length]
    area += ax * by - bx * ay
  }
  return Math.abs(area) / 2
}

describe('WO SKC-15: validateSketchForProfile refuses BY NAME', () => {
  it('accepts a closed square (non-vacuity: the refusals below mean something)', () => {
    expect(validateSketchForProfile(sketch(SQUARE))).toBeNull()
  })

  it('accepts a bare circle (its own closed loop, needs no chaining)', () => {
    expect(validateSketchForProfile(sketch([circle('c0', 5)]))).toBeNull()
  })

  it('null sketch -> no-geometry', () => {
    expect(validateSketchForProfile(null)?.code).toBe('no-geometry')
  })

  it('empty sketch -> no-geometry', () => {
    expect(validateSketchForProfile(sketch([]))?.code).toBe('no-geometry')
  })

  it('construction-only geometry -> no-geometry (construction never bounds a profile)', () => {
    const all = SQUARE.map((e) => ({ ...e, construction: true }))
    expect(validateSketchForProfile(sketch(all))?.code).toBe('no-geometry')
  })

  it('an OPEN loop (three sides of a square) -> open-loop, naming the failure', () => {
    const refusal = validateSketchForProfile(sketch(SQUARE.slice(0, 3)))
    expect(refusal?.code).toBe('open-loop')
    expect(refusal?.message).toContain('not closed')
  })

  // WO BUG-MODEL-REGION-PICK FLIPPED THIS CASE, deliberately. It used to assert 'open-loop': a
  // single stray spur made chainEntitiesIntoLoops throw on its degree-1 vertex and refused the WHOLE
  // sketch -- exactly the defect Operator reported ("vertex 44.922379,-7.500000 has degree 1") with
  // several perfectly closed regions plainly on screen and nothing pickable. Stray geometry bounds
  // nothing, so it is now IGNORED, and the enclosed square is a profile. The refusal itself is not
  // weakened: "nothing at all is enclosed" still refuses by the same name, proven directly above and
  // below this case.
  it('a stray spur off a closed square is IGNORED -- the enclosed square still profiles', () => {
    expect(validateSketchForProfile(sketch([...SQUARE, line('spur', 10, 0, 20, 0)]))).toBeNull()
  })

  it('geometry that encloses NOTHING (a lone spur, no loop) still refuses open-loop by name', () => {
    const refusal = validateSketchForProfile(sketch([line('spur', 10, 0, 20, 0), line('spur2', 20, 0, 25, 5)]))
    expect(refusal?.code).toBe('open-loop')
    expect(refusal?.message).toContain('not closed')
  })

  it('a NaN coordinate -> non-finite-coordinate, naming the entity, BEFORE any loop chaining', () => {
    const refusal = validateSketchForProfile(sketch([...SQUARE.slice(0, 3), line('bad', 0, 10, NaN, 0)]))
    expect(refusal?.code).toBe('non-finite-coordinate')
    expect(refusal?.entityIds).toEqual(['bad'])
  })

  it('an Infinity coordinate -> non-finite-coordinate', () => {
    expect(validateSketchForProfile(sketch([circle('c0', Number.POSITIVE_INFINITY)]))?.code).toBe('non-finite-coordinate')
  })

  it('a NaN radius is non-finite, NOT "degenerate" (order of the two guards matters)', () => {
    expect(validateSketchForProfile(sketch([circle('c0', NaN)]))?.code).toBe('non-finite-coordinate')
  })

  it('a zero-length line -> degenerate-entity, naming the entity', () => {
    const refusal = validateSketchForProfile(sketch([...SQUARE, line('zero', 3, 3, 3, 3)]))
    expect(refusal?.code).toBe('degenerate-entity')
    expect(refusal?.entityIds).toEqual(['zero'])
  })

  it('a zero-radius circle -> degenerate-entity', () => {
    expect(validateSketchForProfile(sketch([circle('c0', 0)]))?.code).toBe('degenerate-entity')
  })

  it('a zero-sweep arc -> degenerate-entity', () => {
    const arc: SketchEntity = { id: 'a0', kind: 'arc', construction: false, center: { x: 0, y: 0 }, radius: 5, startAngle: 1, endAngle: 1 }
    expect(validateSketchForProfile(sketch([arc]))?.code).toBe('degenerate-entity')
  })

  // THE silent-wrong-body guard. chainEntitiesIntoLoops filters to line|arc and handles circles
  // separately, so it would IGNORE each of these and happily emit a profile from whatever else is
  // present -- extruding a shape the user never drew. (SKC-47 removed ellipse/elliptical-arc from
  // this list -- they are now SUPPORTED, proven in the ellipse describe block below. spline and text
  // remain the genuinely-unsupported kinds this guard exists for.)
  it.each([
    ['spline', { id: 'x', kind: 'spline', construction: false, points: [{ x: 0, y: 0 }, { x: 5, y: 5 }], closed: true } as unknown as SketchEntity],
    ['text', { id: 'x', kind: 'text', construction: false, text: 'A', at: { x: 0, y: 0 }, height: 5, rotation: 0, fontStyle: 'single-line' } as unknown as SketchEntity],
  ])('a non-construction %s is REFUSED, never silently dropped', (_kind, entity) => {
    const refusal = validateSketchForProfile(sketch([...SQUARE, entity]))
    expect(refusal?.code).toBe('unsupported-entity')
    expect(refusal?.entityIds).toEqual(['x'])
  })

  it('a genuinely unsupported kind marked CONSTRUCTION is allowed through (it bounds nothing)', () => {
    const spline = { id: 'x', kind: 'spline', construction: true, points: [{ x: 0, y: 0 }, { x: 5, y: 5 }], closed: true } as unknown as SketchEntity
    expect(validateSketchForProfile(sketch([...SQUARE, spline]))).toBeNull()
  })

  it('a bare point neither blocks nor bounds a profile', () => {
    const point = { id: 'p', kind: 'point', construction: false, at: { x: 2, y: 2 } } as SketchEntity
    expect(validateSketchForProfile(sketch([...SQUARE, point]))).toBeNull()
  })
})

describe('WO SKC-47: ellipse + elliptical-arc profiles are supported (not refused)', () => {
  it('a full ellipse is ACCEPTED (was the unsupported-entity case in SKC-15)', () => {
    expect(validateSketchForProfile(sketch([ellipse('e', 20, 10)]))).toBeNull()
  })

  it('a ROTATED ellipse is accepted (the case the exact kernel edge could not represent)', () => {
    expect(validateSketchForProfile(sketch([ellipse('e', 20, 10, 3, -4, Math.PI / 5)]))).toBeNull()
  })

  it('an ellipse as a hole inside a square is accepted (mixed boundary of a region)', () => {
    expect(validateSketchForProfile(sketch([...SQUARE, ellipse('hole', 3, 1.5, 5, 5)]))).toBeNull()
  })

  it('a degenerate ellipse (zero minor axis) -> degenerate-entity, naming the entity', () => {
    const refusal = validateSketchForProfile(sketch([ellipse('flat', 5, 0)]))
    expect(refusal?.code).toBe('degenerate-entity')
    expect(refusal?.entityIds).toEqual(['flat'])
  })

  it('a NaN ellipse radius is non-finite, NOT degenerate (guard order holds for ellipses too)', () => {
    expect(validateSketchForProfile(sketch([ellipse('nan', NaN, 5)]))?.code).toBe('non-finite-coordinate')
  })

  it('a construction-only ellipse -> no-geometry (construction bounds nothing)', () => {
    expect(validateSketchForProfile(sketch([ellipse('e', 20, 10, 0, 0, 0, /* construction */ true)]))?.code).toBe('no-geometry')
  })

  it('a construction ellipse alongside a real square profiles the SQUARE (ellipse excluded)', () => {
    expect(validateSketchForProfile(sketch([...SQUARE, ellipse('e', 3, 2, 5, 5, 0, /* construction */ true)]))).toBeNull()
  })

  it('a lone elliptical arc (open) refuses BY NAME -- an arc alone is not a closed region', () => {
    // Half ellipse (startParam 0 -> PI): an open chain, degree-1 endpoints.
    const refusal = validateSketchForProfile(sketch([ellipticalArc('ea', 20, 10, 0, Math.PI)]))
    expect(refusal?.code).toBe('open-loop')
  })

  it('a degenerate elliptical arc (zero sweep) -> degenerate-entity', () => {
    expect(validateSketchForProfile(sketch([ellipticalArc('ea', 20, 10, 1, 1)]))?.code).toBe('degenerate-entity')
  })

  it('an elliptical arc closed by a chord line into a D-shape is ACCEPTED (partial-boundary region)', () => {
    // Upper half of an ellipse (t: 0 -> PI) plus the diameter chord from (major,0) back to (-major,0).
    const a = 20, b = 10
    const start = ellipsePt(a, b, 0, 0, 0, 0)      // (+20, 0)
    const end = ellipsePt(a, b, 0, 0, 0, Math.PI)  // (-20, 0)
    const arc = ellipticalArc('ea', a, b, 0, Math.PI)
    const chord = line('chord', end.x, end.y, start.x, start.y) // closes the loop end->start
    expect(validateSketchForProfile(sketch([arc, chord]))).toBeNull()
  })
})

describe('WO SKC-47: extractSketchProfile builds a real ProfileRegion from an ellipse', () => {
  it('a full ellipse extracts one closed loop of line segments enclosing ~pi*a*b', async () => {
    const a = 20, b = 10
    const result = await extractSketchProfile(sketch([ellipse('e', a, b)]), BASE_PLANE_FRAMES.xy, 'SKE1')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.regions[0].loops).toHaveLength(1)
    const loop = result.regions[0].loops[0]
    // Tessellated: every segment is a line (no arc/ellipse primitive reaches the frozen contract).
    expect(loop.every((seg) => seg.kind === 'line')).toBe(true)
    // 0.3mm chord budget over a ~48mm-perimeter ellipse -> well above the 16-segment floor.
    expect(loop.length).toBeGreaterThanOrEqual(16)
    // The polygon the kernel will see encloses the analytic ellipse area within tessellation error.
    const area = shoelaceArea(loop)
    const analytic = Math.PI * a * b
    expect(Math.abs(area - analytic) / analytic).toBeLessThan(0.01)
    // Non-vacuity: the area reflects BOTH axes, not major^2 (a circle of r=major would be far larger).
    expect(area).toBeLessThan(Math.PI * a * a * 0.9)
  })

  it('a square with an elliptical hole yields an outer loop plus a hole loop', async () => {
    const result = await extractSketchProfile(sketch([...SQUARE, ellipse('hole', 3, 1.5, 5, 5)]), BASE_PLANE_FRAMES.xy, 'SKE2')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.regions[0].loops.length).toBe(2)
  })

  it('a construction ellipse is excluded -- the square profile is unchanged', async () => {
    const result = await extractSketchProfile(
      sketch([...SQUARE, ellipse('e', 3, 2, 5, 5, 0, /* construction */ true)]), BASE_PLANE_FRAMES.xy, 'SKE3',
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.regions[0].loops).toHaveLength(1)
    expect(result.regions[0].loops[0]).toHaveLength(4)
  })
})

describe('WO SKC-47-R1: emitted srcId is always an ORIGINAL sketch-entity id (audit MAJOR 1)', () => {
  it('a full ellipse: every emitted segment srcId is the ellipse entity id, never a synthetic ~ell tessellation id', async () => {
    const result = await extractSketchProfile(sketch([ellipse('e', 20, 10)]), BASE_PLANE_FRAMES.xy, 'SKL1')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const allSrcIds = result.regions[0].loops.flat().map((seg) => seg.srcId)
    // Non-vacuity: the ellipse really did tessellate into many segments, not collapse to one.
    expect(allSrcIds.length).toBeGreaterThanOrEqual(16)
    // Over EVERY emitted segment, not a sample.
    expect(allSrcIds.every((id) => id === 'e')).toBe(true)
  })

  it('an elliptical-arc + chord D-shape region: every segment srcId is one of the TWO original entity ids', async () => {
    const a = 20, b = 10
    const start = ellipsePt(a, b, 0, 0, 0, 0)
    const end = ellipsePt(a, b, 0, 0, 0, Math.PI)
    const arc = ellipticalArc('ea', a, b, 0, Math.PI)
    const chord = line('chord', end.x, end.y, start.x, start.y)
    const result = await extractSketchProfile(sketch([arc, chord]), BASE_PLANE_FRAMES.xy, 'SKL2')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const allSrcIds = result.regions[0].loops.flat().map((seg) => seg.srcId)
    // Over EVERY emitted segment, not a sample: only the two real entity ids ever appear -- no
    // `ea~ell<i>` synthetic tessellation id leaks past the kernel boundary.
    expect(allSrcIds.every((id) => id === 'ea' || id === 'chord')).toBe(true)
    // Non-vacuity: the tessellated arc produced multiple segments (not degenerate to one) and the
    // chord contributed exactly its own single segment.
    expect(allSrcIds.filter((id) => id === 'ea').length).toBeGreaterThan(1)
    expect(allSrcIds.filter((id) => id === 'chord').length).toBe(1)
  })

  it('a square with an elliptical hole: hole-loop srcIds are the hole entity id, outer loop srcIds are the square edges', async () => {
    const result = await extractSketchProfile(sketch([...SQUARE, ellipse('hole', 3, 1.5, 5, 5)]), BASE_PLANE_FRAMES.xy, 'SKL3')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const [outer, hole] = result.regions[0].loops
    expect(outer.map((seg) => seg.srcId).sort()).toEqual(['e0', 'e1', 'e2', 'e3'])
    expect(hole.every((seg) => seg.srcId === 'hole')).toBe(true)
  })
})

describe('WO SKC-47-R1: CAM bake honesty for partial-ellipse regions (audit MAJOR 2)', () => {
  it('a full ellipse: CAM bake produces ONE closed loop -- parity with Part-Studio holds', () => {
    const { loops } = bakeSketch(sketch([ellipse('e', 20, 10)]))
    expect(loops).toHaveLength(1)
    expect(loops[0].closed).toBe(true)
    expect(loops[0].type).toBe('contour')
  })

  it('an elliptical-arc + chord D-shape region: CAM bake now CHAINS them into ONE closed loop ' +
     '-- full Part-Studio parity (SKC-48)', () => {
    // The SAME entities the "elliptical arc closed by a chord line into a D-shape is ACCEPTED" case
    // above builds into ONE closed Part-Studio profile. SKC-47 left the CAM side at parity's edge:
    // bake.ts tessellated the elliptical arc as its own standalone open polyline and never chained it
    // with the neighbouring chord, so this baked to TWO open loops (the interim state the R2
    // closed-loop-consumer census refused by name). SKC-48 closed the gap: extractChains now expands
    // each elliptical arc into synthetic line Edges from the SHARED sampler and threads them through
    // the same UnionFind + walk chainer, so the arc+chord D-shape bakes to ONE closed loop -- exactly
    // as the Part-Studio ACCEPTED case does. This is the flip the block's own SKC-47 comment booked.
    const a = 20, b = 10
    const start = ellipsePt(a, b, 0, 0, 0, 0)
    const end = ellipsePt(a, b, 0, 0, 0, Math.PI)
    const arc = ellipticalArc('ea', a, b, 0, Math.PI)
    const chord = line('chord', end.x, end.y, start.x, start.y)

    const { loops } = bakeSketch(sketch([arc, chord]))
    expect(loops).toHaveLength(1)
    // A real, closed, cuttable region -- no longer two open polylines masquerading as a boundary.
    expect(loops[0].closed).toBe(true)
    expect(loops[0].type).toBe('contour')
    expect(loops.filter((l) => l.closed === false).length).toBe(0)
    // The refusal-classified CAM consumers (Contour, Pocket, Chamfer, Drill, Thread Mill, Face,
    // Adaptive Clearing) still refuse GENUINELY-open loops by name (that behavior is permanent and is
    // now driven by a LONE elliptical arc in src/tests/cam/loop-consumer-census.test.ts); this D-shape
    // is proven CUTTABLE there (Contour + Pocket emit feed moves), the mirror image of that refusal.
  })
})

describe('WO SKC-15: extractSketchProfile emits a real ProfileRegion on each base plane', () => {
  it.each([['xy'], ['xz'], ['yz']] as const)('a closed square on the %s base plane extracts a finite profile', async (plane) => {
    const result = await extractSketchProfile(sketch(SQUARE), BASE_PLANE_FRAMES[plane], 'SK1')
    expect(result.ok, `plane ${plane} must produce a profile`).toBe(true)
    if (!result.ok) return
    expect(result.regions[0].sketchId).toBe('SK1')
    expect(result.regions[0].plane).toEqual(BASE_PLANE_FRAMES[plane])
    expect(result.regions[0].loops).toHaveLength(1)
    expect(result.regions[0].loops[0]).toHaveLength(4)
  })

  it('a square with a concentric circular hole yields an outer loop plus a hole loop', async () => {
    const result = await extractSketchProfile(sketch([...SQUARE, circle('hole', 2, 5, 5)]), BASE_PLANE_FRAMES.xy, 'SK2')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.regions[0].loops.length).toBe(2)
  })

  it('HOTEL-T4 keeps every disjoint closed region and exposes no legacy profile field', async () => {
    const result = await extractSketchProfile(
      sketch([circle('circle-a', 2, 0, 0), circle('circle-b', 3, 20, 0)]),
      BASE_PLANE_FRAMES.xy,
      'SK-MASTER',
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.regions).toHaveLength(2)
    expect(result).not.toHaveProperty('profile')
    expect(result.regions.map((region) => region.loops[0][0].srcId)).toEqual([
      'circle-a',
      'circle-b',
    ])
  })

  // WO SKC-16 (criterion 2, the profile half): a rectangle + a CONSTRUCTION diagonal extracts the
  // RECTANGLE profile -- the diagonal is excluded, exactly as on the CAM route. The line-level
  // exclusion here is enforced by the SHARED FROZEN engine (src/sketch3d/regions.ts:132 filters
  // `!e.construction` inside chainEntitiesIntoLoops), which sketchProfile.ts's own `live` filters
  // back up (defense in depth) -- so this LINE case is not the mutation target for THIS owned file
  // (mutating sketchProfile.ts's line filter alone leaves regions.ts still excluding). The owned
  // construction-exclusion mutation target is the VALIDATION-layer filter proven below by
  // "the same unsupported kind marked CONSTRUCTION is allowed through". This case proves the
  // observable criterion-2 behavior end to end; its end-to-end non-vacuity (a real diagonal WOULD
  // break the profile) is proven on the real kernel by workbenchKernelVolume.test.tsx (a broken
  // exclusion times out with no body).
  it('a rectangle plus a CONSTRUCTION diagonal extracts the rectangle profile (diagonal excluded)', async () => {
    const diagonal = line('diag', 0, 0, 10, 10, /* construction */ true)
    const result = await extractSketchProfile(sketch([...SQUARE, diagonal]), BASE_PLANE_FRAMES.xy, 'SK5')
    expect(result.ok, 'construction diagonal must not break the rectangle profile').toBe(true)
    if (!result.ok) return
    // ONE region, the RECTANGLE's own four segments. FAILS-IF construction exclusion is removed: a
    // real diagonal splits the square into TWO enclosed triangles (proven directly in the
    // arrangement block below), so this would read 2 regions of 3 segments each.
    expect(result.regions).toHaveLength(1)
    expect(result.regions[0].loops).toHaveLength(1)
    expect(result.regions[0].loops[0]).toHaveLength(4)
  })

  it('an open sketch refuses BY NAME and produces no profile (the sketch itself still saves)', async () => {
    const result = await extractSketchProfile(sketch(SQUARE.slice(0, 3)), BASE_PLANE_FRAMES.xy, 'SK3')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.refusal.code).toBe('open-loop')
  })

  it('never emits a non-finite coordinate into a ProfileRegion', async () => {
    const result = await extractSketchProfile(sketch([...SQUARE.slice(0, 3), line('bad', 0, 10, NaN, 0)]), BASE_PLANE_FRAMES.xy, 'SK4')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.refusal.code).toBe('non-finite-coordinate')
  })
})

// SKC-BLOCKS Stage 3: a sketch may hold a rigid BLOCK (a locked import, or a
// hand-grouped cluster in the workbench). Profile extraction must see through
// the block to its member geometry -- otherwise a promoted DXF (now a locked
// block) or a grouped block would be refused as 'unsupported-entity' and could
// never extrude/revolve. The block bakes to the SAME loops, so the extruded
// solid and the CAM baked profile of one block agree.
describe('SKC-BLOCKS Stage 3: block-aware profile extraction', () => {
  /** The SQUARE lines collapsed into ONE rigid block (members in local frame). */
  function blockSquareSketch(): Sketch {
    const grouped = groupIntoBlock(sketch(SQUARE), SQUARE.map((e) => e.id), (() => { let n = 0; return () => `blk-${++n}` })())
    if (!grouped.ok) throw new Error('fixture: grouping the square failed')
    return grouped.sketch
  }

  it('validateSketchForProfile accepts a block whose members form a closed loop (no unsupported-entity refusal)', () => {
    expect(validateSketchForProfile(blockSquareSketch())).toBeNull()
  })

  it('extractSketchProfile produces the block members\' closed profile (one loop, four segments)', async () => {
    const result = await extractSketchProfile(blockSquareSketch(), BASE_PLANE_FRAMES.xy, 'SK-BLK')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.regions[0].loops).toHaveLength(1)
    expect(result.regions[0].loops[0]).toHaveLength(4)
    // srcIds are the ORIGINAL member entity ids, never the opaque block id.
    const srcIds = result.regions[0].loops[0].map((seg) => seg.srcId).sort()
    expect(srcIds).toEqual(['e0', 'e1', 'e2', 'e3'])
  })
})

// WO BUG-MODEL-REGION-PICK (Operator, 2026-08-05 screenshot): "Pick a profile to extrude fails (and I
// don't want profiles), I want enclosed regions. It might be made up of several profiles."
//
// The unit under test is the PLANAR ARRANGEMENT the workbench accept point now delegates to
// (workbench/sketchRegionArrangement.ts). Every case here refused wholesale before -- the previous
// engine threw on any vertex of degree != 2, so a spur, an abutment, or a crossing killed the entire
// sketch's region list and therefore every viewport pick candidate on it.
//
// Regions are asserted by their srcId LINEAGE, because that lineage is exactly what
// regionSelector.ts turns into the persisted selector; a region whose lineage spans two source
// profiles IS the "region made up of several profiles" the WO is about.
describe('WO BUG-MODEL-REGION-PICK: enclosed regions from a planar arrangement', () => {
  /** Four lines closing an axis-aligned rectangle, ids prefixed so two rectangles stay distinct. */
  const rect = (prefix: string, x0: number, y0: number, x1: number, y1: number): SketchEntity[] => ([
    line(`${prefix}0`, x0, y0, x1, y0),
    line(`${prefix}1`, x1, y0, x1, y1),
    line(`${prefix}2`, x1, y1, x0, y1),
    line(`${prefix}3`, x0, y1, x0, y0),
  ])

  /** Every region's boundary lineage: sorted unique srcIds of its OUTER loop. */
  function lineages(regions: readonly { loops: Array<Array<{ srcId: string }>> }[]): string[][] {
    return regions.map((region) => [...new Set(region.loops[0].map((seg) => seg.srcId))].sort())
  }

  it('a stray spur is pruned: the enclosed square is still exactly one 4-segment region', async () => {
    const result = await extractSketchProfile(
      sketch([...SQUARE, line('spur', 10, 0, 20, 0)]), BASE_PLANE_FRAMES.xy, 'SK-SPUR',
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.regions).toHaveLength(1)
    expect(result.regions[0].loops).toHaveLength(1)
    expect(result.regions[0].loops[0]).toHaveLength(4)
    // The spur contributes NO segment -- it is ignored, not absorbed into the boundary.
    expect(lineages(result.regions)).toEqual([['e0', 'e1', 'e2', 'e3']])
  })

  it('a real diagonal splits the square into TWO enclosed regions, each sharing the diagonal', async () => {
    const result = await extractSketchProfile(
      sketch([...SQUARE, line('diag', 0, 0, 10, 10)]), BASE_PLANE_FRAMES.xy, 'SK-DIAG',
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(lineages(result.regions)).toEqual([['diag', 'e0', 'e1'], ['diag', 'e2', 'e3']])
    // Each triangle really is half the square, so neither is the whole profile in disguise.
    for (const region of result.regions) expect(shoelaceArea(region.loops[0])).toBeCloseTo(50, 6)
  })

  it('TWO CROSSING rectangles: the overlap is its own region, bounded by BOTH profiles edges', async () => {
    // a = [0,10]x[0,10], b = [6,16]x[4,14]; they cross with no shared endpoint anywhere, so the old
    // engine chained them into two whole loops and the lens between them simply did not exist.
    const result = await extractSketchProfile(
      sketch([...rect('a', 0, 0, 10, 10), ...rect('b', 6, 4, 16, 14)]), BASE_PLANE_FRAMES.xy, 'SK-CROSS',
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.regions).toHaveLength(3)

    const overlap = result.regions.find((region) => Math.abs(shoelaceArea(region.loops[0]) - 24) < 1e-6)
    expect(overlap, 'the 4x6 overlap must be a region of its own').toBeDefined()
    const overlapLineage = [...new Set(overlap!.loops[0].map((seg) => seg.srcId))].sort()
    // THE acceptance: one region, boundary edges owned by two different source profiles.
    expect(overlapLineage.some((id) => id.startsWith('a'))).toBe(true)
    expect(overlapLineage.some((id) => id.startsWith('b'))).toBe(true)
    expect(overlapLineage).toEqual(['a1', 'a2', 'b0', 'b3'])

    // The two L-shaped remainders are regions too, and the three tile the union exactly.
    const total = result.regions.reduce((sum, region) => sum + shoelaceArea(region.loops[0]), 0)
    expect(total).toBeCloseTo(100 + 100 - 24, 6)
  })

  it('TWO ABUTTING rectangles (a shared edge, degree-3 corners) yield both enclosed regions', async () => {
    const shared = line('shared', 10, 0, 10, 10)
    const left = [line('l0', 0, 0, 10, 0), shared, line('l2', 10, 10, 0, 10), line('l3', 0, 10, 0, 0)]
    const right = [line('r0', 10, 0, 20, 0), line('r1', 20, 0, 20, 10), line('r2', 20, 10, 10, 10)]
    const result = await extractSketchProfile(sketch([...left, ...right]), BASE_PLANE_FRAMES.xy, 'SK-ABUT')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(lineages(result.regions)).toEqual([
      ['l0', 'l2', 'l3', 'shared'],
      ['r0', 'r1', 'r2', 'shared'],
    ])
  })

  it('a circle crossing a rectangle edge yields the bitten rectangle plus BOTH half-disks', async () => {
    const result = await extractSketchProfile(
      sketch([...SQUARE, circle('c', 3, 10, 5)]), BASE_PLANE_FRAMES.xy, 'SK-BITE',
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.regions).toHaveLength(3)
    // Two of the three share an identical boundary lineage {c, e1} -- the case that makes
    // ProfileSelector.ordinal necessary (regionSelector.test.ts pins the resolution rules).
    const halves = result.regions.filter((region) =>
      [...new Set(region.loops[0].map((seg) => seg.srcId))].sort().join() === 'c,e1')
    expect(halves).toHaveLength(2)
  })

  it('hole containment and island-in-hole are unchanged by the arrangement', async () => {
    const holed = await extractSketchProfile(
      sketch([...SQUARE, circle('hole', 2, 5, 5)]), BASE_PLANE_FRAMES.xy, 'SK-HOLE',
    )
    expect(holed.ok).toBe(true)
    if (!holed.ok) return
    // ONE region: outer square + the circle as a HOLE, never the disk offered as a second region.
    expect(holed.regions).toHaveLength(1)
    expect(holed.regions[0].loops).toHaveLength(2)
    expect(holed.regions[0].loops[1].every((seg) => seg.srcId === 'hole')).toBe(true)

    const island = await extractSketchProfile(
      sketch([...SQUARE, circle('hole', 3, 5, 5), circle('island', 1, 5, 5)]), BASE_PLANE_FRAMES.xy, 'SK-ISLE',
    )
    expect(island.ok).toBe(true)
    if (!island.ok) return
    // Depth 2 starts its OWN region, exactly as before.
    expect(island.regions).toHaveLength(2)
    expect(lineages(island.regions)).toEqual([['e0', 'e1', 'e2', 'e3'], ['island']])
  })

  it('is order-independent: shuffling the entity array changes nothing', async () => {
    const entities = [...rect('a', 0, 0, 10, 10), ...rect('b', 6, 4, 16, 14)]
    const forward = await extractSketchProfile(sketch(entities), BASE_PLANE_FRAMES.xy, 'SK-DET')
    const reversed = await extractSketchProfile(sketch([...entities].reverse()), BASE_PLANE_FRAMES.xy, 'SK-DET')
    expect(forward.ok && reversed.ok).toBe(true)
    if (!forward.ok || !reversed.ok) return
    expect(reversed.regions).toEqual(forward.regions)
  })
})
