/**
 * GEO-1 tessellation transfer helper — PURE.
 * ==========================================
 * Collects the ArrayBuffers of a TessBuffers so they can be TRANSFERRED
 * (zero-copy, structured-clone transfer list) across the worker boundary
 * instead of deep-copied. Contract rule 4: tessellation buffers are
 * transferables. Comlink uses this list via Comlink.transfer(); a plain
 * postMessage would use it as the second argument.
 */
import type { TessBuffers } from '../geom-service.ts'

/**
 * The five typed-array payloads of a TessBuffers, in a fixed order. Deduped by
 * underlying ArrayBuffer so a transfer never lists the same buffer twice (which
 * throws DataCloneError). Small structured-clone-safe fields (faceIds/edgeIds)
 * are intentionally NOT transferred — they are copied.
 */
export function collectTransferables(t: TessBuffers): ArrayBuffer[] {
  const bufs = [
    t.position.buffer,
    t.normal.buffer,
    t.index.buffer,
    t.triFace.buffer,
    t.edgePositions.buffer,
    t.edgeOffsets.buffer,
  ]
  const seen = new Set<ArrayBuffer>()
  const out: ArrayBuffer[] = []
  for (const b of bufs) {
    // SharedArrayBuffer is not transferable; guard defensively.
    if (b instanceof ArrayBuffer && !seen.has(b)) {
      seen.add(b)
      out.push(b)
    }
  }
  return out
}
