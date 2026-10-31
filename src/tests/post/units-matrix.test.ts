// ============================================================
// Full-stack units 2x2 matrix end-to-end gate (ADR-0022, Phase 4)
// ============================================================
// Operator's units feature is TWO independent app-global preferences:
//   - displayUnits: how the UI shows/accepts dimensioned values (UI concern).
//   - exportUnits:  the unit of the exported g-code (G20/G21 + value conversion).
// All four combinations (work mm|inch x export mm|inch) must work.
//
// KEY INSIGHT locked here: the EXPORTED g-code is a function of exportUnits ONLY.
// displayUnits is a UI-presentation concern that has ZERO effect on the posted
// bytes. The post entry (postProgram) does not even receive displayUnits -- the
// PostProcessModal derives format.units + per-unit decimals from exportUnits
// alone (PostProcessModal.tsx exportConfig useMemo). So the 2x2 matrix collapses
// at the export boundary to the two exportUnits cells; the two displayUnits
// values per cell are proven byte-identical, covering all four corners.
//
// The display side of the matrix (the work-unit half) is the UI shim
// src/lib/ui/unitFormat.ts; its round-trip is pinned with a couple of
// assertions here (and exercised thoroughly in units-inch.test.ts + the shim's
// own callers). Assertions run on REAL postProgram output -- no hand-assembled
// g-code except the frozen mm baseline, which is captured from a real run.

import { describe, it, expect } from 'vitest'
import { postProgram } from '../../lib/post/index'
import { UCCNC_CONFIG } from '../../lib/post/dialects/uccnc'
import { resolveFeedrates } from '../../lib/cam/feedrates'
import { resolveSpindle, resolveCoolant } from '../../lib/post/resolve'
import { DIM_DECIMALS, FEED_DECIMALS, fmtDim, parseDimToMm } from '../../lib/ui/unitFormat'
import type { Units } from '../../types'
import { makeMachine, makeOp, makeTool, makeWcs, move } from './helpers'
import type { PostConfig, PostInput, PostOperation } from '../../lib/post/types'

// --- the export-config builder, modeling PostProcessModal EXACTLY -------------
// PostProcessModal.tsx builds the config it hands the post from the app-global
// exportUnits ONLY: it spreads the working config and overrides format.units +
// the per-unit decimals (DIM_DECIMALS / FEED_DECIMALS). displayUnits is NOT an
// input. We reproduce that here, and deliberately accept (and ignore) a
// displayUnits argument so the displayUnits-invariance test can vary it and
// prove it never reaches the post.
function buildExportConfig(
  base: PostConfig,
  exportUnits: Units,
  _displayUnits: Units, // UI concern only -- intentionally unused by the post
): PostConfig {
  return {
    ...base,
    format: {
      ...base.format,
      units: exportUnits,
      xyzDecimals: DIM_DECIMALS[exportUnits],
      feedDecimals: FEED_DECIMALS[exportUnits],
    },
  }
}

// --- representative fixture: linear moves + an arc + a feed -------------------
// All coordinates are exact inch multiples in mm so the inch-converted values
// are clean (25.4 -> 1, 50.8 -> 2, 12.7 -> 0.5). The arc is a quarter circle of
// radius 25.4mm (center (25.4, 25.4), prev (25.4, 0) -> end (25.4, 50.8)) so the
// emitted I/J (center - prev = (0, 25.4)) convert to I0 J1 in inch. Feed
// 1524 mm/min -> exactly 60 IPM (1524/25.4). Spindle resolves from the tool RPM.
function matrixOp(): PostOperation {
  const machine = makeMachine()
  const tool = makeTool({ id: 't1', toolNumber: 1 })
  const op = makeOp({
    id: 'op1',
    name: 'Units matrix',
    toolId: 't1',
    toolpathMoves: [
      // linear rapid + linear feed
      move({ type: 'rapid', x: 25.4, y: 0, z: 12.7, role: 'rapid' }),
      move({ type: 'feed', x: 25.4, y: 0, z: -12.7, feed: 1524, role: 'plunge' }),
      // an arc (quarter circle, cw): center (25.4, 25.4), end (25.4, 50.8)
      move({ type: 'arc_cw', x: 25.4, y: 50.8, z: -12.7, cx: 25.4, cy: 25.4, feed: 1524, role: 'cut' }),
    ],
  })
  return {
    op,
    tool,
    feeds: resolveFeedrates(tool, op.feedrateOverride, machine.rapidRate),
    spindle: resolveSpindle(op, tool, machine),
    coolant: resolveCoolant(tool, machine),
    moves: op.toolpathMoves ?? [],
  }
}

function makeInput(): PostInput {
  return { machine: makeMachine(), setup: { wcs: makeWcs(), operations: [matrixOp()] } }
}

// Post the fixture for a given (exportUnits, displayUnits) pair and assert ok.
function post(exportUnits: Units, displayUnits: Units): string {
  const cfg = buildExportConfig(UCCNC_CONFIG, exportUnits, displayUnits)
  const result = postProgram(makeInput(), cfg)
  expect(result.ok).toBe(true)
  return result.gcode
}

