// @vitest-environment jsdom

// WO-340: "I only seem to be able to select edges projected to the floor...
// not where they live in situ on the mesh." Operator's screenshot listed chains
// as "STL edge chain 19 (Z 0.5)", "20 (Z 3.5)", "21 (Z 0)", "22 (Z 4)" - each
// one knows its own height - but CNCViewport.setPartProjectedLoops drew every
// chain flat at the shared Z2D plane (CNCViewport.ts, pre-fix), so a chain
// not near that plane rendered nowhere close to where the mesh actually put
// it, and two chains at different real heights (a hole's top and bottom rim,
// same XY) landed exactly coincident - the same "twin" bug WO-257's
// render-order hack had to manage rather than cure.
//
// The fix (this WO, CNCViewport.ts only - owned-paths excludes store/index.ts
// and types/index.ts) reads each chain's real local-frame height out of its
// display name ("...(Z <local Z>)", already stamped by meshContourLoops) -
// the only per-chain Z this file's owned scope can reach without widening
// Loop2D itself. A loop with no such suffix (2D DXF/SVG geometry, genuinely
// planar, or the rare user-renamed chain) falls through to the original flat
// Z2D behaviour untouched - see the WO-340 result log for that trade-off.

import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { CNCViewport } from '../../lib/viewport/CNCViewport'

interface HoverHarness {
  loopPickHoverId: string | null
  updateLoopPickHover: (event: MouseEvent) => void
}
function priv(viewport: CNCViewport): HoverHarness {
  return viewport as unknown as HoverHarness
}

const CANVAS_W = 800
const CANVAS_H = 600
const GEO_ID = 'wo340-part'
const CHAIN_LAYER = 'stl-edge-chains'
const Z2D = 0.3 // CNCViewport.Z2D - mirrored here (private), not re-derived from it

/** Same prototype-built, no-WebGL harness shape as WO-257/WO-318: every
 *  method under test is production's, not a re-implementation. The camera is
 *  ISOMETRIC/oblique (not top-down) on purpose - a top-down ortho ray at a
 *  given (x,y) passes through every Z at that column, so it cannot tell a
 *  flattened chain from one drawn at its true height. An oblique view is
 *  what actually makes screen position depend on Z, the way Operator's own
 *  orbited 3D view does when he aims at an edge. */
function makeFixture(): {
  viewport: CNCViewport
  partGroup: THREE.Group
  camera: THREE.OrthographicCamera
  lineFor: (loopId: string) => THREE.Line
} {
  const viewport = Object.create(CNCViewport.prototype) as CNCViewport
  const camera = new THREE.OrthographicCamera(-50, 50, 50, -50, 0.1, 1000)
  // Same direction/up convention as CNCViewport's own default camera
  // (position (500,-400,350), up (0,0,1)), scaled to this fixture's mm range.
  camera.position.set(50, -40, 35)
  camera.up.set(0, 0, 1)
  camera.lookAt(0, 0, 0)
  camera.updateMatrixWorld(true)
  camera.updateProjectionMatrix()

  const domStyle = { cursor: '' }
  const scene = new THREE.Group()
  Object.assign(viewport, {
    scene,
    partGroups: new Map<string, THREE.Group>(),
    projectedLoopGroups: new Map<string, THREE.Group>(),
    geometry2dGroups: new Map<string, THREE.Group>(),
    _worldPlaneLoopGroups: new Map<string, THREE.Group>(),
    _geoLocalLoopGroups: new Map<string, THREE.Group>(),
    nestGroups: new Map<string, THREE.Group>(),
    fixedStockBoxes: new Map<string, THREE.Group>(),
    selectableObjects: [] as THREE.Object3D[],
    camera,
    raycaster: new THREE.Raycaster(),
    mouse: new THREE.Vector2(),
    viewportThemeId: 'classic',
    selectionGlow: 'current' as const,
    loopPickCallback: null,
    loopPickAllowedGeoId: null,
    pickedLoopIds: new Set<string>(),
    loopPickHoverId: null,
    handleLoopPickHoverMove: () => undefined,
    renderer: {
      domElement: {
        style: domStyle,
        getBoundingClientRect: () => ({ left: 0, top: 0, width: CANVAS_W, height: CANVAS_H }),
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      },
    },
  })

  const partGroup = new THREE.Group()
  partGroup.name = GEO_ID
  scene.add(partGroup)
  ;(viewport as unknown as { partGroups: Map<string, THREE.Group> }).partGroups.set(GEO_ID, partGroup)

  // The opaque body Operator actually sees: 40x40 in XY, 0..4 in Z, bottom face at
  // local Z=0 - same recenter convention addSTL uses, and what
  // setPartProjectedLoops' own minZ scan reads.
  const bodyGeometry = new THREE.BoxGeometry(40, 40, 4)
  bodyGeometry.translate(0, 0, 2)
  const body = new THREE.Mesh(bodyGeometry, new THREE.MeshBasicMaterial({ color: 0x888888 }))
  body.name = 'body'
  partGroup.add(body)

  const lineFor = (loopId: string): THREE.Line => {
    let found: THREE.Line | null = null
    partGroup.traverse((child) => {
      if (child instanceof THREE.Line && child.name === loopId) found = child
    })
    if (!found) throw new Error(`no rendered loop line named "${loopId}"`)
    return found
  }

  return { viewport, partGroup, camera, lineFor }
}

