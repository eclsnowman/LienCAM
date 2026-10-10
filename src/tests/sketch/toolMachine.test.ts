// Sketch tool state machine — headless transition coverage (Stage 3).
//
// The machine is pure (src/lib/sketch/tools/toolMachine.ts); these tests
// pin the standard editor armed-tool doctrine: tools stay armed until Esc, first
// Esc cancels the in-progress chain, second Esc returns to Select, Enter
// (or double-click) ends a chain without closing.

import { describe, it, expect } from 'vitest'
import {
  IDLE_TOOL_STATE,
  armTool,
  escapeTool,
  endChain,
  toolClick,
  toggleRectRotated,
  type ToolState,
  type LineChainState,
} from '../../lib/sketch/tools/toolMachine'

function chaining(tool: ToolState['tool'] = 'line'): ToolState {
  const chain: LineChainState = {
    kind: 'line',
    start: { x: 0, y: 0 },
    firstLineId: 'l1',
    prev: { x: 10, y: 0 },
    prevLineId: 'l1',
  }
  return { tool, chain }
}

describe('tool arming', () => {
  it('ARM(t) from select arms the tool with no chain', () => {
    const s = armTool(IDLE_TOOL_STATE, 'line')
    expect(s.tool).toBe('line')
    expect(s.chain).toBeNull()
  })

  it('ARM(t) mid-chain discards the in-progress chain (implicit cancel)', () => {
    const s = armTool(chaining('line'), 'point')
    expect(s.tool).toBe('point')
    expect(s.chain).toBeNull()
  })

  it('ARM(select) disarms', () => {
    const s = armTool(armTool(IDLE_TOOL_STATE, 'line'), 'select')
    expect(s).toEqual(IDLE_TOOL_STATE)
  })
})

describe('escape', () => {
  it('first Esc mid-chain cancels ONLY the chain; tool stays armed', () => {
    const r = escapeTool(chaining('line'))
    expect(r.consumed).toBe(true)
    expect(r.state.tool).toBe('line')
    expect(r.state.chain).toBeNull()
  })

  it('second Esc (armed, no chain) returns to Select', () => {
    const r = escapeTool({ tool: 'line', chain: null })
    expect(r.consumed).toBe(true)
    expect(r.state).toEqual(IDLE_TOOL_STATE)
  })

  it('Esc in Select is NOT consumed (caller clears selection instead)', () => {
    const r = escapeTool(IDLE_TOOL_STATE)
    expect(r.consumed).toBe(false)
    expect(r.state).toEqual(IDLE_TOOL_STATE)
  })
})

