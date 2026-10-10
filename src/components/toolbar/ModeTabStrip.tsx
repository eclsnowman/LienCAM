import { textFor, useText } from '../../i18n'
import { Box, Download, Gauge, Layers, MonitorPlay, PenTool, Wrench } from 'lucide-react'
import { Fragment } from 'react'
import { useCamStore } from '../../store'
import { useModelSelectionBridge } from '../../store/modelSelectionBridge'
import { findModelBodyGeometryRow } from '../../lib/cam/modelBodyAdapter'

const shellText = textFor('app-shell-settings-menus')

// UI-77 (D2): the CAM tab order Operator ruled — Setup / Sketch / Toolpath /
// Simulate — with the Model workspace tab injected immediately AFTER Sketch
// (see the render body). Array order is presentation order.
const MODE_TABS = [
  { id: 'setup' as const,      icon: Wrench,      get label() { return shellText('ModeTabStrip.setup') } },
  { id: 'sketch' as const,     icon: PenTool,     get label() { return shellText('ModeTabStrip.sketch') } },
  { id: 'toolpath' as const,   icon: Layers,      get label() { return shellText('ModeTabStrip.toolpath') } },
  { id: 'simulation' as const, icon: MonitorPlay, get label() { return shellText('ModeTabStrip.simulate') } },
]

/** WO-047 (from the approved WO-036 prototype, uix=12): a simple 2-flute
 *  endmill silhouette in Lucide stroke style (3 strokes): shank + tapered
 *  fluted tip, flute shoulder line, one helix flute line. Operator's ruling:
 *  the Tool Library tab wears a cutting tool, NOT a wrench. */
function EndmillIcon({ size = 14 }: { size?: number }) {
  useText('app-shell-settings-menus')
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9 3h6v9l-3 9-3-9z" />
      <path d="M9 12h6" />
      <path d="m9.5 15.5 4.5-2" />
    </svg>
  )
}

interface Props {
  /** Renders the Model workspace tab (UI-77: after Sketch, D2) when true — gated
   *  by the `partWorkspace` flag, read once by App.tsx (this component stays
   *  flag-agnostic; see App.tsx's own doc comment for the flag mechanism). The
   *  flag's INTERNAL name (`partWorkspace`, testid `mode-tab-part`) is kept as an
   *  identifier only; the user-visible label is "Model" (UI-77 D1). */
  showPartTab?: boolean
}

/**
 * Mode tab strip — the single navigation surface for the app's two axes:
 * the CAM view mode (Setup | Sketch | Toolpath | Simulate, drives `viewer.mode`
 * via `setViewerMode`) and, behind the `partWorkspace` flag, the Model
 * workspace tab (offers New Model; confirmation enters through addModelItem,
 * never `setViewerMode`, so entry never trips the sketch-bake side effect).
 *
 * UI-77 order (Operator ruling): Setup / Sketch / Model / Toolpath / Simulate — the
 * Model tab sits immediately after Sketch, default-on (App.tsx opts OUT only on
 * `?partWorkspace=0`).
 *
 * WO-047 (Operator APPROVED the WO-036 design, card Q-CONTROL-LAYOUT-RULES): the
 * strip lives NATIVELY in the top header (TopToolbar), centered — the UI-73
 * floating-chrome portal era is over. Two non-mode tabs join the set here so
 * the header reads as one workflow row:
 *   - Tool Library, LEFTMOST, endmill icon — opens the tool-library modal the
 *     old right-side Tools button opened (a library the user visits, so it
 *     leads the sequence rather than trailing as a utility).
 *   - Post Process, between Simulate and Control — a workflow STAGE (design,
 *     tool-path, simulate, POST, run), not a utility; opens the post modal.
 * The tabs keep one interaction shape, while WO-1153 gives Control a subtle
 * machine-end backing and hairline after the CAM workflow. Clicking any CAM
 * tab also ensures `workspace === 'cam'`, so every CAM tab is a way back from
 * the Model workspace, not just one.
 */
