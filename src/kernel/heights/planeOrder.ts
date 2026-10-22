// WO-3020 (alpha.3 A3-11, parity): the ONE plane-order validator. Today the
// rule Clearance >= Retract >= Feed >= Top >= Bottom is restated in several
// places (RC-008 / U-16: smartHeights/resolve.ts:804-838,
// cam3d/integration/adaptive3dOperation.ts:332-337, cam3d/pathbuild); this
// module states it once, with today's strictness, and the kernel resolver calls
// it. Nothing in the app calls it yet.
//
// Strictness at parity (MD-56 is a CARD, flag not built):
// - Clearance >= Retract >= Feed >= Material Start: equal is allowed.
// - Material Start above the cutter-center Target End: Top = Bottom is refused
//   unless the end is a spatial target field (today's resolve.ts:832-833).

export type PlaneLabel = 'Clearance' | 'Retract' | 'Feed' | 'Material Start'

export interface PlaneStack {
  clearance: number
  retract: number
  feed: number
  /** Material Start (Top). */
  top: number
  /** Cutter-center Target End (Bottom). */
  bottom: number
}

export interface PlaneOrderViolation {
  upper: PlaneLabel
  lower: PlaneLabel | 'Target End'
  upperMm: number
  lowerMm: number
  /** Today's operator text, word for word. */
  message: string
}

/** The safety stack, top down. The first pair out of order is the violation. */
export function safetyOrderViolation(stack: Omit<PlaneStack, 'bottom'>): PlaneOrderViolation | undefined {
  const order: Array<[PlaneLabel, number]> = [
    ['Clearance', stack.clearance], ['Retract', stack.retract], ['Feed', stack.feed], ['Material Start', stack.top],
  ]
  for (let i = 0; i + 1 < order.length; i++) {
    const [upper, upperMm] = order[i]
    const [lower, lowerMm] = order[i + 1]
    if (upperMm < lowerMm) {
      return {
        upper, lower, upperMm, lowerMm,
        message: `${upper} (${upperMm}) is below ${lower} (${lowerMm}); ` +
          'safety planes must satisfy Clearance >= Retract >= Feed >= Material Start.',
      }
    }
  }
  return undefined
}

/** Top against Bottom. `endIsTargetField`: the end is a spatial target field
 *  (a surface the strategy follows), the one case today accepts Top = Bottom. */
export function bandOrderViolation(
  top: number,
  bottom: number,
  endIsTargetField: boolean,
): PlaneOrderViolation | undefined {
  if (top < bottom || (top === bottom && !endIsTargetField)) {
    return {
      upper: 'Material Start', lower: 'Target End', upperMm: top, lowerMm: bottom,
      message: `Material Start (${top}) must be above the cutter-center Target End (${bottom}).`,
    }
  }
  return undefined
}

/** The whole stack, safety pairs first, then the band - the order today's resolver checks in. */
export function planeOrderViolation(
  stack: PlaneStack,
  options: { endIsTargetField: boolean },
): PlaneOrderViolation | undefined {
  return safetyOrderViolation(stack) ?? bandOrderViolation(stack.top, stack.bottom, options.endIsTargetField)
}

interface LiftablePlane {
  wcsMm: number
  proofNodeIds: string[]
}

/** WO-1621: a safety plane the operator did not set is lifted as far as the
 *  ordering needs (Feed to Material Start, Retract to Feed, Clearance to
 *  Retract). Only planes the operator set can contradict each other. */
export function liftUnsetPlane<T extends LiftablePlane>(plane: T, operatorSet: boolean, floor: T): T {
  return operatorSet || plane.wcsMm >= floor.wcsMm
    ? plane
    : { ...floor, proofNodeIds: [...new Set([...plane.proofNodeIds, ...floor.proofNodeIds])] }
}
