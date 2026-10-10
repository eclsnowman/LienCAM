// WO SKC-57: SketchLayer.pick()'s opt-in PASS 2 (GENEROUS) -- Operator's ask that an unambiguous
// click/hover near a lone entity should not have to be pixel-exact, while a click that could mean
// two things must still refuse. These tests exercise pick() directly (bare `new SketchLayer()`,
// no host/interaction layer -- same pattern as src/tests/sketch/originAnchorLayer.test.ts), since
// the PASS 1/PASS 2 tier logic under test lives entirely in SketchLayer.pick() and does not depend
// on camera pose (that is SKC-54/SKC-55's own, separately-covered concern).
import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { SketchLayer } from '../../lib/sketch/sketcher/sketchLayer'
import type { Sketch, SketchEntity } from '../../lib/sketch/sketcher'

const VIEW_W = 800
const VIEW_H = 600

/** Orthographic camera + viewport pair whose world-per-pixel is IDENTICAL on both axes (frustum
 *  aspect matches the 800x600 viewport aspect exactly), looking squarely down -Z at the identity
 *  XY plane -- same camera shape src/tests/sketch/originAnchorLayer.test.ts uses for its own
 *  `layer.pick()` legs. Pixel (400,300) maps to local (0,0). */
function camera(): THREE.OrthographicCamera {
  const cam = new THREE.OrthographicCamera(-100, 100, 75, -75, 0.1, 1000)
  cam.position.set(0, 0, 10)
  cam.updateMatrixWorld(true)
  return cam
}

// world-per-pixel for the frustum/viewport pair above: (200mm / 800px) === (150mm / 600px) ===
// 0.25. `onFrame(WPP)` below feeds this bare layer's `lastWorldPerPixel` (no pointWorldPerPixel
// callback is wired, so worldPerPixelAt() always returns this flat value) -- deliberately equal to
// the camera's own raw-NDC pixel scale so a screen-pixel offset and a tolerance-mm figure convert
// through the SAME constant.
const WPP = 0.25
const SKETCH_PICK_PX = 8
const SKETCH_PICK_GENEROUS_PX = 16

/** Local (sketch) mm -> canvas pixel, inverting the legacy raw-NDC unprojection this bare layer's
 *  `pick()` calls fall back to (no clientX/clientY supplied below, matching the existing bare-layer
 *  test convention). */
function toPx(local: { x: number; y: number }): { x: number; y: number } {
  return { x: 400 + local.x / WPP, y: 300 - local.y / WPP }
}

function sketch(entities: SketchEntity[], dimensions: Sketch['dimensions'] = []): Sketch {
  return { id: 's', layerId: 'l', entities, constraints: [], dimensions, solveStatus: null }
}

function makeLayer(sk: Sketch): SketchLayer {
  const layer = new SketchLayer()
  layer.update(sk, { selectedIds: new Set(), glyphsVisible: false, editingId: null })
  layer.group.visible = true
  layer.onFrame(WPP)
  return layer
}

