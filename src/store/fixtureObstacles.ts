import { operatorText } from '../i18n/locales/en/console-and-operator-messages'
// WO-1576: every operation is told where the workholding is.
//
// The ONE place a request's workholding is built. Beside the part and the
// remaining stock (toolReachInputs.ts, WO-1571/WO-1582), every generate call -
// the 2D toolpath worker and each 3D operation - gets the setup's vises, jaws and
// clamps as triangle meshes in the moves' frame, and the reach trim (WO-1575)
// keeps the whole tool the Shank clearance off them.
//
// Frames. Workholding is placed in the world exactly the way the viewport shows
// it: a Model-workbench body through the one placement seam
// (resolveModelReferenceFrame), an STL recentred to its xy centre and bottom
// then posed by the row's position and XYZ rotation (CNCViewport.addSTL), a
// STEP's display tessellation posed as it is (addBrepModel does not recentre).
// The 2D worker's moves are world, so its meshes are used as they are; a 3D
// operation computes in its part's display-local frame (translation plus a spin
// about Z), so `workholdingInPartFrame` takes the meshes into that frame.
//
// Nothing is refused because a shape cannot be read (rule 11): the body's
// bounding box stands in for it, and the console says so.
//
// WO-2177 (workholding assemblies, slice 3): a vise or clamp placed as an
// INSTANCE (project.workholding) is read from the ONE resolver
// (lib/workholding/resolveWorkholding.ts) the screen draws from, for the setup
// the operation is in - so the keep-out moves exactly as the drawn jaw does, and
// a setup outside the instance's scope never sees it. A row that is a vise's
// shape data is that vise's body, not also an obstacle of its own. Every other
// marked row keeps the arithmetic below unchanged: a project with no instance
// gets byte-identical meshes (src/tests/workholding/existingWorkholdingUnchanged.wo2177.test.ts).

import type { ImportedGeometry, ModelItemPlacementRecord, Setup, Vec3, WorkholdingModel, WorkholdingSetupScope } from '../types'
import type { ClearanceMesh } from '../lib/cam/holderClearance'
import { isModelOriginGeometry } from '../lib/cam/modelOrigin'
import { resolveModelReferenceFrame } from '../lib/cam/modelReferenceFrame'
import { worldBakedMesh } from '../lib/cam/booleanMeshModel'
import { rotationMatrixXYZ } from '../lib/geometry/rotationMatrixXYZ'
import { cachedWorkholdingShapeReader, type WorkholdingShapeReader } from '../lib/workholding/shapes'
import {
  boundingBoxNotice, resolveInstancePlacements, resolvePlacedBody, setupScopeIncludes, workholdingComponentGeometryIds,
} from '../lib/workholding/resolveWorkholding'
import { isWorkholdingGeometry } from './dispatchGeo'

/** Must equal src/doc/documentHolder.ts's LEGACY_MODEL_ITEM_ID (toolReachInputs.ts keeps the same copy). */
const LEGACY_MODEL_ITEM_ID = 'legacy'

export interface WorkholdingObstacles {
  /** One mesh per workholding body, world frame. */
  readonly meshes: readonly ClearanceMesh[]
  /** Plain sentences for the app console (a shape read as its bounding box). */
  readonly notices: readonly string[]
}

/** WO-2177: the placed vises and clamps, and the setup whose operation is generating. */
export interface WorkholdingAssemblyScope {
  readonly workholding: WorkholdingModel | undefined
  readonly setupId: string | null
}

const NO_OBSTACLES: WorkholdingObstacles = { meshes: [], notices: [] }

/**
 * The workholding an operation must keep clear of, in world. `cutGeometryIds`
 * are the rows the operation itself cuts: a body the operator marked as
 * workholding and then chose to machine is not an obstacle to that operation
 * (WO-1572 lets an operation name it). `assemblies` (WO-2177) adds the vises
 * and clamps placed in the operation's setup, where the resolver puts them.
 */
