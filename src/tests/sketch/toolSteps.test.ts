// Tool step sequences — headless coverage (interaction framework).
//
// Two contracts:
//   1. Every armable tool declares a step sequence with imperative
//      prompts (the prompt bar renders them verbatim).
//   2. toolStepStatus derives the current step from the SAME ToolState
//      the machine owns: driving toolClick through a tool's flow
//      advances stepIndex exactly as the declared sequence promises.

import { describe, it, expect } from 'vitest'
import {
  toolClick,
  confirmToolStep,
  armToolWithSelection,
  IDLE_TOOL_STATE,
  ARMABLE_TOOLS,
  type ToolState,
  type ToolClickCtx,
} from '../../lib/sketch/tools/toolMachine'
import {
  toolStepSequence,
  toolStepStatus,
  type ToolStepCtx,
} from '../../lib/sketch/tools/toolSteps'
import type { SketchEntity } from '../../lib/sketch/types'

const TOL = 0.5

function idFactory(): () => string {
  let n = 0
  return () => `id${n++}`
}

function armed(tool: ToolState['tool']): ToolState {
  return { tool, chain: null }
}

/** Drive one click and return the next state (commit ignored). */
function click(
  state: ToolState, x: number, y: number, ctx?: ToolClickCtx,
  newId: () => string = idFactory(),
): ToolState {
  return toolClick(state, { x, y }, TOL, newId, ctx).state
}

describe('step sequence declarations', () => {
  it('every armable tool declares a non-empty sequence', () => {
    for (const tool of ARMABLE_TOOLS) {
      const steps = toolStepSequence(tool)
      expect(steps, tool).not.toBeNull()
      expect(steps!.length, tool).toBeGreaterThan(0)
      for (const s of steps!) {
        expect(s.prompt.length, `${tool}/${s.id}`).toBeGreaterThan(0)
        expect(['entity-pick', 'point-click', 'confirm', 'value']).toContain(s.expects)
      }
    }
  })

  it('select declares no sequence (rest state) and no status', () => {
    expect(toolStepSequence('select')).toBeNull()
    expect(toolStepStatus(armed('select'))).toBeNull()
  })

  it('exposes the declared prompt for a freshly armed tool', () => {
    const st = toolStepStatus(armed('line'))!
    expect(st.stepIndex).toBe(0)
    expect(st.prompt).toBe('Click the start point')
    expect(st.step.expects).toBe('point-click')
  })
})

