/**
 * LienCAM Geometry Service Contract — v0.4
 * (v0.1 + ICR-1 optional additions, approved by Operator ruling 2026-07-07:
 *  SurfaceType named export, GeometrySnapshot, ElementMapDelta.geometry?)
 * (v0.2 + ICR-2 optional additions, approved by Operator ruling 2026-07-08:
 *  TessBuffers topological-vertex fields — vertexPositions?,
 *  vertexAdjacencyOffsets?, vertexAdjacencyFaces?)
 * (v0.3 + planned Stage-5/Stage-8 appends, applied by the Architect at the
 *  Wave-4 cut 2026-07-08 per this file's own append plan (see the service
 *  comment that named them) and DECISIONS.md: ChamferRequest/ShellRequest/
 *  DraftRequest + applyChamfer/applyShell/applyDraft; PlanarFaceSet +
 *  makeSolidFromPlanarFaces; DiagCodes CHAMFER_FAILED/DRAFT_FAILED/SEW_FAILED.
 *  Pure additions — zero changes to any pre-existing signature.)
 * ====================================================================
 * THE most important interface in the 3D modeling project. See
 * docs/3d-modeling-plan.md §3.2 for the governing rules, restated here:
 *
 *  1. No kernel (OCCT/manifold) type ever crosses the worker boundary.
 *     Handles + plain serializable data only.
 *  2. Every mutating op returns an ElementMapDelta. No exceptions.
 *  3. Diagnostics are structured codes, never parsed strings.
 *  4. Tessellation buffers are transferables (zero-copy to Three.js).
 *  5. Deterministic: same document -> same stable IDs -> same maps.
 *
 * Stage 1 implements the marked subset; later stages append methods but
 * NEVER change existing signatures (add optional fields only).
 * Backing kernel: brepjs@^18.118.3 / occt-wasm@3.6.1 (verified 2026-07-07,
 * see STAGE0_FINDINGS.md). Interface is kernel-agnostic by design.
 */

// ---------- opaque handles ----------
export type BodyHandle = number & { readonly __body: unique symbol };
export type TessHandle = number & { readonly __tess: unique symbol };

// ---------- stable identity (see stable-id-spec.md) ----------
/** e.g. "F12:XTR:S3.e7:side" | "IMP1:step:face#42" | "F9:PAT:i3:F5:FIL:g0" */
export type StableId = string;

export type SubshapeType = 'face' | 'edge' | 'vertex';

/** Face surface classification — the classifyFace() union, exported as a named
 *  type shared by GEO and DOC (ICR-1, approved by Operator 2026-07-07). */
export type SurfaceType =
  | 'plane' | 'cylinder' | 'cone' | 'sphere' | 'torus' | 'bspline' | 'other';

/**
 * Tiny per-face geometry fingerprint captured at bind time — exactly what the
 * stable-ID resolver's split disambiguation (step 2) and geometric fallback
 * (step 3) need (docs/stable-id-spec.md). Added by ICR-1 (approved 2026-07-07)
 * so mutating ops can ship snapshots INLINE with each delta instead of via a
 * companion-map side channel.
 */
export interface GeometrySnapshot {
  surfaceType: SurfaceType;
  centroid: Vec3;
  area: number;
  /** planar faces */
  normal?: Vec3;
  /** cylinder/cone/torus faces */
  axis?: Vec3;
}

/**
 * Plain-data interrogation contract for associative construction geometry.
 * This deliberately describes values rather than kernel handles so the same
 * request/result can cross the worker boundary and survive document replay.
 * Offset planes do not need a kernel query; later point/line/curve/tangent
 * plane types consume these contracts when their worker implementation lands.
 */
export type SubshapeGeometryQuery =
  | { kind: 'vertex-point'; id: StableId }
  | { kind: 'linear-edge'; id: StableId }
  | { kind: 'curve-eval'; id: StableId; normalizedT: number }
  | { kind: 'surface-eval'; id: StableId; normalizedU: number; normalizedV: number };

export type SubshapeGeometryResult =
  | { kind: 'point'; point: Vec3 }
  | { kind: 'line'; point: Vec3; direction: Vec3 }
  | { kind: 'curve'; point: Vec3; tangent: Vec3; normalizedT: number; closed: boolean }
  | {
      kind: 'surface';
      surfaceType: SurfaceType;
      point: Vec3;
      normal: Vec3;
      normalizedU: number;
      normalizedV: number;
      axisPoint?: Vec3;
      axis?: Vec3;
      radius?: number;
    };

