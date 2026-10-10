// ONE PROGRAM, MORE THAN ONE SETUP, ON THE GEOMETRY ROUTE (WO-1323).
//
// The toolpath route hands the controller MOTION ONLY, in WORK coordinates,
// and the bridge adds `offsets[activeWcs]` when the moves are staged. So a
// program that spans two setups cannot be one staged list: the second setup's
// moves mean something different from the first's, and the only thing that
// makes them mean it is the frame the controller holds AT LOAD.
//
// That is the whole shape of this file. It plans the program as a SEQUENCE OF
// STAGES - one per setup, each a self-contained set of controller-sized parts
// with its own frame - and it records, per stage, the height the tool must
// have reached before the frame is allowed to change. Nothing here talks to a
// controller, a store or a component: it takes world-coordinate moves and
// gives back parts, frames and clearances for the session to execute.
//
// THE BOUNDARY IS THE POSTED FILE'S BOUNDARY, deliberately. `emitCombinedProgram`
// (`src/lib/post/emit.ts`) already answers "what happens between two setups" for
// the text route: each section but the last ends with a TRAILING RETRACT to a
// GLOBAL safe height - the max clearance across every setup, taken in a common
// world frame and converted back into the OUTGOING setup's work frame - because
// one setup's work-clearance can sit below the next setup's stock top in machine
// space. Two routes to the same machine that disagreed about how high the tool
// lifts between fixtures would be a crash, so this computes the same number the
// same way. It does NOT import the post (ADR-0021's one-way rule); it shares the
// transform, which is what `src/lib/program/coords.ts` exists for.
//
// AGENDA FAIL #3, NAMED: a Z move at the NEW offset before the tool is clear.
// The plan carries `retractWorkZ` for every stage but the last, and the session
// refuses to select the next frame until the machine has REPORTED reaching it.
// A green plan is not evidence the tool is clear; the readback is.
//
// A DIFFERENT-TOOL BOUNDARY IS A TOOL-CHANGE SEQUENCE, NOT A REFUSAL (WO-1330,
// Operator at the machine 2026-09-11: "If it does change tool, even if I check the
// box saying continue through, it should NOT continue through - it should be
// initiating a tool change sequence.").
//
// WO-1323 refused such a program at the door, and the reason was structural
// rather than a preference: fitting a different tool means raising Z and
// re-zeroing the incoming frame with it, and a paused program disabled every
// jog and refused live work-offset edits - a hold asking for it was a dead end
// whose only exit discarded the program. Operator's ruling makes the boundary the
// tool-change sequence instead, so the paused-at-a-tool-change program ALLOWS
// exactly those two things and nothing else.
//
// WHAT THIS FILE OWES THAT SEQUENCE: the plan records the tool each stage cuts
// with, so the session knows which boundaries are tool changes, the load line
// names the change before CYCLE START is offered, and the hold sentence names
// the tool leaving, the tool to fit and what the operator may do at that hold.
// The stopping, the jog, the Z zero and the re-gated spindle all belong to the
// session; nothing here talks to a controller.

import type { ToolpathMove, WCS } from '../../types'
import type { MachineProgram, ProgramIndex, ProgramStep } from '../machine/controller'
import { buildStraightLineProgram } from './buildMachineProgram'
import { toWork, toWorld } from './coords'
import { isStagedMove } from './programCapacity'
import { buildProgramParts } from './programParts'

/** One operation's contribution to a stage, in WORLD coordinates. Mirrors the
 *  session's `ToolpathProgramSection` without importing the session. */
export interface MultiSetupSection {
  opId: string
  moves: readonly ToolpathMove[]
}

/**
 * The tool one setup cuts with, as the operator is told about it. The plan
 * compares tools across setups so it can say WHERE the program changes tool,
 * and every sentence about a change names the tool in plain words - what the
 * operator picks up - never a library id.
 */
export interface MultiSetupTool {
  /** Library id, the identity two stages are compared on. */
  id: string
  /** Plain words: `T2 (6 mm flat end mill)`. Never an id. */
  label: string
}

