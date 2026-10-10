// Shell stays open during viewport face picking. This is the qualified
// Fillet/Chamfer command-strip interaction: select faces to open, enter one
// thickness, inspect the real kernel preview, then Apply.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, X } from 'lucide-react'
import { useSelectAllOnClick } from '../../ui/selectAllOnClick'
import { useTypeToSet } from '../../ui/useTypeToSet'
import type { CommandHistory, FeatureDag } from '../../../doc'
import { isTypingTarget } from '../../../lib/sketch/tools/shortcuts'
import { createFeatureCommand } from './createFeatureCommand'
import { EditFeaturePayloadCommand } from './EditFeaturePayloadCommand'
import { nextId } from './nextId'

export interface ShellFeaturePayload {
  opType: 'shell'
  ownerId: string
  removeFaces: string[]
  thickness: number
  name: string
}

export interface ShellPreviewIntent {
  featureId: string
  payload: ShellFeaturePayload
}

export type ShellPreviewState =
  | { status: 'idle' | 'pending' | 'ready' | 'applying' }
  | { status: 'refused'; message: string }

interface ShellDialogCommonProps {
  dag: FeatureDag
  history: CommandHistory
  onApplied(featureId: string): void
  onClose(): void
  previewState?: ShellPreviewState
  onPreviewIntent?: (intent: ShellPreviewIntent | null) => void
  onApplyPreview?: (intent: ShellPreviewIntent) => Promise<string | undefined>
  hoverReadout?: string
}

export type ShellDialogProps = ShellDialogCommonProps & (
  | { mode: 'create'; ownerId?: string; faceIds: string[]; previewFeatureId?: string; featureId?: never }
  | { mode: 'edit'; featureId: string; selectedFaceIds: string[]; ownerId?: never; faceIds?: never }
)

const DEFAULT_THICKNESS = 2

function editReferenceError(dag: FeatureDag, featureId: string): string | undefined {
  const node = dag.getNode(featureId)
  if (node === undefined || node.kind !== 'feature' || node.payload.opType !== 'shell') {
    return `Shell edit refused: '${featureId}' is not a shell feature`
  }
  const ownerId = node.payload.ownerId
  if (typeof ownerId !== 'string' || ownerId.length === 0 || dag.getNode(ownerId) === undefined) {
    return `Shell edit refused: owner '${String(ownerId)}' is not available`
  }
  if (!node.consumes.includes(ownerId)) {
    return `Shell edit refused: owner '${ownerId}' is missing from the feature dependencies`
  }
  const order = dag.featureOrder()
  if (order.indexOf(ownerId) < 0 || order.indexOf(ownerId) >= order.indexOf(featureId)) {
    return `Shell edit refused: owner '${ownerId}' is not an upstream feature`
  }
  if (!Array.isArray(node.payload.removeFaces) || node.payload.removeFaces.length === 0 || node.payload.removeFaces.some((id) => typeof id !== 'string' || id.length === 0)) {
    return `Shell edit refused: '${featureId}' has no valid face references`
  }
  if (typeof node.payload.thickness !== 'number' || !Number.isFinite(node.payload.thickness) || node.payload.thickness <= 0) {
    return `Shell edit refused: '${featureId}' has an invalid thickness`
  }
  return undefined
}