export interface ElementMapDelta {
  /** op that produced this delta, for audit/debug */
  featureId: string;
  /** input stableId -> surviving output stableId(s) (retrimmed/split faces) */
  modified: Record<StableId, StableId[]>;
  /** brand-new subshapes with their deterministic origin tags */
  generated: StableId[];
  /** inputs with no survivor in the output */
  deleted: StableId[];
  /**
   * OPTIONAL (ICR-1): face-geometry snapshots for ids named in this delta,
   * keyed by StableId. Backward-compatible addition per contract rule
   * "add optional fields only" — producers not yet emitting it (pre-GEO-2)
   * keep using the companion-map pattern.
   */
  geometry?: Record<StableId, GeometrySnapshot>;
}

// ---------- diagnostics ----------
export type DiagCode =
  | 'OK'
  | 'KERNEL_OP_FAILED'        // wasm-level failure, params attached
  | 'INVALID_RESULT'          // op ran, isValid() false
  | 'FILLET_RADIUS_TOO_LARGE'
  | 'SHELL_FAILED'
  | 'CHAMFER_FAILED'          // v0.4
  | 'DRAFT_FAILED'            // v0.4
  | 'SEW_FAILED'              // v0.4 (prismatic face-set could not sew solid)
  | 'SWEEP_FAILED'            // v0.5
  | 'LOFT_FAILED'             // v0.5
  | 'HOLE_FAILED'             // v0.5
  | 'PATTERN_FAILED'          // v0.5
  | 'SELF_INTERSECTION'
  | 'OPEN_PROFILE'            // extrude/revolve needs closed region
  | 'REFERENCE_UNRESOLVED'    // stableId had no survivor & no fallback match
  | 'REFERENCE_FALLBACK'      // resolved via geometric heuristic (warn)
  | 'DOMAIN_MISMATCH'         // mesh op on brep body or vice versa
  | 'DEFEATURE_UNSUPPORTED'   // known kernel limitation (see gotcha #2)
  | 'CANCELLED';

export interface Diag {
  code: DiagCode;
  severity: 'info' | 'warning' | 'error';
  /** structured params (radius, faceId, ...) — UI layer formats the message */
  params?: Record<string, string | number>;
}

export interface OpResult {
  ok: boolean;
  body?: BodyHandle;
  elementMap?: ElementMapDelta;
  /** Populated by makeExtrude so Up to next can persist the exact body/face it
   * selected rather than rediscovering a different candidate after reload. */
  resolvedExtrudeEnd?: ResolvedExtrudeEnd;
  diagnostics: Diag[];
}

// ---------- geometry-request payloads (plain data only) ----------
export interface Vec3 { x: number; y: number; z: number }
export interface PlaneDef { origin: Vec3; normal: Vec3; xDir: Vec3 }

/** One profile segment in sketch-plane coords, tagged with its source
 *  sketch-entity id (v0.5: extracted as a named type, structurally identical
 *  to the inline union it replaces — zero change to ProfileRegion's shape). */
export type ProfileSegment =
  | { kind: 'line'; a: [number, number]; b: [number, number]; srcId: string }
  | { kind: 'arc'; c: [number, number]; r: number; a0: number; a1: number; ccw: boolean; srcId: string };

/** Sketch profile handed from the sketch subsystem: closed regions in
 *  sketch-plane coords, each loop tagged with source sketch-entity ids
 *  (these become the origin tags of generated side faces). */
export interface ProfileRegion {
  sketchId: string;
  plane: PlaneDef;
  /** outer loop + holes; polyline/arc segments with source entity ids */
  loops: Array<ProfileSegment[]>;
}

/** v0.5 — an OPEN, connected planar chain (sweep path). Same segment
 *  vocabulary as ProfileRegion, on its own plane; segments must connect
 *  end-to-start within kernel tolerance and must NOT close. Non-planar
 *  paths are a later append (add-optional-only rule). */
export interface PathChain {
  sketchId: string;
  plane: PlaneDef;
  segments: ProfileSegment[];
}

