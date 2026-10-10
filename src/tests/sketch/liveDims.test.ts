// Live draw-dimension labels (pure liveDims helper): rectangle W/H, rotated
// rect L/W, ellipse a/b — what shows, WHERE it anchors, which way it pushes
// OUTWARD, and the display-unit formatting. Placement contract (Operator's
// verdict on fe32002): every label anchors at the MIDPOINT of its edge and
// its `out` unit vector points AWAY from the shape interior, so the overlay
// renders it outside the shape, centered on the line. The overlay component
// (SketchLiveDimsOverlay) renders these verbatim, so pinning the pure layer
// pins the shown numbers and sides.

import { describe, it, expect } from 'vitest'
import { liveDrawLabels, formatLiveDim, type LiveDimLabel } from '../../lib/sketch/tools/liveDims'
import type { ToolChainState } from '../../lib/sketch/tools/toolMachine'
import type { Vec2 } from '../../lib/sketch/types'

const rectChain = (mode: 'corner' | 'center'): ToolChainState => ({
  kind: 'rect', mode, anchor: { x: 0, y: 0 },
})

const dot = (a: Vec2, b: Vec2) => a.x * b.x + a.y * b.y

/** `out` must be UNIT length and point away from the shape interior:
 *  stepping from the anchor along `out` moves AWAY from the centroid. */
function expectOutward(label: LiveDimLabel, centroid: Vec2) {
  expect(Math.hypot(label.out.x, label.out.y)).toBeCloseTo(1, 9)
  const toAnchor = { x: label.at.x - centroid.x, y: label.at.y - centroid.y }
  expect(dot(label.out, toAnchor)).toBeGreaterThan(0)
}

