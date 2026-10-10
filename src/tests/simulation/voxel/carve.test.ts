import { describe, it, expect } from 'vitest'
import { VoxelField, type VoxelGridDims } from '../../../lib/simulation/voxel/VoxelField'
import {
  toolProfile,
  toolSdf,
  toolSdfWithProfile,
  csgSubtract,
  carvePoint,
  carveSweep,
  initSolidStock,
  type ToolShape,
} from '../../../lib/simulation/voxel/carve'

const makeDims = (
  nx: number,
  ny: number,
  nz: number,
  voxelSize = 1,
  x0 = 0,
  y0 = 0,
  z0 = 0,
): VoxelGridDims => ({ nx, ny, nz, voxelSize, x0, y0, z0 })

const flat = (radius: number): ToolShape => ({ type: 'flat_end_mill', radius })
const ball = (radius: number): ToolShape => ({ type: 'ball_end_mill', radius })
const vbit = (radius: number, angleFromAxisDeg: number): ToolShape => ({
  type: 'v_bit',
  radius,
  angleFromAxisDeg,
})

describe('toolProfile', () => {
  it('flat end-mill is 0 everywhere within the radius', () => {
    const p = toolProfile(flat(3))
    for (const d of [0, 0.5, 1, 2, 3]) expect(p(d)).toBe(0)
  })

  it('ball end-mill: 0 at the tip (d=0), R at the equator (d=R)', () => {
    const R = 4
    const p = toolProfile(ball(R))
    expect(p(0)).toBeCloseTo(0)
    expect(p(R)).toBeCloseTo(R)
    // Midway: R - sqrt(R^2 - (R/2)^2).
    const half = R / 2
    expect(p(half)).toBeCloseTo(R - Math.sqrt(R * R - half * half))
  })

  it('v-bit is linear in d with slope 1/tan(angle from axis)', () => {
    // angleFromAxisDeg = 45 (= 90 included) -> tan = 1 -> profile(d) = d.
    const p = toolProfile(vbit(5, 45))
    expect(p(0)).toBeCloseTo(0)
    expect(p(1)).toBeCloseTo(1)
    expect(p(2)).toBeCloseTo(2)
    // angleFromAxisDeg = 30 (= 60 included) -> slope = 1/tan(30) = sqrt(3).
    const p60 = toolProfile(vbit(5, 30))
    const slope = 1 / Math.tan((30 * Math.PI) / 180)
    expect(p60(1)).toBeCloseTo(slope)
    expect(p60(2)).toBeCloseTo(2 * slope)
  })
})

describe('initSolidStock', () => {
  it('a deep-interior voxel equals the band; a near-face voxel ~= half a voxel', () => {
    const band = 2
    // 11x11x11 @ 1mm so there is a true center voxel (index 5) far from faces.
    const f = new VoxelField(makeDims(11, 11, 11, 1))
    initSolidStock(f, band)

    // Deep interior: index (5,5,5) center is 5.5mm from each face -> >= band -> clamped to band.
    expect(f.get(5, 5, 5)).toBeCloseTo(band)

    // A voxel whose center is half a voxel from a face: index (0, 5, 5).
    // Its center x is x0 + 0.5*voxelSize = 0.5, distance to x=0 face is 0.5.
    const c = f.voxelCenterWorld(0, 5, 5)
    expect(c.x).toBeCloseTo(0.5)
    expect(f.get(0, 5, 5)).toBeCloseTo(0.5 * 1) // 0.5 * voxelSize
  })

  it('marks the whole field dirty', () => {
    const f = new VoxelField(makeDims(3, 3, 3, 1))
    initSolidStock(f, 2)
    expect(f.dirty).toEqual({ ix0: 0, iy0: 0, iz0: 0, ix1: 2, iy1: 2, iz1: 2 })
  })
})

