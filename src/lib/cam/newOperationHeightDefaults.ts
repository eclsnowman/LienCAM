import type {
  HeightIntentV1,
  HeightParams,
  HeightPlaneName,
  HeightReference,
  HeightValueIntent,
  OperationType,
} from '../../types'
import type { ChamferHeightReference } from './types'

const HEIGHT_PLANES: readonly HeightPlaneName[] = [
  'clearance', 'retract', 'feed', 'top', 'bottom',
]

type ExternalHeightReference = Exclude<HeightReference, HeightPlaneName>

export type OperationHeightInference = 'setup' | 'stock' | 'geometry' | 'fallback'

export interface OperationHeightEndpointEvidence {
  reference: ChamferHeightReference
  offset: number
  source: 'stock' | 'geometry'
}

export interface OperationHeightEvidence {
  top?: OperationHeightEndpointEvidence
  bottom?: OperationHeightEndpointEvidence
  /** A picked cylinder is the one allowed automatic refinement of thread length. */
  cylinderDepth?: number
}

export interface DeriveOperationHeightDraftInput {
  operationType: OperationType
  setupIntent: HeightIntentV1
  currentParams: Readonly<Record<string, unknown>>
  evidence?: OperationHeightEvidence
}

export interface OperationHeightDraft {
  heights: HeightParams
  paramsPatch: Record<string, unknown>
  inference: OperationHeightInference
}

interface FlattenedEndpoint {
  reference: ExternalHeightReference
  offset: number
}

function cloneIntent(intent: HeightIntentV1): HeightIntentV1 {
  return {
    version: 1,
    clearance: { ...intent.clearance },
    retract: { ...intent.retract },
    feed: { ...intent.feed },
    top: { ...intent.top },
    bottom: { ...intent.bottom },
  }
}

/** Collapse only symbolic plane-to-plane links. External planes remain symbolic,
 * so top=stock_top+0, bottom=top-8 becomes stock_top/-8 rather than a fake WCS
 * absolute produced by resolving stock_top against zero. */
export function flattenHeightIntentEndpoint(
  intent: HeightIntentV1,
  endpoint: HeightPlaneName,
): FlattenedEndpoint {
  const visiting = new Set<HeightPlaneName>()
  const walk = (plane: HeightPlaneName): FlattenedEndpoint => {
    if (visiting.has(plane)) throw new Error(`Height reference cycle includes '${plane}'`)
    visiting.add(plane)
    const authored = intent[plane]
    if (!Number.isFinite(authored.offset)) throw new Error(`${plane} offset must be finite`)
    if (!HEIGHT_PLANES.includes(authored.reference as HeightPlaneName)) {
      visiting.delete(plane)
      return {
        reference: authored.reference as ExternalHeightReference,
        offset: authored.offset,
      }
    }
    const parent = walk(authored.reference as HeightPlaneName)
    visiting.delete(plane)
    return { reference: parent.reference, offset: parent.offset + authored.offset }
  }
  return walk(endpoint)
}

function topMode(reference: ExternalHeightReference): HeightParams['topHeightMode'] {
  if (reference === 'stock_top') return 'stock_top'
  if (reference === 'model_top') return 'model_top'
  if (reference === 'selected_feature_top' || reference === 'picked_surface') return 'selected_face'
  return 'absolute'
}

function bottomMode(reference: ExternalHeightReference): HeightParams['bottomHeightMode'] {
  if (reference === 'model_bottom') return 'model_bottom'
  if (reference === 'selected_feature_bottom' || reference === 'picked_surface') return 'selected_face'
  return 'absolute'
}

/** Legacy numeric mirrors for a Setup intent. Values are offsets in one
 * reference-zero frame; the semantic intent remains attached and authoritative. */
export function projectSetupHeightParams(intent: HeightIntentV1): HeightParams {
  const authored = cloneIntent(intent)
  const clearance = flattenHeightIntentEndpoint(authored, 'clearance')
  const retract = flattenHeightIntentEndpoint(authored, 'retract')
  const feed = flattenHeightIntentEndpoint(authored, 'feed')
  const top = flattenHeightIntentEndpoint(authored, 'top')
  const bottom = flattenHeightIntentEndpoint(authored, 'bottom')
  return {
    clearanceHeight: clearance.offset,
    clearanceHeightMode: 'absolute',
    retractHeight: retract.offset,
    feedHeight: feed.offset,
    topHeight: top.offset,
    topHeightMode: topMode(top.reference),
    bottomHeight: bottom.offset,
    bottomHeightMode: bottomMode(bottom.reference),
    heightIntent: authored,
  }
}

function toFamilyReference(reference: ExternalHeightReference): ChamferHeightReference | undefined {
  switch (reference) {
    case 'stock_top': return 'stock_top'
    case 'stock_bottom': return 'stock_bottom'
    case 'model_top': return 'model_top'
    case 'geometry_plane': return 'geometry_face'
    case 'selected_feature_top':
    case 'selected_feature_bottom': return 'selected_face'
    case 'picked_surface': return 'picked_plane'
    case 'wcs_plane': return 'wcs_plane'
    case 'machine_plane': return 'machine_floor'
    case 'model_bottom':
    case 'remaining_stock': return undefined
  }
}