describe('WO SKC-57: SketchLayer.pick() PASS 2 (GENEROUS, opt-in)', () => {
  it('a lonely line 3mm away (12px, between the 2mm tight and 4mm generous radii) picks only under GENEROUS', () => {
    // SKC-62 (2026-07-18, after this WO SKC-57 test was authored) made every
    // line's midpoint a first-class, ALWAYS-VISIBLE center-reference target
    // that outranks the owning curve in pick()'s tier order -- deliberate,
    // Established pick-order matching, same priority pattern already established for
    // line/arc endpoints. A line centered on x=0 would put this test's click
    // exactly in that midpoint's tolerance ring too, which is a DIFFERENT
    // claim than the one under test here (generous CURVE picking). The line
    // is offset so its midpoint sits far outside every pick tolerance below,
    // isolating the curve-tier behavior this test actually verifies -- see
    // 'a click at a line's midpoint resolves to its SKC-62 center reference'
    // further down for the center-tier coverage.
    const layer = makeLayer(sketch([
      { id: 'ln1', kind: 'line', construction: false, start: { x: -10, y: 0 }, end: { x: 50, y: 0 } },
    ]))
    const cam = camera()
    const px = toPx({ x: 0, y: 3 })
    expect(layer.pick(px.x, px.y, cam, VIEW_W, VIEW_H, SKETCH_PICK_PX)).toBeNull()
    expect(
      layer.pick(px.x, px.y, cam, VIEW_W, VIEW_H, SKETCH_PICK_PX, undefined, undefined, SKETCH_PICK_GENEROUS_PX),
    ).toEqual({ id: 'ln1', type: 'entity' })
    layer.dispose()
  })

  it("a click at a line's midpoint resolves to its SKC-62 center reference, not the line (tier priority)", () => {
    const layer = makeLayer(sketch([
      { id: 'ln1', kind: 'line', construction: false, start: { x: -15, y: 0 }, end: { x: 15, y: 0 } },
    ]))
    const cam = camera()
    // Dead-on the midpoint: both the curve and its center ref are at d=0,
    // and centerSelectionIdForEntity's tier is checked BEFORE the curve
    // tier (sketchLayer.ts pick()), so the center reference wins -- same
    // priority class as line/arc endpoints, not a curve pick.
    const px = toPx({ x: 0, y: 0 })
    expect(layer.pick(px.x, px.y, cam, VIEW_W, VIEW_H, SKETCH_PICK_PX)).toEqual({
      id: '__sketch_center_ref__:ln1',
      type: 'entity',
    })
    layer.dispose()
  })

  it('a lonely standalone point 4.5mm away (between the WIDENED 3mm tight and 6mm generous point radii) picks only under GENEROUS', () => {
    const layer = makeLayer(sketch([
      { id: 'pt1', kind: 'point', construction: false, at: { x: 30, y: 0 } },
    ]))
    const cam = camera()
    const px = toPx({ x: 30, y: 4.5 })
    expect(layer.pick(px.x, px.y, cam, VIEW_W, VIEW_H, SKETCH_PICK_PX)).toBeNull()
    expect(
      layer.pick(px.x, px.y, cam, VIEW_W, VIEW_H, SKETCH_PICK_PX, undefined, undefined, SKETCH_PICK_GENEROUS_PX),
    ).toEqual({ id: 'pt1', type: 'entity' })
    layer.dispose()
  })

  it('two equidistant parallel lines in the generous radius REFUSE; a tight-radius click on one still picks it (PASS 1 regression guard)', () => {
    // Offset off x=0 for the same SKC-62 midpoint-collision reason as the
    // lone-line test above: both lines would otherwise center exactly under
    // every click point used below.
    const layer = makeLayer(sketch([
      { id: 'lnA', kind: 'line', construction: false, start: { x: -10, y: 3 }, end: { x: 50, y: 3 } },
      { id: 'lnB', kind: 'line', construction: false, start: { x: -10, y: -3 }, end: { x: 50, y: -3 } },
    ]))
    const cam = camera()

    // Equidistant (3mm from each -- inside the 4mm generous radius, outside the 2mm tight one).
    const midPx = toPx({ x: 0, y: 0 })
    expect(layer.pick(midPx.x, midPx.y, cam, VIEW_W, VIEW_H, SKETCH_PICK_PX)).toBeNull()
    expect(
      layer.pick(midPx.x, midPx.y, cam, VIEW_W, VIEW_H, SKETCH_PICK_PX, undefined, undefined, SKETCH_PICK_GENEROUS_PX),
    ).toBeNull() // 2 candidates in generous range -> refuse, never guess

    // 1.5mm from lnA (inside the 2mm TIGHT radius), 4.5mm from lnB (outside even the generous
    // one): PASS 1 resolves this unambiguously before PASS 2 ever runs, generous opt-in or not.
    const nearAPx = toPx({ x: 0, y: 1.5 })
    expect(
      layer.pick(nearAPx.x, nearAPx.y, cam, VIEW_W, VIEW_H, SKETCH_PICK_PX, undefined, undefined, SKETCH_PICK_GENEROUS_PX),
    ).toEqual({ id: 'lnA', type: 'entity' })
    layer.dispose()
  })

  it('a standalone point entity coincident with a line endpoint wins tier priority under GENEROUS (P10)', () => {
    const layer = makeLayer(sketch([
      { id: 'lnE', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: 20, y: 0 } },
      { id: 'ptE', kind: 'point', construction: false, at: { x: 20, y: 0 } },
    ]))
    const cam = camera()
    // 3.5mm from BOTH the point and the line's endpoint (perpendicular offset at the shared x):
    // outside the 2mm tight curve radius AND the 3mm widened tight point radius, so PASS 1 misses
    // entirely; inside the 4mm generous curve radius AND the 6mm widened generous point radius, so
    // PASS 2 must choose -- and the points tier is checked FIRST, same priority as PASS 1.
    const px = toPx({ x: 20, y: 3.5 })
    expect(layer.pick(px.x, px.y, cam, VIEW_W, VIEW_H, SKETCH_PICK_PX)).toBeNull()
    expect(
      layer.pick(px.x, px.y, cam, VIEW_W, VIEW_H, SKETCH_PICK_PX, undefined, undefined, SKETCH_PICK_GENEROUS_PX),
    ).toEqual({ id: 'ptE', type: 'entity' })
    layer.dispose()
  })

  it('PASS 2 never rescues a DIMENSION: a generous-only-range click still misses; a dead-on tight click still hits', () => {
    const layer = makeLayer(sketch(
      [{ id: 'c1', kind: 'circle', construction: false, center: { x: 0, y: 0 }, radius: 5 }],
      [{ id: 'dr', kind: 'radius', driving: true, value: 5, entityId: 'c1' }],
    ))
    const cam = camera()
    // dimensionDisplay's default radius-dim anchor: (radius + DIM_OFFSET_MM(7)) along a 45deg ray
    // from the circle's center, i.e. 12 * (cos45, sin45) -- see sketchLayer.ts's dimensionDisplay.
    const anchor = { x: 12 * Math.SQRT1_2, y: 12 * Math.SQRT1_2 }
    // Perpendicular to that radial leader, so the offset click's nearest point on the leader
    // segment is the anchor itself (the segment's far endpoint) -- a clean, uninflated 3mm from
    // the dimension by construction, clear of the circle (~7mm away, clear of every tol below).
    const perp = { x: -Math.SQRT1_2, y: Math.SQRT1_2 }
    const nearPx = toPx({ x: anchor.x + perp.x * 3, y: anchor.y + perp.y * 3 })
    expect(layer.pick(nearPx.x, nearPx.y, cam, VIEW_W, VIEW_H, SKETCH_PICK_PX)).toBeNull()
    expect(
      layer.pick(nearPx.x, nearPx.y, cam, VIEW_W, VIEW_H, SKETCH_PICK_PX, undefined, undefined, SKETCH_PICK_GENEROUS_PX),
    ).toBeNull() // badges and dimensions never participate in PASS 2

    const onPx = toPx(anchor)
    expect(layer.pick(onPx.x, onPx.y, cam, VIEW_W, VIEW_H, SKETCH_PICK_PX)).toEqual({ id: 'dr', type: 'dimension' })
    layer.dispose()
  })
})
