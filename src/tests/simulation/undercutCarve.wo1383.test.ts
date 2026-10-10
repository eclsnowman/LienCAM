import { describe, it, expect } from 'vitest'
import { VoxelSimulator, type VoxelSimTool } from '../../lib/simulation/VoxelSimulator'
import { HeightmapSimulator } from '../../lib/simulation/HeightmapSimulator'
import {
  buildToolProfile,
  buildUndercutSolid,
  isUndercutProfile,
  tipOffsetAtRadius,
  toolBodyTopAtRadius,
  undercutSignedDistance,
  type ToolProfile,
} from '../../lib/tool/toolProfile'
import type { Tool, ToolType } from '../../types'

// WO-1383 (BUG-520): the simulation removed material above a lollipop cutter's
// head. The carve treated every tool as "bottom surface + a full-radius column",
// which for a head wider than its neck claims the overhang the tool passes under.
//
// Scenario (through VoxelSimulator.sweepMove, the voxel sim's entry point): a
// 3.4 mm flat end mill cuts a slot down to z=2, then a 6 mm lollipop on a 3 mm
// neck runs along the slot with its tip at z=1, cutting the undercut on both
// sides. Every voxel outside what the two tools can reach must stay solid.

const LOLLIPOP: VoxelSimTool = {
  type: 'lollipop_mill',
  diameter: 6,
  neckDiameter: 3,
  shoulderLength: 8,
  fluteLength: 12,
  overallLength: 50,
  shankDiameter: 6,
}
const SLOT_MILL: VoxelSimTool = {
  type: 'flat_end_mill',
  diameter: 3.4,
  fluteLength: 20,
  overallLength: 50,
  shankDiameter: 3.4,
}
const HEAD_R = 3
const NECK_R = 1.5
const SLOT_R = 1.7
const SLOT_Z = 2
const TIP_Z = 1
const HEAD_CZ = TIP_Z + HEAD_R

function makeTool(over: Partial<Tool> & { type: ToolType; diameter: number }): Tool {
  return {
    id: '',
    name: '',
    fluteLength: 12,
    shankDiameter: over.diameter,
    overallLength: 50,
    numberOfFlutes: 2,
    material: 'carbide',
    coating: 'none',
    notes: '',
    feedsAndSpeeds: {},
    ...over,
  } as Tool
}

function cutUndercut(): VoxelSimulator {
  const sim = new VoxelSimulator({ x0: 0, y0: -6, z0: 0, x1: 16, y1: 6, z1: 10 }, 0.25, 1e7)
  for (const [tool, z] of [
    [SLOT_MILL, SLOT_Z],
    [LOLLIPOP, TIP_Z],
  ] as const) {
    // Plunge beside the stock, then feed along y=0 through it.
    const above = { x: -4, y: 0, z: 12 }
    const down = { x: -4, y: 0, z }
    sim.sweepMove(above, down, tool)
    sim.sweepMove(down, { x: 20, y: 0, z }, tool)
  }
  return sim
}

// Superset of what the slot mill, the lollipop head (a sphere swept along x) and
// its neck can reach, in the YZ plane (the cut runs through the whole stock in x).
function reachable(y: number, z: number): boolean {
  if (Math.abs(y) <= SLOT_R && z >= SLOT_Z) return true
  if (Math.hypot(y, z - HEAD_CZ) <= HEAD_R) return true
  return Math.abs(y) <= NECK_R && z >= HEAD_CZ
}

