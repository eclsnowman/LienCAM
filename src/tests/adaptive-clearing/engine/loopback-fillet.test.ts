// REGRESSION GUARD: loopback fillet geometry (circle-fit measurement based, never bare counts).
//
// Guards the 2026-06-10 loopback fillet fixes (wallCleanLoop.ts):
//   - contact-overlap clamp: ride overshoot used to land the outgoing contact F BEHIND the
//     incoming contact E on the same wall -> exact-180deg straight reversal links at pct25
//     (12 across fixtures; fix5/fix1 clusters) and a 341.7deg full-circle pigtail at pct100
//     (fix5, via the silent den~0 off-circle fallback in the old loopbackArc).
//   - adaptive fillet radius (t <= |EF|/2 and <= ride length): token arcs (sampled sweep a
//     fraction of the required turn) and a crossed-contact backward mini-traverse.
//   - fail-loud validated construction: every emitted fillet arc's sampled sweep equals its
//     intended turn (no 2pi wrap), contacts on the fillet circle, forward-ordered.
//
// Defect fixtures only: fix1 (Kidney), fix5 (BootL), fix7 (Barbell) at pct25, plus fix5 at
// pct100. Per emitted loopback pass this asserts, by MEASUREMENT:
//   (a) tangent joints: the loopback's start/end tangents continue the neighbouring
//       wall-follow tangents within 20deg (a token arc leaves a >100deg corner here);
//   (b) no internal reversal: no consecutive-segment direction flip > 175deg (the backward
//       mini-traverse / straight-reversal class);
//   (c) two-tangent-arc certificate: SOME split of the polyline yields two pieces whose
//       least-squares circle fits each sweep <= 185deg (a wrapped/pigtail arc sweeps ~360 -
//       turn and admits no such split). NOTE: huge-pct loopbacks legitimately form balloon
//       U-turns (two ~135-165deg arcs, zero-length traverse); judged per ARC, not per pass.
//   Measured on wall-clean FILLET loopbacks only: a loopback listed in the result's
//   `routedLoopbackPassIndices` is a WO-438 routed keep-down traverse (a rapid at depth that is
//   allowed to backtrack), counted -- and PINNED, below -- but not held to fillet tangency.
//   See the FeatureResult comment on that member.
//   (d) zero MISSING-reversal links: any keep-down link emitted directly between two
//       wall-follows must be tangent (corner <= 20deg both ends) -- the straight fallback is
//       an ADR-0003 tripwire that should be unreachable on these fixtures.
//
// Also regenerates the post-fix review renders for fix5 (gray toolpath, green good fillet,
// orange suspect>90deg, red defect; expect NO red):
//   review-images/loopback-fillet-fixed-fix5.png         (pct25)
//   review-images/loopback-fillet-fixed-pct100-fix5.png  (pct100)

import { describe, it, expect, beforeAll } from 'vitest'
import * as fs from 'fs'
import * as zlib from 'zlib'
import { ensureEngineClipperReady, type Loop, type Pt } from '../../../lib/cam/adaptiveClearing2d/engine/clipperEngine'
import { processFeature, type FeatureResult } from '../../../lib/cam/adaptiveClearing2d/engine/processFeature'

const SHARP_DEG = 20        // straight fallback links must be tangent (the ADR-0003 tripwire)
// Loopback->wall-follow joints: defect classes leave >= 100deg discontinuities (token arcs
// 100-170deg, reversals 180deg); contacts landing beside a wall polyline VERTEX leave a
// benign 25-40deg kink (the tangent target changes across the corner; pre-existing class).
const JOINT_SHARP_DEG = 60
const REVERSAL_DEG = 175
const MAX_ARC_SWEEP_DEG = 185

// ---------- vector helpers ----------
const sub = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y })
const dist = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.y - b.y)
function unit(v: Pt): Pt { const m = Math.hypot(v.x, v.y) || 1; return { x: v.x / m, y: v.y / m } }
function angleBetweenDeg(a: Pt, b: Pt): number {
  const d = Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y))
  return Math.acos(d) * 180 / Math.PI
}
/** Drop consecutive duplicates (zero-length traverse joints) so tangents are well-defined. */
function dedup(pts: Pt[]): Pt[] {
  const out: Pt[] = [pts[0]]
  for (let i = 1; i < pts.length; i++) if (dist(pts[i], out[out.length - 1]) > 1e-9) out.push(pts[i])
  return out
}
function tanAtStart(p: Pt[]): Pt { return unit(sub(p[1], p[0])) }
function tanAtEnd(p: Pt[]): Pt { return unit(sub(p[p.length - 1], p[p.length - 2])) }

