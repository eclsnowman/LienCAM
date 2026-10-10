// WO UI-24 (Operator Q-17 verbatim: "I cannot save dimensions out from the workbench for you. can
// you devise a way to do this or add a small debug export link in the software now to show you
// issues?"). This module is the repro CHANNEL's data format: build a self-contained JSON
// snapshot of the live workbench scene, and parse/validate one back.
//
// SCOPE DECISION: this is NOT the DOC-3 project-save format (src/doc/persist/format.ts) -- that
// zip archive carries body-cache BREP bytes for fast reload and has no camera/display/plane
// fields at all (see its own DocumentSaveInput). A debug scene never needs cached geometry bytes:
// the exact same deterministic dag+parameters -> kernel recompute pipeline every undo/redo/param
// edit already drives is what rebuilds the bodies, so "everything needed to REBUILD what he is
// looking at" is the dag (which already carries sketches/features/parameters as plain DAG nodes,
// see params/table.ts's own header) plus the state DOC-3 deliberately never persists: camera pose,
// display mode, and plane visibility.
//
// FAIL-LOUD CONTRACT (WORKER-CHARTER item 2): every accept/skip/refuse path here is named.
// parseDebugSceneExport throws DebugSceneFormatError naming the exact field that failed
// validation -- a corrupted or newer-schema file is refused, never silently guessed at. Building
// the export enumerates every piece of state NOT captured (an in-progress sketch session, an open
// dialog) into `skipped[]` rather than dropping it silently.

import {
  FeatureDag,
  GENESIS_NODE_IDS,
  DAG_NODE_KINDS,
  REFERENCE_KINDS,
  isGenesisNodeId,
  isCanonicalGenesisShape,
  type DagNodeSnapshot,
  type FeatureRef,
  type RollbackMarker,
} from '../../doc'
import type { ShadingMode } from '../../types'
import type {
  DebugCameraState,
  OrthographicDebugCameraState,
  PerspectiveDebugCameraState,
  Vec3Like,
} from './sceneRuntime'
// WO UI-24-R3 (round-3 blocker): type-only import of the FROZEN geom-service.ts contract -- reading
// its exported types is not an edit to the file (dag.ts/many other consumers already do the same).
import type { Diag, DiagCode } from '../../geom/geom-service'
// WO UI-24-R1 (audit finding 1's own trial-restore requirement): the SAME idempotent seeder
// SolidsWorkbenchPage's REPLAY half calls after FeatureDag.restore (see SolidsWorkbenchPage.tsx's
// dagRef lazy-init) -- reused here so the trial restore below is a faithful predictor of what the
// real boot path will do, not a second, potentially-drifting reimplementation of it.
import { seedGenesisNodes } from './workbench/basePlanes'

export const DEBUG_SCENE_SCHEMA_VERSION = 1

export type DebugSceneCameraState = DebugCameraState

export interface DebugSceneExport {
  schemaVersion: number
  appVersion: string
  gitCommit: string
  gitBranch: string
  buildDate: string
  /** ISO-8601 export timestamp. */
  exportedAt: string
  /** Raw FeatureDag.serialize() output -- every sketch/feature/parameter/datum node, with
   *  suppression state, as that method already canonically serializes them. */
  dag: string
  /** dag.featureOrder() at export time -- the rollback-marker-relative timeline
   *  restoreRollbackState() needs (see dag.ts's RollbackMarker doc: call-order dependent,
   *  deliberately outside serialize()/restore()). */
  featureOrder: string[]
  rollbackMarker: RollbackMarker
  camera: DebugSceneCameraState
  displayMode: ShadingMode
  /** Genesis (Origin/XY/XZ/YZ) node ids currently hidden -- src/store/uiPrefs.ts's
   *  workbenchHiddenGenesisIds at export time. */
  hiddenGenesisIds: string[]
  /** Fail-loud manifest: every piece of live state this export could NOT capture, named. Empty
   *  is the normal case (see acceptance criterion 1); never silently omitted. */
  skipped: string[]
}

/** Thrown by parseDebugSceneExport, always naming the exact field that failed validation --
 *  the "refuses BY NAME" contract a caller (the boot-time loader) surfaces to the user verbatim. */
export class DebugSceneFormatError extends Error {
  readonly field: string
  constructor(field: string, message: string) {
    super(`debug scene file: ${message}`)
    this.name = 'DebugSceneFormatError'
    this.field = field
  }
}

const VALID_SHADING_MODES: readonly ShadingMode[] = ['shaded-edges', 'shaded-no-edges', 'unshaded', 'translucent']
const VALID_ROLLBACK_KINDS = ['end', 'start', 'after'] as const

