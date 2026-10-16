import { readableInternalIds } from '../../../lib/operatorLabels'
// WO UI-13A: chamfer dialog -- same shape and rationale as FilletDialog.tsx
// (see its header), swapped for ChamferRequest's `distance` field. Equal-
// distance chamfer only (GEO-4 v0.4's own scope; distance-angle/two-distance
// variants are a later optional append per geom-service.ts).

import { useText, textFor } from '../../../i18n'
const workbenchText = textFor('sketch-and-model-workbench')
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, X } from 'lucide-react'
import { useSelectAllOnClick } from '../../ui/selectAllOnClick'
import { useTypeToSet } from '../../ui/useTypeToSet'
import type { CommandHistory, FeatureDag } from '../../../doc'
import { isTypingTarget } from '../../../lib/sketch/tools/shortcuts'
import { createFeatureCommand } from './createFeatureCommand'
import { EditFeaturePayloadCommand } from './EditFeaturePayloadCommand'
import { nextId } from './nextId'

export interface ChamferFeaturePayload {
  opType: 'chamfer'
  ownerId: string
  edges: string[]
  distance: number
  propagateTangent: true
  name: string
}

export interface ChamferPreviewIntent {
  featureId: string
  payload: ChamferFeaturePayload
}

export type ChamferPreviewState =
  | { status: 'idle' | 'pending' | 'ready' }
  | { status: 'refused'; message: string }

interface ChamferDialogCommonProps {
  dag: FeatureDag
  history: CommandHistory
  onApplied(featureId: string): void
  onClose(): void
  previewState?: ChamferPreviewState
  onPreviewIntent?: (intent: ChamferPreviewIntent | null) => void
  onApplyPreview?: (intent: ChamferPreviewIntent) => Promise<string | undefined>
  hoverReadout?: string
  /** WO-2766: the distance a create opens on - an imported chamfer's own
   *  measured distance, so the field starts on the truth. Defaults to
   *  DEFAULT_DISTANCE. */
  initialDistance?: number
}

export type ChamferDialogProps = ChamferDialogCommonProps & (
  | { mode: 'create'; ownerId?: string; edgeIds: string[]; previewFeatureId?: string; featureId?: never }
  | { mode: 'edit'; featureId: string; selectedEdgeIds: string[]; ownerId?: never; edgeIds?: never }
)

const DEFAULT_DISTANCE = 2

function editReferenceError(dag: FeatureDag, featureId: string): string | undefined {
  const node = dag.getNode(featureId)
  if (node === undefined || node.kind !== 'feature' || node.payload.opType !== 'chamfer') {
    return workbenchText('ChamferDialog.chamferEditRefusedIsNotAChamferFeature', { featureId: String(featureId) })
  }
  const ownerId = node.payload.ownerId
  if (typeof ownerId !== 'string' || ownerId.length === 0 || dag.getNode(ownerId) === undefined) {
    return workbenchText('ChamferDialog.chamferEditRefusedOwnerIsNotAvailable', { value1: String(String(ownerId)) })
  }
  if (!node.consumes.includes(ownerId)) {
    return workbenchText('ChamferDialog.chamferEditRefusedOwnerIsMissingFromTheFeature', { ownerId: String(ownerId) })
  }
  const order = dag.featureOrder()
  if (order.indexOf(ownerId) < 0 || order.indexOf(ownerId) >= order.indexOf(featureId)) {
    return workbenchText('ChamferDialog.chamferEditRefusedOwnerIsNotAnUpstreamFeature', { ownerId: String(ownerId) })
  }
  if (!Array.isArray(node.payload.edges) || node.payload.edges.length === 0 || node.payload.edges.some((id) => typeof id !== 'string' || id.length === 0)) {
    return workbenchText('ChamferDialog.chamferEditRefusedHasNoValidEdgeReferences', { featureId: String(featureId) })
  }
  if (typeof node.payload.distance !== 'number' || !Number.isFinite(node.payload.distance) || node.payload.distance <= 0) {
    return workbenchText('ChamferDialog.chamferEditRefusedHasAnInvalidDistance', { featureId: String(featureId) })
  }
  return undefined
}

