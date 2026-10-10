// WO-1100 DIAGNOSIS: why OUR re-entry at Bar's seam is not Fusion's. No engine change.
//
// Operator, on the WO-1091 landing card: "It looks better than our Helix entry, but it does look
// more complicated than it needs to be. Can you compare what it's doing versus what Fusion did
// ... What about the logic is making it require this move?"
//
// This file MEASURES both answers rather than reasoning about them:
//
//  1. WHAT FUSION DOES THERE. `src/tests/evidence/WO-1100/fusion-bar.json` is Fusion's own Bar
//     toolpath, pulled off the layered DXF by the sibling extract-fusion-bar.mjs -- and unlike
//     gt_fix4.json it keeps the `Loopback and Travel Moves` layer, i.e. THE LINKS. So we can
//     replay Fusion's path move for move and ask of every link: was the ground it travels
//     already cut? (The DXF is a plan projection, z=0 on every entity, so this file can say
//     WHERE Fusion goes and never how HIGH. Every claim below is about XY and coverage.)
//  2. WHAT MAKES OURS LIFT. Run our engine on the same fixture at the corpus settings, catch
//     the lift-landing gate's own warnings and the link's `liftReason` attribution, and
//     measure the material standing under the stay-down link the ladder refused.
//
// Always-on (this is the WO's test-slice): the structural facts each claim in compare.md
// rests on. The evidence files (the 1680x900 two-panel picture, measurements.txt) are written
// only under WRITE_EVIDENCE=1, per WO-1093:
//
//   WRITE_EVIDENCE=1 npx vitest run src/tests/adaptive-clearing/engine/_wo1100-fusion-compare.test.ts

import { describe, it, beforeAll, expect } from 'vitest'
import * as fs from 'fs'
import * as zlib from 'zlib'
import {
  ensureEngineClipperReady, offsetClosed, offsetOpenRound, diskPath, difference, intersection,
  union, netArea, type Loops, type Pt,
} from '../../../lib/cam/adaptiveClearing2d/engine/clipperEngine'
import {
  processFeature, type AdaptivePass, type ProcessParams,
} from '../../../lib/cam/adaptiveClearing2d/engine/processFeature'
import { createToolGeometry } from '../../../lib/cam/adaptiveClearing2d/engine/toolGeometry'
import { loadGtFixture } from './_goodspec-helpers'

const TOOL_RADIUS = 2.0
/** The harness's own faceting for the area replay -- the same 0.05 the WO-1087 census used,
 *  so its numbers and these are on one basis. */
const ARC_TOL = 0.05
/** What the ENGINE runs with at these params: `arcTol = max(tolerance * 0.25, 0.01)`
 *  (processFeature.ts:736) = 0.025 at tolerance 0.1. Used only where a bound of the engine's
 *  is reproduced, so the bound comes out at the engine's own value. */
const ENGINE_ARC_TOL = 0.025
const FIX = 4 // Bar
const EVID = 'src/tests/evidence/WO-1100'
const WRITE = !!process.env.WRITE_EVIDENCE

/** The nine `Adaptive Clearing - *` operations in Adaptive Clearing Shapes.camproject carry
 *  these -- the settings Operator's WO-1087 pictures and the WO-1091 landing came from. */
const CORPUS_PARAMS: ProcessParams = {
  toolRadius: TOOL_RADIUS, stepOver: 0.4, tolerance: 0.1, helixDiameter: 3.8, stockToLeave: 0.5,
  integralWallFollow: true, integralWallFollowLengthFactor: 2, wallCleanupAsWeGo: true,
  loopbackFilletPct: 25, wallFinish: true, millingDirection: 'climb',
}

type LinkPass = Extract<AdaptivePass, { type: 'link' }>
interface FusionBar {
  /** Measured by extract-fusion-bar.mjs off the DXF itself, never assumed: every z carrier
   *  (LINE 30/31, LWPOLYLINE 38) on the entities inside Bar's window. `distinct: [0]` means
   *  the export holds no height data at all -- see the WHAT THIS CANNOT SAY note below. */
  zSource: { distinct: number[]; entities: number; entitiesCarryingAnExplicitZ: number }
  boundary: number[][]
  toolpathCenter: number[][]
  helix: { center: number[]; radius: number; diameter: number }
  helixRamp: number[][] | null
  spiral: number[][] | null
  cuts: number[][][]
  links: (number[][] | null)[]
}
const P = (a: number[]): Pt => ({ x: a[0], y: a[1] })
const poly = (a: number[][]): Pt[] => a.map(P)
const len = (pts: Pt[]): number => {
  let s = 0
  for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
  return s
}
const areaOf = (l: Loops): number => (l.length ? Math.abs(netArea(l)) : 0)

/** mm^2 of NOT-YET-CUT stock the tool removes sweeping `pts`, and that area per mm of travel.
 *  The construction is identical to the WO-1087 census's engagement replay (offsetOpenRound
 *  the centreline at the tool radius, intersect with target-minus-cleared, divide by length),
 *  so OUR number and FUSION's number below are the same measurement, not two similar ones. */
function bite(pts: Pt[], target: Loops, cleared: Loops): { area: number; perDist: number; sweep: Loops } {
  const l = len(pts)
  const sweep = pts.length >= 2 && l > 1e-9 ? offsetOpenRound(pts, TOOL_RADIUS, ARC_TOL) : []
  if (!sweep.length) return { area: 0, perDist: 0, sweep: [] }
  const uncut = difference(target, cleared)
  const area = areaOf(uncut.length ? intersection(sweep, uncut) : [])
  return { area, perDist: area / l, sweep }
}
/** The same question asked of a corridor against an ALREADY-COMPUTED standing-stock region. */
function plow(pts: Pt[], standing: Loops): { area: number; perDist: number; length: number } {
  const l = len(pts)
  const sweep = offsetOpenRound(pts, TOOL_RADIUS, ARC_TOL)
  const area = sweep.length && standing.length ? areaOf(intersection(sweep, standing)) : 0
  return { area, perDist: area / l, length: l }
}

