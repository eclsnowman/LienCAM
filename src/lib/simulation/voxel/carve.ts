// carve.ts — GL-FREE, pure-math 3D swept-volume CSG carve for the voxel stock
// simulation (ADR-0028, plan Item 3). NO Three.js, NO WebGL, NO DOM, NO React.
// Operates purely on a VoxelField (typed arrays).
//
// Field value convention (maintained here, defined by VoxelField):
//   value > 0  = inside remaining solid material
//   value < 0  = removed / air
//   value === 0 = on the surface
// interpreted as a clamped signed distance in mm (narrow band).
//
// CSG subtraction maintains that convention: removing material can only make a
// voxel MORE negative (air), never re-add solid.
//   f_new = clamp(min(f_old, -sdfInsidePositive(P)), -band, band)
// where sdfInsidePositive(P) > 0 inside the tool solid. Negating it makes the
// tool interior negative (air) and the tool exterior positive; min() keeps the
// already-removed material removed and carves wherever the tool reaches.

import { VoxelField, type StockBounds } from './VoxelField'
import {
  tipOffsetAtRadius,
  buildRadialLUT,
  evalRadialLUT,
  undercutSolidFor,
  undercutSignedDistance,
  type ToolProfile,
  type RadialLUT,
  type UndercutSolid,
} from '../../tool/toolProfile'

/**
 * Pure description of a tool as a solid of revolution about +z.
 * `radius` is the tool radius = diameter/2 (mm). The optional fields are only
 * consulted for the tool types that need them.
 *
 * `profile` (when present) is the prebuilt source-of-truth ToolProfile
 * (buildToolProfile, the same geometry the 2D diagram and 3D mesh read). When
 * set, the bottom-surface function is derived from it via tipOffsetAtRadius so
 * EVERY tool type — not just flat/ball/bull/v_bit — gets a real cutting shape in
 * the sim. When absent (e.g. a bare ToolShape built directly in a unit test), the
 * legacy per-type switch is used so the historical analytic formulas (and the
 * carve byte-equivalence tests built on them) stay intact.
 */
export interface ToolShape {
  type: string
  radius: number
  cornerRadius?: number
  angleFromAxisDeg?: number
  profile?: ToolProfile
}

/**
 * Return the tool's bottom-surface profile function: how much HIGHER than the
 * tip (lowest point) the tool's bottom surface sits at radial distance `d` from
 * the axis. The returned function clamps `d` to [0, radius] internally so it is
 * safe to call with any non-negative d (for d > radius the tool does not exist
 * there; callers should rely on the radial test in toolSdf to exclude it).
 *
 * Single source of truth: when the ToolShape carries a prebuilt `profile`
 * (buildToolProfile — the SAME geometry the 2D diagram and 3D mesh use), the
 * bottom surface is derived from it via tipOffsetAtRadius, so all 18 tool types
 * carve a real shape. tipOffsetAtRadius reproduces the classic analytic formulas
 * (flat=0, ball=R-sqrt(R^2-d^2), cone=(d-tipR)/tan a) exactly because those ARE
 * the lower boundary of buildToolProfile.
 *
 * NOTE: this bottom surface is only the whole story for profiles that never
 * narrow going up. Undercut profiles (lollipop / dovetail / disc / thread teeth)
 * carve through the bounded undercut solid instead (toolSdfUndercut, WO-1383).
 *
 * Legacy fallback (no `profile` set — e.g. a bare ToolShape in a unit test):
 *   flat_end_mill:  () => 0
 *   ball_end_mill:  d => R - sqrt(max(0, R*R - d*d))
 *   bull_nose:      d => d<=flat ? 0 : r - sqrt(max(0, r*r - (d-flat)^2)),  flat = R - r
 *   v_bit/chamfer:  d => d / tan(half),  half = angleFromAxisDeg (radians)
 *   default/drill:  treated as flat
 * Pure: depends only on `t`.
 */
// Memo of "is this profile's bottom surface a constant zero (flat-bottomed)?"
// keyed by the ToolProfile object. buildToolProfile creates ONE profile object
// per tool/op (toolShapeFromTool) and reuses it across every carve position in a
// sweep, so this samples the bottom surface ONCE per profile, never per voxel and
// never per carve step. A WeakMap keeps the optimization fully inside the sim
// carve layer (no field added to the shared ToolProfile source-of-truth type) and
// lets retired profiles be garbage-collected with their tools.
const flatBottomProfileMemo = new WeakMap<ToolProfile, boolean>()

