/**
 * GEO-1 stable-ID derivation — PURE, kernel-free, deterministic.
 * ==============================================================
 * Governs hash -> stableId translation per docs/stable-id-spec.md. Every
 * function here is a pure transform over plain data so it is unit-testable
 * without the wasm kernel, and — critically — produces byte-identical IDs for
 * byte-identical geometry regardless of the kernel's ephemeral face hashes
 * (occt-wasm hashes differ across build runs; verified 2026-07-07).
 *
 * EDGE JOINER (GEO-1-R1.2): edge IDs use the stable-id-spec joiner exactly, the
 * U+2227 logical-AND wedge `(faceA∧faceB)`. To guarantee this lane can NEVER
 * drift from the merged DOC lane's resolver keys, we import DOC-1's single
 * EDGE_JOIN constant (src/doc/stable-id.ts) rather than re-declaring our own —
 * a read of a write-forbidden lane, which the R1 order explicitly permits. A
 * cross-module test (src/tests/geom/stable-id.test.ts) pins the two identical.
 */
import type { StableId } from '../geom-service.ts'
import type { EvolutionRecord, FaceProbe, GeometrySnapshot } from './internal-types.ts'
// UI-57-R2 blocker: THE one alias carry-forward, shared with geom-engine.ts's
// own producers (see aliasLineage.ts's own header for why every derived delta
// must re-state the lineage rather than only what its feature touched).
import { foldAliasLineageIntoDelta } from '../aliasLineage.ts'
// Single source of truth for the edge-adjacency joiner char (U+2227). Imported
// from the merged DOC lane so a caret/wedge split-brain across lanes is
// structurally impossible; re-exported so tests can assert the two are equal.
import { EDGE_JOIN, EDGE_DISAMB_MARK } from '../../doc/stable-id.ts'

export { EDGE_JOIN, EDGE_DISAMB_MARK }

/** Coordinate snap grid — stable-id-spec §Determinism: snap to 1e-7. */
const SNAP_EPS = 1e-7

/** Quantize a coordinate to the snap grid as an integer (robust total order). */
export function snap(x: number): number {
  // Normalize -0 to 0 so the two never sort differently.
  const q = Math.round(x / SNAP_EPS)
  return q === 0 ? 0 : q
}

/** Total-order comparator for faces: centroid (x,y,z) then area then type.
 *  Deterministic and tolerant to sub-eps float noise. */
export function compareSnapshots(a: GeometrySnapshot, b: GeometrySnapshot): number {
  const ac = a.centroid
  const bc = b.centroid
  for (let i = 0; i < 3; i++) {
    const d = snap(ac[i]) - snap(bc[i])
    if (d !== 0) return d < 0 ? -1 : 1
  }
  const da = snap(a.area) - snap(b.area)
  if (da !== 0) return da < 0 ? -1 : 1
  return a.type < b.type ? -1 : a.type > b.type ? 1 : 0
}

/**
 * GEO-6X6-R3 (auditor's major): an order-free identity key for a MINT
 * candidate — a result face `matchFacesToOriginals` refused to bind to any
 * original (ambiguous exact-key bucket, or a plane-support tie no
 * mutual-nearest round could resolve). `compareSnapshots` alone is not enough
 * here: it is `centroid|area|type` ONLY, and two genuinely distinct faces can
 * coincide on exactly those coarse fields (the snapshot has no boundary/shape
 * signature) — when that happens `compareSnapshots` returns 0, a stable sort
 * falls back to ARRIVAL order, and the caller's `new#j` numbering becomes
 * caller-order-dependent (the auditor's repro). This key strengthens the
 * comparison with the two fields `compareSnapshots`/`exactMatchKey` leave on
 * the table for a given type — every snapshot always carries a real `normal`
 * (never optional), and an axial snapshot also carries `axis` — so two faces
 * that collide on centroid+area+type can still be told apart by orientation.
 * Returns `null` if any field this key reads is non-finite: an unreadable
 * value must never participate in an ordering decision (NaN comparisons are
 * false in both directions, so an ordering built on one would be arbitrary,
 * not deterministic).
 */
export function mintDiscriminatorKey(s: GeometrySnapshot): string | null {
  const core = [s.centroid[0], s.centroid[1], s.centroid[2], s.area, s.normal[0], s.normal[1], s.normal[2]]
  if (!core.every((n) => Number.isFinite(n))) return null
  if (s.axis && !s.axis.every((n) => Number.isFinite(n))) return null
  const axisPart = s.axis ? `${snap(s.axis[0])}|${snap(s.axis[1])}|${snap(s.axis[2])}` : 'none'
  return [
    s.type,
    snap(s.centroid[0]), snap(s.centroid[1]), snap(s.centroid[2]),
    snap(s.area),
    snap(s.normal[0]), snap(s.normal[1]), snap(s.normal[2]),
    axisPart,
  ].join('|')
}

/** Outcome of ordering a batch of mint candidates: either a deterministic
 *  total order (independent of the caller's input order — the same
 *  {@link mintDiscriminatorKey} multiset always sorts to the same sequence,
 *  by lexicographic key comparison rather than pairwise comparator ties), or
 *  a named, structured refusal — never a crash, never a silent arbitrary
 *  pick. */
export type MintOrder =
  | { ok: true; ordered: FaceProbe[] }
  | { ok: false; reason: string }

