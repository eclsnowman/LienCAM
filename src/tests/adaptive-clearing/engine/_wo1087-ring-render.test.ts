// WO-1087 PICTURE GATE: draw the orange rings themselves, and say what drew each one.
//
// WHY THIS HARNESS EXISTS (audit finding, 2026-08-28). The first attempt's pictures came from
// `_wo410-corpus-render.test.ts`. That renderer fixes its image to a 720-px square and its
// drawing block never touches `res.entries` or a link's `helixDescent` -- the only ring it can
// draw is the WO-466 finish-lap connection marker. So those PNGs could not display the helix
// behaviour they were offered to explain. This one is built for exactly that job:
//
//   * 1680x900, with a stamped label band (A / B and what the picture is) drawn IN the image,
//     so the picture cannot be separated from its caption and the size stays 1680x900.
//   * It renders the EMITTED move stream (emitFeature), so what is drawn is what Operator's
//     viewport draws -- every `role: 'helix'` move, as a ring, in the viewport's orange.
//   * Every ring is ATTRIBUTED against the plan and marked with the source's own colour:
//       GREEN  = a region ENTRY helix          (res.entries, mode 'helix')
//       RED    = a LIFT-LANDING helix          (link.jumpType 2 with helixDescent)
//       PURPLE = a FINISH-LAP CONNECTION helix (res.finishApproaches[i].helix)
//   * A right-hand ZOOM panel puts the ring of interest at ~30 px/mm, with the cutter disk at
//     the landing, the incoming link, and the stock still standing under that disk shaded --
//     i.e. the picture shows WHY the gate drilled instead of walking in from cleared air.
//
// The shaded standing stock is a HARNESS RECONSTRUCTION, named as such on the picture: the
// union of every swept cut (offsetOpenRound at the tool radius) that precedes the landing's
// own pass index, plus the entry helix disk. The engine's own `landingDiskUncutFraction` is
// module-private; this reconstruction is the same construction from the public pass stream,
// and it is reported as a measurement, never as the engine's number.
//
// Run (opt-in; the replay is minutes):
//   WO1087_RENDER=1 WO1087_RENDER_OUT=src/tests/evidence/WO-1087/render-rings \
//     npx vitest run src/tests/adaptive-clearing/engine/_wo1087-ring-render.test.ts
// Envs: WO1087_RENDER_ONLY=4,5 (fixture indices), WO1087_RENDER_SETTINGS=corpus|bytestab,
//       WO1087_RENDER_TAG / WO1087_RENDER_LABEL (the band's text, for a before/after pair).

import { describe, it, beforeAll, expect } from 'vitest'
import * as fs from 'fs'
import * as zlib from 'zlib'
import {
  ensureEngineClipperReady, offsetClosed, offsetOpenRound, diskPath, difference, intersection,
  union, netArea, type Loops, type Pt,
} from '../../../lib/cam/adaptiveClearing2d/engine/clipperEngine'
import {
  processFeature, type AdaptivePass, type ProcessParams, type FeatureResult,
} from '../../../lib/cam/adaptiveClearing2d/engine/processFeature'
import { emitFeature, type EmitContext } from '../../../lib/cam/adaptiveClearing2d/engine/emit'
import { loadGtFixture, FIXTURE_META, CANONICAL_PARAMS } from './_goodspec-helpers'

const TOOL_RADIUS = 2.0
const ARC_TOL = 0.05

/** The nine `Adaptive Clearing - *` operations in Adaptive Clearing Shapes.camproject carry these
 *  (see wo1087-reseed-entry.test.ts for the provenance, WO-454 for the climb correction). This
 *  is the run Operator's three pictures came from. */
const CORPUS_PARAMS: ProcessParams = {
  toolRadius: TOOL_RADIUS, stepOver: 0.4, tolerance: 0.1, helixDiameter: 3.8, stockToLeave: 0.5,
  integralWallFollow: true, integralWallFollowLengthFactor: 2, wallCleanupAsWeGo: true,
  loopbackFilletPct: 25, wallFinish: true, millingDirection: 'climb',
}