/** One setup as this planner needs it: already resolved, already validated by
 *  the caller that owns the project. */
export interface MultiSetupInput {
  setupId: string
  setupName: string
  /** The frame the controller must hold while this stage runs ('G54'...). */
  wcsId: string
  /** The setup's own WCS - the world->work transform for its moves. */
  wcs: WCS
  /** The one tool this setup cuts with - the caller has already refused a
   *  setup that needs more than one. */
  tool: MultiSetupTool
  sections: readonly MultiSetupSection[]
}

/** One setup's place in the planned program. */
export interface MultiSetupStage {
  setupId: string
  setupName: string
  wcsId: string
  /** WO-1330: the tool this stage cuts with. Two adjacent stages whose tools
   *  differ are separated by a TOOL CHANGE, which is a hold the operator works
   *  inside rather than a program the door turns away. */
  tool: MultiSetupTool
  /** Index into `plan.parts` of this stage's FIRST controller-sized part. */
  firstPartIndex: number
  partCount: number
  /** Staged moves in this stage, including its trailing retract. */
  moveCount: number
  /**
   * The work-frame Z the trailing retract lifts to, in THIS stage's frame, or
   * null on the last stage (which has no boundary after it). The session turns
   * this into a machine Z with the stage's own work offset and refuses to
   * change frame until the machine reports being at or above it.
   */
  retractWorkZ: number | null
}

export interface MultiSetupPlan {
  /** Every controller-sized part of the whole program, in run order. */
  parts: MachineProgram[]
  /** `stageOfPart[i]` is the index into `stages` that part `i` belongs to. */
  stageOfPart: number[]
  stages: MultiSetupStage[]
  /**
   * The WHOLE program - every stage's steps under program-unique ids, with the
   * merged index. This is what path fidelity is armed against and what the
   * executing-move-id readback is attributed through; it is never staged as
   * one list, because no single frame is true for all of it.
   */
  program: MachineProgram
  /** Staged moves across every stage - the number the operator is told. */
  motionCount: number
}

export type MultiSetupPlanResult =
  | { ok: true; plan: MultiSetupPlan }
  | { ok: false; reason: string }

/**
 * The height every inter-setup retract lifts to, in WORLD coordinates.
 *
 * Per setup: the highest work Z any of its moves reaches (the clearance plane
 * the CAM already used for its own retracts), lifted into the world frame. The
 * program-wide maximum is the answer, so the lift clears EVERY setup's stock
 * top - including one sitting on a taller fixture. Null when no setup moves at
 * all, which the caller refuses before it gets here.
 *
 * This is `computeSafeWorkZ` + the global pre-pass of `emitCombinedProgram`,
 * arrived at by the same arithmetic on the same transform, because the two
 * routes drive the same spindle over the same fixtures.
 */
export function globalSafeRetractWorldZ(inputs: readonly MultiSetupInput[]): number | null {
  let worldZ: number | null = null
  for (const input of inputs) {
    let safeWorkZ: number | null = null
    for (const section of input.sections) {
      for (const move of section.moves) {
        const wz = toWork(move, input.wcs).z
        if (safeWorkZ === null || wz > safeWorkZ) safeWorkZ = wz
      }
    }
    if (safeWorkZ === null) continue
    const candidate = toWorld({ x: 0, y: 0, z: safeWorkZ }, input.wcs).z
    if (worldZ === null || candidate > worldZ) worldZ = candidate
  }
  return worldZ
}

/** Shift every step id (and its index key) by `offset`, preserving order and
 *  attribution. Step ids are only ever compared for identity, so a stage's
 *  second-and-later ids can be rebased to keep the WHOLE program's ids unique -
 *  which `validateMachineProgram` requires and which the executing-move-id
 *  readback depends on to name one move and not two.
 *
 *  A RENUMBERED STEP IS STILL THE WHOLE STEP. The spread below carries
 *  everything the builder put on it, EXECUTION FACTS INCLUDED - a G53 line's
 *  machine-absolute declaration and its machine target are the step's own
 *  enumerable data for this reason (WO-1897). While they were hidden from a
 *  spread, stage 1 kept them and every stage after it lost them: the same
 *  retract went to the board as a machine move from one setup and as an
 *  ordinary work move from the next. Anything new a step carries has to be
 *  plain data too, or it stops at this line. */
