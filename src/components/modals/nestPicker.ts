/* Pure picker-state -> CreateNestParams.sources mapping for the New Nest modal
 * (P4.1). Kept React- and store-free so it is unit-testable in node.
 *
 * The modal owns a list of picker rows (one per nestable project part). This
 * helper distils that UI state into the `sources` array createNest consumes:
 * only INCLUDED rows are emitted, each carrying its quantity and orientation
 * lock. The lock maps to NestPart.lockedRotationDeg = 0 in the store (the
 * solver then returns only the 0 deg orientation).
 */

import type { SolverMode, NestStyle, Spacing } from '../../lib/cam/nesting/types'
import type { CreateNestParams } from '../../store'
import { CREATE_NEST_TEST_DEFAULTS } from '../../lib/cam/nesting/createNestDefaults'

/** One row of the modal's part picker. */
export interface NestPickerRow {
  geometryId: string
  /** Whether this part is included in the pack. */
  included: boolean
  /** Copies requested of this part (integer >= 1). */
  quantity: number
  /** Pin this part to its source orientation (no rotation by the solver). */
  locked: boolean
  /** True when this part is OWNED by the nest: it was imported via the modal's
   *  inline "Add part..." (this session) or, on EDIT, carried over from an
   *  existing nest source whose ownedByNest was true. An owned part lives only
   *  inside the nest (suppressed from the standalone viewport + tree). */
  ownedByNest?: boolean
}

/** The per-source shape CreateNestParams.sources expects. */
export interface NestSource {
  geometryId: string
  quantity: number
  /** Omitted when the part may rotate freely; true pins it (lockedRotationDeg 0). */
  locked?: boolean
  /** Emitted true only when the part is owned by the nest (modal-imported or an
   *  edit carry-through); omitted for pre-existing workspace geometry so a
   *  non-owned source is byte-identical to the pre-provenance shape. */
  ownedByNest?: boolean
}

/**
 * Build the `sources` array for createNest from the modal's picker rows.
 * - Only INCLUDED rows with quantity >= 1 are emitted (an unchecked or zero-qty
 *   row is not a source).
 * - `quantity` is passed through, floored to an integer and clamped to >= 1 so a
 *   fractional/`0` draft never reaches the engine.
 * - `locked` is emitted as `true` only when the row is locked; otherwise omitted
 *   (so an unlocked source is byte-identical to the pre-P4.1 shape).
 * - `ownedByNest` is emitted as `true` only when the row is owned; otherwise
 *   omitted (so a non-owned source is byte-identical to the pre-provenance shape).
 * Pure: no store, no React, no side effects.
 */
export function buildNestSources(rows: NestPickerRow[]): NestSource[] {
  const out: NestSource[] = []
  for (const row of rows) {
    if (!row.included) continue
    const qty = Math.max(1, Math.floor(row.quantity))
    if (!Number.isFinite(qty)) continue
    const source: NestSource = { geometryId: row.geometryId, quantity: qty }
    if (row.locked) source.locked = true
    if (row.ownedByNest) source.ownedByNest = true
    out.push(source)
  }
  return out
}

/* ────────────────────────────────────────────────────────────────────────────
 * P4.2: build the FULL CreateNestParams from the modal's control state.
 * Pure (no store, no React) so each solver-mode -> sheet mapping is unit-testable.
 * ──────────────────────────────────────────────────────────────────────────── */

/** The solver choices the modal's <select> offers, flattened so the UI binds to
 *  ONE value. They map onto the engine's SolverMode union:
 *   - 'fixQty-none'   -> { kind:'fixQty', lockedAxis:'none'   } exact qty, auto-size
 *   - 'fixQty-width'  -> { kind:'fixQty', lockedAxis:'width'  } exact qty, lock width
 *   - 'fixQty-height' -> { kind:'fixQty', lockedAxis:'height' } exact qty, lock height
 *   - 'fixSheet-exact'-> { kind:'fixSheetExact' }              exact qty on fixed sheet
 *   - 'fixSheet'      -> { kind:'fixSheet' }                   max qty (fill) fixed sheet */
export type SolverChoice =
  | 'fixQty-none'
  | 'fixQty-width'
  | 'fixQty-height'
  | 'fixSheet-exact'
  | 'fixSheet'

