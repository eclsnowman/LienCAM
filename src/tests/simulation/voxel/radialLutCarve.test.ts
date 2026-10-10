import { describe, it, expect } from 'vitest'
import { VoxelField, type VoxelGridDims } from '../../../lib/simulation/voxel/VoxelField'
import {
  isFlatBottomProfile,
  toolSdfWithProfile,
  csgSubtract,
  carveSweep,
  initSolidStock,
  type ToolShape,
} from '../../../lib/simulation/voxel/carve'
import { toolShapeFromTool, type VoxelSimTool } from '../../../lib/simulation/VoxelSimulator'
import { tipOffsetAtRadius, buildToolProfile, undercutSolidFor } from '../../../lib/tool/toolProfile'
import type { Tool, ToolType } from '../../../types'

// PERF-RECON finding #2 (coordination/reports/PERF-RECON.report.md): shaped
// tools (ball, bull-nose, ...) paid tipOffsetAtRadius PER VOXEL in the carve
// hot loop, ~11x a flat tool's cost. carve.ts's toolProfile() now serves those
// tools from a precomputed radial LUT (src/lib/tool/toolProfile.ts
// buildRadialLUT/evalRadialLUT) instead. This test is the carve-level,
// end-to-end oracle: it drives a full carveSweep through the PRODUCTION path
// (which now uses the LUT) and through an OLD path forced through the
// untouched tipOffsetAtRadius wrapper per voxel (exactly what production did
// before this change), for SHAPED tools this repo's docs explicitly call out
// (ball, bull-nose, v-bit, dovetail, lollipop) plus a multi-tooth thread mill
// for good measure, and asserts the resulting voxel fields are byte-identical.
//
// Mirrors src/tests/simulation/voxel/flatProfileBypass.test.ts's oracle
// pattern (carvePointOldPath/carveSweepOldPath), which proved the FLAT bypass
// byte-identical; this is the analogous proof for the shaped-tool LUT path.

const makeDims = (n: number, voxelSize = 1): VoxelGridDims => ({
  nx: n,
  ny: n,
  nz: n,
  voxelSize,
  x0: 0,
  y0: 0,
  z0: 0,
})

// Faithful reproduction of the OLD (pre-LUT) shaped-tool carve: build the
// profile closure as the per-voxel tipOffsetAtRadius wrapper (untouched
// oracle) and run csgSubtract with the SAME AABB carvePoint uses.
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

// Drive a multi-segment carve path (plunge + L-shaped sweep) through BOTH the
// production carveSweep (LUT path) and the OLD tipOffsetAtRadius-per-voxel
// oracle path, asserting the resulting fields are byte-identical.
function assertCarveByteIdentical(tool: ToolShape, label: string): void {
  expect(tool.profile, `${label}: expected a prebuilt profile`).toBeDefined()
  expect(isFlatBottomProfile(tool.profile!, tool.radius), `${label}: must NOT take the flat bypass`).toBe(
    false,
  )

  const band = 3
  const N = 31
  const fNew = new VoxelField(makeDims(N))
  initSolidStock(fNew, band)
  const fOld = new VoxelField(makeDims(N))
  initSolidStock(fOld, band)

  const ax = fNew.voxelCenterWorld(15, 15, 0).x
  const ay = fNew.voxelCenterWorld(15, 15, 0).y
  const cutZ = 20

  const p0 = { x: ax, y: ay, z: cutZ }
  const p1 = { x: fNew.voxelCenterWorld(22, 15, 0).x, y: ay, z: cutZ }
  const p2 = { x: fNew.voxelCenterWorld(22, 22, 0).x, y: fNew.voxelCenterWorld(15, 22, 0).y, z: cutZ }

  carveSweep(fNew, p0, p0, tool, band) // plunge
  carveSweep(fNew, p0, p1, tool, band)
  carveSweep(fNew, p1, p2, tool, band)

  carveSweepOldPath(fOld, p0, p0, tool, band)
  carveSweepOldPath(fOld, p0, p1, tool, band)
  carveSweepOldPath(fOld, p1, p2, tool, band)

  let differing = 0
  for (let i = 0; i < fNew.data.length; i++) {
    if (fNew.data[i] !== fOld.data[i]) differing++
  }
  expect(differing, `${label}: voxel field must be byte-identical`).toBe(0)
  expect(fNew.data).toEqual(fOld.data)
}

