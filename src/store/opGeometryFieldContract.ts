// INT-17A-R5 C1: the COMPILE-TIME geometry-reference field contract.
//
// ─── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
//
// The R4 audit's major finding (coordination/reports/INT-17A-R4.audit.json):
// the R3/R4 census's "independent" derivation (independentGeometryField in
// int17aR3OpCensus.test.ts) classified every family purely from the
// OperationType STRING's `_3d` suffix. A separate, disconnected tuple of
// type-level assertions checked ten payload interfaces for `geometryId`
// presence/absence, but nothing bound THOSE checks to the map's own keys or
// values - a renamed field on an implemented family's payload type would not
// have failed the build, only a hand-maintained tuple entry someone forgot to
// touch. The DECISIONS ruling this WO is bound to (2026-07-18, "INT-17A C1
// two-bounce STOP") names the fix: "derive each family's geometry field from
// its payload TYPE" cannot happen at RUNTIME (TypeScript types erase); it has
// to be a `satisfies`-checked mapping that tsc itself validates, where a
// renamed field OR a new op type fails the BUILD.
//
// THIS is that mapping. `OP_GEOMETRY_FIELD_MAP` is declared
// `as const satisfies OpGeometryFieldMapType`, and `OpGeometryFieldMapType` is
// built FROM `OpPayloadByType[K]` for every `K` in the closed `OperationType`
// union - so:
//   - a MISSING family (a key of OperationType absent from the map, or absent
//     from OpPayloadByType)                    -> tsc error, `npm run build` fails.
//   - a RENAMED field (the map's `fields` array names a string that is not a
//     real key of that family's OWN payload interface)
//                                               -> tsc error, `npm run build` fails.
// Both are proven by the mutation-proof pair this WO commits (B3): renaming
// one mapped field on a scratch copy turns `npm run build` red; restoring it
// turns green again. That is a STRONGER, independence-by-construction gate
// than any runtime census can be - it is checked by a completely different
// tool (tsc) against the REAL production interfaces, not against a test
// file's own idea of what those interfaces look like.
//
// ─── FAMILIES WITH NO COMPUTE PATH YET ──────────────────────────────────────
//
// bore and vcarve have no implementation (dispatch stops at "unsupported operation
// type", the same as any op type NewOperationModal cannot construct). The R4
// audit gave two acceptable cures for this gap: "define a canonical payload
// contract now" or "narrow the census claim and add an automatic
// implementation-state gate." This file takes the FIRST option, but only
// where it produces a REAL check:
//   - bore, vcarve: 2.5D families. Every one of their eight IMPLEMENTED 2.5D
//     siblings (contour_2d, pocket_2d, adaptive_clearing_2d, drill,
//     thread_mill, engrave, chamfer, face) carries its geometry entry id in
//     `params.geometryId` - not by accident, by the SAME convention documented
//     in opModelOriginGuard.ts's own header. `BoreParams` / `VCarveParams`
//     (src/lib/cam/types.ts) declare exactly that field, canonically, now -
//     giving this map a REAL interface to check `geometryId` against, so a
//     future rename of that field (on an interface these two families will
//     extend, not replace, when implemented) fails the build exactly as it
//     would for an implemented family.
//   - scallop_3d, pencil_3d: 3D
//     families. Every 3D family's geometry entry id lives in the shared
//     `Operation.geometrySelections` array, NOT in `params` at all (see
//     opModelOriginGuard.ts's header) - `parallel_3d` and `adaptive_3d`
//     PROVE this today (`AssertFalse<HasGeometryId<...>>`-style checks below
//     confirm their real payload interfaces do NOT carry `geometryId`). A
//     `geometrySelections`-kind entry names no per-family payload field at
//     all, so there is nothing to invent a canonical interface FOR - inventing
//     one would only be a stub nobody reads. Their payload type below is
//     `UnimplementedPayload` (`Record<string, unknown>`, the same generic
//     shape `Operation.params` itself has for every family), which is honest:
//     no real payload interface exists yet, and none is needed for this
//     family's entry to be forced into `geometrySelections` at compile time -
//     the FIELD REF value itself (`{ kind: 'geometrySelections' }`) carries no
//     `keyof payload` obligation to check.
//
// ─── WHAT THIS FILE DOES NOT DO ─────────────────────────────────────────────
//
// It does not replace `OP_GEOMETRY_REFERENCE_SOURCE`
// (src/store/opModelOriginGuard.ts), which stays the PRODUCTION guard's own
// source of truth and is UNCHANGED by this WO (charter: no production
// behavior edits). This file is the INDEPENDENT compile-time cross-check the
// R4 audit asked for: int17aR3OpCensus.test.ts's census now derives its
// fixture-planting field from THIS map (never from
// OP_GEOMETRY_REFERENCE_SOURCE) and asserts the two agree for all 17 families.

