// WO-3034 (alpha.3 A3-21): the kernel cheap estimators' records. Pure data.
// Estimates are read-only derived data (draft WO-A3-21, REQ-EST-7): never part of
// a generation fingerprint, never written into moves, never a refusal. An estimate
// that cannot be made says so in its own status; the operation is unaffected.
// The kernel may import only its own files and the pure modules the WO-2904
// boundary lists.

/**
 * - `available`: computed by the estimator's own model from the inputs it needs.
 * - `degraded`: computed, but by a fallback model or from incomplete inputs;
 *   `reason` names what is missing and what was used instead.
 * - `unavailable`: no value; `reason` says why in one line.
 */
export type EstimateStatus = 'available' | 'degraded' | 'unavailable'

export type Estimate<T> =
  | { readonly status: 'available'; readonly value: T; readonly assumptions: readonly string[] }
  | { readonly status: 'degraded'; readonly value: T; readonly reason: string; readonly assumptions: readonly string[] }
  | { readonly status: 'unavailable'; readonly reason: string; readonly assumptions: readonly string[] }

export interface CycleTimeValue {
  /** Machine time for the moves, ms, dwells included. */
  readonly ms: number
  /** `achievable-feed`: through the machine's accelerations; `distance-over-feed`: today's fallback. */
  readonly model: 'achievable-feed' | 'distance-over-feed'
  /** The machine facts the estimate used, in words. */
  readonly facts: readonly string[]
}

export interface CuspValue {
  /**
   * Largest cusp (scallop) height, mm. Not yet a promised quantity: read it with
   * maxStatus. The promised cusp quantity is the mean (WO-3034 audit ruling).
   */
  readonly maxMm: number
  /** 'unvalidated' until the max is checked against a dense geometric reference on production moves. */
  readonly maxStatus: 'validated' | 'unvalidated'
  /** Why the max is unvalidated (present when maxStatus is 'unvalidated'). */
  readonly maxReason?: string
  /** Mean over every spacing sample, mm: the validated cusp figure (BM-EST-cusp on the mean). */
  readonly meanMm: number
  /** Radius the cusp relation used, mm (ball radius, or a bull nose's corner radius). */
  readonly effectiveRadiusMm: number
  /** Spacing samples behind the numbers (0 for a programmed-stepover estimate). */
  readonly samples: number
}

export interface EngagementValue {
  /** Worst sustained window, fraction of a full-width slot with this cutter (1 = slot). */
  readonly peakFraction: number
  /** Length-weighted 95th percentile of the same windows. */
  readonly p95Fraction: number
  /** Lateral cutting length measured, mm. */
  readonly cuttingLengthMm: number
  /** Deepest axial slab the measured moves cut, mm. */
  readonly maxAxialDepthMm: number
  /** Replay cell the estimate ran at, mm (reported with the value, draft step 5). */
  readonly cellMm: number
}

export interface DeflectionProxyValue {
  /** The sourced model's proxy value (declared; no form is accepted yet, deflection.ts). */
  readonly proxy: number
  readonly stickOutMm: number
  readonly radialDepthMm: number
  readonly axialDepthMm: number
  readonly chipLoadMm: number
}

/** WO-3227: the programmed cut of a flat end mill on its side (cuttingLoad.ts). */
export interface ProgrammedCutLoad {
  /** fz, mm per tooth. */
  readonly feedPerToothMm: Estimate<number>
  /** Contact angle phi, radians. */
  readonly engagementAngleRad: Estimate<number>
  /** hmax, mm. */
  readonly maxChipMm: Estimate<number>
  /** hm, mm: the Kienzle chip. */
  readonly meanChipMm: Estimate<number>
  /** Q, cm3/min. */
  readonly removalRateCm3Min: Estimate<number>
  /** kc at hm, N/mm2; needs cutting coefficients. */
  readonly specificForceNMm2: Estimate<number>
  /** Net spindle power, W; needs cutting coefficients. */
  readonly powerW: Estimate<number>
  /** Spindle torque, N*m; needs cutting coefficients. */
  readonly torqueNm: Estimate<number>
  /** hmax is above zero and below RUBBING_CHIP_THICKNESS_MM: the edge may rub rather than cut. */
  readonly rubbing: boolean
}

export type EstimateMode = 'post-plan' | 'pre-plan'

/** One estimate set per operation and mode. Deterministic: two runs give equal sets. */
export interface EstimateSet {
  readonly mode: EstimateMode
  readonly cycleTime: Estimate<CycleTimeValue>
  readonly cusp: Estimate<CuspValue>
  readonly engagement: Estimate<EngagementValue>
  readonly deflection: Estimate<DeflectionProxyValue>
}

/** Wall time per estimator, ms. Timing is kept apart from the deterministic set. */
export interface EstimateCost {
  readonly cycleTimeMs: number
  readonly cuspMs: number
  readonly engagementMs: number
  readonly deflectionMs: number
}

export const available = <T>(value: T, assumptions: readonly string[] = []): Estimate<T> =>
  Object.freeze({ status: 'available' as const, value, assumptions })
export const degraded = <T>(value: T, reason: string, assumptions: readonly string[] = []): Estimate<T> =>
  Object.freeze({ status: 'degraded' as const, value, reason, assumptions })
export const unavailable = <T>(reason: string, assumptions: readonly string[] = []): Estimate<T> =>
  Object.freeze({ status: 'unavailable' as const, reason, assumptions })