function rebaseProgram(program: MachineProgram, offset: number): MachineProgram {
  if (offset === 0) return program
  const index: ProgramIndex = {}
  const steps: ProgramStep[] = program.steps.map((step) => {
    const id = step.id + offset
    const entry = program.index[step.id]
    if (entry !== undefined) index[id] = entry
    return { ...step, id } as ProgramStep
  })
  return { frame: program.frame, units: program.units, steps, index }
}

/**
 * Plan one program over several setups.
 *
 * `rapidFeedMmMin` and `cap` are the caller's resolved machine facts - the
 * declared rapid rate and the board's staged-move ceiling - passed in for the
 * same reason `buildStraightLineProgram` takes them: this file has no way to
 * invent a machine number and never will.
 *
 * Refuses, naming the setup, rather than planning something a controller would
 * have to guess at.
 */
export function planMultiSetupProgram(
  inputs: readonly MultiSetupInput[],
  rapidFeedMmMin: number,
  cap: number,
): MultiSetupPlanResult {
  if (inputs.length < 2) {
    return { ok: false, reason: 'A multi-setup program needs at least two setups.' }
  }

  // TWO SETUPS SHARING ONE FRAME IS NOT A MULTI-SETUP PROGRAM, it is two parts
  // of one that would run the second at the first's zero. The frames come from
  // the setups' own fixture offsets, so this is a project fact, said plainly
  // before anything is built.
  const duplicate = inputs.find(
    (input, i) => inputs.findIndex((other) => other.wcsId === input.wcsId) !== i,
  )
  if (duplicate !== undefined) {
    const sharing = inputs.filter((input) => input.wcsId === duplicate.wcsId)
    return {
      ok: false,
      reason:
        `Setups ${sharing.map((s) => `"${s.setupName}"`).join(' and ')} both run in ${duplicate.wcsId}, `
        + 'so one program cannot switch between them - there is nothing to switch to. Give each setup '
        + 'its own work offset, or run them one at a time.',
    }
  }

  // NOTHING IS REFUSED HERE FOR CHANGING TOOL (WO-1330). A boundary whose two
  // stages cut with different tools is a TOOL CHANGE: the session stops the
  // spindle, holds, and lets the operator jog and set the new tool's Z zero
  // before the frame moves. The plan's job is only to say where that happens,
  // which is what each stage's `tool` records.

  const retractWorldZ = globalSafeRetractWorldZ(inputs)
  if (retractWorldZ === null) {
    return { ok: false, reason: 'No setup in this program has a move, so there is nothing to send.' }
  }

  const parts: MachineProgram[] = []
  const stageOfPart: number[] = []
  const stages: MultiSetupStage[] = []
  const wholeSteps: ProgramStep[] = []
  const wholeIndex: ProgramIndex = {}
  let idOffset = 0

  for (let stageIndex = 0; stageIndex < inputs.length; stageIndex++) {
    const input = inputs[stageIndex]
    const isLast = stageIndex === inputs.length - 1

    // THE TRAILING RETRACT, IN WORLD COORDINATES SO IT GOES THROUGH THE SAME
    // TRANSFORM AS EVERY OTHER MOVE. It stays where the toolpath left the tool
    // in XY and lifts to the global safe height; the builder converts it into
    // this setup's work frame, exactly as the post's inter-section lift is
    // converted into the outgoing setup's work frame. It is attributed to the
    // operation it follows, because that is the operation it retracts from.
    const sections = input.sections.map((section) => ({ ...section, moves: [...section.moves] }))
    const lastSection = sections.at(-1)
    const lastMove = lastSection?.moves.at(-1)
    if (lastSection === undefined || lastMove === undefined) {
      return {
        ok: false,
        reason: `Setup "${input.setupName}" has no move to send, so this program cannot run it.`,
      }
    }
    if (!isLast) {
      lastSection.moves.push({ type: 'rapid', x: lastMove.x, y: lastMove.y, z: retractWorldZ })
    }

    const moves = sections.flatMap((section) => section.moves)
    const built = buildStraightLineProgram(moves, input.wcs, rapidFeedMmMin, {
      opId: sections[0].opId,
      setupId: input.setupId,
    })
    if (!built.ok) return { ok: false, reason: `Setup "${input.setupName}": ${built.reason}` }

    // EVERY STEP NAMES THE OPERATION THAT MADE IT - the same correction the
    // single-setup door makes, for the same reason: the builder takes ONE
    // trace, and a plausible wrong operation name on every move after the first
    // section is what the executing-move-id readback would be attributed
    // against while the machine runs.
    const motionSteps = built.program.steps.filter(isStagedMove)
    if (motionSteps.length !== moves.length) {
      return {
        ok: false,
        reason:
          `Setup "${input.setupName}" built ${motionSteps.length} motion steps for ${moves.length} `
          + 'moves, so each step cannot be traced back to the operation that made it. Nothing was sent.',
      }
    }
    let sectionStart = 0
    for (const section of sections) {
      for (let i = 0; i < section.moves.length; i++) {
        const step = motionSteps[sectionStart + i]
        built.program.index[step.id] = {
          opId: section.opId,
          setupId: input.setupId,
          moveOrdinal: sectionStart + i,
        }
      }
      sectionStart += section.moves.length
    }

    const staged = rebaseProgram(built.program, idOffset)
    idOffset += staged.steps.length

    const partitioned = buildProgramParts(staged, cap)
    if (!partitioned.ok) {
      return { ok: false, reason: `Setup "${input.setupName}": ${partitioned.reason}` }
    }

    stages.push({
      setupId: input.setupId,
      setupName: input.setupName,
      wcsId: input.wcsId,
      tool: input.tool,
      firstPartIndex: parts.length,
      partCount: partitioned.parts.length,
      moveCount: staged.steps.length,
      retractWorkZ: isLast ? null : toWork({ x: 0, y: 0, z: retractWorldZ }, input.wcs).z,
    })
    for (const part of partitioned.parts) {
      parts.push(part)
      stageOfPart.push(stageIndex)
    }
    for (const step of staged.steps) {
      wholeSteps.push(step)
      const entry = staged.index[step.id]
      if (entry !== undefined) wholeIndex[step.id] = entry
    }
  }

  // A STAGE THAT PLANNED NO PART IS A PROGRAM THAT WOULD SKIP A SETUP. The
  // capacity planner returns no parts for an empty program; a stage reaching
  // here empty means the moves were lost between the build and the plan, and
  // running the rest would machine the part with one setup missing.
  const empty = stages.find((stage) => stage.partCount === 0)
  if (empty !== undefined) {
    return {
      ok: false,
      reason:
        `Setup "${empty.setupName}" planned no program parts, so running this program would skip it `
        + 'entirely. Nothing was sent.',
    }
  }

  return {
    ok: true,
    plan: {
      parts,
      stageOfPart,
      stages,
      program: { frame: 'work', units: 'mm', steps: wholeSteps, index: wholeIndex },
      motionCount: wholeSteps.filter(isStagedMove).length,
    },
  }
}

