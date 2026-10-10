// WO INT-3: wiring-layer helpers for the Mesh Shop lab. src/mesh/** (MSH-1/MSH-2, frozen for
// this WO) is a low-level buffer facade -- everything about making it SAFE and HONEST to drive
// interactively (welding raw STL topology, guarding perf cliffs, avoiding redundant analysis
// passes) belongs here, not there.
import type { MeshBuffers, MeshHealthReport, MeshMeasureResult, TessellatedBrepBuffers } from '../../mesh'

/**
 * STL has no shared-vertex topology (every triangle owns 3 unique vertex slots -- see
 * src/mesh/stl.ts's parseBinary/parseAscii) -- a freshly imported mesh reports
 * `holeCount === triangleCount` and `watertight: false` even for a genuinely closed real-world
 * solid, because analyzeMesh's edge-sharing check never finds two triangles that reference the
 * SAME vertex index. manifoldOps.ts already welds internally before every manifold op (its own
 * private weldedMesh()), but the interactive health/repair panels call analyze()/repair()
 * directly -- so this wiring layer welds by position ONCE, right after import, before showing any
 * health report or offering Repair. Without this, "repair" on a perfectly good closed STL would
 * report thousands of fake holes and try to fan-fill every single triangle.
 */
export function weldByPosition(mesh: MeshBuffers, precision = 1e4): MeshBuffers {
  const map = new Map<string, number>()
  const positions: number[] = []
  const remap = new Uint32Array(mesh.positions.length / 3)
  for (let v = 0; v < mesh.positions.length / 3; v++) {
    const x = cleanNumber(mesh.positions[v * 3])
    const y = cleanNumber(mesh.positions[v * 3 + 1])
    const z = cleanNumber(mesh.positions[v * 3 + 2])
    const key = Math.round(x * precision) + ':' + Math.round(y * precision) + ':' + Math.round(z * precision)
    let index = map.get(key)
    if (index === undefined) {
      index = positions.length / 3
      map.set(key, index)
      positions.push(x, y, z)
    }
    remap[v] = index
  }
  const indices = new Uint32Array(mesh.indices.length)
  for (let i = 0; i < mesh.indices.length; i++) indices[i] = remap[mesh.indices[i]]
  return { positions: new Float32Array(positions), indices }
}

function cleanNumber(v: number): number {
  return Object.is(v, -0) || Math.abs(v) < 1e-8 ? 0 : v
}

/**
 * BK-17(a) measured guard (coordination/reports/INT-3.report.json carries the full curve):
 * hollowMesh's minkowskiDifference erosion: a 1,776-tri real composite (union + plane-cut
 * result) measured 10.4s; a 2,208-tri synthetic sphere measured 7.4s; a 6,240-tri sphere
 * measured 19.8s; a 25,280-tri sphere measured 111.4s. Cost scales with mesh size AND shape
 * complexity, not size alone. Enforced HERE (the wiring layer) since src/mesh/** itself has no
 * size guard -- BK-17(a)'s "large-mesh perf guard BEFORE hollow goes interactive".
 *
 * Repair has NO guard (WO-1907). It once refused above 3,000 triangles because repairMesh always
 * ran the self-intersection scan (31.2s at 14,160 tris when that scan was O(n^2)). BK-11a made
 * the scan a spatial grid and WO-1907 made repairMesh skip it unless asked, so the 14,160-tri
 * fixture now repairs through the production worker call in ~0.2s. Refusing it was rule 11.
 */
export const HOLLOW_TRIANGLE_GUARD = 2000

export function hollowGuardMessage(triangleCount: number): string | null {
  if (triangleCount <= HOLLOW_TRIANGLE_GUARD) return null
  return (
    `Hollow is blocked above ${HOLLOW_TRIANGLE_GUARD.toLocaleString()} triangles ` +
    `(measured: ~10-20s at ~2,000-6,000 tris, 111s at 25,280 tris -- see M3 report). ` +
    `Decimate this mesh below the guard first.`
  )
}

/**
 * BK-17(b): the interactive UI never issues a SECOND standalone analyze()/measure() worker call
 * for a mesh state whose {report, measures} pair already arrived bundled from the SAME import/
 * op/repair call (every one of importStl, every manifoldOps.ts op, and repairMesh already
 * computes both together in ONE call -- see src/mesh/stl.ts's importStl and
 * src/mesh/manifoldOps.ts's operationResult()). That bundling is internal to src/mesh/** (frozen
 * for this WO) and itself still runs two buildTopology passes per call -- fixing that would mean
 * editing src/mesh/** internals, which is out of scope here. What IS in scope, and what this
 * function exists to make impossible to get wrong: the wiring layer must reuse the bundled pair
 * it already has instead of re-requesting analyze() and measure() separately, which would add a
 * SECOND full double-pass on top of the op's own. MeshLabPage never calls client.analyze() or
 * client.measure() directly for this reason -- every slot's health/measures panel is populated
 * exclusively from bundleFromResult().
 */
export interface MeshHealthBundle {
  report: MeshHealthReport
  measures: MeshMeasureResult
}

export function bundleFromResult(report: MeshHealthReport, measures: MeshMeasureResult): MeshHealthBundle {
  return { report, measures }
}

/**
 * Every MeshWorkerClient call that takes a mesh argument (repair, exportStl, boolean, planeCut,
 * hollow, mirror, transform, decimate -- everything except analyze/measure) posts it with a
 * Transferable list (see src/mesh/worker/client.ts's meshTransfers()), which DETACHES the
 * caller's positions/indices ArrayBuffers the instant postMessage runs. React state here always
 * holds the LAST result it received, but a slot can be the input to more than one op across
 * renders (e.g. Secondary feeding two separate boolean runs) -- cloning before every such call
 * keeps the state-held buffers alive and independently reusable instead of silently zeroing out
 * on the second use.
 */
export function cloneMesh(mesh: MeshBuffers): MeshBuffers {
  return { positions: new Float32Array(mesh.positions), indices: new Uint32Array(mesh.indices) }
}

/**
 * MSH-4: same detach-on-transfer hazard as cloneMesh above, but for a tessellated-brep operand
 * (crossDomainBoolean.ts's TessellatedBrepBuffers uses the singular position/index field names
 * geom-service.ts's TessBuffers uses, NOT MeshBuffers' plural positions/indices -- a real brep
 * operand built once in the lab (geomOperand.ts) must be reusable across more than one
 * cross-domain boolean run without a silent empty-buffer failure on the second click.
 */
export function cloneTess(tess: TessellatedBrepBuffers): TessellatedBrepBuffers {
  return { position: new Float32Array(tess.position), index: new Uint32Array(tess.index) }
}
