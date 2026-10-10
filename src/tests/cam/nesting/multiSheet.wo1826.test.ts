/* WO-1826: "a nest that overflows continues onto additional sheets, each
 * sheet its own program." Tests solveMultiSheet (multiSheetNest.ts), the
 * repeat-until-placed search layer that wraps solveNest the same way
 * solver.ts wraps packNest — see that file's header for the design.
 *
 * FIXTURE DESIGN: locked-rotation rectangles on a tall, narrow sheet (mirrors
 * solver.test.ts's approach) so the packer's single-column gravity heuristic
 * gives an EXACT, hand-derivable per-sheet capacity — no fuzzy "roughly fits".
 */
import { describe, it, expect } from 'vitest'
import { solveMultiSheet } from '../../../lib/cam/nesting/multiSheetNest'
import type { NestPart, NestRequest } from '../../../lib/cam/nesting'

function rect(id: string, w: number, h: number): NestPart {
  return {
    id,
    outer: [
      { x: 0, y: 0 },
      { x: w, y: 0 },
      { x: w, y: h },
      { x: 0, y: h },
    ],
    holes: [],
    lockedRotationDeg: 0,
  }
}

/** 10x10 squares, single 12-wide column, 55-tall sheet -> exactly 5 per sheet
 *  (floor(55/10) = 5; a 6th needs height 60 > 55). Mirrors solver.test.ts's
 *  fixSheet fixture, but with solver 'fixSheetExact' so overflow is genuine. */
function baseRequest(quantity: number): NestRequest {
  return {
    parts: [{ part: rect('sq', 10, 10), quantity }],
    sheet: { width: 12, height: 55 },
    style: 'ninety',
    spacing: { partGap: 0, sheetMargin: 0, windowGap: 0 },
    solver: { kind: 'fixSheetExact' },
    seed: 12345,
  }
}

describe('multiSheetNest: solveMultiSheet (WO-1826)', () => {
  it('a single-sheet-fits request produces exactly ONE sheet, nothing overflowed', async () => {
    // 40-part fixture, but on a sheet sized to hold all 40 (8 columns x 5 rows).
    const req: NestRequest = {
      parts: [{ part: rect('sq', 10, 10), quantity: 40 }],
      sheet: { width: 12 * 8, height: 55 },
      style: 'ninety',
      spacing: { partGap: 0, sheetMargin: 0, windowGap: 0 },
      solver: { kind: 'fixSheetExact' },
      seed: 12345,
    }
    const plan = await solveMultiSheet(req, { sheets: 'auto', maxSheets: 5 })
    expect(plan.sheets.length).toBe(1)
    expect(plan.sheets[0].result.unplaced).toEqual([])
    expect(plan.sheets[0].result.placements.length).toBe(40)
    expect(plan.neverPlaced).toEqual([])
    // extends, never replaces, the existing single-sheet over-capacity contract
    // (goldens.test.ts): the single-sheet-fits case is untouched by this WO.
  })

  it('a 40-part fixture on an undersized sheet overflows across 2+ sibling sheets, nothing dropped', async () => {
    const req = baseRequest(40) // 5 fit per sheet -> 8 sheets needed for all 40
    const plan = await solveMultiSheet(req, { sheets: 'auto', maxSheets: 10 })
    expect(plan.sheets.length).toBe(8)
    for (const s of plan.sheets.slice(0, 7)) {
      expect(s.result.placements.length).toBe(5)
      expect(s.result.unplaced.length).toBeGreaterThan(0)
    }
    expect(plan.sheets[7].result.placements.length).toBe(5)
    expect(plan.sheets[7].result.unplaced).toEqual([])
    const totalPlaced = plan.sheets.reduce((n, s) => n + s.result.placements.length, 0)
    expect(totalPlaced).toBe(40)
    expect(plan.neverPlaced).toEqual([])
    // no reshuffling: each sheet's request is exactly the previous sheet's
    // unplaced remainder.
    expect(plan.sheets[1].request.parts[0].quantity).toBe(35)
  })

  it('caps at maxSheets and names whatever still does not fit (ADR 0003, never silent)', async () => {
    const req = baseRequest(40) // needs 8 sheets; cap it at 3 -> 15 placed, 25 left
    const plan = await solveMultiSheet(req, { sheets: 'auto', maxSheets: 3 })
    expect(plan.sheets.length).toBe(3)
    const totalPlaced = plan.sheets.reduce((n, s) => n + s.result.placements.length, 0)
    expect(totalPlaced).toBe(15)
    expect(plan.neverPlaced).toEqual([{ partId: 'sq', count: 25 }])
  })

  it('a numeric `sheets` below maxSheets clamps the run to that count', async () => {
    const req = baseRequest(40)
    const plan = await solveMultiSheet(req, { sheets: 2, maxSheets: 10 })
    expect(plan.sheets.length).toBe(2)
    expect(plan.neverPlaced).toEqual([{ partId: 'sq', count: 30 }])
  })

  it('a numeric `sheets` above maxSheets is clamped DOWN to maxSheets, never grown past it', async () => {
    const req = baseRequest(40)
    const plan = await solveMultiSheet(req, { sheets: 9, maxSheets: 3 })
    expect(plan.sheets.length).toBe(3)
  })

  it('a part that fits on no sheet within the maximum is named, not dropped', async () => {
    // 20x20 square can never fit the 12-wide sheet at any sheet count.
    const req: NestRequest = {
      parts: [{ part: rect('big', 20, 20), quantity: 2 }],
      sheet: { width: 12, height: 55 },
      style: 'ninety',
      spacing: { partGap: 0, sheetMargin: 0, windowGap: 0 },
      solver: { kind: 'fixSheetExact' },
      seed: 12345,
    }
    const plan = await solveMultiSheet(req, { sheets: 'auto', maxSheets: 3 })
    expect(plan.sheets.length).toBe(3)
    for (const s of plan.sheets) expect(s.result.placements).toEqual([])
    expect(plan.neverPlaced).toEqual([{ partId: 'big', count: 2 }])
  })

  it('is deterministic: two runs of the same input produce byte-identical output', async () => {
    const req = baseRequest(17)
    const [a, b] = await Promise.all([
      solveMultiSheet(req, { sheets: 'auto', maxSheets: 5 }),
      solveMultiSheet(req, { sheets: 'auto', maxSheets: 5 }),
    ])
    expect(a).toEqual(b)
  })

  it('rejects any solver other than fixSheetExact (the only mode with genuine overflow)', async () => {
    const req = baseRequest(10)
    await expect(
      solveMultiSheet({ ...req, solver: { kind: 'fixSheet' } }, { sheets: 'auto', maxSheets: 3 }),
    ).rejects.toThrow(/fixSheetExact/)
  })
})
