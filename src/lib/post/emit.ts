// ============================================================
// Emission engine (C-P1a / C-P2 arcs) — PostInput -> G-code lines
// ============================================================
// Walks the assembled section list and produces controller-agnostic G-code
// lines driven by a PostConfig.
//   - rapid moves  -> G0
//   - every feed role (incl. fast_traverse, at its clamped feed) -> G1
//   - arc moves (arc_cw/arc_ccw):
//       * capabilities.arcs === false -> ARC_UNSUPPORTED error, abort. We do
//         NOT linearize and we NEVER throw (ADR-0003).
//       * capabilities.arcs === true  -> G2 (cw) / G3 (ccw) with X/Y/Z + I/J
//         center offsets and a modal F. Before the per-section walk, each
//         operation's dense feed runs are collapsed to lines + arcs via
//         collapsePolyline so straight runs stay G1 and curved runs become arcs.
//
// Coordinates are transformed WORLD -> WORK (toWork) and emitted under the
// active fixture offset. Modal suppression keeps blocks compact; the modal
// memory is force-reset at every section + tool-change boundary so each new
// section opens with a fully-qualified block.
//
// I/J (WO-299): I,J = R^T * (cx - xPrevWorld, cy - yPrevWorld) where cx,cy are the
// arc move's WORLD center, xPrevWorld/yPrevWorld are the PREVIOUS move's WORLD x,y,
// and R^T is the SAME WCS-basis un-rotation toWork applies to the endpoint (coords.ts).
// A translation (wcs.origin) cancels in the difference regardless of rotation, so
// under an identity basis R^T is the identity and this collapses to the old plain
// world-frame subtraction exactly. But under a rotated basis the center and the
// endpoint must rotate together or the emitted centre stops being the true centre
// of the emitted arc — a delta is invariant to the WCS origin, never to its
// rotation. We are always G17/XY, so there is never a K word.

import type { ToolpathMove } from '../../types'
import { applyResolvedMoveFeed } from '../cam/feedrates'
import { assembleSections } from './assemble'
import { collapsePolyline } from './arcfit'
import { arcAsLines, grblArcNeedsLines } from './arcfit/grblPrecision'
import { reconstructDrillCycles } from './cannedCycle'
import type { DrillCycleProgram } from './cannedCycle'
import { toWork, toWorld } from '../program/coords'
import { g10Line } from './coords'
import { dimWord, sWord, unitsWord, word, type PostUnits } from './format'
import { createModalState } from './modal'
import { resolveCoolantWord, resolveVacuum } from './resolve'
import type { PostCapabilities, PostConfig, PostDiagnostic, PostInput, PostMachineAction, PostOperation, EmittedOperationSpan } from './types'
import { callableMachineMacros, machineSafeZ } from '../../types'
import { workholdingStopPark } from '../machine/macros/clampPauseMacro'

// --- arc-collapse fallback literals -----------------------------------------
// Consulted only when capabilities.arcs === true. Each mirrors the per-dialect
// capability/option default so a config that omits the tuning knob still gets a
// sane collapse rather than a crash.
const DEFAULT_ARC_TOLERANCE = 0.05
const DEFAULT_MAX_ARC_RADIUS = 1e4
const DEFAULT_MIN_SWEEP_DEG = 2

interface EmitResult {
  lines: string[]
  diagnostics: PostDiagnostic[]
  operationSpans: EmittedOperationSpan[]
}

// Result of emitting ONE setup's section body (WCS select -> per-op walk ->
// optional trailing retract). A multi-setup orchestrator emits ONE preamble,
// then calls emitSetupSection per setup sharing a single modal, then ONE
// postamble. The single-setup emitProgram is the N=1 composition of this.
interface SectionResult {
  lines: string[]
  safeWorkZ: number
  diagnostics: PostDiagnostic[]
  operationSpans: EmittedOperationSpan[]
}

// WO-2693: the tool's WORK Z after the last motion this emitter wrote, or null
// when the program cannot know it (nothing walked yet, a canned cycle, a park or
// a tool-change macro since). Returns the retract line to write BEFORE a
// spindle-off when the tool is below the height that sequence's own retract
// goes to - a stored path that ended at depth (saved before WO-2693's generator
// fix) must not have its spindle stopped in the cut. A tool already at or
// above that height, or an unknown one, gets nothing: byte-identical output.
function liftBeforeSpindleOff(
  toolWorkZ: number | null,
  retractWorkZ: number,
  xyz: number,
  units: PostUnits,
): string | null {
  if (toolWorkZ === null || !(toolWorkZ < retractWorkZ)) return null
  const retract = dimWord('Z', retractWorkZ, xyz, units)
  if (dimWord('Z', toolWorkZ, xyz, units) === retract) return null
  return `G0 ${retract}`
}

// Per-section knobs. sectionComment, when set, prepends one comment line ahead
// of the WCS select (the single-setup path passes undefined so no extra line is
// produced). trailingRetract, when true, appends a final `G0 Z<safeWorkZ>` after
// the per-op walk (the single-setup path passes false because the postamble's
// emitProgramEnd already does the final retract -- adding one here would break
// byte-identity).
interface SectionOpts {
  sectionComment?: string
  trailingRetract?: boolean
  // ---- cross-section tool + coolant state (multi-setup safety) ----
  // The tool number in the spindle when this section is ENTERED. The per-op walk
  // seeds its prevToolNumber from this so the first op of a section whose tool
  // DIFFERS takes the tool-change path (full ceremony incl. emitToolChange), and
  // a section whose first op tool EQUALS the incoming tool takes the same-tool
  // path (no T#/M3 re-emit). Default null = "empty spindle" (initial load), which
  // is exactly the single-setup behavior.
  prevToolNumber?: number | null
  // Spindle state entering this section. Combined programs thread it beside the
  // tool so a same-tool section can distinguish an unchanged speed from a new
  // speed that must be commanded. Null is the initial empty-spindle state.
  incomingSpindle?: PostOperation['spindle'] | null
  // When true, the section ENTRY emits a pause block (M5, optional M9, M0) BEFORE
  // the WCS select. After an M0 the spindle is stopped, so the same-tool branch
  // restarts it. Default false (single-setup + default combined boundary).
  pauseBefore?: boolean
  // WO-2437: the previous section ended on an operator stop, so the spindle is
  // off; the first same-tool op restarts it exactly as after a pause block.
  incomingSpindleStopped?: boolean
  // Whether coolant was ON when this section is entered (drives the M9 before M0
  // in the pause block, and is the starting coolantWasOn state). Default false.
  incomingCoolantOn?: boolean
  // WHICH accessory words are already running when this section is entered (the
  // fixed vacuum-then-coolant order accessoryOnLines emits). The same-tool branch
  // needs the WORDS, not just the boolean, to tell "this op wants what is already
  // running" from "this op wants something else". Omitted alongside
  // incomingCoolantOn:true means "something is running but this caller did not
  // say what", and the same-tool branch then leaves the accessories exactly as
  // they are rather than guessing.
  incomingAccessories?: string[]
  // Multi-fixture safety: the work-Z height for the INTER-section trailing retract
  // (consumed only when trailingRetract is true). When set, the trailing retract
  // lifts to THIS height instead of this section's local safeWorkZ. The combined
  // orchestrator passes the GLOBAL safe height (max clearance across ALL setups,
  // lifted into world then re-expressed in THIS setup's work frame) so the lift
  // clears the NEXT setup's stock top even when it sits on a taller fixture.
  // Undefined preserves the prior behavior (lift to local safeWorkZ).
  trailingRetractWorkZ?: number
}

