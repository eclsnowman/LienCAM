// WO-3002 (A3-09 steps 2 and 5): the feature interface's data contract.
import type { CylinderFeature, HoleFeature, Vec2 } from '../../types'
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
  /** Source facts for consumer rebinding. Not part of geometric identity.
   *  Missing evidence/error remains unknown; old callers need not supply it. */
  readonly evidence?: FeatureRecognitionEvidence
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
  /** Caller-supplied ownership/version; not proof of freshness or a cache key. */
  readonly scope?: FeatureSourceScope
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

/** Optional source ownership carried into the future revision-bound consumer.
 *  PartFrame remains the coordinate authority. Runtime handles, transforms,
 *  memoization and stale-response policy belong to the binder, not this data. */
export interface FeatureSourceScope {
  readonly projectId: string
  readonly sourceGeometryId: string
  readonly sourceFormat?: string
  readonly modelItemId?: string
  readonly bodyId?: string
  readonly geometryVersion?: string | number
}

/** These are the existing structural adapter inputs, with optional producer
 *  evidence fields. No recognizer, worker, document or store imports. */
export type StepCylinderLike = Pick<HoleFeature, 'center' | 'diameter' | 'topZ' | 'bottomZ' | 'through'> & { kind?: CylinderFeature['kind'] }

export interface ModelVerdictLike {
  readonly featureKey: string
  readonly featureClass: string
  readonly removable: boolean
  readonly refuseReason?: string
  readonly faceIds: readonly string[]
  readonly params: Readonly<Record<string, number | string>>
  /** a counterbore's wide wall faces (a subset of faceIds) */
  readonly counterboreFaceIds?: readonly string[]
}

type MeshP3 = P3
export interface MeshRoundLike {
  readonly id: string
  readonly kind: string
  readonly axis: { readonly origin: MeshP3; readonly direction: MeshP3 }
  readonly diameterMm: number
  readonly diametersMm: readonly number[]
  readonly depthMm: number
  readonly bands: readonly {
    readonly surface: AxialBand['surface']
    readonly diameterMm: number
    readonly endDiameterMm?: number
    readonly axialRangeMm: readonly [number, number]
    readonly maxDeviationMm?: number
    readonly sourceFacetIds?: readonly number[]
    readonly includedAngleDeg?: number
  }[]
  readonly maxDeviationMm?: number
  readonly coreRadiusMm?: number
  readonly profile?: string
  readonly sourceFacetIds: readonly number[]
}
export interface MeshRegionLike {
  readonly id: string
  readonly kind: string
  readonly floorNormal: MeshP3
  readonly corners?: readonly MeshP3[]
  readonly centerline?: readonly [MeshP3, MeshP3]
  readonly lengthMm: number
  readonly widthMm: number
  readonly depthMm: number
  readonly maxDeviationMm?: number
  readonly floorSourceFacetIds?: readonly number[]
  readonly clearCorners?: readonly MeshP3[]
  /** slot only */
  readonly endStyle?: string
  /** drafted pocket only: the lean of the wall on side k (corners[k] -> corners[k+1]) */
  readonly wallDraftDeg?: readonly number[]
  readonly sourceFacetIds: readonly number[]
}
export interface MeshBlendLike {
  readonly id: string
  readonly kind: string
  readonly shape: string
  readonly radiusMm?: number
  readonly setbackMm?: readonly [number, number]
  readonly includedAngleDeg: number
  readonly lengthMm: number
  readonly maxDeviationMm?: number
  readonly tangencyErrorMm?: number
  readonly angleDeg?: number
  readonly edgeLine: { readonly ends: readonly [MeshP3, MeshP3] }
  readonly sourceFacetIds: readonly number[]
}
/** Query evidence is descriptive, never a machining tolerance or cache key. */
export interface MeshQueryEvidence {
  readonly toleranceMm?: number
  readonly facetCount?: number
  readonly crackWeldsClosed?: number
  readonly ambiguousCrackWelds?: number
  readonly refusals?: readonly {
    readonly reason: string
    readonly facetCount: number
    readonly sourceFacetIds: readonly number[]
  }[]
}
export interface MeshRecognitionLike extends MeshQueryEvidence {
  readonly features: readonly MeshRoundLike[]
  readonly pockets?: readonly MeshRegionLike[]
  readonly slots?: readonly MeshRegionLike[]
  readonly draftedPockets?: readonly MeshRegionLike[]
}

export interface LoopLike {
  readonly id: string
  readonly points: readonly Vec2[]
  readonly closed: boolean
  readonly type: string
  readonly layerId: string
}

/** The legacy DepthEvidence discriminator is retained for identity/clients.
 *  These labels say HOW that number was obtained; a BREP source alone does
 *  not promote a recognizer parameter estimate into an analytic floor. */
export type FeatureRecognitionEvidence =
  | { readonly source: 'step-cylinder-scan'; readonly depthProvenance: 'analytic-cylinder-span'; readonly cylinders: readonly StepCylinderLike[] }
  | { readonly source: 'model-kernel'; readonly depthProvenance: 'recognizer-parameter-estimate' | 'unknown'; readonly verdict: ModelVerdictLike; readonly faces?: Readonly<Record<string, FaceDescriptor>> }
  | { readonly source: 'stl-mesh'; readonly depthProvenance: 'fitted-mesh'; readonly kind: 'round'; readonly feature: MeshRoundLike; readonly query: MeshQueryEvidence }
  | { readonly source: 'stl-mesh'; readonly depthProvenance: 'fitted-mesh'; readonly kind: 'region'; readonly feature: MeshRegionLike; readonly query: MeshQueryEvidence }
  | { readonly source: 'stl-mesh'; readonly depthProvenance: 'unknown'; readonly kind: 'blend'; readonly feature: MeshBlendLike; readonly query: MeshQueryEvidence }
  | { readonly source: 'sketch-2d'; readonly depthProvenance: 'operation-parameters'; readonly loop: LoopLike }
