// Pre-selection consumption (interaction framework, commit 3).
//
// Arming a multi-operand MODIFY tool with a NON-EMPTY selection consumes
// it as the first step's operands: the chain arrives seeded, the step
// status skips to the next step, and the next click is the axis /
// anchor / center. Filters match the tools' own click-time seeding
// (mirror: any entity; patterns: construction excluded). Other tools
// arm exactly as before.

import { describe, it, expect } from 'vitest'
import {
  armToolWithSelection,
  toolClick,
  confirmToolStep,
  IDLE_TOOL_STATE,
  PRESELECTION_TOOLS,
  type ToolState,
  type ToolClickCtx,
} from '../../lib/sketch/tools/toolMachine'
import { toolStepStatus } from '../../lib/sketch/tools/toolSteps'
import type { SketchEntity } from '../../lib/sketch/types'

const TOL = 0.5

function idFactory(): () => string {
  let n = 0
  return () => `id${n++}`
}

const ENTS: SketchEntity[] = [
  { id: 'a', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: 10, y: 0 } },
  { id: 'b', kind: 'circle', construction: false, center: { x: 5, y: 5 }, radius: 1 },
  { id: 'cx', kind: 'line', construction: true, start: { x: 20, y: -10 }, end: { x: 20, y: 10 } },
  { id: 'axis', kind: 'line', construction: false, start: { x: 30, y: -10 }, end: { x: 30, y: 10 } },
]

function arm(tool: ToolState['tool'], selected: string[]): ToolState {
  return armToolWithSelection(IDLE_TOOL_STATE, tool, selected, ENTS)
}

describe('armToolWithSelection: consumption per tool', () => {
  it('mirror: seeds the chain with all selected entities as an OPEN set', () => {
    const s = arm('mirror', ['a', 'b'])
    // Seeded as an OPEN set (confirmed:false) — Confirm (Enter) closes it
    // before the axis pick, like the patterns. (Seeding straight to
    // axis-pick was the tool-first bug: a lingering selection hijacked
    // the next click as the axis.)
    expect(s.chain).toEqual({ kind: 'mirror', ids: ['a', 'b'], seeded: true, confirmed: false })
    const st = toolStepStatus(s)!
    expect(st.stepIndex).toBe(0) // still the set step (open)
    expect(st.operandCount).toBe(2)
    expect(st.confirmable).toBe(true) // Enter closes the set
    expect(st.prompt).toBe(
      '2 entities from selection - click to add or remove, Confirm (Enter) closes the set')
  })

  it('patterns: seed excluding construction geometry; Confirm closes the set', () => {
    const lin = arm('pattern-linear', ['a', 'cx'])
    expect(lin.chain).toEqual({
      kind: 'linpat', ids: ['a'], confirmed: false, anchor: null, vector: null,
      seeded: true,
    })
    expect(toolStepStatus(lin)!.prompt).toBe(
      '1 entity from selection - Confirm (Enter) closes the set, or click to adjust it')
    expect(toolStepStatus(lin)!.confirmable).toBe(true)
    const circ = arm('pattern-circular', ['a', 'b', 'cx'])
    expect(circ.chain).toEqual({
      kind: 'circpat', ids: ['a', 'b'], confirmed: false, center: null, seeded: true,
    })
    expect(toolStepStatus(circ)!.prompt).toContain('Confirm')
  })

  it('empty / non-entity selections arm without a seed', () => {
    expect(arm('mirror', []).chain).toBeNull()
    expect(arm('mirror', ['not-an-entity']).chain).toBeNull()
    expect(arm('pattern-linear', ['cx']).chain).toBeNull() // construction only
  })

  it('non-preselection tools ignore the selection entirely', () => {
    for (const tool of ['line', 'trim', 'extend'] as const) {
      expect(PRESELECTION_TOOLS.has(tool)).toBe(false)
      expect(arm(tool, ['a', 'b']).chain).toBeNull()
    }
  })

  it('offset: first selected curve seeds its chain as the source', () => {
    const s = arm('offset', ['a'])
    expect(s.chain?.kind).toBe('offset')
    if (s.chain?.kind !== 'offset') return
    expect(s.chain.lockedSide).toBeNull()
    expect(s.chain.source.kind).toBe('chain')
    const st = toolStepStatus(s)!
    expect(st.stepIndex).toBe(1) // straight to the side pick
    // Construction-only selection arms bare.
    expect(arm('offset', ['cx']).chain).toBeNull()
  })

  it('fillet: seeds every shared corner among the selected lines', () => {
    const rect: SketchEntity[] = [
      { id: 'l1', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: 10, y: 0 } },
      { id: 'l2', kind: 'line', construction: false, start: { x: 10, y: 0 }, end: { x: 10, y: 10 } },
      { id: 'l3', kind: 'line', construction: false, start: { x: 10, y: 10 }, end: { x: 0, y: 10 } },
    ]
    const s = armToolWithSelection(IDLE_TOOL_STATE, 'fillet', ['l1', 'l2', 'l3'], rect)
    expect(s.chain?.kind).toBe('fillet')
    if (s.chain?.kind !== 'fillet') return
    expect(s.chain.corners).toHaveLength(2) // l1/l2 and l2/l3 corners
    const st = toolStepStatus(s)!
    expect(st.stepIndex).toBe(1)
    expect(st.operandCount).toBe(2)
    expect(st.confirmable).toBe(true)
    // No shared corners (or no selection) arms bare.
    expect(armToolWithSelection(IDLE_TOOL_STATE, 'fillet', ['l1'], rect).chain).toBeNull()
  })
})

