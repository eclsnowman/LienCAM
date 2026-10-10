// WO UI-4: measure tool state -- ports Lab3DView's proven hover/select/
// measure wiring (applyHoverPick/applySelectPick/runMeasure) into a reusable
// hook driving measureLogic.ts instead of Lab3DView's inline kind-specific
// branches, and adding a second pick mode ('between') for distance/angle.
//
// Reuses the SAME GeomBridgeSession.selection (SelectionState) Lab3DView and
// this WO's appearance/visibility repaint share -- face/edge hover+select
// already has one pub-sub source of truth; this hook does not invent a
// second one. Body/vertex picks have no StableId (types.ts) so their hover/
// select state lives in local refs here, exactly like Lab3DView's
// hoveredBodyIdRef/selectedVertexRef -- exposed on the returned state so a
// caller's repaint function (see the demo harness) can read them the same
// way Lab3DView's repaintHighlights() does.

import { useCallback, useMemo, useRef, useState } from 'react'
import type { CachedBody } from '../../../viewport3d'
import type { BridgeVertexRef, PickHit, PickThresholds, RayLike, SelectionFilterMode } from '../../../viewport3d'
import type { GeomBridgeSession } from '../../../viewport3d'
import type { StableId } from '../../../geom/geom-service'
import type { GeometrySnapshot } from '../../../geom'
import {
  isFailure,
  measureAngle,
  measureDistance,
  measureSingle,
  type MeasureOutcome,
  type PickWithBody,
} from './measureLogic'

export type MeasureMode = 'single' | 'between'

export interface SnapshotSource {
  snapshotsFor(bodyId: string, body: CachedBody): Promise<Readonly<Record<StableId, GeometrySnapshot>>>
}

export interface UseMeasureSessionArgs {
  session: GeomBridgeSession | null
  snapshotSource: SnapshotSource
  liveBodyIds(): readonly string[]
  filterMode: SelectionFilterMode
  pickThresholds?(ray: RayLike, filter: SelectionFilterMode): PickThresholds | undefined
  onChanged?(): void
}

export interface MeasureSessionState {
  mode: MeasureMode
  busy: boolean
  outcomes: MeasureOutcome[]
  armedCount: number
  hoveredBodyId: string | null
  selectedBodyIds: ReadonlySet<string>
  hoveredVertex: { bodyId: string; ref: BridgeVertexRef } | null
  selectedVertex: { bodyId: string; ref: BridgeVertexRef } | null
}

export interface MeasureSession {
  state: MeasureSessionState
  setMode(mode: MeasureMode): void
  handlePointerMove(ray: RayLike): void
  handlePointerClick(ray: RayLike): void
  clear(): void
}

function sameVertexRef(a: BridgeVertexRef, b: BridgeVertexRef): boolean {
  return a.adjacentEdgeIds.length === b.adjacentEdgeIds.length && a.adjacentEdgeIds.every((id, i) => id === b.adjacentEdgeIds[i])
}

