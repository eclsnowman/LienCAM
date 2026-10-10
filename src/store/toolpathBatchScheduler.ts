import { operatorText } from '../i18n/locales/en/console-and-operator-messages'
import type { Operation } from '../types'

export interface ToolpathBatchJob {
  setupId: string
  opId: string
  operationType: Operation['type']
}

export function isCam3dBatchJob(job: ToolpathBatchJob): boolean {
  // Every family that runs through the cam3d worker (its synchronous wasm
  // calls freeze that thread, so the jobs are serialized): the raster finish,
  // the adaptive rougher, waterline finish, and composite finish.
  return job.operationType === 'parallel_3d' ||
    job.operationType === 'adaptive_3d' ||
    job.operationType === 'waterline_3d' ||
    job.operationType === 'steep_shallow_3d' ||
    job.operationType === 'scallop_3d' ||
    job.operationType === 'pencil_3d'
}

export interface SerializedCam3dComputeContext {
  isCancelled: () => boolean
}

interface Cam3dComputeEntry {
  cancelled: boolean
  promise: Promise<unknown>
}

interface Cam3dComputeGateState {
  tail: Promise<void>
  entries: Map<string, Cam3dComputeEntry>
}

// Keep the lane on globalThis so Vite HMR cannot create a fresh tail while a
// compute started by the previous module instance is still using the singleton
// CAM3D/model workers. Production also uses this same one-family lane.
const cam3dGateGlobal = globalThis as typeof globalThis & {
  __liencamCam3dComputeGate?: Cam3dComputeGateState
}
const cam3dComputeGate = cam3dGateGlobal.__liencamCam3dComputeGate ??= {
  tail: Promise.resolve(),
  entries: new Map<string, Cam3dComputeEntry>(),
}

export function hasSerializedCam3dCompute(key: string): boolean {
  return cam3dComputeGate.entries.has(key)
}

/**
 * Cancel a queued CAM3D entry and release its key for a replacement request.
 * The cancelled callback still reaches the head of the lane so its owner can
 * perform batch accounting, but isCancelled() prevents it from doing work.
 */
export function cancelSerializedCam3dCompute(key: string): boolean {
  const entry = cam3dComputeGate.entries.get(key)
  if (!entry) return false
  entry.cancelled = true
  cam3dComputeGate.entries.delete(key)
  return true
}

/** Invalidate every queued/running owner when the project identity changes. */
export function cancelAllSerializedCam3dComputes(): void {
  for (const entry of cam3dComputeGate.entries.values()) entry.cancelled = true
  cam3dComputeGate.entries.clear()
}

export function runSerializedCam3dCompute<T>(
  key: string,
  run: (context: SerializedCam3dComputeContext) => Promise<T>,
): Promise<T> {
  const existing = cam3dComputeGate.entries.get(key)
  if (existing) return existing.promise as Promise<T>

  const entry: Cam3dComputeEntry = {
    cancelled: false,
    promise: Promise.resolve(),
  }
  const scheduled = cam3dComputeGate.tail.then(() => run({
    isCancelled: () => entry.cancelled,
  }))
  entry.promise = scheduled
  cam3dComputeGate.entries.set(key, entry)
  cam3dComputeGate.tail = scheduled.then(() => undefined, () => undefined)
  const release = () => {
    if (cam3dComputeGate.entries.get(key) === entry) {
      cam3dComputeGate.entries.delete(key)
    }
  }
  scheduled.then(release, release)
  return scheduled
}

/**
 * Run Regen All with a small general worker pool. CAM3D family serialization is
 * enforced at the operation dispatch seam by runSerializedCam3dCompute so this
 * pool and individual Regenerate actions obey one application-wide invariant.
 */
export async function runToolpathBatchQueue(
  jobs: ToolpathBatchJob[],
  runJob: (job: ToolpathBatchJob) => Promise<void>,
  concurrency: number,
): Promise<void> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(operatorText('toolpathBatchScheduler1', { value1: String(concurrency) }))
  }

  let nextJobIndex = 0
  const runQueueLane = async () => {
    while (nextJobIndex < jobs.length) {
      const job = jobs[nextJobIndex++]
      await runJob(job)
    }
  }

  const laneCount = Math.min(concurrency, jobs.length)
  await Promise.all(Array.from({ length: laneCount }, runQueueLane))
}
