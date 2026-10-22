// WO-3026 (alpha.3 A3-12): the five local "standoff over material" constants as one
// table at today's values (DUP-059 / D-08). Parity policy `link.standoffs` keeps each
// family's own constant; one unified value is the MD-61 card. The kernel 3D finishing
// linkers read their standoff from here, so a changed row changes their links.

export type StandoffId =
  | 'finish_3d_traverse'
  | 'adaptive_3d_traverse'
  | 'drill_peck_reapproach'
  | 'adaptive_2d_micro_lift'
  | 'rough_3d_low_travel_headroom'

export interface StandoffRow {
  readonly id: StandoffId
  /** mm above the proven material (or the previous peck / level). */
  readonly valueMm: number
  /** Where today's constant lives (read-only original). */
  readonly source: string
  readonly usedBy: string
}

export const STANDOFFS: Readonly<Record<StandoffId, StandoffRow>> = Object.freeze({
  finish_3d_traverse: Object.freeze({
    id: 'finish_3d_traverse', valueMm: 1,
    source: 'src/cam3d/pathbuild/index.ts TRAVERSE_STANDOFF_MM',
    usedBy: 'Parallel, Scallop, Pencil, Waterline linkers (traverse plane and low re-entry); 3D finish link lowering',
  }),
  adaptive_3d_traverse: Object.freeze({
    id: 'adaptive_3d_traverse', valueMm: 0.5,
    source: 'src/cam3d/integration/adaptive3dOperation.ts ADAPTIVE_TRAVERSE_STANDOFF_MM',
    usedBy: 'Adaptive 3D minimum traverse plane over the material top',
  }),
  drill_peck_reapproach: Object.freeze({
    id: 'drill_peck_reapproach', valueMm: 0.5,
    source: 'src/lib/cam/drill2d.ts PECK_REAPPROACH_CLEARANCE',
    usedBy: 'Drill G83 re-approach above the previous peck depth',
  }),
  adaptive_2d_micro_lift: Object.freeze({
    id: 'adaptive_2d_micro_lift', valueMm: 2.0,
    source: 'src/lib/cam/adaptiveClearing2d/engine/processFeature.ts LIFT_DISTANCE',
    usedBy: 'Adaptive 2D micro-lift hover over a corridor proven only to the sliver cap',
  }),
  rough_3d_low_travel_headroom: Object.freeze({
    id: 'rough_3d_low_travel_headroom', valueMm: 1.0,
    source: 'src/cam3d/rough/traverseSafety.ts LOW_TRAVEL_HEADROOM_MM',
    usedBy: 'Adaptive 3D low travels and wall-cleanup links (traverse safety lift)',
  }),
})

export function standoffMm(id: StandoffId): number {
  return STANDOFFS[id].valueMm
}
