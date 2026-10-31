// WO-3278: the number field. Stored units in and out; the units service shows and reads them
// (user unit, locale decimal mark, a typed unit suffix converts). An entry that cannot be read
// keeps the old value and shows the service's catalogue reason (LIENCAM.md rule 11).
import { useId, useState, type KeyboardEvent } from 'react'
import { units } from '../../../lib/units'
import type { Quantity } from '../../../lib/units/types'
import { resolveMessage } from '../../../notices'
import type { MessageKey } from '../../../notices/types'
import type { NumberFieldProps } from '../types'
import { describedBy, useReason } from './reason'

/** Arrow-key step in stored units when the screen gives none. */
const DEFAULT_STEP: Readonly<Record<Quantity, number>> = {
  length: 1, angle: 1, feed: 10, speed: 100, count: 1, percent: 1, time: 1, none: 1,
}
const round = (v: number) => Math.round(v * 1e9) / 1e9

export function NumberField(p: NumberFieldProps) {
  const reason = useReason(p.availability)
  const errorId = useId()
  const [draft, setDraft] = useState<string | null>(null)
  const [error, setError] = useState<MessageKey | null>(null)
  const shown = p.value === null ? '' : units.format(p.quantity, p.value, { withUnit: false, precision: p.precision })
  const clamp = (v: number) => Math.min(p.max ?? Infinity, Math.max(p.min ?? -Infinity, v))

  /** True when the draft is settled (committed, empty, or none); false when it could not be read. */
  const commit = (): boolean => {
    if (draft === null) return true
    if (reason.blocked) { setDraft(null); setError(null); return true }
    const text = draft.trim()
    if (text === '') {
      setDraft(null)
      setError(null)
      if (p.optional && p.value !== null) p.onChange(null)
      return true
    }
    const parsed = units.parse(p.quantity, text)
    if (!parsed.ok) { setError(parsed.reason); return false }
    setDraft(null)
    setError(null)
    p.onChange(clamp(parsed.value))
    return true
  }

  const nudge = (direction: 1 | -1, factor: number) => {
    const typed = draft === null ? null : units.parse(p.quantity, draft.trim())
    if (typed && !typed.ok) { setError(typed.reason); return }
    const base = typed?.ok ? typed.value : p.value ?? 0
    setDraft(null)
    setError(null)
    p.onChange(clamp(round(base + direction * (p.step ?? DEFAULT_STEP[p.quantity]) * factor)))
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (reason.blocked) return
    switch (e.key) {
      case 'Enter': e.preventDefault(); commit(); break
      case 'Escape':
        if (draft !== null) { e.preventDefault(); e.stopPropagation(); setDraft(null); setError(null) }
        else if (error !== null) setError(null)
        break
      case 'ArrowUp': e.preventDefault(); nudge(1, e.shiftKey ? 10 : 1); break
      case 'ArrowDown': e.preventDefault(); nudge(-1, e.shiftKey ? 10 : 1); break
      case 'PageUp': e.preventDefault(); nudge(1, 10); break
      case 'PageDown': e.preventDefault(); nudge(-1, 10); break
    }
  }

  return (
    <span
      className="kit-field kit-number"
      data-kit="NumberField"
      data-testid={p.testId}
      data-unavailable={reason.blocked || undefined}
      data-lock={reason.lock || undefined}
      data-invalid={error !== null || undefined}
    >
      <input
        type="text"
        inputMode="decimal"
        autoComplete="off"
        spellCheck={false}
        aria-label={p.ariaLabel}
        aria-invalid={error !== null || undefined}
        aria-disabled={reason.blocked || undefined}
        aria-describedby={describedBy(error !== null ? errorId : undefined, reason.tipId)}
        readOnly={reason.blocked}
        value={draft ?? shown}
        onChange={e => { if (reason.blocked) return; setDraft(e.target.value); setError(null) }}
        onFocus={e => e.currentTarget.select()}
        onBlur={() => { if (!commit()) setDraft(null) }}
        onKeyDown={onKeyDown}
      />
      <span className="kit-unit" aria-hidden="true">{units.unitLabel(p.quantity)}</span>
      {error !== null && <span role="alert" id={errorId} className="kit-error">{resolveMessage(error)}</span>}
      {reason.tip}
    </span>
  )
}
