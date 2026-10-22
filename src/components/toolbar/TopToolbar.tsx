import { textFor, useText } from '../../i18n'
import { useRef, useEffect, useLayoutEffect, useState, useSyncExternalStore } from 'react'
import {
  FilePlus, FolderOpen, Save, Download,
  Settings, Undo2, Redo2, CircleHelp, Info, LoaderCircle, Bot,
} from 'lucide-react'
import { askBeforeReplacingProject, useCamStore } from '../../store'
import { openExportWindow } from '../../lib/exportCenter'
import { mcpServerHost, type McpServerState, useUiPrefs } from '../../store/uiPrefs'
import { useProjectPicker } from '../../lib/projectOpen/picker'
import { browseProject } from '../../lib/projectOpen/actions'
import { GIT_COMMIT } from '../../version'
import {
  getPartWorkspaceHistory,
  resolveActiveWorkspaceHistory,
  subscribePartWorkspaceHistory,
} from '../../lib/workspace/activeWorkspaceHistory'
import { ModeTabStrip } from './ModeTabStrip'
import { MachineStatusChip } from './MachineStatusChip'

const shellText = textFor('app-shell-settings-menus')

/** WO-3010: the MCP server's state as Electron main reports it; null in a browser. */
function useMcpServerState(): McpServerState | null {
  const [state, setState] = useState<McpServerState | null>(null)
  useEffect(() => {
    const host = mcpServerHost()
    if (host === undefined) return undefined
    let active = true
    void host.getState().then((s) => { if (active && s) setState(s) }).catch(() => undefined)
    const off = host.onState((s) => setState(s))
    return () => { active = false; off() }
  }, [])
  return state
}

/** Free width (px) the header's two flexible sections have left, ignoring the indicator. */
function headerFreeWidth(header: HTMLElement): number {
  let free = 0
  for (const section of header.querySelectorAll<HTMLElement>(':scope > .toolbar-section')) {
    const items = [...section.children].filter((child) => (child as HTMLElement).dataset.mcpCompact === undefined && getComputedStyle(child).position !== 'absolute')
    if (items.length === 0) continue
    const box = section.getBoundingClientRect()
    free += section.classList.contains('toolbar-section-right')
      ? items[0].getBoundingClientRect().left - box.left
      : box.right - items[items.length - 1].getBoundingClientRect().right
  }
  return free
}

/** Shows that MCP clients can edit the model, and which client last connected.
 *  The header has no slack at some supported widths (1440 px keeps every label
 *  with ~1 px to spare), so where the full "MCP: <client>" does not fit it shrinks
 *  to a badge on the About button's corner that takes no width; the client's
 *  name stays in its tooltip and accessible name. */
function McpServerIndicator() {
  const state = useMcpServerState()
  const ref = useRef<HTMLDivElement>(null)
  const fullWidth = useRef(0)
  const [compact, setCompact] = useState(false)
  const running = state !== null && state.running
  const clientName = state?.clientName ?? null
  const text = clientName === null
    ? shellText('TopToolbar.mcpOn')
    : shellText('TopToolbar.mcpConnected', { client: clientName })
  useLayoutEffect(() => {
    const el = ref.current
    const header = el?.closest('header')
    if (!running || !el || !header) return undefined
    const check = () => {
      if (!compact) {
        fullWidth.current = el.getBoundingClientRect().width + 2
        if (header.scrollWidth > header.clientWidth) setCompact(true)
      } else if (fullWidth.current > 0 && headerFreeWidth(header) >= fullWidth.current) {
        setCompact(false)
      }
    }
    check()
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(check)
    resize?.observe(header)
    return () => resize?.disconnect()
  }, [running, compact, text])
  if (!running) return null
  const common = {
    role: 'status',
    'data-testid': 'toolbar-mcp-indicator',
    'data-client': clientName ?? '',
    'data-compact': compact ? 'true' : 'false',
    'data-tooltip': `${text}. ${shellText('TopToolbar.mcpTooltip')}`,
    'aria-label': text,
    title: text,
  }
  if (compact) {
    // Zero width in the row (the -2px cancels the section's gap); the badge sits on About's corner.
    return (
      <div ref={ref} data-mcp-compact="" style={{ position: 'relative', width: 0, height: 28, marginLeft: -2, flexShrink: 0 }}>
        <div {...common} style={{ position: 'absolute', right: 2, top: 1, display: 'inline-flex', padding: 1, borderRadius: 4, background: 'var(--bg-panel)', color: 'var(--accent)', lineHeight: 0 }}>
          <Bot size={11} aria-hidden="true" />
        </div>
      </div>
    )
  }
  return (
    <div
      ref={ref}
      {...common}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '0 6px', fontSize: 11, color: 'var(--text-secondary)', flexShrink: 0 }}
    >
      <Bot size={13} aria-hidden="true" style={{ flexShrink: 0, color: 'var(--accent)' }} />
      <span style={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{text}</span>
    </div>
  )
}