export function ChamferDialog(props: ChamferDialogProps) {
  const workbenchText = useText('sketch-and-model-workbench')
  const { dag, history, onApplied, onClose } = props
  const editing = props.mode === 'edit'
  const existing = editing ? dag.getNode(props.featureId) : undefined
  const edgeIds = editing ? props.selectedEdgeIds : props.edgeIds
  const initialDistance = editing && typeof existing?.payload.distance === 'number' ? existing.payload.distance : (props.initialDistance ?? DEFAULT_DISTANCE)
  const [distanceDraft, setDistanceDraft] = useState(() => String(initialDistance))
  const [applyError, setApplyError] = useState<string | undefined>(undefined)
  const [applying, setApplying] = useState(false)
  const applyingRef = useRef(false)
  const distanceInputRef = useRef<HTMLInputElement | null>(null)
  const selectAllDistance = useSelectAllOnClick()
  useTypeToSet(distanceInputRef, { enabled: true })
  const distance = distanceDraft.trim().length === 0 ? Number.NaN : Number(distanceDraft)

  const referenceError = editing ? editReferenceError(dag, props.featureId) : undefined
  const previewControlled = props.onPreviewIntent !== undefined
  const previewFeatureId = editing ? props.featureId : (props.previewFeatureId ?? nextId(dag, 'F'))
  const previewOwnerId = editing
    ? (typeof existing?.payload.ownerId === 'string' ? existing.payload.ownerId : undefined)
    : props.ownerId
  const invalid = referenceError !== undefined || previewOwnerId === undefined || edgeIds.length === 0 || !Number.isFinite(distance) || distance <= 0
  const applyDisabled = applying || invalid || (previewControlled && props.previewState?.status !== 'ready')
  const edgeIdsKey = edgeIds.join('\u0000')
  const previewIntent = useMemo<ChamferPreviewIntent | null>(() => {
    if (invalid || previewOwnerId === undefined) return null
    return {
      featureId: previewFeatureId,
      payload: {
        opType: 'chamfer',
        ownerId: previewOwnerId,
        edges: edgeIdsKey.length === 0 ? [] : edgeIdsKey.split('\u0000'),
        distance,
        propagateTangent: true,
        name: editing && typeof existing?.payload.name === 'string'
          ? existing.payload.name
          : workbenchText('ChamferDialog.chamfer', { previewFeatureId: String(previewFeatureId) }),
      },
    }
  }, [distance, edgeIdsKey, editing, existing?.payload.name, invalid, previewFeatureId, previewOwnerId])

  useEffect(() => {
    props.onPreviewIntent?.(previewIntent)
  }, [previewIntent, props.onPreviewIntent])

  const handleClose = useCallback((): void => {
    if (!applyingRef.current) onClose()
  }, [onClose])

  const handleApply = useCallback(async (): Promise<void> => {
    if (invalid || applyingRef.current) return
    setApplyError(undefined)
    if (props.onApplyPreview !== undefined && previewIntent !== null) {
      applyingRef.current = true
      setApplying(true)
      try {
        const error = await props.onApplyPreview(previewIntent)
        if (error !== undefined) {
          setApplyError(error)
          return
        }
        onClose()
        return
      } catch (error) {
        setApplyError(workbenchText('ChamferDialog.chamferApplyRefused', { value1: String(error instanceof Error ? error.message : String(error)) }))
        return
      } finally {
        applyingRef.current = false
        setApplying(false)
      }
    }
    if (editing) {
      const live = dag.getNode(props.featureId)
      const liveReferenceError = editReferenceError(dag, props.featureId)
      if (live === undefined || liveReferenceError !== undefined) {
        setApplyError(liveReferenceError ?? workbenchText('ChamferDialog.chamferEditRefusedIsNoLongerAvailable', { featureId: String(props.featureId) }))
        return
      }
      try {
        history.execute(new EditFeaturePayloadCommand(
          props.featureId,
          { ...live.payload, edges: [...edgeIds], distance },
          live.consumes,
          [],
        ))
      } catch (err) {
        setApplyError(err instanceof Error ? err.message : String(err))
        return
      }
      onApplied(props.featureId)
      onClose()
      return
    }

    const ownerId = props.ownerId
    if (ownerId === undefined) return
    const id = nextId(dag, 'F')
    const payload = { opType: 'chamfer', ownerId, edges: props.edgeIds, distance, propagateTangent: true, name: workbenchText('ChamferDialog.chamfer2', { id: String(id) }) }
    try {
      history.execute(createFeatureCommand(dag, { id, kind: 'feature', consumes: [ownerId], payload }))
    } catch (err) {
      setApplyError(err instanceof Error ? err.message : String(err))
      return
    }
    onApplied(id)
    onClose()
  }, [dag, distance, edgeIds, editing, history, invalid, onApplied, onClose, previewIntent, props])

  useEffect(() => {
    const onPaletteKeyDown = (event: KeyboardEvent): void => {
      const activeOwner = document.activeElement
      if (isTypingTarget(event.target) || isTypingTarget(activeOwner)) return
      if (event.key === 'Enter') {
        if (!applyDisabled) {
          event.preventDefault()
          void handleApply()
        }
        return
      }
    }
    window.addEventListener('keydown', onPaletteKeyDown)
    return () => window.removeEventListener('keydown', onPaletteKeyDown)
  }, [applyDisabled, handleApply])

  return (
    <div
      className={`sketch-confirm-overlay fillet-command-strip${props.previewState?.status === 'refused' || referenceError !== undefined || applyError !== undefined ? ' fillet-command-strip--refusal' : ''}`}
      data-testid="chamfer-workspace-palette"
      data-preview-status={props.previewState?.status ?? 'idle'}
      role="toolbar"
      aria-label={editing ? workbenchText('ChamferDialog.editChamferCommand') : workbenchText('ChamferDialog.chamferCommand')}
    >
      <span className="sketch-confirm-title">{workbenchText('ChamferDialog.chamfer3')}</span>
      <span className="sketch-confirm-info" data-testid="chamfer-edge-count">
        {workbenchText('ChamferDialog.edgeSelected', { length: String((edgeIds.length) ?? ''), value2: String((edgeIds.length === 1 ? '' : 's')) })}</span>
      <span className="sketch-confirm-hint" data-testid="chamfer-edge-instruction">
        {edgeIds.length === 0 ? workbenchText('ChamferDialog.selectEdgesInTheViewport') : workbenchText('ChamferDialog.clickEdgesToAddOrRemove')}
      </span>
      {props.hoverReadout !== undefined && (
        <span
          className="fillet-command-hover"
          data-testid="solids-workbench-hover-readout"
          data-tooltip={props.hoverReadout}
        >
          {props.hoverReadout}
        </span>
      )}
      <label className="sketch-confirm-field">
        <span>{workbenchText('ChamferDialog.distance')}</span>
        <span data-testid="chamfer-distance">
          <input
            ref={distanceInputRef}
            type="text"
            inputMode="decimal"
            aria-label={workbenchText('ChamferDialog.chamferDistance')}
            value={distanceDraft}
            min={0.1}
            disabled={applying}
            onChange={(event) => setDistanceDraft(event.currentTarget.value)}
            onFocus={selectAllDistance.onFocus}
            onMouseUp={selectAllDistance.onMouseUp}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                event.stopPropagation()
                if (!applyDisabled) void handleApply()
              } else if (event.key === 'Escape') {
                event.preventDefault()
                event.stopPropagation()
                handleClose()
              }
            }}
          />
        </span>
        <span className="sketch-confirm-unit">{workbenchText('ChamferDialog.mm')}</span>
      </label>
      {referenceError !== undefined && (
        <span
          className="fillet-command-status fillet-command-status--error"
          data-testid="chamfer-reference-error"
          data-tooltip={readableInternalIds(referenceError)}
          aria-live="polite"
        >
          {readableInternalIds(referenceError)}
        </span>
      )}
      {applyError !== undefined && (
        <span
          className="fillet-command-status fillet-command-status--error"
          data-testid="chamfer-apply-error"
          data-tooltip={readableInternalIds(applyError)}
          aria-live="polite"
        >
          {readableInternalIds(applyError)}
        </span>
      )}
      {previewControlled && props.previewState?.status === 'pending' && (
        <span className="fillet-command-status" data-testid="chamfer-preview-status" data-status="pending" aria-live="polite">
          {workbenchText('ChamferDialog.updating')}</span>
      )}
      {previewControlled && props.previewState?.status === 'ready' && (
        <span className="fillet-command-status" data-testid="chamfer-preview-status" data-status="ready" aria-live="polite">
          {workbenchText('ChamferDialog.ready')}</span>
      )}
      {previewControlled && props.previewState?.status === 'refused' && (
        <span
          className="fillet-command-status fillet-command-status--error"
          data-testid="chamfer-preview-status"
          data-status="refused"
          data-tooltip={readableInternalIds(props.previewState.message)}
          aria-live="polite"
        >
          {readableInternalIds(props.previewState.message)}
        </span>
      )}
      <span className="sketch-confirm-actions">
        <button
          type="button"
          className="sketch-prompt-btn sketch-prompt-btn-confirm"
          data-testid="dialog-shell-apply"
          aria-label={workbenchText('ChamferDialog.applyChamfer')}
          data-tooltip={workbenchText('ChamferDialog.applyChamferEnter')}
          disabled={applyDisabled}
          onClick={() => { void handleApply() }}
        >
          <Check size={12} aria-hidden="true" />
          <span>{workbenchText('ChamferDialog.apply')}</span>
        </button>
        <button
          type="button"
          className="sketch-prompt-btn"
          data-testid="dialog-shell-cancel"
          aria-label={workbenchText('ChamferDialog.cancelChamfer')}
          data-tooltip={workbenchText('ChamferDialog.cancelChamferEscape')}
          onClick={handleClose}
        >
          <X size={12} aria-hidden="true" />
          <span>{workbenchText('ChamferDialog.cancel')}</span>
        </button>
      </span>
    </div>
  )
}
