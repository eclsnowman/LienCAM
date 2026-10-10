// B8 SLOT-THROUGH-UNCUT PROBE (diagnostic scratch test, underscore = not part of the gate).
//
// Reproduces bug B8 (docs/planning/POST-MERGE-WORKPLAN.md): with integral wall-follow ON,
// a stay-down reposition (wallfollow / loopback / keep-down link) can cross UNCLEARED
// material at full depth -- a full-width slot, violating rule R1 (material safety).
//
// Method: run the REAL engine (processFeature) on a 120x120 square pocket with a round
// island (user's B8 fixture scale), then REPLAY the ordered pass stream maintaining a
// physical cleared-so-far accumulator (entry disks + cut/finish corridors + the material
// each measured move itself removes, incrementally). For every wallfollow, loopback, and
// keep-down link, measure at the moment it executes:
//   - lenOverUncut: path length whose incremental swept area per distance > 0.1mm width
//   - maxW: max incremental swept-area-per-distance (mm of effective cut width).
//     Full slot = 2*toolR; acceptable engagement ~ stepover distance.
//
// Renders review-images/b8_slot_repro.png (gitignored diagnostic dir, not a golden):
// toolpath + cleared/uncut state AT THE MOMENT of the worst offender, offenders in bright red.
//
// Run:  npx vitest run src/tests/adaptive-clearing/engine/_b8-slot-probe.test.ts
// Env:  TOL=0.02 (default 0.1)  SIZE=120  ISLR=20  TOOLR=3  STEPOVER=0.25

import { describe, it, beforeAll } from 'vitest'
import * as fs from 'fs'
import * as zlib from 'zlib'
import {
  ensureEngineClipperReady, diskPath, capsulePath, offsetOpenRound, offsetClosed,
  union, difference, totalArea, type Loop, type Loops, type Pt,
} from '../../../lib/cam/adaptiveClearing2d/engine/clipperEngine'
import { processFeature, type AdaptivePass, type ProcessParams } from '../../../lib/cam/adaptiveClearing2d/engine/processFeature'

// ---------------------------------------------------------------- fixture
const SIZE = Number(process.env.SIZE ?? 120)
const ISLR = Number(process.env.ISLR ?? 20)       // island radius (40mm dia)
const TOOLR = Number(process.env.TOOLR ?? 3)      // 6mm tool
const STEPOVER = Number(process.env.STEPOVER ?? 0.25) // optimal load 25%
const TOL = Number(process.env.TOL ?? 0.1)

function circle(cx: number, cy: number, r: number, n = 180): Loop {
  const p: Loop = []
  for (let i = 0; i < n; i++) { const a = 2 * Math.PI * i / n; p.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }) }
  return p
}
const square: Loop = [{ x: 0, y: 0 }, { x: SIZE, y: 0 }, { x: SIZE, y: SIZE }, { x: 0, y: SIZE }]
const island = circle(SIZE / 2, SIZE / 2, ISLR)

// ---------------------------------------------------------------- helpers
const dist = (a: Pt, b: Pt) => Math.hypot(b.x - a.x, b.y - a.y)
function polyLen(pts: Pt[]): number { let l = 0; for (let i = 1; i < pts.length; i++) l += dist(pts[i - 1], pts[i]); return l }

/** Resample a polyline at <= ds spacing, keeping original vertices. */
function resample(pts: Pt[], ds: number): Pt[] {
  const out: Pt[] = [pts[0]]
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i]
    const L = dist(a, b)
    const n = Math.max(1, Math.ceil(L / ds))
    for (let k = 1; k <= n; k++) out.push({ x: a.x + (b.x - a.x) * k / n, y: a.y + (b.y - a.y) * k / n })
  }
  return out
}

interface MoveReport {
  passIdx: number
  kind: string            // wallfollow | loopback | link-keepdown
  len: number             // mm
  lenOverUncut: number    // mm of path with effective width > 0.1mm
  maxW: number            // mm max incremental swept width
  avgW: number            // mm mean swept width over the whole move
  clearedSnapshot?: Loops // cleared state at the MOMENT this move executed (worst offender only, filled later)
  points: Pt[]
}

// ---------------------------------------------------------------- PNG (pure JS, copied pattern from _visual-dump.test.ts)
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

