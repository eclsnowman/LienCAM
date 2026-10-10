// MSH-3 BK-11b + ruling-3b: direct MeshWorkerClient coverage through a REAL
// loopback worker (routes every call through the real host handleMeshWorkerCall,
// which unwraps the TransferEnvelope exactly as the browser worker does). This
// proves two things at runtime:
//   (1) ruling 3b — the client's Promise resolves to the PLAIN payload X, never
//       a TransferEnvelope<X> (the declared-type truth INT-3 verified by probe);
//   (2) BK-11b — which calls DETACH the caller's input buffers (transfer
//       semantics), documented here so no future consumer has to rediscover the
//       cloneMesh workaround INT-3 needed.
import { describe, it, expect, afterAll } from 'vitest';
import { MeshWorkerClient } from '../../mesh/worker/client';
import { createMeshWorkerApi, type MeshWorkerApi } from '../../mesh/worker/mesh-service';
import { handleMeshWorkerCall, type MeshWorkerCall, type MeshWorkerResponse } from '../../mesh/worker/host';
import { meshOperand } from '../../mesh/crossDomainBoolean';
import type { MeshBuffers, MeshRepairResult, StlExportResult, StlImportResult, Vec3 } from '../../mesh/types';
import { binaryStlFixture, unitCube } from './fixtures';

const fakeManifoldFactory = async () => ({ setup: () => undefined, Manifold: {} });

function translateMesh(mesh: MeshBuffers, offset: Vec3): MeshBuffers {
  const positions = new Float32Array(mesh.positions);
  for (let i = 0; i < positions.length; i += 3) {
    positions[i] += offset[0];
    positions[i + 1] += offset[1];
    positions[i + 2] += offset[2];
  }
  return { positions, indices: new Uint32Array(mesh.indices) };
}

/**
 * Real single-realm loopback: postMessage clones the call (moving any
 * transferred buffers into the clone, DETACHING the caller's originals just
 * like a real Worker boundary), runs the true host, and delivers the host's
 * response back to the client's listener.
 */
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

function makeClient(): MeshWorkerClient {
  const api = createMeshWorkerApi({ manifoldFactory: fakeManifoldFactory });
  return new MeshWorkerClient(new LoopbackWorker(api) as unknown as Worker);
}

describe('MeshWorkerClient runtime return types (ruling 3b)', () => {
  it('importStl resolves to the PLAIN StlImportResult, not a TransferEnvelope', async () => {
    const client = makeClient();
    const result = await client.importStl(binaryStlFixture(unitCube(10)));
    // runtime truth: no envelope wrapper survived the host unwrap.
    expect('__meshComlinkTransfer' in (result as object)).toBe(false);
    expect(result.mesh).toBeDefined();
    expect(result.report).toBeDefined();
    expect(result.measures).toBeDefined();
    // compile-time truth: the declared return type IS StlImportResult (accessing
    // .mesh would not type-check against TransferEnvelope<StlImportResult>).
    const typed: StlImportResult = result;
    expect(typed.mesh.positions.length).toBeGreaterThan(0);
  });

  it('repair and exportStl also resolve to plain payloads', async () => {
    const client = makeClient();
    const repaired: MeshRepairResult = await client.repair(unitCube(10));
    expect('__meshComlinkTransfer' in (repaired as object)).toBe(false);
    expect(repaired.mesh).toBeDefined();
    expect(typeof repaired.filledHoleCount).toBe('number');

    const exported: StlExportResult = await client.exportStl(unitCube(10));
    expect('__meshComlinkTransfer' in (exported as object)).toBe(false);
    expect(exported.bytes.byteLength).toBeGreaterThan(0);
    expect(typeof exported.triangleCount).toBe('number');
  });
});

describe('MeshWorkerClient input-buffer transfer semantics (BK-11b)', () => {
  it('DETACHES: importStl detaches the input STL ArrayBuffer', async () => {
    const client = makeClient();
    const bytes = binaryStlFixture(unitCube(10));
    expect(bytes.byteLength).toBeGreaterThan(0);
    await client.importStl(bytes);
    expect(bytes.byteLength).toBe(0); // transferred to the worker, caller must not reuse it
  });

  it('DETACHES: exportStl and repair detach BOTH mesh buffers', async () => {
    const client = makeClient();
    for (const call of ['exportStl', 'repair'] as const) {
      const mesh = unitCube(10);
      const pos = mesh.positions.buffer as ArrayBuffer;
      const idx = mesh.indices.buffer as ArrayBuffer;
      await client[call](mesh);
      expect(pos.byteLength).toBe(0);
      expect(idx.byteLength).toBe(0);
    }
  });

  it('DOES NOT DETACH: measure and analyze leave the caller mesh intact (no transfer list)', async () => {
    const client = makeClient();
    for (const call of ['measure', 'analyze'] as const) {
      const mesh = unitCube(10);
      const pos = mesh.positions.buffer as ArrayBuffer;
      const idx = mesh.indices.buffer as ArrayBuffer;
      await client[call](mesh);
      expect(pos.byteLength).toBeGreaterThan(0);
      expect(idx.byteLength).toBeGreaterThan(0);
    }
  });
});

