// WO-2223 (Construct, second wave): what viewport picks make for the picked planes (through three
// points, through two edges, tangent to a face) and the Point datum, and how a point is drawn. The
// rules live in src/sketch3d/datumConstruct.ts so the pick here, the regen executor and Apply all
// agree; this file turns picked mesh elements into that module's inputs (face references and the
// seed the pick shows), the way axisDatum.ts does for the Axis.
//
// Rule 11: every pick makes what it can. A round edge where an edge is wanted gives its centre line;
// a flat face for a tangent plane gives its own plane; a straight edge for a circle centre gives the
// edge's middle; a flat face for a circle centre gives the face's centre.

import { textFor } from '../../../i18n'
const workbenchText = textFor('sketch-and-model-workbench')
import * as THREE from 'three'
import type { CachedBody } from '../../../viewport3d'
import type { StableId, Vec3 } from '../../../geom/geom-service'
import {
  circleCentre,
  computeDatumPoint,
  pickedPlaneFrame,
  tangentSeed,
  type AxisLine,
  type ConstructFaceRefInput,
  type ConstructLineKind,
  type ConstructRefRole,
  type PickedPlaneKind,
  type PickedPlaneState,
  type PlaneFrame,
  type PointDefinitionKind,
} from '../../../sketch3d'
import { asNumber } from '../../../theme/viewportColors'
import { axisFromEdgePick, facesOfEdge, type AxisFaceLookup, type AxisPickedPoint } from './axisDatum'

/** One picked edge, as the line it makes (a round edge: its centre line). */
export interface PickedLine {
  kind: ConstructLineKind
  faceIds: StableId[]
  ownerId: string
  line: AxisLine
  said: string
}

/** What the picks make for a picked plane. */
export interface PickedPlanePick {
  kind: PickedPlaneKind
  faces: ConstructFaceRefInput[]
  ownerIds: string[]
  seed: PickedPlaneState
  lineKinds?: [ConstructLineKind, ConstructLineKind]
  /** in the operator's words: what the plane goes through */
  said: string
}

/** What the picks make for a point. `consumes` holds the owning bodies and, for an edge meeting a
 *  datum plane, that plane. */
export interface PointPick {
  kind: PointDefinitionKind
  faces: ConstructFaceRefInput[]
  consumes: string[]
  seed: Vec3
  seedLine?: AxisLine
  lineKind?: ConstructLineKind
  said: string
}

export type Outcome<T> = { ok: true; pick: T } | { ok: false; message: string }

const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z })
const cross = (a: Vec3, b: Vec3): Vec3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x })
const len = (a: Vec3): number => Math.hypot(a.x, a.y, a.z)
const v3 = (p: { x: number; y: number; z: number }): Vec3 => ({ x: p.x, y: p.y, z: p.z })

const roleFaces = (role: ConstructRefRole, faceIds: readonly StableId[]): ConstructFaceRefInput[] => faceIds.map((faceId) => ({ role, faceId }))

// ------------------------------------------------------------------ planes

/** Through three points, first to second to third (the normal by the right hand). */
export function planeFromThreePoints(points: readonly AxisPickedPoint[]): Outcome<PickedPlanePick> {
  const [a, b, c] = points
  const seed: PickedPlaneState = { kind: 'three-points', points: [a.point, b.point, c.point] }
  const framed = pickedPlaneFrame(seed, false)
  if (!framed.ok) return { ok: false, message: workbenchText('constructDatum.planeTheThreePointsAreOnOneLinePick') }
  return {
    ok: true,
    pick: {
      kind: 'three-points',
      faces: [...roleFaces('pointA', a.faceIds), ...roleFaces('pointB', b.faceIds), ...roleFaces('pointC', c.faceIds)],
      ownerIds: [...new Set([a.ownerId, b.ownerId, c.ownerId])],
      seed,
      said: workbenchText('constructDatum.throughTheThreePoints'),
    },
  }
}

/** One picked edge as a line: a straight edge along itself, a round edge its centre line. */
export async function lineFromEdgePick(body: CachedBody, ownerId: string, edgeId: StableId, lookup: AxisFaceLookup): Promise<Outcome<PickedLine>> {
  const outcome = await axisFromEdgePick(body, ownerId, edgeId, lookup)
  if (!outcome.ok) return { ok: false, message: outcome.message.replace(/^Axis: /, '') }
  const { pick } = outcome
  return {
    ok: true,
    pick: {
      kind: pick.kind === 'cylinder' ? 'cylinder' : 'edge',
      faceIds: pick.faces.map((face) => face.faceId),
      ownerId,
      line: pick.seed,
      said: pick.said,
    },
  }
}

