import { useEffect, useRef, useState } from 'react'
import { Download, X } from 'lucide-react'
import { useCamStore } from '../../store'
import { useDialogFocus } from '../../hooks/useDialogFocus'
import { ThemedListbox } from '../ui/ThemedListbox'
import { collectExportGroups, useExportCenter, EXPORT_MODAL_ID, type ExportRow } from '../../lib/exportCenter'
import './ExportModal.css'

// WO-2448: the ONE Export window (Operator 2026-10-02: "keep our UI clean"). It
// lists only what this project has - no disabled rows, no helper text - and
// every Save routes to the writer that already exists for that kind.
export function ExportModal() {
  const isOpen = useCamStore((s) => s.activeModal === EXPORT_MODAL_ID)
  const closeModal = useCamStore((s) => s.closeModal)
  // Re-collect when the project or the live stock changes while the window is open.
  useCamStore((s) => s.project)
  useExportCenter((s) => s.simulationStock)
  const pickedRowId = useExportCenter((s) => s.pickedRowId)
  const [formats, setFormats] = useState<Record<string, string>>({})
  const pickedRef = useRef<HTMLButtonElement | null>(null)
  const dialogFocusRef = useDialogFocus<HTMLDivElement>()

  useEffect(() => {
    if (!isOpen) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      event.stopImmediatePropagation()
      closeModal()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isOpen, closeModal])

  useEffect(() => {
    if (!isOpen || !pickedRef.current) return
    pickedRef.current.scrollIntoView?.({ block: 'nearest' })
    pickedRef.current.focus()
  }, [isOpen, pickedRowId])

  if (!isOpen) return null
  const groups = collectExportGroups()

  const save = async (row: ExportRow, format: string) => {
    try {
      await row.save(format)
    } catch (error) {
      useCamStore.getState().addConsoleEvent({
        severity: 'warning', source: 'export',
        message: `Could not save ${row.name}: ${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }

  return (
    <div className="modal-backdrop" data-ui78-sanctioned=""
      onMouseDown={(e) => { if (e.target === e.currentTarget) closeModal() }}>
      <div className="modal-container export-modal" role="dialog" aria-modal="true" aria-labelledby="export-title"
        data-testid="export-modal" ref={dialogFocusRef}>
        <div className="modal-header">
          <Download size={14} className="modal-header-icon" />
          <span className="modal-title" id="export-title">Export</span>
          <button type="button" className="modal-close-btn" aria-label="Close" onClick={closeModal}><X size={14} /></button>
        </div>
        <div className="modal-body">
          {groups.map((group) => (
            <section key={group.id} data-testid={`export-group-${group.id}`} aria-label={group.label}>
              <div className="mform-section-header">{group.label}</div>
              {group.rows.map((row) => {
                const format = formats[row.id] ?? row.formats[0].id
                const picked = row.id === pickedRowId
                return (
                  <div key={row.id} className={`mform-row export-row${picked ? ' export-row-picked' : ''}`}
                    data-testid={`export-row-${row.id}`} aria-current={picked || undefined}>
                    <span className="mform-label export-row-name" title={row.name}>{row.name}</span>
                    {row.formats.length > 1
                      ? <ThemedListbox className="export-row-format" value={format} ariaLabel={`${row.name} format`}
                          testId={`export-format-${row.id}`} options={row.formats.map((f) => ({ value: f.id, label: f.label }))}
                          onChange={(value) => setFormats((current) => ({ ...current, [row.id]: value }))} />
                      : <span className="export-row-format" />}
                    <button type="button" className="modal-btn modal-btn-ghost" data-testid={`export-save-${row.id}`}
                      ref={picked ? pickedRef : undefined} onClick={() => { void save(row, format) }}>Save</button>
                  </div>
                )
              })}
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}