describe('step advancement per tool click', () => {
  it('line: anchor advances to the chaining step and is confirmable', () => {
    let s = armed('line')
    expect(toolStepStatus(s)!.stepIndex).toBe(0)
    expect(toolStepStatus(s)!.confirmable).toBe(false)
    s = click(s, 0, 0)
    let st = toolStepStatus(s)!
    expect(st.stepIndex).toBe(1)
    expect(st.operandCount).toBe(1)
    expect(st.confirmable).toBe(true) // Enter ends the polyline
    expect(st.prompt).toContain('Enter to finish')
    s = click(s, 10, 0)
    st = toolStepStatus(s)!
    expect(st.stepIndex).toBe(1) // chaining continues
    expect(st.operandCount).toBe(2)
  })

  it('rect-corner: two-click flow resets to step 0 after commit', () => {
    let s = armed('rect-corner')
    s = click(s, 0, 0)
    expect(toolStepStatus(s)!.stepIndex).toBe(1)
    s = click(s, 10, 5)
    expect(toolStepStatus(s)!.stepIndex).toBe(0) // committed, armed again
  })

  it('circle-3pt: three rim points step 0 -> 1 -> 2 -> 0', () => {
    let s = armed('circle-3pt')
    const seen: number[] = [toolStepStatus(s)!.stepIndex]
    s = click(s, 0, 0); seen.push(toolStepStatus(s)!.stepIndex)
    s = click(s, 10, 0); seen.push(toolStepStatus(s)!.stepIndex)
    s = click(s, 5, 5); seen.push(toolStepStatus(s)!.stepIndex)
    expect(seen).toEqual([0, 1, 2, 0])
  })

  it('arc-center: center -> start -> end prompts in order', () => {
    let s = armed('arc-center')
    expect(toolStepStatus(s)!.prompt).toBe('Click the arc center')
    s = click(s, 0, 0)
    expect(toolStepStatus(s)!.prompt).toContain('sets the radius')
    s = click(s, 5, 0)
    expect(toolStepStatus(s)!.prompt).toBe('Click the arc end')
    s = click(s, 0, 5)
    expect(toolStepStatus(s)!.stepIndex).toBe(0)
  })

  it('slot: cap A -> cap B -> width', () => {
    let s = armed('slot')
    s = click(s, 0, 0)
    expect(toolStepStatus(s)!.stepIndex).toBe(1)
    s = click(s, 20, 0)
    const st = toolStepStatus(s)!
    expect(st.stepIndex).toBe(2)
    expect(st.operandCount).toBe(2)
    expect(st.prompt).toBe('Click to set the slot width')
  })

  it('polygon: center -> vertex', () => {
    let s = armed('polygon')
    s = click(s, 0, 0, { entities: [], polygonSides: 6 })
    const st = toolStepStatus(s)!
    expect(st.stepIndex).toBe(1)
    expect(st.prompt).toContain('vertex')
  })

  it('point/trim/project: stateless tools stay at step 0', () => {
    for (const tool of ['point', 'trim', 'project'] as const) {
      let s = armed(tool)
      expect(toolStepStatus(s)!.stepIndex).toBe(0)
      s = click(s, 3, 3)
      expect(toolStepStatus(s)!.stepIndex).toBe(0)
    }
  })

  it('extend: entity pick advances to the boundary-direction step', () => {
    const line: SketchEntity = {
      id: 'l1', kind: 'line', construction: false,
      start: { x: 0, y: 0 }, end: { x: 10, y: 0 },
    }
    let s = armed('extend')
    expect(toolStepStatus(s)!.stepIndex).toBe(0)
    s = click(s, 5, 0, { entities: [line] }) // picks the line
    const st = toolStepStatus(s)!
    expect(st.stepIndex).toBe(1)
    expect(st.operandCount).toBe(1)
    expect(st.prompt).toContain('boundary')
  })

  it('smart-dimension: operand pick advances to the placement step', () => {
    const line: SketchEntity = {
      id: 'l1', kind: 'line', construction: false,
      start: { x: 0, y: 0 }, end: { x: 10, y: 0 },
    }
    const ctx: ToolClickCtx = { entities: [line] }
    let s = armed('smart-dimension')
    expect(toolStepStatus(s)!.stepIndex).toBe(0)
    s = click(s, 5, 0, ctx) // picks the line
    const st = toolStepStatus(s)!
    expect(st.stepIndex).toBe(1)
    expect(st.operandCount).toBe(1)
    expect(st.prompt).toContain('place the dimension')
  })

  it('fillet: line picks stage a corner; staged corners confirm', () => {
    const lines: SketchEntity[] = [
      { id: 'a', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: 10, y: 0 } },
      { id: 'b', kind: 'line', construction: false, start: { x: 10, y: 0 }, end: { x: 10, y: 10 } },
    ]
    const ctx = { entities: lines, constraints: [], dimensions: [] }
    let s = armed('fillet')
    s = click(s, 5, 0, ctx) // first line pending
    let st = toolStepStatus(s)!
    expect(st.stepIndex).toBe(0)
    expect(st.prompt).toContain('second line')
    s = click(s, 10, 5, ctx) // pair resolved -> corner staged
    st = toolStepStatus(s)!
    expect(st.stepIndex).toBe(1)
    expect(st.operandCount).toBe(1)
    expect(st.confirmable).toBe(true) // Enter = the overlay's Apply
    expect(st.prompt).toContain('overlay')
  })

  it('offset: source pick -> side lock -> confirm step indices', () => {
    const circle: SketchEntity = {
      id: 'c1', kind: 'circle', construction: false,
      center: { x: 0, y: 0 }, radius: 5,
    }
    const ctx = { entities: [circle], constraints: [] }
    let s = armed('offset')
    s = click(s, 5, 0, ctx) // pick the circle
    let st = toolStepStatus(s)!
    expect(st.stepIndex).toBe(1)
    expect(st.prompt).toContain('side')
    expect(st.confirmable).toBe(false)
    s = click(s, 9, 0, ctx) // lock the outside
    st = toolStepStatus(s)!
    expect(st.stepIndex).toBe(2)
    expect(st.confirmable).toBe(true) // Enter = the overlay's OK
    expect(st.prompt).toContain('overlay')
  })

  it('mirror: set accumulation counts operands, axis step prompts', () => {
    const ents: SketchEntity[] = [
      { id: 'a', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: 10, y: 0 } },
      { id: 'b', kind: 'circle', construction: false, center: { x: 0, y: 10 }, radius: 2 },
    ]
    const ctx: ToolClickCtx = { entities: ents, selectedIds: [] }
    let s = armed('mirror')
    expect(toolStepStatus(s)!.stepIndex).toBe(0)
    s = click(s, 5, 0, ctx) // toggle line in
    let st = toolStepStatus(s)!
    expect(st.stepIndex).toBe(0) // OPEN set: still the set step
    expect(st.operandCount).toBe(1)
    expect(st.confirmable).toBe(true) // Enter closes the set
    s = click(s, 2, 10, ctx) // toggle circle in
    st = toolStepStatus(s)!
    expect(st.operandCount).toBe(2)
    expect(st.stepIndex).toBe(0)
    expect(st.prompt).toContain('Click entities to mirror') // the set-step prompt
    // Confirm (Enter) closes the set -> the axis step.
    s = confirmToolStep(s)!
    st = toolStepStatus(s)!
    expect(st.stepIndex).toBe(1)
    expect(st.prompt).toContain('click the mirror line')
  })

  it('pattern-linear: set (confirmable) -> Confirm -> anchor -> vector -> overlay', () => {
    const ents: SketchEntity[] = [
      { id: 'a', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: 5, y: 0 } },
    ]
    const ctx: ToolClickCtx = { entities: ents, constraints: [], selectedIds: [] }
    let s = armed('pattern-linear')
    s = click(s, 2, 0, ctx) // toggle entity in
    let st = toolStepStatus(s)!
    expect(st.stepIndex).toBe(0) // still the set step
    expect(st.operandCount).toBe(1)
    expect(st.confirmable).toBe(true) // Enter closes the set
    s = confirmToolStep(s)! // Confirm advances to placement
    expect(toolStepStatus(s)!.stepIndex).toBe(1)
    s = click(s, 50, 50, ctx) // anchor
    st = toolStepStatus(s)!
    expect(st.stepIndex).toBe(2)
    expect(st.prompt).toContain('step-vector end')
    s = click(s, 60, 50, ctx) // vector locked -> overlay step
    st = toolStepStatus(s)!
    expect(st.stepIndex).toBe(3)
    expect(st.confirmable).toBe(true) // Enter = the overlay's OK
    expect(st.prompt).toContain('overlay')
  })

  it('pattern-circular: set -> Confirm -> center -> overlay', () => {
    const ents: SketchEntity[] = [
      { id: 'a', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: 5, y: 0 } },
    ]
    const ctx: ToolClickCtx = { entities: ents, constraints: [], selectedIds: [] }
    let s = armed('pattern-circular')
    s = click(s, 2, 0, ctx)
    expect(toolStepStatus(s)!.stepIndex).toBe(0)
    expect(toolStepStatus(s)!.confirmable).toBe(true)
    s = confirmToolStep(s)!
    let st = toolStepStatus(s)!
    expect(st.stepIndex).toBe(1)
    expect(st.prompt).toContain('rotation center')
    s = click(s, 20, 20, ctx) // center locked -> overlay step
    st = toolStepStatus(s)!
    expect(st.stepIndex).toBe(2)
    expect(st.confirmable).toBe(true)
  })

  it('pattern-path: set -> Confirm -> pick the path -> overlay', () => {
    const ents: SketchEntity[] = [
      { id: 'a', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: 5, y: 0 } },
      { id: 'rail', kind: 'line', construction: false, start: { x: 0, y: 20 }, end: { x: 100, y: 20 } },
    ]
    const ctx: ToolClickCtx = { entities: ents, constraints: [], selectedIds: [] }
    let s = armed('pattern-path')
    s = click(s, 2, 0, ctx) // toggle entity 'a' into the set
    let st = toolStepStatus(s)!
    expect(st.stepIndex).toBe(0)
    expect(st.operandCount).toBe(1)
    expect(st.confirmable).toBe(true) // Enter closes the set
    s = confirmToolStep(s)! // Confirm advances to the path pick
    st = toolStepStatus(s)!
    expect(st.stepIndex).toBe(1)
    expect(st.prompt).toContain('path')
    s = click(s, 50, 20, ctx) // pick the 'rail' line as the path -> overlay step
    st = toolStepStatus(s)!
    expect(st.stepIndex).toBe(2)
    expect(st.confirmable).toBe(true) // Enter = the overlay's OK
    expect(s.chain?.kind === 'pathpat' && s.chain.path).toBeTruthy()
  })
})

