// Rectangle tools (corner + center) — headless commit coverage.
//
// Each tool is two clicks; the commit must contain four lines chained by
// coincident corner constraints plus horizontal (top/bottom) and vertical
// (sides) auto-constraints — REAL document constraints, standard editor style.

import { describe, it, expect } from 'vitest'
import {
  toolClick,
  toolPreview,
  escapeTool,
  toggleRectRotated,
  type ToolState,
} from '../../lib/sketch/tools/toolMachine'
import type { SketchEntity, SketchLineEntity, SketchPointEntity } from '../../lib/sketch/types'

const TOL = 0.5

function idFactory(): () => string {
  let n = 0
  return () => `id${n++}`
}

function armed(tool: ToolState['tool']): ToolState {
  return { tool, chain: null }
}

/** Run the two clicks and return the final result. When `forceSquare` is set
 *  the committing (second) click carries the Shift-square flag via ctx, exactly
 *  as the store passes it (ortho-lock made the drag a visual square). */
function drawRect(
  tool: 'rect-corner' | 'rect-center',
  c1: { x: number; y: number },
  c2: { x: number; y: number },
  forceSquare = false,
) {
  const newId = idFactory()
  const r1 = toolClick(armed(tool), c1, TOL, newId)
  const ctx = { entities: [], forceSquare }
  return { first: r1, second: toolClick(r1.state, c2, TOL, newId, ctx) }
}

/** The CUT line sides of a rectangle commit (C2 appends a construction
 *  center point that must not pollute the four-side assertions). */
function lineEntities(commit: { entities: SketchEntity[] }): SketchLineEntity[] {
  return commit.entities.filter(
    (e): e is SketchLineEntity => e.kind === 'line' && !e.construction,
  )
}

