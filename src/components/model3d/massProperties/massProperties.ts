// WO UI-4 acceptance #6 (BK-49 rider): mass + center-of-mass from a
// per-body material assignment. src/geom/** is frozen/read-only for this WO
// (architect ruling 1); the underlying occt-wasm kernel DOES have a
// getCenterOfMass() primitive (node_modules/occt-wasm/dist/index.d.ts) but
// geom-engine.ts never wires it into measure() -- confirmed gap, filed in
// this WO's report interfaceConcerns, same "Stage-2 resolver work" class as
// distance/radius/angle.
//
// Mass is NEVER mesh-derived: mass = density * volume, and volume always
// comes from the kernel's own exact measure('volume') (whole-body, analytic)
// -- so mass is exact regardless of how curved the body is.
//
// Center of mass has no kernel path today, so it is computed here from the
// tessellated mesh via the standard signed-tetrahedra decomposition
// (divergence theorem: for a closed, consistently-wound triangle mesh, sum
// each triangle's origin-tetrahedron, which needs no explicit closedness
// check -- an open mesh just silently gives a nonsense answer, but every
// body this bridge tessellates is a closed B-rep solid by construction).
// This is EXACT for a flat-faced (polyhedral) body -- its tessellation IS
// its true geometry, no curve deflection error -- and bounded by the
// tessellation deflection for a curved one. Every CoM readout says which
// case it is.

import * as THREE from 'three'
import type { CachedBody } from '../../../viewport3d'

export interface Vec3Plain {
  x: number
  y: number
  z: number
}

export interface MeshVolumeCentroid {
  volume: number
  centroid: Vec3Plain
}

const A = new THREE.Vector3()
const B = new THREE.Vector3()
const C = new THREE.Vector3()

/** Signed-tetrahedra decomposition of a closed triangle mesh: volume and
 *  volume-centroid, both independent of the coordinate origin chosen (the
 *  origin choice affects each per-triangle term but cancels in the sum for
 *  a closed mesh). Used ONLY as the CoM fallback (see header) -- body volume
 *  itself should always come from the kernel's exact measure('volume'). */
export function meshVolumeCentroid(body: CachedBody): MeshVolumeCentroid {
  const index = body.geometry.getIndex()
  const position = body.geometry.getAttribute('position')
  if (index === null || position === undefined) return { volume: 0, centroid: { x: 0, y: 0, z: 0 } }

  let volume6 = 0
  let cx = 0
  let cy = 0
  let cz = 0
  const triCount = index.count / 3
  for (let t = 0; t < triCount; t++) {
    const i0 = index.getX(t * 3)
    const i1 = index.getX(t * 3 + 1)
    const i2 = index.getX(t * 3 + 2)
    A.fromBufferAttribute(position, i0)
    B.fromBufferAttribute(position, i1)
    C.fromBufferAttribute(position, i2)
    // 6x signed volume of the tetrahedron (origin, A, B, C).
    const v6 = A.dot(B.clone().cross(C))
    volume6 += v6
    // Centroid of that tetrahedron is (origin+A+B+C)/4 = (A+B+C)/4 (origin
    // is the zero vector here); weight by this tet's signed volume.
    cx += v6 * (A.x + B.x + C.x)
    cy += v6 * (A.y + B.y + C.y)
    cz += v6 * (A.z + B.z + C.z)
  }
  const volume = volume6 / 6
  if (Math.abs(volume6) < 1e-12) return { volume, centroid: { x: 0, y: 0, z: 0 } }
  return {
    volume,
    centroid: { x: cx / (4 * volume6), y: cy / (4 * volume6), z: cz / (4 * volume6) },
  }
}

/** g/cm^3 -> g/mm^3 -- this app's model units are mm throughout
 *  (geom-service.ts's MeasureResult doc: "model units (mm)"). */
export function densityGPerMm3(densityGPerCm3: number): number {
  return densityGPerCm3 / 1000
}

export function computeMassGrams(volumeMm3: number, densityGPerCm3: number): number {
  return volumeMm3 * densityGPerMm3(densityGPerCm3)
}

export interface MassProperties {
  massGrams: number
  volumeMm3: number
  densityGPerCm3: number
  centerOfMass: Vec3Plain
  /** true when the body's tessellation has curved faces, so the mesh-
   *  derived center of mass is bounded by tessellation deflection rather
   *  than exact (see header -- a flat-faced/polyhedral body's tessellation
   *  IS its true geometry, so this is false for e.g. a box). Callers should
   *  label the CoM readout accordingly. */
  centerOfMassApprox: boolean
}

/** `exactVolumeMm3` MUST come from the kernel's measure('volume') -- never
 *  from meshVolumeCentroid's own volume field, which exists only as a
 *  byproduct of the centroid sum (see header: mass is never mesh-derived).
 *  `hasCurvedFaces` is a caller-supplied classification (e.g. any
 *  GeometrySnapshot in this body's snapshot map with surfaceType other than
 *  'plane') -- this module doesn't own snapshot lookup, keeping it testable
 *  against a bare CachedBody. */
export function computeMassProperties(
  body: CachedBody,
  exactVolumeMm3: number,
  densityGPerCm3: number,
  hasCurvedFaces: boolean,
): MassProperties {
  const { centroid } = meshVolumeCentroid(body)
  return {
    massGrams: computeMassGrams(exactVolumeMm3, densityGPerCm3),
    volumeMm3: exactVolumeMm3,
    densityGPerCm3,
    centerOfMass: centroid,
    centerOfMassApprox: hasCurvedFaces,
  }
}
