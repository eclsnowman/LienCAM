import type {
  FitTraceState,
  MachineControlState,
  MachineJobState,
  MachineProgramFit,
  MachineProgramReadiness,
  ToolChangeState,
} from '../../store/machineControlStore'
import { useMachineControl } from '../../store/machineControlStore'
import {
  activeMachineHasNoHomeSwitches,
  armLoadedProgramFromLine1,
  estopNeedsReset,
  getMachineController,
  guidedToolMeasureState,
  isProbeCyclePaused,
  loadedFileArmableFromLine1,
  loadedFileFitRefusal,
  loadedFileRefusedAtLoad,
  operatorChosenStartLost,
  pausedProgramReadout,
  nonProgramActionStatus,
  standaloneMdiJob,
  programHoldCycleStartDecision,
  programM0HoldLine,
  programPartsTransportState,
  textM6WasAnswered,
  textProgramHoldLine,
  loadedProgramText,
  RE_ARM_REFUSAL,
  startMachineJob,
  startMaterialFitTrace,
  stepBackInProgress,
} from './machineSession'
import type { MachineState } from './types'
import { authorize, ESTOP_BLOCKS_MOTION } from './operatorAuthority'
import { tokenizeLine } from '../gcode'

export type OperatorCycleAction = 'trace' | 'single-block' | 'resume' | 'start' | 'arm-start' | 'none'

export interface OperatorTransportInput {
  connectionPhase: MachineControlState['connectionPhase']
  machineState: MachineState
  /** A work-coordinate move has no physical destination until this session has a datum. */
  homed: boolean
  /** The controller's active work offset, unknown until its modal state arrives. */
  activeWcs: MachineControlState['activeWcs']
  /** WO-985 mode: this machine cannot establish a datum by homing. Absent is not switchless. */
  noHomeSwitches?: boolean
  job: MachineJobState
  programReadiness: MachineProgramReadiness
  /** The fit verdict ProgramPreview actually published in this session. */
  programFit?: MachineProgramFit | null
  singleBlock: boolean
  fitTrace: FitTraceState | null
  toolChange: ToolChangeState | null
  /** Whether there is a program to re-arm at all (WO-082). */
  programText: string | null
  /** Present only while one operator program is between controller-sized parts. */
  programParts?: ReturnType<typeof programPartsTransportState>
  /** The guided measure's miss/retry state (machineSession.guidedToolMeasureState),
   *  so a held M6 names the card button that is actually drawn. */
  guidedMeasure?: { missed: boolean; measured: boolean } | null
  /** Who owns the held program's release, as the session's Cycle Start and
   *  Single Block step decide it (machineSession.programHoldCycleStartDecision). */
  programHold?: ReturnType<typeof programHoldCycleStartDecision>
  /** The listing the session published with the loaded program (the store's
   *  `stagedProgram`). Every toolpath load publishes one; an MDI line staged
   *  through the same door does not (WO-2140). Absent = not told. */
  stagedProgram?: MachineControlState['stagedProgram']
  /** WO-2519: the paused program's readouts while it stands in a kept stop
   *  (machineSession.pausedProgramReadout). Absent = asked of the session. */
  pausedProgram?: ReturnType<typeof pausedProgramReadout>
}

/** The re-arm-from-the-top offer (WO-082). It is a SEPARATE authority from
 * CYCLE START on purpose: arming puts the program back at its first line and
 * moves nothing; CYCLE START stays the only gesture that begins motion. */
export interface OperatorReArmState {
  /** Render the control at all - there is a loaded program it could re-arm. */
  offered: boolean
  enabled: boolean
  label: string
  /** Plain sentence for the control's tooltip; when disabled it says WHY. */
  detail: string
}

export interface OperatorTransportState {
  action: OperatorCycleAction
  cycleStartEnabled: boolean
  nextAction: string
  cycleStartDetail: string
  reArm: OperatorReArmState
}

export interface OperatorProgramProgressInput {
  phase: MachineJobState['phase']
  /** Pause-aware running time. Null when this job has no active run clock. */
  elapsedMs: number | null
  /** The estimate bound to this exact program, else null. */
  estimatedMs: number | null
  completedDistance: number
  totalDistance: number
  completedMoves: number
  totalMoves: number
}

/**
 * The one program-percent decision used by the operator progress row (WO-2040).
 *
 * A running program with its own estimate advances by running time, not by how
 * densely its post happened to tessellate the path. Without that estimate the
 * best controller-independent measure is commanded path distance; a program
 * whose path cannot be measured retains the old acknowledged-move fallback.
 * The active ceiling is 99 because only the controller's terminal phase may
 * claim completion.
 */
export function deriveOperatorProgramPercent(input: OperatorProgramProgressInput): number {
  if (input.totalMoves <= 0) return 0
  if (input.phase === 'complete') return 100

  const active = input.phase === 'streaming' || input.phase === 'paused'
  let fraction: number
  if (
    active
    && input.elapsedMs !== null
    && Number.isFinite(input.elapsedMs)
    && input.estimatedMs !== null
    && Number.isFinite(input.estimatedMs)
    && input.estimatedMs > 0
  ) {
    fraction = input.elapsedMs / input.estimatedMs
  } else if (
    Number.isFinite(input.completedDistance)
    && Number.isFinite(input.totalDistance)
    && input.totalDistance > 0
  ) {
    fraction = input.completedDistance / input.totalDistance
  } else {
    fraction = input.completedMoves / input.totalMoves
  }

  const percent = Math.max(0, Math.min(100, Math.round(fraction * 100)))
  return active ? Math.min(99, percent) : percent
}

