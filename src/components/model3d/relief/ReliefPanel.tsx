// Relief - the Relief palette (docked at the viewport's top-left, the Form
// palette's shell) and the height map (docked at its top-right), shown while
// relief mode is open inside the Model screen. Stage 1 controls
// (docs/design/RELIEF-WHAT-GOOD-LOOKS-LIKE.md section 1): the picture, Depth,
// Raise / Cut in, Invert image, Zero plane, Base, size (keep proportions),
// rotate and move by number, Auto; the status line is information only (S12).
// WO-2174 (stage 2): the picture adjustments (section 2) with the levels
// histogram, the step-downs, and Before / After / Split views of the map.
// WO-2216: the Height row's two buttons became three - Raise / Emboss / Engrave
// (Engrave is the old Cut in, renamed); each sets direction + emboss, Invert
// stays a separate control (reliefHeights.ts reliefStyleOf/reliefStyleSettings).

import { useCallback, useEffect, useMemo, useRef } from 'react'
import { ChevronDown, ChevronRight, Mountain } from 'lucide-react'
import { DockedPanel } from '../workbench/DockedPanel'
import { useToolPaletteLayout } from '../../common/useToolPaletteLayout'
import { NumericInput } from '../../ui/NumericInput'
import { adjustSmoothPx, EDGE_SMOOTH_ON, greyOf, GREY_CHANNELS, histogram, MANUAL_PICTURE_ADJUST, type PictureAdjust } from '../../../relief/adjust'
import { DEFAULT_STEPS, picturePitchMm, reliefStyleOf, reliefStyleSettings, type ReliefStyle, type StepDowns } from '../../../relief/reliefHeights'
import { currentAdjust, useReliefStore, type ReliefMapView } from './reliefStore'
import { drawHistogram, drawReliefMap, drawReliefSection, drawThumbnail } from './reliefMap'
import type { ReliefSession } from './useReliefSession'
import './relief.css'

const MAP_SIZE = 260

/** WO-2216: the three Height buttons (Operator's card): each sets direction + emboss for the operator; Invert stays a
 *  separate control for a picture whose subject Auto reads the wrong way round. */
const RELIEF_STYLES: Array<[ReliefStyle, string, string]> = [
  ['raise', 'Raise', 'The subject stands proud of the face'],
  ['emboss', 'Emboss', 'The subject stays at the face, everything around it cuts down to the depth'],
  ['engrave', 'Engrave', 'The subject cuts into the face to the depth, everything around it stays at the face'],
]

