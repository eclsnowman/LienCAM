import type { ImportedGeometry, ModelItemPlacementRecord, Vec3 } from '../../types'
import type { PartMesh } from '../kernel/types'
import { sanitizeTriangleMesh } from '../input/sanitize'
import { isModelOriginGeometry, resolveOwningModelItemId } from '../../lib/cam/modelOrigin'
import { resolveModelReferenceFrame } from '../../lib/cam/modelReferenceFrame'

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
