// A property palette docked at the side beside the tool rail (Form, Relief): a column of the Model screen's row, so
// the view narrows for it instead of being covered. Its header chevron folds it to a slim strip at the side, giving
// the view its whole width back to review the preview; the strip's chevron (or its name) brings it back. The fold is
// remembered per viewer. Header, a scrolling body, and a footer that stays put (Cancel / Finish).

import { useText } from '../../../i18n'
import { useState, type ReactNode } from 'react'
import { ChevronLeft, ChevronRight, X } from 'lucide-react'
import { readPref, writePref } from '../../common/useToolPaletteLayout'
import './dockedPanel.css'

export interface DockedPanelProps {
  /** remembers this panel's fold per viewer */
  id: string
  testId: string
  title: string
  icon: ReactNode
  width: number
  onClose(): void
  closeLabel: string
  closeTestId: string
  footer: ReactNode
  children: ReactNode
  /** extra class on the column (for the panel's own styles) */
  className?: string
}

export function DockedPanel({ id, testId, title, icon, width, onClose, closeLabel, closeTestId, footer, children, className }: DockedPanelProps) {
  const workbenchText = useText('sketch-and-model-workbench')
  const key = `liencam.${id}.dock-folded`
  const [folded, setFolded] = useState<boolean>(() => readPref(key) === true)
  const fold = (next: boolean) => { writePref(key, next); setFolded(next) }

  if (folded) {
    return (
      <aside className={`panel-right docked-panel is-folded${className ? ` ${className}` : ''}`} data-testid={testId} data-folded="true" aria-label={title}>
        <button
          type="button"
          className="docked-panel-unfold"
          data-testid={`${testId}-unfold`}
          aria-expanded={false}
          aria-label={workbenchText('DockedPanel.showThePanel', { title: String(title) })}
          data-tooltip={workbenchText('DockedPanel.showThePanel', { title: String(title) })}
          onClick={() => fold(false)}
        >
          <ChevronLeft size={14} />
          <span className="docked-panel-icon">{icon}</span>
          <span className="docked-panel-strip-title">{title}</span>
        </button>
      </aside>
    )
  }
  return (
    <aside className={`panel-right docked-panel${className ? ` ${className}` : ''}`} data-testid={testId} data-folded="false" aria-label={title} style={{ width, minWidth: width }}>
      <div className="panel-header">
        <span className="docked-panel-icon">{icon}</span>
        <span className="panel-title">{title}</span>
        <button
          type="button"
          className="modal-close-btn docked-panel-fold"
          data-testid={`${testId}-fold`}
          aria-expanded={true}
          aria-label={workbenchText('DockedPanel.foldThePanelToWidenTheView', { title: String(title) })}
          data-tooltip={workbenchText('DockedPanel.foldToTheSideTheViewGetsItsWhole')}
          onClick={() => fold(true)}
        >
          <ChevronRight size={14} />
        </button>
        <button type="button" className="modal-close-btn" aria-label={closeLabel} data-testid={closeTestId} onClick={onClose}>
          <X size={14} />
        </button>
      </div>
      <div className="docked-panel-body">{children}</div>
      <div className="docked-panel-footer">{footer}</div>
    </aside>
  )
}
