// LEAK PROBE (root-cause tool, clipper2-wasm embind handle leak). Gated behind
// PROBE2=1 so the normal suite skips it. Run as its own vitest process:
//
//   $env:PROBE2='1'; npx vitest run src/tests/adaptive-clearing/engine/_wasm-leak-probe.test.ts --testTimeout=600000
//
// Test 1 hammers the engine's representative clipper op mix (union-accumulate,
// difference disk-vs-cleared, closed offset, polytree offset, point-in-polygon)
// for ~20k iterations, sampling the wasm linear-memory size every 1000 iterations.
// Emscripten memory only grows, so: leak = monotonic growth (historically to the
// 2GB Aborted() wall); healthy = early plateau. The historical leak mechanism was
// embind value-returning accessors -- PathsD.get(i)/PathD.get(j)/PolyPathD.polygon()
// each malloc a COPY on the wasm heap that must be .delete()d.
//
// Test 2 is the "~12 engine runs per process" quirk check: run a small real GT
// fixture through processFeature 20x in ONE process. Before the handle-leak fix
// this aborted around run ~12; it must now complete all 20 with a flat heap.
import { describe, it, expect, beforeAll } from 'vitest'
import * as fs from 'fs'
import {
  ensureEngineClipperReady, engineWasmHeapBytes,
  union, difference, intersection, offsetClosed, offsetClosedTree,
  diskPath, capsulePath, pointInPolygon, type Loop, type Pt,
} from '../../../lib/cam/adaptiveClearing2d/engine/clipperEngine'
import { processFeature } from '../../../lib/cam/adaptiveClearing2d/engine/processFeature'

const MB = (b: number) => (b / 1048576).toFixed(1)

describe.runIf(!!process.env.PROBE2)('clipper2-wasm leak probe', () => {
  beforeAll(async () => { await ensureEngineClipperReady() })

  it('op-mix heap probe: heap must plateau over ~20k iterations', () => {
    const N = Number(process.env.ITERS ?? 20000)
    const square: Loop = [
      { x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 40 }, { x: 0, y: 40 },
    ]
    let cleared = diskPath({ x: 20, y: 20 }, 2)
    const samples: number[] = []
    for (let i = 0; i < N; i++) {
      // a capsule marching around a circle, unioned into an accumulating cleared
      // region -- the engine's hottest pattern (step commit).
      const ang = (i % 360) * Math.PI / 180
      const a: Pt = { x: 20 + 10 * Math.cos(ang), y: 20 + 10 * Math.sin(ang) }
      const b: Pt = { x: 20 + 10 * Math.cos(ang + 0.2), y: 20 + 10 * Math.sin(ang + 0.2) }
      cleared = union(cleared, capsulePath(a, b, 2))
      // cut-bite measurement: disk minus cleared (engagement sampling pattern)
      const disk = diskPath(b, 2.2)
      difference(disk, cleared)
      intersection(disk, cleared)
      // inward closed offset + polytree variant (reseed / region pattern)
      offsetClosed([square], -0.5 - (i % 10) * 0.1)
      if (i % 25 === 0) offsetClosedTree([square], -1.0)
      pointInPolygon(b, square)
      // reset the accumulator periodically so geometry complexity stays bounded
      // (we are probing per-call handle leaks, not polygon growth)
      if (i % 50 === 49) cleared = diskPath({ x: 20, y: 20 }, 2)
      if ((i + 1) % 1000 === 0) {
        const bytes = engineWasmHeapBytes()
        samples.push(bytes)
        // eslint-disable-next-line no-console
        console.log(`iter ${i + 1}: wasm heap ${MB(bytes)} MB`)
      }
    }
    // Plateau gate: after warm-up (first 2 samples), the heap may not grow by
    // more than 16MB (one emscripten growth step of slack). Leaky code blows
    // through this by hundreds of MB (or aborts before finishing).
    const warm = samples[1]
    const last = samples[samples.length - 1]
    // eslint-disable-next-line no-console
    console.log(`heap warm=${MB(warm)} MB -> final=${MB(last)} MB (growth ${MB(last - warm)} MB)`)
    expect(last - warm).toBeLessThanOrEqual(16 * 1048576)
  })

  it('20 processFeature runs in one process (the historical ~12-run abort)', () => {
    const FIX = process.env.FIX ?? '4' // Bar: smallest GT fixture
    const d = JSON.parse(fs.readFileSync(`test_fixtures/adaptive-clearing/spirals/_cmp/_gt/gt_fix${FIX}.json`, 'utf8'))
    const boundary: Loop = (d.boundary as number[][]).map(([x, y]) => ({ x, y }))
    const holes: Loop[] = (d.islands ?? []).map((isl: number[][]) => isl.map(([x, y]: number[]) => ({ x, y })))
    const params = {
      toolRadius: 2.0, stepOver: 0.2, tolerance: 0.1,
      helixDiameter: d.helix?.diameter ?? 3, stockToLeave: 0.5,
    }
    for (let run = 1; run <= 20; run++) {
      const res = processFeature({ boundary, holes }, params)
      // eslint-disable-next-line no-console
      console.log(`run ${run}: passes=${res.passes.length} heap=${MB(engineWasmHeapBytes())} MB`)
      expect(res.passes.length).toBeGreaterThan(0)
    }
  })
})
