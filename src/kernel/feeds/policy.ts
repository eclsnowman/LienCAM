// WO-3033: the feed/speed policies. Both carded changes ship OFF; turning one on is a
// later order with the operator's before/after card (rule 11 CARD class: each changes F or S).

export interface FeedPolicy {
  /** MD-75 (RC-019): feed AND spindle read the cutting-data entry keyed by the
   *  operation's material, then 'default', then the first entry. Off = today: the
   *  material is never consulted, spindle reads 'default' then the first entry, and
   *  feed reads 'default' only (a tool without one feeds at the safety fallbacks). */
  md75_material_entry: boolean
  /** MD-77: radial chip thinning raises the cutting feed by 1 / Kr when the request
   *  states the radial engagement (Kr = 2 sqrt(ae/D (1 - ae/D)), ae <= D/2). */
  md77_chip_thinning: boolean
}

/** Parity: every carded flag off. Frozen so no caller can turn one on by mutation. */
export const PARITY_FEED_POLICY: Readonly<FeedPolicy> = Object.freeze({
  md75_material_entry: false,
  md77_chip_thinning: false,
})
