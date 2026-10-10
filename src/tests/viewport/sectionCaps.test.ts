import { describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import {
  applySectionCapPairVisibility,
  createSectionCapController,
} from '../../lib/viewport/sectionCaps'

function meshesWithRole(scene: THREE.Scene, role: string): THREE.Mesh[] {
  return scene.children.filter(
    (object): object is THREE.Mesh =>
      object instanceof THREE.Mesh && object.userData.sectionCapRole === role,
  )
}

function stencilHelpers(scene: THREE.Scene): THREE.Mesh[] {
  return [
    ...meshesWithRole(scene, 'stencil-back'),
    ...meshesWithRole(scene, 'stencil-front'),
  ]
}

describe('shared section-cap controller', () => {
  it('builds the proven stencil pass and positions the cap on the first plane', () => {
    const scene = new THREE.Scene()
    const geometry = new THREE.BoxGeometry(4, 5, 6)
    const bodyMaterial = new THREE.MeshStandardMaterial()
    const edgeMaterial = new THREE.LineBasicMaterial()
    const mesh = new THREE.Mesh(geometry, bodyMaterial)
    const controller = createSectionCapController(scene)
    controller.register(mesh, [bodyMaterial, edgeMaterial])

    const helpers = stencilHelpers(scene)
    expect(helpers).toHaveLength(2)
    const backMaterial = meshesWithRole(scene, 'stencil-back')[0].material as THREE.MeshBasicMaterial
    const frontMaterial = meshesWithRole(scene, 'stencil-front')[0].material as THREE.MeshBasicMaterial
    expect({
      side: backMaterial.side,
      colorWrite: backMaterial.colorWrite,
      depthWrite: backMaterial.depthWrite,
      depthTest: backMaterial.depthTest,
      stencilWrite: backMaterial.stencilWrite,
      stencilFunc: backMaterial.stencilFunc,
      stencilFail: backMaterial.stencilFail,
      stencilZFail: backMaterial.stencilZFail,
      stencilZPass: backMaterial.stencilZPass,
    }).toEqual({
      side: THREE.BackSide,
      colorWrite: false,
      depthWrite: false,
      depthTest: false,
      stencilWrite: true,
      stencilFunc: THREE.AlwaysStencilFunc,
      stencilFail: THREE.IncrementWrapStencilOp,
      stencilZFail: THREE.IncrementWrapStencilOp,
      stencilZPass: THREE.IncrementWrapStencilOp,
    })
    expect(frontMaterial.side).toBe(THREE.FrontSide)
    expect(frontMaterial.stencilZPass).toBe(THREE.DecrementWrapStencilOp)
    expect(helpers.every((helper) => helper.renderOrder === 1)).toBe(true)

    const primary = new THREE.Plane(new THREE.Vector3(1, 0, 0), -7)
    const secondary = new THREE.Plane(new THREE.Vector3(0, 1, 0), 2)
    controller.setPlanes([primary, secondary])

    expect(bodyMaterial.clippingPlanes).toEqual([primary, secondary])
    expect(edgeMaterial.clippingPlanes).toEqual([primary, secondary])
    expect(backMaterial.clippingPlanes).toEqual([primary, secondary])
    expect(frontMaterial.clippingPlanes).toEqual([primary, secondary])

    const cap = meshesWithRole(scene, 'fill')[0]
    const capMaterial = cap.material as THREE.MeshStandardMaterial
    expect(cap.renderOrder).toBe(2)
    expect(cap.position.x).toBeCloseTo(7)
    expect(cap.position.y).toBeCloseTo(0)
    expect(cap.position.z).toBeCloseTo(0)
    expect(new THREE.Vector3(0, 0, 1).applyQuaternion(cap.quaternion).x).toBeCloseTo(1)
    expect(capMaterial.side).toBe(THREE.DoubleSide)
    expect(capMaterial.stencilWrite).toBe(true)
    expect(capMaterial.stencilFunc).toBe(THREE.NotEqualStencilFunc)
    expect(capMaterial.stencilZPass).toBe(THREE.KeepStencilOp)

    controller.setPlanes([])
    expect(meshesWithRole(scene, 'fill')).toHaveLength(0)
    expect(bodyMaterial.clippingPlanes).toBeNull()
    expect(edgeMaterial.clippingPlanes).toBeNull()
  })

  it('keeps root-level helpers aligned with a transformed nested body at draw time', () => {
    const scene = new THREE.Scene()
    const parent = new THREE.Group()
    parent.position.set(10, -4, 3)
    parent.rotation.set(0.2, -0.35, 0.1)
    parent.scale.set(1.5, 0.75, 2)
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(2, 3, 4),
      new THREE.MeshStandardMaterial(),
    )
    mesh.position.set(1, 2, -3)
    mesh.rotation.set(-0.15, 0.25, 0.4)
    parent.add(mesh)
    scene.add(parent)

    const controller = createSectionCapController(scene)
    controller.register(mesh, [mesh.material as THREE.Material])
    const helpers = stencilHelpers(scene)
    expect(helpers).toHaveLength(2)
    expect(helpers.every((helper) => helper.parent === scene)).toBe(true)

    parent.position.set(-8, 5, 12)
    mesh.scale.set(0.5, 1.25, 0.8)
    scene.updateMatrixWorld(true)
    for (const helper of helpers) {
      ;(helper.onBeforeRender as () => void)()
      expect(helper.matrixWorld.equals(mesh.matrixWorld)).toBe(true)
      expect(helper.frustumCulled).toBe(false)
    }
  })

  it('suppresses topology-only contributors by default and supports a host override', () => {
    const geometry = new THREE.BoxGeometry(1, 1, 1)
    const material = new THREE.MeshStandardMaterial({ wireframe: true })
    const mesh = new THREE.Mesh(geometry, material)
    const pair = {
      back: new THREE.Object3D(),
      front: new THREE.Object3D(),
    }

    applySectionCapPairVisibility(mesh, pair, true)
    expect([pair.back.visible, pair.front.visible]).toEqual([false, false])

    applySectionCapPairVisibility(mesh, pair, true, { suppressWireframe: false })
    expect([pair.back.visible, pair.front.visible]).toEqual([true, true])

    material.wireframe = false
    material.transparent = true
    material.opacity = 0
    applySectionCapPairVisibility(mesh, pair, true)
    expect([pair.back.visible, pair.front.visible]).toEqual([false, false])

    applySectionCapPairVisibility(mesh, pair, true, { surfaceVisible: () => true })
    expect([pair.back.visible, pair.front.visible]).toEqual([true, true])
  })

  it('syncs replacement geometry and disposes only controller-owned resources', () => {
    const scene = new THREE.Scene()
    const baselinePlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -2)
    const bodyMaterial = new THREE.MeshStandardMaterial()
    bodyMaterial.clippingPlanes = [baselinePlane]
    const originalGeometry = new THREE.BoxGeometry(2, 2, 2)
    const originalGeometryDispose = vi.spyOn(originalGeometry, 'dispose')
    const mesh = new THREE.Mesh(originalGeometry, bodyMaterial)
    const controller = createSectionCapController(scene)
    controller.register(mesh, [bodyMaterial])

    const helpers = stencilHelpers(scene)
    const helperMaterialDisposals = helpers.map((helper) => (
      vi.spyOn(helper.material as THREE.Material, 'dispose')
    ))
    const replacementGeometry = new THREE.BoxGeometry(4, 3, 2)
    const replacementGeometryDispose = vi.spyOn(replacementGeometry, 'dispose')
    mesh.geometry = replacementGeometry
    controller.syncGeometry(mesh)
    expect(helpers.every((helper) => helper.geometry === replacementGeometry)).toBe(true)

    controller.setPlanes([new THREE.Plane(new THREE.Vector3(0, 1, 0), -3)])
    expect(() => controller.register(mesh, [bodyMaterial])).toThrow(/already registered/)
    controller.unregister(mesh)
    expect(stencilHelpers(scene)).toHaveLength(0)
    expect(helperMaterialDisposals.every((dispose) => dispose.mock.calls.length === 1)).toBe(true)
    expect(bodyMaterial.clippingPlanes).toEqual([baselinePlane])
    expect(originalGeometryDispose).not.toHaveBeenCalled()
    expect(replacementGeometryDispose).not.toHaveBeenCalled()

    controller.dispose()
    controller.dispose()
    expect(meshesWithRole(scene, 'fill')).toHaveLength(0)
    expect(() => controller.setPlanes([])).toThrow(/disposed/)
  })
})