/** Durable identity for geometry selected as an extrude terminator. Kernel
 * handles are intentionally absent: the workbench persists this record, then
 * resolves bodyFeatureId to a fresh handle on every regeneration. `lineage`
 * carries prior stable ids which may still resolve after an upstream edit. */
export interface ExtrudeTargetIdentity {
  modelItemId: string;
  bodyFeatureId: string;
  subshape?: {
    kind: 'face' | 'vertex';
    stableId: StableId;
    lineage?: StableId[];
  };
}

/** Durable identity for a standalone base or construction datum plane. The
 * feature id survives save/load and upstream regeneration; the current plane
 * definition is deliberately resolved again for each kernel generation. */
export interface ExtrudePlaneTargetIdentity {
  modelItemId: string;
  planeFeatureId: string;
  /** Makes body-only consumers see an explicit absence while preserving the
   * structural union and its existing bodyFeatureId assertions. */
  bodyFeatureId?: never;
}

export type ExtrudeEndTargetIdentity = ExtrudeTargetIdentity | ExtrudePlaneTargetIdentity;

/** Runtime half of an extrude target. The identity crosses save/load; the
 * opaque handle is reattached only for the current kernel generation. */
export interface ResolvedExtrudeTarget {
  identity: ExtrudeTargetIdentity;
  body: BodyHandle;
}

/** Runtime half of a standalone datum-plane target. */
export interface ResolvedExtrudePlaneTarget {
  identity: ExtrudePlaneTargetIdentity;
  plane: PlaneDef;
}

export type ResolvedExtrudeFaceTarget = ResolvedExtrudeTarget | ResolvedExtrudePlaneTarget;

export type ExtrudeEnd =
  | { kind: 'blind'; distance: number }
  | { kind: 'symmetric'; distance: number }
  | { kind: 'upToNext'; direction: 1 | -1; candidates: ResolvedExtrudeTarget[]; offset?: number }
  | { kind: 'toFace'; direction: 1 | -1; target: ResolvedExtrudeFaceTarget; offset?: number }
  | { kind: 'toPart'; direction: 1 | -1; target: ResolvedExtrudeTarget; offset?: number }
  | { kind: 'toVertex'; direction: 1 | -1; target: ResolvedExtrudeTarget; offset?: number }
  | { kind: 'throughAll'; direction: 1 | -1; targets: ResolvedExtrudeTarget[]; symmetric?: boolean };

export interface ResolvedExtrudeEnd {
  kind: ExtrudeEnd['kind'];
  /** Signed distances from the profile plane along its positive normal. */
  startDistance: number;
  endDistance: number;
  /** The exact stable target(s) used by the kernel decision. */
  targets: ExtrudeEndTargetIdentity[];
}

interface ExtrudeRequestBase {
  featureId: string;
  end: ExtrudeEnd;
  op: 'newBody' | 'add' | 'cut' | 'intersect';
  target?: BodyHandle;           // required unless newBody
  /** Present for persisted up-to/through-all requests; lets the worker refuse
   * a cross-Model-Item target even if a caller supplied a live foreign handle. */
  modelItemId?: string;
  draftAngleDeg?: number;
  thin?: { thickness: number };
}

export type ExtrudeRequest = ExtrudeRequestBase & (
  | {
      /** One or more selected regions, fused into one tool before the feature boolean. */
      profiles: [ProfileRegion, ...ProfileRegion[]];
      profile?: never;
    }
  | {
      /** @deprecated Source compatibility for out-of-lane callers; new code uses profiles. */
      profile: ProfileRegion;
      profiles?: never;
    }
);

export interface RevolveRequest {
  featureId: string;
  profile: ProfileRegion;
  axis: { origin: Vec3; dir: Vec3 };
  angleDeg: number;              // 360 = full
  op: 'newBody' | 'add' | 'cut' | 'intersect';
  target?: BodyHandle;
}

export interface BooleanRequest {
  featureId: string;
  op: 'fuse' | 'cut' | 'intersect';
  target: BodyHandle;
  tools: BodyHandle[];
}

export interface FilletRequest {
  featureId: string;
  body: BodyHandle;
  edges: StableId[];
  radius: number;                // constant; variable-radius added Stage 5
  propagateTangent: boolean;
}

/** v0.4 — equal-distance chamfer (distance-angle/two-distance variants later,
 *  optional fields only). */
export interface ChamferRequest {
  featureId: string;
  body: BodyHandle;
  edges: StableId[];
  distance: number;
  propagateTangent: boolean;
}