// Bug T5 regression: pressing Esc while ANY multi-click tool has staged
// operands/points must ABORT the in-progress chain WITHOUT committing a
// half-built entity — the tool returns to its armed (chain=null) state and
// the event is consumed. This pins the SHARED cancel path (escapeTool's
// generic "drop the chain" branch) for every tool the user can leave
// mid-operation, so a future per-tool tweak can never silently regress it.
describe('escape aborts an in-progress multi-click chain with no commit (T5)', () => {
  const TOL = 0.5

  // Build a partial chain by replaying clicks; assert NONE of the
  // intermediate clicks committed an entity (only the FINAL click would),
  // then Esc and assert the chain is dropped, the tool stays armed, and the
  // event was consumed.
  function expectAbort(
    tool: ToolState['tool'],
    points: Array<{ x: number; y: number }>,
  ) {
    const newId = idFactory()
    let r = toolClick({ tool, chain: null }, points[0], TOL, newId)
    expect(r.commit).toBeNull()        // first click only anchors
    for (let i = 1; i < points.length; i++) {
      r = toolClick(r.state, points[i], TOL, newId)
      expect(r.commit).toBeNull()      // still mid-chain: nothing committed
    }
    expect(r.state.chain).not.toBeNull() // a chain really is in progress
    const esc = escapeTool(r.state)
    expect(esc.consumed).toBe(true)
    expect(esc.state.tool).toBe(tool)  // stays armed (standard editor doctrine)
    expect(esc.state.chain).toBeNull() // ...with the in-progress chain gone
  }

  it('elliptical-arc (center, major, minor, start placed) aborts', () => {
    // The reported repro: 4 of 5 points placed, no entity should survive.
    expectAbort('ellipse-arc', [
      { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 5 }, { x: 10, y: 0 },
    ])
  })

  it('ellipse (center, major placed) aborts', () => {
    expectAbort('ellipse', [{ x: 0, y: 0 }, { x: 10, y: 0 }])
  })

  it('line chain (anchor + one segment) aborts the OPEN chain (committed segments stay, by design)', () => {
    // The line tool is the one multi-click tool that commits each SEGMENT
    // as it is drawn; Esc drops only the still-open chain (the rubber-band
    // to the next point), it does not retroactively delete committed
    // segments — that is the documented doctrine, the store leaves prior
    // committed entities in the document.
    const newId = idFactory()
    let r = toolClick({ tool: 'line', chain: null }, { x: 0, y: 0 }, TOL, newId)
    expect(r.commit).toBeNull()          // anchor only
    r = toolClick(r.state, { x: 10, y: 0 }, TOL, newId)
    expect(r.commit).not.toBeNull()      // first segment commits
    expect(r.state.chain).not.toBeNull() // chain still open for the next pt
    const esc = escapeTool(r.state)
    expect(esc.consumed).toBe(true)
    expect(esc.state).toEqual({ tool: 'line', chain: null })
  })

  it('rect-corner (first corner placed) aborts', () => {
    expectAbort('rect-corner', [{ x: 0, y: 0 }])
  })

  it('polygon (center placed) aborts', () => {
    expectAbort('polygon', [{ x: 0, y: 0 }])
  })

  it('slot (axis start placed) aborts', () => {
    expectAbort('slot', [{ x: 0, y: 0 }])
  })

  it('slot-arc (centerline start placed) aborts', () => {
    expectAbort('slot-arc', [{ x: 0, y: 0 }])
  })

  it('arc-3pt (start placed) aborts', () => {
    expectAbort('arc-3pt', [{ x: 0, y: 0 }])
  })

  // Staged / pick-set tools whose chain is a non-geometric payload: build
  // the chain state the tool produces after one pick, then assert Esc drops
  // it with nothing committed.
  it('smart-dimension with one operand picked aborts (no dimension)', () => {
    const mid: ToolState = {
      tool: 'smart-dimension',
      chain: { kind: 'dim', operandIds: ['L1'] },
    }
    const esc = escapeTool(mid)
    expect(esc.consumed).toBe(true)
    expect(esc.state).toEqual({ tool: 'smart-dimension', chain: null })
  })

  it('fillet with a staged corner aborts (no arc inserted)', () => {
    const mid: ToolState = {
      tool: 'fillet',
      chain: {
        kind: 'fillet',
        corners: [
          { aId: 'L1', bId: 'L2', hintA: { x: 1, y: 0 }, hintB: { x: 0, y: 1 }, at: { x: 0, y: 0 } },
        ],
        pendingLineId: null,
        pendingClick: null,
      },
    }
    const esc = escapeTool(mid)
    expect(esc.consumed).toBe(true)
    expect(esc.state).toEqual({ tool: 'fillet', chain: null })
  })

  it('fillet with one line picked (pending pair) aborts', () => {
    const mid: ToolState = {
      tool: 'fillet',
      chain: {
        kind: 'fillet', corners: [],
        pendingLineId: 'L1', pendingClick: { x: 2, y: 0 },
      },
    }
    const esc = escapeTool(mid)
    expect(esc.consumed).toBe(true)
    expect(esc.state.chain).toBeNull()
  })

  it('chamfer with a staged corner aborts (no chamfer line inserted)', () => {
    const mid: ToolState = {
      tool: 'chamfer',
      chain: {
        kind: 'chamfer',
        corners: [
          { aId: 'L1', bId: 'L2', hintA: { x: 1, y: 0 }, hintB: { x: 0, y: 1 }, at: { x: 0, y: 0 } },
        ],
        pendingLineId: null,
        pendingClick: null,
      },
    }
    const esc = escapeTool(mid)
    expect(esc.consumed).toBe(true)
    expect(esc.state).toEqual({ tool: 'chamfer', chain: null })
  })
})

