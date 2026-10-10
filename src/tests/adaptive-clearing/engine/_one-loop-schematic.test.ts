// STANDALONE DIAGNOSTIC SCHEMATIC (render-only, NOT a CI assertion -- gated behind
// SCHEMATIC=1 so the normal suite skips it). This does NOT touch the adaptive engine
// (processFeature etc). It draws ONE idealized canonical "wall-clean loop" unit so a
// human can agree on the design intent + travel direction:
//
//   WALL-FOLLOW ENTRY -> MAIN ARC (cut) -> WALL-FOLLOW EXIT -> FILLETED LOOPBACK
//   (fillet -> fast-traverse -> fillet) -> next arc's WALL-FOLLOW ENTRY.
//
// Direction intent (the engine got this BACKWARDS): single CCW winding, no reversals.
// The cut proceeds forward; the WALL-FOLLOW EXIT rides BEHIND the cut -- back over the
// point where the PREVIOUS arc departed the wall, to clean the cusp the round tool
// leaves -- then the loopback fillets out, fast-traverses, and fillets into the NEXT
// arc's wall-follow entry.
//
// Geometry is constructed analytically (replicating scripts/linking.py's build_transition
// forward-loop SHAPE: lead_out/wall_follow_e/fillet/loopback/fillet/wall_follow_i), reusing
// the engine's own sampleArc() (geometry/index.ts). It is an
// ILLUSTRATION of the unit, not a physically exact toolpath.
//
//   SCHEMATIC=1 npx vitest run src/tests/adaptive-clearing/engine/_one-loop-schematic.test.ts
//
// Output: review-images/one-loop-schematic.png (>=1500px).

import { describe, it } from 'vitest'
import * as fs from 'fs'
import * as zlib from 'zlib'
import { sampleArc } from '../../../lib/cam/geometry'
import type { Vec2 } from '../../../types'

type Pt = Vec2

