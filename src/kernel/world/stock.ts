// WO-3008 08a (A3-08 algorithm steps 2, 3 and 7): the kernel's stock record query.
//
// stockBounds(record, setup) answers "where is the block this setup cuts" from
// the project's stock record (Project.stocks, Project.sceneStock, the member
// geometry and Model Item placements), never from the mounted viewport. The
// membership rules are today's src/store/stockAssignment.ts and
// src/store/dispatchGeo.ts, written once here (both stay the app's authority
// until a later order switches the app over; worldStock.wo3008.test.ts holds the
// two equal). This is NOT a second remaining-stock authority: what material is
// left before an operation stays WO-2953's (src/lib/cam/operationStockAuthority.ts).
import type { ImportedGeometry, PhysicalStock, SceneStock, StockType, Vec3 } from '../../types'
import type { Aabb, WorldRecord, WorldSetup } from './contracts'
import { effectiveYawDeg, isModelRow, partPlacement, placePoint, poseMap } from './placement'

/** A geometry that pokes out of a stock by less than this still counts as inside (mm). */
const CONTAIN_TOL = 1e-6
/** The catch-all auto stock's stable id (src/store/migrateHierarchy.ts DERIVED_STOCK_ID). */
export const CATCH_ALL_STOCK_ID = 'stock-derived-migrated'

export const isWorkholding = (geo: { workholding?: boolean } | null | undefined): boolean => geo?.workholding === true

// ── Geometry in the world ───────────────────────────────────────────────────

function cornersAabb(min: Vec3, max: Vec3, pose: { position: Vec3; rotation: Partial<Vec3> | undefined }): Aabb {
  const map = poseMap(pose)
  let minX = Infinity, minY = Infinity, minZ = Infinity
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
  for (const x of [min.x, max.x]) {
    for (const y of [min.y, max.y]) {
      for (const z of [min.z, max.z]) {
        const p = placePoint(map, { x, y, z })
        if (p.x < minX) minX = p.x
        if (p.y < minY) minY = p.y
        if (p.z < minZ) minZ = p.z
        if (p.x > maxX) maxX = p.x
        if (p.y > maxY) maxY = p.y
        if (p.z > maxZ) maxZ = p.z
      }
    }
  }
  return { min: { x: minX, y: minY, z: minZ }, max: { x: maxX, y: maxY, z: maxZ } }
}

/**
 * World AABB of one geometry row as stock sizing sees it, or null when it
 * contributes nothing. Modelled body: its tessellated bbox through its Model Item
 * placement (no placement: nothing). 2D curves: the loops turned by the in-plane
 * yaw and moved, flat at position.z. 3D import: the local bbox corners through the
 * full pose (exact for axis-aligned turns, loose for arbitrary angles).
 */
export function geometryWorldAabb(geo: ImportedGeometry, record: Pick<WorldRecord, 'modelItemPlacements'>): Aabb | null {
  if (isModelRow(geo)) {
    const display = geo.modelBody?.display
    if (!display) return null
    const [minX, minY, minZ] = display.bbox.min
    const [maxX, maxY, maxZ] = display.bbox.max
    if (minX === maxX && minY === maxY && minZ === maxZ) return null
    const placement = partPlacement(geo, record.modelItemPlacements ?? [])
    if (!placement.ok) return null
    return cornersAabb({ x: minX, y: minY, z: minZ }, { x: maxX, y: maxY, z: maxZ }, placement)
  }
  if (geo.type === 'curves_2d') {
    const rad = (effectiveYawDeg(geo.rotation) * Math.PI) / 180
    const cos = Math.cos(rad), sin = Math.sin(rad)
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const loop of geo.loops ?? []) {
      for (const p of loop.points) {
        const x = p.x * cos - p.y * sin + geo.position.x
        const y = p.x * sin + p.y * cos + geo.position.y
        if (x < minX) minX = x
        if (y < minY) minY = y
        if (x > maxX) maxX = x
        if (y > maxY) maxY = y
      }
    }
    if (!Number.isFinite(minX)) return null
    return { min: { x: minX, y: minY, z: geo.position.z }, max: { x: maxX, y: maxY, z: geo.position.z } }
  }
  const bb = geo.boundingBox
  if (bb.max.x === bb.min.x && bb.max.y === bb.min.y && bb.max.z === bb.min.z) return null
  return cornersAabb(bb.min, bb.max, geo)
}