// --- safe-Z computation ------------------------------------------------------
// The highest safe retract height for ONE setup, in that setup's WORK coords:
// the max work-Z over all of its operation moves (the clearance plane the CAM
// already used for its own retracts). Shared by the per-section emitter and the
// combined-program global-safe-Z pre-pass so both derive the SAME number.
//
// NEVER expressed via G53/machine Z0: machine zero is the BOTTOM of travel on
// many machines, so a "G53 G0 Z0 retract" would PLUNGE into the work (caught in
// real UCCNC sim). Work-coord retracts are safe on every machine.
function computeSafeWorkZ(input: PostInput): number {
  const { wcs } = input.setup
  const sections = assembleSections(input)
  let safeWorkZ = 0
  let sawMove = false
  for (const s of sections) {
    if (s.kind !== 'operation') continue
    for (const mv of s.op.moves) {
      const wz = toWork(mv, wcs).z
      if (!sawMove || wz > safeWorkZ) {
        safeWorkZ = wz
        sawMove = true
      }
    }
  }
  return safeWorkZ
}

// --- framing units substitution ----------------------------------------------
// The program-frame units word (G20 inch / G21 mm) is part of the dialect's
// programStart line, authored with a `{units}` token so its POSITION among the
// other modal G-codes (G90/G94/G17/.../G64) is dialect-controlled while its
// VALUE is driven by format.units (ADR-0022). For mm this substitutes G21 in the
// exact spot the literal used to sit, so mm output is byte-identical. A line
// without the token passes through unchanged.
function framingLine(raw: string, units: PostUnits): string {
  return raw.replace(/\{units\}/g, unitsWord(units))
}

// --- comment helper ----------------------------------------------------------

function comment(text: string, config: PostConfig): string {
  // Sanitize: in paren style the delimiters ARE parentheses, so any ( ) inside
  // the text would nest and produce invalid g-code (caught by the linter's
  // NESTED_PAREN). Real op names can contain parens, so replace them with
  // square brackets, and collapse newlines that would split the block.
  const safe = text
    .replace(/\(/g, '[')
    .replace(/\)/g, ']')
    .replace(/[\r\n]+/g, ' ')
  return config.capabilities.comment === 'semicolon' ? `; ${safe}` : `( ${safe} )`
}

// --- operator stop helpers (WO-2437) -----------------------------------------

/** The stop's message as the post writes it: LinuxCNC's `(MSG,...)` when the
 *  post asks for it (the GUI shows it), else a comment in the post's style. */
function operatorStopMessageLine(message: string, config: PostConfig): string {
  if (config.options.operatorStopMessage !== 'msg') return comment(message, config)
  const safe = message.replace(/\(/g, '[').replace(/\)/g, ']').replace(/[\r\n]+/g, ' ')
  return `(MSG, ${safe})`
}

/** The move to the machine's own park: `workholdingStopPark`, the one answer
 *  the clamp pause Control runs at M2001 also reads. Both legs G53, Z first unless the park says
 *  otherwise; a park with no Z and no machine safe Z moves X Y only, at the
 *  safe height the stop already retracted to. A machine with no park stops
 *  where it retracted, and the file says so. */
function operatorStopParkLines(
  machine: PostInput['machine'],
  config: PostConfig,
  xyz: number,
  units: PostUnits,
): string[] {
  const park = workholdingStopPark(machine, undefined)
  if (park === null || !Number.isFinite(park.x) || !Number.isFinite(park.y)) {
    return [comment('no park position on this machine - stopping at safe height', config)]
  }
  const z = typeof park.z === 'number' && Number.isFinite(park.z) ? park.z : machineSafeZ(machine)?.z ?? null
  const xyLine = `G53 G0 ${dimWord('X', park.x, xyz, units)} ${dimWord('Y', park.y, xyz, units)}`
  if (z === null) return [xyLine]
  const zLine = `G53 G0 ${dimWord('Z', z, xyz, units)}`
  return park.zFirst === false ? [xyLine, zLine] : [zLine, xyLine]
}

// --- dwell helper ------------------------------------------------------------
// dwellMs option is authored in milliseconds. UCCNC consumes ms directly; GRBL
// consumes seconds, so we convert per capabilities.dwellUnits.
function dwellBlock(ms: number, caps: PostCapabilities): string {
  return caps.dwellUnits === 's' ? `G4 ${word('P', ms / 1000, 3)}` : `G4 ${word('P', ms, 0)}`
}

// Arc-fit each stretch between dwell-carrying moves separately and pass the
// dwell move itself through verbatim, so a collapse can never merge a timed
// pause away. A stream with no dwell collapses exactly as before.
function collapseKeepingDwells(moves: ToolpathMove[], params: Parameters<typeof collapsePolyline>[1]): ToolpathMove[] {
  if (!moves.some((m) => m.dwellMs !== undefined)) return collapsePolyline(moves, params)
  const out: ToolpathMove[] = []
  let start = 0
  moves.forEach((m, i) => {
    if (m.dwellMs === undefined) return
    out.push(...collapsePolyline(moves.slice(start, i), params), { ...m })
    start = i + 1
  })
  out.push(...collapsePolyline(moves.slice(start), params))
  return out
}

function dwellLine(config: PostConfig): string | null {
  const ms = config.options.dwellMs
  if (typeof ms !== 'number' || ms <= 0) return null
  return dwellBlock(ms, config.capabilities)
}

// --- coolant helpers ---------------------------------------------------------
/** WO-1650: the word THIS machine's output list gives the channel - a flood
 *  listed on M108 is posted M108 - and the standard M8/M7 only when the list
 *  names none. The reader learns the same list, so what is posted here is
 *  never a word it refuses. */
function coolantOnLine(coolant: PostOperation['coolant'], machine: PostInput['machine']): string | null {
  return resolveCoolantWord(machine, coolant)
}

/** Guard the separate vacuum channel at the last emission seam. Program-flow,
 * spindle, tool-change, and shared-stop words cannot become an accessory start.
 * Trusted profile-derived M7/M8 mappings are allowed only when the operation is
 * not already using that same word as coolant: one emitted code has one meaning. */
function vacuumOnLine(
  vacuum: PostOperation['vacuum'],
  coolantLine: string | null,
): string | null {
  if (!vacuum || !/^M(?:0|[1-9]\d*)$/.test(vacuum)) return null
  if (vacuum === 'M0' || vacuum === 'M1' || vacuum === 'M2'
    || vacuum === 'M3' || vacuum === 'M4' || vacuum === 'M5' || vacuum === 'M6'
    || vacuum === 'M9' || vacuum === 'M30') return null
  if (vacuum === coolantLine) return null
  return vacuum
}

/** Start order is fixed: dust extraction first, requested coolant second. M9
 * is their shared stop, so shutdown is one accessory-off word after both have
 * stopped rather than two misleading per-channel off commands. */
function accessoryOnLines(
  vacuum: PostOperation['vacuum'],
  coolant: PostOperation['coolant'],
  machine: PostInput['machine'],
): string[] {
  const coolantLine = coolantOnLine(coolant, machine)
  const vacuumLine = vacuumOnLine(vacuum, coolantLine)
  return [vacuumLine, coolantLine].filter((line): line is string => line !== null)
}

/** Are these the same accessory words, in the same fixed order? The order is
 * fixed by accessoryOnLines, so a positional compare is exact. */
function sameAccessories(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((line, i) => line === b[i])
}

function sameSpindle(
  a: PostOperation['spindle'],
  b: PostOperation['spindle'],
): boolean {
  return a.rpm === b.rpm && a.dir === b.dir
}

// --- spindle helper ----------------------------------------------------------
function spindleOnLine(spindle: PostOperation['spindle']): string {
  const code = spindle.dir === 'ccw' ? 'M4' : 'M3'
  return `${code} ${sWord(spindle.rpm)}`
}

// --- main entry --------------------------------------------------------------

/** Shift section-local 1-based line spans into program-level line numbers. */
function shiftSpans(spans: EmittedOperationSpan[], offset: number): EmittedOperationSpan[] {
  return spans.map((span) => ({ ...span, startLine: span.startLine + offset, endLine: span.endLine + offset }))
}

