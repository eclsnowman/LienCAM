import * as THREE from 'three'

const DEFAULT_CAP_SIZE = 10_000
const DEFAULT_CAP_COLOR = 0xd08a3e

export type SectionCapSurfacePredicate = (mesh: THREE.Mesh) => boolean

export interface SectionCapStencilPair {
  back: THREE.Mesh
  front: THREE.Mesh
}

export interface SectionCapVisibilityOptions {
  /**
   * Hosts with a topology-only display mode can override the default material
   * inspection without changing the controller or its public lifecycle.
   */
  surfaceVisible?: SectionCapSurfacePredicate
  suppressWireframe?: boolean
}

export interface SectionCapControllerOptions extends SectionCapVisibilityOptions {
  capColor?: THREE.ColorRepresentation
  capSize?: number
}

export interface SectionCapController {
  setPlanes(planes: readonly THREE.Plane[]): void
  register(mesh: THREE.Mesh, clippingMaterials: readonly THREE.Material[]): void
  syncGeometry(mesh: THREE.Mesh): void
  setVisible(mesh: THREE.Mesh, visible: boolean): void
  unregister(mesh: THREE.Mesh): void
  dispose(): void
}

interface MaterialRegistration {
  baselineClippingPlanes: THREE.Plane[] | null
  count: number
}

interface SectionCapRegistration {
  clippingMaterials: THREE.Material[]
  pair: SectionCapStencilPair
}

function isWireframeMaterial(material: THREE.Material): boolean {
  return 'wireframe' in material
    && (material as THREE.Material & { wireframe?: boolean }).wireframe === true
}

export function sectionCapHasVisibleSurface(
  mesh: THREE.Mesh,
  suppressWireframe = true,
): boolean {
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
  return materials.some((material) => (
    material.visible
    && !(material.transparent && material.opacity <= 0)
    && !(suppressWireframe && isWireframeMaterial(material))
  ))
}

/**
 * Keep stencil contributors in lockstep with the body's effective surface.
 * A topology-only body remains scene-visible for picking and bounds, but must
 * not leave a filled amber section behind.
 */
export function applySectionCapPairVisibility(
  mesh: THREE.Mesh,
  pair: { back: THREE.Object3D; front: THREE.Object3D },
  visible: boolean,
  options: SectionCapVisibilityOptions = {},
): void {
  const hasVisibleSurface = options.surfaceVisible?.(mesh)
    ?? sectionCapHasVisibleSurface(mesh, options.suppressWireframe ?? true)
  const helpersVisible = visible && hasVisibleSurface
  pair.back.visible = helpersVisible
  pair.front.visible = helpersVisible
}

/**
 * Stencil helpers live at the scene root so recursive body picking and body
 * traversal never see them. Copying the host's world matrix immediately
 * before each helper draw keeps translated, rotated, scaled, and nested bodies
 * aligned without requiring hosts to mirror transform mutations manually.
 */
export function syncSectionCapHelperWorldMatrix(
  host: THREE.Mesh,
  helper: THREE.Object3D,
): void {
  host.updateWorldMatrix(true, false)
  helper.matrixWorld.copy(host.matrixWorld)
}

function createStencilHelper(
  host: THREE.Mesh,
  side: THREE.Side,
  op: THREE.StencilOp,
  clippingPlanes: THREE.Plane[] | null,
): THREE.Mesh {
  const material = new THREE.MeshBasicMaterial()
  material.side = side
  material.colorWrite = false
  material.depthWrite = false
  material.depthTest = false
  material.stencilWrite = true
  material.stencilFunc = THREE.AlwaysStencilFunc
  material.stencilFail = op
  material.stencilZFail = op
  material.stencilZPass = op
  material.clippingPlanes = clippingPlanes

  const helper = new THREE.Mesh(host.geometry, material)
  helper.name = side === THREE.BackSide
    ? 'section-cap-stencil-back'
    : 'section-cap-stencil-front'
  helper.userData.sectionCapRole = side === THREE.BackSide ? 'stencil-back' : 'stencil-front'
  helper.renderOrder = 1
  helper.frustumCulled = false
  helper.matrixAutoUpdate = false
  helper.matrixWorldAutoUpdate = false
  helper.raycast = () => {}
  helper.onBeforeRender = () => {
    syncSectionCapHelperWorldMatrix(host, helper)
  }
  syncSectionCapHelperWorldMatrix(host, helper)
  return helper
}

/**
 * Shared GPU stencil-cap registry for closed, correctly-wound body meshes.
 * The first active clipping plane owns the cap quad; all active planes clip
 * registered body/edge and stencil materials.
 */
