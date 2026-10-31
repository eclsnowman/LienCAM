import type { ImportedGeometry, Loop2D } from '../../types'

type LoopWithImportedCircle = Loop2D & { importedCircleDiameter?: number }

/** Presentation only: never filters picks or participates in authoring admission.
 * Read detected diameters by owning layer + loop identity, or importer-stamped
 * analytic DXF CIRCLE provenance. A sampled boundary alone cannot establish a
 * hole diameter: polygons and a partial arc closed by a chord can share the
 * same circle fit. Area or a fitted circle is not known hole metadata.
 */
export function drillSizeNoticeHoleDiameter(
  drillDiameter: number | undefined,
  rows: ReadonlyArray<{ loop: Loop2D; source: ImportedGeometry }>,
  selectedLoopIds: readonly string[],
): number | undefined {
  if (drillDiameter === undefined || !Number.isFinite(drillDiameter) || !(drillDiameter > 0)) return undefined
  let smallest: number | undefined
  for (const { loop, source } of rows) {
    if (!loop.closed || (selectedLoopIds.length > 0 && !selectedLoopIds.includes(loop.id))) continue
    const layer = source.layers2d?.find(candidate => candidate.id === loop.layerId)
    const feature = layer?.holes?.find(hole => hole.loopId === loop.id)
      ?? layer?.cylinders?.find(cylinder => cylinder.kind === 'bore' && cylinder.loopId === loop.id)
    const diameter = feature?.diameter ?? (loop as LoopWithImportedCircle).importedCircleDiameter
    // Numerical circle-fit noise must not turn an equal drill into a notice.
    if (diameter !== undefined && Number.isFinite(diameter) && diameter > 0 &&
        drillDiameter - diameter > 1e-6 && (smallest === undefined || diameter < smallest)) {
      smallest = diameter
    }
  }
  // Mixed sizes still get exactly one truthful line, naming the smallest pick.
  return smallest
}
