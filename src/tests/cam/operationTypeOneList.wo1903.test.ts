// WO-1903 — operation-type lists come from ONE place.
//
// Four sites used to name the operation types again by hand: the wizard's
// opType state (a 16-literal union), newOperationHeightDefaults'
// LiveSmartHeightOperationType (the same 16 literals), the store's queued cam3d
// subset (six literals) and heightReference.ts' HeightRefOpType (nine literals
// widened to `| string`, which made the compiler check nothing). Each is now
// derived from the ONE OperationType union in src/types (or the WO-1819
// manifest's cam3d lane). Adding an operation type turns a missed site red at
// COMPILE time instead of silently shipping.
//
// These are type-level checks: they are enforced by `tsc -b` (the product
// build), which compiles this file. expectTypeOf is vitest's type assertion -
// it is a no-op at runtime and a compile error on mismatch, which is exactly
// the proof we want.
import { describe, expectTypeOf, it } from 'vitest'
import type { OperationType } from '../../types'
import { OPERATION_MANIFEST } from '../../lib/cam/operationManifest'
import type { LiveSmartHeightOperationType } from '../../lib/cam/newOperationHeightDefaults'
import { useNewOperationModalState } from '../../components/modals/useNewOperationModalState'
import type { QueuedCam3dOperationType } from '../../store'

/** The wizard's state slot, read off the real hook's return type. */
type ModalOpType = ReturnType<typeof useNewOperationModalState>['opType']

/** Every manifest key whose compute lane is 'cam3d', straight off the table -
 *  never re-listed. */
type ManifestCam3dType = {
  [K in keyof typeof OPERATION_MANIFEST]:
    (typeof OPERATION_MANIFEST)[K]['compute']['lane'] extends 'cam3d' ? K : never
}[keyof typeof OPERATION_MANIFEST]

/** The six 3D families, spelled once here so the manifest and the store subset
 *  are cross-checked against the same anchor. */
type Expected3d = Extract<
  OperationType,
  'parallel_3d' | 'adaptive_3d' | 'waterline_3d' | 'steep_shallow_3d' | 'scallop_3d' | 'pencil_3d'
>

describe('WO-1903 — the one operation-type list', () => {
  it('the wizard opType state IS OperationType', () => {
    expectTypeOf<ModalOpType>().toEqualTypeOf<OperationType>()
  })

  it('the live smart-height op type IS OperationType', () => {
    expectTypeOf<LiveSmartHeightOperationType>().toEqualTypeOf<OperationType>()
  })

  it("the manifest's cam3d lane IS the six 3D families", () => {
    expectTypeOf<ManifestCam3dType>().toEqualTypeOf<Expected3d>()
  })

  it("the store's queued cam3d subset equals the manifest's cam3d lane", () => {
    expectTypeOf<QueuedCam3dOperationType>().toEqualTypeOf<ManifestCam3dType>()
  })
})
