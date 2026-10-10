import { describe, expect, it } from 'vitest'
import {
  compilePlanarRoughPrismaticTarget,
  PLANAR_ROUGH_PRISMATIC_TARGET_REPRESENTATION,
  PLANAR_ROUGH_UNIFORM_MATERIAL_REPRESENTATION,
  type CompilePlanarRoughTargetInput,
  type PlanarRoughPrismaticTargetBody,
} from '../../lib/cam/smartHeights/planarRoughCompile'
import { PLANAR_ROUGH_TARGET_REPRESENTATION } from '../../lib/cam/smartHeights/planarRough'

const bounds = (minZ = 0, maxZ = 20) => ({
  minX: 0, minY: 0, minZ, maxX: 100, maxY: 80, maxZ,
})

function target(overrides: Partial<PlanarRoughPrismaticTargetBody> = {}): PlanarRoughPrismaticTargetBody {
  return {
    geometryId: 'part-1',
    stockId: 'stock-1',
    artifactId: 'target:part-1:v1',
    boundsMachineMm: bounds(2, 20),
    fingerprint: 'target-fingerprint-v1',
    representation: PLANAR_ROUGH_PRISMATIC_TARGET_REPRESENTATION,
    roughFloorMachineMm: 5,
    keepOutRegions: [],
    classification: {
      source: 'analytic_kernel',
      allFacesClassified: true,
      hasSlopedFaces: false,
      hasUndercuts: false,
      deckLevelsMachineMm: [5],
      unclassifiedFaceIds: [],
    },
    ...overrides,
  }
}

function boss(topMachineMm = 20) {
  return {
    regionId: 'boss-1',
    loopId: 'boss-loop-1',
    pointsMachineMm: [
      { x: 40, y: 30 }, { x: 60, y: 30 }, { x: 60, y: 50 }, { x: 40, y: 50 },
    ],
    targetTopMachineMm: topMachineMm,
    fingerprint: 'boss-region-fingerprint-v1',
  }
}

function fixture(overrides: Partial<CompilePlanarRoughTargetInput> = {}): CompilePlanarRoughTargetInput {
  return {
    stock: {
      stockId: 'stock-1',
      artifactId: 'stock-box:stock-1',
      boundsMachineMm: bounds(),
      fingerprint: 'stock-fingerprint-v1',
    },
    material: {
      stockId: 'stock-1',
      artifactId: 'stock-box:stock-1',
      boundsMachineMm: bounds(),
      fingerprint: 'material-fingerprint-v1',
      representation: PLANAR_ROUGH_UNIFORM_MATERIAL_REPRESENTATION,
      defaultTopMachineMm: 20,
      regionTops: [],
    },
    targets: [target()],
    ...overrides,
  }
}

