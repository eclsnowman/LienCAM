// viewport3d: two-phase progressive tessellation (WO UI-2, architect ruling
// #2). First paint uses COARSE_TESS_QUALITY; once that lands, a DISPLAY_TESS_
// QUALITY pass replaces it under the SAME bodyId, so GeometryCache.ingest()'s
// existing dispose-prior-entry behavior (see GeometryCache.ts) frees the
// coarse GPU buffers automatically -- no separate unmount step, no leak, and
// exactly one live BufferGeometry per bodyId at all times, same as any other
// re-ingest.
//
// Deliberately NOT coupled to GeomClient/GeomService or any worker-spawning
// concern: callers hand in whatever object satisfies TessellatingClient
// (a real client, a GeomBridgeSession's held client, or a hand-rolled fake in
// tests), keeping this module trivially fakeable.

import type { BodyHandle, TessBuffers, TessQuality } from '../geom/geom-service';
import type { CachedBody, GeometryCache } from './GeometryCache';
import { COARSE_TESS_QUALITY, DISPLAY_TESS_QUALITY } from './tessQuality';
import type { BodyId } from './types';

/** Minimal structural interface this module needs from a geometry client --
 *  intentionally narrower than GeomService/GeomClient so tests can fake it
 *  with a single method. */
export interface TessellatingClient {
  tessellate(handle: BodyHandle, quality: TessQuality): Promise<TessBuffers>;
}

export type TessPaintPhase = 'coarse' | 'display';

export interface ProgressiveTessellateResult {
  coarse: CachedBody;
  display: CachedBody;
}

/** Quality pair for a two-phase progressive pass (WO INT-1: STEP-imported
 *  bodies use scale-relative tiers from the GEO-2 facade's tessQualityForTier
 *  instead of the fixed COARSE/DISPLAY constants below, since a 40mm demo box
 *  and a 400mm STEP part need very different absolute deflections to land in
 *  the same visual/perf budget). */
export interface TierQualities {
  coarse: TessQuality;
  display: TessQuality;
}

/**
 * INTERFACE GAP discovered while building this WO against the REAL GEO-1
 * engine (src/geom/worker/geom-engine.ts `tessellate()`), not something this
 * module invents: viewport3d/tessGeometry.ts's `validateTessBuffers()` (UI-1,
 * out of this WO's touch scope) requires `edgeOffsets.length ===
 * edgeIds.length + 1` -- a full CSR table with a trailing sentinel equal to
 * the total edge-point count (that file's own header already flagged this as
 * "an assumption for GEO lane to confirm"). The real engine's edge loop
 * pushes exactly one `pointStart` per edge and never appends that trailing
 * sentinel, so `edgeOffsets.length === edgeIds.length` -- one short. Every
 * OTHER entry it does emit is correct (each edge's start is the previous
 * edge's natural end, since occt-wasm's wireframe() lays edge points out
 * contiguously in emission order -- the same contiguity
 * validateTessBuffers's own monotonic-offsets check already assumes). This
 * reconstructs the single missing trailing value from `edgePositions.length /
 * 3` (the total edge-point count, which IS the correct final boundary for a
 * contiguous CSR table) rather than guessing -- a no-op for any buffers that
 * already carry the full table (mock fixtures, or a future engine fix).
 * Flagged as an interfaceConcern in the WO report; the real fix belongs in
 * geom-engine.ts (append the sentinel there) or a documented contract
 * amendment, neither of which this WO may make (src/geom/** is frozen).
 */
function normalizeEdgeOffsets(buffers: TessBuffers): TessBuffers {
  const expectedLength = buffers.edgeIds.length + 1;
  if (buffers.edgeOffsets.length === expectedLength) return buffers;
  if (buffers.edgeOffsets.length !== expectedLength - 1) return buffers; // unexpected shape: let validateTessBuffers fail loud
  const totalEdgePoints = buffers.edgePositions.length / 3;
  const edgeOffsets = new Uint32Array(expectedLength);
  edgeOffsets.set(buffers.edgeOffsets);
  edgeOffsets[expectedLength - 1] = totalEdgePoints;
  return { ...buffers, edgeOffsets };
}

/** Shared two-phase implementation: tessellate `handle` at `qualities.coarse`,
 *  ingest + paint, then tessellate at `qualities.display` and ingest + paint
 *  again under the same bodyId. Resolves once both tiers have landed
 *  (callers wanting to react to the coarse tier alone should do so from
 *  `onPaint('coarse', ...)`, not by racing this promise). */
async function runProgressiveTessellate(
  client: TessellatingClient,
  cache: GeometryCache,
  bodyId: BodyId,
  handle: BodyHandle,
  qualities: TierQualities,
  onPaint?: (phase: TessPaintPhase, body: CachedBody) => void,
): Promise<ProgressiveTessellateResult> {
  const coarseBuffers = normalizeEdgeOffsets(await client.tessellate(handle, qualities.coarse));
  const coarse = cache.ingest(bodyId, coarseBuffers);
  onPaint?.('coarse', coarse);

  const displayBuffers = normalizeEdgeOffsets(await client.tessellate(handle, qualities.display));
  // Re-ingesting the same bodyId disposes `coarse`'s geometry/edgeGeometry
  // before this entry lands (GeometryCache.ingest doc comment) -- no leak.
  const display = cache.ingest(bodyId, displayBuffers);
  onPaint?.('display', display);

  return { coarse, display };
}

/** Fixed-tier variant (original WO UI-2 shape, unchanged signature/behavior)
 *  -- used by the demo box, where a fixed absolute deflection was tuned by
 *  hand for its known 40mm scale. */
export async function progressiveTessellate(
  client: TessellatingClient,
  cache: GeometryCache,
  bodyId: BodyId,
  handle: BodyHandle,
  onPaint?: (phase: TessPaintPhase, body: CachedBody) => void,
): Promise<ProgressiveTessellateResult> {
  return runProgressiveTessellate(
    client,
    cache,
    bodyId,
    handle,
    { coarse: COARSE_TESS_QUALITY, display: DISPLAY_TESS_QUALITY },
    onPaint,
  );
}

/** Scale-relative variant (WO INT-1): caller supplies qualities computed from
 *  the body's own bbox diagonal (see src/geom/index.ts tessQualityForTier),
 *  so the same two-phase progressive behavior works at any part scale --
 *  a 40mm demo box and a 400mm STEP import both get a fast, visually-coarse
 *  first paint followed by a refine swap, instead of one fixed absolute
 *  deflection under- or over-shooting depending on scale. */
export async function progressiveTessellateAtQuality(
  client: TessellatingClient,
  cache: GeometryCache,
  bodyId: BodyId,
  handle: BodyHandle,
  qualities: TierQualities,
  onPaint?: (phase: TessPaintPhase, body: CachedBody) => void,
): Promise<ProgressiveTessellateResult> {
  return runProgressiveTessellate(client, cache, bodyId, handle, qualities, onPaint);
}
