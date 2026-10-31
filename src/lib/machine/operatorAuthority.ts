/**
 * WO-1992: ONE AUTHORITY TABLE FOR OPERATOR COMMANDS.
 *
 * Every Control-tab command's enabled state, and the sentence it shows when it
 * refuses, is decided HERE. The panels read `authorize(command, facts)`; they
 * no longer carry their own `connected && !estopLatched && ...` expressions.
 * One page answers "what does jogging require, and what does it say when it
 * refuses" (research 2026-09-10, LinuxCNC suite review, item 2).
 *
 * Three layers:
 *  - REQUIREMENTS: a named predicate over the facts, and its default refusal
 *    sentence (null = the control keeps its own label when this fails).
 *  - GATES: per command, an ORDERED list of requirements. A step may replace
 *    the requirement's sentence with the command's own wording (null = quiet).
 *  - The verdict: allowed when every step holds; the refusal is the sentence
 *    of the FIRST failing step that has one. Step order is therefore the
 *    tooltip's precedence, and is part of the contract.
 *
 * CYCLE START's own verdict stays in operatorTransport.ts (deriveOperatorTransport):
 * it is one fail-closed decision over program state and it arrives here as the
 * `cycleStartEnabled` fact. Nothing in this table opens a door that verdict,
 * or the session's own refusals, keep shut.
 *
 * FAIL-CLOSED: every fact but `connected` is optional, and a requirement that
 * reads one it was not given does NOT hold. A panel that forgets a fact shows
 * a disabled control, never a live one.
 */
import type { MachineJobState } from '../../store/machineControlStore'
import type { MachineState } from './types'

// A LEAF MODULE: nothing here imports machineSession (which re-exports the
// three sentences below under their original names), so a panel that reads
// the table never drags the session in - and a test that mocks the session
// whole still renders the panel.

/** The plain-language refusal for every machine-MOVING function gated behind
 *  the E-STOP latch (Goto XY0, Safe-Z, macros, probe touches/cycles, park,
 *  the material-fit trace). Same sentence ControlTransportBar's Cycle
 *  Start/Step gate uses, so "the E-STOP is why this refused" reads
 *  identically everywhere it can appear. */
export const ESTOP_BLOCKS_MOTION = 'The software stop is latched. Press CLEAR to reset it.'

/** WO-3087: the top line while an E-STOP has actually tripped - the state
 *  chip beside it says E-STOP, so the line names the same thing. The
 *  connect-time latch keeps ESTOP_BLOCKS_MOTION: nothing was pressed then. */
export const ESTOP_TRIPPED_LINE = 'E-STOP is on. Press CLEAR to reset it.'

/** WO-1042: one offset write per machine may be in flight. */
export const WORK_OFFSET_WRITE_BUSY =
  'work offset: waiting for the bridge to confirm the previous change'

/**
 * The one sentence for "this control needs a machine datum and this machine
 * has none". `what` names the clause that needed the datum.
 *
 * ONE WORDING, THREE SURFACES - the session's safe-Z gate, the Safe Z tooltip
 * in `JogPanel`, and the machine-column goto refusal in `ControlPage`. Written
 * once so the three cannot drift into three different explanations of the
 * same fact. It never contains "home the machine first": there is nothing to
 * home with, and a refusal naming the wrong cause is worse than no refusal.
 */
export function noHomeSwitchesRefusal(what: string): string {
  return 'This machine has no home switches, so it has no machine datum and '
    + `nothing to home - ${what}`
}

/** What the re-arm control says while it is flushing the controller (WO-087).
 *  Named so the label the operator reads and the tests are one string. */
export const RE_ARM_RESETTING = 'Resetting controller...'

