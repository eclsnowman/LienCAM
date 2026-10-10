// WO-2198 (workholding assemblies, slice 6): a vise or clamp made once is
// used again (docs/design/WORKHOLDING-ASSEMBLIES.md "Save, reopen, and reuse",
// product choice 3: project-local definitions plus import/export first).
//
//   - Place another: a new INSTANCE of the same definition, beside the one it
//     came from, with its own pose and opening. The definition - its shapes
//     and joint - is stored once and shared (same id, same revision).
//   - Export: the definition written to a self-contained file - every
//     component's shape as a binary STL in the component's display frame, the
//     joint, and where the exported vise sat and how far it was open.
//   - Import: that file copied into a project as the project's OWN
//     definition - new definition id, new shape rows with their own cached
//     bytes. Nothing links back to the file or the project it came from, so a
//     later change to either never changes the importing project.
//
// Every pose still comes from the ONE resolver (./resolveWorkholding.ts); a
// shape that has to be re-written as an STL (a STEP or Model body) has the
// STL display recentring folded into its component pose, so the imported
// body resolves where the exported one did. Nothing here refuses or warns: a
// file that cannot be read is just "could not be read" (null).

import type {
  BoundingBox, ImportedGeometry, Project, Vec3, WorkholdingComponent, WorkholdingDefinition,
  WorkholdingInstance, WorkholdingPose,
} from '../../types'
import { isModelOriginGeometry } from '../cam/modelOrigin'
import { exportBinaryStl } from '../../mesh/stl'
import { arrayBufferToBase64, base64ToArrayBuffer } from '../projectBinaries'
import { loadCachedSTL } from '../stlCache'
import { importStlToPartMesh } from '../../cam3d/input/stl'
import { mat4ToPose, multiplyMat4, poseToMat4, transformPoint, translationMat4 } from './pose'
import { jointValuesWithinTravel, resolveWorkholdingPlacements } from './resolveWorkholding'
import {
  boxMesh, cachedWorkholdingShapeReader, displayBoundingBox, readDisplayShape, recentredForDisplay,
  type LocalMesh, type WorkholdingShapeReader,
} from './shapes'

type ReuseProject = Pick<Project, 'geometry' | 'modelItemPlacements' | 'workholding'>

export const WORKHOLDING_FILE_FORMAT = 'liencam-workholding'
export const WORKHOLDING_FILE_VERSION = 1
/** The file name ending an exported vise or clamp is saved with. */
export const WORKHOLDING_FILE_SUFFIX = '.workholding.json'

export interface WorkholdingFileShape {
  readonly name: string
  /** A binary STL, base64, in the component's display frame as an STL is drawn. */
  readonly stl: string
}

export interface WorkholdingFile {
  readonly format: typeof WORKHOLDING_FILE_FORMAT
  readonly version: number
  /** Each component's geometryId names an entry of `shapes`. */
  readonly definition: WorkholdingDefinition
  readonly shapes: Readonly<Record<string, WorkholdingFileShape>>
  /** Where the exported vise sat and how far it was open (absent for a clamp). */
  readonly placedAt?: { readonly worldPose: WorkholdingPose; readonly jointValuesMm: Readonly<Record<string, number>> }
}

// ── Place another ───────────────────────────────────────────────────────────

const GAP_MM = 20

/** The world box an instance's components resolve to, ignoring its setup scope; null when none has volume. */
export function instanceWorldBox(project: ReuseProject, instance: WorkholdingInstance): { min: Vec3; max: Vec3 } | null {
  const unscoped: ReuseProject = {
    ...project,
    workholding: {
      definitions: project.workholding?.definitions ?? [],
      instances: [{ ...instance, setupScope: { kind: 'all' } }],
    },
  }
  const rows = new Map(project.geometry.map((g) => [g.id, g]))
  const lo = { x: Infinity, y: Infinity, z: Infinity }
  const hi = { x: -Infinity, y: -Infinity, z: -Infinity }
  for (const placement of resolveWorkholdingPlacements(unscoped, null).placements) {
    if (placement.instanceId !== instance.id) continue
    const row = rows.get(placement.geometryId)
    const box = row ? displayBoundingBox(row) : null
    if (!box) continue
    for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
      const p = transformPoint(placement.worldFromComponent, { x, y, z })
      lo.x = Math.min(lo.x, p.x); lo.y = Math.min(lo.y, p.y); lo.z = Math.min(lo.z, p.z)
      hi.x = Math.max(hi.x, p.x); hi.y = Math.max(hi.y, p.y); hi.z = Math.max(hi.z, p.z)
    }
  }
  return Number.isFinite(lo.x) ? { min: lo, max: hi } : null
}

