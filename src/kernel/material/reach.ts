// WO-3032 (alpha.3 A3-10b, parity): reach(T), what tool T can reach, from the
// one tool-shape source and the holder bands. Today the reach trim sweeps the
// whole assembly as radial bands, tip upward (holderClearance
// assemblySweepBands): the cutting head in <= 0.05 mm bands (headBandsFor), the
// actual non-cutting silhouette above cuttingMaxZ, then the shank and holder
// components the caller resolves. reach() builds the same list from the profile
// (the shank and holder components are supplied, as the tool model takes them).
//
// Part a's lollipop note lives here: the inscribed sweep shape takes the
// narrowest radius of the whole body, so a lollipop sweeps as its neck. The
// head-only shape (the head's own outline up to its widest point, full radius
// above) is generated and recorded, never used: it removes more than the tool
// above the widest point unless the reach check clears the undercut, so the
// policy value head_only_reach_shape stays OFF (PARITY_QUERY_POLICY).
import type { ProfileVertex, SweepShape, ToolShapeSource } from './contracts'
import { reachBands, sweepHeight, sweepShape } from './shape'

/** Today's gouge tolerance: the cutting head is banded no taller than this. */
export const REACH_HEAD_BAND_MM = 0.05

/** One radial band of the assembly, tip upward (today's RadialComponent). */
export interface ReachComponent {
  readonly kind: string
  readonly bottomOffsetMm: number
  /** Absent = runs on up. */
  readonly topOffsetMm?: number
  readonly diameterMm: number
}

export interface ToolReach {
  /** The whole assembly as swept bands, tip upward: head, silhouette, then the supplied components. */
  readonly components: readonly ReachComponent[]
  /** Depth below which only the cutting head reaches (the profile's cuttingMaxZ). */
  readonly cuttingReachMm: number
  /** Recorded, not used (head_only_reach_shape OFF): the head-only sweep shape, when it differs from the sweep shape. */
  readonly headOnly?: { readonly shape: SweepShape; readonly note: string }
}

export interface ReachOptions {
  /** The shank and holder components the caller resolved (today's shankComponents + holderComponents). */
  readonly upper?: readonly ReachComponent[]
  /** A neck span (today's toolNeckBand): silhouette bands inside it are labelled 'neck'. */
  readonly neck?: { readonly bottomMm: number; readonly topMm: number }
}

/** The head's own outline up to its widest point, as an upward-open shape. */
function headOnlyShape(source: ToolShapeSource): SweepShape | undefined {
  const v = source.profile.vertices
  if (v.length < 2) return undefined
  let widest = 0
  for (let i = 1; i < v.length; i++) {
    if (v[i].z > source.profile.cuttingMaxZ + 1e-9) break
    if (v[i].r > v[widest].r) widest = i
  }
  const run: ProfileVertex[] = []
  let maxR = -Infinity
  for (let i = 0; i <= widest; i++) {
    const r = Math.max(maxR, v[i].r)
    if (run.length && v[i].z === run[run.length - 1].z) run[run.length - 1] = { z: v[i].z, r }
    else run.push({ z: v[i].z, r })
    maxR = r
  }
  if (!(maxR > 0)) return undefined
  return { kind: 'inscribed', radius: maxR, zs: run.map(p => p.z), rs: run.map(p => p.r),
    note: `${source.tool.name} (${source.tool.type}) head-only shape (radius ${maxR.toFixed(3)} mm): ` +
      'removes more than the tool above its widest point unless the reach check clears the undercut; recorded, not used.' }
}

/** The head-only shape sits lower than the sweep shape somewhere: it would claim material the tool may not take. */
function removesMore(head: Extract<SweepShape, { kind: 'inscribed' }>, sweep: SweepShape): boolean {
  return head.rs.some(r => sweepHeight(head, r) < sweepHeight(sweep, r) - 1e-9)
}

/** reach(T): the assembly bands the reach trim sweeps, from the profile and the supplied holder bands. */
export function reach(source: ToolShapeSource, options: ReachOptions = {}): ToolReach {
  const profile = source.profile
  const silhouette: ReachComponent[] = []
  for (let i = 0; i < profile.vertices.length - 1; i++) {
    const a = profile.vertices[i], b = profile.vertices[i + 1]
    const bottom = Math.max(a.z, profile.cuttingMaxZ)
    if (!(b.z > bottom)) continue
    const pieces = a.r === b.r ? 1 : Math.ceil((b.z - bottom) / REACH_HEAD_BAND_MM)
    const radiusAt = (z: number) => a.r + (b.r - a.r) * (z - a.z) / (b.z - a.z)
    for (let p = 0; p < pieces; p++) {
      const z0 = bottom + (b.z - bottom) * p / pieces
      const z1 = bottom + (b.z - bottom) * (p + 1) / pieces
      const neck = options.neck
      const kind = neck && z0 >= neck.bottomMm - 1e-9 && z1 <= neck.topMm + 1e-9 ? 'neck' : 'shank'
      silhouette.push({ kind, bottomOffsetMm: z0, topOffsetMm: z1, diameterMm: 2 * Math.max(radiusAt(z0), radiusAt(z1)) })
    }
  }
  const head = reachBands(profile, 0, 0, REACH_HEAD_BAND_MM).map(band => ({
    kind: 'cutter', bottomOffsetMm: band.bottom, topOffsetMm: band.top, diameterMm: 2 * band.radius,
  }))
  const sweep = sweepShape(source)
  const headOnly = sweep.ok && sweep.value.kind === 'inscribed' ? headOnlyShape(source) : undefined
  return {
    components: [...head, ...silhouette, ...(options.upper ?? [])],
    cuttingReachMm: profile.cuttingMaxZ,
    ...(headOnly && headOnly.kind === 'inscribed' && sweep.ok && removesMore(headOnly, sweep.value)
      ? { headOnly: { shape: headOnly, note: headOnly.note } } : {}),
  }
}

/** Part b's own policy value, OFF at parity (the MD-50..MD-53 values stay in PARITY_POLICY). */
export const PARITY_QUERY_POLICY = Object.freeze({
  /** Sweep undercut tools with the head-only shape behind a reach check. Needs CARD V02 like MD-53. */
  head_only_reach_shape: false,
})
