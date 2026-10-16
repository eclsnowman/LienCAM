// WO-2222 (Construct: Axis): the Axis property palette. The page owns the viewport pick (the pick
// filter follows the Type chosen here) and hands back what the pick made; this palette names it,
// flips it and applies it. Backdropless, like the construction planes, so the model stays clickable.

import { useText, textFor } from '../../../i18n'
const workbenchText = textFor('sketch-and-model-workbench')
import { useEffect, useState } from 'react'
import type { AxisDefinitionKind } from '../../../sketch3d'
import { DialogShell } from './DialogShell'

export interface AxisDialogValue {
  kind: AxisDefinitionKind
  name: string
  flip: boolean
}

export const AXIS_TYPE_WORDS: Record<AxisDefinitionKind, string> = {
  get cylinder() { return workbenchText('AxisDialog.throughACylinderOrHole') },
  get edge() { return workbenchText('AxisDialog.alongAnEdge') },
  get 'two-points'() { return workbenchText('AxisDialog.throughTwoPoints') },
}

const PICK_HINTS: Record<AxisDefinitionKind, string> = {
  get cylinder() { return workbenchText('AxisDialog.clickACylinderHoleOrRoundFaceInThe') },
  get edge() { return workbenchText('AxisDialog.clickAStraightEdgeInTheViewportARound') },
  get 'two-points'() { return workbenchText('AxisDialog.clickTwoVerticesInTheViewportFirstThenSecond') },
}

export interface AxisDialogProps {
  mode: 'create' | 'edit'
  kind: AxisDefinitionKind
  initialName: string
  initialFlip: boolean
  /** what the current pick makes, in the operator's words; null before the first pick */
  picked: string | null
  /** two points: the first vertex is in, waiting for the second */
  waitingForSecondPoint?: boolean
  onKindChange?(kind: AxisDefinitionKind): void
  onValueChange?(value: AxisDialogValue): void
  onApply(value: AxisDialogValue): Promise<string | undefined>
  onClose(): void
}

export function AxisDialog(props: AxisDialogProps) {
  const workbenchText = useText('sketch-and-model-workbench')
  const [name, setName] = useState(props.initialName)
  const [flip, setFlip] = useState(props.initialFlip)
  const [error, setError] = useState<string | null>(null)
  const [applying, setApplying] = useState(false)
  const { onValueChange, kind } = props

  useEffect(() => {
    onValueChange?.({ kind, name: name.trim(), flip })
  }, [onValueChange, kind, name, flip])

  const localError = props.picked === null
    ? (props.waitingForSecondPoint === true ? workbenchText('AxisDialog.pickTheSecondPoint') : workbenchText('AxisDialog.pickInTheViewport'))
    : name.trim().length === 0
      ? workbenchText('AxisDialog.enterAnAxisName')
      : null
  const applyDisabled = localError !== null || applying

  const apply = async (): Promise<void> => {
    if (applyDisabled) return
    setApplying(true)
    setError(null)
    try {
      const refusal = await props.onApply({ kind, name: name.trim(), flip })
      if (refusal !== undefined) setError(refusal)
      else props.onClose()
    } finally {
      setApplying(false)
    }
  }

  return (
    <DialogShell
      title={props.mode === 'create' ? workbenchText('AxisDialog.axis') : workbenchText('AxisDialog.editAxis')}
      onApply={() => { void apply() }}
      onCancel={props.onClose}
      applyDisabled={applyDisabled}
      floatingPalette
      backdropless
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }} data-testid="axis-dialog">
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}>{workbenchText('AxisDialog.type')}</span>
          {props.mode === 'create'
            ? (
              <select
                data-testid="axis-type"
                value={kind}
                onChange={(event) => props.onKindChange?.(event.target.value as AxisDefinitionKind)}
              >
                {(Object.keys(AXIS_TYPE_WORDS) as AxisDefinitionKind[]).map((k) => <option key={k} value={k}>{AXIS_TYPE_WORDS[k]}</option>)}
              </select>
            )
            : <span data-testid="axis-type-name">{AXIS_TYPE_WORDS[kind]}</span>}
        </label>
        {props.mode === 'create' && (
          <div data-testid="axis-pick-hint" style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}>
            {PICK_HINTS[kind]}
          </div>
        )}
        <div data-testid="axis-picked" style={{ fontSize: 'var(--font-size-sm)', color: props.picked === null ? 'var(--text-muted)' : 'var(--text-accent)' }}>
          {props.picked === null
            ? (props.waitingForSecondPoint === true ? workbenchText('AxisDialog.firstPointPickedNowTheSecond') : workbenchText('AxisDialog.nothingPickedYet'))
            : workbenchText('AxisDialog.axis2', { picked: String(props.picked) })}
        </div>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}>{workbenchText('AxisDialog.name')}</span>
          <input data-testid="axis-name" value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input data-testid="axis-flip" type="checkbox" checked={flip} onChange={(event) => setFlip(event.target.checked)} />
          {workbenchText('AxisDialog.flipDirection')}</label>
        {(localError ?? error) !== null && (
          <div data-testid="axis-error" style={{ color: error !== null ? 'var(--text-danger)' : 'var(--text-muted)' }}>{error ?? localError}</div>
        )}
      </div>
    </DialogShell>
  )
}