describe('flat end-mill plunge (clean cylindrical column)', () => {
  it('removes inside-radius-above-cutZ, keeps inside-radius-below and outside-radius', () => {
    const band = 3
    // 21x21x21 @ 1mm, origin 0. Center axis at world (10.5, 10.5).
    const N = 21
    const f = new VoxelField(makeDims(N, N, N, 1))
    initSolidStock(f, band)

    const R = 4
    const tool = flat(R)
    const axisX = f.voxelCenterWorld(10, 10, 0).x // 10.5
    const axisY = f.voxelCenterWorld(10, 10, 0).y // 10.5
    const cutZ = 12 // tip plunged to z=12 (well below the z=21 top)
    carvePoint(f, axisX, axisY, cutZ, tool, band)

    // Inside radius, ABOVE the cut -> removed (air, f < 0).
    // voxel (10,10,15): center z=15.5 > cutZ, on the axis (d=0 < R).
    expect(f.get(10, 10, 15)).toBeLessThan(0)
    // voxel (12,10,15): center x=12.5, d=2 < R, above cut -> removed.
    expect(f.get(12, 10, 15)).toBeLessThan(0)

    // Inside radius, BELOW the cut -> still solid (f > 0).
    // voxel (10,10,8): center z=8.5 < cutZ -> below the flat bottom -> solid.
    expect(f.get(10, 10, 8)).toBeGreaterThan(0)

    // OUTSIDE radius (a grid corner column), above the cut -> still solid.
    // voxel (0,0,15): far from the axis (d ~= 14 >> R) -> untouched solid.
    expect(f.get(0, 0, 15)).toBeGreaterThan(0)

    // Just outside the radial wall at the cut height also stays solid:
    // voxel (15,10,15): center x=15.5, d=5 > R=4 -> outside -> solid.
    expect(f.get(15, 10, 15)).toBeGreaterThan(0)
  })
})

describe('ball end-mill hemispherical bottom', () => {
  it('a voxel just below the hemisphere stays solid; directly above is removed', () => {
    const band = 4
    const N = 31
    const f = new VoxelField(makeDims(N, N, N, 1))
    initSolidStock(f, band)

    const R = 6
    const tool = ball(R)
    const axisX = f.voxelCenterWorld(15, 15, 0).x // 15.5
    const axisY = f.voxelCenterWorld(15, 15, 0).y // 15.5
    const tipZ = 10 // ball tip (lowest point) at z=10
    carvePoint(f, axisX, axisY, tipZ, tool, band)

    // Pick a moderate radial offset: d=3. The hemisphere bottom surface there is
    // at z = tipZ + profile(3) = 10 + (6 - sqrt(36-9)) = 10 + (6 - 5.196) = 10.804.
    // So a voxel center BELOW ~10.8 at d=3 stays solid; one above is removed.
    // d=3 -> use ix offset of 3 from axis: voxel x index 18 (center 18.5, d=3).
    const belowZ = 10 // voxel iz=10 center z=10.5 -> below the 10.8 bottom surface
    const aboveZ = 13 // voxel iz=13 center z=13.5 -> above the bottom surface
    expect(f.get(18, 15, belowZ)).toBeGreaterThan(0) // solid under the ball
    expect(f.get(18, 15, aboveZ)).toBeLessThan(0) // removed above the bottom
  })
})

