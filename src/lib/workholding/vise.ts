// WO-2172 (workholding assemblies, slice 2): make a VISE from two bodies the
// operator already has, and read/drive its opening.
//
// A vise is a two-component definition placed by one instance
// (docs/design/WORKHOLDING-ASSEMBLIES.md, "Create and set the opening"):
//   - the definition frame IS the fixed body's world pose, so the fixed
//     component sits at identity and the instance's worldPose is that pose;
//   - the moving jaw's localPose is chosen so that, at the opening it was made
//     at, the resolver puts the jaw exactly where it sits now. Making a vise
//     therefore moves nothing: the picture does not jump.
//   - the slide axis is stored in the definition frame and points the way the
//     jaw moves as the vise OPENS: a signed axis of the jaw (Jaw -X, ...) or,
//     for a picked face, opposite the normal of the jaw's clamping face (that
//     face looks at the fixed jaw, so opening moves the other way).
//
// Every pose here goes through ./resolveWorkholding.ts (the ONE resolver). The
// viewport draws the resolver's worldFromComponent (viseDrawPoses), so the
// picture is the pose CAM and simulation read in slice 3.
//
// Nothing here refuses. Travel given high-to-low is swapped; an opening outside
// the travel is kept within it.

import type {
  ImportedGeometry, Project, Vec3, WorkholdingComponent, WorkholdingDefinition, WorkholdingInstance,
  WorkholdingModel, WorkholdingPose,
} from '../../types'
import {
  invertRigidMat4, mat4ToPose, multiplyMat4, poseToMat4, transformDirection, transformPoint, translationMat4,
} from './pose'
import {
  markedRowWorldPose, resolveJointValue, resolveWorkholdingPlacements, workholdingComponentGeometryIds,
} from './resolveWorkholding'
import { displayBoundingBox } from './shapes'
import { rowDrawnInstanceIds } from './reuse'

type ViseProject = Pick<Project, 'geometry' | 'modelItemPlacements' | 'workholding'>

/** A vise's fixed and moving component ids (the definition's own ids). */
export const VISE_FIXED_COMPONENT_ID = 'fixed'
export const VISE_MOVING_COMPONENT_ID = 'moving'

/** One of the jaw's own axes, signed: the way the jaw moves as the vise opens. */
export type ViseJawAxis = 'x' | '-x' | 'y' | '-y' | 'z' | '-z'

/** How the jaw slides as the vise opens: along a signed axis of the jaw, or
 *  away from its clamping face (opposite that face's world outward normal). */
export type ViseSlide =
  | { kind: 'jaw-axis'; axis: ViseJawAxis }
  | { kind: 'clamping-face'; normal: Vec3 }

export interface MakeViseInput {
  name?: string
  fixedGeometryId: string
  jawGeometryId: string
  slide: ViseSlide
  minMm: number
  maxMm: number
  /** The opening the jaw sits at now (as imported). Missing = the minimum. */
  openingNowMm?: number
  /** The setup the vise is placed in; null = every setup. */
  setupId: string | null
}

export interface BuiltVise {
  definition: WorkholdingDefinition
  instance: WorkholdingInstance
}

const UNIT_AXES: Record<ViseJawAxis, Vec3> = {
  'x': { x: 1, y: 0, z: 0 }, 'y': { x: 0, y: 1, z: 0 }, 'z': { x: 0, y: 0, z: 1 },
  '-x': { x: -1, y: 0, z: 0 }, '-y': { x: 0, y: -1, z: 0 }, '-z': { x: 0, y: 0, z: -1 },
}

function dot(a: Vec3, b: Vec3) { return a.x * b.x + a.y * b.y + a.z * b.z }
function scale(v: Vec3, s: number): Vec3 { return { x: v.x * s, y: v.y * s, z: v.z * s } }
function finiteOr(n: number, fallback: number) { return Number.isFinite(n) ? n : fallback }

/** The world corners of a row's display bounding box (its origin alone when it has none). */
function worldCorners(row: ImportedGeometry, pose: WorkholdingPose): Vec3[] {
  const box = displayBoundingBox(row)
  const m = poseToMat4(pose)
  if (!box) return [transformPoint(m, { x: 0, y: 0, z: 0 })]
  const out: Vec3[] = []
  for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
    out.push(transformPoint(m, { x, y, z }))
  }
  return out
}

