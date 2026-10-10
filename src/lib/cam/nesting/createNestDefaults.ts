/* Default-params builder for the TEMPORARY "Create Nest (test)" trigger (P3.4).
 *
 * This is a thin, PURE seam so the trigger's parameter choices are unit-testable
 * without a React render. The real parametric create UI is P4 and will replace
 * this with user-driven inputs. Keep these defaults conservative and obviously
 * "test" values - they exist only so Operator can produce a nest and SEE it render.
 */

import type { CreateNestParams } from '../../../store'

/** Fixed defaults for the temporary test trigger (P3.4). Documented here so the
 *  single source of truth is the code, not a comment buried in the tree UI. */
export const CREATE_NEST_TEST_DEFAULTS = {
  /** Copies requested PER selected part. */
  quantityPerPart: 4,
  /** Sheet stock size (mm, ADR 0022). */
  sheet: { width: 300, height: 300 },
  /** Axis-aligned rotations only (0/90/180/270) for a predictable test layout. */
  style: 'ninety' as const,
  /** Clearances (mm): part-to-part gap, sheet keep-out border, in-window gap. */
  spacing: { partGap: 3, sheetMargin: 5, windowGap: 2 },
  /** Fixed seed -> deterministic, byte-identical packs across runs (ADR 0024). */
  seed: 1,
} as const

/** Build the CreateNestParams for the temporary test trigger from the set of
 *  currently-selected geometry part ids. Each selected part becomes one source
 *  with the default quantity; all other params come from CREATE_NEST_TEST_DEFAULTS.
 *  Returns null when no parts are selected (the trigger is disabled in that case;
 *  this guard makes the "nothing to nest" path explicit rather than dispatching an
 *  empty pack). curveTolerance is intentionally omitted -> the engine default. */
export function buildCreateNestParams(
  selectedIds: string[],
): CreateNestParams | null {
  // De-dup defensively; a part should not appear twice as a source.
  const ids = [...new Set(selectedIds.filter((id) => !!id))]
  if (ids.length === 0) return null
  return {
    sources: ids.map((geometryId) => ({
      geometryId,
      quantity: CREATE_NEST_TEST_DEFAULTS.quantityPerPart,
    })),
    sheet: { ...CREATE_NEST_TEST_DEFAULTS.sheet },
    style: CREATE_NEST_TEST_DEFAULTS.style,
    spacing: { ...CREATE_NEST_TEST_DEFAULTS.spacing },
    seed: CREATE_NEST_TEST_DEFAULTS.seed,
  }
}
