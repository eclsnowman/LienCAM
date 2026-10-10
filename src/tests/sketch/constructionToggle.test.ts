// Construction toggle — headless coverage.
//
// Two behaviors (PLAN 3.4, 'q' / toolbox Construction button):
//   1. Draw-as-construction MODE: toolClick ctx.construction flags every
//      entity a click commits (all CREATE tools).
//   2. Selection flip: toggleConstructionFlags flips the flag on selected
//      ENTITY ids and tells the store (null) when the selection holds no
//      entities so it can fall back to toggling the mode.
//
// Construction entities participate in constraints; only the Stage 5
// bake will filter on the flag — nothing here touches the solver.

import { describe, it, expect } from 'vitest'
import {
  toolClick,
  toggleConstructionFlags,
  type ToolState,
  type ToolClickCtx,
} from '../../lib/sketch/tools/toolMachine'
import type { SketchEntity } from '../../lib/sketch/types'

const TOL = 0.5
const CTX: ToolClickCtx = { entities: [], construction: true }

function idFactory(): () => string {
  let n = 0
  return () => `id${n++}`
}

function armed(tool: ToolState['tool']): ToolState {
  return { tool, chain: null }
}

describe('draw-as-construction mode (ctx.construction)', () => {
  it('point tool commits construction points', () => {
    const r = toolClick(armed('point'), { x: 1, y: 2 }, TOL, idFactory(), CTX)
    expect(r.commit!.entities[0].construction).toBe(true)
  })

  it('line tool commits construction segments', () => {
    const newId = idFactory()
    let r = toolClick(armed('line'), { x: 0, y: 0 }, TOL, newId, CTX)
    r = toolClick(r.state, { x: 10, y: 0 }, TOL, newId, CTX)
    expect(r.commit!.entities[0].construction).toBe(true)
  })

  it('rectangle tools flag all four lines (constraints unchanged)', () => {
    const newId = idFactory()
    let r = toolClick(armed('rect-corner'), { x: 0, y: 0 }, TOL, newId, CTX)
    r = toolClick(r.state, { x: 10, y: 5 }, TOL, newId, CTX)
    // Four cut sides + D1's construction diagonal for the tied center (C2 also
    // appends one construction center point).
    expect(r.commit!.entities.filter((e) => e.kind === 'line')).toHaveLength(5)
    expect(r.commit!.entities.every((e) => e.construction)).toBe(true)
    // 8 rect auto-constraints + D1's center tie (2 coincident + 1 midpoint).
    expect(r.commit!.constraints).toHaveLength(11)
  })

  it('circle and arc tools flag their entity', () => {
    const newId = idFactory()
    let c = toolClick(armed('circle-center'), { x: 0, y: 0 }, TOL, newId, CTX)
    c = toolClick(c.state, { x: 5, y: 0 }, TOL, newId, CTX)
    expect(c.commit!.entities[0].construction).toBe(true)

    let a = toolClick(armed('arc-center'), { x: 0, y: 0 }, TOL, newId, CTX)
    a = toolClick(a.state, { x: 5, y: 0 }, TOL, newId, CTX)
    a = toolClick(a.state, { x: 0, y: 5 }, TOL, newId, CTX)
    expect(a.commit!.entities[0].construction).toBe(true)
  })

  it('defaults to normal geometry when ctx omits the flag', () => {
    const r = toolClick(armed('point'), { x: 1, y: 2 }, TOL, idFactory())
    expect(r.commit!.entities[0].construction).toBe(false)
  })
})

describe('toggleConstructionFlags (selection flip)', () => {
  const entities: SketchEntity[] = [
    { id: 'p1', kind: 'point', construction: false, at: { x: 0, y: 0 } },
    { id: 'l1', kind: 'line', construction: true, start: { x: 0, y: 0 }, end: { x: 5, y: 0 } },
    { id: 'c1', kind: 'circle', construction: false, center: { x: 0, y: 0 }, radius: 3 },
  ]

  it('flips exactly the selected entities, both directions', () => {
    const next = toggleConstructionFlags(entities, ['p1', 'l1'])!
    expect(next.map((e) => e.construction)).toEqual([true, false, false])
    // Untouched entities keep identity (no needless re-render churn).
    expect(next[2]).toBe(entities[2])
    // Input is never mutated (store applies the RESULT as one undo step).
    expect(entities[0].construction).toBe(false)
  })

  it('ignores non-entity ids mixed into the selection', () => {
    const next = toggleConstructionFlags(entities, ['c1', 'some-constraint-id'])!
    expect(next.map((e) => e.construction)).toEqual([false, true, true])
  })

  it('returns null when the selection holds no entities (mode fallback)', () => {
    expect(toggleConstructionFlags(entities, [])).toBeNull()
    expect(toggleConstructionFlags(entities, ['some-constraint-id'])).toBeNull()
  })
})
