// The ElementMap: the persistent-naming core of the document layer (WO DOC-1).
//
// Implements docs/stable-id-spec.md "Lineage recording (the ElementMap)" and the
// "Resolution algorithm (stableId -> current subshape)". It ingests the frozen
// ElementMapDelta records that (mock or real) modeling ops emit, maintains the
// per-body CURRENT map (which ids are live + the lineage edges between them), and
// resolves a stored stableId to its current survivor via the spec's 4 steps:
//   1. exact   2. lineage walk   3. geometric fallback   4. lost
//
// Design invariants (from the spec + geom-service.ts rules):
//  - Derived, never random. No Date.now, no Math.random, no iteration-order
//    dependence -- everything that emits is sorted first, so two identical build
//    sequences produce byte-identical id sets (asserted by the golden tests).
//  - "Silent wrong-binding is the one unforgivable failure mode; degrading is
//    always preferred." Every resolution returns a TYPED result carrying which
//    step bound it (or that it was lost) -- never a bare null.
//  - ZERO kernel dependency: only plain-data types are imported from
//    geom-service.ts; nothing here touches wasm, a worker, or occt.
//
// Geometry snapshots (needed by resolution steps 2 & 3) may arrive either in a
// COMPANION map alongside each delta (pre-ICR-1 pattern, still supported) or
// inline via the delta's optional `geometry` field (ICR-1, approved
// 2026-07-07). SurfaceType and GeometrySnapshot are now defined ONCE in the
// contract (src/geom/geom-service.ts) and re-exported here so existing
// importers keep working.

import type { Diag, ElementMapDelta, GeometrySnapshot, StableId, SurfaceType, Vec3 } from '../geom/geom-service'
import { compareIds } from './stable-id'

export type { GeometrySnapshot, SurfaceType }

/** Snapshots keyed by the id they describe, handed in alongside a delta. */
export type DeltaSnapshots = Record<StableId, GeometrySnapshot>

/** Which resolution step produced the binding (AC #3: caller-distinguishable). */
export type ResolutionVia = 'exact' | 'lineage' | 'geometric' | 'none'

/** Maps 1:1 onto GeomService.resolve()'s status union. */
export type ResolutionStatus = 'exact' | 'fallback' | 'lost'

/**
 * How a stored reference wants a split handled (spec resolution step 2):
 *  - 'single-face'   (e.g. a sketch plane): a split picks the max-overlap fragment.
 *  - 'face-set'      (e.g. a fillet face set): a split binds to ALL fragments.
 *  - 'single-edge'   (e.g. a plane axis): exact or one-survivor lineage only.
 *  - 'single-vertex' (e.g. a plane point): exact or one-survivor lineage only.
 *
 * Edge/vertex references intentionally have no face-snapshot geometric
 * fallback. A split or missing lineage degrades instead of borrowing the
 * face-only centroid/area heuristic and silently binding the wrong element.
 */
// WO UI-24-R2 (schema-derived loader validation): same derivation as dag.ts's DAG_NODE_KINDS -- the
// union is generated FROM this runtime tuple so a validator's allowlist can import the one true
// list instead of maintaining a second, driftable copy of the union members.
export const REFERENCE_KINDS = ['single-face', 'face-set', 'single-edge', 'single-vertex'] as const
export type ReferenceKind = (typeof REFERENCE_KINDS)[number]

export interface Resolution {
  id: StableId
  status: ResolutionStatus
  via: ResolutionVia
  /** current live id(s) this bound to; [] when lost. */
  boundTo: StableId[]
  diagnostics: Diag[]
}

export interface ElementMapOptions {
  /**
   * Bounding-box diagonal used for the geometric-fallback centroid tolerance
   * (spec: centroid dist < 0.5% bbox diag). If omitted it is derived from the
   * live snapshot centroids; a single-snapshot map falls back to this default.
   */
  bboxDiag?: number
}

