import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { Check, ChevronDown } from 'lucide-react'

// ============================================================
// ThemedListbox - a themed, fully-accessible custom select control
// (UI-BRAND-B3-1, Q-65 verdict "Option 2 - custom list (scoped)").
// ============================================================
// SCOPE (Operator's explicit pick, REJ-1): this control is deployed ONLY to the
// highest-friction menus - the Settings modal selects and the Post Processor
// modal selects. Every OTHER native <select> in the app stays native. It is
// NOT a blanket replacement for all 83 native selects (that was rejected as a
// functionality gamble; native selects carry OS-level keyboard/screen-reader/
// touch behavior a hand-rolled listbox must RE-EARN one at a time).
//
// The bar (SKC-44-level): this control RE-EARNS native behavior, it does not
// approximate it. It follows the WAI-ARIA APG "Select-Only Combobox" pattern:
//   - the trigger is role=combobox and KEEPS DOM FOCUS the whole time; the
//     visual "active option" is tracked with aria-activedescendant (so there
//     is no focus to trap and focus is inherently returned to the trigger on
//     close - the popup never steals it).
//   - full keyboard: Tab focus, Enter/Space open, Enter/Space select+close,
//     Arrow navigation (skips disabled), Home/End, first-letter type-ahead,
//     Esc close-without-change, Tab closes.
//   - click-outside close, scroll-into-view for the active option, long-list
//     scrolling, disabled-option support, correct ARIA wiring.
//   - the popup is PORTALED to document.body and position:fixed, positioned
//     from the trigger's rect and repositioned on scroll/resize, so it can
//     never be clipped by a modal body's own overflow:auto scroll region (an
//     absolutely-positioned popup inside the scrolling Settings body WOULD be
//     clipped near the bottom - the exact defect this avoids).
//
// VALUE CONTRACT: identical to the native <select> it replaces. `value` is the
// current option value (string); `onChange(value)` fires only when a DIFFERENT
// option is chosen (matching native change semantics). Consumers see zero
// behavioral change - drop-in for `<select value onChange>`.

export interface ThemedListboxOption {
  value: string
  /** Display text AND the string matched by type-ahead. */
  label: string
  disabled?: boolean
}

export interface ThemedListboxGroup {
  /** Group heading (non-selectable, like <optgroup label>). */
  label: string
  options: ThemedListboxOption[]
}

export type ThemedListboxItems = ReadonlyArray<ThemedListboxOption | ThemedListboxGroup>

function isGroup(item: ThemedListboxOption | ThemedListboxGroup): item is ThemedListboxGroup {
  return Array.isArray((item as ThemedListboxGroup).options)
}

interface ThemedListboxProps {
  value: string
  onChange: (value: string) => void
  /** Flat options, or a mix of options and <optgroup>-style groups. */
  options: ThemedListboxItems
  disabled?: boolean
  /** Extra class(es) on the outer wrapper (which carries flex:1 by default). */
  className?: string
  /** data-testid on the trigger button. Options get `${testId}-option-${value}`. */
  testId?: string
  /** Accessible name if there is no visible <label> wired via ariaLabelledBy. */
  ariaLabel?: string
  /** id of the visible label element (preferred over ariaLabel when one exists). */
  ariaLabelledBy?: string
  /** Shown on the trigger when `value` matches no option. */
  placeholder?: string
  /** Hover/focus hint, shown via the shared ThemedTooltip (data-tooltip). */
  tooltip?: string
}

interface PopupPos {
  left?: number
  right?: number
  top: number
  minWidth: number
  maxWidth: number
  maxHeight: number
  /** true when the popup opens above the trigger (not enough room below). */
  above: boolean
}

const POPUP_MAX_HEIGHT = 288
const POPUP_MAX_WIDTH = 480
const VIEWPORT_MARGIN = 8
const TYPEAHEAD_RESET_MS = 600

