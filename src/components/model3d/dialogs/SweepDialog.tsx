// WO UI-13A: sweep dialog -- GEO-5's makeSweep (pipe) wired into the Part
// Studio UI. Profile is an existing closed sketch; viewport region picking is
// primary and the original name dropdown remains a fallback. This dialog owns
// no freehand path-sketch UI, and the sketch subsystem only ever emits a
// CLOSED ProfileRegion off a sketch node -- see sketch3d/regen.ts -- so there
// is no existing sketch shape that could serve as an OPEN PathChain either).
// The path is therefore a straight line along one world axis
// (dressUpGeometry.ts's buildAxisPathChain), the minimal "pick a path"
// affordance the GEO-5 sweep.test.ts fixtures themselves use (a straight
// spine) -- same "fixed axis, no new UX invention" convention
// RevolveDialog.tsx already established for its own axis field.
//
// WO-3230: the path is now chosen explicitly -- Axis (the straight world-axis
// spine above, unchanged) or Sketch path (one open line/arc chain of an
// upstream sketch, persisted as the WO-3228 selector in `path`). The axis and
// length fields stay in the payload as dormant values while a sketch path is
// chosen, so switching back restores them; a payload with no `path` is the
// original axis sweep byte for byte.
//
// BK-174: 'edit' mode reuses this SAME dialog (the ExtrudeDialog/RevolveDialog
// create-vs-edit pattern) instead of a bespoke editor -- FeatureTree Edit on a
// sweep feature now reopens this dialog prefilled from the stored payload,
// and Apply rewrites the SAME node through EditFeaturePayloadCommand.

import { useText } from '../../../i18n'
import { useEffect, useRef, useState } from 'react'
import { NumericInput } from '../../ui/NumericInput'
import type { CommandHistory, FeatureDag } from '../../../doc'
import { DialogShell } from './DialogShell'
import { createFeatureCommand } from './createFeatureCommand'
import { EditFeaturePayloadCommand } from './EditFeaturePayloadCommand'
import { nextId } from './nextId'
import type { PathAxis } from './dressUpGeometry'
import type { StartProfilePick } from '../workbench/profileRegionPicker'
import type { ProfileSelector } from '../workbench/regionSelector'
import type { PathChain } from '../../../geom/geom-service'
import {
  resolveSweepPathChain,
  reverseSweepPathSelector,
  sweepProducerIds,
  type SketchChainPathSelector,
  type SweepPathNodeLookup,
} from '../../../geom/sweep-path'
import { sweepPathCandidatesForSketch, sweepPathKey, sweepPathStart, type SweepPathCandidate } from '../workbench/sweepPathPicker'

export interface SweepFeaturePayload {
  opType: 'sweep'
  sketchId: string
  /** Missing means legacy first closed region; explicit picks remain stable across region reorder. */
  profileSelector?: ProfileSelector
  axis: PathAxis
  length: number
  orientation: 'frenet' | 'fixed'
  name: string
  /** WO-3230: present = sweep along this sketch chain (axis/length dormant); absent = the axis sweep. */
  path?: SketchChainPathSelector
}

export interface SweepDialogProps {
  dag: FeatureDag
  history: CommandHistory
  sketchOptions: Array<{ id: string; label: string }>
  /** defaults to 'create' -- existing create-only call sites need no change. */
  mode?: 'create' | 'edit'
  /** required in edit mode */
  featureId?: string
  treeSketchPick?: { sketchId: string; nonce: number }
  onTreePickConsumed?: (nonce: number) => void
  onStartProfilePick?: StartProfilePick
  /** WO-3230: the chosen path, resolved, for the viewport to draw (null = nothing to draw). */
  onPathPreview?(path: PathChain | null): void
  onApplied(featureId: string): void
  onClose(): void
}

const DEFAULT_LENGTH = 30

