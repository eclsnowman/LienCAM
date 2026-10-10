import type {
  CylinderFeature,
  HoleFeature,
  ImportedGeometry,
  Layer2D,
  Loop2D,
} from '../../../types'
import { smartHeightEvidenceFingerprint } from './adaptive3d'
import type { DrillBoreOperationType } from './drillBore'
import type { StableFeatureReference } from './types'

export interface DrillBoreFeatureBinding {
  geometryId: string
  layerId: string
  loopId: string
  frame: 'geometry_local' | 'world'
  featureKind: 'hole' | 'bore'
  feature: StableFeatureReference
  topMm: number
  floorMm: number
  /** WO-2678: the hole's own `through` - its floor reaches the solid's bottom.
   * False is a blind floor with part below it. */
  through: boolean
  evidenceFingerprint: string
}

export interface DrillBoreFeatureBindingRefusal {
  loopId: string
  code:
    | 'missing_loop'
    | 'ambiguous_loop'
    | 'missing_layer'
    | 'no_physical_feature'
    | 'wrong_feature_kind'
    | 'ambiguous_feature'
    | 'invalid_feature'
  message: string
}

export type DeriveDrillBoreFeatureBindingsResult =
  | { ok: true; bindings: DrillBoreFeatureBinding[] }
  | { ok: false; refusals: DrillBoreFeatureBindingRefusal[] }

interface LocatedLoop {
  geometry: ImportedGeometry
  layer: Layer2D
  loop: Loop2D
}

interface LocatedPhysicalFeature {
  kind: 'hole' | 'bore'
  value: HoleFeature | CylinderFeature
}

function owner(geometry: ImportedGeometry): Pick<StableFeatureReference, 'modelItemId' | 'bodyId'> {
  return {
    modelItemId: geometry.modelItemId?.trim() || `import:${geometry.id}`,
    bodyId: geometry.modelBody?.ref.bodyId?.trim() || geometry.id,
  }
}

function physicalFeatures(located: LocatedLoop): LocatedPhysicalFeature[] {
  const holes = (located.layer.holes ?? [])
    .filter(feature => feature.loopId === located.loop.id)
    .map(value => ({ kind: 'hole' as const, value }))
  const bores = (located.layer.cylinders ?? [])
    .filter(feature => feature.loopId === located.loop.id && feature.kind === 'bore')
    .map(value => ({ kind: 'bore' as const, value }))
  return [...holes, ...bores]
}

function bindOne(
  operationType: DrillBoreOperationType,
  located: LocatedLoop,
): DrillBoreFeatureBinding | DrillBoreFeatureBindingRefusal {
  const matches = physicalFeatures(located)
  if (matches.length === 0) {
    const hasCylinder = (located.layer.cylinders ?? []).some(feature => feature.loopId === located.loop.id)
    return {
      loopId: located.loop.id,
      code: hasCylinder && operationType === 'bore' ? 'wrong_feature_kind' : 'no_physical_feature',
      message: hasCylinder && operationType === 'bore'
        ? `Bore loop '${located.loop.id}' is an external boss, not a proven internal bore.`
        : `${operationType === 'drill' ? 'Drill' : 'Bore'} loop '${located.loop.id}' is a flat circle with no proven physical floor. Use explicit Material Start and Target End.`,
    }
  }
  if (matches.length > 1) {
    return {
      loopId: located.loop.id,
      code: 'ambiguous_feature',
      message: `${operationType === 'drill' ? 'Drill' : 'Bore'} loop '${located.loop.id}' maps to more than one physical feature.`,
    }
  }
  const match = matches[0]
  if (operationType === 'bore' && match.kind !== 'bore') {
    return {
      loopId: located.loop.id,
      code: 'wrong_feature_kind',
      message: `Bore loop '${located.loop.id}' is not backed by a selected internal cylindrical wall.`,
    }
  }
  const top = Number(match.value.topZ)
  const floor = Number(match.value.bottomZ)
  if (!Number.isFinite(top) || !Number.isFinite(floor) || floor > top) {
    return {
      loopId: located.loop.id,
      code: 'invalid_feature',
      message: `${operationType === 'drill' ? 'Drill' : 'Bore'} loop '${located.loop.id}' has invalid physical top/floor evidence.`,
    }
  }

  const source = match.value.sourceIdentity
  const sourceOwner = owner(located.geometry)
  const fallbackFingerprint = smartHeightEvidenceFingerprint({
    geometryId: located.geometry.id,
    layerId: located.layer.id,
    loopId: located.loop.id,
    loop: {
      points: located.loop.points,
      closed: located.loop.closed,
      type: located.loop.type,
    },
    featureKind: match.kind,
    feature: {
      center: match.value.center,
      diameter: match.value.diameter,
      topZ: top,
      bottomZ: floor,
      through: match.value.through,
    },
  })
  const sourceFingerprint = source?.sourceFingerprint.trim() || fallbackFingerprint
  const stableId = source?.stableId.trim() || located.loop.id
  const sourceVersion = source?.sourceVersion ?? 1
  if (!stableId || !sourceFingerprint || !Number.isInteger(sourceVersion) || sourceVersion < 1) {
    return {
      loopId: located.loop.id,
      code: 'invalid_feature',
      message: `${operationType === 'drill' ? 'Drill' : 'Bore'} loop '${located.loop.id}' has incomplete feature identity.`,
    }
  }
  const frame = source?.evidenceFrame ?? (located.layer.frame === 'geometry_local' ? 'geometry_local' : 'world')
  const feature: StableFeatureReference = {
    ...sourceOwner,
    featureKind: `detected_${match.kind}`,
    stableId,
    sourceVersion,
    sourceFingerprint,
  }
  return {
    geometryId: located.geometry.id,
    layerId: located.layer.id,
    loopId: located.loop.id,
    frame,
    featureKind: match.kind,
    feature,
    topMm: top,
    floorMm: floor,
    through: match.value.through === true,
    evidenceFingerprint: smartHeightEvidenceFingerprint({
      feature,
      loopId: located.loop.id,
      top,
      floor,
      frame,
    }),
  }
}

