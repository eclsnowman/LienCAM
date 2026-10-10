import type { Project, Setup, WCS } from '../../types'
import { setupStockConsistency } from '../../store/stockAssignment'

// Pure, deterministic helpers for work-coordinate (G54-G59) fixture-offset
// assignment across the setups in a project. No React/store/I/O dependencies.
//
// Work offsets belong to setups: a physical block can be machined in distinct
// setups under distinct controller frames. Legacy projects may still carry the
// former stock-level assignment; records without the explicit setup marker keep
// that old resolution so merely opening a project never silently re-homes it.

/** The valid work-coordinate fixture offsets, in order (G54..G59). */
export const FIXTURE_OFFSETS = [54, 55, 56, 57, 58, 59] as const
export type FixtureOffset = (typeof FIXTURE_OFFSETS)[number]

export function isFixtureOffset(value: unknown): value is FixtureOffset {
  return typeof value === 'number' && FIXTURE_OFFSETS.includes(value as FixtureOffset)
}

type SetupOwnedFixtureOffsetWcs = WCS & { fixtureOffsetOwner?: unknown }

/** New/explicit records name the setup WCS as offset authority. */
export function setupOwnsFixtureOffset(wcs: WCS): boolean {
  return (wcs as SetupOwnedFixtureOffsetWcs).fixtureOffsetOwner === 'setup'
}

/**
 * Unified WCS -> stock binding reader. Once originBinding exists it is the
 * authority. A part-feature binding may explicitly name the stock the setup
 * machines while its origin continues to follow the feature. Older feature
 * bindings without that field and manual bindings remain unbound even if a
 * stale legacy WCS.stockId remains. Legacy stockId is read only for
 * pre-hierarchy WCS records.
 */
export function wcsBoundStockId(wcs: WCS): string | undefined {
  if (wcs.originBinding !== undefined) {
    return wcs.originBinding.kind === 'stock_corner' || wcs.originBinding.kind === 'part_feature'
      ? wcs.originBinding.stockId
      : undefined
  }
  return wcs.stockId
}

export interface WorkOffsetClaim {
  fixtureOffset: FixtureOffset
  kind: 'stock' | 'setup'
  id: string
  name: string
  stockId?: string
}

type WorkOffsetAssignmentProject = Pick<Project, 'setups' | 'stocks'>

function setupClaimFixtureOffset(
  project: WorkOffsetAssignmentProject,
  setup: Setup,
): FixtureOffset | undefined {
  if (setupOwnsFixtureOffset(setup.wcs)) {
    return isFixtureOffset(setup.wcs.fixtureOffset)
      ? setup.wcs.fixtureOffset
      : undefined
  }
  const stockId = wcsBoundStockId(setup.wcs)
  const stock = (project.stocks ?? []).find((candidate) => candidate.id === stockId)
  if (stock?.fixtureOffset !== undefined) {
    return isFixtureOffset(stock.fixtureOffset) ? stock.fixtureOffset : undefined
  }
  return isFixtureOffset(setup.wcs.fixtureOffset)
    ? setup.wcs.fixtureOffset
    : undefined
}

/**
 * Find another physical owner that would collide with an offset used by a setup
 * on targetStockId. Setups on the same stock may deliberately share a frame.
 */
export function conflictingWorkOffsetClaim(
  project: WorkOffsetAssignmentProject,
  fixtureOffset: FixtureOffset,
  targetStockId?: string,
  exceptSetupId?: string,
): WorkOffsetClaim | undefined {
  const stockConflict = (project.stocks ?? []).find(
    (stock) =>
      stock.id !== targetStockId &&
      stock.fixtureOffset === fixtureOffset,
  )
  if (stockConflict) {
    return {
      fixtureOffset,
      kind: 'stock',
      id: stockConflict.id,
      name: stockConflict.name,
      stockId: stockConflict.id,
    }
  }

  for (const setup of project.setups) {
    if (setup.id === exceptSetupId) continue
    const stockId = wcsBoundStockId(setup.wcs)
    if (targetStockId !== undefined && stockId === targetStockId) continue
    if (setupClaimFixtureOffset(project, setup) !== fixtureOffset) continue
    const stock = (project.stocks ?? []).find((candidate) => candidate.id === stockId)
    return stock
      ? {
          fixtureOffset,
          kind: 'stock',
          id: stock.id,
          name: stock.name,
          stockId: stock.id,
        }
      : {
          fixtureOffset,
          kind: 'setup',
          id: setup.id,
          name: setup.name,
        }
  }
  return undefined
}

