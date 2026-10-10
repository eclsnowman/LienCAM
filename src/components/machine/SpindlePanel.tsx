// SpindlePanel - manual spindle and coolant control (MACHINE-CONTROL Tier 0,
// stage 9 rewire). NOTHING here hardcodes a code: every button resolves
// through the machine-action abstraction (user override -> controller
// default), because machines are wired differently and controllers differ.
// The gear opens the Machine Actions modal. MDI-path: refused while a job
// streams (RX-buffer rule).
//
// WO-049: CW/CCW/Off and Mist/Flood/Off are radio sets (EXACTLY ONE lit).
// The latched member wears .control-latched (blue selection + underline).
// TODO(WO-050): bind latched state to the store's live accessory state
// (GrblParserState.spindle / .coolant) once accessory-state plumbing
// lands. Until then, track the commanded state locally — do not fake
// the live controller state.
// WO-2668: the Vacuum button lights from its pin's controller readback whenever
// the session has one - whoever switched the pin. The locally commanded state
// stands only where there is no readback (a text controller, no pin).

import { useEffect, useState, useSyncExternalStore } from 'react'
import { CircleOff, Droplets, Fan, Settings2 } from 'lucide-react'
import { controlMachine, useCamStore } from '../../store'
import { useMachineControl } from '../../store/machineControlStore'
import { useMachineActions } from '../../store/machineActionsStore'
import { useUiPrefs } from '../../store/uiPrefs'
import {
  CONTROLLER_NEUTRAL_STOP_LINES,
  resolveBuiltinLines,
  substituteActionLines,
  type BuiltinActionId,
} from '../../lib/machine/machineActions'
import {
  resolveDeclaredController,
  UNDECLARED_CONTROLLER_REASON,
} from '../../lib/machine/machineChoice'
import {
  commandSpindle,
  getMachineController,
  pausedProgramTakesCommands,
  runMachineAction,
  spindleRoute,
  subscribePausedProgramTakesCommands,
  subscribeToolChangeHold,
  toolChangeHoldActive,
} from '../../lib/machine/machineSession'
import { outputReadbackOn, watchOutputPins } from '../../lib/machine/outputPinWatch'
import type { MachineStatus } from '../../lib/machine/controller'
import type { MachineConfig, MachineOutputDefinition } from '../../types'
import {
  machineOffersCoolant,
  machineOutputForChannel,
  machineVacuumCapability,
  statedCoolantCapability,
  type CoolantChannel,
} from '../../types'
import {
  ControlPanelCollapseToggle,
  useControlPanelCollapsed,
} from './ControlPanelCollapseToggle'
import { NumCell } from './NumCell'
import { authorize, type OperatorAuthorityFacts } from '../../lib/machine/operatorAuthority'

type SpindleDir = 'cw' | 'ccw' | 'off'
type AccessoryRunState = Record<CoolantChannel, boolean>

const ACCESSORY_CHANNELS: readonly CoolantChannel[] = ['mist', 'flood', 'vacuum']
const ACCESSORIES_STOPPED: AccessoryRunState = { mist: false, flood: false, vacuum: false }
const NO_OUTPUTS: readonly MachineOutputDefinition[] = []

/**
 * WO-1650: THE OUTPUTS THIS MACHINE'S ONE LIST DEFINES THAT GET A BUTTON OF
 * THEIR OWN - a pump, air, a dust boot: every listed output that is not one of
 * the three channels the panel already draws (mist, flood, vacuum) and is not a
 * relay switched beside a controller word of its own (the spindle's M3).
 * Operator ruling 2026-09-17: "They define the pins. They point them at the use cases
 * like a pump or a vacuum or whatever they want to run in the macro and it
 * works." Each button sends the output's own words - its on word, and its off
 * word or the shared M9 - through the same action path as every other button,
 * so the pin it switches is the definition's (WO-1649's one resolver).
 *
 * Each is the one-step "switch output" body WO-1674's macro model will carry;
 * this panel draws one per listed output rather than a fixed strip.
 */
export function listedOutputButtons(
  outputs: readonly MachineOutputDefinition[] | null | undefined,
): MachineOutputDefinition[] {
  return (outputs ?? []).filter((output) =>
    output.besideWord !== true
    && output.role === undefined
    && /^M\d+$/.test(output.onCode))
}

// WO-442: `MachineStatus.spindle` (decoded VFD telemetry) has no store
// plumbing yet - `machineSession.ts`'s `applyContractStatus` and
// `machineControlStore.ts` are both outside this WO's owned-paths, so this
// reads the live controller directly rather than widening either. Polled,
// not event-driven: there is no generic "status changed" subscription
// outside the store today. 500ms matches the bridge's own IDLE push cadence
// (BRIDGE-PROTOCOL.md "Cadence"), so this never claims fresher data than the
// wire can actually carry.
const SPINDLE_TELEMETRY_POLL_MS = 500

/** `status.spindle` may be `undefined` (GrblController/SimulatedController
 *  never set the key at all - see the field's own doc in controller.ts) as
 *  well as `null` (UccncController with no VFD link/definition) - both mean
 *  the same thing to a reader: nothing to show. */
function useSpindleTelemetry(connected: boolean): NonNullable<MachineStatus['spindle']> | null {
  const [telemetry, setTelemetry] = useState<NonNullable<MachineStatus['spindle']> | null>(null)
  useEffect(() => {
    if (!connected) {
      setTelemetry(null)
      return
    }
    const read = () => setTelemetry(getMachineController().status().spindle ?? null)
    read()
    const timer = setInterval(read, SPINDLE_TELEMETRY_POLL_MS)
    return () => clearInterval(timer)
  }, [connected])
  return telemetry
}

/** The spindle speed range the machine definition states. An end the machine
 * does not state (absent, zero or inverted) bounds nothing - no number from
 * any other machine stands in for it. */
export function spindleRpmRange(
  machine: Pick<MachineConfig, 'minSpindleRpm' | 'maxSpindleRpm'> | null | undefined,
): { minRpm: number; maxRpm: number | undefined } {
  const max = machine?.maxSpindleRpm
  const maxRpm = Number.isFinite(max) && max! > 0 ? max : undefined
  const min = machine?.minSpindleRpm
  const minRpm = Number.isFinite(min) && min! > 0 && (maxRpm === undefined || min! <= maxRpm) ? min! : 0
  return { minRpm, maxRpm }
}

export function rpmWithin(value: number, minRpm: number, maxRpm: number | undefined): number {
  return Math.max(minRpm, maxRpm === undefined ? value : Math.min(value, maxRpm))
}

