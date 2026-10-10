// WO-2167 (workholding assemblies, slice 1): the ONE resolver that turns a
// project's workholding into world bodies for a setup.
//
// Two sources feed it, through the same code:
//   - project.workholding: reusable DEFINITIONS (a vise = several components,
//     one on a linear joint; a clamp = one component) placed by setup-scoped
//     INSTANCES. For each instance component:
//         worldFromComponent = instanceWorldPose * jointPose(value) * componentLocalPose
//     where jointPose translates along the joint's axis (definition frame) by
//     the saved value, kept within the travel.
//   - a geometry row marked `workholding: true` (WO-1572, today's bodies): a
//     one-component instance in every setup whose world pose is the row's own
//     scene pose - position + rotation, or for a Model-workbench body its
//     Model Item placement (resolveModelReferenceFrame). This is exactly where
//     the viewport draws it and where store/fixtureObstacles.ts puts it today.
//
// A component's shape is read in its display frame (./shapes.ts owns STL
// recentring, STEP and Model display frames) and carried to the world by
// worldFromComponent. A shape that cannot be read is replaced by its bounding
// box, and the notice says so (rule 11: nothing is refused).
//
// Nothing here refuses, gates or warns the operator. A joint value outside the
// travel is kept within it (a number, not a refusal); a joint with no usable
// slide direction or travel resolves at its zero, with a named notice.

import type {
  ImportedGeometry, Project, Vec3, WorkholdingComponent, WorkholdingDefinition,
  WorkholdingInstance, WorkholdingLinearJoint, WorkholdingPose, WorkholdingSetupScope,
} from '../../types'
import type { ClearanceMesh } from '../cam/holderClearance'
import { isModelOriginGeometry } from '../cam/modelOrigin'
import { resolveModelReferenceFrame } from '../cam/modelReferenceFrame'
import {
  IDENTITY_MAT4, multiplyMat4, poseToMat4, transformPositions, translationMat4, type Mat4,
} from './pose'
import {
  boxMesh, cachedWorkholdingShapeReader, displayBoundingBox, readDisplayShape,
  type WorkholdingShapeReader,
} from './shapes'

/** Must equal src/doc/documentHolder.ts's LEGACY_MODEL_ITEM_ID (fixtureObstacles.ts keeps the same copy). */
const LEGACY_MODEL_ITEM_ID = 'legacy'

/** One placed workholding component, before its shape is read. */
export interface ResolvedWorkholdingPlacement {
  /** The instance id; for a marked geometry row, the row id. */
  readonly instanceId: string
  readonly componentId: string
  /** Null for a marked geometry row (it has no definition). */
  readonly definitionId: string | null
  readonly definitionRevision: number | null
  readonly source: 'instance' | 'marked-geometry'
  readonly geometryId: string
  /** For notices and the tree: "<definition> - <component>", or the row name. */
  readonly name: string
  /** worldFromComponent: the component's display frame to world, column-major 4x4. */
  readonly worldFromComponent: Mat4
  /** The joint displacement actually used (within travel), mm. Absent without a joint. */
  readonly jointValueMm?: number
}

/** One placed workholding component with its world shape. */
export interface ResolvedWorkholdingBody extends ResolvedWorkholdingPlacement {
  /** World-frame triangle mesh. */
  readonly mesh: ClearanceMesh
  /** 'bounding-box' = the exact shape could not be read; its box stands in. */
  readonly shape: 'exact' | 'bounding-box'
}

export interface ResolvedWorkholdingPlacements {
  readonly placements: readonly ResolvedWorkholdingPlacement[]
  readonly notices: readonly string[]
}

export interface ResolvedWorkholding {
  readonly bodies: readonly ResolvedWorkholdingBody[]
  /** Plain sentences for the app console. */
  readonly notices: readonly string[]
}

export interface ResolveWorkholdingOptions {
  /** Marked rows the operation itself cuts are not obstacles to it (WO-1572). */
  readonly cutGeometryIds?: Iterable<string>
  readonly reader?: WorkholdingShapeReader
}

// ── Joint ────────────────────────────────────────────────────────────────────

export interface ResolvedJoint {
  /** The displacement used, mm. */
  readonly valueMm: number
  /** Unit axis, or null when the joint cannot move (then valueMm is 0). */
  readonly axis: Vec3 | null
}

/**
 * The displacement a saved joint value resolves to. A missing or non-finite
 * value reads as the joint's closed value; any value is kept within
 * [minMm, maxMm]. A zero or non-finite axis, or a non-finite travel, cannot
 * move at all: the component stays at the joint's zero (axis null).
 */