export async function resolveWorkholdingObstacles(
  geometry: readonly ImportedGeometry[],
  placements: readonly ModelItemPlacementRecord[] | undefined,
  cutGeometryIds: Iterable<string> = [],
  reader: WorkholdingShapeReader = cachedWorkholdingShapeReader,
  assemblies?: WorkholdingAssemblyScope,
): Promise<WorkholdingObstacles> {
  const cut = new Set(cutGeometryIds)
  const componentRows = workholdingComponentGeometryIds(assemblies?.workholding)
  const instances = assemblies
    ? resolveInstancePlacements({ geometry: [...geometry], workholding: assemblies.workholding }, assemblies.setupId)
    : { placements: [], notices: [] }
  const bodies = geometry.filter((g) => isWorkholdingGeometry(g) && !cut.has(g.id) && !componentRows.has(g.id))
  if (bodies.length === 0 && instances.placements.length === 0 && instances.notices.length === 0) return NO_OBSTACLES
  const meshes: ClearanceMesh[] = []
  const notices: string[] = [...instances.notices]
  const rows = new Map(geometry.map((g) => [g.id, g]))
  for (const placement of instances.placements) {
    if (cut.has(placement.geometryId)) continue // a vise body this operation machines (soft jaw), WO-1572
    const body = await resolvePlacedBody(placement, rows.get(placement.geometryId)!, reader)
    if (!body) continue
    meshes.push(body.mesh)
    if (body.shape === 'bounding-box') notices.push(boundingBoxNotice(placement.name))
  }
  for (const body of bodies) {
    const exact = await exactWorldMesh(body, placements ?? [], reader)
    if (exact) {
      meshes.push(exact)
      continue
    }
    const box = boundingBoxWorldMesh(body, placements ?? [])
    if (!box) continue // a flat sketch has no height to keep clear of
    meshes.push(box)
    notices.push(boundingBoxNotice(body.name || body.id))
  }
  return { meshes, notices }
}

/**
 * World meshes taken into a 3D operation's display-local frame: the inverse of
 * world = position + Rz(local) (worldPlaceParallel3dMoves in the store).
 */
export function workholdingInPartFrame(
  meshes: readonly ClearanceMesh[],
  position: Vec3,
  rotZDeg: number,
): ClearanceMesh[] {
  if (position.x === 0 && position.y === 0 && position.z === 0 && rotZDeg === 0) return [...meshes]
  const rad = (rotZDeg * Math.PI) / 180
  const c = Math.cos(rad)
  const s = Math.sin(rad)
  return meshes.map((mesh) => {
    const out = new Float32Array(mesh.positions.length)
    for (let i = 0; i + 2 < mesh.positions.length; i += 3) {
      const dx = mesh.positions[i] - position.x
      const dy = mesh.positions[i + 1] - position.y
      out[i] = dx * c + dy * s
      out[i + 1] = -dx * s + dy * c
      out[i + 2] = mesh.positions[i + 2] - position.z
    }
    return { positions: out, indices: mesh.indices }
  })
}

/**
 * Changing, moving, marking or unmarking workholding changes what every
 * operation must keep clear of, so every generated operation goes outdated, as
 * one does when its part moves. Returns the same array when nothing changed.
 */
export function outdateOperationsForWorkholding(setups: Setup[]): Setup[] {
  return outdateReadyOperations(setups, () => true)
}

/**
 * WO-2177: a vise or clamp placed as an instance is in only the setups of its
 * scope, so changing it outdates the generated operations of those setups and
 * no others. `scopes` are every scope the change touches (before and after).
 * Returns the same array when nothing changed.
 */
export function outdateOperationsForWorkholdingScopes(
  setups: Setup[],
  scopes: readonly (WorkholdingSetupScope | undefined)[],
): Setup[] {
  if (scopes.length === 0) return setups
  return outdateReadyOperations(setups, (setup) => scopes.some((scope) => setupScopeIncludes(scope, setup.id)))
}

/**
 * WO-2177: the setup scopes a workholding-model edit touches: every instance
 * whose own record or definition changed, in its scope before AND after (moving
 * a vise from one setup to another changes both). Making or removing a vise
 * also turns marked bodies into its shape data or back - they were obstacles in
 * every setup - so a change in which rows are components touches every setup.
 */
export function workholdingChangeScopes(
  before: WorkholdingModel | undefined,
  after: WorkholdingModel | undefined,
): WorkholdingSetupScope[] {
  const key = (ids: Set<string>) => [...ids].sort().join('|')
  if (key(workholdingComponentGeometryIds(before)) !== key(workholdingComponentGeometryIds(after))) {
    return [{ kind: 'all' }]
  }
  const snapshot = (model: WorkholdingModel | undefined) => {
    const definitions = new Map((model?.definitions ?? []).map((d) => [d.id, d]))
    return new Map((model?.instances ?? []).map((i) => [i.id, {
      scope: i.setupScope,
      json: JSON.stringify([i, definitions.get(i.definitionId) ?? null]),
    }]))
  }
  const was = snapshot(before)
  const now = snapshot(after)
  const scopes: WorkholdingSetupScope[] = []
  for (const id of new Set([...was.keys(), ...now.keys()])) {
    const a = was.get(id)
    const b = now.get(id)
    if (a?.json === b?.json) continue
    if (a) scopes.push(a.scope)
    if (b) scopes.push(b.scope)
  }
  return scopes
}