// ---------------------------------------------------------------------------------------
// tiny 5x7 bitmap font + RGBA framebuffer + PNG encoder. Lifted from
// _wo1087-ring-render.test.ts (which took it from _sidebyside.test.ts) so this diagnosis
// needs no image dependency and no browser.
// ---------------------------------------------------------------------------------------
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
  '#': [0x0A, 0x0A, 0x1F, 0x0A, 0x1F, 0x0A, 0x0A], '+': [0x00, 0x04, 0x04, 0x1F, 0x04, 0x04, 0x00],
  '=': [0x00, 0x00, 0x1F, 0x00, 0x1F, 0x00, 0x00], '%': [0x19, 0x1A, 0x02, 0x04, 0x08, 0x0B, 0x13],
  '>': [0x08, 0x04, 0x02, 0x01, 0x02, 0x04, 0x08], '<': [0x02, 0x04, 0x08, 0x10, 0x08, 0x04, 0x02],
  '*': [0x00, 0x0A, 0x04, 0x1F, 0x04, 0x0A, 0x00], '?': [0x0E, 0x11, 0x01, 0x02, 0x04, 0x00, 0x04],
  '!': [0x04, 0x04, 0x04, 0x04, 0x04, 0x00, 0x04], "'": [0x04, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00],
  '"': [0x0A, 0x0A, 0x00, 0x00, 0x00, 0x00, 0x00], '[': [0x0E, 0x08, 0x08, 0x08, 0x08, 0x08, 0x0E],
  ']': [0x0E, 0x02, 0x02, 0x02, 0x02, 0x02, 0x0E], '_': [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x1F],
}
type RGB = [number, number, number]
class FB {
  buf: Uint8Array; w: number; h: number
  cx0 = 0; cy0 = 0; cx1 = 1e9; cy1 = 1e9
  constructor(w: number, h: number, bg: RGB) {
    this.w = w; this.h = h; this.buf = new Uint8Array(w * h * 4)
    for (let i = 0; i < w * h; i++) { this.buf[i * 4] = bg[0]; this.buf[i * 4 + 1] = bg[1]; this.buf[i * 4 + 2] = bg[2]; this.buf[i * 4 + 3] = 255 }
  }
  clip(x0: number, y0: number, x1: number, y1: number) { this.cx0 = x0; this.cy0 = y0; this.cx1 = x1; this.cy1 = y1 }
  noClip() { this.cx0 = 0; this.cy0 = 0; this.cx1 = 1e9; this.cy1 = 1e9 }
  px(x: number, y: number, c: RGB) {
    x |= 0; y |= 0
    if (x < this.cx0 || y < this.cy0 || x > this.cx1 || y > this.cy1) return
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return
    const i = (y * this.w + x) * 4
    this.buf[i] = c[0]; this.buf[i + 1] = c[1]; this.buf[i + 2] = c[2]; this.buf[i + 3] = 255
  }
  dot(x: number, y: number, c: RGB, r = 0) {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (dx * dx + dy * dy <= r * r + 1) this.px(x + dx, y + dy, c)
  }
  line(x0: number, y0: number, x1: number, y1: number, c: RGB, r = 0) {
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
  dashedLine(x0: number, y0: number, x1: number, y1: number, c: RGB, r = 0, on = 8, off = 7) {
    const d = Math.hypot(x1 - x0, y1 - y0)
    if (d < 1e-6) return
    const n = Math.max(1, Math.round(d / (on + off)))
    for (let i = 0; i < n; i++) {
      const t0 = (i * (on + off)) / d, t1 = Math.min(1, (i * (on + off) + on) / d)
      this.line(x0 + (x1 - x0) * t0, y0 + (y1 - y0) * t0, x0 + (x1 - x0) * t1, y0 + (y1 - y0) * t1, c, r)
    }
  }
  fillRect(x0: number, y0: number, x1: number, y1: number, c: RGB) {
    for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++)
      for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) this.px(x, y, c)
  }
  rect(x0: number, y0: number, x1: number, y1: number, c: RGB, r = 0) {
    this.line(x0, y0, x1, y0, c, r); this.line(x1, y0, x1, y1, c, r)
    this.line(x1, y1, x0, y1, c, r); this.line(x0, y1, x0, y0, c, r)
  }
  circle(cx: number, cy: number, rad: number, c: RGB, thick = 1) {
    const steps = Math.max(32, Math.ceil(rad * 2))
    for (let i = 0; i < steps; i++) {
      const a0 = (i / steps) * 2 * Math.PI, a1 = ((i + 1) / steps) * 2 * Math.PI
      this.line(cx + Math.cos(a0) * rad, cy + Math.sin(a0) * rad, cx + Math.cos(a1) * rad, cy + Math.sin(a1) * rad, c, thick)
    }
  }
  dashedCircle(cx: number, cy: number, rad: number, c: RGB, thick = 1) {
    for (let deg = 0; deg < 360; deg += 3) {
      if (deg % 12 >= 6) continue
      const a = deg * Math.PI / 180, b = (deg + 3) * Math.PI / 180
      this.line(cx + Math.cos(a) * rad, cy + Math.sin(a) * rad, cx + Math.cos(b) * rad, cy + Math.sin(b) * rad, c, thick)
    }
  }
  text(str: string, x: number, y: number, c: RGB, scale = 2) {
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
      const l = Buffer.alloc(4); l.writeUInt32BE(data.length, 0)
      const t = Buffer.from(type, 'ascii')
      const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0, 0)
      return Buffer.concat([l, t, data, crc])
    }
    const ihdr = Buffer.alloc(13)
    ihdr.writeUInt32BE(this.w, 0); ihdr.writeUInt32BE(this.h, 4); ihdr[8] = 8; ihdr[9] = 6
    const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
    return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))])
  }
}
const textW = (s: string, scale = 2) => s.length * 6 * scale
function crc32(buf: Buffer): number {
  let c = ~0
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1))
  }
  return ~c
}
const COL = {
  bg: [16, 18, 22] as RGB, panel: [10, 11, 14] as RGB, frame: [70, 74, 82] as RGB,
  band: [255, 211, 77] as RGB, bandText: [20, 20, 20] as RGB,
  label: [214, 219, 226] as RGB, dim: [138, 144, 152] as RGB,
  boundary: [150, 150, 150] as RGB, centre: [92, 96, 104] as RGB,
  standing: [104, 78, 44] as RGB, cut: [70, 130, 210] as RGB, cutOld: [40, 62, 96] as RGB,
  loopback: [245, 175, 20] as RGB, lift: [255, 44, 44] as RGB, lead: [120, 220, 255] as RGB,
  disk: [238, 243, 252] as RGB, seam: [255, 90, 200] as RGB, ring: [255, 232, 60] as RGB,
  warn: [255, 168, 76] as RGB, // reserved for what the SOURCE cannot tell us (WO-1100 audit 2)
}
interface View { s: number; ox: number; oy: number }
const vx = (v: View, p: Pt) => v.ox + p.x * v.s
const vy = (v: View, p: Pt) => v.oy - p.y * v.s
function drawPoly(fb: FB, v: View, pts: Pt[], c: RGB, r = 0, dashed = false) {
  for (let i = 1; i < pts.length; i++) {
    if (dashed) fb.dashedLine(vx(v, pts[i - 1]), vy(v, pts[i - 1]), vx(v, pts[i]), vy(v, pts[i]), c, r)
    else fb.line(vx(v, pts[i - 1]), vy(v, pts[i - 1]), vx(v, pts[i]), vy(v, pts[i]), c, r)
  }
}
/** Fill a clipper Loops region by even-odd scanline -- how the standing stock is shaded. */
function fillLoops(fb: FB, v: View, loops: Loops, c: RGB) {
  if (!loops.length) return
  let minY = Infinity, maxY = -Infinity
  for (const lp of loops) for (const p of lp) { if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y }
  const y0 = Math.floor(vy(v, { x: 0, y: maxY })), y1 = Math.ceil(vy(v, { x: 0, y: minY }))
  for (let py = y0; py <= y1; py++) {
    const wy = (v.oy - py) / v.s
    const xs: number[] = []
    for (const lp of loops) {
      for (let i = 0; i < lp.length; i++) {
        const a = lp[i], b = lp[(i + 1) % lp.length]
        if ((a.y <= wy && b.y > wy) || (b.y <= wy && a.y > wy)) xs.push(a.x + ((wy - a.y) / (b.y - a.y)) * (b.x - a.x))
      }
    }
    xs.sort((p, q) => p - q)
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const px0 = Math.round(vx(v, { x: xs[i], y: 0 })), px1 = Math.round(vx(v, { x: xs[i + 1], y: 0 }))
      for (let px = px0; px <= px1; px++) fb.px(px, py, c)
    }
  }
}

