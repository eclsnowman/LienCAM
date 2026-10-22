import { catalogChildren, liveCatalog } from './definition/catalogText'
import { textFor, useText } from '../../i18n'
const controlText = textFor('control-screens-not-probing')

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import {
  CircleCheck,
  CirclePause,
  CirclePlay,
  CircleStop,
  Hourglass,
  Info,
  OctagonX,
  RotateCcw,
  SkipBack,
  SkipForward,
} from 'lucide-react'
import {
  bridgePresence,
  useMachineControl,
  type BridgePresence,
} from '../../store/machineControlStore'
import { useShallow } from 'zustand/react/shallow'
import { controlMachine, controlMachineSelection, useCamStore } from '../../store'
import { machineHasNoHomeSwitches } from '../../types'
import { dialogOpen } from '../../hooks/useControlJogKeys'
import {
  deriveOperatorTransport,
  executeOperatorCycleStart,
  executeOperatorFeedHold,
  executeOperatorStopReset,
  nextActionIsCycleStartRefusal,
} from '../../lib/machine/operatorTransport'
import {
  ESTOP_BLOCKS_MOTION,
  armProgramFromTop,
  clearSurfaceMesh,
  clearWorkRotation,
  connectMachine,
  controllerResetInProgress,
  describeOperatorStop,
  describeWorkRotation,
  estopControlMode,
  estopNeedsReset,
  estopTripNeedsReset,
  operatorStopState,
  nonProgramActionStatus,
  subscribeNonProgramActionStatus,
  guidedToolMeasureState,
  isProbeCycleActive,
  pressEstop,
  programHoldCycleStartDecision,
  programPartsTransportState,
  softLimitLatchActive,
  subscribeControllerReset,
  runFromReview,
  selectControlMachine,
  setMachineSingleBlock,
  SOFT_LIMIT_UNLOCK_TITLE,
  stepBackOneLine,
  stepBackInProgress,
  subscribeEstopControlMode,
  subscribeEstopNeedsReset,
  subscribeOperatorStop,
  subscribeProbeCycleActive,
  subscribeRunFromReview,
  subscribeSoftLimitLatch,
  subscribeStepBackInProgress,
  subscribeWorkRotations,
  workRotations,
  type EstopControlMode,
  type MachineConnectionKind,
} from '../../lib/machine/machineSession'
import { activeMacroRun, subscribeMacroRun } from '../../lib/machine/macros/macroRuntime'
import {
  authorize,
  RE_ARM_RESETTING,
  type OperatorAuthorityFacts,
} from '../../lib/machine/operatorAuthority'
import { useControlPanelCollapsed } from './ControlPanelCollapseToggle'
import { bridgeHostCapability, restartBridge } from '../../lib/machine/bridgeHost'
import { machineBridgePort, useUiPrefs } from '../../store/uiPrefs'
import { useMachineToolTable } from '../../store/machineToolTableStore'
import { controllerSurface } from '../../lib/machine/controllerSurface'
import { DRIVE_FAULT_ALARM_PREFIX } from '../../lib/machine/uccncController'

/*
  WO-469, Operator's ruling 2026-08-22: THE CONTROL HAS TWO MODES, AND THE MODE
  DECIDES - not the state. Armed it is an E-STOP and a click only STOPS;
  stopped it is flashing and it is a CLEAR, and a click only clears, returning
  it to the armed E-STOP. pressEstop() dispatches on estopControlMode() and on
  nothing else - it no longer GUESSES which a click meant, which is what
  deadlocked it (the stop set 'alarm' and the clear's guess demanded 'idle',
  so the first click guaranteed the one state the second would not accept).

  Hiding the E-STOP in the stopped mode is safe by Operator's own argument, and
  that argument is the load-bearing part: once the machine is already stopped
  there is nothing left for an E-STOP to do. A later seat must not "restore" a
  stop control here.

  WHY THIS IS ONE COMPONENT AND NOT A SHAPE COPIED PER PANEL. The audit that
  failed attempt 1 found the reason: ProbeRoutineRunPanel carried a SECOND
  hand-rolled E-STOP, so when pressEstop() gained the clear mode that panel
  silently became a button labelled E-STOP that performed a clear - and its
  onClick discarded the result, so it could not even say so. The architect's
  rule from that finding - "EVERY E-STOP CONTROL FOLLOWS THE TWO-MODE DESIGN.
  Not the transport bar's. Every one. If a third ever appears it inherits this
  rule automatically" - is only true if there is one implementation to
  inherit. So this is it. A new E-STOP anywhere in the app renders THIS and
  gets the modes, the labels, the delay and the refusal sentence for free.
*/

/** What each mode looks like and what it means. The WORD is the mitigation
 *  for the one risk Operator accepted - an operator stabbing the flashing control
 *  meaning to STOP will CLEAR instead - and the order states it as a
 *  constraint: the modes must read as different controls, "a different label,
 *  not merely a different colour". So no two of these share a word.
 *
 *  `state` keeps the WO-328 vocabulary ('armed'/'needs-reset') so every
 *  existing interlock test still pins the same states; `mode` is the new,
 *  finer fact. */
const ESTOP_MODE_UI: Record<EstopControlMode, {
  label: string
  mode: string
  state: 'armed' | 'needs-reset'
  className: string
  tooltip: string
}> = liveCatalog(() => ({
  armed: {
    label: controlText('ControlTransportBar.text001'),
    mode: 'estop',
    state: 'armed',
    // The static red look. It never blinks.
    className: 'control-estop-armed',
    tooltip: controlText('ControlTransportBar.text002'),
  },
  settling: {
    label: controlText('ControlTransportBar.text003'),
    mode: 'settling',
    state: 'needs-reset',
    // Deliberately the needs-reset class WHILE DISABLED: app.css blinks
    // `.control-estop-needs-reset:not(:disabled)`, so a disabled one renders
    // in the flat disabled palette instead. Three unmistakable looks - static
    // red, flat grey, blinking - out of the stylesheet that already exists.
    className: 'control-estop-needs-reset',
    tooltip:
      controlText('ControlTransportBar.text004'),
  },
  stopped: {
    label: controlText('ControlTransportBar.text005'),
    mode: 'clear',
    state: 'needs-reset',
    className: 'control-estop-needs-reset',
    tooltip:
      controlText('ControlTransportBar.text006'),
  },
}))

/** Shown, unprompted, for the whole settling delay. A control that is merely
 *  disabled and says nothing is the WO-474 defect - the operator taps it,
 *  nothing happens, and no sentence explains why. This one explains before
 *  the tap. */
export const ESTOP_SETTLING_NOTE =
  controlText('ControlTransportBar.text007')

export interface EstopControlProps {
  /** Test id for the button. Its sentence line is `${testId}-refusal`. */
  testId: string
  /** Extra classes for the host panel's own layout. */
  className?: string
  /** The HOST's reason to disable (e.g. not connected). The settling delay
   *  disables the control on its own and is never passed in. */
  disabled?: boolean
  /** 'data' uses the app's own `data-tooltip`; 'native' uses `title`, for
   *  panels outside the transport bar's tooltip host. */
  tooltip?: 'data' | 'native'
}

/**
 * THE E-STOP control - all of them. Owns the mode, the labels, the settling
 * delay and the refusal sentence, so no caller can get any of them wrong.
 *
 * Callers pass presentation only. Nothing overridable here can make a stop
 * weaker: the mode comes from the session, the click always goes through
 * pressEstop(), and a refused clear always shows its reason.
 */
