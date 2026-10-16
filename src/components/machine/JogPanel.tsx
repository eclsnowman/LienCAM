import { textFor, useText } from '../../i18n'
const controlText = textFor('control-screens-not-probing')

// JogPanel - manual machine motion (MACHINE-CONTROL plan, stage 5).
//
// Color contract: every control in this panel MOVES THE MACHINE, so nothing
// here may look passive. WO-354 supersedes WO-331's three unrelated axis
// colors with one theme-derived control family. Axis and direction remain
// distinguishable without color: Y has one outward rail, X has two, and Z
// has three. Home All and Safe Z retain their existing motion treatment.
//
// PER-AXIS HOME: THREE EXPLICIT BUTTONS (WO-931), NOT A MODIFIER.
//
// WO-927 built this as an Alt-click on the jog buttons, obeying the standing
// rule that the rail has no vertical budget - "reuse the surface, add no
// elements, never grow the layout". Operator REJECTED it (WO-931): "Using the alt
// key for homing an axis sets a user up to crash or break an endmill if they
// don't know the functionality exists. I want selecting things to be
// explicit."
//
// RECORD THAT AS A RESOLUTION, NOT A CHANGE OF MIND, or the next lane will
// re-derive the modifier from the older rule and ship the hazard twice:
// A CONTROL THAT COMMANDS MOTION MUST BE DISCOVERABLE WITHOUT ALREADY KNOWING
// IT EXISTS, and that beats the no-growth rule whenever the control moves a
// machine. A hidden gesture is discoverable by accident, and here the accident
// is an axis moving.
//
// The no-growth rule still binds otherwise, and it was honoured by PAYING for
// the row rather than arguing for it - Operator's own solution, 2026-08-24: the
// jog step sizes became a dropdown beside Continuous and the feed joined that
// row, which bought back nearly all of the height. Measured 343px -> 349px.
//
// Per-axis homing is an explicit operator choice (WO-1120). The gantry
// refusal, capability gate, and a refused home not marking the session homed
// remain controller guarantees; the app does not impose the Home All order on
// a single-axis request.
//
// Two jog styles, matching GRBL's own recommended patterns
// (docs/machine/GRBL-PROTOCOL.md, Jogging):
// - step mode: one $J=G91 increment per click
// - continuous mode: press-and-hold re-sends short increments on an interval,
//   pointer release sends the realtime jog-cancel byte (0x85)

