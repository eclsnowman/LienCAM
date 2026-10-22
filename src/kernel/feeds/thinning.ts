// WO-3033 (MD-77, OFF): the radial chip-thinning relation (alpha3-17 A.4.1).
// Kr = h_max / f_z for a straight-flute cutter at radial engagement ae:
// 2 sqrt(ae/D (1 - ae/D)) below half the diameter, 1 at or above it.
// A.4.1 example: ae = 0.10 D -> Kr = 0.60. Same relation as the WO-2900 settings
// collector (src/tests/benchmark/settingsMetrics.alpha3.ts radialFactor).

export function chipThinningFactor(aeOverD: number): number {
  if (!Number.isFinite(aeOverD) || aeOverD <= 0) throw new Error('chip thinning: radial engagement must be a positive fraction of D')
  return aeOverD >= 0.5 ? 1 : 2 * Math.sqrt(aeOverD * (1 - aeOverD))
}