export function EstopControl({ testId, className = '', disabled = false, tooltip = 'data' }: EstopControlProps) {
  // Subscribed to the MODE, not just the latch: the mode also turns over when
  // the settling delay elapses, which moves no latch. Without that the
  // control would sit greyed on WAIT long after it was ready.
  const mode = useSyncExternalStore(subscribeEstopControlMode, estopControlMode, () => 'stopped' as const)
  const ui = ESTOP_MODE_UI[mode]

  // A REFUSAL GOES TO THE CONSOLE, NOT BESIDE THE BUTTON.
  //
  // Operator's standing ruling, given three times now - WO-414 ("The partially
  // outside banner steals vertical pixels. Don't do that. Use console for
  // messages."), WO-416 ("Do not ever apply a huge vertical pixel stealing
  // banner across the entire screen"), and again at the machine 2026-08-23
  // when a refused CLEAR printed its sentence here: "should be in the consol.
  // We have taled about this."
  //
  // WO-474 was right that a SILENT refusal is the worst outcome and wrong
  // about where the sentence goes. Both halves survive: the operator is still
  // told exactly why, in the one place this machine already reports every
  // other refusal, which is also the place they are looking when something
  // does not happen.
  //
  // The settling note stays - it is not a message about an event, it is what
  // this control says about its own current mode, shown unprompted before any
  // tap. It has never been what Operator objected to.
  const sentence = mode === 'settling' ? ESTOP_SETTLING_NOTE : null

  return (
    <>
      <button
        type="button"
        className={`control-btn-estop ${ui.className}${className ? ` ${className}` : ''}`}
        data-testid={testId}
        data-estop-state={ui.state}
        data-estop-mode={ui.mode}
        // Disabled ONLY in settling, and settling is reachable only with the
        // machine already stopped. This gates a CLEAR; it never gates a stop.
        // In 'armed' mode the sole thing that can disable this control is the
        // host's own reason (not connected - there is nothing to stop).
        disabled={disabled || mode === 'settling'}
        {...(tooltip === 'native' ? { title: ui.tooltip } : { 'data-tooltip': ui.tooltip })}
        onClick={() => {
          void pressEstop().then((result) => {
            if (!result.ok && result.reason) {
              useMachineControl.getState().pushConsole('tx', result.reason, 'error')
            }
          })
        }}
      >
        {mode === 'armed' ? <OctagonX size={16} /> : mode === 'settling' ? <Hourglass size={16} /> : <CircleCheck size={16} />}
        {' '}{ui.label}
      </button>
      {sentence && (
        <span
          className="control-estop-refusal"
          data-testid={`${testId}-settling-note`}
          role="status"
          title={sentence}
        >
          {sentence}
        </span>
      )}
    </>
  )
}

const STATE_LABEL: Record<string, string> = {
  unknown: 'Not connected',
  idle: 'Idle',
  run: 'Running',
  hold: 'Hold',
  jog: 'Jogging',
  alarm: 'ALARM',
  door: 'Door open',
  check: 'Check mode',
  home: 'Homing',
  sleep: 'Sleep',
}

type BridgePresenceIssue = {
  kind: 'socket-closed' | 'process-stopped'
  headline: string
  detail: string
}

/** Customer wording for the independent socket/process facts. Capability is
 * host-owned: an unhosted browser gets instructions it can perform and never
 * a process control. Controller liveness deliberately does not participate
 * until WO-1130 supplies that separate fact. */
export function bridgePresenceIssue(
  presence: BridgePresence,
  capability: ReturnType<typeof bridgeHostCapability>,
): BridgePresenceIssue | null {
  const canRecover = capability !== 'unhosted'
  if (presence.socket === 'closed') {
    const process = presence.process === 'gave-up'
      ? controlText('ControlTransportBar.text008')
      : presence.process === 'stopped'
        ? controlText('ControlTransportBar.text009')
        : presence.process === 'running'
          ? controlText('ControlTransportBar.text010')
          : ''
    return {
      kind: 'socket-closed',
      headline: controlText('ControlTransportBar.text011'),
      detail: canRecover
        ? controlText('ControlTransportBar.text014', { value1: String(process), value2: String(presence.process === 'stopped' || presence.process === 'gave-up' ? controlText('ControlTransportBar.text012') : controlText('ControlTransportBar.text013')) })
        : controlText('ControlTransportBar.text015'),
    }
  }
  if (canRecover && (presence.process === 'stopped' || presence.process === 'gave-up')) {
    return {
      kind: 'process-stopped',
      headline: presence.process === 'gave-up' ? controlText('ControlTransportBar.text016') : controlText('ControlTransportBar.text017'),
      detail: presence.process === 'gave-up'
        ? controlText('ControlTransportBar.text018')
        : controlText('ControlTransportBar.text019'),
    }
  }
  return null
}

/** The app latch is an operator state, not a controller state. While it is up,
 * it outranks the last status poll so the chip cannot say Idle beside CLEAR. */
export function machineStateChipLabel(input: {
  machineState: string
  alarmMessage?: string | null
  softLimitLatched: boolean
  estopTripped: boolean
  programHeld?: boolean
  programRunning?: boolean
}): string {
  if (input.estopTripped) return controlText('ControlTransportBar.text020')
  if (input.alarmMessage?.startsWith(DRIVE_FAULT_ALARM_PREFIX)) return controlText('ControlTransportBar.text021')
  if (input.softLimitLatched) return controlText('ControlTransportBar.text022')
  if (input.programHeld && input.machineState !== 'alarm' && input.machineState !== 'door') return controlText('ControlTransportBar.programHeld')
  if (input.programRunning && input.machineState === 'idle') return controlText('ControlTransportBar.programRunning')
  return STATE_LABEL[input.machineState] ?? input.machineState
}

/** What the re-arm control says while it is flushing the controller (WO-087).
 *  Lives with the rest of the refusals in the operator authority table (WO-1992). */
export { RE_ARM_RESETTING }

/** WO-328: the plain-language refusal shown at CYCLE START (and Step, and
 *  their tooltips) while the E-STOP needs reset - named so the operator-
 *  facing sentence and the tests asserting it stay one string. */
export const ESTOP_BLOCKS_CYCLE_START = ESTOP_BLOCKS_MOTION

/**
 * WO-990: THE MACHINE SAYS IT HAS NO DATUM BEFORE ANYONE REACHES FOR A JOG KEY.
 *
 * Operator, at the machine 2026-08-24, after jogging Z-1 on an unhomed machine:
 * "WHY IS THIS NOT THE DEFAULT THAT HOME IS FIRST REQUIRED AFTER CONNECTION IF
 * HOME STATE IS NOT KNOWN. It should be CONNECT, CLEAR, HOME, THEN MOVE."
 *
 * THE GATE WAS NOT THE DEFECT. `RequireHomed()` already refuses every move to
 * a coordinate, and a RELATIVE jog stays allowed unhomed on purpose - that is
 * how an axis comes off a limit switch. What he hit was the policy working in
 * silence: the jog was allowed, soft limits stopped it at -0.1, and the FIRST
 * FEEDBACK ARRIVED AFTER THE ATTEMPT. The rule lived in prose all week and
 * never in the software - he got a warning from a document, and the machine
 * said nothing.
 *
 * So this is a STATE CHIP in the row that already carries the state chip. Not
 * a modal, not a banner, not a new full-width row (Operator's standing rule -
 * vertical pixels are scarce), and it is derived from state alone, so it is on
 * screen on a freshly connected session rather than after a refusal.
 *
 * IT DISAPPEARS WHEN THE DATUM EXISTS. A permanent chip is furniture and gets
 * ignored, which is how the rule became invisible in the first place.
 *
 * IT MUST NOT SAY "HOME" TO A MACHINE THAT CANNOT HOME. On a switchless
 * machine (WO-985's mode) there is nothing to home with, and a chip pointing
 * at HOME sends the operator to fix something that was never the problem -
 * the exact defect WO-985 and WO-988 exist to remove.
 */
export type DatumChipMode = 'needs-home' | 'work-coordinates'

export interface DatumChip {
  mode: DatumChipMode
  /** What the chip reads on the strip. The strip never wraps. */
  text: string
  /** The whole sentence, on hover - the same split `control-next-action` uses. */
  title: string
  className: string
}

/** The two sentences, named so the operator's words and the tests are one
 *  string. `workCoordinates` contains no form of the word "home" ANYWHERE,
 *  visible text and tooltip both: that is the acceptance, not a style note.
 *
 *  WO-1005 REWROTE `needsHome`, AFTER A DAMAGED Z ENDSTOP. It used to read
 *  "Press Home All before moving to any coordinate." - a bare imperative, and
 *  the sentence is FALSE-SAFE in exactly one state: the next power cycle after
 *  a successful homing. Homing parks each axis ON its switch, `homed` lives
 *  only in this session's store (it never persists, by design - see
 *  machineControlStore's header), so power off and back on and the app comes
 *  up `homed=false` with the machine still physically sitting on every switch.
 *  In that state the old sentence pointed the operator straight at the action
 *  that drove 1.4mm into Operator's Z stop twice on 2026-08-25.
 *
 *  `src/` CANNOT SEE THE SWITCH - only the bridge can, and reading it is
 *  WO-1004's job. So this is not a new state; it is the PRECONDITION, said
 *  out loud, in the same breath as the suggestion, and the chip says plainly
 *  that the app cannot check it. Never the other way round: a string that
 *  implied a switch was clear would be worse than the one it replaced. */
