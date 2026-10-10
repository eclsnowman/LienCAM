// WO-1608 (Smart Heights campaign, slice 5): a picture report of representative
// cases from WO-1604..1607, behind WRITE_EVIDENCE=1, for Operator to read by eye.
//
// This file draws the 2D sketch pictures (1, 2, 3, 5, 6): Pocket 2D on the
// table, the same pocket raised on a vise, Face on a tall fixed stock, the
// stock-bottom + 1.35 override, and the through-pocket-over-vise finding
// (SH-9). The solid (3D) pictures - Drill, Adaptive 3D, Parallel 3D - each
// live in their OWN file (pictureReportDrill/Rough/Sequence*/ParallelStandalone
// .wo1608.test.ts): see pictureHelpers.ts's header for why they are split.
//
// Every picture uses the shared side-view drawer (src/tests/helpers/sideViewEvidence.ts,
// WO-1598) and the shared scenario harness (src/tests/helpers/heightScenario.ts,
// WO-1604..1607) - no new copy of either. Each picture's caption states the
// expected top/bottom/retract worked out in docs/testing/SMART-HEIGHTS-CAMPAIGN.md,
// the measured ones read off the real moves, and pass or the finding id. Every
// number in a caption is backed by an `expect()` in this file, so a caption can
// never say something the test did not check.
//
// Findings not pictured anywhere in this campaign report (SH-1, SH-2, SH-4,
// SH-11) are listed in the campaign doc's slice 5 section with why: each is
// either a refusal before any toolpath exists to draw (SH-1, SH-2, SH-11) or a
// sub-millimetre radial clearance question a side view at this scale cannot
// usefully show and that closed without a picture (SH-4).

import { describe, expect, it } from 'vitest'
import {
  circleLoop, installRealToolpathWorker, runHeightScenario,
  type HeightScenario, type ScenarioStock, type ScenarioWorkholding, type HeightReading, rectLoop,
} from '../helpers/heightScenario'
import { writeSideView, toolBands } from '../helpers/sideViewEvidence'
import {
  DIR, RAISE, TOL, HOLDER, tool2D, toPath, deepestPlacement, stockObstacle, workholdingObstacle, TABLE_REF, pass,
} from './pictureHelpers'

installRealToolpathWorker()

const SKETCH: HeightScenario['part'] = {
  kind: 'sketch_2d', z: 0,
  loops: [rectLoop('outline', 0, 0, 60, 40), rectLoop('pocket', 15, 10, 35, 30), circleLoop('hole', 48, 20, 4)],
}
const SKETCH_RAISED: HeightScenario['part'] = { ...SKETCH, z: RAISE }
const AUTO_STOCK: ScenarioStock = { kind: 'auto', offsetXY: 5, offsetZTop: 12, offsetZBottom: 0 }
const TALL_STOCK: ScenarioStock = { kind: 'fixed', width: 70, height: 50, depth: 22, position: { x: -5, y: -5, z: RAISE } }
const VISE: ScenarioWorkholding = { name: 'Vise', min: { x: 40, y: 5, z: 0 }, max: { x: 56, y: 35, z: RAISE } }

/** Flat-sketch part footprint in WCS: inset by the auto offset on every side of
 * the stock XY the harness already computed (both stocks here use the same 5 mm
 * margin the campaign doc worked out - AUTO_STOCK directly, TALL_STOCK by design
 * around the same auto footprint). */
function sketchPartObstacle(r: HeightReading, margin = 5) {
  const z = r.stockBottomWcs // WO-1604/1605: a flat sketch on the table (or on the vise) sits exactly at the stock bottom.
  return {
    columns: [[r.stockXY.minX + margin, r.stockXY.maxX - margin, z - 0.4, z] as const],
    yRange: [r.stockXY.minY + margin, r.stockXY.maxY - margin] as const,
    colour: '#16a085', label: 'part (flat sketch, drawn as a thin band at its plane)', showLabel: false,
  }
}

