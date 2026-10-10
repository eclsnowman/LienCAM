// Edit-in-Sketch for imported layers (Stage 5) — headless store tests.
//
// Pins: openSketchForLayer on an imported DXF/SVG layer LIFTS its loops
// into a fresh parametric document; finishing bakes back onto the layer
// (loops replaced, sourceType -> 'sketch') and stores the document, so
// the next edit is a parametric re-edit of the stored sketch (chunk 1's
// reopen path). Guards: STL-projected layers (projectionPlane set, or any
// layer of an STL geometry) and locked layers refuse with a notice —
// never a silent no-op (ADR-0011 read-only rule).

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import type { ImportedGeometry, Loop2D } from '../../types'
import type { SketchBlockEntity } from '../../lib/sketch/types'

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
let persistPartialize: typeof import('../../store').persistPartialize

beforeAll(async () => {
  ;({ useCamStore, persistPartialize } = await import('../../store'))
})

const GEO_ID = 'dxf-geo'
const LAYER_ID = 'dxf-layer'

const FLAT_PLANE = {
  origin: { x: 0, y: 0, z: 0 },
  xAxis: { x: 1, y: 0, z: 0 },
  yAxis: { x: 0, y: 1, z: 0 },
  normal: { x: 0, y: 0, z: 1 },
}

/** 10x10 rectangle as a bare polyline (no segments[]) — the common DXF
 *  import shape. */
function rectLoop(): Loop2D {
  return {
    id: 'loop-rect', layerId: LAYER_ID, closed: true, type: 'contour',
    area: 100,
    points: [
      { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 },
    ],
  }
}

function makeImportedGeo(opts: {
  format?: ImportedGeometry['format']
  projected?: boolean
  locked?: boolean
} = {}): ImportedGeometry {
  return {
    id: GEO_ID,
    name: 'part.dxf',
    filename: 'part.dxf',
    type: 'curves_2d',
    format: opts.format ?? 'dxf',
    boundingBox: {
      min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 0 },
      size: { x: 10, y: 10, z: 0 }, center: { x: 5, y: 5, z: 0 },
    },
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    loaded: true,
    loops: [rectLoop()],
    layers2d: [{
      id: LAYER_ID, name: '0', color: '#00ff00', visible: true,
      ...(opts.projected ? { projectionPlane: FLAT_PLANE } : {}),
      ...(opts.locked ? { locked: true } : {}),
    }],
  }
}

function seed(geo: ImportedGeometry): void {
  useCamStore.setState((s) => ({
    activeSketch: null,
    sketchSolveStatus: null,
    sketchSelectedIds: [],
    sketchTool: 'select' as const,
    sketchToolChain: null,
    sketchConstructionMode: false,
    sketchNotice: null,
    lastNonSketchMode: 'setup' as const,
    viewer: { ...s.viewer, mode: 'setup' as const, selectedGeometryId: null },
    project: { ...s.project, geometry: [geo] },
    projectHistory: [],
    sketchHistory: [],
  }))
}

beforeEach(() => seed(makeImportedGeo()))

const geo = () =>
  useCamStore.getState().project.geometry.find((g) => g.id === GEO_ID)!
const layer = () => geo().layers2d!.find((l) => l.id === LAYER_ID)!
const layerLoops = () =>
  (geo().loops ?? []).filter((l) => l.layerId === LAYER_ID)

