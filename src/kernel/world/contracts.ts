// WO-3008 (alpha.3 A3-08, P2 parity slice): the kernel world model's records.
// Pure data. The kernel may import only its own files and the pure modules the
// WO-2904 boundary lists (src/types, src/lib/geometry/coordinateFrames).
import type {
  ImportedGeometry, ModelItemPlacementRecord, NestRecord, PhysicalStock, SceneStock, Setup, Vec3,
} from '../../types'

/** The slice of the project the world model reads. Never the mounted viewport. */
export interface WorldRecord {
  readonly stocks?: readonly PhysicalStock[]
  readonly sceneStock: SceneStock
  readonly geometry: readonly ImportedGeometry[]
  readonly modelItemPlacements?: readonly ModelItemPlacementRecord[]
  readonly nests?: readonly NestRecord[]
}

export type WorldSetup = Pick<Setup, 'id' | 'wcs' | 'stock'>

export interface Aabb { readonly min: Vec3; readonly max: Vec3 }

/** Card V07 policies (MD-43, MD-44). Both OFF until the card is approved. */
export interface WorldPolicy {
  /** MD-43: a part rotated about X or Y gets a placement instead of today's refusal. */
  readonly rotated_part_placement: boolean
  /** MD-44: loops are typed by containment depth instead of winding sign. */
  readonly loop_type_from_nesting: boolean
}

export const PARITY_POLICY: WorldPolicy = Object.freeze({
  rotated_part_placement: false,
  loop_type_from_nesting: false,
})

/** World Z = 0 is the machine table surface (OP-3). */
export const TABLE_Z = 0
