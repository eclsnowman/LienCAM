// Elliptical-arc draw tool (Tier 2b): 5-click flow + preview==commit + bake.
// Headless, pure-geometry. The 'elliptical-arc' ENTITY (and its bake +
// solver-inert mapping) shipped earlier; this exercises only the new DRAW
// TOOL and its wiring through the tool machine.

import { describe, it, expect } from 'vitest'
import {
  toolClick, toolPreview, type ToolState,
} from '../../lib/sketch/tools/toolMachine'
import { ellipticalArcFromClicks } from '../../lib/sketch/tools/ellipseTools'
import { ellipseParamFromPoint } from '../../lib/sketch/ellipse'
import { bakeSketch } from '../../lib/sketch/bake'
import type {
  Sketch, SketchEntity, SketchEllipticalArcEntity,
} from '../../lib/sketch/types'

const TOL = 0.5

function idFactory(): () => string {
  let n = 0
  return () => `id${n++}`
}
function armed(tool: ToolState['tool']): ToolState {
  return { tool, chain: null }
}
const close = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps

// Walk the full 5-click sequence, returning the final ToolClickResult.
function fiveClicks(
  newId: () => string,
  c: { x: number; y: number }, m: { x: number; y: number },
  mn: { x: number; y: number }, s: { x: number; y: number },
  e: { x: number; y: number },
) {
  let r = toolClick(armed('ellipse-arc'), c, TOL, newId)
  r = toolClick(r.state, m, TOL, newId)
  r = toolClick(r.state, mn, TOL, newId)
  r = toolClick(r.state, s, TOL, newId)
  return toolClick(r.state, e, TOL, newId)
}

describe('elliptical-arc tool (5-click flow)', () => {
  it('click 1 anchors the center; no commit', () => {
    const r = toolClick(armed('ellipse-arc'), { x: 2, y: 3 }, TOL, idFactory())
    expect(r.commit).toBeNull()
    expect(r.state.chain).toEqual({
      kind: 'ellipse-arc', center: { x: 2, y: 3 }, major: null, minor: null, start: null,
    })
  })

  it('clicks 2-4 advance the chain without committing', () => {
    const newId = idFactory()
    let r = toolClick(armed('ellipse-arc'), { x: 0, y: 0 }, TOL, newId)
    r = toolClick(r.state, { x: 10, y: 0 }, TOL, newId) // major
    expect(r.commit).toBeNull()
    expect((r.state.chain as { major: unknown }).major).toEqual({ x: 10, y: 0 })
    r = toolClick(r.state, { x: 0, y: 5 }, TOL, newId) // minor
    expect(r.commit).toBeNull()
    expect((r.state.chain as { minor: unknown }).minor).toEqual({ x: 0, y: 5 })
    r = toolClick(r.state, { x: 10, y: 0 }, TOL, newId) // start
    expect(r.commit).toBeNull()
    expect((r.state.chain as { start: unknown }).start).toEqual({ x: 10, y: 0 })
  })

  it('click 5 commits a quarter-sweep elliptical arc (axis-aligned 2:1)', () => {
    const newId = idFactory()
    const r = fiveClicks(
      newId,
      { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 5 },
      { x: 10, y: 0 }, { x: 0, y: 5 },
    )
    const a = r.commit!.entities[0] as SketchEllipticalArcEntity
    expect(a.kind).toBe('elliptical-arc')
    expect(close(a.majorRadius, 10)).toBe(true)
    expect(close(a.minorRadius, 5)).toBe(true)
    expect(close(a.rotation, 0)).toBe(true)
    expect(close(a.startParam, 0)).toBe(true)
    expect(close(a.endParam, Math.PI / 2)).toBe(true)
    expect(r.commit!.constraints).toEqual([])
    expect(r.state.chain).toBeNull() // tool stays armed for the next arc
  })

  it('builder maps start/end CLICKS to eccentric params (axis-aligned)', () => {
    const shape = ellipticalArcFromClicks(
      { x: 0, y: 0 }, { x: 8, y: 0 }, { x: 0, y: 4 },
      { x: 0, y: 4 }, { x: -8, y: 0 },
    )
    expect(close(shape.majorRadius, 8)).toBe(true)
    expect(close(shape.minorRadius, 4)).toBe(true)
    expect(close(shape.startParam, Math.PI / 2)).toBe(true) // +minor vertex
    expect(close(shape.endParam, Math.PI)).toBe(true)        // -major vertex
  })

  it('rotation comes from the major-axis direction; params follow the frame', () => {
    // Major along +Y (rotation = +pi/2), 2:1 ellipse.
    const shape = ellipticalArcFromClicks(
      { x: 0, y: 0 }, { x: 0, y: 6 }, { x: 3, y: 0 },
      { x: 0, y: 6 }, { x: -3, y: 0 },
    )
    expect(close(shape.majorRadius, 6)).toBe(true)
    expect(close(shape.minorRadius, 3)).toBe(true)
    expect(close(shape.rotation, Math.PI / 2)).toBe(true)
    // In the rotated frame: (0,6) is the +major vertex (t=0); the +minor
    // co-vertex (t=pi/2) sits at (-3,0), so (3,0) would be t=3pi/2.
    expect(close(shape.startParam, 0)).toBe(true)
    expect(close(shape.endParam, Math.PI / 2)).toBe(true)
  })

  it('param pick is by DIRECTION: a point off the curve still maps right', () => {
    const e = { center: { x: 0, y: 0 }, majorRadius: 10, minorRadius: 5, rotation: 0 }
    // (20, 0) is far off the curve but on the +major direction -> t = 0.
    expect(close(ellipseParamFromPoint(e, { x: 20, y: 0 }), 0)).toBe(true)
    // (0, 0.3) is on the +minor direction -> t = pi/2.
    expect(close(ellipseParamFromPoint(e, { x: 0, y: 0.3 }), Math.PI / 2)).toBe(true)
    // (-2, 0) -> -major direction -> t = pi.
    expect(close(ellipseParamFromPoint(e, { x: -2, y: 0 }), Math.PI)).toBe(true)
  })

  it('preview equals the committed arc (same end point)', () => {
    const newId = idFactory()
    let r = toolClick(armed('ellipse-arc'), { x: 0, y: 0 }, TOL, newId)
    r = toolClick(r.state, { x: 10, y: 0 }, TOL, newId) // major
    r = toolClick(r.state, { x: 0, y: 5 }, TOL, newId)  // minor
    r = toolClick(r.state, { x: 10, y: 0 }, TOL, newId) // start (param 0)
    const endPt = { x: 0, y: 5 }
    const preview = toolPreview(r.state, endPt)!
    const a = toolClick(r.state, endPt, TOL, newId).commit!
      .entities[0] as SketchEllipticalArcEntity
    // Preview is the open arc polyline: it must start at the start point and
    // end at the +minor vertex (the committed arc's two endpoints).
    const first = preview[0]
    const last = preview[preview.length - 1]
    expect(close(first.x, 10, 1e-3) && close(first.y, 0, 1e-3)).toBe(true)
    expect(close(last.x, 0, 1e-3) && close(last.y, 5, 1e-3)).toBe(true)
    expect(close(a.endParam, Math.PI / 2)).toBe(true)
    // Open polyline (first != last): an arc, not a closed ellipse.
    expect(close(first.x, last.x) && close(first.y, last.y)).toBe(false)
  })

  it('zero-length major (click 2 on center) is ignored', () => {
    const newId = idFactory()
    let r = toolClick(armed('ellipse-arc'), { x: 0, y: 0 }, TOL, newId)
    r = toolClick(r.state, { x: 0.1, y: 0 }, TOL, newId) // within TOL of center
    expect((r.state.chain as { major: unknown }).major).toBeNull()
  })

  it('zero minor radius (click 3 on the major axis) is ignored', () => {
    const newId = idFactory()
    let r = toolClick(armed('ellipse-arc'), { x: 0, y: 0 }, TOL, newId)
    r = toolClick(r.state, { x: 10, y: 0 }, TOL, newId) // major
    r = toolClick(r.state, { x: 4, y: 0.1 }, TOL, newId) // ~on the major axis
    expect((r.state.chain as { minor: unknown }).minor).toBeNull()
  })

  it('coincident start/end click is rejected fail-loud (no commit)', () => {
    const newId = idFactory()
    let r = toolClick(armed('ellipse-arc'), { x: 0, y: 0 }, TOL, newId)
    r = toolClick(r.state, { x: 10, y: 0 }, TOL, newId) // major
    r = toolClick(r.state, { x: 0, y: 5 }, TOL, newId)  // minor
    r = toolClick(r.state, { x: 10, y: 0 }, TOL, newId) // start
    r = toolClick(r.state, { x: 10.1, y: 0 }, TOL, newId) // end ~ start
    expect(r.commit).toBeNull()
    expect((r.state.chain as { start: unknown }).start).toEqual({ x: 10, y: 0 })
  })
})

