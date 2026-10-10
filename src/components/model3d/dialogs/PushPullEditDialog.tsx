// WO UI-80: edit-after-creation dialog for a first-class push/pull DAG node.
//
// Direct push/pull edits now land as their own `kind: 'feature'`, `opType:
// 'pushPull'` node (SolidsWorkbenchPage's handlePushPullCommit), so -- exactly
// like extrude/revolve -- they need an edit dialog reachable from the tree's
// "Edit..." entry (editEntryFor). This dialog is EDIT-ONLY: a push/pull node is
// born from an in-viewport gesture (never a create-mode modal), so there is no
// 'create' branch here.
//
// Apply mirrors ExtrudeDialog edit-mode EXACTLY (WO UI-80 AM4): it runs one
// EditFeaturePayloadCommand on the pushPull node itself -- the same undo-safe,
// order-neutral remove-then-reinsert-same-id seam BoxSizeDialog/ExtrudeDialog
// prove -- then the page's onApplied (handleDialogApplied) drives the SAME
// fullResync every dialog Apply uses. One undo step, deterministic regen.
//
// The stored `delta` is a SIGNED offset along the face normal captured at pick
// time (+ = outward along that normal, - = inward). The dialog splits it into a
// magnitude field + an outward/inward direction select for legibility (the same
// magnitude+direction shape ExtrudeDialog uses), recombining to the signed delta
// on Apply. `normal` and `ownerId` are creation-fixed identity/topology and are
// preserved untouched.

import { useState } from 'react'
import { NumericInput } from '../../ui/NumericInput'
import type { CommandHistory, FeatureDag } from '../../../doc'
import { DialogShell } from './DialogShell'
import { EditFeaturePayloadCommand } from './EditFeaturePayloadCommand'

export interface PushPullFeaturePayload extends Record<string, unknown> {
  opType: 'pushPull'
  /** The body-producing feature this push/pull consumes and supersedes. Also
   *  carried on the node's `consumes` edge (the reorder-guard / lineage
   *  carrier); duplicated here so the executor's lookupLiveBody gate reads it
   *  the same way every other single-body op reads its own ownerId. */
  ownerId: string
  /** Signed offset along `normal`, mm. Positive = outward along the captured
   *  face normal, negative = inward. Passed straight to client.editFeature
   *  faceOffset as the `delta`. */
  delta: number
  /** World-space face normal captured at pick time -- direction display only
   *  (the kernel derives push direction from the resolved face itself). */
  normal: { x: number; y: number; z: number }
  name: string
}

type PushPullDirection = 'outward' | 'inward'

export interface PushPullEditDialogProps {
  dag: FeatureDag
  history: CommandHistory
  featureId: string
  onApplied(featureId: string): void
  onClose(): void
}

const DEFAULT_DISTANCE = 5

export function PushPullEditDialog({ dag, history, featureId, onApplied, onClose }: PushPullEditDialogProps) {
  const existing = dag.getNode(featureId)?.payload as Record<string, unknown> | undefined
  const priorDelta = typeof existing?.delta === 'number' && Number.isFinite(existing.delta) ? (existing.delta as number) : DEFAULT_DISTANCE
  const [magnitude, setMagnitude] = useState<number>(Math.abs(priorDelta) < 1e-9 ? DEFAULT_DISTANCE : Math.abs(priorDelta))
  const [direction, setDirection] = useState<PushPullDirection>(priorDelta < 0 ? 'inward' : 'outward')
  const [applyError, setApplyError] = useState<string | undefined>(undefined)

  const handleApply = (): void => {
    const node = dag.getNode(featureId)
    if (node === undefined) {
      setApplyError(`Push/Pull feature '${featureId}' no longer exists.`)
      return
    }
    if (!Number.isFinite(magnitude) || magnitude <= 0) {
      setApplyError('Distance must be a positive number.')
      return
    }
    setApplyError(undefined)
    const delta = direction === 'inward' ? -magnitude : magnitude
    // AM4: EditFeaturePayloadCommand on the pushPull node itself, preserving
    // opType/ownerId/normal/name (identity + topology) and consumes untouched.
    history.execute(new EditFeaturePayloadCommand(featureId, { ...node.payload, delta }))
    onApplied(featureId)
    onClose()
  }

  return (
    <DialogShell title="Edit push/pull" onApply={handleApply} onCancel={onClose} applyDisabled={magnitude <= 0}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 70, color: 'var(--text-muted)' }}>Direction</span>
          <select
            data-testid="pushpull-direction-select"
            value={direction}
            onChange={(e) => setDirection(e.target.value as PushPullDirection)}
            style={{ flex: 1 }}
          >
            <option value="outward" data-testid="pushpull-direction-option-outward">
              Outward (along face normal)
            </option>
            <option value="inward" data-testid="pushpull-direction-option-inward">
              Inward (into the body)
            </option>
          </select>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 70, color: 'var(--text-muted)' }}>Distance</span>
          <span data-testid="pushpull-distance" style={{ flex: 1 }}>
            <NumericInput value={magnitude} onChange={setMagnitude} min={0.001} style={{ width: '100%' }} />
          </span>
          <span style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}>mm</span>
        </label>
        {applyError !== undefined && (
          <div data-testid="pushpull-apply-error" style={{ color: 'var(--text-danger)', fontSize: 'var(--font-size-sm)' }}>
            {applyError}
          </div>
        )}
      </div>
    </DialogShell>
  )
}
