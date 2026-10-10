import { textFor, useText } from './i18n'
import { TopToolbar } from './components/toolbar/TopToolbar'
import { HelpCenterModal } from './components/modals/HelpCenterModal'
import { AboutModal } from './components/modals/AboutModal'
import { DesignTree } from './components/panels/DesignTree'
import { PropertiesPanel } from './components/panels/PropertiesPanel'
import { PanelResizer } from './components/panels/PanelResizer'
import { BottomConsole } from './components/panels/BottomConsole'
import { Viewport } from './components/viewport/Viewport'
import { ViewportErrorBoundary } from './components/viewport/ViewportErrorBoundary'
import { SetupModal } from './components/modals/SetupModal'
import { MachineLibraryModal } from './components/modals/MachineLibraryModal'
import { ToolLibraryModal } from './components/modals/ToolLibraryModal'
import { NewOperationModal } from './components/modals/NewOperationModal'
import { SketchEntryModal } from './components/modals/SketchEntryModal'
import { ModelEntryModal } from './components/modals/ModelEntryModal'
import { ConfirmModal } from './components/modals/ConfirmModal'
import { MultiBodyImportModal } from './components/modals/MultiBodyImportModal'
import { ImportStockChoiceModal } from './components/modals/ImportStockChoiceModal'
import { SettingsModal } from './components/modals/SettingsModal'
import { ExportModal } from './components/modals/ExportModal'
import { PostProcessModal } from './components/modals/PostProcessModal'
import { NestModal } from './components/modals/NestModal'
import { BooleanMeshDialog } from './components/modals/BooleanMeshDialog'
import { MeshViewerModal } from './components/machine/MeshViewerModal'
import { ProjectStartupFlow } from './components/modals/DemoExamplePickerModal'
import { useCamStore } from './store'
import type { Project } from './types'
import { subscribeToProjectOpenTiming } from './lib/perf/projectOpenTiming'
import { useEffect, useLayoutEffect, useRef, useState, lazy, Suspense } from 'react'
import {
  MACHINE_PANEL_LEFT_DEFAULT,
  MACHINE_PANEL_RIGHT_DEFAULT,
  resolveEffectivePanelWidth,
  resolveUiScale,
  useUiPrefs,
} from './store/uiPrefs'
import { useGlobalShortcuts } from './hooks/useGlobalShortcuts'
import { registerSketchDevSeed } from './lib/sketch/demoSeed'
import { Sketch3dLabPage } from './components/sketch3dlab'
import { MeshLabPage } from './components/meshlab'
import { ThemedTooltip } from './components/ui/ThemedTooltip'
import './theme/tokens.css'
import './styles/app.css'
import './app.css'

const shellText = textFor('app-shell-settings-menus')

// INT-13A (D1, "must not become a universal tax"): a genuine code-split import, not just a
// lazy REACT MOUNT — imported from the concrete file, never the './components/model3d'
// barrel, because that barrel also re-exports mountLab3DPage (main.tsx's own dynamic import
// target for the legacy ?lab3d=1&workbench=1 route). Importing the barrel here would give
// App.tsx a STATIC path to mountLab3DPage.ts too, which defeats main.tsx's dynamic import for
// it (confirmed by vite's own [INEFFECTIVE_DYNAMIC_IMPORT] build warning) and bundles the
// whole workbench — kernel, six-thousand-line component, its deps — into the main chunk for
// every user who never opens the 3D modeling workspace.
const SolidsWorkbenchPage = lazy(() =>
  import('./components/model3d/SolidsWorkbenchPage').then((m) => ({ default: m.SolidsWorkbenchPage })),
)

// MACHINE-CONTROL: the Control workspace (GRBL sender) follows the same
// code-split + retained-mount lifecycle as the Model workbench above - lazy on
// first entry, then hidden rather than unmounted so a live serial connection
// survives tab switches.
const ControlPage = lazy(() =>
  import('./components/machine/ControlPage').then((m) => ({ default: m.ControlPage })),
)

// Dev-only sketch demo seed (window.__seedDemoSketch / __seedConflict) —
// review tooling for Stage 2 rendering before drawing tools exist.
if (import.meta.env.DEV) registerSketchDevSeed()

