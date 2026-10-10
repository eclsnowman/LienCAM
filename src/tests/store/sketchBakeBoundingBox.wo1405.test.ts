// WO-1405: a sketch-baked geometry edit leaves its saved bounding box behind.
//
// Codex audit BUG-528 (family K1): setGeometryLoops is the one landing path a
// sketch bake uses to publish new loops. It replaced loops/layers/projectionStale,
// re-derived stock membership + derived-stock bounds and marked the owning nest
// stale -- but never recomputed g.boundingBox, so Properties/Size, import/export
// and viewport restore kept showing the pre-edit extent after a scale-and-bake.
//
// These drive the REAL setGeometryLoops action at the store level (Tier 2 desk):
// geometry, bounds, stock dependencies and nest freshness must land together.

import { describe, it, expect, beforeEach } from 'vitest'
import { useCamStore } from '../../store'
import type {
  ImportedGeometry, BoundingBox, Vec3, Loop2D, NestRecord,
} from '../../types'

// -- Fixtures ------------------------------------------------------------------

function bbox(min: Vec3, max: Vec3): BoundingBox {
  return {
    min: { ...min }, max: { ...max },
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
  }
}

function squareLoop(id: string, s: number): Loop2D {
  return {
    id,
    layerId: 'lyr-a',
    closed: true,
    type: 'contour',
    area: s * s,
    points: [
      { x: 0, y: 0 }, { x: s, y: 0 }, { x: s, y: s }, { x: 0, y: s },
    ],
  }
}

// An owned 2D seed with one layer + one 10x10 loop, its saved bounding box
// matching that footprint (the state a post-pack seed is persisted in).
function makeOwnedSeed2D(id: string, ownerNestId: string): ImportedGeometry {
  return {
    id, name: `Seed ${id}`, filename: `${id}.dxf`, type: 'curves_2d', format: 'dxf',
    ownerNestId, stockIdLocked: true,
    boundingBox: bbox({ x: 0, y: 0, z: 0 }, { x: 10, y: 10, z: 0 }),
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    layers2d: [
      { id: 'lyr-a', name: 'Outline', color: '#f00', visible: true },
    ],
    loops: [squareLoop('lp-a', 10)],
  } as ImportedGeometry
}

function makeNest(id: string, sources: NestRecord['sources']): NestRecord {
  return {
    id, name: `Nest ${id}`,
    sheet: { width: 200, height: 200 },
    style: 'arbitrary',
    spacing: { partGap: 1, sheetMargin: 1, windowGap: 1 },
    seed: 1,
    sources,
    placements: [],
    unplaced: [],
    utilization: 0,
  }
}

function install(geometry: ImportedGeometry[], nests: NestRecord[]): void {
  useCamStore.setState((s) => ({
    project: {
      ...s.project,
      geometry,
      geometryFolders: [],
      nests,
      setups: [],
      stocks: undefined,
    },
    projectHistory: [],
    canUndo: false,
  }))
}

const geo = (id: string) =>
  useCamStore.getState().project.geometry.find((g) => g.id === id)!

// The PropertiesPanel "Size" reads exactly geo.boundingBox.size (PropertiesPanel.tsx).
const reportedSize = (id: string) => geo(id).boundingBox.size

beforeEach(() => {
  install(
    [
      makeOwnedSeed2D('g-seed', 'n1'),   // the block being edited
      makeOwnedSeed2D('g-other', 'n1'),  // unrelated owned geometry
      { ...makeOwnedSeed2D('g-src', ''), ownerNestId: undefined, name: 'Imported source' } as ImportedGeometry,
    ],
    [makeNest('n1', [{ geometryId: 'g-seed', quantity: 1 }])],
  )
})