export function emitProgram(
  input: PostInput,
  config: PostConfig,
): EmitResult {
  const lines: string[] = []
  const diagnostics: PostDiagnostic[] = []
  const xyz = config.format.xyzDecimals
  const units = config.format.units
  const modal = createModalState()

  const push = (line: string) => lines.push(line)

  // ---- PREAMBLE ----
  // Optional program-name comment (from the first operation's setup name is
  // not available; we keep this minimal and comment per-op instead). The
  // {units} token in the framing becomes G20/G21 per format.units.
  for (const line of config.framing.programStart) push(framingLine(line, units))

  // ---- SETUP SECTION ----
  // The WCS select (+ optional G10) and the per-op walk live in the reusable
  // section emitter, sharing the modal created above. sectionComment undefined
  // and trailingRetract false keep the single-setup output byte-identical: no
  // extra comment line, and no extra retract (the postamble's emitProgramEnd
  // does the final retract).
  const preambleCount = lines.length
  const section = emitSetupSection(input, config, modal, {
    sectionComment: undefined,
    trailingRetract: false,
    // Single-setup defaults: empty spindle, no entry pause, no incoming coolant.
    // These keep the output byte-identical to the pre-multi-setup behavior.
    prevToolNumber: null,
    pauseBefore: false,
    incomingCoolantOn: false,
  })
  for (const line of section.lines) push(line)
  diagnostics.push(...section.diagnostics)
  const safeWorkZ = section.safeWorkZ
  const operationSpans = shiftSpans(section.operationSpans, preambleCount)

  // If the section aborted (e.g. ARC_UNSUPPORTED), do not emit the postamble:
  // the same early-return behavior the per-op walk had before the extraction.
  if (section.diagnostics.some((d) => d.code === 'ARC_UNSUPPORTED' || d.code === 'ARC_MALFORMED')) {
    return { lines, diagnostics, operationSpans }
  }

  // ---- POSTAMBLE ----
  // In 'custom' end mode the user's verbatim block OWNS the entire end of program
  // (spindle-off, retract, M30): suppress the auto M5/M9/M30 so they are not
  // duplicated. emitProgramEnd emits the user's lines (or fails loud if empty).
  const customEnd = config.options.programEndMode === 'custom'
  if (!customEnd) {
    // WO-2693: a stored path that ended at depth is lifted to the safe height
    // the program end retracts to, before the spindle stops.
    const lift = liftBeforeSpindleOff(section.endWorkZ, safeWorkZ, xyz, units)
    if (lift) push(lift)
    push('M5')
    if (section.coolantWasOn) push('M9')
  }
  emitProgramEnd(push, config, safeWorkZ, xyz, units, diagnostics)
  if (!customEnd) push('M30')

  return { lines, diagnostics, operationSpans }
}

// Thin exported wrapper around the module-internal emitSetupSection so callers
// (and tests) can emit one setup's section body with a shared modal without
// reaching the program-level preamble/postamble. Returns the documented section
// contract; the internal coolant-tracking field is intentionally not surfaced.
export function emitSetupSectionForCaller(
  input: PostInput,
  config: PostConfig,
  modal: ReturnType<typeof createModalState>,
  opts: SectionOpts = {},
): SectionResult {
  const { lines, safeWorkZ, diagnostics, operationSpans } = emitSetupSection(input, config, modal, opts)
  return { lines, safeWorkZ, diagnostics, operationSpans }
}

