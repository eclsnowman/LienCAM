// Outline (filled-glyph / TTF) text geometry + bake + tool wiring (sketch
// text C3, part B). Mirrors text.test.ts / textTools.test.ts. Headless: the
// font is parsed with three.js's FontLoader and tessellated with
// Shape.generateShapes/extractPoints, which are pure JS (no WebGL/DOM) and
// RUN UNDER vitest/node -- so the 'O'-has-a-hole / scaling / bake cases are
// driven for REAL, not mocked. The pure layout helper (shapesToContours) is
// ALSO covered with mock glyph data to pin the contour/hole typing + the
// duplicate-closing-vertex drop independently of the font.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  outlineTextToContours, outlineTextToWorldContours, distanceToOutlineText,
  shapesToContours, type RawGlyphShape,
  outlineFont, registerFont, isFontRegistered, listFontFamilies, DEFAULT_FONT_FAMILY,
  fontPickerOptions, SINGLE_LINE_FONT_VALUE, SINGLE_LINE_FONT_LABEL,
  outlineTextAdvanceWidth, outlineTextLocalBBox,
} from '../../lib/sketch/textOutline'
import { textClick } from '../../lib/sketch/tools/textTools'
import { toolClick, type ToolState } from '../../lib/sketch/tools/toolMachine'
import { bakeSketch } from '../../lib/sketch/bake'
import { entitiesFromSolved } from '../../lib/sketch/solver/gcsMapping'
import type { Sketch, SketchEntity, SketchTextEntity, Vec2 } from '../../lib/sketch/types'

const close = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps

function bbox(contours: { points: Vec2[] }[]) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const c of contours) for (const p of c.points) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x)
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y)
  }
  return { minX, maxX, minY, maxY }
}

function idFactory(): () => string {
  let n = 0
  return () => `id${n++}`
}
function armed(tool: ToolState['tool']): ToolState {
  return { tool, chain: null }
}

// ---- Pure layout / typing (mock glyph data, no font) ----------------------

describe('shapesToContours (pure): contour/hole typing + dedup', () => {
  it('an outer ring -> contour; an interior ring -> hole', () => {
    const shapes: RawGlyphShape[] = [{
      shape: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
      holes: [[{ x: 3, y: 3 }, { x: 7, y: 3 }, { x: 7, y: 7 }, { x: 3, y: 7 }]],
    }]
    const cs = shapesToContours(shapes, 1)
    expect(cs.length).toBe(2)
    expect(cs[0].isHole).toBe(false)
    expect(cs[1].isHole).toBe(true)
  })

  it('drops the duplicate closing vertex (extractPoints repeats point 0)', () => {
    const shapes: RawGlyphShape[] = [{
      // 4 distinct corners + a repeated first point (closed-ring form).
      shape: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }, { x: 0, y: 0 }],
      holes: [],
    }]
    const cs = shapesToContours(shapes, 1)
    expect(cs[0].points.length).toBe(4) // closing dup removed
    const a = cs[0].points[0], b = cs[0].points[cs[0].points.length - 1]
    expect(close(a.x, b.x) && close(a.y, b.y)).toBe(false)
  })

  it('scales every vertex uniformly', () => {
    const shapes: RawGlyphShape[] = [{
      shape: [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }], holes: [],
    }]
    const cs = shapesToContours(shapes, 3)
    expect(cs[0].points).toContainEqual({ x: 6, y: 6 })
  })

  it('a degenerate ring (< 3 vertices) is dropped', () => {
    const shapes: RawGlyphShape[] = [{ shape: [{ x: 0, y: 0 }, { x: 1, y: 1 }], holes: [] }]
    expect(shapesToContours(shapes, 1)).toEqual([])
  })
})

// ---- Real font tessellation (three.js FontLoader, headless) ---------------

