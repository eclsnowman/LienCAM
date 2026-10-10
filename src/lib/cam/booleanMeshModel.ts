// MSH-4-BOOLEAN-EDIT: pure helpers for the one-shot "Boolean an imported mesh
// against a Model body" surface. This module is deliberately pure (types + math
// only, no store, no DOM, no kernel handle) so every honesty claim it makes is
// unit-pinnable.
//
// HONESTY MODEL (Operator ruling Q-72: A). There is NO user tolerance control. A
// Model body is only ever available in the CAM domain as its ALREADY-tessellated
// display mesh (the CAM-BINDING identity boundary - see modelBodyDerive.ts - CAM
// holds no live kernel handle, so it cannot re-tessellate a B-rep at a chosen
// tolerance). Therefore:
//   - If EVERY face of the Model body is planar, its display tessellation is
//     EXACT (flat faces triangulate with zero chord error), so the boolean
//     result is exact too - only the geometry TYPE changed (B-rep -> mesh).
//   - If ANY face is curved, that face was approximated by triangles at the
//     model's display fidelity, so the result is genuinely approximate.
// The classifier below decides which, rigorously, from the persisted per-face
// display data. When per-face identity is unavailable we CANNOT prove planarity,
// so we conservatively report "approximate" (never overclaim exactness).

import * as THREE from 'three'
import { isModelOriginGeometry } from './modelOrigin'
import type { MeshBooleanOperation, MeshBuffers } from '../../mesh/types'
import type { BooleanMeshProvenance, ImportedGeometry, ModelBodyDisplay } from '../../types'

// ── shared eligibility predicates (one source, every nav path + the dialog) ───

/** An imported mesh (STL) row eligible as the mesh operand: a real mesh, not a
 *  Model body, and not a nest's integrated seed copy. A boolean RESULT (format
 *  'stl' + booleanProvenance) is eligible too, so results can be chained. */
export function isMeshBooleanSourceRow(g: ImportedGeometry): boolean {
  return g.type === 'mesh' && g.format === 'stl' && !isModelOriginGeometry(g) && !g.ownerNestId
}

/** A Model body eligible as the second operand: model-origin with a drawable
 *  display tessellation. */
export function isModelBooleanBodyRow(g: ImportedGeometry): boolean {
  return isModelOriginGeometry(g) && !!g.modelBody?.display && g.modelBody.display.positions.length > 0
}

/** True IFF the project has at least one Model body usable as a boolean operand
 *  (gates the "Boolean with model body..." affordances - no point offering it
 *  with nothing to cut against). */
export function hasModelBooleanBody(geometry: readonly ImportedGeometry[]): boolean {
  return geometry.some(isModelBooleanBodyRow)
}

/** True IFF this row is a boolean RESULT (drives the "Edit boolean" affordances
 *  + routing Edit to re-open the picker). */
export function isBooleanResultRow(g: ImportedGeometry): boolean {
  return !!g.booleanProvenance
}

// BooleanMeshProvenance lives in src/types (the central types home) to avoid a
// types <-> this-module import cycle; re-exported here so callers that already
// import the boolean helpers get the type from one place.
export type { BooleanMeshProvenance }

/** Outcome of the store's booleanMeshVsModelBody action (fail-loud, ADR-0003). */
export type BooleanMeshOutcome =
  | { ok: true; newId: string; approximate: boolean }
  | { ok: false; error: string }

/**
 * Characterized chord tolerance (mm) of the Model kernel's DISPLAY tessellation.
 * NOT a user control (Operator ruling Q-72: A dropped the tolerance field) - CAM
 * holds no live kernel handle, so a Model body always arrives pre-tessellated at
 * the kernel's display fidelity. This constant only feeds the internal
 * brep-operand provenance tag (so a curved model operand is honestly recorded as
 * "was a tessellated brep") and is never shown to the user. ~0.01mm matches the
 * "sub-0.01mm typical" figure modelBodyDerive.ts's Stage-4 precision note cites.
 */
export const MODEL_DISPLAY_CHORD_TOLERANCE_MM = 0.01

/**
 * Fail-loud operand-size ceiling (browser-headroom). A boolean of operands past
 * this many triangles risks a very long / memory-heavy run; the action refuses
 * BY NAME (suggesting decimation) rather than let it hang. Deliberately generous
 * - real scan meshes are typically well under this - and a NAMED ceiling, not a
 * silent cap, mirroring meshWiring.ts's measured HOLLOW/REPAIR guards in spirit.
 */
export const MAX_BOOLEAN_OPERAND_TRIANGLES = 1_500_000

/** TRUE when either operand's triangle count exceeds the fail-loud ceiling. */
export function exceedsOperandTriangleLimit(meshTriangles: number, modelTriangles: number): boolean {
  return meshTriangles > MAX_BOOLEAN_OPERAND_TRIANGLES || modelTriangles > MAX_BOOLEAN_OPERAND_TRIANGLES
}