// --- reusable per-setup section emitter --------------------------------------
// Emits ONE setup's section body using a CALLER-SUPPLIED modal (so a multi-setup
// orchestrator can share one modal across N sections):
//   [optional sectionComment] -> WCS select (+ optional G10) -> per-op walk
//   -> [if trailingRetract: G0 Z<safeWorkZ>]
// It does NOT emit programStart or the postamble (M5/M9/M30/program-end); those
// are owned by the program-level composition. safeWorkZ for THIS input is
// computed and returned so the caller (or trailingRetract) can use it.
function emitSetupSection(
  input: PostInput,
  config: PostConfig,
  modal: ReturnType<typeof createModalState>,
  opts: SectionOpts,
): SectionResult & {
  coolantWasOn: boolean
  accessories: string[] | null
  lastToolNumber: number | null
  spindle: PostOperation['spindle'] | null
  /** WO-2437: the section ended on an operator stop, so the spindle is off. */
  spindleStopped: boolean
  /** WO-2693: the tool's WORK Z where the section left it (null = unknown). */
  endWorkZ: number | null
} {
  const lines: string[] = []
  const diagnostics: PostDiagnostic[] = []
  const { wcs } = input.setup
  const xyz = config.format.xyzDecimals
  const feedDec = config.format.feedDecimals
  const units = config.format.units

  const sections = assembleSections(input)

  // Highest safe retract height in WORK coordinates (the clearance plane the CAM
  // already used for its own retracts). See computeSafeWorkZ for the rationale
  // (work-coord retract, never G53/machine Z0). This LOCAL value is returned to
  // the caller and used for the program-end retract + tool-change retract; the
  // inter-section lift may be overridden by opts.trailingRetractWorkZ.
  const safeWorkZ = computeSafeWorkZ(input)

  // Coolant state ENTERING this section (the pause block + same-tool restart use
  // it; defaults false = single-setup / first section). Updated as ops toggle it.
  let coolantWasOn = opts.incomingCoolantOn ?? false
  // The accessory words currently running, in emission order. null = "on, but
  // this section was not told which words started it" (a caller that carried
  // only the boolean); a transition cannot be computed against an unknown state,
  // so the same-tool branch leaves such a section's accessories alone.
  let activeAccessories: string[] | null =
    opts.incomingAccessories ?? (coolantWasOn ? null : [])
  // Track previous tool number across ops to detect tool changes. SEEDED from the
  // tool already in the spindle (opts.prevToolNumber): null = empty spindle ->
  // the first op takes the initial-load path (single-setup behavior). A non-null
  // seed that DIFFERS from the first op's tool forces the tool-change path so a
  // multi-setup program never cuts with the previous setup's tool still loaded.
  let prevToolNumber: number | null = opts.prevToolNumber ?? null
  let activeSpindle: PostOperation['spindle'] | null = opts.incomingSpindle ?? null
  let aborted = false
  // Set true by the pause block below; consumed by the FIRST op's same-tool
  // branch to restart the spindle the pause stopped. Cleared after one use so a
  // later same-tool op in this section does not redundantly re-emit M3.
  let pendingPauseRestart = opts.incomingSpindleStopped ?? false
  // WO-2023: set when a tool is loaded (the program's first tool, or any tool
  // change). Where the machine sits then is unknown to the program - a park,
  // or the tool setter after an M6 measure - and often LOW, so the next move
  // must lift Z alone before any XY travel. Consumed by the first move walked
  // after it (see emitLiftBeforeTravel); it survives an op that emits no moves.
  let liftBeforeTravel = false
  // WO-2693: where the last walked move left the tool (WORK Z), for the lift
  // before a spindle-off (liftBeforeSpindleOff). Unknown at section entry: a
  // previous section ends on its own trailing retract.
  let toolWorkZ: number | null = null

  const push = (line: string) => lines.push(line)

  // Per-operation source-line spans (1-based, section-local; the program-level
  // composition shifts them by its own line offset). Ops that emit zero lines
  // produce no span entry - only actually-emitted sections are recorded.
  // INVARIANT shared with src/lib/machine/programContext.ts (buildProgramContext):
  // the program context requires one span per resolved section, in order. That
  // holds because buildPostInput's CAM-12 re-add path returns moveless operations
  // to post validation, which refuses them before this emitter runs; if a section
  // ever reaches here and emits nothing, the context build refuses by name.
  const operationSpans: EmittedOperationSpan[] = []
  let spanOpId: string | null = null
  let spanStart = 0
  const closeSpan = () => {
    if (spanOpId === null) return
    const end = lines.length
    if (end >= spanStart) {
      operationSpans.push({ opId: spanOpId, setupId: input.setupId, startLine: spanStart, endLine: end })
    }
    spanOpId = null
  }

  // ---- OPERATOR STOPS (WO-2437) ----
  // Messages grouped by the operation they run before; null = after the last.
  // A stop naming an operation this input does not emit runs at the end.
  const emittedOpIds = new Set(sections.flatMap((s) => (s.kind === 'operation' ? [s.op.op.id] : [])))
  const actionsBefore = new Map<string | null, PostMachineAction[]>()
  const actions: PostMachineAction[] = input.setup.machineActions
    ?? (input.setup.operatorStops ?? []).map((stop) => ({ ...stop, kind: 'operator_stop' }))
  for (const action of actions) {
    const key = action.beforeOpId !== null && emittedOpIds.has(action.beforeOpId) ? action.beforeOpId : null
    actionsBefore.set(key, [...(actionsBefore.get(key) ?? []), action])
  }
  const stoppedBefore = new Set<string>()
  // Retract, stop the spindle (and accessories), park, say the message, halt.
  // The program then carries on as after a pause: the next operation restarts
  // the spindle and lifts Z alone before any XY travel, since the park leaves
  // the machine wherever the machine's own park is.
  const emitOperatorStop = (messages: string[]) => {
    if (config.framing.sectionComment) push(comment('Operator stop', config))
    push(`G0 ${dimWord('Z', safeWorkZ, xyz, units)}`)
    push('M5')
    if (coolantWasOn) push('M9')
    for (const line of operatorStopParkLines(input.machine, config, xyz, units)) push(line)
    for (const message of messages) {
      if (message.trim().length > 0) push(operatorStopMessageLine(message, config))
    }
    const macro = config.options.operatorStopMacro
    const macroWord = typeof macro === 'string' && /^M\d+$/.test(macro.trim()) ? macro.trim() : undefined
    if (macroWord) push(macroWord)
    // UCCNC's M2001 parks and waits for CYCLE START. Other posts and macro
    // words retain the explicit pause, as do absent/invalid macros.
    if (config.id !== 'uccnc' || macroWord !== 'M2001') push('M0')
    coolantWasOn = false
    activeAccessories = []
    pendingPauseRestart = prevToolNumber !== null
    liftBeforeTravel = true
    modal.forceReset()
    toolWorkZ = null // the park leaves the tool wherever the machine parks
  }

  const emitMachineActions = (pending: PostMachineAction[]) => {
    let messages: string[] = []
    const flushStops = () => {
      if (messages.length > 0) emitOperatorStop(messages)
      messages = []
    }
    for (const action of pending) {
      if (action.kind === 'operator_stop') {
        messages.push(action.message)
        continue
      }
      flushStops()
      const macro = callableMachineMacros(input.machine).find((candidate) => candidate.id === action.macroId)
      if (!macro) {
        diagnostics.push({
          level: 'error', code: 'RUN_MACRO_UNAVAILABLE',
          message: `Run macro operation "${action.name}" has no callable macro on "${input.machine.name}". Choose a shown macro with an M-code.`,
        })
        continue
      }
      if (config.framing.sectionComment) push(comment(`${action.name}: ${macro.name}`, config))
      if (macro.mCode === 6) {
        if (prevToolNumber === null) {
          const firstToolNumber = input.setup.operations[0]?.tool.toolNumber
          if (firstToolNumber === undefined) {
            diagnostics.push({ level: 'error', code: 'RUN_MACRO_TOOL_REQUIRED', message: `Run macro operation "${action.name}" uses M6, which needs a selected tool for its tool-change prelude.` })
            continue
          }
          push(`T${firstToolNumber}`)
        }
        // M6 retains its tool-change meaning even when its bound macro is
        // selected as an action. Use the existing tool-change preparation.
        const lift = liftBeforeSpindleOff(toolWorkZ, safeWorkZ, xyz, units)
        if (lift) push(lift)
        push('M5')
        push('M9')
        push(`G0 ${dimWord('Z', safeWorkZ, xyz, units)}`)
        coolantWasOn = false
        activeAccessories = []
      }
      push(`M${macro.mCode}`)
      // A macro can move and change modal/spindle state. Re-establish the
      // program's frame and let the next operation restart its own spindle
      // and accessories, lifting Z before it travels, as after a tool macro.
      push(`${unitsWord(units)} G90 G17 G94`)
      push(`G${wcs.fixtureOffset}`)
      pendingPauseRestart = prevToolNumber !== null
      liftBeforeTravel = true
      modal.forceReset()
      toolWorkZ = null
    }
    flushStops()
  }

  // ---- SECTION HEADER ----
  // Optional section comment (multi-setup orchestrator labels each setup).
  if (opts.sectionComment) push(comment(opts.sectionComment, config))
  // Pause block (multi-setup PAUSE boundary): stop the spindle, turn coolant off
  // if it was on, then halt for the operator. Placed AFTER the section comment but
  // BEFORE the WCS select so the operator sees which setup is next, and so the
  // per-op walk's tool/spindle logic composes cleanly with the restart afterward.
  if (opts.pauseBefore) {
    push('M5')
    if (coolantWasOn) push('M9')
    push('M0')
    coolantWasOn = false
    activeAccessories = []
    pendingPauseRestart = true
  }
  // WCS select: G54..G59 from fixtureOffset.
  push(`G${wcs.fixtureOffset}`)
  if (config.options.writeWorkOffsets) push(g10Line(wcs, config))

  // ---- PER-OP ----
  for (const section of sections) {
    if (section.kind !== 'operation') continue
    if (aborted) break

    closeSpan()
    // WO-2437: a stop placed before this operation runs ahead of its first
    // section (a nest expansion repeats the operation; the stop runs once).
    // Its lines belong to neither operation's span.
    if (!stoppedBefore.has(section.op.op.id)) {
      stoppedBefore.add(section.op.op.id)
      const pending = actionsBefore.get(section.op.op.id)
      if (pending) emitMachineActions(pending)
    }
    const { op, tool, feeds, spindle, coolant, moves, nestExpanded } = section.op
    // Adaptive emits semantic finish/traverse roles without inventing a number.
    // The post owns resolved machine/tool feeds, so materialise those roles here
    // before arc grouping and emission. Unknown feed-less roles stay feed-less.
    const resolvedMoves = moves.map((move) => applyResolvedMoveFeed(move, feeds))
    // WO-2697: the machine's vacuum word is how ITS controller starts the
    // extractor (LienCNC V2: a UCCNC M7 macro on a relay). Post Process may
    // post in any format (WO-2285, "to post for another controller"); in
    // another controller's format that word means something else - GRBL's M7
    // is mist coolant. So the machine's own word goes out only in its own
    // controller's format.
    const vacuum = section.op.vacuum === undefined
      ? (config.id === input.machine.controller ? resolveVacuum(input.machine) : null)
      : section.op.vacuum
    spanOpId = op.id
    spanStart = lines.length + 1
    const toolNumber = tool.toolNumber ?? 0

    // Section comment.
    if (config.framing.sectionComment) push(comment(op.name, config))

    const isFirstTool = prevToolNumber === null
    const isToolChange = !isFirstTool && toolNumber !== prevToolNumber

    if (isFirstTool) {
      // First tool of the program: select, spindle on, optional dwell, coolant.
      push(`T${toolNumber}`)
      push(spindleOnLine(spindle))
      const dwell = dwellLine(config)
      if (dwell) push(dwell)
      const accessories = accessoryOnLines(vacuum, coolant, input.machine)
      if (accessories.length > 0) {
        for (const line of accessories) push(line)
        coolantWasOn = true
      }
      activeAccessories = accessories
      modal.forceReset()
      liftBeforeTravel = true
    } else if (isToolChange) {
      // Spindle off, coolant off, then retract UP to the safe work-clearance
      // height before the change. NOT a G53 machine move: machine Z0 is the
      // BOTTOM of travel on many machines, so "G53 G0 Z0" would PLUNGE (caught
      // in real UCCNC sim). Work-coord retract is safe on every machine.
      // WO-2693: a stored path that ended at depth gets that same retract
      // first, so the spindle never stops in the cut.
      const lift = liftBeforeSpindleOff(toolWorkZ, safeWorkZ, xyz, units)
      if (lift) push(lift)
      push('M5')
      push('M9')
      push(`G0 ${dimWord('Z', safeWorkZ, xyz, units)}`)
      coolantWasOn = false
      activeAccessories = []

      emitToolChange(push, config, toolNumber, diagnostics)
      toolWorkZ = null // a tool-change macro may move the machine

      // Re-assert the work offset before resuming. The retract above is in work
      // coords, but a user tool-change MACRO may move in machine coords (G53/
      // G28) or change the modal WCS; re-selecting the fixture offset keeps the
      // return to work coordinates unambiguous (a harmless no-op otherwise).
      push(`G${wcs.fixtureOffset}`)

      // Restart spindle + restore dwell + coolant.
      push(spindleOnLine(spindle))
      const dwell = dwellLine(config)
      if (dwell) push(dwell)
      const accessories = accessoryOnLines(vacuum, coolant, input.machine)
      if (accessories.length > 0) {
        for (const line of accessories) push(line)
        coolantWasOn = true
      }
      activeAccessories = accessories
      // This branch already restarted the spindle, so a pending pause-restart is
      // satisfied; clear it so no later same-tool op re-emits M3.
      pendingPauseRestart = false
      modal.forceReset()
      liftBeforeTravel = true
    } else {
      // Same tool as the tool already in the spindle: no tool-change ceremony is
      // needed. Spindle state is independent of tool identity, though: a new RPM
      // or direction must still be commanded before this operation's motion.
      // If a pause block ran at section entry it stopped
      // the spindle (and coolant), so restart them before any cut -- otherwise
      // setup 2 would cut with a stopped spindle. Restart only ONCE (the first op
      // after the pause); a later same-tool op must not re-emit M3. Without a
      // pause, keep the existing behavior: just reset the modal for a clean,
      // fully-qualified open.
      if (pendingPauseRestart) {
        push(spindleOnLine(spindle))
        const dwell = dwellLine(config)
        if (dwell) push(dwell)
        const accessories = accessoryOnLines(vacuum, coolant, input.machine)
        if (accessories.length > 0) {
          for (const line of accessories) push(line)
          coolantWasOn = true
        }
        activeAccessories = accessories
        pendingPauseRestart = false
      } else {
        if (activeSpindle !== null && !sameSpindle(spindle, activeSpindle)) {
          push(spindleOnLine(spindle))
          const dwell = dwellLine(config)
          if (dwell) push(dwell)
        }

        if (activeAccessories !== null) {
          // Same tool, no pause: NOTHING above this point stops a running
          // accessory, so an operation that asks for a different accessory state
          // than the one already running has to be given it here. Without this an
          // operation whose contract says the vacuum is off (`vacuum: null`,
          // post/types.ts) would cut with the vacuum still running until the
          // program end - the machine would be doing the opposite of what the
          // operation asked for.
          //
          // M9 is the SHARED stop for both channels, so a change to either one
          // stops both and restarts whatever this operation still wants, in the
          // fixed vacuum-then-coolant order. That is the only truthful way to
          // express "vacuum off, flood still on" on a controller with one
          // accessory-off word.
          //
          // Builder-produced input never reaches this branch with a difference:
          // the coolant request comes from the tool and the vacuum from the
          // machine definition, so a same-tool run asks for the same accessories
          // throughout and its emitted program is byte-identical to before. Only
          // a directly-constructed PostOperation - the case types.ts documents -
          // can change accessories mid-tool.
          const accessories = accessoryOnLines(vacuum, coolant, input.machine)
          if (!sameAccessories(accessories, activeAccessories)) {
            if (activeAccessories.length > 0) push('M9')
            for (const line of accessories) push(line)
            coolantWasOn = accessories.length > 0
            activeAccessories = accessories
          }
        }
      }
      modal.forceReset()
    }

    prevToolNumber = toolNumber
    activeSpindle = spindle

    // ---- MOTION ----
    // When the controller supports arcs, collapse this op's dense feed runs into
    // the minimal set of lines + arcs (collapsePolyline is pure and treats
    // rapid/role/feed boundaries internally). When arcs are off, walk the moves
    // verbatim so output stays byte-identical to the linear-only behavior.
    const caps = config.capabilities

    // Drill canned-cycle branch: when the controller supports canned cycles and
    // this is a drill op, re-derive the native G81/G82/G83 cycle from the
    // expanded move stream and emit one compact block per hole instead of the
    // fully expanded G0/G1 plunge/retract spam.
    // A nest-expanded drill section is a multi-copy stream WITH inter-copy travel
    // already inserted (ADR 0024 Amendment 1). Collapsing it into G81 across
    // copies would silently drop that travel (clamp-crash risk), so skip the
    // canned-cycle reconstruction and emit the verbatim move walk below.
    if (op.type === 'drill' && caps.cannedCycles && !nestExpanded) {
      const recon = reconstructDrillCycles(op, resolvedMoves)
      if (recon.ok) {
        emitDrillCycles(push, recon.program, wcs, modal, xyz, feedDec, units, config)
        // The cycle returns to its own plane, which this walk does not track.
        toolWorkZ = null
        // The canned block already opens with a Z-only rapid to its clearance
        // plane before the first hole's XY, so it satisfies the pending lift.
        liftBeforeTravel = false
        continue // skip the linear walk for this section
      }
      // WO-1926: a shrinking-peck sequence is the same kind of EXPECTED signal —
      // its varying Q cannot fit one G83, so the expanded stream (already
      // correct) is posted; no diagnostic. chip_break likewise.
      if (recon.code !== 'DRILL_CHIP_BREAK_EXPANDED'
          && recon.code !== 'DRILL_PECK_DECREMENT_EXPANDED') {
        // Q3: malformed reconstruction -> structured warning, then fall back to
        // the already-correct expanded linear stream (safe + named, ADR-0003).
        diagnostics.push({
          level: 'warning',
          code: recon.code,
          message: recon.message,
          opId: op.id,
        })
      }
      // chip_break (EXPECTED signal) or malformed (warned): fall through to the
      // existing linear walk below, which emits the correct expanded G0/G1 stream.
    }

    const walkMoves = caps.arcs
      ? collapseKeepingDwells(resolvedMoves, {
          arcTolerance: config.options.arcTolerance ?? DEFAULT_ARC_TOLERANCE,
          minArcRadius: caps.minArcRadius,
          maxArcRadius: caps.maxArcRadius ?? DEFAULT_MAX_ARC_RADIUS,
          minSweepDeg: caps.minSweepDeg ?? DEFAULT_MIN_SWEEP_DEG,
        })
      : resolvedMoves

    // The previous move's WORLD position, threaded into emitMove so an arc can
    // compute I/J as a WCS-rotated delta from world centers. Null until the first move.
    let prevWorld: { x: number; y: number; z: number } | null = null
    for (const mv of walkMoves) {
      if (liftBeforeTravel) {
        emitLiftBeforeTravel(push, mv, wcs, safeWorkZ, xyz, units)
        liftBeforeTravel = false
      }
      const motion = emitMove(push, mv, wcs, modal, xyz, feedDec, units, config, prevWorld, diagnostics, op.id)
      if (motion === 'arc_unsupported') {
        diagnostics.push({
          level: 'error',
          code: 'ARC_UNSUPPORTED',
          message: `Operation "${op.name}" contains an arc move, but the "${config.label}" postprocessor does not support arc output in this phase. Arc emission is not yet implemented.`,
          opId: op.id,
        })
        aborted = true
        break
      }
      if (motion === 'arc_malformed') {
        aborted = true
        break
      }
      // The move's timed pause (ToolpathMove.dwellMs, WO-1516) becomes an explicit
      // G4 right after it, so an expanded drill keeps every G82 bottom dwell.
      if (mv.dwellMs !== undefined && mv.dwellMs !== 0) {
        if (!Number.isFinite(mv.dwellMs) || mv.dwellMs < 0) {
          diagnostics.push({
            level: 'error',
            code: 'DWELL_MALFORMED',
            message: `Operation "${op.name}" has a move with an invalid dwell (${String(mv.dwellMs)} ms); a pause needs a finite non-negative duration.`,
            opId: op.id,
          })
          aborted = true
          break
        }
        push(dwellBlock(mv.dwellMs, caps))
      }
      prevWorld = { x: mv.x, y: mv.y, z: mv.z }
      toolWorkZ = toWork(mv, wcs).z
    }
  }
  closeSpan()

  // If the walk aborted (e.g. ARC_UNSUPPORTED), return what we have. The caller
  // (program composition) skips the postamble when an abort diagnostic is
  // present, mirroring the pre-extraction early return. No trailing retract on
  // an aborted section.
  if (aborted) {
    return { lines, safeWorkZ, diagnostics, operationSpans, coolantWasOn, accessories: activeAccessories, lastToolNumber: prevToolNumber, spindle: activeSpindle, spindleStopped: false, endWorkZ: toolWorkZ }
  }

  // WO-2437: a stop placed after the setup's last operation.
  const trailingActions = actionsBefore.get(null)
  if (trailingActions) emitMachineActions(trailingActions)

  // ---- TRAILING RETRACT ----
  // A multi-setup orchestrator asks for this so the machine lifts to the safe
  // work-clearance height before moving on to the next setup. The single-setup
  // path passes trailingRetract:false because the postamble's emitProgramEnd
  // already does the final retract -- adding one here would break byte-identity.
  if (opts.trailingRetract) {
    // The inter-section lift goes to the GLOBAL safe height when the orchestrator
    // supplied one (expressed in THIS setup's work frame), else this setup's own
    // safeWorkZ. The global value guarantees the lift clears the NEXT setup's
    // stock top even when that setup sits on a taller fixture (higher origin.z).
    const liftZ = opts.trailingRetractWorkZ ?? safeWorkZ
    push(`G0 ${dimWord('Z', liftZ, xyz, units)}`)
    toolWorkZ = liftZ
  }

  return { lines, safeWorkZ, diagnostics, operationSpans, coolantWasOn, accessories: activeAccessories, lastToolNumber: prevToolNumber, spindle: activeSpindle, spindleStopped: trailingActions !== undefined, endWorkZ: toolWorkZ }
}

