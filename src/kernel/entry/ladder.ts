// WO-3031 (alpha.3 A3-13): the entry ladder (alpha3-12 s6.2, REQ-ENTRY-1..4). Per region and
// level the first rung that fits is used, in the operator's preference order (A-29): helix,
// ramp, an outside / already-open start, a pre-drilled shaft, the slow plunge at the reduced
// plunge feed (rated tools only, and only with its policy on), and last declared rest.
// Nothing in the app asks the ladder yet: at parity each family's own code decides its
// entries (mapping.ts), and the policies are off (policy.ts).

import type { EntryPolicy } from './policy'

export const ENTRY_RUNGS = ['helix', 'ramp', 'open', 'pre_drilled', 'rated_plunge', 'declared_rest'] as const
export type EntryRung = typeof ENTRY_RUNGS[number]

/** The tool facts the ladder reads. Absent means unknown, and unknown is not rated (alpha3-12 s6.2 note d). */
export interface EntryToolFacts {
  readonly centreCutting?: boolean
  readonly plungeRated?: boolean
}

/** A tool may take the slow-plunge rung only when it is documented centre-cutting or plunge-rated. */
export function toolIsPlungeRated(tool: EntryToolFacts): boolean {
  return tool.centreCutting === true || tool.plungeRated === true
}

/** The rungs this policy offers this tool, in ladder order. */
export function entryLadder(policy: EntryPolicy, tool: EntryToolFacts): EntryRung[] {
  return ENTRY_RUNGS.filter(rung =>
    rung !== 'rated_plunge' || (policy.slow_plunge_rung === 'rated_tools_only' && toolIsPlungeRated(tool)))
}

/** Which rungs fit this region at this level (from the geometry and the stock state). Declared rest always fits. */
export type RungFits = Partial<Record<Exclude<EntryRung, 'declared_rest'>, boolean>>

/** The rank reported for an entry (M-ENTRY-4): 1 for helix .. 6 for declared rest. */
export function rungRank(rung: EntryRung): number {
  return ENTRY_RUNGS.indexOf(rung) + 1
}

/** The first offered rung that fits; declared rest when none does. */
export function chooseEntry(policy: EntryPolicy, tool: EntryToolFacts, fits: RungFits): EntryRung {
  for (const rung of entryLadder(policy, tool)) {
    if (rung === 'declared_rest' || fits[rung] === true) return rung
  }
  return 'declared_rest'
}

/** A declared-rest record (REQ-ENTRY-8): what was left, where and why, and what was tried.
 *  The type only - at parity nothing is declared rest (tool_approach_search is off). */
export interface DeclaredRest {
  readonly levelZ: number
  readonly polygon: ReadonlyArray<{ x: number; y: number }>
  readonly areaMm2: number
  readonly reason: string
  readonly toolsTried: readonly string[]
  readonly rungsTried: readonly EntryRung[]
}
