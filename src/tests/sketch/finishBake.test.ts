// Finish Sketch UX + bake-on-exit (Stage 5, commit 3) — headless store
// tests for the SHARED bake path: finishSketch() (toolbox button) and
// setViewerMode() away from sketch both bake the active document onto its
// geometry layer, store the Sketch alongside for re-edit (PLAN D5), and
// surface feedback in the status notice. Verifies the baked layer is
// consumable by operations through the EXACT selection path ops use
// (project.geometry[].loops — zero operation-code changes).

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
    viewer: { ...s.viewer, mode: 'setup' as const },
    project: { ...s.project, geometry: [] },
    projectHistory: [],
    sketchHistory: [],
  }))
})

// WO-2189: every new sketch is its own part - find it through its layer's owner.
const sketchPart = (layerId: string) =>
  useCamStore.getState().project.geometry.find((g) => g.layers2d?.some((l) => l.id === layerId))
const partById = (id: string) =>
  useCamStore.getState().project.geometry.find((g) => g.id === id)

function line(id: string, x0: number, y0: number, x1: number, y1: number): SketchEntity {
  return { id, kind: 'line', construction: false, start: { x: x0, y: y0 }, end: { x: x1, y: y1 } }
}

/** Enter sketch mode and place a closed 10x10 rectangle (4 chained lines). */
function drawRectangleSketch(): string {
  const s = useCamStore.getState()
  s.setViewerMode('sketch')
  const layerId = useCamStore.getState().activeSketch!.layerId
  useCamStore.getState().addEntity(line('b', 0, 0, 10, 0))
  useCamStore.getState().addEntity(line('r', 10, 0, 10, 10))
  useCamStore.getState().addEntity(line('t', 10, 10, 0, 10))
  useCamStore.getState().addEntity(line('l', 0, 10, 0, 0))
  return layerId
}

describe('finishSketch', () => {
  it('bakes to the layer, stores the document, exits to the previous mode', () => {
    useCamStore.getState().setViewerMode('toolpath') // previous non-sketch mode
    const layerId = drawRectangleSketch()
    useCamStore.getState().finishSketch()

    const st = useCamStore.getState()
    expect(st.viewer.mode).toBe('toolpath')
    expect(st.activeSketch).toBeNull()

    const geo = sketchPart(layerId)!
    const loops = (geo.loops ?? []).filter((l) => l.layerId === layerId)
    expect(loops).toHaveLength(1)
    expect(loops[0].closed).toBe(true)
    expect(loops[0].type).toBe('contour')
    expect(loops[0].area).toBeCloseTo(100, 6)
    // Document stored alongside the layer for re-edit (PLAN D5).
    const stored = geo.sketches?.find((sk) => sk.layerId === layerId)
    expect(stored).toBeDefined()
    expect(stored!.entities).toHaveLength(4)
    // Status feedback names the layer and the loop counts.
    expect(st.sketchNotice).toContain('Sketch baked to layer')
    expect(st.sketchNotice).toContain('1 loop')
    expect(st.sketchNotice).toContain('(1 closed)')
  })

  it('finishing an EMPTY sketch discards the auto-created layer (no junk)', () => {
    useCamStore.getState().setViewerMode('sketch')
    const partId = sketchPart(useCamStore.getState().activeSketch!.layerId)!.id
    expect(partById(partId)).toBeDefined()
    useCamStore.getState().finishSketch()
    const st = useCamStore.getState()
    expect(st.viewer.mode).toBe('setup')
    expect(st.activeSketch).toBeNull()
    expect(partById(partId)).toBeUndefined()
  })

  it('baked loops are consumable by ops with zero op-code changes', () => {
    // Operations resolve geometry as project.geometry.find(g => g.id ===
    // params.geometryId) then read g.loops (computeOperationToolpath), and
    // the operation modal lists project.geometry.filter(g => g.loops?.length)
    // — assert the baked container satisfies exactly that path.
    const layerId = drawRectangleSketch()
    useCamStore.getState().finishSketch()
    const { geometry } = useCamStore.getState().project
    const pickable = geometry.filter((g) => g.loops && g.loops.length > 0)
    expect(pickable).toHaveLength(1)
    expect(pickable[0].format).toBe('sketch')
    const closed = pickable[0].loops!.filter((l) => l.closed)
    expect(closed).toHaveLength(1)
    expect(closed[0].layerId).toBe(layerId)
    expect(closed[0].points.length).toBeGreaterThanOrEqual(4)
  })
})

describe('bake on mode switch (top tabs)', () => {
  it('switching modes with a non-empty sketch takes the SAME bake path', () => {
    const layerId = drawRectangleSketch()
    useCamStore.getState().setViewerMode('simulation')
    const st = useCamStore.getState()
    expect(st.viewer.mode).toBe('simulation')
    expect(st.activeSketch).toBeNull()
    const geo = sketchPart(layerId)!
    const loops = (geo.loops ?? []).filter((l) => l.layerId === layerId)
    expect(loops).toHaveLength(1)
    expect(loops[0].type).toBe('contour')
    expect(geo.sketches?.some((sk) => sk.layerId === layerId)).toBe(true)
    expect(st.sketchNotice).toContain('Sketch baked to layer')
  })

  it('a second bake REPLACES the layer loops, not appends', () => {
    const layerId = drawRectangleSketch()
    useCamStore.getState().finishSketch()
    const firstLoops = (sketchPart(layerId)!.loops ?? []).filter((l) => l.layerId === layerId)
    expect(firstLoops).toHaveLength(1)

    // Re-activate the STORED document (manual re-open; the UI entry path
    // lands in commit 4), add a second disjoint rectangle, finish again.
    const stored = sketchPart(layerId)!.sketches!.find((sk) => sk.layerId === layerId)!
    useCamStore.getState().setActiveSketch(stored)
    useCamStore.getState().setViewerMode('sketch')
    useCamStore.getState().addEntity(line('b2', 20, 0, 30, 0))
    useCamStore.getState().addEntity(line('r2', 30, 0, 30, 10))
    useCamStore.getState().addEntity(line('t2', 30, 10, 20, 10))
    useCamStore.getState().addEntity(line('l2', 20, 10, 20, 0))
    useCamStore.getState().finishSketch()

    const loops = (sketchPart(layerId)!.loops ?? []).filter((l) => l.layerId === layerId)
    expect(loops).toHaveLength(2) // replaced: 1 old rect would make 3
    expect(loops.every((l) => l.closed && l.type === 'contour')).toBe(true)
  })

  it('bake pushes history first: undo rewinds the bake', () => {
    const layerId = drawRectangleSketch()
    useCamStore.getState().finishSketch()
    expect((sketchPart(layerId)!.loops ?? []).filter((l) => l.layerId === layerId)).toHaveLength(1)
    const partId = sketchPart(layerId)!.id
    useCamStore.getState().undo()
    const geo = partById(partId)
    expect((geo?.loops ?? []).filter((l) => l.layerId === layerId)).toHaveLength(0)
  })
})
