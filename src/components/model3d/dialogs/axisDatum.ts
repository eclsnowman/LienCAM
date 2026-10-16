// WO-2222 (Construct: Axis): what a viewport pick makes, and how an axis datum is drawn. The line
// rules themselves live in src/sketch3d/datumAxis.ts (computeAxisLine) so the pick here, the regen
// executor and the dialog's Apply all agree. This file only turns picked mesh elements into that
// module's inputs: the face references (faces are what the ElementMap tracks -- an edge is named by
// its two faces, a vertex by the faces its edges touch) and the seed line the pick shows.
//
// Rule 11: every pick makes the axis it can. A flat face picked for a hole axis gives its normal; a
// round edge picked for an edge axis gives the circle's axis; a curved edge with no axial neighbour
// gives the circle through its points, held where it was picked.

import { textFor } from '../../../i18n'
const workbenchText = textFor('sketch-and-model-workbench')
import * as THREE from 'three'
import type { CachedBody } from '../../../viewport3d'
import type { StableId, Vec3 } from '../../../geom/geom-service'
import { parseStableId } from '../../../doc/stable-id'
import {
  computeAxisLine,
  DEFAULT_AXIS_LENGTH,
  type AxisDefinitionKind,
  type AxisFaceGeometry,
  type AxisFaceRefInput,
  type AxisLine,
} from '../../../sketch3d'
import { asNumber } from '../../../theme/viewportColors'

export type AxisFaceLookup = (faceId: StableId) => Promise<AxisFaceGeometry | undefined>

/** What one pick (or, for two points, the pair) makes. */
export interface AxisPick {
  kind: AxisDefinitionKind
  faces: AxisFaceRefInput[]
  ownerIds: string[]
  /** unflipped */
  seed: AxisLine
  /** in the operator's words: what the axis goes through */
  said: string
}

export type AxisPickOutcome = { ok: true; pick: AxisPick } | { ok: false; message: string }

/** One picked vertex: where it is and the faces that meet there. */
export interface AxisPickedPoint {
  point: Vec3
  faceIds: StableId[]
  ownerId: string
}

const v3 = (p: { x: number; y: number; z: number }): Vec3 => ({ x: p.x, y: p.y, z: p.z })
const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z })
const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z
const cross = (a: Vec3, b: Vec3): Vec3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x })
const len = (a: Vec3): number => Math.hypot(a.x, a.y, a.z)
const along = (o: Vec3, d: Vec3, t: number): Vec3 => ({ x: o.x + d.x * t, y: o.y + d.y * t, z: o.z + d.z * t })