/** The label is shared with the next-action sentences below on purpose: a
 * message that names a way out must name the button the operator can see. */
export const RE_ARM_LABEL = 'Re-arm from start'

export const PROGRAM_FIT_REMEDY =
  'Move the work offset onto the table, or check the machine-zero end in the Machine Library.'

/** WO-2686: the next step when the loaded file, read again now, does not fit. */
export const LOADED_FILE_FIT_REMEDY =
  'Correct what it names (work offset, saved point, tool length, machine travel) or load another program; CYCLE START then runs it from line 1.'

/**
 * Whether re-arming from the top is offered, and if not, why (WO-082). Mirrors
 * armProgramFromTop()'s own refusals - it is a render of the same decision,
 * never a second opinion. Being disconnected is NOT a refusal: arming is a
 * local act, exactly like loading the file was.
 */
export function deriveReArm(input: OperatorTransportInput): OperatorReArmState {
  const { programText, machineState, job } = input
  if (!programText) {
    return { offered: false, enabled: false, label: RE_ARM_LABEL, detail: RE_ARM_REFUSAL.noProgram }
  }
  if (machineState === 'alarm') {
    return { offered: true, enabled: false, label: RE_ARM_LABEL, detail: RE_ARM_REFUSAL.alarm }
  }
  if (job.phase === 'streaming' || job.phase === 'paused') {
    return { offered: true, enabled: false, label: RE_ARM_LABEL, detail: RE_ARM_REFUSAL.running }
  }
  return {
    offered: true,
    enabled: true,
    label: RE_ARM_LABEL,
    detail: 'Arm this program again from its first line. Nothing moves until CYCLE START.',
  }
}

/** One fail-closed decision for every path that can put program or trace
 * motion into the controller. ProgramPanel and guided flows only ARM work;
 * this verdict owns the sole CYCLE START gesture. */
export function deriveOperatorTransport(input: OperatorTransportInput): OperatorTransportState {
  const reArm = deriveReArm(input)
  const state = atProgramStop(input, inAKeptStop(input, deriveCycleVerdict(input, reArm)))
  // WO-1186 orders the fresh connection's offer by the facts a coordinate
  // action needs: datum first, then an active work offset. Keep this narrowly
  // scoped to the empty state so a loaded or held program retains its more
  // specific canonical verdict.
  const freshEmptyConnection =
    input.connectionPhase === 'connected'
    && input.machineState === 'idle'
    && input.job.phase === 'empty'
    && input.programText === null
  if (freshEmptyConnection && !input.homed && !input.noHomeSwitches) {
    return {
      ...state,
      nextAction:
        'No machine datum. Press Home All before choosing a work-coordinate action.',
      reArm,
    }
  }
  if (freshEmptyConnection && input.homed && input.activeWcs === null) {
    return { ...state, nextAction: '', reArm }
  }
  return { ...state, reArm }
}

/**
 * WO-2519: IN A KEPT STOP THE LINE SAYS WHERE THE PROGRAM IS PAUSED AND WHAT
 * IS HAPPENING NOW. The stop under it is a re-armed program, an MDI line a
 * program of its own, the return a slice staged from a prelude: their own
 * sentences read "Program checks passed. CYCLE START begins the program.",
 * "The cycle failed." or a plain run (machine session 2026-10-03, F4-F6).
 * Only the readout words change - the action and its gates are the verdict's.
 * A refusal (not connected, an alarm, the door, a hold a flow owns, a program
 * that is not ready at rest) keeps its own sentence, and so does a held return
 * that CYCLE START resumes.
 */
function inAKeptStop(
  input: OperatorTransportInput,
  verdict: Omit<OperatorTransportState, 'reArm'>,
): Omit<OperatorTransportState, 'reArm'> {
  const paused = input.pausedProgram !== undefined ? input.pausedProgram : pausedProgramReadout()
  if (paused === null || input.connectionPhase !== 'connected') return verdict
  if (input.machineState === 'alarm' || input.machineState === 'door') return verdict
  if (input.fitTrace?.step === 'confirm' || input.fitTrace?.step === 'tracing') return verdict
  if (sessionOwnedHold(input) !== null) return verdict
  // While a command or the return runs, a `start` verdict is the board not yet
  // saying "run" (the bridge lifts before its first run frame, desk kit 10-04):
  // "CYCLE START begins the program" is never true then.
  const says = input.job.phase === 'complete' || (paused.doing === 'paused'
    ? verdict.action === 'start'
    : !verdict.cycleStartEnabled || verdict.action === 'start')
  if (!says) return verdict
  // WO-2566: the tooltip names the same pause as the line below the bar,
  // rather than the re-armed program / command / return underneath it.
  const cycleStartDetail = paused.doing === 'paused'
    ? `Go back to where the program paused and carry on from line ${paused.line}.`
    : paused.doing === 'returning'
      ? `The program is returning to line ${paused.line}.`
      : paused.sentence
  return { ...verdict, nextAction: paused.sentence, cycleStartDetail }
}

/**
 * WO-2776: HELD AT THE PROGRAM'S OWN M0, CYCLE START'S TIP NAMES THAT STOP.
 *
 * Board session 2026-10-07 (OWED-CHECKS O13): at the M0 on line 11 the line
 * under the bar named the hold, and the tip over CYCLE START said only "Resume
 * the held program." WO-2566 renamed the tip in a kept stop, whose verdict is
 * `start`; a program held on its M0 is the resume branch's (or Single Block's),
 * so it was never asked. Words only: the action and its gate are the verdict's.
 * A Feed Hold, a tool change (an M6 not yet answered, or a post's commented M0 -
 * WO-2691), a hold a flow or card owns, and a kept stop keep their own tips.
 */
