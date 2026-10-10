// LIFT RE-ENTRY MATERIAL-STATE PROBE (diagnostic scratch test, underscore = not a gate).
//
// QUESTION (CNC machinist): after a jumpType-2 lift, the emitted re-entry is a STRAIGHT
// VERTICAL PLUNGE at plungeRate (emit.ts emitLink, jumpType 2 branch). Does that plunge
// land in already-cleared material (safe: descending through air / a cleared floor) or in
// UNCUT stock (overload: a center-cutting full/partial-width plunge)?
//
// Method: same physical replay as _b8-slot-probe / staydown-engagement -- run the REAL
// engine (processFeature, WITH the uncommitted B8 engagement gate active), replay the
// ordered pass stream against a cleared-so-far accumulator, and for every jumpType-2 link
// that emit would actually emit (links immediately before an `entry` are SKIPPED by
// emit.ts:86-88 -- the entry owns its own approach), measure AT THAT MOMENT:
//   - reentry XY        = link.points[1]  (emitLink plunges at b)
//   - uncutFraction     = area(toolDisk(reentry) - cleared) / area(toolDisk)
//                         0.0 = plunge lands fully over cleared floor; 1.0 = full-width
//                         center plunge into solid stock
//   - distToClearedEdge = distance from reentry XY to the nearest cleared-region boundary,
//                         NEGATIVE when the re-entry point itself is inside cleared
// Region-seed entries (helix/plunge passes) are tallied separately for context: a `plunge`
// mode entry is BY DESIGN a straight plunge into solid uncut (where no helix fits).
//
// Fixtures:
//   1. island repro: 120x120 pocket, r=20 island, 6mm tool, stepover 1.5mm (25%), the B8
//      settings (integralWallFollow + wallCleanupAsWeGo + wallFinish ON) -- full per-lift table.
//   2. the 4 B8-changed engine fixtures fix2 SquareIsland / fix4 Bar / fix5 BootL /
//      fix7 Barbell (gt_fix*.json, tool R2, 20% stepover, stockToLeave 0.5, same flags as
//      loopback-fillet.test.ts) -- totals + worst case.
//
// Render: review-images/lift_reentry_island.png (gitignored diagnostic dir, not a golden;
// island fixture; re-entry dots colored by uncut fraction: green < 5%, yellow 5-25%, red > 25%).
//
// Run (opt-in, WO-408 - a probe never runs in the default slice):
//   LIFT_REENTRY_PROBE=1 npx vitest run src/tests/adaptive-clearing/engine/_lift-reentry-probe.test.ts

import { describe, it, beforeAll } from 'vitest'
import * as fs from 'fs'
import * as zlib from 'zlib'
import {
  ensureEngineClipperReady, diskPath, offsetOpenRound,
  union, difference, netArea, type Loop, type Loops, type Pt,
} from '../../../lib/cam/adaptiveClearing2d/engine/clipperEngine'
import { closestPointOnPaths } from '../../../lib/cam/adaptiveClearing2d/engine/geom'
import { processFeature, type AdaptivePass, type ProcessParams } from '../../../lib/cam/adaptiveClearing2d/engine/processFeature'

const ARCTOL = 0.05

// ---------------------------------------------------------------- helpers
function pointInLoops(p: Pt, loops: Loops): boolean {
  // even-odd over ALL loops (cleared output: outers + holes mixed; even-odd is correct)
  let inside = false
  for (const loop of loops) {
    const n = loop.length
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const a = loop[i], b = loop[j]
      if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside
    }
  }
  return inside
}

interface LiftReport {
  liftIdx: number
  passIdx: number
  from: Pt
  to: Pt
  uncutFrac: number   // 0..1 of the tool disk over uncut stock at the moment of the plunge
  uncutArea: number   // mm^2
  signedDist: number  // mm to nearest cleared edge; negative = re-entry point inside cleared
  prevType: string    // pass type immediately before the lift (context: who set connStart)
  nextType: string    // pass type immediately after (wallfollow = cusp entry ride owns the landing)
}

interface RunReport {
  name: string
  lifts: LiftReport[]
  entryHelix: number
  entryPlunge: number
  passes: number
}

/** Replay the ordered pass stream with a physical cleared accumulator and measure every
 *  EMITTED jumpType-2 lift's landing-disk material state at the moment it executes. */
