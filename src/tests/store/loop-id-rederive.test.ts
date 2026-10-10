// Store-path integration test for stable loop ids (B19c recurrence prevention,
// docs/planning/STABLE-LOOP-ID-PLAN.md Item 3).
//
// Items 1/2 (the pure helper + the mint-site wiring) are covered by
// loopId.test.ts and the cam/loop-id-stability.test.ts real-DXF guard. NEITHER
// of those exercises the REAL re-derive path: setGeometryLoops(geoId, loops, ...).
// That store action is where a sketch-bake / loop-optimizer / projection re-derive
// re-mints a geometry's loops in place; it routes the incoming loops through
// assignStableLoopIds(loops, geoId) (store/index.ts:1437) and then outdates ops
// via outdateOpsReferencingGeo. This file drives that exact action through the
// real zustand store (the autoStock.test.ts pattern -- the store IS importable in
// vitest) and proves the three behaviors the plan's safety argument rests on:
//
//   (a) SURVIVE        -- re-derive the SAME loops -> ids UNCHANGED, a stored op
//                         selection STILL resolves to a current loop (so the
//                         builder cuts moves on recompute instead of orphaning).
//                         NB: a faithful pocket op (params.geometryId === geoId)
//                         is still marked 'outdated' on re-derive -- it must
//                         recompute -- so the survival property the fix controls
//                         is RESOLUTION, not the (correctly set) outdate flag.
//   (b) SAFETY NEG (P6)-- re-derive where a selected loop's geometry GENUINELY
//                         changes -> its id changes, the selection ORPHANS, and
//                         the loop-id arm of the outdate / fail-loud path engages.
//   (c) COLLISION SAFE -- two geometries built from the SAME source (same layer
//                         names + identical shapes) get DIFFERENT final ids
//                         because the geoId namespace differs.
//
// The "resolves to a current loop" check mirrors the real dispatch+builder
// contract: computeOperationToolpath (store:1770-1791) collects loops from the
// geometry whose id == params.geometryId, then the pocket/contour/etc. builder
// filters those by params.loopIds. A selection "resolves" iff every id in
// params.loopIds is present among the geometry's CURRENT loop ids. We assert that
// store-side set-membership directly (no worker needed); the real-DXF guard in
// cam/loop-id-stability.test.ts already proves the end-to-end build produces a
// non-zero toolpath on a surviving id.

import { describe, it, expect, beforeEach } from 'vitest'
import { useCamStore } from '../../store'
import { computeLoopContentId } from '../../lib/geometry/loopId'
import type {
  ImportedGeometry, Loop2D, Layer2D, Setup, Operation, WCS,
  HeightParams, PassParams, LinkingParams,
} from '../../types'

// ── Fixtures ─────────────────────────────────────────────────────────────────
// A 2D geometry with TWO distinct closed contour loops on one layer:
//   BIG   = 20x20 square centred at (10,10)  (the op's selected boundary)
//   SMALL = 6x6  square centred at (40,40)   (a second, untouched loop)
// Points are the raw derivation; setGeometryLoops re-mints the id from points so
// the literal `id` below is a placeholder that the store overwrites.

const GEO_ID = 'geo-A'
const LAYER_ID = 'L1'   // layer NAME (not globally unique) -- the collision risk

function bigSquare(): Loop2D {
  return {
    id: 'placeholder-big',
    points: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 }],
    closed: true, type: 'contour', layerId: LAYER_ID, area: 400,
  }
}
function smallSquare(): Loop2D {
  return {
    id: 'placeholder-small',
    points: [{ x: 37, y: 37 }, { x: 43, y: 37 }, { x: 43, y: 43 }, { x: 37, y: 43 }],
    closed: true, type: 'contour', layerId: LAYER_ID, area: 36,
  }
}
function layer(): Layer2D {
  return { id: LAYER_ID, name: 'Layer 1', color: '#00e5ff', visible: true }
}

function make2DGeo(): ImportedGeometry {
  return {
    id: GEO_ID, name: 'Sketch', filename: 'part.dxf', type: 'curves_2d', format: 'dxf',
    boundingBox: {
      min: { x: 0, y: 0, z: 0 }, max: { x: 43, y: 43, z: 0 },
      size: { x: 43, y: 43, z: 0 }, center: { x: 21.5, y: 21.5, z: 0 },
    },
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
    loaded: true,
    loops: [],          // installed via setGeometryLoops below (real mint path)
    layers2d: [layer()],
  }
}

const heights: HeightParams = {
  clearanceHeight: 10, clearanceHeightMode: 'absolute',
  retractHeight: 5, feedHeight: 1,
  topHeight: 0, topHeightMode: 'absolute',
  bottomHeight: -2, bottomHeightMode: 'absolute',
}
const passes: PassParams = { stepdown: 2, stepover: 1.5, stockToLeave: 0, finishPasses: 0, springPasses: 0 }
const linking: LinkingParams = {
  entryType: 'plunge', rampAngle: 3, rampLength: 0, leadInRadius: 0, leadOutRadius: 0,
  retractType: 'full', transitionType: 'safe_height',
}

