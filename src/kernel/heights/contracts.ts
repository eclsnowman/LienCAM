// WO-3020 (alpha.3 A3-11, parity): the heights contracts - persisted intent,
// evidence graph and resolved plan - copied from src/lib/cam/smartHeights/types.ts
// (not edited) so the kernel service owns its own shapes. Kept field for field:
// the parity test compares kernel plans to today's with toEqual.
import type {
  HeightPlaneName,
  HeightReference,
  OperationType,
  PersistedOperationHeightState,
} from '../../types'

export const SMART_HEIGHT_INTENT_VERSION = 2 as const
export const SMART_HEIGHT_POLICY_VERSION = 1 as const

export type SmartHeightFrame = 'geometry_local' | 'world' | 'wcs' | 'machine'

export type SmartHeightIntentOwner =
  | { kind: 'setup'; setupId: string }
  | { kind: 'operation_policy' }
  | { kind: 'user_override' }

export interface AuthoredPlaneIntentV2 {
  reference: HeightReference
  offsetMm: number
  owner: SmartHeightIntentOwner
}

export interface OwnedSmartHeightIntent<T> {
  value: T
  owner: SmartHeightIntentOwner
}

export type MaterialStartIntent =
  | { kind: 'policy_default' }
  | { kind: 'current_material' }
  | { kind: 'initial_stock' }
  | { kind: 'selected_feature_top' }
  | { kind: 'target_model_top' }
  | { kind: 'geometry_tool_formula' }
  | { kind: 'explicit_plane'; plane: AuthoredPlaneIntentV2 }

export interface ThreadBandFormulaIntent {
  kind: 'thread_band'
  datum: 'feature_top' | 'feature_base' | 'authored_plane'
  direction: 'down' | 'up'
  depthMm: number
  datumOffsetMm: number
  datumPlane?: AuthoredPlaneIntentV2
}

export interface ChamferEdgeFormulaIntent {
  kind: 'chamfer_edge'
  /** Semantic plane containing the selected edge. The selected loops remain a
   * separate stable feature scope so a replaced edge cannot inherit this cut. */
  datumPlane: AuthoredPlaneIntentV2
  /** Requested axial chamfer depth below the datum plane. */
  chamferWidthMm: number
  /** Additional axial tool-tip depth used to move contact up the flute. */
  tipOffsetMm: number
}

export interface EngravePathFormulaIntent {
  kind: 'engrave_path'
  /** Physical surface used as the engraving datum. */
  datumPlane: AuthoredPlaneIntentV2
  /** Signed cutter-axis shift from the physical datum to Material Start. */
  axialOffsetMm: number
  /** Constant engraving depth measured down from Material Start. */
  depth:
    | { kind: 'explicit'; depthMm: number }
    | { kind: 'line_width'; targetLineWidthMm: number }
}

export interface VCarveRegionFormulaIntent {
  kind: 'vcarve_region'
  /** Physical surface the carve is measured from. */
  datumPlane: AuthoredPlaneIntentV2
  /** Carving begins this far below the datum (>= 0). Material Start =
   *  datum - startDepthMm. */
  startDepthMm: number
  /** Deepest the tip may go below Material Start: the operator's flat depth,
   *  or the bit's own physical limit (full diameter reached, or flute
   *  length) when no flat depth is set. Cutter End = Material Start - that. */
  flatDepth:
    | { kind: 'explicit'; depthMm: number }
    | { kind: 'tool_limit' }
}

export type GeometryToolFormulaIntent =
  | ThreadBandFormulaIntent
  | ChamferEdgeFormulaIntent
  | EngravePathFormulaIntent
  | VCarveRegionFormulaIntent

export type MachiningEndIntent =
  | { kind: 'policy_default' }
  | {
      kind: 'target_surface'
      /** Optional lower cutter-center limit for a spatial finishing field.
       * The physical target remains the surface artifact; this plane only
       * prevents the strategy from following it below the operator's limit. */
      lowerLimit?: AuthoredPlaneIntentV2
    }
  | { kind: 'selected_feature_floor' }
  | { kind: 'detected_feature_floors' }
  | { kind: 'selected_plane'; plane: AuthoredPlaneIntentV2 }
  | { kind: 'model_bottom'; allowanceMm: number }
  | { kind: 'stock_bottom'; allowanceMm: number }
  | { kind: 'through_stock'; allowanceMm: number }
  | { kind: 'depth_from_start'; depthMm: number }
  | { kind: 'geometry_tool_formula'; formula: GeometryToolFormulaIntent }
  | { kind: 'bounded_plane'; plane: AuthoredPlaneIntentV2 }

