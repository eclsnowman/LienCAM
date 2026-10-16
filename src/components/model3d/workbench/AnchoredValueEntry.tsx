// WO UI-58 (Operator verdict, T-UI5-PUSHPULL-RESIZE step 3): "pulling this stuff
// into interactive workspace selectors" -- a compact, non-blocking, ON-SCREEN
// value entry anchored near a world point (a picked hole, in this WO's own
// caller; UI-57's push/pull readout is expected to adopt this same
// component). Deliberately free of hole-specific (or push/pull-specific)
// logic: every domain fact (title, current-value text, validation, apply,
// delta formatting) is injected by the caller.
//
// Anchor math reuses the caller's own world->screen primitive
// (SceneRuntime.projectToCanvas via the `projectToCanvas` prop) -- this file
// never reimplements projection. Tracking a moving camera during an
// orbit gesture needs a value that is recomputed continuously (React state
// only updates on a caller re-render, which orbiting alone does not
// trigger), so this component runs its own rAF loop while mounted and stores
// the resolved card PLACEMENT in local state. Unmounting (the caller drops
// this element when nothing is selected) cancels the loop -- there is no
// stray rAF outliving the entry.
//
// WO UI-57 audit F2: the projected point is an ANCHOR, not the card's
// position. Every frame the raw projection is run through placeAnchoredCard,
// which keeps the card wholly inside the viewport (measured from the card's
// own positioning ancestor, or an explicit `bounds` prop) and off any docked
// panel the caller declares via `avoidRects` -- so an anchor near an edge
// slides/flips the card instead of hanging it over the Design Tree.

import { useText } from '../../../i18n'
import { useCallback, useEffect, useRef, useState } from 'react'
import { NumericInput } from '../../ui/NumericInput'
import { fmtDim, DIM_DECIMALS, type Units } from '../../../lib/ui/unitFormat'
import { useSelectAllOnClick } from '../../ui/selectAllOnClick'

export interface AnchoredValueEntryValidation {
  ok: boolean
  /** shown when ok */
  deltaText?: string
  /** shown when !ok */
  reason?: string
}

export interface AnchoredValueEntryVec3 {
  x: number
  y: number
  z: number
}

/** A box in the SAME coordinate space `projectToCanvas` reports in (canvas-/
 *  container-relative pixels, origin at the container's top-left) -- not page
 *  coordinates. */
export interface AnchoredValueEntryRect {
  left: number
  top: number
  right: number
  bottom: number
}

/** Gap between the anchor point and the card's nearest edge. */
const ANCHOR_GAP = 12
/** WO-1490/BUG-382: the current-value and delta rows separate their label from
 *  their value with `justify-content: space-between`, which gives ZERO slack
 *  when the card shrink-wraps to exactly the row's content width -- the label
 *  and value then render flush (the audit's "Convention" / "+ pulls, - pushes"
 *  capture). This explicit minimum gap keeps them apart no matter how tightly
 *  the card sizes. */
const ROW_LABEL_MIN_GAP = 12
/** Breathing room the card keeps from the viewport edge / a docked panel. */
const EDGE_MARGIN = 8
/** Used for the FIRST frame only, before the card has been measured -- keeps
 *  even that frame clamped rather than flashing off-screen. Mirrors the
 *  minWidth below and a typical rendered height. */
const FALLBACK_CARD_SIZE = { width: 176, height: 140 }

function clampRange(v: number, lo: number, hi: number): number {
  if (hi < lo) return lo // container narrower than the card: pin to the near edge.
  return Math.min(Math.max(v, lo), hi)
}

function overlaps(a: AnchoredValueEntryRect, b: AnchoredValueEntryRect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
}

/** WO UI-57 audit F2 ("the anchored card is not viewport-clamped and visibly
 *  overlaps the Design Tree"): place a `size` card near `anchor`, fully inside
 *  `bounds`, and off any `avoid` box (docked panels). Pure + exported for
 *  test. Preference order, so the card stays where the user's eye already is:
 *  above the anchor -> below the anchor -> clamped to the nearest edge. */
