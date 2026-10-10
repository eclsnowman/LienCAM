// P6 (ADR 0024 §2): an OWNED NEST SEED's op must compute its toolpath in the
// seed's LOCAL 2D frame, independent of the seed's SLOT pose, so P7 can later
// instance that one stored toolpath per placement.
//
// applyNestResult writes each seed's lower-left SLOT pose onto
// geometry.position/rotation while the seed's loops STAY local (store/index.ts
// ~5403). computeOperationToolpath normally bakes geometry.position/rotation
// into the loops via transformLoopPoints; for an owned seed (ownerNestId set)
// it must SKIP that bake and send the raw local points.
//
// These tests capture the loops posted to the toolpath Worker (postMessage runs
// synchronously inside computeOperationToolpath) and assert the frame:
//   (a) a seed-targeted op posts loops centered at the LOCAL origin (slot pose
//       subtracted) — NOT at the slot pose.
//   (b) an identical op on a NORMAL (non-seed) geometry posts WORLD-posed loops
//       (the slot pose baked in) — byte-identical to legacy behavior.
//   (c) an '__all__' op EXCLUDES owned seeds (their loops never reach the worker).

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { resolveOpGeometrySources, useCamStore } from '../../store'
import type {
  ImportedGeometry, SceneStock, PhysicalStock, BoundingBox, Vec3, Vec2, Project,
  Setup, Operation, WCS, Tool, HeightParams, PassParams, LinkingParams, NestRecord,
} from '../../types'
import { smartHeightAuthorityFixture } from '../helpers/smartHeightAuthorityFixture'

// -- Worker stub: capture every postMessage payload --------------------------
// A real Worker cannot be constructed in jsdom. The stub records the posted
// message so the test can inspect the loops the store sent. onmessage is never
// driven, so the op stays in 'computing' — we only assert the dispatched loops.

let postedPayloads: Array<{ type: string; payload: { loops?: Array<{ id: string; points: Vec2[] }> } }> = []
let OrigWorker: typeof Worker | undefined

function installWorkerStub(): void {
  OrigWorker = (globalThis as { Worker?: typeof Worker }).Worker
  ;(globalThis as { Worker?: unknown }).Worker = class {
    onmessage: ((e: unknown) => void) | null = null
    onerror: ((e: unknown) => void) | null = null
    postMessage(msg: { type: string; payload: { loops?: Array<{ id: string; points: Vec2[] }> } }): void {
      postedPayloads.push(msg)
    }
    terminate(): void { /* no-op */ }
  }
}

function restoreWorker(): void {
  ;(globalThis as { Worker?: unknown }).Worker = OrigWorker
}

// -- Geometry / project fixtures ---------------------------------------------

function bbox(min: Vec3, max: Vec3): BoundingBox {
  return {
    min: { ...min }, max: { ...max },
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
  }
}

// A unit-ish square whose LOCAL loop is centered on (0,0): corners +/-5.
const LOCAL_SQUARE: Vec2[] = [
  { x: -5, y: -5 }, { x: 5, y: -5 }, { x: 5, y: 5 }, { x: -5, y: 5 },
]

function bboxOfPoints(pts: Vec2[]): { minX: number; minY: number; maxX: number; maxY: number; cx: number; cy: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const p of pts) {
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }
  return { minX, minY, maxX, maxY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 }
}

function makeGeo(over: Partial<ImportedGeometry> = {}): ImportedGeometry {
  return {
    id: 'geo-1', name: 'WidgetPart', filename: 'part.dxf', type: 'curves_2d', format: 'dxf',
    boundingBox: bbox({ x: -5, y: -5, z: 0 }, { x: 5, y: 5, z: 0 }),
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    loops: [{
      id: 'loop-1',
      points: LOCAL_SQUARE.map(p => ({ ...p })),
      closed: true, type: 'contour', layerId: 'L1', area: 100,
    }],
    layers2d: [{ id: 'L1', name: 'Layer', color: '#00e5ff', visible: true }],
    stockId: 'stock-1', stockIdLocked: true,
    ...over,
  } as ImportedGeometry
}

function namedStock(id = 'stock-1', name = 'Stock 1'): PhysicalStock {
  return {
    id, name, mode: 'explicit',
    bounds: bbox({ x: -50, y: -50, z: -10 }, { x: 50, y: 50, z: 0 }),
    // stockWorldBounds places an 'explicit' stock at `position` (its MIN
    // corner) spanning upward by `bounds.size` -- position must be the min
    // corner, not (0,0,0), or Smart Height V2's owning-stock evidence (which
    // calls stockWorldBounds, unlike the pre-cutover path this fixture was
    // written against) resolves the stock top 10mm higher than intended and
    // trips the Clearance/Retract/Feed/Material-Start plane-order gate.
    position: { x: -50, y: -50, z: -10 },
  } as PhysicalStock
}