// ---- tiny 5x7 bitmap font (row = 5-bit mask, MSB = leftmost column) ------------
const GLYPHS: Record<string, number[]> = {
  'A': [0x0E, 0x11, 0x11, 0x1F, 0x11, 0x11, 0x11], 'B': [0x1E, 0x11, 0x11, 0x1E, 0x11, 0x11, 0x1E],
  'C': [0x0E, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0E], 'D': [0x1E, 0x11, 0x11, 0x11, 0x11, 0x11, 0x1E],
  'E': [0x1F, 0x10, 0x10, 0x1E, 0x10, 0x10, 0x1F], 'F': [0x1F, 0x10, 0x10, 0x1E, 0x10, 0x10, 0x10],
  'G': [0x0E, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0F], 'H': [0x11, 0x11, 0x11, 0x1F, 0x11, 0x11, 0x11],
  'I': [0x0E, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0E], 'J': [0x07, 0x02, 0x02, 0x02, 0x12, 0x12, 0x0C],
  'K': [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11], 'L': [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1F],
  'M': [0x11, 0x1B, 0x15, 0x15, 0x11, 0x11, 0x11], 'N': [0x11, 0x19, 0x15, 0x13, 0x11, 0x11, 0x11],
  'O': [0x0E, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0E], 'P': [0x1E, 0x11, 0x11, 0x1E, 0x10, 0x10, 0x10],
  'Q': [0x0E, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0D], 'R': [0x1E, 0x11, 0x11, 0x1E, 0x14, 0x12, 0x11],
  'S': [0x0F, 0x10, 0x10, 0x0E, 0x01, 0x01, 0x1E], 'T': [0x1F, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
  'U': [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0E], 'V': [0x11, 0x11, 0x11, 0x11, 0x11, 0x0A, 0x04],
  'W': [0x11, 0x11, 0x11, 0x15, 0x15, 0x1B, 0x11], 'X': [0x11, 0x11, 0x0A, 0x04, 0x0A, 0x11, 0x11],
  'Y': [0x11, 0x11, 0x0A, 0x04, 0x04, 0x04, 0x04], 'Z': [0x1F, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1F],
  '0': [0x0E, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0E], '1': [0x04, 0x0C, 0x04, 0x04, 0x04, 0x04, 0x0E],
  '2': [0x0E, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1F], '3': [0x1F, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0E],
  '4': [0x02, 0x06, 0x0A, 0x12, 0x1F, 0x02, 0x02], '5': [0x1F, 0x10, 0x1E, 0x01, 0x01, 0x11, 0x0E],
  '6': [0x06, 0x08, 0x10, 0x1E, 0x11, 0x11, 0x0E], '7': [0x1F, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
  '8': [0x0E, 0x11, 0x11, 0x0E, 0x11, 0x11, 0x0E], '9': [0x0E, 0x11, 0x11, 0x0F, 0x01, 0x02, 0x0C],
  ' ': [0, 0, 0, 0, 0, 0, 0], '-': [0x00, 0x00, 0x00, 0x1F, 0x00, 0x00, 0x00],
  '.': [0x00, 0x00, 0x00, 0x00, 0x00, 0x0C, 0x0C], ',': [0x00, 0x00, 0x00, 0x00, 0x0C, 0x04, 0x08],
  ':': [0x00, 0x0C, 0x0C, 0x00, 0x0C, 0x0C, 0x00], '/': [0x01, 0x01, 0x02, 0x04, 0x08, 0x10, 0x10],
  '(': [0x02, 0x04, 0x08, 0x08, 0x08, 0x04, 0x02], ')': [0x08, 0x04, 0x02, 0x02, 0x02, 0x04, 0x08],
  '#': [0x0A, 0x0A, 0x1F, 0x0A, 0x1F, 0x0A, 0x0A], '~': [0x00, 0x00, 0x08, 0x15, 0x02, 0x00, 0x00],
}

// ---- RGBA framebuffer + PNG encoder (draw helpers ported from _visual-dump.test.ts) ----
class FB {
  buf: Uint8Array; w: number; h: number
  constructor(w: number, h: number, bg: [number, number, number]) {
    this.w = w; this.h = h; this.buf = new Uint8Array(w * h * 4)
    for (let i = 0; i < w * h; i++) { this.buf[i * 4] = bg[0]; this.buf[i * 4 + 1] = bg[1]; this.buf[i * 4 + 2] = bg[2]; this.buf[i * 4 + 3] = 255 }
  }
  px(x: number, y: number, c: [number, number, number]) {
    x |= 0; y |= 0
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return
    const i = (y * this.w + x) * 4
    this.buf[i] = c[0]; this.buf[i + 1] = c[1]; this.buf[i + 2] = c[2]; this.buf[i + 3] = 255
  }
  dot(x: number, y: number, c: [number, number, number], r = 0) {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (dx * dx + dy * dy <= r * r + 1) this.px(x + dx, y + dy, c)
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
  rect(x0: number, y0: number, x1: number, y1: number, c: [number, number, number], r = 0) {
    this.line(x0, y0, x1, y0, c, r); this.line(x1, y0, x1, y1, c, r)
    this.line(x1, y1, x0, y1, c, r); this.line(x0, y1, x0, y0, c, r)
  }
  fillRect(x0: number, y0: number, x1: number, y1: number, c: [number, number, number]) {
    for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++)
      for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) this.px(x, y, c)
  }
  dashed(x0: number, y0: number, x1: number, y1: number, c: [number, number, number], on = 6, off = 4, r = 0) {
    const len = Math.hypot(x1 - x0, y1 - y0)
    if (len < 1e-6) return
    const ux = (x1 - x0) / len, uy = (y1 - y0) / len
    for (let d = 0; d < len; d += on + off) {
      const e = Math.min(d + on, len)
      this.line(x0 + ux * d, y0 + uy * d, x0 + ux * e, y0 + uy * e, c, r)
    }
  }
  // filled arrowhead chevron centred at (x,y) pointing along (dx,dy)
  chevron(x: number, y: number, dx: number, dy: number, c: [number, number, number], size = 9) {
    const l = Math.hypot(dx, dy); if (l < 1e-6) return
    const ux = dx / l, uy = dy / l, px = -uy, py = ux, w = size * 0.62
    const tipX = x + ux * size, tipY = y + uy * size
    const baseX = x - ux * size * 0.5, baseY = y - uy * size * 0.5
    this.line(tipX, tipY, baseX + px * w, baseY + py * w, c, 1)
    this.line(tipX, tipY, baseX - px * w, baseY - py * w, c, 1)
  }
  text(str: string, x: number, y: number, c: [number, number, number], scale = 2) {
    let cx = x
    for (const chRaw of str.toUpperCase()) {
      const g = GLYPHS[chRaw]
      if (g) for (let row = 0; row < 7; row++) {
        const bits = g[row]
        for (let col = 0; col < 5; col++) if (bits & (1 << (4 - col)))
          this.fillRect(cx + col * scale, y + row * scale, cx + col * scale + scale - 1, y + row * scale + scale - 1, c)
      }
      cx += 6 * scale
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
  for (let i = 0; i < buf.length; i++) { c ^= buf[i]; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)) }
  return ~c
}

// ---- small vector helpers --------------------------------------------------------
const sub = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y })
const unit = (v: Pt): Pt => { const m = Math.hypot(v.x, v.y) || 1; return { x: v.x / m, y: v.y / m } }
function tangentAtStart(p: Pt[]): Pt { return unit(sub(p[1], p[0])) }
function tangentAtEnd(p: Pt[]): Pt { return unit(sub(p[p.length - 1], p[p.length - 2])) }