function atProgramStop(
  input: OperatorTransportInput,
  verdict: Omit<OperatorTransportState, 'reArm'>,
): Omit<OperatorTransportState, 'reArm'> {
  if (!verdict.cycleStartEnabled || (verdict.action !== 'resume' && verdict.action !== 'single-block')) return verdict
  if (input.connectionPhase !== 'connected' || input.toolChange) return verdict
  if (sessionOwnedHold(input) !== null || heldAtToolChange(input) !== null) return verdict
  const paused = input.pausedProgram !== undefined ? input.pausedProgram : pausedProgramReadout()
  if (paused !== null) return verdict
  const stop = programStopHeldAt(input)
  if (stop === null) return verdict
  return {
    ...verdict,
    cycleStartDetail: verdict.action === 'resume'
      ? `Carry on from the ${stop.word} on line ${stop.line}.`
      : `Execute exactly one block after the ${stop.word} on line ${stop.line}.`,
  }
}

/** The program's own stop (an M0, or an M1 the session stops at) the job is
 * held on, as the session reads it: the file door's held boundary
 * (`programM0HoldLine`), the text door's held pause line. Null for any other
 * hold. */
function programStopHeldAt(input: OperatorTransportInput): { word: 'M0' | 'M1'; line: number } | null {
  const live = useMachineControl.getState()
  if (input.programParts?.held) {
    // The session's held boundary is the live job's.
    const line = input.job === live.job ? programM0HoldLine() : null
    return line === null ? null : { word: 'M0', line }
  }
  const text = input.programText
  if (text === null) return null
  const line = textProgramHoldLine(text, input.job, input.job === live.job ? live.holdsSeen : 0)
  if (line === null) return null
  const words = tokenizeLine(text.split(/\r?\n/)[line - 1] ?? '', line).words
  const has = (value: number) => words.some((w) => w.letter === 'M' && w.value === value)
  // A same-line M6 holds first as the tool change; answered, the M0 holds.
  if (has(6) && !textM6WasAnswered(line)) return null
  return has(0) ? { word: 'M0', line } : has(1) ? { word: 'M1', line } : null
}

/**
 * A TERMINAL STATE WHERE THE RE-ARM CONTROL IS NOT ON THE SCREEN (WO-1031).
 *
 * The complete/failed sentences below name the re-arm control because WO-082
 * found them naming a way out with no way to take it. A TOOLPATH program
 * (WO-1031's geometry door) re-opened exactly that dead end from the other
 * side: it genuinely has no program TEXT, so `deriveReArm` hides the control
 * (`offered: false`) - and the sentence went on telling the operator to press
 * a button that is not rendered. So these sentences are derived from the SAME
 * verdict that decides whether the control is drawn, and when it is not drawn
 * they name the way out that does exist, or name nothing at all.
 *
 * For a toolpath program that way out is loading the toolpath again. It is
 * deliberately NOT a control name: the geometry door has no operator affordance
 * yet (slice 1d, gated on Operator's UX ruling), and naming one that does not exist
 * is the defect this function exists to prevent.
 *
 * WO-2140 (rehearsal 2026-09-28, bite 9): an MDI line is staged through the
 * same geometry door - its name, no text - so a finished MDI move (or a probe
 * run after one, which leaves the job as the MDI line left it) read "A toolpath
 * program has no re-arm control". That sentence belongs to a toolpath the
 * operator loaded; after an MDI line nothing is loaded to run again.
 */
function terminalWithoutReArm(
  input: OperatorTransportInput,
  opening: string,
): Omit<OperatorTransportState, 'reArm'> {
  // A toolpath program is the one thing that is LOADED with a null text: the
  // geometry door stores its name and no text (machineSession.loadGeometryProgram),
  // while both text loads always store the text they were given.
  const loadedWithoutText = input.programText === null && input.job.name !== null
  const mdi = input.job === useMachineControl.getState().job && standaloneMdiJob()
  const toolpath = loadedWithoutText && !mdi
  const fromLine = toolpath && input.job === useMachineControl.getState().job
    && publishedListing(input) === true && loadedProgramText() !== null
  if (loadedWithoutText && !toolpath) {
    return {
      action: 'none',
      cycleStartEnabled: false,
      nextAction: input.job.phase === 'complete' ? 'Move finished. Ready.' : 'The move failed. See the console.',
      cycleStartDetail: 'No program is armed.',
    }
  }
  return {
    action: 'none',
    cycleStartEnabled: false,
    nextAction: toolpath
      ? fromLine ? `${opening} Choose From line and Plan to run again, or load a program.`
        : `${opening} A toolpath program has no re-arm control - load the toolpath again to run it.`
      : `${opening} Load a checked program to run again.`,
    cycleStartDetail: toolpath
      ? fromLine ? 'Choose From line and Plan to arm the next run.' : 'No program is armed - load the toolpath again.'
      : 'No program is armed.',
  }
}

/** Whether the loaded program came with a published listing (WO-2140). Every
 * toolpath door publishes one (setup, operation, file, parts); the MDI door
 * never does. A caller that does not pass it - the header builds its input
 * field by field - is answered from the store when the input IS the store's
 * current job (same object), else unknown (undefined). */
