// WO-1911: repair closes more of a real broken file.
//
// Measured on Operator's own STLs (the worker report in
// queue/WO-1911-repair-closes-more-of-a-real-broken-file.md): welding by distance
// instead of today's fixed-grid position weld made watertight parts worse at every
// tolerance tried, so the weld stays as it is. What won is duplicate-triangle
// removal inside repairMesh. A pair of facets over the same three corners facing
// opposite ways cancels, and same-facing copies collapse to one. It runs before the
// hole caps and again after them. On platte-c-broken.stl today's cap puts two ears
// exactly on top of existing facets, facing the other way, and the part stays
// non-manifold.
//
// The real files run through the production repair call MeshLabPage's Repair
// button takes: worker client -> real host -> mesh-service -> repairMesh, after
// the page's own import + weldByPosition.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MeshWorkerClient } from '../../mesh/worker/client';
import { createMeshWorkerApi, type MeshWorkerApi } from '../../mesh/worker/mesh-service';
import { handleMeshWorkerCall, type MeshWorkerCall, type MeshWorkerResponse } from '../../mesh/worker/host';
import { analyzeMesh, repairMesh } from '../../mesh/analysis';
import type { MeshBuffers } from '../../mesh/types';
import { weldByPosition } from '../../components/meshlab/meshWiring';
import { unitCube } from './fixtures';

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

/** MeshLabPage.importFile then runRepair: import, weld by position, repair. */
async function importAndRepair(path: string) {
  const client = productionClient();
  const bytes = readFileSync(path);
  const imported = await client.importStl(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const welded = weldByPosition(imported.mesh);
  const before = analyzeMesh(welded, { checkSelfIntersections: false });
  const input = { positions: new Float32Array(welded.positions), indices: new Uint32Array(welded.indices) };
  const repaired = await client.repair(input);
  return { welded, before, repaired };
}

function concat(a: MeshBuffers, b: MeshBuffers): MeshBuffers {
  const positions = new Float32Array(a.positions.length + b.positions.length);
  positions.set(a.positions, 0);
  positions.set(b.positions, a.positions.length);
  const offset = a.positions.length / 3;
  return { positions, indices: new Uint32Array([...a.indices, ...Array.from(b.indices, (v) => v + offset)]) };
}

function withExtraFacet(mesh: MeshBuffers, facet: number, reversed: boolean): MeshBuffers {
  const [a, b, c] = mesh.indices.slice(facet * 3, facet * 3 + 3);
  return { positions: mesh.positions, indices: new Uint32Array([...mesh.indices, ...(reversed ? [a, c, b] : [a, b, c])]) };
}

describe('WO-1911: repair closes more of a real broken file', () => {
  it('#1 platte-c-broken.stl repairs watertight through the production call', async () => {
    const { before, repaired } = await importAndRepair('src/tests/meshlab/fixtures/platte-c-broken.stl');
    // The damage: one 14-edge hole in a 1,396-facet plate.
    expect(before.holeCount).toBe(1);
    expect(before.boundaryEdgeCount).toBe(14);
    expect(before.nonManifoldEdgeCount).toBe(0);
    // Before WO-1911: filled 1 hole, still 2 non-manifold edges + 2 duplicate facets, not watertight.
    expect(repaired.filledHoleCount).toBe(1);
    expect(repaired.report.nonManifoldEdgeCount).toBe(0);
    expect(repaired.report.duplicateTriangleCount).toBe(0);
    expect(repaired.report.windingConflictEdgeCount).toBe(0);
    expect(repaired.report.watertight).toBe(true);
    expect(repaired.report.triangleCount).toBe(1404);
    // The good export of the same plate encloses 10,651.27 mm^3.
    expect(Math.abs(repaired.measures.volume - 10651.272) / 10651.272).toBeLessThan(1e-3);
    expect(repaired.measures.signedVolume).toBeGreaterThan(0);
  });

  it('#2 negative control: the good Platte C export comes out of repair untouched', async () => {
    const { welded, repaired } = await importAndRepair('src/tests/mesh/fixtures/obj_1_Platte C.stl');
    expect(repaired.report.watertight).toBe(true);
    expect(repaired.filledHoleCount).toBe(0);
    expect(repaired.flippedTriangleCount).toBe(0);
    expect(Array.from(repaired.mesh.indices)).toEqual(Array.from(welded.indices));
    expect(Array.from(repaired.mesh.positions)).toEqual(Array.from(welded.positions));
  });

  it('#3 a same-facing duplicate facet collapses to one', () => {
    const doubled = withExtraFacet(unitCube(), 4, false);
    expect(analyzeMesh(doubled).nonManifoldEdgeCount).toBe(3);
    const repaired = repairMesh(doubled);
    expect(repaired.report.watertight).toBe(true);
    expect(repaired.report.duplicateTriangleCount).toBe(0);
    expect(repaired.report.triangleCount).toBe(12);
  });

  it('#4 two boxes exported as separate shells sharing a face merge: the doubled wall cancels', () => {
    // Box B is box A mirrored across x = 1, so the wall at x = 1 is the same two
    // facets in both, facing opposite ways.
    const a = unitCube();
    const mirrored = new Float32Array(a.positions);
    for (let i = 0; i < mirrored.length; i += 3) mirrored[i] = 2 - mirrored[i];
    const b: MeshBuffers = { positions: mirrored, indices: new Uint32Array(a.indices.length) };
    for (let i = 0; i < a.indices.length; i += 3) {
      b.indices[i] = a.indices[i];
      b.indices[i + 1] = a.indices[i + 2];
      b.indices[i + 2] = a.indices[i + 1];
    }
    const welded = weldByPosition(concat(a, b));
    expect(analyzeMesh(welded).duplicateTriangleCount).toBe(2);
    const repaired = repairMesh(welded);
    expect(repaired.report.watertight).toBe(true);
    expect(repaired.report.triangleCount).toBe(20);
    expect(repaired.measures.componentCount).toBe(1);
    expect(repaired.measures.volume).toBeCloseTo(2, 6);
  });

  // Cancelling a set whose edge a third facet also uses leaves that edge with one
  // facet. Unguarded, that left MORE holes open on Operator's files (Growlithe.stl 13
  // -> 15, Zelda_Bey.stl 44 -> 45), so such a set stays and repair is never worse.
  it('#5 a folded facet on an edge a third facet uses is kept, never cancelled into an open edge', () => {
    const folded = withExtraFacet(unitCube(), 4, true);
    const repaired = repairMesh(folded);
    expect(repaired.report.boundaryEdgeCount).toBe(0);
    expect(repaired.report.holeCount).toBe(0);
    expect(repaired.report.triangleCount).toBe(13);
  });
});
