// WO UI-3 acceptance #2's proof dialog: edits an existing box feature's size
// through the SAME command layer any future feature dialog (M4's extrude/
// revolve) will use. Demonstrates the full framework contract:
//   - open  : reads the feature's CURRENT payload from the DAG (never a
//             separately-tracked "form state" that could drift from it)
//   - field change : calls onPreview(size) -- the live-preview seam. The
//             caller decides what "preview" means (a THREE mesh scale, a
//             re-tessellation, or nothing in a headless test); this dialog
//             does not touch a scene itself, keeping it framework-generic.
//   - cancel: calls onCancelPreview() so the caller can revert its preview,
//             then closes WITHOUT touching the DAG (nothing was ever
//             committed, so there's nothing to undo).
//   - apply : executes an EditFeaturePayloadCommand through the caller's
//             CommandHistory -- undo/redo now cover this edit for free.

import { useState } from 'react'
import { NumericInput } from '../../ui/NumericInput'
import type { CommandHistory, FeatureDag } from '../../../doc'
import type { Vec3 } from '../../../geom/geom-service'
import { DialogShell } from './DialogShell'
import { EditFeaturePayloadCommand } from './EditFeaturePayloadCommand'

export interface BoxSizeDialogProps {
  dag: FeatureDag
  history: CommandHistory
  featureId: string
  /** Live-preview seam: invoked with the DRAFT size on every committed field
   *  change (NumericInput's own edit-draft/commit-on-blur-or-Enter contract --
   *  same as every other numeric field in this app), before Apply. */
  onPreview?(size: Vec3): void
  /** Invoked on Cancel so the caller can revert whatever onPreview did. */
  onCancelPreview?(): void
  onApplied?(): void
  onClose(): void
}

const DEFAULT_SIZE: Vec3 = { x: 10, y: 10, z: 10 }

function readSize(dag: FeatureDag, featureId: string): Vec3 {
  const node = dag.getNode(featureId)
  const raw = node?.payload.size as Vec3 | undefined
  return raw ? { x: raw.x, y: raw.y, z: raw.z } : DEFAULT_SIZE
}

export function BoxSizeDialog({ dag, history, featureId, onPreview, onCancelPreview, onApplied, onClose }: BoxSizeDialogProps) {
  const [size, setSize] = useState<Vec3>(() => readSize(dag, featureId))

  const updateAxis = (axis: keyof Vec3) => (value: number) => {
    const next = { ...size, [axis]: value }
    setSize(next)
    onPreview?.(next)
  }

  const handleApply = (): void => {
    const node = dag.getNode(featureId)
    const payload = { ...(node?.payload ?? {}), size }
    history.execute(new EditFeaturePayloadCommand(featureId, payload))
    onApplied?.()
    onClose()
  }

  const handleCancel = (): void => {
    onCancelPreview?.()
    onClose()
  }

  return (
    <DialogShell title="Box size" onApply={handleApply} onCancel={handleCancel}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {(['x', 'y', 'z'] as const).map((axis) => (
          <label key={axis} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ width: 16, textTransform: 'uppercase', color: 'var(--text-muted)' }}>{axis}</span>
            <span data-testid={`box-size-${axis}`} style={{ flex: 1 }}>
              <NumericInput value={size[axis]} onChange={updateAxis(axis)} min={0.1} style={{ width: '100%' }} />
            </span>
            <span style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}>mm</span>
          </label>
        ))}
      </div>
    </DialogShell>
  )
}
