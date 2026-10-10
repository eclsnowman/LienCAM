// WO-1574: "Seat in vise" - two face picks (a face on the workholding body,
// a face on the part) produce ONE rigid transform that seats the workholding
// body against the part. The vise moves; the part, stock, work origin and
// operations never do (architect decision on the order, 2026-09-15).
//
// Pure geometry, no store/React dependency, so it composes with
// `updateGeometryTransform` (the existing transform action, store/index.ts)
// exactly the way a gizmo drag or a typed Properties-panel edit already does.
//
// WO-1587: faces now come from the VIEWPORT - `CNCViewport.enterSeatFacePickMode`
// clusters the clicked triangle's coplanar, edge-connected region and hands
// back its world centroid + outward normal, so a stepped jaw, a V-groove face
// or a parallel seats exactly like a bounding-box face. Not one line of the
// seating math below changed to accept them: it always consumed a `FacePick`
// (point + normal), never a face key. `localFaceFromWorld` (added below) is
// the whole adapter - it puts a world pick back into the moving body's frame.
//
// WO-1593: the second contact now SQUARES as well as slides, and every seat
// reports the freedom it leaves. `seatAgainstFace` is the one engine function -
// `seatFirstFace` and `seatSecondFace` are the two rungs of the ladder it
// already had, and the third contact is the same call run against a line.
//
// The six axis-aligned bounding-box faces (`BoxFaceKey`, bottom of this file)
// stay as WO-1574 built them. They are the fallback the strip offers for a
// body the viewport cannot raycast at all - an STL that has not loaded, or a
// 2D-only geometry - where refusing to seat would be us handing the operator
// our problem (rule 11) over a box whose faces we already know exactly.

import type { Vec3 } from '../../types'
import { rotationMatrixXYZ } from '../geometry/rotationMatrixXYZ'

/** A planar face pick: a point on the face and its OUTWARD unit normal, both
 *  in the same frame (LOCAL to one body, or WORLD - callers below are
 *  explicit about which). */
export interface FacePick {
  point: Vec3
  normal: Vec3
}

export interface RigidPose {
  position: Vec3
  rotation: Vec3
}

const EPS = 1e-9

function add(a: Vec3, b: Vec3): Vec3 { return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z } }
function sub(a: Vec3, b: Vec3): Vec3 { return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z } }
function scale(a: Vec3, s: number): Vec3 { return { x: a.x * s, y: a.y * s, z: a.z * s } }
function neg(a: Vec3): Vec3 { return { x: -a.x, y: -a.y, z: -a.z } }
function dot(a: Vec3, b: Vec3): number { return a.x * b.x + a.y * b.y + a.z * b.z }
function cross(a: Vec3, b: Vec3): Vec3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x }
}
function length(a: Vec3): number { return Math.sqrt(dot(a, a)) }
function normalize(a: Vec3): Vec3 {
  const len = length(a)
  if (len < EPS) throw new Error('workholdingSeat: cannot normalize a zero-length vector')
  return scale(a, 1 / len)
}

/** Columns of a 3x3 rotation matrix, the same shape `rotationMatrixXYZ`
 *  (lib/geometry/rotationMatrixXYZ.ts) returns: col1/col2/col3 are the world
 *  images of the local X/Y/Z axes. R * v = col1*v.x + col2*v.y + col3*v.z. */
export interface RotationCols { col1: Vec3; col2: Vec3; col3: Vec3 }

const IDENTITY_COLS: RotationCols = { col1: { x: 1, y: 0, z: 0 }, col2: { x: 0, y: 1, z: 0 }, col3: { x: 0, y: 0, z: 1 } }

function matVec(R: RotationCols, v: Vec3): Vec3 {
  return add(add(scale(R.col1, v.x), scale(R.col2, v.y)), scale(R.col3, v.z))
}

/** A*B, as columns: apply A to each column of B. */
function matMul(A: RotationCols, B: RotationCols): RotationCols {
  return { col1: matVec(A, B.col1), col2: matVec(A, B.col2), col3: matVec(A, B.col3) }
}

