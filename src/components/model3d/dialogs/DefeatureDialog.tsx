// WO UI-6X: picker for deleting recognized coherent feature groups as one
// history feature. Recognition happens before this dialog opens; this surface
// only owns the user's accept mask and the standard DAG insertion transaction.
//
// BK-174: 'edit' mode reuses this SAME dialog -- FeatureTree Edit on a
// defeature feature re-recognizes the owner body's CURRENT feature groups
// (the same recognition step create mode always runs, since a stale verdict
// set from the moment of original creation could no longer match live
// geometry) and preselects the stored accept mask over that fresh verdict
// set. Apply adopts the page-owned preview when that seam is supplied; legacy
// callers still rewrite the SAME node through EditFeaturePayloadCommand.

import { useText, textFor } from '../../../i18n'
const workbenchText = textFor('sketch-and-model-workbench')
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { GripVertical, X } from 'lucide-react'
import type { CommandHistory, FeatureDag } from '../../../doc'
import type { FeatureClass, FeatureVerdict } from '../../../geom/geom-service'
import { createDirectEditFeatureCommand } from './createFeatureCommand'
import { EditFeaturePayloadCommand } from './EditFeaturePayloadCommand'
import { nextId } from './nextId'

export type DefeatureClassDisposition =
  | { kind: 'accept' }
  | { kind: 'decline'; reason: string }

/** Total-domain recognition policy. `satisfies Record<FeatureClass, ...>` makes
 * every new engine class a build error until the UI explicitly accepts or
 * declines it. Declined classes remain visible as named, disabled picker rows. */
export const DEFEATURE_CLASS_DISPOSITIONS = {
  throughHole: { kind: 'accept' },
  blindHole: { kind: 'accept' },
  counterboreStack: { kind: 'accept' },
  pocket: { kind: 'accept' },
  engravedText: { kind: 'accept' },
  boss: { kind: 'accept' },
  filletPlanar: { kind: 'accept' },
  chamferPlanar: { kind: 'accept' },
  filletCurvedCorner: { kind: 'accept' },
  filletChain: { kind: 'accept' },
  chamferChain: { kind: 'accept' },
  sliver: { kind: 'decline', get reason() { return workbenchText('DefeatureDialog.defeatureDeclinesSliverSliverRemovalIsNotSupportedBy') } },
} as const satisfies Record<FeatureClass, DefeatureClassDisposition>

export const DEFEATURE_CLASSES = Object.freeze(
  (Object.entries(DEFEATURE_CLASS_DISPOSITIONS) as [FeatureClass, DefeatureClassDisposition][])
    .filter(([, disposition]) => disposition.kind === 'accept')
    .map(([featureClass]) => featureClass),
)

export function disposeDefeatureVerdict(verdict: FeatureVerdict): FeatureVerdict {
  const disposition: DefeatureClassDisposition = DEFEATURE_CLASS_DISPOSITIONS[verdict.featureClass]
  if (disposition.kind === 'accept') return verdict
  return { ...verdict, removable: false, refuseReason: disposition.reason }
}

export interface DefeatureFeaturePayload extends Record<string, unknown> {
  opType: 'defeature'
  ownerId: string
  featureKeys: string[]
  name: string
}

export interface DefeaturePreviewIntent {
  readonly featureId: string
  readonly payload: DefeatureFeaturePayload
}

