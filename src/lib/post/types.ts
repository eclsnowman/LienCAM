// ============================================================
// Postprocessor contract types (Group C, C-P0 scaffolding)
// ============================================================
// Honors ADR-0001 (post imports only shared src/types, never operation
// internals) and ADR-0003 (failures surface as structured diagnostics,
// never thrown). NO G-code emission in C-P0 — these are the declarative
// shapes the emitter (C-P1) consumes.

import type {
  MachineConfig,
  MachineMCode,
  Operation,
  PhysicalStock,
  Tool,
  ToolpathMove,
  WCS,
} from '../../types'
import type { ResolvedFeedrates } from '../cam/feedrates'

// --- Input bundle ---

/** A single operation prepared for emission: the source op plus everything
 *  the post needs that the op itself does not carry (resolved feeds, spindle,
 *  coolant, vacuum, the tool). Moves are WORLD coords; world->work transform
 *  happens at emission time. */
export interface PostOperation {
  op: Operation
  tool: Tool
  feeds: ResolvedFeedrates
  spindle: { rpm: number; dir: 'cw' | 'ccw' }
  /** Semantic coolant request from the tool. Vacuum is deliberately separate:
   * a combined machine may run both, and neither channel may outrank the other. */
  coolant: 'none' | 'flood' | 'mist' | 'air'
  /** Vacuum start word for this operation. `undefined` inherits the machine
   * definition (the existing builder compatibility path); null explicitly
   * disables vacuum for a directly constructed operation. */
  vacuum?: MachineMCode | null
  moves: ToolpathMove[]
  /** True when these moves are a NEST EXPANSION section (multi-copy stream with
   *  inter-copy travel already generated upstream, ADR 0024 Amendment 1). The
   *  drill canned-cycle branch must NOT collapse such a stream into G81 across
   *  copies — that would drop the deliberately-inserted inter-copy travel — so it
   *  falls through to the verbatim move walk. Absent/false for normal ops, which
   *  keep their canned-cycle behavior byte-identical. */
  nestExpanded?: boolean
  /** WO-2019: the library tool has no number, so `tool.toolNumber` is the one
   *  buildPostInput gave it (assignedToolNumbers). Absent for numbered tools. */
  toolNumberAssigned?: true
}

/** WO-2437: an operator stop as the post sees it, already resolved onto an
 *  operation this input emits (or null = after the last one). */
export interface PostOperatorStop {
  beforeOpId: string | null
  message: string
}

/** WO-2870: an operation with nothing left to cut. It posts no motion, only
 *  one line saying so, placed before `beforeOpId` (null = after the last). */
export interface PostNothingToCut {
  opId: string
  name: string
  beforeOpId: string | null
}

/** Ordered machine actions; positions are resolved onto emitted operations. */
export type PostMachineAction =
  | (PostOperatorStop & { kind: 'operator_stop' })
  | { kind: 'run_macro'; beforeOpId: string | null; macroId: string; name: string }

/** The complete, store-detached input to a post run. */
export interface PostInput {
  machine: MachineConfig
  setup: {
    wcs: WCS
    operations: PostOperation[]
    /** WO-2437: retract -> park -> stop blocks between operations. Absent for
     *  a setup with none, which keeps its output byte-identical. */
    operatorStops?: PostOperatorStop[]
    /** When present, replaces operatorStops and preserves mixed action order. */
    machineActions?: PostMachineAction[]
    /** WO-2870: operations left out of `operations` because they have nothing
     *  left to cut. Absent when there are none (byte-identical output). */
    nothingToCut?: PostNothingToCut[]
  }
  stocks?: PhysicalStock[]
  /** The owning setup id, threaded by buildPostInput so emitted operation spans
   *  can name their setup. Optional for legacy/direct PostInput construction. */
  setupId?: string
}

// --- Dialect capability declaration ---

export interface PostCapabilities {
  arcs: boolean
  arcFullCircle: boolean
  arcCenterMode: 'ijk' | 'r'
  cannedCycles: boolean
  toolChange: 'm6' | 'pause' | 'none' | 'macro'
  workOffsets: { g54_59: boolean; extended: boolean; g10: boolean }
  feedMode: 'g94' | 'g93-supported'
  comment: 'paren' | 'semicolon'
  /** Arcs fitted tighter than this radius (mm) are emitted as lines instead. */
  minArcRadius: number
  /** Arcs fitted larger than this radius (mm) are emitted as lines (a huge-radius
   *  arc is numerically a line). Optional; the arc-collapse stage defaults it. */
  maxArcRadius?: number
  /** Arcs sweeping less than this angle (deg) are emitted as lines (too small to
   *  be meaningful / risk IJK round-off). Optional; collapse defaults it. */
  minSweepDeg?: number
  /** Controller line limit (characters, excluding the newline). Declared per
   *  post; the motion emitter does not enforce it today, but the program-context
   *  envelope (WO-381) wraps every comment line within it (default 80 when unset). */
  maxLineLength?: number
  /** Dwell argument units for G4 P-words. UCCNC uses milliseconds; GRBL uses
   *  seconds. The engine formats the dwell value accordingly. */
  dwellUnits: 'ms' | 's'
  /** WO-381: readiness for the portable program-context envelope - the comment-
   *  only LCX1 block written after program end. ABSENT means not certified: the
   *  export toggle is off and disabled (fail closed). A post declares
   *  `{ ready: true, maxLineLength }` only after its row in
   *  docs/research/post-context-compatibility-matrix.md records and tests its
   *  comment delimiters, embedded-character escaping, maximum safe line length,
   *  after-M30 handling and import round trip. User-authored posts cannot declare
   *  it (the user-post parser does not read it), so they never emit a block. */
  programContextEnvelope?: ProgramContextEnvelopeCapability
}

