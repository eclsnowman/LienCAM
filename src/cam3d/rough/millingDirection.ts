import type { AdaptiveMillingDirection } from '../../lib/cam/types';
import { materialSideFor } from '../../lib/cam/millingDirection';
import {
  directionForClockwiseSpindle,
  type ToolSpindleRotation,
} from '../../lib/tool/cutHand';

export type SpindleRotation = ToolSpindleRotation;
export type MillingMaterialSide = 'left' | 'right';

/**
 * The Adaptive engine's canonical path orientation is defined for a clockwise
 * spindle viewed from +Z. Reversing the physical spindle reverses which side
 * of the same XY path is climb versus conventional.
 */
export function directionForClockwisePlanner(
  selected: AdaptiveMillingDirection,
  spindleRotation: SpindleRotation,
): AdaptiveMillingDirection {
  return directionForClockwiseSpindle(selected, spindleRotation);
}

/**
 * Material side required by a physical milling selection at the actual spindle
 * rotation. For a CW cutter, climb keeps material right and conventional keeps
 * it left (the one rule, src/lib/cam/millingDirection.ts, WO-1896); a CCW
 * cutter reverses those sides.
 */
export function materialSideForMilling(
  selected: AdaptiveMillingDirection,
  spindleRotation: SpindleRotation,
): MillingMaterialSide {
  return materialSideFor(directionForClockwiseSpindle(selected, spindleRotation));
}

/** Material side used inside the engine after conversion to its CW convention. */
export function materialSideForClockwisePlanner(
  plannerDirection: AdaptiveMillingDirection,
): MillingMaterialSide {
  return materialSideFor(plannerDirection);
}
