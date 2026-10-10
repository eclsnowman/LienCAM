// Tool overlay previews (interaction framework rework, commit 1: trim).
//
// Preview-equals-commit invariant: the removal span the hover highlight
// shows is EXACTLY the span the click removes — span endpoints equal the
// kept pieces' new cut endpoints. Swipe highlights accumulate along the
// path and match what releasing the drag commits.

import { describe, it, expect } from 'vitest'
import { toolOverlay, entityOutline } from '../../lib/sketch/tools/toolOverlay'
import { toolPreview, toolClick, type ToolState } from '../../lib/sketch/tools/toolMachine'
import { applyOrthoLock } from '../../lib/sketch/orthoLock'
import { mirrorEntities } from '../../lib/sketch/tools/mirrorTool'
import {
  trimAtPoint, trimSwipe, trimSwipeHighlights, trimHighlight,
  type SketchDoc,
} from '../../lib/sketch/tools/trimTool'
import type { SketchEntity, Vec2 } from '../../lib/sketch/types'

function idFactory(prefix = 'n'): () => string {
  let n = 0
  return () => `${prefix}${n++}`
}

function doc(entities: SketchEntity[]): SketchDoc {
  return { entities, constraints: [], dimensions: [] }
}

const TOL = 0.5

// A horizontal line crossed by two verticals at x=3 and x=7.
function crossedLineDoc(): SketchDoc {
  return doc([
    { id: 'target', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: 10, y: 0 } },
    { id: 'v1', kind: 'line', construction: false, start: { x: 3, y: -5 }, end: { x: 3, y: 5 } },
    { id: 'v2', kind: 'line', construction: false, start: { x: 7, y: -5 }, end: { x: 7, y: 5 } },
  ])
}

describe('trim hover highlight', () => {
  it('highlights exactly the span between the bounding cuts', () => {
    const d = crossedLineDoc()
    const spans = trimHighlight(d, { x: 5, y: 0 }, TOL)!
    expect(spans).toHaveLength(1)
    expect(spans[0][0]).toEqual({ x: 3, y: 0 })
    expect(spans[0][spans[0].length - 1]).toEqual({ x: 7, y: 0 })
  })

  it('preview-equals-commit: span ends match the kept pieces after the click', () => {
    const d = crossedLineDoc()
    const spans = trimHighlight(d, { x: 5, y: 0 }, TOL)!
    const r = trimAtPoint(d, { x: 5, y: 0 }, TOL, idFactory())
    const lines = r.transform!.entities.filter(
      (e): e is Extract<SketchEntity, { kind: 'line' }> =>
        e.kind === 'line' && (e.id === 'target' || e.id.startsWith('n')),
    )
    // Piece A keeps the original id and ends at the span start; piece B
    // starts at the span end.
    const a = lines.find((e) => e.id === 'target')!
    const b = lines.find((e) => e.id !== 'target')!
    expect(a.end).toEqual(spans[0][0])
    expect(b.start).toEqual(spans[0][spans[0].length - 1])
  })

  it('no intersections: the whole entity highlights (it would be deleted)', () => {
    const d = doc([
      { id: 'lonely', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: 4, y: 0 } },
    ])
    const spans = trimHighlight(d, { x: 2, y: 0 }, TOL)!
    expect(spans[0][0]).toEqual({ x: 0, y: 0 })
    expect(spans[0][spans[0].length - 1]).toEqual({ x: 4, y: 0 })
    // ... and the click indeed deletes the whole entity.
    const r = trimAtPoint(d, { x: 2, y: 0 }, TOL, idFactory())
    expect(r.transform!.entities).toHaveLength(0)
  })

  it('circle with two cuts: removal arc is the complement of the kept arc', () => {
    const d = doc([
      { id: 'c', kind: 'circle', construction: false, center: { x: 0, y: 0 }, radius: 5 },
      { id: 'vx', kind: 'line', construction: false, start: { x: 0, y: -10 }, end: { x: 0, y: 10 } },
    ])
    // Click the right side (angle 0): removed span runs between the two
    // vertical-line cuts (angles pi/2 and 3pi/2) through angle 0.
    const spans = trimHighlight(d, { x: 5, y: 0 }, TOL)!
    expect(spans).toHaveLength(1)
    const span = spans[0]
    // Every removal point sits on the circle, on the right half.
    for (const p of span) {
      expect(Math.hypot(p.x, p.y)).toBeCloseTo(5, 9)
    }
    const first = span[0]
    const last = span[span.length - 1]
    const r = trimAtPoint(d, { x: 5, y: 0 }, TOL, idFactory())
    const arc = r.transform!.entities.find((e) => e.id === 'c')!
    expect(arc.kind).toBe('arc')
    if (arc.kind !== 'arc') return
    // Removal runs CCW lo -> hi; the kept arc runs CCW hi -> lo. So the
    // removal's first point is the kept END, its last the kept START.
    const at = (a: number): Vec2 => ({ x: 5 * Math.cos(a), y: 5 * Math.sin(a) })
    expect(first.x).toBeCloseTo(at(arc.endAngle).x, 9)
    expect(first.y).toBeCloseTo(at(arc.endAngle).y, 9)
    expect(last.x).toBeCloseTo(at(arc.startAngle).x, 9)
    expect(last.y).toBeCloseTo(at(arc.startAngle).y, 9)
  })

  it('empty hover (nothing under the cursor) shows nothing', () => {
    expect(trimHighlight(crossedLineDoc(), { x: 50, y: 50 }, TOL)).toBeNull()
  })
})

