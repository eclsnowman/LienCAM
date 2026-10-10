// Stable element-ID minting + edge/vertex derivation (DOC lane, WO DOC-1).
//
// Implements docs/stable-id-spec.md Grammar + Per-op origin rules. Every face of
// every body carries a DERIVED (never random) string id so regenerating the same
// document reproduces byte-identical ids. Edges/vertices are NOT stored -- they
// are derived on demand from the sorted set of their adjacent face ids, so they
// survive automatically whenever their faces survive.
//
// This module is pure TypeScript with ZERO kernel dependency: it only consumes
// the frozen plain-data types from geom-service.ts.

import type { StableId, Vec3 } from '../geom/geom-service'

// The logical-AND join char (U+2227) the spec uses to write an edge as the
// unordered pair of its adjacent face ids: (faceA<AND>faceB). Declared as an
// escape so this source file stays plain-ASCII while the EMITTED id is
// spec-faithful (the spec grammar is binding).
export const EDGE_JOIN = '∧'

/**
 * GEO-16 (ICR-3 step 2): marker that introduces a two-face edge's geometric
 * disambiguator, placed AFTER the closing paren -- `(A<AND>B)@<token>`. Declared
 * here (the joiner lane's source of truth, imported by the worker's stable-id.ts
 * exactly as EDGE_JOIN is) so the mint lane and the parse lane can never disagree
 * on the marker char. See the worker's disambiguateEdgeIds for the token grammar.
 */
export const EDGE_DISAMB_MARK = '@'

/** opCode segment of the grammar (docs/stable-id-spec.md Grammar). */
export type OpCode =
  | 'XTR' | 'REV' | 'SWP' | 'LFT' | 'FIL' | 'CHM' | 'SHL' | 'BOX'
  | 'CUT' | 'FUS' | 'INT' | 'PAT' | 'MIR' | 'DFT' | 'HOL' | 'MVF'
  | 'OFS' | 'DELF' | 'step' | 'stl'

/** The six canonical faces of an axis-aligned box, named by the face normal. */
export type BoxFace = 'xmin' | 'xmax' | 'ymin' | 'ymax' | 'zmin' | 'zmax'

/** Boolean op codes that produce split fragments of a surviving face. */
export type BooleanOp = 'CUT' | 'FUS' | 'INT'

// ---------------------------------------------------------------------------
// Primitive / feature face ids (the only subshapes that need explicit ids).
// ---------------------------------------------------------------------------

/**
 * BOX primitive face. Grammar: featureRef:opCode:originTag.
 * e.g. boxFaceId('F1','zmax') -> "F1:BOX:zmax" (the box top face).
 */
export function boxFaceId(featureId: string, face: BoxFace): StableId {
  return `${featureId}:BOX:${face}`
}

/** Extrude side face generated from a sketch entity. "F12:XTR:S3.e7:side". */
export function extrudeSideFaceId(featureId: string, sketchEntityId: string): StableId {
  return `${featureId}:XTR:${sketchEntityId}:side`
}

/** Extrude start (0) / end (1) cap face. "F12:XTR:cap1". */
export function extrudeCapId(featureId: string, which: 0 | 1): StableId {
  return `${featureId}:XTR:cap${which}`
}

/** Revolve surface generated from a sketch entity. "F14:REV:S3.e2:surf". */
export function revolveFaceId(featureId: string, sketchEntityId: string): StableId {
  return `${featureId}:REV:${sketchEntityId}:surf`
}

/** Fillet band face replacing an edge. "F20:FIL:(<edgeStableId>)". */
export function filletFaceId(featureId: string, edgeStableId: StableId): StableId {
  return `${featureId}:FIL:${edgeStableId}`
}

/** Chamfer band face replacing an edge. "F21:CHM:(<edgeStableId>)". */
export function chamferFaceId(featureId: string, edgeStableId: StableId): StableId {
  return `${featureId}:CHM:${edgeStableId}`
}