function centreOf(points: readonly Vec3[]): Vec3 {
  const lo = { x: Infinity, y: Infinity, z: Infinity }
  const hi = { x: -Infinity, y: -Infinity, z: -Infinity }
  for (const p of points) {
    lo.x = Math.min(lo.x, p.x); lo.y = Math.min(lo.y, p.y); lo.z = Math.min(lo.z, p.z)
    hi.x = Math.max(hi.x, p.x); hi.y = Math.max(hi.y, p.y); hi.z = Math.max(hi.z, p.z)
  }
  return { x: (lo.x + hi.x) / 2, y: (lo.y + hi.y) / 2, z: (lo.z + hi.z) / 2 }
}

/**
 * A vise made from two bodies, placed where they sit now. Null only when a
 * named body is not in the project or has no place in the world (a Model body
 * with no Model Item placement) - there is then nothing to build from.
 */
export function buildVise(
  project: ViseProject,
  input: MakeViseInput,
  ids: { definitionId: string; instanceId: string },
): BuiltVise | null {
  const fixedRow = project.geometry.find((g) => g.id === input.fixedGeometryId)
  const jawRow = project.geometry.find((g) => g.id === input.jawGeometryId)
  if (!fixedRow || !jawRow || fixedRow.id === jawRow.id) return null
  const placements = project.modelItemPlacements ?? []
  const fixedPose = markedRowWorldPose(fixedRow, placements)
  const jawPose = markedRowWorldPose(jawRow, placements)
  if (!fixedPose || !jawPose) return null

  const F = poseToMat4(fixedPose)
  const J = poseToMat4(jawPose)

  // The opening direction in the world: a signed jaw axis, or away from the clamping face.
  let world = input.slide.kind === 'jaw-axis'
    ? transformDirection(J, UNIT_AXES[input.slide.axis])
    : scale(input.slide.normal, -1)
  const length = Math.hypot(world.x, world.y, world.z)
  if (Number.isFinite(length) && length > 0) world = scale(world, 1 / length)
  // Into the definition (fixed body) frame.
  const axis = transformDirection(invertRigidMat4(F), world)

  const a = finiteOr(input.minMm, 0)
  const b = finiteOr(input.maxMm, a)
  const minMm = Math.min(a, b)
  const maxMm = Math.max(a, b)
  const opening = Math.min(maxMm, Math.max(minMm, finiteOr(input.openingNowMm ?? minMm, minMm)))

  // jaw local = T(-axis * opening) * F^-1 * J, so F * T(axis * opening) * local = J.
  const jawLocal = multiplyMat4(translationMat4(scale(axis, -opening)), multiplyMat4(invertRigidMat4(F), J))

  const components: WorkholdingComponent[] = [
    {
      id: VISE_FIXED_COMPONENT_ID, name: fixedRow.name || 'Fixed body', geometryId: fixedRow.id,
      localPose: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } },
    },
    {
      id: VISE_MOVING_COMPONENT_ID, name: jawRow.name || 'Moving jaw', geometryId: jawRow.id,
      localPose: mat4ToPose(jawLocal),
      joint: { kind: 'linear', axis, minMm, maxMm, closedAtMm: minMm },
    },
  ]
  const definition: WorkholdingDefinition = {
    id: ids.definitionId, revision: 1, name: input.name?.trim() || 'Vise', kind: 'vise', components,
  }
  const instance: WorkholdingInstance = {
    id: ids.instanceId,
    definitionId: definition.id,
    definitionRevision: definition.revision,
    setupScope: input.setupId ? { kind: 'setups', setupIds: [input.setupId] } : { kind: 'all' },
    worldPose: { position: { ...fixedPose.position }, rotation: { ...fixedPose.rotation } },
    jointValuesMm: { [VISE_MOVING_COMPONENT_ID]: opening },
    placement: { kind: 'free' },
  }
  return { definition, instance }
}

/**
 * The opening direction a new vise starts on - a first guess the operator sees
 * and changes in the same form. The axis: the one of the jaw's own X/Y/Z along
 * which the jaw sits furthest from the fixed body's centre (a jaw slides along
 * the line it sits on). The sign: away from the END of the fixed body nearest
 * the jaw - that end is the fixed jaw (a moving jaw on a long base still opens
 * away from it, not away from the base's middle).
 */
