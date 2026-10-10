// STANDALONE DIAGNOSTIC RENDER (render-only, NOT a CI assertion -- gated behind
// SIDEBYSIDE=1 so the normal suite skips it). Uses REAL geometry from OUR engine
// (processFeature, the FreeCAD-port in engine/), NOT Fusion ground-truth.
//
// Produces ONE side-by-side PNG of a single real transition (cut arc N -> link ->
// cut arc N+1):
//   LEFT  ("AS EMITTED (no feature)")  -- the two real cut arcs + the real LINK
//          exactly as the engine emits it today (wall-clean OFF).
//   RIGHT ("WALL-CLEAN (correct)")     -- the same two real arcs with the proposed
//          wall-clean built ON THE REAL ARC GEOMETRY: a wall-follow exit that rides
//          the cutRegion boundary FORWARD in the cut's own winding (cleaning the
//          cusp), a tangent fillet (gate-free loopback for the U-turn), and a
//          fast-traverse loopback into cut N+1's entry.
//
//   SIDEBYSIDE=1 npx vitest run src/tests/adaptive-clearing/engine/_sidebyside.test.ts
//
// Output: review-images/new-system-sidebyside.png (>=1800px wide).

import { describe, it, beforeAll } from 'vitest'
import * as fs from 'fs'
import * as zlib from 'zlib'
import { ensureEngineClipperReady, type Loop, type Pt } from '../../../lib/cam/adaptiveClearing2d/engine/clipperEngine'
import { processFeature } from '../../../lib/cam/adaptiveClearing2d/engine/processFeature'
import { buildWallCleanTransition } from '../../../lib/cam/adaptiveClearing2d/engine/wallCleanLoop'
import { importDXF } from '../../../lib/import/dxfImporter'

// ---- tiny 5x7 bitmap font (row = 5-bit mask, MSB = leftmost column) -------------
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
  '#': [0x0A, 0x0A, 0x1F, 0x0A, 0x1F, 0x0A, 0x0A],
  '+': [0x00, 0x04, 0x04, 0x1F, 0x04, 0x04, 0x00],
}

// ---- RGBA framebuffer + PNG encoder (helpers from _visual-dump.test.ts) ----------
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
const dist = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.y - b.y)
const unit = (v: Pt): Pt => { const m = Math.hypot(v.x, v.y) || 1; return { x: v.x / m, y: v.y / m } }
function polyLenLocal(p: Pt[]): number { let s = 0; for (let i = 1; i < p.length; i++) s += dist(p[i], p[i - 1]); return s }

// ---- feature loader (DXF or GT fixture), mirrors _visual-dump.test.ts -------------
function loadFeature(): { boundary: Loop; holes: Loop[]; helixDiameter: number; name: string } {
  const dxfPath = process.env.DXF
  if (dxfPath) {
    const fsx = fs.readFileSync(dxfPath, 'utf8')
    const { loops } = importDXF(fsx)
    const closed = loops.filter(l => l.closed && l.points.length >= 3).sort((a, b) => b.area - a.area)
    if (closed.length === 0) throw new Error(`DXF ${dxfPath} has no closed loops`)
    const toLoop = (pts: { x: number; y: number }[]): Loop => pts.map(p => ({ x: p.x, y: p.y }))
    const boundary = toLoop(closed[0].points)
    const maxIslands = Number(process.env.MAXISLANDS ?? 9999)
    const holes = closed.slice(1).filter(l => l.area > 1).slice(0, maxIslands).map(l => toLoop(l.points))
    return { boundary, holes, helixDiameter: 3, name: dxfPath.split(/[\\/]/).pop() ?? 'dxf' }
  }
  const FIX = process.env.FIX ?? '0'
  const d = JSON.parse(fs.readFileSync(`test_fixtures/adaptive-clearing/spirals/_cmp/_gt/gt_fix${FIX}.json`, 'utf8'))
  return {
    boundary: (d.boundary as number[][]).map(([x, y]) => ({ x, y })),
    holes: (d.islands ?? []).map((isl: number[][]) => isl.map(([x, y]: number[]) => ({ x, y }))),
    helixDiameter: d.helix?.diameter ?? 3,
    name: d.name,
  }
}

