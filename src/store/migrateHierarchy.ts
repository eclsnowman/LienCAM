import { operatorText } from '../i18n/locales/en/console-and-operator-messages'
// Coordinate-hierarchy migration (Phase 0).
//
// PURE + IDEMPOTENT migrator that populates the new ADDITIVE hierarchy fields
// (Project.stocks, ImportedGeometry.stockId, WCS.originBinding) from the legacy
// data model WITHOUT changing any value a resolver reads. Every legacy field is
// preserved; nothing is repointed. See docs/planning/COORDINATE-HIERARCHY-PLAN.md
// Phase 0 and ADR-0020.
//
// Dependency-free by design: it MUST NOT import deriveAutoStockBounds or any
// store/viewport code. Derived-stock bounds are a placeholder here; Phase 1
// computes authoritative per-stock bounds from member geometry.

import type {
  Project,
  PhysicalStock,
  OriginBinding,
  ImportedGeometry,
  Setup,
  WCS,
  Vec3,
  BoundingBox,
  AutoStockItem,
  SceneStock,
} from '../types'
import { isModelOriginGeometry } from '../lib/cam/modelOrigin'

/** Stable id for the single lone DERIVED stock that owns all geometry on first
 *  migration. STABLE so re-running the migrator never mints a fresh id (the
 *  idempotency keystone). This SAME id is the default visible AUTO stock's id
 *  (ensureDefaultAutoStock), so the catch-all and the default auto stock are one
 *  and the same PhysicalStock — no second stock, no new id to migrate. */
export const DERIVED_STOCK_ID = 'stock-derived-migrated'

/** Display name of the default visible AUTO stock (the catch-all made visible).
 *  Matches the lone derived stock's migrated name so a project that already
 *  carries the derived stock keeps its name. */
export const DEFAULT_AUTO_STOCK_NAME = operatorText('migrateHierarchy1')

/** The default AutoStockItem (id === DERIVED_STOCK_ID). Its offsets default to
 *  the scene-stock auto offsets so the catch-all sizes itself exactly like the
 *  legacy single auto stock did. */
function makeDefaultAutoStock(sceneStock: SceneStock | undefined): AutoStockItem {
  return {
    id: DERIVED_STOCK_ID,
    name: DEFAULT_AUTO_STOCK_NAME,
    autoOffsetXY: sceneStock?.autoOffsetXY ?? 5,
    autoOffsetZTop: sceneStock?.autoOffsetZTop ?? 5,
    autoOffsetZBottom: sceneStock?.autoOffsetZBottom ?? 0,
  }
}

/**
 * Guarantee the project's sceneStock carries at least one named AUTO stock that
 * acts as the catch-all (id === DERIVED_STOCK_ID), so:
 *  - every project always has >=1 visible auto stock (a box + working ops), and
 *  - new imports default into it (assignStocks routes unlocked geometry to the
 *    DERIVED_STOCK_ID stock via findDerivedStock).
 *
 * PURE + IDEMPOTENT: when an autoStocks list already contains ANY entry it is
 * returned untouched (a project that explicitly created its own auto stocks is
 * not forced to also carry the default). Only a project with no auto stocks at
 * all gains the default catch-all. Returns the SAME project reference when
 * nothing changes (idempotency / no needless re-render).
 */
export function ensureDefaultAutoStock(project: Project): Project {
  const autoStocks = project.sceneStock?.autoStocks ?? []
  if (autoStocks.length > 0) return project
  const sceneStock: SceneStock = {
    ...project.sceneStock,
    autoStocks: [makeDefaultAutoStock(project.sceneStock)],
  }
  return { ...project, sceneStock }
}

const ZERO_VEC: Vec3 = { x: 0, y: 0, z: 0 }

function zeroBounds(): BoundingBox {
  return {
    min: { x: 0, y: 0, z: 0 },
    max: { x: 0, y: 0, z: 0 },
    size: { x: 0, y: 0, z: 0 },
    center: { x: 0, y: 0, z: 0 },
  }
}

function cloneVec(v: Vec3 | undefined): Vec3 {
  return v ? { x: v.x, y: v.y, z: v.z } : { ...ZERO_VEC }
}

function readableSetupWcs(setup: unknown): WCS | null {
  if (setup === null || typeof setup !== 'object') return null
  const wcs = (setup as { wcs?: unknown }).wcs
  return wcs !== null && typeof wcs === 'object' && !Array.isArray(wcs)
    ? wcs as WCS
    : null
}

/** True when the project already carries a complete hierarchy: the derived stock
 *  is present, every geometry has a stockId, and every setup's WCS has an
 *  originBinding. Used for a fast structural idempotency short-circuit. */