/**
 * MSH-3-R1.2 — the FULL detach matrix (audit finding 2: the loopback tests did
 * not assert every MeshWorkerClient method that carries a transfer list). This
 * comment IS the caller-facing contract: every client.ts method appears below
 * with its tested-or-documented transfer disposition.
 *
 *   init        — no mesh args, no transfer list.                    N/A
 *   dispose     — no mesh args, no transfer list.                    N/A
 *   importStl   — transfers the input STL ArrayBuffer.                DETACH (tested above)
 *   exportStl   — transfers the input mesh buffers.                   DETACH (tested above)
 *   repair      — transfers the input mesh buffers.                   DETACH (tested above)
 *   measure     — no transfer list.                                   NO DETACH (tested above)
 *   analyze     — no transfer list.                                   NO DETACH (tested above)
 *   boolean     — transfers BOTH `mesh` and `other` buffers.           DETACH (tested below, real kernel)
 *   planeCut    — transfers the input mesh buffers.                   DETACH (tested below, real kernel)
 *   hollow      — transfers the input mesh buffers.                   DETACH (tested below, real kernel)
 *   mirror      — transfers the input mesh buffers.                   DETACH (tested below, real kernel)
 *   transform   — transfers the input mesh buffers.                   DETACH (tested below, real kernel)
 *   decimate    — transfers the input mesh buffers.                   DETACH (tested below, real kernel)
 *
 * These six run through the REAL manifold-3d kernel (not the fake stub used
 * above) because their kernel-facing behavior is cheap on a unit cube
 * (see src/tests/mesh/operations.test.ts, same fixture scale) -- there is no
 * need to fall back to a documented-only assertion. The transfer-list detach
 * itself is a property of `structuredClone`'s transfer at postMessage time
 * (LoopbackWorker above), so it holds regardless of whether the kernel call
 * inside the host succeeds -- but running the real kernel also proves the
 * method actually completes end-to-end through the client.
 */
describe('MeshWorkerClient input-buffer transfer semantics — full matrix (BK-11b R1.2)', () => {
  const realApi = createMeshWorkerApi();
  const realClient = new MeshWorkerClient(new LoopbackWorker(realApi) as unknown as Worker);

  afterAll(async () => {
    await realApi.dispose();
  });

  it('DETACHES: boolean detaches BOTH the mesh and other input buffers', async () => {
    const mesh = unitCube(10);
    const other = translateMesh(unitCube(10), [5, 0, 0]);
    const meshPos = mesh.positions.buffer as ArrayBuffer;
    const meshIdx = mesh.indices.buffer as ArrayBuffer;
    const otherPos = other.positions.buffer as ArrayBuffer;
    const otherIdx = other.indices.buffer as ArrayBuffer;
    await realClient.boolean(mesh, other, { operation: 'union' });
    expect(meshPos.byteLength).toBe(0);
    expect(meshIdx.byteLength).toBe(0);
    expect(otherPos.byteLength).toBe(0);
    expect(otherIdx.byteLength).toBe(0);
  });

  it('DETACHES: crossDomainBoolean detaches BOTH operands\' mesh buffers (MSH-4)', async () => {
    const mesh = unitCube(10);
    const other = translateMesh(unitCube(10), [5, 0, 0]);
    const meshPos = mesh.positions.buffer as ArrayBuffer;
    const meshIdx = mesh.indices.buffer as ArrayBuffer;
    const otherPos = other.positions.buffer as ArrayBuffer;
    const otherIdx = other.indices.buffer as ArrayBuffer;
    const result = await realClient.crossDomainBoolean(meshOperand(mesh), meshOperand(other), { operation: 'union' });
    expect(meshPos.byteLength).toBe(0);
    expect(meshIdx.byteLength).toBe(0);
    expect(otherPos.byteLength).toBe(0);
    expect(otherIdx.byteLength).toBe(0);
    // mesh-vs-mesh through this API: still domain 'mesh', but honestly not
    // approximate -- nothing was tessellated, so no tolerance is claimed.
    expect(result.domain).toBe('mesh');
    expect(result.approximate).toBe(false);
    expect(result.tessellationTolerance).toBeNull();
  });

  it('DETACHES: planeCut detaches the input mesh buffers', async () => {
    const mesh = unitCube(10);
    const pos = mesh.positions.buffer as ArrayBuffer;
    const idx = mesh.indices.buffer as ArrayBuffer;
    await realClient.planeCut(mesh, { normal: [0, 0, 1], offset: 5, keep: 'both' });
    expect(pos.byteLength).toBe(0);
    expect(idx.byteLength).toBe(0);
  });

  it('DETACHES: hollow detaches the input mesh buffers', async () => {
    const mesh = unitCube(10);
    const pos = mesh.positions.buffer as ArrayBuffer;
    const idx = mesh.indices.buffer as ArrayBuffer;
    await realClient.hollow(mesh, { thickness: 1 });
    expect(pos.byteLength).toBe(0);
    expect(idx.byteLength).toBe(0);
  });

  it('DETACHES: mirror detaches the input mesh buffers', async () => {
    const mesh = unitCube(10);
    const pos = mesh.positions.buffer as ArrayBuffer;
    const idx = mesh.indices.buffer as ArrayBuffer;
    await realClient.mirror(mesh, { normal: [1, 0, 0] });
    expect(pos.byteLength).toBe(0);
    expect(idx.byteLength).toBe(0);
  });

  it('DETACHES: transform detaches the input mesh buffers', async () => {
    const mesh = unitCube(10);
    const pos = mesh.positions.buffer as ArrayBuffer;
    const idx = mesh.indices.buffer as ArrayBuffer;
    await realClient.transform(mesh, { rotateDegrees: [0, 0, 90] });
    expect(pos.byteLength).toBe(0);
    expect(idx.byteLength).toBe(0);
  });

  it('DETACHES: decimate detaches the input mesh buffers', async () => {
    const mesh = unitCube(10);
    const pos = mesh.positions.buffer as ArrayBuffer;
    const idx = mesh.indices.buffer as ArrayBuffer;
    await realClient.decimate(mesh, { tolerance: 0 });
    expect(pos.byteLength).toBe(0);
    expect(idx.byteLength).toBe(0);
  });
});