function toIntentReference(
  endpoint: 'top' | 'bottom',
  reference: ChamferHeightReference,
): ExternalHeightReference {
  switch (reference) {
    case 'geometry_face': return 'geometry_plane'
    case 'selected_face': return endpoint === 'top' ? 'selected_feature_top' : 'selected_feature_bottom'
    case 'picked_plane': return 'picked_surface'
    case 'machine_floor': return 'machine_plane'
    case 'absolute':
    case 'wcs_plane': return 'wcs_plane'
    default: return reference
  }
}

function evidenceValue(
  endpoint: 'top' | 'bottom',
  evidence: OperationHeightEndpointEvidence,
): HeightValueIntent {
  return {
    reference: toIntentReference(endpoint, evidence.reference),
    offset: evidence.offset,
    provenance: 'inferred',
  }
}

function endpointPatch(endpoint: FlattenedEndpoint): Record<string, unknown> | undefined {
  const reference = toFamilyReference(endpoint.reference)
  return reference ? { heightReference: reference, planeOffset: endpoint.offset } : undefined
}

type EndpointUse = 'top' | 'bottom' | 'mesh' | 'special'

function endpointUse(
  operationType: OperationType,
  currentParams: Readonly<Record<string, unknown>>,
): EndpointUse {
  switch (operationType) {
    case 'contour_2d':
    case 'pocket_2d':
    case 'adaptive_clearing_2d':
    case 'drill':
    case 'bore': return 'bottom'
    case 'face':
    case 'pattern': return 'top'
    case 'engrave': return currentParams.useWidthForDepth === true ? 'special' : 'top'
    case 'parallel_3d':
    case 'waterline_3d':
    case 'adaptive_3d':
    case 'scallop_3d':
    case 'steep_shallow_3d':
    case 'pencil_3d': return 'mesh'
    case 'thread_mill':
    case 'chamfer':
    case 'vcarve': return 'special'
  }
}

/** Build the two synchronized representations consumed by operation dispatch.
 * This is intentionally a draft/reset projection only; callers must not apply it
 * while loading an existing operation. */
export function deriveOperationHeightDraft({
  operationType,
  setupIntent,
  currentParams,
  evidence,
}: DeriveOperationHeightDraftInput): OperationHeightDraft {
  const use = endpointUse(operationType, currentParams)
  const intent = cloneIntent(setupIntent)
  let inference: OperationHeightInference = use === 'mesh' ? 'geometry' : 'setup'
  let appliedEvidence: OperationHeightEndpointEvidence | undefined

  if (use === 'top' && evidence?.top) {
    intent.top = evidenceValue('top', evidence.top)
    appliedEvidence = evidence.top
  } else if (use === 'bottom' && evidence?.bottom) {
    intent.bottom = evidenceValue('bottom', evidence.bottom)
    appliedEvidence = evidence.bottom
  } else if ((operationType === 'chamfer' || operationType === 'vcarve') && evidence?.top) {
    intent.top = evidenceValue('top', evidence.top)
    appliedEvidence = evidence.top
  }
  if (appliedEvidence) inference = appliedEvidence.source

  const heights = projectSetupHeightParams(intent)
  let paramsPatch: Record<string, unknown> = {}
  const patchEndpoint = use === 'top' || use === 'bottom'
    ? use
    : ((operationType === 'chamfer' || operationType === 'vcarve') && appliedEvidence ? 'top' : undefined)
  if (patchEndpoint) {
    const patch = endpointPatch(flattenHeightIntentEndpoint(intent, patchEndpoint))
    if (patch) paramsPatch = patch
    else inference = 'fallback'
  }

  if (operationType === 'thread_mill' && evidence?.cylinderDepth !== undefined) {
    if (Number.isFinite(evidence.cylinderDepth) && evidence.cylinderDepth > 0) {
      paramsPatch = { ...paramsPatch, threadDepth: evidence.cylinderDepth }
      inference = 'geometry'
    }
  }

  return {
    heights,
    paramsPatch,
    inference,
  }
}

/** The operation types that author a "live" starting height policy: every
 *  OperationType member today (selectStartingHeightPolicy below is exhaustive
 *  over the union). WO-1903: this was a hand-typed 16-literal copy; it is now
 *  the ONE OperationType union, so a new operation is covered by the switch
 *  above without an edit here. */
export type LiveSmartHeightOperationType = OperationType

export interface StartingHeightSelectionContext {
  hasSetupStock: boolean
  hasSelectedGeometry?: boolean
  hasSelectedFeature?: boolean
  hasTargetSurface?: boolean
  hasRemainingMaterial?: boolean
  explicitEndConfirmed?: boolean
  /** Face (WO-2694): the setup's stock holds a model, so the smart Target End
   * is the model top and needs no confirmation. */
  hasModelTop?: boolean
  boundarySource?: 'geometry' | 'stock'
  useWidthForDepth?: boolean
  /** V-carve: the operator set a flat depth (else the bit's own limit applies). */
  hasFlatDepth?: boolean
  finishDepthMm?: number
  threadKind?: 'internal' | 'external'
  externalThreadReference?: 'top' | 'base'
}

