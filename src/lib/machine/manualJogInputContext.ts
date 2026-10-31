// WO-3258 (WO-3181 phase P): WHICH INPUT IS ABOUT TO MOVE THE MACHINE.
//
// Today only the phone has arbitration of its own (the pendant bridge's
// activeJogClient), and each held jog is its own caller's handle. A gamepad
// (WO-3259/3260) holding a jog must stop its own timers the moment ANOTHER
// input - the Jog panel, the jog keys, the phone, a Safe Z, Home, CYCLE START,
// an MDI line, a probe routine - is about to send motion, or a late gamepad
// keepalive, burst or release would land on that other input's motion.
//
// This module is only the observation seam the session's installed controller
// wrappers report through (machineSession.ts installBackend and its routes):
//
//   intent      announced synchronously BEFORE the wrapper dispatches anything,
//               so an observer can stop its own motion first. Calls are
//               external (gesture null) unless made inside
//               `withManualJogGesture(token, ...)` with that input's own token.
//   stop        announced AFTER an operator stop went out (jog cancel/stop,
//               feed hold, pause, Stop, Reset, E-STOP), so nothing an observer
//               does in answer can delay it on the wire.
//   connection  the controller is being replaced or disconnected; the
//               generation steps first.
//
// It never denies, renames, queues or delays a request: there is no lock, no
// refusal, no policy and no polling. A listener that throws is reported and
// skipped; the command goes on exactly as it would have.
//
// Nested announcements are not new gestures. While one announced call runs,
// the calls it makes (a wrapper calling another wrapper, a stop inside a
// stop) announce nothing. A command the session deferred and replays later -
// a jog, MDI line or Single Block step that waited for a pause to become a
// kept stop - is replayed inside `replayDeferredManualMotion` and announces
// nothing either: it was announced when the operator asked for it.
//
// THE TOKEN IS SYNCHRONOUS. A gesture's own async continuation (a burst timer,
// a promise callback) is outside the scope it started in; it must re-enter it
// with `withManualJogGesture(token, ...)` or `token`'s `bind`, or it reads as
// external and the input yields to itself.

export type ManualMotionIntentKind =
  /** A relative step jog (a press, a burst step, a pendant step). */
  | 'jog'
  /** A native run-until-stopped jog start (not its keepalive). */
  | 'jog-continuous'
  /** An absolute coordinate jog: Go to X Y, Safe Z, a park leg. */
  | 'move'
  | 'home'
  /** CYCLE START, Resume or a Single Block step. */
  | 'program'
  /** An MDI line that is not stop words only (the E-STOP door's allowlist). */
  | 'mdi'
  /** A configured action or macro block that is not stop words only. */
  | 'action'
  /** A probe routine claiming the probe lock. */
  | 'probe'

export type ManualMotionStopKind =
  | 'jog-cancel'
  | 'jog-stop'
  | 'feed-hold'
  | 'pause'
  | 'stop'
  | 'reset'
  | 'estop'

/** One input's opaque identity. Compared by reference only. */
export interface ManualJogGesture {
  readonly label: string
  /** `fn` run later inside this gesture's scope (a timer, a promise callback). */
  bind<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R
}

export type ManualMotionEvent =
  | {
    type: 'intent'
    kind: ManualMotionIntentKind
    /** The operator's words for it, as the console names it ("Jog X"). */
    what: string
    /** The input that made the call; null is any other input. */
    gesture: ManualJogGesture | null
    generation: number
  }
  | {
    type: 'stop'
    kind: ManualMotionStopKind
    gesture: ManualJogGesture | null
    generation: number
  }
  | { type: 'connection'; generation: number }

export type ManualMotionListener = (event: ManualMotionEvent) => void

const listeners = new Set<ManualMotionListener>()
let currentGesture: ManualJogGesture | null = null
/** >0 while an announced call or a deferred replay runs. */
let quiet = 0
let generation = 0

export function subscribeManualMotionInput(listener: ManualMotionListener): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function createManualJogGesture(label: string): ManualJogGesture {
  const gesture: ManualJogGesture = Object.freeze({
    label,
    bind: <A extends unknown[], R>(fn: (...args: A) => R) =>
      (...args: A): R => withManualJogGesture(gesture, () => fn(...args)),
  })
  return gesture
}

/** Run `fn` as `gesture`'s own call. Everything `fn` sends synchronously is
 *  announced with this token, so its owner can tell it from another input. */
export function withManualJogGesture<T>(gesture: ManualJogGesture, fn: () => T): T {
  const previous = currentGesture
  currentGesture = gesture
  try {
    return fn()
  } finally {
    currentGesture = previous
  }
}

export function manualMotionConnectionGeneration(): number {
  return generation
}

function deliver(event: ManualMotionEvent): void {
  for (const listener of [...listeners]) {
    try {
      listener(event)
    } catch (error) {
      // An observer's fault never reaches the operator's command.
      console.error('manual motion observer failed', error)
    }
  }
}

/** Announce a motion request, then run it. Nested and replayed calls only run. */
export function announceManualMotionIntent<T>(
  kind: ManualMotionIntentKind,
  what: string,
  run: () => T,
): T {
  if (quiet === 0) deliver({ type: 'intent', kind, what, gesture: currentGesture, generation })
  quiet++
  try {
    return run()
  } finally {
    quiet--
  }
}

/** Run a stop, then announce it. Nested and replayed stops only run. */
export function announceManualMotionStop<T>(kind: ManualMotionStopKind, run: () => T): T {
  if (quiet > 0) return run()
  const gesture = currentGesture
  quiet++
  try {
    return run()
  } finally {
    quiet--
    deliver({ type: 'stop', kind, gesture, generation })
  }
}

/** A stop the session learned of rather than sent (the board's E-STOP input). */
export function noteManualMotionStop(kind: ManualMotionStopKind): void {
  if (quiet > 0) return
  deliver({ type: 'stop', kind, gesture: null, generation })
}

/** Replay a command the session deferred: it was announced when it was asked. */
export function replayDeferredManualMotion<T>(run: () => T): T {
  quiet++
  try {
    return run()
  } finally {
    quiet--
  }
}

/** The controller is being replaced or disconnected. */
export function announceManualMotionConnection(): void {
  generation++
  deliver({ type: 'connection', generation })
}

/** Test isolation only. */
export function __resetManualMotionInputForTest(): void {
  listeners.clear()
  currentGesture = null
  quiet = 0
}
