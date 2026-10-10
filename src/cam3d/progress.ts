export interface Cam3dProgressTiming {
  phase: string;
  elapsedMs: number;
}

/** Structured progress for long 3D calculations. `fraction` is whole-job,
 * monotonic work-unit progress; `phaseFraction` is progress inside the named
 * phase. Timings are measured wall time, not estimates. */
export interface Cam3dProgressDetail {
  phase: string;
  step?: string;
  phaseFraction: number;
  elapsedMs: number;
  phaseElapsedMs: number;
  attempt: number;
  completedPhase?: Cam3dProgressTiming;
  longestPhase?: Cam3dProgressTiming;
}

export type Cam3dProgressCallback = (
  fraction: number,
  detail?: Cam3dProgressDetail,
) => void;
