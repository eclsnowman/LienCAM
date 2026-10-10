// WO-1907: a part LienCAM can repair is not refused.
//
// repairMesh used to pay for the self-intersection scan on every call (it had no
// MeshAnalyzeOptions, unlike importStl/operationResult), the lab answered that
// cost by refusing Repair above 3,000 triangles and telling the operator to
// decimate, and every boundary loop was closed by a fan from its centroid, which
// folds over itself on a non-convex rim. Everything here runs through the
// production repair call: the worker client -> real host -> mesh-service ->
// repairMesh, the route MeshLabPage's Repair button takes.
import { describe, expect, it } from 'vitest';
import { MeshWorkerClient } from '../../mesh/worker/client';
import { createMeshWorkerApi, type MeshWorkerApi } from '../../mesh/worker/mesh-service';
import { handleMeshWorkerCall, type MeshWorkerCall, type MeshWorkerResponse } from '../../mesh/worker/host';
import { analyzeMesh, repairMesh } from '../../mesh/analysis';
import type { MeshBuffers, Vec3 } from '../../mesh/types';
import { sphereApprox, unitCube } from './fixtures';

const fakeManifoldFactory = async () => ({ setup: () => undefined, Manifold: {} });

/** Same single-realm loopback client.test.ts uses: the call is structured-cloned
 *  across a fake Worker boundary and handled by the REAL host. */
class LoopbackWorker {
  private listener: ((event: MessageEvent<MeshWorkerResponse>) => void) | null = null;
  private readonly api: MeshWorkerApi;
  constructor(api: MeshWorkerApi) { this.api = api; }
  addEventListener(type: 'message', listener: (event: MessageEvent<MeshWorkerResponse>) => void): void {
    if (type === 'message') this.listener = listener;
  }
  postMessage(message: MeshWorkerCall, transfer?: Transferable[]): void {
    const delivered = structuredClone(message, { transfer: (transfer ?? []) as Transferable[] });
    void handleMeshWorkerCall(this.api, delivered, (response) => {
      this.listener?.({ data: response } as MessageEvent<MeshWorkerResponse>);
    });
  }
}

function productionClient(): MeshWorkerClient {
  return new MeshWorkerClient(new LoopbackWorker(createMeshWorkerApi({ manifoldFactory: fakeManifoldFactory })) as unknown as Worker);
}

function copy(mesh: MeshBuffers): MeshBuffers {
  return { positions: new Float32Array(mesh.positions), indices: new Uint32Array(mesh.indices) };
}

/** The 14,160-triangle fixture INT-3 measured at 31.2 s, with its north-pole fan
 *  (the first 120 triangles) and a patch of the next band cut away, so the hole's
 *  rim zig-zags between two latitude rings instead of being one flat circle. */
function holedSphere(): MeshBuffers {
  const sphere = sphereApprox(10, 120, 60);
  const drop = new Set<number>();
  for (let t = 0; t < 120; t++) drop.add(t);
  for (let t = 120; t < 120 + 40; t++) drop.add(t);
  const indices: number[] = [];
  for (let t = 0; t < sphere.indices.length / 3; t++) {
    if (drop.has(t)) continue;
    indices.push(sphere.indices[t * 3], sphere.indices[t * 3 + 1], sphere.indices[t * 3 + 2]);
  }
  return { positions: sphere.positions, indices: new Uint32Array(indices) };
}

/** A U-shaped prism's side walls only: two U-shaped openings (top and bottom),
 *  each a flat, NON-convex rim whose vertex centroid (15, 16.875) lies in the
 *  notch, outside the U - a centroid fan there folds back over itself. */