/**
 * Total-order (or structured-refuse) a batch of unmatched result faces before
 * the caller mints `new#j` ids for them. See {@link mintDiscriminatorKey} for
 * why `compareSnapshots` alone is insufficient. Two distinct outcomes, both
 * enumerated to the caller:
 *  - every candidate has a valid, UNIQUE key -> deterministic order (`ok:
 *    true`), sorted by key string — depends only on the candidate set, never
 *    on `probes`' arrival order.
 *  - any candidate's key could not be read (non-finite field), OR two-or-more
 *    candidates share an identical key (a TRUE total tie — every discriminated
 *    field coincides, so no order-free rule can separate them) -> structured
 *    refusal (`ok: false`) naming the reason. The caller must not mint, pair,
 *    or otherwise silently proceed past this — it is the one case where the
 *    coarse snapshot genuinely cannot tell two faces apart.
 */
export function orderMintCandidates(probes: readonly FaceProbe[]): MintOrder {
  if (probes.length === 0) return { ok: true, ordered: [] }
  const keyed = probes.map((p) => ({ p, key: mintDiscriminatorKey(p.snapshot) }))
  const invalid = keyed.filter((k) => k.key === null)
  if (invalid.length > 0) {
    return {
      ok: false,
      reason: `${invalid.length} of ${probes.length} mint candidate(s) have a non-finite geometry field (centroid/area/normal/axis) — cannot be ordered without guessing`,
    }
  }
  const byKey = new Map<string, FaceProbe[]>()
  for (const { p, key } of keyed) {
    const bucket = byKey.get(key as string)
    if (bucket) bucket.push(p); else byKey.set(key as string, [p])
  }
  const tie = [...byKey.entries()].find(([, bucket]) => bucket.length > 1)
  if (tie) {
    const [key, bucket] = tie
    return {
      ok: false,
      reason: `${bucket.length} mint candidates share an identical discriminator key (${key}) — a true total tie, refused rather than order-bound`,
    }
  }
  const ordered = keyed.slice().sort((a, b) => ((a.key as string) < (b.key as string) ? -1 : 1)).map((k) => k.p)
  return { ok: true, ordered }
}

export interface BBox {
  min: [number, number, number]
  max: [number, number, number]
}

const AXES = ['x', 'y', 'z'] as const

/**
 * Deterministic side tag for an axis-aligned box face from its centroid vs the
 * body bbox: 'xMin' | 'xMax' | ... Returns null if the face centroid does not
 * lie on exactly one bbox extreme (non-box face -> caller falls back to index).
 */
export function boxFaceTag(centroid: [number, number, number], bbox: BBox): string | null {
  const spanX = bbox.max[0] - bbox.min[0]
  const spanY = bbox.max[1] - bbox.min[1]
  const spanZ = bbox.max[2] - bbox.min[2]
  const tol = Math.max(spanX, spanY, spanZ, 1) * 1e-6
  let found: string | null = null
  for (let i = 0; i < 3; i++) {
    const c = centroid[i]
    const onMin = Math.abs(c - bbox.min[i]) <= tol
    const onMax = Math.abs(c - bbox.max[i]) <= tol
    if (onMin && onMax) return null // degenerate span, ambiguous
    if (onMin || onMax) {
      if (found !== null) return null // lies on two extremes -> not a flat box side
      found = `${AXES[i]}${onMin ? 'Min' : 'Max'}`
    }
  }
  return found
}

/**
 * Assign stable IDs to every face of a freshly-made box.
 * Returns hash->id and id->snapshot maps for the new body record.
 */
export function assignBoxFaceIds(
  featureId: string,
  faces: FaceProbe[],
  bbox: BBox,
): { faceMap: Map<number, StableId>; snapshots: Map<StableId, GeometrySnapshot> } {
  const faceMap = new Map<number, StableId>()
  const snapshots = new Map<StableId, GeometrySnapshot>()
  // Stable fallback order for any face without a clean side tag.
  const sorted = [...faces].sort((a, b) => compareSnapshots(a.snapshot, b.snapshot))
  const fallbackIndex = new Map<number, number>()
  sorted.forEach((f, i) => fallbackIndex.set(f.hash, i))
  const usedTags = new Set<string>()
  for (const f of faces) {
    let tag = boxFaceTag(f.snapshot.centroid, bbox)
    if (tag === null || usedTags.has(tag)) tag = `f${fallbackIndex.get(f.hash)}`
    usedTags.add(tag)
    const id: StableId = `${featureId}:BOX:${tag}`
    faceMap.set(f.hash, id)
    snapshots.set(id, f.snapshot)
  }
  return { faceMap, snapshots }
}

/** Sort a wedge pair of face IDs lexicographically -> canonical edge ID.
 *  Uses the spec joiner (EDGE_JOIN, U+2227) so IDs match DOC's resolver keys.
 *  This is the BASE two-face form; GEO-16 appends a geometric disambiguator
 *  (see {@link disambiguateEdgeIds}) ONLY when two physically distinct edges of
 *  the SAME shape collapse onto this pair -- a single-edge-per-pair id stays
 *  BYTE-IDENTICAL to this output, so the common case needs no migration. */