// Gate-FREE tangent-arc fillet (same centre construction as the engine's lead
// fillet, but WITHOUT the <=90 lead gate). The loopback is a non-cutting
// reposition U-turn over CLEARED stock; per project_ac_rule_hierarchy a loopback
// may retrace cleared ground, and per linking.py the loopback (exit_fillet /
// entry_fillet) is selected by pick_dot with NO <=90 lead gate -- that gate is for
// LEADS/wall-follow joins only (feedback_ac_fillet_90deg_gate). So the loopback
// fillets here are allowed to sweep past 90deg. Returns the tangent arc p0->p1.
function loopbackArc(p0: Pt, t0: Pt, p1: Pt, t1: Pt, R: number, chordTol: number): { arc: Pt[]; sweepDeg: number } | null {
  const d0 = unit(t0), d1 = unit(t1)
  const dot = Math.max(-1, Math.min(1, d0.x * d1.x + d0.y * d1.y))
  let turnDeg = Math.acos(dot) * 180 / Math.PI
  if (turnDeg < 0.5) return null
  if (turnDeg > 179.5) turnDeg = 179.5
  const crossv = d0.x * d1.y - d0.y * d1.x
  const sgn = crossv >= 0 ? 1 : -1
  const thetaRad = turnDeg * Math.PI / 180
  const t = R * Math.tan(thetaRad / 2)
  // apex = intersection of line(p0,d0) and line(p1,d1)
  const den = d0.x * (-d1.y) - d0.y * (-d1.x)
  let A: Pt, B: Pt
  if (Math.abs(den) > 1e-12) {
    const rx = p1.x - p0.x, ry = p1.y - p0.y
    const s = (rx * (-d1.y) - ry * (-d1.x)) / den
    const apex = { x: p0.x + d0.x * s, y: p0.y + d0.y * s }
    A = { x: apex.x - d0.x * t, y: apex.y - d0.y * t }
    B = { x: apex.x + d1.x * t, y: apex.y + d1.y * t }
  } else { A = p0; B = p1 }
  const O = { x: A.x - d0.y * sgn * R, y: A.y + d0.x * sgn * R }
  const a0 = Math.atan2(A.y - O.y, A.x - O.x)
  const a1 = Math.atan2(B.y - O.y, B.x - O.x)
  const dir: 'CCW' | 'CW' = sgn > 0 ? 'CCW' : 'CW'
  const arc = sampleArc(O, R, a0, a1, dir, Math.max(chordTol, 1e-3))
  arc.push({ x: B.x, y: B.y })
  if (arc.length < 2) return null
  return { arc, sweepDeg: turnDeg }
}