// ---------- least-squares (Kasa) circle fit + unwrapped sweep ----------
function circleFit(pts: Pt[]): { cx: number; cy: number; r: number; rms: number } | null {
  const n = pts.length
  if (n < 3) return null
  let Sx = 0, Sy = 0, Sxx = 0, Syy = 0, Sxy = 0, Sxz = 0, Syz = 0, Sz = 0
  for (const p of pts) {
    const z = p.x * p.x + p.y * p.y
    Sx += p.x; Sy += p.y; Sxx += p.x * p.x; Syy += p.y * p.y; Sxy += p.x * p.y
    Sxz += p.x * z; Syz += p.y * z; Sz += z
  }
  const A = [[Sxx, Sxy, Sx], [Sxy, Syy, Sy], [Sx, Sy, n]]
  const B = [Sxz, Syz, Sz]
  for (let c = 0; c < 3; c++) {
    let piv = c
    for (let r2 = c + 1; r2 < 3; r2++) if (Math.abs(A[r2][c]) > Math.abs(A[piv][c])) piv = r2
    if (Math.abs(A[piv][c]) < 1e-12) return null
    if (piv !== c) { const t = A[piv]; A[piv] = A[c]; A[c] = t; const tb = B[piv]; B[piv] = B[c]; B[c] = tb }
    for (let r2 = c + 1; r2 < 3; r2++) {
      const f = A[r2][c] / A[c][c]
      for (let kk = c; kk < 3; kk++) A[r2][kk] -= f * A[c][kk]
      B[r2] -= f * B[c]
    }
  }
  const sol = [0, 0, 0]
  for (let r2 = 2; r2 >= 0; r2--) {
    let s = B[r2]
    for (let kk = r2 + 1; kk < 3; kk++) s -= A[r2][kk] * sol[kk]
    sol[r2] = s / A[r2][r2]
  }
  const cx = sol[0] / 2, cy = sol[1] / 2
  const r = Math.sqrt(Math.max(0, sol[2] + cx * cx + cy * cy))
  let ss = 0
  for (const p of pts) { const d = Math.hypot(p.x - cx, p.y - cy) - r; ss += d * d }
  return { cx, cy, r, rms: Math.sqrt(ss / n) }
}
function sweepAboutDeg(pts: Pt[], cx: number, cy: number): number {
  let total = 0
  let prev = Math.atan2(pts[0].y - cy, pts[0].x - cx)
  for (let i = 1; i < pts.length; i++) {
    const a = Math.atan2(pts[i].y - cy, pts[i].x - cx)
    let d = a - prev
    while (d > Math.PI) d -= 2 * Math.PI
    while (d < -Math.PI) d += 2 * Math.PI
    total += d; prev = a
  }
  return Math.abs(total) * 180 / Math.PI
}
/** Measured sweep of one piece: circle-fit sweep, or 0 for a (near-)straight piece. */
function pieceSweepDeg(pts: Pt[]): number {
  if (pts.length < 3) return 0
  const fit = circleFit(pts)
  if (!fit || fit.r > 1e4) return 0   // straight within fit tolerance
  return sweepAboutDeg(pts, fit.cx, fit.cy)
}

// ---------- per-loopback measurements ----------
interface LoopbackVerdict {
  jointStartDeg: number   // tangent discontinuity vs the previous pass at the loopback start
  jointEndDeg: number     // tangent discontinuity vs the next pass at the loopback end
  maxInternalTurnDeg: number  // worst consecutive-segment direction change inside the pass
  certified: boolean      // some split yields two arcs each <= MAX_ARC_SWEEP_DEG
  bestMaxPieceSweep: number   // the best split's larger piece sweep (for reporting)
}