describe('UNDERCUT PROOF (impossible for a 2.5D heightmap)', () => {
  it('carves an interior sphere: center is void, material directly ABOVE it remains solid', () => {
    // A 2.5D heightmap stores one remaining-Z per XY column, so it can NEVER
    // represent solid material sitting ABOVE a void in the same column. This
    // test removes a sphere fully interior to the stock and asserts exactly
    // that overhang condition holds in the voxel field -> true 3D occupancy.
    const band = 4
    const N = 31
    const f = new VoxelField(makeDims(N, N, N, 1))
    initSolidStock(f, band)

    // Sphere center at the grid middle, radius 5, fully interior.
    const center = f.voxelCenterWorld(15, 15, 15) // (15.5, 15.5, 15.5)
    const sphereR = 5
    const sphereInsidePositive = (x: number, y: number, z: number): number => {
      const dx = x - center.x
      const dy = y - center.y
      const dz = z - center.z
      return sphereR - Math.sqrt(dx * dx + dy * dy + dz * dz)
    }
    const min = { x: center.x - sphereR - band, y: center.y - sphereR - band, z: center.z - sphereR - band }
    const max = { x: center.x + sphereR + band, y: center.y + sphereR + band, z: center.z + sphereR + band }
    csgSubtract(f, sphereInsidePositive, min, max, band)

    // The sphere center voxel is removed (inside the void).
    expect(f.get(15, 15, 15)).toBeLessThan(0)

    // A voxel directly ABOVE the sphere, same xy, higher z, OUTSIDE the sphere,
    // remains SOLID. center z = 15.5 + (sphereR + 3) = above the void.
    // voxel (15,15,24): center z=24.5, distance from center ~= 9 > sphereR -> solid.
    expect(f.get(15, 15, 24)).toBeGreaterThan(0)
    // And the column between (the void roof) really did get carved: a voxel on
    // the top of the sphere is removed, proving solid sits above carved-out air.
    // voxel (15,15,18): center z=18.5, distance ~=3 < sphereR -> removed.
    expect(f.get(15, 15, 18)).toBeLessThan(0)
  })
})

describe('carveSweep continuous channel (no gaps between steps)', () => {
  it('a horizontal line plunge-cut removes a continuous channel', () => {
    const band = 3
    const N = 41
    const f = new VoxelField(makeDims(N, N, N, 1))
    initSolidStock(f, band)

    const R = 2
    const tool = flat(R)
    const cutZ = 30 // tip below the z=41 top
    // Sweep along +x at fixed y, constant z.
    const fromX = f.voxelCenterWorld(8, 20, 0).x // 8.5
    const toX = f.voxelCenterWorld(32, 20, 0).x // 32.5
    const y = f.voxelCenterWorld(8, 20, 0).y // 20.5
    carveSweep(f, { x: fromX, y, z: cutZ }, { x: toX, y, z: cutZ }, tool, band)

    // Sample voxels along the path centerline ABOVE the cut: all should be
    // removed, including positions BETWEEN nominal carve steps (every ix in the
    // swept range). The sweep step is 0.5*voxel = 0.5mm, far finer than 1 voxel,
    // so there must be no un-carved gaps.
    for (let ix = 9; ix <= 31; ix++) {
      // a voxel at the centerline, above the cut plane
      expect(f.get(ix, 20, 32)).toBeLessThan(0)
    }

    // Off the channel (well beyond the tool radius) stays solid.
    expect(f.get(20, 28, 32)).toBeGreaterThan(0)
    // Below the cut along the channel stays solid.
    expect(f.get(20, 20, 25)).toBeGreaterThan(0)
  })
})

describe('toolSdfWithProfile matches toolSdf (Opt 3 hoist)', () => {
  it('returns identical values for the same tool with a hoisted profile', () => {
    const t = ball(6)
    const profile = toolProfile(t)
    for (const [px, py, pz] of [
      [0, 0, 1],
      [2, 3, 7],
      [5, 0, 4],
      [10, 10, 0],
    ] as const) {
      expect(toolSdfWithProfile(px, py, pz, 0, 0, 0, t.radius, profile)).toBe(
        toolSdf(px, py, pz, 0, 0, 0, t),
      )
    }
  })
})