export function resolveJointValue(joint: WorkholdingLinearJoint, savedMm: number | undefined): ResolvedJoint {
  const a = joint.axis
  const length = a ? Math.hypot(a.x, a.y, a.z) : NaN
  if (!Number.isFinite(length) || length <= 0 || !Number.isFinite(joint.minMm) || !Number.isFinite(joint.maxMm)) {
    return { valueMm: 0, axis: null }
  }
  const lo = Math.min(joint.minMm, joint.maxMm)
  const hi = Math.max(joint.minMm, joint.maxMm)
  const wanted = Number.isFinite(savedMm) ? savedMm! : Number.isFinite(joint.closedAtMm) ? joint.closedAtMm : lo
  return {
    valueMm: Math.min(hi, Math.max(lo, wanted)),
    axis: { x: a.x / length, y: a.y / length, z: a.z / length },
  }
}

/** An instance's saved joint values: one per jointed component of `definition`, each within travel. */
export function jointValuesWithinTravel(
  definition: WorkholdingDefinition,
  saved: Readonly<Record<string, number>> | undefined,
): Record<string, number> {
  const out: Record<string, number> = {}
  for (const component of definition.components) {
    if (component.joint) out[component.id] = resolveJointValue(component.joint, saved?.[component.id]).valueMm
  }
  return out
}

export function setupScopeIncludes(scope: WorkholdingSetupScope | undefined, setupId: string | null | undefined): boolean {
  if (!scope || scope.kind === 'all') return true
  return setupId != null && Array.isArray(scope.setupIds) && scope.setupIds.includes(setupId)
}

// ── Placement (pure) ─────────────────────────────────────────────────────────

/**
 * Every workholding component in `setupId`'s scope, placed in the world. Pure:
 * reads only `project`. `setupId` null = no active setup, so only instances in
 * every setup (and marked rows) count.
 */
export function resolveWorkholdingPlacements(
  project: Pick<Project, 'geometry' | 'modelItemPlacements' | 'workholding'>,
  setupId: string | null | undefined,
  options: Pick<ResolveWorkholdingOptions, 'cutGeometryIds'> = {},
): ResolvedWorkholdingPlacements {
  const { placements: instancePlacements, notices: instanceNotices } = resolveInstancePlacements(project, setupId)
  const placements: ResolvedWorkholdingPlacement[] = [...instancePlacements]
  const notices: string[] = [...instanceNotices]

  // Today's marked rows: one-component instances in every setup. A row used as
  // an assembly component is that definition's shape data, not a body of its own.
  const componentRows = workholdingComponentGeometryIds(project.workholding)
  const cut = new Set(options.cutGeometryIds ?? [])
  for (const row of project.geometry) {
    if (row.workholding !== true || componentRows.has(row.id) || cut.has(row.id)) continue
    const worldPose = markedRowWorldPose(row, project.modelItemPlacements ?? [])
    if (!worldPose) {
      notices.push(`the workholding "${row.name || row.id}" has no Model Item placement, so it could not be placed.`)
      continue
    }
    placements.push({
      instanceId: row.id,
      componentId: row.id,
      definitionId: null,
      definitionRevision: null,
      source: 'marked-geometry',
      geometryId: row.id,
      name: row.name || row.id,
      worldFromComponent: poseToMat4(worldPose),
    })
  }
  return { placements, notices }
}

/**
 * WO-2177: only the placed INSTANCES (vises, clamps) in `setupId`'s scope, each
 * component in the world - the part of resolveWorkholdingPlacements that is new
 * with assemblies. CAM and simulation take these from here; a marked row keeps
 * the arithmetic it has always had (store/fixtureObstacles.ts).
 */
export function resolveInstancePlacements(
  project: Pick<Project, 'geometry' | 'workholding'>,
  setupId: string | null | undefined,
): ResolvedWorkholdingPlacements {
  const placements: ResolvedWorkholdingPlacement[] = []
  const notices: string[] = []
  const rows = new Map(project.geometry.map((g) => [g.id, g]))
  const definitions = new Map((project.workholding?.definitions ?? []).map((d) => [d.id, d]))
  for (const instance of project.workholding?.instances ?? []) {
    if (!setupScopeIncludes(instance.setupScope, setupId)) continue
    const definition = definitions.get(instance.definitionId)
    if (!definition) {
      notices.push(`the workholding "${instance.id}" names a definition this project does not have, so it was left out.`)
      continue
    }
    for (const component of definition.components) {
      const placed = placeInstanceComponent(instance, definition, component, rows, notices)
      if (placed) placements.push(placed)
    }
  }
  return { placements, notices }
}

/** Every geometry row some definition uses as a component (shape data, not a body of its own). */
export function workholdingComponentGeometryIds(model: Project['workholding']): Set<string> {
  return new Set((model?.definitions ?? []).flatMap((d) => d.components.map((c) => c.geometryId)))
}

