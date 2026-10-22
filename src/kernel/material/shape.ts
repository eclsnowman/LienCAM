// WO-3017 MD-45: one tool-shape source. Every cutter model the material service
// needs is generated from the revolved tool profile (ADR-0030) the caller hands
// in: the drop-cutter spec, the sweep profile, the reach-trim bands and the
// simulation profile. Today each of these is built by its own code:
//   drop-cutter spec  src/cam3d/integration/cutterSpec.ts toolToCutterSpec
//   sweep profile     src/cam3d/stock/cutterProfile.ts sweepProfile / profileHeight
//   reach-trim bands  src/lib/cam/holderClearance.ts headBandsFor
//   simulation        src/lib/tool/toolProfile.ts tipOffsetAtRadius
// For flat and ball every form generated here equals what that code builds
// (motion-neutral). Capability and refusal lines are today's: a form this
// service generates for a tool today's code refuses is not offered.
import type {
  DropCutterSpec, Generated, ProfileVertex, ReachBand, RevolvedProfile, SweepShape, ToolShapeSource,
} from './contracts'

const ANALYTIC_FAMILIES = new Set(['flat', 'ball', 'bull', 'cone'])

function fail<T>(reason: string): Generated<T> {
  return { ok: false, reason }
}

/** Finite vertices. Today's builders can step back down (a ball whose flute is shorter
 * than its radius); the head run below stops there, as today's specs ignore it. */
function usable(profile: RevolvedProfile): boolean {
  const v = profile.vertices
  return v.length >= 2 && v.every(p => Number.isFinite(p.z) && Number.isFinite(p.r))
}

/**
 * The cutting head's leading run: vertices from the tip while the radius does
 * not shrink and z rises (a repeated point, such as the bull corner arc's first
 * point on the tip flat, is kept; a step out to a wider shank ends the run). Its
 * last vertex carries the full cutting radius exactly as the profile builder
 * stored it (flat/ball/bull/cone).
 */
function headRun(profile: RevolvedProfile): ProfileVertex[] {
  const v = profile.vertices
  const run = [v[0]]
  for (let i = 1; i < v.length; i++) {
    const a = v[i - 1], b = v[i]
    // Rounding noise (a bull arc's last point can land an ulp past R) is not a shrink.
    if (b.r < a.r - 1e-9 * Math.max(1, a.r) || b.z < a.z) break
    if (b.z === a.z && b.r - a.r > 1e-9 * Math.max(1, a.r)) break
    run.push(b)
  }
  return run
}

/** Height at which the head first reaches its full radius (bull corner, cone height). */
function fullRadiusHeight(run: readonly ProfileVertex[], radius: number): number {
  const eps = 1e-9 * Math.max(1, radius)
  for (const p of run) if (p.r >= radius - eps) return p.z
  return run[run.length - 1].z
}

// ── Drop-cutter spec ───────────────────────────────────────────────────────────

/**
 * The drop-cutter spec, from the profile. The capability table and every
 * refusal line are today's toolToCutterSpec: flat_end_mill, ball_end_mill,
 * bull_nose and v_bit only, with the same checks in the same order.
 */
export function dropCutterSpec(source: ToolShapeSource): Generated<DropCutterSpec> {
  const { tool, profile } = source
  const diameter = tool.diameter
  if (!(diameter > 0) || !Number.isFinite(diameter)) {
    return fail(`parallel_3d cannot use tool "${tool.name}": diameter must be a positive finite number (got ${diameter}).`)
  }
  switch (tool.type) {
    case 'flat_end_mill':
    case 'ball_end_mill':
    case 'bull_nose':
    case 'v_bit':
      break
    default:
      return fail(`parallel_3d does not yet support ${tool.type} cutters (tool "${tool.name}"). ` +
        `Use a flat, ball or bull-nose end mill, or a V-bit.`)
  }
  if (tool.type === 'bull_nose') {
    const cornerRadius = tool.cornerRadius
    if (cornerRadius === undefined || !(cornerRadius > 0) || !Number.isFinite(cornerRadius)) {
      return fail(`parallel_3d cannot use bull-nose tool "${tool.name}": it needs a positive cornerRadius ` +
        `(got ${cornerRadius}).`)
    }
    if (cornerRadius > diameter / 2 + 1e-9) {
      return fail(`parallel_3d cannot use bull-nose tool "${tool.name}": cornerRadius ${cornerRadius} exceeds ` +
        `the tool radius ${diameter / 2}.`)
    }
  }
  if (tool.type === 'v_bit') {
    const angleFromAxisDeg = tool.angleFromAxisDeg ?? 59
    if (!Number.isFinite(angleFromAxisDeg) || angleFromAxisDeg <= 0 || angleFromAxisDeg >= 90) {
      return fail(`3D operations cannot use V-bit "${tool.name}": its angle from the tool axis must be between 0 and ` +
        `90 degrees (got ${angleFromAxisDeg}).`)
    }
    const tipDiameter = tool.tipDiameter ?? 0
    if (!Number.isFinite(tipDiameter) || tipDiameter < 0 || tipDiameter >= diameter) {
      return fail(`3D operations cannot use V-bit "${tool.name}": its tip flat (${tipDiameter} mm) must be smaller ` +
        `than its diameter (${diameter} mm).`)
    }
  }
  if (!usable(profile)) return fail(`tool "${tool.name}" has no usable revolved profile.`)
  const run = headRun(profile)
  const radius = run[run.length - 1].r
  switch (tool.type) {
    case 'flat_end_mill':
      return { ok: true, value: { kind: 'flat', diameter: 2 * radius } }
    case 'ball_end_mill':
      return { ok: true, value: { kind: 'ball', diameter: 2 * radius } }
    case 'bull_nose':
      return { ok: true, value: { kind: 'bull', diameter: 2 * radius, cornerRadius: fullRadiusHeight(run, radius) } }
    default: {
      const tipRadius = run[0].r
      const coneHeight = fullRadiusHeight(run, radius)
      const angleFromAxisDeg = Math.atan2(radius - tipRadius, coneHeight) * 180 / Math.PI
      return { ok: true, value: tipRadius > 0
        ? { kind: 'vbit', diameter: 2 * radius, angleFromAxisDeg, tipDiameter: 2 * tipRadius }
        : { kind: 'vbit', diameter: 2 * radius, angleFromAxisDeg } }
    }
  }
}

