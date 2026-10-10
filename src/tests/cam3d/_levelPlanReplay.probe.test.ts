// WO-409 probe (opt-in): replay ONE dumped 2D level-plan request (feature + params, written
// by the example probe's EXAMPLE_PROBE_PLAN_DUMP) through processFeature in seconds and
// measure every lateral pass with a 2 mm-window capsule measure against the running
// cleared polygon - the 2D twin of measurePathEngagement. Prints entries, passes, the
// over-cap windows by pass, and (optionally) writes the passes for plotting.
//
//   LEVEL_PLAN_REPLAY=<dump.json> LEVEL_PLAN_INDEX=<i> [LEVEL_PLAN_OUT=<passes.json>]
//   npx vitest run src/tests/cam3d/_levelPlanReplay.probe.test.ts
import { describe, it, beforeAll } from 'vitest'
import * as fs from 'node:fs'
import { ensureEngineClipperReady, processFeature } from '../../cam3d/rough/engineEntry'
import { capsulePath, diskPath, difference, totalArea, union, loopArea, type Loops, type Pt } from '../../lib/cam/adaptiveClearing2d/engine/clipperEngine'

const DUMP = process.env.LEVEL_PLAN_REPLAY
describe.skipIf(!DUMP)('level plan replay', () => {
  beforeAll(async () => { await ensureEngineClipperReady() })
  it('replays one level request and measures engagement', { timeout: 600000 }, () => {
    const all = JSON.parse(fs.readFileSync(DUMP!, 'utf8')) as Array<{ feature: any; params: any; passes: number; aborted: string | null }>
    const idx = Number(process.env.LEVEL_PLAN_INDEX ?? '0')
    const req = all[idx]
    if (!req) throw new Error(`no request ${idx} (have ${all.length})`)
    const p = req.params
    console.log(`[replay] request ${idx}/${all.length}: boundary ${req.feature.boundary.length} pts, ${req.feature.holes?.length ?? 0} holes, R ${p.toolRadius} stepOver ${p.stepOver} tol ${p.tolerance} helix ${p.helixDiameter} dir ${p.millingDirection} seed ${p.clearedSeed ? 'yes' : 'no'} skipOuter ${!!p.skipOuterBoundaryCleanup} (3D run: ${req.passes} passes, aborted ${req.aborted})`)
    const t0 = performance.now()
    const res = processFeature(req.feature, p)
    console.log(`[replay] ${((performance.now() - t0) / 1000).toFixed(1)}s: ${res.passes.length} passes, entries ${res.entries.length}, aborted ${res.stats.aborted ?? "no"}, stats ${JSON.stringify(res.stats)}`)
    for (const e of res.entries) console.log(`[replay]   entry ${e.mode} at (${e.point.x.toFixed(2)}, ${e.point.y.toFixed(2)}) r ${e.radius.toFixed(2)}`)
    // 2D engagement measure, the 3D gate's twin: every lateral move at depth (cut, lead,
    // wallfollow, finish, keep-down link) in emitted order, windowed over >= 2 mm across pass
    // boundaries; a run breaks at an entry or a lift (jumpType 2). Fresh area per segment
    // against the running cleared polygon.
    const R = p.toolRadius, D = 2 * R, arcTol = p.arcTol ?? Math.max(p.tolerance * 0.25, 0.01)
    const WINDOW = 2.0, CAP = 0.75
    const nearParts = (process.env.LEVEL_PLAN_NEAR ?? '').split(',').map(Number)
    const near = nearParts.length >= 2 && nearParts.every(Number.isFinite) ? { x: nearParts[0], y: nearParts[1], r: nearParts[2] ?? 2.5 } : null
    let acc: Loops = p.clearedSeed ?? []
    let peak = 0, peakAt: Pt | null = null, peakPass = -1, overCap = 0, cutting = 0
    const byPass = new Map<number, { over: number; max: number; type: string; n: number }>()
    type Seg = { len: number; area: number; mid: Pt; pass: number; type: string }
    const runs: Seg[][] = [[]]
    res.passes.forEach((pass, pi) => {
      if (pass.type === 'entry') { acc = union(acc, diskPath(pass.point, pass.radius > 0 ? pass.radius + R : R, arcTol)); runs.push([]); return }
      if (pass.type === 'link' && pass.jumpType === 2) { runs.push([]); return }
      if (pass.type !== 'cut' && pass.type !== 'lead' && pass.type !== 'wallfollow' && pass.type !== 'finish' && pass.type !== 'link') return
      const pts = pass.points
      if (near && pts.some((q) => Math.hypot(q.x - near.x, q.y - near.y) <= near.r)) console.log(`[replay]     passes near: ${pi} ${pass.type}${pass.type === 'link' ? ' j' + pass.jumpType : ''} ${pts.length} pts from (${pts[0].x.toFixed(2)}, ${pts[0].y.toFixed(2)}) to (${pts[pts.length - 1].x.toFixed(2)}, ${pts[pts.length - 1].y.toFixed(2)})`)
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i]
        const L = Math.hypot(b.x - a.x, b.y - a.y)
        if (L < 1e-9) continue
        const cap = capsulePath(a, b, R, arcTol)
        runs[runs.length - 1].push({ len: L, area: totalArea(difference(cap, acc)), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, pass: pi, type: pass.type })
        acc = union(acc, cap)
      }
    })
    for (const run of runs) {
      let j = 0, lenSum = 0, areaSum = 0
      for (let i = 0; i < run.length; i++) {
        while (j < run.length && lenSum < WINDOW) { lenSum += run[j].len; areaSum += run[j].area; j++ }
        const frac = areaSum / Math.max(lenSum, WINDOW) / D
        const seg = run[i]
        const rec = byPass.get(seg.pass) ?? { over: 0, max: 0, type: seg.type, n: 0 }
        rec.n++
        if (near && Math.hypot(seg.mid.x - near.x, seg.mid.y - near.y) <= near.r && frac > 0.3) console.log(`[replay]     near: pass ${seg.pass} ${seg.type} at (${seg.mid.x.toFixed(2)}, ${seg.mid.y.toFixed(2)}) window ${(frac * 100).toFixed(0)}% (step ${seg.len.toFixed(2)} mm, fresh ${seg.area.toFixed(2)} mm^2 = ${(seg.area / seg.len / D * 100).toFixed(0)}% instantaneous)`)
        if (frac > peak) { peak = frac; peakAt = seg.mid; peakPass = seg.pass }
        if (frac > rec.max) rec.max = frac
        if (frac > CAP) { overCap += seg.len; rec.over += seg.len }
        cutting += seg.len
        byPass.set(seg.pass, rec)
        lenSum -= seg.len; areaSum -= seg.area
      }
    }
    // Belief vs physical: what the engine's final `cleared` holds that the emitted passes never swept.
    const beliefOnly = difference(res.cleared, acc)
    console.log(`[replay] belief-not-swept: ${totalArea(beliefOnly).toFixed(1)} mm^2 in ${beliefOnly.length} piece(s)`)
    for (const piece of beliefOnly.map((loop) => ({ loop, a: Math.abs(loopArea(loop)) })).sort((u, v) => v.a - u.a).slice(0, 8)) {
      const cx = piece.loop.reduce((t, q) => t + q.x, 0) / piece.loop.length, cy = piece.loop.reduce((t, q) => t + q.y, 0) / piece.loop.length
      console.log(`[replay]   piece ${piece.a.toFixed(2)} mm^2 near (${cx.toFixed(2)}, ${cy.toFixed(2)})`)
    }
    if (process.env.LEVEL_PLAN_OUT) fs.writeFileSync(process.env.LEVEL_PLAN_OUT + '.belief.json', JSON.stringify(beliefOnly))
    console.log(`[replay] 2D measure: peak ${(peak * 100).toFixed(1)}% at (${peakAt?.x.toFixed(2)}, ${peakAt?.y.toFixed(2)}) pass ${peakPass}; over-cap ${overCap.toFixed(1)} / ${cutting.toFixed(0)} mm`)
    for (const [pi, r] of [...byPass.entries()].filter(([, r]) => r.over > 0 || r.max > 0.6).sort((a, b) => b[1].over - a[1].over).slice(0, 15)) {
      console.log(`[replay]   pass ${pi} ${r.type} ${r.n} pts: max ${(r.max * 100).toFixed(0)}% over-cap ${r.over.toFixed(1)} mm`)
    }
    if (process.env.LEVEL_PLAN_OUT) fs.writeFileSync(process.env.LEVEL_PLAN_OUT, JSON.stringify({ feature: req.feature, passes: res.passes, cleared: res.cleared, cutRegion: res.cutRegion }))
  })
})
