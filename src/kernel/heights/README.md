# Kernel heights service (WO-3020, alpha.3 A3-11 P2 parity slice)

The version-2 Smart Height resolver re-hosted in the kernel as the one heights
service for the 2.5D and 3D lanes. Headless: it imports only its own files and
`src/types`. Nothing in the app calls it (engine selector stays `current`;
`src/tests/kernel/boundary.wo2904.test.ts` proves no caller). Today's resolver,
`src/lib/cam/smartHeights/`, is not edited and stays the app's.

| Module | What | At parity with today's |
|---|---|---|
| contracts.ts | intent, evidence graph, resolved plan | `smartHeights/types.ts` (copy) |
| policies.ts | per-operation, per-variant policy registry | `smartHeights/policies.ts` (copy, deep-equal) |
| resolve.ts | `resolveHeightPlan`: precedence user override > operation policy > setup default | `smartHeights/resolve.ts` (copy; plane order via planeOrder.ts) |
| planeOrder.ts | the one validator: Clearance >= Retract >= Feed >= Top >= Bottom, WO-1621 lift | resolve.ts:804-838; agrees with adaptive3dOperation.ts:332 |
| formulas.ts | chamfer, thread band, engrave depth / line width, V-carve depth and bands | the four family evidence builders |
| levels.ts | `buildDepthLevels`: fixed_step, adaptive_2d, even_3d, waterline | the five 2.5D `buildDepths` copies, `scheduledDepths`, `planLevels`, `planWaterlineLevels` |
| builder.ts | one plan-to-builder conversion: 2.5D worker heights, 3D local planes, dependency ids, `bindUnprovenStockTop` | face/pattern/thread-mill and the six 3D family conversions |
| fingerprint.ts | one evidence fingerprint convention | `smartHeightEvidenceFingerprint` |
| policy.ts, service.ts | `PARITY_POLICY`, `createHeightsService()` | - |

Today's behaviour kept, recorded, not changed: Top = Bottom is refused unless
the end is a spatial target field; the 2.5D fixed-step ladder gives it one
level, Adaptive 2D none.

Policies (all at parity; each alternative changes tool Z on approved routines
and needs the operator's before/after card before it is built): `top_source`
(`stock_box_top`, MD-55), `override_moves_formula` (off, MD-57),
`floor_allowance_rough_only` (off, MD-58), `fixture_clearance` (off, MD-59).

Legacy height fields are not carried (ADR-0040); the RC-025 field-by-field
search is `src/tests/evidence/WO-3020/rc025-legacy-fields.md`.

Proof: `src/tests/kernel/heightsParity.wo3020.test.ts` (every production
resolution replayed on the kernel; table in `src/tests/evidence/WO-3020/parity.json`),
`src/tests/kernel/heightsUnits.wo3020.test.ts`, `feature-proof.json`,
`negative-control.json`.
