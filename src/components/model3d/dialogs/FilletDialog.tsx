// WO UI-13A: fillet dialog -- INT-5's gate-premise catch found GEO-4's
// applyFillet was never wired into the 3D modeling workspace UI. Follows the
// established create-mode dialog contract (BooleanDialog.tsx's header), but
// Fillet deliberately stays open DURING the viewport edge-pick flow. Edge
// selection and radius editing therefore share one continuous live-preview
// palette instead of a pick -> Done -> radius two-stage interaction.
//
// propagateTangent is always true: GEO-4-R1's own R1.3 finding proved the
// occt-wasm backend refuses propagateTangent:false outright (no kernel API
// to suppress tangent-chain propagation) -- exposing a checkbox that always
// refuses would be the exact "accepted-and-ignored field" anti-pattern this
// codebase's own propagateTangent lesson warns against (see geom-service.ts
// SweepRequest's header). Only the supported value is offered.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, X } from 'lucide-react'
import { useSelectAllOnClick } from '../../ui/selectAllOnClick'
import { useTypeToSet } from '../../ui/useTypeToSet'
import type { CommandHistory, FeatureDag } from '../../../doc'
import { isTypingTarget } from '../../../lib/sketch/tools/shortcuts'
import { createFeatureCommand } from './createFeatureCommand'
import { EditFeaturePayloadCommand } from './EditFeaturePayloadCommand'
import { nextId } from './nextId'

export interface FilletFeaturePayload {
  opType: 'fillet'
  ownerId: string
  edges: string[]
  radius: number
  propagateTangent: true
  name: string
}

export interface FilletPreviewIntent {
  featureId: string
  payload: FilletFeaturePayload
}

export type FilletPreviewState =
  | { status: 'idle' | 'pending' | 'ready' }
  | { status: 'refused'; message: string }

interface FilletDialogCommonProps {
  dag: FeatureDag
  history: CommandHistory
  onApplied(featureId: string): void
  onClose(): void
  previewState?: FilletPreviewState
  onPreviewIntent?: (intent: FilletPreviewIntent | null) => void
  onApplyPreview?: (intent: FilletPreviewIntent) => Promise<string | undefined>
  hoverReadout?: string
  /** WO-1936: the radius a create opens on - an STL blend's own measured
   *  radius, so the field starts on the truth. Defaults to DEFAULT_RADIUS. */
  initialRadius?: number
}

export type FilletDialogProps = FilletDialogCommonProps & (
  | { mode: 'create'; ownerId?: string; edgeIds: string[]; previewFeatureId?: string; featureId?: never }
  | { mode: 'edit'; featureId: string; selectedEdgeIds: string[]; ownerId?: never; edgeIds?: never }
)

const DEFAULT_RADIUS = 2

function editReferenceError(dag: FeatureDag, featureId: string): string | undefined {
  const node = dag.getNode(featureId)
  if (node === undefined || node.kind !== 'feature' || node.payload.opType !== 'fillet') {
    return `Fillet edit refused: '${featureId}' is not a fillet feature`
  }
  const ownerId = node.payload.ownerId
  if (typeof ownerId !== 'string' || ownerId.length === 0 || dag.getNode(ownerId) === undefined) {
    return `Fillet edit refused: owner '${String(ownerId)}' is not available`
  }
  if (!node.consumes.includes(ownerId)) {
    return `Fillet edit refused: owner '${ownerId}' is missing from the feature dependencies`
  }
  const order = dag.featureOrder()
  if (order.indexOf(ownerId) < 0 || order.indexOf(ownerId) >= order.indexOf(featureId)) {
    return `Fillet edit refused: owner '${ownerId}' is not an upstream feature`
  }
  if (!Array.isArray(node.payload.edges) || node.payload.edges.length === 0 || node.payload.edges.some((id) => typeof id !== 'string' || id.length === 0)) {
    return `Fillet edit refused: '${featureId}' has no valid edge references`
  }
  if (typeof node.payload.radius !== 'number' || !Number.isFinite(node.payload.radius) || node.payload.radius <= 0) {
    return `Fillet edit refused: '${featureId}' has an invalid radius`
  }
  return undefined
}

