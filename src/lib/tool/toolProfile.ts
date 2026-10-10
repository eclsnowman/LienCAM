// ── Tool geometry: the single source of truth ─────────────────────────────────
//
// Every tool is a SOLID OF REVOLUTION. A profile is an ordered radius(z)
// polyline from the TIP (z = 0) upward toward the holder; the full silhouette is
// the profile mirrored across the centerline. The cutting region is
// [0, cuttingMaxZ]; everything above is non-cutting neck / shoulder / shank.
//
// This module is the validated reference implementation ported to TypeScript
// from docs/qa/009 - tool-geometry-model/tool-geometry-reference.html. All later
// consumers (2D diagram, 3D mesh, simulation) read profiles from HERE so the
// geometry can never drift between views.
//
// Per-type geometry is keyed on toolTypeMeta(tool.type).profileKind and the
// half-angle (toolHalfAngleRad — the canonical from-axis half-angle for both
// included- and perSide-input tools). Pure and deterministic.

import type { Tool, ToolHolder } from '../../types'
import { toolTypeMeta } from './toolMeta'
import { toolHalfAngleRad } from '../cam/geometry'

export interface ProfileVertex {
  z: number
  r: number
}

export interface ToolProfile {
  vertices: ProfileVertex[]
  cuttingMaxZ: number
  fluteTopZ: number
}

// ── Internal helpers ──────────────────────────────────────────────────────────

// Points on a circle parameterised by angle (z increases up). Mirrors arcPts in
// the reference HTML: z = cz + rad*sin(t), r = cx + rad*cos(t).
function arcPts(cx: number, cz: number, rad: number, a0: number, a1: number, n: number): ProfileVertex[] {
  const out: ProfileVertex[] = []
  for (let i = 0; i <= n; i++) {
    const t = a0 + (a1 - a0) * (i / n)
    out.push({ z: cz + rad * Math.sin(t), r: cx + rad * Math.cos(t) })
  }
  return out
}

// Resolve the non-cutting neck radius for undercut families (lollipop / disc /
// dovetail). Default = min(shankRadius, diameter*0.6 -> radius), clamped to stay
// strictly below the cutting radius.
function resolveNeckRadius(tool: Tool, cuttingR: number): number {
  const shankR = (tool.shankDiameter || tool.diameter) / 2
  let rn = tool.neckDiameter != null ? tool.neckDiameter / 2 : Math.min(shankR, tool.diameter * 0.6 * 0.5)
  // Clamp strictly below the cutting radius so the neck is a genuine undercut.
  if (rn >= cuttingR) rn = cuttingR * 0.99
  if (rn < 0) rn = 0
  return rn
}

// ── Per-kind profile builders (ported EXACTLY from the reference HTML) ─────────

function buildFlat(tool: Tool): ToolProfile {
  const R = tool.diameter / 2
  const Rsh = (tool.shankDiameter || tool.diameter) / 2
  const L = tool.fluteLength
  const OAL = tool.overallLength
  const vertices: ProfileVertex[] = [{ z: 0, r: R }, { z: L, r: R }]
  // Optional neck (thread_mill): explicit neckDiameter + shoulderLength.
  if (tool.neckDiameter != null && tool.shoulderLength) {
    const Rn = tool.neckDiameter / 2
    const Lsh = tool.shoulderLength
    vertices.push({ z: L, r: Rn }, { z: L + Lsh, r: Rn }, { z: L + Lsh, r: Rsh })
    vertices.push({ z: Math.max(OAL, L + Lsh), r: Rsh })
  } else {
    vertices.push({ z: L, r: Rsh }, { z: OAL, r: Rsh })
  }
  return { vertices, cuttingMaxZ: L, fluteTopZ: L }
}

function buildBall(tool: Tool): ToolProfile {
  const R = tool.diameter / 2
  const Rsh = (tool.shankDiameter || tool.diameter) / 2
  const L = tool.fluteLength
  const OAL = tool.overallLength
  // hemisphere R centered z=R: tip (z=0) up to equator (z=R, r=R)
  const vertices = arcPts(0, R, R, -Math.PI / 2, 0, 40)
  vertices.push({ z: L, r: R }, { z: L, r: Rsh }, { z: OAL, r: Rsh })
  return { vertices, cuttingMaxZ: L, fluteTopZ: L }
}

function buildBull(tool: Tool): ToolProfile {
  const R = tool.diameter / 2
  const Rsh = (tool.shankDiameter || tool.diameter) / 2
  const L = tool.fluteLength
  const OAL = tool.overallLength
  const RE = Math.min(tool.cornerRadius ?? 0, R)
  // bottom flat (R-RE) then corner arc RE from bottom (-90) to side (0)
  const vertices: ProfileVertex[] = [{ z: 0, r: R - RE }]
  arcPts(R - RE, RE, RE, -Math.PI / 2, 0, 24).forEach(q => vertices.push(q))
  vertices.push({ z: L, r: R }, { z: L, r: Rsh }, { z: OAL, r: Rsh })
  return { vertices, cuttingMaxZ: L, fluteTopZ: L }
}

