import type { Project, Setup, Vec3 } from '../../types'
import { stockWorldBounds } from '../../store/stockAssignment'
import {
  conflictingWorkOffsetClaim,
  FIXTURE_OFFSETS,
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
// WO-3108: The approved S2D-02 target supersedes the shared-datum default.
// New second sides reflect the parent's XY about the stock centre and use
// the next available offset. Owner decision 2026-10-25: probe Z0 on the flipped stock TOP,
// not the reflected first-side datum on the bottom. Saved frames stay explicit. The
// physical block and part geometry are never moved by this planner.

/** Axis the part is turned over about. X and Y are different operations and the
 *  app must never guess which one was meant. */
export type FlipAxis = 'x' | 'y'

/** The stock frame both sides share. `stockSize` is the block's world extents;
 *  `originInStock` is the first-side work zero measured from the block's minimum
 *  corner (so a top-face zero has originInStock.z === stockSize.z). The origin
 *  is required, not optional: where the zero sits inside the block is exactly
 *  what decides whether a flipped coordinate reads 45 or -5. */
export interface SecondSideFrame {
  stockSize: Vec3
  originInStock: Vec3
  /** Destination zero inside the same block. Omitted preserves legacy shared
   *  datum callers; saved second sides must supply their actual zero. */
  secondOriginInStock?: Vec3
}

/**
 * Where a point on the part ends up once the block is turned over.
 *
 * Input is relative to the first-side zero; output is relative to the destination
 * zero (both axis-aligned). Turning about X keeps world X and swings Y and Z
 * across the block; turning about Y keeps Y and swings X and Z.
 *
 * Legacy shared-zero example - 100 x 50 x 20 block, zero at the front-left TOP corner
 * (originInStock = {x:0, y:0, z:20}), turned about X:
 *   a point 5 mm behind the front face and 3 mm below the top (y=5, z=-3)
 *   reads y = 50 - 0 - 5 = 45 and z = 20 - 40 + 3 = -17.
 * It is 5 mm from what is now the BACK face and 3 mm above the new bottom.
 * With the flipped XY / top-zero destination (0,50,20), the point reads
 * y = -5, z = -17. The physical point is identical; only its frame changes.
 */
export function flipPointToSecondSide(
  point: Vec3,
  axis: FlipAxis,
  frame: SecondSideFrame,
): Vec3 {
  const size = frame.stockSize
  const zero = frame.originInStock
  const destination = frame.secondOriginInStock ?? zero
  // First translate into the block, turn once, then subtract the child zero.
  const z = size.z - zero.z - point.z - destination.z
  return axis === 'x'
    ? { x: zero.x + point.x - destination.x, y: size.y - zero.y - point.y - destination.y, z }
    : { x: size.x - zero.x - point.x - destination.x, y: zero.y + point.y - destination.y, z }
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
  /** First-side work zero, measured from the stock minimum. */
  originInStock: Vec3
  secondOriginInStock: Vec3
  /** World origin of the destination frame. */
  origin: Vec3
  cornerRow: number
  cornerCol: number
  cornerFace: 'top' | 'bottom'
  /** Offset owned by the destination setup. */
  fixtureOffset: FixtureOffset
  /** New creation must ask before sharing the parent when every slot is used. */
  requiresOffsetReuseConfirmation: boolean
}

export interface SecondSideRequest {
  /** Setup the new one is the second side of. */
  parentSetupId: string
  axis: FlipAxis
  /** Resolve this actual saved child instead of allocating a creation default. */
  existingSetup?: Setup
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

  const existing = request.existingSetup
  const rawOffset = resolvedOffsetFor(existing ?? parent, stock.fixtureOffset)
  if (!isFixtureOffset(rawOffset)) {
    return {
      ok: false,
      code: 'FLIP_WORK_OFFSET_INVALID',
      message:
        `"${parent.name}" resolves to work offset G${String(rawOffset)}, which is not ` +
        `one of G54-G59. Give the first side a valid offset before turning it over.`,
    }
  }

  // Owner decision 2026-10-25: first unused G54-G59 across ALL setup/stock claims.
  // Exhaustion proposes the parent's slot; creation must ask before saving it.
  const unusedOffset = FIXTURE_OFFSETS.find(offset => !conflictingWorkOffsetClaim(project, offset))
  const fixtureOffset = existing ? rawOffset : unusedOffset ?? rawOffset
  const requiresOffsetReuseConfirmation = !existing && unusedOffset === undefined
  // Saved explicit choices already passed the setup editor (WO-2983 allows
  // separate programs to share a slot). Never reallocate them during probing.
  const claim = existing ? undefined : conflictingWorkOffsetClaim(project, fixtureOffset, stock.id)
  if (claim) {
    return {
      ok: false,
      code: 'FLIP_WORK_OFFSET_CLAIMED',
      message: `G${fixtureOffset} is already held by ${claim.kind} "${claim.name}".`,
    }
  }

  const bounds = stockWorldBounds(stock)
  const origin = existing ? { ...existing.wcs.origin } : {
    x: request.axis === 'y' ? bounds.min.x + bounds.max.x - parent.wcs.origin.x : parent.wcs.origin.x,
    y: request.axis === 'x' ? bounds.min.y + bounds.max.y - parent.wcs.origin.y : parent.wcs.origin.y,
    z: bounds.max.z,
  }
  const childBinding = existing ? wcsStockCornerBinding(existing.wcs) : undefined
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
    secondOriginInStock: {
      x: origin.x - bounds.min.x,
      y: origin.y - bounds.min.y,
      z: origin.z - bounds.min.z,
    },
    origin,
    cornerRow: childBinding?.cornerRow ?? (request.axis === 'x' ? 2 - binding.cornerRow : binding.cornerRow),
    cornerCol: childBinding?.cornerCol ?? (request.axis === 'y' ? 2 - binding.cornerCol : binding.cornerCol),
    // Match the stored origin so stock moves/reloads keep the probed top zero.
    cornerFace: existing
      ? childBinding?.cornerFace ?? (binding.cornerFace === 'top' ? 'bottom' : 'top')
      : 'top',
    fixtureOffset,
    requiresOffsetReuseConfirmation,
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

/** WO-3196: how a second side holds the part - the block turned 180 degrees
 *  about `axis` through its own centre, where it stays in the same world box.
 *  `center` is the centre of that block in world coordinates. */
export interface SecondSideTurn {
  axis: FlipAxis
  center: Vec3
}

/** The turn a setup machines under, or null for a first side (no flipOf).
 *  `block` is the setup's proven stock box; a second side without one has no
 *  block to turn and returns 'no-block' so the caller can say so. */
export function secondSideTurn(
  setup: Pick<Setup, 'flipOf'>,
  block: { min: Vec3; max: Vec3 } | null | undefined,
): SecondSideTurn | null | 'no-block' {
  if (!setup.flipOf) return null
  if (!block) return 'no-block'
  return {
    axis: setup.flipOf.axis,
    center: {
      x: (block.min.x + block.max.x) / 2,
      y: (block.min.y + block.max.y) / 2,
      z: (block.min.z + block.max.z) / 2,
    },
  }
}

/** Where a world point of the part sits once the block is turned. Turning
 *  about X keeps X and swings Y and Z across the block; about Y keeps Y and
 *  swings X and Z - the same turn flipPointToSecondSide expresses in setup
 *  coordinates. A half turn, not a mirror: handedness is kept. */
export function turnWorldPointForSecondSide(point: Vec3, turn: SecondSideTurn): Vec3 {
  const { center } = turn
  return turn.axis === 'x'
    ? { x: point.x, y: 2 * center.y - point.y, z: 2 * center.z - point.z }
    : { x: 2 * center.x - point.x, y: point.y, z: 2 * center.z - point.z }
}