export function useMeasureSession({
  session,
  snapshotSource,
  liveBodyIds,
  filterMode,
  pickThresholds,
  onChanged,
}: UseMeasureSessionArgs): MeasureSession {
  const [mode, setModeState] = useState<MeasureMode>('single')
  const [outcomes, setOutcomes] = useState<MeasureOutcome[]>([])
  const [busy, setBusy] = useState(false)
  const [renderTick, setRenderTick] = useState(0)

  const hoveredBodyIdRef = useRef<string | null>(null)
  const selectedBodyIdsRef = useRef<Set<string>>(new Set())
  const hoveredVertexRef = useRef<{ bodyId: string; ref: BridgeVertexRef } | null>(null)
  const selectedVertexRef = useRef<{ bodyId: string; ref: BridgeVertexRef } | null>(null)
  const armedRef = useRef<PickWithBody[]>([])
  const tokenRef = useRef(0)
  // Keyed by `${bodyId}@${body.version}`, not bodyId alone -- CachedBody.version
  // is bumped on every ingest of that bodyId, including a same-id regenerate
  // (GeometryCache.ingest() doc comment), so a stale pre-edit snapshot can
  // never be served under a regenerated body's new version (R1.5 rework:
  // UI4.audit.json finding -- angle/radius readouts kept using cached
  // pre-edit face normals/axes/centroids forever under DEMO_BODY_ID).
  const snapshotCacheRef = useRef<Map<string, Readonly<Record<StableId, GeometrySnapshot>>>>(new Map())

  const bump = useCallback(() => {
    setRenderTick((t) => t + 1)
    onChanged?.()
  }, [onChanged])

  const snapshotsForBody = useCallback(
    async (bodyId: string, body: CachedBody): Promise<Readonly<Record<StableId, GeometrySnapshot>>> => {
      const cacheKey = `${bodyId}@${body.version}`
      const cached = snapshotCacheRef.current.get(cacheKey)
      if (cached !== undefined) return cached
      const snaps = await snapshotSource.snapshotsFor(bodyId, body)
      snapshotCacheRef.current.set(cacheKey, snaps)
      return snaps
    },
    [snapshotSource],
  )

  const clearArmed = useCallback((): void => {
    session?.selection.clearSelection()
    armedRef.current = []
    selectedBodyIdsRef.current = new Set()
    selectedVertexRef.current = null
  }, [session])

  const clear = useCallback((): void => {
    session?.selection.clearSelection()
    hoveredBodyIdRef.current = null
    selectedBodyIdsRef.current = new Set()
    hoveredVertexRef.current = null
    selectedVertexRef.current = null
    armedRef.current = []
    setOutcomes([])
    bump()
  }, [session, bump])

  const setMode = useCallback(
    (next: MeasureMode): void => {
      clearArmed()
      setOutcomes([])
      setModeState(next)
      bump()
    },
    [clearArmed, bump],
  )

  const runSinglePick = useCallback(
    async (hit: PickHit, bodyId: string, body: CachedBody): Promise<void> => {
      if (session === null) return
      const token = ++tokenRef.current
      setBusy(true)
      try {
        const snaps = await snapshotsForBody(bodyId, body)
        if (hit.kind === 'face' || hit.kind === 'edge') session.selection.select(hit.id)
        const readouts = await measureSingle(
          (bId, kind, ids) => session.measure(bId, kind, ids),
          body,
          bodyId,
          hit,
          snaps,
        )
        if (tokenRef.current !== token) return
        setOutcomes(readouts)
      } catch (err) {
        if (tokenRef.current !== token) return
        setOutcomes([{ error: err instanceof Error ? err.message : String(err) }])
      } finally {
        if (tokenRef.current === token) setBusy(false)
      }
    },
    [session, snapshotsForBody],
  )

  const runBetweenPick = useCallback(
    async (hit: PickHit, bodyId: string, body: CachedBody): Promise<void> => {
      if (session === null) return
      if (hit.kind === 'face' || hit.kind === 'edge') session.selection.addToSelection(hit.id)
      const snaps = await snapshotsForBody(bodyId, body)
      const entry: PickWithBody = { bodyId, body, hit, snapshots: snaps }
      armedRef.current = [...armedRef.current, entry].slice(-2)
      bump()
      if (armedRef.current.length < 2) return

      const [a, b] = armedRef.current
      const token = ++tokenRef.current
      setBusy(true)
      try {
        const distance = measureDistance(a, b)
        const angle = measureAngle(a, b)
        if (tokenRef.current !== token) return
        const result: MeasureOutcome[] = [distance]
        if (!isFailure(angle)) result.push(angle)
        setOutcomes(result)
      } finally {
        if (tokenRef.current === token) setBusy(false)
      }
    },
    [session, snapshotsForBody, bump],
  )

  const resolvePick = useCallback(
    (ray: RayLike): { hit: PickHit; bodyId: string; body: CachedBody } | null => {
      if (session === null) return null
      const hit = session.pick(liveBodyIds(), ray, filterMode, pickThresholds?.(ray, filterMode))
      if (hit === null) return null
      const body = session.cache.get(hit.bodyId)
      if (body === undefined) return null
      return { hit, bodyId: hit.bodyId, body }
    },
    [session, liveBodyIds, filterMode, pickThresholds],
  )

  const handlePointerMove = useCallback(
    (ray: RayLike): void => {
      if (session === null) return
      const resolved = resolvePick(ray)
      const hit = resolved?.hit ?? null
      hoveredBodyIdRef.current = hit !== null && hit.kind === 'body' ? hit.bodyId : null
      if (hit === null) {
        hoveredVertexRef.current = null
        session.selection.setHover(null)
      } else if (hit.kind === 'face' || hit.kind === 'edge') {
        hoveredVertexRef.current = null
        session.selection.setHover(hit.id)
      } else if (hit.kind === 'vertex') {
        session.selection.setHover(null)
        hoveredVertexRef.current = { bodyId: hit.bodyId, ref: hit.id }
      } else {
        hoveredVertexRef.current = null
        session.selection.setHover(null)
      }
      bump()
    },
    [resolvePick, session, bump],
  )

  const handlePointerClick = useCallback(
    (ray: RayLike): void => {
      if (session === null) return
      const resolved = resolvePick(ray)
      if (resolved === null) return
      const { hit, bodyId, body } = resolved

      if (mode === 'single') {
        if (hit.kind === 'body') {
          selectedBodyIdsRef.current = new Set([bodyId])
          selectedVertexRef.current = null
          bump()
          void runSinglePick(hit, bodyId, body)
          return
        }
        if (hit.kind === 'vertex') {
          const current = selectedVertexRef.current
          const isSame = current !== null && current.bodyId === bodyId && sameVertexRef(current.ref, hit.id)
          selectedVertexRef.current = isSame ? null : { bodyId, ref: hit.id }
          selectedBodyIdsRef.current = new Set()
          bump()
          if (isSame) {
            setOutcomes([])
          } else {
            void runSinglePick(hit, bodyId, body)
          }
          return
        }
        selectedBodyIdsRef.current = new Set()
        selectedVertexRef.current = null
        void runSinglePick(hit, bodyId, body)
        return
      }

      // 'between' mode: only face/edge picks compose into distance/angle
      // today (measureLogic's PickWithBody path) -- body/vertex between-mode
      // picks are accepted for distance (pointsForHit covers every kind) but
      // never drive an angle.
      void runBetweenPick(hit, bodyId, body)
    },
    [mode, resolvePick, runSinglePick, runBetweenPick, bump],
  )

  const state: MeasureSessionState = useMemo(
    () => ({
      mode,
      busy,
      outcomes,
      armedCount: armedRef.current.length,
      hoveredBodyId: hoveredBodyIdRef.current,
      selectedBodyIds: selectedBodyIdsRef.current,
      hoveredVertex: hoveredVertexRef.current,
      selectedVertex: selectedVertexRef.current,
    }),
    // renderTick intentionally forces this memo to recompute even though the
    // refs it reads aren't themselves reactive state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mode, busy, outcomes, renderTick],
  )

  return { state, setMode, handlePointerMove, handlePointerClick, clear }
}