/** The Bar operation's heights/feeds block, verbatim from the project file. Only the ramp
 *  geometry matters here: helixAngleDeg sets how many turns a ring has. */
const CTX: EmitContext = {
  heights: { clearanceZ: 15, retractZ: 5, feedZ: 5, topZ: 0, bottomZ: -2 },
  feeds: { feedRate: 1000, plungeRate: 300, rampRate: 500, leadInRate: 500, leadOutRate: 500, fastTraverseRate: 5000, finishRate: 1000 },
  stepdown: 2,
  helixAngleDeg: 3,
}

const OUT_DIR = process.env.WO1087_RENDER_OUT ?? 'src/tests/evidence/_corpus-scratch/wo1087-rings'
const TAG = process.env.WO1087_RENDER_TAG ?? 'today'
const SETTINGS = (process.env.WO1087_RENDER_SETTINGS ?? 'corpus') as 'corpus' | 'bytestab'
const BAND = process.env.WO1087_RENDER_LABEL ?? ''
const ONLY = process.env.WO1087_RENDER_ONLY
  ? process.env.WO1087_RENDER_ONLY.split(',').map(s => Number(s.trim()))
  : null
/** WO-1091: zoom on a POINT rather than on "the second ring". Once the lift-landing gate
 *  stops drilling there is no ring left to focus, and the after picture still has to look at
 *  the same square millimetre the before picture did. Format "x,y" in fixture coordinates. */
const FOCUS_AT: Pt | null = process.env.WO1087_RENDER_FOCUS
  ? (([fx, fy]) => ({ x: fx, y: fy }))(process.env.WO1087_RENDER_FOCUS.split(',').map(Number))
  : null

const W = 1680, H = 900

// ---- tiny 5x7 bitmap font (from _sidebyside.test.ts) -----------------------------
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

