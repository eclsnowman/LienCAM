import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildContractEvents } from '../../lib/machine/machineSession'
import { useMachineControl } from '../../store/machineControlStore'
import type { StreamerProgress } from '../../lib/machine/controller'

const progress = (acked: number, phase: StreamerProgress['phase'] = 'streaming'): StreamerProgress => ({
  phase, totalLines: 100, sentLines: 100, ackedLines: acked,
  ackedSourceLine: acked, sentSourceLine: 100, bytesInFlight: 0,
})
afterEach(() => { vi.useRealTimers() })
describe('WO-2607 trailing progress publication', () => {
  it('does not let a trailing update overwrite the session-restored kept program', async () => {
    vi.useFakeTimers()
    const events = buildContractEvents()
    events.onJobProgress!(progress(1))
    events.onJobProgress!(progress(2))
    useMachineControl.getState().applyJobProgress(progress(1, 'ready'))
    const restored = useMachineControl.getState().job
    await vi.advanceTimersByTimeAsync(100)
    expect(useMachineControl.getState().job).toBe(restored)
  })
  it('keeps the receive window when its last trailing value is published', async () => {
    vi.useFakeTimers()
    const events = buildContractEvents()
    events.onJobProgress!(progress(1))
    events.onJobProgress!(progress(2))
    await vi.advanceTimersByTimeAsync(101)
    events.onJobProgress!(progress(3))
    expect(useMachineControl.getState().job.ackedLines).toBe(3)
  })
  it('publishes the newest update at the trailing edge without another backend update', async () => {
    vi.useFakeTimers()
    const events = buildContractEvents()
    events.onJobProgress!(progress(1))
    await vi.advanceTimersByTimeAsync(20)
    events.onJobProgress!(progress(2))
    await vi.advanceTimersByTimeAsync(20)
    events.onJobProgress!(progress(3))
    expect(useMachineControl.getState().job.ackedLines).toBe(1)
    await vi.advanceTimersByTimeAsync(60)
    expect(useMachineControl.getState().job.ackedLines).toBe(3)
    await vi.advanceTimersByTimeAsync(500)
    expect(useMachineControl.getState().job.ackedLines).toBe(3)
  })
  it('a phase edge replaces a pending update and cannot be regressed by its timer', async () => {
    vi.useFakeTimers()
    const events = buildContractEvents()
    events.onJobProgress!(progress(1))
    events.onJobProgress!(progress(2))
    events.onJobProgress!(progress(3, 'paused'))
    expect(useMachineControl.getState().job).toMatchObject({ phase: 'paused', ackedLines: 3 })
    await vi.advanceTimersByTimeAsync(100)
    expect(useMachineControl.getState().job).toMatchObject({ phase: 'paused', ackedLines: 3 })
  })
  it('a stopped lifecycle keeps its final cursor and cancels the old streaming timer', async () => {
    vi.useFakeTimers()
    const events = buildContractEvents()
    events.onJobProgress!(progress(1))
    events.onJobProgress!(progress(2))
    events.onJobEvent!('stopped', null)
    const job = useMachineControl.getState().job
    expect(job.ackedLines).toBe(2)
    await vi.advanceTimersByTimeAsync(100)
    expect(useMachineControl.getState().job).toEqual(job)
  })
  it('disconnect cancels the pending publication', async () => {
    vi.useFakeTimers()
    const events = buildContractEvents()
    events.onJobProgress!(progress(1))
    events.onJobProgress!(progress(2))
    events.onConnectionPhase!('disconnected', null)
    const job = useMachineControl.getState().job
    await vi.advanceTimersByTimeAsync(100)
    expect(useMachineControl.getState().job).toEqual(job)
  })
})