// ---- cutRegion contact: nearest distance from a point to any cutRegion loop edge,
// plus the projected foot + the loop index/arc-position (so we can walk the wall). --
interface WallProj { d: number; foot: Pt; loop: number; seg: number; t: number; cum: number }
function nearestOnLoops(p: Pt, loops: Loop[]): WallProj {
  let best: WallProj = { d: Infinity, foot: p, loop: -1, seg: -1, t: 0, cum: 0 }
  for (let li = 0; li < loops.length; li++) {
    const lp = loops[li]
    let cum = 0
    for (let i = 0; i < lp.length; i++) {
      const a = lp[i], b = lp[(i + 1) % lp.length]
      const ab = sub(b, a); const L2 = ab.x * ab.x + ab.y * ab.y
      let t = L2 > 1e-12 ? ((p.x - a.x) * ab.x + (p.y - a.y) * ab.y) / L2 : 0
      t = Math.max(0, Math.min(1, t))
      const foot = { x: a.x + ab.x * t, y: a.y + ab.y * t }
      const d = dist(p, foot)
      if (d < best.d) best = { d, foot, loop: li, seg: i, t, cum: cum + Math.hypot(ab.x, ab.y) * t }
      cum += Math.hypot(ab.x, ab.y)
    }
  }
  return best
}
function loopPerimeter(lp: Loop): number {
  let s = 0
  for (let i = 0; i < lp.length; i++) s += dist(lp[i], lp[(i + 1) % lp.length])
  return s
}
// Signed area of a loop (>0 => CCW in math/y-up coords).
function signedArea(lp: Loop): number {
  let a = 0
  for (let i = 0; i < lp.length; i++) { const p = lp[i], q = lp[(i + 1) % lp.length]; a += p.x * q.y - q.x * p.y }
  return a / 2
}