// Geometric-fallback thresholds (docs/stable-id-spec.md resolution step 3).
const CENTROID_FRACTION = 0.005 // < 0.5% of the bbox diagonal
const NORMAL_DOT_MIN = 0.999
const AXIS_DOT_MIN = 0.999
const AREA_RATIO_MIN = 0.8
const AREA_RATIO_MAX = 1.25
const DEFAULT_BBOX_DIAG = 100 // mm, only when the map has too few snapshots

// Split-winner tie band (resolution step 2): fragments whose overlap (as a
// fraction of the parent area) and centroid distance (as a fraction of the
// parent's equivalent radius) are both within 1% of the best are a draw.
const SPLIT_TIE_FRACTION = 0.01
const SPLIT_TIE_EPS = 1e-9

// Surface types whose orientation is carried by an `axis` (a line) rather than a
// planar `normal`. For these, axis alignment is REQUIRED before a geometric-
// fallback bind (see geometricCandidates).
const AXIAL_SURFACES: ReadonlySet<SurfaceType> = new Set(['cylinder', 'cone', 'torus'])

export class ElementMap {
  // Currently-existing subshape ids (the "current map" cache).
  private readonly live = new Set<StableId>()
  // Ids that were explicitly deleted (an input with no survivor).
  private readonly deletedIds = new Set<StableId>()
  // Lineage: parent id -> its direct successor id(s) (from delta.modified).
  private readonly lineage = new Map<StableId, StableId[]>()
  // Every snapshot ever seen, keyed by id (kept for evolved parents too, so
  // split disambiguation can compare a now-dead parent against its fragments).
  private readonly snapshots = new Map<StableId, GeometrySnapshot>()
  // Audit trail of the featureIds applied, in order.
  private readonly featureLog: string[] = []

  private readonly bboxDiagOverride?: number

  constructor(opts: ElementMapOptions = {}) {
    this.bboxDiagOverride = opts.bboxDiag
  }

  // -------------------------------------------------------------------------
  // Delta application (docs/stable-id-spec.md "Lineage recording").
  // -------------------------------------------------------------------------

  /**
   * Apply one op's ElementMapDelta (optionally with a companion snapshot map).
   * created  -> delta.generated       (brand-new ids become live)
   * modified -> delta.modified         (parent evolves into child(ren); a split
   *             is one parent -> many children; a merge is many parents -> one
   *             shared child -- both fall out of this same edge recording)
   * deleted  -> delta.deleted          (input with no survivor)
   */
  applyDelta(delta: ElementMapDelta, snapshots?: DeltaSnapshots): this {
    this.featureLog.push(delta.featureId)

    for (const id of delta.generated) {
      this.live.add(id)
      this.deletedIds.delete(id)
    }

    for (const parent of Object.keys(delta.modified)) {
      const children = delta.modified[parent]
      this.recordLineage(parent, children)
      for (const child of children) {
        this.live.add(child)
        this.deletedIds.delete(child)
      }
      // The parent stops existing UNLESS it maps to itself (a retrim that keeps
      // the same identity, e.g. a chamfer nibbling a face's edge).
      if (!children.includes(parent)) this.live.delete(parent)
    }

    for (const id of delta.deleted) {
      this.live.delete(id)
      this.deletedIds.add(id)
    }

    // BK-16a (WO DOC-5): default to the delta's OWN inline geometry (ICR-1) when
    // no companion map is passed. Before this fix only replay.applyFeatureDelta
    // merged inline geometry into the companion argument, so a DIRECT applyDelta
    // caller shipping a post-GEO-2 delta (inline geometry, no side channel)
    // silently dropped every snapshot -- leaving resolution steps 2 & 3 blind.
    // A companion map, when present, stays authoritative here because
    // replay.applyFeatureDelta already folds inline geometry into it (inline
    // wins on disagreement) BEFORE calling this method, so that path is
    // byte-for-byte unchanged; only the previously-broken no-companion path
    // gains behavior.
    const effective = snapshots ?? delta.geometry
    if (effective) {
      for (const id of Object.keys(effective)) this.snapshots.set(id, effective[id])
    }
    return this
  }

