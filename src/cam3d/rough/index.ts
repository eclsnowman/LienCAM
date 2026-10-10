// cam3d rough: public surface of the 3D adaptive rougher's geometry core
// (stage A1 -- per-level cut regions). No clearer, no toolpath emission here.

export {
  ringToLoop,
  loopToRing,
  tupleLoopToRing,
  ringsToLoops,
  loopsToRings,
  type Pt,
  type Loop,
} from './convert';
export { planLevels } from './levels';
export {
  findCriticalDepths,
  CRITICAL_DEPTH_QUANTUM,
  GRID_RESOLUTION_ERROR_NAME,
  type CriticalDepthOpts,
} from './criticalDepths';
export { buildPartHeightField, frameOf, type BuildPartHeightFieldOpts } from './partField';
export {
  cutRegionAt,
  decomposeToComponents,
  type CutRegionOpts,
  type RegionComponent,
} from './cutRegion';
export { featureFromComponent } from './feature';
export { emitLevelPasses, type EmitContext, type EmitHeights } from './emit';
export {
  measurePathEngagement,
  slotCrossSectionMm2,
  type PathEngagementOptions,
  type PathEngagementResult,
} from './pathEngagement';
export {
  enforceTraverseSafety,
  TRAVERSE_INTRUSION_TOLERANCE_MM,
  type TraverseSafetyInput,
  type TraverseSafetyReport,
  type TraverseSafetyResult,
} from './traverseSafety';
