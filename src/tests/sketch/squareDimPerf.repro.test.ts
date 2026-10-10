// PERF REPRO (measure-first, no fix shipped here). Bug report: after commit
// 0eb3518 added an `equal` leg to a Shift-drawn SQUARE (buildRectCommit
// forceSquare=true), placing a dimension on the square and then CHANGING that
// dimension takes SEVERAL SECONDS to resize. A normal (non-square) rectangle
// does not lag.
//
// This drives the REAL app solver path (solveSketchOnWrapper on a real
// planegcs GcsWrapper — the exact call the worker makes) and MEASURES
// wall-clock per solve for:
//   A  square + equal, NO fix (under-defined, dof>0) — dimension EDIT
//      (geometry starts far from the demanded value: the real scenario)
//   A' square + equal, NO fix — dimension AT the drawn value (near solution)
//   B  square, NO equal, NO fix — dimension EDIT (control)
//   C  normal rectangle (20x10, two dims), NO fix — width EDIT (control)
//   D  square + equal, WITH a corner fix (dof==0) — dimension EDIT
//      (dof==0 short-circuits the per-entity diagnosis + free-DoF parking)
//   RAW one bare DogLeg solve of case A's primitives (no diagnosis/park/
//      false-conflict pipeline) — isolates the solver cost from the pipeline.
//
// The whole point is to LOCALIZE the cost, so every case logs its ms and the
// final assertion goes RED if square+equal is pathologically slower than the
// normal rectangle (the regression the user feels).

import { describe, it, expect } from 'vitest'
import { Algorithm } from '@salusoft89/planegcs'
import { createGcsWrapper } from '../../lib/planegcs/planegcsLoader'
import {
  solveSketchOnWrapper, sketchToGcsPrimitives,
} from '../../lib/sketch/solver/gcsMapping'
import { buildRectCommit } from '../../lib/sketch/tools/rectTools'
import type {
  Sketch, SketchConstraint, SketchDimension, PointRef,
} from '../../lib/sketch/types'
import type { GcsWrapper } from '@salusoft89/planegcs'

let wrapperP: Promise<GcsWrapper> | null = null
const getWrapper = () => (wrapperP ??= createGcsWrapper())

function ref(entityId: string, site: PointRef['site']): PointRef {
  return { entityId, site }
}

/** Build the sketch a Shift-square (or plain rect) tool would emit, plus the
 *  requested driving dimension(s). `forceSquare` toggles the extra equal leg.
 *  `drawn` is the as-drawn opposite corner; `fixCorner` grounds corner0 (so we
 *  can compare dof>0 vs dof==0). Dimensions drive side lengths to `dims`. */
function buildSketch(opts: {
  forceSquare: boolean
  drawn: { x: number; y: number }
  fixCorner: boolean
  dims: { side: 0 | 1; value: number }[]
}): { sketch: Sketch; sideIds: string[] } {
  let n = 0
  const commit = buildRectCommit(
    { x: 0, y: 0 }, opts.drawn, false, () => `r${n++}`, opts.forceSquare,
  )
  const sideIds = commit.entities.slice(0, 4).map((e) => e.id) // the four sides
  const constraints: SketchConstraint[] = [...commit.constraints]
  if (opts.fixCorner) {
    constraints.push({ id: 'fix0', kind: 'fix', point: ref(sideIds[0], 'start') })
  }
  const dimensions: SketchDimension[] = opts.dims.map((d, i) => ({
    id: `d${i}`, kind: 'distance', driving: true, value: d.value,
    a: ref(sideIds[d.side], 'start'), b: ref(sideIds[d.side], 'end'),
  }))
  return {
    sketch: {
      id: 'sk', layerId: 'layer',
      entities: commit.entities, constraints, dimensions, solveStatus: null,
    },
    sideIds,
  }
}

/** Best-of-`reps` wall-clock (ms) of one full solveSketchOnWrapper. Best-of
 *  strips GC / JIT noise so the reported number is the steady-state cost. */
async function timeSolve(sketch: Sketch, reps = 5): Promise<{ ms: number; out: ReturnType<typeof solveSketchOnWrapper> }> {
  const wrapper = await getWrapper()
  let best = Infinity
  let out!: ReturnType<typeof solveSketchOnWrapper>
  for (let i = 0; i < reps; i++) {
    const t0 = performance.now()
    out = solveSketchOnWrapper(wrapper, sketch)
    const dt = performance.now() - t0
    if (dt < best) best = dt
  }
  return { ms: best, out }
}

/** Best-of-`reps` wall-clock (ms) of ONE bare DogLeg solve (no diagnosis /
 *  parking / false-conflict pipeline) — the raw solver cost alone. */
