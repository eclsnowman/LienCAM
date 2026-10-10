// cam3d stock: cutter radial height profile for sweep subtraction.
//
// height(r) = vertical offset of the cutter's lowest surface above the TIP at
// horizontal distance r from the tool axis. This is the one function the
// z-dexel sweep needs: with the tip at z, the tool occupies every column
// within radius R down to z + height(r) (and upward through the shank --
// which is exactly why one interval per column is exact for these cutters,
// D-016).
//
//   flat: height(r) = 0                      for r <= R (horizontal disc)
//   ball: height(r) = R - sqrt(R^2 - r^2)    for r <= R (sphere bottom)
//
// NOTE (unification debt, flagged in the Phase 2 digest): the kernel's
// dropCutter.ts encodes the same cutter shapes as per-triangle CONTACT tests
// but exposes no reusable height(r); when bull/vbit sweeps land, this profile
// and the kernel cutter model should merge into one radial-profile module.
// Until then bull/vbit FAIL LOUD here rather than silently under-removing.

import type { CutterSpec } from '../kernel/types';

/** Cutter kinds the Phase 2 sweep supports. */
export type SweepCutterKind = 'flat' | 'ball';

export interface SweepProfile {
  kind: SweepCutterKind;
  /** Cutter radius, mm. */
  radius: number;
}

/**
 * Validate a CutterSpec for sweeping and extract kind + radius. Throws for
 * bull/vbit (not yet supported -- see module header) and for non-positive or
 * non-finite diameters.
 */
export function sweepProfile(cutter: CutterSpec): SweepProfile {
  if (cutter.kind !== 'flat' && cutter.kind !== 'ball') {
    throw new Error(
      `stock sweep: cutter kind '${cutter.kind}' is not supported yet ` +
        `(Phase 2 sweeps flat and ball only; bull/vbit land with the unified ` +
        `kernel cutter profile).`,
    );
  }
  const d = cutter.diameter;
  if (!Number.isFinite(d) || d <= 0) {
    throw new Error(`stock sweep: cutter diameter must be positive and finite, got ${d}.`);
  }
  return { kind: cutter.kind, radius: d / 2 };
}

/**
 * Radial height profile, mm. Returns +Infinity for r > radius (the cutter
 * does not reach that column at all -- min() against +Infinity is a no-op,
 * which composes cleanly with the sweep's per-column min).
 */
export function profileHeight(kind: SweepCutterKind, radius: number, r: number): number {
  if (r > radius) return Number.POSITIVE_INFINITY;
  if (kind === 'flat') return 0;
  // ball: sphere of radius R centered R above the tip.
  const s = radius * radius - r * r;
  // r <= radius guarantees s >= 0 up to rounding; clamp the rounding case.
  return radius - Math.sqrt(s > 0 ? s : 0);
}