import type { OperationType } from '../types'
import type {
  ContourParams, PocketParams, DrillParams, ThreadMillParams,
  ChamferParams, EngraveParams, ACParams, FaceParams,
  BoreParams, VCarveParams,
} from '../lib/cam/types'
import type { Parallel3dParams } from '../cam3d/integration/parallel3dOperation'
import type { Adaptive3dParams } from '../cam3d/integration/adaptive3dOperation'
import type { WaterlineParams } from '../cam3d/integration/waterline3dOperation'
import type { SteepShallow3dParams } from '../cam3d/integration/steepShallow3dOperation'
import type { Scallop3dParams } from '../cam3d/integration/scallop3dOperation'
import type { Pencil3dParams } from '../cam3d/integration/pencil3dOperation'
import type { OpGeometryReferenceSource } from './opModelOriginGuard'

/** True iff T's own declared keys include 'geometryId'. Mirrors the R4 cure's
 *  HasGeometryId, kept local so this file has no runtime OR type import from
 *  the census test (independence runs both directions). */
type HasGeometryId<T> = 'geometryId' extends keyof T ? true : false
type AssertTrue<T extends true> = T
type AssertFalse<T extends false> = T

/** No real payload interface exists for this family yet (see file header,
 *  Every live family below names its actual operation payload rather than a
 *  generic stand-in. */
/**
 * Every `OperationType` mapped to the payload interface a real op of that
 * family carries in `params` - the thing B1 requires this map's field names
 * be checked AGAINST. `_PayloadMapCoversUnion` below forces this object type's
 * key set to equal `OperationType` exactly (missing OR stale key = tsc error).
 */
export type OpPayloadByType = {
  // 2.5D - implemented.
  face: FaceParams
  contour_2d: ContourParams
  pocket_2d: PocketParams
  adaptive_clearing_2d: ACParams
  drill: DrillParams
  thread_mill: ThreadMillParams
  engrave: EngraveParams
  chamfer: ChamferParams
  // 2.5D - unimplemented, canonical contract (see file header).
  bore: BoreParams
  vcarve: VCarveParams
  // 3D - implemented.
  parallel_3d: Parallel3dParams
  adaptive_3d: Adaptive3dParams
  waterline_3d: WaterlineParams
  steep_shallow_3d: SteepShallow3dParams
  scallop_3d: Scallop3dParams
  pencil_3d: Pencil3dParams
}

type KeysExactly<A extends PropertyKey, B extends PropertyKey> =
  [A] extends [B] ? ([B] extends [A] ? true : false) : false

/** Forces `OpPayloadByType`'s key set to equal the closed `OperationType`
 *  union exactly. Add a member to `OperationType` without adding it here (or
 *  remove one from `OperationType` and leave a stale key here) and this line
 *  fails `npm run build` - the "missing family" half of B1's requirement. */
export type _INT17AR5_PayloadMapCoversUnion =
  AssertTrue<KeysExactly<keyof OpPayloadByType, OperationType>>

/** Re-confirms, against the REAL payload interfaces, which families carry
 *  `geometryId` in `params` and which do not - the same compile-time contract
 *  the R4 cure established, kept here as the direct evidence backing
 *  OP_GEOMETRY_FIELD_MAP's per-family `fields` values below. */
export type _INT17AR5_PayloadShapeContract = [
  AssertTrue<HasGeometryId<FaceParams>>,
  AssertTrue<HasGeometryId<ContourParams>>,
  AssertTrue<HasGeometryId<PocketParams>>,
  AssertTrue<HasGeometryId<ACParams>>,
  AssertTrue<HasGeometryId<DrillParams>>,
  AssertTrue<HasGeometryId<ThreadMillParams>>,
  AssertTrue<HasGeometryId<EngraveParams>>,
  AssertTrue<HasGeometryId<ChamferParams>>,
  AssertTrue<HasGeometryId<BoreParams>>,
  AssertTrue<HasGeometryId<VCarveParams>>,
  AssertFalse<HasGeometryId<Parallel3dParams>>,
  AssertFalse<HasGeometryId<Adaptive3dParams>>,
  AssertFalse<HasGeometryId<WaterlineParams>>,
  AssertFalse<HasGeometryId<SteepShallow3dParams>>,
  AssertFalse<HasGeometryId<Scallop3dParams>>,
  AssertFalse<HasGeometryId<Pencil3dParams>>,
]