describe('OPTIMIZED carve equivalence (Opt 1/2/3 byte-identical)', () => {
  // Carve a flat-mill plunge + a short SELF-OVERLAPPING sweep so saturated-air
  // voxels (cur === -band) really are revisited by Opt 2, then assert the field
  // matches a brute-force reference computed directly in the test, plus that the
  // dirty box equals the TIGHT union of voxels actually written (not the naive
  // per-voxel-set box that would include unchanged saturated cells).
  const band = 3
  const N = 41
  const R = 2
  const tool = flat(R)
  const cutZ = 30

  // Build a field with the production (optimized) carve path.
  const f = new VoxelField(makeDims(N, N, N, 1))
  initSolidStock(f, band)

  const ax = f.voxelCenterWorld(15, 20, 0).x
  const ay = f.voxelCenterWorld(15, 20, 0).y
  // 1) A plunge at (15,20). 2) A short sweep that starts AT the same column and
  //    moves +x only a couple voxels, so its first carve positions overlap the
  //    already-cleared plunge column -> saturated revisits.
  carvePoint(f, ax, ay, cutZ, tool, band)
  f.clearDirty() // isolate the sweep's dirty box for the tight-box assertion.
  const toX = f.voxelCenterWorld(18, 20, 0).x
  carveSweep(f, { x: ax, y: ay, z: cutZ }, { x: toX, y: ay, z: cutZ }, tool, band)

  // Brute-force reference: start from solid stock, then apply the EXACT same
  // sequence of tool positions with the naive per-voxel min()-clamp math. It
  // mirrors the OPTIMIZED written-bbox semantics: it skips saturated-air cells
  // (cur === -band, the Opt-2 early-out) and marks dirty over every NON-saturated
  // cell it writes (whether or not the value ends up changing), exactly like the
  // optimized csgSubtract grows wix*/wiy*/wiz*.
  const ref = new VoxelField(makeDims(N, N, N, 1))
  initSolidStock(ref, band)
  const clampLocal = (v: number, lo: number, hi: number) =>
    v < lo ? lo : v > hi ? hi : v
  // Saturated-air value as STORED in the f32 field. Production now uses this
  // (Math.fround(-band)) so the dead `cur === -band` early-out actually fires
  // and the dirty box tightens; mirror it here so f.dirty === ref.dirty holds.
  const satAir = Math.fround(-band)
  const naiveCarvePoint = (tx: number, ty: number, tz: number) => {
    const { z0, voxelSize, nz } = ref.dims
    const fieldTopZ = z0 + nz * voxelSize
    const min = { x: tx - R - band, y: ty - R - band, z: tz - band }
    const max = { x: tx + R + band, y: ty + R + band, z: fieldTopZ + band }
    const lo = ref.worldToVoxel(min.x, min.y, min.z)
    const hi = ref.worldToVoxel(max.x, max.y, max.z)
    const { nx, ny } = ref.dims
    const ix0 = Math.max(0, Math.min(lo.ix, hi.ix))
    const iy0 = Math.max(0, Math.min(lo.iy, hi.iy))
    const iz0 = Math.max(0, Math.min(lo.iz, hi.iz))
    const ix1 = Math.min(nx - 1, Math.max(lo.ix, hi.ix))
    const iy1 = Math.min(ny - 1, Math.max(lo.iy, hi.iy))
    const iz1 = Math.min(nz - 1, Math.max(lo.iz, hi.iz))
    const tprof = toolProfile(tool)
    for (let iz = iz0; iz <= iz1; iz++) {
      for (let iy = iy0; iy <= iy1; iy++) {
        for (let ix = ix0; ix <= ix1; ix++) {
          const c = ref.voxelCenterWorld(ix, iy, iz)
          if (
            c.x < min.x || c.x > max.x ||
            c.y < min.y || c.y > max.y ||
            c.z < min.z || c.z > max.z
          ) {
            continue
          }
          const cur = ref.get(ix, iy, iz)
          // Mirror the Opt-2 early-out: saturated air is a no-op, skipped, and
          // excluded from the dirty union. Uses satAir = fround(-band) so it
          // tightens identically to production.
          if (cur === satAir) continue
          // Inline toolSdf math (inside-positive), negate to subtract.
          const dx = c.x - tx
          const dy = c.y - ty
          const dd = Math.sqrt(dx * dx + dy * dy)
          const aHt = c.z - (tz + tprof(Math.min(dd, R)))
          const bIn = R - dd
          const removed = -Math.min(aHt, bIn)
          const next = clampLocal(Math.min(cur, removed), -band, band)
          // Mirror Opt 1: every non-saturated written cell joins the dirty union,
          // regardless of whether the stored value changes.
          ref.data[ref.idx(ix, iy, iz)] = next
          ref.markDirty(ix, iy, iz, ix, iy, iz)
        }
      }
    }
  }
  const naiveSweep = (
    from: { x: number; y: number; z: number },
    to: { x: number; y: number; z: number },
  ) => {
    const dx = to.x - from.x
    const dy = to.y - from.y
    const dz = to.z - from.z
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz)
    const maxStep = 0.5 * ref.dims.voxelSize
    const steps = Math.max(1, Math.ceil(len / maxStep))
    for (let i = 0; i <= steps; i++) {
      const u = i / steps
      naiveCarvePoint(from.x + dx * u, from.y + dy * u, from.z + dz * u)
    }
  }
  naiveCarvePoint(ax, ay, cutZ)
  ref.clearDirty()
  naiveSweep({ x: ax, y: ay, z: cutZ }, { x: toX, y: ay, z: cutZ })

  it('field.data is byte-identical to the brute-force reference', () => {
    // Float32Array exact equality across the whole field.
    expect(f.data).toEqual(ref.data)
  })

  it('cleared column is air (= reference); untouched solid is at +band; a boundary voxel matches', () => {
    // On-axis above the cut -> cleared air (negative). The flat-mill SDF here is
    // min(heightAboveBottom, R - d); on the axis d=0 so it saturates at -R (R=2,
    // < band=3), NOT -band. Assert air + exact match to the brute-force reference.
    const cleared = f.get(15, 20, 35)
    expect(cleared).toBeLessThan(0)
    expect(cleared).toBe(-R)
    expect(cleared).toBe(ref.get(15, 20, 35))
    // Deep interior, far from all six faces AND outside the cut -> solid at
    // +band. Index (20,20,20): center (20.5,20.5,20.5) is >=band from every face;
    // it is below the cut (z=20.5 < cutZ=30) and d from the axis is 5 > R -> never
    // carved -> saturated solid.
    expect(f.get(20, 20, 20)).toBe(band)
    // A specific boundary voxel: just outside the radial wall at cut height stays
    // solid (positive), and equals the reference exactly.
    const bx = f.get(18 + R + 1, 20, 35) // beyond the swept end + radius
    expect(bx).toBeGreaterThan(0)
    expect(bx).toBe(ref.get(18 + R + 1, 20, 35))
  })

  it('dirty box equals the TIGHT union of voxels actually written by the sweep', () => {
    // The optimized sweep dirty box must equal the reference (change-only) union,
    // NOT a box inflated by revisited saturated cells.
    expect(f.dirty).toEqual(ref.dirty)
    expect(f.dirty).not.toBeNull()
  })
})

