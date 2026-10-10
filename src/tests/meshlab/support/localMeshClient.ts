// Test-only MeshClient: runs every op SYNCHRONOUSLY on the calling thread against the REAL
// src/mesh facade functions and a REAL manifold-3d module (dynamic import resolves fine under
// vitest/Node, same as it does under vite-node -- see coordination/reports/INT-3.report.json's
// benches). Mirrors src/geom/index.ts's createLocalGeomService pattern: component tests need an
// injectable client that never constructs a real Worker (jsdom either lacks Worker entirely or
// can't load a module worker's bundled graph), but a hand-rolled fake with canned results would
// test nothing real. This exercises the ACTUAL analyze/repair/boolean/hollow/decimate math, just
// off the worker thread.
import {
  analyzeMesh,
  booleanMesh,
  crossDomainBooleanMesh,
  decimateMesh,
  exportBinaryStl,
  hollowMesh,
  importStl,
  measureMesh,
  mirrorMesh,
  ManifoldKernel,
  planeCutMesh,
  repairMesh,
  transformMesh,
} from '../../../mesh'
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
} from '../../../mesh'
import type { ManifoldWasmModule } from '../../../mesh/manifoldKernel'
import type { MeshClient } from '../../../components/meshlab'

async function nodeManifoldFactory(): Promise<ManifoldWasmModule> {
  const pkg = (await import('manifold-3d')) as { default?: (opts?: unknown) => Promise<ManifoldWasmModule> } | ((opts?: unknown) => Promise<ManifoldWasmModule>)
  const factory = typeof pkg === 'function' ? pkg : pkg.default
  if (factory === undefined) throw new Error('manifold-3d default factory export was not found')
  return factory({})
}

export function createLocalMeshClient(): MeshClient {
  const kernel = new ManifoldKernel(nodeManifoldFactory)

  return {
    async init(options?: MeshInitOptions): Promise<MeshKernelInfo> {
      return kernel.init(options)
    },
    async dispose(): Promise<{ disposed: true }> {
      kernel.dispose()
      return { disposed: true }
    },
    // No real Worker in this off-thread test client -- nothing to terminate.
    terminate(): void {},
    async importStl(bytes: ArrayBuffer, options?: StlImportOptions): Promise<StlImportResult> {
      return importStl(bytes, options)
    },
    async exportStl(mesh: MeshBuffers): Promise<StlExportResult> {
      return exportBinaryStl(mesh)
    },
    async analyze(mesh: MeshBuffers, options?: MeshAnalyzeOptions): Promise<MeshHealthReport> {
      return analyzeMesh(mesh, options)
    },
    async repair(mesh: MeshBuffers): Promise<MeshRepairResult> {
      return repairMesh(mesh)
    },
    async measure(mesh: MeshBuffers): Promise<MeshMeasureResult> {
      return measureMesh(mesh)
    },
    async boolean(mesh: MeshBuffers, other: MeshBuffers, params: MeshBooleanParams): Promise<MeshOperationResult> {
      const module = await kernel.getModule({ requireManifold: true })
      return booleanMesh(module, mesh, other, params)
    },
    async crossDomainBoolean(left: CrossDomainOperand, right: CrossDomainOperand, params: MeshBooleanParams): Promise<CrossDomainBooleanResult> {
      const module = await kernel.getModule({ requireManifold: true })
      return crossDomainBooleanMesh(module, left, right, params)
    },
    async planeCut(mesh: MeshBuffers, params: MeshPlaneCutParams): Promise<MeshPlaneCutResult> {
      const module = await kernel.getModule({ requireManifold: true })
      return planeCutMesh(module, mesh, params)
    },
    async hollow(mesh: MeshBuffers, params: MeshHollowParams): Promise<MeshOperationResult> {
      const module = await kernel.getModule({ requireManifold: true })
      return hollowMesh(module, mesh, params)
    },
    async mirror(mesh: MeshBuffers, params: MeshMirrorParams): Promise<MeshOperationResult> {
      const module = await kernel.getModule({ requireManifold: true })
      return mirrorMesh(module, mesh, params)
    },
    async transform(mesh: MeshBuffers, params: MeshTransformParams): Promise<MeshOperationResult> {
      const module = await kernel.getModule({ requireManifold: true })
      return transformMesh(module, mesh, params)
    },
    async decimate(mesh: MeshBuffers, params: MeshDecimateParams): Promise<MeshOperationResult> {
      const module = await kernel.getModule({ requireManifold: true })
      return decimateMesh(module, mesh, params)
    },
  }
}
