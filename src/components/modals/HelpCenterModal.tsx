import { EngraveVcarveGuide } from './EngraveVcarveGuide'
import { i18n, machineTranslationNote, textFor, useText } from '../../i18n'
// Help Center (WO HELP-1 stage S1) - registry-backed help with a category
// index tree. Topics live in src/help/ (typed modules, lazy bodies per
// category chunk); this modal owns presentation only. Search REPLACES the
// tree with a flat filtered list (seed behavior, unchanged); clearing it
// restores the tree. Context elevation lands in stage S2.
//
// WO-413: Help also opens AT a topic from any HelpLink (openHelpTopic) and,
// when it is opened from inside another modal, as an OVERLAY over that modal
// (useHelpOpen.overlay) so the modal underneath keeps its in-progress edits;
// closing Help (X, Escape, backdrop) returns the user exactly where they were.
//
// WO-2252: a topic image whose file is a video (.mp4 / .webm) plays in place.
// Help videos are walkthroughs of an example project kept beside them
// (public/help/<topic>/<name>.camproject): the steps section that follows the
// video sits beside it, and "Open this example" opens that project on the
// Model screen.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Bug, ChevronDown, ChevronRight, CircleHelp, FolderOpen, Search, Sparkles, X } from 'lucide-react'
import { askBeforeReplacingProject, useCamStore } from '../../store'
import { HELP_CATEGORIES } from '../../help/categories'
import { deriveHelpContext, rankTopics } from '../../help/helpContext'
import { useHelpContext } from '../../help/helpContextStore'
import { closeHelp, isHelpOpen, useHelpOpen } from '../../help/helpOpen'
import { helpIndex, helpIndexEntry, loadTopic } from '../../help/registry'
import type { ContextKey, HelpCategoryId, HelpSection, HelpTopic } from '../../help/types'
import { HelpFigure } from './HelpFigure'
import { CamShortcutMap } from '../settings/CamShortcutMap'
import { useDialogFocus } from '../../hooks/useDialogFocus'
import { useProjectPicker } from '../../lib/projectOpen/picker'
import { assetUrl } from '../../lib/assetUrl'
import { installDiagnostics } from '../../lib/diagnostics'
import { ReportProblemModal, openReportProblem } from './ReportProblemModal'

const shellText = textFor('app-shell-settings-menus')

const DEFAULT_TOPIC_ID = 'setup-wcs'
const ERROR_TOPIC_ID = 'error-details'

const VIDEO_FILE = /\.(mp4|webm)$/i

/**
 * WO-2252: Form and Relief are modes of the Model screen, each with its palette
 * docked beside the rail (folded or not) while it is open. Help opened then
 * suggests that mode's topics first. Read from the page, so the Model screen's
 * lazily loaded stores stay out of the main bundle.
 */
function modelModeKeys(): string[] {
  if (typeof document === 'undefined') return []
  const keys: string[] = []
  if (document.querySelector('[data-testid="form-palette-shell"]')) keys.push('interaction:form')
  if (document.querySelector('[data-testid="relief-palette-shell"]')) keys.push('interaction:relief')
  return keys
}

/** A section that is a video (an image slot whose file is .mp4 / .webm). */
function videoOf(section: HelpSection, topic: HelpTopic) {
  if (section.kind !== 'image') return null
  const image = topic.images.find((i) => i.slot === section.slot)
  return image && image.status === 'done' && VIDEO_FILE.test(image.file) ? image : null
}

/**
 * A Help video. The file is fetched and played from a blob of the right type,
 * so it plays and seeks the same from the web server and from the desktop
 * build's file handler (which answers whole files, with no byte ranges and no
 * video MIME type).
 */
