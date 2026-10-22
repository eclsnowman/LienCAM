// WO-3031 (alpha.3 A3-13): the entry policies. Every one is OFF: the service reproduces
// today's per-family entries. The operator named A-29 (slow plunge only for a rated tool, helix /
// ramp preferred), A-30 (working defaults) and A-34 (owned-tool / approach search before
// declared rest); each changes motion on approved routines, so nothing switches on until
// its before/after card. MD-68 (one helix form) and MD-70 (lead fields honoured) are cards.
//
// The A-29 rung is typed with its one alternative because the ladder's rung gate is
// policy logic only (no motion): the unit tests prove a non-rated tool never acquires it
// and that at parity no tool does. The other flags admit only their parity value; no
// alternative branch is built (decide-and-log in the WO).

export interface EntryPolicy {
  /** A-29 / REQ-ENTRY-3. Parity 'off': no slow-plunge rung; each family plunges as today
   *  (a plain feed descent at its plunge rate, decided by the family, never a ladder rung). */
  readonly slow_plunge_rung: 'off' | 'rated_tools_only'
  /** A-29 / REQ-ENTRY-2. Parity: a plunge carries the family's plunge rate as today. */
  readonly full_feed_plunge_guard: 'plunge_rate_as_today'
  /** A-30. Parity: today's defaults (gates.ts ENTRY_CONVENTIONS); no new starting limit. */
  readonly working_defaults: 'today'
  /** A-34 / REQ-ENTRY-4. Parity: no owned-tool / approach search; nothing is declared rest. */
  readonly tool_approach_search: 'off'
  /** MD-68 / REQ-ENTRY-5. Parity: each family's helix form (only Adaptive 3D ends with a full turn at depth). */
  readonly helix_form: 'per_family'
  /** MD-70 / REQ-ENTRY-7. Parity: the lead radius fields act only where today reads them. */
  readonly lead_fields_honoured: 'off'
}

export const PARITY_ENTRY_POLICY: EntryPolicy = Object.freeze({
  slow_plunge_rung: 'off',
  full_feed_plunge_guard: 'plunge_rate_as_today',
  working_defaults: 'today',
  tool_approach_search: 'off',
  helix_form: 'per_family',
  lead_fields_honoured: 'off',
})

/** What turning each flag on would do, the operator decision that names it, and the card it waits for. */
export const CARDED_ENTRY_ALTERNATIVES: Readonly<Record<keyof EntryPolicy, { readonly alternative: string; readonly named: string; readonly card: string }>> =
  Object.freeze({
    slow_plunge_rung: { alternative: 'rung 4: slow plunge at the reduced plunge feed, only for a centre-cutting or plunge-rated tool, only where no helix / ramp / open start fits', named: 'A-29', card: 'V01 (MD-69)' },
    full_feed_plunge_guard: { alternative: 'every straight descent into stock capped strictly below the cutting feed', named: 'A-29', card: 'V01' },
    working_defaults: { alternative: 'sourced entry conventions by material, tool and machine', named: 'A-30', card: 'V01' },
    tool_approach_search: { alternative: 'ask the tool-selection support over the owned inventory before declaring rest; an explicit tool is kept and a fitting alternative named', named: 'A-34', card: 'V01 (MD-115)' },
    helix_form: { alternative: 'one helix form for every family, full turn at depth decided by M-ENTRY-3', named: '-', card: 'V01 (MD-68)' },
    lead_fields_honoured: { alternative: 'Contour, Pocket and Face read their lead-in / lead-out radius; a lead that does not fit is the largest that fits', named: '-', card: 'V14 (MD-70)' },
  })
