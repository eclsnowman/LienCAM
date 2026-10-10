import { useEffect, useState } from 'react'
import { FolderOpen, X } from 'lucide-react'
import { askBeforeReplacingProject, onCamStoreHydrated, useCamStore } from '../../store'
import { assetUrl } from '../../lib/assetUrl'
import { offersStartupExamples } from '../../lib/demoBuild'
import { createSampleMachine } from '../../lib/machine/sampleMachine'
import { shouldPromptMachineChoice } from '../../lib/machine/machineChoice'
import { useDialogFocus } from '../../hooks/useDialogFocus'
import { MachineChoiceModal } from './MachineChoiceModal'

// Vite discovers and ships the actual projects, including kit parts added later.
// Deliberately no broad Sample Parts/Example Projects glob: those contain third-party work.
const shippedProjects = import.meta.glob<string>([
  '/examples/**/*.camproject',
  '/public/help/form-walkthrough-*/*.camproject',
  '/Example Projects/Full Suite.camproject',
], { eager: true, query: '?url', import: 'default' })

export function demoExampleAssetUrl(path: string, url: string): string {
  // With base './', Vite resolves imported assets via import.meta.url to an
  // absolute URL at runtime. Strip the resolved mount, never prefix './http:'.
  const base = new URL(import.meta.env.BASE_URL, window.location.href)
  const asset = new URL(url, window.location.href)
  const relativePath = path.startsWith('/public/') ? path.slice('/public/'.length)
    : asset.pathname.slice(base.pathname.length) + asset.search
  return assetUrl(relativePath)
}

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
  return { path, label, group, url }
})

/** The production startup seam, mounted by App and exercised without a mock App shell. */
export function ProjectStartupFlow() {
  // The release browser demo and the installed desktop app (WO-2532) offer examples.
  const offer = offersStartupExamples()
  const [hydrated, setHydrated] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [exampleProjectId, setExampleProjectId] = useState<string | null>(null)
  const projectId = useCamStore((s) => s.project.id)
  const projectMachineId = useCamStore((s) => s.project.machine?.id)
  const machineLibrary = useCamStore((s) => s.machineLibrary)
  const required = useCamStore((s) => s.machineChoiceRequired)
  const setRequired = useCamStore((s) => s.setMachineChoiceRequired)

  useEffect(() => onCamStoreHydrated(() => {
    // The initial project gets a new id each boot. A hydrated saved project has
    // its own id, even when empty; never mistake it for a first-time visitor.
    setPickerOpen(offer && useCamStore.getState().project.id === useCamStore.getInitialState().project.id)
    setHydrated(true)
  }), [offer])

  useEffect(() => {
    if (offer && !hydrated) return
    // An example explicitly chooses the starter machine. Other project opens,
    // restored projects and builds without the picker retain the original machine gate.
    const needs = !(offer && (pickerOpen || projectId === exampleProjectId)) &&
      shouldPromptMachineChoice(useCamStore.getState().project.machine, machineLibrary)
    if (needs && !required) setRequired(true)
    else if (!needs && required) setRequired(false)
  }, [offer, hydrated, pickerOpen, projectId, exampleProjectId, projectMachineId, machineLibrary, required, setRequired])

  return <>
    <MachineChoiceModal />
    {pickerOpen && <DemoExamplePickerModal onDismiss={() => setPickerOpen(false)} onOpened={(id) => {
      setExampleProjectId(id)
      setPickerOpen(false)
    }} />}
  </>
}

export function DemoExamplePickerModal({ onDismiss, onOpened }: {
  onDismiss: () => void
  onOpened: (projectId: string) => void
}) {
  const [loading, setLoading] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const focusRef = useDialogFocus<HTMLDivElement>()
  const examples = DEMO_EXAMPLES.map((example) => ({
    ...example, url: demoExampleAssetUrl(example.path, example.url),
  }))

  async function openExample(example: typeof DEMO_EXAMPLES[number]) {
    if (loading) return
    setLoading(example.path)
    setError(null)
    // Lock the picker while the confirm/save is pending, before any open
    // lifecycle or fetch can replace the current project. Cancel unlocks it.
    let requestId: number | undefined
    try {
      if (!await askBeforeReplacingProject('open')) return
      const store = useCamStore.getState()
      requestId = store.beginProjectOpen()
      const before = store.project
      const response = await fetch(example.url)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const project = JSON.parse(await response.text())
      project.machine = createSampleMachine()
      await useCamStore.getState().loadProjectFromFile(JSON.stringify(project), requestId)
      const opened = useCamStore.getState()
      if (opened.project === before) throw new Error('The example could not be opened. See the console for details.')
      // Open normally reconciles against the user's library (WO-2014). This
      // demo choice intentionally uses the starter without editing that library.
      opened.setProjectMachine(createSampleMachine())
      onOpened(opened.project.id)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      if (requestId !== undefined) useCamStore.getState().failProjectOpenRead(requestId, 'error', `${example.label}: ${message}`)
      setError(message)
    } finally {
      setLoading(null)
    }
  }

  const busy = loading !== null
  return <div className="modal-backdrop" data-ui78-sanctioned="">
    <div className="modal-container machine-choice-modal" role="dialog" aria-modal="true" aria-labelledby="demo-example-title"
      ref={focusRef} style={{ width: 560, maxHeight: '85vh' }} onKeyDown={(event) => {
        // This startup dialog has no activeModal key; contain global CAM shortcuts.
        event.stopPropagation()
        if (event.key === 'Escape' && !loading) onDismiss()
      }}>
      <div className="modal-header">
        <FolderOpen size={14} className="modal-header-icon" />
        <span className="modal-title" id="demo-example-title">Try an example</span>
        <button className="modal-close-btn" aria-label="Close example picker" disabled={busy} onClick={onDismiss}><X size={14} /></button>
      </div>
      <div className="modal-body machine-choice-body">
        <p className="machine-choice-note">Open a real part to explore LienCAM. Each example uses the sample hobby router.</p>
        <div className="machine-choice-list" style={{ maxHeight: '55vh' }}>
          {examples.map((example) => <button key={example.path} className="machine-choice-item"
            data-example-url={example.url}
            style={{ textAlign: 'left', background: 'var(--bg-panel)', color: 'var(--text-primary)' }}
            disabled={busy} onClick={() => void openExample(example)}>
            <div className="machine-choice-item-main">
              <div className="machine-choice-name">{example.label}</div>
              <div className="machine-choice-meta">{loading === example.path ? 'Opening...' : example.group}</div>
            </div>
          </button>)}
        </div>
        {error && <p role="alert" className="machine-choice-note">{error} You can try again or choose another example.</p>}
      </div>
      <div className="modal-footer machine-choice-footer">
        <button className="modal-btn modal-btn-ghost" disabled={busy} onClick={onDismiss}>Start with an empty project</button>
      </div>
    </div>
  </div>
}
