import { textFor, useText } from '../../i18n'
// WO-2759: Help > Report a problem (docs/design/REPORT-A-PROBLEM-V2.md).
//
// Screen order (design section 6): problem to report -> what to include ->
// the actual files -> Save ZIP -> optional Open bug report on GitHub, which
// first shows the exact prefill fields. The details are read ONCE into a
// frozen copy when the dialog opens (or on "Read details again"); every change
// of choice rebuilds the preview from that copy, and Save writes the exact
// bytes the preview was built from. Closing drops the copy and any chosen file.
// So does Clear, here or in another tab, and so does choosing another incident:
// no consent or chosen file carries over (design sections 2 and 5).
//
// Its own open flag, not activeModal: Report a problem opens from Help even
// when Help sits as an overlay over another dialog, and must not replace that
// dialog (and its unsaved edits) underneath.

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { create } from 'zustand'
import { Bug, ExternalLink, FileDown, RefreshCw, X } from 'lucide-react'
import {
  CATEGORY_IDS, DEFAULT_CHOICES, LIMITS, REPORT_FILENAME, buildReport, clearDiagnosticHistory, diagnosticHistory,
  freezeReportSources, issueFormUrl, openIssueForm, optionalSourceAvailable, prefillFields, readOptionalSource,
  type Attachment, type BuiltReport, type CategoryId, type PrefillFieldId, type ReportChoices, type ReportSources,
} from '../../lib/diagnostics'
import { saveFile } from '../../lib/saveFile'
import { useUiPrefs } from '../../store/uiPrefs'
import { useDialogFocus } from '../../hooks/useDialogFocus'
import './ReportProblemModal.css'

const shellText = textFor('app-shell-settings-menus')
const t = (key: string, values?: Record<string, unknown>): string =>
  String(shellText(`ReportProblemModal.${key}` as Parameters<typeof shellText>[0], values as never))

export const useReportProblem = create<{ open: boolean }>(() => ({ open: false }))
export function openReportProblem() { useReportProblem.setState({ open: true }) }
function closeReportProblem() { useReportProblem.setState({ open: false }) }

const CATEGORY_KEY: Record<CategoryId, string> = {
  appVersions: 'AppVersions', basicEnvironment: 'BasicEnvironment', eventHistory: 'EventHistory',
  machineState: 'MachineState', operationSettings: 'OperationSettings', preciseEnvironment: 'PreciseEnvironment',
  originalProject: 'OriginalProject', originalProgram: 'OriginalProgram', appImage: 'AppImage',
}

