import type { Units } from '../../types'
import { DIM_DECIMALS } from '../ui/unitFormat'

// WO-2877: a resolved length (a Smart height, a derived band edge) can carry
// float noise from the resolver's WCS/machine arithmetic - 5.00000005 or
// 15.0000001 - and an mm NumericInput prints up to ten decimals of it. Round
// the value a field SHOWS to the panel's length precision (DIM_DECIMALS.mm,
// the same 3 places fmtDim uses) so it reads 15 / 5 like every other length.
// Inch display already rounds inside NumericInput (4 places after /25.4), so
// the mm value passes through untouched there. Display only: the stored value
// is never rewritten, and an untouched field still commits nothing.
export function lengthFieldValue(valueMm: number, units?: Units): number {
  if (units === 'inch' || !Number.isFinite(valueMm)) return valueMm
  const rounded = Number(valueMm.toFixed(DIM_DECIMALS.mm))
  return Object.is(rounded, -0) ? 0 : rounded
}
