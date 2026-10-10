/* WO-1826: nest overflow orchestration — "a nest that overflows continues onto
 * additional sheets, each sheet its own program."
 *
 * Operator's D9 ruling (2026-09-22, MC card): separate program per sheet, never one
 * program with an operator pause. Combined with project.nests already being
 * NestRecord[] (ADR 0024), this makes each overflow sheet a SIBLING record run
 * through the EXISTING single-sheet solve/toolpath/post pipeline, unchanged —
 * no new cross-sheet data model. This file is the repeat-until-placed search
 * layer that WRAPS solveNest (solver.ts) the same way solver.ts itself wraps
 * packNest (index.ts): it does not re-implement packing.
 *
 * Only the 'fixSheetExact' objective (fixed WxH, EXACT requested quantities,
 * leftovers reported explicitly — ADR 0003) has a meaningful notion of
 * "overflow": fixSheet scales UP to fill one sheet and fixQty/fixQtyRatio SIZE
 * the sheet to fit everything, so neither ever leaves genuine leftovers to
 * carry onto a next sheet. Any other solver.kind is a caller error here.
 *
 * DETERMINISM: every sheet is solved with the SAME req.seed (the request's
 * "deterministic seed policy") — this is a pure function of the input, never
 * wall-clock. Once a part is placed on a sheet it is never revisited by a
 * later sheet (no reshuffling): each sheet's request contains only the
 * previous sheet's `unplaced` parts.
 */

import type { NestPart, NestRequest, NestResult } from './types'
import { solveNest } from './solver'

/** How many sheets to produce.
 *  - 'auto': keep adding sheets until every part places or `maxSheets` is hit.
 *  - a number: the same auto behaviour, but capped to at most this many sheets
 *    even when `maxSheets` would allow more (a caller-supplied ceiling BELOW
 *    the stated maximum — never above it; a number greater than `maxSheets` is
 *    clamped down to `maxSheets`, never grown past it). */
export type SheetCount = 'auto' | number

export interface MultiSheetOptions {
  sheets: SheetCount
  maxSheets: number
}

/** One solved sheet in the run: the exact-quantity request that produced it
 *  (its `parts` are that sheet's share only) and the resulting NestResult. */
export interface SheetPlan {
  sheetIndex: number
  request: NestRequest
  result: NestResult
}

export interface MultiSheetResult {
  sheets: SheetPlan[]
  /** Parts that fit on NO sheet within the stated maximum — reported EXPLICITLY
   *  by partId (ADR 0003: named leftovers, never a silent drop). Empty when
   *  every requested part placed somewhere in `sheets`. */
  neverPlaced: { partId: string; count: number }[]
}

/**
 * Repeat solveNest against the SAME fixed sheet size, feeding each sheet's
 * unplaced remainder into the next sheet's request, up to the effective cap
 * (see SheetCount). Stops as soon as a sheet places everything requested of
 * it. Requires req.solver.kind === 'fixSheetExact' (see file header).
 */
export async function solveMultiSheet(
  req: NestRequest,
  opts: MultiSheetOptions,
): Promise<MultiSheetResult> {
  if (req.solver.kind !== 'fixSheetExact') {
    throw new Error(
      `multiSheetNest: solveMultiSheet requires solver.kind 'fixSheetExact' (fixed sheet, ` +
        `exact quantities, explicit leftovers) — got '${req.solver.kind}'. The other solver ` +
        'modes either scale up to fill one sheet or size the sheet to fit everything, so ' +
        'neither ever has genuine overflow to carry onto a next sheet.',
    )
  }
  const maxSheets = Math.max(1, Math.floor(opts.maxSheets))
  const cap =
    opts.sheets === 'auto' ? maxSheets : Math.max(1, Math.min(Math.floor(opts.sheets), maxSheets))

  // partId -> source NestPart, so a later sheet's request can be rebuilt from
  // an `unplaced` entry (which carries only partId + count).
  const partById = new Map<string, NestPart>()
  for (const entry of req.parts) partById.set(entry.part.id, entry.part)

  const sheets: SheetPlan[] = []
  let remaining: { part: NestPart; quantity: number }[] = req.parts

  for (let sheetIndex = 0; sheetIndex < cap && remaining.length > 0; sheetIndex++) {
    const sheetReq: NestRequest = { ...req, parts: remaining }
    const result = await solveNest(sheetReq)
    sheets.push({ sheetIndex, request: sheetReq, result })

    if (result.unplaced.length === 0) {
      remaining = []
      break
    }
    remaining = result.unplaced.map((u) => {
      const part = partById.get(u.partId)
      if (!part) {
        throw new Error(`multiSheetNest: unplaced partId "${u.partId}" not found in the request`)
      }
      return { part, quantity: u.count }
    })
  }

  // Anything still remaining after the cap is reached fits no sheet within the
  // stated maximum — name it explicitly (ADR 0003), never a silent drop.
  const neverPlaced = remaining.map((r) => ({ partId: r.part.id, count: r.quantity }))

  return { sheets, neverPlaced }
}
