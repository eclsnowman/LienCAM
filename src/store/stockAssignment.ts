import { operatorText } from '../i18n/locales/en/console-and-operator-messages'
// Coordinate-hierarchy Phase 1: geometry <-> stock LINKAGE (pure functions).
//
// These functions keep ImportedGeometry.stockId current and compute per-stock
// bounds from MEMBER geometry, without touching the store, viewport, or any
// resolver. Phase 1 only ADDS this capability; Phase 2 repoints the resolvers
// to deriveStockBounds. See docs/planning/COORDINATE-HIERARCHY-PLAN.md Phase 1
// and ADR-0020.
//
// Dependency rules (mirror migrateHierarchy.ts): import only types + the pure
// geometryWorldBounds helper. NO store/viewport imports.

import type {
  ImportedGeometry,
  PhysicalStock,
  SceneStock,
  BoundingBox,
  Vec3,
  NestRecord,
  Operation,
  Setup,
} from '../types'
import { geometryWorldBounds, isWorkholdingGeometry, resolveOwningStock } from './dispatchGeo'
import { DERIVED_STOCK_ID } from './migrateHierarchy'
import { isModelOriginGeometry, type ModelOriginCandidate } from '../lib/cam/modelOrigin'
import type { ModelItemPlacementRegistryEntry } from '../lib/cam/modelItemPlacement'

/** Mirrors dispatchGeo.ts's own NO_PLACEMENTS constant - a shared empty list so
 *  a caller with no Placement context yet gets the byte-identical pre-Stage-3
 *  answer for a model row (contributes no bounds), never a crash. */
const NO_PLACEMENTS: readonly ModelItemPlacementRegistryEntry[] = []

/** Small absolute tolerance for AABB-in-AABB containment (mm). A geometry that
 *  pokes out of a stock by less than this still counts as inside. */
const CONTAIN_TOL = 1e-6

/**
 * World-space AABB of a PhysicalStock.
 *  - explicit: position (min corner) + bounds.size span.
 *  - derived:  its stored bounds verbatim (Phase 1 derive fills these; the
 *              stored bounds are already world-space, like deriveAutoStockBounds
 *              produces). position is NOT re-added for derived stocks.
 */
export function stockWorldBounds(stock: PhysicalStock): { min: Vec3; max: Vec3 } {
  if (stock.mode === 'explicit') {
    const p = stock.position
    const s = stock.bounds.size
    return {
      min: { x: p.x, y: p.y, z: p.z },
      max: { x: p.x + s.x, y: p.y + s.y, z: p.z + s.z },
    }
  }
  // derived: stored bounds are already world-space.
  return {
    min: { ...stock.bounds.min },
    max: { ...stock.bounds.max },
  }
}

function boundingBoxFrom(min: Vec3, max: Vec3): BoundingBox {
  return {
    min: { ...min },
    max: { ...max },
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
  }
}

/**
 * AUTOSTOCK-MODEL-FAIL fix - THE single source of truth for "which geometry
 * rows a DERIVED stock owns for BOUNDS + display". Both deriveStockBounds (the
 * rendered box) and the Properties panel's "Member parts" list read this, so
 * the box the viewport draws and the count the panel shows can never disagree.
 *
 * A row belongs to `stock` when:
 *  - geo.stockId === stock.id  (an explicit / locked member), OR
 *  - effectiveStockIdForCompute(geo, [], allStocks) === stock.id — the SAME
 *    resolver the compute-time provenance gate (resolveProvenCam3dStockBounds)
 *    uses, so membership and provenance can never again disagree (WO-305). For
 *    a model-origin row this resolves an unlocked ('auto-catch-all') row to the
 *    catch-all derived stock's id: a model row is deliberately never auto-swept
 *    into stockId membership (assignGeometryToStocks clears it, and the compute
 *    guards rely on that), yet the design tree presents such a row as a member
 *    of the default "Auto Stock 1" - so the catch-all must wrap it and count
 *    it. A row set to explicit None (stockIdLocked, no stockId) resolves to
 *    undefined and is correctly excluded (ADR-0003 respect for a deliberate
 *    no-stock).
 *
 * `allStocks` is required to identify the catch-all; omit it (the dispatch /
 * compute per-stock path) to get strict stockId-only membership - byte-identical
 * to the pre-fix behavior.
 */