export type MachiningScopeIntent =
  | { kind: 'selected_geometry'; geometryIds: string[] }
  | {
      kind: 'selected_paths'
      geometryIds: string[]
      loopIds: string[]
      includeOpen: boolean
      includeClosed: boolean
    }
  | { kind: 'selected_features'; features: StableFeatureReference[] }
  | { kind: 'selected_bodies'; bodyIds: string[] }
  | { kind: 'stock_footprint'; stockId: string }
  | { kind: 'containment'; geometryIds: string[] }
  | { kind: 'whole_target'; geometryIds: string[] }

export type OperationHeightPolicyIntent =
  | { operationType: 'face'; variant: 'target_face' | 'explicit_depth' }
  | { operationType: 'contour_2d'; variant: 'selected_feature' | 'through_stock' | 'stock_bottom' | 'model_bottom' | 'explicit_depth' }
  | { operationType: 'pocket_2d'; variant: 'geometry_floor' | 'stock_rough' | 'through_stock' | 'explicit_depth' }
  | { operationType: 'adaptive_clearing_2d'; variant: 'geometry_floor' | 'stock_rough' | 'through_stock' | 'explicit_depth' }
  | { operationType: 'drill'; variant: 'detected_features' | 'explicit_depth' }
  | { operationType: 'bore'; variant: 'detected_features' | 'explicit_depth' }
  | { operationType: 'thread_mill'; variant:
      | 'internal_top'
      | 'external_top'
      | 'external_base'
      | 'internal_explicit'
      | 'external_top_explicit'
      | 'external_base_explicit' }
  | { operationType: 'engrave'; variant: 'explicit_depth' | 'width_derived' | 'surface_following' }
  | { operationType: 'vcarve'; variant: 'flat_depth' | 'tool_limit' }
  | { operationType: 'chamfer'; variant: 'edge_width_formula' }
  | { operationType: 'pattern'; variant: 'explicit_depth' }
  | { operationType: 'parallel_3d'; variant: 'target_surface' | 'bounded_surface' }
  | { operationType: 'waterline_3d'; variant: 'target_surface' | 'bounded_surface' }
  | { operationType: 'adaptive_3d'; variant: 'initial_stock' | 'current_material' | 'rest' | 'bounded_band' }
  | { operationType: 'scallop_3d'; variant: 'target_surface' | 'bounded_surface' }
  | { operationType: 'steep_shallow_3d'; variant: 'target_surface' | 'bounded_surface' }
  | { operationType: 'pencil_3d'; variant: 'target_surface' | 'bounded_surface' }

export type OperationHeightPolicyIntentFor<T extends OperationType> =
  Extract<OperationHeightPolicyIntent, { operationType: T }>

export type OperationHeightPolicyVariantFor<T extends OperationType> =
  OperationHeightPolicyIntentFor<T>['variant']

export interface StableFeatureReference {
  modelItemId: string
  bodyId: string
  featureKind: string
  stableId: string
  sourceVersion: number
  sourceFingerprint: string
}

export interface FeatureEndpointOverride {
  feature: StableFeatureReference
  /** Exact cutter-center endpoint for this feature. The detected physical
   * floor remains in the proof graph, but strategy allowances are not applied
   * again to an explicit per-feature endpoint. */
  cutterCenterEnd: AuthoredPlaneIntentV2
}

/** The operator's own Top Height (Material Start) and Bottom Height (Target
 * End), typed in the operation's height rows. Either one replaces what the
 * policy variant would resolve for that plane; the variant still supplies
 * scope, evidence and every plane that is not overridden. */
export interface OperatorPlaneOverrides {
  top?: AuthoredPlaneIntentV2
  bottom?: AuthoredPlaneIntentV2
}

export interface OperationHeightIntentV2 {
  version: typeof SMART_HEIGHT_INTENT_VERSION
  policyVersion: typeof SMART_HEIGHT_POLICY_VERSION
  policy: OperationHeightPolicyIntent
  safety: {
    clearance: AuthoredPlaneIntentV2
    retract: AuthoredPlaneIntentV2
    feed: AuthoredPlaneIntentV2
  }
  machining: {
    start: OwnedSmartHeightIntent<MaterialStartIntent>
    end: OwnedSmartHeightIntent<MachiningEndIntent>
    scope: OwnedSmartHeightIntent<MachiningScopeIntent>
  }
  featureOverrides?: FeatureEndpointOverride[]
  planeOverrides?: OperatorPlaneOverrides
}

