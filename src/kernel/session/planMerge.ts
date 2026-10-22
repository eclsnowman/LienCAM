import { planPathParts, lookupPlanPath, setPlanPath, samePlanValue } from '../editPaths'
import type { Operation } from '../../types'
import { comparePlanKeys, type GeneratedOperation } from '../contracts/plan'

export interface PlanMergeReport {
  itemKey: string
  operationId: string
  outcome: 'added' | 'updated' | 'unchanged' | 'user-edited' | 'kept-position' | 'no-longer-proposed' | 'deleted'
  keptPaths: string[]
  message: string
}
/** Pure merge only. No generator is invoked here or by the current engine.
 * Existing array positions always survive; only new keys are inserted after
 * this generator's last item, in key order (alpha3-15 section 16.2). */
export function mergePlanOperations(current: readonly Operation[], proposals: readonly GeneratedOperation[],
  generatorId: string, deletedItemKeys: readonly string[] = []): { operations: Operation[]; report: PlanMergeReport[] } {
  const ordered = [...proposals].sort((a, b) => comparePlanKeys(a.itemKey, b.itemKey))
  const pending = new Map<string, GeneratedOperation>()
  for (const proposal of ordered) {
    if (proposal.provenance.generatorId !== generatorId || pending.has(proposal.itemKey)) {
      throw new TypeError('Plan proposals must have unique keys from the named generator')
    }
    pending.set(proposal.itemKey, proposal)
  }
  const existingKeys = new Set<string>()
  for (const operation of current) {
    if (operation.provenance?.generatorId !== generatorId || operation.itemKey === undefined) continue
    if (existingKeys.has(operation.itemKey)) throw new TypeError('Existing generated items must have unique keys')
    existingKeys.add(operation.itemKey)
  }
  const deleted = new Set(deletedItemKeys)
  const report: PlanMergeReport[] = []
  let insertionIndex = current.length
  const operations = current.map((old, index) => {
    if (old.provenance?.generatorId !== generatorId || old.itemKey === undefined) return structuredClone(old)
    insertionIndex = index + 1
    const proposal = pending.get(old.itemKey)
    pending.delete(old.itemKey)
    const base = { itemKey: old.itemKey, operationId: old.id, keptPaths: [] as string[] }
    if (!proposal) {
      report.push({ ...base, outcome: 'no-longer-proposed', message: `${old.id}: no longer proposed; kept.` })
      return structuredClone(old)
    }
    const next: Operation = { ...structuredClone(proposal), id: old.id }
    // A generator cannot clear the operator's edit history on a rerun.
    if (old.userEdited === undefined) delete next.userEdited
    else next.userEdited = [...new Set(old.userEdited)].sort(comparePlanKeys)
    const keptPaths: string[] = []
    for (const path of next.userEdited ?? []) {
      if (path === 'orderIndex') continue
      const parts = planPathParts(path)
      const previous = lookupPlanPath(old, parts)
      // Compare against the untouched proposal: restoring an ancestor must not
      // hide a conflicting descendant from the kept-path report.
      const proposed = lookupPlanPath(proposal, parts)
      if (previous.present !== proposed.present || !samePlanValue(previous.value, proposed.value)) keptPaths.push(path)
      setPlanPath(next, parts, previous, old)
    }
    const moved = next.userEdited?.includes('orderIndex') === true
    const outcome = moved ? 'kept-position' : next.userEdited?.length ? 'user-edited' : samePlanValue(old, next) ? 'unchanged' : 'updated'
    report.push({ ...base, outcome, keptPaths,
      message: `${old.id}: ${moved ? 'kept position' : outcome === 'user-edited' ? 'kept because user-edited' : outcome}${keptPaths.length ? `; kept ${keptPaths.join(', ')}` : ''}.` })
    return next
  })
  const added: Operation[] = []
  for (const proposal of pending.values()) {
    const blocked = deleted.has(proposal.itemKey)
    report.push({ itemKey: proposal.itemKey, operationId: proposal.id, outcome: blocked ? 'deleted' : 'added', keptPaths: [],
      message: `${proposal.id}: ${blocked ? 'deleted by user, not re-added' : 'added'}.` })
    if (!blocked) added.push(structuredClone(proposal))
  }
  operations.splice(insertionIndex, 0, ...added)
  if (new Set(operations.map(operation => operation.id)).size !== operations.length) {
    throw new TypeError('Merged operations must have unique operation ids')
  }
  return { operations, report }
}
