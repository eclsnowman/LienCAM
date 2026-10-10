// WO-2172 (workholding assemblies, slice 2): a vise's bodies are DRAWN where
// the one resolver puts them (lib/workholding/vise.ts viseDrawPoses), not at
// their geometry rows' own poses - so the jaw follows the opening, and the
// picture is the pose CAM and simulation read in slice 3. Viewport.tsx applies
// this after every scene (re)build and whenever the vise, its opening or the
// active setup changes. A body whose vise is not in the active setup is not
// drawn there; a body that leaves its vise goes back to its row's own pose.

import { useCamStore } from '../../store'
import type { Vec3 } from '../../types'
import { viseDrawPoses } from '../../lib/workholding/vise'
import { markedRowWorldPose } from '../../lib/workholding/resolveWorkholding'

/** The two viewport calls this needs (CNCViewport has both). */
export interface ViseDrawTarget {
  setPartTransform(id: string, position: Vec3, rotation: Vec3): void
  setSTLVisible(id: string, visible: boolean): void
}

const drawnState = new WeakMap<ViseDrawTarget, { placed: Set<string>; hidden: Set<string> }>()

export function applyViseDrawPoses(vp: ViseDrawTarget): void {
  const { project } = useCamStore.getState()
  const { poses, hidden } = viseDrawPoses(project, project.activeSetupId)
  const previous = drawnState.get(vp) ?? { placed: new Set<string>(), hidden: new Set<string>() }
  if (poses.size === 0 && hidden.size === 0 && previous.placed.size === 0 && previous.hidden.size === 0) return
  const rows = new Map(project.geometry.map((g) => [g.id, g]))
  for (const [id, pose] of poses) vp.setPartTransform(id, pose.position, pose.rotation)
  for (const id of previous.placed) {
    const row = rows.get(id)
    const own = row && !poses.has(id) ? markedRowWorldPose(row, project.modelItemPlacements ?? []) : null
    if (own) vp.setPartTransform(id, own.position, own.rotation)
  }
  for (const id of hidden) vp.setSTLVisible(id, false)
  for (const id of new Set([...previous.hidden, ...poses.keys()])) {
    const row = rows.get(id)
    if (row && !hidden.has(id)) vp.setSTLVisible(id, !row.hidden)
  }
  drawnState.set(vp, { placed: new Set(poses.keys()), hidden: new Set(hidden) })
}
