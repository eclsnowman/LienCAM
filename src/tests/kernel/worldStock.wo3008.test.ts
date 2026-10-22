// WO-3008 08a: the kernel stock record (A3-08 steps 2, 3, 7).
//
// Independent truths: today's membership rules (src/store/stockAssignment.ts,
// src/store/dispatchGeo.ts, read-only) and the box the REAL viewport draws
// (CNCViewport.rebuildStock + getStockBounds, the method getStockBoundsFromViewport
// reads) from the same project, on every P0 measuring-stick chain and every
// example project. The service reads no viewport.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { useCamStore } from '../../store'
import { CNCViewport } from '../../lib/viewport/CNCViewport'
import {
  assignGeometryToStocks, deriveStockBounds, derivedStockMembers, effectiveStockIdForCompute,
  resolveStockMembershipState, stockWorldBounds,
} from '../../store/stockAssignment'
import { geometryWorldBounds } from '../../store/dispatchGeo'
import { DERIVED_STOCK_ID } from '../../store/migrateHierarchy'
import { resolveTabs } from '../../kernel/workholding/tabs'
import {
  CATCH_ALL_STOCK_ID, NON_BOX_STOCK_LINE, PARITY_POLICY, cuttingStockId, derivedStockAabb, explicitStockAabb,
  geometryWorldAabb, isStockMember, membership, membershipState, stockBottomWcsZ, stockBounds, stockFootprint,
  stockKind, type Aabb, type WorldRecord, type WorldSetup,
} from '../../kernel/world'
import { alpha3Chains } from '../benchmark/registry'
import { chainScene } from '../benchmark/chainRunner'
import type { ImportedGeometry, NestRecord, PhysicalStock, Project, SceneStock, Setup } from '../../types'

const EVIDENCE = 'src/tests/evidence/WO-3008'
/** The viewport draws a Float32 BoxGeometry, so its box carries Float32 rounding of the half-sizes. */
const VIEWPORT_FLOAT32_MM = 1e-4

// ── The viewport, really: rebuildStock + getStockBounds on a prototype harness ──
function viewportBounds(project: Pick<Project, 'stocks' | 'sceneStock'>, stockId: string | undefined): Aabb | null {
  useCamStore.setState(state => ({ project: { ...state.project, stocks: [...(project.stocks ?? [])] } }))
  const vp = Object.create(CNCViewport.prototype)
  Object.assign(vp, {
    partGroups: new Map(), partMaterials: new Map(), materialBaselines: new Map(), currentShadingMode: 'shaded-edges',
    projectedLoopGroups: new Map(), geometry2dGroups: new Map(), geometry2dLayerMats: new Map(),
    layer2dRequestedVisible: new Map(), nestGroups: new Map(), fixedStockBoxes: new Map(), selectableObjects: [],
    wcsFixed: true, _stockBounds: null, workpieceGroup: new THREE.Group(), stockGroup: new THREE.Group(),
    toolpathGroup: new THREE.Group(), wcsGroup: new THREE.Group(), currentStockConfig: project.sceneStock,
    updateSelectableObjects: () => {}, applyShadingMode: () => {},
  })
  vp.rebuildStock(project.sceneStock)
  return vp.getStockBounds(stockId)
}

const corners = (b: Aabb | null) => b && [b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z]
function maxDelta(a: Aabb | null, b: Aabb | null): number {
  if (!a || !b) return a === b ? 0 : Infinity
  const ca = corners(a)!, cb = corners(b)!
  return Math.max(...ca.map((v, i) => Math.abs(v - cb[i])))
}

// ── The fixtures: every P0 chain's scene and every example project ──
interface Case { id: string; record: WorldRecord; setups: Setup[]; rows: string[] }

function exampleCases(): Case[] {
  return readdirSync('examples', { withFileTypes: true }).filter(entry => entry.isDirectory())
    .flatMap(dir => readdirSync(`examples/${dir.name}`).filter(file => file.endsWith('.camproject'))
      .map(file => `examples/${dir.name}/${file}`))
    .sort()
    .map(path => {
      const project = JSON.parse(readFileSync(path, 'utf8')) as Project
      return { id: path, record: project, setups: project.setups, rows: [] }
    })
}