/** RGBA framebuffer + PNG encoder, with a clip rect so two panels share one canvas. */
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
  fillRect(x0: number, y0: number, x1: number, y1: number, c: RGB) {
    for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++)
      for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) this.px(x, y, c)
  }
  rect(x0: number, y0: number, x1: number, y1: number, c: RGB, r = 0) {
    this.line(x0, y0, x1, y0, c, r); this.line(x1, y0, x1, y1, c, r)
    this.line(x1, y1, x0, y1, c, r); this.line(x0, y1, x0, y0, c, r)
  }
  circle(cx: number, cy: number, rad: number, c: RGB, thick = 1) {
    const steps = Math.max(24, Math.ceil(rad * 2))
    for (let i = 0; i < steps; i++) {
      const a0 = (i / steps) * 2 * Math.PI, a1 = ((i + 1) / steps) * 2 * Math.PI
      this.line(cx + Math.cos(a0) * rad, cy + Math.sin(a0) * rad, cx + Math.cos(a1) * rad, cy + Math.sin(a1) * rad, c, thick)
    }
  }
  dashedCircle(cx: number, cy: number, rad: number, c: RGB) {
    for (let deg = 0; deg < 360; deg += 4) {
      if (deg % 12 >= 6) continue
      const a = deg * Math.PI / 180
      this.dot(cx + Math.cos(a) * rad, cy + Math.sin(a) * rad, c, 1)
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

const COL = {
  bg: [16, 18, 22] as RGB,
  panel: [10, 11, 14] as RGB,
  frame: [70, 74, 82] as RGB,
  band: [255, 211, 77] as RGB,
  bandText: [20, 20, 20] as RGB,
  label: [205, 210, 218] as RGB,
  dim: [120, 126, 134] as RGB,
  target: [46, 46, 50] as RGB,
  boundary: [150, 150, 150] as RGB,
  hole: [190, 130, 130] as RGB,
  cut: [55, 95, 150] as RGB,
  wall: [0, 200, 155] as RGB,
  finish: [210, 70, 210] as RGB,
  loopback: [220, 160, 0] as RGB,
  keepdown: [40, 160, 40] as RGB,
  lift: [255, 40, 40] as RGB,
  micro: [255, 150, 30] as RGB,
  lead: [120, 220, 255] as RGB,     // WO-1091: an at-depth lead-in into the cut
  helix: [255, 190, 40] as RGB,       // the ring itself, in the viewport's orange
  srcEntry: [80, 255, 120] as RGB,    // ring source: region entry
  srcLift: [255, 60, 60] as RGB,      // ring source: lift landing
  srcFinish: [225, 90, 235] as RGB,   // ring source: finish-lap connection
  stock: [96, 74, 46] as RGB,         // stock still standing under the landing disk
  disk: [235, 240, 250] as RGB,
}

type Move = { x: number; y: number; z: number; role?: string }
type RingSource = 'entry' | 'lift-landing' | 'finish-lap' | 'unattributed'
interface Ring { pts: Pt[]; cx: number; cy: number; source: RingSource; note: string }

/** Group consecutive `role: 'helix'` moves into rings -- one emitted helix ramp each. */
function ringsOf(moves: Move[]): { pts: Pt[]; cx: number; cy: number }[] {
  const out: { pts: Pt[]; cx: number; cy: number }[] = []
  let cur: Pt[] | null = null
  const close = () => {
    if (!cur || cur.length === 0) { cur = null; return }
    out.push({ pts: cur, cx: cur.reduce((s, p) => s + p.x, 0) / cur.length, cy: cur.reduce((s, p) => s + p.y, 0) / cur.length })
    cur = null
  }
  for (const m of moves) {
    if (m.role === 'helix') { (cur ??= []).push({ x: m.x, y: m.y }) } else close()
  }
  close()
  return out
}

interface LiftLanding { center: Pt; radius: number; landing: Pt; passIdx: number; reason: string }

function liftLandings(res: FeatureResult): LiftLanding[] {
  const out: LiftLanding[] = []
  res.passes.forEach((p, i) => {
    if (p.type !== 'link') return
    const l = p as Extract<AdaptivePass, { type: 'link' }>
    if (l.jumpType !== 2 || !l.helixDescent) return
    out.push({
      center: l.helixDescent.center, radius: l.helixDescent.radius,
      landing: l.points[1], passIdx: i, reason: l.liftReason ?? 'unattributed',
    })
  })
  return out
}

/** Every cut the tool physically took BEFORE pass `upto`, swept at the tool radius, plus the
 *  first entry helix's disk. A harness reconstruction of the engine's `clearedBeforePass`,
 *  labelled as one on the picture. `withWallRides` picks the two BOUNDS the engine's own
 *  belief sits between: it folds a WO-447 gap-fill ride's capsule into `cleared` but has never
 *  folded a wall-follow TRANSITION ride, and both emit as `wallfollow` passes with no
 *  discriminator to tell them apart from out here. Cuts only = the most standing stock the
 *  gate could have seen; cuts + wall rides = the least. */
function clearedBefore(res: FeatureResult, upto: number, toolRadius: number, withWallRides: boolean): Loops {
  // Folded ONE corridor at a time, exactly as _wo410-corpus-render's wallRideSweep does.
  // The engine's clipper runs the EVEN-ODD fill rule, so two overlapping corridors handed to
  // union() inside the SAME operand cancel each other and punch a phantom hole; only a
  // normalized set may be an operand. (Batching them is what made this measure non-monotone
  // on the first cut of this harness: more cleared read as MORE standing stock.)
  let acc: Loops = []
  const fold = (loops: Loops) => { if (loops.length) acc = acc.length ? union(acc, loops) : loops }
  // Only the FIRST entry's disk is credited: an AdaptiveEntry carries no pass index, so a
  // re-seed's disk cannot be proven to predate `upto`. On a single-entry feature (Bar, every
  // corpus fixture at the corpus settings) that is exact; on a re-seeding one it UNDER-credits
  // cleared stock, which can only overstate the standing stock, never hide it.
  const first = res.entries[0]
  if (first) fold(diskPath(first.point, toolRadius + (first.mode === 'helix' ? first.radius : 0), ARC_TOL))
  for (let i = 0; i < Math.min(upto, res.passes.length); i++) {
    const p = res.passes[i]
    if (p.type === 'link') continue
    if (p.type === 'wallfollow' && !withWallRides) continue
    const pts = (p as { points?: Pt[] }).points
    if (!pts || pts.length < 2) continue
    fold(offsetOpenRound(pts, toolRadius, ARC_TOL))
  }
  return acc
}

interface View { t: (p: Pt) => [number, number]; pxPerMm: number }

function viewFor(win: { x0: number; y0: number; x1: number; y1: number }, rect: { x0: number; y0: number; x1: number; y1: number }): View {
  const wSpan = Math.max(win.x1 - win.x0, 1e-6), hSpan = Math.max(win.y1 - win.y0, 1e-6)
  const s = Math.min((rect.x1 - rect.x0) / wSpan, (rect.y1 - rect.y0) / hSpan)
  const ox = rect.x0 + ((rect.x1 - rect.x0) - wSpan * s) / 2
  const oy = rect.y0 + ((rect.y1 - rect.y0) - hSpan * s) / 2
  return {
    pxPerMm: s,
    t: (p: Pt) => [ox + (p.x - win.x0) * s, oy + (win.y1 - p.y) * s],
  }
}

function drawScene(fb: FB, v: View, res: FeatureResult, boundary: Pt[], holes: Pt[][], params: ProcessParams) {
  const loop = (pts: Pt[], c: RGB, close: boolean, r = 0) => {
    for (let i = 1; i < pts.length; i++) { const a = v.t(pts[i - 1]), b = v.t(pts[i]); fb.line(a[0], a[1], b[0], b[1], c, r) }
    if (close && pts.length > 2) { const a = v.t(pts[pts.length - 1]), b = v.t(pts[0]); fb.line(a[0], a[1], b[0], b[1], c, r) }
  }
  const finishStock = params.tolerance / 2 + (params.stockToLeave ?? 0)
  const target = difference(offsetClosed([boundary], -finishStock, ARC_TOL), offsetClosed(holes, finishStock, ARC_TOL))
  for (const l of target) loop(l, COL.target, true)
  loop(boundary, COL.boundary, true)
  for (const h of holes) loop(h, COL.hole, true)
  for (const p of res.passes) if (p.type === 'cut') loop(p.points, COL.cut, false)
  for (const p of res.passes) if (p.type === 'wallfollow') loop(p.points, COL.wall, false)
  for (const p of res.passes) if (p.type === 'finish') loop((p as Extract<AdaptivePass, { type: 'finish' }>).points, COL.finish, false)
  for (const p of res.passes) if (p.type === 'loopback') loop(p.points, COL.loopback, false)
  // WO-1091: the lead-in a side landing hands the cut. Drawn thick: on an after picture it
  // IS the subject, and it is the only at-depth motion the pre-WO-1091 pictures never had.
  for (const p of res.passes) if (p.type === 'lead') loop(p.points, COL.lead, false, 1)
  for (const p of res.passes) {
    if (p.type !== 'link') continue
    const l = p as Extract<AdaptivePass, { type: 'link' }>
    if (l.jumpType === 1) loop(l.points, COL.keepdown, false)
    else if ((l as { microLift?: unknown }).microLift) loop(l.points, COL.micro, false, 1)
    else loop(l.points, COL.lift, false, 1)
  }
}

function drawRings(fb: FB, v: View, rings: Ring[], numbered: boolean) {
  rings.forEach((ring, i) => {
    // the emitted ramp itself, exactly as the viewport draws it
    for (let k = 1; k < ring.pts.length; k++) {
      const a = v.t(ring.pts[k - 1]), b = v.t(ring.pts[k])
      fb.line(a[0], a[1], b[0], b[1], COL.helix, 1)
    }
    const c = ring.source === 'entry' ? COL.srcEntry : ring.source === 'lift-landing' ? COL.srcLift : COL.srcFinish
    const [px, py] = v.t({ x: ring.cx, y: ring.cy })
    fb.circle(px, py, Math.max(9, v.pxPerMm * 3.2), c, 1)
    if (numbered) fb.text(`#${i + 1}`, px + Math.max(9, v.pxPerMm * 3.2) + 5, py - 7, c, 2)
  })
}

function renderFixture(fix: number, params: ProcessParams, name: string): {
  file: string; rings: Ring[]; focusNote: string
} {
  const { boundary, holes } = loadGtFixture(fix)
  const warns: string[] = []
  const warn = console.warn
  console.warn = (...a: unknown[]) => { warns.push(a.map(String).join(' ')) }
  let res: FeatureResult, moves: Move[]
  try {
    res = processFeature({ boundary, holes }, params)
    moves = emitFeature(res, CTX) as unknown as Move[]
  } finally { console.warn = warn }

  const entryHelixes = res.entries.filter(e => e.mode === 'helix')
  const lifts = liftLandings(res)
  const finishHelixes = (res.finishApproaches ?? []).filter(a => a?.helix).map(a => a!.helix!)
  const near = (r: { cx: number; cy: number }, p: Pt) => Math.hypot(p.x - r.cx, p.y - r.cy) <= 0.75

  const rings: Ring[] = ringsOf(moves).map(r => {
    const e = entryHelixes.findIndex(x => near(r, x.point))
    if (e >= 0) return { ...r, source: 'entry' as const, note: e === 0 ? "the feature's FIRST entry" : `re-seed entry #${e}` }
    const l = lifts.findIndex(x => near(r, x.center))
    if (l >= 0) return { ...r, source: 'lift-landing' as const, note: `lift landing, pass #${lifts[l].passIdx}, reason ${lifts[l].reason.slice(0, 46)}` }
    const f = finishHelixes.findIndex(x => near(r, x.center))
    if (f >= 0) return { ...r, source: 'finish-lap' as const, note: `wall-finish lap connection #${f + 1}` }
    return { ...r, source: 'unattributed' as const, note: 'UNATTRIBUTED' }
  })

  // The ring of interest: the first ring that is NOT the feature's first entry -- the second
  // helix Operator's pictures arrow at. With only one ring, zoom the entry instead.
  const focusIdx = rings.length > 1 ? 1 : 0
  const focus = rings[focusIdx]
  // WO-1091: with FOCUS_AT the zoom is pinned to a point, and the landing it explains is the
  // retract that puts the cutter down nearest that point -- ring or no ring.
  const focusLink = FOCUS_AT
    ? res.passes
      .map((p, i) => ({ p, i }))
      .filter((x): x is { p: Extract<AdaptivePass, { type: 'link' }>; i: number } =>
        x.p.type === 'link' && x.p.jumpType === 2)
      .sort((a, b) =>
        Math.hypot(a.p.points[1].x - FOCUS_AT.x, a.p.points[1].y - FOCUS_AT.y)
        - Math.hypot(b.p.points[1].x - FOCUS_AT.x, b.p.points[1].y - FOCUS_AT.y))[0] ?? null
    : null
  const zoomCentre: Pt | null = FOCUS_AT ?? (focus ? { x: focus.cx, y: focus.cy } : null)

  // ---- the stock standing under the focus landing, reconstructed from the pass stream ----
  let standingHigh: number | null = null   // cuts only
  let standingLow: number | null = null    // cuts + wall rides
  let clearedLoops: Loops = []
  let landingPt: Pt | null = null
  const landingSource: { landing: Pt; passIdx: number } | null = focusLink
    ? { landing: focusLink.p.points[1], passIdx: focusLink.i }
    : (focus && focus.source === 'lift-landing' ? lifts.find(x => near(focus, x.center))! : null)
  if (landingSource) {
    const l = landingSource
    landingPt = l.landing
    const disk = diskPath(l.landing, params.toolRadius, ARC_TOL)
    const diskArea = Math.abs(netArea(disk))
    const standing = (cleared: Loops) => diskArea > 0
      ? 100 * (1 - Math.abs(netArea(intersection(disk, cleared))) / diskArea)
      : null
    clearedLoops = clearedBefore(res, l.passIdx, params.toolRadius, false)
    standingHigh = standing(clearedLoops)
    standingLow = standing(clearedBefore(res, l.passIdx, params.toolRadius, true))
  }

  // ---- canvas ----
  const fb = new FB(W, H, COL.bg)
  const bandH = 62
  fb.fillRect(0, 0, W - 1, bandH - 1, COL.band)
  const title = BAND || `${TAG.toUpperCase()} - FIX${fix} ${name} - ${SETTINGS} SETTINGS - ${rings.length} EMITTED HELIX RING(S)`
  fb.text(title.slice(0, 92), 12, 14, COL.bandText, 3)
  fb.text(`FIX${fix} ${name}  ${SETTINGS}  RINGS=${rings.length}  ENTRIES=${res.entries.length}  LIFT-HELIX=${lifts.length}  FINISH-LAP-HELIX=${finishHelixes.length}`, 12, 42, COL.bandText, 2)

  const top = bandH + 10, bot = 744
  const lp = { x0: 10, y0: top, x1: 830, y1: bot }
  const rp = { x0: 844, y0: top, x1: W - 10, y1: bot }
  fb.fillRect(lp.x0, lp.y0, lp.x1, lp.y1, COL.panel)
  fb.fillRect(rp.x0, rp.y0, rp.x1, rp.y1, COL.panel)

  // LEFT: the whole part, auto-fit.
  const xs = [...boundary, ...holes.flat()].map(p => p.x), ys = [...boundary, ...holes.flat()].map(p => p.y)
  const pad = 3
  const win = { x0: Math.min(...xs) - pad, y0: Math.min(...ys) - pad, x1: Math.max(...xs) + pad, y1: Math.max(...ys) + pad }
  const vL = viewFor(win, { x0: lp.x0 + 6, y0: lp.y0 + 26, x1: lp.x1 - 6, y1: lp.y1 - 6 })
  fb.clip(lp.x0 + 1, lp.y0 + 1, lp.x1 - 1, lp.y1 - 1)
  drawScene(fb, vL, res, boundary, holes, params)
  drawRings(fb, vL, rings, true)
  if (zoomCentre) {
    // the zoom window, marked on the overview
    const zHalf = 11
    const a = vL.t({ x: zoomCentre.x - zHalf, y: zoomCentre.y + zHalf }), b = vL.t({ x: zoomCentre.x + zHalf, y: zoomCentre.y - zHalf })
    fb.rect(a[0], a[1], b[0], b[1], COL.label, 0)
  }
  fb.noClip()
  fb.text(`WHOLE PART, ${vL.pxPerMm.toFixed(1)} PX/MM - EVERY HELIX RING NUMBERED IN CUT ORDER`.slice(0, 66), lp.x0 + 8, lp.y0 + 8, COL.label, 2)
  fb.rect(lp.x0, lp.y0, lp.x1, lp.y1, COL.frame)

  // RIGHT: the zoom on the ring of interest.
  fb.clip(rp.x0 + 1, rp.y0 + 1, rp.x1 - 1, rp.y1 - 1)
  if (zoomCentre) {
    const zHalf = 11
    const zwin = { x0: zoomCentre.x - zHalf, y0: zoomCentre.y - zHalf, x1: zoomCentre.x + zHalf, y1: zoomCentre.y + zHalf }
    const vR = viewFor(zwin, { x0: rp.x0 + 6, y0: rp.y0 + 26, x1: rp.x1 - 6, y1: rp.y1 - 6 })
    // the reconstructed standing stock: hatch everything the swept cuts have NOT reached
    if (clearedLoops.length) {
      const diskBig = diskPath(landingPt ?? zoomCentre, 9, ARC_TOL)
      const standing = difference(diskBig, clearedLoops)
      for (const l of standing) {
        for (let i = 0; i < l.length; i++) {
          const a = vR.t(l[i]), b = vR.t(l[(i + 1) % l.length])
          fb.line(a[0], a[1], b[0], b[1], COL.stock, 1)
        }
      }
      // hatch the standing area so it reads as material, not as another contour
      const step = 7
      for (const l of standing) {
        const lys = l.map(p => vR.t(p)[1]), lxs = l.map(p => vR.t(p)[0])
        const y0 = Math.min(...lys), y1 = Math.max(...lys), x0 = Math.min(...lxs), x1 = Math.max(...lxs)
        for (let yy = y0; yy <= y1; yy += step) {
          for (let xx = x0; xx <= x1; xx += step) {
            // point-in-polygon on the pixel-space loop
            let inside = false
            for (let i = 0, j = l.length - 1; i < l.length; j = i++) {
              const pi = vR.t(l[i]), pj = vR.t(l[j])
              if ((pi[1] > yy) !== (pj[1] > yy) && xx < (pj[0] - pi[0]) * (yy - pi[1]) / (pj[1] - pi[1]) + pi[0]) inside = !inside
            }
            if (inside) fb.dot(xx, yy, COL.stock, 1)
          }
        }
      }
    }
    drawScene(fb, vR, res, boundary, holes, params)
    // the cutter disk at the landing the gate judged (link.points[1]), not at the ring centre
    const [fx, fy] = vR.t(landingPt ?? zoomCentre)
    fb.dashedCircle(fx, fy, params.toolRadius * vR.pxPerMm, COL.disk)
    fb.dot(fx, fy, COL.disk, 2)
    if (focus) drawRings(fb, vR, [focus], false)
    fb.noClip()
    const zoomLabel = FOCUS_AT
      ? `ZOOM ON (${FOCUS_AT.x.toFixed(2)}, ${FOCUS_AT.y.toFixed(2)}), ${vR.pxPerMm.toFixed(1)} PX/MM - DASHED WHITE = THE 4 MM CUTTER DISK AT THE LANDING`
      : `ZOOM ON RING #${focusIdx + 1}, ${vR.pxPerMm.toFixed(1)} PX/MM - DASHED WHITE = THE 4 MM CUTTER DISK`
    fb.text(zoomLabel.slice(0, 70), rp.x0 + 8, rp.y0 + 8, COL.label, 2)
  } else {
    fb.noClip()
    fb.text('NO HELIX RING EMITTED ON THIS FIXTURE', rp.x0 + 8, rp.y0 + 8, COL.label, 2)
  }
  fb.rect(rp.x0, rp.y0, rp.x1, rp.y1, COL.frame)

  // ---- legend + the facts, under the panels ----
  let ly = bot + 8
  const legend: [string, RGB][] = [
    ['HELIX RAMP (EMITTED)', COL.helix], ['RING = ENTRY', COL.srcEntry], ['RING = LIFT LANDING', COL.srcLift],
    ['RING = FINISH LAP', COL.srcFinish], ['CUT', COL.cut], ['WALL RIDE', COL.wall], ['FINISH LAP', COL.finish],
    ['LOOPBACK', COL.loopback], ['KEEP-DOWN LINK', COL.keepdown], ['RETRACT', COL.lift], ['MICRO-LIFT', COL.micro],
    ['LEAD-IN', COL.lead], ['STANDING STOCK', COL.stock],
  ]
  let lx = 12
  for (const [t, c] of legend) {
    fb.fillRect(lx, ly + 1, lx + 12, ly + 11, c)
    fb.text(t, lx + 17, ly + 2, COL.label, 1)
    lx += 22 + t.length * 6 + 12
  }
  ly += 20
  const facts: string[] = rings.map((r, i) => `RING #${i + 1} AT (${r.cx.toFixed(2)}, ${r.cy.toFixed(2)}): ${r.source.toUpperCase()} - ${r.note}`)
  if (standingHigh !== null && standingLow !== null && landingPt) {
    const drilled = lifts.some(l => Math.hypot(l.landing.x - landingPt!.x, l.landing.y - landingPt!.y) < 1e-9)
    facts.push(`LANDING DISK AT (${landingPt.x.toFixed(2)}, ${landingPt.y.toFixed(2)}): ${standingLow.toFixed(1)}-${standingHigh.toFixed(1)}% OF THE 4 MM CUTTER DISK IS STANDING STOCK`
      + ` VS THE GATE'S 5% CAP - ${drilled ? 'SO THE GATE DRILLED INSTEAD OF PLUNGING.' : 'AND THE GATE PUT THE CUTTER DOWN HERE IN AIR.'}`)
    facts.push('HARNESS RECONSTRUCTION OF CLEARED: SWEPT CUTS BEFORE THAT PASS + THE ENTRY DISK. LOW = WALL RIDES CREDITED, HIGH = CUTS ONLY. HATCH = HIGH.')
  }
  if (rings.length === 1) facts.push('ONLY THE FIRST ENTRY HELIX IS EMITTED ON THIS FIXTURE - NO SECOND RING TODAY.')
  for (const f of facts.slice(0, 6)) { fb.text(f.slice(0, 138), 12, ly, COL.label, 2); ly += 17 }
  fb.text(`PARAMS: R${params.toolRadius} STEPOVER ${params.stepOver} STOCK ${params.stockToLeave} HELIX-D ${params.helixDiameter} WALLFINISH ${params.wallFinish ? 'ON' : 'OFF'} ${params.millingDirection ?? 'default'}`,
    12, H - 20, COL.dim, 2)

  fs.mkdirSync(OUT_DIR, { recursive: true })
  const file = `${OUT_DIR}/fix${fix}_${name}_${TAG}.png`
  fs.writeFileSync(file, fb.png())
  const focusNote = focus ? `${focus.source}@(${focus.cx.toFixed(2)},${focus.cy.toFixed(2)})` : 'none'
  console.log(`fix${fix} ${name}: ${rings.length} ring(s) -> ${rings.map((r, i) => `#${i + 1} ${r.source}@(${r.cx.toFixed(2)},${r.cy.toFixed(2)})`).join(' ')}`
    + (standingHigh !== null ? ` | landing disk ${standingLow!.toFixed(1)}-${standingHigh.toFixed(1)}% standing stock vs 5% cap` : '')
    + ` | wrote ${file} ${W}x${H}`)
  return { file, rings, focusNote }
}

describe('WO-1087: the rings, drawn and attributed (1680x900 picture gate)', () => {
  beforeAll(async () => { await ensureEngineClipperReady() })

  it.skipIf(!process.env.WO1087_RENDER)('renders every corpus fixture with each helix ring attributed', () => {
    const report: Record<string, unknown> = {}
    for (const meta of FIXTURE_META) {
      if (ONLY && !ONLY.includes(meta.fix)) continue
      const { helixDiameter } = loadGtFixture(meta.fix)
      const params: ProcessParams = SETTINGS === 'corpus' ? CORPUS_PARAMS : { ...CANONICAL_PARAMS, helixDiameter }
      const r = renderFixture(meta.fix, params, meta.name)
      report[`fix${meta.fix}`] = {
        name: meta.name, file: r.file, focus: r.focusNote,
        rings: r.rings.map(x => ({ x: Number(x.cx.toFixed(2)), y: Number(x.cy.toFixed(2)), source: x.source, note: x.note })),
      }
    }
    fs.writeFileSync(`${OUT_DIR}/rings_${TAG}.json`, JSON.stringify(report, null, 2) + '\n')
    expect(Object.keys(report).length).toBeGreaterThan(0)
  }, 3_000_000)
})
