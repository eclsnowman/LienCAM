// POSTED G-CODE, INTERPRETED INTO THE PROGRAM THE GEOMETRY ROUTE ALREADY RUNS
// (WO-1335 - slice 4 of WO-1265, Operator's requirement, 2026-09-11).
//
// "A CNC control software that cannot load the most standard file format for
// controlling a CNC is not complete (.gcode and .nc)." He is right, and the
// route existed in pieces: `reader.ts` (WO-1288) already reads a whole file
// into the app's canonical-mm move vocabulary, and the geometry queue already
// carries frames (WO-1312), the spindle gate (WO-1275), the path check
// (WO-1313), the readout (WO-1322) and the setup boundary (WO-1323). What did
// not exist was the step between them. This file is that step, and nothing
// else: `GcodeReadProgram` in, STAGES out.
//
// THE DIALECT IS WHAT THE UCCNC POSTS EMIT, NOT WHAT OUR POST EMITS
// (architect re-scope, 2026-09-11T03:23Z). The first round of this order was
// told "the dialect is LienCAM's own post, exactly" and implemented that
// faithfully - and the result refused Operator's own Fusion output AND our own
// two-setup posted file, the two files the acceptance names. The vocabulary
// below is therefore measured from the files his machine is actually given:
// a tool change is a BOUNDARY, `G91` is CONVERTED, `G43 H` is RESOLVED against
// the machine's tool table and folded into the staged Z (WO-1677), two spindle speeds are
// allowed, and a word that changes nothing this route can honour (`G64`, `G94`)
// is accepted and SAID once instead of turning the file away at the door.
//
// A STAGE IS A RUN OF MOVES IN ONE FRAME, AT ONE SPINDLE STATE, WITH ONE TOOL
// AND ONE COOLANT STATE, ended by whichever of those the next block changes.
// That is the only structure the executing route needs, because it is the
// structure the toolpath route already has: `loadSetupsToolpathProgram` plans
// one stage per setup, selects the frame at each boundary once the outgoing
// stage's retract has been REPORTED reached, and holds in between. A posted
// file's `G55` after a `G0 Z10` is the same event as a setup boundary, and an
// `M0` is the same event without the frame change, so both become boundaries
// here and the session executes them through the code WO-1323 already landed.
// An `M5` is the same event again with neither a frame change nor a hold: the
// program runs straight on, with the inverter commanded off in the gap between
// the two staged parts - which is the only instant the app has, because the
// moves themselves live on the board.
//
// WHAT THIS FILE NEVER DOES:
//  - guess. A word this route cannot honour is refused by line and word,
//    through the reader's own refusal path, before a single move exists. There
//    is no "unsupported word skipped".
//  - scale. Inches are refused (ADR-0003), never silently converted, because no
//    conversion has been decided for the live route.
//  - talk to a controller, a store or a component. It is pure, like the reader
//    and the builder either side of it. The tool library reaches it as a
//    function the caller passes, never as an import.

import {
  readGcodeProgram,
  type GcodeDialect,
  type GcodeListedOutputCommand,
  type GcodeReadRefusal,
  type GcodeReaderMove,
  type GcodeReaderOptions,
  type GcodeReaderPoint,
  type GcodeRefusedWord,
  type GcodeWcs,
} from './reader'
import { collapsedBoundaryMessage, secondStopMessage } from '../machine/operatorMessages'

export interface GcodeInterpretOptions {
  /** Only reaches the reader's dwell arithmetic, which this route refuses
   *  outright - carried so the two readers never disagree about a file. */
  dialect: GcodeDialect
  /** The frame the session holds when the file is loaded. A file that names no
   *  G54-G59 of its own runs in this one. */
  sessionWcs: GcodeWcs
  /** Where the machine is, in `sessionWcs` work coordinates, at load. A file
   *  whose first move addresses every axis never consults it. */
  initialPosition: GcodeReaderPoint
  /** Machine-native units, used only when the file has no G20/G21 word. */
  machineUnits?: 'mm' | 'inch'
  /** Machine coordinates of each work origin, so a frame change can rebase the
   *  reader's position. */
  workOffsets?: Partial<Record<GcodeWcs, GcodeReaderPoint>>
  /** WHERE HOME IS, IN MACHINE COORDINATES, AND ONLY ON A HOMED MACHINE
   *  (WO-1337). It is what resolves a `G28` home block into the rapids that
   *  carry it out. Absent - which is what an UNHOMED machine's caller passes -
   *  `G28` is refused at its own line, naming why, exactly as it was before.
   *  A caller that supplies a remembered home while unhomed would stage a
   *  rapid to a place the tool is not measured against, which is the one thing
   *  this option must never be used for. */
  machineHome?: GcodeReaderPoint
  /** Machine-frame G30 points stored by the active machine definition. */
  referencePositions?: Partial<Record<1 | 2 | 3 | 4, GcodeReaderPoint>>
  /** THE MACHINE'S OWN DWELL P UNIT (WO-1559). The active definition, so the
   *  reader can read UCCNC's `Generalsettings.Dwellinseconds` when the machine
   *  states it; absent, the dialect's own default decides. */
  machineDefinition?: GcodeReaderOptions['machineDefinition']
  /** The length the machine's tool table holds for tool n (WO-1677), folded
   *  into every absolute Z a `G43 H<n>` governs. See reader.ts. */
  toolLengthMm?: GcodeReaderOptions['toolLengthMm']
  /** WO-3192: the length the controller holds in force, which `G49` cancels.
   *  See reader.ts. */
  toolLengthInForceMm?: GcodeReaderOptions['toolLengthInForceMm']
}

