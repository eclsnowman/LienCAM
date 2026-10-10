// cam3d worker entry -- deliberately THIN: all behavior lives in
// dispatcher.ts (testable without a worker). Consumers spawn this via:
//   new Worker(new URL('./cam3dWorker.ts', import.meta.url), { type: 'module' })
// (same convention as src/lib/cam/geometry/occt/model/modelWorker.ts).

import { Cam3dDispatcher } from './dispatcher';
import { BvhKernel } from '../kernel/bvhKernel';
import type { GeometryKernel } from '../kernel/types';
import type { Cam3dRequest, Cam3dResponse } from './protocol';
import { WorkerPlannerPool, type PlannerWorkerLike } from './plannerPool';

/**
 * The ONE place the worker picks its kernel implementation. BvhKernel is
 * the default finishing kernel per DECISIONS.md D-010 (exact-contact
 * flat/ball; OCL relegated to waterline + future exact bull/vbit).
 */
export function createWorkerKernel(): GeometryKernel {
  return new BvhKernel();
}

/**
 * WO-2096: the adaptive rougher's parallel Z-level planners. Workers spawn on
 * first use; two cores stay free for the page and this worker. A host that
 * cannot spawn a worker from a worker plans in-line, exactly as before.
 */
function createPlannerPool(): WorkerPlannerPool | undefined {
  if (typeof Worker !== 'function') return undefined;
  const size = Math.min(8, (self.navigator?.hardwareConcurrency ?? 2) - 2);
  if (size < 2) return undefined;
  return new WorkerPlannerPool(
    () => new Worker(new URL('./plannerWorker.ts', import.meta.url), {
      type: 'module',
    }) as unknown as PlannerWorkerLike,
    size,
  );
}

const plannerPool = createPlannerPool();
const dispatcher = new Cam3dDispatcher(
  createWorkerKernel(),
  (msg: Cam3dResponse, transfer?: Transferable[]) => {
    if (transfer) self.postMessage(msg, { transfer });
    else self.postMessage(msg);
  },
  plannerPool !== undefined ? { plannerPool } : {},
);

self.onmessage = (event: MessageEvent<Cam3dRequest>) => {
  dispatcher.handle(event.data);
};
