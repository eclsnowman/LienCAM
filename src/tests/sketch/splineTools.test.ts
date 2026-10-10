// Spline draw tool + bake + solver-inert mapping (basic spline, C4). Headless.

import { describe, it, expect } from 'vitest'
import {
  toolClick, toolPreview, type ToolState,
} from '../../lib/sketch/tools/toolMachine'
import {
  splineClick, splineFinish, splinePreview, splineWouldCloseOnStart,
  SPLINE_MIN_POINTS, type SplineChainState,
} from '../../lib/sketch/tools/splineTools'
import { bakeSketch } from '../../lib/sketch/bake'
import {
  sketchToGcsPrimitives, entitiesFromSolved,
} from '../../lib/sketch/solver/gcsMapping'
import type { Sketch, SketchEntity, SketchSplineEntity } from '../../lib/sketch/types'

const TOL = 0.5

function idFactory(): () => string {
  let n = 0
  return () => `id${n++}`
}
function armed(tool: ToolState['tool']): ToolState {
  return { tool, chain: null }
}
const close = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps

describe('spline tool (multi-click accumulation)', () => {
  it('click 1 anchors the chain with one point; no commit', () => {
    const r = splineClick(null, { x: 2, y: 3 }, TOL)
    expect(r.commit).toBeNull()
    expect(r.chain).toEqual({ kind: 'spline', points: [{ x: 2, y: 3 }] })
  })

  it('subsequent clicks append through-points (never commit on click)', () => {
    let r = splineClick(null, { x: 0, y: 0 }, TOL)
    r = splineClick(r.chain, { x: 10, y: 5 }, TOL)
    r = splineClick(r.chain, { x: 20, y: -3 }, TOL)
    expect(r.commit).toBeNull()
    expect(r.chain!.points).toEqual([{ x: 0, y: 0 }, { x: 10, y: 5 }, { x: 20, y: -3 }])
  })

  it('a click within tol of the last point is ignored (zero-length / dblclick guard)', () => {
    let r = splineClick(null, { x: 0, y: 0 }, TOL)
    r = splineClick(r.chain, { x: 10, y: 0 }, TOL)
    const before = r.chain
    r = splineClick(r.chain, { x: 10.1, y: 0 }, TOL) // within TOL of last
    expect(r.chain).toBe(before) // unchanged reference
    expect(r.chain!.points.length).toBe(2)
  })

  it('routes through the tool machine: accumulation, no commit', () => {
    let r = toolClick(armed('spline'), { x: 0, y: 0 }, TOL, idFactory())
    expect(r.commit).toBeNull()
    r = toolClick(r.state, { x: 10, y: 4 }, TOL, idFactory())
    expect(r.commit).toBeNull()
    expect((r.state.chain as SplineChainState).points.length).toBe(2)
  })
})

