// WO-1901: NO ADAPTIVE PASS SPIRALS DOWN BESIDE STANDING MATERIAL TO REACH A WALL RING.
//
// Operator ruling 2026-09-23: "we should NEVER be helixing into a corner for cleanup. We have talked
// about this many times and have fixed it multiple times... Get this fixed and ensure it
// doesn't return."
//
// WHAT IS COUNTED, and why it is exactly the defect. cam3d's emitter draws a helix in two
// places, and they are distinguishable in the emitted stream without any stock model:
//
//   - A REGION ENTRY (rough/emit.ts, case 'entry'): the tool spirals down to open a fresh
//     region and the LAST ramp move is still on the helix circle -- the mandatory full turn
//     at the floor ends where the cutting starts.
//   - A LIFT-AND-LAND RE-ENTRY (rough/emit.ts, case 'link', WO-400): the planner asked to
//     drop straight in at a landing point, the LIVE carved stock said that shaft is not
//     clear, so the emitter spirals down BESIDE the landing and then feeds across to it.
//     That last feed is a single ramp-role move at depth, OFF the helix circle. Its
//     existence is the emitter saying, in its own words, "there was material where I was
//     asked to descend" -- which is precisely "helixing beside standing material".
//
// So a run of ramp moves whose final point sits off its own circle IS a re-entry beside
// standing material, and this test pins how many of them every adaptive benchmark row has.
// The engagement pocket's two chambers used to contribute 6 (2 per level x 3): the wall
// ring of each chamber was ridden only after the whole walk, so the tool lifted out of one
// chamber, flew back to the other, and spiralled down next to the corner its clearing
// passes could not reach. It rides each chamber's ring in place now, at depth.
//
// A LIFT-AND-LAND HELIX IS NOT ALWAYS WRONG -- it is the emitter's honest last rung when
// nothing else fits. The pins below are today's measured counts, not a target: raising one
// means some change put the tool back into a corner and must be explained; lowering one is
// an improvement and the pin is re-taken deliberately.
//
// Only the adaptive steps of each chain are planned (the parallel/pencil finishing steps
// emit no helix and cost minutes). Every adaptive benchmark row in the registry is
// covered; there are no 2D-adaptive benchmark rows -- the 2D engine's own corpus is the
// nine gt fixtures pinned byte-for-byte by
// src/tests/adaptive-clearing/engine/_bytestab-fingerprint.test.ts.
import { describe, expect, it } from 'vitest'

import { planChain } from '../benchmark/chainRunner'
import { CHAINS, type BenchmarkChain } from '../benchmark/registry'
import type { ToolpathMove } from '../../types'

/** Fewest ramp moves that can be a helix: emit draws 24 straight segments per turn. */
const MIN_HELIX_MOVES = 8
/** How far off its own circle a ramp move has to sit to be the at-depth landing feed. */
const OFF_CIRCLE_MM = 0.05

interface HelixRun {
  readonly startIndex: number
  readonly z: number
  readonly centre: { x: number; y: number }
  readonly radius: number
  /** True = a WO-400 lift-and-land re-entry (spiralled beside the requested landing). */
  readonly landsOffCircle: boolean
}

function helixRuns(moves: readonly ToolpathMove[]): HelixRun[] {
  const runs: HelixRun[] = []
  let i = 0
  while (i < moves.length) {
    if (moves[i].type !== 'feed' || moves[i].role !== 'ramp') { i++; continue }
    let j = i
    while (j < moves.length && moves[j].type === 'feed' && moves[j].role === 'ramp') j++
    if (j - i >= MIN_HELIX_MOVES) {
      // Fit the circle on every ramp move BUT the last: a lift-and-land run's final move is
      // the feed across to the landing, and letting it into the fit would hide itself.
      const circle = moves.slice(i, j - 1)
      const xs = circle.map((m) => m.x)
      const ys = circle.map((m) => m.y)
      const centre = {
        x: (Math.min(...xs) + Math.max(...xs)) / 2,
        y: (Math.min(...ys) + Math.max(...ys)) / 2,
      }
      const radius = (Math.max(...xs) - Math.min(...xs)) / 2
      const last = moves[j - 1]
      const off = Math.abs(Math.hypot(last.x - centre.x, last.y - centre.y) - radius)
      runs.push({
        startIndex: i,
        z: last.z,
        centre,
        radius,
        landsOffCircle: radius > OFF_CIRCLE_MM && off > OFF_CIRCLE_MM,
      })
    }
    i = j
  }
  return runs
}

/** Today's honest counts, measured on this branch 2026-09-23:
 *  reentries = WO-400 lift-and-land helices (EXACT -- the defect; every row is at zero),
 *  helices   = every helix the row draws (a CEILING -- region entries are legitimate, so
 *              drawing fewer is fine and drawing more has to be explained). */
const PINNED: Record<string, { readonly reentries: number; readonly helices: number }> = {
  'feature-block-mesh-rough-finish/rough-6-flat': { reentries: 0, helices: 7 },
  'feature-block-step-rough-finish/rough-6-flat': { reentries: 0, helices: 7 },
  'engagement-pocket-rest-pencil/rough-6-flat': { reentries: 0, helices: 6 },
  'engagement-pocket-rest-pencil/rest-rough-4-flat': { reentries: 0, helices: 4 },
  'engagement-pocket-rough-finish/rough-6-flat': { reentries: 0, helices: 6 },
  'stepped-boss-rough-finish/rough-6-flat': { reentries: 0, helices: 5 },
  'boss-taper-step-rough-finish/rough-6-flat': { reentries: 0, helices: 3 },
}

/** The chain with only its adaptive steps: nothing else in a chain emits a helix. */
function adaptiveOnly(chain: BenchmarkChain): BenchmarkChain {
  return { ...chain, steps: chain.steps.filter((step) => step.type.startsWith('adaptive')) }
}

describe('WO-1901 adaptive rides each region wall ring in place', () => {
  it('no adaptive benchmark row gains a helical re-entry beside standing material', async () => {
    const chains = CHAINS.filter((chain) => chain.steps.some((step) => step.type.startsWith('adaptive')))
    const observed: Record<string, { reentries: number; helices: number }> = {}
    for (const chain of chains) {
      const planned = await planChain(adaptiveOnly(chain))
      for (const step of planned.steps) {
        const runs = helixRuns(step.moves)
        observed[`${chain.id}/${step.stepId}`] = {
          reentries: runs.filter((r) => r.landsOffCircle).length,
          helices: runs.length,
        }
      }
    }
    // Every registry row is covered: a row that vanishes from the plan is a silent hole.
    expect(Object.keys(observed).sort()).toEqual(Object.keys(PINNED).sort())
    const reentries = Object.fromEntries(
      Object.entries(observed).map(([key, row]) => [key, row.reentries]),
    )
    expect(reentries).toEqual(
      Object.fromEntries(Object.entries(PINNED).map(([key, row]) => [key, row.reentries])),
    )
    for (const [key, row] of Object.entries(observed)) {
      expect(row.helices, `${key} draws more helices than the pin`).toBeLessThanOrEqual(PINNED[key].helices)
    }
  }, 1_200_000)
})
