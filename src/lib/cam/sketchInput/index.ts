// WO-3305 (UI M2 W2-12): sketch geometry as a toolpath input.
//
// A sketch drawn in the Model workspace (on the model's XY plane, an offset plane or a face) is
// turned into an ordinary 2D layer on its own sketch part, so an operation reads it through
// `params.geometryId` + `loopIds` exactly as it reads an imported DXF layer or a CAM sketch:
// the dispatch has no second route and no existing operation's moves change.
//
// The layer's id carries the link back to the sketch (`sketch-input:<model item>:<node>`), so a
// saved project keeps it and the sync can find the source again. Loops are in the model's own
// frame (`frame: 'geometry_local'`, the B-rep derived layer convention) on a projection plane at
// the sketch's height; the part's position and rotation are the model item's placement, so the
// dispatch applies the same transform it applies to every other 2D part.
//
// Pure: no store, no kernel, no React. The store-side bridge is src/store/dispatchGeo.ts.

import type { BoundingBox, ImportedGeometry, Layer2D, Loop2D, LoopSegment, Vec2, Vec3 } from '../../../types'
import type { Sketch } from '../../sketch/types'
import { bakeSketch } from '../../sketch/bake'
import { rotationMatrixXYZ } from '../../geometry/rotationMatrixXYZ'
import { basePlaneFrame } from '../modelWorkbenchHelpers'
import { assignStableLoopIds } from '../../geometry/loopId'

/** A sketch plane in the model's frame: origin, unit normal and unit local X. */
export interface SketchInputPlane {
  origin: Vec3
  normal: Vec3
  xDir: Vec3
}

/** One sketch of a model item that may become operation geometry. */
export interface ModelSketchSource {
  modelItemId: string
  /** The sketch's node id in the model document. */
  nodeId: string
  name: string
  sketch: Sketch
  plane: SketchInputPlane
}

/** Where the model item sits in the project (its placement); identity when it has none. */
export interface SketchInputPose {
  position: Vec3
  rotation: Vec3
}

export const IDENTITY_POSE: SketchInputPose = {
  position: { x: 0, y: 0, z: 0 },
  rotation: { x: 0, y: 0, z: 0 },
}

/** A plane counts as level when its normal is this close to the Z axis as placed. */
const LEVEL_TOLERANCE = 1e-6

const LAYER_PREFIX = 'sketch-input:'

export function sketchInputLayerId(modelItemId: string, nodeId: string): string {
  return `${LAYER_PREFIX}${modelItemId}:${nodeId}`
}

/** The link a sketch-input layer carries, or null for any other layer. */
export function parseSketchInputLayerId(layerId: string): { modelItemId: string; nodeId: string } | null {
  if (!layerId.startsWith(LAYER_PREFIX)) return null
  const rest = layerId.slice(LAYER_PREFIX.length)
  const split = rest.indexOf(':')
  if (split <= 0 || split === rest.length - 1) return null
  return { modelItemId: rest.slice(0, split), nodeId: rest.slice(split + 1) }
}

/** The sketch-input layer of a geometry row, when the row is a linked sketch part. */
export function sketchInputLink(geo: Pick<ImportedGeometry, 'format' | 'layers2d'>): {
  layer: Layer2D; modelItemId: string; nodeId: string
} | null {
  if (geo.format !== 'sketch') return null
  for (const layer of geo.layers2d ?? []) {
    const link = parseSketchInputLayerId(layer.id)
    if (link) return { layer, ...link }
  }
  return null
}

// ---- reading the model document -------------------------------------------------------------

/** The two reads this module needs from a model document (FeatureDag satisfies it). */
export interface SketchInputDag {
  nodeIds(): string[]
  getNode(id: string): { id: string; kind: string; payload: Record<string, unknown>; suppressed?: boolean } | undefined
}

function isVec3(v: unknown): v is Vec3 {
  const o = v as Vec3 | undefined
  return !!o && Number.isFinite(o.x) && Number.isFinite(o.y) && Number.isFinite(o.z)
}

function isPlane(v: unknown): v is SketchInputPlane {
  const o = v as SketchInputPlane | undefined
  return !!o && isVec3(o.origin) && isVec3(o.normal) && isVec3(o.xDir)
}