describe('Edit in Sketch: imported layer lift', () => {
  it('lifts the layer loops into ONE LOCKED BLOCK and enters sketch mode (SKC-BLOCKS Stage 3)', () => {
    const ok = useCamStore.getState().openSketchForLayer(LAYER_ID)
    expect(ok).toBe(true)
    const st = useCamStore.getState()
    expect(st.viewer.mode).toBe('sketch')
    expect(st.activeSketch).not.toBeNull()
    expect(st.activeSketch!.layerId).toBe(LAYER_ID)
    // The imported rectangle arrives as ONE rigid block (the 4 lines are its
    // members), NOT a sea of loose under-defined lines. Only the block is
    // user (non-construction) geometry; WO SKC-49's 3 injected anchors are
    // construction.
    const userLifted = st.activeSketch!.entities.filter((e) => !e.construction)
    expect(userLifted).toHaveLength(1)
    const block = userLifted[0] as SketchBlockEntity
    expect(block.kind).toBe('block')
    expect(block.members.entities).toHaveLength(4)
    expect(block.members.entities.every((e) => e.kind === 'line')).toBe(true)
    // The block is BORN LOCKED: a fix pins its origin, so the whole import is
    // fully-defined by construction (dof 0) rather than the blue under-defined
    // sea a loose lift produced.
    const originFix = st.activeSketch!.constraints.find(
      (c) => c.kind === 'fix' && c.point?.entityId === block.id && c.point?.site === 'origin',
    )
    expect(originFix).toBeDefined()
    // No document is stored until a bake happens.
    expect(geo().sketches ?? []).toHaveLength(0)
  })

  it('finish with no edits: loops preserved within epsilon, layer becomes sketch-driven', () => {
    useCamStore.getState().openSketchForLayer(LAYER_ID)
    useCamStore.getState().finishSketch()

    const loops = layerLoops()
    expect(loops).toHaveLength(1)
    expect(loops[0].closed).toBe(true)
    expect(loops[0].type).toBe('contour')
    expect(loops[0].area).toBeCloseTo(100, 6)
    expect(layer().sourceType).toBe('sketch')
    // Document stored on the IMPORTED geometry for parametric re-edit.
    expect(geo().sketches).toHaveLength(1)
    expect(geo().sketches![0].layerId).toBe(LAYER_ID)
    // Mode returned, document closed, history captured (undo can restore
    // the original import).
    const st = useCamStore.getState()
    expect(st.viewer.mode).toBe('setup')
    expect(st.activeSketch).toBeNull()
    expect(st.projectHistory.length).toBeGreaterThan(0)
  })

  it('subsequent edit reopens the STORED document (parametric re-edit)', () => {
    useCamStore.getState().openSketchForLayer(LAYER_ID)
    useCamStore.getState().finishSketch()
    const storedId = geo().sketches![0].id

    const ok = useCamStore.getState().openSketchForLayer(LAYER_ID)
    expect(ok).toBe(true)
    const st = useCamStore.getState()
    expect(st.activeSketch!.id).toBe(storedId)
    // Re-open carries the stored block (NOT a re-lift): 1 block + WO SKC-49's
    // 3 injected anchors. The block is not re-wrapped (no nested double-block).
    const reUser = st.activeSketch!.entities.filter((e) => !e.construction)
    expect(reUser).toHaveLength(1)
    expect(reUser[0].kind).toBe('block')
    // Finishing again still round-trips.
    useCamStore.getState().finishSketch()
    expect(layerLoops()).toHaveLength(1)
    expect(layerLoops()[0].area).toBeCloseTo(100, 6)
    expect(geo().sketches).toHaveLength(1)
  })

  it('persists imported provenance and marks only a real authored edit', () => {
    useCamStore.getState().openSketchForLayer(LAYER_ID)
    useCamStore.getState().finishSketch()

    expect(layer().sourceOrigin).toBe('import')
    expect(layer().sourceEdited).toBeUndefined()

    useCamStore.getState().openSketchForLayer(LAYER_ID)
    useCamStore.getState().addEntity({
      id: 'authored-line',
      kind: 'line',
      construction: false,
      start: { x: 20, y: 0 },
      end: { x: 25, y: 0 },
    })
    useCamStore.getState().finishSketch()

    expect(layer().sourceOrigin).toBe('import')
    expect(layer().sourceEdited).toBe(true)

    const persisted = JSON.parse(JSON.stringify(persistPartialize(useCamStore.getState())))
    const persistedLayer = persisted.project.geometry[0].layers2d[0]
    expect(persistedLayer.sourceOrigin).toBe('import')
    expect(persistedLayer.sourceEdited).toBe(true)
  })
})

describe('Edit in Sketch: guards (never silent)', () => {
  it('refuses STL-projected layers (projectionPlane set) with a notice', () => {
    seed(makeImportedGeo({ format: 'stl', projected: true }))
    const ok = useCamStore.getState().openSketchForLayer(LAYER_ID)
    expect(ok).toBe(false)
    const st = useCamStore.getState()
    expect(st.viewer.mode).toBe('setup')
    expect(st.activeSketch).toBeNull()
    expect(st.sketchNotice).toMatch(/read-only/i)
    expect(st.sketchNotice).toMatch(/ADR-0011/)
  })

  it('refuses any layer of an STL geometry even without a layer plane', () => {
    seed(makeImportedGeo({ format: 'stl' }))
    const ok = useCamStore.getState().openSketchForLayer(LAYER_ID)
    expect(ok).toBe(false)
    expect(useCamStore.getState().sketchNotice).toMatch(/read-only/i)
  })

  it('refuses locked layers with a notice', () => {
    seed(makeImportedGeo({ locked: true }))
    const ok = useCamStore.getState().openSketchForLayer(LAYER_ID)
    expect(ok).toBe(false)
    const st = useCamStore.getState()
    expect(st.viewer.mode).toBe('setup')
    expect(st.activeSketch).toBeNull()
    expect(st.sketchNotice).toMatch(/locked/i)
  })

  it('returns false for an unknown layer id', () => {
    expect(useCamStore.getState().openSketchForLayer('no-such-layer')).toBe(false)
  })
})
