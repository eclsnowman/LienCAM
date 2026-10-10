import * as THREE from 'three'
import { buildEdgeLineGeometry } from './tessGeometry'
import { createBodyEdgeOverlay, type BodyEdgeOverlay } from './bodyPresentation'
import type { CachedBody } from './GeometryCache'
import type { SelectionState } from './SelectionState'
import {
  SELECTION_ORANGE_HOVER,
  SELECTION_ORANGE_SELECTED,
} from '../lib/viewport/lighting/selectionGlowTokens'

export type InteractionVariant = 'hovered' | 'selected'
export type InteractionDisplayMode = 'shaded-edges' | 'shaded-no-edges' | 'unshaded' | 'translucent'

export const INTERACTION_ORANGE = SELECTION_ORANGE_SELECTED
export const INTERACTION_HOVER_ORANGE = SELECTION_ORANGE_HOVER
export const INTERACTION_EDGE_WIDTH_PX = 4
export const INTERACTION_SELECTED_EDGE_WIDTH_PX = 5
export const INTERACTION_BODY_OUTLINE_WIDTH_PX = 4
export const INTERACTION_SELECTED_FILL_OPACITY = 0.82

/** One selected-body presentation contract for every 3D workspace. */
export const SELECTED_BODY_VISUAL_CONTRACT = Object.freeze({
  // Fill is applied to the actual MeshStandardMaterial, preserving studio
  // lighting without a coplanar transparent duplicate.
  fillOpacity: 1,
  // Selection uses a centered stroke over true topology, never an expanded
  // duplicate shell.
  outlineWidthPx: 5,
  outlineKind: 'topology' as const,
})

export const INTERACTION_SELECTED_BODY_OUTLINE_WIDTH_PX =
  SELECTED_BODY_VISUAL_CONTRACT.outlineWidthPx

export interface SelectedBodyMaterialState {
  color: THREE.Color
  vertexColors: boolean
  opacity: number
  transparent: boolean
}

export function applySelectedBodyMaterialTint(
  material: THREE.MeshStandardMaterial,
  color: THREE.ColorRepresentation,
): SelectedBodyMaterialState {
  const state: SelectedBodyMaterialState = {
    color: material.color.clone(),
    vertexColors: material.vertexColors,
    opacity: material.opacity,
    transparent: material.transparent,
  }
  updateSelectedBodyMaterialTint(material, color)
  return state
}

export function updateSelectedBodyMaterialTint(
  material: THREE.MeshStandardMaterial,
  color: THREE.ColorRepresentation,
): void {
  material.color.set(color)
  material.vertexColors = false
  material.opacity = SELECTED_BODY_VISUAL_CONTRACT.fillOpacity
  material.transparent = SELECTED_BODY_VISUAL_CONTRACT.fillOpacity < 1
  material.needsUpdate = true
}

export function restoreSelectedBodyMaterialTint(
  material: THREE.MeshStandardMaterial,
  state: SelectedBodyMaterialState,
): void {
  material.color.copy(state.color)
  material.vertexColors = state.vertexColors
  material.opacity = state.opacity
  material.transparent = state.transparent
  material.needsUpdate = true
}

export interface InteractionResolution {
  width: number
  height: number
}

export interface InteractionColors {
  hovered: THREE.ColorRepresentation
  selected: THREE.ColorRepresentation
}

export interface FaceTriangleSource {
  geometry: THREE.BufferGeometry
  faceIndex: number
  /** Model-workspace layout: one local face index per triangle. */
  triFace?: Uint32Array
  /** CAM B-rep layout: [indexStart, indexCount] per face. */
  faceRanges?: Uint32Array
}

function indexedTrianglePositions(
  geometry: THREE.BufferGeometry,
  triangleIndices: readonly number[],
): Float32Array | null {
  const index = geometry.getIndex()
  const position = geometry.getAttribute('position')
  if (index === null || position === undefined || triangleIndices.length === 0) return null
  const output = new Float32Array(triangleIndices.length * 9)
  let write = 0
  for (const triangle of triangleIndices) {
    for (let corner = 0; corner < 3; corner++) {
      const vertex = index.getX(triangle * 3 + corner)
      output[write++] = position.getX(vertex)
      output[write++] = position.getY(vertex)
      output[write++] = position.getZ(vertex)
    }
  }
  return output
}