describe('liveDrawLabels: rectangle', () => {
  it('corner rect (drag down-right): W outside the TOP edge midpoint, H outside the LEFT edge midpoint', () => {
    // Anchor (0,0), cursor (40,-30): a 40x30 rect below-right of the anchor.
    const labels = liveDrawLabels(rectChain('corner'), { x: 40, y: -30 }, 'mm')
    expect(labels.map((l) => l.key)).toEqual(['w', 'h'])
    const w = labels.find((l) => l.key === 'w')!
    const h = labels.find((l) => l.key === 'h')!
    expect(w.text).toBe('40')
    expect(h.text).toBe('30')
    // W anchors at the top-edge (max-Y) midpoint and pushes toward +y —
    // ABOVE the rect, outside it (anchor.y === rect maxY, out.y > 0).
    expect(w.at).toEqual({ x: 20, y: 0 })
    expect(w.out).toEqual({ x: 0, y: 1 })
    // H anchors at the left-edge (min-X) midpoint and pushes toward -x —
    // LEFT of the rect, outside it.
    expect(h.at).toEqual({ x: 0, y: -15 })
    expect(h.out).toEqual({ x: -1, y: 0 })
    const centroid = { x: 20, y: -15 }
    expectOutward(w, centroid)
    expectOutward(h, centroid)
  })

  it('drag UP-LEFT still puts W outside the top edge and H outside the left edge', () => {
    // Anchor (0,0), cursor (-40, 30): the rect grows up-left of the anchor.
    const labels = liveDrawLabels(rectChain('corner'), { x: -40, y: 30 }, 'mm')
    const w = labels.find((l) => l.key === 'w')!
    const h = labels.find((l) => l.key === 'h')!
    // Top edge is now y = 30 (the CURSOR side), left edge x = -40.
    expect(w.at).toEqual({ x: -20, y: 30 })
    expect(w.out).toEqual({ x: 0, y: 1 })
    expect(h.at).toEqual({ x: -40, y: 15 })
    expect(h.out).toEqual({ x: -1, y: 0 })
    // W sits ON the max-Y edge and steps beyond it; H on/beyond min-X.
    expect(w.at.y).toBe(30)                       // rect maxY
    expect(w.at.y + w.out.y).toBeGreaterThan(30)  // outside (above)
    expect(h.at.x).toBe(-40)                      // rect minX
    expect(h.at.x + h.out.x).toBeLessThan(-40)    // outside (left)
    const centroid = { x: -20, y: 15 }
    expectOutward(w, centroid)
    expectOutward(h, centroid)
  })

  it('center rect doubles the span (cursor is a corner, anchor the center)', () => {
    const labels = liveDrawLabels(rectChain('center'), { x: 10, y: 5 }, 'mm')
    const w = labels.find((l) => l.key === 'w')!
    const h = labels.find((l) => l.key === 'h')!
    expect(w.text).toBe('20')
    expect(h.text).toBe('10')
    expect(w.at).toEqual({ x: 0, y: 5 })   // top edge midpoint
    expect(w.out).toEqual({ x: 0, y: 1 })
    expect(h.at).toEqual({ x: -10, y: 0 }) // left edge midpoint
    expect(h.out).toEqual({ x: -1, y: 0 })
    expectOutward(w, { x: 0, y: 0 })       // center-mode centroid IS the anchor
    expectOutward(h, { x: 0, y: 0 })
  })

  it('formats in DISPLAY units (25.4 mm -> 1 inch)', () => {
    const labels = liveDrawLabels(rectChain('corner'), { x: 25.4, y: -12.7 }, 'inch')
    expect(labels.find((l) => l.key === 'w')!.text).toBe('1')
    expect(labels.find((l) => l.key === 'h')!.text).toBe('0.5')
  })

  it('rotated rect: first-edge rubber band shows the length, offset perpendicular to the edge', () => {
    const chain: ToolChainState = {
      kind: 'rect', mode: 'corner', rotated: true, anchor: { x: 0, y: 0 },
    }
    const labels = liveDrawLabels(chain, { x: 30, y: 40 }, 'mm')
    expect(labels).toHaveLength(1)
    expect(labels[0].key).toBe('l')
    expect(labels[0].text).toBe('50') // hypot(30,40)
    expect(labels[0].at).toEqual({ x: 15, y: 20 }) // edge midpoint
    // No interior exists yet: out is a UNIT perpendicular of the edge.
    expect(Math.hypot(labels[0].out.x, labels[0].out.y)).toBeCloseTo(1, 9)
    expect(dot(labels[0].out, { x: 30, y: 40 })).toBeCloseTo(0, 9)
  })

  it('rotated rect width phase: L and W centered on their edges, outward perpendicular from the centroid', () => {
    // First edge (0,0)->(30,40) (len 50), width point (-40,30): corners
    // (0,0) (30,40) (-10,70) (-40,30), centroid (-5,35), width 50.
    const chain: ToolChainState = {
      kind: 'rect', mode: 'corner', rotated: true,
      anchor: { x: 0, y: 0 }, edgeEnd: { x: 30, y: 40 },
    }
    const labels = liveDrawLabels(chain, { x: -40, y: 30 }, 'mm')
    expect(labels.map((l) => l.key)).toEqual(['l', 'w'])
    const l = labels[0], w = labels[1]
    expect(l.text).toBe('50')
    expect(w.text).toBe('50')
    const centroid = { x: -5, y: 35 }
    // L: midpoint of the first edge, pushed perpendicular AWAY from centroid.
    expect(l.at).toEqual({ x: 15, y: 20 })
    expect(dot(l.out, { x: 30, y: 40 })).toBeCloseTo(0, 9)  // perp to its edge
    expectOutward(l, centroid)
    expect(l.out.x).toBeCloseTo(0.8, 9)   // = -n, the away-from-width side
    expect(l.out.y).toBeCloseTo(-0.6, 9)
    // W: midpoint of the width edge (30,40)->(-10,70), perp to THAT edge.
    expect(w.at).toEqual({ x: 10, y: 55 })
    expect(dot(w.out, { x: -40, y: 30 })).toBeCloseTo(0, 9) // perp to its edge
    expectOutward(w, centroid)
    expect(w.out.x).toBeCloseTo(0.6, 9)   // along the first-edge direction
    expect(w.out.y).toBeCloseTo(0.8, 9)
  })

  it('degenerate zero-size drag shows nothing (never a 0x0 label pair)', () => {
    expect(liveDrawLabels(rectChain('corner'), { x: 0, y: 0 }, 'mm')).toEqual([])
  })
})

