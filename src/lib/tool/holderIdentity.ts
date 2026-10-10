// WO-1440 (BUG-508, family K5): an incoming holder's id is an identity CLAIM
// (usually an external-format GUID), not a content guarantee. Both holder write
// paths - addHolder (library import) and loadProjectFromFile's holder merge -
// resolve an incoming holder against the library through this one primitive, so
// a same-id holder with different geometry can never silently replace, or be
// silently replaced by, the one already there.

import type { ToolHolder } from '../../types'

// Lengths are compared to a micrometre-of-a-micrometre: far below anything a
// holder drawing states, far above float round-trip noise through JSON.
const LENGTH_QUANTUM = 1e-6

function quantize(value: unknown): number | string {
  if (typeof value !== 'number') return String(value)
  if (!Number.isFinite(value)) return String(value)
  const q = Math.round(value / LENGTH_QUANTUM) * LENGTH_QUANTUM
  return Number(q.toFixed(6))
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** Canonical string of the content that makes a holder physically what it is:
 *  its segment stack, gauge length, vendor and product id. Name and description
 *  are labels, not geometry, and do not take part. */
export function holderContentKey(holder: ToolHolder): string {
  const segments = Array.isArray(holder.segments) ? holder.segments : []
  return JSON.stringify({
    segments: segments.map((segment) => [
      quantize(segment?.height),
      quantize(segment?.lowerDiameter),
      quantize(segment?.upperDiameter),
    ]),
    gaugeLength: holder.gaugeLength === undefined || holder.gaugeLength === null
      ? null
      : quantize(holder.gaugeLength),
    vendor: text(holder.vendor),
    productId: text(holder.productId),
  })
}

export function holdersShareContent(a: ToolHolder, b: ToolHolder): boolean {
  return holderContentKey(a) === holderContentKey(b)
}

// FNV-1a, 32-bit. Only used to derive a stable id for a conflicting holder, so the
// same file reopened twice lands on the same record instead of minting a new one
// every time; a hash collision is caught by the content check below.
function contentHash(key: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

export interface HolderResolution {
  /** The id tools arriving with this holder must link to. */
  id: string
  /** The record to append to the library, or null when an existing record with
   *  identical content is shared. */
  record: ToolHolder | null
  /** True when the incoming id was already taken by a holder with DIFFERENT
   *  content, so the incoming holder was given an identity of its own. */
  reidentified: boolean
}

/**
 * Resolve one incoming holder against the holders already in the library.
 *
 * - No id, or an id nobody has: added under that id (a fresh one if missing).
 * - Same id, same content: shares the existing record (no id churn).
 * - Same id, different content: neither record is dropped. The incoming holder
 *   gets an id derived from its content (or a fresh one if that is somehow
 *   taken by different content) and the library record is left untouched.
 */
export function resolveIncomingHolder(
  library: readonly ToolHolder[],
  incoming: ToolHolder,
  mintId: () => string = () => crypto.randomUUID(),
): HolderResolution {
  const claimed = typeof incoming.id === 'string' && incoming.id.length > 0 ? incoming.id : ''
  const byId = (id: string) => library.find((holder) => holder.id === id)

  if (!claimed) {
    let id = mintId()
    while (byId(id)) id = mintId()
    return { id, record: { ...incoming, id }, reidentified: false }
  }
  const existing = byId(claimed)
  if (!existing) return { id: claimed, record: { ...incoming, id: claimed }, reidentified: false }
  const key = holderContentKey(incoming)
  if (holderContentKey(existing) === key) return { id: claimed, record: null, reidentified: false }

  const derived = `${claimed}~${contentHash(key)}`
  const atDerived = byId(derived)
  if (atDerived && holderContentKey(atDerived) === key) {
    return { id: derived, record: null, reidentified: true }
  }
  let id = derived
  while (byId(id)) id = mintId()
  return { id, record: { ...incoming, id }, reidentified: true }
}

export interface HolderMerge {
  /** Records to append to the library, in incoming order. */
  added: ToolHolder[]
  /** Incoming id -> the id it resolved to, only where the two differ. */
  remap: Map<string, string>
  /** Incoming holders that collided with different content under the same id. */
  reidentified: Array<{ name: string; claimedId: string; id: string }>
}

/** Resolve a batch of incoming holders (a project file's embedded holders)
 *  against the library, each one also seeing the ones merged before it. */
export function mergeIncomingHolders(
  library: readonly ToolHolder[],
  incoming: readonly ToolHolder[],
  mintId?: () => string,
): HolderMerge {
  const merged: ToolHolder[] = [...library]
  const added: ToolHolder[] = []
  const remap = new Map<string, string>()
  const reidentified: HolderMerge['reidentified'] = []
  for (const holder of incoming) {
    if (!holder || typeof holder !== 'object') continue
    const resolution = resolveIncomingHolder(merged, holder, mintId)
    if (resolution.record) {
      merged.push(resolution.record)
      added.push(resolution.record)
    }
    if (holder.id && resolution.id !== holder.id) remap.set(holder.id, resolution.id)
    if (resolution.reidentified && resolution.record) {
      reidentified.push({ name: holder.name, claimedId: holder.id, id: resolution.id })
    }
  }
  return { added, remap, reidentified }
}