function buildCone(tool: Tool): ToolProfile {
  const R = tool.diameter / 2
  const Rt = (tool.tipDiameter ?? 0) / 2 // tip flat; default 0 = sharp point
  const Rsh = (tool.shankDiameter || tool.diameter) / 2
  const L = tool.fluteLength
  const OAL = tool.overallLength
  const a = toolHalfAngleRad(tool.angleFromAxisDeg)
  const hc = (R - Rt) / Math.tan(a) // cone height tip-flat -> full radius
  const vertices: ProfileVertex[] = [{ z: 0, r: Rt }, { z: hc, r: R }]
  if (L > hc) vertices.push({ z: L, r: R })
  const top = Math.max(L, hc)
  vertices.push({ z: top, r: Rsh }, { z: Math.max(OAL, top), r: Rsh })
  const cut = Math.min(L, top)
  return { vertices, cuttingMaxZ: cut, fluteTopZ: cut }
}

function buildFrustum(tool: Tool): ToolProfile {
  // Tapered endmill: diameter = MAJOR (top) diameter; tool narrows to the tip.
  // The derived tip radius spans the FULL fluteLength. Stored tipDiameter is
  // ignored here (it is a derived/display value for this family).
  const R = tool.diameter / 2
  const Rsh = (tool.shankDiameter || tool.diameter) / 2
  const L = tool.fluteLength
  const OAL = tool.overallLength
  const a = toolHalfAngleRad(tool.angleFromAxisDeg)
  let dtip = tool.diameter - 2 * L * Math.tan(a) // SMALL end at the tip
  if (dtip < 0) dtip = 0 // cone closes before flute end -> acts as a V-bit
  const Rtip = dtip / 2
  const vertices: ProfileVertex[] = [
    { z: 0, r: Rtip },
    { z: L, r: R },
    { z: L, r: Rsh },
    { z: OAL, r: Rsh },
  ]
  return { vertices, cuttingMaxZ: L, fluteTopZ: L }
}

function buildDrill(tool: Tool): ToolProfile {
  const R = tool.diameter / 2
  const Rsh = (tool.shankDiameter || tool.diameter) / 2
  const L = tool.fluteLength
  const OAL = tool.overallLength
  const a = toolHalfAngleRad(tool.angleFromAxisDeg)
  const hp = R / Math.tan(a) // conical point height
  const vertices: ProfileVertex[] = [{ z: 0, r: 0 }, { z: hp, r: R }]
  if (L > hp) vertices.push({ z: L, r: R })
  const top = Math.max(L, hp)
  vertices.push({ z: top, r: Rsh }, { z: Math.max(OAL, top), r: Rsh })
  const cut = Math.min(L, top)
  return { vertices, cuttingMaxZ: cut, fluteTopZ: cut }
}

function buildDovetail(tool: Tool): ToolProfile {
  const R = tool.diameter / 2
  const Rsh = (tool.shankDiameter || tool.diameter) / 2
  const L = tool.fluteLength
  const OAL = tool.overallLength
  const a = toolHalfAngleRad(tool.angleFromAxisDeg)
  const rt = R - L * Math.tan(a) // narrow top of cutting (inverted taper)
  const Rn = tool.neckDiameter != null ? tool.neckDiameter / 2 : rt
  const Lsh = tool.shoulderLength || 4
  const vertices: ProfileVertex[] = [{ z: 0, r: R }, { z: L, r: rt }] // wide bottom -> narrow up
  vertices.push({ z: L, r: Rn }, { z: L + Lsh, r: Rn }) // neck
  vertices.push({ z: L + Lsh, r: Rsh }, { z: Math.max(OAL, L + Lsh), r: Rsh })
  return { vertices, cuttingMaxZ: L, fluteTopZ: L }
}

function buildDisc(tool: Tool): ToolProfile {
  const R = tool.diameter / 2
  const Rsh = (tool.shankDiameter || tool.diameter) / 2
  const L = tool.fluteLength // kerf thickness
  const OAL = tool.overallLength
  const Rn = resolveNeckRadius(tool, R)
  const Lsh = tool.shoulderLength || 6
  const vertices: ProfileVertex[] = [{ z: 0, r: R }, { z: L, r: R }] // disc
  vertices.push({ z: L, r: Rn }, { z: L + Lsh, r: Rn }) // arbor neck
  vertices.push({ z: L + Lsh, r: Rsh }, { z: Math.max(OAL, L + Lsh), r: Rsh })
  return { vertices, cuttingMaxZ: L, fluteTopZ: L }
}