export function edgeId(adjacentFaceIds: StableId[], seamKey: string): StableId {
  const ids = adjacentFaceIds.filter((x) => x.length > 0).sort()
  if (ids.length >= 2) return `(${ids[0]}${EDGE_JOIN}${ids[1]})`
  if (ids.length === 1) return `(${ids[0]}${EDGE_JOIN}seam#${seamKey})`
  return `(orphan${EDGE_JOIN}seam#${seamKey})`
}

// ---------------------------------------------------------------------------
// GEO-16 (ICR-3 step 2): two-face edge-id DISAMBIGUATION.
// ---------------------------------------------------------------------------
//
// docs/stable-id-spec.md keys a two-face edge on the UNORDERED adjacent-face
// pair ONLY. PROVEN collision (edge-id-collision.test.ts): two overlapping fused
// cylinders share a face pair across TWO physically distinct intersection seams,
// so 15 edges collapse to 13 ids. The fix: when >=2 edges of one shape share a
// base pair `(A^B)`, append a deterministic GEOMETRIC disambiguator so each
// physical edge mints a UNIQUE id -- while a pair that owns a single edge keeps
// the bare `(A^B)` byte-identical (zero migration for the common case).
//
// The disambiguator marker is `@`, placed AFTER the closing paren:
//   (A^B)@m<x>_<y>_<z>_l<len>
// The token is a pure function of the edge's OWN geometry (representative curve
// mid-parameter point + analytic curve length, each snapped to the 1e-7 grid),
// so it is identical across re-tessellation, kernel reorder, and full
// regeneration -- it never consults enumeration or caller order. Face operands
// are unchanged, so every existing edge consumer (edgesOfFace, measure length,
// visibility) still reads A and B; only the parser (doc/stable-id.ts) learns to
// strip the trailing `@token` and expose it.

/** The intrinsic geometry a disambiguator token is derived from. `mid` is the
 *  edge curve's mid-parameter point (a representative point independent of
 *  tessellation density); `length` its analytic curve length. Both are
 *  properties of the curve itself, so they survive re-tessellation/regeneration.
 *  A null geom (kernel could not sample the curve) disables disambiguation for
 *  that edge -- the base id stays, and the fail-closed consumer guard catches
 *  the residual collision by name. */
export interface EdgeGeom {
  mid: [number, number, number]
  length: number
}

/** Canonical, order-free disambiguator token for one edge. Snapped to the same
 *  1e-7 grid the rest of stable-id uses, so sub-grid float noise across two
 *  regenerations cannot flip a digit. Returns null for a non-finite geom (an
 *  unreadable value must never take part in an id -- NaN would poison equality
 *  in both directions). */
export function edgeDisambToken(geom: EdgeGeom): string | null {
  const core = [geom.mid[0], geom.mid[1], geom.mid[2], geom.length]
  if (!core.every((n) => Number.isFinite(n))) return null
  return `m${snap(geom.mid[0])}_${snap(geom.mid[1])}_${snap(geom.mid[2])}_l${snap(geom.length)}`
}

/** Compose the disambiguated form `(A^B)@<token>` from a base edge id + token. */
export function withEdgeDisamb(baseId: StableId, token: string): StableId {
  return `${baseId}${EDGE_DISAMB_MARK}${token}`
}

/** Grammar of a disambiguator token BODY (the part after EDGE_DISAMB_MARK): the
 *  exact shape {@link edgeDisambToken} emits — `m<int>_<int>_<int>_l<int>`, each
 *  a snapped integer (optionally negative). A trailing suffix is stripped by
 *  {@link edgeIdBase} ONLY when it matches this grammar, so a MALFORMED persisted
 *  id (e.g. `(A∧B)garbage`) is never silently reduced to a bare base and
 *  mis-migrated onto a lone current base-pair edge — it stays intact and refuses
 *  by name in {@link resolvePersistedEdgeId}. */
const EDGE_DISAMB_TOKEN_RE = /^m-?\d+_-?\d+_-?\d+_l-?\d+$/

/** Strip a trailing `@<token>` disambiguator, returning the base edge id (or the
 *  id UNCHANGED when it carries none, is not a parenthesized edge id, or carries
 *  a suffix that is NOT the EDGE_DISAMB_MARK token grammar). Used by migration to
 *  match an old bare id against current disambiguated candidates. A malformed
 *  suffix is deliberately left intact so it cannot masquerade as a base pair — a
 *  bare `(A∧B)garbage` returning `(A∧B)` would let migration bind it to a lone
 *  current edge (a guessed rebind); left intact it resolves to `lost`. */
export function edgeIdBase(id: StableId): StableId {
  if (!id.startsWith('(')) return id
  const close = id.lastIndexOf(')')
  if (close === -1) return id
  const baseId = id.slice(0, close + 1)
  const tail = id.slice(close + 1)
  if (tail === '') return baseId // already a bare base pair
  if (tail.startsWith(EDGE_DISAMB_MARK) && EDGE_DISAMB_TOKEN_RE.test(tail.slice(EDGE_DISAMB_MARK.length))) {
    return baseId // a well-formed @<token> -> strip to the base pair
  }
  return id // unknown/malformed suffix -> leave intact (refuses, never mis-migrates)
}

