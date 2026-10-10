// cam3d integration (L6 bridge): the app's lazy-singleton Cam3dClient.
//
// Mirrors modelClient.ts's lazy-singleton discipline: the cam3d worker (and its
// wasm kernels) spins up ONCE on the first getCam3dClient() call and is reused
// for every later compute. The store's parallel_3d branch uses this so the
// worker is not respawned per operation. The worker entry + spawn shape is the
// same one the dev page uses (dev/devPage.ts spawnWorker).

import { Cam3dClient } from '../worker/client';

let client: Cam3dClient | null = null;

/** Spawn the real cam3d worker (module worker, wasm kernels inside). */
function spawnWorker(): Worker {
  return new Worker(new URL('../worker/cam3dWorker.ts', import.meta.url), {
    type: 'module',
  });
}

/**
 * The shared cam3d client. Constructed lazily on first use and reused
 * thereafter (one worker for the whole app session).
 */
export function getCam3dClient(): Cam3dClient {
  if (client) return client;
  // Cam3dClient accepts a Worker directly (WorkerLike is a structural subset of
  // the DOM Worker), constructing it lazily so no worker is spawned until the
  // first 3D compute actually runs.
  client = new Cam3dClient(spawnWorker());
  return client;
}

/**
 * Tear down the shared client (terminates the worker) and clear the singleton
 * so a later getCam3dClient() spins up a fresh one. Safe to call when none
 * exists.
 */
export function disposeCam3dClient(): void {
  if (!client) return;
  const c = client;
  client = null;
  // dispose() is async (fire-and-forget teardown); we do not await it here —
  // the client is already detached from the singleton, and dispose() never
  // rejects on a normal lifecycle. Swallow a late rejection defensively.
  void c.dispose().catch(() => {});
}