function buildThread(tool: Tool): ToolProfile {
  // Thread mill: a stack of N V-form teeth along the cutting length, then an
  // optional relieved neck up to the shank. crestR is the cutting OD; the teeth
  // dip to rootR = crestR - toothDepth. When threadPitch is unset/<=0 the tool
  // is a plain cylinder (legacy buildFlat shape) so old tools are unchanged.
  const crestR = tool.diameter / 2
  const Rsh = (tool.shankDiameter || tool.diameter) / 2
  const OAL = tool.overallLength

  const pitch = tool.threadPitch
  if (pitch == null || !(pitch > 0)) {
    // Backward-compatible: identical geometry to buildFlat (plain cylinder +
    // optional neck/shank tail).
    return buildFlat(tool)
  }

  const N = Math.max(1, Math.round(tool.threadTeethCount ?? 1))
  const formAngle = tool.threadFormAngleDeg ?? 60
  const toothDepth = (pitch / 2) / Math.tan((formAngle / 2) * (Math.PI / 180))
  // Degenerate guard: never collapse the root below 40% of the crest radius.
  const rootR = Math.max(crestR - toothDepth, crestR * 0.4)
  const Lc = N * pitch // threaded region length at the tip

  // Triangle-wave silhouette: start at the root (z=0), then per tooth push a
  // crest at the tooth mid-pitch and a root at the tooth end. N crests, ending
  // back at the root at z = Lc.
  const vertices: ProfileVertex[] = [{ z: 0, r: rootR }]
  for (let i = 0; i < N; i++) {
    vertices.push({ z: i * pitch + pitch / 2, r: crestR })
    vertices.push({ z: (i + 1) * pitch, r: rootR })
  }

  // Tail above the teeth: relieved neck (if set) then a CONE up to the shank
  // (instead of a sharp radial step). The shoulderLength stays the cylindrical
  // neck length; the transition cone is ADDED above it.
  if (tool.neckDiameter != null && tool.shoulderLength) {
    const Rn = tool.neckDiameter / 2
    const Lsh = tool.shoulderLength
    // Transition cone z-rise. angleFromAxis in (0, 90]; 90 = sharp radial step.
    let angleFromAxis = tool.neckTransitionAngleDeg ?? 30
    if (!(angleFromAxis > 0)) angleFromAxis = 30
    if (angleFromAxis > 90) angleFromAxis = 90
    let dz = 0
    if (Rsh > Rn && angleFromAxis < 89.999) {
      dz = (Rsh - Rn) / Math.tan(angleFromAxis * (Math.PI / 180))
    }
    vertices.push({ z: Lc, r: Rn }, { z: Lc + Lsh, r: Rn })
    vertices.push({ z: Lc + Lsh + dz, r: Rsh })
    vertices.push({ z: Math.max(OAL, Lc + Lsh + dz), r: Rsh })
  } else {
    vertices.push({ z: Lc, r: Rsh }, { z: Math.max(OAL, Lc), r: Rsh })
  }
  return { vertices, cuttingMaxZ: Lc, fluteTopZ: Lc }
}

function buildLollipop(tool: Tool): ToolProfile {
  const R = tool.diameter / 2
  const Rsh = (tool.shankDiameter || tool.diameter) / 2
  const OAL = tool.overallLength
  const Rn = resolveNeckRadius(tool, R)
  const Lsh = tool.shoulderLength || 10
  // sphere R centered z=R wraps PAST the equator down to where r = Rn at
  // z = R + sqrt(R^2 - Rn^2). aEnd is the angle from center for that point.
  const zNeck = R + Math.sqrt(Math.max(0, R * R - Rn * Rn))
  const aEnd = Math.atan2(zNeck - R, Rn)
  const vertices = arcPts(0, R, R, -Math.PI / 2, aEnd, 48)
  vertices.push({ z: zNeck, r: Rn }, { z: zNeck + Lsh, r: Rn }) // neck
  vertices.push({ z: zNeck + Lsh, r: Rsh }, { z: Math.max(OAL, zNeck + Lsh), r: Rsh })
  return { vertices, cuttingMaxZ: zNeck, fluteTopZ: zNeck }
}

