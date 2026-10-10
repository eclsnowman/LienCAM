// Pure single-line (Hershey) text geometry (sketch text C3, part A). Headless
// coverage of text.ts + fonts/hersheySimplex.ts: glyph -> stroke count,
// open-ness, height scaling, left-to-right advance/layout, space handling,
// empty/whitespace/zero-height degeneracy, unknown-char fallback, world
// transform (anchor + rotation), and nearest-stroke distance.

import { describe, it, expect } from 'vitest'
import {
  textToPolylines, textToWorldPolylines, distanceToText, isDegenerateText,
  textAdvanceWidth, textLocalBBox,
} from '../../lib/sketch/text'
import { hersheyGlyph } from '../../lib/sketch/fonts/hersheySimplex'
import type { Vec2 } from '../../types'

const close = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps

function bbox(polys: Vec2[][]) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const poly of polys) for (const p of poly) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x)
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y)
  }
  return { minX, maxX, minY, maxY }
}

describe('font table (Hershey futural)', () => {
  it("'A' decodes to 3 strokes; glyph stroke count drives polyline count", () => {
    // 'A' = left diagonal + right diagonal + crossbar = 3 strokes.
    expect(hersheyGlyph('A'.charCodeAt(0))!.strokes.length).toBe(3)
    expect(textToPolylines('A', 10).length).toBe(3)
  })
  it("'I' decodes to a single 2-point vertical stroke", () => {
    const g = hersheyGlyph('I'.charCodeAt(0))!
    expect(g.strokes.length).toBe(1)
    expect(g.strokes[0].length).toBe(2)
  })
  it('space (code 32) carries no glyph (advance only)', () => {
    expect(hersheyGlyph(32)).toBeNull()
  })
})

describe('textToPolylines: open strokes', () => {
  it('every stroke is an OPEN polyline (first != last, >= 2 points)', () => {
    const polys = textToPolylines('AVE', 8)
    expect(polys.length).toBeGreaterThan(0)
    for (const poly of polys) {
      expect(poly.length).toBeGreaterThanOrEqual(2)
      const a = poly[0], b = poly[poly.length - 1]
      expect(close(a.x, b.x) && close(a.y, b.y)).toBe(false)
    }
  })
})

describe('textToPolylines: height scaling (cap height == height)', () => {
  it("'A' spans 0..height vertically with a baseline-left origin", () => {
    const h = 12
    const { minX, minY, maxY } = bbox(textToPolylines('A', h))
    expect(close(minY, 0, 1e-6)).toBe(true)        // baseline at y = 0
    expect(close(maxY, h, 1e-6)).toBe(true)        // cap line at y = height
    expect(minX).toBeGreaterThanOrEqual(0)         // left of the first glyph
  })
  it('doubling the height doubles the vertical extent', () => {
    const a = bbox(textToPolylines('B', 5)).maxY
    const b = bbox(textToPolylines('B', 10)).maxY
    expect(close(b, a * 2, 1e-6)).toBe(true)
  })
})

describe('textToPolylines: left-to-right advance / layout', () => {
  it('a longer string is wider (glyphs advance rightward)', () => {
    const w1 = bbox(textToPolylines('A', 8)).maxX
    const w2 = bbox(textToPolylines('AA', 8)).maxX
    const w3 = bbox(textToPolylines('AAA', 8)).maxX
    expect(w2).toBeGreaterThan(w1)
    expect(w3).toBeGreaterThan(w2)
  })
  it('a space adds horizontal advance (A_B wider than AB)', () => {
    const noSpace = bbox(textToPolylines('AB', 8)).maxX
    const withSpace = bbox(textToPolylines('A B', 8)).maxX
    expect(withSpace).toBeGreaterThan(noSpace)
  })
})

describe('textToPolylines: degeneracy', () => {
  it('empty string -> no strokes', () => {
    expect(textToPolylines('', 5)).toEqual([])
    expect(isDegenerateText('', 5)).toBe(true)
  })
  it('whitespace-only string -> no strokes', () => {
    expect(textToPolylines('   ', 5)).toEqual([])
    expect(isDegenerateText('  \t ', 5)).toBe(true)
  })
  it('non-positive height -> no strokes', () => {
    expect(textToPolylines('ABC', 0)).toEqual([])
    expect(textToPolylines('ABC', -3)).toEqual([])
    expect(isDegenerateText('ABC', 0)).toBe(true)
  })
})