interface Props {
  /** WO-047: the mode tabs live in this header now, so the Model-tab flag
   *  (read once from the URL by App.tsx, D3 default-ON) threads through here
   *  to the strip. */
  showPartTab?: boolean
  onAbout?: () => void
}

export function TopToolbar({ showPartTab = false, onAbout }: Props) {
  useText('app-shell-settings-menus')
  const headerRef = useRef<HTMLElement>(null)
  useLayoutEffect(() => {
    const header = headerRef.current!
    // WO-2330: viewport breakpoints alone cannot predict translated text or
    // font metrics. Reuse the icon/tooltip command treatment only as needed.
    // Reset first so widening or a shorter status/language restores labels.
    const fit = () => {
      delete header.dataset.fit
      if (header.scrollWidth <= header.clientWidth) return
      header.dataset.fit = 'utilities'
      if (header.scrollWidth > header.clientWidth) header.dataset.fit = 'commands'
    }
    fit()
    // Component tests and embedded hosts may not expose these browser APIs.
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fit)
    resize?.observe(header)
    const content = new MutationObserver(fit)
    content.observe(header, { subtree: true, childList: true, characterData: true })
    document.fonts?.addEventListener('loadingdone', fit)
    return () => {
      resize?.disconnect()
      content.disconnect()
      document.fonts?.removeEventListener('loadingdone', fit)
    }
  }, [])
  const newProject  = useCamStore((s) => s.newProject)
  const saveProject = useCamStore((s) => s.saveProjectToFile)
  const loadProject = useCamStore((s) => s.loadProjectFromFile)
  const beginProjectOpen = useCamStore((s) => s.beginProjectOpen)
  const failProjectOpenRead = useCamStore((s) => s.failProjectOpenRead)
  const projectOpen = useCamStore((s) => s.projectOpen)
  const openModal   = useCamStore((s) => s.openModal)
  const undo        = useCamStore((s) => s.undo)
  const redo        = useCamStore((s) => s.redo)
  const canUndo     = useCamStore((s) => s.canUndo)
  const canRedo     = useCamStore((s) => s.canRedo)
  const sketchActive = useCamStore((s) => s.activeSketch !== null)
  // WO INT-13C (D5.3 rule 3 / D5.4): this bar renders ABOVE both workspace hosts (App.tsx:202)
  // and is visible in BOTH, so "which history do I mean?" is now a real question it has to ask.
  const workspace   = useCamStore((s) => s.workspace)

  // WO-1259: report the provenance THIS bundle was compiled with, so the desktop
  // shell can compare the renderer inputs' contents against the revision the code
  // now on screen was actually built from. A timestamp cannot do this: the machine
  // seat read a newer `dist` as proof it contained a fix it did not contain.
  useEffect(() => {
    type RendererBuildStatus = { state: 'current' | 'stale' | 'missing' | 'unknown'; message: string | null }
    type RendererBuildProvenance = { commit: string }
    type RendererBuildHost = { rendererBuildStatus?: (provenance: RendererBuildProvenance) => Promise<RendererBuildStatus> }
    const host = (globalThis as typeof globalThis & { liencamHost?: RendererBuildHost }).liencamHost
    if (typeof host?.rendererBuildStatus !== 'function') return
    let active = true
    void host.rendererBuildStatus({ commit: GIT_COMMIT }).then((status) => {
      if (!active || (status.state !== 'stale' && status.state !== 'unknown') || !status.message) return
      const store = useCamStore.getState()
      if (store.consoleEvents.some((event) => event.source === 'build' && event.message === status.message)) return
      store.addConsoleEvent({ severity: 'warning', source: 'build', message: status.message })
    }).catch((error: unknown) => {
      if (!active) return
      const detail = error instanceof Error ? error.message : String(error)
      const message = shellText('TopToolbar.lienCAMCouldNotVerifyWhetherThisBuildMatchesThe', { detail: detail })
      const store = useCamStore.getState()
      if (!store.consoleEvents.some((event) => event.source === 'build' && event.message === message)) {
        store.addConsoleEvent({ severity: 'warning', source: 'build', message })
      }
    })
    return () => { active = false }
  }, [])

  const projectInputRef = useRef<HTMLInputElement>(null)

  // WO-2698 (10-09): New never throws away unsaved work without asking.
  // A project that matches what was last opened, started or saved goes
  // straight to New. Otherwise (changed, or restored at startup so nobody
  // knows) the themed confirm asks Save / Discard / Cancel. Save runs the
  // ordinary Save and starts the new project only when the file was written
  // AND nothing changed while it was being written; a cancelled or failed save
  // (already reported by Save itself) keeps the whole project.
  const newProjectAskingToSave = async () => {
    if (await askBeforeReplacingProject('new')) newProject()
  }

  // WO INT-13C (D5.4): the Model workspace's history, published by its host while that host is
  // active (SolidsWorkbenchPage). null whenever no Part host owns one -- including the whole
  // time the operator is in CAM, which is the overwhelmingly common case.
  const partHistory = useSyncExternalStore(
    subscribePartWorkspaceHistory,
    getPartWorkspaceHistory,
    getPartWorkspaceHistory,
  )
  const activeHistory = resolveActiveWorkspaceHistory(workspace, { undo, redo, canUndo, canRedo }, partHistory)
  const camSketchActive = workspace === 'cam' && sketchActive
  const redoTitle = activeHistory?.canRedo === true
    ? (camSketchActive ? shellText('TopToolbar.redoSketchEditCtrlShiftZ') : shellText('TopToolbar.redoCtrlShiftZ'))
    : (camSketchActive ? shellText('TopToolbar.nothingToRedoInThisSketch') : shellText('TopToolbar.nothingToRedo'))

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // WO INT-13C (D5.3 RULE 3), the guard that makes D5.2 safe. Before INT-13C this listener
      // was registered globally regardless of what was on screen, relying ENTIRELY on the
      // workbench's capture listener to stop it. D5.2 removes that listener while the Part
      // workspace is suspended -- so with no guard here, nothing would stop this one firing CAM
      // project undo while the operator is in the Model workspace. That is a defect D5.2 would
      // otherwise INTRODUCE, which is why the two ship in one stage (spec lines 1177-1183); face
      // (a) of the mirror defect is exactly this line being absent.
      //
      // Rule 3 is LAST RESORT in the dispatch table, so it is a guard here rather than a
      // registration change (contrast the Part host, which must have no listener at all when
      // suspended, D5.2): TopToolbar is shared chrome that is never itself suspended, and
      // "am I the active workspace?" is precisely the flag question rule 3 states.
      if (workspace !== 'cam') return
      // WO INT-13C (D5.3 RULE 1) -- native text editing always wins, in BOTH workspaces.
      //
      // THE DEFECT THIS FIXES, found by this WO's own rule-1 interleave test rather than by
      // reading: the spec asserts (line 1172) that rule 1 "is already implemented identically by
      // both listeners (SolidsWorkbenchPage.tsx:5365, and TopToolbar INHERITS IT VIA
      // defaultPrevented)". That inheritance does not exist. The workbench's rule-1 path RETURNS
      // WITHOUT calling preventDefault -- correctly, since claiming a chord it is declining would
      // be worse -- so `defaultPrevented` is false and there has never been anything here to
      // inherit. Before this line, Ctrl+Z typed into ANY CAM text field fired a CAM project undo
      // and preventDefault()ed the browser's native field undo. That is pre-existing on main, not
      // introduced by D5.2; D5.2 is simply what made it testable, because AC4 asks the question in
      // both workspaces and the CAM leg is where it fails.
      //
      // Implemented by the same predicate the workbench uses, deliberately identical: rule 1 is
      // the one rule that holds regardless of workspace, so the two owners must not drift.
      const target = e.target as HTMLElement | null
      if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable === true) return
      // WO SKC-15C-R1 (B2, disclosed shortcut-scoping): if another mount has already CLAIMED this
      // chord (the workbench's capture-phase Ctrl+Z owner calls preventDefault + stopImmediatePropagation
      // before this bubble listener can run), do not ALSO fire CAM's project undo -- the double-fire the
      // S3 gate audit flagged. `defaultPrevented` is a second, order-independent net behind that
      // stopImmediatePropagation: even a capture owner that only preventDefaults is respected here.
      if (e.defaultPrevented) return
      const key = e.key.toLowerCase()
      if ((e.ctrlKey || e.metaKey) && key === 'z' && !e.shiftKey) {
        e.preventDefault()
        undo()
      } else if ((e.ctrlKey || e.metaKey) &&
        ((key === 'z' && e.shiftKey) || (key === 'y' && !e.shiftKey))) {
        e.preventDefault()
        redo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [redo, undo, workspace])

  const handleLoadProject = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    // Reset before awaiting: choosing the same file after Cancel must work.
    e.target.value = ''
    if (!await askBeforeReplacingProject('open')) return
    const requestId = beginProjectOpen()
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result !== 'string') {
        failProjectOpenRead(requestId, 'error', shellText('TopToolbar.theBrowserReturnedAnUnreadableResult'))
        return
      }
      void loadProject(reader.result, requestId)
    }
    reader.onerror = () => {
      const detail = reader.error?.message ?? shellText('TopToolbar.unknownBrowserFileReadError')
      failProjectOpenRead(requestId, 'error', detail)
    }
    reader.onabort = () => {
      failProjectOpenRead(requestId, 'abort')
    }
    reader.readAsText(file)
  }

  // WO-047 (approved WO-036 design, card Q-CONTROL-LAYOUT-RULES): the header
  // is the app's one navigation row — left: logo + file commands; CENTER: the
  // mode tab strip sitting flat on the header surface (Tool Library / Setup /
  // Sketch / Model / Toolpath / Simulate / Post Process / Control); right:
  // Undo/Redo (outside Control), Settings, Help, then the shared machine chip.
  // Tools and Post Process left the right side — both are tabs in the central
  // strip now.
  return (
    <header ref={headerRef} className="top-toolbar" aria-busy={projectOpen !== null}>
      <div className="toolbar-section toolbar-section-left">
      {/* Brand — the name alone. WO-290 (Operator, MC note 2026-08-12): a generic
          processor glyph from the icon set used to sit here in a blue tile.
          "What does this computerchip looking logo even mean? Remove it. It is
          not my logo, that is visible in the bootscreen. Just make LienCAM text
          here bigger." So the corner is the wordmark and nothing else — do not
          reintroduce an icon, mark or glyph beside it. */}
      <div className="toolbar-brand">
        {/* WO-268: the product is LienCAM. The <em> split is the existing
            two-tone treatment (.brand-name em = accent), and it matches the
            boot splash wordmark in index.html: LienCAM prefix + accented CAM. */}
        <span className="brand-name">{shellText('TopToolbar.li', { value: 'en' })}<em>{shellText('TopToolbar.cAM')}</em></span>
      </div>

      {/* File menu group */}
      <div className="toolbar-group">
        <button
          className="tb-btn"
          // B14: newProject() itself now drives the viewport reload (the SAME
          // reloadProjectScene seam loadProjectFromFile uses), so this button
          // no longer needs to poke window.__cncViewport as a manual side
          // effect -- that was the fragile, single-call-site fix that left
          // every OTHER caller of newProject() with a stale viewport mesh.
          onClick={() => void newProjectAskingToSave()}
          // WO-1833 (BUG-546): app.css hides the label spans below 1525/1365px,
          // and display:none text drops out of the accessible-name computation,
          // so the tooltip string must also be the aria-label. House pattern:
          // NumericInput.tsx's aria-label={ariaLabel ?? tooltip}.
          data-tooltip={shellText('TopToolbar.newProject')}
          aria-label={shellText('TopToolbar.newProject')}
        >
          <FilePlus size={14} />
          <span>{shellText('TopToolbar.new')}</span>
        </button>
        <button
          className="tb-btn"
          onClick={() => {
            if (!useUiPrefs.getState().projectOpenDirectly) useProjectPicker.getState().show()
            else void browseProject().catch((error: unknown) => useCamStore.getState().addConsoleEvent({ source: 'project', severity: 'error', message: String(error) }))
          }}
          data-tooltip={shellText('TopToolbar.openProject')}
          aria-label={shellText('TopToolbar.openProject')}
        >
          <FolderOpen size={14} />
          <span>{shellText('TopToolbar.open')}</span>
        </button>
        <button className="tb-btn" onClick={saveProject} data-tooltip={shellText('TopToolbar.saveProject')} aria-label={shellText('TopToolbar.saveProject')}>
          <Save size={14} />
          <span>{shellText('TopToolbar.save')}</span>
        </button>
        <button className="tb-btn" onClick={() => openExportWindow()} data-tooltip={shellText('TopToolbar.export')} aria-label={shellText('TopToolbar.export')}>
          <Download size={14} />
          <span>{shellText('TopToolbar.export')}</span>
        </button>
      </div>
      </div>

      {/* Center — the mode tabs, flat on the header surface (no pill
          container); the active tab wears the standard bottom-accent
          underline on the header's bottom edge (app.css .header-mode-tabs). */}
      <div className="header-mode-tabs">
        <ModeTabStrip showPartTab={showPartTab} />
      </div>

      <div className="toolbar-section toolbar-section-right">
      {/* Undo — WO INT-13C (D5.4): delegates to the ACTIVE workspace's history, so this button
          and Ctrl+Z are two paths to the SAME value rather than two behaviors. In the Model
          workspace both land on the workbench's CommandHistory (literally the same handleUndo
          function object the capture listener calls); in CAM both land on the project snapshot
          history. `activeHistory` is null only when the Model workspace is active and its host
          has not published yet (it mounts lazily) -- the buttons disable rather than falling
          back to CAM, because a CAM undo fired from the Model workspace is the defect. */}
      {workspace !== 'control' && (
        <>
          <div className="toolbar-group">
            <button
              className="tb-btn"
              onClick={() => activeHistory?.undo()}
              disabled={activeHistory?.canUndo !== true}
              data-tooltip={shellText('TopToolbar.undoCtrlZ')}
              aria-label={shellText('TopToolbar.undoCtrlZ')}
            >
              <Undo2 size={14} />
              <span>{shellText('TopToolbar.undo')}</span>
            </button>
            <button
              className="tb-btn"
              onClick={() => activeHistory?.redo()}
              disabled={activeHistory?.canRedo !== true}
              data-tooltip={redoTitle}
              aria-label={redoTitle}
            >
              <Redo2 size={14} />
              <span>{shellText('TopToolbar.redo')}</span>
            </button>
          </div>

          <div className="toolbar-sep" />
        </>
      )}

      {/* Settings */}
      <div className="toolbar-group">
        <button
          className="tb-btn"
          onClick={() => openModal('settings')}
          data-tooltip={shellText('TopToolbar.applicationSettings')}
          aria-label={shellText('TopToolbar.applicationSettings')}
        >
          <Settings size={14} />
          <span>{shellText('TopToolbar.settings')}</span>
        </button>
      </div>

      <div className="toolbar-group">
        <button
          className="tb-btn"
          data-testid="toolbar-help"
          onClick={() => openModal('help')}
          data-tooltip={shellText('TopToolbar.helpAndTroubleshooting')}
          aria-label={shellText('TopToolbar.helpAndTroubleshooting')}
        >
          <CircleHelp size={14} />
          <span>{shellText('TopToolbar.help')}</span>
        </button>
        <button className="tb-btn" onClick={onAbout} aria-label="About LienCAM" data-tooltip="About LienCAM">
          <Info size={14} /><span>About</span>
        </button>
      </div>

      <McpServerIndicator />
      <MachineStatusChip />
      </div>

      {projectOpen && (
        <div
          className="project-open-indicator"
          role="status"
          aria-live="polite"
          data-phase={projectOpen.phase}
          data-testid="project-open-indicator"
        >
          <LoaderCircle className="project-open-spinner" size={14} aria-hidden="true" />
          <strong>{shellText('TopToolbar.opening')}</strong>
          <span>{projectOpen.message}</span>
        </div>
      )}

      {/* Hidden file input for project open */}
      <input
        ref={projectInputRef}
        type="file"
        accept=".camproject"
        style={{ display: 'none' }}
        onChange={handleLoadProject}
      />
    </header>
  )
}