/** Offsets unavailable to a stock because another stock/setup already owns them. */
export function usedFixtureOffsetsForStock(
  project: WorkOffsetAssignmentProject,
  targetStockId?: string,
  exceptSetupId?: string,
): Set<FixtureOffset> {
  return new Set(
    FIXTURE_OFFSETS.filter((fixtureOffset) =>
      conflictingWorkOffsetClaim(
        project,
        fixtureOffset,
        targetStockId,
        exceptSetupId,
      ) !== undefined,
    ),
  )
}

export interface WcsStockCornerBinding {
  stockId?: string
  cornerRow: number
  cornerCol: number
  cornerFace: 'top' | 'bottom'
}

/** Full stock-corner reader for work-zero re-derivation and setup editing. */
export function wcsStockCornerBinding(wcs: WCS): WcsStockCornerBinding | undefined {
  if (wcs.originBinding !== undefined) {
    return wcs.originBinding.kind === 'stock_corner'
      ? wcs.originBinding
      : undefined
  }
  if (wcs.snapGeoId != null) return undefined
  if (wcs.cornerRow == null || wcs.cornerCol == null) return undefined
  return {
    stockId: wcs.stockId,
    cornerRow: wcs.cornerRow,
    cornerCol: wcs.cornerCol,
    cornerFace: wcs.cornerFace ?? 'top',
  }
}

export type WorkOffsetResolutionCode =
  | 'WORK_OFFSET_STOCK_MISSING'
  | 'WORK_OFFSET_INVALID'
  | 'SETUP_STOCK_BINDING_MISMATCH'
  | 'SETUP_MULTI_STOCK'

export class WorkOffsetResolutionError extends Error {
  readonly code: WorkOffsetResolutionCode

  constructor(code: WorkOffsetResolutionCode, message: string) {
    super(message)
    this.name = 'WorkOffsetResolutionError'
    this.code = code
  }
}

export interface ResolvedSetupWorkOffset {
  fixtureOffset: FixtureOffset
  stockId?: string
  stockName?: string
  /** Setup copy whose WCS label/fixtureOffset are ready for post emission. */
  setup: Setup
}

export interface ResolvedWorkOffsetConflict {
  fixtureOffset: FixtureOffset
  setupNames: string[]
  ownerNames: string[]
}

/**
 * Detect one G-code offset shared by different physical owners. Multiple setups
 * resolving to the same stock are one owner and are therefore valid.
 */
export function findResolvedWorkOffsetConflicts(
  resolved: ReadonlyArray<ResolvedSetupWorkOffset>,
): ResolvedWorkOffsetConflict[] {
  const byOffset = new Map<
    FixtureOffset,
    Map<string, { ownerName: string; setupNames: string[] }>
  >()
  for (const item of resolved) {
    const ownerKey = item.stockId == null
      ? `setup:${item.setup.id}`
      : `stock:${item.stockId}`
    const ownerName = item.stockName ?? item.stockId ?? item.setup.name
    const owners = byOffset.get(item.fixtureOffset) ?? new Map()
    const owner = owners.get(ownerKey)
    if (owner) owner.setupNames.push(item.setup.name)
    else owners.set(ownerKey, { ownerName, setupNames: [item.setup.name] })
    byOffset.set(item.fixtureOffset, owners)
  }
  return [...byOffset.entries()]
    .filter(([, owners]) => owners.size > 1)
    .sort(([a], [b]) => a - b)
    .map(([fixtureOffset, owners]) => ({
      fixtureOffset,
      setupNames: [...owners.values()].flatMap((owner) => owner.setupNames),
      ownerNames: [...owners.values()].map((owner) => owner.ownerName),
    }))
}

/**
 * Resolve the controller offset owned by this setup.
 *
 * Operation ownership is authoritative when operations identify a stock.
 * A stock-corner WCS binding must agree with it; disagreement is refused rather
 * than choosing either frame. Explicit setup-owned records always use their WCS
 * value. Unmarked legacy records preserve the old stock-first rule, which keeps
 * an ambiguous saved project on the same controller frame until the operator
 * explicitly edits its setup offset.
 */