describe('trim swipe highlights', () => {
  it('accumulates one span per crossing and matches the committed swipe', () => {
    // Two horizontal rails crossed by verticals; swipe down through both.
    const d = doc([
      { id: 'h1', kind: 'line', construction: false, start: { x: 0, y: 2 }, end: { x: 10, y: 2 } },
      { id: 'h2', kind: 'line', construction: false, start: { x: 0, y: -2 }, end: { x: 10, y: -2 } },
      { id: 'v1', kind: 'line', construction: false, start: { x: 3, y: -5 }, end: { x: 3, y: 5 } },
      { id: 'v2', kind: 'line', construction: false, start: { x: 7, y: -5 }, end: { x: 7, y: 5 } },
    ])
    const path: Vec2[] = [{ x: 5, y: 4 }, { x: 5, y: -4 }]
    const spans = trimSwipeHighlights(d, path)
    expect(spans).toHaveLength(2)
    // Each span runs between the two verticals on its rail.
    for (const span of spans) {
      const xs = [span[0].x, span[span.length - 1].x].sort((a, b) => a - b)
      expect(xs[0]).toBeCloseTo(3, 9)
      expect(xs[1]).toBeCloseTo(7, 9)
    }
    // Releasing the drag commits exactly those two trims.
    const r = trimSwipe(d, path, idFactory())
    expect(r.transform).not.toBeNull()
    const mids = r.transform!.entities.filter(
      (e) => e.kind === 'line' && e.start.x < 6.99 && e.end.x > 3.01
        && Math.abs(e.start.y) === 2,
    )
    expect(mids).toHaveLength(0) // both middle spans are gone
  })

  it('empty path or no crossings highlights nothing', () => {
    const d = crossedLineDoc()
    expect(trimSwipeHighlights(d, [{ x: 50, y: 50 }, { x: 60, y: 60 }])).toHaveLength(0)
  })
})

