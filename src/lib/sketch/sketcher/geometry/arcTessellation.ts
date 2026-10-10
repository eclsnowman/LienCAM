// WO SKC-14 (BK-88, DECISIONS 2026-07-10 "SKC-12 audit major HELD"): THE arc tessellator.
//
// Before this module the repo walked an arc's sweep in FOUR places -- arcTools.tessellateArc
// (preview), sketchLayer.tessellateArc (canvas render), filletTool's private tessellateArc
// (fillet ghosts) and sketch3d-shared/geometry2d.sampleArcPoints (workbench outline). All four
// implemented the SAME walk (`startAngle + sweep * i / n`, CCW) and differed only in how many
// segments they chose. Four walks meant four chances to disagree about what `endAngle` means --
// the exact bug class SKC-12 closed for CONSTRUCTION and left open for RENDERING (the held
// major: the two-tessellators property test could only prove point-identity for 60-300deg
// sweeps, because the minimum-segment policies diverged outside that band).
//
// The structural fix (critic's law, docs/3d/SKETCH-CRITIC-REPORT.md: "divergence is hard only
// when there is no file in which a second version could be written"): the WALK lives here, once.
// Callers supply a DENSITY POLICY and nothing else. There is no file in which a second sweep
// walk could live without the capability scan
// (src/tests/sketch/oneArcTessellator.test.ts) going red.
//
// Sweep convention: document arcs sweep COUNTERCLOCKWISE from startAngle to endAngle
// (src/lib/sketch/types.ts canonical winding, made the ONLY encoding by SKC-12/S1).
import type { Vec2 } from '../../types'

export const TWO_PI = Math.PI * 2

export interface ArcGeometry {
  center: Vec2
  radius: number
  startAngle: number
  endAngle: number
}

/** Evaluate one point on an arc's supporting circle at `angle`.
 *  Arc parameterization lives here with the canonical sweep walk so callers
 *  cannot grow a second center/radius/cos/sin implementation. */
export function arcPointAtAngle(
  arc: Pick<ArcGeometry, 'center' | 'radius'>,
  angle: number,
): Vec2 {
  return {
    x: arc.center.x + arc.radius * Math.cos(angle),
    y: arc.center.y + arc.radius * Math.sin(angle),
  }
}

/** How many segments to spend on an arc. The three policies below are the three
 *  that existed in the tree before this module; each caller keeps the one it had,
 *  so collapsing the walk changed no rendered geometry. */
export type ArcDensity =
  /** Flat samples-per-full-turn with a floor. Preview + workbench outline. */
  | { kind: 'perTurn'; samplesPerTurn: number; minSegments: number }
  /** Adaptive by radius so chord error <= toleranceMm. Canvas render. */
  | { kind: 'chordTolerance'; toleranceMm: number; minSegments: number; maxSegments: number }
  /** Adaptive by arc LENGTH so no chord exceeds maxChordMm. Ghost outlines. */
  | { kind: 'chordLength'; maxChordMm: number; minSegments: number }
  /** A constant segment count regardless of size. Dimension guide arcs. */
  | { kind: 'fixed'; segments: number }

/** Preview + outline density: 64 samples per turn, never fewer than 8 segments.
 *  Shared by arcTools.tessellateArc and sketch3d's sampleArcPoints -- which is
 *  precisely what lets the arcCanonical property test assert FULL-RANGE point
 *  agreement (BK-88) instead of the old 60-300deg filtered band. */
export const PREVIEW_ARC_DENSITY: ArcDensity = {
  kind: 'perTurn',
  samplesPerTurn: 64,
  minSegments: 8,
}

/** Canvas-render density: chord error <= 0.02mm, clamped to [12, 256] segments. */
export const RENDER_ARC_DENSITY: ArcDensity = {
  kind: 'chordTolerance',
  toleranceMm: 0.02,
  minSegments: 12,
  maxSegments: 256,
}

/** Ghost/outline arc density: no chord longer than 0.5mm, never fewer than 8 segments.
 *  Shared by filletTool's staged-corner ghosts and toolOverlay.entityOutline. */
export const GHOST_ARC_DENSITY: ArcDensity = {
  kind: 'chordLength',
  maxChordMm: 0.5,
  minSegments: 8,
}

/** Ghost/outline CIRCLE density: same chord budget, but a 16-segment floor so a
 *  small ghosted circle still reads as round (toolOverlay.entityOutline). */