export function defaultViseSlideAxis(project: ViseProject, fixedGeometryId: string, jawGeometryId: string): ViseJawAxis {
  const fixedRow = project.geometry.find((g) => g.id === fixedGeometryId)
  const jawRow = project.geometry.find((g) => g.id === jawGeometryId)
  const placements = project.modelItemPlacements ?? []
  const fixedPose = fixedRow ? markedRowWorldPose(fixedRow, placements) : null
  const jawPose = jawRow ? markedRowWorldPose(jawRow, placements) : null
  if (!fixedRow || !jawRow || !fixedPose || !jawPose) return 'x'
  const fixedCorners = worldCorners(fixedRow, fixedPose)
  const a = centreOf(fixedCorners)
  const b = centreOf(worldCorners(jawRow, jawPose))
  const J = poseToMat4(jawPose)
  const apart = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z }
  let best: 'x' | 'y' | 'z' = 'x'
  let bestScore = -1
  for (const axis of ['x', 'y', 'z'] as const) {
    const score = Math.abs(dot(transformDirection(J, UNIT_AXES[axis]), apart))
    if (score > bestScore + 1e-9) { best = axis; bestScore = score }
  }
  // Along that axis: the fixed body's two ends, and the jaw's centre between or beyond them.
  const d = transformDirection(J, UNIT_AXES[best])
  const ends = fixedCorners.map((p) => dot(p, d))
  const lo = Math.min(...ends)
  const hi = Math.max(...ends)
  const at = dot(b, d)
  const nearestEnd = Math.abs(at - hi) <= Math.abs(at - lo) ? hi : lo
  return at >= nearestEnd ? best : (('-' + best) as ViseJawAxis)
}

// ── Reading a vise ──────────────────────────────────────────────────────────

export interface ViseMembership {
  instance: WorkholdingInstance
  definition: WorkholdingDefinition
  /** The component this row is the shape of. */
  component: WorkholdingComponent
  /** The jointed component (the moving jaw), when the definition has one. */
  moving: WorkholdingComponent | null
}

/** Every placed vise/fixture instance with its definition, in instance order.
 *  WO-2192: a clamp is not a vise - it has its own list (./clamps.ts). */
export function viseInstances(model: WorkholdingModel | undefined): Array<{
  instance: WorkholdingInstance; definition: WorkholdingDefinition
}> {
  const definitions = new Map((model?.definitions ?? []).map((d) => [d.id, d]))
  const out: Array<{ instance: WorkholdingInstance; definition: WorkholdingDefinition }> = []
  for (const instance of model?.instances ?? []) {
    const definition = definitions.get(instance.definitionId)
    if (definition && definition.kind !== 'clamp') out.push({ instance, definition })
  }
  return out
}

/** The placed workholding a geometry row is a component of, or null. WO-2198:
 *  with a definition placed more than once, the FIRST instance - the one its
 *  rows are drawn at (viseDrawPoses). */
export function workholdingOfGeometry(
  model: WorkholdingModel | undefined,
  geometryId: string,
): ViseMembership | null {
  for (const { instance, definition } of viseInstances(model)) {
    const component = definition.components.find((c) => c.geometryId === geometryId)
    if (component) {
      return { instance, definition, component, moving: definition.components.find((c) => c.joint) ?? null }
    }
  }
  return null
}

/** WO-2198: one placed vise/fixture instance as the Properties panel shows it
 *  (its fixed body as `component`), or null for a clamp or an unknown id. */
export function viseMembershipOfInstance(
  model: WorkholdingModel | undefined,
  instanceId: string | null | undefined,
): ViseMembership | null {
  const found = viseInstances(model).find(({ instance }) => instance.id === instanceId)
  if (!found) return null
  const { instance, definition } = found
  const component = definition.components.find((c) => !c.joint) ?? definition.components[0]
  return component
    ? { instance, definition, component, moving: definition.components.find((c) => c.joint) ?? null }
    : null
}

export { workholdingComponentGeometryIds } from './resolveWorkholding'

