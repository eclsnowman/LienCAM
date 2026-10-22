// WO-2911: the desktop app's own window picture for Report this problem.
// The preload exposes one argument-free call; the main process answers only
// its main window (a sender that is not it gets nothing). Same vm harness as
// jobWakeLock.wo1080.test.ts.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { electronMainRequire } from '../support/electronMainRequire'
import nodePath from 'node:path'
import nodeProcess from 'node:process'
import vm from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

describe('WO-2911 desktop app picture', () => {
  it('preload exposes captureApp, which invokes liencam:capture-app with no arguments', async () => {
    const invoke = vi.fn(async () => new Uint8Array([1]))
    let exposed: Record<string, unknown> | null = null
    vm.runInNewContext(readFileSync(nodePath.resolve('electron/preload.cjs'), 'utf8'), {
      require: (id: string) => id === 'electron'
        ? {
            contextBridge: { exposeInMainWorld: (_name: string, api: Record<string, unknown>) => { exposed = api } },
            ipcRenderer: { invoke, send: vi.fn() },
          }
        : createRequire(import.meta.url)(id),
      process: { platform: 'win32', versions: { chrome: '1', electron: '1' } },
      Object,
    })
    const captureApp = exposed!.captureApp as (...args: unknown[]) => Promise<unknown>
    await captureApp('C:\\anything', { evil: true })
    expect(invoke.mock.calls).toEqual([['liencam:capture-app']])
  })

  it('main registers the handler and answers a sender that is not its main window with nothing', async () => {
    const handlers = new Map<string, (event: unknown) => Promise<unknown>>()
    const electron = {
      app: { isPackaged: false, on: vi.fn(), quit: vi.fn(), whenReady: () => ({ then: vi.fn() }) },
      BrowserWindow: { getAllWindows: () => [] },
      ipcMain: { handle: (channel: string, fn: (event: unknown) => Promise<unknown>) => { handlers.set(channel, fn) }, on: vi.fn() },
      Menu: { setApplicationMenu: vi.fn() },
      powerSaveBlocker: { isStarted: () => false, start: vi.fn(), stop: vi.fn() },
      protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
    }
    const realRequire = electronMainRequire
    vm.runInNewContext(readFileSync(nodePath.resolve('electron/main.cjs'), 'utf8'), {
      AbortSignal, Buffer, Response, URL, __dirname: nodePath.resolve('electron'), clearTimeout, console, fetch,
      process: nodeProcess, require: (id: string) => id === 'electron' ? electron : realRequire(id), setTimeout,
    })
    const capture = handlers.get('liencam:capture-app')
    expect(capture).toBeDefined()
    expect(await capture!({ sender: {} })).toBeNull()
  })
})