describe('seeded chain click flows', () => {
  const ctx: ToolClickCtx = {
    entities: ENTS, constraints: [], selectedIds: [],
    linearPatternCount: 3, circularPatternCount: 4,
    circularPatternStepRad: Math.PI / 2,
  }

  it('mirror: Confirm closes the seeded set, then the axis click commits (ANY line)', () => {
    let s = arm('mirror', ['a', 'b'])
    s = confirmToolStep(s)! // Enter closes the set -> axis-pick phase
    expect(s.chain).toMatchObject({ kind: 'mirror', confirmed: true })
    // 'axis' is a regular (non-construction) line: confirmed mode accepts it.
    const r = toolClick(s, { x: 30, y: 0 }, TOL, idFactory(), ctx)
    expect(r.commit).not.toBeNull()
    expect(r.commit!.entities).toHaveLength(2) // both seeds mirrored
    expect(r.state.chain).toBeNull() // flow complete, tool stays armed
    expect(r.state.tool).toBe('mirror')
  })

  it('mirror: a seeded set click ADDS an entity (does not hijack as the axis)', () => {
    // The tool-first bug: a single lingering selection seeded the chain
    // and the very next click (meant to add 'b') committed instead.
    const s = arm('mirror', ['a'])
    // Circle 'b' is center (5,5) r=1 -> click its rim at (6,5).
    const r = toolClick(s, { x: 6, y: 5 }, TOL, idFactory(), ctx)
    expect(r.commit).toBeNull() // NOT an instant mirror
    expect(r.state.chain).toMatchObject({ kind: 'mirror', ids: ['a', 'b'] })
  })

  it('mirror: a miss on a CONFIRMED set keeps the operands and explains itself', () => {
    let s = arm('mirror', ['a'])
    s = confirmToolStep(s)!
    const r = toolClick(s, { x: 100, y: 100 }, TOL, idFactory(), ctx)
    expect(r.commit).toBeNull()
    expect(r.notice).toContain('click a LINE')
    expect(r.state.chain).toMatchObject({ kind: 'mirror', ids: ['a'], confirmed: true })
  })

  it('linear pattern: Confirm closes the seeded set, two clicks place the vector', () => {
    let s = arm('pattern-linear', ['a'])
    s = confirmToolStep(s)! // Enter / prompt-bar Confirm
    expect(toolStepStatus(s)!.stepIndex).toBe(1)
    const r1 = toolClick(s, { x: 0, y: 20 }, TOL, idFactory(), ctx)
    expect(toolStepStatus(r1.state)!.stepIndex).toBe(2)
    const r2 = toolClick(r1.state, { x: 0, y: 40 }, TOL, idFactory(), ctx)
    expect(r2.commit).toBeNull() // the overlay's OK commits, not the click
    expect(r2.state.chain).toMatchObject({
      kind: 'linpat', vector: { x: 0, y: 20 },
    })
    expect(toolStepStatus(r2.state)!.stepIndex).toBe(3) // overlay step
    expect(toolStepStatus(r2.state)!.confirmable).toBe(true)
  })

  it('circular pattern: Confirm closes the set, the click locks the center', () => {
    let s = arm('pattern-circular', ['b'])
    s = confirmToolStep(s)!
    const r = toolClick(s, { x: 0, y: 0 }, TOL, idFactory(), ctx)
    expect(r.commit).toBeNull()
    expect(r.state.chain).toMatchObject({
      kind: 'circpat', center: { x: 0, y: 0 },
    })
    expect(toolStepStatus(r.state)!.confirmable).toBe(true)
  })
})
