import { useEffect, useRef, useState } from 'react'
import { FolderOpen, X } from 'lucide-react'
import { askBeforeReplacingProject, onCamStoreHydrated, useCamStore } from '../../store'
import { assetUrl } from '../../lib/assetUrl'
import { offersStartupExamples } from '../../lib/demoBuild'
import { createSampleMachine } from '../../lib/machine/sampleMachine'
import { shouldPromptMachineChoice } from '../../lib/machine/machineChoice'
import { useDialogFocus } from '../../hooks/useDialogFocus'
import { useText } from '../../i18n'
import { MachineChoiceModal } from './MachineChoiceModal'
import { useUiPrefs } from '../../store/uiPrefs'
import { useProjectPicker } from '../../lib/projectOpen/picker'
import { browseProject } from '../../lib/projectOpen/actions'
import { projectHost, type RecentProject } from '../../lib/projectOpen/host'
import './ProjectPicker.css'

// Vite discovers and ships the actual projects, including kit parts added later.
// Deliberately no broad Sample Parts/Example Projects glob: those contain third-party work.
// One glob per base folder: a multi-pattern glob walks from the patterns'
// common base (the project root) and crawls every gitignored tree there -
// archive/, .planning/ - which hung the main-checkout build (10-13).
const shippedProjects: Record<string, string> = {
  ...import.meta.glob<string>('/examples/**/*.camproject', { eager: true, query: '?url', import: 'default' }),
  ...import.meta.glob<string>('/public/help/form-walkthrough-*/*.camproject', { eager: true, query: '?url', import: 'default' }),
  ...import.meta.glob<string>('/Example Projects/Full Suite.camproject', { eager: true, query: '?url', import: 'default' }),
}

export function demoExampleAssetUrl(path: string, url: string): string {
  // With base './', Vite resolves imported assets via import.meta.url to an
  // absolute URL at runtime. Strip the resolved mount, never prefix './http:'.
  const base = new URL(import.meta.env.BASE_URL, window.location.href)
  const asset = new URL(url, window.location.href)
  const relativePath = path.startsWith('/public/') ? path.slice('/public/'.length)
    : asset.pathname.slice(base.pathname.length) + asset.search
  return assetUrl(relativePath)
}

const pictures = import.meta.glob<string>('../../lib/projectOpen/thumbnails/*.png', { eager: true, query: '?url', import: 'default' })
const fullSuitePath = '/Example Projects/Full Suite.camproject'

