// MSH-4-BOOLEAN-EDIT: the MAIN-APP (non-lab) mesh worker singleton.
//
// The product has never run a mesh worker before (the manifold pipeline lived
// only in the dev MeshLab lab). This stands up ONE lazy instance, created on
// first use and disposed on project reset (newProject) - the same lazy-singleton
// lifecycle the geom facade uses. The heavy manifold boolean stays off the main
// thread (browser-headroom law); parsing/exporting STL is cheap and stays on the
// main thread (src/mesh/stl.ts).
//
// TEST SEAM: getCrossDomainBooleanRunner() returns an override when one is set,
// so a unit test injects a real-manifold runner that needs no Worker (jsdom
// cannot reliably spawn module Workers) - the MSH-4-MESHLAB-PROOF pattern.
import { MeshWorkerClient } from './worker/client'
import type { CrossDomainBooleanResult, CrossDomainOperand } from './crossDomainBoolean'
import type { MeshBooleanParams } from './types'

/** The single method the boolean-mesh-vs-model-body store action needs. */
export interface CrossDomainBooleanRunner {
  crossDomainBoolean(
    left: CrossDomainOperand,
    right: CrossDomainOperand,
    params: MeshBooleanParams,
  ): Promise<CrossDomainBooleanResult>
}

let singleton: { worker: Worker; client: MeshWorkerClient } | null = null
let runnerOverride: CrossDomainBooleanRunner | null = null

/** Lazily creates the app mesh worker + client on first use; idempotent after. */
export function getBrowserMeshClient(): MeshWorkerClient {
  if (singleton === null) {
    const worker = new Worker(new URL('./worker/browser-mesh-worker.ts', import.meta.url), {
      type: 'module',
    })
    singleton = { worker, client: new MeshWorkerClient(worker) }
  }
  return singleton.client
}

/** The runner the store action uses: a test override if set, else the real
 *  worker-backed client. MeshWorkerClient satisfies CrossDomainBooleanRunner. */
export function getCrossDomainBooleanRunner(): CrossDomainBooleanRunner {
  return runnerOverride ?? getBrowserMeshClient()
}

/** Inject (or clear with null) a Worker-free real-manifold runner for tests. */
export function setCrossDomainBooleanRunnerForTests(runner: CrossDomainBooleanRunner | null): void {
  runnerOverride = runner
}

/** Terminate + drop the worker singleton (called on project reset). Idempotent;
 *  never touches a test override. */
export function disposeBrowserMeshClient(): void {
  if (singleton !== null) {
    singleton.worker.terminate()
    singleton = null
  }
}