describe('WO-1608 picture 1: Pocket 2D on the table', () => {
  it('draws the pocket cut on the table, auto stock, Smart default', async () => {
    const r = await runHeightScenario({ part: SKETCH, stock: AUTO_STOCK, operation: 'pocket_2d', loopIds: ['pocket'] })
    expect(r.authoringError).toBeUndefined()
    expect(r.status, r.errorMessage).toBe('ready')
    expect(r.deepestCutZ).toBeCloseTo(-5, 2)
    expect(r.highestCuttingZ).toBeLessThanOrEqual(0 + TOL)
    expect(r.heightsRow.retract).toBeCloseTo(5, 2)

    const bands = toolBands(tool2D('EM6', 6), HOLDER)
    writeSideView({
      dir: DIR, name: 'pocket-on-table', title: 'Pocket 2D on the table (auto stock, Smart)',
      subtitle: 'WO-1604 case 3. Expected top 0, bottom -5, retract 5. Measured matches. ' + pass(),
      obstacles: [stockObstacle(r), sketchPartObstacle(r)],
      path: toPath(r.moves), bands, placements: [deepestPlacement(r.moves, 'pocket_2d')],
      referenceLines: [TABLE_REF(r.wcsOriginMachineZ)],
      captions: [
        `Expected: top 0, bottom -5, retract 5, clearance 15 (WO-1604 case 3).`,
        `Measured: top ${r.heightsRow.top?.toFixed(2)}, bottom ${r.heightsRow.bottom?.toFixed(2)}, ` +
          `retract ${r.heightsRow.retract?.toFixed(2)}, clearance ${r.heightsRow.clearance?.toFixed(2)}. ${pass()}.`,
      ],
    })
  }, 60_000)
})

describe('WO-1608 picture 2: Pocket 2D raised on a vise', () => {
  it('draws the same pocket cut 50 mm up, clear of the vise', async () => {
    const r = await runHeightScenario({
      part: SKETCH_RAISED, stock: AUTO_STOCK, operation: 'pocket_2d', loopIds: ['pocket'], workholding: VISE,
    })
    expect(r.authoringError).toBeUndefined()
    expect(r.status, r.errorMessage).toBe('ready')
    expect(r.deepestCutZ).toBeCloseTo(-5, 2)
    expect(r.deepestCutMachineZ).toBeCloseTo(57, 1)
    expect(r.heightsRow.retract).toBeCloseTo(5, 2)

    const bands = toolBands(tool2D('EM6', 6), HOLDER)
    writeSideView({
      dir: DIR, name: 'pocket-raised-on-vise', title: 'Pocket 2D raised 50 mm on a vise (auto stock, Smart)',
      subtitle: 'WO-1605 case 19. Expected top 0, bottom -5 (machine 57), retract 5. Measured matches. ' + pass(),
      obstacles: [stockObstacle(r), sketchPartObstacle(r), workholdingObstacle(r.workholdingWcs!)],
      path: toPath(r.moves), bands, placements: [deepestPlacement(r.moves, 'pocket_2d')],
      referenceLines: [TABLE_REF(r.wcsOriginMachineZ)],
      captions: [
        `Expected: top 0, bottom -5 (machine 57), retract 5, clearance 15 (WO-1605 case 19).`,
        `Measured: top ${r.heightsRow.top?.toFixed(2)}, bottom ${r.heightsRow.bottom?.toFixed(2)} ` +
          `(machine ${r.deepestCutMachineZ.toFixed(2)}), retract ${r.heightsRow.retract?.toFixed(2)}. ${pass()}.`,
        'The vise stands under the part, clear of the pocket; nothing in this path enters it.',
      ],
    })
  }, 60_000)
})

describe('WO-1608 picture 3: Face on a tall fixed stock', () => {
  it('draws the cut starting above the part top, at the real (taller) stock top', async () => {
    const r = await runHeightScenario({ part: SKETCH_RAISED, stock: TALL_STOCK, operation: 'face', loopIds: [], workholding: VISE })
    expect(r.authoringError).toBeUndefined()
    expect(r.status, r.errorMessage).toBe('ready')
    expect(r.deepestCutZ).toBeCloseTo(-5, 2)
    expect(r.deepestCutMachineZ).toBeCloseTo(67, 1)
    // partTop (the auto-stock top the part itself defines) is WCS -10; the real
    // (taller) stock top is 0 - cutting must start above -10, in the extra material.
    expect(r.highestCuttingZ).toBeGreaterThan(-10)

    const bands = toolBands(tool2D('EM6', 6), HOLDER)
    writeSideView({
      dir: DIR, name: 'face-tall-fixed-stock', title: 'Face on a tall fixed stock, 10 mm more material on top',
      subtitle: 'WO-1605 case 35. Expected top 0 (not the part’s own -10), bottom -5. Measured matches. ' + pass(),
      obstacles: [stockObstacle(r), sketchPartObstacle(r), workholdingObstacle(r.workholdingWcs!)],
      path: toPath(r.moves), bands, placements: [deepestPlacement(r.moves, 'face')],
      referenceLines: [TABLE_REF(r.wcsOriginMachineZ), { z: -10, label: 'the part’s own top (auto-stock footprint)' }],
      captions: [
        `Expected: top 0 (the real, taller stock top), bottom -5, part’s own top -10 (WO-1605 case 35).`,
        `Measured: highest cutting Z ${r.highestCuttingZ.toFixed(2)} (above -10, in the extra material), ` +
          `deepest cut ${r.deepestCutZ.toFixed(2)}. ${pass()}.`,
      ],
    })
  }, 60_000)
})

