/**
 * GEO-1 Geometry Engine — thread-agnostic occt-wasm implementation of the
 * frozen GeomService contract (src/geom/geom-service.ts).
 * ====================================================================
 * This class holds ALL geometry worker-side, behind opaque BodyHandles, and
 * never lets an OCCT type cross its boundary (contract rule 1). It is the same
 * code whether hosted inside a Web Worker (browser: geom-worker.ts wraps it via
 * Comlink) or run directly on the calling thread (Node tests + the main-thread
 * fallback). Because it uses the FULL OcctKernel — not occt-wasm's curated
 * OcctWorkerProxy — history-producing ops (cutWithHistory) run wherever the
 * engine runs, INCLUDING the worker. That is GEO-1 architect ruling #2, path (a).
 *
 * Kernel wiring follows ruling #1 exactly: explicit OcctKernel.init({wasm}) +
 * registerKernel('occt-wasm', OcctWasmAdapter.fromKernel(kernel)) — never bare
 * brepjs.init() (STAGE0_FINDINGS gotcha #6). brepjs is wired so downstream WOs
 * have it available; the Stage-1 ops themselves run on OcctKernel directly,
 * which is the most robust path and sidesteps the worker-fillet bug (gotcha #7).
 */
import { OcctKernel } from 'occt-wasm'
import { parseEdgeToFaceMap, planarEdgeAdjacency } from './planarAdjacency'
import { registerKernel, OcctWasmAdapter } from 'brepjs'
import type { EvolutionData, LabelTag, ShapeHandle, SurfaceKind, XCAFDocument } from 'occt-wasm'
import type {
  BodyHandle,
  BooleanRequest,
  ChamferRequest,
  Diag,
  DraftRequest,
  EdgeClass,
  ElementMapDelta,
  FilletRequest,
  GeometrySnapshot as ContractGeometrySnapshot,
  IgesContent,
  ImportedBody,
  KernelInfo,
  MeasureResult,
  OpResult,
  ShellRequest,
  StableId,
  SubshapeType,
  SurfaceType,
  TessBuffers,
  TessQuality,
  Vec3,
} from '../geom-service.ts'

/** Runtime metadata for replacing a recognized imported fillet through the
 * existing Fillet production entry point. Ordinary authored fillets omit it. */
interface ImportedFilletRequest extends FilletRequest {
  importedFeatureKey: string
}

function isImportedFilletRequest(req: FilletRequest): req is ImportedFilletRequest {
  const candidate = req as Partial<ImportedFilletRequest>
  return typeof candidate.importedFeatureKey === 'string' && candidate.importedFeatureKey.length > 0
}

type ImportedFilletBuildResult =
  | { ok: false; diagnostics: Diag[] }
  | {
      ok: true
      body: BodyHandle
      assignment: {
        modified: Record<StableId, StableId[]>
        generated: StableId[]
        deleted: StableId[]
        geometry: Record<StableId, ContractGeometrySnapshot>
      }
    }
import type {
  BodyRecord,
  DeltaSnapshots,
  EvolutionRecord,
  FaceProbe,
  FaceSurfaceKind,
  GeometrySnapshot,
} from './internal-types.ts'
import {
  assignBoxFaceIds,
  assignCutFaceIds,
  assignShellFaceIds,
  nameShellBlendFaces,
  compareSnapshots,
  type CutAssignment,
  type ShellAssignment,
  edgeId,
  withEdgeDisamb,
  disambiguateEdgeIds,
  collidingPickedEdgeIds,
  resolvePersistedEdgeId,
  type EdgeGeom,
  orderMintCandidates,
  rebindDraftFaces,
  type BBox,
} from './stable-id.ts'
import { compareIds, parseStableId, vertexId } from '../../doc/stable-id.ts'
// THE shared face-id resolver + its delta lineage, shared verbatim with the UI
// lane (see src/geom/aliasLineage.ts for why it lives outside this file).
import { aliasesFromDelta, foldAliasLineageIntoDelta, resolveFaceIdVia } from '../aliasLineage.ts'
import {
  add,
  axisFromThreeCirclePoints,
  capOrderRefs,
  capOrderScore,
  cross,
  dot,
  extrudeCapId,
  extrudeSideId,
  frameFromNormal,
  holeFaceId,
  len,
  lift,
  loftCapId,
  loftSideId,
  loopClosed,
  normalize,
  patternInstanceId,
  patternMergeId,
  planeBasis,
  reflectPoint,
  reflectVector,
  revolveCapId,
  revolveSurfId,
  rotateAboutAxis,
  scale,
  segGeom2d,
  segRep2d,
  sub,
  sweepCapId,
  sweepSideId,
  type PlaneBasis,
  type SegGeom2D,
  type Vec3T,
} from './sweep-lineage.ts'
import type {
  ExtrudeRequest,
  ExtrudeEndTargetIdentity,
  ExtrudeTargetIdentity,
  HoleRequest,
  LoftRequest,
  PatternRequest,
  PlanarFaceSet,
  ProfileRegion,
  RevolveRequest,
  ResolvedExtrudeEnd,
  ResolvedExtrudeFaceTarget,
  ResolvedExtrudeTarget,
  SweepRequest,
} from '../geom-service.ts'
// MSH-3 registration (WO ruling 1): prismatic mesh->brep bridge lives entirely
// in its own file; the method below is a thin delegator.
import { buildSolidFromPlanarFaces } from './prismaticBuild.ts'
import { reliefFaceStepInFrame, type ReliefPoles } from '../../relief/reliefStep.ts'
import { reliefDetailFaceMesh, type DetailFrame, type ReliefDetail } from '../../relief/reliefMesh.ts'
import { draftTiltedNeutralPlaneMessage } from '../../lib/machine/operatorMessages.ts'
// GEO-6 direct-edit / defeature core (kernel-facing, hash-only; the engine is
// the sole translator to stable ids).
import {
  gatherFaces,
  releaseFaceRecs,
  recognizeFeatures as recognizeFeaturesCore,
  healRemoval,
  type RecognizedFeature,
  type FaceRec,
  type HealResult,
} from './defeature.ts'
import type {
  DefeatureItemResult,
  DefeatureRequest,
  DefeatureResult,
  FaceEditRequest,
  FeatureClass,
  FeatureQuery,
  FeatureVerdict,
} from '../geom-service.ts'

/** WO-2091: change a recognized hole's depth. The frozen FaceEditRequest kind
 *  union lives in geom-service.ts; this engine-side request rides beside it
 *  through the same editFeature entry. `delta` is the signed depth change (mm)
 *  from the recognized depth, measured from the hole's entry opening; `through`
 *  cuts the hole through the part instead (delta ignored). A new depth that
 *  reaches the far side of the part also comes out as a through hole. */
export interface HoleDepthEditRequest extends Omit<FaceEditRequest, 'kind'> {
  kind: 'holeDepth'
  through?: boolean
}

/** WO-2171: lay an image relief into a flat face (docs/design/IMAGE-RELIEF-PLAN.md
 *  section 3, route (b)). Rides the same editFeature entry as holeDepth.
 *  `featureKey` is the planar face's StableId; `delta` is unused (0). The
 *  relief face is the clamped bicubic B-spline whose n x n control points are
 *  origin + gx xDir + gy yDir + h normal (gx, gy at their Greville points over
 *  widthMm x heightMm, h = heights[iy * n + ix], signed mm; the border ring is
 *  0 so the face's boundary lies in the plane).
 *
 *  WO-2200 `detail`: a MESH relief - the working grid (cols x rows signed mm
 *  over the same rectangle, row 0 at its low-Y edge) whose detail is finer
 *  than the exact face's poles can hold. The body is still built from the
 *  poles (the exact face, never above RELIEF_EXACT_POLE_CAP); the relief face
 *  is then meshed from this grid at its full detail (display, CAM and STL),
 *  while STEP carries the exact face. */
export interface ReliefEditRequest extends Omit<FaceEditRequest, 'kind'> {
  kind: 'relief'
  relief: {
    origin: Vec3
    xDir: Vec3
    yDir: Vec3
    normal: Vec3
    widthMm: number
    heightMm: number
    n: number
    heights: ArrayLike<number>
    detail?: ReliefDetail
  }
}

/** WO-2170's measured rule (IMAGE-RELIEF-PLAN.md 3a): an exact relief face is never
 *  built above 256 control points per side - at 1024 the kernel trapped and stayed
 *  broken for the process. The engine refuses above this, whoever asks. */
export const RELIEF_EXACT_POLE_CAP = 256

/**
 * How a relief face is meshed (display and CAM alike): by its chord, at most 0.02 mm
 * (under half the 0.05 mm CAM tolerance), with the angle limit relaxed to
 * 0.8 rad. MEASURED (WO-2171, the text sign at 256 x 256 poles, 100 x 50 mm):
 * the display's own 0.08 mm / 0.35 rad took 64 s for 487,544 triangles - the
 * angle limit multiplies triangles on a relief's many short steep walls without
 * adding accuracy - while 0.02 mm / 0.8 rad took 2.6 s for 175,652 triangles,
 * four times tighter on the chord.
 */
export const RELIEF_MESH = { linearDeflection: 0.02, angularDeflection: 0.8 } as const

/** One face's triangles in tessellate (normals as meshed; `reversed` flips them). */
interface FaceTriangles {
  positions: ArrayLike<number>
  normals: ArrayLike<number>
  indices: ArrayLike<number>
  reversed: boolean
}

/** WO-2200: the mesh points of the other faces lying in a relief's plane (flat xyz) - where its edges' points come from. */
function pointsOnPlane(meshes: readonly (FaceTriangles | null)[], frame: DetailFrame): number[] {
  const { origin: o, normal: n } = frame
  const out: number[] = []
  for (const m of meshes) {
    if (m === null) continue
    const p = m.positions
    for (let i = 0; i + 2 < p.length; i += 3) {
      if (Math.abs((p[i] - o.x) * n.x + (p[i + 1] - o.y) * n.y + (p[i + 2] - o.z) * n.z) <= 1e-3) out.push(p[i], p[i + 1], p[i + 2])
    }
  }
  return out
}

/** Every request editFeature accepts. */
export type EngineFaceEditRequest = FaceEditRequest | HoleDepthEditRequest | ReliefEditRequest

/** Hash upper bound for hashCode() — matches the Stage-0 spikes. */
const HM = 1 << 30

/** WO-2107: what the Shell-by-construction route found on the part (see
 *  GeomEngine #applyShellByConstruction). Handles are owned by `own`'s
 *  scratch list and released when the shell request finishes. */
interface ShellConstructionPlan {
  /** outward unit normal of the removed (opened) face */
  n: { x: number; y: number; z: number }
  /** a point on the removed face */
  origin: { x: number; y: number; z: number }
  /** each depression floor's outer wire and its depth below the opening */
  floors: Array<{ wire: ShapeHandle; depth: number }>
  /** the part with its depressions filled */
  block0: ShapeHandle
  /** block0, then (built on demand) block0 with its small faces off too */
  blocks: ShapeHandle[]
  /** the first block stage MakeThickSolid hollowed; later walls start there */
  stage: number
  /** every source face but the opened one */
  retainedFaces: ShapeHandle[]
  retainedHashes: number[]
  own: <T extends ShapeHandle>(h: T) => T
}

/** OCCT major version behind occt-wasm@3.6.1 (STAGE0_FINDINGS). No runtime
 *  getter is exposed by the package, so this is a documented constant. */
const OCCT_VERSION = '8.0'

const KNOWN_SURFACE_KINDS = new Set<FaceSurfaceKind>([
  'plane', 'cylinder', 'cone', 'sphere', 'torus', 'bspline', 'bezier', 'offset', 'revolution', 'extrusion',
])

/** Exact circumcenter of three non-collinear points on a 3D circle. */
function circleCenter(p0: Vec3T, p1: Vec3T, p2: Vec3T): Vec3T | undefined {
  const a = sub(p1, p0)
  const b = sub(p2, p0)
  const axb = cross(a, b)
  const denom = 2 * dot(axb, axb)
  if (!(denom > 1e-18)) return undefined
  const num = add(
    scale(cross(b, axb), dot(a, a)),
    scale(cross(axb, a), dot(b, b)),
  )
  const center = add(p0, scale(num, 1 / denom))
  return center.every(Number.isFinite) ? center : undefined
}

function toFaceKind(k: SurfaceKind): FaceSurfaceKind {
  return KNOWN_SURFACE_KINDS.has(k as FaceSurfaceKind) ? (k as FaceSurfaceKind) : 'other'
}

/**
 * ICR-1 boundary collapse (GEO-2, architect ruling #2): worker-internal
 * FaceSurfaceKind (occt-wasm's raw, finer-grained SurfaceKind) -> the frozen
 * contract's SurfaceType (geom-service.ts). Exact table:
 *   plane/cylinder/cone/sphere/torus/bspline -> itself (already contract-shaped)
 *   bezier                                   -> 'bspline' (both are parametric
 *                                                 spline curves/surfaces — the
 *                                                 "spline-like" half of ruling #2)
 *   offset/revolution/extrusion              -> 'other' (procedural/derived
 *                                                 surfaces with no direct
 *                                                 SurfaceType equivalent; NOT
 *                                                 spline-like themselves even
 *                                                 when built from a spline
 *                                                 profile — the underlying
 *                                                 basis surface isn't exposed)
 *   anything unrecognized                    -> 'other' (already folded by toFaceKind)
 */
export function toSurfaceType(kind: FaceSurfaceKind): SurfaceType {
  if (kind === 'bezier') return 'bspline'
  if (kind === 'offset' || kind === 'revolution' || kind === 'extrusion') return 'other'
  if (kind === 'plane' || kind === 'cylinder' || kind === 'cone' || kind === 'sphere' || kind === 'torus' || kind === 'bspline') {
    return kind
  }
  return 'other'
}

const AXIAL_KINDS: ReadonlySet<FaceSurfaceKind> = new Set(['cylinder', 'cone', 'torus'])

/** Parameters driving constructed sweep lineage (see #assignSweptFaceIds). */
interface SweepLineageParams {
  featureId: string
  sketchId: string
  mode: 'XTR' | 'REV'
  segReps: Array<{ srcId: string; rep: Vec3T }>
  capScore: (centroid: Vec3T) => number
  /** XTR only: extrude unit dir — a planar face whose normal is parallel to it
   *  is a cap (a robust primary signal alongside the projection-distance test). */
  capNormalRef?: Vec3T
}

type ExtrudeTerminal = {
  distance: number
  targets: ExtrudeEndTargetIdentity[]
}

type ExtrudeTerminalResult =
  | { ok: true; terminal: ExtrudeTerminal }
  | { ok: false; code: 'KERNEL_OP_FAILED' | 'REFERENCE_UNRESOLVED'; reason: string }

/** Project an internal (worker-side) GeometrySnapshot onto the frozen
 *  contract's GeometrySnapshot shape (ICR-1). Pure, no kernel access. */
function toContractGeometry(s: GeometrySnapshot): ContractGeometrySnapshot {
  const surfaceType = toSurfaceType(s.type)
  const centroid: Vec3 = { x: s.centroid[0], y: s.centroid[1], z: s.centroid[2] }
  const out: ContractGeometrySnapshot = { surfaceType, centroid, area: s.area }
  if (surfaceType === 'plane') {
    out.normal = { x: s.normal[0], y: s.normal[1], z: s.normal[2] }
  } else if ((s.type === 'cylinder' || s.type === 'cone' || s.type === 'torus') && s.axis) {
    // GEO-3 BK-14: axis is now the ANALYTIC axis of revolution for ALL axial
    // kinds (cylinder/cone/torus), derived in #probeFace from three points
    // sampled along a latitude circle (their plane is perpendicular to the
    // axis, so its normal IS the axis) -- exact, not the tilted-normal
    // cross-product. This SUPERSEDES the GEO-2-R1.1 cylinder-only gate (which
    // withheld axis on cone/torus because the two-normal shortcut was
    // analytically wrong there); the DOC resolver's wrong-bind guard now gets
    // a correct axis for cones and tori too instead of degrading to "absent".
    out.axis = { x: s.axis[0], y: s.axis[1], z: s.axis[2] }
  }
  return out
}

function distance3(a: [number, number, number], b: Vec3): number {
  return Math.hypot(a[0] - b.x, a[1] - b.y, a[2] - b.z)
}

/** Lift a 2D sketch-plane DIRECTION (not point) to a 3D unit vector. */
function liftDir(basis: PlaneBasis, d: [number, number]): Vec3T {
  return normalize(add(scale(basis.xDir, d[0]), scale(basis.yDir, d[1])))
}

function okDiag(): Diag[] {
  return [{ code: 'OK', severity: 'info' }]
}

/** WO-2093: a short identity for a body's geometry (every face's id, kind,
 *  centre and area), so two handles holding the same shape share one key. */
function shapeFingerprint(snapshots: ReadonlyMap<StableId, GeometrySnapshot>): string {
  let a = 0x811c9dc5
  let b = 0x01000193
  const ids = [...snapshots.keys()].sort()
  for (const id of ids) {
    const snap = snapshots.get(id)!
    const text = `${id}|${snap.type}|${snap.centroid.map((v) => v.toFixed(4)).join(',')}|${snap.area.toFixed(4)};`
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i)
      a = Math.imul(a ^ c, 0x01000193) >>> 0
      b = Math.imul(b ^ c, 0x5bd1e995) >>> 0
    }
  }
  return `${ids.length}:${a.toString(36)}${b.toString(36)}`
}

/** WO-2093: a STEP product label that is only the exporting program's stamp
 *  ("Open CASCADE STEP translator 7.9 2") rather than a part name. */
function isExporterStampName(name: string): boolean {
  return /^open cascade step translator\b/i.test(name.trim())
}

/** Decode occt-wasm's flattened evolution array [inHash, count, ...outHashes]. */
export function decodeEvolution(arr: ArrayLike<number>): EvolutionRecord[] {
  const out: EvolutionRecord[] = []
  let i = 0
  const n = arr.length
  while (i < n) {
    const inHash = arr[i++]
    if (i >= n) break
    const count = arr[i++]
    const outHashes: number[] = []
    for (let j = 0; j < count && i < n; j++) outHashes.push(arr[i++])
    out.push({ inHash, outHashes })
  }
  return out
}

export interface GeomEngineOptions {
  /** wasm source passed to OcctKernel.init({wasm}). In the browser worker this
   *  is the Vite `?url` string; in Node leave undefined to auto-locate. */
  wasm?: string | URL | ArrayBuffer | Uint8Array
}

/**
 * The engine. Implements the Stage-1 subset of GeomService fully, and provides
 * kernel-backed implementations of the remaining Stage-1-listed methods. The
 * hard resolver/persistence edges that genuinely need Stage-2 machinery are
 * clearly marked and fail loud rather than silently mis-binding.
 */
/** Round to a 1e-3 grid — the tolerance at which byte-identical kept faces and
 *  rebuilt (untrimmed / loop-removed) axis-aligned planar faces both match. */
function r3(v: number): number { return Math.round(v * 1000) / 1000 }

/**
 * GEO-6X6 (BK-91) face-lineage matching, shared by #assignHealedIds and
 * #assignEditedIds. Replaces the single `healMatchKey` probe, whose PLANE branch
 * keyed on `P|normal|offset` ALONE: two distinct coplanar faces of one valid
 * solid (two pads on one plane; 86 such faces on the raw Tray.step import) share
 * that key, so on a collision the last writer won the map slot and the
 * first-come probe won the id — which face kept its id was iteration-order luck,
 * and every loser was re-minted (~87 ids churned per heal on the Tray).
 *
 * The loose plane key exists ON PURPOSE and must survive: a REBUILT planar face
 * (untrim / removeHolesFromFace) changes area AND centroid but keeps its
 * supporting plane, so normal + signed offset is the only invariant left. Adding
 * centroid+area to the plane key would fix the collisions and break rebuilt-face
 * lineage. So the loose key is not tightened — it is DEMOTED to a fallback that
 * only ever sees the faces exact matching could not claim:
 *
 *   pass 1  exactMatchKey   type+centroid+area+axis, every surface type.
 *                           A byte-identical KEPT face matches here, always,
 *                           before any loose key is consulted.  (property 1)
 *   pass 2  planeSupportKey normal+signed offset, over the REMAINDER only.
 *                           A rebuilt planar face alone on its support still
 *                           matches its original id.               (property 2)
 *           On a support carrying more than one leftover original OR probe the
 *           fallback is AMBIGUOUS: it resolves only mutual-nearest-centroid
 *           pairs, and REFUSES everything else (probe minted new, original
 *           deleted) rather than mis-bind.                          (property 3)
 *
 * Two distinct coplanar KEPT faces are both claimed by pass 1 and never reach
 * the fallback at all — which is the whole fix.
 */

/** PASS-1 key: the full geometry snapshot. Byte-identical survivors of ANY
 *  surface type (including planes) match on this and nothing looser.
 *
 *  Per-surface-type key format (GEO-6X6-R1, fixing the auditor's major): the
 *  direction component is the field that actually carries the surface's
 *  orientation for that type —
 *    plane                        -> centroid|area|NORMAL (the plane's own
 *                                     orientation; `axis` is never set on a
 *                                     plane snapshot, so the pre-fix key
 *                                     silently used [0,0,0] for every plane
 *                                     and could not tell +X from +Z faces —
 *                                     the auditor's repro).
 *    cylinder | cone | torus       -> centroid|area|AXIS (best-effort axial
 *                                     direction; falls back to [0,0,0] on the
 *                                     rare degenerate probe, same as before).
 *    sphere | bspline | bezier |
 *    offset | revolution |
 *    extrusion | other             -> centroid|area|[0,0,0] (no reliable
 *                                     single direction exists for these;
 *                                     centroid+area+type is the same
 *                                     discriminant this key always relied on
 *                                     for them — unchanged by this fix).
 */
export function exactMatchKey(s: GeometrySnapshot): string {
  // GEO-6X6-R2 (auditor's minor): only cylinder/cone/torus consume `axis` — a
  // stray axis on a sphere/bspline/etc. (a type that never carries one in
  // production, but the field is optional on GeometrySnapshot for every type)
  // must not perturb the key for those types. plane uses its own normal;
  // every other non-axial type is a constant [0,0,0], never `s.axis`.
  const d = s.type === 'plane' ? s.normal : AXIAL_KINDS.has(s.type) ? (s.axis ?? [0, 0, 0]) : [0, 0, 0]
  return `${s.type}|${r3(s.centroid[0])}|${r3(s.centroid[1])}|${r3(s.centroid[2])}|${r3(s.area)}|${r3(d[0])}|${r3(d[1])}|${r3(d[2])}`
}

/** PASS-2 key: the supporting PLANE — normal + signed offset dot(n, centroid),
 *  which is plane-constant for any point ON the plane and survives an untrim.
 *  Non-planar faces have no support fallback (they only ever survive intact). */
export function planeSupportKey(s: GeometrySnapshot): string | null {
  if (s.type !== 'plane') return null
  const n = s.normal, c = s.centroid
  const off = n[0] * c[0] + n[1] * c[1] + n[2] * c[2]
  return `P|${r3(n[0])}|${r3(n[1])}|${r3(n[2])}|${r3(off)}`
}

/** Which rule bound a face to its original id. Enumerated, never an else-branch. */
export type FaceMatchPath = 'exact' | 'plane-fallback-unique' | 'plane-fallback-nearest'

export interface OrigFace { id: StableId; snap: GeometrySnapshot }
export interface FaceMatch { id: StableId; probe: FaceProbe; origSnap: GeometrySnapshot; path: FaceMatchPath }

export interface FaceMatchResult {
  /** ids that moved along a verified match, with the rule that carried them. */
  matches: FaceMatch[]
  /** result faces no rule claimed -> caller mints a new id. */
  mintProbes: FaceProbe[]
  /** original ids no rule claimed -> caller deletes (or pairs them itself). */
  remainingOrig: OrigFace[]
  /**
   * GEO-6X6-R2 (auditor's major): provenance for members of `remainingOrig` /
   * `mintProbes` that were REFUSED by an ambiguous or total-tie bucket (pass 1
   * exact-key cardinality mismatch, or pass 2 plane-support members no
   * mutual-nearest round could resolve) — as opposed to members that simply
   * never had a same-key/same-support counterpart at all. A caller that pairs
   * its own leftovers (edit pass 3) MUST exclude every id/probe in these two
   * sets before pairing, or it re-binds by whatever order its own pairing rule
   * happens to iterate in — exactly the input-order dependency the shared
   * matcher was built to refuse. Callers that unconditionally mint+delete
   * every leftover (the heal consumer) do not need to consult these — refusal
   * already IS mint+delete for them.
   */
  refusedOrigIds: Set<StableId>
  refusedProbes: Set<FaceProbe>
  /** per-path census; the five counts partition every face on both sides. */
  paths: {
    exact: number
    planeFallbackUnique: number
    planeFallbackNearest: number
    /** probe+orig pairs left on an ambiguous support that no mutual-nearest rule
     *  could bind. They are refused: counted here AND in mint/delete below. */
    planeFallbackRefused: number
    noHitMint: number
    origLeftoverDelete: number
  }
}

/**
 * The shared id -> live kernel-hash index for a (faceMap, aliases) pair, with
 * every alias folded in so a merged-away pre-existing id lands on its winner's
 * live face. O(n) for a whole consumer call, vs the O(n)-per-id
 * `[...faceMap.entries()].find()` it replaces.
 *
 * A live id always outranks its own alias entry. An alias whose root this body
 * has since DELETED is left OUT of the index entirely, so its consumer refuses
 * BY NAME rather than binding a wrong face — fail-closed, per charter item 2.
 */
function faceHashIndexVia(faceMap: Map<number, StableId>, aliases: Map<StableId, StableId> | undefined): Map<StableId, number> {
  const idx = new Map<StableId, number>()
  for (const [h, id] of faceMap) idx.set(id, h)
  if (aliases) {
    for (const loser of aliases.keys()) {
      if (idx.has(loser)) continue
      const rootHash = idx.get(resolveFaceIdVia(aliases, loser))
      if (rootHash !== undefined) idx.set(loser, rootHash)
    }
  }
  return idx
}

/**
 * EDGE-ID MIGRATION ACROSS FACE ALIASES (UI-57-R1 blocker 2). An edge StableId
 * is not stored — it is RE-DERIVED every tessellation from its adjacent FACE
 * ids and embeds them verbatim (`(<faceA><AND><faceB>)`, operands sorted, plus
 * an optional `@<geometric token>` disambiguator; see edgeId() and
 * parseStableId()). So when a face merges away, every persisted edge id naming
 * the LOSER re-derives to a different string and silently resolves 'lost' —
 * a fillet/chamfer on a healed body's edge would land in `missing` as a
 * REFERENCE_UNRESOLVED. Migration rewrites each face operand through the shared
 * resolver so the persisted pick names the winner instead.
 *
 * Scope + fail-closed rules:
 *  - EDGES ONLY (exactly 2 operands). The >2-operand vertex form and the
 *    non-edge segment-chain forms are returned UNCHANGED: edgeId() keeps only
 *    the first two ids, so re-emitting a vertex id through it would CORRUPT it.
 *  - The disambiguator rides through untouched: healing is a purely topological
 *    merge, so a surviving edge's midpoint/length geometry is unchanged.
 *  - When BOTH operands resolve to the SAME winner, the edge WAS the healed-away
 *    seam between them. The migrated id then names no live edge and resolves
 *    'lost' — which is the honest answer (the edge genuinely no longer exists),
 *    not a bug to paper over.
 */
function migrateEdgeIdVia(aliases: Map<StableId, StableId> | undefined, id: StableId): StableId {
  if (!aliases || aliases.size === 0) return id
  const parsed = parseStableId(id as string)
  if (parsed.kind !== 'edge' || parsed.operands.length !== 2) return id
  const faceIds: StableId[] = []
  let seamKey: string | undefined
  let changed = false
  for (const op of parsed.operands) {
    if (op.isSeam) { seamKey = op.raw.slice('seam#'.length); continue }
    if (op.isOrphan) continue
    const root = resolveFaceIdVia(aliases, op.raw as StableId)
    if (root !== op.raw) changed = true
    faceIds.push(root)
  }
  if (!changed) return id
  const base = edgeId(faceIds, seamKey ?? '0')
  return parsed.disambiguator !== undefined ? withEdgeDisamb(base, parsed.disambiguator) : base
}

/** The original body's faces as match candidates, deduped by StableId (a faceMap
 *  can carry two kernel hashes for one id) and ordered by id for determinism. */
function origFaces(rec: BodyRecord): OrigFace[] {
  const byId = new Map<StableId, GeometrySnapshot>()
  for (const id of rec.faceMap.values()) {
    const snap = rec.snapshots.get(id)
    if (snap && !byId.has(id)) byId.set(id, snap)
  }
  return [...byId].map(([id, snap]) => ({ id, snap }))
}

/** Squared centroid distance — the only ranking the ambiguous fallback uses. */
function centroidD2(a: GeometrySnapshot, b: GeometrySnapshot): number {
  const dx = a.centroid[0] - b.centroid[0]
  const dy = a.centroid[1] - b.centroid[1]
  const dz = a.centroid[2] - b.centroid[2]
  return dx * dx + dy * dy + dz * dz
}

/** Index of the STRICTLY unique nearest entry, or -1 when the set is empty or
 *  the minimum is tied. A tie must not be broken by iteration order — refusing
 *  is the only answer that cannot mis-bind. */
function uniqueNearest(from: GeometrySnapshot, to: readonly GeometrySnapshot[]): number {
  let best = -1, bestD = Infinity, tied = false
  for (let i = 0; i < to.length; i++) {
    const d = centroidD2(from, to[i])
    if (d < bestD - 1e-12) { bestD = d; best = i; tied = false }
    else if (Math.abs(d - bestD) <= 1e-12) tied = true
  }
  return tied ? -1 : best
}

/**
 * Bind every result face to at most one original id, and every original id to at
 * most one result face. Order-independent: the exact pass is keyed, and the
 * fallback's mutual-nearest relation is symmetric, so the same (origs, probes)
 * sets always produce the same assignment regardless of input order.
 */
export function matchFacesToOriginals(
  origs: readonly OrigFace[],
  probes: readonly FaceProbe[],
): FaceMatchResult {
  const matches: FaceMatch[] = []
  const usedId = new Set<StableId>()
  const usedProbe = new Set<FaceProbe>()
  const refusedOrigIds = new Set<StableId>()
  const refusedProbes = new Set<FaceProbe>()
  const paths: FaceMatchResult['paths'] = {
    exact: 0, planeFallbackUnique: 0, planeFallbackNearest: 0,
    planeFallbackRefused: 0, noHitMint: 0, origLeftoverDelete: 0,
  }
  const bind = (o: OrigFace, p: FaceProbe, path: FaceMatchPath): void => {
    matches.push({ id: o.id, probe: p, origSnap: o.snap, path })
    usedId.add(o.id); usedProbe.add(p)
  }

  // ---- PASS 1: exact full-snapshot key, over EVERY probe, before any fallback.
  // Group BOTH sides by key first (never a streaming last-writer-wins slot, and
  // never a shift() off a sorted queue): a key with exactly one orig and exactly
  // one probe is unambiguous and binds outright. A key with more than one
  // candidate on EITHER side is AMBIGUOUS — every member of that bucket is left
  // unbound here, falling through to pass 2 (plane-support, for planar faces)
  // or straight to mint/delete refusal. Binding an ambiguous bucket by sort or
  // arrival order is exactly the input-order dependency the auditor's repro
  // demonstrated (two distinct planes sharing a key, forward vs reversed probe
  // order swapping which id got which). Grouping-then-checking-cardinality
  // makes the outcome depend only on the (origs, probes) sets, never their order.
  const origByExact = new Map<string, OrigFace[]>()
  for (const o of origs) {
    const k = exactMatchKey(o.snap)
    const bucket = origByExact.get(k)
    if (bucket) bucket.push(o); else origByExact.set(k, [o])
  }
  const probeByExact = new Map<string, FaceProbe[]>()
  for (const p of probes) {
    const k = exactMatchKey(p.snapshot)
    const bucket = probeByExact.get(k)
    if (bucket) bucket.push(p); else probeByExact.set(k, [p])
  }
  for (const [k, os] of origByExact) {
    const ps = probeByExact.get(k)
    if (!ps || ps.length === 0) continue
    if (os.length === 1 && ps.length === 1) {
      bind(os[0], ps[0], 'exact'); paths.exact++
    } else {
      // ambiguous: leave every os/ps member unbound (property 3 — refuse
      // rather than mis-bind); pass 2 and the mint/delete tail pick them up.
      // Mark refusal PROVENANCE (GEO-6X6-R2): a caller that pairs its own
      // leftovers must know these were REFUSED, not merely "no counterpart".
      for (const o of os) refusedOrigIds.add(o.id)
      for (const p of ps) refusedProbes.add(p)
    }
  }

  // ---- PASS 2: plane-support fallback over the REMAINDER only.
  interface Support { origs: OrigFace[]; probes: FaceProbe[] }
  const supports = new Map<string, Support>()
  const support = (k: string): Support => {
    let s = supports.get(k)
    if (!s) { s = { origs: [], probes: [] }; supports.set(k, s) }
    return s
  }
  for (const o of origs) {
    if (usedId.has(o.id)) continue
    const k = planeSupportKey(o.snap)
    if (k) support(k).origs.push(o)
  }
  for (const p of probes) {
    if (usedProbe.has(p)) continue
    const k = planeSupportKey(p.snapshot)
    if (k) support(k).probes.push(p)
  }
  for (const s of supports.values()) {
    if (s.origs.length === 0 || s.probes.length === 0) continue
    if (s.origs.length === 1 && s.probes.length === 1) {
      bind(s.origs[0], s.probes[0], 'plane-fallback-unique'); paths.planeFallbackUnique++
      continue
    }
    // AMBIGUOUS support: more than one leftover original or probe shares this
    // plane. Bind only mutual-nearest-centroid pairs (a rebuilt face's bbox
    // centroid stays put or moves little; a cross-binding never wins both
    // directions), repeating while the relation keeps producing pairs. Whatever
    // survives the rounds is refused — minted + deleted, never mis-bound.
    let o = s.origs, p = s.probes
    for (;;) {
      const oSnaps = o.map((x) => x.snap), pSnaps = p.map((x) => x.snapshot)
      const pick: Array<[OrigFace, FaceProbe]> = []
      for (let i = 0; i < o.length; i++) {
        const j = uniqueNearest(oSnaps[i], pSnaps)
        if (j >= 0 && uniqueNearest(pSnaps[j], oSnaps) === i) pick.push([o[i], p[j]])
      }
      if (pick.length === 0) break
      for (const [oi, pi] of pick) { bind(oi, pi, 'plane-fallback-nearest'); paths.planeFallbackNearest++ }
      o = o.filter((x) => !usedId.has(x.id))
      p = p.filter((x) => !usedProbe.has(x))
      if (o.length === 0 || p.length === 0) break
    }
    paths.planeFallbackRefused += Math.min(o.length, p.length)
    // Whatever survives the mutual-nearest rounds is refused (comment above):
    // mark ALL of it, both sides, not just the min-count used by the census.
    for (const oi of o) refusedOrigIds.add(oi.id)
    for (const pi of p) refusedProbes.add(pi)
  }

  const mintProbes = probes.filter((p) => !usedProbe.has(p))
  const remainingOrig = origs.filter((o) => !usedId.has(o.id))
  paths.noHitMint = mintProbes.length
  paths.origLeftoverDelete = remainingOrig.length
  return { matches, mintProbes, remainingOrig, refusedOrigIds, refusedProbes, paths }
}

/** AND-combine the FeatureQuery predicates against a verdict. */
function matchesFeatureQuery(v: FeatureVerdict, q: FeatureQuery): boolean {
  if (q.removableOnly && !v.removable) return false
  if (q.classes && !q.classes.includes(v.featureClass)) return false
  const num = (key: string): number | undefined => (typeof v.params[key] === 'number' ? (v.params[key] as number) : undefined)
  if (q.maxDiameter !== undefined) { const d = num('diameter'); if (d === undefined || d > q.maxDiameter) return false }
  if (q.maxRadius !== undefined) { const r = num('radius'); if (r === undefined || r > q.maxRadius) return false }
  if (q.maxFaceArea !== undefined) { const a = num('area'); if (a === undefined || a > q.maxFaceArea) return false }
  return true
}

export class GeomEngine {
  #kernel: OcctKernel | null = null
  #wasm: GeomEngineOptions['wasm']
  #bodies = new Map<number, BodyRecord>()
  #nextHandle = 1
  /** WO-2093: largest fillet/chamfer that fits, per body GEOMETRY + edge set.
   *  A preview replays onto a fresh body handle on every keystroke, and each
   *  probe the search makes can throw inside the kernel (WO-1894: caught native
   *  exceptions are not free -- measured, the kernel dies after ~900), so the
   *  answer is found once per shape, not once per handle. Bounded, oldest out. */
  #dressUpFitCache = new Map<string, number>()
  /** WO-2093: failed search probes this engine may still spend. Each costs a
   *  caught kernel exception; with ~900 per worker lifetime (measured), the
   *  search may use at most this share. Spent -> the refusal names no value. */
  #dressUpProbeFailuresLeft = 128
  /** Transient (non-body) shapes currently held mid-op — e.g. the fused tool of
   *  a multi-tool cut. Every entry is released in applyBoolean's finally block on
   *  BOTH the success and throw paths, so this set is empty between ops. Exposed
   *  read-only via debugTransientCount() for the R1.3 leak regression test. */
  #transients = new Set<number>()
  /** TEST-ONLY (GEO-3 R1): a fault injected into #applySweepBoolean right after
   *  the boolean produces its result shape but BEFORE that shape is minted into
   *  a body record — lets a test drive the post-boolean error path and assert
   *  the orphaned result is released (no kernel-handle growth). Null in prod. */
  #sweepFaultAfterBoolean: (() => void) | null = null
  /** WO-1892 test-hook counter - see debugToolLineageCensus(). */
  #toolLineageCensus = { history: 0, geometry: 0, unmatched: 0 }
  /** TEST-ONLY (GEO-6): force the heal of the accepted feature at this SORTED
   *  batch index to fail, so a test can drive the partial-success (BK-45)
   *  9-of-10 machinery deterministically without needing a naturally-unhealable
   *  fixture. Null in prod. */
  #defeatureFault: number | null = null
  /** TEST-ONLY (GEO-10-R1): force the faceOffset/pocketDepth isSolid hard gate to
   *  see a NON-SOLID result, so a test can drive the "non-solid outcome refuses"
   *  path (finding 2) deterministically without manufacturing a valid-but-non-
   *  solid boolean by hand. False in prod. */
  #editNonSolidFaultForTest = false

  /** WO-2171: the ids of relief faces this engine has built (tessellate meshes them by RELIEF_MESH). */
  readonly #reliefFaceIds = new Set<StableId>()
  /** WO-2200: mesh reliefs - the working grid each relief face id is meshed from while it is still its whole rectangle. */
  readonly #reliefDetail = new Map<StableId, { frame: DetailFrame; detail: ReliefDetail }>()

  constructor(opts: GeomEngineOptions = {}) {
    this.#wasm = opts.wasm
  }

  #k(): OcctKernel {
    if (!this.#kernel) throw new Error('GeomEngine.init() has not completed')
    return this.#kernel
  }

  #rec(h: BodyHandle): BodyRecord {
    const r = this.#bodies.get(h as number)
    if (!r) throw new Error(`unknown BodyHandle ${h}`)
    return r
  }

  #mint(record: BodyRecord): BodyHandle {
    const h = this.#nextHandle++
    this.#bodies.set(h, record)
    return h as BodyHandle
  }

  // ---- lifecycle -------------------------------------------------------
  async init(onProgress?: (pct: number, phase: string) => void): Promise<KernelInfo> {
    onProgress?.(2, 'geom:starting')
    onProgress?.(10, 'geom:loading-wasm')
    const kernel = await OcctKernel.init(this.#wasm ? { wasm: this.#wasm } : undefined)
    onProgress?.(70, 'geom:kernel-ready')
    // Ruling #1: explicit adapter wiring, never bare brepjs.init().
    registerKernel('occt-wasm', OcctWasmAdapter.fromKernel(kernel))
    onProgress?.(90, 'geom:adapter-registered')
    this.#kernel = kernel
    onProgress?.(100, 'geom:ready')
    return {
      backend: 'occt-wasm',
      occtVersion: OCCT_VERSION,
      capabilities: { defeature: false, xcaf: true, hlr: true },
    }
  }

  async dispose(handle: BodyHandle): Promise<void> {
    const r = this.#bodies.get(handle as number)
    if (!r) return
    try {
      this.#k().release(r.shape as ShapeHandle)
    } catch { /* already released */ }
    this.#bodies.delete(handle as number)
  }

  async disposeAll(): Promise<void> {
    for (const r of this.#bodies.values()) {
      try {
        this.#k().release(r.shape as ShapeHandle)
      } catch { /* ignore */ }
    }
    this.#bodies.clear()
    this.#dressUpFitCache.clear()
  }

  /**
   * Full deterministic teardown of the kernel itself (GEO-1-R1.1). Releases all
   * bodies + transients, then disposes the underlying occt-wasm kernel via its
   * Symbol.dispose (releaseAll() + delete() of the raw wasm kernel). Call this
   * when the engine is DONE — the Node test suite drives it in afterAll so the
   * emscripten module is torn down deterministically at end-of-file rather than
   * left for the FinalizationRegistry, keeping heavy wasm state from lingering
   * into the vitest worker->main RPC window (defensive against the pre-existing
   * "Timeout calling onTaskUpdate" infra flake; occt-wasm@3.6.1 is single-thread
   * wasm — 0 pthreads — so this cannot leave worker threads alive, but leaving no
   * live kernel is the right hygiene either way). After this the engine must be
   * re-init()'d before reuse.
   */
  async disposeKernel(): Promise<void> {
    // Release everything we still hold before dropping the kernel.
    for (const r of this.#bodies.values()) {
      try { this.#kernel?.release(r.shape as ShapeHandle) } catch { /* ignore */ }
    }
    for (const t of this.#transients) {
      try { this.#kernel?.release(t as ShapeHandle) } catch { /* ignore */ }
    }
    this.#bodies.clear()
    this.#transients.clear()
    const k = this.#kernel
    this.#kernel = null
    if (k) {
      try { k[Symbol.dispose]() } catch { /* already disposed */ }
    }
  }

  // ---- geometry probing ------------------------------------------------
  #probeFace(face: ShapeHandle): FaceProbe {
    const k = this.#k()
    const b = k.getBoundingBox(face, true)
    const centroid: [number, number, number] = [
      (b.xmin + b.xmax) / 2,
      (b.ymin + b.ymax) / 2,
      (b.zmin + b.zmax) / 2,
    ]
    let normal: [number, number, number] = [0, 0, 0]
    let uv: { uMin: number; uMax: number; vMin: number; vMax: number } | undefined
    try {
      uv = k.uvBounds(face)
      const n = k.surfaceNormal(face, (uv.uMin + uv.uMax) / 2, (uv.vMin + uv.vMax) / 2)
      normal = [n.x, n.y, n.z]
    } catch { /* normal best-effort */ }
    const kind = toFaceKind(k.surfaceType(face))
    // GEO-3 BK-14: axial faces (cylinder/cone/torus) get their ANALYTIC axis of
    // revolution by sampling THREE points along a latitude circle (same V,
    // three well-separated U) and taking that circle's plane normal. A
    // cylinder/cone/torus latitude circle lies in a plane perpendicular to the
    // axis, so its normal is exactly the axis — correct for cones and tori too,
    // unlike the GEO-2 two-surface-normal cross product (which was only valid
    // for cylinders, whose normals are purely radial). Best-effort: degrades to
    // "axis absent" if the sample degenerates rather than a wrong direction.
    let axis: [number, number, number] | undefined
    let axisPoint: [number, number, number] | undefined
    let radius: number | undefined
    if (uv && AXIAL_KINDS.has(kind)) {
      try {
        const vMid = (uv.vMin + uv.vMax) / 2
        const uSpan = uv.uMax - uv.uMin
        const wide = uSpan > 1e-9
        const uA = uv.uMin + (wide ? uSpan / 6 : (Math.PI * 2) / 6)
        const uB = uv.uMin + (wide ? uSpan / 2 : (Math.PI * 2) / 2)
        const uC = uv.uMin + (wide ? (uSpan * 5) / 6 : (Math.PI * 2 * 5) / 6)
        const q0 = k.pointOnSurface(face, uA, vMid)
        const q1 = k.pointOnSurface(face, uB, vMid)
        const q2 = k.pointOnSurface(face, uC, vMid)
        axis = axisFromThreeCirclePoints(
          [q0.x, q0.y, q0.z], [q1.x, q1.y, q1.z], [q2.x, q2.y, q2.z],
        )
        if (kind === 'cylinder' && axis) {
          const center = circleCenter(
            [q0.x, q0.y, q0.z], [q1.x, q1.y, q1.z], [q2.x, q2.y, q2.z],
          )
          const kernelRadius = k.getFaceCylinderData(face)?.radius
          const sampledRadius = center ? len(sub([q0.x, q0.y, q0.z], center)) : NaN
          const radiusTol = Number.isFinite(kernelRadius)
            ? Math.max(1e-6, Math.abs(kernelRadius as number) * 1e-5)
            : 0
          if (
            center &&
            Number.isFinite(kernelRadius) &&
            (kernelRadius as number) > 0 &&
            Number.isFinite(sampledRadius) &&
            Math.abs(sampledRadius - (kernelRadius as number)) <= radiusTol
          ) {
            axisPoint = center
            radius = kernelRadius
          }
        }
      } catch { /* axis best-effort */ }
    }
    const snapshot: GeometrySnapshot = {
      type: kind,
      centroid,
      normal,
      area: k.getSurfaceArea(face),
      ...(axis ? { axis } : {}),
      ...(axisPoint ? { axisPoint } : {}),
      ...(radius !== undefined ? { radius } : {}),
    }
    return { hash: k.hashCode(face, HM), snapshot }
  }

  #bodyBBox(shape: ShapeHandle): BBox {
    const b = this.#k().getBoundingBox(shape, false)
    return { min: [b.xmin, b.ymin, b.zmin], max: [b.xmax, b.ymax, b.zmax] }
  }

  /** GEO-2-R1.3: getSubShapes('face') mints one caller-owned ShapeHandle per
   *  face; #probeFace only needs each handle transiently (hash + snapshot are
   *  pure-data extracts). Release every face handle once probed, on BOTH the
   *  success and throw paths (GEO-1-R1.3 #transients finally-release
   *  precedent) — otherwise every #faceProbes call (makeBox, applyBoolean,
   *  importStep, restoreBody) leaks one kernel shape per face forever. */
  #faceProbes(shape: ShapeHandle): FaceProbe[] {
    const k = this.#k()
    const faces = k.getSubShapes(shape, 'face')
    try {
      return faces.map((f) => this.#probeFace(f))
    } finally {
      for (const f of faces) {
        try { k.release(f) } catch { /* already released */ }
      }
    }
  }

  // ---- creation --------------------------------------------------------
  async makeBox(featureId: string, size: Vec3): Promise<OpResult> {
    const k = this.#k()
    const shape = k.makeBox(size.x, size.y, size.z)
    const probes = this.#faceProbes(shape)
    const { faceMap, snapshots } = assignBoxFaceIds(featureId, probes, this.#bodyBBox(shape))
    const handle = this.#mint({ shape: shape as number, faceMap, snapshots })
    const geometry: Record<StableId, ContractGeometrySnapshot> = {}
    for (const [id, snap] of snapshots) geometry[id] = toContractGeometry(snap)
    return {
      ok: k.isValid(shape),
      body: handle,
      elementMap: {
        featureId,
        modified: {},
        generated: [...snapshots.keys()],
        deleted: [],
        geometry,
      },
      diagnostics: k.isValid(shape) ? okDiag() : [{ code: 'INVALID_RESULT', severity: 'error' }],
    }
  }

  // ---- prismatic mesh->brep bridge (v0.4, MSH-3) ----------------------
  /** Rebuild + sew a PlanarFaceSet (from the mesh lane's prismatic converter)
   *  into a solid. All logic + wasm-handle lifecycle lives in prismaticBuild.ts
   *  (MSH-3's one GEO-side file); this just wires the engine's release-safe
   *  helpers to it. */
  async makeSolidFromPlanarFaces(req: PlanarFaceSet): Promise<OpResult> {
    return buildSolidFromPlanarFaces(
      {
        k: () => this.#k(),
        mint: (rec) => this.#mint(rec),
        faceProbes: (shape) => this.#faceProbes(shape),
        toContractGeom: (snap) => toContractGeometry(snap),
      },
      req,
    )
  }

  // ---- booleans -------------------------------------------------------
  async applyBoolean(req: BooleanRequest): Promise<OpResult> {
    const k = this.#k()
    const target = this.#rec(req.target)
    // NON-MUTATING validation-failure path: elementMap omitted by design (see
    // the ruling-3 note above).
    if (req.tools.length === 0) {
      return { ok: false, diagnostics: [{ code: 'KERNEL_OP_FAILED', severity: 'error', params: { reason: `${req.op} requires at least one tool` } }] }
    }

    // Fold multiple tools into one so the op emits a single clean delta. Each
    // k.fuse() mints a NEW transient shape that is NOT a #bodies record and so is
    // never reached by dispose/disposeAll; we track every fused intermediate and
    // release them in the finally below — on the success AND the throw paths —
    // so a multi-tool cut can never leak kernel shapes (GEO-1-R1.3).
    let toolShape = this.#rec(req.tools[0]).shape as ShapeHandle
    let unownedResult: ShapeHandle | undefined
    const booleanScratch: ShapeHandle[] = []
    try {
      for (let i = 1; i < req.tools.length; i++) {
        const fused = k.fuse(toolShape, this.#rec(req.tools[i]).shape as ShapeHandle)
        this.#transients.add(fused as number)
        toolShape = fused
      }

      const inputHashes = [...target.faceMap.keys()]
      const evo = req.op === 'cut'
        ? k.cutWithHistory(target.shape as ShapeHandle, toolShape, inputHashes, HM)
        : req.op === 'fuse'
          ? k.fuseWithHistory(target.shape as ShapeHandle, toolShape, inputHashes, HM)
          : k.intersectWithHistory(target.shape as ShapeHandle, toolShape, inputHashes, HM)
      let resultShape = evo.result
      unownedResult = resultShape

      // Union of disjoint bodies is a compound, and intersection of disjoint
      // bodies is empty. Neither is a usable single-body Boolean result. Keep
      // cut's established acceptance unchanged, but require the newly exposed
      // operations to produce one valid positive-volume solid.
      if (req.op !== 'cut') {
        const volume = k.getVolume(resultShape)
        if (!k.isValid(resultShape) || !Number.isFinite(volume) || volume <= 1e-12) {
          return {
            ok: false,
            diagnostics: [{
              code: 'KERNEL_OP_FAILED',
              severity: 'error',
              params: { op: req.op, reason: 'boolean result is not valid positive-volume geometry' },
            }],
          }
        }
        const solidified = this.#asSingleSolid(resultShape, booleanScratch)
        if (!solidified.ok || solidified.shape === undefined) {
          return {
            ok: false,
            diagnostics: [{
              code: 'KERNEL_OP_FAILED',
              severity: 'error',
              params: { op: req.op, reason: `boolean result is not one closed solid: ${solidified.reason ?? 'unknown shape'}` },
            }],
          }
        }
        resultShape = solidified.shape
        unownedResult = resultShape
      }

      const records = decodeEvolution(evo.modified)
      const resultFaces = this.#faceProbes(resultShape)
      const opCode = req.op === 'cut' ? 'CUT' : req.op === 'fuse' ? 'FUS' : 'INT'
      const assign = assignCutFaceIds(req.featureId, target.faceMap, records, resultFaces, target.aliases, opCode)
      const handle = this.#mint({ shape: resultShape as number, faceMap: assign.faceMap, snapshots: assign.snapshots , aliases: target.aliases })
      unownedResult = undefined

      const valid = k.isValid(resultShape)
      // ICR-1 inline geometry: snapshots for every id NAMED in this delta.
      // Generated + modified children get their POST-op geometry (the result
      // body's own snapshots); modified parents + deleted ids get their
      // PRE-op geometry (target.snapshots — the only place it still exists,
      // since the parent face itself no longer survives in the result).
      const geometry: Record<StableId, ContractGeometrySnapshot> = {}
      for (const id of assign.generated) {
        const s = assign.snapshots.get(id)
        if (s) geometry[id] = toContractGeometry(s)
      }
      for (const [parent, children] of Object.entries(assign.modified)) {
        const parentSnap = target.snapshots.get(parent)
        if (parentSnap) geometry[parent] = toContractGeometry(parentSnap)
        for (const child of children) {
          const s = assign.snapshots.get(child)
          if (s) geometry[child] = toContractGeometry(s)
        }
      }
      for (const id of assign.deleted) {
        const parentSnap = target.snapshots.get(id)
        if (parentSnap) geometry[id] = toContractGeometry(parentSnap)
      }
      // GEO-2-R1.4 (surfaced by the restore-body strict-skip regression
      // test): a target face the cut left ENTIRELY UNTOUCHED keeps its
      // original id (assigned by assignCutFaceIds step 1, "unchanged faces
      // keep their ID") but is never a key of `modified`, `generated`, or
      // `deleted` -- so it silently fell out of the inline geometry map
      // above even though assign.snapshots (and the result body's own
      // faceMap) both still carry it live. restoreBody's geometric rebind
      // then had no inline snapshot to match it against, and its degraded
      // centroid/lexical fallback did not always recover it either -- a
      // real partial-rebind gap, not just a weak test. Emit geometry for
      // every id the target ever named that survived into the result,
      // regardless of whether THIS cut modified it.
      for (const id of target.faceMap.values()) {
        if (geometry[id] !== undefined) continue
        const s = assign.snapshots.get(id)
        if (s) geometry[id] = toContractGeometry(s)
      }
      return {
        ok: valid,
        body: handle,
        elementMap: {
          featureId: req.featureId,
          modified: assign.modified,
          generated: assign.generated,
          deleted: assign.deleted,
          geometry,
        },
        diagnostics: valid ? okDiag() : [{ code: 'INVALID_RESULT', severity: 'error', params: { op: req.op } }],
      }
    } catch (e) {
      // NON-MUTATING kernel-failure path (the boolean threw before any body was
      // minted): elementMap omitted by design (ruling 3). The finally releases
      // any transients created before the throw.
      return {
        ok: false,
        diagnostics: [{ code: 'KERNEL_OP_FAILED', severity: 'error', params: { op: req.op, message: (e instanceof Error ? e.message : String(e)).slice(0, 200) } }],
      }
    } finally {
      if (unownedResult !== undefined) {
        try {
          k.release(unownedResult)
        } catch { /* already released */ }
      }
      for (const shape of booleanScratch) {
        try {
          k.release(shape)
        } catch { /* already released */ }
      }
      for (const t of this.#transients) {
        try {
          this.#k().release(t as ShapeHandle)
        } catch { /* already released */ }
      }
      this.#transients.clear()
    }
  }

  /** TEST HOOK (GEO-1-R1.3): number of transient (non-body) shapes the engine is
   *  currently holding. Always 0 between ops — applyBoolean releases every fused
   *  transient in a finally on both the success and throw paths. */
  debugTransientCount(): number {
    return this.#transients.size
  }

  /** TEST HOOK (GEO-1-R1.3): live shape count in the kernel (occt-wasm's
   *  shapeCount getter). Proves a multi-tool cut leaks NO kernel shapes — after
   *  disposing every body the count returns to the pre-op baseline; a skipped
   *  transient release would leave it higher. */
  debugKernelShapeCount(): number {
    return this.#k().shapeCount
  }

  /** TEST HOOK (WO-1892): how the LAST tool-lineage relabel named the boolean's
   *  new walls - `history` counts walls the KERNEL's own record named,
   *  `geometry` counts walls that fell back to the nearest-centroid match, and
   *  `unmatched` counts walls neither could name (they keep their
   *  `<fid>:CUT:new#k` fragment id). A test asserting `history > 0` proves the
   *  kernel record was really consulted rather than the fallback agreeing with
   *  it by luck. NOT part of the frozen contract. */
  debugToolLineageCensus(): { history: number; geometry: number; unmatched: number } {
    return { ...this.#toolLineageCensus }
  }

  /** TEST HOOK (GEO-3 R1): install (or clear, with null) a fault that fires
   *  inside #applySweepBoolean immediately after the boolean produces its result
   *  shape but before that shape is minted — so a test can drive the
   *  post-boolean error path and assert the orphaned result is released (no
   *  kernel-handle growth). NOT part of the frozen contract. */
  debugSetSweepFaultAfterBoolean(fn: (() => void) | null): void {
    this.#sweepFaultAfterBoolean = fn
  }

  /** TEST HOOK (GEO-10-R1 finding 2): when set, the faceOffset/pocketDepth
   *  isSolid hard gate treats the boolean result as NON-SOLID, so a test can
   *  prove a non-solid outcome REFUSES (structured) rather than succeeds. NOT
   *  part of the frozen contract. */
  debugSetEditNonSolidFault(on: boolean): void {
    this.#editNonSolidFaultForTest = on
  }

  /**
   * TEST HOOK (GEO-6X6-R2): drive the REAL, UNCHANGED pass-3 consumer —
   * #assignEditedIds together with the real #pairByOffset / #pairByRole it is
   * called with in production — against a synthetic (original, final-probe)
   * pair. Exists because the auditor's major (exact-duplicate faces re-bound
   * after the matcher refused them) can only be regression-tested by
   * constructing an exact-duplicate face pair, which cannot exist on a real
   * occt solid: two faces sharing one identical centroid+area+normal is
   * degenerate/non-manifold topology, not a buildable body — on EITHER the
   * original or the final side. `origEntries` and `finalProbes` stand in for
   * the original body's faceMap/snapshots and the edited body's post-op face
   * set; only their content reaches the matcher (#assignEditedIds no longer
   * dereferences a kernel shape — see the R2 refactor moving #faceProbes to
   * the two real call sites). NOT part of the frozen contract; this is the
   * committed form of the auditor's scratch diagnostic, calling the
   * production private methods directly rather than re-deriving their logic.
   */
  debugAssignEditedIdsForTest(
    origEntries: Array<{ id: StableId; snap: GeometrySnapshot }>,
    finalProbes: FaceProbe[], fid: string,
    kind: 'faceOffset' | 'holeDiameter', axis?: Vec3T,
  ): {
    ok: true
    faceMap: Map<number, StableId>; snapshots: Map<StableId, GeometrySnapshot>
    modified: Record<StableId, StableId[]>; generated: StableId[]; deleted: StableId[]
    geometry: Record<StableId, ContractGeometrySnapshot>
  } | { ok: false; reason: string } {
    const faceMap = new Map<number, StableId>()
    const snapshots = new Map<StableId, GeometrySnapshot>()
    origEntries.forEach((o, i) => { faceMap.set(-1_000_000 - i, o.id); snapshots.set(o.id, o.snap) })
    const rec: BodyRecord = { shape: 0, faceMap, snapshots }
    const pairRemaining = kind === 'faceOffset'
      ? (remOrig: Array<{ id: StableId; snap: GeometrySnapshot }>, probes: FaceProbe[]) => this.#pairByOffset(remOrig, probes)
      : (remOrig: Array<{ id: StableId; snap: GeometrySnapshot }>, probes: FaceProbe[]) => this.#pairByRole(remOrig, probes, axis ?? [0, 0, 1])
    return this.#assignEditedIds(rec, finalProbes, fid, pairRemaining)
  }

  /** TEST HOOK (GEO-2 BK-10b): mint a Z-axis cylinder body purely so tests have
   *  a body with an exact-length-checkable circular edge (radius r -> 2*pi*r)
   *  and an axial face to exercise the axis probe. NOT part of the frozen
   *  contract — cylinder creation is explicitly out of Stage-1 scope per
   *  geom-service.ts's own "[Stage 1: box only, for tests]" comment; this
   *  reuses the box ID-assignment helper only to get a valid, disposable body
   *  record, not to claim spec-conformant cylinder stable IDs. */
  async debugMakeCylinder(featureId: string, radius: number, height: number): Promise<OpResult> {
    const k = this.#k()
    const shape = k.makeCylinder(radius, height)
    const probes = this.#faceProbes(shape)
    const { faceMap, snapshots } = assignBoxFaceIds(featureId, probes, this.#bodyBBox(shape))
    const handle = this.#mint({ shape: shape as number, faceMap, snapshots })
    const geometry: Record<StableId, ContractGeometrySnapshot> = {}
    for (const [id, snap] of snapshots) geometry[id] = toContractGeometry(snap)
    return {
      ok: k.isValid(shape),
      body: handle,
      elementMap: { featureId, modified: {}, generated: [...snapshots.keys()], deleted: [], geometry },
      diagnostics: k.isValid(shape) ? okDiag() : [{ code: 'INVALID_RESULT', severity: 'error' }],
    }
  }

  /** TEST HOOK (GEO-2-R1.1): mint a Z-axis TRUNCATED CONE body (r1 != r2) so
   *  tests can exercise the axis probe on a genuinely conical face -- the
   *  R1.1 fix (emit axis only when surfaceType==='cylinder') needs a real
   *  cone snapshot to prove `axis` comes back undefined rather than the old
   *  analytically-wrong cross(surfaceNormal(u0), surfaceNormal(u1)) value
   *  (cone normals tilt toward the apex by the half-angle, so that
   *  cross-product is NOT the cone's axis). NOT part of the frozen contract
   *  -- cone creation is out of Stage-1 scope, same rationale as
   *  debugMakeCylinder above; reuses the box ID-assignment helper only to
   *  get a valid, disposable body record. */
  async debugMakeCone(featureId: string, r1: number, r2: number, height: number): Promise<OpResult> {
    const k = this.#k()
    const shape = k.makeCone(r1, r2, height)
    const probes = this.#faceProbes(shape)
    const { faceMap, snapshots } = assignBoxFaceIds(featureId, probes, this.#bodyBBox(shape))
    const handle = this.#mint({ shape: shape as number, faceMap, snapshots })
    const geometry: Record<StableId, ContractGeometrySnapshot> = {}
    for (const [id, snap] of snapshots) geometry[id] = toContractGeometry(snap)
    return {
      ok: k.isValid(shape),
      body: handle,
      elementMap: { featureId, modified: {}, generated: [...snapshots.keys()], deleted: [], geometry },
      diagnostics: k.isValid(shape) ? okDiag() : [{ code: 'INVALID_RESULT', severity: 'error' }],
    }
  }

  /** TEST HOOK (GEO-3 BK-14): mint a Z-axis TORUS body so tests can exercise
   *  the analytic axis probe on a genuinely toroidal face. NOT part of the
   *  frozen contract — torus creation is out of scope; reuses the box
   *  ID-assignment helper only to get a valid, disposable body record. */
  async debugMakeTorus(featureId: string, majorRadius: number, minorRadius: number): Promise<OpResult> {
    const k = this.#k()
    const shape = k.makeTorus(majorRadius, minorRadius)
    const probes = this.#faceProbes(shape)
    const { faceMap, snapshots } = assignBoxFaceIds(featureId, probes, this.#bodyBBox(shape))
    const handle = this.#mint({ shape: shape as number, faceMap, snapshots })
    const geometry: Record<StableId, ContractGeometrySnapshot> = {}
    for (const [id, snap] of snapshots) geometry[id] = toContractGeometry(snap)
    return {
      ok: k.isValid(shape),
      body: handle,
      elementMap: { featureId, modified: {}, generated: [...snapshots.keys()], deleted: [], geometry },
      diagnostics: k.isValid(shape) ? okDiag() : [{ code: 'INVALID_RESULT', severity: 'error' }],
    }
  }

  // ---- sweep features (extrude / revolve) — GEO-3 ----------------------
  //
  // Extrude/revolve have NO kernel history (BRepPrimAPI_MakePrism / MakeRevol
  // expose no *WithHistory variant — STAGE0_FINDINGS). Per stable-id-spec.md,
  // lineage is CONSTRUCTED, not queried: we own the profile, so each result
  // side/surf face is matched BY GEOMETRY (not kernel enumeration order) to the
  // sketch entity that generated it, via a representative point that lies on
  // exactly that generated face. Determinism: the ID strings are pure functions
  // of srcId/sketchId + a geometric sort, never the kernel's ephemeral hashes.

  /**
   * Build the profile face (outer loop + holes) from a ProfileRegion, lifting
   * 2D sketch-plane coords to 3D via the plane basis. Every intermediate kernel
   * handle (edges, wires, the un-holed face) is pushed to `scratch` so the
   * caller releases them on BOTH the success and error paths (GEO-1-R1.3
   * finally-release precedent). Returns the final (possibly holed) face handle,
   * also in `scratch`. Throws OPEN_PROFILE-worthy errors on a degenerate profile.
   */
  #buildProfileFace(profile: ProfileRegion, basis: PlaneBasis, scratch: ShapeHandle[]): ShapeHandle {
    const k = this.#k()
    if (profile.loops.length === 0 || profile.loops[0].length === 0) {
      throw new Error('profile has no outer loop')
    }
    const P = (v: Vec3T) => ({ x: v[0], y: v[1], z: v[2] })
    const buildLoopWire = (loop: ProfileRegion['loops'][number]): ShapeHandle => {
      if (loop.length === 0) throw new Error('empty profile loop')
      const edges: ShapeHandle[] = []
      for (const seg of loop) {
        let edge: ShapeHandle
        if (seg.kind === 'line') {
          edge = k.makeLineEdge(P(lift(basis, seg.a)), P(lift(basis, seg.b)))
        } else if (Math.abs(seg.a1 - seg.a0) >= Math.PI * 2 - 1e-6) {
          // full circle: unambiguous, no angle-reference dependence.
          edge = k.makeCircleEdge(P(lift(basis, seg.c)), P(basis.normal), seg.r)
        } else {
          // partial arc: build from 3 lifted points (start/mid/end) so we never
          // depend on OCCT's auto-chosen X-reference for makeCircleArc angles.
          let sweep = seg.a1 - seg.a0
          if (seg.ccw && sweep <= 0) sweep += Math.PI * 2
          if (!seg.ccw && sweep >= 0) sweep -= Math.PI * 2
          const at = (t: number): Vec3T => lift(basis, [seg.c[0] + seg.r * Math.cos(t), seg.c[1] + seg.r * Math.sin(t)])
          edge = k.makeArcEdge(P(at(seg.a0)), P(at(seg.a0 + sweep / 2)), P(at(seg.a1)))
        }
        scratch.push(edge)
        edges.push(edge)
      }
      const wire = k.makeWire(edges)
      scratch.push(wire)
      return wire
    }
    const outerWire = buildLoopWire(profile.loops[0])
    let face = k.makeFace(outerWire)
    scratch.push(face)
    if (profile.loops.length > 1) {
      const holeWires = profile.loops.slice(1).map(buildLoopWire)
      const holed = k.addHolesInFace(face, holeWires)
      scratch.push(holed)
      face = holed
    }
    return face
  }

  /** Representative 3D point per profile segment: a point that lies on the
   *  interior of exactly the face that segment generates (lifted 2D midpoint,
   *  moved by `place`). For extrude `place` shifts to the swept-face center;
   *  for revolve it rotates about the axis by half the sweep angle. */
  #segReps(profile: ProfileRegion, basis: PlaneBasis, place: (mid: Vec3T) => Vec3T): Array<{ srcId: string; rep: Vec3T }> {
    const out: Array<{ srcId: string; rep: Vec3T }> = []
    for (const loop of profile.loops) {
      for (const seg of loop) {
        out.push({ srcId: seg.srcId, rep: place(lift(basis, segRep2d(seg))) })
      }
    }
    return out
  }

  /** Diagonal of a shape's AABB (relative tolerances for lineage matching). */
  #diagOf(shape: ShapeHandle): number {
    const b = this.#bodyBBox(shape)
    return Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) || 1
  }

  /**
   * Assign CONSTRUCTED lineage to every face of a swept solid. Each face is
   * matched to the profile segment whose representative point lies on it
   * (projectPointOnFace distance ~ 0); faces near NO segment are caps (the
   * profile swept 0-width at the two angular/linear ends). Side faces sharing a
   * srcId (e.g. a periodic cylinder the kernel split at its seam) get a
   * deterministic `#j` centroid-ordered disambig; the common one-face case
   * stays clean (`<F>:XTR:<srcId>:side`). Returns faceMap/snapshots/generated.
   */
  #assignSweptFaceIds(
    resultShape: ShapeHandle,
    params: SweepLineageParams,
  ): { faceMap: Map<number, StableId>; snapshots: Map<StableId, GeometrySnapshot>; generated: StableId[] } {
    const k = this.#k()
    const faces = k.getSubShapes(resultShape, 'face')
    try {
      const tol = Math.max(1e-4, this.#diagOf(resultShape) * 0.01)
      const sides = new Map<string, FaceProbe[]>()
      const caps: FaceProbe[] = []
      faces.forEach((f) => {
        const probe = this.#probeFace(f)
        // Primary cap signal (XTR): planar face whose normal ∥ extrude dir.
        if (params.mode === 'XTR' && params.capNormalRef && probe.snapshot.type === 'plane') {
          const n = probe.snapshot.normal
          if (Math.abs(dot(n as Vec3T, params.capNormalRef)) > 0.99) { caps.push(probe); return }
        }
        let bestSeg = -1
        let bestDist = Infinity
        for (let s = 0; s < params.segReps.length; s++) {
          const rp = params.segReps[s].rep
          const cp = k.projectPointOnFace(f, { x: rp[0], y: rp[1], z: rp[2] })
          const d = Math.hypot(cp.x - rp[0], cp.y - rp[1], cp.z - rp[2])
          if (d < bestDist) { bestDist = d; bestSeg = s }
        }
        if (bestSeg >= 0 && bestDist <= tol) {
          const srcId = params.segReps[bestSeg].srcId
          const arr = sides.get(srcId) ?? []
          arr.push(probe)
          sides.set(srcId, arr)
        } else {
          caps.push(probe)
        }
      })

      const faceMap = new Map<number, StableId>()
      const snapshots = new Map<StableId, GeometrySnapshot>()
      const generated: StableId[] = []
      const idFor = (srcId: string): string =>
        params.mode === 'XTR' ? extrudeSideId(params.featureId, srcId) : revolveSurfId(params.featureId, srcId)
      for (const [srcId, arr] of sides) {
        const sorted = [...arr].sort((a, b) => compareSnapshots(a.snapshot, b.snapshot))
        const base = idFor(srcId)
        sorted.forEach((p, j) => {
          const id: StableId = sorted.length === 1 ? base : `${base}#${j}`
          faceMap.set(p.hash, id)
          snapshots.set(id, p.snapshot)
          generated.push(id)
        })
      }
      const sortedCaps = [...caps].sort((a, b) => params.capScore(a.snapshot.centroid) - params.capScore(b.snapshot.centroid))
      sortedCaps.forEach((p, idx) => {
        const which: 'start' | 'end' = idx === 0 ? 'start' : 'end'
        let id: StableId = params.mode === 'XTR'
          ? extrudeCapId(params.featureId, params.sketchId, which)
          : revolveCapId(params.featureId, params.sketchId, which)
        if (idx > 1) id = `${id}#${idx}` // defensive: >2 caps is unexpected
        faceMap.set(p.hash, id)
        snapshots.set(id, p.snapshot)
        generated.push(id)
      })
      generated.sort()
      return { faceMap, snapshots, generated }
    } finally {
      for (const f of faces) {
        try { k.release(f) } catch { /* already released */ }
      }
    }
  }

  /**
   * WO-1892: the kernel's OWN record of which tool face became which result
   * wall, keyed by result-face hash. Built from a boolean's evolution channels
   * (`modified` for a retrimmed/split tool wall, `generated` for one the op
   * spawned, plus the hash-preserved wall that gets no record at all).
   *
   * This is only trustworthy on a kernel whose booleans run
   * `SetNonDestructive(true)`: the argument-taking OCCT constructors rewrite
   * their input shapes IN PLACE, so on the old kernel a tool face hash taken
   * before `Build()` named a shape the boolean had already replaced, and the
   * record pointed at faces that never existed (the "unreliable" note in
   * stable-id.ts). `buildToolLineageFromHistory` therefore returns an EMPTY map
   * on a kernel that reports nothing, and every caller falls back to the
   * geometric match — the behaviour before this order.
   */
  #buildToolLineageFromHistory(
    toolFaceMap: Map<number, StableId>,
    toolRecords: EvolutionRecord[],
    resultFaces: FaceProbe[],
  ): Map<number, StableId> {
    const byResultHash = new Map<number, StableId>()
    const resultByHash = new Map<number, FaceProbe>()
    for (const rf of resultFaces) resultByHash.set(rf.hash, rf)

    // A tool wall the boolean did not have to retrim keeps its own hash.
    for (const [hash, id] of toolFaceMap) {
      if (resultByHash.has(hash)) byResultHash.set(hash, id)
    }

    for (const rec of toolRecords) {
      const toolId = toolFaceMap.get(rec.inHash)
      if (toolId === undefined) continue
      const outs = rec.outHashes
        .filter((h) => resultByHash.has(h))
        .map((h) => resultByHash.get(h)!)
      if (outs.length === 0) continue
      if (outs.length === 1) {
        byResultHash.set(outs[0].hash, toolId)
        continue
      }
      // The tool wall arrived in the result as several fragments. Same `#j`
      // convention a split target face uses, so the names stay predictable.
      const sorted = [...outs].sort((a, b) => compareSnapshots(a.snapshot, b.snapshot))
      sorted.forEach((o, j) => byResultHash.set(o.hash, `${toolId}#${j}` as StableId))
    }
    return byResultHash
  }

  /**
   * Relabel the NEW faces of a boolean (the tool walls the op created) with the
   * TOOL's constructed sweep lineage, so a cut/add/intersect cavity wall carries
   * its generating `XTR/REV` id instead of an anonymous `:CUT:new#k`.
   *
   * WO-1892: when the kernel reports which tool face became which result wall,
   * that record wins — the binding is the op's own, not a guess. It is what
   * keeps a pocket wall bound to the sketch segment that drew it when the
   * sketch is re-dimensioned and every centroid moves. Anything the record does
   * not cover falls back to the previous best-effort geometric match (same
   * surfaceType, nearest centroid within tolerance); any new face with no
   * unique tool match keeps its boolean-fragment id — never a silent wrong-bind.
   */
  #relabelWithToolLineage(
    assign: { faceMap: Map<number, StableId>; snapshots: Map<StableId, GeometrySnapshot>; generated: StableId[] },
    toolSnapshots: Map<StableId, GeometrySnapshot>,
    bboxDiag: number,
    fromHistory?: Map<number, StableId>,
  ): void {
    const tol = Math.max(1e-4, bboxDiag * 0.02)
    const idToHash = new Map<StableId, number>()
    for (const [hash, id] of assign.faceMap) idToHash.set(id, hash)
    const usedTool = new Set<StableId>()
    const nextGenerated: StableId[] = []
    this.#toolLineageCensus = { history: 0, geometry: 0, unmatched: 0 }
    // Kernel-derived bindings are claimed FIRST, so a later geometric match can
    // never steal a tool id the op itself already spent.
    if (fromHistory) {
      for (const genId of assign.generated) {
        const hash = idToHash.get(genId)
        if (hash === undefined) continue
        const named = fromHistory.get(hash)
        if (named === undefined) continue
        usedTool.add(named)
        // A split wall is named `<toolId>#j`; the tool id it came from is spent
        // too, or the geometric pass could hand it to an unrelated face.
        const split = /^(.*)#\d+$/.exec(named)
        if (split) usedTool.add(split[1] as StableId)
      }
    }
    for (const genId of assign.generated) {
      const snap = assign.snapshots.get(genId)
      const hash = idToHash.get(genId)
      if (!snap || hash === undefined) { nextGenerated.push(genId); continue }
      const named = fromHistory?.get(hash)
      if (named !== undefined) {
        if (named !== genId) {
          assign.faceMap.set(hash, named)
          assign.snapshots.delete(genId)
          assign.snapshots.set(named, snap)
        }
        nextGenerated.push(named)
        this.#toolLineageCensus.history++
        continue
      }
      let best: StableId | undefined
      let bestDist = Infinity
      for (const [tid, tsnap] of toolSnapshots) {
        if (usedTool.has(tid) || tsnap.type !== snap.type) continue
        const d = Math.hypot(
          tsnap.centroid[0] - snap.centroid[0],
          tsnap.centroid[1] - snap.centroid[1],
          tsnap.centroid[2] - snap.centroid[2],
        )
        if (d <= tol && d < bestDist) { bestDist = d; best = tid }
      }
      if (best !== undefined && best !== genId) {
        usedTool.add(best)
        assign.faceMap.set(hash, best)
        assign.snapshots.delete(genId)
        assign.snapshots.set(best, snap)
        nextGenerated.push(best)
        this.#toolLineageCensus.geometry++
      } else {
        nextGenerated.push(genId)
        this.#toolLineageCensus.unmatched++
      }
    }
    assign.generated = nextGenerated
  }

  /** Build the inline `geometry` map (ICR-1) for a boolean-with-sweep delta:
   *  post-op snapshots for generated + modified children; pre-op (target)
   *  snapshots for modified parents + deleted; plus untouched target survivors
   *  (GEO-2-R1.4). Mirrors applyBoolean's inline-geometry block. */
  #sweepBooleanGeometry(
    assign: { snapshots: Map<StableId, GeometrySnapshot>; generated: StableId[]; modified: Record<StableId, StableId[]>; deleted: StableId[]; faceMap: Map<number, StableId> },
    target: BodyRecord,
  ): Record<StableId, ContractGeometrySnapshot> {
    const geometry: Record<StableId, ContractGeometrySnapshot> = {}
    for (const id of assign.generated) {
      const s = assign.snapshots.get(id)
      if (s) geometry[id] = toContractGeometry(s)
    }
    for (const [parent, children] of Object.entries(assign.modified)) {
      const ps = target.snapshots.get(parent)
      if (ps) geometry[parent] = toContractGeometry(ps)
      for (const c of children) {
        const s = assign.snapshots.get(c)
        if (s) geometry[c] = toContractGeometry(s)
      }
    }
    for (const id of assign.deleted) {
      const ps = target.snapshots.get(id)
      if (ps) geometry[id] = toContractGeometry(ps)
    }
    for (const id of target.faceMap.values()) {
      if (geometry[id] !== undefined) continue
      const s = assign.snapshots.get(id)
      if (s) geometry[id] = toContractGeometry(s)
    }
    return geometry
  }

  #extrudeTargetFailure(reason: string, code: 'KERNEL_OP_FAILED' | 'REFERENCE_UNRESOLVED' = 'KERNEL_OP_FAILED'): ExtrudeTerminalResult {
    return { ok: false, code, reason }
  }

  #offsetExtrudeTerminal(
    label: string,
    hit: number,
    offset: number,
    targets: ExtrudeEndTargetIdentity[],
  ): ExtrudeTerminalResult {
    if (!Number.isFinite(hit) || !(hit > 1e-7)) {
      return this.#extrudeTargetFailure(`${label} is not ahead of the profile in the selected extrusion direction before offset; terminal offset cannot make an ineligible target valid`)
    }
    const distance = hit + offset
    if (!Number.isFinite(distance)) {
      return this.#extrudeTargetFailure(`${label} terminal offset must produce a finite endpoint`)
    }
    if (!(distance > 1e-7)) {
      return this.#extrudeTargetFailure(`${label} is eligible before offset, but the terminal offset crosses the profile plane; reduce or reverse the offset`)
    }
    return { ok: true, terminal: { distance, targets } }
  }

  #validateExtrudeTargetItem(req: ExtrudeRequest, target: ResolvedExtrudeTarget): string | undefined {
    if (req.modelItemId !== undefined && target.identity.modelItemId !== req.modelItemId) {
      return `extrude target '${target.identity.bodyFeatureId}' belongs to Model Item '${target.identity.modelItemId}', not '${req.modelItemId}'`
    }
    if (!this.#bodies.has(target.body as number)) {
      return `extrude target body '${target.identity.bodyFeatureId}' is lost (no live kernel body)`
    }
    return undefined
  }

  #targetStableIds(identity: ExtrudeTargetIdentity, kind: 'face' | 'vertex'): StableId[] | undefined {
    if (identity.subshape?.kind !== kind) return undefined
    return [...new Set([identity.subshape.stableId, ...(identity.subshape.lineage ?? [])])]
  }

  #planarFaceTravel(face: ShapeHandle, origin: Vec3T, dir: Vec3T): number | undefined {
    const k = this.#k()
    if (k.surfaceType(face) !== 'plane') return undefined
    const uv = k.uvBounds(face)
    const p = k.pointOnSurface(face, (uv.uMin + uv.uMax) / 2, (uv.vMin + uv.vMax) / 2)
    const n = normalize((() => {
      const raw = k.surfaceNormal(face, (uv.uMin + uv.uMax) / 2, (uv.vMin + uv.vMax) / 2)
      return [raw.x, raw.y, raw.z] as Vec3T
    })())
    const denom = dot(dir, n)
    if (Math.abs(denom) <= 1e-9) return undefined
    const travel = dot(sub([p.x, p.y, p.z], origin), n) / denom
    return Number.isFinite(travel) ? travel : undefined
  }

  /** Exact trimmed-face overlap for Up to next/part. The profile is translated
   * onto the candidate support plane and intersected with the real B-rep face.
   * Callers sum coplanar faces at the same distance so several faces may
   * together cover and terminate one profile. */
  #faceTerminationArea(profileFace: ShapeHandle, face: ShapeHandle, dir: Vec3T, travel: number): number {
    const k = this.#k()
    let translated: ShapeHandle | undefined
    let overlap: ShapeHandle | undefined
    try {
      translated = k.translate(profileFace, dir[0] * travel, dir[1] * travel, dir[2] * travel)
      overlap = k.common(translated, face)
      const overlapArea = k.getSurfaceArea(overlap)
      return Number.isFinite(overlapArea) ? overlapArea : 0
    } catch {
      return 0
    } finally {
      if (overlap !== undefined) try { k.release(overlap) } catch { /* already released */ }
      if (translated !== undefined) try { k.release(translated) } catch { /* already released */ }
    }
  }

  #selectedFaceTerminal(
    req: ExtrudeRequest,
    origin: Vec3T,
    dir: Vec3T,
    target: ResolvedExtrudeFaceTarget,
    offset: number,
  ): ExtrudeTerminalResult {
    if ('plane' in target) {
      if (req.modelItemId !== undefined && target.identity.modelItemId !== req.modelItemId) {
        return this.#extrudeTargetFailure(
          `extrude datum-plane target '${target.identity.planeFeatureId}' belongs to Model Item '${target.identity.modelItemId}', not '${req.modelItemId}'`,
          'REFERENCE_UNRESOLVED',
        )
      }
      const p = target.plane.origin
      const rawNormal: Vec3T = [target.plane.normal.x, target.plane.normal.y, target.plane.normal.z]
      if (![p.x, p.y, p.z, ...rawNormal].every(Number.isFinite)) {
        return this.#extrudeTargetFailure(`Up to plane target '${target.identity.planeFeatureId}' has an invalid plane definition`, 'REFERENCE_UNRESOLVED')
      }
      const normal = normalize(rawNormal)
      if (dot(normal, normal) <= 1e-12) {
        return this.#extrudeTargetFailure(`Up to plane target '${target.identity.planeFeatureId}' has a zero normal`, 'REFERENCE_UNRESOLVED')
      }
      const denom = dot(dir, normal)
      if (Math.abs(denom) <= 1e-9) {
        return this.#extrudeTargetFailure(`Up to plane target '${target.identity.planeFeatureId}' is parallel to the extrusion direction`)
      }
      const hit = dot(sub([p.x, p.y, p.z], origin), normal) / denom
      return this.#offsetExtrudeTerminal(`Up to plane target '${target.identity.planeFeatureId}'`, hit, offset, [target.identity])
    }
    const itemFailure = this.#validateExtrudeTargetItem(req, target)
    if (itemFailure) return this.#extrudeTargetFailure(itemFailure, 'REFERENCE_UNRESOLVED')
    const wanted = this.#targetStableIds(target.identity, 'face')
    if (!wanted) return this.#extrudeTargetFailure('Up to face requires a stable face target', 'REFERENCE_UNRESOLVED')
    const rec = this.#rec(target.body)
    const roots = new Set(wanted.map((id) => this.#resolveFaceId(rec, id)))
    const k = this.#k()
    const faces = k.getSubShapes(rec.shape as ShapeHandle, 'face')
    try {
      const matches = faces.filter((face) => {
        const id = rec.faceMap.get(k.hashCode(face, HM))
        return id !== undefined && roots.has(id)
      })
      if (matches.length === 0) {
        return this.#extrudeTargetFailure(`Up to face target '${target.identity.subshape!.stableId}' is lost`, 'REFERENCE_UNRESOLVED')
      }
      if (matches.length > 1) {
        return this.#extrudeTargetFailure(`Up to face target '${target.identity.subshape!.stableId}' is ambiguous (${matches.length} live faces)`, 'REFERENCE_UNRESOLVED')
      }
      const face = matches[0]
      const surface = k.surfaceType(face)
      if (surface !== 'plane') {
        return this.#extrudeTargetFailure(`Up to face target '${target.identity.subshape!.stableId}' has unsupported non-planar surface '${surface}'; the kernel cannot trim this extrusion to that B-rep surface honestly`)
      }
      const hit = this.#planarFaceTravel(face, origin, dir)
      if (hit === undefined) return this.#extrudeTargetFailure(`Up to face target '${target.identity.subshape!.stableId}' is parallel to the extrusion direction`)
      return this.#offsetExtrudeTerminal(`Up to face target '${target.identity.subshape!.stableId}'`, hit, offset, [target.identity])
    } finally {
      for (const face of faces) try { k.release(face) } catch { /* already released */ }
    }
  }

  #partTerminal(
    req: ExtrudeRequest,
    profileFace: ShapeHandle,
    origin: Vec3T,
    dir: Vec3T,
    targets: readonly ResolvedExtrudeTarget[],
    offset: number,
    label: 'Up to next' | 'Up to part',
  ): ExtrudeTerminalResult {
    const k = this.#k()
    const candidates: Array<{ travel: number; target: ResolvedExtrudeTarget; faceIds: StableId[] }> = []
    let sawUnsupported = false
    const profileArea = k.getSurfaceArea(profileFace)
    const areaTol = Math.max(1e-7, profileArea * 1e-7)
    for (const target of targets) {
      const itemFailure = this.#validateExtrudeTargetItem(req, target)
      if (itemFailure) return this.#extrudeTargetFailure(itemFailure, 'REFERENCE_UNRESOLVED')
      if (target.identity.subshape !== undefined) {
        return this.#extrudeTargetFailure(`${label} candidate '${target.identity.bodyFeatureId}' must name a body, not a subshape`, 'REFERENCE_UNRESOLVED')
      }
      const rec = this.#rec(target.body)
      const faces = k.getSubShapes(rec.shape as ShapeHandle, 'face')
      try {
        const groups: Array<{ travel: number; coveredArea: number; faceIds: StableId[] }> = []
        for (const face of faces) {
          const surface = k.surfaceType(face)
          if (surface !== 'plane') {
            sawUnsupported = true
            continue
          }
          const travel = this.#planarFaceTravel(face, origin, dir)
          if (travel === undefined || travel <= 1e-7) continue
          const faceId = rec.faceMap.get(k.hashCode(face, HM))
          if (faceId === undefined) continue
          const coveredArea = this.#faceTerminationArea(profileFace, face, dir, travel)
          if (coveredArea <= areaTol) continue
          const distanceTol = Math.max(1e-7, travel * 1e-8)
          let group = groups.find((candidate) => Math.abs(candidate.travel - travel) <= distanceTol)
          if (!group) {
            group = { travel, coveredArea: 0, faceIds: [] }
            groups.push(group)
          }
          group.coveredArea += coveredArea
          group.faceIds.push(faceId)
        }
        for (const group of groups) {
          if (group.coveredArea + areaTol < profileArea) continue
          group.faceIds.sort(compareIds)
          candidates.push({ travel: group.travel, target, faceIds: group.faceIds })
        }
      } finally {
        for (const face of faces) try { k.release(face) } catch { /* already released */ }
      }
    }
    if (candidates.length === 0) {
      return sawUnsupported
        ? this.#extrudeTargetFailure(`${label} found no fully terminating planar face; a possible non-planar target is unsupported without honest B-rep surface trimming`)
        : this.#extrudeTargetFailure(`${label} found no geometry that fully terminates the profile`)
    }
    candidates.sort((a, b) => a.travel - b.travel || compareIds(a.target.identity.bodyFeatureId, b.target.identity.bodyFeatureId) || compareIds(a.faceIds[0], b.faceIds[0]))
    const nearest = candidates[0]
    const tied = candidates.filter((candidate) => Math.abs(candidate.travel - nearest.travel) <= Math.max(1e-7, nearest.travel * 1e-8))
    if (tied.length > 1) {
      return this.#extrudeTargetFailure(`${label} is ambiguous: ${tied.length} eligible faces occur at the same nearest distance`, 'REFERENCE_UNRESOLVED')
    }
    const resolvedIdentities: ExtrudeTargetIdentity[] = nearest.faceIds.map((faceId) => ({
      ...nearest.target.identity,
      subshape: { kind: 'face', stableId: faceId },
    }))
    return this.#offsetExtrudeTerminal(`${label} target`, nearest.travel, offset, resolvedIdentities)
  }

  #selectedVertexTerminal(
    req: ExtrudeRequest,
    origin: Vec3T,
    dir: Vec3T,
    target: ResolvedExtrudeTarget,
    offset: number,
  ): ExtrudeTerminalResult {
    const itemFailure = this.#validateExtrudeTargetItem(req, target)
    if (itemFailure) return this.#extrudeTargetFailure(itemFailure, 'REFERENCE_UNRESOLVED')
    const wanted = this.#targetStableIds(target.identity, 'vertex')
    if (!wanted) return this.#extrudeTargetFailure('Up to vertex requires a stable vertex target', 'REFERENCE_UNRESOLVED')
    const rec = this.#rec(target.body)
    const normalizedWanted = new Set(wanted.map((id) => this.#normalizeVertexId(rec, id)))
    const k = this.#k()
    const vertices = k.getSubShapes(rec.shape as ShapeHandle, 'vertex')
    try {
      const liveIds = this.#vertexIdsOf(rec, vertices)
      const matches = vertices.filter((_, i) => normalizedWanted.has(liveIds[i]))
      if (matches.length === 0) {
        return this.#extrudeTargetFailure(`Up to vertex target '${target.identity.subshape!.stableId}' is lost`, 'REFERENCE_UNRESOLVED')
      }
      if (matches.length > 1) {
        return this.#extrudeTargetFailure(`Up to vertex target '${target.identity.subshape!.stableId}' is ambiguous (${matches.length} live vertices)`, 'REFERENCE_UNRESOLVED')
      }
      const p = k.vertexPosition(matches[0])
      const hit = dot(sub([p.x, p.y, p.z], origin), dir)
      return this.#offsetExtrudeTerminal(`Up to vertex target '${target.identity.subshape!.stableId}'`, hit, offset, [target.identity])
    } finally {
      for (const vertex of vertices) try { k.release(vertex) } catch { /* already released */ }
    }
  }

  /** Rewrite a persisted vertex id's face operands across this body's face
   *  aliases, so a vertex naming a merged-away face matches the winner-derived
   *  live id. Seam/orphan forms and non-parenthesized ids come back unchanged. */
  #normalizeVertexId(rec: BodyRecord, id: StableId): StableId {
    const parsed = parseStableId(id)
    if (parsed.kind !== 'edge' || parsed.operands.some((operand) => operand.isSeam || operand.isOrphan)) return id
    return vertexId(parsed.operands.map((operand) => this.#resolveFaceId(rec, operand.raw)))
  }

  /** The live vertex id of each handle in `vertices` (index-aligned), derived
   *  from the set of named faces touching it. The caller owns `vertices`; the
   *  face handles minted here are released here. */
  #vertexIdsOf(rec: BodyRecord, vertices: ShapeHandle[]): StableId[] {
    const k = this.#k()
    const adjacency = new Map<number, Set<StableId>>()
    const faces = k.getSubShapes(rec.shape as ShapeHandle, 'face')
    try {
      for (const face of faces) {
        const faceId = rec.faceMap.get(k.hashCode(face, HM))
        if (faceId === undefined) continue
        const faceVertices = k.getSubShapes(face, 'vertex')
        try {
          for (const v of faceVertices) {
            const hash = k.hashCode(v, HM)
            const ids = adjacency.get(hash) ?? new Set<StableId>()
            ids.add(faceId)
            adjacency.set(hash, ids)
          }
        } finally {
          for (const v of faceVertices) try { k.release(v) } catch { /* already released */ }
        }
      }
    } finally {
      for (const face of faces) try { k.release(face) } catch { /* already released */ }
    }
    return vertices.map((v) => vertexId([...(adjacency.get(k.hashCode(v, HM)) ?? [])]))
  }

  #throughAllRange(req: ExtrudeRequest, origin: Vec3T, dir: Vec3T, targets: readonly ResolvedExtrudeTarget[], symmetric: boolean):
    | { ok: true; start: number; end: number; identities: ExtrudeTargetIdentity[] }
    | { ok: false; code: 'KERNEL_OP_FAILED' | 'REFERENCE_UNRESOLVED'; reason: string } {
    if (targets.length === 0) return { ok: false, code: 'REFERENCE_UNRESOLVED', reason: 'Through all requires at least one target body' }
    let min = Infinity
    let max = -Infinity
    let span = 0
    for (const target of targets) {
      const itemFailure = this.#validateExtrudeTargetItem(req, target)
      if (itemFailure) return { ok: false, code: 'REFERENCE_UNRESOLVED', reason: itemFailure }
      const rec = this.#rec(target.body)
      const b = this.#bodyBBox(rec.shape as ShapeHandle)
      span = Math.max(span, Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]))
      for (const x of [b.min[0], b.max[0]]) for (const y of [b.min[1], b.max[1]]) for (const z of [b.min[2], b.max[2]]) {
        const projection = dot(sub([x, y, z], origin), dir)
        min = Math.min(min, projection)
        max = Math.max(max, projection)
      }
    }
    const margin = Math.max(1e-5, span * 1e-7)
    if (symmetric) {
      const extent = Math.max(Math.abs(min), Math.abs(max)) + margin
      return { ok: true, start: -extent, end: extent, identities: targets.map((target) => target.identity) }
    }
    if (!(max > 1e-7)) {
      return { ok: false, code: 'REFERENCE_UNRESOLVED', reason: 'Through all targets are behind the selected extrusion direction' }
    }
    return { ok: true, start: 0, end: max + margin, identities: targets.map((target) => target.identity) }
  }

  async makeExtrude(req: ExtrudeRequest): Promise<OpResult> {
    const k = this.#k()
    const scratch: ShapeHandle[] = []
    let bodyShape: ShapeHandle | null = null
    try {
      const profiles = 'profiles' in req && req.profiles !== undefined
        ? req.profiles
        : [req.profile]
      if (profiles.length === 0) {
        return { ok: false, diagnostics: [{ code: 'KERNEL_OP_FAILED', severity: 'error', params: { op: 'extrude', reason: 'extrude requires at least one profile region' } }] }
      }
      const primaryProfile = profiles[0]
      const basis = planeBasis(primaryProfile.plane)
      const faces = profiles.map((profile) => this.#buildProfileFace(profile, basis, scratch))
      const primaryFace = faces[0]

      let startDistance = 0
      let endDistance = 0
      let resolvedTargets: ExtrudeEndTargetIdentity[] = []
      if (req.end.kind === 'blind') {
        endDistance = req.end.distance
      } else if (req.end.kind === 'symmetric') {
        startDistance = -req.end.distance / 2
        endDistance = req.end.distance / 2
      } else if (req.end.kind === 'throughAll') {
        const dir = scale(basis.normal, req.end.direction)
        const range = this.#throughAllRange(req, basis.origin, dir, req.end.targets, req.end.symmetric === true)
        if (!range.ok) {
          return { ok: false, diagnostics: [{ code: range.code, severity: 'error', params: { op: 'extrude:throughAll', reason: range.reason } }] }
        }
        startDistance = req.end.symmetric ? range.start : req.end.direction * range.start
        endDistance = req.end.symmetric ? range.end : req.end.direction * range.end
        resolvedTargets = range.identities
      } else {
        const dir = scale(basis.normal, req.end.direction)
        const terminal = req.end.kind === 'toFace'
          ? this.#selectedFaceTerminal(req, basis.origin, dir, req.end.target, req.end.offset ?? 0)
          : req.end.kind === 'toVertex'
            ? this.#selectedVertexTerminal(req, basis.origin, dir, req.end.target, req.end.offset ?? 0)
            : req.end.kind === 'toPart'
              ? this.#partTerminal(req, primaryFace, basis.origin, dir, [req.end.target], req.end.offset ?? 0, 'Up to part')
              : this.#partTerminal(req, primaryFace, basis.origin, dir, req.end.candidates, req.end.offset ?? 0, 'Up to next')
        if (!terminal.ok) {
          return { ok: false, diagnostics: [{ code: terminal.code, severity: 'error', params: { op: `extrude:${req.end.kind}`, reason: terminal.reason } }] }
        }
        endDistance = req.end.direction * terminal.terminal.distance
        resolvedTargets = terminal.terminal.targets
      }

      const sweepDistance = endDistance - startDistance
      if (!Number.isFinite(sweepDistance) || Math.abs(sweepDistance) <= 1e-7) {
        return { ok: false, diagnostics: [{ code: 'KERNEL_OP_FAILED', severity: 'error', params: { op: 'extrude', reason: 'resolved end condition has zero or non-finite depth' } }] }
      }
      let profileFaces = faces
      if (startDistance !== 0) {
        const start = scale(basis.normal, startDistance)
        profileFaces = faces.map((face) => {
          const translated = k.translate(face, start[0], start[1], start[2])
          scratch.push(translated)
          return translated
        })
      }

      const extVec = scale(basis.normal, sweepDistance)
      const repOffset = scale(basis.normal, (startDistance + endDistance) / 2)
      const resolvedExtrudeEnd: ResolvedExtrudeEnd = {
        kind: req.end.kind,
        startDistance,
        endDistance,
        targets: resolvedTargets,
      }

      const regionSolids = profileFaces.map((profileFace) => {
        const regionSolid = k.extrude(profileFace, extVec[0], extVec[1], extVec[2])
        scratch.push(regionSolid)
        return regionSolid
      })
      if (regionSolids.some((regionSolid) => !k.isValid(regionSolid))) {
        return { ok: false, diagnostics: [{ code: 'INVALID_RESULT', severity: 'error', params: { op: 'extrude:region' } }] }
      }
      let solid = regionSolids[0]
      for (let i = 1; i < regionSolids.length; i++) {
        const fused = k.fuse(solid, regionSolids[i])
        scratch.push(fused)
        solid = fused
      }
      if (!k.isValid(solid)) {
        return { ok: false, diagnostics: [{ code: 'INVALID_RESULT', severity: 'error', params: { op: 'extrude:fuse-regions' } }] }
      }

      const segReps = profiles.flatMap((profile) =>
        this.#segReps(profile, basis, (mid) => add(mid, repOffset)),
      )
      const extrudeParams = {
        featureId: req.featureId,
        sketchId: primaryProfile.sketchId,
        mode: 'XTR' as const,
        segReps,
        capScore: (c: Vec3T) => dot(c, basis.normal),
        capNormalRef: normalize(extVec),
      }

      if (req.op === 'newBody') {
        const assign = this.#assignSweptFaceIds(solid, extrudeParams)
        bodyShape = solid
        const handle = this.#mint({ shape: solid as number, faceMap: assign.faceMap, snapshots: assign.snapshots })
        const geometry: Record<StableId, ContractGeometrySnapshot> = {}
        for (const [id, snap] of assign.snapshots) geometry[id] = toContractGeometry(snap)
        return {
          ok: true,
          body: handle,
          elementMap: { featureId: req.featureId, modified: {}, generated: assign.generated, deleted: [], geometry },
          resolvedExtrudeEnd,
          diagnostics: okDiag(),
        }
      }

      // add / cut / intersect: sweep is the TOOL against an existing target.
      if (req.target === undefined) {
        return { ok: false, diagnostics: [{ code: 'KERNEL_OP_FAILED', severity: 'error', params: { op: `extrude:${req.op}`, reason: 'op requires a target body' } }] }
      }
      const result = this.#applySweepBoolean(req.featureId, req.op, req.target, solid, extrudeParams)
      bodyShape = result.bodyShape
      if (result.opResult.ok) result.opResult.resolvedExtrudeEnd = resolvedExtrudeEnd
      return result.opResult
    } catch (e) {
      return {
        ok: false,
        diagnostics: [{ code: 'KERNEL_OP_FAILED', severity: 'error', params: { op: 'extrude', message: (e instanceof Error ? e.message : String(e)).slice(0, 200) } }],
      }
    } finally {
      for (const s of scratch) {
        if (s === bodyShape) continue
        try { k.release(s) } catch { /* already released */ }
      }
    }
  }

  async makeRevolve(req: RevolveRequest): Promise<OpResult> {
    const k = this.#k()
    const scratch: ShapeHandle[] = []
    let bodyShape: ShapeHandle | null = null
    try {
      if (!(req.angleDeg > 0) || req.angleDeg > 360 + 1e-6) {
        return { ok: false, diagnostics: [{ code: 'KERNEL_OP_FAILED', severity: 'error', params: { op: 'revolve', reason: `angleDeg ${req.angleDeg} out of range (0, 360]` } }] }
      }
      const basis = planeBasis(req.profile.plane)
      const face = this.#buildProfileFace(req.profile, basis, scratch)
      const theta = (req.angleDeg * Math.PI) / 180
      const axisOrigin: Vec3T = [req.axis.origin.x, req.axis.origin.y, req.axis.origin.z]
      const axisDir = normalize([req.axis.dir.x, req.axis.dir.y, req.axis.dir.z])

      const solid = k.revolve(face, { point: { x: axisOrigin[0], y: axisOrigin[1], z: axisOrigin[2] }, direction: { x: axisDir[0], y: axisDir[1], z: axisDir[2] } }, theta)
      scratch.push(solid)
      if (!k.isValid(solid)) {
        return { ok: false, diagnostics: [{ code: 'INVALID_RESULT', severity: 'error', params: { op: 'revolve' } }] }
      }

      // Representative point per segment: rotate the lifted midpoint half-way
      // through the sweep so it lands on the interior of the swept face.
      const segReps = this.#segReps(req.profile, basis, (mid) => rotateAboutAxis(mid, axisOrigin, axisDir, theta / 2))

      // Cap ordering (partial revolve only): the START cap sits at theta=0 (in
      // the original profile plane), the END cap at theta. Score each cap by
      // distance to a theta=0 profile reference vs that reference rotated by
      // theta, so capStart (nearer start, negative score) sorts before capEnd.
      // The reference is the profile's own centroid (mean of the theta=0 lifted
      // segment midpoints) — guaranteed OFF the axis for any valid revolve — NOT
      // basis.origin, which collapses to a zero perpendicular when the profile
      // plane origin lies on the axis (the xzPlane fixture) and let kernel face
      // enumeration silently decide start/end (GEO-3 R1 audit finding). Full
      // revolve produces no caps.
      const profileRep = (() => {
        const pts = this.#segReps(req.profile, basis, (mid) => mid) // theta=0 lifted midpoints
        const sum = pts.reduce<Vec3T>((acc, p) => add(acc, p.rep), [0, 0, 0])
        return scale(sum, 1 / Math.max(1, pts.length))
      })()
      const { startRef, endRef } = capOrderRefs(profileRep, axisOrigin, axisDir, theta)
      const capScore = (c: Vec3T): number => capOrderScore(c, startRef, endRef)

      const revolveParams = {
        featureId: req.featureId,
        sketchId: req.profile.sketchId,
        mode: 'REV' as const,
        segReps,
        capScore,
      }

      if (req.op === 'newBody') {
        const assign = this.#assignSweptFaceIds(solid, revolveParams)
        bodyShape = solid
        const handle = this.#mint({ shape: solid as number, faceMap: assign.faceMap, snapshots: assign.snapshots })
        const geometry: Record<StableId, ContractGeometrySnapshot> = {}
        for (const [id, snap] of assign.snapshots) geometry[id] = toContractGeometry(snap)
        return {
          ok: true,
          body: handle,
          elementMap: { featureId: req.featureId, modified: {}, generated: assign.generated, deleted: [], geometry },
          diagnostics: okDiag(),
        }
      }

      if (req.target === undefined) {
        return { ok: false, diagnostics: [{ code: 'KERNEL_OP_FAILED', severity: 'error', params: { op: `revolve:${req.op}`, reason: 'op requires a target body' } }] }
      }
      const result = this.#applySweepBoolean(req.featureId, req.op, req.target, solid, revolveParams)
      bodyShape = result.bodyShape
      return result.opResult
    } catch (e) {
      return {
        ok: false,
        diagnostics: [{ code: 'KERNEL_OP_FAILED', severity: 'error', params: { op: 'revolve', message: (e instanceof Error ? e.message : String(e)).slice(0, 200) } }],
      }
    } finally {
      for (const s of scratch) {
        if (s === bodyShape) continue
        try { k.release(s) } catch { /* already released */ }
      }
    }
  }

  /** Shared add/cut/intersect assembler for a swept TOOL against a target body.
   *  Runs the matching *WithHistory op, names target survivors via the boolean
   *  lineage machinery, then relabels the created tool-wall faces with the
   *  tool's constructed sweep lineage. Returns the minted OpResult and the
   *  result shape (so the caller's finally never releases the live body). */
  #applySweepBoolean(
    featureId: string,
    op: 'add' | 'cut' | 'intersect',
    targetHandle: BodyHandle,
    toolShape: ShapeHandle,
    sweepParams: SweepLineageParams,
  ): { opResult: OpResult; bodyShape: ShapeHandle } {
    // Tool's own constructed lineage (used only to relabel the new walls).
    const toolAssign = this.#assignSweptFaceIds(toolShape, sweepParams)
    return this.#applyToolBoolean(featureId, op, targetHandle, toolShape, toolAssign)
  }

  /** Boolean a TOOL (with its own constructed face lineage) against a target
   *  body. Shared by extrude/revolve (#applySweepBoolean) and sweep — the tool's
   *  constructed faceMap/snapshots relabel the created walls; target survivors
   *  are named by the boolean lineage machinery. Returns the minted OpResult and
   *  the live result shape (so the caller's finally never releases the body). */
  #applyToolBoolean(
    featureId: string,
    op: 'add' | 'cut' | 'intersect',
    targetHandle: BodyHandle,
    toolShape: ShapeHandle,
    toolAssign: { faceMap: Map<number, StableId>; snapshots: Map<StableId, GeometrySnapshot>; generated: StableId[] },
  ): { opResult: OpResult; bodyShape: ShapeHandle } {
    const k = this.#k()
    const target = this.#rec(targetHandle)

    const targetHashes = [...target.faceMap.keys()]
    // WO-1892: ask the op about the TOOL's faces as well as the target's. The
    // kernel only walks faces whose hash it was handed, so before this the tool
    // side of the history was never built at all — the cavity walls were bound
    // by nearest centroid. A hash a tool face carries is only still valid after
    // Build() on a kernel whose booleans are non-destructive; on one where they
    // are not, these extra hashes simply match nothing and the geometric
    // fallback runs exactly as before.
    const toolHashes = [...toolAssign.faceMap.keys()].filter((h) => !target.faceMap.has(h))
    const inputHashes = [...targetHashes, ...toolHashes]
    const evo = op === 'cut'
      ? k.cutWithHistory(target.shape as ShapeHandle, toolShape, inputHashes, HM)
      : op === 'add'
        ? k.fuseWithHistory(target.shape as ShapeHandle, toolShape, inputHashes, HM)
        : k.intersectWithHistory(target.shape as ShapeHandle, toolShape, inputHashes, HM)

    // From here on `evo.result` is a live, caller-owned kernel shape that is
    // NOT yet held by any body record. Every step below (face probing, cut-id
    // naming, tool-lineage relabel, validity check, inline geometry) can throw;
    // until #mint transfers ownership to a record, an exception would ORPHAN
    // evo.result (the outer makeExtrude/makeRevolve finally only releases its
    // `scratch` array — the tool — never this boolean result). Release it on the
    // error path unless it has been minted (GEO-3 R1 audit finding). Once minted
    // the record owns the shape, so releasing it would corrupt the live body —
    // hence the `minted` guard.
    let minted = false
    try {
      // TEST-ONLY (GEO-3 R1): drive the post-boolean error path.
      this.#sweepFaultAfterBoolean?.()

      const opCode = op === 'cut' ? 'CUT' : op === 'add' ? 'FUS' : 'INT'
      const resultFaces = this.#faceProbes(evo.result)
      // Split the record by which INPUT each entry describes. The target's own
      // records drive the boolean lineage exactly as before (a tool record must
      // never reach assignCutFaceIds — its `outToIn` map decides which result
      // faces count as brand-new); the tool's drive the wall relabel.
      const toolHashSet = new Set(toolHashes)
      const modifiedRecords = decodeEvolution(evo.modified)
      const toolRecords = [
        ...modifiedRecords.filter((r) => toolHashSet.has(r.inHash)),
        ...decodeEvolution(evo.generated).filter((r) => toolHashSet.has(r.inHash)),
      ]
      const assign = assignCutFaceIds(
        featureId,
        target.faceMap,
        modifiedRecords.filter((r) => target.faceMap.has(r.inHash)),
        resultFaces,
        target.aliases,
        opCode,
      )
      this.#relabelWithToolLineage(
        assign,
        toolAssign.snapshots,
        this.#diagOf(evo.result),
        this.#buildToolLineageFromHistory(toolAssign.faceMap, toolRecords, resultFaces),
      )

      const valid = k.isValid(evo.result)
      const handle = this.#mint({ shape: evo.result as number, faceMap: assign.faceMap, snapshots: assign.snapshots , aliases: target.aliases })
      minted = true
      const geometry = this.#sweepBooleanGeometry(assign, target)
      return {
        bodyShape: evo.result,
        opResult: {
          ok: valid,
          body: handle,
          elementMap: {
            featureId,
            modified: assign.modified,
            generated: assign.generated,
            deleted: assign.deleted,
            geometry,
          },
          diagnostics: valid ? okDiag() : [{ code: 'INVALID_RESULT', severity: 'error', params: { op: `sweep:${op}` } }],
        },
      }
    } catch (e) {
      if (!minted) {
        try { k.release(evo.result) } catch { /* already released */ }
      }
      throw e
    }
  }

  // ---- sweep / loft / hole / body-pattern features — GEO-5 --------------
  //
  // Empirical kernel findings (GEO-5 throwaway spikes, deleted before commit):
  //  - occt-wasm 3.6.1's sweep(), sweepOriented(), sweepPipeShell() ALL throw
  //    WebAssembly.Exception. Only pipe() (BRepOffsetAPI_MakePipe,
  //    corrected-Frenet transport) works, and it yields a CAPPED SOLID when
  //    handed a profile FACE. pipe REQUIRES the profile placed at the spine
  //    START with its plane normal == the spine start tangent — a misaligned
  //    profile returns a degenerate zero-volume result (isValid()-is-not-enough:
  //    the volume>0 backstop below catches it). A closed spine also degenerates
  //    to ~0 volume with no throw, so the closed-path refusal is explicit.
  //  - Because only the frenet-transport pipe() exists, 'fixed' orientation can
  //    only be honored where fixed == frenet (a straight / zero-curvature path).
  //    On a curved path a true 'fixed' sweep is refused rather than silently
  //    swept as frenet (the propagateTangent lesson, GEO-4-R1.3 / ruling 2).
  //  - loft([wires], isSolid=true, ruled) works; two coaxial rects give the
  //    prismatoid volume exactly.
  //  - transform *WithHistory (translate/rotate/mirror) return EMPTY evolution,
  //    so body-pattern lineage is matched GEOMETRICALLY from the PARAMETER GRID
  //    (each instance's transform applied to the seed's own face snapshots),
  //    never kernel enumeration order (ruling 4 / criterion 4 determinism).

  /** Build an open spine wire from a PathChain's segments (same segment
   *  vocabulary as a profile loop, but NOT closed and NOT faced). Every edge +
   *  the wire is pushed to `scratch` for release on both success and error. */
  #buildPathWire(path: SweepRequest['path'], basis: PlaneBasis, scratch: ShapeHandle[]): ShapeHandle {
    const k = this.#k()
    const P = (v: Vec3T): Vec3 => ({ x: v[0], y: v[1], z: v[2] })
    const edges: ShapeHandle[] = []
    for (const seg of path.segments) {
      let edge: ShapeHandle
      if (seg.kind === 'line') {
        edge = k.makeLineEdge(P(lift(basis, seg.a)), P(lift(basis, seg.b)))
      } else {
        let sweep = seg.a1 - seg.a0
        if (seg.ccw && sweep <= 0) sweep += Math.PI * 2
        if (!seg.ccw && sweep >= 0) sweep -= Math.PI * 2
        const at = (t: number): Vec3T => lift(basis, [seg.c[0] + seg.r * Math.cos(t), seg.c[1] + seg.r * Math.sin(t)])
        edge = k.makeArcEdge(P(at(seg.a0)), P(at(seg.a0 + sweep / 2)), P(at(seg.a1)))
      }
      scratch.push(edge)
      edges.push(edge)
    }
    const wire = k.makeWire(edges)
    scratch.push(wire)
    return wire
  }

  /**
   * Constructed lineage for a pipe (sweep) solid. Each side face is matched to
   * the (profile segment x path segment) pair that generated it — the profile
   * segment's 2D representative point, lifted into a frame at that path
   * segment's MIDPOINT (normal = mid tangent), lands on exactly that side face
   * (projectPointOnFace distance ~ 0). Caps are the planar faces whose normal is
   * parallel to a path END tangent (extrude capStart/capEnd precedent). All ids
   * are pure functions of the profile/path srcIds + a deterministic geometric
   * sort — never kernel enumeration order.
   */
  #assignPipeFaceIds(
    resultShape: ShapeHandle,
    params: {
      featureId: string
      sketchId: string
      profile: ProfileRegion
      pathSegs: Array<{ srcId: string; geom: SegGeom2D }>
      pathBasis: PlaneBasis
      startTan: Vec3T
      endTan: Vec3T
      start3d: Vec3T
      end3d: Vec3T
      xHint: Vec3T
    },
  ): { faceMap: Map<number, StableId>; snapshots: Map<StableId, GeometrySnapshot>; generated: StableId[] } {
    const k = this.#k()
    const faces = k.getSubShapes(resultShape, 'face')
    try {
      const tol = Math.max(1e-4, this.#diagOf(resultShape) * 0.01)
      // Per-path-segment midpoint frame for rep placement.
      const midFrames = params.pathSegs.map((ps) => {
        const mid3d = lift(params.pathBasis, ps.geom.mid)
        const midTan = liftDir(params.pathBasis, ps.geom.tMid)
        return { pathSrc: ps.srcId, basis: frameFromNormal(mid3d, midTan, params.xHint) }
      })
      const profSegs: Array<{ srcId: string; rep2d: [number, number] }> = []
      for (const loop of params.profile.loops) {
        for (const seg of loop) profSegs.push({ srcId: seg.srcId, rep2d: segRep2d(seg) })
      }

      const sides = new Map<string, { profSrc: string; pathSrc: string; probes: FaceProbe[] }>()
      const caps: FaceProbe[] = []
      faces.forEach((f) => {
        const probe = this.#probeFace(f)
        // Cap: planar face whose normal is parallel to a path END tangent.
        if (probe.snapshot.type === 'plane') {
          const n = probe.snapshot.normal as Vec3T
          if (Math.abs(dot(n, params.startTan)) > 0.99 || Math.abs(dot(n, params.endTan)) > 0.99) {
            caps.push(probe)
            return
          }
        }
        let bestKey: { profSrc: string; pathSrc: string } | null = null
        let bestDist = Infinity
        for (const pf of midFrames) {
          for (const ps of profSegs) {
            const rp = lift(pf.basis, ps.rep2d)
            const cp = k.projectPointOnFace(f, { x: rp[0], y: rp[1], z: rp[2] })
            const d = Math.hypot(cp.x - rp[0], cp.y - rp[1], cp.z - rp[2])
            if (d < bestDist) { bestDist = d; bestKey = { profSrc: ps.srcId, pathSrc: pf.pathSrc } }
          }
        }
        if (bestKey && bestDist <= tol) {
          const key = `${bestKey.profSrc}x${bestKey.pathSrc}`
          const g = sides.get(key) ?? { profSrc: bestKey.profSrc, pathSrc: bestKey.pathSrc, probes: [] }
          g.probes.push(probe)
          sides.set(key, g)
        } else {
          caps.push(probe)
        }
      })

      const faceMap = new Map<number, StableId>()
      const snapshots = new Map<StableId, GeometrySnapshot>()
      const generated: StableId[] = []
      for (const g of sides.values()) {
        const sorted = [...g.probes].sort((a, b) => compareSnapshots(a.snapshot, b.snapshot))
        const base = sweepSideId(params.featureId, g.profSrc, g.pathSrc)
        sorted.forEach((p, j) => {
          const id: StableId = sorted.length === 1 ? base : `${base}#${j}`
          faceMap.set(p.hash, id)
          snapshots.set(id, p.snapshot)
          generated.push(id)
        })
      }
      const sortedCaps = [...caps].sort((a, b) =>
        (len(sub(a.snapshot.centroid as Vec3T, params.start3d)) - len(sub(a.snapshot.centroid as Vec3T, params.end3d)))
        - (len(sub(b.snapshot.centroid as Vec3T, params.start3d)) - len(sub(b.snapshot.centroid as Vec3T, params.end3d))))
      sortedCaps.forEach((p, idx) => {
        let id: StableId = sweepCapId(params.featureId, params.sketchId, idx === 0 ? 'start' : 'end')
        if (idx > 1) id = `${id}#${idx}`
        faceMap.set(p.hash, id)
        snapshots.set(id, p.snapshot)
        generated.push(id)
      })
      generated.sort()
      return { faceMap, snapshots, generated }
    } finally {
      for (const f of faces) {
        try { k.release(f) } catch { /* already released */ }
      }
    }
  }

  async makeSweep(req: SweepRequest): Promise<OpResult> {
    const k = this.#k()
    const scratch: ShapeHandle[] = []
    let bodyShape: ShapeHandle | null = null
    const fail = (reason: string, code: 'SWEEP_FAILED' | 'OPEN_PROFILE' = 'SWEEP_FAILED'): OpResult => ({
      ok: false,
      diagnostics: [{ code, severity: 'error', params: { profileSketch: req.profile.sketchId, pathSketch: req.path.sketchId, reason } }],
    })
    try {
      if (req.path.segments.length === 0) {
        return fail(`sweep path ${req.path.sketchId} has no segments`)
      }
      // OPEN_PROFILE: the swept profile's outer loop must close into a face.
      if (req.profile.loops.length === 0 || !loopClosed(req.profile.loops[0])) {
        return fail(`sweep profile ${req.profile.sketchId} is an open loop -- a swept profile must be a closed region`, 'OPEN_PROFILE')
      }
      const pathBasis = planeBasis(req.path.plane)
      const pathSegs = req.path.segments.map((s) => ({ srcId: s.srcId, geom: segGeom2d(s) }))
      const first = pathSegs[0].geom
      const last = pathSegs[pathSegs.length - 1].geom
      const start3d = lift(pathBasis, first.start)
      const end3d = lift(pathBasis, last.end)
      const startTan = liftDir(pathBasis, first.tStart)
      const endTan = liftDir(pathBasis, last.tEnd)
      // Closed-path refusal (PathChain "must NOT close" — a closed spine
      // degenerates pipe() to ~0 volume with no throw, verified empirically).
      if (len(sub(end3d, start3d)) < 1e-6) {
        return fail(`sweep path ${req.path.sketchId} is closed (its end returns to its start) -- a sweep path must be an open chain`)
      }
      // 'fixed' orientation is honorable only where it coincides with frenet: a
      // straight (zero-curvature) path. On a curved path the only working kernel
      // sweep (pipe, frenet transport) cannot produce a fixed-orientation solid,
      // so refuse rather than silently sweeping frenet.
      const straight = req.path.segments.every((s) => s.kind === 'line')
        && pathSegs.every((ps) => Math.abs(dot(liftDir(pathBasis, ps.geom.tStart), startTan)) > 1 - 1e-9)
      if (req.orientation === 'fixed' && !straight) {
        return fail(`fixed-orientation sweep along the curved path ${req.path.sketchId} is not supported by the current kernel -- only a straight path keeps a fixed profile orientation (a curved path requires orientation:'frenet')`)
      }

      const xHint: Vec3T = [req.profile.plane.xDir.x, req.profile.plane.xDir.y, req.profile.plane.xDir.z]
      const placement = frameFromNormal(start3d, startTan, xHint)
      const face = this.#buildProfileFace(req.profile, placement, scratch)
      const spine = this.#buildPathWire(req.path, pathBasis, scratch)

      let solid: ShapeHandle
      try {
        solid = k.pipe(face, spine)
      } catch {
        return fail(`the sweep of profile ${req.profile.sketchId} along path ${req.path.sketchId} could not be constructed by the kernel`)
      }
      scratch.push(solid)
      if (!k.isValid(solid) || !(k.getVolume(solid) > 1e-12)) {
        return fail(`the sweep of profile ${req.profile.sketchId} along path ${req.path.sketchId} produced a degenerate (zero-volume) solid -- the profile plane and the path start tangent may be incompatible`)
      }

      const lineage = {
        featureId: req.featureId,
        sketchId: req.profile.sketchId,
        profile: req.profile,
        pathSegs, pathBasis, startTan, endTan, start3d, end3d, xHint,
      }

      if (req.op === 'newBody') {
        const assign = this.#assignPipeFaceIds(solid, lineage)
        bodyShape = solid
        const handle = this.#mint({ shape: solid as number, faceMap: assign.faceMap, snapshots: assign.snapshots })
        const geometry: Record<StableId, ContractGeometrySnapshot> = {}
        for (const [id, snap] of assign.snapshots) geometry[id] = toContractGeometry(snap)
        return {
          ok: true,
          body: handle,
          elementMap: { featureId: req.featureId, modified: {}, generated: assign.generated, deleted: [], geometry },
          diagnostics: okDiag(),
        }
      }

      if (req.target === undefined) {
        return fail(`sweep op '${req.op}' requires a target body`)
      }
      const toolAssign = this.#assignPipeFaceIds(solid, lineage)
      const result = this.#applyToolBoolean(req.featureId, req.op, req.target, solid, toolAssign)
      bodyShape = result.bodyShape
      return result.opResult
    } catch (e) {
      return fail(`sweep of profile ${req.profile.sketchId} along path ${req.path.sketchId} failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 120)}`)
    } finally {
      for (const s of scratch) {
        if (s === bodyShape) continue
        try { k.release(s) } catch { /* already released */ }
      }
    }
  }

  /**
   * Constructed lineage for a loft solid. Each section contributes an outer
   * loop; ruled bands span consecutive sections. A side face is matched to the
   * profile segment (by srcId) whose representative point — lifted on the two
   * bracketing sections and swept along the band — lies on it; caps are the
   * planar faces at the first and last sections. Deterministic geometric sort,
   * never kernel order.
   */
  #assignLoftFaceIds(
    resultShape: ShapeHandle,
    params: {
      featureId: string
      sketchId: string
      sections: ProfileRegion[]
      bases: PlaneBasis[]
      capNormals: [Vec3T, Vec3T]
    },
  ): { faceMap: Map<number, StableId>; snapshots: Map<StableId, GeometrySnapshot>; generated: StableId[] } {
    const k = this.#k()
    const faces = k.getSubShapes(resultShape, 'face')
    try {
      const tol = Math.max(1e-3, this.#diagOf(resultShape) * 0.02)
      const nSections = params.sections.length
      // Rep point per (profile segment srcId, band b between section b and b+1):
      // midpoint between the segment rep lifted on the two bracketing sections.
      type Rep = { srcId: string; band: number; rep: Vec3T }
      const reps: Rep[] = []
      for (let b = 0; b < nSections - 1; b++) {
        const secA = params.sections[b], secB = params.sections[b + 1]
        const basA = params.bases[b], basB = params.bases[b + 1]
        // pair segments across sections by index within the outer loop.
        const loopA = secA.loops[0] ?? [], loopB = secB.loops[0] ?? []
        const n = Math.min(loopA.length, loopB.length)
        for (let i = 0; i < n; i++) {
          const pa = lift(basA, segRep2d(loopA[i]))
          const pb = lift(basB, segRep2d(loopB[i]))
          reps.push({ srcId: loopA[i].srcId, band: b, rep: scale(add(pa, pb), 0.5) })
        }
      }

      const sides = new Map<string, { srcId: string; band: number; probes: FaceProbe[] }>()
      const caps: FaceProbe[] = []
      const capCentroidStart = lift(params.bases[0], segRep2d(params.sections[0].loops[0][0]))
      faces.forEach((f) => {
        const probe = this.#probeFace(f)
        if (probe.snapshot.type === 'plane') {
          const n = probe.snapshot.normal as Vec3T
          if (Math.abs(dot(n, params.capNormals[0])) > 0.99 || Math.abs(dot(n, params.capNormals[1])) > 0.99) {
            caps.push(probe)
            return
          }
        }
        let best: Rep | null = null
        let bestDist = Infinity
        for (const r of reps) {
          const cp = k.projectPointOnFace(f, { x: r.rep[0], y: r.rep[1], z: r.rep[2] })
          const d = Math.hypot(cp.x - r.rep[0], cp.y - r.rep[1], cp.z - r.rep[2])
          if (d < bestDist) { bestDist = d; best = r }
        }
        if (best && bestDist <= tol) {
          const key = `${best.srcId}:s${best.band}`
          const g = sides.get(key) ?? { srcId: best.srcId, band: best.band, probes: [] }
          g.probes.push(probe)
          sides.set(key, g)
        } else {
          caps.push(probe)
        }
      })

      const faceMap = new Map<number, StableId>()
      const snapshots = new Map<StableId, GeometrySnapshot>()
      const generated: StableId[] = []
      for (const g of sides.values()) {
        const sorted = [...g.probes].sort((a, b) => compareSnapshots(a.snapshot, b.snapshot))
        const base = loftSideId(params.featureId, g.srcId, g.band)
        sorted.forEach((p, j) => {
          const id: StableId = sorted.length === 1 ? base : `${base}#${j}`
          faceMap.set(p.hash, id)
          snapshots.set(id, p.snapshot)
          generated.push(id)
        })
      }
      const sortedCaps = [...caps].sort((a, b) =>
        len(sub(a.snapshot.centroid as Vec3T, capCentroidStart)) - len(sub(b.snapshot.centroid as Vec3T, capCentroidStart)))
      sortedCaps.forEach((p, idx) => {
        let id: StableId = loftCapId(params.featureId, params.sketchId, idx === 0 ? 'start' : 'end')
        if (idx > 1) id = `${id}#${idx}`
        faceMap.set(p.hash, id)
        snapshots.set(id, p.snapshot)
        generated.push(id)
      })
      generated.sort()
      return { faceMap, snapshots, generated }
    } finally {
      for (const f of faces) {
        try { k.release(f) } catch { /* already released */ }
      }
    }
  }

  async makeLoft(req: LoftRequest): Promise<OpResult> {
    const k = this.#k()
    const scratch: ShapeHandle[] = []
    let bodyShape: ShapeHandle | null = null
    const fail = (reason: string, code: 'LOFT_FAILED' | 'OPEN_PROFILE' = 'LOFT_FAILED', sketchId?: string): OpResult => ({
      ok: false,
      diagnostics: [{ code, severity: 'error', params: { ...(sketchId ? { sketchId } : {}), reason } }],
    })
    try {
      if (req.sections.length < 2) {
        return fail(`a loft needs at least 2 sections (got ${req.sections.length})`)
      }
      // Each section must be a closed outer loop.
      for (const sec of req.sections) {
        if (sec.loops.length === 0 || !loopClosed(sec.loops[0])) {
          return fail(`loft section ${sec.sketchId} is an open loop -- every loft section must be a closed region`, 'OPEN_PROFILE', sec.sketchId)
        }
      }
      const bases = req.sections.map((s) => planeBasis(s.plane))
      // Build each section's outer wire (loft takes WIRES, not faces).
      const wires: ShapeHandle[] = []
      for (let i = 0; i < req.sections.length; i++) {
        wires.push(this.#buildLoopWireForLoft(req.sections[i].loops[0], bases[i], scratch))
      }
      let solid: ShapeHandle
      try {
        solid = k.loft(wires, true, req.ruled)
      } catch {
        return fail(`the loft through ${req.sections.length} sections could not be constructed by the kernel`)
      }
      scratch.push(solid)
      if (!k.isValid(solid) || !(k.getVolume(solid) > 1e-12)) {
        return fail(`the loft through ${req.sections.length} sections produced a degenerate (zero-volume) solid`)
      }

      const capNormals: [Vec3T, Vec3T] = [bases[0].normal, bases[bases.length - 1].normal]
      const lineage = { featureId: req.featureId, sketchId: req.sections[0].sketchId, sections: req.sections, bases, capNormals }

      if (req.op === 'newBody') {
        const assign = this.#assignLoftFaceIds(solid, lineage)
        bodyShape = solid
        const handle = this.#mint({ shape: solid as number, faceMap: assign.faceMap, snapshots: assign.snapshots })
        const geometry: Record<StableId, ContractGeometrySnapshot> = {}
        for (const [id, snap] of assign.snapshots) geometry[id] = toContractGeometry(snap)
        return {
          ok: true,
          body: handle,
          elementMap: { featureId: req.featureId, modified: {}, generated: assign.generated, deleted: [], geometry },
          diagnostics: okDiag(),
        }
      }

      if (req.target === undefined) {
        return fail(`loft op '${req.op}' requires a target body`)
      }
      const toolAssign = this.#assignLoftFaceIds(solid, lineage)
      const result = this.#applyToolBoolean(req.featureId, req.op, req.target, solid, toolAssign)
      bodyShape = result.bodyShape
      return result.opResult
    } catch (e) {
      return fail(`loft failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 120)}`)
    } finally {
      for (const s of scratch) {
        if (s === bodyShape) continue
        try { k.release(s) } catch { /* already released */ }
      }
    }
  }

  /** Build a closed outer wire (no face) from a loop for lofting. Edges + wire
   *  pushed to `scratch`. Mirrors #buildProfileFace's inner wire builder. */
  #buildLoopWireForLoft(loop: ProfileRegion['loops'][number], basis: PlaneBasis, scratch: ShapeHandle[]): ShapeHandle {
    const k = this.#k()
    const P = (v: Vec3T): Vec3 => ({ x: v[0], y: v[1], z: v[2] })
    if (loop.length === 0) throw new Error('empty loft section loop')
    const edges: ShapeHandle[] = []
    for (const seg of loop) {
      let edge: ShapeHandle
      if (seg.kind === 'line') {
        edge = k.makeLineEdge(P(lift(basis, seg.a)), P(lift(basis, seg.b)))
      } else if (Math.abs(seg.a1 - seg.a0) >= Math.PI * 2 - 1e-6) {
        edge = k.makeCircleEdge(P(lift(basis, seg.c)), P(basis.normal), seg.r)
      } else {
        let sweep = seg.a1 - seg.a0
        if (seg.ccw && sweep <= 0) sweep += Math.PI * 2
        if (!seg.ccw && sweep >= 0) sweep -= Math.PI * 2
        const at = (t: number): Vec3T => lift(basis, [seg.c[0] + seg.r * Math.cos(t), seg.c[1] + seg.r * Math.sin(t)])
        edge = k.makeArcEdge(P(at(seg.a0)), P(at(seg.a0 + sweep / 2)), P(at(seg.a1)))
      }
      scratch.push(edge)
      edges.push(edge)
    }
    const wire = k.makeWire(edges)
    scratch.push(wire)
    return wire
  }

  /**
   * Machinist hole feature (WP6.3). Placements on ONE named face, drilled along
   * the (inward) face normal. Builds a tool per point per the HoleStyle
   * (cylinder / cylinder+counterbore / cylinder+countersink cone), fuses all
   * tools, cuts them from the body in one boolean, then names the created
   * wall/floor faces by POINT INDEX (criterion 3 — ids derived from featureId +
   * point index, stable across reruns). A point that does not lie on the face
   * fails loud (HOLE_FAILED naming the face id + point index; body unchanged).
   */
  async makeHole(req: HoleRequest): Promise<OpResult> {
    const k = this.#k()
    const target = this.#rec(req.body)
    const scratch: ShapeHandle[] = []
    const fail = (reason: string): OpResult => ({
      ok: false,
      diagnostics: [{ code: 'HOLE_FAILED', severity: 'error', params: { face: req.face, reason } }],
    })
    if (req.points.length === 0) return fail(`hole feature on face ${req.face} has no points`)
    const st = req.style
    const diameter = st.diameter
    if (!(diameter > 0)) return fail(`hole diameter must be positive (got ${diameter})`)

    // Resolve the named face + its outward normal.
    const faces = k.getSubShapes(target.shape as ShapeHandle, 'face')
    let faceHandle: ShapeHandle | undefined
    let faceNormal: Vec3T = [0, 0, 1]
    try {
      // UI-57-R1 blocker 2: the SHARED resolver, not a raw faceMap inversion —
      // a merged-away (healed) id must find its winner's live face here, not
      // refuse.
      const idToHash = this.#faceHashIndex(target)
      const hash = idToHash.get(req.face)
      if (hash === undefined) return fail(`face ${req.face} does not exist on this body`)
      faceHandle = faces.find((f) => k.hashCode(f, HM) === hash)
      if (faceHandle === undefined) return fail(`face ${req.face} does not exist on this body`)
      const snap = target.snapshots.get(this.#resolveFaceId(target, req.face))
      if (snap) faceNormal = normalize(snap.normal as Vec3T)
      else {
        try {
          const uv = k.uvBounds(faceHandle)
          const nn = k.surfaceNormal(faceHandle, (uv.uMin + uv.uMax) / 2, (uv.vMin + uv.vMax) / 2)
          faceNormal = normalize([nn.x, nn.y, nn.z])
        } catch { /* keep default */ }
      }
      // Validate every point lies ON the face BEFORE building any geometry.
      const bboxDiag = this.#diagOf(target.shape as ShapeHandle)
      const onFaceTol = Math.max(1e-4, bboxDiag * 0.001)
      for (let i = 0; i < req.points.length; i++) {
        const p = req.points[i]
        const cp = k.projectPointOnFace(faceHandle, { x: p.x, y: p.y, z: p.z })
        const d = Math.hypot(cp.x - p.x, cp.y - p.y, cp.z - p.z)
        if (d > onFaceTol) {
          return fail(`hole point index ${i} (${p.x}, ${p.y}, ${p.z}) does not lie on face ${req.face} (off by ${d.toFixed(4)} mm) -- every hole placement must be on the starting face`)
        }
        // GEO-5-R1.1 (a) trim-aware check: the distance test only proves the
        // point is on the face's SUPPORTING SURFACE (unbounded). A point
        // coplanar with the face but OUTSIDE its trimmed boundary projects onto
        // itself (d ~ 0) yet would cut no material. Classify the point's UV
        // against the trimmed boundary and reject 'out' (the silent-no-op class).
        const { u, v } = k.uvFromPoint(faceHandle, { x: p.x, y: p.y, z: p.z })
        if (k.classifyPointOnFace(faceHandle, u, v) === 'out') {
          return fail(`hole point index ${i} (${p.x}, ${p.y}, ${p.z}) is coplanar with face ${req.face} but lies OUTSIDE its trimmed boundary -- every hole placement must be inside the starting face`)
        }
      }
    } finally {
      for (const f of faces) {
        try { k.release(f) } catch { /* already released */ }
      }
    }

    // Drill direction = INTO the material = opposite the outward face normal.
    const drill = scale(faceNormal, -1)
    // Blind/throughAll depth (throughAll: overshoot the whole body along drill).
    const bodyDepth = this.#diagOf(target.shape as ShapeHandle) + 10
    const depth = req.depth.kind === 'blind' ? req.depth.distance : bodyDepth
    if (!(depth > 0)) return fail(`hole depth must be positive (got ${(req.depth as { distance?: number }).distance})`)

    // A small margin so throughAll cleanly exits both faces.
    const throughMargin = req.depth.kind === 'throughAll' ? bodyDepth * 0.5 : 0

    let tool: ShapeHandle | null = null
    try {
      for (const p of req.points) {
        const center: Vec3T = [p.x, p.y, p.z]
        // For throughAll, start slightly ABOVE the surface so the top is open.
        const top = add(center, scale(drill, -throughMargin))
        const drillLen = depth + throughMargin
        const pointTools: ShapeHandle[] = []
        // main drill cylinder (diameter) full length.
        pointTools.push(this.#cylinderTool(top, drill, diameter / 2, drillLen + throughMargin, scratch))
        if (st.kind === 'counterbore') {
          pointTools.push(this.#cylinderTool(top, drill, st.cbDiameter / 2, throughMargin + st.cbDepth, scratch))
        } else if (st.kind === 'countersink') {
          const rTop = st.csDiameter / 2, rBot = diameter / 2
          const coneH = (rTop - rBot) / Math.tan((st.csAngleDeg / 2) * Math.PI / 180)
          pointTools.push(this.#coneTool(center, drill, rTop, rBot, coneH, scratch))
        }
        let merged = pointTools[0]
        for (let i = 1; i < pointTools.length; i++) {
          const fused = k.fuse(merged, pointTools[i])
          scratch.push(fused)
          merged = fused
        }
        if (tool === null) {
          tool = merged
        } else {
          const fused = k.fuse(tool, merged)
          scratch.push(fused)
          tool = fused
        }
      }
      if (tool === null) return fail(`hole feature on face ${req.face} produced no tool`)

      const inputHashes = [...target.faceMap.keys()]
      const evo = k.cutWithHistory(target.shape as ShapeHandle, tool, inputHashes, HM)
      let minted = false
      try {
        if (!k.isValid(evo.result)) {
          try { k.release(evo.result) } catch { /* already released */ }
          return fail(`the hole(s) on face ${req.face} produced an invalid result`)
        }
        const resultFaces = this.#faceProbes(evo.result)
        const assign = assignCutFaceIds(req.featureId, target.faceMap, decodeEvolution(evo.modified), resultFaces, target.aliases, 'CUT')
        // GEO-5-R1.1 (b) zero-cut backstop (belt-and-suspenders, per the shell
        // volume-delta precedent): even past the trim-aware pre-check a
        // degenerate tool could remove nothing for a point. Every hole point
        // must own >=1 generated wall/floor face (grouped by nearest point on
        // the same geometry #relabelHoleFaces uses). A point that cut nothing
        // FAILED -- release the result and leave the body byte-unchanged.
        const cutPoints = new Set<number>()
        for (const gid of assign.generated) {
          const snap = assign.snapshots.get(gid)
          if (!snap) continue
          let bestI = 0, bestD = Infinity
          for (let i = 0; i < req.points.length; i++) {
            const pp = req.points[i]
            const dd = Math.hypot(snap.centroid[0] - pp.x, snap.centroid[1] - pp.y, snap.centroid[2] - pp.z)
            if (dd < bestD) { bestD = dd; bestI = i }
          }
          cutPoints.add(bestI)
        }
        for (let i = 0; i < req.points.length; i++) {
          if (!cutPoints.has(i)) {
            try { k.release(evo.result) } catch { /* already released */ }
            return fail(`hole point index ${i} (${req.points[i].x}, ${req.points[i].y}, ${req.points[i].z}) on face ${req.face} removed no material -- the placement produced no hole`)
          }
        }
        // Relabel the created hole faces by the nearest hole POINT index (the
        // constructed lineage: featureId + point index + sub-face role).
        this.#relabelHoleFaces(assign, req.points, req.featureId)
        const handle = this.#mint({ shape: evo.result as number, faceMap: assign.faceMap, snapshots: assign.snapshots , aliases: target.aliases })
        minted = true
        const geometry = this.#sweepBooleanGeometry(assign, target)
        return {
          ok: true,
          body: handle,
          elementMap: { featureId: req.featureId, modified: assign.modified, generated: assign.generated, deleted: assign.deleted, geometry },
          diagnostics: okDiag(),
        }
      } catch (e) {
        if (!minted) {
          try { k.release(evo.result) } catch { /* already released */ }
        }
        throw e
      }
    } catch (e) {
      return fail(`the hole(s) on face ${req.face} could not be constructed: ${(e instanceof Error ? e.message : String(e)).slice(0, 100)}`)
    } finally {
      for (const s of scratch) {
        try { k.release(s) } catch { /* already released */ }
      }
    }
  }

  /** A cylindrical drill tool: circle of `radius` at `apex` swept `length` along
   *  unit `dir`. Built by extruding a circle face (no rotation math needed). */
  #cylinderTool(apex: Vec3T, dir: Vec3T, radius: number, length: number, scratch: ShapeHandle[]): ShapeHandle {
    const k = this.#k()
    const circle = k.makeCircleEdge({ x: apex[0], y: apex[1], z: apex[2] }, { x: dir[0], y: dir[1], z: dir[2] }, radius)
    scratch.push(circle)
    const wire = k.makeWire([circle])
    scratch.push(wire)
    const face = k.makeFace(wire)
    scratch.push(face)
    const v = scale(dir, length)
    const solid = k.extrude(face, v[0], v[1], v[2])
    scratch.push(solid)
    return solid
  }

  /** A conical countersink tool: frustum from radius `rTop` at `apex` down to
   *  `rBot` a distance `height` along unit `dir`, built by lofting the two
   *  circle wires (verified: loft ruled between two coaxial circles -> cone). */
  #coneTool(apex: Vec3T, dir: Vec3T, rTop: number, rBot: number, height: number, scratch: ShapeHandle[]): ShapeHandle {
    const k = this.#k()
    // GEO-5-R1.2: store the raw circle-edge handles in scratch BEFORE makeWire
    // (exactly like #cylinderTool) — otherwise the two edges built inline leak
    // (they are never released, since only the wires were tracked). The leak is
    // on the SUCCESS path, which the error-path lifecycle tests missed.
    const topEdge = k.makeCircleEdge({ x: apex[0], y: apex[1], z: apex[2] }, { x: dir[0], y: dir[1], z: dir[2] }, rTop)
    scratch.push(topEdge)
    const top = k.makeWire([topEdge])
    scratch.push(top)
    const b = add(apex, scale(dir, height))
    const botEdge = k.makeCircleEdge({ x: b[0], y: b[1], z: b[2] }, { x: dir[0], y: dir[1], z: dir[2] }, rBot)
    scratch.push(botEdge)
    const bot = k.makeWire([botEdge])
    scratch.push(bot)
    const cone = k.loft([top, bot], true, true)
    scratch.push(cone)
    return cone
  }

  /** Rename each created hole face (default `:CUT:new#k` from assignCutFaceIds)
   *  to `<fid>:HOL:i<pointIndex>:<role>` by matching the face to the nearest
   *  hole point (its centroid's distance to each point) and its surface role
   *  (cylinder/cone wall vs planar floor). Deterministic: point index comes from
   *  the request order, role from the face's own surface type, `#j` from a
   *  geometric sort — never kernel enumeration order. */
  #relabelHoleFaces(assign: CutAssignment, points: Vec3[], featureId: string): void {
    if (assign.generated.length === 0) return
    const idToHash = new Map<StableId, number>()
    for (const [hash, id] of assign.faceMap) idToHash.set(id, hash)
    // group generated faces by nearest point index.
    const byPoint = new Map<number, Array<{ oldId: StableId; snap: GeometrySnapshot }>>()
    for (const oldId of assign.generated) {
      const snap = assign.snapshots.get(oldId)
      if (!snap) continue
      let bestI = 0, bestD = Infinity
      for (let i = 0; i < points.length; i++) {
        const d = Math.hypot(snap.centroid[0] - points[i].x, snap.centroid[1] - points[i].y, snap.centroid[2] - points[i].z)
        if (d < bestD) { bestD = d; bestI = i }
      }
      const arr = byPoint.get(bestI) ?? []
      arr.push({ oldId, snap })
      byPoint.set(bestI, arr)
    }
    const renamed = new Map<StableId, StableId>()
    for (const [pointIndex, arr] of byPoint) {
      // sort deterministically, then within a role bucket assign #j.
      const roleOf = (s: GeometrySnapshot): string => (s.type === 'plane' ? 'floor' : 'wall')
      const roleCounts = new Map<string, number>()
      const totalOfRole = new Map<string, number>()
      for (const a of arr) totalOfRole.set(roleOf(a.snap), (totalOfRole.get(roleOf(a.snap)) ?? 0) + 1)
      const sorted = [...arr].sort((a, b) => compareSnapshots(a.snap, b.snap))
      for (const a of sorted) {
        const role = roleOf(a.snap)
        const j = roleCounts.get(role) ?? 0
        roleCounts.set(role, j + 1)
        const base = holeFaceId(featureId, pointIndex, role)
        renamed.set(a.oldId, (totalOfRole.get(role) ?? 1) > 1 ? `${base}#${j}` : base)
      }
    }
    const nextGenerated: StableId[] = []
    for (const oldId of assign.generated) {
      const newId = renamed.get(oldId)
      if (newId === undefined || newId === oldId) { nextGenerated.push(oldId); continue }
      const hash = idToHash.get(oldId)
      const snap = assign.snapshots.get(oldId)
      if (hash === undefined || !snap) { nextGenerated.push(oldId); continue }
      assign.faceMap.set(hash, newId)
      assign.snapshots.delete(oldId)
      assign.snapshots.set(newId, snap)
      nextGenerated.push(newId)
    }
    assign.generated = nextGenerated.sort()
  }

  /**
   * Body-level pattern (WP5.3): the seed body and every instance fuse into ONE
   * result body. Instance sub-shape ids derive as `<featureId>:PAT:i<n>:<childId>`
   * per stable-id-spec (ruling 4). Because transform *WithHistory return empty
   * evolution (verified), each result face is matched GEOMETRICALLY to the
   * (instance n, seed face id) whose transformed snapshot it equals — the
   * transform comes from the PARAMETER GRID (n, spacing/step/plane), never kernel
   * enumeration order, so two identical runs produce byte-identical ids.
   */
  async applyBodyPattern(req: PatternRequest): Promise<OpResult> {
    const k = this.#k()
    const seed = this.#rec(req.body)
    const scratch: ShapeHandle[] = []
    const fail = (reason: string): OpResult => ({
      ok: false,
      diagnostics: [{ code: 'PATTERN_FAILED', severity: 'error', params: { reason } }],
    })
    // Build the per-instance rigid transform of a point + a normal (pure geometry
    // from the parameter grid). Instance 0 is the seed (identity).
    const spec = req.spec
    let count: number
    let xform: (n: number, centroid: Vec3T, normal: Vec3T) => { c: Vec3T; n: Vec3T }
    if (spec.kind === 'linear') {
      if (!(spec.count >= 2)) return fail(`linear pattern needs count >= 2 (got ${spec.count})`)
      if (!(spec.spacing > 0)) return fail(`linear pattern needs non-zero spacing (got ${spec.spacing})`)
      const dir = normalize([spec.dir.x, spec.dir.y, spec.dir.z])
      if (len(dir) < 1e-9) return fail('linear pattern direction must be a non-zero vector')
      count = spec.count
      xform = (n, c, nm) => ({ c: add(c, scale(dir, spec.spacing * n)), n: nm })
    } else if (spec.kind === 'circular') {
      if (!(spec.count >= 2)) return fail(`circular pattern needs count >= 2 (got ${spec.count})`)
      if (!(Math.abs(spec.stepDeg) > 1e-9)) return fail(`circular pattern needs non-zero stepDeg (got ${spec.stepDeg})`)
      const axisO: Vec3T = [spec.axis.origin.x, spec.axis.origin.y, spec.axis.origin.z]
      const axisD = normalize([spec.axis.dir.x, spec.axis.dir.y, spec.axis.dir.z])
      if (len(axisD) < 1e-9) return fail('circular pattern axis direction must be a non-zero vector')
      count = spec.count
      xform = (n, c, nm) => {
        const ang = (spec.stepDeg * n * Math.PI) / 180
        return { c: rotateAboutAxis(c, axisO, axisD, ang), n: rotateAboutAxis(add(nm, axisO), axisO, axisD, ang).map((v, i) => v - axisO[i]) as Vec3T }
      }
    } else {
      // mirror
      const o: Vec3T = [spec.plane.origin.x, spec.plane.origin.y, spec.plane.origin.z]
      const nrm = normalize([spec.plane.normal.x, spec.plane.normal.y, spec.plane.normal.z])
      if (len(nrm) < 1e-9) return fail('mirror plane normal must be a non-zero vector')
      count = 2
      xform = (n, c, nm) => n === 0 ? { c, n: nm } : { c: reflectPoint(c, o, nrm), n: reflectVector(nm, nrm) }
    }

    let fused: ShapeHandle
    try {
      // instance 0 = seed (a copy, so the seed body record stays untouched).
      fused = k.copy(seed.shape as ShapeHandle)
      scratch.push(fused)
      for (let n = 1; n < count; n++) {
        let inst: ShapeHandle
        if (spec.kind === 'linear') {
          const d = scale(normalize([spec.dir.x, spec.dir.y, spec.dir.z]), spec.spacing * n)
          inst = k.translate(seed.shape as ShapeHandle, d[0], d[1], d[2])
        } else if (spec.kind === 'circular') {
          const ang = (spec.stepDeg * n * Math.PI) / 180
          inst = k.rotate(seed.shape as ShapeHandle, { point: spec.axis.origin, direction: { x: normalize([spec.axis.dir.x, spec.axis.dir.y, spec.axis.dir.z])[0], y: normalize([spec.axis.dir.x, spec.axis.dir.y, spec.axis.dir.z])[1], z: normalize([spec.axis.dir.x, spec.axis.dir.y, spec.axis.dir.z])[2] } }, ang)
        } else {
          inst = k.mirror(seed.shape as ShapeHandle, spec.plane.origin, { x: normalize([spec.plane.normal.x, spec.plane.normal.y, spec.plane.normal.z])[0], y: normalize([spec.plane.normal.x, spec.plane.normal.y, spec.plane.normal.z])[1], z: normalize([spec.plane.normal.x, spec.plane.normal.y, spec.plane.normal.z])[2] })
        }
        scratch.push(inst)
        const next = k.fuse(fused, inst)
        scratch.push(next)
        fused = next
      }
      if (!k.isValid(fused) || !(k.getVolume(fused) > 1e-12)) {
        return fail('the pattern fuse produced an invalid or degenerate body')
      }

      // Predicted (instance, seed-face) snapshots from the parameter grid —
      // each carries its transformed centroid AND normal (the normal is needed
      // to test plane-coincidence for overlap-merged faces, GEO-5-R1.3).
      type Pred = { n: number; seedId: StableId; c: Vec3T; nrm: Vec3T; type: string }
      const preds: Pred[] = []
      for (let n = 0; n < count; n++) {
        for (const [seedId, snap] of seed.snapshots) {
          const t = xform(n, snap.centroid as Vec3T, normalize(snap.normal as Vec3T))
          preds.push({ n, seedId, c: t.c, nrm: normalize(t.n), type: snap.type })
        }
      }
      const resultFaces = this.#faceProbes(fused)
      const bboxDiag = this.#diagOf(fused)
      const tol = Math.max(1e-3, bboxDiag * 0.01)
      const planeTol = Math.max(1e-3, bboxDiag * 1e-3)

      const faceMap = new Map<number, StableId>()
      const snapshots = new Map<StableId, GeometrySnapshot>()
      const generated: StableId[] = []
      const modified: Record<StableId, StableId[]> = {}
      const usedPred = new Set<Pred>()
      const sortedFaces = [...resultFaces].sort((a, b) => compareSnapshots(a.snapshot, b.snapshot))
      // Pass 1: assign each result face to its nearest unused predicted (instance,
      // seed face) — the clean 1:1 case (non-overlapping instances, and the
      // outermost survivors of overlapping ones).
      const unmatched: FaceProbe[] = []
      for (const rf of sortedFaces) {
        let best: Pred | undefined
        let bestD = Infinity
        for (const pr of preds) {
          if (usedPred.has(pr)) continue
          if (pr.type !== rf.snapshot.type) continue
          const d = Math.hypot(rf.snapshot.centroid[0] - pr.c[0], rf.snapshot.centroid[1] - pr.c[1], rf.snapshot.centroid[2] - pr.c[2])
          if (d < bestD) { bestD = d; best = pr }
        }
        if (best && bestD <= tol) {
          usedPred.add(best)
          const id: StableId = best.n === 0 ? best.seedId : patternInstanceId(req.featureId, best.n, best.seedId)
          faceMap.set(rf.hash, id)
          snapshots.set(id, rf.snapshot)
          if (best.n === 0) modified[best.seedId] = [best.seedId]
          else generated.push(id)
        } else {
          unmatched.push(rf)
        }
      }
      // Pass 2 (GEO-5-R1.3): overlapping instances fuse coplanar walls into ONE
      // result face that no single prediction's centroid matches. stable-id-spec
      // forbids silent unnamed faces on a persisted body (uniform no-silent-gaps
      // ruling, same family as GEO-4-R1.4's shell catch-all): name every such
      // face from ALL its CONTRIBUTING (instance, seed-face) predictions — those
      // whose transformed plane coincides with the merged face — via a
      // deterministic merged-source id (sorted, byte-identical across runs).
      const orphans: FaceProbe[] = []
      for (const rf of unmatched) {
        const rn = normalize(rf.snapshot.normal as Vec3T)
        const rc = rf.snapshot.centroid as Vec3T
        const contributors: Array<{ n: number; childId: string }> = []
        for (const pr of preds) {
          if (pr.type !== rf.snapshot.type) continue
          // plane-coincident: normals (anti)parallel AND the prediction's
          // centroid lies in the result face's plane.
          if (Math.abs(dot(pr.nrm, rn)) < 1 - 1e-6) continue
          if (Math.abs(dot(rn, sub(pr.c, rc))) > planeTol) continue
          contributors.push({ n: pr.n, childId: pr.seedId })
        }
        if (contributors.length === 0) { orphans.push(rf); continue }
        const id = patternMergeId(req.featureId, contributors)
        faceMap.set(rf.hash, id)
        snapshots.set(id, rf.snapshot)
        generated.push(id)
      }
      // No-silent-gaps enforcement: if any surviving face still has no
      // deterministic id, fail loud rather than persist an unnamed face.
      if (orphans.length > 0) {
        return fail(`pattern produced ${orphans.length} result face(s) with no derivable stable id -- every surviving face must map to an instance or merged-source id`)
      }
      generated.sort()
      // Seed faces with no surviving DISTINCT survivor (overlap fused them into a
      // merged face, or into the solid interior) -> deleted. Their lineage is
      // still recoverable: an absorbed seed face's id is embedded in the merged
      // face's merged-source id grammar.
      const survived = new Set(faceMap.values())
      const deleted: StableId[] = []
      for (const seedId of seed.snapshots.keys()) {
        if (!survived.has(seedId)) deleted.push(seedId)
      }
      deleted.sort()

      // UI-57-R2 blocker: the seed body's inherited lineage is re-stated in this
      // delta (the #mint below already carries it in MEMORY -- `aliases:
      // seed.aliases`; without this fold that map cannot survive a
      // serialize/restore, which is exactly the round trip the blocker names).
      // Instance-0 keeps the seed's own ids, so an aliased seed face's live root
      // is live here under the same id.
      const generatedIds = new Set(generated)
      foldAliasLineageIntoDelta({
        aliases: seed.aliases,
        isLive: (id) => snapshots.has(id),
        modified,
        isGenerated: (id) => generatedIds.has(id),
      })

      const handle = this.#mint({ shape: fused as number, faceMap, snapshots , aliases: seed.aliases })
      // remove `fused` from scratch so the finally doesn't release the live body.
      const idx = scratch.indexOf(fused)
      if (idx >= 0) scratch.splice(idx, 1)

      const geometry: Record<StableId, ContractGeometrySnapshot> = {}
      for (const [id, snap] of snapshots) geometry[id] = toContractGeometry(snap)
      return {
        ok: true,
        body: handle,
        elementMap: { featureId: req.featureId, modified, generated, deleted, geometry },
        diagnostics: okDiag(),
      }
    } catch (e) {
      return fail(`pattern failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 120)}`)
    } finally {
      for (const s of scratch) {
        try { k.release(s) } catch { /* already released */ }
      }
    }
  }

  // ---- dress-up features (fillet / chamfer / shell / draft) — GEO-4 -----
  //
  // Fillet/chamfer/shell all have kernel history (filletWithHistory /
  // chamferWithHistory / shellWithHistory — verified STAGE0_FINDINGS + this
  // WO's own spikes), so their unchanged/modified/deleted classification
  // reuses assignCutFaceIds exactly (empirically confirmed compatible: a
  // fillet/chamfer band's 2 adjacent walls show up as ordinary 1:1 "retrim
  // keeps its id" modified records, same as a boolean). Only the NEW band
  // face's name differs from a boolean's positional `new#k` — it must be the
  // spec's edge-derived `F:FIL:<edgeStableId>` / `F:CHM:<edgeStableId>`, so
  // #relabelDressUpBandFaces renames them post-hoc by nearest-edge geometric
  // match, mirroring #relabelWithToolLineage's existing pattern.
  //
  // Draft has NO kernel history at all (occt-wasm's `draft()` exposes no
  // *WithHistory variant) AND — verified empirically — rehashes faces it did
  // not even touch, so hash equality cannot be trusted as an identity signal
  // the way it can for the other three. applyDraft instead loops one
  // requested face at a time and geometrically re-binds EVERY id after each
  // step via rebindDraftFaces (stable-id.ts), refusing to proceed if any
  // id cannot be re-matched within tolerance (never a silent mis-bind).

  /**
   * The SINGLE per-shape edge-id derivation every edge consumer shares
   * (tessellate / #edgeIdsFor / #edgeCandidates), so the id the UI picks FROM
   * (tessellate) is byte-identical to the id a resolver later matches AGAINST
   * (#edgeCandidates / #edgeIdsFor). For each wireframe edge group it derives the
   * BASE two-face id (the sorted adjacent-face-pair wedge, per
   * docs/stable-id-spec.md), a representative curve mid-parameter point, and the
   * analytic curve length; then GEO-16's disambiguateEdgeIds appends a geometric
   * disambiguator to any base id shared by >=2 physical edges (a collision
   * group), leaving single-edge pairs byte-identical. Aligned with `edgeHandles`
   * by group index `g` (ids[g], reps[g] describe edgeHandles[g]); an undefined
   * handle yields a placeholder id/rep at that slot so alignment never shifts.
   * All three callers already fetch edgeHandles + adjacency + wireframe, so this
   * takes them as arguments rather than re-querying the kernel.
   */
  #labelEdges(
    edgeHandles: ShapeHandle[],
    adjacency: Map<number, Set<number>>,
    wf: { edgeGroups: ArrayLike<number> },
    rec: BodyRecord,
  ): { ids: StableId[]; reps: Vec3T[] } {
    const k = this.#k()
    const groupCount = wf.edgeGroups.length / 3
    const seamCounters = new Map<string, number>()
    const bases: StableId[] = []
    const geoms: Array<EdgeGeom | null> = []
    const reps: Vec3T[] = []
    for (let g = 0; g < groupCount; g++) {
      const edge = edgeHandles[g]
      const eHash = edge !== undefined ? k.hashCode(edge, HM) : -1
      const adjHashes = adjacency.get(eHash) ?? new Set<number>()
      const faceIdsForEdge = [...adjHashes]
        .map((fh) => rec.faceMap.get(fh))
        .filter((x): x is StableId => x !== undefined)
      const seamBase = faceIdsForEdge[0] ?? `e${g}`
      const seamK = seamCounters.get(seamBase) ?? 0
      if (faceIdsForEdge.length < 2) seamCounters.set(seamBase, seamK + 1)
      bases.push(edgeId(faceIdsForEdge, String(seamK)))
      let rep: Vec3T = [0, 0, 0]
      let geom: EdgeGeom | null = null
      if (edge !== undefined) {
        try {
          const params = k.curveParameters(edge)
          const p = k.curvePointAtParam(edge, (params.first + params.last) / 2)
          rep = [p.x, p.y, p.z]
          // Analytic curve length is intrinsic to the curve (not deflection-
          // dependent), so it is a regeneration-stable second key alongside the
          // mid-point. Best-effort: a curve occt cannot length-measure just
          // leaves the token to the mid-point.
          let length = NaN
          try { length = k.curveLength(edge) } catch { /* mid-point-only token */ }
          geom = { mid: rep, length }
        } catch { /* best-effort representative point + no disambiguator */ }
      }
      reps.push(rep)
      geoms.push(geom)
    }
    return { ids: disambiguateEdgeIds(bases, geoms), reps }
  }

  /** Every edge of `shape`, with its stable-id-spec-derived id (the unordered,
   *  sorted wedge-join of its adjacent face ids — GEO-16-disambiguated when a
   *  face pair carries more than one edge; same derivation #edgeIdsFor and
   *  tessellate() use), a representative 3D point (curve mid-parameter), and its
   *  live ShapeHandle. `allHandles` is the FULL caller-owned getSubShapes('edge')
   *  array (same as #edgeIdsFor) — the caller must release every one of them, on
   *  both the success and error paths, once done; `candidates` only aliases a
   *  subset of those handles (one per wireframe edge group) and must not be
   *  released separately. */
  #edgeCandidates(shape: ShapeHandle, rec: BodyRecord): {
    candidates: Array<{ id: StableId; hash: number; handle: ShapeHandle; rep: Vec3T; faceIds: StableId[] }>
    allHandles: ShapeHandle[]
  } {
    const k = this.#k()
    const edgeHandles = k.getSubShapes(shape, 'edge')
    const { adjacentFaces: adjacency } = this.#edgeAdjacency(shape)
    const wf = k.wireframe(shape, 0.1)
    const { ids, reps } = this.#labelEdges(edgeHandles, adjacency, wf, rec)
    const candidates: Array<{ id: StableId; hash: number; handle: ShapeHandle; rep: Vec3T; faceIds: StableId[] }> = []
    for (let g = 0; g < ids.length; g++) {
      const edge = edgeHandles[g]
      if (edge === undefined) continue
      const hash = k.hashCode(edge, HM)
      const faceIds = [...(adjacency.get(hash) ?? [])]
        .map((faceHash) => rec.faceMap.get(faceHash))
        .filter((id): id is StableId => id !== undefined)
      candidates.push({ id: ids[g], hash, handle: edge, rep: reps[g], faceIds })
    }
    return { candidates, allHandles: edgeHandles }
  }

  /**
   * ICR-3 STEP 1 (GEO-15, Operator-approved Q-18): edgeId (stable-id.ts:193-200)
   * keys a two-face edge on the UNORDERED adjacent-face pair ONLY, per
   * docs/stable-id-spec.md, so two physically distinct edges that share one
   * face pair collapse to the SAME stable id. PROVEN on real topology: two
   * overlapping R10xH20 cylinders 12mm apart fuse to 15 edges but only 13
   * unique ids (two duplicate-id pairs) -- see the committed regression fixture
   * src/tests/geom/edge-id-collision.test.ts. Any consumer that then resolves a
   * PICKED id through a by-id Map (last-wins) or a parallel-array indexOf
   * (first-wins) would silently bind the pick to the WRONG twin: the fillet
   * lands on the wrong edge and the edge the user picked stays sharp (the class
   * behind Operator's "not actually filleted" screenshot). Until the grammar is
   * extended with a persisted-id migration -- that is GEO-16, NOT this WO --
   * every picked-edge-id resolver must REFUSE a pick that lands on a colliding
   * id rather than guess a twin.
   *
   * Returns the REQUESTED ids that collide (candidate multiplicity >= 2), each
   * with its multiplicity, de-duplicated and deterministically ordered by first
   * appearance in `requested`. A collision the caller did NOT pick is not this
   * op's problem and is never reported here, even though `candidateIds` may
   * carry unrelated collisions elsewhere on the same body.
   *
   * GEO-16: the grammar now disambiguates colliding pairs, so kernel output no
   * longer feeds this guard a real collision -- it becomes the fail-CLOSED
   * BACKSTOP for any future grammar regression (or a residual token tie). Kept
   * here, its logic extracted to the pure collidingPickedEdgeIds (stable-id.ts)
   * so the backstop stays unit-testable with synthetic duplicate lists even
   * though the kernel can no longer produce one.
   */
  #collidingPickedEdgeIds(
    requested: readonly StableId[],
    candidateIds: readonly StableId[],
  ): Array<{ id: StableId; count: number }> {
    return collidingPickedEdgeIds(requested, candidateIds)
  }

  /**
   * Rename each brand-new dress-up "band" face (default-named `<op>:new#k` by
   * assignCutFaceIds) to the spec's edge-derived id `<fid>:<opCode>:<edgeId>`,
   * by finding the GEOMETRICALLY NEAREST pre-op edge candidate (projected
   * distance from the edge's representative point to the band face) — the
   * same representative-point matching pattern #assignSweptFaceIds already
   * uses for extrude/revolve lineage. Each edge candidate is used at most
   * once (greedy nearest-first over deterministically-sorted band ids), so a
   * tangent-propagated chain (verified empirically: filleting ONE edge of a
   * tangent-continuous pair auto-propagates the fillet across BOTH edges,
   * each surfacing as its OWN band face) names each band after its own
   * originating edge without the caller needing to have asked for it.
   */
  #relabelDressUpBandFaces(
    assign: CutAssignment,
    resultShape: ShapeHandle,
    edgeCandidates: Array<{ id: StableId; hash: number; handle: ShapeHandle; rep: Vec3T }>,
    opCode: 'FIL' | 'CHM',
    featureId: string,
  ): void {
    if (assign.generated.length === 0 || edgeCandidates.length === 0) return
    const k = this.#k()
    const idToHash = new Map<StableId, number>()
    for (const [hash, id] of assign.faceMap) idToHash.set(id, hash)
    const faces = k.getSubShapes(resultShape, 'face')
    try {
      const byHash = new Map<number, ShapeHandle>()
      for (const f of faces) byHash.set(k.hashCode(f, HM), f)
      const usedEdge = new Set<StableId>()
      const renamed = new Map<StableId, StableId>()
      const sortedGenerated = [...assign.generated].sort()
      for (const genId of sortedGenerated) {
        const hash = idToHash.get(genId)
        const faceHandle = hash !== undefined ? byHash.get(hash) : undefined
        if (faceHandle === undefined) continue
        let best: { id: StableId } | undefined
        let bestDist = Infinity
        for (const c of edgeCandidates) {
          if (usedEdge.has(c.id)) continue
          let d: number
          try {
            const cp = k.projectPointOnFace(faceHandle, { x: c.rep[0], y: c.rep[1], z: c.rep[2] })
            d = Math.hypot(cp.x - c.rep[0], cp.y - c.rep[1], cp.z - c.rep[2])
          } catch { continue }
          if (d < bestDist) { bestDist = d; best = c }
        }
        if (best) {
          usedEdge.add(best.id)
          renamed.set(genId, `${featureId}:${opCode}:${best.id}`)
        }
      }
      const nextGenerated: StableId[] = []
      for (const genId of assign.generated) {
        const newId = renamed.get(genId)
        if (newId === undefined) { nextGenerated.push(genId); continue }
        const hash = idToHash.get(genId)!
        const snap = assign.snapshots.get(genId)!
        assign.faceMap.set(hash, newId)
        assign.snapshots.delete(genId)
        assign.snapshots.set(newId, snap)
        nextGenerated.push(newId)
      }
      assign.generated = nextGenerated
    } finally {
      for (const f of faces) {
        try { k.release(f) } catch { /* already released */ }
      }
    }
  }

  /** Shared fillet/chamfer implementation: both are edge-selection, single
   *  scalar-parameter, kernel-history dress-up ops that differ only in which
   *  *WithHistory call runs and which DiagCode/opCode/param-name they use. */
  async #applyEdgeDressUp(
    req: { featureId: string; body: BodyHandle; edges: StableId[]; importedFeatureKey?: string },
    param: number,
    paramName: 'radius' | 'distance',
    opCode: 'FIL' | 'CHM',
    failCode: 'FILLET_RADIUS_TOO_LARGE' | 'CHAMFER_FAILED',
    invoke: (shape: ShapeHandle, edges: ShapeHandle[], inputHashes: number[], value: number) => EvolutionData,
  ): Promise<OpResult> {
    if (opCode === 'FIL' && isImportedFilletRequest(req as FilletRequest)) {
      const changed = this.#editImportedFilletRadius(this.#rec(req.body), req as ImportedFilletRequest)
      if (!changed.ok) return changed
      return {
        ok: true,
        body: changed.body,
        elementMap: { featureId: req.featureId, ...changed.assignment },
        diagnostics: okDiag(),
      }
    }
    const k = this.#k()
    const target = this.#rec(req.body)
    if (req.edges.length === 0) {
      return { ok: false, diagnostics: [{ code: failCode, severity: 'error', params: { reason: `${opCode === 'FIL' ? 'fillet' : 'chamfer'} requires at least one edge` } }] }
    }
    const { candidates, allHandles } = this.#edgeCandidates(target.shape as ShapeHandle, target)
    try {
      // ICR-3 step 1 (GEO-15): refuse BY NAME when a PICKED id collides with a
      // twin edge (edgeId face-pair collapse) instead of last-wins-binding to
      // the wrong edge. Only ids the caller actually picked block the op; a
      // collision elsewhere on the body is not this op's problem. See
      // #collidingPickedEdgeIds. NOT a throw and NOT last-wins -- a structured
      // refusal naming every colliding id and its collision count.
      const candidateIds = candidates.map((c) => c.id)
      // UI-57-R1 blocker 2: migrate every PERSISTED pick across this body's face
      // aliases FIRST (see migrateEdgeIdVia) -- an edge id embeds its adjacent
      // face ids verbatim, so a pick naming a merged-away face names no live
      // edge until it is rewritten to name the winner. Done before BOTH the
      // collision guard and the resolve loop so each reasons about the same ids.
      // `requestedEdges` is index-aligned with req.edges; diagnostics keep
      // naming the caller's ORIGINAL id (what the user's document holds).
      const requestedEdges = req.edges.map((id) => migrateEdgeIdVia(target.aliases, id))
      const migratedToOriginal = new Map<StableId, StableId>()
      req.edges.forEach((originalId, i) => { migratedToOriginal.set(requestedEdges[i], originalId) })
      const colliding = this.#collidingPickedEdgeIds(requestedEdges, candidateIds)
        .map((c) => ({ ...c, id: migratedToOriginal.get(c.id) ?? c.id }))
      if (colliding.length > 0) {
        return {
          ok: false,
          diagnostics: [{
            code: 'REFERENCE_UNRESOLVED',
            severity: 'error',
            params: {
              op: opCode,
              ids: colliding.map((c) => c.id).join(', '),
              collisions: colliding.map((c) => `${c.id} matches ${c.count} distinct edges`).join('; '),
              reason: `${opCode === 'FIL' ? 'fillet' : 'chamfer'} refused: picked edge ${colliding.map((c) => `${c.id} (${c.count} distinct edges share this stable id)`).join(', ')} cannot be resolved to a single edge -- the stable-id grammar collapses two-face edges that share an adjacent-face pair (ICR-3 step 1, docs/stable-id-spec.md). Refusing rather than dressing up the wrong edge; grammar disambiguation is tracked as GEO-16.`,
            },
          }],
        }
      }
      // GEO-16 migration: a persisted pick is resolved against the CURRENT edge
      // ids. A unique pair id is byte-identical old->new (exact); a persisted
      // disambiguated id whose colliding twin was removed upstream binds to the
      // lone survivor (migrated). An OLD BARE id that never carried the
      // disambiguator yet now names a collided pair is AMBIGUOUS -- refused by
      // name (the old format lost the discriminating info; never a silent
      // rebind), the same fail-loud refusal shape the collision guard uses.
      const byId = new Map(candidates.map((c) => [c.id, c] as const))
      const edgeHandles: ShapeHandle[] = []
      const missing: StableId[] = []
      const ambiguous: Array<{ id: StableId; count: number }> = []
      // Index-aligned with req.edges: resolve the ALIAS-MIGRATED id, but report
      // the caller's ORIGINAL id in every refusal (that is the id their document
      // holds and the one they can act on).
      req.edges.forEach((originalId, i) => {
        const res = resolvePersistedEdgeId(requestedEdges[i], candidateIds)
        if (res.status === 'exact' || res.status === 'migrated') {
          const c = byId.get(res.id)
          if (c) edgeHandles.push(c.handle); else missing.push(originalId)
        } else if (res.status === 'ambiguous') {
          ambiguous.push({ id: originalId, count: res.count })
        } else {
          missing.push(originalId)
        }
      })
      if (ambiguous.length > 0) {
        return {
          ok: false,
          diagnostics: [{
            code: 'REFERENCE_UNRESOLVED',
            severity: 'error',
            params: {
              op: opCode,
              ids: ambiguous.map((c) => c.id).join(', '),
              collisions: ambiguous.map((c) => `${c.id} matches ${c.count} distinct edges`).join('; '),
              reason: `${opCode === 'FIL' ? 'fillet' : 'chamfer'} refused: persisted edge ${ambiguous.map((c) => `${c.id} (base pair now names ${c.count} distinct edges)`).join(', ')} was saved under the pre-GEO-16 grammar and cannot be migrated to a single physical edge -- the old id never carried a disambiguator. Refusing rather than rebinding to a guessed twin (docs/stable-id-spec.md).`,
            },
          }],
        }
      }
      if (missing.length > 0) {
        return { ok: false, diagnostics: [{ code: 'REFERENCE_UNRESOLVED', severity: 'error', params: { op: opCode, ids: missing.join(', ') } }] }
      }
      const inputHashes = [...target.faceMap.keys()]
      // WO-2093: a refusal also says what WOULD work -- the largest value this
      // kernel can build on these edges (params.largestRadius/largestDistance),
      // which the Model screen turns into its plain-word message.
      const tooLarge = (reason: string): OpResult => {
        const fitKey = `${opCode}|${shapeFingerprint(target.snapshots)}|${[...requestedEdges].sort().join(',')}`
        const known = this.#dressUpFitCache.get(fitKey)
        // Same shape, same edges: an answer below this request still holds.
        const largest = known !== undefined && known < param
          ? known
          : this.#largestFittingDressUp(target.shape as ShapeHandle, edgeHandles, inputHashes, param, invoke)
        if (largest !== undefined) {
          this.#dressUpFitCache.delete(fitKey)
          this.#dressUpFitCache.set(fitKey, largest)
          if (this.#dressUpFitCache.size > 64) this.#dressUpFitCache.delete(this.#dressUpFitCache.keys().next().value!)
        }
        return {
          ok: false,
          diagnostics: [{
            code: failCode,
            severity: 'error',
            params: {
              edges: req.edges.join(', '),
              [paramName]: param,
              // 0 = nothing smaller fits either; absent = not known.
              ...(largest === undefined ? {} : { [opCode === 'FIL' ? 'largestRadius' : 'largestDistance']: largest }),
              reason,
            },
          }],
        }
      }
      let evo: EvolutionData
      try {
        evo = invoke(target.shape as ShapeHandle, edgeHandles, inputHashes, param)
      } catch {
        return tooLarge(`${opCode === 'FIL' ? 'fillet radius' : 'chamfer distance'} ${param} is too large for edge ${req.edges.join(', ')} -- it cannot be constructed without self-intersecting the adjacent faces`)
      }
      let minted = false
      try {
        const valid = k.isValid(evo.result)
        if (!valid) {
          try { k.release(evo.result) } catch { /* already released */ }
          return tooLarge(`${opCode === 'FIL' ? 'fillet radius' : 'chamfer distance'} ${param} produced an invalid result on edge ${req.edges.join(', ')} -- try a smaller ${paramName}`)
        }
        const resultFaces = this.#faceProbes(evo.result)
        const assign = assignCutFaceIds(req.featureId, target.faceMap, decodeEvolution(evo.modified), resultFaces, target.aliases, opCode)
        this.#relabelDressUpBandFaces(assign, evo.result, candidates, opCode, req.featureId)
        const handle = this.#mint({ shape: evo.result as number, faceMap: assign.faceMap, snapshots: assign.snapshots , aliases: target.aliases })
        minted = true
        const geometry = this.#sweepBooleanGeometry(assign, target)
        return {
          ok: true,
          body: handle,
          elementMap: { featureId: req.featureId, modified: assign.modified, generated: assign.generated, deleted: assign.deleted, geometry },
          diagnostics: okDiag(),
        }
      } catch (e) {
        if (!minted) {
          try { k.release(evo.result) } catch { /* already released */ }
        }
        throw e
      }
    } catch (e) {
      return { ok: false, diagnostics: [{ code: 'KERNEL_OP_FAILED', severity: 'error', params: { op: opCode, message: (e instanceof Error ? e.message : String(e)).slice(0, 200) } }] }
    } finally {
      for (const h of allHandles) {
        try { k.release(h) } catch { /* already released */ }
      }
    }
  }

  /** WO-2093: the largest fillet radius / chamfer distance below `tooLarge`
   *  that builds a valid solid on these edges, found by bisection and rounded
   *  down to a value the operator can type. 0 when the search ran and nothing
   *  fits; undefined when the probe budget ran out before anything was known.
   *  Bounded by a probe count, a time budget and the engine's failure budget. */
  #largestFittingDressUp(
    shape: ShapeHandle,
    edges: ShapeHandle[],
    inputHashes: number[],
    tooLarge: number,
    invoke: (shape: ShapeHandle, edges: ShapeHandle[], inputHashes: number[], value: number) => EvolutionData,
  ): number | undefined {
    const k = this.#k()
    const fits = (value: number): boolean => {
      let evo: EvolutionData
      try {
        evo = invoke(shape, edges, inputHashes, value)
      } catch {
        this.#dressUpProbeFailuresLeft--
        return false
      }
      try {
        return k.isValid(evo.result)
      } catch {
        return false
      } finally {
        try { k.release(evo.result) } catch { /* already released */ }
      }
    }
    if (!(tooLarge > 0) || !Number.isFinite(tooLarge)) return undefined
    if (this.#dressUpProbeFailuresLeft <= 0) return undefined
    const deadline = Date.now() + 4000
    let lo = 0
    let hi = tooLarge
    let complete = true
    for (let i = 0; i < 8; i++) {
      if (Date.now() >= deadline || this.#dressUpProbeFailuresLeft <= 0) { complete = false; break }
      const mid = (lo + hi) / 2
      if (fits(mid)) lo = mid
      else hi = mid
      if (lo > 0 && hi - lo <= Math.max(0.01, lo * 0.02)) break
    }
    if (lo <= 0) return complete ? 0 : undefined
    const step = lo >= 10 ? 0.1 : lo >= 0.1 ? 0.01 : 0.001
    const rounded = Math.floor(lo / step + 1e-9) * step
    return rounded > 0 ? Number(rounded.toFixed(3)) : Number(lo.toFixed(4))
  }

  async applyFillet(req: FilletRequest): Promise<OpResult> {
    // GEO-4-R1.3: occt-wasm 3.6.1's BRepFilletAPI auto-propagates the fillet
    // along the whole tangent-connected edge chain and exposes no way to
    // suppress it (proven empirically — see GEO-4 report pathTaken). Rather than
    // silently ignoring propagateTangent:false and rounding more than the caller
    // asked for, refuse loud. `true` (and absent) keep today's propagating
    // behavior. Real non-propagating dress-up is an Architect backlog rider
    // (BK-33), not this WO. Code is the frozen contract's sole fillet-failure
    // code (v0.4 has no dedicated FILLET_FAILED); the reason carries the cause.
    if (req.propagateTangent === false) {
      return {
        ok: false,
        diagnostics: [{
          code: 'FILLET_RADIUS_TOO_LARGE',
          severity: 'error',
          params: {
            edges: req.edges.join(', '),
            radius: req.radius,
            reason: `non-propagating fillet is not supported by the current kernel -- filleting edge ${req.edges.join(', ')} would also round the entire tangent-connected edge chain it belongs to; request propagateTangent:true to proceed with the propagating fillet`,
          },
        }],
      }
    }
    return this.#applyEdgeDressUp(
      req,
      req.radius,
      'radius',
      'FIL',
      'FILLET_RADIUS_TOO_LARGE',
      (shape, edges, inputHashes, radius) => this.#k().filletWithHistory(shape, edges, radius, inputHashes, HM),
    )
  }

  async applyChamfer(req: ChamferRequest): Promise<OpResult> {
    // GEO-4-R1.3: same tangent-chain limitation as applyFillet (occt-wasm's
    // edge dress-up auto-propagates along tangent-connected edges with no
    // suppression). Refuse propagateTangent:false rather than silently
    // chamfering more than the caller asked for; `true`/absent keep today's
    // behavior. See applyFillet for the full rationale + BK-33 backlog rider.
    if (req.propagateTangent === false) {
      return {
        ok: false,
        diagnostics: [{
          code: 'CHAMFER_FAILED',
          severity: 'error',
          params: {
            edges: req.edges.join(', '),
            distance: req.distance,
            reason: `non-propagating chamfer is not supported by the current kernel -- chamfering edge ${req.edges.join(', ')} would also bevel the entire tangent-connected edge chain it belongs to; request propagateTangent:true to proceed with the propagating chamfer`,
          },
        }],
      }
    }
    return this.#applyEdgeDressUp(
      req,
      req.distance,
      'distance',
      'CHM',
      'CHAMFER_FAILED',
      (shape, edges, inputHashes, distance) => this.#k().chamferWithHistory(shape, edges, distance, inputHashes, HM),
    )
  }

  async applyShell(req: ShellRequest): Promise<OpResult> {
    const k = this.#k()
    const target = this.#rec(req.body)
    if (!(req.thickness > 0)) {
      return { ok: false, diagnostics: [{ code: 'SHELL_FAILED', severity: 'error', params: { thickness: req.thickness, reason: `shell thickness must be positive (got ${req.thickness})` } }] }
    }
    if (req.removeFaces.length === 0) {
      return { ok: false, diagnostics: [{ code: 'SHELL_FAILED', severity: 'error', params: { reason: 'shell requires at least one face to remove' } }] }
    }
    const faces = k.getSubShapes(target.shape as ShapeHandle, 'face')
    try {
      const byHash = new Map<number, ShapeHandle>()
      for (const f of faces) byHash.set(k.hashCode(f, HM), f)
      // UI-57-R1 blocker 2: shared resolver (alias-aware), not a raw inversion —
      // a healed-away id in removeFaces must resolve to its winner, not land in
      // `missing` as a REFERENCE_UNRESOLVED.
      const idToHash = this.#faceHashIndex(target)
      const removeHandles: ShapeHandle[] = []
      const missing: StableId[] = []
      for (const id of req.removeFaces) {
        const hash = idToHash.get(id)
        const handle = hash !== undefined ? byHash.get(hash) : undefined
        if (handle !== undefined) removeHandles.push(handle)
        else missing.push(id)
      }
      if (missing.length > 0) {
        return { ok: false, diagnostics: [{ code: 'REFERENCE_UNRESOLVED', severity: 'error', params: { op: 'shell', ids: missing.join(', ') } }] }
      }
      const inputHashes = [...target.faceMap.keys()]
      let evo: EvolutionData
      try {
        evo = k.shellWithHistory(target.shape as ShapeHandle, removeHandles, req.thickness, 1e-6, inputHashes, HM)
      } catch {
        // WO-2107: MakeThickSolid aborts on any blind hole or pocket opened
        // through the removed face. Build the shell the way other CAD tells its
        // users to by hand instead: hollow the plain block, cut each depression
        // back in grown by the wall.
        const constructed = this.#applyShellByConstruction(req, target, removeHandles, faces)
        if (constructed !== null) return constructed
        // WO-2084: MakeThickSolidByJoin can abort before returning any shape
        // for reasons that are not a local thickness collision (the recorded
        // Step Test With Holes face does so even at 0.1 mm, after shape-fix,
        // and at both documented tolerances). The facade exposes only a WASM
        // exception, not OCCT's native status. Report the boundary we actually
        // observed instead of inventing "exceeds the local wall geometry".
        const retainedFaceCount = target.faceMap.size - removeHandles.length
        // Form stage 7 (measured): a form's exact faces offset, with bosses,
        // holes and fillets on them, but not once a cut trims them (a slot
        // across a form's crown) - while the same cut on the shelled form works.
        const ids = [...target.faceMap.values()]
        const formFaces = ids.filter((id) => /^FRM\d+:step:face#\d+$/.test(id))
        const trimmedForm = formFaces.length > 0 && formFaces.length < ids.length
          ? ` Offsets stop where a cut trims form faces (${formFaces[0].split(':')[0]}); Shell the form before that cut, then cut - that order works.`
          : ''
        return {
          ok: false,
          diagnostics: [{
            code: 'SHELL_FAILED',
            severity: 'error',
            params: {
              faces: req.removeFaces.join(', '),
              thickness: req.thickness,
              reason: `shell kernel stopped while constructing inward offsets for ${retainedFaceCount} retained face(s) after opening ${req.removeFaces.join(', ')} at thickness ${req.thickness}; it produced no result shape and the source body was left unchanged.${trimmedForm}`,
            },
          }],
        }
      }
      let minted = false
      try {
        const valid = k.isValid(evo.result)
        // Defense against occt-wasm silently returning a topologically
        // "valid" but geometrically nonsensical shell once thickness exceeds
        // the local wall geometry (verified empirically: isValid() alone
        // does NOT catch this — beyond the true infeasibility boundary the
        // op stops throwing and instead returns a shape whose volume is
        // statistically indistinguishable from the UNSHELLED target, i.e. it
        // removed no material at all). Requiring a non-trivial volume delta
        // (not mere floating-point noise) catches that class without
        // rejecting legitimate near-degenerate thin walls (feedback_gates_
        // mask_defects: measure the real thing, not a proxy).
        const targetVolume = k.getVolume(target.shape as ShapeHandle)
        const resultVolume = valid ? k.getVolume(evo.result) : 0
        const meaningfulRemoval = valid && (targetVolume - resultVolume) > targetVolume * 1e-9
        if (!meaningfulRemoval) {
          try { k.release(evo.result) } catch { /* already released */ }
          // WO-2107: a silent no-op is the same kernel failure in another
          // form (a chamfered block does this); try the construction first.
          const constructed = this.#applyShellByConstruction(req, target, removeHandles, faces)
          if (constructed !== null) return constructed
          return {
            ok: false,
            diagnostics: [{
              code: 'SHELL_FAILED',
              severity: 'error',
              params: {
                faces: req.removeFaces.join(', '),
                thickness: req.thickness,
                reason: `shell thickness ${req.thickness} produced no meaningful hollow near face ${req.removeFaces.join(', ')} -- try a smaller thickness`,
              },
            }],
          }
        }
        const resultFaces = this.#faceProbes(evo.result)
        const assign = assignShellFaceIds(req.featureId, target.faceMap, decodeEvolution(evo.modified), decodeEvolution(evo.generated), resultFaces, target.aliases)
        this.#nameShellBlends(req.featureId, assign, evo.result)
        // GEO-4-R1.4: no silent minting of off-grammar positional ids. If any
        // result face could not be traced to a generating face via shell's
        // evolution channels, refuse rather than persist a non-derived lineage
        // (a silent wrong-binding once saved — stable-id-spec §3). Well-formed
        // shells never hit this (spawn channel is reliable, verified).
        if (assign.unmapped.length > 0) {
          try { k.release(evo.result) } catch { /* already released */ }
          const topo = assign.unmapped
            .map((p) => `a ${p.snapshot.type} face near (${p.snapshot.centroid.map((n) => n.toFixed(2)).join(', ')})`)
            .join('; ')
          return {
            ok: false,
            diagnostics: [{
              code: 'SHELL_FAILED',
              severity: 'error',
              params: {
                faces: req.removeFaces.join(', '),
                thickness: req.thickness,
                reason: `shell of face ${req.removeFaces.join(', ')} produced ${assign.unmapped.length} face(s) the kernel could not trace to a generating face (${topo}) -- refusing to persist a stable id the design tree could not re-derive`,
              },
            }],
          }
        }
        const handle = this.#mint({ shape: evo.result as number, faceMap: assign.faceMap, snapshots: assign.snapshots , aliases: target.aliases })
        minted = true
        const geometry = this.#sweepBooleanGeometry(assign, target)
        return {
          ok: true,
          body: handle,
          elementMap: { featureId: req.featureId, modified: assign.modified, generated: assign.generated, deleted: assign.deleted, geometry },
          diagnostics: okDiag(),
        }
      } catch (e) {
        if (!minted) {
          try { k.release(evo.result) } catch { /* already released */ }
        }
        throw e
      }
    } catch (e) {
      return { ok: false, diagnostics: [{ code: 'KERNEL_OP_FAILED', severity: 'error', params: { op: 'shell', message: (e instanceof Error ? e.message : String(e)).slice(0, 200) } }] }
    } finally {
      for (const f of faces) {
        try { k.release(f) } catch { /* already released */ }
      }
    }
  }

  /** Names the rounded walls a shell builds round re-entrant edges (nameShellBlendFaces) from their neighbours in `shape`. */
  #nameShellBlends(featureId: string, assign: ShellAssignment, shape: ShapeHandle): void {
    if (assign.unmapped.length === 0) return
    const k = this.#k()
    const faces = k.getSubShapes(shape, 'face')
    try {
      const byHash = new Map<number, ShapeHandle>()
      for (const f of faces) byHash.set(k.hashCode(f, HM), f)
      nameShellBlendFaces(featureId, assign, (hash) => {
        const face = byHash.get(hash)
        if (face === undefined) return []
        const adj = k.adjacentFaces(shape, face)
        try { return adj.map((a) => k.hashCode(a, HM)) } finally { for (const a of adj) { try { k.release(a) } catch { /* already released */ } } }
      })
    } finally {
      for (const f of faces) { try { k.release(f) } catch { /* already released */ } }
    }
  }

  /**
   * WO-2107: Shell by construction, used only after MakeThickSolid failed.
   * Hollow the simple shape first and add the openings after, so complex
   * depressions do not prevent the kernel from building the cavity:
   *  1. depressions = the blind holes/pockets opened through the removed face
   *     (faces reached from its inner loops without touching its outer loop);
   *  2. hollow the plain block (those depressions filled, then - if the kernel
   *     still refuses - its small faces too) with MakeThickSolid;
   *  3. keep a wall round each depression: its floor outline grown by the
   *     thickness, extruded from the floor minus the thickness to past the
   *     opening, cut out of the block's cavity;
   *  4. cut that cavity from the ORIGINAL part, so every chamfer is untouched.
   * Proven in raw kernel probes (src/tests/evidence/WO-2086, WO-2107). Face ids
   * follow the shell grammar: the opened face keeps its id (or splits `#j`),
   * every retained face keeps its id, and each new wall is the `:inner`
   * companion of the source face it lies the wall thickness away from.
   *
   * When the walls cannot join up (blind depressions shallower than the floor
   * at a thin wall), the result would be several separate pieces; the shell
   * then fails with a message naming the piece count
   * and the thinnest wall the software measured to keep it one piece.
   *
   * Returns null when the route does not apply or the kernel cannot build it,
   * leaving the caller's own failure message in place. Never mutates the body.
   */
  #applyShellByConstruction(req: ShellRequest, target: BodyRecord, removeHandles: ShapeHandle[], sourceFaces: ShapeHandle[]): OpResult | null {
    const k = this.#k()
    const scratch: ShapeHandle[] = []
    const own = <T extends ShapeHandle>(h: T): T => { scratch.push(h); return h }
    const ownAll = (hs: ShapeHandle[]): ShapeHandle[] => { scratch.push(...hs); return hs }
    let adopted: ShapeHandle | undefined
    const t = req.thickness
    const source = target.shape as ShapeHandle
    try {
      if (removeHandles.length !== 1) return null
      const plan = this.#shellConstructionPlan(source, removeHandles[0], sourceFaces, own, ownAll)
      if (plan === null) return null
      const inputHashes = [...target.faceMap.keys()]
      const retained = plan.retainedHashes

      // The route is trusted only while it opens the removed face and leaves
      // every other face of the part exactly as it was.
      const keepsRetainedFaces = (shape: ShapeHandle, ownFn: typeof own): boolean => {
        const present = new Set(k.getSubShapes(shape, 'face').map((f) => k.hashCode(ownFn(f), HM)))
        for (const h of retained) if (!present.has(h)) return false
        return true
      }

      let evo: EvolutionData
      try {
        const cavity = this.#shellConstructionCavity(plan, t, own)
        if (cavity === null) return null
        evo = k.cutWithHistory(source, cavity, inputHashes, HM)
        own(evo.result)
      } catch {
        return null
      }
      if (!k.isValid(evo.result) || !keepsRetainedFaces(evo.result, own)) return null
      const solids = ownAll(k.getSubShapes(evo.result, 'solid'))
      if (solids.length === 0) return null

      if (solids.length > 1) {
        const onePiece = this.#shellOnePieceThickness(plan, t, source, keepsRetainedFaces)
        const faces = req.removeFaces.join(', ')
        const fix = onePiece !== null
          ? `The thinnest wall that keeps it one piece is ${onePiece} mm.`
          : 'No wall thickness Shell can build keeps it in one piece.'
        return {
          ok: false,
          diagnostics: [{
            code: 'SHELL_FAILED',
            severity: 'error',
            params: {
              faces,
              thickness: t,
              pieces: solids.length,
              ...(onePiece !== null ? { onePieceThickness: onePiece } : {}),
              reason: `a ${t} mm shell opening ${faces} would split this part into ${solids.length} separate pieces: once that face is open, the ${t} mm walls round some of its holes or pockets touch nothing else. ${fix} The body was left unchanged.`,
            },
          }],
        }
      }

      const solid = solids[0]
      const targetVolume = k.getVolume(source)
      if (!(targetVolume - k.getVolume(solid) > targetVolume * 1e-9)) return null

      // Opened-face evolution (a retrim to a rim, or a split) from the cut.
      const inputSet = new Set(inputHashes)
      const removedRecords = decodeEvolution(evo.modified)
        .map((r) => ({ inHash: r.inHash, outHashes: r.outHashes.filter((h) => !inputSet.has(h)) }))
      const modifiedOuts = new Set(removedRecords.flatMap((r) => r.outHashes))
      // Every other new face is a wall: name it after the source face it lies
      // exactly the wall thickness away from, along its own normal.
      const spawned = new Map<number, number[]>()
      const sourceBoxes = plan.retainedFaces.map((f) => ({ face: f, hash: k.hashCode(f, HM), box: k.getBoundingBox(f, false) }))
      const tol = 1e-3
      for (const f of ownAll(k.getSubShapes(solid, 'face'))) {
        const hash = k.hashCode(f, HM)
        if (inputSet.has(hash) || modifiedOuts.has(hash)) continue
        const sample = this.#faceInteriorSample(f)
        if (sample === null) continue // left unmapped -> refused below
        let best: { hash: number; d: number; id: StableId } | undefined
        for (const sign of [1, -1]) {
          const q = { x: sample.p.x + sign * sample.n.x * t, y: sample.p.y + sign * sample.n.y * t, z: sample.p.z + sign * sample.n.z * t }
          const vertex = own(k.makeVertex(q.x, q.y, q.z))
          for (const s of sourceBoxes) {
            const b = s.box
            if (q.x < b.xmin - tol || q.x > b.xmax + tol || q.y < b.ymin - tol || q.y > b.ymax + tol || q.z < b.zmin - tol || q.z > b.zmax + tol) continue
            const d = k.distanceBetween(vertex, s.face)
            if (d >= tol) continue
            const id = target.faceMap.get(s.hash) ?? ''
            if (best === undefined || d < best.d - 1e-9 || (Math.abs(d - best.d) <= 1e-9 && compareIds(id, best.id) < 0)) best = { hash: s.hash, d, id }
          }
        }
        if (best !== undefined) spawned.set(best.hash, [...(spawned.get(best.hash) ?? []), hash])
      }
      const spawnedRecords = [...spawned].map(([inHash, outHashes]) => ({ inHash, outHashes }))
      const assign = assignShellFaceIds(req.featureId, target.faceMap, removedRecords, spawnedRecords, this.#faceProbes(solid), target.aliases)
      this.#nameShellBlends(req.featureId, assign, solid)
      // A wall no source face accounts for would need an id the design tree
      // could not re-derive (GEO-4-R1.4): do not persist it; the caller's own
      // shell-failed message stands.
      if (assign.unmapped.length > 0) return null
      adopted = solid
      const handle = this.#mint({ shape: solid as number, faceMap: assign.faceMap, snapshots: assign.snapshots, aliases: target.aliases })
      const geometry = this.#sweepBooleanGeometry(assign, target)
      return {
        ok: true,
        body: handle,
        elementMap: { featureId: req.featureId, modified: assign.modified, generated: assign.generated, deleted: assign.deleted, geometry },
        diagnostics: okDiag(),
      }
    } catch {
      return null
    } finally {
      for (const h of scratch) {
        if (h === adopted) continue
        try { k.release(h) } catch { /* already released */ }
      }
    }
  }

  /** WO-2107: what the construction needs from the part, found once. Null when
   *  the removed face is not planar or opens no blind depression. */
  #shellConstructionPlan(
    source: ShapeHandle,
    removed: ShapeHandle,
    sourceFaces: ShapeHandle[],
    own: <T extends ShapeHandle>(h: T) => T,
    ownAll: (hs: ShapeHandle[]) => ShapeHandle[],
  ): ShellConstructionPlan | null {
    const k = this.#k()
    if (k.surfaceType(removed) !== 'plane') return null
    const sample = this.#faceInteriorSample(removed)
    if (sample === null) return null
    // Outward normal: a step against it lands inside the part.
    const eps = 1e-3
    let n = sample.n
    const inward = { x: sample.p.x - n.x * eps, y: sample.p.y - n.y * eps, z: sample.p.z - n.z * eps }
    if (!k.containsPoint(source, inward)) n = { x: -n.x, y: -n.y, z: -n.z }
    const origin = sample.p
    const depthBelow = (p: { x: number; y: number; z: number }) =>
      (origin.x - p.x) * n.x + (origin.y - p.y) * n.y + (origin.z - p.z) * n.z

    const byHash = new Map<number, ShapeHandle>()
    for (const f of sourceFaces) byHash.set(k.hashCode(f, HM), f)
    const removedHash = k.hashCode(removed, HM)
    const outerEdges = new Set(ownAll(k.getSubShapes(own(k.outerWire(removed)), 'edge')).map((e) => k.hashCode(e, HM)))
    const around = ownAll(k.adjacentFaces(source, removed))
    const rimFaces = new Set<number>()
    const seeds: number[] = []
    for (const f of around) {
      const shared = ownAll(k.sharedEdges(removed, f)).map((e) => k.hashCode(e, HM))
      const h = k.hashCode(f, HM)
      if (shared.some((e) => outerEdges.has(e))) rimFaces.add(h)
      if (shared.some((e) => !outerEdges.has(e))) seeds.push(h)
    }
    // Flood each inner loop's faces without crossing the removed face. A
    // component that reaches the removed face's outer loop is not a blind
    // depression (a through hole reaches the far side and the outer walls).
    const seen = new Set<number>([removedHash])
    const depressions: number[][] = []
    for (const seed of seeds) {
      if (seen.has(seed)) continue
      seen.add(seed)
      const component: number[] = []
      const stack = [seed]
      let open = false
      while (stack.length > 0) {
        const h = stack.pop()!
        component.push(h)
        if (rimFaces.has(h)) open = true
        const face = byHash.get(h)
        if (face === undefined) return null
        for (const g of ownAll(k.adjacentFaces(source, face))) {
          const gh = k.hashCode(g, HM)
          if (seen.has(gh)) continue
          seen.add(gh)
          stack.push(gh)
        }
      }
      if (!open) depressions.push(component)
    }
    if (depressions.length === 0) return null

    // Each depression's floors: planes facing the opening, below it.
    const floors: ShellConstructionPlan['floors'] = []
    for (const component of depressions) {
      let found = 0
      for (const h of component) {
        const face = byHash.get(h)!
        if (k.surfaceType(face) !== 'plane') continue
        const fs = this.#faceInteriorSample(face)
        if (fs === null) continue
        if (Math.abs(fs.n.x * n.x + fs.n.y * n.y + fs.n.z * n.z) < 0.999) continue
        const depth = depthBelow(fs.p)
        if (!(depth > 1e-6)) continue
        floors.push({ wire: own(k.outerWire(face)), depth })
        found++
      }
      if (found === 0) return null
    }
    const block0 = own(k.defeature(source, depressions.flat().map((h) => byHash.get(h)!), 1e-6))
    if (!k.isValid(block0)) return null
    // Every face but the opened one - depression walls included - must come
    // through the construction untouched.
    const retainedFaces = sourceFaces.filter((f) => k.hashCode(f, HM) !== removedHash)
    return {
      n,
      origin,
      floors,
      block0,
      blocks: [block0],
      stage: 0,
      retainedFaces,
      retainedHashes: retainedFaces.map((f) => k.hashCode(f, HM)),
      own,
    }
  }

  /** WO-2107: the cavity to cut from the part at wall `t`, or null. */
  #shellConstructionCavity(plan: ShellConstructionPlan, t: number, own: <T extends ShapeHandle>(h: T) => T): ShapeHandle | null {
    const k = this.#k()
    const { n } = plan
    // Hollow the plain block. A block that still carries small faces (outer
    // chamfers) comes back from MakeThickSolid with nothing removed
    // (probe-block.mjs); take those off too and try again.
    let cavity0: ShapeHandle | null = null
    for (let stage = plan.stage; stage < 2 && cavity0 === null; stage++) {
      if (stage === 1 && plan.blocks.length === 1) {
        const faces = k.getSubShapes(plan.block0, 'face').map((f) => plan.own(f))
        const areas = faces.map((f) => k.getSurfaceArea(f))
        const top = this.#blockOpening(plan, faces)
        const maxArea = Math.max(...areas)
        const small = faces.filter((f, i) => f !== top && areas[i] < 0.02 * maxArea)
        if (small.length === 0) break
        try {
          const block1 = plan.own(k.defeature(plan.block0, small, 1e-6))
          if (!k.isValid(block1)) break
          plan.blocks.push(block1)
        } catch { break }
      }
      const block = plan.blocks[stage]
      if (block === undefined) break
      const top = this.#blockOpening(plan, k.getSubShapes(block, 'face').map((f) => own(f)))
      if (top === null) continue
      try {
        const hollow = own(k.shell(block, [top], t, 1e-6))
        const blockVolume = k.getVolume(block)
        if (!k.isValid(hollow) || !(blockVolume - k.getVolume(hollow) > blockVolume * 1e-9)) continue
        cavity0 = own(k.cut(block, hollow))
        plan.stage = stage
      } catch { continue }
    }
    if (cavity0 === null) return null
    const tools: ShapeHandle[] = []
    for (const floor of plan.floors) {
      const outline = this.#grownOutline(floor.wire, t, own)
      if (outline === null) return null
      // offsetWire2D applies a floor edge's own placement a second time (a hole
      // floor made by extruding a sketch sits `depth` away from its sketch, and
      // the grown outline came back that far off again): put it back on the
      // floor's plane before lowering it
      const at = this.#faceInteriorSample(outline)
      if (at === null) return null
      const drift = floor.depth - ((plan.origin.x - at.p.x) * n.x + (plan.origin.y - at.p.y) * n.y + (plan.origin.z - at.p.z) * n.z)
      const lowered = own(k.translate(outline, -n.x * (t + drift), -n.y * (t + drift), -n.z * (t + drift)))
      const reach = floor.depth + 2 * t
      const prism = own(k.extrude(lowered, n.x * reach, n.y * reach, n.z * reach))
      tools.push(k.isValid(prism) ? prism : own(k.fixShape(prism)))
    }
    return own(k.cutAll(cavity0, tools))
  }

  /** WO-2107: the block's face lying on the removed face's plane. */
  #blockOpening(plan: ShellConstructionPlan, faces: ShapeHandle[]): ShapeHandle | null {
    const k = this.#k()
    const { n, origin } = plan
    let best: ShapeHandle | null = null
    let bestArea = 0
    for (const f of faces) {
      if (k.surfaceType(f) !== 'plane') continue
      const s = this.#faceInteriorSample(f)
      if (s === null) continue
      if (Math.abs(s.n.x * n.x + s.n.y * n.y + s.n.z * n.z) < 0.999) continue
      const off = (origin.x - s.p.x) * n.x + (origin.y - s.p.y) * n.y + (origin.z - s.p.z) * n.z
      if (Math.abs(off) > 1e-5) continue
      const area = k.getSurfaceArea(f)
      if (area > bestArea) { best = f; bestArea = area }
    }
    return best
  }

  /** WO-2107: a floor's outline pushed out by `t`, as a planar face. Offset
   *  curves (from B-spline floor edges) are re-fitted as plain B-splines: the
   *  STEP writer throws on extrusions of offset curves (probe-export.mjs). */
  #grownOutline(wire: ShapeHandle, t: number, own: <T extends ShapeHandle>(h: T) => T): ShapeHandle | null {
    const k = this.#k()
    const plain = k.getSurfaceArea(own(k.makeFace(wire)))
    // offsetWire2D's side follows the wire's orientation. Find the growing
    // side with a tiny offset and only then offset by t: asking for the
    // collapsing side (a 2.5 mm hole shrunk by 2.5 mm) corrupts the kernel's
    // heap, and every later STEP export dies with "memory access out of
    // bounds" (probe-export-route.mjs).
    const tiny = Math.min(t, 1e-2)
    let side = 0
    for (const d of [1, -1]) {
      try {
        if (k.getSurfaceArea(own(k.makeFace(own(k.offsetWire2D(wire, d * tiny))))) > plain) { side = d; break }
      } catch { /* the other side */ }
    }
    if (side === 0) return null
    const grown = own(k.offsetWire2D(wire, side * t))
    if (!(k.getSurfaceArea(own(k.makeFace(grown))) > plain)) return null
    const edges = k.getSubShapes(grown, 'edge').map((e) => own(e))
    if (edges.every((e) => k.curveType(e) !== 'offset')) return own(k.makeFace(grown))
    try {
      const refit = edges.map((e) => {
        if (k.curveType(e) !== 'offset') return e
        const { first, last } = k.curveParameters(e)
        const samples = 32
        const points = Array.from({ length: samples + 1 }, (_, i) => k.curvePointAtParam(e, first + ((last - first) * i) / samples))
        return own(k.interpolatePointsWithTangents(points, k.curveTangent(e, first), k.curveTangent(e, last)))
      })
      return own(k.makeFace(own(k.makeWire(refit))))
    } catch {
      return own(k.makeFace(grown))
    }
  }

  /** WO-2107: the thinnest wall, on a 0.1 mm grid above `t`, at which the
   *  construction is one piece; null when none the block can take is. */
  #shellOnePieceThickness(
    plan: ShellConstructionPlan,
    t: number,
    source: ShapeHandle,
    keepsRetainedFaces: (shape: ShapeHandle, own: <T extends ShapeHandle>(h: T) => T) => boolean,
  ): number | null {
    const k = this.#k()
    const piecesAt = (w: number): number | null => {
      const scratch: ShapeHandle[] = []
      const own = <T extends ShapeHandle>(h: T): T => { scratch.push(h); return h }
      try {
        const cavity = this.#shellConstructionCavity(plan, w, own)
        if (cavity === null) return null
        const result = own(k.cut(source, cavity))
        if (!k.isValid(result) || !keepsRetainedFaces(result, own)) return null
        return k.getSubShapes(result, 'solid').map((s) => own(s)).length
      } catch {
        return null
      } finally {
        for (const h of scratch) { try { k.release(h) } catch { /* already released */ } }
      }
    }
    let lo = t
    let hi: number | null = null
    for (let w = Math.floor(t / 0.5 + 1e-9) * 0.5 + 0.5, tries = 0; tries < 24; w += 0.5, tries++) {
      const pieces = piecesAt(w)
      if (pieces === null) break
      if (pieces === 1) { hi = w; break }
      lo = w
    }
    if (hi === null) return null
    let low = Math.floor(lo * 10 + 1e-9)
    let high = Math.round(hi * 10)
    while (high - low > 1) {
      const mid = Math.floor((low + high) / 2)
      if (piecesAt(mid / 10) === 1) high = mid
      else low = mid
    }
    return high / 10
  }

  /** WO-2107: a point inside a face's trimmed area and the unit surface normal
   *  there (orientation as the surface reports it). */
  #faceInteriorSample(face: ShapeHandle): { p: { x: number; y: number; z: number }; n: { x: number; y: number; z: number } } | null {
    const k = this.#k()
    const uv = k.uvBounds(face)
    const fractions = [0.5, 0.25, 0.75, 0.125, 0.375, 0.625, 0.875, 0.0625, 0.9375]
    for (const fu of fractions) {
      for (const fv of fractions) {
        const u = uv.uMin + (uv.uMax - uv.uMin) * fu
        const v = uv.vMin + (uv.vMax - uv.vMin) * fv
        if (k.classifyPointOnFace(face, u, v) !== 'in') continue
        const raw = k.surfaceNormal(face, u, v)
        const length = Math.hypot(raw.x, raw.y, raw.z)
        if (!(length > 1e-12)) continue
        return { p: k.pointOnSurface(face, u, v), n: { x: raw.x / length, y: raw.y / length, z: raw.z / length } }
      }
    }
    return null
  }

  /**
   * WO-2085: retry a draft whose selected planar wall is surrounded entirely
   * by one uniform 45 deg planar chamfer collar. OCCT's draft builder extends
   * the wall through those four chamfers but returns an invalid solid; none of
   * fixShape/healSolid/unifySameDomain repairs it. Removing the collar first,
   * drafting the exposed wall, then rebuilding the same four equal-distance
   * chamfers is the kernel route that preserves the intended feature order.
   *
   * This is deliberately a narrow fallback after the ordinary draft returned
   * invalid. Every geometric precondition is proved from the live B-rep; any
   * different adjacency leaves the established direct-draft refusal unchanged.
   */
  #draftThroughPlanarChamferCollar(
    shape: ShapeHandle,
    face: ShapeHandle,
    angleRad: number,
    direction: { x: number; y: number; z: number },
  ): ShapeHandle | null {
    const k = this.#k()
    const adjacent = k.adjacentFaces(shape, face)
    const scratch: ShapeHandle[] = []
    let adopted: ShapeHandle | undefined
    try {
      if (adjacent.length !== 4) return null
      const target = this.#probeFace(face).snapshot
      if (target.type !== 'plane') return null
      const targetN = normalize(target.normal as Vec3T)
      const chamferCenters: Vec3T[] = []
      const widths: number[] = []

      for (const neighbour of adjacent) {
        const neighbourProbe = this.#probeFace(neighbour).snapshot
        if (neighbourProbe.type !== 'plane') return null
        const neighbourN = normalize(neighbourProbe.normal as Vec3T)
        const inclination = Math.abs(dot(targetN, neighbourN))
        if (Math.abs(inclination - Math.SQRT1_2) > 1e-4) return null

        const shared = k.sharedEdges(face, neighbour)
        try {
          if (shared.length !== 1) return null
        } finally {
          for (const edge of shared) { try { k.release(edge) } catch { /* */ } }
        }

        const vertices = k.getSubShapes(neighbour, 'vertex')
        try {
          let width = 0
          for (const vertex of vertices) {
            const p = k.vertexPosition(vertex)
            width = Math.max(width, Math.abs(dot(targetN, sub([p.x, p.y, p.z], target.centroid as Vec3T))))
          }
          if (!(width > 1e-6) || !Number.isFinite(width)) return null
          widths.push(width)
          chamferCenters.push(neighbourProbe.centroid as Vec3T)
        } finally {
          for (const vertex of vertices) { try { k.release(vertex) } catch { /* */ } }
        }
      }

      const chamferDistance = widths.reduce((sum, width) => sum + width, 0) / widths.length
      if (widths.some((width) => Math.abs(width - chamferDistance) > Math.max(1e-5, chamferDistance * 1e-4))) return null

      const stripped = k.defeature(shape, adjacent, 1e-6)
      scratch.push(stripped)
      if (!k.isValid(stripped) || !k.isSolid(stripped)) return null

      const strippedFaces = k.getSubShapes(stripped, 'face')
      let strippedFace: ShapeHandle | undefined
      let strippedSnapshot: GeometrySnapshot | undefined
      try {
        const candidates: Array<{ face: ShapeHandle; snapshot: GeometrySnapshot }> = []
        for (const candidate of strippedFaces) {
          const snapshot = this.#probeFace(candidate).snapshot
          if (snapshot.type !== 'plane') continue
          const candidateN = normalize(snapshot.normal as Vec3T)
          if (Math.abs(Math.abs(dot(targetN, candidateN)) - 1) > 1e-6) continue
          if (Math.abs(dot(targetN, sub(snapshot.centroid as Vec3T, target.centroid as Vec3T))) > 1e-5) continue
          candidates.push({ face: candidate, snapshot })
        }
        if (candidates.length !== 1) return null
        strippedFace = candidates[0].face
        strippedSnapshot = candidates[0].snapshot
        const drafted = k.draft(stripped, strippedFace, angleRad, direction)
        scratch.push(drafted)
        if (!k.isValid(drafted) || !k.isSolid(drafted)) return null

        const draftedProbes = this.#faceProbes(drafted)
        const bbox = this.#bodyBBox(drafted)
        const pull = normalize([direction.x, direction.y, direction.z])
        let lo = 0, hi = 0
        for (const i of [0, 1, 2] as const) {
          const a = pull[i] * bbox.min[i], b = pull[i] * bbox.max[i]
          lo += Math.min(a, b); hi += Math.max(a, b)
        }
        const rebound = rebindDraftFaces(
          ['WO2085:collar-wall'],
          new Map([['WO2085:collar-wall', strippedSnapshot]]),
          draftedProbes,
          { editedId: 'WO2085:collar-wall', angleRad, motionBudget: Math.tan(angleRad) * Math.max(Math.abs(lo), Math.abs(hi)) },
        )
        if (rebound.unresolved.length > 0) return null
        const draftedHash = [...rebound.faceMap.keys()][0]

        const draftedFaces = k.getSubShapes(drafted, 'face')
        try {
          const draftedFace = draftedFaces.find((candidate) => k.hashCode(candidate, HM) === draftedHash)
          if (draftedFace === undefined) return null
          const boundaryEdges = k.getSubShapes(draftedFace, 'edge')
          try {
            if (boundaryEdges.length < adjacent.length) return null
            const remaining = new Set(boundaryEdges)
            const selected: ShapeHandle[] = []
            for (const center of chamferCenters) {
              let nearest: ShapeHandle | undefined
              let nearestDistance = Infinity
              let tied = false
              for (const edge of remaining) {
                const edgeCenter = k.getLinearCenterOfMass(edge)
                const distance = len(sub([edgeCenter.x, edgeCenter.y, edgeCenter.z], center))
                if (distance < nearestDistance - 1e-9) {
                  nearest = edge
                  nearestDistance = distance
                  tied = false
                } else if (Math.abs(distance - nearestDistance) <= 1e-9) {
                  tied = true
                }
              }
              if (nearest === undefined || tied || nearestDistance > chamferDistance * 3) return null
              selected.push(nearest)
              remaining.delete(nearest)
            }

            const rechamfered = k.chamfer(drafted, selected, chamferDistance)
            const singled = this.#asSingleSolid(rechamfered, scratch)
            if (!singled.ok || singled.shape === undefined) {
              if (!scratch.includes(rechamfered)) scratch.push(rechamfered)
              return null
            }
            if (!k.isValid(singled.shape) || !k.isSolid(singled.shape)) {
              if (!scratch.includes(singled.shape)) scratch.push(singled.shape)
              return null
            }
            adopted = singled.shape
            return adopted
          } finally {
            for (const edge of boundaryEdges) { try { k.release(edge) } catch { /* */ } }
          }
        } finally {
          for (const candidate of draftedFaces) { try { k.release(candidate) } catch { /* */ } }
        }
      } finally {
        for (const candidate of strippedFaces) { try { k.release(candidate) } catch { /* */ } }
      }
    } catch {
      return null
    } finally {
      for (const neighbour of adjacent) { try { k.release(neighbour) } catch { /* */ } }
      for (const transient of scratch) {
        if (transient === adopted) continue
        try { k.release(transient) } catch { /* */ }
      }
    }
  }

  async applyDraft(req: DraftRequest): Promise<OpResult> {
    const k = this.#k()
    const target = this.#rec(req.body)
    if (!(req.angleDeg > 0) || req.angleDeg >= 90) {
      return {
        ok: false,
        diagnostics: [{
          code: 'DRAFT_FAILED',
          severity: 'error',
          params: {
            faces: req.faces.join(', '),
            angleDeg: req.angleDeg,
            reason: `draft angle ${req.angleDeg} deg is not physically constructible (must be strictly between 0 and 90 degrees) for face ${req.faces.join(', ')}`,
          },
        }],
      }
    }
    if (req.faces.length === 0) {
      return { ok: false, diagnostics: [{ code: 'DRAFT_FAILED', severity: 'error', params: { reason: 'draft requires at least one face' } }] }
    }

    const angleRad = (req.angleDeg * Math.PI) / 180
    const pullDir = { x: req.pullDir.x, y: req.pullDir.y, z: req.pullDir.z }
    const pdLen = Math.hypot(pullDir.x, pullDir.y, pullDir.z)
    if (!(pdLen > 0)) {
      return { ok: false, diagnostics: [{ code: 'DRAFT_FAILED', severity: 'error', params: { faces: req.faces.join(', '), reason: `draft pull direction must be a non-zero vector for face ${req.faces.join(', ')}` } }] }
    }
    // unit pull direction — also the normal of the neutral plane occt-wasm
    // actually drafts about (see R1.1 below).
    const pdu = { x: pullDir.x / pdLen, y: pullDir.y / pdLen, z: pullDir.z / pdLen }

    // GEO-4-R1.1: occt-wasm 3.6.1's draft wrapper takes only (shape, face,
    // angleRad, direction) — it exposes NO neutral-plane parameter, and the
    // empirical probe proved the plane it drafts about is FIXED: the plane
    // through the WORLD ORIGIN with normal = pullDir (translating the body along
    // the pull axis leaves the neutral fibre at world z=0, i.e. the plane does
    // NOT ride the shape). So req.neutralPlane cannot be wired through. Rather
    // than silently drafting about a DIFFERENT plane than the caller asked for
    // (the pre-R1 bug), accept only requests whose neutral plane coincides with
    // the one the kernel implies, and refuse anything else. Two planes coincide
    // iff their normals are parallel AND the request's plane passes through the
    // world origin along the pull axis. (BK-33-adjacent: a real per-face neutral
    // plane needs a lower-level kernel surface occt-wasm 3.6.1 does not expose.)
    const npN = req.neutralPlane.normal
    const npNLen = Math.hypot(npN.x, npN.y, npN.z)
    if (!(npNLen > 0)) {
      return { ok: false, diagnostics: [{ code: 'DRAFT_FAILED', severity: 'error', params: { faces: req.faces.join(', '), reason: `draft neutral-plane normal must be a non-zero vector for face ${req.faces.join(', ')}` } }] }
    }
    const nnu = { x: npN.x / npNLen, y: npN.y / npNLen, z: npN.z / npNLen }
    const crossMag = Math.hypot(
      pdu.y * nnu.z - pdu.z * nnu.y,
      pdu.z * nnu.x - pdu.x * nnu.z,
      pdu.x * nnu.y - pdu.y * nnu.x,
    )
    const originOffset = req.neutralPlane.origin.x * pdu.x + req.neutralPlane.origin.y * pdu.y + req.neutralPlane.origin.z * pdu.z
    const PLANE_TOL = 1e-6
    // BK-53 (GEO-5 ruling 3): the kernel drafts only about the world-origin
    // plane perpendicular to pullDir, but an ARBITRARY plane whose normal is
    // (anti)parallel to pullDir is now honored by TRANSLATE-CONJUGATION —
    // translate the body so the requested plane passes through the world origin,
    // draft, translate back. So the ONLY remaining refusal is a neutral plane
    // whose normal is NOT (anti)parallel to the pull direction: that is a
    // genuinely different draft the wrapper cannot express (a per-face neutral
    // surface needs a lower-level kernel API occt-wasm 3.6.1 does not expose).
    if (crossMag > PLANE_TOL) {
      const fmt = (v: { x: number; y: number; z: number }) => `(${v.x}, ${v.y}, ${v.z})`
      return {
        ok: false,
        diagnostics: [{
          code: 'DRAFT_FAILED',
          severity: 'error',
          params: {
            faces: req.faces.join(', '),
            requestedNeutralPlane: `origin ${fmt(req.neutralPlane.origin)}, normal ${fmt(req.neutralPlane.normal)}`,
            reason: draftTiltedNeutralPlaneMessage(fmt(req.neutralPlane.origin), fmt(req.neutralPlane.normal), req.faces.join(', '), fmt(pdu)),
          },
        }],
      }
    }

    // Translate-conjugation shift: move the body by -offset along the pull axis
    // so the requested plane lands on the world origin (where the kernel drafts).
    // Zero when the plane already passes through the origin (identity).
    const conjugate = Math.abs(originOffset) > PLANE_TOL
    const shift: Vec3T = [-originOffset * pdu.x, -originOffset * pdu.y, -originOffset * pdu.z]
    // GEO-18: occt-wasm 3.6.1's draft wrapper empirically rejects every
    // non-Z pull direction even when the same geometry succeeds along Z.
    // Rigidly rotate the already-neutralized body so pullDir becomes the
    // nearest Z direction, run the exact proven draft path there, then rotate
    // the result back. This is a coordinate-frame conjugation, so it changes
    // neither the requested plane nor the resulting world-space geometry.
    const rotateConjugate = Math.hypot(pdu.x, pdu.y) > PLANE_TOL
    const kernelPullUnit = { x: 0, y: 0, z: pdu.z >= 0 ? 1 : -1 }
    const rotationCross: Vec3T = [
      pdu.y * kernelPullUnit.z,
      -pdu.x * kernelPullUnit.z,
      0,
    ]
    const rotationCrossLen = Math.hypot(...rotationCross)
    const rotationAxis: Vec3T = rotateConjugate
      ? [rotationCross[0] / rotationCrossLen, rotationCross[1] / rotationCrossLen, 0]
      : [1, 0, 0]
    const rotationAngle = rotateConjugate
      ? Math.acos(Math.max(-1, Math.min(1, pdu.z * kernelPullUnit.z)))
      : 0
    const draftPullDir = rotateConjugate ? kernelPullUnit : pullDir
    const draftPullUnit = rotateConjugate ? kernelPullUnit : pdu

    let currentShape = target.shape as ShapeHandle
    let currentFaceMap = new Map(target.faceMap)
    let currentSnapshots = new Map(target.snapshots)
    let ownsCurrentShape = false
    let failDiag: Diag | null = null

    if (conjugate) {
      // Shift the body into the frame where the neutral plane is the origin
      // plane, rebinding every id by the EXACT rigid translation.
      const shifted = k.translate(target.shape as ShapeHandle, shift[0], shift[1], shift[2])
      const rb = this.#rebindByShift(shifted, target.snapshots, shift)
      if (!rb) {
        try { k.release(shifted) } catch { /* already released */ }
        return { ok: false, diagnostics: [{ code: 'DRAFT_FAILED', severity: 'error', params: { faces: req.faces.join(', '), reason: `draft could not re-anchor the body onto neutral plane through origin ${req.neutralPlane.origin.x}, ${req.neutralPlane.origin.y}, ${req.neutralPlane.origin.z}` } }] }
      }
      currentShape = shifted
      ownsCurrentShape = true
      currentFaceMap = rb.faceMap
      currentSnapshots = rb.snapshots
    }

    if (rotateConjugate) {
      const rotated = k.rotate(
        currentShape,
        {
          point: { x: 0, y: 0, z: 0 },
          direction: { x: rotationAxis[0], y: rotationAxis[1], z: rotationAxis[2] },
        },
        rotationAngle,
      )
      const rb = this.#rebindByRotation(rotated, currentSnapshots, rotationAxis, rotationAngle)
      if (!rb) {
        try { k.release(rotated) } catch { /* already released */ }
        if (ownsCurrentShape) {
          try { k.release(currentShape) } catch { /* already released */ }
        }
        return { ok: false, diagnostics: [{ code: 'DRAFT_FAILED', severity: 'error', params: { faces: req.faces.join(', '), reason: 'draft could not rotate the body into the kernel-supported pull frame' } }] }
      }
      if (ownsCurrentShape) {
        try { k.release(currentShape) } catch { /* already released */ }
      }
      currentShape = rotated
      ownsCurrentShape = true
      currentFaceMap = rb.faceMap
      currentSnapshots = rb.snapshots
    }

    for (const faceId of req.faces) {
      if (failDiag) break
      // UI-57-R1 blocker 2: shared resolver over the CURRENT (possibly
      // rebuilt-by-a-prior-iteration) faceMap, with this body's aliases folded
      // in — a merged-away id resolves to its winner instead of refusing.
      const idToHash = faceHashIndexVia(currentFaceMap, target.aliases)
      const hash = idToHash.get(faceId)
      if (hash === undefined) {
        failDiag = { code: 'REFERENCE_UNRESOLVED', severity: 'error', params: { op: 'draft', id: faceId } }
        break
      }
      const faces = k.getSubShapes(currentShape, 'face')
      try {
        const faceHandle = faces.find((f) => k.hashCode(f, HM) === hash)
        if (faceHandle === undefined) {
          failDiag = { code: 'REFERENCE_UNRESOLVED', severity: 'error', params: { op: 'draft', id: faceId } }
          break
        }
        let next: ShapeHandle
        try {
          next = k.draft(currentShape, faceHandle, angleRad, draftPullDir)
        } catch {
          failDiag = {
            code: 'DRAFT_FAILED',
            severity: 'error',
            params: {
              face: faceId,
              angleDeg: req.angleDeg,
              reason: `draft angle ${req.angleDeg} deg could not be applied to face ${faceId} -- the kernel could not construct a valid draft`,
            },
          }
          break
        }
        if (!k.isValid(next)) {
          try { k.release(next) } catch { /* already released */ }
          const rebuilt = this.#draftThroughPlanarChamferCollar(currentShape, faceHandle, angleRad, draftPullDir)
          if (rebuilt === null) {
            failDiag = {
              code: 'DRAFT_FAILED',
              severity: 'error',
              params: { face: faceId, angleDeg: req.angleDeg, reason: `draft angle ${req.angleDeg} deg produced an invalid result on face ${faceId}` },
            }
            break
          }
          next = rebuilt
        }
        const probes = this.#faceProbes(next)
        const ids = [...currentFaceMap.values()].sort()
        // GEO-4-R1.2: motion-aware budget for THIS iteration. A point at
        // distance h from the neutral plane (through origin, normal pdu) moves
        // at most h*tan(angle) laterally under a draft, so every face's
        // bbox-centroid moves by at most tan(angle) x maxDistToNeutralPlane.
        // This replaces the old fixed 1%-of-bbox-diag tolerance, which rejected
        // valid drafts >5deg (a 10deg side face moves its centroid ~0.88 vs a
        // 0.46 tolerance). Computed on the POST-draft shape (its extent along
        // the pull axis bounds the motion).
        const nb = this.#bodyBBox(next)
        let lo = 0, hi = 0
        for (const i of [0, 1, 2] as const) {
          const c = [draftPullUnit.x, draftPullUnit.y, draftPullUnit.z][i]
          const a = c * nb.min[i], b = c * nb.max[i]
          lo += Math.min(a, b); hi += Math.max(a, b)
        }
        const maxDistToNeutral = Math.max(Math.abs(lo), Math.abs(hi))
        const motionBudget = Math.tan(angleRad) * maxDistToNeutral
        const rebind = rebindDraftFaces(ids, currentSnapshots, probes, { editedId: faceId, angleRad, motionBudget })
        if (rebind.unresolved.length > 0) {
          try { k.release(next) } catch { /* already released */ }
          failDiag = {
            code: 'DRAFT_FAILED',
            severity: 'error',
            params: {
              face: faceId,
              angleDeg: req.angleDeg,
              reason: `draft angle ${req.angleDeg} deg on face ${faceId} lost track of face ${rebind.unresolved.join(', ')} -- refusing to silently mis-bind`,
            },
          }
          break
        }
        if (ownsCurrentShape) {
          try { k.release(currentShape) } catch { /* already released */ }
        }
        currentShape = next
        ownsCurrentShape = true
        currentFaceMap = rebind.faceMap
        currentSnapshots = rebind.snapshots
      } finally {
        for (const f of faces) {
          try { k.release(f) } catch { /* already released */ }
        }
      }
    }

    if (failDiag) {
      if (ownsCurrentShape) {
        try { k.release(currentShape) } catch { /* already released */ }
      }
      return { ok: false, diagnostics: [failDiag] }
    }

    if (rotateConjugate) {
      const restored = k.rotate(
        currentShape,
        {
          point: { x: 0, y: 0, z: 0 },
          direction: { x: rotationAxis[0], y: rotationAxis[1], z: rotationAxis[2] },
        },
        -rotationAngle,
      )
      const rb = this.#rebindByRotation(restored, currentSnapshots, rotationAxis, -rotationAngle)
      if (ownsCurrentShape) {
        try { k.release(currentShape) } catch { /* already released */ }
      }
      if (!rb) {
        try { k.release(restored) } catch { /* already released */ }
        return { ok: false, diagnostics: [{ code: 'DRAFT_FAILED', severity: 'error', params: { faces: req.faces.join(', '), reason: 'draft could not restore the body from the kernel-supported pull frame' } }] }
      }
      currentShape = restored
      currentFaceMap = rb.faceMap
      currentSnapshots = rb.snapshots
    }

    // BK-53: undo the conjugation shift so the drafted body returns to the
    // caller's world frame, rebinding every id by the EXACT inverse translation.
    if (conjugate) {
      const back: Vec3T = [-shift[0], -shift[1], -shift[2]]
      const restored = k.translate(currentShape, back[0], back[1], back[2])
      const rb = this.#rebindByShift(restored, currentSnapshots, back)
      if (ownsCurrentShape) {
        try { k.release(currentShape) } catch { /* already released */ }
      }
      if (!rb) {
        try { k.release(restored) } catch { /* already released */ }
        return { ok: false, diagnostics: [{ code: 'DRAFT_FAILED', severity: 'error', params: { faces: req.faces.join(', '), reason: 'draft could not restore the body to its original frame after the conjugated draft' } }] }
      }
      // `restored` is now the body we mint below; it owns its own shape.
      currentShape = restored
      currentFaceMap = rb.faceMap
      currentSnapshots = rb.snapshots
    }

    const handle = this.#mint({ shape: currentShape as number, faceMap: currentFaceMap, snapshots: currentSnapshots , aliases: target.aliases })
    const geometry: Record<StableId, ContractGeometrySnapshot> = {}
    for (const [id, snap] of currentSnapshots) geometry[id] = toContractGeometry(snap)
    // UI-57-R2 blocker: draft is a BIJECTION on faces -- every id survives as
    // itself, which is why this delta legitimately reports no modified/
    // generated/deleted of its own. But "this feature changed no ids" is not
    // "this body has no id lineage": a face merged away by an earlier heal is
    // still an input to this draft whose surviving output is its live root, and
    // a delta that omits it cannot rebuild rec.aliases on restore. The #mint
    // above carries the map in memory; this is the same fact, written down.
    const modified: Record<StableId, StableId[]> = {}
    foldAliasLineageIntoDelta({
      aliases: target.aliases,
      isLive: (id) => currentSnapshots.has(id),
      modified,
    })
    return {
      ok: true,
      body: handle,
      elementMap: { featureId: req.featureId, modified, generated: [], deleted: [], geometry },
      diagnostics: okDiag(),
    }
  }

  /** Rebind every prior id to a rigidly TRANSLATED copy of a shape: each face's
   *  centroid moved by exactly `shift`, normal/type/area unchanged. Exact match
   *  (translate is rigid), so tolerances are tight. Returns null if any id fails
   *  to find its translated face (never silently mis-binds — used by the BK-53
   *  draft translate-conjugation). Snapshots returned are the translated shape's
   *  OWN probes (correct hashes + post-shift centroids). */
  #rebindByShift(
    shape: ShapeHandle,
    priorSnapshots: Map<StableId, GeometrySnapshot>,
    shift: Vec3T,
  ): { faceMap: Map<number, StableId>; snapshots: Map<StableId, GeometrySnapshot> } | null {
    const probes = this.#faceProbes(shape)
    const remaining = new Set(probes)
    const faceMap = new Map<number, StableId>()
    const snapshots = new Map<StableId, GeometrySnapshot>()
    const tol = Math.max(1e-5, this.#diagOf(shape) * 1e-6)
    for (const [id, s] of priorSnapshots) {
      const t: Vec3T = [s.centroid[0] + shift[0], s.centroid[1] + shift[1], s.centroid[2] + shift[2]]
      let best: FaceProbe | undefined
      let bestD = Infinity
      for (const p of remaining) {
        if (p.snapshot.type !== s.type) continue
        const d = Math.hypot(p.snapshot.centroid[0] - t[0], p.snapshot.centroid[1] - t[1], p.snapshot.centroid[2] - t[2])
        if (d < bestD) { bestD = d; best = p }
      }
      if (best && bestD <= tol) {
        faceMap.set(best.hash, id)
        snapshots.set(id, best.snapshot)
        remaining.delete(best)
      } else {
        return null
      }
    }
    return { faceMap, snapshots }
  }

  /** Rebind every prior id through an exact rigid rotation about the world
   *  origin. Centroid is the acceptance gate; transformed normal breaks ties
   *  for symmetric faces that share a centroid. */
  #rebindByRotation(
    shape: ShapeHandle,
    priorSnapshots: Map<StableId, GeometrySnapshot>,
    axis: Vec3T,
    angleRad: number,
  ): { faceMap: Map<number, StableId>; snapshots: Map<StableId, GeometrySnapshot> } | null {
    const probes = this.#faceProbes(shape)
    const remaining = new Set(probes)
    const faceMap = new Map<number, StableId>()
    const snapshots = new Map<StableId, GeometrySnapshot>()
    const tol = Math.max(1e-5, this.#diagOf(shape) * 1e-6)
    const zero: Vec3T = [0, 0, 0]
    for (const [id, s] of priorSnapshots) {
      const expectedCentroid = rotateAboutAxis(s.centroid, zero, axis, angleRad)
      const expectedNormal = normalize(rotateAboutAxis(s.normal, zero, axis, angleRad))
      let best: FaceProbe | undefined
      let bestCentroidDistance = Infinity
      let bestScore = Infinity
      for (const p of remaining) {
        if (p.snapshot.type !== s.type) continue
        const centroidDistance = Math.hypot(
          p.snapshot.centroid[0] - expectedCentroid[0],
          p.snapshot.centroid[1] - expectedCentroid[1],
          p.snapshot.centroid[2] - expectedCentroid[2],
        )
        const probeNormal = normalize(p.snapshot.normal)
        const normalDistance = Math.min(
          Math.hypot(
            probeNormal[0] - expectedNormal[0],
            probeNormal[1] - expectedNormal[1],
            probeNormal[2] - expectedNormal[2],
          ),
          Math.hypot(
            probeNormal[0] + expectedNormal[0],
            probeNormal[1] + expectedNormal[1],
            probeNormal[2] + expectedNormal[2],
          ),
        )
        const score = centroidDistance + normalDistance * tol
        if (score < bestScore) {
          best = p
          bestScore = score
          bestCentroidDistance = centroidDistance
        }
      }
      if (best !== undefined && bestCentroidDistance <= tol) {
        faceMap.set(best.hash, id)
        snapshots.set(id, best.snapshot)
        remaining.delete(best)
      } else {
        return null
      }
    }
    return { faceMap, snapshots }
  }

  // ---- tessellation ----------------------------------------------------
  async tessellate(h: BodyHandle, q: TessQuality): Promise<TessBuffers> {
    const k = this.#k()
    const rec = this.#rec(h)
    const shape = rec.shape as ShapeHandle
    const deflection = q.deflection > 0 ? q.deflection : 0.1
    const opts = { linearDeflection: deflection, angularDeflection: q.angularDeflection ?? 0.5 }
    // a relief face: never coarser than RELIEF_MESH's chord, never finer than its angle
    const reliefOpts = { linearDeflection: Math.min(deflection, RELIEF_MESH.linearDeflection), angularDeflection: Math.max(opts.angularDeflection, RELIEF_MESH.angularDeflection) }

    // Per-face meshing => triangle->face mapping is correct BY CONSTRUCTION.
    // (occt-wasm's whole-body faceGroups use an internal hash that does NOT
    // join to hashCode(); verified 2026-07-07.)
    // GEO-2-R1.3: both getSubShapes calls below mint caller-owned transient
    // handles (one per face, one per edge). They are only needed for the
    // duration of this call (hash/mesh/adjacency lookups), so release ALL of
    // them in the finally below on BOTH the success and throw paths
    // (GEO-1-R1.3 #transients precedent) — otherwise every tessellate() call
    // leaks one kernel shape per face + per edge forever.
    const faces = k.getSubShapes(shape, 'face')
    const edgeHandles = k.getSubShapes(shape, 'edge')
    try {
      const positions: number[] = []
      const normals: number[] = []
      const indices: number[] = []
      const triFace: number[] = []
      const faceIds: StableId[] = []
      let vertBase = 0
      // WO-2200: a mesh relief's face is meshed from its working grid after every
      // other face, stitched to the points they put on its edges
      const meshes: (FaceTriangles | null)[] = []
      faces.forEach((face, faceIndex) => {
        const hash = k.hashCode(face, HM)
        const faceId = rec.faceMap.get(hash) ?? `UNMAPPED:face#${faceIndex}`
        faceIds.push(faceId)
        const d = this.#reliefDetail.get(faceId)
        if (d !== undefined && this.#reliefFaceWhole(face, d.frame)) { meshes.push(null); return }
        const m = k.meshShape(face, this.#reliefFaceIds.has(faceId) ? reliefOpts : opts)
        meshes.push({ positions: m.positions, normals: m.normals, indices: m.indices, reversed: k.shapeOrientation(face) === 'reversed' })
      })
      meshes.forEach((m, faceIndex) => {
        if (m !== null) return
        const d = this.#reliefDetail.get(faceIds[faceIndex])!
        const fine = reliefDetailFaceMesh(d.detail, d.frame, pointsOnPlane(meshes, d.frame))
        if (fine !== null) { meshes[faceIndex] = { ...fine, reversed: false }; return }
        // its neighbours did not trace its rectangle: the face's own mesh, at the exact face's detail
        const own = k.meshShape(faces[faceIndex], reliefOpts)
        meshes[faceIndex] = { positions: own.positions, normals: own.normals, indices: own.indices, reversed: k.shapeOrientation(faces[faceIndex]) === 'reversed' }
      })
      meshes.forEach((m, faceIndex) => {
        if (m === null) return
        for (let i = 0; i < m.positions.length; i++) positions.push(m.positions[i])
        // GEO-22B: occt-wasm meshShape emits per-vertex SHADING normals as the
        // raw surface normal WITHOUT applying the face's TopAbs orientation. For
        // a TopAbs_REVERSED face the winding (index order) is already
        // orientation-corrected — so culling is right (FrontSide keeps the
        // floor) — but the shading normal points INTO the solid, opposite the
        // outward/winding normal. Under the all-above workbench light rig
        // (sceneRuntime.ts hemisphere sky +Z + key/fill/rim all above) an
        // upward-facing REVERSED planar face (a blind-hole/pocket floor,
        // counterbore spotface, the plate bottom) then shades near-black and
        // reads as a see-through void — Operator's "blind holes render through"
        // symptom (coordination/reports/GEO-22.report.json). Negate the shading
        // normal ONLY on reversed faces so it agrees with the already-correct
        // winding. The guard on 'reversed' means FORWARD faces (outer walls, the
        // top face, through-hole cylinder walls) are byte-untouched — no
        // double-flip. buildBufferGeometry (viewport3d/tessGeometry.ts) wraps
        // this buffer verbatim, so fixing it here is the single source of truth.
        const flipNormals = m.reversed
        for (let i = 0; i < m.normals.length; i++) normals.push(flipNormals ? -m.normals[i] : m.normals[i])
        for (let i = 0; i < m.indices.length; i++) indices.push(m.indices[i] + vertBase)
        for (let t = 0; t < m.indices.length / 3; t++) triFace.push(faceIndex)
        vertBase += m.positions.length / 3
      })

      // Edges: wireframe polylines are POSITIONALLY aligned with getSubShapes
      // ('edge') (verified 2026-07-07); adjacency via edgeToFaceMap (which DOES
      // join to hashCode()).
      const { adjacentFaces: adjacency, occurrences } = this.#edgeAdjacency(shape)
      const wf = k.wireframe(shape, deflection)
      const edgePositions = new Float32Array(wf.points.length)
      edgePositions.set(wf.points)
      const edgeOffsets: number[] = []
      const groupCount = wf.edgeGroups.length / 3
      const edgeClasses: EdgeClass[] = []
      for (let g = 0; g < groupCount; g++) {
        // vertex index into edgePositions (CSR start table, sentinel below).
        edgeOffsets.push(wf.edgeGroups[g * 3] / 3)
        const edge = edgeHandles[g]
        const edgeHash = edge === undefined ? -1 : k.hashCode(edge, HM)
        // edgeToFaceMap repeats a true seam once per side, while a free
        // boundary has one entry even though both resolve to one unique face.
        const isSeam = adjacency.get(edgeHash)?.size === 1 && occurrences.get(edgeHash) === 2
        edgeClasses.push(isSeam ? 'seam' : 'regular')
      }
      // Same GEO-16-disambiguated derivation #edgeCandidates/#edgeIdsFor use, so
      // the id the UI picks here matches the id a resolver later resolves.
      const { ids: edgeIds } = this.#labelEdges(edgeHandles, adjacency, wf, rec)
      // BK-18: emit the CSR trailing sentinel so edgeOffsets is a full
      // start-index table — edge i's polyline is edgePositions points
      // [edgeOffsets[i], edgeOffsets[i+1]); the final entry is the total
      // edge-point count. This makes edgeOffsets.length === edgeIds.length + 1
      // (the shape viewport3d/tessGeometry.ts validateTessBuffers requires and
      // that its progressiveTessellate normalizeEdgeOffsets workaround was
      // reconstructing at the SOURCE) and mirrors the CSR sentinel rule the
      // contract already mandates for vertexAdjacencyOffsets (ICR-2). Fix here,
      // never a defensive downstream patch.
      edgeOffsets.push(edgePositions.length / 3)

      return {
        position: new Float32Array(positions),
        normal: new Float32Array(normals),
        index: new Uint32Array(indices),
        triFace: new Uint32Array(triFace),
        faceIds,
        edgePositions,
        edgeOffsets: new Uint32Array(edgeOffsets),
        edgeIds,
        edgeClasses,
      }
    } finally {
      for (const f of faces) {
        try { k.release(f) } catch { /* already released */ }
      }
      for (const e of edgeHandles) {
        try { k.release(e) } catch { /* already released */ }
      }
    }
  }

  /**
   * WO-2200: a mesh relief's face is meshed from its working grid only while it
   * is still the whole rectangle it was laid as: four edges, its corners where
   * the relief's frame puts them. A later feature that cut into it, split it or
   * moved the body leaves the face to the kernel's own mesh.
   */
  #reliefFaceWhole(face: ShapeHandle, frame: DetailFrame): boolean {
    const k = this.#k()
    const edges = k.getSubShapes(face, 'edge')
    const vertices = k.getSubShapes(face, 'vertex')
    try {
      if (edges.length !== 4 || vertices.length !== 4) return false
      const { origin: o, xDir: x, yDir: y } = frame
      const corners = [[0, 0], [frame.widthMm, 0], [frame.widthMm, frame.heightMm], [0, frame.heightMm]]
        .map(([u, v]) => ({ x: o.x + u * x.x + v * y.x, y: o.y + u * x.y + v * y.y, z: o.z + u * x.z + v * y.z }))
      return vertices.every((vh) => {
        const p = k.vertexPosition(vh)
        return corners.some((c) => Math.hypot(p.x - c.x, p.y - c.y, p.z - c.z) <= 1e-3)
      })
    } finally {
      for (const h of [...edges, ...vertices]) { try { k.release(h) } catch { /* already released */ } }
    }
  }

  #edgeAdjacency(shape: ShapeHandle): {
    adjacentFaces: Map<number, Set<number>>
    occurrences: Map<number, number>
  } {
    // a large all-planar (faceted) body: exact face walk, not the kernel's quadratic map
    const planar = planarEdgeAdjacency(this.#k(), shape, HM)
    if (planar !== null) return planar
    return parseEdgeToFaceMap(this.#k().edgeToFaceMap(shape, HM))
  }

  /**
   * Edge handles + their stable IDs, in the SAME labeling tessellate() uses
   * for TessBuffers.edgeIds (kept side-by-side rather than refactored out of
   * tessellate, to avoid touching GEO-1's already-tested edge-labeling path
   * mid-WO). Used by measure('length', ids) to resolve an edge stableId to
   * its kernel handle for exact curveLength() (GEO-2 BK-10b). The wireframe
   * deflection passed here only affects polyline point density, never which
   * edges exist or their enumeration order, so a fixed cheap value is fine —
   * we never read wf.points here, only wf.edgeGroups for edge count/order.
   *
   * GEO-2-R1.3: getSubShapes('edge') mints one caller-owned handle per edge.
   * Ownership of the returned `handles` array TRANSFERS to the caller
   * (measure()), which needs the live handles for k.curveLength() and is
   * responsible for releasing every one of them (not just the ones it ends
   * up using) once done — this helper does not release them itself. Returns
   * the FULL edgeHandles array (not sliced to groupCount) so the caller's
   * release loop can never miss a fetched handle even if groupCount and
   * edgeHandles.length ever disagree; index lookups by the caller only ever
   * use indices < groupCount, which is an unaffected prefix of this array.
   */
  #edgeIdsFor(shape: ShapeHandle, rec: BodyRecord): { handles: ShapeHandle[]; ids: StableId[] } {
    const k = this.#k()
    const edgeHandles = k.getSubShapes(shape, 'edge')
    const { adjacentFaces: adjacency } = this.#edgeAdjacency(shape)
    const wf = k.wireframe(shape, 0.1)
    // Same GEO-16-disambiguated derivation tessellate()/#edgeCandidates use.
    const { ids } = this.#labelEdges(edgeHandles, adjacency, wf, rec)
    return { handles: edgeHandles, ids }
  }

  // ---- GEO-6 direct edit: recognize + rule-select + batch defeature ----

  /** TEST-ONLY: force the heal of the accepted feature at `index` (sorted batch
   *  order) to fail, exercising the BK-45 partial-success path deterministically. */
  debugSetDefeatureFault(index: number | null): void { this.#defeatureFault = index }

  /** Recognize every face-level feature on a body, translated to stable ids. */
  async recognizeFeatures(h: BodyHandle): Promise<FeatureVerdict[]> {
    return this.#recognizeVerdicts(this.#rec(h))
  }

  /** Rule-based batch selection — a filtered recognizeFeatures (SW-2024 bar). */
  async queryFeatures(h: BodyHandle, query: FeatureQuery): Promise<FeatureVerdict[]> {
    const all = await this.recognizeFeatures(h)
    return all.filter((v) => matchesFeatureQuery(v, query))
  }

  /** Translate the hash-only recognizer output into stable-id verdicts. */
  #recognizeVerdicts(rec: BodyRecord): FeatureVerdict[] {
    const k = this.#k()
    const recs = gatherFaces(k, rec.shape as ShapeHandle)
    try {
      const feats = recognizeFeaturesCore(k, rec.shape as ShapeHandle, recs)
      const byHash = new Map(recs.map((face) => [face.hash, face] as const))
      return feats.map((f) => {
        const verdict = this.#verdictOf(f, rec)
        if (
          verdict.removable &&
          verdict.featureClass.startsWith('fillet') &&
          typeof verdict.params.radius !== 'number'
        ) {
          const face = f.dropHashes.length === 1 ? byHash.get(f.dropHashes[0]) : undefined
          const radius = face === undefined ? undefined : this.#measureImportedFilletRadius(face)
          if (radius !== undefined) verdict.params = { ...verdict.params, radius: r3(radius) }
        }
        return verdict
      })
    } finally {
      releaseFaceRecs(k, recs)
    }
  }

  #verdictOf(f: RecognizedFeature, rec: BodyRecord): FeatureVerdict {
    const toIds = (hashes: number[]): StableId[] => {
      const out: StableId[] = []
      for (const hsh of hashes) { const id = rec.faceMap.get(hsh); if (id !== undefined) out.push(id) }
      return out
    }
    return {
      featureKey: f.key,
      featureClass: f.type as FeatureClass,
      removable: f.removable,
      refuseReason: f.refuseReason,
      effect: f.effect,
      faceIds: toIds(f.dropHashes),
      neighbourIds: toIds(f.neighbourHashes),
      params: f.params,
    }
  }

  /** Measure the radius the Fillet palette must show for an imported blend.
   * Analytic cylindrical STEP faces expose it directly. Vendor b-spline bands
   * retain circular end arcs; recover their common circle radius from three
   * independent curve samples. No estimate is emitted when the boundary does
   * not provide a readable circle. */
  #measureImportedFilletRadius(face: FaceRec): number | undefined {
    if (face.radius !== undefined && Number.isFinite(face.radius) && face.radius > 1e-6) return face.radius
    const k = this.#k()
    let wire: ShapeHandle | undefined
    let edges: ShapeHandle[] = []
    const radii: number[] = []
    try {
      wire = k.outerWire(face.handle)
      edges = k.getSubShapes(wire, 'edge')
      for (const edge of edges) {
        let kind: string
        try { kind = k.curveType(edge) } catch { continue }
        if (kind !== 'circle') continue
        try {
          const range = k.curveParameters(edge)
          const span = range.last - range.first
          if (!(Math.abs(span) > 1e-12)) continue
          const p0 = k.curvePointAtParam(edge, range.first)
          const p1 = k.curvePointAtParam(edge, range.first + span / 2)
          const p2 = k.curvePointAtParam(edge, range.last)
          const center = circleCenter(
            [p0.x, p0.y, p0.z],
            [p1.x, p1.y, p1.z],
            [p2.x, p2.y, p2.z],
          )
          if (center === undefined) continue
          const radius = len(sub([p0.x, p0.y, p0.z], center))
          if (Number.isFinite(radius) && radius > 1e-6) radii.push(radius)
        } catch { /* unreadable boundary arc is not a radius */ }
      }
    } finally {
      for (const edge of edges) { try { k.release(edge) } catch { /* */ } }
      if (wire !== undefined) { try { k.release(wire) } catch { /* */ } }
    }
    if (radii.length === 0) return undefined
    radii.sort((a, b) => a - b)
    const median = radii[Math.floor(radii.length / 2)]
    const agreeing = radii.filter((radius) => Math.abs(radius - median) <= Math.max(1e-5, median * 1e-4))
    return agreeing.length >= Math.min(2, radii.length) ? median : undefined
  }

  /**
   * Remove an accepted feature set and heal watertight as ONE history feature
   * (BK-45). Non-destructive: works on a copy, so the input body is byte-
   * identical if 0 features heal. PARTIAL SUCCESS — features heal one at a time
   * on a running solid; a feature that refuses (curved corner) or fails to reach
   * a solid is skipped and named LOUD in the report, never aborting the batch,
   * never silently dropped. The healed faces keep their neighbours' stable ids
   * (CAM rebinding); dropped feature faces land in `deleted`; any genuinely new
   * heal face gets a `<featureId>:DELF:heal#j` id (the lineage grammar addendum
   * flagged in the report). Signed volume delta reported per item + total.
   */
  async defeatureBatch(req: DefeatureRequest): Promise<DefeatureResult> {
    const k = this.#k()
    const rec = this.#rec(req.body)
    const original = rec.shape as ShapeHandle

    // 1) recognize + select the accepted feature set (deterministic order).
    const all = this.#recognizeVerdicts(rec)
    // Requested keys that no longer resolve (e.g. an upstream edit consumed the
    // feature) are named LOUD in report.notFound — never silently skipped, never
    // matched to the wrong face (criterion 5 / stable-id-spec §3).
    const notFound: string[] = []
    let accepted: FeatureVerdict[]
    if (req.featureKeys && req.featureKeys.length) {
      const present = new Set(all.map((v) => v.featureKey))
      for (const kk of req.featureKeys) if (!present.has(kk)) notFound.push(kk)
      const keys = new Set(req.featureKeys)
      accepted = all.filter((v) => keys.has(v.featureKey))
    } else if (req.query) {
      accepted = all.filter((v) => matchesFeatureQuery(v, req.query!))
    } else {
      accepted = all.filter((v) => v.removable)
    }
    accepted = [...accepted].sort((a, b) => (a.featureKey < b.featureKey ? -1 : a.featureKey > b.featureKey ? 1 : 0))
    const removableCount = accepted.filter((v) => v.removable).length
    if (accepted.length === 0) {
      const reason = notFound.length
        ? `no accepted feature resolves on this body; ${notFound.length} requested key(s) not found: ${notFound.slice(0, 4).join(', ')}${notFound.length > 4 ? '…' : ''}`
        : 'no features matched the selection'
      return {
        ok: false,
        diagnostics: [{ code: 'DEFEATURE_UNSUPPORTED', severity: notFound.length ? 'error' : 'warning', params: { reason } }],
        report: { requested: req.featureKeys?.length ?? 0, healed: 0, failed: 0, refused: 0, totalVolumeDelta: 0, items: [], notFound },
      }
    }

    // 2) heal accepted features one at a time on a running COPY.
    const items: DefeatureItemResult[] = []
    let healedCount = 0, failedCount = 0, refusedCount = 0
    const originalVol = k.getVolume(original)
    let current = k.copy(original)
    let idx = 0
    for (const v of accepted) {
      if (!v.removable) {
        items.push({ featureKey: v.featureKey, featureClass: v.featureClass, healed: false, reason: v.refuseReason ?? 'refused (parallel-kernel class)', effect: v.effect })
        refusedCount++; idx++; continue
      }
      const scratch: ShapeHandle[] = []
      const curRecs = gatherFaces(k, current)
      let ok = false, reason: string | undefined, delta: number | undefined
      try {
        const curFeats = recognizeFeaturesCore(k, current, curRecs)
        const match = curFeats.find((cf) => cf.key === v.featureKey) ?? this.#refindByFingerprint(curFeats, v)
        if (!match) {
          reason = 'feature not found on the regenerated body (an upstream edit may have consumed it)'
        } else if (this.#defeatureFault === idx) {
          reason = 'debug fault (partial-success test)'
        } else {
          const heal = healRemoval(k, current, [match], scratch, curRecs)
          if (heal.ok && heal.shape && Number.isFinite(heal.volumeDelta)) {
            try { k.release(current) } catch { /* */ }
            current = heal.shape
            ok = true; delta = heal.volumeDelta
          } else if (heal.ok && heal.shape) {
            // GEO-11-R1 (blocker 2): defense-in-depth at the consumer boundary.
            // healRemoval's finite-data gate already refuses a non-finite delta; if
            // one ever reached here it would poison the running volume total below.
            // Refuse BY NAME rather than accept an unvalidated body.
            reason = `heal reported success with a non-finite volumeDelta (${heal.volumeDelta}); refused at the defeature consumer boundary`
          } else {
            reason = heal.reason
          }
        }
      } catch (e) {
        reason = `heal threw: ${(e instanceof Error ? e.message : String(e)).slice(0, 100)}`
      } finally {
        for (const s of scratch) { if (s === current) continue; try { k.release(s) } catch { /* */ } }
        releaseFaceRecs(k, curRecs)
      }
      if (ok) { healedCount++; items.push({ featureKey: v.featureKey, featureClass: v.featureClass, healed: true, volumeDelta: delta, effect: v.effect }) }
      else { failedCount++; items.push({ featureKey: v.featureKey, featureClass: v.featureClass, healed: false, reason, effect: v.effect }) }
      idx++
    }

    const report: NonNullable<DefeatureResult['report']> = {
      requested: (req.featureKeys?.length ?? accepted.length),
      // failedCount counts heal failures only; refusals are tracked separately;
      // notFound are requested keys that no longer resolve.
      failed: failedCount + notFound.length,
      healed: healedCount,
      refused: refusedCount,
      totalVolumeDelta: 0,
      items,
      notFound,
    }

    // 3) if nothing healed, discard the copy and fail loud — input untouched.
    if (healedCount === 0) {
      try { k.release(current) } catch { /* */ }
      const firstFailure = items.find((item) => !item.healed && item.reason?.trim())
      const detail = firstFailure === undefined
        ? ''
        : `; ${firstFailure.featureKey}: ${firstFailure.reason}`
      return {
        ok: false,
        diagnostics: [{ code: 'DEFEATURE_UNSUPPORTED', severity: 'error', params: { reason: `0 of ${removableCount} removable feature(s) healed${detail}` } }],
        report,
      }
    }

    // 4) assign healed-body ids vs the original, mint the ONE new body + delta.
    // GEO-11-R1 (blocker 2): validate the total-delta inputs again at this boundary.
    // Each accepted item already carries a finite delta, but the running total is a
    // fresh subtraction of two live volumes; refuse the whole batch BY NAME rather
    // than mint a body with a NaN/Infinity totalVolumeDelta.
    const healedVol = k.getVolume(current)
    if (!Number.isFinite(healedVol) || !Number.isFinite(originalVol)) {
      try { k.release(current) } catch { /* */ }
      return {
        ok: false,
        diagnostics: [{ code: 'DEFEATURE_UNSUPPORTED', severity: 'error', params: { reason: `defeature produced non-finite volume data (healed=${healedVol}, original=${originalVol}); refused at the consumer boundary` } }],
        report,
      }
    }
    report.totalVolumeDelta = r3(healedVol - originalVol)
    const assign = this.#assignHealedIds(rec, current, req.featureId)
    const handle = this.#mint({ shape: current as number, faceMap: assign.faceMap, snapshots: assign.snapshots , aliases: rec.aliases })
    return {
      ok: true,
      body: handle,
      elementMap: { featureId: req.featureId, modified: assign.modified, generated: assign.generated, deleted: assign.deleted, geometry: assign.geometry },
      diagnostics: okDiag(),
      report,
    }
  }

  /** Regen fallback: after an upstream edit shifts geometry, re-find a feature by
   *  its class + nearest fingerprint centroid (never a silent wrong match). */
  #refindByFingerprint(curFeats: RecognizedFeature[], v: FeatureVerdict): RecognizedFeature | undefined {
    const cx = Number(v.params.centerX ?? v.params.axisX ?? NaN)
    let best: RecognizedFeature | undefined
    let bestD = Infinity
    for (const f of curFeats) {
      if (f.type !== v.featureClass) continue
      const d = Number.isFinite(cx) ? Math.abs(f.fingerprint.cx - cx) : Infinity
      if (d < bestD && d < 1) { bestD = d; best = f }
    }
    return best
  }

  /** Build the healed body's faceMap/snapshots + ElementMapDelta vs the original,
   *  matching every healed face to an original by the geometry lineage key. */
  #assignHealedIds(rec: BodyRecord, finalShape: ShapeHandle, batchFid: string): {
    faceMap: Map<number, StableId>; snapshots: Map<StableId, GeometrySnapshot>
    modified: Record<StableId, StableId[]>; generated: StableId[]; deleted: StableId[]
    geometry: Record<StableId, ContractGeometrySnapshot>
  } {
    const finalProbes = this.#faceProbes(finalShape)
    const origs = origFaces(rec)
    const m = matchFacesToOriginals(origs, finalProbes)
    const faceMap = new Map<number, StableId>()
    const snapshots = new Map<StableId, GeometrySnapshot>()
    const modified: Record<StableId, StableId[]> = {}
    const generated: StableId[] = []
    for (const mt of m.matches) {
      faceMap.set(mt.probe.hash, mt.id); snapshots.set(mt.id, mt.probe.snapshot)
      // a rebuilt (untrimmed / loop-removed) survivor changed area -> retrim.
      if (Math.abs(mt.probe.snapshot.area - mt.origSnap.area) > 1e-6) modified[mt.id] = [mt.id]
    }
    m.mintProbes.sort((a, b) => compareSnapshots(a.snapshot, b.snapshot)).forEach((p, j) => {
      const id: StableId = `${batchFid}:DELF:heal#${j}`
      faceMap.set(p.hash, id); snapshots.set(id, p.snapshot); generated.push(id)
    })
    const deleted: StableId[] = m.remainingOrig.map((o) => o.id).sort()
    // UI-57-R2 blocker: re-state `rec`'s inherited lineage in this delta (the
    // caller's #mint passes `aliases: rec.aliases` in memory; this is what lets
    // restoreBody rebuild that same map from the delta alone).
    const generatedIds = new Set(generated)
    foldAliasLineageIntoDelta({
      aliases: rec.aliases,
      isLive: (id) => snapshots.has(id),
      modified,
      isGenerated: (id) => generatedIds.has(id),
    })
    const geometry: Record<StableId, ContractGeometrySnapshot> = {}
    for (const [id, snap] of snapshots) geometry[id] = toContractGeometry(snap)
    for (const id of deleted) { const s = rec.snapshots.get(id); if (s) geometry[id] = toContractGeometry(s) }
    return { faceMap, snapshots, modified, generated, deleted, geometry }
  }

  /**
   * v0.6 (GEO-10) — resize a hole diameter / pocket depth, or offset a planar
   * face, then re-verify watertight. V1 REMOVE-AND-RE-CUT re-drive (BK-62):
   *
   *  - faceOffset  (priority; UI-5 push-pull): translate a PLANAR face along its
   *      own normal by `delta` mm, re-closing planar/cylindrical neighbours via a
   *      boolean prism (extrude the face -> fuse for +delta / cut for -delta).
   *      `featureKey` names the face StableId directly (the face IS the feature
   *      for a bare offset). Non-planar target -> STRUCTURED refusal naming the
   *      surface class (the Tray corner-blend torus lands here).
   *  - holeDiameter: recognized hole family (through / blind / counterbore).
   *      Heal the hole away (existing healRemoval stack), then re-cut the pilot
   *      at the new radius on the same axis/depth. An entry cone is reconstructed
   *      from its measured half-angle and axial depth and carried to the new edge.
   *  - pocketDepth: recognized pocket. Re-drive depth by offsetting the pocket
   *      FLOOR face by `-delta` through the SAME boolean-prism core (deeper for
   *      +delta, shallower for -delta). Reuses #offsetFaceBoolean exactly.
   *
   *  - holeDepth (WO-2091): recognized hole family. Same heal + re-cut as
   *      holeDiameter at the SAME radius (and entry cone / counterbore) with the
   *      new depth; through -> blind and blind -> through both ride this route.
   *
   * Every unsupported (kind x class) pair keeps a STRUCTURED refusal that names
   * the class + reason (see GEO-10.report.json class matrix). The frozen
   * FaceEditRequest signature is untouched — the V1 semantics ride behind it.
   */
  async editFeature(req: EngineFaceEditRequest): Promise<OpResult> {
    const rec = this.#rec(req.body) // validate the handle exists (throws on unknown body)
    if (!Number.isFinite(req.delta)) {
      return this.#editRefusal(`editFeature(${req.kind}): delta must be a finite number (got ${req.delta})`, req.featureKey, 'error')
    }
    try {
      switch (req.kind) {
        case 'faceOffset': return this.#editFaceOffset(rec, req)
        case 'pocketDepth': return this.#editPocketDepth(rec, req)
        case 'holeDiameter': return this.#recutHole(rec, req)
        case 'holeDepth': return this.#recutHole(rec, req)
        case 'relief': return this.#applyRelief(rec, req)
        default: return this.#editRefusal(`editFeature: unknown kind '${(req as { kind: string }).kind}'`, (req as { featureKey: string }).featureKey, 'error')
      }
    } catch (e) {
      return {
        ok: false,
        diagnostics: [{ code: 'KERNEL_OP_FAILED', severity: 'error', params: {
          reason: `editFeature(${req.kind}) threw: ${(e instanceof Error ? e.message : String(e)).slice(0, 140)}`,
          featureKey: req.featureKey,
        } }],
      }
    }
  }

  /** A structured (never-crash) refusal diagnostic for an unsupported edit class. */
  #editRefusal(reason: string, featureKey: string, severity: 'warning' | 'error' = 'warning', extra: Record<string, string | number> = {}): OpResult {
    return { ok: false, diagnostics: [{ code: 'DEFEATURE_UNSUPPORTED', severity, params: { reason, featureKey, ...extra } }] }
  }

  /** Resolve a face StableId to its live kernel handle-derived probe on `rec`
   *  (handle released before return). Returns undefined if the id is unknown.
   *  WO UI-57 Design 5: chases rec.aliases first, so a SECOND faceEdit keyed
   *  to an old (merge-healed) id transparently redirects to the survivor's
   *  current face — a second push/pull on the same aliased wall still
   *  resolves, never a refusal. */
  #resolveFaceSnap(rec: BodyRecord, faceId: StableId): { snap: GeometrySnapshot; hash: number } | undefined {
    const resolvedId = this.#resolveFaceId(rec, faceId)
    const snap = rec.snapshots.get(resolvedId)
    const hash = this.#faceHashIndex(rec).get(resolvedId)
    if (snap === undefined || hash === undefined) return undefined
    return { snap, hash }
  }

  /**
   * The GEO-10 boolean-prism workhorse shared by faceOffset and pocketDepth.
   * Translate the planar face `faceId` by `offset` mm along its outward normal:
   * extrude the face into a prism of height `offset`, then FUSE it (offset > 0,
   * material added) or CUT it (offset < 0, material removed). The neighbouring
   * planar/cylindrical walls re-close automatically through the boolean's
   * coplanar/coaxial merge — the V1 stand-in for "untrim/extend + re-intersect".
   *
   * VERIFY gate (criterion 3): the result must be a valid isSolid, the signed
   * volume delta must match the offset's sign, and |volumeDelta - area*offset|
   * must fall inside tolerance. A face whose neighbours are NOT in the parallel
   * planar/cylindrical class (e.g. a draft-angled wall) fails the volume-match
   * and is REFUSED with the measured-vs-expected numbers naming the class miss.
   */
  #offsetFaceBoolean(rec: BodyRecord, faceId: StableId, offset: number, fid: string, label: string): OpResult {
    const k = this.#k()
    if (Math.abs(offset) < 1e-9) {
      return this.#editRefusal(`${label}: a zero offset is a no-op (nothing to re-drive)`, faceId, 'warning')
    }
    const found = this.#resolveFaceSnap(rec, faceId)
    if (!found) return this.#editRefusal(`${label}: face ${faceId} does not resolve on this body`, faceId, 'error')
    if (found.snap.type !== 'plane') {
      return this.#editRefusal(
        `${label} supports PLANAR faces only; face ${faceId} is a ${found.snap.type} surface (out-of-class: curved neighbours need the parallel-kernel untrim path) — refused in V1`,
        faceId, 'warning', { surfaceType: found.snap.type },
      )
    }
    const normal = normalize(found.snap.normal as Vec3T)
    const area = found.snap.area
    if (!(area > 1e-9)) return this.#editRefusal(`${label}: face ${faceId} has degenerate area`, faceId, 'error')

    const scratch: ShapeHandle[] = []
    let result: ShapeHandle | undefined
    const faces = k.getSubShapes(rec.shape as ShapeHandle, 'face')
    try {
      const faceHandle = faces.find((f) => k.hashCode(f, HM) === found.hash)
      if (faceHandle === undefined) return this.#editRefusal(`${label}: face ${faceId} does not resolve on this body`, faceId, 'error')
      // Give the boolean a microscopic volume overlap at the source face.
      // A prism that merely TOUCHES the body there leaves OCCT free to retain
      // splitters on trimmed fillet neighbours. The overlap is already occupied
      // for FUSE (and starts just outside for CUT), so it cannot change the
      // intended area*offset volume; the hard volume gate below verifies that.
      const bb = k.getBoundingBox(rec.shape as ShapeHandle, false)
      const bodyScale = Math.max(bb.xmax - bb.xmin, bb.ymax - bb.ymin, bb.zmax - bb.zmin, 1)
      const overlap = Math.min(1e-4, Math.max(1e-7, bodyScale * 1e-7))
      const seedShift = offset > 0 ? -overlap : overlap
      const seed = k.translate(faceHandle, normal[0] * seedShift, normal[1] * seedShift, normal[2] * seedShift)
      scratch.push(seed)
      const prismDistance = offset > 0 ? offset + overlap : offset - overlap
      const v = scale(normal, prismDistance)
      const prism = k.extrude(seed, v[0], v[1], v[2])
      scratch.push(prism)
      if (!k.isValid(prism)) return this.#editRefusal(`${label}: the offset prism for face ${faceId} was not a valid solid`, faceId, 'error')
      const originalVol = k.getVolume(rec.shape as ShapeHandle)
      if (offset > 0) {
        result = k.fuse(rec.shape as ShapeHandle, prism)
      } else {
        const inputHashes = [...rec.faceMap.keys()]
        result = k.cutWithHistory(rec.shape as ShapeHandle, prism, inputHashes, HM).result
      }
      // Watertight gate (GEO-10-R1 finding 2): the edited body must be a valid,
      // positive-volume, CLOSED SOLID — isSolid() is now a HARD success gate for
      // faceOffset/pocketDepth, the WO's stated invariant. A boolean can wrap its
      // solid in a compound (which isSolid() rejects), so normalize to the lone
      // solid subshape first; zero or >1 closed solids (an emptied or split body)
      // is out-of-class and refuses. This closes the "isValid but not solid"
      // acceptance the auditor flagged at geom-engine.ts:3258-3263.
      if (!k.isValid(result) || !(k.getVolume(result) > 1e-9)) {
        return this.#editRefusal(`${label}: face ${faceId} offset by ${offset} did not yield a valid positive-volume result (out-of-class geometry)`, faceId, 'error')
      }
      const solidified = this.#editNonSolidFaultForTest
        ? { ok: false, reason: 'injected non-solid fault (test)' }
        : this.#asSingleSolid(result, scratch)
      if (!solidified.ok || !solidified.shape) {
        return this.#editRefusal(
          `${label}: face ${faceId} offset by ${offset} did not yield a single closed solid (isSolid hard gate: ${solidified.reason}) — out-of-class`,
          faceId, 'error', { reason: solidified.reason ?? 'not a solid' },
        )
      }
      // #asSingleSolid may have unwrapped a new solid handle (pushing the old
      // compound onto `scratch` for release) — carry it forward as `result`.
      result = solidified.shape
      const newVol = k.getVolume(result)
      const volumeDelta = newVol - originalVol
      const expected = area * offset
      const tol = Math.max(1e-2, Math.abs(expected) * 5e-3)
      if (volumeDelta * offset <= 0 || Math.abs(volumeDelta - expected) > tol) {
        return this.#editRefusal(
          `${label}: face ${faceId} is not a rigid planar/cylindrical-neighbour offset (out-of-class): expected volume delta area*offset=${r3(expected)}, measured ${r3(volumeDelta)} (tol ${r3(tol)}) — neighbours did not re-close as a straight extend`,
          faceId, 'warning', { expected: r3(expected), measured: r3(volumeDelta) },
        )
      }
      // Id lineage: byte-identical + plane-offset-preserved survivors keep ids by
      // matchFacesToOriginals; the translated face + any curved NEIGHBOUR walls (whose
      // height/area/centroid changed but axis + concentricity did not) keep their
      // ids via the pair-by-offset pass. resolve() -> 'exact' (GEO-10-R1 finding 3).
      let assign = this.#assignEditedIds(rec, this.#faceProbes(result), fid, (remOrig, probes) => this.#pairByOffset(remOrig, probes))
      if (!assign.ok) {
        // GEO-6X6-R3: a true total tie (or unreadable geometry) among mint
        // candidates — structured refusal, never a silent order-dependent bind.
        return this.#editRefusal(`${label}: ${assign.reason}`, faceId, 'error')
      }

      // ---- WO UI-57 Design 5: seam healing (faceOffset ONLY — pocketDepth
      // reuses this same method but is explicitly out of this WO's scope;
      // "book follow-ups instead" per its SURVIVAL RULES). unifySameDomain is
      // a PURE topological merge (occt-wasm index.d.ts:456), volume-neutral
      // by construction (empirically confirmed via a real-kernel probe: a
      // box top-face pull's healed volume matched the unhealed volume
      // exactly) — safe to attempt only AFTER the volume gate above already
      // accepted the unhealed `result`. The healed candidate still gets its
      // OWN isValid/isSolid/volume-match gate below (never trusted blindly),
      // and any failure — geometric, OR #pairHealedFaces refusing an
      // ambiguous merge — is a NAMED fallback (ADR-0003): commit the
      // unhealed-but-valid `result` and surface "seam retained: <reason>",
      // never silently.
      let healReason: string | undefined
      let aliases = rec.aliases
      if (label === 'faceOffset') {
        try {
          const rawHealed = k.unifySameDomain(result)
          const singled = this.#asSingleSolid(rawHealed, scratch)
          if (!singled.ok || !singled.shape) {
            healReason = `unifySameDomain result was not a single closed solid: ${singled.reason ?? 'not a solid'}`
            try { k.release(rawHealed) } catch { /* */ }
          } else {
            let healedCandidate = singled.shape
            let healedVol = k.getVolume(healedCandidate)
            if (!k.isValid(healedCandidate) || !k.isSolid(healedCandidate) || !Number.isFinite(healedVol)) {
              // ShapeUpgrade_UnifySameDomain can merge the intended analytic
              // faces yet leave invalid pcurves around microscopic boolean
              // overlap slivers. ShapeFix repairs those curve-on-surface
              // records without changing the represented solid. This is the
              // same bounded pcurve repair used by curved defeaturing; the
              // validity, solid, volume-neutrality, and lineage gates below
              // still decide whether the repaired candidate is adoptable.
              try {
                const repairedRaw = k.fixShape(healedCandidate)
                const repairedSingle = this.#asSingleSolid(repairedRaw, scratch)
                if (!repairedSingle.ok || !repairedSingle.shape) {
                  healReason = `fixShape could not restore the unified result to a single closed solid: ${repairedSingle.reason ?? 'not a solid'}`
                  try { k.release(repairedRaw) } catch { /* */ }
                } else {
                  scratch.push(healedCandidate)
                  healedCandidate = repairedSingle.shape
                  healedVol = k.getVolume(healedCandidate)
                  // The first unifier skipped any same-cylinder merge whose
                  // pcurves were still invalid. Now that ShapeFix has repaired
                  // them, one bounded second pass can merge those remaining
                  // analytic stripes. Never loop: a second miss is a named
                  // fallback at the gates below, not an open-ended healer.
                  if (
                    k.isValid(healedCandidate) &&
                    k.isSolid(healedCandidate) &&
                    Number.isFinite(healedVol)
                  ) {
                    const reunitedRaw = k.unifySameDomain(healedCandidate)
                    const reunitedSingle = this.#asSingleSolid(reunitedRaw, scratch)
                    if (!reunitedSingle.ok || !reunitedSingle.shape) {
                      healReason = `second unifySameDomain pass was not a single closed solid: ${reunitedSingle.reason ?? 'not a solid'}`
                      try { k.release(reunitedRaw) } catch { /* */ }
                    } else {
                      scratch.push(healedCandidate)
                      healedCandidate = reunitedSingle.shape
                      healedVol = k.getVolume(healedCandidate)
                    }
                  }
                }
              } catch (e) {
                healReason = `fixShape threw while repairing the unified result: ${(e instanceof Error ? e.message : String(e)).slice(0, 120)}`
              }
            }
            if (
              healReason === undefined &&
              (!k.isValid(healedCandidate) || !k.isSolid(healedCandidate) || !Number.isFinite(healedVol))
            ) {
              healReason = 'healed result failed the isValid/isSolid/finite-volume gate after fixShape repair'
              scratch.push(healedCandidate)
            } else if (healReason !== undefined) {
              scratch.push(healedCandidate)
            } else if (Math.abs(healedVol - newVol) > Math.max(1e-6, Math.abs(newVol) * 1e-6)) {
              healReason = `healed volume ${r3(healedVol)}mm3 diverged from the unhealed result's ${r3(newVol)}mm3 (healing must be volume-neutral)`
              scratch.push(healedCandidate)
            } else {
              const pairing = this.#pairHealedFaces(fid, assign, this.#faceProbes(healedCandidate), rec.aliases)
              if (!pairing.ok) {
                healReason = pairing.reason
                scratch.push(healedCandidate)
              } else {
                scratch.push(result) // the unhealed shape is superseded
                result = healedCandidate
                assign = pairing
                aliases = pairing.aliases
              }
            }
          }
        } catch (e) {
          healReason = `unifySameDomain threw: ${(e instanceof Error ? e.message : String(e)).slice(0, 120)}`
        }
      }

      const handle = this.#mint({ shape: result as number, faceMap: assign.faceMap, snapshots: assign.snapshots, aliases })
      result = undefined // ownership transferred to the body record
      return {
        ok: true,
        body: handle,
        elementMap: { featureId: fid, modified: assign.modified, generated: assign.generated, deleted: assign.deleted, geometry: assign.geometry },
        diagnostics: healReason !== undefined ? [{ code: 'OK', severity: 'warning', params: { reason: `seam retained: ${healReason}` } }] : okDiag(),
      }
    } finally {
      for (const f of faces) { try { k.release(f) } catch { /* */ } }
      for (const s of scratch) { try { k.release(s) } catch { /* */ } }
      if (result !== undefined) { try { k.release(result) } catch { /* */ } }
    }
  }

  /**
   * Normalize a boolean result to a single CLOSED SOLID for the faceOffset/
   * pocketDepth isSolid hard gate (GEO-10-R1 finding 2). If `shape` is already
   * a solid, it is returned unchanged. Otherwise its solid subshapes are
   * enumerated: exactly one closed solid -> unwrap it (the caller mints it) and
   * push the old compound wrapper onto `scratch` for release; zero or more than
   * one closed solid -> fail (an emptied or split body is out-of-class). Every
   * non-adopted extracted handle is released here so nothing leaks.
   */
  #asSingleSolid(shape: ShapeHandle, scratch: ShapeHandle[]): { ok: boolean; shape?: ShapeHandle; reason?: string } {
    const k = this.#k()
    if (k.isSolid(shape)) return { ok: true, shape }
    let solids: ShapeHandle[] = []
    try {
      solids = k.getSubShapes(shape, 'solid')
      const closed = solids.filter((s) => { try { return k.isSolid(s) } catch { return false } })
      if (closed.length === 1) {
        const solid = closed[0]
        for (const s of solids) { if (s !== solid) { try { k.release(s) } catch { /* */ } } }
        scratch.push(shape) // release the compound wrapper on the finally path
        return { ok: true, shape: solid }
      }
      for (const s of solids) { try { k.release(s) } catch { /* */ } }
      return { ok: false, reason: `${closed.length} closed solids (expected exactly 1)` }
    } catch (e) {
      for (const s of solids) { try { k.release(s) } catch { /* */ } }
      return { ok: false, reason: `solid decomposition failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 80)}` }
    }
  }

  /**
   * WO-1455: does `shape` carry any real closed-solid content -- true for a
   * bare TopAbs_SOLID (k.isSolid()) AND for a compound wrapping one or more
   * solids (the routine boolean/push-pull result shape #asSingleSolid also
   * unwraps above), false only for a shape with NO solid subshape at all
   * (an imported open shell -- exactly readStepShape's own solidCount === 0
   * case, core.ts:153-158). Used to gate measure('volume'): unlike
   * #asSingleSolid this never refuses on "more than one solid" -- a
   * multi-solid compound's total volume is still a real, meaningful number.
   */
  #isClosedSolid(shape: ShapeHandle): boolean {
    const k = this.#k()
    if (k.isSolid(shape)) return true
    let solids: ShapeHandle[] = []
    try {
      solids = k.getSubShapes(shape, 'solid')
      return solids.length > 0
    } catch {
      return false
    } finally {
      for (const s of solids) { try { k.release(s) } catch { /* */ } }
    }
  }

  /**
   * WO-2171 relief: the exact relief face read in from its explicit poles
   * (reliefStep.ts, the route WO-2170 measured), the target face split by the
   * relief's outline, the inside piece dropped and the relief sewn in its
   * place (split + sewAndSolidify). The kernel's volume is NOT a gate here:
   * WO-2170 finding 3 measured getVolume misreading detailed B-spline faces by
   * up to 50 %, while the geometry itself was right - validity and closure are
   * the gates. Lineage: the face keeps its id on the piece outside the relief;
   * the relief face is generated.
   */
  #applyRelief(rec: BodyRecord, req: ReliefEditRequest): OpResult {
    const k = this.#k()
    const faceId = req.featureKey as StableId
    const r = req.relief
    const label = 'relief'
    const n = r?.n
    if (!Number.isInteger(n) || n < 4 || n > RELIEF_EXACT_POLE_CAP) {
      return this.#editRefusal(`${label}: an exact relief face takes 4 to ${RELIEF_EXACT_POLE_CAP} control points per side (got ${n})`, faceId, 'error')
    }
    if (r.heights.length !== n * n || !(r.widthMm > 0) || !(r.heightMm > 0)) {
      return this.#editRefusal(`${label}: ${r.heights.length} heights for ${n} x ${n} control points over ${r.widthMm} x ${r.heightMm} mm`, faceId, 'error')
    }
    for (let i = 0; i < r.heights.length; i++) {
      if (!Number.isFinite(r.heights[i])) return this.#editRefusal(`${label}: control point ${i} has no finite height`, faceId, 'error')
    }
    // WO-2200 (rule 11): a working grid the mesh route cannot use is dropped, not
    // refused - the relief is still built, meshed from the exact face as main does.
    const allFinite = (a: ArrayLike<number>): boolean => { for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) return false; return true }
    const sent = r.detail
    const detail = sent !== undefined
      && Number.isInteger(sent.cols) && Number.isInteger(sent.rows) && sent.cols >= 4 && sent.rows >= 4
      && sent.heights.length === sent.cols * sent.rows && allFinite(sent.heights)
      ? sent : undefined
    const found = this.#resolveFaceSnap(rec, faceId)
    if (!found) return this.#editRefusal(`${label}: face ${faceId} does not resolve on this body`, faceId, 'error')
    if (found.snap.type !== 'plane') {
      return this.#editRefusal(`${label}: face ${faceId} is a ${found.snap.type} surface; this stage lays reliefs on flat faces`, faceId, 'warning', { surfaceType: found.snap.type })
    }
    const origSnap = found.snap
    const planeN = normalize(origSnap.normal as Vec3T)
    const liveId = this.#resolveFaceId(rec, faceId)
    const scratch: ShapeHandle[] = []
    let result: ShapeHandle | undefined
    const faces = k.getSubShapes(rec.shape as ShapeHandle, 'face')
    try {
      const target = faces.find((f) => k.hashCode(f, HM) === found.hash)
      if (target === undefined) return this.#editRefusal(`${label}: face ${faceId} does not resolve on this body`, faceId, 'error')
      const poles: ReliefPoles = { n, widthMm: r.widthMm, depthMm: r.heightMm, heights: Float64Array.from(r.heights) }
      const text = reliefFaceStepInFrame(poles, { origin: r.origin, xDir: r.xDir, yDir: r.yDir, normal: r.normal }, req.featureId.replace(/[^A-Za-z0-9_-]/g, '_'))
      const read = k.importStep(text)
      scratch.push(read)
      const reliefFaces = k.getSubShapes(read, 'face')
      scratch.push(...reliefFaces)
      if (reliefFaces.length !== 1) return this.#editRefusal(`${label}: the relief face read back as ${reliefFaces.length} faces`, faceId, 'error')
      const relief = reliefFaces[0]
      const edges = k.getSubShapes(relief, 'edge')
      scratch.push(...edges)
      const split = k.split(target, edges)
      scratch.push(split)
      const pieces = k.getSubShapes(split, 'face')
      scratch.push(...pieces)
      if (pieces.length !== 2) {
        return this.#editRefusal(`${label}: the relief's rectangle does not lie inside face ${faceId} (the face split into ${pieces.length} pieces) - move it or make it smaller so it stays on the face`, faceId, 'error', { pieces: pieces.length })
      }
      const area = r.widthMm * r.heightMm
      const areas = pieces.map((f) => k.getSurfaceArea(f))
      const inside = Math.abs(areas[0] - area) < Math.abs(areas[1] - area) ? 0 : 1
      // a rectangle reaching past the face's edge still cuts two pieces, but the inside one is short of it
      if (Math.abs(areas[inside] - area) > Math.max(1e-3, area * 1e-4)) {
        return this.#editRefusal(`${label}: the relief's rectangle does not lie inside face ${faceId} (${r3(areas[inside])} of its ${r3(area)} mm^2 are on the face) - move it or make it smaller so it stays on the face`, faceId, 'error')
      }
      const keep = pieces[1 - inside]
      const sewn = k.sewAndSolidify([...faces.filter((f) => f !== target), keep, relief], 1e-4)
      const single = this.#asSingleSolid(sewn, scratch)
      if (!single.ok || !single.shape) {
        scratch.push(sewn)
        return this.#editRefusal(`${label}: sewing the relief into face ${faceId} did not give one closed solid (${single.reason})`, faceId, 'error')
      }
      if (!k.isValid(single.shape) || !k.isSolid(single.shape)) {
        scratch.push(single.shape)
        return this.#editRefusal(`${label}: sewing the relief into face ${faceId} did not give a valid solid`, faceId, 'error')
      }
      // WO-2404: the faces sewn back in keep the triangulation an earlier tessellate
      // left on them, but sewing gave them new edges. Per-face meshing then reuses
      // that stale mesh, which no longer meets its neighbours (366 open edges on the
      // kit's medallion), and the snapshots read it as the face's shape. A copy
      // carries the exact geometry and no mesh.
      scratch.push(single.shape)
      result = k.copy(single.shape)
      const assign = this.#assignEditedIds(rec, this.#faceProbes(result), req.featureId, (remOrig, probes) => {
        // the picked face lives on as the piece of its plane outside the relief
        const o = remOrig.find((x) => x.id === liveId)
        if (o === undefined) return []
        let best: FaceProbe | undefined
        let bestD = Infinity
        for (const p of probes) {
          if (p.snapshot.type !== 'plane') continue
          if (dot(normalize(p.snapshot.normal as Vec3T), planeN) < 0.999) continue
          const off = Math.abs(dot(sub(p.snapshot.centroid as Vec3T, origSnap.centroid as Vec3T), planeN))
          if (off > 1e-6) continue
          const dA = Math.abs(origSnap.area - area - p.snapshot.area)
          if (dA < bestD) { bestD = dA; best = p }
        }
        return best === undefined ? [] : [{ id: o.id, probe: best }]
      })
      if (!assign.ok) return this.#editRefusal(`${label}: ${assign.reason}`, faceId, 'error')
      // the relief face is meshed by RELIEF_MESH wherever this id lives on (later features keep it by lineage)
      for (const id of assign.generated) this.#reliefFaceIds.add(id)
      // a mesh relief's face is meshed from its working grid (tessellate) wherever it lives on whole
      const frame: DetailFrame = { origin: r.origin, xDir: r.xDir, yDir: r.yDir, normal: r.normal, widthMm: r.widthMm, heightMm: r.heightMm }
      for (const id of assign.generated) {
        if (detail !== undefined) this.#reliefDetail.set(id, { frame, detail: { cols: detail.cols, rows: detail.rows, heights: Float32Array.from(detail.heights) } })
        else this.#reliefDetail.delete(id)
      }
      const handle = this.#mint({ shape: result as number, faceMap: assign.faceMap, snapshots: assign.snapshots, aliases: rec.aliases })
      result = undefined // ownership transferred to the body record
      return {
        ok: true,
        body: handle,
        elementMap: { featureId: req.featureId, modified: assign.modified, generated: assign.generated, deleted: assign.deleted, geometry: assign.geometry },
        diagnostics: [{ code: 'OK', severity: 'info', params: { surface: detail !== undefined ? 'mesh' : 'exact', controlPoints: n, ...(detail !== undefined ? { workingGrid: `${detail.cols} x ${detail.rows}` } : {}) } }],
      }
    } finally {
      for (const f of faces) { try { k.release(f) } catch { /* */ } }
      for (const sh of scratch) { try { k.release(sh) } catch { /* */ } }
      if (result !== undefined) { try { k.release(result) } catch { /* */ } }
    }
  }

  /** faceOffset: `featureKey` names the planar face StableId to push/pull. */
  #editFaceOffset(rec: BodyRecord, req: FaceEditRequest): OpResult {
    return this.#offsetFaceBoolean(rec, req.featureKey as StableId, req.delta, req.featureId, 'faceOffset')
  }

  /** pocketDepth: re-drive a recognized pocket's depth by offsetting its FLOOR
   *  face by -delta (deeper for +delta) through the same boolean-prism core. */
  #editPocketDepth(rec: BodyRecord, req: FaceEditRequest): OpResult {
    const k = this.#k()
    const recs = gatherFaces(k, rec.shape as ShapeHandle)
    try {
      const feats = recognizeFeaturesCore(k, rec.shape as ShapeHandle, recs)
      const f = feats.find((ff) => ff.key === req.featureKey)
      if (!f) return this.#editRefusal(`pocketDepth: feature ${req.featureKey} not found on this body`, req.featureKey, 'error')
      if (f.type !== 'pocket') {
        return this.#editRefusal(`pocketDepth: feature ${req.featureKey} is a ${f.type}, not a pocket — refused (wrong kind for this edit)`, req.featureKey, 'warning', { featureClass: f.type })
      }
      // The pocket floor = the dropped PLANAR face whose normal is parallel to the
      // host normal (faces the same way as the opening rim, i.e. the pocket bottom).
      const byHash = new Map(recs.map((r) => [r.hash, r]))
      const host = byHash.get(f.neighbourHashes[0])
      const hostN = host ? normalize([host.normal.x, host.normal.y, host.normal.z]) : ([0, 0, 1] as Vec3T)
      let floorHash: number | undefined
      let bestDot = 0.9
      for (const h of f.dropHashes) {
        const fr = byHash.get(h)
        if (!fr || fr.type !== 'plane') continue
        const nd = Math.abs(dot(normalize([fr.normal.x, fr.normal.y, fr.normal.z]), hostN))
        if (nd > bestDot) { bestDot = nd; floorHash = h }
      }
      if (floorHash === undefined) {
        return this.#editRefusal(`pocketDepth: could not isolate a planar floor face for pocket ${req.featureKey} (non-planar/through pocket) — refused in V1`, req.featureKey, 'warning')
      }
      const floorId = rec.faceMap.get(floorHash)
      if (floorId === undefined) return this.#editRefusal(`pocketDepth: pocket ${req.featureKey} floor face has no stable id`, req.featureKey, 'error')
      // deeper (delta > 0) => floor moves ALONG -hostNormal => offset the floor by
      // -delta along its own (host-parallel) normal. Shallower is the mirror.
      return this.#offsetFaceBoolean(rec, floorId, -req.delta, req.featureId, 'pocketDepth')
    } finally {
      releaseFaceRecs(k, recs)
    }
  }

  /** Remove exactly one recognized imported blend, find the one
   * sharp edge that removal created, then dress that recovered edge at the new
   * radius. The two kernel operations are assigned and minted once against the
   * original body, so callers receive one edit delta and one undoable feature. */
  #editImportedFilletRadius(rec: BodyRecord, req: ImportedFilletRequest): ImportedFilletBuildResult {
    const k = this.#k()
    const recs = gatherFaces(k, rec.shape as ShapeHandle)
    const scratch: ShapeHandle[] = []
    let healed: ShapeHandle | undefined
    let result: ShapeHandle | undefined
    let originalEdgeHandles: ShapeHandle[] = []
    let healedEdgeHandles: ShapeHandle[] = []
    const refuse = (result: OpResult): ImportedFilletBuildResult => ({ ok: false, diagnostics: result.diagnostics })
    try {
      const feats = recognizeFeaturesCore(k, rec.shape as ShapeHandle, recs)
      const feature = feats.find((candidate) => candidate.key === req.importedFeatureKey)
      if (feature === undefined) {
        return refuse(this.#editRefusal(`filletRadius: feature ${req.importedFeatureKey} not found on this body`, req.importedFeatureKey, 'error'))
      }
      if (!feature.type.startsWith('fillet') || !feature.removable || feature.dropHashes.length !== 1) {
        return refuse(this.#editRefusal(
          `filletRadius: feature ${req.importedFeatureKey} is not one independently removable imported fillet`,
          req.importedFeatureKey,
          'warning',
          { featureClass: feature.type },
        ))
      }
      const byHash = new Map(recs.map((face) => [face.hash, face] as const))
      const band = byHash.get(feature.dropHashes[0])
      const oldRadius = band === undefined ? undefined : this.#measureImportedFilletRadius(band)
      if (oldRadius === undefined) {
        return refuse(this.#editRefusal(`filletRadius: current radius for ${req.importedFeatureKey} could not be measured`, req.importedFeatureKey, 'error'))
      }
      const newRadius = req.radius
      if (!Number.isFinite(newRadius) || !(newRadius > 1e-4)) {
        return refuse(this.#editRefusal(
          `filletRadius: new radius ${r3(newRadius)} is not positive and finite (current ${r3(oldRadius)})`,
          req.importedFeatureKey,
          'warning',
        ))
      }

      const originalEdges = this.#edgeCandidates(rec.shape as ShapeHandle, rec)
      originalEdgeHandles = originalEdges.allHandles
      const originalEdgeIds = new Set(originalEdges.candidates.map((edge) => edge.id))
      const neighbourIds = new Set(
        feature.neighbourHashes
          .map((hash) => rec.faceMap.get(hash))
          .filter((id): id is StableId => id !== undefined),
      )

      const removal = this.#healRemovalForEdit(k, rec.shape as ShapeHandle, [feature], scratch, recs, 'filletRadius')
      if (!removal.ok || removal.shape === undefined) {
        return refuse(this.#editRefusal(
          `filletRadius: could not remove ${req.importedFeatureKey} before rebuilding it: ${removal.reason ?? 'heal failed'}`,
          req.importedFeatureKey,
          'error',
        ))
      }
      healed = removal.shape
      const healedAssign = this.#assignHealedIds(rec, healed, req.featureId)
      const healedRec: BodyRecord = {
        shape: healed,
        faceMap: healedAssign.faceMap,
        snapshots: healedAssign.snapshots,
        aliases: rec.aliases,
      }
      const healedEdges = this.#edgeCandidates(healed, healedRec)
      healedEdgeHandles = healedEdges.allHandles
      const recovered = healedEdges.candidates.filter((edge) =>
        !originalEdgeIds.has(edge.id) &&
        edge.faceIds.filter((faceId) => neighbourIds.has(faceId)).length >= 2,
      )
      if (recovered.length !== 1) {
        return refuse(this.#editRefusal(
          `filletRadius: removal of ${req.importedFeatureKey} produced ${recovered.length} candidate sharp edges; expected exactly one`,
          req.importedFeatureKey,
          'error',
          { recoveredEdges: recovered.length },
        ))
      }

      const evolution = k.filletWithHistory(
        healed,
        [recovered[0].handle],
        newRadius,
        [...healedRec.faceMap.keys()],
        HM,
      )
      result = evolution.result
      const resultVolume = k.getVolume(result)
      if (!k.isValid(result) || !Number.isFinite(resultVolume) || !(resultVolume > 1e-9)) {
        return refuse(this.#editRefusal(
          `filletRadius: rebuilding ${req.importedFeatureKey} at radius ${r3(newRadius)} did not yield a valid positive-volume result`,
          req.importedFeatureKey,
          'error',
        ))
      }
      const solidified = this.#asSingleSolid(result, scratch)
      if (!solidified.ok || solidified.shape === undefined) {
        return refuse(this.#editRefusal(
          `filletRadius: rebuilding ${req.importedFeatureKey} at radius ${r3(newRadius)} did not yield a single closed solid (${solidified.reason})`,
          req.importedFeatureKey,
          'error',
        ))
      }
      result = solidified.shape

      const targetFaceId = rec.faceMap.get(feature.dropHashes[0])
      const targetSnapshot = targetFaceId === undefined ? undefined : rec.snapshots.get(targetFaceId)
      const assign = this.#assignEditedIds(rec, this.#faceProbes(result), req.featureId, (remainingOriginals, probes) => {
        if (targetFaceId === undefined || targetSnapshot === undefined) return []
        const original = remainingOriginals.find((entry) => entry.id === targetFaceId)
        if (original === undefined) return []
        const candidates = probes.filter((probe) =>
          probe.snapshot.type === 'cylinder' &&
          probe.snapshot.radius !== undefined &&
          Math.abs(probe.snapshot.radius - newRadius) <= Math.max(1e-5, newRadius * 1e-5),
        )
        if (candidates.length === 0) return []
        candidates.sort((a, b) => len(sub(a.snapshot.centroid, targetSnapshot.centroid)) - len(sub(b.snapshot.centroid, targetSnapshot.centroid)))
        return [{ id: targetFaceId, probe: candidates[0] }]
      })
      if (!assign.ok) return refuse(this.#editRefusal(`filletRadius: ${assign.reason}`, req.importedFeatureKey, 'error'))
      const handle = this.#mint({
        shape: result as number,
        faceMap: assign.faceMap,
        snapshots: assign.snapshots,
        aliases: rec.aliases,
      })
      result = undefined
      return {
        ok: true,
        body: handle,
        assignment: assign,
      }
    } finally {
      for (const edge of healedEdgeHandles) { try { k.release(edge) } catch { /* */ } }
      for (const edge of originalEdgeHandles) { try { k.release(edge) } catch { /* */ } }
      if (healed !== undefined) { try { k.release(healed) } catch { /* */ } }
      for (const shape of scratch) {
        if (shape === healed || shape === result) continue
        try { k.release(shape) } catch { /* */ }
      }
      if (result !== undefined) { try { k.release(result) } catch { /* */ } }
      releaseFaceRecs(k, recs)
    }
  }

  /** One finite-data boundary shared by remove-and-rebuild edits. Keeping the
   * check here means every caller either receives an owned finite heal or a
   * named failure with no leaked success shape. */
  #healRemovalForEdit(
    k: OcctKernel,
    shape: ShapeHandle,
    features: RecognizedFeature[],
    scratch: ShapeHandle[],
    recs: FaceRec[],
    consumer: string,
  ): HealResult {
    const heal = healRemoval(k, shape, features, scratch, recs)
    if (!heal.ok || heal.shape === undefined) return heal
    if (Number.isFinite(heal.volumeDelta)) return heal
    try { k.release(heal.shape) } catch { /* already released */ }
    return {
      ok: false,
      reason: `${consumer}: heal reported success with a non-finite volumeDelta (${heal.volumeDelta}); refused at the edit consumer boundary`,
    }
  }

  /**
   * holeDiameter: heal the recognized hole away (existing healRemoval stack),
   * then re-cut the pilot at the new radius on the same axis + depth. Symmetric
   * for grow and shrink; through / blind / counterbore supported. A single entry
   * cone keeps its measured half-angle and axial depth at the resized bore edge.
   *
   * holeDepth (WO-2091): the same heal + re-cut at the SAME radius, entry cone
   * and counterbore, with the pilot's bottom moved to the new depth (measured
   * from the entry opening, like the recognizer's `depth`). A depth reaching the
   * far side of the part, or `through`, cuts through.
   */
  #recutHole(rec: BodyRecord, req: FaceEditRequest | HoleDepthEditRequest): OpResult {
    const k = this.#k()
    const recs = gatherFaces(k, rec.shape as ShapeHandle)
    const scratch: ShapeHandle[] = []
    let s1: ShapeHandle | undefined
    let result: ShapeHandle | undefined
    try {
      const feats = recognizeFeaturesCore(k, rec.shape as ShapeHandle, recs)
      const f = feats.find((ff) => ff.key === req.featureKey)
      if (!f) return this.#editRefusal(`holeDiameter: feature ${req.featureKey} not found on this body`, req.featureKey, 'error')
      if (f.type !== 'throughHole' && f.type !== 'blindHole' && f.type !== 'counterboreStack') {
        return this.#editRefusal(`holeDiameter: feature ${req.featureKey} is a ${f.type}, not a hole — refused (wrong kind)`, req.featureKey, 'warning', { featureClass: f.type })
      }
      const byHash = new Map(recs.map((r) => [r.hash, r]))
      const dropped = f.dropHashes.map((h) => byHash.get(h)).filter((r): r is FaceRec => r !== undefined)
      // Measured geometry: axis (outward), entry rim centre, pilot radius, depth.
      const axis = normalize([Number(f.params.axisX), Number(f.params.axisY), Number(f.params.axisZ)])
      if (Math.hypot(axis[0], axis[1], axis[2]) < 0.5) return this.#editRefusal(`holeDiameter: hole ${req.featureKey} has no resolvable axis`, req.featureKey, 'error')
      const entry: Vec3T = [f.fingerprint.cx, f.fingerprint.cy, f.fingerprint.cz]
      const oldR = Number(f.params.diameter) / 2
      const newR = req.kind === 'holeDiameter' ? oldR + req.delta / 2 : oldR
      if (!(newR > 1e-4)) return this.#editRefusal(`holeDiameter: resized radius ${r3(newR)} is not positive (delta ${req.delta} too negative for pilot Ø${r3(2 * oldR)})`, req.featureKey, 'warning')
      const cyls = dropped.filter((r) => r.type === 'cylinder' && r.radius !== undefined)
      const cbR = cyls.length ? Math.max(...cyls.map((r) => r.radius as number)) : oldR
      const isCounterbore = cbR > oldR + 1e-4
      if (isCounterbore && newR >= cbR - 1e-4) {
        return this.#editRefusal(`holeDiameter: resized pilot Ø${r3(2 * newR)} meets/exceeds the counterbore Ø${r3(2 * cbR)} — refused (would consume the spotface)`, req.featureKey, 'warning')
      }
      const cones = dropped.filter((r) => r.type === 'cone')
      if (cones.length > 1) {
        return this.#editRefusal(`holeDiameter: feature ${req.featureKey} has ${cones.length} cones in its stack; only one entry cone can be reconstructed`, req.featureKey, 'warning', { featureClass: 'countersink' })
      }
      const cone = cones.length === 1 ? this.#measureEntryCone(cones[0], axis) : undefined
      if (cones.length === 1 && cone === undefined) {
        return this.#editRefusal(`holeDiameter: feature ${req.featureKey} entry cone angle/depth could not be measured safely`, req.featureKey, 'warning', { featureClass: 'countersink' })
      }
      let fullDepth = Number(f.params.depth)
      let isThrough = f.type === 'throughHole'
      if (req.kind === 'holeDepth') {
        // Material along the drill direction from the entry opening (AABB bound):
        // a depth that reaches it breaks out of the far side -> a through hole.
        const drillDir = scale(axis, -1)
        const bb = this.#bodyBBox(rec.shape as ShapeHandle)
        let reach = 0
        for (const x of [bb.min[0], bb.max[0]]) for (const y of [bb.min[1], bb.max[1]]) for (const z of [bb.min[2], bb.max[2]]) {
          reach = Math.max(reach, dot([x - entry[0], y - entry[1], z - entry[2]], drillDir))
        }
        const newDepth = req.through === true ? reach : fullDepth + req.delta
        isThrough = req.through === true || newDepth >= reach - 1e-6
        fullDepth = newDepth
      }

      // 1) REMOVE: heal the hole away -> s1 (solid, openings closed). Non-destructive.
      // GEO-11-R2 (blocker 2, the SECOND HealResult consumer): this call site must
      // validate the heal at its own accept point, not trust the producer. Accept
      // ONLY a success carrying a FINITE volumeDelta; a non-finite delta refuses BY
      // NAME here (the same finite-data defense defeatureBatch already applies) so a
      // poisoned success can never seed the re-cut below.
      const heal = this.#healRemovalForEdit(k, rec.shape as ShapeHandle, [f], scratch, recs, 'holeDiameter')
      if (!heal.ok || !heal.shape) {
        return this.#editRefusal(`holeDiameter: could not heal hole ${req.featureKey} away before re-cut: ${heal.reason ?? 'heal failed'}`, req.featureKey, 'error')
      }
      s1 = heal.shape

      // 2) RE-CUT: build a cylinder (+ counterbore spotface) tool at the new radius.
      const drill = scale(axis, -1)
      const diag = this.#diagOf(s1)
      const tool = this.#buildHoleTool({ entry, drill, newR, fullDepth, isThrough, isCounterbore, cbR, cbLen: this.#axialExtent(cyls, cbR, axis), cone, diag, scratch })
      if (!tool) return this.#editRefusal(`holeDiameter: re-cut tool for ${req.featureKey} could not be built`, req.featureKey, 'error')
      const s1Hashes = k.getSubShapes(s1, 'face').map((fc) => { const h = k.hashCode(fc, HM); try { k.release(fc) } catch { /* */ } return h })
      result = k.cutWithHistory(s1, tool, s1Hashes, HM).result
      // GEO-11-R2 (blocker 2): the final mint gate FAIL-CLOSES on non-finite data
      // and requires SOLID classification, not just isValid + a bare `> 1e-9`
      // (Infinity > 1e-9 is true). No body is minted below unless the re-cut is a
      // valid solid with a finite positive volume.
      const resultVol = k.getVolume(result)
      const resultValid = k.isValid(result)
      if (!resultValid || !Number.isFinite(resultVol) || !(resultVol > 1e-9)) {
        return this.#editRefusal(`holeDiameter: re-cut of ${req.featureKey} at Ø${r3(2 * newR)} did not yield a valid positive-volume result (valid=${resultValid}, volume=${r3(resultVol)}) — out-of-class`, req.featureKey, 'error')
      }
      // Require a single CLOSED SOLID before minting: a boolean cut can wrap its
      // solid in a compound (isSolid rejects that), so normalize to the lone solid
      // first, matching the proven faceOffset gate (#asSingleSolid). Zero or >1
      // closed solids (an emptied or split body) refuses BY NAME.
      const solidified = this.#asSingleSolid(result, scratch)
      if (!solidified.ok || !solidified.shape) {
        return this.#editRefusal(`holeDiameter: re-cut of ${req.featureKey} at Ø${r3(2 * newR)} did not yield a single closed solid (isSolid hard gate: ${solidified.reason}) — out-of-class`, req.featureKey, 'error', { reason: solidified.reason ?? 'not a solid' })
      }
      // #asSingleSolid may have unwrapped a new solid handle (pushing the old
      // compound onto `scratch` for release) — carry it forward as `result`.
      result = solidified.shape

      // 3) Id lineage: unchanged faces keep ids by matchFacesToOriginals; the re-cut hole
      //    faces inherit the OLD hole face ids by role (type + axial position) so
      //    resolve(oldWall/floor id) -> 'exact', never 'lost' (criterion 2).
      const assign = this.#assignEditedIds(rec, this.#faceProbes(result), req.featureId, (remOrig, probes) => this.#pairByRole(remOrig, probes, axis))
      if (!assign.ok) {
        // GEO-6X6-R3: a true total tie (or unreadable geometry) among mint
        // candidates — structured refusal, never a silent order-dependent bind.
        return this.#editRefusal(`holeDiameter: ${assign.reason}`, req.featureKey, 'error')
      }
      const handle = this.#mint({ shape: result as number, faceMap: assign.faceMap, snapshots: assign.snapshots , aliases: rec.aliases })
      result = undefined
      return {
        ok: true,
        body: handle,
        elementMap: { featureId: req.featureId, modified: assign.modified, generated: assign.generated, deleted: assign.deleted, geometry: assign.geometry },
        diagnostics: okDiag(),
      }
    } finally {
      if (s1 !== undefined) { try { k.release(s1) } catch { /* */ } }
      for (const s of scratch) { if (s === s1) continue; try { k.release(s) } catch { /* */ } }
      if (result !== undefined) { try { k.release(result) } catch { /* */ } }
      releaseFaceRecs(k, recs)
    }
  }

  /** Build the re-cut pilot tool, plus a wider counterbore spotface and/or entry
   *  cone when present. Through holes overshoot both faces; blind holes stop at depth. */
  #buildHoleTool(o: {
    entry: Vec3T; drill: Vec3T; newR: number; fullDepth: number; isThrough: boolean
    isCounterbore: boolean; cbR: number; cbLen: number
    cone?: { axialDepth: number; halfAngle: number }
    diag: number; scratch: ShapeHandle[]
  }): ShapeHandle | undefined {
    const k = this.#k()
    const bodyDepth = o.diag + 10
    const margin = o.isThrough ? bodyDepth * 0.5 : 0
    const top = add(o.entry, scale(o.drill, -margin))
    const pilotLen = (o.isThrough ? bodyDepth : o.fullDepth) + margin
    let tool = this.#cylinderTool(top, o.drill, o.newR, pilotLen + margin, o.scratch)
    if (o.isCounterbore && o.cbLen > 1e-4) {
      const cb = this.#cylinderTool(top, o.drill, o.cbR, margin + o.cbLen, o.scratch)
      const fused = k.fuse(tool, cb)
      o.scratch.push(fused)
      tool = fused
    }
    if (o.cone) {
      const coneBottomR = o.isCounterbore ? o.cbR : o.newR
      const coneTopR = coneBottomR + o.cone.axialDepth * Math.tan(o.cone.halfAngle)
      const entryCone = this.#coneTool(o.entry, o.drill, coneTopR, coneBottomR, o.cone.axialDepth, o.scratch)
      const fused = k.fuse(tool, entryCone)
      o.scratch.push(fused)
      tool = fused
    }
    return tool
  }

  /** Measure a conical entry directly from its kernel face. The recognized hole
   *  supplies the trustworthy axis. A cone normal's axial component is
   *  sin(halfAngle); projecting its boundary vertices onto that axis gives the
   *  exact axial depth without an axis-aligned bounding-box assumption. */
  #measureEntryCone(cone: FaceRec, axis: Vec3T): { axialDepth: number; halfAngle: number } | undefined {
    const k = this.#k()
    const n = normalize([cone.normal.x, cone.normal.y, cone.normal.z])
    const sinHalf = Math.min(1, Math.abs(dot(n, axis)))
    const halfAngle = Math.asin(sinHalf)
    if (!Number.isFinite(halfAngle) || halfAngle <= 1e-6 || halfAngle >= Math.PI / 2 - 1e-6) return undefined
    const vertices = k.getSubShapes(cone.handle, 'vertex')
    try {
      if (vertices.length === 0) return undefined
      const axial = vertices.map((vertex) => {
        const point = k.vertexPosition(vertex)
        return dot([point.x, point.y, point.z], axis)
      })
      const axialDepth = Math.max(...axial) - Math.min(...axial)
      if (!Number.isFinite(axialDepth) || axialDepth <= 1e-6) return undefined
      return { axialDepth, halfAngle }
    } catch {
      return undefined
    } finally {
      for (const vertex of vertices) { try { k.release(vertex) } catch { /* */ } }
    }
  }

  /** Axial extent (mm) along `axis` of the widest (== `targetR`) cylinder face —
   *  the counterbore spotface depth. Projects the face bbox corners onto the axis. */
  #axialExtent(cyls: FaceRec[], targetR: number, axis: Vec3T): number {
    const cb = cyls.find((r) => Math.abs((r.radius ?? 0) - targetR) < 1e-4)
    if (!cb) return 0
    const b = cb.bbox
    const corners: Vec3T[] = [
      [b.xmin, b.ymin, b.zmin], [b.xmax, b.ymin, b.zmin], [b.xmin, b.ymax, b.zmin], [b.xmax, b.ymax, b.zmin],
      [b.xmin, b.ymin, b.zmax], [b.xmax, b.ymin, b.zmax], [b.xmin, b.ymax, b.zmax], [b.xmax, b.ymax, b.zmax],
    ]
    const proj = corners.map((c) => dot(c, axis))
    return Math.max(...proj) - Math.min(...proj)
  }

  /**
   * Build the edited body's faceMap/snapshots + ElementMapDelta vs the original.
   * Passes 1-2 are the shared `matchFacesToOriginals` (exact snapshot, then the
   * plane-support fallback over the remainder). Pass 3 (custom): pair the
   * REMAINING original ids to remaining result faces — the translated face
   * (faceOffset) or the re-cut hole faces (holeDiameter). Leftover result faces
   * get `<fid>:EDIT:new#j`; leftover original ids land in `deleted`.
   *
   * GEO-6X6-R3 (auditor's major): the mint tail used to sort leftover result
   * faces with `compareSnapshots` alone (centroid|area|type). Two REFUSED mint
   * candidates that collide on exactly those coarse fields compare EQUAL, so a
   * stable sort preserved arrival order and `new#0`/`new#1` swapped whichever
   * physical face they landed on when the caller's probe order reversed — the
   * auditor's repro. `orderMintCandidates` (stable-id.ts) strengthens the key
   * with `normal`/`axis` (fields `compareSnapshots` leaves unused for a given
   * type) to total-order genuinely distinct faces; when even THAT full key
   * ties — a true total tie, or a non-finite field it cannot safely read — it
   * returns a structured refusal instead of guessing. That refusal is
   * enumerated here to the LAST consumer: this method fails closed (`ok:
   * false`) rather than mint anything, and both callers (`#offsetFaceBoolean`,
   * `#recutHole`) turn it into a `DEFEATURE_UNSUPPORTED` refusal.
   */
  #assignEditedIds(
    rec: BodyRecord,
    finalProbes: FaceProbe[],
    fid: string,
    pairRemaining: (remOrig: Array<{ id: StableId; snap: GeometrySnapshot }>, probes: FaceProbe[]) => Array<{ id: StableId; probe: FaceProbe }>,
  ): {
    ok: true
    faceMap: Map<number, StableId>; snapshots: Map<StableId, GeometrySnapshot>
    modified: Record<StableId, StableId[]>; generated: StableId[]; deleted: StableId[]
    geometry: Record<StableId, ContractGeometrySnapshot>
  } | { ok: false; reason: string } {
    const m = matchFacesToOriginals(origFaces(rec), finalProbes)
    const faceMap = new Map<number, StableId>()
    const snapshots = new Map<StableId, GeometrySnapshot>()
    const modified: Record<StableId, StableId[]> = {}
    const generated: StableId[] = []
    const usedId = new Set<StableId>()
    for (const mt of m.matches) {
      faceMap.set(mt.probe.hash, mt.id); snapshots.set(mt.id, mt.probe.snapshot); usedId.add(mt.id)
      if (Math.abs(mt.probe.snapshot.area - mt.origSnap.area) > 1e-6) modified[mt.id] = [mt.id]
    }
    // pass 3 (edit-only): the caller pairs what the shared matcher left over —
    // the translated face (faceOffset) or the re-cut hole faces (holeDiameter).
    // GEO-6X6-R2 (auditor's major): a member the matcher REFUSED (ambiguous
    // exact-key or plane-support bucket) must never reach the caller's own
    // pairing rule — faceOffset's closest-area pick and holeDiameter's
    // sorted-zip are exactly the order-dependent bind the matcher refused to
    // do itself. Excluding refused members here means they fall straight
    // through to the unconditional mint/delete tail below, same discipline
    // the heal consumer (#assignHealedIds) already applies to every leftover.
    const unmatched = m.mintProbes
    const eligibleOrig = m.remainingOrig.filter((o) => !m.refusedOrigIds.has(o.id))
    const eligibleProbes = unmatched.filter((p) => !m.refusedProbes.has(p))
    const pairs = pairRemaining(eligibleOrig, eligibleProbes)
    const pairedProbe = new Set<number>()
    for (const { id, probe } of pairs) {
      if (usedId.has(id) || pairedProbe.has(probe.hash)) continue
      faceMap.set(probe.hash, id); snapshots.set(id, probe.snapshot); usedId.add(id); pairedProbe.add(probe.hash)
      modified[id] = [id]
    }
    const mintCandidates = unmatched.filter((p) => !pairedProbe.has(p.hash))
    const order = orderMintCandidates(mintCandidates)
    if (!order.ok) {
      return { ok: false, reason: `#assignEditedIds(${fid}): ${order.reason}` }
    }
    order.ordered.forEach((p, j) => {
      const id: StableId = `${fid}:EDIT:new#${j}`
      faceMap.set(p.hash, id); snapshots.set(id, p.snapshot); generated.push(id)
    })
    const deleted: StableId[] = m.remainingOrig.filter((o) => !usedId.has(o.id)).map((o) => o.id).sort()
    // UI-57-R2 blocker: re-state `rec`'s inherited lineage (see #assignHealedIds
    // -- same rule, same shared owner). This producer runs on EVERY face edit,
    // so it is the one a second push/pull on an already-healed body goes
    // through: without the fold, edit -> save -> reopen loses the first edit's
    // merged-away ids.
    const generatedIds = new Set(generated)
    foldAliasLineageIntoDelta({
      aliases: rec.aliases,
      isLive: (id) => snapshots.has(id),
      modified,
      isGenerated: (id) => generatedIds.has(id),
    })
    const geometry: Record<StableId, ContractGeometrySnapshot> = {}
    for (const [id, snap] of snapshots) geometry[id] = toContractGeometry(snap)
    for (const id of deleted) { const s = rec.snapshots.get(id); if (s) geometry[id] = toContractGeometry(s) }
    return { ok: true, faceMap, snapshots, modified, generated, deleted, geometry }
  }

  /**
   * Pair-by-offset (faceOffset / pocketDepth). Two neighbour classes survive an
   * offset with changed geometry and must keep their ids (never a silent 'lost'):
   *
   *  1. The MOVED planar face: preserves type + normal + area, only its plane
   *     offset changed -> matched by same-normal, closest-area.
   *  2. A CURVED NEIGHBOUR WALL of a holed face (cylinder / cone / torus): when
   *     the face it borders moves, the wall changes HEIGHT + AREA + CENTROID but
   *     keeps its AXIS DIRECTION and stays CONCENTRIC (its centroid rides the
   *     same axis line). area is useless here, so match by axis alignment +
   *     concentricity (perpendicular centroid offset ~ 0). This is the
   *     GEO-10-R1 finding-3 fix: without it the old cylindrical wall/floor id of
   *     an offset planar face is dropped to deleted/generated instead of 'exact'.
   */
  #pairByOffset(remOrig: Array<{ id: StableId; snap: GeometrySnapshot }>, probes: FaceProbe[]): Array<{ id: StableId; probe: FaceProbe }> {
    const pairs: Array<{ id: StableId; probe: FaceProbe }> = []
    const usedP = new Set<number>()
    // (1) planar moved faces: same type + normal, closest area.
    for (const o of remOrig) {
      if (o.snap.type !== 'plane') continue
      let best: FaceProbe | undefined
      let bestD = Infinity
      for (const p of probes) {
        if (usedP.has(p.hash) || p.snapshot.type !== 'plane') continue
        if (dot(normalize(p.snapshot.normal as Vec3T), normalize(o.snap.normal as Vec3T)) < 0.999) continue
        const dA = Math.abs(p.snapshot.area - o.snap.area)
        if (dA < bestD) { bestD = dA; best = p }
      }
      if (best && bestD < Math.max(1e-2, o.snap.area * 1e-3)) { pairs.push({ id: o.id, probe: best }); usedP.add(best.hash) }
    }
    // (2) curved neighbour walls: concentric + axis-aligned (area/height changed).
    for (const o of remOrig) {
      if (o.snap.type === 'plane' || !o.snap.axis) continue
      const oa = normalize(o.snap.axis as Vec3T)
      let best: FaceProbe | undefined
      let bestPerp = Infinity
      for (const p of probes) {
        if (usedP.has(p.hash) || p.snapshot.type !== o.snap.type || !p.snapshot.axis) continue
        if (Math.abs(dot(normalize(p.snapshot.axis as Vec3T), oa)) < 0.999) continue
        // concentric: the centroid-to-centroid vector is parallel to the axis
        // (pure axial slide, no radial move) -> its perpendicular part ~ 0.
        const d = sub(p.snapshot.centroid as Vec3T, o.snap.centroid as Vec3T)
        const along = scale(oa, dot(d, oa))
        const perp = Math.hypot(d[0] - along[0], d[1] - along[1], d[2] - along[2])
        if (perp < bestPerp) { bestPerp = perp; best = p }
      }
      if (best && bestPerp < 1e-2) { pairs.push({ id: o.id, probe: best }); usedP.add(best.hash) }
    }
    return pairs
  }

  /** Pair-by-role (holeDiameter): the re-cut hole faces changed geometry, so
   *  match remaining orig hole ids to remaining result hole faces by surface
   *  type + axial position along the drill axis (wall<->wall, floor<->floor,
   *  spotface<->spotface). Deterministic zip; no kernel enumeration order. */
  #pairByRole(remOrig: Array<{ id: StableId; snap: GeometrySnapshot }>, probes: FaceProbe[], axis: Vec3T): Array<{ id: StableId; probe: FaceProbe }> {
    const pairs: Array<{ id: StableId; probe: FaceProbe }> = []
    const axialO = (s: GeometrySnapshot): number => dot(s.centroid as Vec3T, axis)
    const groupO = new Map<string, Array<{ id: StableId; snap: GeometrySnapshot }>>()
    const groupP = new Map<string, FaceProbe[]>()
    for (const o of remOrig) { const g = groupO.get(o.snap.type) ?? []; g.push(o); groupO.set(o.snap.type, g) }
    for (const p of probes) { const g = groupP.get(p.snapshot.type) ?? []; g.push(p); groupP.set(p.snapshot.type, g) }
    for (const [t, os] of groupO) {
      const ps = groupP.get(t) ?? []
      const so = [...os].sort((a, b) => axialO(a.snap) - axialO(b.snap) || a.snap.area - b.snap.area)
      const sp = [...ps].sort((a, b) => axialO(a.snapshot) - axialO(b.snapshot) || a.snapshot.area - b.snapshot.area)
      const n = Math.min(so.length, sp.length)
      for (let i = 0; i < n; i++) pairs.push({ id: so[i].id, probe: sp[i] })
    }
    return pairs
  }

  /**
   * WO UI-57 Design 5 — the merge-aware StableId pairing pass for a healed
   * (unifySameDomain'd) shape. unifySameDomain is a MANY-TO-ONE merge: a
   * pre-existing wall face + the fresh prism side face become ONE bigger
   * face whose area falls outside every original face's pairing window (the
   * naive #pairByOffset-only version orphans the old wall's id to `deleted`
   * and mints a fresh one). unifySameDomain also rebuilds EVERY face's
   * kernel hash — even untouched ones — so this pass is 100% geometric,
   * never hash-based (verified empirically: 0/10 unhealed hashes survived a
   * probed unifySameDomain call, preserved as this WO's own preflight note).
   *
   * REQUIRED INVARIANT: a merged face keeps the StableId of a PRE-EXISTING
   * contributing face (never a freshly-generated prism face); when several
   * pre-existing ids merge, the losers are recorded as modified-with-alias
   * (their `modified` entry lists the survivor, and `aliases` maps them
   * forward to it) — NEVER silently `deleted`. An id genuinely absent from
   * the healed shape (no exact match, no clean merge group) is deleted.
   *
   * DELTA DIRECTION (UI-57-R1 blocker 3). The frozen contract
   * (geom-service.ts:66) defines `modified` as INPUT stableId -> SURVIVING
   * OUTPUT stableId(s). A many-to-one merge therefore emits one entry PER
   * CONTRIBUTING INPUT, each listing the single winner:
   *     modified[loser]  = [winner]      (for every pre-existing loser)
   *     modified[winner] = [winner]      (the winner was modified: it absorbed
   *                                       the losers' area)
   * NOT the inverted modified[winner] = [winner, ...losers], which reads as
   * "the winner was replaced by several outputs" and poisons restoreBody's
   * rebind universe (:4708-4712) by offering vanished losers up for a
   * geometric rebind onto unrelated leftover faces.
   *
   * A GENERATED contributor is an OUTPUT of this same delta, never an input:
   * one that survives healing stays in `generated`; one that merges away is
   * OMITTED entirely (it is neither a surviving output nor a deleted input —
   * it never existed for any consumer).
   *
   * ALIAS LINEAGE RIDES IN `modified` (the restore path). Every alias — the
   * ones minted here AND the ones inherited from earlier features — is itself
   * a contract-true `modified` entry: an aliased id IS an input to this
   * feature (it existed before it) and its sole surviving output IS the live
   * id it now resolves to. Emitting them all makes the delta a COMPLETE
   * statement of this body's id lineage, which is exactly what lets
   * restoreBody reconstruct `aliases` (#aliasesFromDelta) without widening the
   * frozen ElementMapDelta contract with a new field.
   *
   * Fails closed: a healed face that matches neither an exact unhealed
   * counterpart nor a clean same-domain group whose summed area equals its
   * own (within tolerance) REFUSES the whole healing attempt. Same-domain is
   * proven for planes by normal + plane offset, and for cylinders by radius +
   * axis line. Other curved kinds remain out of class. This keeps the same
   * "refuse rather than mis-bind" discipline matchFacesToOriginals already
   * uses, so the caller falls back to the unhealed (seam-retained) result
   * instead of guessing a wrong merge.
   */
  #pairHealedFaces(
    fid: string,
    unhealed: { faceMap: Map<number, StableId>; snapshots: Map<StableId, GeometrySnapshot>; modified: Record<StableId, StableId[]>; generated: StableId[]; deleted: StableId[] },
    healedProbes: FaceProbe[],
    inheritedAliases: Map<StableId, StableId> | undefined,
  ): {
    ok: true
    faceMap: Map<number, StableId>; snapshots: Map<StableId, GeometrySnapshot>
    modified: Record<StableId, StableId[]>; generated: StableId[]; deleted: StableId[]
    geometry: Record<StableId, ContractGeometrySnapshot>
    aliases: Map<StableId, StableId>
  } | { ok: false; reason: string } {
    const areaTol = (a: number): number => Math.max(1e-2, Math.abs(a) * 1e-3)
    const unhealedList: Array<{ id: StableId; probe: FaceProbe }> = []
    for (const [hash, id] of unhealed.faceMap) {
      const snap = unhealed.snapshots.get(id)
      if (snap) unhealedList.push({ id, probe: { hash, snapshot: snap } })
    }
    const generatedSet = new Set(unhealed.generated)
    const consumed = new Set<StableId>()
    const faceMap = new Map<number, StableId>()
    const snapshots = new Map<StableId, GeometrySnapshot>()
    // unhealed output id -> healed output id (identity for an untouched
    // survivor, the winner for every contributor of a merge). The one map every
    // delta field below is composed through.
    const healMap = new Map<StableId, StableId>()
    const mergeWinners = new Set<StableId>()
    const mintedHealIds: StableId[] = []
    const newAliases = new Map<StableId, StableId>()
    let mintCounter = 0
    const sameCylinderDomain = (a: GeometrySnapshot, b: GeometrySnapshot): boolean => {
      if (
        a.type !== 'cylinder' ||
        b.type !== 'cylinder' ||
        a.axis === undefined ||
        b.axis === undefined ||
        a.axisPoint === undefined ||
        b.axisPoint === undefined ||
        a.radius === undefined ||
        b.radius === undefined
      ) return false
      const aa = normalize(a.axis)
      const ba = normalize(b.axis)
      if (Math.abs(dot(aa, ba)) <= 0.999999) return false
      const radiusTol = Math.max(1e-4, Math.max(Math.abs(a.radius), Math.abs(b.radius)) * 1e-5)
      if (Math.abs(a.radius - b.radius) > radiusTol) return false
      // Axis points are non-unique along the axis. Compare only the component
      // perpendicular to the axis so differently sampled latitude circles on
      // the same cylinder still match, while parallel offset cylinders do not.
      const between = sub(b.axisPoint, a.axisPoint)
      const perpendicular = sub(between, scale(aa, dot(between, aa)))
      return len(perpendicular) < 1e-3
    }

    for (const h of healedProbes) {
      const hNormal = h.snapshot.normal ? normalize(h.snapshot.normal as Vec3T) : undefined
      // (1) EXACT untouched match — same type/normal/area/centroid, the
      // overwhelming common case (every face NOT adjacent to the edit).
      const exact = unhealedList.find(
        ({ id, probe }) =>
          !consumed.has(id) &&
          probe.snapshot.type === h.snapshot.type &&
          Math.abs(probe.snapshot.area - h.snapshot.area) < areaTol(h.snapshot.area) &&
          Math.hypot(
            probe.snapshot.centroid[0] - h.snapshot.centroid[0],
            probe.snapshot.centroid[1] - h.snapshot.centroid[1],
            probe.snapshot.centroid[2] - h.snapshot.centroid[2],
          ) < 1e-2 &&
          (hNormal === undefined || dot(normalize(probe.snapshot.normal as Vec3T), hNormal) > 0.999),
      )
      if (exact) {
        consumed.add(exact.id)
        healMap.set(exact.id, exact.id)
        faceMap.set(h.hash, exact.id)
        snapshots.set(exact.id, h.snapshot)
        continue
      }
      // (2) MERGE group. A translated planar face can merge with a coplanar
      // neighbour; an arc on its boundary can also extrude into a cylindrical
      // stripe that merges with the pre-existing fillet/hole cylinder. Both
      // cases require analytic same-domain proof before area can participate.
      let group: Array<{ id: StableId; probe: FaceProbe }>
      if (h.snapshot.type === 'plane' && hNormal !== undefined) {
        const hPlaneOffset = dot(hNormal, h.snapshot.centroid as Vec3T)
        group = unhealedList.filter(({ id, probe }) => {
          if (consumed.has(id) || probe.snapshot.type !== 'plane') return false
          const n = normalize(probe.snapshot.normal as Vec3T)
          if (dot(n, hNormal) <= 0.999) return false
          return Math.abs(dot(n, probe.snapshot.centroid as Vec3T) - hPlaneOffset) < 1e-2
        })
      } else if (h.snapshot.type === 'cylinder') {
        group = unhealedList.filter(
          ({ id, probe }) => !consumed.has(id) && sameCylinderDomain(probe.snapshot, h.snapshot),
        )
      } else {
        return { ok: false, reason: `healed face (type ${h.snapshot.type}, area ${r3(h.snapshot.area)}) has no exact unhealed counterpart and no supported analytic same-domain merge proof` }
      }
      const groupArea = group.reduce((s, g) => s + g.probe.snapshot.area, 0)
      if (group.length < 2 || Math.abs(groupArea - h.snapshot.area) > areaTol(h.snapshot.area)) {
        return {
          ok: false,
          reason: `healed face (${h.snapshot.type}, area ${r3(h.snapshot.area)}) did not resolve to an exact match or a clean same-domain merge group (best group: ${group.length} candidate(s), area ${r3(groupArea)})`,
        }
      }
      // Winner: a PRE-EXISTING contributor (never a freshly-generated prism
      // face) — lexicographically smallest for a deterministic tie-break
      // when several pre-existing ids merge at once.
      const preExisting = group.map((g) => g.id).filter((id) => !generatedSet.has(id)).sort()
      const winner: StableId = preExisting.length > 0 ? preExisting[0] : (`${fid}:EDIT:heal#${mintCounter++}` as StableId)
      if (preExisting.length === 0) mintedHealIds.push(winner)
      mergeWinners.add(winner)
      for (const g of group) {
        consumed.add(g.id)
        healMap.set(g.id, winner)
        if (g.id !== winner && !generatedSet.has(g.id)) {
          // A freshly-generated prism face has no prior meaning to alias —
          // only a PRE-EXISTING id needs a forward pointer so a caller who
          // still holds it (a second faceEdit, a modelReference, a selection)
          // resolves.
          newAliases.set(g.id, winner)
        }
      }
      faceMap.set(h.hash, winner)
      snapshots.set(winner, h.snapshot)
    }

    // ---- delta composition (see the DELTA DIRECTION block above) ----------
    const modified: Record<StableId, StableId[]> = {}
    /** Record `input -> output`, refusing any GENERATED input: a face born in
     *  this same delta is an output, never an input the contract can key on. */
    const noteModified = (input: StableId, output: StableId): void => {
      if (generatedSet.has(input)) return
      const cur = modified[input]
      if (cur === undefined) modified[input] = [output]
      else if (!cur.includes(output)) cur.push(output)
    }
    // (a) carry the unhealed pass's own entries forward through the heal map.
    //     Its keys are always PRE-EXISTING input ids that survived as
    //     themselves, so this is a pure value rewrite; an output that vanished
    //     in healing drops out here and is caught by the `deleted` tail below.
    for (const [input, outputs] of Object.entries(unhealed.modified)) {
      for (const o of outputs) {
        const healed = healMap.get(o)
        if (healed !== undefined) noteModified(input as StableId, healed)
      }
    }
    // (b) every PRE-EXISTING contributor of a merge is an input whose sole
    //     surviving output is the winner — the winner included (it was
    //     modified: it absorbed the losers' area).
    for (const [u, healed] of healMap) {
      if (mergeWinners.has(healed)) noteModified(u, healed)
    }

    // A generated face survives as itself or is omitted entirely — never
    // `deleted` (it was not an input) and never a `modified` key.
    const generated: StableId[] = [...unhealed.generated.filter((g) => healMap.get(g) === g), ...mintedHealIds]

    const deleted: StableId[] = [...unhealed.deleted]
    for (const { id } of unhealedList) {
      if (consumed.has(id) || generatedSet.has(id)) continue
      deleted.push(id)
    }
    deleted.sort()

    // Alias map: inherited chain + this pass's merges, PATH-COMPRESSED so every
    // entry points straight at a currently-live root (an inherited alias whose
    // old root just merged again must follow the second merge too).
    const aliases = new Map<StableId, StableId>(inheritedAliases ?? [])
    for (const [loser, winner] of newAliases) aliases.set(loser, winner)
    for (const loser of [...aliases.keys()]) {
      let root = aliases.get(loser) as StableId
      const seen = new Set<StableId>([loser])
      while (!seen.has(root) && aliases.has(root)) { seen.add(root); root = aliases.get(root) as StableId }
      const healedRoot = healMap.get(root) ?? root
      aliases.set(loser, healedRoot)
    }
    // Lineage rides in `modified` so restoreBody can rebuild this map from the
    // delta alone.
    //
    // UI-57-R2: this used to be an inline `if (snapshots.has(healedRoot))
    // noteModified(loser, healedRoot)` in the compression loop above -- which
    // emitted modified[loser] = [root] but NOT the root's own `modified[root] =
    // [root]` survivor marker. For a root this pass merged, step (b) happened to
    // emit that marker anyway (a merge winner is in healMap and mergeWinners),
    // which is why the single-heal round trip passed. For an INHERITED alias
    // whose root this pass does not touch -- heal, then heal again elsewhere --
    // no marker was emitted, aliasesFromDelta rejected the entry as a
    // rename/split, and the alias was silently dropped on restore. So this
    // producer, the one the WO calls the template, had the blocker's own bug in
    // its second generation. It now routes through the SAME shared fold every
    // other producer does, which owns both halves and cannot emit one without
    // the other.
    foldAliasLineageIntoDelta({
      aliases,
      isLive: (id) => snapshots.has(id),
      modified,
      isGenerated: (id) => generatedSet.has(id),
    })

    const geometry: Record<StableId, ContractGeometrySnapshot> = {}
    for (const [id, snap] of snapshots) geometry[id] = toContractGeometry(snap)
    for (const id of deleted) {
      const s = unhealed.snapshots.get(id)
      if (s) geometry[id] = toContractGeometry(s)
    }
    return { ok: true, faceMap, snapshots, modified, generated, deleted, geometry, aliases }
  }

  /** UI-57-R1 blocker 2/3: rebuild the alias map from a delta's `modified`
   *  lineage — the inverse of what #pairHealedFaces emits. The rule itself
   *  lives in ../aliasLineage.ts because the UI's own store migration
   *  (workbench/faceIdMigration.ts) must read the SAME lineage the same way;
   *  two copies of this rule would be two resolvers, which is the bypass
   *  blocker 2 exists to close. */
  #aliasesFromDelta(map: ElementMapDelta): Map<StableId, StableId> | undefined {
    const aliases = aliasesFromDelta(map)
    return aliases.size > 0 ? aliases : undefined
  }

  /**
   * THE SHARED FACE-ID RESOLVER (WO UI-57 Design 5; made shared by UI-57-R1
   * blocker 2). Follows rec.aliases from `id` to its current root — a
   * merge-healed loser id forwards to the survivor it merged into, which may
   * itself have merged again in a later edit. Bounded by a `seen` set so a
   * hypothetical cycle (should never occur — aliases only ever point toward a
   * currently-live id) refuses (returns `id` unresolved) rather than looping
   * forever.
   *
   * EVERY consumer that accepts a caller-supplied face StableId resolves
   * through this, or through the two helpers built on it (#faceHashIndex,
   * #resolveFaceSnap). A direct `rec.faceMap` inversion or a current-id
   * equality compare silently rejects a merged-away id — that bypass is what
   * UI-57-R1 blocker 2 named. See #faceHashIndex for the consumer census.
   */
  #resolveFaceId(rec: BodyRecord, id: StableId): StableId {
    return resolveFaceIdVia(rec.aliases, id)
  }

  /**
   * The shared id -> live kernel-hash index, with every alias folded in so a
   * merged-away pre-existing id lands on its winner's live face. Built once per
   * consumer call (the naive per-id `[...faceMap.entries()].find()` is O(n) per
   * id; this is O(n) for the whole call).
   *
   * CONSUMER CENSUS (UI-57-R1 blocker 2) — every engine site that turns a
   * caller-supplied face StableId into a live face now routes through this or
   * #resolveFaceSnap, and each has a merged-loser regression in
   * src/tests/geom/faceOffsetHealing.test.ts:
   *   makeHole, applyShell, applyDraft, measure('area'), classifyFace,
   *   #resolveFaceSnap (faceOffset/pocketDepth), resolve(), and the edge lane
   *   via #migrateEdgeId (fillet/chamfer/measure('length')).
   * A live id always outranks its own alias entry: an id that is BOTH live and
   * an alias key (impossible today, but a cheap invariant to hold) resolves to
   * its own face, never to a winner it once pointed at.
   */
  #faceHashIndex(rec: BodyRecord): Map<StableId, number> {
    return faceHashIndexVia(rec.faceMap, rec.aliases)
  }

  // ---- interrogation ---------------------------------------------------
  async resolve(h: BodyHandle, ids: StableId[]): Promise<Array<{
    id: StableId
    status: 'exact' | 'fallback' | 'lost'
    localIndex?: number
    type?: SubshapeType
  }>> {
    type Resolution = { id: StableId; status: 'exact' | 'fallback' | 'lost'; localIndex?: number; type?: SubshapeType }
    const k = this.#k()
    const rec = this.#rec(h)
    const shape = rec.shape as ShapeHandle
    const faces = k.getSubShapes(shape, 'face')
    // id -> current local face index. Anything that does not resolve exactly or
    // through a known lineage degrades to 'lost' rather than guess, which the
    // spec calls the only safe failure.
    const idToIndex = new Map<StableId, number>()
    try {
      faces.forEach((f, i) => {
        const id = rec.faceMap.get(k.hashCode(f, HM))
        if (id !== undefined) idToIndex.set(id, i)
      })
    } finally {
      for (const f of faces) try { k.release(f) } catch { /* already released */ }
    }
    const out: Resolution[] = ids.map((id) => {
      const localIndex = idToIndex.get(id)
      if (localIndex !== undefined) return { id, status: 'exact' as const, localIndex, type: 'face' as SubshapeType }
      // WO UI-57 Design 5: a merge-healed id is no longer a direct faceMap
      // member, but its alias root might be — a real, still-live face whose
      // GEOMETRY moved (it absorbed this id's old face), so 'fallback' (a
      // geometric rebind), never a silent 'lost'.
      const resolvedId = this.#resolveFaceId(rec, id)
      const aliasedIndex = resolvedId !== id ? idToIndex.get(resolvedId) : undefined
      return aliasedIndex !== undefined
        ? { id, status: 'fallback' as const, localIndex: aliasedIndex, type: 'face' as SubshapeType }
        : { id, status: 'lost' as const }
    })

    // WO-1411: edge and vertex ids (the parenthesized derived forms). Before
    // this branch every edge id came back 'lost', so an edge-chain op degraded
    // on the first regen pass whether or not its edges changed. Edges use the
    // SAME identity machinery measure('length') trusts: the live edge id list
    // (#edgeIdsFor), face-alias migration (migrateEdgeIdVia), then
    // resolvePersistedEdgeId. 'localIndex' indexes getSubShapes(shape, 'edge' |
    // 'vertex'), matching the face path's own convention.
    const pending = out.flatMap((r, i) => (r.status === 'lost' && (r.id as string).startsWith('(') ? [i] : []))
    if (pending.length === 0) return out
    const { handles: edgeHandles, ids: edgeIdList } = this.#edgeIdsFor(shape, rec)
    for (const eh of edgeHandles) try { k.release(eh) } catch { /* already released */ }
    const vertexPending: number[] = []
    for (const i of pending) {
      const id = out[i].id
      const migratedId = migrateEdgeIdVia(rec.aliases, id)
      const res = resolvePersistedEdgeId(migratedId, edgeIdList)
      // exact on the persisted string -> 'exact'; exact only after alias
      // migration, or a lone lineage survivor ('migrated') -> 'fallback'.
      // 'ambiguous' refuses as 'lost' (never a guessed rebind).
      if (res.status === 'exact' || res.status === 'migrated') {
        const status = res.status === 'exact' && migratedId === id ? 'exact' as const : 'fallback' as const
        out[i] = { id, status, localIndex: edgeIdList.indexOf(res.id), type: 'edge' as SubshapeType }
      } else if (res.status === 'lost') {
        vertexPending.push(i)
      }
    }
    if (vertexPending.length === 0) return out
    const vertices = k.getSubShapes(shape, 'vertex')
    try {
      const liveVertexIds = this.#vertexIdsOf(rec, vertices)
      const indexOfUnique = (id: StableId): number => {
        const first = liveVertexIds.indexOf(id)
        return first !== -1 && liveVertexIds.indexOf(id, first + 1) === -1 ? first : -1
      }
      for (const i of vertexPending) {
        const id = out[i].id
        const exactIndex = indexOfUnique(id)
        if (exactIndex !== -1) {
          out[i] = { id, status: 'exact', localIndex: exactIndex, type: 'vertex' as SubshapeType }
          continue
        }
        const normalized = this.#normalizeVertexId(rec, id)
        const aliasedIndex = normalized !== id ? indexOfUnique(normalized) : -1
        if (aliasedIndex !== -1) out[i] = { id, status: 'fallback', localIndex: aliasedIndex, type: 'vertex' as SubshapeType }
      }
    } finally {
      for (const v of vertices) try { k.release(v) } catch { /* already released */ }
    }
    return out
  }

  async measure(h: BodyHandle, kind: MeasureResult['kind'], ids?: StableId[]): Promise<MeasureResult> {
    const k = this.#k()
    const rec = this.#rec(h)
    const shape = rec.shape as ShapeHandle

    // GEO-3 BK-20: id-scoped area returns the named FACE's own analytic surface
    // area (getSurfaceArea per face), NOT the whole-body surface. The
    // whole-body call (no ids) is unchanged below. getSubShapes('face') mints
    // one caller-owned handle per face — release every one on BOTH the success
    // and throw paths (GEO-1-R1.3 precedent) or an id-scoped area() call leaks
    // one kernel shape per face on the body forever.
    if (kind === 'area' && ids && ids.length > 0) {
      // UI-57-R1 blocker 2: resolve every REQUESTED id through the shared
      // resolver before comparing against live ids — a merged-away id is not a
      // current faceMap value and would otherwise never match (and, with all
      // ids aliased, throw as if the caller had named nothing real).
      // Several requested ids can resolve to the SAME winner (a loser and the
      // face it merged into): that face's area counts ONCE, but each requested
      // id still counts toward `matched`, so `unresolvedCount` stays truthful.
      const wanted = new Map<StableId, number>()
      for (const id of ids) {
        const root = this.#resolveFaceId(rec, id)
        wanted.set(root, (wanted.get(root) ?? 0) + 1)
      }
      const faces = k.getSubShapes(shape, 'face')
      try {
        let total = 0
        let matched = 0
        for (const f of faces) {
          const id = rec.faceMap.get(k.hashCode(f, HM))
          const askedFor = id !== undefined ? wanted.get(id) : undefined
          if (askedFor !== undefined) {
            total += k.getSurfaceArea(f)
            matched += askedFor
          }
        }
        if (matched === 0) {
          throw new Error(`measure('area', ids): none of [${ids.join(', ')}] resolved to a face on body ${h}`)
        }
        return matched === ids.length
          ? { kind, value: total }
          : { kind, value: total, aux: { unresolvedCount: ids.length - matched } }
      } finally {
        for (const f of faces) {
          try { k.release(f) } catch { /* already released */ }
        }
      }
    }

    // GEO-2 BK-10b: edge-scoped length uses the kernel's ANALYTIC curve
    // length (exact for lines/circles/etc.), not a deflection-dependent
    // polyline sum. Only 'length' is id-scoped today — face-scoped
    // distance/radius/angle stay Stage-2 resolver work (unimplemented below).
    if (kind === 'length' && ids && ids.length > 0) {
      // GEO-2-R1.3: #edgeIdsFor's `handles` are caller-owned (see its
      // docstring) — release every one of them once curveLength() is done,
      // on BOTH the success and throw paths, or an id-scoped length() call
      // leaks one kernel shape per edge on the body forever.
      const { handles, ids: edgeIdList } = this.#edgeIdsFor(shape, rec)
      try {
        // ICR-3 step 1 (GEO-15-R1): edge-length is a PICKED-id resolver too, via
        // indexOf (first-wins) into the parallel id list. A requested id that
        // collides with a twin (edgeId face-pair collapse) would silently
        // measure only the first edge and report it as fully resolved. Refuse
        // instead -- STRUCTURALLY and WITHOUT a throw (the architect/WO contract
        // for a collision refusal is "structured, named, never a throw"). The
        // frozen MeasureResult (geom-service.ts) has no failure member and its
        // aux is numeric-only, so this layer cannot carry the id STRING: it
        // refuses structurally with value NaN (no meaningful length --
        // formatReadout renders "unavailable") plus aux.edgeIdCollisionCount =
        // how many of the requested ids are ambiguous. The NAMED refusal (id +
        // count) is produced one layer up by the UI resolver (measureLogic.ts
        // measureSingle) via the structured MeasureFailure, which refuses BEFORE
        // this call is ever made; this structured sentinel is the same fail-loud
        // contract for any direct caller. Only ids the caller picked block the
        // measure -- a collision elsewhere on the body is never reported here.
        // UI-57-R1 blocker 2: migrate each persisted pick across this body's
        // face aliases before ANY edge-id reasoning -- an edge id embeds its
        // adjacent face ids verbatim, so a pick naming a merged-away face
        // matches no live edge until it is rewritten to name the winner.
        const migratedIds = ids.map((id) => migrateEdgeIdVia(rec.aliases, id))
        const colliding = this.#collidingPickedEdgeIds(migratedIds, edgeIdList)
        if (colliding.length > 0) {
          return { kind, value: NaN, aux: { edgeIdCollisionCount: colliding.length } }
        }
        // GEO-16 migration: resolve each persisted id against the current edge
        // list. exact/migrated -> measure the resolved edge; a persisted OLD BARE
        // id that now names a collided pair (ambiguous) is refused STRUCTURALLY
        // via the same NaN + aux.edgeIdCollisionCount sentinel (the frozen
        // MeasureResult cannot carry the id STRING; the NAMED refusal is the UI
        // measureLogic layer's job). 'lost' falls through to the unresolved path.
        let total = 0
        let matched = 0
        let ambiguousCount = 0
        for (const id of migratedIds) {
          const res = resolvePersistedEdgeId(id, edgeIdList)
          if (res.status === 'ambiguous') { ambiguousCount++; continue }
          const resolvedId = res.status === 'exact' || res.status === 'migrated' ? res.id : id
          const idx = edgeIdList.indexOf(resolvedId)
          if (idx === -1) continue
          matched++
          total += k.curveLength(handles[idx])
        }
        if (ambiguousCount > 0) {
          return { kind, value: NaN, aux: { edgeIdCollisionCount: ambiguousCount } }
        }
        if (matched === 0) {
          throw new Error(`measure('length', ids): none of [${ids.join(', ')}] resolved to an edge on body ${h}`)
        }
        return matched === ids.length
          ? { kind, value: total }
          : { kind, value: total, aux: { unresolvedCount: ids.length - matched } }
      } finally {
        for (const eh of handles) {
          try { k.release(eh) } catch { /* already released */ }
        }
      }
    }

    switch (kind) {
      case 'volume':
        // WO-1455: volume (and mass/CoM, which callers derive from it) is
        // undefined for an open shell -- k.getVolume() on a non-solid shape
        // returns a number, but it is not a volume (verified: an open 30x20x10
        // box missing one face measured 4800 instead of refusing). Refuse BY
        // NAME instead of returning that number as if it meant something.
        // k.isSolid() alone is too strict here: a boolean/push-pull result is
        // routinely a COMPOUND wrapping one real closed solid (see
        // #asSingleSolid above, same shape), which k.isSolid() reports false
        // for even though it is perfectly measurable -- #isClosedSolid also
        // accepts that case, and only refuses a shape with NO solid content
        // at all (exactly readStepShape's own solidCount === 0 case).
        if (!this.#isClosedSolid(shape)) {
          throw new Error(
            `measure('volume') refused for body ${h}: the body is not a closed solid (open shell) -- volume, mass and center of mass require a closed solid`,
          )
        }
        return { kind, value: k.getVolume(shape) }
      case 'area':
        return { kind, value: k.getSurfaceArea(shape) }
      case 'length': {
        // Whole-body fallback (no ids given): total edge length via wireframe
        // polyline sum. Kept for the Stage-1 body-measure use case; exact
        // per-edge length is the ids-scoped path above.
        const wf = k.wireframe(shape, 0.01)
        let len = 0
        const gc = wf.edgeGroups.length / 3
        for (let g = 0; g < gc; g++) {
          const start = wf.edgeGroups[g * 3]
          const count = wf.edgeGroups[g * 3 + 1]
          for (let p = start; p < start + count - 3; p += 3) {
            len += Math.hypot(
              wf.points[p + 3] - wf.points[p],
              wf.points[p + 4] - wf.points[p + 1],
              wf.points[p + 5] - wf.points[p + 2],
            )
          }
        }
        return { kind, value: len }
      }
      default:
        throw new Error(`measure kind '${kind}' is not implemented in the Stage-1 subset`)
    }
  }

  async classifyFace(h: BodyHandle, id: StableId): Promise<
    'plane' | 'cylinder' | 'cone' | 'sphere' | 'torus' | 'bspline' | 'other'
  > {
    const k = this.#k()
    const rec = this.#rec(h)
    // UI-57-R1 blocker 2: compare against the SHARED-RESOLVER root, not the raw
    // caller id — a merged-away id classifies as its winner's surface (which is
    // the face it now names) instead of throwing "not found".
    const resolvedId = this.#resolveFaceId(rec, id)
    const faces = k.getSubShapes(rec.shape as ShapeHandle, 'face')
    for (const f of faces) {
      if (rec.faceMap.get(k.hashCode(f, HM)) === resolvedId) {
        const kind = toFaceKind(k.surfaceType(f))
        return kind === 'plane' || kind === 'cylinder' || kind === 'cone' || kind === 'sphere' || kind === 'torus' || kind === 'bspline'
          ? kind
          : 'other'
      }
    }
    throw new Error(`classifyFace: id '${id}' not found on body ${h}`)
  }

  // ---- I/O -------------------------------------------------------------

  /**
   * Walk an XCAF document's label tree collecting LEAF shapes (component
   * labels with an attached shape) plus their inherited name/color. Names and
   * colors that live on an ASSEMBLY label (common for single-body exports:
   * name on the root, no name on the component) are inherited down; a leaf's
   * OWN name/color wins over an inherited one. Bounded depth defends against
   * a pathological/cyclic label tree (real XCAF trees are acyclic DAGs, but
   * this is untrusted vendor file input).
   *
   * Per getLabelInfo's own doc comment ("If shapeHandle is non-null, the
   * caller owns it and must release it"): assembly labels that ALSO carry a
   * shape (some exporters emit a top-level compound alongside its children)
   * are redundant with what we collect from their children, so that shape is
   * released immediately rather than double-counted as a body.
   */
  #collectXCAFLeaves(doc: XCAFDocument): Array<{ shape: ShapeHandle; name?: string; color?: [number, number, number] }> {
    const k = this.#k()
    const leaves: Array<{ shape: ShapeHandle; name?: string; color?: [number, number, number] }> = []
    const MAX_DEPTH = 16
    const visit = (
      label: LabelTag,
      inheritedName: string | undefined,
      inheritedColor: [number, number, number] | undefined,
      depth: number,
    ): void => {
      if (depth > MAX_DEPTH) return
      const info = doc.getLabelInfo(label)
      // WO-2093: a label that is only the exporter's stamp ("Open CASCADE STEP
      // translator 7.9 2") names no part; treat it as absent so the body falls
      // back to the file name like any other unnamed STEP.
      const name = info.name.length > 0 && !isExporterStampName(info.name) ? info.name : inheritedName
      const color = info.hasColor ? info.color : inheritedColor
      if (info.isAssembly) {
        if (info.shapeHandle !== null) {
          try { k.release(info.shapeHandle) } catch { /* ignore */ }
        }
        for (const child of doc.getChildren(label)) visit(child, name, color, depth + 1)
      } else if (info.shapeHandle !== null) {
        leaves.push({ shape: info.shapeHandle, name, color })
      }
    }
    for (const root of doc.getRoots()) visit(root, undefined, undefined, 0)
    return leaves
  }

  /**
   * importStep (GEO-2 acceptance #1/#2). Two-phase: try the XCAF path first
   * (names/colors from the STEP PRODUCT/label tree, verified working against
   * this package 2026-07-07 — see STAGE0_FINDINGS gotcha #9 and this WO's
   * report). If the file carries no usable XCAF structure — no PRODUCT tree,
   * or importXCAFFromSTEP throws on a pure-geometry STEP export — we degrade
   * to the plain importStep() path with deterministic `IMPn:step:body#k`
   * names. Both outcomes are contract-legal (ImportedBody.name is optional);
   * the gap is recorded as a documented 'OK'/info diagnostic either way, per
   * WO GEO-2 criterion 2 ("an undocumented silent gap is not" acceptable).
   */
  async importStep(bytes: ArrayBuffer, importId: string): Promise<{ bodies: ImportedBody[]; diagnostics: Diag[] }> {
    const k = this.#k()
    const diagnostics: Diag[] = []

    type Source = { shape: ShapeHandle; name?: string; color?: [number, number, number] }
    let sources: Source[] = []
    try {
      const text = new TextDecoder().decode(bytes)
      const doc = k.importXCAFFromSTEP(text)
      try {
        sources = this.#collectXCAFLeaves(doc)
      } finally {
        doc.close()
      }
      if (sources.length === 0) {
        diagnostics.push({
          code: 'OK',
          severity: 'info',
          params: { xcafGap: 'importXCAFFromSTEP returned no labeled component shapes (file has no PRODUCT/XCAF structure) -- falling back to plain importStep with deterministic body names' },
        })
      }
    } catch (e) {
      // CAM-13-R1: severity 'warning' (not 'info' like the benign "no XCAF
      // structure at all" case above) -- this branch means the reader COULD NOT
      // PARSE the file's XCAF/product structure (a real read failure degrading
      // to the plain-geometry fallback), which callers must be able to tell
      // apart from a file that legitimately carries no PRODUCT/XCAF data at all
      // (ADR-0003: distinguish attribute ABSENCE from parser/read FAILURE).
      // src/lib/import/stepAttributes.ts consumes this severity to surface a
      // named degrade warning; the "no labeled component shapes" branch above
      // stays 'info' on purpose since it needs no warning (A2-defaults).
      diagnostics.push({
        code: 'OK',
        severity: 'warning',
        params: {
          xcafGap: 'importXCAFFromSTEP threw -- falling back to plain importStep with deterministic body names',
          message: (e instanceof Error ? e.message : String(e)).slice(0, 200),
        },
      })
    }

    if (sources.length === 0) {
      let root: ShapeHandle
      try {
        root = k.importStep(bytes)
      } catch (e) {
        return {
          bodies: [],
          diagnostics: [{ code: 'KERNEL_OP_FAILED', severity: 'error', params: { op: 'importStep', message: (e instanceof Error ? e.message : String(e)).slice(0, 200) } }],
        }
      }
      let solids = k.getSubShapes(root, 'solid')
      if (solids.length === 0) solids = [root]
      sources = solids.map((shape) => ({ shape }))
    }

    const bodies: ImportedBody[] = []
    // Import-order face index is FROZEN across the whole import (spec §Determinism).
    let faceCounter = 0
    let bodyCounter = 0
    for (const src of sources) {
      let solids = k.getSubShapes(src.shape, 'solid')
      // GEO-2-R1.2: if the leaf/source shape decomposes into DISTINCT solid
      // handles, those (not src.shape itself) get minted as bodies below, so
      // src.shape is caller-owned dead weight afterward -- release it. If it
      // does NOT decompose (solids.length===0), src.shape itself becomes the
      // sole minted body's shape (solids=[src.shape] below), so it must NOT
      // be released -- disposeAll()/dispose() own it from here on. This
      // closes the leaf shapeHandle leak from #collectXCAFLeaves (occt-wasm's
      // getLabelInfo docs: "the caller owns it and must release it") and
      // applies uniformly to the plain-importStep fallback's per-solid
      // sources too, since both paths converge on this one loop.
      const usesSrcShapeDirectly = solids.length === 0
      if (usesSrcShapeDirectly) solids = [src.shape]
      for (const solid of solids) {
        const faceMap = new Map<number, StableId>()
        const snapshots = new Map<StableId, GeometrySnapshot>()
        const geometry: Record<StableId, ContractGeometrySnapshot> = {}
        const probes = this.#faceProbes(solid)
        const generated: StableId[] = []
        for (const p of probes) {
          const id: StableId = `${importId}:step:face#${faceCounter++}`
          faceMap.set(p.hash, id)
          snapshots.set(id, p.snapshot)
          generated.push(id)
          geometry[id] = toContractGeometry(p.snapshot)
        }
        const handle = this.#mint({ shape: solid as number, faceMap, snapshots })
        bodies.push({
          handle,
          name: src.name ?? `${importId}:step:body#${bodyCounter}`,
          color: src.color,
          elementMap: { featureId: importId, modified: {}, generated, deleted: [], geometry },
        })
        bodyCounter++
      }
      if (!usesSrcShapeDirectly) {
        try { k.release(src.shape) } catch { /* already released */ }
      }
    }
    diagnostics.push(...okDiag())
    return { bodies, diagnostics }
  }

  /**
   * importIges (WO-1824). The kernel-side twin of importStep, minus the XCAF
   * phase: IGESControl_Reader carries no PRODUCT/label tree, so there is no
   * name/color source to try first and no degrade to record.
   *
   * IGES IS NOT A SOLID FORMAT. A file from the older CAD and legacy-parts
   * sites this exists for may hold a real MSBO solid (entity 186), a sewn
   * shell, a pile of trimmed surfaces (144), or nothing but wireframe curves.
   * This method refuses NONE of those (LIENCAM.md rule 11): it mints a body per
   * SOLID when the file has solids, and otherwise mints the shape the file
   * actually held as one body, returning a `content` census so the caller can
   * LABEL the part honestly rather than present surfaces as a solid. The only
   * error path is a file the reader could not read at all.
   */
  async importIges(bytes: ArrayBuffer, importId: string): Promise<{ bodies: ImportedBody[]; diagnostics: Diag[]; content: IgesContent }> {
    const k = this.#k()
    const empty: IgesContent = { solids: 0, shells: 0, faces: 0, wires: 0, edges: 0 }

    let root: ShapeHandle
    try {
      root = k.importIges(bytes)
    } catch (e) {
      return {
        bodies: [],
        diagnostics: [{ code: 'KERNEL_OP_FAILED', severity: 'error', params: { op: 'importIges', message: (e instanceof Error ? e.message : String(e)).slice(0, 200) } }],
        content: empty,
      }
    }

    // Census. getSubShapes hands back CALLER-OWNED handles (occt-wasm docs), so
    // every one counted here is released again immediately -- otherwise a
    // surface-heavy import leaks one kernel shape per face before a single body
    // is minted. The solid list below is the one exception: those handles
    // BECOME bodies.
    const countOf = (type: 'shell' | 'face' | 'wire' | 'edge'): number => {
      const subs = k.getSubShapes(root, type)
      for (const s of subs) {
        try { k.release(s) } catch { /* already released */ }
      }
      return subs.length
    }

    let solids = k.getSubShapes(root, 'solid')
    const content: IgesContent = {
      solids: solids.length,
      shells: countOf('shell'),
      faces: countOf('face'),
      wires: countOf('wire'),
      edges: countOf('edge'),
    }

    // No solids is NOT a failure: surfaces and wireframe are what most IGES
    // files hold, and the caller labels them. Mint the root itself so the part
    // still lands.
    const usesRootDirectly = solids.length === 0
    if (usesRootDirectly) solids = [root]

    const bodies: ImportedBody[] = []
    let faceCounter = 0
    let bodyCounter = 0
    for (const solid of solids) {
      const faceMap = new Map<number, StableId>()
      const snapshots = new Map<StableId, GeometrySnapshot>()
      const geometry: Record<StableId, ContractGeometrySnapshot> = {}
      const probes = this.#faceProbes(solid)
      const generated: StableId[] = []
      for (const p of probes) {
        const id: StableId = `${importId}:iges:face#${faceCounter++}`
        faceMap.set(p.hash, id)
        snapshots.set(id, p.snapshot)
        generated.push(id)
        geometry[id] = toContractGeometry(p.snapshot)
      }
      const handle = this.#mint({ shape: solid as number, faceMap, snapshots })
      bodies.push({
        handle,
        name: `${importId}:iges:body#${bodyCounter}`,
        elementMap: { featureId: importId, modified: {}, generated, deleted: [], geometry },
      })
      bodyCounter++
    }
    // When the minted bodies came from getSubShapes the root is dead weight and
    // the mints own their own handles; when the root ITSELF was minted it must
    // not be released (dispose()/disposeAll() own it from here on) -- the same
    // ownership split importStep makes.
    if (!usesRootDirectly) {
      try { k.release(root) } catch { /* already released */ }
    }

    const diagnostics: Diag[] = [{
      code: 'OK',
      severity: 'info',
      params: {
        igesContent: `solids=${content.solids} shells=${content.shells} faces=${content.faces} wires=${content.wires} edges=${content.edges}`,
      },
    }]
    diagnostics.push(...okDiag())
    return { bodies, diagnostics, content }
  }

  async exportStep(handles: BodyHandle[]): Promise<ArrayBuffer> {
    const k = this.#k()
    if (handles.length === 0) throw new Error('exportStep: no bodies given')
    const shapes = handles.map((h) => this.#rec(h).shape as ShapeHandle)
    const shape = shapes.length === 1 ? shapes[0] : k.makeCompound(shapes)
    const step = k.exportStep(shape)
    return new TextEncoder().encode(step).buffer
  }

  async serializeBody(h: BodyHandle): Promise<ArrayBuffer> {
    const bin = this.#k().toBREPBinary(this.#rec(h).shape as ShapeHandle)
    // Copy out of any wasm-heap view into a standalone buffer.
    return bin.slice().buffer
  }

  /**
   * restoreBody (GEO-2 BK-10a): rebuilds the shape from BREP and re-attaches
   * the body's face IDs via GEOMETRIC-SNAPSHOT REBIND, using `map.geometry`
   * (ICR-1's inline snapshot field, now emitted by makeBox/applyBoolean/
   * importStep above) — NOT the old centroid-sort-order <-> lexical-id-sort
   * pairing. That old pairing silently mis-binds whenever "sorted by
   * centroid" and "sorted by id string" disagree, which is common (see
   * restoreBody.test.ts's box fixture, where they are FULLY reversed and the
   * old algorithm mis-binds all 6 faces).
   *
   * Matching: for each id with an inline snapshot, find the restored face
   * whose OWN probe is the closest geometric match (same collapsed
   * surfaceType, centroid within 1% of the body's bbox diagonal, area within
   * [0.8, 1.25]x) — tight tolerances are appropriate here because this is a
   * serialize/deserialize ROUND TRIP of the same shape, not cross-feature
   * fuzzy resolution, so a true match should be near-exact. Ids with no
   * inline snapshot (pre-ICR-1 callers) — or whose snapshot matched nothing
   * within tolerance — degrade to the OLD centroid/lexical pairing against
   * whatever faces are left over, so restore never silently drops a face.
   */
  async restoreBody(bytes: ArrayBuffer, map: ElementMapDelta): Promise<BodyHandle> {
    const k = this.#k()
    const shape = k.fromBREPBinary(new Uint8Array(bytes))
    const probes = this.#faceProbes(shape)
    const geometry = map.geometry ?? {}
    // GEO-2-R1.4 (surfaced by the restore-body strict-skip regression test):
    // `map.generated` + flat(map.modified values) is only the CUT DELTA's
    // touched ids -- a face the op left entirely UNTOUCHED keeps its
    // original id but is neither a generated nor a modified id, so it fell
    // out of the rebind universe entirely and restoreBody silently dropped
    // it (not merely fell back to degraded pairing -- dropped outright).
    // Since applyBoolean now emits inline geometry for every surviving id
    // (including untouched survivors), widen the universe to every
    // geometry-keyed id EXCEPT the two categories that provably do NOT exist
    // as a face on the restored shape: deleted ids, and modified PARENT ids
    // that were replaced by DIFFERENT children (split/retrim-away) rather
    // than kept as their own single survivor (modified[id at exactly [id]).
    // Attempting to rebind those would risk a false-positive tolerance match
    // stealing another id's rightful face.
    const deletedSet = new Set(map.deleted)
    const modifiedParentGoneAway = new Set(
      Object.entries(map.modified)
        .filter(([parent, children]) => !children.includes(parent))
        .map(([parent]) => parent),
    )
    const ids = [...new Set<StableId>([
      ...map.generated,
      ...Object.values(map.modified).flat(),
      ...Object.keys(geometry).filter((id) => !deletedSet.has(id) && !modifiedParentGoneAway.has(id)),
    ])]

    const bbox = this.#bodyBBox(shape)
    const bboxDiag = Math.hypot(
      bbox.max[0] - bbox.min[0],
      bbox.max[1] - bbox.min[1],
      bbox.max[2] - bbox.min[2],
    ) || 1

    const faceMap = new Map<number, StableId>()
    const snapshots = new Map<StableId, GeometrySnapshot>()
    const remaining = new Set(probes)

    const idsWithSnap = ids.filter((id) => geometry[id] !== undefined).sort()
    for (const id of idsWithSnap) {
      const snap = geometry[id]
      let best: FaceProbe | undefined
      let bestDist = Infinity
      for (const p of remaining) {
        if (toSurfaceType(p.snapshot.type) !== snap.surfaceType) continue
        const d = distance3(p.snapshot.centroid, snap.centroid) / bboxDiag
        if (d > 0.01) continue
        const ratio = snap.area === 0 ? (p.snapshot.area === 0 ? 1 : Infinity) : p.snapshot.area / snap.area
        if (ratio < 0.8 || ratio > 1.25) continue
        if (d < bestDist) {
          bestDist = d
          best = p
        }
      }
      if (best) {
        faceMap.set(best.hash, id)
        snapshots.set(id, best.snapshot)
        remaining.delete(best)
      }
    }

    // Degraded fallback: any id that had no snapshot, or matched nothing
    // above, pairs against whatever faces are left over by centroid order —
    // same best-effort semantics as the pre-GEO-2 Stage-1 behavior.
    const matchedIds = new Set(faceMap.values())
    const unresolvedIds = ids.filter((id) => !matchedIds.has(id)).sort()
    const leftoverFaces = [...remaining].sort((a, b) => {
      for (let i = 0; i < 3; i++) {
        const d = a.snapshot.centroid[i] - b.snapshot.centroid[i]
        if (Math.abs(d) > 1e-6) return d < 0 ? -1 : 1
      }
      return 0
    })
    unresolvedIds.forEach((id, i) => {
      const p = leftoverFaces[i]
      if (p) {
        faceMap.set(p.hash, id)
        snapshots.set(id, p.snapshot)
      }
    })

    // UI-57-R1 blocker 2: a healed body's alias map is NOT dropped across a
    // serialize/restore round trip. It is reconstructed from the delta's own
    // lineage entries (#pairHealedFaces emits one `modified[loser] = [winner]`
    // per alias precisely so this is possible without a new contract field),
    // so a merged-away id still resolves after a restore.
    return this.#mint({ shape: shape as number, faceMap, snapshots, aliases: this.#aliasesFromDelta(map) })
  }

  /** Bounding-box diagonal of a body (GEO-2: feeds the tessellation-quality
   *  tier presets in ../index.ts, which need a size-relative deflection).
   *  NOT a GeomService method; facade-only extra like snapshotsFor. */
  bboxDiagonal(h: BodyHandle): number {
    const b = this.#bodyBBox(this.#rec(h).shape as ShapeHandle)
    return Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2])
  }

  // ---- companion map (GEO-1 ruling #3) --------------------------------
  /** Retrieve the geometry-snapshot companion map for a body. This is the
   *  DeltaSnapshots channel that travels ALONGSIDE ElementMapDelta — the
   *  naming system (DOC-1) consumes it for geometric fallback matching. NOT a
   *  GeomService method; intentionally outside the frozen contract. */
  snapshotsFor(h: BodyHandle): DeltaSnapshots {
    const rec = this.#rec(h)
    const out: DeltaSnapshots = {}
    for (const [id, snap] of rec.snapshots) out[id] = snap
    return out
  }
}
