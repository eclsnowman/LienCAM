// WO UI-3 acceptance #3: the translate gizmo framework piece. A purely
// imperative Three.js child (renders null -- same "no DOM output" contract
// Lab3DView's canvas-owning effects follow) that attaches a TransformControls
// handle to `target` when non-null, streams live drag positions through
// onChange (the viewport-side live-preview seam), and fires onCommit exactly
// once per drag release with the FINAL position -- the caller executes an
// EditFeaturePayloadCommand (or any Command) through its own CommandHistory
// there, so undo/redo is the caller's existing machinery, not something this
// component reimplements.
//
// Two injection points, mirroring sceneRuntime.ts's own two ("SceneRuntime"
// jsdom-safety split): `createTransformControlsAdapter` keeps this component
// from ever constructing a real TransformControls in a render-smoke test
// (jsdom lacks pointer-capture APIs the real class touches at construction/
// pointerdown time).

import { useEffect, useRef } from 'react'
import type * as THREE from 'three'
import {
  createDefaultTransformControlsAdapter,
  type CreateTransformControlsAdapter,
  type TransformControlsAdapter,
} from './TransformControlsAdapter'

export interface Vec3Like {
  x: number
  y: number
  z: number
}

export interface TranslateGizmoProps {
  scene: THREE.Scene
  camera: THREE.Camera
  domElement: HTMLElement
  /** The object to attach the gizmo to; null/undefined detaches (gizmo hidden). */
  target: THREE.Object3D | null | undefined
  enabled?: boolean
  /** Live-preview seam: fires continuously while dragging, with the object's
   *  current (uncommitted) world position. */
  onChange?(position: Vec3Like): void
  /** Fires exactly once per drag, with the FINAL position, when the pointer
   *  releases -- this is the "commit through the command layer" seam. */
  onCommit?(position: Vec3Like): void
  /** Lets the caller disable e.g. OrbitControls while a drag is in flight
   *  (matches CNCViewport.ts's 'dragging-changed' -> controls.enabled=!isDragging
   *  precedent). */
  onDraggingChange?(dragging: boolean): void
  createTransformControlsAdapter?: CreateTransformControlsAdapter
  /** WO UI-14A (C5, UI-14.report.json defects[1] -- "every other gizmo-mount
   *  path in this codebase has the same latent gap"): sceneRuntime.ts
   *  renders strictly on-demand, so attaching/mounting a TransformControls
   *  helper does NOT itself fire a render -- see PushPullGizmo.tsx's
   *  identical prop for the full rationale. Called once after the
   *  mount-once effect's initial scene.add call, and once more on every
   *  target attach/detach. */
  requestRender?(): void
}

function positionOf(obj: THREE.Object3D): Vec3Like {
  return { x: obj.position.x, y: obj.position.y, z: obj.position.z }
}

export function TranslateGizmo({
  scene,
  camera,
  domElement,
  target,
  enabled = true,
  onChange,
  onCommit,
  onDraggingChange,
  createTransformControlsAdapter = createDefaultTransformControlsAdapter,
  requestRender,
}: TranslateGizmoProps) {
  const controlsRef = useRef<TransformControlsAdapter | null>(null)
  // Callback refs so the mount-once effect below never needs to rebind
  // three.js event listeners just because a caller passed a fresh inline
  // callback on re-render (same pattern Lab3DView uses for filterModeRef).
  const onChangeRef = useRef(onChange)
  const onCommitRef = useRef(onCommit)
  const onDraggingChangeRef = useRef(onDraggingChange)
  const requestRenderRef = useRef(requestRender)
  useEffect(() => {
    onChangeRef.current = onChange
    onCommitRef.current = onCommit
    onDraggingChangeRef.current = onDraggingChange
    requestRenderRef.current = requestRender
  })

  useEffect(() => {
    const controls = createTransformControlsAdapter(camera, domElement)
    controlsRef.current = controls
    controls.setSpace('world')
    controls.setMode('translate')
    scene.add(controls.getHelper())
    requestRenderRef.current?.()

    const handleChange = (): void => {
      if (controls.object) onChangeRef.current?.(positionOf(controls.object))
    }
    const handleDraggingChanged = (event: { value?: boolean }): void => {
      const dragging = event.value === true
      onDraggingChangeRef.current?.(dragging)
      if (!dragging && controls.object) onCommitRef.current?.(positionOf(controls.object))
    }
    controls.addEventListener('change', handleChange)
    controls.addEventListener('dragging-changed', handleDraggingChanged)

    return () => {
      controls.removeEventListener('change', handleChange)
      controls.removeEventListener('dragging-changed', handleDraggingChanged)
      controls.detach()
      scene.remove(controls.getHelper())
      controls.dispose()
      controlsRef.current = null
    }
    // Mount-once effect: scene/camera/domElement/createTransformControlsAdapter
    // are stable for the lifetime of a mounted viewport (same contract
    // Lab3DView's own bootstrap effect documents).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene, camera, domElement, createTransformControlsAdapter])

  useEffect(() => {
    const controls = controlsRef.current
    if (!controls) return
    if (target) controls.attach(target)
    else controls.detach()
    requestRenderRef.current?.()
  }, [target])

  useEffect(() => {
    const controls = controlsRef.current
    if (controls) controls.enabled = enabled
  }, [enabled])

  return null
}
