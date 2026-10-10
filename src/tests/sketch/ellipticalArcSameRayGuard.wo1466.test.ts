// WO-1466 / BUG-494: an elliptical arc's end click farther along the SAME
// RAY as the start click (not the same point) mapped to the same eccentric
// parameter as the start -- creation accepted it (raw pointer distance was
// large), render showed a full ellipse (ellipticalArcSweep's full-turn
// remap), and bake published nothing for it (bake.ts already measures the
// RAW, un-remapped sweep). One authored state, three disagreeing readings.
// This exercises the fix: the click-5 guard now validates the MAPPED
// parameters, and the preview no longer shows a full ellipse for a
// same-ray cursor.

import { describe, it, expect } from 'vitest'
import {
  toolClick, toolPreview, type ToolState,
} from '../../lib/sketch/tools/toolMachine'
import { ellipseFromClicks } from '../../lib/sketch/tools/ellipseTools'
import { ellipseParamFromPoint, ellipsePointAt } from '../../lib/sketch/ellipse'
import { bakeSketch } from '../../lib/sketch/bake'
import type { Sketch, SketchEntity, SketchEllipticalArcEntity } from '../../lib/sketch/types'

const TOL = 0.5

function idFactory(): () => string {
  let n = 0
  return () => `id${n++}`
}
function armed(tool: ToolState['tool']): ToolState {
  return { tool, chain: null }
}

function sketchOf(entities: SketchEntity[]): Sketch {
  return {
    id: 'sk', layerId: 'L', entities, constraints: [], dimensions: [],
    solveStatus: { dof: 0, conflicting: [], redundant: [] },
  }
}