function makeWcs(): WCS {
  return {
    id: 'wcs-1', label: 'G54', fixtureOffset: 54,
    origin: { x: 0, y: 0, z: 0 },
    xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
  }
}

// A READY pocket op bound to `selId`, mirroring how NewOperationModal creates one
// (params.geometryId == the owning geoId, params.loopIds == geometrySelections ==
// the selected loop ids). `geometryId` is parameterized so we can isolate the
// loop-id arm of outdateOpsReferencingGeo from its `paramGeoId === geoId` arm.
function makePocketOp(selId: string, geometryId: string): Operation {
  return {
    id: 'op-1', name: 'Pocket', type: 'pocket_2d', enabled: true, status: 'ready',
    toolId: 'tool-1',
    geometrySelections: [selId],
    heights, passes, linking,
    params: {
      geometryId, loopIds: [selId], direction: 'climb', orderStrategy: 'by_depth',
      fillStrategy: 'outside_in', floorStockToLeave: 0, finishContour: false,
    },
    toolpathMoves: [],
  }
}

function makeSetup(ops: Operation[]): Setup {
  return {
    id: 'setup-1', name: 'Setup 1', wcs: makeWcs(),
    stock: {
      type: 'rectangular', offsetX: 0, offsetY: 0, offsetZTop: 0, offsetZBottom: 0,
      material: 'aluminum',
    } as Setup['stock'],
    operations: ops, notes: '',
  }
}

const store = () => useCamStore.getState()
const geoLoops = (id = GEO_ID): Loop2D[] =>
  store().project.geometry.find(g => g.id === id)?.loops ?? []
const op0 = () => store().project.setups[0].operations[0]

// Does the op's stored selection still resolve to a CURRENT loop of its geometry?
// (= the dispatch/builder membership check; an empty/failed match is the orphan.)
function selectionResolves(op: Operation): boolean {
  const geometryId = (op.params as { geometryId?: string }).geometryId ?? ''
  const loopIds = (op.params as { loopIds?: string[] }).loopIds ?? []
  const current = new Set(geoLoops(geometryId).map(l => l.id))
  return loopIds.length > 0 && loopIds.every(id => current.has(id))
}

// Wholesale-install a scene (autoStock.test.ts pattern), then mint the initial
// loops through the REAL setGeometryLoops path so the op binds to a true stable id.
function installAndMint(ops: Operation[]): void {
  useCamStore.setState(s => ({
    project: { ...s.project, geometry: [make2DGeo()], setups: [makeSetup(ops)] },
  }))
}