/** Extract only one face's triangles without changing the source geometry. */
export function faceTrianglePositions(source: FaceTriangleSource): Float32Array | null {
  const { geometry, faceIndex, triFace, faceRanges } = source
  if (faceIndex < 0) return null
  if (triFace !== undefined) {
    const triangles: number[] = []
    for (let triangle = 0; triangle < triFace.length; triangle++) {
      if (triFace[triangle] === faceIndex) triangles.push(triangle)
    }
    return indexedTrianglePositions(geometry, triangles)
  }
  if (faceRanges === undefined || faceIndex * 2 + 1 >= faceRanges.length) return null
  const indexStart = faceRanges[faceIndex * 2]
  const indexCount = faceRanges[faceIndex * 2 + 1]
  if (indexCount < 3 || indexCount % 3 !== 0 || indexStart % 3 !== 0) return null
  const triangles: number[] = []
  const firstTriangle = indexStart / 3
  for (let offset = 0; offset < indexCount / 3; offset++) triangles.push(firstTriangle + offset)
  return indexedTrianglePositions(geometry, triangles)
}

const BOUNDARY_SNAP = 1e6

function pointKey(x: number, y: number, z: number): string {
  return `${Math.round(x * BOUNDARY_SNAP)},${Math.round(y * BOUNDARY_SNAP)},${Math.round(z * BOUNDARY_SNAP)}`
}

interface BoundaryEdge {
  count: number
  a: readonly [number, number, number]
  b: readonly [number, number, number]
}

/**
 * Reduce a non-indexed triangle stream to its boundary only. Shared triangle
 * sides cancel in pairs, so tessellation diagonals never become hover lines.
 */
export function faceBoundarySegmentPositions(trianglePositions: Float32Array): Float32Array {
  if (trianglePositions.length % 9 !== 0) {
    throw new Error('interactionPresentation: face triangle positions are not xyz triangles')
  }
  const edges = new Map<string, BoundaryEdge>()
  for (let offset = 0; offset < trianglePositions.length; offset += 9) {
    const points = [
      [trianglePositions[offset], trianglePositions[offset + 1], trianglePositions[offset + 2]],
      [trianglePositions[offset + 3], trianglePositions[offset + 4], trianglePositions[offset + 5]],
      [trianglePositions[offset + 6], trianglePositions[offset + 7], trianglePositions[offset + 8]],
    ] as const
    for (const [from, to] of [[0, 1], [1, 2], [2, 0]] as const) {
      const a = points[from]
      const b = points[to]
      const aKey = pointKey(a[0], a[1], a[2])
      const bKey = pointKey(b[0], b[1], b[2])
      const key = aKey < bKey ? `${aKey}|${bKey}` : `${bKey}|${aKey}`
      const existing = edges.get(key)
      if (existing === undefined) edges.set(key, { count: 1, a, b })
      else existing.count++
    }
  }
  const output: number[] = []
  for (const edge of edges.values()) {
    if (edge.count !== 1) continue
    output.push(...edge.a, ...edge.b)
  }
  return new Float32Array(output)
}

function interactionLine(
  segmentPositions: Float32Array,
  color: THREE.ColorRepresentation,
  linewidthPx: number,
  resolution: InteractionResolution,
): BodyEdgeOverlay {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(segmentPositions, 3))
  const line = createBodyEdgeOverlay(geometry, {
    fat: true,
    color,
    linewidthPx,
    resolution,
    opacity: 1,
    depthBias: true,
    toneMapped: false,
    ownsGeometry: true,
    renderOrder: 20,
    userData: { isInteractionOverlay: true },
  })
  if (line.geometry !== geometry) geometry.dispose()
  return line
}