export function placeAnchoredCard(
  anchor: { x: number; y: number },
  size: { width: number; height: number },
  bounds: AnchoredValueEntryRect,
  avoid: readonly AnchoredValueEntryRect[] = [],
): { left: number; top: number } {
  const minLeft = bounds.left + EDGE_MARGIN
  const maxLeft = bounds.right - EDGE_MARGIN - size.width
  const minTop = bounds.top + EDGE_MARGIN
  const maxTop = bounds.bottom - EDGE_MARGIN - size.height

  let top = anchor.y - ANCHOR_GAP - size.height // preferred: above the anchor
  if (top < minTop) {
    const below = anchor.y + ANCHOR_GAP
    if (below <= maxTop) top = below // flip under the anchor rather than cover it
  }
  let left = clampRange(anchor.x - size.width / 2, minLeft, maxLeft)
  top = clampRange(top, minTop, maxTop)

  // Docked panels: slide the card clear of each obstacle horizontally (the
  // docks are full-height side panels, so a vertical dodge buys nothing),
  // preferring whichever side is reachable within bounds.
  for (const box of avoid) {
    const card = { left, top, right: left + size.width, bottom: top + size.height }
    if (!overlaps(card, box)) continue
    const toRight = box.right + EDGE_MARGIN
    const toLeft = box.left - EDGE_MARGIN - size.width
    const rightFits = toRight <= maxLeft
    const leftFits = toLeft >= minLeft
    if (rightFits && (!leftFits || Math.abs(toRight - left) <= Math.abs(toLeft - left))) left = toRight
    else if (leftFits) left = toLeft
    else left = clampRange(toRight, minLeft, maxLeft) // nowhere clear: stay in bounds
  }

  return { left, top }
}

export interface AnchoredValueEntryProps {
  testId: string
  /** Optional canonical dimension field; other callers retain their draft input. */
  numeric?: { valueMm: number; units: Units; onBlurDraft?(draft: string): void }
  anchorWorldPoint: AnchoredValueEntryVec3
  /** SceneRuntime.projectToCanvas (or an equivalent) -- canvas-relative pixel
   *  coordinates, or null when the point is behind the camera / off-screen. */
  projectToCanvas(point: AnchoredValueEntryVec3): { x: number; y: number } | null
  title: string
  currentValueLabel: string
  currentValueText: string
  valueLabel?: string
  deltaLabel: string
  initialDraft: string
  unitSuffix?: string
  validate(draft: string): AnchoredValueEntryValidation
  /** Resolves to a refusal reason (shown inline, entry stays open) or
   *  undefined on success (caller is responsible for closing/re-anchoring --
   *  this component never assumes success means "unmount me"). THE apply
   *  path -- never forked, never duplicated by a caller. */
  onApply(draft: string): Promise<string | undefined>
  onCancel(): void
  /** Optional caller-owned lifecycle readout for live-preview tools. The
   *  component renders it generically and never interprets domain details. */
  status?: {
    kind: 'idle' | 'pending' | 'ready' | 'refused' | 'applying'
    message: string
  }
  /** Additional readiness gate beyond field validation. Defaults to true. */
  canApply?: boolean
  /** Locks every card interaction during an external adoption transaction. */
  interactionDisabled?: boolean
  /** The supplement-list affordance (WO UI-58 Design: "a small affordance
   *  reachable from the armed state... never the first thing the user
   *  sees"). Omit to render no such button (a domain with no supplement). */
  extraAction?: { testId: string; label: string; onClick(): void }
  /** WO UI-57 (push/pull adopting this shared component, per this file's own
   *  header note): CONTROLLED-draft pair, additive and optional. When BOTH
   *  are provided the input's value is driven by the CALLER (e.g. a live
   *  gizmo-drag delta, updated every pointermove) instead of this
   *  component's own internal useState(initialDraft) -- lets one entry serve
   *  as both the live DRAG readout and the TYPED entry, one state, never two
   *  that can disagree. Omitting both keeps every existing caller (resize-
   *  hole) byte-identical: uncontrolled, seeded once from initialDraft. */
  draftValue?: string
  onDraftValueChange?(value: string): void
  /** WO UI-57 Design 3: when true, Enter is TWO-STAGE -- the first Enter (or
   *  any Enter/blur whose current draft differs from the last one this
   *  component itself adjusted or applied) calls onAdjust(draft) and keeps
   *  the entry open; an Enter typed with NO edit since then calls the normal
   *  onApply path instead. Blur ALWAYS adjusts, NEVER applies (the
   *  focus-loss trap -- e.g. clicking the gizmo mid-typing must never
   *  silently complete the feature). Defaults to false: every Enter applies
   *  immediately, resize-hole's existing single-stage contract, byte-
   *  identical when omitted. */
  twoStageEnter?: boolean
  /** Required when twoStageEnter is true -- the "preview this typed/dragged
   *  value, do not complete yet" seam. */
  onAdjust?(draft: string): void
  /** WO UI-57 audit F2 (card clamp). The region the card must stay inside, in
   *  the same container-relative space `projectToCanvas` reports in. OMIT and
   *  the card measures its own positioning ancestor instead -- correct
   *  whenever the caller mounts this element inside the viewport container
   *  that the projection is relative to. Supply it only when those two differ. */
  bounds?: AnchoredValueEntryRect
  /** WO UI-57 audit F2: boxes the card must not cover (docked panels -- the
   *  Design Tree), same coordinate space as `bounds`. Only the PARENT knows its
   *  own dock geometry, so this is an optional prop with a safe default (no
   *  obstacles) rather than this component reaching into the layout.
   *
   *  UI-57-R1: may also be a FUNCTION of the resolved anchor + bounds, for an
   *  obstacle that FOLLOWS the anchor rather than sitting at a fixed spot --
   *  specifically the push/pull gizmo handle, which is centred on this card's
   *  own anchor and gets covered (and its drag swallowed) by the default
   *  above-the-anchor placement. A static array cannot express that: the
   *  projected anchor only exists inside this component's own rAF loop. */
  avoidRects?: readonly AnchoredValueEntryRect[] | ((anchor: { x: number; y: number }, bounds: AnchoredValueEntryRect) => readonly AnchoredValueEntryRect[])
}