  private recordLineage(parent: StableId, children: StableId[]): void {
    const existing = this.lineage.get(parent) ?? []
    const merged = existing.slice()
    for (const child of children) {
      if (child !== parent && !merged.includes(child)) merged.push(child)
    }
    if (merged.length > 0) this.lineage.set(parent, merged)
  }

  // -------------------------------------------------------------------------
  // Resolution (docs/stable-id-spec.md "Resolution algorithm").
  // -------------------------------------------------------------------------

  /** Resolve a stored stableId to its current survivor(s) via the 4 steps. */
  resolve(id: StableId, kind: ReferenceKind = 'single-face'): Resolution {
    // Step 1: exact.
    if (this.live.has(id)) {
      return { id, status: 'exact', via: 'exact', boundTo: [id], diagnostics: [] }
    }

    // Step 2: lineage walk -- collect the live descendants of this id.
    const survivors = this.liveDescendants(id)
    if (survivors.length === 1) {
      return { id, status: 'exact', via: 'lineage', boundTo: survivors, diagnostics: [] }
    }
    if (survivors.length > 1) {
      if (kind === 'face-set') {
        // A face-set reference accepts ALL fragments of a split.
        return { id, status: 'exact', via: 'lineage', boundTo: survivors, diagnostics: [] }
      }
      if (kind === 'single-face') {
        // A single-face reference takes the fragment with max area overlap vs the
        // id's last-known snapshot. With no snapshot to disambiguate, or a tie the
        // evidence cannot break, we DO NOT guess -> degrade to lost (silent
        // wrong-binding is the unforgivable case).
        const pick = this.pickSplitWinner(id, survivors)
        if (pick.winner) {
          return { id, status: 'exact', via: 'lineage', boundTo: [pick.winner], diagnostics: [] }
        }
        if (pick.tied > 1) {
          const lost = this.lost(id)
          lost.diagnostics[0].params = { id, reason: 'ambiguous-split', candidates: pick.tied }
          return lost
        }
      }
      return this.lost(id)
    }

    // Step 3: geometric fallback (no lineage path, e.g. feature reordered).
    // Snapshots are face fingerprints. Applying them to an edge or vertex
    // would be a type-confused silent fallback, so typed singular references
    // stop at exact/lineage and degrade here.
    const snap = kind === 'single-face' || kind === 'face-set' ? this.snapshots.get(id) : undefined
    if (snap) {
      const matches = this.geometricCandidates(snap)
      if (matches.length === 1) {
        return {
          id,
          status: 'fallback',
          via: 'geometric',
          boundTo: matches,
          diagnostics: [{ code: 'REFERENCE_FALLBACK', severity: 'warning', params: { id, boundTo: matches[0] } }],
        }
      }
      // Multiple or zero candidates -> do not guess.
    }

    // Step 4: lost.
    return this.lost(id)
  }

  private lost(id: StableId): Resolution {
    return {
      id,
      status: 'lost',
      via: 'none',
      boundTo: [],
      diagnostics: [{ code: 'REFERENCE_UNRESOLVED', severity: 'error', params: { id } }],
    }
  }

  // Forward BFS through the lineage DAG, returning the SORTED set of live ids
  // reachable from `id`. Cycle-guarded (a retrim self-edge is never stored, but
  // the visited set defends against any pathological input all the same).
  private liveDescendants(id: StableId): StableId[] {
    const found = new Set<StableId>()
    const visited = new Set<StableId>()
    const stack = [id]
    while (stack.length > 0) {
      const cur = stack.pop() as StableId
      if (visited.has(cur)) continue
      visited.add(cur)
      const kids = this.lineage.get(cur)
      if (!kids) continue
      for (const kid of kids) {
        if (this.live.has(kid)) found.add(kid)
        stack.push(kid)
      }
    }
    return [...found].sort(compareIds)
  }

