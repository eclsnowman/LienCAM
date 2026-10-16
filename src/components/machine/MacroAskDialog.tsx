import { textFor, useText } from '../../i18n'
const controlText = textFor('control-screens-not-probing')

// MacroAskDialog - WO-1715: the dialog a macro's confirm(), choose() or ask()
// opens, and the answer it hands back to the script.
//
// Operator ruling 2026-09-19: "does our system have the ability for a pop-up? Sometimes
// your program may have the desire for a decision tree, entry field,
// confirmation button, etc."
//
// The runtime (`lib/machine/macros/macroRuntime.ts`) owns the question and
// the wait; this only shows it and reports the answer. It reuses the shared
// modal shell (.modal-backdrop / .modal-container / .modal-header /
// .modal-body / .modal-footer) every app modal uses, so its backdrop is what
// `dialogOpen()` finds: the jog keys and the CYCLE START key stay gated while
// a macro waits on the operator, exactly as for any other dialog.
//
// It mounts itself, once, on the first question (`mountMacroAskDialog`), on
// its own root at the end of <body>: a macro bound to an M-code can ask from
// a running program on any screen, so no one panel can own it. Theme tokens
// live on <html>, so it wears the app's theme there.
//
// Cancel, the close X, Escape and a click on the backdrop all answer
// false (confirm) or null (choose / ask) - an answer the script decides what
// to do with. "Stop macro" is the Macros panel's own Stop (`stopUserMacro`),
// here because the backdrop covers that panel: the run ends, nothing more is
// sent, and this closes.

import { useEffect, useState, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { MessageCircleQuestion, X } from 'lucide-react'
import {
  activeMacroAsk,
  answerMacroAsk,
  stopUserMacro,
  subscribeMacroAsk,
  type MacroAskState,
} from '../../lib/machine/macros/macroRuntime'
import { useDialogFocus } from '../../hooks/useDialogFocus'

export function MacroAskDialog() {
  const ask = useSyncExternalStore(subscribeMacroAsk, activeMacroAsk, () => null)
  // Keyed by the question's id so a second question never inherits the first
  // one's typed text.
  return ask ? <MacroAskPanel key={ask.id} ask={ask} /> : null
}

function MacroAskPanel({ ask }: { ask: MacroAskState }) {
  useText('control-screens-not-probing')
  const { question } = ask
  const [typed, setTyped] = useState(question.kind === 'ask' ? question.defaultValue : '')
  const dialogFocusRef = useDialogFocus<HTMLDivElement>()
  const cancelAnswer = question.kind === 'confirm' ? false : null
  const cancel = () => answerMacroAsk(ask.id, cancelAnswer)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return
      if (e.key === 'Escape') {
        e.preventDefault()
        answerMacroAsk(ask.id, cancelAnswer)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [ask.id, cancelAnswer])

  const title = controlText('MacroAskDialog.text001', { value1: String(ask.macroName) })

  return (
    <div
      className="modal-backdrop"
      data-testid="macro-ask-backdrop"
      data-ui78-sanctioned=""
      onMouseDown={cancel}
    >
      <div
        className="modal-container confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        data-testid="macro-ask-dialog"
        data-kind={question.kind}
        style={{ maxWidth: 460, minWidth: 320 }}
        onMouseDown={(e) => e.stopPropagation()}
        ref={dialogFocusRef}
      >
        <div className="modal-header">
          <MessageCircleQuestion size={15} className="modal-header-icon" />
          <span className="modal-title">{title}</span>
          <button className="modal-close-btn" data-testid="macro-ask-close" onClick={cancel} aria-label={controlText('MacroAskDialog.text002')}>
            <X size={14} />
          </button>
        </div>

        <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 10, lineHeight: 1.5 }}>
          <div data-testid="macro-ask-text" style={{ whiteSpace: 'pre-wrap' }}>{question.text}</div>
          {question.kind === 'ask' && (
            <input
              className="mform-input"
              data-testid="macro-ask-input"
              aria-label={question.text}
              autoFocus
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  answerMacroAsk(ask.id, typed)
                }
              }}
            />
          )}
          {question.kind === 'choose' && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {question.options.map((option, i) => (
                <button
                  key={`${i}:${option}`}
                  type="button"
                  className="modal-btn modal-btn-primary"
                  data-testid={`macro-ask-option-${i}`}
                  autoFocus={i === 0}
                  onClick={() => answerMacroAsk(ask.id, option)}
                >
                  {option}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="modal-footer" style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '12px 16px' }}>
          <button
            type="button"
            className="modal-btn modal-btn-danger"
            data-testid="macro-ask-stop"
            data-tooltip={controlText('MacroAskDialog.text003', { value1: String(ask.macroName) })}
            style={{ marginRight: 'auto' }}
            onClick={() => stopUserMacro()}
          >{controlText('MacroAskDialog.text004')}</button>
          <button type="button" className="modal-btn modal-btn-ghost" data-testid="macro-ask-cancel" onClick={cancel}>{controlText('MacroAskDialog.text005')}</button>
          {question.kind === 'confirm' && (
            <button
              type="button"
              className="modal-btn modal-btn-primary"
              data-testid="macro-ask-ok"
              autoFocus
              onClick={() => answerMacroAsk(ask.id, true)}
            >{controlText('MacroAskDialog.text006')}</button>
          )}
          {question.kind === 'ask' && (
            <button
              type="button"
              className="modal-btn modal-btn-primary"
              data-testid="macro-ask-ok"
              onClick={() => answerMacroAsk(ask.id, typed)}
            >{controlText('MacroAskDialog.text007')}</button>
          )}
        </div>
      </div>
    </div>
  )
}

let host: HTMLElement | null = null

/** Mount the dialog once, on its own root at the end of <body>. Idempotent;
 *  a no-op with no document. */
export function mountMacroAskDialog(): void {
  if (typeof document === 'undefined') return
  if (host && host.isConnected) return
  host = document.createElement('div')
  host.setAttribute('data-macro-ask-root', '')
  document.body.appendChild(host)
  createRoot(host).render(<MacroAskDialog />)
}
