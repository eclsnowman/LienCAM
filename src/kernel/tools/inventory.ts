import type { ToolType } from '../../types'
import type { ToolDefinition } from './model'
import { snapshot } from './model'
import { physicalToolKey } from './identity'

export interface ToolCatalog {
  contract: 'kernel.toolCatalog'
  schemaVersion: 1
  catalogId: string
  catalogVersion: string
  licence: string
  entries: readonly ToolDefinition[]
}

/** Caller data only. No bundled sizes, maker data, selection or write-through. */
export function createToolCatalog(input: Omit<ToolCatalog, 'contract' | 'schemaVersion'>) {
  return snapshot({ ...input, contract: 'kernel.toolCatalog' as const, schemaVersion: 1 as const })
}

export interface InventoryQuery {
  scope: 'owned' | 'catalog' | 'both'
  types?: readonly (ToolType | 'other')[]
  /** Canonical mm; inclusive endpoints. An empty type list matches nothing. */
  diameterRange?: readonly [number, number]
}

export function createToolInventory(
  library: readonly ToolDefinition[],
  catalogs: readonly ToolCatalog[],
  /** Use createToolModel(authority).classify(tool).standardType at composition. */
  standardType: (tool: ToolDefinition) => ToolType | 'other',
) {
  const entries = snapshot([
    ...library.filter(tool => tool.owned !== false).map(tool => ({
      source: 'owned' as const, tool, physicalKey: physicalToolKey(tool),
      catalogId: undefined as string | undefined, catalogVersion: undefined as string | undefined,
    })),
    ...catalogs.flatMap(catalog => catalog.entries.map(tool => ({
      source: 'catalog' as const, tool, physicalKey: physicalToolKey(tool),
      catalogId: catalog.catalogId, catalogVersion: catalog.catalogVersion,
    }))),
  ])
  // No locale-dependent ordering. Preserve duplicates and explicit ids/membership.
  const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
  const sorted = [...entries].sort((a, b) => compare(a.physicalKey, b.physicalKey)
    || compare(a.source, b.source) || compare(a.catalogId ?? '', b.catalogId ?? '')
    || compare(a.catalogVersion ?? '', b.catalogVersion ?? '')
    || compare(a.tool.libraryId ?? '', b.tool.libraryId ?? '') || compare(a.tool.id, b.tool.id)
    || compare(a.tool.name, b.tool.name) || compare(stableData(a.tool), stableData(b.tool)))
  return Object.freeze({
    tools(query: InventoryQuery) {
      const range = query.diameterRange
      if (range && (!range.every(Number.isFinite) || range[0] < 0 || range[0] > range[1])) {
        throw new RangeError('diameterRange must be finite, nonnegative and ordered (mm)')
      }
      return Object.freeze(sorted.filter(entry => (query.scope === 'both' || entry.source === query.scope)
        && (!query.types || query.types.includes(standardType(structuredClone(entry.tool) as ToolDefinition)))
        && (!range || entry.tool.diameter >= range[0] && entry.tool.diameter <= range[1])))
    },
  })
}

// Stable final tie-break for repeated ids with different data, independent of input order.
function stableData(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableData).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key =>
    `${JSON.stringify(key)}:${stableData((value as Record<string, unknown>)[key])}`).join(',')}}`
  return JSON.stringify(value) ?? 'undefined'
}