/** Inverse of `rotationMatrixXYZ`: recover Euler XYZ degrees (three.js
 *  'XYZ' order, R = Rx*Ry*Rz) from a rotation matrix given as columns.
 *  Mirrors three.js Euler.setFromRotationMatrix('XYZ'), including its
 *  gimbal-lock branch (|col3.x| ~= 1, i.e. Y ~= +/-90deg). */
function eulerXYZFromMatrix(R: RotationCols): Vec3 {
  const m13 = Math.min(1, Math.max(-1, R.col3.x))
  const y = Math.asin(m13)
  let x: number, z: number
  if (Math.abs(m13) < 0.9999999) {
    x = Math.atan2(-R.col3.y, R.col3.z)
    z = Math.atan2(-R.col2.x, R.col1.x)
  } else {
    x = Math.atan2(R.col2.z, R.col2.y)
    z = 0
  }
  const toDeg = 180 / Math.PI
  return { x: x * toDeg, y: y * toDeg, z: z * toDeg }
}

/** The minimal rotation that carries unit vector `a` onto unit vector `b`
 *  (Rodrigues' formula). `a` and `b` are assumed already normalized. Falls
 *  back to an arbitrary perpendicular axis for the degenerate anti-parallel
 *  case (a == -b), where the minimal rotation is not unique. */
function rotationBetweenUnitVectors(a: Vec3, b: Vec3): RotationCols {
  const v = cross(a, b)
  const c = dot(a, b)
  const s2 = dot(v, v)
  if (s2 < 1e-18) {
    if (c > 0) return IDENTITY_COLS
    // Anti-parallel: 180deg about any axis perpendicular to a.
    const seed: Vec3 = Math.abs(a.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 }
    const k = normalize(cross(a, seed))
    const applyHalfTurn = (w: Vec3) => sub(scale(k, 2 * dot(k, w)), w)
    return {
      col1: applyHalfTurn({ x: 1, y: 0, z: 0 }),
      col2: applyHalfTurn({ x: 0, y: 1, z: 0 }),
      col3: applyHalfTurn({ x: 0, y: 0, z: 1 }),
    }
  }
  const k = (1 - c) / s2
  const applyRodrigues = (w: Vec3) => add(add(w, cross(v, w)), scale(cross(v, cross(v, w)), k))
  return {
    col1: applyRodrigues({ x: 1, y: 0, z: 0 }),
    col2: applyRodrigues({ x: 0, y: 1, z: 0 }),
    col3: applyRodrigues({ x: 0, y: 0, z: 1 }),
  }
}

/** The rotation of `angleCos`/`angleSin` about unit axis `k` (Rodrigues, with
 *  the angle supplied as its cosine and sine so callers never round-trip
 *  through `atan2`). */
function rotationAboutAxis(k: Vec3, angleCos: number, angleSin: number): RotationCols {
  const apply = (w: Vec3) => add(
    add(scale(w, angleCos), scale(cross(k, w), angleSin)),
    scale(k, dot(k, w) * (1 - angleCos)),
  )
  return {
    col1: apply({ x: 1, y: 0, z: 0 }),
    col2: apply({ x: 0, y: 1, z: 0 }),
    col3: apply({ x: 0, y: 0, z: 1 }),
  }
}

// ---------------------------------------------------------------------------
// WO-1593: the freedom ladder (ASSEMBLY-MATING-REVIEW.md sections 17-19)
// ---------------------------------------------------------------------------
//
// A rigid body has six freedoms. Three ordered contacts eat them 3-2-1 - the
// machinist's own locating scheme - and no solver is needed for any of them,
// because each contact is closed-form arithmetic on the freedom the one
// before it left:
//
//   free  --contact 1 (a plane)-->  on-plane  --contact 2-->  along-line
//         --contact 3-->  located
//
// There is no under-constrained STATE in this application: every body always
// carries a complete transform. "Remaining freedom" is a prediction about what
// the NEXT contact may change, never a claim that something is unknown - which
// is why it is a sentence (`describeFreedom`) and never a gate (rule 11).

