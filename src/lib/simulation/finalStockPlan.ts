// WO-3096: which stored toolpaths make the final stock, read the way the Setup
// tree reads them. An operation the tree shows READY is compared on the
// toolpath it holds - the same moves Simulate plays - and is never worded as
// out of date. Only an operation with no usable toolpath is waited for.
// Only the compared stock's operations count, as getOperationStockDomain reads
// them: another stock's operations are neither waited for nor cut.
import { stockCutterOf } from '../../store/toolReachInputs'
import { operationGenerationIsCurrent } from '../cam/generationFingerprint'
import type { Operation, Project, Setup, Tool } from '../../types'
import type { SampledOperation } from './finalStockSampler'

/** generate: no toolpath; computing: being generated; regenerate: the tree marks it out of date. */
export type FinalStockWaitKind = 'waitGenerate' | 'waitComputing' | 'waitRegenerate'
export interface FinalStockPlan {
  readonly operations: readonly SampledOperation[]
  readonly waiting: readonly { id: string; name: string; kind: FinalStockWaitKind }[]
  /** READY operations whose saved inputs no longer verify; compared as stored. */
  readonly stored: readonly { id: string; name: string }[]
  /** READY operations whose cutter has no removal shape here; they remove nothing. */
  readonly unmodelled: readonly { id: string; name: string }[]
}

export function waitKindOf(op: Operation): FinalStockWaitKind | null {
  if (op.status === 'ready' && op.toolpathMoves) return null
  if (op.status === 'computing') return 'waitComputing'
  return op.status === 'outdated' ? 'waitRegenerate' : 'waitGenerate'
}

/** Which stock the final stock is compared on; `stockIdOf` reads an operation's
 * material stock, null when unresolved. */
export interface FinalStockScope {
  readonly stockId: string
  stockIdOf(op: Operation): string | null
}

/** Enabled operations of the setup that cut the scoped stock, in execution
 * order. An operation whose stock is unresolved is kept: it may cut this one. */
export function finalStockPlan(project: Project, setup: Setup, toolLibrary: readonly Tool[], scope: FinalStockScope): FinalStockPlan {
  const operations: SampledOperation[] = []
  const waiting: FinalStockPlan['waiting'][number][] = []
  const stored: FinalStockPlan['stored'][number][] = []
  const unmodelled: FinalStockPlan['unmodelled'][number][] = []
  const freshness = { ...project, toolLibrary: [...toolLibrary] }
  for (const op of setup.operations) {
    if (op.enabled === false) continue
    const owner = scope.stockIdOf(op)
    if (owner !== null && owner !== scope.stockId) continue
    const name = op.name || op.id
    const kind = waitKindOf(op)
    if (kind) { waiting.push({ id: op.id, name, kind }); continue }
    const replay = stockCutterOf(toolLibrary.find(tool => tool.id === op.toolId))
    if (!replay) { unmodelled.push({ id: op.id, name }); continue }
    if (!operationGenerationIsCurrent(freshness, setup, op)) stored.push({ id: op.id, name })
    operations.push({ moves: op.toolpathMoves!, cutter: replay.cutter, liftMm: replay.liftMm })
  }
  return { operations, waiting, stored, unmodelled }
}
