// WO-2905: pure parameter contracts shared by authoring and current adapters.
import type { AdaptiveMillingDirection } from '../lib/cam/types'

export interface Adaptive3dParams {
  /** Max axial depth of cut per Z level, mm (> 0; deep is OK -- engagement is
   *  bounded in plan view by the 2D engine, not by the stepdown). */
  maxStepdown: number;
  /** Stepover as a FRACTION 0..1 of tool DIAMETER (the engagement knob). */
  stepover: number;
  /** Physical milling direction for a clockwise spindle. */
  millingDirection: AdaptiveMillingDirection;
  /** Add roughing levels between full stepdowns to leave sloped walls nearer net shape. */
  intermediateStepdown: boolean;
  /** Tangent radius used to enter retained-wall cleanup contours, mm. */
  wallLeadInRadius: number;
  /** Tangent radius used to leave retained-wall cleanup contours, mm. */
  wallLeadOutRadius: number;
  /** Stay-down loopback fillet radius as a percent of tool radius. */
  loopbackFilletPct: number;
  /** Follow a shared wall at depth instead of retracting between nearby passes. */
  integralWallFollow: boolean;
  /** Maximum wall-follow route length divided by straight-line distance. */
  integralWallFollowLengthFactor: number;
  /** Max chordal deviation of the sampled polyline from the surface, mm. */
  tolerance: number;
  /** Entry helix diameter, mm (> 0). */
  helixDiameter: number;
  /** Entry helix descent angle from horizontal, degrees (0.5..30). */
  helixAngleDeg: number;
  /** Radial finish stock left on part walls, mm (>= 0). */
  radialStockToLeave: number;
  /** Axial finish stock left on the floor, mm (>= 0; raises the computed floor). */
  axialStockToLeave: number;
  /** Stock/part grid cell size, mm. <= 0 means "derive from tolerance + tool". */
  cellSize: number;
  /** Clip the job to the stock footprint (true) or the part xy-bounds (false). */
  useStockBoundary: boolean;
  /**
   * Corner-reach (Stage C-2): mm PAST the stock edge the tool centre may reach,
   * so the full-clear pass removes the leftover corner posts. undefined = AUTO
   * (tool radius: the tool just kisses the corner apex); 0 = stay at the walls /
   * leave posts. Only consulted in the STOCK-OUTLINE full-clear branch; ignored
   * in part-bounds / fallback mode (dilating there would gouge uncleared stock).
   */
  stockEdgeOvershoot?: number;
}

export interface Parallel3dParams {
  /** Pass spacing, mm (> 0). */
  stepover: number;
  /** Pass direction, degrees CCW from +X. */
  angleDeg: number;
  /** Max chordal deviation of the sampled polyline from the surface, mm. */
  tolerance: number;
  /** Material left along the sampled 3D surface normal, mm. */
  surfaceStockToLeave?: number;
  /** Shallow areas only; 0/undefined keeps the legacy whole-part raster. */
  maxSlopeDeg?: number;
  /** Optional maximum finish depth below model top, mm. */
  finishDepth?: number;
  /**
   * Clip passes to the stock footprint (true) or the part xy-bounds (false).
   * This SELECTS which boundary contains the passes. It does not overrun
   * whichever boundary is chosen -- that is `stockEdgeOvershoot` (WO-1271).
   */
  useStockBoundary: boolean;
  /**
   * WO-1271. Stock-edge overrun: mm PAST the containment edge the tool
   * CENTRE may travel, so the round cutter clears the edge instead of
   * stopping with its axis on it and leaving one radius of material behind.
   * Same name and semantics as Adaptive Rough 3D's `stockEdgeOvershoot`
   * (ADR-0015 s2 is one cross-cutting convention, not three spellings):
   * undefined = AUTO (the tool radius); 0 = none (the pre-WO-1271 toolpath).
   * Never applied to a face-scoped pass (WO-1223): a selection edge is a
   * wall the cutter must not cross, so that region stays inset.
   */
  stockEdgeOvershoot?: number;
}

export interface WaterlineParams {
  /** Maximum stepdown between levels, mm (> 0); the last step may be shorter. */
  stepdown: number;
  /** Max chordal deviation, mm (> 0). Drives the slicer sampling (kernel/oclWaterline.ts). */
  tolerance: number;
  /** Radial allowance on the walls, mm (>= 0). A ball cutter's is a true surface offset. */
  stockToLeave: number;
  /** Steep areas only: 0 = whole part; else drop runs shallower than this angle from horizontal. */
  minSlopeDeg: number;
  /** Add a level at every horizontal face. */
  flatAreaDetection: boolean;
  /** Level-first ("order by depth") or region-first ("order by islands"). */
  order: 'level' | 'region';
  direction: 'climb' | 'conventional';
  /** Optional maximum finish depth below model top, mm (Smart Height bounded variant). */
  finishDepth?: number;
  /** Clip passes to the stock footprint (true) or leave the part silhouette (false). */
  useStockBoundary: boolean;
  /** Stock-edge overrun in mm; undefined = auto tool radius, 0 = legacy containment. */
  stockEdgeOvershoot?: number;
}

export interface SteepShallow3dParams {
  /** Angle from horizontal dividing steep waterlines from shallow raster passes. */
  thresholdDeg: number;
  stepdown: number;
  stepover: number;
  angleDeg: number;
  tolerance: number;
  stockToLeave: number;
  useStockBoundary: boolean;
  finishDepth?: number;
}

export interface Scallop3dParams {
  scallopHeight: number;
  tolerance: number;
  stockToLeave: number;
  useStockBoundary: boolean;
  finishDepth?: number;
  direction: 'climb' | 'conventional';
  /**
   * WO-1282. Stock-edge overrun: mm PAST the containment edge the tool CENTRE
   * may travel, so the round cutter clears the edge instead of stopping with
   * its axis on it and leaving one radius of material behind. Same name, same
   * semantics and the SAME decision function as Parallel Finish 3D and
   * Adaptive Rough 3D carry (ADR-0015 s2 is one cross-cutting convention, not
   * four spellings): undefined = AUTO (the tool radius), 0 = none (the
   * pre-WO-1282 toolpath). Never applied to a face-scoped pass (WO-1223) or to
   * a boundary the caller has not vouched for as a stock outline.
   */
  stockEdgeOvershoot?: number;
}

export interface Pencil3dParams {
  tolerance: number;
  stockToLeave: number;
  useStockBoundary: boolean;
  finishDepth?: number;
  direction: 'climb' | 'conventional';
}

export interface Rest3dParams {
  stockSource: RestMachiningStockSource;
  referenceToolDiameter: number;
  referenceCornerRadius: number;
  tolerance: number;
  stockToLeave: number;
  stepdown: number;
  useStockBoundary: boolean;
  direction: 'climb' | 'conventional';
}

export type RestMachiningStockSource = 'previous_operations' | 'previous_tool';

export interface RestMachiningSettings {
  restMachining: boolean;
  stockSource: RestMachiningStockSource;
}
