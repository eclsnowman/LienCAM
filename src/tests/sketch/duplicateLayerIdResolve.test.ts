// Regression: edit-sketch / the entry chooser opened the WRONG part when two
// parts share a layerId. DXF layer ids ARE the layer NAME (dxfImporter), so
// re-importing the same file gives both parts a layer with id "Holes"; the
// old openSketchForLayer(layerId) did geometry.find(...) and always returned
// the FIRST import (Operator ruling 2026-06-13: "always goes to the first copy"). The fix
// threads the owning geoId so the user opens the part they clicked.

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

beforeAll(async () => {
  ;({ useCamStore } = await import('../../store'))
})

// Both parts carry a layer with the SAME id — the DXF-import collision.
const SHARED_LAYER_ID = 'Holes'
const GEO_A = 'dxf-geo-a'
const GEO_B = 'dxf-geo-b'

/** Closed polyline with `n` distinct corners -> n lifted line entities, so
 *  the entity count tells us WHICH part's loops were lifted. */
function polyLoop(n: number): Loop2D {
  const pts = Array.from({ length: n }, (_, i) => {
    const a = (2 * Math.PI * i) / n
    return { x: 10 * Math.cos(a), y: 10 * Math.sin(a) }
  })
  return { id: `loop-${n}-${crypto.randomUUID()}`, layerId: SHARED_LAYER_ID, closed: true, type: 'contour', area: 100, points: pts }
}

function makeGeo(id: string, corners: number): ImportedGeometry {
  return {
    id,
    name: 'Leadscrew_Stepper_Mount',   // duplicate names, like Operator's repro
    filename: 'Leadscrew_Stepper_Mount.dxf',
    type: 'curves_2d',
    format: 'dxf',
    boundingBox: {
      min: { x: -10, y: -10, z: 0 }, max: { x: 10, y: 10, z: 0 },
      size: { x: 20, y: 20, z: 0 }, center: { x: 0, y: 0, z: 0 },
    },
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    loaded: true,
    loops: [polyLoop(corners)],
    layers2d: [{ id: SHARED_LAYER_ID, name: 'Holes', color: '#00ff00', visible: true }],
  }
}

function seedTwoParts(): void {
  // Part A = triangle (3 entities), Part B = pentagon (5 entities).
  useCamStore.setState((s) => ({
    activeSketch: null,
    sketchSolveStatus: null,
    sketchNotice: null,
    lastNonSketchMode: 'setup' as const,
    viewer: { ...s.viewer, mode: 'setup' as const, selectedGeometryId: null },
    project: { ...s.project, geometry: [makeGeo(GEO_A, 3), makeGeo(GEO_B, 5)] },
    projectHistory: [],
    sketchHistory: [],
  }))
}

beforeEach(seedTwoParts)

/** The imported layer arrives as ONE locked block (SKC-BLOCKS Stage 3); the
 *  block's MEMBER count tells us WHICH part's loops were lifted (triangle -> 3,
 *  pentagon -> 5) now that both parts collapse to a single top-level entity. */
function liftedBlockMemberCount(): number {
  const block = useCamStore.getState().activeSketch!.entities
    .find((e): e is SketchBlockEntity => e.kind === 'block')
  expect(block).toBeDefined()
  return block!.members.entities.length
}

describe('openSketchForLayer: shared layerId resolves by owning geoId', () => {
  it('opens the SECOND part when its geoId is passed (not the first match)', () => {
    const ok = useCamStore.getState().openSketchForLayer(SHARED_LAYER_ID, GEO_B)
    expect(ok).toBe(true)
    const st = useCamStore.getState()
    expect(st.viewer.mode).toBe('sketch')
    // Pentagon -> a block of 5 member lines. If it had wrongly resolved to part
    // A (triangle) the block would hold 3.
    expect(liftedBlockMemberCount()).toBe(5)
  })

  it('opens the FIRST part when its geoId is passed', () => {
    const ok = useCamStore.getState().openSketchForLayer(SHARED_LAYER_ID, GEO_A)
    expect(ok).toBe(true)
    // Triangle -> a block of 3 member lines.
    expect(liftedBlockMemberCount()).toBe(3)
  })

  it('without geoId falls back to first-match (legacy behavior preserved)', () => {
    const ok = useCamStore.getState().openSketchForLayer(SHARED_LAYER_ID)
    expect(ok).toBe(true)
    expect(liftedBlockMemberCount()).toBe(3)
  })
})
