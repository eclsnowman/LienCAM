import { describe, expect, it } from 'vitest'
import {
  cancelAllSerializedCam3dComputes,
  cancelSerializedCam3dCompute,
  hasSerializedCam3dCompute,
  isCam3dBatchJob,
  runSerializedCam3dCompute,
  runToolpathBatchQueue,
  type ToolpathBatchJob,
} from '../../store/toolpathBatchScheduler'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

describe('toolpath batch scheduler', () => {
  it('keeps the general pool concurrent but never overlaps CAM3D operations', async () => {
    const parallelGate = deferred()
    const jobs: ToolpathBatchJob[] = [
      { setupId: 's', opId: '2d-a', operationType: 'contour_2d' },
      { setupId: 's', opId: 'parallel', operationType: 'parallel_3d' },
      { setupId: 's', opId: 'adaptive', operationType: 'adaptive_3d' },
      { setupId: 's', opId: 'waterline', operationType: 'waterline_3d' },
      { setupId: 's', opId: 'steep-shallow', operationType: 'steep_shallow_3d' },
      { setupId: 's', opId: 'scallop', operationType: 'scallop_3d' },
      { setupId: 's', opId: 'pencil', operationType: 'pencil_3d' },
      { setupId: 's', opId: '2d-b', operationType: 'pocket_2d' },
    ]
    const started: string[] = []
    let activeCam3d = 0
    let maxActiveCam3d = 0

    // The production predicate decides, so a family added there (WO-1176's
    // waterline) is counted here without a second hand-typed list.
    expect(isCam3dBatchJob({ setupId: 's', opId: 'w', operationType: 'waterline_3d' })).toBe(true)
    expect(isCam3dBatchJob({ setupId: 's', opId: 'ss', operationType: 'steep_shallow_3d' })).toBe(true)
    expect(isCam3dBatchJob({ setupId: 's', opId: 'sc', operationType: 'scallop_3d' })).toBe(true)
    expect(isCam3dBatchJob({ setupId: 's', opId: 'pc', operationType: 'pencil_3d' })).toBe(true)
    expect(isCam3dBatchJob({ setupId: 's', opId: 'c', operationType: 'contour_2d' })).toBe(false)
    const execute = async (job: ToolpathBatchJob) => {
      started.push(job.opId)
      if (!isCam3dBatchJob(job)) return
      activeCam3d++
      maxActiveCam3d = Math.max(maxActiveCam3d, activeCam3d)
      try {
        if (job.opId === 'parallel') await parallelGate.promise
      } finally {
        activeCam3d--
      }
    }
    const run = runToolpathBatchQueue(
      jobs,
      (job) => isCam3dBatchJob(job)
        ? runSerializedCam3dCompute(`scheduler:${job.opId}`, () => execute(job))
        : execute(job),
      3,
    )

    await Promise.resolve()
    await Promise.resolve()
    expect(started).toContain('parallel')
    expect(started).toContain('2d-a')
    expect(started).not.toContain('adaptive')
    expect(started).not.toContain('waterline')

    parallelGate.resolve()
    await run

    expect(started).toContain('adaptive')
    expect(started).toContain('waterline')
    expect(started).toContain('steep-shallow')
    expect(started).toContain('2d-b')
    expect(maxActiveCam3d).toBe(1)
  })

  it('deduplicates repeated requests for the same queued or active CAM3D operation', async () => {
    const gate = deferred()
    let runCount = 0
    const first = runSerializedCam3dCompute('dedupe-op', async () => {
      runCount++
      await gate.promise
      return 'first'
    })
    const duplicate = runSerializedCam3dCompute('dedupe-op', async () => {
      runCount++
      return 'duplicate'
    })

    expect(duplicate).toBe(first)
    expect(hasSerializedCam3dCompute('dedupe-op')).toBe(true)
    gate.resolve()
    await expect(first).resolves.toBe('first'
    )
    expect(runCount).toBe(1)
    expect(hasSerializedCam3dCompute('dedupe-op')).toBe(false)
  })

  it('lets a cancelled queued request account for itself without blocking a replacement', async () => {
    const blocker = deferred()
    const blockingRun = runSerializedCam3dCompute('cancel-blocker', async () => {
      await blocker.promise
    })
    let cancelledContext = false
    const cancelledRun = runSerializedCam3dCompute('cancel-op', async ({ isCancelled }) => {
      cancelledContext = isCancelled()
      return 'cancelled-owner-finished'
    })

    expect(cancelSerializedCam3dCompute('cancel-op')).toBe(true)
    const replacementRun = runSerializedCam3dCompute('cancel-op', async ({ isCancelled }) => {
      expect(isCancelled()).toBe(false)
      return 'replacement'
    })

    blocker.resolve()
    await blockingRun
    await expect(cancelledRun).resolves.toBe('cancelled-owner-finished')
    await expect(replacementRun).resolves.toBe('replacement')
    expect(cancelledContext).toBe(true)
    expect(hasSerializedCam3dCompute('cancel-op')).toBe(false)
  })

  it('invalidates every project-owned entry while preserving lane order for replacements', async () => {
    const blocker = deferred()
    const active = runSerializedCam3dCompute('project-active', async ({ isCancelled }) => {
      await blocker.promise
      return isCancelled()
    })
    const queued = runSerializedCam3dCompute('project-queued', async ({ isCancelled }) => isCancelled())

    cancelAllSerializedCam3dComputes()
    const replacement = runSerializedCam3dCompute('project-queued', async ({ isCancelled }) => !isCancelled())
    blocker.resolve()

    await expect(active).resolves.toBe(true)
    await expect(queued).resolves.toBe(true)
    await expect(replacement).resolves.toBe(true)
  })

  it('rejects invalid concurrency instead of silently leaving a batch idle', async () => {
    await expect(runToolpathBatchQueue([], async () => {}, 0)).rejects.toThrow(/positive integer/i)
  })
})
