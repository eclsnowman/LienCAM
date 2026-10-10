// B8 ROUTE-AROUND before/after RENDER (Stage 2 visual gate, diagnostic; underscore = not CI).
//
// Renders the 120x120 + r20 island repro toolpath so Operator can SEE the change stage 2 makes:
// stay-down repositions the B8 gate used to reject (conceding a full retract) are now RE-
// ROUTED along the OTHER boundary arc (the far side of the island) and kept down. Colour-
// codes lifts (bright red) vs kept-down wall rides (teal) vs cuts (blue), same legend as
// _b8-slot-probe. Fewer red lifts + the far-side teal wraps = the intended win.
//
// The SAME file renders BEFORE (run at the stage-1 engine) and AFTER (run at the stage-2
// engine); the output path is taken from B8_RENDER_OUT.
//
// Run:  B8_RENDER_OUT=coordination/evidence/B8-STAYDOWN/island_before.png \
//         npx vitest run src/tests/adaptive-clearing/engine/_b8-routearound-render.test.ts

import { describe, it, beforeAll } from 'vitest'
import * as fs from 'fs'
import * as zlib from 'zlib'
import {
  ensureEngineClipperReady, offsetClosed, difference,
  type Loop, type Loops, type Pt,
} from '../../../lib/cam/adaptiveClearing2d/engine/clipperEngine'
import { processFeature, getB8GateStats, type AdaptivePass, type ProcessParams } from '../../../lib/cam/adaptiveClearing2d/engine/processFeature'

const OUT = process.env.B8_RENDER_OUT ?? 'coordination/evidence/B8-STAYDOWN/island_render.png'
// B8_RENDER_FIXTURE = 'island' (default, the 120x120+r20 staydown repro), 'squareisland' (gt fix2,
// canonical byte-stability settings -- the vivid 16->1 lifts case), or 'twoisland' (gt_two_island,
// the stage-3 through-cleared-chord demonstrator -- the diagonal shortcut between two offset islands).
const FIXTURE = process.env.B8_RENDER_FIXTURE ?? 'island'

function circle(cx: number, cy: number, r: number, n = 180): Loop {
  const p: Loop = []
  for (let i = 0; i < n; i++) { const a = 2 * Math.PI * i / n; p.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }) }
  return p
}

/** Load the gt fixture geometry + helix diameter (mirrors _bytestab-fingerprint). */
function loadGtFixture(fix: number): { boundary: Loop; holes: Loop[]; helixDiameter: number } {
  return loadGtFixture2(`gt_fix${fix}.json`)
}
/** Load a gt-family fixture by filename (for named fixtures like gt_two_island.json). */
function loadGtFixture2(file: string): { boundary: Loop; holes: Loop[]; helixDiameter: number } {
  const d = JSON.parse(fs.readFileSync(`test_fixtures/adaptive-clearing/spirals/_cmp/_gt/${file}`, 'utf8'))
  return {
    boundary: (d.boundary as number[][]).map(([x, y]: number[]) => ({ x, y })),
    holes: (d.islands ?? []).map((isl: number[][]) => isl.map(([x, y]: number[]) => ({ x, y }))),
    helixDiameter: d.helix?.diameter ?? 3,
  }
}

/** Resolve the fixture geometry + params + a render viewport for the selected fixture. Both
 *  cases use EXACTLY the settings their measurement/byte-stability run uses. */
function resolveFixture(): { boundary: Loop; holes: Loop[]; params: ProcessParams; viewport: { minX: number; minY: number; span: number } } {
  if (FIXTURE === 'squareisland') {
    const { boundary, holes, helixDiameter } = loadGtFixture(2) // SquareIsland, canonical settings
    const params: ProcessParams = {
      toolRadius: 2.0, stepOver: 0.2, tolerance: 0.1, helixDiameter, stockToLeave: 0.5,
      integralWallFollow: true, wallCleanupAsWeGo: true, loopbackFilletPct: 25,
    }
    const xs = [...boundary, ...holes.flat()].map(p => p.x), ys = [...boundary, ...holes.flat()].map(p => p.y)
    const minX = Math.min(...xs), minY = Math.min(...ys)
    const span = Math.max(Math.max(...xs) - minX, Math.max(...ys) - minY)
    return { boundary, holes, params, viewport: { minX, minY, span } }
  }
  if (FIXTURE === 'twoisland') {
    const { boundary, holes, helixDiameter } = loadGtFixture2('gt_two_island.json') // stage-3 chord demonstrator
    const params: ProcessParams = {
      toolRadius: 3, stepOver: 0.25, tolerance: 0.1, helixDiameter, stockToLeave: 0,
      integralWallFollow: true, wallCleanupAsWeGo: true, loopbackFilletPct: 25, wallFinish: true,
    }
    const xs = [...boundary, ...holes.flat()].map(p => p.x), ys = [...boundary, ...holes.flat()].map(p => p.y)
    const minX = Math.min(...xs), minY = Math.min(...ys)
    const span = Math.max(Math.max(...xs) - minX, Math.max(...ys) - minY)
    return { boundary, holes, params, viewport: { minX, minY, span } }
  }
  // default: the 120x120 + r20 island repro (staydown-engagement settings)
  const SIZE = 120, ISLR = 20, TOOLR = 3
  const boundary: Loop = [{ x: 0, y: 0 }, { x: SIZE, y: 0 }, { x: SIZE, y: SIZE }, { x: 0, y: SIZE }]
  const holes = [circle(SIZE / 2, SIZE / 2, ISLR)]
  const params: ProcessParams = {
    toolRadius: TOOLR, stepOver: 0.25, tolerance: 0.1, helixDiameter: TOOLR * 2 * 0.9,
    stockToLeave: 0, integralWallFollow: true, wallCleanupAsWeGo: true, loopbackFilletPct: 25, wallFinish: true,
  }
  return { boundary, holes, params, viewport: { minX: 0, minY: 0, span: SIZE } }
}

