// cam3d stock (L0/L3): public surface of the Phase 2 z-dexel stock model.
//
// - ZDexelField: single-interval-per-column stock over a regular XY grid
//   (D-016; paired top/bottom Float32Arrays, budgeted cell count).
// - removeSweep: subtract a linear tool move (flat/ball) in place.
// - toMesh: greedy-quad watertight display mesh (budgeted, fail-loud).
// - remainingAbove: geom2d rings tracing material above a z plane.
// - engagementAt: average removed cross-section (mm^2) for a candidate move.
//
// Layering: this package imports geom2d (L2 polygon ops) and kernel TYPES
// only -- never clipper2, three-mesh-bvh, or OCL directly.

export {
  ZDexelField,
  DEFAULT_CELL_BUDGET,
  type Box3,
  type GridFrame,
} from './zdexel';
export { removeSweep, type LinearMove, type SweepResult } from './removeSweep';
export {
  maxTraverseIntrusion,
  plungeUncutFraction,
  type TraverseIntrusion,
  type PlungeUncut,
} from './traverseClearance';
export { toMesh, DEFAULT_TRIANGLE_BUDGET, type StockMesh } from './toMesh';
export { remainingAbove, EPS_ABOVE } from './remainingAbove';
export { engagementAt } from './engagement';
export { sweepProfile, profileHeight, type SweepCutterKind, type SweepProfile } from './cutterProfile';