async function p0Cases(): Promise<{ cases: Case[]; noScene: string[] }> {
  const cases = new Map<string, Case>()
  const noScene: string[] = []
  for (const chain of alpha3Chains()) {
    const rows = chain.steps.map(step => `${chain.id}/${step.id}`)
    // planChain stands no scene up for a chain whose every step is n/a; neither does this.
    if (chain.steps.every(step => step.unavailableReason)) { noScene.push(chain.id); continue }
    if (chain.alpha3?.project) {
      const id = `p0:${chain.id}`
      cases.set(id, { id, record: chain.alpha3.project, setups: chain.alpha3.project.setups, rows })
      continue
    }
    const scene = await chainScene(chain)
    const id = `p0:${chain.id}`
    cases.set(id, {
      id,
      record: { stocks: [scene.physicalStock], sceneStock: scene.sceneStock, geometry: [scene.geometry],
        modelItemPlacements: scene.modelItemPlacements },
      setups: scene.setups,
      rows,
    })
  }
  return { cases: [...cases.values()], noScene }
}

function compareCase(c: Case) {
  const stocks = c.record.stocks ?? []
  const setups = c.setups.map(setup => {
    const record = stockBounds(c.record, setup)
    const viewport = viewportBounds(c.record as Project, setup.wcs.stockId ?? undefined)
    const delta = maxDelta(record.ok ? record.bounds : null, viewport)
    return { setupId: setup.id, stockId: setup.wcs.stockId ?? null, source: record.ok ? record.source : 'no-stock',
      record: record.ok ? record.bounds : null, viewport, maxDeltaMm: delta, equal: delta <= VIEWPORT_FLOAT32_MM }
  })
  const placements = c.record.modelItemPlacements ?? []
  const geometry = c.record.geometry.map(geo => {
    const todayBox = geometryWorldBounds(geo, placements)
    const box = geometryWorldAabb(geo, c.record)
    const todayAssigned = assignGeometryToStocks([geo], [...stocks])[0].stockId
    const todayOwner = effectiveStockIdForCompute(geo, c.record.nests ?? [], stocks)
    return { id: geo.id, equal: JSON.stringify(todayBox) === JSON.stringify(box) &&
      todayAssigned === membership(geo, stocks).stockId && todayOwner === cuttingStockId(geo, c.record) &&
      resolveStockMembershipState(geo, stocks) === membershipState(geo, stocks) }
  })
  const stockRows = stocks.map(stock => {
    const offsets = c.record.sceneStock.autoStocks?.find(item => item.id === stock.id) ?? c.record.sceneStock
    const today = stock.mode === 'explicit' ? stockWorldBounds(stock)
      : deriveStockBounds(stock, c.record.geometry, offsets, placements, stocks)
    const mine = stock.mode === 'explicit' ? explicitStockAabb(stock) : derivedStockAabb(stock, c.record)
    const todayMembers = derivedStockMembers(stock, c.record.geometry, stocks).map(geo => geo.id)
    const members = c.record.geometry.filter(geo => isStockMember(geo, stock, c.record)).map(geo => geo.id)
    return { id: stock.id, mode: stock.mode, equal: JSON.stringify(corners(today as Aabb | null)) === JSON.stringify(corners(mine)) &&
      JSON.stringify(todayMembers) === JSON.stringify(members) }
  })
  return { id: c.id, rows: c.rows, setups, geometry, stocks: stockRows }
}

function save(name: string, value: unknown) {
  mkdirSync(EVIDENCE, { recursive: true })
  writeFileSync(`${EVIDENCE}/${name}`, JSON.stringify(value, null, 2) + '\n')
}

// ── Unit fixtures for the membership rules ──
const bb = (min: [number, number, number], max: [number, number, number]) => ({
  min: { x: min[0], y: min[1], z: min[2] }, max: { x: max[0], y: max[1], z: max[2] },
  size: { x: max[0] - min[0], y: max[1] - min[1], z: max[2] - min[2] },
  center: { x: (min[0] + max[0]) / 2, y: (min[1] + max[1]) / 2, z: (min[2] + max[2]) / 2 },
})
const explicit = (id: string, min: [number, number, number], max: [number, number, number]): PhysicalStock =>
  ({ id, name: id, mode: 'explicit', bounds: bb(min, max), position: { x: min[0], y: min[1], z: min[2] } })
const derived = (id: string): PhysicalStock =>
  ({ id, name: id, mode: 'derived', bounds: bb([0, 0, 0], [0, 0, 0]), position: { x: 0, y: 0, z: 0 } })
