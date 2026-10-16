import { catalogChildren } from './definition/catalogText'
import { textFor, useText } from '../../i18n'
const controlText = textFor('control-screens-not-probing')

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { ChevronRight, Copy, Link2, Link2Off, RefreshCw, Smartphone, X } from 'lucide-react'
import { useMachineControl } from '../../store/machineControlStore'
import { pendantBridge } from '../../lib/machine/pendantRuntime'
import { startPendantBroker, stopPendantBroker } from '../../lib/machine/pendantBrokerHost'
import { LocalQrCode } from '../common/LocalQrCode'

function newPairingToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(18))
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('')
}

export function PendantPanel() {
  useText('control-screens-not-probing')
  const snapshot = useSyncExternalStore(pendantBridge.subscribe, pendantBridge.snapshot, pendantBridge.snapshot)
  const machineConnected = useMachineControl((state) => state.connectionPhase === 'connected')
  const connectionKind = useMachineControl((state) => state.connectionKind)
  const [pairingToken, setPairingToken] = useState(newPairingToken)
  const [warningAccepted, setWarningAccepted] = useState(false)
  const [hostBusy, setHostBusy] = useState(false)
  const [hostError, setHostError] = useState<string | null>(null)
  const [popoverOpen, setPopoverOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [selectedLanIp, setSelectedLanIp] = useState('')
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const [popoverPosition, setPopoverPosition] = useState<{ left: number; top: number } | null>(null)
  const lanIp = snapshot.lanIps.includes(selectedLanIp) ? selectedLanIp : (snapshot.lanIps[0] ?? null)
  const pairingUrl = useMemo(() => {
    if (!lanIp || snapshot.phase !== 'connected') return null
    const brokerSocket = `ws://${lanIp}:${snapshot.brokerPort}/bridge`
    const query = new URLSearchParams({ pair: snapshot.pairingToken, broker: brokerSocket })
    return `http://${lanIp}:${snapshot.brokerPort}/?${query.toString()}`
  }, [lanIp, snapshot.brokerPort, snapshot.pairingToken, snapshot.phase])

  const rotatePairingCode = () => {
    setPairingToken(newPairingToken())
    setWarningAccepted(false)
  }

  const enableRemoteControl = async () => {
    setHostBusy(true)
    setHostError(null)
    try {
      const broker = await startPendantBroker()
      pendantBridge.enable(broker.brokerUrl, pairingToken)
    } catch (error) {
      setHostError(error instanceof Error ? error.message : String(error))
    } finally {
      setHostBusy(false)
    }
  }

  const disableRemoteControl = async () => {
    pendantBridge.disable()
    setHostBusy(true)
    setHostError(null)
    try {
      await stopPendantBroker()
    } catch (error) {
      setHostError(error instanceof Error ? error.message : String(error))
    } finally {
      setHostBusy(false)
    }
  }

  const copyPairingUrl = async () => {
    if (!pairingUrl) return
    await navigator.clipboard.writeText(pairingUrl)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }

  const positionPopover = useCallback(() => {
    const trigger = triggerRef.current
    if (!trigger) return
    const triggerRect = trigger.getBoundingClientRect()
    const width = Math.min(360, window.innerWidth - 16)
    const measuredHeight = popoverRef.current?.getBoundingClientRect().height ?? 520
    const maxHeight = window.innerHeight - 16
    setPopoverPosition({
      left: Math.max(8, Math.min(triggerRect.right + 6, window.innerWidth - width - 8)),
      top: Math.max(8, Math.min(triggerRect.top, window.innerHeight - Math.min(measuredHeight, maxHeight) - 8)),
    })
  }, [])

  useLayoutEffect(() => {
    if (!popoverOpen) return
    positionPopover()
  }, [popoverOpen, positionPopover])

  useEffect(() => {
    if (!popoverOpen) return
    const closeOnOutsidePress = (event: PointerEvent) => {
      const target = event.target as Node
      if (!triggerRef.current?.contains(target) && !popoverRef.current?.contains(target)) {
        setPopoverOpen(false)
      }
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setPopoverOpen(false)
      triggerRef.current?.focus()
    }
    window.addEventListener('resize', positionPopover)
    window.addEventListener('scroll', positionPopover, true)
    document.addEventListener('pointerdown', closeOnOutsidePress)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      window.removeEventListener('resize', positionPopover)
      window.removeEventListener('scroll', positionPopover, true)
      document.removeEventListener('pointerdown', closeOnOutsidePress)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [popoverOpen, positionPopover])

  const pendantStateLabel = snapshot.enabled
    ? snapshot.phase === 'connected'
      ? controlText('PendantPanel.text001', { value1: String(snapshot.connectedPendants), value2: String(snapshot.connectedPendants === 1 ? '' : 's') })
      : snapshot.phase
    : 'off'
  const pendantButtonValue = snapshot.enabled
    ? snapshot.phase === 'connected'
      ? String(snapshot.connectedPendants)
      : snapshot.phase === 'connecting'
        ? '...'
        : snapshot.phase === 'error'
          ? '!'
          : ''
    : 'off'

  const popover = popoverOpen && typeof document !== 'undefined'
    ? createPortal(
      <div
        id="pendant-pairing-popover"
        ref={popoverRef}
        className="pendant-popover"
        role="dialog"
        aria-label={controlText('PendantPanel.text002')}
        style={popoverPosition
          ? { left: popoverPosition.left, top: popoverPosition.top }
          : { visibility: 'hidden' }}
      >
        <div className="pendant-popover-header">
          <span>{snapshot.enabled ? controlText('PendantPanel.text003') : controlText('PendantPanel.text004')}</span>
          <button
            className="pendant-popover-close"
            type="button"
            aria-label={controlText('PendantPanel.text005')}
            onClick={() => {
              setPopoverOpen(false)
              triggerRef.current?.focus()
            }}
          >
            <X size={14} />
          </button>
        </div>
        <div className="pendant-panel-body">
          {!snapshot.enabled ? (
            <>
              {connectionKind === 'simulator' ? null : (
                <>
                  <div className="pendant-warning" role="note">
                    <Smartphone size={15} aria-hidden="true" />
                    <span>{controlText('PendantPanel.text006')}</span>
                  </div>
                  <label className="pendant-confirm-row">
                    <input
                      type="checkbox"
                      checked={warningAccepted}
                      onChange={(event) => setWarningAccepted(event.currentTarget.checked)}
                    />
                    <span>{controlText('PendantPanel.text007')}</span>
                  </label>
                </>
              )}
              <div className="pendant-actions">
                <button
                  className="modal-btn modal-btn-primary"
                  type="button"
                  data-testid="pendant-enable"
                  disabled={!machineConnected || hostBusy || (connectionKind !== 'simulator' && !warningAccepted)}
                  onClick={() => void enableRemoteControl()}
                >
                  <Link2 size={13} /> {hostBusy ? 'Starting...' : controlText('PendantPanel.text008')}
                </button>
                <button
                  className="modal-btn modal-btn-ghost pendant-icon-btn"
                  type="button"
                  data-tooltip={controlText('PendantPanel.text009')}
                  aria-label={controlText('PendantPanel.text010')}
                  disabled={hostBusy}
                  onClick={rotatePairingCode}
                >
                  <RefreshCw size={13} />
                </button>
              </div>
              {!machineConnected && (
                <div className="control-connect-detail">{controlText('PendantPanel.text011')}</div>
              )}
              {hostError && (
                <div className="control-connect-error" data-testid="pendant-host-error">{hostError}</div>
              )}
            </>
          ) : (
            <>
              {snapshot.phase === 'connecting' && (
                <div className="pendant-status-line">{controlText('PendantPanel.text012')}</div>
              )}
              {pairingUrl && (
                <>
                  <div className="pendant-qr-wrap">
                    <LocalQrCode value={pairingUrl} />
                    <span>{controlText('PendantPanel.text013')}</span>
                  </div>
                  {snapshot.lanIps.length > 1 && (
                    <label className="pendant-field">
                      <span>{controlText('PendantPanel.text014')}</span>
                      <select
                        className="mform-input"
                        value={lanIp ?? ''}
                        onChange={(event) => setSelectedLanIp(event.currentTarget.value)}
                      >
                        {snapshot.lanIps.map((ip) => <option key={ip} value={ip}>{ip}</option>)}
                      </select>
                    </label>
                  )}
                  <div className="pendant-pair-label">{controlText('PendantPanel.text015')}</div>
                  <div className="pendant-url-row">
                    <input className="mform-input pendant-url" readOnly value={pairingUrl} aria-label={controlText('PendantPanel.text016')} />
                    <button
                      className="modal-btn modal-btn-ghost pendant-copy-btn"
                      type="button"
                      data-testid="pendant-copy-url"
                      onClick={() => void copyPairingUrl()}
                    >
                      <Copy size={13} /> {copied ? controlText('PendantPanel.text017') : controlText('PendantPanel.text018')}
                    </button>
                  </div>
                  <div className="pendant-pair-code">{catalogChildren(controlText('PendantPanel.text019', { value1: '\u0000value1\u0000' }), { value1: snapshot.pairingToken.slice(0, 8) })}</div>
                </>
              )}
              {snapshot.phase === 'connected' && snapshot.lanIps.length === 0 && (
                <div className="control-connect-error">{controlText('PendantPanel.text020')}</div>
              )}
              {snapshot.lastError && (
                <div className="control-connect-error" data-testid="pendant-error">{snapshot.lastError}</div>
              )}
              {snapshot.lastActivity && (
                <div className="pendant-last-activity" role="status">{snapshot.lastActivity}</div>
              )}
              <button
                className="modal-btn modal-btn-danger pendant-disable-btn"
                type="button"
                data-testid="pendant-disable"
                disabled={hostBusy}
                onClick={() => void disableRemoteControl()}
              >
                <Link2Off size={13} /> {hostBusy ? 'Stopping...' : controlText('PendantPanel.text021')}
              </button>
            </>
          )}
          {!snapshot.enabled && snapshot.lastError && (
            <div className="control-connect-error" data-testid="pendant-error">{snapshot.lastError}</div>
          )}
        </div>
      </div>,
      document.body,
    )
    : null

  return (
    <>
      <button
        ref={triggerRef}
        className={`pendant-status-button pendant-status-${snapshot.phase}`}
        type="button"
        data-testid="pendant-status-button"
        aria-label={controlText('PendantPanel.text022', { value1: String(pendantStateLabel) })}
        aria-expanded={popoverOpen}
        aria-controls="pendant-pairing-popover"
        onClick={() => setPopoverOpen((open) => !open)}
      >
        <Smartphone size={12} aria-hidden="true" />
        <span className="pendant-status-label">{controlText('PendantPanel.text023')}</span>
        <span className="pendant-status-dot" aria-hidden="true" />
        <span className="pendant-status-value">{pendantButtonValue}</span>
        <ChevronRight size={12} className={popoverOpen ? 'pendant-chevron-open' : ''} aria-hidden="true" />
      </button>
      {popover}
    </>
  )
}
