// WO-2883 fix round 5: every install-and-restart path stops the pendant and waits for the
// machine bridge before LienCAM relaunches or quits for the installer. These tests run the
// real electron/main.cjs with a fake Electron, a fake bridge child and a fake pendant child,
// and drive the update callbacks main.cjs hands the updater (app.exit skips will-quit, so
// the relaunch callback itself must do the cleanup).

import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { electronMainRequire } from '../../support/electronMainRequire'
import nodePath from 'node:path'
import nodeProcess from 'node:process'
import vm from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

class FakeChild extends EventEmitter {
  exitCode: number | null = null
  killed = false
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  readonly pid: number
  readonly role: 'bridge' | 'pendant'
  private readonly log: string[]
  constructor(pid: number, role: 'bridge' | 'pendant', log: string[]) {
    super()
    this.pid = pid
    this.role = role
    this.log = log
  }
  kill = vi.fn((_signal?: string) => {
    this.killed = true
    this.log.push(`kill ${this.role}`)
    // The bridge exits a little later, as a real process does; the shutdown must wait for it.
    setTimeout(() => {
      if (this.exitCode !== null) return
      this.exitCode = 0
      if (this.role === 'bridge') this.log.push('bridge exited')
      this.emit('exit', 0, null)
    }, 20)
    return true
  })
}

interface UpdateHost {
  quit: () => void
  relaunch: (execPath: string) => void
  shutdown?: () => Promise<boolean>
  resume?: () => void
}

async function startMain() {
  const log: string[] = []
  const children: FakeChild[] = []
  let appHandler: ((request: Request) => Promise<Response>) | null = null
  let updateHost: UpdateHost | null = null
  class FakeWindow {
    webContents = { setWindowOpenHandler: vi.fn(), on: vi.fn(), send: vi.fn() }
    constructor(_options: unknown) {}
    once = vi.fn()
    on = vi.fn()
    show = vi.fn()
    maximize = vi.fn()
    loadURL = vi.fn(async () => {})
    static getAllWindows = () => []
  }
  const electron = {
    app: {
      isPackaged: false,
      getVersion: () => '0.35.0',
      getPath: (name: string) => nodePath.resolve(`.tmp-wo2883-shutdown-${name}`),
      on: vi.fn(),
      quit: vi.fn(() => { log.push('app.quit') }),
      relaunch: vi.fn(() => { log.push('app.relaunch') }),
      exit: vi.fn(() => { log.push('app.exit') }),
      whenReady: () => ({ then: (listener: () => void) => { listener(); return Promise.resolve() } }),
    },
    BrowserWindow: FakeWindow,
    dialog: {},
    ipcMain: { handle: vi.fn(), on: vi.fn() },
    Menu: { setApplicationMenu: vi.fn() },
    net: { fetch: vi.fn() },
    powerSaveBlocker: { isStarted: vi.fn(() => false), start: vi.fn(() => 1), stop: vi.fn() },
    protocol: {
      registerSchemesAsPrivileged: vi.fn(),
      handle: (_scheme: string, handler: (request: Request) => Promise<Response>) => { appHandler = handler },
    },
    screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 } }) },
    shell: { showItemInFolder: vi.fn(), openPath: vi.fn(async () => '') },
  }
  const pendantUp = () => children.some((child) => child.role === 'pendant' && child.exitCode === null)
  const fakeFetch = async (url: string) => {
    if (String(url).includes(':8324/') && pendantUp()) {
      return new Response(JSON.stringify({ ok: true, service: 'liencam-pendant-bridge' }), { status: 200 })
    }
    throw new TypeError('fetch failed')
  }
  const processValue = {
    ...nodeProcess,
    argv: [],
    env: { ...nodeProcess.env, LIENCAM_BRIDGE_EXECUTABLE: 'C:\\fake\\liencam-bridge.exe', LIENCAM_BRIDGE_ARGS_JSON: '[]' },
    platform: 'win32',
  }
  const moduleValue = { exports: {} }
  // WO-3056's shared require: main.cjs's ./agentChannel.cjs and ./mcp/ resolve against electron/.
  const realRequire = electronMainRequire
  const updaterPath = nodePath.resolve('electron', 'update', 'updater.cjs')
  vm.runInNewContext(readFileSync(nodePath.resolve('electron/main.cjs'), 'utf8'), {
    AbortSignal, Buffer, Date, Promise, Response, URL, __dirname: nodePath.resolve('electron'),
    clearTimeout, console, exports: moduleValue.exports, fetch: fakeFetch, module: moduleValue,
    process: processValue, queueMicrotask, setTimeout, setInterval, clearInterval,
    require: (id: string) => {
      if (id === 'electron') return electron
      if (id === updaterPath) {
        return {
          createUpdateRoute: (options: UpdateHost) => { updateHost = options; return {} },
          registerUpdateIpc: () => {},
        }
      }
      if (id === 'node:child_process') {
        return {
          execFile: vi.fn(),
          spawn: vi.fn((_file: string, args: string[]) => {
            const role = args.some((arg) => String(arg).endsWith('server.mjs')) ? 'pendant' : 'bridge'
            const child = new FakeChild(5100 + children.length, role, log)
            children.push(child)
            log.push(`spawn ${role}`)
            return child
          }),
        }
      }
      return realRequire(id)
    },
  })
  await vi.waitFor(() => expect(children.some((child) => child.role === 'bridge')).toBe(true))
  expect(updateHost).not.toBeNull()
  // Start the pendant the way the renderer does, through the app protocol.
  const started = await appHandler!(new Request('liencam://app/__liencam/pendant-broker/start', { method: 'POST' }))
  expect(started.status).toBe(200)
  const bridge = children.find((child) => child.role === 'bridge')!
  const pendant = children.find((child) => child.role === 'pendant')!
  log.length = 0
  return { host: updateHost!, app: electron.app, bridge, pendant, log, children }
}