export function ReliefPanel({ session }: { session: ReliefSession }) {
  const name = useReliefStore((s) => s.name)
  const editing = useReliefStore((s) => s.featureId !== null)
  const target = useReliefStore((s) => s.target)
  const image = useReliefStore((s) => s.image)
  const picture = useReliefStore((s) => s.picture)
  const settings = useReliefStore((s) => s.settings)
  const notice = useReliefStore((s) => s.notice)
  const status = useReliefStore((s) => s.status)
  const autoLine = useReliefStore((s) => s.autoLine)
  const applying = useReliefStore((s) => s.applying)
  const set = useReliefStore.getState().setSettings
  // the height map's fold, remembered per viewer
  const layout = useToolPaletteLayout('relief-palette')
  // drawn whenever its canvas mounts, not once per picture: folding the column unmounts the canvas and the unfold
  // mounts a new, blank one
  const thumbRef = useCallback((canvas: HTMLCanvasElement | null) => {
    if (canvas !== null && picture !== null) drawThumbnail(canvas, picture)
  }, [picture])

  const canApply = settings !== null && picture !== null && target !== null && !applying
  // docked at the side beside the tool rail (it floated over the view's top-left, the height map over its right): one
  // column, the height map a foldable section at its top; the chevron folds the column for the whole view
  return (
    <DockedPanel
      id="relief-palette"
      testId="relief-palette-shell"
      className="relief-palette-shell"
      title={editing ? `Edit relief - ${name}` : `Relief - ${name}`}
      icon={<Mountain size={14} />}
      width={320}
      onClose={session.cancel}
      closeLabel="Cancel relief"
      closeTestId="relief-close"
      footer={<>
        <button type="button" className="modal-btn modal-btn-ghost" data-testid="relief-cancel" onClick={session.cancel}>Cancel</button>
        <button type="button" className="modal-btn modal-btn-primary" data-testid="relief-apply" disabled={!canApply} onClick={session.apply}>
          {applying ? 'Applying...' : editing ? 'Apply changes' : 'Apply Relief'}
        </button>
      </>}
    >
          {settings !== null && picture !== null && target !== null && (
            <div className="relief-map-group" data-testid="relief-map-group">
              <button
                type="button"
                className="relief-map-toggle"
                data-testid="relief-map-toggle"
                aria-expanded={!layout.isCollapsed('map')}
                data-tooltip={layout.isCollapsed('map') ? 'Show the height map' : 'Hide the height map'}
                onClick={() => layout.toggleSection('map')}
              >
                {layout.isCollapsed('map') ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                <span>Height map</span>
              </button>
              {!layout.isCollapsed('map') && <ReliefMapPanel session={session} />}
            </div>
          )}
          <div className="relief-palette" data-testid="relief-palette">
            <div className="relief-section-title">
              <span>Image</span>
              <span className="relief-hint">light = high</span>
            </div>
            <div className="relief-image-row">
              <canvas ref={thumbRef} width={56} height={56} className="relief-thumb" data-testid="relief-thumb" />
              <div className="relief-image-meta">
                {image !== null
                  ? <>
                      <div className="relief-file" data-testid="relief-file-name">{image.fileName}</div>
                      <div className="relief-hint">{image.cols} x {image.rows} px, {image.bitDepth}-bit</div>
                    </>
                  : <div className="relief-hint">No picture yet</div>}
                <button type="button" className="modal-btn modal-btn-ghost relief-open" data-testid="relief-open" onClick={() => session.fileInputRef.current?.click()}>
                  {image !== null ? 'Open another' : 'Open image'}
                </button>
                <input
                  ref={(el) => { session.fileInputRef.current = el }}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/bmp,.png,.jpg,.jpeg"
                  data-testid="relief-file-input"
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const file = e.target.files?.[0]
                    e.target.value = ''
                    if (file !== undefined) void session.openFile(file)
                  }}
                />
              </div>
            </div>
            {settings !== null && (
              <>
                <div className="relief-row">
                  <span className="relief-row-label">Auto</span>
                  <label className="relief-check" data-testid="relief-auto-toggle">
                    <input type="checkbox" checked={settings.auto} onChange={(e) => useReliefStore.getState().setAuto(e.target.checked)} />
                    <span className="relief-hint">{settings.auto ? (autoLine ?? 'on') : isManualDefault(settings.adjust) ? 'off - the picture as it is' : 'off - your own adjustments'}</span>
                  </label>
                </div>

                <AdjustSection />

                <div className="relief-section-title"><span>Height</span></div>
                <div className="relief-row">
                  <span className="relief-row-label">Depth</span>
                  <NumericInput
                    value={settings.depthMm} min={0.05} max={50} step={0.25} decimals={2}
                    ariaLabel="Relief depth" tooltip="The tallest point of the relief above (or below) the face, mm"
                    onChange={(n) => set({ depthMm: n })} style={{ width: '4.2rem' }}
                  />
                  <span className="relief-unit">mm</span>
                  <span className="relief-seg" role="group" aria-label="Raise, Emboss or Engrave">
                    {RELIEF_STYLES.map(([style, label, title]) => (
                      <button
                        key={style} type="button" data-testid={`relief-dir-${style}`} title={title}
                        className={reliefStyleOf(settings) === style ? 'active' : ''}
                        onClick={() => set(reliefStyleSettings(style))}
                      >{label}</button>
                    ))}
                  </span>
                </div>
                <div className="relief-row">
                  <span className="relief-row-label" />
                  <input
                    type="range" className="relief-slider" data-testid="relief-depth-slider" aria-label="Depth slider"
                    min={0.05} max={Math.max(10, Math.ceil(settings.depthMm * 2))} step={0.05} value={settings.depthMm}
                    onChange={(e) => set({ depthMm: Number(e.target.value) })}
                  />
                </div>
                <div className="relief-row">
                  <span className="relief-row-label">Zero plane</span>
                  <input
                    type="range" className="relief-slider" data-testid="relief-zero-slider" aria-label="Zero plane slider"
                    min={0} max={99} step={1} value={Math.round(settings.zeroPlane * 100)}
                    onChange={(e) => set({ zeroPlane: Number(e.target.value) / 100 })}
                  />
                  <NumericInput
                    value={Math.round(settings.zeroPlane * 100)} min={0} max={99} step={1} decimals={0}
                    ariaLabel="Zero plane" tooltip="Everything darker than this share of the picture sits flat on the face (0 to 99 %)"
                    onChange={(n) => set({ zeroPlane: n / 100 })} style={{ width: '3.2rem' }}
                  />
                  <span className="relief-unit">%</span>
                </div>
                <div className="relief-row">
                  <span className="relief-row-label">Base</span>
                  <NumericInput
                    value={settings.baseMm} min={0} max={Math.max(2 * settings.depthMm, 0.1)} step={0.1} decimals={2}
                    ariaLabel="Relief base" tooltip="A plinth under the whole picture, mm above the face"
                    onChange={(n) => set({ baseMm: n })} style={{ width: '4.2rem' }}
                  />
                  <span className="relief-unit">mm above face</span>
                </div>
                <div className="relief-row">
                  <span className="relief-row-label">Invert</span>
                  <label className="relief-check" data-testid="relief-invert">
                    <input type="checkbox" checked={settings.invert} onChange={(e) => set({ invert: e.target.checked })} />
                    <span className="relief-hint">dark = high</span>
                  </label>
                </div>

                <StepsSection />

                <div className="relief-section-title">
                  <span>Place</span>
                  <span className="relief-hint" data-testid="relief-face">{target !== null ? `on ${target.bodyName}` : ''}</span>
                </div>
                <div className="relief-row">
                  <span className="relief-row-label">Size</span>
                  <NumericInput
                    value={settings.widthMm} min={1} max={10000} step={1} decimals={2}
                    ariaLabel="Relief width" tooltip="Width of the picture on the face, mm"
                    onChange={(n) => set({ widthMm: n })} style={{ width: '4.6rem' }}
                  />
                  <span className="relief-unit">x</span>
                  <NumericInput
                    value={settings.heightMm} min={1} max={10000} step={1} decimals={2}
                    ariaLabel="Relief height" tooltip="Height of the picture on the face, mm"
                    onChange={(n) => set({ heightMm: n })} style={{ width: '4.6rem' }}
                  />
                  <span className="relief-unit">mm</span>
                  <label className="relief-check" title="Keep the picture's proportions">
                    <input type="checkbox" data-testid="relief-keep" checked={settings.keepProportions} onChange={(e) => set({ keepProportions: e.target.checked })} />
                    <span className="relief-hint">keep</span>
                  </label>
                </div>
                <div className="relief-row">
                  <span className="relief-row-label">Rotate</span>
                  <NumericInput
                    value={settings.rotationDeg} min={-360} max={360} step={5} decimals={1}
                    ariaLabel="Relief rotation" tooltip="Turn the picture on the face, degrees counter-clockwise"
                    onChange={(n) => set({ rotationDeg: n })} style={{ width: '4.2rem' }}
                  />
                  <span className="relief-unit">deg</span>
                </div>
                <div className="relief-row">
                  <span className="relief-row-label">Move</span>
                  <NumericInput
                    value={settings.offsetXMm} min={-10000} max={10000} step={1} decimals={2}
                    ariaLabel="Relief move X" tooltip="Move the picture across the face (right is +), mm"
                    onChange={(n) => set({ offsetXMm: n })} style={{ width: '3.8rem' }}
                  />
                  <NumericInput
                    value={settings.offsetYMm} min={-10000} max={10000} step={1} decimals={2}
                    ariaLabel="Relief move Y" tooltip="Move the picture up the face (up is +), mm"
                    onChange={(n) => set({ offsetYMm: n })} style={{ width: '3.8rem' }}
                  />
                  <span className="relief-unit">mm</span>
                </div>
              </>
            )}
            <div className="relief-status" data-testid="relief-status">
              {status !== null && <div data-testid="relief-status-line">{status}</div>}
              {target === null && <div className="relief-hint">Click a flat face on the part to lay the picture on.</div>}
              {notice !== null && <div className="relief-notice" data-testid="relief-notice">{notice}</div>}
            </div>
          </div>
    </DockedPanel>
  )
}