/** Resolve a flattened SolverChoice into the engine SolverMode union. */
export function solverModeFor(choice: SolverChoice): SolverMode {
  switch (choice) {
    case 'fixSheet': return { kind: 'fixSheet' }
    case 'fixSheet-exact': return { kind: 'fixSheetExact' }
    case 'fixQty-width': return { kind: 'fixQty', lockedAxis: 'width' }
    case 'fixQty-height': return { kind: 'fixQty', lockedAxis: 'height' }
    case 'fixQty-none': return { kind: 'fixQty', lockedAxis: 'none' }
  }
}

/** INVERSE of solverModeFor (+ buildNestRequest's ratio decomposition): recover
 *  the modal's flattened control state from a stored SolverMode so EDIT can
 *  faithfully prefill the <select> + the ratio controls. Total over the union:
 *   - fixSheet        -> 'fixSheet'                      (ratio off, 1/1)
 *   - fixSheetExact   -> 'fixSheet-exact'                (ratio off, 1/1)
 *   - fixQty/'none'   -> 'fixQty-none'                   (ratio off, 1/1)
 *   - fixQty/'width'  -> 'fixQty-width'                  (ratio off, 1/1)
 *   - fixQty/'height' -> 'fixQty-height'                 (ratio off, 1/1)
 *   - fixQtyRatio     -> 'fixQty-none' + ratioLocked true + { ratioW:1, ratioH:ratio }
 *     so ratioH/ratioW === ratio (buildNestRequest computes ratio = ratioH/ratioW),
 *     round-tripping the stored aspect. */
export function solverStateFromMode(mode: SolverMode): {
  solver: SolverChoice
  ratioLocked: boolean
  ratioW: number
  ratioH: number
} {
  switch (mode.kind) {
    case 'fixSheet':
      return { solver: 'fixSheet', ratioLocked: false, ratioW: 1, ratioH: 1 }
    case 'fixSheetExact':
      return { solver: 'fixSheet-exact', ratioLocked: false, ratioW: 1, ratioH: 1 }
    case 'fixQtyRatio':
      return { solver: 'fixQty-none', ratioLocked: true, ratioW: 1, ratioH: mode.ratio }
    case 'fixQty':
      switch (mode.lockedAxis) {
        case 'width': return { solver: 'fixQty-width', ratioLocked: false, ratioW: 1, ratioH: 1 }
        case 'height': return { solver: 'fixQty-height', ratioLocked: false, ratioW: 1, ratioH: 1 }
        case 'none': return { solver: 'fixQty-none', ratioLocked: false, ratioW: 1, ratioH: 1 }
      }
  }
}

/** Whether a given solver choice packs EXACT requested quantities (vs the fill
 *  mode where Qty is only a ratio and the sheet is filled with as many as fit).
 *  Drives the modal's per-part summary format + shortfall warning. */
export function isExactChoice(choice: SolverChoice): boolean {
  return choice !== 'fixSheet'
}

/** Which sheet dimensions a given solver choice CONSUMES as input:
 *   - fixSheet       -> both width AND height are inputs (fixed sheet, fill).
 *   - fixSheet-exact -> both width AND height are inputs (fixed sheet, exact qty).
 *   - fixQty-width   -> width is the LOCKED input; height is solved.
 *   - fixQty-height  -> height is the LOCKED input; width is solved.
 *   - fixQty-none    -> neither; the solver sizes both (auto). */
export function sheetInputsFor(choice: SolverChoice): { width: boolean; height: boolean } {
  switch (choice) {
    case 'fixSheet': return { width: true, height: true }
    case 'fixSheet-exact': return { width: true, height: true }
    case 'fixQty-width': return { width: true, height: false }
    case 'fixQty-height': return { width: false, height: true }
    case 'fixQty-none': return { width: false, height: false }
  }
}

/** Full modal control state (the picker rows PLUS the P4.2 sections). Pure data
 *  the helper maps into a CreateNestParams; the modal holds this in useState. */
