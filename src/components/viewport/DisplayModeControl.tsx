import { textFor, useText } from '../../i18n'
const tx = textFor('cam-operations-new-operation')
import { useState, useEffect, useRef } from 'react'
import type { ShadingMode, SectionAxis } from '../../types'
import { useCamStore } from '../../store'
import { NumericInput } from '../ui/NumericInput'
import { unitLabel } from '../../lib/ui/unitFormat'

export const CAM_SECTION_MIN = -200
export const CAM_SECTION_MAX = 200

// Display-view glyph: a 3D cube (each visible face a slightly different dark tone
// for depth) with a gear at the bottom-right, signalling "view / display
// settings". Cube outlines + gear use currentColor (so they inherit the control's
// view-cube-label blue + glow + hover brighten); the three face fills use mode-aware
// tokens for the 3D shading. The gear is a solid currentColor cog with a
// punched (evenodd) center hole.
function CubeGearIcon({ size = 26 }: { size?: number }) {
  useText('cam-operations-new-operation')
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.3}
      strokeLinejoin="round"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M8,2 L14.5,5.2 L8,8.4 L1.5,5.2 Z" fill="var(--vp-display-top)" />
      <path d="M1.5,5.2 L8,8.4 L8,14.9 L1.5,11.7 Z" fill="var(--vp-display-left)" />
      <path d="M14.5,5.2 L14.5,11.7 L8,14.9 L8,8.4 Z" fill="var(--vp-display-right)" />
      <path
        fill="currentColor"
        stroke="none"
        fillRule="evenodd"
        d="M17.15,15.66 L17.41,14.23 L18.99,14.23 L19.25,15.66 L20.45,14.83 L21.57,15.95 L20.74,17.15 L22.17,17.41 L22.17,18.99 L20.74,19.25 L21.57,20.45 L20.45,21.57 L19.25,20.74 L18.99,22.17 L17.41,22.17 L17.15,20.74 L15.95,21.57 L14.83,20.45 L15.66,19.25 L14.23,18.99 L14.23,17.41 L15.66,17.15 L14.83,15.95 L15.95,14.83 L17.15,15.66 Z M19.55,18.2 A1.35,1.35 0 1,0 16.85,18.2 A1.35,1.35 0 1,0 19.55,18.2 Z"
      />
    </svg>
  )
}

