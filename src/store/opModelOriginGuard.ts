// INT-17A-R3 C1: the model-origin compute guard, at the NARROWEST SHARED
// operation boundary, derived from the CLOSED OperationType union.
//
// ─── WHAT THE ROUND-3 AUDIT FOUND ───────────────────────────────────────────
//
// R2 put the guard at src/store/index.ts:6390, which reads as "the top of
// compute" but is not: parallel_3d and adaptive_3d branch and RETURN above it
// (index.ts:6320 and :6348), because both hand off to the cam3d worker instead
// of toolpathWorker. Worse, the two families do not even name their geometry
// the same way - 2.5D ops carry the entry id in `params.geometryId` while 3D
// ops carry it in `geometrySelections[0]` (and 2.5D ops use geometrySelections
// for LOOP ids, an entirely different id space). So the R2 guard was not merely
// mis-placed; it was reading a field the 3D families never populate.
//
// A modeled body named by a 3D op therefore never reached the named Stage 1
// refusal. It did error - on the incidental format check at index.ts:1052/1411
// ("needs an STL or STEP solid, but "Model F1" is model") - which is why this
// was a major and not a blocker: no route admitted a modeled body into a
// completed toolpath. But an incidental refusal is not a guard. It fires only
// because 'model' happens not to be 'stl' or 'step'; it names no Stage, offers
// no next action, and would evaporate the moment a modeled body gained a
// tessellated payload the 3D path could read.
//
// ─── WHY A CENSUS, AND WHY THIS IS THE TRACTABLE CASE ───────────────────────
//
// The DECISIONS tripwire/guard ruling (2026-07-18 SKC-59 part 3) says an
// invariant belongs at a single choke point UNLESS the set of paths is a CLOSED
// enumerable set, in which case a census over that set is admissible and
// preferable. `OperationType` is exactly that: a closed union in
// src/types/index.ts. So the coverage argument here is not "we looked at the
// call sites and believe we found them all" - it is derived FROM the union.
//
// The mechanism is the exhaustive Record below. `Record<OperationType, X>` is
// checked by tsc, so adding a member to the union without classifying it here
// FAILS `npm run build`. And because the runtime census (see
// int17aR3OpCensus.test.ts) enumerates `Object.keys` of that same Record rather
// than a hand-typed list, a new op type cannot be added, classified, and then
// quietly left without a working refusal path either: the census drives every
// family's real payload build with a modeled entry as its source and requires
// each one to refuse BY NAME.
//
// ─── WHY ONE SHARED POINT AND NOT PER-FAMILY GUARDS ─────────────────────────
//
// The WO allows either. One shared point exists here and is strictly better:
// computeOperationToolpath is upstream of EVERY branch (the 3D hand-offs, the
// unsupported-type refusal, and the whole 2.5D resolution chain), and it is the
// action the Compute button calls. Per-family guards would have been four
// copies of the same policy with four chances to drift.
//
// The guard runs BEFORE the unsupported-operation-type check, deliberately. An
// op of an as-yet-unimplemented type (bore, vcarve, waterline_3d, ...) that
// names a modeled body should say WHY the body is refused, not stop at
// "unsupported operation type" - the type is the lesser problem, and the
// modeled-body answer is the one that tells the user what to do instead. It
// also makes the census uniform: every member of the union refuses by the same
// name, with no special-cased subset.
//
// The arrival-point guards inside dispatchGeo (computeGeometryScope at its
// resolvers) STAY. They are idempotent by construction and they cover callers
// that never pass through computeOperationToolpath at all.

import type { ImportedGeometry, Operation, OperationType } from '../types'
import { ModelOriginComputeError, computeGeometryScope } from './dispatchGeo'

/**
 * Where an operation family names the geometry ENTRY it cuts or references.
 *
 * - `params.geometryId` - the 2.5D families. `geometrySelections` holds LOOP
 *   ids for these, which live in a different id space and are NOT entry
 *   references; feeding them to the guard would be a category error (harmless
 *   today only because the two spaces happen not to collide, which is not a
 *   property worth depending on).
 * - `geometrySelections` - the 3D families. A single-element array holding the
 *   entry id itself (minted by modelBodyEntryId / set by NewOperationModal).
 * - `none` - families that take no geometry entry at all. There are none today;
 *   the case exists so a future stock-footprint-only family has an honest
 *   classification instead of being forced into a field it does not read.
 */
