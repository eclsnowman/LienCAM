// viewport3d: TessBuffers -> cached Three.js BufferGeometry + MeshBVH.
//
// One entry per BodyId. Tessellation buffers are transferables per the
// geom-service contract (rule 4): attributes are wired directly onto the
// caller's typed arrays, zero-copy. Re-ingesting the same BodyId (new
// tessellation after a regen, or a coarser/finer quality pass) disposes the
// prior entry's GPU-side buffers before the replacement lands, so repeated
// ingestion never leaks -- there is exactly one live BufferGeometry (+ one
// edge BufferGeometry) per BodyId at all times.
//
// BVH built with `indirect: true`: three-mesh-bvh's default build REORDERS
// the geometry's index buffer in place to a spatially-coherent leaf order
// (verified against three-mesh-bvh 0.9.10 -- a raycast on a 2000-triangle
// mesh returned faceIndex 0 for a triangle planted at original index 1999).
// triFace is "parallel to triangles" in the ORIGINAL upload order, so a
// reordered index would silently mis-map every raycast hit to the wrong
// face's stable id. `indirect: true` leaves the index buffer untouched and
// keeps raycastFirst().faceIndex aligned with triFace (re-verified with the
// same probe: faceIndex 1999 comes back correctly).

import type { BufferGeometry } from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import type { BodyId, TessBuffers } from './types';
import { buildBufferGeometry, buildEdgeLineGeometry, validateTessBuffers } from './tessGeometry';
import { withoutSmoothFormFacetEdges } from '../form/formEdges';

export interface CachedBody {
  bodyId: BodyId;
  /** Monotonically bumped on every ingest() of this bodyId, INCLUDING across
   *  an evict() + re-ingest of the same id (WO UI-1-R1, R1.1) -- lets
   *  dependents (PickEngine's vertex memo) cheaply detect a stale derived
   *  cache by keying on (bodyId, version) instead of bodyId alone. */
  version: number;
  geometry: BufferGeometry;
  /** Line-segment geometry for edge overlays; zero vertices when the body
   *  has no edge polylines (e.g. a degenerate mock fixture) -- never null,
   *  so callers don't need a null-check to add it to a scene. */
  edgeGeometry: BufferGeometry;
  bvh: MeshBVH;
  /** Parallel to the triangle stream; triFace[t] is the LOCAL INDEX into
   *  faceIds for triangle t. STABILITY NOTE (S5 audit Q1, 2026-07-22): the
   *  ORDER of faceIds/triFace comes from the kernel tessellation's face
   *  iteration order and carries no cross-version/cross-platform stability
   *  guarantee. This is safe because ModelReference never persists a local
   *  index - only stableIds[] (see modelBodyDisplay.ts's fuller note). A
   *  pick's local index is only ever resolved against the SAME CachedBody it
   *  came from within one session. */
  triFace: Uint32Array;
  faceIds: readonly string[];
  edgeIds: readonly string[];
  edgeOffsets: Uint32Array;
  edgePositions: Float32Array;
}

/**
 * A complete cache entry built off to the side of the live cache. A prepared
 * entry owns real GPU resources, but is not visible through get()/has() until
 * adoptPrepared() succeeds. It must therefore be either adopted or disposed.
 */
export type PreparedCachedBody = CachedBody;

/**
 * Exact committed presentation retained across a destructive preview ingest.
 * The token belongs to this cache and must be restored or released exactly once.
 */
export interface RetainedCachedBody {
  readonly bodyId: BodyId;
  readonly entry: CachedBody;
}

export interface PreparedAdoptionTransaction {
  readonly adopted: readonly CachedBody[];
  commit(): void;
  rollback(): void;
}

