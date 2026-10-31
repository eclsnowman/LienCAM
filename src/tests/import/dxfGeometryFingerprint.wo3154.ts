import { createHash } from 'node:crypto'
import type { Loop2D } from '../../types'

type LoopWithImportedCircle = Loop2D & { importedCircleDiameter?: number }

/**
 * The old DXF contracts fingerprinted every import result field except its
 * report.  Analytic CIRCLE provenance is deliberately checked by its own
 * contract, so this projection removes only that one optional loop fact.
 * Every other loop field (including future unknown fields) remains in the
 * serialized object and therefore continues to affect the fingerprint.
 */
export function projectDxfGeometryForFingerprint<T extends { loops: readonly Loop2D[] }>(value: T) {
  // Map the root entries rather than rebuilding a reduced shape: JSON key
  // order remains the original contract's order, and every root field stays.
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key,
    key === 'loops'
      ? (entry as readonly Loop2D[]).map(loop => {
          const { importedCircleDiameter: _provenance, ...geometryLoop } = loop as LoopWithImportedCircle
          return geometryLoop
        })
      : entry,
  ]))
}

export function dxfGeometryFingerprint<T extends { loops: readonly Loop2D[] }>(value: T): string {
  const stable = JSON.stringify(projectDxfGeometryForFingerprint(value), (_key, entry) =>
    typeof entry === 'number' ? Math.round(entry * 1e9) / 1e9 : entry)
  return createHash('sha256').update(stable).digest('hex').slice(0, 16)
}
