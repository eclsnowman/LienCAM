// WO-3026 (alpha.3 A3-12): link choice by geometric case, mapped from the retract-type
// and transition-type fields through a parity policy table (MD-60, REQ-LINK-2).
//
// Today no builder reads those two fields (BL-226: only recipes and diagnostics carry
// them), so at parity the table maps every field value to the family's own link
// behaviour - the same row whatever the operator stored. The row names the code that
// decides the link today and the outcomes it produces in each case, measured on the
// production runs (WO-3026 parity test, src/tests/evidence/WO-3026/parity.json).

import type { LinkingParams, OperationType } from '../../types'
import type { LinkCase, LinkOutcome } from './cases'

export const RETRACT_TYPES = ['full', 'partial', 'minimum'] as const satisfies readonly LinkingParams['retractType'][]
export const TRANSITION_TYPES = ['safe_height', 'direct', 'avoid_stock'] as const satisfies readonly LinkingParams['transitionType'][]

export interface LinkFields {
  retractType: LinkingParams['retractType']
  transitionType: LinkingParams['transitionType']
}

/** New operations' stored defaults (src/kernel/parameterDefaults.ts defaultLinking). */
export const DEFAULT_LINK_FIELDS: LinkFields = Object.freeze({ retractType: 'full', transitionType: 'safe_height' })

export interface FamilyLinkRow {
  /** Cuts on Z levels (a Z change between runs is a level change); false for surface finishers. */
  readonly levelled: boolean
  /** The code that decides this family's links today (read-only originals). */
  readonly decidedBy: string
  /** Outcomes today's family produces per case. Between regions is a planner fact the
   *  move list cannot show; its row is the union of the gap and level rows [INFERRED]. */
  readonly outcomes: Readonly<Record<LinkCase, readonly LinkOutcome[]>>
}

const ALL: readonly LinkOutcome[] = ['stay_down', 'low_rapid', 'feed_plane', 'retract_plane', 'clearance_plane']

const row = (
  levelled: boolean, decidedBy: string,
  gaps: { readonly short_gap: readonly LinkOutcome[]; readonly long_gap: readonly LinkOutcome[]; readonly level_change: readonly LinkOutcome[] },
): FamilyLinkRow => Object.freeze({
  levelled, decidedBy,
  outcomes: Object.freeze({
    ...gaps,
    between_regions: Object.freeze(ALL.filter(o => gaps.short_gap.includes(o) || gaps.long_gap.includes(o) || gaps.level_change.includes(o))),
  }),
})

// Each row's outcomes are the planes the family's own link code can reach (read from the
// code at the cited lines) and include every outcome the production runs measured.
const STAY_OR_CLEAR: readonly LinkOutcome[] = ['stay_down', 'clearance_plane']
const FACE: readonly LinkOutcome[] = ['stay_down', 'retract_plane', 'clearance_plane']
const DRILL: readonly LinkOutcome[] = ['retract_plane', 'clearance_plane']
// WO-3083 rule 2: hops between the features of one operation cross at Retract.
const RETRACT_OR_CLEAR = DRILL
const STAY_RETRACT_OR_CLEAR: readonly LinkOutcome[] = ['stay_down', 'retract_plane', 'clearance_plane']
const same = (outcomes: readonly LinkOutcome[]) => ({ short_gap: outcomes, long_gap: outcomes, level_change: outcomes })

export const PARITY_LINK_TABLE: Readonly<Record<OperationType, FamilyLinkRow>> = Object.freeze({
  face: row(true, 'src/lib/cam/face2d/index.ts:692-753,1054-1084: stepover feeds, Retract-plane rides; a new level at Retract (moves hopsAtRetract, WO-3083), Clearance first and last', same(FACE)),
  contour_2d: row(true, 'src/lib/cam/contour2d.ts rapidEntry / retractFrom, then moves hopsAtRetract (WO-3083): links at Retract, Clearance first and last', same(RETRACT_OR_CLEAR)),
  pocket_2d: row(true, 'src/lib/cam/pocket2d.ts:96,523,1713-1715,1786-1896: keep-down rides, low helix hops (linkZ), Retract and Clearance lifts', same(ALL)),
  adaptive_clearing_2d: row(true, 'src/lib/cam/adaptiveClearing2d/engine/emit.ts (fast_traverse rides, WO-2835 floor hop, LIFT_DISTANCE micro-lift, retract jumps)', same(ALL)),
  drill: row(true, 'src/lib/cam/drill2d.ts:174-211,277-347: between holes at the retract mode\'s plane (Retract or Clearance)', same(DRILL)),
  bore: row(true, 'src/lib/cam/bore2d.ts (moves hopTo / liftTo, WO-3083): helix passes stay down, orbits and holes linked at Retract, Clearance first and last', same(STAY_RETRACT_OR_CLEAR)),
  thread_mill: row(true, 'src/lib/cam/threadmill2d.ts (moves hopTo / liftTo, WO-3083): passes linked at Retract, Clearance first and last', same(RETRACT_OR_CLEAR)),
  engrave: row(true, 'src/lib/cam/engrave2d/index.ts:286-289,380-383 rapidEntry / retractFrom; trochoidal orbits stay down', same(STAY_OR_CLEAR)),
  vcarve: row(true, 'src/lib/cam/vcarve2d/index.ts:371-376,400-401,666,688,801: stepover rides, Retract then a lower rapid, retractFrom', same(ALL)),
  chamfer: row(true, 'src/lib/cam/chamfer2d.ts (moves hopTo / liftTo, WO-3083): loops linked at Retract, Clearance first and last; clear-space plans via Clearance', same(RETRACT_OR_CLEAR)),
  pattern: row(true, 'the patterned operation\'s own row', same(ALL)),
  parallel_3d: row(false, 'src/cam3d/pathbuild/index.ts buildLinkedPath (kernel copy finishLinker3d.ts): stepover ride, low re-entry at material top + standoff, traverse plane >= Clearance', same(ALL)),
  waterline_3d: row(true, 'src/cam3d/strategies/waterline/link.ts (kernel copy waterlineLinker.ts): stay down within min(stepdown, r), else the traverse plane >= Clearance', same(STAY_OR_CLEAR)),
  adaptive_3d: row(true, 'src/cam3d/rough/emit.ts + traverseSafety.ts: stay-down rides, low travels with headroom, Retract / Clearance lifts', same(ALL)),
  scallop_3d: row(false, 'src/cam3d/pathbuild/index.ts buildLinkedPath (kernel copy finishLinker3d.ts)', same(ALL)),
  steep_shallow_3d: row(true, 'its waterline and parallel halves (both kernel copies)', same(ALL)),
  pencil_3d: row(false, 'src/cam3d/pathbuild/index.ts buildLinkedPath (kernel copy finishLinker3d.ts)', same(ALL)),
})

/** The outcomes a link of this family and case may have under these fields. At parity the
 *  fields do not act (MD-60 is the card that makes them act). */
export function parityLinkOutcomes(family: OperationType, fields: LinkFields, linkCase: LinkCase): readonly LinkOutcome[] {
  void fields
  return PARITY_LINK_TABLE[family].outcomes[linkCase]
}