/** The six named freedom states. Never a DOF count: the operator reads a
 *  sentence, and `describeFreedom` below is where every one of them lives. */
export const SEAT_FREEDOM_STATES = [
  'free', 'on-plane', 'along-line', 'located', 'on-axis', 'about-axis',
] as const
export type SeatFreedomState = typeof SEAT_FREEDOM_STATES[number]

/** A freedom state plus the geometry that names it, so the next contact knows
 *  exactly what it is allowed to spend. `on-axis`/`about-axis` are the coaxial
 *  branch (review section 19.1); this order neither produces nor consumes
 *  them, it only gives them a sentence. */
export type SeatFreedom =
  /** Nothing contacted: all six freedoms, the body is wherever it was put. */
  | { state: 'free' }
  /** Lying on a contact plane of world normal `normal`: two slides in that
   *  plane plus the turn about its normal. */
  | { state: 'on-plane'; normal: Vec3 }
  /** One slide left, along world direction `direction`. */
  | { state: 'along-line'; direction: Vec3 }
  /** Nothing left: every number came from the fixture. */
  | { state: 'located' }
  /** Coaxial (S5): slide along `axis` and turn about it. */
  | { state: 'on-axis'; axis: Vec3 }
  /** Coaxial + an end face (S5): the turn about `axis` is all that is left. */
  | { state: 'about-axis'; axis: Vec3 }

/** The freedom of a body nothing has been seated against yet. */
export const SEAT_FREEDOM_FREE: SeatFreedom = { state: 'free' }

/** Every seat returns a pose AND the freedom it leaves. The pose is always a
 *  legal point inside that freedom. */
export interface SeatResult {
  pose: RigidPose
  freedom: SeatFreedom
}

/** The ONE degenerate refusal in this engine (review section 18.4, rule 11):
 *  the freedom the earlier contacts left cannot reach this gap, so the
 *  software genuinely cannot close it - not a preference, not a warning. The
 *  `on-plane` wording is WO-1574's, unchanged. */
function cannotCloseTheGap(state: 'on-plane' | 'along-line'): Error {
  return new Error(
    state === 'on-plane'
      ? 'Seat in vise: the second face is parallel to the first contact plane - sliding along it can never close this gap.'
      : 'Seat in vise: the third face is parallel to the slide the first two contacts left - sliding along it can never close this gap.',
  )
}

/** ONE contact against ONE face, for every rung of the ladder: it spends the
 *  freedom it is given and returns what is left. `facePickLocal` is the MOVING
 *  body's face in its own local frame; `targetFaceWorld` is the stationary
 *  body's face in world space (the part never moves).
 *
 *  LEAST MOTION is a law, not an accident: within the freedom it may spend, a
 *  contact moves the body as little as it can (`rotationBetweenUnitVectors`
 *  takes the minimal rotation). So a seated body keeps the orientation the
 *  operator gave it, and anything the contacts do not constrain stays exactly
 *  where he put it.
 *
 *  `free` -> `on-plane`: rotate the picked normal onto the target's opposite,
 *  then translate purely along that normal to close the gap, so no lateral
 *  position is invented that the picks did not imply.
 *
 *  `on-plane` -> `along-line`: SQUARE, then slide. WHY THE SQUARING CANNOT
 *  BREAK THE FIRST CONTACT: a rotation about an axis parallel to `n1` leaves
 *  every point's `n1` coordinate unchanged, and the first contact is a
 *  condition on exactly that coordinate - so turning the body about `n1`
 *  cannot open, close or tilt it, and neither can sliding inside the contact
 *  plane. (WO-1574 read "rotating would break the first contact", which is
 *  true of a GENERAL rotation and false of this one; that is why the second
 *  contact slid but never squared.)
 *
 *  `along-line` -> `located`: the same function run against a LINE instead of
 *  a plane - one slide, no turn left to spend. Not a third mate type.
 */