describe('WO-2883 fix round 5: the update restart waits for the pendant and machine bridge', () => {
  it('the AppImage relaunch stops the pendant and waits for the bridge to exit before it relaunches', async () => {
    const { host, app, bridge, pendant, log } = await startMain()
    host.relaunch('/home/op/LienCAM.AppImage')
    await vi.waitFor(() => expect(app.exit).toHaveBeenCalledWith(0))
    const relaunchAt = log.indexOf('app.relaunch')
    const cleanupCalls = log.slice(0, relaunchAt).filter((entry) => entry.startsWith('kill ')).length
    expect({ cleanupCalls, pendantKilled: pendant.killed, log }).toEqual({
      cleanupCalls: 2, pendantKilled: true,
      log: ['kill pendant', 'kill bridge', 'bridge exited', 'app.relaunch', 'app.exit'],
    })
    expect(bridge.exitCode).toBe(0)
    expect(app.relaunch).toHaveBeenCalledWith({ execPath: '/home/op/LienCAM.AppImage' })
  })

  it('the installer quit stops the pendant and waits for the bridge to exit before it quits', async () => {
    const { host, app, log } = await startMain()
    host.quit()
    await vi.waitFor(() => expect(app.quit).toHaveBeenCalledTimes(1))
    expect(log).toEqual(['kill pendant', 'kill bridge', 'bridge exited', 'app.quit'])
  })

  it('the updater gets the same shutdown, and it resolves only once the bridge has exited', async () => {
    const { host, bridge, log } = await startMain()
    expect(typeof host.shutdown).toBe('function')
    const stopped = await host.shutdown!()
    expect(stopped).toBe(true)
    expect(bridge.exitCode).toBe(0)
    expect(log).toEqual(['kill pendant', 'kill bridge', 'bridge exited'])
  })

  it('after a replace that failed, the resume starts the machine bridge and the pendant the shutdown stopped', async () => {
    const { host, log, children } = await startMain()
    await host.shutdown!()
    log.length = 0
    host.resume!()
    await vi.waitFor(() => expect(log).toEqual(expect.arrayContaining(['spawn bridge', 'spawn pendant'])))
    expect(children.filter((child) => child.exitCode === null).map((child) => child.role).sort()).toEqual(['bridge', 'pendant'])
  })
})
