import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { textFor, useText } from '../../i18n'
import { RELEASE_CHECK_DELAY_MS } from '../../lib/update/releaseCheck'
import {
  claimLaunchUpdateCheck, desktopUpdateHost, dismissUpdateVersion, formatMegabytes, installRestarts, isUpdateDismissed,
  offersDownload, startUpdateRecheck,
  type UpdateCheck, type UpdateDownload, type UpdateInstall, type UpdateKind, type UpdateProgress,
} from '../../lib/update/desktopUpdate'

// WO-2883: one small offer when a newer published release exists. "Not now",
// "Later" and Close hide that version until the next start; while the app stays
// open a silent re-check offers only a newer release (owner ruling 10-17). Nothing else asks
// (rule 11: no nags). Offline stays silent and the app carries on. A failed download, or a checked file that
// went missing before install, is one console line and an offer to download again.

const messageText = () => textFor('desktop-update.wo3267')

type Notice = { severity: 'info' | 'error'; source: 'app'; message: string }
type Available = Extract<UpdateCheck, { status: 'available' }>
type Phase =
  | { name: 'hidden' }
  | { name: 'offer'; release: Available }
  | { name: 'downloading'; release: Available; progress: UpdateProgress | null }
  | { name: 'ready'; release: Available; kind: UpdateKind; note: string | null }
  | { name: 'installing'; message: string }
  | { name: 'failed'; message: string; release: Available; retry: Available | null }

const bar: CSSProperties = {
  position: 'fixed', right: 16, bottom: 40, zIndex: 900, maxWidth: 460,
  display: 'flex', flexDirection: 'column', gap: 'var(--space-2)',
  padding: 'var(--space-3)', borderRadius: 6,
  background: 'var(--surface-banner)', color: 'var(--text-bright)',
  border: '1px solid var(--border-subtle)', fontSize: 'var(--font-size-sm)',
  boxShadow: '0 4px 16px rgba(0, 0, 0, 0.35)',
}
const row: CSSProperties = { display: 'flex', gap: 'var(--space-2)', justifyContent: 'flex-end' }

export function DesktopUpdateOffer({ emit }: { emit: (notice: Notice) => void }) {
  const t = useText('desktop-update.wo3267')
  const [phase, setPhase] = useState<Phase>({ name: 'hidden' })
  const emitRef = useRef(emit)
  useEffect(() => { emitRef.current = emit }, [emit])
  const host = desktopUpdateHost()

  useEffect(() => {
    if (!host || !claimLaunchUpdateCheck()) return
    const check = () => {
      void host.check().then((result) => {
        // Offline or unreadable stays silent, as WO-2720 settled for the launch check.
        if (!offersDownload(result) || isUpdateDismissed(result.version)) return
        // A re-check never interrupts a download, an install or a message on screen.
        setPhase((current) => current.name === 'hidden' || current.name === 'offer'
          ? { name: 'offer', release: result }
          : current)
      }, () => { /* the main process answers every failure itself; nothing to add */ })
    }
    setTimeout(() => { check(); startUpdateRecheck(check) }, RELEASE_CHECK_DELAY_MS)
    // Deliberately not cleared: StrictMode remounts the shell immediately and
    // the launch's single check and re-check must still run.
  }, [host])

  useEffect(() => host?.onProgress((progress) => {
    setPhase((current) => current.name === 'downloading' && current.release.version === progress.version
      ? { ...current, progress }
      : current)
  }), [host])

  if (!host || phase.name === 'hidden') return null

  const download = async (release: Available) => {
    setPhase({ name: 'downloading', release, progress: null })
    const result = await host.download(release.tag).catch((error: unknown): UpdateDownload => ({
      ok: false, message: messageText()('downloadFailed', { version: release.version, error: error instanceof Error ? error.message : String(error) }),
    }))
    if (!result.ok) {
      emitRef.current({ severity: 'error', source: 'app', message: result.message })
      setPhase({ name: 'failed', message: result.message, release, retry: release })
      return
    }
    emitRef.current({ severity: 'info', source: 'app', message: messageText()('downloadedMatched', { version: result.version }) })
    setPhase({ name: 'ready', release, kind: result.kind, note: null })
  }

  const install = async (release: Available, kind: UpdateKind) => {
    // Re-checking a large file takes a moment; the offer leaves the ready screen so
    // the button cannot be pressed twice (the main process also joins a second call).
    setPhase({ name: 'installing', message: messageText()('installChecking', { version: release.version }) })
    const result = await host.install().catch((error: unknown): UpdateInstall => ({
      ok: false, message: messageText()('installFailed', { version: release.version, error: error instanceof Error ? error.message : String(error) }),
    }))
    emitRef.current({ severity: result.ok ? 'info' : 'error', source: 'app', message: result.message })
    if (!result.ok && result.downloadAgain) setPhase({ name: 'failed', message: result.message, release, retry: release })
    else if (!result.ok) setPhase({ name: 'ready', release, kind, note: result.message })
    else if (result.restarting) setPhase({ name: 'installing', message: result.message })
    else setPhase({ name: 'failed', message: result.message, release, retry: null })
  }

  const hide = () => setPhase({ name: 'hidden' })
  const putOff = (release: Available) => { dismissUpdateVersion(release.version); hide() }
  const retry = phase.name === 'failed' ? phase.retry : null

  return (
    <div role="status" aria-live="polite" data-testid="desktop-update-offer" style={bar}>
      {phase.name === 'offer' && (
        <>
          <div>
            {phase.release.size
              ? t('offerAvailableSized', { version: phase.release.version, currentVersion: phase.release.currentVersion, size: formatMegabytes(phase.release.size) })
              : t('offerAvailable', { version: phase.release.version, currentVersion: phase.release.currentVersion })}
          </div>
          <div style={row}>
            <button className="modal-btn modal-btn-ghost" onClick={() => putOff(phase.release)}>{t('notNow')}</button>
            <button className="modal-btn modal-btn-primary" onClick={() => void download(phase.release)}>{t('download')}</button>
          </div>
        </>
      )}
      {phase.name === 'downloading' && (
        <div>
          {phase.progress?.total
            ? t('downloadingPercent', { version: phase.release.version, percent: Math.floor((phase.progress.received / phase.progress.total) * 100) })
            : t('downloading', { version: phase.release.version })}
        </div>
      )}
      {phase.name === 'ready' && (
        <>
          <div>
            {t('downloaded', { version: phase.release.version })}{' '}
            {installRestarts(phase.kind)
              ? t('installExplanation')
              : t('showFileExplanation')}
          </div>
          {phase.note && <div style={{ color: 'var(--text-danger)' }}>{phase.note}</div>}
          <div style={row}>
            <button className="modal-btn modal-btn-ghost" onClick={() => putOff(phase.release)}>{t('later')}</button>
            <button className="modal-btn modal-btn-primary" onClick={() => void install(phase.release, phase.kind)}>
              {installRestarts(phase.kind) ? t('installAndRestart') : t('showFile')}
            </button>
          </div>
        </>
      )}
      {phase.name === 'installing' && <div>{phase.message}</div>}
      {phase.name === 'failed' && (
        <>
          <div>{phase.message}</div>
          <div style={row}>
            <button className="modal-btn modal-btn-ghost" onClick={() => putOff(phase.release)}>{t('close')}</button>
            {retry && <button className="modal-btn modal-btn-primary" onClick={() => void download(retry)}>{t('downloadAgain')}</button>}
          </div>
        </>
      )}
    </div>
  )
}
