// heldJog - the one continuous ("hold to jog") route every jog control uses.
//
// WO-2468: this lived inside JogPanel.tsx, so the desktop Control screen was
// the only caller that had it. The phone pendant wrote its own: ONE relative
// jog of the axis's whole travel, stopped by release. The simulator refuses
// any jog whose end is outside travel, so from mid-table nothing moved, and Z-
// never moved at all (Z travel 129.2 against a 129.1 soft limit). Operator,
// 2026-10-02: "I am running into problems now in the simulator when I try and
// jog continuous from my phone via pendant." Both callers now start a held jog
// here, and there is no second jog mechanism to drift from this one.
//
// Two shapes, chosen by what the controller can do:
// - the controller's own run-until-stopped jog (`jogStartContinuous`), kept
//   alive by `jogHold` - the bridge stops the axis when the holds stop;
// - otherwise a train of short bursts, paced to the machine and clamped to the
//   travel end where the end is known (GRBL's recommended pattern,
//   docs/machine/GRBL-PROTOCOL.md, Jogging).
// Either way `stop()` is the release: it ends the timers first, then sends
// jogStop (native) and the jog-cancel.

import { useMachineControl } from '../../store/machineControlStore'
import type { MachinePosition } from './types'
import {
  currentResolvedMachineMotion,
  getMachineController,
  type ControlAxis,
} from './machineSession'
import { unhomedAxes } from './controller'

/** How often the burst route sends its next step while a press is held. */
export const CONTINUOUS_INTERVAL_MS = 150

/**
 * How often a held NATIVE jog says "still holding" (WO-1111). Deliberately far
 * shorter than the burst interval above, and it is not the same number for a
 * reason worth keeping.
 *
 * THE BRIDGE'S DEADMAN WINDOW IS 250 ms. Sending a hold every 150 ms left only
 * 100 ms of slack - one skipped frame and the machine stops under the
 * operator's finger. That is not theoretical: Operator's FIRST jog after homing did
 * exactly this on 2026-08-29 (bridge log, one firing, immediately after the
 * homing lines), when the app was busy re-rendering the DRO and the homed
 * badges. He had to release and press again.
 *
 * 75 ms puts three holds inside every window instead of one and a half.
 *
 * IT COSTS NO SAFETY, which is the point: worst-case travel after a client dies
 * is set by the WINDOW, not by how often we talk. Holding more often makes the
 * deadman harder to trip by accident without making it any slower to fire when
 * it is meant to.
 */
export const JOG_HOLD_INTERVAL_MS = 75

/**
 * WO-2257: THE HOLD ALSO RIDES THE STATUS FRAMES.
 *
 * Operator, 2026-09-30, at the machine: "it's in continuous but when I click x
 * minus it's stopping" - on Main and on Probing. A moving axis brings a status
 * frame every 25 ms, and every frame re-renders whatever reads the position.
 * On a busy screen those frames queue up faster than the page works through
 * them, and a plain interval waits behind the queue: holds measured 400-1200 ms
 * apart on Probing with an EMPTY console, and the bridge stopped the axis at
 * 250 ms.
 *
 * The store applies each frame synchronously, inside the frame's own task and
 * before React renders it, so a hold sent from the store subscription goes out
 * once per frame the page processes, however long the renders behind it queue.
 * The interval stays: it is the cadence when frames are quiet. The caller
 * clears the timer and unsubscribes BEFORE it sends its stop. A page that has
 * truly frozen processes no frames and fires no timers, so the bridge's
 * deadman still stops the axis.
 *
 * Sends the first hold now (see the caller), then returns both handles.
 */
export function keepHeldJogAlive(jogHold: () => void): {
  timer: ReturnType<typeof setInterval>
  unsubscribe: () => void
} {
  let lastHoldAt = Date.now()
  const hold = () => {
    lastHoldAt = Date.now()
    jogHold()
  }
  jogHold()
  const timer = setInterval(hold, JOG_HOLD_INTERVAL_MS)
  const unsubscribe = useMachineControl.subscribe(() => {
    if (Date.now() - lastHoldAt >= JOG_HOLD_INTERVAL_MS / 2) hold()
  })
  return { timer, unsubscribe }
}

/** Each continuous-mode burst moves feed * interval worth of distance, so the
 *  queue never runs far ahead of the cancel byte (low stop latency). */
