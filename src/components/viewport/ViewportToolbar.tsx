import { textFor, useText } from '../../i18n'
const tx = textFor('cam-operations-new-operation')
import { useState, useEffect, type MutableRefObject } from 'react'
import {
  Box, Eye, EyeOff, Grid3x3, Axis3d,
  Move, RotateCcw, ArrowDownToLine,
  PanelBottom, Magnet, ScanLine,
} from 'lucide-react'
import { useCamStore } from '../../store'
import type { CNCViewport } from '../../lib/viewport/CNCViewport'

const FORMATS_2D = new Set(['svg', 'dxf', 'dwg'])

interface Props {
  viewport: MutableRefObject<CNCViewport | null>
  interactionMode: 'normal' | 'lay-on-face' | 'project-plane'
  onEnterLayOnFace: () => void
  onExitLayOnFace: () => void
  onEnterProjectPlane: () => void
  onExitProjectPlane: () => void
}

export function ViewportToolbar({ viewport, interactionMode, onEnterLayOnFace, onExitLayOnFace, onEnterProjectPlane, onExitProjectPlane }: Props) {
  useText('cam-operations-new-operation')
  const viewer = useCamStore((s) => s.viewer)
  const toggle = useCamStore((s) => s.toggleViewerFlag)

  const vp = viewport.current
  const selectedGeoId = viewer.selectedGeometryId
  const project = useCamStore((s) => s.project)
  const selectedGeo = project.geometry.find(g => g.id === selectedGeoId)
  const is2D = selectedGeo ? FORMATS_2D.has(selectedGeo.format) : false

  const [transformMode, setTransformMode] = useState<'translate' | 'rotate'>('translate')

  // Reset to translate mode whenever the selected part changes
  useEffect(() => {
    setTransformMode('translate')
    vp?.setTransformMode?.('translate')
  }, [selectedGeoId]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleTransformMode = (mode: 'translate' | 'rotate') => {
    setTransformMode(mode)
    vp?.setTransformMode?.(mode)
  }

  const handleDropToFloor = () => {
    if (selectedGeoId) vp?.dropPartToFloor?.(selectedGeoId)
  }

  const handleSettle = () => {
    if (selectedGeoId) vp?.settleToFloor?.(selectedGeoId)
  }

  const handleLayOnFace = () => {
    if (interactionMode === 'lay-on-face') onExitLayOnFace()
    else onEnterLayOnFace()
  }

  return (
    // CVU-2: REGIME 2 ownership marker (see DisclosureSection.tsx) -- shipped
    // in-viewport toolbar, already COHESIVE in the UI-70 census.
    <div className="viewport-toolbar" data-ui78-sanctioned="">
      {/* WO-047: the mode/workspace strip moved natively into the top header
          (TopToolbar). UI-73's portal target here is gone; this bar holds
          view controls only. */}
      {/* Visibility toggles */}
      <div className="vp-toolbar-group" data-testid="viewport-visibility-tools">
        <button
          className={`vp-btn vp-btn-icon ${viewer.showStock ? 'vp-btn-on' : ''}`}
          onClick={() => toggle('showStock')}
          data-tooltip={tx('ViewportToolbar.Toggle_stock')}
          aria-label={tx('ViewportToolbar.Toggle_stock')}
        >
          <Box size={13} />
        </button>
        <button
          className={`vp-btn vp-btn-icon ${viewer.showWorkpiece ? 'vp-btn-on' : ''}`}
          onClick={() => toggle('showWorkpiece')}
          data-tooltip={tx('ViewportToolbar.Toggle_geometry')}
          aria-label={tx('ViewportToolbar.Toggle_geometry')}
        >
          {viewer.showWorkpiece ? <Eye size={13} /> : <EyeOff size={13} />}
        </button>
        <button
          className={`vp-btn vp-btn-icon ${viewer.showGrid ? 'vp-btn-on' : ''}`}
          onClick={() => toggle('showGrid')}
          data-tooltip={tx('ViewportToolbar.Toggle_grid')}
          aria-label={tx('ViewportToolbar.Toggle_grid')}
        >
          <Grid3x3 size={13} />
        </button>
        <button
          className={`vp-btn vp-btn-icon ${viewer.showAxes ? 'vp-btn-on' : ''}`}
          onClick={() => toggle('showAxes')}
          data-tooltip={tx('ViewportToolbar.Toggle_WCS')}
          aria-label={tx('ViewportToolbar.Toggle_WCS')}
        >
          <Axis3d size={13} />
        </button>
        {/* P11: the set-and-forget controls (grid spacing, nest seed outline,
            height planes) moved to the DisplayModeControl flyout by the
            ViewCube — the at-rest toolbar keeps only the 4 high-frequency
            visibility toggles. */}
      </div>

      {/* Transform + orient tools — only shown when a part is selected */}
      {selectedGeoId && (
        <>
          <div className="vp-toolbar-sep" />
          <div className="vp-toolbar-group" data-testid="viewport-manipulation-tools">
            <button
              className={`vp-btn vp-btn-icon ${transformMode === 'translate' ? 'vp-btn-active' : ''}`}
              onClick={() => handleTransformMode('translate')}
              data-tooltip={tx('ViewportToolbar.Move_translate')}
              aria-label={tx('ViewportToolbar.Move_translate')}
            >
              <Move size={13} />
            </button>
            <button
              className={`vp-btn vp-btn-icon ${transformMode === 'rotate' ? 'vp-btn-active' : ''}`}
              onClick={() => handleTransformMode('rotate')}
              data-tooltip={tx('ViewportToolbar.Rotate')}
              aria-label={tx('ViewportToolbar.Rotate')}
            >
              <RotateCcw size={13} />
            </button>
            {!is2D && (
              <>
                <button
                  className="vp-btn vp-btn-icon"
                  onClick={handleDropToFloor}
                  data-tooltip={tx('ViewportToolbar.Drop_to_floor_snap_bottom_to_Z_0')}
                  aria-label={tx('ViewportToolbar.Drop_to_floor')}
                >
                  <ArrowDownToLine size={13} />
                </button>
                <button
                  className={`vp-btn vp-btn-icon ${interactionMode === 'lay-on-face' ? 'vp-btn-active' : ''}`}
                  onClick={handleLayOnFace}
                  data-tooltip={tx('ViewportToolbar.Lay_on_face_click_a_face_to_rest_the')}
                  aria-label={tx('ViewportToolbar.Lay_on_face')}
                >
                  <PanelBottom size={13} />
                </button>
                <button
                  className="vp-btn vp-btn-icon"
                  onClick={handleSettle}
                  data-tooltip={tx('ViewportToolbar.Settle_auto_orient_part_to_most_stable_resting_position')}
                  aria-label={tx('ViewportToolbar.Settle')}
                >
                  <Magnet size={13} />
                </button>
                <div className="vp-toolbar-sep vp-toolbar-sep-sm" />
                <button
                  className={`vp-btn vp-btn-icon ${interactionMode === 'project-plane' ? 'vp-btn-active' : ''}`}
                  onClick={() => interactionMode === 'project-plane' ? onExitProjectPlane() : onEnterProjectPlane()}
                  data-tooltip={tx('ViewportToolbar.Set_projection_plane_click_a_face_or_stock_surface')}
                  aria-label={tx('ViewportToolbar.Set_projection_plane')}
                >
                  <ScanLine size={13} />
                </button>
              </>
            )}
          </div>
        </>
      )}

    </div>
  )
}