export const DATUM_CHIP = liveCatalog(() => ({
  needsHome: {
    // "HOME FIRST" is still here because that IS the condition (WO-990). What
    // follows it is a CHECK TO RUN, never a state this app is reporting.
    //
    // It reads "CHECK SWITCHES" and not "SWITCHES CLEAR?" for one reason: the
    // strip never wraps, so a long chip ELLIPSIZES at narrow widths, and
    // "...SWITCHES CLEAR" with the question mark cut off is a claim about the
    // machine. Every prefix of an imperative is still an imperative. Pinned in
    // homeInvitation.wo1005.test.tsx, which caught exactly this.
    text: controlText('ControlTransportBar.text023'),
    title:
      controlText('ControlTransportBar.text024')
      + controlText('ControlTransportBar.text025')
      + controlText('ControlTransportBar.text026')
      + controlText('ControlTransportBar.text027')
      + controlText('ControlTransportBar.text028'),
  },
  workCoordinates: {
    text: controlText('ControlTransportBar.text029'),
    title:
      controlText('ControlTransportBar.text030')
      + controlText('ControlTransportBar.text031'),
  },
} as const))

/**
 * Whether the strip carries the no-datum chip, and which one. Pure, so the
 * contract can be pinned without a render.
 *
 * `noHomeSwitches` is WO-985's MODE, passed in - this component does NOT
 * re-derive "switchless" from `homePin`, because two definitions of one mode
 * drift. It is read from the Control machine with that order's pure predicate.
 */
export function deriveDatumChip(input: {
  connected: boolean
  homed: boolean
  noHomeSwitches: boolean
}): DatumChip | null {
  // Disconnected there is no machine to have a datum, and the state chip
  // already says "Not connected" beside this one.
  if (!input.connected) return null
  // THE NEGATIVE CONTROL. A datum exists; the chip is gone, not greyed.
  if (input.homed) return null
  return input.noHomeSwitches
    ? {
        mode: 'work-coordinates',
        ...DATUM_CHIP.workCoordinates,
        // Amber and non-interactive (`control-chip-static`): a caution about
        // whose responsibility the coordinates are, not an action to take.
        className: 'control-state-chip control-datum-chip control-datum-work-coords control-chip-static',
      }
    : {
        mode: 'needs-home',
        ...DATUM_CHIP.needsHome,
        // `control-home-outline` is WO-931's HOME signature - Operator, 2026-08-24
        // on that rail: "Land it, but with blue outlines." The chip that sends
        // an operator to HOME wears the colour the HOME controls wear, and it
        // costs no new stylesheet rule.
        className: 'control-state-chip control-datum-chip control-datum-needs-home control-home-outline',
      }
}

/**
 * WO-2187 (Operator 2026-09-29, the rotation card's default 4): while any work
 * system carries a rotation, "G54 rotated 0.73 deg" and a Clear sit in this
 * strip - the one row every Control view shows, so every screen that shows the
 * work position shows it. The numbers are the controller's report
 * (machineSession.workRotations); Clear asks the controller for 0, and the
 * chip goes when the controller says so. No rotation renders nothing at all.
 */
function WorkRotationChips() {
  useText('control-screens-not-probing')
  const rotations = useSyncExternalStore(subscribeWorkRotations, workRotations, workRotations)
  const rotated = Object.entries(rotations)
  if (rotated.length === 0) return null
  return (
    <>
      {rotated.map(([wcs, degrees]) => (
        <span key={wcs} className="control-work-rotation" data-testid={`control-wcs-rotation-${wcs}`}>
          <span
            className="control-state-chip control-chip-static"
            role="status"
            title={controlText('ControlTransportBar.text032', { value1: String(describeWorkRotation(wcs, degrees)), value2: String(String(degrees)), value3: String(wcs) })}
          >
            {describeWorkRotation(wcs, degrees)}
          </span>
          <button
            type="button"
            className="control-chip-btn"
            data-testid={`control-wcs-rotation-clear-${wcs}`}
            title={controlText('ControlTransportBar.text033', { value1: String(wcs) })}
            onClick={() => { void clearWorkRotation(wcs) }}
          >{controlText('ControlTransportBar.text034')}</button>
        </span>
      ))}
    </>
  )
}

/**
 * WO-2267 (Operator ruling 2026-09-30: "it should be applied to the work coordinate
 * system and cleared similar to the way rotation is done"): while a Z surface
 * mesh is applied, "G55 mesh 5x5" and a Clear sit beside the rotation chips,
 * in their look. The label opens the mesh viewer, as Main's program-row chip
 * does; Clear is Probing's Disable compensation - same action, same rule
 * (not while a program runs). Nothing applied renders nothing.
 */
function SurfaceMeshChip() {
  useText('control-screens-not-probing')
  const mesh = useMachineControl((s) => (s.surfaceMesh?.active ? s.surfaceMesh : null))
  const running = useMachineControl((s) => s.job.phase === 'streaming' || s.job.phase === 'paused')
  if (!mesh) return null
  const label = controlText('ControlTransportBar.text035', { value1: String(mesh.workOffset), value2: String(mesh.pointsX), value3: String(mesh.pointsY) })
  return (
    <span className="control-work-rotation" data-testid={`control-wcs-mesh-${mesh.workOffset}`}>
      <button
        type="button"
        className="control-state-chip control-chip-static"
        style={{ cursor: 'pointer' }}
        data-testid="control-wcs-mesh-label"
        title={controlText('ControlTransportBar.text036', { value1: String(mesh.workOffset), value2: String(mesh.pointsX), value3: String(mesh.pointsY), value4: String(mesh.workOffset) })}
        onClick={() => useCamStore.getState().openModal('mesh-viewer')}
      >
        {label}
      </button>
      <button
        type="button"
        className="control-chip-btn"
        data-testid={`control-wcs-mesh-clear-${mesh.workOffset}`}
        title={controlText('ControlTransportBar.text037', { value1: String(mesh.workOffset) })}
        disabled={running}
        onClick={clearSurfaceMesh}
      >{controlText('ControlTransportBar.text038')}</button>
    </span>
  )
}

/** WO-414: the re-arm click refusal is shown in the transport cluster
 *  (control-rearm-refusal) and must never share the screen with the
 *  disabled-reason sentence (WO-333: "the two reasons never render at once").
 *  The reason now lives in ControlStepRow's status line, so the refusal is
 *  published here for that row to read - a two-line external store, no
 *  machine-store change. */
let reArmRefusalShown: string | null = null
const reArmRefusalListeners = new Set<() => void>()
function publishReArmRefusal(refusal: string | null) {
  if (reArmRefusalShown === refusal) return
  reArmRefusalShown = refusal
  reArmRefusalListeners.forEach((l) => l())
}
const subscribeReArmRefusal = (listener: () => void) => {
  reArmRefusalListeners.add(listener)
  return () => { reArmRefusalListeners.delete(listener) }
}
const readReArmRefusal = () => reArmRefusalShown

// WO-422: subscribe through the SESSION, not through the controller instance.
// connectMachine can install a different backend (GRBL <-> bridge), and a
// subscription taken on the previous instance would be silently orphaned -
// this bar's re-arming spinner would then never clear.
const subscribeResetInProgress = (listener: () => void) => subscribeControllerReset(listener)
const resetInProgress = () => controllerResetInProgress()

export type ControlView = 'main' | 'offsets' | 'tools' | 'probing' | 'routines' | 'machine'

const CONTROL_VIEWS: Array<[ControlView, string]> = liveCatalog(() => ([
  ['main', controlText('ControlTransportBar.text039')],
  ['offsets', controlText('ControlTransportBar.text040')],
  ['tools', controlText('ControlTransportBar.text041')],
  // WO-297: probing left ToolsProbePanel for its own bespoke view - Operator
  // rejected sharing the screen with the tool table
  // (docs/ui-ux/probing-workspace-requirements.md).
  ['probing', controlText('ControlTransportBar.text042')],
  // WO-411 (Operator ruling 2026-08-21: "Perhaps custom probe needs its own tab? Probe
  // tab is getting pretty busy."): the routine library / editor / preview is
  // its own view, not a station buried under the Probing operator station.
  ['routines', controlText('ControlTransportBar.text043')],
  // WO-917 (Operator 2026-08-23, card Q-WHICH-TABS-MOVE-UNDER-MACHINE): "machine
  // actions would become just machine and then underneath that there would be
  // sub tabs for the tabs that moved there." Diagnostics and Macros LEFT this
  // row for those sub-tabs - they were not deleted, they moved (ControlPage's
  // machine view renders both at full size). `Machine` is a real view now, not
  // the modal-opener the `Machine actions` button used to be; the modal it
  // opened is one of its sub-tabs. Offsets, Tools, Probing and Routines stay
  // here unchanged - Operator ruled Offsets keeps its own tab because the Main
  // column's copy is a quick action and the tab is the before-the-job setup
  // workspace that has to grow past 2.5D.
  ['machine', controlText('ControlTransportBar.text044')],
]))