// --- multi-setup composition -------------------------------------------------
// Compose N PostInputs into ONE program: a single programStart preamble, one
// section per input sharing ONE modal, and one program end. This is the N>=1
// generalization of emitProgram (which is the N=1 case kept byte-identical).
//
// Section/boundary contract:
//   programStart                              (ONCE)
//   section[0]   trailingRetract = (N > 1)    (lift before the next setup)
//   section[1]   prevToolNumber = carryTool, pauseBefore = pauseBetweenSetups
//   ...
//   section[N-1] trailingRetract = false      (postamble does the final retract)
//   postamble    M5 / M9(if carryCoolant) / emitProgramEnd / M30   (ONCE)
//
// Tool + coolant state is THREADED across sections (the safety fix). carryTool is
// the tool number in the spindle entering each section; carryCoolant is whether
// coolant is on. emitSetupSection seeds its per-op walk from these, so:
//   - A section whose first op uses a DIFFERENT tool than carryTool takes the
//     tool-change path (M5/M9/retract + emitToolChange ceremony + WCS re-select +
//     spindle restart) -> the program NEVER cuts setup i+1 with setup i's tool.
//   - A section whose first op uses the SAME tool takes the same-tool path: no
//     redundant T#/M3 re-emit (and, under PAUSE, a spindle restart because the
//     M0 stopped it).
// The PAUSE block (M5 / M9-if-coolant / M0) is emitted INSIDE the section at its
// entry via pauseBefore, so the spindle restart composes with the tool logic.
// Redundant safety codes (e.g. a double M5 when a different-tool section also
// follows a pause) are ACCEPTABLE; correctness over terseness.
export function emitCombinedProgram(
  inputs: PostInput[],
  config: PostConfig,
  opts: { pauseBetweenSetups: boolean; sectionComments?: string[] },
): EmitResult {
  const lines: string[] = []
  const diagnostics: PostDiagnostic[] = []
  const xyz = config.format.xyzDecimals
  const units = config.format.units
  const modal = createModalState()
  const push = (line: string) => lines.push(line)
  const operationSpans: EmittedOperationSpan[] = []

  // ---- PREAMBLE (ONCE) ---- ({units} -> G20/G21 per format.units)
  for (const line of config.framing.programStart) push(framingLine(line, units))

  const n = inputs.length

  // ---- GLOBAL SAFE Z (multi-fixture retract safety) ----
  // Each setup's safe clearance height is WORK-relative to its OWN WCS. When the
  // setups sit at different origin.z (taller fixture / higher stock), one setup's
  // work-clearance can be BELOW the next setup's stock top in MACHINE space, so an
  // inter-setup XY rapid at that height could crash. Fix: retract between offsets
  // to a GLOBAL safe height -- the MAX clearance across ALL setups, taken in a
  // COMMON world/machine frame. Per setup: safeWorkZ (work) -> toWorld -> world Z;
  // the program-wide max is globalSafeWorldZ. Each inter-section lift then converts
  // this back into the OUTGOING setup's work frame via toWork, so the emitted Z is
  // a work-coord G0 (never G53) that still clears every setup's stock top.
  //
  // When all setups share the same clearance height AND origin.z, globalSafeWorldZ
  // equals each setup's local safeWorkZ once converted back, so the inter-section
  // retract Z is byte-identical to the prior per-setup behavior.
  let globalSafeWorldZ = -Infinity
  for (const input of inputs) {
    const worldZ = toWorld({ x: 0, y: 0, z: computeSafeWorkZ(input) }, input.setup.wcs).z
    if (worldZ > globalSafeWorldZ) globalSafeWorldZ = worldZ
  }

  // safeWorkZ of the LAST emitted section feeds the postamble's final retract,
  // mirroring emitProgram (which uses the single section's safeWorkZ).
  let lastSafeWorkZ = 0
  // WO-2693: where the LAST section left the tool, in its work frame.
  let lastEndWorkZ: number | null = null
  // Threaded state: the tool in the spindle, and whether coolant is on, ENTERING
  // the next section. carryTool=null means an empty spindle (section 0 takes the
  // initial-load path). After each section they advance to that section's final
  // state so the next section's first op composes its tool/spindle/coolant logic
  // correctly (the safety fix: a different tool forces a real tool change).
  let carryTool: number | null = null
  let carrySpindle: PostOperation['spindle'] | null = null
  let carryCoolant = false
  // WO-2437: the previous section ended on an operator stop (spindle off).
  let carrySpindleStopped = false
  // Which accessory words are running entering the next section, so a same-tool
  // first op can tell "already running what I want" from "wants something else".
  // null = on but unknown, which no section produced by this loop ever is.
  let carryAccessories: string[] | null = []

  // ---- SECTIONS (shared modal) ----
  for (let i = 0; i < n; i++) {
    const isLast = i === n - 1
    const section = emitSetupSection(inputs[i], config, modal, {
      sectionComment: opts.sectionComments?.[i],
      // Every section EXCEPT the last lifts to the GLOBAL safe height before the
      // program moves on; the last relies on the postamble's retract. The global
      // world-frame height is converted into THIS setup's work frame so the lift
      // clears the next setup's stock top even on a taller fixture.
      trailingRetract: !isLast,
      trailingRetractWorkZ: isLast
        ? undefined
        : toWork({ x: 0, y: 0, z: globalSafeWorldZ }, inputs[i].setup.wcs).z,
      // Thread the tool/coolant state from the prior section. The PAUSE block is
      // emitted INSIDE the section (pauseBefore) so the spindle restart composes
      // with the per-op tool logic. Section 0 never pauses (i > 0 guard).
      prevToolNumber: carryTool,
      incomingSpindle: carrySpindle,
      pauseBefore: opts.pauseBetweenSetups && i > 0,
      incomingCoolantOn: carryCoolant,
      incomingSpindleStopped: carrySpindleStopped,
      incomingAccessories: carryAccessories ?? undefined,
    })
    const sectionOffset = lines.length
    for (const line of section.lines) push(line)
    operationSpans.push(...shiftSpans(section.operationSpans, sectionOffset))
    diagnostics.push(...section.diagnostics)
    lastSafeWorkZ = section.safeWorkZ
    lastEndWorkZ = section.endWorkZ

    // Abort (mirror emitProgram): on an arc abort, return WITHOUT the postamble.
    if (section.diagnostics.some((d) => d.code === 'ARC_UNSUPPORTED' || d.code === 'ARC_MALFORMED')) {
      return { lines, diagnostics, operationSpans }
    }

    // Advance the carried state for the next section. No manual boundary M5/M0
    // here anymore -- the pause is handled inside the next section via pauseBefore.
    carryTool = section.lastToolNumber
    carrySpindle = section.spindle
    carrySpindleStopped = section.spindleStopped
    carryCoolant = section.coolantWasOn
    carryAccessories = section.accessories
  }

  // ---- POSTAMBLE (ONCE) ----
  // Custom end mode owns spindle-off/retract/M30; honor it exactly ONCE at the
  // very end (suppress the auto M5/M9/M30), mirroring emitProgram. M9 only when
  // coolant is still on at program end (carryCoolant after the last section).
  const customEnd = config.options.programEndMode === 'custom'
  if (!customEnd) {
    // WO-2693: lift a stored path that ended at depth before the spindle stops.
    const lift = liftBeforeSpindleOff(lastEndWorkZ, lastSafeWorkZ, xyz, units)
    if (lift) push(lift)
    push('M5')
    if (carryCoolant) push('M9')
  }
  emitProgramEnd(push, config, lastSafeWorkZ, xyz, units, diagnostics)
  if (!customEnd) push('M30')

  return { lines, diagnostics, operationSpans }
}