export interface OperatorAuthorityFacts {
  connected: boolean
  machineState?: MachineState
  jobPhase?: MachineJobState['phase']
  /** The software E-STOP latch (machineSession.estopNeedsReset). */
  estopLatched?: boolean
  homed?: boolean
  /** WO-985: this machine cannot establish a datum by homing. Wording only. */
  noHomeSwitches?: boolean
  softLimitLatched?: boolean
  /** WO-1330: a tool-change hold lends jog; it does not lend homing. */
  toolChangeHold?: boolean
  /** WO-2437 fix round 4: a program's clamp pause, parked and waiting
   *  (machineSession.programClampPauseTakesMdi). MDI works there; only the
   *  MDI box's caller (ControlPage) states it, so no other row opens. */
  clampPauseHold?: boolean
  homingInFlight?: boolean
  /** The bridge-presence refusal JogPanel derives, or null when the bridge is reachable. */
  bridgeJogRefusal?: string | null
  /** This machine's definition states a safe Z. */
  safeZSet?: boolean
  singleBlock?: boolean
  steppingBack?: boolean
  reArming?: boolean
  ackedSourceLine?: number
  /** deriveOperatorTransport's verdict. */
  cycleStartEnabled?: boolean
  /** deriveReArm's verdict. */
  reArmEnabled?: boolean
  /** The spindle has a route on this controller (spindleRoute() !== 'unsupported'). */
  spindleRouted?: boolean
  /** The inverter link reported down (WO-475). */
  spindleLinkDown?: boolean
  offsetWriteBusy?: boolean
  mdiLine?: string
  /** WO-2138: a probe routine holds the probe lock (machineSession.isProbeCycleActive),
   *  its short gaps between moves included. */
  probeRoutineRunning?: boolean
  /** WO-2237: the session's verdict (machineSession.pausedProgramTakesCommands)
   *  that the pause standing now takes an operator command as a kept stop.
   *  False in a hold another flow owns (clamp card, probe, Step Back, fit
   *  trace, a boundary macro) and in a pause the session cannot keep. */
  pauseTakesCommands?: boolean
}

type Sentence = string | null | ((facts: OperatorAuthorityFacts) => string | null)

interface Requirement {
  holds: (facts: OperatorAuthorityFacts) => boolean
  sentence: Sentence
}

const programRunning = (f: OperatorAuthorityFacts) => f.jobPhase === 'streaming' || f.jobPhase === 'paused'
const programKnownIdle = (f: OperatorAuthorityFacts) => f.jobPhase !== undefined && !programRunning(f)
/** WO-2237 (Operator ruling 2026-09-29, card Q-JOG-MDI-DURING-A-PAUSE-PICK-ONE: "1 - kept
 *  stop, return to the pause point"): a program standing still in a pause.
 *  Jog, Safe Z, MDI, the spindle and the outputs work there exactly as with no
 *  program; the first of them turns the pause into a kept stop at that point
 *  (machineSession) and CYCLE START goes back to it. */
const programPausedAtRest = (f: OperatorAuthorityFacts) =>
  programRunning(f) && f.machineState === 'hold' && f.toolChangeHold !== true && f.pauseTakesCommands !== false
const programNotRunningOrPaused = (f: OperatorAuthorityFacts) => programKnownIdle(f) || programPausedAtRest(f)

const FEED_HOLD_UNAVAILABLE = 'Feed Hold is available while the machine is moving or running a program'

