// @vitest-environment jsdom
//
// WO-1451: Inkscape layer names were never recognized on import.
//
// extractInkscapeLayers() found layer groups with the CSS attribute selector
// `g[inkscape\:groupmode="layer"]`. That selector looks up a literal,
// no-namespace attribute NAMED "inkscape:groupmode"; per the CSS Selectors
// spec it cannot match an attribute in the Inkscape XML namespace with local
// name `groupmode`. So inkLayers was always empty, hasInkLayers always false
// and every SVG fell back to color-based grouping - "Layer 1", "Layer 2", ...
// regardless of named Inkscape layers. findLayerId() (which walks ancestors
// with getAttribute) was dead code as a result.
//
// These tests run the REAL importSVG() pipeline headless (jsdom DOMParser +
// live DOM host; the one missing browser primitive, SVG path geometry, is
// polyfilled - see svgPathGeometryPolyfill.ts).

import { describe, it, expect, beforeAll } from 'vitest'
import { importSVG, type Import2DResult } from '../../lib/import/svgImporter'
import { installSvgPathGeometry } from './svgPathGeometryPolyfill'

const NS = 'http://www.inkscape.org/namespaces/inkscape'

// A minimal Inkscape-authored document with two named layers, each holding one
// rectangle of a distinct stroke color.
const NAMED_LAYERS_SVG = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="${NS}"
     width="100" height="100" viewBox="0 0 100 100">
  <g inkscape:groupmode="layer" inkscape:label="Cut geometry" id="cut">
    <rect x="0" y="0" width="10" height="10" style="stroke:#ff0000"/>
  </g>
  <g inkscape:groupmode="layer" inkscape:label="Engrave" id="engrave">
    <rect x="20" y="20" width="10" height="10" style="stroke:#00ff00"/>
  </g>
</svg>`

// No Inkscape layers: two plain groups of distinct colors, no layer metadata.
const PLAIN_SVG = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100">
  <g><rect x="0" y="0" width="10" height="10" style="stroke:#ff0000"/></g>
  <g><rect x="20" y="20" width="10" height="10" style="stroke:#00ff00"/></g>
</svg>`

beforeAll(() => {
  installSvgPathGeometry(window as unknown as { SVGElement: { prototype: object } })
})

describe('WO-1451: Inkscape layer names are recognized on import', () => {
  it('the old CSS attribute selector structurally matches zero namespaced layers', () => {
    const doc = new DOMParser().parseFromString(NAMED_LAYERS_SVG, 'image/svg+xml')
    const svg = doc.querySelector('svg')!
    // Companion evidence for the root cause: the escaped-colon attribute
    // selector sees a literal "inkscape:groupmode" attribute name and cannot
    // see the namespaced attribute, while getAttribute() can.
    expect(svg.querySelectorAll('g[inkscape\\:groupmode="layer"]')).toHaveLength(0)
    expect(svg.querySelectorAll('g')).toHaveLength(2)
    for (const g of Array.from(svg.querySelectorAll('g'))) {
      expect(g.getAttribute('inkscape:groupmode')).toBe('layer')
    }
  })

  it('importSVG() returns the labeled Inkscape layers, not color-keyed fallbacks', () => {
    const result: Import2DResult = importSVG(NAMED_LAYERS_SVG)

    const names = result.layers.map(l => l.name).sort()
    expect(names).toEqual(['Cut geometry', 'Engrave'])

    // No fallback naming leaked through
    expect(names.some(n => /^Layer \d+$/.test(n))).toBe(false)

    // Layer ids come from the group id attributes
    const ids = result.layers.map(l => l.id).sort()
    expect(ids).toEqual(['cut', 'engrave'])
  })

  it('assigns each layer\'s child geometry to that layer id', () => {
    const result: Import2DResult = importSVG(NAMED_LAYERS_SVG)

    const usedIds = new Set(result.loops.map(l => l.layerId))
    expect(usedIds).toEqual(new Set(['cut', 'engrave']))

    // The "Cut geometry" layer owns a loop (its rectangle imported)
    const cutLoops = result.loops.filter(l => l.layerId === 'cut')
    expect(cutLoops.length).toBeGreaterThan(0)

    // Layer ids in the result are exactly the Inkscape group ids
    const layerIds = new Set(result.layers.map(l => l.id))
    for (const id of usedIds) expect(layerIds.has(id)).toBe(true)
  })

  it('still falls back to color-based grouping when there are no Inkscape layers', () => {
    const result = importSVG(PLAIN_SVG)

    const names = result.layers.map(l => l.name).sort()
    expect(names).toEqual(['Layer 1', 'Layer 2'])
    const ids = result.layers.map(l => l.id).sort()
    expect(ids).toEqual(['color-0', 'color-1'])

    const usedIds = new Set(result.loops.map(l => l.layerId))
    expect(usedIds).toEqual(new Set(['color-0', 'color-1']))
  })
})