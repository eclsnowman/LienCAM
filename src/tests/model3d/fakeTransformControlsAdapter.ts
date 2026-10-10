// WO UI-3 render-smoke + drag-simulation seam: a plain object satisfying
// TransformControlsAdapter that never constructs a real three.js
// TransformControls (jsdom lacks the pointer-capture APIs it touches) --
// mirrors src/tests/model3d/fakeSceneRuntime.ts's own rationale/shape for
// SceneRuntime. simulateDrag/simulateDragStart/simulateDragEnd let a test
// drive the SAME event sequence the real class dispatches ('change' during
// drag, 'dragging-changed' at start/end) without any DOM pointer events.

import * as THREE from 'three'
import type {
  CreateTransformControlsAdapter,
  TransformControlsAdapter,
} from '../../components/model3d/gizmos/TransformControlsAdapter'

export interface FakeTransformControlsAdapter extends TransformControlsAdapter {
  attachCalls: THREE.Object3D[]
  detachCallCount: number
  disposeCallCount: number
  addedToSceneHelper: THREE.Object3D
  simulateDragStart(): void
  /** Moves the attached object's position and fires 'change' (live preview). */
  simulateDrag(position: { x: number; y: number; z: number }): void
  /** Fires 'dragging-changed' value:false (the commit point). */
  simulateDragEnd(): void
}

export function createFakeTransformControlsAdapter(): FakeTransformControlsAdapter {
  const listeners = new Map<string, Set<(event: { value?: boolean }) => void>>()
  const attachCalls: THREE.Object3D[] = []
  let detachCallCount = 0
  let disposeCallCount = 0
  let object: THREE.Object3D | undefined
  const helper = new THREE.Object3D()

  function on(type: string): Set<(event: { value?: boolean }) => void> {
    let set = listeners.get(type)
    if (!set) {
      set = new Set()
      listeners.set(type, set)
    }
    return set
  }
  function emit(type: string, event: { value?: boolean } = {}): void {
    for (const cb of on(type)) cb(event)
  }

  const adapter: FakeTransformControlsAdapter = {
    get object() {
      return object
    },
    enabled: true,
    attachCalls,
    addedToSceneHelper: helper,
    get detachCallCount() {
      return detachCallCount
    },
    get disposeCallCount() {
      return disposeCallCount
    },
    addEventListener: (type, listener) => {
      on(type).add(listener)
    },
    removeEventListener: (type, listener) => {
      on(type).delete(listener)
    },
    attach: (target) => {
      object = target
      attachCalls.push(target)
    },
    detach: () => {
      object = undefined
      detachCallCount++
    },
    setMode: () => {},
    setSpace: () => {},
    getHelper: () => helper,
    dispose: () => {
      disposeCallCount++
    },
    simulateDragStart: () => {
      emit('dragging-changed', { value: true })
    },
    simulateDrag: (position) => {
      if (object) object.position.set(position.x, position.y, position.z)
      emit('change')
    },
    simulateDragEnd: () => {
      emit('dragging-changed', { value: false })
    },
  }
  return adapter
}

export const fakeCreateTransformControlsAdapter: CreateTransformControlsAdapter = () =>
  createFakeTransformControlsAdapter()