/**
 * WO UI-24-R2 (root-cause ruling: "completeness must be DERIVED, not listed"). This closure is
 * built from TWO independent compile-time proofs, not a hand-maintained copy of either union:
 *
 *  1. `DAG_NODE_KINDS`/`REFERENCE_KINDS` (dag.ts/element-map.ts) ARE the source the DagNodeKind/
 *     ReferenceKind types are generated from (`typeof tuple[number]`) -- importing them here means
 *     this validator's kind/ref-kind allowlists can never drift from the type, because there is
 *     only one place either union is declared.
 *  2. `NODE_RECORD_FIELD_SET`/`REF_RECORD_FIELD_SET` below are typed as `Record<keyof T, true>` --
 *     if DagNodeSnapshot or FeatureRef ever gains or loses a field, the object literal fails to
 *     typecheck (TS's excess-property check catches an extra key; a missing required property
 *     check catches a dropped one). `npm run build` (the charter's typecheck gate; vitest strips
 *     types and cannot see this) fails at THAT line -- a future field lands as a compile error
 *     pointing at the exact validator that needs an entry, never as a silent gap the loader
 *     accepts-by-default. src/tests/model3d/debugSceneSchemaClosure.test.ts pins both proofs.
 */
const NODE_RECORD_FIELD_SET: Record<keyof DagNodeSnapshot, true> = {
  id: true,
  kind: true,
  consumes: true,
  refs: true,
  payload: true,
  degraded: true,
  diagnostics: true,
  lastGoodBoundTo: true,
  suppressed: true,
  hidden: true,
}
/** Exported so debugSceneSchemaClosure.test.ts can assert this allowlist against FeatureDag.serialize()'s
 *  REAL output shape, not just against the DagNodeSnapshot interface (see that test's own header). */
export const NODE_RECORD_FIELDS: readonly string[] = Object.keys(NODE_RECORD_FIELD_SET)

const REF_RECORD_FIELD_SET: Record<keyof FeatureRef, true> = { id: true, kind: true, role: true, elementType: true }
export const REF_RECORD_FIELDS: readonly string[] = Object.keys(REF_RECORD_FIELD_SET)

/**
 * WO UI-24-R3 (round-3 blocker: each DagNodeSnapshot.diagnostics element was checked only as a
 * non-null object -- no Diag field allowlist, no DiagCode/severity/params validation at all).
 *
 * FROZEN-BOUNDARY DISCLOSURE (report this verbatim): DAG_NODE_KINDS/REFERENCE_KINDS above are true
 * derivations -- dag.ts/element-map.ts declare `export const X = [...] as const; export type Y =
 * (typeof X)[number]`, so the TUPLE is the union's one source. geom-service.ts's `DiagCode` and
 * `Diag['severity']` are NOT declared that way -- they are hand-written string-literal unions
 * (`export type DiagCode = 'OK' | 'KERNEL_OP_FAILED' | ...`), and geom-service.ts is FROZEN for this
 * WO (its manifest: "MUST NOT TOUCH ... derive around it and disclose, or stop and report"). Turning
 * DiagCode into a tuple-derived type would require editing that file, so DIAG_CODES/DIAG_SEVERITIES
 * below are a MIRROR, not a derivation: a hand-maintained tuple enumerating DiagCode's / severity's
 * members today. What keeps a mirror from silently going stale (the whole reason derivation exists)
 * is the pair of `satisfies`/pin checks immediately below it: `as const satisfies readonly DiagCode[]`
 * fails `npm run build` if this tuple ever names something DiagCode does NOT have; the `_assert*`
 * pins fail the build if DiagCode/severity ever gains a member this tuple does NOT mirror. Divergence
 * in EITHER direction is a compile error pointing at this file, never a silent gap -- as close to the
 * DAG_NODE_KINDS pattern as the frozen boundary allows.
 */
const DIAG_CODES = [
  'OK',
  'KERNEL_OP_FAILED',
  'INVALID_RESULT',
  'FILLET_RADIUS_TOO_LARGE',
  'SHELL_FAILED',
  'CHAMFER_FAILED',
  'DRAFT_FAILED',
  'SEW_FAILED',
  'SWEEP_FAILED',
  'LOFT_FAILED',
  'HOLE_FAILED',
  'PATTERN_FAILED',
  'SELF_INTERSECTION',
  'OPEN_PROFILE',
  'REFERENCE_UNRESOLVED',
  'REFERENCE_FALLBACK',
  'DOMAIN_MISMATCH',
  'DEFEATURE_UNSUPPORTED',
  'CANCELLED',
] as const satisfies readonly DiagCode[]
/** Exported so debugSceneTypeGraphClosure.test.ts can register it against the real Diag shape. */
export const DIAG_CODES_LIST: readonly string[] = DIAG_CODES

const DIAG_SEVERITIES = ['info', 'warning', 'error'] as const satisfies readonly Diag['severity'][]
export const DIAG_SEVERITIES_LIST: readonly string[] = DIAG_SEVERITIES

// The OTHER direction `satisfies` cannot catch on its own (a strict SUBSET of DiagCode still
// satisfies `readonly DiagCode[]`): fails to typecheck the moment DiagCode/severity has a member
// this mirror does not, pointing straight at this file, not at a downstream silent gap.
type _DiagCodeNotMirrored = Exclude<DiagCode, (typeof DIAG_CODES)[number]>
type _AssertDiagCodesMirrorComplete = _DiagCodeNotMirrored extends never
  ? true
  : ['DiagCode has a member DIAG_CODES does not mirror -- update DIAG_CODES', _DiagCodeNotMirrored]
