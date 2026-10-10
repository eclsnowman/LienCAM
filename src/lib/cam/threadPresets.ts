// ── Thread-size presets ───────────────────────────────────────────────────────
//
// A plain data table of common standard thread sizes used to batch-fill the
// thread-milling params UI (majorDiameter + pitch). Selecting a preset is a
// convenience only; the user can still edit any field afterwards ("Custom").
//
// UNITS: every numeric field here is in MILLIMETRES (mm).
//   - majorDiameter: nominal thread major diameter in mm (e.g. 10 for M10).
//   - pitch:         mm advanced per revolution.
//   - tpi:           ONLY present for imperial (UNC/UNF/UNEF) entries, as the
//                    original spec value (threads per inch). For those entries
//                    pitch is DERIVED as pitch_mm = 25.4 / tpi. Metric entries
//                    omit tpi (they are pitch-native).
//   - tapDrill:      recommended tap-drill diameter in mm (~100% engagement
//                    approximation = majorDiameter - pitch). Optional.
//   - series:        which standard family the entry belongs to (e.g.
//                    'metric-coarse', 'metric-fine', 'UNC', 'UNF', 'UNEF').
//
// Imperial major diameters are likewise converted to mm from their nominal
// fractional-inch sizes (e.g. 1/4" = 6.35 mm, 3/8" = 9.525 mm).

export interface ThreadPreset {
  id: string
  label: string
  majorDiameter: number // mm
  pitch: number         // mm per revolution
  tpi?: number          // imperial spec value (threads per inch); pitch = 25.4 / tpi
  tapDrill?: number     // mm; recommended tap-drill (~major - pitch)
  series?: string       // 'metric-coarse' | 'metric-fine' | 'UNC' | 'UNF' | 'UNEF'
}

/** Inches -> millimetres. */
const INCH_MM = 25.4

/** Convert threads-per-inch to a metric pitch (mm per revolution). */
const tpiToPitchMm = (tpi: number): number => INCH_MM / tpi

// ──────────────────────────────────────────────────────────────────────────────
// CURATED dropdown list (DO NOT reorder / rename / change ids).
// This is the short hand-picked list the NewOperationModal preset dropdown maps
// over. findThreadPreset() resolves against THIS list. Keep it stable.
// ──────────────────────────────────────────────────────────────────────────────
export const THREAD_PRESETS: readonly ThreadPreset[] = [
  // ── Metric coarse (pitch-native, mm) ──
  { id: 'M3x0.5',   label: 'M3 x 0.5',   majorDiameter: 3,  pitch: 0.5 },
  { id: 'M4x0.7',   label: 'M4 x 0.7',   majorDiameter: 4,  pitch: 0.7 },
  { id: 'M5x0.8',   label: 'M5 x 0.8',   majorDiameter: 5,  pitch: 0.8 },
  { id: 'M6x1.0',   label: 'M6 x 1.0',   majorDiameter: 6,  pitch: 1.0 },
  { id: 'M8x1.25',  label: 'M8 x 1.25',  majorDiameter: 8,  pitch: 1.25 },
  { id: 'M10x1.5',  label: 'M10 x 1.5',  majorDiameter: 10, pitch: 1.5 },
  { id: 'M12x1.75', label: 'M12 x 1.75', majorDiameter: 12, pitch: 1.75 },
  { id: 'M16x2.0',  label: 'M16 x 2.0',  majorDiameter: 16, pitch: 2.0 },
  { id: 'M20x2.5',  label: 'M20 x 2.5',  majorDiameter: 20, pitch: 2.5 },
  { id: 'M24x3.0',  label: 'M24 x 3.0',  majorDiameter: 24, pitch: 3.0 },

  // ── Imperial UNC (coarse); pitch derived from tpi, diameter converted to mm ──
  { id: '1/4-20-UNC',  label: '1/4-20 UNC',  majorDiameter: 6.35,  pitch: tpiToPitchMm(20), tpi: 20 },
  { id: '5/16-18-UNC', label: '5/16-18 UNC', majorDiameter: 7.9375, pitch: tpiToPitchMm(18), tpi: 18 },
  { id: '3/8-16-UNC',  label: '3/8-16 UNC',  majorDiameter: 9.525, pitch: tpiToPitchMm(16), tpi: 16 },
  { id: '1/2-13-UNC',  label: '1/2-13 UNC',  majorDiameter: 12.7,  pitch: tpiToPitchMm(13), tpi: 13 },

  // ── Imperial UNF (fine); pitch derived from tpi, diameter converted to mm ──
  { id: '1/4-28-UNF',  label: '1/4-28 UNF',  majorDiameter: 6.35,  pitch: tpiToPitchMm(28), tpi: 28 },
  { id: '3/8-24-UNF',  label: '3/8-24 UNF',  majorDiameter: 9.525, pitch: tpiToPitchMm(24), tpi: 24 },
]

