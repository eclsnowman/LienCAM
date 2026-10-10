// WO INT-3: typed wrapper around MeshWorkerClient (src/mesh/worker/client.ts, frozen for this
// WO). MeshWorkerClient's own TypeScript signatures claim every buffer-returning method resolves
// to `Promise<TransferEnvelope<X>>` (see comlink.ts) -- but host.ts's handleMeshWorkerCall
// UNWRAPS the envelope (`post({ result: result.value }, result.transferables)`) before it ever
// crosses postMessage, so MeshWorkerClient.handleResponse actually resolves every pending call
// with the plain `X`, never the envelope. Confirmed empirically against a real manifold-3d
// worker loop (see coordination/reports/INT-3.report.json) before writing this file, not
// assumed. This is a real declared-type/runtime mismatch in frozen src/mesh/** code -- out of
// scope to fix there for this WO -- so it is corrected exactly ONCE, here, rather than via
// scattered `as unknown as X` casts through the rest of the lab.
import { MeshWorkerClient } from '../../mesh/worker/client'
import type {
  CrossDomainBooleanResult,
  CrossDomainOperand,
  MeshAnalyzeOptions,
  MeshBooleanParams,
  MeshBuffers,
  MeshDecimateParams,
  MeshHealthReport,
  MeshHollowParams,
  MeshInitOptions,
  MeshKernelInfo,
  MeshMeasureResult,
  MeshMirrorParams,
  MeshOperationResult,
  MeshPlaneCutParams,
  MeshPlaneCutResult,
  MeshRepairResult,
  MeshTransformParams,
  StlExportResult,
  StlImportOptions,
  StlImportResult,
} from '../../mesh'

export interface MeshClient {
  init(options?: MeshInitOptions): Promise<MeshKernelInfo>
  dispose(): Promise<{ disposed: true }>
  /** Terminates the underlying transport (the real Worker, for the worker-backed client) so no
   *  kernel/wasm state can outlive the client. See createMeshClient's header note. */
  terminate(): void
  importStl(bytes: ArrayBuffer, options?: StlImportOptions): Promise<StlImportResult>
  exportStl(mesh: MeshBuffers): Promise<StlExportResult>
  analyze(mesh: MeshBuffers, options?: MeshAnalyzeOptions): Promise<MeshHealthReport>
  repair(mesh: MeshBuffers): Promise<MeshRepairResult>
  measure(mesh: MeshBuffers): Promise<MeshMeasureResult>
  boolean(mesh: MeshBuffers, other: MeshBuffers, params: MeshBooleanParams): Promise<MeshOperationResult>
  /** MSH-4: boolean between a mesh operand and a tessellated-brep operand (at least one operand
   *  must be mesh-domain -- brep-vs-brep is refused by src/mesh/crossDomainBoolean.ts itself, and
   *  that refusal is surfaced here unchanged, never swallowed). */
  crossDomainBoolean(left: CrossDomainOperand, right: CrossDomainOperand, params: MeshBooleanParams): Promise<CrossDomainBooleanResult>
  planeCut(mesh: MeshBuffers, params: MeshPlaneCutParams): Promise<MeshPlaneCutResult>
  hollow(mesh: MeshBuffers, params: MeshHollowParams): Promise<MeshOperationResult>
  mirror(mesh: MeshBuffers, params: MeshMirrorParams): Promise<MeshOperationResult>
  transform(mesh: MeshBuffers, params: MeshTransformParams): Promise<MeshOperationResult>
  decimate(mesh: MeshBuffers, params: MeshDecimateParams): Promise<MeshOperationResult>
}

export function wrapMeshWorkerClient(worker: Worker): MeshClient {
  const client = new MeshWorkerClient(worker) as unknown as Omit<MeshClient, 'terminate'>
  // MeshWorkerClient (frozen src/mesh/**) has no terminate() -- it only knows how to post a
  // 'dispose' RPC call, not how to kill the Worker thread that hosts it. Only the CALLER of
  // this constructor (this module) actually holds the Worker reference, so terminate has to be
  // attached here rather than added to the frozen class.
  return Object.assign(client, { terminate: () => worker.terminate() }) as MeshClient
}

export function createMeshClient(): MeshClient {
  // Points at THIS lab's own worker entry (meshLabWorker.ts), not src/mesh/worker/mesh-worker.ts
  // -- see that file's header comment for why (real-browser manifold-3d module resolution).
  const worker = new Worker(new URL('./meshLabWorker.ts', import.meta.url), { type: 'module' })
  return wrapMeshWorkerClient(worker)
}
