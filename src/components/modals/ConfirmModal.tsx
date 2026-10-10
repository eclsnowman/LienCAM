import { textFor, useText } from '../../i18n'
// PROMOTE-SKETCH-FAIL round 2: the app's ONE themed confirm dialog, the
// on-brand replacement for native window.confirm() (Operator flagged the native
// "localhost:5173 says..." bubble as off-theme). Driven entirely by the store's
// promise-based requestConfirm/resolveConfirm: a caller does
// `if (await requestConfirm({ title, body, confirmLabel })) { ... }` and this
// component renders the themed dialog while that promise is pending.
//
// It reuses the SAME modal shell classes (.modal-backdrop / .modal-container /
// .modal-header / .modal-body) every other app modal uses, so it is COHESIVE by
// construction and MODAL-GOVERNED in the overlay census (COHESION-STANDARD.md
// section 5 governs modality, one disposition keyed by this authoring site).
//
// Mounted once at the App root. Renders nothing when no confirm is pending.
import { useEffect } from 'react'
import { AlertTriangle, HelpCircle, X } from 'lucide-react'
import { useCamStore } from '../../store'
import { useDialogFocus } from '../../hooks/useDialogFocus'

const shellText = textFor('app-shell-settings-menus')

export function ConfirmModal() {
  useText('app-shell-settings-menus')
  const confirmDialog = useCamStore((s) => s.confirmDialog)
  const resolveConfirm = useCamStore((s) => s.resolveConfirm)
  const resolveConfirmChoice = useCamStore((s) => s.resolveConfirmChoice)
  const dialogFocusRef = useDialogFocus<HTMLDivElement>()

  // Keyboard: Escape cancels, Enter confirms — the same affordances the native
  // dialog gave, kept for parity. Effect is a no-op while no confirm is pending.
  // Enter on a focused button is that button's own activation: Enter on a
  // focused Cancel must cancel, never approve (Codex audit BUG-485). The
  // dialog-wide Enter shortcut only applies when focus is on no control.
  useEffect(() => {
    if (!confirmDialog) return
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return
      if (e.key === 'Escape') { e.preventDefault(); resolveConfirm(false) }
      else if (e.key === 'Enter') {
        const target = e.target instanceof Element ? e.target : null
        if (target?.closest('button, a[href], input, select, textarea, [role="button"]')) return
        e.preventDefault(); resolveConfirm(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [confirmDialog, resolveConfirm])

  if (!confirmDialog) return null
  const { title, body, confirmLabel, cancelLabel, tone, altLabel } = confirmDialog
  const danger = tone === 'danger'

  return (
    // CVU-2: REGIME 2 ownership marker (see DisclosureSection.tsx) -- MODAL-
    // GOVERNED scrim in the UI-70 census.
    <div
      className="modal-backdrop"
      data-testid="confirm-dialog-backdrop"
      data-ui78-sanctioned=""
      onMouseDown={() => resolveConfirm(false)}
    >
      <div
        className="modal-container confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        data-testid="confirm-dialog"
        style={{ maxWidth: 440, minWidth: 320 }}
        onMouseDown={(e) => e.stopPropagation()}
        ref={dialogFocusRef}
      >
        <div className="modal-header">
          {danger
            ? <AlertTriangle size={15} className="modal-header-icon" style={{ color: 'var(--text-danger)' }} />
            : <HelpCircle size={15} className="modal-header-icon" />}
          <span className="modal-title">{title}</span>
          <button className="modal-close-btn" onClick={() => resolveConfirm(false)} aria-label={shellText('ConfirmModal.cancel')}>
            <X size={14} />
          </button>
        </div>

        {body && (
          <div className="modal-body" data-testid="confirm-dialog-body" style={{ color: 'var(--text-secondary)', lineHeight: 1.5 }}>
            {body}
          </div>
        )}

        <div
          className="modal-footer"
          style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '12px 16px' }}
        >
          {/* WO-2698: the optional third answer (requestConfirmChoice), e.g.
              Discard beside Save / Cancel. Two-button confirms never set it. */}
          {altLabel && (
            <button
              type="button"
              className="modal-btn modal-btn-ghost"
              data-testid="confirm-dialog-alt"
              style={{ marginRight: 'auto' }}
              onClick={() => resolveConfirmChoice('alt')}
            >
              {altLabel}
            </button>
          )}
          <button
            type="button"
            className="modal-btn modal-btn-ghost"
            data-testid="confirm-dialog-cancel"
            onClick={() => resolveConfirm(false)}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`modal-btn ${danger ? 'modal-btn-danger' : 'modal-btn-primary'}`}
            data-testid="confirm-dialog-confirm"
            autoFocus
            onClick={() => resolveConfirm(true)}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