// A nest whose bound FIXED stock is the sheet the seed is cut from (ADR 0025
// Amd 3). Owned seeds are no-stock; their op resolves its stock coordinate
// frame from the owning nest's boundStockId (effectiveStockIdForCompute).
function makeNest(over: Partial<NestRecord> = {}): NestRecord {
  return {
    id: 'nest-1', name: 'Nest 1', boundStockId: 'stock-1',
    sheet: { width: 100, height: 100 },
    sources: [{ geometryId: 'seed-1', quantity: 1 }],
    placements: [], unplaced: [], utilization: 0,
    ...over,
  } as NestRecord
}

function autoSceneStock(over: Partial<SceneStock> = {}): SceneStock {
  return {
    mode: 'auto', autoOffsetXY: 2, autoOffsetZTop: 1,
    fixedWidth: 100, fixedHeight: 100, fixedDepth: 12, fixedStocks: [], ...over,
  }
}

// Absolute top/bottom so the owning-stock plane resolvers are never invoked —
// keeps the test focused on the loop-FRAME decision, not height resolution.
const heights: HeightParams = {
  clearanceHeight: 10, clearanceHeightMode: 'relative',
  retractHeight: 5, feedHeight: 1,
  topHeight: 0, topHeightMode: 'absolute',
  bottomHeight: -5, bottomHeightMode: 'absolute',
}
const passes: PassParams = {
  stepdown: 1.5, stepover: 3, stockToLeave: 0, finishPasses: 0, springPasses: 0,
}
const linking: LinkingParams = {
  entryType: 'plunge', rampAngle: 2, rampLength: 5,
  leadInRadius: 1.5, leadOutRadius: 1, retractType: 'full', transitionType: 'safe_height',
}

// Every op needs a valid Smart Height V2 authority to compute at all (commit
// 2e5678b7). Contour's materialStart is always 'current_material' regardless
// of variant, which needs a PROVEN owning stock -- so this also requires
// makeWcs() below to bind the setup to 'stock-1' (setupProvenStockId).
// `heightGeometryIds` is separate from the loop-aggregation `geometryId`
// param: Smart Height's own scope must name a REAL geometry id that resolves
// to 'stock-1' (the '__all__' aggregation token itself does not exist as a
// geometry and would refuse height evidence lookup), so callers that use
// '__all__' pass a concrete id instead.
function makeOp(geometryId: string, heightGeometryIds: string[] = [geometryId]): Operation {
  return {
    id: 'op-1', name: 'Profile Cut', type: 'contour_2d', enabled: true, status: 'ready',
    toolId: 'tool-1', geometrySelections: ['loop-1'],
    heights: structuredClone(heights),
    passes: structuredClone(passes),
    linking: structuredClone(linking),
    params: { geometryId, side: 'outside', direction: 'climb' },
    smartHeight: smartHeightAuthorityFixture('contour_2d', {
      setupId: 'setup-1',
      geometryIds: heightGeometryIds,
      heights,
    }),
  }
}

function makeWcs(): WCS {
  return {
    id: 'wcs-1', label: 'G54', fixtureOffset: 54, origin: { x: 0, y: 0, z: 0 },
    xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
    stockId: 'stock-1',
  }
}

function makeSetup(op: Operation): Setup {
  return {
    id: 'setup-1', name: 'Setup 1', wcs: makeWcs(),
    stock: {
      type: 'rectangular', width: 100, height: 100, depth: 12,
      offsetX: 2, offsetY: 2, offsetZTop: 1, offsetZBottom: 0, material: 'al',
    },
    operations: [op], notes: '',
  }
}

const tool: Tool = {
  id: 'tool-1', name: 'EM6', type: 'flat_end_mill', diameter: 6,
  fluteLength: 20, shankDiameter: 6, overallLength: 50, numberOfFlutes: 2,
} as Tool

function installProject(geometry: ImportedGeometry[], op: Operation, stocks: PhysicalStock[]): void {
  useCamStore.setState((s) => ({
    toolLibrary: [tool],
    project: {
      ...s.project,
      geometry,
      stocks,
      nests: [makeNest()],
      setups: [makeSetup(op)],
      sceneStock: autoSceneStock(),
    } as Project,
  }))
}

function postedLoops(): Array<{ id: string; points: Vec2[] }> {
  const last = postedPayloads[postedPayloads.length - 1]
  return last?.payload?.loops ?? []
}

// =============================================================================