// ---------------------------------------------------------------- probe
describe('B8 slot-through-uncut probe (island fixture, user settings)', () => {
  beforeAll(async () => { await ensureEngineClipperReady() })

  it('measures every stay-down move against the cleared-so-far state', () => {
    const params: ProcessParams = {
      toolRadius: TOOLR,
      stepOver: STEPOVER,
      tolerance: TOL,
      helixDiameter: TOOLR * 2 * 0.9, // helix entry 90% of tool dia
      stockToLeave: 0,
      integralWallFollow: true,       // the B8 feature, ON
      wallCleanupAsWeGo: true,        // user setting: wall cleanup as we go ON
      loopbackFilletPct: 25,
      wallFinish: true,               // final wall cleanup ON (final depth; 2D stream order only)
    }
    const stepoverDist = 2 * TOOLR * STEPOVER

    const t0 = Date.now()
    const res = processFeature({ boundary: square, holes: [island] }, params)
    console.log(`engine: ${Date.now() - t0}ms passes=${res.passes.length} aborted=${res.stats.aborted ?? 'no'} ` +
      `wallfollows=${res.passes.filter(p => p.type === 'wallfollow').length} ` +
      `loopbacks=${res.passes.filter(p => p.type === 'loopback').length} ` +
      `keepLinks=${res.passes.filter(p => p.type === 'link' && (p as any).jumpType === 1).length} ` +
      `lifts=${res.passes.filter(p => p.type === 'link' && (p as any).jumpType === 2).length}`)

    // ---- replay the pass stream with a PHYSICAL cleared accumulator ----
    const arcTol = 0.05
    let cleared: Loops = []
    const reports: MoveReport[] = []
    const ds = 0.75 // mm sampling

    const measureAndStamp = (passIdx: number, kind: string, rawPts: Pt[]): void => {
      const pts = resample(rawPts, ds)
      const len = polyLen(pts)
      let lenOver = 0, maxW = 0, freshTotal = 0
      let clearedLocal = cleared
      let snapshot: Loops | null = null
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i]
        const L = dist(a, b)
        if (L < 1e-9) continue
        const cap = capsulePath(a, b, TOOLR, arcTol)
        const fresh = difference(cap, clearedLocal)
        const aArea = totalArea(fresh)
        const w = aArea / L
        if (w > 0.1) lenOver += L
        if (w > maxW) { maxW = w; if (!snapshot) snapshot = clearedLocal }
        freshTotal += aArea
        clearedLocal = union(clearedLocal, cap)
      }
      reports.push({
        passIdx, kind, len, lenOverUncut: lenOver, maxW, avgW: len > 0 ? freshTotal / len : 0,
        clearedSnapshot: cleared, // state when the move STARTED (good enough for the render)
        points: rawPts,
      })
      cleared = clearedLocal // the tool physically removed this material (or crashed trying)
    }

    for (let i = 0; i < res.passes.length; i++) {
      const pass = res.passes[i]
      if (pass.type === 'entry') {
        cleared = union(cleared, diskPath(pass.point, pass.radius + TOOLR, arcTol))
      } else if (pass.type === 'cut' || pass.type === 'finish') {
        if (pass.points.length >= 2) cleared = union(cleared, offsetOpenRound(pass.points, TOOLR, arcTol))
      } else if (pass.type === 'wallfollow') {
        measureAndStamp(i, 'wallfollow', pass.points)
      } else if (pass.type === 'loopback') {
        measureAndStamp(i, 'loopback', pass.points)
      } else if (pass.type === 'link') {
        const link = pass as Extract<AdaptivePass, { type: 'link' }>
        if (link.jumpType === 1) measureAndStamp(i, 'link-keepdown', link.points)
        // jumpType 2 = retract-reposition-plunge: exempt by design (R1 allows it)
      }
    }

    // ---- offender table ----
    // wallfollow is a CUTTING move but its load must stay near stepover; loopback and
    // keep-down links are NON-cutting (fast_traverse) -- ANY uncut crossing is a violation.
    const offenders = reports.filter(r =>
      (r.kind === 'wallfollow' && r.maxW > stepoverDist * 1.25) ||
      (r.kind !== 'wallfollow' && r.lenOverUncut > 0.5))
    offenders.sort((a, b) => b.maxW - a.maxW)

    const fmt = (n: number) => n.toFixed(2).padStart(8)
    console.log(`\nstepoverDist=${stepoverDist.toFixed(2)}mm  fullSlot=${(2 * TOOLR).toFixed(2)}mm  measured stay-down moves=${reports.length}`)
    console.log('OFFENDERS (maxW = max effective cut width mm; full slot = ' + (2 * TOOLR).toFixed(1) + 'mm):')
    console.log('passIdx     kind          len  lenOverUncut    maxW    avgW')
    for (const r of offenders) {
      console.log(`${String(r.passIdx).padStart(7)} ${r.kind.padStart(13)} ${fmt(r.len)} ${fmt(r.lenOverUncut).padStart(13)} ${fmt(r.maxW)} ${fmt(r.avgW)}`)
    }
    if (offenders.length === 0) console.log('  (none -- no slotting reproduced at these settings)')

    // also print the 10 worst stay-downs regardless of threshold, for context
    const worst = [...reports].sort((a, b) => b.maxW - a.maxW).slice(0, 10)
    console.log('\nTOP-10 stay-down moves by maxW (context):')
    console.log('passIdx     kind          len  lenOverUncut    maxW    avgW')
    for (const r of worst) {
      console.log(`${String(r.passIdx).padStart(7)} ${r.kind.padStart(13)} ${fmt(r.len)} ${fmt(r.lenOverUncut).padStart(13)} ${fmt(r.maxW)} ${fmt(r.avgW)}`)
    }

    // ---- render PNG: state at the moment of the worst offender ----
    const worstOff = offenders[0] ?? worst[0]
    const clearedAtMoment = worstOff?.clearedSnapshot ?? cleared
    const finishStock = params.tolerance / 2 + (params.stockToLeave ?? 0)
    const targetRaw = offsetClosed([square], -finishStock, arcTol)
    const islGrown = offsetClosed([island], finishStock, arcTol)
    const target = difference(targetRaw, islGrown)
    const uncutAtMoment = difference(target, clearedAtMoment)

    const pad = 4, S = Math.min(1400 / (SIZE + 2 * pad), 1400 / (SIZE + 2 * pad))
    const W = Math.ceil((SIZE + 2 * pad) * S), H = Math.ceil((SIZE + 2 * pad) * S)
    const T = (p: Pt): [number, number] => [(p.x + pad) * S, ((SIZE - p.y) + pad) * S]
    const fb = new FB(W, H, [17, 17, 17])
    const drawLoop = (loop: Pt[], c: [number, number, number], close: boolean, r = 0) => {
      for (let i = 1; i < loop.length; i++) { const a = T(loop[i - 1]), b = T(loop[i]); fb.line(a[0], a[1], b[0], b[1], c, r) }
      if (close && loop.length > 2) { const a = T(loop[loop.length - 1]), b = T(loop[0]); fb.line(a[0], a[1], b[0], b[1], c, r) }
    }
    // uncut-at-moment shaded by scanline fill (even-odd over its loops)
    const fillLoops = (loops: Loops, c: [number, number, number]) => {
      for (let py = 0; py < H; py++) {
        const wy = SIZE - (py / S - pad)
        const xs: number[] = []
        for (const loop of loops) {
          const n = loop.length
          for (let i = 0; i < n; i++) {
            const a = loop[i], b = loop[(i + 1) % n]
            if ((a.y > wy) !== (b.y > wy)) xs.push(a.x + (b.x - a.x) * (wy - a.y) / (b.y - a.y))
          }
        }
        xs.sort((p, q) => p - q)
        for (let k = 0; k + 1 < xs.length; k += 2) {
          const x0 = Math.max(0, Math.round((xs[k] + pad) * S)), x1 = Math.min(W - 1, Math.round((xs[k + 1] + pad) * S))
          for (let px = x0; px <= x1; px++) fb.px(px, py, c)
        }
      }
    }
    fillLoops(uncutAtMoment, [70, 35, 35])               // uncut stock at the moment = dark red fill
    for (const loop of clearedAtMoment) drawLoop(loop, [40, 70, 100], true) // cleared outline dim blue
    drawLoop(square, [150, 150, 150], true)
    drawLoop(island, [190, 130, 130], true)
    for (const loop of res.cutRegion) drawLoop(loop, [80, 80, 80], true)
    for (const p of res.passes) if (p.type === 'cut') drawLoop(p.points, [60, 110, 170], false)
    for (const p of res.passes) if (p.type === 'wallfollow') drawLoop(p.points, [0, 190, 150], false)
    for (const p of res.passes) if (p.type === 'loopback') drawLoop(p.points, [220, 160, 0], false)
    for (const p of res.passes) if (p.type === 'link') drawLoop((p as any).points, (p as any).jumpType === 2 ? [120, 40, 45] : [40, 160, 40], false)
    // offenders in BRIGHT RED, thick; worst gets endpoint dots
    for (const r of offenders) drawLoop(r.points, [255, 30, 30], false, 2)
    if (worstOff) {
      const s = T(worstOff.points[0]); fb.dot(s[0], s[1], [255, 255, 0], 4)
      const e = T(worstOff.points[worstOff.points.length - 1]); fb.dot(e[0], e[1], [255, 0, 255], 4)
    }
    // Diagnostic render only (not a golden compare) -- write to the gitignored
    // review-images/ dir (see _visual-dump.test.ts etc.), never the tracked
    // docs/planning/ copy, so full-suite runs stop binary-churning it.
    fs.mkdirSync('review-images', { recursive: true })
    const OUT = 'review-images/b8_slot_repro.png'
    fs.writeFileSync(OUT, fb.png())
    console.log(`\nwrote ${OUT} ${W}x${H} (worst offender passIdx=${worstOff?.passIdx ?? 'n/a'} maxW=${worstOff?.maxW.toFixed(2) ?? 'n/a'}mm)`)
    console.log('legend: dark-red fill = uncut stock at the moment of the worst offender; bright red = offending stay-down moves;')
    console.log('        teal = wallfollow, amber = loopback, green = keep-down link, dark-red lines = lifts, blue = cuts')
  }, 600_000)
})
