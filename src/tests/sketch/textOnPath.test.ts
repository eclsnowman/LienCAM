// Text-on-path warp (sketch "text on curve"). Headless coverage of
// textOnPath.ts: arc-length LUT correctness (ends + midpoint, open clamp,
// closed wrap), the local->path warp (straight line ~ translated/rotated
// horizontal layout, circle wrap), entity sampling, missing-path fallback in
// resolveTextPath + bake, and the store bind/unbind/pick round-trip.

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import {
  buildArcLengthLUT, warpLocalToPath, sampleEntityToPolyline, isSampleablePath,
  resolveTextPath, pickPathEntity, pickTextAttachTarget, textAttachMarkerWorld,
  effectiveStartOffsetMm, textEntityAdvanceMm,
  textOnPathToWorldPolylines, outlineTextOnPathToWorldContours,
  textOnPathPickDistance, textCaretWorldSegment,
} from '../../lib/sketch/textOnPath'
import { textToPolylines, textAdvanceWidth, textLocalBBox } from '../../lib/sketch/text'
import { outlineTextAdvanceWidth } from '../../lib/sketch/textOutline'
import { bakeSketch } from '../../lib/sketch/bake'
import type {
  Sketch, SketchEntity, SketchLineEntity, SketchTextEntity,
} from '../../lib/sketch/types'
import type { Vec2 } from '../../types'

const close = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps

function idFactory(): () => string {
  let n = 0
  return () => `id${n++}`
}

// ---- Arc-length LUT --------------------------------------------------------

describe('buildArcLengthLUT (open)', () => {
  const lut = buildArcLengthLUT([{ x: 0, y: 0 }, { x: 10, y: 0 }], false)

  it('totalLength equals the polyline length', () => {
    expect(close(lut.totalLength, 10)).toBe(true)
  })
  it('pointAt(0) = start, pointAt(total) = end, midpoint at s/2', () => {
    expect(lut.pointAt(0)).toEqual({ x: 0, y: 0 })
    expect(lut.pointAt(10)).toEqual({ x: 10, y: 0 })
    expect(lut.pointAt(5)).toEqual({ x: 5, y: 0 })
  })
  it('tangent points along +X', () => {
    const t = lut.tangentAt(3)
    expect(close(t.x, 1)).toBe(true)
    expect(close(t.y, 0)).toBe(true)
  })
  it('open path EXTRAPOLATES s past either end on the terminal tangent', () => {
    expect(lut.pointAt(-4)).toEqual({ x: -4, y: 0 })
    expect(lut.pointAt(99)).toEqual({ x: 99, y: 0 })
  })
  it('tangent is CONSTANT beyond either open end (terminal tangent)', () => {
    for (const s of [-50, -0.001, 10.001, 99]) {
      const t = lut.tangentAt(s)
      expect(close(t.x, 1) && close(t.y, 0)).toBe(true)
    }
  })
})

describe('buildArcLengthLUT (L-shaped midpoint)', () => {
  // (0,0)->(0,4)->(4,4): total 8, midpoint s=4 is the corner (0,4).
  const lut = buildArcLengthLUT([{ x: 0, y: 0 }, { x: 0, y: 4 }, { x: 4, y: 4 }], false)
  it('total length sums both legs', () => {
    expect(close(lut.totalLength, 8)).toBe(true)
  })
  it('midpoint sits at the corner; second leg advances in +X', () => {
    expect(lut.pointAt(4)).toEqual({ x: 0, y: 4 })
    expect(lut.pointAt(6)).toEqual({ x: 2, y: 4 })
  })
  it('extrapolation follows EACH terminal tangent (start +Y, end +X)', () => {
    // Before the start: pointAt(0) + s * tangentAt(0) = (0,0) + (-2)*(0,1).
    expect(lut.pointAt(-2)).toEqual({ x: 0, y: -2 })
    // Past the end: pointAt(8) + (s-8) * tangentAt(8) = (4,4) + 2*(1,0).
    expect(lut.pointAt(10)).toEqual({ x: 6, y: 4 })
    const t0 = lut.tangentAt(-5)
    expect(close(t0.x, 0) && close(t0.y, 1)).toBe(true)
    const t1 = lut.tangentAt(99)
    expect(close(t1.x, 1) && close(t1.y, 0)).toBe(true)
  })
})

describe('buildArcLengthLUT (closed wraps)', () => {
  // Unit square (no duplicate closing vertex): perimeter 4, closed.
  const sq = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]
  const lut = buildArcLengthLUT(sq, true)
  it('total length includes the closing segment', () => {
    expect(close(lut.totalLength, 4)).toBe(true)
  })
  it('pointAt(total) wraps back to the start', () => {
    const p = lut.pointAt(4)
    expect(close(p.x, 0) && close(p.y, 0)).toBe(true)
  })
  it('s beyond total wraps (s = total + 1 == s = 1)', () => {
    const a = lut.pointAt(1)
    const b = lut.pointAt(5)
    expect(close(a.x, b.x) && close(a.y, b.y)).toBe(true)
  })
  it('negative s wraps too -- closed paths never extrapolate', () => {
    const a = lut.pointAt(-1)
    const b = lut.pointAt(3)
    expect(close(a.x, b.x) && close(a.y, b.y)).toBe(true)
    const ta = lut.tangentAt(-1)
    const tb = lut.tangentAt(3)
    expect(close(ta.x, tb.x) && close(ta.y, tb.y)).toBe(true)
  })
})

