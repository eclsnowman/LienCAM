// IMPORT-MULTIBODY-CHOICE (Operator Q-76): when an imported STEP file carries more
// than one body, the USER decides how it lands in the Geometry list -- keep the
// whole file as one multi-body item, or split each body into its own item. Operator
// ruled the software should not impose one behaviour: "how it should work may
// depend upon the users needs not the software's expectations."
//
// Driven entirely by the store's promise-based
// requestMultiBodyImportChoice/resolveMultiBodyImportChoice (the same shape the
// themed ConfirmModal uses): the importer does
// `const mode = await requestMultiBodyImportChoice(...)` and this component
// renders the themed dialog while that promise is pending, resolving it with the
// chosen mode.
//
// It reuses the SAME modal shell classes (.modal-backdrop / .modal-container /
// .modal-header / .modal-body / .modal-footer) every other app modal uses, so it
// is COHESIVE by construction and MODAL-GOVERNED in the overlay census
// (COHESION-STANDARD.md section 5 governs modality).
//
// Least surprise: dismissing (backdrop / X / Escape) chooses the pre-selected
// currentMode -- 'combined' at import (the historical default), or the row's
// stored prior pick when the decision is re-opened. Mounted once at the App root;
// renders nothing when no choice is pending.
import { useEffect } from 'react'
import { Boxes, Layers, X } from 'lucide-react'
import { useCamStore } from '../../store'
import { useDialogFocus } from '../../hooks/useDialogFocus'

export function MultiBodyImportModal() {
  const choice = useCamStore((s) => s.multiBodyImportChoice)
  const resolve = useCamStore((s) => s.resolveMultiBodyImportChoice)
  const dialogFocusRef = useDialogFocus<HTMLDivElement>()

  // Keyboard: Escape (and Enter) commit the pre-selected default, matching the
  // backdrop/X dismiss -- no dangling promise, no surprise change of behaviour.
  const currentMode = choice?.currentMode
  useEffect(() => {
    if (!choice) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'Enter') {
        e.preventDefault()
        resolve(currentMode ?? 'combined')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [choice, currentMode, resolve])

  if (!choice) return null
  const { name, bodyCount } = choice
  const defaultIsCombined = currentMode !== 'individual'

  return (
    // MODAL-GOVERNED scrim (UI-70 census). Backdrop dismiss = the default option.
    <div
      className="modal-backdrop"
      data-testid="multibody-import-backdrop"
      data-ui78-sanctioned=""
      onMouseDown={() => resolve(currentMode ?? 'combined')}
    >
      <div
        className="modal-container multibody-import-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Choose how the imported bodies land"
        data-testid="multibody-import-dialog"
        style={{ maxWidth: 460, minWidth: 340 }}
        onMouseDown={(e) => e.stopPropagation()}
        ref={dialogFocusRef}
      >
        <div className="modal-header">
          <Boxes size={15} className="modal-header-icon" />
          <span className="modal-title">This file has {bodyCount} separate bodies</span>
          <button
            className="modal-close-btn"
            onClick={() => resolve(currentMode ?? 'combined')}
            aria-label="Keep the default"
          >
            <X size={14} />
          </button>
        </div>

        <div
          className="modal-body"
          data-testid="multibody-import-body"
          style={{ color: 'var(--text-secondary)', lineHeight: 1.5 }}
        >
          <p style={{ margin: '0 0 12px' }}>
            &ldquo;{name}&rdquo; contains {bodyCount} bodies. How would you like them in the
            geometry list? You can change this later.
          </p>

          <div className="multibody-import-options">
            <button
              type="button"
              className="multibody-import-option"
              data-default={defaultIsCombined || undefined}
              data-testid="multibody-choice-combined"
              onClick={() => resolve('combined')}
            >
              <Boxes size={18} className="multibody-import-option-icon" />
              <span>
                <span className="multibody-import-option-title">
                  Keep as one item{defaultIsCombined ? ' (default)' : ''}
                </span>
                <span className="multibody-import-option-desc">
                  All {bodyCount} bodies stay together as a single row.
                </span>
              </span>
            </button>

            <button
              type="button"
              className="multibody-import-option"
              data-default={!defaultIsCombined || undefined}
              data-testid="multibody-choice-individual"
              onClick={() => resolve('individual')}
            >
              <Layers size={18} className="multibody-import-option-icon" />
              <span>
                <span className="multibody-import-option-title">
                  One item per body{!defaultIsCombined ? ' (default)' : ''}
                </span>
              </span>
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
