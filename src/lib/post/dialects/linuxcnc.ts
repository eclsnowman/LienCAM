// ============================================================
// LinuxCNC dialect config (C-P4)
// ============================================================
// LinuxCNC runs the RS274NGC interpreter. Arcs are ENABLED: dense feed runs are
// collapsed to lines + arcs and emitted as G2/G3 with I/J center offsets.
// arcFullCircle matches UCCNC (false) — the collapse never emits a 360deg arc;
// it splits at 180deg. Canned cycles are declared capable but unused until
// drilling is wired.
//
// LinuxCNC dialect rules baked in here:
//   - Comments may be SEMICOLON to end-of-line:  ; like this  (comment: 'semicolon').
//   - Six standard work offsets G54..G59 PLUS the extended G59.1-.3 set, so
//     workOffsets.extended is TRUE. NOTE: extended-offset EMISSION (G59.1-.3) is
//     DEFERRED (DEF-1) — the capability is DECLARED here but the emitter still
//     uses only G54-G59. G10 L2 numeric writes are supported.
//   - Dwell G4 P-word is in SECONDS (dwellUnits: 's').
//   - Tool change is native M6 (T<n> M6), followed by an M0 manual pause.
//   - Supports G64 path-blending mode, included in programStart.
//   - Home/reference command is G28 (homeCommand option).
//   - INCH output (G20) is DEFERRED (DEF-2) — the engine emits mm (G21) only.

import type { PostConfig } from '../types'

export const LINUXCNC_CONFIG: PostConfig = {
  id: 'linuxcnc',
  label: 'LinuxCNC',
  builtin: true,
  capabilities: {
    arcs: true, // arcs enabled: feed runs collapse to G2/G3 with I/J offsets
    arcFullCircle: false, // collapse splits at 180deg; never a 360deg arc
    arcCenterMode: 'ijk',
    cannedCycles: true, // capable, but unused while emission is linear
    toolChange: 'm6', // LinuxCNC has native M6
    // extended:true declares G59.1-.3 capability; emission deferred (DEF-1).
    workOffsets: { g54_59: true, extended: true, g10: true },
    feedMode: 'g94',
    comment: 'semicolon', // ';' to end-of-line is valid RS274NGC
    minArcRadius: 0.5,
    maxArcRadius: 1e4, // arcs larger than this collapse to lines
    minSweepDeg: 2, // arcs sweeping less than this collapse to lines
    dwellUnits: 's', // LinuxCNC G4 P-word is seconds
    // WO-381: certified for the LienCAM program-context envelope (LCX1 comment
    // block after M30) - see docs/research/post-context-compatibility-matrix.md.
    // RS274NGC LINELEN is 256; 80 is the conservative certified width.
    maxLineLength: 80,
    programContextEnvelope: { ready: true, maxLineLength: 80 },
  },
  format: {
    xyzDecimals: 3,
    feedDecimals: 1,
    units: 'mm', // default; driven by exportUnits at the call site (ADR-0022)
    lineNumbers: false,
    lineNumberStep: 0,
  },
  framing: {
    // The engine appends the WCS-select line (and optional G10) after these.
    // {units} -> G21 (mm) / G20 (inch) per format.units (ADR-0022); mm stays
    // byte-identical. INCH (G20) output is now wired (DEF-2 closed).
    programStart: ['G90 G94 G17 {units} G64'],
    // Program-end is synthesized by the engine via options.programEndMode.
    programEnd: [],
    sectionComment: true,
  },
  options: {
    programEndMode: 'safe_z_only',
    programEndMachineZ: undefined,
    writeWorkOffsets: false,
    // Arc-collapse chordal tolerance (mm); consulted once arcs are enabled.
    arcTolerance: 0.05,
    toolChangeMacro: undefined,
    // LinuxCNC M6 may run the operator's own tool-change remap, which pauses for
    // the change. Default true (safe) here; the operator turns it off for an
    // M6-remap workflow that already pauses.
    toolChangePause: true,
    // LinuxCNC home/reference command used when programEndMode === 'home'.
    homeCommand: 'G28',
    // Spindle-on settle dwell in SECONDS (0 = no dwell).
    dwellMs: 0,
    // WO-2437: an operator stop's message goes out as (MSG,...), which the
    // LinuxCNC GUI shows the operator; the stop itself is M0.
    operatorStopMessage: 'msg',
  },
}