// ── Membership (written once) ───────────────────────────────────────────────

/** The catch-all auto stock homeless geometry falls to: DERIVED id first, then the first derived stock. */
export function catchAllStock(stocks: readonly PhysicalStock[]): PhysicalStock | null {
  return stocks.find(s => s.id === CATCH_ALL_STOCK_ID && s.mode === 'derived') ?? stocks.find(s => s.mode === 'derived') ?? null
}

export type MembershipState = 'named-stock' | 'auto-catch-all' | 'none'

/** named-stock: stockId resolves; none: locked with no stock (deliberate); else the catch-all candidate. */
export function membershipState(geo: Pick<ImportedGeometry, 'stockId' | 'stockIdLocked'>, stocks: readonly PhysicalStock[]): MembershipState {
  if (geo.stockId !== undefined && stocks.some(s => s.id === geo.stockId)) return 'named-stock'
  return geo.stockIdLocked === true ? 'none' : 'auto-catch-all'
}

/**
 * The stock a geometry cuts in. An owned nest seed cuts on its nest's bound sheet;
 * an unlocked modelled body resolves to the catch-all (it is never swept into a
 * stockId); everything else is its own stockId.
 */
export function cuttingStockId(geo: ImportedGeometry, record: Pick<WorldRecord, 'stocks' | 'nests'>): string | undefined {
  if (geo.ownerNestId !== undefined) return (record.nests ?? []).find(n => n.id === geo.ownerNestId)?.boundStockId
  const stocks = record.stocks ?? []
  if (isModelRow(geo) && membershipState(geo, stocks) === 'auto-catch-all') return catchAllStock(stocks)?.id
  return geo.stockId
}

/** True when a geometry sizes and is drawn inside `stock`. Workholding never is. */
export function isStockMember(geo: ImportedGeometry, stock: PhysicalStock, record: Pick<WorldRecord, 'stocks' | 'nests'>): boolean {
  if (isWorkholding(geo)) return false
  // Sizing never follows a nest seed to its sheet (the sheet is its own fixed block).
  return geo.stockId === stock.id || (geo.ownerNestId === undefined && cuttingStockId(geo, record) === stock.id)
}

export function stockMembers(stock: PhysicalStock, record: Pick<WorldRecord, 'stocks' | 'nests' | 'geometry'>): ImportedGeometry[] {
  return record.geometry.filter(geo => isStockMember(geo, stock, record))
}

const inside = (g: Aabb, s: Aabb) =>
  g.min.x >= s.min.x - CONTAIN_TOL && g.min.y >= s.min.y - CONTAIN_TOL && g.min.z >= s.min.z - CONTAIN_TOL &&
  g.max.x <= s.max.x + CONTAIN_TOL && g.max.y <= s.max.y + CONTAIN_TOL && g.max.z <= s.max.z + CONTAIN_TOL
const volume = (b: Aabb) => Math.max(0, b.max.x - b.min.x) * Math.max(0, b.max.y - b.min.y) * Math.max(0, b.max.z - b.min.z)

export interface Membership {
  /** The stock the containment rule assigns (undefined: none). */
  readonly stockId: string | undefined
  readonly rule: 'locked' | 'model-unlocked' | 'contained' | 'catch-all' | 'unassigned'
}

/**
 * membership(geometry, stocks): the automatic assignment rule. Locked rows keep
 * their stock; an unlocked modelled body is never swept (no stock). Otherwise the
 * smallest explicit stock whose box holds the part's box (first on ties), else
 * the catch-all derived stock, else none. Containment reads the imported pose
 * only (no Model Item placements), as today.
 */
