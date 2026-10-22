// WO-3020 (alpha.3 A3-11, parity): the per-operation, per-variant height policy
// registry, copied from src/lib/cam/smartHeights/policies.ts (not edited).
// Parity test: deep-equal to today's registry for every operation type.
import type { OperationType } from '../../types'
import type {
  OperationHeightPolicyVariantFor,
  SmartHeightEvidenceKind,
  SmartHeightSafetyPlane,
} from './contracts'

export type SmartHeightMaterialStartRule =
  | 'current_or_initial_material'
  | 'remaining_material_required'
  | 'selected_feature_top'
  | 'target_model_top'
  | 'geometry_tool_formula'
  | 'explicit_required'
  | 'unsupported'

export type SmartHeightMachiningEndRule =
  | 'selected_target_face'
  | 'selected_plane'
  | 'selected_feature_floor'
  | 'target_surface_in_scope'
  | 'detected_feature_floors'
  | 'thread_band_formula'
  | 'edge_tool_formula'
  | 'engrave_tool_formula'
  | 'vcarve_tool_formula'
  | 'explicit_depth'
  | 'stock_bottom'
  | 'model_bottom'
  | 'through_stock'
  | 'unsupported'

export type SmartHeightScopeRule =
  | 'selected_geometry'
  | 'selected_paths'
  | 'selected_features'
  | 'stock_footprint'
  | 'containment_or_whole_target'
  | 'unsupported'

export type SmartHeightVariantActivation =
  | { status: 'live' }
  | { status: 'provisional'; reason: string }
  | { status: 'unavailable'; reason: string }
  | { status: 'unsupported'; reason: string }

export interface OperationHeightVariantPolicy {
  activation: SmartHeightVariantActivation
  materialStart: SmartHeightMaterialStartRule
  machiningEnd: SmartHeightMachiningEndRule
  scope: SmartHeightScopeRule
  endpointCardinality: 'operation' | 'per_feature' | 'spatial_field' | 'unsupported'
  requiredEvidence: readonly SmartHeightEvidenceKind[]
  missingEvidence: 'refuse' | 'require_explicit_confirmation' | 'unsupported'
  conformanceFixtures: readonly string[]
}

export interface OperationHeightPolicy<T extends OperationType> {
  operationType: T
  support: 'live' | 'unsupported'
  safetyPlanes: readonly SmartHeightSafetyPlane[]
  variants: {
    [V in OperationHeightPolicyVariantFor<T>]: OperationHeightVariantPolicy
  }
}

type OperationHeightVariantRules = Omit<OperationHeightVariantPolicy, 'activation'>

const withActivation = <A extends SmartHeightVariantActivation>(
  policy: OperationHeightVariantRules,
  activation: A,
): OperationHeightVariantPolicy & { activation: A } => ({ ...policy, activation })

/** A provisional variant may continue using its already-implemented V2 path,
 * but it cannot be reported as fully activated until all four proof layers are
 * direct and variant-specific. New variants deliberately default here. */
const variant = (policy: OperationHeightVariantRules) =>
  withActivation(policy, {
    status: 'provisional',
    reason: 'One or more direct runtime, authoring, Properties, or test proofs remain incomplete.',
  })

const liveVariant = (policy: OperationHeightVariantRules) =>
  withActivation(policy, { status: 'live' })

