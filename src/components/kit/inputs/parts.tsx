// WO-3278: TextField, Select, Segmented, Toggle and Slider. An unavailable part keeps focus,
// ignores every change and says why (./reason.tsx).
import { useRef, type KeyboardEvent } from 'react'
import { units } from '../../../lib/units'
import type { SegmentedProps, SelectProps, SliderProps, TextFieldProps, ToggleProps } from '../types'
import { describedBy, useReason } from './reason'

const flags = (reason: ReturnType<typeof useReason>) => ({
  'data-unavailable': reason.blocked || undefined,
  'data-lock': reason.lock || undefined,
})

export function TextField(p: TextFieldProps) {
  const reason = useReason(p.availability)
  return (
    <span className={p.mono ? 'kit-field kit-text kit-mono' : 'kit-field kit-text'} data-kit="TextField" data-testid={p.testId} {...flags(reason)}>
      <input
        type="text"
        aria-label={p.ariaLabel}
        aria-disabled={reason.blocked || undefined}
        aria-describedby={describedBy(reason.tipId)}
        readOnly={reason.blocked}
        placeholder={p.placeholder}
        value={p.value}
        onChange={e => { if (!reason.blocked) p.onChange(e.target.value) }}
      />
      {reason.tip}
    </span>
  )
}

export function Select<T extends string>(p: SelectProps<T>) {
  const reason = useReason(p.availability)
  return (
    <span className="kit-field kit-select" data-kit="Select" data-testid={p.testId} {...flags(reason)}>
      <select
        aria-label={p.ariaLabel}
        aria-disabled={reason.blocked || undefined}
        aria-describedby={describedBy(reason.tipId)}
        value={p.value}
        onChange={e => { if (!reason.blocked) p.onChange(e.target.value as T) }}
        onMouseDown={e => { if (reason.blocked) e.preventDefault() }}
        onKeyDown={e => { if (reason.blocked && e.key !== 'Tab') e.preventDefault() }}
      >
        {p.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <span className="kit-chevron" aria-hidden="true" />
      {reason.tip}
    </span>
  )
}

export function Segmented<T extends string>(p: SegmentedProps<T>) {
  const reason = useReason(p.availability)
  const group = useRef<HTMLSpanElement>(null)
  const checked = p.options.findIndex(o => o.value === p.value)
  const tabStop = checked >= 0 ? checked : 0
  const go = (to: number) => {
    if (reason.blocked || p.options.length === 0) return
    const at = (to + p.options.length) % p.options.length
    p.onChange(p.options[at].value)
    group.current?.querySelectorAll<HTMLElement>('[role="radio"]')[at]?.focus()
  }
  const onKeyDown = (i: number) => (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return
    const to = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? i + 1
      : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? i - 1
        : e.key === 'Home' ? 0
          : e.key === 'End' ? p.options.length - 1
            : null
    if (to === null) return
    e.preventDefault()
    go(to)
  }
  return (
    <span className="kit-field kit-segmented" data-kit="Segmented" data-testid={p.testId} {...flags(reason)}>
      <span ref={group} role="radiogroup" aria-label={p.ariaLabel} aria-describedby={describedBy(reason.tipId)} className="kit-segments">
        {p.options.map((o, i) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            className="kit-segment"
            aria-checked={i === checked}
            aria-disabled={reason.blocked || undefined}
            tabIndex={i === tabStop ? 0 : -1}
            onClick={() => { if (!reason.blocked) p.onChange(o.value) }}
            onKeyDown={onKeyDown(i)}
          >
            {o.label}
          </button>
        ))}
      </span>
      {reason.tip}
    </span>
  )
}

export function Toggle(p: ToggleProps) {
  const reason = useReason(p.availability)
  return (
    <span className="kit-field kit-toggle" data-kit="Toggle" data-testid={p.testId} {...flags(reason)}>
      <label className="kit-toggle-label">
        <input
          type="checkbox"
          aria-label={p.ariaLabel}
          aria-disabled={reason.blocked || undefined}
          aria-describedby={describedBy(reason.tipId)}
          checked={p.on}
          onClick={e => { if (reason.blocked) e.preventDefault() }}
          onChange={e => { if (!reason.blocked) p.onChange(e.target.checked) }}
        />
        <span className="kit-box" aria-hidden="true" />
        <span className="kit-toggle-text">{p.label}</span>
      </label>
      {reason.tip}
    </span>
  )
}

export function Slider(p: SliderProps) {
  const reason = useReason(p.availability)
  const text = p.quantity === undefined ? undefined : units.format(p.quantity, p.value)
  return (
    <span className="kit-field kit-slider" data-kit="Slider" data-testid={p.testId} {...flags(reason)}>
      <input
        type="range"
        aria-label={p.ariaLabel}
        aria-valuetext={text}
        aria-disabled={reason.blocked || undefined}
        aria-describedby={describedBy(reason.tipId)}
        min={p.min}
        max={p.max}
        step={p.step}
        value={p.value}
        onChange={e => { if (!reason.blocked) p.onChange(e.target.valueAsNumber) }}
        onPointerDown={e => { if (reason.blocked) e.preventDefault() }}
        onKeyDown={e => { if (reason.blocked && e.key !== 'Tab') e.preventDefault() }}
      />
      {text !== undefined && <span className="kit-readout" aria-hidden="true">{text}</span>}
      {reason.tip}
    </span>
  )
}
