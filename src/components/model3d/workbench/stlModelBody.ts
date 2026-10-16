// WO-1935: an imported STL shown in the Model screen as a mesh-backed body.
//
// The part stays an STL underneath. Nothing here converts it to a kernel body
// or touches its CAM row: the shape comes from THE resolver
// (`resolveEditedStlMesh`, ADR-0051 s1.2 - the row's `meshEdits` journal
// applied), and the features come from the SAME recognisers Setup used
// (`src/mesh/recognition`). This module owns three things and nothing else:
//   1. the model - displayed triangles, and for each one the recognised
//      feature that owns it (or none);
//   2. the presentation - a body that LOOKS solid (crease-angle normals, so a
//      faceted bore shades round and a flat stays crisp), the part's outline
//      edges as the resting edges, and the triangle mesh as a separate wire
//      that only the Unshaded (wireframe) display mode shows;
//   3. the pick - a ray hit resolved to the WHOLE feature owning the hit
//      triangle, or to the body when no recognised feature owns it.
//
// Facet numbering: every index here is a DISPLAYED triangle index (the edited
// mesh, in `resolveEditedStlMesh` order). The recognisers speak WO-1845
// source-facet ids; `displayedFacets` below converts once, at build time, the
// way the panel's `displayedFacetsOf` did (an edited part is renumbered -
// WO-1923's audit).

