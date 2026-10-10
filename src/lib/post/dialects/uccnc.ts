// ============================================================
// UCCNC dialect config (C-P1a, LINEAR subset)
// ============================================================
// UCCNC is the project's primary target controller. Arcs are ENABLED: dense
// feed runs are collapsed to lines + arcs and emitted as G2/G3 with I/J center
// offsets. arcFullCircle stays false (the collapse never emits a 360deg arc; it
// splits at 180deg). Canned cycles are declared capable but unused until
// drilling is wired.
//
// UCCNC dialect rules baked in here:
//   - Comments are PARENTHESES only:  ( like this )
//   - Six standard work offsets G54..G59 (no extended G54.1 P-words).
//   - Dwell G4 P-word is in MILLISECONDS (dwellUnits: 'ms').
//   - Tool change is M6 (T<n> M6), followed by an M0 manual pause.
//   - No program-number '%' wrapper and no N line numbers by default.
//   - Home/reference command is G28 (homeCommand option).

import type { PostConfig } from '../types'

export const UCCNC_CONFIG: PostConfig = {
  id: 'uccnc',
  label: 'UCCNC',
  builtin: true,
  capabilities: {
    arcs: true, // arcs enabled: feed runs collapse to G2/G3 with I/J offsets
    arcFullCircle: false, // collapse splits at 180deg; never a 360deg arc
    arcCenterMode: 'ijk',
    cannedCycles: true, // capable, but unused while emission is linear
    toolChange: 'm6',
    workOffsets: { g54_59: true, extended: false, g10: true },
    feedMode: 'g94',
    comment: 'paren',
    minArcRadius: 0.5,
    maxArcRadius: 1e4, // arcs larger than this collapse to lines
    minSweepDeg: 2, // arcs sweeping less than this collapse to lines
    dwellUnits: 'ms', // UCCNC G4 P-word is milliseconds
    // WO-381: certified for the LienCAM program-context envelope (LCX1 comment
    // block after M30) - see docs/research/post-context-compatibility-matrix.md.
    // no documented UCCNC line limit was found; 80 is the conservative certified width.
    maxLineLength: 80,
    programContextEnvelope: { ready: true, maxLineLength: 80 },
  },
  format: {
    xyzDecimals: 3,
    feedDecimals: 1,
    units: 'mm',
    lineNumbers: false,
    lineNumberStep: 0,
  },
  framing: {
    // The engine appends the WCS-select line (and optional G10) after these.
    // {units} -> G21 (mm) / G20 (inch) per format.units (ADR-0022); the literal
    // position is preserved so mm output stays byte-identical.
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
    // UCCNC M6 runs the operator's own tool-change macro (Operator's setup), which
    // pauses for the change -- so the post should NOT add its own M0. Default
    // true (safe) here; the operator turns it off for an M6-macro workflow.
    toolChangePause: true,
    // UCCNC home/reference command used when programEndMode === 'home'.
    homeCommand: 'G28',
    // Spindle-on settle dwell in MILLISECONDS (0 = no dwell).
    dwellMs: 0,
    // WO-2437: an operator stop calls M2001, "Park Position to Screw Down
    // Material", then M0 - exactly what Fusion's UCCNC post writes. The
    // machine's own M2001 parks and prompts; LienCAM's Control runs the macro
    // bound to M2001; an M0 in the file stops separately after the macro.
    operatorStopMacro: 'M2001',
  },
}
