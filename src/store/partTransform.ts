// Coordinate hierarchy Phase 4 - Item 1: the single world-placement seam.
//
// `partWorldTransform` is the SOLE source of truth for "where does this part
// sit in the world (machine) frame, and how is it oriented". Every site that
// places a part group in the viewport should derive its placement from here
// rather than reading `geo.position` / `geo.rotation` directly.
//
// WHY a seam that does nothing today:
//   Under Q1 = Option 1 (machine-absolute coordinates + delta propagation by
//   membership id - see docs/planning/PHASE4-PLAN.md S3b), `geo.position` /
//   `geo.rotation` are already MACHINE-absolute for BOTH derived and explicit
//   members. There is exactly ONE coordinate meaning, so the world transform is
//   the stored transform unchanged (the identity). This helper is therefore
//   byte-identical to today's ad-hoc reads.
//
//   The value is the UPGRADE seam (ADR-0020 guardrails a/c):
//     - a future WORKSPACE tier (machine -> workspace -> stock -> geometry)
//       adds ONE compose step HERE - no call-site churn (guardrail a:
//       composable parent-child transforms).
//     - a future switch to Q1 = Option 2 (stored stock-RELATIVE local
//       transforms) does the compose `world = stockWorld * local` HERE, again
//       with no call-site churn. The `stocks` parameter is already threaded for
//       exactly that day.
//   Both upgrades are additive and driven purely by membership ids on the
//   children (guardrail c) - no `members[]` aggregate on the parent.
//
// This module is intentionally dependency-light: types only, no store / viewport
// imports, no side effects. It is a PURE function.

import type { ImportedGeometry, PhysicalStock, Vec3 } from '../types'

/** A part's resolved world (machine-frame) placement. */
export interface PartWorldTransform {
  position: Vec3
  rotation: Vec3
}

/**
 * Resolve a part's world placement.
 *
 * Option 1 (machine-absolute): the stored transform IS the world transform, so
 * this returns `geo.position` / `geo.rotation` unchanged for derived AND
 * explicit members alike. `stocks` is accepted now (and intentionally unused)
 * so the future workspace tier / stored-relative model composes here without
 * touching any call site.
 *
 * @param geo    the part whose world placement we want.
 * @param stocks the project's physical stocks (the future compose context).
 */
export function partWorldTransform(
  geo: ImportedGeometry,
  stocks: ReadonlyArray<PhysicalStock>,
): PartWorldTransform {
  // `stocks` is the future compose context (workspace tier / stored
  // stock-relative transform - see the module doc comment). Identity today
  // under Option 1, so it is intentionally unused; the `void` keeps the
  // parameter named and on the public signature without tripping
  // `noUnusedParameters`.
  void stocks
  return { position: geo.position, rotation: geo.rotation }
}
