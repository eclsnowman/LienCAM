import type { CylinderFeature, ImportedGeometry, Layer2D, Loop2D } from '../../../types'
import { smartHeightEvidenceFingerprint } from './adaptive3d'
import type { StableFeatureReference } from './types'

export interface ThreadMillFeatureBinding {
  geometryId: string
  layerId: string
  loopId: string
  frame: 'geometry_local' | 'world'
  featureKind: 'bore' | 'boss'
  feature: StableFeatureReference
  topMm: number
  floorMm: number
  evidenceFingerprint: string
}

export interface ThreadMillFeatureBindingRefusal {
  loopId: string
  code:
    | 'missing_loop'
    | 'ambiguous_loop'
    | 'missing_layer'
    | 'no_physical_feature'
    | 'ambiguous_feature'
    | 'invalid_feature'
  message: string
}

export type DeriveThreadMillFeatureBindingsResult =
  | { ok: true; bindings: ThreadMillFeatureBinding[] }
  | { ok: false; refusals: ThreadMillFeatureBindingRefusal[] }

interface LocatedLoop {
  geometry: ImportedGeometry
  layer: Layer2D
  loop: Loop2D
}

function featureKey(feature: StableFeatureReference): string {
  return [
    feature.modelItemId,
    feature.bodyId,
    feature.featureKind,
    feature.stableId,
    String(feature.sourceVersion),
    feature.sourceFingerprint,
  ].join('\u001f')
}

function owner(geometry: ImportedGeometry): Pick<StableFeatureReference, 'modelItemId' | 'bodyId'> {
  return {
    modelItemId: geometry.modelItemId?.trim() || `import:${geometry.id}`,
    bodyId: geometry.modelBody?.ref.bodyId?.trim() || geometry.id,
  }
}

function bindOne(located: LocatedLoop): ThreadMillFeatureBinding | ThreadMillFeatureBindingRefusal {
  const matches = (located.layer.cylinders ?? []).filter(feature => feature.loopId === located.loop.id)
  if (matches.length === 0) {
    return {
      loopId: located.loop.id,
      code: 'no_physical_feature',
      message: `Thread Mill loop '${located.loop.id}' is a flat circle with no proven bore or boss band. Use an explicit reference plane and thread length.`,
    }
  }
  if (matches.length > 1) {
    return {
      loopId: located.loop.id,
      code: 'ambiguous_feature',
      message: `Thread Mill loop '${located.loop.id}' maps to more than one cylindrical feature.`,
    }
  }
  const cylinder: CylinderFeature = matches[0]
  const top = Number(cylinder.topZ)
  const floor = Number(cylinder.bottomZ)
  if (!Number.isFinite(top) || !Number.isFinite(floor) || floor > top) {
    return {
      loopId: located.loop.id,
      code: 'invalid_feature',
      message: `Thread Mill loop '${located.loop.id}' has invalid physical top/base evidence.`,
    }
  }

  const source = cylinder.sourceIdentity
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
    cylinder: {
      kind: cylinder.kind,
      center: cylinder.center,
      diameter: cylinder.diameter,
      topZ: top,
      bottomZ: floor,
      through: cylinder.through,
    },
  })
  const sourceFingerprint = source?.sourceFingerprint.trim() || fallbackFingerprint
  const stableId = source?.stableId.trim() || located.loop.id
  const sourceVersion = source?.sourceVersion ?? 1
  if (!stableId || !sourceFingerprint || !Number.isInteger(sourceVersion) || sourceVersion < 1) {
    return {
      loopId: located.loop.id,
      code: 'invalid_feature',
      message: `Thread Mill loop '${located.loop.id}' has incomplete cylinder identity.`,
    }
  }
  const frame = source?.evidenceFrame ?? (located.layer.frame === 'geometry_local' ? 'geometry_local' : 'world')
  const feature: StableFeatureReference = {
    ...sourceOwner,
    featureKind: `detected_${cylinder.kind}`,
    stableId,
    sourceVersion,
    sourceFingerprint,
  }
  return {
    geometryId: located.geometry.id,
    layerId: located.layer.id,
    loopId: located.loop.id,
    frame,
    featureKind: cylinder.kind,
    feature,
    topMm: top,
    floorMm: floor,
    evidenceFingerprint: smartHeightEvidenceFingerprint({
      feature,
      loopId: located.loop.id,
      kind: cylinder.kind,
      top,
      floor,
      frame,
    }),
  }
}

/** Bind selected Thread Mill loops to exact bore/boss topology. Loop ids route
 * the worker; stable feature references own the persisted machining band. */
export function deriveThreadMillFeatureBindings(
  geometries: readonly ImportedGeometry[],
  loopIds: readonly string[],
): DeriveThreadMillFeatureBindingsResult {
  const selected = loopIds.map(id => id.trim()).filter(Boolean)
  if (selected.length === 0) {
    return {
      ok: false,
      refusals: [{
        loopId: '',
        code: 'missing_loop',
        message: 'Thread Mill detected-feature mode requires at least one selected loop.',
      }],
    }
  }
  if (new Set(selected).size !== selected.length) {
    return {
      ok: false,
      refusals: [{
        loopId: '',
        code: 'ambiguous_loop',
        message: 'Thread Mill selection contains duplicate loop ids.',
      }],
    }
  }

  const bindings: ThreadMillFeatureBinding[] = []
  const refusals: ThreadMillFeatureBindingRefusal[] = []
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
            message: `Thread Mill loop '${loopId}' no longer has its source layer.`,
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
          message: `Thread Mill loop '${loopId}' no longer exists in the selected geometry scope.`,
        })
      }
      continue
    }
    if (matches.length > 1) {
      refusals.push({
        loopId,
        code: 'ambiguous_loop',
        message: `Thread Mill loop '${loopId}' exists in more than one geometry source.`,
      })
      continue
    }
    const result = bindOne(matches[0])
    if ('code' in result) refusals.push(result)
    else bindings.push(result)
  }
  if (new Set(bindings.map(item => featureKey(item.feature))).size !== bindings.length) {
    refusals.push({
      loopId: '',
      code: 'ambiguous_feature',
      message: 'Thread Mill selection resolves the same physical cylinder more than once.',
    })
  }
  return refusals.length > 0 ? { ok: false, refusals } : { ok: true, bindings }
}