/**
 * Given the BASE two-face ids for every edge of one shape (aligned with `geoms`,
 * one entry per edge; a null geom = no representative geometry), return the
 * FINAL per-edge ids. A base id that appears exactly once is returned unchanged
 * (byte-identical). A base id shared by >=2 edges (a collision group) has each
 * member's geometric disambiguator appended so every physical edge is unique.
 *
 * Determinism: the appended token is a pure function of each edge's own geometry
 * and does not depend on the order edges are supplied -- feeding the same shape's
 * edges in any order yields the same id per edge.
 *
 * ATOMICITY (auditor finding 1, GEO-16-R1): a collision group is disambiguated
 * ALL-OR-NOTHING. Tokens are appended only when EVERY member has a non-null,
 * WITHIN-GROUP-UNIQUE token; if a single member has no usable token (null geom)
 * or two members' tokens tie (geometrically indistinguishable edges, which a
 * valid solid does not contain), the WHOLE group is left at the bare base form.
 * A PARTIAL tag would be the silent-wrong-binding bug: tagging the readable
 * member while leaving the unreadable one bare makes the base id appear EXACTLY
 * ONCE, so resolvePersistedEdgeId would bind an old persisted bare id 'exact' to
 * the surviving bare twin -- a guessed rebind of information the old format never
 * carried. Left whole, the base keeps multiplicity >=2 and the residual collision
 * is refused BY NAME at the consumer (the step-1 fail-closed guard).
 */
export function disambiguateEdgeIds(
  baseIds: readonly StableId[],
  geoms: ReadonlyArray<EdgeGeom | null>,
): StableId[] {
  const groups = new Map<StableId, number[]>()
  baseIds.forEach((b, i) => {
    const g = groups.get(b)
    if (g) g.push(i); else groups.set(b, [i])
  })
  const out = baseIds.slice()
  for (const [, members] of groups) {
    if (members.length < 2) continue // unique pair -> byte-identical base id
    // Compute every member's token, then apply the ATOMIC rule: the group is
    // disambiguated only if all tokens are present AND pairwise distinct.
    const tokens = members.map((i) => (geoms[i] ? edgeDisambToken(geoms[i]!) : null))
    const allPresent = tokens.every((t) => t !== null)
    const allUnique = new Set(tokens).size === tokens.length
    if (!allPresent || !allUnique) continue // leave the WHOLE group bare (refused by name)
    members.forEach((i, k) => { out[i] = withEdgeDisamb(baseIds[i], tokens[k]!) })
  }
  return out
}

/**
 * The REQUESTED (caller-picked) ids that still collide -- candidate multiplicity
 * >= 2 -- de-duplicated and ordered by first appearance in `requested`. Extracted
 * PURE from the worker's #collidingPickedEdgeIds so the fail-closed backstop can
 * be unit-tested with synthetic duplicate lists even after the grammar makes
 * kernel-produced collisions unreachable (GEO-16 keeps the guard + its coverage
 * as a regression fence for any future grammar drift).
 */
export function collidingPickedEdgeIds(
  requested: readonly StableId[],
  candidateIds: readonly StableId[],
): Array<{ id: StableId; count: number }> {
  const counts = new Map<StableId, number>()
  for (const id of candidateIds) counts.set(id, (counts.get(id) ?? 0) + 1)
  const seen = new Set<StableId>()
  const out: Array<{ id: StableId; count: number }> = []
  for (const id of requested) {
    if (seen.has(id)) continue
    seen.add(id)
    const n = counts.get(id) ?? 0
    if (n >= 2) out.push({ id, count: n })
  }
  return out
}

/**
 * GEO-16 migration/compatibility: resolve a PERSISTED edge id (saved under an
 * older grammar, or the current one) against the CURRENT shape's edge id list.
 * Never silently rebinds -- an id the grammar cannot map to exactly one current
 * edge is refused BY NAME (`ambiguous`/`lost`), the one unforgivable failure
 * mode (docs/stable-id-spec.md).
 *  - `exact`    : the id is present once in the current list -> bind directly
 *                 (the common case: a unique pair id is byte-identical old->new).
 *  - `migrated` : the id is gone but its base pair now owns a SINGLE current edge
 *                 (e.g. a persisted disambiguated id whose colliding twin was
 *                 removed upstream) -> the lone survivor of the pair, bound by
 *                 lineage (spec Resolution step 2, "exactly one survivor").
 *  - `ambiguous`: the base pair owns >=2 current edges but the persisted id is
 *                 not one of them (an OLD BARE id that never carried the
 *                 disambiguator, or a disambiguated id whose geometry drifted past
 *                 the snap grid) -> REFUSE; the old format lost the discriminating
 *                 info and rebinding would be a guess.
 *  - `lost`     : the base pair owns no current edge at all -> REFUSE.
 */
export type EdgeResolution =
  | { status: 'exact'; id: StableId }
  | { status: 'migrated'; id: StableId }
  | { status: 'ambiguous'; base: StableId; count: number }
  | { status: 'lost'; base: StableId }

export function resolvePersistedEdgeId(
  persistedId: StableId,
  currentIds: readonly StableId[],
): EdgeResolution {
  const counts = new Map<StableId, number>()
  for (const id of currentIds) counts.set(id, (counts.get(id) ?? 0) + 1)
  const exact = counts.get(persistedId) ?? 0
  if (exact === 1) return { status: 'exact', id: persistedId }
  const base = edgeIdBase(persistedId)
  if (exact >= 2) return { status: 'ambiguous', base, count: exact }
  const matches = [...new Set(currentIds)].filter((id) => edgeIdBase(id) === base)
  if (matches.length === 0) return { status: 'lost', base }
  if (matches.length === 1) return { status: 'migrated', id: matches[0] }
  return { status: 'ambiguous', base, count: matches.length }
}

