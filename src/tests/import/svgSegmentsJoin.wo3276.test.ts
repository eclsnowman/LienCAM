// @vitest-environment jsdom
//
// WO-3276: an SVG drawn as separate lines imports as closed loops. The nested
// letter logo is 56 two-point lines; 16 of the line ends land on the middle of
// another line rather than on a shared endpoint, and three lines meet at most
// corners. Chaining end to end never closes anything there (19 loops, 0
// closed); the closed shapes are the faces the lines enclose (22).

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { importDXF } from '../../lib/import/dxfImporter'
import { importSVG } from '../../lib/import/svgImporter'
import { formatSvgImportReport } from '../../lib/import/importGeometryFile'
import { joinSegments, joinSegmentsIntoFaces } from '../../lib/geometry/path2d'
import type { Vec2 } from '../../types'

const line = (x1: number, y1: number, x2: number, y2: number) =>
  `<path d="M ${x1} ${y1} L ${x2} ${y2}" stroke="#000" fill="none"/>`

function svg(lines: Array<[number, number, number, number]>): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="100mm" viewBox="0 0 100 100">`
    + `${lines.map(l => line(...l)).join('')}</svg>`
}

const closedCount = (r: ReturnType<typeof importSVG>) => r.loops.filter(l => l.closed).length

describe('WO-3276: separate SVG lines form closed loops', () => {
  it('the nested letter logo imports as its 22 closed faces and no open chains', () => {
    const r = importSVG(readFileSync('Sample Parts/Lien3D-Nested-Letter-Logo.svg', 'utf8'))
    expect(closedCount(r)).toBe(22)
    expect(r.loops.length).toBe(22)
  })

  it('two boxes side by side, the middle wall drawn as ONE line ending on both boxes, give two closed loops', () => {
    // Outer 0..60 x 0..20 drawn as four lines; the wall at x=30 is its own line
    // whose ends sit on the top and bottom edges (T-junctions, no shared end).
    const r = importSVG(svg([[0, 0, 60, 0], [60, 0, 60, 20], [60, 20, 0, 20], [0, 20, 0, 0], [30, 0, 30, 20]]))
    expect(closedCount(r)).toBe(2)
    expect(r.loops.length).toBe(2)
  })

  it('a box of four lines whose corners all share endpoints still imports as one closed loop', () => {
    const r = importSVG(svg([[0, 0, 40, 0], [40, 0, 40, 30], [40, 30, 0, 30], [0, 30, 0, 0]]))
    expect(closedCount(r)).toBe(1)
    expect(r.loops.length).toBe(1)
  })

  // Authored closed outlines: a 10 x 10 square and a diamond whose corner touches
  // the square's top edge at (5,0). Areas and vertex counts, not just counts.
  const SQUARE_AND_DIAMOND = '<path d="M 0 0 L 10 0 L 10 10 L 0 10 Z"/><path d="M 5 0 L 8 3 L 5 6 L 2 3 Z"/>'
  const shapeOf = (r: ReturnType<typeof importSVG>) =>
    r.loops.map(l => ({ closed: l.closed, area: Math.round(l.area * 1e6) / 1e6, points: l.points.length }))
      .sort((p, q) => q.area - p.area || p.points - q.points)

  it('closed outlines that touch are left exactly as drawn: area 100 / 4 vertices and area 18 / 4 vertices', () => {
    const r = importSVG(`<svg xmlns="http://www.w3.org/2000/svg">${SQUARE_AND_DIAMOND}</svg>`)
    expect(shapeOf(r)).toEqual([{ closed: true, area: 100, points: 4 }, { closed: true, area: 18, points: 4 }])
    expect(r.report?.tJunctionsSplit ?? 0).toBe(0)
  })

  it('a distant open line in the same layer does not re-trace the closed outlines', () => {
    const r = importSVG(`<svg xmlns="http://www.w3.org/2000/svg">${SQUARE_AND_DIAMOND}<path d="M 20 20 L 30 20"/></svg>`)
    expect(shapeOf(r)).toEqual([
      { closed: true, area: 100, points: 4 },
      { closed: true, area: 18, points: 4 },
      { closed: false, area: 0, points: 2 },
    ])
  })

  it('closed outlines are untouched even when separate lines elsewhere in the layer form faces', () => {
    // The shared-wall boxes (made of lines) far from the square and diamond.
    const lines = [[100, 0, 160, 0], [160, 0, 160, 20], [160, 20, 100, 20], [100, 20, 100, 0], [130, 0, 130, 20]]
      .map(l => line(l[0], l[1], l[2], l[3])).join('')
    const r = importSVG(`<svg xmlns="http://www.w3.org/2000/svg">${SQUARE_AND_DIAMOND}${lines}</svg>`)
    expect(shapeOf(r)).toEqual([
      { closed: true, area: 600, points: 4 }, { closed: true, area: 600, points: 4 },
      { closed: true, area: 100, points: 4 }, { closed: true, area: 18, points: 4 },
    ])
  })

  it('the DXF route is unchanged: Leadscrew_Stepper_Mount.DXF still joins to 9 closed loops, 8 gaps closed', () => {
    const r = importDXF(readFileSync('Sample Parts/Leadscrew_Stepper_Mount.DXF', 'utf8'))
    expect(r.loops.length).toBe(9)
    expect(closedCount(r)).toBe(9)
    expect(r.report.gapsClosed).toBe(8)
    expect(r.report.openChains).toBe(0)
  })

  it('segments that genuinely do not close stay open: no loop is invented', () => {
    // A U (open top) with a stub that stops 0.5 mm short of the bottom edge.
    const r = importSVG(svg([[0, 0, 0, 20], [0, 20, 40, 20], [40, 20, 40, 0], [20, 0, 20, 19.5]]))
    expect(closedCount(r)).toBe(0)
  })

  it('a line end further than the join tolerance from the line it nears is not joined', () => {
    // Would close a box if the stub reached the top edge; it stops 0.2 mm short.
    const r = importSVG(svg([[0, 0, 40, 0], [0, 0, 0, 20], [40, 0, 40, 20], [0, 20, 40, 20], [20, 0.2, 20, 20]]))
    expect(closedCount(r)).toBe(1)
    expect(r.loops.some(l => !l.closed)).toBe(true)
  })

  it('the import report says what was joined and closed', () => {
    const r = importSVG(svg([[0, 0, 60, 0], [60, 0, 60, 20], [60, 20, 0, 20], [0, 20, 0, 0], [30, 0, 30, 20]]))
    expect(r.report?.tJunctionsSplit).toBe(2)
    expect(r.report?.facesClosed).toBe(2)
    expect(r.report?.openChains).toBe(0)
  })

  it('the import console line says what was closed, and is silent when nothing needed joining', () => {
    const two = importSVG(svg([[0, 0, 60, 0], [60, 0, 60, 20], [60, 20, 0, 20], [0, 20, 0, 0], [30, 0, 30, 20]]))
    expect(formatSvgImportReport(two.report)).toBe('2 places where a line ends on another line joined, 2 closed shapes found')
    const box = importSVG(svg([[0, 0, 40, 0], [40, 0, 40, 30], [40, 30, 0, 30], [0, 30, 0, 0]]))
    expect(formatSvgImportReport(box.report)).toBe('')
    expect(formatSvgImportReport({ gapsClosed: 1, largestGapMM: 0.04, openChains: 2 })).toBe('1 gap closed (largest 0.04mm), 2 chains left open')
  })

  // Fix round 2: whether lines are traced for faces is decided per connected
  // group of lines, not per layer. A loop that joinSegments (main) closes from
  // lines that touch no open chain comes out exactly as main gives it.
  const P = (x: number, y: number): Vec2 => ({ x, y })
  const boxLines = (x0: number, y0: number, x1: number, y1: number): Vec2[][] =>
    [[P(x0, y0), P(x1, y0)], [P(x1, y0), P(x1, y1)], [P(x1, y1), P(x0, y1)], [P(x0, y1), P(x0, y0)]]
  const boxPath = (x0: number, y0: number, x1: number, y1: number): Vec2[][] =>
    [[P(x0, y0), P(x1, y0), P(x1, y1), P(x0, y1), P(x0, y0)]]
  const FAR_LINE: Vec2[][] = [[P(200, 200), P(230, 200)]]

  it('audit case: a nested hole drawn as separate lines stays a hole when a distant open line is added', () => {
    const outer = '<path d="M 0 0 L 40 0 L 40 40 L 0 40 Z" stroke="#000" fill="none"/>'
    const hole = [[10, 10, 30, 10], [30, 10, 30, 30], [30, 30, 10, 30], [10, 30, 10, 10]].map(l => line(l[0], l[1], l[2], l[3])).join('')
    const r = importSVG(`<svg xmlns="http://www.w3.org/2000/svg">${outer}${hole}${line(200, 200, 230, 200)}</svg>`)
    expect(r.loops.map(l => ({ type: l.type, area: l.area, points: l.points.length }))
      .sort((p, q) => q.area - p.area)).toEqual([
      { type: 'contour', area: 1600, points: 4 },
      { type: 'hole', area: 400, points: 4 },
      { type: 'open', area: 0, points: 2 },
    ])
  })

  it('audit case, every way of drawing the nested pair: the loops are byte-equal to main (joinSegments)', () => {
    const cw = (segs: Vec2[][]) => segs.map(s => [...s].reverse()).reverse()
    const layouts: Array<[string, Vec2[][]]> = [
      ['closed outer, hole of lines', [...boxPath(0, 0, 40, 40), ...boxLines(10, 10, 30, 30)]],
      ['outer of lines, closed hole', [...boxLines(0, 0, 40, 40), ...boxPath(10, 10, 30, 30)]],
      ['both of lines', [...boxLines(0, 0, 40, 40), ...boxLines(10, 10, 30, 30)]],
      ['both of lines, clockwise', [...cw(boxLines(0, 0, 40, 40)), ...cw(boxLines(10, 10, 30, 30))]],
    ]
    for (const [name, segs] of layouts) {
      const all = [...segs, ...FAR_LINE]
      expect(joinSegmentsIntoFaces(all, 'L'), name).toEqual(joinSegments(all, 'L'))
    }
  })

  it('faces traced from lines inside a closed outline are holes of it; the outline is unchanged', () => {
    // Shared-wall boxes made of lines (a T-junction, so they need the face
    // trace) inside a closed 100 x 50 outline.
    const inner: Vec2[][] = [...boxLines(10, 10, 70, 30), [P(40, 10), P(40, 30)]]
    const all = [...boxPath(0, 0, 100, 50), ...inner]
    const got = joinSegmentsIntoFaces(all, 'L')
    expect(got.map(l => ({ type: l.type, area: l.area, points: l.points.length }))
      .sort((p, q) => q.area - p.area)).toEqual([
      { type: 'contour', area: 5000, points: 4 },
      { type: 'hole', area: 600, points: 4 },
      { type: 'hole', area: 600, points: 4 },
    ])
    expect(got.find(l => l.area === 5000)).toEqual(joinSegments(all, 'L').find(l => l.area === 5000))
  })

  it('property: adding a far-away open line never changes any loop that closed without it (25 layouts)', () => {
    let seed = 0
    const rnd = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
    const pickInt = (n: number) => Math.floor(rnd() * n)
    // A box drawn as lines, starting at a random corner, in a random direction.
    const anyBoxLines = (x0: number, y0: number, x1: number, y1: number) => {
      let segs = boxLines(x0, y0, x1, y1)
      const k = pickInt(4)
      segs = [...segs.slice(k), ...segs.slice(0, k)]
      if (rnd() < 0.5) segs = segs.map(s => [...s].reverse()).reverse()
      return segs
    }
    const anyBox = (x0: number, y0: number, x1: number, y1: number) => {
      if (rnd() < 0.5) return anyBoxLines(x0, y0, x1, y1)
      const path = boxPath(x0, y0, x1, y1)[0]
      return [rnd() < 0.5 ? path : [...path].reverse()]
    }
    let traced = 0
    for (let layout = 1; layout <= 25; layout++) {
      seed = layout * 7919
      const segs: Vec2[][] = []
      for (let cx = 0; cx < 4; cx++) {
        for (let cy = 0; cy < 4; cy++) {
          const x = cx * 100, y = cy * 100
          // Odd layouts hold only shapes that close without the face trace, so
          // the far line is the only open chain; even ones also need the trace.
          switch (pickInt(layout % 2 === 1 ? 4 : 6)) {
            case 0: break
            case 1: segs.push(...anyBox(x, y, x + 60, y + 40)); break
            case 2: segs.push(...anyBox(x, y, x + 80, y + 80), ...anyBox(x + 20, y + 20, x + 60, y + 60)); break
            case 3: // nested three deep
              segs.push(...anyBox(x, y, x + 90, y + 90), ...anyBox(x + 10, y + 10, x + 80, y + 80), ...anyBox(x + 30, y + 30, x + 60, y + 60)); break
            case 4: // shared-wall boxes of lines (T-junctions): only the face trace closes them
              segs.push(...anyBoxLines(x, y, x + 60, y + 20), [P(x + 30, y), P(x + 30, y + 20)]); break
            case 5: // an open U
              segs.push([P(x, y + 30), P(x, y)], [P(x, y), P(x + 40, y)], [P(x + 40, y), P(x + 40, y + 30)]); break
          }
        }
      }
      const base = joinSegmentsIntoFaces(segs, 'L')
      if (base.some(l => l.closed) && segs.some(s => s.length === 2)) traced++
      if (layout % 2 === 1) expect(base, `layout ${layout}`).toEqual(joinSegments(segs, 'L'))
      const at = pickInt(segs.length + 1)
      const withFar = joinSegmentsIntoFaces([...segs.slice(0, at), [P(5000, 5000), P(5030, 5000)], ...segs.slice(at)], 'L')
      expect(withFar.length, `layout ${layout}`).toBe(base.length + 1)
      for (const loop of base.filter(l => l.closed)) {
        expect(withFar, `layout ${layout}, loop area ${loop.area} at ${JSON.stringify(loop.points[0])}`).toContainEqual(loop)
      }
    }
    expect(traced).toBeGreaterThan(10)
  })
})