/** Shell offset inner face of a face. "F22:SHL:<faceId>:inner". */
export function shellInnerFaceId(featureId: string, faceId: StableId): StableId {
  return `${featureId}:SHL:${faceId}:inner`
}

/**
 * Boolean split fragment j of a surviving face. "F16:CUT:(F12:XTR:cap1)#0".
 * `j` MUST come from the full geometric comparator chain (centroid -> area ->
 * orientation -> shapeKey -> full-precision serialization, see
 * mintBooleanFragments / docs/stable-id-spec.md "Boolean fragment comparator
 * chain"), never from kernel enumeration or caller/input order.
 */
export function booleanFragmentId(featureId: string, op: BooleanOp, faceId: StableId, j: number): StableId {
  return `${featureId}:${op}:${faceId}#${j}`
}

/** Pattern instance i of a child subshape. "F9:PAT:i3:F5:FIL:g0". */
export function patternInstanceId(featureId: string, instance: number, childId: StableId): StableId {
  return `${featureId}:PAT:i${instance}:${childId}`
}

/**
 * Imported STEP/STL face. "IMP1:step:face#42" (i = import-order index, frozen at
 * import time and stored in the map -- NEVER recomputed).
 */
export function importFaceId(importId: string, fmt: 'step' | 'stl', importIndex: number): StableId {
  return `${importId}:${fmt}:face#${importIndex}`
}

/** Direct-edit heal face j produced by a Delete-face op. "F30:DELF:heal#0". */
export function healFaceId(featureId: string, j: number): StableId {
  return `${featureId}:DELF:heal#${j}`
}

// ---------------------------------------------------------------------------
// Derived edge / vertex ids (NOT stored -- computed from adjacent face ids).
// ---------------------------------------------------------------------------

/**
 * Edge id = the unordered pair of its two adjacent face ids, sorted
 * lexicographically and joined with the spec's AND char inside parens.
 * edgeId('B','A') === edgeId('A','B') === "(A<AND>B)".
 */
export function edgeId(faceA: StableId, faceB: StableId): StableId {
  const pair = [faceA, faceB].sort(compareIds)
  return `(${pair[0]}${EDGE_JOIN}${pair[1]})`
}

/** Seam / degenerate edge (single adjacent face). "(A<AND>seam#0)". */
export function seamEdgeId(faceId: StableId, seamIndex: number): StableId {
  return `(${faceId}${EDGE_JOIN}seam#${seamIndex})`
}

/**
 * Vertex id = the sorted SET of its adjacent face ids joined with the AND char.
 * Order-independent and duplicate-free so it survives whatever its faces survive.
 */
export function vertexId(faceIds: StableId[]): StableId {
  const uniqueSorted = [...new Set(faceIds)].sort(compareIds)
  return `(${uniqueSorted.join(EDGE_JOIN)})`
}

// Deterministic string comparison (code-unit order). Explicit so the sort is
// not locale-dependent (Array.prototype.sort default is code-unit order already,
// but stating it removes any doubt for the byte-identical golden tests).
// Exported as the single source of truth for id ordering (element-map.ts imports
// it rather than re-declaring an identical copy).
export function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

// ---------------------------------------------------------------------------
// Deterministic boolean-fragment ordering (docs/stable-id-spec.md Determinism).
// ---------------------------------------------------------------------------

// Fragment centroids are snapped to a 1e-7 integer grid before comparison so a
// sub-tolerance wobble cannot flip the ordering (kernel enumeration order is NOT
// trusted; the centroid order IS the source of truth for the #j suffix).
const CENTROID_SNAP = 1e-7

function snapToGrid(v: number): number {
  const q = Math.round(v / CENTROID_SNAP)
  return q === 0 ? 0 : q // collapse -0 to 0 so the key is canonical
}

