// WO-3032 (alpha.3 A3-10b, parity): where each family starts, as material
// queries, with today's mechanism per family (PARITY_TOP_OF_CUT) and today's
// adjacent-roughs-only hand-off (PARITY_HANDOFF) as the parity answers:
//
// - 2.5D families: Smart Top starts at the highest material the enabled, ready
//   earlier operations left over the region, when that is below the stock top,
//   and names the earliest operation whose cut brought it down there (the store's
//   earlierMaterialStartFor: snapshotBefore + topHeight + the prefix search).
// - adaptive_3d: the retained field of the immediately preceding ready
//   adaptive_3d rough, under exactly today's compatibility facts
//   (restStartStockFor), else the stock box. MD-52 (non_adjacent_handoff, OFF)
//   would start from snapshotBefore instead.
// - 3D finishes: no top of cut from material (planned over the target, then
//   WO-1641 air feeds); MD-51 (top_of_cut_from_material, OFF) would use topHeight.
import { materialFingerprint } from './fingerprint'
import type { Box3 } from './dexel'
import type { MaterialLifecycle } from './lifecycle'
import { PARITY_POLICY, type MaterialPolicy } from './policy'
import { topHeight, type RegionXY } from './queries'
import type { MaterialOperation } from './replay'

export interface SmartTop2d {
  /** Highest material over the region, clamped into the block. */
  readonly materialTopZ: number
  /** Index of the earlier operation whose cut first brought the region down to it. */
  readonly sourceIndex: number
}

/**
 * The 2.5D top of cut for operation `n` over `region`, or undefined when the
 * stock as loaded stands (nothing earlier, nothing earlier cut there, or the
 * material still reaches the block top).
 */
export function smartTop2d(lifecycle: MaterialLifecycle, chain: readonly MaterialOperation[], n: number,
  region: RegionXY | undefined): SmartTop2d | undefined {
  if (!region || n <= 0) return undefined
  const stock = lifecycle.stock
  const remaining = lifecycle.snapshotBefore(chain, n)
  if (remaining.operationsReplayed === 0) return undefined
  const highest = topHeight(remaining, region)
  if (highest === undefined || highest >= stock.maxZ - 1e-6) return undefined
  const materialTopZ = Math.min(stock.maxZ, Math.max(stock.minZ, highest))
  let sourceIndex = n - 1
  for (let count = 1; count <= n; count++) {
    const prefix = lifecycle.snapshotAfter(chain, count - 1)
    const prefixTop = prefix.operationsReplayed > 0 ? topHeight(prefix, region) : undefined
    if (prefixTop !== undefined && prefixTop <= highest + 1e-9) { sourceIndex = count - 1; break }
  }
  return { materialTopZ, sourceIndex }
}

/** The facts the adaptive_3d hand-off reads (today's restStartStockFor input, without the worker objects). */
export interface AdaptiveHandoffFacts {
  /** The field the previous rough left, when one is retained. */
  readonly retained?: {
    /** The retained field lives on the client this compute runs on. */
    readonly sameClient: boolean
    readonly setupId: string
    readonly opId: string
    readonly geometryId: string
    readonly stockBounds: Box3
    readonly cellSize: number
    readonly upstreamChainFingerprint: string
  }
  readonly setupId: string
  /** The operation immediately before this one in the setup. */
  readonly previous?: { readonly id: string; readonly type: string; readonly enabled: boolean; readonly status: string }
  readonly geometryId: string | undefined
  readonly stockBounds: Box3
  readonly cellSize: number
  readonly upstreamChainFingerprint: string
}

export type AdaptiveHandoff =
  | { readonly source: 'retained-field'; readonly opId: string }
  | { readonly source: 'snapshot'; readonly afterIndex: number }
  | { readonly source: 'stock-box'; readonly reason: string }

function retainedUsable(facts: AdaptiveHandoffFacts): string | undefined {
  const { retained, previous } = facts
  if (retained === undefined) return 'no retained field'
  if (previous === undefined) return 'first operation of the setup'
  if (!retained.sameClient) return 'the retained field belongs to another worker'
  if (previous.type !== 'adaptive_3d' || !previous.enabled || previous.status !== 'ready') {
    return 'the previous operation is not the enabled, ready adaptive_3d rough (adjacent roughs only)'
  }
  if (retained.setupId !== facts.setupId || retained.opId !== previous.id) return 'the retained field is another operation\'s'
  if (facts.geometryId === undefined || retained.geometryId !== facts.geometryId) return 'carved around another solid'
  if (retained.cellSize !== facts.cellSize) return 'carved on another cell size'
  if (retained.upstreamChainFingerprint !== facts.upstreamChainFingerprint) return 'the chain before it changed'
  const mine = facts.stockBounds, carved = retained.stockBounds
  if (carved.minX !== mine.minX || carved.minY !== mine.minY || carved.minZ !== mine.minZ ||
    carved.maxX !== mine.maxX || carved.maxY !== mine.maxY || carved.maxZ !== mine.maxZ) return 'carved against another stock box'
  return undefined
}

/**
 * Where an adaptive_3d rough at chain index `n` starts. Parity: the previous
 * rough's retained field when today's facts allow it, else the stock box.
 * non_adjacent_handoff ON (MD-52, CARD V02 first): the replayed snapshot
 * whenever any earlier operation was cut and no retained field applies.
 */
export function adaptiveHandoff(facts: AdaptiveHandoffFacts, policy: MaterialPolicy = PARITY_POLICY,
  replayed?: { lifecycle: MaterialLifecycle; chain: readonly MaterialOperation[]; n: number }): AdaptiveHandoff {
  const why = retainedUsable(facts)
  if (why === undefined) return { source: 'retained-field', opId: facts.retained!.opId }
  if (policy.non_adjacent_handoff && replayed && replayed.n > 0) {
    const before = replayed.lifecycle.snapshotBefore(replayed.chain, replayed.n)
    if (before.operationsReplayed > 0) return { source: 'snapshot', afterIndex: before.afterIndex }
  }
  return { source: 'stock-box', reason: why }
}

/** Today's adaptive chain fingerprint record (store adaptive3dMaterialChainFingerprint), for the hand-off facts. */
export function adaptiveChainRecord(operations: readonly {
  id: string; type: string; status: string; enabled: boolean; toolId?: string; geometrySelections?: unknown;
  params?: unknown; smartHeight?: unknown; generationFingerprint?: unknown
}[]) {
  return operations.filter(operation => operation.enabled).map(operation => ({
    id: operation.id, type: operation.type, status: operation.status, toolId: operation.toolId,
    geometrySelections: operation.geometrySelections, params: operation.params,
    smartHeight: operation.smartHeight, generationFingerprint: operation.generationFingerprint,
  }))
}

/** The upstream chain fingerprint today's hand-off compares (same value as the store's). */
export function adaptiveChainFingerprint(operations: Parameters<typeof adaptiveChainRecord>[0]): string {
  return materialFingerprint(adaptiveChainRecord(operations))
}

/** Where a 3D finish starts. Parity: no top of cut from material; MD-51 ON: the top of the remaining material. */
export function finishTopOfCut(lifecycle: MaterialLifecycle, chain: readonly MaterialOperation[], n: number,
  region: RegionXY, policy: MaterialPolicy = PARITY_POLICY): { readonly fromMaterial: false } | { readonly fromMaterial: true; readonly topZ: number | undefined } {
  if (!policy.top_of_cut_from_material) return { fromMaterial: false }
  return { fromMaterial: true, topZ: topHeight(lifecycle.snapshotBefore(chain, n), region) }
}
