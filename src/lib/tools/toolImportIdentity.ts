import type { Tool } from '../../types'
import { normalizeToolCutHand } from '../tool/cutHand'

/** A single-tool import assigns a shop number, so that number cannot be part
 * of its duplicate key. Library files retain their posted numbers. IDs only
 * identify records; every other field (including cutting data) is content. */
export function importedToolKey(tool: Tool, includeNumber = false): string {
  const { id: _id, libraryId: _libraryId, toolNumber, ...content } = tool
  return JSON.stringify({ ...content, cutHand: normalizeToolCutHand(tool.cutHand),
    ...(includeNumber ? { toolNumber } : {}),
  }, (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
    : value)
}

export function identicalImportedLibrary(existing: readonly Tool[], incoming: readonly Tool[]): boolean {
  if (existing.length !== incoming.length) return false
  const keys = (tools: readonly Tool[]) => tools.map(t => importedToolKey(t, true)).sort()
  const other = keys(incoming)
  return keys(existing).every((key, i) => key === other[i])
}

export function nextImportedToolNumber(tools: readonly Tool[]): number {
  const used = new Set(tools.map(t => t.toolNumber))
  let number = 1
  while (used.has(number)) number++
  return number
}