export interface NestModalState {
  rows: NestPickerRow[]
  solver: SolverChoice
  /** Sheet size (mm). Only the dimensions sheetInputsFor() marks as inputs are
   *  meaningful for a given solver; the others are passed through but ignored by
   *  the engine for that mode (kept so toggling modes preserves the user's value). */
  sheet: { width: number; height: number }
  style: NestStyle
  /** Orientation samples for style 'arbitrary' (>= 2); ignored for 'ninety'. */
  rotationCount: number
  spacing: Spacing
  /** Sheet Z thickness (mm, > 0). Every 2D nest part needs a cut depth; carried
   *  onto the NestRecord (Item 3). Independent of solver mode. */
  thickness: number
  /** Multi-copy cut ordering (P7). Carried onto the NestRecord; undefined ===
   *  'by-operation' (the default) downstream. The modal always supplies it;
   *  optional here so pre-P7 callers/tests stay valid (buildNestRequest defaults
   *  it to 'by-operation'). */
  machiningOrder?: 'by-operation' | 'by-part'
  seed: number
  /** Auto-size ratio constraint (only meaningful for solver 'fixQty-none'). When
   *  true, the auto-size solve is constrained to a sheet of the W:H ratio below
   *  instead of a free-aspect (typically 1-wide strip) min-area sheet. Ignored by
   *  every other solver. */
  ratioLocked?: boolean
  /** Ratio numerator (sheet WIDTH part of the W:H constraint). Finite > 0. */
  ratioW?: number
  /** Ratio denominator (sheet HEIGHT part of the W:H constraint). Finite > 0. */
  ratioH?: number
}

/**
 * Build the full CreateNestParams from the modal state. Pure.
 *  - sources via buildNestSources (only included rows).
 *  - solver via solverModeFor(state.solver).
 *  - sheet passed through as-is (the engine reads only the dims the mode locks;
 *    fixQty-none ignores both and auto-sizes).
 *  - style passed through; rotationCount is included ONLY for 'arbitrary'
 *    (floored, clamped >= 2) — omitted for 'ninety' so the request shape matches
 *    the axis-aligned case exactly.
 *  - spacing + seed passed through.
 * The store still owns geometry -> NestPart resolution; this only maps controls.
 */
/* ────────────────────────────────────────────────────────────────────────────
 * P4.3: persisted last-used CONTROL values (remembered across modal opens).
 * Only the CONTROLS are remembered (solver/sheet/style/rotationCount/spacing) —
 * NOT the part-picker selections, which depend on the current project geometry
 * and must be re-picked each time. Stored in the UI-prefs store (useUiPrefs).
 * ──────────────────────────────────────────────────────────────────────────── */

/** The remembered control values (no part picks). */
export interface NestSettings {
  solver: SolverChoice
  sheet: { width: number; height: number }
  style: NestStyle
  rotationCount: number
  spacing: Spacing
  /** Sheet Z thickness (mm, > 0): remembered so reopening keeps the last value
   *  (Item 3). Seeded from appSettings.defaultStockThicknessMm on first open. */
  thickness: number
  /** Multi-copy cut ordering (P7): remembered so reopening keeps the last value.
   *  Defaults to 'by-operation' when nothing has been remembered. */
  machiningOrder: 'by-operation' | 'by-part'
  /** Auto-size ratio constraint (P4.3b): remembered so reopening keeps the
   *  checkbox + ratio. Only consumed when solver is 'fixQty-none'. */
  ratioLocked: boolean
  ratioW: number
  ratioH: number
}

/** The fresh defaults used when nothing has been remembered yet (first ever open).
 *  Solver default is 'fixSheet-exact' (P4.3); sheet/spacing from the shared test
 *  defaults; style 'ninety'; 4 orientation samples. */
export const DEFAULT_NEST_SETTINGS: NestSettings = {
  solver: 'fixSheet-exact',
  sheet: { ...CREATE_NEST_TEST_DEFAULTS.sheet },
  style: CREATE_NEST_TEST_DEFAULTS.style,
  rotationCount: 4,
  spacing: { ...CREATE_NEST_TEST_DEFAULTS.spacing },
  // Fallback only: the modal seeds the initial thickness from
  // appSettings.defaultStockThicknessMm (which is also 12). This literal keeps
  // the pure validator total when nothing has been remembered.
  thickness: 12,
  // P7: default to 'by-operation' (the same default every downstream consumer
  // assumes for an undefined NestRecord.machiningOrder).
  machiningOrder: 'by-operation',
  ratioLocked: false,
  ratioW: 1,
  ratioH: 1,
}

const SOLVER_CHOICES: readonly SolverChoice[] = [
  'fixQty-none', 'fixQty-width', 'fixQty-height', 'fixSheet-exact', 'fixSheet',
]
const NEST_STYLES: readonly NestStyle[] = ['ninety', 'arbitrary']