// WO-2154: a touch probe - a ball on a stylus stem, then the probe's shank.
// `diameter` is the ball, `fluteLength` the stylus length from the tip (where
// the shank begins), `neckDiameter` the stem (default as resolveNeckRadius).
// The whole stylus is the contact region, so the drawing's 'flute' span is
// the stylus the operator entered.
function buildProbe(tool: Tool): ToolProfile {
  const R = tool.diameter / 2
  const Rsh = (tool.shankDiameter || tool.diameter) / 2
  const OAL = tool.overallLength
  const Rn = resolveNeckRadius(tool, R)
  const zNeck = R + Math.sqrt(Math.max(0, R * R - Rn * Rn))
  const aEnd = Math.atan2(zNeck - R, Rn)
  const L = Math.max(tool.fluteLength, zNeck)
  const vertices = arcPts(0, R, R, -Math.PI / 2, aEnd, 48)
  vertices.push({ z: zNeck, r: Rn }, { z: L, r: Rn }) // stylus stem
  vertices.push({ z: L, r: Rsh }, { z: Math.max(OAL, L), r: Rsh })
  return { vertices, cuttingMaxZ: L, fluteTopZ: L }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Build the radius(z) profile for a tool, keyed on its profileKind. The returned
 * vertices are ordered tip (z=0) -> up; cuttingMaxZ is the top of the cutting
 * region. Pure and deterministic.
 */
export function buildToolProfile(tool: Tool): ToolProfile {
  const kind = toolTypeMeta(tool.type).profileKind
  switch (kind) {
    case 'flat':
      return buildFlat(tool)
    case 'ball':
      return buildBall(tool)
    case 'bull':
      return buildBull(tool)
    case 'cone':
      return buildCone(tool)
    case 'frustum':
      return buildFrustum(tool)
    case 'drillpoint':
      return buildDrill(tool)
    case 'dovetail':
      return buildDovetail(tool)
    case 'disc':
      return buildDisc(tool)
    case 'lollipop':
      return buildLollipop(tool)
    case 'thread':
      return buildThread(tool)
    case 'probe':
      return buildProbe(tool)
    default:
      return buildFlat(tool)
  }
}

/**
 * Build a holder profile as an ordered radius(z) polyline, z measured from the
 * holder bottom (= 0) upward. Each segment contributes its lower-diameter vertex
 * at its base and its upper-diameter vertex at its top; equal dias = cylinder,
 * unequal = cone.
 */
export function buildHolderProfile(holder: ToolHolder): ProfileVertex[] {
  const vertices: ProfileVertex[] = []
  let z = 0
  for (const seg of holder.segments) {
    vertices.push({ z, r: seg.lowerDiameter / 2 })
    z += seg.height
    vertices.push({ z, r: seg.upperDiameter / 2 })
  }
  return vertices
}

/**
 * Radius of the profile at axial height z (linear interpolation between
 * vertices). Returns 0 above the top vertex; clamps at/below 0 to the first
 * vertex. When two vertices share a z (a vertical step), returns the LARGER
 * radius so the silhouette stays conservative.
 */
export function radiusAtZ(profile: ToolProfile, z: number): number {
  const v = profile.vertices
  if (v.length === 0) return 0
  if (z <= v[0].z) return v[0].r
  const top = v[v.length - 1]
  if (z > top.z) return 0
  if (z === top.z) return top.r
  let result = 0
  for (let i = 0; i < v.length - 1; i++) {
    const a = v[i]
    const b = v[i + 1]
    if (z >= a.z && z <= b.z) {
      if (b.z === a.z) {
        // Vertical step: take the larger radius (conservative silhouette).
        result = Math.max(result, a.r, b.r)
      } else {
        const t = (z - a.z) / (b.z - a.z)
        result = Math.max(result, a.r + (b.r - a.r) * t)
      }
    }
  }
  return result
}

/** True when z is within the cutting region (z <= cuttingMaxZ + epsilon). */
export function isCutting(profile: ToolProfile, z: number): boolean {
  return z <= profile.cuttingMaxZ + 1e-6
}

// ── Passive reach (rub) warnings ───────────────────────────────────────────────
//
// A PASSIVE, non-blocking check: does an operation's axial cut depth exceed the
// tool's cutting (flute) length or its stickout below the holder? If so the
// NON-CUTTING shank/neck (or the holder itself) would rub the wall. Active
// avoidance (pull-away / trim) is OUT OF SCOPE (deferred). Pure, deterministic,
// never throws — fail-safe per ADR-0003 (surface explicitly, never silently
// swallow, but never block the toolpath).

export interface ToolReachWarning {
  kind: 'shank-rub' | 'holder-rub'
  message: string
  depthMm: number
  limitMm: number
}

// Small tolerance so a depth that merely equals the limit (within float noise)
// does not raise a false warning.
const REACH_EPS = 1e-4

/**
 * Warnings for a tool whose non-cutting geometry would rub the workpiece at the
 * given axial cut depth. Returns [] when within limits, or when the flute length
 * is unknown / non-positive. Messages are short, ASCII, UI-facing.
 */
export function toolReachWarnings(tool: Tool, axialDepthMm: number): ToolReachWarning[] {
  const out: ToolReachWarning[] = []
  if (!Number.isFinite(axialDepthMm) || axialDepthMm <= 0) return out

  const flute = tool.fluteLength
  if (Number.isFinite(flute) && flute > 0 && axialDepthMm > flute + REACH_EPS) {
    out.push({
      kind: 'shank-rub',
      message:
        `Cut depth ${axialDepthMm.toFixed(2)} mm > flute length ${flute.toFixed(2)} mm ` +
        `-> non-cutting shank/neck will rub the wall unless relieved.`,
      depthMm: axialDepthMm,
      limitMm: flute,
    })
  }

  const stickout = tool.lengthBelowHolder
  if (stickout != null && Number.isFinite(stickout) && stickout > 0 && axialDepthMm > stickout + REACH_EPS) {
    out.push({
      kind: 'holder-rub',
      message:
        `Cut depth ${axialDepthMm.toFixed(2)} mm > stickout below holder ${stickout.toFixed(2)} mm ` +
        `-> the holder would contact the stock.`,
      depthMm: axialDepthMm,
      limitMm: stickout,
    })
  }

  return out
}

/**
 * Height of the tool's lower CUTTING surface at radial distance d — the inverse
 * of the rising lower boundary of the profile (z as a function of r, walking the
 * profile from the tip up within the cutting region). Returns 0 at/below the
 * tip-flat radius and, for d beyond the maximum cutting radius, the height at
 * that maximum radius (the d is clamped to [0, maxCuttingRadius] first).
 *
 * This reproduces the classic per-type "bottom profile" formulas the voxel
 * carve used to switch on by hand —
 *   flat:  0
 *   ball:  R - sqrt(R^2 - d^2)
 *   cone:  (d - tipR) / tan(half)
 * — because those formulas ARE the lower boundary of buildToolProfile. Threading
 * the prebuilt profile through carve.ts therefore gives every one of the 18 tool
 * types a real cutting shape in simulation, derived from the single source of
 * truth rather than a duplicated per-type switch.
 *
 * This is the BOTTOM surface only. For an undercut profile (lollipop, dovetail,
 * disc, thread-mill teeth, a shank narrower than the cutter) the tool is also
 * bounded ABOVE at each radius, and "bottom surface + full-radius column" claims
 * material the tool never reaches. The simulators carve those through
 * undercutSolidFor / undercutSignedDistance below (WO-1383).
 *
 * Pure and deterministic; depends only on the profile vertices.
 */
export function tipOffsetAtRadius(profile: ToolProfile, d: number): number {
  const v = profile.vertices
  if (v.length === 0) return 0

  // The lower cutting boundary = profile vertices within the cutting region,
  // ordered tip(z=0) -> up. cuttingMaxZ is the top of that region.
  const cutMaxZ = profile.cuttingMaxZ + 1e-9

  // Maximum cutting radius (over the cutting region) -> the clamp ceiling and the
  // value returned for any d past it.
  let maxR = 0
  for (const p of v) {
    if (p.z <= cutMaxZ && p.r > maxR) maxR = p.r
  }
  if (maxR <= 0) return 0

  const dd = d < 0 ? 0 : d > maxR ? maxR : d

  // Walk the boundary tip-up; find the first segment whose radius reaches dd and
  // interpolate the z there. The lower boundary is non-decreasing in r as z
  // rises for the cutting families, so the first crossing is the bottom surface.
  let prevAtOrAboveStart = false
  for (let i = 0; i < v.length - 1; i++) {
    const a = v[i]
    const b = v[i + 1]
    if (a.z > cutMaxZ) break
    // Segment endpoints (clamp b at the cutting top is unnecessary — segments
    // wholly inside the region are what we walk; the tip-flat at z=0 yields 0).
    const r0 = a.r
    const r1 = b.r
    const lo = Math.min(r0, r1)
    const hi = Math.max(r0, r1)
    if (dd < lo) {
      // dd is below this segment's radius range. If we have not yet reached a
      // segment that brackets dd, dd lies within the tip flat -> height 0.
      if (!prevAtOrAboveStart) return 0
      continue
    }
    prevAtOrAboveStart = true
    if (dd <= hi) {
      if (r1 === r0) {
        // Vertical step (e.g. flute top): radius constant -> the surface at dd is
        // the lower z of the step.
        return Math.min(a.z, b.z)
      }
      const t = (dd - r0) / (r1 - r0)
      return a.z + (b.z - a.z) * t
    }
  }
  // dd == maxR (clamped) or never bracketed within the cutting region: return the
  // cutting-region height at the max radius.
  let zAtMax = 0
  for (const p of v) {
    if (p.z <= cutMaxZ && Math.abs(p.r - maxR) < 1e-9) zAtMax = Math.max(zAtMax, p.z)
  }
  return zAtMax
}

// -- Undercut solid (WO-1383) ---------------------------------------------------
//
// "Bottom surface + a cylinder of the full radius above it" is exact for a
// profile whose radius never narrows going up (flat, ball, bull, drill, cone) and
// wrong for one that does: a lollipop's head curves back in to its neck, so that
// solid claims the overhang above the head. At any radius such a tool occupies z
// INTERVALS, bounded above as well as below.
//
// The undercut solid is the tool's real (r, z) section: the cutting-region
// vertices (radii clamped to the carve radius R) closed by the tip cap, then a
// column of the radius at the top of the cutting region (the neck) straight up.
// The part above the cutting region is modelled at that radius, never wider: the
// sim shows what the cutter removes, it is not a holder collision check.

const UNDERCUT_EPS = 1e-9

export interface UndercutSolid {
  /** Carve radius the section is clamped to. */
  readonly R: number
  /** Cutting-region vertices tip-up (z non-decreasing), radii clamped to R. */
  readonly zs: Float64Array
  readonly rs: Float64Array
  /** Top of the cutting region; above it the tool is a column of columnR. */
  readonly topZ: number
  readonly columnR: number
  /**
   * Radial bands: band j spans [bandR[j], bandR[j+1]) and its boundary crossings,
   * in ascending z, are entries bandStart[j] .. bandStart[j+1]-1 of the cross*
   * arrays (crossing z at radius d = crossZ + crossK * (d - crossR)). At or past
   * the last band radius the tool is absent.
   */
  readonly bandR: Float64Array
  readonly bandStart: Int32Array
  readonly crossR: Float64Array
  readonly crossZ: Float64Array
  readonly crossK: Float64Array
}

function cuttingSection(profile: ToolProfile, R: number): { zs: number[]; rs: number[] } {
  const zs: number[] = []
  const rs: number[] = []
  const cutMaxZ = profile.cuttingMaxZ + UNDERCUT_EPS
  for (const p of profile.vertices) {
    if (p.z > cutMaxZ) continue
    zs.push(p.z)
    rs.push(p.r < 0 ? 0 : p.r > R ? R : p.r)
  }
  return { zs, rs }
}

/**
 * True when the cutting-region radius (clamped to R) ever narrows going up from
 * the tip, counting the radius the tool continues at above the cutting region.
 * False for flat / ball / bull / drill / cone / frustum profiles whose shank is
 * at least as wide as the cutter.
 */
export function isUndercutProfile(profile: ToolProfile, R: number): boolean {
  const { rs } = cuttingSection(profile, R)
  let runMax = -Infinity
  for (const r of rs) {
    if (r < runMax - UNDERCUT_EPS) return true
    if (r > runMax) runMax = r
  }
  return false
}

export function buildUndercutSolid(profile: ToolProfile, R: number): UndercutSolid {
  const { zs, rs } = cuttingSection(profile, R)
  if (zs.length === 0) {
    zs.push(0)
    rs.push(R)
  }
  const m = zs.length
  // Section boundary edges a line of constant radius can cross: the tip cap from
  // the axis out to the first vertex, then the polyline. (The column above is at
  // constant radius and is never crossed.)
  const ra = [0]
  const za = [zs[0]]
  const rb = [rs[0]]
  const zb = [zs[0]]
  for (let i = 0; i < m - 1; i++) {
    ra.push(rs[i])
    za.push(zs[i])
    rb.push(rs[i + 1])
    zb.push(zs[i + 1])
  }

  const radii = [0, ...rs].sort((a, b) => a - b).filter((r, i, a) => i === 0 || r !== a[i - 1])
  const bandStart: number[] = []
  const cR: number[] = []
  const cZ: number[] = []
  const cK: number[] = []
  for (let j = 0; j < radii.length - 1; j++) {
    bandStart.push(cR.length)
    const lo = radii[j]
    const hi = radii[j + 1]
    const mid = (lo + hi) / 2
    // Edges spanning the whole band cross every radius in it; edges never cross
    // each other, so their z order inside the band is fixed.
    const band: { r: number; z: number; k: number; zMid: number }[] = []
    for (let e = 0; e < ra.length; e++) {
      if (Math.min(ra[e], rb[e]) > lo || Math.max(ra[e], rb[e]) < hi) continue
      const k = (zb[e] - za[e]) / (rb[e] - ra[e])
      band.push({ r: ra[e], z: za[e], k, zMid: za[e] + k * (mid - ra[e]) })
    }
    band.sort((p, q) => p.zMid - q.zMid)
    for (const c of band) {
      cR.push(c.r)
      cZ.push(c.z)
      cK.push(c.k)
    }
  }
  bandStart.push(cR.length, cR.length)

  return {
    R,
    zs: Float64Array.from(zs),
    rs: Float64Array.from(rs),
    topZ: zs[m - 1],
    columnR: rs[m - 1],
    bandR: Float64Array.from(radii),
    bandStart: Int32Array.from(bandStart),
    crossR: Float64Array.from(cR),
    crossZ: Float64Array.from(cZ),
    crossK: Float64Array.from(cK),
  }
}

const undercutSolidMemo = new WeakMap<ToolProfile, { R: number; solid: UndercutSolid | null }>()

/**
 * The undercut solid for a profile carved at radius R, or null when the profile
 * is not an undercut (callers keep their bottom-surface fast path). Memoized per
 * profile object, so it is built once per tool, never per voxel.
 */
export function undercutSolidFor(profile: ToolProfile, R: number): UndercutSolid | null {
  const hit = undercutSolidMemo.get(profile)
  if (hit !== undefined && hit.R === R) return hit.solid
  const solid = isUndercutProfile(profile, R) ? buildUndercutSolid(profile, R) : null
  undercutSolidMemo.set(profile, { R, solid })
  return solid
}

// Band index containing radius d, or -1 when the tool is absent at d.
function undercutBand(s: UndercutSolid, d: number): number {
  const b = s.bandR
  const n = b.length
  if (d >= b[n - 1]) return -1
  let lo = 0
  let hi = n - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >>> 1
    if (b[mid] <= d) lo = mid
    else hi = mid
  }
  return lo
}

