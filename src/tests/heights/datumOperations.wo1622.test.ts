// WO-1622: Smart Heights for Chamfer, Engrave, V-carve and Thread Mill, plus
// Adaptive 3D's Clearance/Retract/Feed safety row and a raised-Top case.
//
// Chamfer, Engrave, V-carve and Thread Mill share one shape: a datum plane
// (reference + offset) and a depth formula, authored directly through
// heightScenario's new branches (WO-1622) - there is no separate Bottom/Top
// row override mechanism for them, unlike the planar-rough family WO-1607
// tested. "Smart" below means the dialog's own default datum reference
// (geometry_face for Chamfer/Thread Mill, stock_top for Engrave/V-carve);
// depth itself has no dialog-proposed default for any of the four (unlike
// Face/Pocket/Drill's "no floor -> 5mm" proposal), so the depth used in the
// "Smart" case here is this test's own reasonable operator choice, decided
// and logged in the WO's result section, not a product default.
//
// Frame: WO-1605's raised sketch on a vise (RAISE 50mm), auto stock (as
// WO-1607's override grid used). Chamfer/Engrave/V-carve run only on that
// frame, not also on the table: WO-1607 already established the arithmetic
// is WCS-invariant under a uniform raise (the sketch and the stock rise
// together), and this WO-1622 grid reconfirms that identity while the vise
// gives every case a live "did anything enter the workholding" check the
// table frame cannot offer. Thread Mill instead runs the grid on the table
// (its 'hole' loop sits over the vise footprint) plus one raised case to
// characterize what happens when a thread's own hole is over workholding.

import { describe, expect, it, vi } from 'vitest'
import { typedMock } from '../support/typedMock'

// WO-1622's Adaptive 3D cases reuse WO-1606's solid-import path (runSolidScenario),
// which routes four browser-only transports to node; the mocks must live in the
// test file (module mocks), same as solids3d.wo1606.test.ts.
vi.mock('../../lib/stepCache', async (importOriginal) => typedMock<typeof import('../../lib/stepCache')>({
  ...(await importOriginal<typeof import('../../lib/stepCache')>()),
  loadCachedStep: async (geoId: string) => (await import('../helpers/heightScenario')).solidStepBytes(geoId),
}))
vi.mock('../../cam3d/integration/parallel3dOperation', async (importOriginal) =>
  typedMock<typeof import('../../cam3d/integration/parallel3dOperation')>({
    ...(await importOriginal<typeof import('../../cam3d/integration/parallel3dOperation')>()),
    acquirePartMesh: async (source, tolerance) =>
      (await import('../helpers/heightScenario')).tessellateSolid(source, tolerance),
  }))
vi.mock('../../cam3d/integration/appClient', async (importOriginal) =>
  typedMock<typeof import('../../cam3d/integration/appClient')>({
    ...(await importOriginal<typeof import('../../cam3d/integration/appClient')>()),
    getCam3dClient: () => scenarioModule.inProcessCam3dClient(),
    disposeCam3dClient: () => {},
  }))
vi.mock('../../lib/cam/geometry/occt/model/modelClient', async (importOriginal) =>
  typedMock<typeof import('../../lib/cam/geometry/occt/model/modelClient')>({
    ...(await importOriginal<typeof import('../../lib/cam/geometry/occt/model/modelClient')>()),
    deriveHoles: async (geoId: string) =>
      (await import('../helpers/heightScenario')).deriveHolesInProcess(geoId),
  }))

import * as scenarioModule from '../helpers/heightScenario'
import {
  circleLoop, installRealToolpathWorker, movesEnteringBox, rectLoop, runHeightScenario, runSolidScenario,
  type HeightScenario, type ScenarioWorkholding, type ScenarioStock,
} from '../helpers/heightScenario'

installRealToolpathWorker()

const OUTLINE = rectLoop('outline', 0, 0, 60, 40)
const POCKET = rectLoop('pocket', 15, 10, 35, 30)
const HOLE = circleLoop('hole', 48, 20, 4)

const RAISE = 50
const AUTO_STOCK = { kind: 'auto' as const, offsetXY: 5, offsetZTop: 12, offsetZBottom: 0 }
const VISE: ScenarioWorkholding = { name: 'Vise', min: { x: 40, y: 5, z: 0 }, max: { x: 56, y: 35, z: 50 } }

const EPS = 0.01