function measureLoopback(prev: Pt[] | null, pts0: Pt[], next: Pt[] | null): LoopbackVerdict {
  const pts = dedup(pts0)
  const jointStartDeg = prev && prev.length >= 2 && pts.length >= 2 ? angleBetweenDeg(tanAtEnd(prev), tanAtStart(pts)) : 0
  const jointEndDeg = next && next.length >= 2 && pts.length >= 2 ? angleBetweenDeg(tanAtEnd(pts), tanAtStart(next)) : 0
  let maxInternalTurnDeg = 0
  for (let i = 1; i < pts.length - 1; i++) {
    const d1 = unit(sub(pts[i], pts[i - 1]))
    const d2 = unit(sub(pts[i + 1], pts[i]))
    maxInternalTurnDeg = Math.max(maxInternalTurnDeg, angleBetweenDeg(d1, d2))
  }
  // two-tangent-arc certificate: try every split point
  let certified = pts.length < 3   // a 2-pt straight loopback is trivially fine
  let bestMaxPieceSweep = pts.length < 3 ? 0 : Infinity
  for (let i = 1; i < pts.length - 1 && !certified; i++) {
    const s1 = pieceSweepDeg(pts.slice(0, i + 1))
    const s2 = pieceSweepDeg(pts.slice(i))
    const worse = Math.max(s1, s2)
    if (worse < bestMaxPieceSweep) bestMaxPieceSweep = worse
    if (s1 <= MAX_ARC_SWEEP_DEG && s2 <= MAX_ARC_SWEEP_DEG) certified = true
  }
  return { jointStartDeg, jointEndDeg, maxInternalTurnDeg, certified, bestMaxPieceSweep }
}

// ---------- fixture loading (same pattern as _visual-dump.test.ts) ----------
function loadFixture(fix: number): { boundary: Loop; holes: Loop[]; helixDiameter: number; name: string } {
  const d = JSON.parse(fs.readFileSync(`test_fixtures/adaptive-clearing/spirals/_cmp/_gt/gt_fix${fix}.json`, 'utf8'))
  return {
    boundary: (d.boundary as number[][]).map(([x, y]) => ({ x, y })),
    holes: (d.islands ?? []).map((isl: number[][]) => isl.map(([x, y]: number[]) => ({ x, y }))),
    helixDiameter: d.helix?.diameter ?? 3,
    name: d.name,
  }
}

function run(fix: number, pct: number): { res: FeatureResult; boundary: Loop; holes: Loop[]; name: string } {
  const { boundary, holes, helixDiameter, name } = loadFixture(fix)
  const res = processFeature({ boundary, holes }, {
    toolRadius: 2.0, stepOver: 0.2, tolerance: 0.1, helixDiameter, stockToLeave: 0.5,
    integralWallFollow: true, wallCleanupAsWeGo: true, loopbackFilletPct: pct,
  })
  return { res, boundary, holes, name }
}

interface CaseReport {
  loopbacks: number
  routed: number
  badJoints: string[]
  reversals: string[]
  uncertified: string[]
  missingLinks: string[]
  verdicts: Map<number, LoopbackVerdict>
}

/** The WO-438 ROUTED keep-down traverses, by pass index. Read from the result rather than from
 *  a flag on the pass, because a discriminator that moves no coordinate must not move the
 *  pass-stream fingerprint (WO-1069 audit, attempt 1). */
function routedIndices(res: FeatureResult): Set<number> {
  return new Set(res.routedLoopbackPassIndices ?? [])
}

