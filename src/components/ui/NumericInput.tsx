import { textFor, useText } from '../../i18n'
import { useState, useEffect, useRef } from 'react'
import type { Units } from '../../types'
import {
  toDisplay, fromDisplay, DIM_DECIMALS,
  feedToDisplay, parseFeedToMmMin, FEED_DECIMALS,
  unitLabel, feedLabel,
} from '../../lib/ui/unitFormat'
import { useSelectAllOnClick } from './selectAllOnClick'
import { useCamStore } from '../../store'

const shellText = textFor('app-shell-settings-menus')

// Whether a NumericInput carries a length (mm) or a feed (mm/min). Only matters
// when `units` is provided and is 'inch': lengths convert via /25.4, feeds via
// IPM. Defaults to 'dim'. mm-mode is identity for both.
export type NumericKind = 'dim' | 'feed'

interface NumericInputProps {
  value: number
  onChange: (v: number) => void
  className?: string
  min?: number
  max?: number
  step?: number
  placeholder?: string
  disabled?: boolean
  /** Hover/focus hint, shown via the shared ThemedTooltip (data-tooltip). */
  tooltip?: string
  /**
   * Accessible name for screen readers (ICON-BUTTON-ARIA-LABELS, B3-2b). This
   * field is a bare `<input>` with no visible `<label>` of its own -- the
   * visible label, if any, lives in the caller's surrounding row and is not
   * programmatically associated. Defaults to `tooltip` (the best description
   * already at hand) when not given explicitly; pass a shorter override when
   * `tooltip` is a long sentence.
   */
  ariaLabel?: string
  style?: React.CSSProperties
  /**
   * Optional unit awareness (ADR-0022). When provided, `value`/`onChange` STILL
   * speak millimeters (call sites are unchanged); only the DISPLAYED string and
   * the parsing of the user's draft convert. min/max/step stay in mm and clamp
   * in mm. When `units` is undefined or 'mm' the rendering/commit path is
   * byte-identical to the original (no inch formatting branch is taken).
   */
  units?: Units
  /** Optional decimal override for inch display (defaults to the per-kind table). */
  decimals?: number
  /** 'dim' (length, mm) or 'feed' (mm/min). Defaults to 'dim'. */
  kind?: NumericKind
}

/**
 * Unit-aware display of an mm (or mm/min) value (ADR-0022). BYTE-IDENTITY rule:
 * when `units` is undefined or 'mm', this is EXACTLY the original formatNum path
 * so mm rendering is unchanged. Only inch takes the toFixed+strip branch (which
 * avoids float noise like 0.3937007874 from value/25.4).
 */
export function formatNumUnit(
  valueMm: number, units?: Units, decimals?: number, kind: NumericKind = 'dim',
): string {
  if (units === undefined || units === 'mm') return formatNum(valueMm)
  const disp = kind === 'feed' ? feedToDisplay(valueMm, units) : toDisplay(valueMm, units)
  return formatDisplayNumber(disp, units, decimals, kind)
}

// Format a number ALREADY in display units (no mm conversion) -- shared by
// formatNumUnit (after converting a canonical mm value) and the range/clamp-
// notice text (WO-2070), which start from what the operator typed or a raw
// display-unit limit and must never be converted twice.
function formatDisplayNumber(
  disp: number, units?: Units, decimals?: number, kind: NumericKind = 'dim',
): string {
  if (units === undefined || units === 'mm') return formatNum(disp)
  const dp = decimals ?? (kind === 'feed' ? FEED_DECIMALS.inch : DIM_DECIMALS.inch)
  return stripTrailingZeros(disp.toFixed(dp))
}

// Drop trailing zeros (and a trailing dot) from a fixed-decimal string so
// e.g. "0.3937" stays but "1.0000" -> "1" and "0.5000" -> "0.5".
function stripTrailingZeros(s: string): string {
  if (!s.includes('.')) return s
  return s.replace(/\.?0+$/, '')
}

// 'mm'/'inch' -> the unit suffix a range or clamp-notice line shows, matching
// the field's kind (dim vs feed) the same way the displayed value does.
// `units` is a field's opt-in (ADR-0022): plenty of NumericInput fields are
// genuinely unitless (polygon side count, pattern instance count) and have no
// prop that distinguishes them from an implicit-mm field that never opted in
// (WO-2070 attempt 1 found no such signal among min/max/step/decimals across
// the app's call sites). Showing no suffix when `units` is absent only omits
// a decoration the plain number never had either; guessing 'mm' mislabels
// every unitless field. Reversible per call site in one line (`units="mm"`).
function rangeUnit(units: Units | undefined, kind: NumericKind): string | undefined {
  if (units === undefined) return undefined
  return kind === 'feed' ? feedLabel(units) : unitLabel(units)
}