/** v0.4 — open-face shell; thickness > 0 hollows inward. */
export interface ShellRequest {
  featureId: string;
  body: BodyHandle;
  /** faces removed to open the shell (>=1) */
  removeFaces: StableId[];
  thickness: number;
}

/** v0.4 — neutral-plane draft. */
export interface DraftRequest {
  featureId: string;
  body: BodyHandle;
  faces: StableId[];
  neutralPlane: { origin: Vec3; normal: Vec3 };
  /** direction the mold pulls; faces tilt angleDeg away from it */
  pullDir: Vec3;
  angleDeg: number;
}

/**
 * v0.4 — planar face set handed from the mesh lane's prismatic converter
 * (MSH-3): each face is a closed outer polygon + holes on its own plane,
 * vertices in model coords (mm), polygons planar within `planarTolerance`.
 * The geom worker rebuilds faces, sews, and returns a solid with
 * import-rooted stable ids (CNVn:face#i grammar per stable-id-spec).
 */
export interface PlanarFaceSet {
  /** conversion id, roots the stable ids (like importId for STEP) */
  convertId: string;
  planarTolerance: number;
  faces: Array<{
    plane: PlaneDef;
    /** outer ring then holes; each ring a closed loop of xyz points */
    outer: Vec3[];
    holes: Vec3[][];
    /** mesh-side confidence 0..1 (planarity residual based) — carried into
     *  diagnostics, does not affect geometry */
    confidence: number;
  }>;
}

/** v0.5 — swept solid: closed profile driven along an open path (WP6.1).
 *  Orientation: 'frenet' rotates the profile with path curvature (pipes,
 *  handles); 'fixed' keeps the profile parallel to its own plane throughout.
 *  Guide curves are a later optional append — NOT accepted-and-ignored here
 *  (the propagateTangent lesson: never carry a field the implementation
 *  cannot honor). */
export interface SweepRequest {
  featureId: string;
  profile: ProfileRegion;
  path: PathChain;
  orientation: 'frenet' | 'fixed';
  op: 'newBody' | 'add' | 'cut' | 'intersect';
  target?: BodyHandle;
}

/** v0.5 — lofted solid through ordered sections (WP6.2). ruled=true gives
 *  straight-line transitions; false lets the kernel smooth. Guides are a
 *  later optional append (same rule as SweepRequest). */
export interface LoftRequest {
  featureId: string;
  /** >= 2 closed sections, in loft order */
  sections: ProfileRegion[];
  ruled: boolean;
  op: 'newBody' | 'add' | 'cut' | 'intersect';
  target?: BodyHandle;
}

/** v0.5 — machinist hole feature (WP6.3): placements on ONE face, drilled
 *  along the face normal (into the material). Dimensions in mm. Machining
 *  intent (thread spec, tap-drill) lives on the DOC-lane feature record,
 *  never in this geometry contract. */
export type HoleStyle =
  | { kind: 'simple'; diameter: number }
  | { kind: 'counterbore'; diameter: number; cbDiameter: number; cbDepth: number }
  | { kind: 'countersink'; diameter: number; csDiameter: number; csAngleDeg: number };

export interface HoleRequest {
  featureId: string;
  body: BodyHandle;
  /** the face the holes start on; points are model coords ON that face */
  face: StableId;
  points: Vec3[];
  style: HoleStyle;
  depth: { kind: 'blind'; distance: number } | { kind: 'throughAll' };
}

/** v0.5 — body-level pattern via kernel transform + fuse (WP5.3). The seed
 *  body and every instance fuse into ONE result body (separate-instance
 *  output is a later optional append). Feature-level patterns (regen replay)
 *  are DOC-lane and never cross this contract. Instance sub-shape ids derive
 *  as `<featureId>:PAT:i<n>:<childId>` per stable-id-spec. */
export type PatternSpec =
  | { kind: 'linear'; dir: Vec3; count: number; spacing: number }
  | { kind: 'circular'; axis: { origin: Vec3; dir: Vec3 }; count: number; stepDeg: number }
  | { kind: 'mirror'; plane: PlaneDef };

export interface PatternRequest {
  featureId: string;
  body: BodyHandle;
  spec: PatternSpec;
}