export function continuousStepMm(feedMmMin: number): number {
  return Math.max(0.05, (feedMmMin / 60000) * CONTINUOUS_INTERVAL_MS * 1.5)
}

/**
 * WO-2128: HOW FAR THE BURST TRAIN MAY QUEUE AHEAD OF THE MACHINE, in steps.
 *
 * Each burst step is 1.5x what the machine covers in one interval, so an
 * unpaced train runs ahead without bound - 40 mm more every second at
 * 5000 mm/min. Operator, 2026-09-28 7:36 AM, simulator: after a few seconds of
 * holding X- the QUEUED end passed X 0 while the machine was still at X 98.3,
 * the controller (which checks each step against the end of its queue)
 * refused the next one, and the console said "Nothing moved" under a moving
 * axis. A step is only sent while the queue is less than this many steps
 * ahead of where the machine last said it was.
 *
 * WHY SIX, NOT ONE OR TWO: the lead is measured from the controller's last
 * REPORTED position, and GRBL (the other burst-route backend) reports only
 * once a second while it reads idle - so at the start of a hold its position
 * can be a whole second old. Six steps are 1.35 s of travel at any feed, so a
 * stale report can never starve the train into a stutter. Release still stops
 * at once: jogCancel drops the queue, however long it is.
 */
const BURST_AHEAD_STEPS = 6

/**
 * WO-2128: the burst route's sender for one held press. It sends a step only
 * while the queue is close to the machine, and shortens the last one so it
 * lands on the end of the travel the session judges every jog against
 * (`currentResolvedMachineMotion().envelope`, the same one the step-jog
 * refusal reads). At the end it stops sending, and once the axis is there it
 * says so, once.
 * With no machine position, it sends every step as it always did.
 *
 * THE END IS ONLY KNOWN WHERE IT IS KNOWN (WO-2128 audit): the simulator
 * enforces its profile box homed or not, and a homed axis has a datum. An
 * UNHOMED real controller's position is its power-up count, not a fact about
 * the table (machineEnvelope.ts safeMachinePosition) - clamping to it stopped
 * a held GRBL Z+ after one step. There the train is paced but never clamped,
 * and the controller answers for its own travel, as it always did.
 *
 * Each call returns false when the controller refused the step it sent.
 */
export function heldBurstSender(
  ctrl: ReturnType<typeof getMachineController>,
  axis: ControlAxis,
  sign: 1 | -1,
  feedMmMin: number,
  say: (text: string, severity: 'info' | 'error') => void,
  endIsKnown: boolean,
): () => false | void {
  const step = continuousStepMm(feedMmMin)
  const key = axis.toLowerCase() as keyof MachinePosition
  const position = (): number | undefined => {
    const at = ctrl.status().machinePos?.[key]
    return typeof at === 'number' && Number.isFinite(at) ? at : undefined
  }
  let queuedEnd = position()
  let sentAny = false
  /** The travel end the queue has reached; nothing more is sent after it. */
  let travelEnd: number | null = null
  let finished = false
  return () => {
    if (finished) return
    const at = position()
    if (travelEnd !== null) {
      // Said when the AXIS is there, not when the queue is: a line while it is
      // still on its way would be the same lie this order removes. Released
      // before it arrives, the interval is gone and nothing is said.
      if (at !== undefined && Math.abs(at - travelEnd) <= ARRIVED_MM) {
        finished = true
        say(`Jog ${axis}${sign > 0 ? '+' : '-'}: ${axis} reached the end of its travel at machine ${axis} ${travelEnd.toFixed(3)} and stopped there.`, 'info')
      }
      return
    }
    let delta = step
    if (queuedEnd !== undefined && at !== undefined) {
      if ((queuedEnd - at) * sign >= BURST_AHEAD_STEPS * step) return
      const env = endIsKnown && (key === 'x' || key === 'y' || key === 'z')
        ? currentResolvedMachineMotion().envelope[key]
        : null
      if (env) {
        const room = sign > 0 ? env.max - queuedEnd : queuedEnd - env.min
        if (room > END_OF_TRAVEL_MM) {
          delta = Math.min(step, room)
        } else if (sentAny) {
          travelEnd = sign > 0 ? env.max : env.min
          return
        }
        // Otherwise the press STARTED at (or past) the end: the full step goes
        // and the controller answers it, as it always did.
      }
    }
    if (ctrl.jog(axis, sign * delta, feedMmMin)) {
      sentAny = true
      if (queuedEnd !== undefined) queuedEnd += sign * delta
    } else {
      // The controller's answer, already on the console through the session.
      // Sending the same step again every interval would only repeat it.
      finished = true
      return false
    }
  }
}