export interface CutAssignment {
  faceMap: Map<number, StableId>
  snapshots: Map<StableId, GeometrySnapshot>
  modified: Record<StableId, StableId[]>
  generated: StableId[]
  deleted: StableId[]
}

/**
 * The heart of boolean lineage. Given the target's named faces, the kernel's
 * decoded evolution records, and the result faces, deterministically name every
 * result face and emit the modified/generated/deleted delta per spec:
 *  - unchanged face (kernel hash preserved) -> keeps its ID
 *  - retrimmed 1:1 -> keeps its ID (survivor == input ID)
 *  - split into N -> `<fid>:CUT:<inputId>#j` (j by centroid order)
 *  - brand-new face (tool wall) -> `<fid>:CUT:new#k` (k by centroid order)
 *  - vanished input -> deleted
 */
export function assignCutFaceIds(
  featureId: string,
  inputFaceMap: Map<number, StableId>,
  modifiedRecords: EvolutionRecord[],
  resultFaces: FaceProbe[],
  /**
   * UI-57-R2 blocker: the TARGET body's inherited alias lineage
   * (`rec.aliases`/`target.aliases`), folded into this delta's own `modified`
   * so the delta stands alone across a serialize/restore. REQUIRED, and
   * deliberately positioned BEFORE the defaulted `opCode`: a new caller that
   * forgets it is a compile error, not a silent lineage drop discovered by an
   * auditor two rounds later. Pass `undefined` only when there is genuinely no
   * target body (a fresh mint from a sketch profile has no inherited aliases).
   */
  inheritedAliases: ReadonlyMap<StableId, StableId> | undefined,
  /** spec opCode for the split/new-face id segments — 'CUT' (default, boolean
   *  cut), 'FUS' (fuse/add), 'INT' (intersect), or 'FIL'/'CHM' (GEO-4
   *  fillet/chamfer, whose default `new#k` band-face names are renamed
   *  post-hoc by #relabelDressUpBandFaces to the spec's edge-derived form —
   *  see geom-engine.ts). Only affects the names of fragments the op itself
   *  creates; target survivors keep their ids. */
  opCode: 'CUT' | 'FUS' | 'INT' | 'FIL' | 'CHM' = 'CUT',
): CutAssignment {
  const faceMap = new Map<number, StableId>()
  const snapshots = new Map<StableId, GeometrySnapshot>()
  const modified: Record<StableId, StableId[]> = {}
  const generated: StableId[] = []

  const inputHashes = new Set(inputFaceMap.keys())
  const resultByHash = new Map<number, FaceProbe>()
  for (const rf of resultFaces) resultByHash.set(rf.hash, rf)

  // outHash -> the input hash it descended from (only surviving outs).
  const outToIn = new Map<number, number>()
  for (const rec of modifiedRecords) {
    for (const out of rec.outHashes) {
      if (resultByHash.has(out) && !inputHashes.has(out)) outToIn.set(out, rec.inHash)
    }
  }

  const record = (hash: number, id: StableId, snap0: GeometrySnapshot) => {
    faceMap.set(hash, id)
    snapshots.set(id, snap0)
  }

  const survivingInputIds = new Set<StableId>()

  // 1) Unchanged faces keep their ID.
  for (const rf of resultFaces) {
    if (inputHashes.has(rf.hash)) {
      const id = inputFaceMap.get(rf.hash)!
      record(rf.hash, id, rf.snapshot)
      survivingInputIds.add(id)
    }
  }

  // 2) Modified (retrimmed/split) faces, grouped by input face.
  for (const rec of modifiedRecords) {
    const inId = inputFaceMap.get(rec.inHash)
    if (inId === undefined) continue // input face wasn't a named target face
    const outs = rec.outHashes
      .filter((h) => outToIn.get(h) === rec.inHash)
      .map((h) => resultByHash.get(h)!)
    if (outs.length === 0) continue // no survivor -> handled as deleted below
    survivingInputIds.add(inId)
    if (outs.length === 1) {
      record(outs[0].hash, inId, outs[0].snapshot)
      modified[inId] = [inId]
    } else {
      const sorted = [...outs].sort((a, b) => compareSnapshots(a.snapshot, b.snapshot))
      const childIds = sorted.map((o, j) => {
        const id: StableId = `${featureId}:${opCode}:${inId}#${j}`
        record(o.hash, id, o.snapshot)
        return id
      })
      modified[inId] = childIds
    }
  }

  // 3) Brand-new faces (from the tool) — geometry-derived, since occt-wasm's
  //    `generated` hashes are unreliable (verified 2026-07-07).
  const newFaces = resultFaces.filter(
    (rf) => !inputHashes.has(rf.hash) && !outToIn.has(rf.hash),
  )
  newFaces
    .sort((a, b) => compareSnapshots(a.snapshot, b.snapshot))
    .forEach((rf, k) => {
      const id: StableId = `${featureId}:${opCode}:new#${k}`
      record(rf.hash, id, rf.snapshot)
      generated.push(id)
    })

  // 4) Deleted: any named input face with no survivor.
  const deleted: StableId[] = []
  for (const id of inputFaceMap.values()) {
    if (!survivingInputIds.has(id)) deleted.push(id)
  }
  deleted.sort()

  // 5) UI-57-R2 blocker: re-state the target's inherited lineage. A face merged
  //    away by an EARLIER heal is an input to this boolean too (it existed
  //    before it) whose sole surviving output is the live root it resolves to —
  //    so this delta says so, and restoreBody can rebuild the map from it alone.
  const generatedIds = new Set(generated)
  foldAliasLineageIntoDelta({
    aliases: inheritedAliases,
    isLive: (id) => snapshots.has(id),
    modified,
    isGenerated: (id) => generatedIds.has(id),
  })

  return { faceMap, snapshots, modified, generated, deleted }
}