// ---- Warp ------------------------------------------------------------------

describe('warpLocalToPath: straight line', () => {
  it('a line along +X from origin reproduces the horizontal layout', () => {
    const lut = buildArcLengthLUT([{ x: 0, y: 0 }, { x: 200, y: 0 }], false)
    const local = textToPolylines('AB', 8)
    const warped = warpLocalToPath(local, lut, 0, false)
    // tangent +X, normal +Y => world == local (identity for this path).
    for (let i = 0; i < local.length; i++) {
      for (let j = 0; j < local[i].length; j++) {
        expect(close(warped[i][j].x, local[i][j].x, 1e-6)).toBe(true)
        expect(close(warped[i][j].y, local[i][j].y, 1e-6)).toBe(true)
      }
    }
  })

  it('a line along +Y rotates the layout +90deg (local (x,y) -> (-y, x))', () => {
    const lut = buildArcLengthLUT([{ x: 0, y: 0 }, { x: 0, y: 200 }], false)
    const local: Vec2[][] = [[{ x: 4, y: 0 }, { x: 4, y: 21 }]]
    const warped = warpLocalToPath(local, lut, 0, false)
    // (4,0): base=(0,4), normal=(-1,0), y=0 -> (0,4).
    expect(close(warped[0][0].x, 0) && close(warped[0][0].y, 4)).toBe(true)
    // (4,21): base=(0,4), y=21 along normal (-1,0) -> (-21,4).
    expect(close(warped[0][1].x, -21) && close(warped[0][1].y, 4)).toBe(true)
  })

  it('flip mirrors to the other side / reverses reading direction', () => {
    const lut = buildArcLengthLUT([{ x: 0, y: 0 }, { x: 200, y: 0 }], false)
    const local: Vec2[][] = [[{ x: 10, y: 3 }]]
    const noflip = warpLocalToPath(local, lut, 0, false)[0][0]
    const flip = warpLocalToPath(local, lut, 0, true)[0][0]
    // no-flip: base=(10,0)+3*(0,1)=(10,3). flip walks s backward from 0
    // (extrapolating before the start) and negates the normal:
    // base=(-10,0)+3*(0,-1)=(-10,-3).
    expect(close(noflip.x, 10) && close(noflip.y, 3)).toBe(true)
    expect(close(flip.x, -10) && close(flip.y, -3)).toBe(true)
  })

  it('text slid PAST an open end keeps glyph shape (no endpoint smear)', () => {
    // 10mm line, offset 20: every glyph point extrapolates past the end. On
    // a straight +X path extrapolation is an exact translation, so the warp
    // must reproduce the local layout shifted by the offset -- with the old
    // clamp EVERY point collapsed onto x=10 (the smeared-bar defect).
    const lut = buildArcLengthLUT([{ x: 0, y: 0 }, { x: 10, y: 0 }], false)
    const local = textToPolylines('AB', 8)
    const warped = warpLocalToPath(local, lut, 20, false)
    const distinctX = new Set<number>()
    for (let i = 0; i < local.length; i++) {
      for (let j = 0; j < local[i].length; j++) {
        expect(close(warped[i][j].x, local[i][j].x + 20, 1e-6)).toBe(true)
        expect(close(warped[i][j].y, local[i][j].y, 1e-6)).toBe(true)
        distinctX.add(Math.round(warped[i][j].x * 1e6))
      }
    }
    // Shape survives: many distinct x positions, none pinned to the endpoint.
    expect(distinctX.size).toBeGreaterThan(1)
    expect(distinctX.has(10 * 1e6)).toBe(false)
  })

  it('text STRADDLING an open end stays continuous across the boundary', () => {
    // Offset puts half the layout on the path and half past the end: two
    // local points 1mm apart on either side of the boundary must stay ~1mm
    // apart in world (the old clamp pinched them onto the endpoint).
    const lut = buildArcLengthLUT([{ x: 0, y: 0 }, { x: 10, y: 0 }], false)
    const local: Vec2[][] = [[{ x: 4.5, y: 0 }, { x: 5.5, y: 0 }]]
    const [[a, b]] = warpLocalToPath(local, lut, 5, false)
    expect(close(a.x, 9.5) && close(a.y, 0)).toBe(true)
    expect(close(b.x, 10.5) && close(b.y, 0)).toBe(true)
    expect(close(Math.hypot(b.x - a.x, b.y - a.y), 1)).toBe(true)
  })
})

