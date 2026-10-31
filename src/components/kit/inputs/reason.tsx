// WO-3278: the "why not" shared by every input. An unavailable input stays focusable and read-only
// (spec 7: never only greyed out); its reason, resolved from the catalogue, is a tooltip on hover
// and focus and the field's description for assistive technology.
import { useId, type ReactElement } from 'react'
import type { Availability } from '../../../commands/types'
import { resolveMessage } from '../../../notices'

export interface Reason {
  readonly blocked: boolean
  /** id of the tooltip, for aria-describedby; undefined while the part is ready. */
  readonly tipId: string | undefined
  readonly lock: boolean
  readonly tip: ReactElement | null
}

export function useReason(availability: Availability | undefined): Reason {
  const id = useId()
  if (availability === undefined || availability.ready) return { blocked: false, tipId: undefined, lock: false, tip: null }
  return {
    blocked: true,
    tipId: id,
    lock: availability.lock === true,
    tip: <span role="tooltip" id={id} className="kit-reason">{resolveMessage(availability.reason, availability.params)}</span>,
  }
}

/** Space-separated ids for aria-describedby, or undefined when there are none. */
export const describedBy = (...ids: (string | undefined)[]): string | undefined => {
  const kept = ids.filter((i): i is string => i !== undefined)
  return kept.length > 0 ? kept.join(' ') : undefined
}
