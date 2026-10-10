// WO-1436 (BUG-482): reopening a sketch that already has baked content, deleting
// everything, and leaving must COMMIT the empty result. Before the fix the
// empty-content guard in bakeActiveSketch returned with no write, so the layer
// kept its old loops and stored document and reopening resurrected the
// geometry the operator had just deleted. A fresh sketch abandoned without
// content still writes nothing (finishBake.test.ts owns that case too).

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import type { SketchEntity } from '../../lib/sketch/types'
import { stripSketchAnchors, isInjectedSketchAnchorId } from '../../lib/sketch/sketchAnchors'

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
    sketchEntrySnapshot: null,
    lastNonSketchMode: 'setup' as const,
    viewer: { ...s.viewer, mode: 'setup' as const, selectedGeometryId: null },
    project: { ...s.project, geometry: [] },
    projectHistory: [],
    projectFuture: [],
    sketchHistory: [],
  }))
})

// WO-2189: every new sketch is its own part - find it through its layer's owner.
const container = (layerId: string) =>
  useCamStore.getState().project.geometry.find((g) => g.layers2d?.some((l) => l.id === layerId))
const layerLoops = (layerId: string) =>
  (container(layerId)?.loops ?? []).filter((l) => l.layerId === layerId)
const storedDoc = (layerId: string) =>
  container(layerId)?.sketches?.find((sk) => sk.layerId === layerId)

function line(id: string, x0: number, y0: number, x1: number, y1: number): SketchEntity {
  return { id, kind: 'line', construction: false, start: { x: x0, y: y0 }, end: { x: x1, y: y1 } }
}

/** Draw and Finish a closed 10x10 rectangle; returns its layer id. */
function bakeRectangle(): string {
  useCamStore.getState().setViewerMode('sketch')
  const layerId = useCamStore.getState().activeSketch!.layerId
  useCamStore.getState().addEntity(line('b', 0, 0, 10, 0))
  useCamStore.getState().addEntity(line('r', 10, 0, 10, 10))
  useCamStore.getState().addEntity(line('t', 10, 10, 0, 10))
  useCamStore.getState().addEntity(line('l', 0, 10, 0, 0))
  useCamStore.getState().finishSketch()
  return layerId
}

/** Reopen the stored sketch and delete every user entity (Select all + Delete). */
function reopenAndDeleteEverything(layerId: string): void {
  expect(useCamStore.getState().openSketchForLayer(layerId, container(layerId)!.id)).toBe(true)
  const ids = useCamStore.getState().activeSketch!.entities
    .map((e) => e.id)
    .filter((id) => !isInjectedSketchAnchorId(id))
  expect(ids.length).toBeGreaterThan(0)
  useCamStore.getState().deleteSketchItems(ids)
  const live = stripSketchAnchors(useCamStore.getState().activeSketch!)
  expect(live.entities).toHaveLength(0)
}

describe('WO-1436: a deliberately cleared existing sketch commits the empty result', () => {
  it('Finish removes the old loops and stores the empty document; reopening shows nothing', () => {
    const layerId = bakeRectangle()
    expect(layerLoops(layerId)).toHaveLength(1)
    expect(storedDoc(layerId)!.entities).toHaveLength(4)

    reopenAndDeleteEverything(layerId)
    useCamStore.getState().finishSketch()

    const st = useCamStore.getState()
    expect(st.activeSketch).toBeNull()
    expect(st.viewer.mode).toBe('setup')
    expect(layerLoops(layerId)).toHaveLength(0)
    // The layer itself stays (clearing content is not deleting the layer).
    expect(container(layerId)!.layers2d!.some((l) => l.id === layerId)).toBe(true)
    const doc = storedDoc(layerId)!
    expect(doc.entities).toHaveLength(0)
    expect(doc.dimensions).toHaveLength(0)
    expect(doc.constraints).toHaveLength(0)
    expect(st.sketchNotice).toContain('cleared')

    // Reopen: the deleted rectangle does not come back.
    expect(useCamStore.getState().openSketchForLayer(layerId, container(layerId)!.id)).toBe(true)
    expect(stripSketchAnchors(useCamStore.getState().activeSketch!).entities).toHaveLength(0)
  })

  it('undo after clearing brings the rectangle back (the clear is one history step)', () => {
    const layerId = bakeRectangle()
    reopenAndDeleteEverything(layerId)
    useCamStore.getState().finishSketch()
    expect(layerLoops(layerId)).toHaveLength(0)

    useCamStore.getState().undo()
    expect(layerLoops(layerId)).toHaveLength(1)
    expect(storedDoc(layerId)!.entities).toHaveLength(4)
  })

  it('a fresh never-drawn sketch still writes nothing and leaves no layer or document', () => {
    useCamStore.getState().setViewerMode('sketch')
    const partId = container(useCamStore.getState().activeSketch!.layerId)!.id
    const historyBefore = useCamStore.getState().projectHistory.length
    useCamStore.getState().finishSketch()

    const st = useCamStore.getState()
    expect(st.activeSketch).toBeNull()
    expect(st.project.geometry.find((g) => g.id === partId)).toBeUndefined()
    expect(st.projectHistory.length).toBe(historyBefore)
  })
})
