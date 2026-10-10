// MIRRORED text (flip-TEXT, spec T5b, plan item 7 / decision D-C).
//
// The mirror is ONE shared transform (text.ts mirrorLocalLayoutX): an
// x-negation of the LOCAL layout about the string's ADVANCE MIDPOINT
// (x -> advance - x), applied as the last local-layout step inside
// textToPolylines / outlineTextToContours so render, bake, on-path warp AND
// the pick metrics all inherit it. Mirroring about the advance midpoint --
// not about x = 0 -- keeps the mirrored text inside the SAME [0, advance]
// span (standard editor mirrors in place). This file proves: the transform itself
// (span preserved, reading reversed, double-mirror identity), both font
// styles, free + on-path, render/bake parity, the pick bbox/band, and the
// plan's risk E -- mirrored outline contours reverse winding, and the bake's
// containment nesting still types counters as holes (winding normalized).

import { describe, it, expect } from 'vitest'
import type { Vec2 } from '../../types'
import {
  textToPolylines, textToWorldPolylines, textAdvanceWidth, textLocalBBox,
  distanceToTextBBox, mirrorLocalLayoutX,
} from '../../lib/sketch/text'
import {
  outlineTextToContours, outlineTextAdvanceWidth, outlineTextLocalBBox,
} from '../../lib/sketch/textOutline'
import {
  textOnPathToWorldPolylines, outlineTextOnPathToWorldContours,
  textOnPathPickDistance,
} from '../../lib/sketch/textOnPath'
import { bakeSketch } from '../../lib/sketch/bake'
import type {
  Sketch, SketchEntity, SketchLineEntity, SketchTextEntity,
} from '../../lib/sketch/types'

function idFactory(): () => string {
  let n = 0
  return () => `id${n++}`
}

/** Shoelace signed area (CCW positive), closing edge implied. */
function signedArea(pts: readonly Vec2[]): number {
  let a = 0
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]
    const q = pts[(i + 1) % pts.length]
    a += p.x * q.y - q.x * p.y
  }
  return a / 2
}

const LINE: SketchLineEntity = {
  id: 'ln', kind: 'line', construction: false,
  start: { x: 0, y: 0 }, end: { x: 100, y: 0 },
}

function textEnt(over: Partial<SketchTextEntity> = {}): SketchTextEntity {
  return {
    id: 'tx', kind: 'text', construction: false,
    at: { x: 0, y: 0 }, text: 'AB', height: 8, rotation: 0,
    fontStyle: 'single-line',
    ...over,
  }
}

function sketchOf(entities: SketchEntity[]): Sketch {
  return {
    id: 'sk', layerId: 'L', entities,
    constraints: [], dimensions: [], solveStatus: null,
  }
}

// ---- The ONE transform ------------------------------------------------------

describe('mirrorLocalLayoutX (the one shared transform)', () => {
  it('maps every vertex x -> advance - x (y untouched)', () => {
    const polys = [[{ x: 1, y: 2 }, { x: 3, y: -1 }], [{ x: 0, y: 0 }]]
    const out = mirrorLocalLayoutX(polys as Vec2[][], 10)
    expect(out).toEqual([[{ x: 9, y: 2 }, { x: 7, y: -1 }], [{ x: 10, y: 0 }]])
  })

  it('double-mirror is the identity', () => {
    const polys = textToPolylines('LF', 8)
    const twice = mirrorLocalLayoutX(mirrorLocalLayoutX(polys, 12.5), 12.5)
    expect(twice).toEqual(polys)
  })
})

// ---- Single-line local layout ----------------------------------------------

describe('single-line mirrored layout (textToPolylines)', () => {
  it('is exactly the unmirrored layout reflected about the advance midpoint', () => {
    const adv = textAdvanceWidth('LAB', 8)
    const plain = textToPolylines('LAB', 8)
    const mirrored = textToPolylines('LAB', 8, { mirrored: true })
    expect(mirrored).toEqual(
      plain.map((poly) => poly.map((p) => ({ x: adv - p.x, y: p.y }))),
    )
  })

  it('span preserved: the mirrored bbox is the reflected interval inside [0, advance]', () => {
    const adv = textAdvanceWidth('LAB', 8)
    const b0 = textLocalBBox('LAB', 8)!
    const b1 = textLocalBBox('LAB', 8, { mirrored: true })!
    expect(b1.minX).toBeCloseTo(adv - b0.maxX, 9)
    expect(b1.maxX).toBeCloseTo(adv - b0.minX, 9)
    expect(b1.minY).toBeCloseTo(b0.minY, 9)
    expect(b1.maxY).toBeCloseTo(b0.maxY, 9)
  })

  it('reading reversed: the FIRST glyph now occupies the RIGHT end of the span', () => {
    // 'L' + 3 spaces: all stroke geometry belongs to the L (spaces advance
    // the pen, spec T3). Unmirrored the L sits in the LEFT half of the
    // advance span; mirrored it must sit in the RIGHT half.
    const adv = textAdvanceWidth('L   ', 8)
    const b0 = textLocalBBox('L   ', 8)!
    const b1 = textLocalBBox('L   ', 8, { mirrored: true })!
    expect(b0.maxX).toBeLessThan(adv / 2) // L on the left...
    expect(b1.minX).toBeGreaterThan(adv / 2) // ...moves to the right
  })

  it('advance width itself is mirror-invariant (same span, same alignment offsets)', () => {
    // textAdvanceWidth takes no mirror flag by design: the pen span is what
    // effectiveStartOffsetMm aligns with, and mirroring must not move it.
    expect(textAdvanceWidth('LAB', 8)).toBeGreaterThan(0)
  })
})