describe('computeOperationToolpath: owned-seed ops compute in the LOCAL frame (P6)', () => {
  beforeEach(() => {
    postedPayloads = []
    installWorkerStub()
  })
  afterEach(() => {
    restoreWorker()
  })

  it('(a) a seed-targeted op posts loops centered at the LOCAL origin, NOT the slot pose', () => {
    // Seed at a far slot pose (position 100,200) with LOCAL loops (centered on 0,0).
    const seed = makeGeo({
      id: 'seed-1', name: 'Seed Part', ownerNestId: 'nest-1',
      position: { x: 100, y: 200, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
    })
    installProject([seed], makeOp('seed-1'), [namedStock()])

    useCamStore.getState().computeOperationToolpath('setup-1', 'op-1')

    const loops = postedLoops()
    expect(loops.length).toBe(1)
    const bb = bboxOfPoints(loops[0].points)
    // Local frame: centered on (0,0), NOT translated to the slot (100,200).
    expect(bb.cx).toBeCloseTo(0, 6)
    expect(bb.cy).toBeCloseTo(0, 6)
    expect(bb.minX).toBeCloseTo(-5, 6)
    expect(bb.maxX).toBeCloseTo(5, 6)
  })

  it('(a2) the slot ROTATION is also not baked for a seed op', () => {
    // 90 deg slot rotation would skew a baked square; local frame keeps it square.
    const seed = makeGeo({
      id: 'seed-1', name: 'Seed Part', ownerNestId: 'nest-1',
      position: { x: 100, y: 200, z: 0 }, rotation: { x: 0, y: 0, z: 90 },
    })
    installProject([seed], makeOp('seed-1'), [namedStock()])

    useCamStore.getState().computeOperationToolpath('setup-1', 'op-1')

    const bb = bboxOfPoints(postedLoops()[0].points)
    // Untransformed local square: corners exactly +/-5 on both axes, centered 0,0.
    expect(bb.cx).toBeCloseTo(0, 6)
    expect(bb.cy).toBeCloseTo(0, 6)
    expect(bb.minX).toBeCloseTo(-5, 6)
    expect(bb.maxX).toBeCloseTo(5, 6)
    expect(bb.minY).toBeCloseTo(-5, 6)
    expect(bb.maxY).toBeCloseTo(5, 6)
  })

  it('(b) an identical op on a NORMAL (non-seed) geometry posts WORLD-posed loops (pose baked)', () => {
    // Same geometry + same slot-like pose, but ownerNestId is undefined -> normal
    // part -> the position must be baked into the loops (legacy behavior).
    const part = makeGeo({
      id: 'geo-1', name: 'Free Part', ownerNestId: undefined,
      position: { x: 100, y: 200, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
    })
    installProject([part], makeOp('geo-1'), [namedStock()])

    useCamStore.getState().computeOperationToolpath('setup-1', 'op-1')

    const bb = bboxOfPoints(postedLoops()[0].points)
    // World frame: square centered at the part's world position (100,200).
    expect(bb.cx).toBeCloseTo(100, 6)
    expect(bb.cy).toBeCloseTo(200, 6)
    expect(bb.minX).toBeCloseTo(95, 6)
    expect(bb.maxX).toBeCloseTo(105, 6)
  })

  it('(c) an "__all__" op EXCLUDES owned seeds and hidden parts', () => {
    // One owned seed (far slot), one hidden part, and one free visible part.
    // An '__all__' op must pull in ONLY the free visible part.
    const seed = makeGeo({
      id: 'seed-1', name: 'Seed Part', ownerNestId: 'nest-1',
      position: { x: 100, y: 200, z: 0 },
    })
    const hidden = makeGeo({
      id: 'hidden-1', name: 'Hidden Part', hidden: true,
      loops: [{
        id: 'hidden-loop', points: LOCAL_SQUARE.map(p => ({ ...p })),
        closed: true, type: 'contour', layerId: 'L1', area: 100,
      }],
    })
    const free = makeGeo({
      id: 'free-1', name: 'Free Part', ownerNestId: undefined,
      position: { x: 0, y: 0, z: 0 },
      loops: [{
        id: 'free-loop', points: LOCAL_SQUARE.map(p => ({ ...p })),
        closed: true, type: 'contour', layerId: 'L1', area: 100,
      }],
    })
    installProject([seed, hidden, free], makeOp('__all__', ['free-1']), [namedStock()])

    useCamStore.getState().computeOperationToolpath('setup-1', 'op-1')

    const loops = postedLoops()
    const ids = loops.map(l => l.id)
    expect(ids).toContain('free-loop')
    expect(ids).not.toContain('loop-1') // the seed's loop id
    expect(ids).not.toContain('hidden-loop')
    expect(loops.length).toBe(1)

    // Hiding only removes a part from the aggregate. A direct operation remains
    // a deliberate reference and must continue to resolve it.
    expect(resolveOpGeometrySources([seed, hidden, free], 'hidden-1')).toEqual([hidden])
  })
})
