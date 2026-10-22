// WO-3026 (alpha.3 A3-12): the linking policies. Each alternative changes link motion or
// emitted G-code on approved routines (rule 11 (b)), so each waits for the operator's before/after
// card (V04 / V02). Until then the type admits only the parity value and no alternative
// branch is built (decide-and-log in the WO). MD-67 is a gate, not a policy here.

export interface LinkingPolicy {
  /** MD-60. Parity: each family links as today; the retract / transition fields are read by no builder (BL-226). */
  readonly policy_mapping: 'per_family'
  /** MD-61. Parity: each family keeps its own standoff constant (standoffs.ts). */
  readonly standoffs: 'per_family'
  /** MD-62. Parity: the 3D lane emits its 8 IR roles mapped as today (helix as ramp, ride as stepover). */
  readonly roles: 'ir_8_mapped'
  /** MD-63. Parity: each operation's own keep-down proof (corridor, centre line, cleared polygon, dexel). */
  readonly keepdown_proof: 'per_operation'
  /** MD-64. Parity: 2.5D rides at fast traverse, 3D rides at cutting feed. */
  readonly ride_feed: 'fast_2d_cutting_3d'
  /** MD-65. Parity: rest-aware link lowering and air-feed demotion run for 3D finishes only. */
  readonly rest_aware: 'finishes_3d_only'
  /** MD-66. Parity: waterline keeps its own linker and 10 deg ramp beside the raster linker. */
  readonly finish_linker_3d: 'per_family'
}

export const PARITY_LINKING_POLICY: LinkingPolicy = Object.freeze({
  policy_mapping: 'per_family',
  standoffs: 'per_family',
  roles: 'ir_8_mapped',
  keepdown_proof: 'per_operation',
  ride_feed: 'fast_2d_cutting_3d',
  rest_aware: 'finishes_3d_only',
  finish_linker_3d: 'per_family',
})

/** What turning each flag on would do, and the card it waits for. */
export const CARDED_LINKING_ALTERNATIVES: Readonly<Record<keyof LinkingPolicy, { readonly alternative: string; readonly card: string }>> =
  Object.freeze({
    policy_mapping: { alternative: 'per-case links from the retract / transition fields; 3D finishing uses the retract plane', card: 'MD-60' },
    standoffs: { alternative: 'one standoff-over-material table row for every family', card: 'MD-61' },
    roles: { alternative: 'all 12 roles emitted directly in 3D, one feed row each (helix, ride, plunge fed by their own row)', card: 'MD-62' },
    keepdown_proof: { alternative: 'the real tool profile swept through the material service; unproven links lift to the lowest proven height', card: 'MD-63' },
    ride_feed: { alternative: 'a ride proven in cleared air at fast traverse, else cutting feed, in both lanes', card: 'MD-64' },
    rest_aware: { alternative: 'rest-aware link lowering and air-feed-to-rapid for every operation (gated by MD-67)', card: 'MD-65' },
    finish_linker_3d: { alternative: 'one 3D finishing linker on the retract plane, one depth clip inserting the crossing point', card: 'MD-66' },
  })
