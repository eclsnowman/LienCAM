// IMPORT-STOCK-PROMPT: when a newly imported geometry item lands and the project
// has one or more ASSIGNABLE named stocks, the USER decides which stock the part
// joins -- a named stock (pinned, locked), the automatic catch-all (let the app
// route it by location, the historical default), or no stock at all (deliberate,
// sticky). Named stocks include BOTH explicit (user-defined fixed) stocks AND
// named derived (automatic) stocks; the lone catch-all derived stock is the
// 'Auto' option, never a named pick. When the ONLY stock is that lone catch-all
// (no explicit and no named derived stocks), it is the one obvious destination
// and NO prompt is shown (requestImportStockChoice returns null); the historical
// auto-assign behavior is preserved unchanged.
//
// Driven entirely by the store's promise-based
// requestImportStockChoice/resolveImportStockChoice (the same shape the themed
// ConfirmModal and MultiBodyImportModal use): the importer does
// `const choice = await requestImportStockChoice(...)` and this component renders
// the themed dialog while that promise is pending, resolving it with the chosen
// pick. The selection is persisted through the EXISTING stock-binding source of
// truth (setStockMembership / setGeometryNoStock) -- no new persistence path.
//
// Reuses the SAME modal shell classes (.modal-backdrop / .modal-container /
// .modal-header / .modal-body) every other app modal uses, so it is COHESIVE by
// construction and MODAL-GOVERNED in the overlay census (COHESION-STANDARD.md
// section 5 governs modality).
//
// Least surprise: dismissing (backdrop / X / Escape) chooses 'auto' -- the
// pre-selected historical default. Mounted once at the App root; renders nothing
// when no choice is pending.
import { useEffect } from 'react'
import { Boxes, BoxSelect, Ban, X } from 'lucide-react'
import { useCamStore } from '../../store'
import type { ImportStockSelection } from '../../store'
import { useDialogFocus } from '../../hooks/useDialogFocus'

export function ImportStockChoiceModal() {
  const choice = useCamStore((s) => s.importStockChoice)
  const resolve = useCamStore((s) => s.resolveImportStockChoice)
  const dialogFocusRef = useDialogFocus<HTMLDivElement>()

  // Keyboard: Escape (and Enter) commit the pre-selected default ('auto'),
  // matching the backdrop/X dismiss -- no dangling promise, no surprise change.
  useEffect(() => {
    if (!choice) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'Enter') {
        e.preventDefault()
        resolve({ kind: 'auto' })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [choice, resolve])

  if (!choice) return null
  const { name, stocks } = choice

  const pick = (selection: ImportStockSelection) => resolve(selection)

  return (
    // MODAL-GOVERNED scrim (UI-70 census). Backdrop dismiss = the 'auto' default.
    <div
      className="modal-backdrop"
      data-testid="import-stock-choice-backdrop"
      data-ui78-sanctioned=""
      onMouseDown={() => pick({ kind: 'auto' })}
    >
      <div
        className="modal-container import-stock-choice-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Choose which stock the imported part joins"
        data-testid="import-stock-choice-dialog"
        style={{ maxWidth: 480, minWidth: 340 }}
        onMouseDown={(e) => e.stopPropagation()}
        ref={dialogFocusRef}
      >
        <div className="modal-header">
          <BoxSelect size={15} className="modal-header-icon" />
          <span className="modal-title">Which stock should &ldquo;{name}&rdquo; join?</span>
          <button
            className="modal-close-btn"
            onClick={() => pick({ kind: 'auto' })}
            aria-label="Keep the default (auto)"
          >
            <X size={14} />
          </button>
        </div>

        <div
          className="modal-body"
          data-testid="import-stock-choice-body"
          style={{ color: 'var(--text-secondary)', lineHeight: 1.5 }}
        >
          <p style={{ margin: '0 0 12px' }}>
            Pick a stock for this new part. You can change this later from the Design Tree.
          </p>

          <div className="multibody-import-options">
            {stocks.map((stock) => (
              <button
                key={stock.id}
                type="button"
                className="multibody-import-option"
                data-testid={`import-stock-choice-stock-${stock.id}`}
                onClick={() => pick({ kind: 'stock', stockId: stock.id })}
              >
                <Boxes size={18} className="multibody-import-option-icon" />
                <span>
                  <span className="multibody-import-option-title">
                    {stock.name}
                  </span>
                  <span className="multibody-import-option-desc">
                    Pin this part to {stock.name}&rsquo;s coordinate frame.
                  </span>
                </span>
              </button>
            ))}

            <button
              type="button"
              className="multibody-import-option"
              data-default=""
              data-testid="import-stock-choice-auto"
              onClick={() => pick({ kind: 'auto' })}
            >
              <BoxSelect size={18} className="multibody-import-option-icon" />
              <span>
                <span className="multibody-import-option-title">
                  Auto (default)
                </span>
              </span>
            </button>

            <button
              type="button"
              className="multibody-import-option"
              data-testid="import-stock-choice-none"
              onClick={() => pick({ kind: 'none' })}
            >
              <Ban size={18} className="multibody-import-option-icon" />
              <span>
                <span className="multibody-import-option-title">
                  None
                </span>
              </span>
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
