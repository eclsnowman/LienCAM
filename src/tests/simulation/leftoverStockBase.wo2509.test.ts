// WO-2509: stock left below the deepest cut draws as a solid in Simulate.
//
// Example 06 carves a knob from the top of a raised blank and leaves a ~15 mm
// base under it. The heightmap engine's surface (the one WO-2445's capture drew,
// verification.json engine "heightmap") meshed only the top surface and the
// walls BETWEEN cells, so its outer rim was open: the base drew as a flat sheet
// floating 15 mm above the vise. These tests drive the production viewport
// methods (initStockSim + updateStockSimHeights) with a HeightmapSimulator
// carved like the knob, and measure the geometry the viewport hands to Three.

import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { CNCViewport } from '../../lib/viewport/CNCViewport'
import { HeightmapSimulator } from '../../lib/simulation/HeightmapSimulator'
import { VoxelSimulator } from '../../lib/simulation/VoxelSimulator'

interface SimViewport {
  initStockSim: CNCViewport['initStockSim']
  updateStockSimHeights: CNCViewport['updateStockSimHeights']
  stockSimGeometry: THREE.BufferGeometry | null
}

// Stock 40 x 40 x 30 mm, bottom at Z 0. Same minimal harness as SIM-6.
const STOCK = { x0: 0, y0: 0, x1: 40, y1: 40, zBot: 0, zTop: 30 }
const CELL = 0.5

function makeViewport(): SimViewport {
  const viewport = Object.create(CNCViewport.prototype)
  const scene = new THREE.Scene()
  const stockGroup = new THREE.Group()
  scene.add(stockGroup)
  Object.assign(viewport, {
    scene,
    stockGroup,
    fixedStockBoxes: new Map<string, THREE.Group>(),
    _stockBounds: {
      min: new THREE.Vector3(STOCK.x0, STOCK.y0, STOCK.zBot),
      max: new THREE.Vector3(STOCK.x1, STOCK.y1, STOCK.zTop),
    },
    carvedStockGroups: new Map<string, THREE.Group>(),
    stockSimGroup: null,
    stockSimGeometry: null,
    stockSimNx: 0,
    stockSimNy: 0,
    stockSimLayout: null,
    stockSimThreshold: 0,
    stockSimTopVertCount: 0,
    voxelSimGroup: null,
    voxelSimTexture: null,
    voxelSimMaterial: null,
    voxelSimMesh: null,
  })
  return viewport as SimViewport
}

/** Simulate the end of a job on the viewport's own grid and return the drawn geometry. */
function simulateToEnd(carve: (sim: HeightmapSimulator) => void): THREE.BufferGeometry {
  const viewport = makeViewport()
  const bounds = viewport.initStockSim(CELL)
  if (!bounds) throw new Error('initStockSim returned no bounds')
  const sim = new HeightmapSimulator(
    bounds.x0, bounds.y0,
    bounds.nx * bounds.cellSize, bounds.ny * bounds.cellSize,
    bounds.stockTop, bounds.stockBot, bounds.cellSize,
  )
  carve(sim)
  viewport.updateStockSimHeights(sim.heights)
  if (!viewport.stockSimGeometry) throw new Error('no stock-sim geometry')
  return viewport.stockSimGeometry
}

// Knob: everything outside a 10 mm-radius boss cut down to Z 15 with a 6 mm
// flat end mill, leaving a 15 mm base under the deepest cut.
const BASE_Z = 15
function carveKnob(sim: HeightmapSimulator): void {
  const cx = 20, cy = 20, bossR = 10, toolR = 3
  for (let y = -toolR; y <= 40 + toolR; y += 0.5) {
    for (let x = -toolR; x <= 40 + toolR; x += 0.5) {
      if (Math.hypot(x - cx, y - cy) >= bossR + toolR) sim.carve(x, y, BASE_Z, toolR)
    }
  }
}

// Plain blank + shallow pocket: 2 mm deep, 20 x 20 in the middle.
function carvePocket(sim: HeightmapSimulator): void {
  for (let y = 13; y <= 27; y += 0.5) sim.sweepMove(13, y, 28, 27, y, 28, 3)
}

