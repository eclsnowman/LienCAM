// @vitest-environment jsdom

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import nodePath from 'node:path'
import nodeProcess from 'node:process'
import vm from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  installJobWakeLock,
  jobNeedsWakeLock,
} from '../../lib/machine/jobWakeLock'
import { useMachineControl } from '../../store/machineControlStore'
import {
  __resetEstopInterlockForTest,
  connectMachine,
  disconnectMachine,
  getMachineController,
  loadMachineProgram,
} from '../../lib/machine/machineSession'

type WakeState = Parameters<typeof jobNeedsWakeLock>[0]
type WakeStatePatch = Partial<Omit<WakeState, 'job'>> & { job?: Partial<WakeState['job']> }

const baseState = (): WakeState => ({
  connectionPhase: 'connected',
  job: {
    phase: 'ready',
    name: 'wo1080.nc',
    totalLines: 4,
    sentLines: 0,
    ackedLines: 0,
    ackedSourceLine: 0,
    sentSourceLine: 0,
    startedAt: null,
    pausedAt: null,
    error: null,
    toolChanges: [],
  },
  toolChange: null,
})

function source(initial = baseState()) {
  let state = initial
  const listeners = new Set<(next: WakeState) => void>()
  return {
    getState: () => state,
    subscribe(listener: (next: WakeState) => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    set(patch: WakeStatePatch) {
      state = {
        ...state,
        ...patch,
        job: patch.job ? { ...state.job, ...patch.job } : state.job,
      }
      listeners.forEach((listener) => listener(state))
    },
  }
}

function setElectronHost(setJobWakeLock: (active: boolean) => void) {
  Object.defineProperty(window, 'liencamHost', {
    configurable: true,
    value: { setJobWakeLock },
  })
}

function setBrowserWakeLock(request?: (type: 'screen') => Promise<unknown>) {
  Object.defineProperty(navigator, 'wakeLock', {
    configurable: true,
    value: request ? { request } : undefined,
  })
}

async function flushPromises() {
  await Promise.resolve()
  await Promise.resolve()
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  Reflect.deleteProperty(window, 'liencamHost')
  Reflect.deleteProperty(navigator, 'wakeLock')
})

describe('renderer job wake lock lifecycle', () => {
  it('holds one lock across stream, pause, guided tool-change hold, and resume', () => {
    const setJobWakeLock = vi.fn()
    setElectronHost(setJobWakeLock)
    const state = source()
    const cleanup = installJobWakeLock(state)

    state.set({ job: { phase: 'streaming' } })
    state.set({ job: { phase: 'streaming' } })
    state.set({ job: { phase: 'paused' } })
    state.set({
      job: { phase: 'ready' },
      toolChange: {
        step: 'awaiting-swap',
        mode: 'toolChange',
        tool: 2,
        resumeLine: 4,
        message: 'Change the tool.',
        warnings: [],
      },
    })
    state.set({ job: { phase: 'streaming' }, toolChange: null })
    state.set({ job: { phase: 'complete' } })

    expect(setJobWakeLock.mock.calls).toEqual([[true], [false]])
    cleanup()
  })

  it.each([
    ['complete', { job: { phase: 'complete' } }],
    ['stop/reset', { job: { phase: 'ready' } }],
    ['failure', { job: { phase: 'failed' } }],
    ['disconnect', { connectionPhase: 'disconnected' }],
  ] as const)('releases on %s', (_label, terminal) => {
    const setJobWakeLock = vi.fn()
    setElectronHost(setJobWakeLock)
    const state = source({ ...baseState(), job: { ...baseState().job, phase: 'streaming' } })
    const cleanup = installJobWakeLock(state)

    state.set(terminal)

    expect(setJobWakeLock.mock.calls).toEqual([[true], [false]])
    cleanup()
  })

  it('releases on renderer cleanup and ignores duplicate cleanup', () => {
    const setJobWakeLock = vi.fn()
    setElectronHost(setJobWakeLock)
    const state = source({ ...baseState(), job: { ...baseState().job, phase: 'paused' } })
    const cleanup = installJobWakeLock(state)

    cleanup()
    cleanup()
    state.set({ job: { phase: 'streaming' } })

    expect(setJobWakeLock.mock.calls).toEqual([[true], [false]])
  })

  it('releases a guided hold that fails', () => {
    const setJobWakeLock = vi.fn()
    setElectronHost(setJobWakeLock)
    const state = source()
    const cleanup = installJobWakeLock(state)

    state.set({
      toolChange: {
        step: 'awaiting-swap',
        mode: 'toolChange',
        tool: 2,
        resumeLine: 4,
        message: 'Change the tool.',
        warnings: [],
      },
    })
    state.set({
      toolChange: {
        step: 'failed',
        mode: 'toolChange',
        tool: 2,
        resumeLine: 4,
        message: 'Probe failed.',
        warnings: [],
      },
    })

    expect(setJobWakeLock.mock.calls).toEqual([[true], [false]])
    cleanup()
  })
})