/** Look up a preset by its id. Returns undefined for unknown ids (incl. ""). */
export function findThreadPreset(id: string): ThreadPreset | undefined {
  return THREAD_PRESETS.find(p => p.id === id)
}

// ──────────────────────────────────────────────────────────────────────────────
// COMPREHENSIVE snap source.
//
// THREAD_STANDARDS is a broad, authoritative table of standard thread sizes used
// by the nearest-snap helpers (findThreadByMajor / findThreadByBore) so the UI
// can suggest a thread spec from a measured boss OD or bore diameter. It is kept
// SEPARATE from the curated THREAD_PRESETS dropdown above so that growing the
// snap table never disturbs the dropdown contents/order.
//
// tap-drill convention (uniform + testable): tapDrill = majorDiameter - pitch.
// This is the standard ~100%-engagement approximation. We apply it consistently
// to metric AND imperial entries (rather than gauge-letter drill charts) so the
// rule is a single formula everywhere. Spot-check examples that come out exact:
//   M10 x 1.5 -> 8.5,  M6 x 1.0 -> 5.0,  M16 x 2.0 -> 14.0.
// ──────────────────────────────────────────────────────────────────────────────

/** Build a metric entry; tapDrill derived as major - pitch. */
const metric = (
  id: string,
  label: string,
  major: number,
  pitch: number,
  series: 'metric-coarse' | 'metric-fine',
): ThreadPreset => ({
  id,
  label,
  series,
  majorDiameter: major,
  pitch,
  tapDrill: major - pitch,
})

/**
 * Build an imperial entry from a nominal inch size + tpi.
 * majorDiameter and tapDrill are converted to mm; pitch = 25.4 / tpi.
 */
const imperial = (
  size: string,        // display size, e.g. '#10', '1/4', '1'
  inch: number,        // nominal major diameter in inches
  tpi: number,
  series: 'UNC' | 'UNF' | 'UNEF',
): ThreadPreset => {
  const major = inch * INCH_MM
  const pitch = tpiToPitchMm(tpi)
  return {
    id: `${size}-${tpi}-${series}`,
    label: `${size}-${tpi} ${series}`,
    series,
    majorDiameter: major,
    pitch,
    tpi,
    tapDrill: major - pitch,
  }
}

/** Numbered imperial gauge -> nominal major diameter in inches: 0.060 + 0.013*N. */
const numberedInch = (n: number): number => 0.060 + 0.013 * n