// ── Sweep profile ──────────────────────────────────────────────────────────────

/**
 * The largest upward-open shape inside the profile: at height z its radius is
 * the narrowest the body gets anywhere at or above z (piecewise linear, so the
 * minimum sits on a vertex or a crossing). Between vertices it is the linear
 * radius or that suffix minimum, whichever is smaller, so it never exceeds
 * radiusAtZ: a sweep with it removes no more than the tool.
 */
function inscribedBoundary(profile: RevolvedProfile): { zs: number[]; rs: number[] } {
  const v = profile.vertices
  const suffix = new Array<number>(v.length)
  let min = Number.POSITIVE_INFINITY
  for (let i = v.length - 1; i >= 0; i--) { min = Math.min(min, v[i].r); suffix[i] = min }
  const zs = [v[0].z]
  const rs = [suffix[0]]
  const push = (z: number, r: number) => {
    if (z === zs[zs.length - 1]) { rs[rs.length - 1] = Math.max(rs[rs.length - 1], r); return }
    zs.push(z); rs.push(r)
  }
  for (let i = 0; i < v.length - 1; i++) {
    const a = v[i], b = v[i + 1]
    if (!(b.z > a.z)) continue
    const s = suffix[i + 1]
    if (b.r > a.r && a.r < s && b.r > s) push(a.z + (b.z - a.z) * ((s - a.r) / (b.r - a.r)), s)
    push(b.z, Math.min(b.r, s))
  }
  return { zs, rs }
}

/**
 * The sweep profile height(r) source. flat, ball, bull and cone are analytic,
 * their numbers read from the profile; flat and ball equal today's
 * sweepProfile(toolToCutterSpec(tool)). Any other family sweeps with its
 * inscribed upward-open shape and says so in one line.
 */
export function sweepShape(source: ToolShapeSource): Generated<SweepShape> {
  const { tool, profileKind, profile } = source
  if (!usable(profile)) return fail(`tool "${tool.name}" has no usable revolved profile to sweep.`)
  const run = headRun(profile)
  const radius = run[run.length - 1].r
  if (!(radius > 0)) return fail(`tool "${tool.name}" has no cutting radius to sweep.`)
  if (ANALYTIC_FAMILIES.has(profileKind)) {
    switch (profileKind) {
      case 'flat': return { ok: true, value: { kind: 'flat', radius } }
      case 'ball': return { ok: true, value: { kind: 'ball', radius } }
      case 'bull': return { ok: true, value: { kind: 'bull', radius, cornerRadius: fullRadiusHeight(run, radius) } }
      default: return { ok: true, value: { kind: 'cone', radius, tipRadius: run[0].r, coneHeight: fullRadiusHeight(run, radius) } }
    }
  }
  const { zs, rs } = inscribedBoundary(profile)
  const inner = rs[rs.length - 1]
  if (!(inner > 0)) return fail(`tool "${tool.name}" has no upward-open part to sweep.`)
  return { ok: true, value: {
    kind: 'inscribed', radius: inner, zs, rs,
    note: `${tool.name} (${tool.type}) swept as the largest upward-open shape inside its profile ` +
      `(radius ${inner.toFixed(3)} mm): it removes no more than the tool, so remaining stock is not under-stated.`,
  } }
}

/**
 * height(r) above the tip of the sweep shape's lowest surface; +Infinity past
 * its radius. flat and ball use today's profileHeight expressions verbatim.
 */
