// Parity policy table (draft WO-A3-14 step 4): each family's current default and
// label behaviour, reproduced exactly so a later re-hosting is cell-identical.
// The carded policies (step 5) are flags that ship OFF; turning one on is a
// later order with the operator looking at the actual toolpaths (rule 11 CARD class).

export type DirectionFamily =
  | 'contour' | 'chamfer' | 'bore' | 'thread' | 'trochoid' | 'engrave'
  | 'pocket' | 'face' | 'adaptive2d'
  | 'adaptive3d' | 'rest3d' | 'wallCleanup3d' | 'waterline' | 'scallop' | 'pencil'

export interface DirectionFlags {
  /** MD-73: an Adaptive 2D operation with no stored direction bit resolves to climb. */
  adaptive2d_default_climb: boolean
  /** MD-71 / BL-397: pocket outside-in rings and facing rings are wound so the
   *  label names the side they engage. */
  labels_mean_engaged_side: boolean
  /** MD-72: scallop and pencil apply the cut-hand fold like every other family. */
  fold_all_finishes: boolean
}

/** Parity: every carded flag off. Frozen so no caller can turn one on by mutation. */
export const PARITY_FLAGS: Readonly<DirectionFlags> = Object.freeze({
  adaptive2d_default_climb: false,
  labels_mean_engaged_side: false,
  fold_all_finishes: false,
})

export interface FamilyPolicy {
  /** Today's engine applies the cut-hand fold for this family. */
  fold: boolean
  /** The fold is the carded MD-72 change, applied only under `fold_all_finishes`. */
  foldCarded?: boolean
  /** What today's engine cuts when the operation stores no direction. */
  missingPreference?: 'climb'
  /** Where today's engine reads the material side from. */
  materialSource: 'side-parameter' | 'nesting' | 'probe' | 'fill-order' | 'none'
  /** Today's engine code the row reproduces (read-only; never imported). */
  current: string
}

export const FAMILY_POLICY: Readonly<Record<DirectionFamily, Readonly<FamilyPolicy>>> = Object.freeze({
  contour: { fold: true, materialSource: 'side-parameter', current: 'src/lib/cam/contour2d.ts directionForTool + loopWindingFor / materialSideFor' },
  chamfer: { fold: true, materialSource: 'side-parameter', current: 'src/lib/cam/chamfer2d.ts directionForTool + loopWindingFor (side from loopSides, holes default inner)' },
  bore: { fold: true, materialSource: 'side-parameter', current: 'src/lib/cam/bore2d.ts orbitIsCCW = loopWindingFor(dir, false)' },
  thread: { fold: true, materialSource: 'side-parameter', current: 'src/lib/cam/threadHelix.ts threadOrbitSense(kind, cut, spindleSign)' },
  trochoid: { fold: true, materialSource: 'side-parameter', current: 'src/lib/cam/trochoidal2d.ts orbitSenseFor (climb -> CCW)' },
  engrave: { fold: true, materialSource: 'side-parameter', current: 'src/lib/cam/engrave2d/index.ts as_drawn | directionForTool; orbits turn the climb way' },
  pocket: { fold: true, materialSource: 'fill-order', current: 'src/lib/cam/pocket2d.ts useClimb: rough rings CCW, outer wall as found, island walls CW' },
  face: { fold: true, materialSource: 'fill-order', current: 'src/lib/cam/face2d/index.ts both_ways | directionForTool; one-way +X, rings CCW, spiral CCW for climb' },
  adaptive2d: { fold: true, materialSource: 'side-parameter', current: 'src/lib/cam/types.ts resolveAdaptiveMillingDirection (stored bit: false -> climb, else conventional)' },
  adaptive3d: { fold: true, missingPreference: 'climb', materialSource: 'side-parameter', current: 'src/cam3d/rough/millingDirection.ts directionForClockwisePlanner; adaptiveRough.ts:1207 missing -> climb' },
  rest3d: { fold: true, materialSource: 'side-parameter', current: 'src/cam3d/strategies/rest/index.ts -> adaptive rough millingDirection + spindleRotation' },
  wallCleanup3d: { fold: true, materialSource: 'side-parameter', current: 'src/cam3d/rough/wallCleanup.ts materialSideForClockwisePlanner' },
  waterline: { fold: true, materialSource: 'probe', current: 'src/cam3d/strategies/waterline/loops.ts classifyLevel wantMaterialOnRight' },
  scallop: { fold: false, foldCarded: true, materialSource: 'none', current: 'src/cam3d/strategies/scallop/index.ts orientPath (climb -> clockwise, cutter hand ignored)' },
  pencil: { fold: false, foldCarded: true, materialSource: 'none', current: 'src/cam3d/strategies/pencil/index.ts (conventional reverses the traced pass, cutter hand ignored)' },
})

export function resolveFlags(flags: Partial<DirectionFlags> | undefined): Readonly<DirectionFlags> {
  if (!flags) return PARITY_FLAGS
  return Object.freeze({ ...PARITY_FLAGS, ...flags })
}

export function familyFolds(family: DirectionFamily, flags: Readonly<DirectionFlags>): boolean {
  const policy = FAMILY_POLICY[family]
  if (!policy) throw new Error(`Unknown direction family "${String(family)}".`)
  return policy.fold || (policy.foldCarded === true && flags.fold_all_finishes)
}