/** See PostCapabilities.programContextEnvelope. */
export interface ProgramContextEnvelopeCapability {
  ready: boolean
  /** Maximum safe line length (characters) certified for this post's comment
   *  lines; every envelope line is wrapped within it. */
  maxLineLength: number
}

// --- Program-end behavior (selectable, declarative) ---

/** safe_z_only = retract to safe Z, leave XY where they are.
 *  machine_coords = G53 G0 to a fixed machine point.
 *  home = issue the controller home command.
 *  custom = emit user-authored verbatim end-of-program lines. */
export type ProgramEndMode = 'safe_z_only' | 'machine_coords' | 'home' | 'custom'

/** Declarative emission knobs. Extensible: dialect/UI layers may add keys
 *  without a type change, hence the index signature. */
export interface PostOptions {
  programEndMode: ProgramEndMode
  programEndMachineZ?: number
  /** Verbatim lines emitted at program end when programEndMode==='custom'. */
  programEndCustom?: string
  /** User tool-change macro body, used when capabilities.toolChange === 'macro'. */
  toolChangeMacro?: string
  /** Emit an M0 manual pause after a tool change (default true). Turn OFF when
   *  the controller's M6 / the user's tool-change macro already pauses, so the
   *  program does not stop a redundant second time. */
  toolChangePause?: boolean
  /** Opt-in G10 L2 work-offset write (default false). */
  writeWorkOffsets: boolean
  /** Max chordal deviation (mm) the arc-collapse stage may introduce when
   *  fitting G2/G3 arcs over dense polylines. User-tunable; default 0.05. Only
   *  consulted when capabilities.arcs === true. */
  arcTolerance?: number
  /** WO-2437: a macro word an operator stop calls just before its M0 (UCCNC's
   *  M2001, as Fusion's UCCNC post writes it). Absent = the stop is M0 alone. */
  operatorStopMacro?: string
  /** WO-2437: 'msg' writes the stop's message as a LinuxCNC `(MSG,...)`
   *  comment, which the controller shows the operator. Absent = a plain
   *  comment in the post's own style. */
  operatorStopMessage?: 'comment' | 'msg'
  [k: string]: string | number | boolean | undefined
}

// --- Config (a named, possibly user-authored postprocessor) ---

export interface PostConfig {
  id: string
  label: string
  builtin: boolean
  capabilities: PostCapabilities
  format: {
    xyzDecimals: number
    feedDecimals: number
    units: 'mm' | 'inch'
    lineNumbers: boolean
    lineNumberStep: number
  }
  framing: {
    programStart: string[]
    programEnd: string[]
    sectionComment: boolean
  }
  options: PostOptions
}

// --- Diagnostics & result (ADR-0003) ---

export interface PostDiagnostic {
  level: 'error' | 'warning' | 'info'
  code: string
  message: string
  opId?: string
  /** WO-2637: TOOL_NUMBER_DUPLICATE names the shared number and the two
   *  tools (library ids) so the Post Process screen can resolve it. */
  toolNumber?: number
  toolIds?: string[]
}

/**
 * One operation/section actually emitted, in emitted order. Repeated sections
 * (nest expansion) appear as repeated entries sharing one opId. Line numbers are
 * 1-based and refer to the RAW generated G-code text (PostResult.gcode).
 */
export interface EmittedOperationSpan {
  opId: string
  /** Owning setup id (present when the PostInput carried one). */
  setupId?: string
  startLine: number
  endLine: number
}

export interface PostResult {
  gcode: string
  ok: boolean
  diagnostics: PostDiagnostic[]
  meta?: { opCount: number; lineCount: number }
  /** Ordered per-operation/section source-line spans in the emitted gcode,
   *  present on successful emissions. */
  operationSpans?: EmittedOperationSpan[]
  /** WO-381: whether this program's gcode carries a LienCAM program-context
   *  envelope (the LCX1 comment block after program end), and if not, why.
   *  Present only when the caller asked postProject for one. */
  programContextEnvelope?: ProgramContextEnvelopeStatus
}

/** WO-381: outcome of the program-context envelope request for one program. */
export type ProgramContextEnvelopeStatus =
  | {
      included: true
      payloadBytes: number
      chunks: number
      lines: number
      /** WO-412: the wire version written (1 = one setup, 2 = a setup list)
       *  and how many setups the block lists. */
      version: 1 | 2
      setupCount: number
    }
  | { included: false; reason: string }