/** Lexicographic (x,y,z) compare of two centroids on the snap grid. */
export function compareCentroids(a: Vec3, b: Vec3): number {
  const ax = snapToGrid(a.x), bx = snapToGrid(b.x)
  if (ax !== bx) return ax < bx ? -1 : 1
  const ay = snapToGrid(a.y), by = snapToGrid(b.y)
  if (ay !== by) return ay < by ? -1 : 1
  const az = snapToGrid(a.z), bz = snapToGrid(b.z)
  if (az !== bz) return az < bz ? -1 : 1
  return 0
}

/** Snapped scalar compare on the same 1e-7 grid as the centroids. */
function compareScalar(a: number, b: number): number {
  const as = snapToGrid(a), bs = snapToGrid(b)
  return as === bs ? 0 : as < bs ? -1 : 1
}

/**
 * Seed for one boolean split-fragment of a surviving parent face. EVERY field
 * is REQUIRED: a partial seed (centroid only, say) would force the tie-break to
 * fall back on caller/input order, which the determinism invariant forbids
 * absolutely (see DOC-1-R2 / the R1 cross-vendor audit). All four fields are
 * pure functions of the fragment's OWN geometry, so feeding the same fragment
 * set in any order yields a byte-identical #j assignment.
 */
export interface FragmentSeed {
  /** centroid of the fragment face -- the primary deterministic ordering key. */
  centroid: Vec3
  /** surface area of the fragment -- second ordering key. */
  area: number
  /**
   * Orientation vector: the face NORMAL for planar fragments, the AXIS for
   * cylinder/cone/torus fragments (the caller supplies whichever is meaningful
   * for the surface type). Third ordering key -- separates coincident-centroid,
   * equal-area MIRRORED fragments.
   */
  orientation: Vec3
  /**
   * Canonical, kernel-derived shape signature that distinguishes two
   * geometrically DISTINCT fragments whose centroid + area + orientation all
   * collide -- e.g. two equal-area concentric coplanar annular fragments, which
   * are identical on every scalar key yet are different faces. The audit
   * required exactly one such discriminator; of the offered candidates (snapped
   * perimeter, bounding-sphere radius, face-signature string) we require a
   * face-signature STRING because it is the only one that can encode loop
   * topology / edge count, so it never aliases two genuinely different faces the
   * way a single scalar (perimeter, radius) can. It MUST be derived from the
   * fragment's own geometry, NEVER from caller/input order.
   */
  shapeKey: string
}

export interface MintedFragment<T extends FragmentSeed> {
  id: StableId
  /** 0-based #j suffix assigned by the full geometric key order. */
  index: number
  seed: T
}

/** DOC-owned diagnostic code for the truly-identical-fragment tie. */
export type FragmentDiagCode = 'FRAGMENT_TIE_UNRESOLVED'

/**
 * Structured (never string-parsed) diagnostic. DOC-local rather than the frozen
 * geom-service DiagCode union because this tie is specific to fragment minting;
 * geom-service.ts is frozen and cannot grow a new code. Severity is 'error':
 * a full-key tie is a REFUSAL (mintBooleanFragments throws this diag and mints
 * nothing), never a warn-and-assign, so it can never carry a lower severity.
 */
export interface FragmentDiag {
  code: FragmentDiagCode
  severity: 'error'
  params: Record<string, string | number>
}

/**
 * Structured REFUSAL thrown when two fragment seeds are geometrically
 * indistinguishable through the ENTIRE key chain (a true full-key tie). Carries
 * the FRAGMENT_TIE_UNRESOLVED diagnostic so a caller catching it can surface the
 * structured params (never string-parse the message). See mintBooleanFragments
 * for the design ruling behind refusing instead of assigning.
 */
export class FragmentTieError extends Error {
  readonly diagnostic: FragmentDiag
  constructor(diagnostic: FragmentDiag) {
    super(
      `mintBooleanFragments: refusing to mint -- two fragment seeds are ` +
        `geometrically indistinguishable through the full key chain ` +
        `(FRAGMENT_TIE_UNRESOLVED). parentFaceId=${diagnostic.params.parentFaceId} ` +
        `op=${diagnostic.params.op} fragments=[${diagnostic.params.fragmentA},` +
        `${diagnostic.params.fragmentB}] key=${diagnostic.params.key}`,
    )
    this.name = 'FragmentTieError'
    this.diagnostic = diagnostic
  }
}