export function seatAgainstFace(
  current: RigidPose,
  freedom: SeatFreedom,
  facePickLocal: FacePick,
  targetFaceWorld: FacePick,
): SeatResult {
  const R = rotationMatrixXYZ(current.rotation)
  // Where the moving face's outward normal has to end up: opposed to the
  // target's, so the two faces meet rather than back onto each other.
  const target = neg(normalize(targetFaceWorld.normal))
  const facePointAt = (Rc: RotationCols) => add(matVec(Rc, facePickLocal.point), current.position)

  if (freedom.state === 'free') {
    const currentWorldNormal = normalize(matVec(R, facePickLocal.normal))
    const deltaR = rotationBetweenUnitVectors(currentWorldNormal, target)
    const R1 = matMul(deltaR, R)
    const rotation = eulerXYZFromMatrix(R1)
    const gap = dot(sub(targetFaceWorld.point, facePointAt(R1)), target)
    return {
      pose: { position: add(current.position, scale(target, gap)), rotation },
      freedom: { state: 'on-plane', normal: target },
    }
  }

  if (freedom.state === 'on-plane') {
    const n1 = normalize(freedom.normal)
    const inPlane = (v: Vec3): Vec3 => sub(v, scale(n1, dot(v, n1)))

    // The slide this contact is allowed: the target direction's component
    // inside the first contact plane. No component there means no slide and no
    // turn about n1 could ever close the gap - the one refusal.
    const targetInPlane = inPlane(target)
    const slideMag = length(targetInPlane)
    if (slideMag < 1e-6) throw cannotCloseTheGap('on-plane')
    const m = scale(targetInPlane, 1 / slideMag)

    // SQUARE: turn about n1 until the picked face's in-plane normal direction
    // matches the target's. A DRAFTED face has an n1 component too; rotation
    // about n1 cannot touch that, so it squares the in-plane part and the
    // faces meet along a line - which is what physically happens when you push
    // a drafted part against a flat jaw, and needs no warning.
    let R2 = R
    let rotation = current.rotation
    const faceInPlane = inPlane(normalize(matVec(R, facePickLocal.normal)))
    const faceMag = length(faceInPlane)
    if (faceMag > 1e-9) {
      const a = scale(faceInPlane, 1 / faceMag)
      const angleCos = Math.min(1, Math.max(-1, dot(a, m)))
      const angleSin = dot(cross(a, m), n1)
      // Least motion: already square, so do not re-derive the Euler angles.
      if (Math.abs(angleSin) > 1e-12 || angleCos < 1 - 1e-12) {
        R2 = matMul(rotationAboutAxis(n1, angleCos, angleSin), R)
        rotation = eulerXYZFromMatrix(R2)
      }
    }
    // (faceMag ~ 0 means the picked face is parallel to the first contact
    // plane: no turn about n1 can orient it, so the contact spends only its
    // slide. It closes the gap at the pick point, which the software CAN do -
    // no refusal joins the one above.)

    // SLIDE: inside the contact plane only, so the first contact holds.
    // dot(m, target) is slideMag by construction, so this never divides by ~0.
    const s = dot(sub(targetFaceWorld.point, facePointAt(R2)), target) / slideMag
    // What is left is the intersection of the two contact planes: the line the
    // part still slides along.
    return {
      pose: { position: add(current.position, scale(m, s)), rotation },
      freedom: { state: 'along-line', direction: normalize(cross(n1, m)) },
    }
  }

  if (freedom.state === 'along-line') {
    const d = normalize(freedom.direction)
    const denom = dot(d, target)
    if (Math.abs(denom) < 1e-6) throw cannotCloseTheGap('along-line')
    const s = dot(sub(targetFaceWorld.point, facePointAt(R)), target) / denom
    return {
      pose: { position: add(current.position, scale(d, s)), rotation: current.rotation },
      freedom: { state: 'located' },
    }
  }

  // `located` has nothing left to spend, and the coaxial states are S5's to
  // consume. The body already carries an exact transform, so the honest answer
  // is to leave it where it is and report the same freedom - never a refusal
  // and never a silent nudge.
  return { pose: current, freedom }
}

