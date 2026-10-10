// WO-2192 (workholding assemblies, slice 5): every placed CLAMP is drawn in
// the viewport where the one resolver puts it (lib/workholding/
// resolveWorkholding.ts resolveInstancePlacements) - the pose CAM keep-out and
// simulation contact read. One clamp definition is placed many times, so its
// shape row cannot be drawn by moving that row (vise.ts viseDrawPoses keeps
// it hidden): each placed clamp gets its own body in the scene under a draw id
// of its own (`wh-clamp:<instance>/<component>`), built from the same cached
// shape the row was drawn from (STL bytes, STEP display, Model display).
//
// Viewport.tsx calls applyClampDrawings after every scene (re)build and
// whenever the clamps, their setup or the active setup change. A clamp not in
// the active setup is not drawn there. Selecting a drawn clamp selects that
// clamp; dropping it after a drag slides it along its edge (Viewport.tsx).

import { useCamStore } from '../../store'
import type { ModelBodyDisplay, Vec3 } from '../../types'
import type { BrepModelPayload } from '../../lib/cam/geometry/occt/model/types'
import { isModelOriginGeometry } from '../../lib/cam/modelOrigin'
import { resolveInstancePlacements } from '../../lib/workholding/resolveWorkholding'
import { mat4ToPose } from '../../lib/workholding/pose'
import { rowDrawnInstanceIds } from '../../lib/workholding/reuse'
import { loadCachedSTL } from '../../lib/stlCache'
import { loadCachedStepDisplay } from '../../lib/stepCache'

export const CLAMP_DRAW_PREFIX = 'wh-clamp:'

export function clampDrawId(instanceId: string, componentId: string): string {
  return `${CLAMP_DRAW_PREFIX}${instanceId}/${componentId}`
}

/** The placed clamp a viewport body id draws, or null for any other body. */
export function clampInstanceOfDrawId(id: string | null | undefined): { instanceId: string; componentId: string } | null {
  if (!id?.startsWith(CLAMP_DRAW_PREFIX)) return null
  const rest = id.slice(CLAMP_DRAW_PREFIX.length)
  const slash = rest.lastIndexOf('/')
  return slash > 0 ? { instanceId: rest.slice(0, slash), componentId: rest.slice(slash + 1) } : null
}

/** The CNCViewport calls this needs. */
export interface ClampDrawTarget {
  addSTL(buffer: ArrayBuffer, id: string, name: string, position?: Vec3, rotation?: Vec3, color?: string): Promise<unknown>
  addBrepModel(id: string, payload: BrepModelPayload, name: string, position?: Vec3, rotation?: Vec3, color?: string): void
  addModelBody(id: string, display: ModelBodyDisplay, name: string, position?: Vec3, rotation?: Vec3, color?: string): void
  removeSTL(id: string): void
  setPartTransform(id: string, position: Vec3, rotation: Vec3): void
  setPartWorkholding(id: string, workholding: boolean, fallbackColor?: string): void
  /** Null when no body with this id is in the scene (a rebuilt scene dropped it). */
  partPointToScreen(id: string, p: Vec3): { x: number; y: number } | null
}

interface DrawnState { drawn: Set<string>; loading: Set<string> }
const drawnState = new WeakMap<ClampDrawTarget, DrawnState>()

/** Every clamp body the active setup shows, keyed by draw id. WO-2198: and
 *  every vise placed again from one definition - its first instance is drawn
 *  by the shape rows themselves (vise.ts viseDrawPoses), each other instance
 *  by a copy of its own here, selected and drawn the way a clamp is. */
export function clampDrawPoses(): Map<string, { geometryId: string; name: string; position: Vec3; rotation: Vec3 }> {
  const { project } = useCamStore.getState()
  const out = new Map<string, { geometryId: string; name: string; position: Vec3; rotation: Vec3 }>()
  if (!project.workholding?.instances.length) return out
  const rowDrawn = rowDrawnInstanceIds(project.workholding)
  if (project.workholding.instances.every((i) => rowDrawn.has(i.id))) return out
  for (const placement of resolveInstancePlacements(project, project.activeSetupId).placements) {
    if (rowDrawn.has(placement.instanceId)) continue
    const pose = mat4ToPose(placement.worldFromComponent)
    out.set(clampDrawId(placement.instanceId, placement.componentId), {
      geometryId: placement.geometryId, name: placement.name, position: pose.position, rotation: pose.rotation,
    })
  }
  return out
}

/** Put every placed clamp of the active setup in the scene at its pose; take away the rest. */
export async function applyClampDrawings(vp: ClampDrawTarget): Promise<void> {
  const state = drawnState.get(vp) ?? { drawn: new Set<string>(), loading: new Set<string>() }
  drawnState.set(vp, state)
  const wanted = clampDrawPoses()
  for (const id of [...state.drawn]) {
    if (wanted.has(id)) continue
    vp.removeSTL(id)
    state.drawn.delete(id)
  }
  const loads: Promise<void>[] = []
  for (const [id, want] of wanted) {
    if (vp.partPointToScreen(id, { x: 0, y: 0, z: 0 }) !== null) {
      vp.setPartTransform(id, want.position, want.rotation)
      state.drawn.add(id)
      continue
    }
    if (state.loading.has(id)) continue
    state.loading.add(id)
    loads.push(addClampBody(vp, id, want).finally(() => { state.loading.delete(id) }).then((added) => {
      if (!added) return
      state.drawn.add(id)
      // The clamp may have moved (or gone) while its shape was loading.
      const now = clampDrawPoses().get(id)
      if (now) vp.setPartTransform(id, now.position, now.rotation)
      else { vp.removeSTL(id); state.drawn.delete(id) }
    }))
  }
  await Promise.all(loads)
}

async function addClampBody(
  vp: ClampDrawTarget,
  id: string,
  want: { geometryId: string; name: string; position: Vec3; rotation: Vec3 },
): Promise<boolean> {
  const row = useCamStore.getState().project.geometry.find((g) => g.id === want.geometryId)
  if (!row) return false
  try {
    if (isModelOriginGeometry(row)) {
      const display = row.modelBody?.display
      if (!display) return false
      vp.addModelBody(id, display, want.name, want.position, want.rotation)
    } else if (row.format === 'stl') {
      const bytes = await loadCachedSTL(row.id)
      if (!bytes) return false
      await vp.addSTL(bytes, id, want.name, want.position, want.rotation)
    } else if (row.format === 'step') {
      const cached = await loadCachedStepDisplay(row.id)
      if (!cached?.payload) return false
      vp.addBrepModel(id, cached.payload, want.name, want.position, want.rotation)
    } else {
      return false
    }
  } catch (err) {
    console.error(`WO-2192: the clamp "${want.name}" could not be drawn:`, err)
    return false
  }
  vp.setPartWorkholding(id, true)
  return true
}
