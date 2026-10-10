// WO UI-13A: draft dialog -- neutral-plane draft (GEO-4 DraftRequest).
// Faces are picked in-viewport before this dialog opens (see FilletDialog.tsx's
// header for the shared pick-mode rationale, entityKind 'face').
//
// GEO-18: direction may be any world axis or the selected face's real normal.
// The original world -Z path remains the default. Face-normal mode carries the
// viewport's world-space hit frame and constructs the neutral-plane normal
// FROM the pull direction, preserving the kernel's parallel-plane invariant.

import { useEffect, useMemo, useRef, useState } from 'react'
import { GripVertical, X } from 'lucide-react'
import { NumericInput } from '../../ui/NumericInput'
import type { CommandHistory, FeatureDag } from '../../../doc'
import { createFeatureCommand } from './createFeatureCommand'
import { EditFeaturePayloadCommand } from './EditFeaturePayloadCommand'
import { nextId } from './nextId'
import {
  DRAFT_PULL_DIR,
  decomposePrincipalAxis,
  draftFaceNormalPlane,
  draftPullDir,
  type DraftFaceFrame,
  type PathAxis,
} from './dressUpGeometry'

export type DraftPullMode = 'axis' | 'face-normal'

export interface DraftFeaturePayload {
  opType: 'draft'
  ownerId: string
  faces: string[]
  angleDeg: number
  /** WO UI-16 (C2): principal pull axis + flip -- the DraftRequest's real
   *  pullDir/neutralPlane are derived from these at the executor (dressUpGeometry.ts's
   *  draftPullDir/draftNeutralPlane), never carried as raw vectors here (the
   *  payload stays the small, serializable "what the user chose" shape every
   *  other dialog payload already is). */
  pullAxis: PathAxis
  pullFlip: boolean
  /** Missing on legacy payloads, which replay through the unchanged axis path. */
  pullMode?: DraftPullMode
  /** Present only for face-normal mode. */
  faceFrame?: DraftFaceFrame
  /** First selected face: reference-only in face-normal mode, never drafted. */
  faceFrameSourceId?: string
  /** Plane offset (mm) along the chosen pull axis from the world origin. */
  offset: number
  name: string
}

export interface DraftPreviewIntent {
  readonly featureId: string
  readonly payload: DraftFeaturePayload
}

export type DraftPreviewState =
  | { readonly status: 'idle' }
  | { readonly status: 'pending' }
  | { readonly status: 'ready' }
  | { readonly status: 'refused'; readonly message: string }

interface DraftDialogCommonProps {
  dag: FeatureDag
  history: CommandHistory
  onApplied(featureId: string): void
  onClose(): void
  previewState?: DraftPreviewState
  onPreviewIntent?: (intent: DraftPreviewIntent | null) => void
  onApplyPreview?: (intent: DraftPreviewIntent) => Promise<string | undefined>
}

export type DraftDialogProps = DraftDialogCommonProps & (
  | {
      mode: 'create'
      ownerId?: string
      faceIds: string[]
      selectedFaceFrame?: DraftFaceFrame
      /** UI-91: present only while the page owns the explicit two-step
       * viewport workflow. Standalone/legacy callers remain ready-to-apply. */
      selectionStep?: 'neutral' | 'faces'
      onConfirmNeutral?: () => void
      onReselectNeutral?: () => void
      /** Controlled page path: scratch preview intent, never a live command. */
      previewFeatureId?: string
      featureId?: never
    }
  | {
      mode: 'edit'
      featureId: string
      ownerId?: never
      faceIds?: never
      selectedFaceFrame?: never
      selectionStep?: never
      onConfirmNeutral?: never
      onReselectNeutral?: never
      previewFeatureId?: never
    }
)

const DEFAULT_ANGLE = 5
const AXIS_LABEL: Record<PathAxis, string> = { x: 'X', y: 'Y', z: 'Z' }

function isPathAxis(value: unknown): value is PathAxis {
  return value === 'x' || value === 'y' || value === 'z'
}