/** Fixed operator authority. This is the only Control surface allowed to
 * start, resume, or single-block program/trace motion.
 *
 * WO-048 (the approved uix=12 layout): the transport cluster is a
 * center-column grid item directly under the shortened program list, and the
 * top strip carries only the subview nav + machine state. ControlPage mounts
 * this component twice with explicit `sections`; the 'row' default keeps the
 * whole strip in one mount for focused panel tests that render the transport
 * alone. */
export function ControlTransportBar({
  activeView = 'main',
  onSelectView,
  sections = 'row',
  selectedConnectionKind = null,
}: {
  activeView?: ControlView
  /** Wiring this is what puts the subview nav in this strip. Focused panel
   *  tests mount the transport alone and pass nothing.
   *
   *  WO-917: `onOpenActions` is gone from this component. The nav row used to
   *  carry ONE child that was not a view - a `Machine actions` button that
   *  opened a modal - so the row was six tabs plus a door. Now every child of
   *  this row selects a view, and the machine-actions modal is reached from
   *  the Machine view's Actions sub-tab. ControlPage still owns that modal. */
  onSelectView?: (view: ControlView) => void
  /** 'row' is the single-strip mount (focused tests); 'transport' renders
   *  ONLY the transport cluster (the center-column grid item); 'nav' renders
   *  ONLY the subview tabs + state chip + next-action banner strip. */
  sections?: 'row' | 'transport' | 'nav'
  /** The disconnected connection choice lives in ControlPage. Once connected,
   * the session store takes over; either way the header labels simulation. */
  selectedConnectionKind?: MachineConnectionKind | null
} = {}) {
  useText('control-screens-not-probing')
  const connectionPhase = useMachineControl((s) => s.connectionPhase)
  const connectionKind = useMachineControl((s) => s.connectionKind)
  const connectionDetail = useMachineControl((s) => s.connectionDetail)
  const machineState = useMachineControl((s) => s.machineState)
  const alarm = useMachineControl((s) => s.alarm)
  const softLimitLatched = useSyncExternalStore(
    subscribeSoftLimitLatch,
    softLimitLatchActive,
    () => false,
  )
  useSyncExternalStore(subscribeNonProgramActionStatus, nonProgramActionStatus, () => null)
  const job = useMachineControl((s) => s.job)
  const operatorStop = useSyncExternalStore(subscribeOperatorStop, operatorStopState, () => null)
  const programReadiness = useMachineControl((s) => s.programReadiness)
  const programFit = useMachineControl((s) => s.programFit)
  const singleBlock = useMachineControl((s) => s.singleBlock)
  const fitTrace = useMachineControl((s) => s.fitTrace)
  const toolChange = useMachineControl((s) => s.toolChange)
  // WO-2031: a boundary macro starting, waiting at hold() or ending changes
  // the session's hold decision below; this re-renders on each.
  useSyncExternalStore(subscribeMacroRun, activeMacroRun, () => null)
  const programText = useMachineControl((s) => s.programText)
  const bridgeControllerPresence = useMachineControl((s) => s.bridgeControllerPresence)
  const bridgeProcessPresence = useMachineControl((s) => s.bridgeProcessPresence)
  // WO-990: the two facts the no-datum chip is made of, both SUBSCRIBED.
  // `homed` is the state; `noHomeSwitches` is WO-985's mode, asked of
  // the Control machine with that order's PURE predicate rather than the
  // store-reading accessor in machineSession - a component that called the
  // accessor during render would subscribe to nothing and keep the wrong
  // chip on screen after the machine changed (that accessor's own note
  // says so, and JogPanel subscribes the same way).
  const homed = useMachineControl((s) => s.homed)
  const activeWcs = useMachineControl((s) => s.activeWcs)
  // WO-1065: ONE view, derived from the one resolver. This row may not read
  // `control.activeMachineId`, `control.sessionMachine` or CAM's own project
  // record to decide what it says - a session pinned to A used to be announced here
  // as B, because the `<select>` read the raw id while every reader resolved
  // the pin. `useShallow` because the view is a fresh object per call and its
  // fields are the stable records already in the store.
  const selection = useCamStore(useShallow(controlMachineSelection))
  const bridgeLaunchSettings = useUiPrefs((s) => s.machineLinks[selection.machine.id])
  const machineLibrary = useCamStore((s) => s.machineLibrary)
  const noHomeSwitches = useCamStore((s) => machineHasNoHomeSwitches(controlMachine(s)))
  // WO-2772: a loaded file's fit is read again against the tool table's
  // lengths (Tools tab), so CYCLE START re-renders when a length changes.
  useMachineToolTable((s) => s.byMachine)
  // WO-2833: and against the work offsets (and their rotations) - a file
  // refused for travel and fixed by G10 must enable the RENDERED button with
  // the keyboard start's verdict, not keep the stale refusal greyed.
  useMachineControl((s) => s.offsets)
  useSyncExternalStore(subscribeWorkRotations, workRotations, workRotations)
  const state = deriveOperatorTransport({
    connectionPhase,
    machineState,
    homed,
    activeWcs,
    noHomeSwitches,
    job,
    programReadiness,
    programFit,
    singleBlock,
    fitTrace,
    toolChange,
    programText,
    programParts: programPartsTransportState(),
    guidedMeasure: guidedToolMeasureState(),
    programHold: programHoldCycleStartDecision(),
  })
  // WO-087: re-arming now resets the controller when the last run could still
  // have motion queued inside it, so it takes real time and it can REFUSE.
  // Both facts have to be visible right at the control - a button that sits
  // silent for a second and may quietly have done nothing is the same class of
  // lie this WO exists to remove.
  const reArming = useSyncExternalStore(subscribeResetInProgress, resetInProgress, () => false)
  const steppingBack = useSyncExternalStore(subscribeStepBackInProgress, stepBackInProgress, () => false)
  // WO-2138: Feed Hold is live for a probe routine's whole run, gaps included.
  const probeRoutineRunning = useSyncExternalStore(subscribeProbeCycleActive, isProbeCycleActive, () => false)
  // WO-328: the E-STOP needs-reset latch. Defaults true even before this
  // subscription mounts (getSnapshot and the SSR fallback agree) - a render
  // must never show the machine READY before the interlock says so.
  const estopTripped = useSyncExternalStore(subscribeEstopNeedsReset, estopNeedsReset, () => true)
  const estopActuallyTripped = useSyncExternalStore(subscribeEstopNeedsReset, estopTripNeedsReset, () => false)
  const [reArmRefusal, setReArmRefusal] = useState<string | null>(null)
  useEffect(() => {
    publishReArmRefusal(reArmRefusal)
    return () => publishReArmRefusal(null)
  }, [reArmRefusal])
  const connected = connectionPhase === 'connected'
  const headerConnectionKind = connectionKind ?? selectedConnectionKind
  // WHICH ROW IS CHECKED, decided once from the view: the empty value is
  // Follow CAM, any other value is the resolved machine's own id. The word
  // `simulated` is decided once from the connection kind and lands on that one
  // row - never on a row that merely shares an id with something raw.
  const selectedValue = selection.mode === 'follow-cam' ? '' : selection.machine.id
  const simulatedSuffix = headerConnectionKind === 'simulator' ? ' - simulated' : ''
  /** What Follow CAM resolves to RIGHT NOW: the pinned record while a session
   *  holds it, CAM's record otherwise. Both come from the view. */
  const followName = selection.mode === 'follow-cam'
    ? selection.machine.name
    : selection.camMachine.name
  /** The one sentence about a pinned session, written once and used by the
   *  option text and the hover alike. */
  const pinnedNote = selection.camMovedTo
    ? controlText('ControlTransportBar.text045', { value1: String(selection.camMovedTo.name) })
    : null
  const datumChip = deriveDatumChip({ connected, homed, noHomeSwitches })
  const hasBridgeSurface = controllerSurface(selection.machine).bridgeSettings
    && headerConnectionKind === 'bridge'
  const presence = bridgePresence({
    connectionPhase,
    connectionKind,
    bridgeControllerPresence,
    bridgeProcessPresence,
  })
  const bridgeCapability = bridgeHostCapability()
  // A bridge-capable machine selected on a fresh screen is not an outage.
  // Surface the stronger bridge wording only after the socket has reported a
  // failure or the hosted process monitor has supplied a concrete state.
  const bridgeIncidentObserved = connectionDetail !== null
    || bridgeProcessPresence !== 'unknown'
  const presenceIssue = hasBridgeSurface && bridgeIncidentObserved && machineState !== 'alarm'
    ? bridgePresenceIssue(presence, bridgeCapability)
    : null
  const showTransport = sections !== 'nav'
  const showNav = sections !== 'transport'
  const [bridgeRecovering, setBridgeRecovering] = useState(false)
  const presenceAnnounced = useRef<BridgePresenceIssue['kind'] | null>(null)
  // WO-1553: only a bridge that was CONNECTED, then lost, then restored earns
  // the recovery line. A fresh session starts with a closed socket that is not
  // a loss - the connecting->connected edge looks identical to a loss->restore
  // if the prior issue is only remembered as "non-null", which is why the
  // console claimed "Bridge recovery complete" on a first connect at the board
  // (2026-09-14). So the edge that announces an issue also records whether the
  // bridge had already been connected this session; a first connect's
  // pre-connect issue is ineligible for a recovery.
  const bridgeConnectedThisSession = useRef(false)
  const announcedIssueWasAfterConnect = useRef(false)
  useEffect(() => {
    if (!showNav) return
    if (!hasBridgeSurface) {
      presenceAnnounced.current = null
      bridgeConnectedThisSession.current = false
      announcedIssueWasAfterConnect.current = false
      return
    }
    // Alarm owns the headline. Keep the bridge edge pending until the alarm
    // clears rather than announcing a recovery the machine cannot confirm.
    if (machineState === 'alarm') return
    // `presence.socket` is in the deps precisely so this runs on an
    // open/closed edge even when no issue was ever announced - otherwise a
    // silent connect would leave the ref false and a later real loss could
    // never be recovered.
    if (presence.socket === 'open') bridgeConnectedThisSession.current = true
    const next = presenceIssue?.kind ?? null
    if (next === presenceAnnounced.current) return
    const previous = presenceAnnounced.current
    presenceAnnounced.current = next
    if (presenceIssue) {
      announcedIssueWasAfterConnect.current = bridgeConnectedThisSession.current
      useMachineControl.getState().pushConsole('rx', presenceIssue.detail, 'info')
    } else if (previous !== null && announcedIssueWasAfterConnect.current) {
      announcedIssueWasAfterConnect.current = false
      useMachineControl.getState().pushConsole(
        'rx',
        controlText('ControlTransportBar.text046'),
        'info',
      )
    }
  }, [hasBridgeSurface, machineState, presenceIssue, presence.socket, showNav])

  const recoverBridge = async () => {
    if (bridgeRecovering || bridgeCapability === 'unhosted') return
    setBridgeRecovering(true)
    try {
      let port: number
      try {
        port = machineBridgePort(selection.machine.id)
      } catch {
        useMachineControl.getState().pushConsole(
          'tx',
          controlText('ControlTransportBar.text047'),
          'error',
        )
        return
      }
      // WO-2845: Reconnect is an operator press - after the changed-DLL line it is the second Connect.
      const result = await restartBridge(port, bridgeLaunchSettings, { operatorPress: true })
      if (!result.ok) {
        if (result.reason === 'exited') {
          // WO-1306: a fast child exit is reported with the bridge's own last
          // line, never a paraphrase. electron/main.cjs captures that line in
          // lastExit.error; the fallback names the absence rather than guessing.
          const lastLine = result.lastExit?.error?.trim()
          useMachineControl.getState().pushConsole(
            'tx',
            lastLine
              ? controlText('ControlTransportBar.text048', { value1: String(lastLine) })
              : controlText('ControlTransportBar.text049'),
            'error',
          )
          return
        }
        const reason = result.reason === 'no-socket'
          ? controlText('ControlTransportBar.text050', { value1: String(result.port) })
          : result.reason === 'not-configured'
            ? controlText('ControlTransportBar.text051')
            : controlText('ControlTransportBar.text052')
        useMachineControl.getState().pushConsole('tx', controlText('ControlTransportBar.text053', { value1: String(reason) }), 'error')
        return
      }
      const state = useMachineControl.getState()
      state.setBridgeProcessPresence('running')
      window.dispatchEvent(new Event('liencam:bridge-lifecycle'))
      // A process restart is only half of Reconnect. If the socket is already
      // live (an unusual but supported presence combination), preserve it;
      // otherwise complete the same bridge connection the Connect control uses.
      if (useMachineControl.getState().connectionPhase !== 'connected') {
        await connectMachine('bridge')
      }
      if (useMachineControl.getState().connectionPhase !== 'connected') {
        throw new Error(controlText('ControlTransportBar.text054'))
      }
      useMachineControl.getState().pushConsole(
        'tx',
        controlText('ControlTransportBar.text055'),
        'info',
      )
    } catch (error) {
      useMachineControl.getState().pushConsole(
        'tx',
        controlText('ControlTransportBar.text056', { value1: String(error instanceof Error ? error.message : String(error)) }),
        'error',
      )
    } finally {
      setBridgeRecovering(false)
    }
  }
  // WO-1992: every transport control's gate is a row of the operator authority table.
  const authorityFacts: OperatorAuthorityFacts = {
    connected,
    machineState,
    jobPhase: job.phase,
    estopLatched: estopTripped,
    steppingBack,
    reArming,
    cycleStartEnabled: state.cycleStartEnabled,
    reArmEnabled: state.reArm.enabled,
    probeRoutineRunning,
  }
  const cycleStartGate = authorize('cycleStart', authorityFacts)
  const feedHoldGate = authorize('feedHold', authorityFacts)
  const reArmGate = authorize('reArm', authorityFacts)

  const jogCollapsed = useControlPanelCollapsed('jog')
  // JogPanel owns the existing Unlock button but is outside this work order's
  // owned paths. The always-mounted nav instance supplies the bridge-latch
  // hover context to that existing element, preserving its prior attributes
  // when the latch clears. Subscribing to Jog's existing collapsed state makes
  // this effect run after expanding mounts a new Unlock button while latched.
  // No control is added and no click path changes.
  useEffect(() => {
    if (!showNav || !softLimitLatched) return
    const unlock = document.querySelector<HTMLElement>('[data-testid="control-unlock"]')
    if (!unlock) return
    const previousTitle = unlock.getAttribute('title')
    const previousTooltip = unlock.getAttribute('data-tooltip')
    unlock.setAttribute('title', SOFT_LIMIT_UNLOCK_TITLE)
    unlock.setAttribute('data-tooltip', SOFT_LIMIT_UNLOCK_TITLE)
    return () => {
      if (unlock.getAttribute('title') === SOFT_LIMIT_UNLOCK_TITLE) {
        if (previousTitle === null) unlock.removeAttribute('title')
        else unlock.setAttribute('title', previousTitle)
      }
      if (unlock.getAttribute('data-tooltip') === SOFT_LIMIT_UNLOCK_TITLE) {
        if (previousTooltip === null) unlock.removeAttribute('data-tooltip')
        else unlock.setAttribute('data-tooltip', previousTooltip)
      }
    }
  }, [jogCollapsed, showNav, softLimitLatched])
  // WO-1086: Main is the only workspace that shows program-start and
  // program-stepping authority. Off Main the operator can still react to
  // motion through the same E-STOP, Feed Hold and Stop/Reset executors, but
  // cannot start, re-arm or single-block a program they cannot see.
  // The Probing panel's embedded transport is not the off-Main header row:
  // it already owns a task-specific Restart probe control and deliberately
  // omits program Stop/Reset. Preserve that pre-existing WO-327 contract.
  const probeOnly = activeView === 'probing' && sections === 'transport'
  const compactTransport = activeView !== 'main' && !probeOnly
  // WO-328: the needs-reset E-STOP outranks every other next-action sentence
  // once connected - "before continuing to anything else" - so it overrides
  // rather than competes with the alarm/door/etc. messages
  // deriveOperatorTransport already owns. Disconnected keeps its own (more
  // fundamental) message.
  // WO-1663: after the operator's own Stop the line says where they stopped
  // it - never "the cycle failed" - until CYCLE START starts it again. Only
  // while the machine is at Idle and the same program is loaded: an alarm, a
  // door, a new file or a run all keep their own sentence.
  const stoppedLine =
    operatorStop !== null
    && connected
    && machineState === 'idle'
    && operatorStop.name === job.name
    && (job.phase === 'empty' || (job.phase === 'ready' && state.action === 'start'))
      ? describeOperatorStop(operatorStop)
      : null
  // WO-2885: CYCLE START's own refusal (a Load refused for the travel, an
  // off-table program, a program not ready) is not repeated here - greyed
  // CYCLE START carries it on hover and the console holds it. The operator, 10-16:
  // "Redundancy of what's in the terminal and at the top of the screen".
  const nextAction = connected && estopTripped
    ? ESTOP_BLOCKS_CYCLE_START
    : stoppedLine ?? (nextActionIsCycleStartRefusal(state) ? '' : state.nextAction)

  // S remains the physical-controller-style shortcut for the canonical
  // button in Single Block mode. It calls the same verdict and executor.
  // Registered only by the instance that owns the transport buttons, so the
  // split mount never double-fires a cycle start.
  // WO-327: the probing view has no Single Block control at all - not even a
  // leftover global flag from another view gets to make this accelerator
  // live there.
  useEffect(() => {
    if (!showTransport || compactTransport || probeOnly) return
    const onKey = (event: KeyboardEvent) => {
      if (steppingBack || !singleBlock || (event.key !== 's' && event.key !== 'S')) return
      if (event.ctrlKey || event.metaKey || event.altKey) return
      const target = event.target as HTMLElement | null
      if (
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.tagName === 'SELECT' ||
        target?.isContentEditable
      ) return
      // WO-1502: ControlPage stays mounted-but-hidden (display: none) once
      // shown once, so this listener stays alive off Control. Read the
      // workspace fresh at event time, the same way estopNeedsReset() and
      // deriveOperatorTransport are read fresh below - a render-time closure
      // would go stale without this effect re-running.
      if (useCamStore.getState().workspace !== 'control') return
      // WO-1706: a key pressed inside an open dialog belongs to the dialog.
      if (dialogOpen()) return
      // WO-328: read the latch fresh, not the render-time hook value - this
      // effect does not re-run when only the latch changes, so a captured
      // boolean would go stale the moment the button's own disabled state
      // updates.
      if (estopNeedsReset()) return
      const fresh = deriveOperatorTransport({
        ...useMachineControl.getState(),
        noHomeSwitches,
        programParts: programPartsTransportState(),
        guidedMeasure: guidedToolMeasureState(),
        programHold: programHoldCycleStartDecision(),
      })
      // WO-2686: a loaded program that is not armed is armed from line 1 and
      // its first block executed - the same CYCLE START, one block at a time.
      if (!fresh.cycleStartEnabled || (fresh.action !== 'single-block' && fresh.action !== 'arm-start')) return
      event.preventDefault()
      void executeOperatorCycleStart()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [singleBlock, showTransport, steppingBack, compactTransport, probeOnly, noHomeSwitches])

  return (
    // WO-072: the three role class-sets stay INLINE literals rather than a
    // hoisted `rootClass` identifier. The overlay census's className evaluator
    // resolves literals through conditionals but refuses identifiers
    // (overlayRenderTree.evalClassExpression), so hoisting turned this root
    // into an INDETERMINATE floating-surface entry - a scanner blind spot the
    // regrid created for free, and the +1 that took the app-wide census from
    // 176 to 177. Inline, all three sets resolve, none is positioned in
    // app.css, and the census sees what it should: not a floating surface.
    <div
      className={
        sections === 'transport'
          ? compactTransport
            ? 'control-uix-transport control-transport-compact'
            : 'control-uix-transport'
          : sections === 'nav'
            ? 'control-safety-bar control-operator-bar control-uix-subnav'
            : compactTransport
              ? 'control-safety-bar control-operator-bar control-transport-compact'
              : 'control-safety-bar control-operator-bar'
      }
      data-testid={sections === 'nav' ? 'control-subnav-bar' : 'control-safety-bar'}
    >
      {showTransport && (
        <>
          {/* WO-469: the one E-STOP implementation, defined at the top of
              this file. Every E-STOP in the app renders THIS - see the note
              there for why a copied shape is what failed the last audit. */}
          <EstopControl testId="control-estop" disabled={authorize('estop', authorityFacts).disabled} />
          {!compactTransport && !probeOnly && <button
            className="control-btn-start control-cycle-start"
            data-testid="control-cyclestart"
            disabled={cycleStartGate.disabled}
            aria-describedby={nextAction ? 'control-next-action' : undefined}
            data-tooltip={cycleStartGate.refusal ?? state.cycleStartDetail}
            onClick={() => void executeOperatorCycleStart()}
          >
            <CirclePlay size={14} />{controlText('ControlTransportBar.text057')}</button>}
          <button
            className="control-btn-hold control-safety-btn"
            data-testid="control-feedhold"
            disabled={feedHoldGate.disabled}
            data-tooltip={feedHoldGate.refusal ?? controlText('ControlTransportBar.text058')}
            onClick={executeOperatorFeedHold}
          >
            <CirclePause size={14} />{controlText('ControlTransportBar.text059')}</button>
          {!probeOnly && <button
            className="control-btn-stop control-safety-btn"
            data-testid="control-stop-reset"
            disabled={authorize('stopReset', authorityFacts).disabled}
            // WO-333: Operator could not tell what "Reset" meant here ("how is
            // anything it does a reset?") - the tooltip now says the actual
            // action (abandon motion, clear the queue, known state) and
            // explicitly disowns the E-STOP's own reset, since both controls
            // use the word "reset" for two different things. The visible
            // label stays "Stop/Reset": operatorTransport.ts's next-action
            // banners and RE_ARM_REFUSAL.running (out of this WO's owned
            // paths) already refer to this control by that exact name, so
            // renaming the label here would desync the button from the
            // sentence that tells the operator to press it.
            data-tooltip={controlText('ControlTransportBar.text060')}
            onClick={executeOperatorStopReset}
          >
            <CircleStop size={14} />{controlText('ControlTransportBar.text061')}</button>}
          {/* WO-082: the way back to the top of the program. It sits with the
              transport because that is where the operator already is when a
              cycle ends, and because the next-action sentence names it by this
              exact label. It ARMS ONLY - CYCLE START still owns motion, so
              this is a quiet momentary, never the green start treatment.
              WO-333: wrapped with its always-visible disabled-reason line so
              the two stay one grid/flex item - see .control-rearm-group and
              .control-uix-transport's "rearm" grid row in app.css. */}
          {!compactTransport && !probeOnly && state.reArm.offered && (
            <div className="control-rearm-group" data-testid="control-rearm-group">
              <button
                className="control-btn-rearm control-safety-btn"
                data-testid="control-rearm"
                disabled={reArmGate.disabled}
                data-tooltip={reArmGate.refusal ?? state.reArm.detail}
                onClick={() => {
                  setReArmRefusal(null)
                  void armProgramFromTop()
                    .then((result) => setReArmRefusal(result.ok ? null : result.reason))
                }}
              >
                <RotateCcw size={14} /> {reArming ? RE_ARM_RESETTING : state.reArm.label}
              </button>
              {/* WO-333 put the disabled reason IN PLACE under this button;
                  WO-414 batch 1 (Operator: "What here is required? ... less busy")
                  moved that sentence into the ONE compact status line under
                  the STEP row (ControlStepRow, testid control-rearm-reason is
                  still there). WO-2276 keeps this reason in place only. The
                  tooltip on this button keeps the full sentence. */}
              {reArmRefusal && (
                <span
                  className="control-rearm-refusal"
                  data-testid="control-rearm-refusal"
                  role="status"
                  title={reArmRefusal}
                >
                  {reArmRefusal}
                </span>
              )}
            </div>
          )}
          {/* WO-048: in the split mounts Single Block lives in the STEP row
              (ControlStepRow) under this cluster. The one-strip 'row' mount
              keeps it here so the focused operator-contract tests exercise
              the mode against the same buttons. */}
          {sections === 'row' && !compactTransport && (
            <button
              className={`control-chip-btn control-single-block-mode ${singleBlock ? 'control-chip-active' : ''}`}
              data-testid="control-singleblock-toggle"
              aria-pressed={singleBlock}
              disabled={authorize('singleBlockInline', authorityFacts).disabled}
              onClick={() => setMachineSingleBlock(!singleBlock)}
              data-tooltip={singleBlock ? SINGLE_BLOCK_STATUS.on : SINGLE_BLOCK_STATUS.off}
            >
              {controlText('ControlTransportBar.text064')}
            </button>
          )}
        </>
      )}
      {showNav && onSelectView && (
        <>
          <span className="control-strip-sep" aria-hidden="true" />
          <nav className="control-strip-nav" aria-label={controlText('ControlTransportBar.text065')}>
            {CONTROL_VIEWS.map(([view, label]) => (
              <button
                key={view}
                className={`control-view-tab ${activeView === view ? 'control-view-tab-active' : ''}`}
                data-testid={`control-view-${view}`}
                aria-pressed={activeView === view}
                onClick={() => onSelectView(view)}
              >
                {label}
              </button>
            ))}
          </nav>
        </>
      )}
      {showNav && (
        <>
          <span className="control-strip-sep" aria-hidden="true" />
          <select
            className="control-view-tab"
            data-testid="control-machine-select"
            aria-label={controlText('ControlTransportBar.text066')}
            data-tooltip={pinnedNote
              ? controlText('ControlTransportBar.text067', { value1: String(pinnedNote) })
              : controlText('ControlTransportBar.text068')}
            // THE ROW'S HEIGHT IS THE RULE (Operator, WO-1070 and this order's
            // acceptance): a native select is as wide as its widest option, so
            // the pinned sentence took this control from 432px to 778px and
            // wrapped the operator's own row from 46px to 64px. Capped at the
            // width the machine list already needed, the row cannot move; the
            // whole sentence is still on the hover, in the open list, and in
            // the console. Inline because the one stylesheet is out of this
            // order's grant.
            style={{ maxWidth: '27rem', textOverflow: 'ellipsis' }}
            value={selectedValue}
            onChange={(event) => {
              const nextId = event.target.value || null
              const next = nextId === null
                ? selection.camMachine
                : machineLibrary.find((candidate) => candidate.id === nextId)
              if (!next) return
              // The session owns this transition. Its disconnect boundary
              // cancels old work and invalidates stale callbacks before the
              // newest requested selection is allowed to publish.
              void selectControlMachine(nextId)
            }}
          >
            <option value="">{catalogChildren(controlText('ControlTransportBar.text069', { value1: '\u0000value1\u0000', value2: '\u0000value2\u0000', value3: '\u0000value3\u0000' }), { value1: followName, value2: pinnedNote ? ` - ${pinnedNote}` : '', value3: selectedValue === '' ? simulatedSuffix : '' })}</option>
            {machineLibrary.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name}
                {candidate.id === selection.camMachine.id
                  ? controlText('ControlTransportBar.text070')
                  : ''}
                {candidate.id === selectedValue ? simulatedSuffix : ''}
              </option>
            ))}
          </select>
        </>
      )}
      {showNav && (
        <>
          <span className="control-strip-sep" aria-hidden="true" />
          <span
            className={`control-state-chip control-state-${presenceIssue || (connected && estopActuallyTripped) ? 'alarm' : programPartsTransportState()?.held === true && machineState !== 'alarm' && machineState !== 'door' ? 'hold' : job.phase === 'streaming' && machineState === 'idle' ? 'run' : machineState}`}
            data-testid="control-state-chip"
            title={presenceIssue?.detail}
          >
            {presenceIssue?.headline ?? machineStateChipLabel({
              machineState,
              alarmMessage: alarm?.message,
              softLimitLatched,
              estopTripped: connected && estopActuallyTripped,
              programHeld: programPartsTransportState()?.held === true,
              programRunning: job.phase === 'streaming',
            })}
          </span>
          {presenceIssue && bridgeCapability !== 'unhosted' && (
            <button
              type="button"
              className="control-chip-btn control-home-outline"
              data-testid="control-bridge-reconnect"
              disabled={bridgeRecovering}
              title={controlText('ControlTransportBar.text071', { value1: String(presenceIssue.detail) })}
              onClick={() => { void recoverBridge() }}
            >
              <RotateCcw size={13} aria-hidden="true" />
              {bridgeRecovering ? 'Reconnecting...' : controlText('ControlTransportBar.text072')}
            </button>
          )}
          {/* WO-990: the machine says it has no datum BEFORE anyone reaches
              for a jog key - see deriveDatumChip for why this is a chip in
              this row and not a banner, and why it vanishes once a datum
              exists. It sits beside the state chip because that is where the
              operator already reads what the machine is. */}
          {datumChip && (
            <span
              className={datumChip.className}
              data-testid="control-datum-chip"
              data-datum-mode={datumChip.mode}
              role="status"
              title={datumChip.title}
            >
              {datumChip.text}
            </span>
          )}
          <WorkRotationChips />
          <SurfaceMeshChip />
          {nextAction && <span
            className="control-next-action"
            id="control-next-action"
            data-testid="control-next-action"
            role="status"
            aria-live="polite"
            // WO-048: this line is a BANNER (contextual guidance, clearly
            // non-interactive), INLINE per Operator's round-3 verdict - never a
            // full-width row. data-state lets the CSS tint it amber on hold.
            data-state={machineState}
            // WO-2264: this stop sentence must show what CYCLE START does
            // without hovering. Only its text wraps in the existing space;
            // the other guidance keeps its compact layout and hover title.
            data-operator-stop={stoppedLine !== null && nextAction === stoppedLine ? true : undefined}
            title={nextAction}
          >
            <Info size={13} className="control-banner-icon" aria-hidden="true" />
            {/* WO-2885: its own box, so a sentence longer than the row ends in
                an ellipsis instead of being cut mid-word with no sign. */}
            <span className="control-next-action-text">{nextAction}</span>
          </span>}
        </>
      )}
    </div>
  )
}