// ---- Outline local layout ---------------------------------------------------

describe('outline mirrored layout (outlineTextToContours)', () => {
  it('is exactly the unmirrored contours reflected about the advance midpoint (isHole preserved)', () => {
    const adv = outlineTextAdvanceWidth('O', 8)
    const plain = outlineTextToContours('O', 8)
    const mirrored = outlineTextToContours('O', 8, { mirrored: true })
    expect(mirrored.length).toBe(plain.length)
    expect(plain.some((c) => c.isHole)).toBe(true) // 'O' has a counter
    for (let i = 0; i < plain.length; i++) {
      expect(mirrored[i].isHole).toBe(plain[i].isHole)
      expect(mirrored[i].points).toEqual(
        plain[i].points.map((p) => ({ x: adv - p.x, y: p.y })),
      )
    }
  })

  it('winding reverses under the reflection (plan risk E, raw layout level)', () => {
    const plain = outlineTextToContours('O', 8)
    const mirrored = outlineTextToContours('O', 8, { mirrored: true })
    for (let i = 0; i < plain.length; i++) {
      const a0 = signedArea(plain[i].points)
      const a1 = signedArea(mirrored[i].points)
      expect(Math.abs(a1)).toBeCloseTo(Math.abs(a0), 6)
      expect(Math.sign(a1)).toBe(-Math.sign(a0))
    }
  })

  it('outline bbox reflects like the single-line one', () => {
    const adv = outlineTextAdvanceWidth('LAB', 8)
    const b0 = outlineTextLocalBBox('LAB', 8)!
    const b1 = outlineTextLocalBBox('LAB', 8, { mirrored: true })!
    expect(b1.minX).toBeCloseTo(adv - b0.maxX, 6)
    expect(b1.maxX).toBeCloseTo(adv - b0.minX, 6)
  })
})

// ---- Free world layout + on-path warp ---------------------------------------

describe('mirrored text: free world layout and on-path warp', () => {
  it('FREE: world polylines are the mirrored local layout placed at the anchor', () => {
    const at = { x: 10, y: 5 }
    const local = textToPolylines('LAB', 8, { mirrored: true })
    const world = textToWorldPolylines('LAB', 8, at, 0, { mirrored: true })
    expect(world).toEqual(
      local.map((poly) => poly.map((p) => ({ x: at.x + p.x, y: at.y + p.y }))),
    )
  })

  it('ON-PATH: the warp consumes the mirrored local layout (straight line = translated layout)', () => {
    // On the +X line with offset 20 and no flip, warp maps local (x, y) ->
    // (20 + x, y) exactly (collinear densification).
    const e = textEnt({ pathId: 'ln', pathOffsetMm: 20, pathAlign: 'free', mirrored: true })
    const world = textOnPathToWorldPolylines(e, LINE)
    const local = textToPolylines(e.text, e.height, { mirrored: true })
    expect(world.length).toBe(local.length)
    for (let i = 0; i < local.length; i++) {
      for (let j = 0; j < local[i].length; j++) {
        expect(world[i][j].x).toBeCloseTo(20 + local[i][j].x, 9)
        expect(world[i][j].y).toBeCloseTo(local[i][j].y, 9)
      }
    }
  })

  it('ON-PATH: mirrored text occupies the SAME arc span as unmirrored (advance-midpoint choice)', () => {
    const e0 = textEnt({ pathId: 'ln', pathOffsetMm: 20, pathAlign: 'free' })
    const e1 = { ...e0, mirrored: true }
    const xs = (polys: Vec2[][]) => polys.flat().map((p) => p.x)
    const x0 = xs(textOnPathToWorldPolylines(e0, LINE))
    const x1 = xs(textOnPathToWorldPolylines(e1, LINE))
    const adv = textAdvanceWidth(e0.text, e0.height)
    // The occupied interval is REFLECTED inside [20, 20 + advance]: mirrored
    // extremes are 20 + (advance - (extreme - 20)) of the unmirrored ones.
    expect(Math.min(...x1)).toBeCloseTo(20 + adv - (Math.max(...x0) - 20), 9)
    expect(Math.max(...x1)).toBeCloseTo(20 + adv - (Math.min(...x0) - 20), 9)
  })

  it('ON-PATH outline: contours warp mirrored with isHole preserved', () => {
    const e = textEnt({
      fontStyle: 'outline', text: 'O',
      pathId: 'ln', pathOffsetMm: 20, pathAlign: 'free', mirrored: true,
    })
    const world = outlineTextOnPathToWorldContours(e, LINE)
    const local = outlineTextToContours('O', 8, { mirrored: true })
    expect(world.length).toBe(local.length)
    for (let i = 0; i < local.length; i++) {
      expect(world[i].isHole).toBe(local[i].isHole)
      for (let j = 0; j < local[i].points.length; j++) {
        expect(world[i].points[j].x).toBeCloseTo(20 + local[i].points[j].x, 9)
        expect(world[i].points[j].y).toBeCloseTo(local[i].points[j].y, 9)
      }
    }
  })
})