/** English description of a field's allowed range in DISPLAY units (COHESION-
 *  STANDARD.md section 24), e.g. "0.1 to 50 mm", "at least 0.1 mm", "at most
 *  50 mm"; no unit word when the field never opted into `units`. Returns
 *  undefined when neither min nor max is set. */
function describeRange(
  min: number | undefined, max: number | undefined,
  units?: Units, decimals?: number, kind: NumericKind = 'dim',
): string | undefined {
  if (min === undefined && max === undefined) return undefined
  const unit = rangeUnit(units, kind)
  const suffix = unit ? ` ${unit}` : ''
  const fmt = (v: number) => formatNumUnit(v, units, decimals, kind)
  if (min !== undefined && max !== undefined) return shellText('NumericInput.to', { value: fmt(min), value2: fmt(max), suffix: suffix })
  if (min !== undefined) return shellText('NumericInput.atLeast', { value: fmt(min), suffix: suffix })
  return shellText('NumericInput.atMost', { value: fmt(max as number), suffix: suffix })
}

/** Appends a range description after whatever hover text the caller already
 *  gives (section 24): "Probing depth: 0.1 to 50 mm" when both exist, just
 *  the range alone when the caller gave no tooltip. */
function withRangeHint(tooltip: string | undefined, range: string | undefined): string | undefined {
  if (!range) return tooltip
  return tooltip ? shellText('NumericInput.labelAndRange', { label: tooltip, range }) : range
}

/** Which limit, if any, a just-committed draft was clamped to, for the
 *  section-24 console notice. Reasons in two stages: canonical-mm equality
 *  decides WHETHER clamping happened at all (exact -- clamp() returns the
 *  literal min/max unchanged when it clamps, so comparing against that exact
 *  value has no float-tolerance question), and DISPLAY-string equality
 *  decides whether to still SAY so. A unit-conversion round-trip can land
 *  the canonical value a hair under/over the limit while the typed and
 *  limit numbers render identically at the field's own decimals (WO-2070
 *  attempt 2's bug: "0.0039 is below 0.0039 in - set to 0.0039 in"). When
 *  they render the same, nothing visibly clamped from the operator's seat,
 *  so no notice.
 *
 *  Direction (`which`) is read from which bound the TYPED canonical value
 *  crossed (`canonical < min`), not from which limit `result.value` equals:
 *  a collapsed range (min === max) makes those the same number, so equality
 *  against `result.value` alone can't tell above from below (WO-2070 audit,
 *  attempt 3: min=max=1, typed 2 was reported as "below 1"). */
function clampNotice(
  draft: string, result: { value: number; committed: boolean },
  min?: number, units?: Units, decimals?: number, kind: NumericKind = 'dim',
): { which: 'min' | 'max'; typed: number } | undefined {
  if (!result.committed) return undefined
  const parsed = parseFloat(draft)
  const u = units ?? 'mm'
  const canonical = kind === 'feed' ? parseFeedToMmMin(parsed, u) : fromDisplay(parsed, u)
  if (canonical === result.value) return undefined
  const which: 'min' | 'max' = min !== undefined && canonical < min ? 'min' : 'max'
  if (formatDisplayNumber(parsed, units, decimals, kind) === formatNumUnit(result.value, units, decimals, kind)) {
    return undefined
  }
  return { which, typed: parsed }
}

/** Visible field name read from the DOM at commit, for a clamp notice whose
 *  caller gave neither `ariaLabel` nor `tooltip` (audit, attempt 3: a bare
 *  `<NumericInput min={3} />` logged "Value: ..." though the operator sees a
 *  name right next to it). No call-site sweep: the name comes from whatever
 *  already labels the control on screen --
 *   - a native `<label>` association (explicit `htmlFor` or implicit
 *     wrapping, via the standard `input.labels`); else
 *   - the nearest ancestor row's own label element, found by a class name
 *     containing "label" (the PropertiesPanel/DefinitionFields shape: a
 *     sibling ".props-label" div next to the ".props-value" that holds the
 *     input, not a DOM ancestor of the input itself).
 *  `aria-labelledby` is the third DOM naming mechanism generally, but no
 *  caller can put it on NumericInput's own <input> (no such prop exists), so
 *  reading it here would be unreachable dead code; the standard covers
 *  ariaLabel already. Returns undefined (caller falls back to "Value") when
 *  nothing on screen names the field either way. */