function readFaceFrame(value: unknown): DraftFaceFrame | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as Partial<DraftFaceFrame>
  if (typeof candidate.origin !== 'object' || candidate.origin === null || typeof candidate.normal !== 'object' || candidate.normal === null) return undefined
  const origin = candidate.origin as Partial<DraftFaceFrame['origin']>
  const normal = candidate.normal as Partial<DraftFaceFrame['normal']>
  if (![origin.x, origin.y, origin.z, normal.x, normal.y, normal.z].every((component) => typeof component === 'number' && Number.isFinite(component))) return undefined
  return {
    origin: { x: origin.x!, y: origin.y!, z: origin.z! },
    normal: { x: normal.x!, y: normal.y!, z: normal.z! },
  }
}

function editReferenceError(dag: FeatureDag, featureId: string): string | undefined {
  const node = dag.getNode(featureId)
  if (node === undefined || node.kind !== 'feature' || node.payload.opType !== 'draft') {
    return `Draft edit refused: '${featureId}' is not a draft feature`
  }
  const ownerId = node.payload.ownerId
  if (typeof ownerId !== 'string' || ownerId.length === 0 || dag.getNode(ownerId) === undefined) {
    return `Draft edit refused: owner '${String(ownerId)}' is not available`
  }
  if (!node.consumes.includes(ownerId)) {
    return `Draft edit refused: owner '${ownerId}' is missing from the feature dependencies`
  }
  const order = dag.featureOrder()
  if (order.indexOf(ownerId) < 0 || order.indexOf(ownerId) >= order.indexOf(featureId)) {
    return `Draft edit refused: owner '${ownerId}' is not an upstream feature`
  }
  const faces = node.payload.faces
  if (!Array.isArray(faces) || faces.length === 0 || faces.some((id) => typeof id !== 'string' || id.length === 0)) {
    return `Draft edit refused: '${featureId}' has no valid face references`
  }
  if (typeof node.payload.angleDeg !== 'number' || !Number.isFinite(node.payload.angleDeg) || node.payload.angleDeg <= 0 || node.payload.angleDeg >= 90) {
    return `Draft edit refused: '${featureId}' has an invalid angle`
  }
  if (node.payload.pullMode !== undefined && node.payload.pullMode !== 'axis' && node.payload.pullMode !== 'face-normal') {
    return `Draft edit refused: '${featureId}' has an invalid pull mode`
  }
  if (node.payload.pullAxis !== undefined && !isPathAxis(node.payload.pullAxis)) {
    return `Draft edit refused: '${featureId}' has an invalid pull axis`
  }
  if (node.payload.pullFlip !== undefined && typeof node.payload.pullFlip !== 'boolean') {
    return `Draft edit refused: '${featureId}' has an invalid pull direction`
  }
  if (node.payload.offset !== undefined && (typeof node.payload.offset !== 'number' || !Number.isFinite(node.payload.offset))) {
    return `Draft edit refused: '${featureId}' has an invalid neutral-plane offset`
  }
  if (node.payload.pullMode === 'face-normal') {
    const sourceId = node.payload.faceFrameSourceId
    if (typeof sourceId !== 'string' || sourceId.length === 0 || faces.includes(sourceId)) {
      return `Draft edit refused: '${featureId}' has an invalid neutral-face reference`
    }
    const frame = readFaceFrame(node.payload.faceFrame)
    if (frame === undefined || !draftFaceNormalPlane(frame, node.payload.pullFlip === true, typeof node.payload.offset === 'number' ? node.payload.offset : 0).ok) {
      return `Draft edit refused: '${featureId}' has an invalid neutral-face frame`
    }
  }
  return undefined
}

