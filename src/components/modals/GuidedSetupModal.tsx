import { ListChecks, X } from 'lucide-react'
import { useCamStore } from '../../store'
import { useDialogFocus } from '../../hooks/useDialogFocus'
import { useText } from '../../i18n'
import type { Units } from '../../types'

/**
 * The guide is one more `activeModal` ('guided-setup'), so every rule that
 * already keeps the app quiet behind a modal (CAM shortcuts, a second editor
 * replacing the first, the workspace-switch close) applies to it unchanged.
 * It is ephemeral: never saved, never in uiPrefs.
 */
export const GUIDED_SETUP_MODAL = 'guided-setup'
const show = () => useCamStore.getState().openModal(GUIDED_SETUP_MODAL)
const hide = () => { if (useCamStore.getState().activeModal === GUIDED_SETUP_MODAL) useCamStore.getState().closeModal() }
const OPEN = { open: true, show, hide }
const CLOSED = { open: false, show, hide }
const view = (activeModal: string | null) => activeModal === GUIDED_SETUP_MODAL ? OPEN : CLOSED
export const useGuidedSetup = Object.assign(
  <T,>(select: (state: typeof OPEN) => T): T => useCamStore((s) => select(view(s.activeModal))),
  { getState: () => view(useCamStore.getState().activeModal) },
)

/** The existing editors the guide hands over to (the `activeModal` ids). */
export type GuidedSetupChild = 'settings' | 'machine-config' | 'tool-library'

/**
 * The optional first-time guide: Units, Machine, Tools with live facts. It
 * creates, selects, imports and changes nothing itself; each action opens the
 * editor that already owns that job.
 */
export function GuidedSetupModal({ onOpenChild, onLeave }: {
  onOpenChild: (child: GuidedSetupChild) => void
  onLeave?: () => void
}) {
  const t = useText('guided-setup.wo3256')
  const open = useGuidedSetup((s) => s.open)
  const hide = useGuidedSetup((s) => s.hide)
  const displayUnits = useCamStore((s) => s.appSettings.displayUnits)
  const exportUnits = useCamStore((s) => s.appSettings.exportUnits)
  const machineName = useCamStore((s) => s.project.machine?.name)
  const toolCount = useCamStore((s) => s.toolLibrary.length)
  const confirmPending = useCamStore((s) => s.confirmDialog !== null)
  const focusRef = useDialogFocus<HTMLDivElement>()
  if (!open) return null
  const unitName = (units: Units) => units === 'inch' ? t('unitIn') : t('unitMm')
  const leave = () => { hide(); onLeave?.() }
  const rows: { child: GuidedSetupChild; title: string; summary: string; note?: string; action: string }[] = [
    { child: 'settings', title: t('unitsTitle'), summary: t('unitsSummary', { display: unitName(displayUnits), export: unitName(exportUnits) }),
      note: t('unitsNote'), action: t('unitsOpen') },
    { child: 'machine-config', title: t('machineTitle'),
      summary: machineName ? t('machineSummary', { name: machineName }) : t('machineNone'), action: t('machineOpen') },
    { child: 'tool-library', title: t('toolsTitle'), summary: t('toolsSummary', { count: toolCount }), action: t('toolsOpen') },
  ]
  return <div className="modal-backdrop" data-ui78-sanctioned="" inert={confirmPending || undefined}>
    <div className="modal-container guided-setup" role="dialog" aria-modal="true" aria-labelledby="guided-setup-title"
      style={{ width: 'min(36rem, calc(100vw - 2rem))' }} ref={focusRef}
      onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); leave() } }}>
      <div className="modal-header">
        <ListChecks size={14} className="modal-header-icon" />
        <span className="modal-title" id="guided-setup-title">{t('title')}</span>
        <button className="modal-close-btn" aria-label={t('close')} onClick={leave}><X size={14} /></button>
      </div>
      <div className="modal-body">
        <p className="mform-hint">{t('intro')}</p>
        <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {rows.map((row, index) => <li key={row.child} data-testid={`guided-setup-${row.child}`} className="mform-row"
            style={{ alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <span>
              <strong>{index + 1}. {row.title}</strong><br />
              <span>{row.summary}</span>
              {row.note && <><br /><small className="mform-hint">{row.note}</small></>}
            </span>
            <button className="modal-btn modal-btn-ghost" onClick={() => onOpenChild(row.child)}>{row.action}</button>
          </li>)}
        </ol>
        <p className="mform-hint">{t('savedNote')}</p>
      </div>
      <div className="modal-footer">
        <button className="modal-btn modal-btn-ghost" onClick={leave}>{t('skip')}</button>
        <button className="modal-btn modal-btn-primary" onClick={leave}>{t('continue')}</button>
      </div>
    </div>
  </div>
}