// Viewport Display-mode control (P8: relocated out of the top-center toolbar to
// sit by the ViewCube in the bottom-left corner of the viewport). Behavior is
// identical to its former toolbar home — it reads/writes ONLY the Zustand store
// (the CNCViewport GL effect lives in Viewport.tsx), so no viewport ref is
// needed and this is a standalone store-only component. Because it now lives at
// the bottom of the viewport, its flyout opens UPWARD (see .display-mode-control
// .planes-flyout in app.css).
export function DisplayModeControl() {
  useText('cam-operations-new-operation')
  const viewer = useCamStore((s) => s.viewer)
  const setShading = useCamStore((s) => s.setShadingMode)
  const setSection = useCamStore((s) => s.setSectionView)

  // P11: set-and-forget viewport prefs relocated here from the always-on
  // ViewportToolbar (grid spacing, nest seed outline, height planes). Same
  // store state as before — the GL sync effects live in Viewport.tsx, so this
  // stays a store-only component (pure relocation, no behavior change).
  const toggle = useCamStore((s) => s.toggleViewerFlag)
  const setGridSpacing = useCamStore((s) => s.setGridSpacing)
  const displayUnits = useCamStore((s) => s.appSettings.displayUnits)
  const hiddenPlanes = useCamStore((s) => s.viewer.hiddenHeightPlanes)
  const togglePlane = useCamStore((s) => s.toggleHeightPlane)

  const [showDisplayFlyout, setShowDisplayFlyout] = useState(false)

  // Click-away handler to close the display-mode flyout
  const displayFlyoutRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!showDisplayFlyout) return
    const handler = (e: MouseEvent) => {
      if (displayFlyoutRef.current && !displayFlyoutRef.current.contains(e.target as Node)) {
        setShowDisplayFlyout(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showDisplayFlyout])

  return (
    // CVU-2: REGIME 2 ownership marker (see DisclosureSection.tsx) -- shipped
    // viewport chrome, already COHESIVE in the UI-70 census.
    <div className="display-mode-control" ref={displayFlyoutRef} data-ui78-sanctioned="">
      <button
        className="display-mode-gizmo-btn"
        onClick={() => setShowDisplayFlyout(p => !p)}
        data-tooltip={tx('DisplayModeControl.Display_mode')}
        aria-label={tx('DisplayModeControl.Display_mode')}
      >
        <CubeGearIcon size={30} />
      </button>
      {showDisplayFlyout && (
        <div className="planes-flyout" data-testid="display-mode-flyout">
          <div className="planes-flyout-header">
            <span className="planes-flyout-title">{tx('DisplayModeControl.Display_Mode')}</span>
            <button className="planes-flyout-close" onClick={() => setShowDisplayFlyout(false)}>{tx('DisplayModeControl.symbol')}</button>
          </div>
          {([
            { mode: 'shaded-edges',    get label() { return tx('DisplayModeControl.Shaded_with_edges') } },
            { mode: 'shaded-no-edges', get label() { return tx('DisplayModeControl.Shaded_no_edges') } },
            { mode: 'unshaded',        get label() { return tx('DisplayModeControl.Unshaded_wireframe') } },
            { mode: 'translucent',     get label() { return tx('DisplayModeControl.Translucent') } },
          ] as Array<{ mode: ShadingMode; label: string }>).map(({ mode, label }) => (
            <label key={mode} className="planes-flyout-item">
              <input
                type="radio"
                name="shading-mode"
                data-testid={`shading-${mode}`}
                checked={viewer.shadingMode === mode}
                onChange={() => setShading(mode)}
              />
              <span>{label}</span>
            </label>
          ))}

          {/* P11: relocated set-and-forget viewport prefs (formerly at-rest
              ViewportToolbar controls). Same store wiring as before. */}
          <div className="planes-flyout-divider" />
          <label className="planes-flyout-item">
            <span style={{ flex: 1 }}>{tx('DisplayModeControl.Grid_spacing')}</span>
            <NumericInput
              className="vp-grid-spacing-input"
              value={viewer.gridSpacing}
              min={5}
              max={1000}
              step={5}
              units={displayUnits}
              tooltip={tx('DisplayModeControl.Grid_spacing_tooltip', { p1: unitLabel(displayUnits) })}
              onChange={(v) => setGridSpacing(v)}
            />
            <span>{unitLabel(displayUnits)}</span>
          </label>
          <label className="planes-flyout-item">
            <input
              type="checkbox"
              data-testid="toggle-seed-outline"
              checked={viewer.showSeedOutline}
              onChange={() => toggle('showSeedOutline')}
            />
            <span>{tx('DisplayModeControl.Nest_seed_outline')}</span>
          </label>
          <label className="planes-flyout-item">
            <input
              type="checkbox"
              data-testid="toggle-height-planes"
              checked={viewer.showHeightPlanes}
              onChange={() => toggle('showHeightPlanes')}
            />
            <span>{tx('DisplayModeControl.Height_planes')}</span>
          </label>
          <div
            className="section-subcontrols"
            style={{ opacity: viewer.showHeightPlanes ? 1 : 0.45 }}
          >
            {[
              { key: 'clearance', get label() { return tx('DisplayModeControl.Clearance') },     color: '#4a90d9' },
              { key: 'retract',   get label() { return tx('DisplayModeControl.Retract') },        color: '#00e5ff' },
              { key: 'feed',      get label() { return tx('DisplayModeControl.Feed_Height') },    color: '#4caf50' },
              { key: 'top',       get label() { return tx('DisplayModeControl.Top_of_Stock') },   color: '#aac8e0' },
              { key: 'bottom',    get label() { return tx('DisplayModeControl.Bottom_of_Cut') },  color: '#e05252' },
            ].map(({ key, label, color }) => (
              <label key={key} className="planes-flyout-item">
                <input
                  type="checkbox"
                  checked={!hiddenPlanes.includes(key)}
                  disabled={!viewer.showHeightPlanes}
                  onChange={() => togglePlane(key)}
                />
                <span className="planes-color-dot" style={{ background: color }} />
                <span>{label}</span>
              </label>
            ))}
          </div>

          {/* Section view — a SEPARATE toggle, orthogonal to shading.
              Drives viewer.section* state -> CNCViewport clip plane. */}
          <div className="planes-flyout-divider" />
          <label className="planes-flyout-item">
            <input
              type="checkbox"
              data-testid="section-toggle"
              checked={viewer.sectionEnabled}
              onChange={() => {
                const sectionEnabled = !viewer.sectionEnabled
                setSection({
                  sectionEnabled,
                  ...(!sectionEnabled ? { sectionDragEnabled: false } : {}),
                })
              }}
            />
            <span>{tx('DisplayModeControl.Section_view')}</span>
          </label>

          <div
            className="section-subcontrols"
            style={{ opacity: viewer.sectionEnabled ? 1 : 0.45 }}
          >
            <label className="planes-flyout-item">
              <span style={{ minWidth: 32 }}>{tx('DisplayModeControl.Axis')}</span>
              <select
                data-testid="section-axis"
                value={viewer.sectionAxis}
                disabled={!viewer.sectionEnabled}
                onChange={(e) => setSection({ sectionAxis: e.target.value as SectionAxis })}
              >
                <option value="x">X</option>
                <option value="y">Y</option>
                <option value="z">Z</option>
              </select>
            </label>

            <label className="planes-flyout-item">
              <span style={{ minWidth: 32 }}>{tx('DisplayModeControl.Pos')}</span>
              <input
                type="range"
                data-testid="section-position"
                min={CAM_SECTION_MIN}
                max={CAM_SECTION_MAX}
                step={1}
                value={viewer.sectionPosition}
                disabled={!viewer.sectionEnabled}
                onChange={(e) => setSection({ sectionPosition: Number(e.target.value) })}
              />
              <span style={{ minWidth: 56, textAlign: 'right' }}>{tx('DisplayModeControl.mm', { p1: viewer.sectionPosition })}</span>
            </label>

            <label className="planes-flyout-item">
              <input
                type="checkbox"
                data-testid="section-flip"
                checked={viewer.sectionFlip}
                disabled={!viewer.sectionEnabled}
                onChange={() => setSection({ sectionFlip: !viewer.sectionFlip })}
              />
              <span>{tx('DisplayModeControl.Flip_side')}</span>
            </label>

            <div className="section-action-row">
              <button
                type="button"
                data-testid="section-drag-mode"
                aria-pressed={viewer.sectionDragEnabled}
                className="section-action-button"
                onClick={() => {
                  const sectionDragEnabled = !viewer.sectionDragEnabled
                  setSection({
                    sectionDragEnabled,
                    ...(sectionDragEnabled ? { sectionEnabled: true } : {}),
                  })
                }}
              >{tx('DisplayModeControl.Drag_plane')}</button>
              <button
                type="button"
                data-testid="section-clear"
                className="section-action-button"
                onClick={() => setSection({
                  sectionEnabled: false,
                  sectionAxis: 'x',
                  sectionPosition: 0,
                  sectionFlip: false,
                  sectionDragEnabled: false,
                })}
              >{tx('DisplayModeControl.Clear')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