  // Split disambiguation (spec step 2, single-face): the fragment of MAX AREA
  // OVERLAP with the parent's last-known geometry. Snapshots carry no boundary,
  // so each face is modelled as its equivalent disc (same area, centred on its
  // centroid) and the overlap is the disc-disc intersection area. Centroid
  // distance breaks a near-tie in overlap. If the best candidates are still
  // near-equal on both (a genuinely symmetric split) there is no evidence for
  // either, so no winner is returned and `tied` reports how many drew -- id
  // names and candidate order never decide. Requires same surfaceType.
  private pickSplitWinner(parentId: StableId, candidates: StableId[]): { winner?: StableId; tied: number } {
    const parentSnap = this.snapshots.get(parentId)
    if (!parentSnap) return { tied: 0 }
    const parentRadius = Math.sqrt(Math.max(parentSnap.area, 0) / Math.PI)
    const scored: Array<{ id: StableId; overlap: number; dist: number }> = []
    for (const cand of candidates) {
      const snap = this.snapshots.get(cand)
      if (!snap || snap.surfaceType !== parentSnap.surfaceType) continue
      const dist = distance(snap.centroid, parentSnap.centroid)
      scored.push({ id: cand, overlap: discOverlapArea(parentRadius, Math.sqrt(Math.max(snap.area, 0) / Math.PI), dist), dist })
    }
    if (scored.length === 0) return { tied: 0 }
    const overlapTol = Math.max(parentSnap.area * SPLIT_TIE_FRACTION, SPLIT_TIE_EPS)
    const distTol = Math.max(parentRadius * SPLIT_TIE_FRACTION, SPLIT_TIE_EPS)
    const maxOverlap = Math.max(...scored.map((s) => s.overlap))
    const byOverlap = scored.filter((s) => maxOverlap - s.overlap <= overlapTol)
    const minDist = Math.min(...byOverlap.map((s) => s.dist))
    const finalists = byOverlap.filter((s) => s.dist - minDist <= distTol)
    return finalists.length === 1 ? { winner: finalists[0].id, tied: 1 } : { tied: finalists.length }
  }

  // Geometric fallback candidates (spec step 3): live faces of the same
  // surfaceType within centroid / orientation / area tolerance of the snapshot.
  //
  // Orientation is checked two ways depending on surfaceType, because binding two
  // similar-centroid/area faces of DIFFERENT orientation is exactly the silent
  // wrong-bind the spec calls unforgivable:
  //  - PLANAR faces carry a `normal`: require the normals to be near-parallel.
  //  - CYLINDER/CONE/TORUS faces carry an `axis`: require the axes to be aligned.
  //    A cylinder/cone/torus axis is an undirected LINE -- its stored sign is not
  //    canonical across kernel re-derivations (a re-parametrized face may report
  //    the negated axis for the SAME physical feature). We therefore compare
  //    |dot(axis)|, so an ANTI-PARALLEL (sign-flipped) axis is deliberately
  //    treated as ALIGNED (avoids a spurious degrade), while a genuinely
  //    different axis direction is still rejected (the wrong-bind guard). If an
  //    axial-surface candidate is MISSING an axis on either side we reject it:
  //    alignment cannot be verified, so we do not guess.
  private geometricCandidates(snap: GeometrySnapshot): StableId[] {
    const tol = this.bboxDiag() * CENTROID_FRACTION
    const axial = AXIAL_SURFACES.has(snap.surfaceType)
    const out: StableId[] = []
    for (const id of this.live) {
      const cand = this.snapshots.get(id)
      if (!cand || cand.surfaceType !== snap.surfaceType) continue
      if (distance(cand.centroid, snap.centroid) >= tol) continue
      if (snap.normal && cand.normal && dot(unit(snap.normal), unit(cand.normal)) <= NORMAL_DOT_MIN) continue
      if (axial) {
        if (!snap.axis || !cand.axis) continue
        if (Math.abs(dot(unit(snap.axis), unit(cand.axis))) <= AXIS_DOT_MIN) continue
      }
      const ratio = snap.area === 0 ? (cand.area === 0 ? 1 : Infinity) : cand.area / snap.area
      if (ratio < AREA_RATIO_MIN || ratio > AREA_RATIO_MAX) continue
      out.push(id)
    }
    return out.sort(compareIds)
  }