describe('selection-seeded prompts (mirror / patterns)', () => {
  const ents: SketchEntity[] = [
    { id: 'a', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: 10, y: 0 } },
    { id: 'b', kind: 'circle', construction: false, center: { x: 0, y: 10 }, radius: 2 },
    { id: 'cx', kind: 'line', construction: true, start: { x: 0, y: -5 }, end: { x: 10, y: -5 } },
  ]

  it('mirror armed with a selection seeds an OPEN set (Confirm closes it)', () => {
    // Pre-selection seeds the SET, not the axis: the user still confirms
    // with Enter before the axis pick (a single lingering selection no
    // longer hijacks the next click as the axis — the tool-first bug).
    const seeded = armToolWithSelection(IDLE_TOOL_STATE, 'mirror', ['a', 'b'], ents)
    const st = toolStepStatus(seeded)!
    expect(st.stepIndex).toBe(0) // still the set step
    expect(st.operandCount).toBe(2)
    expect(st.confirmable).toBe(true)
    expect(st.prompt).toBe(
      '2 entities from selection - click to add or remove, Confirm (Enter) closes the set')
  })

  it('patterns: an arm-time seed fills the set step and asks to Confirm', () => {
    const lin = toolStepStatus(
      armToolWithSelection(IDLE_TOOL_STATE, 'pattern-linear', ['a', 'cx'], ents))!
    expect(lin.stepIndex).toBe(0) // still the set step (Confirm closes it)
    expect(lin.operandCount).toBe(1) // construction excluded from the seed
    expect(lin.confirmable).toBe(true)
    expect(lin.prompt).toBe(
      '1 entity from selection - Confirm (Enter) closes the set, or click to adjust it')
    const circ = toolStepStatus(
      armToolWithSelection(IDLE_TOOL_STATE, 'pattern-circular', ['a', 'b'], ents))!
    expect(circ.stepIndex).toBe(0)
    expect(circ.operandCount).toBe(2)
    expect(circ.prompt).toContain('Confirm')
    const path = toolStepStatus(
      armToolWithSelection(IDLE_TOOL_STATE, 'pattern-path', ['a', 'b'], ents))!
    expect(path.stepIndex).toBe(0)
    expect(path.operandCount).toBe(2)
    expect(path.prompt).toContain('Confirm')
  })

  it('an empty selection leaves the tools at the set step', () => {
    const ctx: ToolStepCtx = { entities: ents, selectedIds: [] }
    expect(toolStepStatus(armed('mirror'), ctx)!.stepIndex).toBe(0)
    expect(toolStepStatus(armed('pattern-linear'), ctx)!.stepIndex).toBe(0)
  })
})

describe('smart-dimension kind-aware prompts (angle-dim fix)', () => {
  const lines: SketchEntity[] = [
    { id: 'L1', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: 10, y: 0 } },
    { id: 'L2', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: 10, y: 10 } },
  ]
  const dimChain = (ids: string[]): ToolState =>
    ({ tool: 'smart-dimension', chain: { kind: 'dim', operandIds: ids } })

  it('one picked line invites a SECOND line for the angle', () => {
    const st = toolStepStatus(dimChain(['L1']), { entities: lines })!
    expect(st.stepIndex).toBe(1)
    expect(st.prompt).toContain('SECOND line')
  })

  it('two picked lines invite placement of the angle dimension', () => {
    const st = toolStepStatus(dimChain(['L1', 'L2']), { entities: lines })!
    expect(st.prompt).toContain('place the angle dimension')
  })

  it('base step names the operand kinds (two lines = angle)', () => {
    const st = toolStepStatus(armed('smart-dimension'), { entities: lines })!
    expect(st.stepIndex).toBe(0)
    expect(st.prompt).toContain('two lines = angle')
  })
})