/** The opening an instance's jaw is at (within travel), and its travel. */
export function viseOpening(
  instance: WorkholdingInstance,
  moving: WorkholdingComponent,
): { valueMm: number; minMm: number; maxMm: number } | null {
  if (!moving.joint) return null
  const { valueMm } = resolveJointValue(moving.joint, instance.jointValuesMm?.[moving.id])
  return {
    valueMm,
    minMm: Math.min(moving.joint.minMm, moving.joint.maxMm),
    maxMm: Math.max(moving.joint.minMm, moving.joint.maxMm),
  }
}

// ── Drawing and dragging ────────────────────────────────────────────────────

export interface ViseDrawPoses {
  /** geometry row -> the group pose that draws it at the resolver's world transform. */
  readonly poses: ReadonlyMap<string, WorkholdingPose>
  /** Component rows with no instance in this setup: not drawn here. */
  readonly hidden: ReadonlySet<string>
}

/**
 * Where the viewport draws each assembly component in `setupId`: the
 * resolver's worldFromComponent, as the position + rotation a body group takes.
 * A body group draws its display frame at its own pose, so this is the
 * resolver's pose exactly (mat4ToPose round-trips through poseToMat4).
 */
export function viseDrawPoses(project: ViseProject, setupId: string | null | undefined): ViseDrawPoses {
  const poses = new Map<string, WorkholdingPose>()
  if (!project.workholding?.definitions.length) return { poses, hidden: new Set() }
  // WO-2192: a clamp shape is drawn once per placed clamp (components/workholding/clampViewport.ts),
  // never at one of them by its own row, so its row stays hidden here.
  // WO-2198: a definition placed more than once shares its shape rows; the rows
  // draw its FIRST instance (the one workholdingOfGeometry names, so a row
  // dragged moves that instance) and every other instance is drawn as its own
  // copy (components/workholding/clampViewport.ts). When the first instance is
  // not in this setup, the rows are not drawn here.
  const rowDrawn = rowDrawnInstanceIds(project.workholding)
  for (const placement of resolveWorkholdingPlacements(project, setupId).placements) {
    if (placement.source !== 'instance' || !rowDrawn.has(placement.instanceId)) continue
    poses.set(placement.geometryId, mat4ToPose(placement.worldFromComponent))
  }
  const hidden = new Set<string>()
  for (const id of workholdingComponentGeometryIds(project.workholding)) if (!poses.has(id)) hidden.add(id)
  return { poses, hidden }
}

/**
 * A dragged moving jaw -> the opening it asks for: the drag's travel along the
 * jaw's world slide axis added to the opening it had. The result is NOT kept
 * within travel here; the store does that and reports the value it used.
 */
export function openingFromJawDrag(
  project: ViseProject,
  membership: ViseMembership,
  droppedAt: Vec3,
): number | null {
  const { instance, component } = membership
  if (!component.joint) return null
  const joint = resolveJointValue(component.joint, instance.jointValuesMm?.[component.id])
  if (!joint.axis) return null
  const placement = placementIgnoringScope(project, instance, component.id)
  if (!placement) return null
  const m = placement.worldFromComponent
  const worldAxis = transformDirection(poseToMat4(instance.worldPose), joint.axis)
  const moved = { x: droppedAt.x - m[12], y: droppedAt.y - m[13], z: droppedAt.z - m[14] }
  return joint.valueMm + dot(moved, worldAxis)
}

/** The instance's placement for one component, whatever its setup scope. */
function placementIgnoringScope(project: ViseProject, instance: WorkholdingInstance, componentId: string) {
  const unscoped: ViseProject = {
    ...project,
    workholding: {
      definitions: project.workholding?.definitions ?? [],
      instances: [{ ...instance, setupScope: { kind: 'all' } }],
    },
  }
  return resolveWorkholdingPlacements(unscoped, null).placements.find(
    (p) => p.instanceId === instance.id && p.componentId === componentId,
  )
}

/** A component without a joint dragged to `droppedPose` -> the instance pose that puts it there. */
export function instancePoseFromComponentDrag(
  component: WorkholdingComponent,
  droppedPose: WorkholdingPose,
): WorkholdingPose {
  return mat4ToPose(multiplyMat4(poseToMat4(droppedPose), invertRigidMat4(poseToMat4(component.localPose))))
}