// ---------- v0.6 (GEO-6) direct edit / defeature ----------
// Face-level feature recognition + remove/heal (defeature) + rule-based batch
// select on imported/native bodies. The heal core is the GEO-6S-proven manual
// primitive stack (untrim / drop-loops -> sew -> solidify -> orientation-
// normalize -> isValid + signed volume delta) — NOT the kernel's broken
// defeature(). The four methods below are OPTIONAL until this WO merges; the
// Architect flips them to required at the merge (same flow as v0.4/v0.5).

/** The face-level feature classes GEO-6 recognizes (a superset of the GEO-6S
 *  removalClassVerdicts). `filletCurvedCorner`: since GEO-6X5, the bounded
 *  analytic blend-ribbon class (one torus G1-chained to two same-radius fillet
 *  cylinders, every shared boundary tangency-verified with finite data) is
 *  removable; everything outside it still refuses structured by name. */
export type FeatureClass =
  | 'throughHole' | 'blindHole' | 'counterboreStack'
  | 'pocket' | 'engravedText' | 'boss'
  | 'filletPlanar' | 'chamferPlanar'
  | 'filletCurvedCorner' | 'sliver';

/** A recognized feature with its stable-id face set + measured parameters. */
export interface FeatureVerdict {
  /** deterministic geometry-derived key — identical geometry -> identical key
   *  across runs; the accept-mask (DefeatureRequest.featureKeys) references it. */
  featureKey: string;
  featureClass: FeatureClass;
  /** true = removable in V1; false carries `refuseReason` (never crashes). */
  removable: boolean;
  refuseReason?: string;
  /** signed material effect of removal: 'add' fills a void (hole/pocket/fillet),
   *  'remove' deletes a protrusion (boss). Sign of the volume delta. */
  effect: 'add' | 'remove';
  /** the feature's OWN faces (dropped on removal). */
  faceIds: StableId[];
  /** preserved neighbour faces — the lineage source for CAM rebinding. */
  neighbourIds: StableId[];
  /** measured params for rule queries + UI (axis, diameter, depth, radius…). */
  params: Record<string, number | string>;
}

/** Rule-based batch selection criteria (the SW-2024 / SpaceClaim Power-Select
 *  bar). All predicates AND together; omitted predicates don't filter. Designed
 *  so the machinability criteria BK-46 will need (fillet r < corner radius,
 *  hole d < min drill) are expressible without a schema change. */
export interface FeatureQuery {
  classes?: FeatureClass[];
  /** all holes with diameter <= this (mm). */
  maxDiameter?: number;
  /** all fillets/chamfers with radius <= this (mm). */
  maxRadius?: number;
  /** all faces/features with area <= this (mm^2) — the sliver/small-face bar. */
  maxFaceArea?: number;
  removableOnly?: boolean;
}

export interface DefeatureRequest {
  /** the ONE history feature this batch becomes (BK-45). */
  featureId: string;
  body: BodyHandle;
  /** accept mask: feature keys (from a prior recognizeFeatures) to remove. */
  featureKeys?: string[];
  /** OR a rule query, applied when featureKeys is absent. */
  query?: FeatureQuery;
}

/** Per-feature outcome inside a batch — partial success names each failure. */
export interface DefeatureItemResult {
  featureKey: string;
  featureClass: FeatureClass;
  healed: boolean;
  /** why it did NOT heal (refusal reason or heal failure) — loud, never silent. */
  reason?: string;
  /** signed per-feature volume delta (healed - before) when healed. */
  volumeDelta?: number;
  effect: 'add' | 'remove';
}

export interface DefeatureReport {
  requested: number;
  healed: number;
  /** removable features that were attempted but failed to reach a solid. */
  failed: number;
  /** features refused at classification (e.g. curved-corner fillet). */
  refused: number;
  /** signed total volume delta (healed body - original). */
  totalVolumeDelta: number;
  items: DefeatureItemResult[];
  /** requested featureKeys that no longer resolve to a feature on the body —
   *  named LOUD (an upstream edit removed/moved them), never silently matched. */
  notFound?: string[];
}

export interface DefeatureResult extends OpResult {
  report?: DefeatureReport;
}

/** v0.6 — move/offset ONE planar face along its normal (or a resize of a hole
 *  diameter / pocket depth). Same heal + validity discipline as defeatureBatch. */