/**
 * WO-2174: the picture adjustments (RELIEF-WHAT-GOOD-LOOKS-LIKE.md section 2),
 * each showing its value - Auto's after opening, the operator's once one is
 * moved (Auto then switches off; one click on Auto puts its values back).
 */
function AdjustSection() {
  const picture = useReliefStore((s) => s.picture)
  const settings = useReliefStore((s) => s.settings)
  const a = useReliefStore(currentAdjust)
  const histRef = useRef<HTMLCanvasElement | null>(null)
  const channel = a?.channel ?? 'luma'
  const hist = useMemo(() => (picture === null ? null : histogram(greyOf(picture, channel), 128)), [picture, channel])
  useEffect(() => {
    if (hist !== null && a !== null && histRef.current !== null) drawHistogram(histRef.current, hist, a.black, a.midtones, a.white)
  }, [hist, a])
  if (a === null || settings === null) return null
  const setA = useReliefStore.getState().setAdjust
  const pitch = picture === null ? 0 : picturePitchMm(picture, settings)
  const smoothPx = pitch > 0 ? adjustSmoothPx(a, pitch) : 0
  const edgeOn = a.edgeSmoothMm > 0
  return (
    <>
      <div className="relief-section-title">
        <span>Adjust</span>
        <span className="relief-hint">{picture?.rgb === undefined ? 'grey picture' : 'colour picture'}</span>
      </div>
      <div className="relief-row">
        <span className="relief-row-label">Greyscale</span>
        <span className="relief-seg" role="group" aria-label="Greyscale channel">
          {GREY_CHANNELS.map(([id, label]) => (
            <button key={id} type="button" data-testid={`relief-channel-${id}`} className={channel === id ? 'active' : ''} onClick={() => setA({ channel: id })}>{label}</button>
          ))}
        </span>
      </div>
      <canvas ref={histRef} width={288} height={44} className="relief-histogram" data-testid="relief-histogram" />
      <div className="relief-row">
        <span className="relief-row-label">Levels</span>
        <NumericInput
          value={round(a.black * 255, 1)} min={0} max={254} step={1} decimals={1}
          ariaLabel="Levels black" tooltip="Black point: greys at or below it sit at the bottom of the relief (0 to 255)"
          onChange={(n) => setA({ black: n / 255 })} style={{ width: '3.6rem' }}
        />
        <NumericInput
          value={a.midtones} min={0.3} max={3} step={0.05} decimals={2}
          ariaLabel="Levels midtones" tooltip="Midtones (gamma): above 1 fattens the middle heights, below 1 sharpens the peaks (0.30 to 3.00)"
          onChange={(n) => setA({ midtones: n })} style={{ width: '3.4rem' }}
        />
        <NumericInput
          value={round(a.white * 255, 1)} min={1} max={255} step={1} decimals={1}
          ariaLabel="Levels white" tooltip="White point: greys at or above it reach the top of the relief (0 to 255)"
          onChange={(n) => setA({ white: n / 255 })} style={{ width: '3.6rem' }}
        />
      </div>
      <SliderRow label="Contrast" testId="relief-contrast" value={a.contrast} min={-100} max={100} step={1} decimals={0} unit=""
        tooltip="Steeper or flatter about mid-grey (-100 to +100, 0 = as it is)" onChange={(n) => setA({ contrast: n })} />
      <SliderRow label="Brightness" testId="relief-brightness" value={a.brightness} min={-100} max={100} step={1} decimals={0} unit=""
        tooltip="Lifts or lowers every grey (-100 to +100, 0 = as it is)" onChange={(n) => setA({ brightness: n })} />
      <SliderRow label="Denoise" testId="relief-denoise" value={a.denoisePx} min={0} max={5} step={1} decimals={0} unit="px"
        tooltip="Median filter radius in picture pixels: removes speckle and grain, keeps edges (0 = off, 1 = 3 x 3)" onChange={(n) => setA({ denoisePx: n })} />
      <SliderRow label="Smooth" testId="relief-smooth" value={round(a.smoothPx !== undefined ? a.smoothPx * pitch : a.smoothMm, 2)} min={0} max={5} step={0.01} decimals={2} unit={`mm (${smoothPx.toFixed(1)} px)`}
        tooltip="Gaussian smooth, in mm on the part: softens everything, removes 8-bit terraces and grain (0 to 5 mm)" onChange={(n) => setA({ smoothMm: n })} />
      <div className="relief-row">
        <span className="relief-row-label">Edge-keep</span>
        <label className="relief-check" data-testid="relief-edge-toggle">
          <input type="checkbox" checked={edgeOn} onChange={(e) => setA(e.target.checked ? { ...EDGE_SMOOTH_ON } : { edgeSmoothMm: 0 })} />
          <span className="relief-hint">{edgeOn ? 'smooths, keeps edges' : 'off'}</span>
        </label>
        {edgeOn && (
          <>
            <NumericInput
              value={a.edgeSmoothMm} min={0.01} max={3} step={0.05} decimals={2}
              ariaLabel="Edge smooth size" tooltip="Edge-keeping smooth: how far it reaches, mm on the part (0 to 3)"
              onChange={(n) => setA({ edgeSmoothMm: n })} style={{ width: '3.4rem' }}
            />
            <span className="relief-unit">mm</span>
            <NumericInput
              value={round(a.edgeRange * 100, 1)} min={1} max={30} step={1} decimals={0}
              ariaLabel="Edge smooth range" tooltip="Edge-keeping smooth: greys closer than this blend, bigger differences stay edges (1 to 30 %)"
              onChange={(n) => setA({ edgeRange: n / 100 })} style={{ width: '3rem' }}
            />
            <span className="relief-unit">%</span>
          </>
        )}
      </div>
    </>
  )
}