/** WO-414: the single-block sentences, named so the line and the tests agree.
 *  WO-2673 (operator 10-07: "I'm always a fan of shortening words if they aren't
 *  needed"): short enough to read in full on one line at the operator's 264.5px Control
 *  panel (the line has 247px at 12px DM Sans; these measure 226 / 232px). The
 *  Single Block toggle's tooltip shows the same words. */
export const SINGLE_BLOCK_STATUS = liveCatalog(() => ({
  on: controlText('ControlTransportBar.text073'),
  off: controlText('ControlTransportBar.text074'),
} as const))

export interface TransportStatusLine {
  kind: 'step-back' | 'rearm' | 'single-block'
  testId: 'control-step-back-status' | 'control-rearm-reason' | 'control-singleblock-mode'
  text: string
  title?: string
}

/** WO-414: pick the ONE sentence the compact status line under the STEP row
 *  shows. Priority: a Step Back result (transient, most specific) > why Re-arm
 *  is disabled (WO-333's in-place reason) > the Single Block mode. Pure, so
 *  tests can pin it without a render. */
export function deriveTransportStatusLine(input: {
  singleBlock: boolean
  reArm: { offered: boolean; enabled: boolean; detail: string }
  reArming: boolean
  stepBack: { plan: { startLine: number; warnings: string[] } | null; error: string | null } | null
}): TransportStatusLine {
  const { singleBlock, reArm, reArming, stepBack } = input
  if (stepBack && (stepBack.plan || stepBack.error)) {
    return {
      kind: 'step-back',
      testId: 'control-step-back-status',
      text: stepBackSentence(stepBack),
      title: stepBack.error ?? stepBack.plan?.warnings.join(' ') ?? '',
    }
  }
  if (reArm.offered && !reArm.enabled && !reArming) {
    return { kind: 'rearm', testId: 'control-rearm-reason', text: reArm.detail }
  }
  return {
    kind: 'single-block',
    testId: 'control-singleblock-mode',
    text: singleBlock ? SINGLE_BLOCK_STATUS.on : SINGLE_BLOCK_STATUS.off,
  }
}

