// WO-3020 (alpha.3 A3-11, parity): one evidence fingerprint convention for both
// lanes - a copy of smartHeightEvidenceFingerprint (src/lib/cam/smartHeights/
// adaptive3d.ts:105-136, not edited), which every family builder already shares.

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

/** Small deterministic identity used by Smart Height evidence and retained
 * material compatibility. It deliberately hashes values, not object identity. */
export function heightsFingerprint(value: unknown): string {
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

