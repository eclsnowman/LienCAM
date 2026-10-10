// cam3d rough: bridge a decomposed cut-region component to the 2D adaptive
// engine's Feature type.
//
// The 2D engine (src/lib/cam/adaptiveClearing2d) clears ONE feature at a time:
// an outer boundary loop plus its island holes, expressed as {x,y}[] Loops. Our
// per-level cut region (cutRegion.ts) is a flat-f64 Ring set that
// decomposeToComponents already split into bounded RegionComponents (one CCW
// outer + the CW holes inside it). featureFromComponent is the thin adapter:
// ring -> loop via convert.ts, packaged as the engine's Feature.
//
// STEPOVER CONVENTION (documented once, kept end-to-end): the 2D engine's
// ProcessParams.stepOver is a FRACTION (0..1) of the tool DIAMETER
// (processFeature.ts line ~165: stepOverDistance = toolDia * stepOver). The
// AdaptiveRoughInput.stepover carries the SAME fraction. So the strategy passes
// input.stepover straight through to processFeature -- no mm<->fraction
// conversion anywhere. Callers that think in mm must divide by diameter before
// they reach this layer.

import type { Feature } from './engineEntry';
import { ringToLoop } from './convert';
import type { RegionComponent } from './cutRegion';

/**
 * Convert one bounded cut-region component to the 2D engine's Feature (outer
 * boundary loop + island hole loops), converting each flat-f64 Ring to a
 * {x,y}[] Loop. Pure; fails loud (via convert.ts) on a degenerate ring.
 */
export function featureFromComponent(comp: RegionComponent): Feature {
  return {
    boundary: ringToLoop(comp.boundary),
    holes: comp.holes.map((h) => ringToLoop(h)),
  };
}
