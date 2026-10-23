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

// WO-3018: every sampling, steering, sharpening and cap number comes from the policy record.
import { ADAPTIVE_POLICY as AP } from '../../../../kernel/ops/adaptive/policy'
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
  /** No candidate cut honored materialSide; the tool stays at its original position. */
  blockedByMillingSide?: boolean
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
  /** No candidate cut honored materialSide; the tool stays at its original position. */
  blockedByMillingSide?: boolean
}

export interface StepperOptions {
  /** Required dominant physical cutting flank in the planner's clockwise-spindle frame. */
  materialSide?: 'left' | 'right'
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
  /** WO-3042 cause B (ADAPTIVE_MOTION_SWITCHES.steeringSmoothing; omitted = today's stepper, to the
   *  bit): the first guess is the momentum plus `gain` x the turn that, along this pass's last measured
   *  load-per-turn slope, would bring the last accepted load to this step's target, at most
   *  `maxCorrection` rad. Today's stepper keeps any first guess inside the accept band, so the load
   *  drifts to a band edge and one search kink corrects it, then it drifts out the other side.
   *  The guess is still probed and accepted only inside the band, like any guess. */
  smoothing?: { gain: number; maxCorrection: number }
  /** Measurement only; omitted by production callers. Runs after the search has chosen. */
  onDecision?: (decision: StepDecision) => void
}

export interface Stepper {
  /** Reset the momentum history (call at the start of each pass). */
  resetHistory(): void
  /** One adaptive step from (toolPos,toolDir) holding `targetAreaPerDist` against `cleared`. */
  findNextPoint(cleared: Loops, toolPos: Pt, toolDir: Pt, step: number, targetAreaPerDist: number): StepResult
  /** WO-3042 cause C: the caller replaced the last accepted move with its own (a departure clamp);
   *  `deflection` is that move's turn from the heading the last findNextPoint was handed and `load` its
   *  measured load. The momentum history (and, with `smoothing`, the load the next first guess corrects
   *  from) keeps it in place of the stepper's own. A no-op when the last call accepted no move. */
  recordTakenDeflection(deflection: number, load: number): void
}

// A frontal bite cuts both flanks; polygon faceting also perturbs a symmetric
// split. Treat 40/60 through 60/40 as mixed engagement (the WO-1227 diagnostic
// deadband), and reject only a clearly dominant cut on the opposite flank.
const MILLING_SIDE_DEADBAND = AP.steering.millingSideDeadband

