// WO-114, the load-bearing evidence WO-095's tests did NOT produce: a picked
// modeled-body edge chain survives an actual model REBUILD driven through the
// REAL model/kernel path - or refuses out loud.
//
// WO-095's audit: its fixture "never edits/rebuilds a body through the
// model/kernel path". Fabricating display arrays in the store is not a rebuild.
// So nothing in this file fabricates a tessellation. Every body here goes
// through the whole production chain:
//
//   GeomEngine (real occt-wasm kernel)
//     -> makeBox / makeHole / editFeature      <- a REAL parametric edit
//     -> engine.tessellate()                   <- real TessBuffers + edge ids
//     -> GeometryCache.ingest()                <- the viewport's own cache
//     -> modelBodyDisplayFromCached()          <- the persisted display payload
//     -> buildModelBodyGeometry()              <- the real CAM geometry adapter
//     -> deriveModelBodyEdges()                <- the binding under test
//
// The picked chain is the TOP RIM of a drilled hole - one closed circular edge
// whose id the kernel mints from its own adjacent-face pair. Growing that hole
// through editFeature is a genuine feature edit: the kernel removes and re-cuts
// the feature, remints the faces, and re-tessellates. If the binding were a
// cached polyline or a positional index, the derived loop would either be the
// OLD diameter or some other edge entirely.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { GeomEngine } from '../../geom/worker/geom-engine.ts'
import type { BodyHandle, StableId, TessBuffers } from '../../geom/geom-service.ts'
import { GeometryCache } from '../../viewport3d/GeometryCache'
import { modelBodyDisplayFromCached } from '../../viewport3d/modelBodyDisplay'
import { buildModelBodyGeometry } from '../../lib/cam/modelBodyAdapter'
import { deriveModelBodyEdges } from '../../store/modelEdgeChainBinding'
import { ModelBodyDeriveError } from '../../lib/cam/modelBodyDerive'
import type { ImportedGeometry, Operation, Setup } from '../../types'
import type { ModelItemPlacementRegistryEntry } from '../../lib/cam/modelItemPlacement'

const { useCamStore } = await import('../../store')

const BOX = { x: 60, y: 30, z: 12 }
const TOP: StableId = 'F1:BOX:zMax' as StableId
const HOLE_CENTER = { x: 30, y: 15 }
const HOLE_D0 = 8
const HOLE_D1 = 12 // after the +4 diameter edit

/** The body's Model Item placement, identity - the CAM row's world pose lives
 *  here (a model row's own position/rotation stay identity forever). */
const PLACEMENTS: ModelItemPlacementRegistryEntry[] = [
  { modelItemId: 'legacy', position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } },
]

let cacheSeq = 0

/**
 * The REAL chain, end to end: tessellate the kernel body, push the buffers
 * through the viewport's GeometryCache, read the persisted display payload out
 * of the cache entry, and build the CAM geometry row with the production
 * adapter. No hand-authored arrays anywhere.
 */
function camRowFromKernelBody(tess: TessBuffers, bodyId: string): ImportedGeometry {
  // A fresh cache per call: GeometryCache versions per bodyId, and each rebuild
  // here stands for a separate regen pass.
  const cache = new GeometryCache()
  const cacheKey = `${bodyId}#${cacheSeq++}`
  try {
    cache.ingest(cacheKey, tess)
    const cached = cache.get(cacheKey)
    if (cached === undefined) throw new Error('GeometryCache.ingest produced no entry')
    const display = modelBodyDisplayFromCached(cached)
    return buildModelBodyGeometry(
      { bodyId, name: 'Plate' },
      { bodyId, version: cached.version, stableIds: [...cached.faceIds, ...cached.edgeIds], display },
    )
  } finally {
    cache.disposeAll()
  }
}

/**
 * Find the hole's TOP RIM edge in a tessellation: the one edge whose whole
 * polyline sits on the top plane (z = BOX.z) AND stays within a small radius of
 * the hole centre. Located GEOMETRICALLY, never by index or by name, so the
 * fixture makes no assumption about the kernel's id grammar or edge order.
 */
