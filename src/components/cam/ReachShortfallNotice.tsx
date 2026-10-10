import { textFor, useText } from '../../i18n'
const tx = textFor('cam-operations-new-operation')
// WO-1683: the fact that the reach trim (WO-1565/1678) stopped this operation
// short of full depth, shown on the operation itself - never a refusal, never
// a modal or banner (COHESION-STANDARD sections 13 and 17).

import { positionNumber } from '../../lib/machine/positionFrames'
import type { OperationReachShortfall } from '../../lib/cam/holderClearanceGate'

/** This field is never user-authored, but it round-trips through a saved
 *  project like any other operation field, so a hand-edited or corrupted file
 *  can hand it a malformed value - read it as absent rather than throw. */
export function isValidReachShortfall(value: unknown): value is OperationReachShortfall {
  const v = value as Partial<OperationReachShortfall> | null | undefined
  return !!v && Number.isFinite(v.reachedZ) && Number.isFinite(v.askedZ) && Number.isFinite(v.uncutMm)
}

export function reachShortfallMessage(shortfall: OperationReachShortfall): string {
  return tx('ReachShortfallNotice.message', { reached: positionNumber(shortfall.reachedZ), asked: positionNumber(shortfall.askedZ), uncut: shortfall.uncutMm.toFixed(1) })
}

export interface ReachShortfallNoticeProps {
  readonly shortfall: OperationReachShortfall
}

export function ReachShortfallNotice({ shortfall }: ReachShortfallNoticeProps) {
  useText('cam-operations-new-operation')
  const message = reachShortfallMessage(shortfall)
  return (
    <div className="props-group props-error-msg" data-testid="op-reach-shortfall">
      <div className="props-label">{tx('ReachShortfallNotice.Reach')}</div>
      <div className="props-value" data-tooltip={message}>
        <span className="badge badge-warning">{tx('ReachShortfallNotice.Stopped_short')}</span> {message}
      </div>
    </div>
  )
}
