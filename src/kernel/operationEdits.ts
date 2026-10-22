import type { Operation } from '../types'
import { comparePlanKeys } from './contracts/plan'
import { planPathParts, lookupPlanPath, setPlanPath, samePlanValue } from './editPaths'

export type OperationEdit = { path: string } & ({ value: unknown; remove?: false } | { remove: true })
const authored = new Set(['name', 'enabled', 'toolId', 'params', 'heights', 'passes', 'linking',
  'feedrateOverride', 'geometrySelections', 'modelReferences', 'smartHeight'])

/** Shared headless edit boundary. Values keep the schema's existing authoring
 * semantics (no new clamp/default). Computed publications do not use this API.
 * Dotted paths name actual record fields, including whole objects/arrays. */
export function editOperation(operation: Operation, edits: readonly OperationEdit[]): Operation {
  const result = structuredClone(operation)
  const changed = new Set(operation.userEdited ?? [])
  for (const edit of edits) {
    const parts = planPathParts(edit.path)
    if (!authored.has(parts[0])) throw new TypeError(`Not an authored operation path: ${edit.path}`)
    const previous = lookupPlanPath(result, parts)
    const next = edit.remove ? { present: false } : { present: true, value: edit.value }
    if (previous.present === next.present && samePlanValue(previous.value, next.value)) continue
    const parent = lookupPlanPath(result, parts.slice(0, -1))
    setPlanPath(result, parts, next)
    // Removing an element shifts later indices; preserve the resulting array
    // as a structural edit rather than replaying a deletion at a stale index.
    if (operation.provenance) changed.add(edit.remove && Array.isArray(parent.value)
      ? parts.slice(0, -1).join('.') : edit.path)
  }
  if (operation.provenance && changed.size) result.userEdited = [...changed].sort(comparePlanKeys)
  return result
}
