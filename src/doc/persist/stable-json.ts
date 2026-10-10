export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

export function canonicalize(value: unknown): JsonValue {
  if (value === null) return null
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error("stableStringify: non-finite number '" + value + "' cannot be persisted.")
    return value
  }
  if (Array.isArray(value)) return value.map((item) => canonicalize(item))
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    throw new Error('stableStringify: binary data must be stored as a zip entry, not JSON.')
  }
  if (!isPlainObject(value)) {
    throw new Error("stableStringify: unsupported value type '" + Object.prototype.toString.call(value) + "'.")
  }

  const out: JsonObject = {}
  for (const key of Object.keys(value).sort()) {
    const child = value[key]
    if (child !== undefined) out[key] = canonicalize(child)
  }
  return out
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}
