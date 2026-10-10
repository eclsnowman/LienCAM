import type { HeightmapSimulator } from './HeightmapSimulator'
import type { VoxelSimulator } from './VoxelSimulator'
import { saveFile } from '../saveFile'

type Point = [number, number, number]
type TriangleSink = (a: Point, b: Point, c: Point) => void

// A consistent six-tetrahedra split shares face diagonals across every cube.
// Negative padding closes the stock's exterior as well as internal cut surfaces.
const CORNERS: Point[] = [[0,0,0], [1,0,0], [1,1,0], [0,1,0], [0,0,1], [1,0,1], [1,1,1], [0,1,1]]
const TETS = [[0,1,2,6], [0,2,3,6], [0,3,7,6], [0,7,4,6], [0,4,5,6], [0,5,1,6]]

/** Binary STL in world-space millimetres, at the active simulation resolution.
 * No replay, target model or viewport display mesh is substituted for live stock. */
export function stockStl(sim: HeightmapSimulator | VoxelSimulator): ArrayBuffer {
  const voxel = 'field' in sim ? sim.field : null
  const hm = 'heights' in sim ? sim : null
  const size = voxel?.dims.voxelSize ?? hm!.cellSize
  const nx = voxel?.dims.nx ?? hm!.nx
  const ny = voxel?.dims.ny ?? hm!.ny
  const nz = voxel?.dims.nz ?? Math.max(1, Math.ceil((hm!.stockTop - hm!.stockBot) / size))
  const dz = voxel ? size : (hm!.stockTop - hm!.stockBot) / nz
  const origin: Point = voxel ? [voxel.dims.x0, voxel.dims.y0, voxel.dims.z0] : [hm!.x0, hm!.y0, hm!.stockBot]
  const sample = (x: number, y: number, z: number): number => {
    if (z < 0 || z >= nz) return -dz / 2
    if (x < 0 || y < 0 || x >= nx || y >= ny) return -size / 2
    const value = voxel ? voxel.get(x, y, z) : Math.min(size / 2, hm!.heights[y * nx + x] - (origin[2] + (z + 0.5) * dz))
    // A tiny common iso-level offset avoids collapsed triangles at exact zero
    // samples (including cuts aligned with a voxel centre).
    return value - Math.min(size, dz) * 0.0001
  }
  const walk = (emit: TriangleSink) => {
    for (let z = -1; z < nz; z++) for (let y = -1; y < ny; y++) for (let x = -1; x < nx; x++) {
      const values = CORNERS.map(c => sample(x + c[0], y + c[1], z + c[2]))
      if (values.every(v => v <= 0) || values.every(v => v > 0)) continue
      const points = CORNERS.map(c => [origin[0] + (x + c[0] + 0.5) * size, origin[1] + (y + c[1] + 0.5) * size, origin[2] + (z + c[2] + 0.5) * dz] as Point)
      const crossing = (i: number, j: number): Point => {
        // Canonical endpoint order gives identical float32 vertices on shared
        // edges, independent of the neighbouring tetrahedron's winding.
        const axis = points[i].findIndex((v, a) => v !== points[j][a])
        if (points[i][axis] > points[j][axis]) [i, j] = [j, i]
        const t = values[i] / (values[i] - values[j])
        return points[i].map((v, axis) => Math.fround(v + t * (points[j][axis] - v))) as Point
      }
      for (const tet of TETS) {
        const inside = tet.filter(i => values[i] > 0)
        const outside = tet.filter(i => values[i] <= 0)
        if (!inside.length || !outside.length) continue
        const outward = points[outside[0]].map((v, axis) => v - points[inside[0]][axis])
        const triangle = (a: Point, b: Point, c: Point) => {
          const normal = cross(a, b, c)
          if (normal.some(v => v !== 0)) {
            if (normal.reduce((sum, v, axis) => sum + v * outward[axis], 0) < 0) emit(a, c, b)
            else emit(a, b, c)
          }
        }
        if (inside.length === 2) {
          const a = crossing(inside[0], outside[0]), b = crossing(inside[0], outside[1])
          const c = crossing(inside[1], outside[1]), d = crossing(inside[1], outside[0])
          triangle(a, b, c); triangle(a, c, d)
        } else {
          const lone = inside.length === 1 ? inside[0] : outside[0]
          const others = inside.length === 1 ? outside : inside
          triangle(crossing(lone, others[0]), crossing(lone, others[1]), crossing(lone, others[2]))
        }
      }
    }
  }
  // Count first to allocate only the final bytes, rather than millions of
  // temporary triangle objects for a large stock.
  let count = 0
  walk(() => { count++ })
  const buffer = new ArrayBuffer(84 + count * 50)
  const view = new DataView(buffer)
  new Uint8Array(buffer, 0, 80).set(new TextEncoder().encode('LienCAM simulated stock; coordinates in mm'))
  view.setUint32(80, count, true)
  let offset = 84
  walk((a, b, c) => {
    const n = cross(a, b, c)
    const length = Math.hypot(...n)
    for (const value of [...n.map(v => v / length), ...a, ...b, ...c]) {
      view.setFloat32(offset, value, true); offset += 4
    }
    view.setUint16(offset, 0, true); offset += 2
  })
  return buffer
}

function cross(a: Point, b: Point, c: Point): Point {
  const u = b.map((v, i) => v - a[i]), v = c.map((v, i) => v - a[i])
  return [u[1]*v[2]-u[2]*v[1], u[2]*v[0]-u[0]*v[2], u[0]*v[1]-u[1]*v[0]]
}

export function exportStockStl(sim: HeightmapSimulator | VoxelSimulator): Promise<string | null> {
  return saveFile('simulation-stock.stl', new Blob([stockStl(sim)], { type: 'model/stl' }), 'model/stl')
}