describe('toolOverlay dispatch', () => {
  const ents = crossedLineDoc().entities

  it('trim armed: hover over a curve returns the removal channel', () => {
    const o = toolOverlay(
      { tool: 'trim', chain: null }, { x: 5, y: 0 }, TOL, { entities: ents },
    )!
    expect(o.removal).toHaveLength(1)
    expect(o.ghosts).toBeUndefined()
  })

  it('trim armed: empty hover returns null', () => {
    expect(toolOverlay(
      { tool: 'trim', chain: null }, { x: 50, y: 50 }, TOL, { entities: ents },
    )).toBeNull()
  })

  it('extend with a picked entity: ghost channel toward the boundary', () => {
    const o = toolOverlay(
      { tool: 'extend', chain: { kind: 'extend', targetId: 'target' } },
      { x: 11, y: 0 }, TOL, { entities: ents },
    )
    // 'target' (0..10) has no boundary beyond x=10... v2 ends at x=7;
    // nothing beyond the end -> no ghost. Use a cursor before v2's cut
    // side instead: extend start side has nothing either, so expect null
    // here and a real ghost on a reachable layout below.
    expect(o).toBeNull()
    const reachable: SketchEntity[] = [
      { id: 't2', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: 2, y: 0 } },
      { id: 'wall', kind: 'line', construction: false, start: { x: 6, y: -5 }, end: { x: 6, y: 5 } },
    ]
    const o2 = toolOverlay(
      { tool: 'extend', chain: { kind: 'extend', targetId: 't2' } },
      { x: 4, y: 0 }, TOL, { entities: reachable },
    )!
    expect(o2.ghosts).toHaveLength(1)
    expect(o2.ghosts![0][0]).toEqual({ x: 2, y: 0 })
    expect(o2.ghosts![0][1]).toEqual({ x: 6, y: 0 })
  })

  it('other tools (today): no overlay', () => {
    expect(toolOverlay(
      { tool: 'line', chain: null }, { x: 5, y: 0 }, TOL, { entities: ents },
    )).toBeNull()
  })

  it('mirror: hovering the candidate axis ghosts the mirrored copies', () => {
    const scene: SketchEntity[] = [
      { id: 'c', kind: 'circle', construction: false, center: { x: 5, y: 5 }, radius: 2 },
      { id: 'axis', kind: 'line', construction: true, start: { x: 0, y: 0 }, end: { x: 10, y: 0 } },
    ]
    const chain = { kind: 'mirror' as const, ids: ['c'] }
    // Hover the construction axis: ghost of the mirrored circle.
    const o = toolOverlay(
      { tool: 'mirror', chain }, { x: 5, y: 0 }, TOL, { entities: scene },
    )!
    expect(o.ghosts).toHaveLength(1)
    // Preview-equals-commit: every ghost point sits on the circle the
    // click would create (center (5,-5), R2).
    const committed = mirrorEntities(scene, ['c'], 'axis', () => 'm1')
    expect(typeof committed).not.toBe('string')
    if (typeof committed === 'string') return
    const mc = committed.entities[0]
    expect(mc.kind).toBe('circle')
    if (mc.kind !== 'circle') return
    for (const p of o.ghosts![0]) {
      expect(Math.hypot(p.x - mc.center.x, p.y - mc.center.y)).toBeCloseTo(mc.radius, 9)
    }
    // Hovering empty space (or a non-axis) shows nothing.
    expect(toolOverlay(
      { tool: 'mirror', chain }, { x: 50, y: 50 }, TOL, { entities: scene },
    )).toBeNull()
  })

  it('patterns: confirmed chains ghost the instances at the live count', () => {
    const scene: SketchEntity[] = [
      { id: 'c', kind: 'circle', construction: false, center: { x: 10, y: 0 }, radius: 1 },
    ]
    const lin = toolOverlay(
      {
        tool: 'pattern-linear',
        chain: {
          kind: 'linpat', ids: ['c'], confirmed: true,
          anchor: { x: 0, y: 0 }, vector: null,
        },
      },
      { x: 5, y: 0 }, TOL,
      { entities: scene, linearPatternCount: 3 },
    )!
    expect(lin.ghosts).toHaveLength(2) // count 3 = 2 ghost copies
    // Circular: ghost ring about the CURSOR before the center locks.
    const circ = toolOverlay(
      {
        tool: 'pattern-circular',
        chain: { kind: 'circpat', ids: ['c'], confirmed: true, center: null },
      },
      { x: 0, y: 0 }, TOL,
      { entities: scene, circularPatternCount: 4, circularPatternStepRad: Math.PI / 2 },
    )!
    expect(circ.ghosts).toHaveLength(3)
    // Unconfirmed set: nothing ghosts yet.
    expect(toolOverlay(
      {
        tool: 'pattern-circular',
        chain: { kind: 'circpat', ids: ['c'], confirmed: false, center: null },
      },
      { x: 0, y: 0 }, TOL, { entities: scene, circularPatternCount: 4 },
    )).toBeNull()
  })

  // ---- smart-dimension angle arc preview (angle-dim repro fix) ----
  describe('smart-dimension angle arc preview', () => {
    // Two non-parallel lines meeting at the origin: A along +x, B at 45deg.
    const lineA: SketchEntity = {
      id: 'A', kind: 'line', construction: false,
      start: { x: 0, y: 0 }, end: { x: 10, y: 0 },
    }
    const lineB: SketchEntity = {
      id: 'B', kind: 'line', construction: false,
      start: { x: 0, y: 0 }, end: { x: 10, y: 10 },
    }

    it('draws an arc + two extension lines for two picked lines', () => {
      const ov = toolOverlay(
        { tool: 'smart-dimension', chain: { kind: 'dim', operandIds: ['A', 'B'] } },
        { x: 5, y: 2 }, TOL, { entities: [lineA, lineB] },
      )!
      expect(ov.dimGuides).toBeDefined()
      // [arc, extensionA, extensionB]
      expect(ov.dimGuides!).toHaveLength(3)
      expect(ov.dimGuides![0].length).toBeGreaterThan(10) // the tessellated arc
      expect(ov.dimGuides![1]).toHaveLength(2)            // extension line A
      expect(ov.dimGuides![2]).toHaveLength(2)            // extension line B
    })

    it('keeps the raw-cursor angle sector while bounding a far initial arc radius', () => {
      const angle = (112 * Math.PI) / 180 // I2: the obtuse sector
      const nearCursor = { x: 3 * Math.cos(angle), y: 3 * Math.sin(angle) }
      const farCursor = { x: 30 * Math.cos(angle), y: 30 * Math.sin(angle) }
      const state: ToolState = {
        tool: 'smart-dimension',
        chain: { kind: 'dim', operandIds: ['A', 'B'] },
      }
      const near = toolOverlay(
        state, nearCursor, TOL, { entities: [lineA, lineB] },
      )!.dimGuides![0]
      const far = toolOverlay(
        state, farCursor, TOL, { entities: [lineA, lineB] },
      )!.dimGuides![0]
      const r = (pt: Vec2) => Math.hypot(pt.x, pt.y) // intersection is origin
      const cap = 0.35 * Math.hypot(10, 10) // longer selected operand span

      expect(r(near[0])).toBeCloseTo(3, 9)
      expect(r(far[0])).toBeCloseTo(cap, 9)
      // Both previews start on B's 45-deg ray, proving the far raw cursor
      // still chose I2 even though only its displayed radius was clamped.
      expect(Math.atan2(near[0].y, near[0].x)).toBeCloseTo(Math.PI / 4, 9)
      expect(Math.atan2(far[0].y, far[0].x)).toBeCloseTo(Math.PI / 4, 9)

      const committed = toolClick(
        state, farCursor, TOL, idFactory('dim'), { entities: [lineA, lineB] },
      ).commit?.dimensions?.[0]
      expect(committed?.kind).toBe('angle')
      expect(committed?.labelAnchor).toBeDefined()
      expect(r(committed!.labelAnchor!)).toBeCloseTo(cap, 9)
    })

    it('a single picked line previews its length witness (live drag-to-place)', () => {
      // One line picked: the resolver now shows the length leader as the
      // cursor moves (was previously no preview). Dragging above the
      // horizontal line auto-picks a horizontal-measuring leader.
      const ov = toolOverlay(
        { tool: 'smart-dimension', chain: { kind: 'dim', operandIds: ['A'] } },
        { x: 5, y: 2 }, TOL, { entities: [lineA, lineB] },
      )!
      expect(ov.dimGuides).toBeDefined()
      expect(ov.dimGuides!.length).toBeGreaterThanOrEqual(3) // witnesses + dim line
    })

    it('two parallel lines preview a point-to-line distance witness', () => {
      // Parallel lines have no angle, so the resolver previews the
      // perpendicular distance witness (distancePL) instead of an arc.
      const parA: SketchEntity = {
        id: 'P1', kind: 'line', construction: false,
        start: { x: 0, y: 0 }, end: { x: 10, y: 0 },
      }
      const parB: SketchEntity = {
        id: 'P2', kind: 'line', construction: false,
        start: { x: 0, y: 5 }, end: { x: 10, y: 5 },
      }
      const ov = toolOverlay(
        { tool: 'smart-dimension', chain: { kind: 'dim', operandIds: ['P1', 'P2'] } },
        { x: 5, y: 2 }, TOL, { entities: [parA, parB] },
      )!
      expect(ov.dimGuides).toBeDefined()
      expect(ov.dimGuides!.length).toBeGreaterThanOrEqual(2) // witness + leader
    })

    // WO SKC-56: sector (which of the 4 regions the two lines' intersection
    // divides the plane into) follows the LIVE CURSOR, standard editor convention --
    // deliverable 1. A along +x, B at 45deg -> I1=(0,45) I2=(45,180)
    // I3=(180,225) I4=(225,360), sweeping all 4 as the cursor moves.
    it('the arc SECTOR follows the live cursor through all 4 sectors, not just its radius', () => {
      const arcAt = (deg: number) => {
        const rad = (deg * Math.PI) / 180
        return toolOverlay(
          { tool: 'smart-dimension', chain: { kind: 'dim', operandIds: ['A', 'B'] } },
          { x: 5 * Math.cos(rad), y: 5 * Math.sin(rad) }, TOL, { entities: [lineA, lineB] },
        )!.dimGuides![0]
      }
      const angleOf = (p: Vec2) => Math.atan2(p.y, p.x)
      // Sample the arc's START point (index 0) for each sector -- must sit
      // inside that sector's own angular span, not always the I1 short-way.
      const i1 = angleOf(arcAt(22)[0])
      const i2 = angleOf(arcAt(112)[0])
      const i3 = angleOf(arcAt(202)[0])
      const i4 = angleOf(arcAt(292)[0])
      // I1's arc starts at ray 0 (line A); I2's starts at ray 45 (line B) --
      // a DIFFERENT ray than I1's, proving the sector (not just the radius)
      // tracks the cursor.
      expect(i1).toBeCloseTo(0, 1)
      expect(i2).toBeCloseTo(Math.PI / 4, 1)
      expect(i3).toBeCloseTo(Math.PI, 1)
      expect(i4).toBeCloseTo(-Math.PI + Math.PI / 4, 1) // atan2 range: 225deg wraps to -135deg
    })
  })

  it('entityOutline tessellates every entity kind', () => {
    expect(entityOutline(
      { id: 'l', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: 1, y: 0 } },
    )).toHaveLength(2)
    expect(entityOutline(
      { id: 'c', kind: 'circle', construction: false, center: { x: 0, y: 0 }, radius: 5 },
    )!.length).toBeGreaterThan(16)
    expect(entityOutline(
      { id: 'p', kind: 'point', construction: false, at: { x: 0, y: 0 } },
    )!.length).toBeGreaterThan(2)
  })
})

