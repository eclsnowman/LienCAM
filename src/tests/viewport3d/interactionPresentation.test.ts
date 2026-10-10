import * as THREE from 'three'
import { afterEach, describe, expect, it } from 'vitest'
import {
  GeometryCache,
  INTERACTION_EDGE_WIDTH_PX,
  INTERACTION_HOVER_ORANGE,
  INTERACTION_ORANGE,
  INTERACTION_SELECTED_EDGE_WIDTH_PX,
  SELECTED_BODY_VISUAL_CONTRACT,
  SelectionState,
  applySelectedBodyMaterialTint,
  createBodySilhouetteOverlay,
  createCachedBodyInteractionOverlay,
  createEdgeInteractionOverlay,
  createFaceInteractionOverlay,
  disposeInteractionOverlay,
  faceBoundarySegmentPositions,
  faceTrianglePositions,
  interactionOverlayVisibleForMode,
  restoreSelectedBodyMaterialTint,
  syncInteractionClipping,
  syncInteractionResolution,
  updateSelectedBodyMaterialTint,
} from '../../viewport3d'
import { makeBoxFixture } from './fixtures'

const resolution = { width: 800, height: 600 }
const disposables: THREE.Object3D[] = []

afterEach(() => {
  for (const object of disposables.splice(0)) disposeInteractionOverlay(object)
})

