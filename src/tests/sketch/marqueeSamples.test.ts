// Marquee (box-select) SAMPLE points for text -- entitySamples.
//
// entitiesInRect hit-tests a marquee against each entity's flattened sample
// vertices. For ON-PATH text those samples must come from the WARPED render
// layout (where the glyphs actually draw), NOT the free layout at the ignored
// anchor -- otherwise the marquee selects the text where it is NOT drawn (the
// same wrong-place class as the pick bug fixed in 8e2f834). This file pins
// that: an on-path text whose free anchor sits FAR from its host path must
// sample ON the path, never near the anchor. Free text (no pathId) still
// samples at its anchor (the contrast case).

import { describe, it, expect } from 'vitest'
import { entitySamples } from '../../lib/sketch/sketcher/sketchLayer'
import type {
  SketchEntity, SketchLineEntity, SketchTextEntity,
} from '../../lib/sketch/types'

// Path: +X line 0..200 at y=0. On-path text samples land near y=0.
const LINE: SketchLineEntity = {
  id: 'ln', kind: 'line', construction: false,
  start: { x: 0, y: 0 }, end: { x: 200, y: 0 },
}
// Anchor deliberately parked FAR from the path so free-vs-warped is
// unambiguous: pre-fix the samples clustered here, post-fix they do not.
const FAR_ANCHOR = { x: 500, y: 500 }

function onPathText(over: Partial<SketchTextEntity> = {}): SketchTextEntity {
  return {
    id: 'tx', kind: 'text', construction: false,
    at: FAR_ANCHOR, text: 'AB', height: 8, rotation: 0,
    fontStyle: 'single-line', pathId: 'ln', pathAlign: 'free', pathOffsetMm: 50,
    ...over,
  }
}

const distToAnchor = (p: { x: number; y: number }) =>
  Math.hypot(p.x - FAR_ANCHOR.x, p.y - FAR_ANCHOR.y)

describe('entitySamples: on-path text samples the WARPED layout, not the anchor', () => {
  it('single-line on-path text: samples ride the path, none near the far anchor', () => {
    const e = onPathText()
    const samples = entitySamples(e, [LINE, e])
    expect(samples.length).toBeGreaterThan(0)
    // Every sample sits in the band along the +X path (y ~ [0, height]),
    // near the offset, and NOWHERE near the (500,500) anchor.
    for (const p of samples) {
      expect(p.y).toBeGreaterThan(-2)
      expect(p.y).toBeLessThan(12)      // within cap height + slack of the path
      expect(p.x).toBeGreaterThan(30)   // past text start (offset 50 minus slack)
      expect(p.x).toBeLessThan(140)     // 'AB' is short; well before x=200
      expect(distToAnchor(p)).toBeGreaterThan(400)
    }
  })

  it('outline on-path text: same -- warped samples, not the anchor', () => {
    const e = onPathText({ fontStyle: 'outline' })
    const samples = entitySamples(e, [LINE, e])
    expect(samples.length).toBeGreaterThan(0)
    for (const p of samples) {
      expect(distToAnchor(p)).toBeGreaterThan(400)
      expect(p.y).toBeLessThan(12)
    }
  })

  it('CONTRAST: FREE text (no pathId) still samples at its anchor', () => {
    const free: SketchTextEntity = {
      id: 'tf', kind: 'text', construction: false,
      at: FAR_ANCHOR, text: 'AB', height: 8, rotation: 0, fontStyle: 'single-line',
    }
    const samples = entitySamples(free, [free])
    expect(samples.length).toBeGreaterThan(0)
    // Free layout: samples cluster AT the anchor (the whole box within a few
    // cap heights of it), never down on the y=0 path.
    for (const p of samples) {
      expect(distToAnchor(p)).toBeLessThan(60)
    }
  })

  it('on-path text whose path is missing falls back to the free layout (loud, not empty)', () => {
    // A dangling pathId resolves to null -> free-layout samples at the anchor;
    // the marquee still hits SOMETHING rather than silently sampling nothing.
    const e = onPathText({ pathId: 'gone' })
    const entities: SketchEntity[] = [LINE, e] // no entity 'gone'
    const samples = entitySamples(e, entities)
    expect(samples.length).toBeGreaterThan(0)
    for (const p of samples) expect(distToAnchor(p)).toBeLessThan(60)
  })
})