/** A loosely-typed persisted value as read back from storage (uiPrefs stores it
 *  without the SolverChoice/NestStyle literal narrowing). mergeNestSettings is
 *  what re-narrows + validates it. */
export interface PersistedNestSettings {
  solver?: string
  sheet?: { width?: number; height?: number }
  style?: string
  rotationCount?: number
  spacing?: { partGap?: number; sheetMargin?: number; windowGap?: number }
  thickness?: number
  machiningOrder?: string
  ratioLocked?: boolean
  ratioW?: number
  ratioH?: number
}

/** Merge a (possibly partial / stale / tampered) persisted value over the fresh
 *  defaults, validating each field. Pure + total: a malformed stored value can
 *  never leave the modal with a broken control state. Unknown solver/style fall
 *  back to the default; non-finite numbers fall back to the default. */
export function mergeNestSettings(persisted: PersistedNestSettings | null | undefined): NestSettings {
  const p = persisted ?? {}
  const num = (v: unknown, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback
  // ratio components must be strictly positive (a 0 or negative axis is meaningless).
  const pos = (v: unknown, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback
  const solver = SOLVER_CHOICES.includes(p.solver as SolverChoice)
    ? (p.solver as SolverChoice)
    : DEFAULT_NEST_SETTINGS.solver
  const style = NEST_STYLES.includes(p.style as NestStyle)
    ? (p.style as NestStyle)
    : DEFAULT_NEST_SETTINGS.style
  // P7: only the two known modes are valid; anything else (incl. undefined / a
  // tampered value) falls back to the default 'by-operation'.
  const machiningOrder: 'by-operation' | 'by-part' =
    p.machiningOrder === 'by-part' ? 'by-part' : 'by-operation'
  return {
    solver,
    sheet: {
      width: num(p.sheet?.width, DEFAULT_NEST_SETTINGS.sheet.width),
      height: num(p.sheet?.height, DEFAULT_NEST_SETTINGS.sheet.height),
    },
    style,
    rotationCount: Math.max(2, Math.round(num(p.rotationCount, DEFAULT_NEST_SETTINGS.rotationCount))),
    spacing: {
      partGap: num(p.spacing?.partGap, DEFAULT_NEST_SETTINGS.spacing.partGap),
      sheetMargin: num(p.spacing?.sheetMargin, DEFAULT_NEST_SETTINGS.spacing.sheetMargin),
      windowGap: num(p.spacing?.windowGap, DEFAULT_NEST_SETTINGS.spacing.windowGap),
    },
    // Thickness must be strictly positive (a 0/negative cut depth is meaningless).
    thickness: pos(p.thickness, DEFAULT_NEST_SETTINGS.thickness),
    machiningOrder,
    ratioLocked: p.ratioLocked === true,
    ratioW: pos(p.ratioW, DEFAULT_NEST_SETTINGS.ratioW),
    ratioH: pos(p.ratioH, DEFAULT_NEST_SETTINGS.ratioH),
  }
}

export function buildNestRequest(state: NestModalState): CreateNestParams {
  const sources = buildNestSources(state.rows)
  // Auto-size (fixQty-none) + ratio lock with valid positive W:H -> constrain the
  // auto-size solve to that fixed aspect (engine fixQtyRatio, ratio = H / W).
  // Any other solver, an unticked box, or an invalid ratio -> the plain mapping.
  const rW = state.ratioW
  const rH = state.ratioH
  const useRatio =
    state.solver === 'fixQty-none' &&
    state.ratioLocked === true &&
    typeof rW === 'number' && Number.isFinite(rW) && rW > 0 &&
    typeof rH === 'number' && Number.isFinite(rH) && rH > 0
  const solver: SolverMode = useRatio
    ? { kind: 'fixQtyRatio', ratio: (rH as number) / (rW as number) }
    : solverModeFor(state.solver)
  const params: CreateNestParams = {
    sources,
    sheet: { width: state.sheet.width, height: state.sheet.height },
    style: state.style,
    spacing: { ...state.spacing },
    solver,
    seed: state.seed,
    thickness: state.thickness,
    // Default to 'by-operation' when a caller omits it (pre-P7 callers/tests);
    // the modal always supplies the user's choice.
    machiningOrder: state.machiningOrder ?? 'by-operation',
  }
  if (state.style === 'arbitrary') {
    params.rotationCount = Math.max(2, Math.floor(state.rotationCount))
  }
  return params
}
