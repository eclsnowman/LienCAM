import type { ImportedGeometry, ModelItemPlacementRecord, Vec3 } from '../../types'
import type { PartMesh } from '../kernel/types'
import { sanitizeTriangleMesh } from '../input/sanitize'
import { isModelOriginGeometry, resolveOwningModelItemId } from '../../lib/cam/modelOrigin'
import { resolveModelReferenceFrame } from '../../lib/cam/modelReferenceFrame'
import { turnWorldPointForSecondSide, type SecondSideTurn } from '../../lib/cam/flipSetup'

export class Adaptive3dPartSourceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'Adaptive3dPartSourceError'
  }
}

export interface ResolvedAdaptive3dPartSource {
  partMesh: PartMesh
  position: Vec3
  rotation: Vec3
}

function recenterStlForDisplay(mesh: PartMesh): PartMesh {
  const cx = (mesh.bounds.min[0] + mesh.bounds.max[0]) / 2
  const cy = (mesh.bounds.min[1] + mesh.bounds.max[1]) / 2
  const zBase = mesh.bounds.min[2]
  const positions = new Float32Array(mesh.positions.length)
  for (let i = 0; i < mesh.positions.length; i += 3) {
    positions[i] = mesh.positions[i] - cx
    positions[i + 1] = mesh.positions[i + 1] - cy
    positions[i + 2] = mesh.positions[i + 2] - zBase
  }
  return {
    ...mesh,
    positions,
    bounds: {
      min: [mesh.bounds.min[0] - cx, mesh.bounds.min[1] - cy, 0],
      max: [mesh.bounds.max[0] - cx, mesh.bounds.max[1] - cy, mesh.bounds.max[2] - zBase],
    },
  }
}

function modeledPartMesh(geo: ImportedGeometry, operationLabel: string): PartMesh {
  const display = geo.modelBody?.display
  if (!display || display.positions.length === 0 || display.indices.length === 0) {
    throw new Adaptive3dPartSourceError(
      `Modeled solid "${geo.name}" has no tessellated geometry. Open the Model workspace ` +
        `once so the body can regenerate, then retry ${operationLabel}.`,
    )
  }
  if (display.positions.length % 3 !== 0 || display.indices.length % 3 !== 0) {
    throw new Adaptive3dPartSourceError(
      `Modeled solid "${geo.name}" has malformed tessellation arrays; re-sync the body in ` +
        `the Model workspace before computing ${operationLabel}.`,
    )
  }

  const positions = Float32Array.from(display.positions)
  const indices = Uint32Array.from(display.indices)
  const faceIds = display.triFace?.length === indices.length / 3
    ? Uint32Array.from(display.triFace)
    : undefined
  let clean: ReturnType<typeof sanitizeTriangleMesh>
  try {
    clean = sanitizeTriangleMesh(positions, indices, faceIds)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    throw new Adaptive3dPartSourceError(
      `Modeled solid "${geo.name}" has invalid tessellation (${reason}). ` +
        `Re-sync the body before computing ${operationLabel}.`,
    )
  }
  if (clean.droppedDegenerateTriangles > 0) {
    console.warn(
      `[${operationLabel}] Modeled solid "${geo.name}": dropped ` +
        `${clean.droppedDegenerateTriangles} degenerate triangle` +
        `${clean.droppedDegenerateTriangles === 1 ? '' : 's'} before machining.`,
    )
  }
  if (!clean.watertight && !clean.watertightBeforeRepair) {
    throw new Adaptive3dPartSourceError(
      `Modeled solid "${geo.name}" is still not a closed, watertight solid after dropping ` +
        `${clean.droppedDegenerateTriangles} degenerate triangle` +
        `${clean.droppedDegenerateTriangles === 1 ? '' : 's'}: ` +
        `${clean.boundaryEdges} open edge${clean.boundaryEdges === 1 ? '' : 's'} and ` +
        `${clean.oversharedEdges} edge${clean.oversharedEdges === 1 ? '' : 's'} shared by more than ` +
        `two triangles were found after repair. Repair or regenerate the body before computing ${operationLabel}.`,
    )
  }

  return {
    positions: clean.positions,
    indices: clean.indices,
    bounds: clean.bounds,
    ...(clean.faceIds ? { faceIds: clean.faceIds } : {}),
    source: 'model',
  }
}