export const DEMO_EXAMPLES = Object.entries(shippedProjects).sort(([a], [b]) =>
  Number(b === fullSuitePath) - Number(a === fullSuitePath) || a.localeCompare(b),
).map(([path, url]) => {
  // Show plain names while preserving the on-disk project filenames.
  const file = path.split('/').pop()!.replace(/\.camproject$/, '').replace(/\s+v\d[\d.]*(\s*\(\d{4}-\d{2}-\d{2}\))?$/i, '')
  const label = path === fullSuitePath ? 'Full Suite' : file.replace(/-/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
  const group = path.startsWith('/examples/') ? 'CNC starter kit'
    : path.startsWith('/public/') ? 'Form walkthrough' : 'Sketches, imported parts and models in multiple setups'
  // Keep the catalog page-independent; resolve Vite URLs only in the picker.
  const thumbnail = pictures[`../../lib/projectOpen/thumbnails/${path.split('/').pop()!.replace(/\.camproject$/, '')}.png`]
  return { path, label, group, url, thumbnail }
})

/**
 * The example document the picker hands to Open: the starter machine, and
 * (WO-2861) a file still saved under the new-project default name opens under
 * the name its card shows instead of "Untitled Project".
 */
export function prepareExampleProject(text: string, label: string): string {
  const project = JSON.parse(text)
  project.machine = createSampleMachine()
  const untitled = useCamStore.getInitialState().project.name
  if (typeof project.name !== 'string' || !project.name.trim() || project.name === untitled) project.name = label
  return JSON.stringify(project)
}

/** The production startup seam, mounted by App and exercised without a mock App shell. */
export function ProjectStartupFlow() {
  // The release browser demo and the installed desktop app (WO-2532) offer examples.
  const offer = offersStartupExamples()
  const [hydrated, setHydrated] = useState(false)
  const section = useProjectPicker((s) => s.section)
  const pickerOpen = section !== null
  const [exampleProjectId, setExampleProjectId] = useState<string | null>(null)
  const projectId = useCamStore((s) => s.project.id)
  const projectMachineId = useCamStore((s) => s.project.machine?.id)
  const machineLibrary = useCamStore((s) => s.machineLibrary)
  const required = useCamStore((s) => s.machineChoiceRequired)
  const setRequired = useCamStore((s) => s.setMachineChoiceRequired)

  useEffect(() => onCamStoreHydrated(() => {
    // The initial project gets a new id each boot. A hydrated saved project has
    // its own id, even when empty; never mistake it for a first-time visitor.
    if (offer && useCamStore.getState().project.id === useCamStore.getInitialState().project.id) useProjectPicker.getState().show()
    setHydrated(true)
  }), [offer])

  useEffect(() => {
    if (offer && !hydrated) return
    // An example explicitly chooses the starter machine. Other project opens,
    // restored projects and builds without the picker retain the original machine gate.
    const needs = !pickerOpen && projectId !== exampleProjectId &&
      shouldPromptMachineChoice(useCamStore.getState().project.machine, machineLibrary)
    if (needs && !required) setRequired(true)
    else if (!needs && required) setRequired(false)
  }, [offer, hydrated, pickerOpen, projectId, exampleProjectId, projectMachineId, machineLibrary, required, setRequired])

  return <>
    <MachineChoiceModal />
    {pickerOpen && <DemoExamplePickerModal initialSection={section ?? 'recent'} onExampleOpened={setExampleProjectId} onDismiss={() => useProjectPicker.getState().close()} onOpened={() => {
      useProjectPicker.getState().close()
    }} />}
  </>
}

export function DemoExamplePickerModal({ onDismiss, onOpened, onExampleOpened, initialSection = 'recent' }: {
  onDismiss: () => void
  onOpened: (projectId: string) => void
  onExampleOpened?: (projectId: string) => void
  initialSection?: 'recent' | 'examples'
}) {
  const t = useText('app-shell-settings-menus')
  // WO-2789: this is the existing dismissal, never a project replacement.
  // Offer it as a start choice only while the project has no authored content;
  // loaded models live in modelItems, including the migrated legacy document.
  const startChoice = useCamStore((s) => s.project.geometry.length === 0 &&
    s.project.setups.length === 0 && !s.project.modelItems?.length &&
    !s.project.referenceImages2d?.length && !s.project.nests?.length &&
    s.project.sceneStock.fixedStocks.length === 0)
  const [loading, setLoading] = useState<string | null>(null)
  const lock = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const [recents, setRecents] = useState<RecentProject[]>([])
  const [recentsLoading, setRecentsLoading] = useState(!!projectHost())
  const [section, setSection] = useState(initialSection)
  const [examplesChoice, setExamplesChoice] = useState<boolean | null>(null)
  const direct = useUiPrefs((s) => s.projectOpenDirectly)
  const setDirect = useUiPrefs((s) => s.setProjectOpenDirectly)
  const confirmPending = useCamStore((s) => s.confirmDialog !== null)
  const focusRef = useDialogFocus<HTMLDivElement>()
  const recentRef = useRef<HTMLElement>(null)
  const examplesRef = useRef<HTMLElement>(null)
  const desktop = !!projectHost()
  const examplesExpanded = examplesChoice ?? (initialSection === 'examples' || !desktop || (!recentsLoading && recents.length === 0))
  const examples = DEMO_EXAMPLES.map((example) => ({
    ...example, url: demoExampleAssetUrl(example.path, example.url),
  }))

  useEffect(() => {
    let live = true
    const host = projectHost()
    if (host) void host.recentProjects().then((items) => { if (live) setRecents(items) })
      .catch(() => { if (live) setError('Recent projects could not be read. You can still Browse or open an example.') })
      .finally(() => { if (live) setRecentsLoading(false) })
    return () => { live = false }
  }, [])
  useEffect(() => {
    if (initialSection === 'examples') examplesRef.current?.scrollIntoView?.({ block: 'start' })
  }, [initialSection, recentsLoading])

  async function runOpen(key: string, action: () => Promise<void>) {
    if (lock.current) return
    lock.current = true
    setLoading(key)
    setError(null)
    try { await action() }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { lock.current = false; setLoading(null) }
  }

  async function openExample(example: typeof DEMO_EXAMPLES[number]) {
    await runOpen(example.path, async () => {
      // WO-2704: ask before fetching or starting the replacement lifecycle.
      if (!await askBeforeReplacingProject('open')) return
      const store = useCamStore.getState()
      const requestId = store.beginProjectOpen()
      const before = store.project
      try {
        const response = await fetch(example.url)
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        await useCamStore.getState().loadProjectFromFile(prepareExampleProject(await response.text(), example.label), requestId)
        const opened = useCamStore.getState()
        if (opened.project === before) throw new Error('The example could not be opened. See the console for details.')
        // WO-2014: examples deliberately choose the starter without editing the library.
        opened.setProjectMachine(createSampleMachine())
        onExampleOpened?.(opened.project.id)
        onOpened(opened.project.id)
      } catch (cause) {
        useCamStore.getState().failProjectOpenRead(requestId, 'error', `${example.label}: ${String(cause)}`)
        throw cause
      }
    })
  }
  function openFile(path?: string) {
    void runOpen(path ?? 'browse', async () => {
      const id = await browseProject(path)
      if (id) onOpened(id)
      // Files may have moved since this window opened. Refresh their availability.
      else if (projectHost()) setRecents(await projectHost()!.recentProjects())
    }).then(async () => {
      if (projectHost()) {
        try { setRecents(await projectHost()!.recentProjects()) } catch { /* The actionable read error remains above. */ }
      }
    })
  }
  function jump(next: 'recent' | 'examples') {
    setSection(next)
    if (next === 'examples') setExamplesChoice(true)
    ;(next === 'recent' ? recentRef : examplesRef).current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' })
  }
  const busy = loading !== null
  return <div className="modal-backdrop project-picker-backdrop" data-ui78-sanctioned="" inert={confirmPending || undefined}>
    <div className="modal-container project-picker" role="dialog" aria-modal="true" aria-labelledby="demo-example-title"
      ref={focusRef} onKeyDown={(event) => {
        event.stopPropagation()
        if (event.key === 'Escape' && !busy) onDismiss()
      }}>
      <div className="modal-header">
        <FolderOpen size={16} className="modal-header-icon" />
        <span className="modal-title" id="demo-example-title">Open a project</span>
        <button className="modal-close-btn" aria-label="Close project picker" disabled={busy} onClick={onDismiss}><X size={14} /></button>
      </div>
      <div className="project-picker-tools">
        <div className="project-picker-sections" aria-label="Project sections">
          {desktop && <button className="modal-btn modal-btn-ghost" aria-pressed={section === 'recent'} onClick={() => jump('recent')}>Recent</button>}
          <button className="modal-btn modal-btn-ghost" aria-pressed={section === 'examples' || !desktop} onClick={() => jump('examples')}>Examples</button>
        </div>
        <button className="modal-btn modal-btn-primary project-picker-browse" disabled={busy} onClick={() => openFile()}><FolderOpen size={18} /> Browse...</button>
      </div>
      <div className="modal-body project-picker-body">
        {desktop && <section ref={recentRef} aria-labelledby="recent-projects-heading">
          <h2 id="recent-projects-heading">Recent projects</h2>
          {recentsLoading ? <p>Loading recent projects...</p> : recents.length === 0 ?
            <p className="project-picker-empty">Your projects will appear here after you open or save them. Browse for a file, or explore an example below.</p> :
            <div className="project-recent-grid">{recents.map((item) => <div key={item.path} className={`project-recent${item.missing ? ' project-recent-missing' : ''}`}>
              <button className="project-recent-open" disabled={busy || item.missing} onClick={() => openFile(item.path)} title={item.path}>
                <ProjectPicture src={item.thumbnail} />
                <span className="project-card-copy"><strong>{item.name}</strong>
                  <span className="project-folder">{item.path.replace(/[/\\][^/\\]*$/, '')}</span>
                  <small>{item.missing ? 'File moved or missing' : `Last opened ${new Date(item.openedAt).toLocaleString()}`}</small>
                </span>
              </button>
              <button className="project-remove" disabled={busy} aria-label={`Remove ${item.name} from list`} onClick={() => {
                void runOpen(`remove:${item.path}`, async () => {
                  await projectHost()!.removeRecentProject(item.path)
                  setRecents(await projectHost()!.recentProjects())
                })
              }}>Remove from list</button>
            </div>)}</div>}
        </section>}
        <section ref={examplesRef} aria-labelledby="example-projects-heading">
          <div className="project-examples-heading">
            <h2 id="example-projects-heading">Examples</h2>
            <button className="modal-btn modal-btn-ghost" aria-expanded={examplesExpanded} aria-controls="project-examples-content"
              onClick={() => setExamplesChoice(!examplesExpanded)}>{examplesExpanded ? 'Hide examples' : 'Show examples'}</button>
          </div>
          <div id="project-examples-content" hidden={!examplesExpanded}>
          <p className="project-picker-note">Real projects to explore, using the sample hobby router. Start with Full Suite for a tour of LienCAM.</p>
          <div className="project-example-grid">
            {examples.map((example) => <button key={example.path} className="project-example-card"
              data-example-url={example.url} disabled={busy} onClick={() => void openExample(example)}>
              <ProjectPicture src={example.thumbnail} />
              <span className="project-card-copy"><strong>{example.label}</strong>
                <small>{loading === example.path ? 'Opening...' : example.group}</small>
              </span>
            </button>)}
          </div>
          </div>
        </section>
      </div>
      {error && <p role="alert" className="project-picker-error">{error}</p>}
      <div className="modal-footer project-picker-footer">
        <label><input type="checkbox" checked={direct} onChange={(event) => setDirect(event.target.checked)} /> Always go straight to the file browser</label>
        <div className="project-picker-footer-actions">
          {startChoice && <button className="modal-btn modal-btn-ghost" disabled={busy} onClick={onDismiss}>{t('ProjectPicker.startWithAnEmptyProject')}</button>}
          <button className="modal-btn modal-btn-ghost" disabled={busy} onClick={onDismiss}>Close</button>
        </div>
      </div>
    </div>
  </div>
}
function ProjectPicture({ src }: { src?: string }) {
  return src ? <img className="project-picture" src={src} alt="" loading="lazy" /> :
    <span className="project-picture project-picture-empty"><FolderOpen size={25} /><small>No preview yet</small></span>
}
