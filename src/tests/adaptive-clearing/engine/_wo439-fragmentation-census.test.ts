// WO-439 STEP 1: FRAGMENTATION CENSUS (diagnosis only; underscore = not CI).
//
// THE QUESTION: why does the engine fragment a simple area into many spiral starts?
// On fix4 Bar (a plain rectangle) it enters 7 times where Fusion enters once.
//
// This runner turns on the motion-neutral census recorder in processFeature
// (setFragmentationCensus) and prints, for fix4 Bar / fix0 CommaSpiral / fix6 Triangle
// at the canonical corpus settings:
//   - every pass ending: index, reason, x/y, pass length mm, area cut mm^2, whether it
//     cleared the progress contract, and how much uncut material was still standing
//     within one tool diameter of the point where it stopped (remainingNearEnd);
//   - every reseed: what the engage walker tried (boundary distance walked, in-band bites
//     handed out) before it gave up, and what reseed() then did;
//   - per-fixture totals by reason, split into the ancestor's three-way model
//     (no-cut / over-cut / boundary, freecad-ancestry.md sec 4) and OUR additions.
//
// It also writes a labeled PNG per fixture to src/tests/evidence/WO-439/diagnosis/:
// pale paths, a numbered circle at every entry, a colour-coded dot at every pass end,
// and a plain-words legend strip. Render pattern copied from _wo410-corpus-render.test.ts;
// 5x7 font copied from src/tests/evidence/WO-410/corpus/stitch.mjs.
//
// Run:  npx vitest run src/tests/adaptive-clearing/engine/_wo439-fragmentation-census.test.ts

import { describe, it, beforeAll } from 'vitest'
import * as fs from 'fs'
import * as zlib from 'zlib'
import {
  ensureEngineClipperReady, offsetClosed, difference,
  type Loops, type Pt,
} from '../../../lib/cam/adaptiveClearing2d/engine/clipperEngine'
import {
  processFeature, setFragmentationCensus, getFragmentationCensus,
  type AdaptivePass, type ProcessParams, type PassEndRecord, type ReseedRecord,
} from '../../../lib/cam/adaptiveClearing2d/engine/processFeature'
import { CANONICAL_PARAMS, loadGtFixture, FIXTURE_META } from './_goodspec-helpers'

// The default is a SCRATCH directory on purpose. This runner used to default to
// src/tests/evidence/WO-439/diagnosis, and a plain `vitest run src/tests/adaptive-clearing`
// then silently overwrote the committed step-1 diagnosis evidence with post-fix numbers.
// Binding evidence is written only when a run NAMES its destination.
// (The same hazard still exists in _wo410-corpus-render.test.ts, which defaults to
// src/tests/evidence/WO-410/corpus with CORPUS_TAG=after - reported, not fixed here.)
const OUT_DIR = process.env.WO439_OUT_DIR ?? 'src/tests/evidence/WO-439/_last-run'
// Default: the three step-1 diagnosis fixtures (Bar, CommaSpiral, Triangle). Step 2 runs
// the whole corpus for the before/after table: WO439_FIXTURES=0,1,2,3,4,5,6,7,8
const FIXTURES = (process.env.WO439_FIXTURES ?? '4,0,6').split(',').map(s => Number(s.trim()))

// ---- reason vocabulary: whose model does each ending come from? ------------------
// freecad-ancestry.md sec 4: the ancestor's per-pass loop ends for exactly THREE reasons.
const ANCESTOR_REASONS = new Set<PassEndRecord['reason']>(['no-cut', 'over-cut', 'boundary-clip'])
// Plain words for the picture legend and the printed table.
const PLAIN: Record<PassEndRecord['reason'], string> = {
  'boundary-clip': 'HIT THE WALL',
  'boundary-stall': 'STUCK ON THE WALL',
  'no-cut': 'NOTHING TO BITE',
  'over-cut': 'LOAD SPIKE',
  'orbit-close': 'BACK WHERE IT STARTED',
  'max-points': 'RAN OUT OF STEPS',
}
const REASON_COLOR: Record<PassEndRecord['reason'], [number, number, number]> = {
  'boundary-clip': [235, 60, 200],   // magenta
  'boundary-stall': [255, 120, 0],   // orange
  'no-cut': [250, 230, 40],          // yellow
  'over-cut': [255, 40, 40],         // red
  'orbit-close': [40, 220, 220],     // cyan
  'max-points': [255, 255, 255],     // white
}
const RESEED_COLOR: Record<ReseedRecord['cause'], [number, number, number]> = {
  'walk-exhausted': [70, 230, 90],   // green
  'fruitless-lap': [255, 160, 30],   // amber
}