/**
 * True when the profile's lower CUTTING boundary (tipOffsetAtRadius) is a constant
 * zero across [0, R] within a tight epsilon — i.e. a flat-bottomed tool. The lower
 * boundary is non-decreasing in radius for every cutting family, so a flat bottom
 * is identically 0 everywhere; the multi-sample loop is defensive and cheap.
 * Memoized per profile object so it runs once per tool/op, not per voxel.
 */
export function isFlatBottomProfile(profile: ToolProfile, R: number): boolean {
  const cached = flatBottomProfileMemo.get(profile)
  if (cached !== undefined) return cached
  const EPS = 1e-9
  const SAMPLES = 8
  let flat = true
  for (let i = 0; i <= SAMPLES; i++) {
    const d = (R * i) / SAMPLES
    if (Math.abs(tipOffsetAtRadius(profile, Math.min(d, R))) > EPS) {
      flat = false
      break
    }
  }
  flatBottomProfileMemo.set(profile, flat)
  return flat
}

// Memo of the precomputed radial LUT (toolProfile.ts's buildRadialLUT) per
// profile object. Same lifecycle argument as flatBottomProfileMemo: one
// ToolProfile object is built per tool/op and reused across every carve
// position in a sweep, so the LUT is built ONCE per profile, never per voxel.
const radialLUTMemo = new WeakMap<ToolProfile, RadialLUT>()

function getRadialLUT(profile: ToolProfile): RadialLUT {
  let lut = radialLUTMemo.get(profile)
  if (lut === undefined) {
    lut = buildRadialLUT(profile)
    radialLUTMemo.set(profile, lut)
  }
  return lut
}

export function toolProfile(t: ToolShape): (d: number) => number {
  const R = t.radius
  if (t.profile) {
    const profile = t.profile
    // Fast path (perf, BYTE-IDENTICAL): when the profile's bottom surface is a
    // constant zero (a flat-bottomed tool — flat/face/reamer/boring/tap, a
    // pitchless thread-mill cylinder, drill-as-flat fallback, etc.) the generic
    // tipOffsetAtRadius wrapper returns 0 at every radius. Returning the inlinable
    // `() => 0` closure instead removes a non-inlinable per-voxel call: the CPU
    // profile measured the wrapper at 2.40x of a flat tool's carve time
    // (529.9us -> 220.4us per cut) with 0 of 6.5M voxels differing. The flatness
    // test is memoized per profile object (isFlatBottomProfile), so it runs ONCE
    // per tool/op, never in the per-voxel hot loop.
    if (isFlatBottomProfile(profile, R)) {
      return () => 0
    }
    // Shaped tools (perf, BYTE-IDENTICAL, PERF-RECON finding #2): the generic
    // tipOffsetAtRadius wrapper re-walks the full profile.vertices list on
    // EVERY per-voxel call (a full maxR scan plus a partial bracket search) —
    // measured ~11x a flat tool's carve cost for ball/bull-nose profiles. The
    // radial LUT (toolProfile.ts) precomputes the profile's bracket segments
    // ONCE per profile (memoized here) and the per-voxel closure below does a
    // binary search instead of re-deriving the segment list from scratch, with
    // the SAME clamp/bracket/interpolation arithmetic tipOffsetAtRadius uses —
    // bit-for-bit identical output, proven in src/tests/tool/radialLUT.test.ts
    // and src/tests/simulation/voxel/radialLutCarve.test.ts.
    const lut = getRadialLUT(profile)
    return (d) => evalRadialLUT(lut, Math.min(d, R))
  }
  switch (t.type) {
    case 'flat_end_mill':
      return () => 0
    case 'ball_end_mill':
      return (d) => {
        const dd = clamp(d, 0, R)
        return R - Math.sqrt(Math.max(0, R * R - dd * dd))
      }
    case 'bull_nose': {
      const r = t.cornerRadius ?? 0
      if (r <= 0) return () => 0
      const flat = R - r
      return (d) => {
        const dd = clamp(d, 0, R)
        if (dd <= flat) return 0
        const dr = dd - flat
        return r - Math.sqrt(Math.max(0, r * r - dr * dr))
      }
    }
    case 'v_bit':
    case 'chamfer': {
      // Contract: angleFromAxisDeg is already the per-side half-angle (no halving).
      const half = (t.angleFromAxisDeg ?? 59) * (Math.PI / 180)
      const tanHalf = Math.tan(half)
      return (d) => clamp(d, 0, R) / tanHalf
    }
    default:
      // drill / unknown -> treated as flat for now.
      return () => 0
  }
}