/**
 * WHAT WILL RUN AND IN WHICH FRAMES, IN ORDER, BEFORE CYCLE START IS OFFERED.
 *
 * WO-1312's rule ("the load line names the frame") for a program with more
 * than one. Plain words, one sentence, no mechanism: the operator is being
 * told what the machine is about to do, not how this software arranged it.
 */
export function describeMultiSetupLoad(
  name: string,
  plan: MultiSetupPlan,
  runThrough = false,
  drivesSpindle = false,
): string {
  // WO-1330: A TOOL CHANGE IS PART OF WHAT WAS LOADED, so the load line names
  // it - the tool each setup cuts with and the change between them. A program
  // that runs on ONE tool says nothing about tools at all, because the operator
  // is not being told anything by "with T1" repeated twice, and that is the
  // sentence WO-1323 and WO-1329 measured.
  const order = planChangesTool(plan)
    ? plan.stages
      .map((stage, i) => {
        const said = `${stage.setupName} in ${stage.wcsId} with ${stage.tool.label}`
        if (i === 0) return said
        return stage.tool.id === plan.stages[i - 1].tool.id
          ? said
          : `a TOOL CHANGE, then ${said}`
      })
      .join(', then ')
    : plan.stages.map((stage) => `${stage.setupName} in ${stage.wcsId}`).join(', then ')
  const line = `Toolpath program "${name}" loaded: ${plan.motionCount} moves in ${plan.stages.length} `
    + `setups - ${order}.`
  // WO-1330: THE BOX DOES NOT DECIDE A TOOL CHANGE, whatever it says, and the
  // load line is where the operator finds that out - before they press CYCLE
  // START once expecting the program to run itself to the end.
  // "The spindle stops" is said only of a connection that can stop it.
  if (planChangesTool(plan)) {
    const spindle = drivesSpindle
      ? 'the spindle stops and the new tool is yours to fit and zero.'
      : 'this app has no link to the spindle, so switching it off there is yours, and so is '
        + 'fitting and zeroing the new tool.'
    return `${line} It stops at the tool change whether or not "Continue through the setups" is `
      + `ticked - ${spindle}`
  }
  // WO-1329: WHETHER IT STOPS BETWEEN THEM IS PART OF WHAT WAS LOADED. The
  // operator is about to press CYCLE START once for a program that may run all
  // the way through, so the load line says which of the two it is.
  if (!runThrough) return line
  const frames = plan.stages.map((stage) => stage.wcsId)
  return `${line} It runs straight through from ${frames[0]} into ${frames.at(-1)} without stopping.`
}

