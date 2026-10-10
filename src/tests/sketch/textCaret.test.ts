// In-canvas text CARET (M1b). Headless coverage of textCaretWorldSegment
// (textOnPath.ts): the caret's local x is the SUBSTRING advance under the
// entity's own style (single-line / outline), reflected for mirror; the world
// segment rides the SAME transforms as the glyphs -- on-path warp (perpendicular
// to the path at the insertion point, radial on a circle, shifted by pathAlign)
// or the free anchor+rotation placement. Empty text carets at the layout
// origin; an orphan path yields null; the index clamps.

import { describe, it, expect } from 'vitest'
import {
  textCaretWorldSegment, textEntityAdvanceMm, effectiveStartOffsetMm, pathLUT,
} from '../../lib/sketch/textOnPath'
import { textAdvanceWidth } from '../../lib/sketch/text'
import { outlineTextAdvanceWidth } from '../../lib/sketch/textOutline'
import type {
  SketchEntity, SketchLineEntity, SketchTextEntity,
} from '../../lib/sketch/types'
import type { Vec2 } from '../../types'

const H = 8
// Caret local extents (must mirror CARET_DESCENT_FRAC in textOnPath.ts).
const DESC = 0.18 * H

function freeText(over: Partial<SketchTextEntity> = {}): SketchTextEntity {
  return {
    id: 't', kind: 'text', construction: false, at: { x: 0, y: 0 },
    text: 'AB', height: H, rotation: 0, fontStyle: 'single-line', ...over,
  }
}

const line: SketchLineEntity = {
  id: 'ln', kind: 'line', construction: false,
  start: { x: 0, y: 0 }, end: { x: 100, y: 0 },
}

function onPathText(over: Partial<SketchTextEntity> = {}): SketchTextEntity {
  return freeText({ pathId: 'ln', ...over })
}

const sub = (v: Vec2, w: Vec2): Vec2 => ({ x: v.x - w.x, y: v.y - w.y })

describe('textCaretWorldSegment: local caret x (free text at origin)', () => {
  // Free text at (0,0) rotation 0: world == local, so the segment's shared x
  // IS the local caret x.
  it('single-line: x at index 0 / mid / end equals the substring advance', () => {
    const e = freeText({ text: 'HIP' })
    for (const i of [0, 1, 2, 3]) {
      const seg = textCaretWorldSegment(e, [e], i)!
      const want = textAdvanceWidth('HIP'.slice(0, i), H)
      expect(seg[0].x).toBeCloseTo(want, 9)
      expect(seg[1].x).toBeCloseTo(want, 9)
      // Vertical extents: slight descender dip to the cap line.
      expect(seg[0].y).toBeCloseTo(-DESC, 9)
      expect(seg[1].y).toBeCloseTo(H, 9)
    }
  })

  it('outline: x equals the OUTLINE substring advance (not the Hershey one)', () => {
    const e = freeText({ text: 'AB', fontStyle: 'outline' })
    for (const i of [0, 1, 2]) {
      const seg = textCaretWorldSegment(e, [e], i)!
      expect(seg[0].x).toBeCloseTo(outlineTextAdvanceWidth('AB'.slice(0, i), H), 9)
    }
    // Sanity: the two font systems measure differently (the test would be
    // vacuous if they happened to agree everywhere).
    expect(outlineTextAdvanceWidth('A', H)).not.toBeCloseTo(textAdvanceWidth('A', H), 1)
  })

  it('mirrored: x reflects about the advance midpoint (x\' = advance - x)', () => {
    const e = freeText({ text: 'AB', mirrored: true })
    const adv = textEntityAdvanceMm(e)
    for (const i of [0, 1, 2]) {
      const seg = textCaretWorldSegment(e, [e], i)!
      expect(seg[0].x).toBeCloseTo(adv - textAdvanceWidth('AB'.slice(0, i), H), 9)
    }
  })

  it('clamps the index to [0, text.length]', () => {
    const e = freeText({ text: 'AB' })
    expect(textCaretWorldSegment(e, [e], 999)).toEqual(textCaretWorldSegment(e, [e], 2))
    expect(textCaretWorldSegment(e, [e], -5)).toEqual(textCaretWorldSegment(e, [e], 0))
  })

  it('EMPTY text carets at the layout origin (visible before typing)', () => {
    const e = freeText({ text: '', at: { x: 3, y: 4 } })
    const seg = textCaretWorldSegment(e, [e], 0)!
    expect(seg[0].x).toBeCloseTo(3, 9)
    expect(seg[0].y).toBeCloseTo(4 - DESC, 9)
    expect(seg[1].x).toBeCloseTo(3, 9)
    expect(seg[1].y).toBeCloseTo(4 + H, 9)
  })
})

describe('textCaretWorldSegment: free text follows anchor + rotation', () => {
  it('rotates the caret with the layout (90 deg about the anchor)', () => {
    const e = freeText({ text: 'A', at: { x: 5, y: 7 }, rotation: Math.PI / 2 })
    const x = textAdvanceWidth('A', H)
    const seg = textCaretWorldSegment(e, [e], 1)!
    // R90 maps local (x, y) -> (-y, x), then translate by `at`.
    expect(seg[0].x).toBeCloseTo(5 + DESC, 9)
    expect(seg[0].y).toBeCloseTo(7 + x, 9)
    expect(seg[1].x).toBeCloseTo(5 - H, 9)
    expect(seg[1].y).toBeCloseTo(7 + x, 9)
  })
})