export function SliderRow(p: { label: string; testId: string; value: number; min: number; max: number; step: number; decimals: number; unit: string; tooltip: string; onChange: (n: number) => void }) {
  return (
    <div className="relief-row">
      <span className="relief-row-label">{p.label}</span>
      <input
        type="range" className="relief-slider relief-slider-compact" data-testid={`${p.testId}-slider`} aria-label={`${p.label} slider`}
        min={p.min} max={p.max} step={p.step} value={p.value} onChange={(e) => p.onChange(Number(e.target.value))}
      />
      <NumericInput
        value={p.value} min={p.min} max={p.max} step={p.step} decimals={p.decimals}
        ariaLabel={p.label} tooltip={p.tooltip} onChange={p.onChange} style={{ width: '3.4rem' }}
      />
      {p.unit !== '' && <span className="relief-unit">{p.unit}</span>}
    </div>
  )
}

const STEP_MODES: Array<[StepDowns['mode'], string]> = [['off', 'Off'], ['levels', 'Levels'], ['step', 'Fixed step']]

/** WO-2174: step-downs - flat floors along the picture's contours (the layered lake / contour sign). */
function StepsSection() {
  const settings = useReliefStore((s) => s.settings)
  if (settings === null) return null
  const st = settings.steps ?? DEFAULT_STEPS
  const setS = useReliefStore.getState().setSteps
  return (
    <>
      <div className="relief-section-title">
        <span>Step-downs</span>
        <span className="relief-hint">flat floors along the contours</span>
      </div>
      <div className="relief-row">
        <span className="relief-row-label">Steps</span>
        <span className="relief-seg" role="group" aria-label="Step-downs">
          {STEP_MODES.map(([id, label]) => (
            <button key={id} type="button" data-testid={`relief-steps-${id}`} className={st.mode === id ? 'active' : ''} onClick={() => setS({ mode: id })}>{label}</button>
          ))}
        </span>
      </div>
      {st.mode !== 'off' && (
        <div className="relief-row">
          {st.mode === 'levels'
            ? <>
                <span className="relief-row-label">Levels</span>
                <NumericInput
                  value={st.levels} min={1} max={50} step={1} decimals={0}
                  ariaLabel="Step levels" tooltip="How many flat floors above the zero plane (1 to 50): the depth is split evenly between them"
                  onChange={(n) => setS({ levels: n })} style={{ width: '3rem' }}
                />
              </>
            : <>
                <span className="relief-row-label">Step</span>
                <NumericInput
                  value={st.stepMm} min={0.01} max={50} step={0.25} decimals={2}
                  ariaLabel="Step depth" tooltip="Depth of each step, mm: every floor is a whole number of steps deep"
                  onChange={(n) => setS({ stepMm: n })} style={{ width: '3.6rem' }}
                />
                <span className="relief-unit">mm</span>
              </>}
          <span className="relief-row-label relief-row-label-inline">Walls</span>
          <NumericInput
            value={st.wallDeg} min={5} max={90} step={5} decimals={1}
            ariaLabel="Wall angle" tooltip="The walls between floors, degrees from the face: 90 = vertical, less = sloped (5 to 90)"
            onChange={(n) => setS({ wallDeg: n })} style={{ width: '3.4rem' }}
          />
          <span className="relief-unit">deg</span>
        </div>
      )}
    </>
  )
}