// Section radius at height h, for zs[0] <= h < topZ.
function undercutRadiusAt(s: UndercutSolid, h: number): number {
  const zs = s.zs
  let lo = 0
  let hi = zs.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >>> 1
    if (zs[mid] <= h) lo = mid
    else hi = mid
  }
  const t = (h - zs[lo]) / (zs[hi] - zs[lo])
  return s.rs[lo] + (s.rs[hi] - s.rs[lo]) * t
}

/**
 * Inside-positive signed distance estimate from a point at radius d and height h
 * above the tip to the undercut solid. The sign is exact (crossing parity at d);
 * the magnitude is the shorter of the horizontal distance to the wall at h and the
 * vertical distance to the nearest boundary at d. Both are distances to real
 * surface points, so the estimate never under-reads the true distance.
 */
export function undercutSignedDistance(s: UndercutSolid, d: number, h: number): number {
  let horiz = Infinity
  if (h >= s.topZ) horiz = Math.abs(s.columnR - d)
  else if (h >= s.zs[0]) horiz = Math.abs(undercutRadiusAt(s, h) - d)
  let vert = Infinity
  let below = 0
  const j = undercutBand(s, d)
  if (j >= 0) {
    for (let c = s.bandStart[j], end = s.bandStart[j + 1]; c < end; c++) {
      const dz = h - (s.crossZ[c] + s.crossK[c] * (d - s.crossR[c]))
      if (dz >= 0) below++
      const a = dz < 0 ? -dz : dz
      if (a < vert) vert = a
    }
  }
  const mag = horiz < vert ? horiz : vert
  if (mag === Infinity) return -Math.max(d - s.R, s.zs[0] - h)
  return (below & 1) === 1 ? mag : -mag
}

