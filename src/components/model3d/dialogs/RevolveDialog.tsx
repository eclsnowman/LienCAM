// WO INT-4A: revolve dialog -- same create/edit split as ExtrudeDialog.tsx
// (see its header). Axis is fixed to the world Z axis through the origin:
// the workbench only ever creates 'xz'-plane sketch profiles offset from
// that axis (workbench/profileGeometry.ts), so a free-form axis picker would
// be UI surface with nothing behind it -- out of scope per the WO's "no new
// UX inventions" instruction.
//
// WO INT-4A-R1 (R1.1): angleDeg is DRIVING, same optional bound-expression
// seam as ExtrudeDialog.tsx's distance -- see that file's header and
// workbench/featureDimension.ts for the shared contract.
//
// WO-039 (UI-107 slice 3): the dialog's live-preview seam on ExtrudeDialog's
// WO-035 shape -- the extrude PROFILE-CONSUMING intent template plus the AXIS
// reference the census names (fixed world-Z here; a tagged reference so the
// guard's intent equality covers it and a future axis picker extends the
// union instead of reshaping the intent). The page owns the
// FeaturePreviewSession; Apply routes through onApplyGuard BEFORE any history
// command executes. Edit mode also emits the saved profile for highlighting
// and the page highlights the axis reference in the viewport.
//
// WO-2222: the axis picker arrived -- Axis offers world Z or any axis datum (Construct: Axis) upstream
// of this revolve. The payload names the datum (`axisDatumId`) and the node consumes it, so moving the
// axis re-revolves.

import { useEffect, useMemo, useRef, useState } from 'react'
import { NumericInput } from '../../ui/NumericInput'
import type { CommandHistory, FeatureDag } from '../../../doc'
import { DialogShell } from './DialogShell'
import { EditFeaturePayloadCommand } from './EditFeaturePayloadCommand'
import { createFeatureCommand } from './createFeatureCommand'
import { nextId } from './nextId'
import { featureExpressionParamConsumes, validateFeatureExpression } from '../workbench/featureDimension'
import type { ProfilePickResult, StartProfilePick } from '../workbench/profileRegionPicker'
import { resolveProfileSelector, type ProfileSelector } from '../workbench/regionSelector'
import type { ProfileRegion, Vec3 } from '../../../geom/geom-service'
import { useCamStore } from '../../../store'
import { axisLineOfNode, isAxisDatumPayload } from '../../../sketch3d'

export interface RevolveFeaturePayload {
  opType: 'revolve'
  sketchId: string
  /** Missing means legacy first closed region; explicit picks remain stable across region reorder. */
  profileSelector?: ProfileSelector
  angleDeg: number
  /** Optional driving expression (e.g. "180+extra") -- see featureDimension.ts. */
  expression?: string
  name: string
  /** WO-2222: the axis datum node revolved about; absent means world Z through the origin. */
  axisDatumId?: string
}

/** WO-039: the revolve axis reference. The workbench only ever creates
 *  profiles revolved about the world Z axis through the origin (see this
 *  file's header), so 'world-z' is the only member today; carrying it in the
 *  preview intent makes the commit-time guard's intent equality cover the
 *  axis and gives a future axis picker a union to extend. */
export type RevolveAxisReference = { kind: 'world-z' } | { kind: 'datum'; id: string }

// WO-039 (UI-107 slice 3): one preview request. Geometric fields only (the
// feature name never rides here) -- ExtrudePreviewIntent's template minus the
// newBody/add-or-cut target (revolve authors newBody only today) plus the
// axis reference.
export interface RevolvePreviewIntent {
  mode: 'create' | 'edit'
  /** edit mode only */
  featureId?: string
  sketchId: string
  profileSelector?: ProfileSelector
  /** Degrees in (0, 360], already clamped by the dialog's numeric field. */
  angleDeg: number
  axis: RevolveAxisReference
  /** Optional driving expression; the scratch replay re-evaluates it. */
  expression?: string
}

export type RevolvePreviewState =
  | { status: 'idle' | 'pending' | 'ready' }
  | { status: 'refused'; message: string }