describe("WO-1100: why our re-entry at Bar's seam is not Fusion's", () => {
  beforeAll(async () => { await ensureEngineClipperReady() }, 120_000)

  // THE FUSION HALF, still live and still load-bearing. It reads only the committed
  // fusion-bar.json, so WO-1103 cannot touch it, and it carries the one claim the whole
  // diagnosis rests on: Fusion is not allowed something we forbid.
  it("Fusion's Bar path: 38 cuts, 37 links, and every link would pass OUR keep-down cap", () => {
    const setpoint = createToolGeometry(TOOL_RADIUS, CORPUS_PARAMS.stepOver, ARC_TOL).optimalCutAreaPerDist
    const stepOverDistance = 2 * TOOL_RADIUS * CORPUS_PARAMS.stepOver
    const engineSetpoint = createToolGeometry(TOOL_RADIUS, CORPUS_PARAMS.stepOver, ENGINE_ARC_TOL).optimalCutAreaPerDist
    const traverseCap = Math.max(ENGINE_ARC_TOL,
      1.5 * engineSetpoint * (stepOverDistance / 4 + ENGINE_ARC_TOL * 4) / 2.0)

    const fj = `${EVID}/fusion-bar.json`
    expect(fs.existsSync(fj)).toBe(true) // committed; regenerate with extract-fusion-bar.mjs
    const F = JSON.parse(fs.readFileSync(fj, 'utf8')) as FusionBar
    // WHAT THIS CANNOT SAY, pinned before anything is claimed: the source is a PLAN
    // projection. Not one entity carries an explicit z code and every z readable off it is 0,
    // so this measures WHERE Fusion's tool centre goes, never how high it is.
    expect(F.zSource.distinct).toEqual([0])
    expect(F.zSource.entitiesCarryingAnExplicitZ).toBe(0)

    const fTarget: Loops = offsetClosed([poly(F.toolpathCenter)], TOOL_RADIUS, ARC_TOL)
    let fCleared: Loops = diskPath(P(F.helix.center), F.helix.radius + TOOL_RADIUS, ARC_TOL)
    if (F.spiral) fCleared = union(fCleared, offsetOpenRound(poly(F.spiral), TOOL_RADIUS, ARC_TOL))
    const fLinks: { i: number; perDist: number }[] = []
    for (let i = 0; i < F.cuts.length; i++) {
      const b = bite(poly(F.cuts[i]), fTarget, fCleared)
      if (b.sweep.length) fCleared = union(fCleared, b.sweep)
      const lk = F.links[i]
      if (!lk) continue
      fLinks.push({ i, perDist: plow(poly(lk), difference(fTarget, fCleared)).perDist })
    }
    expect(F.cuts.length).toBe(38)
    expect(fLinks.length).toBe(37)
    const worstLink = fLinks.reduce((a, b) => (b.perDist > a.perDist ? b : a))
    expect(worstLink.perDist).toBeLessThan(0.05 * setpoint)
    expect(worstLink.perDist).toBeLessThan(traverseCap)
  }, 120_000)

  // HISTORICAL, AND DELIBERATELY SKIPPED BY WO-1103 (2026-08-29). This case measured OUR
  // seam on Bar: one lift, the stay-down chord the ladder refused, the standing stock under
  // it, the 59%-uncut landing. WO-1103 acted on exactly that diagnosis -- a channel's entry
  // now goes near one end instead of at the region's deepest point -- and Bar at the corpus
  // settings roughs with ZERO retracts, so `lifts[0]` no longer exists and every measurement
  // below has lost its subject. Nothing here was wrong; the defect it describes was fixed.
  // The numbers it produced are committed beside it in compare.md and measurements.txt, and
  // the picture it drew is bar-seam-ours-vs-fusion.png. The Fusion half above is unchanged
  // and still runs. The WO-1103 after-state is gated by wo1103-channel-entry.test.ts.
  it.skip('measures both paths at the seam and (under WRITE_EVIDENCE) draws them side by side', () => {
    // ── OURS ────────────────────────────────────────────────────────────────────────────
    const { boundary, holes } = loadGtFixture(FIX)
    const warn = console.warn
    const warns: string[] = []
    console.warn = (...a: unknown[]) => { warns.push(a.map(String).join(' ')) }
    let res
    try { res = processFeature({ boundary, holes }, CORPUS_PARAMS) } finally { console.warn = warn }

    const setpoint = createToolGeometry(TOOL_RADIUS, CORPUS_PARAMS.stepOver, ARC_TOL).optimalCutAreaPerDist
    expect(setpoint).toBeCloseTo(1.56, 2) // the 1.573 WO-1087 quotes, at this arc tolerance
    /** THE BAR EVERY KEEP-DOWN TRAVERSE IN THIS ENGINE MEETS, reproduced verbatim from
     *  `traverseKeepDownCap` (processFeature.ts:2686-2688) at the engine's own arcTol, so
     *  Fusion's links and our refused link can be held to OUR rule rather than to a guess.
     *  Units: mm2/mm, i.e. effective cut width in mm -- the same quantity the rung's
     *  "sustains N mm effective width" refusal reports. */
    const stepOverDistance = 2 * TOOL_RADIUS * CORPUS_PARAMS.stepOver
    const engineSetpoint = createToolGeometry(TOOL_RADIUS, CORPUS_PARAMS.stepOver, ENGINE_ARC_TOL).optimalCutAreaPerDist
    const traverseCap = Math.max(ENGINE_ARC_TOL,
      1.5 * engineSetpoint * (stepOverDistance / 4 + ENGINE_ARC_TOL * 4) / 2.0)
    const lifts = res.passes.filter(p => p.type === 'link' && p.jumpType === 2) as LinkPass[]
    expect(lifts.length).toBe(1)
    const lift = lifts[0]
    const liftIdx = res.passes.indexOf(lift)
    const from = lift.points[0], landing = lift.points[1]
    const liftReason = (lift as { liftReason?: string }).liftReason ?? ''
    // The gate's own log: the landing it wanted, and the landing it took.
    const gateLog = warns.filter(w => w.includes('[lift-landing]') || w.includes('[cutthrough]') || w.includes('[side-'))
    const walkerPt = (() => {
      const m = gateLog.join('\n').match(/landing at the walker point \(([-\d.]+), ([-\d.]+)\)/)
      return m ? { x: Number(m[1]), y: Number(m[2]) } : null
    })()

    const ourTarget: Loops = offsetClosed(res.cutRegion, TOOL_RADIUS, ARC_TOL)
    // Replay OUR path up to the lift to recover the belief the transition was judged against.
    let ourCleared: Loops = []
    for (const e of res.entries) if (e.radius > 0) ourCleared = union(ourCleared, diskPath(e.point, e.radius + TOOL_RADIUS, ARC_TOL))
    let standingAtSeam: Loops = []
    let clearedAtSeam: Loops = []
    let ourFirstCutAfter: { i: number; perDist: number; area: number; length: number } | null = null
    res.passes.forEach((p, i) => {
      if (i === liftIdx) { clearedAtSeam = ourCleared; standingAtSeam = difference(ourTarget, ourCleared) }
      if (p.type !== 'cut' && p.type !== 'wallfollow' && p.type !== 'lead') return
      const b = bite(p.points, ourTarget, ourCleared)
      if (i > liftIdx && p.type === 'cut' && !ourFirstCutAfter)
        ourFirstCutAfter = { i, perDist: b.perDist, area: b.area, length: len(p.points) }
      if (b.sweep.length) ourCleared = union(ourCleared, b.sweep)
    })

    // WHAT THE REFUSED STAY-DOWN LINK WOULD HAVE COST: the straight chord the ladder judged,
    // from where the last cut ended to the landing the walker asked for.
    const refusedChord = [from, walkerPt ?? landing]
    const refused = plow(refusedChord, standingAtSeam)
    /** ...and its PEAK, not just its average. Measured with the ENGINE'S OWN load function
     *  (`ToolGeometry.cutArea` = the newly-swept crescent per mm, the quantity the steering
     *  holds at `optimalCutAreaPerDist`), walking the chord in 0.5 mm steps and folding each
     *  step into the belief -- so this number is directly comparable with the setpoint. */
    const tool = createToolGeometry(TOOL_RADIUS, CORPUS_PARAMS.stepOver, ARC_TOL)
    const refusedPeak = (() => {
      const a = refusedChord[0], b = refusedChord[1]
      const total = Math.hypot(b.x - a.x, b.y - a.y)
      const n = Math.max(1, Math.round(total / 0.5))
      let seen: Loops = clearedAtSeam
      let worst = 0
      for (let i = 0; i < n; i++) {
        const t0 = i / n, t1 = (i + 1) / n
        const p0 = { x: a.x + (b.x - a.x) * t0, y: a.y + (b.y - a.y) * t0 }
        const p1 = { x: a.x + (b.x - a.x) * t1, y: a.y + (b.y - a.y) * t1 }
        worst = Math.max(worst, tool.cutArea(p0, p1, seen).areaPerDist)
        seen = union(seen, offsetOpenRound([p0, p1], TOOL_RADIUS, ARC_TOL))
      }
      return worst
    })()
    /** LEGALITY, the ladder's other complaint ('gouge'): how far outside the tool-centre
     *  region the same chord takes the tool. `cutRegion` is where the tool CENTRE may go;
     *  a chord that leaves it drives the cutter into the wall-finish skin. */
    const inCutRegion = (p: Pt): boolean => {
      let inside = false
      for (const lp of res.cutRegion) {
        for (let i = 0, j = lp.length - 1; i < lp.length; j = i++) {
          if ((lp[i].y > p.y) !== (lp[j].y > p.y)
            && p.x < ((lp[j].x - lp[i].x) * (p.y - lp[i].y)) / (lp[j].y - lp[i].y) + lp[i].x) inside = !inside
        }
      }
      return inside
    }
    /** Fraction of a chord whose samples fall outside cutRegion, and the worst sample. */
    const outsideRun = (a: Pt, b: Pt) => {
      const n = 200
      let out = 0
      let firstOut: Pt | null = null
      for (let i = 0; i <= n; i++) {
        const t = i / n
        const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
        if (!inCutRegion(p)) { out++; if (!firstOut) firstOut = p }
      }
      return { frac: out / (n + 1), firstOut }
    }
    const chordOutside = outsideRun(refusedChord[0], refusedChord[1])
    // The ladder's stop-short rung judged the ORIGINAL target, one stepover further down the
    // wall than the walker point the gate later fell back to. Report both.
    const stopShortTarget = (() => {
      const m = liftReason.match(/machinable region between \([-\d.]+, [-\d.]+\) and \(([-\d.]+), ([-\d.]+)\)/)
      return m ? { x: Number(m[1]), y: Number(m[2]) } : null
    })()
    const stopShortOutside = stopShortTarget ? outsideRun(from, stopShortTarget) : null
    const cutRegionBox = (() => {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
      for (const lp of res.cutRegion) for (const p of lp) {
        x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y)
      }
      return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 }
    })()
    // WHY A CENTRED SPIRAL STRANDS BOTH ENDS OF A BAR. The tool-centre region is a long thin
    // rectangle; a spiral grown from a point inside it saturates once it touches both long
    // walls -- at half the WIDTH -- and everything beyond that radius along the LENGTH is
    // still standing. Our entry sits at the region's centroid, so that leftover splits in two.
    const spiralSaturationRadius = cutRegionBox.w / 2
    const strandedPerEnd = Math.max(0, cutRegionBox.h / 2 - spiralSaturationRadius)
    /** The gate's own 5%-plunge-allowance question, asked of any candidate landing. */
    const diskUncut = (c: Pt) =>
      areaOf(standingAtSeam.length ? intersection(diskPath(c, TOOL_RADIUS, ARC_TOL), standingAtSeam) : [])
      / (Math.PI * TOOL_RADIUS * TOOL_RADIUS)

    // ── FUSION ──────────────────────────────────────────────────────────────────────────
    const fj = `${EVID}/fusion-bar.json`
    expect(fs.existsSync(fj)).toBe(true) // committed; regenerate with extract-fusion-bar.mjs
    const F = JSON.parse(fs.readFileSync(fj, 'utf8')) as FusionBar
    const fTarget: Loops = offsetClosed([poly(F.toolpathCenter)], TOOL_RADIUS, ARC_TOL)
    let fCleared: Loops = diskPath(P(F.helix.center), F.helix.radius + TOOL_RADIUS, ARC_TOL)
    if (F.spiral) fCleared = union(fCleared, offsetOpenRound(poly(F.spiral), TOOL_RADIUS, ARC_TOL))
    const fLinks: { i: number; from: Pt; to: Pt; length: number; chord: number; area: number; perDist: number }[] = []
    const fCuts: { i: number; perDist: number; area: number; length: number }[] = []
    let fStandingAtBand: Loops = []
    let bandLink = -1
    for (let i = 0; i < F.cuts.length; i++) {
      const c = poly(F.cuts[i])
      const b = bite(c, fTarget, fCleared)
      fCuts.push({ i, perDist: b.perDist, area: b.area, length: len(c) })
      if (b.sweep.length) fCleared = union(fCleared, b.sweep)
      const lk = F.links[i]
      if (!lk) continue
      const lp = poly(lk)
      const standing = difference(fTarget, fCleared)
      const pl = plow(lp, standing)
      fLinks.push({
        i, from: lp[0], to: lp[lp.length - 1], length: pl.length,
        chord: Math.hypot(lp[lp.length - 1].x - lp[0].x, lp[lp.length - 1].y - lp[0].y),
        area: pl.area, perDist: pl.perDist,
      })
      // The link that lands in the SAME band of the bar our seam sits in.
      if (bandLink < 0 && lp[lp.length - 1].y <= landing.y) { bandLink = fLinks.length - 1; fStandingAtBand = standing }
    }

    // ── ALWAYS-ON FACTS (every claim compare.md makes) ──────────────────────────────────
    // Ours: exactly one lift; it lands in clear air (WO-1091) and drills no helix.
    expect(lift.clearAirLanding).toBe(true)
    expect(lift.helixDescent).toBeUndefined()
    // ...and it is the LADDER that put it there -- every cheaper rung is named as refused.
    expect(liftReason).toContain('no-wall')
    expect(liftReason).toContain('route-detour>budget')
    expect(liftReason).toContain('stopshort-refused')
    // WHAT THIS CANNOT SAY, pinned as a fact before anything is claimed about Fusion.
    // The source is a PLAN projection: not one entity in Bar's window carries an explicit z
    // code, and every z readable off it is 0. So this test can measure WHERE Fusion's tool
    // centre goes and what stock stands under that corridor, and it can prove that corridor
    // would pass our own keep-down rule -- but it CANNOT distinguish an at-depth loopback from
    // the identical XY move flown above the floor, and it cannot see a vertical retract or a
    // second descent, which project to a point and leave no entity. The WO's "does it lift
    // there" is therefore NOT answered by the committed source; every assertion below is an XY
    // assertion, and compare.md says so in the same words.
    expect(F.zSource.distinct).toEqual([0])
    expect(F.zSource.entitiesCarryingAnExplicitZ).toBe(0)
    // Fusion: 38 cuts threaded by 37 single continuous return moves, each of whose corridor is
    // ground Fusion has already cut (an XY fact, per the note above).
    expect(F.cuts.length).toBe(38)
    expect(fLinks.length).toBe(37)
    const worstLink = fLinks.reduce((a, b) => (b.perDist > a.perDist ? b : a))
    expect(worstLink.perDist).toBeLessThan(0.05 * setpoint)
    // THE HEADLINE: every one of Fusion's 37 links would pass OUR OWN keep-down traverse bar.
    // Fusion is not allowed something we forbid -- it never asks for it.
    expect(worstLink.perDist).toBeLessThan(traverseCap)
    // Ours would not: the chord the ladder was offered is nearly six times that bar.
    expect(refusedPeak).toBeGreaterThan(traverseCap)
    // The stay-down link OUR ladder refused is nothing like that: its corridor is standing
    // stock, by two orders of magnitude more than Fusion's worst link, and its landing disk
    // sits on stock the 5% plunge allowance cannot cover.
    expect(refused.area).toBeGreaterThan(5)
    expect(refused.perDist).toBeGreaterThan(20 * worstLink.perDist)
    expect(refusedPeak).toBeGreaterThan(setpoint)
    expect(diskUncut(walkerPt ?? landing)).toBeGreaterThan(0.05)
    expect(diskUncut(landing)).toBeLessThan(0.05)
    expect(bandLink).toBeGreaterThanOrEqual(0)

    const lines: string[] = []
    const say = (s = '') => { lines.push(s); console.log(s) }
    say('=== WO-1100: BAR SEAM, OURS vs FUSION ===')
    say('corpus settings: tool r2.0, stepOver 0.4 (=1.60mm), stockToLeave 0.5, climb, wallFinish on')
    say(`setpoint (optimalCutAreaPerDist) = ${setpoint.toFixed(3)} mm2/mm`)
    say(`keep-down traverse cap (traverseKeepDownCap, processFeature.ts:2686) = ${traverseCap.toFixed(3)} mm `
      + 'effective width -- the bar EVERY at-depth link in this engine must meet')
    say('')
    say('-- OURS -------------------------------------------------------------------------')
    say(`passes ${res.passes.length} (cuts ${res.passes.filter(p => p.type === 'cut').length}), entries: `
      + res.entries.map(e => `${e.mode}@(${e.point.x.toFixed(2)},${e.point.y.toFixed(2)})r${e.radius.toFixed(2)}`).join(' '))
    say(`ONE lift, pass #${liftIdx}: (${from.x.toFixed(2)}, ${from.y.toFixed(2)}) -> (${landing.x.toFixed(2)}, ${landing.y.toFixed(2)})`
      + `  clearAirLanding=${!!lift.clearAirLanding}  helixDescent=${!!lift.helixDescent}`)
    say(`liftReason = ${liftReason}`)
    for (const w of gateLog) say(`  GATE ${w}`)
    if (walkerPt) say(`walker point (the stay-down landing asked for) = (${walkerPt.x.toFixed(2)}, ${walkerPt.y.toFixed(2)}); `
      + `cutter disk there is ${(diskUncut(walkerPt) * 100).toFixed(1)}% standing stock`)
    say(`landing taken (${landing.x.toFixed(2)}, ${landing.y.toFixed(2)}): cutter disk is ${(diskUncut(landing) * 100).toFixed(1)}% standing stock`)
    say(`REFUSED stay-down chord, ${refused.length.toFixed(2)}mm: would plow ${refused.area.toFixed(2)} mm2 of standing stock `
      + `= ${refused.perDist.toFixed(3)} mm2/mm average (${(refused.perDist / setpoint).toFixed(2)}x setpoint), `
      + `peaking at ${refusedPeak.toFixed(3)} mm2/mm by the engine's own cutArea `
      + `(${(refusedPeak / setpoint).toFixed(2)}x setpoint)`)
    say(`cutRegion (where the tool CENTRE may go) is x[${cutRegionBox.x0.toFixed(2)}, ${cutRegionBox.x1.toFixed(2)}] `
      + `y[${cutRegionBox.y0.toFixed(2)}, ${cutRegionBox.y1.toFixed(2)}] = ${cutRegionBox.w.toFixed(2)} x ${cutRegionBox.h.toFixed(2)} mm, `
      + `${res.cutRegion.length} loop(s)`)
    say(`  a spiral grown from inside it saturates at radius ${spiralSaturationRadius.toFixed(2)}mm (half the WIDTH); `
      + `our entry is at the region centroid, so ~${strandedPerEnd.toFixed(1)}mm of length is left standing at EACH end `
      + '-- that is the seam. Fusion enters '
      + `${Math.abs(F.helix.center[1] - res.entries[0].point.y).toFixed(1)}mm nearer the top end and never turns round.`)
    say(`  the refused chord runs at x=${from.x.toFixed(2)} -- EXACTLY cutRegion's left edge, so the stop-short `
      + "rung's gouge veto (centrePathExitsCutRegion -> isOutsideCutRegion, processFeature.ts:4809/694) reads "
      + 'boundary contact as an escape: pip2 counts only STRICTLY inside as inside.')
    say(`  chord to the walker point: ${(chordOutside.frac * 100).toFixed(1)}% of its samples lie outside cutRegion`
      + (chordOutside.firstOut ? ` (first at (${chordOutside.firstOut.x.toFixed(2)}, ${chordOutside.firstOut.y.toFixed(2)}))` : ''))
    if (stopShortTarget && stopShortOutside) {
      say(`  chord the stop-short rung actually judged, to (${stopShortTarget.x.toFixed(2)}, ${stopShortTarget.y.toFixed(2)}): `
        + `${(stopShortOutside.frac * 100).toFixed(1)}% of its samples lie outside cutRegion`
        + (stopShortOutside.firstOut ? ` (first at (${stopShortOutside.firstOut.x.toFixed(2)}, ${stopShortOutside.firstOut.y.toFixed(2)}))` : ''))
    }
    if (ourFirstCutAfter) {
      const f = ourFirstCutAfter as { i: number; perDist: number; area: number; length: number }
      say(`first CUT after the seam: pass #${f.i}, ${f.length.toFixed(2)}mm, ${f.area.toFixed(2)} mm2 `
        + `= ${f.perDist.toFixed(3)} mm2/mm (${(f.perDist / setpoint).toFixed(2)}x setpoint)`)
    }
    say('')
    say('-- FUSION -----------------------------------------------------------------------')
    say(`1 helix @(${F.helix.center[0].toFixed(2)}, ${F.helix.center[1].toFixed(2)}) r${F.helix.radius}, then 1 spiral, `
      + `then ${F.cuts.length} cuts joined by ${fLinks.length} loopbacks. (gt_fix4 carries cut polylines only - whether Fusion lifts between cuts cannot be read from it; see compare.md section 1.)`)
    say(`worst link corridor over standing stock: link #${worstLink.i} = ${worstLink.area.toFixed(3)} mm2 `
      + `= ${worstLink.perDist.toFixed(4)} mm2/mm (${(100 * worstLink.perDist / setpoint).toFixed(2)}% of setpoint) `
      + `-- our refused link is ${(refused.perDist / worstLink.perDist).toFixed(0)}x that`)
    say(`EVERY Fusion link passes OUR keep-down traverse cap: worst ${worstLink.perDist.toFixed(4)} mm vs cap `
      + `${traverseCap.toFixed(3)} mm (${(100 * worstLink.perDist / traverseCap).toFixed(1)}% of it). `
      + `Our refused chord peaks at ${refusedPeak.toFixed(3)} mm = ${(refusedPeak / traverseCap).toFixed(1)}x the same cap.`)
    const bl = fLinks[bandLink]
    say(`link crossing OUR seam's band: #${bl.i} (${bl.from.x.toFixed(2)}, ${bl.from.y.toFixed(2)}) -> `
      + `(${bl.to.x.toFixed(2)}, ${bl.to.y.toFixed(2)}), ${bl.length.toFixed(2)}mm over a ${bl.chord.toFixed(2)}mm chord, `
      + `plows ${bl.area.toFixed(3)} mm2 = ${bl.perDist.toFixed(4)} mm2/mm`)
    const nc = fCuts[bl.i + 1]
    if (nc) say(`Fusion's first CUT after that link: cut #${nc.i}, ${nc.length.toFixed(2)}mm, ${nc.area.toFixed(2)} mm2 `
      + `= ${nc.perDist.toFixed(3)} mm2/mm (${(nc.perDist / setpoint).toFixed(2)}x setpoint)`)
    const fWorstCut = fCuts.reduce((a, b) => (b.perDist > a.perDist ? b : a))
    say(`Fusion's worst cut engagement: cut #${fWorstCut.i} = ${fWorstCut.perDist.toFixed(3)} mm2/mm `
      + `(${(fWorstCut.perDist / setpoint).toFixed(2)}x setpoint)`)
    say('')
    say('-- OUR PASS STREAM AROUND THE SEAM ----------------------------------------------')
    for (let i = Math.max(0, liftIdx - 6); i <= Math.min(res.passes.length - 1, liftIdx + 10); i++) {
      const p = res.passes[i]
      const mark = i === liftIdx ? '->' : '  '
      if (p.type === 'entry') {
        say(`  ${mark} #${String(i).padStart(3)} ${`entry ${p.mode}`.padEnd(10)} `
          + `r=${p.radius.toFixed(2)}  at (${p.point.x.toFixed(2)}, ${p.point.y.toFixed(2)})`)
        continue
      }
      const pts = p.points
      say(`  ${mark} #${String(i).padStart(3)} ${p.type.padEnd(10)} n=${String(pts.length).padStart(4)} `
        + `len=${len(pts).toFixed(2).padStart(7)}  (${pts[0].x.toFixed(2)}, ${pts[0].y.toFixed(2)}) -> `
        + `(${pts[pts.length - 1].x.toFixed(2)}, ${pts[pts.length - 1].y.toFixed(2)})`)
    }
    say('-- FUSION\'S STREAM IN THE SAME BAND ---------------------------------------------')
    say(`   SOURCE IS A PLAN PROJECTION: z groups present = [${F.zSource.distinct.join(', ')}] over `
      + `${F.zSource.entities} entities, ${F.zSource.entitiesCarryingAnExplicitZ} with an explicit z code.`)
    say('   So these are XY facts. Whether Fusion held depth across them is NOT readable here.')
    for (let i = Math.max(0, bl.i - 2); i <= Math.min(F.cuts.length - 1, bl.i + 2); i++) {
      const c = poly(F.cuts[i])
      say(`     cut ${String(i).padStart(2)} n=${String(c.length).padStart(4)} len=${len(c).toFixed(2).padStart(7)}  `
        + `(${c[0].x.toFixed(2)}, ${c[0].y.toFixed(2)}) -> (${c[c.length - 1].x.toFixed(2)}, ${c[c.length - 1].y.toFixed(2)})`)
      const lk = F.links[i]
      if (!lk) continue
      const lp = poly(lk)
      say(`     lnk ${String(i).padStart(2)} n=${String(lp.length).padStart(4)} len=${len(lp).toFixed(2).padStart(7)}  `
        + `(${lp[0].x.toFixed(2)}, ${lp[0].y.toFixed(2)}) -> (${lp[lp.length - 1].x.toFixed(2)}, ${lp[lp.length - 1].y.toFixed(2)}) ONE MOVE, CORRIDOR ALREADY CUT (XY ONLY)`)
    }

    if (!WRITE) return

    // ── THE PICTURE: two panels, one window, one scale ──────────────────────────────────
    const W = 1680, H = 900
    const fb = new FB(W, H, COL.bg)
    const BAND_H = 34
    fb.fillRect(0, 0, W - 1, BAND_H - 1, COL.band)
    fb.text("WO-1100  BAR'S SEAM: OUR RE-ENTRY vs FUSION'S  -  SAME FIXTURE, SAME WINDOW, SAME SCALE", 12, 9, COL.bandText, 2)
    const win = { x0: 118.5, x1: 147.0, y0: -70.0, y1: -30.0 }
    const panels = [
      { x0: 8, x1: 830, title: 'OURS (WO-1091 AS LANDED)' },
      { x0: 846, x1: W - 8, title: 'REFERENCE POST, SAME FIXTURE' },
    ]
    const views: View[] = []
    const PY0 = BAND_H + 6, PY1 = H - 8, PAD_T = 44, PAD_B = 132
    for (const pn of panels) {
      fb.fillRect(pn.x0, PY0, pn.x1, PY1, COL.panel)
      fb.rect(pn.x0, PY0, pn.x1, PY1, COL.frame)
      const s = Math.min((pn.x1 - pn.x0 - 32) / (win.x1 - win.x0), (PY1 - PY0 - PAD_T - PAD_B) / (win.y1 - win.y0))
      const ox = pn.x0 + ((pn.x1 - pn.x0) - (win.x1 - win.x0) * s) / 2 - win.x0 * s
      const oy = PY0 + PAD_T + win.y1 * s
      views.push({ s, ox, oy })
    }
    const st = `SCALE ${views[0].s.toFixed(1)} PX/MM   WINDOW X ${win.x0}..${win.x1}  Y ${win.y0}..${win.y1}`
    fb.text(st, W - textW(st, 1) - 12, 13, COL.bandText, 1)

    // LEFT: ours, frozen at the moment of the lift.
    {
      const v = views[0], pn = panels[0]
      fb.clip(pn.x0 + 2, PY0 + 2, pn.x1 - 2, PY1 - 2)
      fillLoops(fb, v, standingAtSeam, COL.standing)
      drawPoly(fb, v, [...poly(F.boundary), poly(F.boundary)[0]], COL.boundary)
      for (const lp of res.cutRegion) drawPoly(fb, v, [...lp, lp[0]], COL.centre)
      res.passes.forEach((p, i) => {
        if (i > liftIdx + 3) return
        // Only the four polyline pass kinds are drawn here; `entry` (a point + radius, no
        // `points` field), `link` and `finish` were already skipped by the old colour table
        // returning null for them. Discriminating FIRST keeps that exact set and lets the
        // union narrow, which `if (c)` did not do -- `p` stayed `AdaptivePass` and `p.points`
        // failed `tsc -b` on the `entry` variant (WO-1100 audit finding 1).
        if (p.type !== 'cut' && p.type !== 'wallfollow' && p.type !== 'loopback' && p.type !== 'lead') return
        const c = p.type === 'cut' ? (i < liftIdx ? COL.cutOld : COL.cut)
          : p.type === 'wallfollow' ? COL.cutOld
            : p.type === 'loopback' ? COL.loopback
              : COL.lead
        drawPoly(fb, v, p.points, c, i > liftIdx ? 1 : 0)
      })
      if (walkerPt) {
        drawPoly(fb, v, refusedChord, COL.seam, 1, true)
        fb.dashedCircle(vx(v, walkerPt), vy(v, walkerPt), TOOL_RADIUS * v.s, COL.seam, 1)
      }
      fb.dashedLine(vx(v, from), vy(v, from), vx(v, landing), vy(v, landing), COL.lift, 1)
      fb.dot(vx(v, from), vy(v, from), COL.lift, 4)
      fb.dot(vx(v, landing), vy(v, landing), COL.lift, 4)
      fb.dashedCircle(vx(v, landing), vy(v, landing), TOOL_RADIUS * v.s, COL.disk, 1)
      const seam = { x: (from.x + (walkerPt ?? landing).x) / 2, y: (from.y + (walkerPt ?? landing).y) / 2 }
      fb.circle(vx(v, seam), vy(v, seam), 5.0 * v.s, COL.ring, 1)
      fb.noClip()
      // Title and legend strips go on LAST, over their own opaque backing, so nothing the
      // scene draws can sit on top of the words that explain it.
      fb.fillRect(pn.x0 + 1, PY0 + 1, pn.x1 - 1, PY0 + PAD_T - 8, COL.panel)
      fb.fillRect(pn.x0 + 1, PY1 - PAD_B + 4, pn.x1 - 1, PY1 - 1, COL.panel)
      fb.text(pn.title, pn.x0 + 14, PY0 + 12, COL.label, 2)
      fb.text('THE YELLOW RING IS THE SEAM', pn.x1 - 14 - textW('THE YELLOW RING IS THE SEAM', 1), PY0 + 18, COL.ring, 1)
      let ty = PY1 - PAD_B + 14
      const L = (t: string, c: RGB = COL.label) => { fb.text(t, pn.x0 + 14, ty, c, 1); ty += 13 }
      L(`LIFT (RED DASH): RETRACT AT (${from.x.toFixed(2)},${from.y.toFixed(2)}), RAPID ACROSS, RAPID DOWN IN AIR, LEAD IN AT (${landing.x.toFixed(2)},${landing.y.toFixed(2)})`, COL.lift)
      if (walkerPt) {
        L(`PINK: THE STAY-DOWN LINK THE LADDER REFUSED. IT PEAKS AT ${refusedPeak.toFixed(2)} MM = ${(refusedPeak / traverseCap).toFixed(1)}X OUR OWN ${traverseCap.toFixed(2)} MM KEEP-DOWN CAP,`, COL.seam)
        L(`AND THE CUTTER AT ITS LANDING (PINK CIRCLE) SITS ON ${(diskUncut(walkerPt) * 100).toFixed(0)}% STANDING STOCK AGAINST A 5% PLUNGE ALLOWANCE`, COL.seam)
      }
      L(`WHITE DASHED CIRCLE = THE CUTTER WHERE WE ACTUALLY LAND: ${(diskUncut(landing) * 100).toFixed(0)}% STANDING STOCK UNDER IT`, COL.disk)
      L(`WE ENTER AT THE MIDDLE, SO THE SPIRAL STRANDS ABOUT ${strandedPerEnd.toFixed(0)}MM OF BAR AT EACH END AND THE PATH MUST CROSS BACK OVER STOCK`, COL.dim)
      L('BROWN = STOCK STILL STANDING AT THIS INSTANT   BLUE = CUTS   ORANGE = STAY-DOWN LINKS   GREY = WALL / TOOL-CENTRE LIMIT', COL.dim)
    }
    // RIGHT: Fusion, frozen at the equivalent moment.
    {
      const v = views[1], pn = panels[1]
      fb.clip(pn.x0 + 2, PY0 + 2, pn.x1 - 2, PY1 - 2)
      fillLoops(fb, v, fStandingAtBand, COL.standing)
      drawPoly(fb, v, [...poly(F.boundary), poly(F.boundary)[0]], COL.boundary)
      drawPoly(fb, v, [...poly(F.toolpathCenter), poly(F.toolpathCenter)[0]], COL.centre)
      for (let i = 0; i <= Math.min(bl.i + 3, F.cuts.length - 1); i++) {
        drawPoly(fb, v, poly(F.cuts[i]), i >= bl.i ? COL.cut : COL.cutOld, i >= bl.i ? 1 : 0)
        const lk = F.links[i]
        if (lk) drawPoly(fb, v, poly(lk), COL.loopback, i === bl.i ? 1 : 0)
      }
      fb.dot(vx(v, bl.from), vy(v, bl.from), COL.loopback, 4)
      fb.dot(vx(v, bl.to), vy(v, bl.to), COL.loopback, 4)
      fb.dashedCircle(vx(v, bl.to), vy(v, bl.to), TOOL_RADIUS * v.s, COL.disk, 1)
      // Same ring, same radius, over the equivalent place: where Fusion re-enters the cut.
      fb.circle(vx(v, bl.to), vy(v, bl.to), 5.0 * v.s, COL.ring, 1)
      fb.noClip()
      fb.fillRect(pn.x0 + 1, PY0 + 1, pn.x1 - 1, PY0 + PAD_T - 8, COL.panel)
      fb.fillRect(pn.x0 + 1, PY1 - PAD_B + 4, pn.x1 - 1, PY1 - 1, COL.panel)
      fb.text(pn.title, pn.x0 + 14, PY0 + 12, COL.label, 2)
      fb.text('THE YELLOW RING IS THE SAME SPOT', pn.x1 - 14 - textW('THE YELLOW RING IS THE SAME SPOT', 1), PY0 + 18, COL.ring, 1)
      let ty = PY1 - PAD_B + 14
      const L = (t: string, c: RGB = COL.label) => { fb.text(t, pn.x0 + 14, ty, c, 1); ty += 13 }
      L(`RETURN MOVE (ORANGE) (${bl.from.x.toFixed(2)},${bl.from.y.toFixed(2)}) -> (${bl.to.x.toFixed(2)},${bl.to.y.toFixed(2)}), ${bl.length.toFixed(1)}MM LONG, ONE MOVE`, COL.loopback)
      L(`IT PLOWS ${bl.perDist.toFixed(3)} MM: THE RETURN CORRIDOR IS INSIDE THE CUT IT JUST MADE.`, COL.loopback)
      L(`WORST OF ALL ${fLinks.length} LINKS IS ${worstLink.perDist.toFixed(3)} MM = ${(100 * worstLink.perDist / traverseCap).toFixed(0)}% OF OUR OWN ${traverseCap.toFixed(2)} MM CAP, SO OUR RULES WOULD ALLOW EVERY ONE OF THEM`, COL.loopback)
      L(`ALL ${F.cuts.length} CUTS RUN THE SAME WAY, LEFT WALL -> RIGHT WALL; FUSION ENTERS NEAR THE TOP END, NOT THE MIDDLE`)
      L('SO FUSION HAS NO SEAM TO RE-ENTER: THE NEXT CUT STARTS EXACTLY WHERE THE LINK ENDS, IN CLEARED STOCK', COL.dim)
      L('BROWN = STOCK STILL STANDING AT THIS INSTANT   BLUE = CUTS   ORANGE = RETURN LINKS   GREY = WALL / TOOL-CENTRE LIMIT', COL.dim)
      L('THIS PANEL IS DRAWN FROM A PLAN VIEW WITH NO Z IN IT. IT SHOWS WHERE FUSION GOES, NOT HOW HIGH.', COL.warn)
      L('IT PROVES THIS RETURN WOULD BE LEGAL FOR US TO FLY AT DEPTH; IT CANNOT PROVE FUSION ACTUALLY DID.', COL.warn)
    }
    fs.mkdirSync(EVID, { recursive: true })
    fs.writeFileSync(`${EVID}/bar-seam-ours-vs-fusion.png`, fb.png())
    fs.writeFileSync(`${EVID}/measurements.txt`, lines.join('\n') + '\n')
    console.log(`wrote ${EVID}/bar-seam-ours-vs-fusion.png (${W}x${H})`)
  }, 2_400_000)
})