function readVisibleLabel(input: HTMLInputElement | null): string | undefined {
  if (!input) return undefined
  const label = input.labels?.[0]?.textContent?.trim()
  if (label) return label
  let ancestor = input.parentElement
  for (let depth = 0; depth < 4 && ancestor; depth++) {
    const labelEl = ancestor.querySelector('[class*="label" i]')
    const text = labelEl && !labelEl.contains(input) ? labelEl.textContent?.trim() : undefined
    if (text) return text
    ancestor = ancestor.parentElement
  }
  return undefined
}

/** One console line naming the field, what was typed, and what was set
 *  (section 24), e.g. "Probing depth: -3 is below 0.1 mm - set to 0.1 mm".
 *  The typed number carries no unit suffix (it's the operator's own draft);
 *  the limit/set number does, matching the range text. */
function describeClamp(
  fieldName: string, which: 'min' | 'max', typed: number, limitMm: number,
  units?: Units, decimals?: number, kind: NumericKind = 'dim',
): string {
  const unit = rangeUnit(units, kind)
  const suffix = unit ? ` ${unit}` : ''
  const typedStr = formatDisplayNumber(typed, units, decimals, kind)
  const limitStr = formatNumUnit(limitMm, units, decimals, kind)
  const verb = which === 'min' ? shellText('NumericInput.below') : shellText('NumericInput.above')
  return shellText('NumericInput.isSetTo', { fieldName: fieldName, typedStr: typedStr, verb: verb, limitStr: limitStr, suffix: suffix, limitStr2: limitStr, suffix2: suffix })
}

/**
 * Controlled numeric input that feels natural to edit:
 *  - Selects all text on focus so you can type over the value immediately
 *  - Maintains a local string while editing so partial inputs (e.g. "-", "1.") don't break
 *  - Commits the parsed value on blur or Enter; reverts to the last valid value if invalid
 *  - Propagates external value changes only when the field is not focused
 */
export function NumericInput({
  value, onChange, className, min, max, step, placeholder, disabled, tooltip, ariaLabel, style,
  units, decimals, kind = 'dim',
}: NumericInputProps) {
  useText('app-shell-settings-menus')
  const [localStr, setLocalStr] = useState(() => formatNumUnit(value, units, decimals, kind))
  const focused = useRef(false)
  // Armed by Escape, read by commit(). A ref (not state) so it is visible even
  // to a STALE commit closure: e.currentTarget.blur() fires the native blur
  // event synchronously, before React has flushed Escape's queued setState,
  // so the onBlur handler that runs is still the one from the pre-Escape
  // render. Reading a ref's .current bypasses that staleness (BUG-376/404).
  const cancelledRef = useRef(false)
  // Enter commits then calls .blur(), which fires a second, synchronous
  // native blur -> a second commit() from the SAME stale pre-render closure
  // (same localStr, same value) before this one's setLocalStr has applied.
  // Without this guard that would log the section-24 clamp notice twice for
  // one edit. Reset on focus so the next real edit can log again.
  const clampLoggedRef = useRef(false)
  // Read at commit (see readVisibleLabel) only when the clamp notice has no
  // caller-given name to use instead.
  const inputRef = useRef<HTMLInputElement | null>(null)
  // Select-all-on-click contract (extracted to the SHARED helper so bespoke
  // inputs can't fork the pattern again): select-all on focus + a one-shot
  // re-select on the first mouseUp (the click otherwise collapses the
  // selection to a caret). See selectAllOnClick.ts for the full story.
  const selectAll = useSelectAllOnClick()
  const addConsoleEvent = useCamStore((s) => s.addConsoleEvent)

  // Sync display when external value (or the display unit) changes while not editing
  useEffect(() => {
    if (!focused.current) setLocalStr(formatNumUnit(value, units, decimals, kind))
  }, [value, units, decimals, kind])

  const commit = () => {
    focused.current = false
    if (cancelledRef.current) {
      // Escape cancelled this session: the DOM/closure's `localStr` may still
      // be the user's uncommitted typed text, so it must never be parsed.
      cancelledRef.current = false
      return
    }
    // The draft is in DISPLAY units; resolve it to a committed canonical value
    // (mm for 'dim', mm/min for 'feed'). min/max stay canonical and the clamp
    // happens AFTER conversion (ADR-0022).
    const result = resolveNumericDraft(localStr, value, min, max, units, kind)
    // Only fire onChange when the resolved value actually differs (at display
    // precision) from what the field showed on focus -- an untouched field
    // (tabbed through, clicked away from) must not push a phantom history step.
    if (result.committed
      && formatNumUnit(result.value, units, decimals, kind) !== formatNumUnit(value, units, decimals, kind)) {
      onChange(result.value)
    }
    if (!clampLoggedRef.current) {
      const notice = clampNotice(localStr, result, min, units, decimals, kind)
      if (notice) {
        clampLoggedRef.current = true
        const fieldName = ariaLabel ?? tooltip ?? readVisibleLabel(inputRef.current) ?? shellText('NumericInput.value')
        addConsoleEvent({
          severity: 'warning',
          source: 'input',
          message: describeClamp(
            fieldName, notice.which, notice.typed, result.value, units, decimals, kind,
          ),
        })
      }
    }
    setLocalStr(formatNumUnit(result.value, units, decimals, kind))
  }

  const hoverText = withRangeHint(tooltip, describeRange(min, max, units, decimals, kind))

  return (
    <input
      // type="text" + inputMode="decimal" (not type="number") so select-all on
      // focus actually works: the text-selection APIs do NOT apply to number
      // inputs (HTML spec), which made the old e.target.select() a silent no-op.
      // resolveNumericDraft handles NaN/partial input, so native number
      // validation is not needed; min/max/step below are still honored on commit.
      type="text"
      inputMode="decimal"
      ref={inputRef}
      className={className}
      value={localStr}
      min={min}
      max={max}
      step={step}
      placeholder={placeholder}
      disabled={disabled}
      data-tooltip={hoverText}
      aria-label={ariaLabel ?? tooltip}
      style={style}
      onChange={(e) => setLocalStr(e.target.value)}
      onFocus={(e) => {
        focused.current = true
        clampLoggedRef.current = false
        // Select all + arm the one-shot mouseUp re-select (shared contract).
        selectAll.onFocus(e)
      }}
      onMouseUp={selectAll.onMouseUp}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { commit(); e.currentTarget.blur() }
        if (e.key === 'Escape') {
          cancelledRef.current = true
          focused.current = false
          setLocalStr(formatNumUnit(value, units, decimals, kind))
          e.currentTarget.blur()
        }
      }}
    />
  )
}

