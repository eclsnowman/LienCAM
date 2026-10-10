// WO-1481 — step count and dimension prompt say what the click actually does.
//
// BUG-540: the angled (Tab) 3-click rect flow (rect-corner/rect-center)
// clamped stepIndex/steps.length to the axis-aligned tool's 2-entry STEPS
// declaration, so the prompt bar read "Step 2 of 2" on BOTH the
// opposite-edge-end click and the width click — implying completion one
// click early.
// BUG-539: the smart-dimension two-line branch always prompted "click to
// place the angle dimension" from operand COUNT + entity KIND alone, even
// when the two lines are parallel and planDimension actually resolves a
// perpendicular distance (distancePL).
//
// Both fixed the same way: toolStepStatus now consults the state/plan the
// tool module already computed instead of guessing from a cheap proxy.

import { describe, it, expect } from 'vitest'
import { toolStepStatus } from '../../lib/sketch/tools/toolSteps'
import type { ToolState } from '../../lib/sketch/tools/toolMachine'
import type { SketchEntity } from '../../lib/sketch/types'

describe('WO-1481: angled rect step count is honest (BUG-540)', () => {
  it('rect-center: three distinct steps, never repeating "2 of 2"', () => {
    const stage1: ToolState = {
      tool: 'rect-center',
      chain: { kind: 'rect', mode: 'center', rotated: true },
    }
    const s1 = toolStepStatus(stage1)!
    expect(s1.steps.length).toBe(3)
    expect(s1.stepIndex).toBe(0)

    const stage2: ToolState = {
      tool: 'rect-center',
      chain: { kind: 'rect', mode: 'center', rotated: true, anchor: { x: 0, y: 0 } },
    }
    const s2 = toolStepStatus(stage2)!
    expect(s2.steps.length).toBe(3)
    expect(s2.stepIndex).toBe(1)
    expect(s2.prompt).toContain('opposite end of the first edge')

    const stage3: ToolState = {
      tool: 'rect-center',
      chain: {
        kind: 'rect', mode: 'center', rotated: true,
        anchor: { x: 0, y: 0 }, edgeEnd: { x: 10, y: 0 },
      },
    }
    const s3 = toolStepStatus(stage3)!
    expect(s3.steps.length).toBe(3)
    expect(s3.stepIndex).toBe(2)
    expect(s3.prompt).toContain('set the width')

    // The two in-progress stages must not collapse onto the same reading.
    expect(`${s2.stepIndex + 1} of ${s2.steps.length}`)
      .not.toBe(`${s3.stepIndex + 1} of ${s3.steps.length}`)
  })

  it('rect-corner: same three-stage sequence', () => {
    const edgeEndStage: ToolState = {
      tool: 'rect-corner',
      chain: { kind: 'rect', mode: 'corner', rotated: true, anchor: { x: 0, y: 0 } },
    }
    const widthStage: ToolState = {
      tool: 'rect-corner',
      chain: {
        kind: 'rect', mode: 'corner', rotated: true,
        anchor: { x: 0, y: 0 }, edgeEnd: { x: 10, y: 0 },
      },
    }
    const s2 = toolStepStatus(edgeEndStage)!
    const s3 = toolStepStatus(widthStage)!
    expect(s2.steps.length).toBe(3)
    expect(s3.steps.length).toBe(3)
    expect(s2.stepIndex).toBe(1)
    expect(s3.stepIndex).toBe(2)
  })

  it('axis-aligned rectangle mode is unchanged (still two steps)', () => {
    const fresh = toolStepStatus({ tool: 'rect-center', chain: null })!
    expect(fresh.steps.length).toBe(2)
    expect(fresh.stepIndex).toBe(0)

    const anchored: ToolState = {
      tool: 'rect-center',
      chain: { kind: 'rect', mode: 'center', anchor: { x: 0, y: 0 } },
    }
    const s = toolStepStatus(anchored)!
    expect(s.steps.length).toBe(2)
    expect(s.stepIndex).toBe(1)
  })
})

describe('WO-1481: smart-dimension prompt matches the resolved plan (BUG-539)', () => {
  const parallelLines: SketchEntity[] = [
    { id: 'l1', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: 10, y: 0 } },
    { id: 'l2', kind: 'line', construction: false, start: { x: 0, y: 5 }, end: { x: 10, y: 5 } },
  ]
  const angledLines: SketchEntity[] = [
    { id: 'l1', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: 10, y: 0 } },
    { id: 'l2', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: 0, y: 10 } },
  ]

  it('two PARALLEL lines: prompt says perpendicular distance, not angle', () => {
    const state: ToolState = {
      tool: 'smart-dimension',
      chain: { kind: 'dim', operandIds: ['l1', 'l2'] },
    }
    const status = toolStepStatus(state, { entities: parallelLines })!
    expect(status.prompt.toLowerCase()).toContain('perpendicular')
    expect(status.prompt.toLowerCase()).not.toContain('angle')
  })

  it('two NON-parallel lines: prompt still says angle dimension (unchanged)', () => {
    const state: ToolState = {
      tool: 'smart-dimension',
      chain: { kind: 'dim', operandIds: ['l1', 'l2'] },
    }
    const status = toolStepStatus(state, { entities: angledLines })!
    expect(status.prompt.toLowerCase()).toContain('angle dimension')
  })
})