export const THREAD_STANDARDS: readonly ThreadPreset[] = [
  // ── Metric coarse (ISO 261) ── tapDrill = major - pitch ──
  metric('M1.6x0.35', 'M1.6 x 0.35', 1.6, 0.35, 'metric-coarse'),
  metric('M2x0.4',    'M2 x 0.4',    2,    0.4,  'metric-coarse'),
  metric('M2.5x0.45', 'M2.5 x 0.45', 2.5,  0.45, 'metric-coarse'),
  metric('M3x0.5',    'M3 x 0.5',    3,    0.5,  'metric-coarse'),
  metric('M4x0.7',    'M4 x 0.7',    4,    0.7,  'metric-coarse'),
  metric('M5x0.8',    'M5 x 0.8',    5,    0.8,  'metric-coarse'),
  metric('M6x1.0',    'M6 x 1.0',    6,    1.0,  'metric-coarse'),
  metric('M8x1.25',   'M8 x 1.25',   8,    1.25, 'metric-coarse'),
  metric('M10x1.5',   'M10 x 1.5',   10,   1.5,  'metric-coarse'),
  metric('M12x1.75',  'M12 x 1.75',  12,   1.75, 'metric-coarse'),
  metric('M14x2.0',   'M14 x 2.0',   14,   2.0,  'metric-coarse'),
  metric('M16x2.0',   'M16 x 2.0',   16,   2.0,  'metric-coarse'),
  metric('M20x2.5',   'M20 x 2.5',   20,   2.5,  'metric-coarse'),
  metric('M24x3.0',   'M24 x 3.0',   24,   3.0,  'metric-coarse'),
  metric('M30x3.5',   'M30 x 3.5',   30,   3.5,  'metric-coarse'),
  metric('M36x4.0',   'M36 x 4.0',   36,   4.0,  'metric-coarse'),
  metric('M42x4.5',   'M42 x 4.5',   42,   4.5,  'metric-coarse'),
  metric('M48x5.0',   'M48 x 5.0',   48,   5.0,  'metric-coarse'),
  metric('M56x5.5',   'M56 x 5.5',   56,   5.5,  'metric-coarse'),
  metric('M64x6.0',   'M64 x 6.0',   64,   6.0,  'metric-coarse'),

  // ── Metric fine (common) ── tapDrill = major - pitch ──
  metric('M8x1.0',    'M8 x 1.0',    8,    1.0,  'metric-fine'),
  metric('M10x1.0',   'M10 x 1.0',   10,   1.0,  'metric-fine'),
  metric('M10x1.25',  'M10 x 1.25',  10,   1.25, 'metric-fine'),
  metric('M12x1.0',   'M12 x 1.0',   12,   1.0,  'metric-fine'),
  metric('M12x1.25',  'M12 x 1.25',  12,   1.25, 'metric-fine'),
  metric('M12x1.5',   'M12 x 1.5',   12,   1.5,  'metric-fine'),
  metric('M16x1.5',   'M16 x 1.5',   16,   1.5,  'metric-fine'),
  metric('M20x1.5',   'M20 x 1.5',   20,   1.5,  'metric-fine'),
  metric('M24x2.0',   'M24 x 2.0',   24,   2.0,  'metric-fine'),

  // ── Imperial UNC (coarse) ── numbered major = 0.060 + 0.013*N inch ──
  imperial('#4',   numberedInch(4),  40, 'UNC'),
  imperial('#6',   numberedInch(6),  32, 'UNC'),
  imperial('#8',   numberedInch(8),  32, 'UNC'),
  imperial('#10',  numberedInch(10), 24, 'UNC'),
  imperial('1/4',  1 / 4,  20, 'UNC'),
  imperial('5/16', 5 / 16, 18, 'UNC'),
  imperial('3/8',  3 / 8,  16, 'UNC'),
  imperial('7/16', 7 / 16, 14, 'UNC'),
  imperial('1/2',  1 / 2,  13, 'UNC'),
  imperial('5/8',  5 / 8,  11, 'UNC'),
  imperial('3/4',  3 / 4,  10, 'UNC'),
  imperial('1',    1,       8, 'UNC'),

  // ── Imperial UNF (fine) ──
  imperial('#6',   numberedInch(6),  40, 'UNF'),
  imperial('#8',   numberedInch(8),  36, 'UNF'),
  imperial('#10',  numberedInch(10), 32, 'UNF'),
  imperial('1/4',  1 / 4,  28, 'UNF'),
  imperial('5/16', 5 / 16, 24, 'UNF'),
  imperial('3/8',  3 / 8,  24, 'UNF'),
  imperial('1/2',  1 / 2,  20, 'UNF'),
  imperial('5/8',  5 / 8,  18, 'UNF'),
  imperial('3/4',  3 / 4,  16, 'UNF'),

  // ── Imperial UNEF (extra fine, common) ──
  imperial('1/4',  1 / 4,  32, 'UNEF'),
  imperial('5/16', 5 / 16, 32, 'UNEF'),
  imperial('3/8',  3 / 8,  32, 'UNEF'),
]

/**
 * Pick the THREAD_STANDARDS entry nearest some measured value, within `tol` mm.
 * `key` selects which field to compare (majorDiameter or tapDrill).
 * Tie rule: smallest absolute difference first; on an exact diff tie, the
 * coarsest pitch (largest pitch) wins.
 */
function nearestStandard(
  value: number,
  tol: number,
  key: 'majorDiameter' | 'tapDrill',
): ThreadPreset | undefined {
  let best: ThreadPreset | undefined
  let bestDiff = Infinity
  for (const entry of THREAD_STANDARDS) {
    const ref = entry[key]
    if (ref === undefined) continue
    const diff = Math.abs(ref - value)
    if (diff > tol) continue
    if (
      diff < bestDiff ||
      // tie on distance -> prefer the coarsest pitch (largest pitch)
      (diff === bestDiff && best !== undefined && entry.pitch > best.pitch)
    ) {
      best = entry
      bestDiff = diff
    }
  }
  return best
}

/**
 * Given a measured OUTER diameter (boss OD), return the THREAD_STANDARDS entry
 * whose majorDiameter is nearest within `tol` mm; undefined if none within tol.
 */
export function findThreadByMajor(diameter: number, tol = 0.4): ThreadPreset | undefined {
  return nearestStandard(diameter, tol, 'majorDiameter')
}

/**
 * Given a measured BORE (tap-drill hole) diameter, return the THREAD_STANDARDS
 * entry whose tapDrill is nearest within `tol` mm; undefined if none within tol.
 */
export function findThreadByBore(diameter: number, tol = 0.4): ThreadPreset | undefined {
  return nearestStandard(diameter, tol, 'tapDrill')
}
