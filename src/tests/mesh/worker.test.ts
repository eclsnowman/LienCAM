import { describe, expect, it } from 'vitest';
import { MeshWorkerClient } from '../../mesh/worker/client';
import { createMeshWorkerApi } from '../../mesh/worker/mesh-service';
import { handleMeshWorkerCall, type MeshWorkerCall, type MeshWorkerResponse } from '../../mesh/worker/host';
import { binaryStlFixture, unitCube } from './fixtures';

const fakeManifoldFactory = async () => ({
  setup: () => undefined,
  Manifold: {},
});

class DetachingWorker {
  readonly posts: { message: MeshWorkerCall; transfer?: Transferable[] }[] = [];
  private listener: ((event: MessageEvent<MeshWorkerResponse>) => void) | null = null;

  addEventListener(type: 'message', listener: (event: MessageEvent<MeshWorkerResponse>) => void): void {
    if (type === 'message') this.listener = listener;
  }

  postMessage(message: MeshWorkerCall, transfer?: Transferable[]): void {
    this.posts.push({ message, transfer });
    structuredClone(message, { transfer });
    this.listener?.({ data: this.responseFor(message) } as MessageEvent<MeshWorkerResponse>);
  }

  private responseFor(message: MeshWorkerCall): MeshWorkerResponse {
    if (message.method === 'exportStl') {
      return { kind: 'result', requestId: message.requestId, result: { bytes: new ArrayBuffer(84), triangleCount: 0 } };
    }
    return { kind: 'result', requestId: message.requestId, result: {} };
  }
}

describe('mesh worker lifecycle and transfer path', () => {
  it('initializes and disposes the manifold kernel cleanly', async () => {
    const api = createMeshWorkerApi({ manifoldFactory: fakeManifoldFactory });
    await expect(api.init({ requireManifold: true })).resolves.toMatchObject({
      kernel: 'manifold-3d',
      version: '3.5.1',
      available: true,
    });
    await expect(api.dispose()).resolves.toEqual({ disposed: true });
  });

  it('applies transfer lists on the actual worker response path for STL import', async () => {
    const api = createMeshWorkerApi({ manifoldFactory: fakeManifoldFactory });
    const posts: { response: MeshWorkerResponse; transfer?: Transferable[] }[] = [];
    await handleMeshWorkerCall(
      api,
      { requestId: 1, method: 'importStl', args: [binaryStlFixture()] },
      (response, transfer) => posts.push({ response, transfer }),
    );

    expect(posts).toHaveLength(1);
    expect(posts[0].response.kind).toBe('result');
    expect(posts[0].transfer?.length).toBe(2);
  });

  it('transfers replayable operation result buffers on the worker response path', async () => {
    const api = createMeshWorkerApi();
    const transformPosts: { response: MeshWorkerResponse; transfer?: Transferable[] }[] = [];
    await handleMeshWorkerCall(
      api,
      { requestId: 3, method: 'transform', args: [unitCube(), { translate: [1, 0, 0] }] },
      (response, transfer) => transformPosts.push({ response, transfer }),
    );

    expect(transformPosts[0].response.kind).toBe('result');
    expect(transformPosts[0].transfer?.length).toBe(2);

    const cutPosts: { response: MeshWorkerResponse; transfer?: Transferable[] }[] = [];
    await handleMeshWorkerCall(
      api,
      { requestId: 4, method: 'planeCut', args: [unitCube(), { normal: [0, 0, 1], offset: 0.5, keep: 'both' }] },
      (response, transfer) => cutPosts.push({ response, transfer }),
    );

    expect(cutPosts[0].response.kind).toBe('result');
    expect(cutPosts[0].transfer?.length).toBe(4);
  });

  it('directly covers MeshWorkerClient input-buffer transfer semantics', async () => {
    const worker = new DetachingWorker();
    const client = new MeshWorkerClient(worker as unknown as Worker);

    const exportMesh = unitCube();
    const exportPositions = exportMesh.positions.buffer as ArrayBuffer;
    const exportIndices = exportMesh.indices.buffer as ArrayBuffer;
    await client.exportStl(exportMesh);

    expect(worker.posts[0].message.method).toBe('exportStl');
    expect(worker.posts[0].transfer?.[0]).toBe(exportPositions);
    expect(worker.posts[0].transfer?.[1]).toBe(exportIndices);
    expect(exportPositions.byteLength).toBe(0);
    expect(exportIndices.byteLength).toBe(0);

    const repairMesh = unitCube();
    const repairPositions = repairMesh.positions.buffer as ArrayBuffer;
    const repairIndices = repairMesh.indices.buffer as ArrayBuffer;
    await client.repair(repairMesh);

    expect(worker.posts[1].message.method).toBe('repair');
    expect(worker.posts[1].transfer?.[0]).toBe(repairPositions);
    expect(worker.posts[1].transfer?.[1]).toBe(repairIndices);
    expect(repairPositions.byteLength).toBe(0);
    expect(repairIndices.byteLength).toBe(0);
  });

  it('transfers exported STL bytes on the worker response path', async () => {
    const api = createMeshWorkerApi({ manifoldFactory: fakeManifoldFactory });
    const posts: { response: MeshWorkerResponse; transfer?: Transferable[] }[] = [];
    await handleMeshWorkerCall(
      api,
      { requestId: 2, method: 'exportStl', args: [unitCube()] },
      (response, transfer) => posts.push({ response, transfer }),
    );

    expect(posts[0].response.kind).toBe('result');
    expect(posts[0].transfer?.length).toBe(1);
  });
});
