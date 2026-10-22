// WO-3002 (A3-09 steps 2 and 5): the feature interface's data contract.
import type { P3 } from './signature'

/** The CLOSED feature-type set. A recogniser output that maps to none of these
 *  is `unclassified`, with one line saying why; nothing else is ever listed. */
export const FEATURE_TYPES = [
  'throughHole', 'blindHole', 'counterbore', 'countersink', 'chamferedHole', 'boss',
  'pocket', 'slot', 'draftedPocket', 'engravedText', 'fillet', 'chamfer', 'sliver',
  'unclassified',
] as const
export type FeatureType = typeof FEATURE_TYPES[number]
export const isFeatureType = (value: unknown): value is FeatureType =>
  typeof value === 'string' && (FEATURE_TYPES as readonly string[]).includes(value)

/** Who produced the evidence (GAP-013 R1, R2, R4, and 2D loops). */
export const FEATURE_SOURCES = ['step-cylinder-scan', 'model-kernel', 'stl-mesh', 'sketch-2d'] as const
export type FeatureSource = typeof FEATURE_SOURCES[number]

/** The part frame: a WO-2945 FrameRef of kind `geometry-native` satisfies this
 *  structurally (the kernel boundary admits no import of that module). Every
 *  coordinate below is in this frame. */
export interface PartFrame {
  readonly kind: 'geometry-native'
  readonly entityId: string
}

/** One surface of a round feature: where it starts and ends along the
 *  canonical axis, and its diameter at each end (equal for a cylinder). */
export interface AxialBand {
  readonly surface: 'cylinder' | 'cone'
  readonly stationsMm: readonly [number, number]
  readonly diametersMm: readonly [number, number]
}
/** A round feature on an axis. `direction` is canonical (signature.ts), `axisPoint`
 *  the line's foot nearest the frame origin, `stationsMm` [low, high] along it.
 *  `bands` is the whole profile, low station first: every shoulder and every
 *  diameter the source measured sits in it, so no step is lost to the extremes. */
export interface AxialGeometry {
  readonly kind: 'axial'
  readonly axisPoint: P3
  readonly direction: P3
  readonly stationsMm: readonly [number, number]
  readonly diameterMm: number
  /** every diameter the source measured, as the source lists them */
  readonly diametersMm: readonly number[]
  readonly bands: readonly AxialBand[]
}
/** A feature known by where it is and how big: area-weighted centre, the
 *  normal when it has one, and its extents largest first. */
export interface RegionGeometry {
  readonly kind: 'region'
  readonly centroid: P3
  readonly normal?: P3
  readonly sizeMm: readonly number[]
  /** total face area when the source gives faces rather than extents */
  readonly areaMm2?: number
  /** the outline's corners (or a slot's centreline ends) in canonical ring
   *  order (signature.ts canonicalRing): a turned outline is new geometry */
  readonly outline?: readonly P3[]
}
/** A feature along a line (an edge blend): unordered ends. */
export interface LineGeometry {
  readonly kind: 'line'
  readonly ends: readonly [P3, P3]
  readonly sizeMm: readonly number[]
}
/** A source that gives no geometry the kernel can read: its own key stands in,
 *  stated as such. */
export interface KeyedGeometry {
  readonly kind: 'source-key'
  readonly key: string
}
export type FeatureGeometry = AxialGeometry | RegionGeometry | LineGeometry | KeyedGeometry

export type DepthEvidence =
  | { readonly evidence: 'measured'; readonly depthMm: number }
  | { readonly evidence: 'from-parameters' }
  | { readonly evidence: 'none' }

/** What an adapter hands the identity service: one recogniser output, mapped. */
export interface FeatureCandidate {
  readonly type: FeatureType
  readonly geometry: FeatureGeometry
  readonly depth: DepthEvidence
  /** the recogniser's own type text, verbatim */
  readonly sourceType: string
  /** the recogniser's own id or key, verbatim (never used for identity) */
  readonly sourceKey: string
  /** the recogniser's face / facet / loop ids, as strings, sorted */
  readonly references: readonly string[]
  /** every defining dimension the source measured that `geometry` does not
   *  already hold, by name (adapters.ts DEFINING_FIELDS lists them per source
   *  type). All of them enter the id. */
  readonly dimensions: Readonly<Record<string, number | string>>
  /** one line, present when `type` is `unclassified`, geometry is
   *  `source-key`, or a measured dimension could not be placed on the geometry */
  readonly note?: string
}

export interface PartFeature extends FeatureCandidate {
  /** `feature:<hash>` (+ `#n` per the collision rule): stable across re-import,
   *  entity order and runs for the same geometry; new geometry, new id. */
  readonly id: string
  readonly source: FeatureSource
}

export interface PartFeatureList {
  readonly frame: PartFrame
  readonly source: FeatureSource
  /** sorted by id */
  readonly features: readonly PartFeature[]
  /** one line per thing a recogniser could not give (a failed body, a skipped output) */
  readonly notes: readonly string[]
}

/** B-rep face facts, as a modelling-kernel `GeometrySnapshot` carries them. */
export interface FaceDescriptor {
  readonly surface: string
  readonly areaMm2: number
  readonly centroid: P3
  readonly normal?: P3
  readonly axis?: P3
}
/** An edge as a polyline in the part frame (tessellated B-rep edge or mesh chain). */
export interface EdgeDescriptor {
  readonly points: readonly P3[]
  readonly closed: boolean
}
export interface IdentifiedEntity<T> {
  readonly id: string
  readonly sourceId: string
  readonly descriptor: T
}
