import * as THREE from 'three'
import type { WebGLProgramParametersWithUniforms } from 'three'
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js'
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js'

export const BODY_EDGE_NDC_DEPTH_BIAS = 2e-5

type FatLineGeometry = LineSegmentsGeometry & {
  setColors?: (colors: number[]) => void
  setPositions: (positions: number[]) => void
}

export type BodyEdgeOverlay = THREE.LineSegments

export interface BodyEdgeOverlayOptions {
  fat: boolean
  color: THREE.ColorRepresentation
  opacity?: number
  linewidthPx?: number
  vertexColors?: boolean
  resolution?: { width: number; height: number }
  renderOrder?: number
  depthBias?: boolean
  depthTest?: boolean
  depthWrite?: boolean
  toneMapped?: boolean
  /** Thin overlays may alias a cache-owned geometry or own a CAM-created one.
   * Fat overlays always own their copied LineSegmentsGeometry. */
  ownsGeometry?: boolean
  userData?: Record<string, unknown>
}

export interface BodyPresentationPair {
  mesh: THREE.Mesh
  edgeLines: BodyEdgeOverlay
}

const CLIP_ASSIGNMENT = 'gl_Position = clip;'

/** Keep visible modeled edges in front of their independently tessellated
 * faces without disabling depth testing (rear edges remain occluded). */
export function installDepthSafeBodyEdgeBias(
  material: LineMaterial,
  bias = BODY_EDGE_NDC_DEPTH_BIAS,
): void {
  material.depthTest = true
  material.depthWrite = false
  material.polygonOffset = false
  material.userData.bodyEdgeNdcDepthBias = bias
  material.userData.modelEdgeNdcDepthBias = bias
  material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms): void => {
    if (!shader.vertexShader.includes(CLIP_ASSIGNMENT)) {
      throw new Error('LineMaterial shader no longer exposes the body-edge clip assignment')
    }
    shader.vertexShader = shader.vertexShader.replace(
      CLIP_ASSIGNMENT,
      `${CLIP_ASSIGNMENT}\n\t\t\tgl_Position.z -= ${bias.toExponential()} * gl_Position.w;`,
    )
  }
  material.customProgramCacheKey = () => `body-edge-ndc-bias:${bias}`
}

/** Construct the one true-edge presentation used by CAM and Model. Classic
 * themes retain THREE.LineSegments; fat themes use screen-space quads. */
export function createBodyEdgeOverlay(
  edgeGeometry: THREE.BufferGeometry,
  options: BodyEdgeOverlayOptions,
): BodyEdgeOverlay {
  const opacity = options.opacity ?? 1
  let edgeLines: BodyEdgeOverlay
  if (!options.fat) {
    const material = new THREE.LineBasicMaterial({
      color: options.color,
      transparent: opacity < 1,
      opacity,
      vertexColors: options.vertexColors ?? false,
      toneMapped: options.toneMapped ?? true,
      depthTest: options.depthTest ?? true,
      depthWrite: options.depthWrite ?? true,
    })
    edgeLines = new THREE.LineSegments(edgeGeometry, material)
  } else {
    const position = edgeGeometry.getAttribute('position')
    if (position === undefined) {
      throw new Error('bodyPresentation: true-edge geometry has no position attribute')
    }
    const geometry = new LineSegmentsGeometry()
    geometry.setPositions(Array.from(position.array as ArrayLike<number>))
    const color = edgeGeometry.getAttribute('color')
    const useVertexColors = (options.vertexColors ?? false) && color !== undefined
    if (useVertexColors) geometry.setColors(Array.from(color.array as ArrayLike<number>))
    const material = new LineMaterial({
      color: useVertexColors ? 0xffffff : options.color,
      transparent: opacity < 1,
      opacity,
      vertexColors: useVertexColors,
      linewidth: options.linewidthPx ?? 1,
      worldUnits: false,
      toneMapped: options.toneMapped ?? true,
      depthTest: options.depthTest ?? true,
      depthWrite: options.depthWrite ?? true,
    })
    const resolution = options.resolution ?? { width: 1, height: 1 }
    material.resolution.set(resolution.width, resolution.height)
    if (options.depthBias ?? true) installDepthSafeBodyEdgeBias(material)
    // The bias installer establishes its shaded default. A topology-only
    // caller may intentionally disable depth testing after the shader hook is
    // installed, while retaining that hook for the next shaded-mode restore.
    material.depthTest = options.depthTest ?? true
    if (options.depthWrite !== undefined) material.depthWrite = options.depthWrite
    edgeLines = new LineSegments2(geometry, material) as unknown as BodyEdgeOverlay
  }
  if (options.renderOrder !== undefined) edgeLines.renderOrder = options.renderOrder
  if (options.userData !== undefined) Object.assign(edgeLines.userData, options.userData)
  edgeLines.userData.isBodyEdgeOverlay = true
  edgeLines.userData.ownsBodyEdgeGeometry = options.fat || (options.ownsGeometry ?? false)
  return edgeLines
}

export interface BodyEdgeOverlayStyle {
  color: THREE.ColorRepresentation
  opacity: number
  linewidthPx: number
  depthTest: boolean
  depthWrite: boolean
}