/**
 * WO-2177: `project` with its workholding model replaced by `next`, and the
 * generated operations of every setup the change touches outdated - the one
 * seam each vise/clamp edit goes through. Nothing changed = nothing outdated.
 */
export function withWorkholdingModel<P extends { setups: Setup[]; workholding?: WorkholdingModel }>(
  project: P,
  next: WorkholdingModel | undefined,
): P {
  const setups = outdateOperationsForWorkholdingScopes(project.setups, workholdingChangeScopes(project.workholding, next))
  return { ...project, workholding: next, setups }
}

function outdateReadyOperations(setups: Setup[], affects: (setup: Setup) => boolean): Setup[] {
  let changed = false
  const next = setups.map((setup) => {
    if (!affects(setup) || !setup.operations.some((op) => op.status === 'ready')) return setup
    changed = true
    return {
      ...setup,
      operations: setup.operations.map((op) =>
        op.status === 'ready' ? { ...op, status: 'outdated' as const, toolpathMoves: undefined } : op,
      ),
    }
  })
  return changed ? next : setups
}

// ── Shapes ───────────────────────────────────────────────────────────────────

async function exactWorldMesh(
  body: ImportedGeometry,
  placements: readonly ModelItemPlacementRecord[],
  reader: WorkholdingShapeReader,
): Promise<ClearanceMesh | null> {
  try {
    if (isModelOriginGeometry(body)) {
      const display = body.modelBody?.display
      if (!display || display.positions.length < 9 || display.indices.length < 3) return null
      const frame = resolveModelReferenceFrame(
        placements, body.modelItemId ?? LEGACY_MODEL_ITEM_ID, body.modelBody?.ref.bodyId,
      )
      return worldBakedMesh(display.positions, display.indices, frame)
    }
    const local = body.format === 'stl'
      ? await reader.stl(body.id)
      : body.format === 'step'
        ? await reader.step(body.id)
        : null
    if (!local || local.positions.length < 9 || local.indices.length < 3) return null
    return posed(local.positions, local.indices, body.position, body.rotation)
  } catch (err) {
    console.warn(operatorText('fixtureObstacles1', { value1: String(body.name || body.id) }), err)
    return null
  }
}

function boundingBoxWorldMesh(
  body: ImportedGeometry,
  placements: readonly ModelItemPlacementRecord[],
): ClearanceMesh | null {
  const display = body.modelBody?.display
  const min = isModelOriginGeometry(body) && display
    ? { x: display.bbox.min[0], y: display.bbox.min[1], z: display.bbox.min[2] }
    : body.boundingBox?.min
  const max = isModelOriginGeometry(body) && display
    ? { x: display.bbox.max[0], y: display.bbox.max[1], z: display.bbox.max[2] }
    : body.boundingBox?.max
  if (!min || !max) return null
  if (![min.x, min.y, min.z, max.x, max.y, max.z].every(Number.isFinite)) return null
  if (!(max.x > min.x && max.y > min.y && max.z > min.z)) return null
  const positions: number[] = []
  for (const z of [min.z, max.z]) for (const y of [min.y, max.y]) for (const x of [min.x, max.x]) positions.push(x, y, z)
  // Corner i = x + 2y + 4z; two outward triangles per face.
  const indices = [
    0, 2, 3, 0, 3, 1, 4, 5, 7, 4, 7, 6, // bottom, top
    0, 1, 5, 0, 5, 4, 2, 6, 7, 2, 7, 3, // -y, +y
    0, 4, 6, 0, 6, 2, 1, 3, 7, 1, 7, 5, // -x, +x
  ]
  try {
    if (isModelOriginGeometry(body)) {
      const frame = resolveModelReferenceFrame(
        placements, body.modelItemId ?? LEGACY_MODEL_ITEM_ID, body.modelBody?.ref.bodyId,
      )
      return worldBakedMesh(positions, indices, frame)
    }
    return posed(positions, indices, body.position, body.rotation)
  } catch {
    return null
  }
}

/** world = position + R(rotation XYZ degrees) * local - the viewport group transform. */
function posed(
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
  position: Vec3 | undefined,
  rotation: Vec3 | undefined,
): ClearanceMesh {
  const { col1, col2, col3 } = rotationMatrixXYZ(rotation)
  const px = position?.x ?? 0, py = position?.y ?? 0, pz = position?.z ?? 0
  const out = new Float32Array(positions.length - (positions.length % 3))
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2]
    out[i] = col1.x * x + col2.x * y + col3.x * z + px
    out[i + 1] = col1.y * x + col2.y * y + col3.y * z + py
    out[i + 2] = col1.z * x + col2.z * y + col3.z * z + pz
  }
  return { positions: out, indices: indices instanceof Uint32Array ? indices : Uint32Array.from(indices) }
}
