// WO UI-17 (criterion 7): the workbench display-mode control -- a lookalike of
// the CAM viewport's DisplayModeControl flyout (src/components/viewport/
// DisplayModeControl.tsx, read-only reference: it is CAM-store-coupled, so the
// pattern is copied against WORKBENCH state instead), applying the PURE
// src/lib/viewport/displayModes.ts helpers to the workbench body materials.
// Reuses the SAME app.css classes (.display-mode-control /
// .display-mode-gizmo-btn / .planes-flyout*), so the two controls cannot
// drift visually.
//
// POINTER-OWNERSHIP NOTE (oneWorkbenchSketchPointerOwner.test.ts net (d)):
// this file lives in the severing target. The reference control's click-away
// uses a document 'mousedown' listener; 'mousedown' is a forbidden raw event
// here, so the click-away listens for 'click' instead -- same felt behavior
// (the flyout closes on the next click anywhere outside it).

import { useText, textFor } from '../../../i18n'
const workbenchText = textFor('sketch-and-model-workbench')
import { useEffect, useRef, useState } from 'react'
import type { ShadingMode } from '../../../types'
import type { CameraProjectionMode } from '../sceneRuntime'
import { CURVATURE_STOPS, curvatureDisplay, curvatureLegendMm, setCurvatureDisplay as setCurvatureSettings, type CurvatureDisplay } from '../../../lib/viewport/lighting/zebra'

/** The CubeGearIcon pattern from DisplayModeControl.tsx (that component is
 *  store-coupled and does not export its icon; the manifest's rule for this
 *  case is "copy the pattern"). */
function CubeGearIcon({ size = 26 }: { size?: number }) {
  useText('sketch-and-model-workbench')
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
      <path d="M8,2 L14.5,5.2 L8,8.4 L1.5,5.2 Z" fill="#3a424c" />
      <path d="M1.5,5.2 L8,8.4 L8,14.9 L1.5,11.7 Z" fill="#2b323b" />
      <path d="M14.5,5.2 L14.5,11.7 L8,14.9 L8,8.4 Z" fill="#20262d" />
      <path
        fill="currentColor"
        stroke="none"
        fillRule="evenodd"
        d="M17.15,15.66 L17.41,14.23 L18.99,14.23 L19.25,15.66 L20.45,14.83 L21.57,15.95 L20.74,17.15 L22.17,17.41 L22.17,18.99 L20.74,19.25 L21.57,20.45 L20.45,21.57 L19.25,20.74 L18.99,22.17 L17.41,22.17 L17.15,20.74 L15.95,21.57 L14.83,20.45 L15.66,19.25 L14.23,18.99 L14.23,17.41 L15.66,17.15 L14.83,15.95 L15.95,14.83 L17.15,15.66 Z M19.55,18.2 A1.35,1.35 0 1,0 16.85,18.2 A1.35,1.35 0 1,0 19.55,18.2 Z"
      />
    </svg>
  )
}

/** The modes the pure displayModes.ts helpers support -- the same four the
 *  CAM control offers, same labels (terminology parity). */
const MODES: Array<{ mode: ShadingMode; label: string }> = [
  { mode: 'shaded-edges',    get label() { return workbenchText('WorkbenchDisplayMode.shadedWithEdges') } },
  { mode: 'shaded-no-edges', get label() { return workbenchText('WorkbenchDisplayMode.shadedNoEdges') } },
  { mode: 'unshaded',        get label() { return workbenchText('WorkbenchDisplayMode.unshadedWireframe') } },
  { mode: 'translucent',     get label() { return workbenchText('WorkbenchDisplayMode.translucent') } },
]

/** WO UI-23 (C4): the two camera projections, offered the same radio-group
 *  shape as MODES above (terminology parity: "Perspective" / "Orthographic",
 *  same words major parametric CAD systems use). */