export function derivedStockMembers(
  stock: PhysicalStock,
  geometry: ReadonlyArray<ImportedGeometry>,
  allStocks?: ReadonlyArray<PhysicalStock>,
): ImportedGeometry[] {
  // WO-1572: workholding is never a stock member, whatever its stockId says.
  return geometry.filter(
    (geo) =>
      !isWorkholdingGeometry(geo) &&
      (geo.stockId === stock.id ||
        (allStocks !== undefined && effectiveStockIdForCompute(geo, [], allStocks) === stock.id)),
  )
}

/**
 * World-space BoundingBox of a stock derived from its MEMBER geometry
 * (geometry.stockId === stock.id), padded with the SAME rules
 * deriveAutoStockBounds uses: autoOffsetXY on each X/Y side, base = members'
 * min Z minus autoOffsetZBottom (0 = legacy base === min Z, no Z pad on the
 * base), top = members' max Z + autoOffsetZTop. So when the members are
 * exactly all geometry, the result is numerically IDENTICAL to
 * deriveAutoStockBounds (the migrated common case is preserved).
 *
 * For mode 'explicit': returns stock.bounds unchanged (authoritative).
 * For mode 'derived' with no contributing members: returns null.
 */
export function deriveStockBounds(
  stock: PhysicalStock,
  geometry: ReadonlyArray<ImportedGeometry>,
  sceneStock: Pick<SceneStock, 'autoOffsetXY' | 'autoOffsetZTop' | 'autoOffsetZBottom'>,
  placementRecords: readonly ModelItemPlacementRegistryEntry[] = NO_PLACEMENTS,
  // AUTOSTOCK-MODEL-FAIL fix: the full stocks list, passed ONLY by the callers
  // that produce the RENDERED / WCS-anchoring bounds (rederiveDerivedStockBounds,
  // syncAutoStocksToPhysical, applyAutoStockToSetups). When present, THIS derived
  // stock is checked for being the CATCH-ALL owner (the lone stock
  // assignGeometryToStocks routes homeless geometry to). A model-origin row is
  // deliberately NEVER auto-swept into a stock's stockId membership (its stockId
  // stays undefined; assignGeometryToStocks clears it, and downstream compute
  // guards rely on that) - YET the design tree shows an unassigned, unlocked
  // model row as belonging to the default auto stock ("Auto Stock 1"), and the
  // acceptance bar requires the auto stock to WRAP that part and re-render live.
  // So the catch-all derived stock ALSO folds in model rows whose membership
  // resolves to 'auto-catch-all', reading them through the SAME placement-aware
  // geometryWorldBounds the viewport draws them with. This makes the per-stock
  // rendered bounds match deriveAutoStockBounds (whole-scene union, which already
  // folds model rows) for the single-derived-stock common case, closing the gap
  // GEO-UNIFY's model rows opened. Omitting allStocks = byte-identical prior
  // behavior (the dispatch/compute per-stock path stays strict, fail-loud).
  allStocks?: ReadonlyArray<PhysicalStock>,
): BoundingBox | null {
  if (stock.mode === 'explicit') return stock.bounds

  let box: { min: Vec3; max: Vec3 } | null = null
  for (const geo of derivedStockMembers(stock, geometry, allStocks)) {
    const b = geometryWorldBounds(geo, placementRecords)
    if (!b) continue
    if (!box) {
      box = { min: { ...b.min }, max: { ...b.max } }
    } else {
      box.min.x = Math.min(box.min.x, b.min.x)
      box.min.y = Math.min(box.min.y, b.min.y)
      box.min.z = Math.min(box.min.z, b.min.z)
      box.max.x = Math.max(box.max.x, b.max.x)
      box.max.y = Math.max(box.max.y, b.max.y)
      box.max.z = Math.max(box.max.z, b.max.z)
    }
  }
  if (!box) return null

  const off = sceneStock.autoOffsetXY
  const min: Vec3 = { x: box.min.x - off, y: box.min.y - off, z: box.min.z - (sceneStock.autoOffsetZBottom ?? 0) }
  const max: Vec3 = {
    x: box.max.x + off,
    y: box.max.y + off,
    z: box.max.z + sceneStock.autoOffsetZTop,
  }
  return boundingBoxFrom(min, max)
}