/** Bind selected loops to exact physical Drill/Bore features. Loop ids remain
 * worker-routing data only; StableFeatureReference is the durable authority. */
export function deriveDrillBoreFeatureBindings(
  geometries: readonly ImportedGeometry[],
  loopIds: readonly string[],
  operationType: DrillBoreOperationType,
): DeriveDrillBoreFeatureBindingsResult {
  const selected = loopIds.map(id => id.trim()).filter(Boolean)
  if (selected.length === 0) {
    return {
      ok: false,
      refusals: [{
        loopId: '',
        code: 'missing_loop',
        message: `${operationType === 'drill' ? 'Drill' : 'Bore'} detected-feature mode requires at least one selected loop.`,
      }],
    }
  }
  if (new Set(selected).size !== selected.length) {
    return {
      ok: false,
      refusals: [{
        loopId: '',
        code: 'ambiguous_loop',
        message: `${operationType === 'drill' ? 'Drill' : 'Bore'} selection contains duplicate loop ids.`,
      }],
    }
  }

  const bindings: DrillBoreFeatureBinding[] = []
  const refusals: DrillBoreFeatureBindingRefusal[] = []
  for (const loopId of selected) {
    const matches: LocatedLoop[] = []
    for (const geometry of geometries) {
      const layers = new Map((geometry.layers2d ?? []).map(layer => [layer.id, layer]))
      for (const loop of geometry.loops ?? []) {
        if (loop.id !== loopId) continue
        const layer = layers.get(loop.layerId)
        if (!layer) {
          refusals.push({
            loopId,
            code: 'missing_layer',
            message: `${operationType === 'drill' ? 'Drill' : 'Bore'} loop '${loopId}' no longer has its source layer.`,
          })
          continue
        }
        matches.push({ geometry, layer, loop })
      }
    }
    if (matches.length === 0) {
      if (!refusals.some(refusal => refusal.loopId === loopId)) {
        refusals.push({
          loopId,
          code: 'missing_loop',
          message: `${operationType === 'drill' ? 'Drill' : 'Bore'} loop '${loopId}' no longer exists in the selected geometry scope.`,
        })
      }
      continue
    }
    if (matches.length > 1) {
      refusals.push({
        loopId,
        code: 'ambiguous_loop',
        message: `${operationType === 'drill' ? 'Drill' : 'Bore'} loop '${loopId}' exists in more than one geometry source.`,
      })
      continue
    }
    const result = bindOne(operationType, matches[0])
    if ('code' in result) refusals.push(result)
    else bindings.push(result)
  }
  const identityKeys = bindings.map(item => JSON.stringify(item.feature))
  if (new Set(identityKeys).size !== identityKeys.length) {
    refusals.push({
      loopId: '',
      code: 'ambiguous_feature',
      message: `${operationType === 'drill' ? 'Drill' : 'Bore'} selection resolves the same physical feature more than once.`,
    })
  }
  return refusals.length > 0 ? { ok: false, refusals } : { ok: true, bindings }
}
