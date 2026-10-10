import * as THREE from 'three'
import { describe, expect, it, vi } from 'vitest'
import {
  CNCViewport,
  resolvePartMoveOrthoLock,
  type PartMoveLockAxis,
  type PartMovePlaneAxis,
} from '../../lib/viewport/CNCViewport'

describe('resolvePartMoveOrthoLock', () => {
  const start = { x: 10, y: 20, z: 30 }

  it('chooses and latches the dominant XY axis', () => {
    const first = resolvePartMoveOrthoLock(start, { x: 16, y: 22, z: 35 }, 'XY', null)
    expect(first).toEqual({
      position: { x: 16, y: 20, z: 30 },
      lockedAxis: 'x',
    })

    // The pointer later crosses the diagonal, but the gesture stays on X.
    const latched = resolvePartMoveOrthoLock(
      start,
      { x: 17, y: 40, z: 50 },
      'XY',
      first.lockedAxis,
    )
    expect(latched).toEqual({
      position: { x: 17, y: 20, z: 30 },
      lockedAxis: 'x',
    })
  })

  it.each([
    ['XZ', { x: 11, y: 80, z: 39 }, 'z', { x: 10, y: 20, z: 39 }],
    ['YZ', { x: 80, y: 28, z: 31 }, 'y', { x: 10, y: 28, z: 30 }],
    ['XYZ', { x: 12, y: 29, z: 99 }, 'y', { x: 10, y: 29, z: 30 }],
  ] as Array<[
    PartMovePlaneAxis,
    { x: number; y: number; z: number },
    PartMoveLockAxis,
    { x: number; y: number; z: number },
  ]>)('locks %s free movement to one world axis', (plane, current, axis, position) => {
    expect(resolvePartMoveOrthoLock(start, current, plane, null)).toEqual({
      position,
      lockedAxis: axis,
    })
  })

  it('waits for real motion before choosing an axis', () => {
    expect(resolvePartMoveOrthoLock(start, start, 'XY', null)).toEqual({
      position: start,
      lockedAxis: null,
    })
  })
})

type TransformStub = {
  axis: 'X' | 'Y' | 'Z' | 'XY' | 'XZ' | 'YZ' | 'XYZ' | null
  mode: 'translate' | 'rotate'
  object: THREE.Object3D | undefined
}

type ViewportUnderTest = {
  handleTransformControlsChange(): void
  handleTransformDraggingChanged(event: { value: boolean }): void
  transformControls: TransformStub
  controls: { enabled: boolean }
  selectedPartId: string | null
  stockGizmoSphere: THREE.Mesh | null
  stockGizmoId: string | null
  geometry2dGizmoProxy: THREE.Object3D | null
  geometry2dGizmoGroup: THREE.Group | null
  geometry2dGizmoLastWorld: THREE.Matrix4
  partMoveShiftHeld: boolean
  partMovePlaneDrag: unknown
  partGroups: Map<string, THREE.Group>
  geometry2dGroups: Map<string, THREE.Group>
  rebuildStock: ReturnType<typeof vi.fn>
  onPartTransformChange: ReturnType<typeof vi.fn>
}

function makeViewport(object: THREE.Object3D): ViewportUnderTest {
  const onPartTransformChange = vi.fn()
  const viewport = Object.create(CNCViewport.prototype) as ViewportUnderTest
  Object.assign(viewport, {
    transformControls: { axis: 'XY', mode: 'translate', object } satisfies TransformStub,
    controls: { enabled: true },
    selectedPartId: 'part',
    stockGizmoSphere: null,
    stockGizmoId: null,
    geometry2dGizmoProxy: null,
    geometry2dGizmoGroup: null,
    geometry2dGizmoLastWorld: new THREE.Matrix4(),
    partMoveShiftHeld: true,
    partMovePlaneDrag: null,
    partGroups: new Map<string, THREE.Group>(),
    geometry2dGroups: new Map<string, THREE.Group>(),
    rebuildStock: vi.fn(),
    onPartTransformChange,
  })
  return viewport
}

describe('CNCViewport Shift part move', () => {
  it('constrains a direct 3D part and persists the constrained transform', () => {
    const scene = new THREE.Scene()
    const part = new THREE.Group()
    part.position.set(4, 5, 6)
    scene.add(part)
    const viewport = makeViewport(part)
    viewport.partGroups.set('part', part)

    viewport.handleTransformDraggingChanged({ value: true })
    expect(viewport.controls.enabled).toBe(false)
    part.position.set(14, 8, 9)
    viewport.handleTransformControlsChange()

    expect(part.position.toArray()).toEqual([14, 5, 6])
    expect(viewport.rebuildStock).toHaveBeenCalledTimes(1)

    viewport.handleTransformDraggingChanged({ value: false })
    expect(viewport.controls.enabled).toBe(true)
    expect(viewport.onPartTransformChange).toHaveBeenCalledWith(
      'part',
      { x: 14, y: 5, z: 6 },
      { x: 0, y: 0, z: 0 },
    )
  })

  it('constrains the proxy before folding its delta into a 2D part', () => {
    const scene = new THREE.Scene()
    const group = new THREE.Group()
    const proxy = new THREE.Object3D()
    proxy.position.set(20, 10, 0)
    scene.add(group, proxy)
    proxy.updateMatrixWorld(true)

    const viewport = makeViewport(proxy)
    viewport.geometry2dGroups.set('part', group)
    viewport.geometry2dGizmoProxy = proxy
    viewport.geometry2dGizmoGroup = group
    viewport.geometry2dGizmoLastWorld.copy(proxy.matrixWorld)
    viewport.transformControls.axis = 'XYZ'

    viewport.handleTransformDraggingChanged({ value: true })
    proxy.position.set(28, 13, 4)
    viewport.handleTransformControlsChange()

    expect(proxy.position.toArray()).toEqual([28, 10, 0])
    expect(group.position.toArray()).toEqual([8, 0, 0])
    viewport.handleTransformDraggingChanged({ value: false })
    const [id, position, rotation] = viewport.onPartTransformChange.mock.lastCall!
    expect(id).toBe('part')
    expect(position).toEqual({ x: 8, y: 0, z: 0 })
    expect(rotation.x).toBeCloseTo(0)
    expect(rotation.y).toBeCloseTo(0)
    expect(rotation.z).toBeCloseTo(0)
  })

  it('does not alter axis-handle movement, rotation, or unmodified plane movement', () => {
    const scene = new THREE.Scene()
    const part = new THREE.Group()
    scene.add(part)
    const viewport = makeViewport(part)
    viewport.partGroups.set('part', part)

    viewport.transformControls.axis = 'X'
    viewport.handleTransformDraggingChanged({ value: true })
    part.position.set(7, 2, 3)
    viewport.handleTransformControlsChange()
    expect(part.position.toArray()).toEqual([7, 2, 3])

    viewport.handleTransformDraggingChanged({ value: false })
    viewport.transformControls.axis = 'XY'
    viewport.transformControls.mode = 'rotate'
    viewport.handleTransformDraggingChanged({ value: true })
    part.rotation.z = Math.PI / 4
    viewport.handleTransformControlsChange()
    expect(part.rotation.z).toBeCloseTo(Math.PI / 4)

    viewport.handleTransformDraggingChanged({ value: false })
    viewport.transformControls.mode = 'translate'
    viewport.partMoveShiftHeld = false
    viewport.handleTransformDraggingChanged({ value: true })
    part.position.set(11, 12, 13)
    viewport.handleTransformControlsChange()
    expect(part.position.toArray()).toEqual([11, 12, 13])
  })
})
