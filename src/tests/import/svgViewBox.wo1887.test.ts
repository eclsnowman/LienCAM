// @vitest-environment jsdom
//
// WO-1887: an SVG whose viewBox does not start at 0,0 (a cropped Inkscape /
// Illustrator file) or whose aspect differs from its page imported shifted /
// mis-sized. The importer applied only width / viewBox.width and never the
// viewBox origin, the height ratio, or preserveAspectRatio.
//
// The origin subtraction is asserted through the exported getSvgUserToMM()
// because importSVG() ends with centerLoops(), which normalises the final
// translation away - a global origin shift is invisible in the grouped loops
// (though it is what placed imported geometry wrong relative to its page).
// The ratio and preserveAspectRatio behaviour is asserted end-to-end through
// importSVG() too.

import { describe, expect, it } from 'vitest'
import { getSvgUserToMM, importSVG } from '../../lib/import/svgImporter'

function svgDoc(attrs: string, children = ''): SVGSVGElement {
  const doc = new DOMParser().parseFromString(
    `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${children}</svg>`,
    'image/svg+xml',
  )
  return doc.querySelector('svg') as unknown as SVGSVGElement
}

const RECT = (x: number, y: number, w: number, h: number) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" stroke="#000" fill="none"/>`

// Apply an affine [a b c d e f] the SVG way: (a x + c y + e, b x + d y + f).
function apply(m: number[], x: number, y: number) {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] }
}

describe('WO-1887: viewBox origin, height ratio and preserveAspectRatio', () => {
  it('test 1: a viewBox with a non-zero origin subtracts it (rect at 100,50 lands at mm 0,0)', () => {
    const svg = svgDoc('width="200mm" height="100mm" viewBox="100 50 200 100"', RECT(100, 50, 20, 10))
    const m = getSvgUserToMM(svg)
    // Rect corner (100,50) is the viewBox origin -> mm (0,0); its far x is 20 mm.
    expect(apply(m, 100, 50)).toEqual({ x: 0, y: 0 })
    expect(apply(m, 120, 50).x).toBeCloseTo(20, 9)

    // End-to-end shape size survives centering, which hides the offset itself.
    const result = importSVG(svg.outerHTML)
    expect(result.boundingBox.size.x).toBeCloseTo(20, 6)
    expect(result.boundingBox.size.y).toBeCloseTo(10, 6)
    expect(result.boundingBox.center.x).toBeCloseTo(0, 6)
    expect(result.boundingBox.center.y).toBeCloseTo(0, 6)
  })

  it('test 2: equal-page viewBox with a mismatched aspect uses meet and centres (100x50 content)', () => {
    // viewBox aspect 2:1, page 1:1 -> meet scale 0.5, content 100 x 50, centred.
    const svg = svgDoc('width="100mm" height="100mm" viewBox="0 0 200 100"', RECT(0, 0, 200, 100))
    const m = getSvgUserToMM(svg)
    expect(apply(m, 0, 0)).toEqual({ x: 0, y: 25 })
    expect(apply(m, 200, 100)).toEqual({ x: 100, y: 75 })

    const result = importSVG(svg.outerHTML)
    expect(result.boundingBox.size.x).toBeCloseTo(100, 6)
    expect(result.boundingBox.size.y).toBeCloseTo(50, 6)
  })

  it('test 2b: meet picks the smaller ratio, not width-only (tall content is not stretched)', () => {
    // sx = 1, sy = 0.25 -> meet 0.25: content 50 x 100, not the old 200 x 400.
    const svg = svgDoc('width="200mm" height="100mm" viewBox="0 0 200 400"', RECT(0, 0, 200, 400))
    const m = getSvgUserToMM(svg)
    expect(m[0]).toBeCloseTo(0.25, 9)
    expect(m[3]).toBeCloseTo(0.25, 9)

    const result = importSVG(svg.outerHTML)
    expect(result.boundingBox.size.x).toBeCloseTo(50, 6)
    expect(result.boundingBox.size.y).toBeCloseTo(100, 6)
  })

  it('test 2c: preserveAspectRatio alignment and slice are honoured', () => {
    const min = getSvgUserToMM(svgDoc('width="100mm" height="100mm" viewBox="0 0 200 100" preserveAspectRatio="xMinYMin meet"'))
    expect(apply(min, 0, 0)).toEqual({ x: 0, y: 0 })

    const max = getSvgUserToMM(svgDoc('width="100mm" height="100mm" viewBox="0 0 200 100" preserveAspectRatio="xMaxYMax meet"'))
    expect(apply(max, 0, 0)).toEqual({ x: 0, y: 50 })

    // slice covers the page: scale 1, content 200 x 100, centred horizontally.
    const slice = getSvgUserToMM(svgDoc('width="100mm" height="100mm" viewBox="0 0 200 100" preserveAspectRatio="xMidYMid slice"'))
    expect(apply(slice, 0, 0)).toEqual({ x: -50, y: 0 })
    expect(apply(slice, 200, 100)).toEqual({ x: 150, y: 100 })
  })

  it('test 3: viewBox at 0,0 with matching aspect is byte-identical to today (identity mapping)', () => {
    const svg = svgDoc('width="200mm" height="100mm" viewBox="0 0 200 100"', RECT(0, 0, 75, 30))
    expect(getSvgUserToMM(svg)).toEqual([1, 0, 0, 1, 0, 0])

    const result = importSVG(svg.outerHTML)
    expect(result.boundingBox.size.x).toBeCloseTo(75, 6)
    expect(result.boundingBox.size.y).toBeCloseTo(30, 6)
  })

  it('test 4: no width/height keeps 1 user unit = 1 mm and never refuses', () => {
    const vbOnly = svgDoc('viewBox="0 0 10 10"', RECT(0, 0, 4, 3))
    expect(getSvgUserToMM(vbOnly)).toEqual([1, 0, 0, 1, 0, 0])
    expect(importSVG(vbOnly.outerHTML).boundingBox.size.x).toBeCloseTo(4, 6)

    const bare = svgDoc('', RECT(0, 0, 4, 3))
    expect(getSvgUserToMM(bare)).toEqual([1, 0, 0, 1, 0, 0])
    expect(importSVG(bare.outerHTML).boundingBox.size.x).toBeCloseTo(4, 6)
  })
})
