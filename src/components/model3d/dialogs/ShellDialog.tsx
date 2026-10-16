import { readableInternalIds } from '../../../lib/operatorLabels'
// Shell stays open during viewport face picking. This is the qualified
// Fillet/Chamfer command-strip interaction: select faces to open, enter one
// thickness, inspect the real kernel preview, then Apply.

import { useText, textFor } from '../../../i18n'
const workbenchText = textFor('sketch-and-model-workbench')
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
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

// WO-2865: the strip stays one row until a refusal shows; then the refusal
// takes a full-width row of its own and wraps, so the whole sentence and its
// next step are read instead of clipped at the strip's ellipsis.
const REFUSAL_STRIP_STYLE: CSSProperties = { flexWrap: 'wrap' }
const REFUSAL_LINE_STYLE: CSSProperties = { order: 1, flexBasis: '100%', maxWidth: 'none', whiteSpace: 'normal', overflow: 'visible' }

function editReferenceError(dag: FeatureDag, featureId: string): string | undefined {
  const node = dag.getNode(featureId)
  if (node === undefined || node.kind !== 'feature' || node.payload.opType !== 'shell') {
    return workbenchText('ShellDialog.shellEditRefusedIsNotAShellFeature', { featureId: String(featureId) })
  }
  const ownerId = node.payload.ownerId
  if (typeof ownerId !== 'string' || ownerId.length === 0 || dag.getNode(ownerId) === undefined) {
    return workbenchText('ShellDialog.shellEditRefusedOwnerIsNotAvailable', { value1: String(String(ownerId)) })
  }
  if (!node.consumes.includes(ownerId)) {
    return workbenchText('ShellDialog.shellEditRefusedOwnerIsMissingFromTheFeature', { ownerId: String(ownerId) })
  }
  const order = dag.featureOrder()
  if (order.indexOf(ownerId) < 0 || order.indexOf(ownerId) >= order.indexOf(featureId)) {
    return workbenchText('ShellDialog.shellEditRefusedOwnerIsNotAnUpstreamFeature', { ownerId: String(ownerId) })
  }
  if (!Array.isArray(node.payload.removeFaces) || node.payload.removeFaces.length === 0 || node.payload.removeFaces.some((id) => typeof id !== 'string' || id.length === 0)) {
    return workbenchText('ShellDialog.shellEditRefusedHasNoValidFaceReferences', { featureId: String(featureId) })
  }
  if (typeof node.payload.thickness !== 'number' || !Number.isFinite(node.payload.thickness) || node.payload.thickness <= 0) {
    return workbenchText('ShellDialog.shellEditRefusedHasAnInvalidThickness', { featureId: String(featureId) })
  }
  return undefined
}

export function ShellDialog(props: ShellDialogProps) {
  const workbenchText = useText('sketch-and-model-workbench')
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
          : workbenchText('ShellDialog.shell', { previewFeatureId: String(previewFeatureId) }),
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
        setApplyError(workbenchText('ShellDialog.shellApplyRefused', { value1: String(error instanceof Error ? error.message : String(error)) }))
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
        setApplyError(liveReferenceError ?? workbenchText('ShellDialog.shellEditRefusedIsNoLongerAvailable', { featureId: String(props.featureId) }))
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
    const payload = { opType: 'shell', ownerId, removeFaces: [...props.faceIds], thickness, name: workbenchText('ShellDialog.shell2', { id: String(id) }) }
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

  const refusalShown = props.previewState?.status === 'refused' || referenceError !== undefined || applyError !== undefined
  return (
    <div
      className={`sketch-confirm-overlay fillet-command-strip${refusalShown ? ' fillet-command-strip--refusal' : ''}`}
      style={refusalShown ? REFUSAL_STRIP_STYLE : undefined}
      data-testid="shell-workspace-palette"
      data-preview-status={applyingVisible ? 'applying' : (props.previewState?.status ?? 'idle')}
      role="toolbar"
      aria-label={editing ? workbenchText('ShellDialog.editShellCommand') : workbenchText('ShellDialog.shellCommand')}
      aria-busy={applyingVisible}
    >
      <span className="sketch-confirm-title">{workbenchText('ShellDialog.shell3')}</span>
      <span className="sketch-confirm-info" data-testid="shell-face-count">
        {workbenchText('ShellDialog.faceToOpen', { length: String((faceIds.length) ?? ''), value2: String((faceIds.length === 1 ? '' : 's')) })}</span>
      <span className="sketch-confirm-hint" data-testid="shell-face-instruction">
        {faceIds.length === 0 ? workbenchText('ShellDialog.selectFacesToOpenInTheViewport') : workbenchText('ShellDialog.clickFacesToOpenOrKeepClosed')}
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
        <span>{workbenchText('ShellDialog.thickness')}</span>
        <span data-testid="shell-thickness">
          <input
            ref={thicknessInputRef}
            type="text"
            inputMode="decimal"
            aria-label={workbenchText('ShellDialog.shellThickness')}
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
        <span className="sketch-confirm-unit">{workbenchText('ShellDialog.mm')}</span>
      </label>
      {referenceError !== undefined && (
        <span
          className="fillet-command-status fillet-command-status--error"
          data-testid="shell-reference-error"
          style={REFUSAL_LINE_STYLE}
          data-tooltip={readableInternalIds(referenceError)}
          aria-live="polite"
        >
          {readableInternalIds(referenceError)}
        </span>
      )}
      {applyError !== undefined && (
        <span
          className="fillet-command-status fillet-command-status--error"
          data-testid="shell-apply-error"
          style={REFUSAL_LINE_STYLE}
          data-tooltip={readableInternalIds(applyError)}
          aria-live="polite"
        >
          {readableInternalIds(applyError)}
        </span>
      )}
      {previewControlled && applyingVisible && (
        <span className="fillet-command-status" data-testid="shell-preview-status" data-status="applying" aria-live="polite">
          {workbenchText('ShellDialog.applying')}</span>
      )}
      {previewControlled && !applyingVisible && props.previewState?.status === 'pending' && (
        <span className="fillet-command-status" data-testid="shell-preview-status" data-status="pending" aria-live="polite">
          {workbenchText('ShellDialog.updating')}</span>
      )}
      {previewControlled && !applyingVisible && props.previewState?.status === 'ready' && (
        <span className="fillet-command-status" data-testid="shell-preview-status" data-status="ready" aria-live="polite">
          {workbenchText('ShellDialog.ready')}</span>
      )}
      {previewControlled && !applyingVisible && props.previewState?.status === 'refused' && (
        <span
          className="fillet-command-status fillet-command-status--error"
          data-testid="shell-preview-status"
          data-status="refused"
          style={REFUSAL_LINE_STYLE}
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
          aria-label={workbenchText('ShellDialog.applyShell')}
          data-tooltip={workbenchText('ShellDialog.applyShellEnter')}
          disabled={applyDisabled}
          onClick={() => { void handleApply() }}
        >
          <Check size={12} aria-hidden="true" />
          <span>{workbenchText('ShellDialog.apply')}</span>
        </button>
        <button
          type="button"
          className="sketch-prompt-btn"
          data-testid="dialog-shell-cancel"
          aria-label={workbenchText('ShellDialog.cancelShell')}
          data-tooltip={workbenchText('ShellDialog.cancelShellEscape')}
          disabled={applyingVisible}
          onClick={handleClose}
        >
          <X size={12} aria-hidden="true" />
          <span>{workbenchText('ShellDialog.cancel')}</span>
        </button>
      </span>
    </div>
  )
}
