// WO-1103 PICTURES (evidence only; writes nothing unless WRITE_EVIDENCE=1).
//
// Three 1680x900 PNGs for Operator's picture gate, all in src/tests/evidence/WO-1103/:
//   bar-before-after-fusion.png  whole part, three panels: our old path, our new path, Fusion
//   bar-entry-zoom.png           the same three, zoomed on the entry and the seam
//   census-table.png             the nine-part census, both settings banks
//
// The BEFORE path cannot be replanned from this branch's engine, so it is read from
// before-bar-path.json -- dumped from the pre-WO-1103 engine and committed beside it. The
// AFTER path is replanned live, so the picture can never drift from what the engine does.
//
//   WRITE_EVIDENCE=1 npx vitest run src/tests/adaptive-clearing/engine/_wo1103-picture.test.ts
import { describe, it, beforeAll, expect } from 'vitest'
import * as fs from 'fs'
import * as zlib from 'zlib'
import {
  ensureEngineClipperReady, offsetClosed, offsetOpenRound, union, difference, diskPath,
  type Loop, type Loops, type Pt,
} from '../../../lib/cam/adaptiveClearing2d/engine/clipperEngine'
import { processFeature, type AdaptivePass, type ProcessParams } from '../../../lib/cam/adaptiveClearing2d/engine/processFeature'

const TOOL_RADIUS = 2.0
const ARC_TOL = 0.05
const EVID = 'src/tests/evidence/WO-1103'
const WRITE = !!process.env.WRITE_EVIDENCE
const CORPUS_PARAMS: ProcessParams = {
  toolRadius: TOOL_RADIUS, stepOver: 0.4, tolerance: 0.1, helixDiameter: 3.8, stockToLeave: 0.5,
  integralWallFollow: true, integralWallFollowLengthFactor: 2, wallCleanupAsWeGo: true,
  loopbackFilletPct: 25, wallFinish: true, millingDirection: 'climb',
}
const P = (a: number[]): Pt => ({ x: a[0], y: a[1] })
const poly = (a: number[][]): Pt[] => a.map(P)

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
// ---------------------------------------------------------------------------------------

interface Plan { entries: { point: Pt; radius: number; mode: string }[]; passes: AdaptivePass[]; cutRegion: Loops }

/** Everything the tool has removed by the time pass `stop` runs: every entry's bored disk
 *  plus every cutting pass's swept corridor. Retracted links (jumpType 2) remove nothing. */
function clearedUpTo(plan: Plan, stop: number): Loops {
  let cleared: Loops = []
  for (const e of plan.entries) if (e.radius > 0) cleared = union(cleared, diskPath(e.point, e.radius + TOOL_RADIUS, ARC_TOL))
  for (let i = 0; i < stop && i < plan.passes.length; i++) {
    const p = plan.passes[i]
    if (p.type === 'link' && (p as { jumpType?: number }).jumpType === 2) continue
    if (p.type !== 'cut' && p.type !== 'lead' && p.type !== 'wallfollow' && p.type !== 'loopback'
      && p.type !== 'finish' && p.type !== 'link') continue
    if (p.points.length < 2) continue
    const sweep = offsetOpenRound(p.points, TOOL_RADIUS, ARC_TOL)
    if (sweep.length) cleared = union(cleared, sweep)
  }
  return cleared
}

const liftsOf = (plan: Plan): AdaptivePass[] =>
  plan.passes.filter(p => p.type === 'link' && (p as { jumpType?: number }).jumpType === 2)

/** A view that fits `box` into a panel, same scale shared across every panel so the three
 *  paths are directly comparable on the page. */
function viewFor(x0: number, y0: number, x1: number, y1: number, px0: number, py0: number, px1: number, py1: number, scale?: number): View {
  const s = scale ?? Math.min((px1 - px0) / Math.max(x1 - x0, 1e-6), (py1 - py0) / Math.max(y1 - y0, 1e-6))
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2
  return { s, ox: (px0 + px1) / 2 - cx * s, oy: (py0 + py1) / 2 + cy * s }
}

