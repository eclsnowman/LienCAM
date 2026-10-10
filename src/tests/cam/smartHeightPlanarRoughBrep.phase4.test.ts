import { describe, expect, it } from 'vitest'
import type { ImportedGeometry } from '../../types'
import type { PrismaticRoughTargetFacts } from '../../lib/cam/geometry/occt/model/types'
import {
  adaptBrepPrismaticRoughTarget,
  compileBrepPlanarRoughTarget,
} from '../../lib/cam/smartHeights/planarRoughBrep'

function geometry(overrides: Partial<ImportedGeometry> = {}): ImportedGeometry {
  return {
    id: 'part-1',
    name: 'Prismatic part',
    filename: 'part.step',
    type: 'brep',
    format: 'step',
    boundingBox: {
      min: { x: 0, y: 0, z: 0 },
      max: { x: 60, y: 60, z: 20 },
      size: { x: 60, y: 60, z: 20 },
      center: { x: 30, y: 30, z: 10 },
    },
    position: { x: 100, y: 200, z: 30 },
    rotation: { x: 0, y: 0, z: 90 },
    loaded: true,
    ...overrides,
  }
}

function facts(overrides: Partial<PrismaticRoughTargetFacts> = {}): PrismaticRoughTargetFacts {
  return {
    bounds: { min: [0, 0, 0], max: [60, 60, 20] },
    solidCount: 1,
    roughFloorZ: 10,
    keepOutRegions: [{
      faceIndex: 7,
      targetTopZ: 20,
      loop: {
        points: [{ x: 20, y: 20 }, { x: 40, y: 20 }, { x: 40, y: 40 }, { x: 20, y: 40 }],
        closed: true,
        type: 'contour',
        area: 400,
      },
    }],
    classification: {
      allFacesClassified: true,
      hasSlopedFaces: false,
      hasUndercuts: false,
      deckLevelsZ: [10],
      unclassifiedFaceIds: [],
    },
    ...overrides,
  }
}

describe('Smart Height B-rep prismatic target adapter', () => {
  it('transforms analytic local facts through Z pose into machine evidence', () => {
    const result = adaptBrepPrismaticRoughTarget({
      geometry: geometry(), stockId: 'stock-1', facts: facts(),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.target).toMatchObject({
      geometryId: 'part-1',
      stockId: 'stock-1',
      roughFloorMachineMm: 40,
      boundsMachineMm: {
        minX: 40, minY: 200, minZ: 30,
        maxX: 100, maxY: 260, maxZ: 50,
      },
    })
    expect(result.target.keepOutRegions[0]).toMatchObject({
      regionId: 'part-1:face:7',
      loopId: 'smart-height-keep-out:part-1:face:7',
      targetTopMachineMm: 50,
    })
    expect(result.target.keepOutRegions[0].pointsMachineMm[0]).toMatchObject({ x: 80, y: 220 })
  })

  it('binds fingerprints to geometry pose and analytic facts', () => {
    const first = adaptBrepPrismaticRoughTarget({
      geometry: geometry(), stockId: 'stock-1', facts: facts(),
    })
    const moved = adaptBrepPrismaticRoughTarget({
      geometry: geometry({ position: { x: 101, y: 200, z: 30 } }),
      stockId: 'stock-1', facts: facts(),
    })
    expect(first.ok && moved.ok).toBe(true)
    if (!first.ok || !moved.ok) return
    expect(moved.target.fingerprint).not.toBe(first.target.fingerprint)
    expect(moved.target.keepOutRegions[0].fingerprint)
      .not.toBe(first.target.keepOutRegions[0].fingerprint)
  })

  it('refuses non-B-rep, tilted, and deckless target evidence by name', () => {
    const unsupported = adaptBrepPrismaticRoughTarget({
      geometry: geometry({ type: 'mesh', format: 'stl' }), stockId: 'stock-1', facts: facts(),
    })
    const tilted = adaptBrepPrismaticRoughTarget({
      geometry: geometry({ rotation: { x: 5, y: 0, z: 0 } }), stockId: 'stock-1', facts: facts(),
    })
    const deckless = adaptBrepPrismaticRoughTarget({
      geometry: geometry(), stockId: 'stock-1', facts: facts({ roughFloorZ: undefined }),
    })
    expect(unsupported).toMatchObject({ ok: false, refusal: { code: 'unsupported_geometry' } })
    expect(tilted).toMatchObject({ ok: false, refusal: { code: 'tilted_target' } })
    expect(deckless).toMatchObject({ ok: false, refusal: { code: 'incomplete_target_evidence' } })
  })

  it('compiles every supplied target deterministically against exact stock and material', () => {
    const stock = {
      stockId: 'stock-1', artifactId: 'stock-box:stock-1',
      boundsMachineMm: { minX: 0, minY: 0, minZ: 0, maxX: 300, maxY: 300, maxZ: 50 },
      fingerprint: 'stock-fingerprint',
    }
    const material = {
      stockId: 'stock-1', artifactId: 'stock-box:stock-1',
      boundsMachineMm: stock.boundsMachineMm,
      fingerprint: 'material-fingerprint',
      representation: 'uniform-prismatic-material-v1' as const,
      defaultTopMachineMm: 50,
      regionTops: [{
        targetRegionFingerprint: '',
        topMachineMm: 50,
      }],
    }
    const firstAdapted = adaptBrepPrismaticRoughTarget({
      geometry: geometry(), stockId: stock.stockId, facts: facts(),
    })
    expect(firstAdapted.ok).toBe(true)
    if (!firstAdapted.ok) return
    material.regionTops[0].targetRegionFingerprint =
      firstAdapted.target.keepOutRegions[0].fingerprint

    const result = compileBrepPlanarRoughTarget({
      stock,
      material,
      targets: [{ geometry: geometry(), facts: facts() }],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.evidence).toMatchObject({
      stockId: 'stock-1',
      targetGeometryIds: ['part-1'],
      floorMachineMm: 40,
    })
    expect(result.keepOutLoops).toHaveLength(1)
  })

  it('refuses an unsupported target instead of compiling the remaining bodies', () => {
    const result = compileBrepPlanarRoughTarget({
      stock: {
        stockId: 'stock-1', artifactId: 'stock-box:stock-1',
        boundsMachineMm: { minX: 0, minY: 0, minZ: 0, maxX: 300, maxY: 300, maxZ: 50 },
        fingerprint: 'stock-fingerprint',
      },
      material: {
        stockId: 'stock-1', artifactId: 'stock-box:stock-1',
        boundsMachineMm: { minX: 0, minY: 0, minZ: 0, maxX: 300, maxY: 300, maxZ: 50 },
        fingerprint: 'material-fingerprint',
        representation: 'uniform-prismatic-material-v1',
        defaultTopMachineMm: 50,
        regionTops: [],
      },
      targets: [
        { geometry: geometry(), facts: facts() },
        { geometry: geometry({ id: 'mesh-1', type: 'mesh', format: 'stl' }), facts: facts() },
      ],
    })
    expect(result).toMatchObject({
      ok: false,
      refusal: { code: 'unsupported_geometry', subjectId: 'mesh-1' },
    })
  })
})