describe('end chain (Enter / double-click)', () => {
  it('ends the chain without closing; tool stays armed', () => {
    const s = endChain(chaining('line'))
    expect(s.tool).toBe('line')
    expect(s.chain).toBeNull()
  })

  it('is a no-op when no chain is in progress', () => {
    const armed: ToolState = { tool: 'line', chain: null }
    expect(endChain(armed)).toBe(armed)
    expect(endChain(IDLE_TOOL_STATE)).toBe(IDLE_TOOL_STATE)
  })
})

// The toolbox RectRotatedRow (SketchToolbox.tsx) reads the live rotated flag
// off the rect chain with exactly this expression and toggles via the store's
// toggleSketchRectRotated -> pure toggleRectRotated. Pin that read+toggle so
// the discoverable affordance stays in sync with the Tab shortcut.
describe('rotated-rect toolbox affordance wiring', () => {
  // Mirror of the RectRotatedRow selector: rotated flag off the rect chain.
  const readRotated = (s: ToolState): boolean =>
    s.chain?.kind === 'rect' ? s.chain.rotated === true : false

  it('reads OFF while armed, and the toggle flips it ON (and back)', () => {
    const armed: ToolState = { tool: 'rect-corner', chain: null }
    expect(readRotated(armed)).toBe(false)
    const on = toggleRectRotated(armed)
    expect(readRotated(on)).toBe(true)
    // The button click toggles back to axis-aligned (plain armed).
    expect(readRotated(toggleRectRotated(on))).toBe(false)
  })

  it('reflects a mid-draw chain toggled via the same action', () => {
    let s: ToolState = { tool: 'rect-center', chain: null }
    s = toolClick(s, { x: 0, y: 0 }, 0.5).state // click1 anchors, axis-aligned
    expect(readRotated(s)).toBe(false)
    s = toggleRectRotated(s) // toolbox button / Tab mid-draw
    expect(readRotated(s)).toBe(true)
  })
})

describe('click dispatch', () => {
  it('select-tool clicks are a no-op (selection is the viewport path)', () => {
    const r = toolClick(IDLE_TOOL_STATE, { x: 5, y: 5 }, 0.5)
    expect(r.state).toEqual(IDLE_TOOL_STATE)
    expect(r.commit).toBeNull()
  })
})

// Deterministic id factory for commit assertions.
function idFactory(): () => string {
  let n = 0
  return () => `id${n++}`
}

describe('point tool', () => {
  it('each click commits a free point; the tool stays armed', () => {
    const armed: ToolState = { tool: 'point', chain: null }
    const r = toolClick(armed, { x: 3, y: -2 }, 0.5, idFactory())
    expect(r.state).toEqual(armed)
    expect(r.commit).toEqual({
      entities: [{ id: 'id0', kind: 'point', construction: false, at: { x: 3, y: -2 } }],
      constraints: [],
    })
  })
})

