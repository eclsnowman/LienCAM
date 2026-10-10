import type { Project, Setup, Vec3 } from '../../types'
import { stockWorldBounds } from '../../store/stockAssignment'
import {
  conflictingWorkOffsetClaim,
  isFixtureOffset,
  setupOwnsFixtureOffset,
  wcsStockCornerBinding,
  type FixtureOffset,
} from '../post/workOffsets'

// WO-288: "this setup is the second side of that one" - the same physical block
// of material, turned over about one axis, machined again.
//
// Pure and deterministic: no React, no store writes, no I/O. The store/UI call
// planSecondSideSetup to build the second side's WCS from the first side's
// instead of asking the user to type an origin in again.
//
// THE MODEL, stated plainly, because the arithmetic is meaningless without it:
//
//   The BLOCK does not move. It is turned over inside the same vise, in the
//   same place, so it occupies the same world box (a 180-degree turn about a
//   principal axis maps a box onto itself). What changes is which face of the
//   PART is up, and therefore which part corner sits under the work zero.
//
//   The second side therefore zeroes on the SAME stock corner as the first -
//   same physical spot on the fixture, same work offset. That is what a
//   machinist does: the corner of the block in the vise is re-touched, and the
//   part underneath it is the one that moved. Side 2 is not a new datum; it is
//   the same datum seeing a different face.
//
// WHY BOTH SIDES SHARE ONE OFFSET, and what changed under it (WO-288 asked for
// the opposite; the note is kept because the answer is not obvious). The block
// does not move and the zero stays on the same corner of it, so the two sides
// genuinely run on one controller frame - that is the machinist's answer, and
// it is what this module implements. What WO-1291 changed is WHOSE offset that
// is: a SETUP now owns its own frame, so the shared value is the first side's,
// not the stock's. Only an unmarked legacy setup still reads through its stock.
// resolvedOffsetFor below must stay in the same order as resolveSetupWorkOffset
// in workOffsets.ts. An operator who wants the second side on a DIFFERENT offset
// can now say so: edit that setup, and the console reports what it outdated.

/** Axis the part is turned over about. X and Y are different operations and the
 *  app must never guess which one was meant. */
export type FlipAxis = 'x' | 'y'

/** The stock frame both sides share. `stockSize` is the block's world extents;
 *  `originInStock` is the shared work zero measured from the block's minimum
 *  corner (so a top-face zero has originInStock.z === stockSize.z). The origin
 *  is required, not optional: where the zero sits inside the block is exactly
 *  what decides whether a flipped coordinate reads 45 or -5. */
export interface SecondSideFrame {
  stockSize: Vec3
  originInStock: Vec3
}

/**
 * Where a point on the part ends up once the block is turned over.
 *
 * Input and output are both in setup coordinates (relative to the shared work
 * zero, axis-aligned with it). Turning about X keeps X and swings Y and Z
 * across the block; turning about Y keeps Y and swings X and Z.
 *
 * Worked example - 100 x 50 x 20 block, zero at the front-left TOP corner
 * (originInStock = {x:0, y:0, z:20}), turned about X:
 *   a point 5 mm behind the front face and 3 mm below the top (y=5, z=-3)
 *   reads y = 50 - 0 - 5 = 45 and z = 20 - 40 + 3 = -17.
 * It is 5 mm from what is now the BACK face and 3 mm above the new bottom.
 * Negating instead (y = -5) is the plausible wrong answer.
 */
export function flipPointToSecondSide(
  point: Vec3,
  axis: FlipAxis,
  frame: SecondSideFrame,
): Vec3 {
  const size = frame.stockSize
  const zero = frame.originInStock
  // Z always turns over, whichever axis the part rolls about.
  const z = size.z - 2 * zero.z - point.z
  return axis === 'x'
    ? { x: point.x, y: size.y - 2 * zero.y - point.y, z }
    : { x: size.x - 2 * zero.x - point.x, y: point.y, z }
}

export type SecondSideRefusalCode =
  | 'FLIP_PARENT_MISSING'
  | 'FLIP_PARENT_NOT_STOCK_BOUND'
  | 'FLIP_STOCK_MISSING'
  | 'FLIP_STOCK_MISMATCH'
  | 'FLIP_WORK_OFFSET_INVALID'
  | 'FLIP_WORK_OFFSET_CLAIMED'

export interface SecondSideRefusal {
  ok: false
  code: SecondSideRefusalCode
  /** Machinist-readable reason, shown in the setup dialog verbatim. */
  message: string
}

export interface SecondSidePlan {
  ok: true
  /** The first side. */
  parentSetupId: string
  parentSetupName: string
  axis: FlipAxis
  /** The one physical stock both sides are bound to. */
  stockId: string
  stockName: string
  /** World extents of that stock. */
  stockSize: Vec3
  /** Shared work zero, measured from the stock's minimum corner. */
  originInStock: Vec3
  /** World origin of the second side: the first side's, because the block did
   *  not move and the zero stays on the same corner of it. */
  origin: Vec3
  cornerRow: number
  cornerCol: number
  cornerFace: 'top' | 'bottom'
  /** Offset both sides resolve to (the first side owns it; WO-1291). */
  fixtureOffset: FixtureOffset
}