export interface DefeatureDialogProps {
  dag: FeatureDag
  history: CommandHistory
  ownerId: string
  verdicts: FeatureVerdict[]
  /** defaults to 'create' -- existing create-only call sites need no change. */
  mode?: 'create' | 'edit'
  /** required in edit mode */
  featureId?: string
  /** required in edit mode -- the stored accept mask, preselected over the
   *  freshly re-recognized verdict set. */
  initialFeatureKeys?: string[]
  // DEFEATURE-CLICK-PICK (Q-68): when the parent drives an in-viewport pick it
  // OWNS the accept mask -- so the viewport paint can read it every repaint and a
  // face-click can toggle the SAME set the checkboxes drive. Provide BOTH
  // selectedKeys + onToggleKey to run controlled; omit both to keep the original
  // self-managed checkbox list (every standalone caller/test path).
  selectedKeys?: ReadonlySet<string>
  onToggleKey?: (featureKey: string) => void
  /** the verdict currently hovered in the viewport -- highlights its row so the
   *  face<->row link works in the viewport->row direction. */
  hoverKey?: string | null
  /** report a row hover (enter/leave) up, so hovering a row highlights its face
   *  set in the viewport (the row->viewport direction). */
  onRowHover?: (featureKey: string | null) => void
  /** Live healed-body preview feedback. Apply is gated until the selected mask
   * has produced a complete preview; failures stay visible and actionable. */
  previewFeedback?: DefeaturePreviewFeedback
  /** Controlled edit seam: adopt the already-built preview as the authoritative
   * history transaction. A returned error is shown without closing the dialog. */
  onApplyPreview?: (intent: DefeaturePreviewIntent) => Promise<string | undefined>
  onApplied(featureId: string): void
  onClose(): void
}

export interface DefeaturePreviewFeedback {
  kind: 'idle' | 'building' | 'ready' | 'failed'
  message: string
}

const FEATURE_CLASS_LABELS = {
  get throughHole() { return workbenchText('DefeatureDialog.throughHole') },
  get blindHole() { return workbenchText('DefeatureDialog.blindHole') },
  get counterboreStack() { return workbenchText('DefeatureDialog.counterboreStack') },
  get pocket() { return workbenchText('DefeatureDialog.pocket') },
  get engravedText() { return workbenchText('DefeatureDialog.engravedText') },
  get boss() { return workbenchText('DefeatureDialog.boss') },
  get filletPlanar() { return workbenchText('DefeatureDialog.planarFillet') },
  get chamferPlanar() { return workbenchText('DefeatureDialog.planarChamfer') },
  get filletCurvedCorner() { return workbenchText('DefeatureDialog.curvedCornerFillet') },
  get filletChain() { return workbenchText('DefeatureDialog.filletChain') },
  get chamferChain() { return workbenchText('DefeatureDialog.chamferChain') },
  get sliver() { return workbenchText('DefeatureDialog.sliver') },
} as const satisfies Record<FeatureClass, string>

function classLabel(featureClass: FeatureClass): string {
  return FEATURE_CLASS_LABELS[featureClass]
}

/** hole/fillet classes each measure themselves with a different key; chamfer keeps
 *  its pre-existing preference order. Classes absent here (pocket, boss,
 *  engravedText, sliver) have no single well-known key and fall through to the
 *  length-like-name search below. */
const PREFERRED_MEASURED_KEYS: Partial<Record<FeatureClass, string[]>> = {
  throughHole: ['diameter'],
  blindHole: ['diameter'],
  counterboreStack: ['diameter'],
  filletPlanar: ['radius'],
  filletCurvedCorner: ['radius'],
  filletChain: ['radius'],
  chamferPlanar: ['distance', 'radius', 'width'],
  chamferChain: ['distance', 'distanceA'],
}

/** axisX/axisY/axisZ (direction) and centerX/centerY/centerZ (position) are never
 *  a length -- rendering them with an "mm" suffix dresses up a direction or
 *  position component as a measurement (WO-1486). */
const LENGTH_LIKE_KEY = /^(diameter|depth|radius|width|distance|span|setback|thickness|length)/i

