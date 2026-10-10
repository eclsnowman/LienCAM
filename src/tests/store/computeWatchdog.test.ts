import { afterEach, describe, expect, it, vi } from 'vitest'
import { createInactivityWatchdog } from '../../store/computeWatchdog'

afterEach(() => {
  vi.useRealTimers()
})

describe('compute inactivity watchdog', () => {
  it('resets its deadline on progress and fails loudly after inactivity', async () => {
    vi.useFakeTimers()
    const onTimeout = vi.fn()
    const watchdog = createInactivityWatchdog({
      label: 'Adaptive 3D',
      timeoutMs: 1000,
      onTimeout,
    })
    const observed = watchdog.failure.catch((error) => error as Error)

    watchdog.pulse('loading mesh')
    await vi.advanceTimersByTimeAsync(900)
    watchdog.pulse('generating rough')
    await vi.advanceTimersByTimeAsync(900)
    expect(onTimeout).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(100)
    const error = await observed
    expect(error.message).toMatch(/stalled for 1 seconds during generating rough/i)
    expect(onTimeout).toHaveBeenCalledOnce()
  })

  it('stops without producing a late rejection', async () => {
    vi.useFakeTimers()
    const onTimeout = vi.fn()
    const watchdog = createInactivityWatchdog({
      label: 'Parallel 3D',
      timeoutMs: 100,
      onTimeout,
    })
    watchdog.pulse('loading mesh')
    watchdog.stop()
    await vi.advanceTimersByTimeAsync(500)
    expect(onTimeout).not.toHaveBeenCalled()
  })

  it('supports a longer silent preprocessing allowance than compute progress', async () => {
    vi.useFakeTimers()
    const onTimeout = vi.fn()
    const watchdog = createInactivityWatchdog({
      label: 'Parallel 3D',
      timeoutMs: 100,
      onTimeout,
    })
    const observed = watchdog.failure.catch((error) => error as Error)

    watchdog.pulse('loading mesh', 1000)
    await vi.advanceTimersByTimeAsync(999)
    expect(onTimeout).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)

    const error = await observed
    expect(error.message).toMatch(/stalled for 1 seconds during loading mesh/i)
    expect(onTimeout).toHaveBeenCalledOnce()
  })
})
