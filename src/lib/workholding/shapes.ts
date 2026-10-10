// WO-2167: the imported shape of a workholding body in its own display frame.
//
// Each format has its own base frame, and this is the one place the assembly
// resolver reads it (docs/design/WORKHOLDING-ASSEMBLIES.md, risk 5):
//   - STL: the cached bytes parsed, then recentred the way CNCViewport.addSTL
//     draws them - centred in X and Y, bottom on Z 0.
//   - STEP: the cached display tessellation as it is (addBrepModel does not
//     recentre).
//   - Model: the body's own display tessellation, carried on the row.
// Placing that frame in the world is the resolver's job, not the row's.

import type { ImportedGeometry, Vec3 } from '../../types'
import { isModelOriginGeometry } from '../cam/modelOrigin'
import { loadCachedSTL } from '../stlCache'
import { loadCachedStepDisplay } from '../stepCache'
import { importStlToPartMesh } from '../../cam3d/input'

/** A triangle mesh in a body's own (display-local) frame. */
export interface LocalMesh {
  readonly positions: ArrayLike<number>
  readonly indices: ArrayLike<number>
}

/** Reads the imported shape of a row. Null = not available. */
export interface WorkholdingShapeReader {
  stl(geometryId: string): Promise<LocalMesh | null>
  step(geometryId: string): Promise<LocalMesh | null>
}

/** The imported shapes as the viewport draws them (STL recentred, STEP as cached). */
export const cachedWorkholdingShapeReader: WorkholdingShapeReader = {
  async stl(geometryId) {
    const bytes = await loadCachedSTL(geometryId)
    if (!bytes) return null
    const { mesh } = await importStlToPartMesh(bytes)
    return recentredForDisplay(mesh.positions, mesh.indices)
  },
  async step(geometryId) {
    const cached = await loadCachedStepDisplay(geometryId)
    const mesh = cached?.payload?.mesh
    return mesh ? { positions: mesh.positions, indices: mesh.indices } : null
  },
}

/** The row's exact shape in its display frame, or null when it cannot be read. */
export async function readDisplayShape(
  row: ImportedGeometry,
  reader: WorkholdingShapeReader,
): Promise<LocalMesh | null> {
  try {
    const mesh = isModelOriginGeometry(row)
      ? row.modelBody?.display ?? null
      : row.format === 'stl'
        ? await reader.stl(row.id)
        : row.format === 'step'
          ? await reader.step(row.id)
          : null
    if (!mesh || mesh.positions.length < 9 || mesh.indices.length < 3) return null
    return { positions: mesh.positions, indices: mesh.indices }
  } catch {
    return null // the bounding box stands in, and the resolver says so
  }
}

/** The row's bounding box in its display frame; null when it has no volume (a flat sketch). */
export function displayBoundingBox(row: ImportedGeometry): { min: Vec3; max: Vec3 } | null {
  const display = isModelOriginGeometry(row) ? row.modelBody?.display : undefined
  const min = display
    ? { x: display.bbox.min[0], y: display.bbox.min[1], z: display.bbox.min[2] }
    : row.boundingBox?.min
  const max = display
    ? { x: display.bbox.max[0], y: display.bbox.max[1], z: display.bbox.max[2] }
    : row.boundingBox?.max
  if (!min || !max) return null
  if (![min.x, min.y, min.z, max.x, max.y, max.z].every(Number.isFinite)) return null
  if (!(max.x > min.x && max.y > min.y && max.z > min.z)) return null
  return { min, max }
}

/** A closed box mesh over `min`..`max`: corner i = x + 2y + 4z, two outward triangles per face. */
export function boxMesh(min: Vec3, max: Vec3): LocalMesh {
  const positions: number[] = []
  for (const z of [min.z, max.z]) for (const y of [min.y, max.y]) for (const x of [min.x, max.x]) positions.push(x, y, z)
  const indices = [
    0, 2, 3, 0, 3, 1, 4, 5, 7, 4, 7, 6, // bottom, top
    0, 1, 5, 0, 5, 4, 2, 6, 7, 2, 7, 3, // -y, +y
    0, 4, 6, 0, 6, 2, 1, 3, 7, 1, 7, 5, // -x, +x
  ]
  return { positions, indices }
}

/** CNCViewport.addSTL: centre in x and y, bottom on Z = 0. */
export function recentredForDisplay(positions: ArrayLike<number>, indices: ArrayLike<number>): LocalMesh {
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity
  for (let i = 0; i + 2 < positions.length; i += 3) {
    minX = Math.min(minX, positions[i]); maxX = Math.max(maxX, positions[i])
    minY = Math.min(minY, positions[i + 1]); maxY = Math.max(maxY, positions[i + 1])
    minZ = Math.min(minZ, positions[i + 2])
  }
  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2
  const out = new Float32Array(positions.length)
  for (let i = 0; i + 2 < positions.length; i += 3) {
    out[i] = positions[i] - cx
    out[i + 1] = positions[i + 1] - cy
    out[i + 2] = positions[i + 2] - minZ
  }
  return { positions: out, indices }
}