export const REQUIREMENTS = {
  connected: { holds: (f) => f.connected, sentence: null },
  /** CYCLE START and the Step row: the latch refuses even before a connection. */
  estopClear: { holds: (f) => f.estopLatched === false, sentence: ESTOP_BLOCKS_MOTION },
  /** Motion panels: disconnected, `connected` refuses instead and the
   *  control keeps its own label (Operator 2026-09-14, "A: Flash, all motion off"). */
  estopClearWhileConnected: { holds: (f) => !f.connected || f.estopLatched === false, sentence: ESTOP_BLOCKS_MOTION },
  idle: { holds: (f) => f.machineState === 'idle', sentence: null },
  /** WO-2237: or a program paused at rest - the jog becomes its kept stop. */
  idleOrJog: {
    holds: (f) => f.machineState === 'idle' || f.machineState === 'jog' || programPausedAtRest(f),
    sentence: null,
  },
  idleOrHold: { holds: (f) => f.machineState === 'idle' || f.machineState === 'hold', sentence: null },
  notHeldOrAlarmed: {
    holds: (f) => f.machineState !== undefined && f.machineState !== 'hold' && f.machineState !== 'alarm',
    sentence: null,
  },
  /** WO-2138: a running probe routine counts as moving for its whole length -
   *  the gaps between its moves are part of it, and a hold pressed in one
   *  pauses the routine before its next move. */
  moving: {
    holds: (f) => f.jobPhase === 'streaming' || f.machineState === 'run' || f.machineState === 'jog'
      || f.probeRoutineRunning === true,
    sentence: null,
  },
  /** WO-2237: MDI, the spindle and the outputs also work in a pause.
   *  WO-2437 fix round 4: and at a parked clamp pause its caller states. */
  programNotRunning: {
    holds: (f) => programNotRunningOrPaused(f) || (programRunning(f) && f.clampPauseHold === true),
    sentence: null,
  },
  /** WO-1330: a running program disables jog, except at a tool-change hold.
   *  WO-2237: and a pause at rest, which the jog turns into a kept stop. */
  programNotRunningUnlessToolChangeHold: {
    holds: (f) => programNotRunningOrPaused(f) || (programRunning(f) && f.toolChangeHold === true),
    sentence: 'A program is running - jogging is locked out.',
  },
  noToolChangeHold: { holds: (f) => f.toolChangeHold === false, sentence: null },
  notHomingInFlight: { holds: (f) => f.homingInFlight === false, sentence: null },
  bridgeReachable: {
    holds: (f) => f.bridgeJogRefusal === null,
    sentence: (f) => f.bridgeJogRefusal ?? null,
  },
  /** Disconnected, `connected` refuses; the datum question is not asked. */
  homedWhileConnected: { holds: (f) => !f.connected || f.homed === true, sentence: null },
  somethingToUnlock: {
    holds: (f) => f.softLimitLatched === true
      || f.machineState === 'alarm'
      || (f.homed === false && f.machineState === 'idle'),
    sentence: null,
  },
  safeZSet: { holds: (f) => f.safeZSet === true, sentence: null },
  singleBlockOn: { holds: (f) => f.singleBlock === true, sentence: null },
  notSteppingBack: { holds: (f) => f.steppingBack === false, sentence: null },
  notReArming: { holds: (f) => f.reArming === false, sentence: RE_ARM_RESETTING },
  completedLine: { holds: (f) => (f.ackedSourceLine ?? 0) > 0, sentence: null },
  cycleStartVerdict: { holds: (f) => f.cycleStartEnabled === true, sentence: null },
  reArmVerdict: { holds: (f) => f.reArmEnabled === true, sentence: null },
  spindleRouted: { holds: (f) => f.spindleRouted === true, sentence: null },
  spindleLinkUp: {
    holds: (f) => f.spindleLinkDown === false,
    sentence: 'the inverter is not answering, so it cannot be started',
  },
  offsetWriteIdle: { holds: (f) => f.offsetWriteBusy === false, sentence: WORK_OFFSET_WRITE_BUSY },
  mdiLineTyped: { holds: (f) => (f.mdiLine ?? '').trim() !== '', sentence: null },
} satisfies Record<string, Requirement>

export type RequirementId = keyof typeof REQUIREMENTS

/** A requirement, or a requirement as this command words it. */
type GateStep = RequirementId | {
  need: RequirementId
  /** This command's own sentence for the requirement (null = quiet). */
  says?: Sentence
  /** A refusal the control keeps pressable so its handler can SAY it: a
   *  native disabled button receives no pointer event (WO-1131's silent jog). */
  pressable?: true
}

const safeZHomeSentence: Sentence = (f) => f.noHomeSwitches
  ? noHomeSwitchesRefusal('safe Z is a machine coordinate.')
  : 'Home the machine first - safe Z is a machine coordinate'

