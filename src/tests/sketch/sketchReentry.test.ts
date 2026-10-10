// Re-entry + guardrails (Stage 5, commit 4) — headless store tests.
//
// Pins: finishing a sketch stores its parametric document; re-entering
// (openSketchForLayer, or the mode tab with the sketches container
// selected) REOPENS that document; the next finish REPLACES the layer's
// loops. Guardrails: all-open-chain sketches bake 'open' loops (ops that
// need closed loops already filter), a solver-CONFLICTING sketch still
// bakes (warned in the notice), and emptying a re-opened sketch never
// deletes the layer's existing loops.

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
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

// WO-2189: every new sketch is its own part - find it through its layer's owner.
const container = (layerId: string) =>
  useCamStore.getState().project.geometry.find((g) => g.layers2d?.some((l) => l.id === layerId))

function line(id: string, x0: number, y0: number, x1: number, y1: number): SketchEntity {
  return { id, kind: 'line', construction: false, start: { x: x0, y: y0 }, end: { x: x1, y: y1 } }
}

/** Draw a closed 10x10 rectangle in a fresh sketch and finish it.
 *  Returns the layer id it baked to. */
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

const layerLoops = (layerId: string) =>
  (container(layerId)?.loops ?? []).filter((l) => l.layerId === layerId)

describe('re-entry round trip', () => {
  it('finish -> reopen -> modify -> finish REPLACES the layer loops', () => {
    const layerId = finishRectangleSketch()
    expect(layerLoops(layerId)).toHaveLength(1)
    expect(useCamStore.getState().activeSketch).toBeNull()

    // Re-open through the real entry path.
    const ok = useCamStore.getState().openSketchForLayer(layerId)
    expect(ok).toBe(true)
    const st = useCamStore.getState()
    expect(st.viewer.mode).toBe('sketch')
    expect(st.activeSketch).not.toBeNull()
    expect(st.activeSketch!.layerId).toBe(layerId)
    // WO SKC-49: + three injected anchors, appended after the four stored rectangle entities.
    expect(st.activeSketch!.entities).toHaveLength(7) // parametric re-edit

    // Modify: add a second disjoint rectangle, finish again.
    useCamStore.getState().addEntity(line('b2', 20, 0, 30, 0))
    useCamStore.getState().addEntity(line('r2', 30, 0, 30, 10))
    useCamStore.getState().addEntity(line('t2', 30, 10, 20, 10))
    useCamStore.getState().addEntity(line('l2', 20, 10, 20, 0))
    useCamStore.getState().finishSketch()

    const loops = layerLoops(layerId)
    expect(loops).toHaveLength(2) // REPLACED (append would give 3)
    expect(loops.every((l) => l.closed && l.type === 'contour')).toBe(true)
    // The stored document was updated to the modified version.
    const stored = container(layerId)!.sketches!.find((sk) => sk.layerId === layerId)!
    expect(stored.entities).toHaveLength(8)
    // Still exactly one layer — re-edit never spawns "Sketch 2".
    expect(container(layerId)!.layers2d).toHaveLength(1)
  })

  it('openSketchForLayer returns false for a layer without a stored sketch', () => {
    expect(useCamStore.getState().openSketchForLayer('nope')).toBe(false)
    expect(useCamStore.getState().viewer.mode).toBe('setup')
    expect(useCamStore.getState().activeSketch).toBeNull()
  })

  // NAV-SKETCH-TAB-SELECTION (GEO-UNIFY Stage 5): mode-tab entry with a
  // selection now routes through enterSketchWorkspace (store/index.ts),
  // not a bare setViewerMode('sketch') — the sketch part has exactly one
  // (sketch-editable) layer, so this is the 'direct' route, which reuses
  // openSketchForLayer and reopens the stored doc exactly as before. The
  // OLD geometry-granularity auto-reopen inside setViewerMode itself is
  // gone (see sketchTabDeadFallback.navSketchTabSelection.test.ts).
  it('mode-tab entry with the sketch part SELECTED reopens the stored doc', () => {
    const layerId = finishRectangleSketch()
    useCamStore.getState().setSelectedGeometry(container(layerId)!.id)
    useCamStore.getState().enterSketchWorkspace()
    const st = useCamStore.getState()
    expect(st.activeSketch).not.toBeNull()
    expect(st.activeSketch!.layerId).toBe(layerId)
    // WO SKC-49: re-entry now ALSO carries the three injected anchors alongside the four stored
    // rectangle entities (appended after them, so they never disturb the stored geometry's order).
    expect(st.activeSketch!.entities).toHaveLength(7)
    // No second layer was created by the entry.
    expect(container(layerId)!.layers2d).toHaveLength(1)
  })

  it('emptying a re-opened sketch and exiting keeps the layer and its loops', () => {
    const layerId = finishRectangleSketch()
    useCamStore.getState().openSketchForLayer(layerId)
    // Delete everything (one undo step), then exit without finishing.
    const ids = useCamStore.getState().activeSketch!.entities.map((e) => e.id)
    useCamStore.getState().setSketchSelection(ids)
    useCamStore.getState().deleteSketchSelection()
    // WO SKC-49: "everything" (ids grabbed all four, including the three injected anchors) still
    // leaves the three protected origin/axis anchors behind -- the delete guard refuses them by
    // name exactly like a real Ctrl+A/Delete gesture would. Only the user's own geometry is gone.
    expect(useCamStore.getState().activeSketch!.entities).toHaveLength(3)
    useCamStore.getState().setViewerMode('setup')
    // The layer owns baked loops — the empty-exit cleanup must NOT touch it.
    expect(layerLoops(layerId)).toHaveLength(1)
    expect(container(layerId)!.layers2d).toHaveLength(1)
    expect(useCamStore.getState().activeSketch).toBeNull()
  })
})

