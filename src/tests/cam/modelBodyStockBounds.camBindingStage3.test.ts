// CAM-BINDING Stage 3 (stock): geometryWorldBounds/deriveStockBounds now
// resolve a model-backed CAM entry's world-space AABB from its own
// tessellated display bbox, composed through resolveModelReferenceFrame (the
// coordinator MANDATE's one named seam) - reversing dispatchGeo.ts's former
// "a model-backed CAM entry is READ-ONLY, it contributes no bounds" refusal.
//
// FIXTURE STRATEGY: mirrors modelBodyDerive.camBindingStage2.test.ts - a
// hand-built ModelBodyDisplay.bbox is a legitimate, deterministic input
// (geometryWorldBounds only reads the bbox corners + the resolved frame,
// never how the mesh was produced).

import { describe, it, expect } from 'vitest'
import type { ImportedGeometry, BoundingBox, Vec3 } from '../../types'
import type { ModelItemPlacementRegistryEntry } from '../../lib/cam/modelItemPlacement'
import { geometryWorldBounds } from '../../store/dispatchGeo'
import { deriveStockBounds } from '../../store/stockAssignment'
import type { PhysicalStock } from '../../types'

function bbox(min: Vec3, max: Vec3): BoundingBox {
  return {
    min: { ...min }, max: { ...max },
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
  }
}

function makeModelGeo(
  id: string,
  boundsMinMax: [Vec3, Vec3] | undefined,
  opts: { modelItemId?: string; stockId?: string; stockIdLocked?: boolean } = {},
): ImportedGeometry {
  return {
    id, name: id, filename: '', type: 'model', format: 'model',
    boundingBox: boundsMinMax ? bbox(boundsMinMax[0], boundsMinMax[1]) : bbox({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }),
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    ...(opts.modelItemId !== undefined ? { modelItemId: opts.modelItemId } : {}),
    ...(opts.stockId !== undefined ? { stockId: opts.stockId } : {}),
    ...(opts.stockIdLocked !== undefined ? { stockIdLocked: opts.stockIdLocked } : {}),
    modelBody: {
      ref: { bodyId: `${id}-body`, stableIds: [`${id}-body:F0`], version: 1 },
      ...(boundsMinMax ? {
        display: {
          positions: [], normals: [], indices: [], edgePositions: [], edgeOffsets: [],
          bbox: { min: [boundsMinMax[0].x, boundsMinMax[0].y, boundsMinMax[0].z], max: [boundsMinMax[1].x, boundsMinMax[1].y, boundsMinMax[1].z] },
        },
      } : {}),
    },
  } as unknown as ImportedGeometry
}

const IDENTITY = (modelItemId: string): ModelItemPlacementRegistryEntry => ({
  modelItemId, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
})