function auditCase(res: FeatureResult, label: string): CaseReport {
  const rep: CaseReport = { loopbacks: 0, routed: 0, badJoints: [], reversals: [], uncertified: [], missingLinks: [], verdicts: new Map() }
  const passes = res.passes
  const routed = routedIndices(res)
  for (let i = 0; i < passes.length; i++) {
    const p = passes[i]
    if (p.type === 'loopback' && routed.has(i)) {
      // WO-438 ROUTED KEEP-DOWN TRAVERSE, not a wall-clean fillet chain. It shares the pass
      // type (both are fast_traverse at depth over proven-clear stock) but answers to a
      // different rule: a routed ride is a RAPID and AC-SPEC E.3 lets it backtrack along the
      // cutter's own just-cut track -- an exact 180deg turn BY CONSTRUCTION. Rules (a)/(b)/(c)
      // below are fillet-tangency rules and were never about these. Count them -- and pin the
      // count per case, so the exempt class cannot silently balloon; measure them nowhere else.
      // (WO-438 became the second producer of this pass type in 2026-08 without a
      // discriminator, which is why this guard has read its backtracks as non-tangent fillets
      // since 136306bf -- WO-1069 published `routedLoopbackPassIndices`.)
      rep.routed++
    } else if (p.type === 'loopback') {
      rep.loopbacks++
      const prev = passes[i - 1]
      const next = passes[i + 1]
      const v = measureLoopback(
        prev && 'points' in prev ? (prev.points as Pt[]) : null,
        p.points,
        next && 'points' in next ? (next.points as Pt[]) : null,
      )
      rep.verdicts.set(i, v)
      const at = `(${p.points[0].x.toFixed(2)}, ${p.points[0].y.toFixed(2)})`
      if (v.jointStartDeg > JOINT_SHARP_DEG || v.jointEndDeg > JOINT_SHARP_DEG) {
        rep.badJoints.push(`${label} pass#${i} joints ${v.jointStartDeg.toFixed(1)}/${v.jointEndDeg.toFixed(1)}deg at ${at}`)
      }
      if (v.maxInternalTurnDeg > REVERSAL_DEG) {
        rep.reversals.push(`${label} pass#${i} internal turn ${v.maxInternalTurnDeg.toFixed(1)}deg at ${at}`)
      }
      if (!v.certified) {
        rep.uncertified.push(`${label} pass#${i} no 2-arc split <= ${MAX_ARC_SWEEP_DEG}deg (best ${v.bestMaxPieceSweep.toFixed(1)}deg) at ${at}`)
      }
    } else if (p.type === 'link' && p.jumpType === 1) {
      // straight keep-down link directly between two wall-follows = the loopback fallback;
      // a sharp corner here is the MISSING-reversal defect (must be tangent if it fires at all)
      const prev = passes[i - 1]
      const next = passes[i + 1]
      if (prev?.type === 'wallfollow' && next?.type === 'wallfollow' && dist(p.points[0], p.points[1]) > 1e-9) {
        const tLink = unit(sub(p.points[1], p.points[0]))
        const c1 = angleBetweenDeg(tanAtEnd(prev.points), tLink)
        const c2 = angleBetweenDeg(tLink, tanAtStart(next.points))
        if (c1 > SHARP_DEG || c2 > SHARP_DEG) {
          rep.missingLinks.push(`${label} pass#${i} link corners ${c1.toFixed(1)}/${c2.toFixed(1)}deg at (${p.points[0].x.toFixed(2)}, ${p.points[0].y.toFixed(2)})`)
        }
      }
    }
  }
  return rep
}

// ---------- minimal PNG render (same approach as _visual-dump.test.ts) ----------
class FB {
  buf: Uint8Array; w: number; h: number
  constructor(w: number, h: number, bg: [number, number, number]) {
    this.w = w; this.h = h
    this.buf = new Uint8Array(w * h * 4)
    for (let i = 0; i < w * h; i++) { this.buf[i * 4] = bg[0]; this.buf[i * 4 + 1] = bg[1]; this.buf[i * 4 + 2] = bg[2]; this.buf[i * 4 + 3] = 255 }
  }
  px(x: number, y: number, c: [number, number, number]) {
    x |= 0; y |= 0
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return
    const i = (y * this.w + x) * 4
    this.buf[i] = c[0]; this.buf[i + 1] = c[1]; this.buf[i + 2] = c[2]; this.buf[i + 3] = 255
  }
  dot(x: number, y: number, c: [number, number, number], r = 0) {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) this.px(x + dx, y + dy, c)
  }
  line(x0: number, y0: number, x1: number, y1: number, c: [number, number, number], r = 0) {
    x0 |= 0; y0 |= 0; x1 |= 0; y1 |= 0
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0)
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1
    let err = dx + dy
    for (; ;) {
      this.dot(x0, y0, c, r)
      if (x0 === x1 && y0 === y1) break
      const e2 = 2 * err
      if (e2 >= dy) { err += dy; x0 += sx }
      if (e2 <= dx) { err += dx; y0 += sy }
    }
  }
  png(): Buffer {
    const raw = Buffer.alloc(this.h * (this.w * 4 + 1))
    for (let y = 0; y < this.h; y++) {
      raw[y * (this.w * 4 + 1)] = 0
      this.buf.subarray(y * this.w * 4, (y + 1) * this.w * 4).forEach((v, i) => { raw[y * (this.w * 4 + 1) + 1 + i] = v })
    }
    const idat = zlib.deflateSync(raw)
    const chunk = (type: string, data: Buffer) => {
      const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0)
      const t = Buffer.from(type, 'ascii')
      const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0, 0)
      return Buffer.concat([len, t, data, crc])
    }
    const ihdr = Buffer.alloc(13)
    ihdr.writeUInt32BE(this.w, 0); ihdr.writeUInt32BE(this.h, 4); ihdr[8] = 8; ihdr[9] = 6
    const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
    return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))])
  }
}
function crc32(buf: Buffer): number {
  let c = ~0
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1))
  }
  return ~c
}

