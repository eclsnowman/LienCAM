// followScroll - pure policy for keeping the ACTIVE program line centered
// in the line-list viewport while the machine is running (WO-037).
//
// Two concerns, both pure so tests can pin the exact numbers:
//   1. centeredScrollTop: where the viewport must sit so the active row's
//      center matches the viewport's center, clamped to real scroll range.
//   2. A tiny override state machine: the operator's own scroll always wins;
//      centering resumes after FOLLOW_RESUME_MS without operator scrolling.
//      Programmatic scrolls echo as scroll events too - markApplied records
//      what we set so observeScroll can tell our echo from the operator.

/** Operator scroll pauses following; it resumes after this much idle. */
export const FOLLOW_RESUME_MS = 4000

/** Browsers can report fractional scrollTop; treat within 1px as our echo. */
const APPLIED_EPSILON = 1

export interface FollowScrollState {
  /** When the operator last scrolled; null = actively following. */
  userScrolledAt: number | null
  /** The scrollTop we last applied, to recognize our own echo event. */
  appliedTop: number | null
}

export function initialFollowScroll(): FollowScrollState {
  return { userScrolledAt: null, appliedTop: null }
}

/**
 * The scrollTop that puts the row's vertical center at the viewport's
 * vertical center, clamped to [0, scrollHeight - viewportHeight].
 */
export function centeredScrollTop(
  rowTop: number,
  rowHeight: number,
  viewportHeight: number,
  scrollHeight: number,
): number {
  const raw = rowTop + rowHeight / 2 - viewportHeight / 2
  return Math.max(0, Math.min(raw, Math.max(0, scrollHeight - viewportHeight)))
}

/** True when centering may act: never scrolled, or idle long enough. */
export function isFollowing(state: FollowScrollState, now: number): boolean {
  return state.userScrolledAt === null || now - state.userScrolledAt >= FOLLOW_RESUME_MS
}

/** Record a programmatic scroll; clears any expired operator override. */
export function markApplied(state: FollowScrollState, top: number): FollowScrollState {
  void state
  return { userScrolledAt: null, appliedTop: top }
}

/**
 * Feed every scroll event here. Our own echo leaves the state alone;
 * anything else is the operator and pauses following from `now`.
 */
export function observeScroll(
  state: FollowScrollState,
  scrollTop: number,
  now: number,
): FollowScrollState {
  if (state.appliedTop !== null && Math.abs(scrollTop - state.appliedTop) <= APPLIED_EPSILON) {
    return state
  }
  return { userScrolledAt: now, appliedTop: null }
}
