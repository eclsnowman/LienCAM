import { analyzeMesh, measureMesh, repairMesh } from '../analysis';
import {
  booleanMesh,
  decimateMesh,
  hollowMesh,
  mirrorMesh,
  planeCutMesh,
  transformMesh,
} from '../manifoldOps';
import { crossDomainBooleanMesh, type CrossDomainBooleanResult, type CrossDomainOperand } from '../crossDomainBoolean';
import { importStl, exportBinaryStl } from '../stl';
import { ManifoldKernel, type ManifoldFactory } from '../manifoldKernel';
import type {
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
} from '../types';
import { Comlink, type TransferEnvelope } from './comlink';

export interface MeshWorkerApi {
  init(options?: MeshInitOptions): Promise<MeshKernelInfo>;
  dispose(): Promise<{ disposed: true }>;
  importStl(bytes: ArrayBuffer, options?: StlImportOptions): Promise<TransferEnvelope<StlImportResult>>;
  exportStl(mesh: MeshBuffers): Promise<TransferEnvelope<StlExportResult>>;
  analyze(mesh: MeshBuffers, options?: MeshAnalyzeOptions): Promise<MeshHealthReport>;
  repair(mesh: MeshBuffers): Promise<TransferEnvelope<MeshRepairResult>>;
  measure(mesh: MeshBuffers): Promise<MeshMeasureResult>;
  boolean(mesh: MeshBuffers, other: MeshBuffers, params: MeshBooleanParams): Promise<TransferEnvelope<MeshOperationResult>>;
  crossDomainBoolean(left: CrossDomainOperand, right: CrossDomainOperand, params: MeshBooleanParams): Promise<TransferEnvelope<CrossDomainBooleanResult>>;
  planeCut(mesh: MeshBuffers, params: MeshPlaneCutParams): Promise<TransferEnvelope<MeshPlaneCutResult>>;
  hollow(mesh: MeshBuffers, params: MeshHollowParams): Promise<TransferEnvelope<MeshOperationResult>>;
  mirror(mesh: MeshBuffers, params: MeshMirrorParams): Promise<TransferEnvelope<MeshOperationResult>>;
  transform(mesh: MeshBuffers, params: MeshTransformParams): Promise<TransferEnvelope<MeshOperationResult>>;
  decimate(mesh: MeshBuffers, params: MeshDecimateParams): Promise<TransferEnvelope<MeshOperationResult>>;
}

export interface MeshWorkerApiOptions {
  manifoldFactory?: ManifoldFactory;
}

function meshTransfers(mesh: MeshBuffers): Transferable[] {
  return [mesh.positions.buffer as ArrayBuffer, mesh.indices.buffer as ArrayBuffer];
}

function operationTransfers(...results: Array<MeshOperationResult | undefined>): Transferable[] {
  return results.flatMap((result) => (result ? meshTransfers(result.mesh) : []));
}

export class MeshService implements MeshWorkerApi {
  private readonly kernel: ManifoldKernel;

  constructor(options: MeshWorkerApiOptions = {}) {
    this.kernel = new ManifoldKernel(options.manifoldFactory);
  }

  async init(options: MeshInitOptions = {}): Promise<MeshKernelInfo> {
    return this.kernel.init(options);
  }

  async dispose(): Promise<{ disposed: true }> {
    this.kernel.dispose();
    return { disposed: true };
  }

  async importStl(bytes: ArrayBuffer, options: StlImportOptions = {}): Promise<TransferEnvelope<StlImportResult>> {
    const result = importStl(bytes, options);
    return Comlink.transfer(result, meshTransfers(result.mesh));
  }

  async exportStl(mesh: MeshBuffers): Promise<TransferEnvelope<StlExportResult>> {
    const result = exportBinaryStl(mesh);
    return Comlink.transfer(result, [result.bytes]);
  }

  async analyze(mesh: MeshBuffers, options: MeshAnalyzeOptions = { checkSelfIntersections: false }): Promise<MeshHealthReport> {
    return analyzeMesh(mesh, options);
  }

  async repair(mesh: MeshBuffers): Promise<TransferEnvelope<MeshRepairResult>> {
    const result = repairMesh(mesh);
    return Comlink.transfer(result, meshTransfers(result.mesh));
  }

  async measure(mesh: MeshBuffers): Promise<MeshMeasureResult> {
    return measureMesh(mesh);
  }

  async boolean(mesh: MeshBuffers, other: MeshBuffers, params: MeshBooleanParams): Promise<TransferEnvelope<MeshOperationResult>> {
    const module = await this.kernel.getModule({ requireManifold: true });
    const result = booleanMesh(module, mesh, other, params);
    return Comlink.transfer(result, operationTransfers(result));
  }

  async crossDomainBoolean(
    left: CrossDomainOperand,
    right: CrossDomainOperand,
    params: MeshBooleanParams,
  ): Promise<TransferEnvelope<CrossDomainBooleanResult>> {
    const module = await this.kernel.getModule({ requireManifold: true });
    const result = crossDomainBooleanMesh(module, left, right, params);
    return Comlink.transfer(result, operationTransfers(result));
  }

  async planeCut(mesh: MeshBuffers, params: MeshPlaneCutParams): Promise<TransferEnvelope<MeshPlaneCutResult>> {
    const module = await this.kernel.getModule({ requireManifold: true });
    const result = planeCutMesh(module, mesh, params);
    return Comlink.transfer(result, operationTransfers(result.positive, result.negative));
  }

  async hollow(mesh: MeshBuffers, params: MeshHollowParams): Promise<TransferEnvelope<MeshOperationResult>> {
    const module = await this.kernel.getModule({ requireManifold: true });
    const result = hollowMesh(module, mesh, params);
    return Comlink.transfer(result, operationTransfers(result));
  }

  async mirror(mesh: MeshBuffers, params: MeshMirrorParams): Promise<TransferEnvelope<MeshOperationResult>> {
    const module = await this.kernel.getModule({ requireManifold: true });
    const result = mirrorMesh(module, mesh, params);
    return Comlink.transfer(result, operationTransfers(result));
  }

  async transform(mesh: MeshBuffers, params: MeshTransformParams): Promise<TransferEnvelope<MeshOperationResult>> {
    const module = await this.kernel.getModule({ requireManifold: true });
    const result = transformMesh(module, mesh, params);
    return Comlink.transfer(result, operationTransfers(result));
  }

  async decimate(mesh: MeshBuffers, params: MeshDecimateParams): Promise<TransferEnvelope<MeshOperationResult>> {
    const module = await this.kernel.getModule({ requireManifold: true });
    const result = decimateMesh(module, mesh, params);
    return Comlink.transfer(result, operationTransfers(result));
  }
}

export function createMeshWorkerApi(options: MeshWorkerApiOptions = {}): MeshWorkerApi {
  return new MeshService(options);
}
