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

import { useText } from '../../../i18n'
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


export function ReliefPanel({ session }: { session: ReliefSession }) {
  const workbenchText = useText('sketch-and-model-workbench')
  const RELIEF_STYLES: Array<[ReliefStyle, string, string]> = [
  ['raise', workbenchText('ReliefPanel.raise'), workbenchText('ReliefPanel.theSubjectStandsProudOfTheFace')],
  ['emboss', workbenchText('ReliefPanel.emboss'), workbenchText('ReliefPanel.theSubjectStaysAtTheFaceEverythingAroundIt')],
  ['engrave', workbenchText('ReliefPanel.engrave'), workbenchText('ReliefPanel.theSubjectCutsIntoTheFaceToTheDepth')],
]
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
      title={editing ? workbenchText('ReliefPanel.editRelief', { name: String(name) }) : workbenchText('ReliefPanel.relief', { name: String(name) })}
      icon={<Mountain size={14} />}
      width={320}
      onClose={session.cancel}
      closeLabel={workbenchText('ReliefPanel.cancelRelief')}
      closeTestId="relief-close"
      footer={<>
        <button type="button" className="modal-btn modal-btn-ghost" data-testid="relief-cancel" onClick={session.cancel}>{workbenchText('ReliefPanel.cancel')}</button>
        <button type="button" className="modal-btn modal-btn-primary" data-testid="relief-apply" disabled={!canApply} onClick={session.apply}>
          {applying ? workbenchText('ReliefPanel.applying') : editing ? workbenchText('ReliefPanel.applyChanges') : workbenchText('ReliefPanel.applyRelief')}
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
                data-tooltip={layout.isCollapsed(workbenchText('ReliefPanel.map')) ? workbenchText('ReliefPanel.showTheHeightMap') : workbenchText('ReliefPanel.hideTheHeightMap')}
                onClick={() => layout.toggleSection('map')}
              >
                {layout.isCollapsed('map') ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                <span>{workbenchText('ReliefPanel.heightMap')}</span>
              </button>
              {!layout.isCollapsed('map') && <ReliefMapPanel session={session} />}
            </div>
          )}
          <div className="relief-palette" data-testid="relief-palette">
            <div className="relief-section-title">
              <span>{workbenchText('ReliefPanel.image')}</span>
              <span className="relief-hint">{workbenchText('ReliefPanel.lightHigh')}</span>
            </div>
            <div className="relief-image-row">
              <canvas ref={thumbRef} width={56} height={56} className="relief-thumb" data-testid="relief-thumb" />
              <div className="relief-image-meta">
                {image !== null
                  ? <>
                      <div className="relief-file" data-testid="relief-file-name">{image.fileName}</div>
                      <div className="relief-hint">{workbenchText('ReliefPanel.combinedXPxBit', { value1: String((image.cols) ?? ''), value2: String((image.rows) ?? ''), value3: String((image.bitDepth) ?? '') })}</div>
                    </>
                  : <div className="relief-hint">{workbenchText('ReliefPanel.noPictureYet')}</div>}
                <button type="button" className="modal-btn modal-btn-ghost relief-open" data-testid="relief-open" onClick={() => session.fileInputRef.current?.click()}>
                  {image !== null ? workbenchText('ReliefPanel.openAnother') : workbenchText('ReliefPanel.openImage')}
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
                  <span className="relief-row-label">{workbenchText('ReliefPanel.auto')}</span>
                  <label className="relief-check" data-testid="relief-auto-toggle">
                    <input type="checkbox" checked={settings.auto} onChange={(e) => useReliefStore.getState().setAuto(e.target.checked)} />
                    <span className="relief-hint">{settings.auto ? (autoLine ?? workbenchText('ReliefPanel.on')) : isManualDefault(settings.adjust) ? workbenchText('ReliefPanel.offThePictureAsItIs') : workbenchText('ReliefPanel.offYourOwnAdjustments')}</span>
                  </label>
                </div>

                <AdjustSection />

                <div className="relief-section-title"><span>{workbenchText('ReliefPanel.height')}</span></div>
                <div className="relief-row">
                  <span className="relief-row-label">{workbenchText('ReliefPanel.depth')}</span>
                  <NumericInput
                    value={settings.depthMm} min={0.05} max={50} step={0.25} decimals={2}
                    ariaLabel={workbenchText('ReliefPanel.reliefDepth')} tooltip={workbenchText('ReliefPanel.theTallestPointOfTheReliefAboveOrBelow')}
                    onChange={(n) => set({ depthMm: n })} style={{ width: '4.2rem' }}
                  />
                  <span className="relief-unit">{workbenchText('ReliefPanel.mm')}</span>
                  <span className="relief-seg" role="group" aria-label={workbenchText('ReliefPanel.raiseEmbossOrEngrave')}>
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
                    type="range" className="relief-slider" data-testid="relief-depth-slider" aria-label={workbenchText('ReliefPanel.depthSlider')}
                    min={0.05} max={Math.max(10, Math.ceil(settings.depthMm * 2))} step={0.05} value={settings.depthMm}
                    onChange={(e) => set({ depthMm: Number(e.target.value) })}
                  />
                </div>
                <div className="relief-row">
                  <span className="relief-row-label">{workbenchText('ReliefPanel.zeroPlane')}</span>
                  <input
                    type="range" className="relief-slider" data-testid="relief-zero-slider" aria-label={workbenchText('ReliefPanel.zeroPlaneSlider')}
                    min={0} max={99} step={1} value={Math.round(settings.zeroPlane * 100)}
                    onChange={(e) => set({ zeroPlane: Number(e.target.value) / 100 })}
                  />
                  <NumericInput
                    value={Math.round(settings.zeroPlane * 100)} min={0} max={99} step={1} decimals={0}
                    ariaLabel={workbenchText('ReliefPanel.zeroPlane')} tooltip={workbenchText('ReliefPanel.everythingDarkerThanThisShareOfThePictureSits')}
                    onChange={(n) => set({ zeroPlane: n / 100 })} style={{ width: '3.2rem' }}
                  />
                  <span className="relief-unit">{workbenchText('ReliefPanel.value')}</span>
                </div>
                <div className="relief-row">
                  <span className="relief-row-label">{workbenchText('ReliefPanel.base')}</span>
                  <NumericInput
                    value={settings.baseMm} min={0} max={Math.max(2 * settings.depthMm, 0.1)} step={0.1} decimals={2}
                    ariaLabel={workbenchText('ReliefPanel.reliefBase')} tooltip={workbenchText('ReliefPanel.aPlinthUnderTheWholePictureMmAboveThe')}
                    onChange={(n) => set({ baseMm: n })} style={{ width: '4.2rem' }}
                  />
                  <span className="relief-unit">{workbenchText('ReliefPanel.mmAboveFace')}</span>
                </div>
                <div className="relief-row">
                  <span className="relief-row-label">{workbenchText('ReliefPanel.invert')}</span>
                  <label className="relief-check" data-testid="relief-invert">
                    <input type="checkbox" checked={settings.invert} onChange={(e) => set({ invert: e.target.checked })} />
                    <span className="relief-hint">{workbenchText('ReliefPanel.darkHigh')}</span>
                  </label>
                </div>

                <StepsSection />

                <div className="relief-section-title">
                  <span>{workbenchText('ReliefPanel.place')}</span>
                  <span className="relief-hint" data-testid="relief-face">{target !== null ? workbenchText('ReliefPanel.on2', { value1: String(target.bodyName) }) : ''}</span>
                </div>
                <div className="relief-row">
                  <span className="relief-row-label">{workbenchText('ReliefPanel.size')}</span>
                  <NumericInput
                    value={settings.widthMm} min={1} max={10000} step={1} decimals={2}
                    ariaLabel={workbenchText('ReliefPanel.reliefWidth')} tooltip={workbenchText('ReliefPanel.widthOfThePictureOnTheFaceMm')}
                    onChange={(n) => set({ widthMm: n })} style={{ width: '4.6rem' }}
                  />
                  <span className="relief-unit">x</span>
                  <NumericInput
                    value={settings.heightMm} min={1} max={10000} step={1} decimals={2}
                    ariaLabel={workbenchText('ReliefPanel.reliefHeight')} tooltip={workbenchText('ReliefPanel.heightOfThePictureOnTheFaceMm')}
                    onChange={(n) => set({ heightMm: n })} style={{ width: '4.6rem' }}
                  />
                  <span className="relief-unit">{workbenchText('ReliefPanel.mm')}</span>
                  <label className="relief-check" title={workbenchText('ReliefPanel.keepThePictureSProportions')}>
                    <input type="checkbox" data-testid="relief-keep" checked={settings.keepProportions} onChange={(e) => set({ keepProportions: e.target.checked })} />
                    <span className="relief-hint">{workbenchText('ReliefPanel.keep')}</span>
                  </label>
                </div>
                <div className="relief-row">
                  <span className="relief-row-label">{workbenchText('ReliefPanel.rotate')}</span>
                  <NumericInput
                    value={settings.rotationDeg} min={-360} max={360} step={5} decimals={1}
                    ariaLabel={workbenchText('ReliefPanel.reliefRotation')} tooltip={workbenchText('ReliefPanel.turnThePictureOnTheFaceDegreesCounterClockwise')}
                    onChange={(n) => set({ rotationDeg: n })} style={{ width: '4.2rem' }}
                  />
                  <span className="relief-unit">{workbenchText('ReliefPanel.deg')}</span>
                </div>
                <div className="relief-row">
                  <span className="relief-row-label">{workbenchText('ReliefPanel.move')}</span>
                  <NumericInput
                    value={settings.offsetXMm} min={-10000} max={10000} step={1} decimals={2}
                    ariaLabel={workbenchText('ReliefPanel.reliefMoveX')} tooltip={workbenchText('ReliefPanel.moveThePictureAcrossTheFaceRightIsMm')}
                    onChange={(n) => set({ offsetXMm: n })} style={{ width: '3.8rem' }}
                  />
                  <NumericInput
                    value={settings.offsetYMm} min={-10000} max={10000} step={1} decimals={2}
                    ariaLabel={workbenchText('ReliefPanel.reliefMoveY')} tooltip={workbenchText('ReliefPanel.moveThePictureUpTheFaceUpIsMm')}
                    onChange={(n) => set({ offsetYMm: n })} style={{ width: '3.8rem' }}
                  />
                  <span className="relief-unit">{workbenchText('ReliefPanel.mm')}</span>
                </div>
              </>
            )}
            <div className="relief-status" data-testid="relief-status">
              {status !== null && <div data-testid="relief-status-line">{status}</div>}
              {target === null && <div className="relief-hint">{workbenchText('ReliefPanel.clickAFlatFaceOnThePartToLay')}</div>}
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
  const workbenchText = useText('sketch-and-model-workbench')
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
        <span>{workbenchText('ReliefPanel.adjust')}</span>
        <span className="relief-hint">{picture?.rgb === undefined ? workbenchText('ReliefPanel.greyPicture') : workbenchText('ReliefPanel.colourPicture')}</span>
      </div>
      <div className="relief-row">
        <span className="relief-row-label">{workbenchText('ReliefPanel.greyscale')}</span>
        <span className="relief-seg" role="group" aria-label={workbenchText('ReliefPanel.greyscaleChannel')}>
          {GREY_CHANNELS.map(([id, label]) => (
            <button key={id} type="button" data-testid={`relief-channel-${id}`} className={channel === id ? 'active' : ''} onClick={() => setA({ channel: id })}>{label}</button>
          ))}
        </span>
      </div>
      <canvas ref={histRef} width={288} height={44} className="relief-histogram" data-testid="relief-histogram" />
      <div className="relief-row">
        <span className="relief-row-label">{workbenchText('ReliefPanel.levels')}</span>
        <NumericInput
          value={round(a.black * 255, 1)} min={0} max={254} step={1} decimals={1}
          ariaLabel={workbenchText('ReliefPanel.levelsBlack')} tooltip={workbenchText('ReliefPanel.blackPointGreysAtOrBelowItSitAt')}
          onChange={(n) => setA({ black: n / 255 })} style={{ width: '3.6rem' }}
        />
        <NumericInput
          value={a.midtones} min={0.3} max={3} step={0.05} decimals={2}
          ariaLabel={workbenchText('ReliefPanel.levelsMidtones')} tooltip={workbenchText('ReliefPanel.midtonesGammaAbove1FattensTheMiddleHeightsBelow')}
          onChange={(n) => setA({ midtones: n })} style={{ width: '3.4rem' }}
        />
        <NumericInput
          value={round(a.white * 255, 1)} min={1} max={255} step={1} decimals={1}
          ariaLabel={workbenchText('ReliefPanel.levelsWhite')} tooltip={workbenchText('ReliefPanel.whitePointGreysAtOrAboveItReachThe')}
          onChange={(n) => setA({ white: n / 255 })} style={{ width: '3.6rem' }}
        />
      </div>
      <SliderRow label={workbenchText('ReliefPanel.contrast')} testId="relief-contrast" value={a.contrast} min={-100} max={100} step={1} decimals={0} unit=""
        tooltip={workbenchText('ReliefPanel.steeperOrFlatterAboutMidGrey100To100')} onChange={(n) => setA({ contrast: n })} />
      <SliderRow label={workbenchText('ReliefPanel.brightness')} testId="relief-brightness" value={a.brightness} min={-100} max={100} step={1} decimals={0} unit=""
        tooltip={workbenchText('ReliefPanel.liftsOrLowersEveryGrey100To1000')} onChange={(n) => setA({ brightness: n })} />
      <SliderRow label={workbenchText('ReliefPanel.denoise')} testId="relief-denoise" value={a.denoisePx} min={0} max={5} step={1} decimals={0} unit="px"
        tooltip={workbenchText('ReliefPanel.medianFilterRadiusInPicturePixelsRemovesSpeckleAnd')} onChange={(n) => setA({ denoisePx: n })} />
      <SliderRow label={workbenchText('ReliefPanel.smooth')} testId="relief-smooth" value={round(a.smoothPx !== undefined ? a.smoothPx * pitch : a.smoothMm, 2)} min={0} max={5} step={0.01} decimals={2} unit={workbenchText('ReliefPanel.mmPx', { value1: String(smoothPx.toFixed(1)) })}
        tooltip={workbenchText('ReliefPanel.gaussianSmoothInMmOnThePartSoftensEverything')} onChange={(n) => setA({ smoothMm: n })} />
      <div className="relief-row">
        <span className="relief-row-label">{workbenchText('ReliefPanel.edgeKeep')}</span>
        <label className="relief-check" data-testid="relief-edge-toggle">
          <input type="checkbox" checked={edgeOn} onChange={(e) => setA(e.target.checked ? { ...EDGE_SMOOTH_ON } : { edgeSmoothMm: 0 })} />
          <span className="relief-hint">{edgeOn ? workbenchText('ReliefPanel.smoothsKeepsEdges') : workbenchText('ReliefPanel.off')}</span>
        </label>
        {edgeOn && (
          <>
            <NumericInput
              value={a.edgeSmoothMm} min={0.01} max={3} step={0.05} decimals={2}
              ariaLabel={workbenchText('ReliefPanel.edgeSmoothSize')} tooltip={workbenchText('ReliefPanel.edgeKeepingSmoothHowFarItReachesMmOn')}
              onChange={(n) => setA({ edgeSmoothMm: n })} style={{ width: '3.4rem' }}
            />
            <span className="relief-unit">{workbenchText('ReliefPanel.mm')}</span>
            <NumericInput
              value={round(a.edgeRange * 100, 1)} min={1} max={30} step={1} decimals={0}
              ariaLabel={workbenchText('ReliefPanel.edgeSmoothRange')} tooltip={workbenchText('ReliefPanel.edgeKeepingSmoothGreysCloserThanThisBlendBigger')}
              onChange={(n) => setA({ edgeRange: n / 100 })} style={{ width: '3rem' }}
            />
            <span className="relief-unit">{workbenchText('ReliefPanel.value')}</span>
          </>
        )}
      </div>
    </>
  )
}