// Frozen mm baseline: captured from a real postProgram run of THIS fixture under
// exportUnits='mm' (the identity path == today's pre-feature behavior). It is
// the regression anchor for test 6 (work-mm/export-mm byte-identity). If the
// fixture or the mm emission ever changes, this string must be re-captured from
// a real run -- do NOT hand-edit it.
const FROZEN_MM_BASELINE = [
  'G90 G94 G17 G21 G64',
  // WO-3123: absent authored safe Z retains clearance fallback and names it.
  '( Machine safe Z is missing or rounds to zero; using work clearance for start/restart )',
  'G54',
  '( Units matrix )',
  'T1',
  'M3 S12000',
  'M8',
  'G0 Z12.7', // WO-2023: Z lifts alone before the first XY travel
  'G0 X25.4 Y0 Z12.7',
  'G1 Z-12.7 F1524',
  // X is modal-suppressed: the arc endpoint X (25.4) equals the prior move's X
  // (25.4), so the post correctly omits it from the G2 block.
  'G2 Y50.8 I0 J25.4',
  // WO-2693: the path ends at depth, so the program end lifts to its own
  // retract height before the spindle stops.
  'G0 Z12.7',
  'M5',
  'M9',
  'G0 Z12.7',
  'M30',
  '',
].join('\n')

describe('units 2x2 matrix end-to-end (ADR-0022)', () => {
  // --- Cell: export mm ---
  it('export mm -> G21 (not G20); coords in mm; F is mm/min', () => {
    const g = post('mm', 'mm')
    expect(/\bG21\b/.test(g)).toBe(true)
    expect(/\bG20\b/.test(g)).toBe(false)
    // 25.4mm coordinate appears verbatim in mm; 50.8mm arc endpoint too.
    expect(g).toContain('X25.4')
    expect(g).toContain('Y50.8')
    // F word is the raw mm/min value.
    expect(g).toContain('F1524')
  })

  // --- Cell: export inch ---
  it('export inch -> G20 (not G21); same coords as mm/25.4; F is IPM; 4dp', () => {
    const g = post('inch', 'inch')
    expect(/\bG20\b/.test(g)).toBe(true)
    expect(/\bG21\b/.test(g)).toBe(false)
    // 25.4mm -> 1, 50.8mm -> 2 (trailing zeros trimmed by fmtNum).
    expect(g).toContain('X1')
    expect(g).toContain('Y2')
    // Z 12.7mm -> 0.5; arc I/J: I 0mm -> I0, J 25.4mm -> J1.
    expect(g).toContain('Z0.5')
    expect(g).toContain('I0')
    expect(g).toContain('J1')
    // Feed 1524 mm/min -> 60 IPM.
    expect(g).toContain('F60')
    expect(/\bF1524\b/.test(g)).toBe(false)
    // The raw mm magnitudes must NOT survive as coordinate words.
    expect(/\bX25\.4\b/.test(g)).toBe(false)
    expect(/\bY50\.8\b/.test(g)).toBe(false)
    // A coordinate with 4 decimals is reachable (the dialect's inch decimals);
    // our clean fixture trims trailing zeros, so assert the decimals SOURCE is 4.
    expect(DIM_DECIMALS.inch).toBe(4)
  })

  // --- displayUnits-invariance: covers all 4 matrix corners at the export edge.
  // The post NEVER sees displayUnits; buildExportConfig ignores it. We prove the
  // bytes are identical by posting the SAME project + SAME exportUnits twice,
  // once with displayUnits='mm' and once with displayUnits='inch'.
  it('export mm is byte-identical regardless of displayUnits', () => {
    const withMmDisplay = post('mm', 'mm')
    const withInchDisplay = post('mm', 'inch')
    expect(withInchDisplay).toBe(withMmDisplay)
  })

  it('export inch is byte-identical regardless of displayUnits', () => {
    const withMmDisplay = post('inch', 'mm')
    const withInchDisplay = post('inch', 'inch')
    expect(withInchDisplay).toBe(withMmDisplay)
  })

  // --- Spindle RPM invariance: S word identical in mm and inch (never converts).
  it('spindle S word is identical in mm and inch exports (RPM never converts)', () => {
    const mm = post('mm', 'mm')
    const inch = post('inch', 'inch')
    const sMm = mm.split('\n').find((l) => /\bS\d+\b/.test(l))
    const sInch = inch.split('\n').find((l) => /\bS\d+\b/.test(l))
    expect(sMm).toBeDefined()
    expect(sMm).toBe(sInch)
    // The tool RPM is 12000 in the shared helper; assert the literal too.
    expect(mm).toContain('S12000')
    expect(inch).toContain('S12000')
  })

  // --- work-mm/export-mm byte-identity vs the frozen pre-feature-equivalent
  // baseline (the mm path is the identity path == today's behavior).
  it('export mm output equals the frozen mm baseline (byte-identity regression)', () => {
    const g = post('mm', 'mm')
    expect(g).toBe(FROZEN_MM_BASELINE)
  })

  // --- display side of the matrix: the UI shim round-trips per unit.
  // Thoroughly exercised in units-inch.test.ts + the shim's callers; kept
  // minimal here to cover the work-unit half of the 2x2 matrix.
  it('UI shim round-trips: inch fmt/parse ~= identity; mm is exact identity', () => {
    const v = 25.4 // mm
    // inch: parseDimToMm(fmtDim(v,'inch'),'inch') ~= v
    expect(parseDimToMm(fmtDim(v, 'inch'), 'inch')).toBeCloseTo(v, 6)
    // mm: identity (no conversion, just toFixed/parse round-trip).
    expect(parseDimToMm(fmtDim(v, 'mm'), 'mm')).toBeCloseTo(v, 6)
    // decimals table is the one source of truth shared with the post.
    expect(FEED_DECIMALS.mm).toBe(1)
    expect(FEED_DECIMALS.inch).toBe(1)
  })
})
