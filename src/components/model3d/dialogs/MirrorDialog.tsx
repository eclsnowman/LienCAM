// WO-3244: Model > Modify > Mirror. Pick one solid body and a base or
// construction plane; Apply records ONE feature node (opType 'bodyTransform',
// src/doc/features/bodyTransform.ts) whose reflection replaces the original
// body. Edit reopens the same body and plane choice and rewrites the payload
// and its two dependencies in one history step.
//
// This slice offers "Replace original" only - the result row says so, and no
// keep-the-original or join option is advertised. An open, unconverted mesh
// cannot be mirrored exactly: one line says so and the mesh is left alone.
//
// The page previews the reflection as the choices change (onSelectionChange);
// the preview is never written to history and never hides the source.
//
// Timeline (audit fix round): a Mirror applied at a rolled-back marker
// replaces its source there, so the rolled-back features below that worked on
// the source move onto the Mirror in the same history step
// (RewireReplacedBodyConsumersCommand). Their own edge/face references and
// stored positions are kept: every replay resolves them through this Mirror's
// plane where it is then (bodyTransform resolveReferencesThroughMirrors), so a
// later plane edit carries them along. A reference with no named form on the
// reflection refuses the Apply by feature and reference, and nothing is
// written. On Edit, a plane or body already built
// from this Mirror's result cannot place it - it would depend on itself - so
// the lists leave it out (a choice that becomes one while the dialog is open
// leaves Apply disabled), and EditFeaturePayloadCommand itself refuses the
// edge (DagCycleError), so no route commits the loop.

import { useEffect, useState } from 'react'
import { useText } from '../../../i18n'
import { readableInternalIds } from '../../../lib/operatorLabels'
import { CompositeCommand, type CommandHistory, type FeatureDag } from '../../../doc'
import {
  MirrorReferenceNotCarriedError,
  RewireReplacedBodyConsumersCommand,
  bodyTransformConsumes,
  bodyTransformCyclicChoice,
  mirrorReplacePayload,
  parseBodyTransformPayload,
} from '../../../doc/features/bodyTransform'
import { DialogShell } from './DialogShell'
import { createFeatureCommand } from './createFeatureCommand'
import { EditFeaturePayloadCommand } from './EditFeaturePayloadCommand'
import { nextId } from './nextId'

export interface MirrorSelection {
  sourceBodyId: string
  planeNodeId: string
}

export interface MirrorPreviewState {
  kind: 'idle' | 'building' | 'ready' | 'failed'
  message?: string
}

interface MirrorDialogCommonProps {
  dag: FeatureDag
  history: CommandHistory
  bodyOptions: Array<{ id: string; label: string }>
  planeOptions: Array<{ id: string; label: string }>
  /** the open mesh's name when one is open and not converted to a solid */
  meshName?: string
  preview?: MirrorPreviewState
  onSelectionChange?(selection: MirrorSelection | null): void
  onApplied(featureId: string): void
  onClose(): void
}

export type MirrorDialogProps = MirrorDialogCommonProps & (
  | { mode: 'create'; featureId?: never }
  | { mode: 'edit'; featureId: string }
)

