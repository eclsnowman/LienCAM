import type { Tool, ToolCutHand } from '../../types'

export type ToolSpindleRotation = 'cw' | 'ccw'
export type PhysicalMillingDirection = 'climb' | 'conventional'

/** Legacy/malformed tool data is always normalized to the safe standard hand. */
export function normalizeToolCutHand(value: unknown): ToolCutHand {
  return value === 'left' ? 'left' : 'right'
}

/**
 * Cutter rotation sign used by geometry and post resolution.
 * +1 = standard right-hand cutter, -1 = left-hand cutter.
 */
export function spindleSignForTool(tool: Pick<Tool, 'cutHand'>): 1 | -1 {
  return normalizeToolCutHand(tool.cutHand) === 'left' ? -1 : 1
}

/**
 * Physical cutting rotation required by the selected cutter when viewed from +Z.
 * Tool hand owns this decision: right-hand cutters run CW and left-hand cutters
 * run CCW. Machine configuration may limit RPM, but it must not silently reverse
 * the cutter and thereby invert climb/conventional toolpath geometry.
 */
export function spindleRotationForTool(
  tool: Pick<Tool, 'cutHand'>,
): ToolSpindleRotation {
  return spindleSignForTool(tool) === 1 ? 'cw' : 'ccw'
}

/**
 * Translate the operator's physical climb/conventional selection into the
 * equivalent direction for a planner whose winding rules are defined for a
 * standard CW spindle. Reversing the cutter reverses the engaged material side
 * of an unchanged XY path, so the planner direction must reverse as well.
 */
export function directionForClockwiseSpindle(
  selected: PhysicalMillingDirection,
  spindleRotation: ToolSpindleRotation,
): PhysicalMillingDirection {
  if (selected !== 'climb' && selected !== 'conventional') {
    throw new Error(`Invalid physical milling direction "${String(selected)}".`)
  }
  if (spindleRotation !== 'cw' && spindleRotation !== 'ccw') {
    throw new Error(`Invalid spindle rotation "${String(spindleRotation)}".`)
  }
  if (spindleRotation === 'cw') return selected
  return selected === 'climb' ? 'conventional' : 'climb'
}

/** One boundary for every CW-convention CAM planner. */
export function directionForTool(
  selected: PhysicalMillingDirection,
  tool: Pick<Tool, 'cutHand'>,
): PhysicalMillingDirection {
  return directionForClockwiseSpindle(selected, spindleRotationForTool(tool))
}