export type PersistedOperationHeightIntent =
  Extract<PersistedOperationHeightState, { kind: 'smart_v2' }> &
  { intent: OperationHeightIntentV2 }

export interface SmartHeightRevisionStamp {
  projectRevision: string
  setupRevision: string
  operationRevision: string
}

export type SmartHeightEvidenceKind =
  | 'setup_wcs'
  | 'owning_stock'
  | 'initial_stock'
  | 'remaining_material'
  | 'target_model'
  | 'target_surface_field'
  | 'selected_feature'
  | 'selected_plane'
  | 'detected_feature_floor'
  | 'operation_scope'
  | 'tool_geometry'
  | 'strategy_allowance'
  | 'fixture_envelope'

export interface SmartHeightScalarEvidence {
  frame: SmartHeightFrame
  valueMm: number
  /** Machine-coordinate Z of this frame's local zero. Required for
   * geometry-local evidence; ignored for machine/world and checked against the
   * context WCS origin for WCS evidence. */
  frameOriginMachineMm?: number
}

export interface SmartHeightBoundsMm {
  minX: number
  minY: number
  minZ: number
  maxX: number
  maxY: number
  maxZ: number
}

export interface SmartHeightSpatialArtifactRef {
  artifactId: string
  schemaVersion: number
  representation: string
  frame: SmartHeightFrame
  frameOriginMachineMm?: number
  boundsMm: SmartHeightBoundsMm
  fingerprint: string
}

export interface SmartHeightEvidenceNode {
  id: string
  kind: SmartHeightEvidenceKind
  role: SmartHeightEvidenceRole
  entityId: string
  dependencyNodeIds: string[]
  dependencyFingerprint: string
  scalar?: SmartHeightScalarEvidence
  spatial?: SmartHeightSpatialArtifactRef
  feature?: StableFeatureReference
}

export type SmartHeightEvidenceRole =
  | 'wcs_origin'
  | 'stock_top'
  | 'stock_bottom'
  | 'material_top'
  | 'material_artifact'
  | 'target_top'
  | 'target_bottom'
  | 'target_artifact'
  | 'feature_top'
  | 'feature_floor'
  | 'selected_plane'
  | 'scope'
  | 'tool'
  | 'formula_material_start'
  | 'formula_cutter_end'
  | 'cutter_end_allowance'
  | 'fixture_top'
  | 'safety_clearance_min'

export interface HeightEvidenceContext {
  revision: SmartHeightRevisionStamp
  operationType: OperationType
  wcsOriginMachineMm: number
  evidence: SmartHeightEvidenceNode[]
}

export interface ResolvedSmartHeightComponent {
  wcsMm: number
  machineMm: number
  owner: SmartHeightIntentOwner
  proofNodeIds: string[]
}

export interface ResolvedFeatureEndpoint {
  feature: StableFeatureReference
  physicalTarget: ResolvedSmartHeightComponent
  cutterCenterEnd: ResolvedSmartHeightComponent
}

export interface ResolvedHeightPlanV2 {
  version: typeof SMART_HEIGHT_INTENT_VERSION
  policyVersion: typeof SMART_HEIGHT_POLICY_VERSION
  policy: OperationHeightPolicyIntent
  revision: SmartHeightRevisionStamp
  safety: {
    clearance: ResolvedSmartHeightComponent
    retract: ResolvedSmartHeightComponent
    feed: ResolvedSmartHeightComponent
  }
  machining: {
    materialStart: ResolvedSmartHeightComponent
    physicalTarget?: ResolvedSmartHeightComponent
    cutterCenterEnd?: ResolvedSmartHeightComponent
    targetArtifact?: SmartHeightSpatialArtifactRef
    materialArtifact?: SmartHeightSpatialArtifactRef
    featureEndpoints?: ResolvedFeatureEndpoint[]
  }
  evidenceGraph: SmartHeightEvidenceNode[]
  dependencyFingerprints: string[]
  warnings: string[]
}

export type SmartHeightSafetyPlane = Extract<HeightPlaneName, 'clearance' | 'retract' | 'feed'>