async function timeRawSolve(sketch: Sketch, reps = 5): Promise<number> {
  const wrapper = await getWrapper()
  const prims = sketchToGcsPrimitives(sketch)
  let best = Infinity
  for (let i = 0; i < reps; i++) {
    wrapper.clear_data()
    wrapper.push_primitives_and_params(prims)
    const t0 = performance.now()
    wrapper.solve(Algorithm.DogLeg)
    const dt = performance.now() - t0
    if (dt < best) best = dt
  }
  return best
}

describe('PERF: square + equal-leg dimension edit (0eb3518)', () => {
  it('measures each case and localizes the cost', async () => {
    // A: square+equal, no fix, dimension EDITED to 30 (drawn at 20 -> far).
    const A = buildSketch({ forceSquare: true, drawn: { x: 20, y: 20 }, fixCorner: false,
      dims: [{ side: 0, value: 30 }] })
    // A': square+equal, no fix, dimension AT the drawn value (near solution).
    const Aprime = buildSketch({ forceSquare: true, drawn: { x: 20, y: 20 }, fixCorner: false,
      dims: [{ side: 0, value: 20 }] })
    // B: square WITHOUT equal, no fix, dimension EDITED to 30 (control).
    const B = buildSketch({ forceSquare: false, drawn: { x: 20, y: 20 }, fixCorner: false,
      dims: [{ side: 0, value: 30 }] })
    // C: normal rectangle 20x10, two dims, width EDITED to 30 (control).
    const C = buildSketch({ forceSquare: false, drawn: { x: 20, y: 10 }, fixCorner: false,
      dims: [{ side: 0, value: 30 }, { side: 1, value: 10 }] })
    // D: square+equal, corner FIXED (dof==0), dimension EDITED to 30.
    const D = buildSketch({ forceSquare: true, drawn: { x: 20, y: 20 }, fixCorner: true,
      dims: [{ side: 0, value: 30 }] })

    const a = await timeSolve(A.sketch)
    const aprime = await timeSolve(Aprime.sketch)
    const b = await timeSolve(B.sketch)
    const c = await timeSolve(C.sketch)
    const d = await timeSolve(D.sketch)
    const rawA = await timeRawSolve(A.sketch)

    const dof = (o: ReturnType<typeof solveSketchOnWrapper>) =>
      o.ok ? o.status.dof : `FAIL(${o.reason})`

    /* eslint-disable no-console */
    console.log('\n===== square-dim perf repro (best-of-5, ms) =====')
    console.log(`A  square+equal   no-fix EDIT(20->30)   full=${a.ms.toFixed(1)}  dof=${dof(a.out)}  ok=${a.out.ok}`)
    console.log(`A' square+equal   no-fix AT-value(20)   full=${aprime.ms.toFixed(1)}  dof=${dof(aprime.out)}  ok=${aprime.out.ok}`)
    console.log(`B  square NO-equal no-fix EDIT(20->30)   full=${b.ms.toFixed(1)}  dof=${dof(b.out)}  ok=${b.out.ok}`)
    console.log(`C  normal rect     no-fix EDIT(w 20->30) full=${c.ms.toFixed(1)}  dof=${dof(c.out)}  ok=${c.out.ok}`)
    console.log(`D  square+equal    FIXED  EDIT(20->30)   full=${d.ms.toFixed(1)}  dof=${dof(d.out)}  ok=${d.out.ok}`)
    console.log(`RAW one bare DogLeg solve of A          raw =${rawA.toFixed(1)}`)
    console.log('=================================================\n')
    /* eslint-enable no-console */

    // Sanity: A must actually resize to 30 (it is not silently reverting).
    if (a.out.ok) {
      const l0 = a.out.entities.find((e) => e.id === A.sideIds[0])
      const l1 = a.out.entities.find((e) => e.id === A.sideIds[1])
      if (l0?.kind === 'line' && l1?.kind === 'line') {
        const w = Math.hypot(l0.end.x - l0.start.x, l0.end.y - l0.start.y)
        const h = Math.hypot(l1.end.x - l1.start.x, l1.end.y - l1.start.y)
        // eslint-disable-next-line no-console
        console.log(`A resized to width=${w.toFixed(3)} height=${h.toFixed(3)} (square holds if both ~30)`)
        expect(w).toBeCloseTo(30, 3)
        expect(h).toBeCloseTo(30, 3)
      }
    }

    // The regression the user feels: square+equal (A) should NOT be
    // pathologically slower than the normal rectangle (C). Goes RED if it is.
    // (Generous 3x factor: we are catching a "several seconds" blowup, not
    // shaving milliseconds.)
    //
    // MEASURED RESULT (this machine): A ~= C (both ~2-3ms). GREEN. So the
    // ISOLATED single-square dimension edit is NOT the several-second lag: the
    // solve is fast, redundant==0, conflicting==0, no false-conflict re-solve,
    // no re-solve loop. Case D (corner FIXED, dof==0) collapses to ~0.2ms and
    // ONE internal solve — proving the cost of A/B/C is the dof>0-only work:
    // the per-entity DEFINITION DIAGNOSIS probe loop (gcsMapping.ts
    // diagnoseDefinedEntities, called at gcsMapping.ts:1029) which runs
    // N_entities+1 full solves per user solve. See the scaling test below for
    // where that reaches SECONDS.
    expect(a.ms).toBeLessThan(c.ms * 3 + 5)
  }, 60000)

  // Where the "several seconds" came from: the per-entity diagnosis probe loop
  // is O(N_entities) full solves, each itself growing with N, so the cost is
  // super-linear in sketch size. THE FIX (topology-keyed definedness cache in
  // gcsMapping): definedness is STRUCTURAL, so a VALUE EDIT on a fixed-topology
  // sketch reuses the cached result and skips the probe loop entirely. This
  // test measures, per size, the COLD first solve (fresh topology -> the probe
  // loop runs) vs a WARM value edit (same ids, changed dim values -> cache hit,
  // probe loop skipped) and asserts the warm value edit on a big sketch is a
  // small fraction of the cold cost — the several-second lag the user felt.
  it('value edit on a big sketch skips the probe loop (cold vs warm cache)', async () => {
    const wrapper = await getWrapper()
    let uid = 0
    // M dimensioned, under-defined (dof>0) squares -> the probe loop runs on a
    // cold solve. `tag` makes every id unique per build so a fresh build is
    // ALWAYS a topology miss (cold); mutating only dim values keeps the ids
    // (and thus the signature) identical -> a guaranteed warm hit.
    function multi(M: number, tag: string): Sketch {
      let n = 0
      const entities: Sketch['entities'] = []
      const constraints: SketchConstraint[] = []
      const dimensions: SketchDimension[] = []
      for (let m = 0; m < M; m++) {
        const commit = buildRectCommit(
          { x: m * 60, y: 0 }, { x: m * 60 + 20, y: 20 }, false,
          () => `${tag}_s${m}_${n++}`, true)
        entities.push(...commit.entities)
        constraints.push(...commit.constraints)
        const s0 = commit.entities[0].id
        dimensions.push({ id: `${tag}_d${m}`, kind: 'distance', driving: true, value: 30,
          a: ref(s0, 'start'), b: ref(s0, 'end') })
      }
      return { id: 'sk', layerId: 'layer', entities, constraints, dimensions, solveStatus: null }
    }
    const solveMs = (sk: Sketch): { ms: number; out: ReturnType<typeof solveSketchOnWrapper> } => {
      const t0 = performance.now()
      const out = solveSketchOnWrapper(wrapper, sk)
      return { ms: performance.now() - t0, out }
    }

    /* eslint-disable no-console */
    console.log('\n===== definedness cache: cold first-solve vs warm value-edit (ms) =====')
    let coldBig = 0
    let warmBig = 0
    for (const M of [1, 4, 8, 16]) {
      const cold = multi(M, `t${uid++}`)               // fresh topology -> MISS
      const c = solveMs(cold)                            // COLD: runs the probe loop
      const warm = { ...cold, dimensions: cold.dimensions.map((d) => ({ ...d, value: 40 })) }
      const w = solveMs(warm)                            // WARM: same topology -> HIT
      if (M === 16) { coldBig = c.ms; warmBig = w.ms }
      const defsEqual = c.out.ok && w.out.ok &&
        JSON.stringify([...(c.out.status.fullyDefinedEntities ?? [])].sort()) ===
        JSON.stringify([...(w.out.status.fullyDefinedEntities ?? [])].sort())
      console.log(`M=${M} entities=${M * 6}: COLD=${c.ms.toFixed(0)}ms  WARM(value-edit)=${w.ms.toFixed(0)}ms  ratio=${(c.ms / Math.max(w.ms, 0.01)).toFixed(1)}x  definedness-identical=${defsEqual}`)
    }
    console.log(`=> value edit on ${16 * 6} entities: cold=${coldBig.toFixed(0)}ms -> warm=${warmBig.toFixed(0)}ms`)
    console.log('=====================================================================\n')
    /* eslint-enable no-console */

    // The fix: a value edit on the big sketch (same topology) is now a small
    // fraction of the cold first-solve cost — the probe loop is skipped.
    // (Half is a very loose gate for a several-seconds -> few-ms collapse;
    // keeps it honest without being flaky on timing.)
    expect(warmBig).toBeLessThan(coldBig * 0.5)
  }, 120000)
})
