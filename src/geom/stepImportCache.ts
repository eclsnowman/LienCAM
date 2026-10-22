/** Worker-local STEP evaluations. Exact byte comparison guards hash collisions;
 * every retained kernel shape is owned by this cache and released on eviction.
 * The frozen import API has default reader options and identity placement only.
 * Any future parameter must be supplied here before it can participate in reuse.
 */
export interface StepImportKey {
  importId: string
  options: string
  placement: readonly number[]
  kernelVersion: string
  engineVersion: string
}

function signature(bytes: Uint8Array, key: StepImportKey): string {
  let hash = 2166136261
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 16777619)
  return JSON.stringify([bytes.length, hash >>> 0, key.importId, key.options,
    key.placement, key.kernelVersion, key.engineVersion])
}

function complete(key: StepImportKey): boolean {
  return [key.importId, key.options, key.kernelVersion, key.engineVersion]
    .every(value => typeof value === 'string' && value.length > 0) &&
    Array.isArray(key.placement) && key.placement.length === 12 && key.placement.every(Number.isFinite)
}

export class StepImportCache<T> {
  readonly #entries = new Map<string, { signature: string; bytes: Uint8Array; value: T }>()
  readonly #release: (value: T) => void
  constructor(release: (value: T) => void) { this.#release = release }

  get(source: ArrayBuffer, key: StepImportKey): T | undefined {
    if (!complete(key)) return undefined
    const entry = this.#entries.get(key.importId)
    const bytes = new Uint8Array(source)
    if (!entry || entry.signature !== signature(bytes, key) ||
      !entry.bytes.every((byte, i) => byte === bytes[i])) return undefined
    return entry.value
  }

  set(source: ArrayBuffer, key: StepImportKey, value: T): void {
    if (!complete(key)) { this.#release(value); return }
    this.delete(key.importId)
    // Eight recent imports bound retained native shapes and byte buffers.
    if (this.#entries.size >= 8) this.delete(this.#entries.keys().next().value!)
    const bytes = new Uint8Array(source).slice()
    this.#entries.set(key.importId, { signature: signature(bytes, key), bytes, value })
  }

  delete(importId: string): void {
    const entry = this.#entries.get(importId)
    if (entry) { this.#entries.delete(importId); this.#release(entry.value) }
  }

  clear(): void {
    for (const id of this.#entries.keys()) this.delete(id)
  }
}