export function sweepHeight(shape: SweepShape, r: number): number {
  if (r > shape.radius) return Number.POSITIVE_INFINITY
  switch (shape.kind) {
    case 'flat': return 0
    case 'ball': {
      const s = shape.radius * shape.radius - r * r
      return shape.radius - Math.sqrt(s > 0 ? s : 0)
    }
    case 'bull': {
      const flat = shape.radius - shape.cornerRadius
      if (r <= flat) return 0
      const e = r - flat
      const s = shape.cornerRadius * shape.cornerRadius - e * e
      return shape.cornerRadius - Math.sqrt(s > 0 ? s : 0)
    }
    case 'cone': {
      if (r <= shape.tipRadius) return 0
      return (r - shape.tipRadius) * shape.coneHeight / (shape.radius - shape.tipRadius)
    }
    default: {
      const { zs, rs } = shape
      if (r <= rs[0]) return zs[0]
      for (let k = 0; k < rs.length - 1; k++) {
        if (r <= rs[k + 1]) return zs[k] + (zs[k + 1] - zs[k]) * ((r - rs[k]) / (rs[k + 1] - rs[k]))
      }
      return Number.POSITIVE_INFINITY
    }
  }
}

// ── Reach-trim bands ───────────────────────────────────────────────────────────

/**
 * The cutting head as stacked cylinders for the reach trim: today's
 * holderClearance headBandsFor, line for line, on the supplied profile.
 */
export function reachBands(profile: RevolvedProfile, toleranceMm: number, slackMm: number,
  maxBandHeightMm = Infinity): ReachBand[] {
  const bands: ReachBand[] = []
  const vertices = profile.vertices
  for (let i = 0; i < vertices.length - 1; i++) {
    const a = vertices[i]
    const b = vertices[i + 1]
    if (a.z >= profile.cuttingMaxZ - 1e-9) break
    if (!(b.z > a.z)) continue
    const top = Math.min(b.z, profile.cuttingMaxZ)
    const pieces = a.r === b.r ? 1 : Math.max(1, Math.ceil((top - a.z) / maxBandHeightMm - 1e-9))
    if (pieces === 1) {
      const radius = Math.max(a.r, b.r) - toleranceMm + slackMm
      if (radius > 0) bands.push({ bottom: a.z, top, radius })
      continue
    }
    const radiusAt = (z: number) => a.r + (b.r - a.r) * ((z - a.z) / (b.z - a.z))
    for (let p = 0; p < pieces; p++) {
      const z0 = p === 0 ? a.z : a.z + (top - a.z) * (p / pieces)
      const z1 = p === pieces - 1 ? top : a.z + (top - a.z) * ((p + 1) / pieces)
      const radius = Math.max(radiusAt(z0), radiusAt(z1)) - toleranceMm + slackMm
      if (radius > 0) bands.push({ bottom: z0, top: z1, radius })
    }
  }
  return bands
}

// ── Simulation profile ─────────────────────────────────────────────────────────

/**
 * Height of the lower cutting surface at radial distance d, as the simulators
 * carve it: today's tipOffsetAtRadius, line for line, on the supplied profile.
 */
export function simulationBottomAt(profile: RevolvedProfile, d: number): number {
  const v = profile.vertices
  if (v.length === 0) return 0
  const cutMaxZ = profile.cuttingMaxZ + 1e-9
  let maxR = 0
  for (const p of v) {
    if (p.z <= cutMaxZ && p.r > maxR) maxR = p.r
  }
  if (maxR <= 0) return 0
  const dd = d < 0 ? 0 : d > maxR ? maxR : d
  let prevAtOrAboveStart = false
  for (let i = 0; i < v.length - 1; i++) {
    const a = v[i]
    const b = v[i + 1]
    if (a.z > cutMaxZ) break
    const r0 = a.r
    const r1 = b.r
    const lo = Math.min(r0, r1)
    const hi = Math.max(r0, r1)
    if (dd < lo) {
      if (!prevAtOrAboveStart) return 0
      continue
    }
    prevAtOrAboveStart = true
    if (dd <= hi) {
      if (r1 === r0) return Math.min(a.z, b.z)
      const t = (dd - r0) / (r1 - r0)
      return a.z + (b.z - a.z) * t
    }
  }
  let zAtMax = 0
  for (const p of v) {
    if (p.z <= cutMaxZ && Math.abs(p.r - maxR) < 1e-9) zAtMax = Math.max(zAtMax, p.z)
  }
  return zAtMax
}

/** Every form the one source generates for a tool. */
export function toolShape(source: ToolShapeSource) {
  return {
    dropCutter: dropCutterSpec(source),
    sweep: sweepShape(source),
    reachBands: (toleranceMm: number, slackMm: number, maxBandHeightMm?: number) =>
      reachBands(source.profile, toleranceMm, slackMm, maxBandHeightMm),
    simulationBottomAt: (d: number) => simulationBottomAt(source.profile, d),
  }
}
