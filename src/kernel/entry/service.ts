// WO-3031 (alpha.3 A3-13, parity): the entry service - one object both lanes would call:
// the one helix builder, the one ramp builder, the lead library, the entry ladder under one
// policy, today's gates and conventions, and the parity table of each family's entries.
// Headless: it imports only kernel files and pure src modules. Nothing in the app calls it
// yet (engine selector stays `current`); a family switches in P6.

import { buildHelix, helixFits, borePitch, threadPitch } from './helix'
import { rampDescent, rampTo } from './ramp'
import { straightLead, polylineLead, arcLead, arcMoveLead, rampLead, helixLead } from './leads'
import { chooseEntry, entryLadder, rungRank, type EntryToolFacts, type RungFits } from './ladder'
import { ENTRY_CONVENTIONS, ENTRY_GATES, straightDescentAllowed, helixOrbitRadius } from './gates'
import { PARITY_ENTRY_TABLE, parityEntryClasses } from './mapping'
import { entrySpans } from './classify'
import { PARITY_ENTRY_POLICY, type EntryPolicy } from './policy'

export interface EntryService {
  readonly policy: EntryPolicy
  readonly helix: { readonly build: typeof buildHelix; readonly fits: typeof helixFits; readonly orbitRadius: typeof helixOrbitRadius; readonly borePitch: typeof borePitch; readonly threadPitch: typeof threadPitch }
  readonly ramp: { readonly descent: typeof rampDescent; readonly alongContour: typeof rampTo }
  readonly leads: { readonly straight: typeof straightLead; readonly polyline: typeof polylineLead; readonly arc: typeof arcLead; readonly arcMove: typeof arcMoveLead; readonly ramp: typeof rampLead; readonly helix: typeof helixLead }
  /** The rungs this service's policy offers a tool, in ladder order. */
  readonly ladder: (tool: EntryToolFacts) => ReturnType<typeof entryLadder>
  /** The first fitting rung under this service's policy. */
  readonly choose: (tool: EntryToolFacts, fits: RungFits) => ReturnType<typeof chooseEntry>
  readonly rank: typeof rungRank
  readonly gates: typeof ENTRY_GATES
  readonly conventions: typeof ENTRY_CONVENTIONS
  readonly straightDescentAllowed: typeof straightDescentAllowed
  readonly parityTable: typeof PARITY_ENTRY_TABLE
  readonly parityEntryClasses: typeof parityEntryClasses
  readonly entrySpans: typeof entrySpans
}

export function createEntryService(policy: EntryPolicy = PARITY_ENTRY_POLICY): EntryService {
  return Object.freeze({
    policy,
    helix: Object.freeze({ build: buildHelix, fits: helixFits, orbitRadius: helixOrbitRadius, borePitch, threadPitch }),
    ramp: Object.freeze({ descent: rampDescent, alongContour: rampTo }),
    leads: Object.freeze({ straight: straightLead, polyline: polylineLead, arc: arcLead, arcMove: arcMoveLead, ramp: rampLead, helix: helixLead }),
    ladder: (tool: EntryToolFacts) => entryLadder(policy, tool),
    choose: (tool: EntryToolFacts, fits: RungFits) => chooseEntry(policy, tool, fits),
    rank: rungRank,
    gates: ENTRY_GATES,
    conventions: ENTRY_CONVENTIONS,
    straightDescentAllowed,
    parityTable: PARITY_ENTRY_TABLE,
    parityEntryClasses,
    entrySpans,
  })
}