describe('textCaretWorldSegment: on-path (straight line)', () => {
  it('is PERPENDICULAR to the path with its foot at pointAt(start + caret x)', () => {
    const e = onPathText({ text: 'HI', pathAlign: 'free', pathOffsetMm: 10 })
    const lut = pathLUT(line)!
    for (const i of [0, 1, 2]) {
      const seg = textCaretWorldSegment(e, [line, e], i)!
      const dir = sub(seg[1], seg[0])
      const s = 10 + textAdvanceWidth('HI'.slice(0, i), H)
      const tan = lut.tangentAt(s)
      // Dot-product check: caret _|_ path tangent at the insertion point.
      expect(dir.x * tan.x + dir.y * tan.y).toBeCloseTo(0, 9)
      // Foot (the baseline point, DESC/(DESC+H) up the segment) sits ON the
      // curve at arc length s.
      const t = DESC / (DESC + H)
      const foot = { x: seg[0].x + dir.x * t, y: seg[0].y + dir.y * t }
      const base = lut.pointAt(s)
      expect(foot.x).toBeCloseTo(base.x, 9)
      expect(foot.y).toBeCloseTo(base.y, 9)
    }
  })

  it('pathAlign center/right shift the caret foot by the shared offset formulas', () => {
    const lut = pathLUT(line)!
    for (const align of ['center', 'right'] as const) {
      const e = onPathText({ text: 'HI', pathAlign: align })
      const start = effectiveStartOffsetMm(e, lut, textEntityAdvanceMm(e))
      const seg = textCaretWorldSegment(e, [line, e], 2)!
      // Straight +X line: both endpoints share the foot's x = start + caret x.
      expect(seg[0].x).toBeCloseTo(start + textAdvanceWidth('HI', H), 9)
      expect(seg[1].x).toBeCloseTo(seg[0].x, 9)
    }
  })

  it('pathFlip walks the caret BACKWARD from the start offset (glyph parity)', () => {
    // left + flip: start = advance, s = advance - caret x; caret 0 sits at
    // s = advance -- exactly where the flipped layout puts index 0.
    const e = onPathText({ text: 'HI', pathAlign: 'left', pathFlip: true })
    const adv = textEntityAdvanceMm(e)
    const seg0 = textCaretWorldSegment(e, [line, e], 0)!
    expect(seg0[0].x).toBeCloseTo(adv, 9)
    const segEnd = textCaretWorldSegment(e, [line, e], 2)!
    expect(segEnd[0].x).toBeCloseTo(0, 9)
    // Flip negates the normal: the caret hangs on the other side of the line.
    expect(seg0[1].y).toBeCloseTo(-H, 9)
  })

  it('mirrored on-path: caret foot lands where the mirrored glyphs emit', () => {
    const e = onPathText({ text: 'HI', pathAlign: 'free', pathOffsetMm: 10, mirrored: true })
    const adv = textEntityAdvanceMm(e)
    const seg = textCaretWorldSegment(e, [line, e], 0)!
    expect(seg[0].x).toBeCloseTo(10 + adv, 9) // index 0 reflects to the far end
  })
})

describe('textCaretWorldSegment: on-path (circle) is radial', () => {
  const circle: SketchEntity = {
    id: 'c', kind: 'circle', construction: false,
    center: { x: 0, y: 0 }, radius: 20,
  }

  it('the segment points along the radius at the insertion point', () => {
    const e = freeText({ text: 'HI', pathId: 'c', pathAlign: 'center' })
    const lut = pathLUT(circle)!
    for (const i of [0, 1, 2]) {
      const seg = textCaretWorldSegment(e, [circle, e], i)!
      const dir = sub(seg[1], seg[0])
      const dirLen = Math.hypot(dir.x, dir.y)
      const s = effectiveStartOffsetMm(e, lut, textEntityAdvanceMm(e))
        + textAdvanceWidth('HI'.slice(0, i), H)
      const radial = lut.pointAt(s) // center is the origin
      const radLen = Math.hypot(radial.x, radial.y)
      // Normalized cross ~ 0 => parallel to the radius (the LUT's dense
      // tessellation leaves a sub-0.01-rad chordal angle at r=20).
      const crossUnit =
        (dir.x * radial.y - dir.y * radial.x) / (dirLen * radLen)
      expect(Math.abs(crossUnit)).toBeLessThan(0.01)
    }
  })
})

describe('textCaretWorldSegment: fail-safe returns', () => {
  it('an ORPHAN pathId returns null (fallback already reported loudly)', () => {
    const e = freeText({ text: 'HI', pathId: 'gone' })
    expect(textCaretWorldSegment(e, [e], 1)).toBeNull()
  })

  it('a non-positive height returns null', () => {
    const e = freeText({ text: 'HI', height: 0 })
    expect(textCaretWorldSegment(e, [e], 1)).toBeNull()
  })
})
