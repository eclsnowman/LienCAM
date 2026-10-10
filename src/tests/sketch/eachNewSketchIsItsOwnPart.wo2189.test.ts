// WO-2189 (Operator, 2026-09-29): "I made a new sketch using the sketch tab, and it
// linked it under another sketch. How would I ever make multiple sketches that
// move independently?"
//
// EXPECTED: every "new sketch" entry creates a NEW sketch part (own id, own
// Position / Rotation) named after its sketch and holding that sketch's layer.
// Two new sketches = two parts; moving one leaves the other where it was.
// Finish / re-open / re-bake stay on that sketch's own part, and an aborted
// (empty) sketch leaves no part behind.
//
// Drives the REAL store actions (startNewSketch, setViewerMode('sketch'),
// addEntity, finishSketch, openSketchForLayer, updateGeometryTransform).

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import type { SketchEntity } from '../../lib/sketch/types'
import type { ImportedGeometry } from '../../types'

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
    sketchHistory: [],
  }))
})

function line(id: string, x0: number, y0: number, x1: number, y1: number): SketchEntity {
  return { id, kind: 'line', construction: false, start: { x: x0, y: y0 }, end: { x: x1, y: y1 } }
}

function addRect(p: string, x0: number, y0: number, x1: number, y1: number): void {
  const st = useCamStore.getState()
  st.addEntity(line(`${p}-b`, x0, y0, x1, y0))
  st.addEntity(line(`${p}-r`, x1, y0, x1, y1))
  st.addEntity(line(`${p}-t`, x1, y1, x0, y1))
  st.addEntity(line(`${p}-l`, x0, y1, x0, y0))
}

const geometry = (): ImportedGeometry[] => useCamStore.getState().project.geometry
const ownerOf = (layerId: string): ImportedGeometry | undefined =>
  geometry().find((g) => g.layers2d?.some((l) => l.id === layerId))

/** Sketch tab -> new sketch -> draw a rectangle -> finish. Returns the layer id. */
function drawNewSketch(p: string, x0: number, y0: number, x1: number, y1: number): string {
  useCamStore.getState().startNewSketch()
  const layerId = useCamStore.getState().activeSketch!.layerId
  addRect(p, x0, y0, x1, y1)
  useCamStore.getState().finishSketch()
  return layerId
}

describe('WO-2189: each new sketch is its own part', () => {
  it('two new sketches from the Sketch tab land in two separate parts', () => {
    const l1 = drawNewSketch('a', 0, 0, 10, 10)
    const l2 = drawNewSketch('b', 20, 0, 30, 10)

    const p1 = ownerOf(l1)!
    const p2 = ownerOf(l2)!
    expect(p1).toBeDefined()
    expect(p2).toBeDefined()
    expect(p1.id).not.toBe(p2.id)
    expect(geometry()).toHaveLength(2)

    // Each part is a sketch part named after its sketch, holding only its own layer.
    for (const [part, layerId] of [[p1, l1], [p2, l2]] as const) {
      expect(part.format).toBe('sketch')
      expect(part.layers2d!.map((l) => l.id)).toEqual([layerId])
      expect(part.name).toBe(part.layers2d![0].name)
      expect(part.loops!.length).toBeGreaterThan(0)
      expect(part.loops!.every((lp) => lp.layerId === layerId)).toBe(true)
      expect(part.sketches!.map((sk) => sk.ownerGeometryId)).toEqual([part.id])
    }
    expect(p1.name).toBe('Sketch 1')
    expect(p2.name).toBe('Sketch 2')
  })

  it('moving one sketch part leaves the other where it was', () => {
    const l1 = drawNewSketch('a', 0, 0, 10, 10)
    const l2 = drawNewSketch('b', 20, 0, 30, 10)
    const p1 = ownerOf(l1)!
    const p2Before = ownerOf(l2)!

    useCamStore.getState().updateGeometryTransform(p1.id, { x: 50, y: 25, z: 0 }, { x: 0, y: 0, z: 90 })

    const moved = ownerOf(l1)!
    const other = ownerOf(l2)!
    expect(moved.position).toEqual({ x: 50, y: 25, z: 0 })
    expect(moved.rotation).toEqual({ x: 0, y: 0, z: 90 })
    expect(other.id).toBe(p2Before.id)
    expect(other.position).toEqual(p2Before.position)
    expect(other.rotation).toEqual(p2Before.rotation)
  })

  it('the no-document Sketch-mode entry also makes a new part per sketch', () => {
    useCamStore.getState().setViewerMode('sketch')
    const l1 = useCamStore.getState().activeSketch!.layerId
    expect(useCamStore.getState().activeSketch!.ownerGeometryId).toBe(ownerOf(l1)!.id)
    addRect('a', 0, 0, 10, 10)
    useCamStore.getState().finishSketch()

    useCamStore.getState().setViewerMode('sketch')
    const l2 = useCamStore.getState().activeSketch!.layerId
    addRect('b', 0, 0, 5, 5)
    useCamStore.getState().finishSketch()

    expect(ownerOf(l1)!.id).not.toBe(ownerOf(l2)!.id)
    expect(geometry()).toHaveLength(2)
  })

  it('re-opening and re-baking a sketch stays on its own part', () => {
    const l1 = drawNewSketch('a', 0, 0, 10, 10)
    const l2 = drawNewSketch('b', 20, 0, 30, 10)
    const p1Id = ownerOf(l1)!.id
    const p2Loops = ownerOf(l2)!.loops

    expect(useCamStore.getState().openSketchForLayer(l1, p1Id)).toBe(true)
    addRect('c', 40, 40, 45, 45)
    useCamStore.getState().finishSketch()

    expect(geometry()).toHaveLength(2)
    expect(ownerOf(l1)!.id).toBe(p1Id)
    expect(ownerOf(l1)!.loops!.length).toBeGreaterThan(1)
    expect(ownerOf(l2)!.loops).toEqual(p2Loops)
  })

  it('an aborted (empty) new sketch leaves no part behind', () => {
    const l1 = drawNewSketch('a', 0, 0, 10, 10)
    useCamStore.getState().startNewSketch()
    expect(geometry()).toHaveLength(2)
    useCamStore.getState().finishSketch()

    expect(geometry()).toHaveLength(1)
    expect(geometry()[0].id).toBe(ownerOf(l1)!.id)
  })
})