function raisedScenario(op: HeightScenario['operation'], loop: { id: string }, extra: Partial<HeightScenario>): HeightScenario {
  return {
    part: { kind: 'sketch_2d', loops: [OUTLINE, POCKET, HOLE], z: RAISE },
    stock: AUTO_STOCK, workholding: VISE, operation: op, loopIds: [loop.id], ...extra,
  }
}

function tableScenario(op: HeightScenario['operation'], loop: { id: string }, extra: Partial<HeightScenario>): HeightScenario {
  return {
    part: { kind: 'sketch_2d', loops: [OUTLINE, POCKET, HOLE], z: 0 },
    stock: AUTO_STOCK, operation: op, loopIds: [loop.id], ...extra,
  }
}

// ─── Chamfer (datum: geometry_face -> the sketch plane, WCS -12) ───────────

describe('WO-1622 Chamfer: datum plane + depth formula, raised on a vise', () => {
  it('Smart: geometry_face datum, default width 1mm', async () => {
    const reading = await runHeightScenario(raisedScenario('chamfer', OUTLINE, {}))
    expect(reading.status).toBe('ready')
    expect(reading.heightsRow.top).toBeCloseTo(-12, 2)
    expect(reading.heightsRow.bottom).toBeCloseTo(-13, 2)
    expect(reading.heightsRow.retract).toBeCloseTo(5, 2)
    expect(reading.heightsRow.clearance).toBeCloseTo(15, 2)
    expect(reading.deepestCutZ).toBeCloseTo(-13, 2)
    expect(reading.highestCuttingZ).toBeLessThanOrEqual(-12 + EPS)
    expect(movesEnteringBox(reading.moves, reading.workholdingWcs!, 3).length).toBe(0)
  })

  it('depth override: chamferWidth 3mm', async () => {
    const reading = await runHeightScenario(raisedScenario('chamfer', OUTLINE, { datumFormula: { depthMm: 3 } }))
    expect(reading.status).toBe('ready')
    expect(reading.heightsRow.top).toBeCloseTo(-12, 2)
    expect(reading.heightsRow.bottom).toBeCloseTo(-15, 2)
    expect(reading.deepestCutZ).toBeCloseTo(-15, 2)
  })

  it('Top override: an absolute WCS plane instead of geometry_face', async () => {
    const reading = await runHeightScenario(raisedScenario('chamfer', OUTLINE, {
      datumFormula: { datumReference: 'wcs_plane', datumOffsetMm: -5 },
    }))
    expect(reading.status).toBe('ready')
    expect(reading.heightsRow.top).toBeCloseTo(-5, 2)
    expect(reading.heightsRow.bottom).toBeCloseTo(-6, 2)
    expect(reading.heightsRow.retract).toBeCloseTo(5, 2)
    expect(reading.heightsRow.clearance).toBeCloseTo(15, 2)
  })

  it('Retract = WCS 20: Clearance follows, Top/Bottom untouched', async () => {
    const reading = await runHeightScenario(raisedScenario('chamfer', OUTLINE, {
      safetyOverride: { plane: 'retract', reference: 'wcs_plane', offsetMm: 20 },
    }))
    expect(reading.status).toBe('ready')
    expect(reading.heightsRow.top).toBeCloseTo(-12, 2)
    expect(reading.heightsRow.bottom).toBeCloseTo(-13, 2)
    expect(reading.heightsRow.retract).toBeCloseTo(20, 2)
    expect(reading.heightsRow.clearance).toBeCloseTo(30, 2)
  })
})

// ─── Engrave (datum: stock_top, WCS 0; depth explicit, this test's own 1mm) ─

