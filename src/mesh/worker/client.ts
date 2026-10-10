import type {
  MeshAnalyzeOptions,
  MeshBooleanParams,
  MeshBuffers,
  MeshDecimateParams,
  MeshHollowParams,
  MeshInitOptions,
  MeshMirrorParams,
  MeshPlaneCutParams,
  MeshTransformParams,
  StlImportOptions,
} from '../types';
import type { CrossDomainOperand } from '../crossDomainBoolean';
import type { MeshWorkerApi } from './mesh-service';
import type { TransferEnvelope } from './comlink';
import type { MeshWorkerCall, MeshWorkerResponse } from './host';

type PendingCall = {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
};

/**
 * MSH-3 ruling 3b (source fix for the declared-type/runtime-truth lie INT-3
 * found at its wiring layer): host.ts's handleMeshWorkerCall UNWRAPS every
 * TransferEnvelope (`post({ result: result.value }, transferables)`) BEFORE it
 * crosses postMessage, so a client Promise for a buffer-returning method
 * actually resolves to the plain payload `X`, never `TransferEnvelope<X>`. The
 * service-side `MeshWorkerApi` correctly declares the envelope-returning shape
 * (that IS what MeshService produces), so the CLIENT needs its OWN interface:
 * MeshWorkerApi with every `Promise<TransferEnvelope<X>>` return collapsed to
 * `Promise<X>`. This is the exact unwrapped truth INT-3's meshClient.ts wrapper
 * verified empirically (a loopback probe: `'__meshComlinkTransfer' in result`
 * was false); we encode it at the source so consumers no longer need casts.
 * The public METHOD SET (names + argument lists) is byte-for-byte unchanged —
 * only the declared RETURN types are corrected.
 */
type UnwrapEnvelope<T> = T extends Promise<TransferEnvelope<infer V>> ? Promise<V> : T;

export type MeshWorkerClientApi = {
  [K in keyof MeshWorkerApi]: MeshWorkerApi[K] extends (...args: infer A) => infer R
    ? (...args: A) => UnwrapEnvelope<R>
    : never;
};

function meshTransfers(mesh: MeshBuffers): Transferable[] {
  return [mesh.positions.buffer as ArrayBuffer, mesh.indices.buffer as ArrayBuffer];
}

export class MeshWorkerClient implements MeshWorkerClientApi {
  private readonly worker: Worker;
  private readonly pending = new Map<number, PendingCall>();
  private nextRequestId = 1;

  constructor(worker: Worker) {
    this.worker = worker;
    this.worker.addEventListener('message', (event: MessageEvent<MeshWorkerResponse>) => this.handleResponse(event.data));
  }

  init(options?: MeshInitOptions) {
    return this.call('init', [options]) as ReturnType<MeshWorkerClientApi['init']>;
  }

  dispose() {
    return this.call('dispose', []) as ReturnType<MeshWorkerClientApi['dispose']>;
  }

  importStl(bytes: ArrayBuffer, options?: StlImportOptions) {
    return this.call('importStl', [bytes, options], [bytes]) as ReturnType<MeshWorkerClientApi['importStl']>;
  }

  /**
   * Transfers the input mesh buffers to the worker; callers must treat the mesh as consumed.
   */
  exportStl(mesh: MeshBuffers) {
    return this.call('exportStl', [mesh], meshTransfers(mesh)) as ReturnType<MeshWorkerClientApi['exportStl']>;
  }

  analyze(mesh: MeshBuffers, options?: MeshAnalyzeOptions) {
    return this.call('analyze', [mesh, options]) as ReturnType<MeshWorkerClientApi['analyze']>;
  }

  /**
   * Transfers the input mesh buffers to the worker; callers must treat the mesh as consumed.
   */
  repair(mesh: MeshBuffers) {
    return this.call('repair', [mesh], meshTransfers(mesh)) as ReturnType<MeshWorkerClientApi['repair']>;
  }

  measure(mesh: MeshBuffers) {
    return this.call('measure', [mesh]) as ReturnType<MeshWorkerClientApi['measure']>;
  }

  boolean(mesh: MeshBuffers, other: MeshBuffers, params: MeshBooleanParams) {
    return this.call('boolean', [mesh, other, params], [...meshTransfers(mesh), ...meshTransfers(other)]) as ReturnType<MeshWorkerClientApi['boolean']>;
  }

  /**
   * Transfers both operands' mesh buffers to the worker; callers must treat
   * both as consumed.
   */
  crossDomainBoolean(left: CrossDomainOperand, right: CrossDomainOperand, params: MeshBooleanParams) {
    return this.call(
      'crossDomainBoolean',
      [left, right, params],
      [...meshTransfers(left.mesh), ...meshTransfers(right.mesh)],
    ) as ReturnType<MeshWorkerClientApi['crossDomainBoolean']>;
  }

  planeCut(mesh: MeshBuffers, params: MeshPlaneCutParams) {
    return this.call('planeCut', [mesh, params], meshTransfers(mesh)) as ReturnType<MeshWorkerClientApi['planeCut']>;
  }

  hollow(mesh: MeshBuffers, params: MeshHollowParams) {
    return this.call('hollow', [mesh, params], meshTransfers(mesh)) as ReturnType<MeshWorkerClientApi['hollow']>;
  }

  mirror(mesh: MeshBuffers, params: MeshMirrorParams) {
    return this.call('mirror', [mesh, params], meshTransfers(mesh)) as ReturnType<MeshWorkerClientApi['mirror']>;
  }

  transform(mesh: MeshBuffers, params: MeshTransformParams) {
    return this.call('transform', [mesh, params], meshTransfers(mesh)) as ReturnType<MeshWorkerClientApi['transform']>;
  }

  decimate(mesh: MeshBuffers, params: MeshDecimateParams) {
    return this.call('decimate', [mesh, params], meshTransfers(mesh)) as ReturnType<MeshWorkerClientApi['decimate']>;
  }

  private call(method: MeshWorkerCall['method'], args: unknown[], transfer: Transferable[] = []): Promise<unknown> {
    const requestId = this.nextRequestId++;
    const message: MeshWorkerCall = { requestId, method, args };
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      this.worker.postMessage(message, transfer);
    });
  }

  private handleResponse(response: MeshWorkerResponse): void {
    const pending = this.pending.get(response.requestId);
    if (!pending) return;
    this.pending.delete(response.requestId);
    if (response.kind === 'error') {
      const err = new Error(response.message);
      err.name = response.name;
      if (response.stack) err.stack = response.stack;
      pending.reject(err);
      return;
    }
    pending.resolve(response.result);
  }
}