describe('WO-1405: setGeometryLoops re-derives boundingBox from the published loops', () => {
  it('a 1.5x scale-and-bake moves boundingBox + reported Size onto the new loops', () => {
    const before = reportedSize('g-seed')
    expect(before).toEqual({ x: 10, y: 10, z: 0 })

    // Scale the footprint 1.5x (15x15) and bake it through the real action.
    useCamStore.getState().setGeometryLoops(
      'g-seed',
      [squareLoop('lp-a', 15)],
      geo('g-seed').layers2d!,
    )

    const g = geo('g-seed')
    expect(g.boundingBox.size).toEqual({ x: 15, y: 15, z: 0 })
    expect(g.boundingBox.min).toEqual({ x: 0, y: 0, z: 0 })
    expect(g.boundingBox.max).toEqual({ x: 15, y: 15, z: 0 })
    expect(g.boundingBox.center).toEqual({ x: 7.5, y: 7.5, z: 0 })
    // The "reported Size" surface agrees with the geometry's own loops.
    expect(reportedSize('g-seed')).toEqual({ x: 15, y: 15, z: 0 })

    // Freshness still lands in the same pass (today's behaviour, unchanged).
    expect(useCamStore.getState().project.nests![0].needsRecompute).toBe(true)
  })

  it('leaves an unrelated owned geometry and the original imported source untouched', () => {
    const otherBefore = geo('g-other')
    const srcBefore = geo('g-src')

    useCamStore.getState().setGeometryLoops(
      'g-seed',
      [squareLoop('lp-a', 15)],
      geo('g-seed').layers2d!,
    )

    const otherAfter = geo('g-other')
    const srcAfter = geo('g-src')
    expect(otherAfter.boundingBox).toEqual(otherBefore.boundingBox)
    expect(otherAfter.loops).toEqual(otherBefore.loops)
    expect(srcAfter.boundingBox).toEqual(srcBefore.boundingBox)
    expect(srcAfter.loops).toEqual(srcBefore.loops)
  })

  it('a non-scaling sketch edit leaves boundingBox numerically the same', () => {
    const before = geo('g-seed').boundingBox

    // Same 10x10 footprint re-baked (e.g. a naming/constraint edit that does not
    // change geometry).
    useCamStore.getState().setGeometryLoops(
      'g-seed',
      [squareLoop('lp-a', 10)],
      geo('g-seed').layers2d!,
    )

    expect(geo('g-seed').boundingBox).toEqual(before)
  })
})

// Audit fix round: setGeometryLoops is ALSO the DesignTree "Fit arcs & merge
// lines" landing path (handleConfirmOptimization), and that button is offered on
// STL projections / brep sections. The loops on a 3D body are a derived 2D
// footprint; the body's boundingBox is its 3D mesh extent and must survive the
// edit (a 100x60x25 part must not become a 20x20x0 flat part).
function makeStlBody(id: string): ImportedGeometry {
  return {
    id, name: `STL ${id}`, filename: `${id}.stl`, type: 'mesh', format: 'stl',
    boundingBox: bbox({ x: -10, y: -10, z: 0 }, { x: 90, y: 50, z: 25 }),
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    layers2d: [
      {
        id: 'lyr-proj', name: 'STL Projection 1', color: '#0ff', visible: true,
        projectionPlane: {
          origin: { x: 0, y: 0, z: 0 },
          xAxis: { x: 1, y: 0, z: 0 },
          yAxis: { x: 0, y: 1, z: 0 },
          normal: { x: 0, y: 0, z: 1 },
        },
      },
    ],
    loops: [{ ...squareLoop('lp-proj', 20), layerId: 'lyr-proj' }],
    projectionStale: false,
  } as ImportedGeometry
}

describe('WO-1405 fix round: a 3D body keeps its boundingBox through setGeometryLoops', () => {
  it('an STL body with a projection layer keeps its 3D boundingBox (z stays 25)', () => {
    install([makeStlBody('g-stl')], [])
    const before = JSON.parse(JSON.stringify(geo('g-stl').boundingBox)) as BoundingBox

    // Exactly how handleConfirmOptimization lands an Optimize edit on an STL
    // projection: setGeometryLoops(geoId, loops, layers).
    useCamStore.getState().setGeometryLoops(
      'g-stl',
      [{ ...squareLoop('lp-proj', 30), layerId: 'lyr-proj' }],
      geo('g-stl').layers2d!,
    )

    // The 2D loops were published (the action really ran) ...
    expect(geo('g-stl').loops).toHaveLength(1)
    expect(geo('g-stl').loopsVersion).toBe(1)
    // ... but the mesh's 3D extent is untouched: not a flat z:0 2D footprint.
    expect(geo('g-stl').boundingBox).toEqual(before)
    expect(geo('g-stl').boundingBox.size).toEqual({ x: 100, y: 60, z: 25 })
  })
})