export class GeometryCache {
  private readonly entries = new Map<BodyId, CachedBody>();
  /** Per-bodyId generation counter (WO UI-1-R1, R1.1). Survives evict() --
   *  unlike `entries`, this map is never deleted from, only grown -- so a
   *  bodyId's version strictly increases across its whole ingest/evict
   *  history, not just within one live entry. Without this, a bodyId
   *  evicted then re-ingested restarts its version at 1 (prior is gone), so
   *  a dependent's memo keyed on (bodyId, version) can alias a DIFFERENT
   *  body's version-1 snapshot as still current. */
  private readonly generations = new Map<BodyId, number>();
  private readonly ownedPrepared = new WeakSet<PreparedCachedBody>();
  private readonly settledPrepared = new WeakSet<PreparedCachedBody>();
  private readonly retained = new Map<BodyId, RetainedCachedBody>();
  private readonly settledRetained = new WeakSet<RetainedCachedBody>();

  /**
   * Build a complete geometry/edge/BVH entry without changing live cache
   * membership, generation, or the currently rendered entry. If construction
   * throws, every resource constructed by this call is disposed here.
   */
  prepare(bodyId: BodyId, rawBuffers: TessBuffers): PreparedCachedBody {
    validateTessBuffers(rawBuffers);
    // A form body's facets meet smoothly almost everywhere; only its creases
    // and cuts are edges worth drawing (src/form/formEdges.ts). Every other
    // body's buffers pass through unchanged (same object).
    const buffers = withoutSmoothFormFacetEdges(rawBuffers);
    let geometry: BufferGeometry | undefined;
    let edgeGeometry: BufferGeometry | undefined;
    try {
      geometry = buildBufferGeometry(buffers);
      const bvh = new MeshBVH(geometry, { indirect: true });
      edgeGeometry = buildEdgeLineGeometry(buffers);
      const prepared: PreparedCachedBody = {
        bodyId,
        version: (this.generations.get(bodyId) ?? 0) + 1,
        geometry,
        edgeGeometry,
        bvh,
        triFace: buffers.triFace,
        faceIds: buffers.faceIds,
        edgeIds: buffers.edgeIds,
        edgeOffsets: buffers.edgeOffsets,
        edgePositions: buffers.edgePositions,
      };
      this.ownedPrepared.add(prepared);
      return prepared;
    } catch (err) {
      geometry?.dispose();
      edgeGeometry?.dispose();
      throw err;
    }
  }

  /**
   * Atomically publish a prepared entry. The prior live entry is not disposed
   * until the replacement has passed ownership/version validation and landed
   * in the cache map.
   */
  adoptPrepared(prepared: PreparedCachedBody): CachedBody {
    const transaction = this.beginPreparedAdoption([prepared]);
    transaction.commit();
    return prepared;
  }

  /**
   * Validate and publish a complete prepared set while keeping every prior
   * entry alive until commit. rollback() restores exact entry/generation
   * identity and disposes the staged set.
   */
  beginPreparedAdoption(preparedEntries: readonly PreparedCachedBody[]): PreparedAdoptionTransaction {
    const bodyIds = new Set<BodyId>();
    const records = preparedEntries.map((prepared) => {
      if (bodyIds.has(prepared.bodyId)) {
        throw new Error(`GeometryCache: duplicate prepared body '${prepared.bodyId}'`);
      }
      bodyIds.add(prepared.bodyId);
      this.assertPreparedOwnership(prepared);
      const priorGeneration = this.generations.get(prepared.bodyId);
      const expectedVersion = (priorGeneration ?? 0) + 1;
      if (prepared.version !== expectedVersion) {
        throw new Error(
          `GeometryCache: prepared '${prepared.bodyId}' version ${prepared.version} is stale (expected ${expectedVersion})`,
        );
      }
      return {
        prepared,
        prior: this.entries.get(prepared.bodyId),
        priorGeneration,
      };
    });

    for (const { prepared } of records) {
      this.entries.set(prepared.bodyId, prepared);
      this.generations.set(prepared.bodyId, prepared.version);
      this.settledPrepared.add(prepared);
    }

    let active = true;
    return {
      adopted: records.map(({ prepared }) => prepared),
      commit: () => {
        if (!active) return;
        active = false;
        for (const { prepared, prior } of records) {
          if (prior !== undefined && this.retained.get(prepared.bodyId)?.entry !== prior) {
            this.disposeEntry(prior);
          }
        }
      },
      rollback: () => {
        if (!active) return;
        active = false;
        for (const { prepared, prior, priorGeneration } of records) {
          if (prior === undefined) this.entries.delete(prepared.bodyId);
          else this.entries.set(prepared.bodyId, prior);
          if (priorGeneration === undefined) this.generations.delete(prepared.bodyId);
          else this.generations.set(prepared.bodyId, priorGeneration);
          this.disposeEntry(prepared);
        }
      },
    };
  }