function publishedListing(input: OperatorTransportInput): boolean | undefined {
  if (input.stagedProgram !== undefined) return input.stagedProgram !== null
  const live = useMachineControl.getState()
  return live.job === input.job ? live.stagedProgram !== null : undefined
}

/**
 * WO-2031: THE SESSION DECIDES WHO OWNS A HELD PROGRAM'S RELEASE; THE HEADER
 * AND CYCLE START SHOW THAT DECISION, NOT A GUESS OF THEIR OWN.
 *
 * `programHold` is machineSession's `programHoldCycleStartDecision()` - the
 * same checks `cycleResume` and `stepJob` make. The header used to say "Cycle
 * Start continues" with CYCLE START lit while the session refused it for the
 * guided M6 (Operator's session 2026-09-26, finding F3).
 * - Guided tool change: the card's Continue is the only door (Operator: one stop
 *   per tool change, resumed by the operator's explicit Continue).
 * - The boundary's macro (an M6 prelude among them): CYCLE START continues it
 *   while it waits at hold(), with or without Single Block (the session
 *   refuses the step); while it moves there is no door.
 * - The clamp card (WO-2773, Operator 2026-10-13 "A - Continue on both"): the
 *   same answer - its Continue is the only door, and CYCLE START is dark with
 *   the same tip, naming its own card.
 * A plain M6 hold with no card (no measured reference tool) has no owner here
 * and is still released by CYCLE START.
 * - A probe routine held by Feed Hold (WO-2103): CYCLE START resumes it.
 */
function sessionOwnedHold(input: OperatorTransportInput): Omit<OperatorTransportState, 'reArm'> | null {
  const { programParts, programHold, toolChange } = input
  if (!programHold) return null
  // WO-2103: Feed Hold inside a probe routine. CYCLE START resumes it,
  // whatever program happens to be loaded behind it.
  if (programHold.owner === 'probe-cycle') {
    return {
      action: 'resume',
      cycleStartEnabled: true,
      // The probing screen cancels and replays its own move (WO-2600),
      // unlike Feed Hold (WO-2103). Name the buttons drawn on that screen.
      nextAction: isProbeCyclePaused()
        ? `${programHold.routine} is paused - Resume on the probing screen resumes it; Stop ends it.`
        : `${programHold.routine} is held - CYCLE START resumes it; Stop/Reset ends it.`,
      cycleStartDetail: 'Resume the held probe routine.',
    }
  }
  // WO-2259: Feed Hold on a guided flow's park move. CYCLE START carries the
  // park on to its position; the card's own steps follow as before.
  if (programHold.owner === 'tool-change-park') {
    return {
      action: 'resume',
      cycleStartEnabled: true,
      nextAction: 'The park is held - CYCLE START carries it on; Stop/Reset stops it.',
      cycleStartDetail: 'Carry the held park on.',
    }
  }
  // WO-2239: the controller waits at an M6 typed in a kept stop. CYCLE START
  // answers it; the next CYCLE START goes back to the stop.
  if (programHold.owner === 'controller-tool-change') {
    const fit = programHold.tool > 0 ? `fit T${programHold.tool}` : 'take the tool out'
    return programHold.canAnswer
      ? {
        action: 'resume',
        cycleStartEnabled: true,
        nextAction: `The controller is waiting at the tool change: ${fit}, then press CYCLE START. The next CYCLE START goes back to the stop.`,
        cycleStartDetail: "Answer the controller's tool change.",
      }
      : {
        action: 'none',
        cycleStartEnabled: false,
        nextAction: `The controller is waiting at the tool change: ${fit} and answer it on the controller. Then CYCLE START goes back to the stop.`,
        cycleStartDetail: "This machine's tool change is answered on the controller, not from here.",
      }
  }
  const part = programParts?.held
    ? `Program held at part ${programParts.completedPart} of ${programParts.totalParts}`
    : 'Program held'
  if (programHold.owner === 'boundary-macro') {
    const held = `${part} - macro "${programHold.macro}"`
    if (programHold.macroWaiting) {
      return {
        action: 'resume',
        cycleStartEnabled: true,
        nextAction: `${held} is waiting - Cycle Start continues it`,
        cycleStartDetail: 'Continue the macro running at this hold.',
      }
    }
    return {
      action: 'none',
      cycleStartEnabled: false,
      nextAction: `${held} is running - let it finish, or Stop it`,
      cycleStartDetail: "This hold's macro is still running.",
    }
  }
  if (programHold.owner === 'clamp-card') {
    const clamp = toolChange?.mode === 'clampPause' ? toolChange : null
    const now = clamp?.step === 'stopping' || clamp?.step === 'parking'
      ? clamp.message || 'parking for the clamp pause'
      : clamp?.step === 'failed'
        ? 'the park did not finish - see the Park + clamp card'
        : 'screw down the material, then press Continue on the Park + clamp card'
    return {
      action: 'none',
      cycleStartEnabled: false,
      nextAction: `${part} - ${now}`,
      cycleStartDetail: 'The Park + clamp card continues this program, not CYCLE START.',
    }
  }
  if (programHold.owner !== 'tool-change-card' && programHold.owner !== 'typed-tool-change') return null
  const card = toolChange?.mode === 'toolChange' ? toolChange : null
  const tool = card?.tool != null ? `T${card.tool}` : 'the next tool'
  // WO-2533: a change typed with no program loaded holds no program - name the typed change.
  const typed = programHold.owner === 'typed-tool-change'
  const held = typed
    ? `${card?.tool != null ? `T${card.tool} t` : 'T'}ool change`
    : `${part} for the ${card?.tool != null ? `T${card.tool} ` : ''}tool change`
  const next: Record<ToolChangeState['step'], string> = {
    stopping: card?.message || 'stopping for the tool change',
    parking: card?.message || 'parking for the tool change',
    'awaiting-swap': input.guidedMeasure?.missed
      ? 'press Retry measure on the tool-change card'
      : `fit ${tool}, then press Continue on the tool-change card`,
    probing: 'measuring the new tool',
    arming: 'finishing the tool change',
    ready: 'press Continue from the M6 on the tool-change card',
    failed: 'the tool change stopped - see the tool-change card',
  }
  return {
    action: 'none',
    cycleStartEnabled: false,
    nextAction: `${held} - ${card ? next[card.step] : `fit ${tool}, then press Continue on the tool-change card`}`,
    cycleStartDetail: typed
      ? 'The tool-change card finishes this tool change, not CYCLE START.'
      : 'The tool-change card continues this program, not CYCLE START.',
  }
}