function replayAndMeasure(name: string, res: { passes: AdaptivePass[] }, toolR: number): RunReport {
  const diskArea = Math.PI * toolR * toolR
  let cleared: Loops = []
  const lifts: LiftReport[] = []
  let entryHelix = 0, entryPlunge = 0

  const passes = res.passes
  for (let i = 0; i < passes.length; i++) {
    const pass = passes[i]
    if (pass.type === 'entry') {
      if (pass.mode === 'helix') entryHelix++; else entryPlunge++
      cleared = union(cleared, diskPath(pass.point, pass.radius + toolR, ARCTOL))
    } else if (pass.type === 'cut' || pass.type === 'finish') {
      if (pass.points.length >= 2) cleared = union(cleared, offsetOpenRound(pass.points, toolR, ARCTOL))
    } else if (pass.type === 'wallfollow' || pass.type === 'loopback') {
      if (pass.points.length >= 2) cleared = union(cleared, offsetOpenRound(pass.points, toolR, ARCTOL))
    } else if (pass.type === 'link') {
      const link = pass as Extract<AdaptivePass, { type: 'link' }>
      if (link.jumpType === 1) {
        // keep-down traverse at depth: its sweep is physically removed
        cleared = union(cleared, offsetOpenRound(link.points, toolR, ARCTOL))
      } else {
        // jumpType 2 LIFT. emit.ts skips a link immediately before an `entry` (the entry
        // owns the safe approach) -- mirror that so we measure only EMITTED plunges.
        const next = passes[i + 1]
        if (next && next.type === 'entry') continue
        const to = link.points[1]
        const disk = diskPath(to, toolR, ARCTOL)
        const uncut = Math.max(0, netArea(difference(disk, cleared)))
        const { dist } = closestPointOnPaths(cleared, to)
        const inside = pointInLoops(to, cleared)
        lifts.push({
          liftIdx: lifts.length, passIdx: i,
          from: link.points[0], to,
          uncutFrac: uncut / diskArea, uncutArea: uncut,
          signedDist: inside ? -dist : dist,
          prevType: passes[i - 1]?.type ?? '-', nextType: next?.type ?? '-',
        })
        // the lift removes nothing
      }
    }
  }
  return { name, lifts, entryHelix, entryPlunge, passes: passes.length }
}

function printTable(rep: RunReport, toolR: number): void {
  const f = (n: number, w = 8) => n.toFixed(2).padStart(w)
  console.log(`\n=== ${rep.name}: ${rep.lifts.length} emitted lift re-entries ` +
    `(passes=${rep.passes}, entries: helix=${rep.entryHelix} plunge=${rep.entryPlunge}, toolR=${toolR}mm) ===`)
  console.log('liftIdx passIdx   reentryX  reentryY  uncutFrac  uncutArea(mm2)  distToClearedEdge(mm; neg=inside cleared)  prev->next')
  for (const l of rep.lifts) {
    console.log(`${String(l.liftIdx).padStart(7)} ${String(l.passIdx).padStart(7)} ${f(l.to.x, 10)} ${f(l.to.y, 9)} ` +
      `${l.uncutFrac.toFixed(3).padStart(10)} ${f(l.uncutArea, 15)} ${f(l.signedDist, 12)}  ${l.prevType}->${l.nextType}`)
  }
  const over25 = rep.lifts.filter(l => l.uncutFrac > 0.25)
  const worst = rep.lifts.reduce<LiftReport | null>((w, l) => (!w || l.uncutFrac > w.uncutFrac ? l : w), null)
  console.log(`summary: lifts=${rep.lifts.length}  >25% uncut=${over25.length}  ` +
    `worst=${worst ? `${(worst.uncutFrac * 100).toFixed(1)}% at (${worst.to.x.toFixed(2)}, ${worst.to.y.toFixed(2)})` : 'n/a'}`)
}

// ---------------------------------------------------------------- PNG (pattern from _b8-slot-probe)
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

// ---------------------------------------------------------------- fixtures
function circle(cx: number, cy: number, r: number, n = 180): Loop {
  const p: Loop = []
  for (let i = 0; i < n; i++) { const a = 2 * Math.PI * i / n; p.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }) }
  return p
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

