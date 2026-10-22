import type { Operation, Setup } from '../../types'

/** Rule ids are stable strings (e.g. AL6061-FLAT-ADAPTIVE-01); data versions
 * use semver (e.g. 1.0.0). They remain optional until the rule data lands. */
export interface Provenance {
  generatorKind: 'user' | 'recipe' | 'ruleset' | (string & {})
  generatorId: string
  ruleId?: string
  rulesetVersion?: string
  /** Stable, order-independent feature-service id (e.g. model:face-42).
   * Optional until feature recognition lands; never validated as an op gate. */
  featureId?: string
  reason: string
  inputDigest: string
}

/** Additive record fields live here while the shared types file is outside
 * this order's ownership. Ordinary project serialization preserves them. */
export interface PlanMetadata {
  provenance?: Provenance
  itemKey?: string
  /** Dot-separated operation paths, e.g. params.stepover; orderIndex is a move. */
  userEdited?: string[]
}
declare module '../../types' {
  interface Operation extends PlanMetadata {}
  interface Setup {
    deletedItemKeys?: Record<string, string[]>
  }
}

export interface PlanItem extends PlanMetadata {
  operationId: string
  orderIndex: number
  enabled: boolean
}
export interface PlanRecord {
  contract: 'kernel.plan'
  schemaVersion: '1.0.0'
  setups: { setupId: string; items: PlanItem[]; deletedItemKeys?: Record<string, string[]> }[]
  planDigest: string
}

/** Fixed codepoint order, independent of machine locale. */
export const comparePlanKeys = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0
export function canonicalPlanText(value: unknown): string {
  return JSON.stringify(value, (_key, entry) => {
    if (typeof entry === 'number' && Number.isFinite(entry)) return Math.round(entry * 1e6) / 1e6
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      return Object.fromEntries(Object.entries(entry).sort(([a], [b]) => comparePlanKeys(a, b)))
    }
    return entry
  })
}
// Browser/headless pure hash, same two independent 32-bit lanes as generation
// fingerprints. The plan and key namespaces are separate from the generation contract.
export function planHash(value: unknown): string {
  const text = canonicalPlanText(value)
  let a = 0x811c9dc5
  let b = 0x9e3779b9
  for (let i = 0; i < text.length; i++) {
    a = Math.imul(a ^ text.charCodeAt(i), 0x01000193) >>> 0
    b = Math.imul(b ^ text.charCodeAt(i), 0x85ebca6b) >>> 0
  }
  return `${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0')}`
}

/** Feature ids are stable, order-independent strings from the feature service.
 * Version/reason/input digest deliberately do not participate in item identity. */
export function planItemKey(generatorId: string, ruleId: string | undefined, featureId: string | undefined, role: string): string {
  return `plan-item-v1-${planHash([generatorId, ruleId ?? null, featureId ?? null, role])}`
}

/** Derived view only: never a second authored copy of the operation list. */
export function derivePlanRecord(setups: readonly Pick<Setup, 'id' | 'operations' | 'deletedItemKeys'>[]): PlanRecord {
  const records = setups.map(setup => ({
    setupId: setup.id,
    items: setup.operations.map((op, orderIndex): PlanItem => ({
      operationId: op.id, orderIndex, enabled: op.enabled,
      ...(op.provenance === undefined ? {} : { provenance: structuredClone(op.provenance) }),
      ...(op.itemKey === undefined ? {} : { itemKey: op.itemKey }),
      ...(op.userEdited === undefined ? {} : { userEdited: [...op.userEdited] }),
    })),
    ...(setup.deletedItemKeys === undefined ? {} : { deletedItemKeys: structuredClone(setup.deletedItemKeys) }),
  }))
  const digestItems = records.map(setup => ({ setupId: setup.setupId,
    items: setup.items.map(item => ({ operationId: item.operationId, orderIndex: item.orderIndex,
      enabled: item.enabled, ...(item.itemKey === undefined ? {} : { itemKey: item.itemKey }) })),
  }))
  return { contract: 'kernel.plan', schemaVersion: '1.0.0', setups: records,
    planDigest: `plan-v1-${planHash(digestItems)}` }
}

export type GeneratedOperation = Operation & { provenance: Provenance; itemKey: string }