  /** Dispose an unadopted prepared entry exactly once. */
  disposePrepared(prepared: PreparedCachedBody): void {
    if (!this.ownedPrepared.has(prepared) || this.settledPrepared.has(prepared)) return;
    this.settledPrepared.add(prepared);
    this.disposeEntry(prepared);
  }

  /** Compatibility path for ordinary immediate ingestion. */
  ingest(bodyId: BodyId, buffers: TessBuffers): CachedBody {
    const prepared = this.prepare(bodyId, buffers);
    try {
      return this.adoptPrepared(prepared);
    } catch (err) {
      this.disposePrepared(prepared);
      throw err;
    }
  }

  /** Keep the exact live entry alive while preview ingests replace cache membership. */
  retain(bodyId: BodyId): RetainedCachedBody | undefined {
    const entry = this.entries.get(bodyId);
    if (entry === undefined) return undefined;
    if (this.retained.has(bodyId)) {
      throw new Error(`GeometryCache: '${bodyId}' already has a retained presentation`);
    }
    const token: RetainedCachedBody = { bodyId, entry };
    this.retained.set(bodyId, token);
    return token;
  }

  /** Restore exact cache/BVH/geometry identity after a refused or cancelled preview. */
  restoreRetained(token: RetainedCachedBody): CachedBody {
    this.assertRetainedOwnership(token);
    const current = this.entries.get(token.bodyId);
    if (current !== undefined && current !== token.entry) this.disposeEntry(current);
    this.entries.set(token.bodyId, token.entry);
    this.settleRetained(token);
    return token.entry;
  }

  /** Accept the current replacement and dispose the superseded retained entry. */
  releaseRetained(token: RetainedCachedBody): void {
    this.assertRetainedOwnership(token);
    if (this.entries.get(token.bodyId) !== token.entry) this.disposeEntry(token.entry);
    this.settleRetained(token);
  }

  isRetained(token: RetainedCachedBody): boolean {
    return this.retained.get(token.bodyId) === token && !this.settledRetained.has(token);
  }

  private assertPreparedOwnership(prepared: PreparedCachedBody): void {
    if (!this.ownedPrepared.has(prepared)) {
      throw new Error(`GeometryCache: prepared '${prepared.bodyId}' belongs to another cache`);
    }
    if (this.settledPrepared.has(prepared)) {
      throw new Error(`GeometryCache: prepared '${prepared.bodyId}' was already adopted or disposed`);
    }
  }

  private assertRetainedOwnership(token: RetainedCachedBody): void {
    if (this.retained.get(token.bodyId) !== token || this.settledRetained.has(token)) {
      throw new Error(`GeometryCache: retained '${token.bodyId}' is not active in this cache`);
    }
  }

  private settleRetained(token: RetainedCachedBody): void {
    this.retained.delete(token.bodyId);
    this.settledRetained.add(token);
  }

  get(bodyId: BodyId): CachedBody | undefined {
    return this.entries.get(bodyId);
  }

  has(bodyId: BodyId): boolean {
    return this.entries.has(bodyId);
  }

  evict(bodyId: BodyId): void {
    const entry = this.entries.get(bodyId);
    if (entry === undefined) return;
    this.disposeEntry(entry);
    this.entries.delete(bodyId);
  }

  disposeAll(): void {
    for (const token of this.retained.values()) {
      if (this.entries.get(token.bodyId) !== token.entry) this.disposeEntry(token.entry);
      this.settledRetained.add(token);
    }
    this.retained.clear();
    for (const bodyId of [...this.entries.keys()]) this.evict(bodyId);
  }

  private disposeEntry(entry: CachedBody): void {
    entry.geometry.dispose();
    entry.edgeGeometry.dispose();
  }
}