/** True when any two ADJACENT stages cut with different tools - the one
 *  question "is there a tool change in this program" reduces to. */
export function planChangesTool(plan: MultiSetupPlan): boolean {
  return plan.stages.some((stage, i) => i > 0 && stage.tool.id !== plan.stages[i - 1].tool.id)
}

/** `['G54', 'G55', 'G56']` as an operator would read it aloud. */
function namedInOrder(frames: readonly string[]): string {
  if (frames.length <= 1) return frames[0] ?? ''
  return `${frames.slice(0, -1).join(', ')} and ${frames.at(-1)}`
}

/**
 * WO-1329, OPERATOR'S REQUIREMENT 4 (from the machine, 2026-09-11): "we state in
 * the terminal that both work coordinate systems must be defined to allow
 * continuation and notify the user. It is their responsibility to confirm both
 * work coordinate systems are correct."
 *
 * A CONSOLE LINE, NOT A NOTICE AND NOT A GATE (COHESION-STANDARD s13). The
 * program has already refused any frame the controller does not have set; what
 * this says is the part software cannot check - that the zeros the controller
 * holds are the RIGHT ones for the work in the vices, which only the operator
 * standing at the machine can confirm.
 */
export function describeSetupContinuation(plan: MultiSetupPlan): string {
  const frames = namedInOrder(plan.stages.map((stage) => stage.wcsId))
  return `This program does not stop between setups, so ${frames} must be set to the right zeros `
    + `before it runs. Confirming that is yours to do - check ${frames} at the machine, then press `
    + 'CYCLE START.'
}

/** A stage boundary as the operator meets it - the two setups and the frame the
 *  next one runs in. The tool is not among them: both stages cut with the same
 *  one, because the planner refuses a program where they do not. */
export interface SetupBoundaryHold {
  finishedName: string
  nextName: string
  wcs: string
}

/** What the operator is told AT the boundary, before they press CYCLE START
 *  again: the tool is clear, the part can be moved, and this is the frame the
 *  next setup runs in.
 *
 *  EVERYTHING THIS ASKS FOR CAN BE DONE WHILE THE PROGRAM IS PAUSED - re-fixture
 *  the work and press CYCLE START - which is why the boundary is allowed to be
 *  a hold at all. A boundary that also changes tool asks for two more things,
 *  and gets its own sentence below. */