export function createStepper(tool: ToolGeometry, opts: StepperOptions = {}): Stepper {
  const maxDeflection = opts.maxDeflection ?? Math.PI / AP.steering.maxDeflectionDivisor
  const maxIterations = opts.maxIterations ?? AP.steering.maxIterations
  const maxErrorRel = opts.maxErrorRel ?? AP.steering.maxErrorRel
  const maxErrorAbs = opts.maxErrorAbs ?? 0
  const historyLen = opts.historyLen ?? AP.steering.historyLen
  const loadSetpoint = opts.loadSetpoint ?? AP.steering.loadSetpoint

  const interp: Interpolator = createInterpolator(maxDeflection)
  let history: number[] = []
  // WO-3042 cause B (smoothing only): this pass's last measured d(load)/d(deflection) near an
  // accepted angle, and the load the last accepted move measured.
  let loadSlope = 0
  let lastLoad = NaN
  // Whether the last findNextPoint call accepted a move (pushed a history entry).
  let lastAccepted = false

  function resetHistory() { history = []; loadSlope = 0; lastLoad = NaN }

  function recordTakenDeflection(deflection: number, load: number) {
    if (!lastAccepted) return
    history[history.length - 1] = deflection
    if (opts.smoothing) lastLoad = load
  }

  /** Cause B: learn the load-per-turn slope from this step's cutting probes nearest the accepted one. */
  function learnSlope(angle: number, apd: number, cuts: { angle: number; apd: number }[]) {
    let near: { angle: number; apd: number } | null = null
    for (const c of cuts) {
      if (Math.abs(c.angle - angle) < 1e-9) continue
      if (!near || Math.abs(c.angle - angle) < Math.abs(near.angle - angle)) near = c
    }
    if (near) {
      const s = (near.apd - apd) / (near.angle - angle)
      if (Number.isFinite(s) && s !== 0) loadSlope = s
    }
    lastLoad = apd
  }

  function predicted(): number {
    if (history.length === 0) return 0
    let s = 0
    for (const a of history) s += a
    return s / history.length
  }

  function findNextPoint(cleared: Loops, toolPos: Pt, toolDir: Pt, step: number, targetAreaPerDist: number): StepResult {
    interp.reset()
    lastAccepted = false
    // Setpoint shift: the symmetric search aims just under optimal so realized load holds
    // AT/under optimal (aiming exactly at optimal let the symmetric band overshoot ~40% of
    // steps). Search/accept logic below is unchanged -- only the target it centres on moves.
    targetAreaPerDist *= loadSetpoint
    let predictedAngle = predicted()
    const smoothing = opts.smoothing
    if (smoothing && loadSlope !== 0 && Number.isFinite(lastLoad)) {
      const correction = smoothing.gain * (targetAreaPerDist - lastLoad) / loadSlope
      predictedAngle += Math.max(-smoothing.maxCorrection, Math.min(smoothing.maxCorrection, correction))
    }
    const maxError = maxErrorRel * targetAreaPerDist + maxErrorAbs
    const probes: ProbeRecord[] | undefined = opts.onDecision ? [] : undefined
    const cuts: { angle: number; apd: number }[] = []
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
    let sawWrongSideCut = false
    let bestCut: { pos: Pt; dir: Pt; area: number; apd: number; angle: number; err: number } | null = null

    const accept = (pos: Pt, dir: Pt, area: number, apd: number, angle: number, overLimit: boolean): StepResult => {
      history.push(angle)
      lastAccepted = true
      if (history.length > historyLen) history.shift()
      if (smoothing) learnSlope(angle, apd, cuts)
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
      if (smoothing && area > 0) cuts.push({ angle, apd: areaPerDist })
      const error = areaPerDist - targetAreaPerDist

      const sideAllowed = !opts.materialSide || area <= 0
        || (opts.materialSide === 'left' ? sideBalance >= -MILLING_SIDE_DEADBAND : sideBalance <= MILLING_SIDE_DEADBAND)
      if (area > 0 && !sideAllowed) sawWrongSideCut = true
      const absErr = Math.abs(error)
      if (area > 0 && sideAllowed && (bestCut === null || absErr < bestCut.err)) {
        bestCut = { pos: tryPos, dir: tryDir, area, apd: areaPerDist, angle, err: absErr }
      }

      if (sideAllowed && absErr < maxError) {
        // good enough -> take this move directly
        return accept(tryPos, tryDir, area, areaPerDist, angle, false)
      }

      if (iteration > maxIterations) {
        // budget exhausted -> prefer the best cutting move found over the last probe
        if (bestCut) return accept(bestCut.pos, bestCut.dir, bestCut.area, bestCut.apd, bestCut.angle, true)
        if (sawWrongSideCut) {
          // No admissible cutting heading was found. End this pass at its actual
          // position; never emit the rejected cut with an air/no-cut label.
          if (probes) opts.onDecision?.({
            from: { ...toolPos }, dir: { ...toolDir }, step,
            target: targetAreaPerDist, maxError, predictedAngle, probes,
            acceptedIndex: -1, hitIterationLimit: true, blockedByMillingSide: true,
          })
          return { toolPos, toolDir, area: 0, areaPerDist: 0, deflectionAngle: 0,
            hitIterationLimit: true, blockedByMillingSide: true }
        }
        // nothing cut in any sampled direction -> genuine no-cut
        observe(angle, area, areaPerDist, true)
        return { toolPos: tryPos, toolDir: normalize(tryDir), area, areaPerDist, deflectionAngle: angle, hitIterationLimit: true }
      }

      interp.addPoint(areaPerDist, angle)
    }
  }

  return { resetHistory, findNextPoint, recordTakenDeflection }
}