// --- drill canned-cycle emission ---------------------------------------------
// Render a reconstructed DrillCycleProgram as a native canned cycle: a rapid to
// the initial (clearance) plane, then one G81/G82/G83 block per hole with the
// G-word/R/Q/P/F set on the first hole and modal-suppressed thereafter, closed
// by G80. The canned block bypasses the modal state machine, so we force-reset
// the modal memory afterward (the next section opens fully-qualified).

function emitDrillCycles(
  push: (line: string) => void,
  program: DrillCycleProgram,
  wcs: PostInput['setup']['wcs'],
  modal: ReturnType<typeof createModalState>,
  xyz: number,
  feedDec: number,
  units: PostUnits,
  config: PostConfig,
): void {
  // Rapid to the initial (clearance) plane so a G98 return goes back to a safe
  // height. Transform the WORLD initial Z into WORK Z.
  const initialWorkZ = toWork({ x: 0, y: 0, z: program.initialZ }, wcs).z
  push(`G0 ${dimWord('Z', initialWorkZ, xyz, units)}`)

  // The R approach plane in WORK coords (constant across all holes).
  const rWorkZ = toWork({ x: 0, y: 0, z: program.rPlaneZ }, wcs).z

  // Dwell P-word formatting depends on the controller's dwell units. params.dwell
  // is in SECONDS: UCCNC wants milliseconds, GRBL/LinuxCNC want seconds.
  const dwellWord = (sec: number): string =>
    config.capabilities.dwellUnits === 'ms'
      ? word('P', sec * 1000, 0)
      : word('P', sec, 3)

  let prevWorkZ: number | null = null
  program.holes.forEach((h, i) => {
    const w = toWork({ x: h.x, y: h.y, z: h.bottomZ }, wcs)
    if (i === 0) {
      const parts: string[] = [
        program.returnMode,
        program.gWord,
        dimWord('X', w.x, xyz, units),
        dimWord('Y', w.y, xyz, units),
        dimWord('Z', w.z, xyz, units),
        dimWord('R', rWorkZ, xyz, units),
      ]
      // Q is the peck increment (a DEPTH) -> converts like a coordinate. The
      // dwell P is a TIME -> never converts (dwellWord handles units of time).
      if (program.peckQ !== undefined) parts.push(dimWord('Q', program.peckQ, xyz, units))
      if (program.dwellSec !== undefined) parts.push(dwellWord(program.dwellSec))
      // F is mm/min -> IPM (/25.4) for inch, via the same conversion.
      parts.push(dimWord('F', program.feed, feedDec, units))
      push(parts.join(' '))
    } else {
      // Subsequent holes: X/Y always; Z only when this hole's bottom differs from
      // the previous (Z is modal in a canned cycle). The G-word/R/Q/P/F are modal
      // and never repeated.
      const parts: string[] = [dimWord('X', w.x, xyz, units), dimWord('Y', w.y, xyz, units)]
      if (prevWorkZ === null || Math.abs(w.z - prevWorkZ) > 1e-9) {
        parts.push(dimWord('Z', w.z, xyz, units))
      }
      push(parts.join(' '))
    }
    prevWorkZ = w.z
  })

  // Cancel the canned cycle. The block bypassed modal tracking, so reset modal
  // memory: the next section must open with a fully-qualified block.
  push('G80')
  modal.forceReset()
}

