import * as THREE from 'three'
import type { PlaneFrame } from '../../../sketch3d/planeMath'
import type { ReferenceImagePayload } from '../../../referenceImage/referenceImage'
import { makePlaneFrameGroup } from '../workbench/workbenchSketcherHost'

export function decodeReferenceImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('The image could not be decoded.'))
    image.src = dataUrl
  })
}

/** Keep the original in the document; cap only the GPU copy for large phone pictures. */
export function referenceImageTexture(image: HTMLImageElement): THREE.Texture {
  const scale = Math.min(1, 2048 / Math.max(image.naturalWidth, image.naturalHeight))
  let source: HTMLImageElement | HTMLCanvasElement = image
  if (scale < 1) {
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
    canvas.getContext('2d')!.drawImage(image, 0, 0, canvas.width, canvas.height)
    source = canvas
  }
  const texture = new THREE.Texture(source)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.needsUpdate = true
  return texture
}

export function buildReferenceImage(id: string, payload: ReferenceImagePayload, frame: PlaneFrame, image: HTMLImageElement): THREE.Group {
  const root = makePlaneFrameGroup(frame)
  root.name = `reference-image:${id}`
  root.userData.referenceImageId = id
  const material = new THREE.MeshBasicMaterial({
    map: referenceImageTexture(image), transparent: true, opacity: payload.opacity,
    side: THREE.DoubleSide, depthWrite: false,
    // Bring a coplanar underlay in front of its support face, without changing its world corners.
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
  })
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(payload.widthMm, payload.heightMm), material)
  quad.name = 'reference-image-quad'
  applyReferenceImagePose(quad, payload)
  quad.renderOrder = -1
  // Defense in depth: neither THREE raycasting nor the workbench's body-only PickEngine can pick it.
  quad.raycast = () => {}
  root.add(quad)
  return root
}

export function applyReferenceImagePose(quad: THREE.Object3D, payload: ReferenceImagePayload): void {
  quad.position.set(payload.center?.x ?? 0, payload.center?.y ?? 0, 0)
  quad.rotation.z = THREE.MathUtils.degToRad(payload.angleDeg ?? 0)
  const geometry = (quad as THREE.Mesh<THREE.PlaneGeometry>).geometry.parameters
  quad.scale.set((payload.flipHorizontal ? -1 : 1) * payload.widthMm / geometry.width,
    (payload.flipVertical ? -1 : 1) * payload.heightMm / geometry.height, 1)
}

export function disposeReferenceImage(root: THREE.Group): void {
  const quad = root.children[0] as THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>
  quad.geometry.dispose()
  quad.material.map?.dispose()
  quad.material.dispose()
}

/** Fit about the sketch origin in the current normal-to-plane view, preserving proportions. */
export function referenceImageSize(camera: THREE.Camera, frame: PlaneFrame, aspect: number): { widthMm: number; heightMm: number } {
  const origin = new THREE.Vector3(frame.origin.x, frame.origin.y, frame.origin.z)
  camera.updateMatrixWorld()
  const ortho = camera as THREE.OrthographicCamera
  const persp = camera as THREE.PerspectiveCamera
  const depth = Math.max(0.01, -origin.clone().applyMatrix4(camera.matrixWorldInverse).z)
  const height = ortho.isOrthographicCamera ? (ortho.top - ortho.bottom) / ortho.zoom : 2 * depth * Math.tan(THREE.MathUtils.degToRad(persp.fov ?? 45) / 2)
  const width = ortho.isOrthographicCamera ? (ortho.right - ortho.left) / ortho.zoom : height * (persp.aspect || 1)
  const heightMm = Math.min(height * 0.75, width * 0.75 / aspect)
  return { widthMm: heightMm * aspect, heightMm }
}