/** Less room than this before the end of travel is no room to send. */
const END_OF_TRAVEL_MM = 0.001
/** A reported position this close to the end of travel is there (reports
 *  round to the micron or coarser). */
const ARRIVED_MM = 0.01


/** One held press, from the press to its release. */
export interface HeldJog {
  /** The release. Clears the timer and the status-frame keep-alive BEFORE it
   *  sends the stop, so nothing may follow it; then jogStop for a native jog
   *  and jogCancel always. Reads the controller current at release. */
  stop(): void
  /** Whether the controller took the start: the native start's answer, or
   *  whether the first burst was refused. The controller's own reason is
   *  already on the console through the session. */
  started: Promise<boolean>
}

/**
 * Start a held jog of `axis` in `sign`'s direction at `feedMmMin`.
 *
 * `onNotStarted` runs when a native start is refused - by the soft limits, an
 * unhomed axis, a feed over the axis maximum. There is no fallback to bursts:
 * the refusal is an answer, and quietly jogging some other way would be
 * ignoring it. The desktop passes its own release here; the pendant passes one
 * that ends this hold.
 */
export function startHeldJog(
  axis: ControlAxis,
  sign: 1 | -1,
  feedMmMin: number,
  say: (text: string, severity: 'info' | 'error') => void,
  onNotStarted: () => void,
): HeldJog {
  const ctrl = getMachineController()
  let timer: ReturnType<typeof setInterval> | null = null
  let unsubscribe: (() => void) | null = null
  let native = false
  const stop = () => {
    if (timer === null) return
    clearInterval(timer)
    timer = null
    // Before the stop goes out: nothing below may be followed by a hold.
    unsubscribe?.()
    unsubscribe = null
    const current = getMachineController()
    // WO-1111: a native continuous jog is ended by its own verb, which also
    // disarms the bridge's deadman. jogCancel is still sent after it - this
    // is the release path, and sending one stop too many has never hurt
    // anybody. Both are safe to call when no jog is running.
    if (native) {
      native = false
      current.jogStop?.()
    }
    current.jogCancel()
  }

  // WO-1111: ONE MOTION IF THE CONTROLLER CAN DO ONE.
  //
  // Operator, 2026-08-29, at the machine: "jog is still stuttery, especially at
  // the beginning... I can see the feedrate under the DRO vary during
  // continous jog." The burst train below is why - the controller ramps into
  // and out of every 150 ms step. A backend that can run its own jog gets to.
  //
  // The interval does not go away, it changes job: it stops being the thing
  // that MOVES the machine and becomes the thing that keeps it moving. Miss
  // those holds and the backend stops the axis itself, which is what makes a
  // run-until-stopped motion safe to start at all.
  if (ctrl.jogStartContinuous && ctrl.jogHold) {
    native = true
    const started = ctrl.jogStartContinuous(axis, sign, feedMmMin).then((ok) => {
      if (!ok) onNotStarted()
      return ok
    })
    // THE FIRST HOLD GOES NOW, not one interval from now. setInterval does
    // not fire immediately, so the gap between arming the deadman and the
    // first keepalive used to be a whole interval on top of the round trip -
    // the widest gap in the whole hold, sitting exactly where the app is
    // busiest (the press that follows a home).
    const alive = keepHeldJogAlive(() => ctrl.jogHold?.())
    timer = alive.timer
    unsubscribe = alive.unsubscribe
    return { stop, started }
  }

  const endIsKnown = useMachineControl.getState().connectionKind === 'simulator'
    || ((axis === 'X' || axis === 'Y' || axis === 'Z') && unhomedAxes(ctrl, [axis]).length === 0)
  const sendStep = heldBurstSender(ctrl, axis, sign, feedMmMin, say, endIsKnown)
  const first = sendStep()
  timer = setInterval(sendStep, CONTINUOUS_INTERVAL_MS)
  return { stop, started: Promise.resolve(first !== false) }
}
