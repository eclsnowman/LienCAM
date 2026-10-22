import type { Operation, Setup } from '../../types'
import { comparePlanKeys } from '../contracts/plan'

/** A move edits list position, not a generated parameter. The merge always
 * keeps the current array order; this mark supplies its explicit report. */
export function movePlanOperation(operations: readonly Operation[], operationId: string, toIndex: number): Operation[] {
  const result = structuredClone([...operations])
  const from = result.findIndex(op => op.id === operationId)
  if (from < 0 || !Number.isFinite(toIndex)) return result
  const target = Math.min(result.length - 1, Math.max(0, Math.trunc(toIndex)))
  if (from === target) return result
  const [operation] = result.splice(from, 1)
  if (operation.provenance) operation.userEdited = [...new Set([...(operation.userEdited ?? []), 'orderIndex'])].sort(comparePlanKeys)
  result.splice(target, 0, operation)
  return result
}

/** The tombstone is scoped by generator, and persists in the ordinary setup. */
export function deletePlanOperation<T extends Pick<Setup, 'operations' | 'deletedItemKeys'>>(setup: T, operationId: string): T {
  const result = structuredClone(setup)
  const operation = result.operations.find(op => op.id === operationId)
  result.operations = result.operations.filter(op => op.id !== operationId)
  if (operation?.provenance && operation.itemKey !== undefined) {
    const id = operation.provenance.generatorId
    const deleted = result.deletedItemKeys ?? {}
    const keys = Object.prototype.hasOwnProperty.call(deleted, id) ? deleted[id] : []
    // Computed property definition handles even ids named __proto__ as data.
    result.deletedItemKeys = { ...deleted, [id]: [...new Set([...keys, operation.itemKey])].sort(comparePlanKeys) }
  }
  return result
}