describe('outlineTextToContours (real font): holes + closure', () => {
  it("'O' yields an outer CONTOUR plus an inner HOLE", () => {
    const cs = outlineTextToContours('O', 10)
    const contours = cs.filter((c) => !c.isHole)
    const holes = cs.filter((c) => c.isHole)
    expect(contours.length).toBe(1)
    expect(holes.length).toBe(1)
  })

  it("'I' (no counter) yields a contour and NO hole", () => {
    const cs = outlineTextToContours('I', 10)
    expect(cs.some((c) => !c.isHole)).toBe(true)
    expect(cs.some((c) => c.isHole)).toBe(false)
  })

  it('every contour is a closed ring (>= 3 pts, first != last)', () => {
    for (const c of outlineTextToContours('Oo', 8)) {
      expect(c.points.length).toBeGreaterThanOrEqual(3)
      const a = c.points[0], b = c.points[c.points.length - 1]
      expect(close(a.x, b.x) && close(a.y, b.y)).toBe(false)
    }
  })

  it("cap height scales: 'H' top maps to ~the requested height", () => {
    const h = 12
    const { maxY } = bbox(outlineTextToContours('H', h))
    // Rounded terminals make this approximate; allow a small tolerance.
    expect(maxY).toBeGreaterThan(h * 0.9)
    expect(maxY).toBeLessThan(h * 1.1)
  })

  it('doubling the height ~doubles the vertical extent', () => {
    const a = bbox(outlineTextToContours('H', 5)).maxY
    const b = bbox(outlineTextToContours('H', 10)).maxY
    expect(close(b, a * 2, 1e-6)).toBe(true)
  })

  it('empty / whitespace / non-positive height -> no contours', () => {
    expect(outlineTextToContours('', 5)).toEqual([])
    expect(outlineTextToContours('   ', 5)).toEqual([])
    expect(outlineTextToContours('AB', 0)).toEqual([])
    expect(outlineTextToContours('AB', -3)).toEqual([])
  })

  it('world transform translates to the anchor', () => {
    const at = { x: 100, y: 50 }
    const local = outlineTextToContours('O', 8)
    const world = outlineTextToWorldContours('O', 8, at, 0)
    expect(close(world[0].points[0].x, local[0].points[0].x + at.x)).toBe(true)
    expect(close(world[0].points[0].y, local[0].points[0].y + at.y)).toBe(true)
  })

  it('distanceToOutlineText: a far point is finite + large', () => {
    const d = distanceToOutlineText('O', 8, { x: 0, y: 0 }, 0, { x: 500, y: 500 })
    expect(Number.isFinite(d)).toBe(true)
    expect(d).toBeGreaterThan(100)
  })
})

// ---- Bake: outline -> CLOSED contour + hole Loop2Ds ------------------------

describe('outline text bake -> CLOSED contour + hole loops', () => {
  const layerId = 'L'
  function sketchOf(entities: SketchEntity[]): Sketch {
    return {
      id: 'sk', layerId, entities, constraints: [], dimensions: [],
      solveStatus: { dof: 0, conflicting: [], redundant: [] },
    }
  }

  it("'O' bakes to a CLOSED contour loop + a CLOSED hole loop", () => {
    const e: SketchTextEntity = {
      id: 't1', kind: 'text', construction: false,
      at: { x: 0, y: 0 }, text: 'O', height: 10, rotation: 0, fontStyle: 'outline',
    }
    const { loops, bakedEntities } = bakeSketch(sketchOf([e]), { newId: idFactory() })
    expect(bakedEntities).toBe(1)
    expect(loops.length).toBe(2)
    expect(loops.every((l) => l.closed)).toBe(true)
    // Containment nesting types them: outer = contour, inner counter = hole.
    expect(loops.some((l) => l.type === 'contour')).toBe(true)
    expect(loops.some((l) => l.type === 'hole')).toBe(true)
    // Closed loops carry exact line segments (polygonal bake).
    for (const l of loops) {
      expect(l.segments!.length).toBeGreaterThan(0)
      expect(l.segments!.every((s) => s.type === 'line')).toBe(true)
    }
  })

  it('degenerate (whitespace) outline text is excluded from bake', () => {
    const e: SketchTextEntity = {
      id: 't2', kind: 'text', construction: false,
      at: { x: 0, y: 0 }, text: '  ', height: 10, rotation: 0, fontStyle: 'outline',
    }
    const { loops, excludedEntities } = bakeSketch(sketchOf([e]), { newId: idFactory() })
    expect(loops.length).toBe(0)
    expect(excludedEntities).toBe(1)
  })
})

// ---- Tool / store wiring: fontStyle carried onto the committed entity ------