export interface SecondSideRequest {
  /** Setup the new one is the second side of. */
  parentSetupId: string
  axis: FlipAxis
  /** Stock the caller currently has selected. Given and different from the
   *  first side's stock, the flip is refused: two sides of one part are one
   *  block of material. Omitted = adopt the first side's stock. */
  stockId?: string
}

type FlipProject = Pick<Project, 'setups' | 'stocks'>

/** The offset a setup resolves to. A setup that owns its offset (WO-1291) is
 *  the authority on its own controller frame; only an unmarked legacy setup
 *  still resolves through its bound stock, and only when that stock carries an
 *  offset at all. Same order as resolveSetupWorkOffset in workOffsets.ts, which
 *  is the resolver the post itself uses - the two must not disagree, or a flip
 *  plans one frame and the program emits another. */
function resolvedOffsetFor(
  setup: Setup,
  stockOffset: number | undefined,
): number {
  if (setupOwnsFixtureOffset(setup.wcs)) return setup.wcs.fixtureOffset
  return isFixtureOffset(stockOffset) ? stockOffset : setup.wcs.fixtureOffset
}

/**
 * Build the second side of `parentSetupId`, or refuse and say why.
 *
 * Refusals are the point of this function as much as the plan is: a second side
 * that is not the same block of material, or that lands on an offset another
 * owner holds, is not a second side and must not be created.
 */
export function planSecondSideSetup(
  project: FlipProject,
  request: SecondSideRequest,
): SecondSidePlan | SecondSideRefusal {
  const parent = project.setups.find((setup) => setup.id === request.parentSetupId)
  if (!parent) {
    return {
      ok: false,
      code: 'FLIP_PARENT_MISSING',
      message: 'That setup no longer exists, so there is no first side to turn over.',
    }
  }

  const binding = wcsStockCornerBinding(parent.wcs)
  if (!binding || binding.stockId == null) {
    return {
      ok: false,
      code: 'FLIP_PARENT_NOT_STOCK_BOUND',
      message:
        `"${parent.name}" does not zero on a stock corner, so there is no block to ` +
        `turn over. Bind that setup to a stock corner first.`,
    }
  }

  if (request.stockId !== undefined && request.stockId !== binding.stockId) {
    const chosen = (project.stocks ?? []).find((stock) => stock.id === request.stockId)
    return {
      ok: false,
      code: 'FLIP_STOCK_MISMATCH',
      message:
        `A second side is the SAME block of material turned over. "${parent.name}" is ` +
        `on a different stock than ${chosen ? `"${chosen.name}"` : 'the one selected'}.`,
    }
  }

  const stock = (project.stocks ?? []).find((candidate) => candidate.id === binding.stockId)
  if (!stock) {
    return {
      ok: false,
      code: 'FLIP_STOCK_MISSING',
      message:
        `"${parent.name}" names a stock that is no longer in this project, so the two ` +
        `sides cannot be shown to be one block.`,
    }
  }

  const rawOffset = resolvedOffsetFor(parent, stock.fixtureOffset)
  if (!isFixtureOffset(rawOffset)) {
    return {
      ok: false,
      code: 'FLIP_WORK_OFFSET_INVALID',
      message:
        `"${parent.name}" resolves to work offset G${String(rawOffset)}, which is not ` +
        `one of G54-G59. Give the first side a valid offset before turning it over.`,
    }
  }

  // The two sides run on the first side's offset. Ask the existing collision
  // reader whether an owner on some OTHER stock already holds it; a second side
  // must never be created into an offset map that is already wrong.
  const claim = conflictingWorkOffsetClaim(project, rawOffset, stock.id)
  if (claim) {
    return {
      ok: false,
      code: 'FLIP_WORK_OFFSET_CLAIMED',
      message:
        `G${rawOffset} is already held by ${claim.kind} "${claim.name}". Both sides of ` +
        `one part run on the first side's offset, so free G${rawOffset} first.`,
    }
  }

  const bounds = stockWorldBounds(stock)
  return {
    ok: true,
    parentSetupId: parent.id,
    parentSetupName: parent.name,
    axis: request.axis,
    stockId: stock.id,
    stockName: stock.name,
    stockSize: {
      x: bounds.max.x - bounds.min.x,
      y: bounds.max.y - bounds.min.y,
      z: bounds.max.z - bounds.min.z,
    },
    originInStock: {
      x: parent.wcs.origin.x - bounds.min.x,
      y: parent.wcs.origin.y - bounds.min.y,
      z: parent.wcs.origin.z - bounds.min.z,
    },
    origin: { ...parent.wcs.origin },
    cornerRow: binding.cornerRow,
    cornerCol: binding.cornerCol,
    cornerFace: binding.cornerFace,
    fixtureOffset: rawOffset,
  }
}

/** The stock's far top corner in first-side coordinates: the point the dialog
 *  quotes on both sides so a machinist can check the turn by eye. */
export function farCornerInSetupCoords(plan: SecondSidePlan): Vec3 {
  return {
    x: plan.stockSize.x - plan.originInStock.x,
    y: plan.stockSize.y - plan.originInStock.y,
    z: plan.stockSize.z - plan.originInStock.z,
  }
}