/** Hover is boundary-only; selected is an orange face fill. */
export function createFaceInteractionOverlay(args: {
  trianglePositions: Float32Array
  variant: InteractionVariant
  resolution: InteractionResolution
  clippingPlanes?: THREE.Plane[] | null
  color?: THREE.ColorRepresentation
}): THREE.Object3D | null {
  const color = args.color ?? (args.variant === 'selected' ? INTERACTION_ORANGE : INTERACTION_HOVER_ORANGE)
  if (args.variant === 'hovered') {
    const boundary = faceBoundarySegmentPositions(args.trianglePositions)
    if (boundary.length === 0) return null
    const line = interactionLine(boundary, color, INTERACTION_EDGE_WIDTH_PX, args.resolution)
    ;(line.material as THREE.Material).clippingPlanes = args.clippingPlanes === undefined
      ? null
      : args.clippingPlanes
    line.userData.interactionKind = 'face-boundary'
    line.userData.interactionVariant = args.variant
    return line
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(args.trianglePositions, 3))
  const material = new THREE.MeshBasicMaterial({
    color,
    side: THREE.DoubleSide,
    depthTest: true,
    depthWrite: false,
    transparent: true,
    opacity: INTERACTION_SELECTED_FILL_OPACITY,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
    toneMapped: false,
  })
  material.clippingPlanes = args.clippingPlanes === undefined ? null : args.clippingPlanes
  const mesh = new THREE.Mesh(geometry, material)
  mesh.renderOrder = 21
  mesh.userData.isInteractionOverlay = true
  mesh.userData.interactionKind = 'face-fill'
  mesh.userData.interactionVariant = args.variant
  return mesh
}

/** One independent, wider, depth-aware stroke for a picked topology edge. */
export function createEdgeInteractionOverlay(args: {
  polylinePositions: Float32Array
  variant: InteractionVariant
  resolution: InteractionResolution
  clippingPlanes?: THREE.Plane[] | null
  color?: THREE.ColorRepresentation
}): BodyEdgeOverlay | null {
  if (args.polylinePositions.length < 6 || args.polylinePositions.length % 3 !== 0) return null
  const pointCount = args.polylinePositions.length / 3
  const segmentGeometry = buildEdgeLineGeometry({
    edgePositions: args.polylinePositions,
    edgeOffsets: new Uint32Array([0, pointCount]),
  })
  const position = segmentGeometry.getAttribute('position')
  const copied = new Float32Array(position.array as ArrayLike<number>)
  segmentGeometry.dispose()
  const color = args.color ?? (args.variant === 'selected' ? INTERACTION_ORANGE : INTERACTION_HOVER_ORANGE)
  const line = interactionLine(
    copied,
    color,
    args.variant === 'selected' ? INTERACTION_SELECTED_EDGE_WIDTH_PX : INTERACTION_EDGE_WIDTH_PX,
    args.resolution,
  )
  ;(line.material as THREE.Material).clippingPlanes = args.clippingPlanes === undefined
    ? null
    : args.clippingPlanes
  line.userData.interactionKind = 'edge-stroke'
  line.userData.interactionVariant = args.variant
  return line
}

const BODY_OUTLINE_VERTEX_SHADER = `
#include <common>
#include <clipping_planes_pars_vertex>
uniform vec2 interactionResolution;
uniform float interactionWidthPx;
void main() {
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  vec3 mvNormal = normalize(normalMatrix * normal);
  vec4 clipPosition = projectionMatrix * mvPosition;
  vec4 normalPosition = projectionMatrix * vec4(mvPosition.xyz + mvNormal, 1.0);
  vec2 baseNdc = clipPosition.xy / max(abs(clipPosition.w), 1e-6);
  vec2 normalNdc = normalPosition.xy / max(abs(normalPosition.w), 1e-6);
  vec2 direction = normalNdc - baseNdc;
  float directionLength = length(direction);
  if (directionLength > 1e-6) {
    direction /= directionLength;
    clipPosition.xy += direction * interactionWidthPx * 2.0
      / max(interactionResolution, vec2(1.0)) * clipPosition.w;
  }
  gl_Position = clipPosition;
  #include <clipping_planes_vertex>
}
`

const BODY_OUTLINE_FRAGMENT_SHADER = `
#include <common>
#include <clipping_planes_pars_fragment>
uniform vec3 interactionColor;
void main() {
  #include <clipping_planes_fragment>
  gl_FragColor = vec4(interactionColor, 1.0);
}
`

/**
 * Dedicated screen-space silhouette shell. Back-face rendering prevents
 * internal topology from becoming selection glow; the normal extrusion makes
 * only the camera-visible outer profile extend beyond the resting body.
 */
