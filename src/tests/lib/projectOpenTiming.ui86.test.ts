import { describe, expect, it, vi } from 'vitest'
import {
  createProjectOpenTimingRecorder,
  getLatestProjectOpenTimingSample,
  subscribeToProjectOpenTiming,
  type ProjectOpenTimingProgress,
} from '../../lib/perf/projectOpenTiming'

function clock(...values: number[]): () => number {
  let index = 0
  return () => values[Math.min(index++, values.length - 1)]
}

describe('UI-86 project-open timing core', () => {
  it('records phase order and deterministic wall-clock deltas until null finalizes', () => {
    const recorder = createProjectOpenTimingRecorder({ now: clock(10, 14, 20, 25) })

    recorder.observe({ requestId: 1, phase: 'reading-file' })
    recorder.observe({ requestId: 1, phase: 'validating-project' })
    recorder.observe({ requestId: 1, phase: 'installing-project' })
    expect(recorder.getLatestSample()).toBeNull()
    recorder.observe(null)

    expect(recorder.getLatestSample()).toEqual({
      outcome: 'ended',
      phases: [
        { phase: 'reading-file', durationMs: 4 },
        { phase: 'validating-project', durationMs: 6 },
        { phase: 'installing-project', durationMs: 5 },
      ],
      totalMs: 15,
    })
  })

  it('finalizes a superseded request without mixing its phases into the newer sample', () => {
    const samples: unknown[] = []
    const recorder = createProjectOpenTimingRecorder({
      now: clock(0, 5, 8, 12),
      onSample: (sample) => samples.push(sample),
    })

    recorder.observe({ requestId: 100, phase: 'reading-file' })
    recorder.observe({ requestId: 200, phase: 'validating-project' })
    recorder.observe({ requestId: 200, phase: 'restoring-scene' })
    recorder.observe(null)
    recorder.observe(null)

    expect(samples).toEqual([
      {
        outcome: 'superseded',
        phases: [{ phase: 'reading-file', durationMs: 5 }],
        totalMs: 5,
      },
      {
        outcome: 'ended',
        phases: [
          { phase: 'validating-project', durationMs: 3 },
          { phase: 'restoring-scene', durationMs: 4 },
        ],
        totalMs: 7,
      },
    ])
  })

  it('keeps every duration finite and nonnegative when the injected clock regresses', () => {
    const recorder = createProjectOpenTimingRecorder({ now: clock(9, 4, Number.NaN, Infinity) })
    recorder.observe({ requestId: 1, phase: 'reading-file' })
    recorder.observe({ requestId: 1, phase: 'validating-project' })
    recorder.observe({ requestId: 1, phase: 'restoring-scene' })
    recorder.observe(null)

    const sample = recorder.getLatestSample()
    expect(sample).not.toBeNull()
    for (const duration of [...sample!.phases.map((phase) => phase.durationMs), sample!.totalMs]) {
      expect(Number.isFinite(duration)).toBe(true)
      expect(duration).toBeGreaterThanOrEqual(0)
    }
  })

  it('starts safely mid-load, emits one sanitized summary, and cleans up its subscription', () => {
    let current: ProjectOpenTimingProgress | null = {
      requestId: 8675309,
      phase: 'restoring-checkpoints',
    }
    const listeners = new Set<(progress: ProjectOpenTimingProgress | null) => void>()
    const emitInfo = vi.fn()
    const unsubscribe = subscribeToProjectOpenTiming({
      getSnapshot: () => current,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    }, { now: clock(20, 26), emitInfo })

    current = null
    for (const listener of listeners) listener(current)
    for (const listener of listeners) listener(current)

    expect(emitInfo).toHaveBeenCalledTimes(1)
    expect(emitInfo.mock.calls[0][0]).toBe(
      'Project open timing (ended): restoring-checkpoints 6 ms; total 6 ms.',
    )
    expect(emitInfo.mock.calls[0][0]).not.toContain('8675309')
    expect(getLatestProjectOpenTimingSample()).toEqual({
      outcome: 'ended',
      phases: [{ phase: 'restoring-checkpoints', durationMs: 6 }],
      totalMs: 6,
    })

    unsubscribe()
    expect(listeners.size).toBe(0)
    current = { requestId: 2, phase: 'reading-file' }
    for (const listener of listeners) listener(current)
    expect(emitInfo).toHaveBeenCalledTimes(1)
  })
})
