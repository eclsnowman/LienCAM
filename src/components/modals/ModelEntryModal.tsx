// INT-MODEL-UNIFY: model entry chooser; WO-2700: plain tab New Model dialog.
//
// The model-entry chooser is still raised by enterModelWorkspace (store/index.ts)
// when there is no already-active item AND 2+ Model Items
// exist -- the one case where "which item?" is genuinely ambiguous and must
// not be silently guessed (Operator navigation law: no-choice reply always
// available -- Cancel here leaves workspace/activeModelItemId untouched).
//
// Mirrors SketchEntryModal's shape (a focused, closable list-or-new picker)
// without its viewport-picking/layer-narrowing machinery -- a Model Item has
// no sub-layers, so "pick one, or start a new one" is the whole job. Reuses
// the Model Items tree row's own classes (tree-folder-row/-icon/-name) for
// the list and the sketch chooser's own list/title classes, so this modal
// introduces NO new CSS surface.

import { useText } from '../../i18n'
import { useEffect, useRef } from 'react'
import { X, Box, Plus } from 'lucide-react'
import { useCamStore } from '../../store'
import type { ImportedGeometry, ModelItemRecord } from '../../types'
import { isWrappableGeometryRow } from '../../lib/cam/modelOrigin'
import { useDialogFocus } from '../../hooks/useDialogFocus'

// Module-level stable reference -- `s.project.modelItems ?? []` INSIDE a
// zustand selector mints a NEW array every call when modelItems is
// undefined, which breaks getSnapshot's reference-equality contract and
// infinite-loops the subscription (this modal is always mounted, gated
// on `open` in its render body, so its selectors run on every store
// update even while closed). Same fix DesignTree.tsx avoids by never
// putting `?? []` inside a selector itself -- only in the render body.
const EMPTY_MODEL_ITEMS: ModelItemRecord[] = []
const EMPTY_GEOMETRY: ImportedGeometry[] = []

export function ModelEntryModal() {
  const workbenchText = useText('sketch-and-model-workbench')
  const activeModal = useCamStore((s) => s.activeModal)
  const closeModal = useCamStore((s) => s.closeModal)
  const modelItems = useCamStore((s) => s.project.modelItems ?? EMPTY_MODEL_ITEMS)
  const openModelItem = useCamStore((s) => s.openModelItem)
  const addModelItem = useCamStore((s) => s.addModelItem)
  const geometry = useCamStore((s) => s.project.geometry ?? EMPTY_GEOMETRY)
  const wrapImportedGeometryAsModelItem = useCamStore((s) => s.wrapImportedGeometryAsModelItem)
  const dialogFocusRef = useDialogFocus<HTMLDivElement>()

  // The plain tab's New Model window always offers Create Model AND the project's existing models (owner ruling 10-09:
  // it must at least offer New Model, never only that). The programmatic STL/help chooser keeps its own title.
  const newOnly = activeModal === 'new-model'
  const open = newOnly || activeModal === 'model-entry'

  // WO-2010: Escape does what the X / Cancel does, for this dialog only.
  const backdropRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      const own = backdropRef.current
      const all = document.querySelectorAll('.modal-backdrop')
      if (!own || all[all.length - 1] !== own) return
      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()
      closeModal()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, closeModal])

  if (!open) return null

  const handleOpen = (id: string) => {
    closeModal()
    openModelItem(id)
  }

  // Imported STEP/STL parts open the same way as the design tree's "Edit as model" button.
  const importedParts = geometry.filter((geo) => isWrappableGeometryRow(geo))
  const handleOpenImported = (id: string) => {
    closeModal()
    void wrapImportedGeometryAsModelItem(id)
  }

  const handleNew = () => {
    closeModal()
    addModelItem()
  }

  return (
    // CVU-2: REGIME 2 ownership marker (see DisclosureSection.tsx) -- MODAL-
    // GOVERNED scrim in the UI-70 census.
    <div className="modal-backdrop" data-ui78-sanctioned="" ref={backdropRef} onMouseDown={closeModal}>
      <div
        className="modal-container model-entry-modal"
        onMouseDown={(event) => event.stopPropagation()}
        ref={dialogFocusRef}
      >
        <div className="modal-header">
          <Box size={15} className="modal-header-icon" />
          <span className="modal-title">{newOnly ? workbenchText('ModelEntryModal.newModel') : workbenchText('ModelEntryModal.chooseAModelItem')}</span>
          <button className="modal-close-btn" onClick={closeModal}>
            <X size={14} />
          </button>
        </div>

        <div className="modal-body">
          <button
            className="op-type-card sketch-entry-new"
            data-testid="model-entry-new"
            onClick={handleNew}
          >
            <Plus size={18} />
            <span className="op-type-name">{newOnly ? workbenchText('ModelEntryModal.createModel') : workbenchText('ModelEntryModal.newModelItem')}</span>
          </button>

          {/* Same shape as the Sketch window: create on top, then every existing entry to open. */}
          <div className="sketch-entry-list-title">{workbenchText('ModelEntryModal.chooseExistingModel')}</div>
          {modelItems.length === 0 && importedParts.length === 0 ? (
            <div className="sketch-entry-empty" data-testid="model-entry-empty">
              {workbenchText('ModelEntryModal.emptyProject')}
            </div>
          ) : (
            <div className="sketch-entry-list" data-testid="model-entry-list">
              {modelItems.map((item) => (
                <button
                  key={item.id}
                  className="sketch-entry-row"
                  data-testid={`model-entry-row-${item.id}`}
                  onClick={() => handleOpen(item.id)}
                  data-tooltip={workbenchText('ModelEntryModal.open', { name: item.name })}
                >
                  <span className="sketch-entry-row-name">{item.name}</span>
                  <span className="sketch-entry-row-meta">{workbenchText('ModelEntryModal.model')}</span>
                </button>
              ))}
              {importedParts.map((geo) => (
                <button
                  key={geo.id}
                  className="sketch-entry-row"
                  data-testid={`model-entry-import-${geo.id}`}
                  onClick={() => handleOpenImported(geo.id)}
                  data-tooltip={workbenchText('ModelEntryModal.editImportedModel', { name: geo.name })}
                >
                  <span className="sketch-entry-row-name">{geo.name}</span>
                  <span className="sketch-entry-row-meta">{workbenchText('ModelEntryModal.importedModel', { format: geo.format === 'stl' ? 'STL' : 'STEP' })}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button className="modal-btn modal-btn-ghost" onClick={closeModal}>
            {workbenchText('ModelEntryModal.cancel')}</button>
        </div>
      </div>
    </div>
  )
}
