import type { OperationType } from '../../types'
import type { Point } from '../geometry/contracts'

/** One workholding body as the caller resolved it, in the frame of the setup's
 * planning loops (the store's workholdingInPartFrame output). Structurally the
 * engine's ClearanceMesh. */
export interface ObstacleMesh {
  /** xyz triples, mm. */
  readonly positions: ArrayLike<number>
  /** Triangle vertex indices into positions / 3. */
  readonly indices: ArrayLike<number>
}

/** A body as solid Z spans on a regular XY grid of column centres. Structurally
 * the engine's SolidColumns, so the injected builder is today's buildSolidColumns. */
export interface ObstacleColumns {
  readonly originX: number
  readonly originY: number
  readonly cell: number
  readonly nx: number
  readonly ny: number
  readonly spanStart: Uint32Array
  readonly spanZ: Float64Array
}

/** Every carded merge decision is a flag. Both ship OFF (parity); turning one on
 * is a later order with the operator looking at the toolpaths (A3-19 CARD class). */
export interface WorkholdingPolicy {
  /** MD-88: every family plans around the keep-outs. Off: today's per-family
   * behaviour (Pocket and Adaptive Clearing plan around, every other family is
   * trimmed afterwards by the worker's reach trim). */
  readonly keepout_in_planning: boolean
  /** MD-89 / MD-102: tabs honoured on every contour route. Off: today's routes. */
  readonly tabs_all_routes: boolean
}

export const PARITY_POLICY: WorkholdingPolicy = Object.freeze({ keepout_in_planning: false, tabs_all_routes: false })

/** One fixture or clamp as the caller hands it over. A missing mesh is kept as
 * an omission, never a refusal. */
export interface ObstacleInput {
  readonly id: string
  readonly name?: string
  readonly kind?: 'vise' | 'clamp' | 'fixture' | 'other'
  readonly mesh: ObstacleMesh | null
}

/** The setup record (algorithm step 1). The frame is the caller's WO-2945 token
 * and the envelope a reference; this service transforms neither. */
export interface SetupInput<Frame = unknown, Envelope = unknown> {
  readonly setupId: string
  readonly frame: Frame
  /** The setup this one is flipped from, when it is a flip setup. */
  readonly flipOf?: string
  readonly obstacles: readonly ObstacleInput[]
  readonly envelope?: Envelope
}

export interface Obstacle {
  readonly id: string
  readonly name: string
  readonly kind: NonNullable<ObstacleInput['kind']>
  /** XY footprint box and Z range of the solid columns, mm. */
  readonly footprint: { readonly minX: number; readonly minY: number; readonly maxX: number; readonly maxY: number }
  readonly bottomZ: number
  readonly topZ: number
}

export interface ObstacleOmission {
  readonly id: string
  readonly reason: 'no-mesh' | 'unreadable-mesh'
  /** One operator line: planning proceeds without a keep-out for this item. */
  readonly line: string
}

export interface SetupRecord<Frame = unknown, Envelope = unknown> {
  readonly setupId: string
  readonly frame: Frame
  readonly flipOf?: string
  readonly envelope?: Envelope
  readonly obstacles: readonly Obstacle[]
  readonly omissions: readonly ObstacleOmission[]
}

export interface KeepOutLevel {
  /** The deepest Z the operation cuts at. */
  readonly bottomZ: number
  /** The highest Z the cutter reaches while cutting (shallowest cut plus flute length). */
  readonly topZ: number
  /** The operation's Shank clearance, mm (0.25 mm by default today, CF-008). */
  readonly allowanceMm: number
}

export interface DepthBandRequest {
  /** The operation's cutting depths, highest first. */
  readonly depths: readonly number[]
  readonly topZ: number
  readonly allowanceMm: number
}

export interface DepthBand {
  readonly depths: number[]
  readonly keepOuts: Point[][]
  readonly addedFloorZ?: number
  readonly workholdingTopZ?: number
}

export interface ReducedRegion {
  readonly loops: Point[][]
  readonly removedAreaMm2: number
}

/** How a family receives the keep-outs (algorithm step 3). */
export type IslandRouting =
  | { readonly family: OperationType; readonly route: 'plan-around'; readonly backstop: 'reach-trim' }
  | { readonly family: OperationType; readonly route: 'trim-after'; readonly backstop: 'reach-trim' }

/** Obstacle tops published for the heights service (algorithm step 4). */
export interface ObstacleTop {
  readonly id: string
  readonly topZ: number
}