export function createSectionCapController(
  scene: THREE.Scene,
  options: SectionCapControllerOptions = {},
): SectionCapController {
  const registrations = new Map<THREE.Mesh, SectionCapRegistration>()
  const materialRegistrations = new Map<THREE.Material, MaterialRegistration>()
  const visibilityOptions: SectionCapVisibilityOptions = {
    surfaceVisible: options.surfaceVisible,
    suppressWireframe: options.suppressWireframe ?? true,
  }
  let clippingPlanes: THREE.Plane[] | null = null
  let capMesh: THREE.Mesh | null = null
  let disposed = false

  const requireActive = (): void => {
    if (disposed) throw new Error('section-cap controller is disposed')
  }

  const disposeCapMesh = (): void => {
    if (capMesh === null) return
    scene.remove(capMesh)
    capMesh.geometry.dispose()
    const materials = Array.isArray(capMesh.material) ? capMesh.material : [capMesh.material]
    for (const material of materials) material.dispose()
    capMesh = null
  }

  const rebuildCapMesh = (plane: THREE.Plane | null): void => {
    disposeCapMesh()
    if (plane === null) return
    if (
      !Number.isFinite(plane.normal.x)
      || !Number.isFinite(plane.normal.y)
      || !Number.isFinite(plane.normal.z)
      || plane.normal.lengthSq() <= 1e-12
    ) {
      throw new Error('section-cap plane requires a finite, nonzero normal')
    }

    const geometry = new THREE.PlaneGeometry(
      options.capSize ?? DEFAULT_CAP_SIZE,
      options.capSize ?? DEFAULT_CAP_SIZE,
    )
    const material = new THREE.MeshStandardMaterial({
      color: options.capColor ?? DEFAULT_CAP_COLOR,
      metalness: 0.05,
      roughness: 0.9,
      side: THREE.DoubleSide,
      stencilWrite: true,
      stencilRef: 0,
      stencilFunc: THREE.NotEqualStencilFunc,
      stencilFail: THREE.KeepStencilOp,
      stencilZFail: THREE.KeepStencilOp,
      stencilZPass: THREE.KeepStencilOp,
    })
    const mesh = new THREE.Mesh(geometry, material)
    mesh.name = 'section-cap-fill'
    mesh.userData.sectionCapRole = 'fill'
    mesh.renderOrder = 2
    mesh.frustumCulled = false
    mesh.raycast = () => {}
    mesh.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 0, 1),
      plane.normal.clone().normalize(),
    )
    mesh.position.copy(plane.coplanarPoint(new THREE.Vector3()))
    scene.add(mesh)
    capMesh = mesh
  }

  const retainMaterial = (material: THREE.Material): void => {
    const current = materialRegistrations.get(material)
    if (current !== undefined) {
      current.count += 1
      material.clippingPlanes = clippingPlanes
      return
    }
    materialRegistrations.set(material, {
      baselineClippingPlanes: material.clippingPlanes ?? null,
      count: 1,
    })
    material.clippingPlanes = clippingPlanes
  }

  const releaseMaterial = (material: THREE.Material): void => {
    const current = materialRegistrations.get(material)
    if (current === undefined) return
    current.count -= 1
    if (current.count > 0) return
    material.clippingPlanes = current.baselineClippingPlanes
    materialRegistrations.delete(material)
  }

  const unregister = (mesh: THREE.Mesh): void => {
    const registration = registrations.get(mesh)
    if (registration === undefined) return
    registrations.delete(mesh)
    scene.remove(registration.pair.back, registration.pair.front)
    registration.pair.back.onBeforeRender = () => {}
    registration.pair.front.onBeforeRender = () => {}
    const helperMaterials = [
      registration.pair.back.material,
      registration.pair.front.material,
    ].flatMap((material) => Array.isArray(material) ? material : [material])
    for (const material of helperMaterials) material.dispose()
    for (const material of registration.clippingMaterials) releaseMaterial(material)
  }

  return {
    setPlanes: (planes) => {
      requireActive()
      clippingPlanes = planes.length > 0 ? [...planes] : null
      for (const material of materialRegistrations.keys()) {
        material.clippingPlanes = clippingPlanes
      }
      for (const { pair } of registrations.values()) {
        const backMaterials = Array.isArray(pair.back.material)
          ? pair.back.material
          : [pair.back.material]
        const frontMaterials = Array.isArray(pair.front.material)
          ? pair.front.material
          : [pair.front.material]
        for (const material of [...backMaterials, ...frontMaterials]) {
          material.clippingPlanes = clippingPlanes
        }
      }
      rebuildCapMesh(planes[0] ?? null)
    },
    register: (mesh, materials) => {
      requireActive()
      if (registrations.has(mesh)) {
        throw new Error('section-cap mesh is already registered')
      }
      const clippingMaterialsForMesh = [...new Set(materials)]
      for (const material of clippingMaterialsForMesh) retainMaterial(material)

      const pair = {
        back: createStencilHelper(
          mesh,
          THREE.BackSide,
          THREE.IncrementWrapStencilOp,
          clippingPlanes,
        ),
        front: createStencilHelper(
          mesh,
          THREE.FrontSide,
          THREE.DecrementWrapStencilOp,
          clippingPlanes,
        ),
      }
      applySectionCapPairVisibility(mesh, pair, mesh.visible, visibilityOptions)
      scene.add(pair.back, pair.front)
      registrations.set(mesh, { clippingMaterials: clippingMaterialsForMesh, pair })
    },
    syncGeometry: (mesh) => {
      requireActive()
      const registration = registrations.get(mesh)
      if (registration === undefined) return
      registration.pair.back.geometry = mesh.geometry
      registration.pair.front.geometry = mesh.geometry
      syncSectionCapHelperWorldMatrix(mesh, registration.pair.back)
      syncSectionCapHelperWorldMatrix(mesh, registration.pair.front)
    },
    setVisible: (mesh, visible) => {
      requireActive()
      const registration = registrations.get(mesh)
      if (registration === undefined) return
      applySectionCapPairVisibility(mesh, registration.pair, visible, visibilityOptions)
    },
    unregister: (mesh) => {
      requireActive()
      unregister(mesh)
    },
    dispose: () => {
      if (disposed) return
      for (const mesh of [...registrations.keys()]) unregister(mesh)
      disposeCapMesh()
      disposed = true
    },
  }
}