// --- tool-change emission ----------------------------------------------------

function emitToolChange(
  push: (line: string) => void,
  config: PostConfig,
  toolNumber: number,
  diagnostics: PostDiagnostic[],
): void {
  const mode = config.capabilities.toolChange
  switch (mode) {
    case 'm6':
      push(`T${toolNumber} M6`)
      break
    case 'pause':
      // GRBL etc.: no M6 — announce the change in a comment, pause below.
      push(comment(`change tool to T${toolNumber}`, config))
      break
    case 'macro': {
      const macro = config.options.toolChangeMacro
      if (typeof macro !== 'string' || macro.trim().length === 0) {
        // Fail loud (ADR 0003): no silent fallback to a bare T#.
        diagnostics.push({
          level: 'error',
          code: 'TOOL_CHANGE_MACRO_MISSING',
          message:
            "toolChange 'macro' requires options.toolChangeMacro (the verbatim tool-change lines).",
        })
        return
      }
      for (const raw of macro.split('\n')) {
        push(raw.replace(/\{tool\}/g, String(toolNumber)))
      }
      break
    }
    case 'none':
      push(`T${toolNumber}`)
      break
  }
  // A manual M0 pause lets the operator act where nothing else stops for the
  // change. After `T# M6` it is redundant - the M6 IS the tool-change stop
  // (LienCAM holds there; a controller's M6 macro pauses) - so it is never
  // written (owner ruling 10-04: "if the m0 is redundant don't put it in"). A 'pause'
  // machine (no M6) needs it; a 'macro' machine follows toolChangePause.
  // 'none' never pauses.
  if (mode === 'pause' || (mode === 'macro' && config.options.toolChangePause !== false)) push('M0')
}

// --- program-end emission ----------------------------------------------------

