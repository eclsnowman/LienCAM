// WO-3008 08b (A3-08 algorithm step 4): one placement transform per part
// instance and one STL recentring rule, on WO-2945's coordinate frames.
//
// Today the app has three placement conventions (BL-208): an imported row's own
// position/rotation, a modelled body's Model Item placement, and an STL's display
// recentring folded in before the pose. This file states each once. Nothing in
// the app calls it yet; the current engine keeps its own copies (see
// src/tests/evidence/WO-3008/repository-record.md for every copy, file:line).
import type { ImportedGeometry, ModelItemPlacementRecord, Vec3 } from '../../types'
import {
  frameRef, mapPoint, mapVector, pointMm, rigidMapFromPose, vectorMm,
  type FrameRef, type RigidMap,
} from '../../lib/geometry/coordinateFrames'
import type { WorldPolicy } from './contracts'

/** Format tag of a modelled-body row (src/lib/cam/modelOrigin.ts MODEL_ORIGIN_FORMAT). */
const MODEL_FORMAT = 'model'
/** Item id a model row with no modelItemId resolves through (src/doc/documentHolder.ts). */
const LEGACY_MODEL_ITEM_ID = 'legacy'

export function isModelRow(geo: Pick<ImportedGeometry, 'format'> | null | undefined): boolean {
  return geo?.format === MODEL_FORMAT
}

/** A pose-only frame pair. The world service has no project epoch of its own;
 * callers that cross a typed boundary build their own revision-bearing refs. */
function poseFrames(entityId: string): { local: FrameRef<'display-local'>; world: FrameRef<'world'> } {
  return {
    local: frameRef({ kind: 'display-local', projectEpoch: 'world-service', entityId, revision: 'pose' }),
    world: frameRef({ kind: 'world', projectEpoch: 'world-service', entityId, revision: 'pose' }),
  }
}

/** T[world <- display-local] for one pose (Euler XYZ degrees, three.js order). */
export function poseMap(pose: { position: Vec3; rotation: Partial<Vec3> | undefined }, entityId = 'pose'): RigidMap<'display-local', 'world'> {
  const { local, world } = poseFrames(entityId)
  return rigidMapFromPose(local, world, {
    position: pose.position,
    rotation: { x: pose.rotation?.x ?? 0, y: pose.rotation?.y ?? 0, z: pose.rotation?.z ?? 0 },
  })
}

export function placePoint(map: RigidMap<'display-local', 'world'>, p: Vec3): Vec3 {
  const { x, y, z } = mapPoint(map, pointMm(map.from, p)).value
  return { x, y, z }
}

/** Image of a local axis under the pose rotation (no translation). */
export function placeDirection(map: RigidMap<'display-local', 'world'>, v: Vec3): Vec3 {
  const { x, y, z } = mapVector(map, vectorMm(map.from, v)).value
  return { x, y, z }
}

/** In-plane yaw in degrees, read off the rotated X axis (atan2), so Euler
 * (180, 180, theta) and (0, 0, theta - 180) give the same answer. */
export function effectiveYawDeg(rotation: Partial<Vec3> | undefined): number {
  const u = placeDirection(poseMap({ position: { x: 0, y: 0, z: 0 }, rotation }), { x: 1, y: 0, z: 0 })
  return (Math.atan2(u.y, u.x) * 180) / Math.PI
}

/**
 * THE STL recentring rule: the translation to ADD to a raw STL coordinate to get
 * the display-local frame every STL consumer works in (centre X/Y, bottom Z on
 * zero). An empty buffer has no shift.
 */
export function stlRecentreShift(positions: ArrayLike<number>): Vec3 {
  let minX = Infinity, minY = Infinity, minZ = Infinity
  let maxX = -Infinity, maxY = -Infinity
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2]
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
    if (z < minZ) minZ = z
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, z: 0 }
  return { x: -(minX + maxX) / 2, y: -(minY + maxY) / 2, z: -minZ }
}

export type PartPlacement =
  | {
    readonly ok: true
    readonly source: 'geometry-pose' | 'model-placement'
    readonly position: Vec3
    readonly rotation: Vec3
    /** T[world <- display-local]. */
    readonly toWorld: RigidMap<'display-local', 'world'>
  }
  | { readonly ok: false; readonly reason: 'no-placement'; readonly modelItemId: string; readonly bodyId?: string }