// ---------------------------------------------------------------- probe
describe.skipIf(!process.env.LIFT_REENTRY_PROBE)('lift re-entry material-state probe', () => {
  beforeAll(async () => { await ensureEngineClipperReady() })

  it('island repro (B8 settings): per-lift re-entry table', () => {
    const SIZE = 120, ISLR = 20, TOOLR = 3
    const square: Loop = [{ x: 0, y: 0 }, { x: SIZE, y: 0 }, { x: SIZE, y: SIZE }, { x: 0, y: SIZE }]
    const island = circle(SIZE / 2, SIZE / 2, ISLR)
    const params: ProcessParams = {
      toolRadius: TOOLR, stepOver: 0.25, tolerance: 0.1,
      helixDiameter: TOOLR * 2 * 0.9, stockToLeave: 0,
      integralWallFollow: true, wallCleanupAsWeGo: true, loopbackFilletPct: 25, wallFinish: true,
    }
    const t0 = Date.now()
    const res = processFeature({ boundary: square, holes: [island] }, params)
    console.log(`engine: ${Date.now() - t0}ms passes=${res.passes.length} aborted=${res.stats.aborted ?? 'no'}`)

    const rep = replayAndMeasure('island 120x120 r20, tool 6mm, stepover 1.5mm', res, TOOLR)
    printTable(rep, TOOLR)

    // bound context: the walker's engage-band cap for these settings
    const stepoverDist = 2 * TOOLR * 0.25
    const moveDistance = stepoverDist / 4 + 0.1
    const maxBite = 1.5 * stepoverDist * moveDistance // optimal = stepover * 2r = stepoverDist mm^2/mm
    console.log(`walker maxBite bound = ${maxBite.toFixed(2)}mm2 = ${(maxBite / (Math.PI * TOOLR * TOOLR) * 100).toFixed(1)}% of the tool disk`)

    // ---- render: re-entry dots over the toolpath, colored by uncut fraction ----
    const pad = 4, S = 1400 / (SIZE + 2 * pad)
    const W = Math.ceil((SIZE + 2 * pad) * S), H = W
    const T = (p: Pt): [number, number] => [(p.x + pad) * S, ((SIZE - p.y) + pad) * S]
    const fb = new FB(W, H, [17, 17, 17])
    const drawLoop = (loop: Pt[], c: [number, number, number], close: boolean, r = 0) => {
      for (let i = 1; i < loop.length; i++) { const a = T(loop[i - 1]), b = T(loop[i]); fb.line(a[0], a[1], b[0], b[1], c, r) }
      if (close && loop.length > 2) { const a = T(loop[loop.length - 1]), b = T(loop[0]); fb.line(a[0], a[1], b[0], b[1], c, r) }
    }
    drawLoop(square, [150, 150, 150], true)
    drawLoop(island, [190, 130, 130], true)
    for (const p of res.passes) if (p.type === 'cut') drawLoop(p.points, [50, 80, 120], false)
    for (const p of res.passes) if (p.type === 'wallfollow') drawLoop(p.points, [0, 120, 95], false)
    for (const p of res.passes) if (p.type === 'link' && (p as any).jumpType === 2) drawLoop((p as any).points, [90, 90, 90], false)
    for (const l of rep.lifts) {
      const c: [number, number, number] = l.uncutFrac > 0.25 ? [255, 40, 40] : l.uncutFrac > 0.05 ? [240, 210, 40] : [60, 220, 60]
      const q = T(l.to); fb.dot(q[0], q[1], c, 4)
    }
    // Diagnostic render only (not a golden compare) -- write to the gitignored
    // review-images/ dir, never the tracked docs/planning/ copy, so full-suite
    // runs stop binary-churning it.
    fs.mkdirSync('review-images', { recursive: true })
    const OUT = 'review-images/lift_reentry_island.png'
    fs.writeFileSync(OUT, fb.png())
    console.log(`wrote ${OUT} (re-entry dots: green <5% uncut, yellow 5-25%, red >25%)`)
  }, 600_000)

  it('Bar fixture render: old 97%-uncut landing vs gated landings', () => {
    // Render docs/planning/lift_reentry_bar_fixed.png: the Bar toolpath with every emitted
    // lift landing colored by its measured uncut fraction (green <5%, yellow 5-25%, red >25%)
    // plus a hollow RED RING at the OLD pre-gate landing (143.33, -54.97) -- the 97%-uncut
    // full-width center plunge the lift-landing gate now rejects (no dot sits there anymore;
    // the lift lands at the walker point instead).
    const { boundary, holes, helixDiameter, name } = loadGtFixture(4)
    const TOOLR = 2.0
    const res = processFeature({ boundary, holes }, {
      toolRadius: TOOLR, stepOver: 0.2, tolerance: 0.1, helixDiameter, stockToLeave: 0.5,
      integralWallFollow: true, wallCleanupAsWeGo: true, loopbackFilletPct: 25,
    })
    const rep = replayAndMeasure(`Bar (fix4) ${name} [render]`, res, TOOLR)
    printTable(rep, TOOLR)

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const p of boundary) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y) }
    const pad = 6, S = 1400 / (maxX - minX + 2 * pad)
    const W = Math.ceil((maxX - minX + 2 * pad) * S), H = Math.ceil((maxY - minY + 2 * pad) * S)
    const T = (p: Pt): [number, number] => [(p.x - minX + pad) * S, (maxY - p.y + pad) * S]
    const fb = new FB(W, H, [17, 17, 17])
    const drawLoop = (loop: Pt[], c: [number, number, number], close: boolean, r = 0) => {
      for (let i = 1; i < loop.length; i++) { const a = T(loop[i - 1]), b = T(loop[i]); fb.line(a[0], a[1], b[0], b[1], c, r) }
      if (close && loop.length > 2) { const a = T(loop[loop.length - 1]), b = T(loop[0]); fb.line(a[0], a[1], b[0], b[1], c, r) }
    }
    drawLoop(boundary, [150, 150, 150], true)
    for (const h of holes) drawLoop(h, [190, 130, 130], true)
    for (const p of res.passes) if (p.type === 'cut') drawLoop(p.points, [50, 80, 120], false)
    for (const p of res.passes) if (p.type === 'wallfollow') drawLoop(p.points, [0, 120, 95], false)
    for (const p of res.passes) if (p.type === 'link' && (p as any).jumpType === 2) drawLoop((p as any).points, [90, 90, 90], false)
    // NEW landings, colored by measured uncut fraction
    for (const l of rep.lifts) {
      const c: [number, number, number] = l.uncutFrac > 0.25 ? [255, 40, 40] : l.uncutFrac > 0.05 ? [240, 210, 40] : [60, 220, 60]
      const q = T(l.to); fb.dot(q[0], q[1], c, 4)
    }
    // OLD pre-gate landing: hollow red ring (nothing lands here anymore)
    const OLD: Pt = { x: 143.33, y: -54.97 }
    const [ox, oy] = T(OLD)
    for (let a = 0; a < 360; a += 2) {
      const r = 10
      fb.dot(ox + r * Math.cos(a * Math.PI / 180), oy + r * Math.sin(a * Math.PI / 180), [255, 40, 40], 1)
    }
    // Diagnostic render only -- gitignored review-images/ dir, same reasoning as above.
    fs.mkdirSync('review-images', { recursive: true })
    const OUT = 'review-images/lift_reentry_bar_fixed.png'
    fs.writeFileSync(OUT, fb.png())
    console.log(`wrote ${OUT} (red ring = OLD rejected landing; dots = current landings, green <5% / yellow 5-25% / red >25% uncut)`)
  }, 600_000)

  it('4 B8-changed fixtures: lift re-entry summaries', () => {
    const cases = [
      { fix: 2, label: 'SquareIsland (fix2)' },
      { fix: 4, label: 'Bar (fix4)' },
      { fix: 5, label: 'BootL (fix5)' },
      { fix: 7, label: 'Barbell (fix7)' },
    ]
    for (const c of cases) {
      const { boundary, holes, helixDiameter, name } = loadGtFixture(c.fix)
      const res = processFeature({ boundary, holes }, {
        toolRadius: 2.0, stepOver: 0.2, tolerance: 0.1, helixDiameter, stockToLeave: 0.5,
        integralWallFollow: true, wallCleanupAsWeGo: true, loopbackFilletPct: 25,
      })
      const rep = replayAndMeasure(`${c.label} ${name}`, res, 2.0)
      printTable(rep, 2.0)
    }
  }, 600_000)
})