/** Through two edges. Where they do not meet, it holds the first and runs parallel to the second. */
export function planeFromTwoLines(a: PickedLine, b: PickedLine): Outcome<PickedPlanePick> {
  const seed: PickedPlaneState = { kind: 'two-edges', lines: [a.line, b.line] }
  const framed = pickedPlaneFrame(seed, false)
  if (!framed.ok) return { ok: false, message: workbenchText('constructDatum.planeTheTwoEdgesAreOnOneLinePick') }
  const meet = len(cross(a.line.dir, b.line.dir)) > 1e-6
  const gap = Math.abs(
    (b.line.origin.x - a.line.origin.x) * framed.frame.normal.x + (b.line.origin.y - a.line.origin.y) * framed.frame.normal.y + (b.line.origin.z - a.line.origin.z) * framed.frame.normal.z,
  )
  return {
    ok: true,
    pick: {
      kind: 'two-edges',
      faces: [...roleFaces('lineA', a.faceIds), ...roleFaces('lineB', b.faceIds)],
      ownerIds: [...new Set([a.ownerId, b.ownerId])],
      seed,
      lineKinds: [a.kind, b.kind],
      said: meet && gap > 1e-6 ? workbenchText('constructDatum.throughTheFirstEdgeParallelToTheSecondThey') : workbenchText('constructDatum.throughTheTwoEdges'),
    },
  }
}

/** The outward normal of the tessellated triangle of `faceId` nearest `point` (for a surface the
 *  tangent rule has no analytic answer for). */
export function meshNormalNear(body: CachedBody, faceId: StableId, point: Vec3): Vec3 | undefined {
  const index = body.geometry.getIndex()
  const position = body.geometry.getAttribute('position')
  if (index === null || position === undefined) return undefined
  let best: Vec3 | undefined
  let bestDistance = Infinity
  for (let t = 0; t < body.triFace.length; t++) {
    if (body.faceIds[body.triFace[t]] !== faceId) continue
    const corner = (k: number): Vec3 => {
      const vi = index.getX(t * 3 + k)
      return { x: position.getX(vi), y: position.getY(vi), z: position.getZ(vi) }
    }
    const p0 = corner(0), p1 = corner(1), p2 = corner(2)
    const centre = { x: (p0.x + p1.x + p2.x) / 3, y: (p0.y + p1.y + p2.y) / 3, z: (p0.z + p1.z + p2.z) / 3 }
    const d = len(sub(centre, point))
    const n = cross(sub(p1, p0), sub(p2, p0))
    if (d < bestDistance && len(n) > 1e-12) {
      bestDistance = d
      best = n
    }
  }
  return best
}

/** Tangent to the face clicked, touching it where it was clicked. */
export async function planeTangentAt(body: CachedBody, ownerId: string, faceId: StableId, hit: Vec3, lookup: AxisFaceLookup): Promise<Outcome<PickedPlanePick>> {
  const geometry = await lookup(faceId)
  if (geometry === undefined) return { ok: false, message: workbenchText('constructDatum.planeThatFaceHasNoCapturedGeometryYetPick') }
  const seed = tangentSeed(geometry, v3(hit), meshNormalNear(body, faceId, v3(hit)))
  if (seed === undefined) return { ok: false, message: workbenchText('constructDatum.planeThatFaceHasNoDirectionAtTheClick') }
  const said = geometry.surfaceType === 'plane'
    ? workbenchText('constructDatum.onTheFlatFaceItsOwnPlane')
    : geometry.surfaceType === 'cylinder' && geometry.axis !== undefined
      ? workbenchText('constructDatum.tangentToTheRoundFaceWhereYouClicked')
      : workbenchText('constructDatum.squareToTheFaceWhereYouClickedHeldThere', { surfaceType: String(geometry.surfaceType) })
  return { ok: true, pick: { kind: 'tangent', faces: roleFaces('tangentFace', [faceId]), ownerIds: [ownerId], seed, said } }
}

// ------------------------------------------------------------------ points

/** A point at a picked vertex. */
export function pointAtVertex(point: AxisPickedPoint): PointPick {
  return { kind: 'vertex', faces: roleFaces('pointFace', point.faceIds), consumes: [point.ownerId], seed: point.point, said: workbenchText('constructDatum.atTheVertex') }
}

