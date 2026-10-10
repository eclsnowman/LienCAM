// Text bounding-box PICK metric (D-E, TEXT-REDESIGN-PLAN item 3). The
// hover/select/double-click target for text is its full BOX -- with the old
// stroke/contour metric an 8px tolerance missed inside letter counters (the
// hole in 'O') and between glyphs. Headless coverage of distanceToTextBBox
// (single-line), distanceToOutlineTextBBox (outline), and
// textOnPathPickDistance (the warped band along a path). The stroke metrics
// (distanceToText / distanceToOutlineText) stay as-is for SNAPPING and are
// asserted here as the contrast case.

import { describe, it, expect } from 'vitest'
import {
  textLocalBBox, distanceToTextBBox, distanceToText,
} from '../../lib/sketch/text'
import {
  outlineTextLocalBBox, distanceToOutlineTextBBox, distanceToOutlineText,
} from '../../lib/sketch/textOutline'
import {
  textOnPathPickDistance, warpLocalToPath, buildArcLengthLUT,
  sampleEntityToPolyline, pointHitsTextEntity,
} from '../../lib/sketch/textOnPath'
import { pickNearestEntity } from '../../lib/sketch/sketcher/sketchLayer'
import type {
  SketchEntity, SketchLineEntity, SketchTextEntity,
} from '../../lib/sketch/types'

// ---- Free text: outline (letter counter) ------------------------------------

describe('distanceToOutlineTextBBox: inside a letter counter', () => {
  const h = 8
  const at = { x: 0, y: 0 }
  const box = outlineTextLocalBBox('O', h)!
  const counter = { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 }

  it("a click in the middle of the 'O' (inside the counter) hits: distance 0", () => {
    expect(distanceToOutlineTextBBox('O', h, at, 0, counter)).toBe(0)
  })
  it('the old contour metric MISSED there (contrast: why the bbox exists)', () => {
    // The counter center sits well off the glyph boundary -- farther than any
    // sane world-space pick tolerance at normal zoom.
    expect(distanceToOutlineText('O', h, at, 0, counter)).toBeGreaterThan(0.5)
  })
  it('degenerate text stays unpickable (Infinity)', () => {
    expect(distanceToOutlineTextBBox('', h, at, 0, counter)).toBe(Infinity)
    expect(distanceToTextBBox('   ', h, at, 0, counter)).toBe(Infinity)
  })
})

// ---- Free text: single-line (between glyphs, far away, rotation) ------------

describe('distanceToTextBBox: between glyphs / distance falloff', () => {
  const h = 21 // Hershey scale 1: cap line at y = 21
  const at = { x: 0, y: 0 }
  const box = textLocalBBox('I I', h)!
  const gap = { x: (box.minX + box.maxX) / 2, y: h / 2 } // mid-gap, mid-height

  it("a click between the two 'I' strokes hits: distance 0", () => {
    expect(distanceToTextBBox('I I', h, at, 0, gap)).toBe(0)
  })
  it('the old stroke metric measured a real gap there (contrast)', () => {
    expect(distanceToText('I I', h, at, 0, gap)).toBeGreaterThan(1)
  })
  it('a click ~2x cap height BELOW the box does not hit', () => {
    const d = distanceToTextBBox('I I', h, at, 0, { x: gap.x, y: -2 * h })
    expect(d).toBeGreaterThan(1.5 * h)
  })
  it('a click ~2x cap height ABOVE the box does not hit', () => {
    const d = distanceToTextBBox('I I', h, at, 0, { x: gap.x, y: h + 2 * h })
    expect(d).toBeGreaterThan(1.5 * h)
  })
})

describe('distanceToTextBBox: the box follows rotation', () => {
  const h = 10
  const at = { x: 100, y: 50 }
  const text = 'IIIII' // wide enough that a 90deg turn visibly moves the box
  const box = textLocalBBox(text, h)!
  const cx = (box.minX + box.maxX) / 2
  const cy = (box.minY + box.maxY) / 2

  it('sanity: the layout is wider than it is tall (so rotation is observable)', () => {
    expect(box.maxX - box.minX).toBeGreaterThan(box.maxY - box.minY)
  })
  it('a point inside the UNROTATED box hits at rotation 0', () => {
    expect(distanceToTextBBox(text, h, at, 0, { x: at.x + cx, y: at.y + cy })).toBe(0)
  })
  it('the same world point misses once the text rotates 90deg', () => {
    const d = distanceToTextBBox(text, h, at, Math.PI / 2, { x: at.x + cx, y: at.y + cy })
    expect(d).toBeGreaterThan(0)
  })
  it('the box center rotated WITH the text hits at rotation 90deg', () => {
    // local (cx, cy) rotated +90deg about the anchor -> world (at.x - cy, at.y + cx)
    const p = { x: at.x - cy, y: at.y + cx }
    expect(distanceToTextBBox(text, h, at, Math.PI / 2, p)).toBe(0)
  })
})

