import { BufferGeometry, Float32BufferAttribute, DoubleSide, Ray, Vector3 } from 'three'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { MeshBVH } from 'three-mesh-bvh'
import type { ImportedGeometry, Project } from '../../types'
import { LEGACY_MODEL_ITEM_ID } from '../../doc/documentHolder'
import { effectiveStockIdForCompute } from '../../store/stockAssignment'
import { partWorldTransform } from '../../store/partTransform'
import { resolveModelReferenceFrame } from '../cam/modelReferenceFrame'
import { frameRef, mapPoint, pointMm, rigidMapFromPose, type FrameRef } from '../geometry/coordinateFrames'
import { loadCachedSTL } from '../stlCache'
import { computeStepSha256, loadCachedStep, loadCachedStepDisplay, STEP_DISPLAY_CONTRACT_VERSION } from '../stepCache'
import { loadCachedModelBodyDisplay } from '../modelBodyDisplayCache'
import type { TargetSurface } from './deviationComparison'

/** Same centering convention as CNCViewport.addSTL. Import/cache coordinates
 * are already mm; STEP importer converts source units before caching display. */
export function centerStlForDeviation(mesh: BufferGeometry): void {
  mesh.computeBoundingBox()
  const box = mesh.boundingBox!
  mesh.translate(-(box.min.x + box.max.x) / 2, -(box.min.y + box.max.y) / 2, -box.min.z)
}
export function placeDeviationMesh(mesh: BufferGeometry, geo: ImportedGeometry, project: Project, world: FrameRef<'world'>): void {
  const pose = geo.format === 'model' && geo.modelBody
    ? resolveModelReferenceFrame(project.modelItemPlacements ?? [], geo.modelItemId ?? LEGACY_MODEL_ITEM_ID, geo.modelBody.ref.bodyId)
    : partWorldTransform(geo, project.stocks ?? [])
  const native = frameRef({ kind: 'geometry-native', projectEpoch: world.projectEpoch,
    entityId: geo.id, revision: JSON.stringify([geo.modelBody?.ref, pose]) })
  const map = rigidMapFromPose(native, world, pose)
  const positions = mesh.getAttribute('position')
  for (let i = 0; i < positions.count; i++) {
    const p = mapPoint(map, pointMm(native, { x: positions.getX(i), y: positions.getY(i), z: positions.getZ(i) })).value
    positions.setXYZ(i, p.x, p.y, p.z)
  }
}
export function triangleTarget(meshes: readonly BufferGeometry[], frame: FrameRef<'world'>): TargetSurface & { dispose(): void; estimatedBytes: number } {
  const trees = meshes.map(mesh => {
    mesh.computeBoundingBox()
    return { tree: new MeshBVH(mesh, { indirect: true }), top: mesh.boundingBox!.max.z,
      bottom: mesh.boundingBox!.min.z }
  })
  const ray = new Ray(new Vector3(), new Vector3(0, 0, -1))
  return {
    frame, estimatedBytes: meshes.reduce((sum, mesh) => sum + mesh.getAttribute('position').array.byteLength * 3, 0),
    topAt(x, y) {
      let top: number | null = null
      for (const { tree, top: z, bottom } of trees) {
        ray.origin.set(x, y, z + 1)
        const hit = tree.raycastFirst(ray, DoubleSide, 0, z - bottom + 2)
        if (hit && (top === null || hit.point.z > top)) top = hit.point.z
      }
      return top
    },
    dispose() { for (const mesh of meshes) mesh.dispose() },
  }
}

/** Load actual intended geometry, never bounding-box substitute solids. A
 * missing member prevents comparison: ignoring it would invent empty space.
 * Nest placements / planar-only geometry need another representation. */
export async function loadDeviationTarget(project: Project, stockId: string, world: FrameRef<'world'>, signal: AbortSignal) {
  const members = project.geometry.filter(geo => !geo.workholding &&
    effectiveStockIdForCompute(geo, project.nests ?? [], project.stocks ?? []) === stockId)
  if (!members.length) throw new Error('No intended solid geometry belongs to this stock.')
  const meshes: BufferGeometry[] = []
  let triangles = 0
  try {
    for (const geo of members) {
      signal.throwIfAborted()
      if (geo.ownerNestId) throw new Error('Nested intended geometry comparison is not available yet.')
      let mesh: BufferGeometry
      if (geo.format === 'stl') {
        const buffer = await loadCachedSTL(geo.id)
        signal.throwIfAborted()
        if (!buffer || buffer.byteLength > 32 * 1024 * 1024) throw new Error(`Intended mesh '${geo.name}' is missing or exceeds 32 MiB.`)
        mesh = new STLLoader().parse(buffer)
        centerStlForDeviation(mesh)
      } else {
        let display: { positions: ArrayLike<number>; indices: ArrayLike<number> } | undefined
        if (geo.format === 'model' && geo.modelBody) {
          display = geo.modelBody.display ?? (await loadCachedModelBodyDisplay({ projectId: project.id,
            geometryId: geo.id, bodyId: geo.modelBody.ref.bodyId, version: geo.modelBody.ref.version })) ?? undefined
        } else if (geo.format === 'step') {
          const [raw, cached] = await Promise.all([loadCachedStep(geo.id), loadCachedStepDisplay(geo.id)])
          if (raw && cached?.displayContractVersion === STEP_DISPLAY_CONTRACT_VERSION &&
              cached.sourceSha256 === await computeStepSha256(raw)) display = cached.payload.mesh
        }
        signal.throwIfAborted()
        if (!display) throw new Error(`Intended solid '${geo.name}' has no current triangle surface.`)
        if (display.positions.length > 900_000 || display.indices.length > 300_000) throw new Error('Intended surface exceeds 100,000 triangles.')
        mesh = new BufferGeometry()
        mesh.setAttribute('position', new Float32BufferAttribute(Array.from(display.positions), 3))
        mesh.setIndex(Array.from(display.indices))
      }
      meshes.push(mesh)
      triangles += (mesh.index?.count ?? mesh.getAttribute('position').count) / 3
      if (triangles > 100_000) throw new Error('Intended surface exceeds 100,000 triangles.')
      placeDeviationMesh(mesh, geo, project, world)
      await new Promise<void>(resolve => setTimeout(resolve, 0))
    }
    signal.throwIfAborted()
    return triangleTarget(meshes, world)
  } catch (error) { for (const mesh of meshes) mesh.dispose(); throw error }
}