describe('WO-1383: undercut tools carve a bounded solid', () => {
  it('a lollipop under an overhang leaves the overhang standing and cuts the undercut (voxel sim)', () => {
    const f = cutUndercut().field
    const { nx, ny, nz } = f.dims
    let wronglyRemoved = 0
    let overhang = 0
    let undercut = 0
    let undercutMissed = 0
    for (let iz = 0; iz < nz; iz++) {
      for (let iy = 0; iy < ny; iy++) {
        for (let ix = 0; ix < nx; ix++) {
          const c = f.voxelCenterWorld(ix, iy, iz)
          const v = f.get(ix, iy, iz)
          const ay = Math.abs(c.y)
          if (!reachable(c.y, c.z)) {
            if (v <= 0) wronglyRemoved++
            const headTop = HEAD_CZ + Math.sqrt(Math.max(0, HEAD_R * HEAD_R - ay * ay))
            if (ay > SLOT_R + 0.2 && ay < HEAD_R && c.z > headTop + 0.3) overhang++
          } else if (ay > SLOT_R + 0.2 && Math.hypot(c.y, c.z - HEAD_CZ) < HEAD_R - 0.3) {
            undercut++
            if (!(v < 0)) undercutMissed++
          }
        }
      }
    }
    expect(overhang, 'overhang voxels in the scenario').toBeGreaterThan(1000)
    expect(undercut, 'undercut voxels in the scenario').toBeGreaterThan(1000)
    expect(wronglyRemoved, 'voxels removed that neither tool reaches').toBe(0)
    expect(undercutMissed, 'undercut voxels left standing').toBe(0)
  })

  it('classifies only profiles that narrow going up as undercuts', () => {
    const monotonic = [
      makeTool({ type: 'flat_end_mill', diameter: 6 }),
      makeTool({ type: 'ball_end_mill', diameter: 6 }),
      makeTool({ type: 'bull_nose', diameter: 8, cornerRadius: 1 }),
      makeTool({ type: 'drill', diameter: 5, angleFromAxisDeg: 59 }),
      makeTool({ type: 'chamfer_mill', diameter: 10, angleFromAxisDeg: 45 }),
      makeTool({ type: 'v_bit', diameter: 8, angleFromAxisDeg: 30 }),
    ]
    for (const t of monotonic) {
      expect(isUndercutProfile(buildToolProfile(t), t.diameter / 2), t.type).toBe(false)
    }
    for (const t of undercutTools()) {
      expect(isUndercutProfile(buildToolProfile(t), t.diameter / 2), t.type).toBe(true)
    }
  })

  it('the undercut section agrees with a brute-force walk of the profile', () => {
    let seed = 1383
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed / 2147483648
    }
    for (const t of undercutTools()) {
      const R = t.diameter / 2
      const profile = buildToolProfile(t)
      const solid = buildUndercutSolid(profile, R)
      let checked = 0
      let mismatched = 0
      for (let s = 0; s < 20000; s++) {
        const d = rand() * R * 1.1
        const h = -1 + rand() * (solid.topZ + 4)
        const inside = bruteInside(profile, R, d, h)
        if (inside === null) continue
        checked++
        if (undercutSignedDistance(solid, d, h) > 0 !== inside) mismatched++
      }
      expect(checked, t.type).toBeGreaterThan(19000)
      expect(mismatched, t.type).toBe(0)
    }
  })

  it('heightmap: a lollipop passing under the surface leaves it; a head that reaches it lowers it', () => {
    const profile = buildToolProfile(makeTool({ type: 'lollipop_mill', diameter: 6, neckDiameter: 3, shoulderLength: 8 }))
    const bottom = (d: number) => tipOffsetAtRadius(profile, d)
    const top = (d: number) => toolBodyTopAtRadius(profile, d)
    expect(top(1)).toBe(Infinity)
    expect(top(2)).toBeCloseTo(3 + Math.sqrt(5), 1)
    expect(toolBodyTopAtRadius(buildToolProfile(makeTool({ type: 'ball_end_mill', diameter: 6 })), 2)).toBe(Infinity)

    const run = (stockTop: number, bodyTop?: (d: number) => number) => {
      const hm = new HeightmapSimulator(0, -6, 16, 12, stockTop, 0, 0.25)
      hm.sweepMoveWithProfile(-4, 0, TIP_Z, 20, 0, TIP_Z, HEAD_R, bottom, bodyTop)
      return (x: number, y: number) =>
        hm.heights[Math.floor((y - hm.y0) / hm.cellSize) * hm.nx + Math.floor((x - hm.x0) / hm.cellSize)]
    }
    const undercutFloor = TIP_Z + HEAD_R - Math.sqrt(HEAD_R * HEAD_R - 2.125 * 2.125)

    const bounded = run(10, top)
    expect(bounded(8.125, 2.125), 'surface above the head stays').toBe(10)
    expect(bounded(8.125, 0.125), 'neck column is cut to the tip').toBeCloseTo(TIP_Z, 1)

    // Without the bound (the old behaviour) the head removes the overhang.
    expect(run(10)(8.125, 2.125)).toBeCloseTo(undercutFloor, 1)
    // A surface below the head's top is reached and lowered.
    expect(run(5, top)(8.125, 2.125)).toBeCloseTo(undercutFloor, 1)
  })
})

function undercutTools(): Tool[] {
  return [
    makeTool({ type: 'lollipop_mill', diameter: 6, neckDiameter: 3, shoulderLength: 8 }),
    makeTool({
      type: 'dovetail_mill',
      diameter: 10,
      angleFromAxisDeg: 25,
      fluteLength: 3,
      neckDiameter: 5,
      shoulderLength: 5,
      shankDiameter: 8,
    }),
    makeTool({ type: 'slitting_saw', diameter: 20, fluteLength: 2, neckDiameter: 8, shankDiameter: 8 }),
    makeTool({
      type: 'thread_mill',
      diameter: 6,
      fluteLength: 20,
      threadPitch: 1,
      threadTeethCount: 4,
      threadFormAngleDeg: 60,
      neckDiameter: 4,
      shoulderLength: 6,
    }),
  ]
}

// Inside test by walking the profile polyline directly: the tool at height h is
// a disc of the profile radius (clamped to R), continuing at the top radius above
// the cutting region. null when (d, h) sits too close to a vertex or the wall to
// call.
function bruteInside(profile: ToolProfile, R: number, d: number, h: number): boolean | null {
  const cut = profile.vertices.filter((p) => p.z <= profile.cuttingMaxZ + 1e-9)
  for (const p of cut) if (Math.abs(p.z - h) < 1e-6) return null
  if (h < cut[0].z) return false
  let r = Math.min(cut[cut.length - 1].r, R)
  for (let i = 0; i < cut.length - 1; i++) {
    const a = cut[i]
    const b = cut[i + 1]
    if (a.z <= h && h < b.z) {
      const ra = Math.min(a.r, R)
      const rb = Math.min(b.r, R)
      r = ra + ((rb - ra) * (h - a.z)) / (b.z - a.z)
      break
    }
  }
  if (Math.abs(r - d) < 1e-6) return null
  return d < r
}
