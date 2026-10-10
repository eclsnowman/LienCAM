import type { ImportedGeometry, NestRecord, Operation } from '../../types'
import { estimateNestCutTimeMs } from './nesting/nestRuntime'
import type { CutTimeMotion } from './runtime'

/** Suppression wins even when the suppressed operation remains selected. */
export function selectEnabledOperations(
  operations: readonly Operation[],
  activeOperationId: string | null,
): Operation[] {
  const enabled = operations.filter((operation) => operation.enabled)
  return activeOperationId
    ? enabled.filter((operation) => operation.id === activeOperationId)
    : enabled
}

/** Nest-aware context for setupEnabledCutTimeMs (BUG-428). Optional: omitting
 *  it (or passing no nests) reproduces the prior naive-sum behavior exactly,
 *  so every pre-existing call site (and the standalone-only setup case) is
 *  byte-identical to before this context existed. */
export interface SetupCutTimeContext {
  geometry?: ReadonlyArray<Pick<ImportedGeometry, 'id' | 'ownerNestId'>>
  nests?: ReadonlyArray<NestRecord>
  rapidRate?: number
  motion?: CutTimeMotion | null
}

/** Runtime total for the executable program only.
 *
 *  A nest seed op's estimatedCutTimeMs is the PER-COPY time in the seed-local
 *  frame (nestRuntime.ts) — it does not know the nest's placement count or
 *  inter-copy travel. Summing it directly (as every other operation is
 *  summed) undercounts a nest by its placement count (BUG-428). When `context`
 *  resolves an operation's geometry to a nest-owned seed (ImportedGeometry.
 *  ownerNestId set), that nest's contribution is counted ONCE via the
 *  existing estimateNestCutTimeMs (the same expansion the nest's own Properties
 *  summary uses) instead of the raw per-copy sum; every other operation keeps
 *  today's direct sum. A second seed op of an already-counted nest is skipped
 *  so the nest is never double counted. The nest expansion itself only ever
 *  sees ENABLED ops of that nest (a suppressed seed op contributes nothing,
 *  matching buildPostInput.ts's own `operations.filter(o => o.enabled)` before
 *  collectToolpathSections) -- a suppressed or outdated/degraded-but-disabled
 *  seed op is not in the executable program and must not be timed into the
 *  badge either. */
export function setupEnabledCutTimeMs(
  operations: ReadonlyArray<Operation>,
  context?: SetupCutTimeContext,
): number {
  const { geometry, nests, rapidRate, motion } = context ?? {}
  if (!geometry || !nests || nests.length === 0) {
    return operations.reduce(
      (sum, op) => sum + (op.enabled && op.status === 'ready' ? (op.estimatedCutTimeMs ?? 0) : 0),
      0,
    )
  }

  const geoById = new Map(geometry.map((g) => [g.id, g]))
  const nestById = new Map(nests.map((n) => [n.id, n]))
  const countedNestIds = new Set<string>()
  let total = 0

  // Same "enabled" filter buildPostInput.ts applies before collectToolpathSections
  // -- the executable program never includes a suppressed op's toolpath, so the
  // expansion estimateNestCutTimeMs times must not see one either. Status
  // (ready/outdated/degraded) is still enforced inside buildNestExpansion via
  // hasDisplayableToolpath, matching the post exactly.
  const enabledOps = operations.filter((op) => op.enabled)

  for (const op of operations) {
    if (!(op.enabled && op.status === 'ready')) continue
    const geometryId = (op.params as { geometryId?: string } | undefined)?.geometryId
    const geo = geometryId ? geoById.get(geometryId) : undefined
    const nestId = geo?.ownerNestId
    if (nestId === undefined) {
      total += op.estimatedCutTimeMs ?? 0
      continue
    }
    if (countedNestIds.has(nestId)) continue
    const nest = nestById.get(nestId)
    if (!nest) {
      total += op.estimatedCutTimeMs ?? 0
      continue
    }
    countedNestIds.add(nestId)
    total += estimateNestCutTimeMs(
      nest, enabledOps as Operation[], rapidRate ?? 0, undefined, undefined, motion,
    ).totalMs
  }

  return total
}