describe('WO-1466: elliptical-arc same-ray guard (BUG-494)', () => {
  it('rejects an end click farther along the SAME RAY as the start click', () => {
    const newId = idFactory()
    // Ellipse: center (0,0), major (10,0) -> majorRadius 10, minor (0,5) ->
    // minorRadius 5, axis-aligned. Start click at (3,4); end click at (6,8)
    // is TWICE as far from center along the exact same ray (6,8) = 2*(3,4)
    // -- far apart in world space (raw distance 5, well outside TOL) but the
    // same DIRECTION from the center, so both map to the identical eccentric
    // parameter.
    let r = toolClick(armed('ellipse-arc'), { x: 0, y: 0 }, TOL, newId)
    r = toolClick(r.state, { x: 10, y: 0 }, TOL, newId) // major
    r = toolClick(r.state, { x: 0, y: 5 }, TOL, newId)  // minor
    r = toolClick(r.state, { x: 3, y: 4 }, TOL, newId)  // start
    const rawDist = Math.hypot(6 - 3, 8 - 4)
    expect(rawDist).toBeGreaterThan(TOL) // the raw-pointer-distance guard would NOT catch this
    const end = toolClick(r.state, { x: 6, y: 8 }, TOL, newId) // end: same ray, farther out

    expect(end.commit).toBeNull()
    expect(end.notice).toBeTruthy()
    // The chain is unconsumed: the start click still stands, tool stays armed
    // for another end click (fail-loud, not a silent full-turn commit).
    expect((end.state.chain as { start: unknown }).start).toEqual({ x: 3, y: 4 })
  })

  it('a near-ray click (tiny mapped-parameter drift, not bit-exact) is still rejected -- real mouse clicks round-trip through screen pixels, so BUG-494 never reproduces as an EXACT parameter match', () => {
    const newId = idFactory()
    let r = toolClick(armed('ellipse-arc'), { x: 0, y: 0 }, TOL, newId)
    r = toolClick(r.state, { x: 10, y: 0 }, TOL, newId) // major
    r = toolClick(r.state, { x: 0, y: 5 }, TOL, newId)  // minor
    r = toolClick(r.state, { x: 3, y: 4 }, TOL, newId)  // start

    const shape = ellipseFromClicks({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 5 })
    const startParam = ellipseParamFromPoint(shape, { x: 3, y: 4 })
    // A 1e-4 rad drift is orders of magnitude bigger than the 1e-9 an
    // exact-float-equality guard would require, but still far too small a
    // curve distance to be a real, distinguishable arc at TOL=0.5 -- this is
    // the shape of the sub-pixel noise a real screen->world round trip
    // leaves on an intentional same-ray click.
    const nearRayPoint = ellipsePointAt(shape, startParam + 1e-4)
    // Scaling a point away from the center preserves ellipseParamFromPoint's
    // DIRECTION-only reading (BUG-494's exact mechanism), so this click
    // lands far from the start click in world space while still mapping
    // within 1e-4 rad of startParam.
    const farEnd = {
      x: shape.center.x + (nearRayPoint.x - shape.center.x) * 5,
      y: shape.center.y + (nearRayPoint.y - shape.center.y) * 5,
    }
    expect(Math.hypot(farEnd.x - 3, farEnd.y - 4)).toBeGreaterThan(TOL)

    const end = toolClick(r.state, farEnd, TOL, newId)
    expect(end.commit).toBeNull()
    expect(end.notice).toBeTruthy()
  })

  it('the existing exact-same-click refusal still works unchanged', () => {
    const newId = idFactory()
    let r = toolClick(armed('ellipse-arc'), { x: 0, y: 0 }, TOL, newId)
    r = toolClick(r.state, { x: 10, y: 0 }, TOL, newId) // major
    r = toolClick(r.state, { x: 0, y: 5 }, TOL, newId)  // minor
    r = toolClick(r.state, { x: 10, y: 0 }, TOL, newId) // start
    const end = toolClick(r.state, { x: 10.1, y: 0 }, TOL, newId) // end ~ start
    expect(end.commit).toBeNull()
    expect((end.state.chain as { start: unknown }).start).toEqual({ x: 10, y: 0 })
  })

  it('a normal elliptical arc (genuinely different params) still creates, previews and bakes', () => {
    const newId = idFactory()
    let r = toolClick(armed('ellipse-arc'), { x: 0, y: 0 }, TOL, newId)
    r = toolClick(r.state, { x: 10, y: 0 }, TOL, newId) // major
    r = toolClick(r.state, { x: 0, y: 5 }, TOL, newId)  // minor
    r = toolClick(r.state, { x: 3, y: 4 }, TOL, newId)  // start
    const preview = toolPreview(r.state, { x: -4, y: -3 })
    expect(preview).not.toBeNull()
    expect(preview!.length).toBeGreaterThan(2)

    const end = toolClick(r.state, { x: -4, y: -3 }, TOL, newId) // genuinely different direction
    expect(end.commit).not.toBeNull()
    const arc = end.commit!.entities[0] as SketchEllipticalArcEntity
    expect(arc.kind).toBe('elliptical-arc')
    expect(arc.startParam).not.toBeCloseTo(arc.endParam, 6)

    const { loops } = bakeSketch(sketchOf([arc]), { newId: idFactory() })
    expect(loops.length).toBe(1)
    expect(loops[0].type).toBe('open')
  })

  it('preview never shows a full ellipse for a same-ray cursor (dot at start instead)', () => {
    const newId = idFactory()
    let r = toolClick(armed('ellipse-arc'), { x: 0, y: 0 }, TOL, newId)
    r = toolClick(r.state, { x: 10, y: 0 }, TOL, newId) // major
    r = toolClick(r.state, { x: 0, y: 5 }, TOL, newId)  // minor
    r = toolClick(r.state, { x: 3, y: 4 }, TOL, newId)  // start
    const preview = toolPreview(r.state, { x: 6, y: 8 })! // same ray, farther out
    expect(preview.length).toBe(2)
    // A degenerate dot: both points equal (never a closed full-ellipse polyline).
    expect(preview[0]).toEqual(preview[1])
  })

  it('re-entry after a rejected same-ray click still commits a genuinely valid arc', () => {
    // Nothing was authored by the rejected click (acceptance-1 picked
    // refusal, not a full-turn representation), so there is no entity whose
    // file-reopen behavior could disagree -- the only thing to preserve is
    // that the tool chain survives the rejection and a subsequent valid end
    // click still commits and bakes normally.
    const newId = idFactory()
    let r = toolClick(armed('ellipse-arc'), { x: 0, y: 0 }, TOL, newId)
    r = toolClick(r.state, { x: 10, y: 0 }, TOL, newId) // major
    r = toolClick(r.state, { x: 0, y: 5 }, TOL, newId)  // minor
    r = toolClick(r.state, { x: 3, y: 4 }, TOL, newId)  // start
    const rejected = toolClick(r.state, { x: 6, y: 8 }, TOL, newId) // same ray: rejected
    expect(rejected.commit).toBeNull()
    const end = toolClick(rejected.state, { x: -4, y: -3 }, TOL, newId) // now a real end click
    expect(end.commit).not.toBeNull()
    const arc = end.commit!.entities[0] as SketchEllipticalArcEntity
    const { loops, excludedEntities } = bakeSketch(sketchOf([arc]), { newId: idFactory() })
    expect(loops.length).toBe(1)
    expect(excludedEntities).toBe(0)
  })
})