/**
 * Top of the tool body that rises continuously from the tool's bottom at radius
 * d: Infinity where the tool continues upward (inside the neck column), -Infinity
 * where the tool is absent. A top-surface simulator lowers a column only when its
 * surface is at or below this height; above it the tool passes underneath.
 */
export function undercutBodyTopAtRadius(s: UndercutSolid, d: number): number {
  const j = undercutBand(s, d)
  if (j < 0) return -Infinity
  const start = s.bandStart[j]
  const n = s.bandStart[j + 1] - start
  if (n === 0) return -Infinity
  const zAt = (i: number) => s.crossZ[start + i] + s.crossK[start + i] * (d - s.crossR[start + i])
  let e = 1
  // Touching intervals (a zero-length gap at a vertex radius) are one body.
  while (e + 1 < n && zAt(e + 1) - zAt(e) <= UNDERCUT_EPS) e += 2
  return e < n ? zAt(e) : Infinity
}

/**
 * undercutBodyTopAtRadius for a profile at its own cutting radius; Infinity at
 * every radius for a profile that is not an undercut. The companion of
 * tipOffsetAtRadius for top-surface (heightmap) simulation.
 */
export function toolBodyTopAtRadius(profile: ToolProfile, d: number): number {
  let maxR = 0
  const cutMaxZ = profile.cuttingMaxZ + 1e-9
  for (const p of profile.vertices) {
    if (p.z <= cutMaxZ && p.r > maxR) maxR = p.r
  }
  const solid = undercutSolidFor(profile, maxR)
  return solid === null ? Infinity : undercutBodyTopAtRadius(solid, d)
}