describe('column HIGH-WATER-MARK (HWM) carve equivalence + restore lifecycle', () => {
  // Exercises the new per-column HWM skip + the satAir (fround(-band)) early-out.
  // Uses a BALL mill with R > band so air voxels high in the central column truly
  // SATURATE to satAir(-band) (the on-axis SDF reaches -R, clamped to -band), and
  // the HWM caps the scan there. A flat R<band tool would only reach -R and never
  // produce satAir, so it would not exercise the new code.
  const band = 3
  const N = 41
  const R = 5 // R > band (=3): central column genuinely saturates to -band.
  const tool = ball(R)
  const satAir = Math.fround(-band)

  // Full-height brute-force reference carve (NO HWM cap). Scans the FULL iz range
  // [iz0..iz1] for each tool position, mirroring the satAir early-out and the
  // written-bbox dirty semantics exactly. This is the byte-identity oracle.
  const refCarvePoint = (rf: VoxelField, tx: number, ty: number, tz: number) => {
    const { z0, voxelSize, nz } = rf.dims
    const fieldTopZ = z0 + nz * voxelSize
    const min = { x: tx - R - band, y: ty - R - band, z: tz - band }
    const max = { x: tx + R + band, y: ty + R + band, z: fieldTopZ + band }
    const lo = rf.worldToVoxel(min.x, min.y, min.z)
    const hi = rf.worldToVoxel(max.x, max.y, max.z)
    const { nx, ny } = rf.dims
    const ix0 = Math.max(0, Math.min(lo.ix, hi.ix))
    const iy0 = Math.max(0, Math.min(lo.iy, hi.iy))
    const iz0 = Math.max(0, Math.min(lo.iz, hi.iz))
    const ix1 = Math.min(nx - 1, Math.max(lo.ix, hi.ix))
    const iy1 = Math.min(ny - 1, Math.max(lo.iy, hi.iy))
    const iz1 = Math.min(nz - 1, Math.max(lo.iz, hi.iz))
    const tprof = toolProfile(tool)
    const clampLocal = (v: number, l: number, h: number) =>
      v < l ? l : v > h ? h : v
    // FULL iz range, no HWM cap.
    for (let iz = iz0; iz <= iz1; iz++) {
      for (let iy = iy0; iy <= iy1; iy++) {
        for (let ix = ix0; ix <= ix1; ix++) {
          const cur = rf.get(ix, iy, iz)
          if (cur === satAir) continue
          const c = rf.voxelCenterWorld(ix, iy, iz)
          if (
            c.x < min.x || c.x > max.x ||
            c.y < min.y || c.y > max.y ||
            c.z < min.z || c.z > max.z
          ) {
            continue
          }
          const dx = c.x - tx
          const dy = c.y - ty
          const dd = Math.sqrt(dx * dx + dy * dy)
          const aHt = c.z - (tz + tprof(Math.min(dd, R)))
          const bIn = R - dd
          const removed = -Math.min(aHt, bIn)
          rf.data[rf.idx(ix, iy, iz)] = clampLocal(Math.min(cur, removed), -band, band)
        }
      }
    }
  }
  const refSweep = (
    rf: VoxelField,
    from: { x: number; y: number; z: number },
    to: { x: number; y: number; z: number },
  ) => {
    const dx = to.x - from.x
    const dy = to.y - from.y
    const dz = to.z - from.z
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz)
    const maxStep = 0.5 * rf.dims.voxelSize
    const steps = Math.max(1, Math.ceil(len / maxStep))
    for (let i = 0; i <= steps; i++) {
      const u = i / steps
      refCarvePoint(rf, from.x + dx * u, from.y + dy * u, from.z + dz * u)
    }
  }

  it('byte-identical to a full-height brute force after an overlapping multi-pass carve', () => {
    const f = new VoxelField(makeDims(N, N, N, 1))
    initSolidStock(f, band)
    const ref = new VoxelField(makeDims(N, N, N, 1))
    initSolidStock(ref, band)

    const ax = f.voxelCenterWorld(20, 20, 0).x
    const ay = f.voxelCenterWorld(20, 20, 0).y
    const baseline = f.snapshot()

    // Pass 1: a deep plunge at the column center (saturates the top to satAir).
    carvePoint(f, ax, ay, 24, tool, band)
    refCarvePoint(ref, ax, ay, 24)
    // Pass 2: a short SELF-OVERLAPPING sweep at the SAME depth, revisiting the
    // already-saturated column tops (HWM skip is active on the revisit).
    const toX = f.voxelCenterWorld(23, 20, 0).x
    carveSweep(f, { x: ax, y: ay, z: 24 }, { x: toX, y: ay, z: 24 }, tool, band)
    refSweep(ref, { x: ax, y: ay, z: 24 }, { x: toX, y: ay, z: 24 })
    // Pass 3: a DEEPER plunge at the center (drops material further; tops already
    // saturated -> HWM caps the scan well below nz-1).
    carvePoint(f, ax, ay, 18, tool, band)
    refCarvePoint(ref, ax, ay, 18)

    // The on-axis high column really did saturate to satAir (proves R>band path).
    expect(f.get(20, 20, 38)).toBe(satAir)
    // Byte-identical to the full-height brute force.
    expect(f.data).toEqual(ref.data)

    // Dirty box COVERS every voxel that changed vs the pre-carve baseline.
    const d = f.dirty
    expect(d).not.toBeNull()
    for (let iz = 0; iz < N; iz++) {
      for (let iy = 0; iy < N; iy++) {
        for (let ix = 0; ix < N; ix++) {
          const i = f.idx(ix, iy, iz)
          if (f.data[i] !== baseline[i]) {
            expect(ix).toBeGreaterThanOrEqual(d!.ix0)
            expect(ix).toBeLessThanOrEqual(d!.ix1)
            expect(iy).toBeGreaterThanOrEqual(d!.iy0)
            expect(iy).toBeLessThanOrEqual(d!.iy1)
            expect(iz).toBeGreaterThanOrEqual(d!.iz0)
            expect(iz).toBeLessThanOrEqual(d!.iz1)
          }
        }
      }
    }
  })

  it('restore re-establishes the HWM so a later deeper re-carve is byte-identical (seek-backward path)', () => {
    const f = new VoxelField(makeDims(N, N, N, 1))
    initSolidStock(f, band)

    const ax = f.voxelCenterWorld(20, 20, 0).x
    const ay = f.voxelCenterWorld(20, 20, 0).y

    // Carve some, then SNAPSHOT (this is the seek-backward baseline).
    carvePoint(f, ax, ay, 26, tool, band)
    const snap = f.snapshot()

    // Carve MORE (drops columnTop further) so the HWM is now low.
    carvePoint(f, ax, ay, 20, tool, band)
    carveSweep(f, { x: ax, y: ay, z: 20 }, { x: f.voxelCenterWorld(24, 20, 0).x, y: ay, z: 20 }, tool, band)

    // RESTORE the snapshot (SimulationPanel seek-backward). This MUST re-establish
    // the HWM conservatively (all solid) or the next carve would skip now-solid
    // voxels above the stale low columnTop.
    f.restore(snap)

    // Re-carve a DIFFERENT, DEEPER pass from the restored state.
    carvePoint(f, ax, ay, 14, tool, band)
    carveSweep(f, { x: ax, y: ay, z: 14 }, { x: f.voxelCenterWorld(26, 20, 0).x, y: ay, z: 14 }, tool, band)

    // Fresh brute force starting from the SAME restored snapshot, no HWM.
    const ref = new VoxelField(makeDims(N, N, N, 1))
    ref.restore(snap) // copy the exact restored state
    refCarvePoint(ref, ax, ay, 14)
    refSweep(ref, { x: ax, y: ay, z: 14 }, { x: ref.voxelCenterWorld(26, 20, 0).x, y: ay, z: 14 })

    // Byte-identical: restore did NOT cause the HWM to skip now-solid voxels.
    expect(f.data).toEqual(ref.data)
  })
})