describe('ortho-lock (Shift) cue + preview-equals-commit', () => {
  // An in-progress line chain anchored at (2,2).
  const chainState: ToolState = {
    tool: 'line',
    chain: {
      kind: 'line', start: { x: 2, y: 2 }, firstLineId: null,
      prev: { x: 2, y: 2 }, prevLineId: null,
    },
  }
  const anchor = { x: 2, y: 2 }
  const rawCursor = { x: 12, y: 3 } // ~5.7 deg above horizontal -> locks to 0 deg

  it('emits a dimGuide along the locked direction when the anchor is set', () => {
    const locked = applyOrthoLock(anchor, rawCursor)
    const ov = toolOverlay(chainState, locked, TOL, {
      entities: [], orthoLockAnchor: anchor,
    })!
    expect(ov.dimGuides).toBeDefined()
    expect(ov.dimGuides!).toHaveLength(1)
    // The guide is co-linear with the lock (here the horizontal 0 deg ray):
    // every guide point shares the anchor's Y.
    for (const p of ov.dimGuides![0]) {
      expect(p.y).toBeCloseTo(anchor.y, 9)
    }
  })

  it('the guide is a RAY from the anchor and never extends behind it (T2)', () => {
    // A 45deg lock so a "behind the anchor" point would be detectable on both
    // axes (it would have x < anchor.x and y < anchor.y).
    const a = { x: 2, y: 2 }
    const locked = applyOrthoLock(a, { x: a.x + 20, y: a.y + 19 }) // ~43.5deg -> 45
    const guide = toolOverlay(chainState, locked, TOL, {
      entities: [], orthoLockAnchor: a,
    })!.dimGuides![0]
    // First point IS the anchor (the kept start point).
    expect(guide[0].x).toBeCloseTo(a.x, 9)
    expect(guide[0].y).toBeCloseTo(a.y, 9)
    // No point lies behind the anchor along the locked +ray direction.
    const ux = locked.x - a.x, uy = locked.y - a.y
    for (const p of guide) {
      const proj = (p.x - a.x) * ux + (p.y - a.y) * uy
      expect(proj).toBeGreaterThanOrEqual(-1e-9)
    }
    // The far end reaches PAST the locked cursor (a small forward stub).
    const end = guide[guide.length - 1]
    const endProj = (end.x - a.x) * ux + (end.y - a.y) * uy
    const lockProj = ux * ux + uy * uy
    expect(endProj).toBeGreaterThan(lockProj)
  })

  it('emits the same cue for a NON-line tool (ellipse major-axis step)', () => {
    // Issue 3: ortho applies to every draw tool with a direction step.
    const ell: ToolState = {
      tool: 'ellipse', chain: { kind: 'ellipse', center: { x: 0, y: 0 }, major: null },
    }
    const a = { x: 0, y: 0 }
    const locked = applyOrthoLock(a, { x: 30, y: 2 }) // horizontal lock
    const ov = toolOverlay(ell, locked, TOL, { entities: [], orthoLockAnchor: a })!
    expect(ov.dimGuides).toBeDefined()
    expect(ov.dimGuides![0][0]).toEqual({ x: 0, y: 0 }) // starts at the anchor
  })

  it('no cue without the anchor (Shift released) — free drawing unchanged', () => {
    expect(toolOverlay(chainState, rawCursor, TOL, { entities: [] })).toBeNull()
  })

  it('preview band uses the locked point (preview === commit under lock)', () => {
    const locked = applyOrthoLock(anchor, rawCursor)
    // The viewport feeds the locked cursor to the preview.
    const band = toolPreview(chainState, locked)!
    expect(band[band.length - 1]).toEqual(locked)
    // ...and the click commits a segment whose end is that SAME locked point.
    const r = toolClick(chainState, locked, 0.01, idFactory())
    const seg = r.commit!.entities[0]
    expect(seg.kind).toBe('line')
    if (seg.kind === 'line') expect(seg.end).toEqual(locked)
  })
})