// ── Radial lookup table (perf: PERF-RECON finding #2) ──────────────────────────
//
// tipOffsetAtRadius walks profile.vertices from scratch on every call (a full
// maxR scan PLUS a partial bracket-search), which is fine when called once per
// tool position (2D diagram, 3D mesh) but far too slow when called PER VOXEL in
// the sim carve hot loop (src/lib/simulation/voxel/carve.ts) — measured ~11x a
// flat tool's carve cost for ball/bull-nose profiles.
//
// buildRadialLUT precomputes, ONCE per profile, an array of the "winning"
// (radius, height) segments — the same segments tipOffsetAtRadius would ever
// actually select, in the same order — and evalRadialLUT looks one up via
// binary search + the SAME interpolation arithmetic tipOffsetAtRadius uses, so
// the result is bit-for-bit identical for every d, not merely close.
//
// Why "winning segments" (not just a straight copy of profile.vertices) is
// needed: the profile's radius is NOT always non-decreasing tip-up. A dovetail
// mill's single cutting segment narrows (r decreases with z); a lollipop mill's
// arc rises past the equator then narrows again toward its neck; a thread
// mill's teeth zig-zag root/crest/root many times. tipOffsetAtRadius resolves
// this with an index-order "first segment whose [lo,hi] brackets d wins" walk,
// which is EXACTLY equivalent to: track a running maximum of hi = max(r0,r1)
// as segments are visited tip-up; a segment only ever wins for d values that
// are STRICTLY beyond every earlier segment's hi (any earlier segment whose
// bracket already reaches that far returns first). So a segment that never
// extends the running max — the lollipop's neck-ward taper after its ball
// already reached maxR, a thread mill's 2nd..Nth tooth after the 1st already
// reached crestR — can never be selected by any query in [0, maxR] and is
// safely dropped. This holds for every profileKind buildToolProfile emits;
// proven byte-identical against the untouched tipOffsetAtRadius oracle across
// all of them (src/tests/tool/radialLUT.test.ts, src/tests/simulation/voxel/
// radialLutCarve.test.ts).
export interface RadialLUT {
  readonly maxR: number
  readonly zAtMax: number
  readonly lo0: number
  readonly his: Float64Array
  readonly r0s: Float64Array
  readonly r1s: Float64Array
  readonly z0s: Float64Array
  readonly z1s: Float64Array
}

const EMPTY_RADIAL_LUT: RadialLUT = {
  maxR: 0,
  zAtMax: 0,
  lo0: 0,
  his: new Float64Array(0),
  r0s: new Float64Array(0),
  r1s: new Float64Array(0),
  z0s: new Float64Array(0),
  z1s: new Float64Array(0),
}