/**
 * Inside-positive APPROXIMATE signed distance (mm) from world point (px,py,pz)
 * to the tool solid, with the tool tip (lowest point) at world (tx,ty,tz) and
 * its axis along +z.
 *
 * Construction (per contract): with d = radial distance from the axis,
 *   a = z - (tz + profile(clamp(d, 0, R)))   // signed height above the bottom surface
 *   b = R - d                                 // signed inset from the cylindrical wall
 *   return min(a, b)
 * Positive => inside the tool solid, negative => outside. The zero-crossing is
 * exact (the boundary of the half-space intersection); the magnitude is an
 * approximation, which is acceptable for a narrow-band field.
 */
export function toolSdf(
  px: number,
  py: number,
  pz: number,
  tx: number,
  ty: number,
  tz: number,
  t: ToolShape,
): number {
  if (t.profile) {
    const solid = undercutSolidFor(t.profile, t.radius)
    if (solid !== null) return toolSdfUndercut(px, py, pz, tx, ty, tz, solid)
  }
  const profile = toolProfile(t)
  return toolSdfWithProfile(px, py, pz, tx, ty, tz, t.radius, profile)
}

/**
 * Tool SDF for an undercut profile (WO-1383): the tool's real section, bounded
 * above as well as below at each radius, so a lollipop never removes the
 * overhang above its head. `solid` comes from undercutSolidFor(profile, R).
 */
export function toolSdfUndercut(
  px: number,
  py: number,
  pz: number,
  tx: number,
  ty: number,
  tz: number,
  solid: UndercutSolid,
): number {
  const dx = px - tx
  const dy = py - ty
  return undercutSignedDistance(solid, Math.sqrt(dx * dx + dy * dy), pz - tz)
}

/**
 * Same math as toolSdf but with the radial profile function HOISTED in by the
 * caller, so the per-voxel hot path never rebuilds the profile closure (Opt 3).
 * `R` is the tool radius; `profile` is the result of toolProfile(t) for the same
 * tool. Byte-identical to toolSdf for matching (R, profile).
 */
export function toolSdfWithProfile(
  px: number,
  py: number,
  pz: number,
  tx: number,
  ty: number,
  tz: number,
  R: number,
  profile: (d: number) => number,
): number {
  const dx = px - tx
  const dy = py - ty
  const d = Math.sqrt(dx * dx + dy * dy)
  const a = pz - (tz + profile(Math.min(d, R)))
  const b = R - d
  return Math.min(a, b)
}

/**
 * Generic CSG subtraction primitive — the single shared carve core.
 *
 * For every voxel whose center lies inside the world AABB [min, max], compute
 *   f_new = clamp(min(field.get, -sdfInsidePositive(center)), -band, band)
 * and store it. Voxels whose index falls outside the grid are skipped.
 *
 * `sdfInsidePositive` returns > 0 inside the solid being removed.
 *
 * Perf (ADR-0028, byte-identical to the naive field.set() loop):
 *  - Opt 1: write field.data directly inline and call field.markDirty() ONCE for
 *    the union bbox of voxels ACTUALLY written, instead of per-voxel.
 *  - Opt 2: early-out on saturated-air voxels (cur === satAir): min(satAir, x)
 *    clamps back to satAir, a no-op write, so they are skipped and excluded from
 *    the written bbox (tighter but still exactly the union of changed cells).
 *    NOTE: satAir = Math.fround(-band). Comparing against the f64 literal -band
 *    never fired (band is f64, e.g. 0.762, but cur is the f32-rounded store),
 *    so this early-out was DEAD; fround makes it actually trigger.
 *  - HWM (column high-water-mark): scan each (ix,iy) column COLUMN-MAJOR and cap
 *    the iz range at field.columnTop[col] + MARGIN. Every voxel above columnTop
 *    is provably saturated air (a permanent no-op), so skipping it is byte-safe.
 *    The HWM only ever REDUCES the iz scan range (izTop <= iz1), never expands
 *    it, so it is universally safe (including the undercut sphere test, whose
 *    tight iz1 sits below columnTop -> izTop == iz1 -> no behavior change).
 *
 * Byte-identity holds regardless of loop order: each voxel's written value
 * depends only on (cur, sdf at that voxel) — order-independent — and the dirty
 * box is a union — order-independent. So the column-major restructure is safe.
 */