function drawPath(fb: FB, v: View, plan: Plan, standing: Loops, highlightFrom: number): void {
  fillLoops(fb, v, standing, COL.standing)
  for (const lp of plan.cutRegion) drawPoly(fb, v, [...lp, lp[0]], COL.centre)
  plan.passes.forEach((p, i) => {
    if (p.type === 'link' && (p as { jumpType?: number }).jumpType === 2) {
      const a = p.points[0], b = p.points[p.points.length - 1]
      fb.dashedLine(vx(v, a), vy(v, a), vx(v, b), vy(v, b), COL.lift, 1)
      fb.dot(vx(v, a), vy(v, a), COL.lift, 4)
      fb.dot(vx(v, b), vy(v, b), COL.lift, 4)
      fb.circle(vx(v, a), vy(v, a), 5.0 * v.s, COL.ring, 1)
      return
    }
    if (p.type !== 'cut' && p.type !== 'wallfollow' && p.type !== 'loopback' && p.type !== 'lead' && p.type !== 'link') return
    if (p.points.length < 2) return
    const c = p.type === 'cut' ? (i < highlightFrom ? COL.cutOld : COL.cut)
      : p.type === 'wallfollow' ? COL.cutOld
        : p.type === 'loopback' ? COL.loopback
          : p.type === 'lead' ? COL.lead : COL.loopback
    drawPoly(fb, v, p.points, c, 0)
  })
  for (const e of plan.entries) {
    fb.circle(vx(v, e.point), vy(v, e.point), Math.max(3, e.radius * v.s), COL.disk, 1)
    fb.dot(vx(v, e.point), vy(v, e.point), COL.disk, 3)
  }
}