describe('browser-only wake lock fallback', () => {
  it('takes one screen lock, releases it at terminal state, and logs both transitions', async () => {
    let onRelease = () => {}
    const sentinel = {
      addEventListener: vi.fn((_type: 'release', listener: () => void) => { onRelease = listener }),
      release: vi.fn(async () => { onRelease() }),
    }
    const request = vi.fn(async () => sentinel)
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    setBrowserWakeLock(request)
    const state = source()
    const cleanup = installJobWakeLock(state)

    state.set({ job: { phase: 'streaming' } })
    state.set({ job: { phase: 'paused' } })
    await flushPromises()
    expect(request).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledWith('screen')

    state.set({ job: { phase: 'complete' } })
    await flushPromises()
    expect(sentinel.release).toHaveBeenCalledTimes(1)
    expect(info.mock.calls.map(([line]) => line)).toEqual([
      'LienCAM: keeping this PC awake while the job runs.',
      'LienCAM: no longer keeping this PC awake; the job is not running.',
    ])
    cleanup()
  })

  it('re-acquires after the browser releases the lock while hidden', async () => {
    let releaseListener = () => {}
    const request = vi.fn(async () => ({
      addEventListener: (_type: 'release', listener: () => void) => { releaseListener = listener },
      release: vi.fn(async () => {}),
    }))
    vi.spyOn(console, 'info').mockImplementation(() => {})
    setBrowserWakeLock(request)
    const state = source()
    const cleanup = installJobWakeLock(state)
    state.set({ job: { phase: 'streaming' } })
    await flushPromises()

    releaseListener()
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    document.dispatchEvent(new Event('visibilitychange'))
    await flushPromises()

    expect(request).toHaveBeenCalledTimes(2)
    cleanup()
  })

  it('treats browser denial as a warning and never blocks the job lifecycle', async () => {
    const denied = new DOMException('Permission denied', 'NotAllowedError')
    setBrowserWakeLock(vi.fn(async () => { throw denied }))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const state = source()
    const cleanup = installJobWakeLock(state)

    expect(() => state.set({ job: { phase: 'streaming' } })).not.toThrow()
    await flushPromises()
    state.set({ job: { phase: 'complete' } })

    expect(warn).toHaveBeenCalledWith(
      '[LienCAM] Could not keep this PC awake while the job runs:',
      denied,
    )
    cleanup()
  })

  it('warns once when the browser API is absent', () => {
    setBrowserWakeLock()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const state = source()
    const cleanup = installJobWakeLock(state)

    state.set({ job: { phase: 'streaming' } })
    state.set({ job: { phase: 'paused' } })
    state.set({ job: { phase: 'complete' } })
    state.set({ job: { phase: 'streaming' } })

    expect(warn).toHaveBeenCalledTimes(1)
    cleanup()
  })
})