// ---- Pick metrics ------------------------------------------------------------

describe('mirrored text: pick metrics follow the mirrored layout', () => {
  it('FREE bbox pick: a point inside the MIRRORED extent hits (0) and misses unmirrored', () => {
    // 'L ' (trailing space): the glyph body sits LEFT unmirrored, RIGHT
    // mirrored -- a probe near the right end of the advance span
    // discriminates the two layouts.
    const adv = textAdvanceWidth('L ', 8)
    const b0 = textLocalBBox('L ', 8)!
    const probe = { x: adv - b0.minX - 0.05, y: 4 } // inside mirrored bbox
    expect(probe.x).toBeGreaterThan(b0.maxX) // ...and OUTSIDE the unmirrored one
    const at = { x: 0, y: 0 }
    expect(distanceToTextBBox('L ', 8, at, 0, probe, { mirrored: true })).toBe(0)
    expect(distanceToTextBBox('L ', 8, at, 0, probe)).toBeGreaterThan(0)
    // Far away still misses either way.
    expect(
      distanceToTextBBox('L ', 8, at, 0, { x: adv / 2, y: 16 }, { mirrored: true }),
    ).toBeGreaterThan(0)
  })

  it('ON-PATH band pick: the warped band sits over the mirrored glyphs', () => {
    const e = textEnt({
      text: 'L ', pathId: 'ln', pathOffsetMm: 20, pathAlign: 'free', mirrored: true,
    })
    const adv = textAdvanceWidth('L ', 8)
    const b0 = textLocalBBox('L ', 8)!
    // Same discriminating probe, translated onto the line (+20 along +X).
    const probe = { x: 20 + adv - b0.minX - 0.05, y: 4 }
    expect(textOnPathPickDistance(e, LINE, probe)).toBe(0)
    const plain = { ...e, mirrored: undefined }
    expect(textOnPathPickDistance(plain, LINE, probe)).toBeGreaterThan(0)
  })
})

// ---- Bake: winding / hole typing (plan risk E) + render/bake parity ---------

