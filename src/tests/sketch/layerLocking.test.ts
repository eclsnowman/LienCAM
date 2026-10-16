// Layer locking + blank-layer creation (Stage 6).
//
// Locking scope (the honest contract): a locked layer refuses SKETCH
// EDITING (openSketchForLayer guard + entry-chooser disable); visibility
// and color stay free; project/use may still consume it read-only
// (covered in projectUse.test.ts). The padlock toggle persists on
// Layer2D.locked via updateGeometryLayer.
//
// Blank layers: createSketchLayer (the Geometry-panel "New empty layer"
// button) creates an empty Layer2D in the sketches container for ANY
// project state; the layer is immediately sketchable from the entry
// chooser.
//
// Store-import stubs: same pattern as sketchEntry.test.ts.

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { listSketchEntryCandidates } from '../../lib/sketch/entryChooser'
import type { ImportedGeometry, Loop2D } from '../../types'

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

const rectLoop = (layerId: string): Loop2D => ({
  id: 'loop-rect',
  points: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 10 }, { x: 0, y: 10 }],
  closed: true,
  type: 'contour',
  layerId,
  area: 200,
})

function dxfGeo(locked: boolean): ImportedGeometry {
  return {
    id: 'dxf-1', name: 'part', filename: 'part.dxf', type: 'curves_2d',
    format: 'dxf', loaded: true,
    boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 },
      size: { x: 0, y: 0, z: 0 }, center: { x: 0, y: 0, z: 0 } },
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
    loops: [rectLoop('l1')],
    layers2d: [{ id: 'l1', name: 'Outline', color: '#fff', visible: true, locked }],
  }
}

beforeEach(() => {
  useCamStore.setState((s) => ({
    activeSketch: null,
    sketchSolveStatus: null,
    sketchSelectedIds: [],
    sketchTool: 'select',
    sketchToolChain: null,
    sketchNotice: null,
    viewer: { ...s.viewer, mode: 'setup' },
    project: { ...s.project, geometry: [] },
  }))
})

describe('layer locking', () => {
  it('the locked predicate blocks the edit path with a notice', () => {
    useCamStore.setState((s) => ({
      project: { ...s.project, geometry: [dxfGeo(true)] },
    }))
    const ok = useCamStore.getState().openSketchForLayer('l1')
    expect(ok).toBe(false)
    const after = useCamStore.getState()
    expect(after.activeSketch).toBeNull()
    expect(after.viewer.mode).toBe('setup')
    expect(after.sketchNotice).toMatch(/locked/)
  })

  it('updateGeometryLayer persists the padlock toggle both ways', () => {
    useCamStore.setState((s) => ({
      project: { ...s.project, geometry: [dxfGeo(false)] },
    }))
    const layer = () =>
      useCamStore.getState().project.geometry[0].layers2d![0]
    expect(layer().locked).toBe(false)

    useCamStore.getState().updateGeometryLayer('dxf-1', 'l1', { locked: true })
    expect(layer().locked).toBe(true)
    // WO-2854 (the operator 10-15 "If not why is it in there?"): a locked layer cannot
    // be opened, so the entry chooser no longer lists it.
    const candidate = listSketchEntryCandidates(
      useCamStore.getState().project.geometry
    ).find((c) => c.layerId === 'l1')
    expect(candidate).toBeUndefined()

    useCamStore.getState().updateGeometryLayer('dxf-1', 'l1', { locked: false })
    expect(layer().locked).toBe(false)
    expect(useCamStore.getState().openSketchForLayer('l1')).toBe(true)
  })

  it('locking only blocks sketch editing: visibility and color stay free', () => {
    useCamStore.setState((s) => ({
      project: { ...s.project, geometry: [dxfGeo(true)] },
    }))
    useCamStore.getState().toggleGeometryLayer('dxf-1', 'l1')
    useCamStore.getState().updateGeometryLayer('dxf-1', 'l1', { color: '#123456' })
    const layer = useCamStore.getState().project.geometry[0].layers2d![0]
    expect(layer.visible).toBe(false)
    expect(layer.color).toBe('#123456')
    expect(layer.locked).toBe(true) // untouched by either edit
  })
})

describe('blank layer creation', () => {
  it('createSketchLayer creates an empty layer on its own new sketch part for an empty project', () => {
    expect(useCamStore.getState().project.geometry).toHaveLength(0)
    const layer = useCamStore.getState().createSketchLayer()
    // WO-2189: the layer's owner is a new sketch part named after it.
    const container = useCamStore.getState().project.geometry
      .find((g) => g.layers2d?.some((l) => l.id === layer.id))!
    expect(container).toBeDefined()
    expect(container.format).toBe('sketch')
    expect(container.name).toBe('Sketch 1')
    expect(useCamStore.getState().project.geometry).toHaveLength(1)
    expect(container.layers2d).toHaveLength(1)
    expect(container.layers2d![0].id).toBe(layer.id)
    expect(layer.name).toBe('Sketch 1')
    expect(layer.sourceType).toBe('sketch')
    // Empty: the container owns no loops for it.
    expect((container.loops ?? []).filter((lp) => lp.layerId === layer.id))
      .toHaveLength(0)
  })

  it('a blank layer is sketchable from the entry chooser', () => {
    const layer = useCamStore.getState().createSketchLayer()
    const candidate = listSketchEntryCandidates(
      useCamStore.getState().project.geometry
    ).find((c) => c.layerId === layer.id)!
    expect(candidate).toBeDefined()
    expect(candidate.disabledReason).toBeNull()
    expect(candidate.loopCount).toBe(0)
    // And actually opens: an empty parametric document on that layer.
    expect(useCamStore.getState().openSketchForLayer(layer.id)).toBe(true)
    const after = useCamStore.getState()
    expect(after.viewer.mode).toBe('sketch')
    expect(after.activeSketch!.layerId).toBe(layer.id)
    // WO SKC-49: an empty parametric document now owns exactly the three injected origin/axis
    // anchors and no USER geometry -- see sketchEntry.test.ts's own "blank" assertion.
    expect(after.activeSketch!.entities).toHaveLength(3)
  })

  it('works alongside existing geometry (any project state)', () => {
    useCamStore.setState((s) => ({
      project: { ...s.project, geometry: [dxfGeo(false)] },
    }))
    const layer = useCamStore.getState().createSketchLayer()
    expect(useCamStore.getState().project.geometry).toHaveLength(2)
    expect(layer.name).toBe('Sketch 1')
  })
})
