import type * as THREE from 'three'
import type { ViewMode } from '../../types'
import { PERSISTED_USER_DATA_REGISTRY } from '../../store/persistedKeys'

const STOCK_REMOVAL_BODY_KEY = PERSISTED_USER_DATA_REGISTRY.stockRemovalBody.key

export type StockRemovalBodyKind = 'adaptive-preview' | 'heightmap' | 'voxel'

/**
 * Tag the root of a user-facing carved-stock representation. Keeping the tag on
 * the scene object lets regression gates census the render graph itself instead
 * of duplicating CNCViewport's private field list.
 */
export function markStockRemovalBody(
  body: THREE.Object3D,
  kind: StockRemovalBodyKind,
): void {
  body.userData[STOCK_REMOVAL_BODY_KEY] = kind
}

function isEffectivelyVisible(body: THREE.Object3D): boolean {
  for (let current: THREE.Object3D | null = body; current; current = current.parent) {
    if (!current.visible) return false
  }
  return true
}

/** Return every visible carved-stock body by traversing the real scene graph. */
export function visibleStockRemovalBodies(scene: THREE.Object3D): THREE.Object3D[] {
  const bodies: THREE.Object3D[] = []
  scene.traverse((object) => {
    if (object.userData[STOCK_REMOVAL_BODY_KEY] && isEffectivelyVisible(object)) {
      bodies.push(object)
    }
  })
  return bodies
}

export function stockRemovalBodyKind(body: THREE.Object3D): StockRemovalBodyKind | null {
  const kind = body.userData[STOCK_REMOVAL_BODY_KEY]
  return kind === 'adaptive-preview' || kind === 'heightmap' || kind === 'voxel'
    ? kind
    : null
}

/** The adaptive z-dexel mesh is a Toolpath diagnostic, not a second sim body. */
export function shouldDisplayAdaptiveCarvedStock(mode: ViewMode): boolean {
  return mode === 'toolpath'
}