describe('warpLocalToPath: circle wraps around', () => {
  it('baseline points stay on the circle at arc-length angle', () => {
    const R = 50
    const circle: SketchEntity = {
      id: 'c', kind: 'circle', construction: false, center: { x: 0, y: 0 }, radius: R,
    }
    const sampled = sampleEntityToPolyline(circle)!
    const lut = buildArcLengthLUT(sampled.points, sampled.closed)
    expect(close(lut.totalLength, 2 * Math.PI * R, 0.5)).toBe(true)
    // Local baseline (y=0) stroke spanning a quarter of the circumference.
    const quarter = (2 * Math.PI * R) / 4
    const local: Vec2[][] = [[{ x: 0, y: 0 }, { x: quarter, y: 0 }]]
    const [[p0, p1]] = warpLocalToPath(local, lut, 0, false)
    // Both baseline points lie ON the circle (distance R from center).
    expect(close(Math.hypot(p0.x, p0.y), R, 0.5)).toBe(true)
    expect(close(Math.hypot(p1.x, p1.y), R, 0.5)).toBe(true)
    // A quarter turn CCW from (R,0) lands near (0, R).
    expect(close(p1.x, 0, 0.5) && close(p1.y, R, 0.5)).toBe(true)
  })
})

// ---- Entity sampling -------------------------------------------------------

describe('sampleEntityToPolyline', () => {
  it('samples curve kinds and rejects point/text', () => {
    const line: SketchEntity = { id: 'l', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: 5, y: 0 } }
    expect(sampleEntityToPolyline(line)?.closed).toBe(false)
    expect(isSampleablePath(line)).toBe(true)
    const circle: SketchEntity = { id: 'c', kind: 'circle', construction: false, center: { x: 0, y: 0 }, radius: 3 }
    expect(sampleEntityToPolyline(circle)?.closed).toBe(true)
    const pt: SketchEntity = { id: 'p', kind: 'point', construction: false, at: { x: 0, y: 0 } }
    expect(sampleEntityToPolyline(pt)).toBeNull()
    expect(isSampleablePath(pt)).toBe(false)
    const txt: SketchTextEntity = {
      id: 't', kind: 'text', construction: false, at: { x: 0, y: 0 }, text: 'A', height: 5, fontStyle: 'single-line',
    }
    expect(sampleEntityToPolyline(txt)).toBeNull()
  })
})

// ---- Missing-path resolution + bake fallback -------------------------------

describe('resolveTextPath (missing path -> free)', () => {
  const line: SketchLineEntity = {
    id: 'ln', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: 20, y: 0 },
  }
  it('unset pathId returns null (free, quiet)', () => {
    const t: SketchTextEntity = { id: 't', kind: 'text', construction: false, at: { x: 0, y: 0 }, text: 'A', height: 5, fontStyle: 'single-line' }
    expect(resolveTextPath(t, [t, line])).toBeNull()
  })
  it('valid pathId resolves to the curve', () => {
    const t: SketchTextEntity = { id: 't', kind: 'text', construction: false, at: { x: 0, y: 0 }, text: 'A', height: 5, fontStyle: 'single-line', pathId: 'ln' }
    expect(resolveTextPath(t, [t, line])?.id).toBe('ln')
  })
  it('missing pathId falls back to null (fallback path)', () => {
    const t: SketchTextEntity = { id: 't', kind: 'text', construction: false, at: { x: 0, y: 0 }, text: 'A', height: 5, fontStyle: 'single-line', pathId: 'ghost' }
    expect(resolveTextPath(t, [t, line])).toBeNull()
  })
})

describe('bake: on-path vs free', () => {
  const layerId = 'L'
  const line: SketchLineEntity = {
    id: 'ln', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: 0, y: 60 },
  }
  function sketchOf(entities: SketchEntity[]): Sketch {
    return { id: 'sk', layerId, entities, constraints: [], dimensions: [], solveStatus: null }
  }

  it('a text bound to a missing path bakes IDENTICALLY to free text', () => {
    const free: SketchTextEntity = { id: 't', kind: 'text', construction: false, at: { x: 0, y: 0 }, text: 'I', height: 21, rotation: 0, fontStyle: 'single-line' }
    const bad: SketchTextEntity = { ...free, pathId: 'ghost' }
    const a = bakeSketch(sketchOf([free]), { newId: idFactory() })
    const b = bakeSketch(sketchOf([bad]), { newId: idFactory() })
    expect(b.loops.map((l) => l.points)).toEqual(a.loops.map((l) => l.points))
  })

  it("'I' bound to a vertical line bakes the warped (perpendicular) stroke", () => {
    // 'I' local stroke: x=4 (both ends), y 0..21. On the +Y line both ends map
    // to s=4 -> base (0,4); the height runs along normal (-1,0) -> (-21,4).
    const t: SketchTextEntity = { id: 't', kind: 'text', construction: false, at: { x: 0, y: 0 }, text: 'I', height: 21, rotation: 0, fontStyle: 'single-line', pathId: 'ln' }
    const { loops } = bakeSketch(sketchOf([line, t]), { newId: idFactory() })
    const allPts = loops.flatMap((l) => l.points)
    const hasWarpedTip = allPts.some((p) => close(p.x, -21, 1e-4) && close(p.y, 4, 1e-4))
    const hasBase = allPts.some((p) => close(p.x, 0, 1e-4) && close(p.y, 4, 1e-4))
    expect(hasWarpedTip).toBe(true)
    expect(hasBase).toBe(true)
  })
})

// ---- Advance width (untrimmed, whitespace counts -- spec T3) ---------------