function findHoleRimEdgeId(tess: TessBuffers): { id: string; radius: number } {
  const candidates: Array<{ id: string; radius: number }> = []
  for (let e = 0; e < tess.edgeIds.length; e++) {
    const start = tess.edgeOffsets[e]
    const end = tess.edgeOffsets[e + 1]
    if (end - start < 3) continue
    let onTop = true
    let minR = Infinity, maxR = -Infinity
    for (let p = start; p < end; p++) {
      const x = tess.edgePositions[p * 3]
      const y = tess.edgePositions[p * 3 + 1]
      const z = tess.edgePositions[p * 3 + 2]
      if (Math.abs(z - BOX.z) > 1e-6) { onTop = false; break }
      const r = Math.hypot(x - HOLE_CENTER.x, y - HOLE_CENTER.y)
      if (r < minR) minR = r
      if (r > maxR) maxR = r
    }
    // A circle about the hole centre: every point the same distance from it.
    if (onTop && maxR - minR < 0.05 && maxR < 20) {
      candidates.push({ id: tess.edgeIds[e], radius: (minR + maxR) / 2 })
    }
  }
  if (candidates.length !== 1) {
    throw new Error(
      `findHoleRimEdgeId: expected exactly 1 top-plane circular edge about the hole centre, found ` +
        `${candidates.length} (${candidates.map((c) => `${c.id}@r${c.radius.toFixed(3)}`).join(', ')})`,
    )
  }
  return candidates[0]
}

function loopExtent(points: ReadonlyArray<{ x: number; y: number }>) {
  const xs = points.map((p) => p.x), ys = points.map((p) => p.y)
  return {
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
    cx: (Math.max(...xs) + Math.min(...xs)) / 2,
    cy: (Math.max(...ys) + Math.min(...ys)) / 2,
  }
}