const mesh = (id: string, over: Partial<ImportedGeometry> = {}): ImportedGeometry => ({
  id, name: id, filename: `${id}.step`, type: 'brep', format: 'step', boundingBox: bb([-5, -5, 0], [5, 5, 10]),
  position: { x: 20, y: 20, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true, ...over,
})
const sceneStock: SceneStock = { mode: 'auto', autoOffsetXY: 2, autoOffsetZTop: 1, autoOffsetZBottom: 3,
  fixedWidth: 100, fixedHeight: 100, fixedDepth: 10, fixedStocks: [] }

const unitGeometry: ImportedGeometry[] = [
  mesh('in-small'), // inside both explicit blocks: the smaller wins
  mesh('tilted', { rotation: { x: 90, y: 0, z: 37 }, position: { x: 200, y: 0, z: 5 } }),
  mesh('locked-none', { stockIdLocked: true }),
  mesh('locked-big', { stockIdLocked: true, stockId: 'big' }),
  mesh('workholding', { workholding: true, stockId: CATCH_ALL_STOCK_ID }),
  mesh('seed', { ownerNestId: 'nest-1', stockIdLocked: true }),
  { ...mesh('flat-2d'), type: 'curves_2d', format: 'dxf', rotation: { x: 180, y: 180, z: -10 },
    loops: [{ id: 'l', closed: true, type: 'contour', layerId: '0', area: 180, points: [{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 12 }] }] },
  { ...mesh('model-placed'), format: 'model', type: 'model', modelItemId: 'item-1', position: { x: 0, y: 0, z: 0 },
    modelBody: { ref: { bodyId: 'body-1', lineageId: 'body-1', stableIds: [], version: 1 },
      display: { positions: [], indices: [], normals: [], edgePositions: [], edgeOffsets: [], bbox: { min: [0, 0, 0], max: [8, 4, 2] } } } },
  { ...mesh('model-unplaced'), format: 'model', type: 'model', modelItemId: 'item-2', position: { x: 0, y: 0, z: 0 },
    modelBody: { ref: { bodyId: 'body-2', lineageId: 'body-2', stableIds: [], version: 1 },
      display: { positions: [], indices: [], normals: [], edgePositions: [], edgeOffsets: [], bbox: { min: [0, 0, 0], max: [1, 1, 1] } } } },
]
const unitStocks = [explicit('big', [0, 0, 0], [100, 100, 20]), explicit('small', [10, 10, 0], [40, 40, 15]), derived(DERIVED_STOCK_ID)]
const unitRecord: WorldRecord = {
  stocks: unitStocks, sceneStock, geometry: unitGeometry,
  modelItemPlacements: [{ modelItemId: 'item-1', bodyId: 'body-1', position: { x: 3, y: 4, z: 5 }, rotation: { x: 0, y: 90, z: 0 } }],
  nests: [{ id: 'nest-1', boundStockId: 'small' }] as unknown as NestRecord[],
}
const setupOn = (stockId: string | undefined, type: Setup['stock']['type'] = 'rectangular'): WorldSetup => ({
  id: 's', wcs: { id: 'w', label: 'G54', fixtureOffset: 54, origin: { x: 0, y: 0, z: 7 }, xAxis: { x: 1, y: 0, z: 0 },
    yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 }, stockId },
  stock: { type, offsetX: 0, offsetY: 0, offsetZTop: 0, offsetZBottom: 0, material: 'aluminum' },
})