describe('advance width: pen position, NOT bbox extent', () => {
  it('a trailing space grows the ADVANCE but not the bbox X-extent', () => {
    const a = textAdvanceWidth('AB', 8)
    const b = textAdvanceWidth('AB ', 8)
    const spaceAdv = textAdvanceWidth(' ', 8)
    expect(b - a).toBeCloseTo(spaceAdv, 9)
    // The bbox is blind to the trailing space (no stroke geometry) -- the
    // reason alignment must measure ADVANCE, not the bbox.
    expect(textLocalBBox('AB ', 8)!.maxX).toBeCloseTo(textLocalBBox('AB', 8)!.maxX, 9)
  })

  it('"  text" measures exactly two space advances more than "text" (T3 example)', () => {
    const spaceAdv = textAdvanceWidth(' ', 8)
    expect(textAdvanceWidth('  text', 8) - textAdvanceWidth('text', 8))
      .toBeCloseTo(2 * spaceAdv, 9)
  })

  it('outline advance also counts whitespace; empty / height<=0 measure 0', () => {
    const a = outlineTextAdvanceWidth('AB', 8)
    const b = outlineTextAdvanceWidth(' AB ', 8)
    expect(a).toBeGreaterThan(0)
    expect(b).toBeGreaterThan(a)
    expect(textAdvanceWidth('', 8)).toBe(0)
    expect(textAdvanceWidth('A', 0)).toBe(0)
    expect(outlineTextAdvanceWidth('', 8)).toBe(0)
  })

  it('textEntityAdvanceMm dispatches on the entity font style', () => {
    const single: SketchTextEntity = {
      id: 't', kind: 'text', construction: false, at: { x: 0, y: 0 },
      text: 'AB', height: 8, fontStyle: 'single-line',
    }
    const outline: SketchTextEntity = { ...single, fontStyle: 'outline' }
    expect(textEntityAdvanceMm(single)).toBeCloseTo(textAdvanceWidth('AB', 8), 9)
    expect(textEntityAdvanceMm(outline)).toBeCloseTo(outlineTextAdvanceWidth('AB', 8), 9)
  })
})

// ---- effectiveStartOffsetMm (the ONE align resolver) ------------------------

// Entity factory for resolver tests (fields beyond align/offset irrelevant).
function alignedText(over: Partial<SketchTextEntity>): SketchTextEntity {
  return {
    id: 't', kind: 'text', construction: false, at: { x: 0, y: 0 },
    text: 'AB', height: 8, fontStyle: 'single-line', pathId: 'ln', ...over,
  }
}

describe('effectiveStartOffsetMm: open path (length 100, advance 20)', () => {
  const lut = buildArcLengthLUT([{ x: 0, y: 0 }, { x: 100, y: 0 }], false)
  const adv = 20

  it("'left' anchors at the curve START", () => {
    expect(effectiveStartOffsetMm(alignedText({ pathAlign: 'left' }), lut, adv)).toBe(0)
  })
  it("'center' centers on the curve MIDDLE (total/2 - advance/2)", () => {
    expect(effectiveStartOffsetMm(alignedText({ pathAlign: 'center' }), lut, adv)).toBe(40)
  })
  it("'right' ends at the curve END (total - advance)", () => {
    expect(effectiveStartOffsetMm(alignedText({ pathAlign: 'right' }), lut, adv)).toBe(80)
  })
  it("'free' uses pathOffsetMm verbatim", () => {
    expect(effectiveStartOffsetMm(
      alignedText({ pathAlign: 'free', pathOffsetMm: 7 }), lut, adv,
    )).toBe(7)
  })
  it('ABSENT pathAlign = legacy pathOffsetMm behavior (regression)', () => {
    expect(effectiveStartOffsetMm(alignedText({ pathOffsetMm: 7 }), lut, adv)).toBe(7)
    expect(effectiveStartOffsetMm(alignedText({}), lut, adv)).toBe(0)
  })
  it('pathFlip mirrors the aligned formulas (same arc region, backward walk)', () => {
    // Flip walks s BACKWARD from the start offset, so keeping the text on
    // the same arc region means: left -> advance, center -> total/2 +
    // advance/2, right -> total. 'free' stays raw.
    expect(effectiveStartOffsetMm(
      alignedText({ pathAlign: 'left', pathFlip: true }), lut, adv,
    )).toBe(20)
    expect(effectiveStartOffsetMm(
      alignedText({ pathAlign: 'center', pathFlip: true }), lut, adv,
    )).toBe(60)
    expect(effectiveStartOffsetMm(
      alignedText({ pathAlign: 'right', pathFlip: true }), lut, adv,
    )).toBe(100)
    expect(effectiveStartOffsetMm(
      alignedText({ pathAlign: 'free', pathOffsetMm: 7, pathFlip: true }), lut, adv,
    )).toBe(7)
  })
})

