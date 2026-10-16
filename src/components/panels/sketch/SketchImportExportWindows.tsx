import { useText } from '../../../i18n'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { useDialogFocus } from '../../../hooks/useDialogFocus'
import './sketchImportExport.css'

/** The shared row owns values and actions for both sketch hosts. This shell
 * only moves their controls into ordinary, focus-trapped centred modals. */
export function SketchImportExportWindows({ window, onClose, importControls, exportControls }: {
  window: 'import' | 'export' | null
  onClose(): void
  importControls: ReactNode
  exportControls: ReactNode
}) {
  const workbenchText = useText('sketch-and-model-workbench')
  const dialogFocusRef = useDialogFocus<HTMLDivElement>()
  if (!window) return null
  const title = window === 'import' ? workbenchText('SketchImportExportWindows.importIntoSketch') : workbenchText('SketchImportExportWindows.exportPrintSketch')
  // Portal out of the scrolling toolbox/rail so the scrim covers the viewport.
  return createPortal(
    <div className="modal-backdrop" data-ui78-sanctioned=""
      onMouseDown={onClose}
      onKeyDown={(event) => {
        // SketchInteraction handles Escape before its typing guard. Keep all
        // dialog keys inside the modal so they cannot arm/cancel sketch tools.
        event.stopPropagation()
        if (event.key === 'Escape') { event.preventDefault(); onClose() }
      }}>
      <div className="modal-container sketch-import-export-window"
        role="dialog" aria-modal="true" aria-label={title}
        ref={dialogFocusRef} onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">{title}</span>
          <button type="button" className="modal-close-btn" aria-label={workbenchText('SketchImportExportWindows.close')} onClick={onClose}><X size={14} /></button>
        </div>
        <div className="modal-body sketch-import-export-controls">
          {window === 'import' ? importControls : exportControls}
        </div>
      </div>
    </div>, document.body,
  )
}