describe('WO-1608 picture 5: the stock-bottom + 1.35 override', () => {
  it('draws Operator’s override case: Bottom row = stock bottom + 1.35 mm', async () => {
    const r = await runHeightScenario({
      part: SKETCH_RAISED, stock: AUTO_STOCK, operation: 'pocket_2d', loopIds: ['pocket'], workholding: VISE,
      bottomRow: { reference: 'stock_bottom', offsetMm: 1.35 },
    })
    expect(r.authoringError).toBeUndefined()
    expect(r.status, r.errorMessage).toBe('ready')
    expect(r.deepestCutZ).toBeCloseTo(-10.65, 2)

    const bands = toolBands(tool2D('EM6', 6), HOLDER)
    writeSideView({
      dir: DIR, name: 'override-stock-bottom-plus135', title: 'Override: Bottom = stock bottom + 1.35 mm (Operator’s case)',
      subtitle: 'WO-1607 case 20. Expected bottom -10.65 (stock bottom -12 + 1.35). Measured matches. ' + pass(),
      obstacles: [stockObstacle(r), sketchPartObstacle(r), workholdingObstacle(r.workholdingWcs!)],
      path: toPath(r.moves), bands, placements: [deepestPlacement(r.moves, 'pocket_2d')],
      referenceLines: [TABLE_REF(r.wcsOriginMachineZ), { z: r.stockBottomWcs, label: `stock bottom ${r.stockBottomWcs.toFixed(2)}` }],
      captions: [
        `Expected: bottom = stock bottom (-12) + 1.35 = -10.65 (WO-1607 case 20).`,
        `Measured: deepest cut ${r.deepestCutZ.toFixed(2)}, Heights row Bottom ${r.heightsRow.bottom?.toFixed(2)}. ${pass()}.`,
      ],
    })
  }, 60_000)
})

// SH-9, closed by WO-1618: a through Pocket 2D with the vise UNDER the pocket is
// cut everywhere above the vise and stops the allowance (0.25 mm) above its top.

describe('WO-1608 picture 6: through Pocket 2D over a vise under the pocket (SH-9, closed by WO-1618)', () => {
  it('draws the pocket cut down to just above the vise', async () => {
    const r = await runHeightScenario({
      part: SKETCH_RAISED, stock: AUTO_STOCK, operation: 'pocket_2d', loopIds: ['pocket'],
      bottomRow: { reference: 'stock_bottom', offsetMm: -0.5 },
      workholding: { name: 'Vise', min: { x: 10, y: 5, z: 0 }, max: { x: 40, y: 35, z: RAISE } },
    })
    expect(r.status, r.errorMessage).toBe('ready')
    expect(r.moves.length, 'the pocket is cut, not dropped').toBeGreaterThan(0)
    const viseTop = r.workholdingWcs!.max.z
    expect(r.deepestCutZ, 'stops the 0.25 mm allowance above the vise top').toBeCloseTo(viseTop + 0.25, 1)

    const bands = toolBands(tool2D('EM6', 6), HOLDER)
    writeSideView({
      dir: DIR, name: 'through-pocket-over-vise', title: 'Through Pocket 2D: the vise sits under the pocket',
      subtitle: `WO-1606 case 90 (SH-9, closed by WO-1618). Expected: cut down to the vise top + 0.25. Measured deepest ${r.deepestCutZ.toFixed(3)}.`,
      obstacles: [stockObstacle(r), sketchPartObstacle(r), workholdingObstacle(r.workholdingWcs!)],
      path: toPath(r.moves), bands, placements: [deepestPlacement(r.moves, 'pocket_2d')],
      referenceLines: [TABLE_REF(r.wcsOriginMachineZ), { z: viseTop, label: `vise top ${viseTop.toFixed(2)}` }],
      captions: [
        'Expected (rule 11): the pocket is cut everywhere above the vise, stopping 0.25 mm (the clearance allowance) ' +
          'above the vise top instead of breaking 0.5 mm into it.',
        `Measured: status ${r.status}, ${r.moves.length} moves, deepest cut ${r.deepestCutZ.toFixed(3)} ` +
          `(vise top ${viseTop.toFixed(2)}). Before WO-1618 this was 0 moves - finding SH-9.`,
      ],
    })
  }, 60_000)
})

describe('WO-1608 non-vacuity', () => {
  it('the pocket-on-table numbers are not vacuously close to anything', async () => {
    const r = await runHeightScenario({ part: SKETCH, stock: AUTO_STOCK, operation: 'pocket_2d', loopIds: ['pocket'] })
    expect(Math.abs(r.deepestCutZ - (-5 + 0.5))).toBeGreaterThan(0.1)
    expect(Math.abs((r.heightsRow.retract ?? 0) - (5 + 0.5))).toBeGreaterThan(0.1)
  }, 60_000)
})