export const OPERATION_HEIGHT_POLICIES = {
  face: {
    operationType: 'face', support: 'live', safetyPlanes: ['clearance', 'retract', 'feed'],
    variants: {
      target_face: variant({ materialStart: 'current_or_initial_material', machiningEnd: 'selected_target_face', scope: 'selected_geometry', endpointCardinality: 'operation', requiredEvidence: ['owning_stock', 'target_model', 'selected_plane', 'operation_scope'], missingEvidence: 'refuse', conformanceFixtures: ['face:target-face'] }),
      explicit_depth: liveVariant({ materialStart: 'current_or_initial_material', machiningEnd: 'explicit_depth', scope: 'stock_footprint', endpointCardinality: 'operation', requiredEvidence: ['owning_stock', 'operation_scope'], missingEvidence: 'require_explicit_confirmation', conformanceFixtures: ['face:explicit-depth'] }),
    },
  },
  contour_2d: {
    operationType: 'contour_2d', support: 'live', safetyPlanes: ['clearance', 'retract', 'feed'],
    variants: {
      selected_feature: variant({ materialStart: 'current_or_initial_material', machiningEnd: 'detected_feature_floors', scope: 'selected_features', endpointCardinality: 'per_feature', requiredEvidence: ['owning_stock', 'selected_feature', 'operation_scope'], missingEvidence: 'refuse', conformanceFixtures: ['contour:selected-feature'] }),
      through_stock: variant({ materialStart: 'current_or_initial_material', machiningEnd: 'through_stock', scope: 'selected_geometry', endpointCardinality: 'operation', requiredEvidence: ['owning_stock', 'operation_scope'], missingEvidence: 'refuse', conformanceFixtures: ['contour:through-stock'] }),
      stock_bottom: variant({ materialStart: 'current_or_initial_material', machiningEnd: 'stock_bottom', scope: 'selected_geometry', endpointCardinality: 'operation', requiredEvidence: ['owning_stock', 'operation_scope'], missingEvidence: 'refuse', conformanceFixtures: ['contour:stock-bottom'] }),
      model_bottom: variant({ materialStart: 'current_or_initial_material', machiningEnd: 'model_bottom', scope: 'selected_geometry', endpointCardinality: 'operation', requiredEvidence: ['owning_stock', 'target_model', 'operation_scope'], missingEvidence: 'refuse', conformanceFixtures: ['contour:model-bottom'] }),
      explicit_depth: variant({ materialStart: 'explicit_required', machiningEnd: 'explicit_depth', scope: 'selected_geometry', endpointCardinality: 'operation', requiredEvidence: ['operation_scope'], missingEvidence: 'require_explicit_confirmation', conformanceFixtures: ['contour:flat-explicit-depth'] }),
    },
  },
  pocket_2d: {
    operationType: 'pocket_2d', support: 'live', safetyPlanes: ['clearance', 'retract', 'feed'],
    variants: {
      geometry_floor: liveVariant({ materialStart: 'current_or_initial_material', machiningEnd: 'selected_plane', scope: 'selected_geometry', endpointCardinality: 'operation', requiredEvidence: ['owning_stock', 'target_model', 'selected_plane', 'operation_scope'], missingEvidence: 'refuse', conformanceFixtures: ['pocket:geometry-floor'] }),
      stock_rough: liveVariant({ materialStart: 'current_or_initial_material', machiningEnd: 'target_surface_in_scope', scope: 'stock_footprint', endpointCardinality: 'spatial_field', requiredEvidence: ['owning_stock', 'target_model', 'target_surface_field', 'operation_scope'], missingEvidence: 'refuse', conformanceFixtures: ['pocket:stock-rough'] }),
      through_stock: liveVariant({ materialStart: 'current_or_initial_material', machiningEnd: 'through_stock', scope: 'selected_geometry', endpointCardinality: 'operation', requiredEvidence: ['owning_stock', 'operation_scope'], missingEvidence: 'refuse', conformanceFixtures: ['pocket:through-stock'] }),
      explicit_depth: liveVariant({ materialStart: 'current_or_initial_material', machiningEnd: 'explicit_depth', scope: 'selected_geometry', endpointCardinality: 'operation', requiredEvidence: ['owning_stock', 'operation_scope'], missingEvidence: 'require_explicit_confirmation', conformanceFixtures: ['pocket:flat-explicit-depth'] }),
    },
  },
  adaptive_clearing_2d: {
    operationType: 'adaptive_clearing_2d', support: 'live', safetyPlanes: ['clearance', 'retract', 'feed'],
    variants: {
      geometry_floor: liveVariant({ materialStart: 'current_or_initial_material', machiningEnd: 'selected_plane', scope: 'selected_geometry', endpointCardinality: 'operation', requiredEvidence: ['owning_stock', 'target_model', 'selected_plane', 'operation_scope'], missingEvidence: 'refuse', conformanceFixtures: ['adaptive2d:geometry-floor'] }),
      stock_rough: liveVariant({ materialStart: 'current_or_initial_material', machiningEnd: 'target_surface_in_scope', scope: 'stock_footprint', endpointCardinality: 'spatial_field', requiredEvidence: ['owning_stock', 'target_model', 'target_surface_field', 'operation_scope'], missingEvidence: 'refuse', conformanceFixtures: ['adaptive2d:stock-rough'] }),
      through_stock: liveVariant({ materialStart: 'current_or_initial_material', machiningEnd: 'through_stock', scope: 'selected_geometry', endpointCardinality: 'operation', requiredEvidence: ['owning_stock', 'operation_scope'], missingEvidence: 'refuse', conformanceFixtures: ['adaptive2d:through-stock'] }),
      explicit_depth: liveVariant({ materialStart: 'current_or_initial_material', machiningEnd: 'explicit_depth', scope: 'selected_geometry', endpointCardinality: 'operation', requiredEvidence: ['owning_stock', 'operation_scope'], missingEvidence: 'require_explicit_confirmation', conformanceFixtures: ['adaptive2d:flat-explicit-depth'] }),
    },
  },
  drill: {
    operationType: 'drill', support: 'live', safetyPlanes: ['clearance', 'retract', 'feed'],
    variants: {
      detected_features: variant({ materialStart: 'current_or_initial_material', machiningEnd: 'detected_feature_floors', scope: 'selected_features', endpointCardinality: 'per_feature', requiredEvidence: ['owning_stock', 'detected_feature_floor', 'operation_scope', 'tool_geometry'], missingEvidence: 'refuse', conformanceFixtures: ['drill:detected-mixed-depths'] }),
      explicit_depth: variant({ materialStart: 'explicit_required', machiningEnd: 'explicit_depth', scope: 'selected_geometry', endpointCardinality: 'operation', requiredEvidence: ['operation_scope', 'tool_geometry'], missingEvidence: 'require_explicit_confirmation', conformanceFixtures: ['drill:plain-circle-explicit-depth'] }),
    },
  },
  bore: {
    operationType: 'bore', support: 'live', safetyPlanes: ['clearance', 'retract', 'feed'],
    variants: {
      detected_features: variant({ materialStart: 'current_or_initial_material', machiningEnd: 'detected_feature_floors', scope: 'selected_features', endpointCardinality: 'per_feature', requiredEvidence: ['owning_stock', 'detected_feature_floor', 'operation_scope', 'tool_geometry'], missingEvidence: 'refuse', conformanceFixtures: ['bore:detected-mixed-depths'] }),
      explicit_depth: variant({ materialStart: 'explicit_required', machiningEnd: 'explicit_depth', scope: 'selected_geometry', endpointCardinality: 'operation', requiredEvidence: ['operation_scope', 'tool_geometry'], missingEvidence: 'require_explicit_confirmation', conformanceFixtures: ['bore:plain-circle-explicit-depth'] }),
    },
  },
  thread_mill: {
    operationType: 'thread_mill', support: 'live', safetyPlanes: ['clearance', 'retract', 'feed'],
    variants: {
      internal_top: variant({ materialStart: 'geometry_tool_formula', machiningEnd: 'thread_band_formula', scope: 'selected_features', endpointCardinality: 'operation', requiredEvidence: ['selected_feature', 'tool_geometry', 'strategy_allowance', 'operation_scope'], missingEvidence: 'refuse', conformanceFixtures: ['thread:internal-top'] }),
      external_top: variant({ materialStart: 'geometry_tool_formula', machiningEnd: 'thread_band_formula', scope: 'selected_features', endpointCardinality: 'operation', requiredEvidence: ['selected_feature', 'tool_geometry', 'strategy_allowance', 'operation_scope'], missingEvidence: 'refuse', conformanceFixtures: ['thread:external-top'] }),
      external_base: variant({ materialStart: 'geometry_tool_formula', machiningEnd: 'thread_band_formula', scope: 'selected_features', endpointCardinality: 'operation', requiredEvidence: ['selected_feature', 'tool_geometry', 'strategy_allowance', 'operation_scope'], missingEvidence: 'refuse', conformanceFixtures: ['thread:external-base'] }),
      internal_explicit: variant({ materialStart: 'geometry_tool_formula', machiningEnd: 'thread_band_formula', scope: 'selected_geometry', endpointCardinality: 'operation', requiredEvidence: ['selected_plane', 'tool_geometry', 'strategy_allowance', 'operation_scope'], missingEvidence: 'require_explicit_confirmation', conformanceFixtures: ['thread:internal-explicit'] }),
      external_top_explicit: variant({ materialStart: 'geometry_tool_formula', machiningEnd: 'thread_band_formula', scope: 'selected_geometry', endpointCardinality: 'operation', requiredEvidence: ['selected_plane', 'tool_geometry', 'strategy_allowance', 'operation_scope'], missingEvidence: 'require_explicit_confirmation', conformanceFixtures: ['thread:external-top-explicit'] }),
      external_base_explicit: variant({ materialStart: 'geometry_tool_formula', machiningEnd: 'thread_band_formula', scope: 'selected_geometry', endpointCardinality: 'operation', requiredEvidence: ['selected_plane', 'tool_geometry', 'strategy_allowance', 'operation_scope'], missingEvidence: 'require_explicit_confirmation', conformanceFixtures: ['thread:external-base-explicit'] }),
    },
  },
  engrave: {
    operationType: 'engrave', support: 'live', safetyPlanes: ['clearance', 'retract', 'feed'],
    variants: {
      explicit_depth: variant({ materialStart: 'geometry_tool_formula', machiningEnd: 'engrave_tool_formula', scope: 'selected_paths', endpointCardinality: 'operation', requiredEvidence: ['selected_plane', 'tool_geometry', 'strategy_allowance', 'operation_scope'], missingEvidence: 'require_explicit_confirmation', conformanceFixtures: ['engrave:explicit-depth'] }),
      width_derived: variant({ materialStart: 'geometry_tool_formula', machiningEnd: 'engrave_tool_formula', scope: 'selected_paths', endpointCardinality: 'operation', requiredEvidence: ['selected_plane', 'tool_geometry', 'strategy_allowance', 'operation_scope'], missingEvidence: 'refuse', conformanceFixtures: ['engrave:width-derived'] }),
      // WO-1969: the same path-depth formula, measured down from the part's
      // surface sampled under the paths instead of from one datum plane.
      surface_following: variant({ materialStart: 'geometry_tool_formula', machiningEnd: 'engrave_tool_formula', scope: 'selected_paths', endpointCardinality: 'spatial_field', requiredEvidence: ['target_surface_field', 'tool_geometry', 'strategy_allowance', 'operation_scope'], missingEvidence: 'refuse', conformanceFixtures: ['engrave:surface-following'] }),
    },
  },
  vcarve: {
    operationType: 'vcarve', support: 'live', safetyPlanes: ['clearance', 'retract', 'feed'],
    variants: {
      flat_depth: variant({ materialStart: 'geometry_tool_formula', machiningEnd: 'vcarve_tool_formula', scope: 'selected_paths', endpointCardinality: 'operation', requiredEvidence: ['selected_plane', 'tool_geometry', 'strategy_allowance', 'operation_scope'], missingEvidence: 'refuse', conformanceFixtures: ['vcarve:flat-depth'] }),
      tool_limit: variant({ materialStart: 'geometry_tool_formula', machiningEnd: 'vcarve_tool_formula', scope: 'selected_paths', endpointCardinality: 'operation', requiredEvidence: ['selected_plane', 'tool_geometry', 'strategy_allowance', 'operation_scope'], missingEvidence: 'refuse', conformanceFixtures: ['vcarve:tool-limit'] }),
    },
  },
  chamfer: {
    operationType: 'chamfer', support: 'live', safetyPlanes: ['clearance', 'retract', 'feed'],
    variants: {
      edge_width_formula: variant({ materialStart: 'geometry_tool_formula', machiningEnd: 'edge_tool_formula', scope: 'selected_features', endpointCardinality: 'operation', requiredEvidence: ['selected_feature', 'selected_plane', 'tool_geometry', 'strategy_allowance', 'operation_scope'], missingEvidence: 'refuse', conformanceFixtures: ['chamfer:edge-width-formula'] }),
    },
  },
  // WO-3001: a pattern starts at the current (or initial) stock top and ends
  // the explicit depth below it the operation states; the pattern spec's own
  // depth is measured down from the same Material Start.
  pattern: {
    operationType: 'pattern', support: 'live', safetyPlanes: ['clearance', 'retract', 'feed'],
    variants: {
      explicit_depth: variant({ materialStart: 'current_or_initial_material', machiningEnd: 'explicit_depth', scope: 'stock_footprint', endpointCardinality: 'operation', requiredEvidence: ['owning_stock', 'operation_scope'], missingEvidence: 'require_explicit_confirmation', conformanceFixtures: ['pattern:explicit-depth'] }),
    },
  },
  parallel_3d: {
    operationType: 'parallel_3d', support: 'live', safetyPlanes: ['clearance', 'retract', 'feed'],
    variants: {
      target_surface: variant({ materialStart: 'target_model_top', machiningEnd: 'target_surface_in_scope', scope: 'containment_or_whole_target', endpointCardinality: 'spatial_field', requiredEvidence: ['target_model', 'target_surface_field', 'operation_scope'], missingEvidence: 'refuse', conformanceFixtures: ['parallel3d:target-surface'] }),
      bounded_surface: variant({ materialStart: 'target_model_top', machiningEnd: 'target_surface_in_scope', scope: 'containment_or_whole_target', endpointCardinality: 'spatial_field', requiredEvidence: ['target_model', 'target_surface_field', 'operation_scope'], missingEvidence: 'refuse', conformanceFixtures: ['parallel3d:bounded-surface'] }),
    },
  },
  waterline_3d: {
    operationType: 'waterline_3d', support: 'live', safetyPlanes: ['clearance', 'retract', 'feed'],
    variants: {
      target_surface: variant({ materialStart: 'target_model_top', machiningEnd: 'target_surface_in_scope', scope: 'containment_or_whole_target', endpointCardinality: 'spatial_field', requiredEvidence: ['target_model', 'target_surface_field', 'operation_scope'], missingEvidence: 'refuse', conformanceFixtures: ['waterline3d:target-surface'] }),
      bounded_surface: variant({ materialStart: 'target_model_top', machiningEnd: 'target_surface_in_scope', scope: 'containment_or_whole_target', endpointCardinality: 'spatial_field', requiredEvidence: ['target_model', 'target_surface_field', 'operation_scope'], missingEvidence: 'refuse', conformanceFixtures: ['waterline3d:bounded-surface'] }),
    },
  },
  adaptive_3d: {
    operationType: 'adaptive_3d', support: 'live', safetyPlanes: ['clearance', 'retract', 'feed'],
    variants: {
      initial_stock: variant({ materialStart: 'current_or_initial_material', machiningEnd: 'target_surface_in_scope', scope: 'containment_or_whole_target', endpointCardinality: 'spatial_field', requiredEvidence: ['owning_stock', 'initial_stock', 'target_model', 'target_surface_field', 'operation_scope', 'tool_geometry'], missingEvidence: 'refuse', conformanceFixtures: ['adaptive3d:initial-stock-target'] }),
      current_material: variant({ materialStart: 'current_or_initial_material', machiningEnd: 'target_surface_in_scope', scope: 'containment_or_whole_target', endpointCardinality: 'spatial_field', requiredEvidence: ['owning_stock', 'target_model', 'target_surface_field', 'operation_scope', 'tool_geometry'], missingEvidence: 'refuse', conformanceFixtures: ['adaptive3d:current-material-target'] }),
      rest: variant({ materialStart: 'remaining_material_required', machiningEnd: 'target_surface_in_scope', scope: 'containment_or_whole_target', endpointCardinality: 'spatial_field', requiredEvidence: ['owning_stock', 'remaining_material', 'target_model', 'target_surface_field', 'operation_scope', 'tool_geometry'], missingEvidence: 'refuse', conformanceFixtures: ['adaptive3d:rest-material-required'] }),
      bounded_band: variant({ materialStart: 'explicit_required', machiningEnd: 'explicit_depth', scope: 'containment_or_whole_target', endpointCardinality: 'spatial_field', requiredEvidence: ['owning_stock', 'target_model', 'target_surface_field', 'operation_scope', 'tool_geometry'], missingEvidence: 'refuse', conformanceFixtures: ['adaptive3d:explicit-bounded-band'] }),
    },
  },
  scallop_3d: {
    operationType: 'scallop_3d', support: 'live', safetyPlanes: ['clearance', 'retract', 'feed'],
    variants: {
      target_surface: variant({ materialStart: 'target_model_top', machiningEnd: 'target_surface_in_scope', scope: 'containment_or_whole_target', endpointCardinality: 'spatial_field', requiredEvidence: ['target_model', 'target_surface_field', 'operation_scope'], missingEvidence: 'refuse', conformanceFixtures: ['scallop3d:target-surface'] }),
      bounded_surface: variant({ materialStart: 'target_model_top', machiningEnd: 'target_surface_in_scope', scope: 'containment_or_whole_target', endpointCardinality: 'spatial_field', requiredEvidence: ['target_model', 'target_surface_field', 'operation_scope'], missingEvidence: 'refuse', conformanceFixtures: ['scallop3d:bounded-surface'] }),
    },
  },
  steep_shallow_3d: {
    operationType: 'steep_shallow_3d', support: 'live', safetyPlanes: ['clearance', 'retract', 'feed'],
    variants: {
      target_surface: variant({ materialStart: 'target_model_top', machiningEnd: 'target_surface_in_scope', scope: 'containment_or_whole_target', endpointCardinality: 'spatial_field', requiredEvidence: ['target_model', 'target_surface_field', 'operation_scope'], missingEvidence: 'refuse', conformanceFixtures: ['steepShallow3d:target-surface'] }),
      bounded_surface: variant({ materialStart: 'target_model_top', machiningEnd: 'target_surface_in_scope', scope: 'containment_or_whole_target', endpointCardinality: 'spatial_field', requiredEvidence: ['target_model', 'target_surface_field', 'operation_scope'], missingEvidence: 'refuse', conformanceFixtures: ['steepShallow3d:bounded-surface'] }),
    },
  },
  pencil_3d: {
    operationType: 'pencil_3d', support: 'live', safetyPlanes: ['clearance', 'retract', 'feed'],
    variants: {
      target_surface: variant({ materialStart: 'target_model_top', machiningEnd: 'target_surface_in_scope', scope: 'containment_or_whole_target', endpointCardinality: 'spatial_field', requiredEvidence: ['target_model', 'target_surface_field', 'operation_scope'], missingEvidence: 'refuse', conformanceFixtures: ['pencil3d:target-surface'] }),
      bounded_surface: variant({ materialStart: 'target_model_top', machiningEnd: 'target_surface_in_scope', scope: 'containment_or_whole_target', endpointCardinality: 'spatial_field', requiredEvidence: ['target_model', 'target_surface_field', 'operation_scope'], missingEvidence: 'refuse', conformanceFixtures: ['pencil3d:bounded-surface'] }),
    },
  },
} as const satisfies {
  [T in OperationType]: OperationHeightPolicy<T>
}

export function operationHeightPolicy<T extends OperationType>(
  operationType: T,
): (typeof OPERATION_HEIGHT_POLICIES)[T] {
  return OPERATION_HEIGHT_POLICIES[operationType]
}

export interface SmartHeightRuntimeConformanceEntry {
  operationType: OperationType
  variant: string
  fixtureId: string
  activation: SmartHeightVariantActivation['status']
}

/** Runtime-readable manifest used by the architecture gate. A future policy
 * variant cannot exist only in a UI switch: every declared fixture is routed
 * through the resolver contract now, then promoted to family parity coverage
 * when that family takes V2 authority. */
export const SMART_HEIGHT_RUNTIME_CONFORMANCE_MANIFEST: readonly SmartHeightRuntimeConformanceEntry[] =
  Object.values(OPERATION_HEIGHT_POLICIES).flatMap(policy =>
    Object.entries(policy.variants).flatMap(([variantName, variantPolicy]) =>
      variantPolicy.conformanceFixtures.map((fixtureId: string) => ({
        operationType: policy.operationType,
        variant: variantName,
        fixtureId,
        activation: variantPolicy.activation.status,
      })),
    ),
  )
