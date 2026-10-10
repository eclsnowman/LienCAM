import { operatorText } from '../i18n/locales/en/console-and-operator-messages'
export interface InactivityWatchdog {
  failure: Promise<never>
  pulse: (phase: string, timeoutOverrideMs?: number) => void
  stop: () => void
}

interface InactivityWatchdogOptions {
  label: string
  timeoutMs: number
  onTimeout?: () => void
}

/**
 * Reject when an async compute stage stops producing lifecycle activity.
 * Callers race `failure` against their real work and pulse at stage changes or
 * progress events. This converts a lost worker response into a named failure
 * instead of an operation that remains at 0% forever.
 */
export function createInactivityWatchdog({
  label,
  timeoutMs,
  onTimeout,
}: InactivityWatchdogOptions): InactivityWatchdog {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(operatorText('computeWatchdog1', { value1: String(timeoutMs) }))
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  let active = true
  let currentPhase: string = operatorText('computeWatchdog2')
  let currentTimeoutMs = timeoutMs
  let rejectFailure!: (error: Error) => void
  const failure = new Promise<never>((_resolve, reject) => { rejectFailure = reject })

  const clear = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }

  const pulse = (phase: string, timeoutOverrideMs?: number) => {
    if (!active) return
    currentPhase = phase
    currentTimeoutMs = timeoutOverrideMs ?? timeoutMs
    if (!Number.isFinite(currentTimeoutMs) || currentTimeoutMs <= 0) {
      throw new Error(operatorText('computeWatchdog3', { value1: String(currentTimeoutMs) }))
    }
    clear()
    timer = setTimeout(() => {
      if (!active) return
      active = false
      rejectFailure(new Error(
        operatorText('computeWatchdog4', { value1: String(label), value2: String(Math.round(currentTimeoutMs / 1000)), value3: String(currentPhase) }),
      ))
      onTimeout?.()
    }, currentTimeoutMs)
  }

  const stop = () => {
    active = false
    clear()
  }

  return { failure, pulse, stop }
}