/**
 * Another instance of `source`'s definition: beside it along world +X (its
 * width plus 20 mm), at the same opening, in `setupId` (null = every setup).
 * It shares the definition and its revision; it has its own id, pose and
 * joint values. A clamp keeps its edge anchor only through the clamp actions,
 * so a copy made here is placed freely where it lands.
 */
export function anotherInstance(
  project: ReuseProject,
  source: WorkholdingInstance,
  definition: WorkholdingDefinition,
  setupId: string | null,
  id: string,
): WorkholdingInstance {
  const box = instanceWorldBox(project, source)
  const step = (box ? box.max.x - box.min.x : 0) + GAP_MM
  const p = source.worldPose.position
  return {
    id,
    definitionId: definition.id,
    definitionRevision: definition.revision,
    setupScope: setupId ? { kind: 'setups', setupIds: [setupId] } : { kind: 'all' },
    worldPose: { position: { x: p.x + step, y: p.y, z: p.z }, rotation: { ...source.worldPose.rotation } },
    jointValuesMm: jointValuesWithinTravel(definition, source.jointValuesMm),
    placement: { kind: 'free' },
  }
}

/**
 * The instance whose definition's shape ROWS are drawn in the viewport for
 * each vise/fixture definition: the first placed in instance order. Every
 * other instance of that definition is drawn as its own copy of the shapes
 * (components/workholding/clampViewport.ts), so one row is never asked to
 * stand in two places. vise.ts workholdingOfGeometry names the same instance.
 */
export function rowDrawnInstanceIds(model: Project['workholding']): Set<string> {
  const clampDefinitions = new Set((model?.definitions ?? []).filter((d) => d.kind === 'clamp').map((d) => d.id))
  const seen = new Set<string>()
  const out = new Set<string>()
  for (const instance of model?.instances ?? []) {
    if (clampDefinitions.has(instance.definitionId) || seen.has(instance.definitionId)) continue
    seen.add(instance.definitionId)
    out.add(instance.id)
  }
  return out
}

// ── Export ──────────────────────────────────────────────────────────────────

export interface ExportDeps {
  readonly reader?: WorkholdingShapeReader
  /** The cached bytes of an STL row (lib/stlCache loadCachedSTL). */
  readonly loadStl?: (geometryId: string) => Promise<ArrayBuffer | null>
}

function float32Mesh(mesh: LocalMesh) {
  return {
    positions: mesh.positions instanceof Float32Array ? mesh.positions : Float32Array.from(mesh.positions),
    indices: mesh.indices instanceof Uint32Array ? mesh.indices : Uint32Array.from(mesh.indices),
  }
}

/** Where the STL display recentring moves `positions` from: centre X/Y, bottom Z. */
function recentringOffset(positions: ArrayLike<number>): Vec3 {
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity
  for (let i = 0; i + 2 < positions.length; i += 3) {
    minX = Math.min(minX, positions[i]); maxX = Math.max(maxX, positions[i])
    minY = Math.min(minY, positions[i + 1]); maxY = Math.max(maxY, positions[i + 1])
    minZ = Math.min(minZ, positions[i + 2])
  }
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2, z: minZ }
}

/**
 * The definition an instance places, written as a self-contained file. Each
 * component's shape is what the resolver reads for it: an STL row's own
 * cached bytes as they are; a STEP or Model body's display mesh written as an
 * STL (its recentring folded into the component pose); a shape that cannot
 * be read, its bounding box (the box CAM already keeps clear of) - the notice
 * says so. Null when the instance or its definition is not in the project.
 */