describe('shared viewport interaction presentation', () => {
  it('extracts one Model face and cancels its tessellation diagonal from the hover boundary', () => {
    const cache = new GeometryCache()
    const fixture = makeBoxFixture()
    const body = cache.ingest('box', fixture.buffers)
    const faceIndex = body.faceIds.indexOf(fixture.faceIds.posZ)
    const triangles = faceTrianglePositions({
      geometry: body.geometry,
      faceIndex,
      triFace: body.triFace,
    })
    expect(triangles).not.toBeNull()
    expect(triangles!.length).toBe(18)
    // A quad is four boundary segments (8 xyz endpoints), never the shared
    // diagonal between its two tessellation triangles.
    expect(faceBoundarySegmentPositions(triangles!)).toHaveLength(24)
    cache.disposeAll()
  })

  it('keeps face hover boundary-only and selected face as an orange depth-aware fill', () => {
    const triangles = new Float32Array([
      0, 0, 0, 1, 0, 0, 1, 1, 0,
      0, 0, 0, 1, 1, 0, 0, 1, 0,
    ])
    const hover = createFaceInteractionOverlay({ trianglePositions: triangles, variant: 'hovered', resolution })!
    const selected = createFaceInteractionOverlay({ trianglePositions: triangles, variant: 'selected', resolution })!
    disposables.push(hover, selected)

    expect(hover.userData.interactionKind).toBe('face-boundary')
    expect(hover.userData.isBodyEdgeOverlay).toBe(true)
    const hoverMaterial = (hover as THREE.LineSegments).material as THREE.Material & {
      color: THREE.Color
      linewidth: number
    }
    expect(hoverMaterial.color.getHex()).toBe(INTERACTION_HOVER_ORANGE)
    expect(hoverMaterial.linewidth).toBe(INTERACTION_EDGE_WIDTH_PX)
    expect(hoverMaterial.linewidth).toBe(4)
    expect(hoverMaterial.depthTest).toBe(true)
    expect(hoverMaterial.depthWrite).toBe(false)
    expect(hoverMaterial.userData.bodyEdgeNdcDepthBias).toBeTypeOf('number')

    expect(selected.userData.interactionKind).toBe('face-fill')
    const selectedMaterial = (selected as THREE.Mesh).material as THREE.MeshBasicMaterial
    expect(selectedMaterial.color.getHex()).toBe(INTERACTION_ORANGE)
    expect(selectedMaterial.depthTest).toBe(true)
    expect(selectedMaterial.depthWrite).toBe(false)
    expect(selectedMaterial.transparent).toBe(true)
    expect(selectedMaterial.opacity).toBeGreaterThan(0.75)
    expect(selectedMaterial.opacity).toBeLessThan(1)
    expect(selectedMaterial.polygonOffset).toBe(true)
  })

  it('renders light-orange hover and darker, wider selected edge strokes', () => {
    const hovered = createEdgeInteractionOverlay({
      polylinePositions: new Float32Array([0, 0, 0, 0.5, 0.5, 0, 1, 0, 0]),
      variant: 'hovered',
      resolution,
    })!
    const selected = createEdgeInteractionOverlay({
      polylinePositions: new Float32Array([0, 0, 0, 0.5, 0.5, 0, 1, 0, 0]),
      variant: 'selected',
      resolution,
    })!
    disposables.push(hovered, selected)
    const hoverMaterial = hovered.material as unknown as {
      color: THREE.Color
      linewidth: number
    }
    const selectedMaterial = selected.material as unknown as {
      color: THREE.Color
      depthTest: boolean
      depthWrite: boolean
      linewidth: number
      userData: Record<string, unknown>
    }
    expect(hovered.userData.interactionKind).toBe('edge-stroke')
    expect(selected.userData.interactionKind).toBe('edge-stroke')
    expect(hoverMaterial.color.getHex()).toBe(INTERACTION_HOVER_ORANGE)
    expect(selectedMaterial.color.getHex()).toBe(INTERACTION_ORANGE)
    expect(hoverMaterial.linewidth).toBe(INTERACTION_EDGE_WIDTH_PX)
    expect(selectedMaterial.linewidth).toBe(INTERACTION_SELECTED_EDGE_WIDTH_PX)
    expect(hoverMaterial.linewidth).toBe(4)
    expect(selectedMaterial.linewidth).toBe(5)
    expect(selectedMaterial.depthTest).toBe(true)
    expect(selectedMaterial.depthWrite).toBe(false)
    expect(selectedMaterial.userData.bodyEdgeNdcDepthBias).toBeTypeOf('number')
  })

  it('uses a dedicated BackSide silhouette shell with shared geometry and no internal-edge overlay', () => {
    const geometry = new THREE.BoxGeometry(2, 2, 2)
    const outline = createBodySilhouetteOverlay({ geometry, resolution })
    disposables.push(outline)
    const material = outline.material as THREE.ShaderMaterial
    expect(outline.geometry).toBe(geometry)
    expect(outline.userData.interactionKind).toBe('body-silhouette')
    expect(outline.userData.ownsInteractionGeometry).toBe(false)
    expect(material.side).toBe(THREE.BackSide)
    expect(material.depthTest).toBe(true)
    expect(material.depthWrite).toBe(false)
    expect(material.uniforms.interactionWidthPx.value).toBe(4)
    expect(material.vertexShader).toContain('interactionWidthPx')
    expect(material.vertexShader).toContain('clipping_planes_vertex')
    geometry.dispose()
  })

  it('builds Model face, edge, and whole-body selection feedback from stable IDs', () => {
    const cache = new GeometryCache()
    const fixture = makeBoxFixture()
    const body = cache.ingest('box', fixture.buffers)
    const selection = new SelectionState()
    selection.select(fixture.faceIds.posZ)
    selection.setHover(body.edgeIds[0])
    const group = createCachedBodyInteractionOverlay({
      body,
      selection,
      bodyVariant: 'selected',
      resolution,
    })!
    disposables.push(group)
    const kinds = new Set(group.children.map((child) => child.userData.interactionKind))
    expect(kinds).toEqual(new Set(['face-fill', 'edge-stroke', 'body-outline']))
    const bodyOutline = group.children.find(
      (child) => child.userData.interactionKind === 'body-outline',
    ) as THREE.LineSegments
    const outlineMaterial = bodyOutline.material as unknown as {
      color: THREE.Color
      linewidth: number
      userData: Record<string, unknown>
    }
    expect(bodyOutline.children).toHaveLength(0)
    expect(bodyOutline.userData.interactionGeometry).toBe(body.geometry)
    expect(outlineMaterial.color.getHex()).toBe(INTERACTION_ORANGE)
    expect(outlineMaterial.linewidth).toBe(SELECTED_BODY_VISUAL_CONTRACT.outlineWidthPx)
    expect(outlineMaterial.userData.bodyEdgeNdcDepthBias).toBeTypeOf('number')
    cache.disposeAll()
  })

  it('tints and restores the actual body material with one selected-body contract', () => {
    const material = new THREE.MeshStandardMaterial({
      color: 0x8ab7d1,
      opacity: 0.64,
      transparent: true,
      vertexColors: true,
    })

    const state = applySelectedBodyMaterialTint(material, INTERACTION_ORANGE)
    expect(material.color.getHex()).toBe(INTERACTION_ORANGE)
    expect(material.vertexColors).toBe(false)
    expect(material.opacity).toBe(SELECTED_BODY_VISUAL_CONTRACT.fillOpacity)
    expect(material.transparent).toBe(false)

    updateSelectedBodyMaterialTint(material, 0xff2fb0)
    expect(material.color.getHex()).toBe(0xff2fb0)

    restoreSelectedBodyMaterialTint(material, state)
    expect(material.color.getHex()).toBe(0x8ab7d1)
    expect(material.vertexColors).toBe(true)
    expect(material.opacity).toBe(0.64)
    expect(material.transparent).toBe(true)
    material.dispose()
  })

  it('routes palette overrides to each selected or hovered overlay variant', () => {
    const cache = new GeometryCache()
    const fixture = makeBoxFixture()
    const body = cache.ingest('box', fixture.buffers)
    const selection = new SelectionState()
    selection.select(fixture.faceIds.posZ)
    selection.setHover(body.edgeIds[0])
    const group = createCachedBodyInteractionOverlay({
      body,
      selection,
      bodyVariant: 'hovered',
      resolution,
      colors: { hovered: 0x123456, selected: 0xabcdef },
    })!
    disposables.push(group)

    const face = group.children.find((child) => child.userData.interactionKind === 'face-fill') as THREE.Mesh
    const edge = group.children.find((child) => child.userData.interactionKind === 'edge-stroke') as THREE.LineSegments
    const bodyOutline = group.children.find(
      (child) => child.userData.interactionKind === 'body-silhouette',
    ) as THREE.Mesh
    expect((face.material as THREE.MeshBasicMaterial).color.getHex()).toBe(0xabcdef)
    expect((edge.material as THREE.LineBasicMaterial).color.getHex()).toBe(0x123456)
    expect(
      ((bodyOutline.material as THREE.ShaderMaterial).uniforms.interactionColor.value as THREE.Color).getHex(),
    ).toBe(0x123456)
    cache.disposeAll()
  })

  it('synchronizes fat-line and silhouette resolution plus clipping across a live overlay group', () => {
    const edge = createEdgeInteractionOverlay({
      polylinePositions: new Float32Array([0, 0, 0, 1, 0, 0]),
      variant: 'hovered',
      resolution,
    })!
    const silhouetteGeometry = new THREE.BoxGeometry(1, 1, 1)
    const silhouette = createBodySilhouetteOverlay({
      geometry: silhouetteGeometry,
      resolution,
    })
    const group = new THREE.Group()
    group.add(edge, silhouette)
    disposables.push(group)

    syncInteractionResolution(group, { width: 1600, height: 900 })
    const lineResolution = (edge.material as unknown as { resolution: THREE.Vector2 }).resolution
    const silhouetteMaterial = silhouette.material as THREE.ShaderMaterial
    expect(lineResolution.toArray()).toEqual([1600, 900])
    expect(
      (silhouetteMaterial.uniforms.interactionResolution.value as THREE.Vector2).toArray(),
    ).toEqual([1600, 900])

    const planes = [new THREE.Plane(new THREE.Vector3(1, 0, 0), -2)]
    syncInteractionClipping(group, planes)
    expect((edge.material as THREE.Material).clippingPlanes).toBe(planes)
    expect(silhouetteMaterial.clippingPlanes).toBe(planes)
    silhouetteGeometry.dispose()
  })

  it.each(['shaded-edges', 'shaded-no-edges', 'unshaded', 'translucent'] as const)(
    'keeps interaction feedback available in %s while resting-edge visibility remains host-owned',
    (mode) => {
      expect(interactionOverlayVisibleForMode('face', mode)).toBe(true)
      expect(interactionOverlayVisibleForMode('edge', mode)).toBe(true)
      expect(interactionOverlayVisibleForMode('body', mode)).toBe(true)
    },
  )
})