export function membership(geo: ImportedGeometry, stocks: readonly PhysicalStock[]): Membership {
  if (isModelRow(geo)) {
    return geo.stockIdLocked === true ? { stockId: geo.stockId, rule: 'locked' } : { stockId: undefined, rule: 'model-unlocked' }
  }
  if (geo.stockIdLocked === true) return { stockId: geo.stockId, rule: 'locked' }
  const box = geometryWorldAabb(geo, {})
  if (box) {
    let best: { id: string; vol: number } | null = null
    for (const stock of stocks) {
      if (stock.mode !== 'explicit') continue
      const s = explicitStockAabb(stock)
      if (!inside(box, s)) continue
      const vol = volume(s)
      if (best === null || vol < best.vol) best = { id: stock.id, vol }
    }
    if (best) return { stockId: best.id, rule: 'contained' }
  }
  const derived = catchAllStock(stocks)
  return derived ? { stockId: derived.id, rule: 'catch-all' } : { stockId: undefined, rule: 'unassigned' }
}

// ── Stock bounds ────────────────────────────────────────────────────────────

/** An explicit stock is its min-corner position plus its size; nothing else is read. */
export function explicitStockAabb(stock: PhysicalStock): Aabb {
  const p = stock.position, s = stock.bounds.size
  return { min: { x: p.x, y: p.y, z: p.z }, max: { x: p.x + s.x, y: p.y + s.y, z: p.z + s.z } }
}

type Offsets = Pick<SceneStock, 'autoOffsetXY' | 'autoOffsetZTop' | 'autoOffsetZBottom'>

function union(boxes: Iterable<Aabb>): Aabb | null {
  let box: { min: Vec3; max: Vec3 } | null = null
  for (const b of boxes) {
    if (!box) { box = { min: { ...b.min }, max: { ...b.max } }; continue }
    box.min.x = Math.min(box.min.x, b.min.x); box.min.y = Math.min(box.min.y, b.min.y); box.min.z = Math.min(box.min.z, b.min.z)
    box.max.x = Math.max(box.max.x, b.max.x); box.max.y = Math.max(box.max.y, b.max.y); box.max.z = Math.max(box.max.z, b.max.z)
  }
  return box
}

function padded(box: Aabb, offsets: Offsets): Aabb {
  const off = offsets.autoOffsetXY
  return {
    min: { x: box.min.x - off, y: box.min.y - off, z: box.min.z - (offsets.autoOffsetZBottom ?? 0) },
    max: { x: box.max.x + off, y: box.max.y + off, z: box.max.z + offsets.autoOffsetZTop },
  }
}

/** A derived stock: its members' union, padded by its own named offsets (else the scene's). Null with no members. */
export function derivedStockAabb(stock: PhysicalStock, record: WorldRecord): Aabb | null {
  const offsets = record.sceneStock.autoStocks?.find(item => item.id === stock.id) ?? record.sceneStock
  const box = union(stockMembers(stock, record).flatMap(geo => geometryWorldAabb(geo, record) ?? []))
  return box ? padded(box, offsets) : null
}

const positiveVolume = (b: Aabb | null): b is Aabb =>
  b !== null && [b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z].every(Number.isFinite) &&
  b.max.x > b.min.x && b.max.y > b.min.y && b.max.z > b.min.z

/** Stock kinds (MD-02 / GAP-008). Box is built; the others are reserved and plan from their bounding box. */
export type StockKind = 'box' | 'mesh' | 'cylinder' | 'cast'
export const STOCK_KINDS: Readonly<Record<StockKind, { readonly built: boolean }>> = Object.freeze({
  box: { built: true }, mesh: { built: false }, cylinder: { built: false }, cast: { built: false },
})
/** Rule 11: the software can plan a reserved kind from its box, so it does and says so. */
export const NON_BOX_STOCK_LINE = 'planned from the bounding box; expect air moves'

const KIND_OF: Readonly<Record<StockType, StockKind>> = { rectangular: 'box', cylindrical: 'cylinder', from_model: 'mesh' }
export function stockKind(setup: Pick<WorldSetup, 'stock'>): StockKind {
  return KIND_OF[setup.stock?.type] ?? 'box'
}

/** Material carried into the next setup (A3-10): an interface slot only. Nothing answers it in alpha.3. */
export interface CarriedMaterialSlot {
  readonly fromSetupId: string
  readonly toSetupId: string
}
export function carriedMaterial(_slot: CarriedMaterialSlot): null {
  return null
}

