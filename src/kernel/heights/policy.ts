// WO-3020 (alpha.3 A3-11): the heights policies. Each alternative changes tool Z
// on approved routines (rule 11 (b)), so each needs the operator's before/after card
// before it exists; until then the type admits only the parity value and no
// alternative branch is built (decide-and-log in the WO).

export interface HeightsPolicy {
  /** MD-55 / RC-009. Parity: the 3D rough starts at the stock box top. Card: `resolved_top`. */
  readonly top_source: 'stock_box_top'
  /** MD-57. Parity: a Top/Bottom override changes the plan, not the formula depth. */
  readonly override_moves_formula: false
  /** MD-58 / BL-398. Parity: the floor allowance applies to every level. */
  readonly floor_allowance_rough_only: false
  /** MD-59. Parity: no obstacle-raised Clearance; the plan warns "Fixture/clamp clearance is unverified." */
  readonly fixture_clearance: false
}

export const PARITY_POLICY: HeightsPolicy = Object.freeze({
  top_source: 'stock_box_top',
  override_moves_formula: false,
  floor_allowance_rough_only: false,
  fixture_clearance: false,
})

/** What turning each flag on would do, and the card it waits for. */
export const CARDED_ALTERNATIVES: Readonly<Record<keyof HeightsPolicy, { readonly alternative: string; readonly card: string }>> =
  Object.freeze({
    top_source: { alternative: 'resolved_top: 3D roughs start at the resolved Top / Material Start', card: 'MD-55' },
    override_moves_formula: { alternative: 'an override moves the formula depth', card: 'MD-57' },
    floor_allowance_rough_only: { alternative: 'allowance on roughing levels only; finish reaches the floor', card: 'MD-58' },
    fixture_clearance: { alternative: 'Clearance and Retract rise to obstacle top + standoff', card: 'MD-59' },
  })