import { memo, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { ArrowUpToLine, Home, Unlock } from 'lucide-react'
import { controlMachine, useCamStore } from '../../store'
import { bridgePresence, useMachineControl } from '../../store/machineControlStore'
import { parkCarrierMachine, useMachineActions } from '../../store/machineActionsStore'
import { machineSafeZValue } from '../../lib/machine/machineActions'
import { startHeldJog, type HeldJog } from '../../lib/machine/heldJog'
import {
  controllerCapabilities,
  estopNeedsReset,
  getMachineController,
  jogToSafeZ,
  pausedProgramTakesCommands,
  subscribeEstopNeedsReset,
  subscribePausedProgramTakesCommands,
  softLimitLatchActive,
  subscribeSoftLimitLatch,
  subscribeToolChangeHold,
  toolChangeHoldActive,
  type ControlAxis,
} from '../../lib/machine/machineSession'
import { enabledControlAxes, resolveHomingOrder } from '../../lib/machine/controller'
import { authorize, type OperatorAuthorityFacts } from '../../lib/machine/operatorAuthority'
import { machineHasNoHomeSwitches } from '../../types'
import { useUiPrefs } from '../../store/uiPrefs'
import { useDisplayUnits } from './useDisplayUnits'
import { bridgeHostCapability } from '../../lib/machine/bridgeHost'
import { controllerSurface } from '../../lib/machine/controllerSurface'
import {
  ControlCollapsedReadout,
  ControlPanelCollapseToggle,
  useControlPanelCollapsed,
} from './ControlPanelCollapseToggle'
import {
  MM_PER_INCH,
  feedLabel,
  fmtMachineLength,
  feedToDisplay,
  parseFeedToMmMin,
  unitLabel,
} from '../../lib/ui/unitFormat'
import { NumCell } from './NumCell'

/** Step choices per display unit; stored pref stays mm (canonical). */
const STEP_CHOICES: Record<'mm' | 'inch', number[]> = {
  mm: [0.01, 0.1, 1, 10, 50, 100],
  // Keep the unit toggle equivalent at the large end: 2 and 4 inches are
  // the inch-sized counterparts to the new 50 and 100 mm choices.
  inch: [0.001, 0.01, 0.1, 1, 2, 4],
}

/** WO-2817: shared Home guidance, not an off-switch prerequisite.
 * Revert 313b6a630cfe records two normal re-homes from the resting switches.
 * The controller owns the cycle; these words must not add an operator step.
 * Keep the exported name for existing consumers of the shared hint.
 */
export const HOME_PRECONDITION =
  controlText('JogPanel.text001')
  + controlText('JogPanel.text002')
  + controlText('JogPanel.text003')

/** The axis colour tokens the rest of the app already uses. Operator chose the
 *  coloured form on sight (2026-08-24) over the plain one this seat
 *  recommended; he was shown both renders. Uses the app's own spelling,
 *  `--x-axis` (app.css:74), as MachineDefinitionPanel.tsx:91 does. */
function axisHomeColour(axis: ControlAxis): string | undefined {
  return axis === 'X' || axis === 'Y' || axis === 'Z'
    ? `var(--${axis.toLowerCase()}-axis)`
    : undefined
}

const JOG_WEDGE_PATHS = {
  'Y+': 'M 0 0 H 176 L 88 88 Z',
  'X+': 'M 176 0 V 176 L 88 88 Z',
  'Y-': 'M 176 176 H 0 L 88 88 Z',
  'X-': 'M 0 176 V 0 L 88 88 Z',
} as const

function JogButtonPlate({ axis, sign }: { axis: ControlAxis; sign: 1 | -1 }) {
  const direction = sign === 1 ? 'plus' : 'minus'
  if (axis === 'Z') {
    // The selected Gentle correction keeps the three rails individually
    // legible. Moving the label and stack inward together preserves their
    // 7px relationship while giving the rounded outer edge room to breathe.
    const positions = sign === 1 ? [18, 24, 30] : [82, 76, 70]
    const transform = sign === 1 ? 'translate(0 -3.68)' : 'translate(0 3.68)'
    return (
      <svg className="control-jog-plate" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        <rect className="control-jog-face" x="4" y="4" width="92" height="92" rx="14" />
        <g className="control-jog-rails" data-axis="Z" data-direction={direction} transform={transform}>
          {positions.map((y) => <line key={y} x1="28" y1={y} x2="72" y2={y} />)}
        </g>
      </svg>
    )
  }

  const key = `${axis}${sign === 1 ? '+' : '-'}` as keyof typeof JOG_WEDGE_PATHS
  const transform = axis === 'X'
    ? sign === 1 ? 'translate(0.85 0)' : 'translate(-0.85 0)'
    : sign === 1 ? 'translate(0 4.23)' : 'translate(0 -4.23)'
  const rails = axis === 'X'
    ? (sign === 1 ? [150, 160] : [16, 26]).map((x) => (
        <line key={x} x1={x} y1="62" x2={x} y2="114" />
      ))
    : [sign === 1 ? 16 : 160].map((y) => (
        <line key={y} x1="60" y1={y} x2="116" y2={y} />
      ))

  return (
    <svg className="control-jog-plate" viewBox="0 0 176 176" preserveAspectRatio="none" aria-hidden="true">
      <path className="control-jog-face" d={JOG_WEDGE_PATHS[key]} />
      <g className="control-jog-rails" data-axis={axis} data-direction={direction} transform={transform}>
        {rails}
      </g>
    </svg>
  )
}

function JogPanelView({
  selectedConnectionKind,
}: {
  selectedConnectionKind?: 'serial' | 'simulator' | 'bridge' | 'gateway'
} = {}) {
  useText('control-screens-not-probing')
  const machineState = useMachineControl((s) => s.machineState)
  const connected = useMachineControl((s) => s.connectionPhase) === 'connected'
  const connectionPhase = useMachineControl((s) => s.connectionPhase)
  const connectionKind = useMachineControl((s) => s.connectionKind)
  const connectionDetail = useMachineControl((s) => s.connectionDetail)
  const bridgeControllerPresence = useMachineControl((s) => s.bridgeControllerPresence)
  const bridgeProcessPresence = useMachineControl((s) => s.bridgeProcessPresence)
  const jobPhase = useMachineControl((s) => s.job.phase)
  /**
   * WO-1330: THE ONE PAUSED STATE THAT MAY BE JOGGED.
   *
   * A paused program disables jog, and it is right to: the machine is standing
   * in the middle of a path it is about to resume. A tool-change hold is the
   * exception Operator ruled for from the machine (2026-09-11) - the spindle is
   * stopped, the tool has retracted clear, and the operator has to reach the
   * spindle and then touch the new tool off, both of which are jogs. Held at
   * one, this panel is live exactly as it is when the machine is idle.
   */
  const toolChangeHold = useSyncExternalStore(
    subscribeToolChangeHold,
    toolChangeHoldActive,
    () => false,
  )
  // WO-2237: a pause the session keeps as a stop takes a jog or Safe Z; a hold
  // another flow owns stays locked, as before.
  const pauseTakesCommands = useSyncExternalStore(
    subscribePausedProgramTakesCommands,
    pausedProgramTakesCommands,
    () => false,
  )
  const homed = useMachineControl((s) => s.homed)
  const softLimitLatched = useSyncExternalStore(
    subscribeSoftLimitLatch,
    softLimitLatchActive,
    () => false,
  )
  // WO-328/WO-1349, Operator 2026-09-14 ("A: Flash, all motion off"): while the
  // E-STOP blinks for CLEAR, home, jog and safe Z are dead, not merely refused.
  const estopLatched = useSyncExternalStore(subscribeEstopNeedsReset, estopNeedsReset, () => true)
  const machine = useCamStore(controlMachine)
  const machineId = machine.id ?? 'default'
  // WO-1670: the definition's safe Z (a UCCNC profile states it), never retyped.
  const storedActions = useMachineActions((s) => s.byMachine[machineId])
  const safeZ = machineSafeZValue(useCamStore(parkCarrierMachine), storedActions)
  /**
   * WO-985: the MODE, subscribed so this panel re-renders when the machine
   * changes. Subscribes to the resolved Control machine itself and not just to
   * `controllerDefinition` below, because the WO-301 `noHomingSwitches`
   * declaration is the other way a machine says it has none.
   *
   * Used for WORDING ONLY here. Safe Z stays disabled exactly as it was -
   * it is a machine coordinate and this machine has no machine coordinates.
   * What changes is that the tooltip stops sending the operator to home a
   * machine with nothing to home with.
   */
  const noHomeSwitches = machineHasNoHomeSwitches(machine)
  const jogStep = useUiPrefs((s) => s.machineJogStepMm)
  const jogFeed = useUiPrefs((s) => s.machineJogFeedMmMin)
  const jogContinuous = useUiPrefs((s) => s.machineJogContinuous)
  const setPref = useUiPrefs.setState
  const units = useDisplayUnits()
  const collapsed = useControlPanelCollapsed('jog')
  /** The press being held in continuous mode (WO-2468: the shared route in
   *  heldJog.ts - native jog with keep-alives, or the burst train). */
  const heldJog = useRef<HeldJog | null>(null)
  const homePendingTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const homingInFlightRef = useRef(false)
  const [homeRequestPending, setHomeRequestPending] = useState(false)

  const presence = bridgePresence({
    connectionPhase,
    connectionKind,
    bridgeControllerPresence,
    bridgeProcessPresence,
  })
  const selectedTransport = connectionKind ?? selectedConnectionKind
  const hasBridgeSurface = controllerSurface(machine).bridgeSettings
    && selectedTransport === 'bridge'
  const canOwnBridge = bridgeHostCapability() !== 'unhosted'
  const bridgeIncidentObserved = connectionDetail !== null
    || bridgeProcessPresence !== 'unknown'
  const bridgeJogRefusal = !hasBridgeSurface || !bridgeIncidentObserved
    ? null
    : presence.socket === 'closed'
      ? canOwnBridge
        ? controlText('JogPanel.text004')
        : controlText('JogPanel.text005')
      : canOwnBridge && (presence.process === 'stopped' || presence.process === 'gave-up')
        ? controlText('JogPanel.text006')
        : null
  // WO-914 SAFETY: HOME ALL PASSES THIS MACHINE'S OWN ORDER.
  //
  // The order the axes home in is a per-machine setting, not a preference:
  // homing Z last on a router with a tool in the spindle drives the tool
  // through the work on its way to the X or Y switch. Until this landed
  // nobody passed an order at all and the bridge held one hardcoded C#
  // literal for every machine on earth. `resolveHomingOrder` is the ONE place
  // the fallback lives - it is USED here, never duplicated.
  const controllerDefinition = machine.controllerDefinition ?? null
  const homingOrder = resolveHomingOrder(controllerDefinition)
  const controlAxes = enabledControlAxes(controllerDefinition)
  const hasXJog = controlAxes.includes('X')
  const hasYJog = controlAxes.includes('Y')
  const hasZJog = controlAxes.includes('Z')
  const rotaryAxes = controlAxes.filter(
    (axis): axis is Extract<ControlAxis, 'A' | 'B' | 'C'> =>
      axis === 'A' || axis === 'B' || axis === 'C',
  )

  /** Which axes get an explicit Home button, and IN WHAT ORDER: this machine's
   *  own homing order, filtered to the three the jog panel drives.
   *
   *  NOT a `['Z','X','Y']` constant. WO-914's one-place rule exists because a
   *  second copy of that literal is exactly what put the whole order on the
   *  wire when a single axis had been asked for, and `resolveHomingOrder` is
   *  the one place it is allowed to live. It also means the buttons follow a
   *  machine whose order is Y,X,Z rather than telling its operator a
   *  comfortable lie about Z going first. */
  const homeButtonAxes = [
    ...homingOrder.filter((axis) => controlAxes.includes(axis)),
    ...controlAxes.filter((axis) => !homingOrder.includes(axis)),
  ]
  // Read at render, exactly as ControlPage does: capabilities change only at
  // connect/disconnect, and that transition moves `connectionPhase` in the
  // store, which re-renders this panel.
  const perAxisHoming = controllerCapabilities()?.perAxisHoming === true
  const homingInFlight = homeRequestPending || machineState === 'home'
  // WO-1330 (audit): the tool-change hold lends jog and the incoming frame's Z
  // zero, nothing else. Homing replaces the machine datum the staged setup is
  // about to run on, so the Home buttons stay locked for the whole hold.
  // WO-1992: every gate on this panel - jog, home, safe Z, unlock - is a row
  // of the operator authority table. Operator ruling 2026-09-14: while the E-STOP blinks
  // every motion control is dead and says why, in the transport header's words.
  const authorityFacts: OperatorAuthorityFacts = {
    connected,
    machineState,
    jobPhase,
    estopLatched,
    homed,
    noHomeSwitches,
    softLimitLatched,
    toolChangeHold,
    pauseTakesCommands,
    homingInFlight,
    bridgeJogRefusal,
    safeZSet: safeZ !== null,
  }
  const jogGate = authorize('jog', authorityFacts)
  const jogAllowed = jogGate.allowed
  const homeGate = authorize('home', authorityFacts)
  const safeZGate = authorize('safeZ', authorityFacts)
  const unlockGate = authorize('unlock', authorityFacts)

  // The status push normally changes to `home` almost immediately, but the
  // click must close before that round trip: the measured duplicates arrived
  // as quickly as 0.5 s apart. Hold a short request latch until the controller
  // reports Home. If a controller refuses without ever entering Home, release
  // it rather than leaving the controls dead for the rest of the session.
  useEffect(() => {
    homingInFlightRef.current = homingInFlight
    if (machineState !== 'home' || !homeRequestPending) return
    if (homePendingTimer.current !== null) clearTimeout(homePendingTimer.current)
    homePendingTimer.current = null
    setHomeRequestPending(false)
  }, [homeRequestPending, homingInFlight, machineState])

  useEffect(() => () => {
    if (homePendingTimer.current !== null) clearTimeout(homePendingTimer.current)
  }, [])

  const markHomingRequested = () => {
    homingInFlightRef.current = true
    setHomeRequestPending(true)
    if (homePendingTimer.current !== null) clearTimeout(homePendingTimer.current)
    homePendingTimer.current = setTimeout(() => {
      homePendingTimer.current = null
      setHomeRequestPending(false)
    }, 5000)
  }

  // The console is the machine's message surface (Operator, four times now:
  // reuse an existing surface, never a new element, never one that shifts
  // the layout). Keep Home All and Home One on the same route.
  const say = (text: string, severity: 'info' | 'error') =>
    useMachineControl.getState().pushConsole('tx', text, severity)

  const homeRefusal = (
    ctrl: ReturnType<typeof getMachineController>,
    fallback: string,
  ): string => {
    // A synchronous controller may retain the reason beside its boolean
    // without widening the cross-backend contract. Message controllers report
    // later failures through onConsole instead and use the generic fallback
    // only when their synchronous gate returns false.
    const withReason = ctrl as typeof ctrl & {
      homeAxesRefusal?: () => string | null
    }
    return withReason.homeAxesRefusal?.() ?? fallback
  }

  const homeAll = () => {
    if (homingInFlightRef.current) return
    const ctrl = getMachineController()
    // A controller that homes per axis is told the order. One that does not
    // (GRBL: `$H` runs the sequence its own firmware config holds) is asked
    // for its own cycle instead - we do not get to choose it there, and
    // saying otherwise in the tooltip would be a lie.
    if (ctrl.capabilities.perAxisHoming && typeof ctrl.homeAxes === 'function') {
      if (!ctrl.homeAxes(homingOrder)) {
        say(homeRefusal(ctrl, controlText('JogPanel.text007')), 'error')
      } else {
        markHomingRequested()
      }
      return
    }
    if (!ctrl.home()) {
      say(controlText('JogPanel.text008'), 'error')
    } else {
      markHomingRequested()
    }
  }

  /**
   * HOME EXACTLY ONE AXIS - from that axis's own labelled Home button
   * (WO-931; it was WO-927's Alt-click until Operator rejected the modifier).
   *
   * WO-1120: selecting one axis is the operator's choice. The app sends that
   * choice on the first press regardless of Home All's configured order.
   *
   * The gantry guarantee remains: this is `homeAxes([axis])`, the SAME call Home All
   * makes, so a bridge refusal (Y slaved to A with the board not holding the
   * slave) rejects the same promise, lands on the same console through
   * `reportCallFailure` -> `onConsole`, and reads the same. Nothing here
   * intercepts, summarises or swallows it.
   *
   * The GRBL guarantee remains: `capabilities.perAxisHoming` is false there. The gesture
   * is not advertised (see the jog tooltips) and, if tried anyway, says so
   * rather than quietly sending a whole-machine `$H`.
   */
  const homeOneAxis = (axis: ControlAxis) => {
    if (homingInFlightRef.current) return
    const ctrl = getMachineController()

    if (!ctrl.capabilities.perAxisHoming || typeof ctrl.homeAxes !== 'function') {
      say(
        controlText('JogPanel.text009') +
        controlText('JogPanel.text010') +
        controlText('JogPanel.text011', { value1: String(axis) }),
        'error',
      )
      return
    }

    if (!ctrl.homeAxes([axis])) {
      say(homeRefusal(ctrl, controlText('JogPanel.text012', { value1: String(axis) })), 'error')
      return
    }
    markHomingRequested()
    say(controlText('JogPanel.text013', { value1: String(axis) }), 'info')
  }

  const stopContinuous = () => {
    const held = heldJog.current
    if (held !== null) {
      heldJog.current = null
      // Clears the timer and the frame keep-alive first, then jogStop (native)
      // and jogCancel, on the controller current at release.
      held.stop()
    }
  }

  // WO-1993 SAFETY: pointer release is not guaranteed when the browser itself
  // loses focus or its tab is hidden. Stop through the SAME release path so a
  // native bridge jog gets jogStop + jogCancel and a fallback burst jog loses
  // its interval immediately, without waiting for the bridge's 250 ms deadman.
  useEffect(() => {
    const stopWhenHidden = () => {
      if (document.hidden) stopContinuous()
    }
    window.addEventListener('blur', stopContinuous)
    document.addEventListener('visibilitychange', stopWhenHidden)
    return () => {
      window.removeEventListener('blur', stopContinuous)
      document.removeEventListener('visibilitychange', stopWhenHidden)
      stopContinuous()
    }
    // The release path reads refs and the current controller only; installing
    // one listener set for this mount avoids churn during live DRO updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // WO-116 SAFETY: collapsing unmounts the jog buttons, so a pointer held on
  // one (a second finger tapping the chevron on a touchscreen) would never
  // deliver pointerup. Folding the panel must itself cancel an in-flight
  // continuous jog - collapse is a fail-safe stop, never a runaway.
  useEffect(() => {
    if (collapsed) stopContinuous()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collapsed])

  /**
   * SAY IT ONCE PER SESSION: an unhomed machine does not know where it is.
   *
   * Operator at the machine, 2026-08-24, after a Z-1mm jog moved 0.1mm and alarmed:
   * "We have to home first. It doesn't know the true position. You always have
   * to home first. On like any machine that comes to life and does not have
   * absolute encoders... Just make a console note that homing is required if
   * not homed."
   *
   * WHY THE ALARM IS SO MISLEADING WITHOUT THIS. Soft limits are measured FROM
   * THE DATUM, and until the machine homes there is no datum - the controller
   * enforces them against whatever the counters happened to hold at power-on,
   * which is 0. On this machine 0 IS Z's floor (-0.1) and X's and Y's (0), so
   * the first jog travels the sliver left before the limit - 0.1mm on Z, below
   * anything a person can see - and then raises "a move was refused by the
   * controller's soft limits". It reads exactly like a dead axis or a broken
   * jog. It is neither, and the wire proved it: the jog reached the board, the
   * board moved Z to -0.1 and refused the rest, correctly.
   *
   * THIS DOES NOT GATE THE JOG, AND MUST NOT. Relative jogging while unhomed is
   * DELIBERATELY allowed, in the bridge's own words at Machine.cs:1731 - "that
   * is how you get an axis off a limit switch, and it is the ordinary control
   * convention". Gate it and you strand a machine sitting on its own switch.
   *
   * WHAT IS ALREADY REFUSED, so this note does not imply the product has no
   * policy: `RequireHomed()` (Machine.cs:1733) refuses every move to a
   * COORDINATE until the axis is homed - JogToWorkXY (:2257), JogToMachineZ
   * (:2268) and StartJob (:3137). Operator's "connect, clear, home, then move" IS
   * the implemented policy. It was just never said out loud, which is the whole
   * defect: he met it as a silent refusal and it read as a dead axis.
   *
   * CORRECTED 2026-08-24, same evening, and the correction matters more than
   * the note: the first version of this line told the operator to "use Unlock
   * to move without a datum". BOTH HALVES WERE WRONG. Unlock's alarm-only gate
   * could not be pressed on an unhomed IDLE machine - the exact
   * state this note appears in. WO-987 made that existing $X control reachable
   * there, but did not change its meaning: it is an alarm-clear, never an
   * override for moving without a datum. Pointing at it for a thing it does not
   * do was the same class of defect as every lying instrument found this week,
   * and this one was mine, shipped an hour before it was caught.
   *
   * The real answer is that the jog they just pressed IS the way to move
   * without a datum. It already worked. Nobody had ever said so.
   */
  const saidUnhomed = useRef(false)
  useEffect(() => {
    if (homed) saidUnhomed.current = false
  }, [homed])

  const noteUnhomed = () => {
    if (homed || saidUnhomed.current) return
    saidUnhomed.current = true
    useMachineControl.getState().pushConsole(
      'tx',
      controlText('JogPanel.text014')
      + controlText('JogPanel.text015')
      + controlText('JogPanel.text016')
      + controlText('JogPanel.text017')
      + controlText('JogPanel.text018')
      + controlText('JogPanel.text019')
      + controlText('JogPanel.text020')
      + controlText('JogPanel.text021', { value1: String(homingOrder.join(', ')) }),
      'info',
    )
  }

  const pressJog = (axis: ControlAxis, sign: 1 | -1) => {
    if (bridgeJogRefusal !== null) {
      say(bridgeJogRefusal, 'error')
      return
    }
    if (!jogAllowed) return
    // WO-931: ALT NO LONGER HOMES ANYTHING. Operator rejected the modifier - "sets
    // a user up to crash or break an endmill if they don't know the
    // functionality exists. I want selecting things to be explicit." A plain
    // click jogs, an Alt-click jogs, and homing is the three labelled buttons
    // above. There is no hidden gesture on this panel any more.
    noteUnhomed()
    const ctrl = getMachineController()
    if (!jogContinuous) {
      ctrl.jog(axis, sign * jogStep, jogFeed)
      return
    }
    // WO-2468: the held route lives in heldJog.ts so the phone pendant moves
    // through it too. A refused native start ends the press through the same
    // release as a pointer-up.
    heldJog.current = startHeldJog(axis, sign, jogFeed, say, stopContinuous)
  }

  const jogBtn = (
    axis: ControlAxis,
    sign: 1 | -1,
    label: string,
    testid: string,
    className: string,
  ) => (
    <button
      className={className}
      data-testid={testid}
      data-jog-axis={axis}
      data-jog-sign={sign}
      type="button"
      aria-label={controlText('JogPanel.text022', { value1: String(label) })}
      // WO-931: this button jogs, and that is ALL it does. It used to
      // advertise a hidden Alt-click home in its hover text; the home controls
      // are explicit buttons now and nothing about a jog button is a secret.
      // WO-1330: at a tool-change hold the lockout is lifted, so the tooltip
      // must not still announce it - the operator is being ASKED to jog here.
      data-tooltip={jogGate.refusal ?? controlText('JogPanel.text023', { value1: String(label) })}
      // Keep the bridge-failure refusal reachable: a native disabled button
      // receives no pointer event and would recreate the silent-dead-jog
      // defect. The handler above refuses before reading any controller.
      disabled={jogGate.disabled}
      onPointerDown={() => pressJog(axis, sign)}
      onPointerUp={stopContinuous}
      onPointerLeave={stopContinuous}
      onPointerCancel={stopContinuous}
    >
      <JogButtonPlate axis={axis} sign={sign} />
      <span className="control-jog-label">{label}</span>
    </button>
  )

  const rotaryJogBtn = (axis: ControlAxis, sign: 1 | -1) => {
    const direction = sign === 1 ? '+' : '-'
    const label = `${axis}${direction}`
    return (
      <button
        key={label}
        className="control-jog-btn control-jog-sidebtn control-motion-outline"
        data-testid={`control-jog-${axis.toLowerCase()}-${sign === 1 ? 'plus' : 'minus'}`}
        data-jog-axis={axis}
        data-jog-sign={sign}
        type="button"
        aria-label={controlText('JogPanel.text024', { value1: String(label) })}
        data-tooltip={jogGate.refusal
          ?? controlText('JogPanel.text027', { value1: String(label), value2: String(jogContinuous ? controlText('JogPanel.text025') : controlText('JogPanel.text026', { value1: String(jogStep) })) })}
        disabled={jogGate.disabled}
        onPointerDown={() => pressJog(axis, sign)}
        onPointerUp={stopContinuous}
        onPointerLeave={stopContinuous}
        onPointerCancel={stopContinuous}
      >
        {label} {jogContinuous ? controlText('JogPanel.continuousShort') : controlText('JogPanel.text028', { value1: String(jogStep) })}
      </button>
    )
  }

  const stepLabel = jogContinuous
    ? controlText('JogPanel.continuousShort')
    : `${fmtMachineLength(jogStep, units)} ${unitLabel(units)}`

  return (
    <section className="panel control-panel">
      <div className="panel-header">
        <span className="panel-title">{controlText('JogPanel.text029')}</span>
        {/* WO-184: folded, Jog used to show NOTHING - Operator's annotated shot
            left it expanded for exactly that reason ("Jog collapsed is total
            currently, so showing as open"). The D-pad is a CONTROL and stays
            folded; what the operator glances at before touching it - how far
            one press moves and how fast - rides the header. Both come from
            uiPrefs, so changing the mode or feed anywhere updates this live. */}
        {collapsed && (
          <ControlCollapsedReadout testId="control-jog-collapsed-values">
            {stepLabel} - {Math.round(feedToDisplay(jogFeed, units))} {feedLabel(units)}
          </ControlCollapsedReadout>
        )}
        <ControlPanelCollapseToggle
          panel="jog"
          testId="control-jog-toggle"
          collapseTip={controlText('JogPanel.text030')}
          expandTip={controlText('JogPanel.text031')}
        />
      </div>
      {!collapsed && (
      <div className="panel-body control-jog-body">
        {/* Compact directional cluster (Operator 2026-07-31): XY as a nested
            wedge D-pad matching the preview's axis orientation, Z separated
            in its own column so an XY press can never be a Z press - no dead
            space, big hit areas. The three non-nudge machine actions sit in
            their own full-width row below (UI-CONTROL-PAGE-POLISH): as a
            third cluster column their labels no longer fit once the card
            gained real padding. */}
        {(hasXJog || hasYJog || hasZJog) && (
          <div className="control-jog-cluster">
            {(hasXJog || hasYJog) && (
              <div className="control-jog-pad">
                {hasYJog && jogBtn('Y', 1, 'Y+', 'control-jog-y-plus', 'control-jog-wedge wedge-n')}
                {hasXJog && jogBtn('X', 1, 'X+', 'control-jog-x-plus', 'control-jog-wedge wedge-e')}
                {hasYJog && jogBtn('Y', -1, controlText('JogPanel.text032'), 'control-jog-y-minus', 'control-jog-wedge wedge-s')}
                {hasXJog && jogBtn('X', -1, controlText('JogPanel.text033'), 'control-jog-x-minus', 'control-jog-wedge wedge-w')}
                <svg className="control-jog-seams" viewBox="0 0 176 176" preserveAspectRatio="none" aria-hidden="true">
                  <path className="control-jog-seam" d="M 0 0 L 176 176 M 176 0 L 0 176" />
                </svg>
                <span className="control-jog-frame" aria-hidden="true" />
                <span className="control-jog-step-readout">{stepLabel}</span>
              </div>
            )}
            {hasZJog && (
              <div className="control-jog-zcol">
                {jogBtn('Z', 1, 'Z+', 'control-jog-z-plus', 'control-jog-btn control-jog-zbtn')}
                {jogBtn('Z', -1, controlText('JogPanel.text034'), 'control-jog-z-minus', 'control-jog-btn control-jog-zbtn')}
              </div>
            )}
          </div>
        )}
        {rotaryAxes.length > 0 && (
          <div
            className="control-jog-actions"
            data-testid="control-jog-rotary-axes"
            style={{ gridTemplateColumns: `repeat(${rotaryAxes.length * 2}, minmax(0, 1fr))` }}
          >
            {rotaryAxes.flatMap((axis) => [rotaryJogBtn(axis, -1), rotaryJogBtn(axis, 1)])}
          </div>
        )}
        {/* ---- HOMING ------------------------------------------------------
            WO-931. Operator rejected Alt-click-to-home: "Using the alt key for
            homing an axis sets a user up to crash or break an endmill if they
            don't know the functionality exists. I want selecting things to be
            explicit."

            THREE EXPLICIT BUTTONS, ONE ROW, and the axis colours the app
            already uses - his choice on sight, 2026-08-24, over the plain
            version this seat recommended. He was shown both.

            THE ROW IS PAID FOR, NOT ADDED. Measured, the rail is 254px and
            four home controls do not fit one line - two attempts wrapped. His
            answer was better than arguing for the row: reclaim it. The step
            sizes below became a dropdown beside Continuous, which is where the
            height comes from.

            Ordered Z, X, Y - his machine's real homing order, NOT alphabetical.
            Z first is a safety default: homing Z last with a tool in the
            spindle drives it through the work on the way to the X or Y switch. */}
        <div className="control-jog-actions" data-testid="control-home-row">
          {homeButtonAxes.map((axis) => {
            if (!perAxisHoming) return null
            return (
              <button
                key={axis}
                type="button"
                className="control-jog-btn control-jog-sidebtn control-home-outline"
                data-testid={`control-home-${axis.toLowerCase()}`}
                data-home-axis={axis}
                disabled={homeGate.disabled}
                onClick={() => homeOneAxis(axis)}
                aria-label={homingInFlight ? controlText('JogPanel.text035') : controlText('JogPanel.text036', { value1: String(axis) })}
                aria-busy={homingInFlight}
                style={{ color: axisHomeColour(axis) }}
                data-tooltip={
                  homeGate.refusal ??
                  controlText('JogPanel.text037', { value1: String(axis) })
                  + controlText('JogPanel.text038', { value1: String(homingOrder.join(', ')) })
                  + HOME_PRECONDITION
                }
              >
                <Home size={13} /> {homingInFlight ? '...' : axis}
              </button>
            )
          })}
        </div>

        <div className="control-jog-actions">
          <button
            className="control-jog-btn control-jog-sidebtn control-home-outline"
            data-testid="control-home"
            disabled={homeGate.disabled}
            aria-busy={homingInFlight}
            onClick={homeAll}
            data-tooltip={
              homeGate.refusal ?? (perAxisHoming
                ? controlText('JogPanel.text039', { value1: String(homingOrder.join(', ')) })
                : controlText('JogPanel.text040'))
              + HOME_PRECONDITION
            }
          >
            <Home size={13} /> {homingInFlight ? 'Homing...' : controlText('JogPanel.text041')}
          </button>
          <button
            className="control-jog-btn control-jog-sidebtn control-motion-outline"
            data-testid="control-safez"
            disabled={safeZGate.disabled}
            onClick={() => {
              const rapid = controlMachine(useCamStore.getState()).rapidRate ?? 3000
              jogToSafeZ(safeZ, rapid)
            }}
            data-tooltip={
              safeZGate.refusal
                ?? controlText('JogPanel.text042', { value1: String(safeZ) })
            }
          >
            <ArrowUpToLine size={13} />{controlText('JogPanel.text043')}</button>
          <button
            className="modal-btn modal-btn-ghost control-jog-sidebtn"
            data-testid="control-unlock"
            disabled={unlockGate.disabled}
            onClick={() => getMachineController().unlock()}
            data-tooltip={unlockGate.refusal ?? controlText('JogPanel.text044')}
          >
            <Unlock size={13} />{controlText('JogPanel.text045')}</button>
        </div>
        {/* WO-993: THE "Set machine position" BUTTON WAS DELETED HERE, and it
            is deleted rather than moved. Operator, 2026-08-25, at the machine:
            "there's no reason to set the machine position when a machine has
            homing sensors ... we already have a mechanism to do that and
            that's by typing the values into the machine. Dro readouts. that
            should be our mechanism not adding another f****** button."

            THREE THINGS THAT RULING SETTLES, so nobody re-adds it:
            1. IT WAS THE WRONG MECHANISM, not just the wrong placement. Manual
               datum entry belongs on the DRO readout that already exists.
            2. IT IS ONLY EVER RELEVANT ON A SWITCHLESS MACHINE. A machine with
               working home switches homes, and homing IS the datum - it must
               not be offered manual datum entry at all. Affordances that belong
               to the switchless MODE key off the mode (WO-985), like every
               other one in this family.
            3. Its own row pushed MACROS off the bottom of the rail. REUSE A
               ROW, NEVER ADD ONE - and this did not even need a row.

            The `setMachinePosition` seam in machineSession/controller/
            simulatedController is DELIBERATELY KEPT: it is the mechanism the
            DRO route needs, and it is covered by WO-986's tests. Only this
            control and its confirm card are gone. See WO-994 for the DRO
            route, which is NOT a simple rename - committing a machine-column
            edit today calls `attemptGoto`, which MOVES the machine. */}
        {/* ---- JOG CONFIG, COMPACTED ---------------------------------------
            WO-931, Operator: "regain some room by changing the stepsize selector
            into a dropdown so it can fit next to continuous. That will save
            vertical space. Perhaps if we are creative we can fit speed there
            as well and gain two lines to avoid the scroll."

            Three rows became one. The step sizes were chips on a row of their
            own; they are a dropdown now, which is the right control for
            choosing among the six available sizes and costs a fraction of the
            width. Feed rides the same line.

            THE STEP SIZE STAYS VISIBLE WITHOUT OPENING THE DROPDOWN - a closed
            select shows its current value, and the pad's own step readout
            still shows it too. This does not hide a number an operator jogs
            by; it stops spending a whole row on four buttons. */}
        <div className="control-jog-config">
          <div className="control-jog-config-row" style={{ gap: 4 }}>
            <button
              className={`control-chip-btn ${!jogContinuous ? 'control-chip-active' : ''}`}
              // WO-1801: stable hook for this chip. The printed word "Step" is
              // ambiguous - the program single-block Step button
              // (control-step-forward) shows the same word - so automation
              // selects this mode control by id, paired with the existing
              // control-jog-continuous sibling. Test hook only: no behavior,
              // default mode, layout or handler change rides on this line.
              data-testid="control-jog-step-mode"
              onClick={() => setPref({ machineJogContinuous: false })}
            >{controlText('JogPanel.text046')}</button>
            <button
              className={`control-chip-btn ${jogContinuous ? 'control-chip-active' : ''}`}
              data-testid="control-jog-continuous"
              onClick={() => setPref({ machineJogContinuous: true })}
            >{controlText('JogPanel.text047')}</button>
            <select
              className="mform-select"
              data-testid="control-jog-step-select"
              aria-label={controlText('JogPanel.text048')}
              disabled={jogContinuous}
              style={{ flex: '0 0 auto', width: 52, padding: '3px 2px' }}
              value={String(
                STEP_CHOICES[units].find((s) => {
                  const mm = units === 'inch' ? s * MM_PER_INCH : s
                  return Math.abs(jogStep - mm) < 1e-9
                }) ?? '',
              )}
              onChange={(e) => {
                const s = Number(e.target.value)
                if (!Number.isFinite(s)) return
                setPref({ machineJogStepMm: units === 'inch' ? s * MM_PER_INCH : s })
              }}
            >
              {STEP_CHOICES[units].map((s) => (
                <option key={s} value={String(s)}>{fmtMachineLength(units === 'inch' ? s * MM_PER_INCH : s, units)}</option>
              ))}
            </select>
            <NumCell
              className="mform-input mform-input-sm control-jog-feed control-jog-feed-narrow"
              shown={String(Math.round(feedToDisplay(jogFeed, units)))}
              min={1}
              step={units === 'inch' ? 5 : 100}
              onCommit={(text) => {
                const mm = parseFeedToMmMin(text, units)
                if (!Number.isFinite(mm) || mm <= 0) return false
                if (mm === jogFeed) return false
                setPref({ machineJogFeedMmMin: mm })
              }}
            />
            <span className="control-field-label">{feedLabel(units)}</span>
          </div>
        </div>

      </div>
      )}
    </section>
  )
}

/** WO-2257: the jog pad re-renders for its own state, never for its parent's.
 *  Probing re-renders on every status frame (it reads the position) and used
 *  to take this whole panel with it, 40 times a second while the axis moved -
 *  time the held jog's keep-alive could not afford. */
export const JogPanel = memo(JogPanelView)