/** True when geometry's world AABB is fully inside the stock's world AABB
 *  (within CONTAIN_TOL on every face). */
function aabbInside(
  geo: { min: Vec3; max: Vec3 },
  stock: { min: Vec3; max: Vec3 },
): boolean {
  return (
    geo.min.x >= stock.min.x - CONTAIN_TOL &&
    geo.min.y >= stock.min.y - CONTAIN_TOL &&
    geo.min.z >= stock.min.z - CONTAIN_TOL &&
    geo.max.x <= stock.max.x + CONTAIN_TOL &&
    geo.max.y <= stock.max.y + CONTAIN_TOL &&
    geo.max.z <= stock.max.z + CONTAIN_TOL
  )
}

function aabbVolume(b: { min: Vec3; max: Vec3 }): number {
  return (
    Math.max(0, b.max.x - b.min.x) *
    Math.max(0, b.max.y - b.min.y) *
    Math.max(0, b.max.z - b.min.z)
  )
}

/** The lone CATCH-ALL derived stock: the one assignGeometryToStocks routes
 *  homeless geometry to (no explicit stock contains it). Prefers the stable
 *  DERIVED_STOCK_ID; otherwise the first derived-mode stock. null when no
 *  derived stock exists. This is the single source of truth for "which stock
 *  is the Auto option" so every chooser / default-picker agrees with the
 *  auto-assign rule. */
export function findDerivedStock(stocks: ReadonlyArray<PhysicalStock>): PhysicalStock | null {
  return (
    stocks.find((s) => s.id === DERIVED_STOCK_ID && s.mode === 'derived') ??
    stocks.find((s) => s.mode === 'derived') ??
    null
  )
}

/**
 * PURE auto-assignment of geometry to stocks by AABB containment.
 *
 * Per geometry:
 *  - stockIdLocked === true: keep its stockId (manual lock wins).
 *  - else assign by containment of its world AABB:
 *      - inside exactly one EXPLICIT stock -> that stock.
 *      - inside several EXPLICIT stocks -> the smallest-volume one
 *        (deterministic; tie -> first by array order).
 *      - inside no explicit stock -> the lone DERIVED stock (prefer
 *        DERIVED_STOCK_ID).
 *      - no derived stock and no containing explicit stock -> leave stockId
 *        undefined (the fail-loud-able unassigned state).
 *  - geometry whose world AABB is null (empty 2D / zero-bbox mesh) cannot be
 *    contained, so it falls to the derived stock (or stays undefined).
 *
 * Returns a NEW array; only geometry whose stockId changes is cloned.
 *
 * `preferredStockIds` (WO-1424): geometry id -> stock id a caller just assigned
 * IN THE SAME BATCH (e.g. explodeNest baking a placement onto its nest's
 * surviving backing stock, one statement before calling this function). When a
 * geometry's world AABB is ambiguous - contained in more than one EXPLICIT
 * stock, including its preferred one - the preferred stock wins the tie-break
 * instead of the smallest-volume container, so an unrelated overlapping stock
 * can never silently steal a part the caller just placed. The geometry stays
 * UNLOCKED (stockIdLocked untouched): this only breaks the tie for THIS
 * containment re-sort, it does not pin the part against a FUTURE one. When the
 * preferred stock does not actually contain the geometry's box, this has no
 * effect and normal containment resolution applies - a caller cannot use it to
 * claim geometry it did not produce.
 */
