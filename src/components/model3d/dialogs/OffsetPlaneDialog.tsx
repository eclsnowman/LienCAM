import { useText } from '../../../i18n'
import { useEffect, useMemo, useState } from 'react'
import { DialogShell } from './DialogShell'

export interface OffsetPlaneSourceOption {
  id: string
  label: string
}

/** Which construction plane the dialog makes; one dialog, one preview session, one Apply path. */
export type ConstructionPlaneType = 'offset' | 'midplane' | 'angle'

export interface OffsetPlaneDialogValue {
  sourceId: string
  name: string
  distance: number
  flipNormal: boolean
  /** absent means 'offset' (the dialog's first and default kind) */
  planeType?: ConstructionPlaneType
  /** midplane: the second plane */
  secondSourceId?: string
  /** angle: degrees, turned right-handed about the hinge */
  angleDeg?: number
  /** angle: the source plane's own X or Y axis, or an axis datum (WO-2222) */
  hinge?: 'x' | 'y' | 'axis'
  /** angle about an axis: the axis datum's node id */
  hingeAxisId?: string
}



// WO-030 (UI-107 slice 1): the dialog's live-preview seam, following the
// delivered ShellDialog shape. The intent is geometric only (source + finite
// signed distance) so a half-typed name never kills the plane ghost; the name
// rides along purely as the ghost's label.
export type OffsetPlanePreviewState =
  | { status: 'idle' | 'pending' | 'ready' }
  | { status: 'refused'; message: string }

export interface OffsetPlaneDialogProps {
  mode: 'create' | 'edit'
  sources: readonly OffsetPlaneSourceOption[]
  initialSourceId: string
  initialName: string
  initialDistance: number
  initialFlipNormal: boolean
  planeType?: ConstructionPlaneType
  initialSecondSourceId?: string
  initialAngleDeg?: number
  initialHinge?: 'x' | 'y' | 'axis'
  initialHingeAxisId?: string
  /** Plane at angle: the axis datums it can turn about (WO-2222) */
  axisOptions?: readonly OffsetPlaneSourceOption[]
  onSourceChange?(sourceId: string): void
  onSecondSourceChange?(sourceId: string): void
  onApply(value: OffsetPlaneDialogValue): Promise<string | undefined>
  onClose(): void
  previewState?: OffsetPlanePreviewState
  onPreviewIntent?: (value: OffsetPlaneDialogValue | null) => void
}