describe('outline text tool wiring', () => {
  it('textClick carries fontStyle:outline onto the committed entity', () => {
    const e = textClick(
      { x: 1, y: 2 }, { text: 'AB', height: 6, fontStyle: 'outline' }, false, idFactory(),
    )!.entities[0] as SketchTextEntity
    expect(e.fontStyle).toBe('outline')
  })

  it('textClick defaults to single-line when fontStyle is omitted', () => {
    const e = textClick(
      { x: 0, y: 0 }, { text: 'A', height: 5 }, false, idFactory(),
    )!.entities[0] as SketchTextEntity
    expect(e.fontStyle).toBe('single-line')
  })

  it('the tool machine threads ctx.textStyle onto the entity', () => {
    const r = toolClick(armed('text'), { x: 4, y: 4 }, 0.5, idFactory(), {
      entities: [], textValue: 'HI', textHeight: 8, textStyle: 'outline',
    })
    const e = r.commit!.entities[0] as SketchTextEntity
    expect(e.fontStyle).toBe('outline')
  })

  it('textClick carries the outline fontFamily onto the entity (single-line ignores it)', () => {
    const e = textClick(
      { x: 0, y: 0 }, { text: 'A', height: 5, fontStyle: 'outline', fontFamily: 'Helvetiker' },
      false, idFactory(),
    )!.entities[0] as SketchTextEntity
    expect(e.fontFamily).toBe('Helvetiker')
    // Single-line drops the family (that face is always Hershey).
    const s = textClick(
      { x: 0, y: 0 }, { text: 'A', height: 5, fontStyle: 'single-line', fontFamily: 'Helvetiker' },
      false, idFactory(),
    )!.entities[0] as SketchTextEntity
    expect(s.fontFamily).toBeUndefined()
  })

  it('solver rebuild carries fontStyle:outline verbatim (anchor-only)', () => {
    const text: SketchTextEntity = {
      id: 't1', kind: 'text', construction: false,
      at: { x: 3, y: 5 }, text: 'O', height: 6, rotation: 0, fontStyle: 'outline',
    }
    const sketch: Sketch = {
      id: 'sk', layerId: 'L', entities: [text], constraints: [], dimensions: [],
      solveStatus: null,
    }
    const lookup = (id: string) =>
      id === 't1:start'
        ? ({ id, type: 'point', x: 10, y: 20, fixed: false } as never)
        : undefined
    const [out] = entitiesFromSolved(sketch, lookup) as [SketchTextEntity]
    expect(out.at).toEqual({ x: 10, y: 20 })
    expect(out.fontStyle).toBe('outline')
  })
})

// ---- Font REGISTRY: multiple built-ins + import + fallback ----------------

describe('outline font registry', () => {
  it('the default family is listed first and resolves to a stable face', () => {
    const fams = listFontFamilies()
    expect(fams[0]).toBe(DEFAULT_FONT_FAMILY)
    expect(fams).toContain('Helvetiker')
    // Parse-once: the same object comes back for repeat resolutions.
    const a = outlineFont(DEFAULT_FONT_FAMILY)
    const b = outlineFont()               // unset -> default
    expect(a.font).toBe(b.font)
    expect(a.capHeightEm).toBeGreaterThan(0)
  })

  it('the bold weights are registered and listed', () => {
    const fams = listFontFamilies()
    for (const b of ['Helvetiker Bold', 'Gentilis Bold', 'Optimer Bold']) {
      expect(fams).toContain(b)
      expect(isFontRegistered(b)).toBe(true)
      // Each bold face parses to a usable, distinct-cap-height face.
      expect(outlineFont(b).capHeightEm).toBeGreaterThan(0)
    }
    // Regular and bold of the same family are DISTINCT faces.
    expect(outlineFont('Helvetiker').font).not.toBe(outlineFont('Helvetiker Bold').font)
  })

  it('distinct families resolve to DISTINCT faces', () => {
    const def = outlineFont(DEFAULT_FONT_FAMILY)
    const helv = outlineFont('Helvetiker')
    expect(helv.font).not.toBe(def.font)
  })

  it('outlineTextToContours honors fontFamily (default vs Helvetiker differ)', () => {
    const def = outlineTextToContours('A', 10, { fontFamily: DEFAULT_FONT_FAMILY })
    const helv = outlineTextToContours('A', 10, { fontFamily: 'Helvetiker' })
    expect(def.length).toBeGreaterThan(0)
    expect(helv.length).toBeGreaterThan(0)
    // Different faces -> different point counts and/or vertices for the SAME glyph.
    const defPts = def.flatMap((c) => c.points)
    const helvPts = helv.flatMap((c) => c.points)
    expect(JSON.stringify(defPts)).not.toBe(JSON.stringify(helvPts))
  })

  it('an unknown fontFamily falls back to the default WITHOUT throwing', () => {
    expect(isFontRegistered('Definitely Not A Font')).toBe(false)
    let cs: ReturnType<typeof outlineTextToContours> = []
    expect(() => { cs = outlineTextToContours('A', 10, { fontFamily: 'Definitely Not A Font' }) })
      .not.toThrow()
    // Same result as the explicit default (silent geometry-wise; warning is logged).
    const def = outlineTextToContours('A', 10, { fontFamily: DEFAULT_FONT_FAMILY })
    expect(JSON.stringify(cs.flatMap((c) => c.points)))
      .toBe(JSON.stringify(def.flatMap((c) => c.points)))
  })

  it('world contours for an unknown family also fall back cleanly', () => {
    const w = outlineTextToWorldContours('O', 8, { x: 0, y: 0 }, 0, { fontFamily: 'Nope' })
    expect(w.length).toBeGreaterThan(0)
    const d = distanceToOutlineText('O', 8, { x: 0, y: 0 }, 0, { x: 500, y: 500 }, 'Nope')
    expect(Number.isFinite(d)).toBe(true)
  })

  it('TTFLoader round-trip: kenpixel.ttf registers a usable family', async () => {
    // Headless TTF -> typeface JSON via three's vendored opentype (no new dep).
    // If the parser cannot run under node, skip rather than flake.
    let typeface: unknown
    try {
      const { TTFLoader } = await import('three/examples/jsm/loaders/TTFLoader.js')
      const ttfPath = fileURLToPath(
        new URL('../../../node_modules/three/examples/fonts/ttf/kenpixel.ttf', import.meta.url),
      )
      const buf = readFileSync(ttfPath)
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
      typeface = new TTFLoader().parse(ab as ArrayBuffer)
    } catch (err) {
      console.warn('[skip] TTFLoader round-trip not runnable under node:', (err as Error).message)
      return
    }
    registerFont('Kenpixel Test', typeface)
    expect(isFontRegistered('Kenpixel Test')).toBe(true)
    expect(listFontFamilies()).toContain('Kenpixel Test')
    const cs = outlineTextToContours('A', 10, { fontFamily: 'Kenpixel Test' })
    expect(cs.length).toBeGreaterThan(0)
    for (const c of cs) expect(c.points.length).toBeGreaterThanOrEqual(3)
  })
})