function isFullyMigrated(project: Project): boolean {
  const stocks = project.stocks ?? []
  const hasDerived = stocks.some((s) => s.id === DERIVED_STOCK_ID)
  if (!hasDerived) return false
  // INT-17A-R1 C3: modeled bodies are deliberately stockId-less, so they must not
  // count against the fast-path check - otherwise every project containing one
  // would re-run the whole migration on every load, forever.
  if (!project.geometry.every((g) => isModelOriginGeometry(g) || typeof g.stockId === 'string')) return false
  if (!project.setups.every((s) => readableSetupWcs(s)?.originBinding != null)) return false
  // Every named auto stock must already have its derived PhysicalStock; a project
  // that just gained an autoStock is NOT fully migrated (its stock must be emitted).
  const stockIds = new Set(stocks.map((s) => s.id))
  if (!(project.sceneStock?.autoStocks ?? []).every((a) => stockIds.has(a.id))) {
    return false
  }
  return true
}

/** Derive a WCS.originBinding from the legacy binding fields. Legacy fields are
 *  not touched — this only reads them. SetupModal.handleSave MIRRORS this exact
 *  mapping at the write site so a migrated load and a fresh pick agree (the
 *  Phase 3 stale-binding fix). Exported as deriveOriginBindingForTest so the
 *  trigger-matrix suite asserts both producers against one source of truth. */
function deriveOriginBinding(wcs: WCS): OriginBinding {
  // 1. Explicit stockId on the corner pick -> bound to that stock.
  if (wcs.stockId != null) {
    return {
      kind: 'stock_corner',
      stockId: wcs.stockId,
      cornerRow: wcs.cornerRow ?? 0,
      cornerCol: wcs.cornerCol ?? 0,
      cornerFace: wcs.cornerFace ?? 'top',
    }
  }
  // 2. Snap (geometry-feature) binding.
  if (wcs.snapGeoId != null) {
    return {
      kind: 'part_feature',
      geoId: wcs.snapGeoId,
      featureRef: { kind: 'vertex', localPt: cloneVec(wcs.snapLocalPt) },
    }
  }
  // 3. AUTO-mode corner pick: corner fields are set but no stockId (auto/derived
  //    stock historically had no id). This IS corner-bound to the DERIVED stock
  //    and DOES re-derive when the auto stock changes (applyAutoStockToSetups
  //    re-derives any WCS with cornerRow/Col set && no snapGeoId). Labeling it
  //    'manual' would be a Phase-5 landmine: a reader trusting originBinding
  //    would stop re-deriving it and B10 drift would return.
  if (wcs.cornerRow != null && wcs.cornerCol != null) {
    return {
      kind: 'stock_corner',
      stockId: DERIVED_STOCK_ID,
      cornerRow: wcs.cornerRow,
      cornerCol: wcs.cornerCol,
      cornerFace: wcs.cornerFace ?? 'top',
    }
  }
  // 4. True manual / gizmo: no binding at all.
  return { kind: 'manual' }
}

/** Test-only re-export of the legacy->binding mapping. SetupModal.handleSave
 *  mirrors this exact logic at the WCS write site; the trigger-matrix suite
 *  asserts both against this single source of truth. */
export function deriveOriginBindingForTest(wcs: WCS): OriginBinding {
  return deriveOriginBinding(wcs)
}

/**
 * Populate the coordinate-hierarchy fields on a project. PURE (returns a new
 * project; does not mutate the input) and IDEMPOTENT (migrate(migrate(p)) deep-
 * equals migrate(p); ids are stable, existing values are never overwritten).
 *
 * NO BEHAVIOR CHANGE: only the additive fields (stocks, geometry.stockId,
 * wcs.originBinding) are written; every legacy field is preserved verbatim.
 */