/** Render: gray toolpath, fillet pieces green (sweep <= 90) / orange (90..185) / red (defect). */
function renderCase(boundary: Loop, holes: Loop[], res: FeatureResult, rep: CaseReport, out: string): void {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const p of boundary) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y) }
  const pad = 3, S = Math.min(1500 / (maxX - minX + 2 * pad), 1500 / (maxY - minY + 2 * pad))
  const W = Math.ceil((maxX - minX + 2 * pad) * S), H = Math.ceil((maxY - minY + 2 * pad) * S)
  const T = (p: Pt): [number, number] => [(p.x - minX + pad) * S, ((maxY - p.y) + pad) * S]
  const fb = new FB(W, H, [17, 17, 17])
  const drawLoop = (loop: Pt[], c: [number, number, number], close: boolean, r = 0) => {
    for (let i = 1; i < loop.length; i++) { const a = T(loop[i - 1]), b = T(loop[i]); fb.line(a[0], a[1], b[0], b[1], c, r) }
    if (close && loop.length > 2) { const a = T(loop[loop.length - 1]), b = T(loop[0]); fb.line(a[0], a[1], b[0], b[1], c, r) }
  }
  drawLoop(boundary, [120, 120, 120], true)
  for (const h of holes) drawLoop(h, [150, 100, 100], true)
  for (const p of res.passes) if (p.type === 'cut') drawLoop(p.points, [85, 85, 85], false)
  for (const p of res.passes) if (p.type === 'wallfollow') drawLoop(p.points, [60, 110, 110], false)
  const routed = routedIndices(res)
  for (let i = 0; i < res.passes.length; i++) {
    const p = res.passes[i]
    if (p.type !== 'loopback' || routed.has(i)) continue
    const v = rep.verdicts.get(i)
    const bad = !v || !v.certified || v.maxInternalTurnDeg > REVERSAL_DEG
      || v.jointStartDeg > JOINT_SHARP_DEG || v.jointEndDeg > JOINT_SHARP_DEG
    const c: [number, number, number] = bad ? [255, 30, 30]
      : v.bestMaxPieceSweep > 90.5 ? [255, 165, 0] : [40, 220, 60]
    drawLoop(p.points, c, false, bad ? 2 : 1)
  }
  fs.writeFileSync(out, fb.png())
}

