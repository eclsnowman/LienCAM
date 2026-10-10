import * as THREE from 'three'
import { describe, expect, it, vi } from 'vitest'
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js'
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js'
import {
  createBodyPresentationPair,
  disposeBodyPresentation,
  setBodyPresentationVisible,
  syncBodyEdgeOverlayColors,
  syncBodyEdgeOverlayGeometry,
  syncBodyEdgeOverlayGeometryForVisibility,
} from '../../viewport3d/bodyPresentation'

function edges(offset = 0, color = 0.25): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute([offset, 0, 0, offset + 1, 0, 0], 3),
  )
  geometry.setAttribute(
    'color',
    new THREE.Float32BufferAttribute([color, color, color, color, color, color], 3),
  )
  return geometry
}

describe('shared body presentation', () => {
  it('constructs classic and fat true-edge overlays from the same contract', () => {
    const classic = createBodyPresentationPair(
      new THREE.BufferGeometry(),
      new THREE.MeshBasicMaterial(),
      edges(),
      { fat: false, color: '#123456', vertexColors: true },
    )
    expect(classic.edgeLines).toBeInstanceOf(THREE.LineSegments)

    const fat = createBodyPresentationPair(
      new THREE.BufferGeometry(),
      new THREE.MeshBasicMaterial(),
      edges(),
      {
        fat: true,
        color: '#123456',
        vertexColors: true,
        linewidthPx: 2.5,
        resolution: { width: 800, height: 600 },
      },
    )
    expect(fat.edgeLines).toBeInstanceOf(LineSegments2)
    expect(fat.edgeLines.material).toBeInstanceOf(LineMaterial)
    expect((fat.edgeLines.material as unknown as LineMaterial).resolution.toArray()).toEqual([800, 600])
  })

  it('synchronizes fat positions/colors and toggles the mesh and edges together', () => {
    const presentation = createBodyPresentationPair(
      new THREE.BufferGeometry(),
      new THREE.MeshBasicMaterial(),
      edges(),
      { fat: true, color: '#fff', vertexColors: true },
    )
    const next = edges(4, 0.75)
    syncBodyEdgeOverlayGeometry(presentation.edgeLines, next)
    syncBodyEdgeOverlayColors(presentation.edgeLines, next)
    setBodyPresentationVisible(presentation, false)
    expect(presentation.mesh.visible).toBe(false)
    expect(presentation.edgeLines.visible).toBe(false)
    syncBodyEdgeOverlayGeometryForVisibility(presentation.edgeLines, next, 'hidden:e1')
    const geometry = presentation.edgeLines.geometry as unknown as { setPositions: (values: number[]) => void }
    const setPositions = vi.spyOn(geometry, 'setPositions')
    syncBodyEdgeOverlayGeometryForVisibility(presentation.edgeLines, next, 'hidden:e1')
    expect(setPositions).not.toHaveBeenCalled()
    syncBodyEdgeOverlayGeometryForVisibility(presentation.edgeLines, next, 'hidden:e2')
    expect(setPositions).toHaveBeenCalledOnce()
  })

  it('preserves host tone mapping and explicit classic geometry ownership', () => {
    const edgeGeometry = edges()
    const presentation = createBodyPresentationPair(
      new THREE.BufferGeometry(),
      new THREE.MeshBasicMaterial(),
      edgeGeometry,
      { fat: false, color: '#fff', toneMapped: true, ownsGeometry: true },
    )
    expect((presentation.edgeLines.material as THREE.LineBasicMaterial).toneMapped).toBe(true)
    const dispose = vi.spyOn(edgeGeometry, 'dispose')
    disposeBodyPresentation(presentation)
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('disposes host-selected resources exactly once', () => {
    const meshGeometry = new THREE.BufferGeometry()
    const edgeGeometry = edges()
    const meshMaterial = new THREE.MeshBasicMaterial()
    const presentation = createBodyPresentationPair(
      meshGeometry,
      meshMaterial,
      edgeGeometry,
      { fat: false, color: '#fff' },
    )
    const meshGeometryDispose = vi.spyOn(meshGeometry, 'dispose')
    const edgeGeometryDispose = vi.spyOn(edgeGeometry, 'dispose')
    const meshMaterialDispose = vi.spyOn(meshMaterial, 'dispose')
    const edgeMaterialDispose = vi.spyOn(presentation.edgeLines.material as THREE.Material, 'dispose')
    disposeBodyPresentation(presentation, { disposeMeshGeometry: true })
    expect(meshGeometryDispose).toHaveBeenCalledOnce()
    // Classic Model overlays alias GeometryCache.edgeGeometry; the cache,
    // not the presentation, owns and eventually disposes that buffer.
    expect(edgeGeometryDispose).not.toHaveBeenCalled()
    expect(meshMaterialDispose).not.toHaveBeenCalled()
    expect(edgeMaterialDispose).not.toHaveBeenCalled()
    disposeBodyPresentation(presentation, {
      disposeMeshMaterial: true,
      disposeEdgeMaterial: true,
    })
    expect(meshMaterialDispose).toHaveBeenCalledOnce()
    expect(edgeMaterialDispose).toHaveBeenCalledOnce()
  })
})