export function assignGeometryToStocks(
  geometry: ImportedGeometry[],
  stocks: PhysicalStock[],
  preferredStockIds?: ReadonlyMap<string, string>,
): ImportedGeometry[] {
  const explicit = stocks.filter((s) => s.mode === 'explicit')
  // Precompute explicit stock world AABBs once.
  const explicitBounds = explicit.map((s) => ({
    stock: s,
    aabb: stockWorldBounds(s),
  }))
  const derived = findDerivedStock(stocks)

  return geometry.map((geo) => {
    // INT-17A-R1 C3, narrowed by CAM-BINDING Stage 3: a modeled body is still
    // never swept into a stock by the AUTOMATIC containment path (it is never
    // spatially "contained" by anything the way a real part can be - the model
    // branch below never reaches the aabbInside containment logic), so an
    // UNLOCKED model row's stockId is still cleared exactly as before. But
    // Stage 3 makes a DELIBERATE, locked assignment (setStockMembership /
    // setGeometryAutoStock / setGeometryStock - "use this body as stock")
    // legitimate: respect the lock exactly like the non-model
    // `stockIdLocked === true` branch immediately below does, so a user's pick
    // survives the next auto-resort instead of being silently un-pinned (the
    // "two rules fight" the original C3 comment warned about, now resolved by
    // making both rules agree on locked rows).
    if (isModelOriginGeometry(geo)) {
      if (geo.stockIdLocked === true) return geo
      return geo.stockId === undefined && geo.stockIdLocked === undefined
        ? geo
        : { ...geo, stockId: undefined, stockIdLocked: undefined }
    }
    if (geo.stockIdLocked === true) return geo

  let target: string | undefined
  const gb = geometryWorldBounds(geo, NO_PLACEMENTS)
    if (gb) {
      const preferred = preferredStockIds?.get(geo.id)
      let best: { id: string; vol: number } | null = null
      let preferredContains = false
      for (const { stock, aabb } of explicitBounds) {
        if (!aabbInside(gb, aabb)) continue
        if (preferred !== undefined && stock.id === preferred) preferredContains = true
        const vol = aabbVolume(aabb)
        // Smallest-volume wins; strict < keeps the first on ties (array order).
        if (best === null || vol < best.vol) best = { id: stock.id, vol }
      }
      // WO-1424: the caller's same-batch assignment wins the tie-break over a
      // smaller unrelated container, but ONLY when it is actually a valid
      // container for this box (never claims geometry that isn't really there).
      if (preferred !== undefined && preferredContains) target = preferred
      else if (best) target = best.id
    }
    if (target === undefined) target = derived ? derived.id : undefined

    if (geo.stockId === target) return geo
    return { ...geo, stockId: target }
  })
}

/** Geometry whose stockId is undefined OR points to no existing stock id.
 *  Detection for fail-loud; resolution-time fail-loud is Phase 2.
 *
 *  INT-17A-R1 C3: modeled bodies are excluded, UNCHANGED by CAM-BINDING Stage 3.
 *  A model row still never NEEDS a stock (it is not a stock-relative op source
 *  by default; Stage 2's own compute path already supports the geometry-free
 *  height kinds without one), so an unassigned model row is still not a
 *  "forgot to assign it" finding - reporting it here would turn a normal,
 *  common state into a permanent fail-loud entry. A model row that HAS been
 *  deliberately locked to a stock (Stage 3's "use this body as stock" flow)
 *  is, correctly, still not flagged either way (it has a stock; nothing to
 *  report). */
export function getUnassignedGeometry(
  geometry: ReadonlyArray<ImportedGeometry>,
  stocks: ReadonlyArray<PhysicalStock>,
): ImportedGeometry[] {
  const ids = new Set(stocks.map((s) => s.id))
  return geometry.filter(
    (g) =>
      !isModelOriginGeometry(g) &&
      !isWorkholdingGeometry(g) &&
      (g.stockId === undefined || !ids.has(g.stockId)),
  )
}

