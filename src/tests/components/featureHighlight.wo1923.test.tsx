import * as THREE from 'three'
import { describe, expect, it, vi } from 'vitest'
import { CNCViewport } from '../../lib/viewport/CNCViewport'

vi.stubGlobal('window', {
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
})

// Four-triangle non-indexed STL-style mesh, as STLLoader produces.
function makeViewport() {
  const vp = Object.create(CNCViewport.prototype) as CNCViewport
  const positions: number[] = []
  for (let t = 0; t < 4; t++) {
    const x = t * 10
    positions.push(x, 0, 0, x + 5, 0, 0, x, 5, 0)
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3))
  const material = new THREE.MeshStandardMaterial()
  const mesh = new THREE.Mesh(geometry, material)
  mesh.userData.isBodyPresentationMesh = true
  const edges = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial())
  edges.userData.isDisplayEdge = true
  mesh.add(edges)
  const group = new THREE.Group()
  group.add(mesh)
  Object.assign(vp, {
    partGroups: new Map([['geo-a', group]]),
    partMaterials: new Map([['geo-a', material]]),
    renderer: { getDrawingBufferSize: (v: THREE.Vector2) => v.set(100, 100) },
    currentShadingMode: 'shaded',
    partPickSelectedIds: new Set<string>(),
    partPickHoverId: null,
    selectedPartId: null,
    selectionGlow: 'signature',
    viewportThemeId: 'classic',
  })
  return { vp, mesh }
}

const overlays = (mesh: THREE.Mesh) => mesh.children.filter((c) => c.userData.isDisplayEdge !== true)
const litTriangles = (o: THREE.Object3D) =>
  ((o as THREE.Mesh).geometry.getAttribute('position').count) / 3

describe('WO-1923 setHighlightedFacets on the real CNCViewport', () => {
  it('lights exactly the named facets and clears on null', () => {
    const { vp, mesh } = makeViewport()
    expect(overlays(mesh)).toHaveLength(0)
    vp.setHighlightedFacets('geo-a', [1, 3])
    const lit = overlays(mesh)
    expect(lit).toHaveLength(1)
    expect(litTriangles(lit[0])).toBe(2)
    const pos = (lit[0] as THREE.Mesh).geometry.getAttribute('position')
    expect(pos.getX(0)).toBe(10) // facet 1 starts at x=10
    expect(pos.getX(3)).toBe(30) // facet 3 starts at x=30
    vp.setHighlightedFacets('geo-a', null)
    expect(overlays(mesh)).toHaveLength(0)
  })

  it('replaces rather than stacks on repeated calls', () => {
    const { vp, mesh } = makeViewport()
    vp.setHighlightedFacets('geo-a', [0])
    vp.setHighlightedFacets('geo-a', [2])
    expect(overlays(mesh)).toHaveLength(1)
    expect(litTriangles(overlays(mesh)[0])).toBe(1)
  })

  it('out-of-range ids, empty lists and unknown parts highlight nothing and do not throw', () => {
    const { vp, mesh } = makeViewport()
    expect(() => vp.setHighlightedFacets('geo-a', [99, -1, 1.5])).not.toThrow()
    expect(overlays(mesh)).toHaveLength(0)
    expect(() => vp.setHighlightedFacets('geo-a', [])).not.toThrow()
    expect(() => vp.setHighlightedFacets('nope', [0])).not.toThrow()
    vp.setHighlightedFacets('geo-a', [99, 2])
    expect(litTriangles(overlays(mesh)[0])).toBe(1)
  })
})
