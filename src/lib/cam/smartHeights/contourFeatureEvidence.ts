import type { ImportedGeometry, Layer2D, Loop2D } from '../../../types'
import { smartHeightEvidenceFingerprint } from './adaptive3d'
import type { StableFeatureReference } from './types'

export interface ContourFeatureBinding {
  geometryId: string
  layerId: string
  loopId: string
  feature: StableFeatureReference
  featureKind: 'bore' | 'boss' | 'hole' | 'selected_plane'
  frame: 'geometry_local' | 'world'
  topMm: number
  floorMm: number
  evidenceFingerprint: string
}

export interface ContourFeatureBindingRefusal {
  loopId: string
  code:
    | 'missing_loop'
    | 'ambiguous_loop'
    | 'missing_layer'
    | 'no_physical_endpoint'
    | 'invalid_feature'
  message: string
}

export type DeriveContourFeatureBindingsResult =
  | { ok: true; bindings: ContourFeatureBinding[] }
  | { ok: false; refusals: ContourFeatureBindingRefusal[] }

interface LocatedLoop {
  geometry: ImportedGeometry
  layer: Layer2D
  loop: Loop2D
}

function finite(value: number): boolean {
  return Number.isFinite(value)
}

function sourceOwner(geometry: ImportedGeometry): { modelItemId: string; bodyId: string } {
  return {
    modelItemId: geometry.modelItemId?.trim() || `import:${geometry.id}`,
    bodyId: geometry.modelBody?.ref.bodyId?.trim() || geometry.id,
  }
}

function binding(
  located: LocatedLoop,
  featureKind: ContourFeatureBinding['featureKind'],
  topMm: number,
  floorMm: number,
  sourceFacts: unknown,
): ContourFeatureBinding | ContourFeatureBindingRefusal {
  const { geometry, layer, loop } = located
  if (!finite(topMm) || !finite(floorMm) || floorMm > topMm) {
    return {
      loopId: loop.id,
      code: 'invalid_feature',
      message: `Contour loop '${loop.id}' has invalid ${featureKind} top/floor evidence.`,
    }
  }
  const owner = sourceOwner(geometry)
  const sourceFingerprint = smartHeightEvidenceFingerprint({
    geometryId: geometry.id,
    owner,
    layerId: layer.id,
    loopId: loop.id,
    loop: { points: loop.points, closed: loop.closed, type: loop.type },
    sourceFacts,
  })
  const feature: StableFeatureReference = {
    ...owner,
    featureKind: `contour_${featureKind}`,
    stableId: loop.id,
    // Imported SVG/DXF and older project payloads may not carry a loop
    // revision yet. Version 1 is the durable baseline; version 0 is reserved
    // for invalid/unversioned evidence by the shared resolver.
    sourceVersion: geometry.loopsVersion ?? 1,
    sourceFingerprint,
  }
  return {
    geometryId: geometry.id,
    layerId: layer.id,
    loopId: loop.id,
    feature,
    featureKind,
    frame: layer.frame === 'geometry_local' ? 'geometry_local' : 'world',
    topMm,
    floorMm,
    evidenceFingerprint: smartHeightEvidenceFingerprint({
      sourceFingerprint,
      sourceVersion: feature.sourceVersion,
      topMm,
      floorMm,
      frame: layer.frame ?? 'world',
    }),
  }
}

function deriveOne(located: LocatedLoop): ContourFeatureBinding | ContourFeatureBindingRefusal {
  const { geometry, layer, loop } = located
  const cylinder = layer.cylinders?.find(candidate => candidate.loopId === loop.id)
  if (cylinder) {
    return binding(located, cylinder.kind, cylinder.topZ, cylinder.bottomZ, cylinder)
  }
  const hole = layer.holes?.find(candidate => candidate.loopId === loop.id)
  if (hole) {
    return binding(located, 'hole', hole.topZ, hole.bottomZ, hole)
  }
  const planeZ = layer.projectionPlane?.origin.z
  if (planeZ !== undefined) {
    return binding(located, 'selected_plane', planeZ, planeZ, {
      projectionPlane: layer.projectionPlane,
      sectionSource: layer.sectionSource,
    })
  }
  return {
    loopId: loop.id,
    code: 'no_physical_endpoint',
    message:
      `Contour loop '${loop.id}' on '${geometry.name}' is a flat curve with no physical floor, ` +
      'so it needs a stock to cut down to or an end depth you set.',
  }
}

/** Convert selected project loops into durable feature identities and physical
 * top/floor facts. A loop id must resolve exactly once across the supplied
 * geometry scope; duplicate ids from All Parts are named ambiguity failures. */
export function deriveContourFeatureBindings(
  geometries: readonly ImportedGeometry[],
  loopIds: readonly string[],
): DeriveContourFeatureBindingsResult {
  const normalizedIds = loopIds.map(id => id.trim()).filter(Boolean)
  const refusals: ContourFeatureBindingRefusal[] = []
  if (normalizedIds.length === 0) {
    return {
      ok: false,
      refusals: [{
        loopId: '',
        code: 'missing_loop',
        message: 'Selected-feature Contour requires at least one selected loop.',
      }],
    }
  }
  if (new Set(normalizedIds).size !== normalizedIds.length) {
    return {
      ok: false,
      refusals: [{
        loopId: '',
        code: 'ambiguous_loop',
        message: 'Selected-feature Contour contains duplicate loop ids.',
      }],
    }
  }

  const bindings: ContourFeatureBinding[] = []
  for (const loopId of normalizedIds) {
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
            message: `Contour loop '${loopId}' no longer has its source layer.`,
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
          message: `Contour loop '${loopId}' no longer exists in the selected geometry scope.`,
        })
      }
      continue
    }
    if (matches.length > 1) {
      refusals.push({
        loopId,
        code: 'ambiguous_loop',
        message: `Contour loop '${loopId}' exists in more than one geometry source.`,
      })
      continue
    }
    const result = deriveOne(matches[0])
    if ('code' in result) refusals.push(result)
    else bindings.push(result)
  }
  return refusals.length > 0 ? { ok: false, refusals } : { ok: true, bindings }
}
