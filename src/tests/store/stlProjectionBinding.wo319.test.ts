// WO-319: STL edge chains (what Operator calls "the STL contour selection" - the
// "Derived geometry > STL edge chains" layer materialized by
// loadMeshEdgeChains) must be drawn ON the mesh they came from, not floating
// off in space next to it.
//
// Root cause, confirmed against src/tests/mesh/fixtures/obj_1_Platte C.stl -
// the EXACT fixture in Operator's screenshot (its tree row even shows the same
// "22" chain count this fixture produces): meshContourLoops()
// (store/index.ts) re-parses the STL's OWN raw file bytes, which sit at
// whatever origin the CAD tool that authored the file happened to use (this
// fixture's raw footprint is X/Y 98..158, nowhere near 0). But
// CNCViewport.addSTL recenters the DISPLAYED mesh before it ever reaches
// partGroups (XY center -> origin, bottom Z -> 0), and nothing persists that
// recentering offset for the edge-chain deriver to read. So the raw-frame
// chain points landed in the STL FILE's own frame instead of the MESH's
// actual local (post-recenter) frame - a coordinate-frame mismatch between
// two independent parses of the same bytes, not literally a double
// application of the part's world transform (that was the first-pass
// diagnosis this WO asked to be confirmed before fixing; this investigation
// found a different, more specific mechanism - see the Worker result).
//
// The fix mirrors addSTL's own recentering inside meshContourLoops, so the
// chain points and the mesh partGroups agree on where local (0,0) sits.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { meshContourLoops } from '../../store'
import { importStl } from '../../mesh/stl'
import type { MeshBuffers } from '../../mesh/types'
import { CNCViewport } from '../../lib/viewport/CNCViewport'
import { isWorldBakedLayer, layerPlaneWorldZ } from '../../store/dispatchGeo'
import type { Layer2D } from '../../types'

const PLATTE_FIXTURE = 'src/tests/mesh/fixtures/obj_1_Platte C.stl'

function loadRawMesh(): MeshBuffers {
  const bytes = readFileSync(PLATTE_FIXTURE)
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  return importStl(ab).mesh
}

// Independently recomputes CNCViewport.addSTL's own recentering (XY center ->
// origin, bottom Z -> 0) from the SAME raw positions, so this test does not
// assume the fix's internals - it just checks the derived loops land inside
// the footprint the displayed mesh actually occupies.
function centeredFootprint(mesh: MeshBuffers) {
  let minX = Infinity, minY = Infinity, minZ = Infinity
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
  for (let i = 0; i + 2 < mesh.positions.length; i += 3) {
    const x = mesh.positions[i], y = mesh.positions[i + 1], z = mesh.positions[i + 2]
    minX = Math.min(minX, x); maxX = Math.max(maxX, x)
    minY = Math.min(minY, y); maxY = Math.max(maxY, y)
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z)
  }
  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2
  return { minX: minX - cx, maxX: maxX - cx, minY: minY - cy, maxY: maxY - cy, minZ: 0, maxZ: maxZ - minZ }
}