/**
 * Normalize every 3D solid source into the one PartMesh + pose shape consumed
 * by stock, height, preview, and worker code. Imported files keep the existing
 * byte-cache/tessellation path; callers pass that acquired mesh here.
 *
 * WO-1954: Parallel 3D reads a modeled body through this same adapter, so
 * `operationLabel` names the operation in every refusal (default Adaptive 3D).
 */
export function resolveAdaptive3dPartSource(
  geo: ImportedGeometry,
  placementRecords: readonly ModelItemPlacementRecord[],
  importedMesh?: PartMesh,
  operationLabel = 'Adaptive 3D',
): ResolvedAdaptive3dPartSource {
  if (geo.format === 'stl' || geo.format === 'step') {
    if (!importedMesh) {
      throw new Adaptive3dPartSourceError(
        `Imported ${geo.format.toUpperCase()} solid "${geo.name}" has no acquired mesh. ` +
          `Re-import the part before computing ${operationLabel}.`,
      )
    }
    return {
      partMesh: geo.format === 'stl' ? recenterStlForDisplay(importedMesh) : importedMesh,
      position: geo.position,
      rotation: geo.rotation,
    }
  }

  if (isModelOriginGeometry(geo)) {
    const bodyId = geo.modelBody?.ref.bodyId
    if (!bodyId) {
      throw new Adaptive3dPartSourceError(
        `Modeled solid "${geo.name}" has no body identity. Re-sync it in the Model ` +
        `workspace before computing ${operationLabel}.`,
      )
    }
    // Validate the actual machining solid before resolving its pose. A row
    // missing both display and placement should tell the user to regenerate
    // the missing geometry first, not obscure that root defect behind the
    // secondary placement refusal.
    const partMesh = modeledPartMesh(geo, operationLabel)
    const itemId = resolveOwningModelItemId(geo)!
    let frame: { position: Vec3; rotation: Vec3 }
    try {
      frame = resolveModelReferenceFrame(placementRecords, itemId, bodyId)
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      throw new Adaptive3dPartSourceError(
        `Modeled solid "${geo.name}" could not resolve its world placement (${reason}). ` +
          `Re-sync it in the Model workspace before computing ${operationLabel}.`,
      )
    }
    return { partMesh, position: frame.position, rotation: frame.rotation }
  }

  throw new Adaptive3dPartSourceError(
    `${operationLabel} needs an STL, STEP, or LienCAM modeled solid, but "${geo.name}" is ${geo.format}.`,
  )
}

/**
 * WO-3196: the part as a second side holds it. Every 3D strategy machines the
 * mesh it is handed from the top down, so a flipped setup must hand it the part
 * turned over, or it re-cuts the first side's top. The pose is kept (moves are
 * still world-placed by `position` + rotation about Z); only the display-local
 * vertices change, so that the placed mesh lands where the turned part sits in
 * the same block. A half turn keeps triangle winding and face ids as they are.
 * No turn (a first side) returns the source untouched.
 */
export function partSourceAsSetupHoldsIt(
  source: ResolvedAdaptive3dPartSource,
  turn: SecondSideTurn | null,
): ResolvedAdaptive3dPartSource {
  if (!turn) return source
  const { partMesh, position } = source
  const rad = (source.rotation.z * Math.PI) / 180
  const c = Math.cos(rad)
  const s = Math.sin(rad)
  const from = partMesh.positions
  const positions = new Float32Array(from.length)
  const min: [number, number, number] = [Infinity, Infinity, Infinity]
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < from.length; i += 3) {
    const world = turnWorldPointForSecondSide({
      x: from[i] * c - from[i + 1] * s + position.x,
      y: from[i] * s + from[i + 1] * c + position.y,
      z: from[i + 2] + position.z,
    }, turn)
    const dx = world.x - position.x
    const dy = world.y - position.y
    positions[i] = dx * c + dy * s
    positions[i + 1] = -dx * s + dy * c
    positions[i + 2] = world.z - position.z
    for (let axis = 0; axis < 3; axis++) {
      const value = positions[i + axis]
      if (value < min[axis]) min[axis] = value
      if (value > max[axis]) max[axis] = value
    }
  }
  return {
    ...source,
    partMesh: { ...partMesh, positions, indices: partMesh.indices.slice(), bounds: { min, max } },
  }
}
