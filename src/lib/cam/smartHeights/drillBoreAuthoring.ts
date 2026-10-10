import type { HeightIntentV1, ImportedGeometry } from '../../../types'
import { buildDrillBoreSmartHeightIntent, type DrillBoreOperationType } from './drillBore'
import { deriveDrillBoreFeatureBindings } from './drillBoreFeatureEvidence'
import type { OperationHeightIntentV2 } from './types'

export interface DrillBoreSmartHeightDraft {
  mode: 'detected_features' | 'explicit_depth'
  explicitStartWcsMm: number
  explicitEndWcsMm: number
}

export interface DrillBoreAuthoringIntentInput {
  operationType: DrillBoreOperationType
  setupId: string
  safetyIntent: Pick<HeightIntentV1, 'clearance' | 'retract' | 'feed'>
  geometries: readonly ImportedGeometry[]
  selectedLoopIds: readonly string[]
  draft: DrillBoreSmartHeightDraft
  perFeatureEndOverridesWcsMm?: Record<string, number>
}

function exactSelectedGeometryIds(
  geometries: readonly ImportedGeometry[],
  selectedLoopIds: readonly string[],
  operationType: DrillBoreOperationType,
): string[] {
  const ids = selectedLoopIds.map(id => id.trim()).filter(Boolean)
  if (ids.length === 0) {
    throw new Error(`${operationType === 'drill' ? 'Drill' : 'Bore'} Smart Height requires at least one selected loop.`)
  }
  if (new Set(ids).size !== ids.length) {
    throw new Error(`${operationType === 'drill' ? 'Drill' : 'Bore'} Smart Height selection contains duplicate loop ids.`)
  }
  const geometryIds: string[] = []
  for (const loopId of ids) {
    const owners = geometries.filter(geometry => (geometry.loops ?? []).some(loop => loop.id === loopId))
    if (owners.length !== 1) {
      throw new Error(
        `${operationType === 'drill' ? 'Drill' : 'Bore'} loop '${loopId}' ` +
        (owners.length === 0 ? 'no longer exists.' : 'exists in more than one geometry source.'),
      )
    }
    if (!geometryIds.includes(owners[0].id)) geometryIds.push(owners[0].id)
  }
  return geometryIds
}

/** Compile the modal's exact selection into durable Smart Height authority.
 * Detected mode refuses flat or mixed feature selections; explicit mode is the
 * intentional escape hatch for 2D circles that carry no physical floor. */
export function buildDrillBoreAuthoringIntent(
  input: DrillBoreAuthoringIntentInput,
): OperationHeightIntentV2 {
  const geometryIds = exactSelectedGeometryIds(
    input.geometries, input.selectedLoopIds, input.operationType,
  )
  if (input.draft.mode === 'explicit_depth') {
    return buildDrillBoreSmartHeightIntent({
      operationType: input.operationType,
      setupId: input.setupId,
      safetyIntent: input.safetyIntent,
      mode: 'explicit_depth',
      geometryIds,
      explicitStartWcsMm: input.draft.explicitStartWcsMm,
      explicitEndWcsMm: input.draft.explicitEndWcsMm,
    })
  }

  const derived = deriveDrillBoreFeatureBindings(
    input.geometries, input.selectedLoopIds, input.operationType,
  )
  if (!derived.ok) {
    throw new Error(derived.refusals.map(refusal => refusal.message).join(' '))
  }
  return buildDrillBoreSmartHeightIntent({
    operationType: input.operationType,
    setupId: input.setupId,
    safetyIntent: input.safetyIntent,
    mode: 'detected_features',
    features: derived.bindings.map(binding => ({
      loopId: binding.loopId,
      feature: { ...binding.feature },
      // The durable intent stores identity, not these authoring-time scalars.
      // Runtime re-derives current machine-frame evidence before every compute.
      topMachineMm: binding.topMm,
      floorMachineMm: binding.floorMm,
      fingerprint: binding.evidenceFingerprint,
    })),
    perFeatureEndOverridesWcsMm: input.perFeatureEndOverridesWcsMm,
  })
}

export function drillBoreSmartHeightDraftFromIntent(
  intent: OperationHeightIntentV2,
  expectedType: DrillBoreOperationType,
): DrillBoreSmartHeightDraft {
  if (intent.policy.operationType !== expectedType) {
    throw new Error(
      `${expectedType === 'drill' ? 'Drill' : 'Bore'} Smart Height authority names ` +
      `'${intent.policy.operationType}', not '${expectedType}'.`,
    )
  }
  if (intent.policy.variant === 'detected_features') {
    return { mode: 'detected_features', explicitStartWcsMm: 0, explicitEndWcsMm: -5 }
  }
  if (intent.policy.variant !== 'explicit_depth') {
    throw new Error(
      `${expectedType === 'drill' ? 'Drill' : 'Bore'} Smart Height uses unsupported policy '${intent.policy.variant}'.`,
    )
  }
  const start = intent.machining.start.value
  const end = intent.machining.end.value
  if (start.kind !== 'explicit_plane' || start.plane.reference !== 'wcs_plane' ||
      end.kind !== 'bounded_plane' || end.plane.reference !== 'wcs_plane') {
    throw new Error(`${expectedType === 'drill' ? 'Drill' : 'Bore'} explicit Smart Height planes are malformed.`)
  }
  return {
    mode: 'explicit_depth',
    explicitStartWcsMm: start.plane.offsetMm,
    explicitEndWcsMm: end.plane.offsetMm,
  }
}

/** Replace only Setup-owned safety planes. The physical feature/geometry scope,
 * endpoint policy, and stable per-feature overrides remain byte-for-byte owned
 * by the persisted authority rather than being re-inferred from UI scalars. */
export function rebuildDrillBoreSmartHeightSafetyIntent(input: {
  intent: OperationHeightIntentV2
  operationType: DrillBoreOperationType
  setupId: string
  safetyIntent: Pick<HeightIntentV1, 'clearance' | 'retract' | 'feed'>
}): OperationHeightIntentV2 {
  drillBoreSmartHeightDraftFromIntent(input.intent, input.operationType)
  const safetySeed = buildDrillBoreSmartHeightIntent({
    operationType: input.operationType,
    setupId: input.setupId,
    safetyIntent: input.safetyIntent,
    mode: 'explicit_depth',
    geometryIds: ['__safety_only__'],
    explicitStartWcsMm: 0,
    explicitEndWcsMm: -1,
  })
  return {
    ...input.intent,
    safety: safetySeed.safety,
    machining: input.intent.machining,
    ...(input.intent.featureOverrides
      ? { featureOverrides: input.intent.featureOverrides }
      : {}),
  }
}