describe('WO-319: STL edge chains are tied to the mesh', () => {
  // Acceptance bullet 3: chains are drawn ON the mesh at derive time.
  it('derives chains in the mesh\'s own centered local frame, not the STL file\'s raw frame', () => {
    const mesh = loadRawMesh()
    const loops = meshContourLoops(mesh)
    expect(loops.length).toBeGreaterThan(0)

    const footprint = centeredFootprint(mesh)
    const margin = 1e-6
    for (const loop of loops) {
      for (const p of loop.points) {
        expect(p.x).toBeGreaterThanOrEqual(footprint.minX - margin)
        expect(p.x).toBeLessThanOrEqual(footprint.maxX + margin)
        expect(p.y).toBeGreaterThanOrEqual(footprint.minY - margin)
        expect(p.y).toBeLessThanOrEqual(footprint.maxY + margin)
      }
    }
  })

  // Acceptance bullet 1: FAILS on main, passes after - derive chains, move
  // the part, assert the chains moved with it by exactly the same transform.
  // Fails on main because the FIRST assertion (chains render at the part's
  // actual location) fails pre-fix - the raw-frame points render ~100mm+ from
  // where the recentered mesh actually sits, not merely "off by a bit".
  it('a rendered chain point sits on the part at derive time and tracks it by exactly the move delta', () => {
    const mesh = loadRawMesh()
    const loops = meshContourLoops(mesh)
    const footprint = centeredFootprint(mesh)

    const layer: Layer2D = {
      id: '__mesh_edge_chains__', name: 'STL edge chains', color: '#58a6ff',
      visible: true, derived: true, frame: 'geometry_local',
    }

    // Minimal real-CNCViewport-method harness (same Object.create pattern as
    // projectionLayerVisibility.test.ts): the constructor (WebGL renderer,
    // DOM) never runs, but setPartProjectedLoops IS the real production
    // method under test.
    const vp = Object.create(CNCViewport.prototype) as CNCViewport
    const partGroup = new THREE.Group()

    // A stub body mesh with the SAME footprint the real recentered STL body
    // would have, so setPartProjectedLoops' own "find the local mesh bottom"
    // scan agrees with the frame the chain points are now expressed in.
    const stubGeom = new THREE.BoxGeometry(
      footprint.maxX - footprint.minX,
      footprint.maxY - footprint.minY,
      Math.max(footprint.maxZ - footprint.minZ, 1e-3),
    )
    stubGeom.translate(
      (footprint.minX + footprint.maxX) / 2,
      (footprint.minY + footprint.maxY) / 2,
      (footprint.minZ + footprint.maxZ) / 2,
    )
    partGroup.add(new THREE.Mesh(stubGeom))

    const p0 = { x: 300, y: -150, z: 0 }
    partGroup.position.set(p0.x, p0.y, p0.z)
    Object.assign(vp, {
      partGroups: new Map([['geo-1', partGroup]]),
      projectedLoopGroups: new Map<string, THREE.Group>(),
      updateSelectableObjects: () => {},
    })

    vp.setPartProjectedLoops('geo-1', loops, [layer])
    const projGroup = (vp as unknown as { projectedLoopGroups: Map<string, THREE.Group> })
      .projectedLoopGroups.get('geo-1')
    expect(projGroup).toBeDefined()
    const firstLine = projGroup!.children[0] as THREE.Line

    const worldXY = () => {
      partGroup.updateMatrixWorld(true)
      const pos = firstLine.geometry.getAttribute('position')
      return new THREE.Vector3(pos.getX(0), pos.getY(0), pos.getZ(0)).applyMatrix4(firstLine.matrixWorld)
    }

    const world0 = worldXY()
    // On the part, at derive time - not offset by the STL file's raw origin.
    expect(world0.x).toBeGreaterThanOrEqual(p0.x + footprint.minX - 1)
    expect(world0.x).toBeLessThanOrEqual(p0.x + footprint.maxX + 1)
    expect(world0.y).toBeGreaterThanOrEqual(p0.y + footprint.minY - 1)
    expect(world0.y).toBeLessThanOrEqual(p0.y + footprint.maxY + 1)

    // Move the part (the same store position update a gizmo drag makes) and
    // confirm the chain tracks it by EXACTLY the delta - the binding Operator
    // already confirmed works today, and this WO must not break.
    const delta = { x: 42, y: -17 }
    partGroup.position.set(p0.x + delta.x, p0.y + delta.y, p0.z)
    const world1 = worldXY()
    expect(world1.x - world0.x).toBeCloseTo(delta.x, 6)
    expect(world1.y - world0.y).toBeCloseTo(delta.y, 6)
  })

  // Acceptance bullet 2: a legacy world-baked layer (frame absent) still
  // renders/dispatches exactly where it does today. meshContourLoops always
  // produces frame: 'geometry_local' layers; the OTHER STL-derived layer
  // shape - handleProjectSTL's slice+target-plane projection (frame absent,
  // world-baked) - is untouched by this WO's fix. Pin its dispatch behavior.
  it('a legacy world-baked STL-projection layer (no frame) still dispatches its world Z verbatim', () => {
    const legacyLayer: Layer2D = {
      id: 'legacy-proj', name: 'STL Projection 1', color: '#00e5ff', visible: true,
      projectionPlane: {
        origin: { x: 12, y: -4, z: 7.5 },
        xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, normal: { x: 0, y: 0, z: 1 },
      },
      // frame intentionally absent - the legacy/world-baked case.
    }
    expect(isWorldBakedLayer(legacyLayer)).toBe(true)
    // World-baked: returned verbatim. Unlike geometry_local, position.z is
    // NOT added, no matter where the part currently sits.
    expect(layerPlaneWorldZ(legacyLayer, { position: { x: 1000, y: -500, z: 250 } })).toBe(7.5)
  })
})