/** The one sentence a Step Back result produces - armed line N, or the
 *  refusal. WO-414 batch 3 (R24, Operator ruling 2026-08-21: "just the console, I only
 *  need the buttons, not the text."): this sentence is written to the console
 *  ONLY; the STEP row shows no text for it. */
export function stepBackSentence(stepBack: {
  plan: { startLine: number; warnings: string[] } | null
  error: string | null
}): string {
  return stepBack.error
    ? controlText('ControlTransportBar.text075', { value1: String(stepBack.error) })
    : controlText('ControlTransportBar.text076', { value1: String(stepBack.plan!.startLine) })
}

/** Last observed Single Block mode (module-level so the two mounts of
 *  ControlStepRow never write the same mode change twice). */
let lastConsoleSingleBlock: boolean | null = null
/** Last Step Back review revision written to the console (same reason). */
let lastStepBackRevision = 0

/** Test hook: forget the last console sentence between cases. */
export function resetTransportStatusConsole(): void {
  lastConsoleSingleBlock = null
  lastStepBackRevision = 0
}

/**
 * WO-048: the STEP row - a center-column grid item directly under the
 * transport cluster. Single Block is the LATCHING toggle in the shipped
 * selection-chip language (quiet at rest, blue selection + underline when
 * ON); Back / Step are MOMENTARY buttons.
 *
 * Step routes through the canonical operator cycle-start verdict, which
 * executes exactly one block while Single Block is ON - so it is enabled
 * only in that mode (with the mode off it would MEAN "run continuously",
 * which is CYCLE START's job, not Step's). Step BACK needs the reverse
 * run-from-line plan WO-051 lands; until then it renders disabled with an
 * honest tooltip - no dead click handlers.
 *
 * Operator NOTE 3 (WO-048): the single-block explainer lives HERE, directly
 * under its control, not in the program progress row.
 */
