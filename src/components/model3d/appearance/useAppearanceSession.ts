// WO UI-4 acceptance #5 + Operator's Q-1 feedback-bar ruling: appearance picking
// gets the SAME hover-before-click / lock-on-select feedback as the measure
// tool -- reuses the shared GeomBridgeSession.selection (SelectionState) for
// face hover/select (same source the repaint loop already reads for
// highlight.ts), and a local body-hover/select pair for body-kind picks
// (BodyId has no StableId slot in SelectionState, same reasoning as
// useMeasureSession.ts).

import { useCallback, useMemo, useRef, useState } from 'react'
import type { GeomBridgeSession, RayLike, SelectionFilterMode } from '../../../viewport3d'
import type { StableId } from '../../../geom/geom-service'
import type { AppearanceStore, RGB } from './appearanceStore'

export type AppearanceTarget = { kind: 'face'; bodyId: string; id: StableId } | { kind: 'body'; bodyId: string }

export interface AppearanceSessionState {
  filterMode: Extract<SelectionFilterMode, 'face' | 'body'>
  hoveredBodyId: string | null
  target: AppearanceTarget | null
  currentColor: RGB | undefined
}

export interface UseAppearanceSessionArgs {
  session: GeomBridgeSession | null
  appearance: AppearanceStore
  liveBodyIds(): readonly string[]
  onChanged?(): void
  /** Mirrors whole-body appearance into the owning persisted geometry row.
   *  Face colors deliberately stay Model-only because ImportedGeometry has no
   *  face-level appearance contract. Undefined restores the inherited/default
   *  whole-body color. */
  onBodyColorChanged?(bodyId: string, color: RGB | undefined): void
}

export interface AppearanceSession {
  state: AppearanceSessionState
  setFilterMode(mode: Extract<SelectionFilterMode, 'face' | 'body'>): void
  handlePointerMove(ray: RayLike): void
  handlePointerClick(ray: RayLike): void
  applyColor(color: RGB): void
  clearColor(): void
}

export function useAppearanceSession({
  session,
  appearance,
  liveBodyIds,
  onChanged,
  onBodyColorChanged,
}: UseAppearanceSessionArgs): AppearanceSession {
  const [filterMode, setFilterMode] = useState<Extract<SelectionFilterMode, 'face' | 'body'>>('face')
  const [target, setTarget] = useState<AppearanceTarget | null>(null)
  const hoveredBodyIdRef = useRef<string | null>(null)
  const [renderTick, forceTick] = useState(0)

  const bump = useCallback(() => {
    forceTick((t) => t + 1)
    onChanged?.()
  }, [onChanged])

  const handlePointerMove = useCallback(
    (ray: RayLike): void => {
      if (session === null) return
      const hit = session.pick(liveBodyIds(), ray, filterMode)
      if (hit !== null && hit.kind === 'face') {
        hoveredBodyIdRef.current = null
        session.selection.setHover(hit.id)
      } else if (hit !== null && hit.kind === 'body') {
        hoveredBodyIdRef.current = hit.bodyId
        session.selection.setHover(null)
      } else {
        hoveredBodyIdRef.current = null
        session.selection.setHover(null)
      }
      bump()
    },
    [session, liveBodyIds, filterMode, bump],
  )

  const handlePointerClick = useCallback(
    (ray: RayLike): void => {
      if (session === null) return
      const hit = session.pick(liveBodyIds(), ray, filterMode)
      if (hit === null) {
        session.selection.clearSelection()
        setTarget(null)
        return
      }
      if (hit.kind === 'face') {
        session.selection.select(hit.id)
        setTarget({ kind: 'face', bodyId: hit.bodyId, id: hit.id })
      } else if (hit.kind === 'body') {
        session.selection.clearSelection()
        setTarget({ kind: 'body', bodyId: hit.bodyId })
      }
    },
    [session, liveBodyIds, filterMode],
  )

  const applyColor = useCallback(
    (color: RGB): void => {
      if (target === null) return
      if (target.kind === 'face') {
        appearance.setFaceColor(target.id, color)
        // Drop the shared SelectionState's 'selected' lock now that the
        // color itself marks this face -- applyFaceAppearance deliberately
        // skips repainting a hover/selected face (Q-1: pick feedback must
        // stay visible on top of a custom color), so leaving the pick
        // target "selected" forever would silently hide the very color the
        // user just chose.
        session?.selection.clearSelection()
      } else {
        appearance.setBodyColor(target.bodyId, color)
        onBodyColorChanged?.(target.bodyId, color)
      }
    },
    [target, appearance, session, onBodyColorChanged],
  )

  const clearColor = useCallback((): void => {
    if (target === null) return
    if (target.kind === 'face') appearance.clearFaceColor(target.id)
    else {
      appearance.clearBodyColor(target.bodyId)
      onBodyColorChanged?.(target.bodyId, undefined)
    }
  }, [target, appearance, onBodyColorChanged])

  const currentColor = target === null ? undefined : target.kind === 'face' ? appearance.faceColor(target.id) : appearance.bodyColor(target.bodyId)

  const state: AppearanceSessionState = useMemo(
    () => ({ filterMode, hoveredBodyId: hoveredBodyIdRef.current, target, currentColor }),
    // R1.3 rework (UI4.audit.json): renderTick MUST be a dep even though the
    // memo body never reads it -- hoveredBodyIdRef is a ref, so without a
    // tick forcing recomputation, a pointerMove-only hover (no
    // filterMode/target/currentColor change) left this memo's
    // hoveredBodyId frozen at whatever value it had at the last REAL dep
    // change, hiding every body-hover repaint downstream (repaint() reads
    // this field, never the ref directly).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filterMode, target, currentColor, renderTick],
  )

  return { state, setFilterMode, handlePointerMove, handlePointerClick, applyColor, clearColor }
}