/**
 * The one placement of a part instance. Imported rows carry their own world pose;
 * a modelled body's own pose stays identity and its Model Item placement is the
 * source (body-specific record first, then the item record). A model row with no
 * record has no placement, never an identity stand-in.
 */
export function partPlacement(
  geo: Pick<ImportedGeometry, 'id' | 'format' | 'position' | 'rotation' | 'modelItemId' | 'modelBody'>,
  placements: readonly ModelItemPlacementRecord[] = [],
): PartPlacement {
  if (isModelRow(geo)) {
    const modelItemId = geo.modelItemId ?? LEGACY_MODEL_ITEM_ID
    const bodyId = geo.modelBody?.ref.bodyId
    const record = (bodyId !== undefined
      ? placements.find(entry => entry.modelItemId === modelItemId && entry.bodyId === bodyId)
      : undefined) ?? placements.find(entry => entry.modelItemId === modelItemId && entry.bodyId === undefined)
    if (!record) return { ok: false, reason: 'no-placement', modelItemId, ...(bodyId !== undefined ? { bodyId } : {}) }
    return {
      ok: true, source: 'model-placement', position: record.position, rotation: record.rotation,
      toWorld: poseMap(record, geo.id),
    }
  }
  const rotation = { x: geo.rotation?.x ?? 0, y: geo.rotation?.y ?? 0, z: geo.rotation?.z ?? 0 }
  return { ok: true, source: 'geometry-pose', position: geo.position, rotation, toWorld: poseMap({ position: geo.position, rotation }, geo.id) }
}

/** The 3D compute and Smart Height preview routes that refuse a part turned about X or Y. */
export type RotatedPartRoute =
  | 'parallel-compute' | 'parallel-preview'
  | 'waterline-compute' | 'waterline-preview'
  | 'adaptive-compute' | 'adaptive-preview'

/** Today's operator line for each refusal, as its i18n key in
 * src/i18n/locales/en/console-and-operator-messages.ts. value1 is the operation
 * name and value2 the part name where the line names them. `imported` is the
 * pre-check on an imported row's own rotation; `resolved` the check on the
 * resolved part rotation (Model Item placement for a modelled body). */
export const ROTATED_PART_REFUSAL_KEYS: Readonly<Record<RotatedPartRoute, { imported?: string; resolved: string }>> = Object.freeze({
  'parallel-compute': { imported: 'index50', resolved: 'index57' },
  'parallel-preview': { imported: 'index67', resolved: 'index74' },
  'waterline-compute': { imported: 'index78', resolved: 'index86' },
  'waterline-preview': { imported: 'index100', resolved: 'index107' },
  'adaptive-compute': { resolved: 'index276' },
  'adaptive-preview': { resolved: 'index122' },
})

export type RotatedPartDecision =
  | { readonly refused: false; readonly placement?: PartPlacement }
  | { readonly refused: true; readonly operatorKey: string; readonly values: { value1: string; value2: string } }

const turnedAboutXOrY = (rotation: Partial<Vec3> | undefined) => (rotation?.x ?? 0) !== 0 || (rotation?.y ?? 0) !== 0

/**
 * MD-43 policy point. Off (parity): the same exact X/Y test, in the same order,
 * that the six routes run today: an imported row's own rotation first (where the
 * route has that pre-check), then the resolved part rotation. On: the part is
 * placed through partPlacement and nothing is refused here.
 */
export function rotatedPartDecision(
  route: RotatedPartRoute,
  operationName: string,
  geo: Pick<ImportedGeometry, 'id' | 'name' | 'format' | 'position' | 'rotation' | 'modelItemId' | 'modelBody'>,
  placements: readonly ModelItemPlacementRecord[],
  policy: WorldPolicy,
): RotatedPartDecision {
  const placement = partPlacement(geo, placements)
  if (policy.rotated_part_placement) return { refused: false, placement }
  const keys = ROTATED_PART_REFUSAL_KEYS[route]
  const values = { value1: operationName, value2: geo.name }
  const imported = !isModelRow(geo)
  if (keys.imported && imported && turnedAboutXOrY(geo.rotation)) return { refused: true, operatorKey: keys.imported, values }
  if (placement.ok && turnedAboutXOrY(placement.rotation)) return { refused: true, operatorKey: keys.resolved, values }
  return { refused: false, placement }
}