describe('effectiveStartOffsetMm: closed path WRAPS (square, total 4)', () => {
  const sq = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]
  const lut = buildArcLengthLUT(sq, true)

  it('center/right are computed on the UNWRAPPED arc length; the LUT wraps', () => {
    // Advance 6 > total 4: center = 4/2 - 6/2 = -1 (unwrapped) and the LUT
    // brings every sampled s modulo total -- pointAt(-1) == pointAt(3).
    const center = effectiveStartOffsetMm(alignedText({ pathAlign: 'center' }), lut, 6)
    expect(close(center, -1)).toBe(true)
    const a = lut.pointAt(center)
    const b = lut.pointAt(3)
    expect(close(a.x, b.x) && close(a.y, b.y)).toBe(true)
    const right = effectiveStartOffsetMm(alignedText({ pathAlign: 'right' }), lut, 6)
    expect(close(right, -2)).toBe(true)
    const c = lut.pointAt(right)
    const d = lut.pointAt(2)
    expect(close(c.x, d.x) && close(c.y, d.y)).toBe(true)
  })
})

// ---- Align modes: RENDER/BAKE PARITY (shared-resolver rule) -----------------

describe('align modes: render and bake start at the SAME place', () => {
  const layerId = 'L'
  // CONSTRUCTION path: rides the text but never bakes, so the baked loops
  // are EXACTLY the text strokes (clean comparison).
  const line: SketchLineEntity = {
    id: 'ln', kind: 'line', construction: true,
    start: { x: 0, y: 0 }, end: { x: 100, y: 0 },
  }
  function sketchOf(entities: SketchEntity[]): Sketch {
    return { id: 'sk', layerId, entities, constraints: [], dimensions: [], solveStatus: null }
  }
  function onPathText(over: Partial<SketchTextEntity>): SketchTextEntity {
    return {
      id: 't', kind: 'text', construction: false, at: { x: 0, y: 0 },
      text: 'HI', height: 8, rotation: 0, fontStyle: 'single-line',
      pathId: 'ln', ...over,
    }
  }

  const cases: Array<[string, Partial<SketchTextEntity>]> = [
    ['left', { pathAlign: 'left' }],
    ['center', { pathAlign: 'center' }],
    ['right', { pathAlign: 'right' }],
    ['free', { pathAlign: 'free', pathOffsetMm: 7 }],
    ['legacy-absent', { pathOffsetMm: 7 }],
  ]

  for (const [name, over] of cases) {
    it(`${name}: bake loops equal the renderer's world polylines`, () => {
      const e = onPathText(over)
      // Renderer path: resolveTextPath + textOnPathToWorldPolylines (exactly
      // what sketchLayer draws).
      const path = resolveTextPath(e, [line, e])!
      const rendered = textOnPathToWorldPolylines(e, path)
      expect(rendered.length).toBeGreaterThan(0)
      // Bake path.
      const { loops } = bakeSketch(sketchOf([line, e]), { newId: idFactory() })
      expect(loops.map((l) => l.points)).toEqual(rendered)
    })
  }

  it('aligned modes place the text where the mode says (world check)', () => {
    // 'center' on the 100mm +X line: a straight path warp is an identity
    // translation, so world x = start + local x. The layout must sit
    // centered: minX ~ 50 - advance/2 + bearing.
    const e = onPathText({ pathAlign: 'center' })
    const adv = textEntityAdvanceMm(e)
    const local = textToPolylines(e.text, e.height)
    const localMinX = Math.min(...local.flat().map((p) => p.x))
    const world = textOnPathToWorldPolylines(e, line)
    const worldMinX = Math.min(...world.flat().map((p) => p.x))
    expect(worldMinX).toBeCloseTo(50 - adv / 2 + localMinX, 6)
    // 'right': the pen ENDS at the curve end (trailing bearing included).
    const r = onPathText({ pathAlign: 'right' })
    const worldR = textOnPathToWorldPolylines(r, line)
    const worldRMinX = Math.min(...worldR.flat().map((p) => p.x))
    expect(worldRMinX).toBeCloseTo(100 - adv + localMinX, 6)
  })

  it('outline render/bake parity for a centered mode (points match as sets)', () => {
    // Bake normalizes closed-loop winding, which may reverse point order --
    // compare reversal-insensitively.
    const e = onPathText({ pathAlign: 'center', fontStyle: 'outline', text: 'I' })
    const rendered = outlineTextOnPathToWorldContours(e, line)
    const { loops } = bakeSketch(sketchOf([line, e]), { newId: idFactory() })
    expect(loops.length).toBe(rendered.length)
    const key = (pts: readonly Vec2[]) =>
      pts.map((p) => `${p.x.toFixed(6)},${p.y.toFixed(6)}`).sort().join('|')
    const renderedKeys = rendered.map((c) => key(c.points)).sort()
    const bakedKeys = loops.map((l) => key(l.points)).sort()
    expect(bakedKeys).toEqual(renderedKeys)
  })

  it('whitespace SHIFTS aligned text ("  text" aligns differently -- T3)', () => {
    const spaceAdv = textAdvanceWidth(' ', 8)
    // LEFT align: leading spaces push the glyphs along the path.
    const plain = textOnPathToWorldPolylines(onPathText({ pathAlign: 'left', text: 'I' }), line)
    const led = textOnPathToWorldPolylines(onPathText({ pathAlign: 'left', text: '  I' }), line)
    expect(led[0][0].x - plain[0][0].x).toBeCloseTo(2 * spaceAdv, 6)
    // CENTER align: TRAILING spaces pull the glyphs back (bbox is identical,
    // so only an ADVANCE measurement can produce this shift).
    const centered = textOnPathToWorldPolylines(onPathText({ pathAlign: 'center', text: 'I' }), line)
    const trailed = textOnPathToWorldPolylines(onPathText({ pathAlign: 'center', text: 'I  ' }), line)
    expect(trailed[0][0].x - centered[0][0].x).toBeCloseTo(-spaceAdv, 6)
  })

  it('the PICK band sits where the aligned text renders, not at offset 0', () => {
    const e = onPathText({ pathAlign: 'center', text: 'AB' })
    // Inside the rendered (centered) band: distance 0.
    expect(textOnPathPickDistance(e, line, { x: 50, y: 4 })).toBe(0)
    // At the legacy offset-0 location: far away.
    expect(textOnPathPickDistance(e, line, { x: 2, y: 4 })).toBeGreaterThan(10)
    // A 'free' text at offset 0 picks at the start instead.
    const f = onPathText({ pathAlign: 'free', pathOffsetMm: 0, text: 'AB' })
    expect(textOnPathPickDistance(f, line, { x: 2, y: 4 })).toBe(0)
  })
})

