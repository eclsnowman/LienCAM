// ============================================================
// The post's G10 work-offset line (C-P1a)
// ============================================================
// The world->work transform itself MOVED to `src/lib/program/coords.ts`
// (ADR-0043 section 1): the live program builder needs the same transform, and
// ADR-0021's one-way rule forbids it importing the post. The post is now one
// of two callers of a single shared function rather than its owner.
//
// `toWork`/`toWorld` are re-exported from here unchanged so the post's own
// callers (and the simulation panel, which reads a work-coordinate position)
// keep one import path. The transform math is byte-identical - this is a move,
// not a rewrite; `src/tests/post/coords.test.ts` and
// `src/tests/post/combined-global-safez.test.ts` pass unaltered.

import type { WCS } from '../../types'
import type { PostConfig } from './types'
import { dimWord } from './format'

export { toWork, toWorld } from '../program/coords'

/** Map a fixture offset (54..59) to a G10 L2 P-number (1..6). */
export function fixtureOffsetToP(fixtureOffset: number): number {
  return fixtureOffset - 53
}

/** Build a `G10 L2 P<n> X.. Y.. Z..` line that writes the work offset for this
 *  WCS. Values are the WCS origin (world == machine in v1). Only emitted when
 *  options.writeWorkOffsets is set. */
export function g10Line(wcs: WCS, config: PostConfig): string {
  const p = fixtureOffsetToP(wcs.fixtureOffset)
  const d = config.format.xyzDecimals
  // The work-offset origin is set in the controller's active units; under G20 it
  // must be inches, so convert at the same dimensioned seam (ADR-0022).
  const u = config.format.units
  return [
    'G10',
    'L2',
    `P${p}`,
    dimWord('X', wcs.origin.x, d, u),
    dimWord('Y', wcs.origin.y, d, u),
    dimWord('Z', wcs.origin.z, d, u),
  ].join(' ')
}
