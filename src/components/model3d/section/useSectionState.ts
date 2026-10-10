// WO UI-4 acceptance #3: section-view state, driven through the UI-H1
// sectionable runtime (sceneRuntime.ts's setClipPlanes/registerSectionable
// family). Ports Lab3DView's proven section-slider logic (axis-normal
// convention, per-axis range tracking so a flat wide part's Z slider
// reflects Z's own small extent, the min/max coincident-plane z-fight
// epsilon nudge) into a reusable hook instead of Lab3DView's inline effect,
// and adds the flip control Lab3DView never had (BK-noted gap: "no flip
// toggle today" -- see UI-4's recon). Flip needs no sceneRuntime.ts change:
// setClipPlanes takes a caller-constructed THREE.Plane, so flip is just
// negating the normal this hook builds before passing it in.

import { useCallback, useEffect, useState } from 'react'
import * as THREE from 'three'
import type { SceneRuntime } from '../sceneRuntime'

export const SECTION_AXES = ['x', 'y', 'z'] as const
export type SectionAxis = (typeof SECTION_AXES)[number]

/** Same convention Lab3DView established: the normal points the OPPOSITE
 *  way from the axis it's named after, so the slider clips away the "above
 *  the slider" side as it moves down. Flip negates this. */
const SECTION_AXIS_NORMALS: Record<SectionAxis, THREE.Vector3> = {
  x: new THREE.Vector3(-1, 0, 0),
  y: new THREE.Vector3(0, -1, 0),
  z: new THREE.Vector3(0, 0, -1),
}

export interface SectionRange {
  min: number
  max: number
}

export interface SectionState {
  axis: SectionAxis
  pos: number | null // null = auto (fully open at range.max)
  flip: boolean
  enabled: boolean
  dragEnabled: boolean
  range: SectionRange
}

export interface UseSectionStateArgs {
  runtime: SceneRuntime | null
}

export interface SectionController {
  state: SectionState
  setAxis(axis: SectionAxis): void
  setPos(pos: number): void
  setFlip(flip: boolean): void
  setEnabled(enabled: boolean): void
  setDragEnabled(enabled: boolean): void
  reset(): void
  /** Widen the tracked range for `axis` from a body's world-space bbox --
   *  call once per body per (re)paint, mirrors Lab3DView's
   *  expandSectionRangeFor. Sentinel-seeded (Infinity/-Infinity) so a
   *  placeholder can only ever widen, never narrow, the true extent. */
  expandRangeFor(geometry: THREE.BufferGeometry): void
}

const EMPTY_RANGES: Record<SectionAxis, SectionRange> = {
  x: { min: Infinity, max: -Infinity },
  y: { min: Infinity, max: -Infinity },
  z: { min: Infinity, max: -Infinity },
}

export function useSectionState({ runtime }: UseSectionStateArgs): SectionController {
  const [axis, setAxis] = useState<SectionAxis>('z')
  const [posByAxis, setPosByAxis] = useState<Record<SectionAxis, number | null>>({ x: null, y: null, z: null })
  const [flip, setFlip] = useState(false)
  const [enabled, setEnabledState] = useState(false)
  const [dragEnabled, setDragEnabledState] = useState(false)
  const [ranges, setRanges] = useState<Record<SectionAxis, SectionRange>>(EMPTY_RANGES)

  const expandRangeFor = useCallback((geometry: THREE.BufferGeometry): void => {
    geometry.computeBoundingBox()
    const bb = geometry.boundingBox
    if (bb === null) return
    if (![bb.min.x, bb.min.y, bb.min.z, bb.max.x, bb.max.y, bb.max.z].every(Number.isFinite)) return
    setRanges((prev) => ({
      x: { min: Math.min(prev.x.min, bb.min.x), max: Math.max(prev.x.max, bb.max.x) },
      y: { min: Math.min(prev.y.min, bb.min.y), max: Math.max(prev.y.max, bb.max.y) },
      z: { min: Math.min(prev.z.min, bb.min.z), max: Math.max(prev.z.max, bb.max.z) },
    }))
  }, [])

  const rawRange = ranges[axis]
  const range: SectionRange = Number.isFinite(rawRange.min) ? rawRange : { min: -50, max: 50 }
  const pos = posByAxis[axis]

  useEffect(() => {
    if (runtime === null) return
    if (!enabled) {
      runtime.setClipPlanes([])
      return
    }
    const rawPos = pos ?? range.max
    // Same z-fight-avoidance nudge Lab3DView proved out (WO UI-H1): never
    // let the plane sit EXACTLY coincident with the body's own flat extreme
    // face, which makes the GPU discard fragments of that face
    // inconsistently per-pixel.
    const span = range.max - range.min
    const epsilon = Math.max(span * 1e-4, 1e-4)
    const effectivePos = rawPos >= range.max ? rawPos + epsilon : rawPos <= range.min ? rawPos - epsilon : rawPos
    const normal = SECTION_AXIS_NORMALS[axis].clone()
    if (flip) normal.multiplyScalar(-1)
    const plane = new THREE.Plane(normal, effectivePos)
    runtime.setClipPlanes([plane])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtime, enabled, axis, pos, flip, range.min, range.max])

  const setAxisAndReset = useCallback((next: SectionAxis): void => {
    setAxis(next)
  }, [])

  const setPos = useCallback(
    (next: number): void => {
      setPosByAxis((prev) => ({ ...prev, [axis]: next }))
    },
    [axis],
  )

  const setEnabled = useCallback((next: boolean): void => {
    setEnabledState(next)
    if (!next) setDragEnabledState(false)
  }, [])

  const setDragEnabled = useCallback((next: boolean): void => {
    setDragEnabledState(next)
    if (next) setEnabledState(true)
  }, [])

  const reset = useCallback((): void => {
    setAxis('z')
    setPosByAxis({ x: null, y: null, z: null })
    setFlip(false)
    setDragEnabledState(false)
    setEnabledState(false)
  }, [])

  return {
    state: { axis, pos, flip, enabled, dragEnabled, range },
    setAxis: setAxisAndReset,
    setPos,
    setFlip,
    setEnabled,
    setDragEnabled,
    reset,
    expandRangeFor,
  }
}