describe('fillet staged-corner markers (overlay pass-through)', () => {
  // Open rectangle: two corners at (10,0) and (10,10).
  const rect: SketchEntity[] = [
    { id: 'l1', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: 10, y: 0 } },
    { id: 'l2', kind: 'line', construction: false, start: { x: 10, y: 0 }, end: { x: 10, y: 10 } },
    { id: 'l3', kind: 'line', construction: false, start: { x: 10, y: 10 }, end: { x: 0, y: 10 } },
  ]
  const chain = {
    kind: 'fillet' as const,
    corners: [
      { aId: 'l1', bId: 'l2', hintA: { x: 0, y: 0 }, hintB: { x: 10, y: 10 }, at: { x: 10, y: 0 } },
      { aId: 'l2', bId: 'l3', hintA: { x: 10, y: 0 }, hintB: { x: 0, y: 10 }, at: { x: 10, y: 10 } },
    ],
    pendingLineId: null,
    pendingClick: null,
  }

  it('one selection marker per staged corner, at the corner point, plus the ghost arcs', () => {
    const ov = toolOverlay(
      { tool: 'fillet', chain }, { x: 5, y: 5 }, TOL,
      { entities: rect, filletRadius: 2 },
    )!
    expect(ov.ghosts).toHaveLength(2)
    expect(ov.markers).toHaveLength(2)
    const keys = ov.markers!.map((p) => `${p.x},${p.y}`).sort()
    expect(keys).toEqual(['10,0', '10,10'])
  })

  it('a misfit corner keeps its marker (warning triangle AND staged ring)', () => {
    const ov = toolOverlay(
      { tool: 'fillet', chain }, { x: 5, y: 5 }, TOL,
      { entities: rect, filletRadius: 50 }, // fits nowhere
    )!
    expect(ov.warnings).toHaveLength(2)
    expect(ov.markers).toHaveLength(2)
  })
})