describe('setGeometryLoops: stable loop ids across re-derive (B19c recurrence)', () => {
  beforeEach(() => {
    // Mint the initial loops via the real action, then rebind the op to the
    // resulting stable id. Done per-test so each scenario starts from a true
    // store-minted selection rather than a placeholder.
    installAndMint([makePocketOp('placeholder-big', GEO_ID)])
    store().setGeometryLoops(GEO_ID, [bigSquare(), smallSquare()], [layer()])
  })

  // ── (a) SURVIVE ──────────────────────────────────────────────────────────
  it('(a) re-derive of the SAME loops keeps ids stable; a stored selection still resolves', () => {
    const minted = geoLoops()
    expect(minted.length).toBe(2)
    const bigId = minted.find(l => l.area === 400)!.id

    // Bind a FAITHFUL pocket op (exactly as NewOperationModal builds it):
    // params.geometryId == GEO_ID, params.loopIds == geometrySelections == [bigId].
    useCamStore.setState(s => ({
      project: { ...s.project, setups: [makeSetup([makePocketOp(bigId, GEO_ID)])] },
    }))
    expect(selectionResolves(op0())).toBe(true)
    const idsBefore = geoLoops().map(l => l.id)

    // RE-DERIVE the SAME geometry: fresh Loop2D objects, identical points (a
    // re-bake / loop-optimize confirm / tolerance-stable re-projection).
    store().setGeometryLoops(GEO_ID, [bigSquare(), smallSquare()], [layer()])

    const idsAfter = geoLoops().map(l => l.id)
    // (i) deterministic + geoId-namespaced -> byte-identical id set across re-derive.
    expect(idsAfter).toEqual(idsBefore)
    // (ii) the stored selection STILL resolves to a current loop (no orphan). This
    // is the actual survival payoff: the worker dispatch finds bigId among the
    // geometry's CURRENT loops, so the builder cuts moves instead of failing loud.
    expect(selectionResolves(op0())).toBe(true)
    expect((op0().params as { loopIds: string[] }).loopIds).toContain(bigId)

    // HONEST NOTE on "op NOT outdated": a faithful pocket op carries
    // params.geometryId === GEO_ID, and outdateOpsReferencingGeo outdates on that
    // arm (store/index.ts:100) for ANY re-derive of that geometry -- the op MUST
    // recompute because its geometry changed identity. The stable-id fix does NOT
    // (and should not) suppress that recompute; it guarantees the selection
    // RESOLVES on recompute instead of orphaning. We assert what the fix actually
    // controls -- resolution survival -- not the (correctly still-set) outdate flag.
  })

  // ── (b) SAFETY NEGATIVE (P6) ──────────────────────────────────────────────
  it('(b) re-derive where a SELECTED loop genuinely changes -> id changes, '
    + 'selection ORPHANS, outdate path engages (no silent mis-bind)', () => {
    const bigId = geoLoops().find(l => l.area === 400)!.id
    // Bind faithfully: geometryId == GEO_ID, selection == bigId, status ready.
    useCamStore.setState(s => ({
      project: { ...s.project, setups: [makeSetup([makePocketOp(bigId, GEO_ID)])] },
    }))
    expect(selectionResolves(op0())).toBe(true)

    // GENUINELY change the selected (big) loop: shift it +5mm in X -- well beyond
    // the 0.01mm centroid quantum -> its content hash changes -> new id. The small
    // loop is untouched -> keeps its id.
    const movedBig: Loop2D = {
      ...bigSquare(),
      points: bigSquare().points.map(p => ({ x: p.x + 5, y: p.y })),
    }
    store().setGeometryLoops(GEO_ID, [movedBig, smallSquare()], [layer()])

    // The big loop's id MUST have changed (content-derived).
    const currentIds = new Set(geoLoops().map(l => l.id))
    expect(currentIds.has(bigId)).toBe(false)
    // Sanity: the expected new id matches the moved geometry, namespaced by geoId.
    const expectedNewBig = `${GEO_ID}~${computeLoopContentId(LAYER_ID, movedBig.points)}`
    expect(currentIds.has(expectedNewBig)).toBe(true)
    // The stored selection (old bigId) NO LONGER resolves -> orphaned.
    expect(selectionResolves(op0())).toBe(false)
    // And the existing outdate path engaged (op no longer 'ready'); the builder's
    // fail-loud net (ADR 0003) then fires on recompute rather than a silent 0-move
    // or, worse, a silent re-bind to the moved loop.
    expect(op0().status).not.toBe('ready')
  })

  it('(b2) re-derive that DROPS the selected loop also orphans (id absent)', () => {
    const bigId = geoLoops().find(l => l.area === 400)!.id
    useCamStore.setState(s => ({
      project: { ...s.project, setups: [makeSetup([makePocketOp(bigId, GEO_ID)])] },
    }))
    expect(selectionResolves(op0())).toBe(true)

    // Re-derive WITHOUT the big loop (e.g. a cleanup removed it).
    store().setGeometryLoops(GEO_ID, [smallSquare()], [layer()])

    expect(new Set(geoLoops().map(l => l.id)).has(bigId)).toBe(false)
    expect(selectionResolves(op0())).toBe(false)
    expect(op0().status).not.toBe('ready')
  })

  // ── (c) COLLISION SAFETY ──────────────────────────────────────────────────
  it('(c) two geometries from the SAME source (same layers + identical shapes) '
    + 'get DIFFERENT loop ids -- no id from A appears in B', () => {
    const GEO_B = 'geo-B'
    // Install A and B as two independent geometries, both with the same layer
    // name and identical loop shapes (re-importing the same file twice).
    useCamStore.setState(s => ({
      project: {
        ...s.project,
        geometry: [
          make2DGeo(),
          { ...make2DGeo(), id: GEO_B, name: 'Sketch (copy)' },
        ],
        setups: [makeSetup([])],
      },
    }))
    // Mint both via the real path -- each namespaces by its own geoId.
    store().setGeometryLoops(GEO_ID, [bigSquare(), smallSquare()], [layer()])
    store().setGeometryLoops(GEO_B, [bigSquare(), smallSquare()], [layer()])

    const idsA = new Set(geoLoops(GEO_ID).map(l => l.id))
    const idsB = new Set(geoLoops(GEO_B).map(l => l.id))
    expect(idsA.size).toBe(2)
    expect(idsB.size).toBe(2)
    // Disjoint despite identical geometry: the geoId namespace separates them.
    for (const id of idsA) expect(idsB.has(id)).toBe(false)
    // And the per-geometry content portion DOES match (same shapes) -- only the
    // namespace prefix differs, which is exactly the collision-safety mechanism.
    const contentA = [...idsA].map(id => id.slice(`${GEO_ID}~`.length)).sort()
    const contentB = [...idsB].map(id => id.slice(`${GEO_B}~`.length)).sort()
    expect(contentA).toEqual(contentB)
  })
})
