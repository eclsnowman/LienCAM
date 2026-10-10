// @vitest-environment jsdom
//
// WO-1450 (Codex audit BUG-443 + BUG-532, family K6): SVG import ignored every
// `transform` (an element's own and its ancestor groups') and sampled paths by
// uniform arc-length steps that bridged across authored corners.
//
// Both tests drive the production entry point, importSVG(). jsdom lacks the SVG
// path geometry API the pre-fix importer sampled through, so the polyfill is
// installed; that keeps these tests failing BEHAVIOURALLY against the unfixed
// importer rather than on a missing primitive.

import { beforeAll, describe, expect, it } from 'vitest'
import { importSVG } from '../../lib/import/svgImporter'
import { signedArea } from '../../lib/geometry/path2d'
import type { Vec2 } from '../../types'
import { installSvgPathGeometry } from './svgPathGeometryPolyfill'

// Verbatim copies of the audit's paired fixtures:
// docs/Codex Audit/docs/ui-review/current-runtime/findings/import-2d-clean.svg
// docs/Codex Audit/docs/ui-review/current-runtime/findings/import-2d-transformed.svg
const CLEAN_SVG = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" width="200mm" height="100mm" viewBox="0 0 200 100">
  <defs><rect x="1000" y="1000" width="500" height="500"/></defs>
  <g inkscape:groupmode="layer" inkscape:label="Cut geometry" id="cut">
    <path stroke="#4ac3ff" fill="none" d="M0 0 L20 0 L40 0 L40 15 L40 30 L0 30 L0 0 Z"/>
    <circle stroke="#4ac3ff" fill="none" cx="65" cy="15" r="10"/>
  </g>
  <g style="display:none"><rect x="2000" y="2000" width="500" height="500"/></g>
</svg>`

const TRANSFORMED_SVG = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" width="200mm" height="100mm" viewBox="0 0 200 100">
  <defs><rect x="1000" y="1000" width="500" height="500"/></defs>
  <g inkscape:groupmode="layer" inkscape:label="Cut geometry" id="cut">
    <g transform="translate(10,5) scale(2,1)">
      <path stroke="#4ac3ff" fill="none" d="M0 0 L20 0 L40 0 L40 15 L40 30 L0 30 L0 0 Z"/>
      <circle stroke="#4ac3ff" fill="none" cx="65" cy="15" r="10"/>
    </g>
  </g>
  <g style="display:none"><rect x="2000" y="2000" width="500" height="500"/></g>
</svg>`

// Four straight edges, exact vertices, explicit mm units (1 user unit = 1 mm).
const WEDGE_VERTICES: Vec2[] = [{ x: 0, y: 0 }, { x: 70, y: 0 }, { x: 60, y: 12 }, { x: 0, y: 12 }]
const WEDGE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="70mm" height="12mm" viewBox="0 0 70 12">
  <path stroke="#000" fill="none" d="M 0 0 L 70 0 L 60 12 L 0 12 L 0 0"/>
</svg>`

beforeAll(() => {
  installSvgPathGeometry(window as unknown as { SVGElement: { prototype: object } })
})

function bboxOf(pts: Vec2[]) {
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y)
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys)
  return { minX, maxX, minY, maxY, w: maxX - minX, h: maxY - minY }
}

function distToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x, dy = b.y - a.y
  const l2 = dx * dx + dy * dy
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

describe('WO-1450 BUG-443: SVG import composes element and ancestor transforms', () => {
  it('the transformed fixture resolves to ~150 x 30 mm, not the untransformed ~75 x 30 mm', () => {
    const clean = importSVG(CLEAN_SVG)
    const transformed = importSVG(TRANSFORMED_SVG)

    expect(clean.boundingBox.size.x).toBeCloseTo(75, 3)
    expect(clean.boundingBox.size.y).toBeCloseTo(30, 3)
    expect(transformed.boundingBox.size.x).toBeCloseTo(150, 3)
    expect(transformed.boundingBox.size.y).toBeCloseTo(30, 3)
  })

  it('the transformed circle imports as a 40 x 20 mm ellipse and the path as an 80 x 30 mm outline', () => {
    const transformed = importSVG(TRANSFORMED_SVG)
    expect(transformed.loops).toHaveLength(2)
    const boxes = transformed.loops.map(l => bboxOf(l.points)).sort((a, b) => a.w * a.h - b.w * b.h)
    const [circle, outline] = boxes
    expect(circle.w).toBeCloseTo(40, 2)
    expect(circle.h).toBeCloseTo(20, 2)
    expect(outline.w).toBeCloseTo(80, 6)
    expect(outline.h).toBeCloseTo(30, 6)
    // Ellipse area pi * 20 * 10, within the chord-sampling loss of a 0.5 mm chord.
    const ellipse = transformed.loops.find(l => bboxOf(l.points).w < 50)!
    expect(ellipse.area).toBeGreaterThan(Math.PI * 200 * 0.995)
    expect(ellipse.area).toBeLessThanOrEqual(Math.PI * 200)
  })

  it("an element's own transform composes under its ancestors' (rotate, then translate+scale)", () => {
    // Own rotate(90) maps the 10 x 4 rect to 4 x 10; the group then scales x by 3.
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="100mm" viewBox="0 0 100 100">
      <g transform="translate(50 50) scale(3, 1)">
        <rect stroke="#000" fill="none" x="0" y="0" width="10" height="4" transform="rotate(90)"/>
      </g>
    </svg>`
    const result = importSVG(svg)
    expect(result.loops).toHaveLength(1)
    const box = bboxOf(result.loops[0].points)
    expect(box.w).toBeCloseTo(12, 9)
    expect(box.h).toBeCloseTo(10, 9)
    expect(result.loops[0].area).toBeCloseTo(120, 9)
  })
})

describe('WO-1450 BUG-532: sampling keeps every authored path-command endpoint', () => {
  it('the 4-line wedge imports with area 780 mm2 and every authored vertex as an exact output point', () => {
    const result = importSVG(WEDGE_SVG)
    expect(result.loops).toHaveLength(1)
    const loop = result.loops[0]
    expect(loop.closed).toBe(true)
    expect(Math.abs(Math.abs(signedArea(loop.points)) - 780)).toBeLessThan(0.001)
    expect(Math.abs(loop.area - 780)).toBeLessThan(0.001)

    // Import centers the part and flips SVG Y-down into world Y-up.
    const authored = WEDGE_VERTICES.map(v => ({ x: v.x - 35, y: -v.y + 6 }))
    for (const v of authored) {
      const nearest = Math.min(...loop.points.map(p => Math.hypot(p.x - v.x, p.y - v.y)))
      expect(nearest).toBeLessThan(1e-9)
    }
    // No output point strays off the authored polygon's boundary.
    for (const p of loop.points) {
      const d = Math.min(...authored.map((a, i) => distToSegment(p, a, authored[(i + 1) % authored.length])))
      expect(d).toBeLessThan(1e-9)
    }
  })
})