describe('WO-1622 Engrave: datum plane + depth formula, raised on a vise', () => {
  it('Smart: stock_top datum, this test\'s 1mm depth', async () => {
    const reading = await runHeightScenario(raisedScenario('engrave', POCKET, { datumFormula: { depthMm: 1 } }))
    expect(reading.status).toBe('ready')
    expect(reading.heightsRow.top).toBeCloseTo(0, 2)
    expect(reading.heightsRow.bottom).toBeCloseTo(-1, 2)
    expect(reading.heightsRow.retract).toBeCloseTo(5, 2)
    expect(reading.heightsRow.clearance).toBeCloseTo(15, 2)
    expect(reading.deepestCutZ).toBeCloseTo(-1, 2)
    expect(reading.highestCuttingZ).toBeLessThanOrEqual(0 + EPS)
    expect(movesEnteringBox(reading.moves, reading.workholdingWcs!, 3).length).toBe(0)
  })

  it('depth override: 3mm', async () => {
    const reading = await runHeightScenario(raisedScenario('engrave', POCKET, { datumFormula: { depthMm: 3 } }))
    expect(reading.status).toBe('ready')
    expect(reading.heightsRow.top).toBeCloseTo(0, 2)
    expect(reading.heightsRow.bottom).toBeCloseTo(-3, 2)
    expect(reading.deepestCutZ).toBeCloseTo(-3, 2)
  })

  it('Top override: stock_top - 5', async () => {
    const reading = await runHeightScenario(raisedScenario('engrave', POCKET, {
      datumFormula: { datumOffsetMm: -5, depthMm: 1 },
    }))
    expect(reading.status).toBe('ready')
    expect(reading.heightsRow.top).toBeCloseTo(-5, 2)
    expect(reading.heightsRow.bottom).toBeCloseTo(-6, 2)
    expect(reading.heightsRow.retract).toBeCloseTo(5, 2)
    expect(reading.heightsRow.clearance).toBeCloseTo(15, 2)
  })

  it('Retract = WCS 20: Clearance follows, Top/Bottom untouched', async () => {
    const reading = await runHeightScenario(raisedScenario('engrave', POCKET, {
      datumFormula: { depthMm: 1 },
      safetyOverride: { plane: 'retract', reference: 'wcs_plane', offsetMm: 20 },
    }))
    expect(reading.status).toBe('ready')
    expect(reading.heightsRow.top).toBeCloseTo(0, 2)
    expect(reading.heightsRow.bottom).toBeCloseTo(-1, 2)
    expect(reading.heightsRow.retract).toBeCloseTo(20, 2)
    expect(reading.heightsRow.clearance).toBeCloseTo(30, 2)
  })
})

// ─── V-carve (datum: stock_top; flat depth: tool_limit for a 45deg V-bit) ──

describe('WO-1622 V-carve: datum plane + depth formula, raised on a vise', () => {
  it('Smart: stock_top datum, tool-limit depth (3mm for this 6mm 45deg V-bit)', async () => {
    const reading = await runHeightScenario(raisedScenario('vcarve', POCKET, {}))
    expect(reading.status).toBe('ready')
    expect(reading.heightsRow.top).toBeCloseTo(0, 2)
    expect(reading.heightsRow.bottom).toBeCloseTo(-3, 2)
    expect(reading.heightsRow.retract).toBeCloseTo(5, 2)
    expect(reading.heightsRow.clearance).toBeCloseTo(15, 2)
    expect(reading.deepestCutZ).toBeCloseTo(-3, 2)
    expect(reading.highestCuttingZ).toBeLessThanOrEqual(0 + EPS)
    expect(movesEnteringBox(reading.moves, reading.workholdingWcs!, 3).length).toBe(0)
  })

  it('depth override: explicit flat depth 2mm', async () => {
    const reading = await runHeightScenario(raisedScenario('vcarve', POCKET, { datumFormula: { depthMm: 2 } }))
    expect(reading.status).toBe('ready')
    expect(reading.heightsRow.top).toBeCloseTo(0, 2)
    expect(reading.heightsRow.bottom).toBeCloseTo(-2, 2)
    expect(reading.deepestCutZ).toBeCloseTo(-2, 2)
  })

  it('Top override: stock_top - 5, tool-limit depth still applies', async () => {
    const reading = await runHeightScenario(raisedScenario('vcarve', POCKET, {
      datumFormula: { datumOffsetMm: -5 },
    }))
    expect(reading.status).toBe('ready')
    expect(reading.heightsRow.top).toBeCloseTo(-5, 2)
    expect(reading.heightsRow.bottom).toBeCloseTo(-8, 2)
    expect(reading.heightsRow.retract).toBeCloseTo(5, 2)
    expect(reading.heightsRow.clearance).toBeCloseTo(15, 2)
  })

  it('Retract = WCS 20: Clearance follows, Top/Bottom untouched', async () => {
    const reading = await runHeightScenario(raisedScenario('vcarve', POCKET, {
      safetyOverride: { plane: 'retract', reference: 'wcs_plane', offsetMm: 20 },
    }))
    expect(reading.status).toBe('ready')
    expect(reading.heightsRow.top).toBeCloseTo(0, 2)
    expect(reading.heightsRow.bottom).toBeCloseTo(-3, 2)
    expect(reading.heightsRow.retract).toBeCloseTo(20, 2)
    expect(reading.heightsRow.clearance).toBeCloseTo(30, 2)
  })
})

