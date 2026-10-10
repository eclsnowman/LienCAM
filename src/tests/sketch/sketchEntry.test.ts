// Sketch-mode entry regressions.
//
// Stage 3 fix pinned: entering sketch mode (or clicking with an armed tool)
// with NO active sketch must never silently no-op (activeSketch null made
// every tool click a silent drop).
//
// Stage 5 extends entry: a fresh sketch is born owning a REAL "Sketch N"
// Layer2D on its own sketch part (visible in the GEOMETRY panel while
// sketching), and leaving sketch mode with a completely EMPTY sketch removes
// the auto-created layer + document again (no junk).
//
// The store talks to a solver Worker and zustand persist storage; both
// are stubbed before the store module is imported (node test env).

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'

class StubWorker {
  onmessage: ((e: unknown) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  postMessage(): void {}
  terminate(): void {}
}
vi.stubGlobal('Worker', StubWorker)
const storageStub = {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
}
vi.stubGlobal('localStorage', storageStub)

let useCamStore: typeof import('../../store').useCamStore
// The armed tool / chain / construction mode now live in the sketcher package
// (WO SKC-14B). Import it dynamically alongside the store so the store's
// module-load doc-sink binding is in place before any tool action runs.
let sketcherTools: typeof import('../../lib/sketch/sketcher').sketcherTools
let sketcherToolStore: typeof import('../../lib/sketch/sketcher').sketcherToolStore
// WO SKC-49 (Operator Q-35): CAM now injects the same origin+axis anchors the workbench already had
// (setActiveSketch, camSketchDocumentPort.ensureSketch) -- every "fresh sketch is empty" assertion
// in this file predates that and must count the three anchors explicitly instead.
let SKETCH_INJECTED_ENTITY_IDS: ReadonlySet<string>

beforeAll(async () => {
  ;({ useCamStore } = await import('../../store'))
  ;({ sketcherTools, sketcherToolStore } = await import('../../lib/sketch/sketcher'))
  ;({ SKETCH_INJECTED_ENTITY_IDS } = await import('../../lib/sketch/sketchAnchors'))
})

function userEntities(sketch: { entities: readonly import('../../lib/sketch/types').SketchEntity[] }) {
  return sketch.entities.filter((e) => !SKETCH_INJECTED_ENTITY_IDS.has(e.id))
}

beforeEach(() => {
  useCamStore.setState((s) => ({
    activeSketch: null,
    sketchSolveStatus: null,
    sketchSelectedIds: [],
    viewer: { ...s.viewer, mode: 'setup' },
    // Tests share one store module — reset geometry so layer numbering and
    // sketch-part assertions start clean every test.
    project: { ...s.project, geometry: [] },
  }))
  // Tool state lives in the package now: reset the armed tool / chain / mode.
  sketcherToolStore.setState({ tool: 'select', chain: null, constructionMode: false })
})

// WO-2189: every new sketch is its own part - find it through its layer's owner.
const sketchPart = (layerId: string) =>
  useCamStore.getState().project.geometry.find((g) => g.layers2d?.some((l) => l.id === layerId))
const activeLayerId = () => useCamStore.getState().activeSketch!.layerId

describe('sketch-mode entry with no document', () => {
  it('setViewerMode(sketch) auto-creates a blank sketch', () => {
    const s = useCamStore.getState()
    expect(s.activeSketch).toBeNull()
    s.setViewerMode('sketch')
    const after = useCamStore.getState()
    expect(after.viewer.mode).toBe('sketch')
    expect(after.activeSketch).not.toBeNull()
    // A "blank" sketch now owns exactly the three injected anchors (origin + both axes) and
    // nothing else -- no USER geometry, which is what "blank" actually means post-SKC-49.
    expect(userEntities(after.activeSketch!)).toHaveLength(0)
    expect(after.activeSketch!.entities).toHaveLength(3)
    expect(after.activeSketch!.entities.every((e) => SKETCH_INJECTED_ENTITY_IDS.has(e.id))).toBe(true)
    expect(after.activeSketch!.constraints).toHaveLength(3)
    expect(after.activeSketch!.dimensions).toHaveLength(0)
  })

  it('entry creates a REAL "Sketch 1" layer on its own "Sketch 1" part', () => {
    useCamStore.getState().setViewerMode('sketch')
    const geo = sketchPart(activeLayerId())
    expect(geo).toBeDefined()
    expect(geo!.format).toBe('sketch')
    expect(geo!.name).toBe('Sketch 1')
    expect(useCamStore.getState().activeSketch!.ownerGeometryId).toBe(geo!.id)
    expect(geo!.layers2d).toHaveLength(1)
    const layer = geo!.layers2d![0]
    expect(layer.name).toBe('Sketch 1')
    expect(layer.sourceType).toBe('sketch')
    expect(layer.visible).toBe(true)
    // The document is born owning that layer — no placeholder ids.
    expect(useCamStore.getState().activeSketch!.layerId).toBe(layer.id)
  })

  it('layer naming picks the first free "Sketch N" number', () => {
    // Occupy "Sketch 1" with a foreign layer to force "Sketch 2".
    useCamStore.setState((s) => ({
      project: {
        ...s.project,
        geometry: [{
          id: 'dxf-1', name: 'part', filename: 'part.dxf', type: 'curves_2d' as const,
          format: 'dxf' as const, loaded: true,
          boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 },
            size: { x: 0, y: 0, z: 0 }, center: { x: 0, y: 0, z: 0 } },
          position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
          loops: [], layers2d: [{ id: 'l1', name: 'Sketch 1', color: '#fff', visible: true }],
        }],
      },
    }))
    useCamStore.getState().setViewerMode('sketch')
    const geo = sketchPart(activeLayerId())
    expect(geo!.layers2d![0].name).toBe('Sketch 2')
  })

