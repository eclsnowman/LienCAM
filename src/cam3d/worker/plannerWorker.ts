// cam3d planner worker (WO-2096): runs the 2D adaptive planner for one Z-level
// component request at a time, for the adaptive rougher's planner pool
// (plannerPool.ts). Spawned from the cam3d worker:
//   new Worker(new URL('./plannerWorker.ts', import.meta.url), { type: 'module' })
// The request and the result cross by structured clone, which keeps every
// number's bits and every shared reference inside the value, so the result is
// the one processFeature would return in the cam3d worker itself.

import { ensureEngineClipperReady, processFeature } from '../rough/engineEntry';
import type { PlannerWorkerRequest, PlannerWorkerResponse } from './plannerPool';

self.onmessage = async (event: MessageEvent<PlannerWorkerRequest>) => {
  let response: PlannerWorkerResponse;
  try {
    await ensureEngineClipperReady();
    const { feature, params } = event.data.request;
    response = { ok: true, result: processFeature(feature, params) };
  } catch (error) {
    response = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  try {
    self.postMessage(response);
  } catch (error) {
    // A result structured clone rejects (DataCloneError): the pool rejects the
    // request and the rougher plans it in-line.
    self.postMessage({ ok: false, error: String(error) });
  }
};