import { textFor } from '../../../i18n'
const workbenchText = textFor('sketch-and-model-workbench')
import * as THREE from 'three'
import { toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { resolveEditedStlMesh, type MeshEditRecord, type MeshEditReplayStop } from '../../../mesh/edit'
import {
  describeEdgeBlend,
  describeFeature,
  describeFlatFace,
  recognizeEdgeBlends,
  recognizeFlatFaces,
  recognizeMeshFeatures,
  type RecognizedEdgeBlend,
  type RecognizedFeature,
  type RecognizedFlatFace,
} from '../../../mesh/recognition'
import type { MeshBuffers } from '../../../mesh/types'
import type { ShadingMode } from '../../../types'
import {
  createFaceInteractionOverlay,
  disposeInteractionOverlay,
  INTERACTION_HOVER_ORANGE,
  INTERACTION_ORANGE,
  type InteractionResolution,
} from '../../../viewport3d/interactionPresentation'
import {
  createModeledBodyMaterial,
  resolveModeledBodyEdgeModeStyle,
  resolveModeledBodyVisualStyle,
} from '../../../lib/viewport/lighting/bodyVisualStyle'
import { DEFAULT_VIEWPORT_THEME } from '../../../lib/viewport/lighting/viewportThemes'
import { modeledBodyEdgesVisibleForMode } from '../../../lib/viewport/displayModes'

/** The Bodies-list / selection id of an STL row shown in the Model screen.
 *  Prefixed so it can never collide with a DAG feature id. */
export const STL_MODEL_BODY_PREFIX = 'stl-body:'
export function stlModelBodyId(geoId: string): string {
  return `${STL_MODEL_BODY_PREFIX}${geoId}`
}
export function isStlModelBodyId(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.startsWith(STL_MODEL_BODY_PREFIX)
}

/** Crease angle for the shading normals: facets meeting at less than this
 *  share a smoothed normal (a 32-sided bore reads round); at more, the edge
 *  stays sharp. The outline edges use the same angle as Setup's STL edges. */
const SHADING_CREASE_DEG = 30
const OUTLINE_EDGE_DEG = 25

/** WO-1936: what the recogniser proved about a feature - the facts a Model
 *  tool needs to turn a pick into the SAME mesh edit Setup's buttons wrote. */
export type StlFeatureTarget =
  | { family: 'round'; feature: RecognizedFeature }
  | { family: 'blend'; blend: RecognizedEdgeBlend }
  | { family: 'flat'; face: RecognizedFlatFace }
  | { family: 'pocket' }

export interface StlModelFeature {
  /** the recogniser's own id, e.g. `through-hole-256` */
  id: string
  /** plain word for the kind: 'through-hole', 'fillet', 'flat-face', ... */
  kind: string
  /** the recogniser's own one-line description */
  label: string
  /** displayed triangle indices this feature owns, ascending */
  facets: number[]
  /** WO-1936: the recogniser's WHOLE selection as WO-1845 source-facet ids -
   *  what an edit selects (Setup selected by these), even where a higher
   *  priority feature owns some of the facets for picking. */
  sourceFacetIds: number[]
  target: StlFeatureTarget
}

export interface StlModelBodyModel {
  geoId: string
  name: string
  /** non-indexed triangle soup, 9 floats per displayed facet */
  positions: Float32Array
  facetCount: number
  features: StlModelFeature[]
  /** displayed facet -> index into `features`, -1 = no recognised feature */
  featureOfFacet: Int32Array
  /** WO-1936: the resolved mesh (journal applied) and its source-facet id
   *  view - what an edit's facets index and what its witness is taken from. */
  mesh: MeshBuffers
  sourceFacetIds: Uint32Array
  /** every round feature proved, for "the bore now breaks into ..." */
  roundFeatures: RecognizedFeature[]
  /** the journal replay stopped early (the shape shown is the last good one) */
  stopped?: MeshEditReplayStop
}

/** A mesh as a non-indexed triangle soup, 9 floats per facet, facet order kept. */
export function triangleSoupPositions(mesh: MeshBuffers): Float32Array {
  const facetCount = mesh.indices.length / 3
  const positions = new Float32Array(facetCount * 9)
  for (let f = 0; f < facetCount; f++) {
    for (let k = 0; k < 3; k++) {
      const v = mesh.indices[f * 3 + k]
      positions[f * 9 + k * 3] = mesh.positions[v * 3]
      positions[f * 9 + k * 3 + 1] = mesh.positions[v * 3 + 1]
      positions[f * 9 + k * 3 + 2] = mesh.positions[v * 3 + 2]
    }
  }
  return positions
}

/** Shading geometry for a triangle soup: crease-angle normals (a faceted bore
 *  reads round, a flat stays crisp), triangle order kept. */
function creasedSoupGeometry(positions: Float32Array): THREE.BufferGeometry {
  const soup = new THREE.BufferGeometry()
  soup.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  // toCreasedNormals keeps the triangle order (non-indexed in, non-indexed
  // out), so the raycast's faceIndex IS the displayed facet index.
  const geometry = positions.length > 0
    ? toCreasedNormals(soup, THREE.MathUtils.degToRad(SHADING_CREASE_DEG))
    : soup
  if (geometry !== soup) soup.dispose()
  geometry.computeBoundingBox()
  geometry.computeBoundingSphere()
  return geometry
}

/** The displayed-triangle indices whose source-facet id is in `sourceIds`. */
function displayedFacets(sourceFacetIds: Uint32Array, sourceIds: readonly number[]): number[] {
  const wanted = new Set(sourceIds)
  const out: number[] = []
  for (let facet = 0; facet < sourceFacetIds.length; facet++) {
    if (wanted.has(sourceFacetIds[facet])) out.push(facet)
  }
  return out
}

/**
 * Resolve the row's bytes + journal and recognise its features.
 *
 * A facet claimed by more than one recogniser belongs to the first in this
 * order: round features (holes, bosses, counterbores, countersinks), pockets
 * and slots, edge blends (fillets, chamfers), then flat faces. So a click on a
 * blind hole's floor picks the hole, not "a flat face".
 */
export function buildStlModelBodyModel(args: {
  geoId: string
  name: string
  bytes: ArrayBuffer | Uint8Array
  meshEdits: readonly MeshEditRecord[] | undefined
}): StlModelBodyModel {
  const resolved = resolveEditedStlMesh(args.bytes, args.meshEdits)
  const { mesh, sourceFacetIds } = resolved
  const facetCount = mesh.indices.length / 3
  const positions = triangleSoupPositions(mesh)

  const candidates: Array<{ id: string; kind: string; label: string; sourceFacetIds: number[]; target: StlFeatureTarget }> = []
  const round = recognizeMeshFeatures(mesh, sourceFacetIds)
  for (const f of round.features) {
    candidates.push({ id: f.id, kind: f.kind, label: describeFeature(f), sourceFacetIds: f.sourceFacetIds, target: { family: 'round', feature: f } })
  }
  for (const p of round.pockets) {
    candidates.push({ id: p.id, kind: p.kind, label: workbenchText('stlModelBody.rectangularPocketXMmMmDeep', { value1: String(p.lengthMm.toFixed(2)), value2: String(p.widthMm.toFixed(2)), value3: String(p.depthMm.toFixed(2)) }), sourceFacetIds: p.sourceFacetIds, target: { family: 'pocket' } })
  }
  for (const s of round.slots) {
    candidates.push({ id: s.id, kind: 'slot', label: workbenchText('stlModelBody.slotXMmMmDeep', { value1: String(s.lengthMm.toFixed(2)), value2: String(s.widthMm.toFixed(2)), value3: String(s.depthMm.toFixed(2)) }), sourceFacetIds: s.sourceFacetIds, target: { family: 'pocket' } })
  }
  for (const d of round.draftedPockets) {
    candidates.push({ id: d.id, kind: d.kind, label: workbenchText('stlModelBody.draftedPocketXMmMmDeep', { value1: String(d.lengthMm.toFixed(2)), value2: String(d.widthMm.toFixed(2)), value3: String(d.depthMm.toFixed(2)) }), sourceFacetIds: d.sourceFacetIds, target: { family: 'pocket' } })
  }
  for (const b of recognizeEdgeBlends(mesh, sourceFacetIds).blends) {
    candidates.push({ id: b.id, kind: b.kind, label: describeEdgeBlend(b), sourceFacetIds: b.sourceFacetIds, target: { family: 'blend', blend: b } })
  }
  for (const face of recognizeFlatFaces(mesh, sourceFacetIds).faces) {
    candidates.push({ id: face.id, kind: 'flat-face', label: describeFlatFace(face), sourceFacetIds: face.sourceFacetIds, target: { family: 'flat', face } })
  }

  const featureOfFacet = new Int32Array(facetCount).fill(-1)
  const features: StlModelFeature[] = []
  for (const c of candidates) {
    const allFacets = displayedFacets(sourceFacetIds, c.sourceFacetIds)
    const facets = allFacets.filter((f) => featureOfFacet[f] === -1)
    // WO-2803: retain planar tool targets even when a round feature owns
    // their facets in the resting pick (counterbore / blind-hole floors).
    // Resize Hole and Defeature retain their whole-feature priority.
    if (facets.length === 0 && c.target.family !== 'flat') continue
    const index = features.length
    for (const f of facets) featureOfFacet[f] = index
    features.push({ id: c.id, kind: c.kind, label: c.label, facets: c.target.family === 'flat' ? allFacets : facets, sourceFacetIds: c.sourceFacetIds, target: c.target })
  }

  return {
    geoId: args.geoId,
    name: args.name,
    positions,
    facetCount,
    features,
    featureOfFacet,
    mesh,
    sourceFacetIds,
    roundFeatures: round.features,
    ...(resolved.stopped ? { stopped: resolved.stopped } : {}),
  }
}

/** WO-1936: the area-weighted centre of a feature's own facets, in the frame
 *  the body is drawn in - where a Model tool anchors its value entry. (The
 *  recognisers report some points in a recentred frame; this never is.) */
export function stlFeatureCentroid(model: StlModelBodyModel, feature: StlModelFeature): { x: number; y: number; z: number } {
  const p = model.positions
  let area = 0
  const sum = [0, 0, 0]
  for (const f of feature.facets) {
    const o = f * 9
    const ux = p[o + 3] - p[o], uy = p[o + 4] - p[o + 1], uz = p[o + 5] - p[o + 2]
    const vx = p[o + 6] - p[o], vy = p[o + 7] - p[o + 1], vz = p[o + 8] - p[o + 2]
    const a = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2
    for (let k = 0; k < 3; k++) sum[k] += a * (p[o + k] + p[o + 3 + k] + p[o + 6 + k]) / 3
    area += a
  }
  const d = area > 0 ? area : 1
  return { x: sum[0] / d, y: sum[1] / d, z: sum[2] / d }
}

/** What a pick resolved to: a whole recognised feature, or the body. */
export type StlModelPick =
  /** WO-2762: `facet` = the displayed facet the ray hit, so a tool can tell
   *  which step of a stepped hole was picked */
  | { kind: 'feature'; featureIndex: number; distance: number; facet?: number }
  | { kind: 'body'; distance: number }

export interface StlModelBodyPresentation {
  readonly model: StlModelBodyModel
  /** the scene root: add/remove this one object */
  readonly root: THREE.Group
  /** the shaded body - the raycast target; triangle i is displayed facet i */
  readonly mesh: THREE.Mesh
  /** the part's outline (crease) edges - the resting edges */
  readonly outlineEdges: THREE.LineSegments
  /** every triangle edge - the mesh, shown only in Unshaded (wireframe) */
  readonly triangleEdges: THREE.LineSegments
  applyDisplayMode(mode: ShadingMode): void
  /** the part's resting colour ('#rrggbb', the CAM row's own) */
  setColor(color: string): void
  setVisible(visible: boolean): void
  /** `null` clears. A feature highlights ALL its facets as one. */
  setHover(pick: StlModelPick | null): void
  setSelection(pick: StlModelPick | null): void
  /** WO-1936: a Model tool's picks - several whole features painted as the
   *  selection at once (Defeature, Fillet). Replaces `setSelection`'s paint. */
  setMarkedFeatures(featureIndexes: readonly number[]): void
  /** the triangles the current selection/hover overlay paints (0 = none) */
  highlightedFacetCount(variant: 'hovered' | 'selected'): number
  /** WO-1936: show what an edit WOULD make of the part, in place of the part,
   *  until cleared (`null`). The body itself is untouched - Cancel restores it. */
  setPreview(mesh: MeshBuffers | null): void
  /** the facet count of the preview on show, 0 when there is none */
  previewFacetCount(): number
  pick(ray: { origin: { x: number; y: number; z: number }; direction: { x: number; y: number; z: number } }): StlModelPick | null
  dispose(): void
}

function facetPositions(model: StlModelBodyModel, facets: readonly number[]): Float32Array {
  const out = new Float32Array(facets.length * 9)
  facets.forEach((f, i) => out.set(model.positions.subarray(f * 9, f * 9 + 9), i * 9))
  return out
}

export function createStlModelBodyPresentation(
  model: StlModelBodyModel,
  options: { color?: string; resolution?: () => InteractionResolution } = {},
): StlModelBodyPresentation {
  const bodyStyle = resolveModeledBodyVisualStyle(DEFAULT_VIEWPORT_THEME)
  let bodyColor = options.color ?? bodyStyle.bodyHex
  const resolution = options.resolution ?? (() => ({ width: 1, height: 1 }))

  const geometry = creasedSoupGeometry(model.positions)

  const material = createModeledBodyMaterial({ color: bodyColor })
  const restingColor = material.color.clone()
  const restingOpacity = material.opacity
  const restingTransparent = material.transparent
  const mesh = new THREE.Mesh(geometry, material)
  mesh.name = model.name
  mesh.userData.stlModelBodyGeoId = model.geoId
  mesh.userData.isBodyPresentationMesh = true

  const outlineGeometry = new THREE.EdgesGeometry(geometry, OUTLINE_EDGE_DEG)
  const outlineEdges = new THREE.LineSegments(outlineGeometry, new THREE.LineBasicMaterial({ color: bodyStyle.edgeHex }))
  outlineEdges.userData.stlModelBodyEdges = 'outline'

  // WireframeGeometry lists each shared triangle edge once (it keys edges by
  // position), so neighbouring triangles do not double-draw a line.
  const wireGeometry = new THREE.WireframeGeometry(geometry)
  const triangleEdges = new THREE.LineSegments(
    wireGeometry,
    new THREE.LineBasicMaterial({ color: 0x5a6570, transparent: true, opacity: 0.85 }),
  )
  triangleEdges.userData.stlModelBodyEdges = 'triangles'
  triangleEdges.visible = false

  const root = new THREE.Group()
  root.name = `stl-model-body:${model.geoId}`
  root.userData.stlModelBodyGeoId = model.geoId
  root.add(mesh)
  root.add(outlineEdges)
  root.add(triangleEdges)

  let mode: ShadingMode = 'shaded-edges'
  let visible = true
  // WO-1936: the edit preview, drawn with the body's own material and outline
  // rule while the body hides behind it.
  let preview: { mesh: THREE.Mesh; edges: THREE.LineSegments; facets: number } | null = null
  let selected: StlModelPick | null = null
  const overlays: { hovered: THREE.Object3D | null; selected: THREE.Object3D | null } = { hovered: null, selected: null }
  const overlayFacets = { hovered: 0, selected: 0 }

  const applyMaterial = (): void => {
    const bodySelected = selected?.kind === 'body'
    material.color.set(bodySelected ? INTERACTION_ORANGE : restingColor)
    if (mode === 'unshaded') {
      // The same Unshaded filter modelled bodies get: the surface emits no fill
      // (it stays in the scene for picking), the wire is what you see.
      material.transparent = true
      material.opacity = 0
      material.depthWrite = false
    } else if (mode === 'translucent') {
      material.transparent = true
      material.opacity = 0.35
      material.depthWrite = false
    } else {
      material.transparent = restingTransparent
      material.opacity = restingOpacity
      material.depthWrite = true
    }
    material.needsUpdate = true
    const edgeStyle = resolveModeledBodyEdgeModeStyle(mode, bodyColor)
    const outlineMaterial = outlineEdges.material as THREE.LineBasicMaterial
    outlineMaterial.color.set(edgeStyle.color)
    outlineMaterial.opacity = edgeStyle.opacity
    outlineMaterial.transparent = edgeStyle.opacity < 1
    const showBody = visible && preview === null
    outlineEdges.visible = showBody && modeledBodyEdgesVisibleForMode(mode)
    triangleEdges.visible = showBody && mode === 'unshaded'
    mesh.visible = showBody
    if (preview !== null) {
      preview.mesh.visible = visible
      preview.edges.visible = visible && modeledBodyEdgesVisibleForMode(mode)
      ;(preview.edges.material as THREE.LineBasicMaterial).color.set(edgeStyle.color)
    }
  }

  const clearPreview = (): void => {
    if (preview === null) return
    preview.mesh.removeFromParent()
    preview.edges.removeFromParent()
    preview.mesh.geometry.dispose()
    preview.edges.geometry.dispose()
    ;(preview.edges.material as THREE.Material).dispose()
    preview = null
  }

  const setOverlay = (variant: 'hovered' | 'selected', pick: StlModelPick | null): void => {
    const existing = overlays[variant]
    if (existing !== null) {
      disposeInteractionOverlay(existing)
      overlays[variant] = null
      overlayFacets[variant] = 0
    }
    if (pick === null || pick.kind !== 'feature') return
    paintFeatures(variant, [pick.featureIndex])
  }

  const paintFeatures = (variant: 'hovered' | 'selected', featureIndexes: readonly number[]): void => {
    const picked = featureIndexes.map((i) => model.features[i]).filter((f): f is StlModelFeature => f !== undefined)
    if (picked.length === 0) return
    const facets = picked.flatMap((f) => f.facets)
    const overlay = createFaceInteractionOverlay({
      trianglePositions: facetPositions(model, facets),
      variant,
      resolution: resolution(),
      color: variant === 'selected' ? INTERACTION_ORANGE : INTERACTION_HOVER_ORANGE,
    })
    if (overlay === null) return
    overlay.userData.stlModelFeatureId = picked.map((f) => f.id).join(',')
    overlay.userData.stlModelFacetCount = facets.length
    mesh.add(overlay)
    overlays[variant] = overlay
    overlayFacets[variant] = facets.length
  }

  const raycaster = new THREE.Raycaster()

  const presentation: StlModelBodyPresentation = {
    model,
    root,
    mesh,
    outlineEdges,
    triangleEdges,
    applyDisplayMode(next) {
      mode = next
      applyMaterial()
    },
    setColor(color) {
      if (color === bodyColor) return
      bodyColor = color
      restingColor.set(color)
      applyMaterial()
    },
    setVisible(next) {
      visible = next
      applyMaterial()
      if (!next) {
        setOverlay('hovered', null)
      }
    },
    setHover(pick) {
      setOverlay('hovered', pick)
    },
    setSelection(pick) {
      selected = pick
      setOverlay('selected', pick)
      applyMaterial()
    },
    setMarkedFeatures(featureIndexes) {
      selected = null
      setOverlay('selected', null)
      paintFeatures('selected', featureIndexes)
      applyMaterial()
    },
    highlightedFacetCount(variant) {
      return overlayFacets[variant]
    },
    setPreview(next) {
      clearPreview()
      if (next !== null) {
        const previewGeometry = creasedSoupGeometry(triangleSoupPositions(next))
        const previewMesh = new THREE.Mesh(previewGeometry, material)
        previewMesh.name = workbenchText('stlModelBody.preview', { name: String(model.name) })
        previewMesh.userData.stlModelBodyPreview = true
        const previewEdges = new THREE.LineSegments(
          new THREE.EdgesGeometry(previewGeometry, OUTLINE_EDGE_DEG),
          new THREE.LineBasicMaterial({ color: bodyStyle.edgeHex }),
        )
        previewEdges.userData.stlModelBodyEdges = 'preview-outline'
        root.add(previewMesh)
        root.add(previewEdges)
        preview = { mesh: previewMesh, edges: previewEdges, facets: next.indices.length / 3 }
      }
      applyMaterial()
    },
    previewFacetCount() {
      return preview?.facets ?? 0
    },
    pick(ray) {
      if (!visible) return null
      raycaster.set(
        new THREE.Vector3(ray.origin.x, ray.origin.y, ray.origin.z),
        new THREE.Vector3(ray.direction.x, ray.direction.y, ray.direction.z).normalize(),
      )
      root.updateMatrixWorld(true)
      const [hit] = raycaster.intersectObject(mesh, false)
      if (hit === undefined || hit.faceIndex === undefined || hit.faceIndex === null) return null
      const featureIndex = model.featureOfFacet[hit.faceIndex] ?? -1
      return featureIndex >= 0
        ? { kind: 'feature', featureIndex, distance: hit.distance, facet: hit.faceIndex }
        : { kind: 'body', distance: hit.distance }
    },
    dispose() {
      clearPreview()
      setOverlay('hovered', null)
      setOverlay('selected', null)
      root.removeFromParent()
      geometry.dispose()
      material.dispose()
      outlineGeometry.dispose()
      ;(outlineEdges.material as THREE.Material).dispose()
      wireGeometry.dispose()
      ;(triangleEdges.material as THREE.Material).dispose()
    },
  }
  applyMaterial()
  return presentation
}

/** The console line a pick reports - plain words, the recogniser's own. */
export function describeStlModelPick(model: StlModelBodyModel, pick: StlModelPick): string {
  if (pick.kind === 'body') return workbenchText('stlModelBody.selectedTheWholePart', { name: String(model.name) })
  const feature = model.features[pick.featureIndex]
  return workbenchText('stlModelBody.selectedOnFacets', { label: String(feature.label), name: String(model.name), length: String(feature.facets.length) })
}