export function OffsetPlaneDialog(props: OffsetPlaneDialogProps) {
  const workbenchText = useText('sketch-and-model-workbench')
  const TITLES: Record<ConstructionPlaneType, [string, string]> = {
  offset: [workbenchText('OffsetPlaneDialog.offsetPlane'), workbenchText('OffsetPlaneDialog.editOffsetPlane')],
  midplane: [workbenchText('OffsetPlaneDialog.midplane'), workbenchText('OffsetPlaneDialog.editMidplane')],
  angle: [workbenchText('OffsetPlaneDialog.planeAtAngle'), workbenchText('OffsetPlaneDialog.editPlaneAtAngle')],
}
  const [sourceId, setSourceId] = useState(props.initialSourceId)
  const [name, setName] = useState(props.initialName)
  const [distanceText, setDistanceText] = useState(String(props.initialDistance))
  const [flipNormal, setFlipNormal] = useState(props.initialFlipNormal)
  const planeType: ConstructionPlaneType = props.planeType ?? 'offset'
  const [secondSourceId, setSecondSourceId] = useState(props.initialSecondSourceId ?? '')
  const [angleText, setAngleText] = useState(String(props.initialAngleDeg ?? 30))
  // the hinge choice: 'x', 'y', or 'axis:<axis datum id>'
  const [hingeChoice, setHingeChoice] = useState<string>(
    props.initialHinge === 'axis' && props.initialHingeAxisId !== undefined ? `axis:${props.initialHingeAxisId}` : (props.initialHinge === 'y' ? 'y' : 'x'),
  )
  const hinge: 'x' | 'y' | 'axis' = hingeChoice.startsWith('axis:') ? 'axis' : hingeChoice === 'y' ? 'y' : 'x'
  const hingeAxisId = hinge === 'axis' ? hingeChoice.slice('axis:'.length) : undefined
  // a viewport pick of the second plane arrives as a new prop: adopt it (during render, React's pattern for
  // state that follows a prop)
  const [adoptedSecond, setAdoptedSecond] = useState(props.initialSecondSourceId)
  if (props.initialSecondSourceId !== adoptedSecond) {
    setAdoptedSecond(props.initialSecondSourceId)
    setSecondSourceId(props.initialSecondSourceId ?? '')
  }
  const [error, setError] = useState<string | null>(null)
  const [applying, setApplying] = useState(false)

  useEffect(() => setSourceId(props.initialSourceId), [props.initialSourceId])

  const distance = Number(distanceText)
  const angleDeg = Number(angleText)
  // the one number this kind of plane needs, typed and finite (a midplane needs none)
  const numberReady = planeType === 'midplane'
    ? true
    : planeType === 'angle'
      ? angleText.trim().length > 0 && Number.isFinite(angleDeg)
      : distanceText.trim().length > 0 && Number.isFinite(distance)
  const localError = sourceId.length === 0
    ? workbenchText('OffsetPlaneDialog.chooseASourcePlane')
    : planeType === 'midplane' && secondSourceId.length === 0
      ? workbenchText('OffsetPlaneDialog.chooseTheSecondPlane')
      : name.trim().length === 0
        ? workbenchText('OffsetPlaneDialog.enterAPlaneName')
        : !numberReady
          ? (planeType === 'angle' ? workbenchText('OffsetPlaneDialog.enterAnAngleInDegrees') : workbenchText('OffsetPlaneDialog.enterAFiniteSignedDistance'))
          : null
  const valueOf = (): OffsetPlaneDialogValue => planeType === 'offset'
    ? { sourceId, name: name.trim(), distance, flipNormal }
    : planeType === 'midplane'
      ? { sourceId, name: name.trim(), distance: 0, flipNormal, planeType, secondSourceId }
      : { sourceId, name: name.trim(), distance: 0, flipNormal, planeType, angleDeg, hinge, ...(hingeAxisId === undefined ? {} : { hingeAxisId }) }

  const previewControlled = props.onPreviewIntent !== undefined
  const { onPreviewIntent } = props
  const previewIntent = useMemo<OffsetPlaneDialogValue | null>(() => {
    if (sourceId.length === 0 || !numberReady || (planeType === 'midplane' && secondSourceId.length === 0)) return null
    return valueOf()
    // valueOf reads exactly the state listed here
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceId, name, distance, flipNormal, numberReady, planeType, secondSourceId, angleDeg, hinge, hingeAxisId])

  useEffect(() => {
    onPreviewIntent?.(previewIntent)
  }, [onPreviewIntent, previewIntent])

  const previewRefusal = props.previewState?.status === 'refused' ? props.previewState.message : null
  const applyDisabled = localError !== null || applying ||
    (previewControlled && props.previewState?.status !== 'ready')

  const apply = async (): Promise<void> => {
    if (applyDisabled) return
    setApplying(true)
    setError(null)
    try {
      const refusal = await props.onApply(valueOf())
      if (refusal !== undefined) setError(refusal)
      else props.onClose()
    } finally {
      setApplying(false)
    }
  }

  return (
    <DialogShell
      title={TITLES[planeType][props.mode === 'create' ? 0 : 1]}
      onApply={() => { void apply() }}
      onCancel={props.onClose}
      applyDisabled={applyDisabled}
      floatingPalette
      backdropless
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}>{planeType === 'midplane' ? workbenchText('OffsetPlaneDialog.firstPlane') : workbenchText('OffsetPlaneDialog.sourcePlane')}</span>
          <select
            data-testid="offset-plane-source"
            value={sourceId}
            disabled={props.mode === 'edit' || props.sources.length === 1}
            onChange={(event) => {
              setSourceId(event.target.value)
              props.onSourceChange?.(event.target.value)
            }}
          >
            {props.sources.map((source) => <option key={source.id} value={source.id}>{source.label}</option>)}
          </select>
        </label>
        {planeType === 'midplane' && props.mode === 'edit' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}>{workbenchText('OffsetPlaneDialog.secondPlane')}</span>
            <span data-testid="construction-plane-second-source-name">
              {props.sources.find((source) => source.id === secondSourceId)?.label ?? secondSourceId}
            </span>
          </div>
        )}
        {planeType === 'midplane' && props.mode === 'create' && (
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}>{workbenchText('OffsetPlaneDialog.secondPlane')}</span>
            <select
              data-testid="construction-plane-second-source"
              value={secondSourceId}
              onChange={(event) => {
                setSecondSourceId(event.target.value)
                props.onSecondSourceChange?.(event.target.value)
              }}
            >
              {secondSourceId.length === 0 && <option value="">{workbenchText('OffsetPlaneDialog.clickAFaceOrPlane')}</option>}
              {props.sources.map((source) => <option key={source.id} value={source.id}>{source.label}</option>)}
            </select>
          </label>
        )}
        {props.mode === 'create' && (
          <div
            data-testid="offset-plane-viewport-pick-hint"
            style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}
          >
            {planeType === 'midplane'
              ? workbenchText('OffsetPlaneDialog.pickPlanesClickTwoPlanarModelFacesOrPlanes')
              : workbenchText('OffsetPlaneDialog.pickSourceClickAPlanarModelFaceOrPlane')}
          </div>
        )}
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}>{workbenchText('OffsetPlaneDialog.name')}</span>
          <input data-testid="offset-plane-name" value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        {planeType === 'offset' && (
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}>{workbenchText('OffsetPlaneDialog.signedDistanceMm')}</span>
            <input
              data-testid="offset-plane-distance"
              type="number"
              step="any"
              value={distanceText}
              onChange={(event) => setDistanceText(event.target.value)}
            />
          </label>
        )}
        {planeType === 'angle' && (
          <>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}>{workbenchText('OffsetPlaneDialog.angleDeg')}</span>
              <input
                data-testid="construction-plane-angle"
                type="number"
                step="any"
                value={angleText}
                onChange={(event) => setAngleText(event.target.value)}
              />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}>{workbenchText('OffsetPlaneDialog.turnAbout')}</span>
              <select data-testid="construction-plane-hinge" value={hingeChoice} onChange={(event) => setHingeChoice(event.target.value)}>
                <option value="x">{workbenchText('OffsetPlaneDialog.theSourcePlaneSXAxis')}</option>
                <option value="y">{workbenchText('OffsetPlaneDialog.theSourcePlaneSYAxis')}</option>
                {hingeAxisId !== undefined && !(props.axisOptions ?? []).some((option) => option.id === hingeAxisId) && (
                  <option value={hingeChoice}>{workbenchText('OffsetPlaneDialog.unavailable')}{hingeAxisId}{workbenchText('OffsetPlaneDialog.value')}</option>
                )}
                {(props.axisOptions ?? []).map((option) => <option key={option.id} value={`axis:${option.id}`}>{option.label}</option>)}
              </select>

            </label>
          </>
        )}
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            data-testid="offset-plane-flip-normal"
            type="checkbox"
            checked={flipNormal}
            onChange={(event) => setFlipNormal(event.target.checked)}
          />
          {workbenchText('OffsetPlaneDialog.flipPlaneOrientation')}</label>
        {(localError ?? error) !== null && (
          <div data-testid="offset-plane-error" style={{ color: 'var(--text-danger)' }}>{localError ?? error}</div>
        )}
        {previewRefusal !== null && (
          <div data-testid="offset-plane-preview-refusal" style={{ color: 'var(--text-danger)' }}>{previewRefusal}</div>
        )}
      </div>
    </DialogShell>
  )
}
