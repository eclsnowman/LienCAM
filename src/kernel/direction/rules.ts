import type { ToolCutHand } from '../../types'

// Kernel copies of the one milling-direction rule (src/lib/cam/millingDirection.ts,
// WO-1896, RC-005) and the cut-hand fold (src/lib/tool/cutHand.ts, RC-012). The
// kernel may not import the current engine (WO-2904 boundary), so the rule is
// re-hosted here; directionService.wo3003.test.ts pins both copies to each other
// over every input.
//
// For a clockwise (M3) spindle viewed from +Z, CLIMB keeps the material on the
// cutter's RIGHT as it travels; conventional keeps it on the LEFT. A
// counter-clockwise spindle (a left-hand cutter) mirrors every row.

export type MillingDirection = 'climb' | 'conventional'
export type MaterialSide = 'left' | 'right'
export type LoopWinding = 'cw' | 'ccw'
export type SpindleRotation = 'cw' | 'ccw'

/** Legacy/malformed tool data is the standard right-hand cutter. */
export function normalizeCutHand(value: unknown): ToolCutHand {
  return value === 'left' ? 'left' : 'right'
}

/** Right-hand cutters run CW, left-hand cutters run CCW (viewed from +Z). */
export function spindleForCutHand(value: unknown): SpindleRotation {
  return normalizeCutHand(value) === 'left' ? 'ccw' : 'cw'
}

function assertDirection(direction: MillingDirection): void {
  if (direction !== 'climb' && direction !== 'conventional') {
    throw new Error(`Invalid milling direction "${String(direction)}".`)
  }
}

/** The cut-hand fold: the CW-spindle planner direction for a physical selection. */
export function foldForSpindle(selected: MillingDirection, spindle: SpindleRotation): MillingDirection {
  assertDirection(selected)
  if (spindle !== 'cw' && spindle !== 'ccw') throw new Error(`Invalid spindle rotation "${String(spindle)}".`)
  if (spindle === 'cw') return selected
  return selected === 'climb' ? 'conventional' : 'climb'
}

/** Side of travel the uncut material sits on, CW-spindle planner direction. */
export function materialSideFor(direction: MillingDirection): MaterialSide {
  assertDirection(direction)
  return direction === 'climb' ? 'right' : 'left'
}

/**
 * Winding a closed loop needs so the material is on the required side.
 * `materialInside` = the loop encloses the material. Walking a CCW loop keeps
 * its interior on the left.
 */
export function loopWindingFor(direction: MillingDirection, materialInside: boolean): LoopWinding {
  const materialLeft = materialSideFor(direction) === 'left'
  return materialLeft === materialInside ? 'ccw' : 'cw'
}

export function flipWinding(winding: LoopWinding): LoopWinding {
  return winding === 'ccw' ? 'cw' : 'ccw'
}

export function flipSide(side: MaterialSide): MaterialSide {
  return side === 'left' ? 'right' : 'left'
}

/**
 * The engaged side, computed from geometry alone and independent of any label:
 * which physical direction a pass cuts when the material is on `side` of its
 * travel and the spindle turns `spindle`.
 */
export function engagedForMaterialSide(side: MaterialSide, spindle: SpindleRotation): MillingDirection {
  return (side === 'right') === (spindle === 'cw') ? 'climb' : 'conventional'
}

/** Engaged side of a closed loop walked with `winding` around (or inside) the material. */
export function engagedForLoop(winding: LoopWinding, materialInside: boolean, spindle: SpindleRotation): MillingDirection {
  const materialRight = materialInside !== (winding === 'ccw')
  return engagedForMaterialSide(materialRight ? 'right' : 'left', spindle)
}
