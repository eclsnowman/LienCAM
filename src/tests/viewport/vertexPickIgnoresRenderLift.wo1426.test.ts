// WO-1426: picking a work-origin vertex must not bake in the viewport's
// render-only anti-z-fighting lift.
//
// THE BUG (verified on main, BUG-471): CNCViewport draws every 2D loop 0.3mm
// above its true geometry plane (Z2D) to avoid z-fighting with the table.
// buildSnapCandidates, which supplies enterVertexPickMode's candidates (and
// therefore the pos/localPt a vertex-pick click callback receives verbatim —
// see SetupModal.handleStartVertexPick), read its world-space points straight
// off the RENDERED THREE.Line geometry — the same points the Z2D lift was
// baked into — so picking a vertex on an authored Z0 loop persisted a work
// origin at Z 0.3, not Z0.
//
// THE FIX: buildSnapCandidates now strips the known local Z2D lift from each
// vertex BEFORE applying the Line's matrixWorld transform (not after — a
// post-transform subtraction would be wrong under rotation, since the lift
// direction itself would need rotating too). Removing it pre-transform yields
// the true canonical point in any group orientation.
//
// Harness shape mirrors WO-350/UI-75's own CNCViewport tests: a real
// CNCViewport instance built via Object.create (no WebGL needed — nothing
// here renders a frame), driving the real production add2DGeometry /
// setPartProjectedLoops / enterVertexPickMode / buildSnapCandidates — never a
// hand-built payload. The click-resolution step downstream of the candidate
// list (nearest-under-cursor selection in the private handleClick field) is
// pre-existing, unowned by this WO, and untouched by the fix; what's asserted
// here is exactly what that step reads verbatim and forwards to the caller.

import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { CNCViewport } from '../../lib/viewport/CNCViewport'
import type { Layer2D, Loop2D } from '../../types'

const Z2D = 0.3 // CNCViewport.Z2D, mirrored (private) - same convention as WO-340/341/350's tests

interface VertexPickHarness {
  enterVertexPickMode: CNCViewport['enterVertexPickMode']
  add2DGeometry: CNCViewport['add2DGeometry']
  setPartProjectedLoops: CNCViewport['setPartProjectedLoops']
  partGroups: Map<string, THREE.Group>
  scene: THREE.Group
  snapCandidates: Array<{ worldPos: THREE.Vector3; localPos: THREE.Vector3; geoId: string; type: string }>
}
function priv(viewport: CNCViewport): VertexPickHarness {
  return viewport as unknown as VertexPickHarness
}

function makeFixture(): CNCViewport {
  const viewport = Object.create(CNCViewport.prototype) as CNCViewport
  const scene = new THREE.Group()
  const workpieceGroup = new THREE.Group()
  scene.add(workpieceGroup)
  Object.assign(viewport, {
    scene,
    workpieceGroup,
    partGroups: new Map<string, THREE.Group>(),
    projectedLoopGroups: new Map<string, THREE.Group>(),
    geometry2dGroups: new Map<string, THREE.Group>(),
    geometry2dLayerMats: new Map(),
    layer2dRequestedVisible: new Map(),
    sketchEditLayerId: null,
    selectedPartId: null,
    snapCandidates: [],
    snapCloud: null,
    snapHoveredIdx: -1,
    vertexPickCallback: null,
    updateSelectableObjects: () => undefined,
    maybeAutoFit: () => undefined,
    rebuildStock: () => undefined,
    renderer: {
      domElement: {
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      },
    },
  })
  return viewport
}

/** Drive the real production candidate-build pass (enterVertexPickMode ->
 *  buildSnapCandidates) and return the candidate nearest a known WORLD-XY
 *  corner — the authored, ground-truth point, never the rendered/lifted one. */
