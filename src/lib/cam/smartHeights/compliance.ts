import type { OperationType } from '../../../types'
import {
  OPERATION_HEIGHT_POLICIES,
  type SmartHeightVariantActivation,
} from './policies'

export interface SmartHeightActivationProof {
  contractTest: string
  runtimeTest: string
  authoringTest: string
  propertiesTest: string
}

type PolicyVariants<T extends OperationType> =
  (typeof OPERATION_HEIGHT_POLICIES)[T]['variants']

type VariantName<T extends OperationType> = Extract<keyof PolicyVariants<T>, string>

type LiveVariantName<T extends OperationType> = {
  [V in VariantName<T>]: PolicyVariants<T>[V] extends {
    activation: { status: 'live' }
  } ? V : never
}[VariantName<T>]

type LiveVariantProofRegistry = {
  [T in OperationType]: {
    [V in LiveVariantName<T>]: SmartHeightActivationProof
  }
}

/** Compile-time activation boundary. Changing a policy variant to `live`
 * changes this mapped type and forces all four direct proof paths to be named
 * before the project builds. Provisional, frozen, unavailable, and unsupported
 * variants cannot borrow a sibling variant's proof. */
export const SMART_HEIGHT_LIVE_VARIANT_PROOFS = {
  face: {
    explicit_depth: {
      contractTest: 'src/tests/cam/smartHeightFace.phase4.test.ts',
      runtimeTest: 'src/tests/store/smartHeightFaceStore.phase4.test.ts',
      authoringTest: 'src/tests/components/FaceSmartHeightOperationUI.smoke.test.tsx',
      propertiesTest: 'src/tests/components/FaceSmartHeightOperationUI.smoke.test.tsx',
    },
  },
  contour_2d: {},
  pocket_2d: {
    explicit_depth: {
      contractTest: 'src/tests/cam/smartHeightPlanarRough.phase4.test.ts',
      runtimeTest: 'src/tests/store/smartHeightPlanarRoughStore.phase5.test.ts',
      authoringTest: 'src/tests/components/PlanarRoughSmartHeightOperationUI.phase5.test.tsx',
      propertiesTest: 'src/tests/components/PropertiesPanelPlanarRoughSmartHeight.phase6.test.tsx',
    },
    geometry_floor: {
      contractTest: 'src/tests/cam/smartHeightPlanarRough.phase4.test.ts',
      runtimeTest: 'src/tests/store/smartHeightPlanarRoughStore.phase5.test.ts',
      authoringTest: 'src/tests/components/PlanarRoughSmartHeightOperationUI.phase5.test.tsx',
      propertiesTest: 'src/tests/components/PropertiesPanelPlanarRoughSmartHeight.phase6.test.tsx',
    },
    stock_rough: {
      contractTest: 'src/tests/cam/smartHeightPlanarRough.phase4.test.ts',
      runtimeTest: 'src/tests/store/smartHeightPlanarRoughStore.phase5.test.ts',
      authoringTest: 'src/tests/components/PlanarRoughSmartHeightOperationUI.phase5.test.tsx',
      propertiesTest: 'src/tests/components/PropertiesPanelPlanarRoughSmartHeight.phase6.test.tsx',
    },
    through_stock: {
      contractTest: 'src/tests/cam/smartHeightPlanarRough.phase4.test.ts',
      runtimeTest: 'src/tests/store/smartHeightPlanarRoughStore.phase5.test.ts',
      authoringTest: 'src/tests/components/PlanarRoughSmartHeightOperationUI.phase5.test.tsx',
      propertiesTest: 'src/tests/components/PropertiesPanelPlanarRoughSmartHeight.phase6.test.tsx',
    },
  },
  adaptive_clearing_2d: {
    explicit_depth: {
      contractTest: 'src/tests/cam/smartHeightPlanarRough.phase4.test.ts',
      runtimeTest: 'src/tests/store/smartHeightPlanarRoughStore.phase5.test.ts',
      authoringTest: 'src/tests/components/PlanarRoughSmartHeightOperationUI.phase5.test.tsx',
      propertiesTest: 'src/tests/components/PropertiesPanelPlanarRoughSmartHeight.phase6.test.tsx',
    },
    geometry_floor: {
      contractTest: 'src/tests/cam/smartHeightPlanarRough.phase4.test.ts',
      runtimeTest: 'src/tests/store/smartHeightPlanarRoughStore.phase5.test.ts',
      authoringTest: 'src/tests/components/PlanarRoughSmartHeightOperationUI.phase5.test.tsx',
      propertiesTest: 'src/tests/components/PropertiesPanelPlanarRoughSmartHeight.phase6.test.tsx',
    },
    stock_rough: {
      contractTest: 'src/tests/cam/smartHeightPlanarRough.phase4.test.ts',
      runtimeTest: 'src/tests/store/smartHeightPlanarRoughStore.phase5.test.ts',
      authoringTest: 'src/tests/components/PlanarRoughSmartHeightOperationUI.phase5.test.tsx',
      propertiesTest: 'src/tests/components/PropertiesPanelPlanarRoughSmartHeight.phase6.test.tsx',
    },
    through_stock: {
      contractTest: 'src/tests/cam/smartHeightPlanarRough.phase4.test.ts',
      runtimeTest: 'src/tests/store/smartHeightPlanarRoughStore.phase5.test.ts',
      authoringTest: 'src/tests/components/PlanarRoughSmartHeightOperationUI.phase5.test.tsx',
      propertiesTest: 'src/tests/components/PropertiesPanelPlanarRoughSmartHeight.phase6.test.tsx',
    },
  },
  drill: {},
  bore: {},
  thread_mill: {},
  engrave: {},
  vcarve: {},
  chamfer: {},
  pattern: {},
  parallel_3d: {},
  waterline_3d: {},
  adaptive_3d: {},
  scallop_3d: {},
  steep_shallow_3d: {},
  pencil_3d: {
    target_surface: {
      contractTest: 'src/tests/cam/smartHeightPolicyRegistry.test.ts',
      runtimeTest: 'src/tests/store/smartHeightExactPreviewDispatch.v2.test.ts',
      authoringTest: 'src/tests/components/uiClutterCensus.wo1182.test.tsx',
      propertiesTest: 'src/tests/components/uiClutterCensus.wo1182.test.tsx',
    },
    bounded_surface: {
      contractTest: 'src/tests/cam/smartHeightPolicyRegistry.test.ts',
      runtimeTest: 'src/tests/store/smartHeightExactPreviewDispatch.v2.test.ts',
      authoringTest: 'src/tests/components/uiClutterCensus.wo1182.test.tsx',
      propertiesTest: 'src/tests/components/uiClutterCensus.wo1182.test.tsx',
    },
  },
} as const satisfies LiveVariantProofRegistry

