import { textFor, useText } from '../../i18n'
const tx = textFor('cam-operations-new-operation')
import { useMemo, useState } from 'react'
import { ChevronDown, ChevronUp, Eye, EyeOff, Settings2, X } from 'lucide-react'
import { useCamStore } from '../../store'
import { useUiPrefs } from '../../store/uiPrefs'
import { roleColors, asHex } from '../../theme/viewportColors'
import { sketchHasUserContent } from '../../lib/sketch/sketchAnchors'
import { collectToolpathSections } from '../../lib/cam/nesting/nestRuntime'
import { moveRole } from '../../lib/viewport/toolpathSegments'
import { selectEnabledOperations } from '../../lib/cam/operationSuppression'
import {
  SHORTCUT_KEY_BY_TOOL,
  SHORTCUT_KEY_BY_UTILITY,
} from '../../lib/sketch/tools/shortcuts'

interface Props {
  interactionMode: 'normal' | 'lay-on-face' | 'project-plane'
}

// The 11 toolpath move roles shown in the legend (single source for the list,
// the visible-count badge, and the flyout items).
const LEGEND_ROLES = [
  { role: 'cut',      get label() { return tx('ViewportOverlay.Cut') },      dashed: false },
  { role: 'rapid',    get label() { return tx('ViewportOverlay.Rapid') },    dashed: true  },
  { role: 'helix',    get label() { return tx('ViewportOverlay.Helix') },    dashed: false },
  { role: 'ramp',     get label() { return tx('ViewportOverlay.Ramp') },     dashed: false },
  { role: 'plunge',   get label() { return tx('ViewportOverlay.Plunge') },   dashed: false },
  { role: 'stepover', get label() { return tx('ViewportOverlay.Stepover') }, dashed: false },
  { role: 'fast_traverse', get label() { return tx('ViewportOverlay.Fast_Traverse') }, dashed: false },
  { role: 'wall_follow', get label() { return tx('ViewportOverlay.Wall_Follow') }, dashed: false },
  { role: 'finish',   get label() { return tx('ViewportOverlay.Finish') },   dashed: false },
  { role: 'lead_in',  get label() { return tx('ViewportOverlay.Lead_in') },  dashed: false },
  { role: 'lead_out', get label() { return tx('ViewportOverlay.Lead_out') }, dashed: false },
]

// Curated empty-sketch help, with every displayed key sourced from the same
// maps SketchInteraction dispatches. Labels stay intentionally short so the
// banner remains scannable when it wraps on a narrow viewport.
const SKETCH_EMPTY_HINTS = [
  { key: SHORTCUT_KEY_BY_TOOL.line, get label() { return tx('ViewportOverlay.line') } },
  { key: SHORTCUT_KEY_BY_TOOL['rect-corner'], get label() { return tx('ViewportOverlay.rect') } },
  { key: SHORTCUT_KEY_BY_TOOL['circle-center'], get label() { return tx('ViewportOverlay.circle') } },
  { key: SHORTCUT_KEY_BY_TOOL.spline, get label() { return tx('ViewportOverlay.spline') } },
  { key: SHORTCUT_KEY_BY_TOOL.text, get label() { return tx('ViewportOverlay.text') } },
  { key: SHORTCUT_KEY_BY_TOOL['arc-3pt'], get label() { return tx('ViewportOverlay.arc') } },
  { key: SHORTCUT_KEY_BY_TOOL['smart-dimension'], get label() { return tx('ViewportOverlay.dim') } },
  { key: SHORTCUT_KEY_BY_TOOL.trim, get label() { return tx('ViewportOverlay.trim') } },
  { key: SHORTCUT_KEY_BY_TOOL.split, get label() { return tx('ViewportOverlay.split') } },
  { key: SHORTCUT_KEY_BY_TOOL.offset, get label() { return tx('ViewportOverlay.offset') } },
  { key: SHORTCUT_KEY_BY_TOOL.mirror, get label() { return tx('ViewportOverlay.mirror') } },
  { key: SHORTCUT_KEY_BY_TOOL.extend, get label() { return tx('ViewportOverlay.extend') } },
  { key: SHORTCUT_KEY_BY_TOOL.fillet, get label() { return tx('ViewportOverlay.fillet') } },
  { key: SHORTCUT_KEY_BY_TOOL.chamfer, get label() { return tx('ViewportOverlay.chamfer') } },
  { key: SHORTCUT_KEY_BY_TOOL['pattern-linear'], get label() { return tx('ViewportOverlay.linear_pat') } },
  { key: SHORTCUT_KEY_BY_TOOL['pattern-circular'], get label() { return tx('ViewportOverlay.circular_pat') } },
  { key: SHORTCUT_KEY_BY_TOOL.move, get label() { return tx('ViewportOverlay.move') } },
  { key: SHORTCUT_KEY_BY_TOOL.rotate, get label() { return tx('ViewportOverlay.rotate') } },
  { key: SHORTCUT_KEY_BY_TOOL.scale, get label() { return tx('ViewportOverlay.scale') } },
  { key: SHORTCUT_KEY_BY_UTILITY.measure, get label() { return tx('ViewportOverlay.measure') } },
] as const

