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
      ? `${snapshot.connectedPendants} phone${snapshot.connectedPendants === 1 ? '' : 's'}`
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
        aria-label="Mobile pendant pairing"
        style={popoverPosition
          ? { left: popoverPosition.left, top: popoverPosition.top }
          : { visibility: 'hidden' }}
      >
        <div className="pendant-popover-header">
          <span>{snapshot.enabled ? 'Phone pairing' : 'Enable phone control'}</span>
          <button
            className="pendant-popover-close"
            type="button"
            aria-label="Close mobile pendant pairing"
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
                    <span>
                      Remote controls can move the machine. Stay beside it with the physical E-stop within reach.
                    </span>
                  </div>
                  <label className="pendant-confirm-row">
                    <input
                      type="checkbox"
                      checked={warningAccepted}
                      onChange={(event) => setWarningAccepted(event.currentTarget.checked)}
                    />
                    <span>I will stay by the machine while remote control is enabled.</span>
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
                  <Link2 size={13} /> {hostBusy ? 'Starting...' : 'Enable remote control'}
                </button>
                <button
                  className="modal-btn modal-btn-ghost pendant-icon-btn"
                  type="button"
                  data-tooltip="Generate a new pairing code"
                  aria-label="Generate a new pairing code"
                  disabled={hostBusy}
                  onClick={rotatePairingCode}
                >
                  <RefreshCw size={13} />
                </button>
              </div>
              {!machineConnected && (
                <div className="control-connect-detail">Connect the machine or simulator before enabling the pendant.</div>
              )}
              {hostError && (
                <div className="control-connect-error" data-testid="pendant-host-error">{hostError}</div>
              )}
            </>
          ) : (
            <>
              {snapshot.phase === 'connecting' && (
                <div className="pendant-status-line">Connecting to the machine-local broker...</div>
              )}
              {pairingUrl && (
                <>
                  <div className="pendant-qr-wrap">
                    <LocalQrCode value={pairingUrl} />
                    <span>Scan to connect</span>
                  </div>
                  {snapshot.lanIps.length > 1 && (
                    <label className="pendant-field">
                      <span>Phone network</span>
                      <select
                        className="mform-input"
                        value={lanIp ?? ''}
                        onChange={(event) => setSelectedLanIp(event.currentTarget.value)}
                      >
                        {snapshot.lanIps.map((ip) => <option key={ip} value={ip}>{ip}</option>)}
                      </select>
                    </label>
                  )}
                  <div className="pendant-pair-label">Open this address on a phone connected to this LAN:</div>
                  <div className="pendant-url-row">
                    <input className="mform-input pendant-url" readOnly value={pairingUrl} aria-label="Pendant pairing URL" />
                    <button
                      className="modal-btn modal-btn-ghost pendant-copy-btn"
                      type="button"
                      data-testid="pendant-copy-url"
                      onClick={() => void copyPairingUrl()}
                    >
                      <Copy size={13} /> {copied ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                  <div className="pendant-pair-code">Session code {snapshot.pairingToken.slice(0, 8)}</div>
                </>
              )}
              {snapshot.phase === 'connected' && snapshot.lanIps.length === 0 && (
                <div className="control-connect-error">No LAN IPv4 address was found for phone pairing.</div>
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
                <Link2Off size={13} /> {hostBusy ? 'Stopping...' : 'Disable remote control'}
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
        aria-label={`Remote pendant: ${pendantStateLabel}`}
        aria-expanded={popoverOpen}
        aria-controls="pendant-pairing-popover"
        onClick={() => setPopoverOpen((open) => !open)}
      >
        <Smartphone size={12} aria-hidden="true" />
        <span className="pendant-status-label">Pendant</span>
        <span className="pendant-status-dot" aria-hidden="true" />
        <span className="pendant-status-value">{pendantButtonValue}</span>
        <ChevronRight size={12} className={popoverOpen ? 'pendant-chevron-open' : ''} aria-hidden="true" />
      </button>
      {popover}
    </>
  )
}