export interface MintResult<T extends FragmentSeed> {
  fragments: MintedFragment<T>[]
}

function isFiniteVec(v: Vec3 | undefined): v is Vec3 {
  return !!v && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z)
}

/**
 * Minimum orientation-vector length. A zero-length (or sub-epsilon) normal/axis
 * carries no direction, so it cannot serve as the orientation ordering key -- it
 * is degenerate/invalid input and must fail loud rather than silently collapse
 * two differently-oriented fragments onto the same key.
 */
const ORIENTATION_MIN_LEN = 1e-9

function vecLen(v: Vec3): number {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z)
}

/**
 * Full-precision, order-free canonical serialization of a seed's geometry. Used
 * as the FINAL ordering key (separates sub-snap-tolerance-distinct fragments) and
 * as the tie-detection key. Raw float toString() is round-trippable and stable,
 * so this is deterministic. It reads only the seed's own geometry -- no index.
 */
function fullPrecisionKey(seed: FragmentSeed): string {
  const v = (p: Vec3) => `${p.x},${p.y},${p.z}`
  return `${v(seed.centroid)}|${seed.area}|${v(seed.orientation)}|${seed.shapeKey}`
}

/**
 * Throw loudly (never silently degrade) if a seed is missing any of the four
 * required geometric discriminators, OR if a supplied field is degenerate. A
 * partial seed is exactly the condition the R1 audit flagged: it would leave the
 * tie-break with nothing but input order. A degenerate field (zero-length
 * orientation, non-positive area) is the condition the R2 audit flagged: it is
 * finite yet meaningless, so it slips past the finiteness check while poisoning
 * the comparator chain. Both are invalid input and fail loud.
 */
function assertSeed(seed: FragmentSeed, i: number): void {
  const present =
    !!seed &&
    isFiniteVec(seed.centroid) &&
    typeof seed.area === 'number' && Number.isFinite(seed.area) &&
    isFiniteVec(seed.orientation) &&
    typeof seed.shapeKey === 'string' && seed.shapeKey.trim().length > 0
  if (!present) {
    throw new Error(
      `mintBooleanFragments: fragment seed [${i}] is missing required geometric ` +
      `discrimination data. centroid, area, orientation and shapeKey are ALL ` +
      `required -- a partial seed would force a caller/input-order tie-break, ` +
      `which the determinism invariant forbids. Received: ${JSON.stringify(seed)}`,
    )
  }
  // Area must be strictly positive: a face with zero/negative area is degenerate
  // and cannot be a real boolean fragment.
  if (seed.area <= 0) {
    throw new Error(
      `mintBooleanFragments: fragment seed [${i}] has non-positive area ` +
      `(${seed.area}). A boolean fragment must have area > 0; a zero/negative ` +
      `area is degenerate/invalid input. Received: ${JSON.stringify(seed)}`,
    )
  }
  // Orientation must have real direction: a zero-length normal/axis cannot serve
  // as an ordering key and would silently collapse distinct orientations.
  if (vecLen(seed.orientation) <= ORIENTATION_MIN_LEN) {
    throw new Error(
      `mintBooleanFragments: fragment seed [${i}] has a zero-length orientation ` +
      `vector (len <= ${ORIENTATION_MIN_LEN}). Orientation must be a real ` +
      `normal/axis direction; a degenerate vector is invalid input. ` +
      `Received: ${JSON.stringify(seed)}`,
    )
  }
}