function circumcentre(points: readonly Vec3[]): Vec3 | undefined {
  if (points.length < 3) return undefined
  const a = points[0]
  const b = points[Math.floor(points.length / 3)]
  const c = points[Math.floor((2 * points.length) / 3)]
  const ab = sub(b, a)
  const ac = sub(c, a)
  const n = cross(ab, ac)
  const nn = n.x * n.x + n.y * n.y + n.z * n.z
  if (!(nn > 1e-18)) return undefined
  const t1 = cross(n, ab)
  const t2 = cross(ac, n)
  const k1 = (ac.x * ac.x + ac.y * ac.y + ac.z * ac.z) / (2 * nn)
  const k2 = (ab.x * ab.x + ab.y * ab.y + ab.z * ab.z) / (2 * nn)
  return { x: a.x + t1.x * k1 + t2.x * k2, y: a.y + t1.y * k1 + t2.y * k2, z: a.z + t1.z * k1 + t2.z * k2 }
}

function edgePolyline(body: CachedBody, edgeId: StableId): Vec3[] {
  const e = body.edgeIds.indexOf(edgeId)
  if (e === -1) return []
  const points: Vec3[] = []
  for (let p = body.edgeOffsets[e]; p < body.edgeOffsets[e + 1]; p++) {
    points.push({ x: body.edgePositions[p * 3], y: body.edgePositions[p * 3 + 1], z: body.edgePositions[p * 3 + 2] })
  }
  return points
}

/** A circle's centre from a picked edge: a round edge's centre; a straight edge's middle. */
export async function pointAtCircleEdge(body: CachedBody, ownerId: string, edgeId: StableId, lookup: AxisFaceLookup): Promise<Outcome<PointPick>> {
  const points = edgePolyline(body, edgeId)
  if (points.length < 2) return { ok: false, message: workbenchText('constructDatum.pointThatEdgeHasNoDrawnPointsPickIt') }
  const faceIds = facesOfEdge(edgeId)
  const known: { id: StableId; geometry: NonNullable<Awaited<ReturnType<AxisFaceLookup>>> }[] = []
  for (const id of faceIds) {
    const geometry = await lookup(id)
    if (geometry !== undefined) known.push({ id, geometry })
  }
  const round = circumcentre(points)
  const start = round ?? { x: (points[0].x + points[points.length - 1].x) / 2, y: (points[0].y + points[points.length - 1].y) / 2, z: (points[0].z + points[points.length - 1].z) / 2 }
  const seed = round === undefined ? start : circleCentre(known.map((face) => face.geometry), start)
  // a straight edge's middle rides only its flat faces (a round neighbour's axis is not its middle)
  const kept = round === undefined ? known.filter((face) => face.geometry.surfaceType === 'plane') : known
  return {
    ok: true,
    pick: {
      kind: 'circle-centre',
      faces: roleFaces('pointFace', kept.map((face) => face.id)),
      consumes: [ownerId],
      seed,
      said: round === undefined ? workbenchText('constructDatum.atTheStraightEdgeSMiddleHeldThere') : workbenchText('constructDatum.atTheCircleSCentre'),
    },
  }
}

/** A circle's centre from a picked face: a round face's axis at its middle; a flat face's centre. */
export async function pointAtCircleFace(ownerId: string, faceId: StableId, lookup: AxisFaceLookup): Promise<Outcome<PointPick>> {
  const geometry = await lookup(faceId)
  if (geometry === undefined) return { ok: false, message: workbenchText('constructDatum.pointThatFaceHasNoCapturedGeometryYetPick') }
  const made = computeDatumPoint({ kind: 'circle-centre' }, [{ role: 'pointFace', geometry }], { point: geometry.centroid })
  if (!made.ok) return { ok: false, message: workbenchText('constructDatum.point', { reason: String(made.reason) }) }
  return {
    ok: true,
    pick: {
      kind: 'circle-centre',
      faces: roleFaces('pointFace', [faceId]),
      consumes: [ownerId],
      seed: made.point,
      said: geometry.surfaceType === 'plane' ? workbenchText('constructDatum.atTheFlatFaceSCentre') : workbenchText('constructDatum.onTheRoundFaceSAxisAtItsMiddle'),
    },
  }
}

/** Where a picked edge (or a round edge's centre line) meets a plane: a datum plane (consumed) or
 *  a flat face (referenced). */