  it('leaving sketch mode with an EMPTY sketch removes the layer + document', () => {
    useCamStore.getState().setViewerMode('sketch')
    const partId = sketchPart(activeLayerId())!.id
    useCamStore.getState().setViewerMode('setup')
    const after = useCamStore.getState()
    expect(after.activeSketch).toBeNull()
    // Sketch part removed entirely once its last layer goes — no junk.
    expect(after.project.geometry.find((g) => g.id === partId)).toBeUndefined()
  })

  it('leaving sketch mode with a NON-empty document bakes and closes it', () => {
    useCamStore.getState().setViewerMode('sketch')
    const layerId = useCamStore.getState().activeSketch!.layerId
    sketcherTools.armTool('point')
    sketcherTools.click({ x: 5, y: 7 }, 0.5, null, false)
    useCamStore.getState().setViewerMode('setup')
    const after = useCamStore.getState()
    // Finish/exit both bake (PLAN 3.1): the document is closed, its layer
    // survives, and the stored document remains for re-edit. A bare point
    // bakes zero loops — surfaced in the notice, never silently dropped.
    expect(after.activeSketch).toBeNull()
    const geo = sketchPart(layerId)!
    expect(geo.layers2d).toHaveLength(1)
    expect(geo.sketches?.some((sk) => sk.layerId === layerId)).toBe(true)
    expect(after.sketchNotice).toMatch(/no bakeable geometry/)
  })

  it('tool click with no active sketch creates one and commits (no silent drop)', () => {
    const s = useCamStore.getState()
    expect(s.activeSketch).toBeNull()
    sketcherTools.armTool('line')
    // First click anchors the chain — in a freshly auto-created sketch.
    sketcherTools.click({ x: 0, y: 0 }, 0.5, null, false)
    const mid = useCamStore.getState()
    expect(mid.activeSketch).not.toBeNull()
    expect(sketcherToolStore.getState().tool).toBe('line') // armed tool survives the auto-create
    expect(sketcherToolStore.getState().chain?.kind).toBe('line')
    // The click-fallback creates a real layer as well.
    const part = sketchPart(mid.activeSketch!.layerId)!
    expect(part.format).toBe('sketch')
    expect(part.layers2d!.map((l) => l.id)).toEqual([mid.activeSketch!.layerId])
    expect(mid.activeSketch!.ownerGeometryId).toBe(part.id)
    // Second click commits the first segment.
    sketcherTools.click({ x: 40, y: 0 }, 0.5, null, false)
    const after = useCamStore.getState()
    const drawn = userEntities(after.activeSketch!)
    expect(drawn).toHaveLength(1)
    expect(drawn[0].kind).toBe('line')
  })

  it('point tool click with no sketch places a point', () => {
    sketcherTools.armTool('point')
    sketcherTools.click({ x: 5, y: 7 }, 0.5, null, false)
    const after = useCamStore.getState()
    const drawn = userEntities(after.activeSketch!)
    expect(drawn).toHaveLength(1)
    expect(drawn[0].kind).toBe('point')
  })
})
