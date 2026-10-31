// WO-3279: the footer buttons Card, Dialog, Window and Confirm share (not exported from the kit barrel).
import { resolveMessage } from '../../../notices'
import type { CardAction, CardProps } from '../types'
import { useTooltip } from './tooltip'

export function ActionButton({ action, role, danger }: { action: CardAction; role: 'ghost' | 'cancel' | 'primary'; danger?: boolean }) {
  const a = action.availability
  const ready = a === undefined || a.ready
  // only an unavailable action has a tooltip (its reason); the button element is the same either
  // way, so focus survives availability flipping and a ready action stops no key
  const tooltip = useTooltip(ready ? '' : resolveMessage(a.reason, a.params))
  return (
    <>
      <button
        type="button"
        className={`kit-card-${role}`}
        data-danger={danger ? 'true' : undefined}
        data-unavailable={ready ? undefined : 'true'}
        data-lock={!ready && a.lock ? 'true' : undefined}
        aria-disabled={ready ? undefined : true}
        {...tooltip.props}
        onClick={() => { if (ready) action.onPress() }}
      >
        {action.label}
      </button>
      {tooltip.tip}
    </>
  )
}

export function Footer({ footer, danger }: { footer: CardProps['footer']; danger?: boolean }) {
  if (!footer) return null
  return (
    <footer className="kit-card-footer">
      {footer.ghost && <ActionButton action={footer.ghost} role="ghost" />}
      {footer.cancel && <ActionButton action={footer.cancel} role="cancel" />}
      {footer.primary && <ActionButton action={footer.primary} role="primary" danger={danger} />}
    </footer>
  )
}