export function csgSubtract(
  field: VoxelField,
  sdfInsidePositive: (x: number, y: number, z: number) => number,
  min: { x: number; y: number; z: number },
  max: { x: number; y: number; z: number },
  band: number,
): void {
  // Map the world AABB to an inclusive voxel-index box. worldToVoxel floors to
  // the containing cell; expand the high corner by one cell so a center sitting
  // just inside `max` is not dropped by flooring, then clamp to the grid.
  const lo = field.worldToVoxel(min.x, min.y, min.z)
  const hi = field.worldToVoxel(max.x, max.y, max.z)

  const { nx, ny, nz, voxelSize, x0, y0, z0 } = field.dims
  const ix0 = Math.max(0, Math.min(lo.ix, hi.ix))
  const iy0 = Math.max(0, Math.min(lo.iy, hi.iy))
  const iz0 = Math.max(0, Math.min(lo.iz, hi.iz))
  const ix1 = Math.min(nx - 1, Math.max(lo.ix, hi.ix))
  const iy1 = Math.min(ny - 1, Math.max(lo.iy, hi.iy))
  const iz1 = Math.min(nz - 1, Math.max(lo.iz, hi.iz))

  // Saturated-air value as actually STORED in the f32 field. The early-out and
  // the HWM both pivot on this exact value; comparing the raw f64 -band never
  // matches a stored f32 cell, so we round it the same way the store does.
  const satAir = Math.fround(-band)
  // Defense-in-depth margin (in voxels) so any off-by-one in the HWM cannot skip
  // a real band/solid voxel. Band-width voxels are already <= columnTop by the
  // invariant; extra scanned voxels above the true top are satAir no-ops, so a
  // larger margin can never break byte-identity — keep it small for speed.
  const MARGIN = Math.ceil(band / voxelSize) + 1

  const columnTop = field.columnTop

  // Inline / no-alloc hoists (BYTE-IDENTICAL to voxelCenterWorld / idx / clamp).
  // The CPU profile showed ~17% of carve time in per-voxel call+alloc overhead:
  // field.idx() (a method call), field.voxelCenterWorld() (which ALLOCATES a
  // {x,y,z} object -> GC), and the module-level clamp() call. We pull field.data
  // and the grid origin into locals, precompute the z-stride nxny = nx*ny, and
  // compute the voxel center inline. cx/cy and their x/y AABB membership are
  // CONSTANT within a column, so they are hoisted to the column level; only cz and
  // the flat index advance per iz. Every expression is identical to the helpers it
  // replaces (same operands, no float reordering), so the stored field is
  // byte-identical — the brute-force oracle test proves it. min() stays Math.min
  // (already a fast intrinsic; a ternary would change NaN/-0 semantics); clamp is
  // inlined as the exact same ternary the clamp() helper uses.
  const data = field.data
  const nxny = nx * ny
  const minx = min.x, maxx = max.x
  const miny = min.y, maxy = max.y
  const minz = min.z, maxz = max.z

  // Accumulate the bbox of voxels ACTUALLY written, in local ints. Sentinels:
  // lo init to +Inf, hi init to -Inf so the first write seeds the box.
  let wix0 = Infinity
  let wiy0 = Infinity
  let wiz0 = Infinity
  let wix1 = -Infinity
  let wiy1 = -Infinity
  let wiz1 = -Infinity

  // COLUMN-MAJOR so each (ix,iy) column can cap its iz scan at the HWM.
  for (let iy = iy0; iy <= iy1; iy++) {
    const cyv = y0 + (iy + 0.5) * voxelSize
    const inY = cyv >= miny && cyv <= maxy
    for (let ix = ix0; ix <= ix1; ix++) {
      const cxv = x0 + (ix + 0.5) * voxelSize
      // x/y AABB membership is column-constant (cx,cy don't vary with iz).
      const inXY = inY && cxv >= minx && cxv <= maxx
      const col = iy * nx + ix
      const colTopOld = columnTop[col]
      // Never scan above the column high-water-mark (+ a small safety margin).
      // Everything above colTopOld is provably saturated air, hence a no-op.
      const izTop = Math.min(iz1, colTopOld + MARGIN)

      // Highest iz in this column that is NOT saturated air after this carve;
      // -1 means the whole scanned range ended up (or already was) saturated air.
      let lastNonAir = -1

      // Flat index of (ix,iy,iz0); advances by nxny per iz (== field.idx). The
      // increment is in the for-update clause so `continue` still advances it.
      let i = iz0 * nxny + col
      for (let iz = iz0; iz <= izTop; iz++, i += nxny) {
        const cur = data[i]
        // Saturated air: no-op write, does NOT update lastNonAir, does NOT grow
        // the dirty box. (Now actually fires thanks to satAir = fround(-band).)
        if (cur === satAir) {
          continue
        }
        if (!inXY) {
          // Outside the AABB in x/y: still non-air (retained), counts toward the
          // column top. NOT written, does NOT grow the dirty box (prior behavior).
          lastNonAir = iz
          continue
        }
        const czv = z0 + (iz + 0.5) * voxelSize
        if (czv < minz || czv > maxz) {
          // Outside the AABB in z: same handling as the x/y-outside case.
          lastNonAir = iz
          continue
        }
        const removed = -sdfInsidePositive(cxv, cyv, czv)
        // min then clamp, inlined byte-identically (clamp(v,-band,band)).
        let nv = Math.min(cur, removed)
        nv = nv < -band ? -band : nv > band ? band : nv
        // Inline the data write and grow the written-bbox; one markDirty after the
        // loop. Every non-satAir written cell joins the union (prior behavior).
        data[i] = nv
        if (ix < wix0) wix0 = ix
        if (iy < wiy0) wiy0 = iy
        if (iz < wiz0) wiz0 = iz
        if (ix > wix1) wix1 = ix
        if (iy > wiy1) wiy1 = iy
        if (iz > wiz1) wiz1 = iz
        if (nv !== satAir) lastNonAir = iz
      }

      // Update the HWM, but ONLY when this scan actually reached the column's old
      // top (izTop >= colTopOld). In that case everything above izTop is provably
      // saturated air (HWM guarantee) and the whole column above iz0 is now known,
      // so the new top is lastNonAir (or, if the scanned range is entirely air,
      // the true top is below iz0 -> iz0-1 is a valid >=0 upper bound). This only
      // LOWERS columnTop, preserving the invariant.
      //
      // When izTop < colTopOld (a caller passed a tight z-AABB that stops BELOW
      // the column's solid top, e.g. an interior-void csgSubtract), the region
      // (izTop, colTopOld] was NOT scanned and may still be solid, so we must NOT
      // lower the top from this partial scan — leave columnTop at colTopOld
      // (stale-high is always byte-safe; it just costs extra no-op scans later).
      // carvePoint always uses a full-height AABB (iz1 = nz-1 >= colTopOld), so
      // this guard is always true on the production path and is byte-inert there.
      if (izTop >= colTopOld) {
        columnTop[col] = lastNonAir >= 0 ? lastNonAir : Math.max(0, iz0 - 1)
      }
    }
  }

  // Opt 1: a single markDirty over the union of written voxels (only if any).
  if (wix1 >= wix0) {
    field.markDirty(wix0, wiy0, wiz0, wix1, wiy1, wiz1)
  }
}

