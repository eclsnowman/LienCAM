import { fromDisplay, toDisplay } from '../../lib/ui/unitFormat'
import type { Units } from '../../lib/ui/unitFormat'

/** WO-2534: the height offset box shows 3 decimals, the same as the WCS row
 * above it (15.2017213 -> 15.202), in mm and in inch. Display only: the stored
 * offset is never rounded, and NumericInput commits nothing for a box left
 * untouched, so the exact value survives. A typed value is committed as typed. */
export function heightOffsetBoxValue(valueMm: number, units: Units): number {
  const shown = Number(toDisplay(valueMm, units).toFixed(3))
  return units === 'mm' ? shown : fromDisplay(shown, units)
}