export function SliderRow(p: { label: string; testId: string; value: number; min: number; max: number; step: number; decimals: number; unit: string; tooltip: string; onChange: (n: number) => void }) {
  const workbenchText = useText('sketch-and-model-workbench')
  return (
    <div className="relief-row">
      <span className="relief-row-label">{p.label}</span>
      <input
        type="range" className="relief-slider relief-slider-compact" data-testid={`${p.testId}-slider`} aria-label={workbenchText('ReliefPanel.slider', { label: String(p.label) })}
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



/** WO-2174: step-downs - flat floors along the picture's contours (the layered lake / contour sign). */
function StepsSection() {
  const workbenchText = useText('sketch-and-model-workbench')
  const STEP_MODES: Array<[StepDowns['mode'], string]> = [['off', workbenchText('ReliefPanel.off2')], ['levels', workbenchText('ReliefPanel.levels')], ['step', workbenchText('ReliefPanel.fixedStep')]]
  const settings = useReliefStore((s) => s.settings)
  if (settings === null) return null
  const st = settings.steps ?? DEFAULT_STEPS
  const setS = useReliefStore.getState().setSteps
  return (
    <>
      <div className="relief-section-title">
        <span>{workbenchText('ReliefPanel.stepDowns')}</span>
        <span className="relief-hint">{workbenchText('ReliefPanel.flatFloorsAlongTheContours')}</span>
      </div>
      <div className="relief-row">
        <span className="relief-row-label">{workbenchText('ReliefPanel.steps')}</span>
        <span className="relief-seg" role="group" aria-label={workbenchText('ReliefPanel.stepDowns')}>
          {STEP_MODES.map(([id, label]) => (
            <button key={id} type="button" data-testid={`relief-steps-${id}`} className={st.mode === id ? 'active' : ''} onClick={() => setS({ mode: id })}>{label}</button>
          ))}
        </span>
      </div>
      {st.mode !== 'off' && (
        <div className="relief-row">
          {st.mode === 'levels'
            ? <>
                <span className="relief-row-label">{workbenchText('ReliefPanel.levels')}</span>
                <NumericInput
                  value={st.levels} min={1} max={50} step={1} decimals={0}
                  ariaLabel={workbenchText('ReliefPanel.stepLevels')} tooltip={workbenchText('ReliefPanel.howManyFlatFloorsAboveTheZeroPlane1')}
                  onChange={(n) => setS({ levels: n })} style={{ width: '3rem' }}
                />
              </>
            : <>
                <span className="relief-row-label">{workbenchText('ReliefPanel.step')}</span>
                <NumericInput
                  value={st.stepMm} min={0.01} max={50} step={0.25} decimals={2}
                  ariaLabel={workbenchText('ReliefPanel.stepDepth')} tooltip={workbenchText('ReliefPanel.depthOfEachStepMmEveryFloorIsA')}
                  onChange={(n) => setS({ stepMm: n })} style={{ width: '3.6rem' }}
                />
                <span className="relief-unit">{workbenchText('ReliefPanel.mm')}</span>
              </>}
          <span className="relief-row-label relief-row-label-inline">{workbenchText('ReliefPanel.walls')}</span>
          <NumericInput
            value={st.wallDeg} min={5} max={90} step={5} decimals={1}
            ariaLabel={workbenchText('ReliefPanel.wallAngle')} tooltip={workbenchText('ReliefPanel.theWallsBetweenFloorsDegreesFromTheFace90')}
            onChange={(n) => setS({ wallDeg: n })} style={{ width: '3.4rem' }}
          />
          <span className="relief-unit">{workbenchText('ReliefPanel.deg')}</span>
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



function ReliefMapPanel({ session }: { session: ReliefSession }) {
  const workbenchText = useText('sketch-and-model-workbench')
  const VIEWS: Array<[ReliefMapView, string]> = [['image', workbenchText('ReliefPanel.before')], ['adjusted', workbenchText('ReliefPanel.after')], ['compare', workbenchText('ReliefPanel.split')], ['height', workbenchText('ReliefPanel.height')], ['shaded', workbenchText('ReliefPanel.shaded')]]
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
        <span className="relief-seg relief-map-views" role="group" aria-label={workbenchText('ReliefPanel.mapView')}>
          {VIEWS.map(([id, label]) => (
            <button key={id} type="button" data-testid={`relief-view-${id}`} className={view === id ? 'active' : ''} onClick={() => useReliefStore.getState().setMapView(id)}>{label}</button>
          ))}
        </span>
        <canvas ref={mapRef} width={MAP_SIZE} height={MAP_SIZE} className="relief-map" data-testid="relief-map" />
        <div className="relief-hint relief-section-caption">{workbenchText('ReliefPanel.sectionAAMmDashedLineTheFace', { value1: String((depth.toFixed(2)) ?? '') })}</div>
        <canvas ref={sectionRef} width={MAP_SIZE} height={64} className="relief-section" data-testid="relief-section" />
      </div>
    </div>
  )
}