function emitProgramEnd(
  push: (line: string) => void,
  config: PostConfig,
  safeWorkZ: number,
  xyz: number,
  units: PostUnits,
  diagnostics: PostDiagnostic[],
): void {
  const mode = config.options.programEndMode
  switch (mode) {
    case 'safe_z_only':
      // Retract UP to the safe work-clearance height, leave XY. Safest default:
      // no machine-coord move, so it cannot plunge to machine zero. The operator
      // homes/parks afterward.
      push(`G0 ${dimWord('Z', safeWorkZ, xyz, units)}`)
      break
    case 'machine_coords': {
      const z = config.options.programEndMachineZ
      const x = config.options.programEndMachineX
      const y = config.options.programEndMachineY
      if (typeof z !== 'number' || typeof x !== 'number' || typeof y !== 'number') {
        diagnostics.push({
          level: 'error',
          code: 'PROGRAM_END_COORDS_MISSING',
          message:
            "programEndMode 'machine_coords' requires programEndMachineX/Y/Z options to be set.",
        })
        return
      }
      // G53 machine coords are still canonical mm; under G20 the controller reads
      // them as inches, so convert at the same dimensioned seam.
      push(
        `G53 G0 ${dimWord('X', x, xyz, units)} ${dimWord('Y', y, xyz, units)} ${dimWord('Z', z, xyz, units)}`,
      )
      break
    }
    case 'home': {
      const home = config.options.homeCommand
      push(typeof home === 'string' && home.length > 0 ? home : 'G28')
      break
    }
    case 'custom': {
      const custom = config.options.programEndCustom
      if (typeof custom !== 'string' || custom.trim().length === 0) {
        // Fail loud (ADR 0003): no silent fallback. Mirrors PROGRAM_END_COORDS_MISSING.
        diagnostics.push({
          level: 'error',
          code: 'PROGRAM_END_CUSTOM_MISSING',
          message:
            "programEndMode 'custom' requires options.programEndCustom (the verbatim end-of-program lines).",
        })
        return
      }
      for (const raw of custom.split('\n')) {
        const line = raw.replace(/\r$/, '')
        if (line.trim().length > 0) push(line)
      }
      break
    }
  }
}

// --- lift before travel (WO-2023) --------------------------------------------
// After a tool is loaded the machine may sit anywhere, often low (a park, the
// tool setter after an M6 measure). A first move of `G0 X.. Y.. Z15` from there
// travels diagonally while climbing. So ahead of that move: a Z-only rapid to
// the clearance height, then - only when the move does not already travel at
// that height - an XY-only rapid at it. The move itself is then emitted
// unchanged (the modal was reset, so it stays fully qualified) and what is
// left of it is a pure XY move or a pure descent. These lines bypass the modal
// on purpose: the move after them re-emits every word, so the modal memory
// stays exactly what it was before this was added.
function emitLiftBeforeTravel(
  push: (line: string) => void,
  mv: ToolpathMove,
  wcs: PostInput['setup']['wcs'],
  safeWorkZ: number,
  xyz: number,
  units: PostUnits,
): void {
  const w = toWork(mv, wcs)
  const liftZ = dimWord('Z', Math.max(safeWorkZ, w.z), xyz, units)
  push(`G0 ${liftZ}`)
  const isArc = mv.type === 'arc_cw' || mv.type === 'arc_ccw'
  if (isArc) return
  if (mv.type === 'rapid' && dimWord('Z', w.z, xyz, units) === liftZ) return
  push(`G0 ${dimWord('X', w.x, xyz, units)} ${dimWord('Y', w.y, xyz, units)}`)
}

// --- single-move emission ----------------------------------------------------

type MoveResult = 'ok' | 'arc_unsupported' | 'arc_malformed'

function emitMove(
  push: (line: string) => void,
  mv: ToolpathMove,
  wcs: PostInput['setup']['wcs'],
  modal: ReturnType<typeof createModalState>,
  xyz: number,
  feedDec: number,
  units: PostUnits,
  config: PostConfig,
  prevWorld: { x: number; y: number; z: number } | null,
  diagnostics: PostDiagnostic[],
  opId: string,
): MoveResult {
  const caps = config.capabilities
  const isArc = mv.type === 'arc_cw' || mv.type === 'arc_ccw'

  if (isArc) {
    // Arc with arcs disabled -> fail loud, do not linearize (unchanged behavior).
    if (!caps.arcs) return 'arc_unsupported'

    // Arc with arcs enabled but missing geometry -> fail loud (ADR-0003); never
    // emit a malformed arc. Need both centers and a predecessor for I/J.
    if (typeof mv.cx !== 'number' || typeof mv.cy !== 'number' || prevWorld === null) {
      diagnostics.push({
        level: 'error',
        code: 'ARC_MALFORMED',
        message:
          `An arc move is missing its center (cx/cy) or a preceding position, so I/J ` +
          `cannot be computed. Refusing to emit a malformed arc.`,
        opId,
      })
      return 'arc_malformed'
    }

    const w = toWork(mv, wcs)
    // Center offsets I/J are a DELTA (center minus the previous move's WORLD
    // position), so they are invariant to wcs.origin exactly like the old
    // comment said - but NOT to wcs rotation: a delta still has to un-rotate
    // by the same R^T the endpoint gets, or the emitted centre and the emitted
    // endpoint stop describing the same arc the moment the basis is not
    // identity. Rotate here (no origin term - dot() would only add zero for a
    // delta) rather than reuse toWork, which subtracts wcs.origin. Under an
    // identity basis xAxis=(1,0,0)/yAxis=(0,1,0) so this is byte-identical to
    // the old world-difference formula. Always emit both (centers are not
    // modal). G17/XY only -> no K word, so only xAxis/yAxis (not zAxis)
    // contribute. I/J are a length DELTA -> convert at the same dimensioned
    // seam (dimWord).
    const dcx = mv.cx - prevWorld.x
    const dcy = mv.cy - prevWorld.y
    const i = wcs.xAxis.x * dcx + wcs.xAxis.y * dcy
    const j = wcs.yAxis.x * dcx + wcs.yAxis.y * dcy
    const grbl = config.id === 'grbl' || config.id === 'grblhal'
    // WO-2313: native helices bypass arc fitting and may have radii far below
    // minArcRadius. Test their WRITTEN endpoints and offsets at the last seam.
    // Do this before changing modal state, so a G1 fallback cannot inherit G2/3.
    if (grbl && grblArcNeedsLines(toWork(prevWorld, wcs), w, i, j, xyz, units)) {
      for (const line of arcAsLines(prevWorld, mv, config.options.arcTolerance ?? DEFAULT_ARC_TOLERANCE)) {
        emitMove(push, line, wcs, modal, xyz, feedDec, units, config, prevWorld, diagnostics, opId)
      }
      return 'ok'
    }

    const parts: string[] = []
    const motion = modal.motionWord(mv.type === 'arc_cw' ? 'G2' : 'G3')
    if (motion) parts.push(motion)
    const coords = modal.coordWords(w.x, w.y, w.z, xyz, units)
    // GRBL requires an X or Y even for a full circle (or a Z-only helix).
    // Keep modal memory intact; repeat just X when both plane words suppressed.
    if (grbl && !coords.some(c => c.startsWith('X') || c.startsWith('Y'))) {
      coords.unshift(dimWord('X', w.x, xyz, units))
    }
    parts.push(...coords)
    parts.push(dimWord('I', i, xyz, units))
    parts.push(dimWord('J', j, xyz, units))

    // Arcs are feed moves -> emit F modally, exactly like G1.
    if (typeof mv.feed === 'number') {
      const f = modal.feedWord(mv.feed, feedDec, units)
      if (f) parts.push(f)
    }

    push(parts.join(' '))
    return 'ok'
  }

  const w = toWork(mv, wcs)
  const isRapid = mv.type === 'rapid'
  const motionMode = isRapid ? 'G0' : 'G1'

  const parts: string[] = []
  const motion = modal.motionWord(motionMode)
  if (motion) parts.push(motion)

  const coords = modal.coordWords(w.x, w.y, w.z, xyz, units)
  parts.push(...coords)

  // Feed moves carry an F word (modal-suppressed). Every non-rapid role,
  // including fast_traverse, emits G1 at its move.feed.
  if (!isRapid && typeof mv.feed === 'number') {
    const f = modal.feedWord(mv.feed, feedDec, units)
    if (f) parts.push(f)
  }

  // A block with only a (suppressed-away) motion word and no coords is a no-op;
  // skip emitting an empty line. But if the motion mode itself changed we still
  // want the bare mode word, which is already in parts.
  if (parts.length > 0) push(parts.join(' '))
  return 'ok'
}
