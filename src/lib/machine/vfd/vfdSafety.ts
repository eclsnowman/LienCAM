// WO-425 - the safety rules of the VFD link, as pure functions so they can be
// tested without a spindle.
//
// Three rules, in order of who wins:
//
//   1. NOTHING MAY BLOCK A STOP. Not an unverified definition, not a disabled
//      link, not a broken definition, not a lost port. `vfdStopIsAllowed` is a
//      function that returns true and takes no arguments, and that is the whole
//      point of it: there is no state in which it can say no.
//   2. The spindle stops when anything goes wrong: the serial link being quiet
//      past its wall-clock budget, the bridge socket going away, LienCAM
//      disconnecting, or the link being switched off while it spins.
//   3. `verified: false` gates SPINDLE-ON, and only spindle-on.
//
// Ours is the second layer, never the only one. Operator's inverter is set with
// `PC.05 = 0` so it raises its own communication-loss alarm; that stays, and
// the verification flow proves it trips before anything here is relied on.

import { validateVfdDefinition, type VfdCommand, type VfdDefinition } from './vfdDefinition'

/** The link is OFF until somebody switches it on. Shipping default, not a hint. */
export const VFD_LINK_DEFAULT_ENABLED = false

export interface VfdLinkSettings {
  enabled: boolean
  /** The id of the definition in use, or null when none is chosen. */
  definitionId: string | null
}

export const VFD_LINK_DEFAULT_SETTINGS: VfdLinkSettings = {
  enabled: VFD_LINK_DEFAULT_ENABLED,
  definitionId: null,
}

export interface VfdLinkState {
  /** The operator switched the link on. */
  enabled: boolean
  /** The port is open and the last transaction was answered. */
  connected: boolean
  /**
   * Wall-clock time since the last successful VFD transaction, or null until
   * this client has observed one. This is deliberately not a poll count:
   * retryCount and poll cadence are transport tuning, never safety tuning.
   */
  timeSinceLastSuccessMs: number | null
  /** The bridge process's socket is up. */
  bridgeConnected: boolean
  /** LienCAM is still attached to the bridge. */
  clientConnected: boolean
  /** The inverter's fault register says faulted. */
  faulted: boolean
}

export const VFD_LINK_STATE_DOWN: VfdLinkState = {
  enabled: false,
  connected: false,
  timeSinceLastSuccessMs: null,
  bridgeConnected: false,
  clientConnected: false,
  faulted: false,
}

// --- the stop path -----------------------------------------------------------

export type VfdStopReason =
  | 'serial-timeout'
  | 'bridge-socket-lost'
  | 'client-disconnected'
  | 'link-switched-off'

export type VfdStopDecision =
  | { stop: false }
  | { stop: true; reason: VfdStopReason; sentence: string }

/** A link failure is actionable as a spindle safety stop only while this app
 * has a live spindle command to protect. The controller and the bridge-stop
 * narration share this gate so neither can claim it stopped an idle spindle. */
export function spindleSafetyStopIsActionable(commandedRunning: boolean): boolean {
  return commandedRunning
}

/**
 * A stop is ALWAYS allowed. No gate in this series may block a stop, so this
 * takes no state: there is nothing that could make the answer no.
 */
export function vfdStopIsAllowed(): true {
  return true
}

/**
 * Whether the spindle must be stopped right now, whatever anybody asked for.
 * Checked every poll pass by the bridge and every status frame by LienCAM.
 */
/**
 * How long a running spindle may go with NO answer from the inverter before it
 * is stopped. A wall-clock budget, because time is what actually means "the
 * link is gone" - and unlike a transaction count it does not move when
 * somebody tunes the serial port.
 *
 * Matches the bridge's `LinkQuietStopMs` (Vfd.cs, defect 11, commit 2e854b77),
 * which is the C# half of this same rule. The two halves must agree about when
 * a spindle stops; they did not, and the C# half was the correct one.
 */
export const VFD_LINK_QUIET_STOP_MS = 1000