function placeInstanceComponent(
  instance: WorkholdingInstance,
  definition: WorkholdingDefinition,
  component: WorkholdingComponent,
  rows: ReadonlyMap<string, ImportedGeometry>,
  notices: string[],
): ResolvedWorkholdingPlacement | null {
  const name = `${definition.name || definition.id} - ${component.name || component.id}`
  if (!rows.has(component.geometryId)) {
    notices.push(`the workholding "${name}" uses a shape this project does not have, so it was left out.`)
    return null
  }
  let jointMat = IDENTITY_MAT4
  let jointValueMm: number | undefined
  if (component.joint) {
    const joint = resolveJointValue(component.joint, instance.jointValuesMm?.[component.id])
    jointValueMm = joint.valueMm
    if (joint.axis) {
      jointMat = translationMat4({
        x: joint.axis.x * joint.valueMm, y: joint.axis.y * joint.valueMm, z: joint.axis.z * joint.valueMm,
      })
    } else {
      notices.push(
        `the moving part "${name}" has no usable slide direction or travel, so it is shown at its zero position.`,
      )
    }
  }
  return {
    instanceId: instance.id,
    componentId: component.id,
    definitionId: definition.id,
    definitionRevision: definition.revision,
    source: 'instance',
    geometryId: component.geometryId,
    name,
    worldFromComponent: multiplyMat4(
      multiplyMat4(poseToMat4(instance.worldPose), jointMat),
      poseToMat4(component.localPose),
    ),
    ...(jointValueMm !== undefined ? { jointValueMm } : {}),
  }
}

/** Where the viewport places a marked row: its own pose, or its Model Item placement.
 *  WO-2172: also where a vise is made from - its bodies stay exactly where they sit. */
export function markedRowWorldPose(
  row: ImportedGeometry,
  placements: NonNullable<Project['modelItemPlacements']>,
): WorkholdingPose | null {
  if (!isModelOriginGeometry(row)) return { position: row.position, rotation: row.rotation }
  try {
    return resolveModelReferenceFrame(placements, row.modelItemId ?? LEGACY_MODEL_ITEM_ID, row.modelBody?.ref.bodyId)
  } catch {
    return null
  }
}

// ── Shapes ───────────────────────────────────────────────────────────────────

/**
 * Every workholding component in `setupId`'s scope as a world mesh: the exact
 * imported shape when it can be read, else its bounding box with a notice. A
 * body with no volume (a flat sketch) has nothing to keep clear of and is left
 * out, as store/fixtureObstacles.ts does today.
 */
export async function resolveWorkholding(
  project: Pick<Project, 'geometry' | 'modelItemPlacements' | 'workholding'>,
  setupId: string | null | undefined,
  options: ResolveWorkholdingOptions = {},
): Promise<ResolvedWorkholding> {
  const reader = options.reader ?? cachedWorkholdingShapeReader
  const { placements, notices: placementNotices } = resolveWorkholdingPlacements(project, setupId, options)
  const notices = [...placementNotices]
  const rows = new Map(project.geometry.map((g) => [g.id, g]))
  const bodies: ResolvedWorkholdingBody[] = []
  for (const placement of placements) {
    const body = await resolvePlacedBody(placement, rows.get(placement.geometryId)!, reader)
    if (!body) continue
    bodies.push(body)
    if (body.shape === 'bounding-box') notices.push(boundingBoxNotice(placement.name))
  }
  return { bodies, notices }
}

/**
 * One placed component with its world shape: the exact display shape when it
 * can be read, else its display bounding box (see boundingBoxNotice). Null when
 * it has no volume.
 */
export async function resolvePlacedBody(
  placement: ResolvedWorkholdingPlacement,
  row: ImportedGeometry,
  reader: WorkholdingShapeReader = cachedWorkholdingShapeReader,
): Promise<ResolvedWorkholdingBody | null> {
  const exact = await readDisplayShape(row, reader)
  if (exact) return { ...placement, shape: 'exact', mesh: worldMesh(placement.worldFromComponent, exact) }
  const box = placedBoundingBox(placement, row)
  return box ? { ...placement, shape: 'bounding-box', mesh: box } : null
}

/** A placed component's display bounding box, carried to the world; null when it has no volume. */
export function placedBoundingBox(placement: ResolvedWorkholdingPlacement, row: ImportedGeometry): ClearanceMesh | null {
  const box = displayBoundingBox(row)
  return box ? worldMesh(placement.worldFromComponent, boxMesh(box.min, box.max)) : null
}

export function boundingBoxNotice(name: string): string {
  return `the shape of the workholding "${name}" could not be read, so the tool was kept clear of its bounding box.`
}

function worldMesh(m: Mat4, local: { positions: ArrayLike<number>; indices: ArrayLike<number> }): ClearanceMesh {
  return {
    positions: transformPositions(m, local.positions),
    indices: local.indices instanceof Uint32Array ? local.indices : Uint32Array.from(local.indices),
  }
}