export function ThemedListbox({
  value,
  onChange,
  options,
  disabled = false,
  className,
  testId,
  ariaLabel,
  ariaLabelledBy,
  placeholder,
  tooltip,
}: ThemedListboxProps) {
  const reactId = useId()
  const baseId = `tlb-${reactId}`
  const listboxId = `${baseId}-listbox`
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const popupRef = useRef<HTMLUListElement | null>(null)

  const [open, setOpen] = useState(false)
  // Index into `flat` of the visually-active (highlighted) option.
  const [activeIndex, setActiveIndex] = useState(-1)
  const [pos, setPos] = useState<PopupPos | null>(null)

  // A flat, render-order list of the selectable options (groups contribute
  // their children in order). Used for keyboard navigation and type-ahead.
  const flat = useMemo(() => {
    const out: ThemedListboxOption[] = []
    for (const item of options) {
      if (isGroup(item)) out.push(...item.options)
      else out.push(item)
    }
    return out
  }, [options])

  const selectedIndex = useMemo(
    () => flat.findIndex((o) => o.value === value),
    [flat, value],
  )
  const selected = selectedIndex >= 0 ? flat[selectedIndex] : undefined
  const triggerText = selected?.label ?? placeholder ?? value

  const firstEnabled = useCallback(
    (): number => flat.findIndex((o) => !o.disabled),
    [flat],
  )
  const lastEnabled = useCallback((): number => {
    for (let i = flat.length - 1; i >= 0; i--) if (!flat[i].disabled) return i
    return -1
  }, [flat])
  // Next enabled index from `from` moving `dir` (+1/-1); no wrap. -1 if none.
  const stepEnabled = useCallback(
    (from: number, dir: 1 | -1): number => {
      let i = from + dir
      while (i >= 0 && i < flat.length) {
        if (!flat[i].disabled) return i
        i += dir
      }
      return -1
    },
    [flat],
  )

  const optionId = (index: number) => `${baseId}-opt-${index}`

  // ---- open/close ----------------------------------------------------------
  const openPopup = useCallback(() => {
    if (disabled) return
    setActiveIndex(selectedIndex >= 0 && !flat[selectedIndex]?.disabled
      ? selectedIndex
      : firstEnabled())
    setOpen(true)
  }, [disabled, selectedIndex, flat, firstEnabled])

  const closePopup = useCallback((refocus = true) => {
    setOpen(false)
    setActiveIndex(-1)
    if (refocus) triggerRef.current?.focus()
  }, [])

  const commit = useCallback(
    (index: number) => {
      const opt = flat[index]
      if (!opt || opt.disabled) return
      if (opt.value !== value) onChange(opt.value)
      closePopup()
    },
    [flat, value, onChange, closePopup],
  )

  // ---- positioning (portal, fixed, glued to the trigger) -------------------
  const computePos = useCallback(() => {
    const el = triggerRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const spaceBelow = window.innerHeight - rect.bottom - VIEWPORT_MARGIN
    const spaceAbove = rect.top - VIEWPORT_MARGIN
    // Prefer below; flip above only when below is too tight AND above is roomier.
    const above = spaceBelow < Math.min(POPUP_MAX_HEIGHT, 160) && spaceAbove > spaceBelow
    const avail = above ? spaceAbove : spaceBelow
    const maxHeight = Math.max(96, Math.min(POPUP_MAX_HEIGHT, avail))
    // Grow toward the roomier side of the trigger. The popup's CSS gives it
    // intrinsic content width; these bounds cap that growth at 480px and keep
    // both horizontal edges inside the viewport margin.
    const alignRight = rect.left + rect.width / 2 > window.innerWidth / 2
    const horizontalOffset = alignRight
      ? Math.max(VIEWPORT_MARGIN, window.innerWidth - rect.right)
      : Math.max(VIEWPORT_MARGIN, rect.left)
    const maxWidth = Math.max(0, Math.min(
      POPUP_MAX_WIDTH,
      window.innerWidth - horizontalOffset - VIEWPORT_MARGIN,
    ))
    setPos({
      ...(alignRight ? { right: horizontalOffset } : { left: horizontalOffset }),
      top: above ? rect.top - 4 : rect.bottom + 4,
      minWidth: Math.min(rect.width, maxWidth),
      maxWidth,
      maxHeight,
      above,
    })
  }, [])

  useLayoutEffect(() => {
    if (!open) return
    computePos()
    const onScroll = () => computePos()
    const onResize = () => computePos()
    // Capture phase so ANY scrolling ancestor (the modal body) triggers it.
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onResize)
    }
  }, [open, computePos])

  // Scroll the active option into view whenever it changes while open.
  useEffect(() => {
    if (!open || activeIndex < 0) return
    // Options render in flat order (groups contribute their children in order),
    // so the Nth [role=option] is `flat[N]`. Index directly - no id escaping,
    // which keeps this robust where the `CSS` global is absent (some jsdom).
    const nodes = popupRef.current?.querySelectorAll<HTMLElement>('[role="option"]')
    const node = nodes?.[activeIndex]
    // Guarded: jsdom throws "Not implemented" for scrollIntoView.
    try { node?.scrollIntoView({ block: 'nearest' }) } catch { /* no-op in jsdom */ }
  }, [open, activeIndex])

  // Click/pointer outside closes (without refocusing - focus follows the click).
  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (triggerRef.current?.contains(t) || popupRef.current?.contains(t)) return
      closePopup(false)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [open, closePopup])

  // ---- type-ahead (first-letter jump) --------------------------------------
  const typeahead = useRef({ str: '', timer: 0 as number | ReturnType<typeof setTimeout> })
  const runTypeahead = useCallback(
    (char: string) => {
      clearTimeout(typeahead.current.timer as ReturnType<typeof setTimeout>)
      typeahead.current.str += char.toLowerCase()
      const query = typeahead.current.str
      typeahead.current.timer = setTimeout(() => {
        typeahead.current.str = ''
      }, TYPEAHEAD_RESET_MS)

      // Search order starts AFTER the active option so repeated same-letter
      // presses cycle through matches (standard listbox behavior).
      const from = open ? activeIndex : selectedIndex
      const n = flat.length
      const start = from < 0 ? 0 : from
      // When the query is a single repeated char, advance past the current match.
      const singleRepeat = query.length > 1 && query.split('').every((c) => c === query[0])
      const effQuery = singleRepeat ? query[0] : query
      const offset = singleRepeat ? 1 : 0
      for (let k = 0; k < n; k++) {
        const i = (start + offset + k) % n
        const opt = flat[i]
        if (opt.disabled) continue
        if (opt.label.toLowerCase().startsWith(effQuery)) {
          if (open) setActiveIndex(i)
          else if (opt.value !== value) onChange(opt.value)
          return
        }
      }
    },
    [open, activeIndex, selectedIndex, flat, onChange, value],
  )

  useEffect(() => () => clearTimeout(typeahead.current.timer as ReturnType<typeof setTimeout>), [])

  // ---- keyboard ------------------------------------------------------------
  const onKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return
    const key = e.key

    if (!open) {
      switch (key) {
        case 'ArrowDown':
        case 'ArrowUp':
        case 'Enter':
        case ' ':
        case 'Spacebar':
          e.preventDefault()
          openPopup()
          return
        case 'Home':
        case 'End':
          e.preventDefault()
          openPopup()
          return
        default:
          if (key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
            e.preventDefault()
            runTypeahead(key)
          }
          return
      }
    }

    // open:
    switch (key) {
      case 'ArrowDown': {
        e.preventDefault()
        const next = stepEnabled(activeIndex, 1)
        if (next >= 0) setActiveIndex(next)
        return
      }
      case 'ArrowUp': {
        e.preventDefault()
        const prev = stepEnabled(activeIndex, -1)
        if (prev >= 0) setActiveIndex(prev)
        return
      }
      case 'Home': {
        e.preventDefault()
        const f = firstEnabled()
        if (f >= 0) setActiveIndex(f)
        return
      }
      case 'End': {
        e.preventDefault()
        const l = lastEnabled()
        if (l >= 0) setActiveIndex(l)
        return
      }
      case 'Enter':
      case ' ':
      case 'Spacebar':
        e.preventDefault()
        commit(activeIndex)
        return
      case 'Escape':
        e.preventDefault()
        closePopup()
        return
      case 'Tab':
        // Let focus move on naturally; just close (no refocus).
        closePopup(false)
        return
      default:
        if (key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
          e.preventDefault()
          runTypeahead(key)
        }
    }
  }

  // ---- render --------------------------------------------------------------
  const activeDescendant = open && activeIndex >= 0 ? optionId(activeIndex) : undefined

  // Render the popup children, tracking a running flat index so each option's
  // id/active/selected state maps back to `flat`.
  let flatCursor = 0
  const renderOption = (opt: ThemedListboxOption) => {
    const index = flatCursor++
    const isSelected = opt.value === value
    const isActive = index === activeIndex
    return (
      <li
        key={opt.value}
        id={optionId(index)}
        role="option"
        aria-selected={isSelected}
        aria-disabled={opt.disabled || undefined}
        data-testid={testId ? `${testId}-option-${opt.value}` : undefined}
        className={
          'themed-listbox-option' +
          (isActive ? ' is-active' : '') +
          (opt.disabled ? ' is-disabled' : '')
        }
        // Highlight-follows-pointer, but never commit on hover.
        onMouseMove={() => { if (!opt.disabled && index !== activeIndex) setActiveIndex(index) }}
        // Commit on click. mousedown is prevented so the trigger keeps focus.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => commit(index)}
      >
        <span className="themed-listbox-check" aria-hidden="true">
          {isSelected && <Check size={14} />}
        </span>
        <span className="themed-listbox-option-label">{opt.label}</span>
      </li>
    )
  }

  // Authored IN PLACE (never portaled - the overlay-authoring law refuses
  // createPortal). position:fixed with viewport coords still escapes the modal
  // body's overflow:auto clip: this control is used only inside modals, whose
  // viewport-sized .modal-backdrop is the fixed containing block.
  const popup = open && pos
    ? (
        <ul
          ref={popupRef}
          id={listboxId}
          role="listbox"
          aria-label={ariaLabel}
          aria-labelledby={ariaLabelledBy}
          className="themed-listbox-popup"
          style={{
            ...(pos.left !== undefined ? { left: pos.left } : { right: pos.right }),
            minWidth: pos.minWidth,
            maxWidth: pos.maxWidth,
            maxHeight: pos.maxHeight,
            ...(pos.above
              ? { bottom: window.innerHeight - pos.top }
              : { top: pos.top }),
          }}
        >
          {options.map((item, gi) =>
            isGroup(item) ? (
              <li key={`g-${gi}`} role="presentation" className="themed-listbox-group">
                <div className="themed-listbox-group-label" aria-hidden="true">{item.label}</div>
                <ul role="group" aria-label={item.label} className="themed-listbox-group-list">
                  {item.options.map((o) => renderOption(o))}
                </ul>
              </li>
            ) : (
              renderOption(item)
            ),
          )}
        </ul>
      )
    : null

  return (
    <div className={className ? `themed-listbox ${className}` : 'themed-listbox'}>
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-activedescendant={activeDescendant}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        aria-disabled={disabled || undefined}
        disabled={disabled}
        data-testid={testId}
        data-tooltip={tooltip}
        className={'themed-listbox-trigger' + (open ? ' is-open' : '')}
        onClick={() => (open ? closePopup() : openPopup())}
        onKeyDown={onKeyDown}
      >
        <span className="themed-listbox-value">{triggerText}</span>
        <ChevronDown size={14} className="themed-listbox-arrow" aria-hidden="true" />
      </button>
      {popup}
    </div>
  )
}