/** Small reusable screen-anchored value entry. Renders nothing while the
 *  anchor point is off-screen/behind the camera (rather than flashing at a
 *  stale or default pixel) -- it reappears the instant the point projects
 *  again, same frame the highlight/selection it accompanies would. */
export function AnchoredValueEntry({
  testId,
  numeric,
  anchorWorldPoint,
  projectToCanvas,
  title,
  currentValueLabel,
  currentValueText,
  valueLabel,
  deltaLabel,
  initialDraft,
  unitSuffix,
  validate,
  onApply,
  onCancel,
  status,
  canApply = true,
  interactionDisabled = false,
  extraAction,
  draftValue,
  onDraftValueChange,
  twoStageEnter = false,
  onAdjust,
  bounds,
  avoidRects,
}: AnchoredValueEntryProps) {
  const workbenchText = useText('sketch-and-model-workbench')
  const [placement, setPlacement] = useState<{ left: number; top: number } | null>(null)
  const cardRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const selectAllInput = useSelectAllOnClick()
  const setInputRef = useCallback((input: HTMLInputElement | null): void => {
    inputRef.current = input
    if (input === null) return
    input.focus()
    selectAllInput.arm(input)
  }, [selectAllInput])
  const [internalDraft, setInternalDraft] = useState(initialDraft)
  const [applying, setApplying] = useState(false)
  const [applyError, setApplyError] = useState<string | undefined>(undefined)
  const isControlled = draftValue !== undefined
  const draft = isControlled ? draftValue : internalDraft
  const setDraft = (value: string): void => {
    if (isControlled) onDraftValueChange?.(value)
    else setInternalDraft(value)
  }
  // Two-stage dirty tracking (Design 3): the draft value as of the last
  // Enter/blur THIS component itself adjusted or applied -- captured once at
  // mount (whatever the first-render draft is, controlled or not) and
  // updated on every adjust/apply. A draft that still equals this on the
  // NEXT Enter has had "no edit in between" (by typing OR by an external
  // controlled update, e.g. a drag) -- exactly the WO's own test phrasing.
  const lastSubmittedRef = useRef(draft)

  // Continuous reprojection while mounted -- see file header. anchorWorldPoint
  // is read fresh every frame via the ref so a caller re-anchoring (a new
  // prop value on an ALREADY-mounted instance, e.g. re-selecting the same
  // hole after a live geometry change) never needs a rAF-loop restart.
  const anchorRef = useRef(anchorWorldPoint)
  anchorRef.current = anchorWorldPoint
  const projectRef = useRef(projectToCanvas)
  projectRef.current = projectToCanvas
  const boundsRef = useRef(bounds)
  boundsRef.current = bounds
  const avoidRef = useRef(avoidRects)
  avoidRef.current = avoidRects

  useEffect(() => {
    let raf = 0
    /** The region the card may occupy. An explicit `bounds` prop wins;
     *  otherwise measure the card's own positioning ancestor, which IS the
     *  container `projectToCanvas` is relative to for a correctly-mounted
     *  caller. (`offsetParent` is the real positioning context in a browser;
     *  jsdom leaves it null, hence the parentElement fallback -- both resolve
     *  to the same element for this component's callers.) */
    const resolveBounds = (): AnchoredValueEntryRect | null => {
      if (boundsRef.current !== undefined) return boundsRef.current
      const card = cardRef.current
      const host = (card?.offsetParent as HTMLElement | null) ?? card?.parentElement ?? null
      if (host === null) return null
      const r = host.getBoundingClientRect()
      // Container-LOCAL box: the projected point is relative to this element's
      // own top-left, so its origin is (0,0), not its page position.
      return { left: 0, top: 0, right: r.width, bottom: r.height }
    }
    const tick = (): void => {
      const raw = projectRef.current(anchorRef.current)
      if (raw === null) {
        setPlacement((prev) => (prev === null ? prev : null))
      } else {
        const rect = cardRef.current?.getBoundingClientRect()
        const size =
          rect !== undefined && rect.width > 0 && rect.height > 0
            ? { width: rect.width, height: rect.height }
            : FALLBACK_CARD_SIZE
        const box = resolveBounds()
        // An anchor-relative obstacle (the push/pull handle) can only be
        // resolved here, where the projected anchor and the real bounds exist.
        const avoid = box === null
          ? []
          : typeof avoidRef.current === 'function'
            ? avoidRef.current(raw, box)
            : avoidRef.current ?? []
        const next =
          box === null
            ? { left: raw.x - size.width / 2, top: raw.y - ANCHOR_GAP - size.height }
            : placeAnchoredCard(raw, size, box, avoid)
        // Identity guard: this loop runs every frame for the whole life of the
        // entry, and an unchanged camera must not re-render the card 60x/sec.
        setPlacement((prev) => (prev !== null && prev.left === next.left && prev.top === next.top ? prev : next))
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  const numericFocused = useRef(false)
  useEffect(() => {
    if (numeric && placement !== null && !numericFocused.current) {
      numericFocused.current = true
      cardRef.current?.querySelector('input')?.focus()
    }
  }, [numeric, placement])

  const validation = validate(draft)
  const busy = applying || interactionDisabled || status?.kind === 'applying'
  const applyReady = validation.ok && canApply && !busy

  const handleApply = async (): Promise<void> => {
    if (!applyReady) return
    lastSubmittedRef.current = draft
    setApplying(true)
    setApplyError(undefined)
    try {
      const submitted = numeric ? cardRef.current?.querySelector('input')?.value ?? draft : draft
      const refusal = await onApply(submitted)
      if (refusal !== undefined) setApplyError(refusal)
    } finally {
      setApplying(false)
    }
  }

  /** WO UI-57 Design 3: the two-stage Enter/blur state machine. `isBlur`
   *  callers (focus loss) NEVER reach the apply branch -- the named
   *  "clicking the gizmo mid-typing must never silently complete" trap. */
  const handleEnterOrBlur = (isBlur: boolean): void => {
    if (!twoStageEnter) {
      if (!isBlur) void handleApply()
      return
    }
    const changed = draft !== lastSubmittedRef.current
    if (!changed) {
      if (!isBlur) void handleApply()
      return
    }
    if (validation.ok) {
      lastSubmittedRef.current = draft
      onAdjust?.(draft)
    }
    // an invalid changed draft neither adjusts nor applies -- the entry
    // stays open with its own validation reason already visible.
  }

  if (placement === null) return null

  return (
    <div
      ref={cardRef}
      data-testid={testId}
      role="dialog"
      aria-label={title}
      className="workbench-anchor-entry"
      style={{
        position: 'absolute',
        // Resolved by placeAnchoredCard: lifted above the anchor point so the
        // entry never occludes the feature it describes, flipped below it and
        // clamped when that would push it out of the viewport or over a docked
        // panel. Explicit left/top (no translate(-50%,-100%)) because the clamp
        // has to reason about the card's real edges, and a transform would move
        // them out from under it after the fact.
        left: placement.left,
        top: placement.top,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: 8,
        minWidth: 176,
        // UI-57-R1 (design cohesion): was `var(--surface-panel)`, a token that
        // EXISTS NOWHERE in tokens.css -- this file was its only user. An
        // undefined custom property resolves to nothing, so the card had NO
        // background at all: the 3D body rendered straight through it and cut
        // its own title in half (visible in the R0 evidence capture, which was
        // captured over the dark viewport where transparent looks deliberate).
        // --surface-2 is the raised-surface token every other floating panel in
        // app.css uses.
        background: 'var(--surface-2)',
        border: '1px solid var(--border-accent)',
        borderRadius: 6,
        boxShadow: '0 2px 10px rgba(0,0,0,0.35)',
        zIndex: 20,
        pointerEvents: 'auto',
        // UI-57-R1 (design cohesion): a drag gesture must never smear a text
        // selection across the card's own labels. The gizmo drag starts on the
        // canvas and sweeps over this card, so without this the browser paints
        // "Offset", the unit suffix and the button labels as selected text
        // mid-drag (visible in the R0 evidence capture). The INPUT re-enables
        // selection below -- the user must still be able to select what they
        // typed.
        userSelect: 'none',
      }}
      onBlurCapture={(e) => {
        if (numeric && e.target instanceof HTMLInputElement) numeric.onBlurDraft?.(e.target.value)
      }}
      onKeyDownCapture={(e) => {
        // A dimension caller owns Enter adoption. Keep the NumericInput's blur
        // normalization from replacing its raw draft before that caller reads it.
        if (numeric && e.key === 'Enter' && e.target instanceof HTMLInputElement) {
          e.preventDefault(); e.stopPropagation(); void handleApply()
        }
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); handleEnterOrBlur(false) }
        else if (e.key === 'Escape') { e.preventDefault(); onCancel() }
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-secondary)', fontSize: 'var(--font-size-sm)' }}>
        <span>{title}</span>
        {extraAction !== undefined && (
          <button
            type="button"
            data-testid={extraAction.testId}
            className="modal-btn modal-btn-ghost"
            disabled={interactionDisabled}
            style={{ minHeight: 20, padding: '0 6px', fontSize: 'var(--font-size-sm)' }}
            onClick={extraAction.onClick}
          >
            {extraAction.label}
          </button>
        )}
      </div>
      <div data-testid={`${testId}-current`} style={{ display: 'flex', justifyContent: 'space-between', gap: ROW_LABEL_MIN_GAP, color: 'var(--text-secondary)' }}>
        <span>{currentValueLabel}</span>
        <span style={{ fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums' }}>{currentValueText}</span>
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {valueLabel !== undefined && <span style={{ color: 'var(--text-secondary)' }}>{valueLabel}</span>}
        {numeric ? <NumericInput value={numeric.valueMm} units={numeric.units} decimals={DIM_DECIMALS[numeric.units]} ariaLabel={valueLabel ?? title}
          onChange={(value) => setDraft(fmtDim(value, numeric.units))}
          style={{ width: 96, background: 'var(--surface-1)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)', borderRadius: 4, padding: '3px 6px', fontFamily: 'var(--font-mono)' }} /> : (
        <input
          ref={setInputRef}
          type="text"
          inputMode="decimal"
          autoFocus
          data-testid={`${testId}-input`}
          value={draft}
          disabled={interactionDisabled}
          aria-invalid={!validation.ok}
          // userSelect re-enabled: the card suppresses selection for the drag
          // gesture, but the value the user typed must stay selectable.
          // Cohesion fix (UI-70 card drive, 2026-07-17): the browser-default
          // white input on the dark anchored card was the last remnant of
          // Operator's T-UI58 complaint - the UI-70 branch fixed it via the
          // .workbench-anchor-* css family, but the split-merge resolved this
          // file to main's inline-styled version and dropped the input's
          // styling. Tokens inline until BK-168 converts the whole card.
          // Merge-seam fix (INT-14 adaptation): the three custom properties above
          // (--surface-3, --border-default, --danger) are not defined anywhere in
          // src/theme/tokens.css or src/styles/app.css -- phantom tokens caught by
          // the UI-70 cohesion census's fallback-guarded-phantom gate. Replaced with
          // the real semantic tokens closest to each fallback's own hex value:
          // --surface-1 (slate-900, #161b22) for the darkest available surface,
          // --border-subtle (slate-700, #2d3748) for the #2a3648 border, and
          // --status-error (red-500, #e05252) for the #b34a4a danger border --
          // matching the same border-color: var(--status-error) precedent already
          // used at app.css:6880. No fallback guard: these ARE defined tokens.
          style={{
            width: 96, fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums', userSelect: 'text',
            background: 'var(--surface-1)', color: 'var(--text-primary)',
            border: `1px solid ${validation.ok ? 'var(--border-subtle)' : 'var(--status-error)'}`,
            borderRadius: 4, padding: '3px 6px', outline: 'none',
          }}
          onFocus={selectAllInput.onFocus}
          // WO-406: onClick, not onMouseUp - the workbench's one sketch draw machine
          // owns down/up gestures under src/components/model3d (SKC-15C gate).
          onClick={selectAllInput.onClick}
          onChange={(e) => { setDraft(e.target.value); setApplyError(undefined) }}
          onBlur={() => handleEnterOrBlur(true)}
        />
        )}
        {unitSuffix !== undefined && <span style={{ color: 'var(--text-muted)' }}>{unitSuffix}</span>}
      </label>
      <div data-testid={`${testId}-delta`} style={{ display: 'flex', justifyContent: 'space-between', gap: ROW_LABEL_MIN_GAP, color: validation.ok ? 'var(--text-primary)' : 'var(--text-muted)' }}>
        <span>{deltaLabel}</span>
        <span style={{ fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums' }}>
          {validation.ok ? validation.deltaText : '--'}
        </span>
      </div>
      {!validation.ok && (
        <div data-testid={`${testId}-validation`} style={{ color: 'var(--text-danger)', fontSize: 'var(--font-size-sm)' }}>
          {validation.reason}
        </div>
      )}
      {status !== undefined && (
        <div
          data-testid={`${testId}-status`}
          data-status={status.kind}
          aria-live="polite"
          style={{
            color: status.kind === 'refused'
              ? 'var(--text-danger)'
              : status.kind === 'ready'
                ? 'var(--status-ready)'
                : 'var(--text-secondary)',
            fontSize: 'var(--font-size-sm)',
          }}
        >
          {status.message}
        </div>
      )}
      {applyError !== undefined && (
        <div data-testid={`${testId}-apply-error`} style={{ color: 'var(--text-danger)', fontSize: 'var(--font-size-sm)' }}>
          {applyError}
        </div>
      )}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
        <button type="button" data-testid={`${testId}-cancel`} className="modal-btn modal-btn-ghost" disabled={interactionDisabled} onClick={onCancel}>
          {workbenchText('AnchoredValueEntry.cancel')}</button>
        <button
          type="button"
          data-testid={`${testId}-apply`}
          className="modal-btn modal-btn-primary"
          disabled={!applyReady}
          onClick={() => void handleApply()}
        >
          {busy ? workbenchText('AnchoredValueEntry.applying') : workbenchText('AnchoredValueEntry.apply')}
        </button>
      </div>
    </div>
  )
}