// Wire the status-bar state label (previously a static "Ready"; see
// docs/UI-ARCHITECTURE.md §9.3): Computing while any op recomputes, a count of
// failed operations while an enabled op is in 'error', Compute pending when an
// enabled op is outdated, otherwise Ready.
// WO-2272: one derivation, exported so a test reads the bar through it.
export function statusBarLabel(s: { project: Pick<Project, 'setups' | 'nests'> }): string {
  let computing = false, failed = 0, outdated = false, degraded = false, modelUnsupported = false
  for (const setup of s.project.setups)
    for (const op of setup.operations) {
      if (op.status === 'computing') computing = true
      // WO-1373: an enabled op whose generation refused is a failure, not
      // "Ready". Ranked directly below Computing so a settled refusal is
      // surfaced above the softer degraded/outdated states. Only enabled ops
      // count (mirrors 'degraded'/'outdated').
      else if (op.enabled && op.status === 'error') failed++
      // CAM-1: a degraded op (referenced model geometry gone) needs attention
      // and cannot simply be recomputed, so it gets its own label ranked above
      // 'Compute pending'. Only enabled ops drive the bar (mirrors 'outdated').
      else if (op.enabled && op.status === 'degraded') degraded = true
      else if (op.enabled && op.status === 'outdated') outdated = true
      // CAM-BINDING Stage 1: a modeled-body source with no Stage 2 compute
      // path - ranked below degraded/outdated (nothing is wrong, it is just
      // waiting on a future stage) but still surfaced, never silently "Ready".
      else if (op.enabled && op.status === 'unsupported') modelUnsupported = true
    }
  // A nest recompute (tree/properties Recompute button) runs in the worker too;
  // surface it in the same Computing state so the status bar is not silent.
  if (!computing)
    for (const nest of s.project.nests ?? [])
      if (nest.status === 'computing') { computing = true; break }
  return computing ? 'Computing...' : failed > 0 ? `${failed} operation${failed === 1 ? '' : 's'} failed`
    : degraded ? 'Model changed'
    : outdated ? 'Compute pending' : modelUnsupported ? 'Model source pending' : 'Ready'
}

// Sketch3d Lab (WO INT-2, M2 gate demo): ?sketch3dlab=1 mounts the standalone precision-sketcher
// lab INSTEAD of the CAM app shell, mirroring main.tsx's own ?lab3d=1/?cam3dDev gate pattern one
// level up the tree (kept here, not in main.tsx, per this WO's ownership manifest). App() itself
// stays hook-free so the branch is a plain component swap, not a conditional hook call.
// Mesh Shop Lab (WO INT-3, M3 gate demo): ?meshlab=1 mounts the standalone STL repair/boolean/
// hollow/export lab the same way, checked first-or-second arbitrarily since the two query params
// are mutually exclusive in practice.
// Model workspace tab (WO INT-13A / UI-77 D3): the Model tab is ON by DEFAULT — the
// `partWorkspace` query param is now only an opt-OUT hatch (`?partWorkspace=0` disables it;
// every other value stays enabled). Same "read the query param at render time, no new flags
// module" mechanism as the two flags above — see INT-13-WORKBENCH-INTEGRATION-SPEC.md 2.2 (D2.1/D2.2).
export default function App() {
  useText('app-shell-settings-menus')
  const params = new URLSearchParams(window.location.search)
  if (params.get('sketch3dlab') === '1') return <Sketch3dLabPage />
  if (params.get('meshlab') === '1') return <MeshLabPage />
  return <CamApp partWorkspaceEnabled={params.get('partWorkspace') !== '0'} />
}