interface OptionalNumericInputProps {
  /** The current value in mm (mm/min for feed), or undefined meaning "auto". */
  value: number | undefined
  /** Commit handler: a finite (clamped) number, or undefined when the field is
   *  cleared to blank ("auto"). */
  onChange: (v: number | undefined) => void
  className?: string
  min?: number
  max?: number
  step?: number
  /** Shown when the field is blank (the "auto" state), e.g. "auto (tool radius)". */
  placeholder?: string
  disabled?: boolean
  /** Hover/focus hint, shown via the shared ThemedTooltip (data-tooltip). */
  tooltip?: string
  /** Accessible name (see NumericInputProps.ariaLabel); defaults to `tooltip`. */
  ariaLabel?: string
  style?: React.CSSProperties
  units?: Units
  decimals?: number
  kind?: NumericKind
}

/**
 * A NumericInput variant whose value is OPTIONAL: a blank field commits
 * `undefined` (an "auto" sentinel) rather than reverting to the last value.
 * Otherwise it shares NumericInput's edit-draft/commit-on-blur contract and unit
 * awareness (ADR-0022). Used for fields where empty means "let the engine
 * decide" (e.g. the 3D rougher's stock-edge overshoot: blank = tool radius).
 *
 *  - blank / whitespace-only draft -> onChange(undefined)  ("auto")
 *  - a valid parse                 -> onChange(clamped mm value) (min clamps negatives)
 *  - a partial/invalid draft ("-", ".", "abc") -> revert, do NOT commit
 */
