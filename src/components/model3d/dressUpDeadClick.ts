import { textFor } from '../../i18n'
import type { FeatureClass, FeatureVerdict, StableId, SurfaceType } from '../../geom/geom-service'

const deadClickText = textFor('sketch-and-model-workbench')

/** WO-2761: what Fillet can open from a picked face - the imported straight
 *  fillet the WO-2078 imported-edit route changes (removable, absorbed into a
 *  pocket or boss, with a measured radius), or (WO-2766) the whole fillet chain
 *  the face belongs to. */
export function editableImportedFillet(verdicts: readonly FeatureVerdict[], faceId: StableId): FeatureVerdict | undefined {
  return verdicts.find((verdict) =>
    verdict.removable &&
    (verdict.featureKey.startsWith('absorbed:') || verdict.featureKey.startsWith('chain:fillet:')) &&
    verdict.featureClass.startsWith('fillet') &&
    verdict.faceIds.includes(faceId) &&
    typeof verdict.params.radius === 'number' &&
    Number.isFinite(verdict.params.radius) &&
    verdict.params.radius > 0,
  )
}

/** WO-2766: the distance an imported chamfer chain's Chamfer edit opens on -
 *  its one measured distance, or the smaller side of an unequal-leg chain
 *  (the edit re-dresses it at the one distance typed). */
export function importedChamferDistance(verdict: FeatureVerdict): number | undefined {
  const sides = typeof verdict.params.distance === 'number'
    ? [verdict.params.distance]
    : [verdict.params.distanceA, verdict.params.distanceB]
  if (!sides.every((side): side is number => typeof side === 'number' && Number.isFinite(side) && side > 0)) return undefined
  return Math.min(...sides)
}

/** WO-2766: what Chamfer can open from a picked face - the imported chamfer
 *  chain it belongs to, with its sides measured. */
export function editableImportedChamfer(verdicts: readonly FeatureVerdict[], faceId: StableId): FeatureVerdict | undefined {
  return verdicts.find((verdict) =>
    verdict.removable &&
    verdict.featureKey.startsWith('chain:chamfer:') &&
    verdict.faceIds.includes(faceId) &&
    importedChamferDistance(verdict) !== undefined,
  )
}

const SURFACE: Record<SurfaceType, () => string> = {
  plane: () => deadClickText('dressUpDeadClick.surfacePlane'),
  cylinder: () => deadClickText('dressUpDeadClick.surfaceCylinder'),
  cone: () => deadClickText('dressUpDeadClick.surfaceCone'),
  sphere: () => deadClickText('dressUpDeadClick.surfaceSphere'),
  torus: () => deadClickText('dressUpDeadClick.surfaceTorus'),
  bspline: () => deadClickText('dressUpDeadClick.surfaceFreeform'),
  other: () => deadClickText('dressUpDeadClick.surfaceOther'),
}

const FEATURE: Record<FeatureClass, () => string> = {
  throughHole: () => deadClickText('dressUpDeadClick.featureHole'),
  blindHole: () => deadClickText('dressUpDeadClick.featureHole'),
  counterboreStack: () => deadClickText('dressUpDeadClick.featureCounterbore'),
  pocket: () => deadClickText('dressUpDeadClick.featurePocket'),
  engravedText: () => deadClickText('dressUpDeadClick.featureEngravedText'),
  boss: () => deadClickText('dressUpDeadClick.featureBoss'),
  filletPlanar: () => deadClickText('dressUpDeadClick.featureFillet'),
  chamferPlanar: () => deadClickText('dressUpDeadClick.featureChamfer'),
  filletCurvedCorner: () => deadClickText('dressUpDeadClick.featureFillet'),
  filletChain: () => deadClickText('dressUpDeadClick.featureFillet'),
  chamferChain: () => deadClickText('dressUpDeadClick.featureChamfer'),
  sliver: () => deadClickText('dressUpDeadClick.featureSliver'),
}

/** WO-2761: the one console line for a Fillet or Chamfer click that landed on
 *  a face (no edge) and opens nothing - names the face and why the tool cannot
 *  use it, then the next step. `surface` is null when the kernel could not
 *  classify the face. Never called for a face Fillet can open
 *  (editableImportedFillet). */
export function dressUpDeadClickLine(
  tool: 'fillet' | 'chamfer',
  surface: SurfaceType | null,
  verdicts: readonly FeatureVerdict[],
  faceId: StableId,
): string {
  const face = SURFACE[surface ?? 'other']()
  const onFace = verdicts.filter((v) => v.faceIds.includes(faceId))
  if (tool === 'chamfer') {
    return onFace.some((v) => v.featureClass === 'chamferPlanar' || v.featureClass === 'chamferChain')
      ? deadClickText('dressUpDeadClick.chamferExisting', { face })
      : deadClickText('dressUpDeadClick.chamferNotAnEdge', { face })
  }
  const fillet = onFace.find((v) => v.featureClass.startsWith('fillet'))
  if (fillet !== undefined) {
    // defeature.ts refuseCurved: a torus outside the bounded blend-ribbon
    // class, or a fillet cylinder whose ends run into another curved face.
    if (fillet.featureClass === 'filletCurvedCorner' && !fillet.removable) {
      if (surface === 'torus') return deadClickText('dressUpDeadClick.filletCurved')
      if (surface === 'cylinder') return deadClickText('dressUpDeadClick.filletChain')
    }
    return deadClickText('dressUpDeadClick.filletNotChangeable', { face })
  }
  const host = onFace[0]
  if (host !== undefined) return deadClickText('dressUpDeadClick.filletInsideFeature', { face, feature: FEATURE[host.featureClass]() })
  return deadClickText('dressUpDeadClick.filletNotAnEdge', { face })
}