// ---- pickPathEntity --------------------------------------------------------

describe('pickPathEntity', () => {
  it('returns the nearest curve within tol, excluding the text itself', () => {
    const entities: SketchEntity[] = [
      { id: 'ln', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: 10, y: 0 } },
      { id: 't', kind: 'text', construction: false, at: { x: 0, y: 5 }, text: 'A', height: 5, fontStyle: 'single-line' },
    ]
    expect(pickPathEntity(entities, { x: 5, y: 0.1 }, 0.5, 't')?.id).toBe('ln')
    expect(pickPathEntity(entities, { x: 5, y: 9 }, 0.5, 't')).toBeNull()
  })
})

// ---- pickTextAttachTarget (THE owner of the doubled attach tolerance) ------

describe('pickTextAttachTarget', () => {
  const entities: SketchEntity[] = [
    { id: 'ln', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: 10, y: 0 } },
    { id: 't', kind: 'text', construction: false, at: { x: 0, y: 5 }, text: 'A', height: 5, fontStyle: 'single-line' },
  ]

  it('agrees with pickPathEntity at DOUBLE the passed tolerance (hit)', () => {
    // 0.8mm off the line: the single tolerance (0.5) misses, the doubled
    // tolerance (1.0) hits -- exactly the band the helper exists to own.
    const world = { x: 5, y: 0.8 }
    expect(pickPathEntity(entities, world, 0.5)).toBeNull()
    expect(pickTextAttachTarget(entities, world, 0.5)?.id).toBe('ln')
    expect(pickTextAttachTarget(entities, world, 0.5)?.id)
      .toBe(pickPathEntity(entities, world, 1.0)?.id)
  })

  it('misses beyond the doubled tolerance (agrees on the miss too)', () => {
    const world = { x: 5, y: 1.2 }
    expect(pickTextAttachTarget(entities, world, 0.5)).toBeNull()
    expect(pickPathEntity(entities, world, 1.0)).toBeNull()
  })

  it('honors excludeId', () => {
    expect(pickTextAttachTarget(entities, { x: 5, y: 0.1 }, 0.5, 'ln')).toBeNull()
  })
})

// ---- textAttachMarkerWorld (attachment-point marker anchor) ----------------

describe('textAttachMarkerWorld', () => {
  // Open path along +X: LUT s maps 1:1 onto x, so reference points are exact.
  const line: SketchLineEntity = {
    id: 'ln', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: 100, y: 0 },
  }
  const base: SketchTextEntity = {
    id: 't', kind: 'text', construction: false, at: { x: 3, y: 4 },
    text: 'AB', height: 8, fontStyle: 'single-line',
  }
  const at = (e: SketchTextEntity) => textAttachMarkerWorld(e, [e, line])

  it('FREE text (no pathId) -> the entity anchor verbatim', () => {
    expect(at(base)).toEqual({ x: 3, y: 4 })
  })

  it("'left' -> curve START, flip-INVARIANT", () => {
    for (const pathFlip of [false, true]) {
      const p = at({ ...base, pathId: 'ln', pathAlign: 'left', pathFlip })!
      expect(close(p.x, 0) && close(p.y, 0)).toBe(true)
    }
  })

  it("'center' -> curve MIDDLE, flip-INVARIANT", () => {
    for (const pathFlip of [false, true]) {
      const p = at({ ...base, pathId: 'ln', pathAlign: 'center', pathFlip })!
      expect(close(p.x, 50) && close(p.y, 0)).toBe(true)
    }
  })

  it("'right' -> curve END, flip-INVARIANT", () => {
    for (const pathFlip of [false, true]) {
      const p = at({ ...base, pathId: 'ln', pathAlign: 'right', pathFlip })!
      expect(close(p.x, 100) && close(p.y, 0)).toBe(true)
    }
  })

  it("'free' -> the placed LEADING edge (resolved start offset)", () => {
    const p = at({ ...base, pathId: 'ln', pathAlign: 'free', pathOffsetMm: 2.5 })!
    expect(close(p.x, 2.5) && close(p.y, 0)).toBe(true)
  })

  it('LEGACY entity (pathOffsetMm only, no pathAlign) -> leading edge', () => {
    const p = at({ ...base, pathId: 'ln', pathOffsetMm: 40 })!
    expect(close(p.x, 40) && close(p.y, 0)).toBe(true)
  })

  it('orphaned pathId -> null (loud fallback already covers the text)', () => {
    expect(at({ ...base, pathId: 'ghost' })).toBeNull()
  })
})