describe('Electron wake lock ownership', () => {
  it('preload exposes only a boolean job wake lock command', () => {
    const send = vi.fn()
    let exposed: Record<string, unknown> | null = null
    const code = readFileSync(nodePath.resolve('electron/preload.cjs'), 'utf8')
    vm.runInNewContext(code, {
      require: (id: string) => id === 'electron'
        ? {
            contextBridge: { exposeInMainWorld: (_name: string, api: Record<string, unknown>) => { exposed = api } },
            ipcRenderer: { invoke: vi.fn(), send },
          }
        : createRequire(import.meta.url)(id),
      process: { platform: 'win32', versions: { chrome: '1', electron: '1' } },
      Object,
    })

    expect(exposed).not.toBeNull()
    const setJobWakeLock = exposed!.setJobWakeLock as (active: unknown) => void
    setJobWakeLock(true)
    setJobWakeLock(false)
    setJobWakeLock('yes')
    expect(send.mock.calls).toEqual([
      ['liencam:set-job-wake-lock', true],
      ['liencam:set-job-wake-lock', false],
      ['liencam:set-job-wake-lock', false],
    ])
  })

  it('main owns one prevent-app-suspension blocker and releases it on app shutdown', () => {
    const ipcListeners = new Map<string, (event: unknown, active: unknown) => void>()
    const appListeners = new Map<string, () => void>()
    const started = new Set<number>()
    const start = vi.fn((_mode: string) => {
      started.add(71)
      return 71
    })
    const stop = vi.fn((id: number) => { started.delete(id) })
    const electron = {
      app: {
        isPackaged: false,
        on: (event: string, listener: () => void) => { appListeners.set(event, listener) },
        quit: vi.fn(),
        whenReady: () => ({ then: vi.fn() }),
      },
      BrowserWindow: { getAllWindows: () => [] },
      ipcMain: {
        handle: vi.fn(),
        on: (channel: string, listener: (event: unknown, active: unknown) => void) => {
          ipcListeners.set(channel, listener)
        },
      },
      Menu: { setApplicationMenu: vi.fn() },
      powerSaveBlocker: {
        isStarted: (id: number) => started.has(id),
        start,
        stop,
      },
      protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
    }
    const realRequire = createRequire(import.meta.url)
    const code = readFileSync(nodePath.resolve('electron/main.cjs'), 'utf8')
    vm.runInNewContext(code, {
      AbortSignal,
      Buffer,
      Response,
      URL,
      __dirname: nodePath.resolve('electron'),
      clearTimeout,
      console,
      fetch,
      process: nodeProcess,
      require: (id: string) => id === 'electron' ? electron : realRequire(id),
      setTimeout,
    })

    const setWakeLock = ipcListeners.get('liencam:set-job-wake-lock')!
    setWakeLock({ sender: {} }, true)
    setWakeLock({ sender: {} }, true)
    expect(start).toHaveBeenCalledTimes(1)
    expect(start).toHaveBeenCalledWith('prevent-app-suspension')

    setWakeLock({ sender: {} }, false)
    setWakeLock({ sender: {} }, false)
    expect(stop.mock.calls).toEqual([[71]])

    setWakeLock({ sender: {} }, true)
    appListeners.get('will-quit')!()
    expect(stop.mock.calls).toEqual([[71], [71]])
  })
})

describe('simulator console evidence', () => {
  it('prints the take and release lines around a real simulator job', async () => {
    vi.useFakeTimers()
    let releaseListener = () => {}
    const release = vi.fn(async () => { releaseListener() })
    setBrowserWakeLock(vi.fn(async () => ({
      addEventListener: (_type: 'release', listener: () => void) => { releaseListener = listener },
      release,
    })))

    const pendingConnect = connectMachine('simulator', 115200)
    await vi.advanceTimersByTimeAsync(300)
    await pendingConnect
    __resetEstopInterlockForTest()
    expect(getMachineController().setMachinePosition?.(getMachineController().status().machinePos!)).toBe(true)
    const cleanup = installJobWakeLock(useMachineControl)
    // WO-2712: a 1 mm machine-frame move from initial X-5 stays inside
    // stated travel and retains the two-second take/release lifecycle check.
    loadMachineProgram('wo1080-evidence.nc', 'G21\nG90\nG53 G1 X-6 F6000\nM30')

    expect(getMachineController().startJob()).toBe(true)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(useMachineControl.getState().job.phase).toBe('complete')
    expect(release).toHaveBeenCalledTimes(1)

    cleanup()
    const pendingDisconnect = disconnectMachine()
    await vi.advanceTimersByTimeAsync(100)
    await pendingDisconnect
  })
})