describe('spline close-on-start (click the anchor to close)', () => {
  it('>= 3 points + a click within tol of points[0] FINISHES a CLOSED spline', () => {
    let r = splineClick(null, { x: 0, y: 0 }, TOL, false, idFactory())
    r = splineClick(r.chain, { x: 10, y: 0 }, TOL, false, idFactory())
    r = splineClick(r.chain, { x: 10, y: 10 }, TOL, false, idFactory())
    expect(r.chain!.points.length).toBe(3)
    // Click back on the start point (within TOL).
    r = splineClick(r.chain, { x: 0.2, y: -0.1 }, TOL, false, idFactory())
    expect(r.chain).toBeNull() // chain cleared on close
    expect(r.commit).not.toBeNull()
    const e = r.commit!.entities[0] as SketchSplineEntity
    expect(e.kind).toBe('spline')
    expect(e.closed).toBe(true)
    expect(e.points).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }])
  })

  it('close-on-start forces CLOSED even though the finish path default is OPEN', () => {
    const chain: SplineChainState = {
      kind: 'spline', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }],
    }
    const r = splineClick(chain, { x: 0, y: 0 }, TOL, false, idFactory())
    expect((r.commit!.entities[0] as SketchSplineEntity).closed).toBe(true)
  })

  it('a click elsewhere (not near start) just appends -> open chain continues', () => {
    const chain: SplineChainState = {
      kind: 'spline', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }],
    }
    const r = splineClick(chain, { x: 20, y: 20 }, TOL, false, idFactory())
    expect(r.commit).toBeNull()
    expect(r.chain!.points.length).toBe(4)
  })

  it('fewer than 3 points near the start does NOT close (still just appends)', () => {
    const chain: SplineChainState = { kind: 'spline', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] }
    const r = splineClick(chain, { x: 0.1, y: 0 }, TOL, false, idFactory())
    expect(r.commit).toBeNull()
    expect(r.chain!.points.length).toBe(3) // appended near start, not closed
  })

  it('without an id factory (legacy 3-arg call) the start-click just appends (byte-identical open path)', () => {
    const chain: SplineChainState = {
      kind: 'spline', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }],
    }
    const r = splineClick(chain, { x: 0, y: 0 }, TOL) // no construction/newId
    expect(r.commit).toBeNull()
    expect(r.chain!.points.length).toBe(4)
  })

  it('routes through the tool machine: close-on-start commits a CLOSED spline', () => {
    let r = toolClick(armed('spline'), { x: 0, y: 0 }, TOL, idFactory())
    r = toolClick(r.state, { x: 10, y: 0 }, TOL, idFactory())
    r = toolClick(r.state, { x: 10, y: 10 }, TOL, idFactory())
    expect(r.commit).toBeNull()
    r = toolClick(r.state, { x: 0, y: 0 }, TOL, idFactory()) // click the start
    expect(r.commit).not.toBeNull()
    expect((r.commit!.entities[0] as SketchSplineEntity).closed).toBe(true)
    expect(r.state.chain).toBeNull()
  })

  it('splineWouldCloseOnStart predicate: true only with >= 3 points near the start', () => {
    const c3: SplineChainState = {
      kind: 'spline', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }],
    }
    expect(splineWouldCloseOnStart(c3, { x: 0.2, y: 0 }, TOL)).toBe(true)
    expect(splineWouldCloseOnStart(c3, { x: 5, y: 5 }, TOL)).toBe(false)
    const c2: SplineChainState = { kind: 'spline', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] }
    expect(splineWouldCloseOnStart(c2, { x: 0, y: 0 }, TOL)).toBe(false)
    // closeTol <= 0 disables the hint entirely.
    expect(splineWouldCloseOnStart(c3, { x: 0, y: 0 }, 0)).toBe(false)
  })
})

describe('spline finish (Enter / double-click)', () => {
  it('fewer than the minimum points -> no commit (chain discarded)', () => {
    expect(SPLINE_MIN_POINTS).toBe(2)
    const chain: SplineChainState = { kind: 'spline', points: [{ x: 1, y: 1 }] }
    expect(splineFinish(chain, false, idFactory())).toBeNull()
  })

  it('>= 2 points commits ONE open spline carrying the points verbatim', () => {
    const pts = [{ x: 0, y: 0 }, { x: 10, y: 5 }, { x: 20, y: -3 }]
    const chain: SplineChainState = { kind: 'spline', points: pts }
    const commit = splineFinish(chain, false, idFactory())!
    expect(commit.constraints).toEqual([])
    const e = commit.entities[0] as SketchSplineEntity
    expect(e.kind).toBe('spline')
    expect(e.closed).toBe(false)
    expect(e.points).toEqual(pts)
    expect(e.construction).toBe(false)
  })

  it('construction flag is carried onto the committed entity', () => {
    const chain: SplineChainState = { kind: 'spline', points: [{ x: 0, y: 0 }, { x: 5, y: 5 }] }
    const e = splineFinish(chain, true, idFactory())!.entities[0] as SketchSplineEntity
    expect(e.construction).toBe(true)
  })

  it('defaults to OPEN (closed=false) when the flag is omitted', () => {
    const chain: SplineChainState = { kind: 'spline', points: [{ x: 0, y: 0 }, { x: 5, y: 5 }] }
    const e = splineFinish(chain, false, idFactory())!.entities[0] as SketchSplineEntity
    expect(e.closed).toBe(false)
  })

  it('commits closed=true when the "Close loop" flag is set', () => {
    const chain: SplineChainState = {
      kind: 'spline', points: [{ x: 0, y: 0 }, { x: 5, y: 5 }, { x: 10, y: 0 }],
    }
    const e = splineFinish(chain, false, idFactory(), true)!.entities[0] as SketchSplineEntity
    expect(e.closed).toBe(true)
  })
})