export type OpGeometryReferenceSource = 'params.geometryId' | 'geometrySelections' | 'none'

/**
 * THE CENSUS SOURCE OF TRUTH. Exhaustive over the closed `OperationType` union
 * by construction: `Record<OperationType, ...>` makes a missing member a tsc
 * error, and `npm run build` is the gate that catches it.
 *
 * Classifying a NEW op type is a deliberate act with a deliberate consequence.
 * Get it wrong and the census test fails, because the census drives each
 * family's real payload build with a modeled entry planted in the field this
 * map declares and requires a named refusal.
 */
export const OP_GEOMETRY_REFERENCE_SOURCE: Record<OperationType, OpGeometryReferenceSource> = {
  // 2.5D - entry id in params.geometryId, loop ids in geometrySelections.
  face: 'params.geometryId',
  contour_2d: 'params.geometryId',
  pocket_2d: 'params.geometryId',
  adaptive_clearing_2d: 'params.geometryId',
  drill: 'params.geometryId',
  bore: 'params.geometryId',
  thread_mill: 'params.geometryId',
  engrave: 'params.geometryId',
  vcarve: 'params.geometryId',
  chamfer: 'params.geometryId',
  pattern: 'params.geometryId',
  // 3D - entry id in geometrySelections[0]; these run through the cam3d worker
  // and never touch params.geometryId. This row IS the R2 bypass, written down.
  parallel_3d: 'geometrySelections',
  waterline_3d: 'geometrySelections',
  adaptive_3d: 'geometrySelections',
  scallop_3d: 'geometrySelections',
  steep_shallow_3d: 'geometrySelections',
  pencil_3d: 'geometrySelections',
}

/** Every member of the closed union, derived from the map rather than re-typed.
 *  A hand-typed second list is a second source of truth, and one that fails in
 *  whichever direction hides a gap. */
export const ALL_OPERATION_TYPES: readonly OperationType[] =
  Object.keys(OP_GEOMETRY_REFERENCE_SOURCE) as OperationType[]

/**
 * The geometry ENTRY ids this operation references, read from whichever field
 * its family actually uses.
 *
 * Returns [] for a family that references no entry, and skips empty/sentinel
 * values - `computeGeometryScope` treats `''` and `'__all__'` as aggregate
 * sentinels rather than ids, and this must not smuggle them past that.
 */
export function operationReferencedGeometryIds(
  op: Pick<Operation, 'type' | 'params' | 'geometrySelections'>,
): string[] {
  const source = OP_GEOMETRY_REFERENCE_SOURCE[op.type]
  if (source === 'none') return []
  if (source === 'geometrySelections') {
    return (op.geometrySelections ?? []).filter((id): id is string => typeof id === 'string' && id !== '')
  }
  const geometryId = (op.params as { geometryId?: string } | undefined)?.geometryId
  return typeof geometryId === 'string' && geometryId !== '' ? [geometryId] : []
}

/**
 * THE SHARED COMPUTE-BOUNDARY GUARD. Throws `ModelOriginComputeError` when this
 * operation names a model-origin entry, whatever family it belongs to.
 *
 * Delegates the actual decision to `computeGeometryScope` so the message a user
 * reads is byte-identical wherever a modeled body is caught - this boundary, a
 * height resolver, or a coordinate reference. The filtered collection it
 * returns is intentionally discarded here: this seam is a REFUSAL check, and
 * the downstream resolvers do their own scoping at their own arrival points.
 */
export function guardOperationModelOrigin(
  geometry: ReadonlyArray<ImportedGeometry>,
  op: Pick<Operation, 'type' | 'params' | 'geometrySelections'>,
): void {
  computeGeometryScope(geometry, ...operationReferencedGeometryIds(op))
}

export { ModelOriginComputeError }