export interface ShellAssignment extends CutAssignment {
  /**
   * GEO-4-R1.4: result faces that could NOT be traced to a generating face via
   * any of shell's evolution channels (unchanged hash / removed-face retrim /
   * spawned inner companion). stable-id-spec §3 names silent wrong-binding the
   * one unforgivable failure mode, and a non-derived positional id (the old
   * `F:SHL:new#k` catch-all) IS a silent wrong binding once persisted. So these
   * faces are NOT minted — assignShellFaceIds surfaces them here and applyShell
   * fails loud (SHELL_FAILED) naming the unmappable topology. Empty on every
   * well-formed shell (shell's spawn channel is reliable, verified empirically —
   * see geom-engine.ts applyShell recon notes).
   */
  unmapped: FaceProbe[]
}

/**
 * GEO-4 shell dress-up lineage. occt-wasm's shellWithHistory returns TWO
 * DISTINCT evolution channels (same [inHash,count,...outHashes] flat format,
 * decoded by decodeEvolution — see geom-engine.ts):
 *  - `removedRecords` (decoded `modified`): the REMOVED faces' own identity
 *    evolution. Verified empirically (spike, box minus top face): the
 *    "removed" face does NOT vanish outright — it survives as a single
 *    retrimmed face with a HOLE punched where the opening is (a "rim"), so
 *    the common case is a 1:1 retrim that KEEPS the removed face's own id
 *    (same "retrimmed 1:1 -> keeps id" rule as assignCutFaceIds). A record
 *    with zero surviving outputs (no rim built) falls through to `deleted`;
 *    a record with >1 outputs (unexpected multi-fragment opening) splits via
 *    the same `<fid>:SHL:<inId>#j` convention as a boolean split.
 *  - `spawnedRecords` (decoded `generated`): a DIFFERENT relationship — each
 *    REMAINING (non-removed) face spawns a brand-new INNER offset companion.
 *    Verified reliable for shell (unlike cut/fuse, whose `generated` array is
 *    documented elsewhere as unreliable) — every entry's inHash is one of the
 *    ORIGINAL named faces. Each companion is tagged
 *    `<fid>:SHL:<inId>:inner` per stable-id-spec (`#j` only if a single face
 *    spawns more than one companion — the common case stays clean).
 * Faces present in resultFaces with an UNCHANGED hash keep their id (the same
 * "unchanged" bucket as assignCutFaceIds).
 */
