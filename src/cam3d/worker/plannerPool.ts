// cam3d worker: a small pool of 2D planner workers for the adaptive rougher
// (WO-2096). The rougher's Z levels plan independently, and the 2D planner is
// most of an adaptive 3D operation's time; the pool runs those plans side by
// side. Each worker runs one request at a time; requests queue in order.
//
// A cancelled request leaves the queue, or -- if a worker is already planning
// it -- that worker is terminated and a fresh one is spawned on demand: the
// synchronous planner cannot be interrupted any other way. A failed worker is
// retired the same way and its request rejects, so the caller plans it itself.

import type { AdaptiveLevelPlanRequest, AdaptivePlannerPool } from '../rough/adaptivePlanCache';
import type { FeatureResult } from '../rough/engineEntry';

export interface PlannerWorkerRequest {
  request: AdaptiveLevelPlanRequest;
}

export type PlannerWorkerResponse =
  | { ok: true; result: FeatureResult }
  | { ok: false; error: string };

/** The slice of a Worker the pool uses (fakes in tests). */
export interface PlannerWorkerLike {
  onmessage: ((event: MessageEvent<PlannerWorkerResponse>) => void) | null;
  onerror: ((event: Event) => void) | null;
  postMessage(message: PlannerWorkerRequest): void;
  terminate(): void;
}

interface Task {
  readonly request: AdaptiveLevelPlanRequest;
  readonly resolve: (result: FeatureResult) => void;
  readonly reject: (error: Error) => void;
  worker?: PlannerWorkerLike;
}

function abortError(): Error {
  const error = new Error('planner pool: request cancelled');
  error.name = 'AbortError';
  return error;
}

export class WorkerPlannerPool implements AdaptivePlannerPool {
  private readonly spawn: () => PlannerWorkerLike;
  private readonly size: number;
  private readonly idle: PlannerWorkerLike[] = [];
  private readonly queue: Task[] = [];
  private readonly running = new Set<Task>();
  private live = 0;

  constructor(spawn: () => PlannerWorkerLike, size: number) {
    if (!Number.isInteger(size) || size < 1) {
      throw new Error(`WorkerPlannerPool: size must be a positive integer, got ${size}`);
    }
    this.spawn = spawn;
    this.size = size;
  }

  /** Workers currently alive (idle or planning). */
  get liveWorkers(): number {
    return this.live;
  }

  plan(request: AdaptiveLevelPlanRequest, signal?: AbortSignal): Promise<FeatureResult> {
    if (signal?.aborted) return Promise.reject(abortError());
    return new Promise<FeatureResult>((resolve, reject) => {
      const task: Task = { request, resolve, reject };
      signal?.addEventListener('abort', () => this.cancel(task), { once: true });
      this.queue.push(task);
      this.pump();
    });
  }

  /** Terminate every worker and reject everything still queued or running. */
  dispose(): void {
    for (const task of this.queue.splice(0)) task.reject(abortError());
    for (const task of [...this.running]) this.cancel(task);
    for (const worker of this.idle.splice(0)) this.retire(worker);
  }

  private pump(): void {
    while (this.queue.length > 0) {
      let worker = this.idle.pop();
      if (worker === undefined) {
        if (this.live >= this.size) return;
        worker = this.spawn();
        this.live++;
      }
      this.run(worker, this.queue.shift()!);
    }
  }

  private run(worker: PlannerWorkerLike, task: Task): void {
    task.worker = worker;
    this.running.add(task);
    worker.onmessage = (event) => {
      task.worker = undefined;
      this.running.delete(task);
      worker.onmessage = null;
      worker.onerror = null;
      this.idle.push(worker);
      const response = event.data;
      if (response.ok) task.resolve(response.result);
      else task.reject(new Error(`planner worker: ${response.error}`));
      this.pump();
    };
    worker.onerror = () => {
      task.worker = undefined;
      this.running.delete(task);
      this.retire(worker);
      task.reject(new Error('planner worker failed'));
      this.pump();
    };
    worker.postMessage({ request: task.request });
  }

  private cancel(task: Task): void {
    const queued = this.queue.indexOf(task);
    if (queued >= 0) {
      this.queue.splice(queued, 1);
      task.reject(abortError());
      return;
    }
    const worker = task.worker;
    if (worker === undefined) return; // already settled
    task.worker = undefined;
    this.running.delete(task);
    this.retire(worker);
    task.reject(abortError());
    this.pump();
  }

  private retire(worker: PlannerWorkerLike): void {
    worker.onmessage = null;
    worker.onerror = null;
    worker.terminate();
    this.live--;
  }
}
