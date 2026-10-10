// WO-1377 — bakeActiveSketch must write to the geometry the active sketch
// was actually opened from, never "whichever geometry's layers2d happens to
// contain a matching layer id, first". Two separately imported SVGs can both
// produce layer id "color-0" (Codex audit BUG-529): opening and finishing
// the SECOND one's sketch used to silently overwrite the FIRST geometry's
// loops instead, because bakeActiveSketch re-resolved the destination by a
// first-match-by-layerId search of its own, ignoring which geometry
// openSketchForLayer had actually opened.

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
    sketchTool: 'select' as const,
    sketchToolChain: null,
    sketchConstructionMode: false,
    sketchNotice: null,
    lastNonSketchMode: 'setup' as const,
    viewer: { ...s.viewer, mode: 'setup' as const, selectedGeometryId: null },
    // stocks: [] too — a non-empty stock list re-derives membership over ALL
    // geometry on every bake (assignStocks), which would touch the untouched
    // geometry's object identity for a reason unrelated to this bug.
    project: { ...s.project, geometry: [], stocks: [] },
    projectHistory: [],
    sketchHistory: [],
  }))
})

const BBOX = {
  min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 0 },
  size: { x: 10, y: 10, z: 0 }, center: { x: 5, y: 5, z: 0 },
}

function svgGeo(partial: Partial<ImportedGeometry>): ImportedGeometry {
  return {
    id: 'g', name: 'g', filename: 'g.svg', type: 'curves_2d', format: 'svg',
    boundingBox: BBOX,
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
    loaded: true,
    ...partial,
  }
}

function line(id: string, x0: number, y0: number, x1: number, y1: number): SketchEntity {
  return { id, kind: 'line', construction: false, start: { x: x0, y: y0 }, end: { x: x1, y: y1 } }
}

describe('bakeActiveSketch owns its geometry (WO-1377)', () => {
  it('finishing the SECOND geometry\'s sketch never overwrites the first, even though both share layer id "color-0"', () => {
    const firstImport = svgGeo({
      id: 'import-1', name: 'first.svg',
      loops: [{
        id: 'first-loop', layerId: 'color-0', closed: true, type: 'contour', area: 100,
        points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
      }],
      layers2d: [{ id: 'color-0', name: 'color-0', color: '#fff', visible: true, sourceOrigin: 'import' }],
    })
    const secondImport = svgGeo({
      id: 'import-2', name: 'second.svg',
      loops: [],
      layers2d: [{ id: 'color-0', name: 'color-0', color: '#fff', visible: true, sourceOrigin: 'import' }],
    })
    useCamStore.setState((s) => ({
      project: { ...s.project, geometry: [firstImport, secondImport] },
    }))

    // Open the SECOND geometry's sketch. geoId disambiguates the shared
    // layer id at open time — this is the real UI entry point (a click on
    // a specific part's layer), not a bare layerId lookup.
    const ok = useCamStore.getState().openSketchForLayer('color-0', 'import-2')
    expect(ok).toBe(true)
    const opened = useCamStore.getState().activeSketch!
    expect(opened.layerId).toBe('color-0')
    expect(opened.ownerGeometryId).toBe('import-2')

    // Draw and finish — a real, observable change to the SECOND geometry only.
    useCamStore.getState().addEntity(line('b', 20, 20, 30, 20))
    useCamStore.getState().addEntity(line('r', 30, 20, 30, 30))
    useCamStore.getState().addEntity(line('t', 30, 30, 20, 30))
    useCamStore.getState().addEntity(line('l', 20, 30, 20, 20))
    useCamStore.getState().finishSketch()

    const { geometry } = useCamStore.getState().project
    const first = geometry.find((g) => g.id === 'import-1')!
    const second = geometry.find((g) => g.id === 'import-2')!

    // The first geometry is byte-for-byte unchanged: same object identity,
    // its loop untouched, and it never gained a stored sketch document.
    expect(first).toBe(firstImport)
    expect(first.loops).toEqual([firstImport.loops![0]])
    expect(first.sketches ?? []).toHaveLength(0)

    // The second geometry took the bake.
    const secondLoops = (second.loops ?? []).filter((l) => l.layerId === 'color-0')
    expect(secondLoops).toHaveLength(1)
    expect(secondLoops[0].closed).toBe(true)
    expect(second.sketches?.some((sk) => sk.layerId === 'color-0')).toBe(true)
  })
})