/** Command -> gate. Step order is tooltip precedence. */
export const OPERATOR_GATES = {
  estop: ['connected'],
  cycleStart: [
    'estopClear',
    { need: 'notSteppingBack', says: 'Step Back is stopping cleanly and re-arming.' },
    'cycleStartVerdict',
  ],
  feedHold: [
    { need: 'connected', says: 'Connect to the machine to use Feed Hold' },
    { need: 'notHeldOrAlarmed', says: FEED_HOLD_UNAVAILABLE },
    { need: 'moving', says: FEED_HOLD_UNAVAILABLE },
  ],
  /** The send itself (keyboard/pendant included) accepts a hold whenever the
   *  machine is not already held or alarmed; only the button waits for motion. */
  feedHoldSend: ['connected', 'notHeldOrAlarmed'],
  stopReset: ['connected'],
  reArm: ['notReArming', 'reArmVerdict', 'notSteppingBack'],
  singleBlock: [
    { need: 'connected', says: 'Connect to the machine to change Single Block' },
    { need: 'notSteppingBack', says: 'Step Back is stopping cleanly - Single Block returns when it finishes.' },
  ],
  /** The one-strip 'row' mount's Single Block (ControlTransportBar sections='row'). */
  singleBlockInline: ['notSteppingBack'],
  stepBack: [
    { need: 'notSteppingBack', says: 'Stopping cleanly and planning the previous line...' },
    { need: 'connected', says: 'Connect to the machine before stepping back' },
    'estopClear',
    { need: 'singleBlockOn', says: 'Turn Single Block on before stepping back' },
    { need: 'completedLine', says: 'There is no completed program line to step back from' },
    { need: 'idleOrHold', says: 'Feed Hold and wait for Hold before stepping back' },
  ],
  stepForward: [
    'estopClear',
    { need: 'singleBlockOn', says: 'Turn Single Block on to step one line at a time' },
    'notSteppingBack',
    'cycleStartVerdict',
  ],
  jog: [
    { need: 'bridgeReachable', pressable: true },
    'estopClearWhileConnected',
    'programNotRunningUnlessToolChangeHold',
    'connected',
    'idleOrJog',
  ],
  /** WO-1330 (audit): the tool-change hold lends jog, never homing. */
  home: [
    'estopClearWhileConnected',
    {
      need: 'noToolChangeHold',
      says: 'A tool change is holding the program - homing is locked out. '
        + 'Jog and the new Z zero are what this hold allows.',
    },
    'connected',
    'notHomingInFlight',
  ],
  /** Safe Z is a jog to a machine coordinate: the jog gate plus a datum and a safe Z. */
  safeZ: [
    'estopClearWhileConnected',
    { need: 'safeZSet', says: "Set this machine's Safe Z on the Machine tab of its definition first." },
    { need: 'homedWhileConnected', says: safeZHomeSentence },
    { need: 'bridgeReachable', says: null },
    'connected',
    { need: 'programNotRunningUnlessToolChangeHold', says: null },
    'idleOrJog',
  ],
  /** WO-328 names Unlock with jog: the E-STOP is reset before anything else. */
  unlock: ['estopClearWhileConnected', 'connected', 'somethingToUnlock'],
  gotoWorkXY0: ['estopClearWhileConnected', 'connected', 'idle'],
  /** Zeroing is not motion: the E-STOP latch does not refuse it. */
  zeroWorkAxis: ['offsetWriteIdle', 'connected', 'idle'],
  mdiInput: ['connected', 'programNotRunning'],
  mdiSend: ['connected', 'programNotRunning', 'mdiLineTyped'],
  spindleStart: ['spindleLinkUp', 'connected', 'programNotRunning', 'spindleRouted'],
  /** WO-964: a stop is never gated on having a route. */
  spindleStop: ['connected', 'programNotRunning'],
  /** Coolant, vacuum and the definition's outputs. */
  accessory: ['connected', 'programNotRunning'],
  override: ['connected'],
  toolGlance: ['connected'],
} as const satisfies Record<string, readonly GateStep[]>

export type OperatorCommand = keyof typeof OPERATOR_GATES

export interface OperatorAuthority {
  allowed: boolean
  /** Render the control disabled. False while refused only by a pressable
   *  requirement, whose handler speaks the refusal itself. */
  disabled: boolean
  /** The first failing step's sentence; null when allowed or refused quietly. */
  refusal: string | null
  /** The first failing requirement, or null when allowed. */
  refusedBy: RequirementId | null
}

function speak(sentence: Sentence, facts: OperatorAuthorityFacts): string | null {
  return typeof sentence === 'function' ? sentence(facts) : sentence
}

export function authorize(command: OperatorCommand, facts: OperatorAuthorityFacts): OperatorAuthority {
  let refusal: string | null = null
  let refusedBy: RequirementId | null = null
  let pressable = false
  for (const step of OPERATOR_GATES[command] as readonly GateStep[]) {
    const { need, says, pressable: keepsPressable } = typeof step === 'string'
      ? { need: step, says: undefined, pressable: undefined }
      : step
    const requirement: Requirement = REQUIREMENTS[need]
    if (requirement.holds(facts)) continue
    refusedBy ??= need
    if (keepsPressable) pressable = true
    if (refusal === null) refusal = speak(says === undefined ? requirement.sentence : says, facts)
  }
  const allowed = refusedBy === null
  return { allowed, disabled: !allowed && !pressable, refusal, refusedBy }
}