describe('CAM-BINDING Stage 3: geometryWorldBounds resolves a model-backed entry', () => {
  it('identity placement: world bounds equal the display bbox verbatim', () => {
    const geo = makeModelGeo('g1', [{ x: -20, y: -15, z: 0 }, { x: 20, y: 15, z: 10 }], { modelItemId: 'item-1' })
    const b = geometryWorldBounds(geo, [IDENTITY('item-1')])
    expect(b).not.toBeNull()
    expect(b!.min).toEqual({ x: -20, y: -15, z: 0 })
    expect(b!.max).toEqual({ x: 20, y: 15, z: 10 })
  })

  it('translated placement: bounds shift by the Placement position (world pose lives OFF the row - a placed/moved item follows)', () => {
    const geo = makeModelGeo('g2', [{ x: -20, y: -15, z: 0 }, { x: 20, y: 15, z: 10 }], { modelItemId: 'item-2' })
    const placement: ModelItemPlacementRegistryEntry = {
      modelItemId: 'item-2', position: { x: 100, y: 50, z: 5 }, rotation: { x: 0, y: 0, z: 0 },
    }
    const b = geometryWorldBounds(geo, [placement])
    expect(b).not.toBeNull()
    expect(b!.min.x).toBeCloseTo(80, 6)
    expect(b!.min.y).toBeCloseTo(35, 6)
    expect(b!.min.z).toBeCloseTo(5, 6)
    expect(b!.max.x).toBeCloseTo(120, 6)
    expect(b!.max.y).toBeCloseTo(65, 6)
    expect(b!.max.z).toBeCloseTo(15, 6)
  })

  it('90deg-Z-rotated placement: bounds are the rotated AABB (X/Y span swap for a non-square footprint)', () => {
    const geo = makeModelGeo('g3', [{ x: -20, y: -5, z: 0 }, { x: 20, y: 5, z: 10 }], { modelItemId: 'item-3' })
    const placement: ModelItemPlacementRegistryEntry = {
      modelItemId: 'item-3', position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 90 },
    }
    const b = geometryWorldBounds(geo, [placement])
    expect(b).not.toBeNull()
    // Original 40(x) x 10(y) footprint rotates to 10(x) x 40(y).
    expect(b!.max.x - b!.min.x).toBeCloseTo(10, 5)
    expect(b!.max.y - b!.min.y).toBeCloseTo(40, 5)
    expect(b!.min.z).toBeCloseTo(0, 6)
    expect(b!.max.z).toBeCloseTo(10, 6)
  })

  it('translated AND rotated placement together (a placed + moved model item): both compose', () => {
    const geo = makeModelGeo('g4', [{ x: -10, y: -5, z: 0 }, { x: 10, y: 5, z: 4 }], { modelItemId: 'item-4' })
    const placement: ModelItemPlacementRegistryEntry = {
      modelItemId: 'item-4', position: { x: 50, y: -50, z: 20 }, rotation: { x: 0, y: 0, z: 90 },
    }
    const b = geometryWorldBounds(geo, [placement])
    expect(b).not.toBeNull()
    // Rotated footprint: 10(x) x 20(y), then translated.
    expect(b!.min.x).toBeCloseTo(50 - 5, 5)
    expect(b!.max.x).toBeCloseTo(50 + 5, 5)
    expect(b!.min.y).toBeCloseTo(-50 - 10, 5)
    expect(b!.max.y).toBeCloseTo(-50 + 10, 5)
    expect(b!.min.z).toBeCloseTo(20, 6)
    expect(b!.max.z).toBeCloseTo(24, 6)
  })

  it('no resolvable Placement record: contributes null, never throws (graceful, matching the empty-2D-source null case)', () => {
    const geo = makeModelGeo('g5', [{ x: 0, y: 0, z: 0 }, { x: 10, y: 10, z: 10 }], { modelItemId: 'orphan-item' })
    expect(() => geometryWorldBounds(geo, [IDENTITY('some-other-item')])).not.toThrow()
    expect(geometryWorldBounds(geo, [IDENTITY('some-other-item')])).toBeNull()
  })

  it('no placementRecords argument at all (a caller that predates Stage 3): byte-identical pre-Stage-3 null, never a crash', () => {
    const geo = makeModelGeo('g6', [{ x: 0, y: 0, z: 0 }, { x: 10, y: 10, z: 10 }], { modelItemId: 'item-6' })
    expect(geometryWorldBounds(geo)).toBeNull()
  })

  it('no tessellated display yet: null', () => {
    const geo = makeModelGeo('g7', undefined, { modelItemId: 'item-7' })
    expect(geometryWorldBounds(geo, [IDENTITY('item-7')])).toBeNull()
  })

  it('degenerate (zero-volume) display bbox: null', () => {
    const geo = makeModelGeo('g8', [{ x: 5, y: 5, z: 5 }, { x: 5, y: 5, z: 5 }], { modelItemId: 'item-8' })
    expect(geometryWorldBounds(geo, [IDENTITY('item-8')])).toBeNull()
  })

  // Mutation-provable: comment out the `isModelOriginGeometry(geo)` branch's
  // call to modelBodyWorldBounds in dispatchGeo.ts (revert to `return null`)
  // and this goes RED.
  it('MUTATION PROOF: a model row genuinely contributes non-null bounds (not the pre-Stage-3 blanket null)', () => {
    const geo = makeModelGeo('g9', [{ x: -1, y: -1, z: -1 }, { x: 1, y: 1, z: 1 }], { modelItemId: 'item-9' })
    expect(geometryWorldBounds(geo, [IDENTITY('item-9')])).not.toBeNull()
  })
})

describe('CAM-BINDING Stage 3: deriveStockBounds sizes a NAMED stock from a LOCKED model member', () => {
  const stock: PhysicalStock = {
    id: 'auto-1', name: 'Auto Stock 1', mode: 'derived',
    bounds: bbox({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }), position: { x: 0, y: 0, z: 0 },
  }

  it('a single locked model member sizes the stock to its live bbox, padded by the standard auto offsets', () => {
    const geo = makeModelGeo(
      'g10', [{ x: -20, y: -15, z: 0 }, { x: 20, y: 15, z: 10 }],
      { modelItemId: 'item-10', stockId: 'auto-1', stockIdLocked: true },
    )
    const bounds = deriveStockBounds(
      stock, [geo], { autoOffsetXY: 2, autoOffsetZTop: 1 }, [IDENTITY('item-10')],
    )
    expect(bounds).not.toBeNull()
    expect(bounds!.min).toEqual({ x: -22, y: -17, z: 0 })
    expect(bounds!.max).toEqual({ x: 22, y: 17, z: 11 })
  })

  it('no placementRecords passed through: the same locked member contributes nothing (fails toward the pre-Stage-3 "no members" null, never a wrong box)', () => {
    const geo = makeModelGeo(
      'g11', [{ x: -20, y: -15, z: 0 }, { x: 20, y: 15, z: 10 }],
      { modelItemId: 'item-11', stockId: 'auto-1', stockIdLocked: true },
    )
    const bounds = deriveStockBounds(stock, [geo], { autoOffsetXY: 2, autoOffsetZTop: 1 })
    expect(bounds).toBeNull()
  })

  it('an UNLOCKED model row with a stale stockId is not queried here (deriveStockBounds filters purely by stockId, unaffected by lock) - a lock is enforced upstream by assignGeometryToStocks, not here', () => {
    // deriveStockBounds itself is lock-agnostic (it reads geo.stockId only);
    // Stage 3's lock semantics live in assignGeometryToStocks. This fixture
    // just confirms the bounds function does not silently special-case an
    // unlocked row differently - it derives correctly either way.
    const geo = makeModelGeo(
      'g12', [{ x: -5, y: -5, z: 0 }, { x: 5, y: 5, z: 2 }],
      { modelItemId: 'item-12', stockId: 'auto-1', stockIdLocked: false },
    )
    const bounds = deriveStockBounds(
      stock, [geo], { autoOffsetXY: 0, autoOffsetZTop: 0 }, [IDENTITY('item-12')],
    )
    expect(bounds).not.toBeNull()
    expect(bounds!.min).toEqual({ x: -5, y: -5, z: 0 })
    expect(bounds!.max).toEqual({ x: 5, y: 5, z: 2 })
  })
})
