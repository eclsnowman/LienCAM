// WO UI-13A: loft dialog -- GEO-5's makeLoft wired into the 3D modeling workspace UI.
// Exactly two closed-sketch sections (the LoftRequest contract's own minimum,
// "sections<2 -> LOFT_FAILED"), picked in viewport order. The original name
// dropdowns remain a fallback.
//
// `spacing`: the workbench's parametric sketch profiles only ever place an
// 'xy'-plane profile at world z=0 -- there is no existing affordance for a
// SECOND profile plane at a different height,
// which a loft needs (its own sections must be genuinely apart, see
// geom-service.ts's LoftRequest). Rather than fork/extend the sketch tool,
// this dialog's own literal `spacing` field shifts the SECOND section's
// plane by that distance along world Z before handing both to makeLoft --
// the same "fixed literal parameter, no new UX invention" convention
// SweepDialog.tsx's path axis/length already established.
//
// BK-174: 'edit' mode reuses this SAME dialog (the ExtrudeDialog/RevolveDialog
// create-vs-edit pattern) instead of a bespoke editor -- FeatureTree Edit on a
// loft feature now reopens this dialog prefilled from the stored payload, and
// Apply rewrites the SAME node through EditFeaturePayloadCommand.

import { useEffect, useRef, useState } from 'react'
import { NumericInput } from '../../ui/NumericInput'
import type { CommandHistory, FeatureDag } from '../../../doc'
import { DialogShell } from './DialogShell'
import { createFeatureCommand } from './createFeatureCommand'
import { EditFeaturePayloadCommand } from './EditFeaturePayloadCommand'
import { nextId } from './nextId'
import type { StartProfilePick } from '../workbench/profileRegionPicker'
import type { ProfileSelector } from '../workbench/regionSelector'

export interface LoftFeaturePayload {
  opType: 'loft'
  sectionIds: string[]
  /** One selector per sectionIds entry (index-aligned). A missing entry (or
   *  missing array) means legacy first closed region for that section;
   *  explicit picks remain stable across region reorder. An entry can be
   *  `undefined` in-session but round-trips through JSON as `null` once the
   *  sibling slot is set and this one isn't (a sparse array) -- both mean
   *  "no selector recorded"; the loft executor in SolidsWorkbenchPage.tsx
   *  normalizes `null` to `undefined` before calling resolveProfileSelector(). */
  sectionProfileSelectors?: Array<ProfileSelector | undefined | null>
  /** distance the SECOND section is shifted along world Z before lofting --
   *  see this file's header. */
  spacing: number
  ruled: boolean
  name: string
}

