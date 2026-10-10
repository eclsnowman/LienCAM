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
import { isTransferEnvelope } from './comlink';
import type { MeshWorkerApi } from './mesh-service';

export type MeshWorkerMethod = keyof MeshWorkerApi;

export interface MeshWorkerCall {
  requestId: number;
  method: MeshWorkerMethod;
  args: unknown[];
}

export type MeshWorkerResponse =
  | { kind: 'result'; requestId: number; result: unknown }
  | { kind: 'error'; requestId: number; name: string; message: string; stack?: string };

export type MeshWorkerPost = (response: MeshWorkerResponse, transfer?: Transferable[]) => void;

export interface MeshWorkerScope {
  addEventListener(type: 'message', listener: (event: MessageEvent<MeshWorkerCall>) => void): void;
  postMessage(message: MeshWorkerResponse, transfer?: Transferable[]): void;
}

function errorResponse(requestId: number, err: unknown): MeshWorkerResponse {
  if (err instanceof Error) {
    return {
      kind: 'error',
      requestId,
      name: err.name,
      message: err.message,
      ...(err.stack !== undefined ? { stack: err.stack } : {}),
    };
  }
  return { kind: 'error', requestId, name: 'Error', message: String(err) };
}

async function invoke(api: MeshWorkerApi, call: MeshWorkerCall): Promise<unknown> {
  switch (call.method) {
    case 'init':
      return api.init(call.args[0] as MeshInitOptions | undefined);
    case 'dispose':
      return api.dispose();
    case 'importStl':
      return api.importStl(call.args[0] as ArrayBuffer, call.args[1] as StlImportOptions | undefined);
    case 'exportStl':
      return api.exportStl(call.args[0] as MeshBuffers);
    case 'analyze':
      return api.analyze(call.args[0] as MeshBuffers, call.args[1] as MeshAnalyzeOptions | undefined);
    case 'repair':
      return api.repair(call.args[0] as MeshBuffers);
    case 'measure':
      return api.measure(call.args[0] as MeshBuffers);
    case 'boolean':
      return api.boolean(call.args[0] as MeshBuffers, call.args[1] as MeshBuffers, call.args[2] as MeshBooleanParams);
    case 'crossDomainBoolean':
      return api.crossDomainBoolean(call.args[0] as CrossDomainOperand, call.args[1] as CrossDomainOperand, call.args[2] as MeshBooleanParams);
    case 'planeCut':
      return api.planeCut(call.args[0] as MeshBuffers, call.args[1] as MeshPlaneCutParams);
    case 'hollow':
      return api.hollow(call.args[0] as MeshBuffers, call.args[1] as MeshHollowParams);
    case 'mirror':
      return api.mirror(call.args[0] as MeshBuffers, call.args[1] as MeshMirrorParams);
    case 'transform':
      return api.transform(call.args[0] as MeshBuffers, call.args[1] as MeshTransformParams);
    case 'decimate':
      return api.decimate(call.args[0] as MeshBuffers, call.args[1] as MeshDecimateParams);
  }
}

export async function handleMeshWorkerCall(api: MeshWorkerApi, call: MeshWorkerCall, post: MeshWorkerPost): Promise<void> {
  try {
    const result = await invoke(api, call);
    if (isTransferEnvelope(result)) {
      post({ kind: 'result', requestId: call.requestId, result: result.value }, result.transferables);
      return;
    }
    post({ kind: 'result', requestId: call.requestId, result });
  } catch (err) {
    post(errorResponse(call.requestId, err));
  }
}

export function exposeMeshWorker(api: MeshWorkerApi, scope: MeshWorkerScope = self as unknown as MeshWorkerScope): void {
  scope.addEventListener('message', (event) => {
    void handleMeshWorkerCall(api, event.data, (message, transfer) => scope.postMessage(message, transfer));
  });
}