function isSketch(v: unknown): v is Sketch {
  const o = v as Sketch | undefined
  return !!o && typeof o.id === 'string' && Array.isArray(o.entities) && Array.isArray(o.constraints)
}

function planeOfNode(dag: SketchInputDag, planeNodeId: unknown): SketchInputPlane | undefined {
  if (typeof planeNodeId !== 'string') return undefined
  const base = basePlaneFrame(planeNodeId)
  if (base) return base
  const frame = dag.getNode(planeNodeId)?.payload.lastGoodFrame
  return isPlane(frame) ? frame : undefined
}

function nodeName(id: string, payload: Record<string, unknown>): string {
  const name = payload.name
  return typeof name === 'string' && name.trim().length > 0 ? name : id
}

/** Every sketch of one model document that is drawn on a resolved plane, in document order.
 *  A suppressed sketch, or one whose plane has not resolved yet, is not a source. */
export function readModelSketchSources(dag: SketchInputDag, modelItemId: string): ModelSketchSource[] {
  const out: ModelSketchSource[] = []
  for (const id of dag.nodeIds()) {
    const node = dag.getNode(id)
    if (!node || node.kind !== 'sketch' || node.suppressed) continue
    const sketch = node.payload.sketch
    if (!isSketch(sketch)) continue
    const plane = planeOfNode(dag, node.payload.planeNodeId)
    if (!plane) continue
    out.push({ modelItemId, nodeId: id, name: nodeName(id, node.payload), sketch, plane })
  }
  return out
}

// ---- can the setup cut it ---------------------------------------------------------------------

function rotate(rotation: Vec3, v: Vec3): Vec3 {
  const m = rotationMatrixXYZ(rotation)
  return {
    x: m.col1.x * v.x + m.col2.x * v.y + m.col3.x * v.z,
    y: m.col1.y * v.x + m.col2.y * v.y + m.col3.y * v.z,
    z: m.col1.z * v.x + m.col2.z * v.y + m.col3.z * v.z,
  }
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x }
}

function toModel(plane: SketchInputPlane, p: Vec2): Vec3 {
  const y = cross(plane.normal, plane.xDir)
  return {
    x: plane.origin.x + p.x * plane.xDir.x + p.y * y.x,
    y: plane.origin.y + p.x * plane.xDir.y + p.y * y.y,
    z: plane.origin.z + p.x * plane.xDir.z + p.y * y.z,
  }
}

/** Why a sketch cannot be machined: an existing operator reason (rule 11), never a new one. */
export interface SketchInputRefusal {
  ok: false
  key: 'console-and-operator-messages:modelEdgeChainBinding19'
  params: { value1: string; value2: string }
}

export type SketchInputReach = { ok: true } | SketchInputRefusal

/** A 2.5D operation cuts curves that lie on one level plane as placed. A tilted sketch plane is
 *  refused with the app's own reason for a picked edge chain that is not level (its world-Z span
 *  over the sketch's curves). */
export function sketchInputReach(source: ModelSketchSource, pose: SketchInputPose, loops?: readonly Loop2D[]): SketchInputReach {
  const n = rotate(pose.rotation, source.plane.normal)
  const len = Math.hypot(n.x, n.y, n.z)
  if (len > 0 && Math.abs(Math.abs(n.z / len) - 1) <= LEVEL_TOLERANCE) return { ok: true }
  const baked = loops ?? bakeSketch({ ...source.sketch, layerId: 'reach' }, { newId: counterIds() }).loops
  let lo = Infinity, hi = -Infinity
  for (const loop of baked) {
    for (const p of loop.points) {
      const z = rotate(pose.rotation, toModel(source.plane, p)).z
      lo = Math.min(lo, z)
      hi = Math.max(hi, z)
    }
  }
  const span = Number.isFinite(lo) ? hi - lo : 0
  return {
    ok: false,
    key: 'console-and-operator-messages:modelEdgeChainBinding19',
    params: { value1: source.name, value2: String(Math.round(span * 1000) / 1000) },
  }
}

// ---- the layer --------------------------------------------------------------------------------

function counterIds(prefix = 'loop'): () => string {
  let n = 0
  return () => `${prefix}-${++n}`
}