describe('HWM tight-box safety: interior voids must not corrupt the column top', () => {
  // Two interior spheres STACKED in the same column, each carved via csgSubtract
  // with a TIGHT z-AABB that stops BELOW the column's solid top. The LOW void is
  // carved first; a naive HWM update would then lower columnTop to the low void's
  // local top, and the SECOND (higher) void would be SKIPPED above it -> field
  // NOT byte-identical. This guards the update rule: only lower the HWM when the
  // scan actually reached the column's old top (izTop >= colTopOld). carvePoint
  // never hits this (it always uses a full-height AABB), but csgSubtract is a
  // general primitive (the undercut test calls it directly), so the contract must
  // hold for any bounded caller. Oracle = production logic MINUS the HWM.
  const band = 3
  const N = 21

  const sphereSdf =
    (cx: number, cy: number, cz: number, r: number) =>
    (x: number, y: number, z: number) => {
      const dx = x - cx, dy = y - cy, dz = z - cz
      return r - Math.sqrt(dx * dx + dy * dy + dz * dz)
    }

  // Brute-force csgSubtract: production logic MINUS the HWM (full AABB iz range).
  const refSubtract = (
    rf: VoxelField,
    sdf: (x: number, y: number, z: number) => number,
    min: { x: number; y: number; z: number },
    max: { x: number; y: number; z: number },
  ) => {
    const satAir = Math.fround(-band)
    const lo = rf.worldToVoxel(min.x, min.y, min.z)
    const hi = rf.worldToVoxel(max.x, max.y, max.z)
    const { nx, ny, nz } = rf.dims
    const ix0 = Math.max(0, Math.min(lo.ix, hi.ix))
    const iy0 = Math.max(0, Math.min(lo.iy, hi.iy))
    const iz0 = Math.max(0, Math.min(lo.iz, hi.iz))
    const ix1 = Math.min(nx - 1, Math.max(lo.ix, hi.ix))
    const iy1 = Math.min(ny - 1, Math.max(lo.iy, hi.iy))
    const iz1 = Math.min(nz - 1, Math.max(lo.iz, hi.iz))
    const clampLocal = (v: number, l: number, h: number) => (v < l ? l : v > h ? h : v)
    // FULL AABB iz range, no HWM cap — the byte-identity oracle.
    for (let iz = iz0; iz <= iz1; iz++) {
      for (let iy = iy0; iy <= iy1; iy++) {
        for (let ix = ix0; ix <= ix1; ix++) {
          const cur = rf.get(ix, iy, iz)
          if (cur === satAir) continue
          const c = rf.voxelCenterWorld(ix, iy, iz)
          if (c.x < min.x || c.x > max.x || c.y < min.y || c.y > max.y || c.z < min.z || c.z > max.z) {
            continue
          }
          const removed = -sdf(c.x, c.y, c.z)
          rf.data[rf.idx(ix, iy, iz)] = clampLocal(Math.min(cur, removed), -band, band)
        }
      }
    }
  }

  it('a high interior void carved after a low one is fully removed (byte-identical)', () => {
    const f = new VoxelField(makeDims(N, N, N, 1))
    initSolidStock(f, band)
    const ref = new VoxelField(makeDims(N, N, N, 1))
    initSolidStock(ref, band)

    const r = 3
    const lowC = f.voxelCenterWorld(10, 10, 5)
    const highC = f.voxelCenterWorld(10, 10, 15)
    const boxFor = (c: { x: number; y: number; z: number }) => ({
      min: { x: c.x - r - band, y: c.y - r - band, z: c.z - r - band },
      max: { x: c.x + r + band, y: c.y + r + band, z: c.z + r + band },
    })
    const lowBox = boxFor(lowC)
    const highBox = boxFor(highC)
    const lowSdf = sphereSdf(lowC.x, lowC.y, lowC.z, r)
    const highSdf = sphereSdf(highC.x, highC.y, highC.z, r)

    // LOW void first (tight AABB stops below the solid top), THEN the HIGH void.
    csgSubtract(f, lowSdf, lowBox.min, lowBox.max, band)
    csgSubtract(f, highSdf, highBox.min, highBox.max, band)
    // No-HWM oracle, same order.
    refSubtract(ref, lowSdf, lowBox.min, lowBox.max)
    refSubtract(ref, highSdf, highBox.min, highBox.max)

    // The HIGH void's interior (well above the low void's local top, where a
    // corrupted HWM would have stopped scanning) really was carved to air.
    expect(f.get(10, 10, 17)).toBeLessThan(0)
    expect(f.get(10, 10, 16)).toBeLessThan(0)
    // Byte-identical to the full-height brute force: the guard prevented the low
    // void from lowering columnTop and masking the high void.
    expect(f.data).toEqual(ref.data)
  })
})

describe('toolSdf sign convention', () => {
  it('positive inside the tool solid, negative outside, for a flat mill', () => {
    const t = flat(3)
    // Tip at origin. A point on the axis just above the tip and within radius -> inside.
    expect(toolSdf(0, 0, 1, 0, 0, 0, t)).toBeGreaterThan(0)
    // A point below the tip -> outside (a < 0).
    expect(toolSdf(0, 0, -1, 0, 0, 0, t)).toBeLessThan(0)
    // A point beyond the radius -> outside (b < 0).
    expect(toolSdf(5, 0, 1, 0, 0, 0, t)).toBeLessThan(0)
  })
})