export interface LoftDialogProps {
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

export function LoftDialog({ dag, history, sketchOptions, mode = 'create', featureId, treeSketchPick, onTreePickConsumed, onStartProfilePick, onApplied, onClose }: LoftDialogProps) {
  const editing = mode === 'edit'
  const existing = editing && featureId !== undefined ? (dag.getNode(featureId)?.payload as Record<string, unknown> | undefined) : undefined
  const existingSectionIds = existing?.sectionIds as string[] | undefined
  const sections = sketchOptions.filter((option) => !editing || isUpstreamProducer(dag, featureId, option.id))
  const [section1, setSection1] = useState<string>(existingSectionIds?.[0] ?? sections[0]?.id ?? '')
  const [section2, setSection2] = useState<string>(existingSectionIds?.[1] ?? sections[1]?.id ?? sections[0]?.id ?? '')
  const existingSectionProfileSelectors = existing?.sectionProfileSelectors as Array<ProfileSelector | undefined> | undefined
  const [section1Selector, setSection1Selector] = useState<ProfileSelector | undefined>(existingSectionProfileSelectors?.[0])
  const [section2Selector, setSection2Selector] = useState<ProfileSelector | undefined>(existingSectionProfileSelectors?.[1])
  const [treeSelectionActive, setTreeSelectionActive] = useState(false)
  const [isPickingProfiles, setIsPickingProfiles] = useState(false)
  const profilePickSessionRef = useRef<ProfilePickSession | undefined>(undefined)
  const handledTreeSketchPickNonceRef = useRef(0)
  const [spacing, setSpacing] = useState<number>((existing?.spacing as number | undefined) ?? 12)
  const [ruled, setRuled] = useState<boolean>((existing?.ruled as boolean | undefined) ?? true)
  const [applyError, setApplyError] = useState<string | undefined>(undefined)
  const treeSketchPickAvailable = treeSketchPick !== undefined && sections.some((option) => option.id === treeSketchPick.sketchId)

  useEffect(() => {
    if (treeSketchPick === undefined || treeSketchPick.nonce <= handledTreeSketchPickNonceRef.current) return
    handledTreeSketchPickNonceRef.current = treeSketchPick.nonce
    if (isPickingProfiles || !treeSketchPickAvailable) {
      console.info(`Tree pick ignored: ${isPickingProfiles ? 'profile pick session is active' : 'sketch is not available'}`)
      onTreePickConsumed?.(treeSketchPick.nonce)
      return
    }
    setSection1(treeSketchPick.sketchId)
    setSection1Selector({ kind: 'whole-sketch' })
    setTreeSelectionActive(true)
    onTreePickConsumed?.(treeSketchPick.nonce)
  }, [treeSketchPick, treeSketchPickAvailable, isPickingProfiles, onTreePickConsumed])

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
    setIsPickingProfiles(true)
    const stop = onStartProfilePick({
      allowedIds: sections.map((option) => option.id),
      prompt: 'Pick the first loft section, then the second section.',
      maxPicks: 2,
      onDone: ([first, second]) => {
        if (!session.active) return
        session.active = false
        if (first !== undefined && second !== undefined) {
          setSection1(first.sketchId)
          setSection2(second.sketchId)
          setSection1Selector(first.profileSelector)
          setSection2Selector(second.profileSelector)
          setTreeSelectionActive(false)
        }
        if (profilePickSessionRef.current === session) profilePickSessionRef.current = undefined
        setIsPickingProfiles(false)
      },
      onCancel: () => {
        if (!session.active) return
        session.active = false
        if (profilePickSessionRef.current === session) profilePickSessionRef.current = undefined
        setIsPickingProfiles(false)
      },
    })
    if (session.active && typeof stop === 'function') session.stop = stop
  }

  const cancelProfilePick = (): void => {
    const session = profilePickSessionRef.current
    profilePickSessionRef.current = undefined
    setIsPickingProfiles(false)
    if (session === undefined || !session.active) return
    session.active = false
    const stop = session.stop
    session.stop = undefined
    stop?.()
  }

  const section1Available = sections.some((option) => option.id === section1)
  const section2Available = sections.some((option) => option.id === section2)
  const invalid = !section1Available || !section2Available || section1 === section2 || spacing <= 0