describe('WO-3008 kernel stock record', () => {
  it('membership rules equal today\'s stockAssignment/dispatchGeo rules on unit fixtures', () => {
    expect(PARITY_POLICY).toEqual({ rotated_part_placement: false, loop_type_from_nesting: false })
    expect(CATCH_ALL_STOCK_ID).toBe(DERIVED_STOCK_ID)
    const placements = unitRecord.modelItemPlacements!
    const today = assignGeometryToStocks(unitGeometry, unitStocks)
    expect(unitGeometry.map(geo => membership(geo, unitStocks).stockId)).toEqual(today.map(geo => geo.stockId))
    expect(unitGeometry.map(geo => membership(geo, unitStocks).stockId))
      .toEqual(['small', DERIVED_STOCK_ID, undefined, 'big', 'small', undefined, DERIVED_STOCK_ID, undefined, undefined])
    expect(unitGeometry.map(geo => geometryWorldAabb(geo, unitRecord))).toEqual(unitGeometry.map(geo => geometryWorldBounds(geo, placements)))
    expect(unitGeometry.map(geo => cuttingStockId(geo, unitRecord)))
      .toEqual(unitGeometry.map(geo => effectiveStockIdForCompute(geo, unitRecord.nests ?? [], unitStocks)))
    expect(unitGeometry.map(geo => membershipState(geo, unitStocks)))
      .toEqual(unitGeometry.map(geo => resolveStockMembershipState(geo, unitStocks)))
    const assigned = { ...unitRecord, geometry: today }
    for (const stock of unitStocks) {
      expect(today.filter(geo => isStockMember(geo, stock, assigned)).map(geo => geo.id))
        .toEqual(derivedStockMembers(stock, today, unitStocks).map(geo => geo.id))
    }
    const catchAll = unitStocks[2]
    expect(derivedStockAabb(catchAll, assigned)).toEqual(
      (({ min, max }) => ({ min, max }))(deriveStockBounds(catchAll, today, sceneStock, placements, unitStocks)!))
    expect(explicitStockAabb(unitStocks[1])).toEqual(stockWorldBounds(unitStocks[1]))
  })

  it('stock kinds: box built; mesh, cylinder and cast plan from the bounding box and say so in one line', () => {
    const box = stockBounds(unitRecord, setupOn('small'))
    const cylinder = stockBounds(unitRecord, setupOn('small', 'cylindrical'))
    const fromModel = stockBounds(unitRecord, setupOn('small', 'from_model'))
    expect(box).toEqual({ ok: true, source: 'explicit', stockId: 'small', kind: 'box',
      bounds: { min: { x: 10, y: 10, z: 0 }, max: { x: 40, y: 40, z: 15 } } })
    expect(cylinder).toEqual({ ...box, kind: 'cylinder', line: NON_BOX_STOCK_LINE })
    expect(fromModel).toEqual({ ...box, kind: 'mesh', line: NON_BOX_STOCK_LINE })
    expect(stockKind(setupOn(undefined))).toBe('box')
  })

  it('headless: contour tabs and face rest take the stock bottom and footprint from the record with no viewport', () => {
    expect(typeof window).toBe('undefined')
    const setup = setupOn('small')
    const request = { params: { tabs: true, tabWidth: 4, tabHeight: 2, tabCount: 3 }, entryType: 'plunge' as const,
      topZ: 15, wcsOriginZ: setup.wcs.origin.z, doFinish: true }
    // Today the store passes no stock bottom when no viewport is mounted, and the tab block refuses.
    expect(resolveTabs({ ...request, stockBottomWcsZ: undefined }).ok).toBe(false)
    const tabs = resolveTabs({ ...request, stockBottomWcsZ: stockBottomWcsZ(unitRecord, setup) })
    expect(tabs).toEqual({ ok: true, value: { width: 4, count: 3, tabTopZ: 2, stockBottomZ: 0, shape: 'box' } })
    expect(stockFootprint(unitRecord, setup)).toEqual([{ x: 10, y: 10 }, { x: 40, y: 10 }, { x: 40, y: 40 }, { x: 10, y: 40 }])
  })

  it('record stock bounds equal the viewport bounds on every P0 chain and every example project', async () => {
    const p0 = await p0Cases()
    const cases = [...p0.cases, ...exampleCases()]
    const results = cases.map(compareCase)
    const differences = results.flatMap(result => result.setups.filter(setup => !setup.equal)
      .map(setup => ({ case: result.id, ...setup })))
    const parityMisses = results.flatMap(result => [...result.geometry, ...result.stocks]
      .filter(row => !row.equal).map(row => `${result.id}:${row.id}`))
    save('record-vs-viewport.json', { toleranceMm: VIEWPORT_FLOAT32_MM, cases: cases.length, p0ChainsWithNoScene: p0.noScene,
      setups: results.reduce((n, r) => n + r.setups.length, 0), differences })
    save('parity.json', { cases: results.length, rows: results.reduce((n, r) => n + r.rows.length, 0),
      geometryRows: results.reduce((n, r) => n + r.geometry.length, 0), stockRows: results.reduce((n, r) => n + r.stocks.length, 0),
      parityMisses, results })
    expect(results.length).toBeGreaterThan(11)
    expect(differences).toEqual([])
    expect(parityMisses).toEqual([])
  }, 900_000)

  it('is deterministic: two runs over the examples are identical', () => {
    const once = exampleCases().map(c => c.setups.map(setup => stockBounds(c.record, setup)))
    const twice = exampleCases().map(c => c.setups.map(setup => stockBounds(c.record, setup)))
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once))
  })
})
