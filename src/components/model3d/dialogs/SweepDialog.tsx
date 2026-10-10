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
// BK-174: 'edit' mode reuses this SAME dialog (the ExtrudeDialog/RevolveDialog
// create-vs-edit pattern) instead of a bespoke editor -- FeatureTree Edit on a
// sweep feature now reopens this dialog prefilled from the stored payload,
// and Apply rewrites the SAME node through EditFeaturePayloadCommand.

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

export interface SweepFeaturePayload {
  opType: 'sweep'
  sketchId: string
  /** Missing means legacy first closed region; explicit picks remain stable across region reorder. */
  profileSelector?: ProfileSelector
  axis: PathAxis
  length: number
  orientation: 'frenet' | 'fixed'
  name: string
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

export function SweepDialog({ dag, history, sketchOptions, mode = 'create', featureId, treeSketchPick, onTreePickConsumed, onStartProfilePick, onApplied, onClose }: SweepDialogProps) {
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
  const [applyError, setApplyError] = useState<string | undefined>(undefined)
  const treeSketchPickAvailable = treeSketchPick !== undefined && sketches.some((option) => option.id === treeSketchPick.sketchId)

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
      prompt: 'Click a closed sketch region for the sweep profile.',
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
  const invalid = !profileAvailable || length <= 0

  const handleApply = (): void => {
    if (invalid) return
    setApplyError(undefined)
    if (editing && featureId !== undefined) {
      const priorPayload = dag.getNode(featureId)?.payload ?? {}
      const payload = {
        ...priorPayload,
        opType: 'sweep',
        sketchId,
        ...(profileSelector !== undefined ? { profileSelector } : {}),
        axis,
        length,
        orientation,
      }
      try {
        history.execute(new EditFeaturePayloadCommand(featureId, payload, [sketchId]))
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
      name: `Sweep ${id}`,
    }
    try {
      history.execute(createFeatureCommand(dag, { id, kind: 'feature', consumes: [sketchId], payload }))
    } catch (err) {
      setApplyError(err instanceof Error ? err.message : String(err))
      return
    }
    onApplied(id)
    onClose()
  }

  return (
    <DialogShell
      title={editing ? 'Edit sweep' : 'Sweep'}
      onApply={handleApply}
      onCancel={isPickingProfile ? cancelProfilePick : onClose}
      cancelLabel={isPickingProfile ? 'Stop picking' : 'Cancel'}
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
          {isPickingProfile ? 'Cancel profile pick' : 'Pick profile in viewport'}
          <span className="op-pick-count">{sketches.find((option) => option.id === sketchId)?.label ?? 'none'}</span>
        </button>
        {treeSelectionActive && (
          <div data-testid="sweep-tree-sketch-status" style={{ color: 'var(--text-accent)', fontSize: 'var(--font-size-sm)' }}>
            Sketch: {sketches.find((option) => option.id === sketchId)?.label ?? sketchId} (from the design tree) - whole sketch
          </div>
        )}
        {isPickingProfile && (
          <div data-testid="sweep-profile-pick-guidance" style={{ color: 'var(--text-accent)', fontSize: 'var(--font-size-sm)' }}>
            Click one closed sketch profile in the viewport. Escape stops picking and keeps this panel open.
          </div>
        )}
        <details>
          <summary style={{ color: 'var(--text-muted)', cursor: 'pointer' }}>Choose profile by name fallback</summary>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
            <span style={{ width: 70, color: 'var(--text-muted)' }}>Profile</span>
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
          <div data-testid="sweep-profile-error" style={{ color: 'var(--text-danger)', fontSize: 'var(--font-size-sm)' }}>
            Select an available upstream sketch profile.
          </div>
        )}
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 70, color: 'var(--text-muted)' }}>Path axis</span>
          <select data-testid="sweep-path-axis-select" value={axis} onChange={(e) => setAxis(e.target.value as PathAxis)} style={{ flex: 1 }}>
            <option value="x">World X</option>
            <option value="y">World Y</option>
            <option value="z">World Z</option>
          </select>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 70, color: 'var(--text-muted)' }}>Length</span>
          <span data-testid="sweep-length" style={{ flex: 1 }}>
            <NumericInput value={length} onChange={setLength} min={0.1} style={{ width: '100%' }} />
          </span>
          <span style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}>mm</span>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 70, color: 'var(--text-muted)' }}>Orientation</span>
          <select
            data-testid="sweep-orientation-select"
            value={orientation}
            onChange={(e) => setOrientation(e.target.value as 'frenet' | 'fixed')}
            style={{ flex: 1 }}
          >
            <option value="fixed">Fixed</option>
            <option value="frenet">Frenet</option>
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