  const handleApply = (): void => {
    if (invalid) return
    setApplyError(undefined)
    const sectionProfileSelectorsChanged = section1Selector !== undefined || section2Selector !== undefined
    if (editing && featureId !== undefined) {
      const priorPayload = dag.getNode(featureId)?.payload ?? {}
      const payload = {
        ...priorPayload,
        opType: 'loft',
        sectionIds: [section1, section2],
        ...(sectionProfileSelectorsChanged ? { sectionProfileSelectors: [section1Selector, section2Selector] } : {}),
        spacing,
        ruled,
      }
      try {
        history.execute(new EditFeaturePayloadCommand(featureId, payload, [section1, section2]))
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
      opType: 'loft',
      sectionIds: [section1, section2],
      ...(sectionProfileSelectorsChanged ? { sectionProfileSelectors: [section1Selector, section2Selector] } : {}),
      spacing,
      ruled,
      name: `Loft ${id}`,
    }
    try {
      history.execute(createFeatureCommand(dag, { id, kind: 'feature', consumes: [section1, section2], payload }))
    } catch (err) {
      setApplyError(err instanceof Error ? err.message : String(err))
      return
    }
    onApplied(id)
    onClose()
  }

  return (
    <DialogShell
      title={editing ? 'Edit loft' : 'Loft'}
      onApply={handleApply}
      onCancel={isPickingProfiles ? cancelProfilePick : onClose}
      cancelLabel={isPickingProfiles ? 'Stop picking' : 'Cancel'}
      applyDisabled={invalid || isPickingProfiles}
      floatingPalette
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <button
          type="button"
          className="op-pick-btn"
          data-testid="loft-pick-profiles"
          disabled={onStartProfilePick === undefined}
          aria-pressed={isPickingProfiles}
          onClick={isPickingProfiles ? cancelProfilePick : beginProfilePick}
        >
          {isPickingProfiles ? 'Cancel section picks' : 'Pick sections in viewport'}
          <span className="op-pick-count">2 ordered picks</span>
        </button>
        {treeSelectionActive && (
          <div data-testid="loft-tree-sketch-status" style={{ color: 'var(--text-accent)', fontSize: 'var(--font-size-sm)' }}>
            Sketch: {sections.find((option) => option.id === section1)?.label ?? section1} (from the design tree) - whole sketch
          </div>
        )}
        {isPickingProfiles && (
          <div data-testid="loft-profile-pick-guidance" style={{ color: 'var(--text-accent)', fontSize: 'var(--font-size-sm)' }}>
            Pick the first and second closed profiles in order, then use Done in the viewport. Escape stops picking and keeps this panel open.
          </div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}>
          <span data-testid="loft-section1-label">First: {(sections.find((option) => option.id === section1)?.label ?? section1) || 'none'}</span>
          <span data-testid="loft-section2-label">Second: {(sections.find((option) => option.id === section2)?.label ?? section2) || 'none'}</span>
        </div>
        <details>
          <summary style={{ color: 'var(--text-muted)', cursor: 'pointer' }}>Choose sections by name fallback</summary>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
            <span style={{ width: 90, color: 'var(--text-muted)' }}>Section 1</span>
            <select
              data-testid="loft-section1-select"
              value={section1}
              onChange={(e) => {
                setSection1(e.target.value)
                setSection1Selector({ kind: 'whole-sketch' })
                setTreeSelectionActive(false)
              }}
              style={{ flex: 1 }}
            >
              {!section1Available && section1 !== '' && <option value={section1}>(unavailable: {section1})</option>}
              {sections.map((opt) => (
                <option key={opt.id} value={opt.id}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
            <span style={{ width: 90, color: 'var(--text-muted)' }}>Section 2</span>
            <select
              data-testid="loft-section2-select"
              value={section2}
              onChange={(e) => {
                setSection2(e.target.value)
                setSection2Selector({ kind: 'whole-sketch' })
                setTreeSelectionActive(false)
              }}
              style={{ flex: 1 }}
            >
              {!section2Available && section2 !== '' && <option value={section2}>(unavailable: {section2})</option>}
              {sections.map((opt) => (
                <option key={opt.id} value={opt.id}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>
        </details>
        {(!section1Available || !section2Available) && (
          <div data-testid="loft-sections-error" style={{ color: 'var(--text-danger)', fontSize: 'var(--font-size-sm)' }}>
            Select two available upstream sketch sections.
          </div>
        )}
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 90, color: 'var(--text-muted)' }}>Spacing</span>
          <span data-testid="loft-spacing" style={{ flex: 1 }}>
            <NumericInput value={spacing} onChange={setSpacing} min={0.1} style={{ width: '100%' }} />
          </span>
          <span style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}>mm</span>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 90, color: 'var(--text-muted)' }}>Ruled</span>
          <input data-testid="loft-ruled-checkbox" type="checkbox" checked={ruled} onChange={(e) => setRuled(e.target.checked)} />
        </label>
        {section1 === section2 && section1 !== '' && (
          <div style={{ color: 'var(--text-danger)', fontSize: 'var(--font-size-sm)' }}>Sections must be different sketches.</div>
        )}
        {applyError !== undefined && (
          <div data-testid="loft-apply-error" style={{ color: 'var(--text-danger)', fontSize: 'var(--font-size-sm)' }}>
            {applyError}
          </div>
        )}
      </div>
    </DialogShell>
  )
}