/**
 * Where a family of `kind: 'params'` names its geometry entry: a non-empty
 * list of field names, each constrained to `keyof Payload` - a field name
 * that is not a REAL key of that family's own payload interface fails
 * `npm run build`. `kind: 'geometrySelections'` and `kind: 'none'` name no
 * payload field (see file header) and carry no `Payload`-derived obligation.
 */
type FieldRefFor<Payload> =
  | { readonly kind: 'params'; readonly fields: readonly (keyof Payload & string)[] }
  | { readonly kind: 'geometrySelections' }
  | { readonly kind: 'none' }

/** Payload-erased shape of `FieldRefFor<P>` - every concrete instantiation is
 *  assignable to this (a `keyof P & string` array is always a `string[]`), so
 *  it is the right parameter type for a function that accepts any family's
 *  field ref without needing to know which family's payload produced it. */
export type OpFieldRef =
  | { readonly kind: 'params'; readonly fields: readonly string[] }
  | { readonly kind: 'geometrySelections' }
  | { readonly kind: 'none' }

/** The `satisfies` target: every `OperationType` key's value constrained to
 *  ITS OWN family's `FieldRefFor<OpPayloadByType[K]>` - this is what makes the
 *  `fields` array below a per-family, payload-type-derived check rather than
 *  a single shared string type every entry could satisfy interchangeably. */
type OpGeometryFieldMapType = {
  readonly [K in OperationType]: FieldRefFor<OpPayloadByType[K]>
}

/**
 * THE COMPILER-CHECKED MAP. Exhaustive over `OperationType` AND, for every
 * `kind: 'params'` entry, checked field-by-field against that family's REAL
 * payload interface - both by construction of `OpGeometryFieldMapType` above.
 *
 * Rename `geometryId` on any implemented (or canonically-contracted, for
 * bore/vcarve) payload interface without updating the matching entry here,
 * or vice versa, and `npm run build` fails. This is the B3 mutation target.
 */
export const OP_GEOMETRY_FIELD_MAP = {
  // 2.5D - entry id in params.geometryId (every family, implemented or the
  // canonical bore/vcarve contract, agrees - see file header).
  face: { kind: 'params', fields: ['geometryId'] },
  contour_2d: { kind: 'params', fields: ['geometryId'] },
  pocket_2d: { kind: 'params', fields: ['geometryId'] },
  adaptive_clearing_2d: { kind: 'params', fields: ['geometryId'] },
  drill: { kind: 'params', fields: ['geometryId'] },
  bore: { kind: 'params', fields: ['geometryId'] },
  thread_mill: { kind: 'params', fields: ['geometryId'] },
  engrave: { kind: 'params', fields: ['geometryId'] },
  vcarve: { kind: 'params', fields: ['geometryId'] },
  chamfer: { kind: 'params', fields: ['geometryId'] },
  // 3D - entry id in the shared Operation.geometrySelections field, never in
  // params (parallel_3d / adaptive_3d prove this via
  // _INT17AR5_PayloadShapeContract's AssertFalse<HasGeometryId<...>> above).
  parallel_3d: { kind: 'geometrySelections' },
  waterline_3d: { kind: 'geometrySelections' },
  adaptive_3d: { kind: 'geometrySelections' },
  scallop_3d: { kind: 'geometrySelections' },
  steep_shallow_3d: { kind: 'geometrySelections' },
  pencil_3d: { kind: 'geometrySelections' },
} as const satisfies OpGeometryFieldMapType

/** Every member of the closed union, derived from THIS map's own keys - never
 *  a hand-typed second list (see opModelOriginGuard.ts's ALL_OPERATION_TYPES
 *  for the identical rationale, applied here independently). */
export const ALL_OPERATION_TYPES_FROM_FIELD_CONTRACT: readonly OperationType[] =
  Object.keys(OP_GEOMETRY_FIELD_MAP) as OperationType[]

/**
 * Converts a compile-checked field ref into the same three-value vocabulary
 * `OP_GEOMETRY_REFERENCE_SOURCE` (src/store/opModelOriginGuard.ts) uses, so
 * the census's cross-check test can compare this map against the guard's map
 * directly. `params` always maps to the literal `'params.geometryId'` - true
 * for every entry above today (every `kind: 'params'` family's `fields` is
 * `['geometryId']`); if a future family ever needs a DIFFERENT params field
 * name, `operationReferencedGeometryIds` (the guard) would need to generalize
 * beyond its current hardcoded `params.geometryId` read at the same time, so
 * this conversion deliberately narrows rather than silently generalizing.
 */
export function fieldRefToLegacySource(ref: OpFieldRef): OpGeometryReferenceSource {
  if (ref.kind === 'geometrySelections') return 'geometrySelections'
  if (ref.kind === 'none') return 'none'
  return 'params.geometryId'
}