export function migrateProjectToHierarchy(projectIn: Project): Project {
  // Guarantee a default visible AUTO stock (the catch-all made visible) BEFORE
  // any structural work, so the autoStocks list below emits its PhysicalStock and
  // new imports default into it. ensureDefaultAutoStock is a no-op when the
  // project already carries auto stocks (PURE/idempotent), so a fully-migrated
  // project still short-circuits below.
  const project = ensureDefaultAutoStock(projectIn)

  // Fast structural idempotency: nothing to do.
  if (isFullyMigrated(project)) return project

  // --- Stocks: lone derived stock + one explicit stock per fixedStocks item ---
  const existing = project.stocks ?? []

  // The catch-all derived stock IS the default visible auto stock
  // (ensureDefaultAutoStock gave it the matching AutoStockItem). When creating it
  // fresh, name it from that AutoStockItem so the PhysicalStock and the
  // AutoStockItem agree; an already-present stock keeps its stored name (the
  // store's syncAutoStocksToPhysical propagates name edits on later mutations).
  const defaultAutoName =
    (project.sceneStock?.autoStocks ?? []).find((a) => a.id === DERIVED_STOCK_ID)?.name
    ?? DEFAULT_AUTO_STOCK_NAME
  const derivedStock: PhysicalStock =
    existing.find((s) => s.id === DERIVED_STOCK_ID) ?? {
      id: DERIVED_STOCK_ID,
      name: defaultAutoName,
      mode: 'derived',
      // TODO(Phase 1): authoritative per-stock derive from member geometry.
      bounds: zeroBounds(),
      position: { ...ZERO_VEC },
    }

  const explicitStocks: PhysicalStock[] = (project.sceneStock?.fixedStocks ?? []).map(
    (fixed): PhysicalStock => {
      const already = existing.find((s) => s.id === fixed.id)
      if (already) return already
      return {
        id: fixed.id,
        name: fixed.name,
        mode: 'explicit',
        bounds: {
          min: { x: 0, y: 0, z: 0 },
          max: { x: fixed.width, y: fixed.height, z: fixed.depth },
          size: { x: fixed.width, y: fixed.height, z: fixed.depth },
          center: { x: fixed.width / 2, y: fixed.height / 2, z: fixed.depth / 2 },
        },
        position: cloneVec(fixed.position),
      }
    },
  )

  // One mode:'derived' PhysicalStock per named AUTO stock (id === autoStock id).
  // Bounds are a zero placeholder here (same as the lone derived stock); Phase 1
  // / the store re-sync compute authoritative member-derived bounds. An already-
  // present stock with this id is returned verbatim (idempotency). The default
  // auto stock (id === DERIVED_STOCK_ID) is SKIPPED here because `derivedStock`
  // above already emits exactly that PhysicalStock — emitting it again would
  // duplicate the id.
  const autoStocks: PhysicalStock[] = (project.sceneStock?.autoStocks ?? [])
    .filter((auto) => auto.id !== DERIVED_STOCK_ID)
    .map((auto): PhysicalStock => {
      const already = existing.find((s) => s.id === auto.id)
      if (already) return already
      return {
        id: auto.id,
        name: auto.name,
        mode: 'derived',
        bounds: zeroBounds(),
        position: { ...ZERO_VEC },
      }
    })

  // Preserve any pre-existing stocks that are neither the derived stock nor a
  // fixedStocks-id / autoStocks-id duplicate.
  const knownIds = new Set<string>([
    DERIVED_STOCK_ID,
    ...explicitStocks.map((s) => s.id),
    ...autoStocks.map((s) => s.id),
  ])
  const preserved = existing.filter((s) => !knownIds.has(s.id))

  const stocks: PhysicalStock[] = [
    derivedStock,
    ...explicitStocks,
    ...autoStocks,
    ...preserved,
  ]

  // --- Geometry: assign every unassigned part to the lone derived stock ---
  // (Locked rule: the lone derived stock owns all geometry; Phase 1 re-sorts
  // members by containment. Do not overwrite an existing stockId.)
  // INT-17A-R1 C3: this is the FOURTH stock-assignment accept path (alongside
  // assignGeometryToStocks and the two membership setters) and it stamps the
  // catch-all onto anything without an id - modeled bodies included. They are not
  // stock-eligible in Stage 1, so they are skipped here and any id an older blob
  // stamped on them is cleared on the way through.
  const geometry: ImportedGeometry[] = project.geometry.map((g) =>
    isModelOriginGeometry(g)
      ? (g.stockId === undefined ? g : { ...g, stockId: undefined })
      : typeof g.stockId === 'string' ? g : { ...g, stockId: DERIVED_STOCK_ID },
  )

  // --- Setups: derive WCS.originBinding from legacy fields (keep legacy) ---
  const setups: Setup[] = project.setups.map((setup) => {
    const wcs = readableSetupWcs(setup)
    // A later load-boundary reconciliation quarantines malformed setup
    // records. Migration must preserve the rest of a legacy project instead
    // of throwing here and causing Zustand to silently keep its blank default.
    if (wcs === null || wcs.originBinding != null) return setup
    return {
      ...setup,
      wcs: { ...wcs, originBinding: deriveOriginBinding(wcs) },
    }
  })

  return { ...project, stocks, geometry, setups }
}
