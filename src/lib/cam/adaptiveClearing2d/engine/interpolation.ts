// SPDX-License-Identifier: LGPL-2.1-or-later
// Ported from FreeCAD's Adaptive2d (src/Mod/CAM/libarea/Adaptive.cpp and Path Adaptive Python), Copyright (c) 2018 Kresimir Tusek.
// This file remains under LGPL-2.1-or-later; the LienCAM project as a whole is distributed under GPL-3.0-or-later (see /LICENSE).
// The angle<->area interpolation table that steers each adaptive step.
// Direct port of FreeCAD's Interpolation.py.
//
// Per step the engine must pick the tool deflection angle whose resulting cut-area-
// per-distance equals the target load. This module samples (area, angle) pairs the
// caller measures and predicts the angle for the target area by linear interpolation
// (or a degree-1 least-squares fit when the target lies outside the sampled range).
// The deflection is clamped to +-maxDeflection -- the per-step curvature limit.

export interface Interpolator {
  reset(): void
  /** Predict/probe the next deflection angle to try for `targetArea`. */
  getNextAngle(iteration: number, targetArea: number, predictedAngle: number, maxIterations: number): { angle: number; clamped: boolean }
  /** Record a measured (area, angle) sample, keeping `areas` ascending. */
  addPoint(area: number, angle: number): void
  readonly nPoints: number
}

/** Linear interpolation of y at x given ascending xs (np.interp semantics). */
function interp(x: number, xs: number[], ys: number[]): number {
  if (x <= xs[0]) return ys[0]
  if (x >= xs[xs.length - 1]) return ys[ys.length - 1]
  for (let i = 1; i < xs.length; i++) {
    if (x <= xs[i]) {
      const t = (x - xs[i - 1]) / (xs[i] - xs[i - 1])
      return ys[i - 1] + t * (ys[i] - ys[i - 1])
    }
  }
  return ys[ys.length - 1]
}

/** Mulberry32 -- tiny seeded PRNG. CAM toolpaths must be reproducible run-to-run, so the
 *  FreeCAD-style random probe angles below use a fixed-seed PRNG instead of Math.random.
 *  Each interpolator instance gets its own generator from the same constant seed, so the
 *  output is deterministic regardless of how many interpolators a run creates or in what
 *  order they are consulted. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), a | 1)
    t = (t + Math.imul(t ^ (t >>> 7), t | 61)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Fixed probe seed (golden-ratio constant); see mulberry32 note on determinism. */
const PROBE_SEED = 0x9E3779B9

/** Evaluate a degree-1 least-squares fit y(x) through all (xs,ys) at `x`
 *  (np.poly1d(np.polyfit(xs,ys,1))(x)). Falls back to a flat line if x has no spread. */
function polyfit1(x: number, xs: number[], ys: number[]): number {
  const n = xs.length
  let sx = 0, sy = 0
  for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i] }
  const mx = sx / n, my = sy / n
  let num = 0, den = 0
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx; num += dx * (ys[i] - my); den += dx * dx }
  if (den === 0) return my
  const slope = num / den
  return my + slope * (x - mx)
}

export function createInterpolator(maxDeflection = Math.PI / 4): Interpolator {
  let angles: number[] = []
  let areas: number[] = []
  const lo = -maxDeflection
  const hi = maxDeflection
  const rand = mulberry32(PROBE_SEED) // per-instance, fixed seed: deterministic probes

  function reset() { angles = []; areas = [] }

  function randInRange(): number {
    return lo + 1e-8 + (hi - lo) * rand()
  }

  function getNextAngle(iteration: number, targetArea: number, predictedAngle: number, maxIterations: number): { angle: number; clamped: boolean } {
    let angle: number
    if (iteration === 1) {
      angle = predictedAngle // most cuts hold a near-constant angle; try it first
    } else if (iteration === 2) {
      angle = lo // bracket: maximum deflection one way
    } else if (iteration === 4) {
      angle = hi // bracket: maximum deflection the other way
    } else if (areas.length < 2) {
      angle = randInRange() // not enough samples to interpolate yet
    } else if (iteration > 6 && iteration < maxIterations - 1 && iteration % 3 === 0) {
      angle = randInRange() // occasionally probe to enrich the sample set
    } else if (targetArea < areas[0] || targetArea > areas[areas.length - 1]) {
      angle = polyfit1(targetArea, areas, angles) // target outside samples -> extrapolate
    } else {
      angle = interp(targetArea, areas, angles) // target bracketed -> interpolate
    }

    let clamped = false
    if (angle < lo) { angle = lo; clamped = true }
    if (angle > hi) { angle = hi; clamped = true }
    return { angle, clamped }
  }

  function addPoint(area: number, angle: number): void {
    if (areas.length === 0) { angles.push(angle); areas.push(area); return }
    if (area > areas[areas.length - 1]) { angles.push(angle); areas.push(area); return }
    for (let i = 0; i < areas.length; i++) {
      if (area < areas[i]) { angles.splice(i, 0, angle); areas.splice(i, 0, area); return }
      if (area === areas[i]) return // duplicate sample, ignore
    }
  }

  return {
    reset,
    getNextAngle,
    addPoint,
    get nPoints() { return areas.length },
  }
}