export function resolveSetupWorkOffset(
  project: Pick<Project, 'geometry' | 'stocks' | 'nests'>,
  setup: Setup,
): ResolvedSetupWorkOffset {
  const stocks = project.stocks ?? []
  const consistency = setupStockConsistency(
    setup,
    project.geometry,
    stocks,
    project.nests ?? [],
  )
  if (!consistency.ok) {
    throw new WorkOffsetResolutionError(
      'SETUP_MULTI_STOCK',
      consistency.reason ?? `Setup "${setup.name}" spans multiple stocks.`,
    )
  }

  const operationStockId = consistency.stockIds[0]
  const boundStockId = wcsBoundStockId(setup.wcs)
  if (
    operationStockId !== undefined &&
    boundStockId !== undefined &&
    operationStockId !== boundStockId
  ) {
    throw new WorkOffsetResolutionError(
      'SETUP_STOCK_BINDING_MISMATCH',
      `Setup "${setup.name}" is bound to stock "${boundStockId}", but its enabled ` +
        `operations cut stock "${operationStockId}". Rebind the setup to the stock ` +
        `its operations use before posting.`,
    )
  }

  const stockId = operationStockId ?? boundStockId
  const stock = stockId === undefined
    ? undefined
    : stocks.find((candidate) => candidate.id === stockId)
  if (stockId !== undefined && stock === undefined) {
    throw new WorkOffsetResolutionError(
      'WORK_OFFSET_STOCK_MISSING',
      `Setup "${setup.name}" references missing stock "${stockId}". Rebind the setup ` +
        `to an existing stock before posting.`,
    )
  }

  const rawOffset = setupOwnsFixtureOffset(setup.wcs)
    ? setup.wcs.fixtureOffset
    : stock?.fixtureOffset ?? setup.wcs.fixtureOffset
  if (!isFixtureOffset(rawOffset)) {
    throw new WorkOffsetResolutionError(
      'WORK_OFFSET_INVALID',
      `${stock ? `Stock "${stock.name}"` : `Setup "${setup.name}"`} has invalid work ` +
        `offset G${String(rawOffset)}. Choose G54-G59 before posting.`,
    )
  }

  return {
    fixtureOffset: rawOffset,
    ...(stockId !== undefined ? { stockId } : {}),
    ...(stock !== undefined ? { stockName: stock.name } : {}),
    setup: {
      ...setup,
      wcs: {
        ...setup.wcs,
        fixtureOffset: rawOffset,
        label: `G${rawOffset}`,
      },
    },
  }
}

/**
 * Legacy setup-level helper retained for callers/tests that operate without a
 * Project/stock context. New product code should use
 * usedFixtureOffsetsForStock.
 */
export function usedFixtureOffsets(setups: Setup[], exceptId?: string): Set<number> {
  const used = new Set<number>()
  for (const s of setups) {
    if (exceptId !== undefined && s.id === exceptId) continue
    used.add(s.wcs.fixtureOffset)
  }
  return used
}

/**
 * Legacy setup-level helper retained for callers/tests without stock context.
 */
export function setupNameUsingOffset(
  setups: Setup[],
  offset: number,
  exceptId?: string,
): string | undefined {
  for (const s of setups) {
    if (exceptId !== undefined && s.id === exceptId) continue
    if (s.wcs.fixtureOffset === offset) return s.name
  }
  return undefined
}

/**
 * Legacy setup-level detector retained for compatibility. Posting uses
 * findResolvedWorkOffsetConflicts so same-stock setup sharing is allowed.
 */
export function findWorkOffsetConflicts(
  setups: Setup[],
): Array<{ fixtureOffset: number; setupNames: string[] }> {
  const byOffset = new Map<number, string[]>()
  for (const s of setups) {
    const offset = s.wcs.fixtureOffset
    const names = byOffset.get(offset)
    if (names) names.push(s.name)
    else byOffset.set(offset, [s.name])
  }
  return [...byOffset.entries()]
    .filter(([, names]) => names.length > 1)
    .sort(([a], [b]) => a - b)
    .map(([fixtureOffset, setupNames]) => ({ fixtureOffset, setupNames }))
}