describe.runIf(!!process.env.SIDEBYSIDE)('new-system wall-clean side-by-side', () => {
  beforeAll(async () => { await ensureEngineClipperReady() })
  it('renders AS-EMITTED vs WALL-CLEAN(correct) for one real transition', () => {
    const { boundary, holes, helixDiameter, name } = loadFeature()
    const STEPOVER = Number(process.env.STEPOVER ?? 0.2)
    const TOOLR = Number(process.env.TOOLR ?? 2.0)
    const params = {
      toolRadius: TOOLR, stepOver: STEPOVER, tolerance: 0.1,
      helixDiameter, stockToLeave: 0.5,
      // wall-clean OFF, integral wall-follow OFF -- baseline emission.
    }
    const res = processFeature({ boundary, holes }, params)
    const passes = res.passes
    const cutRegion = res.cutRegion as Loop[]
    const Rf = 0.5 * TOOLR

    // ---- SEARCH for the representative transition: cut N -> link -> cut N+1 where
    // BOTH N's wall-contact end and N+1's wall-contact start lie within ~0.3mm of the
    // cutRegion AND the along-wall gap between the two contacts is short (a genuine
    // adjacent wall cusp). For each cut pass we test BOTH ends for wall proximity.
    const WALL_TOL = Number(process.env.WALLTOL ?? 0.35)
    type Cand = {
      ni: number; npi: number; linkI: number
      arcN: Pt[]; arcN1: Pt[]
      // wall-contact end of N and wall-contact start of N+1
      nContact: Pt; nContactProj: WallProj; nContactIsEnd: boolean
      n1Contact: Pt; n1ContactProj: WallProj; n1ContactIsStart: boolean
      wallGap: number
    }
    const cands: Cand[] = []
    for (let i = 0; i < passes.length; i++) {
      if (passes[i].type !== 'cut') continue
      // find next cut after i, and require the in-between to contain a link
      let j = i + 1
      let sawLink = false
      while (j < passes.length && passes[j].type !== 'cut') { if (passes[j].type === 'link') sawLink = true; j++ }
      if (j >= passes.length) break
      if (!sawLink) continue
      const linkI = (() => { for (let k = i + 1; k < j; k++) if (passes[k].type === 'link') return k; return -1 })()
      const arcN = (passes[i] as { points: Pt[] }).points
      const arcN1 = (passes[j] as { points: Pt[] }).points
      if (arcN.length < 2 || arcN1.length < 2) continue
      // Which end of N reaches the wall? Prefer the END (forward travel ends at wall).
      const nEndProj = nearestOnLoops(arcN[arcN.length - 1], cutRegion)
      const nStartProj = nearestOnLoops(arcN[0], cutRegion)
      const nContactIsEnd = nEndProj.d <= nStartProj.d
      const nContact = nContactIsEnd ? arcN[arcN.length - 1] : arcN[0]
      const nContactProj = nContactIsEnd ? nEndProj : nStartProj
      // Which end of N+1 reaches the wall? Prefer the START (forward travel begins at wall).
      const n1StartProj = nearestOnLoops(arcN1[0], cutRegion)
      const n1EndProj = nearestOnLoops(arcN1[arcN1.length - 1], cutRegion)
      const n1ContactIsStart = n1StartProj.d <= n1EndProj.d
      const n1Contact = n1ContactIsStart ? arcN1[0] : arcN1[arcN1.length - 1]
      const n1ContactProj = n1ContactIsStart ? n1StartProj : n1EndProj
      if (nContactProj.d > WALL_TOL || n1ContactProj.d > WALL_TOL) continue
      // along-wall gap: only meaningful if both feet are on the SAME cutRegion loop.
      if (nContactProj.loop !== n1ContactProj.loop) continue
      const lp = cutRegion[nContactProj.loop]
      const per = loopPerimeter(lp)
      const raw = Math.abs(nContactProj.cum - n1ContactProj.cum)
      const wallGap = Math.min(raw, per - raw)
      cands.push({ ni: i, npi: j, linkI, arcN, arcN1, nContact, nContactProj, nContactIsEnd, n1Contact, n1ContactProj, n1ContactIsStart, wallGap })
    }
    // A genuine adjacent wall cusp has a gap on the order of the stepover (the tool
    // leaves a sliver between two adjacent passes that both reach the wall), NOT a
    // near-zero gap (coincident endpoints = the same arc continuing) and NOT a long
    // run (different region). Rank by closeness to the stepover distance, within a
    // sane band, then by tightest wall contact. Also require the two contacts to be
    // genuinely distinct points (the two passes are separate, not one arc split).
    const stepMM = 2 * TOOLR * STEPOVER          // nominal stepover (mm)
    const GAP_MIN = Math.max(0.3, 0.4 * stepMM)  // floor: below this the arcs are ~coincident
    const GAP_MAX = 4 * stepMM                   // ceiling: above this it's not an adjacent cusp
    const inBand = cands.filter(c => c.wallGap >= GAP_MIN && c.wallGap <= GAP_MAX && dist(c.nContact, c.n1Contact) >= GAP_MIN)
    const pool = inBand.length ? inBand : cands
    // IMPORTANT HONESTY NOTE: the engine's pass stream is NOT byte-deterministic
    // run-to-run (a clipper/set-iteration ordering property) -- the EXACT arcs and pass
    // indices jitter, so neither pass index nor an exact cusp coordinate reproduces.
    // To make this DIAGNOSTIC stable we anchor on a FIXED WORLD TARGET and pick the
    // in-band candidate whose cusp is nearest it: the same physical region of the part
    // every run, with a clean stepover-sized adjacent cusp. TARGET="x,y" overrides it;
    // default points at the lower-left wall run where adjacent end-cusps are abundant.
    const tgtEnv = (process.env.TARGET ?? '-11,19.5').split(',').map(Number)
    const TARGET: Pt = { x: tgtEnv[0], y: tgtEnv[1] }
    const gapErrBucket = (c: Cand) => Math.round(Math.abs(c.wallGap - stepMM) / 0.05)
    pool.sort((a, b) =>
      (gapErrBucket(a) - gapErrBucket(b)) ||
      (dist(a.nContact, TARGET) - dist(b.nContact, TARGET)) ||
      ((a.nContactProj.d + a.n1ContactProj.d) - (b.nContactProj.d + b.n1ContactProj.d)))
    cands.length = 0; cands.push(...pool)
    // eslint-disable-next-line no-console
    console.log(`stepover=${stepMM.toFixed(3)}mm GAP band=[${GAP_MIN.toFixed(2)}, ${GAP_MAX.toFixed(2)}]mm -> ${inBand.length} in-band (showing best)`)
    // eslint-disable-next-line no-console
    console.log(`[${name}] passes=${passes.length} cut=${passes.filter(p => p.type === 'cut').length} link=${passes.filter(p => p.type === 'link').length} | adjacent wall-reaching candidates=${cands.length} (WALL_TOL=${WALL_TOL})`)
    if (cands.length === 0) throw new Error('no clean wall-reaching adjacent triple found -- try fallback FIX=0 or raise WALLTOL')
    // Allow manual pick via PICK=k (rank index), else the best.
    const pick = cands[Number(process.env.PICK ?? 0)]
    const { arcN, arcN1, nContactProj, n1ContactProj, wallGap } = pick

    // ---- Identify the PRIOR-arc wall contact so we can verify the along-wall ORDER of
    // the three contacts (prior, N, N+1) and confirm the wall-follow rides BACK toward
    // the prior one (behind the cut). Pass ORDERING jitters run-to-run, so we find it
    // GEOMETRICALLY: among all OTHER cut passes whose wall-end lands on the SAME loop,
    // the one whose contact is the nearest neighbour to N's contact OPPOSITE the N+1
    // side (i.e. on the far side from N+1) is the prior adjacent cusp.
    let priorContactProj: WallProj | null = null
    let priorContact: Pt | null = null
    {
      // unit step along the wall from N+1's contact toward N's contact = the cut's
      // advance direction projected onto the wall; the prior cusp continues past N.
      const towardN = unit(sub(pick.nContact, pick.n1Contact))
      let bestD = Infinity
      for (let i = 0; i < passes.length; i++) {
        if (i === pick.ni || i === pick.npi || passes[i].type !== 'cut') continue
        const pp = (passes[i] as { points: Pt[] }).points
        if (pp.length < 2) continue
        const e = nearestOnLoops(pp[pp.length - 1], cutRegion)
        const s = nearestOnLoops(pp[0], cutRegion)
        const proj = e.d <= s.d ? e : s
        const pt = e.d <= s.d ? pp[pp.length - 1] : pp[0]
        if (proj.loop !== nContactProj.loop || proj.d > WALL_TOL) continue
        // require it to sit FURTHER along the wall past N (the advance direction)
        const ahead = (pt.x - pick.nContact.x) * towardN.x + (pt.y - pick.nContact.y) * towardN.y
        if (ahead <= 0.05) continue
        const d = dist(pt, pick.nContact)
        if (d < bestD) { bestD = d; priorContactProj = proj; priorContact = pt }
      }
    }

    // ---- WINDING sense of the cutRegion wall loop and the cut travel along it.
    const wallLoop = cutRegion[nContactProj.loop]
    const wallAreaSigned = signedArea(wallLoop)   // >0 = CCW (y-up)
    const wallCCW = wallAreaSigned > 0

    // ============================================================================
    // BUILD THE WALL-CLEAN via the SHARED, TRIMMED builder (Step 2: the diagnostic now
    // renders the SAME geometry the engine emits). Orient the two arcs so the prior cut
    // ENDS at its wall contact (A) and the next cut STARTS at its wall contact (B) -- the
    // production convention in processFeature appendCutPass -- then call the builder.
    // ============================================================================
    const per = loopPerimeter(wallLoop)
    // Orient ONLY the prior cut so its LAST point is its wall contact (= A, the literal
    // cut-end the production caller hands the builder). The next cut is passed AS-IS so its
    // FIRST point is the genuine next-pass START (= B / the entry-delivery target) -- which
    // is exactly what processFeature passes (prevCut.points[last] -> A, points[0] -> B).
    const priorOriented = pick.nContactIsEnd ? arcN : [...arcN].reverse()
    const nextOriented = arcN1
    const overlap = 1.5 * Rf
    const nextEntry: Pt = nextOriented[0]
    const built = buildWallCleanTransition(priorOriented, nextOriented, cutRegion, TOOLR, 0.04)
    if (!built) throw new Error("buildWallCleanTransition returned null for the picked transition")
    const wallRide = built.exit
    const loopbackFilletA = built.fillet1
    const fastTraverse = built.traverse
    const loopbackFilletB = built.fillet2
    const wallEntry = built.entry
    const rideLen = polyLenLocal(wallRide)
    const rideSign = 1
    const Rlb = Math.max(Rf, 1.0)
    const sweepA = NaN
    const sweepB = NaN

    // ============================================================================
    // REPORT (printed to console for the compact review).
    // ============================================================================
    const f3 = (n: number) => n.toFixed(3)
    const rep = (label: string, p: Pt, d: number) => `${label}=(${f3(p.x)}, ${f3(p.y)}) d2wall=${f3(d)}mm`
    // eslint-disable-next-line no-console
    console.log('==== SIDE-BY-SIDE REPORT ====')
    // eslint-disable-next-line no-console
    console.log(`fixture=${name}  pass N index=${pick.ni}  link index=${pick.linkI}  pass N+1 index=${pick.npi}`)
    // eslint-disable-next-line no-console
    console.log(`PASS N : ${rep('start', arcN[0], nearestOnLoops(arcN[0], cutRegion).d)} | ${rep('end', arcN[arcN.length - 1], nearestOnLoops(arcN[arcN.length - 1], cutRegion).d)}  -> wall contact = ${pick.nContactIsEnd ? 'END' : 'START'}`)
    // eslint-disable-next-line no-console
    console.log(`PASS N+1: ${rep('start', arcN1[0], nearestOnLoops(arcN1[0], cutRegion).d)} | ${rep('end', arcN1[arcN1.length - 1], nearestOnLoops(arcN1[arcN1.length - 1], cutRegion).d)}  -> wall contact = ${pick.n1ContactIsStart ? 'START' : 'END'}`)
    // eslint-disable-next-line no-console
    console.log(`wall loop ${nContactProj.loop}: winding=${wallCCW ? 'CCW' : 'CW'} (signedArea=${f3(wallAreaSigned)})  perimeter=${f3(per)}mm`)
    // eslint-disable-next-line no-console
    console.log(`along-wall gap (N contact -> N+1 contact) = ${f3(wallGap)}mm`)
    if (priorContactProj && priorContact) {
      // eslint-disable-next-line no-console
      console.log(`THREE wall contacts (along the wall): PRIOR=(${f3(priorContact.x)}, ${f3(priorContact.y)}) cum=${f3(priorContactProj.cum)} | N=(${f3(pick.nContact.x)}, ${f3(pick.nContact.y)}) cum=${f3(nContactProj.cum)} | N+1=(${f3(pick.n1Contact.x)}, ${f3(pick.n1Contact.y)}) cum=${f3(n1ContactProj.cum)}`)
      // eslint-disable-next-line no-console
      console.log(`  -> wall-follow exit rides from N's contact TOWARD the PRIOR contact (behind the cut); next cut N+1 is on the OTHER side (cut advances N+1 -> N -> prior).`)
    } else {
      // eslint-disable-next-line no-console
      console.log(`PRIOR-arc wall contact: none found adjacent on this loop (N is near the start of this wall run); ride direction taken from N's own travel tangent.`)
    }
    // eslint-disable-next-line no-console
    console.log(`wall-follow ride: sign=${rideSign > 0 ? '+cum' : '-cum'}  L_wf=${f3(rideLen)}mm = max(gap ${f3(wallGap)} + overlap ${f3(overlap)}, 3.0) clamped to 0.25*per(${f3(0.25 * per)})`)
    // eslint-disable-next-line no-console
    console.log(`loopback fillet sweeps: A=${isNaN(sweepA) ? 'n/a' : sweepA.toFixed(1)}deg  B=${isNaN(sweepB) ? 'n/a' : sweepB.toFixed(1)}deg  (Rf=${f3(Rf)}, Rlb=${f3(Rlb)})`)
    // eslint-disable-next-line no-console
    console.log(`real LINK as emitted: jumpType=${(passes[pick.linkI] as { jumpType: number }).jumpType} (1=keep-down/fast-traverse, 2=lift)`)
    // ---- CHAIN JUNCTION DUMP (RIGHT panel) -- listed in order so coincidence is checkable.
    const pp = (p: Pt) => `(${f3(p.x)}, ${f3(p.y)})`
    const last = (a: Pt[]) => a[a.length - 1]
    const gap = (a: Pt, b: Pt) => dist(a, b)
    // eslint-disable-next-line no-console
    console.log('==== WALL-CLEAN CHAIN JUNCTIONS (each piece must start where the previous ended) ====')
    // eslint-disable-next-line no-console
    console.log(`  arc N end           = ${pp(last(arcN))}`)
    // eslint-disable-next-line no-console
    console.log(`  wall-follow EXIT    : start ${pp(wallRide[0])}  end ${pp(last(wallRide))}   [gap arcN.end->exit.start = ${f3(gap(last(arcN), wallRide[0]))}mm]`)
    // eslint-disable-next-line no-console
    console.log(`  FILLET 1            : start ${pp(loopbackFilletA[0])}  end ${pp(last(loopbackFilletA))}   [gap exit.end->fil1.start = ${f3(gap(last(wallRide), loopbackFilletA[0]))}mm]`)
    // eslint-disable-next-line no-console
    console.log(`  FAST-TRAVERSE       : start ${pp(fastTraverse[0])}  end ${pp(last(fastTraverse))}   [gap fil1.end->ft.start = ${f3(gap(last(loopbackFilletA), fastTraverse[0]))}mm]`)
    // eslint-disable-next-line no-console
    console.log(`  FILLET 2            : start ${pp(loopbackFilletB[0])}  end ${pp(last(loopbackFilletB))}   [gap ft.end->fil2.start = ${f3(gap(last(fastTraverse), loopbackFilletB[0]))}mm]`)
    // eslint-disable-next-line no-console
    console.log(`  wall-follow ENTRY   : start ${pp(wallEntry[0])}  end ${pp(last(wallEntry))}   [gap fil2.end->entry.start = ${f3(gap(last(loopbackFilletB), wallEntry[0]))}mm]`)
    // eslint-disable-next-line no-console
    console.log(`  arc N+1 start       = ${pp(arcN1[0])}   [gap entry.end->arcN1.start = ${f3(gap(last(wallEntry), arcN1[0]))}mm]`)

    // ============================================================================
    // RENDER -- two panels sharing one world->screen transform (same zoom), drawn
    // side by side. World window = bbox of {arcN, arcN1, wallRide, loopback} + pad.
    // ============================================================================
    const link = passes[pick.linkI] as { type: 'link'; points: [Pt, Pt]; jumpType: 1 | 2 }
    const allWorld: Pt[] = [
      ...arcN, ...arcN1, ...wallRide, ...loopbackFilletA, ...fastTraverse, ...loopbackFilletB,
      ...wallEntry, link.points[0], link.points[1],
    ]
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const p of allWorld) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y) }
    const padMM = 3
    minX -= padMM; minY -= padMM; maxX += padMM; maxY += padMM
    const wW = maxX - minX, wH = maxY - minY
    const PANEL = 1120                     // px per panel (drawing area) -> >=1800px total
    const TOPBAR = 70                      // px reserved at top for panel title
    const S = Math.min(PANEL / wW, (PANEL - TOPBAR) / wH)
    const drawW = Math.ceil(wW * S), drawH = Math.ceil(wH * S)
    const GAP = 48
    const W = drawW * 2 + GAP * 3
    const H = drawH + TOPBAR + 120         // top title band + bottom legend band
    const fb = new FB(W, H, [16, 16, 18])

    const COL = {
      cut: [78, 166, 255] as [number, number, number],
      wall: [140, 140, 140] as [number, number, number],
      island: [180, 120, 120] as [number, number, number],
      traverse: [255, 196, 40] as [number, number, number],     // amber dashed (keep-down)
      lift: [230, 40, 50] as [number, number, number],          // red (lift)
      wallfollow: [0, 208, 160] as [number, number, number],    // teal
      fillet: [235, 70, 220] as [number, number, number],       // magenta
      label: [235, 235, 235] as [number, number, number],
      leader: [120, 120, 120] as [number, number, number],
      panel: [95, 95, 100] as [number, number, number],
    }

    // panel origin (px) -> world transform; ox = left px of this panel's drawing area
    const makeT = (ox: number) => (p: Pt): [number, number] =>
      [ox + (p.x - minX) * S, TOPBAR + (maxY - p.y) * S]

    const drawPath = (T: (p: Pt) => [number, number], loop: Pt[], c: [number, number, number], r = 1, close = false) => {
      for (let i = 1; i < loop.length; i++) { const a = T(loop[i - 1]), b = T(loop[i]); fb.line(a[0], a[1], b[0], b[1], c, r) }
      if (close && loop.length > 2) { const a = T(loop[loop.length - 1]), b = T(loop[0]); fb.line(a[0], a[1], b[0], b[1], c, r) }
    }
    const dashPath = (T: (p: Pt) => [number, number], loop: Pt[], c: [number, number, number]) => {
      for (let i = 1; i < loop.length; i++) { const a = T(loop[i - 1]), b = T(loop[i]); fb.dashed(a[0], a[1], b[0], b[1], c, 9, 6, 1) }
    }
    const arrowsAlong = (T: (p: Pt) => [number, number], loop: Pt[], c: [number, number, number], stepPx = 60) => {
      let acc = stepPx * 0.5
      for (let i = 1; i < loop.length; i++) {
        const a = T(loop[i - 1]), b = T(loop[i])
        const segLen = Math.hypot(b[0] - a[0], b[1] - a[1])
        if (segLen < 1e-6) continue
        while (acc <= segLen) {
          const t = acc / segLen
          fb.chevron(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, b[0] - a[0], b[1] - a[1], c, 9)
          acc += stepPx
        }
        acc -= segLen
      }
    }
    // draw cutRegion wall loops that intersect the window (just draw all; clipping by px happens in px())
    const drawWall = (T: (p: Pt) => [number, number]) => {
      for (const lp of cutRegion) drawPath(T, lp, COL.wall, 0, true)
      for (const h of holes) drawPath(T, h, COL.island, 0, true)
    }

    // ---- LEFT panel: AS EMITTED ----
    const ox0 = GAP
    const T0 = makeT(ox0)
    drawWall(T0)
    drawPath(T0, arcN, COL.cut, 2)
    drawPath(T0, arcN1, COL.cut, 2)
    // the real link exactly as emitted, colored by jumpType
    if (link.jumpType === 1) dashPath(T0, link.points, COL.traverse)
    else drawPath(T0, link.points, COL.lift, 2)
    arrowsAlong(T0, arcN, [200, 220, 255])
    arrowsAlong(T0, arcN1, [200, 220, 255])
    arrowsAlong(T0, link.points, link.jumpType === 1 ? COL.traverse : COL.lift, 50)

    // ---- RIGHT panel: WALL-CLEAN (correct) ----
    const ox1 = GAP + drawW + GAP
    const T1 = makeT(ox1)
    drawWall(T1)
    drawPath(T1, arcN, COL.cut, 2)
    drawPath(T1, arcN1, COL.cut, 2)
    drawPath(T1, wallRide, COL.wallfollow, 2)
    drawPath(T1, loopbackFilletA, COL.fillet, 2)
    dashPath(T1, fastTraverse, COL.traverse)
    drawPath(T1, loopbackFilletB, COL.fillet, 2)
    drawPath(T1, wallEntry, COL.wallfollow, 2)
    arrowsAlong(T1, arcN, [200, 220, 255])
    arrowsAlong(T1, arcN1, [200, 220, 255])
    arrowsAlong(T1, wallRide, [120, 255, 220], 45)
    arrowsAlong(T1, loopbackFilletA, [255, 190, 245], 45)
    arrowsAlong(T1, fastTraverse, COL.traverse, 55)
    arrowsAlong(T1, loopbackFilletB, [255, 190, 245], 45)
    arrowsAlong(T1, wallEntry, [120, 255, 220], 45)

    // panel borders + titles
    fb.rect(ox0 - 6, TOPBAR - 6, ox0 + drawW + 6, TOPBAR + drawH + 6, COL.panel)
    fb.rect(ox1 - 6, TOPBAR - 6, ox1 + drawW + 6, TOPBAR + drawH + 6, COL.panel)
    fb.text('AS EMITTED (NO FEATURE)', ox0 + 8, 22, COL.label, 3)
    fb.text('WALL-CLEAN (CORRECT)', ox1 + 8, 22, COL.label, 3)

    // ====== FIX 1: label placement that keeps text OFF geometry ======================
    // A label box must not overlap (a) any drawn toolpath polyline, (b) the part-wall
    // polyline, or (c) another label box. We build obstacle segments in PIXEL space per
    // panel, then for each label search a ring of candidate offsets around its anchor and
    // pick the first clear slot; a thin leader connects the box back to its anchor point.
    type Box = { x0: number; y0: number; x1: number; y1: number }
    type Seg = { ax: number; ay: number; bx: number; by: number }
    const segsOf = (T: (p: Pt) => [number, number], loop: Pt[], close = false): Seg[] => {
      const out: Seg[] = []
      for (let i = 1; i < loop.length; i++) { const a = T(loop[i - 1]), b = T(loop[i]); out.push({ ax: a[0], ay: a[1], bx: b[0], by: b[1] }) }
      if (close && loop.length > 2) { const a = T(loop[loop.length - 1]), b = T(loop[0]); out.push({ ax: a[0], ay: a[1], bx: b[0], by: b[1] }) }
      return out
    }
    // distance from point to a segment (px)
    const ptSeg = (px: number, py: number, s: Seg): number => {
      const vx = s.bx - s.ax, vy = s.by - s.ay
      const L2 = vx * vx + vy * vy
      let t = L2 > 1e-9 ? ((px - s.ax) * vx + (py - s.ay) * vy) / L2 : 0
      t = Math.max(0, Math.min(1, t))
      const fx = s.ax + vx * t, fy = s.ay + vy * t
      return Math.hypot(px - fx, py - fy)
    }
    // does a box come within `clr` px of any obstacle segment? (sample the box perimeter)
    const boxHitsSegs = (b: Box, segs: Seg[], clr: number): boolean => {
      const pts: [number, number][] = []
      const step = 8
      for (let x = b.x0; x <= b.x1; x += step) { pts.push([x, b.y0]); pts.push([x, b.y1]) }
      for (let y = b.y0; y <= b.y1; y += step) { pts.push([b.x0, y]); pts.push([b.x1, y]) }
      pts.push([(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2])
      for (const s of segs) for (const [px, py] of pts) if (ptSeg(px, py, s) < clr) return true
      return false
    }
    const boxOverlap = (a: Box, b: Box): boolean =>
      a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0
    // Build obstacle segment lists per panel.
    const obstaclesFor = (T: (p: Pt) => [number, number], paths: Pt[][]): Seg[] => {
      let segs: Seg[] = []
      for (const lp of cutRegion) segs = segs.concat(segsOf(T, lp, true))
      for (const h of holes) segs = segs.concat(segsOf(T, h, true))
      for (const p of paths) segs = segs.concat(segsOf(T, p))
      return segs
    }
    // Place one label: anchor (world pt), text, colour. Searches a ring of offsets, scoring
    // each clear candidate by how far it sits from geometry (prefer the clearest), with a
    // bias toward shorter leaders. Mutates `placed` with the chosen box. drawn now.
    const placeLabel = (
      T: (p: Pt) => [number, number], obstacles: Seg[], placed: Box[],
      anchor: Pt, txt: string, c: [number, number, number],
    ) => {
      const a = T(anchor)
      const w = txt.length * 12 + 12, hgt = 20
      // candidate ring: 16 directions x several radii (push toward open space).
      const radii = [54, 78, 104, 132, 164, 200, 240]
      const dirs = 16
      let best: Box | null = null
      let bestScore = -Infinity
      for (const R of radii) {
        for (let k = 0; k < dirs; k++) {
          const ang = (k / dirs) * Math.PI * 2
          let tx = a[0] + Math.cos(ang) * R - w / 2
          let ty = a[1] + Math.sin(ang) * R - hgt / 2
          tx = Math.max(8, Math.min(tx, W - w - 8))
          ty = Math.max(TOPBAR + 6, Math.min(ty, H - 110 - hgt))
          const box: Box = { x0: tx - 3, y0: ty - 2, x1: tx + w, y1: ty + 16 }
          if (boxHitsSegs(box, obstacles, 6)) continue
          if (placed.some(p => boxOverlap(box, p))) continue
          // score: prefer clear (already guaranteed), nearer anchor (shorter leader),
          // and a generous margin from geometry. Use min distance to obstacles as margin.
          let margin = Infinity
          const cx = (box.x0 + box.x1) / 2, cy = (box.y0 + box.y1) / 2
          for (const s of obstacles) { const d = ptSeg(cx, cy, s); if (d < margin) margin = d }
          const leaderLen = Math.hypot(cx - a[0], cy - a[1])
          const score = margin - leaderLen * 0.35
          if (score > bestScore) { bestScore = score; best = box }
        }
        if (best) break   // first radius that yields any clear slot wins (shortest leader)
      }
      // Fallback: if nothing clear was found, take the farthest-from-geometry clamped slot.
      if (!best) {
        const tx = Math.max(8, Math.min(a[0] + 60, W - w - 8))
        const ty = Math.max(TOPBAR + 6, Math.min(a[1] - 60, H - 110 - hgt))
        best = { x0: tx - 3, y0: ty - 2, x1: tx + w, y1: ty + 16 }
      }
      placed.push(best)
      // leader from the nearest box edge-midpoint to the anchor
      const cx = (best.x0 + best.x1) / 2, cy = (best.y0 + best.y1) / 2
      fb.line(a[0], a[1], cx, cy, COL.leader, 0)
      fb.dot(a[0], a[1], c, 3)
      fb.fillRect(best.x0, best.y0, best.x1, best.y1, [28, 28, 30])
      fb.rect(best.x0, best.y0, best.x1, best.y1, [70, 70, 74])
      fb.text(txt, best.x0 + 3, best.y0 + 2, c, 2)
    }
    // LEFT panel labels (anchors on the real arcs + the real link).
    {
      const obst = obstaclesFor(T0, [arcN, arcN1, link.points])
      const placed: Box[] = []
      placeLabel(T0, obst, placed, arcN[Math.floor(arcN.length * 0.5)], 'CUT ARC N', COL.cut)
      placeLabel(T0, obst, placed, arcN1[Math.floor(arcN1.length * 0.5)], 'CUT ARC N+1', COL.cut)
      placeLabel(T0, obst, placed, link.points[1], 'LINK (AS EMITTED)', link.jumpType === 1 ? COL.traverse : COL.lift)
    }
    // RIGHT panel labels (anchors on the constructed wall-clean chain).
    {
      const obst = obstaclesFor(T1, [arcN, arcN1, wallRide, loopbackFilletA, fastTraverse, loopbackFilletB, wallEntry])
      const placed: Box[] = []
      placeLabel(T1, obst, placed, wallRide[Math.floor(wallRide.length * 0.5)], 'WALL-FOLLOW EXIT', COL.wallfollow)
      placeLabel(T1, obst, placed, loopbackFilletA[Math.floor(loopbackFilletA.length * 0.5)], 'FILLET 1', COL.fillet)
      placeLabel(T1, obst, placed, fastTraverse[Math.floor(fastTraverse.length * 0.5)] ?? fastTraverse[0], 'FAST-TRAVERSE LOOPBACK', COL.traverse)
      placeLabel(T1, obst, placed, loopbackFilletB[Math.floor(loopbackFilletB.length * 0.5)], 'FILLET 2', COL.fillet)
      placeLabel(T1, obst, placed, wallEntry[Math.floor(wallEntry.length * 0.5)], 'WALL-FOLLOW ENTRY', COL.wallfollow)
      placeLabel(T1, obst, placed, nextEntry, 'CUT N+1 START', COL.cut)
    }

    // ---- SHARED LEGEND (bottom band) ----
    const legend: [string, [number, number, number], boolean][] = [
      ['CUT ARC (REAL)', COL.cut, false],
      ['WALL-FOLLOW', COL.wallfollow, false],
      ['LOOPBACK FILLET', COL.fillet, false],
      ['FAST-TRAVERSE (KEEP-DOWN)', COL.traverse, true],
      ['LIFT LINK', COL.lift, false],
      ['PART WALL (CUTREGION)', COL.wall, false],
    ]
    const ly = H - 96
    let lx = GAP
    fb.fillRect(GAP - 8, ly - 12, W - GAP + 8, ly + 70, [26, 26, 28])
    fb.rect(GAP - 8, ly - 12, W - GAP + 8, ly + 70, COL.panel)
    let col = 0
    legend.forEach((rowEntry) => {
      const cx = lx + (col % 3) * 560
      const cy = ly + Math.floor(col / 3) * 36
      if (rowEntry[2]) fb.dashed(cx, cy + 7, cx + 34, cy + 7, rowEntry[1], 8, 5, 2)
      else fb.line(cx, cy + 7, cx + 34, cy + 7, rowEntry[1], 2)
      fb.text(rowEntry[0], cx + 44, cy, COL.label, 2)
      col++
    })
    void lx
    // title line under legend
    fb.text(`${name}  N=${pick.ni}/N+1=${pick.npi}  WALL=${wallCCW ? 'CCW' : 'CW'}  GAP=${wallGap.toFixed(2)}MM  WF=${rideLen.toFixed(2)}MM  FILLET A=${isNaN(sweepA) ? 'NA' : sweepA.toFixed(0)}/B=${isNaN(sweepB) ? 'NA' : sweepB.toFixed(0)}DEG`, GAP, ly + 78, [180, 180, 185], 2)

    const OUT_DIR = 'review-images'
    fs.mkdirSync(OUT_DIR, { recursive: true })
    const OUT = `${OUT_DIR}/new-system-sidebyside.png`
    fs.writeFileSync(OUT, fb.png())
    // eslint-disable-next-line no-console
    console.log(`wrote ${OUT} ${W}x${H}`)
  }, 180_000)
})