export function describeSetupBoundaryHold(boundary: SetupBoundaryHold): string {
  return `${boundary.finishedName} is finished and the tool has retracted clear. `
    + `Set up "${boundary.nextName}", then press CYCLE START to run it in ${boundary.wcs}.`
}

/** A tool-change boundary as the operator meets it (WO-1330). */
export interface ToolChangeBoundaryHold extends SetupBoundaryHold {
  /** The tool coming OUT of the spindle, in plain words. */
  leaving: string
  /** The tool to FIT, in plain words. */
  fit: string
}

/**
 * WHAT THE OPERATOR IS TOLD AT A TOOL-CHANGE HOLD (WO-1330).
 *
 * Three facts, in the order they are acted on: the machine is safe (clear and
 * stopped), what to fit and what comes out, and WHAT THIS HOLD LETS THEM DO -
 * jog, and set the new tool's Z zero in the incoming frame. Those two are
 * exactly what a paused program otherwise disables, so saying so is not
 * decoration: it is the difference between a sequence and the dead end
 * WO-1323 refused at the door rather than create.
 *
 * "STOPPED" IS A CLAIM ABOUT THE MACHINE, and it is made only when a stop can
 * reach the spindle (`spindleStops`). A connection with no spindle link has
 * nothing this app can switch off, so the sentence hands the spindle to the
 * operator instead of telling them it is safe to reach in.
 */
export function describeToolChangeHold(
  hold: ToolChangeBoundaryHold,
  spindleStops: boolean,
  fitSpindle: { rpm: number; direction: 'cw' | 'ccw' } | null = null,
  measuredAtSetter = false,
): string {
  // WO-2025: a guided change measures the new tool at the setter, so the hold
  // must not ask for a Z zero - following that re-zeroes the frame. Only that
  // clause changes; the spindle words stay exactly as they are.
  const measured = `Take ${hold.leaving} out and fit ${hold.fit} - the ${hold.wcs} Z work zero is not changed; `
    + 'the new tool is measured at the setter.'
  if (!spindleStops) {
    // Both ends are the operator's here, so the speed to start at is named.
    const speed = fitSpindle === null
      ? ''
      : ` at ${fitSpindle.rpm} RPM ${fitSpindle.direction.toUpperCase()}`
    if (measuredAtSetter) {
      // Continue measures and resumes in one press (continueProgramM6ToolChange),
      // so the words promise no step in between (WO-2025 review).
      const runsAt = speed === '' ? '' : `, and the next section runs${speed}`
      return `${hold.finishedName} is finished and the tool has retracted clear. This app has no link `
        + 'to the spindle, so it cannot stop it - switch it off at the machine. '
        + `${measured} Continue measures it and the program resumes at once, with no stop in between. `
        + `This app cannot start the spindle either${runsAt}.`
    }
    return `${hold.finishedName} is finished and the tool has retracted clear. This app has no link `
      + 'to the spindle, so it cannot stop it - switch it off at the machine. '
      + `Take ${hold.leaving} out and fit ${hold.fit}, then set the ${hold.wcs} Z work zero for it - `
      + `jogging and that Z zero are what this hold allows. Start the spindle${speed} for the new tool `
      + `and press CYCLE START when it is zeroed and "${hold.nextName}" runs in ${hold.wcs}.`
  }
  if (measuredAtSetter) {
    return `${hold.finishedName} is finished, the tool has retracted clear and the spindle is stopped. ${measured}`
  }
  return `${hold.finishedName} is finished, the tool has retracted clear and the spindle is stopped. `
    + `Take ${hold.leaving} out and fit ${hold.fit}, then set the ${hold.wcs} Z work zero for it - `
    + `jogging and that Z zero are what this hold allows. Press CYCLE START when the new tool is `
    + `zeroed and "${hold.nextName}" runs in ${hold.wcs}.`
}