describe('corner rectangle', () => {
  it('first click anchors; no commit', () => {
    const { first } = drawRect('rect-corner', { x: 1, y: 2 }, { x: 9, y: 8 })
    expect(first.commit).toBeNull()
    expect(first.state.chain).toEqual({ kind: 'rect', mode: 'corner', anchor: { x: 1, y: 2 } })
  })

  it('second click commits 4 lines closing the loop', () => {
    const { second } = drawRect('rect-corner', { x: 1, y: 2 }, { x: 9, y: 8 })
    const lines = lineEntities(second.commit!)
    expect(lines).toHaveLength(4)
    expect(lines.every((l) => l.kind === 'line' && !l.construction)).toBe(true)
    // Winding a -> (b.x,a.y) -> b -> (a.x,b.y) -> a.
    expect(lines[0]).toMatchObject({ start: { x: 1, y: 2 }, end: { x: 9, y: 2 } })
    expect(lines[1]).toMatchObject({ start: { x: 9, y: 2 }, end: { x: 9, y: 8 } })
    expect(lines[2]).toMatchObject({ start: { x: 9, y: 8 }, end: { x: 1, y: 8 } })
    expect(lines[3]).toMatchObject({ start: { x: 1, y: 8 }, end: { x: 1, y: 2 } })
    // Tool stays armed for the next rectangle; chain ended.
    expect(second.state).toEqual({ tool: 'rect-corner', chain: null })
  })

  it('auto-constraints: 4 coincident corners + 2 horizontal + 2 vertical', () => {
    const { second } = drawRect('rect-corner', { x: 0, y: 0 }, { x: 10, y: 5 })
    const lines = lineEntities(second.commit!)
    const cs = second.commit!.constraints
    // 4 corner coincidents + 2 horizontal + 2 vertical + D1 tie
    // (2 diagonal-endpoint coincidents + 1 midpoint) = 11.
    expect(cs).toHaveLength(11)

    // The four CORNER coincidents are the first four (D1 diagonal coincidents
    // are appended after the cut sides). end of line i meets start of (i+1)%4.
    const cornerCoincident = cs.slice(0, 4)
    expect(cornerCoincident.every((c) => c.kind === 'coincident')).toBe(true)
    cornerCoincident.forEach((c, i) => {
      expect(c).toMatchObject({
        a: { entityId: lines[i].id, site: 'end' },
        b: { entityId: lines[(i + 1) % 4].id, site: 'start' },
      })
    })

    const horizontal = cs.filter((c) => c.kind === 'horizontal')
    const vertical = cs.filter((c) => c.kind === 'vertical')
    expect(horizontal.map((c) => (c as { line?: string }).line)).toEqual([lines[0].id, lines[2].id])
    expect(vertical.map((c) => (c as { line?: string }).line)).toEqual([lines[1].id, lines[3].id])
  })

  it('normal (non-Shift) rectangle emits NO equal constraint (unchanged)', () => {
    const { second } = drawRect('rect-corner', { x: 0, y: 0 }, { x: 10, y: 5 })
    expect(second.commit!.constraints.filter((c) => c.kind === 'equal')).toHaveLength(0)
    // Byte-for-byte the pre-feature shape: 11 constraints, no equal.
    expect(second.commit!.constraints).toHaveLength(11)
  })

  it('V6 square (Shift/forceSquare): emits ONE equal tying a H leg to a V leg', () => {
    const { second } = drawRect('rect-corner', { x: 0, y: 0 }, { x: 10, y: 10 }, true)
    const lines = lineEntities(second.commit!)
    const equals = second.commit!.constraints.filter(
      (c): c is { kind: 'equal'; a: string; b: string; id: string } => c.kind === 'equal',
    )
    expect(equals).toHaveLength(1)
    // ids[0] (a horizontal leg) equated to ids[1] (a vertical leg) => square.
    expect(equals[0].a).toBe(lines[0].id)
    expect(equals[0].b).toBe(lines[1].id)
    // The equal rides ALONGSIDE the normal 11 constraints (12 total).
    expect(second.commit!.constraints).toHaveLength(12)
  })

  it('works dragging up-left (any quadrant)', () => {
    const { second } = drawRect('rect-corner', { x: 9, y: 8 }, { x: 1, y: 2 })
    const lines = lineEntities(second.commit!)
    expect(lines[0]).toMatchObject({ start: { x: 9, y: 8 }, end: { x: 1, y: 8 } })
    expect(lines[2]).toMatchObject({ start: { x: 1, y: 2 }, end: { x: 9, y: 2 } })
  })

  it('ignores a degenerate second click (zero width or height)', () => {
    const newId = idFactory()
    const r1 = toolClick(armed('rect-corner'), { x: 0, y: 0 }, TOL, newId)
    const flat = toolClick(r1.state, { x: 10, y: 0.2 }, TOL, newId) // height < tol
    expect(flat.commit).toBeNull()
    expect(flat.state).toEqual(r1.state)
    const thin = toolClick(r1.state, { x: 0.2, y: 10 }, TOL, newId) // width < tol
    expect(thin.commit).toBeNull()
  })

  it('Esc cancels the in-progress rectangle; tool stays armed', () => {
    const r1 = toolClick(armed('rect-corner'), { x: 0, y: 0 }, TOL, idFactory())
    const esc = escapeTool(r1.state)
    expect(esc.consumed).toBe(true)
    expect(esc.state).toEqual({ tool: 'rect-corner', chain: null })
  })

  it('preview outline matches the rectangle the next click commits', () => {
    const newId = idFactory()
    const r1 = toolClick(armed('rect-corner'), { x: 1, y: 2 }, TOL, newId)
    const preview = toolPreview(r1.state, { x: 9, y: 8 })!
    expect(preview).toEqual([
      { x: 1, y: 2 }, { x: 9, y: 2 }, { x: 9, y: 8 }, { x: 1, y: 8 }, { x: 1, y: 2 },
    ])
    const lines = lineEntities(toolClick(r1.state, { x: 9, y: 8 }, TOL, newId).commit!)
    lines.forEach((l, i) => {
      expect(l.start).toEqual(preview[i])
      expect(l.end).toEqual(preview[i + 1])
    })
  })

  it('C2/D1: keeps a forced-construction center point at the rectangle center', () => {
    const { second } = drawRect('rect-corner', { x: 0, y: 0 }, { x: 10, y: 6 })
    const points = second.commit!.entities.filter(
      (e): e is SketchPointEntity => e.kind === 'point',
    )
    expect(points).toHaveLength(1)
    expect(points[0].construction).toBe(true) // forced even for a SOLID rect
    expect(points[0].at).toEqual({ x: 5, y: 3 })
    // The four cut sides are still exactly four and non-construction; the D1
    // diagonal is a fifth, CONSTRUCTION line (excluded from lineEntities).
    expect(lineEntities(second.commit!)).toHaveLength(4)
    const constructionLines = second.commit!.entities.filter(
      (e) => e.kind === 'line' && e.construction,
    )
    expect(constructionLines).toHaveLength(1) // the D1 tie diagonal
    // D1: the tie adds 2 diagonal-endpoint coincidents + 1 midpoint on top of
    // the 8 cut auto-constraints = 11.
    expect(second.commit!.constraints).toHaveLength(11)
  })

  it('C2: center-rectangle center marker lands on the clicked center', () => {
    const { second } = drawRect('rect-center', { x: 5, y: 5 }, { x: 8, y: 7 })
    const points = second.commit!.entities.filter((e) => e.kind === 'point')
    expect(points).toHaveLength(1)
    expect((points[0] as SketchPointEntity).at).toEqual({ x: 5, y: 5 })
  })
})