/**
 * WO-2691: HELD AT THE FILE'S OWN TOOL CHANGE, THE LINE NAMES THE TOOL.
 *
 * A GRBL post has no M6: it writes `( change tool to T2 )` and an `M0`
 * (post/emit.ts emitToolChange, 'pause'). Held there, the line said only
 * "CYCLE START resumes the held program." (journey 10-08, C5). The tool comes
 * from the program's words at the held pause - its own line and the lines just
 * before it, back to the last move: a T word, an M6, or a "change tool" /
 * "tool change" comment. Null for any other hold (a Feed Hold, a plain M0, an
 * M6 already answered, the M0 after an M6 that already held), which keeps its
 * sentence. Words only: the action and
 * its gate are the verdict's own.
 */
function heldAtToolChange(input: OperatorTransportInput): string | null {
  const held = heldToolChange(input)
  return held === null ? null : toolChangeHoldSentence(held.tool)
}

function toolChangeHoldSentence(tool: number | null): string {
  return `Held for a tool change - fit ${tool === null ? 'the next tool' : `T${tool}`}, then press CYCLE START.`
}

/** heldAtToolChange's reading: the hold is the file's own tool change at
 *  source line `line`, and the tool its words name (null when they name none). */
function heldToolChange(input: OperatorTransportInput): { line: number; tool: number | null } | null {
  const text = input.programText
  if (text === null) return null
  const live = useMachineControl.getState()
  const held = textProgramHoldLine(text, input.job, input.job === live.job ? live.holdsSeen : 0)
  if (held === null || textM6WasAnswered(held)) return null
  const lines = text.split(/\r?\n/)
  let change = false
  let tool: number | null = null
  for (let n = held; n >= 1 && n > held - 4; n--) {
    const raw = lines[n - 1] ?? ''
    // The product tokenizer, so compact words (`G1X10`, `M6T2`) read as the controller reads them.
    const words = tokenizeLine(raw, n).words
    const has = (letter: string, values: number[]) => words.some((w) => w.letter === letter && values.includes(w.value))
    // A move, or an earlier stop (it was the hold that named its tool), ends the search.
    if (n < held && (has('G', [0, 1, 2, 3]) || has('M', [0, 1, 6]) || words.some((w) => 'XYZ'.includes(w.letter)))) break
    const said = [...raw.matchAll(/\(([^)]*)\)|;(.*)$/g)].map((m) => m[1] ?? m[2] ?? '')
      .find((comment) => /change\s*tool|tool\s*change/i.test(comment))
    const t = words.find((w) => w.letter === 'T' && Number.isInteger(w.value))?.value
    const word = t !== undefined ? String(t) : (said ? /\bT(\d+)\b/i.exec(said)?.[1] : undefined)
    if (said !== undefined || word !== undefined || has('M', [6])) change = true
    if (tool === null && word !== undefined && Number(word) > 0) tool = Number(word)
  }
  return change ? { line: held, tool } : null
}

