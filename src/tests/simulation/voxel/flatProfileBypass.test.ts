import { describe, it, expect } from 'vitest'
import { VoxelField, type VoxelGridDims } from '../../../lib/simulation/voxel/VoxelField'
import {
  toolProfile,
  isFlatBottomProfile,
  toolSdfWithProfile,
  csgSubtract,
  carveSweep,
  initSolidStock,
  type ToolShape,
} from '../../../lib/simulation/voxel/carve'
import { toolShapeFromTool, type VoxelSimTool } from '../../../lib/simulation/VoxelSimulator'
import { tipOffsetAtRadius } from '../../../lib/tool/toolProfile'

const makeDims = (n: number, voxelSize = 1): VoxelGridDims => ({
  nx: n,
  ny: n,
  nz: n,
  voxelSize,
  x0: 0,
  y0: 0,
  z0: 0,
})

// A real flat end-mill WITH a prebuilt profile (fluteLength + overallLength set),
// exactly as the production sim builds it via toolShapeFromTool.
const flatWithProfile = (diameter: number): ToolShape =>
  toolShapeFromTool({
    type: 'flat_end_mill',
    diameter,
    fluteLength: 12,
    overallLength: 50,
    shankDiameter: diameter,
  } as VoxelSimTool)

// A shaped (NON-flat) tool with a profile: a v-bit (cone profileKind). Its bottom
// surface rises with radius, so the flat-bottom bypass must NOT fire for it.
const vbitWithProfile = (diameter: number, includedAngleDeg: number): ToolShape =>
  toolShapeFromTool({
    type: 'v_bit',
    diameter,
    angleFromAxisDeg: includedAngleDeg / 2, // stored half-angle (from axis)
    fluteLength: 12,
    overallLength: 50,
    shankDiameter: diameter,
  } as VoxelSimTool)

// A ball end-mill with a profile (hemispherical bottom) — also non-flat.
const ballWithProfile = (diameter: number): ToolShape =>
  toolShapeFromTool({
    type: 'ball_end_mill',
    diameter,
    fluteLength: 12,
    overallLength: 50,
    shankDiameter: diameter,
  } as VoxelSimTool)

// Faithful reproduction of the OLD (pre-bypass) carve: build the profile closure
// as the per-voxel tipOffsetAtRadius wrapper and run csgSubtract with the SAME
// AABB carvePoint uses. This is byte-identical to the legacy carvePoint for a
// flat tool except that it never takes the new `() => 0` fast path.
function carvePointOldPath(
  field: VoxelField,
  tx: number,
  ty: number,
  tz: number,
  profileShape: ToolShape,
  band: number,
): void {
  const R = profileShape.radius
  const profile = profileShape.profile!
  const { z0, voxelSize, nz } = field.dims
  const fieldTopZ = z0 + nz * voxelSize
  const min = { x: tx - R - band, y: ty - R - band, z: tz - band }
  const max = { x: tx + R + band, y: ty + R + band, z: fieldTopZ + band }
  const prof = (d: number) => tipOffsetAtRadius(profile, Math.min(d, R))
  csgSubtract(
    field,
    (x, y, z) => toolSdfWithProfile(x, y, z, tx, ty, tz, R, prof),
    min,
    max,
    band,
  )
}

function carveSweepOldPath(
  field: VoxelField,
  from: { x: number; y: number; z: number },
  to: { x: number; y: number; z: number },
  profileShape: ToolShape,
  band: number,
): void {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const dz = to.z - from.z
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz)
  const maxStep = 0.5 * field.dims.voxelSize
  const steps = Math.max(1, Math.ceil(len / maxStep))
  for (let i = 0; i <= steps; i++) {
    const u = i / steps
    carvePointOldPath(field, from.x + dx * u, from.y + dy * u, from.z + dz * u, profileShape, band)
  }
}

describe('flat-profile carve bypass (perf, byte-identical)', () => {
  const band = 3
  const N = 31
  const diameter = 6

  it('flat end-mill with a profile takes the bypass (isFlatBottomProfile === true)', () => {
    const tool = flatWithProfile(diameter)
    expect(tool.profile).toBeDefined()
    expect(isFlatBottomProfile(tool.profile!, tool.radius)).toBe(true)
    // The returned closure is the analytic flat path: 0 at every radius.
    const p = toolProfile(tool)
    for (const d of [0, 0.5, 1.5, 3]) expect(p(d)).toBe(0)
  })

  it('byte-identical field to the OLD profile-wrapper carve over a multi-move sweep', () => {
    const tool = flatWithProfile(diameter)

    // NEW (production) path: carveSweep -> toolProfile -> flat bypass `() => 0`.
    const fNew = new VoxelField(makeDims(N))
    initSolidStock(fNew, band)
    // OLD path: same positions, forced through the tipOffsetAtRadius wrapper.
    const fOld = new VoxelField(makeDims(N))
    initSolidStock(fOld, band)

    const ax = fNew.voxelCenterWorld(15, 15, 0).x
    const ay = fNew.voxelCenterWorld(15, 15, 0).y
    const cutZ = 20

    // A short multi-segment path (a plunge column + an L-shaped sweep). Each
    // carveSweep covers many sub-step positions, so this is several hundred
    // carvePoint calls into a small field — well under 5s.
    const p0 = { x: ax, y: ay, z: cutZ }
    const p1 = { x: fNew.voxelCenterWorld(22, 15, 0).x, y: ay, z: cutZ }
    const p2 = { x: fNew.voxelCenterWorld(22, 22, 0).x, y: fNew.voxelCenterWorld(15, 22, 0).y, z: cutZ }

    carveSweep(fNew, p0, p0, tool, band) // plunge
    carveSweep(fNew, p0, p1, tool, band)
    carveSweep(fNew, p1, p2, tool, band)

    carveSweepOldPath(fOld, p0, p0, tool, band)
    carveSweepOldPath(fOld, p0, p1, tool, band)
    carveSweepOldPath(fOld, p1, p2, tool, band)

    // Count differing voxels explicitly — the gate is ZERO.
    let differing = 0
    for (let i = 0; i < fNew.data.length; i++) {
      if (fNew.data[i] !== fOld.data[i]) differing++
    }
    expect(differing).toBe(0)
    // And the whole Float32Array is exactly equal.
    expect(fNew.data).toEqual(fOld.data)
  })

  it('NEGATIVE guard: shaped tools (v-bit, ball) do NOT trigger the bypass', () => {
    const vbit = vbitWithProfile(diameter, 90) // 90 included -> 45 from axis
    const ballTool = ballWithProfile(diameter)
    expect(vbit.profile).toBeDefined()
    expect(ballTool.profile).toBeDefined()

    // The flatness check must return false so these stay on the profile path.
    expect(isFlatBottomProfile(vbit.profile!, vbit.radius)).toBe(false)
    expect(isFlatBottomProfile(ballTool.profile!, ballTool.radius)).toBe(false)

    // Behavioral proof: their bottom surface rises (NOT the `() => 0` closure).
    const pv = toolProfile(vbit)
    expect(pv(vbit.radius)).toBeGreaterThan(0)
    const pb = toolProfile(ballTool)
    expect(pb(ballTool.radius)).toBeGreaterThan(0)
  })
})
