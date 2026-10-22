// WO-3017: the material service's parity policy, as data. Today's behaviour is
// written down here with its source; every new rule the alpha.3 study proposes
// is a policy value and every one is OFF. MD-50..MD-53 change which moves become
// rapids and where finishes start: CARD V02 before any of them ships, and MD-67
// (controller G0 semantics) closes first for 2.5D rapids.
import type { RemovedDefinition } from './contracts'

/** One of today's compensations for the centre-sampled field (MD-50 / CF-085). */
export interface Compensation {
  readonly name: 'one-cell pad' | 'half-cell widening' | 'cell overlap'
  readonly consumer: string
  readonly rule: string
  /** XY growth in cells of the field the consumer reads (1 = one cell; SQRT1_2 = half a diagonal). */
  readonly xyCells: number
  /** Z allowance: mm, or cells of resolution where `zCells` is set. */
  readonly zToleranceMm?: number
  readonly zCells?: number
  readonly source: readonly string[]
}

export const PARITY_COMPENSATIONS: readonly Compensation[] = Object.freeze(([
  {
    name: 'one-cell pad', consumer: '2D rest air (whole passes dropped)',
    rule: 'cutter bounding square grown by one cell; air when z + 1e-3 >= highest top under it; arcs never judged air',
    xyCells: 1, zToleranceMm: 1e-3,
    source: ['src/lib/cam/restAir2d.ts:134', 'src/lib/cam/restAir2d.ts:140'],
  },
  {
    name: 'half-cell widening', consumer: '3D finish air feed demotion and link lowering (single fed moves)',
    rule: 'link footprint widened by resolution x sqrt(1/2); an air feed must clear the top by resolution x sqrt(1/2)',
    xyCells: Math.SQRT1_2, zCells: Math.SQRT1_2,
    source: ['src/cam3d/integration/finishLinksOverRemovedStock.ts:97', 'src/cam3d/integration/airFeedOverRemovedStock.ts:238',
      'src/cam3d/integration/airFeedOverRemovedStock.ts:74'],
  },
  {
    name: 'cell overlap', consumer: 'clear-space / chamfer candidate sweep and the reach trim against stock',
    rule: 'a cell counts when the swept capsule may touch any part of it (separating-axis test, radius + cell x sqrt(1/2) + bias)',
    xyCells: Math.SQRT1_2,
    source: ['src/lib/cam/holderClearance.ts:1250', 'src/lib/cam/holderClearance.ts:1306', 'src/lib/cam/holderClearance.ts:1923'],
  },
] satisfies Compensation[]).map(c => Object.freeze(c)))

/** Today's top of cut per family (DUP-024; repository-record.md item 3). */
export const PARITY_TOP_OF_CUT = Object.freeze({
  '2.5D families': Object.freeze({
    mechanism: 'Smart Top replays the enabled ready earlier operations of the setup (0.2 mm field) and starts at the highest material over the region',
    source: ['src/store/index.ts:5018', 'src/store/toolReachInputs.ts:269'],
  }),
  adaptive_3d: Object.freeze({
    mechanism: 'starts from the retained z-dexel field of the immediately preceding ready adaptive_3d rough, else the stock box top',
    source: ['src/cam3d/integration/adaptive3dOperation.ts:471', 'src/store/index.ts:4777'],
  }),
  '3D finishes': Object.freeze({
    mechanism: 'no top of cut from material: the path is planned over the target surface, then fed moves over removed stock run at rapid with endpoints unchanged',
    source: ['src/lib/cam/smartHeights/policies.ts:179', 'src/cam3d/integration/airFeedOverRemovedStock.ts:1'],
  }),
})

/** Today's cross-operation hand-off: only a rough immediately after a 3D rough reuses its field. */
export const PARITY_HANDOFF = Object.freeze({
  rule: 'adjacent-roughs-only: the retained field is used only when the previous operation is the enabled, ready adaptive_3d that carved it',
  source: ['src/cam3d/integration/adaptive3dOperation.ts:471'],
})

/** Today's replay cutter per tool type (store remainingStockBefore). Undefined = not replayed. */
export const PARITY_REPLAY_CUTTER: Readonly<Record<string, { kind: 'flat' | 'ball'; lift: 'none' | 'drill point length' } | undefined>> = Object.freeze({
  flat_end_mill: { kind: 'flat', lift: 'none' },
  face_mill: { kind: 'flat', lift: 'none' },
  ball_end_mill: { kind: 'ball', lift: 'none' },
  bull_nose: { kind: 'ball', lift: 'none' },
  drill: { kind: 'flat', lift: 'drill point length' },
  spot_drill: { kind: 'flat', lift: 'drill point length' },
  center_drill: { kind: 'flat', lift: 'drill point length' },
})

/** The material service's policy. Parity values reproduce today; every new rule is OFF. */
export interface MaterialPolicy {
  /** MD-50: the removed definition sweeps and queries use. Parity: today's centre rule. */
  readonly removed_definition: RemovedDefinition
  /** MD-50: one air rule for every family (a fed move is air when its sweep removes nothing). */
  readonly single_air_rule: boolean
  /** MD-51: every family starts at the top of remaining material. */
  readonly top_of_cut_from_material: boolean
  /** MD-52: a rough after a non-adjacent rough starts from the remaining stock. */
  readonly non_adjacent_handoff: boolean
  /** MD-53: bull-nose and V-bit (and other profiles) replay with their own swept shape instead of PARITY_REPLAY_CUTTER. */
  readonly profile_replay: boolean
}

export const PARITY_POLICY: MaterialPolicy = Object.freeze({
  removed_definition: 'centre',
  single_air_rule: false,
  top_of_cut_from_material: false,
  non_adjacent_handoff: false,
  profile_replay: false,
})