export function OptionalNumericInput({
  value, onChange, className, min, max, step, placeholder, disabled, tooltip, ariaLabel, style,
  units, decimals, kind = 'dim',
}: OptionalNumericInputProps) {
  useText('app-shell-settings-menus')
  const fmt = (v: number | undefined): string =>
    v === undefined ? '' : formatNumUnit(v, units, decimals, kind)
  const [localStr, setLocalStr] = useState(() => fmt(value))
  const focused = useRef(false)
  // See NumericInput's cancelledRef: a ref, not state, so it is visible to a
  // STALE commit closure racing Escape's queued setState via a synchronous blur.
  const cancelledRef = useRef(false)
  // See NumericInput's clampLoggedRef: suppresses the second, stale-closure
  // commit() that Enter's synchronous blur triggers, so one edit logs once.
  const clampLoggedRef = useRef(false)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const selectAll = useSelectAllOnClick()
  const addConsoleEvent = useCamStore((s) => s.addConsoleEvent)

  useEffect(() => {
    if (!focused.current) setLocalStr(fmt(value))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, units, decimals, kind])

  const commit = () => {
    focused.current = false
    if (cancelledRef.current) {
      cancelledRef.current = false
      return
    }
    // A blank field is the AUTO sentinel: commit undefined (do NOT coerce to 0).
    if (localStr.trim() === '') {
      if (value !== undefined) onChange(undefined)
      setLocalStr('')
      return
    }
    // Otherwise reuse the shared draft resolver (clamps negatives via `min`).
    const result = resolveNumericDraft(localStr, value ?? 0, min, max, units, kind)
    if (result.committed) {
      // Only fire onChange when the resolved value actually differs (at
      // display precision) from what the field showed on focus -- an
      // untouched field must not push a phantom history step.
      if (value === undefined
        || formatNumUnit(result.value, units, decimals, kind) !== formatNumUnit(value, units, decimals, kind)) {
        onChange(result.value)
      }
      if (!clampLoggedRef.current) {
        const notice = clampNotice(localStr, result, min, units, decimals, kind)
        if (notice) {
          clampLoggedRef.current = true
          const fieldName = ariaLabel ?? tooltip ?? readVisibleLabel(inputRef.current) ?? shellText('NumericInput.value')
          addConsoleEvent({
            severity: 'warning',
            source: 'input',
            message: describeClamp(
              fieldName, notice.which, notice.typed, result.value, units, decimals, kind,
            ),
          })
        }
      }
      setLocalStr(fmt(result.value))
    } else {
      // Partial/invalid draft -> revert to the current value's display.
      setLocalStr(fmt(value))
    }
  }

  const hoverText = withRangeHint(tooltip, describeRange(min, max, units, decimals, kind))

  return (
    <input
      type="text"
      inputMode="decimal"
      ref={inputRef}
      className={className}
      value={localStr}
      min={min}
      max={max}
      step={step}
      placeholder={placeholder}
      disabled={disabled}
      data-tooltip={hoverText}
      aria-label={ariaLabel ?? tooltip}
      style={style}
      onChange={(e) => setLocalStr(e.target.value)}
      onFocus={(e) => { focused.current = true; clampLoggedRef.current = false; selectAll.onFocus(e) }}
      onMouseUp={selectAll.onMouseUp}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { commit(); e.currentTarget.blur() }
        if (e.key === 'Escape') {
          cancelledRef.current = true
          focused.current = false
          setLocalStr(fmt(value))
          e.currentTarget.blur()
        }
      }}
    />
  )
}

/**
 * Pure commit resolver for a numeric draft string (B12). Exported so the
 * select-all-overwrite / empty-draft behavior is unit-testable without a DOM:
 *  - a valid parse -> commit the CLAMPED value (committed: true)
 *  - an empty/partial/invalid draft ("", "-", ".", "abc") -> revert to the
 *    last valid `current` value, do NOT commit (committed: false). The store
 *    is never handed NaN/empty mid-typing.
 */
export function resolveNumericDraft(
  draft: string, current: number, min?: number, max?: number,
  units?: Units, kind: NumericKind = 'dim',
): { value: number; committed: boolean } {
  const parsed = parseFloat(draft)
  if (!isNaN(parsed)) {
    // When unit-aware, the draft is in DISPLAY units: convert to the canonical
    // value BEFORE clamping (min/max are canonical - mm for 'dim', mm/min for
    // 'feed'). Without `units` (or 'mm') both conversions are identity, so
    // existing call sites are byte-identical.
    const u = units ?? 'mm'
    const canonical = kind === 'feed' ? parseFeedToMmMin(parsed, u) : fromDisplay(parsed, u)
    return { value: clamp(canonical, min, max), committed: true }
  }
  return { value: current, committed: false }
}

function formatNum(v: number): string {
  // Avoid excess decimals from floating-point noise (e.g. 0.10000000001)
  const s = String(parseFloat(v.toFixed(10)))
  return s
}

function clamp(v: number, min?: number, max?: number): number {
  if (min !== undefined && v < min) return min
  if (max !== undefined && v > max) return max
  return v
}