interface ProfilePickSession {
  active: boolean
  stop?: () => void
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

/** True when `sketchId` is built (transitively) from `featureId`'s own output: using it as that
 *  feature's path would make a loop. */
function isBuiltFrom(dag: FeatureDag, sketchId: string, featureId: string | undefined): boolean {
  if (featureId === undefined) return false
  const pending = [sketchId]
  const visited = new Set<string>()
  while (pending.length > 0) {
    const id = pending.pop()!
    if (id === featureId) return true
    if (visited.has(id)) continue
    visited.add(id)
    pending.push(...(dag.getNode(id)?.consumes ?? []))
  }
  return false
}

function formatMm(value: number): string {
  const rounded = Math.round(value * 1000) / 1000
  return String(Object.is(rounded, -0) ? 0 : rounded)
}

export function SweepDialog({ dag, history, sketchOptions, mode = 'create', featureId, treeSketchPick, onTreePickConsumed, onStartProfilePick, onPathPreview, onApplied, onClose }: SweepDialogProps) {
  const workbenchText = useText('sketch-and-model-workbench')
  const pathText = useText('sweep-path.wo3230')
  const editing = mode === 'edit'
  const existing = editing && featureId !== undefined ? (dag.getNode(featureId)?.payload as Record<string, unknown> | undefined) : undefined
  const sketches = sketchOptions.filter((option) => !editing || isUpstreamProducer(dag, featureId, option.id))
  const [sketchId, setSketchId] = useState<string>((existing?.sketchId as string | undefined) ?? sketches[0]?.id ?? '')
  const [profileSelector, setProfileSelector] = useState<ProfileSelector | undefined>(existing?.profileSelector as ProfileSelector | undefined)
  const [treeSelectionActive, setTreeSelectionActive] = useState(false)
  const [isPickingProfile, setIsPickingProfile] = useState(false)
  const profilePickSessionRef = useRef<ProfilePickSession | undefined>(undefined)
  const handledTreeSketchPickNonceRef = useRef(0)
  const [axis, setAxis] = useState<PathAxis>((existing?.axis as PathAxis | undefined) ?? 'z')
  const [length, setLength] = useState<number>((existing?.length as number | undefined) ?? DEFAULT_LENGTH)
  const [orientation, setOrientation] = useState<'frenet' | 'fixed'>((existing?.orientation as 'frenet' | 'fixed' | undefined) ?? 'fixed')
  const existingPath = existing?.path as SketchChainPathSelector | undefined
  const [pathMode, setPathMode] = useState<'axis' | 'sketch'>(existingPath !== undefined ? 'sketch' : 'axis')
  const [pathSelector, setPathSelector] = useState<SketchChainPathSelector | undefined>(existingPath)
  const orientationTouchedRef = useRef(existing !== undefined)
  const [applyError, setApplyError] = useState<string | undefined>(undefined)
  const treeSketchPickAvailable = treeSketchPick !== undefined && sketches.some((option) => option.id === treeSketchPick.sketchId)

  useEffect(() => {
    if (treeSketchPick === undefined || treeSketchPick.nonce <= handledTreeSketchPickNonceRef.current) return
    handledTreeSketchPickNonceRef.current = treeSketchPick.nonce
    if (isPickingProfile || !treeSketchPickAvailable) {
      console.info(workbenchText('SweepDialog.treePickIgnored', { value1: String(isPickingProfile ? workbenchText('SweepDialog.profilePickSessionIsActive') : workbenchText('SweepDialog.sketchIsNotAvailable')) }))
      onTreePickConsumed?.(treeSketchPick.nonce)
      return
    }
    setSketchId(treeSketchPick.sketchId)
    setProfileSelector({ kind: 'whole-sketch' })
    setTreeSelectionActive(true)
    onTreePickConsumed?.(treeSketchPick.nonce)
  }, [treeSketchPick, treeSketchPickAvailable, isPickingProfile, onTreePickConsumed])

  useEffect(() => () => {
    const session = profilePickSessionRef.current
    profilePickSessionRef.current = undefined
    if (session === undefined || !session.active) return
    session.active = false
    const stop = session.stop
    session.stop = undefined
    stop?.()
  }, [])

  const beginProfilePick = (): void => {
    if (onStartProfilePick === undefined) return
    const session: ProfilePickSession = { active: true }
    profilePickSessionRef.current = session
    setIsPickingProfile(true)
    const stop = onStartProfilePick({
      allowedIds: sketches.map((option) => option.id),
      prompt: workbenchText('SweepDialog.clickAClosedSketchRegionForTheSweepProfile'),
      maxPicks: 1,
      onDone: ([result]) => {
        if (!session.active) return
        session.active = false
        if (result !== undefined) {
          setSketchId(result.sketchId)
          setProfileSelector(result.profileSelector)
          setTreeSelectionActive(false)
        }
        if (profilePickSessionRef.current === session) profilePickSessionRef.current = undefined
        setIsPickingProfile(false)
      },
      onCancel: () => {
        if (!session.active) return
        session.active = false
        if (profilePickSessionRef.current === session) profilePickSessionRef.current = undefined
        setIsPickingProfile(false)
      },
    })
    if (session.active && typeof stop === 'function') session.stop = stop
  }

  const cancelProfilePick = (): void => {
    const session = profilePickSessionRef.current
    profilePickSessionRef.current = undefined
    setIsPickingProfile(false)
    if (session === undefined || !session.active) return
    session.active = false
    const stop = session.stop
    session.stop = undefined
    stop?.()
  }

  const profileAvailable = sketches.some((option) => option.id === sketchId)
  const lookup: SweepPathNodeLookup = (id) => dag.getNode(id)
  // Every open chain in any sketch that exists now, whichever was drawn first: the path sketch becomes
  // an input of the sweep, so regeneration builds it first.
  const pathGroups = sketchOptions.map((option) => ({ label: option.label, ...sweepPathCandidatesForSketch(option.id, lookup) }))
  const pathCandidates: SweepPathCandidate[] = pathGroups.flatMap((group) => group.candidates)
  const selectedPathKey = pathSelector === undefined ? '' : sweepPathKey(pathSelector)
  const pathSketchId = pathSelector?.sketchId ?? ''
  const pathSketchAvailable = pathSelector !== undefined && dag.getNode(pathSketchId) !== undefined && !dag.isRolledBack(pathSketchId)
  const pathMakesLoop = pathSketchAvailable && editing && isBuiltFrom(dag, pathSketchId, featureId)
  // The SAME resolver live and headless replay run: what is shown is what Apply builds.
  const pathResolution = pathSelector === undefined ? undefined : resolveSweepPathChain(pathSelector, lookup)
  const resolvedPath = pathMode === 'sketch' && pathSketchAvailable && !pathMakesLoop && pathResolution?.ok === true ? pathResolution.path : null
  const pathSketchLabel = sketchOptions.find((option) => option.id === pathSketchId)?.label ?? pathSketchId
  const featureLabel = String(existing?.name ?? featureId ?? '')
  const pathError = pathSelector === undefined || resolvedPath !== null ? undefined
    : pathMakesLoop ? pathText('pathCycle', { sketch: pathSketchLabel, feature: featureLabel })
      : pathText('savedPathUnresolved', {
        message: !pathSketchAvailable
          ? pathText('pathSketchMissing', { sketchId: pathSketchId })
          : pathResolution?.ok === false ? pathResolution.diagnostic.message : '',
      })
  const pathStart = resolvedPath === null ? null : sweepPathStart(resolvedPath)
  const invalid = !profileAvailable || (pathMode === 'axis' ? length <= 0 : resolvedPath === null)

  useEffect(() => {
    onPathPreview?.(resolvedPath)
  }, [onPathPreview, resolvedPath === null ? '' : JSON.stringify(resolvedPath)]) // eslint-disable-line react-hooks/exhaustive-deps -- keyed by the resolved geometry, not its object identity
  useEffect(() => () => onPathPreview?.(null), [onPathPreview])

  const choosePathMode = (next: 'axis' | 'sketch'): void => {
    setPathMode(next)
    // A curved path is followed only by 'frenet'; an untouched new sweep takes it (and gives it back on
    // returning to Axis), an edit never changes it silently.
    if (!orientationTouchedRef.current) setOrientation(next === 'sketch' ? 'frenet' : 'fixed')
  }
  const curveWords = (candidate: SweepPathCandidate): string => candidate.path.segments
    .map((segment) => segment.kind === 'line' ? pathText('curveLine', { id: segment.srcId }) : pathText('curveArc', { id: segment.srcId }))
    .join(' \u2192 ')
  const pathFields = pathMode === 'sketch' && pathSelector !== undefined ? { path: pathSelector } : {}
  const consumes = pathMode === 'sketch' && pathSelector !== undefined ? sweepProducerIds(sketchId, pathSelector) : [sketchId]

  const handleApply = (): void => {
    if (invalid) return
    setApplyError(undefined)
    if (editing && featureId !== undefined) {
      const priorPayload = { ...(dag.getNode(featureId)?.payload ?? {}) }
      delete priorPayload.path
      const payload = {
        ...priorPayload,
        opType: 'sweep',
        sketchId,
        ...(profileSelector !== undefined ? { profileSelector } : {}),
        axis,
        length,
        orientation,
        ...pathFields,
      }
      try {
        history.execute(new EditFeaturePayloadCommand(featureId, payload, consumes))
      } catch (err) {
        setApplyError(err instanceof Error ? err.message : String(err))
        return
      }
      onApplied(featureId)
      onClose()
      return
    }
    const id = nextId(dag, 'F')
    const payload = {
      opType: 'sweep',
      sketchId,
      ...(profileSelector !== undefined ? { profileSelector } : {}),
      axis,
      length,
      orientation,
      name: workbenchText('SweepDialog.sweep', { id: String(id) }),
      ...pathFields,
    }
    try {
      history.execute(createFeatureCommand(dag, { id, kind: 'feature', consumes, payload }))
    } catch (err) {
      setApplyError(err instanceof Error ? err.message : String(err))
      return
    }
    onApplied(id)
    onClose()
  }

  return (
    <DialogShell
      title={editing ? workbenchText('SweepDialog.editSweep') : workbenchText('SweepDialog.sweep2')}
      onApply={handleApply}
      onCancel={isPickingProfile ? cancelProfilePick : onClose}
      cancelLabel={isPickingProfile ? workbenchText('SweepDialog.stopPicking') : workbenchText('SweepDialog.cancel')}
      applyDisabled={invalid || isPickingProfile}
      floatingPalette
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <button
          type="button"
          className="op-pick-btn"
          data-testid="sweep-pick-profile"
          disabled={onStartProfilePick === undefined}
          aria-pressed={isPickingProfile}
          onClick={isPickingProfile ? cancelProfilePick : beginProfilePick}
        >
          {isPickingProfile ? workbenchText('SweepDialog.cancelProfilePick') : workbenchText('SweepDialog.pickProfileInViewport')}
          <span className="op-pick-count">{sketches.find((option) => option.id === sketchId)?.label ?? workbenchText('SweepDialog.none')}</span>
        </button>
        {treeSelectionActive && (
          <div data-testid="sweep-tree-sketch-status" style={{ color: 'var(--text-accent)', fontSize: 'var(--font-size-sm)' }}>
            {workbenchText('SweepDialog.sketch')}{sketches.find((option) => option.id === sketchId)?.label ?? sketchId}{workbenchText('SweepDialog.fromTheDesignTreeWholeSketch')}</div>
        )}
        {isPickingProfile && (
          <div data-testid="sweep-profile-pick-guidance" style={{ color: 'var(--text-accent)', fontSize: 'var(--font-size-sm)' }}>
            {workbenchText('SweepDialog.clickOneClosedSketchProfileInTheViewportEscape')}</div>
        )}
        <details>
          <summary style={{ color: 'var(--text-muted)', cursor: 'pointer' }}>{workbenchText('SweepDialog.chooseProfileByNameFallback')}</summary>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
            <span style={{ width: 70, color: 'var(--text-muted)' }}>{workbenchText('SweepDialog.profile')}</span>
            <select
              data-testid="sweep-profile-select"
              value={sketchId}
              onChange={(e) => {
                setSketchId(e.target.value)
                setProfileSelector({ kind: 'whole-sketch' })
                setTreeSelectionActive(false)
              }}
              style={{ flex: 1 }}
            >
              {!profileAvailable && sketchId !== '' && <option value={sketchId}>{workbenchText('SweepDialog.unavailable')}{sketchId}{workbenchText('SweepDialog.value')}</option>}
              {sketches.map((opt) => (
                <option key={opt.id} value={opt.id}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>
        </details>
        {!profileAvailable && (
          <div data-testid="sweep-profile-error" style={{ color: 'var(--text-danger)', fontSize: 'var(--font-size-sm)' }}>
            {workbenchText('SweepDialog.selectAnAvailableUpstreamSketchProfile')}</div>
        )}
        <div role="radiogroup" aria-label={pathText('pathSource')} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 70, color: 'var(--text-muted)' }}>{pathText('pathSource')}</span>
          <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <input type="radio" name="sweep-path-mode" data-testid="sweep-path-mode-axis" checked={pathMode === 'axis'} onChange={() => choosePathMode('axis')} />
            {pathText('modeAxis')}
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <input type="radio" name="sweep-path-mode" data-testid="sweep-path-mode-sketch" checked={pathMode === 'sketch'} onChange={() => choosePathMode('sketch')} />
            {pathText('modeSketch')}
          </label>
        </div>
        {pathMode === 'axis' && (<>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ width: 70, color: 'var(--text-muted)' }}>{workbenchText('SweepDialog.pathAxis')}</span>
            <select data-testid="sweep-path-axis-select" value={axis} onChange={(e) => setAxis(e.target.value as PathAxis)} style={{ flex: 1 }}>
              <option value="x">{workbenchText('SweepDialog.worldX')}</option>
              <option value="y">{workbenchText('SweepDialog.worldY')}</option>
              <option value="z">{workbenchText('SweepDialog.worldZ')}</option>
            </select>
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ width: 70, color: 'var(--text-muted)' }}>{workbenchText('SweepDialog.length')}</span>
            <span data-testid="sweep-length" style={{ flex: 1 }}>
              <NumericInput value={length} onChange={setLength} min={0.1} style={{ width: '100%' }} />
            </span>
            <span style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}>{workbenchText('SweepDialog.mm')}</span>
          </label>
        </>)}
        {pathMode === 'sketch' && (<>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ width: 70, color: 'var(--text-muted)' }}>{pathText('chain')}</span>
            <select
              data-testid="sweep-path-chain-select"
              value={selectedPathKey}
              onChange={(e) => {
                const picked = pathCandidates.find((candidate) => candidate.key === e.target.value)
                setPathSelector(picked?.selector)
              }}
              style={{ flex: 1, minWidth: 0 }}
            >
              {selectedPathKey === '' && <option value="">{pathText('choosePath')}</option>}
              {selectedPathKey !== '' && !pathCandidates.some((candidate) => candidate.key === selectedPathKey) && (
                <option value={selectedPathKey}>{pathSelector!.sketchId}: {pathSelector!.steps.map((step) => step.entityId).join(' \u2192 ')}</option>
              )}
              {pathGroups.flatMap((group) => group.candidates.map((candidate) => (
                <option key={candidate.key} value={candidate.key}>{pathText('chainOption', { sketch: group.label, curves: curveWords(candidate) })}</option>
              )))}
            </select>
            <button
              type="button"
              className="modal-btn modal-btn-ghost"
              data-testid="sweep-path-reverse"
              disabled={pathSelector === undefined}
              onClick={() => { if (pathSelector !== undefined) setPathSelector(reverseSweepPathSelector(pathSelector)) }}
            >
              {pathText('reverse')}
            </button>
          </label>
          {pathStart !== null && (
            <div data-testid="sweep-path-start" style={{ color: 'var(--text-accent)', fontSize: 'var(--font-size-sm)' }}>
              {pathText('startsAt', {
                x: formatMm(pathStart.point.x), y: formatMm(pathStart.point.y), z: formatMm(pathStart.point.z),
                dx: formatMm(pathStart.direction.x), dy: formatMm(pathStart.direction.y), dz: formatMm(pathStart.direction.z),
              })}
            </div>
          )}
          {pathError !== undefined && (
            <div data-testid="sweep-path-error" style={{ color: 'var(--text-danger)', fontSize: 'var(--font-size-sm)' }}>{pathError}</div>
          )}
          {pathCandidates.length === 0 && (
            <div data-testid="sweep-path-none" style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}>{pathText('noChains')}</div>
          )}
          {/* A closed loop is a profile, not a candidate path: only chains that are open but cannot be followed are named. */}
          {pathGroups.flatMap((group) => group.unavailable.filter((diagnostic) => diagnostic.code !== 'closed-path').map((diagnostic) => (
            <div key={`${group.sketchId}:${diagnostic.entityIds.join(',')}`} data-testid="sweep-path-not-listed" style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}>
              {diagnostic.code === 'ambiguous-branch'
                ? pathText('branched', { sketch: group.label, curves: diagnostic.entityIds.join(', ') })
                : pathText('notListed', { sketch: group.label, message: diagnostic.message })}
            </div>
          )))}
        </>)}
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 70, color: 'var(--text-muted)' }}>{workbenchText('SweepDialog.orientation')}</span>
          <select
            data-testid="sweep-orientation-select"
            value={orientation}
            onChange={(e) => { orientationTouchedRef.current = true; setOrientation(e.target.value as 'frenet' | 'fixed') }}
            style={{ flex: 1 }}
          >
            <option value="fixed">{workbenchText('SweepDialog.fixed')}</option>
            <option value="frenet">{pathText('followPath')}</option>
          </select>
        </label>
        {applyError !== undefined && (
          <div data-testid="sweep-apply-error" style={{ color: 'var(--text-danger)', fontSize: 'var(--font-size-sm)' }}>
            {applyError}
          </div>
        )}
      </div>
    </DialogShell>
  )
}