describe('center rectangle', () => {
  it('center + corner commit the same entity/constraint shape, mirrored about the center', () => {
    const { second } = drawRect('rect-center', { x: 5, y: 5 }, { x: 8, y: 7 })
    const lines = lineEntities(second.commit!)
    expect(lines).toHaveLength(4)
    // Opposite corner mirrored through the center: (2*5-8, 2*5-7) = (2, 3).
    expect(lines[0]).toMatchObject({ start: { x: 2, y: 3 }, end: { x: 8, y: 3 } })
    expect(lines[1]).toMatchObject({ start: { x: 8, y: 3 }, end: { x: 8, y: 7 } })
    expect(lines[2]).toMatchObject({ start: { x: 8, y: 7 }, end: { x: 2, y: 7 } })
    expect(lines[3]).toMatchObject({ start: { x: 2, y: 7 }, end: { x: 2, y: 3 } })
    const kinds = second.commit!.constraints.map((c) => c.kind)
    // 4 corner + 2 D1 diagonal-endpoint coincidents = 6.
    expect(kinds.filter((k) => k === 'coincident')).toHaveLength(6)
    expect(kinds.filter((k) => k === 'horizontal')).toHaveLength(2)
    expect(kinds.filter((k) => k === 'vertical')).toHaveLength(2)
    expect(kinds.filter((k) => k === 'midpoint')).toHaveLength(1) // D1 center tie
    expect(second.state).toEqual({ tool: 'rect-center', chain: null })
  })

  it('V6 square (Shift/forceSquare) also applies to the CENTER rectangle', () => {
    // center rect shares buildRectCommit, so the equal-leg lock must appear.
    const { second } = drawRect('rect-center', { x: 5, y: 5 }, { x: 8, y: 8 }, true)
    const lines = lineEntities(second.commit!)
    const equals = second.commit!.constraints.filter((c) => c.kind === 'equal')
    expect(equals).toHaveLength(1)
    expect(equals[0]).toMatchObject({ a: lines[0].id, b: lines[1].id })
    // A non-Shift center rect stays free (no equal).
    const plain = drawRect('rect-center', { x: 5, y: 5 }, { x: 8, y: 8 }, false)
    expect(plain.second.commit!.constraints.filter((c) => c.kind === 'equal')).toHaveLength(0)
  })

  it('clicking the corner ON the center is degenerate and ignored', () => {
    const newId = idFactory()
    const r1 = toolClick(armed('rect-center'), { x: 5, y: 5 }, TOL, newId)
    const r2 = toolClick(r1.state, { x: 5.1, y: 5.1 }, TOL, newId)
    expect(r2.commit).toBeNull()
  })
})

