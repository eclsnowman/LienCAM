// WO-3280: RibbonGroup, PromptBar and AnchoredValue.
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import type { AnchoredValueProps, PromptBarProps, RibbonGroupProps } from '../types'
import { Button } from './Button'
import { resolveMessage } from '../../../notices'
import { useText } from '../../../i18n'
import { units } from '../../../lib/units'

/** A band of tools over a caption. A caption with a menu is a button (the ▾ opens the group's
 *  full menu); without one it is plain text. */
export function RibbonGroup(p: RibbonGroupProps) {
  return (
    <div className="kit-ribbongroup" role="group" aria-label={p.caption} data-kit="RibbonGroup" data-testid={p.testId}>
      <div className="kit-ribbongroup-tools">{p.children}</div>
      {p.onOpenMenu !== undefined ? (
        <button type="button" className="kit-ribbongroup-caption" aria-haspopup="menu" onClick={() => p.onOpenMenu?.()}>
          {p.caption}<span className="kit-caret" aria-hidden="true" />
        </button>
      ) : (
        <span className="kit-ribbongroup-caption">{p.caption}</span>
      )}
    </div>
  )
}

/** One line for every pick prompt: the prompt, the step, an Esc key cap and Cancel; the tool's
 *  own actions (Done) come in through actions. */
export function PromptBar(p: PromptBarProps) {
  const t = useText('ui2-actions.wo3280')
  const keyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Escape' || p.onCancel === undefined) return
    e.stopPropagation()
    p.onCancel()
  }
  return (
    <div className="kit-promptbar" role="group" aria-label={p.prompt} data-kit="PromptBar" data-testid={p.testId} onKeyDown={keyDown}>
      {p.step && <span className="kit-promptbar-step">{p.step.index}/{p.step.count}</span>}
      <span className="kit-promptbar-text">{p.prompt}</span>
      {p.onCancel !== undefined && <kbd className="kit-keycap">{t('escKey')}</kbd>}
      {p.onCancel !== undefined && <Button kind="momentary" emphasis="ghost" label={t('cancel')} onPress={p.onCancel} />}
      {p.actions}
    </div>
  )
}

/** A number typed at a point in the viewport. Enter applies, Escape cancels; an entry that is
 *  not a number stays open with the units service's reason. */
export function AnchoredValue(p: AnchoredValueProps) {
  const [text, setText] = useState(p.value === null ? '' : units.format(p.quantity, p.value, { withUnit: false }))
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => { input.current?.focus(); input.current?.select() }, [])
  const where = { '--kit-x': `${p.anchor.x}px`, '--kit-y': `${p.anchor.y}px` } as CSSProperties
  const unit = units.unitLabel(p.quantity)
  const errorId = `${p.testId ?? 'kit-anchoredvalue'}-error`
  const keyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') { e.stopPropagation(); p.onCancel(); return }
    if (e.key !== 'Enter') return
    const parsed = units.parse(p.quantity, text)
    if (parsed.ok) p.onCommit(parsed.value)
    else setError(resolveMessage(parsed.reason))
  }
  return (
    <div className="kit-anchoredvalue" data-kit="AnchoredValue" data-testid={p.testId} style={where}>
      <input
        ref={input}
        className="kit-anchoredvalue-input"
        type="text"
        inputMode="decimal"
        aria-label={p.ariaLabel}
        aria-invalid={error === null ? undefined : true}
        aria-describedby={error === null ? undefined : errorId}
        value={text}
        onChange={e => { setText(e.target.value); setError(null) }}
        onKeyDown={keyDown}
      />
      <span className="kit-anchoredvalue-unit">{unit}</span>
      {error !== null && <span className="kit-anchoredvalue-error" id={errorId} role="alert">{error}</span>}
    </div>
  )
}