/**
 * The three distinct membership states a geometry can be in. Used by the
 * design-tree dropdown (and the op fail-loud guard) to tell apart a user who
 * DELIBERATELY chose no stock from a part that is merely awaiting the auto
 * catch-all:
 *
 *  - 'named-stock'   : geo.stockId resolves to an existing PhysicalStock. The
 *                      cut references that stock's coordinate frame.
 *  - 'auto-catch-all': geo.stockIdLocked is falsy AND stockId is undefined /
 *                      dangling. assignStocks WILL route it into the default
 *                      auto stock on the next re-sort — a transient "not yet
 *                      sorted" state, never a final answer.
 *  - 'none'          : geo.stockIdLocked === true AND stockId is undefined. The
 *                      user EXPLICITLY chose no stock; assignStocks SKIPS locked
 *                      geometry, so this state is sticky and must NOT fall back
 *                      to the catch-all. An op on it fails loud (ADR-0003).
 */
export type StockMembershipState = 'named-stock' | 'auto-catch-all' | 'none'

export function resolveStockMembershipState(
  geo: Pick<ImportedGeometry, 'stockId' | 'stockIdLocked'>,
  stocks: ReadonlyArray<PhysicalStock>,
): StockMembershipState {
  if (geo.stockId !== undefined && stocks.some((s) => s.id === geo.stockId)) {
    return 'named-stock'
  }
  // No (resolvable) stock. A LOCKED part with no stock is the deliberate None;
  // an unlocked part is the transient catch-all candidate.
  return geo.stockIdLocked === true ? 'none' : 'auto-catch-all'
}

/**
 * WO-305 fix — THE single resolver for "which stock does this geometry cut
 * in", so a derived stock's rendered/counted MEMBERSHIP (derivedStockMembers,
 * above — which now calls back into this function when `stocks` is passed)
 * and a compute-time provenance gate (resolveProvenCam3dStockBounds) can never
 * again compute two different answers for the same geometry. That disagreement
 * was the WO-305 defect: a modeled body derived a stock box around itself (the
 * membership answer) while the provenance gate insisted it had no stock (the
 * compute answer), so a part the app had already drawn a stock around still
 * refused to generate.
 *
 * For a normal part this is just geometry.stockId. For an OWNED NEST SEED
 * (ownerNestId set) the seed itself is deliberately NO-STOCK (stockId undefined +
 * stockIdLocked, ADR 0025 Amendment 2) so the auto catch-all never wraps it — but
 * its actual cut stock is the owning nest's BOUND fixed sheet, mirrored into
 * project.stocks with the same id by syncFixedStocksToPhysical (ADR 0025
 * Amendment 3). This helper returns that bound stock id so a seed-targeted op
 * resolves heights/WCS from the bound sheet instead of fail-louding on no-stock.
 *
 * For a model-origin row (INT-17A-R1 C3): an UNLOCKED row is never spatially
 * swept into a stock's `stockId` (assignGeometryToStocks clears it, unchanged),
 * yet the design tree and the rendered box already treat it as a member of the
 * lone catch-all derived stock ('auto-catch-all', resolveStockMembershipState).
 * `stocks` makes that same answer available here: when supplied, an unlocked
 * model row resolves to the catch-all derived stock's id, matching membership.
 * A LOCKED row ('use this body as stock') or an explicit-None row keeps its own
 * `stockId` verbatim (locked-none stays undefined and must still fail loud).
 * Omitting `stocks` returns the pre-fix, strict answer (geometry.stockId)
 * byte-for-byte, so an existing caller that has not been updated to pass
 * `stocks` is unaffected.
 *
 * Returns undefined when:
 *  - a normal part has no stockId, OR
 *  - an owned seed's nest is missing / has no boundStockId, OR
 *  - a model row is explicit-None (stockIdLocked === true, no stockId), OR
 *  - a model row is unlocked and no derived stock exists to catch it.
 * The caller (computeOperationToolpath) decides how to surface each case: a
 * normal no-stock geo keeps the existing ADR-0003 "not assigned to any stock"
 * error; an owned seed whose nest has no bound sheet gets a seed-specific
 * fail-loud message. This helper does NOT mutate geometry — the caller applies
 * the id to a compute-only shallow copy.
 */