export function FilletDialog(props: FilletDialogProps) {
  const { dag, history, onApplied, onClose } = props
  const editing = props.mode === 'edit'
  const existing = editing ? dag.getNode(props.featureId) : undefined
  const edgeIds = editing ? props.selectedEdgeIds : props.edgeIds
  const initialRadius = editing && typeof existing?.payload.radius === 'number' ? existing.payload.radius : (props.initialRadius ?? DEFAULT_RADIUS)
  const [radiusDraft, setRadiusDraft] = useState(() => String(initialRadius))
  const [applyError, setApplyError] = useState<string | undefined>(undefined)
  const [applying, setApplying] = useState(false)
  const applyingRef = useRef(false)
  const radiusInputRef = useRef<HTMLInputElement | null>(null)
  const selectAllRadius = useSelectAllOnClick()
  useTypeToSet(radiusInputRef, { enabled: true })
  const radius = radiusDraft.trim().length === 0 ? Number.NaN : Number(radiusDraft)

  const referenceError = editing ? editReferenceError(dag, props.featureId) : undefined
  const previewControlled = props.onPreviewIntent !== undefined
  const previewFeatureId = editing ? props.featureId : (props.previewFeatureId ?? nextId(dag, 'F'))
  const previewOwnerId = editing
    ? (typeof existing?.payload.ownerId === 'string' ? existing.payload.ownerId : undefined)
    : props.ownerId
  const invalid = referenceError !== undefined || previewOwnerId === undefined || edgeIds.length === 0 || !Number.isFinite(radius) || radius <= 0
  const applyDisabled = applying || invalid || (previewControlled && props.previewState?.status !== 'ready')
  const edgeIdsKey = edgeIds.join('\u0000')
  const previewIntent = useMemo<FilletPreviewIntent | null>(() => {
    if (invalid || previewOwnerId === undefined) return null
    return {
      featureId: previewFeatureId,
      payload: {
        opType: 'fillet',
        ownerId: previewOwnerId,
        edges: edgeIdsKey.length === 0 ? [] : edgeIdsKey.split('\u0000'),
        radius,
        propagateTangent: true,
        name: editing && typeof existing?.payload.name === 'string'
          ? existing.payload.name
          : `Fillet ${previewFeatureId}`,
      },
    }
  }, [edgeIdsKey, editing, existing?.payload.name, invalid, previewFeatureId, previewOwnerId, radius])

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
        setApplyError(`Fillet Apply refused: ${error instanceof Error ? error.message : String(error)}`)
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
        setApplyError(liveReferenceError ?? `Fillet edit refused: '${props.featureId}' is no longer available`)
        return
      }
      try {
        history.execute(new EditFeaturePayloadCommand(
          props.featureId,
          { ...live.payload, edges: [...edgeIds], radius },
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
    const payload = { opType: 'fillet', ownerId, edges: props.edgeIds, radius, propagateTangent: true, name: `Fillet ${id}` }
    try {
      history.execute(createFeatureCommand(dag, { id, kind: 'feature', consumes: [ownerId], payload }))
    } catch (err) {
      setApplyError(err instanceof Error ? err.message : String(err))
      return
    }
    onApplied(id)
    onClose()
  }, [dag, edgeIds, editing, history, invalid, onApplied, onClose, previewIntent, props, radius])

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
      data-testid="fillet-workspace-palette"
      data-preview-status={props.previewState?.status ?? 'idle'}
      role="toolbar"
      aria-label={editing ? 'Edit Fillet command' : 'Fillet command'}
    >
      <span className="sketch-confirm-title">Fillet</span>
      <span className="sketch-confirm-info" data-testid="fillet-edge-count">
        {edgeIds.length} edge{edgeIds.length === 1 ? '' : 's'} selected
      </span>
      <span className="sketch-confirm-hint" data-testid="fillet-edge-instruction">
        {edgeIds.length === 0 ? 'Select edges in the viewport' : 'Click edges to add or remove'}
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
        <span>Radius</span>
        <span data-testid="fillet-radius">
          <input
            ref={radiusInputRef}
            type="text"
            inputMode="decimal"
            aria-label="Fillet radius"
            value={radiusDraft}
            min={0.1}
            disabled={applying}
            onChange={(event) => setRadiusDraft(event.currentTarget.value)}
            onFocus={selectAllRadius.onFocus}
            onMouseUp={selectAllRadius.onMouseUp}
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
        <span className="sketch-confirm-unit">mm</span>
      </label>
      {referenceError !== undefined && (
        <span
          className="fillet-command-status fillet-command-status--error"
          data-testid="fillet-reference-error"
          data-tooltip={referenceError}
          aria-live="polite"
        >
          {referenceError}
        </span>
      )}
      {applyError !== undefined && (
        <span
          className="fillet-command-status fillet-command-status--error"
          data-testid="fillet-apply-error"
          data-tooltip={applyError}
          aria-live="polite"
        >
          {applyError}
        </span>
      )}
      {previewControlled && props.previewState?.status === 'pending' && (
        <span className="fillet-command-status" data-testid="fillet-preview-status" data-status="pending" aria-live="polite">
          Updating...
        </span>
      )}
      {previewControlled && props.previewState?.status === 'ready' && (
        <span className="fillet-command-status" data-testid="fillet-preview-status" data-status="ready" aria-live="polite">
          Ready
        </span>
      )}
      {previewControlled && props.previewState?.status === 'refused' && (
        <span
          className="fillet-command-status fillet-command-status--error"
          data-testid="fillet-preview-status"
          data-status="refused"
          data-tooltip={props.previewState.message}
          aria-live="polite"
        >
          {props.previewState.message}
        </span>
      )}
      <span className="sketch-confirm-actions">
        <button
          type="button"
          className="sketch-prompt-btn sketch-prompt-btn-confirm"
          data-testid="dialog-shell-apply"
          aria-label="Apply Fillet"
          data-tooltip="Apply Fillet (Enter)"
          disabled={applyDisabled}
          onClick={() => { void handleApply() }}
        >
          <Check size={12} aria-hidden="true" />
          <span>Apply</span>
        </button>
        <button
          type="button"
          className="sketch-prompt-btn"
          data-testid="dialog-shell-cancel"
          aria-label="Cancel Fillet"
          data-tooltip="Cancel Fillet (Escape)"
          onClick={handleClose}
        >
          <X size={12} aria-hidden="true" />
          <span>Cancel</span>
        </button>
      </span>
    </div>
  )
}