describe('elliptical-arc tool -> bake (OPEN Loop2D)', () => {
  const layerId = 'L'
  function sketchOf(entities: SketchEntity[]): Sketch {
    return {
      id: 'sk', layerId, entities, constraints: [], dimensions: [],
      solveStatus: { dof: 0, conflicting: [], redundant: [] },
    }
  }

  it('a drawn elliptical arc bakes to an OPEN polyline loop', () => {
    const newId = idFactory()
    const commit = fiveClicks(
      newId,
      { x: 0, y: 0 }, { x: 8, y: 0 }, { x: 0, y: 4 },
      { x: 8, y: 0 }, { x: 0, y: 4 },
    ).commit!
    const arc = commit.entities[0] as SketchEllipticalArcEntity
    const { loops } = bakeSketch(sketchOf([arc]), { newId: idFactory() })
    expect(loops.length).toBe(1)
    expect(loops[0].closed).toBe(false)
    expect(loops[0].type).toBe('open')
    expect(loops[0].segments!.every((s) => s.type === 'line')).toBe(true)
    expect(loops[0].points.length).toBeGreaterThan(2)
  })

  it('a construction elliptical arc never bakes', () => {
    const arc: SketchEllipticalArcEntity = {
      id: 'a1', kind: 'elliptical-arc', construction: true,
      center: { x: 0, y: 0 }, majorRadius: 8, minorRadius: 4, rotation: 0,
      startParam: 0, endParam: Math.PI / 2,
    }
    const { loops, excludedEntities } = bakeSketch(sketchOf([arc]), { newId: idFactory() })
    expect(loops.length).toBe(0)
    expect(excludedEntities).toBe(1)
  })
})