/** Why a stage ended - which is what the operator is told at its boundary. */
export type GcodeStageEnd =
  /** The next block selects a different work offset. */
  | { kind: 'frame'; line: number; next: GcodeWcs }
  /** M0 (or M1) - the program stops and waits for the operator. */
  | { kind: 'hold'; line: number; optional: boolean }
  /** M3/M4/M5 - the file changes the spindle, and motion follows. NOT a hold:
   *  the file asked for a spindle word here, not for the operator. */
  | { kind: 'spindle'; line: number; on: boolean }
  /** T/M6 - the file fits a different cutter. A BOUNDARY, not a refusal
   *  (architect re-scope): the program holds, the console names both tools, and
   *  CYCLE START runs on. */
  | { kind: 'tool-change'; line: number; from: number; to: number }
  /** M7/M8/M9 - the file changes coolant, and motion follows. WO-1650: also any
   *  word the machine definition points at an output; `outputs` is the listed
   *  outputs on after it (see `GcodeCoolantState`). */
  | ({ kind: 'coolant'; line: number } & GcodeCoolantState)
  /** A user macro call (`M2001`) this app cannot execute. A BOUNDARY: the
   *  program holds at the line, names the macro, and the operator does at the
   *  machine whatever that macro does. `toolChange` (WO-1652 tightening): the
   *  tool the reader counted for a bound macro whose body calls
   *  `toolChange()` - the session's tool-change hold follows that macro
   *  however it ends. */
  | { kind: 'macro'; line: number; code: number; toolChange?: number }
  /** The last stage: M2/M30 ends the program. */
  | { kind: 'end' }

/** THE OUTPUT STATE A FILE HAS COMMANDED: coolant, and (WO-1650) the machine's
 *  own listed outputs that are on, each named by its on word's number. The
 *  `outputs` key is present only on a machine whose definition lists output
 *  words beyond the dialect's coolant words. */
export interface GcodeCoolantState {
  flood: boolean
  mist: boolean
  outputs?: number[]
}

/** Whether two output states say the same thing. */
export function sameGcodeCoolantState(a: GcodeCoolantState, b: GcodeCoolantState): boolean {
  const ao = a.outputs ?? []
  const bo = b.outputs ?? []
  return a.flood === b.flood && a.mist === b.mist
    && ao.length === bo.length && ao.every((code, i) => code === bo[i])
}

/** The spindle a run of moves turns at. */
export interface GcodeSpindleIntent {
  rpm: number
  direction: 'cw' | 'ccw'
  line: number
}

/** One run of moves under one selected WCS. Ordinary coordinates are work
 *  coordinates of `wcs`; a G53 move carries its machine target on the move so
 *  the bridge can stage that one block without applying the work offset. */
export interface GcodeStage {
  wcs: GcodeWcs
  /** Source line of the block that opened this stage. */
  firstLine: number
  moves: GcodeReaderMove[]
  /** Source line for `moves[i]`. */
  moveLines: number[]
  /** G4 pauses in source order. `afterMove` is the number of this stage's
   *  geometric moves that precede the pause, so the machine route can insert
   *  the typed dwell step without re-tokenizing the file. */
  dwells: { line: number; seconds: number; afterMove: number }[]
  ends: GcodeStageEnd
  /** WHETHER THE FILE HAS THE SPINDLE RUNNING WHILE THESE MOVES RUN. A stage
   *  never changes it: an M3 or M5 between two moves ENDS the stage, which is
   *  what gives the executing route an instant to command the inverter at. */
  spindleOn: boolean
  /** THE SPEED AND DIRECTION THESE MOVES RUN AT, or null when the spindle is
   *  off for them. A file may change speed (the architect's re-scope allows it,
   *  because the up-to-speed gate re-arms at every release), and when it does
   *  the change ENDS the stage exactly as a start or a stop does. */
  spindle: GcodeSpindleIntent | null
  /** The tool in the spindle for these moves, or null when the file names none. */
  tool: number | null
  /** The coolant the file has commanded while these moves run. */
  coolant: GcodeCoolantState
  /** An M0/M1 the file states BEFORE this stage's first move, with no motion
   *  of its own between - the hold still belongs to this boundary and is
   *  honoured here rather than dropped for having nothing behind it. */
  heldBefore: { line: number; optional: boolean } | null
  /** A macro call the file states before this stage's first move, with no
   *  motion between. Same rule as `heldBefore` and the same consequence: the
   *  program holds there and names it. */
  macroBefore: { line: number; code: number; toolChange?: number } | null
  /** A tool change the file states before this stage's first move, with no
   *  motion between - which is where EVERY real post puts one, because the
   *  `M5` and the lift come first. Same rule again: the change still belongs to
   *  this boundary and the program holds at it. */
  toolChangeBefore: { line: number; from: number; to: number } | null
  /** A coolant word the file states before this stage's first move, with no
   *  motion between - which is where every post puts the opening `M8`. The
   *  state is already in `coolant`; what this carries is the LINE, so the route
   *  that commands the output can name where the file asked for it instead of
   *  naming the block that happened to open the stage. */
  coolantBefore: ({ line: number; standardCode?: 7 | 8 | 9; listedCommand?: GcodeListedOutputCommand } & GcodeCoolantState) | null
}