/** How a sketch's plane points land in its part's own XY frame, and the pose the part keeps.
 *  A level placement (turned about Z only) stays on the part as its pose and the points are the
 *  model's XY, exactly as a 2D layer placed there. A placement tipped about X or Y is baked into
 *  the points (the part keeps only the position), because a 2D part's layer plane is not tipped
 *  at dispatch. `mirrored` is the handedness of the plane-to-XY map that the points actually take,
 *  so an arc's direction and a closed loop's winding follow the points. */
interface SketchInputFrame {
  toXyz: (p: Vec2) => Vec3
  mirrored: boolean
  pose: SketchInputPose
}

const isLevelPose = (pose: SketchInputPose) =>
  Math.abs(pose.rotation.x) < 1e-9 && Math.abs(pose.rotation.y) < 1e-9

function frameOf(plane: SketchInputPlane, pose: SketchInputPose): SketchInputFrame {
  if (isLevelPose(pose)) {
    return { toXyz: (p) => toModel(plane, p), mirrored: plane.normal.z < 0, pose }
  }
  return {
    toXyz: (p) => rotate(pose.rotation, toModel(plane, p)),
    mirrored: rotate(pose.rotation, plane.normal).z < 0,
    pose: { position: { ...pose.position }, rotation: { x: 0, y: 0, z: 0 } },
  }
}

function mapPoint(frame: SketchInputFrame, p: Vec2): Vec2 {
  const m = frame.toXyz(p)
  return { x: m.x, y: m.y }
}

function mapSegment(frame: SketchInputFrame, s: LoopSegment): LoopSegment {
  if (s.type === 'line') return { type: 'line', to: mapPoint(frame, s.to) }
  return {
    type: 'arc', to: mapPoint(frame, s.to), center: mapPoint(frame, s.center), radius: s.radius,
    clockwise: frame.mirrored ? !s.clockwise : s.clockwise,
  }
}

/** Reverse a closed loop in place of its traversal, keeping the repo's Loop2D convention (no
 *  repeated first point; segments start at points[0] and the last one closes onto it). */
function reverseClosed(loop: Loop2D): Loop2D {
  const pts = [loop.points[0], ...loop.points.slice(1).reverse()]
  if (!loop.segments) return { ...loop, points: pts }
  const n = loop.segments.length
  const starts: Vec2[] = loop.segments.map((_, i) => (i === 0 ? loop.points[0] : loop.segments![i - 1].to))
  const segments: LoopSegment[] = []
  for (let i = n - 1; i >= 0; i--) {
    const s = loop.segments[i]
    const to = starts[i]
    segments.push(s.type === 'line'
      ? { type: 'line', to }
      : { type: 'arc', to, center: s.center, radius: s.radius, clockwise: !s.clockwise })
  }
  return { ...loop, points: pts, segments }
}

function boundsOf(loops: readonly Loop2D[], z: number): BoundingBox {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const l of loops) for (const p of l.points) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y)
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y)
  }
  if (!Number.isFinite(minX)) { minX = minY = maxX = maxY = 0 }
  return {
    min: { x: minX, y: minY, z }, max: { x: maxX, y: maxY, z },
    size: { x: maxX - minX, y: maxY - minY, z: 0 },
    center: { x: (minX + maxX) / 2, y: (minY + maxY) / 2, z },
  }
}

export interface SketchInputBake {
  ok: true
  layer: Layer2D
  loops: Loop2D[]
  boundingBox: BoundingBox
  /** Where the part sits: the model's placement, less any tip that the points already carry. */
  pose: SketchInputPose
  fingerprint: string
}

const SKETCH_INPUT_COLOR = '#ffd740'

/** Bake one model sketch into the layer and loops of its sketch part. Loop ids are stable per
 *  node (`<node>#<n>` in bake order), so a re-bake of an unchanged shape keeps the ids an
 *  operation picked; a refused (tilted) plane returns the refusal. */
