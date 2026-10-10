// SPDX-License-Identifier: LGPL-2.1-or-later
// Ported from FreeCAD's Adaptive2d (src/Mod/CAM/libarea/Adaptive.cpp and Path Adaptive Python), Copyright (c) 2018 Kresimir Tusek.
// This file remains under LGPL-2.1-or-later; the LienCAM project as a whole is distributed under GPL-3.0-or-later (see /LICENSE).
// Per-step steering: find the deflection angle that holds the target cutting load.
// Port of FreeCAD ProcessFeature.findNextPoint (+ its deflectionAngleHistory momentum).
//
// Each call rotates the current heading by a search-chosen deflection, steps by
// `step`, and measures the resulting cut-area-per-distance. It searches (via the
// interpolator) for the deflection whose measured load is within `maxError` of the
// target, accepting the best within `maxIterations`. The accepted deflection feeds a
// short history whose average seeds the next step's first guess (momentum) -- this is
// what makes the path's curvature vary gradually instead of jittering.

import type { Pt, Loops } from './clipperEngine'
import type { ToolGeometry } from './toolGeometry'
import { rotate, normalize, add, scale } from './geom'
import { createInterpolator, type Interpolator } from './interpolation'

export interface StepResult {
  toolPos: Pt
  toolDir: Pt
  area: number
  areaPerDist: number
  deflectionAngle: number
  hitIterationLimit: boolean
}

export interface ProbeRecord {
  angle: number
  area: number
  areaPerDist: number
  sideBalance: number
}

/** Detached observations: callbacks cannot mutate the chosen move or momentum history. */
export interface StepDecision {
  from: Pt
  dir: Pt
  step: number
  target: number
  maxError: number
  predictedAngle: number
  probes: ProbeRecord[]
  acceptedIndex: number
  hitIterationLimit: boolean
}

export interface StepperOptions {
  maxDeflection?: number   // per-step curvature clamp (rad); FreeCAD pi/4
  maxIterations?: number   // search budget per step; FreeCAD 12
  maxErrorRel?: number     // accept band as a fraction of target load
  maxErrorAbs?: number     // additive accept band (load units, mm^2/mm)
  historyLen?: number      // momentum window; FreeCAD 10
  /** Load setpoint: the symmetric load search aims at `loadSetpoint * target` instead of
   *  `target`. < 1 biases the held cutting load just under optimal so realized load stays
   *  AT/under optimal smoothly (the accept band is symmetric, so aiming exactly at optimal
   *  let ~40% of steps land above it). Default 0.95. Set 1 to disable the shift. */
  loadSetpoint?: number
  /** Measurement only; omitted by production callers. Runs after the search has chosen. */
  onDecision?: (decision: StepDecision) => void
}

export interface Stepper {
  /** Reset the momentum history (call at the start of each pass). */
  resetHistory(): void
  /** One adaptive step from (toolPos,toolDir) holding `targetAreaPerDist` against `cleared`. */
  findNextPoint(cleared: Loops, toolPos: Pt, toolDir: Pt, step: number, targetAreaPerDist: number): StepResult
}

export function createStepper(tool: ToolGeometry, opts: StepperOptions = {}): Stepper {
  const maxDeflection = opts.maxDeflection ?? Math.PI / 4
  const maxIterations = opts.maxIterations ?? 12
  const maxErrorRel = opts.maxErrorRel ?? 0.05
  const maxErrorAbs = opts.maxErrorAbs ?? 0
  const historyLen = opts.historyLen ?? 10
  const loadSetpoint = opts.loadSetpoint ?? 0.95

  const interp: Interpolator = createInterpolator(maxDeflection)
  let history: number[] = []

  function resetHistory() { history = [] }

  function predicted(): number {
    if (history.length === 0) return 0
    let s = 0
    for (const a of history) s += a
    return s / history.length
  }

  function findNextPoint(cleared: Loops, toolPos: Pt, toolDir: Pt, step: number, targetAreaPerDist: number): StepResult {
    interp.reset()
    const predictedAngle = predicted()
    // Setpoint shift: the symmetric search aims just under optimal so realized load holds
    // AT/under optimal (aiming exactly at optimal let the symmetric band overshoot ~40% of
    // steps). Search/accept logic below is unchanged -- only the target it centres on moves.
    targetAreaPerDist *= loadSetpoint
    const maxError = maxErrorRel * targetAreaPerDist + maxErrorAbs
    const probes: ProbeRecord[] | undefined = opts.onDecision ? [] : undefined
    const observe = (angle: number, area: number, apd: number, overLimit: boolean) => {
      if (!probes) return
      opts.onDecision?.({
        from: { ...toolPos }, dir: { ...toolDir }, step,
        target: targetAreaPerDist, maxError, predictedAngle, probes,
        acceptedIndex: area <= 0 && overLimit
          ? probes.length - 1
          : probes.findIndex(p => p.angle === angle && p.area === area && p.areaPerDist === apd),
        hitIterationLimit: overLimit,
      })
    }

    let iteration = 0
    // Best CUTTING sample seen so far (area > 0, minimal load error). When the search
    // exhausts its iteration budget we return THIS rather than the last probe -- the
    // last probe is often a random angle getNextAngle threw out, which may cut nothing
    // even though a good move was found earlier. Returning the last probe was making
    // passes quit prematurely with cuttable material still adjacent (the SquareIsland /
    // "should have continued" failure).
    let bestCut: { pos: Pt; dir: Pt; area: number; apd: number; angle: number; err: number } | null = null

    const accept = (pos: Pt, dir: Pt, area: number, apd: number, angle: number, overLimit: boolean): StepResult => {
      history.push(angle)
      if (history.length > historyLen) history.shift()
      observe(angle, area, apd, overLimit)
      return { toolPos: pos, toolDir: normalize(dir), area, areaPerDist: apd, deflectionAngle: angle, hitIterationLimit: overLimit }
    }

    for (;;) {
      iteration++
      const { angle } = interp.getNextAngle(iteration, targetAreaPerDist, predictedAngle, maxIterations)
      const tryDir = rotate(toolDir, angle)
      const tryPos = add(toolPos, scale(tryDir, step))
      const { area, areaPerDist, sideBalance } = tool.cutArea(toolPos, tryPos, cleared)
      probes?.push({ angle, area, areaPerDist, sideBalance })
      const error = areaPerDist - targetAreaPerDist

      const absErr = Math.abs(error)
      if (area > 0 && (bestCut === null || absErr < bestCut.err)) {
        bestCut = { pos: tryPos, dir: tryDir, area, apd: areaPerDist, angle, err: absErr }
      }

      if (absErr < maxError) {
        // good enough -> take this move directly
        return accept(tryPos, tryDir, area, areaPerDist, angle, false)
      }

      if (iteration > maxIterations) {
        // budget exhausted -> prefer the best cutting move found over the last probe
        if (bestCut) return accept(bestCut.pos, bestCut.dir, bestCut.area, bestCut.apd, bestCut.angle, true)
        // nothing cut in any sampled direction -> genuine no-cut
        observe(angle, area, areaPerDist, true)
        return { toolPos: tryPos, toolDir: normalize(tryDir), area, areaPerDist, deflectionAngle: angle, hitIterationLimit: true }
      }

      interp.addPoint(areaPerDist, angle)
    }
  }

  return { resetHistory, findNextPoint }
}