export function createBodySilhouetteOverlay(args: {
  geometry: THREE.BufferGeometry
  resolution: InteractionResolution
  clippingPlanes?: THREE.Plane[] | null
  color?: THREE.ColorRepresentation
  linewidthPx?: number
}): THREE.Mesh {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      interactionResolution: {
        value: new THREE.Vector2(Math.max(1, args.resolution.width), Math.max(1, args.resolution.height)),
      },
      interactionWidthPx: { value: args.linewidthPx ?? INTERACTION_BODY_OUTLINE_WIDTH_PX },
      interactionColor: { value: new THREE.Color(args.color ?? INTERACTION_ORANGE) },
    },
    vertexShader: BODY_OUTLINE_VERTEX_SHADER,
    fragmentShader: BODY_OUTLINE_FRAGMENT_SHADER,
    side: THREE.BackSide,
    depthTest: true,
    depthWrite: false,
    transparent: false,
    toneMapped: false,
    clipping: true,
  })
  material.clippingPlanes = args.clippingPlanes === undefined ? null : args.clippingPlanes
  const outline = new THREE.Mesh(args.geometry, material)
  outline.renderOrder = 19
  outline.frustumCulled = false
  outline.userData.isInteractionOverlay = true
  outline.userData.interactionKind = 'body-silhouette'
  outline.userData.ownsInteractionGeometry = false
  return outline
}

/**
 * Whole-body interaction uses different techniques for preview and commit.
 * Hover remains an outer-profile-only shell. Selection tint belongs to the
 * host's actual MeshStandardMaterial; this object adds only a true-topology
 * outline centered exactly on the rendered edges.
 */
export function createBodyInteractionOverlay(args: {
  geometry: THREE.BufferGeometry
  outlineSegmentPositions?: Float32Array
  variant: InteractionVariant
  resolution: InteractionResolution
  clippingPlanes?: THREE.Plane[] | null
  color?: THREE.ColorRepresentation
}): THREE.Object3D {
  const color = args.color
    ?? (args.variant === 'selected' ? INTERACTION_ORANGE : INTERACTION_HOVER_ORANGE)
  if (args.variant === 'hovered') {
    const silhouette = createBodySilhouetteOverlay({
      geometry: args.geometry,
      resolution: args.resolution,
      clippingPlanes: args.clippingPlanes,
      color,
    })
    silhouette.userData.interactionVariant = args.variant
    return silhouette
  }

  let segmentPositions = args.outlineSegmentPositions
  if (segmentPositions === undefined) {
    const fallback = new THREE.EdgesGeometry(args.geometry, 1)
    const position = fallback.getAttribute('position')
    segmentPositions = position === undefined
      ? new Float32Array()
      : new Float32Array(position.array as ArrayLike<number>)
    fallback.dispose()
  }
  const outline = interactionLine(
    segmentPositions,
    color,
    SELECTED_BODY_VISUAL_CONTRACT.outlineWidthPx,
    args.resolution,
  )
  ;(outline.material as THREE.Material).clippingPlanes =
    args.clippingPlanes === undefined ? null : args.clippingPlanes
  outline.userData.interactionKind = 'body-outline'
  outline.userData.interactionVariant = args.variant
  outline.userData.interactionGeometry = args.geometry
  return outline
}

