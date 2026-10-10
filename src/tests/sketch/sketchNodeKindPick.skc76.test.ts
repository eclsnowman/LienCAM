// WO SKC-76: node-kind hover/pick parity. Operator's repro (coordination/evidence/SKC-NODE-PICK/
// operator-corner-nodes-not-selectable.png): a line's free endpoint highlights on hover and is
// selectable, but a RECTANGLE CORNER does not react at all.
//
// Root cause (src/lib/sketch/sketcher/sketchLayer.ts pick()/pickGenerous()): types.ts's
// independent-endpoint doctrine means every profile corner (rectangle, chained polyline,
// chamfer/fillet trim site, ...) is TWO line endpoints joined by a `coincident` constraint,
// never a shared vertex. The endpoint tier's tie-break (added by SKC-57 for GENUINE ambiguity --
// two unrelated points that happen to overlap) treated a coincident-joined corner's two endpoint
// candidates as tied-and-ambiguous and refused outright: a lone line's free endpoint has exactly
// one candidate and always won, so only corners were ever silent.
//
// Fix: `coincidentGroupResolver` / `resolveTiedEndpointPick` (sketchLayer.ts) tell "same solved
// point via a coincident constraint" apart from "different points that happen to overlap right
// now" -- the former picks a deterministic winner, the latter still refuses exactly as before.
//
// This suite exercises `SketchLayer.pick()` directly (bare `new SketchLayer()`, no host/
// interaction layer -- same harness pattern as sketchLayerGenerousPick.test.ts and
// originAnchorLayer.test.ts) across the reported node kinds: a lone line endpoint (control), a
// rectangle-style joined corner (2-way coincident group), a 3-way coincident group (polyline
// vertex where three segments meet), a genuine overlap NOT joined by a constraint (ambiguity must
// still refuse), and a theoretical-intersect phantom point (SKC-75's construction `kind: 'point'`
// entity -- already hoverable/selectable via the ordinary point tier, asserted here as a
// regression guard so this lane's fix is not credited for behavior that already worked).
import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { SketchLayer } from '../../lib/sketch/sketcher/sketchLayer'
import { coincidentGroupResolver, resolveTiedEndpointPick } from '../../lib/sketch/sketcher/sketchLayer'
import { encodeEndpointSelectionRef } from '../../lib/sketch/centerReferences'
import type { Sketch, SketchEntity, SketchConstraint } from '../../lib/sketch/sketcher'

const VIEW_W = 800
const VIEW_H = 600
const WPP = 0.25
const SKETCH_PICK_PX = 8
const SKETCH_PICK_GENEROUS_PX = 16

function camera(): THREE.OrthographicCamera {
  const cam = new THREE.OrthographicCamera(-100, 100, 75, -75, 0.1, 1000)
  cam.position.set(0, 0, 10)
  cam.updateMatrixWorld(true)
  return cam
}

function toPx(local: { x: number; y: number }): { x: number; y: number } {
  return { x: 400 + local.x / WPP, y: 300 - local.y / WPP }
}

function sketch(entities: SketchEntity[], constraints: SketchConstraint[] = []): Sketch {
  return { id: 's', layerId: 'l', entities, constraints, dimensions: [], solveStatus: null }
}

function makeLayer(sk: Sketch): SketchLayer {
  const layer = new SketchLayer()
  layer.update(sk, { selectedIds: new Set(), glyphsVisible: false, editingId: null })
  layer.group.visible = true
  layer.onFrame(WPP)
  return layer
}

function coincident(id: string, a: { entityId: string; site: 'start' | 'end' }, b: { entityId: string; site: 'start' | 'end' }): SketchConstraint {
  return { id, kind: 'coincident', a, b }
}

