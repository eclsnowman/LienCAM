import type { ProfileRegion } from '../../../geom/geom-service'
import type { RayLike } from '../../../viewport3d'
import { regionProfileSelector, type ProfileSelector } from './regionSelector'

export interface ProfilePickResult {
  sketchId: string
  profileSelector: ProfileSelector
}

export interface ProfilePickCandidate extends ProfilePickResult {
  /** Transient UI identity. Persist profileSelector, never this key. */
  key: string
  profile: ProfileRegion
}

export function profilePickKey(sketchId: string, selector: ProfileSelector): string {
  if (selector.kind === 'whole-sketch') return `${sketchId}:whole-sketch`
  if (selector.kind === 'regions') {
    return `${sketchId}:regions:${selector.regions.map(({ signature, ordinal }) =>
      `${signature.join('\u001f')}${ordinal === undefined ? '' : `#${ordinal}`}`,
    ).join('\u001e')}`
  }
  // The ordinal is part of the key, not decoration: two same-signature regions (see
  // ProfileSelector.ordinal) must hover, highlight, and de-select independently.
  const ordinal = selector.ordinal === undefined ? '' : `#${selector.ordinal}`
  return `${sketchId}:region:${selector.signature.join('\u001f')}${ordinal}`
}

/** Build all directly pickable regions for one sketch. Old documents with
 * only payload.profile stay pickable as an explicit whole-sketch choice. */
export function profilePickCandidatesForSketch(
  sketchId: string,
  legacyProfile: ProfileRegion | undefined,
  regions: readonly ProfileRegion[] | undefined,
): ProfilePickCandidate[] {
  const available = regions !== undefined && regions.length > 0
    // The whole list is handed to the selector builder so a region that shares its boundary lineage
    // with a sibling still gets a selector that names it uniquely (ProfileSelector.ordinal).
    ? regions.map((profile) => ({ profile, profileSelector: regionProfileSelector(profile, regions) }))
    : legacyProfile === undefined
      ? []
      : [{ profile: legacyProfile, profileSelector: { kind: 'whole-sketch' } as const }]
  return available
    .filter(({ profile }) => profile.loops.length > 0)
    .map(({ profile, profileSelector }) => ({
      key: profilePickKey(sketchId, profileSelector),
      sketchId,
      profileSelector,
      profile,
    }))
}

export interface ProfilePickRequest {
  allowedIds: readonly string[]
  prompt: string
  maxPicks: 1 | 2 | 'many'
  onSelectionChange?(results: readonly ProfilePickResult[]): void
  onDone(results: ProfilePickResult[]): void
  onCancel(): void
}

export interface ProfilePickStopper {
  (): void
  done?(results?: readonly ProfilePickResult[]): void
}

/** The returned stopper lets a persistent command palette retire its own
 * viewport session when the operator presses Escape, Cancel, or switches
 * tools. Legacy callers may still return void. */
export type StartProfilePick = (request: ProfilePickRequest) => void | ProfilePickStopper

type V3 = { x: number; y: number; z: number }
type V2 = readonly [number, number]

const dot = (a: V3, b: V3): number => a.x * b.x + a.y * b.y + a.z * b.z
const sub = (a: V3, b: V3): V3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z })
const scale = (v: V3, s: number): V3 => ({ x: v.x * s, y: v.y * s, z: v.z * s })
const cross = (a: V3, b: V3): V3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
})
const normalize = (v: V3): V3 | null => {
  const length = Math.hypot(v.x, v.y, v.z)
  if (!Number.isFinite(length) || length < 1e-9) return null
  return { x: v.x / length, y: v.y / length, z: v.z / length }
}

function tessellateLoop(loop: ProfileRegion['loops'][number]): V2[] {
  const points: V2[] = []
  for (const segment of loop) {
    if (segment.kind === 'line') {
      points.push(segment.a)
      continue
    }
    let span = segment.ccw ? segment.a1 - segment.a0 : segment.a0 - segment.a1
    while (span <= 0) span += Math.PI * 2
    while (span > Math.PI * 2 + 1e-9) span -= Math.PI * 2
    const steps = Math.max(8, Math.ceil(span / (Math.PI / 24)))
    for (let i = 0; i < steps; i++) {
      const fraction = i / steps
      const angle = segment.ccw
        ? segment.a0 + span * fraction
        : segment.a0 - span * fraction
      points.push([
        segment.c[0] + Math.cos(angle) * segment.r,
        segment.c[1] + Math.sin(angle) * segment.r,
      ])
    }
  }
  return points
}

function pointInLoop(point: V2, loop: V2[]): boolean {
  if (loop.length < 3) return false
  let inside = false
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const [xi, yi] = loop[i]
    const [xj, yj] = loop[j]
    if ((yi > point[1]) !== (yj > point[1]) &&
        point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi) {
      inside = !inside
    }
  }
  return inside
}

function profileHitDistance(profile: ProfileRegion, ray: RayLike): number | null {
  const normal = normalize(profile.plane.normal)
  if (normal === null) return null
  const rawX = sub(profile.plane.xDir, scale(normal, dot(profile.plane.xDir, normal)))
  const xDir = normalize(rawX)
  if (xDir === null) return null
  const yDir = normalize(cross(normal, xDir))
  if (yDir === null) return null

  const denominator = dot(normal, ray.direction)
  if (Math.abs(denominator) < 1e-9) return null
  const distance = dot(normal, sub(profile.plane.origin, ray.origin)) / denominator
  if (!Number.isFinite(distance) || distance < 0) return null

  const worldHit = {
    x: ray.origin.x + ray.direction.x * distance,
    y: ray.origin.y + ray.direction.y * distance,
    z: ray.origin.z + ray.direction.z * distance,
  }
  const fromOrigin = sub(worldHit, profile.plane.origin)
  const localHit: V2 = [dot(fromOrigin, xDir), dot(fromOrigin, yDir)]
  let containingLoops = 0
  for (const loop of profile.loops) {
    if (pointInLoop(localHit, tessellateLoop(loop))) containingLoops++
  }
  return containingLoops % 2 === 1 ? distance : null
}

/** Resolve the closest closed sketch region pierced by a workbench camera ray.
 * Profiles keep their existing DAG sketch ids; this picker introduces no
 * parallel geometry identity or selection model. */
export function pickProfileRegion(
  candidates: readonly ProfilePickCandidate[],
  ray: RayLike,
): ProfilePickResult | null {
  let closest: ProfilePickResult | null = null
  let closestDistance = Number.POSITIVE_INFINITY
  for (const candidate of candidates) {
    const distance = profileHitDistance(candidate.profile, ray)
    if (distance !== null && distance < closestDistance) {
      closestDistance = distance
      closest = {
        sketchId: candidate.sketchId,
        profileSelector: candidate.profileSelector,
      }
    }
  }
  return closest
}
