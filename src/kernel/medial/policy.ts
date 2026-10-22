// WO-3038 (alpha.3 A3-07): the medial-axis composition policies. Both are OFF: the service
// reproduces today's V-carve axis. MD-112 (a lone small circle gets a V-bit point plunge where
// today nothing is emitted) and MD-134 (V-carve flat clearing composed through the registry,
// following the entry hierarchy of src/kernel/entry/) each change emitted motion, so neither
// switches on until the operator's before/after card V23. As in the entry service (WO-3031), each
// flag admits only its parity value; no alternative branch is built.

export interface MedialPolicy {
  /** MD-112 / REQ-OP-vcarve-5. Parity 'off': a component whose axis is one point keeps
   *  today's result (a dimple only when the bit reaches depth there, else nothing). */
  readonly vcarve_dot_plunge: 'off'
  /** MD-134 / REQ-OP-vcarve-6. Parity 'built_in': V-carve clears its flat floor with its own
   *  ring fill and wall pass, as today. */
  readonly vcarve_flat_clearing: 'built_in'
}

export const PARITY_MEDIAL_POLICY: MedialPolicy = Object.freeze({
  vcarve_dot_plunge: 'off',
  vcarve_flat_clearing: 'built_in',
})

/** What turning each flag on would do, the merge decision that names it, and the card it waits for. */
export const CARDED_MEDIAL_ALTERNATIVES: Readonly<Record<keyof MedialPolicy, { readonly alternative: string; readonly named: string; readonly card: string }>> =
  Object.freeze({
    vcarve_dot_plunge: { alternative: 'a point site becomes one plunge at (r - tip radius) / tan(half angle), clipped to the maximum depth', named: 'MD-112', card: 'V23' },
    vcarve_flat_clearing: { alternative: 'flat clearing composed as a pocket through the registry, its derived parameters shown, entries from the entry hierarchy (MD-122)', named: 'MD-134', card: 'V23' },
  })
