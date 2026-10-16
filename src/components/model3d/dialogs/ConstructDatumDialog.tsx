// WO-2223 (Construct, second wave): the property palette for the picked planes (through three
// points, through two edges, tangent) and the Point datum. Same shape as the Axis palette: the page
// owns the viewport pick (its filter follows the Type chosen here) and hands back what the picks
// made; this palette names it, flips it (planes) and applies it. Backdropless, so the model stays
// clickable.

import { useText, textFor } from '../../../i18n'
const workbenchText = textFor('sketch-and-model-workbench')
import { useEffect, useState } from 'react'
import type { PickedPlaneKind, PointDefinitionKind } from '../../../sketch3d'
import { DialogShell } from './DialogShell'

export interface ConstructDatumDialogValue {
  name: string
  flip: boolean
}

export const PICKED_PLANE_TYPE_WORDS: Record<PickedPlaneKind, string> = {
  get 'three-points'() { return workbenchText('ConstructDatumDialog.throughThreePoints') },
  get 'two-edges'() { return workbenchText('ConstructDatumDialog.throughTwoEdges') },
  get tangent() { return workbenchText('ConstructDatumDialog.tangentToAFace') },
}

export const PICKED_PLANE_HINTS: Record<PickedPlaneKind, string> = {
  get 'three-points'() { return workbenchText('ConstructDatumDialog.clickThreeVerticesInTheViewportXRunsFrom') },
  get 'two-edges'() { return workbenchText('ConstructDatumDialog.clickTwoEdgesInTheViewportARoundEdge') },
  get tangent() { return workbenchText('ConstructDatumDialog.clickACylinderOrShaftWhereThePlaneShould') },
}

export const POINT_TYPE_WORDS: Record<PointDefinitionKind, string> = {
  get vertex() { return workbenchText('ConstructDatumDialog.atAVertex') },
  get 'circle-centre'() { return workbenchText('ConstructDatumDialog.atACircleSCentre') },
  get 'edge-plane'() { return workbenchText('ConstructDatumDialog.whereAnEdgeMeetsAPlane') },
}

export const POINT_HINTS: Record<PointDefinitionKind, string> = {
  get vertex() { return workbenchText('ConstructDatumDialog.clickAVertexInTheViewport') },
  get 'circle-centre'() { return workbenchText('ConstructDatumDialog.clickARoundEdgeOrARoundOrFlat') },
  get 'edge-plane'() { return workbenchText('ConstructDatumDialog.clickAnEdgeInTheViewportThenChooseThe') },
}

export interface ConstructDatumDialogProps<K extends string> {
  /** 'picked-plane' or 'point-datum': prefixes every test id */
  testId: string
  title: string
  mode: 'create' | 'edit'
  kind: K
  typeWords: Record<K, string>
  hints: Record<K, string>
  initialName: string
  initialFlip: boolean
  /** planes flip; points do not */
  showFlip: boolean
  /** what the picks make, in the operator's words; null until they make something */
  picked: string | null
  /** how far the picks have got (e.g. "2 of 3 points picked") while they are not yet complete */
  progress?: string
  /** edge meets plane: the planes to choose from, and the one chosen ('' = a picked face) */
  planeOptions?: Array<{ id: string; label: string }>
  planeId?: string
  pickedFaceLabel?: string
  onPlaneChange?(id: string): void
  onKindChange?(kind: K): void
  onValueChange?(value: ConstructDatumDialogValue): void
  onApply(value: ConstructDatumDialogValue): Promise<string | undefined>
  onClose(): void
}

export function ConstructDatumDialog<K extends string>(props: ConstructDatumDialogProps<K>) {
  const workbenchText = useText('sketch-and-model-workbench')
  const [name, setName] = useState(props.initialName)
  const [flip, setFlip] = useState(props.initialFlip)
  const [error, setError] = useState<string | null>(null)
  const [applying, setApplying] = useState(false)
  const { onValueChange, testId } = props

  useEffect(() => {
    onValueChange?.({ name: name.trim(), flip })
  }, [onValueChange, name, flip])

  const localError = props.picked === null
    ? (props.progress ?? workbenchText('ConstructDatumDialog.pickInTheViewport'))
    : name.trim().length === 0
      ? workbenchText('ConstructDatumDialog.enterAName')
      : null
  const applyDisabled = localError !== null || applying

  const apply = async (): Promise<void> => {
    if (applyDisabled) return
    setApplying(true)
    setError(null)
    try {
      const refusal = await props.onApply({ name: name.trim(), flip })
      if (refusal !== undefined) setError(refusal)
      else props.onClose()
    } finally {
      setApplying(false)
    }
  }

  const kinds = Object.keys(props.typeWords) as K[]
  return (
    <DialogShell
      title={props.mode === 'create' ? props.title : workbenchText('ConstructDatumDialog.edit', { value1: String(props.title.toLowerCase()) })}
      onApply={() => { void apply() }}
      onCancel={props.onClose}
      applyDisabled={applyDisabled}
      floatingPalette
      backdropless
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }} data-testid={`${testId}-dialog`}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}>{workbenchText('ConstructDatumDialog.type')}</span>
          {props.mode === 'create'
            ? (
              <select data-testid={`${testId}-type`} value={props.kind} onChange={(event) => props.onKindChange?.(event.target.value as K)}>
                {kinds.map((k) => <option key={k} value={k}>{props.typeWords[k]}</option>)}
              </select>
            )
            : <span data-testid={`${testId}-type-name`}>{props.typeWords[props.kind]}</span>}
        </label>
        {props.mode === 'create' && (
          <div data-testid={`${testId}-pick-hint`} style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}>
            {props.hints[props.kind]}
          </div>
        )}
        {props.mode === 'create' && props.planeOptions !== undefined && (
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}>{workbenchText('ConstructDatumDialog.plane')}</span>
            <select data-testid={`${testId}-plane`} value={props.planeId ?? ''} onChange={(event) => props.onPlaneChange?.(event.target.value)}>
              {props.planeId === '' && <option value="">{props.pickedFaceLabel ?? workbenchText('ConstructDatumDialog.thePickedFace')}</option>}
              {props.planeOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
            </select>
          </label>
        )}
        <div data-testid={`${testId}-picked`} style={{ fontSize: 'var(--font-size-sm)', color: props.picked === null ? 'var(--text-muted)' : 'var(--text-accent)' }}>
          {props.picked === null ? (props.progress ?? workbenchText('ConstructDatumDialog.nothingPickedYet')) : `${props.title}: ${props.picked}`}
        </div>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}>{workbenchText('ConstructDatumDialog.name')}</span>
          <input data-testid={`${testId}-name`} value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        {props.showFlip && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input data-testid={`${testId}-flip`} type="checkbox" checked={flip} onChange={(event) => setFlip(event.target.checked)} />
            {workbenchText('ConstructDatumDialog.flipNormal')}</label>
        )}
        {(localError ?? error) !== null && (
          <div data-testid={`${testId}-error`} style={{ color: error !== null ? 'var(--text-danger)' : 'var(--text-muted)' }}>{error ?? localError}</div>
        )}
      </div>
    </DialogShell>
  )
}
