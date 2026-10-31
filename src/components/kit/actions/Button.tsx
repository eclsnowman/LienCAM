// WO-3280: the kit Button. Four kinds that look the same everywhere (spec 7.1): momentary is
// held (solid, sunk) only while pressed, latched carries a lamp, choice is a selected segment,
// transport keeps its status colours. A button whose command cannot run now shows the reason
// (LIENCAM.md rule 11) and does nothing; it stays focusable so the reason is reachable.
import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { assertButtonKind } from './buttonKind'
import { Icon, LockGlyph } from './icon'
import type { ButtonProps } from '../types'
import { resolveMessage } from '../../../notices'
import { useText } from '../../../i18n'

export function Button(props: ButtonProps) {
  assertButtonKind(props)
  const p = props
  const t = useText('ui2-actions.wo3280')
  const tipId = useId()
  const [held, setHeld] = useState(false)
  const started = useRef(false)
  const latest = useRef(p)
  useEffect(() => { latest.current = p })

  const ready = p.availability === undefined || p.availability.ready
  const pressable = p.kind === 'momentary' || p.kind === 'transport'
  // press-and-hold (a jog key): the action starts on press and ends on release
  const hold = pressable && p.onRelease !== undefined

  const begin = () => {
    if (!ready || !pressable || started.current) return
    started.current = true
    setHeld(true)
    if (hold) p.onPress()
  }
  const end = () => {
    if (!started.current) return
    started.current = false
    setHeld(false)
    if (hold) p.onRelease?.()
  }
  // a hold must end even when the button goes away mid-press
  useEffect(() => () => {
    const cur = latest.current
    if (started.current && (cur.kind === 'momentary' || cur.kind === 'transport')) {
      started.current = false
      cur.onRelease?.()
    }
  }, [])

  const click = () => {
    if (!ready || hold) return
    switch (p.kind) {
      case 'momentary': p.onPress(); break
      case 'latched': p.onToggle(!p.on); break
      case 'choice': p.onSelect(); break
      case 'transport': p.onPress(); break
    }
  }
  const down = (e: PointerEvent<HTMLButtonElement>) => { if ((e.button ?? 0) === 0) begin() }
  const keyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== 'Enter' && e.key !== ' ') return
    if (hold) e.preventDefault()
    if (!e.repeat) begin()
  }
  const keyUp = (e: KeyboardEvent<HTMLButtonElement>) => { if (e.key === 'Enter' || e.key === ' ') end() }

  const on = p.kind === 'latched' ? p.on : p.kind === 'choice' ? p.selected : p.kind === 'transport' ? (p.active ?? false) : undefined
  const form = p.form ?? 'text'
  const reason = p.availability !== undefined && !p.availability.ready ? resolveMessage(p.availability.reason, p.availability.params) : null
  const lock = p.availability !== undefined && !p.availability.ready && p.availability.lock === true
  return (
    <span className="kit-buttonwrap" data-form={form}>
      <button
        type="button"
        className="kit-button"
        data-kit="Button"
        data-kind={p.kind}
        data-form={form}
        data-emphasis={p.emphasis ?? 'secondary'}
        data-transport={p.kind === 'transport' ? p.transport : undefined}
        data-on={on}
        data-held={held}
        data-unavailable={!ready}
        data-testid={p.testId}
        aria-label={form === 'icon' ? p.label : undefined}
        aria-pressed={p.kind === 'latched' || p.kind === 'choice' || (p.kind === 'transport' && p.active !== undefined) ? on : undefined}
        aria-disabled={!ready}
        aria-describedby={reason === null ? undefined : tipId}
        onClick={click}
        onPointerDown={pressable ? down : undefined}
        onPointerUp={pressable ? end : undefined}
        onPointerLeave={pressable ? end : undefined}
        onPointerCancel={pressable ? end : undefined}
        onBlur={pressable ? end : undefined}
        onKeyDown={pressable ? keyDown : undefined}
        onKeyUp={pressable ? keyUp : undefined}
      >
        {p.kind === 'latched' && <span className="kit-lamp" data-lit={p.on} aria-hidden="true" />}
        {p.icon !== undefined && <Icon id={p.icon} />}
        {form !== 'icon' && <span className="kit-button-label">{p.label}</span>}
        {lock && <LockGlyph label={t('locked')} />}
      </button>
      {reason !== null && <span className="kit-tip" id={tipId} role="tooltip">{reason}</span>}
    </span>
  )
}