function deriveCycleVerdict(
  input: OperatorTransportInput,
  reArm: OperatorReArmState,
): Omit<OperatorTransportState, 'reArm'> {
  const { connectionPhase, machineState, job, programReadiness, singleBlock, fitTrace, toolChange } = input
  const disconnected = connectionPhase !== 'connected'

  if (disconnected) {
    return {
      action: 'none',
      cycleStartEnabled: false,
      nextAction: 'Connect a machine to enable operator controls.',
      cycleStartDetail: 'Machine is not connected.',
    }
  }
  if (machineState === 'alarm') {
    return {
      action: 'none',
      cycleStartEnabled: false,
      nextAction: 'Resolve the alarm and re-home if position was lost.',
      cycleStartDetail: 'CYCLE START is blocked by an alarm.',
    }
  }
  if (machineState === 'door') {
    return {
      action: 'none',
      cycleStartEnabled: false,
      nextAction: 'Close the machine door, then verify the controller is ready.',
      cycleStartDetail: 'CYCLE START is blocked while the door is open.',
    }
  }
  if (fitTrace?.step === 'confirm') {
    const enabled = machineState === 'idle'
    return {
      action: enabled ? 'trace' : 'none',
      cycleStartEnabled: enabled,
      nextAction: enabled
        ? 'Review the material-fit outline, then press CYCLE START.'
        : 'Wait for the machine to become idle before starting the material-fit trace.',
      cycleStartDetail: enabled
        ? 'Start the reviewed material-fit trace.'
        : 'Wait for the machine to become idle before starting the material-fit trace.',
    }
  }
  if (fitTrace?.step === 'tracing') {
    return {
      action: 'none',
      cycleStartEnabled: false,
      nextAction: 'Material-fit trace is running. Feed Hold pauses motion; Stop/Reset abandons it.',
      cycleStartDetail: 'A material-fit trace is already running.',
    }
  }

  // Ahead of the resume branch and both of its words (plain and Single
  // Block): the session's owner of the hold decides both doors.
  const owned = sessionOwnedHold(input)
  if (owned) return owned

  // WO-2560: only an unlisted action may speak here. Loaded files retain
  // their own transport, and alarm/door/fit/owned-hold decisions above win.
  const noProgram = input.programText === null && publishedListing(input) === false
  const actionResult = input.job === useMachineControl.getState().job ? nonProgramActionStatus() : null
  if (noProgram && machineState === 'idle' && actionResult) {
    return { action: 'none', cycleStartEnabled: false, nextAction: actionResult, cycleStartDetail: 'No program is armed.' }
  }

  // Single Block needs "no block still in flight". A line streamer (GRBL, the
  // simulator) says so with acked === sent. A controller that takes the WHOLE
  // program at load (UCCNC's geometry queue) reports every line sent from the
  // start, so acked only reaches sent at the very end - for it, Idle/Hold is
  // what says nothing is executing. Board, 2026-09-14 (WO-1530): Cycle Start
  // stayed disabled before the first block on UCCNC.
  const noBlockInFlight =
    job.ackedLines === job.sentLines || (job.totalLines > 0 && job.sentLines === job.totalLines)
  const resumeReady =
    job.phase === 'paused' || (machineState === 'hold' && (job.phase === 'streaming' || job.phase === 'complete'))
  if (resumeReady) {
    if (singleBlock) {
      const enabled =
        (machineState === 'hold' || machineState === 'idle') &&
        noBlockInFlight &&
        job.ackedLines < job.totalLines
      return {
        action: enabled ? 'single-block' : 'none',
        cycleStartEnabled: enabled,
        nextAction: input.programParts?.held
          ? `Program held at part ${input.programParts.completedPart} of ${input.programParts.totalParts} - Cycle Start continues`
          : enabled
            ? 'Single Block is ON. CYCLE START executes the next block.'
            : 'Single Block is ON. Wait for Idle before the next CYCLE START.',
        cycleStartDetail: enabled
          ? 'Execute exactly one block.'
          : job.ackedLines >= job.totalLines
            ? 'The program has no remaining block to execute.'
            : 'Wait for the current block to finish.',
      }
    }
    const enabled = machineState === 'hold' || machineState === 'idle'
    return {
      action: enabled ? 'resume' : 'none',
      cycleStartEnabled: enabled,
      nextAction: input.programParts?.held
        ? `Program held at part ${input.programParts.completedPart} of ${input.programParts.totalParts} - Cycle Start continues`
        : enabled
          ? heldAtToolChange(input) ?? 'CYCLE START resumes the held program.'
          : 'Wait for Hold before resuming.',
      cycleStartDetail: enabled ? 'Resume the held program.' : 'Wait for Hold before resuming.',
    }
  }

  // Geometry status and lifecycle travel separately (WO-2609 kit K4).
  // Only this controller's started job can outrank its ready load receipt:
  // a jog also reports Run, and a lingering executing id proves no new start
  // (WO-1549). Detached verdict inputs must not borrow the live job's start.
  const readyProgramRunning = machineState === 'run'
    && job === useMachineControl.getState().job
    && getMachineController().hasActiveJob()
    && getMachineController().jobProgress().phase === 'streaming'
  if (job.phase === 'ready' && !readyProgramRunning) {
    if (!programReadiness.ready) {
      return {
        action: 'none',
        cycleStartEnabled: false,
        nextAction: `Program is not ready: ${programReadiness.reason}`,
        cycleStartDetail: programReadiness.reason,
      }
    }
    if (machineState !== 'idle') {
      return {
        action: 'none',
        cycleStartEnabled: false,
        nextAction: 'Wait for the machine to become idle.',
        cycleStartDetail: 'Machine must be idle.',
      }
    }
    if (input.programFit?.state === 'outside') {
      return {
        action: 'none',
        cycleStartEnabled: false,
        nextAction: `${input.programFit.sentence} ${PROGRAM_FIT_REMEDY}`,
        cycleStartDetail: 'CYCLE START is blocked because the program lies entirely off the table.',
      }
    }
    if (singleBlock) {
      const enabled = noBlockInFlight && job.ackedLines < job.totalLines
      return {
        action: enabled ? 'single-block' : 'none',
        cycleStartEnabled: enabled,
        nextAction: enabled
          ? 'Single Block is ON. CYCLE START executes one block.'
          : 'The program has no remaining block to execute.',
        cycleStartDetail: enabled
          ? 'Execute exactly one block.'
          : job.ackedLines >= job.totalLines
            ? 'The program has no remaining block to execute.'
            : 'Wait for the current block to finish.',
      }
    }
    return {
      action: 'start',
      cycleStartEnabled: true,
      nextAction:
        toolChange?.step === 'ready'
          ? 'Guided recovery is armed. Review its cautions, then press CYCLE START.'
          : input.homed
            ? 'Program checks passed. CYCLE START begins the program.'
            : 'Program checks passed; no machine datum. CYCLE START begins.',
      cycleStartDetail: 'Begin the armed program.',
    }
  }

  if (job.phase === 'streaming' || machineState === 'run') {
    return {
      action: 'none',
      cycleStartEnabled: false,
      nextAction: input.programParts
        ? `Program is running - waiting for part ${input.programParts.nextPart} of ${input.programParts.totalParts}`
        : 'Program is running. Feed Hold pauses motion; Stop/Reset abandons the cycle.',
      cycleStartDetail: 'The program is already running.',
    }
  }
  // WO-2686: a loaded program that is not armed is armed by CYCLE START itself.
  if (job.phase === 'complete' || job.phase === 'failed' || job.phase === 'empty') {
    const fromLine1 = armFromLine1Verdict(input, reArm)
    if (fromLine1) return fromLine1
  }
  // WO-082: these two sentences used to name "re-arm" with no way to do it -
  // the app told the operator to re-arm and every route to re-arming at the
  // top was closed. They now name the control that is right there beside them.
  if (job.phase === 'complete') {
    if (!reArm.offered) return terminalWithoutReArm(input, 'Cycle complete.')
    return {
      action: 'none',
      cycleStartEnabled: false,
      nextAction: `Cycle complete. Press "${RE_ARM_LABEL}" to run the program again.`,
      cycleStartDetail: `No program is armed - press "${RE_ARM_LABEL}" first.`,
    }
  }
  if (job.phase === 'failed') {
    if (!reArm.offered) return terminalWithoutReArm(input, 'The cycle failed. Resolve the error first.')
    return {
      action: 'none',
      cycleStartEnabled: false,
      nextAction: `The cycle failed. Resolve the error, then press "${RE_ARM_LABEL}" to run it again.`,
      cycleStartDetail: `The failed program is not armed - press "${RE_ARM_LABEL}" first.`,
    }
  }
  // Phase 'empty' with a program still loaded is where Stop/Reset lands: the
  // streamer was flushed but the operator still has the part in the machine.
  // Telling them to LOAD a program there was the same dead end (WO-082).
  if (input.programText) {
    return {
      action: 'none',
      cycleStartEnabled: false,
      nextAction: `The program is not armed. Press "${RE_ARM_LABEL}" to arm it from line 1.`,
      cycleStartDetail: `No program is armed - press "${RE_ARM_LABEL}" first.`,
    }
  }
  return {
    action: 'none',
    cycleStartEnabled: false,
    nextAction: 'Load a checked program or prepare a material-fit trace.',
    cycleStartDetail: 'No program is armed.',
  }
}