export type StockBoundsSource = 'explicit' | 'derived' | 'legacy-fixed' | 'legacy-auto' | 'all-stocks'
export type StockBoundsResult =
  | {
    readonly ok: true
    readonly bounds: Aabb
    readonly source: StockBoundsSource
    readonly stockId?: string
    readonly kind: StockKind
    /** Present only for a reserved (non-box) kind: the one line rule 11 asks for. */
    readonly line?: string
  }
  | { readonly ok: false; readonly reason: 'no-stock' }

function oneStockAabb(stock: PhysicalStock, record: WorldRecord): Aabb | null {
  const box = stock.mode === 'explicit' ? explicitStockAabb(stock) : derivedStockAabb(stock, record)
  return positiveVolume(box) ? box : null
}

function legacyBlocks(sceneStock: SceneStock): Array<{ id: string; box: Aabb }> {
  return (sceneStock.fixedStocks ?? []).map(b => ({
    id: b.id,
    box: { min: { ...b.position }, max: { x: b.position.x + b.width, y: b.position.y + b.height, z: b.position.z + b.depth } },
  }))
}

/** All-geometry auto box of a legacy project with no first-class stocks. */
function legacyAutoAabb(record: WorldRecord): Aabb | null {
  const box = union(record.geometry.filter(geo => !isWorkholding(geo)).flatMap(geo => geometryWorldAabb(geo, record) ?? []))
  return box ? padded(box, record.sceneStock) : null
}

/**
 * stockBounds(setup): the world box of the stock the setup's WCS names. A setup
 * naming no stock (or a stock the record does not hold) gets the union of every
 * stock the record can size, which is the box the app falls back to today.
 */
export function stockBounds(record: WorldRecord, setup: WorldSetup): StockBoundsResult {
  const kind = stockKind(setup)
  const done = (bounds: Aabb, source: StockBoundsSource, stockId?: string): StockBoundsResult => ({
    ok: true, bounds, source, kind, ...(stockId !== undefined ? { stockId } : {}),
    ...(STOCK_KINDS[kind].built ? {} : { line: NON_BOX_STOCK_LINE }),
  })
  const stockId = setup.wcs.stockId ?? undefined
  const stocks = record.stocks ?? []
  if (stocks.length > 0) {
    const named = stockId !== undefined ? stocks.find(s => s.id === stockId) : undefined
    if (named) {
      const box = oneStockAabb(named, record)
      if (box) return done(box, named.mode, named.id)
    }
    const all = union(stocks.flatMap(s => oneStockAabb(s, record) ?? []))
    return all ? done(all, 'all-stocks') : { ok: false, reason: 'no-stock' }
  }
  if (record.sceneStock.mode === 'auto') {
    const box = legacyAutoAabb(record)
    return positiveVolume(box) ? done(box, 'legacy-auto') : { ok: false, reason: 'no-stock' }
  }
  const blocks = legacyBlocks(record.sceneStock)
  const named = blocks.find(b => b.id === stockId)
  if (named) return done(named.box, 'legacy-fixed', named.id)
  const all = union(blocks.map(b => b.box))
  return all ? done(all, 'all-stocks') : { ok: false, reason: 'no-stock' }
}

// ── Headless consumers (A3-08 step 7, RC-004) ───────────────────────────────

/** The stock bottom, WCS-relative, that WO-3004's tab block takes from its caller. */
export function stockBottomWcsZ(record: WorldRecord, setup: WorldSetup): number | undefined {
  const result = stockBounds(record, setup)
  return result.ok ? result.bounds.min.z - setup.wcs.origin.z : undefined
}

/** The stock footprint ring (world XY, counter-clockwise) a Face 'rest' boundary starts from. */
export function stockFootprint(record: WorldRecord, setup: WorldSetup): Array<{ x: number; y: number }> | null {
  const result = stockBounds(record, setup)
  if (!result.ok) return null
  const { min, max } = result.bounds
  return [{ x: min.x, y: min.y }, { x: max.x, y: min.y }, { x: max.x, y: max.y }, { x: min.x, y: max.y }]
}