// ---- Store bind / unbind / pick round-trip ---------------------------------

vi.stubGlobal('localStorage', {
  getItem: () => null, setItem: () => undefined, removeItem: () => undefined,
})
class NoopWorker {
  onmessage: ((e: unknown) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  postMessage(): void {}
  terminate(): void {}
}
vi.stubGlobal('Worker', NoopWorker)

describe('store: bind / unbind / pick round-trip', () => {
  let useCamStore: typeof import('../../store').useCamStore
  beforeAll(async () => {
    ;({ useCamStore } = await import('../../store'))
  })
  beforeEach(() => {
    useCamStore.setState({
      activeSketch: {
        id: 'sk', layerId: 'L',
        entities: [
          { id: 'tx', kind: 'text', construction: false, at: { x: 1, y: 2 }, text: 'HI', height: 5, rotation: 0, fontStyle: 'single-line' },
          { id: 'ln', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: 20, y: 0 } },
          { id: 'pt', kind: 'point', construction: false, at: { x: 0, y: 0 } },
        ],
        constraints: [], dimensions: [], solveStatus: null,
      },
      sketchHistory: [], projectHistory: [], canUndo: false,
      sketchTextEditId: null, sketchPickPathForTextId: null,
      sketchTextPathId: null, sketchTextPathOffsetMm: 0, sketchTextPathFlip: false,
      sketchTextPathAlign: 'free',
    })
  })
  const txt = () =>
    useCamStore.getState().activeSketch!.entities.find((e) => e.id === 'tx') as SketchTextEntity

  it('bind sets pathId in place; unbind clears it', () => {
    useCamStore.getState().bindSketchTextPath('tx', 'ln')
    expect(txt().pathId).toBe('ln')
    expect(useCamStore.getState().sketchTextPathId).toBe('ln')
    useCamStore.getState().unbindSketchTextPath('tx')
    expect(txt().pathId).toBeUndefined()
    expect(useCamStore.getState().sketchTextPathId).toBeNull()
  })

  it('binding to a non-curve (point) is rejected, text stays free', () => {
    useCamStore.getState().bindSketchTextPath('tx', 'pt')
    expect(txt().pathId).toBeUndefined()
  })

  it('begin/cancel pick-path toggles the pick flag', () => {
    useCamStore.getState().beginPickTextPath('tx')
    expect(useCamStore.getState().sketchPickPathForTextId).toBe('tx')
    useCamStore.getState().cancelPickTextPath()
    expect(useCamStore.getState().sketchPickPathForTextId).toBeNull()
  })

  it('setSketchTextPathAlign patches the edited entity and the mirror field', () => {
    useCamStore.getState().beginSketchTextEdit('tx')
    useCamStore.getState().bindSketchTextPath('tx', 'ln')
    useCamStore.getState().setSketchTextPathAlign('center')
    expect(txt().pathAlign).toBe('center')
    expect(useCamStore.getState().sketchTextPathAlign).toBe('center')
    useCamStore.getState().commitSketchTextEdit()
    // Re-open: the mode reloads from the entity.
    useCamStore.getState().beginSketchTextEdit('tx')
    expect(useCamStore.getState().sketchTextPathAlign).toBe('center')
  })

  it('a MANUAL numeric offset forces pathAlign back to free (ADR-0003)', () => {
    useCamStore.getState().beginSketchTextEdit('tx')
    useCamStore.getState().bindSketchTextPath('tx', 'ln')
    useCamStore.getState().setSketchTextPathAlign('right')
    useCamStore.getState().setSketchTextPathOffset(3)
    expect(txt().pathOffsetMm).toBe(3)
    expect(txt().pathAlign).toBe('free') // L/C/R would ignore the value
    expect(useCamStore.getState().sketchTextPathAlign).toBe('free')
  })

  it('a LEGACY entity without pathAlign loads as free; unbind clears the mode', () => {
    // tx starts with no pathAlign field (legacy shape).
    useCamStore.getState().beginSketchTextEdit('tx')
    expect(useCamStore.getState().sketchTextPathAlign).toBe('free')
    useCamStore.getState().bindSketchTextPath('tx', 'ln')
    useCamStore.getState().setSketchTextPathAlign('left')
    useCamStore.getState().unbindSketchTextPath('tx')
    expect(txt().pathAlign).toBeUndefined() // meaningless without a path
    expect(useCamStore.getState().sketchTextPathAlign).toBe('free')
  })

  it('beginSketchTextEdit round-trips a bound path into the toolbox state', () => {
    // Real flow: open the edit, attach a path, tweak offset/flip (all patch the
    // entity in place because the edit is open), finish.
    useCamStore.getState().beginSketchTextEdit('tx')
    useCamStore.getState().bindSketchTextPath('tx', 'ln')
    useCamStore.getState().setSketchTextPathOffset(3)
    useCamStore.getState().setSketchTextPathFlip(true)
    expect(txt().pathId).toBe('ln')
    expect(txt().pathOffsetMm).toBe(3)
    expect(txt().pathFlip).toBe(true)
    useCamStore.getState().commitSketchTextEdit()
    // Re-open the edit and confirm the fields reload from the entity.
    useCamStore.getState().beginSketchTextEdit('tx')
    const s = useCamStore.getState()
    expect(s.sketchTextPathId).toBe('ln')
    expect(s.sketchTextPathOffsetMm).toBe(3)
    expect(s.sketchTextPathFlip).toBe(true)
  })
})

