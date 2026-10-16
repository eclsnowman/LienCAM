import type { TessBuffers } from '../../../geom/geom-service'
import { GeometryCache, type PreparedCachedBody } from '../../../viewport3d/GeometryCache'

/** All Model-screen cache routes, including reconstructed edit owners and
 * previews, use the kernel's explicit seam classification. A free boundary
 * is regular even when it has only one adjacent face; never infer from IDs. */
export class ModelGeometryCache extends GeometryCache {
  override prepare(bodyId: string, buffers: TessBuffers): PreparedCachedBody {
    if (!buffers.edgeClasses?.includes('seam')) return super.prepare(bodyId, buffers)
    const edgeIds: string[] = []
    const edgeOffsets = [0]
    const points: number[] = []
    buffers.edgeIds.forEach((id, i) => {
      if (buffers.edgeClasses?.[i] === 'seam') return
      edgeIds.push(id)
      for (let p = buffers.edgeOffsets[i] * 3; p < buffers.edgeOffsets[i + 1] * 3; p++) points.push(buffers.edgePositions[p])
      edgeOffsets.push(points.length / 3)
    })
    return super.prepare(bodyId, {
      ...buffers, edgeIds, edgeOffsets: new Uint32Array(edgeOffsets),
      edgePositions: new Float32Array(points), edgeClasses: edgeIds.map(() => 'regular'),
    })
  }
}