export function ShellDialog(props: ShellDialogProps) {
  const { dag, history, onApplied, onClose } = props
  const editing = props.mode === 'edit'
  const existing = editing ? dag.getNode(props.featureId) : undefined
  const faceIds = editing ? props.selectedFaceIds : props.faceIds
  const initialThickness = editing && typeof existing?.payload.thickness === 'number' ? existing.payload.thickness : DEFAULT_THICKNESS
  const [thicknessDraft, setThicknessDraft] = useState(() => String(initialThickness))
  const [applyError, setApplyError] = useState<string | undefined>(undefined)
  const [applying, setApplying] = useState(false)
  const applyingRef = useRef(false)
  const thicknessInputRef = useRef<HTMLInputElement | null>(null)
  const selectAllThickness = useSelectAllOnClick()
  const thickness = thicknessDraft.trim().length === 0 ? Number.NaN : Number(thicknessDraft)

  const referenceError = editing ? editReferenceError(dag, props.featureId) : undefined
  const previewControlled = props.onPreviewIntent !== undefined
  const previewFeatureId = editing ? props.featureId : (props.previewFeatureId ?? nextId(dag, 'F'))
  const previewOwnerId = editing
    ? (typeof existing?.payload.ownerId === 'string' ? existing.payload.ownerId : undefined)
    : props.ownerId
  const invalid = referenceError !== undefined || previewOwnerId === undefined || faceIds.length === 0 || !Number.isFinite(thickness) || thickness <= 0
  const applyingVisible = applying || props.previewState?.status === 'applying'
  useTypeToSet(thicknessInputRef, { enabled: !applyingVisible })
  const applyDisabled = applyingVisible || invalid || (previewControlled && props.previewState?.status !== 'ready')
  const faceIdsKey = faceIds.join('\u0000')
  const previewIntent = useMemo<ShellPreviewIntent | null>(() => {
    if (invalid || previewOwnerId === undefined) return null
    return {
      featureId: previewFeatureId,
      payload: {
        opType: 'shell',
        ownerId: previewOwnerId,
        removeFaces: faceIdsKey.length === 0 ? [] : faceIdsKey.split('\u0000'),
        thickness,
        name: editing && typeof existing?.payload.name === 'string'
          ? existing.payload.name
          : `Shell ${previewFeatureId}`,
      },
    }
  }, [editing, existing?.payload.name, faceIdsKey, invalid, previewFeatureId, previewOwnerId, thickness])

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
        setApplyError(`Shell Apply refused: ${error instanceof Error ? error.message : String(error)}`)
        return
      } finally {
        applyingRef.current = false
        setApplying(false)
      }
    }
    const refs = faceIds.map((id) => ({ id, kind: 'face-set' as const }))
    if (editing) {
      const live = dag.getNode(props.featureId)
      const liveReferenceError = editReferenceError(dag, props.featureId)
      if (live === undefined || liveReferenceError !== undefined) {
        setApplyError(liveReferenceError ?? `Shell edit refused: '${props.featureId}' is no longer available`)
        return
      }
      try {
        history.execute(new EditFeaturePayloadCommand(
          props.featureId,
          { ...live.payload, removeFaces: [...faceIds], thickness },
          live.consumes,
          refs,
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
    const payload = { opType: 'shell', ownerId, removeFaces: [...props.faceIds], thickness, name: `Shell ${id}` }
    try {
      history.execute(createFeatureCommand(dag, { id, kind: 'feature', consumes: [ownerId], refs, payload }))
    } catch (err) {
      setApplyError(err instanceof Error ? err.message : String(err))
      return
    }
    onApplied(id)
    onClose()
  }, [dag, faceIds, history, invalid, onApplied, onClose, previewIntent, props, thickness])

  useEffect(() => {
    const onPaletteKeyDown = (event: KeyboardEvent): void => {
      if (applyingRef.current) {
        if (event.key === 'Escape' || event.key === 'Enter') event.preventDefault()
        return
      }
      const activeOwner = document.activeElement
      if (isTypingTarget(event.target) || isTypingTarget(activeOwner)) return
      if (event.key === 'Escape') {
        event.preventDefault()
        handleClose()
        return
      }
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
  }, [applyDisabled, handleApply, handleClose])

  return (
    <div
      className={`sketch-confirm-overlay fillet-command-strip${props.previewState?.status === 'refused' || referenceError !== undefined || applyError !== undefined ? ' fillet-command-strip--refusal' : ''}`}
      data-testid="shell-workspace-palette"
      data-preview-status={applyingVisible ? 'applying' : (props.previewState?.status ?? 'idle')}
      role="toolbar"
      aria-label={editing ? 'Edit Shell command' : 'Shell command'}
      aria-busy={applyingVisible}
    >
      <span className="sketch-confirm-title">Shell</span>
      <span className="sketch-confirm-info" data-testid="shell-face-count">
        {faceIds.length} face{faceIds.length === 1 ? '' : 's'} to open
      </span>
      <span className="sketch-confirm-hint" data-testid="shell-face-instruction">
        {faceIds.length === 0 ? 'Select faces to open in the viewport' : 'Click faces to open or keep closed'}
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
        <span>Thickness</span>
        <span data-testid="shell-thickness">
          <input
            ref={thicknessInputRef}
            type="text"
            inputMode="decimal"
            aria-label="Shell thickness"
            value={thicknessDraft}
            min={0.1}
            disabled={applyingVisible}
            onChange={(event) => setThicknessDraft(event.currentTarget.value)}
            onFocus={selectAllThickness.onFocus}
            onMouseUp={selectAllThickness.onMouseUp}
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
          data-testid="shell-reference-error"
          data-tooltip={referenceError}
          aria-live="polite"
        >
          {referenceError}
        </span>
      )}
      {applyError !== undefined && (
        <span
          className="fillet-command-status fillet-command-status--error"
          data-testid="shell-apply-error"
          data-tooltip={applyError}
          aria-live="polite"
        >
          {applyError}
        </span>
      )}
      {previewControlled && applyingVisible && (
        <span className="fillet-command-status" data-testid="shell-preview-status" data-status="applying" aria-live="polite">
          Applying...
        </span>
      )}
      {previewControlled && !applyingVisible && props.previewState?.status === 'pending' && (
        <span className="fillet-command-status" data-testid="shell-preview-status" data-status="pending" aria-live="polite">
          Updating...
        </span>
      )}
      {previewControlled && !applyingVisible && props.previewState?.status === 'ready' && (
        <span className="fillet-command-status" data-testid="shell-preview-status" data-status="ready" aria-live="polite">
          Ready
        </span>
      )}
      {previewControlled && !applyingVisible && props.previewState?.status === 'refused' && (
        <span
          className="fillet-command-status fillet-command-status--error"
          data-testid="shell-preview-status"
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
          aria-label="Apply Shell"
          data-tooltip="Apply Shell (Enter)"
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
          aria-label="Cancel Shell"
          data-tooltip="Cancel Shell (Escape)"
          disabled={applyingVisible}
          onClick={handleClose}
        >
          <X size={12} aria-hidden="true" />
          <span>Cancel</span>
        </button>
      </span>
    </div>
  )
}