const _diagCodesMirrorComplete: _AssertDiagCodesMirrorComplete = true
void _diagCodesMirrorComplete

type _DiagSeverityNotMirrored = Exclude<Diag['severity'], (typeof DIAG_SEVERITIES)[number]>
type _AssertDiagSeveritiesMirrorComplete = _DiagSeverityNotMirrored extends never
  ? true
  : ["Diag['severity'] has a member DIAG_SEVERITIES does not mirror -- update DIAG_SEVERITIES", _DiagSeverityNotMirrored]
const _diagSeveritiesMirrorComplete: _AssertDiagSeveritiesMirrorComplete = true
void _diagSeveritiesMirrorComplete

const DIAG_FIELD_SET: Record<keyof Diag, true> = { code: true, severity: true, params: true }
/** Exported so debugSceneTypeGraphClosure.test.ts can register the Diag allowlist by name. */
export const DIAG_FIELDS: readonly string[] = Object.keys(DIAG_FIELD_SET)

/** charter item 3 ("NaN>tol is false in BOTH directions") applied to Diag.params: every value must
 *  be a finite number or a string -- never a nested object/array, which is exactly what the R2 audit's
 *  own corruption fixture smuggled in (`params:{x:{nested:'not string or number'}}`). */
function isFiniteStringOrNumber(v: unknown): v is string | number {
  return typeof v === 'string' || isFiniteNumber(v)
}

/**
 * WO UI-24-R3 (round-3 blocker fix): validates one serialized Diag element by name -- unknown field,
 * unknown code, unknown severity, or a non-finite/nested params value all refuse naming `path` (or
 * `path.<field>`), never merely confirming "is an object" the way the pre-R3 check did.
 */
function validateDiag(raw: unknown, path: string): void {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new DebugSceneFormatError(path, 'must be an object.')
  }
  const d = raw as Record<string, unknown>
  for (const key of Object.keys(d)) {
    if (!DIAG_FIELDS.includes(key)) {
      throw new DebugSceneFormatError(`${path}.${key}`, `unknown field (allowlist: ${DIAG_FIELDS.join(', ')}).`)
    }
  }
  if (typeof d.code !== 'string' || !(DIAG_CODES_LIST as readonly string[]).includes(d.code)) {
    throw new DebugSceneFormatError(`${path}.code`, `must be one of ${DIAG_CODES_LIST.join(', ')}.`)
  }
  if (typeof d.severity !== 'string' || !(DIAG_SEVERITIES_LIST as readonly string[]).includes(d.severity)) {
    throw new DebugSceneFormatError(`${path}.severity`, `must be one of ${DIAG_SEVERITIES_LIST.join(', ')}.`)
  }
  if (d.params !== undefined) {
    if (d.params === null || typeof d.params !== 'object' || Array.isArray(d.params)) {
      throw new DebugSceneFormatError(`${path}.params`, 'must be a plain object mapping keys to finite numbers or strings.')
    }
    for (const [k, v] of Object.entries(d.params as Record<string, unknown>)) {
      if (!isFiniteStringOrNumber(v)) {
        throw new DebugSceneFormatError(`${path}.params.${k}`, 'must be a finite number or a string (nested objects/arrays refused).')
      }
    }
  }
}

/**
 * WO UI-24-R3 (criterion 2, TYPE-GRAPH CLOSURE): field allowlists for every OTHER object-valued type
 * reachable from DebugSceneExport, exported so debugSceneTypeGraphClosure.test.ts's validator
 * registry is built from THESE (the same `Record<keyof T, true>` derivation NODE_RECORD_FIELDS/
 * REF_RECORD_FIELDS/DIAG_FIELDS already use), not a second hand-typed list the closure test could
 * drift from independently.
 */
const EXPORT_ROOT_FIELD_SET: Record<keyof DebugSceneExport, true> = {
  schemaVersion: true,
  appVersion: true,
  gitCommit: true,
  gitBranch: true,
  buildDate: true,
  exportedAt: true,
  dag: true,
  featureOrder: true,
  rollbackMarker: true,
  camera: true,
  displayMode: true,
  hiddenGenesisIds: true,
  skipped: true,
}
export const EXPORT_ROOT_FIELDS: readonly string[] = Object.keys(EXPORT_ROOT_FIELD_SET)

const PERSPECTIVE_CAMERA_FIELD_SET: Record<keyof PerspectiveDebugCameraState, true> = {
  position: true,
  target: true,
  up: true,
  fov: true,
  projection: true,
}
export const PERSPECTIVE_CAMERA_FIELDS: readonly string[] = Object.keys(PERSPECTIVE_CAMERA_FIELD_SET)