interface Measure {
  triangles: number
  minZ: number
  /** area of triangles lying in the x = x0 plane (the -X outer side) */
  sideAreaXMin: number
  /** area of triangles lying in the y = y1 plane (the +Y outer side) */
  sideAreaYMax: number
  /** area of triangles lying in the z = stock bottom plane */
  bottomArea: number
}

function measure(geo: THREE.BufferGeometry): Measure {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute
  const index = geo.getIndex()!
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3()
  const tri = new THREE.Triangle()
  let minZ = Infinity, sideAreaXMin = 0, sideAreaYMax = 0, bottomArea = 0
  for (let i = 0; i < pos.count; i++) minZ = Math.min(minZ, pos.getZ(i))
  const near = (p: number, q: number) => Math.abs(p - q) < 1e-4
  for (let t = 0; t < index.count; t += 3) {
    a.fromBufferAttribute(pos, index.getX(t))
    b.fromBufferAttribute(pos, index.getX(t + 1))
    c.fromBufferAttribute(pos, index.getX(t + 2))
    tri.set(a, b, c)
    const area = tri.getArea()
    if (area < 1e-9) continue
    if (near(a.x, STOCK.x0) && near(b.x, STOCK.x0) && near(c.x, STOCK.x0)) sideAreaXMin += area
    if (near(a.y, STOCK.y1) && near(b.y, STOCK.y1) && near(c.y, STOCK.y1)) sideAreaYMax += area
    if (near(a.z, STOCK.zBot) && near(b.z, STOCK.zBot) && near(c.z, STOCK.zBot)) bottomArea += area
  }
  return { triangles: index.count / 3, minZ, sideAreaXMin, sideAreaYMax, bottomArea }
}

