const AXIAL_REACH_EPSILON_MM = 1e-6

export interface ToolFluteReachCheck {
  operation: string
  topZ: number
  bottomZ: number
  fluteLength: number
  target?: string
}

/**
 * Refuse an operation that cannot reach its requested floor with the selected
 * tool's cutting flute. Call this before emitting any moves: shortening the
 * operation to the reachable depth would be physically safe but would falsely
 * report an incomplete toolpath as a successful one.
 */
export function assertToolFluteReach({
  operation,
  topZ,
  bottomZ,
  fluteLength,
  target,
}: ToolFluteReachCheck): void {
  const targetText = target ? ` ${target}` : ''
  if (!Number.isFinite(fluteLength) || fluteLength <= 0) {
    throw new Error(
      `${operation}: selected tool has no usable flute length${targetText}. ` +
      'Choose a tool with a valid longer flute/relieved length or reduce the bottom depth.',
    )
  }

  const requestedDepth = Math.max(0, topZ - bottomZ)
  const shortfall = requestedDepth - fluteLength
  if (shortfall <= AXIAL_REACH_EPSILON_MM) return

  throw new Error(
    `${operation}: requested axial depth ${requestedDepth.toFixed(3)} mm${targetText} ` +
    `exceeds available flute length ${fluteLength.toFixed(3)} mm by ${shortfall.toFixed(3)} mm. ` +
    'Choose a tool with a longer flute/relieved length or reduce the bottom depth.',
  )
}