describe.runIf(!!process.env.SCHEMATIC)('one-loop wall-clean schematic', () => {
  it('renders the canonical wall-clean loop unit to PNG', () => {
    // ============================================================================
    // GEOMETRY (mm). World: a CONVEX circular pocket wall (radius RW about WC); the
    // material is on the CONCAVE/INTERIOR side (radius < RW) and the tool centre
    // stays at radius <= RW (never crosses the wall). Travel is a single consistent
    // winding (CW about WC = climb), NO cut reversals.
    //
    // Each MAIN ARC reaches the wall at both ends and bows INTO the material. Two
    // consecutive passes span the SAME wall angles, pass 2 one STEPOVER shallower
    // (nested), so the loopback + the next pass's entry are shown.
    // ============================================================================
    const CHORD = 0.04            // arc sampling chord tolerance (mm)
    const RW = 46                 // CONVEX wall radius (mm); wall centre at origin
    const WC: Pt = { x: 0, y: 0 } // wall (and pocket) centre -- material is INSIDE (r < RW)
    const A_START = 116           // wall angle (deg) at pass-1 main-arc START contact
    const A_END = 64              // wall angle (deg) at pass-1 main-arc END contact (CW travel: angle DECREASES)
    const DEPTH1 = 11.0           // pass-1 bow depth into material (max dip below the wall, mm)
    const STEP = 1.5              // stepover -- pass 2 bows one stepover shallower
    const WF_DEG = 4.6            // wall-follow ride length along the wall (deg of arc)
    const D2R = Math.PI / 180

    // Convex wall: the outer pocket boundary, an arc of radius RW about WC. Material
    // lies on the CONCAVE/INTERIOR side (radius < RW). The tool centre never crosses
    // it (stays at r <= RW). Travel winding is CW about WC (angle decreasing) -- a
    // single consistent climb direction with NO reversals anywhere.
    const wallPt = (deg: number): Pt => ({ x: WC.x + RW * Math.cos(deg * D2R), y: WC.y + RW * Math.sin(deg * D2R) })

    // ---- helper: one MAIN ARC. It starts at the wall (angle aStartDeg), bows INTO
    // the material (dips to radius RW - depth at the mid-angle), and returns to the
    // wall (angle aEndDeg). Modelled as a circular arc through the two wall contacts
    // with the given sagitta toward the pocket centre. Travel is in wall-CW order
    // (aStartDeg -> aEndDeg, angle decreasing). Returned in travel order.
    function mainArc(aStartDeg: number, aEndDeg: number, depth: number): Pt[] {
      const pA = wallPt(aStartDeg), pB = wallPt(aEndDeg)
      const chord = Math.hypot(pB.x - pA.x, pB.y - pA.y)
      const half = chord / 2
      const s = depth                                   // sagitta of the cut arc
      const R = (half * half + s * s) / (2 * s)         // cut-arc radius from sagitta
      const mid: Pt = { x: (pA.x + pB.x) / 2, y: (pA.y + pB.y) / 2 }
      // inward unit normal (toward pocket centre WC) along which the arc bows
      const inN = unit(sub(WC, mid))
      // cut-arc centre sits on the FAR side of the chord from WC, so the arc bulges inward
      const cdist = R - s
      const c: Pt = { x: mid.x - inN.x * cdist, y: mid.y - inN.y * cdist }
      const aA = Math.atan2(pA.y - c.y, pA.x - c.x)
      const aB = Math.atan2(pB.y - c.y, pB.x - c.x)
      // travel pA -> pB bowing toward WC: sample the SHORT arc on the inward side.
      // Pick the direction whose midpoint dips toward WC.
      const tryDir = (dir: 'CCW' | 'CW') => {
        const p = sampleArc(c, R, aA, aB, dir, CHORD); p.push(pB); return p
      }
      const ccw = tryDir('CCW'), cw = tryDir('CW')
      const midR = (pp: Pt[]) => { const m = pp[Math.floor(pp.length / 2)]; return Math.hypot(m.x - WC.x, m.y - WC.y) }
      return midR(ccw) < midR(cw) ? ccw : cw            // the one that dips in(smaller radius) bows into material
    }

    // ---- The two passes span the SAME wall angles; pass 2 bows one STEPOVER
    // SHALLOWER (toward the wall) -- real adaptive nested stepover, not an end-shift.
    // The loopback runs the full pass length: from the EXIT (end-side wall contact)
    // back to the next pass's ENTRY (start-side wall contact). Both cuts travel in
    // the same wall-CW sense (single CCW... here CW-about-centre climb, NO reversal).
    const main1 = mainArc(A_START, A_END, DEPTH1)
    const main2 = mainArc(A_START, A_END, DEPTH1 - STEP)

    // ---- WALL-FOLLOW ENTRY (pass 1): a short ride ALONG the wall arriving at main1's
    // START contact (angle A_START). Comes from the higher-angle side (behind the cut).
    const wfEntry1: Pt[] = sampleArc(WC, RW, (A_START + WF_DEG) * D2R, A_START * D2R, 'CW', CHORD)
    wfEntry1.push(wallPt(A_START))

    // ---- WALL-FOLLOW EXIT (pass 1): departs main1's END contact (angle A_END) and
    // rides a short distance FURTHER ALONG the wall in the SAME travel sense (lower
    // angle), riding back over where the prior arc met the wall plus ~one fillet-
    // radius of overlap -- cleaning the cusp the round tool leaves. NO reversal.
    const A_EXIT = A_END - WF_DEG
    const wfExit1: Pt[] = sampleArc(WC, RW, A_END * D2R, A_EXIT * D2R, 'CW', CHORD)
    wfExit1.push(wallPt(A_EXIT))
    const exitEnd: Pt = wallPt(A_EXIT)

    // ---- WALL-FOLLOW ENTRY (pass 2) -- the loopback's DESTINATION. Identical role
    // to pass-1 entry: a short ride along the wall arriving at main2's START contact.
    const wfEntry2: Pt[] = sampleArc(WC, RW, (A_START + WF_DEG) * D2R, A_START * D2R, 'CW', CHORD)
    wfEntry2.push(wallPt(A_START))
    const entry2Start: Pt = wallPt(A_START + WF_DEG)

    // ============================================================================
    // FILLETED LOOPBACK: fillet OUT of the exit wall-follow -> FAST-TRAVERSE ->
    // fillet INTO the next entry wall-follow (linking.py build_transition: exit_fillet
    // -> loopback straight -> entry_fillet). Because the wall is CONVEX, the exit
    // tangent (at A_EXIT) and the next-entry tangent (at A_START + WF_DEG) point in
    // genuinely different directions, so both loopback fillets are clean <=90deg
    // tangent turns. The fast-traverse chord cuts across the CLEARED interior band
    // between the two passes.
    // ============================================================================
    const tExitOut: Pt = tangentAtEnd(wfExit1)        // travel dir leaving the exit wall-follow
    const tEntryIn: Pt = tangentAtStart(wfEntry2)     // travel dir entering the next wall-follow

    // Fast-traverse endpoints: stand off INWARD from each wall contact (into cleared
    // stock) so the two fillets bracket a straight chord. The chord direction is the
    // loopback travel direction.
    const STANDOFF = 4.0
    const inAtExit = unit(sub(WC, exitEnd))
    const inAtEntry = unit(sub(WC, entry2Start))
    const ftA: Pt = { x: exitEnd.x + inAtExit.x * STANDOFF, y: exitEnd.y + inAtExit.y * STANDOFF }
    const ftB: Pt = { x: entry2Start.x + inAtEntry.x * STANDOFF, y: entry2Start.y + inAtEntry.y * STANDOFF }
    const tFt: Pt = unit(sub(ftB, ftA))               // fast-traverse direction

    // Loopback fillet radius: larger than a lead fillet so the U-turn reads as a
    // smooth peel-off, not a kink (loopbacks are exempt from the <=90 lead gate).
    const Rlb = 2.2
    // The loopback U-turn is a non-cutting reposition that genuinely turns >90, so
    // the <=90 lead gate (feedback_ac_fillet_90deg_gate, AC-SPEC.md) does not apply;
    // use the gate-free loopbackArc.
    const filA = loopbackArc(exitEnd, tExitOut, ftA, tFt, Rlb, CHORD)
    const filB = loopbackArc(ftB, tFt, entry2Start, tEntryIn, Rlb, CHORD)
    const loopbackFilletA: Pt[] = filA ? [exitEnd, ...filA.arc] : [exitEnd, ftA]
    const loopbackFilletB: Pt[] = filB ? [ftB, ...filB.arc] : [ftB, entry2Start]
    const ftStart: Pt = filA ? filA.arc[filA.arc.length - 1] : ftA
    const ftEnd: Pt = filB ? filB.arc[0] : ftB
    const fastTraverse: Pt[] = [ftStart, ftEnd]
    const sweepA = filA ? filA.sweepDeg.toFixed(0) : 'n/a'
    const sweepB = filB ? filB.sweepDeg.toFixed(0) : 'n/a'

    // ---- PART WALL reference (gray): the convex wall arc, drawn well past the unit.
    const wall: Pt[] = sampleArc(WC, RW, (A_START + WF_DEG + 14) * D2R, (A_EXIT - 14) * D2R, 'CW', CHORD)
    wall.push(wallPt(A_EXIT - 14))

    // ============================================================================
    // RENDER
    // ============================================================================
    const allPts = [
      ...wall, ...wfEntry1, ...main1, ...wfExit1, ...loopbackFilletA,
      ...fastTraverse, ...loopbackFilletB, ...wfEntry2, ...main2,
    ]
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const p of allPts) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y) }
    // World margins (mm). Extra TOP room for the title + the top cluster's labels,
    // generous sides so the end-roles + their leader labels never clip.
    const padL = 10, padR = 10, padB = 6, padT = 14
    const LONG = 1900
    const wWorld = (maxX - minX) + padL + padR
    const hWorld = (maxY - minY) + padB + padT
    const S = LONG / Math.max(wWorld, hWorld)
    const W = Math.ceil(wWorld * S), H = Math.ceil(hWorld * S)
    const T = (p: Pt): [number, number] => [(p.x - minX + padL) * S, ((maxY - p.y) + padT) * S]
    const fb = new FB(W, H, [18, 18, 20])

    const COL = {
      wall: [150, 150, 150] as [number, number, number],
      entry: [60, 200, 255] as [number, number, number],     // cyan  -- wall-follow entry
      main: [255, 150, 40] as [number, number, number],       // orange -- main arc (cut)
      exit: [245, 215, 50] as [number, number, number],       // yellow -- wall-follow exit
      fillet: [235, 70, 220] as [number, number, number],     // magenta -- loopback fillet
      ft: [120, 230, 120] as [number, number, number],        // green (dashed) -- fast-traverse
      label: [235, 235, 235] as [number, number, number],
      leader: [120, 120, 120] as [number, number, number],
    }

    const drawPath = (loop: Pt[], c: [number, number, number], r = 2) => {
      for (let i = 1; i < loop.length; i++) { const a = T(loop[i - 1]), b = T(loop[i]); fb.line(a[0], a[1], b[0], b[1], c, r) }
    }
    const dashPath = (loop: Pt[], c: [number, number, number]) => {
      for (let i = 1; i < loop.length; i++) { const a = T(loop[i - 1]), b = T(loop[i]); fb.dashed(a[0], a[1], b[0], b[1], c, 11, 7, 2) }
    }
    const arrowsAlong = (loop: Pt[], c: [number, number, number], stepPx = 95) => {
      let acc = stepPx * 0.55
      for (let i = 1; i < loop.length; i++) {
        const a = T(loop[i - 1]), b = T(loop[i])
        const segLen = Math.hypot(b[0] - a[0], b[1] - a[1])
        if (segLen < 1e-6) continue
        while (acc <= segLen) {
          const t = acc / segLen
          fb.chevron(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, b[0] - a[0], b[1] - a[1], c, 11)
          acc += stepPx
        }
        acc -= segLen
      }
    }

    // wall first (reference), then toolpath roles on top, in travel order.
    drawPath(wall, COL.wall, 1)
    drawPath(wfEntry1, COL.entry, 3)
    drawPath(main1, COL.main, 3)
    drawPath(wfExit1, COL.exit, 3)
    drawPath(loopbackFilletA, COL.fillet, 3)
    dashPath(fastTraverse, COL.ft)
    drawPath(loopbackFilletB, COL.fillet, 3)
    drawPath(wfEntry2, COL.entry, 3)
    drawPath(main2, COL.main, 3)   // next-arc stub (shown as full next arc)

    // direction chevrons along every segment (travel direction)
    arrowsAlong(wfEntry1, [180, 240, 255])
    arrowsAlong(main1, [255, 205, 150])
    arrowsAlong(wfExit1, [255, 240, 150])
    arrowsAlong(loopbackFilletA, [255, 190, 245])
    arrowsAlong(fastTraverse, [190, 255, 190], 80)
    arrowsAlong(loopbackFilletB, [255, 190, 245])
    arrowsAlong(wfEntry2, [180, 240, 255])
    arrowsAlong(main2, [255, 205, 150])

    // ---- LEGEND box (top-right) ----
    const legend: [string, [number, number, number], boolean][] = [
      ['WALL-FOLLOW ENTRY', COL.entry, false],
      ['MAIN ARC (CUT)', COL.main, false],
      ['WALL-FOLLOW EXIT', COL.exit, false],
      ['LOOPBACK FILLET', COL.fillet, false],
      ['FAST-TRAVERSE', COL.ft, true],
      ['PART WALL', COL.wall, false],
    ]
    const lpad = 14, lrow = 34, lsw = 34, lw = 430
    const lh = lpad + legend.length * lrow
    const lx = 24, ly = H - lh - 24            // BOTTOM-LEFT (empty quadrant)
    fb.fillRect(lx, ly, lx + lw, ly + lh, [30, 30, 34])
    fb.rect(lx, ly, lx + lw, ly + lh, [95, 95, 100])
    legend.forEach((row, i) => {
      const yy = ly + lpad + i * lrow + 4
      if (row[2]) fb.dashed(lx + lpad, yy + 7, lx + lpad + lsw, yy + 7, row[1], 8, 5, 2)
      else fb.line(lx + lpad, yy + 7, lx + lpad + lsw, yy + 7, row[1], 2)
      fb.text(row[0], lx + lpad + lsw + 12, yy, COL.label, 3)
    })
    fb.text('AC WALL-CLEAN LOOP -- CANONICAL UNIT (SINGLE WINDING, NO CUT REVERSALS)', 24, 24, COL.label, 3)
    fb.text(`LOOPBACK U-TURN FILLET SWEEP A=${sweepA} B=${sweepB} DEG (LOOPBACK EXEMPT FROM <=90 LEAD GATE)`, 24, 24 + 30, [180, 180, 185], 2)

    // ---- TEXT LABELS w/ leader lines ----
    const labelAt = (anchorWorld: Pt, txt: string, dxPx: number, dyPx: number, c: [number, number, number]) => {
      const a = T(anchorWorld)
      const tx = a[0] + dxPx, ty = a[1] + dyPx
      fb.line(a[0], a[1], tx, ty, COL.leader, 0)
      fb.dot(a[0], a[1], c, 4)
      const w = txt.length * 18 + 10
      fb.fillRect(tx - 4, ty - 3, tx + w, ty + 22, [30, 30, 34])
      fb.rect(tx - 4, ty - 3, tx + w, ty + 22, [80, 80, 84])
      fb.text(txt, tx, ty, c, 3)
    }
    // Left-end cluster (pass-1 entry, pass-2 entry, entry fillet) -- fan the labels
    // up into the empty top band with leaders so they do not overlap each other.
    labelAt(wfEntry1[0], 'WALL-FOLLOW ENTRY (PASS 1)', -70, -160, COL.entry)
    labelAt(wfEntry2[wfEntry2.length - 1], 'NEXT ENTRY (PASS 2 -- LOOPBACK DEST)', 150, -250, COL.entry)
    labelAt(loopbackFilletB[Math.floor(loopbackFilletB.length / 2)], 'LOOPBACK FILLET 2 (ENTRY)', 40, 180, COL.fillet)
    // Centre / cut.
    labelAt(main1[Math.floor(main1.length * 0.42)], 'MAIN ARC (CUT)', -40, 70, COL.main)
    labelAt(fastTraverse[Math.floor(fastTraverse.length / 2)], 'FAST-TRAVERSE (LOOPBACK)', 40, -70, COL.ft)
    // Right-end cluster (pass-1 exit + exit fillet).
    labelAt(wfExit1[wfExit1.length - 1], 'WALL-FOLLOW EXIT (RIDES BEHIND THE CUT)', -560, -200, COL.exit)
    labelAt(loopbackFilletA[Math.floor(loopbackFilletA.length / 2)], 'LOOPBACK FILLET 1 (EXIT)', -560, 110, COL.fillet)

    const OUT_DIR = 'review-images'
    fs.mkdirSync(OUT_DIR, { recursive: true })
    const OUT = `${OUT_DIR}/one-loop-schematic.png`
    fs.writeFileSync(OUT, fb.png())
    // eslint-disable-next-line no-console
    console.log(`wrote ${OUT} ${W}x${H}  filletSweeps A=${sweepA} B=${sweepB} deg`)
  })
})
