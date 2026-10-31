// WO-3257: the CAM shortcut map in force - shown in Help -> Keyboard shortcuts, written to a
// printable text file, and read by the tooltip hints. All of it reads the same registry and the
// same stored overrides as the key handler, so none of it can drift from what the keys do.

import { useMemo } from 'react'
import { useText } from '../../i18n'
import { useUiPrefs } from '../../store/uiPrefs'
import {
  CAM_SHORTCUT_IDS,
  camBindingLabel,
  camShortcutMapText,
  effectiveCamBindings,
  type CamShortcutId,
} from '../../lib/shortcuts/camShortcutRegistry'

type CamShortcutText = ReturnType<typeof useText<'cam-shortcuts.wo3257'>>

const ACTION_TEXT_KEY = {
  computeOperationToolpath: 'actionSelected',
  computeAllToolpaths: 'actionAll',
  'openModal:new-operation': 'actionNewOperation',
} as const satisfies Record<CamShortcutId, 'actionSelected' | 'actionAll' | 'actionNewOperation'>

/** The effective bindings and the translated action names, re-read when either changes. */
export function useCamShortcuts() {
  const t = useText('cam-shortcuts.wo3257')
  const raw = useUiPrefs((s) => s.camShortcutOverrides)
  const effective = useMemo(() => effectiveCamBindings(raw), [raw])
  const actionName = (id: CamShortcutId): string => t(ACTION_TEXT_KEY[id])
  return { t, raw, effective, actionName }
}

/** The tooltip hints for the places that name a shortcut. A row with no key reads without one. */
export function useCamShortcutHints() {
  const { t, effective } = useCamShortcuts()
  const selected = camBindingLabel(effective.computeOperationToolpath)
  const all = camBindingLabel(effective.computeAllToolpaths)
  const newOperation = camBindingLabel(effective['openModal:new-operation'])
  return {
    computeToolpath: selected === null ? t('computeToolpathNone') : t('computeToolpath', { key: selected }),
    computeRegenerate: selected === null ? t('computeRegenerateNone') : t('computeRegenerate', { key: selected }),
    regenerateAll: all === null ? t('regenerateAllNone') : t('regenerateAll', { key: all }),
    addOperation: newOperation === null ? t('addOperationNone') : t('addOperation', { key: newOperation }),
  }
}

function mapText(t: CamShortcutText, raw: unknown): string {
  return camShortcutMapText(raw, {
    title: t('mapTitle'),
    scope: t('mapScopeText'),
    unassigned: t('unassigned'),
    actions: {
      computeOperationToolpath: t('actionSelected'),
      computeAllToolpaths: t('actionAll'),
      'openModal:new-operation': t('actionNewOperation'),
    },
  })
}

export function CamShortcutMap() {
  const { t, raw, effective, actionName } = useCamShortcuts()

  const download = (): void => {
    const url = URL.createObjectURL(new Blob([mapText(t, raw)], { type: 'text/plain;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = t('downloadName')
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }

  return (
    <div className="help-section" data-testid="cam-shortcut-map" style={{ marginTop: 16 }}>
      <h3 className="help-section-heading">{t('mapHeading')}</h3>
      <p className="help-section-text">{t('mapScope')}</p>
      <ul className="help-list">
        {CAM_SHORTCUT_IDS.map((id) => (
          <li key={id} data-testid={`cam-shortcut-map-row-${id}`}>
            <span>{actionName(id)}</span>{' '}
            <kbd>{camBindingLabel(effective[id]) ?? t('unassigned')}</kbd>
          </li>
        ))}
      </ul>
      <button type="button" className="modal-btn modal-btn-ghost" data-testid="cam-shortcut-map-download" onClick={download}>
        {t('download')}
      </button>
    </div>
  )
}
