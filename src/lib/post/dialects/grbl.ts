// ============================================================
// GRBL dialect config (C-P1a, LINEAR subset)
// ============================================================
// A GRBL profile with arcs ENABLED: dense feed runs are collapsed to lines +
// arcs and emitted as G2/G3 with I/J center offsets. arcFullCircle stays false
// (the collapse never emits a 360deg arc; it splits at 180deg). The limited
// canned-cycle set lands in a later phase.
//
// GRBL dialect rules baked in here:
//   - GRBL has NO M6. Tool change becomes a MANUAL PAUSE (M0) preceded by a
//     "( change tool ... )" comment. toolChange: 'pause' drives this in the
//     engine.
//   - Comments are PARENTHESES.
//   - Dwell G4 P-word is in SECONDS (dwellUnits: 's'), unlike UCCNC.
//   - Supports M7/M8/M9 coolant, G53 machine coords, and G10 L2 work offsets.
//   - No G64 path-blending mode (GRBL lacks G61/G64), so it is omitted from
//     programStart.
//   - Homing command is '$H' (homeCommand option).

import type { PostConfig } from '../types'

export const GRBL_CONFIG: PostConfig = {
  id: 'grbl',
  label: 'GRBL',
  builtin: true,
  capabilities: {
    arcs: true, // arcs enabled: feed runs collapse to G2/G3 with I/J offsets
    arcFullCircle: false, // collapse splits at 180deg; never a 360deg arc
    arcCenterMode: 'ijk',
    cannedCycles: false,
    toolChange: 'pause', // GRBL has no M6 -> M0 pause + comment
    workOffsets: { g54_59: true, extended: false, g10: true },
    feedMode: 'g94',
    comment: 'paren',
    minArcRadius: 0.5,
    maxArcRadius: 1e4, // arcs larger than this collapse to lines
    minSweepDeg: 2, // arcs sweeping less than this collapse to lines
    dwellUnits: 's', // GRBL G4 P-word is seconds
    // WO-381: certified for the LienCAM program-context envelope (LCX1 comment
    // block after M30) - see docs/research/post-context-compatibility-matrix.md.
    // GRBL line buffer is 80 chars (LINE_BUFFER_SIZE); the streamer strips comment lines before sending, so the block never reaches the wire.
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
    // No G64 — GRBL lacks path-blending mode words. {units} -> G21 (mm) /
    // G20 (inch) per format.units (ADR-0022); mm stays byte-identical.
    programStart: ['G90 G94 G17 {units}'],
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
    // GRBL has no M6 macro; the M0 pause IS the manual tool-change stop, so keep
    // it on.
    toolChangePause: true,
    // GRBL homing command used when programEndMode === 'home'.
    homeCommand: '$H',
    // Spindle-on settle dwell in SECONDS (0 = no dwell).
    dwellMs: 0,
  },
}
