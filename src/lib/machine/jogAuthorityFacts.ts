import { textFor } from '../../i18n'
import { bridgePresence, useMachineControl, type MachineControlState } from '../../store/machineControlStore'
import { useMachineActions } from '../../store/machineActionsStore'
import { machineHasNoHomeSwitches, type MachineConfig } from '../../types'
import { bridgeHostCapability } from './bridgeHost'
import { controllerSurface } from './controllerSurface'
import { machineSafeZValue } from './machineActions'
import {
  estopNeedsReset,
  pausedProgramTakesCommands,
  softLimitLatchActive,
  toolChangeHoldActive,
} from './machineSession'
import type { OperatorAuthorityFacts } from './operatorAuthority'

const controlText = textFor('control-screens-not-probing')

// WO-3259: THE JOG PANEL'S FACTS, IN ONE PLACE.
//
// Extracted unchanged from JogPanel (WO-1992's authority facts and the
// bridge-presence refusal beside them) so a second jog input - the gamepad
// (useControlGamepadJog) - asks `authorize('jog', ...)` exactly the question
// the pointer jog asks, with the same answers. JogPanel still subscribes to
// every fact it renders from; it only hands them here to be assembled.
//
// pauseTakesCommands is REQUIRED, never defaulted: the authority table reads
// an absent value as "the pause takes commands" (`!== false`), so a caller that
// forgot it would open jog in a hold another flow owns.

export type SelectedConnectionKind = 'serial' | 'simulator' | 'bridge' | 'gateway'

export interface JogAuthorityInputs {
  connectionPhase: MachineControlState['connectionPhase']
  connectionKind: MachineControlState['connectionKind']
  connectionDetail: MachineControlState['connectionDetail']
  bridgeControllerPresence: MachineControlState['bridgeControllerPresence']
  bridgeProcessPresence: MachineControlState['bridgeProcessPresence']
  selectedConnectionKind?: SelectedConnectionKind
  machineState: MachineControlState['machineState']
  jobPhase: MachineControlState['job']['phase']
  homed: MachineControlState['homed']
  machine: MachineConfig
  safeZ: number | null
  estopLatched: boolean
  softLimitLatched: boolean
  toolChangeHold: boolean
  pauseTakesCommands: boolean
  homingInFlight: boolean
}

/** The bridge-presence refusal the Jog panel speaks on a press, or null. */
export function jogBridgeRefusal(
  inputs: Pick<JogAuthorityInputs,
    | 'connectionPhase' | 'connectionKind' | 'connectionDetail' | 'bridgeControllerPresence'
    | 'bridgeProcessPresence' | 'selectedConnectionKind' | 'machine'>,
): string | null {
  const presence = bridgePresence(inputs)
  const selectedTransport = inputs.connectionKind ?? inputs.selectedConnectionKind
  const hasBridgeSurface = controllerSurface(inputs.machine).bridgeSettings
    && selectedTransport === 'bridge'
  const canOwnBridge = bridgeHostCapability() !== 'unhosted'
  const bridgeIncidentObserved = inputs.connectionDetail !== null
    || inputs.bridgeProcessPresence !== 'unknown'
  return !hasBridgeSurface || !bridgeIncidentObserved
    ? null
    : presence.socket === 'closed'
      ? canOwnBridge
        ? controlText('JogPanel.text004')
        : controlText('JogPanel.text005')
      : canOwnBridge && (presence.process === 'stopped' || presence.process === 'gave-up')
        ? controlText('JogPanel.text006')
        : null
}

/** WO-1992: every gate on the Jog panel is a row of the operator authority
 *  table; these are the facts it is asked with. */
export function jogAuthorityFacts(inputs: JogAuthorityInputs): OperatorAuthorityFacts {
  return {
    connected: inputs.connectionPhase === 'connected',
    machineState: inputs.machineState,
    jobPhase: inputs.jobPhase,
    estopLatched: inputs.estopLatched,
    homed: inputs.homed,
    noHomeSwitches: machineHasNoHomeSwitches(inputs.machine),
    softLimitLatched: inputs.softLimitLatched,
    toolChangeHold: inputs.toolChangeHold,
    pauseTakesCommands: inputs.pauseTakesCommands,
    homingInFlight: inputs.homingInFlight,
    bridgeJogRefusal: jogBridgeRefusal(inputs),
    safeZSet: inputs.safeZ !== null,
  }
}

/** The same facts read now from the stores and the session, for an input that
 *  is not a rendered panel. `pauseTakesCommands` is passed explicitly; so is the
 *  Control machine (and the park carrier its safe Z is read from), which the
 *  caller resolves from the project store exactly as JogPanel does. */
export function currentJogAuthorityFacts(options: {
  pauseTakesCommands: boolean
  machine: MachineConfig
  parkMachine: MachineConfig
  homingInFlight?: boolean
  selectedConnectionKind?: SelectedConnectionKind
}): OperatorAuthorityFacts {
  const mc = useMachineControl.getState()
  const machine = options.machine
  const storedActions = useMachineActions.getState().byMachine[machine.id ?? 'default']
  return jogAuthorityFacts({
    connectionPhase: mc.connectionPhase,
    connectionKind: mc.connectionKind,
    connectionDetail: mc.connectionDetail,
    bridgeControllerPresence: mc.bridgeControllerPresence,
    bridgeProcessPresence: mc.bridgeProcessPresence,
    selectedConnectionKind: options.selectedConnectionKind,
    machineState: mc.machineState,
    jobPhase: mc.job.phase,
    homed: mc.homed,
    machine,
    safeZ: machineSafeZValue(options.parkMachine, storedActions),
    estopLatched: estopNeedsReset(),
    softLimitLatched: softLimitLatchActive(),
    toolChangeHold: toolChangeHoldActive(),
    pauseTakesCommands: options.pauseTakesCommands,
    homingInFlight: options.homingInFlight ?? mc.machineState === 'home',
  })
}

/** The session's own verdict, for callers with no subscription of their own. */
export function currentPauseTakesCommands(): boolean {
  return pausedProgramTakesCommands()
}