describe('WO-114: a picked edge chain across a REAL kernel rebuild', () => {
  let engine: GeomEngine

  beforeAll(async () => {
    engine = new GeomEngine()
    await engine.init()
  }, 120_000)

  afterAll(async () => {
    await engine.disposeKernel()
  })

  async function drilledPlate(diameter: number): Promise<BodyHandle> {
    const box = await engine.makeBox('F1', BOX)
    expect(box.ok).toBe(true)
    const drilled = await engine.makeHole({
      featureId: 'H', body: box.body!, face: TOP,
      points: [{ x: HOLE_CENTER.x, y: HOLE_CENTER.y, z: BOX.z }],
      style: { kind: 'simple', diameter },
      depth: { kind: 'throughAll' },
    })
    expect(drilled.ok, JSON.stringify(drilled.diagnostics ?? [])).toBe(true)
    return drilled.body!
  }

  it('#K1 the picked hole-rim edge derives a real contour from a real kernel body', async () => {
    const body = await drilledPlate(HOLE_D0)
    const tess = await engine.tessellate(body, { deflection: 0.05 })
    const geo = camRowFromKernelBody(tess, 'F1')

    // Precondition: the CAM row really carries kernel-minted per-edge identity.
    expect(geo.modelBody?.display?.edgeIds?.length ?? 0).toBeGreaterThan(0)

    const rim = findHoleRimEdgeId(tess)
    expect(rim.radius).toBeCloseTo(HOLE_D0 / 2, 2)

    const derived = deriveModelBodyEdges(geo, [rim.id], PLACEMENTS)
    expect(derived.loops).toHaveLength(1)
    expect(derived.migratedEdgeIds).toEqual([])
    const extent = loopExtent(derived.loops[0].points)
    expect(extent.width).toBeCloseTo(HOLE_D0, 1)
    expect(extent.height).toBeCloseTo(HOLE_D0, 1)
    expect(extent.cx).toBeCloseTo(HOLE_CENTER.x, 1)
    expect(extent.cy).toBeCloseTo(HOLE_CENTER.y, 1)
    expect(derived.z).toBeCloseTo(BOX.z, 3)

    await engine.disposeAll()
  }, 120_000)

  it('#K2 REBUILD: editFeature grows the hole through the kernel; the SAME persisted id still names the SAME physical edge, and the contour is the NEW size', async () => {
    // ── as picked ──
    const body0 = await drilledPlate(HOLE_D0)
    const tess0 = await engine.tessellate(body0, { deflection: 0.05 })
    const geo0 = camRowFromKernelBody(tess0, 'F1')
    const rim0 = findHoleRimEdgeId(tess0)
    const picked = rim0.id // this is what the operation PERSISTS
    const before = loopExtent(deriveModelBodyEdges(geo0, [picked], PLACEMENTS).loops[0].points)
    expect(before.width).toBeCloseTo(HOLE_D0, 1)

    // ── the model is EDITED through the kernel: grow the hole diameter ──
    // A genuine remove-and-re-cut feature edit (GEO-10 editFeature), not a
    // rewritten display array: the kernel remints the hole faces and the body
    // is re-tessellated from scratch below.
    const verdicts = await engine.recognizeFeatures(body0)
    const hole = verdicts.find((v) => v.featureClass === 'throughHole')
    expect(hole, 'kernel did not recognize the drilled through-hole').toBeTruthy()
    const edited = await engine.editFeature({
      featureId: 'E1', body: body0, featureKey: hole!.featureKey,
      delta: HOLE_D1 - HOLE_D0, kind: 'holeDiameter',
    })
    expect(edited.ok, JSON.stringify(edited.diagnostics ?? [])).toBe(true)

    const tess1 = await engine.tessellate(edited.body!, { deflection: 0.05 })
    const geo1 = camRowFromKernelBody(tess1, 'F1')
    // The rebuilt body really is different geometry, located independently of
    // any id: its rim circle is the new diameter.
    const rim1 = findHoleRimEdgeId(tess1)
    expect(rim1.radius).toBeCloseTo(HOLE_D1 / 2, 2)

    // ── the binding, re-resolved against the REBUILT body ──
    // Re-derived from the ORIGINAL persisted id. The WO allows two honest
    // outcomes ("still names the same edge or fails LOUDLY"); this pins the one
    // the REAL kernel actually produces, so a future kernel change that
    // downgrades survival to a refusal fails here loudly instead of passing
    // either way. (The refusal arm has its own proof: #K3.)
    const derived1 = deriveModelBodyEdges(geo1, [picked], PLACEMENTS)
    expect(derived1.loops).toHaveLength(1)
    // Byte-identical id survival - the hole rim's adjacent-face pair is intact
    // through the edit, so this is not even a lineage rebind.
    expect(derived1.migratedEdgeIds).toEqual([])
    const after = loopExtent(derived1.loops[0].points)

    // The SAME physical edge (the hole rim), now at its NEW size. This is the
    // whole claim - "parametric edit -> toolpath knows".
    expect(after.width).toBeCloseTo(HOLE_D1, 1)
    expect(after.height).toBeCloseTo(HOLE_D1, 1)
    expect(after.cx).toBeCloseTo(HOLE_CENTER.x, 1)
    expect(after.cy).toBeCloseTo(HOLE_CENTER.y, 1)
    // ...and it is NOT the stale polyline: the contour actually changed size.
    expect(Math.abs(after.width - before.width)).toBeCloseTo(HOLE_D1 - HOLE_D0, 1)

    await engine.disposeAll()
  }, 180_000)

  it('#K3 REBUILD that REMOVES the feature: the picked edge is gone, and the derive refuses BY NAME rather than binding something else', async () => {
    const body0 = await drilledPlate(HOLE_D0)
    const tess0 = await engine.tessellate(body0, { deflection: 0.05 })
    const picked = findHoleRimEdgeId(tess0).id

    // The hole feature is removed from the model: the rebuilt body is the same
    // plate WITHOUT it, built by the same kernel from the same box feature.
    const plain = await engine.makeBox('F1', BOX)
    expect(plain.ok).toBe(true)
    const tess1 = await engine.tessellate(plain.body!, { deflection: 0.05 })
    const geo1 = camRowFromKernelBody(tess1, 'F1')
    // Precondition: the picked id genuinely no longer exists on the rebuilt body.
    expect(geo1.modelBody?.display?.edgeIds ?? []).not.toContain(picked)

    expect(() => deriveModelBodyEdges(geo1, [picked], PLACEMENTS)).toThrow(ModelBodyDeriveError)
    try {
      deriveModelBodyEdges(geo1, [picked], PLACEMENTS)
    } catch (err) {
      const message = (err as Error).message
      // Named: it says WHICH pick died and what to do, and never returns loops.
      expect(message).toContain(picked)
      expect(message).toMatch(/Re-pick the edge on the edited model/i)
    }

    await engine.disposeAll()
  }, 120_000)

  it('#K4 REBUILD re-resolution scopes a shared raw bodyId to its Model Item, with omitted ids legacy-only', async () => {
    // Item A and item B each own a kernel document whose raw DAG body is F1.
    // The identical feature construction also gives their hole rims the same
    // stable edge id, so a bodyId-only classifier cannot detect a wrong item.
    const bodyA = await drilledPlate(HOLE_D0)
    const tessA = await engine.tessellate(bodyA, { deflection: 0.05 })
    const picked = findHoleRimEdgeId(tessA).id
    await engine.disposeAll()

    const bodyB0 = await drilledPlate(HOLE_D0)
    const verdicts = await engine.recognizeFeatures(bodyB0)
    const hole = verdicts.find((verdict) => verdict.featureClass === 'throughHole')
    expect(hole).toBeTruthy()
    const editedB = await engine.editFeature({
      featureId: 'E-item-b',
      body: bodyB0,
      featureKey: hole!.featureKey,
      delta: HOLE_D1 - HOLE_D0,
      kind: 'holeDiameter',
    })
    expect(editedB.ok, JSON.stringify(editedB.diagnostics ?? [])).toBe(true)
    const tessB1 = await engine.tessellate(editedB.body!, { deflection: 0.05 })
    expect(findHoleRimEdgeId(tessB1).id).toBe(picked)

    const op = (id: string, modelItemId: string | undefined): Operation => ({
      id,
      name: id,
      type: 'contour_2d',
      status: 'ready',
      modelReferences: [{
        bodyId: 'F1',
        ...(modelItemId === undefined ? {} : { modelItemId }),
        stableIds: [picked],
        role: 'edge-chain',
      }],
      toolpathMoves: [{ type: 'feed', x: 0, y: 0, z: -1, role: 'cut' }],
    } as unknown as Operation)
    const setup = {
      id: 'setup-rebuild',
      operations: [op('op-item-a', 'item-a'), op('op-item-b', 'item-b'), op('op-legacy', undefined)],
    } as unknown as Setup
    const current = useCamStore.getState()
    useCamStore.setState({
      activeModelItemId: 'item-b',
      workspace: 'part',
      lastModelReresolveSeq: {},
      modelRefsVerifiedSinceLoad: {},
      project: { ...current.project, setups: [setup] },
    })

    const changed = useCamStore.getState().reresolveModelReferences([{
      bodyId: 'F1',
      changed: true,
      resolutions: [{ id: picked, status: 'exact' }],
    }], 1)

    // The pass came from item B's real rebuild. Item A's separate F1 and the
    // legacy item's separate F1 remain untouched; omission is legacy-only.
    expect(changed).toEqual(['op-item-b'])
    const [itemA, itemB, legacy] = useCamStore.getState().project.setups[0].operations
    expect(itemA.status).toBe('ready')
    expect(itemB.status).toBe('outdated')
    expect(legacy.status).toBe('ready')
    expect(itemA.toolpathMoves).toEqual([{ type: 'feed', x: 0, y: 0, z: -1, role: 'cut' }])
    expect(itemA.modelReferences?.[0].modelItemId).toBe('item-a')
    expect(itemB.modelReferences?.[0].modelItemId).toBe('item-b')
    expect(legacy.modelReferences?.[0].modelItemId).toBeUndefined()
    expect(useCamStore.getState().modelRefsVerifiedSinceLoad).toEqual({ 'item-b': true })

    useCamStore.setState({ activeModelItemId: 'item-a' })
    expect(useCamStore.getState().reresolveModelReferences([{
      bodyId: 'F1',
      changed: false,
      resolutions: [{ id: picked, status: 'exact' }],
    }], 1)).toEqual([])
    expect(useCamStore.getState().modelRefsVerifiedSinceLoad).toEqual({
      'item-a': true,
      'item-b': true,
    })

    await engine.disposeAll()
  }, 180_000)

  it('#K5 stale and out-of-order passes never broaden per-item verification evidence', () => {
    const captured = {
      id: 'op-a',
      name: 'captured',
      type: 'contour_2d',
      status: 'ready',
      modelReferences: [{
        modelItemId: 'item-a', bodyId: 'F1', stableIds: ['edge-1'], role: 'edge-chain',
      }],
      toolpathMoves: [{ type: 'feed', x: 0, y: 0, z: -1, role: 'cut' }],
    } as unknown as Operation
    const mutated = { ...captured, name: 'mutated during resolve' }
    const setup = { id: 'setup-stale', operations: [mutated] } as unknown as Setup
    const current = useCamStore.getState()
    useCamStore.setState({
      activeModelItemId: 'item-a',
      lastModelReresolveSeq: {},
      modelRefsVerifiedSinceLoad: {},
      project: { ...current.project, setups: [setup] },
    })

    expect(useCamStore.getState().reresolveModelReferences([{
      bodyId: 'F1', changed: false, resolutions: [{ id: 'edge-1', status: 'exact' }],
    }], 3, new Map([['op-a', captured]]))).toEqual([])
    expect(useCamStore.getState().modelRefsVerifiedSinceLoad).toEqual({})

    expect(useCamStore.getState().reresolveModelReferences([{
      bodyId: 'F1', changed: false, resolutions: [{ id: 'edge-1', status: 'exact' }],
    }], 2)).toEqual([])
    expect(useCamStore.getState().modelRefsVerifiedSinceLoad).toEqual({})
  })
})