/** Seat 1 (WO-1574's signature, unchanged): the first contact, against a body
 *  no contact has touched yet. */
export function seatFirstFace(
  current: RigidPose,
  facePickLocal: FacePick,
  targetFaceWorld: FacePick,
): RigidPose {
  return seatAgainstFace(current, SEAT_FREEDOM_FREE, facePickLocal, targetFaceWorld).pose
}

/** Seat 2 (WO-1574's signature, unchanged - now it SQUARES as well as slides):
 *  the second contact on a body already lying on the plane whose world normal
 *  is `firstContactNormalWorld`. Throws the degenerate refusal if the second
 *  face is parallel to that plane. */
export function seatSecondFace(
  current: RigidPose,
  firstContactNormalWorld: Vec3,
  facePickLocal: FacePick,
  targetFaceWorld: FacePick,
): RigidPose {
  const freedom: SeatFreedom = { state: 'on-plane', normal: firstContactNormalWorld }
  return seatAgainstFace(current, freedom, facePickLocal, targetFaceWorld).pose
}

/** What to call the things in a freedom sentence. Every field is optional:
 *  with none of them the sentence still reads, it just says "the second face"
 *  where it would rather have said "the fixed jaw". */
export interface FreedomNames {
  /** The moving body, e.g. "Part 1". */
  mover?: string
  /** The faces already contacted, IN THE ORDER THEY WERE MADE, worded the way
   *  the operator picked them: ["the vise floor", "the fixed jaw", "the end
   *  stop"]. The sentence names faces, not axes. */
  contacts?: readonly string[]
  /** For the coaxial states: what the axis belongs to, e.g. "the chuck axis". */
  axis?: string
}

const CONTACT_FALLBACKS = ['the first face', 'the second face', 'the third face']