export function createCachedBodyInteractionOverlay(args: {
  body: CachedBody
  selection: SelectionState
  bodyVariant?: InteractionVariant | null
  resolution: InteractionResolution
  clippingPlanes?: THREE.Plane[] | null
  colors?: InteractionColors
  hiddenFaceIds?: ReadonlySet<string>
  hiddenEdgeIds?: ReadonlySet<string>
}): THREE.Group | null {
  const group = new THREE.Group()
  group.userData.isInteractionOverlay = true
  group.userData.interactionKind = 'body-interactions'
  const add = (object: THREE.Object3D | null): void => {
    if (object !== null) group.add(object)
  }

  for (let faceIndex = 0; faceIndex < args.body.faceIds.length; faceIndex++) {
    const faceId = args.body.faceIds[faceIndex]
    if (args.hiddenFaceIds?.has(faceId)) continue
    const kind = args.selection.highlightFor(faceId)
    if (kind === 'none') continue
    const positions = faceTrianglePositions({
      geometry: args.body.geometry,
      faceIndex,
      triFace: args.body.triFace,
    })
    if (positions === null) continue
    add(createFaceInteractionOverlay({
      trianglePositions: positions,
      variant: kind,
      resolution: args.resolution,
      clippingPlanes: args.clippingPlanes,
      color: args.colors?.[kind],
    }))
  }

  for (let edgeIndex = 0; edgeIndex < args.body.edgeIds.length; edgeIndex++) {
    const edgeId = args.body.edgeIds[edgeIndex]
    if (args.hiddenEdgeIds?.has(edgeId)) continue
    const kind = args.selection.highlightFor(edgeId)
    if (kind === 'none') continue
    const pointStart = args.body.edgeOffsets[edgeIndex]
    const pointEnd = args.body.edgeOffsets[edgeIndex + 1]
    add(createEdgeInteractionOverlay({
      polylinePositions: args.body.edgePositions.slice(pointStart * 3, pointEnd * 3),
      variant: kind,
      resolution: args.resolution,
      clippingPlanes: args.clippingPlanes,
      color: args.colors?.[kind],
    }))
  }

  if (args.bodyVariant !== undefined && args.bodyVariant !== null) {
    const outlinePosition = args.body.edgeGeometry.getAttribute('position')
    add(createBodyInteractionOverlay({
      geometry: args.body.geometry,
      outlineSegmentPositions: outlinePosition === undefined
        ? undefined
        : new Float32Array(outlinePosition.array as ArrayLike<number>),
      variant: args.bodyVariant,
      resolution: args.resolution,
      clippingPlanes: args.clippingPlanes,
      color: args.colors?.[args.bodyVariant]
        ?? (args.bodyVariant === 'selected' ? INTERACTION_ORANGE : INTERACTION_HOVER_ORANGE),
    }))
  }
  return group.children.length === 0 ? null : group
}

export function interactionOverlayVisibleForMode(
  kind: 'face' | 'edge' | 'body',
  mode: InteractionDisplayMode,
): boolean {
  // Interaction feedback is independent of resting topology visibility.
  // Shaded-no-edges still shows picks; unshaded keeps them over the wire view;
  // translucent keeps depth testing while respecting its see-through fill.
  void kind
  void mode
  return true
}

export function syncInteractionResolution(
  object: THREE.Object3D,
  resolution: InteractionResolution,
): void {
  object.traverse((child) => {
    const material = (child as THREE.Mesh).material
    const materials = material === undefined ? [] : (Array.isArray(material) ? material : [material])
    for (const candidate of materials) {
      if (candidate instanceof THREE.ShaderMaterial) {
        const value = candidate.uniforms.interactionResolution?.value
        if (value instanceof THREE.Vector2) value.set(Math.max(1, resolution.width), Math.max(1, resolution.height))
      }
      // LineMaterial extends ShaderMaterial, so this cannot be an `else`
      // branch: fat interaction strokes expose resolution through this
      // property while silhouette shells use interactionResolution above.
      const lineResolution = (candidate as unknown as { resolution?: THREE.Vector2 }).resolution
      lineResolution?.set(Math.max(1, resolution.width), Math.max(1, resolution.height))
    }
  })
}

export function syncInteractionColor(
  object: THREE.Object3D,
  color: THREE.ColorRepresentation,
): void {
  object.traverse((child) => {
    const material = (child as THREE.Mesh).material
    const materials = material === undefined ? [] : (Array.isArray(material) ? material : [material])
    for (const candidate of materials) {
      if (candidate instanceof THREE.ShaderMaterial) {
        const value = candidate.uniforms.interactionColor?.value
        if (value instanceof THREE.Color) value.set(color)
      }
      const materialColor = (candidate as THREE.Material & { color?: THREE.Color }).color
      if (materialColor instanceof THREE.Color) materialColor.set(color)
    }
  })
}

export function syncInteractionClipping(
  object: THREE.Object3D,
  clippingPlanes: THREE.Plane[] | null,
): void {
  object.traverse((child) => {
    const material = (child as THREE.Mesh).material
    const materials = material === undefined ? [] : (Array.isArray(material) ? material : [material])
    for (const candidate of materials) candidate.clippingPlanes = clippingPlanes
  })
}

export function disposeInteractionOverlay(object: THREE.Object3D): void {
  object.removeFromParent()
  object.traverse((child) => {
    const renderable = child as THREE.Mesh
    if (renderable.geometry !== undefined && child.userData.ownsInteractionGeometry !== false) {
      renderable.geometry.dispose()
    }
    const material = renderable.material
    const materials = material === undefined ? [] : (Array.isArray(material) ? material : [material])
    for (const candidate of materials) candidate.dispose()
  })
  object.clear()
}
