// pattern2d types - scripted decorative pattern library (WO-2982, WO-2962 PLAN Phase A).
//
// A pattern is DATA, never code: a list of curves written as expressions in the
// existing params grammar (src/doc/params, no eval), a depth, and a list of
// similarity transforms. buildPatternToolpath() turns it into ordinary
// ToolpathMove[] so the preview, simulator and posts apply unchanged.
//
// Units rule (PLAN sec. 5): `units` scales LENGTH fields only - anchor x/y,
// translate dx/dy, a numeric depth, chordTol and every param marked
// `length: true`. Ratios and counts never scale. Every expression is evaluated
// in mm (an `in` literal inside an expression keeps the parser's own
// conversion), so curve outputs x, y, r and a depth expression are mm.
//
// The curve parameter `t` is in DEGREES because the params evaluator's trig
// takes degrees (one turn = 360).

import type { FeedrateOverride, HeightParams, Tool, ToolpathMove, Vec3 } from '../../../types'

export type PatternUnits = 'mm' | 'in'

export interface PatternParam {
  name: string
  value: number
  /** true: a length, converted from `units` to mm; false: a ratio or count. */
  length: boolean
}

export type PatternTransform =
  | { kind: 'translate'; dx: number; dy: number }
  | { kind: 'rotate'; deg: number }
  | { kind: 'scale'; s: number }
  /** axis 'x' mirrors across the X axis (y -> -y); 'y' across the Y axis (x -> -x). */
  | { kind: 'mirror'; axis: 'x' | 'y' }
  /** `count` copies about the pattern-frame origin, `deg` apart (default 360/count). */
  | { kind: 'polar-array'; count: number; deg?: number }

export type PatternPresetName = 'rose-spiral' | 'sine-raster' | 'epitrochoid' | 'line-moire'

export type PatternCurve =
  | { kind: 'polar'; r: string; t: [number, number]; params?: PatternParam[]; transforms?: PatternTransform[] }
  | { kind: 'xy'; x: string; y: string; t: [number, number]; params?: PatternParam[]; transforms?: PatternTransform[] }
  | { kind: 'preset'; name: PatternPresetName; params: Record<string, number>; transforms?: PatternTransform[] }

export interface PatternSpec {
  version: 1
  units: PatternUnits
  /** Pattern frame origin in the setup WCS. */
  anchor: 'region-centroid' | 'wcs-origin' | { x: number; y: number }
  /** Cut in order, linked at the operation's retract height. */
  curves: PatternCurve[]
  /** Positive distance below the region top. An expression may use x, y (tool
   *  centre relative to the setup WCS origin, mm) and t. */
  depth: number | { expr: string }
  /** Max distance of the emitted polyline from the true curve. Default 0.005 mm. */
  chordTol?: number
  /** 'region' trims curve parts whose cut footprint leaves the region. Default 'none'. */
  clip?: 'none' | 'region'
}

/** Machine bounds the pattern is reported against (C6, C7). Absent = not stated:
 *  nothing is measured against it. */
export interface PatternMachineLimits {
  maxCuttingFeed?: number   // mm/min
  minSpindleRpm?: number
  maxSpindleRpm?: number
}

/** Everything buildPatternToolpath needs. Defined here so Phase A compiles alone;
 *  Phase B re-exports it from src/lib/cam/types.ts. */
export interface PatternWorkerPayload {
  /** Raw spec as stored on the operation; validated by parsePatternSpec. */
  spec: unknown
  tool: Tool
  heights: HeightParams
  wcsOrigin: Vec3
  feedrateOverride?: FeedrateOverride
  /** Region as world-XY closed loops (even-odd: an inner loop is a hole).
   *  Empty when the operation has no region (C1 and clip are then not measured). */
  region: Array<Array<{ x: number; y: number }>>
  spindleRpm?: number
  machine?: PatternMachineLimits
}

/** What the builder measured. Every length in mm. */
export interface PatternMetrics {
  samples: number
  runs: number
  cutLengthMm: number
  /** Widest cut footprint (2 x half-width at the deepest point). */
  grooveWidth: number
  /** Smallest (region-inside distance - footprint half-width) over every cut
   *  point; negative = the footprint crosses the region edge. null = no region. */
  containmentMargin: number | null
  /** Smallest centre distance between two distinct passes; null = none within
   *  the search radius (passes are far apart). */
  minTurnGap: number | null
  /** minTurnGap minus the two footprint half-widths; negative = grooves merge. */
  minRidge: number | null
}

export interface PatternToolpathResult {
  moves: ToolpathMove[]
  /** One line each, operator-facing: what was made, plus anything surprising
   *  the software did as written (Rule 11). */
  notes: string[]
  metrics: PatternMetrics
}