export function bakeSketchInput(source: ModelSketchSource, pose: SketchInputPose): SketchInputBake | SketchInputRefusal {
  const layerId = sketchInputLayerId(source.modelItemId, source.nodeId)
  const baked = bakeSketch({ ...source.sketch, layerId }, { newId: counterIds(`${source.nodeId}#`) })
  const reach = sketchInputReach(source, pose, baked.loops)
  if (!reach.ok) return reach
  const frame = frameOf(source.plane, pose)
  const loops = baked.loops.map((loop) => {
    const mapped: Loop2D = {
      ...loop,
      layerId,
      points: loop.points.map((p) => mapPoint(frame, p)),
      ...(loop.segments ? { segments: loop.segments.map((s) => mapSegment(frame, s)) } : {}),
    }
    return frame.mirrored && mapped.closed ? reverseClosed(mapped) : mapped
  })
  const z = frame.toXyz({ x: 0, y: 0 }).z
  const layer: Layer2D = {
    id: layerId,
    name: source.name,
    color: SKETCH_INPUT_COLOR,
    visible: true,
    frame: 'geometry_local',
    projectionPlane: {
      origin: { x: 0, y: 0, z },
      xAxis: { x: 1, y: 0, z: 0 },
      yAxis: { x: 0, y: 1, z: 0 },
      normal: { x: 0, y: 0, z: 1 },
    },
  }
  return { ok: true, layer, loops, boundingBox: boundsOf(loops, z), pose: frame.pose, fingerprint: sketchInputFingerprint(source, pose) }
}

/** Changes whenever what the bake reads changes: the sketch's geometry, its plane, its name or the
 *  model's placement. The solve status is left out (it does not move a curve). */
export function sketchInputFingerprint(source: ModelSketchSource, pose: SketchInputPose): string {
  const { solveStatus: _solve, ...geometry } = source.sketch
  void _solve
  return JSON.stringify([geometry, source.plane, source.name, pose])
}

/** The sketch part a first "Use" adds: an in-app sketch part (format 'sketch') holding the one
 *  linked layer, placed where the model item is placed. Loop ids are the store's content ids
 *  (the ones setGeometryLoops stamps), so the first sync of an unchanged sketch keeps them. */
export function sketchInputPart(id: string, bake: SketchInputBake): ImportedGeometry {
  const pose = bake.pose
  return {
    id,
    name: bake.layer.name,
    filename: '',
    type: 'curves_2d',
    format: 'sketch',
    boundingBox: bake.boundingBox,
    position: { ...pose.position },
    rotation: { ...pose.rotation },
    loaded: true,
    loops: assignStableLoopIds(bake.loops, id),
    layers2d: [bake.layer],
  }
}

/** What the sync writes to a linked part whose sketch (or placement) changed. */
export interface SketchInputUpdate {
  geoId: string
  loops: Loop2D[]
  layers: Layer2D[]
  pose: SketchInputPose
  poseChanged: boolean
  /** Old loop id -> the loop that replaces it (null: gone), so an operation keeps following the
   *  same curve when its shape changes. Loops whose shape is unchanged keep their id and are absent. */
  loopIdMap: Record<string, string | null>
}

const shapeOf = (loops: readonly Loop2D[]) => JSON.stringify(loops.map(({ id: _id, ...rest }) => { void _id; return rest }))
const samePose = (a: SketchInputPose, b: SketchInputPose) =>
  JSON.stringify([a.position, a.rotation]) === JSON.stringify([b.position, b.rotation])

function boxOf(loop: Loop2D): [number, number, number, number] {
  const xs = loop.points.map((p) => p.x), ys = loop.points.map((p) => p.y)
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
}

const boxDistance = (a: Loop2D, b: Loop2D) => {
  const p = boxOf(a), q = boxOf(b)
  return Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]) + Math.abs(p[3] - q[3])
}

/** What a loop was built from, kept by the caller from the last time it baked the sketch: the
 *  sketch and the loops it produced (the part's loops as saved, in order). */
export interface SketchInputPrevious {
  sketch: Sketch
  loops: readonly Loop2D[]
}

const bakedShape = (l: Loop2D) => JSON.stringify([l.closed, l.points, l.segments ?? null])

/** The sketch entity ids each baked loop is made of, in bake order. An entity belongs to a loop
 *  when baking the sketch without it changes that loop (or makes it vanish). */
