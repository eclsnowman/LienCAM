// WO-3257: Settings -> Keyboard shortcuts. One row per remappable CAM action: a key box that
// records the next letter (with Shift if held), Apply, Clear, Restore, and Restore all.
// Nothing executes while a key box has focus (Settings is a modal, which the shortcut guard
// already refuses), and Enter / Escape inside a key box never close Settings.

import { useState, type KeyboardEvent } from 'react'
import { useUiPrefs } from '../../store/uiPrefs'
import {
  CAM_SHORTCUT_IDS,
  DEFAULT_CAM_BINDINGS,
  camBindingLabel,
  chordFromKeyEvent,
  type CamShortcutBinding,
  type CamShortcutId,
} from '../../lib/shortcuts/camShortcutRegistry'
import { useCamShortcuts } from './CamShortcutMap'

export function CamShortcutSettings() {
  const { t, effective, actionName } = useCamShortcuts()
  const setBinding = useUiPrefs((s) => s.setCamShortcutBinding)
  const restoreAll = useUiPrefs((s) => s.restoreCamShortcutDefaults)
  const [drafts, setDrafts] = useState<Partial<Record<CamShortcutId, CamShortcutBinding>>>({})
  const [conflicts, setConflicts] = useState<Partial<Record<CamShortcutId, string>>>({})

  const forget = (id: CamShortcutId): void => {
    setDrafts((d) => { const { [id]: _gone, ...rest } = d; return rest })
    setConflicts((c) => { const { [id]: _gone, ...rest } = c; return rest })
  }

  const apply = (id: CamShortcutId): void => {
    const draft = drafts[id]
    if (draft === undefined) return
    const edit = setBinding(id, draft)
    if (edit.ok) { forget(id); return }
    setConflicts((c) => ({
      ...c,
      [id]: t('conflict', { key: camBindingLabel(draft) ?? '', action: actionName(edit.conflictWith) }),
    }))
  }

  const change = (id: CamShortcutId, to: CamShortcutBinding | null | 'default'): void => {
    const edit = setBinding(id, to)
    if (edit.ok) { forget(id); return }
    // Restoring into a key another row now uses: same refusal, same wording.
    setDrafts((d) => { const { [id]: _gone, ...rest } = d; return rest })
    setConflicts((c) => ({
      ...c,
      [id]: t('conflict', { key: camBindingLabel(DEFAULT_CAM_BINDINGS[id]) ?? '', action: actionName(edit.conflictWith) }),
    }))
  }

  const onKeyDown = (id: CamShortcutId, event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation()
      forget(id)
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault(); event.stopPropagation()
      apply(id)
      return
    }
    const chord = chordFromKeyEvent(event.nativeEvent)
    if (chord === null) return
    event.preventDefault(); event.stopPropagation()
    setDrafts((d) => ({ ...d, [id]: chord }))
    setConflicts((c) => { const { [id]: _gone, ...rest } = c; return rest })
  }

  return (
    <div data-testid="settings-cam-shortcuts">
      <div className="mform-section-header">{t('section')}</div>
      <div className="mform-hint">{t('hint')}</div>
      {CAM_SHORTCUT_IDS.map((id) => {
        const shown = drafts[id] ?? effective[id]
        return (
          <div key={id} data-testid={`cam-shortcut-row-${id}`}>
            <div className="mform-row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <label className="mform-label" style={{ minWidth: '13rem' }}>{actionName(id)}</label>
              <button
                type="button"
                className="modal-btn modal-btn-ghost"
                data-testid={`cam-shortcut-input-${id}`}
                aria-label={t('keyBoxLabel', { action: actionName(id) })}
                style={{ minWidth: '6rem' }}
                onKeyDown={(event) => onKeyDown(id, event)}
              >
                {camBindingLabel(shown) ?? t('unassigned')}
              </button>
              <button type="button" className="modal-btn modal-btn-ghost" data-testid={`cam-shortcut-apply-${id}`} onClick={() => apply(id)}>{t('apply')}</button>
              <button type="button" className="modal-btn modal-btn-ghost" data-testid={`cam-shortcut-clear-${id}`} onClick={() => change(id, null)}>{t('clear')}</button>
              <button type="button" className="modal-btn modal-btn-ghost" data-testid={`cam-shortcut-restore-${id}`} onClick={() => change(id, 'default')}>{t('restore')}</button>
            </div>
            {conflicts[id] !== undefined && (
              <div className="mform-hint" role="alert" data-testid={`cam-shortcut-conflict-${id}`}>{conflicts[id]}</div>
            )}
          </div>
        )
      })}
      <div className="mform-row">
        <button type="button" className="modal-btn modal-btn-ghost" data-testid="cam-shortcut-restore-all" onClick={() => { restoreAll(); setDrafts({}); setConflicts({}) }}>{t('restoreAll')}</button>
      </div>
    </div>
  )
}