export function effectiveStockIdForCompute(
  geometry: Pick<ImportedGeometry, 'stockId' | 'stockIdLocked' | 'ownerNestId'> & ModelOriginCandidate,
  nests: ReadonlyArray<NestRecord> = [],
  stocks?: ReadonlyArray<PhysicalStock>,
): string | undefined {
  if (geometry.ownerNestId !== undefined) {
    const nest = nests.find((n) => n.id === geometry.ownerNestId)
    return nest?.boundStockId
  }
  if (stocks !== undefined && isModelOriginGeometry(geometry)) {
    const state = resolveStockMembershipState(geometry, stocks)
    if (state === 'auto-catch-all') return findDerivedStock(stocks)?.id
  }
  return geometry.stockId
}

// ── One-stock-per-setup consistency (ADR 0026 + ADR 0003) ────────────────────
//
// ADR 0026: a CAM setup is ONE work coordinate system = ONE fixture = ONE stock.
// A setup whose operations resolve to MORE THAN ONE distinct stock is invalid —
// there is no single correct stock-top/clearance plane and a rapid across regions
// at different heights can crash. Today only an op-level '__all__' selection that
// spans >1 stock is blocked (resolveOwningStock); a setup that MIXES single-stock
// ops across different stocks is NOT — this closes that gap at the post boundary.
//
// This is the PURE checker. The post (postProject) runs it per SELECTED setup and
// refuses the export fail-loud (ADR 0003). It reuses the SAME stock resolvers the
// compute path uses (resolveOwningStock + effectiveStockIdForCompute for nest
// seeds) so the post and the compute agree on which stock an op cuts on.

/** The single distinct-stock outcome for one setup.
 *  - ok: false when the setup's ops resolve to MORE THAN ONE distinct stock.
 *  - stockIds: the distinct, resolvable stock ids (order follows first encounter).
 *  - reason: present only when !ok; a plain-language message naming the setup and
 *    the conflicting stocks, steering the user to split into separate setups. */
export interface SetupStockConsistency {
  ok: boolean
  stockIds: string[]
  reason?: string
}

/** The geometryId an operation cuts. The store stores it on op.params.geometryId
 *  (the same place buildPostInput reads it). Undefined => the op is not bound to a
 *  geometry selection and is skipped by the checker. */
function opGeometryId(op: Operation): string | undefined {
  return (op.params as { geometryId?: string } | undefined)?.geometryId
}

/**
 * Resolve the single stock id one operation cuts on, or undefined when it is
 * UNRESOLVABLE (no geometry selection, missing/unassigned geometry, dangling
 * stock, or an '__all__' selection that itself spans stocks). Unresolvable ops
 * are SKIPPED by the setup checker — the existing per-op no-stock / multi-stock
 * guards (resolveOwningStock at compute, the validateOps* guards at post) own
 * those failures, so the setup checker must not crash on them or double-report.
 *
 * Resolution mirrors the compute path:
 *  - owned nest seed (ownerNestId set): the nest's bound sheet via
 *    effectiveStockIdForCompute (the seed itself is deliberately no-stock).
 *  - normal part: its stockId, when it resolves to an existing stock.
 *  - '__all__': resolveOwningStock's lone-shared-owner result; if that throws
 *    (spans stocks / unassigned), the op is treated as unresolvable here.
 */
function resolveOpStockId(
  op: Operation,
  geometry: ReadonlyArray<ImportedGeometry>,
  stocks: ReadonlyArray<PhysicalStock>,
  nests: ReadonlyArray<NestRecord>,
): string | undefined {
  const geometryId = opGeometryId(op)
  if (geometryId === undefined) return undefined

  const existing = (id: string | undefined): boolean =>
    id !== undefined && stocks.some((s) => s.id === id)

  if (geometryId === '__all__') {
    // resolveOwningStock throws on a span/unassigned '__all__' — that is the
    // existing op-level guard's job; here we just decline to count it.
    try {
      return resolveOwningStock(geometryId, geometry, stocks).id
    } catch {
      return undefined
    }
  }

  const geo = geometry.find((g) => g.id === geometryId)
  if (!geo) return undefined

  // Owned nest seed resolves its cut stock from the owning nest's bound sheet.
  if (geo.ownerNestId !== undefined) {
    const sheetId = effectiveStockIdForCompute(geo, nests)
    return existing(sheetId) ? sheetId : undefined
  }

  return existing(geo.stockId) ? geo.stockId : undefined
}