/** Apply a display-mode style without replacing the edge object or geometry.
 * This is the mechanical half of the shared policy; bodyVisualStyle owns the
 * actual colors and widths. */
export function applyBodyEdgeOverlayStyle(
  edgeLines: BodyEdgeOverlay,
  style: BodyEdgeOverlayStyle,
): void {
  const materials = Array.isArray(edgeLines.material) ? edgeLines.material : [edgeLines.material]
  for (const material of materials) {
    if (material instanceof THREE.LineBasicMaterial || material instanceof LineMaterial) {
      material.color.set(style.color)
      material.opacity = style.opacity
      material.transparent = style.opacity < 1
      material.depthTest = style.depthTest
      material.depthWrite = style.depthWrite
      if (material instanceof LineMaterial) material.linewidth = style.linewidthPx
      material.needsUpdate = true
    }
  }
}

/** Create the common render pair while leaving material and scene ownership
 * with the host workspace. */
export function createBodyPresentationPair(
  geometry: THREE.BufferGeometry,
  material: THREE.Material | THREE.Material[],
  edgeGeometry: THREE.BufferGeometry,
  edgeOptions: BodyEdgeOverlayOptions,
  userData?: Record<string, unknown>,
): BodyPresentationPair {
  const mesh = new THREE.Mesh(geometry, material)
  if (userData !== undefined) Object.assign(mesh.userData, userData)
  mesh.userData.isBodyPresentationMesh = true
  return { mesh, edgeLines: createBodyEdgeOverlay(edgeGeometry, edgeOptions) }
}

export function syncBodyEdgeOverlayGeometry(
  edgeLines: BodyEdgeOverlay,
  edgeGeometry: THREE.BufferGeometry,
): void {
  delete edgeLines.userData.bodyEdgeVisibilityKey
  const fatGeometry = edgeLines.geometry as unknown as FatLineGeometry
  if (typeof fatGeometry.setPositions === 'function') {
    const position = edgeGeometry.getAttribute('position')
    if (position === undefined) {
      throw new Error('bodyPresentation: true-edge geometry has no position attribute')
    }
    fatGeometry.setPositions(Array.from(position.array as ArrayLike<number>))
    return
  }
  edgeLines.geometry = edgeGeometry
}

/** Visibility repaint is frequent (hover and tool feedback). Only rebuild the
 * fat-line position buffers when the hidden-edge mask actually changes. */
export function syncBodyEdgeOverlayGeometryForVisibility(
  edgeLines: BodyEdgeOverlay,
  edgeGeometry: THREE.BufferGeometry,
  visibilityKey: string,
): void {
  if (edgeLines.userData.bodyEdgeVisibilityKey === visibilityKey) return
  syncBodyEdgeOverlayGeometry(edgeLines, edgeGeometry)
  edgeLines.userData.bodyEdgeVisibilityKey = visibilityKey
}

export function syncBodyEdgeOverlayColors(
  edgeLines: BodyEdgeOverlay,
  edgeGeometry: THREE.BufferGeometry,
): void {
  const fatGeometry = edgeLines.geometry as unknown as FatLineGeometry
  if (typeof fatGeometry.setColors !== 'function') return
  const color = edgeGeometry.getAttribute('color')
  if (color === undefined) return
  fatGeometry.setColors(Array.from(color.array as ArrayLike<number>))
}

export function setBodyPresentationVisible(
  presentation: BodyPresentationPair,
  visible: boolean,
): void {
  presentation.mesh.visible = visible
  presentation.edgeLines.visible = visible
}

export function disposeBodyEdgeOverlay(
  edgeLines: BodyEdgeOverlay,
  options: { disposeGeometry?: boolean; disposeMaterial?: boolean } = {},
): void {
  const ownsGeometry = edgeLines.userData.ownsBodyEdgeGeometry === true
  if (options.disposeGeometry ?? ownsGeometry) edgeLines.geometry.dispose()
  if (options.disposeMaterial ?? false) {
    const materials = Array.isArray(edgeLines.material) ? edgeLines.material : [edgeLines.material]
    for (const material of materials) material.dispose()
  }
  edgeLines.removeFromParent()
}

/** Dispose presentation-owned GPU resources. Geometry ownership is explicit
 * because Model's GeometryCache and CAM's import adapter have different
 * lifetimes. */
export function disposeBodyPresentation(
  presentation: BodyPresentationPair,
  options: {
    disposeMeshGeometry?: boolean
    disposeMeshMaterial?: boolean
    disposeEdgeGeometry?: boolean
    disposeEdgeMaterial?: boolean
  } = {},
): void {
  if (options.disposeMeshGeometry ?? false) presentation.mesh.geometry.dispose()
  if (options.disposeMeshMaterial ?? false) {
    const meshMaterials = Array.isArray(presentation.mesh.material)
      ? presentation.mesh.material
      : [presentation.mesh.material]
    for (const material of meshMaterials) material.dispose()
  }
  disposeBodyEdgeOverlay(presentation.edgeLines, {
    disposeGeometry: options.disposeEdgeGeometry,
    disposeMaterial: options.disposeEdgeMaterial,
  })
  presentation.mesh.removeFromParent()
}