/**
 * WO-2686: A LOADED PROGRAM RUNS FROM LINE 1 ON CYCLE START.
 *
 * The operator, 2026-10-08, on "No program is armed - press Re-arm from start first."
 * after a refused start, a reconnect and Home All: "If I load it, and home,
 * why should I not expect it to run from line 1 unless I have told it to do
 * otherwise." The software can arm it (rule 11), so after a completed, failed
 * or stopped run, a reconnect or an alarm, CYCLE START arms the loaded program
 * from line 1 and runs it. Through the door that took it: the text door's
 * Re-arm, or the file door staging its file again (a posted file on the
 * bridge, whose terminal states used to say "Choose From line and Plan").
 * A kept stop is not this: CYCLE START goes back to it, as before. Null when
 * nothing loaded can be armed here - today's sentence stands.
 */
function armFromLine1Verdict(
  input: OperatorTransportInput,
  reArm: OperatorReArmState,
): Omit<OperatorTransportState, 'reArm'> | null {
  const live = input.job === useMachineControl.getState().job
  const paused = input.pausedProgram !== undefined ? input.pausedProgram : live ? pausedProgramReadout() : null
  if (paused !== null) return null
  // A start he chose (Step Back, kept stop, hold, line N) that a reconnect
  // destroyed is his "otherwise": line 1 does not take its place.
  if (live && operatorChosenStartLost()) return null
  const textDoor = input.programText !== null && reArm.enabled
  // The file door's file, the one a reconnect left named (seat case 1) too,
  // and (WO-2772) one a Load refused for a reason outside it: never staged, so
  // no listing - CYCLE START reads it below exactly as it reads the others.
  const fileDoor = input.programText === null && live
    && (publishedListing(input) === true || loadedFileRefusedAtLoad())
    && !standaloneMdiJob() && loadedFileArmableFromLine1()
  if (!textDoor && !fileDoor) return null
  // A failed run leaves GRBL in Hold with the rest of it buffered (WO-087):
  // the arm flushes that to a verified Idle first, exactly as Re-arm does.
  if (input.machineState !== 'idle' && input.machineState !== 'hold') {
    return {
      action: 'none',
      cycleStartEnabled: false,
      nextAction: 'Wait for the machine to become idle.',
      cycleStartDetail: 'Machine must be idle.',
    }
  }
  if (input.programFit?.state === 'outside') {
    return {
      action: 'none',
      cycleStartEnabled: false,
      nextAction: `${input.programFit.sentence} ${PROGRAM_FIT_REMEDY}`,
      cycleStartDetail: 'CYCLE START is blocked because the program lies entirely off the table.',
    }
  }
  const opening = input.job.phase === 'complete'
    ? 'Cycle complete. '
    : input.job.phase === 'failed' ? 'The cycle failed. ' : ''
  // Fix round 4: the file read again against the machine as it stands NOW -
  // offsets, G28/G30 points, tool lengths, travel - never a remembered refusal.
  // While that reading refuses it, CYCLE START does too, in the Load's words.
  const unfit = fileDoor ? loadedFileFitRefusal() : null
  if (unfit !== null) {
    return {
      action: 'none',
      cycleStartEnabled: false,
      nextAction: `${opening}${unfit} ${LOADED_FILE_FIT_REMEDY}`,
      cycleStartDetail: unfit,
    }
  }
  return {
    action: 'arm-start',
    cycleStartEnabled: true,
    nextAction: `${opening}CYCLE START runs the program from line 1.`,
    cycleStartDetail: input.singleBlock
      ? 'Arm the program from line 1 and execute its first block.'
      : 'Arm the program from line 1 and run it.',
  }
}

