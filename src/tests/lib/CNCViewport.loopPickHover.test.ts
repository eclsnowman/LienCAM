import * as THREE from 'three'
import { describe, expect, it, vi } from 'vitest'
import { CNCViewport } from '../../lib/viewport/CNCViewport'

vi.stubGlobal('window', {
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
})

interface LoopPickHarness {
  loopPickCallback: ((loopId: string, nowSelected: boolean) => void) | null
  loopPickAllowedGeoId: string | null
  loopPickHoverId: string | null
  pickedLoopIds: Set<string>
  handleLoopPickHoverMove: (event: MouseEvent) => void
  resolveLoopPickAtCurrentRay: () => string | null
  updateLoopPickHover: (event: MouseEvent) => void
}

function priv(vp: CNCViewport): LoopPickHarness {
  return vp as unknown as LoopPickHarness
}

function loopLine(id: string, halfSize = 5, originalColor = 0x2468ac): THREE.Line {
  const points = [
    new THREE.Vector3(-halfSize, -halfSize, 0),
    new THREE.Vector3(halfSize, -halfSize, 0),
    new THREE.Vector3(halfSize, halfSize, 0),
    new THREE.Vector3(-halfSize, halfSize, 0),
    new THREE.Vector3(-halfSize, -halfSize, 0),
  ]
  const material = new THREE.LineBasicMaterial({ color: originalColor })
  material.userData.origColor = originalColor
  const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), material)
  line.name = id
  return line
}

function makeHarness() {
  const vp = Object.create(CNCViewport.prototype) as CNCViewport
  const line = loopLine('loop-a')
  const group = new THREE.Group()
  group.name = '__wplane_geo-a'
  group.add(line)
  group.updateMatrixWorld(true)

  const addEventListener = vi.fn()
  const removeEventListener = vi.fn()
  const domElement = {
    style: { cursor: '' },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
    addEventListener,
    removeEventListener,
  }
  const camera = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 100)
  camera.position.set(0, 0, 10)
  camera.lookAt(0, 0, 0)
  camera.updateMatrixWorld(true)
  camera.updateProjectionMatrix()

  Object.assign(vp, {
    renderer: { domElement },
    camera,
    mouse: new THREE.Vector2(),
    raycaster: new THREE.Raycaster(),
    selectableObjects: [line],
    geometry2dGroups: new Map<string, THREE.Group>([['geo-a', group]]),
    projectedLoopGroups: new Map<string, THREE.Group>(),
    _worldPlaneLoopGroups: new Map<string, THREE.Group>(),
    _geoLocalLoopGroups: new Map<string, THREE.Group>(),
    nestGroups: new Map<string, THREE.Group>(),
    loopPickCallback: null,
    loopPickAllowedGeoId: null,
    loopPickHoverId: null,
    pickedLoopIds: new Set<string>(),
    selectionGlow: 'signature',
    viewportThemeId: 'classic',
    handleLoopPickHoverMove: vi.fn(),
  })

  return { vp, h: priv(vp), line, group, domElement, addEventListener, removeEventListener }
}

function moveEvent(x = 50, y = 50): MouseEvent {
  return { clientX: x, clientY: y } as MouseEvent
}

describe('HELP-QA-8 CNCViewport loop-pick hover', () => {
  it('uses the shared selectionGlow hover color and pointer, then restores the loop and crosshair on miss', () => {
    const { vp, h, line, domElement, addEventListener } = makeHarness()
    vp.setLoopPickMode(vi.fn(), 'geo-a')
    expect(addEventListener).toHaveBeenCalledWith('mousemove', h.handleLoopPickHoverMove)

    h.resolveLoopPickAtCurrentRay = vi.fn(() => 'loop-a')
    h.updateLoopPickHover(moveEvent())
    expect((line.material as THREE.LineBasicMaterial).color.getHex()).toBe(0xffbd5a)
    expect(domElement.style.cursor).toBe('pointer')

    h.resolveLoopPickAtCurrentRay = vi.fn(() => null)
    h.updateLoopPickHover(moveEvent(90, 90))
    expect((line.material as THREE.LineBasicMaterial).color.getHex()).toBe(0x2468ac)
    expect(domElement.style.cursor).toBe('crosshair')
  })

  it('keeps the existing amber selection tint when the selected loop is hovered', () => {
    const { vp, h, line, domElement } = makeHarness()
    vp.setLoopPickMode(vi.fn(), 'geo-a')
    vp.setPickedLoops(['loop-a'])
    h.resolveLoopPickAtCurrentRay = vi.fn(() => 'loop-a')

    h.updateLoopPickHover(moveEvent())

    expect((line.material as THREE.LineBasicMaterial).color.getHex()).toBe(0xffaa00)
    expect(domElement.style.cursor).toBe('pointer')
  })

  it('clears hover color, cursor, and listener when loop picking disarms', () => {
    const { vp, h, line, domElement, removeEventListener } = makeHarness()
    vp.setLoopPickMode(vi.fn(), 'geo-a')
    h.resolveLoopPickAtCurrentRay = vi.fn(() => 'loop-a')
    h.updateLoopPickHover(moveEvent())

    vp.setLoopPickMode(null)

    expect(h.loopPickHoverId).toBeNull()
    expect((line.material as THREE.LineBasicMaterial).color.getHex()).toBe(0x2468ac)
    expect(domElement.style.cursor).toBe('')
    expect(removeEventListener).toHaveBeenCalledWith('mousemove', h.handleLoopPickHoverMove)
  })

  it('uses one geo-gated resolver for direct outline targets', () => {
    const { h, line } = makeHarness()
    const raycaster = (h as unknown as { raycaster: THREE.Raycaster }).raycaster
    raycaster.intersectObjects = vi.fn(() => [{ object: line }]) as unknown as typeof raycaster.intersectObjects

    h.loopPickAllowedGeoId = 'geo-a'
    expect(h.resolveLoopPickAtCurrentRay()).toBe('loop-a')

    h.loopPickAllowedGeoId = 'geo-b'
    expect(h.resolveLoopPickAtCurrentRay()).toBeNull()
  })

  it('uses the same resolver interior fallback and picks the smallest pierced loop', () => {
    const { h, group } = makeHarness()
    const inner = loopLine('loop-inner', 2)
    group.add(inner)
    group.updateMatrixWorld(true)

    const privateFields = h as unknown as {
      raycaster: THREE.Raycaster
      selectableObjects: THREE.Object3D[]
    }
    privateFields.selectableObjects.push(inner)
    privateFields.raycaster.intersectObjects = vi.fn(() => []) as unknown as typeof privateFields.raycaster.intersectObjects
    privateFields.raycaster.ray.set(new THREE.Vector3(0, 0, 10), new THREE.Vector3(0, 0, -1))
    h.loopPickAllowedGeoId = 'geo-a'

    expect(h.resolveLoopPickAtCurrentRay()).toBe('loop-inner')
  })
})