  // Bounding-box diagonal for the fallback centroid tolerance. Derived from the
  // live snapshot centroids; falls back to the override / a fixed default when
  // there are too few points to span a box.
  private bboxDiag(): number {
    if (this.bboxDiagOverride !== undefined) return this.bboxDiagOverride
    let minX = Infinity, minY = Infinity, minZ = Infinity
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
    let count = 0
    for (const id of this.live) {
      const snap = this.snapshots.get(id)
      if (!snap) continue
      count++
      const c = snap.centroid
      if (c.x < minX) minX = c.x
      if (c.y < minY) minY = c.y
      if (c.z < minZ) minZ = c.z
      if (c.x > maxX) maxX = c.x
      if (c.y > maxY) maxY = c.y
      if (c.z > maxZ) maxZ = c.z
    }
    if (count < 2) return DEFAULT_BBOX_DIAG
    const dx = maxX - minX, dy = maxY - minY, dz = maxZ - minZ
    const diag = Math.sqrt(dx * dx + dy * dy + dz * dz)
    return diag > 0 ? diag : DEFAULT_BBOX_DIAG
  }

  // -------------------------------------------------------------------------
  // Queries (read-only accessors -- for callers and tests).
  // -------------------------------------------------------------------------

  has(id: StableId): boolean {
    return this.live.has(id)
  }

  isDeleted(id: StableId): boolean {
    return this.deletedIds.has(id)
  }

  /** Sorted snapshot of all currently-live ids. */
  liveIds(): StableId[] {
    return [...this.live].sort(compareIds)
  }

  /** Direct successors of an id (empty if none recorded). */
  successorsOf(id: StableId): StableId[] {
    return [...(this.lineage.get(id) ?? [])].sort(compareIds)
  }

  snapshotOf(id: StableId): GeometrySnapshot | undefined {
    return this.snapshots.get(id)
  }

  /** Ordered featureIds applied so far (audit). */
  appliedFeatures(): string[] {
    return [...this.featureLog]
  }

  // -------------------------------------------------------------------------
  // Serialization (docs/stable-id-spec.md Determinism / golden-file test).
  // -------------------------------------------------------------------------

  /**
   * Canonical, sort-stable serialization of the IDENTITY surface of the map
   * (live ids + deleted ids + lineage edges). Two identical build sequences
   * produce a byte-identical string; this is what the golden determinism test
   * compares. Geometry is intentionally excluded (ids are the identity).
   */
  serializeIds(): string {
    const live = [...this.live].sort(compareIds)
    const deleted = [...this.deletedIds].sort(compareIds)
    const lineage = [...this.lineage.entries()]
      .map(([parent, kids]) => [parent, [...kids].sort(compareIds)] as [string, string[]])
      .sort((a, b) => compareIds(a[0], b[0]))
    return JSON.stringify({ live, deleted, lineage })
  }
}

// --------------------------- small vec helpers -----------------------------
// (compareIds is imported from ./stable-id -- the single source of truth for id
// ordering -- rather than re-declared here.)

function distance(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

// Intersection area of two discs of radius r1, r2 whose centres are d apart.
function discOverlapArea(r1: number, r2: number, d: number): number {
  if (r1 <= 0 || r2 <= 0 || d >= r1 + r2) return 0
  const small = Math.min(r1, r2)
  if (d <= Math.abs(r1 - r2)) return Math.PI * small * small
  const a1 = r1 * r1 * Math.acos(clamp((d * d + r1 * r1 - r2 * r2) / (2 * d * r1)))
  const a2 = r2 * r2 * Math.acos(clamp((d * d + r2 * r2 - r1 * r1) / (2 * d * r2)))
  const k = 0.5 * Math.sqrt(Math.max(0, (-d + r1 + r2) * (d + r1 - r2) * (d - r1 + r2) * (d + r1 + r2)))
  return a1 + a2 - k
}

function clamp(v: number): number {
  return v < -1 ? -1 : v > 1 ? 1 : v
}

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z
}

function unit(v: Vec3): Vec3 {
  const len = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z)
  if (len === 0) return v
  return { x: v.x / len, y: v.y / len, z: v.z / len }
}
