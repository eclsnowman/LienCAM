// WO-1969: sample the part's top surface under an Engrave's paths.
//
// Runs in the store (main thread), never in the toolpath worker: it owns the
// 3D kernel. The result is the plain height grid surfaceFollow.ts rides.
//
// Sample spacing. A grid is only as good as what it interpolates between its
// nodes, so the spacing is not guessed from the tolerance - it is MEASURED:
// the surface is dropped at spacing h and at h/2, and every h/2 node that the
// h-grid does not hold (cell centres and edge midpoints) is compared with what
// the h-grid interpolates there. When the worst gap is within the operation's
// tolerance the h/2 grid is kept (bilinear error shrinks with h squared, so it
// sits well inside the tolerance); otherwise h halves and the check repeats,
// down to MIN_SPACING_MM or MAX_SAMPLES nodes.

import { BvhKernel } from '../../../cam3d/kernel/bvhKernel'
import type { GridSpec, PartMesh } from '../../../cam3d/kernel/types'
import { surfaceHeightAt, type EngraveSurfaceField } from './surfaceFollow'

/** A solid's triangles in the moves' world frame. */
export interface EngraveSurfaceMesh {
  positions: ArrayLike<number>
  indices: ArrayLike<number>
}

export interface EngraveSurfaceRegion {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export interface EngraveSurfaceSampling {
  field: EngraveSurfaceField
  /** Lowest and highest surface node under the region, world Z. */
  minZ: number
  maxZ: number
  /** The spacing that passed the tolerance check, mm. */
  spacingMm: number
  /** Worst measured gap between the kept grid's parent and the true surface, mm. */
  measuredErrorMm: number
  /** False when MIN_SPACING_MM or MAX_SAMPLES stopped the refinement first. */
  withinTolerance: boolean
}

export const START_SPACING_MM = 1
export const MIN_SPACING_MM = 0.05
export const MAX_SAMPLES = 2_000_000
/** A probe this thin reads the surface under a point, not a cutter's envelope. */
const PROBE_DIAMETER_MM = 0.002

function mergedPartMesh(meshes: readonly EngraveSurfaceMesh[]): PartMesh {
  let vertexCount = 0
  let indexCount = 0
  for (const mesh of meshes) {
    vertexCount += mesh.positions.length / 3
    indexCount += mesh.indices.length
  }
  const positions = new Float32Array(vertexCount * 3)
  const indices = new Uint32Array(indexCount)
  const min: [number, number, number] = [Infinity, Infinity, Infinity]
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  let vBase = 0
  let iAt = 0
  for (const mesh of meshes) {
    for (let i = 0; i < mesh.positions.length; i++) {
      const v = mesh.positions[i]
      positions[vBase * 3 + i] = v
      const axis = i % 3
      if (v < min[axis]) min[axis] = v
      if (v > max[axis]) max[axis] = v
    }
    for (let i = 0; i < mesh.indices.length; i++) indices[iAt++] = mesh.indices[i] + vBase
    vBase += mesh.positions.length / 3
  }
  return { positions, indices, bounds: { min, max }, source: 'model' }
}

interface Grid {
  x0: number
  y0: number
  nx: number
  ny: number
  h: number
  z: Float64Array
}

async function dropGridAt(
  kernel: BvhKernel,
  mesh: ReturnType<BvhKernel['uploadMesh']>,
  cutter: ReturnType<BvhKernel['makeCutter']>,
  region: EngraveSurfaceRegion,
  h: number,
  floor: number,
): Promise<Grid> {
  const nx = Math.max(2, Math.ceil((region.maxX - region.minX) / h - 1e-9) + 1)
  const ny = Math.max(2, Math.ceil((region.maxY - region.minY) / h - 1e-9) + 1)
  const spec: GridSpec = { x0: region.minX, y0: region.minY, nx, ny, dx: h, dy: h, zSeed: floor }
  const raw = await kernel.dropGrid(mesh, cutter, spec)
  const z = new Float64Array(raw.length)
  // The kernel returns the floor where nothing lies under the probe: that node
  // is off the part.
  for (let i = 0; i < raw.length; i++) z[i] = raw[i] <= floor + 1e-9 ? NaN : raw[i]
  return { x0: region.minX, y0: region.minY, nx, ny, h, z }
}

function asField(grid: Grid, rest: Omit<EngraveSurfaceField, 'x0' | 'y0' | 'dx' | 'dy' | 'nx' | 'ny' | 'z' | 'maxZ'>): EngraveSurfaceField {
  let maxZ = -Infinity
  for (const z of grid.z) if (Number.isFinite(z) && z > maxZ) maxZ = z
  return {
    x0: grid.x0, y0: grid.y0, dx: grid.h, dy: grid.h, nx: grid.nx, ny: grid.ny,
    z: grid.z, maxZ, ...rest,
  }
}

/** Worst gap between what `coarse` interpolates and the fine grid's nodes it
 *  does not itself hold. Nodes with no surface on either side are skipped. */
function interpolationGap(coarse: EngraveSurfaceField, fine: Grid): number {
  let worst = 0
  for (let iy = 0; iy < fine.ny; iy++) {
    for (let ix = 0; ix < fine.nx; ix++) {
      if (ix % 2 === 0 && iy % 2 === 0) continue
      const truth = fine.z[iy * fine.nx + ix]
      if (!Number.isFinite(truth)) continue
      const guess = surfaceHeightAt(coarse, fine.x0 + ix * fine.h, fine.y0 + iy * fine.h)
      if (!Number.isFinite(guess)) continue
      worst = Math.max(worst, Math.abs(guess - truth))
    }
  }
  return worst
}

/**
 * The part's top surface over `region`, sampled finely enough that the
 * interpolated height stays within `toleranceMm` of the real one. Throws when
 * no part lies under the region at all - there is no surface to follow.
 */
export async function sampleEngraveSurface(input: {
  meshes: readonly EngraveSurfaceMesh[]
  region: EngraveSurfaceRegion
  toleranceMm: number
  depthMm: number
  axialOffsetMm: number
}): Promise<EngraveSurfaceSampling> {
  const meshes = input.meshes.filter(mesh => mesh.positions.length >= 9 && mesh.indices.length >= 3)
  if (meshes.length === 0) throw new Error('There is no solid part to follow under the engraved paths.')
  const tol = input.toleranceMm > 0 ? input.toleranceMm : 0.01
  const part = mergedPartMesh(meshes)
  const floor = part.bounds.min[2] - 1
  const kernel = new BvhKernel()
  const mesh = kernel.uploadMesh(part)
  const cutter = kernel.makeCutter({ kind: 'flat', diameter: PROBE_DIAMETER_MM })
  try {
    const width = Math.max(input.region.maxX - input.region.minX, input.region.maxY - input.region.minY)
    let h = Math.min(START_SPACING_MM, Math.max(width / 4, MIN_SPACING_MM))
    const fieldRest = { depthMm: input.depthMm, axialOffsetMm: input.axialOffsetMm, toleranceMm: tol }
    let coarse = await dropGridAt(kernel, mesh, cutter, input.region, h, floor)
    for (;;) {
      const halfRegion = {
        ...input.region,
        maxX: input.region.minX + (coarse.nx - 1) * h,
        maxY: input.region.minY + (coarse.ny - 1) * h,
      }
      const fine = await dropGridAt(kernel, mesh, cutter, halfRegion, h / 2, floor)
      const gap = interpolationGap(asField(coarse, fieldRest), fine)
      const next = fine.nx * fine.ny * 4
      const stop = gap <= tol || h / 2 < MIN_SPACING_MM * 2 - 1e-12 || next > MAX_SAMPLES
      if (stop) {
        const field = asField(fine, fieldRest)
        let minZ = Infinity
        for (const z of fine.z) if (Number.isFinite(z) && z < minZ) minZ = z
        if (!Number.isFinite(minZ)) {
          throw new Error('No part lies under the engraved paths, so there is no surface to follow.')
        }
        return {
          field, minZ, maxZ: field.maxZ, spacingMm: fine.h,
          measuredErrorMm: gap, withinTolerance: gap <= tol,
        }
      }
      h /= 2
      coarse = fine
    }
  } finally {
    kernel.releaseCutter(cutter)
    kernel.releaseMesh(mesh)
  }
}