export interface RevolveDialogProps {
  dag: FeatureDag
  history: CommandHistory
  mode: 'create' | 'edit'
  featureId?: string
  sketchOptions?: Array<{ id: string; label: string }>
  treeSketchPick?: { sketchId: string; nonce: number }
  onTreePickConsumed?: (nonce: number) => void
  onStartProfilePick?: StartProfilePick
  /** Keeps the chosen-region outline synchronized with secondary selection controls. */
  onProfileSelectionChange?: (selection: ProfilePickResult | null) => void
  onApplied(featureId: string): void
  onClose(): void
  /** WO-039: page-owned preview session status (idle/pending/ready/refused). */
  previewState?: RevolvePreviewState
  /** WO-039: emitted on every geometric change; null when the current values
   *  cannot form a valid preview (missing profile, out-of-range angle, bad
   *  expression). */
  onPreviewIntent?: (intent: RevolvePreviewIntent | null) => void
  /** WO-039: commit-time guard, REQUIRED semantics from day one (WO-030's
   *  audit lesson): runs BEFORE history.execute and refuses Apply unless the
   *  dialog intent IS the accepted ready intent and the session baseline
   *  fingerprint still matches the authored model. */
  onApplyGuard?: (intent: RevolvePreviewIntent) => Promise<string | undefined>
}

const DEFAULT_ANGLE = 270

// WO-1474: a profile whose plane normal is the revolve axis lies perpendicular
// to it, so revolving it sweeps no volume -- the kernel cannot build that solid.
// The refusal stays; the operator gets the reason on the app console instead of
// a silently disabled Apply. WO-2222: the axis is world Z or the chosen axis datum.
const AXIS_PARALLEL_EPS = 1e-6
const WORLD_Z: Vec3 = { x: 0, y: 0, z: 1 }
const axisIncompatibleMessage = (axisWords: string): string =>
  `Revolve refused: the selected profile lies in a plane whose normal is the revolve axis (${axisWords}), so revolving it sweeps no volume and can produce no solid.`

/** True only when the selected profile's plane normal can be read and is
 *  (anti)parallel to the axis direction. Anything unreadable answers false, so the
 *  dialog behaves as it did before this check existed. */
function profileNormalIsRevolveAxis(regions: unknown, selector: ProfileSelector | undefined, axisDir: Vec3): boolean {
  if (!Array.isArray(regions)) return false
  try {
    const resolution = resolveProfileSelector(regions as ProfileRegion[], selector)
    if (!resolution.ok) return false
    const normal = resolution.profiles[0]?.plane?.normal
    if (normal === undefined || ![normal.x, normal.y, normal.z].every(Number.isFinite)) return false
    const n = Math.hypot(normal.x, normal.y, normal.z)
    const a = Math.hypot(axisDir.x, axisDir.y, axisDir.z)
    if (!(n > AXIS_PARALLEL_EPS) || !(a > AXIS_PARALLEL_EPS)) return false
    const cx = normal.y * axisDir.z - normal.z * axisDir.y
    const cy = normal.z * axisDir.x - normal.x * axisDir.z
    const cz = normal.x * axisDir.y - normal.y * axisDir.x
    return Math.hypot(cx, cy, cz) / (n * a) < AXIS_PARALLEL_EPS
  } catch {
    return false
  }
}

/** WO-2222: the axis datums this revolve may turn about (in edit, only those upstream of it). */
function revolveAxisOptions(dag: FeatureDag, featureId: string | undefined, editing: boolean): Array<{ id: string; label: string }> {
  return dag.nodeIds()
    .filter((id) => {
      const node = dag.getNode(id)
      return node !== undefined && node.kind === 'datum' && isAxisDatumPayload(node.payload) && (!editing || isUpstreamProducer(dag, featureId, id))
    })
    .map((id) => ({ id, label: String(dag.getNode(id)?.payload.name ?? id) }))
}