export function sketchLoopEntityIds(sketch: Sketch): string[][] {
  const bake = (s: Sketch) => bakeSketch({ ...s, layerId: 'identity' }, { newId: counterIds('identity#') }).loops
  const loops = bake(sketch)
  const owners: string[][] = loops.map(() => [])
  const shapes = loops.map(bakedShape)
  for (const entity of sketch.entities) {
    if (entity.construction) continue
    const rest = new Map<string, number>()
    for (const l of bake({ ...sketch, entities: sketch.entities.filter((e) => e.id !== entity.id) })) {
      const k = bakedShape(l)
      rest.set(k, (rest.get(k) ?? 0) + 1)
    }
    shapes.forEach((k, i) => {
      const left = rest.get(k) ?? 0
      if (left > 0) rest.set(k, left - 1)
      else owners[i].push(entity.id)
    })
  }
  return owners
}

/** The update a linked part needs to show its sketch as it is now, or null when it already does.
 *  `identity` (the sketch as last baked and as it is now) lets a changed loop hand its pick on. */
export function planSketchInputUpdate(
  geo: ImportedGeometry,
  bake: SketchInputBake,
  identity?: { previous: SketchInputPrevious; next: Sketch },
): SketchInputUpdate | null {
  const pose = bake.pose
  const link = sketchInputLink(geo)
  if (!link) return null
  const oldLoops = (geo.loops ?? []).filter((l) => l.layerId === link.layer.id)
  const poseNow = { position: geo.position, rotation: geo.rotation }
  const layerSame = link.layer.name === bake.layer.name
    && JSON.stringify(link.layer.projectionPlane) === JSON.stringify(bake.layer.projectionPlane)
  if (shapeOf(oldLoops) === shapeOf(bake.loops) && layerSame && samePose(poseNow, pose)) return null
  const loops = assignStableLoopIds(bake.loops, geo.id)
  // A loop whose shape did not change keeps its content id. A changed loop hands its pick to the
  // new loop that shares sketch entities with it (a resize or a move keeps them), the largest
  // share first, each new loop taken once. A new loop with no entity in common is a different
  // outline and never inherits a pick: the changed loop is null and its picks keep the old id.
  const newIds = new Set(loops.map((l) => l.id))
  const oldIds = new Set(oldLoops.map((l) => l.id))
  const gone = oldLoops.filter((l) => !newIds.has(l.id))
  const free = loops.filter((l) => !oldIds.has(l.id))
  const loopIdMap: Record<string, string | null> = {}
  for (const old of gone) loopIdMap[old.id] = null
  // The identity is only trusted when the remembered bake is the part as it is saved.
  if (gone.length > 0 && free.length > 0 && identity && shapeOf(identity.previous.loops) === shapeOf(oldLoops)) {
    const before = sketchLoopEntityIds(identity.previous.sketch)
    const after = sketchLoopEntityIds(identity.next)
    if (before.length === oldLoops.length && after.length === loops.length) {
      const shared = (old: Loop2D, loop: Loop2D) => {
        const mine = new Set(before[oldLoops.indexOf(old)])
        return after[loops.indexOf(loop)].filter((id) => mine.has(id)).length
      }
      const pairs: { old: Loop2D; loop: Loop2D; n: number; d: number }[] = []
      for (const old of gone) for (const loop of free) {
        const n = old.closed === loop.closed ? shared(old, loop) : 0
        if (n > 0) pairs.push({ old, loop, n, d: boxDistance(old, loop) })
      }
      pairs.sort((a, b) => b.n - a.n || a.d - b.d)
      const takenOld = new Set<string>(), takenNew = new Set<string>()
      for (const { old, loop } of pairs) {
        if (takenOld.has(old.id) || takenNew.has(loop.id)) continue
        takenOld.add(old.id); takenNew.add(loop.id)
        loopIdMap[old.id] = loop.id
      }
    }
  }
  const others = (geo.loops ?? []).filter((l) => l.layerId !== link.layer.id)
  return {
    geoId: geo.id,
    loops: [...others, ...loops],
    layers: (geo.layers2d ?? []).map((l) => (l.id === link.layer.id
      ? { ...l, name: bake.layer.name, projectionPlane: bake.layer.projectionPlane, frame: bake.layer.frame }
      : l)),
    pose,
    poseChanged: !samePose(poseNow, pose),
    loopIdMap,
  }
}