describe('line tool (chained polyline)', () => {
  const TOL = 0.5

  it('first click anchors the chain without committing anything', () => {
    const r = toolClick({ tool: 'line', chain: null }, { x: 0, y: 0 }, TOL, idFactory())
    expect(r.commit).toBeNull()
    expect(r.state.chain).toEqual({
      kind: 'line',
      start: { x: 0, y: 0 }, firstLineId: null,
      prev: { x: 0, y: 0 }, prevLineId: null,
    })
  })

  it('second click commits the first segment with NO constraint', () => {
    const newId = idFactory()
    let r = toolClick({ tool: 'line', chain: null }, { x: 0, y: 0 }, TOL, newId)
    r = toolClick(r.state, { x: 10, y: 0 }, TOL, newId)
    expect(r.commit).not.toBeNull()
    expect(r.commit!.entities).toEqual([{
      id: 'id0', kind: 'line', construction: false,
      start: { x: 0, y: 0 }, end: { x: 10, y: 0 },
    }])
    expect(r.commit!.constraints).toEqual([])
    expect(r.state.chain).toEqual({
      kind: 'line',
      start: { x: 0, y: 0 }, firstLineId: 'id0',
      prev: { x: 10, y: 0 }, prevLineId: 'id0',
    })
  })

  it('later clicks auto-add a coincident joining consecutive segments', () => {
    const newId = idFactory()
    let r = toolClick({ tool: 'line', chain: null }, { x: 0, y: 0 }, TOL, newId)
    r = toolClick(r.state, { x: 10, y: 0 }, TOL, newId)   // id0
    r = toolClick(r.state, { x: 10, y: 8 }, TOL, newId)   // id1 + id2 constraint
    expect(r.commit!.entities[0]).toMatchObject({
      id: 'id1', kind: 'line', start: { x: 10, y: 0 }, end: { x: 10, y: 8 },
    })
    expect(r.commit!.constraints).toEqual([{
      id: 'id2', kind: 'coincident',
      a: { entityId: 'id0', site: 'end' },
      b: { entityId: 'id1', site: 'start' },
    }])
  })

  it('clicking the chain start CLOSES the chain: snapped endpoint, closure coincident, chain ends, tool stays armed', () => {
    const newId = idFactory()
    let r = toolClick({ tool: 'line', chain: null }, { x: 0, y: 0 }, TOL, newId)
    r = toolClick(r.state, { x: 10, y: 0 }, TOL, newId)   // id0
    r = toolClick(r.state, { x: 10, y: 8 }, TOL, newId)   // id1, id2
    // Click NEAR (not exactly on) the start: within tolerance closes.
    r = toolClick(r.state, { x: 0.3, y: -0.2 }, TOL, newId) // id3, id4, id5
    expect(r.commit!.entities[0]).toMatchObject({
      id: 'id3', kind: 'line',
      start: { x: 10, y: 8 },
      end: { x: 0, y: 0 },                  // snapped to the exact start
    })
    expect(r.commit!.constraints).toEqual([
      { id: 'id4', kind: 'coincident',
        a: { entityId: 'id1', site: 'end' }, b: { entityId: 'id3', site: 'start' } },
      { id: 'id5', kind: 'coincident',
        a: { entityId: 'id3', site: 'end' }, b: { entityId: 'id0', site: 'start' } },
    ])
    expect(r.state.chain).toBeNull()       // chain ended...
    expect(r.state.tool).toBe('line')      // ...tool still armed
  })

  it('ignores zero-length clicks (within tolerance of the previous point)', () => {
    const newId = idFactory()
    let r = toolClick({ tool: 'line', chain: null }, { x: 0, y: 0 }, TOL, newId)
    r = toolClick(r.state, { x: 10, y: 0 }, TOL, newId)
    const before = r.state
    r = toolClick(r.state, { x: 10.2, y: 0.1 }, TOL, newId)
    expect(r.commit).toBeNull()
    expect(r.state).toEqual(before)
  })

  it('a click near the start does NOT close before any segment exists', () => {
    const newId = idFactory()
    let r = toolClick({ tool: 'line', chain: null }, { x: 0, y: 0 }, TOL, newId)
    // Within tol of start == within tol of prev -> zero-length guard.
    r = toolClick(r.state, { x: 0.1, y: 0.1 }, TOL, newId)
    expect(r.commit).toBeNull()
    expect((r.state.chain as LineChainState).firstLineId).toBeNull()
  })

  it('Esc mid-chain cancels only the chain; committed segments are not the machine\'s concern', () => {
    const newId = idFactory()
    let r = toolClick({ tool: 'line', chain: null }, { x: 0, y: 0 }, TOL, newId)
    r = toolClick(r.state, { x: 10, y: 0 }, TOL, newId)
    const esc = escapeTool(r.state)
    expect(esc.consumed).toBe(true)
    expect(esc.state).toEqual({ tool: 'line', chain: null })
  })
})