/** Invert updateLoopPickHover's own clientX/Y -> NDC math exactly, so the
 *  built event aims the ray precisely at a given WORLD point. */
function hoverEventAt(camera: THREE.Camera, point: THREE.Vector3): MouseEvent {
  const ndc = point.clone().project(camera)
  return {
    clientX: ((ndc.x + 1) / 2) * CANVAS_W,
    clientY: ((1 - ndc.y) / 2) * CANVAS_H,
  } as unknown as MouseEvent
}

function square(cx: number, cy: number, half: number): Array<{ x: number; y: number }> {
  return [
    { x: cx - half, y: cy - half },
    { x: cx + half, y: cy - half },
    { x: cx + half, y: cy + half },
    { x: cx - half, y: cy + half },
  ]
}

describe('WO-340: STL edge chains render at their own height, not flattened to one plane', () => {
  it('draws two chains carrying different Z-suffixed names at those measurably different world heights', () => {
    const fixture = makeFixture()
    fixture.viewport.setPartProjectedLoops(
      GEO_ID,
      [
        { id: 'mec:c19', name: 'STL edge chain 19 (Z 0.5)', points: square(-15, 0, 4), closed: true, layerId: CHAIN_LAYER },
        { id: 'mec:c20', name: 'STL edge chain 20 (Z 3.5)', points: square(15, 0, 4), closed: true, layerId: CHAIN_LAYER },
      ],
      [{ id: CHAIN_LAYER, color: '#58a6ff', visible: true }],
    )

    const zOf = (loopId: string) => new THREE.Box3().setFromObject(fixture.lineFor(loopId)).min.z
    const z19 = zOf('mec:c19')
    const z20 = zOf('mec:c20')

    // Measured world positions, not "by eye": each chain sits at minZ(0) +
    // its own real Z + the small anti-z-fighting bump, not a shared plane.
    expect(z19).toBeCloseTo(0.5 + Z2D, 6)
    expect(z20).toBeCloseTo(3.5 + Z2D, 6)
    expect(z20 - z19).toBeCloseTo(3, 6)
  })

  it('a loop with no Z-suffixed name keeps the original flat Z2D height untouched (the genuinely-planar 2D geometry path)', () => {
    const fixture = makeFixture()
    fixture.viewport.setPartProjectedLoops(
      GEO_ID,
      [{ id: 'dxf-loop-1', points: square(0, 0, 4), closed: true, layerId: CHAIN_LAYER }],
      [{ id: CHAIN_LAYER, color: '#58a6ff', visible: true }],
    )
    const z = new THREE.Box3().setFromObject(fixture.lineFor('dxf-loop-1')).min.z
    expect(z).toBeCloseTo(Z2D, 6)
  })

  it('two chains at the same XY (a hole\'s top and bottom rim) are each individually selectable, hovering the one the cursor is actually over at its real height', () => {
    // Operator's exact case: "21 (Z 0)" and "22 (Z 4)" - identical footprint,
    // exactly coincident if flattened (WO-257's own motivating scenario),
    // genuinely distinct once drawn in situ.
    const fixture = makeFixture()
    fixture.viewport.setPartProjectedLoops(
      GEO_ID,
      [
        { id: 'mec:c21-bottom', name: 'STL edge chain 21 (Z 0)', points: square(0, 0, 3), closed: true, layerId: CHAIN_LAYER },
        { id: 'mec:c22-top', name: 'STL edge chain 22 (Z 4)', points: square(0, 0, 3), closed: true, layerId: CHAIN_LAYER },
      ],
      [{ id: CHAIN_LAYER, color: '#58a6ff', visible: true }],
    )
    fixture.viewport.setLoopPickMode(() => {}, GEO_ID)

    const bottomColorBefore = (fixture.lineFor('mec:c21-bottom').material as THREE.LineBasicMaterial).color.getHex()
    const topColorBefore = (fixture.lineFor('mec:c22-top').material as THREE.LineBasicMaterial).color.getHex()

    // Aim exactly at the BOTTOM chain's true 3D location (a vertex on its
    // outline, in situ) - the edge he "points at" in the screenshot.
    const bottomPoint = new THREE.Vector3(3, 0, 0 + Z2D)
    priv(fixture.viewport).updateLoopPickHover(hoverEventAt(fixture.camera, bottomPoint))
    expect(priv(fixture.viewport).loopPickHoverId).toBe('mec:c21-bottom')
    const bottomColorHovered = (fixture.lineFor('mec:c21-bottom').material as THREE.LineBasicMaterial).color.getHex()
    expect(bottomColorHovered).not.toBe(bottomColorBefore)
    // The chain it is NOT over stays exactly as it was.
    expect((fixture.lineFor('mec:c22-top').material as THREE.LineBasicMaterial).color.getHex()).toBe(topColorBefore)

    // Aim exactly at the TOP chain's true 3D location - the hover hands over
    // to it specifically, not the bottom one it was just coincident with pre-fix.
    const topPoint = new THREE.Vector3(3, 0, 4 + Z2D)
    priv(fixture.viewport).updateLoopPickHover(hoverEventAt(fixture.camera, topPoint))
    expect(priv(fixture.viewport).loopPickHoverId).toBe('mec:c22-top')
    expect((fixture.lineFor('mec:c21-bottom').material as THREE.LineBasicMaterial).color.getHex()).toBe(bottomColorBefore)
  })

  it('fail-then-pass: aiming at a chain\'s true 3D location misses it when flattened, hits it once drawn in situ', () => {
    const AIM = new THREE.Vector3(3, 0, 4 + Z2D) // the chain's real, in-situ location

    // Pre-fix reproduction: the SAME chain data, but rendered through a loop
    // with no Z-suffixed name - this function's own fallback still supports
    // it, since that is exactly the shape meshContourLoops produced before
    // this WO stamped the suffix. Both this and its "twin" would flatten onto
    // the shared Z2D plane, nowhere near AIM.
    const flat = makeFixture()
    flat.viewport.setPartProjectedLoops(
      GEO_ID,
      [
        { id: 'mec:hole-bottom', points: square(0, 0, 3), closed: true, layerId: CHAIN_LAYER },
        { id: 'mec:hole-top', points: square(0, 0, 3), closed: true, layerId: CHAIN_LAYER },
      ],
      [{ id: CHAIN_LAYER, color: '#58a6ff', visible: true }],
    )
    flat.viewport.setLoopPickMode(() => {}, GEO_ID)
    priv(flat.viewport).updateLoopPickHover(hoverEventAt(flat.camera, AIM))
    expect(priv(flat.viewport).loopPickHoverId).toBeNull()

    // Post-fix: the real chain name carries its height, so it draws (and is
    // pickable) exactly where AIM points.
    const fixed = makeFixture()
    fixed.viewport.setPartProjectedLoops(
      GEO_ID,
      [
        { id: 'mec:hole-bottom', name: 'STL edge chain 21 (Z 0)', points: square(0, 0, 3), closed: true, layerId: CHAIN_LAYER },
        { id: 'mec:hole-top', name: 'STL edge chain 22 (Z 4)', points: square(0, 0, 3), closed: true, layerId: CHAIN_LAYER },
      ],
      [{ id: CHAIN_LAYER, color: '#58a6ff', visible: true }],
    )
    fixed.viewport.setLoopPickMode(() => {}, GEO_ID)
    priv(fixed.viewport).updateLoopPickHover(hoverEventAt(fixed.camera, AIM))
    expect(priv(fixed.viewport).loopPickHoverId).toBe('mec:hole-top')
  })
})