/**
 * Map a raw boolean-kernel failure to a readable, NAMED refusal (ADR-0003) -
 * never surface a bare "Not manifold" at the UI boundary. Always preserves the
 * original kernel text for diagnosis.
 */
export function describeBooleanFailure(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  if (/brep-vs-brep/i.test(raw)) {
    return `Boolean refused: both operands are exact B-rep bodies - combine them in the Model workspace's own Boolean tool instead. (${raw})`
  }
  if (/manifold/i.test(raw)) {
    return (
      'Boolean failed: one of the shapes is not a closed, watertight solid, so the boolean ' +
      `cannot run reliably. Repair or close the mesh first (Mesh tools), then try again. (kernel: ${raw})`
    )
  }
  return `Boolean failed: ${raw}`
}

// ── operation vocabulary (single source, so every surface agrees) ────────────

/** Title-case label for the picker + PP fact ("Subtract" / "Union" / "Intersect"). */
export function booleanOpLabel(op: MeshBooleanOperation): string {
  switch (op) {
    case 'difference': return 'Subtract'
    case 'union': return 'Union'
    case 'intersect': return 'Intersect'
  }
}

/** Lower-case word used inside the result row NAME ("scan_v3 (subtract)"). */
export function booleanOpWord(op: MeshBooleanOperation): string {
  switch (op) {
    case 'difference': return 'subtract'
    case 'union': return 'union'
    case 'intersect': return 'intersect'
  }
}

/** Plain-English connector for the viewport hover readout ("<mesh> minus <body>"). */
export function booleanOpConnector(op: MeshBooleanOperation): string {
  switch (op) {
    case 'difference': return 'minus'
    case 'union': return 'plus'
    case 'intersect': return 'intersect'
  }
}

/** Default result row name, D4: "<meshName> (<op>)". */
export function booleanResultName(meshName: string, op: MeshBooleanOperation): string {
  return `${meshName} (${booleanOpWord(op)})`
}

// ── planar-vs-curved classifier (the honesty engine) ─────────────────────────

/** Two coplanar-face triangles' unit normals differ by less than acos(this)
 *  ~= 0.26 deg. A genuinely planar B-rep face tessellates into triangles with
 *  mathematically IDENTICAL normals (float noise only), so this tight bound
 *  passes every real planar face while rejecting even a lightly-curved one -
 *  we would rather call a marginal face "approximate" than overclaim exact. */
const COPLANAR_DOT_MIN = 0.99999

export interface ModelBodyFidelity {
  /** true only when EVERY face is provably planar (result is exact). */
  exact: boolean
  /** number of curved faces detected (0 when exact). */
  curvedFaceCount: number
  /** number of planar faces detected. */
  planarFaceCount: number
  /** why the verdict was reached (for the report / a PP tooltip, never a silent guess). */
  reason: string
}

function triangleNormal(
  positions: ArrayLike<number>,
  i0: number, i1: number, i2: number,
): THREE.Vector3 | null {
  const ax = positions[i0 * 3], ay = positions[i0 * 3 + 1], az = positions[i0 * 3 + 2]
  const bx = positions[i1 * 3], by = positions[i1 * 3 + 1], bz = positions[i1 * 3 + 2]
  const cx = positions[i2 * 3], cy = positions[i2 * 3 + 1], cz = positions[i2 * 3 + 2]
  const ux = bx - ax, uy = by - ay, uz = bz - az
  const vx = cx - ax, vy = cy - ay, vz = cz - az
  const nx = uy * vz - uz * vy
  const ny = uz * vx - ux * vz
  const nz = ux * vy - uy * vx
  const len = Math.hypot(nx, ny, nz)
  if (!(len > 1e-9)) return null // degenerate (zero-area) triangle - no normal
  return new THREE.Vector3(nx / len, ny / len, nz / len)
}

/**
 * Decide whether a Model body's persisted display tessellation is an EXACT
 * representation of the body (all faces planar) or an APPROXIMATION (>=1 curved
 * face). Rigorous when per-face identity (faceIds/triFace) is present;
 * conservatively "approximate" when it is not (we never overclaim exactness).
 */
