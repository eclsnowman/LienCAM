import type { ImportedGeometry, Loop2D } from '../../../types'
import { smartHeightEvidenceFingerprint } from './adaptive3d'
import type { StableFeatureReference } from './types'

export interface ChamferEdgeBinding {
  geometryId: string
  layerId: string
  loopId: string
  feature: StableFeatureReference
  evidenceFingerprint: string
}

export interface ChamferEdgeBindingRefusal {
  loopId: string
  code: 'missing_loop' | 'ambiguous_loop' | 'missing_layer' | 'open_loop'
  message: string
}

export type DeriveChamferEdgeBindingsResult =
  | { ok: true; bindings: ChamferEdgeBinding[] }
  | { ok: false; refusals: ChamferEdgeBindingRefusal[] }

interface LocatedLoop {
  geometry: ImportedGeometry
  loop: Loop2D
}

function sourceOwner(geometry: ImportedGeometry): { modelItemId: string; bodyId: string } {
  return {
    modelItemId: geometry.modelItemId?.trim() || `import:${geometry.id}`,
    bodyId: geometry.modelBody?.ref.bodyId?.trim() || geometry.id,
  }
}

/** Bind selected Chamfer paths by edge identity only. Unlike Contour's
 * selected-feature endpoint binder, this deliberately does not require a
 * cylinder, hole floor, or projection plane: the Chamfer datum is separately
 * authored and a flat DXF/SVG loop is a valid edge scope. */
export function deriveChamferEdgeBindings(
  geometries: readonly ImportedGeometry[],
  loopIds: readonly string[],
): DeriveChamferEdgeBindingsResult {
  const normalizedIds = loopIds.map(id => id.trim()).filter(Boolean)
  if (normalizedIds.length === 0) {
    return {
      ok: false,
      refusals: [{
        loopId: '',
        code: 'missing_loop',
        message: 'Chamfer Smart Height requires at least one selected closed edge loop.',
      }],
    }
  }
  if (new Set(normalizedIds).size !== normalizedIds.length) {
    return {
      ok: false,
      refusals: [{
        loopId: '',
        code: 'ambiguous_loop',
        message: 'Chamfer Smart Height contains duplicate loop ids.',
      }],
    }
  }

  const refusals: ChamferEdgeBindingRefusal[] = []
  const bindings: ChamferEdgeBinding[] = []
  for (const loopId of normalizedIds) {
    const matches: LocatedLoop[] = []
    for (const geometry of geometries) {
      for (const loop of geometry.loops ?? []) {
        if (loop.id === loopId) matches.push({ geometry, loop })
      }
    }
    if (matches.length === 0) {
      refusals.push({
        loopId,
        code: 'missing_loop',
        message: `Chamfer edge loop '${loopId}' no longer exists in the selected geometry scope.`,
      })
      continue
    }
    if (matches.length > 1) {
      refusals.push({
        loopId,
        code: 'ambiguous_loop',
        message: `Chamfer edge loop '${loopId}' exists in more than one geometry source.`,
      })
      continue
    }
    const { geometry, loop } = matches[0]
    if (!loop.closed) {
      refusals.push({
        loopId,
        code: 'open_loop',
        message: `Chamfer edge loop '${loopId}' is open. Select a closed edge loop.`,
      })
      continue
    }
    const layer = (geometry.layers2d ?? []).find(candidate => candidate.id === loop.layerId)
    if (!layer) {
      refusals.push({
        loopId,
        code: 'missing_layer',
        message: `Chamfer edge loop '${loopId}' no longer has its source layer.`,
      })
      continue
    }
    const owner = sourceOwner(geometry)
    const sourceFingerprint = smartHeightEvidenceFingerprint({
      geometryId: geometry.id,
      owner,
      layerId: layer.id,
      loopId: loop.id,
      loop: { points: loop.points, closed: loop.closed, type: loop.type },
    })
    const feature: StableFeatureReference = {
      ...owner,
      featureKind: 'chamfer_edge',
      stableId: loop.id,
      sourceVersion: geometry.loopsVersion ?? 1,
      sourceFingerprint,
    }
    bindings.push({
      geometryId: geometry.id,
      layerId: layer.id,
      loopId: loop.id,
      feature,
      evidenceFingerprint: smartHeightEvidenceFingerprint({
        sourceFingerprint,
        sourceVersion: feature.sourceVersion,
      }),
    })
  }
  return refusals.length > 0 ? { ok: false, refusals } : { ok: true, bindings }
}