function HelpVideo({ src, alt }: { src: string; alt: string }) {
  useText('app-shell-settings-menus')
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    let objectUrl: string | null = null
    setUrl(null)
    void fetch(src)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.blob()
      })
      .then((blob) => {
        if (!live) return
        const type = /\.webm$/i.test(src) ? 'video/webm' : 'video/mp4'
        objectUrl = URL.createObjectURL(new Blob([blob], { type }))
        setUrl(objectUrl)
      })
      .catch((error: unknown) => {
        console.error(`Help video ${src} could not be loaded: ${error instanceof Error ? error.message : String(error)}`)
      })
    return () => {
      live = false
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl)
    }
  }, [src])
  return (
    <figure className="help-video" style={{ margin: 0 }}>
      <video
        data-testid="help-video"
        data-src={src}
        src={url ?? undefined}
        controls
        playsInline
        preload="metadata"
        aria-label={alt}
        style={{ display: 'block', width: '100%', aspectRatio: '16 / 9', background: 'var(--surface-page)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)' }}
      />
      <figcaption>{alt}</figcaption>
    </figure>
  )
}

/** Opens a Help example project the way Open does, then shows it on the Model screen. */
async function openExample(url: string) {
  if (!await askBeforeReplacingProject('open')) return
  const store = useCamStore.getState()
  const requestId = store.beginProjectOpen()
  let text: string
  try {
    const r = await fetch(url)
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    text = await r.text()
  } catch (error) {
    useCamStore.getState().failProjectOpenRead(requestId, 'error', `${url}: ${error instanceof Error ? error.message : String(error)}`)
    return
  }
  closeHelp()
  const before = useCamStore.getState().project
  await useCamStore.getState().loadProjectFromFile(text, requestId)
  if (useCamStore.getState().project !== before) await useCamStore.getState().enterModelWorkspace()
}

/** A walkthrough: the video with its step list beside it, and "Open this example". */
function Walkthrough({ topic, video, steps }: { topic: HelpTopic; video: { file: string; alt: string }; steps: string[] | null }) {
  useText('app-shell-settings-menus')
  const project = assetUrl(`help/${topic.id}/${video.file.replace(VIDEO_FILE, '.camproject')}`)
  return (
    <div
      className="help-walkthrough"
      data-testid="help-walkthrough"
      style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 3fr) minmax(15rem, 2fr)', gap: 18, alignItems: 'start', margin: '0 0 16px' }}
    >
      <div>
        <HelpVideo src={assetUrl(`help/${topic.id}/${video.file}`)} alt={video.alt} />
        <button
          type="button"
          className="modal-btn modal-btn-primary"
          data-testid="help-open-example"
          data-project={project}
          style={{ marginTop: 10, display: 'inline-flex', alignItems: 'center', gap: 6 }}
          onClick={() => void openExample(project)}
        >
          <FolderOpen size={14} />
          <span>{shellText('HelpCenterModal.openThisExample')}</span>
        </button>
      </div>
      {steps && (
        <ol data-testid="help-walkthrough-steps" style={{ margin: 0 }}>
          {steps.map((step) => <li key={step}>{step}</li>)}
        </ol>
      )}
    </div>
  )
}

/** A topic body: every section in order, a video taking the steps section after it beside it. */
function TopicBody({ topic }: { topic: HelpTopic }) {
  useText('app-shell-settings-menus')
  const parts: ReactNode[] = []
  const sections = topic.sections
  for (let i = 0; i < sections.length; i++) {
    const video = videoOf(sections[i], topic)
    if (video) {
      const next = sections[i + 1]
      const steps = next?.kind === 'steps' ? next.steps : null
      parts.push(<Walkthrough key={i} topic={topic} video={video} steps={steps} />)
      if (steps) i++
      continue
    }
    parts.push(<SectionBlock key={i} section={sections[i]} topic={topic} />)
  }
  return <>{parts}{topic.id === 'keyboard-shortcuts' && <CamShortcutMap />}<EngraveVcarveGuide operation={topic.id} /></>
}