/**
 * ADR 0026 one-stock-per-setup check (PURE, never throws). Resolves the owning
 * stock of EVERY operation in the setup and returns the distinct set. ok is false
 * when more than one distinct, resolvable stock appears — the setup mixes stocks
 * and cannot share a single WCS / clearance plane.
 *
 * Ops with no geometry / unresolvable stock are SKIPPED (see resolveOpStockId);
 * they do not crash the check and are owned by the existing no-stock fail-loud
 * guards. Disabled ops are ignored (they are not posted).
 */
export function setupStockConsistency(
  setup: Setup,
  geometry: ReadonlyArray<ImportedGeometry>,
  stocks: ReadonlyArray<PhysicalStock>,
  nests: ReadonlyArray<NestRecord> = [],
): SetupStockConsistency {
  const distinct: string[] = []
  for (const op of setup.operations) {
    if (op.enabled === false) continue
    const id = resolveOpStockId(op, geometry, stocks, nests)
    if (id !== undefined && !distinct.includes(id)) distinct.push(id)
  }

  if (distinct.length <= 1) return { ok: true, stockIds: distinct }

  const named = distinct
    .map((id) => {
      const s = stocks.find((st) => st.id === id)
      return s ? `"${s.name}"` : `"${id}"`
    })
    .join(', ')
  return {
    ok: false,
    stockIds: distinct,
    reason:
      operatorText('stockAssignment1', { value1: String(setup.name), value2: String(named) }),
  }
}

// ── Default setup-stock smart pick (new-setup WCS binding) ───────────────────
//
// PROBLEM (real bug): a NEW setup's WCS/stock picker hard-defaulted to the
// catch-all auto stock (DERIVED_STOCK_ID) and derived wcs.origin.z from THAT
// stock's top. When the user machines a NEST, the seeds resolve their cut stock
// from the nest's BOUND fixed sheet (NestRecord.boundStockId via
// effectiveStockIdForCompute, ADR 0025 Amd 3) — a different, often thicker stock.
// The silent auto-stock default left Z0 on the thin auto stock while the seed op
// resolved its top from the thick sheet -> mismatched Z0 -> "Feed height below
// top height" fail-loud.
//
// FIX (Operator-approved): smart-pick the setup's stock. When exactly one
// geometry-bearing stock exists, default to it. When MORE than one exists, force
// an explicit choice (no silent default). When none exists, keep today's
// DERIVED_STOCK_ID fallback.

/** Shape carried by Project for the geometry-bearing-stock computation. Only the
 *  fields these helpers read; keeps them decoupled from the full Project type. */
type StockPickProject = {
  // INT-17A-R1 C3: `format` joins the narrowed shape because origin - not just
  // membership - now decides whether an entry can make a stock geometry-bearing.
  // OPTIONAL so the pre-existing pure callers/tests that build bare {stockId}
  // rows keep compiling unchanged; a row with no format is not model-origin, so
  // absence reads exactly as the pre-cure behaviour for them.
  geometry: ReadonlyArray<
    Pick<ImportedGeometry, 'stockId' | 'stockIdLocked' | 'workholding'> & { format?: ImportedGeometry['format'] }
  >
  stocks?: ReadonlyArray<Pick<PhysicalStock, 'id'>>
  nests?: ReadonlyArray<Pick<NestRecord, 'boundStockId'>>
}

