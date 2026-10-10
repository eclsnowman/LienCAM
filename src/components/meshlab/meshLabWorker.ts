// WO INT-3: this lab's own mesh worker entry point.
//
// src/mesh/worker/mesh-worker.ts (frozen for this WO) calls exposeMeshWorker(createMeshWorkerApi())
// with the DEFAULT manifold factory (src/mesh/manifoldKernel.ts's defaultManifoldFactory), which
// resolves the 'manifold-3d' package via `new Function('specifier', 'return import(specifier)')`.
// That indirection was presumably chosen to dodge a bundler static-analysis issue, but it
// backfires in a REAL browser: Vite's import-analysis plugin rewrites/pre-bundles bare
// `import('manifold-3d')` calls it can see in source, but a specifier hidden inside a
// `new Function(...)` string is invisible to that analysis, so the browser is left trying to
// resolve the bare specifier "manifold-3d" directly and fails with "Failed to resolve module
// specifier 'manifold-3d'" -- confirmed against a real Chromium dev-server smoke run (see
// coordination/reports/INT-3.report.json). MSH-1/MSH-2's own verification only ever exercised
// this path from Node (vitest/vite-node), where bare-specifier resolution works natively, so the
// gap was never caught.
//
// src/mesh/** internals are frozen for this WO (ownership manifest: "interfaceConcerns" wiring
// issues are explicitly this WO's to solve, not MSH's). createMeshWorkerApi already accepts an
// injectable `manifoldFactory` (MeshWorkerApiOptions) for exactly this kind of override -- the
// frozen mesh-worker.ts entry just never passes one. This is this lab's OWN worker entry
// (src/components/meshlab/meshClient.ts points at it instead), composing the existing frozen
// exports with a real `import('manifold-3d')` expression that Vite CAN see and bundle correctly.
import { createMeshWorkerApi, exposeMeshWorker } from '../../mesh'
import type { ManifoldFactory, ManifoldWasmModule } from '../../mesh/manifoldKernel'

const browserManifoldFactory: ManifoldFactory = async (options) => {
  const pkg = (await import('manifold-3d')) as { default?: (opts?: unknown) => Promise<ManifoldWasmModule> } | ((opts?: unknown) => Promise<ManifoldWasmModule>)
  const factory = typeof pkg === 'function' ? pkg : pkg.default
  if (factory === undefined) throw new Error('manifold-3d default factory export was not found')
  return factory(options ?? {})
}

exposeMeshWorker(createMeshWorkerApi({ manifoldFactory: browserManifoldFactory }))