describe('WO SKC-76: sketch node-kind hover/pick parity', () => {
  it('CONTROL: a lone line endpoint (no coincident joint) picks under the tight pass', () => {
    const layer = makeLayer(sketch([
      { id: 'ln1', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: 40, y: 0 } },
    ]))
    const cam = camera()
    const px = toPx({ x: 0, y: 0 })
    expect(layer.pick(px.x, px.y, cam, VIEW_W, VIEW_H, SKETCH_PICK_PX)).toEqual({
      id: encodeEndpointSelectionRef({ entityId: 'ln1', site: 'start' }),
      type: 'entity',
    })
    layer.dispose()
  })

  it("Operator's repro: a RECTANGLE-style corner (two lines' endpoints joined by a coincident constraint) hovers/picks, not refuses", () => {
    // Two lines meeting at (0,0) via a coincident constraint -- exactly the rig rectTools.ts
    // builds at every corner (types.ts: "Lines own their endpoints ... the corners are joined by
    // constraints, not shared vertices").
    const layer = makeLayer(sketch(
      [
        { id: 'top', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: 40, y: 0 } },
        { id: 'left', kind: 'line', construction: false, start: { x: 0, y: -30 }, end: { x: 0, y: 0 } },
      ],
      [coincident('c1', { entityId: 'top', site: 'start' }, { entityId: 'left', site: 'end' })],
    ))
    const cam = camera()
    const px = toPx({ x: 0, y: 0 })
    const hit = layer.pick(px.x, px.y, cam, VIEW_W, VIEW_H, SKETCH_PICK_PX)
    expect(hit).not.toBeNull()
    expect(hit!.type).toBe('entity')
    // Either owning endpoint is an acceptable, deterministic winner -- both name the same solved
    // point. Regression-pin the ACTUAL winner (lexicographically smallest encoded id) so a future
    // change to the tie-break rule is visible here, not just "still non-null".
    const idA = encodeEndpointSelectionRef({ entityId: 'top', site: 'start' })
    const idB = encodeEndpointSelectionRef({ entityId: 'left', site: 'end' })
    expect(hit!.id).toBe(idA < idB ? idA : idB)
    // Hovering the SAME point twice must resolve to the SAME winner (no flicker).
    expect(layer.pick(px.x, px.y, cam, VIEW_W, VIEW_H, SKETCH_PICK_PX)).toEqual(hit)
    layer.dispose()
  })

  it('a THREE-WAY coincident group (three segments meeting at one polyline vertex) also resolves, not refuses', () => {
    const layer = makeLayer(sketch(
      [
        { id: 'a', kind: 'line', construction: false, start: { x: -20, y: 0 }, end: { x: 0, y: 0 } },
        { id: 'b', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: 20, y: 10 } },
        { id: 'c', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: 20, y: -10 } },
      ],
      [
        coincident('c1', { entityId: 'a', site: 'end' }, { entityId: 'b', site: 'start' }),
        coincident('c2', { entityId: 'b', site: 'start' }, { entityId: 'c', site: 'start' }),
      ],
    ))
    const cam = camera()
    const px = toPx({ x: 0, y: 0 })
    const hit = layer.pick(px.x, px.y, cam, VIEW_W, VIEW_H, SKETCH_PICK_PX)
    expect(hit).not.toBeNull()
    expect(hit!.type).toBe('entity')
    layer.dispose()
  })

  it('GENUINE ambiguity still refuses: two endpoints exactly coincident WITHOUT a coincident constraint (unrelated overlap) picks null', () => {
    const layer = makeLayer(sketch([
      { id: 'ln1', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: 40, y: 0 } },
      { id: 'ln2', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: -40, y: 20 } },
    ]))
    const cam = camera()
    const px = toPx({ x: 0, y: 0 })
    expect(layer.pick(px.x, px.y, cam, VIEW_W, VIEW_H, SKETCH_PICK_PX)).toBeNull()
    layer.dispose()
  })

  it('REGRESSION GUARD: a theoretical-intersect phantom point (SKC-75 construction point entity) is already hoverable/selectable -- unaffected by this fix', () => {
    const layer = makeLayer(sketch([
      { id: 'phantom1', kind: 'point', construction: true, at: { x: 5, y: 5 } },
    ]))
    const cam = camera()
    const px = toPx({ x: 5, y: 5 })
    expect(layer.pick(px.x, px.y, cam, VIEW_W, VIEW_H, SKETCH_PICK_PX)).toEqual({
      id: 'phantom1',
      type: 'entity',
    })
    layer.dispose()
  })

  it('PASS 2 (GENEROUS, SKC-57 opt-in): a joined corner outside the tight radius but inside the generous one also resolves, not refuses', () => {
    const layer = makeLayer(sketch(
      [
        { id: 'top', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: 40, y: 0 } },
        { id: 'left', kind: 'line', construction: false, start: { x: 0, y: -30 }, end: { x: 0, y: 0 } },
      ],
      [coincident('c1', { entityId: 'top', site: 'start' }, { entityId: 'left', site: 'end' })],
    ))
    const cam = camera()
    // 3mm off the corner: outside the 2mm tight endpoint radius (SKETCH_PICK_PX * 1.5 * WPP),
    // inside the 4mm generous one (SKETCH_PICK_GENEROUS_PX * 1.5 * WPP).
    const px = toPx({ x: 0, y: 3 })
    expect(layer.pick(px.x, px.y, cam, VIEW_W, VIEW_H, SKETCH_PICK_PX)).toBeNull()
    const generousHit = layer.pick(
      px.x, px.y, cam, VIEW_W, VIEW_H, SKETCH_PICK_PX, undefined, undefined, SKETCH_PICK_GENEROUS_PX,
    )
    expect(generousHit).not.toBeNull()
    expect(generousHit!.type).toBe('entity')
    layer.dispose()
  })

  it('PASS 2 still refuses a genuine generous-radius ambiguity (two DIFFERENT, unjoined corners equidistant)', () => {
    const layer = makeLayer(sketch([
      { id: 'lnA', kind: 'line', construction: false, start: { x: -10, y: 3 }, end: { x: 50, y: 3 } },
      { id: 'lnB', kind: 'line', construction: false, start: { x: -10, y: -3 }, end: { x: 50, y: -3 } },
    ]))
    const cam = camera()
    const midPx = toPx({ x: -10, y: 0 })
    expect(
      layer.pick(midPx.x, midPx.y, cam, VIEW_W, VIEW_H, SKETCH_PICK_PX, undefined, undefined, SKETCH_PICK_GENEROUS_PX),
    ).toBeNull()
    layer.dispose()
  })
})

