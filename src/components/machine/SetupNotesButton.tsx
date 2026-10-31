import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { NotebookPen, X } from 'lucide-react'
import { useCamStore } from '../../store'
import { useText } from '../../i18n'
import { ProgramInsightDetails } from './ProgramInsight'
import type { ProgramInsightFacts } from '../../lib/gcode/programInsight'
import type { Units } from '../../lib/ui/unitFormat'

/** The active setup's notes on Control: a button in the program row that opens a
 *  floating panel over the preview, like the Load menu and the pendant, so nothing
 *  on the screen moves. Readable at normal size, and editable right there.
 *  (WO-3079, owner release review 2026-10-23: "A setup notes button and modal, something that
 *  pops out and collapses like the pendant ... Where do you even add those setup
 *  notes, where do you edit them.") */
export function SetupNotesButton({ insight, estimatedMs, units }: {
  insight: ProgramInsightFacts | null
  estimatedMs: number | null
  units: Units
}) {
  const controlText = useText('control-screens-not-probing')
  const setup = useCamStore((s) => s.project.setups.find((candidate) => candidate.id === s.project.activeSetupId))
  const updateSetup = useCamStore((s) => s.updateSetup)
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<string | null>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [panelMaxHeight, setPanelMaxHeight] = useState<number | null>(null)
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

  // The common panel is a transient overlay over the program area, never over
  // the execution controls below it. The Control grid moves those controls at
  // smaller widths, so derive the available space from their live geometry
  // instead of guessing a viewport height. Locale/row wrapping and content
  // changes can move either boundary without a window resize. Observe their
  // layout ancestors as well as the panel, and remeasure on locale changes.
  // Standalone ProgramPanel consumers retain the normal CSS ceiling.
  useLayoutEffect(() => {
    if (!open) {
      setPanelMaxHeight(null)
      return
    }
    const measure = () => {
      const panel = panelRef.current
      const controls = [...document.querySelectorAll<HTMLElement>(
        '[data-testid="control-estop"], [data-testid="control-cyclestart"], [data-testid="control-feedhold"], [data-testid="control-stop-reset"]',
      )]
      if (!panel) return
      const visibleRects = controls.map((control) => control.getBoundingClientRect())
        .filter((rect) => rect.width > 0 && rect.height > 0)
      if (visibleRects.length === 0) {
        setPanelMaxHeight(null)
        return
      }
      const firstControlTop = Math.min(...visibleRects.map((rect) => rect.top))
      const available = Math.floor(firstControlTop - panel.getBoundingClientRect().top - 8)
      setPanelMaxHeight((current) => current === available ? current : available)
    }
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    const boundaries = [hostRef.current, panelRef.current, ...document.querySelectorAll<HTMLElement>(
      '[data-testid="control-estop"], [data-testid="control-cyclestart"], [data-testid="control-feedhold"], [data-testid="control-stop-reset"]',
    )]
    const observed = new Set<Element>()
    for (const boundary of boundaries) {
      for (let element: Element | null = boundary; element; element = element.parentElement) {
        if (!observed.has(element)) { observer?.observe(element); observed.add(element) }
      }
    }
    measure()
    const frame = requestAnimationFrame(measure)
    window.addEventListener('resize', measure)
    return () => {
      cancelAnimationFrame(frame)
      observer?.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [open, controlText])

  if (!setup && !insight) return null
  const editing = draft !== null
  const save = () => {
    if (setup && draft !== null && draft !== notes) updateSetup(setup.id, { notes: draft })
    setDraft(null)
  }
  const buttonLabel = controlText('ProgramPanel.setupNotesInsightButton')
  const panelLabel = setup && insight
    ? controlText('ProgramPanel.setupNotesInsightTitle', { value1: setup.name })
    : setup ? controlText('ProgramPanel.setupNotesTitle', { value1: setup.name }) : controlText('ProgramInsight.title')

  return (
    <div className="control-load-menu-anchor control-setup-notes-anchor" ref={hostRef}>
      <button
        className={`modal-btn modal-btn-ghost control-load-menu-btn ${open ? 'control-chip-active' : ''}`}
        type="button"
        data-testid="control-setup-notes-button"
        aria-label={buttonLabel}
        title={buttonLabel}
        style={{ paddingInline: 8, minWidth: 0 }}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <NotebookPen size={13} aria-hidden="true" />
        {setup && hasNotes && <span className="control-setup-notes-dot" data-testid="control-setup-notes-dot" aria-hidden="true" />}
      </button>
      {open && (
        <div className="control-setup-notes-panel" role="dialog" data-testid="control-setup-notes"
          aria-label={panelLabel}
          ref={panelRef}
          // Each row keeps its natural height; this outer panel is the scroll
          // owner. Flex shrinking previously hid notes while leaving their dot.
          style={{ display: 'grid', gridAutoRows: 'max-content', alignContent: 'start', overflowY: 'auto',
            ...(panelMaxHeight === null ? {} : { maxHeight: `${Math.max(0, panelMaxHeight)}px` }) }}>
          <div className="control-setup-notes-head">
            <span>{panelLabel}</span>
            <button className="pendant-popover-close" type="button" aria-label={controlText('ProgramPanel.setupNotesClose')}
              onClick={() => setOpen(false)}>
              <X size={14} />
            </button>
          </div>
          {setup && editing ? (
            <textarea
              className="control-setup-notes-edit"
              data-testid="control-setup-notes-edit"
              value={draft}
              rows={8}
              autoFocus
              onChange={(event) => setDraft(event.currentTarget.value)}
            />
          ) : setup && hasNotes ? (
            <div className="control-setup-notes-text" data-testid="control-setup-notes-text" style={{ overflow: 'visible' }}>{notes}</div>
          ) : setup ? (
            <div className="control-setup-notes-empty">{controlText('ProgramPanel.setupNotesEmpty')}</div>
          ) : null}
          {setup && <div className="control-setup-notes-actions">
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
          </div>}
          {insight && <section data-testid="program-insight" style={{ borderTop: setup ? '1px solid var(--border-subtle)' : undefined, paddingTop: setup ? 8 : undefined }}>
            <div style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)', marginBottom: 6 }}>{controlText('ProgramInsight.title')}</div>
            <ProgramInsightDetails facts={insight} estimatedMs={estimatedMs} units={units} />
          </section>}
        </div>
      )}
    </div>
  )
}