export interface FaceEditRequest {
  featureId: string;
  body: BodyHandle;
  /** the feature to resize (a featureKey from recognizeFeatures). */
  featureKey: string;
  /** the edit: signed offset of the feature (hole diameter delta, pocket depth
   *  delta, or planar-face offset), in mm. */
  delta: number;
  kind: 'holeDiameter' | 'pocketDepth' | 'faceOffset';
}

// ---------- tessellation (transferable-friendly) ----------
export interface TessQuality { deflection: number; angularDeflection?: number }

/** Display classification for one wireframe edge group. Tangent-edge
 * classification is deliberately separate and not represented here. */
export type EdgeClass = 'regular' | 'seam'

export interface TessBuffers {
  position: Float32Array;        // transferable
  normal: Float32Array;          // transferable
  index: Uint32Array;            // transferable
  /** parallel to triangles: triangle i belongs to face faceIndex[i] */
  triFace: Uint32Array;          // transferable
  /** faceIndex -> StableId (small, structured-clone ok) */
  faceIds: StableId[];
  /** edge polylines flattened + offsets, edgeIds parallel to offsets */
  edgePositions: Float32Array;   // transferable
  edgeOffsets: Uint32Array;
  edgeIds: StableId[];
  /** Aligned prefix of edgeIds. Missing entries retain legacy draw-all behavior. */
  edgeClasses?: EdgeClass[];
  /**
   * OPTIONAL (ICR-2, approved 2026-07-08): TOPOLOGICAL vertices, so the render
   * bridge can mint spec-conformant vertex StableIds directly instead of the
   * BridgeVertexRef workaround (UI-1 ruling). Emitted by GEO workers from the
   * first post-v0.3 GEO cut; absent until then.
   * vertexPositions: xyz triplets per topological vertex (transferable).
   */
  vertexPositions?: Float32Array;
  /**
   * CSR adjacency: vertex i's adjacent faces are
   * vertexAdjacencyFaces[vertexAdjacencyOffsets[i] .. vertexAdjacencyOffsets[i+1]-1].
   * MUST have length (vertexCount + 1) — the trailing sentinel is REQUIRED
   * (BK-18 lesson: GEO-1's edgeOffsets omitted its sentinel and every consumer
   * needed a defensive workaround; do not repeat that here).
   */
  vertexAdjacencyOffsets?: Uint32Array;
  /** values index into faceIds (join to StableIds there). */
  vertexAdjacencyFaces?: Uint32Array;
}

export interface MeasureResult {
  kind: 'distance' | 'radius' | 'angle' | 'volume' | 'area' | 'length';
  value: number;                 // model units (mm)
  aux?: Record<string, number>;
}

export interface ImportedBody {
  handle: BodyHandle;
  name?: string;
  color?: [number, number, number];
  /** import-rooted stable ids assigned to every face/edge (IMPn:step:face#i) */
  elementMap: ElementMapDelta;
}

/**
 * WO-1824: what an IGES file actually turned out to hold, counted on the shape
 * the kernel returned. IGES is not a solid format - most files from the older
 * CAD and legacy-parts sites carry trimmed surfaces or bare wireframe, and a
 * good many carry a real MSBO solid. The importer does not refuse any of them
 * (LIENCAM.md rule 11); it reports this census so the part is LABELLED for what
 * it is instead of being silently presented as a solid.
 */
export interface IgesContent {
  solids: number;
  shells: number;
  faces: number;
  wires: number;
  edges: number;
}

export interface KernelInfo {
  backend: 'occt-wasm' | 'taucad-ocjs' | 'brepkit';
  occtVersion: string;
  capabilities: { defeature: boolean; xcaf: boolean; hlr: boolean };
}

// ---------- THE SERVICE ----------
export interface GeomService {
  // lifecycle -------------------------------------------------- [Stage 1]
  init(onProgress?: (pct: number, phase: string) => void): Promise<KernelInfo>;
  dispose(handle: BodyHandle): Promise<void>;
  disposeAll(): Promise<void>;

