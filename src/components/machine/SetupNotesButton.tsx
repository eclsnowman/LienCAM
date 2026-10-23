import { useEffect, useRef, useState } from 'react'
import { NotebookPen, X } from 'lucide-react'
import { useCamStore } from '../../store'
import { textFor } from '../../i18n'

const controlText = textFor('control-screens-not-probing')

/** The active setup's notes on Control: a button in the program row that opens a
 *  floating panel over the preview, like the Load menu and the pendant, so nothing
 *  on the screen moves. Readable at normal size, and editable right there.
 *  (WO-3079, owner release review 2026-10-23: "A setup notes button and modal, something that
 *  pops out and collapses like the pendant ... Where do you even add those setup
 *  notes, where do you edit them.") */
export function SetupNotesButton() {
  const setup = useCamStore((s) => s.project.setups.find((candidate) => candidate.id === s.project.activeSetupId))
  const updateSetup = useCamStore((s) => s.updateSetup)
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<string | null>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const notes = setup?.notes ?? ''
  const hasNotes = notes.trim() !== ''

  // Switching setups shows that setup's notes and drops an unsaved edit of the old one.
  useEffect(() => { setDraft(null) }, [setup?.id])

  // Escape or a press outside closes it, like the Load menu. An unsaved edit is kept
  // in the box until Cancel, so a stray click does not lose typing.
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    const onPress = (event: MouseEvent) => {
      const host = hostRef.current
      if (host && event.target instanceof Node && !host.contains(event.target)) setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onPress)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onPress)
    }
  }, [open])

  if (!setup) return null
  const editing = draft !== null
  const save = () => {
    if (draft !== null && draft !== notes) updateSetup(setup.id, { notes: draft })
    setDraft(null)
  }

  return (
    <div className="control-load-menu-anchor control-setup-notes-anchor" ref={hostRef}>
      <button
        className={`modal-btn modal-btn-ghost control-load-menu-btn ${open ? 'control-chip-active' : ''}`}
        type="button"
        data-testid="control-setup-notes-button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <NotebookPen size={13} aria-hidden="true" />
        {controlText('ProgramPanel.setupNotesButton')}
        {hasNotes && <span className="control-setup-notes-dot" data-testid="control-setup-notes-dot" aria-hidden="true" />}
      </button>
      {open && (
        <div className="control-setup-notes-panel" role="dialog" data-testid="control-setup-notes"
          aria-label={controlText('ProgramPanel.setupNotesTitle', { value1: setup.name })}>
          <div className="control-setup-notes-head">
            <span>{controlText('ProgramPanel.setupNotesTitle', { value1: setup.name })}</span>
            <button className="pendant-popover-close" type="button" aria-label={controlText('ProgramPanel.setupNotesClose')}
              onClick={() => setOpen(false)}>
              <X size={14} />
            </button>
          </div>
          {editing ? (
            <textarea
              className="control-setup-notes-edit"
              data-testid="control-setup-notes-edit"
              value={draft}
              rows={8}
              autoFocus
              onChange={(event) => setDraft(event.currentTarget.value)}
            />
          ) : hasNotes ? (
            <div className="control-setup-notes-text" data-testid="control-setup-notes-text">{notes}</div>
          ) : (
            <div className="control-setup-notes-empty">{controlText('ProgramPanel.setupNotesEmpty')}</div>
          )}
          <div className="control-setup-notes-actions">
            {editing ? (
              <>
                <button className="modal-btn modal-btn-ghost" type="button" onClick={() => setDraft(null)}>
                  {controlText('ProgramPanel.setupNotesCancel')}
                </button>
                <button className="modal-btn modal-btn-primary" type="button" data-testid="control-setup-notes-save" onClick={save}>
                  {controlText('ProgramPanel.setupNotesSave')}
                </button>
              </>
            ) : (
              <button className="modal-btn modal-btn-ghost" type="button" data-testid="control-setup-notes-edit-button"
                onClick={() => setDraft(notes)}>
                {hasNotes ? controlText('ProgramPanel.setupNotesEdit') : controlText('ProgramPanel.setupNotesAdd')}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