export function assignShellFaceIds(
  featureId: string,
  inputFaceMap: Map<number, StableId>,
  removedRecords: EvolutionRecord[],
  spawnedRecords: EvolutionRecord[],
  resultFaces: FaceProbe[],
  /** UI-57-R2 blocker: the target body's inherited alias lineage — see
   *  assignCutFaceIds's own parameter doc. Required for the same reason. */
  inheritedAliases: ReadonlyMap<StableId, StableId> | undefined,
): ShellAssignment {
  const faceMap = new Map<number, StableId>()
  const snapshots = new Map<StableId, GeometrySnapshot>()
  const modified: Record<StableId, StableId[]> = {}
  const generated: StableId[] = []

  const inputHashes = new Set(inputFaceMap.keys())
  const resultByHash = new Map<number, FaceProbe>()
  for (const rf of resultFaces) resultByHash.set(rf.hash, rf)

  const record = (hash: number, id: StableId, snap0: GeometrySnapshot) => {
    faceMap.set(hash, id)
    snapshots.set(id, snap0)
  }

  const survivingInputIds = new Set<StableId>()

  // 1) Unchanged faces (present in the result with their original hash).
  for (const rf of resultFaces) {
    if (inputHashes.has(rf.hash)) {
      const id = inputFaceMap.get(rf.hash)!
      record(rf.hash, id, rf.snapshot)
      survivingInputIds.add(id)
    }
  }

  // 2) Removed-face evolution: retrim-to-rim (keeps id), split (#j), or
  //    vanished (no record output -> handled by the deleted pass below).
  for (const rec of removedRecords) {
    const inId = inputFaceMap.get(rec.inHash)
    if (inId === undefined) continue
    const outs = rec.outHashes
      .map((h) => resultByHash.get(h))
      .filter((p): p is FaceProbe => p !== undefined)
    if (outs.length === 0) continue
    survivingInputIds.add(inId)
    if (outs.length === 1) {
      record(outs[0].hash, inId, outs[0].snapshot)
      modified[inId] = [inId]
    } else {
      const sorted = [...outs].sort((a, b) => compareSnapshots(a.snapshot, b.snapshot))
      const childIds = sorted.map((o, j) => {
        const id: StableId = `${featureId}:SHL:${inId}#${j}`
        record(o.hash, id, o.snapshot)
        return id
      })
      modified[inId] = childIds
    }
  }

  // 3) Spawned inner companions: each remaining face's own new offset face(s).
  const spawnedByIn = new Map<string, FaceProbe[]>()
  for (const rec of spawnedRecords) {
    const inId = inputFaceMap.get(rec.inHash)
    if (inId === undefined) continue
    const outs = rec.outHashes
      .map((h) => resultByHash.get(h))
      .filter((p): p is FaceProbe => p !== undefined)
    if (outs.length === 0) continue
    spawnedByIn.set(inId, [...(spawnedByIn.get(inId) ?? []), ...outs])
  }
  for (const [inId, outs] of spawnedByIn) {
    const sorted = [...outs].sort((a, b) => compareSnapshots(a.snapshot, b.snapshot))
    sorted.forEach((o, j) => {
      const id: StableId = sorted.length === 1 ? `${featureId}:SHL:${inId}:inner` : `${featureId}:SHL:${inId}:inner#${j}`
      record(o.hash, id, o.snapshot)
      generated.push(id)
    })
  }

  // 4) Deleted: any named input face with no survivor.
  const deleted: StableId[] = []
  for (const id of inputFaceMap.values()) {
    if (!survivingInputIds.has(id)) deleted.push(id)
  }
  deleted.sort()

  // 5) GEO-4-R1.4: every result face MUST derive from a generating face via one
  //    of the channels above (unchanged hash / removed-face retrim / spawned
  //    inner companion). The old catch-all minted off-grammar positional ids
  //    (`F:SHL:new#k`) for anything left over — but stable-id-spec's shell
  //    grammar has no such id, and a non-derived id IS a silent wrong binding
  //    once persisted (the one unforgivable failure mode, §3). So instead of
  //    minting, surface any still-unnamed result face as `unmapped`; applyShell
  //    fails loud (SHELL_FAILED) naming the topology rather than persisting a
  //    lineage the design tree cannot re-derive. Empty on well-formed shells.
  const unmapped = resultFaces
    .filter((rf) => !faceMap.has(rf.hash))
    .sort((a, b) => compareSnapshots(a.snapshot, b.snapshot))

  generated.sort()

  // 6) UI-57-R2 blocker: re-state the target's inherited lineage (see
  //    assignCutFaceIds step 5 — same rule, same shared owner). Folded AFTER
  //    the unmapped sweep above, which reads `faceMap`, not `modified`.
  const generatedIds = new Set(generated)
  foldAliasLineageIntoDelta({
    aliases: inheritedAliases,
    isLive: (id) => snapshots.has(id),
    modified,
    isGenerated: (id) => generatedIds.has(id),
  })

  return { faceMap, snapshots, modified, generated, deleted, unmapped }
}

/**
 * Shell blend faces. MakeThickSolid rounds the wall where it turns round a
 * re-entrant edge or corner of the part (a boss on a plate, a shaft on a knob):
 * a cylinder or torus face the kernel reports in no evolution channel, because
 * it grows from an edge, not from a face. Each one is named by the faces whose
 * inner companions it joins - its neighbours in the result - sorted, the way a
 * pattern's merged face is: `<fid>:SHL:blend:(A|B)` (`#j` when two blends join
 * the same faces). A blend touching only other blends (at a corner) takes the
 * union of theirs. Re-derivable from the lineage alone, so no positional id is
 * minted; a face with no named neighbour stays in `unmapped` and the shell
 * still fails loud. Mutates `assign`.
 */
export function nameShellBlendFaces(
  featureId: string,
  assign: ShellAssignment,
  neighbourHashes: (hash: number) => number[],
): void {
  const innerRe = new RegExp(`^${featureId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:SHL:(.+):inner(?:#\\d+)?$`)
  const sourcesOf = new Map<number, string[]>()
  const around = new Map<number, number[]>()
  for (const p of assign.unmapped) around.set(p.hash, neighbourHashes(p.hash))
  let pending = [...assign.unmapped]
  for (let pass = 0; pass < 2 && pending.length > 0; pass++) {
    const still: FaceProbe[] = []
    for (const p of pending) {
      const src = new Set<string>()
      for (const h of around.get(p.hash) ?? []) {
        const id = assign.faceMap.get(h)
        const m = id !== undefined ? innerRe.exec(id) : null
        if (m) src.add(m[1])
      }
      if (src.size === 0 && pass > 0) for (const h of around.get(p.hash) ?? []) for (const s of sourcesOf.get(h) ?? []) src.add(s)
      if (src.size === 0) still.push(p)
      else sourcesOf.set(p.hash, [...src].sort())
    }
    pending = still
  }
  const byName = new Map<string, FaceProbe[]>()
  for (const p of assign.unmapped) {
    const src = sourcesOf.get(p.hash)
    if (src === undefined) continue
    const name = `${featureId}:SHL:blend:(${src.join('|')})`
    byName.set(name, [...(byName.get(name) ?? []), p])
  }
  for (const [name, probes] of byName) {
    const sorted = [...probes].sort((a, b) => compareSnapshots(a.snapshot, b.snapshot))
    sorted.forEach((p, j) => {
      const id: StableId = sorted.length === 1 ? name : `${name}#${j}`
      assign.faceMap.set(p.hash, id)
      assign.snapshots.set(id, p.snapshot)
      assign.generated.push(id)
    })
  }
  assign.generated.sort()
  assign.unmapped = pending
}