export interface SmartHeightVariantActivationGate {
  operationType: OperationType
  variant: string
  activation: SmartHeightVariantActivation
  proof?: SmartHeightActivationProof
}

const proofRegistry = SMART_HEIGHT_LIVE_VARIANT_PROOFS as Record<
  string,
  Record<string, SmartHeightActivationProof>
>

/** Runtime-readable, exhaustive variant gate. This is the source used by
 * tests, diagnostics, and future-operation conformance checks. */
export const SMART_HEIGHT_VARIANT_ACTIVATION_GATES: readonly SmartHeightVariantActivationGate[] =
  Object.values(OPERATION_HEIGHT_POLICIES).flatMap(policy =>
    Object.entries(policy.variants).map(([variant, variantPolicy]) => ({
      operationType: policy.operationType,
      variant,
      activation: variantPolicy.activation,
      ...(variantPolicy.activation.status === 'live'
        ? { proof: proofRegistry[policy.operationType]?.[variant] }
        : {}),
    })),
  )

export interface SmartHeightFamilyActivationSummary {
  operationType: OperationType
  status: 'live' | 'partial' | 'unsupported'
  reason?: string
}

/** Compatibility summary for callers that need a family badge. A family is
 * `live` only when every declared variant is live; a family with any
 * provisional/frozen/unavailable variant is explicitly partial. */
export const SMART_HEIGHT_FAMILY_ACTIVATION_GATES = Object.fromEntries(
  Object.values(OPERATION_HEIGHT_POLICIES).map(policy => {
    const variants = Object.entries(policy.variants)
    const incomplete = variants
      .filter(([, variant]) => variant.activation.status !== 'live')
      .map(([name, variant]) => `${name}:${variant.activation.status}`)
    return [policy.operationType, {
      operationType: policy.operationType,
      status: incomplete.length === 0 ? 'live' : 'partial',
      ...(incomplete.length > 0
        ? { reason: `Incomplete variants: ${incomplete.join(', ')}.` }
        : {}),
    } satisfies SmartHeightFamilyActivationSummary]
  }),
) as Record<OperationType, SmartHeightFamilyActivationSummary>