export function ControlStepRow() {
  useText('control-screens-not-probing')
  const connectionPhase = useMachineControl((s) => s.connectionPhase)
  const machineState = useMachineControl((s) => s.machineState)
  const homed = useMachineControl((s) => s.homed)
  const activeWcs = useMachineControl((s) => s.activeWcs)
  const job = useMachineControl((s) => s.job)
  const programReadiness = useMachineControl((s) => s.programReadiness)
  const programFit = useMachineControl((s) => s.programFit)
  const singleBlock = useMachineControl((s) => s.singleBlock)
  const fitTrace = useMachineControl((s) => s.fitTrace)
  const toolChange = useMachineControl((s) => s.toolChange)
  // WO-2031: a boundary macro starting, waiting at hold() or ending changes
  // the session's hold decision below; this re-renders on each.
  useSyncExternalStore(subscribeMacroRun, activeMacroRun, () => null)
  const programText = useMachineControl((s) => s.programText)
  const noHomeSwitches = useCamStore((s) => machineHasNoHomeSwitches(controlMachine(s)))
  // WO-2772: the same verdict as CYCLE START, so the same inputs to its
  // reading of a loaded file - the Control machine, the tool table and
  // (WO-2833) the work offsets with their rotations.
  useCamStore((s) => controlMachine(s))
  useMachineToolTable((s) => s.byMachine)
  useMachineControl((s) => s.offsets)
  useSyncExternalStore(subscribeWorkRotations, workRotations, workRotations)
  const review = useSyncExternalStore(subscribeRunFromReview, runFromReview, runFromReview)
  const steppingBack = useSyncExternalStore(subscribeStepBackInProgress, stepBackInProgress, () => false)
  // WO-328: Step (SkipForward) executes a real g-code block through the same
  // canonical cycle-start verdict CYCLE START uses, so it gates identically.
  // Back is gated too (Operator 2026-09-14, "A: Flash, all motion off"): after an
  // E-STOP mid-program in Single Block the machine sits in hold with a
  // completed line, and Back would re-run the previous line - motion under
  // the latch.
  const estopTripped = useSyncExternalStore(subscribeEstopNeedsReset, estopNeedsReset, () => true)
  const state = deriveOperatorTransport({
    connectionPhase,
    machineState,
    homed,
    activeWcs,
    noHomeSwitches,
    job,
    programReadiness,
    programFit,
    singleBlock,
    fitTrace,
    toolChange,
    programText,
    programParts: programPartsTransportState(),
    guidedMeasure: guidedToolMeasureState(),
    programHold: programHoldCycleStartDecision(),
  })
  const connected = connectionPhase === 'connected'
  // WO-1992: the Step row's three gates are rows of the operator authority table.
  const authorityFacts: OperatorAuthorityFacts = {
    connected,
    machineState,
    jobPhase: job.phase,
    estopLatched: estopTripped,
    singleBlock,
    steppingBack,
    ackedSourceLine: job.ackedSourceLine,
    cycleStartEnabled: state.cycleStartEnabled,
  }
  const singleBlockGate = authorize('singleBlock', authorityFacts)
  const backGate = authorize('stepBack', authorityFacts)
  const forwardGate = authorize('stepForward', authorityFacts)
  const reArming = useSyncExternalStore(subscribeResetInProgress, resetInProgress, () => false)
  const reArmRefusal = useSyncExternalStore(subscribeReArmRefusal, readReArmRefusal, () => null)
  // WO-414 batch 3 (R24): the Step Back result is NOT a sentence in this row
  // any more - it goes to the console (below); the status line keeps the
  // re-arm reason / Single Block mode only.
  const transportStatus = deriveTransportStatusLine({
    singleBlock,
    reArm: state.reArm,
    reArming: reArming || reArmRefusal !== null,
    stepBack: null,
  })
  useEffect(() => {
    if (review.source !== 'step-back' || (!review.plan && !review.error)) return
    if (lastStepBackRevision === review.revision) return
    lastStepBackRevision = review.revision
    useMachineControl.getState().pushConsole('tx', stepBackSentence(review), review.error ? 'error' : 'info')
  }, [review])
  // WO-2001 / WO-2276: report actual mode changes, independent of the display
  // priority. A disabled Re-arm reason is not an operator's Re-arm attempt:
  // starting/resuming a cycle must not echo that refusal to the console.
  // Quiet on first paint and once across main + aux mounts.
  useEffect(() => {
    const modeChanged = lastConsoleSingleBlock !== null && lastConsoleSingleBlock !== singleBlock
    lastConsoleSingleBlock = singleBlock
    if (!modeChanged) return
    useMachineControl.getState().pushConsole('tx', singleBlock ? SINGLE_BLOCK_STATUS.on : SINGLE_BLOCK_STATUS.off, 'info')
  }, [singleBlock])
  return (
    <div className="control-uix-steprow" data-testid="control-uix-steprow">
      <button
        className={`control-chip-btn control-single-block-mode control-uix-step-toggle ${singleBlock ? 'control-chip-active' : ''}`}
        data-testid="control-singleblock-toggle"
        aria-pressed={singleBlock}
        disabled={singleBlockGate.disabled}
        onClick={() => setMachineSingleBlock(!singleBlock)}
        data-tooltip={
          singleBlockGate.refusal ?? (singleBlock ? SINGLE_BLOCK_STATUS.on : SINGLE_BLOCK_STATUS.off)
        }
      >{controlText('ControlTransportBar.text079')}</button>
      <button
        className="control-step-btn control-uix-step-btn"
        data-testid="control-step-back"
        disabled={backGate.disabled}
        data-tooltip={backGate.refusal ?? controlText('ControlTransportBar.text080')}
        onClick={() => {
          void stepBackOneLine()
        }}
      >
        <SkipBack size={13} />{controlText('ControlTransportBar.text081')}</button>
      <button
        className="control-step-btn control-uix-step-btn"
        data-testid="control-step-forward"
        disabled={forwardGate.disabled}
        data-tooltip={forwardGate.refusal ?? controlText('ControlTransportBar.text082')}
        onClick={() => void executeOperatorCycleStart()}
      >
        <SkipForward size={13} />{controlText('ControlTransportBar.text083')}</button>
      {/* WO-414 batch 1 (Operator ruling 2026-08-21: "What here is required? Again, I
          am trying to make the UI less busy."): the two grey sentences that
          used to sit here and under Re-arm ("OFF: CYCLE START runs
          continuously" / "The program is still running - Feed Hold, then
          Stop/Reset, before re-arming") are now ONE compact status line.
          It shows the most useful sentence right now - why Re-arm is
          disabled, else the Single Block mode (batch 3 / R24: a Step Back
          result is a console line only, Operator: "I only need the buttons, not
          the text"). WO-2276: the Re-arm reason stays in place; only actual
          Single Block mode changes are written to the console. The inner testid names
          which sentence is showing so the older tests still find it. */}
      <span
        className="control-mode-explainer control-transport-status"
        data-testid="control-singleblock-explainer"
        data-status-kind={transportStatus.kind}
        role="status"
        title={transportStatus.title ?? transportStatus.text}
      >
        <Info size={12} className="control-banner-icon" aria-hidden="true" />
        <span data-testid={transportStatus.testId}>{transportStatus.text}</span>
      </span>
    </div>
  )
}