function measuredParam(verdict: FeatureVerdict): string {
  const entries = Object.entries(verdict.params).filter(([, value]) =>
    typeof value === 'number' ? Number.isFinite(value) : value.trim().length > 0,
  )
  if (entries.length === 0) return workbenchText('DefeatureDialog.measuredParameterUnavailable')
  const preferredKeys = PREFERRED_MEASURED_KEYS[verdict.featureClass] ?? []
  const entry = preferredKeys.map((key) => entries.find(([name]) => name === key)).find((candidate) => candidate !== undefined)
    ?? entries.find(([name]) => LENGTH_LIKE_KEY.test(name))
  if (entry === undefined) return workbenchText('DefeatureDialog.measuredParameterUnavailable')
  const [key, value] = entry
  const rendered = typeof value === 'number' ? workbenchText('DefeatureDialog.mm', { value1: String(Number(value.toFixed(4))) }) : value
  return `${key} ${rendered}`
}

function featureFamily(featureClass: FeatureClass): string {
  if (featureClass === 'throughHole' || featureClass === 'blindHole' || featureClass === 'counterboreStack') return 'hole'
  if (featureClass.startsWith('fillet')) return 'fillet'
  if (featureClass.startsWith('chamfer')) return 'chamfer'
  if (featureClass === 'engravedText') return 'engraving'
  return featureClass
}

/** WO-2120: what one Defeature Apply removed, said after the fact in plain
 *  words - "Removed the through hole (diameter 10 mm) from fix_plate_holes." */
export function defeatureRemovedLine(verdicts: readonly FeatureVerdict[], ownerLabel: string): string {
  const named = verdicts.map((verdict) => {
    const kind = classLabel(verdict.featureClass).toLowerCase()
    const measure = measuredParam(verdict)
    return measure === 'measured parameter unavailable' ? kind : `${kind} (${measure})`
  })
  if (named.length === 0) return workbenchText('DefeatureDialog.removedThePickedFeaturesFrom', { ownerLabel: String(ownerLabel) })
  if (named.length === 1) return workbenchText('DefeatureDialog.removedTheFrom', { value1: String(named[0]), ownerLabel: String(ownerLabel) })
  return workbenchText('DefeatureDialog.removedFeaturesFrom', { length: String(named.length), ownerLabel: String(ownerLabel), value3: String(named.join(', ')) })
}

/** DEFEATURE-CLICK-PICK (Q-68): one plain-words label for a recognized verdict,
 *  shared by the picker rows AND the SolidsWorkbenchPage console lines
 *  (arm/hover-change/toggle) so the in-viewport feedback names a feature exactly
 *  the way its list row does -- single source of truth for both surfaces. */
export function defeatureVerdictLabel(verdict: FeatureVerdict): string {
  const faces = verdict.faceIds.length
  return workbenchText('DefeatureDialog.face', { value1: String(classLabel(verdict.featureClass)), value2: String(measuredParam(verdict)), faces: String(faces), value4: String(faces === 1 ? '' : 's') })
}

/** A viewport face selects the complete recognized feature group that owns it.
 * This is the Delete Face interaction boundary: holes and stacked features may
 * span several faces, and passing only the hit face would ask the healer to
 * operate on an incoherent subset. */
export function defeatureVerdictForFace(verdicts: readonly FeatureVerdict[], faceId: string): FeatureVerdict | undefined {
  return verdicts.find((verdict) => verdict.removable && verdict.faceIds.includes(faceId))
}

export function defeatureRemovalName(verdicts: FeatureVerdict[]): string {
  const families = new Set(verdicts.map((verdict) => featureFamily(verdict.featureClass)))
  if (families.size === 1) {
    const family = [...families][0]
    return workbenchText('DefeatureDialog.delete', { length: String(verdicts.length), family: String(family), value3: String(verdicts.length === 1 ? '' : 's') })
  }
  return workbenchText('DefeatureDialog.deleteFeatureGroups', { length: String(verdicts.length) })
}

function selectionSummary(verdicts: FeatureVerdict[]): string {
  const counts = new Map<string, number>()
  for (const verdict of verdicts) {
    const family = featureFamily(verdict.featureClass)
    counts.set(family, (counts.get(family) ?? 0) + 1)
  }
  return [...counts]
    .map(([family, count]) => `${count} ${family}${count === 1 ? '' : 's'}`)
    .join(', ')
}