const PROJECTIONS: Array<{ mode: CameraProjectionMode; label: string }> = [
  { mode: 'perspective', get label() { return workbenchText('WorkbenchDisplayMode.perspective') } },
  { mode: 'orthographic', get label() { return workbenchText('WorkbenchDisplayMode.orthographic') } },
]

export interface WorkbenchDisplayModeProps {
  mode: ShadingMode
  onModeChange(mode: ShadingMode): void
  /** WO UI-23 (C4): additive -- omitting both leaves the flyout exactly as
   *  before (no projection section rendered), so any other caller/test that
   *  doesn't yet care about projection is unaffected. */
  projection?: CameraProjectionMode
  onProjectionChange?(mode: CameraProjectionMode): void
  /** additive like projection: reflection stripes on bodies (display only) */
  zebra?: boolean
  onZebraChange?(on: boolean): void
  /** additive like zebra: curvature colours on bodies (display only) */
  curvature?: boolean
  onCurvatureChange?(on: boolean): void
  /** the curvature display's measure or range changed (shared uniforms): the scene wants a render */
  onCurvatureSettingsChange?(): void
}

export function WorkbenchDisplayMode({ mode, onModeChange, projection, onProjectionChange, zebra, onZebraChange, curvature, onCurvatureChange, onCurvatureSettingsChange }: WorkbenchDisplayModeProps) {
  const workbenchText = useText('sketch-and-model-workbench')
  const [open, setOpen] = useState(false)
  // what the curvature colours show (curvedness or Gaussian) and over which radii, for every body at once
  const [curvSettings, setCurvSettingsState] = useState<CurvatureDisplay>(() => curvatureDisplay())
  const changeCurvature = (next: Partial<CurvatureDisplay>) => { setCurvSettingsState(setCurvatureSettings(next)); onCurvatureSettingsChange?.() }
  const legend = curvatureLegendMm(curvSettings)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('click', handler)
    return () => document.removeEventListener('click', handler)
  }, [open])

  return (
    <div className="display-mode-control" ref={rootRef} data-ui78-sanctioned="">
      <button
        className="display-mode-gizmo-btn"
        data-testid="workbench-display-mode-btn"
        onClick={() => setOpen((p) => !p)}
        data-tooltip={workbenchText('WorkbenchDisplayMode.displayMode')}
        aria-label={workbenchText('WorkbenchDisplayMode.displayMode')}
      >
        <CubeGearIcon size={30} />
      </button>
      {open && (
        <div className="planes-flyout" data-testid="workbench-display-mode-flyout">
          <div className="planes-flyout-header">
            <span className="planes-flyout-title">{workbenchText('WorkbenchDisplayMode.displayMode2')}</span>
            <button className="planes-flyout-close" onClick={() => setOpen(false)}>
              x
            </button>
          </div>
          {MODES.map(({ mode: m, label }) => (
            <label key={m} className="planes-flyout-item">
              <input
                type="radio"
                name={"workbench-shading-mode"}
                data-testid={`workbench-shading-${m}`}
                checked={mode === m}
                onChange={() => onModeChange(m)}
              />
              <span>{label}</span>
            </label>
          ))}
          {projection !== undefined && onProjectionChange !== undefined && (
            <>
              <div className="planes-flyout-divider" />
              {PROJECTIONS.map(({ mode: p, label }) => (
                <label key={p} className="planes-flyout-item">
                  <input
                    type="radio"
                    name={"workbench-camera-projection"}
                    data-testid={`workbench-projection-${p}`}
                    checked={projection === p}
                    onChange={() => onProjectionChange(p)}
                  />
                  <span>{label}</span>
                </label>
              ))}
            </>
          )}
          {zebra !== undefined && onZebraChange !== undefined && (
            <>
              <div className="planes-flyout-divider" />
              <label className="planes-flyout-item" data-tooltip={workbenchText('WorkbenchDisplayMode.reflectionStripesOnTheBodiesTheyRunOnUnbroken')}>
                <input
                  type="checkbox"
                  data-testid="workbench-zebra"
                  checked={zebra}
                  onChange={(e) => onZebraChange(e.target.checked)}
                />
                <span>{workbenchText('WorkbenchDisplayMode.zebraStripes')}</span>
              </label>
            </>
          )}
          {curvature !== undefined && onCurvatureChange !== undefined && (
            <>
              {(zebra === undefined || onZebraChange === undefined) && <div className="planes-flyout-divider" />}
              <label className="planes-flyout-item" data-tooltip={curvSettings.mode === 'gaussian'
                ? workbenchText('WorkbenchDisplayMode.coloursTheBodiesByGaussianCurvatureGreenIsFlat', { tightMm: String(curvSettings.tightMm) })
                : workbenchText('WorkbenchDisplayMode.coloursTheBodiesByHowTightlyTheyCurveBlue', { flatMm: String(curvSettings.flatMm), tightMm: String(curvSettings.tightMm) })}>
                <input
                  type="checkbox"
                  data-testid="workbench-curvature"
                  checked={curvature}
                  onChange={(e) => onCurvatureChange(e.target.checked)}
                />
                <span>{workbenchText('WorkbenchDisplayMode.curvature')}</span>
              </label>
              {curvature && (
                <div className="planes-flyout-item" data-testid="workbench-curvature-legend" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 2 }}>
                  <div style={{ display: 'flex', gap: 8 }}>
                    {(['curvedness', 'gaussian'] as const).map((m) => (
                      <label key={m} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        <input
                          type="radio"
                          name={"workbench-curvature-mode"}
                          data-testid={`workbench-curvature-mode-${m}`}
                          checked={curvSettings.mode === m}
                          onChange={() => changeCurvature({ mode: m })}
                        />
                        <span>{m === 'curvedness' ? workbenchText('WorkbenchDisplayMode.howTight') : workbenchText('WorkbenchDisplayMode.gaussian')}</span>
                      </label>
                    ))}
                  </div>
                  <div style={{ height: 8, borderRadius: 2, background: `linear-gradient(to right, ${CURVATURE_STOPS.map((c) => `rgb(${c.map((v) => Math.round(v * 255)).join(',')})`).join(', ')})` }} />
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10 }}>
                    {curvSettings.mode === 'gaussian'
                      ? [workbenchText('WorkbenchDisplayMode.saddle', { value1: String(legend.at(-1)) }), workbenchText('WorkbenchDisplayMode.flatRuled'), workbenchText('WorkbenchDisplayMode.dome', { value1: String(legend.at(-1)) })].map((t) => <span key={t}>{t}</span>)
                      : legend.map((r, i) => <span key={`${i}:${r}`}>{i === 0 ? `${r}+` : i === legend.length - 1 ? `${r}-` : r}</span>)}
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'auto 56px', alignItems: 'center', columnGap: 6, rowGap: 2, fontSize: 10 }}>
                    <span>{workbenchText('WorkbenchDisplayMode.flatRadiusMm')}</span>
                    <input
                      type="number"
                      data-testid="workbench-curvature-flat"
                      aria-label={workbenchText('WorkbenchDisplayMode.curvatureFlatRadius')}
                      min={0}
                      step="any"
                      defaultValue={curvSettings.flatMm}
                      key={`f${curvSettings.flatMm}`}
                      style={{ width: '100%' }}
                      onBlur={(e) => changeCurvature({ flatMm: Number(e.target.value) })}
                      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                    />
                    <span>{workbenchText('WorkbenchDisplayMode.tightRadiusMm')}</span>
                    <input
                      type="number"
                      data-testid="workbench-curvature-tight"
                      aria-label={workbenchText('WorkbenchDisplayMode.curvatureTightRadius')}
                      min={0}
                      step="any"
                      defaultValue={curvSettings.tightMm}
                      key={`t${curvSettings.tightMm}`}
                      style={{ width: '100%' }}
                      onBlur={(e) => changeCurvature({ tightMm: Number(e.target.value) })}
                      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                    />
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
