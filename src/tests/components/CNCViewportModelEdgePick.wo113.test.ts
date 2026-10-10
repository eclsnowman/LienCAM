import * as THREE from 'three'
import { describe, expect, it, vi } from 'vitest'
import { CNCViewport } from '../../components/viewport/CNCViewport'
import type { ModelBodyDisplay } from '../../types'

vi.stubGlobal('window', {
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
})

interface PickHarness {
  partGroups: Map<string, THREE.Group>
  raycaster: THREE.Raycaster
  brepPickKind: 'face' | 'edge' | 'face-or-edge' | null
  collectBrepObjects: (allowedGeoId: string | null) => {
    meshes: THREE.Mesh[]
    edgeLines: THREE.LineSegments[]
  }
  resolveBrepHit: () => {
    geoId: string
    kind: 'face' | 'edge'
    index: number
  } | null
  handleBrepPickClick: () => void
}

function priv(viewport: CNCViewport): PickHarness {
  return viewport as unknown as PickHarness
}

function makeHarness(): CNCViewport {
  const viewport = Object.create(CNCViewport.prototype) as CNCViewport
  const camera = new THREE.OrthographicCamera(-50, 50, 50, -50, 0.1, 1000)
  camera.updateProjectionMatrix()
  Object.assign(viewport, {
    partGroups: new Map<string, THREE.Group>(),
    partMaterials: new Map<string, THREE.MeshStandardMaterial>(),
    workpieceGroup: new THREE.Group(),
    stockGroup: new THREE.Group(),
    colors: { workpiece: 0x8ab4cc, workpieceEdge: 0xbfd8ec },
    materialBaselines: new Map<THREE.MeshStandardMaterial, unknown>(),
    currentShadingMode: 'shaded-edges',
    updateSelectableObjects: () => undefined,
    maybeAutoFit: () => undefined,
    rebuildStock: () => undefined,
    viewportThemeId: 'classic',
    selectionGlow: 'current' as const,
    partPickSelectedIds: new Set<string>(),
    partPickHoverId: null,
    partUsesThemeColor: new Map<string, boolean>(),
    partEdgePositions: new Map<string, Float32Array>(),
    renderer: {
      domElement: {
        getBoundingClientRect: () => ({ width: 800, height: 600 }),
        clientHeight: 500,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      },
      getPixelRatio: () => 1,
      getDrawingBufferSize: (target: THREE.Vector2) => target.set(800, 600),
    },
    camera,
    raycaster: new THREE.Raycaster(),
    brepPickKind: 'edge' as const,
    brepPickAllowedGeoId: null,
    pickedBrepKeys: new Set<string>(),
    brepHighlights: new Map<string, THREE.Object3D>(),
    brepHoverKey: null,
    brepHoverObj: null,
    _geoLocalLoopGroups: new Map<string, THREE.Group>(),
  })
  return viewport
}

const EDGES = {
  front: [[-20, -15, 10], [20, -15, 10]],
  right: [[20, -15, 10], [20, 15, 10]],
  back: [[20, 15, 10], [-20, 15, 10]],
  left: [[-20, 15, 10], [-20, -15, 10]],
} as const

type EdgeName = keyof typeof EDGES

function displayWithEdges(order: EdgeName[]): ModelBodyDisplay {
  const bottom = [-20, -15, 0, 20, -15, 0, 20, 15, 0, -20, 15, 0]
  const top = [-20, -15, 10, 20, -15, 10, 20, 15, 10, -20, 15, 10]
  const edgePositions: number[] = []
  const edgeOffsets = [0]
  for (const edgeName of order) {
    const [a, b] = EDGES[edgeName]
    edgePositions.push(...a, ...b)
    edgeOffsets.push(edgePositions.length / 3)
  }
  return {
    positions: [...bottom, ...top],
    normals: new Array(24).fill(0),
    indices: [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7],
    edgePositions,
    edgeOffsets,
    edgeIds: order.map((name) => `stable-${name}`),
    bbox: { min: [-20, -15, 0], max: [20, 15, 10] },
    faceIds: ['stable-bottom', 'stable-top'],
    triFace: [0, 0, 1, 1],
  }
}

function raycastFrontEdge(viewport: CNCViewport) {
  priv(viewport).raycaster.ray.set(
    new THREE.Vector3(0, -15, 50),
    new THREE.Vector3(0, 0, -1),
  )
  return priv(viewport).resolveBrepHit()
}