/**
 * Carve one tool position. Computes the tool's world AABB (radius in xy; z from
 * the tip tz upward to the top of the field, plus a one-band margin so the
 * narrow band around the cut boundary is refreshed) and runs csgSubtract with
 * toolSdf.
 */
export function carvePoint(
  field: VoxelField,
  tx: number,
  ty: number,
  tz: number,
  t: ToolShape,
  band: number,
): void {
  const R = t.radius
  const { z0, voxelSize, nz } = field.dims
  const fieldTopZ = z0 + nz * voxelSize

  const min = {
    x: tx - R - band,
    y: ty - R - band,
    // The tip is the lowest point; extend a band below so the boundary band
    // just under the cut is also refreshed.
    z: tz - band,
  }
  const max = {
    x: tx + R + band,
    y: ty + R + band,
    // The tool extends upward indefinitely (a cutter shank); cap at the field
    // top plus a band margin so we cover every voxel the tool can reach.
    z: fieldTopZ + band,
  }
  // Undercut profiles carve their bounded section (WO-1383); every other profile
  // keeps the bottom-surface path below unchanged.
  const solid = t.profile ? undercutSolidFor(t.profile, R) : null
  if (solid !== null) {
    csgSubtract(field, (x, y, z) => toolSdfUndercut(x, y, z, tx, ty, tz, solid), min, max, band)
    return
  }
  // Opt 3: build the radial profile closure ONCE per tool position, not once
  // per voxel. The per-voxel SDF then uses the hoisted profile (byte-identical
  // math to toolSdf, which would otherwise rebuild this closure every call).
  const profile = toolProfile(t)
  csgSubtract(
    field,
    (x, y, z) => toolSdfWithProfile(x, y, z, tx, ty, tz, R, profile),
    min,
    max,
    band,
  )
}