describe('textToPolylines: unknown-char fallback', () => {
  it('an out-of-range code point renders the tofu box (not silently dropped)', () => {
    const polys = textToPolylines('ÿ', 10) // y-umlaut, code 255 (no glyph)
    expect(polys.length).toBeGreaterThan(0)
  })
})

describe('textToWorldPolylines: anchor + rotation', () => {
  it('translates the local layout to the anchor', () => {
    const at = { x: 100, y: 50 }
    const local = textToPolylines('I', 21)
    const world = textToWorldPolylines('I', 21, at, 0)
    expect(close(world[0][0].x, local[0][0].x + at.x)).toBe(true)
    expect(close(world[0][0].y, local[0][0].y + at.y)).toBe(true)
  })
  it('90deg rotation maps local +x to world +y about the anchor', () => {
    const world = textToWorldPolylines('I', 21, { x: 0, y: 0 }, Math.PI / 2)
    // 'I' local point (4, 0) -> rotate +90deg -> (0, 4).
    const onStroke = world[0].some((p) => close(p.x, 0, 1e-6) && close(p.y, 4, 1e-6))
    expect(onStroke).toBe(true)
  })
})

describe('distanceToText', () => {
  it('a point ON a stroke projects to ~zero distance', () => {
    // 'I' at origin, height 21 (scale 1): the vertical stroke is x=4, y 0..21.
    const d = distanceToText('I', 21, { x: 0, y: 0 }, 0, { x: 4, y: 10 })
    expect(d).toBeLessThan(1e-6)
  })
  it('a far point projects to a finite, large distance', () => {
    const d = distanceToText('I', 21, { x: 0, y: 0 }, 0, { x: 200, y: 200 })
    expect(d).toBeGreaterThan(100)
    expect(Number.isFinite(d)).toBe(true)
  })
})

// ---- Letter spacing (tracking): single-line -------------------------------
//
// Spacing is absolute mm added BETWEEN glyphs -- N glyphs get (N-1) gaps, no
// trailing space -- threaded through the ONE layout so advance AND bbox
// inherit it identically. Zero/undefined must be byte-identical to today.
describe('letter spacing (single-line, one layout source)', () => {
  it('advance widens by exactly (N-1)*spacing for an N-glyph string', () => {
    const s = 2
    const base = textAdvanceWidth('ABCD', 10)             // N = 4
    const spaced = textAdvanceWidth('ABCD', 10, { letterSpacingMm: s })
    expect(close(spaced - base, (4 - 1) * s)).toBe(true)  // 3 gaps
  })
  it('negative spacing TIGHTENS the advance by (N-1)*|spacing|', () => {
    const base = textAdvanceWidth('ABC', 10)
    const tight = textAdvanceWidth('ABC', 10, { letterSpacingMm: -1.5 })
    expect(close(base - tight, (3 - 1) * 1.5)).toBe(true)
  })
  it('undefined / 0 spacing is byte-identical to today (regression)', () => {
    expect(textAdvanceWidth('HELLO', 8)).toBe(textAdvanceWidth('HELLO', 8, {}))
    expect(textAdvanceWidth('HELLO', 8, { letterSpacingMm: 0 }))
      .toBe(textAdvanceWidth('HELLO', 8))
  })
  it('bbox WIDTH grows by (N-1)*spacing; minX (first glyph) is unchanged', () => {
    const s = 3
    const b0 = textLocalBBox('AWA', 10)!                  // N = 3
    const b1 = textLocalBBox('AWA', 10, { letterSpacingMm: s })!
    expect(close(b1.minX, b0.minX)).toBe(true)            // first glyph unmoved
    const w0 = b0.maxX - b0.minX
    const w1 = b1.maxX - b1.minX
    expect(close(w1 - w0, (3 - 1) * s)).toBe(true)
  })
  it('glyph origins shift cumulatively: the 2nd glyph moves by one gap', () => {
    const s = 4
    // Layout of a 2-glyph string: the ONLY difference vs unspaced is the
    // second glyph shifted right by exactly one gap -> maxX grows by s,
    // minX (first glyph) stays put.
    const b0 = textLocalBBox('AV', 10)!
    const b1 = textLocalBBox('AV', 10, { letterSpacingMm: s })!
    expect(close(b1.maxX - b0.maxX, s)).toBe(true)
    expect(close(b1.minX, b0.minX)).toBe(true)
  })
})