function isUpstreamProducer(dag: FeatureDag, featureId: string | undefined, producerId: string): boolean {
  if (featureId === undefined || producerId === featureId) return false
  const order = dag.featureOrder()
  const featureIndex = order.indexOf(featureId)
  const producerIndex = order.indexOf(producerId)
  if (featureIndex === -1 || producerIndex === -1 || producerIndex >= featureIndex) return false

  const pending = [producerId]
  const visited = new Set<string>()
  while (pending.length > 0) {
    const id = pending.pop()!
    if (id === featureId) return false
    if (visited.has(id)) continue
    visited.add(id)
    pending.push(...(dag.getNode(id)?.consumes ?? []))
  }
  return true
}

export function RevolveDialog({ dag, history, mode, featureId, sketchOptions, treeSketchPick, onTreePickConsumed, onStartProfilePick, onProfileSelectionChange, onApplied, onClose, previewState, onPreviewIntent, onApplyGuard }: RevolveDialogProps) {
  const editing = mode === 'edit'
  const existing = editing && featureId !== undefined ? (dag.getNode(featureId)?.payload as unknown as RevolveFeaturePayload | undefined) : undefined
  const suppliedSketches = sketchOptions ?? dag.nodeIds()
    .filter((id) => dag.getNode(id)?.kind === 'sketch')
    .map((id) => ({ id, label: String(dag.getNode(id)?.payload.name ?? id) }))
  const sketches = suppliedSketches.filter((option) => !editing || isUpstreamProducer(dag, featureId, option.id))
  const [sketchId, setSketchId] = useState<string>(existing?.sketchId ?? sketches[0]?.id ?? '')
  const [profileSelector, setProfileSelector] = useState<ProfileSelector | undefined>(existing?.profileSelector)
  const [treeSelectionActive, setTreeSelectionActive] = useState(false)
  const [isPickingProfile, setIsPickingProfile] = useState(false)
  const stopProfilePickRef = useRef<(() => void) | undefined>(undefined)
  const handledTreeSketchPickNonceRef = useRef(0)
  const [angleDeg, setAngleDeg] = useState<number>(existing?.angleDeg ?? DEFAULT_ANGLE)
  const axisOptions = revolveAxisOptions(dag, featureId, editing)
  const [axisDatumId, setAxisDatumId] = useState<string>(existing?.axisDatumId ?? '')
  const axisDir = axisDatumId === '' ? WORLD_Z : axisLineOfNode(dag, axisDatumId)?.dir
  const axisWords = axisDatumId === '' ? 'world Z' : (axisOptions.find((option) => option.id === axisDatumId)?.label ?? axisDatumId)
  const [expression, setExpression] = useState<string>(existing?.expression ?? '')
  const [expressionError, setExpressionError] = useState<string | undefined>(undefined)
  const [applyError, setApplyError] = useState<string | undefined>(undefined)
  const profileAvailable = sketches.some((option) => option.id === sketchId)
  const treeSketchPickAvailable = treeSketchPick !== undefined && sketches.some((option) => option.id === treeSketchPick.sketchId)
  // WO-1474: computed inline each render -- `dag` keeps its identity while a
  // sketch's regions regenerate, so a memo keyed on it would go stale.
  const profileAxisIncompatible = profileAvailable && axisDir !== undefined && profileNormalIsRevolveAxis(dag.getNode(sketchId)?.payload.regions, profileSelector, axisDir)
  const axisWarnedRef = useRef(false)

  useEffect(() => {
    // One app console warning per change INTO the incompatible state.
    if (!profileAxisIncompatible) {
      axisWarnedRef.current = false
      return
    }
    if (axisWarnedRef.current) return
    axisWarnedRef.current = true
    useCamStore.getState().addConsoleEvent({ severity: 'warning', source: 'model', message: axisIncompatibleMessage(axisWords) })
  }, [profileAxisIncompatible, axisWords])

  useEffect(() => {
    if (treeSketchPick === undefined || treeSketchPick.nonce <= handledTreeSketchPickNonceRef.current) return
    handledTreeSketchPickNonceRef.current = treeSketchPick.nonce
    if (isPickingProfile || !treeSketchPickAvailable) {
      console.info(`Tree pick ignored: ${isPickingProfile ? 'profile pick session is active' : 'sketch is not available'}`)
      onTreePickConsumed?.(treeSketchPick.nonce)
      return
    }
    setSketchId(treeSketchPick.sketchId)
    setProfileSelector({ kind: 'whole-sketch' })
    setTreeSelectionActive(true)
    onTreePickConsumed?.(treeSketchPick.nonce)
  }, [treeSketchPick, treeSketchPickAvailable, isPickingProfile, onTreePickConsumed])

  useEffect(() => {
    // WO-039 (per WO-035's extrude template): edit mode restores + visibly
    // highlights the SAVED profile even when it is a whole-sketch/legacy
    // selector (the region case already highlighted); create keeps its prior
    // region-only behavior.
    onProfileSelectionChange?.(
      profileSelector?.kind === 'region'
        ? { sketchId, profileSelector }
        : editing && profileAvailable
          ? { sketchId, profileSelector: { kind: 'whole-sketch' } }
          : null,
    )
    return () => onProfileSelectionChange?.(null)
  }, [sketchId, profileSelector, onProfileSelectionChange, editing, profileAvailable])

  const previewControlled = onPreviewIntent !== undefined
  // A pending preview does NOT disable Apply: the page's onApplyGuard awaits
  // the in-flight evaluation and commits only its accepted candidate. Only an
  // explicit refusal (bad geometry, drifted model) blocks the button.
  // WO-1474: an axis-normal profile is refused here, preview session or not --
  // the kernel does not refuse it (it returns a zero-volume body), so nothing
  // downstream would.
  const revolvableProfile = profileAvailable && !profileAxisIncompatible
  const applyDisabled = !revolvableProfile ||
    (previewControlled && previewState?.status === 'refused')

  // WO-039: the live preview request. Null (which cancels any session) when
  // the current values cannot evaluate: no resolvable profile, an angle
  // outside (0, 360], or an expression that fails validation. The numeric
  // field clamps to [1, 360], so out-of-range angles are only reachable
  // through a stale initial payload.
  const boundExpression = expression.trim()
  const previewIntent = useMemo<RevolvePreviewIntent | null>(() => {
    if (!revolvableProfile) return null
    if (!Number.isFinite(angleDeg) || angleDeg <= 0 || angleDeg > 360) return null
    if (boundExpression !== '' && !validateFeatureExpression(boundExpression).ok) return null
    return {
      mode,
      ...(editing && featureId !== undefined ? { featureId } : {}),
      sketchId,
      ...(profileSelector !== undefined ? { profileSelector } : {}),
      angleDeg,
      axis: axisDatumId === '' ? { kind: 'world-z' } : { kind: 'datum', id: axisDatumId },
      ...(boundExpression !== '' ? { expression: boundExpression } : {}),
    }
  }, [revolvableProfile, angleDeg, boundExpression, mode, editing, featureId, sketchId, profileSelector, axisDatumId])

  useEffect(() => {
    onPreviewIntent?.(previewIntent)
  }, [onPreviewIntent, previewIntent])

  const beginProfilePick = (): void => {
    if (onStartProfilePick === undefined) return
    setIsPickingProfile(true)
    const stop = onStartProfilePick({
      allowedIds: sketches.map((option) => option.id),
      prompt: 'Click a closed sketch region for the revolve profile.',
      maxPicks: 1,
      onDone: ([result]) => {
        if (result !== undefined) {
          setSketchId(result.sketchId)
          setProfileSelector(result.profileSelector)
          setTreeSelectionActive(false)
        }
        stopProfilePickRef.current = undefined
        setIsPickingProfile(false)
      },
      onCancel: () => {
        stopProfilePickRef.current = undefined
        setIsPickingProfile(false)
      },
    })
    stopProfilePickRef.current = typeof stop === 'function' ? stop : undefined
  }

  const cancelProfilePick = (): void => {
    const stop = stopProfilePickRef.current
    stopProfilePickRef.current = undefined
    if (stop !== undefined) stop()
    else setIsPickingProfile(false)
  }

  const handleApply = async (): Promise<void> => {
    const bound = expression.trim()
    if (bound !== '') {
      const validation = validateFeatureExpression(bound)
      if (!validation.ok) {
        setExpressionError(`${validation.diag?.code}: ${JSON.stringify(validation.diag?.params)}`)
        return
      }
    }
    setExpressionError(undefined)
    setApplyError(undefined)
    // WO-039: commit-time guard BEFORE any history command. The page verifies
    // the current dialog intent IS the accepted ready intent and the session
    // baseline fingerprint still matches; a refusal never reaches execute.
    if (onApplyGuard !== undefined) {
      if (previewIntent === null) {
        setApplyError('Revolve Apply refused: the accepted preview is no longer available.')
        return
      }
      const refusal = await onApplyGuard(previewIntent)
      if (refusal !== undefined) {
        setApplyError(refusal)
        return
      }
    }
    const paramConsumes = featureExpressionParamConsumes(bound === '' ? undefined : bound)

    if (editing && featureId !== undefined) {
      const node = dag.getNode(featureId)
      const { expression: _priorExpression, profileSelector: _priorProfileSelector, axisDatumId: _priorAxis, ...restPayload } = node?.payload ?? {}
      const payload = {
        ...restPayload,
        sketchId,
        ...(profileSelector !== undefined ? { profileSelector } : {}),
        angleDeg,
        ...(bound !== '' ? { expression: bound } : {}),
        ...(axisDatumId !== '' ? { axisDatumId } : {}),
      }
      const nonProfileConsumes = (node?.consumes ?? []).filter((c) => c !== existing?.sketchId && c !== existing?.axisDatumId && !c.startsWith('param:'))
      const axisConsumes = axisDatumId === '' ? [] : [axisDatumId]
      try {
        history.execute(new EditFeaturePayloadCommand(featureId, payload, [...new Set([sketchId, ...nonProfileConsumes, ...axisConsumes, ...paramConsumes])]))
      } catch (err) {
        setApplyError(err instanceof Error ? err.message : String(err))
        return
      }
      onApplied(featureId)
    } else {
      const id = nextId(dag, 'F')
      const payload = {
        opType: 'revolve',
        sketchId,
        ...(profileSelector !== undefined ? { profileSelector } : {}),
        angleDeg,
        ...(bound !== '' ? { expression: bound } : {}),
        ...(axisDatumId !== '' ? { axisDatumId } : {}),
        name: `Revolve ${id}`,
      }
      try {
        history.execute(createFeatureCommand(dag, { id, kind: 'feature', consumes: [sketchId, ...(axisDatumId === '' ? [] : [axisDatumId]), ...paramConsumes], payload }))
      } catch (err) {
        setApplyError(err instanceof Error ? err.message : String(err))
        return
      }
      onApplied(id)
    }
    onClose()
  }

  return (
    <DialogShell
      title={editing ? 'Edit revolve' : 'Revolve'}
      onApply={() => { void handleApply() }}
      onCancel={isPickingProfile ? cancelProfilePick : onClose}
      cancelLabel={isPickingProfile ? 'Stop picking' : 'Cancel'}
      applyDisabled={applyDisabled || isPickingProfile}
      floatingPalette
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <button
          type="button"
          className="op-pick-btn"
          data-testid="revolve-pick-profile"
          disabled={onStartProfilePick === undefined}
          aria-pressed={isPickingProfile}
          onClick={isPickingProfile ? cancelProfilePick : beginProfilePick}
        >
          {isPickingProfile ? 'Cancel profile pick' : 'Pick profile in viewport'}
          <span className="op-pick-count">
            {(sketches.find((option) => option.id === sketchId)?.label ?? sketchId) || 'none'}
            {profileSelector?.kind === 'region' ? ' - chosen region' : ''}
          </span>
        </button>
        {treeSelectionActive && (
          <div data-testid="revolve-tree-sketch-status" style={{ color: 'var(--text-accent)', fontSize: 'var(--font-size-sm)' }}>
            Sketch: {sketches.find((option) => option.id === sketchId)?.label ?? sketchId} (from the design tree) - whole sketch
          </div>
        )}
        {isPickingProfile && (
          <div data-testid="revolve-profile-pick-guidance" style={{ color: 'var(--text-accent)', fontSize: 'var(--font-size-sm)' }}>
            Click a closed sketch profile in the viewport. Hover previews the profile; Escape stops picking.
          </div>
        )}
        {profileSelector?.kind === 'region' && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <span data-testid="revolve-selected-profile-region" style={{ color: 'var(--text-accent)', fontSize: 'var(--font-size-sm)' }}>
              Chosen: one closed region
            </span>
            <button
              type="button"
              className="modal-btn"
              data-testid="revolve-use-whole-sketch"
              onClick={() => {
                setProfileSelector({ kind: 'whole-sketch' })
                setTreeSelectionActive(false)
              }}
            >
              Use whole sketch
            </button>
          </div>
        )}
        <details>
          <summary style={{ color: 'var(--text-muted)', cursor: 'pointer' }}>Choose profile by name fallback</summary>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
            <span style={{ width: 70, color: 'var(--text-muted)' }}>Profile</span>
            <select
              data-testid="revolve-profile-select"
              value={sketchId}
              onChange={(e) => {
                setSketchId(e.target.value)
                setProfileSelector({ kind: 'whole-sketch' })
                setTreeSelectionActive(false)
              }}
              style={{ flex: 1 }}
            >
              {!profileAvailable && sketchId !== '' && <option value={sketchId}>(unavailable: {sketchId})</option>}
              {sketches.map((opt) => (
                <option key={opt.id} value={opt.id}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>
        </details>
        {!profileAvailable && (
          <div data-testid="revolve-profile-error" style={{ color: 'var(--text-danger)', fontSize: 'var(--font-size-sm)' }}>
            Select an available upstream sketch profile.
          </div>
        )}
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 70, color: 'var(--text-muted)' }}>Axis</span>
          <select data-testid="revolve-axis" value={axisDatumId} onChange={(e) => setAxisDatumId(e.target.value)} style={{ flex: 1 }}>
            <option value="">World Z (through origin)</option>
            {axisDatumId !== '' && !axisOptions.some((option) => option.id === axisDatumId) && <option value={axisDatumId}>(unavailable: {axisDatumId})</option>}
            {axisOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
          </select>
        </label>

        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 70, color: 'var(--text-muted)' }}>Angle</span>
          <span data-testid="revolve-angle" style={{ flex: 1 }}>
            <NumericInput value={angleDeg} onChange={setAngleDeg} min={1} max={360} disabled={expression.trim() !== ''} style={{ width: '100%' }} />
          </span>
          <span style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}>deg</span>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 70, color: 'var(--text-muted)' }}>fx</span>
          <input
            data-testid="revolve-angle-expression"
            type="text"
            placeholder="optional driving expression, e.g. 180+extra"
            value={expression}
            onChange={(e) => setExpression(e.target.value)}
            style={{ flex: 1 }}
          />
        </label>
        {expressionError !== undefined && (
          <div data-testid="revolve-angle-expression-error" style={{ color: 'var(--text-danger)', fontSize: 'var(--font-size-sm)' }}>
            {expressionError}
          </div>
        )}
        {previewControlled && (
          <div
            data-testid="revolve-preview-status"
            data-status={previewState?.status ?? 'idle'}
            aria-live="polite"
            style={{
              color: previewState?.status === 'refused' ? 'var(--text-danger)' : 'var(--text-muted)',
              fontSize: 'var(--font-size-sm)',
            }}
          >
            {previewState?.status === 'refused'
              ? previewState.message
              : previewState?.status === 'pending'
                ? 'Updating preview...'
                : previewState?.status === 'ready'
                  ? 'Live preview ready'
                  : ''}
          </div>
        )}
        {applyError !== undefined && (
          <div data-testid="revolve-apply-error" style={{ color: 'var(--text-danger)', fontSize: 'var(--font-size-sm)' }}>
            {applyError}
          </div>
        )}
      </div>
    </DialogShell>
  )
}