function named(value: string | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

function contactName(names: FreedomNames, index: number): string {
  return named(names.contacts?.[index]) ?? CONTACT_FALLBACKS[index] ?? 'the last face'
}

/** "X"/"Y"/"Z" when a direction lies along a machine axis, else null. A
 *  direction earns a machine-axis name ONLY when there is no face to name it
 *  after (review section 19.1, rule 1). */
function machineAxisName(v: Vec3): string | null {
  const len = length(v)
  if (len < EPS) return null
  const u = scale(v, 1 / len)
  const axes: Array<[string, number]> = [['X', u.x], ['Y', u.y], ['Z', u.z]]
  const along = axes.filter(([, c]) => Math.abs(c) > 0.999999)
  return along.length === 1 ? along[0][0] : null
}

/** The operator's sentence for a freedom state - the ONE home for these words,
 *  so the strip, the Properties panel and the console cannot word it three
 *  ways. Pure: no store, no React.
 *
 *  It never contains a count, a "DOF", a percentage, a colour or a badge. An
 *  operator reads "it can still slide along the jaw", not "1 DOF remaining". */
export function describeFreedom(freedom: SeatFreedom, names: FreedomNames = {}): string {
  const mover = named(names.mover) ?? 'The part'
  switch (freedom.state) {
    case 'free':
      return `${mover} is placed by hand.`
    case 'on-plane': {
      const floor = contactName(names, 0)
      return `${mover} sits flat on ${floor}. It can still slide across ${floor} and turn on it.`
    }
    case 'along-line': {
      const floor = contactName(names, 0)
      const jaw = contactName(names, 1)
      const along = named(names.contacts?.[1]) ?? machineAxisName(freedom.direction) ?? jaw
      return `${mover} sits flat on ${floor}, squared against ${jaw}. It can still slide along ${along}.`
    }
    case 'located': {
      const listed = (names.contacts ?? []).map(named).filter((n): n is string => n !== null)
      if (listed.length === 0) return `${mover} is fully located.`
      const phrases = listed.map((n, i) => (i === 0 ? `on ${n}` : `against ${n}`))
      return `${mover} is fully located: ${phrases.join(', ')}.`
    }
    case 'on-axis': {
      const axis = named(names.axis) ?? contactName(names, 0)
      return `${mover} is on ${axis}. It can still slide along the axis and turn about it.`
    }
    case 'about-axis': {
      const axis = named(names.axis) ?? contactName(names, 0)
      return `${mover} is on ${axis}, against ${contactName(names, 1)}. It can still turn about it.`
    }
  }
}

/** The six axis-aligned faces of a local bounding box, keyed for a picker
 *  UI. `label` is what the operator sees. */
export const BOX_FACE_KEYS = ['px', 'nx', 'py', 'ny', 'pz', 'nz'] as const
export type BoxFaceKey = typeof BOX_FACE_KEYS[number]

export const BOX_FACE_LABELS: Record<BoxFaceKey, string> = {
  px: '+X face', nx: '-X face', py: '+Y face', ny: '-Y face', pz: '+Z face (top)', nz: '-Z face (bottom)',
}

/** One local-frame `FacePick` for a body's local bounding box. */
export function localBoxFace(bb: { min: Vec3; max: Vec3 }, face: BoxFaceKey): FacePick {
  const mid: Vec3 = {
    x: (bb.min.x + bb.max.x) / 2,
    y: (bb.min.y + bb.max.y) / 2,
    z: (bb.min.z + bb.max.z) / 2,
  }
  switch (face) {
    case 'px': return { point: { x: bb.max.x, y: mid.y, z: mid.z }, normal: { x: 1, y: 0, z: 0 } }
    case 'nx': return { point: { x: bb.min.x, y: mid.y, z: mid.z }, normal: { x: -1, y: 0, z: 0 } }
    case 'py': return { point: { x: mid.x, y: bb.max.y, z: mid.z }, normal: { x: 0, y: 1, z: 0 } }
    case 'ny': return { point: { x: mid.x, y: bb.min.y, z: mid.z }, normal: { x: 0, y: -1, z: 0 } }
    case 'pz': return { point: { x: mid.x, y: mid.y, z: bb.max.z }, normal: { x: 0, y: 0, z: 1 } }
    case 'nz': return { point: { x: mid.x, y: mid.y, z: bb.min.z }, normal: { x: 0, y: 0, z: -1 } }
  }
}

/** WO-1587: the inverse trip. A face picked in the VIEWPORT arrives in world
 *  space (the clicked triangle's planar-region centroid + outward normal);
 *  `seatFirstFace`/`seatSecondFace` want the MOVING body's face in that body's
 *  OWN local frame, because the seat recomputes where it lands. Undo `pose`:
 *  R^T * (p - position) for the point, R^T * n for the normal.
 *
 *  This is the only thing a real mesh-face pick needed that the WO-1574 engine
 *  did not already have - nothing above changed to accept a stepped jaw, a
 *  V-groove or a parallel, because a planar region is a point and a normal
 *  whatever its outline. */
export function localFaceFromWorld(pose: RigidPose, worldPick: FacePick): FacePick {
  const R = rotationMatrixXYZ(pose.rotation)
  // R is orthonormal, so R^T is its inverse and R^T*v is just v dotted with
  // each column.
  const untransform = (v: Vec3): Vec3 => ({
    x: dot(R.col1, v), y: dot(R.col2, v), z: dot(R.col3, v),
  })
  return {
    point: untransform(sub(worldPick.point, pose.position)),
    normal: untransform(worldPick.normal),
  }
}

/** Same face, transformed into WORLD space through `pose` - for the
 *  STATIONARY body in a seat (the part), whose transform never changes. */
export function worldBoxFace(
  bb: { min: Vec3; max: Vec3 },
  pose: RigidPose,
  face: BoxFaceKey,
): FacePick {
  const local = localBoxFace(bb, face)
  const R = rotationMatrixXYZ(pose.rotation)
  return {
    point: add(matVec(R, local.point), pose.position),
    normal: matVec(R, local.normal),
  }
}