function CamApp({ partWorkspaceEnabled }: { partWorkspaceEnabled: boolean }) {
  useText('app-shell-settings-menus')
  const geometryCount = useCamStore(s => s.project.geometry.length)
  const displayUnits = useCamStore(s => s.appSettings.displayUnits)
  const workspace = useCamStore(s => s.workspace)
  // VIEW-ERRORBOUNDARY: passed to ViewportErrorBoundary as resetKey so switching
  // view tabs (Setup/Sketch/Toolpath/Simulate) auto-retries a caught render error --
  // the "leave the view without a reload" path, since one Viewport instance serves
  // all four modes (docs/UI-ARCHITECTURE.md sec 4).
  const viewerMode = useCamStore(s => s.viewer.mode)
  // WO INT-17C Stage C1 step 6: which Model Item's isolated Editing Space is
  // open (null = the legacy/default single-document context — the existing
  // Model tab keeps working exactly as before). Threaded straight into
  // SolidsWorkbenchPage's own `modelItemId` prop (step 5) so switching items
  // fully remounts to that item's own document.
  const activeModelItemId = useCamStore(s => s.activeModelItemId)

  // INT-13A (D1): SolidsWorkbenchPage mounts lazily the first time the user enters the
  // Part workspace, then stays mounted (retained-and-suspended, section 1.2) — switching
  // back to CAM hides it (display:none below) rather than unmounting it, so re-entering
  // The 3D modeling workspace is instant and its transient state (camera, armed tool, in-progress sketch)
  // survives, matching target 3. The full suspend/resume contract (window listeners, view
  // cube disposal, render-loop detach) is INT-13B's stage; this WO only owns the mount
  // lifecycle itself.
  const [workbenchEverMounted, setWorkbenchEverMounted] = useState(workspace === 'part')
  useEffect(() => {
    if (workspace === 'part') setWorkbenchEverMounted(true)
  }, [workspace])

  // MACHINE-CONTROL: same lazy-then-retained lifecycle for the Control
  // workspace - a live serial session must survive tab switches.
  const [controlEverMounted, setControlEverMounted] = useState(workspace === 'control')
  useEffect(() => {
    if (workspace === 'control') setControlEverMounted(true)
  }, [workspace])

  // WO INT-15 (F-4): the MODAL SUSPEND BOUNDARY for CAM root modals.
  //
  // The modals below (SetupModal, SketchEntryModal, ...) are mounted at App root, OUTSIDE either
  // workspace host's display:none suspend boundary, and each keeps its own window keydown/Escape
  // listener live while open. So a CAM modal opened in CAM and left open across a switch to the
  // Model workspace still answers Escape from the wrong workspace (F-4). The single seam that
  // controls all `activeModal`-gated modals is the store's `activeModal` string, so closing it on
  // a workspace switch unmounts the stranded modal and detaches its listener deterministically.
  //
  // CLOSE-on-switch, not SUSPEND-AND-RESTORE (WO item 4 is a behaviour choice; disclosed):
  //   (1) The only App-level seam is `activeModal`; nulling it UNMOUNTS the modal (each returns
  //       null when closed), so its form state is gone either way -- "restore" would only re-open
  //       a blank modal, giving suspend-and-restore no state-preservation benefit over close here.
  //   (2) settings / tool-library / post-process are openable from the always-visible TopToolbar
  //       in EITHER workspace, so "restore into the workspace it was opened in" is ambiguous; a
  //       blanket restore could resurrect a modal into the wrong workspace.
  // Fires only on a genuine workspace TRANSITION (the ref skips the initial 'cam' mount and any
  // re-render that did not change the axis). MachineChoiceModal is intentionally excluded: it is
  // gated on the separate `machineChoiceRequired` flag, carries no window key listener (no F-4
  // leak), and is a required-choice gate a workspace switch must not silently dismiss.
  const closeModal = useCamStore((s) => s.closeModal)
  const [aboutOpen, setAboutOpen] = useState(false)
  const prevWorkspaceRef = useRef(workspace)
  useEffect(() => {
    if (prevWorkspaceRef.current === workspace) return
    prevWorkspaceRef.current = workspace
    setAboutOpen(false)
    if (useCamStore.getState().activeModal) closeModal()
  }, [workspace, closeModal])

  // Phase 7 (7.3): global CAM shortcuts (G regenerate, Shift+G all, N new op,
  // Delete selected). Guarded against inputs/modals/sketch mode inside the hook.
  useGlobalShortcuts()

  // Default-machine load prompt: when the active project's machine needs an
  // active choice (missing / unknown-id / generic placeholder), raise the
  // transient flag that opens MachineChoiceModal. This single hook covers BOTH
  // cold-start reload (persistMerge restored the project) and loadProjectFromFile
  // -- both land a new project.machine identity here. A project bound to a known,
  // non-generic library machine is honored silently (predicate returns false).
  // Graceful fallback: never prompt when there is no REAL machine to pick - on a
  // fresh install the library holds only the generic placeholder, so forcing a
  // choice would trap the user (the sole option is the generic machine, which
  // re-trips the prompt). shouldPromptMachineChoice encodes that rule.
  // Re-evaluates when the project machine id, the library, or the flag change;
  // the flag clears once the user picks (MachineChoiceModal), avoiding re-open loops.
  // The desktop gate and demo-only first-open picker share this startup seam.

  const statusLabel = useCamStore(statusBarLabel)
  const batch = useCamStore(s => s.toolpathBatch)
  const projectOpen = useCamStore(s => s.projectOpen)
  // Sketch bake feedback (set by finish/exit bake; auto-clears in the store).
  const sketchNotice = useCamStore(s => s.sketchNotice)

  // WO UI-11A writer (a): App status transitions land a console event.
  // Only the edges that matter are logged — entering "Computing..." (info),
  // returning to "Ready" from a compute (success), and entering the WO-1373
  // failure state (error) — "Compute pending" is a static state, not a
  // transition worth logging. Counts come from separate selectors
  // (statusLabel's own selector only returns the label).
  // prevStatusLabelRef starts at null so the FIRST render (mount, not a real
  // transition) never emits.
  const opCount = useCamStore(s =>
    s.project.setups.reduce((n, setup) => n + setup.operations.length, 0))
  // WO-1373: enabled operations that refused to generate. Drives both the
  // failure label and its error-severity console line.
  const failedCount = useCamStore(s =>
    s.project.setups.reduce((n, setup) =>
      n + setup.operations.filter(op => op.enabled && op.status === 'error').length, 0))
  const addConsoleEvent = useCamStore(s => s.addConsoleEvent)
  useEffect(() => subscribeToProjectOpenTiming({
    getSnapshot: () => useCamStore.getState().projectOpen,
    subscribe: (listener) => useCamStore.subscribe((state, previousState) => {
      if (state.projectOpen !== previousState.projectOpen) listener(state.projectOpen)
    }),
  }, {
    // Keep the detached diagnostic sample in every build; phase timing is
    // developer information, so only development adds it to the console.
    emitInfo: (message) => {
      if (import.meta.env.DEV) addConsoleEvent({ severity: 'info', source: 'app', message })
    },
  }), [addConsoleEvent])

  const prevStatusLabelRef = useRef<string | null>(null)
  useEffect(() => {
    const prev = prevStatusLabelRef.current
    if (prev !== null && prev !== statusLabel) {
      if (statusLabel === 'Computing...') {
        addConsoleEvent({
          severity: 'info', source: 'app',
          message: shellText('App.computingOperation', { count: opCount }),
        })
      } else if (statusLabel === 'Ready' && prev === 'Computing...') {
        addConsoleEvent({
          severity: 'success', source: 'app',
          message: shellText('App.readyOperation', { count: opCount }),
        })
      } else if (failedCount > 0 && statusLabel.endsWith('failed')) {
        // WO-1373: an enabled op refused to generate. Never a success line;
        // record the failure on the existing app console channel instead.
        addConsoleEvent({
          severity: 'error', source: 'app',
          message: shellText('App.operationFailed', { count: failedCount }),
        })
      }
    }
    prevStatusLabelRef.current = statusLabel
  }, [statusLabel, opCount, failedCount, addConsoleEvent])

  // P8: persisted panel widths drive the shell layout (survive reload).
  const panelLeftWidth = useUiPrefs(s => s.panelLeftWidth)
  const panelRightWidth = useUiPrefs(s => s.panelRightWidth)
  const panelLeftWidthCustomized = useUiPrefs(s => s.panelLeftWidthCustomized)
  const panelRightWidthCustomized = useUiPrefs(s => s.panelRightWidthCustomized)
  const machineLeftPanelW = useUiPrefs(s => s.machineLeftPanelW)
  const machineLeftPanelWCustomized = useUiPrefs(s => s.machineLeftPanelWCustomized)
  const machineRightPanelW = useUiPrefs(s => s.machineRightPanelW)
  const machineRightPanelWCustomized = useUiPrefs(s => s.machineRightPanelWCustomized)
  const uiScalePreference = useUiPrefs(s => s.uiScale)
  const [displayMetrics, setDisplayMetrics] = useState(() => ({
    cssWidth: window.innerWidth,
    dpr: window.devicePixelRatio || 1,
  }))

  useEffect(() => {
    const syncDisplayMetrics = () => setDisplayMetrics({
      cssWidth: window.innerWidth,
      dpr: window.devicePixelRatio || 1,
    })
    window.addEventListener('resize', syncDisplayMetrics)
    return () => window.removeEventListener('resize', syncDisplayMetrics)
  }, [])

  const uiScale = resolveUiScale(uiScalePreference, displayMetrics.cssWidth, displayMetrics.dpr)
  useLayoutEffect(() => {
    const root = document.documentElement
    root.style.setProperty('--ui-scale', String(uiScale))
    root.dataset.uiScale = String(uiScale)
    return () => {
      root.style.removeProperty('--ui-scale')
      delete root.dataset.uiScale
    }
  }, [uiScale])

  // WO-1154 audit fix: ControlPage writes its persisted px width inline, which
  // otherwise beats the rem stylesheet and freezes the untouched 350px default
  // at 150%. Scale only that default. A pointer change away from the effective
  // default becomes customized and remains byte-for-byte under later scale
  // changes; double-clicking ControlPage back to 350px opts into the default.
  const previousMachineLeftDefaultRef = useRef<number | null>(null)
  useLayoutEffect(() => {
    const previousDefault = previousMachineLeftDefaultRef.current
    const scaledDefault = MACHINE_PANEL_LEFT_DEFAULT * uiScale
    previousMachineLeftDefaultRef.current = scaledDefault

    if (machineLeftPanelWCustomized) {
      if (machineLeftPanelW === MACHINE_PANEL_LEFT_DEFAULT) {
        useUiPrefs.setState({
          machineLeftPanelW: scaledDefault,
          machineLeftPanelWCustomized: false,
        })
      }
      return
    }

    if (
      previousDefault === null
      || machineLeftPanelW === previousDefault
      || machineLeftPanelW === MACHINE_PANEL_LEFT_DEFAULT
    ) {
      if (machineLeftPanelW !== scaledDefault) {
        useUiPrefs.setState({ machineLeftPanelW: scaledDefault })
      }
      return
    }

    useUiPrefs.setState({ machineLeftPanelWCustomized: true })
  }, [machineLeftPanelW, machineLeftPanelWCustomized, uiScale])

  // ControlPage also writes the right rail's persisted width inline. Keep a
  // dragged width verbatim, but let the untouched 280px default participate in
  // root-font scaling so every override and jog control retains its full box.
  const previousMachineRightDefaultRef = useRef<number | null>(null)
  useLayoutEffect(() => {
    const previousDefault = previousMachineRightDefaultRef.current
    const scaledDefault = MACHINE_PANEL_RIGHT_DEFAULT * uiScale
    previousMachineRightDefaultRef.current = scaledDefault

    if (machineRightPanelWCustomized) {
      if (machineRightPanelW === MACHINE_PANEL_RIGHT_DEFAULT) {
        useUiPrefs.setState({
          machineRightPanelW: scaledDefault,
          machineRightPanelWCustomized: false,
        })
      }
      return
    }

    if (
      previousDefault === null
      || machineRightPanelW === previousDefault
      || machineRightPanelW === MACHINE_PANEL_RIGHT_DEFAULT
    ) {
      if (machineRightPanelW !== scaledDefault) {
        useUiPrefs.setState({ machineRightPanelW: scaledDefault })
      }
      return
    }

    useUiPrefs.setState({ machineRightPanelWCustomized: true })
  }, [machineRightPanelW, machineRightPanelWCustomized, uiScale])

  // WO-1494: one authority for "how wide is this panel right now" — App's
  // rendered style and PanelResizer's drag/keyboard/aria math both resolve
  // through resolveEffectivePanelWidth instead of computing their own answer.
  const panelWidthAuthorityInputs = {
    panelLeftWidth, panelLeftWidthCustomized,
    panelRightWidth, panelRightWidthCustomized,
    viewportCssWidth: displayMetrics.cssWidth,
    uiScale,
  }
  const renderedPanelLeftWidth = resolveEffectivePanelWidth('left', panelWidthAuthorityInputs)
  const renderedPanelRightWidth = resolveEffectivePanelWidth('right', panelWidthAuthorityInputs)

  return (
    <div className="app-shell" data-ui-scale={uiScale}>
      {/* WO-047: the mode tabs live natively in the header for EVERY workspace —
          UI-73's floating strip and its per-workspace portal hosts are gone.
          TopToolbar hosts the one shared strip; the Model-tab flag threads
          through it. */}
      <TopToolbar showPartTab={partWorkspaceEnabled} />
      {/* CAM workspace host — always mounted; hidden (not unmounted) while the 3D modeling workspace is
          active so switching back is instant and no CAM state is lost (D1). display:contents
          keeps app-body/BottomConsole/the status footer as direct flex children of app-shell
          when visible. */}
      <div
        data-testid="cam-workspace-host"
        style={{ display: workspace === 'cam' ? 'contents' : 'none' }}
      >
        <div className="app-body">
          <aside className="panel-left" style={{ width: renderedPanelLeftWidth, minWidth: renderedPanelLeftWidth }}>
            <DesignTree />
          </aside>
          <PanelResizer side="left" />
          <main className="app-main">
            {/* INT-13B (spec 3.2): App owns the workspace axis, so App decides
                which host is suspended; Viewport owns the WIRING (it holds the
                CNCViewport instance and the ViewCube call site the contract acts
                on). Note this host stays MOUNTED and merely quiesces -- the
                `display:none` above is presentation, not lifecycle: the CAM
                camera, selection and scene are all still exactly where the
                operator left them (D1/D3.1), which is what makes coming back
                instant and lossless. */}
            {/* ADAPTIVE-VIEW-CRASH follow-up (VIEW-ERRORBOUNDARY): a RENDER-time throw
                anywhere in the viewport subtree (Viewport.tsx's own render/effects, the
                CNCViewport engine, or a child like SimulationPanel) fails loud IN PLACE
                here instead of reaching the app-level ErrorBoundary and tearing down the
                tree/properties/tabs siblings around it. */}
            <ViewportErrorBoundary resetKey={viewerMode}>
              <Viewport suspended={workspace !== 'cam'} />
            </ViewportErrorBoundary>
          </main>
          <PanelResizer side="right" />
          <aside className="panel-right" style={{ width: renderedPanelRightWidth, minWidth: renderedPanelRightWidth }}>
            <PropertiesPanel />
          </aside>
        </div>
        <BottomConsole />
        <footer className="status-bar">
          <span
            className={`status-item${projectOpen ? ' status-project-open' : ''}`}
            role={projectOpen ? 'status' : undefined}
            aria-live={projectOpen ? 'polite' : undefined}
            aria-busy={projectOpen ? true : undefined}
            data-phase={projectOpen?.phase}
            data-testid={projectOpen ? 'project-open-footer' : undefined}
          >
            {projectOpen ? shellText('App.opening', { message: projectOpen.message }) : renderedStatusLabel(statusLabel, failedCount)}
          </span>
          <span className="status-sep">|</span>
          <span className="status-item">{shellText('App.units', { value: displayUnits === 'inch' ? 'in' : 'mm' })}</span>
          <span className="status-sep">|</span>
          <span className={`status-item${geometryCount === 0 ? ' status-error' : ''}`}>
            {geometryCount === 0
              ? shellText('App.noGeometryLoaded')
              : shellText('App.loaded', { count: geometryCount })}
          </span>
          {sketchNotice && (
            <>
              <span className="status-sep">|</span>
              <span className="status-item status-sketch-notice">{sketchNotice}</span>
            </>
          )}
          {batch && (
            <>
              <span className="status-sep">|</span>
              <span className="status-item status-batch">{shellText('App.computingToolpaths', { completed: batch.completed, total: batch.total })}<span className="status-batch-bar">
                  {/* CVU-2: REGIME 2 ownership marker (see
                      DisclosureSection.tsx) -- the footer status bar's own
                      progress fill, positioned within its own bar, not a
                      canvas overlay. */}
                  <span
                    className="status-batch-fill"
                    data-ui78-sanctioned=""
                    style={{ width: `${batch.total > 0 ? (batch.completed / batch.total) * 100 : 0}%` }}
                  />
                </span>
              </span>
            </>
          )}
        </footer>
      </div>

      {/* Model workspace host (INT-13A, D1): lazy-mounted on first ENTRY, retained
          thereafter. Default-on (UI-77 D3) but still lazy. With the opt-out
          `?partWorkspace=0`, `workbenchEverMounted` never turns true (workspace never
          becomes 'part': no tab dispatches setWorkspace), so nothing here mounts (A5). */}
      {partWorkspaceEnabled && workbenchEverMounted && (
        <div
          data-testid="part-workspace-host"
          style={{ display: workspace === 'part' ? 'contents' : 'none' }}
        >
          {/* WO INT-17C Stage C1 step 6 (superseded by GEO-UNIFY-S1b): this
              used to own a floating "Editing: <name> [Finish]" banner here,
              position:absolute over the app-shell. Operator's finding
              (private GEO-UNIFY header-finding capture):
              "looks out of place... does not match visuals or even align",
              plus no rename/new-model affordance from inside the workspace.
              That whole banner is GONE — ModelWorkspaceHeader.tsx now renders
              the equivalent (name + rename + switcher + New model + Finish)
              as a real row INSIDE SolidsWorkbenchPage's own left panel, so it
              is aligned to that panel's width/grid by construction instead of
              floating independently over it. */}
          <Suspense fallback={<div data-testid="part-workspace-loading">{shellText('App.loadingModel')}</div>}>
            {/* INT-13A-R2 (audit major finding): `embedded` makes SolidsWorkbenchPage's root a
                flex child that fills the space below TopToolbar,
                instead of the standalone route's full-viewport fixed root (see the prop's own
                doc comment on SolidsWorkbenchPageProps). modelItemId (step 5): undefined when no
                item is active, so the page keys off LEGACY_MODEL_ITEM_ID exactly as before. */}
            <SolidsWorkbenchPage embedded modelItemId={activeModelItemId ?? undefined} />
          </Suspense>
        </div>
      )}

      {/* Control workspace host (MACHINE-CONTROL): lazy-mounted on first entry,
          retained thereafter - hidden, never unmounted, so the serial session
          and console history survive workspace switches. */}
      {controlEverMounted && (
        <div
          data-testid="control-workspace-host"
          style={{ display: workspace === 'control' ? 'contents' : 'none' }}
        >
          <Suspense fallback={<div data-testid="control-workspace-loading">{shellText('App.loadingControl')}</div>}>
            <ControlPage />
          </Suspense>
        </div>
      )}

      {/* Modals — rendered at root so they appear above everything */}
      <SetupModal />
      <MachineLibraryModal />
      <ToolLibraryModal />
      <NewOperationModal />
      <SketchEntryModal />
      <ModelEntryModal />
      <SettingsModal />
      <ExportModal />
      <HelpCenterModal onAbout={() => setAboutOpen(true)} aboutOpen={aboutOpen} />
      <AboutModal isOpen={aboutOpen} onClose={() => setAboutOpen(false)} />
      <PostProcessModal />
      <NestModal />
      <ProjectStartupFlow />
      <BooleanMeshDialog />
      <MeshViewerModal />
      {/* PROMOTE-SKETCH-FAIL round 2: the ONE themed confirm dialog (on-brand
          replacement for native window.confirm). Store-driven, renders nothing
          when idle. */}
      <ConfirmModal />

      {/* IMPORT-MULTIBODY-CHOICE (Operator Q-76): the multi-body STEP import choice.
          Store-driven, renders nothing unless a multi-body import (or a re-choose)
          is asking the user how the file should land. */}
      <MultiBodyImportModal />

      {/* IMPORT-STOCK-PROMPT: the import-time stock choice. Store-driven, renders
          nothing unless a newly imported part is asking which stock it joins (and
          only when the project has explicit stocks to choose from). */}
      <ImportStockChoiceModal />

      {/* WO B3-2: the ONE shared themed tooltip singleton. Mounted once at the
          app root; it reads data-tooltip="..." off any control app-wide (the
          themed replacement for native title= bubbles) and needs a single
          instance and one listener set for the whole app. */}
      <ThemedTooltip />
    </div>
  )
}

function renderedStatusLabel(value: string, failedCount: number): string {
  switch(value) {
    case "Computing...": return shellText('App.computing')
    case "Model changed": return shellText('App.modelChanged')
    case "Compute pending": return shellText('App.computePending')
    case "Model source pending": return shellText('App.modelSourcePending')
    case "Ready": return shellText('App.ready')
    default: return failedCount > 0 ? shellText('App.failedStatus', { count: failedCount }) : value
  }
}