describe('Smart Height planar rough prismatic compiler', () => {
  it('compiles a complete flat-deck target without islands', () => {
    const result = compilePlanarRoughPrismaticTarget(fixture())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.evidence).toMatchObject({
      stockId: 'stock-1',
      materialArtifactId: 'stock-box:stock-1',
      targetGeometryIds: ['part-1'],
      floorMachineMm: 5,
      representation: PLANAR_ROUGH_TARGET_REPRESENTATION,
      keepOutRegions: [],
    })
    expect(result.keepOutLoops).toEqual([])
    expect(result.diagnostics.at(-1)?.verdict).toBe('accepted')
  })

  it('accepts a boss whose target top equals the local material top', () => {
    const result = compilePlanarRoughPrismaticTarget(fixture({
      targets: [target({ keepOutRegions: [boss()] })],
    }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.keepOutLoops).toHaveLength(1)
    expect(result.evidence.keepOutRegions[0]).toEqual({
      loopId: 'boss-loop-1',
      materialTopMachineMm: 20,
      targetTopMachineMm: 20,
    })
  })

  it('refuses a buried boss because a static island would leave an uncut column', () => {
    const result = compilePlanarRoughPrismaticTarget(fixture({
      targets: [target({ keepOutRegions: [boss(15)] })],
    }))
    expect(result).toMatchObject({
      ok: false,
      refusal: { code: 'material_above_keep_out' },
    })
  })

  it('accepts a formerly buried boss when exact remaining material ends at its top', () => {
    const result = compilePlanarRoughPrismaticTarget(fixture({
      material: {
        stockId: 'stock-1',
        artifactId: 'remaining:op-previous:v2',
        boundsMachineMm: bounds(),
        fingerprint: 'remaining-fingerprint-v2',
        representation: PLANAR_ROUGH_TARGET_REPRESENTATION,
        defaultTopMachineMm: 20,
        regionTops: [{
          targetRegionFingerprint: 'boss-region-fingerprint-v1',
          topMachineMm: 15,
        }],
      },
      targets: [target({ keepOutRegions: [boss(15)] })],
    }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.evidence.materialArtifactId).toBe('remaining:op-previous:v2')
    expect(result.keepOutLoops[0].materialTopMachineMm).toBe(15)
  })

  it('refuses multiple target deck levels', () => {
    const second = target({
      geometryId: 'part-2',
      artifactId: 'target:part-2:v1',
      fingerprint: 'target-part-2-v1',
      roughFloorMachineMm: 8,
      classification: {
        ...target().classification,
        deckLevelsMachineMm: [8],
      },
    })
    const result = compilePlanarRoughPrismaticTarget(fixture({ targets: [target(), second] }))
    expect(result).toMatchObject({ ok: false, refusal: { code: 'multiple_rough_floors' } })
  })

  it('refuses sloped, undercut, and unclassified target topology', () => {
    const cases: PlanarRoughPrismaticTargetBody[] = [
      target({ classification: { ...target().classification, hasSlopedFaces: true } }),
      target({ classification: { ...target().classification, hasUndercuts: true } }),
      target({ classification: {
        ...target().classification,
        allFacesClassified: false,
        unclassifiedFaceIds: ['face-9'],
      } }),
    ]
    expect(cases.map(candidate => {
      const result = compilePlanarRoughPrismaticTarget(fixture({ targets: [candidate] }))
      return result.ok ? 'accepted' : result.refusal.code
    })).toEqual([
      'unsupported_target_topology',
      'unsupported_target_topology',
      'incomplete_target_evidence',
    ])
  })

  it('refuses missing, foreign-stock, and out-of-stock targets', () => {
    const missing = compilePlanarRoughPrismaticTarget(fixture({ targets: [] }))
    const foreign = compilePlanarRoughPrismaticTarget(fixture({
      targets: [target({ stockId: 'stock-2' })],
    }))
    const outside = compilePlanarRoughPrismaticTarget(fixture({
      targets: [target({ boundsMachineMm: { ...bounds(2, 20), maxX: 101 } })],
    }))
    expect(missing).toMatchObject({ ok: false, refusal: { code: 'incomplete_target_evidence' } })
    expect(foreign).toMatchObject({ ok: false, refusal: { code: 'stock_identity_mismatch' } })
    expect(outside).toMatchObject({ ok: false, refusal: { code: 'target_outside_stock' } })
  })

  it('refuses malformed material and keep-out artifacts at the compiler boundary', () => {
    const unknownMaterial = compilePlanarRoughPrismaticTarget(fixture({
      material: {
        ...fixture().material,
        representation: 'unknown-material-shape' as typeof PLANAR_ROUGH_TARGET_REPRESENTATION,
      },
    }))
    const crossingBoss = boss()
    crossingBoss.pointsMachineMm = [
      { x: 40, y: 30 }, { x: 60, y: 50 }, { x: 40, y: 50 }, { x: 60, y: 30 },
    ]
    const selfIntersecting = compilePlanarRoughPrismaticTarget(fixture({
      targets: [target({ keepOutRegions: [crossingBoss] })],
    }))
    const outsideLoop = boss()
    outsideLoop.pointsMachineMm[0] = { x: -1, y: 30 }
    const loopOutsideTarget = compilePlanarRoughPrismaticTarget(fixture({
      targets: [target({ keepOutRegions: [outsideLoop] })],
    }))
    expect(unknownMaterial).toMatchObject({ ok: false, refusal: { code: 'invalid_input' } })
    expect(selfIntersecting).toMatchObject({ ok: false, refusal: { code: 'invalid_keep_out_region' } })
    expect(loopOutsideTarget).toMatchObject({ ok: false, refusal: { code: 'invalid_keep_out_region' } })
  })

  it('binds the result identity to target placement and current material', () => {
    const first = compilePlanarRoughPrismaticTarget(fixture())
    const moved = compilePlanarRoughPrismaticTarget(fixture({
      targets: [target({ fingerprint: 'target-moved-v2' })],
    }))
    const laterMaterial = compilePlanarRoughPrismaticTarget(fixture({
      material: { ...fixture().material, fingerprint: 'material-chain-v2' },
    }))
    expect(first.ok && moved.ok && laterMaterial.ok).toBe(true)
    if (!first.ok || !moved.ok || !laterMaterial.ok) return
    expect(moved.evidence.fingerprint).not.toBe(first.evidence.fingerprint)
    expect(laterMaterial.evidence.fingerprint).not.toBe(first.evidence.fingerprint)
    expect(moved.evidence.artifactId).not.toBe(first.evidence.artifactId)
  })

  it('sorts target and loop identities for deterministic compilation', () => {
    const firstTarget = target({ keepOutRegions: [boss()] })
    const secondTarget = target({
      geometryId: 'part-2',
      artifactId: 'target:part-2:v1',
      fingerprint: 'target-part-2-v1',
      keepOutRegions: [{
        ...boss(),
        regionId: 'boss-2',
        loopId: 'boss-loop-2',
        fingerprint: 'boss-region-fingerprint-v2',
      }],
    })
    const forward = compilePlanarRoughPrismaticTarget(fixture({
      targets: [firstTarget, secondTarget],
    }))
    const reverse = compilePlanarRoughPrismaticTarget(fixture({
      targets: [secondTarget, firstTarget],
    }))
    expect(forward.ok && reverse.ok).toBe(true)
    if (!forward.ok || !reverse.ok) return
    expect(reverse.evidence.fingerprint).toBe(forward.evidence.fingerprint)
    expect(reverse.evidence.targetGeometryIds).toEqual(['part-1', 'part-2'])
    expect(reverse.keepOutLoops.map(loop => loop.loopId)).toEqual(['boss-loop-1', 'boss-loop-2'])
  })
})
