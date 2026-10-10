// Sketch prompt bar — headless coverage (interaction framework).
//
// The bar renders promptBarModel verbatim, so the model IS the bar:
//   - idle hint when no tool is armed
//   - armed tool label + current step prompt + step position
//   - live operand counts ("2 entities selected")
//   - Confirm enabled exactly when the step is confirmable
// Plus the Enter-confirm dispatch: the bar's Confirm button and the
// viewport's Enter key call the SAME store action (sketchToolEnd) —
// covered end-to-end through the real store.
//
// Store-import stubs: same pattern as layerLocking.test.ts.

import { describe, it, expect, vi, beforeAll } from 'vitest'
import {
  promptBarModel,
  toolCommitFlash,
  toolReplaceFlash,
  PROMPT_BAR_IDLE_HINT,
  SKETCH_TOOL_LABELS,
} from '../../lib/sketch/promptBar'
import { ARMABLE_TOOLS, type ToolState } from '../../lib/sketch/tools/toolMachine'
import type { SketchEntity } from '../../lib/sketch/types'

class StubWorker {
  onmessage: ((e: unknown) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  postMessage(): void {}
  terminate(): void {}
}
vi.stubGlobal('Worker', StubWorker)
vi.stubGlobal('localStorage', {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
})

let useCamStore: typeof import('../../store').useCamStore
// The armed tool + chain and the end/escape dispatch now live in the sketcher
// package (WO SKC-14B); import it dynamically alongside the store.
let sketcherTools: typeof import('../../lib/sketch/sketcher').sketcherTools
let sketcherToolStore: typeof import('../../lib/sketch/sketcher').sketcherToolStore

beforeAll(async () => {
  ;({ useCamStore } = await import('../../store'))
  ;({ sketcherTools, sketcherToolStore } = await import('../../lib/sketch/sketcher'))
})

function armed(tool: ToolState['tool']): ToolState {
  return { tool, chain: null }
}

describe('promptBarModel (pure)', () => {
  it('select mode yields the idle hint', () => {
    const m = promptBarModel(armed('select'))
    expect(m.kind).toBe('idle')
    if (m.kind === 'idle') expect(m.hint).toBe(PROMPT_BAR_IDLE_HINT)
  })

  it('every armable tool yields an armed model with a label and prompt', () => {
    for (const tool of ARMABLE_TOOLS) {
      const m = promptBarModel(armed(tool))
      expect(m.kind, tool).toBe('armed')
      if (m.kind !== 'armed') continue
      expect(m.toolLabel).toBe(SKETCH_TOOL_LABELS[tool])
      expect(m.prompt.length).toBeGreaterThan(0)
      expect(m.stepNumber).toBe(1)
      expect(m.stepCount).toBeGreaterThan(0)
    }
  })

  it('line chaining: step position advances and Confirm becomes enabled', () => {
    const m0 = promptBarModel(armed('line'))
    expect(m0.kind === 'armed' && m0.canConfirm).toBe(false)
    const chained = promptBarModel({
      tool: 'line',
      chain: {
        kind: 'line', start: { x: 0, y: 0 }, firstLineId: 'l1',
        prev: { x: 10, y: 0 }, prevLineId: 'l1',
      },
    })
    expect(chained.kind).toBe('armed')
    if (chained.kind === 'armed') {
      expect(chained.stepNumber).toBe(2)
      expect(chained.canConfirm).toBe(true)
      expect(chained.operandText).toBe('2 points placed')
    }
  })

  it('mirror set: live entity operand count (open set is the set step)', () => {
    const m = promptBarModel({
      tool: 'mirror',
      chain: { kind: 'mirror', ids: ['a', 'b'] },
    })
    expect(m.kind).toBe('armed')
    if (m.kind === 'armed') {
      expect(m.operandText).toBe('2 entities selected')
      expect(m.stepNumber).toBe(1) // OPEN set: still the set step
      expect(m.canConfirm).toBe(true) // Enter closes the set
      expect(m.prompt).toContain('Click entities to mirror')
    }
  })

  it('mirror set CONFIRMED: advances to the axis step', () => {
    const m = promptBarModel({
      tool: 'mirror',
      chain: { kind: 'mirror', ids: ['a', 'b'], confirmed: true },
    })
    expect(m.kind).toBe('armed')
    if (m.kind === 'armed') {
      expect(m.stepNumber).toBe(2) // axis step
      expect(m.prompt).toContain('click the mirror line')
    }
  })

  it('stateless pick tools show no operand text', () => {
    const m = promptBarModel(armed('trim'))
    expect(m.kind === 'armed' && m.operandText).toBe(null)
  })
})

describe('commit flash messages', () => {
  const doc: SketchEntity[] = [
    { id: 'ax', kind: 'line', construction: true, start: { x: 0, y: 0 }, end: { x: 0, y: 10 } },
    { id: 'e1', kind: 'circle', construction: false, center: { x: 5, y: 5 }, radius: 2 },
  ]

  it('mirror names the axis with its document-order label', () => {
    const flash = toolCommitFlash('mirror', {
      entities: [
        { id: 'm1', kind: 'circle', construction: false, center: { x: -5, y: 5 }, radius: 2 },
      ],
      constraints: [
        { id: 'c1', kind: 'symmetric', a: { entityId: 'e1', site: 'center' },
          b: { entityId: 'm1', site: 'center' }, axis: 'ax' },
      ],
    }, doc)
    expect(flash).toBe('Mirrored 1 entity about Line 1')
  })

  it('patterns and offset report created entity counts', () => {
    const commit = {
      entities: [
        { id: 'p1', kind: 'point', construction: false, at: { x: 0, y: 0 } } as SketchEntity,
        { id: 'p2', kind: 'point', construction: false, at: { x: 1, y: 0 } } as SketchEntity,
      ],
      constraints: [],
    }
    expect(toolCommitFlash('pattern-linear', commit, doc))
      .toBe('Linear pattern: created 2 entities')
    expect(toolCommitFlash('pattern-circular', commit, doc))
      .toBe('Circular pattern: created 2 entities')
    expect(toolCommitFlash('offset', commit, doc))
      .toBe('Offset: created 2 entities')
  })

  it('CREATE commits stay quiet (self-evident on canvas)', () => {
    const commit = {
      entities: [
        { id: 'p1', kind: 'point', construction: false, at: { x: 0, y: 0 } } as SketchEntity,
      ],
      constraints: [],
    }
    expect(toolCommitFlash('line', commit, doc)).toBeNull()
    expect(toolCommitFlash('point', commit, doc)).toBeNull()
  })

  it('replace transforms flash for trim/extend only (fillet flashes from its overlay Apply)', () => {
    expect(toolReplaceFlash('trim')).toContain('Trimmed')
    expect(toolReplaceFlash('extend')).toContain('Extended')
    expect(toolReplaceFlash('fillet')).toBeNull()
    expect(toolReplaceFlash('mirror')).toBeNull()
  })
})

describe('Enter-confirm dispatch (store)', () => {
  it('sketchToolEnd (Confirm button / Enter) ends the chain, tool stays armed', () => {
    const store = useCamStore.getState()
    store.setViewerMode('sketch') // auto-creates a blank active sketch
    sketcherTools.armTool('line')
    sketcherTools.click({ x: 0, y: 0 }, 0.5, null, false)
    sketcherTools.click({ x: 10, y: 0 }, 0.5, null, false)
    expect(sketcherToolStore.getState().chain).not.toBeNull()

    // The bar model offers Confirm for the in-progress polyline.
    const ts = sketcherToolStore.getState()
    const s = useCamStore.getState()
    const m = promptBarModel(
      { tool: ts.tool, chain: ts.chain },
      { entities: s.activeSketch?.entities ?? [], selectedIds: s.sketchSelectedIds },
    )
    expect(m.kind === 'armed' && m.canConfirm).toBe(true)

    // Confirm = the SAME action the viewport's Enter key dispatches.
    sketcherTools.end()
    const after = sketcherToolStore.getState()
    expect(after.chain).toBeNull()
    expect(after.tool).toBe('line') // armed for the next chain
  })
})
