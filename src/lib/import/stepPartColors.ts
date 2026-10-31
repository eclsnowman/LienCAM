import { BufferAttribute, BufferGeometry, Color, Vector3 } from 'three'
import { MeshBVH } from 'three-mesh-bvh'
import type { GeomClient } from '../../geom'
import type { BrepModelPayload } from '../cam/geometry/occt/model/types'
import type { ImportedGeometry } from '../../types'
import { rgb01ToHex } from './stepAttributes'
import { readStepPresentationColors } from './stepPresentationColors'

// Stored with the geometry row, not the disposable display cache: file open,
// cache misses, undo, duplication and render-quality changes keep appearance.
declare module '../../types' {
  interface ImportedGeometry {
    stepFaceColors?: string[]
  }
}

/** The two OCCT readers have independent face traversal orders. Match geometry
 * in native coordinates, never zip XCAF leaf order with STEPControl face order.
 * Only mixed-colour assemblies need this second shared-reader import/tessellation;
 * single-colour/no-colour files retain WO-3046's names-only fast path. */
export async function readStepFaceColors(
  service: GeomClient, bytes: ArrayBuffer, importId: string,
  mesh: BrepModelPayload['mesh'],
): Promise<string[]> {
  const embedded = readStepPresentationColors(bytes)
  const { bodies, diagnostics } = await service.importStep(bytes, importId)
  const trees: Array<{ geometry: BufferGeometry; tree: MeshBVH; color: string }> = []
  try {
    if (!bodies.length || diagnostics.some(d => d.severity !== 'info')) {
      throw new Error('Could not read STEP part surfaces for embedded colours')
    }
    for (const body of bodies) {
      const tess = await service.tessellate(body.handle, { deflection: 0.05, angularDeflection: 0.2 })
      const geometry = new BufferGeometry()
      geometry.setAttribute('position', new BufferAttribute(tess.position, 3))
      geometry.setIndex(new BufferAttribute(tess.index, 1))
      const rgb = body.color ?? embedded.get(body.name ?? '')
      trees.push({ geometry, tree: new MeshBVH(geometry), color: rgb ? rgb01ToHex(rgb) : '#8ab4cc' })
    }
    const point = new Vector3()
    const a = new Vector3(), b = new Vector3(), c = new Vector3()
    const normal = new Vector3(), ab = new Vector3(), ac = new Vector3()
    const sa = new Vector3(), sb = new Vector3(), sc = new Vector3(), sourceNormal = new Vector3()
    const colors: string[] = []
    for (let face = 0; face < mesh.faceRanges.length / 2; face++) {
      const start = mesh.faceRanges[2 * face], count = mesh.faceRanges[2 * face + 1]
      // Sample triangle interiors (not shared boundary vertices). Summed squared
      // surface distance over the face distinguishes touching and nested parts.
      const scores = trees.map(() => 0)
      const stride = Math.max(1, Math.ceil(count / 3 / 16)) * 3
      for (let i = start; i < start + count; i += stride) {
        a.fromArray(mesh.positions, mesh.indices[i] * 3)
        b.fromArray(mesh.positions, mesh.indices[i + 1] * 3)
        c.fromArray(mesh.positions, mesh.indices[i + 2] * 3)
        point.copy(a).add(b).add(c).multiplyScalar(1 / 3)
        normal.crossVectors(ab.subVectors(b, a), ac.subVectors(c, a)).normalize()
        trees.forEach(({ tree, geometry }, j) => {
          const hit = tree.closestPointToPoint(point)
          if (!hit) { scores[j] = Infinity; return }
          const index = geometry.index!, position = geometry.getAttribute('position')
          sa.fromBufferAttribute(position, index.getX(hit.faceIndex * 3))
          sb.fromBufferAttribute(position, index.getX(hit.faceIndex * 3 + 1))
          sc.fromBufferAttribute(position, index.getX(hit.faceIndex * 3 + 2))
          sourceNormal.crossVectors(ab.subVectors(sb, sa), ac.subVectors(sc, sa)).normalize()
          // Opposing contact faces occupy the SAME plane. Distance alone assigns
          // both to whichever part came first; outward winding disambiguates.
          scores[j] += hit.distance ** 2 + (normal.dot(sourceNormal) < 0 ? 1e6 : 0)
        })
      }
      const best = scores.indexOf(Math.min(...scores))
      colors.push(trees[best].color)
    }
    return colors
  } finally {
    for (const { geometry } of trees) geometry.dispose()
    for (const body of bodies) await service.dispose(body.handle)
  }
}

/** Face blocks have disjoint vertices in the CAM payload. Colours are sRGB in
 * STEP/UI and linear in Three's vertex attribute; white material avoids tinting. */
export function stepVertexColors(mesh: BrepModelPayload['mesh'], geo?: Pick<ImportedGeometry, 'stepFaceColors'>): Float32Array | undefined {
  const faces = geo?.stepFaceColors
  if (!faces || faces.length !== mesh.faceRanges.length / 2) return undefined
  const colors = new Float32Array(mesh.positions.length)
  const color = new Color()
  for (let f = 0; f < faces.length; f++) {
    color.set(faces[f])
    const start = mesh.faceRanges[2 * f], count = mesh.faceRanges[2 * f + 1]
    for (let i = start; i < start + count; i++) color.toArray(colors, mesh.indices[i] * 3)
  }
  return colors
}