function displayWithFaceAndEdge(closed: boolean): ModelBodyDisplay {
  const edge = closed
    ? [
        5, 0, 0,
        0, 5, 0,
        -5, 0, 0,
        0, -5, 0,
        5, 0, 0,
      ]
    : [
        0, -5, 0,
        0, 5, 0,
      ]
  return {
    positions: [-10, -10, 0, 10, -10, 0, 10, 10, 0, -10, 10, 0],
    normals: new Array(12).fill(0),
    indices: [0, 1, 2, 0, 2, 3],
    edgePositions: edge,
    edgeOffsets: [0, edge.length / 3],
    edgeIds: [closed ? 'stable-rim' : 'stable-seam'],
    bbox: { min: [-10, -10, 0], max: [10, 10, 0] },
    faceIds: ['stable-cylinder-wall'],
    triFace: [0, 0],
  }
}

describe('WO-113: production CNCViewport modeled-body edge picking', () => {
  it('contributes a real edge-pick object and resolves an edge raycast', () => {
    const viewport = makeHarness()
    const display = displayWithEdges(['front', 'right', 'back', 'left'])
    viewport.addModelBody('model:g1', display, 'Box')

    expect(viewport.supportsModelEdgePick()).toBe(true)
    const { meshes, edgeLines } = priv(viewport).collectBrepObjects(null)
    expect(meshes).toHaveLength(1)
    expect(edgeLines).toHaveLength(1)
    expect(edgeLines[0].userData.isModelEdges).toBe(true)
    expect(edgeLines[0].geometry.userData.edgeIds).toEqual(display.edgeIds)

    const hit = raycastFrontEdge(viewport)
    expect(hit).not.toBeNull()
    expect(hit).toMatchObject({ geoId: 'model:g1', kind: 'edge', index: 0 })
  })

  it('reports the real raycast callback as a modeled-body edge hit', () => {
    const viewport = makeHarness()
    viewport.addModelBody(
      'model:g-callback',
      displayWithEdges(['front', 'right', 'back', 'left']),
      'Box',
    )
    const callback = vi.fn()
    viewport.setBrepPickMode('edge', callback, 'model:g-callback')

    priv(viewport).raycaster.ray.set(
      new THREE.Vector3(0, -15, 50),
      new THREE.Vector3(0, 0, -1),
    )
    priv(viewport).handleBrepPickClick()

    expect(callback).toHaveBeenCalledWith(
      { geoId: 'model:g-callback', kind: 'edge', index: 0, isModelEdge: true },
      true,
    )
  })

  it('does not invent positional identity for a legacy body without edge ids', () => {
    const viewport = makeHarness()
    const display = displayWithEdges(['front', 'right', 'back', 'left'])
    delete display.edgeIds
    viewport.addModelBody('model:legacy', display, 'Legacy box')

    expect(priv(viewport).collectBrepObjects('model:legacy').edgeLines).toHaveLength(0)
    expect(raycastFrontEdge(viewport)).toBeNull()
  })

  it('carries durable edge identity when a rebuild reorders the edge table', () => {
    const viewport = makeHarness()
    viewport.addModelBody(
      'model:g2',
      displayWithEdges(['front', 'right', 'back', 'left']),
      'Box',
    )
    expect(raycastFrontEdge(viewport)?.index).toBe(0)

    viewport.addModelBody(
      'model:g2',
      displayWithEdges(['back', 'front', 'right', 'left']),
      'Box',
    )
    const { edgeLines } = priv(viewport).collectBrepObjects('model:g2')
    const hit = raycastFrontEdge(viewport)
    expect(hit?.index).toBe(1)
    expect(edgeLines[0].geometry.userData.edgeIds[hit!.index]).toBe('stable-front')
  })

  it('lets an open cylinder seam yield to the face in combined setup-origin picking', () => {
    const viewport = makeHarness()
    viewport.addModelBody('model:cylinder-side', displayWithFaceAndEdge(false), 'Cylinder side')
    viewport.setBrepPickMode('face-or-edge', () => undefined, 'model:cylinder-side')

    priv(viewport).raycaster.ray.set(
      new THREE.Vector3(0, 0, 50),
      new THREE.Vector3(0, 0, -1),
    )

    expect(priv(viewport).resolveBrepHit()).toMatchObject({
      geoId: 'model:cylinder-side',
      kind: 'face',
      index: 0,
    })
  })

  it('keeps a closed rim as the direct edge choice in combined setup-origin picking', () => {
    const viewport = makeHarness()
    viewport.addModelBody('model:circular-rim', displayWithFaceAndEdge(true), 'Circular rim')
    viewport.setBrepPickMode('face-or-edge', () => undefined, 'model:circular-rim')

    priv(viewport).raycaster.ray.set(
      new THREE.Vector3(5, 0, 50),
      new THREE.Vector3(0, 0, -1),
    )

    expect(priv(viewport).resolveBrepHit()).toMatchObject({
      geoId: 'model:circular-rim',
      kind: 'edge',
      index: 0,
    })
  })
})