describe('bake: mirrored text', () => {
  it("mirrored outline 'O': the counter still types as a HOLE and winding is normalized to type", () => {
    const e = textEnt({ fontStyle: 'outline', text: 'O', mirrored: true })
    const { loops } = bakeSketch(sketchOf([e]), { newId: idFactory() })
    const contours = loops.filter((l) => l.type === 'contour')
    const holes = loops.filter((l) => l.type === 'hole')
    expect(contours).toHaveLength(1)
    expect(holes).toHaveLength(1)
    expect(holes[0].area).toBeLessThan(contours[0].area)
    // Repo convention (path2d): CCW = contour, CW = hole -- the mirrored
    // reversed as-drawn winding must have been normalized away.
    expect(signedArea(contours[0].points)).toBeGreaterThan(0)
    expect(signedArea(holes[0].points)).toBeLessThan(0)
  })

  it("mirrored counter glyph 'A' free vs unmirrored: same loop typing (1 contour + 1 hole)", () => {
    const type = (mirrored: boolean) => {
      const e = textEnt({ fontStyle: 'outline', text: 'A', ...(mirrored ? { mirrored } : {}) })
      const { loops } = bakeSketch(sketchOf([e]), { newId: idFactory() })
      return loops.map((l) => l.type).sort()
    }
    expect(type(true)).toEqual(type(false))
    expect(type(true)).toEqual(['contour', 'hole'])
  })

  it('render/bake PARITY: a mirrored ON-PATH single-line text bakes the exact rendered strokes', () => {
    // Single-line strokes bake as OPEN loops (no winding normalization), so
    // the baked points must equal the render wrapper's output verbatim --
    // both sides consume the ONE mirrored local layout.
    const e = textEnt({
      text: 'LAB', pathId: 'ln', pathOffsetMm: 20, pathAlign: 'free', mirrored: true,
    })
    const { loops } = bakeSketch(sketchOf([LINE, e]), { newId: idFactory() })
    const rendered = textOnPathToWorldPolylines(e, LINE)
    // Text loops are pushed LAST by the bake (after edge chains -- the LINE
    // itself bakes an open loop too), so compare the tail.
    const textLoops = loops.filter((l) => !l.closed).slice(-rendered.length)
    expect(textLoops.map((l) => l.points)).toEqual(rendered)
  })

  it('render/bake PARITY: a mirrored FREE single-line text bakes the exact rendered strokes', () => {
    const e = textEnt({ text: 'LAB', at: { x: 7, y: 3 }, mirrored: true })
    const { loops } = bakeSketch(sketchOf([e]), { newId: idFactory() })
    const rendered = textToWorldPolylines('LAB', 8, { x: 7, y: 3 }, 0, { mirrored: true })
    expect(loops.map((l) => l.points)).toEqual(rendered)
  })

  it('ABSENT mirrored bakes byte-identically to before (legacy)', () => {
    const legacy = textEnt({ text: 'LAB' })
    const explicit = textEnt({ text: 'LAB', mirrored: false })
    const a = bakeSketch(sketchOf([legacy]), { newId: idFactory() })
    const b = bakeSketch(sketchOf([explicit]), { newId: idFactory() })
    expect(b.loops.map((l) => l.points)).toEqual(a.loops.map((l) => l.points))
  })
})

// ---- Letter spacing + mirror consistency (bake/render parity) -------------
//
// Mirror reflects the SPACED layout about the spaced advance midpoint, so a
// mirrored + spaced text must span the same width as its unmirrored twin and
// bake to exactly the geometry the renderer draws.
describe('letter spacing + mirror stay consistent', () => {
  const S = 3
  const bboxOf = (pts: Vec2[]) => {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
    for (const p of pts) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x)
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y)
    }
    return { minX, maxX, minY, maxY }
  }

  it('mirror preserves the SPACED span (mirrored width == unmirrored width)', () => {
    const plain = textLocalBBox('ABC', 10, { letterSpacingMm: S })!
    const mir = textLocalBBox('ABC', 10, { letterSpacingMm: S, mirrored: true })!
    const wp = plain.maxX - plain.minX
    const wm = mir.maxX - mir.minX
    expect(Math.abs(wm - wp)).toBeLessThan(1e-6)
    // Both grew by (N-1)*S vs the unspaced width (spacing threaded, not dropped).
    const base = textLocalBBox('ABC', 10)!
    expect(wp - (base.maxX - base.minX)).toBeCloseTo((3 - 1) * S, 6)
  })

  it('mirrored + spaced FREE single-line: bake geometry == render geometry', () => {
    const e = textEnt({ text: 'ABC', mirrored: true, letterSpacingMm: S })
    const render = textToWorldPolylines(
      'ABC', 8, e.at, e.rotation ?? 0, { mirrored: true, letterSpacingMm: S },
    )
    const { loops } = bakeSketch(sketchOf([e]), { newId: idFactory() })
    const rb = bboxOf(render.flat())
    const bb = bboxOf(loops.flatMap((l) => l.points))
    expect(bb.minX).toBeCloseTo(rb.minX, 6)
    expect(bb.maxX).toBeCloseTo(rb.maxX, 6)
    expect(bb.minY).toBeCloseTo(rb.minY, 6)
    expect(bb.maxY).toBeCloseTo(rb.maxY, 6)
  })

  it('mirrored + spaced OUTLINE: mirror preserves the spaced advance span', () => {
    const adv = outlineTextAdvanceWidth('ABC', 10, { letterSpacingMm: S })
    const mir = outlineTextLocalBBox('ABC', 10, { letterSpacingMm: S, mirrored: true })!
    const plain = outlineTextLocalBBox('ABC', 10, { letterSpacingMm: S })!
    // The mirror maps x -> advance - x, so both bboxes lie within [0, advance]
    // and share the same width.
    expect((mir.maxX - mir.minX)).toBeCloseTo(plain.maxX - plain.minX, 4)
    expect(mir.maxX).toBeLessThanOrEqual(adv + 1e-3)
    expect(mir.minX).toBeGreaterThanOrEqual(-1e-3)
  })
})