export function pointWhereLineMeets(
  line: PickedLine,
  plane: { kind: 'datum'; id: string; frame: Pick<PlaneFrame, 'origin' | 'normal'>; label: string } | { kind: 'face'; faceId: StableId; ownerId: string; frame: Pick<PlaneFrame, 'origin' | 'normal'> },
): Outcome<PointPick> {
  const faces: ConstructFaceRefInput[] = roleFaces('lineA', line.faceIds)
  if (plane.kind === 'face') faces.push({ role: 'planeFace', faceId: plane.faceId })
  const made = computeDatumPoint({ kind: 'edge-plane', lineKind: line.kind }, [], { line: line.line }, plane.frame)
  if (!made.ok) return { ok: false, message: workbenchText('constructDatum.pointThatEdgeRunsParallelToThePlaneThey') }
  return {
    ok: true,
    pick: {
      kind: 'edge-plane',
      faces,
      consumes: [...new Set([line.ownerId, ...(plane.kind === 'datum' ? [plane.id] : [plane.ownerId])])],
      seed: made.point,
      seedLine: line.line,
      lineKind: line.kind,
      said: workbenchText('constructDatum.whereMeets', { value1: String(line.kind === 'cylinder' ? workbenchText('constructDatum.theRoundEdgeSCentreLine') : workbenchText('constructDatum.theEdge')), value2: String(plane.kind === 'datum' ? plane.label : workbenchText('constructDatum.theFace')) }),
    },
  }
}

// ------------------------------------------------------------------ glyph

export type PointGlyphVariant = 'ambient' | 'emphasis' | 'preview'

const POINT_ARM_MM = 3
const POINT_BALL_MM = 0.9

/**
 * A point datum in the viewport: a small ball with three short arms along X, Y and Z (the drafting
 * mark for a point in space), in the construction blue the planes and axes use. A faint see-through
 * copy of the ball keeps a point inside the part findable.
 */
export function buildPointDatumGlyph(nodeId: string, point: Vec3, variant: PointGlyphVariant = 'ambient'): THREE.Object3D {
  const base = new THREE.Color(asNumber('--vp-construction-plane'))
  const deep = base.clone().lerp(new THREE.Color(0x0b2a4a), 0.45)
  const group = new THREE.Group()
  group.name = `point-datum:${nodeId}`
  group.userData.pointDatumNodeId = nodeId
  group.userData.pointDatumVariant = variant
  group.renderOrder = variant === 'ambient' ? 1 : 2
  group.position.set(point.x, point.y, point.z)
  const scale = variant === 'ambient' ? 1 : 1.4
  const solid = new THREE.MeshBasicMaterial({ color: variant === 'ambient' ? deep : base, transparent: variant === 'preview', opacity: variant === 'preview' ? 0.85 : 1 })
  const ball = new THREE.Mesh(new THREE.SphereGeometry(POINT_BALL_MM * scale, 16, 12), solid.clone())
  ball.renderOrder = group.renderOrder
  group.add(ball)
  const radius = 0.22 * scale
  const arms: Array<[THREE.Vector3, THREE.Euler]> = [
    [new THREE.Vector3(1, 0, 0), new THREE.Euler(0, 0, Math.PI / 2)],
    [new THREE.Vector3(0, 1, 0), new THREE.Euler(0, 0, 0)],
    [new THREE.Vector3(0, 0, 1), new THREE.Euler(Math.PI / 2, 0, 0)],
  ]
  for (const [, rotation] of arms) {
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, 2 * POINT_ARM_MM * scale, 8, 1), solid.clone())
    arm.rotation.copy(rotation)
    arm.renderOrder = group.renderOrder
    group.add(arm)
  }
  const ghost = new THREE.Mesh(
    new THREE.SphereGeometry(POINT_BALL_MM * scale, 12, 8),
    new THREE.MeshBasicMaterial({ color: base, transparent: true, opacity: variant === 'ambient' ? 0.35 : 0.6, depthTest: false, depthWrite: false }),
  )
  ghost.renderOrder = group.renderOrder + 1
  group.add(ghost)
  solid.dispose()
  return group
}

export function disposePointDatumGlyph(glyph: THREE.Object3D): void {
  glyph.traverse((obj) => {
    const withGeom = obj as Partial<THREE.Mesh>
    withGeom.geometry?.dispose()
    const material = withGeom.material
    if (Array.isArray(material)) material.forEach((m) => m.dispose())
    else material?.dispose()
  })
}
