import type { MachineControlState } from '../../store/machineControlStore'
import { useMachineControl } from '../../store/machineControlStore'

interface ElectronWakeLockHost {
  setJobWakeLock: (active: boolean) => void
}

interface BrowserWakeLockSentinel {
  release: () => Promise<void>
  addEventListener: (type: 'release', listener: () => void, options?: { once?: boolean }) => void
}

interface BrowserWakeLockApi {
  request: (type: 'screen') => Promise<BrowserWakeLockSentinel>
}

type WakeLockState = Pick<MachineControlState, 'connectionPhase' | 'job' | 'toolChange'>

interface WakeLockStateSource {
  getState: () => WakeLockState
  subscribe: (listener: (state: WakeLockState) => void) => () => void
}

function electronHost(): ElectronWakeLockHost | null {
  const host = (window as typeof window & { liencamHost?: Partial<ElectronWakeLockHost> }).liencamHost
  return typeof host?.setJobWakeLock === 'function' ? host as ElectronWakeLockHost : null
}

function browserWakeLock(): BrowserWakeLockApi | null {
  const wakeLock = (navigator as Navigator & { wakeLock?: BrowserWakeLockApi }).wakeLock
  return typeof wakeLock?.request === 'function' ? wakeLock : null
}

export function jobNeedsWakeLock(state: WakeLockState): boolean {
  if (state.connectionPhase !== 'connected') return false
  if (state.job.phase === 'streaming' || state.job.phase === 'paused') return true
  return state.toolChange !== null && state.toolChange.step !== 'failed'
}

/**
 * Mirrors the controller-neutral job lifecycle into the desktop host (or the
 * browser Screen Wake Lock API during browser-only development). The returned
 * cleanup is the renderer-side shutdown boundary and always releases a held
 * lock before unsubscribing.
 */
export function installJobWakeLock(
  source: WakeLockStateSource = useMachineControl,
): () => void {
  const host = electronHost()
  const browserApi = host === null ? browserWakeLock() : null
  let desired = false
  let disposed = false
  let requestPending = false
  let missingApiWarned = false
  let sentinel: BrowserWakeLockSentinel | null = null

  const releaseBrowserLock = async () => {
    const held = sentinel
    sentinel = null
    if (held === null) return
    try {
      await held.release()
      console.info('LienCAM: no longer keeping this PC awake; the job is not running.')
    } catch (error) {
      console.warn('[LienCAM] Could not release the browser job wake lock:', error)
    }
  }

  const requestBrowserLock = async () => {
    if (disposed || !desired || requestPending || sentinel !== null) return
    if (browserApi === null) {
      if (!missingApiWarned) {
        missingApiWarned = true
        console.warn(
          '[LienCAM] Could not keep this PC awake while the job runs: browser wake lock API is unavailable.',
        )
      }
      return
    }

    requestPending = true
    try {
      const acquired = await browserApi.request('screen')
      sentinel = acquired
      acquired.addEventListener('release', () => {
        if (sentinel === acquired) sentinel = null
      }, { once: true })
      console.info('LienCAM: keeping this PC awake while the job runs.')
      if (disposed || !desired) await releaseBrowserLock()
    } catch (error) {
      console.warn('[LienCAM] Could not keep this PC awake while the job runs:', error)
    } finally {
      requestPending = false
    }
  }

  const setDesired = (active: boolean) => {
    if (active === desired) return
    desired = active
    if (host !== null) {
      try {
        host.setJobWakeLock(active)
      } catch (error) {
        console.warn('[LienCAM] Could not change the desktop job wake lock:', error)
      }
      return
    }
    if (active) void requestBrowserLock()
    else void releaseBrowserLock()
  }

  const update = (state: WakeLockState) => setDesired(jobNeedsWakeLock(state))
  const onVisibilityChange = () => {
    if (document.visibilityState === 'visible' && desired && sentinel === null) {
      void requestBrowserLock()
    }
  }

  const unsubscribe = source.subscribe(update)
  document.addEventListener('visibilitychange', onVisibilityChange)
  update(source.getState())

  return () => {
    if (disposed) return
    disposed = true
    setDesired(false)
    document.removeEventListener('visibilitychange', onVisibilityChange)
    unsubscribe()
  }
}