function SectionBlock({ section, topic }: { section: HelpSection; topic: HelpTopic }) {
  useText('app-shell-settings-menus')
  switch (section.kind) {
    case 'paragraph':
      return <p>{section.text}</p>
    case 'steps':
      return (
        <ol>
          {section.steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      )
    case 'tip':
      return <p className="help-tip">{shellText('HelpCenterModal.tip', { text: section.text })}</p>
    case 'warning':
      return <p className="help-warning">{section.text}</p>
    case 'image': {
      const image = topic.images.find((i) => i.slot === section.slot)
      if (!image || image.status !== 'done') return null // debt tracked by the census
      return (
        <HelpFigure src={assetUrl(`help/${topic.id}/${image.file}`)} alt={image.alt} />
      )
    }
    case 'heading':
      return (
        <h3 className="help-heading" data-help-anchor={section.anchor} data-testid={`help-anchor-${section.anchor}`}>
          {section.text}
        </h3>
      )
    case 'table':
      return (
        <div className="help-table-wrap">
          <table className="help-table">
            <thead>
              <tr>
                {section.columns.map((c) => <th key={c}>{c}</th>)}
              </tr>
            </thead>
            <tbody>
              {section.rows.map((row, i) => (
                <tr
                  key={row.anchor ?? i}
                  data-help-anchor={row.anchor}
                  data-testid={row.anchor ? `help-anchor-${row.anchor}` : undefined}
                >
                  {row.cells.map((cell, j) => (
                    j === 0 ? <th key={j} scope="row">{cell}</th> : <td key={j}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
  }
}

/** WO-2759: Help also hosts Help > Report a problem, which keeps its own open
 *  flag so it can sit over Help-as-overlay without replacing the dialog below.
 *  Help is mounted for the app's whole life, so it starts the diagnostic
 *  history too. */
export function HelpCenterModal(props: { onAbout?: () => void; aboutOpen?: boolean }) {
  useEffect(() => { installDiagnostics() }, [])
  return (
    <>
      <HelpCenterDialog {...props} />
      <ReportProblemModal />
    </>
  )
}

function HelpCenterDialog({ onAbout, aboutOpen = false }: { onAbout?: () => void; aboutOpen?: boolean }) {
  useText('app-shell-settings-menus')
  const openExamples = () => { closeHelp(); useProjectPicker.getState().show('examples') }
  const activeModal = useCamStore((s) => s.activeModal)
  const confirmPending = useCamStore((s) => s.confirmDialog !== null)
  // WO-413: a hotlink's requested topic / anchor, and whether Help sits OVER
  // another modal (in which case activeModal is that modal's id, not 'help').
  const requested = useHelpOpen((s) => s.requested)
  const overlay = useHelpOpen((s) => s.overlay)
  const articleRef = useRef<HTMLElement | null>(null)
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string>(DEFAULT_TOPIC_ID)
  const [expanded, setExpanded] = useState<Set<HelpCategoryId>>(new Set())
  const [body, setBody] = useState<HelpTopic | null>(null)
  // Context is SNAPSHOTTED when Help opens - the suggestions describe what
  // the user was doing, and must not reshuffle underneath them.
  const [activeKeys, setActiveKeys] = useState<ContextKey[]>([])
  // HELP-QA-6: the nav pane splits into two tabs so the full category index
  // is a visible entry point (not a scroll-past-the-suggestions discovery).
  // Defaults to Suggested (Operator likes the suggestion system kept prominent)
  // and falls back to All topics when nothing is suggested for the context.
  const [navView, setNavView] = useState<'suggested' | 'all'>('suggested')
  const dialogFocusRef = useDialogFocus<HTMLDivElement>()

  const isOpen = isHelpOpen(activeModal, overlay)
  const index = helpIndex()

  useEffect(() => {
    if (!isOpen) return
    setQuery('')
    const derived = deriveHelpContext(useCamStore.getState())
    const pushed = useHelpContext.getState().pushed
    // The console's Help deep link means "help me with this error" even if
    // the error was already read - force the key so error topics pin first.
    const forced = activeModal === 'help-errors' ? ['error:recent'] : []
    const keys = [...new Set([...forced, ...pushed, ...modelModeKeys(), ...derived])]
    setActiveKeys(keys)
    const suggested = rankTopics(helpIndex(), keys).suggested
    // WO-413: a hotlink names the topic; it wins over the context suggestion.
    const asked = useHelpOpen.getState().requested
    const startId =
      asked && helpIndexEntry(asked.topicId)
        ? asked.topicId
        : activeModal === 'help-errors'
          ? ERROR_TOPIC_ID
          : (suggested[0]?.id ?? DEFAULT_TOPIC_ID)
    setSelectedId(startId)
    // HELP-ALL-TOPICS-INITIAL-COLLAPSE: Suggested owns the initial topic,
    // not the disclosure state of the optional full index. A fresh Help
    // session therefore enters All topics with every category collapsed;
    // choices made after entering that view remain until the modal closes.
    // A hotlinked topic that is not among the suggestions opens the full
    // index with its category expanded, so the nav shows where it lives.
    const askedInSuggested = asked ? suggested.some((e) => e.id === asked.topicId) : false
    const askedCat = asked ? helpIndexEntry(asked.topicId)?.category : undefined
    setExpanded(asked && !askedInSuggested && askedCat ? new Set([askedCat]) : new Set())
    setNavView(suggested.length > 0 && (!asked || askedInSuggested) ? 'suggested' : 'all')
  }, [activeModal, isOpen])

  // WO-413: a hotlink pressed WHILE Help is already open re-selects its topic.
  useEffect(() => {
    if (!isOpen || !requested || !helpIndexEntry(requested.topicId)) return
    setSelectedId(requested.topicId)
  }, [isOpen, requested])

  // WO-413: Escape closes Help (and ONLY Help) - captured at the window so
  // the modal underneath an overlay does not close too. The help-image
  // lightbox has its own capture-phase Escape and wins while it is up.
  // WO-2361: About owns Escape while above Help; retain Help and its editor.
  // WO-2704: the replacement confirm owns Escape too, including Help overlays.
  useEffect(() => {
    if (!isOpen || aboutOpen || confirmPending) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (document.querySelector('.help-image-lightbox')) return
      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()
      closeHelp()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [isOpen, aboutOpen, confirmPending])

  const needle = query.trim().toLowerCase()
  const matches = useMemo(() => {
    if (needle === '') return index
    return index.filter((e) =>
      `${e.title} ${e.summary} ${e.keywords}`.toLowerCase().includes(needle),
    )
  }, [index, needle])

  // The content pane follows the FILTERED list while searching (seed behavior).
  const selected = matches.find((e) => e.id === selectedId) ?? matches[0] ?? null
  const effectiveId = selected?.id ?? null

  const suggestedList = useMemo(
    () => rankTopics(index, activeKeys).suggested,
    [index, activeKeys],
  )

  // Bodies are code-split per category; load whatever is effectively shown.
  useEffect(() => {
    if (!isOpen || effectiveId === null) return
    let stale = false
    void loadTopic(effectiveId).then((topic) => {
      if (!stale) setBody(topic)
    })
    return () => {
      stale = true
    }
  }, [isOpen, effectiveId])

  // WO-413: once the requested topic's body is on screen, scroll to its anchor
  // (a heading or a table row) and mark it so the eye lands on the right row.
  useEffect(() => {
    if (!isOpen || !requested || !body || body.id !== requested.topicId) return
    const root = articleRef.current
    if (!root) return
    // the nav row for the hotlinked topic may sit below the fold of the list
    const navRow = root.parentElement?.querySelector<HTMLElement>('.help-topic-button-active')
    if (navRow && typeof navRow.scrollIntoView === 'function') navRow.scrollIntoView({ block: 'nearest' })
    root.querySelectorAll('.help-anchor-target').forEach((el) => el.classList.remove('help-anchor-target'))
    if (!requested.anchor) {
      root.scrollTop = 0
      return
    }
    const target = root.querySelector<HTMLElement>(`[data-help-anchor="${requested.anchor}"]`)
    if (!target) return
    target.classList.add('help-anchor-target')
    if (typeof target.scrollIntoView === 'function') target.scrollIntoView({ block: 'start' })
  }, [isOpen, requested, body])

  if (!isOpen) return null
  const searching = needle !== ''
  // Only categories that already have topics appear; the full planned tree
  // lives in docs/planning/HELP-WIKI-PLAN.md until backfill lands.
  const populated = HELP_CATEGORIES.filter((c) => index.some((e) => e.category === c.id))

  const pickTopic = (id: string) => {
    setSelectedId(id)
    const cat = helpIndexEntry(id)?.category
    if (cat && !expanded.has(cat)) setExpanded(new Set(expanded).add(cat))
  }

  const toggleCategory = (id: HelpCategoryId) => {
    const next = new Set(expanded)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setExpanded(next)
  }

  const topicRow = (e: { id: string; title: string; summary: string }) => (
    <button
      key={e.id}
      type="button"
      data-testid={`help-topic-${e.id}`}
      className={`help-topic-button${selected?.id === e.id ? ' help-topic-button-active' : ''}`}
      onClick={() => pickTopic(e.id)}
    >
      <span>{e.title}</span>
      <small>{e.summary}</small>
    </button>
  )

  return (
    // CVU-2: REGIME 2 ownership marker (see DisclosureSection.tsx) -- MODAL-
    // GOVERNED scrim in the UI-70 census.
    <div
      className="modal-backdrop"
      data-testid="help-center-backdrop"
      inert={aboutOpen || confirmPending || undefined}
      data-ui78-sanctioned=""
      // The root confirm is painted after Help at the ordinary modal layer.
      // Yield the raised Help layer while it asks, and restore it on Cancel.
      data-help-overlay={overlay && !confirmPending ? 'true' : undefined}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closeHelp()
      }}
    >
      <div
        className="modal-container help-center-modal"
        data-testid="help-center"
        role="dialog"
        aria-modal="true"
        aria-labelledby="help-center-title"
        ref={dialogFocusRef}
      >
        <div className="modal-header">
          <CircleHelp size={15} className="modal-header-icon" />
          <span className="modal-title" id="help-center-title">{shellText('HelpCenterModal.helpAndTroubleshooting')}</span>
          <button type="button" className="modal-close-btn" data-testid="help-center-close" onClick={closeHelp} aria-label={shellText('HelpCenterModal.closeHelp')}>
            <X size={14} />
          </button>
        </div>

        <div style={{ padding: '10px 16px', display: 'flex', gap: 8 }}>
          <button className="modal-btn modal-btn-primary" onClick={openExamples}>Open an example project</button>
          {/* WO-2759: Help > Report a problem. Help closes so the report sits on
              whatever was under it; an overlay's dialog underneath stays put. */}
          <button
            type="button"
            className="modal-btn modal-btn-ghost"
            data-testid="help-report-problem"
            data-tooltip={shellText('HelpCenterModal.reportAProblemTip')}
            onClick={() => { closeHelp(); openReportProblem() }}
          >
            <Bug size={13} /> {shellText('HelpCenterModal.reportAProblem')}
          </button>
        </div>
        {/* WO-2329: Help in a machine-translated language says so, and where a
            correction goes; English shows nothing here. */}
        {(() => {
          const note = machineTranslationNote(i18n.language)
          return note === null ? null : (
            <div className="mform-hint" lang={i18n.language} style={{ padding: '0 16px 6px' }} data-testid="help-machine-translation-note">
              {note}
            </div>
          )
        })()}
        <div className="help-center-search">
          <Search size={14} />
          <input
            type="search"
            data-testid="help-search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={shellText('HelpCenterModal.searchSetupSimulationErrors')}
            aria-label={shellText('HelpCenterModal.searchHelpTopics')}
            autoFocus
          />
        </div>

        <div className="help-center-layout">
          <nav className="help-nav" aria-label={shellText('HelpCenterModal.helpTopics')}>
            <button className="help-cat-row" onClick={openExamples}><FolderOpen size={14} />Open an example project</button>
            {searching ? (
              <div className="help-topic-list-scroll">
                {matches.map(topicRow)}
                {matches.length === 0 && (
                  <div className="help-no-results" data-testid="help-no-results">{shellText('HelpCenterModal.noMatchingQuickHelpTopic')}</div>
                )}
              </div>
            ) : (
              <>
                {/* HELP-QA-6: the suggestion system stays the default view (Operator
                    likes it prominent), but "All topics" is its own always-visible
                    tab - no scrolling required to discover the full index. When
                    nothing is suggested for the current context there is only one
                    view, so the tab strip is skipped entirely. */}
                {suggestedList.length > 0 && (
                  <div className="help-nav-tabs" role="tablist">
                    <button
                      type="button"
                      role="tab"
                      aria-selected={navView === 'suggested'}
                      data-testid="help-nav-tab-suggested"
                      className={`help-nav-tab${navView === 'suggested' ? ' help-nav-tab-active' : ''}`}
                      onClick={() => setNavView('suggested')}
                    >
                      <Sparkles size={12} />
                      <span>{shellText('HelpCenterModal.suggested')}</span>
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={navView === 'all'}
                      data-testid="help-nav-tab-all"
                      className={`help-nav-tab${navView === 'all' ? ' help-nav-tab-active' : ''}`}
                      onClick={() => setNavView('all')}
                    >
                      <span>{shellText('HelpCenterModal.allTopics')}</span>
                      <small className="help-cat-count">{index.length}</small>
                    </button>
                  </div>
                )}
                <div className="help-topic-list-scroll">
                  {navView === 'suggested' && suggestedList.length > 0 ? (
                    <div className="help-cat-group help-suggested-group" data-testid="help-suggested">
                      <div className="help-cat-row help-suggested-head">
                        <Sparkles size={13} />
                        <span>{shellText('HelpCenterModal.suggestedForWhatYouReDoing')}</span>
                      </div>
                      {suggestedList.map(topicRow)}
                      <button
                        type="button"
                        className="help-suggested-seeall"
                        data-testid="help-suggested-seeall"
                        onClick={() => setNavView('all')}
                      >{shellText('HelpCenterModal.seeAllTopics')}</button>
                    </div>
                  ) : (
                    populated.map((cat) => {
                      const catTopics = index.filter((e) => e.category === cat.id)
                      const open = expanded.has(cat.id)
                      return (
                        <div key={cat.id} className="help-cat-group">
                          <button
                            type="button"
                            className="help-cat-row"
                            data-testid={`help-cat-${cat.id}`}
                            aria-expanded={open}
                            onClick={() => toggleCategory(cat.id)}
                          >
                            {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                            <span>{cat.label}</span>
                            <small className="help-cat-count">{catTopics.length}</small>
                          </button>
                          {open && catTopics.map(topicRow)}
                        </div>
                      )
                    })
                  )}
                </div>
              </>
            )}
          </nav>

          <article className="help-topic-content" data-testid="help-topic-content" ref={articleRef}>
            {selected === null ? (
              <>
                <h2>{shellText('HelpCenterModal.noTopicSelected')}</h2>
                <p>{shellText('HelpCenterModal.tryABroaderSearch')}</p>
              </>
            ) : (
              <>
                <h2>{selected.title}</h2>
                <p>{selected.summary}</p>
                {body?.id === selected.id && <TopicBody topic={body} />}
              </>
            )}
          </article>
        </div>

        <div className="help-center-note">
          <span>{shellText('HelpCenterModal.quickGuidanceForCurrentProductWorkflowsNotAnExhaustive')}</span>
          {onAbout && <button type="button" className="modal-btn modal-btn-ghost" onClick={onAbout}>{shellText('HelpCenterModal.aboutLienCAM')}</button>}
        </div>
      </div>
    </div>
  )
}