// WO-1383: undercut profiles (dovetail, lollipop, thread teeth) no longer carve
// through the bottom-surface LUT path at all; they carve their bounded section
// (src/tests/simulation/undercutCarve.wo1383.test.ts). Their LUT stays proven
// against tipOffsetAtRadius in src/tests/tool/radialLUT.test.ts. Here: the
// production carve leaves standing some of what the old full-radius column
// wrongly removed. For a lollipop or thread mill the old column contained the
// whole tool, so nothing new is removed; a dovetail's old "bottom" was its
// inverted taper, so the wedge under the taper is cut for the first time.
function assertUndercutCarvesInsideOldColumn(
  tool: ToolShape,
  label: string,
  wedgeUnderTaper = false,
): void {
  expect(undercutSolidFor(tool.profile!, tool.radius), `${label}: undercut solid`).not.toBeNull()
  const band = 3
  const N = 31
  const fNew = new VoxelField(makeDims(N))
  initSolidStock(fNew, band)
  const fOld = new VoxelField(makeDims(N))
  initSolidStock(fOld, band)
  const ay = fNew.voxelCenterWorld(15, 15, 0).y
  const p0 = { x: fNew.voxelCenterWorld(15, 15, 0).x, y: ay, z: 20 }
  const p1 = { x: fNew.voxelCenterWorld(22, 15, 0).x, y: ay, z: 20 }
  carveSweep(fNew, p0, p0, tool, band)
  carveSweep(fNew, p0, p1, tool, band)
  carveSweepOldPath(fOld, p0, p0, tool, band)
  carveSweepOldPath(fOld, p0, p1, tool, band)
  let newOnly = 0
  let oldOnly = 0
  for (let i = 0; i < fNew.data.length; i++) {
    if (fNew.data[i] < 0 && !(fOld.data[i] < 0)) newOnly++
    if (fOld.data[i] < 0 && !(fNew.data[i] < 0)) oldOnly++
  }
  if (wedgeUnderTaper) expect(newOnly, `${label}: wedge under the taper cut`).toBeGreaterThan(0)
  else expect(newOnly, `${label}: removed outside the old column`).toBe(0)
  expect(oldOnly, `${label}: overhang left standing`).toBeGreaterThan(0)
}

function shapedTool(t: VoxelSimTool): ToolShape {
  return toolShapeFromTool(t)
}

// VoxelSimTool/toolShapeFromTool (the sim's real entry point) does not carry
// thread-pitch fields, so a thread mill can never reach a real (non-flat)
// profile through the sim path today -- the LUT's zigzag-teeth correctness is
// proven directly against buildToolProfile instead (also covered at the pure
// function level in src/tests/tool/radialLUT.test.ts).
function threadMillShape(over: Partial<Tool>): ToolShape {
  const tool: Tool = {
    id: '',
    name: '',
    type: 'thread_mill' as ToolType,
    diameter: 6,
    fluteLength: 20,
    shankDiameter: 6,
    overallLength: 50,
    numberOfFlutes: 0,
    material: 'carbide',
    coating: 'none',
    notes: '',
    feedsAndSpeeds: {},
    ...over,
  }
  return { type: tool.type, radius: tool.diameter / 2, profile: buildToolProfile(tool) }
}

describe('radial LUT carve equivalence (PERF-RECON finding #2, byte-identical)', () => {
  it('ball end mill', () => {
    assertCarveByteIdentical(
      shapedTool({
        type: 'ball_end_mill',
        diameter: 6,
        fluteLength: 12,
        overallLength: 50,
        shankDiameter: 6,
      }),
      'ball',
    )
  })

  it('bull nose', () => {
    assertCarveByteIdentical(
      shapedTool({
        type: 'bull_nose',
        diameter: 8,
        cornerRadius: 1.5,
        fluteLength: 12,
        overallLength: 50,
        shankDiameter: 8,
      }),
      'bull-nose',
    )
  })

  it('v-bit (chamfer/engrave family)', () => {
    assertCarveByteIdentical(
      shapedTool({
        type: 'v_bit',
        diameter: 8,
        angleFromAxisDeg: 30, // 60 included
        fluteLength: 12,
        overallLength: 50,
        shankDiameter: 8,
      }),
      'v-bit',
    )
  })

  it('dovetail mill (inverted taper)', () => {
    assertUndercutCarvesInsideOldColumn(
      shapedTool({
        type: 'dovetail_mill',
        diameter: 10,
        angleFromAxisDeg: 25,
        fluteLength: 3,
        neckDiameter: 5,
        shoulderLength: 5,
        shankDiameter: 8,
        overallLength: 50,
      }),
      'dovetail',
      true,
    )
  })

  it('lollipop mill (shadowed neck tail)', () => {
    assertUndercutCarvesInsideOldColumn(
      shapedTool({
        type: 'lollipop_mill',
        diameter: 6,
        neckDiameter: 3,
        shoulderLength: 8,
        fluteLength: 12,
        overallLength: 50,
        shankDiameter: 6,
      }),
      'lollipop',
    )
  })

  it('thread mill, multi-tooth (zigzag profile)', () => {
    assertUndercutCarvesInsideOldColumn(
      threadMillShape({
        threadPitch: 1,
        threadTeethCount: 4,
        threadFormAngleDeg: 60,
        neckDiameter: 4,
        shoulderLength: 6,
      }),
      'thread-mill',
    )
  })
})