/** WO-2686: arm the loaded program from line 1, say so, then do what the
 *  fresh verdict for the armed program says - every check a start from a
 *  fresh load makes still runs, and refuses with its own sentence. */
async function armFromLine1ThenStart(): Promise<boolean> {
  const say = useMachineControl.getState().pushConsole
  if (estopNeedsReset()) {
    say('tx', `Cycle Start: refused - ${ESTOP_BLOCKS_MOTION}`, 'error')
    return false
  }
  const armed = await armLoadedProgramFromLine1()
  if (!armed.ok) {
    say('tx', `Cycle Start: refused - ${armed.reason}`, 'error')
    return false
  }
  say('tx', 'Armed from line 1.', 'info')
  const fresh = currentOperatorTransport()
  if (!fresh.cycleStartEnabled || fresh.action === 'arm-start') {
    say('tx', `Cycle Start: ${fresh.nextAction}`, 'error')
    return false
  }
  return executeOperatorCycleStart()
}

function currentOperatorTransportInput(): OperatorTransportInput {
  const s = useMachineControl.getState()
  return {
    ...s,
    noHomeSwitches: activeMachineHasNoHomeSwitches(),
    programParts: programPartsTransportState(),
    guidedMeasure: guidedToolMeasureState(),
    programHold: programHoldCycleStartDecision(),
  }
}

export function currentOperatorTransport(): OperatorTransportState {
  return deriveOperatorTransport(currentOperatorTransportInput())
}

/**
 * WO-2863 (sweep G6): the tool change a CYCLE START out of the file's own
 * tool-change hold completes. The line told the operator "fit T3, then press
 * CYCLE START"; pressing it is the operator saying T3 is fitted - the same
 * moment UCCNC's M6 macro calls Setcurrenttool (machineControlStore
 * setToolChange). Null unless the line on screen is that sentence and names a
 * tool. Before this the TOOL panel kept reading T2 after the resume: a GRBL
 * post writes the change as a comment and an M0, never a T word, so neither
 * the controller nor the program's tool-change list ever heard of T3.
 */
function toolFittedByResume(state: OperatorTransportState): { line: number; tool: number } | null {
  const held = heldToolChange(currentOperatorTransportInput())
  if (held === null || held.tool === null) return null
  return state.nextAction === toolChangeHoldSentence(held.tool) ? { line: held.line, tool: held.tool } : null
}

/** The readouts only: the tool in the spindle, and the program's own list of
 *  its tool changes (ToolGlance reads the last one the run has passed). What
 *  is sent and how the program resumes do not change. */
function recordToolFitted(fitted: { line: number; tool: number }): void {
  const s = useMachineControl.getState()
  s.setActiveTool(fitted.tool)
  const { toolChanges } = s.job
  if (toolChanges.some((change) => change.sourceLine === fitted.line && change.tool === fitted.tool)) return
  const change = { sourceLine: fitted.line, tool: fitted.tool, label: `T${fitted.tool}` }
  const next = [...toolChanges.filter((c) => c.sourceLine !== fitted.line), change]
    .sort((a, b) => a.sourceLine - b.sourceLine)
  useMachineControl.setState({ job: { ...s.job, toolChanges: next } })
}

/** Execute only the action named by a fresh canonical verdict. */
export async function executeOperatorCycleStart(): Promise<boolean> {
  // Step Back owns a settle/reset/re-arm transaction. No start, step, or
  // resume authority may interleave with it, even if a stale render briefly
  // presents an otherwise-valid verdict.
  if (stepBackInProgress()) return false
  const state = currentOperatorTransport()
  if (!state.cycleStartEnabled) return false
  const ctrl = getMachineController()
  switch (state.action) {
    case 'trace':
      return startMaterialFitTrace()
    case 'single-block':
      return ctrl.stepJob()
    case 'resume': {
      const fitted = toolFittedByResume(state)
      const resumed = useMachineControl.getState().job.phase === 'paused' && ctrl.hasActiveJob()
        // The controller refuses this while Single Block is on (WO-006).
        ? ctrl.resumeJob()
        : ctrl.cycleResume()
      if (resumed && fitted !== null) recordToolFitted(fitted)
      return resumed
    }
    case 'start':
      return startMachineJob()
    case 'arm-start':
      return armFromLine1ThenStart()
    default:
      return false
  }
}

export function executeOperatorFeedHold(): boolean {
  const s = useMachineControl.getState()
  const facts = { connected: s.connectionPhase === 'connected', machineState: s.machineState }
  if (!authorize('feedHoldSend', facts).allowed) return false
  const ctrl = getMachineController()
  if (ctrl.hasActiveJob() && s.job.phase === 'streaming') ctrl.pauseJob()
  else ctrl.feedHold()
  return true
}

export function executeOperatorStopReset(): boolean {
  const s = useMachineControl.getState()
  if (!authorize('stopReset', { connected: s.connectionPhase === 'connected' }).allowed) return false
  const ctrl = getMachineController()
  if (ctrl.hasActiveJob()) ctrl.stopJob()
  else ctrl.reset()
  return true
}