const ORTHOGRAPHIC_CAMERA_FIELD_SET: Record<keyof OrthographicDebugCameraState, true> = {
  position: true,
  target: true,
  up: true,
  projection: true,
  left: true,
  right: true,
  top: true,
  bottom: true,
  zoom: true,
  near: true,
  far: true,
}
export const ORTHOGRAPHIC_CAMERA_FIELDS: readonly string[] = Object.keys(ORTHOGRAPHIC_CAMERA_FIELD_SET)
export const CAMERA_FIELDS: readonly string[] = [
  ...new Set([...PERSPECTIVE_CAMERA_FIELDS, ...ORTHOGRAPHIC_CAMERA_FIELDS]),
]

const VEC3_FIELD_SET: Record<keyof Vec3Like, true> = { x: true, y: true, z: true }
export const VEC3_FIELDS: readonly string[] = Object.keys(VEC3_FIELD_SET)

/** RollbackMarker (dag.ts) is a discriminated union of object shapes, not a single interface, so
 *  `Record<keyof RollbackMarker, true>` is not expressible the way the other allowlists are --
 *  hand-listed here as the union of both variants' keys (`{kind:'end'|'start'}` | `{kind:'after',
 *  nodeId}`); parseDebugSceneExport's own rollbackMarker.kind/.nodeId checks above are the actual
 *  enforcement, this is just its allowlist mirrored for the closure test's registry. */
export const ROLLBACK_MARKER_FIELDS: readonly string[] = ['kind', 'nodeId']

/** Perspective remains fixed-fov for schema-v1 compatibility. Camera up is no
 * longer canonical: normal-to-plane views author it and the debug restore API
 * now reproduces that live value exactly. */
const CANONICAL_CAMERA_FOV = 45

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function isVec3Like(v: unknown): v is Vec3Like {
  if (v === null || typeof v !== 'object') return false
  const r = v as Record<string, unknown>
  return isFiniteNumber(r.x) && isFiniteNumber(r.y) && isFiniteNumber(r.z)
}

function vec3LengthSq(v: Vec3Like): number {
  return v.x * v.x + v.y * v.y + v.z * v.z
}

function assertExactFields(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new DebugSceneFormatError(`${path}.${key}`, 'is not valid for this camera projection.')
  }
}

/** charter item 3 ("NaN>tol is false in BOTH directions"), applied to an arbitrary payload tree
 *  rather than a single field: every numeric LEAF anywhere inside a node's opaque `payload` must be
 *  finite. Non-numeric leaves (strings/booleans/null) are not numbers and are not this check's job. */
function isFiniteDeep(v: unknown): boolean {
  if (typeof v === 'number') return Number.isFinite(v)
  if (Array.isArray(v)) return v.every(isFiniteDeep)
  if (v !== null && typeof v === 'object') return Object.values(v as Record<string, unknown>).every(isFiniteDeep)
  return true
}

/**
 * WO UI-24-R1 (audit finding 1): the caller's {nodes, order} shape check only proves the outer
 * envelope is well-formed -- it says nothing about whether each node inside is structurally sound,
 * whether every id is unique, whether every declared `consumes` edge resolves to another node in
 * THIS SAME file, or whether the opaque payload carries a NaN/Infinity a naive round-trip bug
 * produces. This is that missing layer: every failure throws a field-named DebugSceneFormatError
 * naming `dag.nodes[i].<field>` (or `dag.nodes`/`dag.order` for a cross-node check) -- never a
 * downstream FeatureDag.restore/topoOrder exception discovered only after the page has half-mounted
 * (the audit's own repro: a CYCLIC_FEATURE_DAG_RESTORE=ACCEPTED that only failed later, inside the
 * mounted page, at topoOrder()).
 *
 * Dangling consumes edges are refused here as corruption, unlike FeatureDag.topoOrder's own live-
 * document tolerance for a mid-session deleted node (dag.ts's removeNode: "dangling consumes edges
 * left pointing at the removed id are treated ... as already-satisfied"). That tolerance exists so
 * an in-app undo can resurrect a deleted node's downstream edge; it is not a property a REAL export
 * ever exhibits, because SolidsWorkbenchPage's own handleDelete removes downstream consumers
 * leaf-first, before their producer, on every delete path. This loader is a boot-time trust
 * boundary for untrusted files, not a live edit session, and is deliberately stricter.
 */