/**
 * Mint boolean split-fragment ids for the fragments of one surviving parent
 * face. Fragments are ordered SOLELY by the full geometric key chain and
 * assigned #0, #1, ... in that order -- fully deterministic and independent of
 * the order the kernel (or the caller) happened to hand them over.
 *
 * The key chain, in order (each is a pure function of the fragment's geometry):
 *   1. centroid   (x,y,z lexicographic, snapped to 1e-7)
 *   2. area       (snapped)
 *   3. orientation vector (snapped) -- normal for planar, axis for cyl/cone/torus
 *   4. shapeKey   -- the canonical face-signature discriminator
 *   5. full-precision serialization -- geometric, order-free last resort that
 *      separates fragments differing only below the snap tolerance
 *
 * There is NO input-order fallback anywhere in this comparator (that was the
 * defect DOC-1-R2 closes). If two seeds are byte-identical through step 5 they
 * are truly geometrically indistinguishable -- a true full-key tie. This is a
 * structured REFUSAL, never an assignment (Architect design ruling, DOC-1-R3):
 * minting distinct ids for geometrically indistinguishable objects would
 * necessarily consult input order, which the determinism invariant forbids
 * absolutely. Two distinct faces of a VALID B-rep solid cannot be full-key
 * identical, so a true tie means degenerate/invalid input; we throw a
 * FragmentTieError carrying the FRAGMENT_TIE_UNRESOLVED diagnostic and mint
 * NOTHING. No code path -- including the stable-sort fallthrough -- can assign
 * suffixes to equal-key seeds.
 */
export function mintBooleanFragments<T extends FragmentSeed>(
  featureId: string,
  op: BooleanOp,
  parentFaceId: StableId,
  fragments: T[],
): MintResult<T> {
  for (let i = 0; i < fragments.length; i++) assertSeed(fragments[i], i)

  const keyed = fragments.map((seed) => ({ seed, key: fullPrecisionKey(seed) }))
  keyed.sort((a, b) => {
    const c = compareCentroids(a.seed.centroid, b.seed.centroid)
    if (c !== 0) return c
    const ar = compareScalar(a.seed.area, b.seed.area)
    if (ar !== 0) return ar
    const o = compareCentroids(a.seed.orientation, b.seed.orientation)
    if (o !== 0) return o
    const sk = compareIds(a.seed.shapeKey, b.seed.shapeKey)
    if (sk !== 0) return sk
    return compareIds(a.key, b.key)
  })

  // REFUSE on a true full-key tie before any id is minted. The sort groups equal
  // keys adjacently, so an adjacent-pair scan finds every tie. We throw on the
  // first one and mint nothing -- there is deliberately no assignment path here.
  for (let k = 1; k < keyed.length; k++) {
    if (keyed[k].key === keyed[k - 1].key) {
      throw new FragmentTieError({
        code: 'FRAGMENT_TIE_UNRESOLVED',
        severity: 'error',
        params: {
          parentFaceId,
          op,
          fragmentA: k - 1,
          fragmentB: k,
          key: keyed[k].key,
        },
      })
    }
  }

  const fragmentsOut = keyed.map(({ seed }, index) => ({
    id: booleanFragmentId(featureId, op, parentFaceId, index),
    index,
    seed,
  }))
  return { fragments: fragmentsOut }
}

// ---------------------------------------------------------------------------
// Grammar-aware id PARSER (UI-H2 / BK-56). Every UI-side consumer that used
// to hand-split a stableId string (EDGE_JOIN, ':', slice/startsWith) must go
// through this instead. A naive split breaks the moment an id EMBEDS another
// id -- fillet/chamfer band faces embed their whole edge id as their
// originTag (`F20:FIL:(F12:XTR:S3.e7:side<AND>F12:XTR:cap1)`), so that edge's
// own AND-joiner and parens appear NESTED one level deep. If that band face
// then borders a further edge, the outer edge id
// (`(F20:FIL:(A<AND>B)<AND>C)`) contains the joiner char THREE times at two
// different nesting depths -- a flat `.split(EDGE_JOIN)` (or a greedy regex
// alternation) cannot tell which occurrence is the top-level split point and
// either mis-splits or (with a `parts.length===2` guard, as
// geometryVisibility.ts's old deriveHiddenEdgeIds had) silently drops the id
// entirely. This parser is depth-aware: a delimiter only splits at
// paren-depth 0, so nested ids are returned INTACT as a single operand/
// segment for the caller to recurse into via a further parseStableId call
// (parseStableId is its own recursion base case) rather than being torn
// apart. Pure function, no I/O -- reads only its string argument.
// ---------------------------------------------------------------------------