/**
 * Build the radial LUT for a profile. Pure and deterministic; depends only on
 * profile.vertices/cuttingMaxZ, exactly like tipOffsetAtRadius. Intended to be
 * called ONCE per profile object and cached by the caller (see carve.ts's
 * WeakMap memo) — building it per-voxel would defeat the point.
 */
export function buildRadialLUT(profile: ToolProfile): RadialLUT {
  const v = profile.vertices
  if (v.length === 0) return EMPTY_RADIAL_LUT

  const cutMaxZ = profile.cuttingMaxZ + 1e-9

  // Mirrors tipOffsetAtRadius's maxR loop exactly.
  let maxR = 0
  for (const p of v) {
    if (p.z <= cutMaxZ && p.r > maxR) maxR = p.r
  }
  if (maxR <= 0) return EMPTY_RADIAL_LUT

  // Mirrors tipOffsetAtRadius's zAtMax fallback loop exactly (rarely used, kept
  // for full fidelity with the degenerate case where no segment ever brackets).
  let zAtMax = 0
  for (const p of v) {
    if (p.z <= cutMaxZ && Math.abs(p.r - maxR) < 1e-9) zAtMax = Math.max(zAtMax, p.z)
  }

  const his: number[] = []
  const r0s: number[] = []
  const r1s: number[] = []
  const z0s: number[] = []
  const z1s: number[] = []
  let lo0 = 0
  let haveFirst = false
  let runningMax = -Infinity
  for (let i = 0; i < v.length - 1; i++) {
    const a = v[i]
    const b = v[i + 1]
    if (a.z > cutMaxZ) break
    const r0 = a.r
    const r1 = b.r
    const lo = Math.min(r0, r1)
    const hi = Math.max(r0, r1)
    if (!haveFirst) {
      // Only the FIRST segment's lo can ever produce a "return 0" in the
      // original walk (prevAtOrAboveStart starts false and becomes true
      // permanently the instant i=0 is checked, whatever the outcome), so
      // this is the only lo we need to remember.
      lo0 = lo
      haveFirst = true
    }
    if (hi > runningMax) {
      his.push(hi)
      r0s.push(r0)
      r1s.push(r1)
      z0s.push(a.z)
      z1s.push(b.z)
      runningMax = hi
    }
    // else: this segment can never be the first bracket match for any d in
    // [0, maxR] (an earlier segment's hi already reaches at least as far) —
    // provably dead, dropped.
  }

  return {
    maxR,
    zAtMax,
    lo0,
    his: Float64Array.from(his),
    r0s: Float64Array.from(r0s),
    r1s: Float64Array.from(r1s),
    z0s: Float64Array.from(z0s),
    z1s: Float64Array.from(z1s),
  }
}

/**
 * Evaluate the radial LUT at radius d. Bit-for-bit identical to
 * tipOffsetAtRadius(profile, d) for the profile the LUT was built from — same
 * clamp, same bracket found (via binary search over the strictly-increasing
 * `his`, which always lands on the same segment the original first-match walk
 * would), same interpolation formula on that segment's ORIGINAL (r0,r1,z0,z1)
 * (not re-derived, not narrowed — the literal values tipOffsetAtRadius would
 * have used), so the floating-point result matches exactly, not approximately.
 */
export function evalRadialLUT(lut: RadialLUT, d: number): number {
  if (lut.maxR <= 0) return 0
  const dd = d < 0 ? 0 : d > lut.maxR ? lut.maxR : d
  const n = lut.his.length
  if (n === 0) return lut.zAtMax
  if (dd < lut.lo0) return 0
  let lo = 0
  let hi = n - 1
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (lut.his[mid] >= dd) hi = mid
    else lo = mid + 1
  }
  if (lut.his[lo] < dd) return lut.zAtMax // defensive; provably unreached
  const r0 = lut.r0s[lo]
  const r1 = lut.r1s[lo]
  const z0 = lut.z0s[lo]
  const z1 = lut.z1s[lo]
  if (r1 === r0) return Math.min(z0, z1)
  const t = (dd - r0) / (r1 - r0)
  return z0 + (z1 - z0) * t
}

/**
 * The tool's maximum immersion below the top of cut, derived from the COMPUTED
 * toolpath: the deepest non-rapid move below `topZAbs`. Both `topZAbs` and the
 * move Z values must be in the SAME (absolute, WCS-resolved) frame -- the height
 * planes are WCS-relative, so the caller lifts topHeight by the setup's WCS
 * origin Z first. Using the actual toolpath (not the top-to-bottom height span)
 * is what makes this correct for engrave / depth-from-width, where the tip
 * engages far shallower than the bottom plane. Returns 0 when there are no
 * cutting moves or the tool never goes below the top of cut.
 */
export function maxImmersionDepth(topZAbs: number, moves: { type: string; z: number }[]): number {
  let deepest = Infinity
  for (const m of moves) if (m.type !== 'rapid' && m.z < deepest) deepest = m.z
  if (!Number.isFinite(deepest)) return 0
  return Math.max(0, topZAbs - deepest)
}