export function DraftDialog(props: DraftDialogProps) {
  const { dag, history, onApplied, onClose } = props
  const editing = props.mode === 'edit'
  const existing = editing ? dag.getNode(props.featureId) : undefined
  const existingPayload = existing?.payload
  const defaultPull = decomposePrincipalAxis(DRAFT_PULL_DIR)
  const initialPullMode: DraftPullMode = editing && existingPayload?.pullMode === 'face-normal' ? 'face-normal' : 'axis'
  const existingFaces = editing && Array.isArray(existingPayload?.faces) ? existingPayload.faces as string[] : []
  const faceIds = editing
    ? (initialPullMode === 'face-normal' && typeof existingPayload?.faceFrameSourceId === 'string'
      ? [existingPayload.faceFrameSourceId, ...existingFaces]
      : existingFaces)
    : props.faceIds
  const selectedFaceFrame = editing ? readFaceFrame(existingPayload?.faceFrame) : props.selectedFaceFrame
  const initialAngle = editing && typeof existingPayload?.angleDeg === 'number' && Number.isFinite(existingPayload.angleDeg) ? existingPayload.angleDeg : DEFAULT_ANGLE
  const initialAxis = editing && isPathAxis(existingPayload?.pullAxis) ? existingPayload.pullAxis : defaultPull.axis
  const initialFlip = editing && typeof existingPayload?.pullFlip === 'boolean' ? existingPayload.pullFlip : defaultPull.flip
  const initialOffset = editing && typeof existingPayload?.offset === 'number' && Number.isFinite(existingPayload.offset) ? existingPayload.offset : 0
  const workflowManaged = !editing && props.selectionStep !== undefined
  const [angleDeg, setAngleDeg] = useState<number>(initialAngle)
  const [pullAxis, setPullAxis] = useState<PathAxis>(initialAxis)
  const [pullFlip, setPullFlip] = useState<boolean>(workflowManaged ? false : initialFlip)
  const [pullMode, setPullMode] = useState<DraftPullMode>(workflowManaged ? 'face-normal' : initialPullMode)
  const [offset, setOffset] = useState<number>(initialOffset)
  const [applyError, setApplyError] = useState<string | undefined>(undefined)
  const [applying, setApplying] = useState(false)

  const referenceError = editing ? editReferenceError(dag, props.featureId) : undefined
  const faceDirection = draftFaceNormalPlane(selectedFaceFrame, pullFlip, offset)
  const neutralRequired = workflowManaged || pullMode === 'face-normal'
  const draftFaceIds = neutralRequired ? faceIds.slice(1) : faceIds
  const faceSelectionError =
    neutralRequired && faceIds.length < 2
      ? 'Select a neutral face first, then at least one additional face to draft.'
      : undefined
  const invalid =
    referenceError !== undefined ||
    (!editing && props.ownerId === undefined) ||
    draftFaceIds.length === 0 ||
    !Number.isFinite(angleDeg) ||
    angleDeg <= 0 ||
    angleDeg >= 90 ||
    !Number.isFinite(offset) ||
    (workflowManaged && props.selectionStep !== 'faces') ||
    (pullMode === 'face-normal' && (!faceDirection.ok || faceSelectionError !== undefined))
  const previewControlled = props.onPreviewIntent !== undefined
  const previewIntentSink = props.onPreviewIntent
  const previewFeatureId = editing ? props.featureId : (props.previewFeatureId ?? nextId(dag, 'F'))
  const previewOwnerId = editing
    ? (typeof existingPayload?.ownerId === 'string' ? existingPayload.ownerId : undefined)
    : props.ownerId
  const faceIdsKey = faceIds.join('\u0000')
  const selectedFaceFrameKey = selectedFaceFrame === undefined
    ? ''
    : [
        selectedFaceFrame.origin.x,
        selectedFaceFrame.origin.y,
        selectedFaceFrame.origin.z,
        selectedFaceFrame.normal.x,
        selectedFaceFrame.normal.y,
        selectedFaceFrame.normal.z,
      ].join('\u0000')
  const previewIntent = useMemo<DraftPreviewIntent | null>(() => {
    if (invalid || previewOwnerId === undefined) return null
    const stableFaceIds = faceIdsKey.length === 0 ? [] : faceIdsKey.split('\u0000')
    const stableDraftFaceIds = neutralRequired ? stableFaceIds.slice(1) : stableFaceIds
    return {
      featureId: previewFeatureId,
      payload: {
        opType: 'draft',
        ownerId: previewOwnerId,
        faces: stableDraftFaceIds,
        angleDeg,
        pullAxis,
        pullFlip,
        pullMode,
        ...(pullMode === 'face-normal'
          ? { faceFrame: selectedFaceFrame, faceFrameSourceId: stableFaceIds[0] }
          : {}),
        offset,
        name: editing && typeof existingPayload?.name === 'string'
          ? existingPayload.name
          : `Draft ${previewFeatureId}`,
      },
    }
  }, [angleDeg, editing, existingPayload?.name, faceIdsKey, invalid, neutralRequired, offset, previewFeatureId, previewOwnerId, pullAxis, pullFlip, pullMode, selectedFaceFrameKey])

  useEffect(() => {
    previewIntentSink?.(previewIntent)
  }, [previewIntent, previewIntentSink])

  const cardRef = useRef<HTMLElement | null>(null)
  const dragRef = useRef<{ pointerId: number; offsetX: number; offsetY: number } | null>(null)
  const [cardPosition, setCardPosition] = useState(() => ({
    x: Math.min(288, Math.max(12, (typeof window === 'undefined' ? 1024 : window.innerWidth) - 356)),
    y: 76,
  }))

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !applying) onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [applying, onClose])

  useEffect(() => {
    const onPointerMove = (event: PointerEvent): void => {
      const drag = dragRef.current
      if (drag === null || drag.pointerId !== event.pointerId) return
      const bounds = cardRef.current?.getBoundingClientRect()
      const width = bounds?.width ?? 344
      const height = bounds?.height ?? 420
      setCardPosition({
        x: Math.max(8, Math.min(window.innerWidth - width - 8, event.clientX - drag.offsetX)),
        y: Math.max(8, Math.min(window.innerHeight - height - 8, event.clientY - drag.offsetY)),
      })
    }
    const stopDrag = (event: PointerEvent): void => {
      if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null
    }
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', stopDrag)
    window.addEventListener('pointercancel', stopDrag)
    return () => {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', stopDrag)
      window.removeEventListener('pointercancel', stopDrag)
    }
  }, [])

  const beginCardDrag = (event: React.PointerEvent<HTMLElement>): void => {
    if ((event.target as HTMLElement).closest('button, input, select') !== null) return
    const bounds = cardRef.current?.getBoundingClientRect()
    if (bounds === undefined) return
    dragRef.current = {
      pointerId: event.pointerId,
      offsetX: event.clientX - bounds.left,
      offsetY: event.clientY - bounds.top,
    }
    event.preventDefault()
  }

  const handleApply = async (): Promise<void> => {
    if (invalid || applying) return
    setApplyError(undefined)
    if (props.onApplyPreview !== undefined && previewIntent !== null) {
      setApplying(true)
      try {
        const error = await props.onApplyPreview(previewIntent)
        if (error !== undefined) {
          setApplyError(error)
          return
        }
        onApplied(previewIntent.featureId)
        onClose()
        return
      } finally {
        setApplying(false)
      }
    }
    if (editing) {
      const live = dag.getNode(props.featureId)
      const liveReferenceError = editReferenceError(dag, props.featureId)
      if (live === undefined || liveReferenceError !== undefined) {
        setApplyError(liveReferenceError ?? `Draft edit refused: '${props.featureId}' is no longer available`)
        return
      }
      const nextPayload: Record<string, unknown> = {
        ...live.payload,
        faces: pullMode === 'face-normal' ? faceIds.slice(1) : faceIds,
        angleDeg,
        pullAxis,
        pullFlip,
        pullMode,
        offset,
      }
      if (pullMode === 'face-normal') {
        nextPayload.faceFrame = selectedFaceFrame
        nextPayload.faceFrameSourceId = faceIds[0]
      } else {
        delete nextPayload.faceFrame
        delete nextPayload.faceFrameSourceId
      }
      try {
        history.execute(new EditFeaturePayloadCommand(props.featureId, nextPayload, live.consumes))
      } catch (err) {
        setApplyError(err instanceof Error ? err.message : String(err))
        return
      }
      onApplied(props.featureId)
      onClose()
      return
    }

    const id = previewFeatureId
    if (props.ownerId === undefined) return
    const payload = previewIntent?.payload
    if (payload === undefined) return
    try {
      history.execute(createFeatureCommand(dag, { id, kind: 'feature', consumes: [props.ownerId], payload: { ...payload } }))
    } catch (err) {
      setApplyError(err instanceof Error ? err.message : String(err))
      return
    }
    onApplied(id)
    onClose()
  }

  const pullDir = pullMode === 'face-normal' && faceDirection.ok ? faceDirection.pullDir : draftPullDir(pullAxis, pullFlip)
  const sign = pullFlip ? '-' : '+'
  const fmt = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(2))

  return (
    <aside
      ref={cardRef}
      className="draft-command-card"
      data-testid="draft-command-card"
      data-primary-interaction="viewport-pick"
      data-ui78-sanctioned=""
      aria-labelledby="draft-command-title"
      style={{ left: cardPosition.x, top: cardPosition.y }}
    >
      <header className="draft-command-header" onPointerDown={beginCardDrag}>
        <GripVertical size={14} aria-hidden="true" />
        <div className="draft-command-heading">
          <span className="draft-command-kicker">Draft faces</span>
          <strong id="draft-command-title">{editing ? 'Edit draft' : 'Select neutral face, then draft faces'}</strong>
        </div>
        <button type="button" className="modal-close-btn" aria-label="Cancel draft" data-testid="dialog-shell-close" disabled={applying} onClick={onClose}>
          <X size={14} />
        </button>
      </header>
      <div className="draft-command-body">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {neutralRequired ? <div className="draft-role-list">
          <div
            data-testid="draft-neutral-face-role"
            className="draft-role-row"
            data-state={faceIds.length === 0 ? 'active' : workflowManaged && props.selectionStep === 'neutral' ? 'ready' : 'complete'}
          >
            <span className="draft-role-index">1</span>
            <span><strong>Neutral face</strong><small>{faceIds.length === 0 ? 'Click a face in the viewport' : workflowManaged && props.selectionStep === 'neutral' ? 'Selected - confirm this role' : 'Confirmed'}</small></span>
          </div>
          <div
            data-testid="draft-face-role"
            className="draft-role-row"
            data-state={workflowManaged && props.selectionStep !== 'faces' ? 'pending' : draftFaceIds.length === 0 ? 'active' : 'ready'}
          >
            <span className="draft-role-index">2</span>
            <span><strong>Draft faces</strong><small>{draftFaceIds.length} draft face{draftFaceIds.length === 1 ? '' : 's'} selected</small></span>
          </div>
        </div> : (
          <div className="draft-role-row" data-state="ready">
            <span className="draft-role-index">1</span>
            <span><strong>Draft faces</strong><small>{draftFaceIds.length} face{draftFaceIds.length === 1 ? '' : 's'} selected</small></span>
          </div>
        )}
        {workflowManaged && props.selectionStep === 'neutral' && (
          <button
            type="button"
            className="modal-btn modal-btn-primary"
            data-testid="draft-confirm-neutral"
            disabled={applying || faceIds.length === 0 || !faceDirection.ok}
            onClick={props.onConfirmNeutral}
          >
            Confirm neutral face
          </button>
        )}
        {workflowManaged && props.selectionStep === 'faces' && (
          <button type="button" className="modal-btn modal-btn-ghost" data-testid="draft-reselect-neutral" disabled={applying} onClick={props.onReselectNeutral}>
            Reselect neutral face
          </button>
        )}
        <div data-testid="draft-face-count" style={{ color: 'var(--text-muted)' }}>
          {neutralRequired
            ? `${faceIds.length === 0 ? '0 neutral faces' : '1 neutral face'}, ${Math.max(0, faceIds.length - 1)} draft face${faceIds.length === 2 ? '' : 's'}`
            : `${faceIds.length} face${faceIds.length === 1 ? '' : 's'} selected`}
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 70, color: 'var(--text-muted)' }}>Direction</span>
          {workflowManaged ? (
            <span data-testid="draft-pull-axis" data-value="face-normal" style={{ flex: 1, color: 'var(--text-primary)' }}>
              Neutral face normal
            </span>
          ) : (
            <select
              data-testid="draft-pull-axis"
              disabled={applying}
              value={pullMode === 'face-normal' ? 'face-normal' : pullAxis}
              onChange={(e) => {
                const value = e.target.value
                if (value === 'face-normal') {
                  setPullMode('face-normal')
                  setPullFlip(false)
                }
                else {
                  setPullMode('axis')
                  setPullAxis(value as PathAxis)
                }
              }}
              style={{ flex: 1 }}
            >
              <option
                value="face-normal"
                disabled={!faceDirection.ok}
                data-tooltip={faceDirection.ok ? undefined : faceDirection.reason}
                data-testid="draft-pull-axis-option-face-normal"
              >
                First selected face normal{faceDirection.ok ? '' : ' (unavailable)'}
              </option>
              {(['x', 'y', 'z'] as const).map((axis) => (
                <option
                  key={axis}
                  value={axis}
                  data-testid={`draft-pull-axis-option-${axis}`}
                >
                  {AXIS_LABEL[axis]}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            data-testid="draft-pull-flip"
            disabled={applying}
            className={pullFlip ? 'modal-btn modal-btn-primary' : 'modal-btn modal-btn-ghost'}
            onClick={() => setPullFlip((f) => !f)}
          >
            Flip
          </button>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 70, color: 'var(--text-muted)' }}>Offset</span>
          <span data-testid="draft-offset" style={{ flex: 1 }}>
            <NumericInput value={offset} onChange={setOffset} disabled={applying} style={{ width: '100%' }} />
          </span>
          <span style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}>mm</span>
        </label>
        <div data-testid="draft-pull-summary" style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}>
          {pullMode === 'face-normal'
            ? `Pull direction: selected face ${pullFlip ? '(flipped) ' : ''}normal (${fmt(pullDir.x)}, ${fmt(pullDir.y)}, ${fmt(pullDir.z)}), neutral plane offset ${fmt(offset)} mm from that face`
            : `Pull direction: world ${sign}${AXIS_LABEL[pullAxis]} (${fmt(pullDir.x)}, ${fmt(pullDir.y)}, ${fmt(pullDir.z)}), neutral plane offset ${fmt(offset)} mm along that axis`}
        </div>
        {!faceDirection.ok && (
          <div data-testid="draft-face-frame-error" style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}>
            {workflowManaged
              ? faceIds.length === 0
                ? 'Click a neutral face in the viewport to define the draft direction.'
                : 'The neutral face direction is unavailable. Re-pick a valid neutral face.'
              : faceDirection.reason}
          </div>
        )}
        {faceSelectionError !== undefined && (
          <div data-testid="draft-face-selection-error" style={{ color: 'var(--text-danger)', fontSize: 'var(--font-size-sm)' }}>
            {faceSelectionError}
          </div>
        )}
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 70, color: 'var(--text-muted)' }}>Angle</span>
          <span data-testid="draft-angle" style={{ flex: 1 }}>
            <NumericInput value={angleDeg} onChange={setAngleDeg} min={0.1} max={89.9} disabled={applying} style={{ width: '100%' }} />
          </span>
          <span style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}>deg</span>
        </label>
        {referenceError !== undefined && (
          <div data-testid="draft-reference-error" style={{ color: 'var(--text-danger)', fontSize: 'var(--font-size-sm)' }}>
            {referenceError}
          </div>
        )}
        {applyError !== undefined && (
          <div data-testid="draft-apply-error" style={{ color: 'var(--text-danger)', fontSize: 'var(--font-size-sm)' }}>
            {applyError}
          </div>
        )}
        {previewControlled && props.previewState?.status === 'pending' && (
          <div data-testid="draft-preview-status" data-status="pending" style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}>
            Updating preview...
          </div>
        )}
        {previewControlled && props.previewState?.status === 'ready' && (
          <div data-testid="draft-preview-status" data-status="ready" style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}>
            Preview ready
          </div>
        )}
        {previewControlled && props.previewState?.status === 'refused' && (
          <div data-testid="draft-preview-status" data-status="refused" style={{ color: 'var(--text-danger)', fontSize: 'var(--font-size-sm)' }}>
            {props.previewState.message}
          </div>
        )}
      </div>
      </div>
      <footer className="draft-command-footer">
        <button type="button" className="modal-btn modal-btn-ghost" data-testid="dialog-shell-cancel" disabled={applying} onClick={onClose}>Cancel</button>
        <button
          type="button"
          className="modal-btn modal-btn-primary"
          data-testid="dialog-shell-apply"
          disabled={applying || invalid || (previewControlled && props.previewState?.status !== 'ready')}
          onClick={() => { void handleApply() }}
        >Apply</button>
      </footer>
    </aside>
  )
}