const U: Array<[number, number]> = [[0, 0], [30, 0], [30, 30], [20, 30], [20, 5], [10, 5], [10, 30], [0, 30]];
const U_AREA = 30 * 30 - 10 * 25;
const U_HEIGHT = 10;
function uTube(): MeshBuffers {
  const positions: number[] = [];
  for (const [x, y] of U) positions.push(x, y, 0);
  for (const [x, y] of U) positions.push(x, y, U_HEIGHT);
  const n = U.length;
  const indices: number[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    // U runs counter-clockwise seen from +Z, so these walls face outward.
    indices.push(i, j, n + j, i, n + j, n + i);
  }
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

function corner(mesh: MeshBuffers, index: number): Vec3 {
  return [mesh.positions[index * 3], mesh.positions[index * 3 + 1], mesh.positions[index * 3 + 2]];
}

function facetNormalArea(mesh: MeshBuffers, facet: number): { normal: Vec3; area: number } {
  const a = corner(mesh, mesh.indices[facet * 3]);
  const b = corner(mesh, mesh.indices[facet * 3 + 1]);
  const c = corner(mesh, mesh.indices[facet * 3 + 2]);
  const u: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const v: Vec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const n: Vec3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const len = Math.hypot(n[0], n[1], n[2]);
  return { normal: [n[0] / len, n[1] / len, n[2] / len], area: len / 2 };
}

describe('WO-1907: a part LienCAM can repair is not refused', () => {
  it('#1 the 14,160-triangle fixture repairs through the production call in under one second', async () => {
    const client = productionClient();
    const whole = sphereApprox(10, 120, 60);
    expect(whole.indices.length / 3).toBe(14160);

    const t0 = performance.now();
    const closed = await client.repair(copy(whole));
    const closedMs = performance.now() - t0;

    const holed = holedSphere();
    const t1 = performance.now();
    const repaired = await client.repair(copy(holed));
    const holedMs = performance.now() - t1;

    console.log(`[WO-1907] production repair, 14,160-tri fixture: ${closedMs.toFixed(1)} ms watertight, ${holedMs.toFixed(1)} ms with a ${160}-facet hole`);
    expect(closed.report.watertight).toBe(true);
    expect(repaired.filledHoleCount).toBe(1);
    expect(repaired.report.watertight).toBe(true);
    expect(repaired.report.windingConflictEdgeCount).toBe(0);
    // The warped, zig-zag rim was ear-clipped over its own corners (no centroid vertex added).
    expect(repaired.mesh.positions.length).toBe(holed.positions.length);
    expect(closedMs).toBeLessThan(1000);
    expect(holedMs).toBeLessThan(1000);
  }, 60_000);

  it('#2 the self-intersection scan runs only when a caller asks for it, and then still finds one', () => {
    // Two closed cubes, one poking through the other: watertight, but crossing.
    const a = unitCube(10);
    const b = unitCube(10);
    const positions = new Float32Array(a.positions.length + b.positions.length);
    positions.set(a.positions, 0);
    for (let i = 0; i < b.positions.length; i++) positions[a.positions.length + i] = b.positions[i] + 5;
    const offset = a.positions.length / 3;
    const indices = new Uint32Array([...a.indices, ...Array.from(b.indices, (v) => v + offset)]);
    const crossing: MeshBuffers = { positions, indices };

    expect(analyzeMesh(crossing, { checkSelfIntersections: true }).selfIntersections).toBe(true);
    expect(repairMesh(copy(crossing)).report.selfIntersections).toBe(false);
    const asked = repairMesh(copy(crossing), { checkSelfIntersections: true });
    expect(asked.report.selfIntersections).toBe(true);
    expect(asked.report.warnings.some((w) => /self-intersections/.test(w))).toBe(true);
  });

  it('#3 a non-convex rim is ear-clipped in its own plane: no folded facet, no new vertex, exact area', async () => {
    const tube = uTube();
    const wallCount = tube.indices.length / 3;
    const result = await productionClient().repair(copy(tube));

    expect(result.filledHoleCount).toBe(2);
    expect(result.report.watertight).toBe(true);
    expect(result.report.windingConflictEdgeCount).toBe(0);
    // Every cap corner is an existing rim vertex: nothing invented at a centroid.
    expect(result.mesh.positions.length).toBe(tube.positions.length);
    expect(result.measures.volume).toBeCloseTo(U_AREA * U_HEIGHT, 6);
    expect(result.measures.signedVolume).toBeGreaterThan(0);

    let topArea = 0;
    let bottomArea = 0;
    const facetCount = result.mesh.indices.length / 3;
    expect(facetCount).toBe(wallCount + 2 * (U.length - 2));
    for (let f = 0; f < facetCount; f++) {
      const zs = [0, 1, 2].map((k) => result.mesh.positions[result.mesh.indices[f * 3 + k] * 3 + 2]);
      if (zs.every((z) => z === U_HEIGHT)) {
        const { normal, area } = facetNormalArea(result.mesh, f);
        expect(normal[2]).toBeCloseTo(1, 9); // faces out of the top, never folded under
        topArea += area;
      } else if (zs.every((z) => z === 0)) {
        const { normal, area } = facetNormalArea(result.mesh, f);
        expect(normal[2]).toBeCloseTo(-1, 9);
        bottomArea += area;
      }
    }
    // Unsigned areas add up to the U exactly only when no two cap facets overlap.
    expect(topArea).toBeCloseTo(U_AREA, 6);
    expect(bottomArea).toBeCloseTo(U_AREA, 6);
  });

  it('#4 negative control: an already-watertight mesh comes back byte-identical with nothing to close', async () => {
    // sphereApprox winds inward (repair would rightly re-orient all of it), so
    // the control flips it to face outward first: a healthy part, nothing to do.
    const sphere = sphereApprox(10, 120, 60);
    const outward = new Uint32Array(sphere.indices);
    for (let i = 0; i < outward.length; i += 3) [outward[i + 1], outward[i + 2]] = [outward[i + 2], outward[i + 1]];
    for (const mesh of [unitCube(10), { positions: sphere.positions, indices: outward }]) {
      const result = await productionClient().repair(copy(mesh));
      expect(result.filledHoleCount).toBe(0);
      expect(result.droppedDegenerateTriangleCount).toBe(0);
      expect(result.flippedTriangleCount).toBe(0);
      expect(Array.from(result.mesh.indices)).toEqual(Array.from(mesh.indices));
      expect(Array.from(result.mesh.positions)).toEqual(Array.from(mesh.positions));
    }
  }, 60_000);
});