export function SpindlePanel({ onOpenActions }: { onOpenActions: () => void }) {
  const connected = useMachineControl((s) => s.connectionPhase) === 'connected'
  const jobPhase = useMachineControl((s) => s.job.phase)
  // WO-2237: a program paused at rest takes the spindle and the outputs (the
  // command turns the pause into a kept stop); the tool-change hold and a hold
  // another flow owns keep them locked, as before.
  const machineState = useMachineControl((s) => s.machineState)
  const toolChangeHold = useSyncExternalStore(subscribeToolChangeHold, toolChangeHoldActive, () => false)
  const pauseTakesCommands = useSyncExternalStore(subscribePausedProgramTakesCommands, pausedProgramTakesCommands, () => false)
  const spindleRpm = useMachineControl((s) => s.spindleRpm)
  // WO-133: the live REPORTED accessory state (decoded from the status
  // report's A: field, cached by the controller between reports). This is
  // what the machine says it is DOING - not the local button latch, and not
  // the $G-commanded modal state, which can lead the live report.
  const machine = useCamStore(controlMachine)
  const machineId = machine?.id ?? 'default'
  const controllerResolution = resolveDeclaredController(machine)
  // WO-1642: the range is the ACTIVE machine's, both ends of it. The saved
  // rpm is a browser preference shared by every machine, so it is brought
  // inside this machine's range rather than commanded as typed for another.
  const { minRpm, maxRpm } = spindleRpmRange(machine)
  const config = useMachineActions((s) => s.byMachine[machineId])
  const rpm = rpmWithin(useUiPrefs((s) => s.machineSpindleRpm), minRpm, maxRpm)
  const accessories = useMachineControl((s) => s.reportedAccessories)

  const [commandedDir, setCommandedDir] = useState<SpindleDir>('off')
  const [commandedAccessories, setCommandedAccessories] =
    useState<AccessoryRunState>(ACCESSORIES_STOPPED)
  // WO-1650: the local latch of each listed output button, keyed by its on
  // word. Written only on a command that went - the WO-474 rule.
  const [listedRunning, setListedRunning] = useState<Record<string, boolean>>({})
  const definedOutputs = machine?.controllerDefinition?.outputs ?? NO_OUTPUTS
  const listedButtons = listedOutputButtons(definedOutputs)
  /** A machine whose one list defines any output decides its Mist and Flood
   *  buttons from that list too: no listed mist, no Mist button. */
  const listDefinesOutputs = definedOutputs.some((output) => output.besideWord !== true)
  const collapsed = useControlPanelCollapsed('spindle')
  const telemetry = useSpindleTelemetry(connected)
  // WO-1079 kept the VA-vs-W provenance honest while the row showed power.
  // WO-1793 (Operator MC 2026-09-20) retired that inline segment from this
  // presentation, so the derived/register label and its tooltip go with it -
  // local presentation only. The decode still computes apparent power from
  // volts x amps exactly as before (src/lib/machine/vfd, pinned by
  // vfdDecode.wo441); nothing about the data changed.

  /**
   * WO-965: DOES THIS MACHINE EVEN HAVE COOLANT?
   *
   * Operator ruling 2026-08-24: "I want to be able to toggle if mist or flood even exist.
   * If they do not, don't even show the buttons ... I have no coolant at all."
   * Two of the six controls on this panel are, for him, permanently useless,
   * and a Mist button on a machine with no mist is this surface asserting a
   * capability the machine has not got - the same defect WO-941 took out of the
   * homing block.
   *
   * ABSENT IS NOT FALSE. `machineOffersCoolant` hides a channel ONLY on a
   * stated `false`; a record that has never carried the flags keeps both
   * buttons, so nobody's machine loses a control by upgrading. That negative
   * control is the acceptance criterion this order names in capitals.
   */
  const offered = (channel: CoolantChannel) => machineOffersCoolant(machine, channel)
  /**
   * READ THE STORED DOCUMENT, RAW - AND THAT IS THE POINT (WO-1058).
   *
   * This panel used to reconcile on read, so that a hand-edited or older record
   * with its vacuum on the M8 the Flood button beside it sends could not render
   * two buttons carrying one command. Reconcile-on-read is what made this order
   * take twelve review rounds: the post did it too, the definition editor did
   * not, and the same record was therefore shown three ways. A collision is
   * migrated out of the document ONCE now, at `adoptMachineDocument` in the
   * store - every door a machine comes in through - so a record that reaches
   * this panel has already been put right and every surface reads the one
   * document. If this line ever grows a reconcile again, the surface that
   * forgets is the surface that lies.
   */
  const vacuum = machineVacuumCapability(machine)
  const vacuumOutput = machineOutputForChannel(machine, 'vacuum')
  const vacuumAnswer = statedCoolantCapability(machine, 'vacuum')
  // WO-2668 (the operator 2026-10-07, at the machine: MDI M7 ran the vacuum while its
  // button stayed dark): the vacuum pin's controller readback, kept read while
  // this button is mounted - now and after every connect, Stop/Reset, E-STOP
  // and job end.
  const outputPins = useMachineControl((s) => s.outputPins)
  const vacuumPort = vacuumOutput?.pin.port ?? 0
  const vacuumPinNumber = vacuumOutput?.pin.pin ?? 0
  const vacuumNegate = vacuumOutput?.pin.negate ?? null
  useEffect(
    () => watchOutputPins([{ port: vacuumPort, pin: vacuumPinNumber, negate: vacuumNegate }]),
    [vacuumPort, vacuumPinNumber, vacuumNegate],
  )

  // WO-959's rule, and it is read here rather than at the collapsed summary
  // alone: the source of a live accessory reading is chosen by whether it is
  // ALIVE. Operator's bridge reports `ownsSpindle = false` (the AXBB-E's spindle
  // and coolant sit on a separate Modbus link), which makes
  // `reportedAccessories` a permanent constant there - so where the backend
  // does not own accessories the local latch is the only truth this panel has,
  // and where it does, the machine's own report wins.
  const ownsAccessories = getMachineController().capabilities?.ownsSpindle === true
  const vacuumOwnsReportedChannel = (channel: 'mist' | 'flood'): boolean =>
    statedCoolantCapability(machine, channel) === false
      && vacuum?.onCode === (channel === 'mist' ? 'M7' : 'M8')
  const reportedVacuumChannel = vacuumOwnsReportedChannel('mist')
    ? 'mist'
    : vacuumOwnsReportedChannel('flood')
      ? 'flood'
      : null
  /**
   * NO GATE MAY EVER BLOCK A STOP, AND HIDING A BUTTON IS A GATE (WO-965).
   *
   * A shared-off channel has no separate Coolant Off button (WO-964: pressing
   * a LIT coolant button IS the stop). So a channel that is reported or
   * latched RUNNING keeps its button whatever the
   * capability says - otherwise the one press that stops it is the press the
   * flag just deleted, and a machine reporting coolant while both flags are off
   * is a FACT this surface may not swallow.
   *
   * The source of "running" is chosen the same way `dirText` chooses it: the
   * controller's reported accessories where the backend OWNS them, and the
   * local latch where it does not (`ownsSpindle === false` on Operator's bridge
   * makes `reportedAccessories` a constant - see the long note above).
   */
  /**
   * THE VACUUM BUTTON HAS EXACTLY ONE STATE, AND IT IS COMPUTED HERE.
   *
   * Rounds 2 and 13 of this order both failed on the same shape: pressing Flood
   * while the vacuum ran darkened the Vacuum button, so its next press re-sent
   * the START code at a vacuum that was already running. That is what a SHARED
   * latch does. There is exactly one `vacuumRunning` in this file, every reader
   * below goes through it, and its two sources are named here and nowhere else:
   *
   *   - the controller's own report, but ONLY when the backend owns accessories
   *     AND this machine's vacuum owns a reported channel word (its `onCode` is
   *     the M7 or M8 of a channel this machine states it has NOT got - the only
   *     case where "flood is running" is a statement about the vacuum). On an
   *     ALONGSIDE machine - mist, flood and a vacuum on its own custom code -
   *     `reportedVacuumChannel` is null, so a mist or flood report can never
   *     feed this value.
   *   - WO-2668, ahead of both: the vacuum pin's controller readback, when the
   *     session has read it - the board's own answer, whoever switched it.
   *   - otherwise the LOCAL latch, `commandedAccessories.vacuum`, which is
   *     written by `pressVacuum` alone through the output's own words or the
   *     shared accessory stop fallback. A Mist or Flood START never touches it: the
   *     mutually-exclusive pair rule in `runAccessory` writes `mist` and
   *     `flood` and nothing else.
   *
   * The press toggles FROM this value: lit sends the off, unlit sends the on.
   */
  const vacuumRunning: boolean = outputReadbackOn(vacuumOutput, outputPins)
    ?? (ownsAccessories && reportedVacuumChannel !== null
      ? accessories[reportedVacuumChannel]
      : commandedAccessories.vacuum)

  const running = (channel: CoolantChannel): boolean =>
    channel === 'vacuum'
      ? vacuumRunning
      : ownsAccessories && !vacuumOwnsReportedChannel(channel)
        ? accessories[channel]
        : commandedAccessories[channel]

  /** Renders at all: this machine HAS the channel, or it is RUNNING and needs
   *  stopping. Never fewer buttons than the stop requires. */
  const showChannel = (channel: 'mist' | 'flood'): boolean =>
    (offered(channel) && (!listDefinesOutputs || machineOutputForChannel(machine, channel) !== null))
    || running(channel)
  const showCoolant = showChannel('mist') || showChannel('flood')
  const showVacuum = vacuum !== null || vacuumRunning
  const listedRunningNames = listedButtons
    .filter((output) => listedRunning[output.onCode] === true)
    .map((output) => output.name)
  const showAccessories = showCoolant || showVacuum || listedButtons.length > 0

  /**
   * WHY, IN THE MACHINE CONSOLE - the surface this panel already uses for
   * everything it declines to do, and Operator's standing ruling on where a reason
   * goes ("should be in the consol. We have taled about this."). A missing
   * button with no explanation anywhere is indistinguishable from a bug.
   *
   * Once per machine per stated answer, not once per render: the effect's key
   * IS the answer, so switching machines or changing the flags says it again
   * and nothing else does.
   */
  const hidden = (['mist', 'flood'] as const).filter((c) => !showChannel(c))
  const hiddenKey = `${machineId}:${hidden.join(',')}`
  useEffect(() => {
    if (hidden.length === 0) return
    useMachineControl.getState().pushConsole(
      'rx',
      `This machine's definition says it has no ${hidden.join(' and no ')} coolant, `
        + `so ${hidden.length === 1 ? 'that button is' : 'those buttons are'} not shown. `
        + 'Change that under Coolant in the machine definition.',
      'info',
    )
    // THE ANSWER IS THE DEPENDENCY. `hidden` is a fresh array on every render
    // and naming it would fire this on every keystroke anywhere in the app.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hiddenKey])

  /**
   * A STATED No EXPLAINS ITSELF; A MACHINE NOBODY HAS ASKED SAYS NOTHING.
   *
   * Exactly the rule the coolant effect above follows, and for the same reason:
   * a line is owed where the definition took a control away, not where the
   * definition is simply silent. Every machine that has never been asked about
   * vacuum - which is every record written before this order, including the
   * factory default - would otherwise open the Control page with a line about
   * an accessory nobody has mentioned. It never left the console empty and it
   * added a second line to the undeclared-controller refusal, which is a
   * one-line refusal by design (`controllerResolver.wo1024`, `consoleCollapse`).
   * The unanswered case is answered where it can be acted on: the definition
   * panel's Vacuum row says "no Vacuum button - nobody has said" and says it
   * again in the console the moment the answer is set.
   */
  const hiddenVacuumKey = `${machineId}:${vacuumAnswer === null ? 'not-stated' : vacuumAnswer ? 'yes' : 'no'}:${showVacuum}`
  useEffect(() => {
    if (showVacuum || vacuumAnswer !== false) return
    useMachineControl.getState().pushConsole(
      'rx',
      "This machine's definition says it has no vacuum, so the Vacuum button is not shown. Change that under Coolant in the machine definition.",
      'info',
    )
    // The primitive answer/show tuple is the dependency; see the coolant
    // explanation above for why the freshly-created render values are not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hiddenVacuumKey])


  /**
   * WHAT THE BUTTONS SHOW IS WHAT THE MACHINE REPORTS, not what we asked for.
   *
   * Found at the machine 2026-08-22, by Operator: the CW button was still lit from
   * a previous press, on a spindle that was not turning. `spindleDir` was
   * local `useState` set on a successful command and never corrected by
   * anything, so the moment the spindle stopped for a reason the UI did not
   * initiate - here, the bridge's own client-gone watchdog - the panel went on
   * showing the affirmative state of a spindle at rest.
   *
   * WO-474 fixed latching on a REFUSED command. This is the other half: a
   * command that went, succeeded, and then stopped being true.
   *
   * Direction still comes from what we commanded, and must: this inverter
   * reports the opposite direction from the one commanded while rotating
   * correctly (VFD-COMMISSIONING.md 4.9). Running/stopped comes from the
   * machine. Each fact from the source that is honest about it.
   */
  const reportedRunning = telemetry?.running ?? null
  const latched: SpindleDir | null =
    reportedRunning === null
      ? commandedDir // this backend cannot say; the commanded state is all there is
      : reportedRunning
        ? commandedDir === 'off'
          ? null // turning, and we did not start it - so we do not know which way
          : commandedDir
        : 'off'

  const actionLines = (
    action: BuiltinActionId,
    mappedDefault?: string[],
    honorOverride = true,
  ): string[] | null => {
    const override = honorOverride ? config?.overrides[action] : undefined
    if (override && override.length > 0) return override
    if (!controllerResolution.ok) {
      if (action === 'spindleOff' || action === 'coolantOff') {
        return CONTROLLER_NEUTRAL_STOP_LINES[action]
      }
      return null
    }
    return mappedDefault
      ?? resolveBuiltinLines(config, controllerResolution.controller, action)
  }

  const run = (
    action: BuiltinActionId,
    mappedDefault?: string[],
    honorOverride = true,
  ) => {
    const lines = actionLines(action, mappedDefault, honorOverride)
    if (lines) {
      return runMachineAction(substituteActionLines(lines, { rpm }), { action })
    }
    return {
      ok: false as const,
      sent: 0,
      reason: UNDECLARED_CONTROLLER_REASON,
    }
  }

  /**
   * WO-474, THE OTHER HALF OF THE SAME DEFECT.
   *
   * The spindle buttons were fixed on 2026-08-22 to latch only on a command
   * that actually went. These three were not, and kept the original
   * `run(action); setCoolantMode(mode)` pair - so with the E-STOP latch set,
   * which is its state on EVERY fresh load, pressing Mist put nothing on the
   * wire, printed nothing, and still LIT THE BUTTON. Character for character
   * the defect WO-474 was written about, in this file, twelve lines below the
   * fix for it.
   *
   * `run` returns `runMachineAction`'s { ok, sent } and all three coolant call
   * sites discarded it; that function refuses silently
   * (machineSession.ts:1936) when the latch is set and the line is not one of
   * the stop-exempt ones.
   *
   * WHY THIS DOES NOT READ `reportedAccessories`, though the panel already
   * subscribes it: `onAccessories` fires only when `capabilities.ownsSpindle`,
   * and this machine's bridge reports that FALSE (Bridge.cs:1384) because the
   * spindle and coolant sit on a separate Modbus link. The value is a
   * constant here, so a button latched on it would never light at all - which
   * is indistinguishable from a command that never went. The spindle half has
   * a live channel for this (the VFD's own telemetry); coolant has none.
   *
   * Coolant OFF is not gated - M9 is stop-exempt (machineSession.ts:1924), the
   * same rule that exempts M5 - so it returns ok and latches as it always did.
   */
  /**
   * WO-964. Operator, overturning WO-957 on this half: "OK we can leave off button
   * on spindle. But spindle only. All others are two state buttons."
   *
   * So the spindle is CW / CCW / OFF again and there is NO two-state press here
   * - CW starts CW, and Off stops. WO-957's `pressSpindle` is GONE, including
   * its "or the machine reports running" clause, and it is deleted rather than
   * left as a harmless extra: an unexplained special case is a thing the next
   * reader defends.
   *
   * WHY IT WAS WRONG, recorded so it is not re-derived. It rested on two claims
   * and he challenged both:
   *
   *   1. "the drive reports direction backwards" OVERSTATED
   *      VFD-COMMISSIONING.md 4.9. What was measured is that the STATUS
   *      REGISTER 0x1001 returns the opposite of what was commanded, rotation
   *      verified correct by eye, cause given as an explicit unconfirmed
   *      hypothesis. Its conclusion is narrow - never infer direction from that
   *      register - and it is satisfied by not reading it. And his physics is
   *      the harder point: a VFD drives PHASE ORDER and has no notion of
   *      clockwise; CW/CCW is a label fixed by swapping two motor leads. There
   *      was no reversed inverter to defend against.
   *
   *   2. "it could be running when we did not start it" is not his machine -
   *      the drive is in remote mode and only this software starts it. The one
   *      real case is an app or bridge restart while the spindle keeps turning,
   *      and that needs no rule either, because telemetry.running is live over
   *      the VFD's own Modbus link and `latched` already reads it.
   *
   * With Off on the panel the question is moot: there is always an
   * unconditional stop. "I think you are over complicating it" was correct.
   */
  /** WO-1058: vacuum is independent of the mutually-exclusive mist/flood pair.
   * For a channel without its own off word, stopping one active group first
   * sends the configured M9 action and then restores the other group when it
   * was running. Safety here depends on preserving that action boundary: the
   * coolantOff call is exempt, then each following M7/M8/custom START is sent
   * in a separate non-stop action call and remains interlocked. */
  const runAccessory = (
    channel: CoolantChannel,
    nextRunning: boolean,
    action: BuiltinActionId,
    mappedDefault?: string[],
    honorOverride = true,
    reportRefusal = true,
  ) => {
    const result = run(action, mappedDefault, honorOverride)
    if (result.ok) {
      // Latch ONLY on a command that actually went. Same rule as runSpindle.
      setCommandedAccessories((current) => {
        const next = { ...current, [channel]: nextRunning }
        if (nextRunning && channel === 'mist') next.flood = false
        if (nextRunning && channel === 'flood') next.mist = false
        return next
      })
      return result
    }
    // Refused. Print the reason THE SESSION GAVE US, in the console - the
    // surface this panel already uses for refusals, and never the layout.
    //
    // WO-963: this used to call `estopNeedsReset()` itself and fall back to a
    // generic sentence, which made this file carry TWO mechanisms for one job -
    // the spindle half reading `result.reason` while the coolant half inferred
    // it. An inference is a second opinion about something `runMachineAction`
    // already knows, and it fails silently: any refusal it has not heard of
    // arrives wearing the generic sentence and nobody can tell.
    if (reportRefusal) {
      useMachineControl.getState().pushConsole('tx', result.reason, 'error')
    }
    return result
  }

  const accessoryStart = (
    channel: CoolantChannel,
  ): { action: BuiltinActionId; lines: string[] } | null => {
    if (channel === 'mist') {
      const lines = actionLines('coolantMist')
      return lines ? { action: 'coolantMist', lines } : null
    }
    if (channel === 'flood') {
      const lines = actionLines('coolantFlood')
      return lines ? { action: 'coolantFlood', lines } : null
    }
    if (!vacuum) return null
    const action: BuiltinActionId = vacuum.onCode === 'M7'
      ? 'coolantMist'
      : 'coolantFlood'
    const lines = actionLines(
      action,
      [vacuum.onCode],
      vacuum.onCode === 'M7' || vacuum.onCode === 'M8',
    )
    return lines ? { action, lines } : null
  }

  const stopAccessory = (channel: CoolantChannel) => {
    const stopLines = actionLines('coolantOff')
    const runningOthers = ACCESSORY_CHANNELS
      .filter((other) => other !== channel && running(other))
    const restored = runningOthers
      .map((other) => ({ channel: other, start: accessoryStart(other) }))
      .filter((entry): entry is {
        channel: CoolantChannel
        start: { action: BuiltinActionId; lines: string[] }
      } => entry.start !== null)
      .map(({ channel: restoredChannel, start }) => ({
        channel: restoredChannel,
        action: start.action,
        lines: start.lines,
      }))
    const controllerUndeclaredWithRunningPeer = !controllerResolution.ok && runningOthers.length > 0
    const stopResult = runAccessory(
      channel,
      false,
      'coolantOff',
      stopLines ?? undefined,
      true,
      false,
    )
    // THE ONE WRITE TO A PEER'S LATCH THIS FILE ALLOWS, AND WHY IT IS HONEST.
    // When this helper is used, the shared accessory stop IS every channel's
    // off. So the channels below are off in fact, not by a Mist or Flood press
    // deciding something about the vacuum. Outside these two branches nothing
    // in this file writes a channel it was not pressed for.
    if (stopResult.ok && controllerUndeclaredWithRunningPeer) {
      setCommandedAccessories((current) => {
        const next = { ...current }
        for (const other of runningOthers) next[other] = false
        return next
      })
      useMachineControl.getState().pushConsole(
        'tx',
        `${UNDECLARED_CONTROLLER_REASON} The shared accessory stop was sent, but no other accessory was restored.`,
        'error',
      )
      return { result: stopResult, stopLines, restored: [] }
    }
    if (!stopResult.ok) {
      useMachineControl.getState().pushConsole('tx', stopResult.reason, 'error')
      return { result: stopResult, stopLines, restored }
    }

    let sent = stopResult.sent
    const fullyRestored = new Set<CoolantChannel>()
    for (const [index, entry] of restored.entries()) {
      const restoreResult = run(entry.action, entry.lines, false)
      sent += restoreResult.sent
      if (restoreResult.ok) {
        fullyRestored.add(entry.channel)
        continue
      }
      const refusedRestoreLines = [
        ...entry.lines.slice(restoreResult.sent),
        ...restored.slice(index + 1).flatMap((later) => later.lines),
      ]
      setCommandedAccessories((current) => {
        const next = { ...current, [channel]: false }
        for (const candidate of restored) {
          next[candidate.channel] = fullyRestored.has(candidate.channel)
        }
        return next
      })
      const refusedDetail = refusedRestoreLines.length > 0
        ? ` Refused restore lines: ${refusedRestoreLines.join(', ')}.`
        : ''
      useMachineControl.getState().pushConsole(
        'tx',
        `${restoreResult.reason} The shared accessory stop was sent, so stopped or unrestored channels are now shown off.${refusedDetail}`,
        'error',
      )
      return {
        result: { ok: false as const, sent, reason: restoreResult.reason },
        stopLines,
        restored,
      }
    }
    // WO-1650: THE SHARED STOP STOPPED EVERY LISTED OUTPUT TOO, so each one
    // that was running is switched back on by its own word.
    const listedRestore = restoreListedOutputs(null)
    sent += listedRestore.sent
    if (!listedRestore.ok) {
      return {
        result: { ok: false as const, sent, reason: listedRestore.reason },
        stopLines,
        restored,
      }
    }
    const result = { ok: true as const, sent }
    return { result, stopLines, restored }
  }

  /** WO-1650: after the shared M9, switch every listed output that was running
   *  (except `except`) back on by its own on word. One that cannot be restored
   *  is shown off and the reason goes to the console. */
  const restoreListedOutputs = (
    except: string | null,
  ): { ok: true; sent: number } | { ok: false; sent: number; reason: string } => {
    let sent = 0
    const stillOn: Record<string, boolean> = {}
    let refusal: string | null = null
    for (const output of listedButtons) {
      if (output.onCode === except || listedRunning[output.onCode] !== true) continue
      if (refusal !== null) continue
      const restore = run('coolantFlood', [output.onCode], false)
      sent += restore.sent
      if (restore.ok) stillOn[output.onCode] = true
      else refusal = restore.reason
    }
    setListedRunning(stillOn)
    if (refusal !== null) {
      useMachineControl.getState().pushConsole(
        'tx',
        `${refusal} The shared accessory stop was sent, so the outputs it could not restore are now shown off.`,
        'error',
      )
      return { ok: false, sent, reason: refusal }
    }
    return { ok: true, sent }
  }

  /** One mechanism for every output whose definition supplies its own off
   * word. A null result means the output uses the shared accessory stop. */
  const stopOutputWithOwnWord = (output: MachineOutputDefinition) =>
    output.offCode === null
      ? null
      : { offCode: output.offCode, result: runMachineAction([output.offCode]) }

  /**
   * WO-1650: ONE BUTTON PER LISTED OUTPUT. Unlit sends the output's on word;
   * lit sends its own off word, or - when the definition names none - the
   * shared stop, after which every other running channel and output is
   * switched back on, exactly as the Mist / Flood / Vacuum stop does.
   */
  const pressListedOutput = (output: MachineOutputDefinition) => {
    const say = (text: string) => useMachineControl.getState().pushConsole('tx', text, 'info')
    const refused = (reason: string) => useMachineControl.getState().pushConsole('tx', reason, 'error')
    if (listedRunning[output.onCode] !== true) {
      const result = run('coolantFlood', [output.onCode], false)
      if (!result.ok) return refused(result.reason)
      setListedRunning((current) => ({ ...current, [output.onCode]: true }))
      return say(`${output.name} switched on with ${output.onCode}, the word this machine's definition gives it.`)
    }
    const ownStop = stopOutputWithOwnWord(output)
    if (ownStop !== null) {
      const { offCode, result } = ownStop
      if (!result.ok) return refused(result.reason)
      setListedRunning((current) => ({ ...current, [output.onCode]: false }))
      return say(`${output.name} switched off with ${offCode}, its own off word.`)
    }
    const stopLines = actionLines('coolantOff')
    const stop = run('coolantOff', stopLines ?? undefined, true)
    if (!stop.ok) return refused(stop.reason)
    // The shared stop stopped the channels too: restore the ones that ran.
    const channels = ACCESSORY_CHANNELS.filter((channel) => running(channel))
    const restoredChannels: CoolantChannel[] = []
    for (const channel of channels) {
      const start = accessoryStart(channel)
      const again = start ? run(start.action, start.lines, false) : null
      if (again?.ok) restoredChannels.push(channel)
      else if (again) refused(again.reason)
    }
    setCommandedAccessories((current) => {
      const next = { ...current }
      for (const channel of channels) next[channel] = restoredChannels.includes(channel)
      return next
    })
    const listed = restoreListedOutputs(output.onCode)
    const restoredNames = [
      ...restoredChannels,
      ...listedButtons
        .filter((other) => other.onCode !== output.onCode && listedRunning[other.onCode] === true)
        .map((other) => other.name),
    ]
    if (!listed.ok) return
    say(
      `${output.name} stopped with ${stopLines?.join(' then ') ?? 'the Coolant Off action'}`
      + `${restoredNames.length > 0 ? ` then restored ${restoredNames.join(' and ')}` : ''}`
      + ' - this output has no off word of its own, so it stops with the shared accessory stop.',
    )
  }

  const pressCoolant = (channel: 'mist' | 'flood', action: BuiltinActionId) => {
    const label = channel === 'mist' ? 'Mist' : 'Flood'
    if (running(channel)) {
      const { result, stopLines, restored } = stopAccessory(channel)
      if (result.ok) {
        const restoreReason = restored.length > 0
          ? ` then restored ${restored.map((entry) => entry.channel).join(' and ')}`
          : ''
        useMachineControl.getState().pushConsole(
          'tx',
          `${label} stopped with ${stopLines?.join(' then ') ?? 'the Coolant Off action'}${restoreReason} because each accessory channel keeps its own state.`,
          'info',
        )
      }
      return
    }
    const startLines = actionLines(action)
    const result = runAccessory(channel, true, action)
    if (result.ok) {
      useMachineControl.getState().pushConsole(
        'tx',
        `${label} started with ${startLines?.join(' then ') ?? `the ${label} action`} because that channel was switched on.`,
        'info',
      )
    }
  }

  /** Vacuum uses the complete coolant action path: matching M7/M8 action-line
   * overrides first, declared-controller refusal next, then its mapped M-code
   * as the controller default. A custom M-code has no coolant action identity,
   * so it cannot inherit an unrelated Mist/Flood override. Its listed output's
   * own off word wins; M9 remains the shared stop fallback. */
  const pressVacuum = () => {
    if (vacuumRunning) {
      const ownStop = vacuumOutput === null ? null : stopOutputWithOwnWord(vacuumOutput)
      if (ownStop !== null) {
        if (!ownStop.result.ok) {
          useMachineControl.getState().pushConsole('tx', ownStop.result.reason, 'error')
          return
        }
        setCommandedAccessories((current) => ({ ...current, vacuum: false }))
        useMachineControl.getState().pushConsole(
          'tx',
          `Vacuum stopped with ${ownStop.offCode}, its own off word from this machine's definition.`,
          'info',
        )
        return
      }
      const { result, stopLines, restored } = stopAccessory('vacuum')
      if (result.ok) {
        const restoreReason = restored.length > 0
          ? ` then restored ${restored.map((entry) => entry.channel).join(' and ')}`
          : ''
        useMachineControl.getState().pushConsole(
          'tx',
          `Vacuum off (${stopLines?.join(' then ') ?? 'the Coolant Off action'})${restoreReason}.`,
          'info',
        )
      }
      return
    }
    if (!vacuum) return
    const action: BuiltinActionId = vacuum.onCode === 'M7'
      ? 'coolantMist'
      : 'coolantFlood'
    const honorOverride = vacuum.onCode === 'M7' || vacuum.onCode === 'M8'
    const startLines = actionLines(action, [vacuum.onCode], honorOverride)
    const result = runAccessory('vacuum', true, action, [vacuum.onCode], honorOverride)
    if (result.ok) {
      useMachineControl.getState().pushConsole(
        'tx',
        `Vacuum on (${startLines?.join(' then ') ?? vacuum.onCode}).`,
        'info',
      )
    }
  }

  // The spindle no longer goes out as M3/M5 unconditionally. A controller
  // that takes spindle CALLS gets them - which is the only route that works
  // on the AXBB, whose bridge refuses text outright - and GRBL keeps the text
  // path, where the codes are correct AND user-overridable for odd wiring.
  const route = connected ? spindleRoute() : 'unsupported'

  /**
   * WO-474. Press the button, and one of three things is now true, never a
   * fourth: the command went, or it was refused AND SAID SO IN THE CONSOLE,
   * or the control was disabled with a reason in its tooltip.
   *
   * WHERE the sentence goes is Operator's standing ruling and it is not beside
   * the button - WO-414, WO-416, and again at the machine 2026-08-23: "should
   * be in the consol. We have taled about this." WO-474 was right that a
   * silent refusal is the worst outcome and wrong about the destination. The
   * operator is still told exactly why, in the one place this machine already
   * reports every other refusal - and the place they are already looking when
   * something does not happen.
   *
   * Found by driving this panel in a real browser 2026-08-22: with the E-STOP
   * latch un-reset - which is its state on EVERY fresh load - pressing CW put
   * ZERO frames on the wire, printed nothing, and still LATCHED THE BUTTON,
   * because `setSpindleDir` ran unconditionally beside the command. So the
   * panel showed the affirmative state of a command that never left.
   *
   * The latch predates the routing change; what the routing change did was
   * make refusal the normal case instead of a rare one.
   */
  const runSpindle = (direction: 'cw' | 'ccw' | 'off', action: BuiltinActionId) => {
    const lines = actionLines(action)
    if (direction !== 'off' && !lines) {
      useMachineControl.getState().pushConsole(
        'tx',
        UNDECLARED_CONTROLLER_REASON,
        'error',
      )
      return
    }
    const result = commandSpindle(direction, rpm, () =>
      lines ? substituteActionLines(lines, { rpm }) : [],
    )
    if (result.ok) {
      // Latch ONLY on a command that actually went. This is the whole fix.
      setCommandedDir(direction)
      return
    }
    // Refused. Say why, in the operator's terms - and say what the command
    // itself reported, not what this panel guessed.
    //
    // WO-474 item 1. This used to call `estopNeedsReset()` and pick a sentence
    // from it, falling back to a generic one when it came back false. That was
    // the panel forming a SECOND OPINION about something commandSpindle already
    // knew, and it could only ever name the one cause it had been taught: a new
    // refusal path in machineSession would have arrived here wearing "the
    // spindle command was refused" with nothing to indicate a sentence had gone
    // missing. `reason` now travels with the refusal and the inference is gone.
    // WO-2157: so does how to print it - a Probe tool in the spindle is
    // information, not a red line.
    useMachineControl.getState().pushConsole('tx', result.reason, result.severity ?? 'error')
  }

  /** What the button will actually do, for the tooltip. Showing G-code on a
   *  controller that refuses G-code is how an operator ends up believing a
   *  button was sent when it was not. */
  const spindleTip = (action: BuiltinActionId, what: string) => {
    if (route === 'calls') return `${what} (sent directly to the spindle link)`
    const lines = actionLines(action)
    if (route === 'text' && lines) return `${what} (${lines.join(' | ')})`
    if (route === 'text') return what
    return `${what} - this controller has no spindle control`
  }

  const coolantTip = (action: BuiltinActionId, what: string) => {
    const lines = actionLines(action)
    return lines ? `${what} (${lines.join(' | ')})` : what
  }
  /**
   * WO-475: the buttons follow the LINK, not the plan.
   *
   * `capabilities.spindleCommands` is derived from `hello.vfd.present`, which
   * means "a spindle link is CONFIGURED" - it is true even when the serial
   * port failed to open, observed directly on 2026-08-22 with COM3 held by
   * another process. That flag is right to be static. Whether the inverter is
   * ANSWERING is a live question, and it is answered here.
   *
   * Only STARTING is withheld. A stop is never gated - not by this, not by
   * anything - and a dead link is precisely when someone reaches for it.
   */
  const linkDown = telemetry !== null && telemetry.linkUp === false
  // WO-1992: the spindle and accessory gates are rows of the operator authority table.
  const authorityFacts: OperatorAuthorityFacts = {
    connected,
    machineState,
    jobPhase,
    toolChangeHold,
    pauseTakesCommands,
    spindleRouted: route !== 'unsupported',
    spindleLinkDown: linkDown,
  }
  const spindleStartGate = authorize('spindleStart', authorityFacts)
  const spindleDisabled = spindleStartGate.disabled
  const accessoryDisabled = authorize('accessory', authorityFacts).disabled
  const spindleStopDisabled = authorize('spindleStop', authorityFacts).disabled
  const startTip = (action: BuiltinActionId, what: string) =>
    spindleStartGate.refusal !== null
      ? `${what} - ${spindleStartGate.refusal}`
      : spindleTip(action, what)

  // WO-133: the collapsed summary's direction and coolant tokens. "Off" is a
  // READING worth seeing (the WO names the overcorrection: dropping a reading
  // because it is usually zero), so both tokens always render. Order matches
  // the panel title: spindle first, coolant after the pipe.
  //
  // WO-959 + WO-133, AND BOTH ORDERS ARE RIGHT - THAT IS THE WHOLE POINT.
  //
  // WO-133 made these read `reportedAccessories` on purpose, and its reason is
  // good: a change that arrives FROM the controller - an M5 in a streamed
  // program, an E-stop reset - is a machine fact this panel never commanded,
  // and the operator should see it. The button latch cannot know about it.
  //
  // WO-959 found the other half: `onAccessories` fires only for a backend that
  // OWNS the spindle, and this machine's bridge reports `ownsSpindle = false`
  // (the AXBB-E's spindle is on its own Modbus link). So on Operator's machine that
  // source is a CONSTANT - "Off | Off" permanently, whatever the spindle is
  // doing, three lines below an open panel reading the VFD's live telemetry and
  // getting it right. A constant wearing the costume of live state is worse
  // than a blank: a blank invites a look, a confident "Off" does not.
  //
  // So the source is chosen by whether it is ALIVE, not by preference. Where
  // the controller owns accessories, WO-133 stands unchanged and the reported
  // state wins - it is strictly better, because it catches what we did not
  // command. Where it does not, the panel falls back to the truth it does have,
  // which is exactly what the buttons show. Neither order had to lose.
  //
  // WO-959's own premise - "there is no defensible reason for the summary to
  // have its own idea of what the spindle is doing" - turned out to be wrong,
  // and the test WO-133 left behind is what said so. Recorded here rather than
  // re-derived by whoever reads this next.
  const dirText = ownsAccessories
    ? accessories.spindle === 'off'
      ? 'Off'
      : accessories.spindle.toUpperCase()
    : latched === null
      ? // The honest case: the machine says it is TURNING and we did not start
        // it, so we know it is on and we do not know which way. The drive
        // reports direction backwards (VFD-COMMISSIONING.md 4.9), so naming one
        // would be a guess and "Off" would be the lie WO-959 exists to remove.
        'Turning'
      : latched === 'off'
        ? 'Off'
        : latched.toUpperCase()

  const activeAccessories = ACCESSORY_CHANNELS.filter(running)
  const activeNames = [
    ...activeAccessories.map((channel) => channel[0].toUpperCase() + channel.slice(1)),
    ...listedRunningNames,
  ]
  const coolantText = activeNames.length > 0 ? activeNames.join('+') : 'Off'

  return (
    <section className="panel control-panel">
      <div className="panel-header">
        {/* WO-965: a title is a claim too. With both channels stated absent
            there is no coolant on this panel and no coolant on this machine,
            and a header saying otherwise is the same small lie the buttons
            were. No new element - the existing title tells the truth. */}
        <span className="panel-title">
          {(showCoolant && showVacuum) || listedButtons.length > 0
            ? 'Spindle / Accessories'
            : showCoolant
              ? 'Spindle / Coolant'
              : showVacuum ? 'Spindle / Vacuum' : 'Spindle'}
        </span>
        {/* WO-116: the live rpm readout stays visible even collapsed - a
            running spindle's speed is never folded out of sight.
            WO-133: rpm alone is NOT ENOUGH - direction and coolant are live
            machine readings too, and folding may hide CONTROLS, never LIVE
            MACHINE STATE. The full live cluster (rpm + direction + coolant)
            comes straight from the store's reportedAccessories, so it keeps
            ticking with every A: report.
            WO-184: that cluster now renders BELOW the header (see the
            compact row after this div) - in the header it did not fit. */}
        {!collapsed && (
          <span className="control-version">{spindleRpm ? `${Math.round(spindleRpm)} rpm` : ''}</span>
        )}
        {/* WO-184: the gear is a CONTROL, so it folds with the body - and it
            was also stealing 24px the longest title on the page could not
            spare. The transport bar's "Machine actions" button reaches the
            same modal while this panel is shut. */}
        {!collapsed && (
          <button
            className="panel-action-btn"
            data-testid="control-spindle-gear"
            onClick={onOpenActions}
            data-tooltip="Configure what these buttons send (machine actions)"
            aria-label="Configure machine actions"
          >
            <Settings2 size={13} />
          </button>
        )}
        <ControlPanelCollapseToggle
          panel="spindle"
          testId="control-spindle-toggle"
          collapseTip="Collapse spindle and coolant controls"
          expandTip="Show spindle and coolant controls"
        />
      </div>
      {/* WO-184: "SPINDLE / COOLANT" is the longest rail title there is; with
          the readout beside it in a 280px header it wrapped onto a second
          line and crushed the values against the chevron - measured 32px of
          title in a 26px header row, and it is what Operator's red arrow points
          at. The readings move DOWN onto their own full-width compact row,
          which is the shipped Position pattern he graded reference quality
          (control-position-compact). Same live source, same testid, room to
          read it. */}
      {collapsed && (
        <div className="panel-body">
          <div className="control-live-row">
            <span data-testid="control-spindle-collapsed-state">
              {spindleRpm === null ? '---' : Math.round(spindleRpm)} rpm {dirText}
              {showAccessories ? ` | ${coolantText}` : ''}
            </span>
          </div>
        </div>
      )}
      {!collapsed && (
      <div className="panel-body control-spindle-body">
        {/* RPM on its own line, then the three spindle actions as an equal
            three-across group (UI-CONTROL-PAGE-POLISH): as one row they
            overran the card and wrapped "Off" onto a ragged second line. */}
        <div className="control-jog-config-row">
          <span className="control-field-label">RPM</span>
          <NumCell
            className="mform-input mform-input-sm control-rpm-input"
            shown={String(rpm)}
            min={minRpm}
            max={maxRpm}
            step={500}
            onCommit={(text) => {
              const value = Number(text)
              if (!Number.isFinite(value) || value < 0) return false
              const nextRpm = rpmWithin(value, minRpm, maxRpm)
              if (nextRpm === rpm) return false
              useUiPrefs.setState({ machineSpindleRpm: nextRpm })
            }}
          />
        </div>
        <div className="control-spindle-btns" data-spindle-dir={latched ?? 'unknown'}>
          <button
            className={`control-spindle-btn ${latched === 'cw' ? 'control-latched' : ''}`}
            data-testid="control-spindle-cw"
            disabled={spindleDisabled}
            data-tooltip={startTip('spindleCw', 'Spindle on clockwise')}
            onClick={() => runSpindle('cw', 'spindleCw')}
          >
            <Fan size={13} /> CW
          </button>
          <button
            className={`control-spindle-btn ${latched === 'ccw' ? 'control-latched' : ''}`}
            data-testid="control-spindle-ccw"
            disabled={spindleDisabled}
            data-tooltip={startTip('spindleCcw', 'Spindle on counter-clockwise')}
            onClick={() => runSpindle('ccw', 'spindleCcw')}
          >
            <Fan size={13} /> CCW
          </button>
          {/* WO-964: Operator keeps the spindle's Off, and only the spindle's.
              `disabled` is the spindleStop gate and NOT `spindleDisabled` - a
              stop is never gated on having a route, because a stop that cannot
              be expressed is still attempted on every route there is. */}
          <button
            className={`control-spindle-btn ${latched === 'off' ? 'control-latched' : ''}`}
            data-testid="control-spindle-off"
            disabled={spindleStopDisabled}
            data-tooltip={spindleTip('spindleOff', 'Spindle stop')}
            onClick={() => runSpindle('off', 'spindleOff')}
          >
            <CircleOff size={13} /> Off
          </button>
        </div>
        {/* WO-442: decoded VFD spindle telemetry - the three measurements Operator
            reads: volts, amps, torque. `null` per field means the inverter
            reported nothing for it right now (link down, faulted, or this
            definition/inverter does not have it). Nothing here has been
            verified against real hardware (Huanyang GT's `verified` flag is
            false) - this only ever shows what the bridge and the decode
            actually produced.
            WO-1648: with no VFD link or definition at all the row carried no
            value and no control, only "not on this controller", and it was
            one of the rows pushing the macros below the fold. It is not
            rendered then; the row appears the moment there is telemetry.
            WO-1793 (Operator MC 2026-09-20): the static "Inverter" caption sat
            beside a live voltage number (it never named an inverter index),
            stole width in the 280px rail and wrapped the row; the inline VA
            power segment was not asked for. The row now shows ONLY volts,
            amps and torque with the same honest null placeholders. RPM is
            already on the DRO, so it is not duplicated here. The
             up-to-speed/ramping words are SPEED STATE, not a measurement, so
             they stay outside the three-value span; no speed gate or driver
             behavior changes. The row wraps (the WO-184 Position pattern):
             the three measurements own the first line and never squeeze, and
             the speed word reads below them when the 280px rail has no room
             beside them - the caption-caused wrap of the measurements is gone. */}
        {telemetry !== null && (
        <div
          className="control-live-row control-spindle-telemetry"
          data-testid="control-spindle-telemetry"
          style={{ flexWrap: 'wrap', rowGap: 2 }}
        >
          <span data-testid="control-spindle-telemetry-values" style={{ flex: '1 0 auto' }}>

            {telemetry.volts === null ? '-- V' : `${telemetry.volts.toFixed(0)} V`}
            {' | '}
            {telemetry.amps === null ? '-- A' : `${telemetry.amps.toFixed(1)} A`}
            {' | '}
            {telemetry.torque === null ? 'torque --' : `torque ${telemetry.torque}`}
          </span>
          {telemetry.upToSpeed === null ? null : (
            <span data-testid="control-spindle-up-to-speed">
              {telemetry.upToSpeed ? 'up to speed' : 'ramping'}
            </span>
          )}
        </div>
        )}
        {/* WO-965: no buttons, no group. WO-1648: and no label row over
            them either - Operator: "that coolant line that has nothing else on it
            could potentially be removed and just leave the buttons for
            coolant and mist." The panel title and the buttons' own words
            already say what they are, and the row was pushing the macros
            below the fold. */}
        {showAccessories && (
          <>
            <div
              className="control-spindle-btns"
              data-coolant-mode={activeAccessories.join('+') || 'off'}
            >
              {showChannel('mist') && (
                <button
                  // Lit by the SAME source the press reads (WO-965). A button
                  // that stops on the next press while showing itself as off is
                  // the WO-474 defect wearing the other face.
                  className={`control-spindle-btn ${running('mist') ? 'control-latched' : ''}`}
                  data-testid="control-coolant-mist"
                  disabled={accessoryDisabled}
                  data-tooltip={coolantTip('coolantMist', 'Mist on')}
                  onClick={() => pressCoolant('mist', 'coolantMist')}
                >
                  <Droplets size={13} /> Mist
                </button>
              )}
              {showChannel('flood') && (
                <button
                  className={`control-spindle-btn ${running('flood') ? 'control-latched' : ''}`}
                  data-testid="control-coolant-flood"
                  disabled={accessoryDisabled}
                  data-tooltip={coolantTip('coolantFlood', 'Flood on')}
                  onClick={() => pressCoolant('flood', 'coolantFlood')}
                >
                  <Droplets size={13} /> Flood
                </button>
              )}
              {showVacuum && (
                <button
                  className={`control-spindle-btn ${vacuumRunning ? 'control-latched' : ''}`}
                  data-testid="control-vacuum"
                  data-vacuum-code={vacuum?.onCode}
                  disabled={accessoryDisabled}
                  data-tooltip={vacuum
                    ? `Vacuum on (${vacuum.onCode}); press again for ${vacuumOutput?.offCode ?? 'M9'} off`
                    : 'Vacuum is running; press for M9 off'}
                  onClick={pressVacuum}
                >
                  <Fan size={13} /> Vacuum
                </button>
              )}
              {listedButtons.map((output) => (
                <button
                  key={output.onCode}
                  className={`control-spindle-btn ${listedRunning[output.onCode] === true ? 'control-latched' : ''}`}
                  data-testid={`control-output-${output.onCode}`}
                  disabled={accessoryDisabled}
                  data-tooltip={`${output.name} on (${output.onCode}); press again for `
                    + `${output.offCode ?? 'M9'} off`}
                  onClick={() => pressListedOutput(output)}
                >
                  <Fan size={13} /> {output.name}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
      )}
    </section>
  )
}