/** The adjustments are the standard's manual defaults (or stage 1's, when a relief carries none). */
function isManualDefault(a: PictureAdjust | undefined): boolean {
  return a === undefined || (Object.keys(MANUAL_PICTURE_ADJUST) as Array<keyof PictureAdjust>).every((k) => a[k] === MANUAL_PICTURE_ADJUST[k])
}

function round(x: number, decimals: number): number {
  const f = 10 ** decimals
  return Math.round(x * f) / f
}

const VIEWS: Array<[ReliefMapView, string]> = [['image', 'Before'], ['adjusted', 'After'], ['compare', 'Split'], ['height', 'Height'], ['shaded', 'Shaded']]

function ReliefMapPanel({ session }: { session: ReliefSession }) {
  const view = useReliefStore((s) => s.mapView)
  const version = useReliefStore((s) => s.settledVersion)
  const picture = useReliefStore((s) => s.picture)
  const settings = useReliefStore((s) => s.settings)
  const mapRef = useRef<HTMLCanvasElement | null>(null)
  const sectionRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const settled = session.settled()
    if (settled === null || mapRef.current === null || sectionRef.current === null) return
    const { heights, n, frame } = settled
    const aspect = frame.heightMm / frame.widthMm
    mapRef.current.width = MAP_SIZE
    mapRef.current.height = Math.max(40, Math.round(MAP_SIZE * Math.min(aspect, 1.6)))
    drawReliefMap(mapRef.current, view, heights, n, frame.widthMm, frame.heightMm, picture, settled.adjusted)
    const s = settled.settings
    drawReliefSection(sectionRef.current, heights, n, s.baseMm + s.depthMm, s.direction === 'cut')
  }, [session, version, view, picture])

  const depth = settings === null ? 0 : settings.baseMm + settings.depthMm
  return (
    <div className="relief-map-shell" data-testid="relief-map-shell">
      <div className="relief-map-body">
        <span className="relief-seg relief-map-views" role="group" aria-label="Map view">
          {VIEWS.map(([id, label]) => (
            <button key={id} type="button" data-testid={`relief-view-${id}`} className={view === id ? 'active' : ''} onClick={() => useReliefStore.getState().setMapView(id)}>{label}</button>
          ))}
        </span>
        <canvas ref={mapRef} width={MAP_SIZE} height={MAP_SIZE} className="relief-map" data-testid="relief-map" />
        <div className="relief-hint relief-section-caption">Section A-A, {depth.toFixed(2)} mm - dashed line = the face</div>
        <canvas ref={sectionRef} width={MAP_SIZE} height={64} className="relief-section" data-testid="relief-section" />
      </div>
    </div>
  )
}
