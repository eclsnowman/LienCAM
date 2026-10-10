// HELIX-DESCENT RENDER (diagnostic scratch, underscore + env-gated -- the normal suite
// SKIPS it). Renders docs/planning/helix_reentry_bar.png: Bar gt fixture's FIRST inter-pass
// transition area, where the raw engagement-walker landing used to be a straight full-width
// plunge into an ~88%-uncut disk (the 472eb61 known remaining hole). The lift-landing gate
// now plans a HELIX DESCENT at the landing (centre shifted inward off the wall by the helix
// radius) and emit descends via the same helix ramp construction as a region entry, then a
// short at-depth lead to the pass start.
//
// Style follows the prior b8 renders (_lift-reentry-probe): dark bg, gray boundary, blue cut
// passes, green wallfollows, dim-gray lift links. New: ORANGE = the emitted helix descent
// spiral (role 'helix' moves circling the planned centre), YELLOW = the at-depth lead to the
// pass start, WHITE dot = the landing (pass start), ORANGE cross = planned helix centre,
// dim ring = the disk the helix opens (radius + toolR). Right panel = 30x30mm zoom.
//
//   HELIX_RENDER=1 npx vitest run src/tests/adaptive-clearing/engine/_helix-descent-render.test.ts

import { describe, it, expect, beforeAll } from 'vitest'
import * as fs from 'fs'
import * as zlib from 'zlib'
import { ensureEngineClipperReady, type Loop, type Pt } from '../../../lib/cam/adaptiveClearing2d/engine/clipperEngine'
import { processFeature, type AdaptivePass } from '../../../lib/cam/adaptiveClearing2d/engine/processFeature'
import { emitFeature, type EmitContext } from '../../../lib/cam/adaptiveClearing2d/engine/emit'

// ---------------------------------------------------------------- PNG (pattern from _lift-reentry-probe)
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

function loadGtFixture(fix: number): { boundary: Loop; holes: Loop[]; helixDiameter: number; name: string } {
  const d = JSON.parse(fs.readFileSync(`test_fixtures/adaptive-clearing/spirals/_cmp/_gt/gt_fix${fix}.json`, 'utf8'))
  return {
    boundary: (d.boundary as number[][]).map(([x, y]) => ({ x, y })),
    holes: (d.islands ?? []).map((isl: number[][]) => isl.map(([x, y]: number[]) => ({ x, y }))),
    helixDiameter: d.helix?.diameter ?? 3,
    name: d.name,
  }
}