describe('spline preview', () => {
  it('null with a single placed point + no extent yet is avoided (rubber-band line)', () => {
    const chain: SplineChainState = { kind: 'spline', points: [{ x: 0, y: 0 }] }
    const preview = splinePreview(chain, { x: 10, y: 0 })!
    // One placed point + cursor = a straight 2-point Catmull-Rom segment.
    expect(preview.length).toBeGreaterThanOrEqual(2)
    expect(close(preview[0].x, 0) && close(preview[0].y, 0)).toBe(true)
  })

  it('previews the EXACT curve through the placed points + the live cursor', () => {
    const chain: SplineChainState = { kind: 'spline', points: [{ x: 0, y: 0 }, { x: 10, y: 6 }] }
    const cursor = { x: 20, y: 0 }
    const preview = splinePreview(chain, cursor)!
    // The curve passes through every placed point and the cursor.
    const passesThrough = (p: { x: number; y: number }) =>
      preview.some((q) => close(q.x, p.x, 1e-6) && close(q.y, p.y, 1e-6))
    expect(passesThrough({ x: 0, y: 0 })).toBe(true)
    expect(passesThrough({ x: 10, y: 6 })).toBe(true)
    expect(passesThrough(cursor)).toBe(true)
  })

  it('toolPreview dispatches to the spline preview', () => {
    const state: ToolState = {
      tool: 'spline',
      chain: { kind: 'spline', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] },
    }
    const preview = toolPreview(state, { x: 20, y: 4 })
    expect(preview).not.toBeNull()
    expect(preview!.length).toBeGreaterThan(2)
  })

  it('the closed preview wraps back to points[0] (last == first); open ends at the cursor', () => {
    const chain: SplineChainState = {
      kind: 'spline', points: [{ x: 0, y: 0 }, { x: 10, y: 6 }, { x: 20, y: -2 }],
    }
    const cursor = { x: 30, y: 4 }
    const open = splinePreview(chain, cursor, false)!
    const openLast = open[open.length - 1]
    expect(close(openLast.x, cursor.x) && close(openLast.y, cursor.y)).toBe(true)

    const closedPrev = splinePreview(chain, cursor, true)!
    const first = closedPrev[0]
    const last = closedPrev[closedPrev.length - 1]
    expect(close(last.x, first.x) && close(last.y, first.y)).toBe(true)
  })

  it('close-on-start feedback: hovering the start (>= 3 pts, closeTol > 0) snaps the preview CLOSED', () => {
    const chain: SplineChainState = {
      kind: 'spline', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }],
    }
    // Cursor on the start point, open toggle, but a positive closeTol.
    const preview = splinePreview(chain, { x: 0.2, y: -0.1 }, false, TOL)!
    const first = preview[0]
    const last = preview[preview.length - 1]
    // Closed loop: last == first, and the provisional cursor point is NOT added.
    expect(close(last.x, first.x) && close(last.y, first.y)).toBe(true)
  })

  it('no close feedback when closeTol is 0 (default): the preview ends at the cursor', () => {
    const chain: SplineChainState = {
      kind: 'spline', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }],
    }
    const cursor = { x: 0.2, y: -0.1 }
    const preview = splinePreview(chain, cursor, false)! // closeTol defaults to 0
    const last = preview[preview.length - 1]
    expect(close(last.x, cursor.x) && close(last.y, cursor.y)).toBe(true)
  })

  it('toolPreview threads ctx.splineClosed to the closed preview', () => {
    const state: ToolState = {
      tool: 'spline',
      chain: { kind: 'spline', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }] },
    }
    const preview = toolPreview(state, { x: 0, y: 10 }, { splineClosed: true })!
    const first = preview[0]
    const last = preview[preview.length - 1]
    expect(close(last.x, first.x) && close(last.y, first.y)).toBe(true)
  })
})

