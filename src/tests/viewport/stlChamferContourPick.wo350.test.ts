// WO-350: "I can only select edges on the top and the bottom of the part...
// I cannot select the contour around the chamfer line." On a chamfered part
// the true outer profile is the chamfer's lower edge, not the (inset) top
// face outline - picking only what's reachable silently machines the part
// undersize by the chamfer width.
//
// THE MECHANISM (found, not guessed - see the result log for the full
// derivation): resolveLoopPickAtCurrentRay's case 1 (direct hit on a loop's
// own thin outline) was always fine regardless of Z - proven below. The bug
// is in case 2, the INTERIOR fallback used whenever a hover/click isn't a
// pixel-perfect hit on the outline (loopPickInterior.ts's own stated purpose:
// "a small closed loop is naturally targeted at its center"). Pre-fix, it
// picked the SMALLEST-AREA loop among every loop the ray pierced, with NO
// regard for which plane the ray reaches FIRST. For an oblique/isometric
// camera - the normal 3D view, not a top-down 2D one - a single ray commonly
// pierces loops at SEVERAL different heights of the same chamfered part
// (each tested against its own plane), and a chamfer's straight-wall rim is
// almost always WIDER than the (inset) top/bottom face it necks down to. So
// whenever a click wasn't pixel-precise on the chamfer's own outline, the
// smaller extreme-Z face won the comparison - even when it was not the
// surface actually under the cursor. That is not a hard "extreme wins", it's
// "smallest wins", which happens to be the extreme face on almost any real
// chamfer.
//
// THE FIX (src/lib/viewport/CNCViewport.ts resolveLoopPickAtCurrentRay,
// src/lib/viewport/loopPickInterior.ts rayPierceLoop): case 2 now prefers the
// NEAREST pierced loop (matches every other pick path in this file - nearest
// hit wins), and only falls back to smallest-area as a tie-break between
// loops the ray reaches at essentially the same distance - which is exactly
// the ORIGINAL nested-holes-on-one-plane case the fallback was built for
// (same Z plane => identical distance => area still disambiguates).
// loopPickInterior.ts's own rayPiercesClosedLoop keeps its exact prior
// signature/behavior (loopPickInterior.test.ts, not owned by this WO, is
// untouched); rayPierceLoop is an additive export sharing its math.

import * as THREE from 'three'
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js'
import { describe, expect, it } from 'vitest'
import { CNCViewport } from '../../lib/viewport/CNCViewport'
import { rayPiercesClosedLoop } from '../../lib/viewport/loopPickInterior'
import { importStl } from '../../mesh/stl'
import { meshContourLoops } from '../../store'
import type { Loop2D } from '../../types'

interface HoverHarness {
  loopPickHoverId: string | null
  updateLoopPickHover: (event: MouseEvent) => void
  raycaster: THREE.Raycaster
  selectableObjects: THREE.Object3D[]
}
function priv(viewport: CNCViewport): HoverHarness {
  return viewport as unknown as HoverHarness
}

const CANVAS_W = 800
const CANVAS_H = 600
const GEO_ID = 'wo350-part'
const CHAIN_LAYER = 'stl-edge-chains'
const Z2D = 0.3 // CNCViewport.Z2D, mirrored (private) - same convention as WO-340/341's tests

/** Same oblique-camera, no-WebGL harness shape as WO-340/341/318's own tests:
 *  every method under test is production's. The camera is ISOMETRIC/oblique
 *  on purpose - a top-down ortho ray cannot tell loops at different heights
 *  apart, so it can never exercise the cross-Z fallback this WO fixes. */
function makeFixture(bodyHeight: number, bodyHalf: number): {
  viewport: CNCViewport
  camera: THREE.OrthographicCamera
  lineFor: (loopId: string) => THREE.Line
} {
  const viewport = Object.create(CNCViewport.prototype) as CNCViewport
  const camera = new THREE.OrthographicCamera(-50, 50, 50, -50, 0.1, 1000)
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

  // The opaque body Operator actually sees. Its exact shape does not affect
  // resolveLoopPickAtCurrentRay (confirmed by reading it - mesh presence
  // never gates a Line hit), but setPartProjectedLoops' own minZ scan reads
  // this mesh's RAW LOCAL geometry Z (addSTL's own recenter convention), so
  // it must be a flat, unrotated box spanning the full height for that scan
  // to land on a sane Z origin.
  const bodyGeometry = new THREE.BoxGeometry(bodyHalf * 2, bodyHalf * 2, bodyHeight)
  bodyGeometry.translate(0, 0, bodyHeight / 2)
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

  return { viewport, camera, lineFor }
}

function hoverEventAt(camera: THREE.Camera, point: THREE.Vector3): MouseEvent {
  const ndc = point.clone().project(camera)
  return {
    clientX: ((ndc.x + 1) / 2) * CANVAS_W,
    clientY: ((1 - ndc.y) / 2) * CANVAS_H,
  } as unknown as MouseEvent
}