// ─── Thread Mill (datum: geometry_face; internal, explicit band, on the table) ─

describe('WO-1622 Thread Mill: datum plane + depth formula, on the table', () => {
  it('Smart: geometry_face datum, default 9mm thread depth', async () => {
    const reading = await runHeightScenario(tableScenario('thread_mill', HOLE, {}))
    expect(reading.status).toBe('ready')
    expect(reading.heightsRow.top).toBeCloseTo(-12, 2)
    expect(reading.heightsRow.bottom).toBeCloseTo(-21, 2)
    expect(reading.heightsRow.retract).toBeCloseTo(5, 2)
    expect(reading.heightsRow.clearance).toBeCloseTo(15, 2)
    expect(reading.deepestCutZ).toBeCloseTo(-21, 2)
  })

  it('depth override: 4mm thread', async () => {
    const reading = await runHeightScenario(tableScenario('thread_mill', HOLE, { datumFormula: { depthMm: 4 } }))
    expect(reading.status).toBe('ready')
    expect(reading.heightsRow.top).toBeCloseTo(-12, 2)
    expect(reading.heightsRow.bottom).toBeCloseTo(-16, 2)
    expect(reading.deepestCutZ).toBeCloseTo(-16, 2)
  })

  it('Top override: an absolute WCS plane instead of geometry_face', async () => {
    const reading = await runHeightScenario(tableScenario('thread_mill', HOLE, {
      datumFormula: { datumReference: 'wcs_plane', datumOffsetMm: -3, depthMm: 4 },
    }))
    expect(reading.status).toBe('ready')
    expect(reading.heightsRow.top).toBeCloseTo(-3, 2)
    expect(reading.heightsRow.bottom).toBeCloseTo(-7, 2)
    expect(reading.heightsRow.retract).toBeCloseTo(5, 2)
    expect(reading.heightsRow.clearance).toBeCloseTo(15, 2)
  })

  it('Retract = WCS 20: Clearance follows, Top/Bottom untouched', async () => {
    const reading = await runHeightScenario(tableScenario('thread_mill', HOLE, {
      safetyOverride: { plane: 'retract', reference: 'wcs_plane', offsetMm: 20 },
    }))
    expect(reading.status).toBe('ready')
    expect(reading.heightsRow.top).toBeCloseTo(-12, 2)
    expect(reading.heightsRow.bottom).toBeCloseTo(-21, 2)
    expect(reading.heightsRow.retract).toBeCloseTo(20, 2)
    expect(reading.heightsRow.clearance).toBeCloseTo(30, 2)
  })

  // SH-12: the 'hole' loop this campaign's sketch carries sits at X44..52,
  // Y16..24 - inside the raised scenario's vise footprint (X40..56, Y5..35).
  // geometry_face resolves to the sketch's own plane (WCS -12 here, same as
  // every placement), which is also exactly the vise's own top in this frame -
  // so an internal thread milled downward by 4mm from that datum should reach
  // WCS -16 (0.25mm short of the vise, matching Pocket's own SH-9 clearance).
  // The Heights row DOES claim Bottom -16 (identical to the table case) - but
  // the real moves stop at WCS -11.75, a full 4.25mm short of the row's own
  // number and only 0.25mm below the datum itself. Something trims Thread
  // Mill's helix/plunge moves at the workholding without telling the row -
  // the outcome the WO asks to prove never happens ("The Heights row and the
  // moves never disagree").
  it.fails('SH-12: the Heights row and the moves disagree once the hole sits over the vise', async () => {
    const reading = await runHeightScenario(raisedScenario('thread_mill', HOLE, { datumFormula: { depthMm: 4 } }))
    expect(reading.status).toBe('ready')
    expect(reading.heightsRow.top).toBeCloseTo(-12, 2)
    expect(reading.heightsRow.bottom).toBeCloseTo(-16, 2)
    expect(movesEnteringBox(reading.moves, reading.workholdingWcs!, 3).length).toBe(0)
    // The real teeth of this finding: the row's own Bottom number is what the
    // moves should reach.
    expect(reading.deepestCutZ).toBeCloseTo(reading.heightsRow.bottom!, 2)
  })
})

