import * as THREE from 'three'
import { describe, expect, it, vi } from 'vitest'
import { Line2 } from 'three/examples/jsm/lines/Line2.js'
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js'
import { CNCViewport } from '../../lib/viewport/CNCViewport'
import {
  INTERACTION_EDGE_WIDTH_PX,
  INTERACTION_SELECTED_EDGE_WIDTH_PX,
} from '../../viewport3d/interactionPresentation'
import {
  SELECTION_ORANGE_HOVER,
  SELECTION_ORANGE_SELECTED,
} from '../../lib/viewport/lighting/selectionGlowTokens'

// WO-341: "make sure you can see it when hovered. It is still barely visible,
// not like with our other edge selection tools." The benchmark he named is
// the BREP/model edge hover-and-pick overlay (buildBrepHighlight ->
// createEdgeInteractionOverlay): a fat screen-space stroke, 4px hover / 5px
// selected (INTERACTION_EDGE_WIDTH_PX / INTERACTION_SELECTED_EDGE_WIDTH_PX),
// colored from the shared selection-glow tokens. This proves the STL chain
// (a loop-pick THREE.Line, same code path as setPartProjectedLoops) now grows
// the SAME overlay, at the SAME measured widths and SAME token colors,
// instead of the old 1px recolor-only treatment WO-318 left in place.

vi.stubGlobal('window', {
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
})

interface Harness {
  loopPickHoverId: string | null
  pickedLoopIds: Set<string>
  resolveLoopPickAtCurrentRay: () => string | null
  updateLoopPickHover: (event: MouseEvent) => void
  loopHighlightOverlays: Map<THREE.Line, THREE.Object3D>
}

function priv(vp: CNCViewport): Harness {
  return vp as unknown as Harness
}

/** A single mesh-edge chain line, same shape setPartProjectedLoops builds:
 *  a plain THREE.Line with its own local-space points and an origColor tag. */
function chainLine(id: string): THREE.Line {
  const points = [
    new THREE.Vector3(-5, -5, 2),
    new THREE.Vector3(5, -5, 2),
    new THREE.Vector3(5, 5, 2),
    new THREE.Vector3(-5, 5, 2),
    new THREE.Vector3(-5, -5, 2),
  ]
  const material = new THREE.LineBasicMaterial({ color: 0x58a6ff })
  material.userData.origColor = 0x58a6ff
  const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), material)
  line.name = id
  return line
}

function makeHarness() {
  const vp = Object.create(CNCViewport.prototype) as CNCViewport
  const line = chainLine('mec:stl-chain-1')
  const projGroup = new THREE.Group()
  projGroup.name = '__proj__'
  projGroup.add(line)
  projGroup.updateMatrixWorld(true)

  const domElement = {
    style: { cursor: '' },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }
  const camera = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 100)
  camera.position.set(0, 0, 10)
  camera.lookAt(0, 0, 0)
  camera.updateMatrixWorld(true)
  camera.updateProjectionMatrix()

  Object.assign(vp, {
    renderer: { domElement },
    camera,
    mouse: new THREE.Vector2(),
    raycaster: new THREE.Raycaster(),
    selectableObjects: [line],
    geometry2dGroups: new Map<string, THREE.Group>(),
    projectedLoopGroups: new Map<string, THREE.Group>([['part-1', projGroup]]),
    _worldPlaneLoopGroups: new Map<string, THREE.Group>(),
    _geoLocalLoopGroups: new Map<string, THREE.Group>(),
    nestGroups: new Map<string, THREE.Group>(),
    loopPickCallback: vi.fn(),
    loopPickAllowedGeoId: null,
    loopPickHoverId: null,
    pickedLoopIds: new Set<string>(),
    selectionGlow: 'signature',
    viewportThemeId: 'classic',
  })

  return { vp, h: priv(vp), line }
}

function moveEvent(): MouseEvent {
  return { clientX: 50, clientY: 50 } as MouseEvent
}

describe('WO-341 STL chain hover/select visibility matches the BREP edge benchmark', () => {
  it('grows no overlay while resting', () => {
    const { line } = makeHarness()
    expect(line.children.length).toBe(0)
  })

  it('hover adds a fat overlay at the BREP hover width and shared hover color', () => {
    const { h, line } = makeHarness()
    h.resolveLoopPickAtCurrentRay = () => 'mec:stl-chain-1'
    h.updateLoopPickHover(moveEvent())

    expect(line.children.length).toBe(1)
    const overlay = line.children[0] as Line2
    expect(overlay).toBeInstanceOf(Line2)
    const mat = overlay.material as LineMaterial
    expect(mat).toBeInstanceOf(LineMaterial)
    expect(mat.linewidth).toBe(INTERACTION_EDGE_WIDTH_PX)
    expect(mat.color.getHex()).toBe(SELECTION_ORANGE_HOVER)
    expect(mat.depthTest).toBe(false) // WO-318 bypass preserved, not re-litigated
    // Base thin line stays recolored exactly as before (existing regression
    // tests read this value directly) -- the fat stroke is additive.
    expect((line.material as THREE.LineBasicMaterial).color.getHex()).toBe(SELECTION_ORANGE_HOVER)
  })

  it('picking grows a wider overlay than hover, in a measurably different color', () => {
    const { vp, h, line } = makeHarness()
    vp.setPickedLoops(['mec:stl-chain-1'])

    expect(line.children.length).toBe(1)
    const overlay = line.children[0] as Line2
    const mat = overlay.material as LineMaterial
    expect(mat.linewidth).toBe(INTERACTION_SELECTED_EDGE_WIDTH_PX)
    expect(mat.color.getHex()).toBe(SELECTION_ORANGE_SELECTED)

    // Section 13: hover and selected must read as visibly different -- both
    // in width and in color, not color alone (the WO's own flagged risk).
    expect(INTERACTION_SELECTED_EDGE_WIDTH_PX).toBeGreaterThan(INTERACTION_EDGE_WIDTH_PX)
    expect(SELECTION_ORANGE_SELECTED).not.toBe(SELECTION_ORANGE_HOVER)

    h.resolveLoopPickAtCurrentRay = () => 'mec:stl-chain-1'
    h.updateLoopPickHover(moveEvent())
    const hoveredWhilePicked = line.children[0] as Line2
    const hoveredMat = hoveredWhilePicked.material as LineMaterial
    // Picked wins over hover for the SAME loop -- matches the pre-existing
    // colorLine precedence (picked ? ... : hovered ? ... : orig).
    expect(hoveredMat.linewidth).toBe(INTERACTION_SELECTED_EDGE_WIDTH_PX)
    expect(hoveredMat.color.getHex()).toBe(SELECTION_ORANGE_SELECTED)
  })

  it('clears the overlay when hover moves off the chain', () => {
    const { h, line } = makeHarness()
    h.resolveLoopPickAtCurrentRay = () => 'mec:stl-chain-1'
    h.updateLoopPickHover(moveEvent())
    expect(line.children.length).toBe(1)

    h.resolveLoopPickAtCurrentRay = () => null
    h.updateLoopPickHover(moveEvent())
    expect(line.children.length).toBe(0)
    expect(h.loopHighlightOverlays.size).toBe(0)
  })
})