function square(half: number): Array<{ x: number; y: number }> {
  return [
    { x: -half, y: -half },
    { x: half, y: -half },
    { x: half, y: half },
    { x: -half, y: half },
  ]
}

function chainLoop(id: string, name: string, half: number): Loop2D {
  return { id, name, points: square(half), closed: true, type: 'contour', layerId: CHAIN_LAYER, area: (half * 2) ** 2 }
}

/** A real double-chamfered cylindrical boss (round, not boxy, so the
 *  wall-to-chamfer rim is one continuous smooth chain rather than 4
 *  disconnected per-face fragments a low-poly box would produce): full
 *  radius 20 from Z2..6, chamfered (45deg) down to a smaller radius-18 face
 *  at both Z0 and Z8. Built with three.js's own well-tested extrude/bevel and
 *  exported to real STL bytes, then run through the SAME importStl ->
 *  meshContourLoops production pipeline every other STL edge-chain test uses -
 *  the "real derived coordinates" flavor stlEdgeHover.wo318.test.tsx
 *  established, not hand-typed points. */
function buildChamferedBossStlBuffer(): ArrayBuffer {
  const shape = new THREE.Shape()
  shape.absarc(0, 0, 18, 0, Math.PI * 2, false)
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: 4, bevelEnabled: true, bevelThickness: 2, bevelSize: 2, bevelOffset: 0,
    bevelSegments: 1, steps: 1, curveSegments: 32,
  })
  geo.computeVertexNormals()
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial())
  const bin = new STLExporter().parse(mesh, { binary: true }) as unknown as DataView
  return bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength) as ArrayBuffer
}