function tessellatedPoints(body: CachedBody, faceId: StableId): Vec3[] {
  const index = body.geometry.getIndex()
  const position = body.geometry.getAttribute('position')
  if (index === null || position === undefined) return []
  const points: Vec3[] = []
  for (let t = 0; t < body.triFace.length; t++) {
    if (body.faceIds[body.triFace[t]] !== faceId) continue
    for (let k = 0; k < 3; k++) {
      const vi = index.getX(t * 3 + k)
      points.push({ x: position.getX(vi), y: position.getY(vi), z: position.getZ(vi) })
    }
  }
  return points
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

/** The line's piece that spans `points` (the face as drawn); the line itself unchanged. */
function spanOver(line: AxisLine, points: readonly Vec3[]): AxisLine {
  if (points.length === 0) return line
  let lo = Infinity
  let hi = -Infinity
  for (const p of points) {
    const t = dot(sub(p, line.origin), line.dir)
    lo = Math.min(lo, t)
    hi = Math.max(hi, t)
  }
  if (!(hi - lo > 1e-6)) return line
  return { origin: along(line.origin, line.dir, lo), dir: line.dir, length: hi - lo }
}

/** The two faces an edge id names (seams and unknown operands dropped). */
export function facesOfEdge(edgeId: StableId): StableId[] {
  const parsed = parseStableId(edgeId)
  if (parsed.kind !== 'edge') return []
  return parsed.operands.map((operand) => operand.raw)
}

/** The faces that meet at a picked vertex: every face its adjacent edges name. */
export function facesOfVertex(adjacentEdgeIds: readonly StableId[]): StableId[] {
  return [...new Set(adjacentEdgeIds.flatMap(facesOfEdge))]
}

async function knownFaces(faceIds: readonly StableId[], lookup: AxisFaceLookup): Promise<{ id: StableId; geometry: AxisFaceGeometry }[]> {
  const out: { id: StableId; geometry: AxisFaceGeometry }[] = []
  for (const id of faceIds) {
    const geometry = await lookup(id)
    if (geometry !== undefined) out.push({ id, geometry })
  }
  return out
}

/** A face picked for "through a cylinder or hole". */
export async function axisFromFacePick(body: CachedBody, ownerId: string, faceId: StableId, lookup: AxisFaceLookup): Promise<AxisPickOutcome> {
  const geometry = await lookup(faceId)
  if (geometry === undefined) return { ok: false, message: workbenchText('axisDatum.axisThatFaceHasNoCapturedGeometryYetPick') }
  const made = computeAxisLine('cylinder', [{ role: 'axisFace', geometry }])
  if (!made.ok) return { ok: false, message: workbenchText('axisDatum.axisThatFaceHasNoAxis', { reason: String(made.reason) }) }
  const round = geometry.axis !== undefined && geometry.surfaceType !== 'plane'
  return {
    ok: true,
    pick: {
      kind: 'cylinder',
      faces: [{ role: 'axisFace', faceId }],
      ownerIds: [ownerId],
      seed: round ? spanOver(made.axis, tessellatedPoints(body, faceId)) : made.axis,
      said: round ? workbenchText('axisDatum.theSAxis', { value1: String(geometry.surfaceType === 'cylinder' ? workbenchText('axisDatum.cylinderOrHole') : workbenchText('axisDatum.face', { value1: String(geometry.surfaceType) })) }) : workbenchText('axisDatum.squareToTheFlatFaceThroughItsCentre'),
    },
  }
}

/** The axis of the circle through three points of a curved polyline, spanning nothing (a point). */
function circleAxis(points: readonly Vec3[]): AxisLine | undefined {
  if (points.length < 3) return undefined
  const a = points[0]
  const b = points[Math.floor(points.length / 3)]
  const c = points[Math.floor((2 * points.length) / 3)]
  const ab = sub(b, a)
  const ac = sub(c, a)
  const n = cross(ab, ac)
  const nn = dot(n, n)
  if (!(nn > 1e-18)) return undefined
  // circumcentre of a, b, c
  const t1 = cross(n, ab)
  const t2 = cross(ac, n)
  const k1 = dot(ac, ac) / (2 * nn)
  const k2 = dot(ab, ab) / (2 * nn)
  const centre = { x: a.x + t1.x * k1 + t2.x * k2, y: a.y + t1.y * k1 + t2.y * k2, z: a.z + t1.z * k1 + t2.z * k2 }
  const dir = { x: n.x / Math.sqrt(nn), y: n.y / Math.sqrt(nn), z: n.z / Math.sqrt(nn) }
  return { origin: along(centre, dir, -DEFAULT_AXIS_LENGTH / 2), dir, length: DEFAULT_AXIS_LENGTH }
}

/** An edge picked for "along an edge". */
export async function axisFromEdgePick(body: CachedBody, ownerId: string, edgeId: StableId, lookup: AxisFaceLookup): Promise<AxisPickOutcome> {
  const points = edgePolyline(body, edgeId)
  const faces = await knownFaces(facesOfEdge(edgeId), lookup)
  if (points.length === 2) {
    const d = sub(points[1], points[0])
    const span = len(d)
    if (!(span > 1e-9)) return { ok: false, message: workbenchText('axisDatum.axisThatEdgeHasNoLength') }
    const seed: AxisLine = { origin: points[0], dir: { x: d.x / span, y: d.y / span, z: d.z / span }, length: span }
    const made = computeAxisLine('edge', faces.map((face) => ({ role: 'edgeFace' as const, geometry: face.geometry })), seed)
    return {
      ok: true,
      pick: {
        kind: 'edge',
        faces: faces.map((face) => ({ role: 'edgeFace', faceId: face.id })),
        ownerIds: [ownerId],
        seed: made.ok ? made.axis : seed,
        said: workbenchText('axisDatum.alongTheEdge'),
      },
    }
  }
  // a round edge: the axis of the round face beside it, else of the circle it draws
  const axial = faces.find((face) => face.geometry.axis !== undefined && face.geometry.surfaceType !== 'plane')
  if (axial !== undefined) {
    const fromFace = await axisFromFacePick(body, ownerId, axial.id, lookup)
    if (fromFace.ok) return { ok: true, pick: { ...fromFace.pick, said: workbenchText('axisDatum.theRoundEdgeSAxis') } }
  }
  const circle = circleAxis(points)
  if (circle === undefined) return { ok: false, message: workbenchText('axisDatum.axisThatEdgeIsNeitherStraightNorRoundPick') }
  return { ok: true, pick: { kind: 'edge', faces: [], ownerIds: [ownerId], seed: circle, said: workbenchText('axisDatum.theCurvedEdgeSCentreLineHeldWhereIt') } }
}

/** A picked vertex: its position and the faces that meet there. */
export async function axisPointFromVertexPick(point: Vec3, ownerId: string, adjacentEdgeIds: readonly StableId[], lookup: AxisFaceLookup): Promise<AxisPickedPoint> {
  const faces = await knownFaces(facesOfVertex(adjacentEdgeIds), lookup)
  return { point: v3(point), faceIds: faces.map((face) => face.id), ownerId }
}

/** "Through two points": first to second. */
export function axisFromTwoPoints(a: AxisPickedPoint, b: AxisPickedPoint): AxisPickOutcome {
  const d = sub(b.point, a.point)
  const span = len(d)
  if (!(span > 1e-9)) return { ok: false, message: workbenchText('axisDatum.axisTheSecondPointIsTheFirstPointPick') }
  return {
    ok: true,
    pick: {
      kind: 'two-points',
      faces: [...a.faceIds.map((faceId) => ({ role: 'pointA' as const, faceId })), ...b.faceIds.map((faceId) => ({ role: 'pointB' as const, faceId }))],
      ownerIds: [...new Set([a.ownerId, b.ownerId])],
      seed: { origin: a.point, dir: { x: d.x / span, y: d.y / span, z: d.z / span }, length: span },
      said: workbenchText('axisDatum.throughTheTwoPoints'),
    },
  }
}

// ------------------------------------------------------------------ glyph

export type AxisGlyphVariant = 'ambient' | 'emphasis' | 'preview'

/** How far the drawn axis runs past each end of its segment: a quarter of it, at least this, mm. */
const AXIS_OVERRUN_MIN_MM = 8
const ARROW_LEN_MM = 4
const ARROW_RADIUS_MM = 1.3

/**
 * An axis datum in the viewport: the drafting mark for an axis -- a long-dash, dot centre line -- over
 * its segment and past each end, with an arrowhead at the far end showing which way it runs.
 *
 * The visible part is a thin solid tube, not a hairline (WebGL draws every line one pixel wide), in a
 * deeper shade of the planes' construction blue so it reads against a light body; solids hide it.
 * Where it runs inside the part, a faint see-through hairline carries on, the way a hidden centre
 * line is drawn -- so a hole's axis still reads straight through the hole.
 */
export function buildAxisDatumGlyph(nodeId: string, line: AxisLine, variant: AxisGlyphVariant = 'ambient'): THREE.Object3D {
  const base = new THREE.Color(asNumber('--vp-construction-plane'))
  const deep = base.clone().lerp(new THREE.Color(0x0b2a4a), 0.45)
  const solidColor = variant === 'ambient' ? deep : base
  const group = new THREE.Group()
  group.name = `axis-datum:${nodeId}`
  group.userData.axisDatumNodeId = nodeId
  group.userData.axisDatumVariant = variant
  group.renderOrder = variant === 'ambient' ? 1 : 2
  const dir = new THREE.Vector3(line.dir.x, line.dir.y, line.dir.z).normalize()
  const overrun = Math.max(AXIS_OVERRUN_MIN_MM, line.length / 4)
  const total = line.length + 2 * overrun
  const start = new THREE.Vector3(line.origin.x, line.origin.y, line.origin.z).addScaledVector(dir, -overrun)
  const end = start.clone().addScaledVector(dir, total)
  const radius = Math.min(0.6, Math.max(0.22, total * 0.005)) * (variant === 'ambient' ? 1 : 1.5)
  const along = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir)
  const solid = new THREE.MeshBasicMaterial({ color: solidColor, transparent: variant === 'preview', opacity: variant === 'preview' ? 0.85 : 1 })

  // long dash, gap, dot, gap -- scaled to the axis so a short hole axis still shows the pattern
  const dash = Math.min(8, Math.max(2.5, total / 9))
  const dot = dash / 5
  const gap = dash / 4
  const piece = (from: number, to: number): void => {
    const len = Math.min(to, total) - from
    if (len <= 0) return
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, len, 8, 1), solid.clone())
    mesh.position.copy(start).addScaledVector(dir, from + len / 2)
    mesh.quaternion.copy(along)
    mesh.renderOrder = group.renderOrder
    group.add(mesh)
  }
  for (let t = 0; t < total; t += dash + gap + dot + gap) {
    piece(t, t + dash)
    piece(t + dash + gap, t + dash + gap + dot)
  }

  const hidden = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([start, end]),
    new THREE.LineBasicMaterial({ color: base, transparent: true, opacity: variant === 'ambient' ? 0.35 : 0.6, depthTest: false, depthWrite: false }),
  )
  hidden.renderOrder = group.renderOrder + 1
  group.add(hidden)

  const arrow = new THREE.Mesh(
    new THREE.ConeGeometry(ARROW_RADIUS_MM * (variant === 'ambient' ? 1 : 1.3), ARROW_LEN_MM, 16),
    solid.clone(),
  )
  arrow.position.copy(end)
  arrow.quaternion.copy(along)
  arrow.renderOrder = group.renderOrder
  group.add(arrow)
  solid.dispose()
  return group
}


export function disposeAxisDatumGlyph(glyph: THREE.Object3D): void {
  glyph.traverse((obj) => {
    const withGeom = obj as Partial<THREE.Mesh>
    withGeom.geometry?.dispose()
    const material = withGeom.material
    if (Array.isArray(material)) material.forEach((m) => m.dispose())
    else material?.dispose()
  })
}