describe('chamfer staged-corner markers (overlay pass-through)', () => {
  // Open rectangle: two corners at (10,0) and (10,10).
  const rect: SketchEntity[] = [
    { id: 'l1', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: 10, y: 0 } },
    { id: 'l2', kind: 'line', construction: false, start: { x: 10, y: 0 }, end: { x: 10, y: 10 } },
    { id: 'l3', kind: 'line', construction: false, start: { x: 10, y: 10 }, end: { x: 0, y: 10 } },
  ]
  const chain = {
    kind: 'chamfer' as const,
    corners: [
      { aId: 'l1', bId: 'l2', hintA: { x: 0, y: 0 }, hintB: { x: 10, y: 10 }, at: { x: 10, y: 0 } },
      { aId: 'l2', bId: 'l3', hintA: { x: 10, y: 0 }, hintB: { x: 0, y: 10 }, at: { x: 10, y: 10 } },
    ],
    pendingLineId: null,
    pendingClick: null,
  }

  it('one selection marker per staged corner, at the corner point, plus the ghost lines', () => {
    const ov = toolOverlay(
      { tool: 'chamfer', chain }, { x: 5, y: 5 }, TOL,
      { entities: rect, chamferSetback: 2 },
    )!
    expect(ov.ghosts).toHaveLength(2)
    expect(ov.markers).toHaveLength(2)
    const keys = ov.markers!.map((p) => `${p.x},${p.y}`).sort()
    expect(keys).toEqual(['10,0', '10,10'])
  })

  it('a misfit corner keeps its marker (warning triangle AND staged ring)', () => {
    const ov = toolOverlay(
      { tool: 'chamfer', chain }, { x: 5, y: 5 }, TOL,
      { entities: rect, chamferSetback: 50 }, // fits nowhere
    )!
    expect(ov.warnings).toHaveLength(2)
    expect(ov.markers).toHaveLength(2)
  })
})