export function MirrorDialog({
  dag,
  history,
  mode,
  featureId,
  bodyOptions: offeredBodies,
  planeOptions: offeredPlanes,
  meshName,
  preview,
  onSelectionChange,
  onApplied,
  onClose,
}: MirrorDialogProps) {
  const text = useText('body-mirror.wo3244')
  const editing = mode === 'edit'
  const downstream = editing && dag.has(featureId) ? new Set([featureId, ...dag.transitiveConsumersOf(featureId)]) : undefined
  const bodyOptions = downstream === undefined ? offeredBodies : offeredBodies.filter((o) => !downstream.has(o.id))
  const planeOptions = downstream === undefined ? offeredPlanes : offeredPlanes.filter((o) => !downstream.has(o.id))
  const existing = editing ? parseBodyTransformPayload(dag.getNode(featureId)?.payload ?? {}) : undefined
  const [sourceBodyId, setSourceBodyId] = useState<string>(existing?.sourceBodyId ?? bodyOptions[0]?.id ?? '')
  const [planeNodeId, setPlaneNodeId] = useState<string>(existing?.transform.planeNodeId ?? planeOptions[0]?.id ?? '')
  const [applyError, setApplyError] = useState<string | undefined>(undefined)

  const referenceError = editing && existing === undefined ? text('notAMirror', { featureId: readableInternalIds(featureId) }) : undefined
  const bodyValid = bodyOptions.some((o) => o.id === sourceBodyId)
  const planeValid = planeOptions.some((o) => o.id === planeNodeId)
  const cyclicChoice = editing && bodyValid && planeValid
    ? bodyTransformCyclicChoice(dag, featureId, [sourceBodyId, planeNodeId])
    : undefined
  const cycleError = cyclicChoice === undefined
    ? undefined
    : text(cyclicChoice === planeNodeId ? 'planeBuiltFromMirror' : 'bodyBuiltFromMirror', {
      choice: (cyclicChoice === planeNodeId ? planeOptions : bodyOptions).find((o) => o.id === cyclicChoice)?.label ?? readableInternalIds(cyclicChoice),
    })
  const invalid = referenceError !== undefined || !bodyValid || !planeValid || cycleError !== undefined

  useEffect(() => {
    onSelectionChange?.(bodyValid && planeValid && cyclicChoice === undefined ? { sourceBodyId, planeNodeId } : null)
  }, [sourceBodyId, planeNodeId, bodyValid, planeValid, cyclicChoice, onSelectionChange])
  useEffect(() => () => onSelectionChange?.(null), [onSelectionChange])

  const handleApply = (): void => {
    if (invalid) return
    setApplyError(undefined)
    try {
      if (editing) {
        const live = dag.getNode(featureId)
        if (live === undefined || parseBodyTransformPayload(live.payload) === undefined) {
          setApplyError(text('notAMirror', { featureId: readableInternalIds(featureId) }))
          return
        }
        const next = { ...live.payload, sourceBodyId, transform: { kind: 'mirror', planeNodeId } }
        history.execute(new EditFeaturePayloadCommand(featureId, next, bodyTransformConsumes({ sourceBodyId, transform: { kind: 'mirror', planeNodeId } })))
        onApplied(featureId)
        onClose()
        return
      }
      const id = nextId(dag, 'F')
      const payload = mirrorReplacePayload({ sourceBodyId, planeNodeId, name: text('defaultName', { id }) })
      const insert = createFeatureCommand(dag, { id, kind: 'feature', consumes: bodyTransformConsumes(payload), payload: { ...payload } })
      history.execute(dag.getRollbackMarker().kind === 'end'
        ? insert
        : new CompositeCommand([insert, new RewireReplacedBodyConsumersCommand(id, sourceBodyId)], insert.label))
      onApplied(id)
      onClose()
    } catch (err) {
      if (err instanceof MirrorReferenceNotCarriedError) {
        const node = dag.getNode(err.featureId)
        const name = typeof node?.payload.name === 'string' && node.payload.name.length > 0 ? node.payload.name : err.featureId
        const key = { notCarried: 'carryNotCarried', noPlane: 'carryNoPlane', badReference: 'carryBadReference' } as const
        setApplyError(text(key[err.kind], { feature: name, reference: err.reference }))
        return
      }
      setApplyError(err instanceof Error ? err.message : String(err))
    }
  }

  const bodyLabel = bodyOptions.find((o) => o.id === sourceBodyId)?.label ?? ''
  const planeLabel = planeOptions.find((o) => o.id === planeNodeId)?.label ?? ''
  const row = { display: 'flex', alignItems: 'center', gap: 8 } as const
  const caption = { width: 70, color: 'var(--text-muted)' } as const
  const note = { color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' } as const
  const danger = { color: 'var(--text-danger)', fontSize: 'var(--font-size-sm)' } as const

  return (
    <DialogShell
      title={editing ? text('editTitle') : text('title')}
      onApply={handleApply}
      onCancel={onClose}
      applyDisabled={invalid}
      allowViewportInteraction
      floatingPalette
    >
      <div data-testid="mirror-dialog" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <label style={row}>
          <span style={caption}>{text('body')}</span>
          <select data-testid="mirror-body-select" value={sourceBodyId} onChange={(e) => setSourceBodyId(e.target.value)} style={{ flex: 1 }}>
            {bodyOptions.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
        </label>
        <label style={row}>
          <span style={caption}>{text('plane')}</span>
          <select data-testid="mirror-plane-select" value={planeNodeId} onChange={(e) => setPlaneNodeId(e.target.value)} style={{ flex: 1 }}>
            {planeOptions.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
        </label>
        <div style={row}>
          <span style={caption}>{text('result')}</span>
          <span data-testid="mirror-result" title={text('replaceOriginalTip')} style={{ flex: 1 }}>{text('replaceOriginal')}</span>
        </div>
        {bodyOptions.length === 0 && <div data-testid="mirror-no-body" style={note}>{text('noBody')}</div>}
        {planeOptions.length === 0 && <div data-testid="mirror-no-plane" style={note}>{text('noPlane')}</div>}
        {meshName !== undefined && (
          <div data-testid="mirror-mesh-note" style={note}>{text('meshNeedsExactBody')}</div>
        )}
        {preview !== undefined && preview.kind !== 'idle' && (
          <div data-testid="mirror-preview-status" data-state={preview.kind} style={preview.kind === 'failed' ? danger : note}>
            {preview.kind === 'building'
              ? text('previewBuilding')
              : preview.kind === 'ready'
                ? text('previewReady', { body: bodyLabel, plane: planeLabel })
                : readableInternalIds(preview.message ?? '')}
          </div>
        )}
        {referenceError !== undefined && <div data-testid="mirror-reference-error" style={danger}>{referenceError}</div>}
        {cycleError !== undefined && <div data-testid="mirror-cycle-error" style={danger}>{cycleError}</div>}
        {applyError !== undefined && <div data-testid="mirror-apply-error" style={danger}>{readableInternalIds(applyError)}</div>}
      </div>
    </DialogShell>
  )
}