export function ModeTabStrip({ showPartTab = false }: Props) {
  useText('app-shell-settings-menus')
  const viewerMode   = useCamStore((s) => s.viewer.mode)
  const workspace    = useCamStore((s) => s.workspace)
  const setMode      = useCamStore((s) => s.setViewerMode)
  const setWorkspace = useCamStore((s) => s.setWorkspace)
  const openModal    = useCamStore((s) => s.openModal)

  const isPartActive = workspace === 'part'
  const isControlActive = workspace === 'control'
  const isCamActive = workspace === 'cam'

  // The Model workspace tab — same component/classes as a CAM tab, differing only
  // in the store action it dispatches (openModal, not setViewerMode). Rendered
  // inline after the Sketch tab below (UI-77 D2). testid kept as mode-tab-part
  // (internal identifier, D1); the label the user reads is "Model".
  const modelTab = showPartTab ? (
    <button
      key="part"
      data-testid="mode-tab-part"
      className={`mode-tab ${isPartActive ? 'mode-tab-active' : ''}`}
      // WO-2700: plain tab entry always offers creation. Selection and retained
      // editor state belong to explicit Edit Model actions, not this intent.
      // Leave the workspace untouched until confirmation so dismissal is inert.
      onClick={() => openModal('new-model')}
      data-tooltip={shellText('ModeTabStrip.modelMode')}
    >
      <Box size={14} />
      <span>{shellText('ModeTabStrip.model')}</span>
    </button>
  ) : null

  return (
    <nav className="mode-tab-strip">
      {/* WO-047: Tool Library leads the set (Operator round-3 verdict, "Move Tool
          Library left of Setup") — a modal opener, never active-marked. */}
      <button
        data-testid="mode-tab-toollibrary"
        className="mode-tab"
        onClick={() => openModal('tool-library')}
        data-tooltip={shellText('ModeTabStrip.toolLibrary2')}
      >
        <EndmillIcon size={14} />
        <span>{shellText('ModeTabStrip.toolLibrary')}</span>
      </button>
      {MODE_TABS.map(({ id, icon: Icon, label }) => (
        <Fragment key={id}>
          <button
            data-testid={`mode-tab-${id}`}
            className={`mode-tab ${isCamActive && viewerMode === id ? 'mode-tab-active' : ''}`}
            onClick={() => {
              // Coming back from the Model or Control workspace: any CAM tab is
              // a way back (D2.2). The selection bridge below is Model-only.
              if (isControlActive) setWorkspace('cam')
              if (isPartActive) {
                setWorkspace('cam')
                // NAV-BODY-ROW (path 3, select-then-mode-switch): if the
                // Model workspace's tree/body-list has a BODY selected right
                // now (the bridge -- see modelSelectionBridge.ts's own doc
                // comment for why this can't just read component state),
                // resolve it to its CAM Geometry row via the SAME forward
                // lookup the context-menu/inline-icon paths use
                // (findModelBodyGeometryRow) and carry it into
                // viewer.selectedGeometryId. Silently no-ops -- leaving any existing
                // CAM selection untouched -- when nothing is selected, the
                // selection is a non-body DAG node (sketch/feature/datum/
                // parameter/import), or that body has no CAM row yet
                // (unsynced/never-regenerated): never a dead end, per the
                // WO's own "omitted, not disabled" rule.
                const bridge = useModelSelectionBridge.getState()
                if (bridge.selectedBodyId !== null) {
                  const st = useCamStore.getState()
                  const row = findModelBodyGeometryRow(
                    st.project.geometry,
                    bridge.selectedBodyId,
                    bridge.selectedBodyModelItemId,
                  )
                  if (row !== undefined) st.setSelectedGeometry(row.id)
                }
              }
              // NAV-SKETCH-TAB-SELECTION (GEO-UNIFY Stage 5, NAV-PARITY-AUDIT
              // Gap 1): the Sketch tab is selection-aware. A single store action owns
              // the whole decision (direct open for one candidate / a
              // pre-filtered chooser for 2+ / today's plain behavior for no
              // usable selection) — see its own doc comment, store/index.ts.
              if (id === 'sketch') {
                useCamStore.getState().enterSketchWorkspace()
                return
              }
              setMode(id)
            }}
            data-tooltip={shellText('ModeTabStrip.mode', { label: label })}
          >
            <Icon size={14} />
            <span>{label}</span>
          </button>
          {/* UI-77 (D2): Model workspace tab sits immediately AFTER Sketch. */}
          {id === 'sketch' && modelTab}
        </Fragment>
      ))}
      {/* WO-047: Post Process sits between Simulate and Control — a workflow
          stage (design, tool-path, simulate, POST, run), not a right-side
          utility. Modal opener, never active-marked. */}
      <button
        data-testid="mode-tab-postprocess"
        className="mode-tab"
        onClick={() => openModal('post-process')}
        data-tooltip={shellText('ModeTabStrip.generateGCode')}
      >
        <Download size={14} />
        <span>{shellText('ModeTabStrip.postProcess')}</span>
      </button>
      {/* MACHINE-CONTROL: the Control workspace tab closes the workflow —
          design, tool-path, simulate, then RUN it on the machine — so it sits
          last. Same shape as the Model tab: dispatches setWorkspace only,
          never setViewerMode (no sketch-bake side effects). */}
      <button
        key="control"
        data-testid="mode-tab-control"
        className={`mode-tab mode-tab-machine-end ${isControlActive ? 'mode-tab-active' : ''}`}
        onClick={() => setWorkspace('control')}
        data-tooltip={shellText('ModeTabStrip.machineControlMode')}
      >
        <Gauge size={14} />
        <span>{shellText('ModeTabStrip.control')}</span>
      </button>
    </nav>
  )
}
