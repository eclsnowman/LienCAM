// WO-3031 (alpha.3 A3-13): today's measured entry gates and entry conventions as one table
// of rule data (REQ-ENTRY-6), every row at today's value and citing the code that holds it.
// They stay parity facts: no row here is a new limit (A-30 keeps today's numbers until the
// measuring stick decides). The parity test compares each row with today's constant.

export interface EntryGateRow {
  readonly value: number
  readonly unit: string
  /** The code that holds today's value (read-only). */
  readonly source: string
}

const row = (value: number, unit: string, source: string): EntryGateRow => Object.freeze({ value, unit, source })

export const ENTRY_GATES = Object.freeze({
  /** Shared 2.5D helix floor: a smaller helix is a plunge (Pocket, Contour, Engrave). */
  helix_floor_2d: row(0.2, 'mm', 'src/lib/cam/moves/index.ts:39 MIN_HELIX_RADIUS_MM'),
  /** Adaptive 2D / 3D planner and emitters' helix floor. */
  helix_floor_adaptive: row(0.2, 'mm', 'src/lib/cam/adaptiveClearing2d/engine/processFeature.ts:4149 MIN_DESCENT_HELIX_RADIUS'),
  /** Adaptive 2D emitter default when the operation sets no minHelixRadius. */
  helix_floor_adaptive_2d_default: row(0.2, 'mm', 'src/lib/cam/adaptiveClearing2d/engine/index.ts:43 DEFAULT_MIN_HELIX_RADIUS_MM'),
  /** Bore helixes only when its orbit radius is strictly above this. */
  bore_helix_orbit_floor: row(0.05, 'mm', 'src/lib/cam/bore2d.ts:193 MIN_HELIX_ORBIT_RADIUS_MM'),
  /** Bore's ramp angle never below this when it sets its own pitch. */
  bore_min_ramp_angle: row(0.25, 'deg', 'src/lib/cam/bore2d.ts:213'),
  /** 3D rough: a straight descent may proceed when at most this share of the cutter face stands above its floor. */
  straight_descent_allowance: row(0.05, 'fraction of the cutter face', 'src/cam3d/rough/emit.ts:149 DEFAULT_PLUNGE_UNCUT_ALLOWANCE'),
  /** ... and never less than one grid cell (a single uncut column always passes). */
  straight_descent_free_columns: row(1, 'columns', 'src/cam3d/rough/emit.ts:370'),
  /** The helix rides its tool-centre circle this far inside the nominal radius (Adaptive 2D and 3D). */
  helix_edge_backoff: row(0.01, 'mm', 'src/lib/cam/adaptiveClearing2d/engine/emit.ts:88, src/cam3d/rough/emit.ts:55 HELIX_EDGE_BACKOFF'),
  /** Adaptive 2D and 3D helix point cap. */
  helix_max_points: row(5000, 'points', 'src/lib/cam/adaptiveClearing2d/engine/emit.ts:89, src/cam3d/rough/emit.ts:57 MAX_HELIX_POINTS'),
  /** 3D rough helix sampling. */
  helix_segments_per_turn_3d: row(24, 'segments/turn', 'src/cam3d/rough/emit.ts:51 HELIX_SEGMENTS_PER_TURN'),
  /** 2.5D descent default sampling (helixDescent 'even'). */
  helix_steps_per_turn_2d: row(36, 'steps/turn', 'src/lib/cam/moves/index.ts:76 helixDescent default sampling'),
  helix_min_steps_2d: row(12, 'steps', 'src/lib/cam/moves/index.ts:76 helixDescent default sampling'),
  /** 3D rough: a later entry starts this far above the highest standing stock under its helix. */
  stock_aware_ramp_clearance_3d: row(0.05, 'mm', 'src/cam3d/rough/emit.ts:65 STOCK_AWARE_RAMP_CLEARANCE_MM'),
})

export type EntryGate = keyof typeof ENTRY_GATES

/** Entry conventions: today's defaults and clamps (REQ-ENTRY-6 parity rows). */
export const ENTRY_CONVENTIONS = Object.freeze({
  /** Linking default entry, ramp angle and ramp length for every 2.5D operation. */
  linking_entry_type: Object.freeze({ value: 'ramp_linear', source: 'src/kernel/parameterDefaults.ts:34 defaultLinking.entryType' }),
  ramp_angle_2d: row(3, 'deg', 'src/kernel/parameterDefaults.ts:35 defaultLinking.rampAngle'),
  ramp_length_2d: row(10, 'mm', 'src/kernel/parameterDefaults.ts:36 defaultLinking.rampLength'),
  lead_in_radius: row(0, 'mm', 'src/kernel/parameterDefaults.ts:37 defaultLinking.leadInRadius'),
  lead_out_radius: row(0, 'mm', 'src/kernel/parameterDefaults.ts:38 defaultLinking.leadOutRadius'),
  /** Pocket, Contour and Chamfer clamp the authored ramp angle into [min, max]. */
  ramp_angle_clamp_min: row(0.5, 'deg', 'src/lib/cam/pocket2d.ts:2201, contour2d.ts:566, chamfer2d.ts:166'),
  ramp_angle_clamp_max: row(30, 'deg', 'src/lib/cam/pocket2d.ts:2201, contour2d.ts:566, chamfer2d.ts:166'),
  /** Adaptive 2D helix diameter, % of the tool diameter. */
  helix_diameter_adaptive_2d: row(90, '% of D', 'src/kernel/parameterDefaults.ts:103 defaultACParams.helixDiameter'),
  /** Adaptive 3D helix diameter and angle. */
  helix_diameter_adaptive_3d: row(3, 'mm', 'src/kernel/parameterDefaults.ts:292 DEFAULT_ADAPTIVE3D_PARAMS.helixDiameter'),
  helix_angle_adaptive_3d: row(10, 'deg', 'src/kernel/parameterDefaults.ts:293, src/cam3d/rough/emit.ts:53 DEFAULT_HELIX_ANGLE_DEG'),
  /** Ramp feed fallback = plunge rate x 1.5, rounded; plunge rate fallback 100 mm/min. */
  ramp_feed_of_plunge: row(1.5, 'x plunge rate', 'src/lib/cam/feedrates.ts:110'),
})

/** Today's straight-descent verdict (src/cam3d/rough/emit.ts:363-371, the rule only - the
 *  stock read stays the 3D rough's until the material service carries it): a descent may
 *  proceed when at most one column is uncut, or when the uncut share of the cutter face is
 *  within the allowance. */
export function straightDescentAllowed(
  read: { uncutColumns: number; fraction: number },
  allowance = ENTRY_GATES.straight_descent_allowance.value,
): boolean {
  return read.uncutColumns <= ENTRY_GATES.straight_descent_free_columns.value || read.fraction <= allowance
}

/** The orbit radius the Adaptive 2D / 3D helix actually rides for a nominal helix radius. */
export function helixOrbitRadius(nominal: number): number {
  return Math.max(nominal - ENTRY_GATES.helix_edge_backoff.value, nominal * 0.5)
}