export function classifyModelBodyFidelity(display: ModelBodyDisplay): ModelBodyFidelity {
  const { positions, indices, faceIds, triFace } = display
  if (!faceIds || !triFace || faceIds.length === 0 || triFace.length === 0) {
    return {
      exact: false,
      curvedFaceCount: 0,
      planarFaceCount: 0,
      reason:
        'per-face identity is unavailable on this body (it has not been re-synced since ' +
        'the per-face data shipped), so planarity cannot be proven - treated as approximate',
    }
  }
  const triCount = Math.floor(indices.length / 3)
  // Per-face reference normal; a face flips to "curved" the first time one of
  // its triangles deviates from the reference beyond COPLANAR_DOT_MIN.
  const refNormal = new Map<number, THREE.Vector3>()
  const curved = new Set<number>()
  const seenFace = new Set<number>()
  for (let t = 0; t < triCount; t++) {
    const face = triFace[t]
    seenFace.add(face)
    if (curved.has(face)) continue
    const n = triangleNormal(positions, indices[t * 3], indices[t * 3 + 1], indices[t * 3 + 2])
    if (n === null) continue // degenerate triangle - cannot judge, skip
    const ref = refNormal.get(face)
    if (ref === undefined) {
      refNormal.set(face, n)
    } else if (ref.dot(n) < COPLANAR_DOT_MIN) {
      curved.add(face)
    }
  }
  const curvedFaceCount = curved.size
  const planarFaceCount = seenFace.size - curvedFaceCount
  const exact = curvedFaceCount === 0 && seenFace.size > 0
  return {
    exact,
    curvedFaceCount,
    planarFaceCount,
    reason: exact
      ? `all ${planarFaceCount} face(s) are planar - display tessellation is exact`
      : `${curvedFaceCount} curved face(s) present - display tessellation approximates them`,
  }
}

// ── consistent copy across all feedback surfaces (contextual-feedback law) ────

/** Short PP fidelity word. */
export function fidelityWord(approximate: boolean): string {
  return approximate ? 'Approximate' : 'Exact'
}

/** PP fact-block one-liner explaining WHY (planar-exact vs curved-approximate,
 *  MSH-4-MESHLAB-PROOF finding 2 - never imply every result is lossy). */
export function fidelityExplanation(approximate: boolean): string {
  return approximate
    ? 'curved surfaces use the model body’s fine display mesh'
    : 'only the geometry type changed (flat faces are exact)'
}

/** Viewport hover readout: "<mesh> minus <body>, approximate (curved surfaces...)". */
export function booleanHoverLabel(prov: BooleanMeshProvenance, approximate: boolean): string {
  return (
    `${prov.sourceMeshName} ${booleanOpConnector(prov.op)} ${prov.modelBodyName}, ` +
    `${approximate ? 'approximate' : 'exact'} (${fidelityExplanation(approximate)})`
  )
}

/** Console success line (plain words). */
export function booleanConsoleMessage(resultName: string, approximate: boolean): string {
  return (
    `Boolean result "${resultName}" created - ${approximate ? 'approximate' : 'exact'} ` +
    `(${fidelityExplanation(approximate)})`
  )
}

// ── world-bake (viewport parity) ─────────────────────────────────────────────

export interface Pose {
  position: { x: number; y: number; z: number }
  /** Euler rotation in DEGREES, applied in THREE's default 'XYZ' order - the
   *  same convention CNCViewport uses to place a part group, so a baked operand
   *  lands exactly where the user sees the part. */
  rotation: { x: number; y: number; z: number }
}

const DEG2RAD = Math.PI / 180

/** Build the world matrix for a pose, matching CNCViewport's group placement
 *  (position + Euler-XYZ-degrees rotation, no scale). */
export function poseMatrix(pose: Pose): THREE.Matrix4 {
  const euler = new THREE.Euler(
    pose.rotation.x * DEG2RAD,
    pose.rotation.y * DEG2RAD,
    pose.rotation.z * DEG2RAD,
    'XYZ',
  )
  return new THREE.Matrix4().compose(
    new THREE.Vector3(pose.position.x, pose.position.y, pose.position.z),
    new THREE.Quaternion().setFromEuler(euler),
    new THREE.Vector3(1, 1, 1),
  )
}

/** Return a NEW positions array with `pose` baked in (does not mutate input).
 *  Identity pose is short-circuited to a plain copy. */
export function bakePoseIntoPositions(positions: ArrayLike<number>, pose: Pose): Float32Array {
  const out = new Float32Array(positions.length)
  const isIdentity =
    pose.position.x === 0 && pose.position.y === 0 && pose.position.z === 0 &&
    pose.rotation.x === 0 && pose.rotation.y === 0 && pose.rotation.z === 0
  if (isIdentity) {
    for (let i = 0; i < positions.length; i++) out[i] = positions[i]
    return out
  }
  const m = poseMatrix(pose)
  const v = new THREE.Vector3()
  for (let i = 0; i + 2 < positions.length; i += 3) {
    v.set(positions[i], positions[i + 1], positions[i + 2]).applyMatrix4(m)
    out[i] = v.x
    out[i + 1] = v.y
    out[i + 2] = v.z
  }
  return out
}

/** Assemble a world-space MeshBuffers from raw positions/indices + a pose. */
export function worldBakedMesh(
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
  pose: Pose,
): MeshBuffers {
  return {
    positions: bakePoseIntoPositions(positions, pose),
    indices: indices instanceof Uint32Array ? indices.slice() : Uint32Array.from(indices),
  }
}