export function DefeatureDialog({ dag, history, ownerId, verdicts, mode = 'create', featureId, initialFeatureKeys, selectedKeys: controlledKeys, onToggleKey, hoverKey, onRowHover, previewFeedback, onApplyPreview, onApplied, onClose }: DefeatureDialogProps) {
  const workbenchText = useText('sketch-and-model-workbench')
  const editing = mode === 'edit'
  const removable = useMemo(() => verdicts.filter((v) => v.removable), [verdicts])
  // WO-2766: a single-face refusal ("cannot be rebuilt on its own") a removable
  // blend chain covers is not shown - the chain row is what removes it.
  const rows = useMemo(() => verdicts.filter((v) => v.removable || v.faceIds.length === 0 || !removable.some((chain) =>
    (chain.featureClass === 'filletChain' || chain.featureClass === 'chamferChain') && v.faceIds.every((id) => chain.faceIds.includes(id)))), [removable, verdicts])
  // Controlled when the parent supplies both the mask and its toggle; otherwise
  // the dialog owns the mask internally exactly as it did before this WO.
  const controlled = controlledKeys !== undefined && onToggleKey !== undefined
  const [internalKeys, setInternalKeys] = useState<Set<string>>(() => {
    if (editing && initialFeatureKeys !== undefined) {
      const stored = new Set(initialFeatureKeys)
      return new Set(removable.filter((v) => stored.has(v.featureKey)).map((v) => v.featureKey))
    }
    return new Set(removable.map((v) => v.featureKey))
  })
  const selectedKeys: ReadonlySet<string> = controlled ? controlledKeys : internalKeys
  const [applyError, setApplyError] = useState<string | undefined>(undefined)
  const [applying, setApplying] = useState(false)
  const applyingRef = useRef(false)

  const selectedVerdicts = removable.filter((v) => selectedKeys.has(v.featureKey))
  // When a live preview is connected, only that exact successful healed body
  // authorizes Apply. "Idle" is not success and must never sneak through a
  // render/effect gap after the selection changes.
  const previewBlocksApply = previewFeedback !== undefined && previewFeedback.kind !== 'ready'
  const invalid = selectedVerdicts.length === 0 || previewBlocksApply
  const cardRef = useRef<HTMLElement | null>(null)
  const dragRef = useRef<{ pointerId: number; offsetX: number; offsetY: number } | null>(null)
  const [cardPosition, setCardPosition] = useState(() => ({
    x: Math.min(276, Math.max(12, (typeof window === 'undefined' ? 1024 : window.innerWidth) - 340)),
    y: 76,
  }))

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !applyingRef.current) onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  // Layout effect: the drag listeners exist the moment the card is in the DOM.
  // A passive effect can run after the header already took a pointerdown, and
  // that drag's moves were lost (the card stayed put).
  useLayoutEffect(() => {
    const onPointerMove = (event: PointerEvent): void => {
      const drag = dragRef.current
      if (drag === null || drag.pointerId !== event.pointerId) return
      const bounds = cardRef.current?.getBoundingClientRect()
      const width = bounds?.width ?? 328
      const height = bounds?.height ?? 280
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
    if ((event.target as HTMLElement).closest('button, input, summary') !== null) return
    const bounds = cardRef.current?.getBoundingClientRect()
    if (bounds === undefined) return
    dragRef.current = {
      pointerId: event.pointerId,
      offsetX: event.clientX - bounds.left,
      offsetY: event.clientY - bounds.top,
    }
    event.preventDefault()
  }

  const toggle = (featureKey: string): void => {
    if (applyingRef.current) return
    if (controlled) {
      onToggleKey(featureKey)
      return
    }
    setInternalKeys((current) => {
      const next = new Set(current)
      if (next.has(featureKey)) next.delete(featureKey)
      else next.add(featureKey)
      return next
    })
  }

  const handleApply = async (): Promise<void> => {
    if (invalid || applyingRef.current) return
    setApplyError(undefined)
    const featureKeys = selectedVerdicts.map((v) => v.featureKey)
    const id = editing && featureId !== undefined ? featureId : nextId(dag, 'F')
    const payload: DefeatureFeaturePayload = {
      opType: 'defeature',
      ownerId,
      featureKeys,
      name: defeatureRemovalName(selectedVerdicts),
    }
    // When the page owns an accepted scratch preview, create and edit share
    // one adoption boundary. The dialog must not mutate the DAG first: doing
    // so would force the page to recompute the operation that the user just
    // accepted and could publish geometry different from the preview.
    if (onApplyPreview !== undefined) {
      applyingRef.current = true
      setApplying(true)
      try {
        const error = await onApplyPreview({ featureId: id, payload })
        if (error !== undefined) {
          setApplyError(error)
          return
        }
        onApplied(id)
        onClose()
        return
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        setApplyError(workbenchText('DefeatureDialog.defeatureApplyFailed', { message: String(message) }))
        return
      } finally {
        applyingRef.current = false
        setApplying(false)
      }
    }
    if (editing && featureId !== undefined) {
      try {
        history.execute(new EditFeaturePayloadCommand(featureId, payload, [ownerId]))
      } catch (err) {
        setApplyError(err instanceof Error ? err.message : String(err))
        return
      }
      onApplied(featureId)
      onClose()
      return
    }
    try {
      history.execute(createDirectEditFeatureCommand(dag, { id, kind: 'feature', consumes: [ownerId], payload }))
    } catch (err) {
      setApplyError(err instanceof Error ? err.message : String(err))
      return
    }
    onApplied(id)
    onClose()
  }

  const requestClose = (): void => {
    if (!applyingRef.current) onClose()
  }

  return (
    <aside
      ref={cardRef}
      className="defeature-command-card"
      data-testid="defeature-command-card"
      data-primary-interaction="viewport-pick"
      data-ui78-sanctioned=""
      aria-labelledby="defeature-command-title"
      style={{ left: cardPosition.x, top: cardPosition.y }}
    >
      <header className="defeature-command-header" onPointerDown={beginCardDrag}>
        <GripVertical size={14} aria-hidden="true" />
        <div className="defeature-command-heading">
          <span className="defeature-command-kicker">{workbenchText('DefeatureDialog.deleteFaces')}</span>
          <strong id="defeature-command-title">{editing ? workbenchText('DefeatureDialog.editHealedRemoval') : workbenchText('DefeatureDialog.pickFeaturesInTheModel')}</strong>
        </div>
        <button
          type="button"
          className="modal-close-btn"
          aria-label={workbenchText('DefeatureDialog.cancelDeleteFaces')}
          data-testid="dialog-shell-close"
          disabled={applying}
          onClick={requestClose}
        >
          <X size={14} />
        </button>
      </header>
      <div className="defeature-command-body">
        <div data-testid="defeature-picker" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {controlled && (
          <div style={{ color: 'var(--text-primary)', fontSize: 'var(--font-size-sm)', lineHeight: 1.4 }}>
            {workbenchText('DefeatureDialog.clickFacesInTheViewportARecognizedHolePocket')}</div>
        )}
        {removable.length === 0 && (
          <div data-testid="defeature-empty" style={{ color: 'var(--text-secondary)' }}>
            {workbenchText('DefeatureDialog.noRemovableFaceGroupsWereFoundOnThisBody')}</div>
        )}
        {removable.length > 0 && (
          <div
            data-testid="defeature-summary"
            style={{ color: 'var(--text-secondary)', fontSize: 'var(--font-size-sm)', borderTop: '1px solid var(--border-subtle, rgba(255,255,255,0.12))', paddingTop: 6, marginTop: 2 }}
          >
            {workbenchText('DefeatureDialog.ofSelected', { length: String((selectedVerdicts.length) ?? ''), length2: String((removable.length) ?? '') })}{selectedVerdicts.length > 0 && (
              <>{workbenchText('DefeatureDialog.value')}{selectionSummary(selectedVerdicts)}</>
            )}
          </div>
        )}
        {previewFeedback !== undefined && (
          <div
            data-testid="defeature-preview-status"
            data-state={previewFeedback.kind}
            role={previewFeedback.kind === 'failed' ? 'alert' : 'status'}
            style={{
              color: previewFeedback.kind === 'failed'
                ? 'var(--status-error)'
                : previewFeedback.kind === 'ready'
                  ? 'var(--status-ready)'
                  : 'var(--text-secondary)',
              fontSize: 'var(--font-size-sm)',
              lineHeight: 1.4,
            }}
          >
            {previewFeedback.message}
          </div>
        )}
        <details data-testid="defeature-selection-details">
          <summary style={{ cursor: 'pointer', color: 'var(--text-secondary)', fontSize: 'var(--font-size-sm)' }}>
            {workbenchText('DefeatureDialog.recognizedFaceGroups')}</summary>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 220, overflowY: 'auto', paddingTop: 6 }}>
            {rows.map((verdict) => {
              const reason = verdict.removable
                ? workbenchText('DefeatureDialog.selectThisRecognizedFeatureForRemoval')
                : (verdict.refuseReason?.trim() || workbenchText('DefeatureDialog.recognitionDidNotProvideARefusalReason'))
              const hovered = hoverKey === verdict.featureKey && verdict.removable
              return (
                <label
                  key={verdict.featureKey}
                  data-testid={`defeature-row-${verdict.featureKey}`}
                  data-hovered={hovered ? 'true' : undefined}
                  data-tooltip={reason}
                  aria-disabled={applying || !verdict.removable}
                  onMouseEnter={() => onRowHover?.(verdict.removable ? verdict.featureKey : null)}
                  onMouseLeave={() => onRowHover?.(null)}
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 8,
                    padding: '2px 4px',
                    borderRadius: 4,
                    cursor: !applying && verdict.removable ? 'pointer' : 'default',
                    backgroundColor: hovered ? 'color-mix(in srgb, var(--accent-blue) 22%, transparent)' : 'transparent',
                    boxShadow: hovered ? 'inset 2px 0 0 0 var(--accent-blue)' : 'none',
                    color: verdict.removable ? 'var(--text-primary)' : 'var(--text-disabled)',
                  }}
                >
                  <input
                    type="checkbox"
                    data-testid={`defeature-check-${verdict.featureKey}`}
                    checked={selectedKeys.has(verdict.featureKey)}
                    disabled={applying || !verdict.removable}
                    onChange={() => toggle(verdict.featureKey)}
                  />
                  <span>
                    {classLabel(verdict.featureClass)}{workbenchText('DefeatureDialog.value')}{measuredParam(verdict)}
                    {!verdict.removable && <>{workbenchText('DefeatureDialog.declined')}{reason}</>}
                  </span>
                </label>
              )
            })}
          </div>
        </details>
        {applyError !== undefined && (
          <div data-testid="defeature-apply-error" style={{ color: 'var(--status-error)', fontSize: 'var(--font-size-sm)' }}>
            {applyError}
          </div>
        )}
        </div>
      </div>
      <footer className="defeature-command-footer">
        <button type="button" className="modal-btn modal-btn-ghost" data-testid="dialog-shell-cancel" disabled={applying} onClick={requestClose}>
          {workbenchText('DefeatureDialog.cancel')}</button>
        <button
          type="button"
          className="modal-btn modal-btn-primary"
          data-testid="dialog-shell-apply"
          disabled={invalid || applying}
          onClick={handleApply}
        >
          {workbenchText('DefeatureDialog.applyRemoval')}</button>
      </footer>
    </aside>
  )
}