describe('WO-1103 pictures', () => {
  beforeAll(async () => { await ensureEngineClipperReady() }, 120_000)

  it('draws before / after / Fusion, and the census table', () => {
    const beforeRaw = JSON.parse(fs.readFileSync(`${EVID}/before-bar-path.json`, 'utf8'))
    const before: Plan = {
      entries: beforeRaw.entries, passes: beforeRaw.passes,
      cutRegion: (beforeRaw.cutRegion as { x: number; y: number }[][]),
    }
    const boundary: Loop = poly(beforeRaw.boundary as number[][])
    const warn = console.warn
    console.warn = () => {}
    let res
    try { res = processFeature({ boundary, holes: [] }, CORPUS_PARAMS) } finally { console.warn = warn }
    const after: Plan = { entries: res.entries, passes: res.passes, cutRegion: res.cutRegion }

    // THE CLAIM THE PICTURE IS EVIDENCE FOR, asserted here so the two can never disagree.
    expect(liftsOf(before).length).toBe(1)
    expect(liftsOf(after).length).toBe(0)

    const F = JSON.parse(fs.readFileSync('src/tests/evidence/WO-1100/fusion-bar.json', 'utf8')) as {
      boundary: number[][]; toolpathCenter: number[][]; helix: { center: number[]; radius: number }
      spiral: number[][] | null; cuts: number[][][]; links: (number[][] | null)[]
    }
    if (!WRITE) return

    const W = 1680, H = 900
    const PAD_T = 46, PAD_B = 74
    const target: Loops = offsetClosed(before.cutRegion, TOOL_RADIUS, ARC_TOL)
    // Each panel is frozen at ITS OWN decisive moment: for the before path that is the lift,
    // for the after path the same point in the walk, for Fusion its equivalent link.
    const beforeLiftIdx = before.passes.indexOf(liftsOf(before)[0])
    const standingBefore = difference(target, clearedUpTo(before, beforeLiftIdx))
    const standingAfter = difference(target, clearedUpTo(after, beforeLiftIdx))

    let box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }
    for (const p of boundary) {
      box = { x0: Math.min(box.x0, p.x), y0: Math.min(box.y0, p.y), x1: Math.max(box.x1, p.x), y1: Math.max(box.y1, p.y) }
    }
    const render = (file: string, title: string, zoom: { cx: number; cy: number; half: number } | null, legend: string[]): void => {
      const fb = new FB(W, H, COL.bg)
      const PY0 = PAD_T, PY1 = H - 8
      const pw = Math.floor(W / 3)
      const panels = [
        { x0: 0, x1: pw - 1, title: 'BEFORE: HELIX AT THE MIDDLE, ONE RETRACT' },
        { x0: pw, x1: 2 * pw - 1, title: 'AFTER (WO-1103): HELIX NEAR THE END, NO RETRACT' },
        { x0: 2 * pw, x1: W - 1, title: 'FUSION, SAME PART' },
      ]
      fb.fillRect(0, 0, W - 1, PAD_T - 1, COL.band)
      fb.text(title, 14, 12, COL.bandText, 2)
      for (const pn of panels) {
        fb.fillRect(pn.x0, PY0, pn.x1, PY1, COL.panel)
        fb.rect(pn.x0, PY0, pn.x1, PY1, COL.frame)
      }
      // ONE SCALE for all three panels: a size difference on the page is then a real one.
      // A zoom has to be driven by the panel's WIDTH alone: fitting a square window into a
      // tall narrow panel picks the height and barely magnifies anything (the first cut of
      // this picture zoomed by 11% and read as "not zoomed"). Scale on width, clip the rest.
      const fit = (b: { x0: number; y0: number; x1: number; y1: number }, pn: { x0: number; x1: number }) =>
        zoom
          ? viewFor(zoom.cx - zoom.half, zoom.cy - zoom.half, zoom.cx + zoom.half, zoom.cy + zoom.half,
            pn.x0 + 16, PY0 + PAD_T, pn.x1 - 16, PY1 - PAD_B, (pn.x1 - pn.x0 - 32) / (2 * zoom.half))
          : viewFor(b.x0, b.y0, b.x1, b.y1, pn.x0 + 16, PY0 + PAD_T, pn.x1 - 16, PY1 - PAD_B)

      // panel 1: before
      {
        const pn = panels[0], v = fit(box, pn)
        fb.clip(pn.x0 + 2, PY0 + 2, pn.x1 - 2, PY1 - 2)
        drawPath(fb, v, before, standingBefore, beforeLiftIdx)
        drawPoly(fb, v, [...boundary, boundary[0]], COL.boundary)
        fb.noClip()
      }
      // panel 2: after
      {
        const pn = panels[1], v = fit(box, pn)
        fb.clip(pn.x0 + 2, PY0 + 2, pn.x1 - 2, PY1 - 2)
        drawPath(fb, v, after, standingAfter, beforeLiftIdx)
        drawPoly(fb, v, [...boundary, boundary[0]], COL.boundary)
        fb.noClip()
      }
      // panel 3: Fusion
      {
        const pn = panels[2], v = fit(box, pn)
        fb.clip(pn.x0 + 2, PY0 + 2, pn.x1 - 2, PY1 - 2)
        drawPoly(fb, v, [...poly(F.toolpathCenter), poly(F.toolpathCenter)[0]], COL.centre)
        for (let i = 0; i < F.cuts.length; i++) {
          drawPoly(fb, v, poly(F.cuts[i]), COL.cut)
          const lk = F.links[i]
          if (lk) drawPoly(fb, v, poly(lk), COL.loopback)
        }
        if (F.spiral) drawPoly(fb, v, poly(F.spiral), COL.cutOld)
        const hc = P(F.helix.center)
        fb.circle(vx(v, hc), vy(v, hc), Math.max(3, F.helix.radius * v.s), COL.disk, 1)
        fb.dot(vx(v, hc), vy(v, hc), COL.disk, 3)
        drawPoly(fb, v, [...poly(F.boundary), poly(F.boundary)[0]], COL.boundary)
        fb.noClip()
      }
      for (const pn of panels) {
        fb.fillRect(pn.x0 + 1, PY0 + 1, pn.x1 - 1, PY0 + PAD_T - 10, COL.panel)
        fb.text(pn.title, pn.x0 + 14, PY0 + 12, COL.label, 1)
      }
      fb.fillRect(0, PY1 - PAD_B + 4, W - 1, PY1 - 1, COL.panel)
      let ty = PY1 - PAD_B + 12
      for (const l of legend) { fb.text(l, 14, ty, COL.dim, 1); ty += 13 }
      fs.writeFileSync(`${EVID}/${file}`, fb.png())
      console.log(`wrote ${EVID}/${file} (${W}x${H})`)
    }

    const beforeEntry = before.entries[0].point
    const afterEntry = after.entries[0].point
    render('bar-before-after-fusion.png',
      `WO-1103 BAR, CORPUS SETTINGS: ENTRY (${beforeEntry.x.toFixed(2)},${beforeEntry.y.toFixed(2)}) -> (${afterEntry.x.toFixed(2)},${afterEntry.y.toFixed(2)}), RETRACTS 1 -> 0`,
      null,
      [
        'RED DASH + YELLOW RING = A RETRACT. THE BEFORE PANEL HAS ONE AT THE MIDDLE OF THE BAR; THE AFTER PANEL HAS NONE; FUSION HAS NONE.',
        'WHITE CIRCLE = THE HELIX ENTRY. BLUE = ROUGHING CUTS   ORANGE = STAY-DOWN LINKS   DARK BLUE = THE OPENING SPIRAL   BROWN = STOCK STILL STANDING AT THE FROZEN MOMENT',
        `AFTER'S HELIX IS ${Math.hypot(afterEntry.x - F.helix.center[0], afterEntry.y - F.helix.center[1]).toFixed(2)}MM FROM FUSION'S (${F.helix.center[0].toFixed(2)},${F.helix.center[1].toFixed(2)}). FUSION PANEL IS AN XY EXPORT WITH NO Z - SEE WO-1100 COMPARE.MD.`,
      ])

    render('bar-entry-zoom.png',
      'WO-1103 BAR, THE ENTRY END ZOOMED: WHERE THE HELIX GOES AND WHAT IT LEAVES BEHIND',
      { cx: afterEntry.x, cy: (afterEntry.y + F.helix.center[1]) / 2 - 2, half: 13 },
      [
        'SAME THREE PATHS, SAME SCALE, ZOOMED ON THE TOP END OF THE BAR.',
        'BEFORE PUTS THE HELIX 20MM FURTHER DOWN (OFF THIS VIEW) AND HAS TO COME BACK UP FOR THIS END LATER; AFTER AND FUSION BOTH START HERE AND WORK AWAY FROM IT.',
      ])

    // ---- the nine-part census table -----------------------------------------------------
    {
      const rows = fs.readFileSync(`${EVID}/census.tsv`, 'utf8').trim().split('\n').map(r => r.split('\t'))
      const head = rows[0]
      const col = (n: string) => head.indexOf(n)
      const fb = new FB(W, H, COL.bg)
      const TABLE_BOTTOM = 520
      fb.fillRect(0, 46, W - 1, TABLE_BOTTOM, COL.panel)
      fb.rect(0, 46, W - 1, TABLE_BOTTOM, COL.frame)
      fb.fillRect(0, 0, W - 1, 45, COL.band)
      fb.text('WO-1103 CENSUS: NINE GT FIXTURES, BOTH SETTINGS BANKS -- ONLY BAR MOVED', 14, 12, COL.bandText, 2)
      const cols: [string, number][] = [
        ['SETTINGS', 20], ['FIXTURE', 150], ['CHANGED', 330], ['ENTRY BEFORE', 520],
        ['ENTRY AFTER', 800], ['LIFTS', 1080], ['PASSES', 1220], ['RESIDUAL', 1360], ['MAXCUT', 1520],
      ]
      let y = 62
      for (const [t, x] of cols) fb.text(t, x, y, COL.label, 1)
      y += 16
      fb.line(14, y, W - 14, y, COL.frame)
      y += 8
      const short = (s: string) => s.replace('helix@', '').replace(/r1\.90/g, '').trim()
      for (let i = 1; i < rows.length; i++) {
        const r = rows[i]
        const moved = r[col('changed')] === 'YES'
        const c = moved ? COL.ring : COL.dim
        const cells = [
          r[col('settings')], `${r[col('fixture')]} ${r[col('name')]}`, moved ? 'MOVED' : 'IDENTICAL',
          short(r[col('entryBefore')]).slice(0, 44), short(r[col('entryAfter')]).slice(0, 44),
          `${r[col('liftsBefore')]} -> ${r[col('liftsAfter')]}`,
          `${r[col('passesBefore')]} -> ${r[col('passesAfter')]}`,
          `${Number(r[col('residualBefore')]).toFixed(1)} -> ${Number(r[col('residualAfter')]).toFixed(1)}`,
          `${Number(r[col('maxCutBefore')]).toFixed(2)} -> ${Number(r[col('maxCutAfter')]).toFixed(2)}`,
        ]
        cells.forEach((t, k) => fb.text(t, cols[k][1], y, c, 1))
        y += 17
        if (i === 9) { fb.line(14, y - 4, W - 14, y - 4, COL.frame); y += 6 }
      }
      y += 18
      fb.text('SETPOINT (WIDEST CUT ALLOWED): 1.573 AT THE CORPUS BANK, 0.787 AT THE BYTESTAB BANK.', 20, y, COL.label, 1)
      y += 16
      fb.text("BAR IS THE ONLY REGION THE CHANNEL RULE FIRES ON: ITS SATURATED DISK STRANDS TWO EQUAL LOBES ON OPPOSITE SIDES OF THE ENTRY.", 20, y, COL.label, 1)
      y += 16
      fb.text('EVERY OTHER FIXTURE IS BYTE-IDENTICAL AT BOTH BANKS -- SAME HASH, SAME PASS COUNT, SAME ENTRY.', 20, y, COL.label, 1)
      fb.text('SOURCE: SRC/TESTS/EVIDENCE/WO-1103/CENSUS.TSV, WRITTEN BY _WO1087-CENSUS.TEST.TS BEFORE AND AFTER THE CHANGE.', 20, TABLE_BOTTOM - 22, COL.dim, 1)
      fs.writeFileSync(`${EVID}/census-table.png`, fb.png())
      console.log(`wrote ${EVID}/census-table.png (${W}x${H})`)
    }
  }, 600_000)
})