/** A word this route honours by doing nothing, and the line it fell on. Said
 *  ONCE on the load line rather than refused (architect re-scope) - the
 *  operator learns it was read and that it changes nothing here. */
export interface GcodeAcceptedWord {
  word: string
  line: number
  note: string
}

export interface GcodeInterpretedProgram {
  stages: GcodeStage[]
  /** Frames in the order the program runs them, one per stage. */
  frames: GcodeWcs[]
  /** Staged moves across every stage - the number the operator is told. */
  moveCount: number
  /** The FIRST spindle intent the file states, which is what the load line
   *  names. `spindleSpeeds` carries every one of them. */
  spindle: GcodeSpindleIntent | null
  /** Every distinct speed/direction the file commands, in the order it does. */
  spindleSpeeds: GcodeSpindleIntent[]
  /** The first tool this program runs on, or null when it names none. */
  tool: number | null
  /** Every tool the file fits, in order. More than one means a tool-change
   *  boundary, which is a HOLD and no longer a refusal. */
  tools: number[]
  /** Coolant the file commands. The geometry wire carries no coolant step, so
   *  the load line SAYS so rather than dropping it silently. */
  coolant: GcodeCoolantState
  /** Legacy diagnostic, now empty: WO-2556 stages final M0/M1 stops too. */
  holdsWithNoMotion: number[]
  /** Every macro call the file makes, in order, whether or not motion follows
   *  it - a macro after the last move still has to be reported, because the
   *  operator has to do it. */
  macros: { line: number; code: number }[]
  /** WO-1652: every `T` word (the preselect) in source order. A macro whose
   *  body calls `toolChange()` fits the tool the file last selected before
   *  its M-code - `T2 M1600` changes to T2 just as `T2 M6` does. */
  preselects: { line: number; tool: number }[]
  /** WO-1652: a code with a standard meaning (M6, M7, ...) that a machine
   *  macro also carries - the program ALWAYS keeps the standard meaning, and
   *  the load line says what the binding does (see the reader). */
  tableCodeMacroBindings: { line: number; code: number }[]
  /** `G64`, `G94` and the rest - read, honoured by doing nothing, said once. */
  accepted: GcodeAcceptedWord[]
  /** The `G43 H<n>` offsets this file applies, so the load line can state the
   *  tool length it resolved instead of leaving it invisible. */
  toolLengthOffsets: { line: number; h: number }[]
}

export type GcodeInterpretResult =
  | { ok: true; program: GcodeInterpretedProgram }
  | { ok: false; refusal: GcodeReadRefusal }

/**
 * THE WORDS THE GEOMETRY ROUTE CANNOT HONOUR, and the sentence each gets.
 *
 * Every one of these is a word the SHARED reader understands and this route
 * cannot execute. They are refused at the block that uses them rather than
 * accepted and dropped, which is the difference between a program that does
 * what the file says and one that does most of it.
 */
const GEOMETRY_ROUTE_REFUSALS: readonly GcodeRefusedWord[] = []

// WHAT IS NOT ON THAT LIST, AND WHY - because each was refused in an earlier
// round of this order and each refusal was wrong:
//
//  - G53. A machine-frame block IS expressible here: the reader resolves it
//    against the CONTROLLER'S OWN REPORTED work offset (work = machine -
//    offset), and the bridge adds exactly that offset back when it stages the
//    move. The round trip is closed, and refusing it turned Operator's own
//    Fusion-posted file away at its first line of motion (`G53 G0 Z128.`).
//  - G81/G82/G83. A canned cycle needs NO new wire vocabulary: the reader
//    expands it into the plain rapids and plunges this route already stages, so
//    a drilled hole reaches the board as the moves that drill it.
//  - G91. INCREMENTAL IS CONVERTED, NOT REFUSED (architect re-scope). The
//    reader tracks the modal state and resolves every block against the
//    position before it, so what this route stages is absolute BY
//    CONSTRUCTION - which is exactly what a program executed by move id needs.
//    Two third-party Fusion files and one of our own died on that refusal for
//    no reason at all.
//  - G43 H / G49. ACCEPTED, AND NEVER A REFUSAL. The H is resolved against the
//    machine's tool table (WO-1677) and the length is folded into every
//    absolute Z it governs, so the staged moves already carry it - the same
//    tip positions UCCNC reaches applying its own table. Three stacked
//    refusals used to guard a constant zero - no library, no matching tool
//    number, H naming a tool other than the fitted one - and every one of
//    them returned zero when it passed. Operator's own Fusion file, which UCCNC
//    runs, died at line 22 on `G43 H19`, and the sentence we printed asked
//    him to renumber his Tool Library to match Fusion so we could hand back
//    the zero we already had.
//  - G28 (WO-1337). A HOME BLOCK IS A RETRACT, and every Fusion post opens and
//    closes with one (`G28 G91 Z0`). On a HOMED machine the reader resolves it
//    the way it resolves G53 - work = machine - offset - so what this route
//    stages is plain rapids to numbers the soft-limit and table checks can
//    see. On an unhomed machine there is no home to go to and it is still
//    refused, at its own line, saying so. Two third-party Fusion files were
//    turned away at their first and seventh lines for this one word.
//  - A HELICAL ARC (WO-1337). Operator's own file stops at line 31 on a `G3` whose
//    Z ramps, and the endpoint Z is a field `ToolpathMove` and the bridge's
//    `AddCircularMoveP` have always carried. It reads as one arc move.
//
//  - G30 (WO-1362). The active machine definition supplies its reference
//    points, and the reader resolves a call into machine-Z then machine-XY
//    rapids using the same G53 execution metadata as an explicit block.