// ---- Letter spacing inherits through the ONE advance/layout source --------
//
// letterSpacingMm threads through textEntityAdvanceMm; every on-path consumer
// (alignment start-offset, warp, caret) derives from that ONE advance/layout,
// so none of them is hand-wired -- proven here by exercising the entity, not
// the low-level opts.
describe('letter spacing inheritance (one source: advance/align/caret)', () => {
  const S = 2
  const N = 4 // 'ABCD'
  function txt(over: Partial<SketchTextEntity> = {}): SketchTextEntity {
    return {
      id: 'tx', kind: 'text', construction: false, at: { x: 0, y: 0 },
      text: 'ABCD', height: 10, rotation: 0, fontStyle: 'single-line', ...over,
    }
  }
  const LN: SketchLineEntity = {
    id: 'ln', kind: 'line', construction: false,
    start: { x: 0, y: 0 }, end: { x: 200, y: 0 },
  }
  const lut = buildArcLengthLUT([{ x: 0, y: 0 }, { x: 200, y: 0 }], false)
  const advBase = textEntityAdvanceMm(txt())
  const advSpaced = textEntityAdvanceMm(txt({ letterSpacingMm: S }))
  const delta = advSpaced - advBase

  it('textEntityAdvanceMm inherits spacing: delta = (N-1)*spacing', () => {
    expect(delta).toBeCloseTo((N - 1) * S, 6)
  })

  it("effectiveStartOffsetMm 'right' shifts by the full advance delta", () => {
    // right offset = total - advance, so a wider advance starts EARLIER.
    const rBase = effectiveStartOffsetMm(txt({ pathAlign: 'right' }), lut, advBase)
    const rSpaced = effectiveStartOffsetMm(
      txt({ pathAlign: 'right', letterSpacingMm: S }), lut, advSpaced,
    )
    expect(rBase - rSpaced).toBeCloseTo(delta, 6)
  })

  it("effectiveStartOffsetMm 'center' shifts by HALF the advance delta", () => {
    const cBase = effectiveStartOffsetMm(txt({ pathAlign: 'center' }), lut, advBase)
    const cSpaced = effectiveStartOffsetMm(
      txt({ pathAlign: 'center', letterSpacingMm: S }), lut, advSpaced,
    )
    expect(cBase - cSpaced).toBeCloseTo(delta / 2, 6)
  })

  it('FREE end-caret rides the spaced advance (sub-advance inherits)', () => {
    // Free horizontal text at the origin: the index=length caret sits at x =
    // advance, so spacing pushes it right by exactly (N-1)*spacing.
    const segBase = textCaretWorldSegment(txt(), [], N)!
    const segSpaced = textCaretWorldSegment(txt({ letterSpacingMm: S }), [], N)!
    expect(segSpaced[0].x - segBase[0].x).toBeCloseTo((N - 1) * S, 6)
  })

  it('ON-PATH right-aligned caret start rides the spaced advance (align + warp)', () => {
    // right-aligned on-path text ends at the curve end; its index-0 caret sits
    // at s = total - advance, warped onto the line at x = 200 - advance. So the
    // spaced caret lands `delta` earlier -- proving align AND warp both inherit.
    const startBase = textCaretWorldSegment(
      txt({ pathId: 'ln', pathAlign: 'right' }), [LN], 0,
    )![0]
    const startSpaced = textCaretWorldSegment(
      txt({ pathId: 'ln', pathAlign: 'right', letterSpacingMm: S }), [LN], 0,
    )![0]
    expect(startBase.x - startSpaced.x).toBeCloseTo(delta, 4)
  })

  it('MIRROR reflects about the SPACED advance (index-0 caret sits at advance)', () => {
    // Mirrored free text: the index-0 caret reflects to x = advance - 0. That
    // advance MUST be the spaced one, or caret/marker/mirror would disagree.
    const adv = textEntityAdvanceMm(txt({ letterSpacingMm: S, mirrored: true }))
    const seg = textCaretWorldSegment(
      txt({ letterSpacingMm: S, mirrored: true }), [], 0,
    )!
    expect(seg[0].x).toBeCloseTo(adv, 6)
    expect(adv).toBeCloseTo(advSpaced, 6) // mirror preserves the span
  })
})
