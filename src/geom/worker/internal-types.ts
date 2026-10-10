/**
 * GEO-1 worker-internal types — NOT part of the frozen GeomService contract.
 * ==========================================================================
 * These live entirely worker-side (or engine-side) and never cross into the
 * frozen `src/geom/geom-service.ts` shapes. In particular the geometry
 * snapshot travels as a COMPANION MAP (`DeltaSnapshots`) retrievable alongside
 * an `ElementMapDelta`, per GEO-1 architect ruling #3. ICR-1 (APPROVED and
 * applied 2026-07-07) added an optional `geometry?` field + contract-level
 * GeometrySnapshot/SurfaceType to geom-service.ts; switching this worker to
 * emit inline snapshots (collapsing FaceSurfaceKind -> contract SurfaceType)
 * is GEO-2 scope (BK-10a).
 */
import type { StableId, SubshapeType } from '../geom-service.ts'

/** occt-wasm SurfaceKind, restated locally so this file has no kernel import.
 *  Finer-grained than the contract's SurfaceType (ICR-1, landed 2026-07-07);
 *  the GEO-2 inline-snapshot wiring collapses this to SurfaceType at the
 *  contract boundary (bezier/offset/revolution/extrusion -> 'other' or
 *  'bspline' per classifyFace semantics). */
export type FaceSurfaceKind =
  | 'plane'
  | 'cylinder'
  | 'cone'
  | 'sphere'
  | 'torus'
  | 'bspline'
  | 'bezier'
  | 'offset'
  | 'revolution'
  | 'extrusion'
  | 'other'

/**
 * Small, serializable geometry fingerprint captured for every named face at
 * bind time. This is exactly the data the stable-ID resolver's geometric
 * fallback needs (stable-id-spec §3): surfaceType + centroid + normal/axis +
 * area. Kept OUTSIDE the frozen delta as the companion-map value type.
 */
export interface GeometrySnapshot {
  type: FaceSurfaceKind
  /** face bounding-box center (getCenterOfMass is unusable for planar faces in
   *  occt-wasm 3.6.1 — returns [0,0,0]; the AABB midpoint is deterministic). */
  centroid: [number, number, number]
  /** representative surface normal/axis at the face's UV midpoint (unit-ish). */
  normal: [number, number, number]
  area: number
  /** GEO-2 (BK / ICR-1): best-effort axis direction for cylinder/cone/torus
   *  faces only, derived from two surface-normal probes (see geom-engine.ts
   *  #probeFace). Absent when the face isn't axial or the probe degenerates. */
  axis?: [number, number, number]
  /** Worker-only analytic cylinder identity used by same-domain healing.
   *  `axisPoint` may lie anywhere on the undirected cylinder axis. These stay
   *  out of the frozen service snapshot; they exist so a healed cylindrical
   *  face is accepted only when every contributor is provably coaxial and
   *  same-radius. */
  axisPoint?: [number, number, number]
  radius?: number
}

/** Companion map returned ALONGSIDE (never inside) an ElementMapDelta. */
export type DeltaSnapshots = Record<StableId, GeometrySnapshot>

/**
 * Per-body record the engine holds worker-side, keyed by BodyHandle. The shape
 * behind a handle is immutable (every op yields a NEW handle), so the kernel
 * face hashes captured here stay valid for the handle's whole lifetime, even
 * though hashes are NOT stable across separate build runs (verified 2026-07-07).
 */
export interface BodyRecord {
  /** raw occt-wasm ShapeHandle (number); kept opaque here to avoid the import. */
  shape: number
  /** current kernel face-hash -> stable ID (valid for this handle only). */
  faceMap: Map<number, StableId>
  /** stable ID -> geometry snapshot (the companion map source of truth). */
  snapshots: Map<StableId, GeometrySnapshot>
  /** WO UI-57 Design 5: an id no longer present in `faceMap` because a
   *  unifySameDomain healing MERGED its face into a survivor -- maps the
   *  losing (aliased) id to the CURRENT id it merged into (which may itself
   *  chain through further aliases across later edits). Optional/absent for
   *  every body that never underwent a merge-healing edit -- every existing
   *  #mint() call site is unaffected. Consulted by resolve() and
   *  #resolveFaceSnap() so an id from BEFORE a healed commit still resolves
   *  (never a silent 'lost'/refusal) instead of requiring every caller to
   *  know about merges. */
  aliases?: Map<StableId, StableId>
}

/** One decoded EvolutionData record: an input face and the output faces it
 *  became. occt-wasm flattens history as [inHash, count, ...outHashes]. */
export interface EvolutionRecord {
  inHash: number
  outHashes: number[]
}

/** A face read out of the kernel with everything the ID layer needs. */
export interface FaceProbe {
  hash: number
  snapshot: GeometrySnapshot
}

export type { StableId, SubshapeType }