export function ViewportOverlay({ interactionMode }: Props) {
  useText('cam-operations-new-operation')
  const viewer = useCamStore((s) => s.viewer)
  const project = useCamStore((s) => s.project)
  const openModal   = useCamStore((s) => s.openModal)
  const hiddenRoles = useCamStore(s => s.viewer.hiddenToolpathRoles)
  const toggleRole  = useCamStore(s => s.toggleToolpathRole)
  const toggleViewerFlag = useCamStore(s => s.toggleViewerFlag)
  // P10: legend collapses to a chip; the expanded state PERSISTS across
  // reloads (uiPrefs, key "liencam-ui-prefs") per Operator's verdict.
  const legendExpanded       = useUiPrefs(s => s.tpLegendExpanded)
  const toggleLegendExpanded = useUiPrefs(s => s.toggleTpLegendExpanded)
  // Empty-state shortcut hint (Stage 6): shown while the active sketch
  // has no entities; the X dismisses it for the rest of the session.
  const sketchEmpty = useCamStore(
    (s) => s.activeSketch !== null && !sketchHasUserContent(s.activeSketch)
  )
  const [hintDismissed, setHintDismissed] = useState(false)

  // Match the viewport's operation/nest selection exactly, then keep only
  // roles that have a real rendered segment. A synthetic rapid joins separate
  // sections in Viewport.tsx, so include Rapid when more than one section is
  // present even if neither operation stored that connector itself.
  const activeLegendRoles = useMemo(() => {
    const setup = project.setups.find(st => st.id === project.activeSetupId)
    if (!setup) return []
    const operations = selectEnabledOperations(
      setup.operations,
      project.activeOperationId,
    )
    const sections = collectToolpathSections(operations, project.geometry, project.nests)
    const present = new Set<string>()
    for (const section of sections) {
      for (const move of section.moves) present.add(moveRole(move))
    }
    if (sections.length > 1) present.add('rapid')
    return LEGEND_ROLES.filter(({ role }) => present.has(role))
  }, [project])
  const visibleLegendRoleCount = activeLegendRoles
    .filter(({ role }) => !hiddenRoles.includes(role))
    .length

  const modeLabels = {
    get setup() { return tx('ViewportOverlay.SETUP') },
    get toolpath() { return tx('ViewportOverlay.TOOLPATH') },
    get simulation() { return tx('ViewportOverlay.SIMULATION') },
    get sketch() { return tx('ViewportOverlay.SKETCH') },
  }

  // Resolved from the shared design tokens so the legend, the CSS, and the
  // 3D scene never drift. Values are identical to the prior literals, except
  // simulation (UI-BRAND-B2-9): the badge borrowed --vp-select-face, the
  // documented "selected face / ramp handle" VIEWPORT-SELECTION token (same
  // hue as picking a face or dragging a gizmo handle), for an unrelated
  // "which mode am I in" label -- the loud saturated orange read as an alert
  // even while nothing was happening (sim idle). Swapped to --accent-amber,
  // the app's existing calm/informational amber (PropertiesPanel computed
  // values, .badge-warning) that carries no viewport-selection duty.
  const modeColors = {
    setup: asHex('--vp-axis-z'),       // #4a90d9
    toolpath: asHex('--role-cut'),     // #00e5ff
    simulation: asHex('--accent-amber'), // #e0a94f
    sketch: asHex('--role-stepover'),  // #44ff88
  }

  return (
    // CVU-2: REGIME 2 ownership marker (see DisclosureSection.tsx) on this
    // layer's OWN root -- covers every child this component renders (mode
    // badge, machine info, axis legend, toolpath legend), all already
    // dispositioned COHESIVE/STRUCTURAL in the UI-70 census.
    <div className="viewport-overlay" data-ui78-sanctioned="">
      {/* Mode badge */}
      <div
        className="viewport-mode-badge"
        style={{ borderColor: modeColors[viewer.mode], color: modeColors[viewer.mode] }}
      >
        {modeLabels[viewer.mode]}
      </div>

      {/* Machine info — click to open machine settings */}
      <div className="viewport-machine-info" onClick={() => openModal('machine-config')} data-tooltip={tx('ViewportOverlay.Machine_settings')}>
        <div className="machine-info-text">
          <span className="machine-name" data-tooltip={project.machine.name}>{project.machine.name}</span>
          <span className="machine-type">{project.machine.type.replace(/_/g, ' ')}</span>
        </div>
        <Settings2 size={12} className="machine-info-icon" />
      </div>

      {/* Selected face info */}
      {viewer.selectedFaceIds.length > 0 && (
        <div className="viewport-selection-info">
          <span>{tx('ViewportOverlay.face_selected', { p1: viewer.selectedFaceIds.length, p2: viewer.selectedFaceIds.length > 1 ? tx('ViewportOverlay.Census_s') : '' })}</span>
        </div>
      )}

      {/* Sketch empty-state hint: one line of tool shortcuts (the keys
          dispatch through lib/sketch/tools/shortcuts.ts), dismissible. */}
      {viewer.mode === 'sketch' && sketchEmpty && !hintDismissed && (
        <div className="sketch-empty-hint">
          <div className="sketch-empty-hint-keys">
            {SKETCH_EMPTY_HINTS.map(({ key, label }, index) => (
              <span key={label}>
                {index > 0 && ', '}
                <kbd>{key}</kbd> {label}
              </span>
            ))}
            <span>{', '}<kbd>Q</kbd>{tx('ViewportOverlay.construction')}<kbd>Esc</kbd>{tx('ViewportOverlay.to_select')}</span>
          </div>
          <button
            className="sketch-empty-hint-dismiss"
            onClick={() => setHintDismissed(true)}
            data-tooltip={tx('ViewportOverlay.Dismiss_hint')}
            aria-label={tx('ViewportOverlay.Dismiss_hint')}
          >
            <X size={14} />
          </button>
        </div>
      )}

      {/* Lay-on-face instruction banner */}
      {interactionMode === 'lay-on-face' && (
        <div className="viewport-mode-banner">
          <span className="viewport-mode-banner-dot" />{tx('ViewportOverlay.Hover_over_a_face_and_click_to_lay_the')}<kbd>Esc</kbd>{tx('ViewportOverlay.to_cancel')}</div>
      )}

      {/* Project-plane instruction banner */}
      {interactionMode === 'project-plane' && (
        <div className="viewport-mode-banner">
          <span className="viewport-mode-banner-dot" />{tx('ViewportOverlay.Projection_mode_follow_the_on_screen_panel')}<kbd>Esc</kbd>{tx('ViewportOverlay.to_cancel')}</div>
      )}

      {/* Axis legend — bottom left */}
      <div className="viewport-axis-legend">
        <div className="axis-item"><span className="axis-dot" style={{ background: asHex('--vp-axis-x') }} />X</div>
        <div className="axis-item"><span className="axis-dot" style={{ background: asHex('--vp-axis-y') }} />Y</div>
        <div className="axis-item"><span className="axis-dot" style={{ background: asHex('--vp-axis-z') }} />Z</div>
      </div>

      {/* Toolpath legend (P10): a single "Legend" chip at rest with a
          visible-role count badge; the flyout contains only move roles used by
          the rendered toolpath. Expanded/collapsed state persists via uiPrefs. */}
      {(viewer.mode === 'toolpath' || viewer.mode === 'simulation') && (
        <div className="tp-legend-wrap">
          {legendExpanded && (
            <div className="tp-legend" data-testid="tp-legend-list">
              <div className="tp-legend-title">{tx('ViewportOverlay.Toolpath')}</div>
              {viewer.mode === 'toolpath' && (
                <label className="tp-legend-item tp-roughing-preview-toggle">
                  <input
                    type="checkbox"
                    data-testid="toggle-roughing-preview"
                    checked={viewer.showRoughingPreview}
                    onChange={() => toggleViewerFlag('showRoughingPreview')}
                  />
                  <span className="tp-legend-label">{tx('ViewportOverlay.Roughing_stock_preview')}</span>
                </label>
              )}
              {/* Colors read from the shared bridge (roleColors) so legend swatches
                  ALWAYS equal the 3D scene's role lines - no hand-copied hex. */}
              {activeLegendRoles.map(({ role, label, dashed }) => {
                const color = roleColors[role]
                const hidden = hiddenRoles.includes(role)
                return (
                  <div
                    key={role}
                    className={`tp-legend-item tp-legend-toggle${hidden ? ' tp-legend-hidden' : ''}`}
                    onClick={() => toggleRole(role)}
                    data-tooltip={hidden ? tx('ViewportOverlay.Show', { p1: label }) : tx('ViewportOverlay.Hide', { p1: label })}
                  >
                    <span
                      className="tp-legend-line"
                      style={dashed
                        ? { width: 22, height: 0, borderBottom: `2px dashed ${color}`, display: 'inline-block', opacity: hidden ? 0.2 : 1 }
                        : { width: 22, height: 2, background: color, display: 'inline-block', borderRadius: 1, opacity: hidden ? 0.2 : 1 }
                      }
                    />
                    <span className="tp-legend-label">
                      {label}
                    </span>
                    <span className="tp-legend-eye">
                      {hidden ? <EyeOff size={10} /> : <Eye size={10} />}
                    </span>
                  </div>
                )
              })}
            </div>
          )}
          <button
            className="tp-legend-chip"
            data-testid="tp-legend-chip"
            onClick={toggleLegendExpanded}
            data-tooltip={legendExpanded
              ? tx('ViewportOverlay.Collapse_toolpath_legend')
              : tx('ViewportOverlay.Expand_toolpath_legend_of_move_types_visible', { p1: visibleLegendRoleCount, p2: activeLegendRoles.length })}
          >
            <span className="tp-legend-chip-text">{tx('ViewportOverlay.Legend')}</span>
            <span
              className="badge badge-accent badge-counter"
              data-testid="tp-legend-chip-badge"
            >
              {visibleLegendRoleCount}
            </span>
            {legendExpanded ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
          </button>
        </div>
      )}
    </div>
  )
}
