// WO-3031 (alpha.3 A3-13): the parity policy table - each family's entry choice today, per
// linking entry type, citing the code that decides it. At parity the ladder (ladder.ts)
// is asked by nobody: each row reproduces what the family's own code does, measured on the
// production runs (WO-3031 parity test, src/tests/evidence/WO-3031/parity.json).

import type { LinkingParams, OperationType } from '../../types'
import type { EntryClass } from './classify'
import type { EntryGate } from './gates'
import type { HelixSampling } from './helix'
import type { LeadKind } from './leads'

export const ENTRY_TYPES = ['plunge', 'ramp_linear', 'ramp_helical', 'arc'] as const satisfies readonly LinkingParams['entryType'][]
export type EntryType = typeof ENTRY_TYPES[number]

export interface FamilyEntryRow {
  /** The code that decides this family's entries today (read-only originals). */
  readonly decidedBy: string
  /** Entry classes today's family produces for each linking entry type. */
  readonly byEntryType: Readonly<Record<EntryType, readonly EntryClass[]>>
  /** The family's helix form (its sampling recipe in the one builder), or none. */
  readonly helixForm: HelixSampling['kind'] | 'none'
  /** Where the family's pitch comes from. */
  readonly pitch: 'entry_angle' | 'own_pitch' | 'none'
  /** The gate that decides when a helix is too small, if the family helixes. */
  readonly helixFloor: EntryGate | null
  /** What today's family does where its helix / ramp does not fit. */
  readonly noFit: string
  /** Lead kinds the family builds today. */
  readonly leads: readonly LeadKind[]
  /** Whether the lead-in / lead-out radius fields act today (MD-70 card makes the rest act). */
  readonly leadFields: 'read' | 'ignored'
}

const same = (classes: readonly EntryClass[]): Readonly<Record<EntryType, readonly EntryClass[]>> =>
  Object.freeze({ plunge: classes, ramp_linear: classes, ramp_helical: classes, arc: classes })

const row = (r: FamilyEntryRow): FamilyEntryRow => Object.freeze(r)