describe('WO-2509: leftover stock base draws as a solid (heightmap engine)', () => {
  it('knob on a 15 mm base: the base has its outer sides and bottom', () => {
    const m = measure(simulateToEnd(carveKnob))
    const width = STOCK.x1 - STOCK.x0
    // The drawn stock reaches the stock bottom, not the 15 mm floor of the cut.
    expect(m.minZ).toBeCloseTo(STOCK.zBot, 4)
    // Each outer side is the full base: 40 mm long x 15 mm high.
    expect(m.sideAreaXMin).toBeCloseTo(width * (BASE_Z - STOCK.zBot), 2)
    expect(m.sideAreaYMax).toBeCloseTo(width * (BASE_Z - STOCK.zBot), 2)
    // And the bottom face covers the whole footprint.
    expect(m.bottomArea).toBeCloseTo(width * (STOCK.y1 - STOCK.y0), 2)
  })

  it('plain blank + shallow pocket: the uncut rim keeps full-height sides', () => {
    const m = measure(simulateToEnd(carvePocket))
    const width = STOCK.x1 - STOCK.x0
    expect(m.minZ).toBeCloseTo(STOCK.zBot, 4)
    expect(m.sideAreaXMin).toBeCloseTo(width * (STOCK.zTop - STOCK.zBot), 2)
    expect(m.bottomArea).toBeCloseTo(width * (STOCK.y1 - STOCK.y0), 2)
  })

  it('the sides meet the carved top surface with no gap at the rim', () => {
    const geo = simulateToEnd(carveKnob)
    const pos = geo.getAttribute('position') as THREE.BufferAttribute
    // Every vertex on the -X rim above the bottom must sit at the base top (15),
    // the height the top surface draws there - the side's top edge is the surface.
    const rimTops = new Set<number>()
    for (let i = 0; i < pos.count; i++) {
      if (Math.abs(pos.getX(i) - STOCK.x0) < 1e-4 && pos.getZ(i) > STOCK.zBot + 1e-4) {
        rimTops.add(Math.round(pos.getZ(i) * 1000) / 1000)
      }
    }
    expect([...rimTops]).toEqual([BASE_Z])
  })

  it('every outer side and the bottom face outward: winding and normal agree', () => {
    // The stock material is DoubleSide, which flips the supplied normal on a
    // back face. A side wound inward would therefore light from inside the
    // solid even with an outward normal. Check both, per triangle, on all five
    // outer planes.
    const geo = simulateToEnd(carveKnob)
    const pos = geo.getAttribute('position') as THREE.BufferAttribute
    const nrm = geo.getAttribute('normal') as THREE.BufferAttribute
    const index = geo.getIndex()!
    const planes = [
      { name: '-X', axis: 'x' as const, at: STOCK.x0, out: new THREE.Vector3(-1, 0, 0) },
      { name: '+X', axis: 'x' as const, at: STOCK.x1, out: new THREE.Vector3(1, 0, 0) },
      { name: '-Y', axis: 'y' as const, at: STOCK.y0, out: new THREE.Vector3(0, -1, 0) },
      { name: '+Y', axis: 'y' as const, at: STOCK.y1, out: new THREE.Vector3(0, 1, 0) },
      { name: '-Z', axis: 'z' as const, at: STOCK.zBot, out: new THREE.Vector3(0, 0, -1) },
    ]
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3()
    const geometric = new THREE.Vector3(), authored = new THREE.Vector3()
    const near = (p: number, q: number) => Math.abs(p - q) < 1e-4
    const result: Record<string, { tris: number; inwardWinding: number; inwardNormal: number }> = {}
    for (const p of planes) result[p.name] = { tris: 0, inwardWinding: 0, inwardNormal: 0 }
    for (let t = 0; t < index.count; t += 3) {
      const ia = index.getX(t), ib = index.getX(t + 1), ic = index.getX(t + 2)
      a.fromBufferAttribute(pos, ia)
      b.fromBufferAttribute(pos, ib)
      c.fromBufferAttribute(pos, ic)
      if (new THREE.Triangle(a, b, c).getArea() < 1e-9) continue
      for (const p of planes) {
        if (!(near(a[p.axis], p.at) && near(b[p.axis], p.at) && near(c[p.axis], p.at))) continue
        const r = result[p.name]
        r.tris++
        geometric.subVectors(b, a).cross(c.clone().sub(a))
        if (geometric.dot(p.out) <= 0) r.inwardWinding++
        for (const iv of [ia, ib, ic]) {
          authored.fromBufferAttribute(nrm, iv)
          if (authored.dot(p.out) <= 0) r.inwardNormal++
        }
      }
    }
    for (const p of planes) {
      expect(result[p.name].tris, `${p.name} has triangles`).toBeGreaterThan(0)
      expect(result[p.name], p.name).toEqual({ tris: result[p.name].tris, inwardWinding: 0, inwardNormal: 0 })
    }
  })
})

describe('WO-2509: the voxel engine keeps the base solid at its sides', () => {
  it('voxels on the outer face below the cut stay solid; above it they are air', () => {
    // The voxel raymarch (voxelSimMaterial.ts) treats a ray that ENTERS the field
    // box inside solid as a surface hit, so solid boundary voxels ARE the side
    // wall. Check the field the shader samples, carved like the knob.
    const sim = new VoxelSimulator(
      { x0: STOCK.x0, y0: STOCK.y0, z0: STOCK.zBot, x1: STOCK.x1, y1: STOCK.y1, z1: STOCK.zTop },
      1,
      1_000_000,
    )
    const tool = { type: 'flat', diameter: 6 }
    for (let y = -3; y <= 43; y += 2) sim.sweepMove({ x: -3, y, z: BASE_Z }, { x: 43, y, z: BASE_Z }, tool)
    const f = sim.field
    const { nz, voxelSize } = f.dims
    const iy = Math.floor(f.dims.ny / 2)
    for (let iz = 0; iz < nz; iz++) {
      const zc = STOCK.zBot + (iz + 0.5) * voxelSize
      const v = f.data[f.idx(0, iy, iz)]
      if (zc < BASE_Z - voxelSize) expect(v).toBeGreaterThan(0)
      if (zc > BASE_Z + voxelSize) expect(v).toBeLessThan(0)
    }
  })
})
