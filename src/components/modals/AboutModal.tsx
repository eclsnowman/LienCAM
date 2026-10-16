import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import creditsData from '../../about/credits.json'
import wordmark from '../../../brand/liencam-wordmark.svg'
import { useDialogFocus } from '../../hooks/useDialogFocus'
import { assetUrl } from '../../lib/assetUrl'
import { APP_VERSION, BUILD_DATE, GIT_COMMIT_LABEL } from '../../version'

type Credits = Pick<typeof creditsData, 'categories' | 'entries'>
type View = 'about' | 'credits' | 'licences'
const VIEWS: { id: View; label: string }[] = [
  { id: 'about', label: 'About' },
  { id: 'credits', label: 'Credits' },
  { id: 'licences', label: 'Licence texts' },
]
const LICENCE_FILES = ['LICENSE', 'THIRD_PARTY_LICENSES.md'] as const
type LicenceText = { file: string; text?: string; error?: string }

/** Kept above Help so closing About preserves Help's topic and any editor beneath it. */
export function AboutModal({ isOpen, onClose, credits = creditsData }: {
  isOpen: boolean
  onClose: () => void
  credits?: Credits
}) {
  const [view, setView] = useState<View>('about')
  const [licences, setLicences] = useState<LicenceText[] | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [linkError, setLinkError] = useState<string | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const dialogFocusRef = useDialogFocus<HTMLDivElement>()

  useEffect(() => {
    if (isOpen) setView('about')
  }, [isOpen])

  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0
  }, [view])

  useEffect(() => {
    if (!isOpen) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopImmediatePropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [isOpen, onClose])

  useEffect(() => {
    if (!isOpen || view !== 'licences') return
    let live = true
    setLicences(null)
    void Promise.all(LICENCE_FILES.map(async (file): Promise<LicenceText> => {
      try {
        const response = await fetch(assetUrl(file))
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return { file, text: await response.text() }
      } catch (error) {
        return { file, error: error instanceof Error ? error.message : String(error) }
      }
    })).then((texts) => { if (live) setLicences(texts) })
    return () => { live = false }
  }, [isOpen, view, attempt])

  if (!isOpen) return null
  return (
    <div className="modal-backdrop about-backdrop" data-testid="about-backdrop" data-ui78-sanctioned="">
      <div className="modal-container about-modal" role="dialog" aria-modal="true"
        aria-labelledby="about-title" data-testid="about-modal" ref={dialogFocusRef}>
        <div className="modal-header">
          <span className="modal-title" id="about-title">About LienCAM</span>
          <button type="button" className="modal-close-btn" aria-label="Close About LienCAM" onClick={onClose}>
            <X size={14} />
          </button>
        </div>
        <div className="about-tabs" role="tablist" aria-label="About LienCAM sections">
          {VIEWS.map((item, index) => (
            <button type="button" role="tab" key={item.id} id={`about-tab-${item.id}`}
              aria-selected={view === item.id} aria-controls="about-panel" tabIndex={view === item.id ? 0 : -1}
              className="modal-btn modal-btn-ghost" onClick={() => setView(item.id)}
              onKeyDown={(event) => {
                const next = event.key === 'ArrowRight' ? (index + 1) % VIEWS.length
                  : event.key === 'ArrowLeft' ? (index + VIEWS.length - 1) % VIEWS.length
                    : event.key === 'Home' ? 0 : event.key === 'End' ? VIEWS.length - 1 : null
                if (next === null) return
                event.preventDefault()
                setView(VIEWS[next].id)
                document.getElementById(`about-tab-${VIEWS[next].id}`)?.focus()
              }}>{item.label}</button>
          ))}
        </div>
        <div className="modal-body about-body" id="about-panel" role="tabpanel"
          aria-labelledby={`about-tab-${view}`} tabIndex={0} ref={bodyRef}>
          {view === 'about' && (
            <div className="about-summary">
              <img className="about-wordmark" src={wordmark} alt="LienCAM" />
              <p className="about-version">Version {APP_VERSION}</p>
              <p style={{ display: 'flex', gap: 20, justifyContent: 'center' }}>
                {[
                  ['GitHub project', 'https://github.com/eclsnowman/LienCAM'],
                  ['Releases', 'https://github.com/eclsnowman/LienCAM/releases'],
                ].map(([label, url]) => <a key={url} href={url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--text-active)' }}
                  onClick={(event) => {
                    const host = (globalThis as typeof globalThis & {
                      liencamHost?: { openProjectLink?: (url: string) => Promise<void> }
                    }).liencamHost
                    if (!host?.openProjectLink) return
                    event.preventDefault()
                    setLinkError(null)
                    void host.openProjectLink(url).catch(() => setLinkError('Could not open the system browser.'))
                  }}>{label}</a>)}
              </p>
              {linkError && <p role="alert">{linkError}</p>}
              <dl className="about-build">
                <dt>Build commit</dt><dd>{GIT_COMMIT_LABEL}</dd>
                <dt>Build date</dt><dd>{BUILD_DATE}</dd>
              </dl>
              <p>Apache-2.0 for LienCAM's own code; the adaptive-clearing engine is a separate LGPL-2.1-or-later module</p>
              <p>Copyright (c) 2026 Eric Lien and LienCAM contributors</p>
              <p className="about-muted">See Credits for the people and projects LienCAM stands on, and Licence texts for the bundled licences.</p>
            </div>
          )}
          {view === 'credits' && credits.categories.map((category) => (
            <section className="about-credit-group" key={category.id} aria-labelledby={`about-category-${category.id}`}>
              <h2 id={`about-category-${category.id}`}>{category.title}</h2>
              <p className="about-muted">{category.intro}</p>
              <ul className="about-credit-list">
                {credits.entries.filter((entry) => entry.category === category.id).map((entry) => (
                  <li key={entry.id} data-testid="about-credit-row" data-credit-id={entry.id}>
                    <h3>{entry.link ? <a href={entry.link} target="_blank" rel="noopener noreferrer">{entry.name}</a> : entry.name}</h3>
                    <p>{entry.thanks}</p>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {view === 'licences' && (
            <div className="about-licences" aria-live="polite">
              {!licences && <p>Loading licence texts...</p>}
              {licences?.map((licence) => (
                <section key={licence.file}>
                  <h2>{licence.file}</h2>
                  {licence.error ? <p role="alert">Could not load {licence.file}: {licence.error}</p>
                    : <pre>{licence.text}</pre>}
                </section>
              ))}
              {licences?.some((licence) => licence.error) && (
                <button type="button" className="modal-btn modal-btn-ghost" onClick={() => setAttempt((value) => value + 1)}>Retry licence texts</button>
              )}
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button type="button" className="modal-btn modal-btn-primary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}