// ---- On-path text: warped band ----------------------------------------------

function textOn(path: string, extra: Partial<SketchTextEntity> = {}): SketchTextEntity {
  return {
    id: 't', kind: 'text', construction: false, at: { x: 0, y: 0 },
    text: 'AB', height: 8, fontStyle: 'single-line', pathId: path, ...extra,
  }
}

describe('textOnPathPickDistance: straight line (identity warp)', () => {
  // A +X line warps the layout by pure translation: band = local bbox + offset.
  const line: SketchLineEntity = {
    id: 'ln', kind: 'line', construction: false,
    start: { x: 0, y: 0 }, end: { x: 200, y: 0 },
  }
  const off = 10
  const e = textOn('ln', { pathOffsetMm: off })
  const box = textLocalBBox('AB', 8)!
  const midX = (box.minX + box.maxX) / 2

  it('a click inside the band (mid-text, mid-height) hits: distance 0', () => {
    expect(textOnPathPickDistance(e, line, { x: off + midX, y: 4 })).toBe(0)
  })
  it('a click ~2x cap height off the path does not hit', () => {
    const d = textOnPathPickDistance(e, line, { x: off + midX, y: 8 + 2 * 8 })
    expect(d).toBeGreaterThan(8)
  })
  it('a click well before the text start along the path does not hit', () => {
    const d = textOnPathPickDistance(e, line, { x: off + box.minX - 16, y: 4 })
    expect(d).toBeGreaterThan(8)
  })
  it('pathFlip moves the band to the other side / reading direction', () => {
    const flipped = textOn('ln', { pathOffsetMm: off, pathFlip: true })
    // flip: s walks backward and the normal negates -> world (off - x, -y).
    expect(textOnPathPickDistance(flipped, line, { x: off - midX, y: -4 })).toBe(0)
    expect(textOnPathPickDistance(flipped, line, { x: off + midX, y: 4 })).toBeGreaterThan(0)
  })
})

describe('textOnPathPickDistance: curved path (circle)', () => {
  const circle: SketchEntity = {
    id: 'c', kind: 'circle', construction: false, center: { x: 0, y: 0 }, radius: 50,
  }
  const e = textOn('c', { text: 'ABC' })
  const box = textLocalBBox('ABC', 8)!

  it('the warped layout center is inside the warped band: distance 0', () => {
    // Warp the local bbox center through the SAME warp the renderer uses --
    // wherever the text actually draws, the pick must hit.
    const sampled = sampleEntityToPolyline(circle)!
    const lut = buildArcLengthLUT(sampled.points, sampled.closed)
    const center = warpLocalToPath(
      [[{ x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 }]],
      lut, 0, false,
    )[0][0]
    expect(textOnPathPickDistance(e, circle, center)).toBe(0)
  })
  it('the circle center (far from the band) does not hit', () => {
    expect(textOnPathPickDistance(e, circle, { x: 0, y: 0 })).toBeGreaterThan(30)
  })
  it('degenerate text on a path stays unpickable (Infinity)', () => {
    const empty = textOn('c', { text: '  ' })
    expect(textOnPathPickDistance(empty, circle, { x: 50, y: 0 })).toBe(Infinity)
  })
})

// ---- pointHitsTextEntity: the M1c click-on-edited-text guard metric ---------