type AttachmentSlot = 'project' | 'program' | 'image'
const SLOT_OF: Partial<Record<CategoryId, AttachmentSlot>> = { originalProject: 'project', originalProgram: 'program', appImage: 'image' }
const ACCEPT: Record<AttachmentSlot, string> = {
  project: '.camproject',
  program: '.nc,.ngc,.gcode,.tap,.cnc,.txt',
  image: 'image/png,image/jpeg',
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`
  return `${(n / 1024 / 1024).toFixed(1)} MiB`
}

function useHistorySummaries() {
  const h = diagnosticHistory()
  const version = useSyncExternalStore(
    (listener) => h.subscribe(listener),
    () => h.summaries().map((s) => `${s.id}:${s.eventCount}`).join('|'),
  )
  return useMemo(() => h.summaries(), [h, version])
}

export function ReportProblemModal() {
  useText('app-shell-settings-menus')
  const open = useReportProblem((s) => s.open)
  const h = diagnosticHistory()
  const clearGeneration = useSyncExternalStore((listener) => h.subscribe(listener), () => h.clearGeneration)
  if (!open) return null
  // A Clear (here or broadcast from another tab) ends the pending report: the
  // dialog starts again with no file, choice or frozen copy from before it.
  return <ReportProblemDialog key={clearGeneration} />
}

const NO_ATTACHMENTS: Record<AttachmentSlot, Attachment | null> = { project: null, program: null, image: null }

function ReportProblemDialog() {
  const history = diagnosticHistory()
  const summaries = useHistorySummaries()
  const recording = useUiPrefs((s) => s.diagnosticHistoryRecording)
  const setRecording = useUiPrefs((s) => s.setDiagnosticHistoryRecording)
  const dialogFocusRef = useDialogFocus<HTMLDivElement>()

  const [incidentId, setIncidentId] = useState(() => history.defaultIncidentSessionId())
  const [attachments, setAttachments] = useState<Record<AttachmentSlot, Attachment | null>>(NO_ATTACHMENTS)
  const [attachmentNote, setAttachmentNote] = useState<Partial<Record<AttachmentSlot, string>>>({})
  const [readCount, setReadCount] = useState(0)
  const [excluded, setExcluded] = useState<Set<number>>(new Set())
  const [choices, setChoices] = useState<ReportChoices>(DEFAULT_CHOICES)
  const [report, setReport] = useState<BuiltReport | null>(null)
  const [saveMessage, setSaveMessage] = useState<string | null>(null)
  const [prefillOpen, setPrefillOpen] = useState(false)
  const [prefillDropped, setPrefillDropped] = useState<Set<PrefillFieldId>>(new Set())
  const [confirmClear, setConfirmClear] = useState(false)
  const [openError, setOpenError] = useState<string | null>(null)
  const fileInputs = useRef<Partial<Record<AttachmentSlot, HTMLInputElement | null>>>({})

  // Expiry runs before a report reads the history, not only at startup.
  useEffect(() => { void history.prune() }, [history])

  // The frozen copy. Rebuilt only on purpose: a new incident, a chosen file,
  // or "Read details again" - never by live logging underneath the preview.
  const frozen = useMemo(
    () => freezeReportSources(incidentId, attachments),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [incidentId, attachments, readCount],
  )
  // Off-by-default categories are read only once ticked, and dropped when unticked.
  const precise = useMemo(
    () => (choices.preciseEnvironment ? readOptionalSource('preciseEnvironment') : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [choices.preciseEnvironment, readCount],
  )
  const settings = useMemo(
    () => (choices.operationSettings ? readOptionalSource('operationSettings') : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [choices.operationSettings, readCount],
  )
  const sources: ReportSources = useMemo(
    () => ({ ...frozen, preciseEnvironment: precise, operationSettings: settings }),
    [frozen, precise, settings],
  )
  const optionalAvailable = useMemo(
    () => ({ preciseEnvironment: optionalSourceAvailable('preciseEnvironment'), operationSettings: optionalSourceAvailable('operationSettings') }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [readCount],
  )

  // Machine state is "on if available"; an unavailable category starts off.
  const [initialised, setInitialised] = useState(false)
  useEffect(() => {
    if (initialised) return
    setInitialised(true)
    setChoices((c) => ({ ...c, machineState: sources.machineState !== null, eventHistory: sources.incident !== null }))
  }, [initialised, sources])

  // Any change invalidates the preview first, then rebuilds it.
  const buildId = useRef(0)
  useEffect(() => {
    const id = ++buildId.current
    setReport(null)
    setSaveMessage(null)
    setPrefillOpen(false)
    void buildReport(choices, sources, excluded).then((built) => {
      if (id === buildId.current) setReport(built)
    })
  }, [choices, sources, excluded])

  // Escape closes this dialog only.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      closeReportProblem()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  const imageFile = report?.files.find((f) => f.category === 'appImage') ?? null
  const imageUrl = useMemo(() => (imageFile ? URL.createObjectURL(new Blob([imageFile.bytes as BlobPart], { type: imageFile.name.endsWith('.jpg') ? 'image/jpeg' : 'image/png' })) : null), [imageFile])
  useEffect(() => () => { if (imageUrl) URL.revokeObjectURL(imageUrl) }, [imageUrl])

  const available = (id: CategoryId) => {
    const slot = SLOT_OF[id]
    if (slot) return true
    switch (id) {
      case 'appVersions': return sources.appVersions !== null
      case 'basicEnvironment': return sources.basicEnvironment !== null
      case 'preciseEnvironment': return optionalAvailable.preciseEnvironment
      case 'eventHistory': return sources.incident !== null
      case 'machineState': return sources.machineState !== null
      case 'operationSettings': return optionalAvailable.operationSettings
      default: return false
    }
  }

  // Design section 2: no consent carries to a new incident. Every choice goes
  // back to its default and chosen files are dropped; a file still being read
  // when the incident changes is discarded too.
  const consentEpoch = useRef(0)
  const selectIncident = (id: string) => {
    consentEpoch.current += 1
    setIncidentId(id)
    setAttachments(NO_ATTACHMENTS)
    setAttachmentNote({})
    setExcluded(new Set())
    setChoices(DEFAULT_CHOICES)
    setInitialised(false)
    setPrefillDropped(new Set())
  }

  const pickFile = async (slot: AttachmentSlot, file: File | undefined) => {
    if (!file) return
    const epoch = consentEpoch.current
    if (slot === 'image' && file.type !== 'image/png' && file.type !== 'image/jpeg') {
      setAttachmentNote((n) => ({ ...n, [slot]: t('imageTypeOnly') }))
      return
    }
    if (file.size > LIMITS.attachmentBytes) {
      setAttachmentNote((n) => ({ ...n, [slot]: t('fileTooLarge', { size: formatBytes(file.size) }) }))
      return
    }
    try {
      // Read once: the report keeps these bytes even if the file changes later.
      const bytes = new Uint8Array(await file.arrayBuffer())
      if (epoch !== consentEpoch.current) return
      const kind = slot === 'image' ? (file.type === 'image/jpeg' ? 'jpg' : 'png') : undefined
      setAttachments((a) => ({ ...a, [slot]: { bytes, kind } }))
      setAttachmentNote((n) => ({ ...n, [slot]: t('fileChosen', { size: formatBytes(bytes.length) }) }))
    } catch {
      setAttachmentNote((n) => ({ ...n, [slot]: t('fileUnreadable') }))
    }
  }

  const save = async () => {
    if (!report || report.problems.length) return
    try {
      const where = await saveFile(REPORT_FILENAME, new Blob([report.zip as BlobPart], { type: 'application/zip' }), 'application/zip')
      if (where === null) return
      setSaveMessage(where === 'download' ? t('saved') : t('savedTo', { where }))
    } catch (error) {
      setSaveMessage(t('saveFailed', { detail: error instanceof Error ? error.message : String(error) }))
    }
  }

  const offered = report ? prefillFields(report, sources) : []
  const kept = offered.filter((f) => !prefillDropped.has(f.id))
  const url = issueFormUrl(kept)

  const sessionName = (index: number, current: boolean) => (current ? t('thisSession') : t('earlierSession', { number: index }))
  const storedSessions = summaries.filter((s) => s.eventCount > 0).length
  const incidentEvents = sources.incident?.events ?? []

  return (
    <div className="modal-backdrop report-problem-backdrop" data-testid="report-problem-backdrop" data-ui78-sanctioned=""
      onMouseDown={(event) => { if (event.target === event.currentTarget) closeReportProblem() }}>
      <div className="modal-container report-problem-modal" data-testid="report-problem" role="dialog" aria-modal="true"
        aria-labelledby="report-problem-title" ref={dialogFocusRef}>
        <div className="modal-header">
          <Bug size={15} className="modal-header-icon" />
          <span className="modal-title" id="report-problem-title">{t('title')}</span>
          <button type="button" className="modal-close-btn" data-testid="report-problem-close" onClick={closeReportProblem} aria-label={t('close')}>
            <X size={14} />
          </button>
        </div>

        <div className="modal-body report-problem-body">
          <div className="report-problem-intro">
            <p>{t('introChoose')}</p>
            <p>{t('introPublic')}</p>
            <p>{t('introUpload')}</p>
          </div>

          <section className="report-problem-section" aria-labelledby="report-problem-incident">
            <h3 id="report-problem-incident">{t('incident')}</h3>
            <div className="report-problem-row">
              <select data-testid="report-problem-incident" value={incidentId}
                onChange={(event) => selectIncident(event.target.value)}>
                {summaries.map((s, i) => (
                  <option key={s.id} value={s.id}>
                    {t(s.endedCleanly || s.current ? 'incidentOption' : 'incidentOptionUnclean', {
                      label: sessionName(i, s.current), events: s.eventCount, failures: s.failureCount,
                    })}
                  </option>
                ))}
              </select>
              <button type="button" className="modal-btn modal-btn-ghost" data-testid="report-problem-read-again"
                data-tooltip={t('readAgainTip')} onClick={() => { setReadCount((n) => n + 1); setExcluded(new Set()) }}>
                <RefreshCw size={13} /> {t('readAgain')}
              </button>
            </div>
          </section>

          <section className="report-problem-section" aria-labelledby="report-problem-choices">
            <h3 id="report-problem-choices">{t('whatToInclude')}</h3>
            <ul className="report-problem-categories">
              {CATEGORY_IDS.map((id) => {
                const slot = SLOT_OF[id]
                const file = report?.files.find((f) => f.category === id)
                const isAvailable = available(id)
                return (
                  <li key={id} className="report-problem-category" data-testid={`report-problem-cat-${id}`}>
                    <label>
                      <input type="checkbox" checked={choices[id]} disabled={!isAvailable}
                        data-testid={`report-problem-check-${id}`}
                        onChange={(event) => setChoices((c) => ({ ...c, [id]: event.target.checked }))} />
                      <span className="report-problem-category-title">{t(`cat${CATEGORY_KEY[id]}Title`)}</span>
                      {DEFAULT_CHOICES[id] && <span className="report-problem-tag">{t('recommended')}</span>}
                      <span className="report-problem-size">
                        {!isAvailable ? t('notAvailable') : file ? formatBytes(file.size) : ''}
                      </span>
                    </label>
                    <p>{t(`cat${CATEGORY_KEY[id]}Text`)}</p>
                    {slot && choices[id] && (
                      <div className="report-problem-row">
                        <button type="button" className="modal-btn modal-btn-ghost" data-testid={`report-problem-choose-${slot}`}
                          onClick={() => fileInputs.current[slot]?.click()}>
                          {t(slot === 'image' ? 'chooseImage' : 'chooseFile')}
                        </button>
                        {attachmentNote[slot] && <span className="report-problem-note">{attachmentNote[slot]}</span>}
                        <input type="file" hidden accept={ACCEPT[slot]} data-testid={`report-problem-file-${slot}`}
                          ref={(node) => { fileInputs.current[slot] = node }}
                          onChange={(event) => { void pickFile(slot, event.target.files?.[0]); event.target.value = '' }} />
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          </section>

          <section className="report-problem-section" aria-labelledby="report-problem-preview" data-testid="report-problem-preview">
            <h3 id="report-problem-preview">{t('previewHeading')}</h3>
            {!report ? <p className="report-problem-note">{t('previewBuilding')}</p> : (
              <>
                {report.problems.map((p) => <p key={p} className="report-problem-problem" role="alert">{p}</p>)}
                {report.files.map((f) => (
                  <details key={f.name} className="report-problem-file" data-testid={`report-problem-file-preview-${f.name}`} open={f.category === 'appImage'}>
                    <summary>
                      <span className="report-problem-file-name">{t('previewFile', { name: f.name, size: formatBytes(f.size) })}</span>
                      <span className="report-problem-hash">{t('previewHash', { hash: f.sha256.slice(0, 16) })}</span>
                    </summary>
                    {f.category === 'originalProject' && (
                      <div className="report-problem-disclosure">
                        <p>{t('projectDisclosure1')}</p>
                        <p>{t('projectDisclosure2')}</p>
                        <p>{t('projectDisclosure3')}</p>
                        <p>{t('projectEmbedded')}</p>
                      </div>
                    )}
                    {f.category === 'originalProgram' && <p className="report-problem-disclosure">{t('programDisclosure')}</p>}
                    {f.category === 'appImage' && (
                      <>
                        <p className="report-problem-disclosure">{t('imageDisclosure')}</p>
                        {imageUrl && <img className="report-problem-image" src={imageUrl} alt={t('imageAlt')} />}
                      </>
                    )}
                    {f.text !== null && <pre className="report-problem-text">{f.text}</pre>}
                  </details>
                ))}
                {choices.eventHistory && sources.incident && (
                  <details className="report-problem-file" data-testid="report-problem-events">
                    <summary>{t('eventsHeading', { count: incidentEvents.length - excluded.size })}</summary>
                    {incidentEvents.length === 0 ? <p className="report-problem-note">{t('noEvents')}</p> : (
                      <ul className="report-problem-events">
                        {incidentEvents.map((e) => (
                          <li key={e.seq}>
                            <label>
                              <input type="checkbox" checked={!excluded.has(e.seq)} aria-label={t('keepEvent')}
                                onChange={(event) => setExcluded((x) => {
                                  const next = new Set(x)
                                  if (event.target.checked) next.delete(e.seq)
                                  else next.add(e.seq)
                                  return next
                                })} />
                              <code>{`#${e.seq} +${(e.t / 1000).toFixed(1)}s ${e.code}`}</code>
                            </label>
                          </li>
                        ))}
                      </ul>
                    )}
                  </details>
                )}
              </>
            )}
          </section>

          {prefillOpen && report && (
            <section className="report-problem-section report-problem-prefill" data-testid="report-problem-prefill" aria-labelledby="report-problem-prefill-title">
              <h3 id="report-problem-prefill-title">{t('prefillHeading')}</h3>
              {offered.length === 0 ? <p>{t('prefillNone')}</p> : (
                <ul className="report-problem-categories">
                  {offered.map((f) => (
                    <li key={f.id} className="report-problem-category">
                      <label>
                        <input type="checkbox" checked={!prefillDropped.has(f.id)} data-testid={`report-problem-prefill-${f.id}`}
                          onChange={(event) => setPrefillDropped((d) => {
                            const next = new Set(d)
                            if (event.target.checked) next.delete(f.id)
                            else next.add(f.id)
                            return next
                          })} />
                        <span className="report-problem-category-title">{f.label}</span>
                        <span className="report-problem-size">{f.value}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
              <p>{t('prefillNote')}</p>
              <p className="report-problem-note">{t('prefillAddress')}</p>
              <pre className="report-problem-text" data-testid="report-problem-prefill-url">{url}</pre>
              {openError && <p className="report-problem-problem" role="alert">{openError}</p>}
              <div className="report-problem-row">
                <button type="button" className="modal-btn modal-btn-primary" data-testid="report-problem-prefill-open"
                  onClick={() => {
                    setOpenError(null)
                    void openIssueForm(url).catch((error: unknown) => setOpenError(t('openFailed', { detail: error instanceof Error ? error.message : String(error) })))
                  }}>
                  <ExternalLink size={13} /> {t('prefillOpen')}
                </button>
                <button type="button" className="modal-btn modal-btn-ghost" onClick={() => setPrefillOpen(false)}>{t('prefillCancel')}</button>
              </div>
            </section>
          )}

          <section className="report-problem-section" aria-labelledby="report-problem-history">
            <h3 id="report-problem-history">{t('historyHeading')}</h3>
            <label className="report-problem-row">
              <input type="checkbox" checked={recording} data-testid="report-problem-record"
                onChange={(event) => setRecording(event.target.checked)} />
              <span>{t('recordLabel')}</span>
            </label>
            <p className="report-problem-note">{t('recordHelp')}</p>
            <p className="report-problem-note">
              {history.status.available
                ? t('historyStored', { sessions: storedSessions, size: formatBytes(history.storedBytes()) })
                : t('historyUnavailable')}
            </p>
            {!confirmClear ? (
              <button type="button" className="modal-btn modal-btn-ghost" data-testid="report-problem-clear" onClick={() => setConfirmClear(true)}>
                {t('clearHistory')}
              </button>
            ) : (
              <div className="report-problem-disclosure" data-testid="report-problem-clear-confirm">
                <p>{t('clearConfirm1')}</p>
                <p>{t('clearConfirm2')}</p>
                <p>{t('clearConfirm3')}</p>
                <div className="report-problem-row">
                  <button type="button" className="modal-btn modal-btn-primary" data-testid="report-problem-clear-yes"
                    onClick={() => {
                      setConfirmClear(false)
                      // The dialog restarts on the Clear (see ReportProblemModal).
                      void clearDiagnosticHistory()
                    }}>{t('clearYes')}</button>
                  <button type="button" className="modal-btn modal-btn-ghost" onClick={() => setConfirmClear(false)}>{t('clearNo')}</button>
                </div>
              </div>
            )}
          </section>
        </div>

        <div className="modal-footer report-problem-footer">
          {saveMessage && <span className="report-problem-note" role="status" data-testid="report-problem-saved">{saveMessage}</span>}
          <button type="button" className="modal-btn modal-btn-ghost" data-testid="report-problem-github"
            disabled={!report} onClick={() => { setPrefillDropped(new Set()); setOpenError(null); setPrefillOpen(true) }}>
            <ExternalLink size={13} /> {t('openGitHub')}
          </button>
          <button type="button" className="modal-btn modal-btn-primary" data-testid="report-problem-save"
            data-tooltip={t('saveZipTip')} disabled={!report || report.problems.length > 0} onClick={() => void save()}>
            <FileDown size={13} /> {t('saveZip')}
          </button>
        </div>
      </div>
    </div>
  )
}