// ---- minimal PNG framebuffer (copied from _b8-slot-probe.test.ts) ----
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

describe('B8 route-around render (lifts vs kept-down wall rides)', () => {
  beforeAll(async () => { await ensureEngineClipperReady() })

  it(`renders the ${FIXTURE} toolpath`, () => {
    const { boundary, holes, params, viewport } = resolveFixture()
    const warn = console.warn; console.warn = () => {}
    let res
    try { res = processFeature({ boundary, holes }, params) } finally { console.warn = warn }

    const lifts = res.passes.filter(p => p.type === 'link' && p.jumpType === 2).length
    const wallfollows = res.passes.filter(p => p.type === 'wallfollow').length
    const g = getB8GateStats()
    console.log(`\nB8 render [${FIXTURE}] ${OUT}: lifts=${lifts} wallfollows=${wallfollows} b8Rejections=${g.rejections} routedAround=${g.routedAround}`)

    // ---- render (viewport auto-fit to the fixture bounds) ----
    const arcTol = 0.05
    const pad = 4, S = 1400 / (viewport.span + 2 * pad)
    const W = Math.ceil((viewport.span + 2 * pad) * S), H = Math.ceil((viewport.span + 2 * pad) * S)
    const T = (p: Pt): [number, number] => [(p.x - viewport.minX + pad) * S, ((viewport.span - (p.y - viewport.minY)) + pad) * S]
    const fb = new FB(W, H, [17, 17, 17])
    const drawLoop = (loop: Pt[], c: [number, number, number], close: boolean, r = 0) => {
      for (let i = 1; i < loop.length; i++) { const a = T(loop[i - 1]), b = T(loop[i]); fb.line(a[0], a[1], b[0], b[1], c, r) }
      if (close && loop.length > 2) { const a = T(loop[loop.length - 1]), b = T(loop[0]); fb.line(a[0], a[1], b[0], b[1], c, r) }
    }
    const finishStock = params.tolerance / 2 + (params.stockToLeave ?? 0)
    const target: Loops = difference(offsetClosed([boundary], -finishStock, arcTol), offsetClosed(holes, finishStock, arcTol))
    for (const loop of target) drawLoop(loop, [45, 45, 45], true)
    drawLoop(boundary, [150, 150, 150], true)
    for (const h of holes) drawLoop(h, [190, 130, 130], true)
    for (const loop of res.cutRegion) drawLoop(loop, [80, 80, 80], true)
    for (const p of res.passes) if (p.type === 'cut') drawLoop(p.points, [55, 95, 150], false)
    for (const p of res.passes) if (p.type === 'wallfollow') drawLoop(p.points, [0, 200, 155], false)
    for (const p of res.passes) if (p.type === 'loopback') drawLoop(p.points, [220, 160, 0], false)
    // lifts LAST, bright red + thick, so the up-down-up pecks are unmissable
    for (const p of res.passes) if (p.type === 'link' && (p as Extract<AdaptivePass, { type: 'link' }>).jumpType === 2) drawLoop((p as Extract<AdaptivePass, { type: 'link' }>).points, [255, 40, 40], false, 2)
    for (const p of res.passes) if (p.type === 'link' && (p as Extract<AdaptivePass, { type: 'link' }>).jumpType === 1) drawLoop((p as Extract<AdaptivePass, { type: 'link' }>).points, [40, 160, 40], false)

    fs.mkdirSync(OUT.replace(/[/\\][^/\\]*$/, ''), { recursive: true })
    fs.writeFileSync(OUT, fb.png())
    console.log(`wrote ${OUT} ${W}x${H}  (legend: teal=wall ride kept down, bright red=lift/retract, blue=cut, amber=loopback, green=keep-down link)`)
  }, 300_000)
})