describe('spline bake -> Loop2D', () => {
  const layerId = 'L'
  function sketchOf(entities: SketchEntity[]): Sketch {
    return {
      id: 'sk', layerId, entities, constraints: [], dimensions: [],
      solveStatus: { dof: 0, conflicting: [], redundant: [] },
    }
  }

  it('an open spline bakes to ONE open polyline loop through the points', () => {
    const e: SketchSplineEntity = {
      id: 's1', kind: 'spline', construction: false,
      points: [{ x: 0, y: 0 }, { x: 10, y: 8 }, { x: 20, y: -4 }, { x: 30, y: 0 }],
      closed: false,
    }
    const { loops, bakedEntities } = bakeSketch(sketchOf([e]), { newId: idFactory() })
    expect(bakedEntities).toBe(1)
    expect(loops.length).toBe(1)
    const loop = loops[0]
    expect(loop.closed).toBe(false)
    expect(loop.type).toBe('open')
    expect(loop.segments!.every((s) => s.type === 'line')).toBe(true)
    // Endpoints are the spline's first/last through-points (point ON the curve).
    expect(close(loop.points[0].x, 0) && close(loop.points[0].y, 0)).toBe(true)
    const last = loop.points[loop.points.length - 1]
    expect(close(last.x, 30) && close(last.y, 0)).toBe(true)
  })

  it('a closed spline bakes to a closed contour loop (no duplicate first point)', () => {
    const e: SketchSplineEntity = {
      id: 's2', kind: 'spline', construction: false,
      points: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 }],
      closed: true,
    }
    const { loops } = bakeSketch(sketchOf([e]), { newId: idFactory() })
    expect(loops.length).toBe(1)
    expect(loops[0].closed).toBe(true)
    expect(loops[0].type).toBe('contour')
    const first = loops[0].points[0]
    const last = loops[0].points[loops[0].points.length - 1]
    expect(close(first.x, last.x) && close(first.y, last.y)).toBe(false)
  })

  it('construction splines never bake', () => {
    const e: SketchSplineEntity = {
      id: 's3', kind: 'spline', construction: true,
      points: [{ x: 0, y: 0 }, { x: 10, y: 0 }], closed: false,
    }
    const { loops, excludedEntities } = bakeSketch(sketchOf([e]), { newId: idFactory() })
    expect(loops.length).toBe(0)
    expect(excludedEntities).toBe(1)
  })
})

describe('spline solver mapping (SOLVER-INERT)', () => {
  const spline: SketchSplineEntity = {
    id: 's1', kind: 'spline', construction: false,
    points: [{ x: 1, y: 2 }, { x: 11, y: 7 }, { x: 21, y: 1 }], closed: false,
  }
  const sketch: Sketch = {
    id: 'sk', layerId: 'L', entities: [spline], constraints: [], dimensions: [],
    solveStatus: null,
  }

  it('pushes only the anchor (first point) as a gcs point, NO spline primitive', () => {
    const prims = sketchToGcsPrimitives(sketch)
    const anchor = prims.find((p) => p.id === 's1:start')
    expect(anchor?.type).toBe('point')
    expect(anchor).toMatchObject({ x: 1, y: 2 })
    expect(prims.some((p) => p.id === 's1')).toBe(false) // no shape primitive
  })

  it('rebuild translates the WHOLE point list rigidly to follow the moved anchor', () => {
    // Fake a solve that moved the anchor from (1,2) to (4,9): delta (+3,+7).
    const lookup = (id: string) =>
      id === 's1:start'
        ? ({ id, type: 'point', x: 4, y: 9, fixed: false } as never)
        : undefined
    const [out] = entitiesFromSolved(sketch, lookup) as [SketchSplineEntity]
    expect(out.points).toEqual([{ x: 4, y: 9 }, { x: 14, y: 14 }, { x: 24, y: 8 }])
    expect(out.closed).toBe(false)
  })
})