export async function exportWorkholding(
  project: ReuseProject,
  instanceId: string,
  deps: ExportDeps = {},
): Promise<{ file: WorkholdingFile; notices: string[] } | null> {
  const reader = deps.reader ?? cachedWorkholdingShapeReader
  const instance = project.workholding?.instances.find((i) => i.id === instanceId)
  const definition = project.workholding?.definitions.find((d) => d.id === instance?.definitionId)
  if (!instance || !definition) return null
  const rows = new Map(project.geometry.map((g) => [g.id, g]))
  const notices: string[] = []
  const shapes: Record<string, WorkholdingFileShape> = {}
  const components: WorkholdingComponent[] = []
  for (const component of definition.components) {
    const row = rows.get(component.geometryId)
    const label = `${definition.name} - ${component.name || component.id}`
    if (!row) {
      notices.push(`the workholding "${label}" uses a shape this project does not have, so it was left out of the file.`)
      continue
    }
    const key = `shape-${components.length + 1}`
    let bytes: ArrayBuffer | null = null
    let localPose = component.localPose
    if (row.format === 'stl' && !isModelOriginGeometry(row)) {
      bytes = await (deps.loadStl ?? loadCachedSTL)(row.id).catch(() => null)
    }
    if (!bytes) {
      let mesh = await readDisplayShape(row, reader)
      if (!mesh) {
        const box = displayBoundingBox(row)
        if (!box) {
          notices.push(`the workholding "${label}" has no shape or size to write, so it was left out of the file.`)
          continue
        }
        mesh = boxMesh(box.min, box.max)
        notices.push(`the shape of the workholding "${label}" could not be read, so its bounding box was written instead.`)
      }
      const f32 = float32Mesh(mesh)
      bytes = exportBinaryStl(f32).bytes
      // An STL is drawn recentred; the component pose carries it back to where this shape sat.
      localPose = mat4ToPose(multiplyMat4(poseToMat4(component.localPose), translationMat4(recentringOffset(f32.positions))))
    }
    shapes[key] = { name: row.name || component.name || key, stl: arrayBufferToBase64(bytes) }
    components.push({ ...component, geometryId: key, localPose })
  }
  const file: WorkholdingFile = {
    format: WORKHOLDING_FILE_FORMAT,
    version: WORKHOLDING_FILE_VERSION,
    definition: { ...definition, components },
    shapes,
    ...(definition.kind !== 'clamp'
      ? { placedAt: { worldPose: instance.worldPose, jointValuesMm: jointValuesWithinTravel(definition, instance.jointValuesMm) } }
      : {}),
  }
  return { file, notices }
}

/** A file name for an exported definition: its name, filesystem-safe, plus the suffix. */
export function workholdingFileName(name: string): string {
  const safe = name.trim().replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ') || 'workholding'
  return `${safe}${WORKHOLDING_FILE_SUFFIX}`
}

// ── Import ──────────────────────────────────────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isVec = (v: unknown): v is Vec3 => isObj(v) && isNum(v.x) && isNum(v.y) && isNum(v.z)
const isPose = (v: unknown): v is WorkholdingPose => isObj(v) && isVec(v.position) && isVec(v.rotation)

/** A workholding file's text read back, or null when it is not one this app can read. */
export function parseWorkholdingFile(text: string): WorkholdingFile | null {
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return null }
  if (!isObj(raw) || raw.format !== WORKHOLDING_FILE_FORMAT || !isNum(raw.version)) return null
  if (raw.version > WORKHOLDING_FILE_VERSION) return null
  const d = raw.definition
  const shapes = raw.shapes
  if (!isObj(d) || !isObj(shapes) || !Array.isArray(d.components) || d.components.length === 0) return null
  if (d.kind !== 'vise' && d.kind !== 'clamp' && d.kind !== 'fixture') return null
  for (const c of d.components as unknown[]) {
    if (!isObj(c) || typeof c.id !== 'string' || typeof c.geometryId !== 'string' || !isPose(c.localPose)) return null
    const shape = shapes[c.geometryId]
    if (!isObj(shape) || typeof shape.stl !== 'string') return null
    if (c.joint !== undefined) {
      const j = c.joint
      if (!isObj(j) || j.kind !== 'linear' || !isVec(j.axis) || !isNum(j.minMm) || !isNum(j.maxMm)) return null
    }
  }
  const placedAt = raw.placedAt
  if (placedAt !== undefined && (!isObj(placedAt) || !isPose(placedAt.worldPose) || !isObj(placedAt.jointValuesMm))) return null
  return raw as unknown as WorkholdingFile
}

export interface PreparedWorkholdingImport {
  /** The project's own copy: a new id, each component on a new shape row. */
  readonly definition: WorkholdingDefinition
  /** New geometry rows (STL, marked workholding) holding the shapes. */
  readonly rows: ImportedGeometry[]
  /** Each new row's STL bytes, to cache under its id. */
  readonly bytes: ReadonlyMap<string, ArrayBuffer>
  readonly placedAt?: WorkholdingFile['placedAt']
}