describe('liveDrawLabels: ellipse', () => {
  it('major-axis rubber band shows the live major radius at the midpoint, offset perpendicular', () => {
    const chain: ToolChainState = {
      kind: 'ellipse', center: { x: 0, y: 0 }, major: null,
    }
    const labels = liveDrawLabels(chain, { x: 10, y: 0 }, 'mm')
    expect(labels).toHaveLength(1)
    expect(labels[0].key).toBe('a')
    expect(labels[0].text).toBe('10')
    expect(labels[0].at).toEqual({ x: 5, y: 0 })
    expect(Math.hypot(labels[0].out.x, labels[0].out.y)).toBeCloseTo(1, 9)
    expect(dot(labels[0].out, { x: 10, y: 0 })).toBeCloseTo(0, 9)
  })

  it('minor phase: a and b anchor at the axis vertices and push radially OUTWARD (outside the outline)', () => {
    const chain: ToolChainState = {
      kind: 'ellipse', center: { x: 0, y: 0 }, major: { x: 10, y: 0 },
    }
    const labels = liveDrawLabels(chain, { x: 0, y: 3 }, 'mm')
    expect(labels.map((l) => l.key)).toEqual(['a', 'b'])
    const a = labels[0], b = labels[1]
    expect(a.text).toBe('10')
    expect(b.text).toBe('3')
    expect(a.at.x).toBeCloseTo(10, 9) // +major vertex
    expect(a.at.y).toBeCloseTo(0, 9)
    expect(b.at.x).toBeCloseTo(0, 9)  // +minor co-vertex
    expect(b.at.y).toBeCloseTo(3, 9)
    // Radially outward = away from the center, so anchor + out lies OUTSIDE
    // the outline (farther from center than the vertex itself).
    expect(a.out.x).toBeCloseTo(1, 9)
    expect(a.out.y).toBeCloseTo(0, 9)
    expect(b.out.x).toBeCloseTo(0, 9)
    expect(b.out.y).toBeCloseTo(1, 9)
    expectOutward(a, { x: 0, y: 0 })
    expectOutward(b, { x: 0, y: 0 })
  })

  it('ROTATED ellipse (major along +y): vertex labels still push radially outward', () => {
    const chain: ToolChainState = {
      kind: 'ellipse', center: { x: 0, y: 0 }, major: { x: 0, y: 10 },
    }
    const labels = liveDrawLabels(chain, { x: 3, y: 0 }, 'mm')
    const a = labels.find((l) => l.key === 'a')!
    const b = labels.find((l) => l.key === 'b')!
    // a vertex at (0,10), out straight up; b co-vertex at (-3,0), out -x.
    expect(a.at.x).toBeCloseTo(0, 9)
    expect(a.at.y).toBeCloseTo(10, 9)
    expect(a.out.x).toBeCloseTo(0, 9)
    expect(a.out.y).toBeCloseTo(1, 9)
    expect(b.at.x).toBeCloseTo(-3, 9)
    expect(b.at.y).toBeCloseTo(0, 9)
    expect(b.out.x).toBeCloseTo(-1, 9)
    expect(b.out.y).toBeCloseTo(0, 9)
    expectOutward(a, { x: 0, y: 0 })
    expectOutward(b, { x: 0, y: 0 })
  })

  it('cursor ON the major axis (zero minor) shows only the a label', () => {
    const chain: ToolChainState = {
      kind: 'ellipse', center: { x: 0, y: 0 }, major: { x: 10, y: 0 },
    }
    const labels = liveDrawLabels(chain, { x: 5, y: 0 }, 'mm')
    expect(labels.map((l) => l.key)).toEqual(['a'])
  })

  it('elliptical-arc param-pick phases (ellipse fixed) show nothing', () => {
    const chain: ToolChainState = {
      kind: 'ellipse-arc', center: { x: 0, y: 0 },
      major: { x: 10, y: 0 }, minor: { x: 0, y: 3 }, start: null,
    }
    expect(liveDrawLabels(chain, { x: 8, y: 8 }, 'mm')).toEqual([])
  })
})

describe('liveDrawLabels: gating', () => {
  it('null chain (idle / just committed) shows nothing', () => {
    expect(liveDrawLabels(null, { x: 5, y: 5 }, 'mm')).toEqual([])
  })

  it('unrelated chain kinds show nothing', () => {
    const chain: ToolChainState = {
      kind: 'line', start: { x: 0, y: 0 }, firstLineId: null,
      prev: { x: 0, y: 0 }, prevLineId: null,
    }
    expect(liveDrawLabels(chain, { x: 5, y: 5 }, 'mm')).toEqual([])
  })
})

describe('formatLiveDim', () => {
  it('mm: 2dp with trailing zeros trimmed', () => {
    expect(formatLiveDim(40, 'mm')).toBe('40')
    expect(formatLiveDim(40.126, 'mm')).toBe('40.13')
  })
  it('inch: converts and keeps 4dp trimmed', () => {
    expect(formatLiveDim(25.4, 'inch')).toBe('1')
    expect(formatLiveDim(10, 'inch')).toBe('0.3937')
  })
})