describe('WO SKC-76: coincidentGroupResolver / resolveTiedEndpointPick unit coverage', () => {
  it('groups endpoints transitively joined by coincident constraints, keeps unrelated endpoints in separate groups', () => {
    const constraints: SketchConstraint[] = [
      coincident('c1', { entityId: 'a', site: 'end' }, { entityId: 'b', site: 'start' }),
      coincident('c2', { entityId: 'b', site: 'start' }, { entityId: 'c', site: 'start' }),
    ]
    const groupOf = coincidentGroupResolver(constraints)
    const gA = groupOf({ entityId: 'a', site: 'end' })
    const gB = groupOf({ entityId: 'b', site: 'start' })
    const gC = groupOf({ entityId: 'c', site: 'start' })
    expect(gA).toBe(gB)
    expect(gB).toBe(gC)
    // A site never mentioned in any coincident constraint is its own singleton group, distinct
    // from the joined trio above.
    expect(groupOf({ entityId: 'd', site: 'start' })).not.toBe(gA)
  })

  it('resolveTiedEndpointPick: single nearest candidate always wins regardless of constraints', () => {
    const winner = resolveTiedEndpointPick(
      [{ id: 'x', d: 0.1, ref: { entityId: 'ln1', site: 'start' } }],
      [],
    )
    expect(winner).toBe('x')
  })

  it('resolveTiedEndpointPick: tied candidates in the SAME coincident group resolve to a deterministic winner', () => {
    const candidates = [
      { id: encodeEndpointSelectionRef({ entityId: 'top', site: 'start' }), d: 0, ref: { entityId: 'top', site: 'start' as const } },
      { id: encodeEndpointSelectionRef({ entityId: 'left', site: 'end' }), d: 0, ref: { entityId: 'left', site: 'end' as const } },
    ]
    const constraints = [coincident('c1', candidates[0].ref, candidates[1].ref)]
    const winner = resolveTiedEndpointPick(candidates, constraints)
    expect(winner).not.toBeNull()
    expect([candidates[0].id, candidates[1].id]).toContain(winner)
  })

  it('resolveTiedEndpointPick: tied candidates spanning DIFFERENT coincident groups still refuse (null)', () => {
    const candidates = [
      { id: 'idA', d: 0, ref: { entityId: 'a', site: 'start' as const } },
      { id: 'idB', d: 0, ref: { entityId: 'b', site: 'start' as const } },
    ]
    // No constraints joining a|start and b|start: a genuine, unrelated overlap.
    expect(resolveTiedEndpointPick(candidates, [])).toBeNull()
  })
})
