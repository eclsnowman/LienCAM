// ============================================================
// Dialect defaults + a minimal GENERIC placeholder config (C-P0)
// ============================================================
// The real UCCNC config (arcs, canned cycles, controller framing) lands in
// C-P1. GENERIC_CONFIG here is a linear-only placeholder so the assembly
// skeleton and tests have a concrete PostConfig to run against.

import type {
  PostCapabilities,
  PostConfig,
  PostOptions,
} from '../types'

export const DEFAULT_CAPABILITIES: PostCapabilities = {
  arcs: false,
  arcFullCircle: false,
  arcCenterMode: 'ijk',
  cannedCycles: false,
  toolChange: 'm6',
  workOffsets: { g54_59: true, extended: false, g10: false },
  feedMode: 'g94',
  comment: 'paren',
  minArcRadius: 0.01,
  dwellUnits: 'ms',
}

export const DEFAULT_FORMAT: PostConfig['format'] = {
  xyzDecimals: 3,
  feedDecimals: 1,
  units: 'mm',
  lineNumbers: false,
  lineNumberStep: 10,
}

export const DEFAULT_OPTIONS: PostOptions = {
  programEndMode: 'safe_z_only',
  toolChangePause: true,
  writeWorkOffsets: false,
}

/** Generic config. Arcs ENABLED to match the shipping dialects (UCCNC/GRBL/
 *  LinuxCNC all emit G2/G3); the arc-collapse caps mirror theirs. */
export const GENERIC_CONFIG: PostConfig = {
  id: 'generic',
  label: 'Generic (linear only)',
  builtin: true,
  capabilities: {
    ...DEFAULT_CAPABILITIES,
    arcs: true,
    arcCenterMode: 'ijk',
    minArcRadius: 0.5,
    maxArcRadius: 1e4,
    minSweepDeg: 2,
  },
  format: DEFAULT_FORMAT,
  framing: {
    programStart: [],
    programEnd: [],
    sectionComment: true,
  },
  options: DEFAULT_OPTIONS,
}