/**
 * This rule has no VFD definition argument. The definition's retry count,
 * timeout, and poll interval cannot influence its threshold.
 */
export function vfdStopRequired(state: VfdLinkState): VfdStopDecision {
  if (!state.clientConnected) {
    return {
      stop: true,
      reason: 'client-disconnected',
      sentence: 'LienCAM is no longer connected, so the spindle is being stopped.',
    }
  }
  if (!state.bridgeConnected) {
    return {
      stop: true,
      reason: 'bridge-socket-lost',
      sentence: 'The link to the machine bridge went away, so the spindle is being stopped.',
    }
  }
  if (!state.enabled) {
    return {
      stop: true,
      reason: 'link-switched-off',
      sentence: 'The spindle link is unavailable, so a spindle stop is being requested.',
    }
  }
  // Match Vfd.cs exactly: a full 1000 ms is still inside the budget; the stop
  // starts strictly after it. This is elapsed wall-clock time only.
  if (state.timeSinceLastSuccessMs !== null && state.timeSinceLastSuccessMs > VFD_LINK_QUIET_STOP_MS) {
    return {
      stop: true,
      reason: 'serial-timeout',
      sentence: 'The inverter stopped answering for too long, so the spindle is being stopped.',
    }
  }
  return { stop: false }
}

// --- the spindle-on gate -----------------------------------------------------

export type VfdGateRefusal =
  | 'no-definition'
  | 'definition-invalid'
  | 'unverified'
  | 'link-disabled'
  | 'not-connected'
  | 'faulted'
  | 'command-missing'

export type VfdGateDecision =
  | { allowed: true }
  | { allowed: false; refusal: VfdGateRefusal; sentence: string }

const STARTS_THE_SPINDLE: readonly VfdCommand[] = ['runCw', 'runCcw']

/**
 * May this command be sent? `stop` is allowed unconditionally - including with
 * no definition at all, which is the case the rule exists for. Everything that
 * could START the spindle passes every gate; `resetFault` and `releaseReset`
 * pass the link gates but not the verified gate, because clearing a fault does
 * not spin anything.
 */
export function vfdCommandGate(
  command: VfdCommand,
  state: VfdLinkState,
  definition: VfdDefinition | null,
): VfdGateDecision {
  if (command === 'stop') return { allowed: true }

  if (!state.enabled) {
    return {
      allowed: false,
      refusal: 'link-disabled',
      sentence: 'The spindle link is not configured for this session, so the command was not sent.',
    }
  }
  if (!definition) {
    return {
      allowed: false,
      refusal: 'no-definition',
      sentence: 'No inverter has been set up, so there is nothing to send the command to.',
    }
  }
  const validation = validateVfdDefinition(definition)
  if (!validation.ok) {
    return {
      allowed: false,
      refusal: 'definition-invalid',
      sentence: `The inverter setup has ${validation.errors.length} problem${validation.errors.length === 1 ? '' : 's'} and cannot be used until they are fixed.`,
    }
  }
  if (!state.connected) {
    return {
      allowed: false,
      refusal: 'not-connected',
      sentence: 'The inverter is not answering, so the spindle cannot be started.',
    }
  }
  if (STARTS_THE_SPINDLE.includes(command)) {
    if (!definition.verified) {
      return {
        allowed: false,
        refusal: 'unverified',
        sentence: `The setup for '${definition.name}' has not been checked against the inverter yet, so the spindle cannot be started. Run the spindle check first.`,
      }
    }
    if (state.faulted) {
      return {
        allowed: false,
        refusal: 'faulted',
        sentence: 'The inverter is reporting a fault. Clear the fault before starting the spindle.',
      }
    }
  }
  return { allowed: true }
}

/** Shorthand for the one question the Control page asks. */
export function vfdSpindleOnAllowed(state: VfdLinkState, definition: VfdDefinition | null): VfdGateDecision {
  return vfdCommandGate('runCw', state, definition)
}
