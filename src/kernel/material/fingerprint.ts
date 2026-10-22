// WO-3032: the material service's value fingerprint - a copy of today's
// smartHeightEvidenceFingerprint (src/lib/cam/smartHeights/adaptive3d.ts:105-136,
// not edited), the hash the adaptive hand-off already compares. A copy, not an
// import: src/kernel/heights has no caller until a family switches (WO-3020
// boundary), and the kernel may not import src/lib/cam/smartHeights.

function canonical(value: unknown): unknown {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return String(value)
    return Object.is(value, -0) ? 0 : value
  }
  if (value === null || typeof value !== 'object') return value
  if (ArrayBuffer.isView(value)) return Array.from(value as unknown as ArrayLike<number>)
  if (Array.isArray(value)) return value.map(canonical)
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => [key, canonical(entry)]),
  )
}

/** Deterministic identity of a value (hashes values, never object identity). */
export function materialFingerprint(value: unknown): string {
  const text = JSON.stringify(canonical(value)) ?? 'undefined'
  let a = 0x811c9dc5
  let b = 0x9e3779b9
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    a = Math.imul(a ^ code, 0x01000193) >>> 0
    b = Math.imul(b ^ code, 0x85ebca6b) >>> 0
  }
  return `smart-height-${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0')}`
}
