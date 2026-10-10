// MSH-4-BOOLEAN-EDIT: the MAIN-APP mesh worker entry (the product's first mesh
// worker, distinct from the dev-only MeshLab lab worker). Identical rationale to
// src/components/meshlab/meshLabWorker.ts: the frozen default manifold factory
// resolves 'manifold-3d' via `new Function('return import(...))`, invisible to
// Vite's import-analysis, which fails in a real browser. This entry composes the
// same frozen exports with a real `import('manifold-3d')` expression Vite can see
// and pre-bundle. src/components/meshlab/* is lab territory, so the product gets
// its OWN neutral entry here in src/mesh/ (used by src/mesh/browserMeshClient.ts)
// rather than importing across the component boundary.
import { createMeshWorkerApi, exposeMeshWorker } from '../index'
import type { ManifoldFactory, ManifoldWasmModule } from '../manifoldKernel'

const browserManifoldFactory: ManifoldFactory = async (options) => {
  const pkg = (await import('manifold-3d')) as
    | { default?: (opts?: unknown) => Promise<ManifoldWasmModule> }
    | ((opts?: unknown) => Promise<ManifoldWasmModule>)
  const factory = typeof pkg === 'function' ? pkg : pkg.default
  if (factory === undefined) throw new Error('manifold-3d default factory export was not found')
  return factory(options ?? {})
}

exposeMeshWorker(createMeshWorkerApi({ manifoldFactory: browserManifoldFactory }))