export const GHOST_CIRCLE_DENSITY: ArcDensity = {
  kind: 'chordLength',
  maxChordMm: 0.5,
  minSegments: 16,
}

/** Angle-dimension guide arc: a fixed 48 segments whatever the radius
 *  (dimPlacement's two-line angle preview). */
export const DIM_GUIDE_ARC_DENSITY: ArcDensity = { kind: 'fixed', segments: 48 }

/** The CCW sweep from startAngle to endAngle, normalized into [0, 2*PI].
 *
 *  Two distinct inputs normalize to zero under a plain modulo and MUST NOT be
 *  conflated -- the six pre-SKC-14 implementations disagreed here, and collapsing
 *  them the wrong way is a real, user-visible behaviour change:
 *
 *   - A NONZERO raw delta that is an exact multiple of a full turn (e.g.
 *     SolidsWorkbenchPage's `{startAngle: 0, endAngle: 2*PI}` full-circle-via-
 *     arc-sampler convenience) means a FULL TURN. A plain modulo sends it to 0
 *     and the circle silently vanishes.
 *   - A raw delta of EXACTLY zero is a genuinely degenerate arc: sweep 0. The
 *     `arc-center` preview reaches this every time the cursor crosses the start
 *     ray (arcTools.arcPreview:296 derives endAngle straight from the cursor),
 *     and it must keep previewing nothing rather than flashing a full circle.
 *
 *  This is `geometry2d.sampleArcPoints`'s original rule, which was the precise
 *  one. sketchLayer / filletTool / toolOverlay each mapped a zero raw delta to a
 *  full turn instead -- but only as a DEFENSIVE branch for an input their own
 *  type invariant forbids (a canonical arc entity never has
 *  startAngle === endAngle, src/lib/sketch/types.ts:46-50), so preferring the
 *  precise rule here moves no rendered geometry.
 */
export function arcSweepCcw(startAngle: number, endAngle: number): number {
  const raw = endAngle - startAngle
  const sweep = ((raw % TWO_PI) + TWO_PI) % TWO_PI
  return sweep === 0 && raw !== 0 ? TWO_PI : sweep
}

/** Segment count for a sweep under a density policy. */
export function arcSegmentCount(radius: number, sweep: number, density: ArcDensity): number {
  switch (density.kind) {
    case 'perTurn':
      return Math.max(
        density.minSegments,
        Math.ceil((Math.abs(sweep) / TWO_PI) * density.samplesPerTurn),
      )
    case 'chordTolerance': {
      // Segment angle for chord tolerance t on radius r is 2*acos(1 - t/r), so
      // big circles get many segments and small ones stay cheap.
      const r = Math.max(Math.abs(radius), 1e-6)
      const segAngle = 2 * Math.acos(1 - Math.min(1, density.toleranceMm / r))
      const n = Math.ceil(Math.abs(sweep) / Math.max(segAngle, 1e-4))
      return Math.min(density.maxSegments, Math.max(density.minSegments, n))
    }
    case 'chordLength':
      return Math.max(
        density.minSegments,
        Math.ceil((Math.abs(sweep) * Math.abs(radius)) / density.maxChordMm),
      )
    case 'fixed':
      return density.segments
  }
}

/** THE arc walk: `segmentCount + 1` points running CCW from startAngle to endAngle.
 *  Every arc drawn anywhere in this repo comes out of this loop. */
export function arcSamplePoints(arc: ArcGeometry, density: ArcDensity): Vec2[] {
  const sweep = arcSweepCcw(arc.startAngle, arc.endAngle)
  const n = arcSegmentCount(arc.radius, sweep, density)
  const pts: Vec2[] = []
  for (let i = 0; i <= n; i++) {
    const a = arc.startAngle + (sweep * i) / n
    pts.push({
      x: arc.center.x + arc.radius * Math.cos(a),
      y: arc.center.y + arc.radius * Math.sin(a),
    })
  }
  return pts
}

/** Full-circle sample points, expressed as a 2*PI arc so circles and arcs share
 *  the one walk (sketchLayer.tessellateCircle's former private loop). */
export function circleSamplePoints(
  center: Vec2,
  radius: number,
  density: ArcDensity,
): Vec2[] {
  return arcSamplePoints({ center, radius, startAngle: 0, endAngle: TWO_PI }, density)
}
