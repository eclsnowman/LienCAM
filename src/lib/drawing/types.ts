// WO-2750 Slice A (WO-2981): the durable records a technical drawing keeps so a
// view or dimension goes on pointing at the same part geometry through edits.
//
// docs/design/ASSOCIATIVE-TECHNICAL-DRAWINGS.md section 4.1 sketched these as a
// schema; this file is that sketch made real, plus the projection scene that
// section 5 asks the editor, PDF and DXF to share. Plain data only: no kernel
// handle, no React, nothing that cannot be saved in a project archive.
//
// Identity is NOT minted here. A BREP selector carries the producer-owned
// StableId (docs/stable-id-spec.md); a mesh selector carries the
// geometry-derived chain id or a fitted-feature support fingerprint. Query ids,
// DFS face indices and source facet numbers never become durable identity.

import type { GeometrySnapshot } from '../../geom/geom-service'

export type DrawingVec3 = [number, number, number]

/**
 * What the drawing last saw of its source. `geometryFingerprint` invalidates
 * caches; it does not prove which entity survived an edit (resolve.ts decides
 * that from lineage). `frameFingerprint` covers the source-to-view placement.
 */
export interface SourceRevision {
  /** model-space content, not the session's cache version */
  geometryFingerprint: string
  /** source-local frame the views were placed against */
  frameFingerprint: string
  /** kernel build or mesh detector identity plus its settings */
  producerVersion: string
  /** raw mesh edit journal, when the source is a mesh */
  journalFingerprint?: string
}

export type DrawingSourceKind = 'model-brep' | 'imported-brep' | 'mesh'

/** The scoped source a drawing belongs to. Every field is part of the scope. */
export interface DrawingSource {
  modelItemId: string
  documentId: string
  /** body lineage root, never the current feature leaf */
  lineageId: string
  kind: DrawingSourceKind
  /** immutable archive asset id of an imported file */
  importAssetId?: string
  /** content hash of the imported bytes */
  importContentFingerprint?: string
  /** which solid of a multi-solid import; never "the first solid" by default */
  importSolidKey?: string
  observedRevision: SourceRevision
}

/** How a reference names its geometry. */
export type DrawingSelector =
  | { kind: 'face' | 'edge' | 'vertex'; stableId: string }
  | { kind: 'mesh-chain'; chainId: string; settingsFingerprint: string }
  | {
      kind: 'mesh-feature'
      featureKind: string
      /** kind + fitted axis/diameter/size, rounded (resolve.ts meshFeatureSupportFingerprint) */
      supportFingerprint: string
      settingsFingerprint: string
    }

export type WitnessRole = 'point' | 'endpoint' | 'center' | 'axis' | 'curve' | 'plane'

/** What the dimension meant when it was placed, checked again on every resolve. */
export interface DrawingWitness {
  role: WitnessRole
  pointLocalMm?: DrawingVec3
  /** interpreted with the stored orientation */
  endpoint?: 'start' | 'end'
  /** plane normal (signed) or axis direction (unsigned) at placement */
  orientationLocal?: DrawingVec3
  /** a stored curve parameter is only a seed, never identity */
  parameter?: number
  /** snapshot text used for validation and repair candidates */
  geometrySignature: string
  /**
   * Decide-and-log (WO-2981): the face snapshot the signature was made from,
   * kept so a resolve can test role and orientation without the kernel. Same
   * shape the ElementMap already stores; absent for mesh selectors.
   */
  snapshot?: GeometrySnapshot
}

export interface DrawingReference {
  id: string
  source: DrawingSource
  selector: DrawingSelector
  witness: DrawingWitness
  acceptedRevision: SourceRevision
}

export type ReferenceState = 'current' | 'updating' | 'stale' | 'missing' | 'ambiguous' | 'unsupported'

export type ReferenceVia = 'exact' | 'lineage' | 'confirmed-repair' | 'none'

/** Machine-readable cause; the editor turns it into words (LIENCAM.md rule 11). */
export type ReferenceReason =
  | 'scope-mismatch'
  | 'source-missing'
  | 'source-kind-changed'
  | 'import-replaced-without-lineage'
  | 'producer-changed'
  | 'deleted'
  | 'not-found'
  | 'split'
  | 'geometric-candidate-only'
  | 'witness-role-mismatch'
  | 'witness-orientation-changed'
  | 'endpoints-collapsed'
  | 'mesh-replay-stopped'
  | 'detector-settings-changed'
  | 'mesh-chain-not-proved'
  | 'mesh-feature-not-proved'
  | 'malformed-selector'
  | 'edge-gone'
  | 'edge-twin-changed'
  | 'topology-unavailable'

export interface ReferenceResult {
  referenceId: string
  state: ReferenceState
  resolvedIds: string[]
  via: ReferenceVia
  /** viable targets kept for an explicit repair; never applied automatically */
  candidates: string[]
  reason?: ReferenceReason
  /** the revision this result describes; publish only if it is still current */
  measuredAt?: SourceRevision
  /**
   * What the plain ElementMap.resolve() said for a BREP face, kept as evidence
   * of where drawing policy is stricter (a split winner it calls 'exact' is
   * 'ambiguous' here).
   */
  elementMap?: { status: 'exact' | 'fallback' | 'lost'; via: 'exact' | 'lineage' | 'geometric' | 'none'; boundTo: string[] }
}

// ---------------------------------------------------------------------------
// Projection (plan section 5): one scene shared by editor, PDF and DXF.
// ---------------------------------------------------------------------------

export type StandardViewName = 'front' | 'top' | 'right' | 'iso'

/**
 * An orthonormal model-to-view frame. `towardViewer` points from the part to
 * the eye; `xAxis` is paper right; `upAxis` = towardViewer x xAxis is paper up.
 */
export interface ViewFrame {
  name?: StandardViewName
  origin: DrawingVec3
  towardViewer: DrawingVec3
  xAxis: DrawingVec3
  upAxis: DrawingVec3
}

export interface RationalScale {
  numerator: number
  denominator: number
}

export type LineVisibility = 'visible' | 'hidden'

/**
 * outline = kernel silhouette of a curved face; smooth = tangent edge; sharp =
 * a real BREP edge; silhouette = view-dependent mesh contour (approximate);
 * feature = a mesh boundary/sharp chain.
 */
export type LineCategory = 'outline' | 'smooth' | 'sharp' | 'silhouette' | 'feature'

/** A polyline in view millimetres (u right, v up), before sheet scale. */
export interface ProjectedLine {
  visibility: LineVisibility
  category: LineCategory
  points: Array<[number, number]>
  /** mesh chain id when the line came from one */
  sourceId?: string
}

export type ProjectionProducer = 'occt-hlr' | 'mesh-occlusion'

export interface ProjectionScene {
  frame: ViewFrame
  producer: ProjectionProducer
  producerVersion: string
  /** worst chord error of a discretized curve, model mm (not a tolerance) */
  chordToleranceMm: number
  lines: ProjectedLine[]
  /** honest limits of this producer, shown with the view */
  limits: string[]
  stats: {
    visibleLengthMm: number
    hiddenLengthMm: number
    /** hidden pieces dropped because a visible line covers them */
    hiddenSuppressedLengthMm: number
    /** second copies of an already drawn line, dropped */
    duplicateSuppressedLengthMm: number
    ms: number
  }
}

/** A scene placed on paper: sheet mm, origin top-left, Y down (plan section 6). */
export interface SheetLine {
  visibility: LineVisibility
  category: LineCategory
  points: Array<[number, number]>
}