// ---------- the guard ----------
describe('loopback fillet regression guard (circle-fit, defect fixtures)', () => {
  beforeAll(async () => { await ensureEngineClipperReady() })

  // `routed` PINS the exempt class (WO-438 keep-down traverses, which are rapids and may
  // backtrack). Rules (a)/(b)/(c) do not measure them, so an unpinned count is an open door:
  // any future change that starts routing MORE rides would silently move loopbacks out of the
  // measured population instead of failing. Re-pin only WITH an attribution line, exactly like
  // goodspec-tripwires -- never to make a red go green.
  // WO-1178 (2026-09-02) re-pin, attributed: the cohesive adaptive close-out changes every
  // fixture's plan (rings ride the wall they touch, the walker plants starts ahead of stock),
  // so the routed keep-down class moves: fix1 Kidney 49 -> 26 and BootL 11 -> 0 at both
  // fillet percentages (fewer connections need routing at all: BootL now makes one lift
  // corpus-wide at the tripwire settings), while fix7 Barbell 28 -> 49 -- its wall band is
  // no longer credited at the convex corners, so more of its transitions cross belief-uncut
  // rim and are routed at depth instead of hopped. (a)/(b)/(c) hold on all four with the
  // measured loopback populations 124 / 189 / 78 / 189.
  // Pre-WO-1178 pins, for the record: fix1 49, fix5 pct25 11, fix7 28, fix5 pct100 11.
  // WO-1178 attempt 3 (Operator's picture gate, 2026-09-02) re-pin, attributed: rings now arrive at
  // a wall on a tangent fillet and leave a planted start on a curvature-limited lead, and two
  // cusp rides that overlap on one wall collapse into one forward ride; every connection is
  // planned from the changed geometry, so the routed keep-down class moves by a few: fix1
  // Kidney 26 -> 27, fix5 BootL 0 -> 1 at both percentages, fix7 Barbell 49 -> 44. (a)/(b)/(c)
  // hold on all four. Census: src/tests/evidence/WO-1178/census.md.
  const CASES: { fix: number; pct: number; routed: number; render?: string }[] = [
    { fix: 1, pct: 25, routed: 27 },
    { fix: 5, pct: 25, routed: 1, render: 'review-images/loopback-fillet-fixed-fix5.png' },
    { fix: 7, pct: 25, routed: 44 },
    { fix: 5, pct: 100, routed: 1, render: 'review-images/loopback-fillet-fixed-pct100-fix5.png' },
  ]

  it('emits only tangent, forward, <=185deg-per-arc loopbacks on the defect fixtures', () => {
    fs.mkdirSync('review-images', { recursive: true })
    const routedMismatches: string[] = []
    for (const c of CASES) {
      const { res, boundary, holes, name } = run(c.fix, c.pct)
      const label = `fix${c.fix} ${name} pct${c.pct}`
      const rep = auditCase(res, label)
      if (c.render) renderCase(boundary, holes, res, rep, c.render)
       
      console.log(`${label}: loopbacks=${rep.loopbacks} routed=${rep.routed} badJoints=${rep.badJoints.length} reversals=${rep.reversals.length} uncertified=${rep.uncertified.length} missingLinks=${rep.missingLinks.length}`)
      // Print EVERY offender, not just the first assertion's list: the four criteria fail in a
      // fixed order, so a red on (d) used to hide whatever (a)/(b)/(c) had to say (WO-1069).
      for (const [k, v] of [['missingLink', rep.missingLinks], ['reversal', rep.reversals], ['badJoint', rep.badJoints], ['uncertified', rep.uncertified]] as [string, string[]][]) {
         
        for (const m of v) console.log(`  ${k}: ${m}`)
      }

      // (d) zero MISSING-reversal links (the straight fallback must be tangent if ever taken)
      expect(rep.missingLinks, rep.missingLinks.join('\n')).toEqual([])
      // (b) no internal reversal (backward mini-traverse / 180deg straight reversal)
      expect(rep.reversals, rep.reversals.join('\n')).toEqual([])
      // (a) tangent joints into the neighbouring wall-follows (token-arc class)
      expect(rep.badJoints, rep.badJoints.join('\n')).toEqual([])
      // (c) every loopback decomposes into two arcs <= 185deg (pigtail / 2pi-wrap class)
      expect(rep.uncertified, rep.uncertified.join('\n')).toEqual([])
      // sanity: the engine still emits a healthy population of loopbacks (not a gate that
      // deletes them -- defect-fix must not be "fixed" by suppressing the feature)
      expect(rep.loopbacks).toBeGreaterThan(50)
      // the exempt class is PINNED, and every index in it must actually name a loopback pass:
      // a stray index would exempt a fillet chain from (a)/(b)/(c) without anything saying so.
      if (rep.routed !== c.routed) routedMismatches.push(`${label}: routed keep-down traverses moved (pinned ${c.routed}, measured ${rep.routed})`)
      for (const i of res.routedLoopbackPassIndices ?? []) {
        expect(res.passes[i]?.type, `${label}: routed index ${i} is not a loopback pass`).toBe('loopback')
      }
    }
    // Asserted once, after every case has run, so a moved pin on the first case never hides
    // the other cases' numbers (the same lesson as the per-offender printing above).
    expect(routedMismatches, routedMismatches.join('\n')).toEqual([])
  }, 600_000)
})