describe.skipIf(!process.env.HELIX_RENDER)('helix descent render (Bar first transition)', () => {
  beforeAll(async () => { await ensureEngineClipperReady() })

  it('renders docs/planning/helix_reentry_bar.png', () => {
    const { boundary, holes, helixDiameter } = loadGtFixture(4) // Bar
    const TOOLR = 2.0
    const res = processFeature({ boundary, holes }, {
      toolRadius: TOOLR, stepOver: 0.2, tolerance: 0.1, helixDiameter, stockToLeave: 0.5,
      integralWallFollow: true, wallCleanupAsWeGo: true, loopbackFilletPct: 25,
    })

    // First emitted lift carrying the planned helix descent (the gated first transition).
    let descent: { link: Extract<AdaptivePass, { type: 'link' }>; landing: Pt } | null = null
    for (let i = 0; i < res.passes.length && !descent; i++) {
      const p = res.passes[i]
      if (p.type === 'link' && p.jumpType === 2 && p.helixDescent && res.passes[i + 1]?.type !== 'entry') {
        descent = { link: p, landing: p.points[1] }
      }
    }
    expect(descent, 'no helix-descent link on Bar -- nothing to render').not.toBeNull()
    const hd = descent!.link.helixDescent!

    // Emit (single depth level) and pull the descent's helix spiral + lead moves.
    const ctx: EmitContext = {
      heights: { clearanceZ: 15, retractZ: 5, feedZ: 1, topZ: 0, bottomZ: -2 },
      feeds: { feedRate: 1000, plungeRate: 300, rampRate: 450, leadInRate: 1000, leadOutRate: 1000, fastTraverseRate: 5000, finishRate: 1000 },
      stepdown: 5,
      helixAngleDeg: 3,
    }
    const moves = emitFeature(res, ctx)
    const nearC = (m: { x: number; y: number }) => Math.hypot(m.x - hd.center.x, m.y - hd.center.y) <= hd.radius + 0.05
    const helixPts: Pt[] = []
    const leadPts: Pt[] = []
    for (let i = 0; i < moves.length; i++) {
      const m = moves[i]
      if (m.role === 'helix' && nearC(m)) {
        helixPts.push({ x: m.x, y: m.y })
        if (moves[i + 1]?.role === 'lead_in') { leadPts.push({ x: m.x, y: m.y }, { x: moves[i + 1].x, y: moves[i + 1].y }) }
      }
    }
    expect(helixPts.length).toBeGreaterThan(2)

    // ---- two panels: full fixture (left) + 30x30mm zoom on the transition (right) ----
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const p of boundary) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y) }
    const pad = 6
    const FULL_W = 1100
    const S1 = FULL_W / (maxX - minX + 2 * pad)
    const H = Math.ceil((maxY - minY + 2 * pad) * S1)
    const ZOOM = 30 // mm window
    const S2 = H / ZOOM
    const ZOOM_W = H
    const GAP = 8
    const W = FULL_W + GAP + ZOOM_W
    const fb = new FB(W, H, [17, 17, 17])
    for (let y = 0; y < H; y++) for (let x = FULL_W; x < FULL_W + GAP; x++) fb.px(x, y, [60, 60, 60])

    const zc = { x: hd.center.x, y: hd.center.y } // zoom centre
    const T1 = (p: Pt): [number, number] => [(p.x - minX + pad) * S1, (maxY - p.y + pad) * S1]
    const T2 = (p: Pt): [number, number] => [FULL_W + GAP + (p.x - (zc.x - ZOOM / 2)) * S2, ((zc.y + ZOOM / 2) - p.y) * S2]

    for (const T of [T1, T2]) {
      const inZoom = T === T2
      // Segment-level reject only when BOTH endpoints sit on the SAME outside side of the
      // zoom window (a long wall segment CROSSING the window must still draw).
      const lim = ZOOM * 0.75
      const segOk = (p: Pt, q: Pt) => !inZoom || !(
        (p.x - zc.x < -lim && q.x - zc.x < -lim) || (p.x - zc.x > lim && q.x - zc.x > lim) ||
        (p.y - zc.y < -lim && q.y - zc.y < -lim) || (p.y - zc.y > lim && q.y - zc.y > lim))
      const drawLoop = (loop: Pt[], c: [number, number, number], close: boolean, r = 0) => {
        for (let i = 1; i < loop.length; i++) {
          if (!segOk(loop[i - 1], loop[i])) continue
          const a = T(loop[i - 1]), b = T(loop[i]); fb.line(a[0], a[1], b[0], b[1], c, r)
        }
        if (close && loop.length > 2 && segOk(loop[loop.length - 1], loop[0])) {
          const a = T(loop[loop.length - 1]), b = T(loop[0]); fb.line(a[0], a[1], b[0], b[1], c, r)
        }
      }
      drawLoop(boundary, [150, 150, 150], true)
      for (const h of holes) drawLoop(h, [190, 130, 130], true)
      for (const p of res.passes) if (p.type === 'cut') drawLoop(p.points, [50, 80, 120], false)
      for (const p of res.passes) if (p.type === 'wallfollow') drawLoop(p.points, [0, 120, 95], false)
      for (const p of res.passes) if (p.type === 'link' && (p as { jumpType?: number }).jumpType === 2) drawLoop((p as { points: Pt[] }).points, [90, 90, 90], false)
      // the disk the helix opens (radius + toolR): dim ring
      const ring: Pt[] = []
      for (let a = 0; a <= 360; a += 3) ring.push({ x: hd.center.x + (hd.radius + TOOLR) * Math.cos(a * Math.PI / 180), y: hd.center.y + (hd.radius + TOOLR) * Math.sin(a * Math.PI / 180) })
      drawLoop(ring, [120, 90, 40], false)
      // the emitted helix descent spiral (orange) + at-depth lead to the pass start (yellow)
      drawLoop(helixPts, [255, 150, 30], false, inZoom ? 1 : 0)
      if (leadPts.length >= 2) drawLoop(leadPts, [250, 230, 60], false, inZoom ? 1 : 0)
      // planned helix centre (orange cross) + landing / pass start (white dot)
      const cc = T(hd.center)
      fb.line(cc[0] - 6, cc[1], cc[0] + 6, cc[1], [255, 150, 30]); fb.line(cc[0], cc[1] - 6, cc[0], cc[1] + 6, [255, 150, 30])
      const ld = T(descent!.landing); fb.dot(ld[0], ld[1], [255, 255, 255], inZoom ? 4 : 3)
    }

    fs.mkdirSync('docs/planning', { recursive: true })
    const OUT = 'docs/planning/helix_reentry_bar.png'
    fs.writeFileSync(OUT, fb.png())
    console.log(`wrote ${OUT} (left: full Bar; right: 30mm zoom on the first transition -- orange spiral = helix descent r=${hd.radius.toFixed(2)} at (${hd.center.x.toFixed(2)}, ${hd.center.y.toFixed(2)}), yellow = at-depth lead, white = landing/pass start)`)
  }, 600_000)
})