export interface RebindProbe {
  hash: number
  snapshot: GeometrySnapshot
}

export interface RebindResult {
  faceMap: Map<number, StableId>
  snapshots: Map<StableId, GeometrySnapshot>
  unresolved: StableId[]
}

export interface DraftRebindParams {
  /** the id of the ONE face handed to the kernel this iteration (the edited
   *  face). We KNOW which face we drafted, so it is tracked explicitly by its
   *  defining edit signature rather than a static centroid tolerance. */
  editedId: StableId
  /** the draft angle in radians applied this iteration. */
  angleRad: number
  /**
   * absolute centroid-motion budget for THIS iteration, = tan(angleRad) x
   * maxDistanceToNeutralPlane over the (post-draft) shape. A point at distance h
   * from the neutral plane moves at most h*tan(angle) laterally under a draft, so
   * every face's bbox-centroid moves by at most this much — the caller computes
   * it motion-aware (NOT a fixed 1% of bbox diag; that was the R1.2 bug that
   * failed valid >5deg drafts).
   */
  motionBudget: number
}

/**
 * GEO-4-R1.2 draft rebind. occt-wasm 3.6.1 exposes NO `draftWithHistory` (only
 * fillet/chamfer/shell/boolean/translate/rotate/mirror/scale carry evolution),
 * and `draft()` — verified empirically — rehashes faces it did not even touch,
 * so hash equality is useless as an identity signal across a draft. But draft
 * is a bijection on faces (it tilts one face and re-trims its neighbours; count
 * is preserved), and we KNOW which face we handed the kernel each iteration, so
 * we track identity by the EDIT SIGNATURE rather than a static tolerance:
 *   - the edited face (`editedId`) is the UNIQUE candidate whose surface normal
 *     rotated by exactly `angleRad` from its prior normal (dot ≈ cos angleRad —
 *     verified: a drafted box face's normal tilts by precisely the draft angle
 *     while every other face keeps its normal unchanged, even across successive
 *     per-face iterations);
 *   - every OTHER (untouched) face keeps a geometric rebind, but gated by its
 *     normal staying parallel (dot ≈ 1) AND its centroid moving within the
 *     motion-aware `motionBudget` — NOT the old fixed 1%-of-bbox-diag tolerance,
 *     which rejected valid 10deg+ drafts, and NOT an area-ratio gate, which a
 *     draft legitimately blows past (an untouched top face can grow >25% as
 *     adjacent walls tilt).
 * ids are matched in `ids` order (caller sorts for determinism); a candidate is
 * used by at most one id. ids with no matching candidate are reported in
 * `unresolved`, never guessed — silent wrong-binding is the one unforgivable
 * failure mode (stable-id-spec §3), so applyDraft turns any unresolved id into a
 * structured DRAFT_FAILED.
 */
export function rebindDraftFaces(
  ids: StableId[],
  priorSnapshots: Map<StableId, GeometrySnapshot>,
  candidates: RebindProbe[],
  params: DraftRebindParams,
): RebindResult {
  const faceMap = new Map<number, StableId>()
  const snapshots = new Map<StableId, GeometrySnapshot>()
  const remaining = new Set(candidates)
  const unresolved: StableId[] = []
  const cosAngle = Math.cos(params.angleRad)
  // Half the gap between "unchanged" (dot=1) and "edited" (dot=cosAngle) so the
  // two normal bands never overlap; floored/capped for numeric robustness.
  const normalTol = Math.min(0.01, Math.max(1e-6, (1 - cosAngle) * 0.5))
  const budget = params.motionBudget + 1e-9
  for (const id of ids) {
    const prior = priorSnapshots.get(id)
    if (!prior) { unresolved.push(id); continue }
    const wantEdited = id === params.editedId
    const priorN = normalize3(prior.normal)
    let best: RebindProbe | undefined
    let bestDist = Infinity
    for (const c of remaining) {
      if (c.snapshot.type !== prior.type) continue
      const d = Math.hypot(
        c.snapshot.centroid[0] - prior.centroid[0],
        c.snapshot.centroid[1] - prior.centroid[1],
        c.snapshot.centroid[2] - prior.centroid[2],
      )
      if (d > budget) continue
      // Normal-consistency gate. Skip only if a normal is degenerate (probe
      // best-effort); otherwise the edited face must show the angleRad rotation
      // and every other face must keep its normal.
      const candN = normalize3(c.snapshot.normal)
      if (priorN && candN) {
        const dot = priorN[0] * candN[0] + priorN[1] * candN[1] + priorN[2] * candN[2]
        if (wantEdited) {
          if (Math.abs(dot - cosAngle) > normalTol) continue
        } else {
          if (dot < 1 - normalTol) continue
        }
      }
      if (d < bestDist) { bestDist = d; best = c }
    }
    if (best) {
      faceMap.set(best.hash, id)
      snapshots.set(id, best.snapshot)
      remaining.delete(best)
    } else {
      unresolved.push(id)
    }
  }
  return { faceMap, snapshots, unresolved }
}

/** Unit-normalize a 3-vector; returns null if it is (near) zero-length (a
 *  best-effort probe normal that could not be sampled). */
function normalize3(v: [number, number, number]): [number, number, number] | null {
  const len = Math.hypot(v[0], v[1], v[2])
  if (len < 1e-9) return null
  return [v[0] / len, v[1] / len, v[2] / len]
}
