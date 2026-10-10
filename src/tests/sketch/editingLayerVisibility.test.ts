// USER BUG regression (2026-06-11): re-editing a finished sketch and
// deleting a line left the line VISIBLE until the next Finish — the ghost
// was the layer's stale baked loop rendering under the live sketch.
//
// The viewport hides the baked loops of exactly ONE layer: the one whose
// document is open in sketch mode. sketchEditingLayerId is the headless
// predicate that drives it (Viewport.tsx subscription ->
// CNCViewport.setSketchEditingLayer). These tests pin the predicate over
// the REAL store lifecycle: enter, re-edit, delete, finish, empty-exit,
// document switch.

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import type { SketchEntity } from '../../lib/sketch/types'
import { sketchEditingLayerId } from '../../lib/sketch/editingLayer'

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

beforeAll(async () => {
  ;({ useCamStore } = await import('../../store'))
})

beforeEach(() => {
  useCamStore.setState((s) => ({
    activeSketch: null,
    sketchSolveStatus: null,
    sketchSelectedIds: [],
    sketchTool: 'select',
    sketchToolChain: null,
    sketchConstructionMode: false,
    sketchNotice: null,
    lastNonSketchMode: 'setup' as const,
    viewer: { ...s.viewer, mode: 'setup' as const, selectedGeometryId: null },
    project: { ...s.project, geometry: [] },
    projectHistory: [],
    sketchHistory: [],
  }))
})

const editing = () => sketchEditingLayerId(useCamStore.getState())

function line(id: string, x0: number, y0: number, x1: number, y1: number): SketchEntity {
  return { id, kind: 'line', construction: false, start: { x: x0, y: y0 }, end: { x: x1, y: y1 } }
}

/** Draw a closed 10x10 rectangle in a fresh sketch and finish it. */
function finishRectangleSketch(): string {
  useCamStore.getState().setViewerMode('sketch')
  const layerId = useCamStore.getState().activeSketch!.layerId
  useCamStore.getState().addEntity(line('b', 0, 0, 10, 0))
  useCamStore.getState().addEntity(line('r', 10, 0, 10, 10))
  useCamStore.getState().addEntity(line('t', 10, 10, 0, 10))
  useCamStore.getState().addEntity(line('l', 0, 10, 0, 0))
  useCamStore.getState().finishSketch()
  return layerId
}

describe('sketchEditingLayerId predicate', () => {
  it('null outside sketch mode; the open layer while sketching', () => {
    expect(editing()).toBeNull()
    useCamStore.getState().setViewerMode('sketch')
    const layerId = useCamStore.getState().activeSketch!.layerId
    expect(editing()).toBe(layerId)
  })

  it('REGRESSION: stays the editing layer through a re-edit delete; null after Finish', () => {
    const layerId = finishRectangleSketch()
    expect(editing()).toBeNull() // finished: baked loops must be visible

    // Re-edit the finished sketch — the layer's baked rendering must now hide.
    expect(useCamStore.getState().openSketchForLayer(layerId)).toBe(true)
    expect(editing()).toBe(layerId)

    // Delete one entity: the document updates, and the layer STAYS hidden
    // (this is the exact user-bug moment — the ghost was the baked loop).
    useCamStore.getState().deleteEntity('b')
    // WO SKC-49: 3 remaining rectangle sides + 3 injected anchors (re-entry carries both).
    expect(useCamStore.getState().activeSketch!.entities).toHaveLength(6)
    expect(editing()).toBe(layerId)

    // Finish restores the baked rendering (predicate releases the layer).
    useCamStore.getState().finishSketch()
    expect(editing()).toBeNull()
  })

  it('releases the layer on EMPTY-sketch exit (cancel path)', () => {
    useCamStore.getState().setViewerMode('sketch')
    expect(editing()).not.toBeNull()
    useCamStore.getState().setViewerMode('setup') // empty exit: cleanup path
    expect(editing()).toBeNull()
  })

  it('document SWITCH hands the hide over to the new layer only', () => {
    const first = finishRectangleSketch()
    const second = finishRectangleSketch()
    expect(first).not.toBe(second)

    useCamStore.getState().openSketchForLayer(first)
    expect(editing()).toBe(first)

    // Switching documents routes through the mode-exit rules, then opens
    // the second layer: only the second may be hidden afterwards.
    useCamStore.getState().openSketchForLayer(second)
    expect(editing()).toBe(second)
  })

  it('undo inside the sketch keeps the layer held (visibility consistent)', () => {
    const layerId = finishRectangleSketch()
    useCamStore.getState().openSketchForLayer(layerId)
    useCamStore.getState().deleteEntity('b')
    useCamStore.getState().undo()
    // WO SKC-49: 4 rectangle sides restored + 3 injected anchors.
    expect(useCamStore.getState().activeSketch!.entities).toHaveLength(7)
    expect(editing()).toBe(layerId)
  })
})