function validateDagNodeStructure(dagParsed: { nodes: unknown[]; order: unknown[] }): Set<string> {
  const ids = new Set<string>()
  const nodesWithConsumes: Array<{ id: string; consumes: string[] }> = []
  for (let i = 0; i < dagParsed.nodes.length; i++) {
    const raw = dagParsed.nodes[i]
    const path = `dag.nodes[${i}]`
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new DebugSceneFormatError(path, 'must be an object.')
    }
    const n = raw as Record<string, unknown>
    // WO UI-24-R2 (criterion 1: "an allowlist, never a blocklist"): a field this validator does not
    // know is refused BY NAME, not silently ignored -- a future serialized field lands here as a
    // named refusal rather than sailing through unchecked.
    for (const key of Object.keys(n)) {
      if (!NODE_RECORD_FIELDS.includes(key)) {
        throw new DebugSceneFormatError(`${path}.${key}`, `unknown field (allowlist: ${NODE_RECORD_FIELDS.join(', ')}).`)
      }
    }
    if (typeof n.id !== 'string' || n.id.length === 0) {
      throw new DebugSceneFormatError(`${path}.id`, 'must be a non-empty string.')
    }
    if (ids.has(n.id)) {
      throw new DebugSceneFormatError(`${path}.id`, `duplicate node id '${n.id}'.`)
    }
    if (typeof n.kind !== 'string' || !(DAG_NODE_KINDS as readonly string[]).includes(n.kind)) {
      throw new DebugSceneFormatError(`${path}.kind`, `must be one of ${DAG_NODE_KINDS.join(', ')}.`)
    }
    if (!Array.isArray(n.consumes) || !n.consumes.every((c) => typeof c === 'string')) {
      throw new DebugSceneFormatError(`${path}.consumes`, 'must be a string array.')
    }
    if (!Array.isArray(n.refs)) {
      throw new DebugSceneFormatError(`${path}.refs`, 'must be an array of {id, kind}.')
    }
    // WO UI-24-R2 (audit R1 finding 1): each ref's `kind` is now checked against the ReferenceKind
    // union members themselves (REFERENCE_KINDS), not merely "is a string" -- an unrecognized ref
    // kind used to cross the fail-closed boundary and be resolved via the single-face fallback
    // (src/doc/element-map.ts's resolve() default parameter) as if it had been declared that way.
    for (let j = 0; j < n.refs.length; j++) {
      const r = n.refs[j]
      const refPath = `${path}.refs[${j}]`
      if (r === null || typeof r !== 'object' || Array.isArray(r)) {
        throw new DebugSceneFormatError(refPath, 'must be a reference object.')
      }
      const ref = r as Record<string, unknown>
      for (const key of Object.keys(ref)) {
        if (!REF_RECORD_FIELDS.includes(key)) {
          throw new DebugSceneFormatError(`${refPath}.${key}`, `unknown field (allowlist: ${REF_RECORD_FIELDS.join(', ')}).`)
        }
      }
      if (typeof ref.id !== 'string' || ref.id.length === 0) {
        throw new DebugSceneFormatError(`${refPath}.id`, 'must be a non-empty string.')
      }
      if (typeof ref.kind !== 'string' || !(REFERENCE_KINDS as readonly string[]).includes(ref.kind)) {
        throw new DebugSceneFormatError(`${refPath}.kind`, `must be one of ${REFERENCE_KINDS.join(', ')}.`)
      }
      if (ref.role !== undefined && (typeof ref.role !== 'string' || ref.role.length === 0)) {
        throw new DebugSceneFormatError(`${refPath}.role`, 'must be a non-empty string when present.')
      }
      if (ref.elementType !== undefined && ref.elementType !== 'face' && ref.elementType !== 'edge' && ref.elementType !== 'vertex') {
        throw new DebugSceneFormatError(`${refPath}.elementType`, 'must be face, edge, or vertex when present.')
      }
      const expectedElementType =
        ref.kind === 'single-edge' ? 'edge' : ref.kind === 'single-vertex' ? 'vertex' : 'face'
      if (ref.elementType !== undefined && ref.elementType !== expectedElementType) {
        throw new DebugSceneFormatError(
          `${refPath}.elementType`,
          `must be ${expectedElementType} for reference kind ${String(ref.kind)}.`,
        )
      }
    }
    if (n.payload === null || typeof n.payload !== 'object' || Array.isArray(n.payload)) {
      throw new DebugSceneFormatError(`${path}.payload`, 'must be a plain object.')
    }
    if (!isFiniteDeep(n.payload)) {
      throw new DebugSceneFormatError(`${path}.payload`, 'contains a non-finite number.')
    }
    if (typeof n.degraded !== 'boolean') {
      throw new DebugSceneFormatError(`${path}.degraded`, 'must be a boolean.')
    }
    if (!Array.isArray(n.diagnostics)) {
      throw new DebugSceneFormatError(`${path}.diagnostics`, 'must be an array of Diag objects.')
    }
    // WO UI-24-R3 (round-3 blocker): each element gets the FULL Diag shape check -- code/severity
    // union membership, a field allowlist, and finite-string-or-number params -- not merely
    // "is a non-null object", which let both auditor corruption shapes (diagnostics:[{}] and the
    // banana-severity/nested-params/auditExtra shape) through ACCEPTED.
    for (let k = 0; k < n.diagnostics.length; k++) {
      validateDiag(n.diagnostics[k], `${path}.diagnostics[${k}]`)
    }
    if (
      n.lastGoodBoundTo === null ||
      typeof n.lastGoodBoundTo !== 'object' ||
      Array.isArray(n.lastGoodBoundTo) ||
      !Object.values(n.lastGoodBoundTo as Record<string, unknown>).every((v) => Array.isArray(v) && v.every((x) => typeof x === 'string'))
    ) {
      throw new DebugSceneFormatError(`${path}.lastGoodBoundTo`, 'must be a plain object mapping ids to string arrays.')
    }
    if (typeof n.suppressed !== 'boolean') {
      throw new DebugSceneFormatError(`${path}.suppressed`, 'must be a boolean.')
    }
    if (typeof n.hidden !== 'boolean') {
      throw new DebugSceneFormatError(`${path}.hidden`, 'must be a boolean.')
    }
    // WO UI-24-R2 (audit R1 finding 2): a reserved genesis id (Origin / a base datum plane) whose
    // serialized kind/payload discriminants are not the ONE canonical shape (src/doc/genesis.ts's
    // isCanonicalGenesisShape -- the SAME predicate FeatureDag.restore itself uses to decide what to
    // DROP) is refused BY NAME here, before FeatureDag.restore ever runs. Before this, a corrupt
    // reserved node was silently dropped by restore() and transparently re-seeded by seedGenesisNodes
    // a few lines below -- parseDebugSceneExport reported ACCEPTED even though the file's own Origin/
    // base-plane record did not describe the workbench's real genesis fixtures.
    if (isGenesisNodeId(n.id) && !isCanonicalGenesisShape(n.id, n.kind, n.payload as Record<string, unknown>)) {
      throw new DebugSceneFormatError(
        path,
        `reserved genesis id '${n.id}' does not have its canonical serialized shape (kind/payload discriminants) -- refused, not silently rebuilt.`,
      )
    }
    ids.add(n.id)
    nodesWithConsumes.push({ id: n.id, consumes: n.consumes as string[] })
  }

  for (const node of nodesWithConsumes) {
    for (const dep of node.consumes) {
      if (!ids.has(dep)) {
        throw new DebugSceneFormatError('dag.nodes', `node '${node.id}' consumes '${dep}', which does not resolve to any node in this file (dangling dependency).`)
      }
    }
  }

  if (
    dagParsed.order.length !== ids.size ||
    new Set(dagParsed.order).size !== dagParsed.order.length ||
    !dagParsed.order.every((id) => typeof id === 'string' && ids.has(id))
  ) {
    throw new DebugSceneFormatError('dag.order', 'must be a duplicate-free permutation of every dag.nodes id.')
  }

  return ids
}