/** One operand of a parenthesized edge/vertex id: either a face's (possibly
 *  itself band-nested) stableId, the literal `seam#<k>` marker, or the
 *  literal `orphan` marker (an edge/vertex naming no real face). */
export interface EdgeOperand {
  /** raw operand text -- a full stableId when neither seam nor orphan. */
  raw: string
  isSeam: boolean
  isOrphan: boolean
}

/**
 * A parenthesized id: `(a<AND>b)` (edge), `(a<AND>seam#k)` (seam edge),
 * `(orphan<AND>seam#k)` (orphan seam edge -- names no real face), or
 * `(a<AND>b<AND>c...)` (vertex id, the sorted-set-of-adjacent-faces form,
 * >2 operands). Edge vs. vertex is purely `operands.length === 2` vs. `> 2`;
 * callers that only handle two-face edges check the length themselves (see
 * geometryVisibility.ts's deriveHiddenEdgeIds).
 */
export interface ParsedEdgeId {
  kind: 'edge'
  operands: EdgeOperand[]
  /**
   * GEO-16 (ICR-3 step 2): the geometric disambiguator token when two physically
   * distinct edges share this adjacent-face pair -- the text after the `@` marker
   * in `(A<AND>B)@<token>`. `undefined` for the common single-edge-per-pair id
   * (which stays byte-identical to the bare `(A<AND>B)` form). Face `operands`
   * are UNCHANGED whether or not a disambiguator is present, so every consumer
   * that reads the two adjacent faces (edgesOfFace, measure length, visibility)
   * works identically on both forms; only callers that need to tell two twins
   * apart read this field. See src/geom/worker/stable-id.ts disambiguateEdgeIds.
   */
  disambiguator?: string
}

/** One contributing (instance, seed-face) pair of a `PAT:merge` overlap-face
 *  id, e.g. `"i0:F1:BOX:yMin"` -> `{ instance: 'i0', childId: 'F1:BOX:yMin' }`. */
export interface PatternMergeMember {
  instance: string
  childId: string
}

/**
 * A ':'-delimited `featureRef:opCode:originTag:disambig` chain -- every
 * non-parenthesized stableId (BOX/XTR/REV/FIL/CHM/CUT/PAT/import/heal
 * faces). The split is depth-aware, so a FIL/CHM band segment whose
 * originTag itself embeds a parenthesized edge id is never torn apart: that
 * segment comes back as ONE verbatim string (the "band form"), one
 * recursive `parseStableId` call away from its own `ParsedEdgeId`.
 */
export interface ParsedSegmentChain {
  kind: 'segments'
  segments: string[]
  featureId: string
  opCode?: string
  /** populated only for the `F:PAT:merge:(i<a>:<childId>|...)` overlap form. */
  patternMerge?: PatternMergeMember[]
}

export type ParsedStableId = ParsedEdgeId | ParsedSegmentChain

/**
 * Depth-aware split: `delimiter` only splits the string at paren-depth 0, so
 * an occurrence nested inside a parenthesized sub-id (band faces, PAT:merge
 * bodies) is never mistaken for a top-level split point. Unbalanced input
 * (should not occur for a well-formed stableId) never goes negative-depth or
 * throws -- depth floors at 0, so it degrades to an ordinary top-level split
 * rather than misbehaving.
 */
function splitTopLevel(input: string, delimiter: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (ch === '(') depth++
    else if (ch === ')') depth = Math.max(0, depth - 1)
    else if (depth === 0 && input.startsWith(delimiter, i)) {
      parts.push(input.slice(start, i))
      i += delimiter.length - 1
      start = i + 1
    }
  }
  parts.push(input.slice(start))
  return parts
}