describe('rotated (angled) rectangle — item G', () => {
  // p1 -> p2 = (3,4): edge length 5 at a non-axis angle. Width point (-4,3)
  // gives a signed perpendicular distance w = 5, so the corners are:
  //   c0 (0,0)  c1 (3,4)  c2 (-1,7)  c3 (-4,3).
  const P1 = { x: 0, y: 0 }
  const P2 = { x: 3, y: 4 }
  const WIDTH = { x: -4, y: 3 }

  /** Toggle rotated, then run the 3 clicks; return the committing result. */
  function drawRotated(tool: 'rect-corner' | 'rect-center') {
    const newId = idFactory()
    const s0 = toggleRectRotated(armed(tool))
    const r1 = toolClick(s0, P1, TOL, newId)
    const r2 = toolClick(r1.state, P2, TOL, newId)
    return { s0, r1, r2, third: toolClick(r2.state, WIDTH, TOL, newId) }
  }

  it('toggleRectRotated flips the rotated flag (and back)', () => {
    const on = toggleRectRotated(armed('rect-corner'))
    expect(on.chain).toMatchObject({ kind: 'rect', mode: 'corner', rotated: true })
    // Toggling off before any click drops back to plain armed (no chain).
    const off = toggleRectRotated(on)
    expect(off).toEqual({ tool: 'rect-corner', chain: null })
    // No-op for a non-rect tool.
    expect(toggleRectRotated(armed('circle-center'))).toEqual(armed('circle-center'))
  })

  it('is a 3-click flow: clicks 1 and 2 do not commit', () => {
    const { r1, r2 } = drawRotated('rect-corner')
    expect(r1.commit).toBeNull()
    expect(r1.state.chain).toMatchObject({ kind: 'rect', rotated: true, anchor: P1 })
    expect(r2.commit).toBeNull()
    expect(r2.state.chain).toMatchObject({ kind: 'rect', rotated: true, edgeEnd: P2 })
  })

  it('click 3 commits 4 lines at the drawn ANGLE (corners NOT axis-aligned)', () => {
    const { third } = drawRotated('rect-corner')
    const lines = lineEntities(third.commit!)
    expect(lines).toHaveLength(4)
    expect(lines[0]).toMatchObject({ start: { x: 0, y: 0 }, end: { x: 3, y: 4 } })
    expect(lines[1]).toMatchObject({ start: { x: 3, y: 4 }, end: { x: -1, y: 7 } })
    expect(lines[2]).toMatchObject({ start: { x: -1, y: 7 }, end: { x: -4, y: 3 } })
    expect(lines[3]).toMatchObject({ start: { x: -4, y: 3 }, end: { x: 0, y: 0 } })
    // No edge is axis-aligned (every edge has both dx and dy non-zero).
    lines.forEach((l) => {
      expect(Math.abs(l.end.x - l.start.x)).toBeGreaterThan(TOL)
      expect(Math.abs(l.end.y - l.start.y)).toBeGreaterThan(TOL)
    })
    // Tool stays armed for the next rectangle; chain ended.
    expect(third.state).toEqual({ tool: 'rect-corner', chain: null })
  })

  it('emits parallel + parallel + perpendicular and NO horizontal/vertical', () => {
    const { third } = drawRotated('rect-corner')
    const cs = third.commit!.constraints
    const kinds = cs.map((c) => c.kind)
    // 4 corner + 2 D1 diagonal-endpoint coincidents = 6.
    expect(kinds.filter((k) => k === 'coincident')).toHaveLength(6)
    expect(kinds.filter((k) => k === 'parallel')).toHaveLength(2)
    expect(kinds.filter((k) => k === 'perpendicular')).toHaveLength(1)
    expect(kinds.filter((k) => k === 'midpoint')).toHaveLength(1) // D1 center tie
    expect(kinds.filter((k) => k === 'horizontal')).toHaveLength(0)
    expect(kinds.filter((k) => k === 'vertical')).toHaveLength(0)
    // 6 coincident + 2 parallel + 1 perpendicular + 1 midpoint = 10.
    expect(cs).toHaveLength(10)
  })

  it('is a rigid rectangle: adjacent sides are perpendicular', () => {
    const { third } = drawRotated('rect-corner')
    const lines = lineEntities(third.commit!)
    const dir = (l: typeof lines[number]) => ({ x: l.end.x - l.start.x, y: l.end.y - l.start.y })
    for (let i = 0; i < 4; i++) {
      const a = dir(lines[i])
      const b = dir(lines[(i + 1) % 4])
      expect(Math.abs(a.x * b.x + a.y * b.y)).toBeLessThan(1e-9) // dot ~ 0
    }
  })

  it('keeps the construction CENTER marker at the rotated-corner average', () => {
    const { third } = drawRotated('rect-corner')
    const points = third.commit!.entities.filter(
      (e): e is SketchPointEntity => e.kind === 'point',
    )
    expect(points).toHaveLength(1)
    expect(points[0].construction).toBe(true)
    expect(points[0].at).toEqual({ x: -0.5, y: 3.5 }) // avg of the 4 corners
  })

  it('ignores a zero-width third click (degenerate)', () => {
    const newId = idFactory()
    const s0 = toggleRectRotated(armed('rect-corner'))
    const r1 = toolClick(s0, P1, TOL, newId)
    const r2 = toolClick(r1.state, P2, TOL, newId)
    // A width point ON the edge line has zero perpendicular distance.
    const onLine = { x: 6, y: 8 } // 2*P2, still on the p1->p2 line
    const r3 = toolClick(r2.state, onLine, TOL, newId)
    expect(r3.commit).toBeNull()
  })

  it('preview: a single rubber-band edge after click1, full rect after click2', () => {
    const newId = idFactory()
    const s0 = toggleRectRotated(armed('rect-corner'))
    // Pre-click1: nothing to rubber-band.
    expect(toolPreview(s0, { x: 1, y: 1 })).toBeNull()
    const r1 = toolClick(s0, P1, TOL, newId)
    expect(toolPreview(r1.state, P2)).toEqual([P1, P2])
    const r2 = toolClick(r1.state, P2, TOL, newId)
    const preview = toolPreview(r2.state, WIDTH)!
    expect(preview).toEqual([
      { x: 0, y: 0 }, { x: 3, y: 4 }, { x: -1, y: 7 }, { x: -4, y: 3 }, { x: 0, y: 0 },
    ])
  })
})