describe('WO-350: the chamfer contour picks in the viewport, same as top/bottom', () => {
  it('case 1 (direct outline hit): a synthetic chamfer chain between two extreme chains is hit exactly like the extremes, at its own height', () => {
    const fixture = makeFixture(4, 20)
    fixture.viewport.setPartProjectedLoops(
      GEO_ID,
      [
        chainLoop('mec:bottom', 'STL edge chain 1 (Z 0)', 20),
        chainLoop('mec:wall', 'STL edge chain 2 (Z 3.5)', 20),
        chainLoop('mec:top', 'STL edge chain 3 (Z 4)', 15),
      ],
      [{ id: CHAIN_LAYER, color: '#58a6ff', visible: true }],
    )
    fixture.viewport.setLoopPickMode(() => {}, GEO_ID)

    priv(fixture.viewport).updateLoopPickHover(hoverEventAt(fixture.camera, new THREE.Vector3(20, 0, 0 + Z2D)))
    expect(priv(fixture.viewport).loopPickHoverId).toBe('mec:bottom')

    // The chamfer edge - Operator's exact complaint - hit the same way.
    priv(fixture.viewport).updateLoopPickHover(hoverEventAt(fixture.camera, new THREE.Vector3(20, 0, 3.5 + Z2D)))
    expect(priv(fixture.viewport).loopPickHoverId).toBe('mec:wall')

    priv(fixture.viewport).updateLoopPickHover(hoverEventAt(fixture.camera, new THREE.Vector3(15, 0, 4 + Z2D)))
    expect(priv(fixture.viewport).loopPickHoverId).toBe('mec:top')
  })

  it('fail-then-pass: the interior fallback, aimed at a point ONLY reachable via case 2, resolves to the wrong (smaller, farther) extreme chain under the pre-fix area-only rule, and to the correct (larger, nearer) chamfer chain under the shipped fix', () => {
    const fixture = makeFixture(4, 20)
    const bottom = chainLoop('mec:bottom', 'STL edge chain 1 (Z 0)', 8)   // small + far from the camera
    const wall   = chainLoop('mec:wall',   'STL edge chain 2 (Z 3.5)', 20) // large + near the camera - Operator's target
    const top    = chainLoop('mec:top',    'STL edge chain 3 (Z 4)', 8)   // small + nearest of all
    fixture.viewport.setPartProjectedLoops(GEO_ID, [bottom, wall, top], [{ id: CHAIN_LAYER, color: '#58a6ff', visible: true }])
    fixture.viewport.setLoopPickMode(() => {}, GEO_ID)

    // Deep inside the wall's own footprint (10mm from any of its edges - well
    // past the raycaster's Line.threshold, so case 1 finds nothing and this
    // exercises case 2), and far enough from center that top's small
    // footprint is NOT also pierced by the same ray (isolates a clean 2-way
    // bottom-vs-wall conflict).
    const aim = new THREE.Vector3(10, 0, 3.5 + Z2D)
    const event = hoverEventAt(fixture.camera, aim)

    priv(fixture.viewport).updateLoopPickHover(event)
    // Sanity: this aim point is genuinely a case-2 (interior) resolution, not
    // a lucky case-1 outline graze.
    const hits = priv(fixture.viewport).raycaster.intersectObjects(priv(fixture.viewport).selectableObjects, true)
    expect(hits.some(h => h.object instanceof THREE.Line)).toBe(false)

    // THE FIX, exercised through the real production path.
    expect(priv(fixture.viewport).loopPickHoverId).toBe('mec:wall')

    // THE BUG, reproduced directly: the exact pre-fix rule (smallest area
    // among every pierced loop, no distance check) against the SAME ray this
    // hover just used and the SAME rendered loop geometry.
    const ray = priv(fixture.viewport).raycaster.ray
    let oldRuleBest: { id: string; area: number } | null = null
    for (const obj of priv(fixture.viewport).selectableObjects) {
      if (!(obj instanceof THREE.Line) || !obj.name) continue
      const pts: Array<{ x: number; y: number; z: number }> = []
      const posAttr = obj.geometry.getAttribute('position') as THREE.BufferAttribute
      obj.updateWorldMatrix(true, false)
      const v = new THREE.Vector3()
      for (let i = 0; i < posAttr.count; i++) {
        v.fromBufferAttribute(posAttr, i).applyMatrix4(obj.matrixWorld)
        pts.push({ x: v.x, y: v.y, z: v.z })
      }
      const area = rayPiercesClosedLoop(pts, ray.origin, ray.direction)
      if (area != null && (!oldRuleBest || area < oldRuleBest.area)) oldRuleBest = { id: obj.name, area }
    }
    expect(oldRuleBest?.id).toBe('mec:bottom')
    expect(oldRuleBest?.id).not.toBe(priv(fixture.viewport).loopPickHoverId)
  })

  it('the interior fallback still prefers the innermost of several loops nested on the SAME plane (the original nested-hole case is unchanged)', () => {
    const fixture = makeFixture(1, 20)
    const pocket = chainLoop('mec:pocket', 'STL edge chain 1 (Z 0.5)', 20)
    const hole   = chainLoop('mec:hole',   'STL edge chain 2 (Z 0.5)', 3)
    fixture.viewport.setPartProjectedLoops(GEO_ID, [pocket, hole], [{ id: CHAIN_LAYER, color: '#58a6ff', visible: true }])
    fixture.viewport.setLoopPickMode(() => {}, GEO_ID)

    priv(fixture.viewport).updateLoopPickHover(hoverEventAt(fixture.camera, new THREE.Vector3(0, 0, 0.5 + Z2D)))
    expect(priv(fixture.viewport).loopPickHoverId).toBe('mec:hole')
  })

  it('real mesh-derived chains from a double-chamfered boss STL: the chamfer rim (the wide intermediate chain) hits via the same pick path as the inset top/bottom faces', () => {
    const parsed = importStl(buildChamferedBossStlBuffer())
    const loops = meshContourLoops(parsed.mesh)
    expect(loops.length).toBe(4)

    const byZ = (z: number) => loops.find(l => l.name?.endsWith(`(Z ${z})`))
    const bottomFace = byZ(0)
    const chamferRim = byZ(2)   // wall meets the bottom chamfer - the wide "true outer profile"
    const topFace = byZ(8)
    if (!bottomFace || !chamferRim || !topFace) {
      throw new Error(`expected chains at Z 0/2/8, got: ${loops.map(l => l.name).join(', ')}`)
    }
    expect(chamferRim.area).toBeGreaterThan(bottomFace.area) // the chamfer band is wider than the inset face

    const fixture = makeFixture(8, 22)
    fixture.viewport.setPartProjectedLoops(GEO_ID, loops, [{ id: '__mesh_edge_chains__', color: '#58a6ff', visible: true }])
    fixture.viewport.setLoopPickMode(() => {}, GEO_ID)

    // Hover exactly on the chamfer rim's own outline (a real derived vertex),
    // mirroring how Operator actually clicks a contour - on its edge, in situ.
    const rimVertex = chamferRim.points[0]
    priv(fixture.viewport).updateLoopPickHover(
      hoverEventAt(fixture.camera, new THREE.Vector3(rimVertex.x, rimVertex.y, 2 + Z2D)),
    )
    expect(priv(fixture.viewport).loopPickHoverId).toBe(chamferRim.id)

    // Regression: the extreme (inset) top face still picks too.
    const topVertex = topFace.points[0]
    priv(fixture.viewport).updateLoopPickHover(
      hoverEventAt(fixture.camera, new THREE.Vector3(topVertex.x, topVertex.y, 8 + Z2D)),
    )
    expect(priv(fixture.viewport).loopPickHoverId).toBe(topFace.id)
  })
})