/**
 * Read a posted file into the stages the geometry route runs.
 *
 * On any refusal the result carries NO partial program, exactly as the reader
 * does: a caller cannot accidentally stage the prefix that happened to be
 * understood before the refusing line.
 */
export function interpretGcodeProgram(
  text: string,
  options: GcodeInterpretOptions,
): GcodeInterpretResult {
  const read = readGcodeProgram(text, {
    dialect: options.dialect,
    sessionWcs: options.sessionWcs,
    initialPosition: options.initialPosition,
    machineUnits: options.machineUnits,
    workOffsets: options.workOffsets,
    // A HOMED MACHINE KNOWS WHERE HOME IS, so `G28` resolves into rapids the
    // route already stages. An unhomed one passes nothing and the reader
    // refuses the block - see the note below.
    machineHome: options.machineHome,
    referencePositions: options.referencePositions,
    // THE MACHINE'S OWN DWELL P UNIT (WO-1559): the file's G4/G82 P is seconds
    // or milliseconds according to the active definition when it states
    // `Dwellinseconds`, and the dialect's default only when it does not.
    machineDefinition: options.machineDefinition,
    // `G43 H<n>` IS ANSWERED BY THE MACHINE'S TOOL TABLE (WO-1677): the
    // session passes the lookup, the reader folds tool n's length into the Z
    // it stages, and the load line states what it resolved. See reader.ts.
    toolLengthMm: options.toolLengthMm,
    // WO-3192: and `G49` cancels the length the controller holds in force.
    toolLengthInForceMm: options.toolLengthInForceMm,
    // A user macro is a line this app cannot run. It is REPORTED so the program
    // can hold at it and name it, rather than refused at the door (which turns
    // away a whole Fusion file for one park-position call) or dropped silently
    // (which runs past something the operator was meant to do).
    macroMCodes: 'report',
    refuse: GEOMETRY_ROUTE_REFUSALS,
  })
  if (!read.ok) return read

  const { moves, moveLines, items } = read.program
  const boundM6Lines = new Set((read.program.tableCodeMacroBindings ?? [])
    .filter((binding) => binding.code === 6).map((binding) => binding.line))

  const stages: GcodeStage[] = []
  let wcs = options.sessionWcs
  // The line of the block that OPENED the current stage - the G5x that selected
  // its frame, the M0 that held before it, or its first move. A refusal that
  // names a stage names THAT line, because it is where the operator looks.
  let openLine: number | null = null
  let current: {
    moves: GcodeReaderMove[]
    lines: number[]
    dwells: { line: number; seconds: number; afterMove: number }[]
  } = { moves: [], lines: [], dwells: [] }
  const holdsWithNoMotion: number[] = []
  // THE MACHINE STATE AS THE FILE HAS IT AT THIS BLOCK, and as the stage being
  // accumulated has it. They can only differ at the word that changes one,
  // which is the block that ends the stage - so a stage's moves all run under
  // one state and the route has one instant to command the change at.
  let spindleOn = false
  let spindleIntent: GcodeSpindleIntent | null = null
  let tool: number | null = null
  let coolant: GcodeCoolantState = { flood: false, mist: false }
  let stageSpindleOn = false
  let stageSpindle: GcodeSpindleIntent | null = null
  let stageTool: number | null = null
  let stageCoolant: GcodeCoolantState = { flood: false, mist: false }
  // An M0/M1 with no motion behind it YET. It is not dead until the file ends
  // with no motion after it; until then it is the hold that opens the next
  // stage. Deciding that at the M0 itself is what dropped it.
  let pendingHold: { line: number; optional: boolean } | null = null
  let pendingMacro: { line: number; code: number; toolChange?: number } | null = null
  let pendingToolChange: { line: number; from: number; to: number } | null = null
  let pendingCoolant: GcodeStage['coolantBefore'] = null
  // Opaque macro bodies can change either channel without changing the file's
  // parsed modal state. Only that channel's explicit command establishes it.
  let coolantAfterMacro = false
  const unknownCoolant = { flood: false, mist: false }

  // WO-2556: preserve a start between M6 and a following pause as executable
  // work, so Continue cannot also clear that pause. Without such a pause,
  // keep pre-motion commands together: a later G5x belongs to the M6 hold.
  const pauseBeforeStep: boolean[] = new Array(items.length)
  let nextBoundaryIsPause = false
  for (let index = items.length - 1; index >= 0; index--) {
    pauseBeforeStep[index] = nextBoundaryIsPause
    const kind = items[index].kind
    if (kind === 'pause') nextBoundaryIsPause = true
    else if (kind === 'move' || kind === 'dwell' || kind === 'program-end') nextBoundaryIsPause = false
  }
  let commandOnly = false
  const currentHasSteps = (): boolean => current.moves.length > 0 || current.dwells.length > 0 || commandOnly
  const openStageForStep = (line: number): void => {
    if (currentHasSteps()) return
    stageSpindleOn = spindleOn
    stageSpindle = spindleOn ? spindleIntent : null
    stageTool = tool
    stageCoolant = coolant
    if (openLine === null) openLine = line
  }

  const closeStage = (ends: GcodeStageEnd): void => {
    stages.push({
      wcs,
      firstLine: openLine ?? current.lines[0] ?? 1,
      moves: current.moves,
      moveLines: current.lines,
      dwells: current.dwells,
      ends,
      spindleOn: stageSpindleOn,
      spindle: stageSpindle,
      tool: stageTool,
      coolant: stageCoolant,
      heldBefore: pendingHold,
      macroBefore: pendingMacro,
      toolChangeBefore: pendingToolChange,
      coolantBefore: pendingCoolant,
    })
    current = { moves: [], lines: [], dwells: [] }
    commandOnly = false
    openLine = null
    pendingHold = null
    pendingMacro = null
    pendingToolChange = null
    pendingCoolant = null
  }

  // THE BOUNDARY BEHIND THIS ONE, when nothing has moved since it and it asks
  // the operator to DO something at the machine - fit a cutter, run a macro.
  // Read exactly as the second-stop refusal reads its prior stop: a pending
  // boundary belongs to the stage the next move will open, and a closed stage's
  // `ends` IS the boundary when no move has landed since (a stage is only ever
  // closed with an executable move or dwell in it, so an empty `current` means
  // nothing has run).
  const priorActionBoundary = (): { line: number; what: string } | null => {
    if (pendingToolChange !== null) {
      return { line: pendingToolChange.line, what: `tool change to T${pendingToolChange.to}` }
    }
    if (pendingMacro !== null) {
      return { line: pendingMacro.line, what: `M${pendingMacro.code} macro call` }
    }
    const lastEnd = stages.at(-1)?.ends
    if (lastEnd?.kind === 'tool-change') {
      return { line: lastEnd.line, what: `tool change to T${lastEnd.to}` }
    }
    if (lastEnd?.kind === 'macro') {
      return { line: lastEnd.line, what: `M${lastEnd.code} macro call` }
    }
    return null
  }

  const priorIsBoundSameToolM6 = (): boolean => {
    const last = stages.at(-1)?.ends
    const change = pendingToolChange ?? (last?.kind === 'tool-change' ? last : null)
    return change !== null && change.from === change.to && boundM6Lines.has(change.line)
  }

  // Keep refusing unrelated tool-change collisions rather than merging two
  // cutter responsibilities into one hold. WO-2478's custom macro sequences
  // and shown same-tool M6 bindings use separate fence stages below.
  const refuseCollapsedBoundary = (
    line: number,
    what: string,
    prior: { line: number; what: string },
  ): GcodeInterpretResult => refuse(
    line,
    collapsedBoundaryMessage(what, prior.what, prior.line),
  )

  const spindleSpeeds: GcodeSpindleIntent[] = []
  const tools: number[] = []
  const macros: { line: number; code: number }[] = []
  const accepted: GcodeAcceptedWord[] = []
  const toolLengthOffsets: { line: number; h: number }[] = []
  const noteAccepted = (word: string, line: number, note: string): void => {
    if (accepted.some((entry) => entry.word === word)) return
    accepted.push({ word, line, note })
  }

  for (const [itemIndex, item] of items.entries()) {
    switch (item.kind) {
      case 'move':
        // The stage runs under the state its FIRST move was staged under; any
        // change after that ends the stage below.
        openStageForStep(item.line)
        current.moves.push(moves[item.moveIndex])
        current.lines.push(moveLines[item.moveIndex])
        break

      case 'work-offset':
        // A FRAME CHANGE WITH NOTHING BEHIND IT IS NOT A BOUNDARY. A file that
        // states G54 in its preamble before any motion simply runs in G54, and
        // the G5x line is where that stage begins.
        if (!currentHasSteps()) {
          wcs = item.wcs
          openLine = item.line
          break
        }
        if (item.wcs === wcs) break
        closeStage({ kind: 'frame', line: item.line, next: item.wcs })
        wcs = item.wcs
        openLine = item.line
        break

      case 'pause': {
        // M0/M1 IS THE BOUNDARY WO-1323 ALREADY EXECUTES, minus the frame
        // change. A hold with nothing staged behind it YET is not dead: the
        // motion that follows it is what it holds, so it is carried as the
        // opening hold of the next stage, including a final nonmoving stage.
        if (currentHasSteps()) {
          closeStage({ kind: 'hold', line: item.line, optional: item.optional })
          openLine = item.line
          break
        }
        // NOTHING HAS MOVED SINCE THE LAST STOP, so a second one here would be
        // collapsed into the same single hold and never honoured as its own.
        // The earlier stop is either still pending or is the `ends` of the
        // stage that was closed with no motion since.
        const lastEnd = stages.at(-1)?.ends
        const priorStop = pendingHold
          ?? (lastEnd !== undefined && lastEnd.kind === 'hold'
            ? { line: lastEnd.line, optional: lastEnd.optional }
            : null)
        if (priorStop !== null) {
          return refuse(
            item.line,
            secondStopMessage(priorStop.optional ? 1 : 0, priorStop.line),
          )
        }
        // AN M0 IN THE FILE ALWAYS STOPS THE MACHINE ON ITS OWN (owner ruling 10-04: "if
        // it's there it stops the machine"). Right after a tool change or macro
        // with no motion between, it would otherwise ride on that boundary and be
        // cleared by the same Continue, so it gets its own (motionless) stage.
        if (pendingToolChange !== null || pendingMacro !== null
          || lastEnd?.kind === 'tool-change' || lastEnd?.kind === 'macro') {
          openStageForStep(item.line)
          commandOnly = true
          closeStage({ kind: 'hold', line: item.line, optional: item.optional })
          openLine = item.line
          break
        }
        pendingHold = { line: item.line, optional: item.optional }
        if (openLine === null) openLine = item.line
        break
      }

      case 'macro':
        coolantAfterMacro = true
        unknownCoolant.flood = unknownCoolant.mist = true
        // A MACRO CALL IS A LINE THIS APP CANNOT RUN, and the architect's
        // re-scope is explicit that ignoring it silently is not safe. It is
        // also not a reason to turn away a 110,000-line Fusion file at the
        // door: Fusion's UCCNC post emits exactly one (`M2001`, "Park Position
        // to Screw Down Material"). So the program HOLDS at it, names it by
        // number, and the operator does at the machine what the macro would
        // have done - the same shape as every other hold on this route.
        macros.push({ line: item.line, code: item.code })
        // WO-1652: a macro that runs the tool change (`toolChange()`) fits a
        // tool the operator has to have ready - the one tool list counts it.
        if (item.toolChange !== undefined && !tools.includes(item.toolChange)) tools.push(item.toolChange)
        if (!currentHasSteps()) {
          // WO-2586: the file's stop precedes the macro. Give it a boundary
          // before any macro (including its park motion) can execute.
          if (pendingHold !== null || stages.at(-1)?.ends.kind === 'hold'
            || pendingMacro !== null || stages.at(-1)?.ends.kind === 'macro'
            || priorIsBoundSameToolM6()
            || (stages.length === 0 && priorActionBoundary() === null)) {
            // A leading or adjacent macro gets its own motionless stage. The
            // session's existing fence makes each incoming boundary execute
            // once; no cutting part is released by another action's Continue.
            openStageForStep(item.line)
            closeStage({ kind: 'macro', ...macroBoundaryOf(item) })
            openLine = item.line
            break
          }
          const priorMacroBoundary = priorActionBoundary()
          if (priorMacroBoundary !== null) {
            return refuseCollapsedBoundary(item.line, `an M${item.code} macro call`, priorMacroBoundary)
          }
          pendingMacro = macroBoundaryOf(item)
          if (openLine === null) openLine = item.line
          break
        }
        closeStage({ kind: 'macro', ...macroBoundaryOf(item) })
        openLine = item.line
        break

      case 'spindle': {
        // M3/M4/M5. THEY ARE COMMANDS, NOT COMMENTS. An earlier round accepted
        // M5 and dropped it, so a file that stopped its spindle and then
        // retracted ran that retract with the inverter still commanded on. A
        // spindle word with motion after it ENDS THE STAGE, which is the only
        // instant this route can command the inverter at: moves stream through
        // its live window, so between two stages is where the app gets to speak.
        if (!item.on) {
          if (!spindleOn) break
          spindleOn = false
          if (currentHasSteps()) {
            closeStage({ kind: 'spindle', line: item.line, on: false })
            openLine = item.line
          }
          break
        }
        const startsAfterChange = !currentHasSteps()
          && (pendingToolChange !== null || stages.at(-1)?.ends.kind === 'tool-change')
          && pauseBeforeStep[itemIndex]
        const rpm = item.rpm
        if (rpm === undefined || !(rpm > 0)) {
          return refuse(
            item.line,
            `M${item.direction === 'ccw' ? 4 : 3} starts the spindle with no S speed this program can `
            + 'run at. A speed is never invented here.',
          )
        }
        const direction = item.direction ?? 'cw'
        // TWO SPEEDS IN ONE FILE ARE ALLOWED (architect re-scope). WO-1275's
        // up-to-speed gate re-arms on EVERY release, so a second speed is
        // honoured by the same mechanism the first one is; the one-intent rule
        // belongs to the multi-setup toolpath route and must not leak here.
        const unchanged = spindleOn
          && spindleIntent !== null
          && spindleIntent.rpm === rpm
          && spindleIntent.direction === direction
        if (unchanged) break
        spindleIntent = { rpm, direction, line: item.line }
        if (!spindleSpeeds.some((speed) => speed.rpm === rpm && speed.direction === direction)) {
          spindleSpeeds.push(spindleIntent)
        }
        spindleOn = true
        if (currentHasSteps()) {
          closeStage({ kind: 'spindle', line: item.line, on: true })
          openLine = item.line
        }
        if (startsAfterChange) {
          openStageForStep(item.line)
          commandOnly = true
        }
        break
      }

      case 'tool-select':
        // A T WORD ON ITS OWN IS A PRESELECT, not a change: the cutter in the
        // spindle does not move until M6. The FIRST tool named with no M6 is
        // still the tool the file runs on, because that is what a post that
        // omits M6 means.
        if (tool === null) {
          tool = item.tool
          if (!tools.includes(item.tool)) tools.push(item.tool)
        }
        break

      case 'tool-change': {
        if (!tools.includes(item.tool)) tools.push(item.tool)
        const boundM6 = boundM6Lines.has(item.line)
        const sameTool = tool === null || tool === item.tool
        if (sameTool && !boundM6) {
          tool = item.tool
          break
        }
        // A TOOL CHANGE IS A BOUNDARY, NOT A REFUSAL (architect re-scope). Our
        // own post emits one in the two-setup program the acceptance names, and
        // refusing it turned our own output away at line 86.
        //
        // THE SPINDLE MUST ALREADY BE STOPPED. Nobody fits a cutter into a
        // turning spindle, every UCCNC post emits M5 before M6, and a file that
        // does not is refused HERE rather than held at a boundary this route
        // would have to stop the spindle at on its own authority.
        if (spindleOn) {
          return refuse(
            item.line,
            `changes from T${tool} to T${item.tool} with the spindle still commanded on; no M5 stopped `
            + 'it, and a cutter is never fitted to a turning spindle.',
          )
        }
        if (boundM6) {
          coolantAfterMacro = true
          unknownCoolant.flood = unknownCoolant.mist = true
        }
        const from = tool ?? item.tool
        tool = item.tool
        if (!currentHasSteps()) {
          // WO-2556: an M0 BEFORE M6 belongs to its own stop. The tool-change
          // Continue answers the tool change, never a file pause.
          if (pendingHold !== null || stages.at(-1)?.ends.kind === 'hold'
            || (boundM6 && sameTool && (pendingMacro !== null || stages.at(-1)?.ends.kind === 'macro' || priorIsBoundSameToolM6()))
            || (boundM6 && stages.length === 0 && priorActionBoundary() === null)) {
            openStageForStep(item.line)
            closeStage({ kind: 'tool-change', line: item.line, from, to: item.tool })
            openLine = item.line
            break
          }
          // WHERE EVERY REAL POST PUTS IT: `M5`, a lift, then `T2 M6`. The
          // previous stage was already closed by that `M5`, so the change has
          // no motion behind it - and it is still the boundary the operator
          // fits a cutter at. Carried as the opening tool change of the stage
          // the next motion lands in, exactly as a stop or a macro is.
          const prior = priorActionBoundary()
          if (prior !== null) {
            return refuseCollapsedBoundary(item.line, `a tool change to T${item.tool}`, prior)
          }
          pendingToolChange = { line: item.line, from, to: item.tool }
          if (openLine === null) openLine = item.line
          break
        }
        closeStage({ kind: 'tool-change', line: item.line, from, to: item.tool })
        openLine = item.line
        break
      }

      case 'coolant':
        // EVER COMMANDED, not "on at the end": M8 followed by M9 still means
        // this program expected coolant, which is what the load line reports.
        // The CHANGE ends the stage, so a machine with a coolant output gets
        // the word at the line that states it and not at the end of the file.
        {
          const startsAfterChange = !currentHasSteps()
            && (item.flood || item.mist || (item.outputs?.length ?? 0) > 0)
            && (pendingToolChange !== null || stages.at(-1)?.ends.kind === 'tool-change')
            && pauseBeforeStep[itemIndex]
          const next: GcodeCoolantState = item.outputs === undefined
            ? { flood: item.flood, mist: item.mist }
            : { flood: item.flood, mist: item.mist, outputs: [...item.outputs] }
          const same = sameGcodeCoolantState(coolant, next)
          const code = item.standardCode
          const resolvesUnknown = code === 7 ? unknownCoolant.mist
            : code === 8 ? unknownCoolant.flood
              : code === 9 && (unknownCoolant.flood || unknownCoolant.mist)
          if (code === 7 || code === 9) unknownCoolant.mist = false
          if (code === 8 || code === 9) unknownCoolant.flood = false
          const preserveCommand = coolantAfterMacro && (item.listedCommand !== undefined || resolvesUnknown || !same)
          if (same && !preserveCommand) break
          coolant = next
          if (preserveCommand) {
            // Keep the actual command after all earlier dwell/motion. A
            // dedicated existing command-only fence owns each explicit effect,
            // including listed words whose parsed state survived an opaque
            // macro. No later word or EOF may overwrite that pending effect.
            if (currentHasSteps()) closeStage({ kind: 'coolant', line: item.line, ...coolant })
            openLine = item.line
            openStageForStep(item.line)
            pendingCoolant = { line: item.line, ...coolant,
              ...(code === undefined ? {} : { standardCode: code }),
              ...(item.listedCommand === undefined ? {} : { listedCommand: item.listedCommand }),
            }
            commandOnly = true
            closeStage({ kind: 'coolant', line: item.line, ...coolant })
            openLine = item.line
            break
          }
          if (startsAfterChange) {
            openStageForStep(item.line)
            commandOnly = true
            pendingCoolant = { line: item.line, ...coolant }
            break
          }
        }
        if (currentHasSteps()) {
          closeStage({ kind: 'coolant', line: item.line, ...coolant })
          openLine = item.line
          break
        }
        // NOTHING BEHIND IT YET - the preamble `M8`. The word belongs to the
        // stage the next move opens, and the LINE travels with it so the route
        // names where the file asked rather than where the stage began.
        pendingCoolant = { line: item.line, ...coolant }
        break

      case 'path-control':
        noteAccepted(
          item.mode === 'continuous' ? 'G64' : 'G61',
          item.line,
          item.mode === 'continuous'
            ? 'path blending - a controller hint; this route stages the moves the file states and the '
              + 'board blends them by its own settings'
            : 'exact stop - this route stages the moves the file states and the board decides how it '
              + 'stops between them',
        )
        break

      case 'accepted-no-op':
        noteAccepted(
          item.word,
          item.line,
          item.word === 'G94' ? 'feed per minute - the only feed mode this app has, so it changes nothing'
            : item.word === 'G20' ? 'inch units - coordinates, arc centres and feeds were converted to millimetres'
              : item.word === 'G18' || item.word === 'G19' ? 'non-XY arcs were linearised to 0.05 mm tolerance'
                : item.word === 'G90.1' ? 'absolute arc centres were converted to offsets from each arc start'
                  : item.word === 'G91.1' ? 'incremental arc centres are the reader default'
                    : item.word === 'G93' ? 'inverse-time feed was converted to millimetres per minute for each move'
                      : item.word === 'EOF' ? 'end of text was treated as end of program'
                        : 'read, and changes nothing on this route',
        )
        break

      case 'tool-length-offset':
        if (item.enabled && item.tool !== undefined) {
          toolLengthOffsets.push({ line: item.line, h: item.tool })
        }
        break

      case 'dwell':
        // A DWELL IS EXECUTABLE WORK UNDER THE CURRENT MACHINE STATE. Opening
        // a stage here prevents a later no-motion boundary from carrying the
        // pause across that boundary (for example M5 / G4 / M3) and running it
        // under the state on the far side.
        openStageForStep(item.line)
        current.dwells.push({ line: item.line, seconds: item.seconds, afterMove: current.moves.length })
        noteAccepted(
          `G4 P (${item.seconds}s)`,
          item.line,
          `dwell will execute on the controller for ${item.seconds} seconds`,
        )
        break
      case 'program-end':
        break
    }
  }

  if (currentHasSteps()) {
    closeStage({ kind: 'end' })
  } else {
    // WO-2556: a final M0/M1 still waits for Cycle Start. An empty final
    // stage gives the machine route a stop boundary without adding motion.
    const last = stages.at(-1)
    const pendingBoundM6 = pendingToolChange !== null && boundM6Lines.has(pendingToolChange.line) ? pendingToolChange : null
    const finalBoundM6 = last?.ends.kind === 'tool-change' && boundM6Lines.has(last.ends.line) ? last.ends : null
    if (pendingHold !== null || last?.ends.kind === 'hold' || pendingMacro !== null || last?.ends.kind === 'macro'
      || pendingBoundM6 !== null || finalBoundM6 !== null) {
      openStageForStep(pendingHold?.line ?? pendingMacro?.line ?? pendingBoundM6?.line ?? (last!.ends as { line: number }).line)
      closeStage({ kind: 'end' })
    } else if (last !== undefined && last.ends.kind !== 'end') {
      last.ends = { kind: 'end' }
    }
  }

  if (stages.length === 0) {
    return refuse(
      items.at(-1)?.line ?? 1,
      'the file commands no motion at all, so there is nothing to run.',
    )
  }

  return {
    ok: true,
    program: {
      stages,
      frames: stages.map((stage) => stage.wcs),
      moveCount: stages.reduce((total, stage) => total + stage.moves.length, 0),
      spindle: spindleSpeeds[0] ?? null,
      spindleSpeeds,
      tool: tools[0] ?? null,
      tools,
      coolant: everCommandedCoolant(stages),
      holdsWithNoMotion,
      macros,
      tableCodeMacroBindings: read.program.tableCodeMacroBindings ?? [],
      preselects: items.flatMap((item) => (item.kind === 'tool-select' ? [{ line: item.line, tool: item.tool }] : [])),
      accepted,
      toolLengthOffsets,
    },
  }
}

/** A macro call as a boundary. WO-1652 tightening: the tool the reader counted
 *  for it (its body calls `toolChange()`) rides along, so the session's
 *  tool-change hold follows the macro however it ends - the load line's
 *  "It runs 2 tools" is then never a tool change the program skips. */
function macroBoundaryOf(
  item: { line: number; code: number; toolChange?: number },
): { line: number; code: number; toolChange?: number } {
  return {
    line: item.line,
    code: item.code,
    ...(item.toolChange === undefined ? {} : { toolChange: item.toolChange }),
  }
}

/** Coolant this program EVER commands, across every stage - the load line's
 *  question is "does this file expect coolant", not "is it on at the end". */
function everCommandedCoolant(stages: GcodeStage[]): { flood: boolean; mist: boolean } {
  let flood = false
  let mist = false
  for (const stage of stages) {
    flood = flood || stage.coolant.flood
    mist = mist || stage.coolant.mist
    if (stage.ends.kind === 'coolant') {
      flood = flood || stage.ends.flood
      mist = mist || stage.ends.mist
    }
  }
  return { flood, mist }
}

function refuse(line: number, reason: string): GcodeInterpretResult {
  return { ok: false, refusal: { line, reason, message: `Line ${line}: ${reason}` } }
}
