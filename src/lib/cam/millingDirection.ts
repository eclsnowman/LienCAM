// The one milling-direction rule every CAM operation uses (WO-1896).
//
// For a clockwise (M3) spindle viewed from +Z, CLIMB keeps the material on the
// cutter's RIGHT as it travels: each tooth enters the wall at full chip
// thickness and leaves at zero (the same side G41 cutter compensation puts the
// part on). Conventional keeps it on the LEFT. So, with an M3 spindle:
//   outside profile (part inside the loop)   climb = CW,  conventional = CCW
//   inside profile / pocket / bore wall      climb = CCW, conventional = CW
// A counter-clockwise (M4) spindle mirrors every row; the operations fold that
// in before they get here (directionForTool in src/lib/tool/cutHand.ts), so the
// functions below take the direction already expressed for a CW spindle.
//
// Before WO-1896 contour, bore, chamfer, Adaptive 2D and the 3D wall cleanup
// each carried their own copy of the reversed belief (climb = material left);
// pocket, thread milling and waterline already agreed with this rule.

export type PlannerMillingDirection = 'climb' | 'conventional'
export type MaterialSide = 'left' | 'right'
export type LoopWinding = 'cw' | 'ccw'

/** Side of the travel direction the uncut material sits on, CW spindle. */
export function materialSideFor(direction: PlannerMillingDirection): MaterialSide {
  if (direction !== 'climb' && direction !== 'conventional') {
    throw new Error(`Invalid milling direction "${String(direction)}".`)
  }
  return direction === 'climb' ? 'right' : 'left'
}

/**
 * Winding a closed cut loop needs so the material is on the required side.
 * `materialInside` = the material is enclosed by the loop (an outside profile
 * around a part, an island wall); false = the material surrounds the loop (an
 * inside profile, pocket wall, bore). Walking a CCW loop keeps its interior on
 * the left.
 */
export function loopWindingFor(
  direction: PlannerMillingDirection,
  materialInside: boolean,
): LoopWinding {
  const materialLeft = materialSideFor(direction) === 'left'
  return materialLeft === materialInside ? 'ccw' : 'cw'
}