/** Parses a `PAT:merge` body's inner text (without its own outer parens) --
 *  `|`-separated `i<n>:<childId>` members, `|` split depth-aware so a
 *  member's own childId may itself embed parens (a merged fillet-band
 *  instance, say) without corrupting the split. Returns undefined if the
 *  segment isn't parenthesized or a member has no `:` (malformed). */
function parsePatternMergeBody(parenSegment: string): PatternMergeMember[] | undefined {
  if (!parenSegment.startsWith('(') || !parenSegment.endsWith(')')) return undefined
  const inner = parenSegment.slice(1, -1)
  const members: PatternMergeMember[] = []
  for (const part of splitTopLevel(inner, '|')) {
    const sep = part.indexOf(':')
    if (sep === -1) return undefined
    members.push({ instance: part.slice(0, sep), childId: part.slice(sep + 1) })
  }
  return members
}

/**
 * Tokenize a stableId per docs/stable-id-spec.md's Grammar section, depth-
 * aware so nested/embedded ids (fillet/chamfer bands, PAT:merge overlap
 * faces) are never torn apart by a naive string split. This is the ONE
 * canonical parser every UI-side consumer must go through instead of
 * hand-splitting id strings (BK-56) -- see
 * src/components/model3d/visibility/geometryVisibility.ts's
 * deriveHiddenEdgeIds and src/components/model3d/measure/measureLogic.ts's
 * axisFaceForEdge for the call sites this replaced.
 *
 *  - `(a<AND>b)` / `(a<AND>seam#k)` / `(orphan<AND>seam#k)` -> ParsedEdgeId
 *    with 2 operands (an edge id).
 *  - `(a<AND>b<AND>c...)` (>2 operands) -> ParsedEdgeId, the vertexId
 *    sorted-set form; callers that only want edges check
 *    `operands.length === 2`.
 *  - anything else -> ParsedSegmentChain, the depth-aware ':'-split of
 *    featureRef:opCode:originTag:disambig. A FIL/CHM band's originTag
 *    segment is the embedded edge id VERBATIM -- recurse with
 *    `parseStableId` on that segment to look inside it (the "band form").
 *    `F:PAT:merge:(i<a>:<childId>|...)` additionally gets its
 *    `patternMerge` field populated.
 */
export function parseStableId(id: string): ParsedStableId {
  if (id.startsWith('(')) {
    // GEO-16: a two-face edge may carry a trailing `@<token>` disambiguator
    // OUTSIDE the closing paren -- `(A<AND>B)@m..._l...`. Split at the LAST
    // top-level ')': everything up to and including it is the paren body (nested
    // ids keep their own parens intact), and an `@...` tail is the disambiguator.
    // A bare `(...)` (tail empty) is the byte-identical common form.
    const close = id.lastIndexOf(')')
    const tail = close === -1 ? '' : id.slice(close + 1)
    if (close !== -1 && (tail === '' || tail.startsWith(EDGE_DISAMB_MARK))) {
      const inner = id.slice(1, close)
      const operands = splitTopLevel(inner, EDGE_JOIN).map((raw) => ({
        raw,
        isSeam: raw.startsWith('seam#'),
        isOrphan: raw === 'orphan',
      }))
      const parsed: ParsedEdgeId = { kind: 'edge', operands }
      if (tail.length > 1) parsed.disambiguator = tail.slice(1)
      return parsed
    }
  }
  const segments = splitTopLevel(id, ':')
  const featureId = segments[0] ?? ''
  const opCode = segments[1]
  const result: ParsedSegmentChain = { kind: 'segments', segments, featureId, opCode }
  if (opCode === 'PAT' && segments[2] === 'merge' && segments[3] !== undefined) {
    const patternMerge = parsePatternMergeBody(segments[3])
    if (patternMerge !== undefined) result.patternMerge = patternMerge
  }
  return result
}