export interface StartingHeightPolicySelection {
  operationType: LiveSmartHeightOperationType
  variant: string
  ready: boolean
  basis: 'feature' | 'geometry' | 'stock' | 'remaining_material' | 'explicit'
}

/** Select the safest useful V2 starting policy from evidence already present
 * in the operation wizard. This function never rewrites an authored policy;
 * callers apply it only while their authoring authority is still `new`. */
export function selectStartingHeightPolicy(
  operationType: LiveSmartHeightOperationType,
  context: StartingHeightSelectionContext,
): StartingHeightPolicySelection {
  const featureReady = context.hasSelectedFeature === true
  const geometryReady = context.hasSelectedGeometry === true
  const stockReady = context.hasSetupStock
  const surfaceReady = context.hasTargetSurface === true

  switch (operationType) {
    case 'face':
      // WO-2694 (the operator, 2026-10-09): with a model in the stock the smart Face ends
      // at the model top - the stock-footprint (explicit_depth) policy with a
      // policy-owned model_top end. Without one it waits for an explicit end.
      return featureReady && geometryReady
        ? { operationType, variant: 'target_face', ready: true, basis: 'feature' }
        : context.hasModelTop === true
          ? { operationType, variant: 'explicit_depth', ready: stockReady, basis: 'geometry' }
          : {
              operationType,
              variant: 'explicit_depth',
              ready: stockReady && context.explicitEndConfirmed === true,
              basis: 'explicit',
            }
    case 'contour_2d':
      if (featureReady) return { operationType, variant: 'selected_feature', ready: stockReady, basis: 'feature' }
      if (geometryReady && stockReady) return { operationType, variant: 'stock_bottom', ready: true, basis: 'stock' }
      return {
        operationType,
        variant: 'explicit_depth',
        ready: geometryReady && context.explicitEndConfirmed === true,
        basis: 'explicit',
      }
    case 'pocket_2d':
    case 'adaptive_clearing_2d':
      if (context.boundarySource === 'stock') {
        return {
          operationType,
          variant: 'stock_rough',
          ready: stockReady && surfaceReady,
          basis: 'stock',
        }
      }
      return geometryReady
        ? { operationType, variant: 'geometry_floor', ready: stockReady, basis: 'geometry' }
        : { operationType, variant: 'explicit_depth', ready: false, basis: 'explicit' }
    case 'drill':
    case 'bore':
      return featureReady
        ? { operationType, variant: 'detected_features', ready: stockReady, basis: 'feature' }
        : {
            operationType,
            variant: 'explicit_depth',
            ready: geometryReady && context.explicitEndConfirmed === true,
            basis: 'explicit',
          }
    case 'thread_mill': {
      const external = context.threadKind === 'external'
      const suffix = external
        ? context.externalThreadReference === 'base' ? 'external_base' : 'external_top'
        : 'internal_top'
      const explicit = external
        ? context.externalThreadReference === 'base'
          ? 'external_base_explicit'
          : 'external_top_explicit'
        : 'internal_explicit'
      return {
        operationType,
        variant: featureReady ? suffix : explicit,
        ready: featureReady || (geometryReady && context.explicitEndConfirmed === true),
        basis: featureReady ? 'feature' : 'explicit',
      }
    }
    case 'engrave':
      return {
        operationType,
        variant: context.useWidthForDepth ? 'width_derived' : 'explicit_depth',
        ready: geometryReady &&
          (context.useWidthForDepth === true || context.explicitEndConfirmed === true),
        basis: context.useWidthForDepth ? 'geometry' : 'explicit',
      }
    case 'vcarve':
      return {
        operationType,
        variant: context.hasFlatDepth ? 'flat_depth' : 'tool_limit',
        ready: geometryReady,
        basis: 'geometry',
      }
    case 'pattern':
      // WO-3001: a pattern ends a stated depth below the stock top.
      return {
        operationType,
        variant: 'explicit_depth',
        ready: stockReady && context.explicitEndConfirmed === true,
        basis: 'explicit',
      }
    case 'chamfer':
      return {
        operationType,
        variant: 'edge_width_formula',
        ready: featureReady,
        basis: featureReady ? 'feature' : 'explicit',
      }
    case 'parallel_3d':
    case 'waterline_3d':
    case 'steep_shallow_3d':
    case 'scallop_3d':
    case 'pencil_3d':
      return {
        operationType,
        variant: Number.isFinite(context.finishDepthMm) ? 'bounded_surface' : 'target_surface',
        ready: geometryReady && surfaceReady,
        basis: 'geometry',
      }
    case 'adaptive_3d':
      return {
        operationType,
        variant: 'current_material',
        ready: stockReady && geometryReady && surfaceReady,
        basis: context.hasRemainingMaterial ? 'remaining_material' : 'stock',
      }
  }
}