function bbox(min: Vec3, max: Vec3): BoundingBox {
  return {
    min, max,
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
  }
}

/**
 * A read file turned into the rows and definition a project adds: each shape
 * decoded, its display box measured the way the viewport draws an STL, a new
 * id for everything. Null when a shape's bytes are not a readable STL.
 */
export async function prepareWorkholdingImport(
  file: WorkholdingFile,
  newId: (kind: 'definition' | 'row') => string,
): Promise<PreparedWorkholdingImport | null> {
  const rowIdOfKey = new Map<string, string>()
  const rows: ImportedGeometry[] = []
  const bytes = new Map<string, ArrayBuffer>()
  const definitionId = newId('definition')
  const name = (typeof file.definition.name === 'string' && file.definition.name.trim()) || 'Workholding'
  for (const component of file.definition.components) {
    if (rowIdOfKey.has(component.geometryId)) continue
    const shape = file.shapes[component.geometryId]
    let buffer: ArrayBuffer
    let display: LocalMesh
    try {
      buffer = base64ToArrayBuffer(shape.stl)
      const { mesh } = await importStlToPartMesh(buffer.slice(0))
      display = recentredForDisplay(mesh.positions, mesh.indices)
    } catch {
      return null
    }
    if (display.positions.length < 9 || display.indices.length < 3) return null
    const lo = { x: Infinity, y: Infinity, z: Infinity }
    const hi = { x: -Infinity, y: -Infinity, z: -Infinity }
    for (let i = 0; i + 2 < display.positions.length; i += 3) {
      lo.x = Math.min(lo.x, display.positions[i]); hi.x = Math.max(hi.x, display.positions[i])
      lo.y = Math.min(lo.y, display.positions[i + 1]); hi.y = Math.max(hi.y, display.positions[i + 1])
      lo.z = Math.min(lo.z, display.positions[i + 2]); hi.z = Math.max(hi.z, display.positions[i + 2])
    }
    const id = newId('row')
    rowIdOfKey.set(component.geometryId, id)
    const shapeName = (typeof shape.name === 'string' && shape.name.trim()) || component.name || 'Shape'
    rows.push({
      id,
      name: shapeName,
      filename: `${name}${WORKHOLDING_FILE_SUFFIX}`,
      type: 'mesh',
      format: 'stl',
      boundingBox: bbox(lo, hi),
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      loaded: true,
      workholding: true,
      faceCount: display.indices.length / 3,
    })
    bytes.set(id, buffer)
  }
  const definition: WorkholdingDefinition = {
    id: definitionId,
    revision: isNum(file.definition.revision) ? file.definition.revision : 1,
    name,
    kind: file.definition.kind,
    components: file.definition.components.map((c) => ({
      id: c.id,
      name: c.name || c.id,
      geometryId: rowIdOfKey.get(c.geometryId)!,
      localPose: { position: { ...c.localPose.position }, rotation: { ...c.localPose.rotation } },
      ...(c.joint ? {
        joint: {
          kind: 'linear' as const,
          axis: { ...c.joint.axis },
          minMm: c.joint.minMm,
          maxMm: c.joint.maxMm,
          closedAtMm: isNum(c.joint.closedAtMm) ? c.joint.closedAtMm : Math.min(c.joint.minMm, c.joint.maxMm),
        },
      } : {}),
    })),
  }
  // Each row sits where its component is drawn at the file's placement, so if
  // the vise is later removed its bodies stay where they were seen.
  const pose = file.placedAt?.worldPose
  if (pose) {
    const placed = resolveWorkholdingPlacements({
      geometry: rows,
      workholding: {
        definitions: [definition],
        instances: [{
          id: 'placed', definitionId, definitionRevision: definition.revision, setupScope: { kind: 'all' },
          worldPose: pose, jointValuesMm: { ...file.placedAt!.jointValuesMm },
        }],
      },
    }, null).placements
    for (const p of placed) {
      const row = rows.find((r) => r.id === p.geometryId)
      if (!row) continue
      const at = mat4ToPose(p.worldFromComponent)
      row.position = at.position
      row.rotation = at.rotation
    }
  }
  return { definition, rows, bytes, ...(file.placedAt ? { placedAt: file.placedAt } : {}) }
}