describe('pointHitsTextEntity (M1c guard): same metric dispatch as the pick', () => {
  const h = 10
  const at = { x: 100, y: 50 }
  const wide = 'IIIII' // wide >> tall so a 90deg turn visibly moves the box
  const box = textLocalBBox(wide, h)!
  const cx = (box.minX + box.maxX) / 2
  const cy = (box.minY + box.maxY) / 2
  const rotated: SketchTextEntity = {
    id: 'tf', kind: 'text', construction: false,
    at, text: wide, height: h, rotation: Math.PI / 2, fontStyle: 'single-line',
  }

  it('free ROTATED text: the box center rotated WITH the text hits', () => {
    // local (cx, cy) rotated +90deg about the anchor -> world (at.x - cy, at.y + cx)
    const p = { x: at.x - cy, y: at.y + cx }
    expect(pointHitsTextEntity(rotated, [rotated], p, 0.5)).toBe(true)
  })
  it('free ROTATED text: the UNROTATED center point misses', () => {
    const p = { x: at.x + cx, y: at.y + cy }
    expect(pointHitsTextEntity(rotated, [rotated], p, 0.5)).toBe(false)
  })

  const line: SketchLineEntity = {
    id: 'ln', kind: 'line', construction: false,
    start: { x: 0, y: 0 }, end: { x: 100, y: 0 },
  }
  const onPath = textOn('ln', { pathOffsetMm: 20 })
  const pbox = textLocalBBox('AB', 8)!
  const pMidX = 20 + (pbox.minX + pbox.maxX) / 2

  it('on-path text: inside the warped band hits', () => {
    expect(pointHitsTextEntity(onPath, [line, onPath], { x: pMidX, y: 4 }, 0.5))
      .toBe(true)
  })
  it('on-path text: off the band (above cap height + tol) misses', () => {
    expect(pointHitsTextEntity(
      onPath, [line, onPath], { x: pMidX, y: pbox.maxY + 3 }, 0.5,
    )).toBe(false)
  })

  it('a non-text entity never hits (even ON the entity)', () => {
    expect(pointHitsTextEntity(line, [line], { x: 50, y: 0 }, 0.5)).toBe(false)
  })
  it('degenerate (empty) text has no box -> never hits', () => {
    const empty: SketchTextEntity = {
      id: 'te', kind: 'text', construction: false,
      at, text: '', height: h, rotation: 0, fontStyle: 'single-line',
    }
    expect(pointHitsTextEntity(empty, [empty], at, 0.5)).toBe(false)
  })
})

// ---- pickNearestEntity: text tie-break (container beats coincident curve) ---

describe('pickNearestEntity: text tie-break vs strictly-nearest', () => {
  // Path line along +X; text 'AB' (height 8) rides it at offset 10, so the
  // warped band is the local bbox translated by (10, 0). A second line
  // crosses the band at mid-height y=4 (the "curve stroke lying on the
  // text" case). CREATION ORDER puts both lines BEFORE the text -- the
  // iteration order under which the old strict '<' let a tied curve win.
  const path: SketchLineEntity = {
    id: 'ln', kind: 'line', construction: false,
    start: { x: 0, y: 0 }, end: { x: 100, y: 0 },
  }
  const cross: SketchLineEntity = {
    id: 'cross', kind: 'line', construction: false,
    start: { x: 0, y: 4 }, end: { x: 100, y: 4 },
  }
  const text = textOn('ln', { pathOffsetMm: 10 })
  const entities: SketchEntity[] = [path, cross, text]
  const box = textLocalBBox('AB', 8)!
  const midX = 10 + (box.minX + box.maxX) / 2

  it('EXACT tie (click ON a curve inside the text band) picks the TEXT', () => {
    // On the cross line (d=0) and inside the band (d=0): tie within the
    // epsilon -> the text (container) wins; double-click can open the editor.
    expect(pickNearestEntity(entities, midX, 4, 1)).toBe('t')
  })

  it('inside the band, 0.006mm off the curve, picks the TEXT', () => {
    // The proof-drive defect distance: band d=0, curve d=0.006 -- the text
    // is strictly nearer AND would win the tie; either way it must win.
    expect(pickNearestEntity(entities, midX, 4.006, 1)).toBe('t')
  })

  it('control: nearer the curve and OUTSIDE the text box picks the curve', () => {
    // Before the text start along the path: on the path line (d=0), well
    // outside the band (d >> epsilon) -- strictly nearest still wins.
    const wx = 10 + box.minX - 5
    expect(pickNearestEntity(entities, wx, 0, 1)).toBe('ln')
  })

  it('control: no entity within tolerance returns null', () => {
    expect(pickNearestEntity(entities, midX, 40, 1)).toBeNull()
  })
})