/**
 * Sweep the tool tip from `from` to `to`, carving at evenly spaced positions no
 * farther apart than half a voxel so the swept volume has no un-carved gaps
 * between step positions.
 */
export function carveSweep(
  field: VoxelField,
  from: { x: number; y: number; z: number },
  to: { x: number; y: number; z: number },
  t: ToolShape,
  band: number,
): void {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const dz = to.z - from.z
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz)
  const maxStep = 0.5 * field.dims.voxelSize
  // At least one carve (the endpoint) even for a zero-length move.
  const steps = Math.max(1, Math.ceil(len / maxStep))
  for (let i = 0; i <= steps; i++) {
    const u = i / steps
    carvePoint(field, from.x + dx * u, from.y + dy * u, from.z + dz * u, t, band)
  }
}

/**
 * Initialize the field as SOLID stock: every voxel center is set to its
 * signed distance to the nearest of the six NOMINAL stock faces, clamped to
 * [-band, band]. Interiors are positive (solid), the narrow band tapers to
 * ~0 at the nominal faces, and samples outside the nominal bounds (grid
 * padding from `planVoxelGrid`'s per-axis ceil) are negative (air). Marks the
 * whole field dirty.
 *
 * `bounds` is the nominal stock AABB (pre-`planVoxelGrid` padding). When
 * omitted, falls back to the field's own (rounded-up) AABB — this is the
 * exact-divide case where the two coincide, and what every caller that
 * predates the nominal-bounds plumbing (WO-1532) still gets, byte-identical
 * (every voxel center is then guaranteed non-negative, so the wider clamp
 * floor never changes the result).
 */
export function initSolidStock(field: VoxelField, band: number, bounds?: StockBounds): void {
  const { nx, ny, nz, voxelSize, x0, y0, z0 } = field.dims
  const fx1 = x0 + nx * voxelSize
  const fy1 = y0 + ny * voxelSize
  const fz1 = z0 + nz * voxelSize
  const bx0 = bounds ? bounds.x0 : x0
  const by0 = bounds ? bounds.y0 : y0
  const bz0 = bounds ? bounds.z0 : z0
  const bx1 = bounds ? bounds.x1 : fx1
  const by1 = bounds ? bounds.y1 : fy1
  const bz1 = bounds ? bounds.z1 : fz1
  for (let iz = 0; iz < nz; iz++) {
    for (let iy = 0; iy < ny; iy++) {
      for (let ix = 0; ix < nx; ix++) {
        const c = field.voxelCenterWorld(ix, iy, iz)
        const dist = Math.min(
          c.x - bx0,
          bx1 - c.x,
          c.y - by0,
          by1 - c.y,
          c.z - bz0,
          bz1 - c.z,
        )
        field.data[field.idx(ix, iy, iz)] = clamp(dist, -band, band)
      }
    }
  }
  // Conservatively re-establish the column high-water-mark at nz-1 for every
  // column (a loose/high HWM only costs extra no-op scans, never wrong
  // results — see resetColumnTopSolid). We wrote field.data directly
  // (bypassing reset), so this HWM update doesn't happen automatically; it is
  // needed regardless of whether a padded column's top sample came out solid
  // or air (WO-1532).
  field.resetColumnTopSolid()
  // One whole-field dirty mark (reset would overwrite our per-voxel values, so
  // mark via a full-extent set-equivalent: touch the corners through markDirty).
  field.markDirty(0, 0, 0, nx - 1, ny - 1, nz - 1)
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}
