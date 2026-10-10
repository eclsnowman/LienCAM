// WO-2120: a picked face named in words - "top face", "flat face facing +X at
// X 60.00 mm", "round face" - never its internal id ("IMP1:step:face#0").
//
// Reads only the face's geometry snapshot (the kind of surface, where its
// middle is, which way a flat one looks) and, when known, the body's extent,
// so the one flat face at the body's very top reads as the "top face".

import type { GeometrySnapshot } from '../../../geom/geom-service'

export interface BodyExtent {
  min: { x: number; y: number; z: number }
  max: { x: number; y: number; z: number }
}

/** How close to an axis a normal has to be before it is named by that axis. */
const AXIS_COS = 0.999
/** How near a face's middle has to sit to the body's extent to be its top/bottom/side. */
const EXTENT_MM = 1e-3

const SURFACE_WORDS: Record<GeometrySnapshot['surfaceType'], string> = {
  plane: 'flat face',
  cylinder: 'round face',
  cone: 'cone-shaped face',
  sphere: 'ball-shaped face',
  torus: 'rounded ring face',
  bspline: 'curved face',
  other: 'curved face',
}

const AXES = [
  { axis: 'x', label: 'X' },
  { axis: 'y', label: 'Y' },
  { axis: 'z', label: 'Z' },
] as const

/** The face in words: the kind of surface, and for a flat face which way it
 *  looks and where it sits. */
export function describeFaceSnapshot(snapshot: GeometrySnapshot, extent?: BodyExtent): string {
  const kind = SURFACE_WORDS[snapshot.surfaceType] ?? 'face'
  const n = snapshot.normal
  if (snapshot.surfaceType !== 'plane' || n === undefined) {
    const a = snapshot.axis
    const along = a === undefined ? undefined : AXES.find(({ axis }) => Math.abs(a[axis]) >= AXIS_COS)
    return along === undefined ? kind : `${kind} along ${along.label}`
  }
  const length = Math.hypot(n.x, n.y, n.z)
  if (!(length > 0)) return kind
  const unit = { x: n.x / length, y: n.y / length, z: n.z / length }
  const c = snapshot.centroid
  const at = (axis: 'x' | 'y' | 'z', label: string): string => `at ${label} ${c[axis].toFixed(2)} mm`
  if (unit.z >= AXIS_COS) {
    if (extent !== undefined && Math.abs(c.z - extent.max.z) <= EXTENT_MM) return 'top face'
    return `flat face facing up ${at('z', 'Z')}`
  }
  if (unit.z <= -AXIS_COS) {
    if (extent !== undefined && Math.abs(c.z - extent.min.z) <= EXTENT_MM) return 'bottom face'
    return `flat face facing down ${at('z', 'Z')}`
  }
  for (const { axis, label } of AXES) {
    if (Math.abs(unit[axis]) < AXIS_COS) continue
    const sign = unit[axis] > 0 ? '+' : '-'
    const edge = unit[axis] > 0 ? extent?.max[axis] : extent?.min[axis]
    if (edge !== undefined && Math.abs(c[axis] - edge) <= EXTENT_MM) return `side face facing ${sign}${label}`
    return `flat face facing ${sign}${label} ${at(axis, label)}`
  }
  const tiltDeg = (Math.acos(Math.min(1, Math.abs(unit.z))) * 180) / Math.PI
  return `flat face tilted ${tiltDeg.toFixed(0)} deg from flat`
}