// ─── Adaptive 3D: the Clearance/Retract/Feed row, and a raised Top (WO-1621) ─
//
// WO-1606's closed box (30x20x10), auto stock (offsets XY 5, Z top 3): WCS
// stock top 0, box top -3, box bottom -13, stock bottom -13 (docs/testing/
// SMART-HEIGHTS-CAMPAIGN.md slice 3's BOX_FRAME.auto). A vise under the box
// footprint only (X5..25, Y5..15) on the raised placement, exactly WO-1606's
// BOX_VISE, so raised reuses the same already-proven clearance.

const BOX_VISE: ScenarioWorkholding = { name: 'Vise', min: { x: 5, y: 5, z: 0 }, max: { x: 25, y: 15, z: RAISE } }
function boxAutoStock(): ScenarioStock {
  return { kind: 'auto', offsetXY: 5, offsetZTop: 3, offsetZBottom: 0 }
}

describe('WO-1622 Adaptive 3D: the safety row, table and raised', () => {
  it.each([
    { placement: 'table' as const, z: 0 },
    { placement: 'raised' as const, z: RAISE },
  ])('Retract = WCS 20 ($placement): Clearance follows, Top/Bottom untouched', async ({ placement, z }) => {
    const [reading] = await runSolidScenario({
      part: 'closed_box', z, stock: boxAutoStock(),
      workholding: placement === 'raised' ? BOX_VISE : undefined,
      operations: [{
        kind: 'adaptive_3d', source: 'current_material', toolDiameter: 6, axialStockToLeave: 0.5,
        params: { useStockBoundary: true },
        safetyOverride: { plane: 'retract', reference: 'wcs_plane', offsetMm: 20 },
      }],
    })
    expect(reading.status).toBe('ready')
    expect(reading.heightsRow.top).toBeCloseTo(0, 2)
    expect(reading.heightsRow.bottom).toBeCloseTo(-12.5, 2)
    expect(reading.heightsRow.retract).toBeCloseTo(20, 2)
    expect(reading.heightsRow.clearance).toBeCloseTo(30, 2)
    expect(reading.deepestCutZ).toBeCloseTo(-12.5, 2)
    if (placement === 'raised') {
      expect(movesEnteringBox(reading.moves, reading.workholdingWcs!, 3).length).toBe(0)
    }
  })

  // WO-1621 (SH-11 closed): raising Top above the Setup's default Retract (5)
  // used to refuse outright (invalid_plane_order); it now lifts Retract (and,
  // if needed, Clearance) to follow instead. Adaptive 3D has no generic Top
  // row - its bounded_band mode authors an explicit Top/Bottom pair directly -
  // so Top = stock top + 2 is authored as band {2, -8}, mirroring WO-1606's
  // own explicit-band case (band -1..-8, deepest -7.5 after its 0.5mm axial
  // stock to leave). Feed = Top + 5 = 7 (formula, tracks this op's own Top);
  // Retract's own formula (stock_top + 5 = 5) is below that floor and is not
  // user-set, so it lifts to 7. Clearance's formula reads the unlifted Retract
  // (5) + 10 = 15, and 15 is already above the lifted Retract's floor (7), so
  // Clearance is untouched at 15.
  it.each([
    { placement: 'table' as const, z: 0 },
    { placement: 'raised' as const, z: RAISE },
  ])('Top = stock top + 2 ($placement): Feed and Retract lift, no refusal', async ({ placement, z }) => {
    const [reading] = await runSolidScenario({
      part: 'closed_box', z, stock: boxAutoStock(),
      workholding: placement === 'raised' ? BOX_VISE : undefined,
      operations: [{
        kind: 'adaptive_3d', source: 'bounded_band', band: { topWcsMm: 2, bottomWcsMm: -8 },
        toolDiameter: 6, axialStockToLeave: 0.5, params: { useStockBoundary: true },
      }],
    })
    expect(reading.status).toBe('ready')
    expect(reading.heightsRow.top).toBeCloseTo(2, 2)
    // The row already carries the 0.5mm axial stock to leave (-8 + 0.5), the
    // same number the real moves reach - row and moves agree.
    expect(reading.heightsRow.bottom).toBeCloseTo(-7.5, 2)
    expect(reading.heightsRow.retract).toBeCloseTo(7, 2)
    expect(reading.heightsRow.clearance).toBeCloseTo(15, 2)
    expect(reading.deepestCutZ).toBeCloseTo(-7.5, 2)
    expect(reading.highestCuttingZ).toBeLessThanOrEqual(2 + 0.01)
    if (placement === 'raised') {
      expect(movesEnteringBox(reading.moves, reading.workholdingWcs!, 3).length).toBe(0)
    }
  })
})