/**
 * Validates an arbitrary parsed-JSON value against the DebugSceneExport shape, refusing BY NAME
 * (WORKER-CHARTER item 2) at the first field that fails. A newer schemaVersion than this build
 * knows is refused rather than guessed at (charter item 2 / this WO's acceptance criterion 2); an
 * older one has no migration path yet and is refused the same way -- both name 'schemaVersion'.
 * Every numeric field is checked with Number.isFinite (charter item 3: "NaN>tol is false in BOTH
 * directions" -- a JSON `null` where a finite number belongs, the exact shape a naive round-trip
 * bug produces, is caught here instead of sailing through downstream comparisons silently).
 */
export function parseDebugSceneExport(raw: unknown): DebugSceneExport {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new DebugSceneFormatError('root', 'must be a JSON object.')
  }
  const obj = raw as Record<string, unknown>

  if (!isFiniteNumber(obj.schemaVersion)) {
    throw new DebugSceneFormatError('schemaVersion', 'missing or non-numeric schemaVersion.')
  }
  if (obj.schemaVersion > DEBUG_SCENE_SCHEMA_VERSION) {
    throw new DebugSceneFormatError(
      'schemaVersion',
      `written by a newer app (schemaVersion ${obj.schemaVersion} > this build's ${DEBUG_SCENE_SCHEMA_VERSION}); refusing to guess at an unknown format.`,
    )
  }
  if (obj.schemaVersion < DEBUG_SCENE_SCHEMA_VERSION) {
    throw new DebugSceneFormatError(
      'schemaVersion',
      `written by an older schema (schemaVersion ${obj.schemaVersion} < this build's ${DEBUG_SCENE_SCHEMA_VERSION}); no migration exists yet.`,
    )
  }

  if (typeof obj.appVersion !== 'string' || obj.appVersion.length === 0) {
    throw new DebugSceneFormatError('appVersion', 'missing appVersion.')
  }
  if (typeof obj.gitCommit !== 'string') throw new DebugSceneFormatError('gitCommit', 'missing gitCommit.')
  if (typeof obj.gitBranch !== 'string') throw new DebugSceneFormatError('gitBranch', 'missing gitBranch.')
  if (typeof obj.buildDate !== 'string') throw new DebugSceneFormatError('buildDate', 'missing buildDate.')
  if (typeof obj.exportedAt !== 'string' || Number.isNaN(Date.parse(obj.exportedAt))) {
    throw new DebugSceneFormatError('exportedAt', 'exportedAt must be an ISO-8601 timestamp string.')
  }

  if (typeof obj.dag !== 'string' || obj.dag.length === 0) {
    throw new DebugSceneFormatError('dag', 'missing dag serialization.')
  }
  let dagParsed: unknown
  try {
    dagParsed = JSON.parse(obj.dag)
  } catch {
    throw new DebugSceneFormatError('dag', 'dag field is not valid JSON.')
  }
  if (
    dagParsed === null ||
    typeof dagParsed !== 'object' ||
    !Array.isArray((dagParsed as Record<string, unknown>).nodes) ||
    !Array.isArray((dagParsed as Record<string, unknown>).order)
  ) {
    throw new DebugSceneFormatError('dag', "dag field does not have FeatureDag.serialize()'s {nodes, order} shape.")
  }
  // WO UI-24-R1 (audit finding 1): node-level structure, unique ids, dep integrity and payload
  // sanity -- everything the outer {nodes, order} shape check above cannot see.
  const dagNodeIds = validateDagNodeStructure(dagParsed as { nodes: unknown[]; order: unknown[] })

  if (!Array.isArray(obj.featureOrder) || !obj.featureOrder.every((id) => typeof id === 'string')) {
    throw new DebugSceneFormatError('featureOrder', 'featureOrder must be a string array.')
  }
  if (
    obj.featureOrder.length !== dagNodeIds.size ||
    new Set(obj.featureOrder).size !== obj.featureOrder.length ||
    !(obj.featureOrder as string[]).every((id) => dagNodeIds.has(id))
  ) {
    throw new DebugSceneFormatError('featureOrder', 'must be a duplicate-free permutation of every dag.nodes id.')
  }

  const marker = obj.rollbackMarker
  if (marker === null || typeof marker !== 'object') {
    throw new DebugSceneFormatError('rollbackMarker', "must be {kind:'end'|'start'|'after', nodeId?}.")
  }
  const markerKind = (marker as Record<string, unknown>).kind
  if (typeof markerKind !== 'string' || !(VALID_ROLLBACK_KINDS as readonly string[]).includes(markerKind)) {
    throw new DebugSceneFormatError('rollbackMarker.kind', `must be one of ${VALID_ROLLBACK_KINDS.join(', ')}.`)
  }
  if (markerKind === 'after' && typeof (marker as Record<string, unknown>).nodeId !== 'string') {
    throw new DebugSceneFormatError('rollbackMarker.nodeId', "kind 'after' requires a string nodeId.")
  }
  if (markerKind === 'after' && !dagNodeIds.has((marker as Record<string, unknown>).nodeId as string)) {
    throw new DebugSceneFormatError(
      'rollbackMarker.nodeId',
      `'${(marker as Record<string, unknown>).nodeId}' does not resolve to any node in this file.`,
    )
  }

  const camera = obj.camera
  if (camera === null || typeof camera !== 'object') {
    throw new DebugSceneFormatError('camera', 'missing camera state.')
  }
  const cam = camera as Record<string, unknown>
  if (!isVec3Like(cam.position)) throw new DebugSceneFormatError('camera.position', 'must be a finite {x,y,z}.')
  if (!isVec3Like(cam.target)) throw new DebugSceneFormatError('camera.target', 'must be a finite {x,y,z}.')
  if (!isVec3Like(cam.up)) throw new DebugSceneFormatError('camera.up', 'must be a finite {x,y,z}.')
  const view = {
    x: cam.target.x - cam.position.x,
    y: cam.target.y - cam.position.y,
    z: cam.target.z - cam.position.z,
  }
  if (vec3LengthSq(view) <= 1e-18) throw new DebugSceneFormatError('camera.target', 'must differ from camera.position.')
  if (vec3LengthSq(cam.up) <= 1e-18) throw new DebugSceneFormatError('camera.up', 'must be non-zero.')
  const viewUpCross = {
    x: view.y * cam.up.z - view.z * cam.up.y,
    y: view.z * cam.up.x - view.x * cam.up.z,
    z: view.x * cam.up.y - view.y * cam.up.x,
  }
  if (vec3LengthSq(viewUpCross) <= 1e-18) {
    throw new DebugSceneFormatError('camera.up', 'must not be parallel to the camera view direction.')
  }

  if (cam.projection === 'perspective') {
    assertExactFields(cam, PERSPECTIVE_CAMERA_FIELDS, 'camera')
    if (!isFiniteNumber(cam.fov)) throw new DebugSceneFormatError('camera.fov', 'must be a finite number.')
    if (Math.abs(cam.fov - CANONICAL_CAMERA_FOV) > 1e-9) {
      throw new DebugSceneFormatError(
        'camera.fov',
        `must equal this workbench's canonical fov (${CANONICAL_CAMERA_FOV}) -- schema-v1 perspective cameras use the runtime's fixed fov.`,
      )
    }
  } else if (cam.projection === 'orthographic') {
    assertExactFields(cam, ORTHOGRAPHIC_CAMERA_FIELDS, 'camera')
    const { left, right, top, bottom, zoom, near, far } = cam
    if (!isFiniteNumber(left)) throw new DebugSceneFormatError('camera.left', 'must be a finite number.')
    if (!isFiniteNumber(right)) throw new DebugSceneFormatError('camera.right', 'must be a finite number.')
    if (!isFiniteNumber(top)) throw new DebugSceneFormatError('camera.top', 'must be a finite number.')
    if (!isFiniteNumber(bottom)) throw new DebugSceneFormatError('camera.bottom', 'must be a finite number.')
    if (!isFiniteNumber(zoom)) throw new DebugSceneFormatError('camera.zoom', 'must be a finite number.')
    if (!isFiniteNumber(near)) throw new DebugSceneFormatError('camera.near', 'must be a finite number.')
    if (!isFiniteNumber(far)) throw new DebugSceneFormatError('camera.far', 'must be a finite number.')
    if (left >= right) throw new DebugSceneFormatError('camera.right', 'must be greater than camera.left.')
    if (bottom >= top) throw new DebugSceneFormatError('camera.top', 'must be greater than camera.bottom.')
    if (zoom <= 0) throw new DebugSceneFormatError('camera.zoom', 'must be greater than zero.')
    if (near < 0) throw new DebugSceneFormatError('camera.near', 'must be greater than or equal to zero.')
    if (far <= near) throw new DebugSceneFormatError('camera.far', 'must be greater than camera.near.')
  } else {
    throw new DebugSceneFormatError(
      'camera.projection',
      "must be 'perspective' or 'orthographic'.",
    )
  }

  if (typeof obj.displayMode !== 'string' || !(VALID_SHADING_MODES as readonly string[]).includes(obj.displayMode)) {
    throw new DebugSceneFormatError('displayMode', `must be one of ${VALID_SHADING_MODES.join(', ')}.`)
  }

  if (!Array.isArray(obj.hiddenGenesisIds) || !obj.hiddenGenesisIds.every((id) => typeof id === 'string')) {
    throw new DebugSceneFormatError('hiddenGenesisIds', 'must be a string array.')
  }
  // WO UI-24-R1 (audit finding 1): a hidden id that is not one of the four canonical genesis ids is
  // not a validation error the replay path can silently ignore -- SolidsWorkbenchPage's own replay
  // loop (`for (const id of GENESIS_NODE_IDS)`) only ever iterates the canonical set, so a
  // non-genesis entry here would previously accept-then-drop it with no named refusal at all.
  if (!(obj.hiddenGenesisIds as string[]).every((id) => (GENESIS_NODE_IDS as readonly string[]).includes(id))) {
    throw new DebugSceneFormatError('hiddenGenesisIds', `every id must be one of the canonical genesis ids (${GENESIS_NODE_IDS.join(', ')}).`)
  }

  if (!Array.isArray(obj.skipped) || !obj.skipped.every((s) => typeof s === 'string')) {
    throw new DebugSceneFormatError('skipped', 'must be a string array.')
  }

  // WO UI-24-R1 (audit finding 1): "a dag FeatureDag.restore() itself rejects must surface as a
  // named refusal too, never an exception." Everything above proves the file's OWN declared shape
  // is sound; this trial runs the EXACT sequence SolidsWorkbenchPage's REPLAY half runs (restore ->
  // seedGenesisNodes -> restoreRollbackState) plus a topoOrder() call -- the same call the audit's
  // own repro showed throwing deep inside an already-mounted page -- so any restore-time failure
  // (a cycle among nodes that individually validated fine, or anything this hand-written validation
  // above did not anticipate) is caught HERE, before mounting anything, and reported by name.
  try {
    const trialDag = FeatureDag.restore(obj.dag)
    // WO UI-24-R2 (belt-and-braces): validateDagNodeStructure already refuses a non-canonical
    // reserved genesis node by name above, using the SAME isCanonicalGenesisShape predicate
    // FeatureDag.restore itself calls -- so restoredDroppedGenesisIds() should always be empty here.
    // Checked anyway, named, so the two can never silently diverge and this trial can never fall
    // back to FeatureDag.restore's own silent-drop-then-reseed behavior undetected.
    if (trialDag.restoredDroppedGenesisIds().length > 0) {
      throw new Error(`FeatureDag.restore dropped non-canonical reserved genesis id(s): ${trialDag.restoredDroppedGenesisIds().join(', ')}.`)
    }
    seedGenesisNodes(trialDag)
    trialDag.restoreRollbackState({ featureOrder: obj.featureOrder as string[], marker: marker as RollbackMarker })
    trialDag.topoOrder()
  } catch (err) {
    throw new DebugSceneFormatError('dag', `FeatureDag refused to restore this scene: ${err instanceof Error ? err.message : String(err)}`)
  }

  return {
    schemaVersion: obj.schemaVersion,
    appVersion: obj.appVersion,
    gitCommit: obj.gitCommit,
    gitBranch: obj.gitBranch,
    buildDate: obj.buildDate,
    exportedAt: obj.exportedAt,
    dag: obj.dag,
    featureOrder: obj.featureOrder as string[],
    rollbackMarker: marker as RollbackMarker,
    camera: cam as unknown as DebugSceneCameraState,
    displayMode: obj.displayMode as ShadingMode,
    hiddenGenesisIds: obj.hiddenGenesisIds as string[],
    skipped: obj.skipped as string[],
  }
}