// ---- minimal PNG framebuffer (copied from _wo410-corpus-render.test.ts) ----------
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
  disc(x: number, y: number, r: number, c: [number, number, number]) {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (dx * dx + dy * dy <= r * r) this.px(x + dx, y + dy, c)
  }
  ring(x: number, y: number, r: number, c: [number, number, number], w = 1) {
    for (let dy = -r - w; dy <= r + w; dy++) for (let dx = -r - w; dx <= r + w; dx++) {
      const d = Math.sqrt(dx * dx + dy * dy)
      if (d >= r - w && d <= r + w) this.px(x + dx, y + dy, c)
    }
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

// 5x7 bitmap font (copied from src/tests/evidence/WO-410/corpus/stitch.mjs)
const FONT: Record<string, string[]> = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  G: ['01110', '10001', '10000', '10111', '10001', '10001', '01110'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
  J: ['00111', '00010', '00010', '00010', '00010', '10010', '01100'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  W: ['10001', '10001', '10001', '10101', '10101', '11011', '10001'],
  X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00110', '01000', '10000', '11111'],
  '3': ['01110', '10001', '00001', '00110', '00001', '10001', '01110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['01110', '10000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00001', '01110'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
}
function drawText(fb: FB, x0: number, y0: number, text: string, scale: number, rgb: [number, number, number]) {
  let x = x0
  for (const ch of text.toUpperCase()) {
    const g = FONT[ch] ?? FONT[' ']
    for (let gy = 0; gy < 7; gy++) for (let gx = 0; gx < 5; gx++) {
      if (g[gy][gx] === '1') for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) fb.px(x + gx * scale + sx, y0 + gy * scale + sy, rgb)
    }
    x += 6 * scale
  }
}

describe('WO-439 fragmentation census (diagnosis)', () => {
  beforeAll(async () => { await ensureEngineClipperReady() })

  for (const fix of FIXTURES) {
    const meta = FIXTURE_META.find(m => m.fix === fix)!
    it(`census + labeled picture: fix${fix} ${meta.name}`, () => {
      const { boundary, holes, helixDiameter, name } = loadGtFixture(fix)
      const params: ProcessParams = { ...CANONICAL_PARAMS, helixDiameter }

      setFragmentationCensus(true)
      const warn = console.warn; console.warn = () => {}
      let res
      try { res = processFeature({ boundary, holes }, params) } finally { console.warn = warn; setFragmentationCensus(false) }
      const census = getFragmentationCensus()

      const cuts = res.passes.filter(p => p.type === 'cut').length
      const entries = res.entries.length
      // WO-439 step 2: the honesty and motion columns of the before/after table, measured
      // here so ONE corpus run answers "did we cut more, and did we connect it more calmly".
      // Lift split copied from _wo410-corpus-render.test.ts (jumpType 2 = a real lift;
      // micro = the WO-437 2mm hop). residualArea is the engine's own honest leftover.
      type LinkP = Extract<AdaptivePass, { type: 'link' }>
      const liftLinks = res.passes.filter(p => p.type === 'link' && (p as LinkP).jumpType === 2) as LinkP[]
      const microLifts = liftLinks.filter(p => p.microLift).length
      const lifts = liftLinks.length
      const clearanceLifts = lifts - microLifts
      const residualMm2 = res.stats.residualArea

      // ---- printed table -------------------------------------------------------
      const L: string[] = []
      L.push(`=== fix${fix} ${name} : cuts=${cuts} entries=${entries} fusionPasses=${meta.fusionPasses} aborted=${res.stats.aborted ?? 'no'} ===`)
      L.push(`lifts=${lifts} (micro=${microLifts} clearance=${clearanceLifts})  residualMm2=${residualMm2.toFixed(4)}  maxInscribedR=${res.stats.residualMaxInscribedR.toFixed(3)}`)
      L.push(`pass-loop iterations recorded: ${census.passEnds.length}; reseeds: ${census.reseeds.length}; entries planted: ${census.entries.length}`)
      L.push('')
      L.push('--- EVERY PASS END ---')
      L.push('  idx  reason             x        y      travel_mm   area_mm2  kept prog  nearEnd_mm2  thick_mm2  detail')
      for (const r of census.passEnds) {
        L.push(
          `  ${String(r.pass).padStart(4)}  ${r.reason.padEnd(16)} ${r.x.toFixed(3).padStart(8)} ${r.y.toFixed(3).padStart(8)}` +
          ` ${r.travel.toFixed(3).padStart(10)} ${r.area.toFixed(4).padStart(10)}  ${r.kept ? 'Y' : 'n'}    ${r.progressed ? 'Y' : 'n'}` +
          ` ${r.remainingNearEnd.toFixed(3).padStart(11)} ${r.remainingNearEndThick.toFixed(3).padStart(10)}  ${r.detail}`,
        )
      }
      L.push('')
      L.push('--- EVERY RESEED (why the walker gave up, what reseed did) ---')
      L.push('  afterPass  cause           walked_mm  boundary_mm  bites  outcome    stop        x        y   remaining_mm2')
      for (const r of census.reseeds) {
        L.push(
          `  ${String(r.pass).padStart(9)}  ${r.cause.padEnd(14)} ${r.odometerSinceProgress.toFixed(1).padStart(10)} ${r.boundaryLength.toFixed(1).padStart(12)}` +
          ` ${String(r.bitesSinceProgress).padStart(6)}  ${r.outcome.padEnd(9)} ${(r.stop ?? '-').padEnd(11)}` +
          ` ${(r.x ?? NaN).toFixed(2).padStart(8)} ${(r.y ?? NaN).toFixed(2).padStart(8)} ${r.remainingArea.toFixed(1).padStart(14)}`,
        )
      }
      L.push('')
      L.push('--- ENTRIES PLANTED (numbered as on the picture) ---')
      census.entries.forEach((e, i) => L.push(`  entry ${i + 1}: pass ${e.pass} at (${e.x.toFixed(2)}, ${e.y.toFixed(2)}) mode=${e.mode} radius=${e.radius.toFixed(2)}`))
      L.push('')

      // totals by reason, ancestor vs ours
      const byReason = new Map<PassEndRecord['reason'], PassEndRecord[]>()
      for (const r of census.passEnds) {
        const list = byReason.get(r.reason) ?? []
        list.push(r); byReason.set(r.reason, list)
      }
      L.push('--- TOTALS BY REASON ---')
      L.push('  reason            model      count   pct    keptN  nonProgressN  medianTravel_mm  medianArea_mm2  nearEnd>0  thick>0')
      const med = (xs: number[]) => xs.length === 0 ? 0 : [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
      const total = census.passEnds.length
      const totals: Record<string, unknown>[] = []
      for (const [reason, list] of [...byReason.entries()].sort((a, b) => b[1].length - a[1].length)) {
        const nonProg = list.filter(r => !r.progressed).length
        const nearPos = list.filter(r => r.remainingNearEnd > 1e-9).length
        const thickPos = list.filter(r => r.remainingNearEndThick > 1e-9).length
        const row = {
          reason, model: ANCESTOR_REASONS.has(reason) ? 'ancestor' : 'OURS', count: list.length,
          pct: Number((100 * list.length / total).toFixed(1)),
          kept: list.filter(r => r.kept).length, nonProgressing: nonProg,
          medianTravel: Number(med(list.map(r => r.travel)).toFixed(3)),
          medianArea: Number(med(list.map(r => r.area)).toFixed(4)),
          nearEndPositive: nearPos, thickPositive: thickPos,
          medianNearEnd: Number(med(list.map(r => r.remainingNearEnd)).toFixed(3)),
          medianThick: Number(med(list.map(r => r.remainingNearEndThick)).toFixed(3)),
        }
        totals.push(row)
        L.push(
          `  ${reason.padEnd(17)} ${row.model.padEnd(9)} ${String(row.count).padStart(6)} ${String(row.pct).padStart(6)}` +
          ` ${String(row.kept).padStart(7)} ${String(row.nonProgressing).padStart(13)} ${String(row.medianTravel).padStart(16)}` +
          ` ${String(row.medianArea).padStart(15)} ${String(row.nearEndPositive).padStart(10)} ${String(row.thickPositive).padStart(8)}`,
        )
      }
      const ancestorN = census.passEnds.filter(r => ANCESTOR_REASONS.has(r.reason)).length
      L.push(`  ANCESTOR-MODEL endings: ${ancestorN}/${total} (${(100 * ancestorN / total).toFixed(1)}%)   OURS: ${total - ancestorN}/${total} (${(100 * (total - ancestorN) / total).toFixed(1)}%)`)
      L.push('')

      // hypothesis probes
      const nonProg = census.passEnds.filter(r => !r.progressed)
      const nearWall = census.passEnds.filter(r => r.distToBoundary < params.toolRadius)
      const noCut = byReason.get('no-cut') ?? []
      const noCutWithMaterial = noCut.filter(r => r.remainingNearEnd > 1e-9)
      const noCutWithThick = noCut.filter(r => r.remainingNearEndThick > 1e-9)
      const stalls = byReason.get('boundary-stall') ?? []
      const skimRefused = stalls.filter(r => r.detail.startsWith('skim-refused'))
      const skimOverload = stalls.filter(r => r.detail.includes('overload'))
      L.push('--- HYPOTHESIS PROBES ---')
      L.push(`(a) WALL TAPER: endings with the tool inside one tool RADIUS of the wall: ${nearWall.length}/${total} (${(100 * nearWall.length / total).toFixed(1)}%)`)
      L.push(`    boundary-stall endings: ${stalls.length}; tangential skim refused on ${skimRefused.length} of them (overload-refusals: ${skimOverload.length})`)
      L.push(`(b) MINIMUM BITE: passes that FAILED the progress contract (area <= minPassBite): ${nonProg.length}/${total}` +
        `; of those, ${nonProg.filter(r => r.kept).length} were still EMITTED as cuts (real material removed, judged too little to count)`)
      L.push(`    minPassBite for this run = ${census.passEnds[0]?.minPassBite.toFixed(4) ?? 'n/a'} mm^2; median area of a failing pass = ${med(nonProg.map(r => r.area)).toFixed(4)} mm^2`)
      L.push(`(c) NO-CUT ON BELIEF: no-cut endings = ${noCut.length}; with uncut material still within one tool DIAMETER = ${noCutWithMaterial.length}` +
        `; with material thicker than half a stepover = ${noCutWithThick.length}`)
      L.push(`    median remainingNearEnd on a no-cut ending = ${med(noCut.map(r => r.remainingNearEnd)).toFixed(3)} mm^2 (thick ${med(noCut.map(r => r.remainingNearEndThick)).toFixed(3)} mm^2)`)
      L.push('')

      console.log(L.join('\n'))

      fs.mkdirSync(OUT_DIR, { recursive: true })
      fs.writeFileSync(`${OUT_DIR}/fix${fix}_${name}_census.txt`, L.join('\n') + '\n')
      fs.writeFileSync(`${OUT_DIR}/fix${fix}_${name}_census.json`, JSON.stringify({
        fix, name, cuts, entries, lifts, microLifts, clearanceLifts,
        residualMm2: Number(residualMm2.toFixed(4)), residualMaxInscribedR: Number(res.stats.residualMaxInscribedR.toFixed(4)),
        fusionPasses: meta.fusionPasses, aborted: res.stats.aborted ?? null,
        totalsByReason: totals, ancestorEndings: ancestorN, ourEndings: total - ancestorN,
        passEnds: census.passEnds, reseeds: census.reseeds, entriesPlanted: census.entries,
      }, null, 2) + '\n')

      // ---- labeled render ------------------------------------------------------
      const xs = [...boundary, ...holes.flat()].map(p => p.x), ys = [...boundary, ...holes.flat()].map(p => p.y)
      const minX = Math.min(...xs), minY = Math.min(...ys)
      const span = Math.max(Math.max(...xs) - minX, Math.max(...ys) - minY)
      const arcTol = 0.05
      const pad = 4, S = 900 / (span + 2 * pad)
      const W = Math.ceil((span + 2 * pad) * S)
      const PLOT_H = Math.ceil((span + 2 * pad) * S)
      const legendRows = 2 + Object.keys(PLAIN).length + 4
      const LEG_H = 24 + legendRows * 20
      const fb = new FB(W, PLOT_H + LEG_H, [17, 17, 17])
      const T = (p: Pt): [number, number] => [(p.x - minX + pad) * S, ((span - (p.y - minY)) + pad) * S]
      const drawLoop = (loop: Pt[], c: [number, number, number], close: boolean, r = 0) => {
        for (let i = 1; i < loop.length; i++) { const a = T(loop[i - 1]), b = T(loop[i]); fb.line(a[0], a[1], b[0], b[1], c, r) }
        if (close && loop.length > 2) { const a = T(loop[loop.length - 1]), b = T(loop[0]); fb.line(a[0], a[1], b[0], b[1], c, r) }
      }
      const finishStock = params.tolerance / 2 + (params.stockToLeave ?? 0)
      const target: Loops = difference(offsetClosed([boundary], -finishStock, arcTol), offsetClosed(holes, finishStock, arcTol))
      for (const loop of target) drawLoop(loop, [40, 40, 40], true)
      drawLoop(boundary, [120, 120, 120], true)
      for (const h of holes) drawLoop(h, [150, 110, 110], true)
      for (const loop of res.cutRegion) drawLoop(loop, [64, 64, 64], true)
      // paths pale/thin so the markers read on top
      type LinkPass = Extract<AdaptivePass, { type: 'link' }>
      for (const p of res.passes) if (p.type === 'cut') drawLoop(p.points, [46, 68, 96], false)
      for (const p of res.passes) if (p.type === 'wallfollow') drawLoop(p.points, [0, 92, 76], false)
      for (const p of res.passes) if (p.type === 'loopback') drawLoop(p.points, [104, 78, 0], false)
      for (const p of res.passes) if (p.type === 'link' && (p as LinkPass).jumpType === 1) drawLoop((p as LinkPass).points, [30, 78, 30], false)
      for (const p of res.passes) if (p.type === 'link' && (p as LinkPass).jumpType === 2) drawLoop((p as LinkPass).points, [110, 30, 30], false)

      // pass-end break points, coloured by reason; a white ring = the pass cut too little
      // to satisfy the progress contract and so sent the walker toward a reseed.
      for (const r of census.passEnds) {
        const [x, y] = T({ x: r.x, y: r.y })
        if (!r.progressed) fb.ring(x, y, 5, [235, 235, 235], 0)
        fb.disc(x, y, 3, REASON_COLOR[r.reason])
      }
      // entries: numbered circles, coloured by WHY the previous engagement path stopped
      // (green = walked the whole boundary with nothing to bite; amber = gave up after a
      // full lap of bites that were all too small to start a pass; white = the first entry)
      census.entries.forEach((e, i) => {
        const [x, y] = T({ x: e.x, y: e.y })
        // the reseed that produced this entry is the last one recorded before its pass
        const rs = [...census.reseeds].filter(r => r.pass < e.pass).pop()
        const c: [number, number, number] = i === 0 && !rs ? [255, 255, 255] : RESEED_COLOR[rs?.cause ?? 'walk-exhausted']
        fb.ring(x, y, 10, c, 1)
        drawText(fb, x + 14, y - 7, String(i + 1), 2, c)
      })

      // ---- legend strip --------------------------------------------------------
      let ly = PLOT_H + 10
      drawText(fb, 10, ly, `FIX${fix} ${name.toUpperCase()} - WHY EVERY CUT PASS STOPPED`, 2, [235, 235, 235]); ly += 20
      drawText(fb, 10, ly, `${cuts} CUT PASSES - ${entries} ENTRIES - FUSION NEEDS ${meta.fusionPasses} PASSES`, 2, [170, 170, 170]); ly += 22
      for (const [reason, list] of [...byReason.entries()].sort((a, b) => b[1].length - a[1].length)) {
        fb.disc(18, ly + 6, 5, REASON_COLOR[reason])
        drawText(fb, 34, ly, `${PLAIN[reason]} - ${list.length}`, 2, REASON_COLOR[reason])
        ly += 20
      }
      fb.ring(18, ly + 6, 5, [235, 235, 235], 0)
      drawText(fb, 34, ly, `WHITE RING - CUT TOO LITTLE TO COUNT - ${nonProg.length}`, 2, [235, 235, 235]); ly += 20
      const zeroMotion = census.passEnds.filter(r => r.travel === 0).length
      drawText(fb, 34, ly, `OF THOSE - ${zeroMotion} MOVED THE TOOL ZERO MM AND CUT NOTHING AT ALL`, 2, [200, 200, 200]); ly += 20
      fb.ring(18, ly + 6, 7, RESEED_COLOR['walk-exhausted'], 1)
      drawText(fb, 34, ly, 'NUMBERED GREEN CIRCLE - NEW ENTRY AFTER NOTHING LEFT ON THE WALL WALK', 2, RESEED_COLOR['walk-exhausted']); ly += 20
      fb.ring(18, ly + 6, 7, RESEED_COLOR['fruitless-lap'], 1)
      drawText(fb, 34, ly, 'NUMBERED AMBER CIRCLE - NEW ENTRY AFTER GIVING UP ON A FULL LAP', 2, RESEED_COLOR['fruitless-lap']); ly += 20

      const out = `${OUT_DIR}/fix${fix}_${name}_breaks.png`
      fs.writeFileSync(out, fb.png())
      console.log(`wrote ${out} ${W}x${PLOT_H + LEG_H}`)
    }, 900_000)
  }
})