function candidateAt(viewport: CNCViewport, corner: { x: number; y: number }) {
  viewport.enterVertexPickMode(() => undefined)
  const candidates = priv(viewport).snapCandidates
  expect(candidates.length).toBeGreaterThan(0)
  let best = candidates[0]
  let bestD = Infinity
  for (const c of candidates) {
    const d = Math.hypot(c.worldPos.x - corner.x, c.worldPos.y - corner.y)
    if (d < bestD) { bestD = d; best = c }
  }
  expect(bestD).toBeLessThan(0.01) // sanity: this really is the clicked corner, not a neighbour
  return best
}

const layer: Layer2D = { id: 'layer-1', name: 'Layer', color: '#00e5ff', visible: true }

function squareLoop(id: string, x0: number, y0: number, x1: number, y1: number): Loop2D {
  return {
    id, layerId: layer.id, type: 'contour', closed: true,
    area: (x1 - x0) * (y1 - y0),
    points: [
      { x: x0, y: y0 }, { x: x1, y: y0 },
      { x: x1, y: y1 }, { x: x0, y: y1 },
    ],
  }
}

describe('WO-1426: vertex pick ignores the render-only Z2D lift', () => {
  it('an imported planar Z0 loop picks Z0 at a known corner, not the 0.3 render lift', () => {
    const vp = makeFixture()
    vp.add2DGeometry('flat-part', [squareLoop('sq', 0, 0, 10, 10)], [layer], { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 })

    const sc = candidateAt(vp, { x: 10, y: 0 })

    // Acceptance 1: persisted Z is 0, not Z2D (0.3).
    expect(sc.worldPos.z).toBeCloseTo(0, 6)
    expect(sc.worldPos.z).not.toBeCloseTo(Z2D, 6)
    expect(sc.localPos.z).toBeCloseTo(0, 6)
    // Acceptance 2: XY still matches the clicked corner exactly.
    expect(sc.worldPos.x).toBeCloseTo(10, 6)
    expect(sc.worldPos.y).toBeCloseTo(0, 6)
  })

  it('a loop authored at a nonzero Z (typed / gizmo-placed) still picks that real Z, not Z0 and not Z-plus-lift', () => {
    const vp = makeFixture()
    vp.add2DGeometry('raised-part', [squareLoop('sq', 0, 0, 10, 10)], [layer], { x: 0, y: 0, z: 7 }, { x: 0, y: 0, z: 0 })

    const sc = candidateAt(vp, { x: 10, y: 0 })

    expect(sc.worldPos.z).toBeCloseTo(7, 6)
    expect(sc.worldPos.z).not.toBeCloseTo(0, 6)
    expect(sc.worldPos.z).not.toBeCloseTo(7 + Z2D, 6)
    expect(sc.localPos.z).toBeCloseTo(0, 6) // local to the group, which itself sits at world Z7
  })

  it('an STL edge-chain projected loop (its own analogous chainZ + Z2D display lift) still picks its real chain height', () => {
    const vp = makeFixture()
    const partGroup = new THREE.Group()
    partGroup.name = 'stl-part'
    priv(vp).scene.add(partGroup)
    priv(vp).partGroups.set('stl-part', partGroup)

    // meshContourLoops stamps the chain's real local-frame height into its
    // name (WO-340 convention); setPartProjectedLoops reads it via
    // chainZFromName and draws at `chainZ + Z2D`.
    const chainLoop: Loop2D = {
      id: 'chain-1', name: 'STL edge chain 1 (Z 4)', layerId: 'stl-edge-chains',
      type: 'contour', closed: true, area: 100,
      points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
    }
    vp.setPartProjectedLoops('stl-part', [chainLoop], [{ id: 'stl-edge-chains', color: '#58a6ff', visible: true }])

    const sc = candidateAt(vp, { x: 10, y: 0 })

    expect(sc.worldPos.z).toBeCloseTo(4, 6)
    expect(sc.worldPos.z).not.toBeCloseTo(4 + Z2D, 6)
  })
})