// ---- Unified font picker options (single-line + all outline faces) ---------

describe('fontPickerOptions (unified always-visible picker)', () => {
  it('lists the single-line Hershey entry FIRST, then every outline family', () => {
    const opts = fontPickerOptions()
    expect(opts[0].value).toBe(SINGLE_LINE_FONT_VALUE)
    expect(opts[0].label).toBe(SINGLE_LINE_FONT_LABEL)
    expect(opts[0].isSingleLine).toBe(true)
    // The rest are the outline families, in listFontFamilies() order.
    const rest = opts.slice(1)
    expect(rest.map((o) => o.value)).toEqual(listFontFamilies())
    expect(rest.every((o) => !o.isSingleLine)).toBe(true)
    // The default face and a bold face are present as selectable outline options.
    expect(rest.some((o) => o.value === DEFAULT_FONT_FAMILY)).toBe(true)
    expect(rest.some((o) => o.value === 'Helvetiker Bold')).toBe(true)
  })

  it('the sentinel never collides with a real family key', () => {
    expect(listFontFamilies()).not.toContain(SINGLE_LINE_FONT_VALUE)
    expect(isFontRegistered(SINGLE_LINE_FONT_VALUE)).toBe(false)
  })
})

// ---- Letter spacing (tracking): outline (real font) -----------------------
//
// Same additive spacing as the single-line path, but the outline layout runs
// through three's FontLoader. Driven for REAL (font parsed under vitest).
// Spacing is BETWEEN glyphs (N glyphs -> (N-1) gaps); zero/undefined stays
// byte-identical to the whole-string layout.
describe('letter spacing (outline, one layout source)', () => {
  it('advance widens by exactly (N-1)*spacing for an N-glyph string', () => {
    const s = 3
    const base = outlineTextAdvanceWidth('ABCD', 10)              // N = 4
    const spaced = outlineTextAdvanceWidth('ABCD', 10, { letterSpacingMm: s })
    expect(spaced - base).toBeCloseTo((4 - 1) * s, 6)            // 3 gaps
  })
  it('negative spacing TIGHTENS the advance by (N-1)*|spacing|', () => {
    const base = outlineTextAdvanceWidth('ABC', 10)
    const tight = outlineTextAdvanceWidth('ABC', 10, { letterSpacingMm: -1 })
    expect(base - tight).toBeCloseTo((3 - 1) * 1, 6)
  })
  it('undefined / 0 spacing is byte-identical to the whole-string advance', () => {
    expect(outlineTextAdvanceWidth('HELLO', 8, { letterSpacingMm: 0 }))
      .toBe(outlineTextAdvanceWidth('HELLO', 8))
  })
  it('undefined / 0 spacing yields byte-identical CONTOURS (regression)', () => {
    const a = outlineTextToContours('AB', 10)
    const b = outlineTextToContours('AB', 10, { letterSpacingMm: 0 })
    expect(b.length).toBe(a.length)
    for (let i = 0; i < a.length; i++) {
      expect(b[i].isHole).toBe(a[i].isHole)
      expect(b[i].points).toEqual(a[i].points)   // exact same geometry
    }
  })
  it('bbox WIDTH grows by (N-1)*spacing; minX (first glyph) is unchanged', () => {
    const s = 4
    const b0 = outlineTextLocalBBox('ABC', 10)!                  // N = 3
    const b1 = outlineTextLocalBBox('ABC', 10, { letterSpacingMm: s })!
    expect(b1.minX).toBeCloseTo(b0.minX, 6)                      // first glyph unmoved
    const w0 = b0.maxX - b0.minX
    const w1 = b1.maxX - b1.minX
    expect(w1 - w0).toBeCloseTo((3 - 1) * s, 6)
  })
})
