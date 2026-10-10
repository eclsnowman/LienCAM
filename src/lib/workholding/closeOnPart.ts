// WO-2190 (workholding assemblies, slice 4): CLOSE ON PART - a one-shot
// command that sets a vise's opening from a part.
//
// docs/design/WORKHOLDING-ASSEMBLIES.md, "Close on part": project the part's
// mesh onto the jaw's travel axis, add the entered clearance, keep the result
// within the travel, and write that number as the opening - the same numeric
// opening the operator types (store setWorkholdingJointValue), so it saves,
// reopens and undoes like a typed one. Nothing live is set up: later part
// edits do not move the jaw. It is geometry in the project only; nothing here
// talks to a controller.
//
// The part is read where the viewport draws it: its display shape (./shapes.ts)
// at its scene pose (resolveWorkholding.ts markedRowWorldPose). A shape that
// cannot be read is replaced by its bounding box, and the line says so.
// Nothing refuses: a part wider than the travel puts the jaw at the end of its
// travel, and the line says how far that is from touching.

import type { ImportedGeometry, Project, Units, Vec3 } from '../../types'
import { fmtDim, unitLabel } from '../ui/unitFormat'
import { invertRigidMat4, poseToMat4, transformDirection } from './pose'
import { markedRowWorldPose, resolveJointValue } from './resolveWorkholding'
import { cachedWorkholdingShapeReader, displayBoundingBox, readDisplayShape, type WorkholdingShapeReader } from './shapes'
import type { ViseMembership } from './vise'

type CloseProject = Pick<Project, 'geometry' | 'modelItemPlacements'>

export interface CloseOnPartResult {
  /** The opening to write: width + clearance, kept within the travel. */
  readonly openingMm: number
  /** The part's extent along the jaw's travel axis. */
  readonly widthMm: number
  readonly clearanceMm: number
  readonly minMm: number
  readonly maxMm: number
  /** openingMm - widthMm: how far the jaw is from touching the part.
   *  Negative = the part is wider than the jaw opens (it overlaps by that much). */
  readonly gapMm: number
  /** True when width + clearance was outside the travel. */
  readonly atTravelEnd: boolean
  readonly shape: 'exact' | 'bounding-box'
}

/** Bodies Close on part can close on: not workholding, not a nest's own copy, with volume. */
export function closeOnPartCandidates(geometry: readonly ImportedGeometry[]): ImportedGeometry[] {
  return geometry.filter((g) => g.workholding !== true && !g.ownerNestId && displayBoundingBox(g) !== null)
}

/** The extent of local `positions` along `localAxis` (max - min of the dot products). */
function extentAlong(positions: ArrayLike<number>, localAxis: Vec3): number {
  let lo = Infinity
  let hi = -Infinity
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const d = positions[i] * localAxis.x + positions[i + 1] * localAxis.y + positions[i + 2] * localAxis.z
    if (d < lo) lo = d
    if (d > hi) hi = d
  }
  return hi >= lo ? hi - lo : 0
}

/**
 * Where Close on part puts the vise's moving jaw for `partGeometryId`. Null
 * only when there is nothing to measure: the vise has no usable slide, or the
 * part is not in the project, has no place in the world, or has no volume.
 */
export async function closeOnPart(
  project: CloseProject,
  membership: Pick<ViseMembership, 'instance' | 'moving'>,
  partGeometryId: string,
  clearanceMm: number,
  reader: WorkholdingShapeReader = cachedWorkholdingShapeReader,
): Promise<CloseOnPartResult | null> {
  const { instance, moving } = membership
  if (!moving?.joint) return null
  const joint = resolveJointValue(moving.joint, instance.jointValuesMm?.[moving.id])
  if (!joint.axis) return null
  const part = project.geometry.find((g) => g.id === partGeometryId)
  if (!part) return null
  const partPose = markedRowWorldPose(part, project.modelItemPlacements ?? [])
  if (!partPose) return null

  // The jaw's travel axis in the world, then in the part's display frame
  // (a rigid pose: the projection's width does not depend on its translation).
  const worldAxis = transformDirection(poseToMat4(instance.worldPose), joint.axis)
  const partLocalAxis = transformDirection(invertRigidMat4(poseToMat4(partPose)), worldAxis)

  const exact = await readDisplayShape(part, reader)
  let widthMm: number
  if (exact) {
    widthMm = extentAlong(exact.positions, partLocalAxis)
  } else {
    const box = displayBoundingBox(part)
    if (!box) return null
    const corners: number[] = []
    for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
      corners.push(x, y, z)
    }
    widthMm = extentAlong(corners, partLocalAxis)
  }

  const minMm = Math.min(moving.joint.minMm, moving.joint.maxMm)
  const maxMm = Math.max(moving.joint.minMm, moving.joint.maxMm)
  const clearance = Number.isFinite(clearanceMm) ? clearanceMm : 0
  const wanted = widthMm + clearance
  const openingMm = Math.min(maxMm, Math.max(minMm, wanted))
  return {
    openingMm,
    widthMm,
    clearanceMm: clearance,
    minMm,
    maxMm,
    gapMm: openingMm - widthMm,
    atTravelEnd: openingMm !== wanted,
    shape: exact ? 'exact' : 'bounding-box',
  }
}

/** The one console line Close on part writes, in the display unit. */
export function closeOnPartMessage(
  viseName: string,
  partName: string,
  result: CloseOnPartResult,
  units: Units,
): string {
  const u = unitLabel(units)
  const len = (mm: number) => `${parseFloat(fmtDim(mm, units, units === 'inch' ? 4 : 3))} ${u}`
  const shape = result.shape === 'bounding-box'
    ? ` (its shape could not be read, so its bounding box was measured)`
    : ''
  const measured = `"${partName}" is ${len(result.widthMm)} across the jaw${shape}`
  if (!result.atTravelEnd) {
    return `Close on part: the vise "${viseName}" is set to ${len(result.openingMm)} - ${measured}, plus ${len(result.clearanceMm)} clearance.`
  }
  const end = result.openingMm === result.maxMm ? 'fully open' : 'fully closed'
  const fromTouching = result.gapMm < 0
    ? `${len(-result.gapMm)} from touching: the part is that much wider than the vise opens`
    : `${len(result.gapMm)} from touching the part`
  return `Close on part: the vise "${viseName}" is set to ${len(result.openingMm)} (${end}) - ${measured}, plus ${len(result.clearanceMm)} clearance; the jaw is ${fromTouching}.`
}