export const PARITY_ENTRY_TABLE: Readonly<Record<OperationType, FamilyEntryRow>> = Object.freeze({
  face: row({
    decidedBy: 'src/lib/cam/face2d/index.ts:690-694 plunge at the plunge rate in the overrun, outside the part; :753-755 a one-way re-plunge there at the cutting feed; the linking entry type is not read (Face has its own, :58)',
    byEntryType: same(['plunge', 'open']), helixForm: 'none', pitch: 'none', helixFloor: null,
    noFit: 'n/a', leads: ['straight'], leadFields: 'ignored',
  }),
  pocket_2d: row({
    decidedBy: 'src/lib/cam/pocketEntryPolicy.ts (inside-out, the default fill, takes Helix or Plunge; outside-in Profile Ramp or Plunge); src/lib/cam/pocket2d.ts:502-524 performEntry; :1768, :1884, :2067-2078 inside-out helix fit',
    byEntryType: Object.freeze({ plunge: ['plunge'], ramp_linear: ['helix', 'ramp', 'plunge'], ramp_helical: ['helix', 'plunge'], arc: ['helix', 'ramp', 'plunge'] }),
    helixForm: 'even', pitch: 'entry_angle', helixFloor: 'helix_floor_2d',
    noFit: 'a helix below the floor plunges at the plunge rate (performEntry); inside-out with no fitting helix stops with an error (pocket2d.ts:2071)',
    leads: [], leadFields: 'ignored',
  }),
  adaptive_clearing_2d: row({
    decidedBy: 'src/lib/cam/adaptiveClearing2d/engine/emit.ts:345-423 emitEntry / emitHelixRamp; processFeature.ts makeEntry, planHelixDescent',
    byEntryType: same(['helix', 'plunge', 'open']), helixForm: 'fixed', pitch: 'entry_angle', helixFloor: 'helix_floor_adaptive_2d_default',
    noFit: 'a helix below the floor plunges at the plunge rate (emitEntry); side entries rapid down outside the stock',
    leads: ['straight', 'polyline', 'arc'], leadFields: 'read',
  }),
  contour_2d: row({
    decidedBy: 'src/lib/cam/contour2d.ts:565 isRamp = Profile Ramp only; :717-731, :838 rampTo; :1038-1061 trochoidal helix (Profile Ramp); :262 open pass',
    byEntryType: Object.freeze({ plunge: ['plunge'], ramp_linear: ['ramp', 'helix', 'plunge'], ramp_helical: ['plunge'], arc: ['plunge'] }),
    helixForm: 'even', pitch: 'entry_angle', helixFloor: 'helix_floor_2d',
    noFit: 'a trochoidal orbit below the floor plunges at the plunge rate (contour2d.ts:1038)',
    leads: ['straight', 'polyline'], leadFields: 'ignored',
    // The lead-in is a fed descent at the lead-in rate where the pass begins (contour2d.ts:792, :877, :889, :1953).
  }),
  drill: row({
    decidedBy: 'src/lib/cam/drill2d.ts (canned cycle / pecks: the plunge is the cut)',
    byEntryType: same(['plunge']), helixForm: 'none', pitch: 'none', helixFloor: null,
    noFit: 'n/a', leads: [], leadFields: 'ignored',
  }),
  bore: row({
    decidedBy: 'src/lib/cam/bore2d.ts:196-250 helical entry (helix arcs, own pitch) else plunge',
    byEntryType: Object.freeze({ plunge: ['plunge'], ramp_linear: ['plunge'], ramp_helical: ['helix', 'plunge'], arc: ['plunge'] }),
    helixForm: 'arcs', pitch: 'own_pitch', helixFloor: 'bore_helix_orbit_floor',
    noFit: 'an orbit at or below 0.05 mm plunges and says so in one line (bore2d.ts:239-248)',
    leads: [], leadFields: 'ignored',
  }),
  chamfer: row({
    decidedBy: 'src/lib/cam/chamfer2d.ts:165, :207-216 rampTo at the plunge rate else plungeTo',
    byEntryType: Object.freeze({ plunge: ['plunge'], ramp_linear: ['ramp', 'plunge'], ramp_helical: ['plunge'], arc: ['plunge'] }),
    helixForm: 'none', pitch: 'none', helixFloor: null,
    noFit: 'n/a', leads: ['straight'], leadFields: 'ignored',
  }),
  engrave: row({
    decidedBy: 'src/lib/cam/engrave2d/index.ts:214 helix (trochoidal, Profile Ramp only), :287, :295 plungeTo',
    byEntryType: Object.freeze({ plunge: ['plunge'], ramp_linear: ['helix', 'plunge'], ramp_helical: ['plunge'], arc: ['plunge'] }), helixForm: 'even', pitch: 'entry_angle', helixFloor: 'helix_floor_2d',
    noFit: 'a trochoidal orbit below the floor plunges at the plunge rate',
    leads: ['polyline'], leadFields: 'read',
  }),
  vcarve: row({
    decidedBy: 'src/lib/cam/vcarve2d/index.ts (plunge, or a descending cut along the carve)',
    byEntryType: same(['plunge', 'ramp']), helixForm: 'none', pitch: 'none', helixFloor: null,
    noFit: 'n/a', leads: [], leadFields: 'ignored',
  }),
  thread_mill: row({
    decidedBy: 'src/lib/cam/threadmill2d.ts:239-241 plunge down the pre-drilled hole; :256, :271 thread helix (own pitch); :246, :288 lead arcs',
    byEntryType: same(['plunge', 'helix']), helixForm: 'dense', pitch: 'own_pitch', helixFloor: null,
    noFit: 'n/a', leads: ['straight', 'arc', 'helix'], leadFields: 'ignored',
  }),
  pattern: row({
    decidedBy: 'the patterned operation\'s own row',
    byEntryType: same(['helix', 'ramp', 'plunge', 'open']), helixForm: 'none', pitch: 'none', helixFloor: null,
    noFit: 'the patterned operation\'s', leads: ['straight', 'polyline', 'arc', 'ramp', 'helix'], leadFields: 'ignored',
  }),
  adaptive_3d: row({
    decidedBy: 'src/cam3d/rough/emit.ts:650-690 region entry (helix >= floor, else straight descent within the 5 % allowance, else an error); :715-770 landing descents; :600-640 side entry',
    byEntryType: same(['helix', 'plunge', 'open']), helixForm: 'turns', pitch: 'entry_angle', helixFloor: 'helix_floor_adaptive',
    noFit: 'a straight descent beyond the 5 % face allowance stops with an error (assertStraightDescentIsClear, emit.ts:383)',
    leads: ['straight', 'polyline', 'arc'], leadFields: 'ignored',
  }),
  parallel_3d: row({
    decidedBy: 'src/cam3d/pathbuild/index.ts ramp lead (kernel copy src/kernel/linking/finishLinker3d.ts)',
    byEntryType: same(['ramp', 'plunge', 'open']), helixForm: 'none', pitch: 'none', helixFloor: null,
    noFit: 'reverse ramp, else ramp-and-return, else a vertical plunge', leads: ['ramp'], leadFields: 'ignored',
  }),
  waterline_3d: row({
    decidedBy: 'src/cam3d/strategies/waterline/link.ts 10 deg ramp (kernel copy src/kernel/linking/waterlineLinker.ts)',
    byEntryType: same(['ramp', 'plunge', 'open']), helixForm: 'none', pitch: 'none', helixFloor: null,
    noFit: 'a vertical plunge', leads: ['ramp'], leadFields: 'ignored',
  }),
  scallop_3d: row({
    decidedBy: 'src/cam3d/pathbuild/index.ts (kernel copy finishLinker3d.ts)',
    byEntryType: same(['ramp', 'plunge', 'open']), helixForm: 'none', pitch: 'none', helixFloor: null,
    noFit: 'reverse ramp, else ramp-and-return, else a vertical plunge', leads: ['ramp'], leadFields: 'ignored',
  }),
  steep_shallow_3d: row({
    decidedBy: 'its halves: src/cam3d/strategies/waterline/link.ts and src/cam3d/pathbuild/index.ts (kernel copies in src/kernel/linking)',
    byEntryType: same(['ramp', 'plunge', 'open']), helixForm: 'none', pitch: 'none', helixFloor: null,
    noFit: 'as its halves', leads: ['ramp'], leadFields: 'ignored',
  }),
  pencil_3d: row({
    decidedBy: 'src/cam3d/pathbuild/index.ts (kernel copy finishLinker3d.ts)',
    byEntryType: same(['ramp', 'plunge', 'open']), helixForm: 'none', pitch: 'none', helixFloor: null,
    noFit: 'reverse ramp, else ramp-and-return, else a vertical plunge', leads: ['ramp'], leadFields: 'ignored',
  }),
})

/** The entry classes a family's entries may have under this entry type at parity. */
export function parityEntryClasses(family: OperationType, entryType: EntryType): readonly EntryClass[] {
  return PARITY_ENTRY_TABLE[family].byEntryType[entryType]
}