  // creation --------------------------------------------------- [Stage 1: box only, for tests]
  makeBox(featureId: string, size: Vec3): Promise<OpResult>;
  // ------------------------------------------------------------ [Stage 4]
  makeExtrude(req: ExtrudeRequest): Promise<OpResult>;
  makeRevolve(req: RevolveRequest): Promise<OpResult>;
  applyBoolean(req: BooleanRequest): Promise<OpResult>;
  // ------------------------------------------------------------ [Stage 5]
  applyFillet(req: FilletRequest): Promise<OpResult>;
  // v0.4 chamfer/shell/draft flipped OPTIONAL->REQUIRED at the GEO-4 merge
  // (2026-07-08, per this file's own append plan). makeSolidFromPlanarFaces
  // below stays OPTIONAL until MSH-3 merges — the Architect flips it then.
  applyChamfer(req: ChamferRequest): Promise<OpResult>;    // v0.4
  applyShell(req: ShellRequest): Promise<OpResult>;        // v0.4
  applyDraft(req: DraftRequest): Promise<OpResult>;        // v0.4
  // ------------------------------------------------------------ [Stage 8]
  /** v0.4 — prismatic mesh->brep bridge; flipped required at the MSH-3 merge (2026-07-08) */
  makeSolidFromPlanarFaces(req: PlanarFaceSet): Promise<OpResult>;
  // ------------------------------------------------------------ [Stage 5/6]
  // v0.5 sweep/loft/hole/pattern flipped OPTIONAL->REQUIRED at the GEO-5
  // merge (2026-07-08, same flow as v0.4).
  makeSweep(req: SweepRequest): Promise<OpResult>;           // v0.5
  makeLoft(req: LoftRequest): Promise<OpResult>;             // v0.5
  makeHole(req: HoleRequest): Promise<OpResult>;             // v0.5
  applyBodyPattern(req: PatternRequest): Promise<OpResult>;  // v0.5
  // ------------------------------------------------------------ [Stage 7: direct edit / defeature]
  // v0.6 (GEO-6) — OPTIONAL until the WO merges; the Architect flips each to
  // required at the merge (v0.4/v0.5 precedent). Recognition + rule-based batch
  // remove/heal on imported & native bodies.
  /** Recognize every face-level feature on a body (structured verdicts). */
  recognizeFeatures(h: BodyHandle): Promise<FeatureVerdict[]>;               // v0.6 (required at GEO-6 merge)
  /** Rule-based batch selection (a filtered recognizeFeatures). */
  queryFeatures(h: BodyHandle, query: FeatureQuery): Promise<FeatureVerdict[]>; // v0.6 (required at GEO-6 merge)
  /** Remove an accepted feature set and heal watertight as ONE history feature;
   *  partial success heals the healable and names every failure (BK-45). */
  defeatureBatch(req: DefeatureRequest): Promise<DefeatureResult>;          // v0.6 (required at GEO-6 merge)
  /** Resize a hole diameter / pocket depth, or offset a planar face, with the
   *  same heal + validity discipline. */
  editFeature(req: FaceEditRequest): Promise<OpResult>;                     // v0.6 (required at GEO-6 merge)

  // interrogation ---------------------------------------------- [Stage 1]
  tessellate(h: BodyHandle, q: TessQuality): Promise<TessBuffers>;
  resolve(h: BodyHandle, ids: StableId[]): Promise<Array<{
    id: StableId;
    status: 'exact' | 'fallback' | 'lost';
    /** current kernel-local index, valid only until next mutation of h */
    localIndex?: number;
    type?: SubshapeType;
  }>>;
  measure(h: BodyHandle, kind: MeasureResult['kind'], ids?: StableId[]): Promise<MeasureResult>;
  classifyFace(h: BodyHandle, id: StableId): Promise<SurfaceType>;

  // I/O ---------------------------------------------------------- [Stage 1]
  importStep(bytes: ArrayBuffer, importId: string): Promise<{ bodies: ImportedBody[]; diagnostics: Diag[] }>;
  /** WO-1824: IGES read on the same kernel. Mints a body per solid; when the
   *  file holds no solid at all, the shape it DOES hold is minted as one body
   *  rather than refused, and `content` says what that is. */
  importIges(bytes: ArrayBuffer, importId: string): Promise<{ bodies: ImportedBody[]; diagnostics: Diag[]; content: IgesContent }>;
  exportStep(handles: BodyHandle[]): Promise<ArrayBuffer>;
  /** kernel-native cache for fast document open (bodies/*.brep in the zip) */
  serializeBody(h: BodyHandle): Promise<ArrayBuffer>;
  restoreBody(bytes: ArrayBuffer, map: ElementMapDelta): Promise<BodyHandle>;
}