describe('bake guardrails', () => {
  it('an all-open-chain sketch bakes open loops (ops filter closed themselves)', () => {
    useCamStore.getState().setViewerMode('sketch')
    const layerId = useCamStore.getState().activeSketch!.layerId
    useCamStore.getState().addEntity(line('a', 0, 0, 10, 0))
    useCamStore.getState().addEntity(line('b', 10, 0, 10, 10))
    useCamStore.getState().addEntity(line('c', 40, 40, 50, 40)) // disjoint
    useCamStore.getState().finishSketch()
    const loops = layerLoops(layerId)
    expect(loops).toHaveLength(2)
    expect(loops.every((l) => l.type === 'open' && !l.closed)).toBe(true)
    // The exact closed-loop filter ops apply (e.g. NewOperationModal
    // counts g.loops.filter(l => l.closed)) yields zero — open loops ride
    // along for ops that accept them (engrave), nothing breaks.
    expect(loops.filter((l) => l.closed)).toHaveLength(0)
    expect(useCamStore.getState().sketchNotice).toContain('(0 closed)')
  })

  it('a solver-CONFLICTING sketch still bakes, with a warning in the notice', () => {
    useCamStore.getState().setViewerMode('sketch')
    const layerId = useCamStore.getState().activeSketch!.layerId
    useCamStore.getState().addEntity(line('b', 0, 0, 10, 0))
    useCamStore.getState().addEntity(line('r', 10, 0, 10, 10))
    useCamStore.getState().addEntity(line('t', 10, 10, 0, 10))
    useCamStore.getState().addEntity(line('l', 0, 10, 0, 0))
    // Simulate the solver reporting an over-defined document.
    useCamStore.setState({
      sketchSolveStatus: { dof: 0, conflicting: ['dim-1', 'dim-2'], redundant: [] },
    })
    useCamStore.getState().finishSketch()
    const loops = layerLoops(layerId)
    expect(loops).toHaveLength(1) // geometry is whatever it is — baked
    expect(loops[0].closed).toBe(true)
    const notice = useCamStore.getState().sketchNotice!
    expect(notice).toContain('Sketch baked to layer')
    expect(notice).toContain('conflicting')
    // The stored document carries the conflict state for the re-open UX.
    const stored = container(layerId)!.sketches!.find((sk) => sk.layerId === layerId)!
    expect(stored.solveStatus?.conflicting).toEqual(['dim-1', 'dim-2'])
  })
})