/**
 * The set of stock ids that actually BEAR geometry to machine — the candidates a
 * new setup's WCS should bind to. The union of:
 *
 *  (1) stock ids referenced by some ImportedGeometry.stockId (a part is assigned
 *      to that stock). The catch-all DERIVED_STOCK_ID is included ONLY when a
 *      real part is assigned to it — an empty catch-all is NOT a candidate (the
 *      whole point of the fix), AND
 *  (2) every NestRecord.boundStockId (the nest's bound fixed sheet). A nest sheet
 *      has NO member geometry — the nest's seeds are explicit no-stock and cut on
 *      the bound sheet via effectiveStockIdForCompute (ADR 0025 Amd 3) — so a
 *      plain membership check would MISS it. This is why membership alone is not
 *      enough, AND
 *  (3) a model-origin row's stockId, but ONLY when stockIdLocked === true (the
 *      user deliberately ran "use this body as stock" - CAM-BINDING Stage 3).
 *      An unlocked modeled body never bears a stock here, matching
 *      assignGeometryToStocks/getUnassignedGeometry's own locked-only rule.
 *
 * Only ids that resolve to an existing PhysicalStock are returned (a dangling
 * stockId / boundStockId is not a real candidate). Deduped; order follows
 * project.stocks for determinism.
 */
export function geometryBearingStockIds(project: StockPickProject): string[] {
  const existing = new Set((project.stocks ?? []).map((s) => s.id))

  const bearing = new Set<string>()
  for (const geo of project.geometry) {
    // WO-1572: a vise or clamp bears no geometry to machine.
    if (isWorkholdingGeometry(geo)) continue
    // MODEL-STOCK-NEW-SETUP-WCS-PICK (closes the INT-17A-R1 C3 disclosed gap):
    // an UNLOCKED modeled body still never makes a stock geometry-bearing here
    // - it has no world bounds under automatic containment, exactly like
    // assignGeometryToStocks/getUnassignedGeometry above. But when CAM-BINDING
    // Stage 3's "use this body as stock" flow has deliberately LOCKED it to a
    // named stock, that stock DOES bear geometry to machine (the same
    // deliberate-lock rule assignGeometryToStocks already honors at line 247
    // above) - so a new setup's default-WCS pick can now silently favor it
    // when it is the only candidate, and correctly force-choose when another
    // real candidate also exists, instead of being blind to it either way.
    if (isModelOriginGeometry(geo)) {
      if (geo.stockIdLocked === true && geo.stockId !== undefined && existing.has(geo.stockId)) {
        bearing.add(geo.stockId)
      }
      continue
    }
    if (geo.stockId !== undefined && existing.has(geo.stockId)) {
      bearing.add(geo.stockId)
    }
  }
  for (const nest of project.nests ?? []) {
    if (nest.boundStockId !== undefined && existing.has(nest.boundStockId)) {
      bearing.add(nest.boundStockId)
    }
  }

  // Emit in project.stocks order so the result is deterministic.
  return (project.stocks ?? [])
    .map((s) => s.id)
    .filter((id) => bearing.has(id))
}

/**
 * The default stock a NEW setup's WCS/stock picker should bind to.
 *
 *  - exactly ONE geometry-bearing stock -> { stockId } (bind to it silently, the
 *    common single-stock / single-nest case — byte-identical to the old behavior
 *    when that lone stock IS the derived catch-all).
 *  - MORE than one -> { forceChoice: true }: the picker comes up with nothing
 *    pre-selected and the user MUST choose. No silent default (ADR-0003 spirit:
 *    no guessing the cut stock when it is ambiguous).
 *  - NONE -> { stockId: DERIVED_STOCK_ID } fallback (today's behavior; the
 *    catch-all may not exist yet but it is the right symbolic default and the
 *    bounds reader tolerates an absent stock).
 *
 * PURE: reads only the passed project shape; no store/viewport access.
 */
export function pickDefaultSetupStock(
  project: StockPickProject,
): { stockId: string } | { forceChoice: true } {
  const candidates = geometryBearingStockIds(project)
  if (candidates.length === 1) return { stockId: candidates[0] }
  if (candidates.length > 1) return { forceChoice: true }
  return { stockId: DERIVED_STOCK_ID }
}
