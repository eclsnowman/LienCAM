// @vitest-environment node
// WO-2845 (ADR-0058 D4): a changed UC100.dll waits for a second Connect press.
// Owner 2026-10-15: "We have no control over what software version a user has
// installed and what firmware version is loaded on their controller."
//
// Two layers, both through production code:
//  - the real bridge (Bridge.cs Main) built against SimUC100 and started as
//    board 19 (SimUC100's DeviceInfo: type 19, serial 7777), against two scratch
//    UCCNC installs whose UC100.dll stand-ins carry real file versions. The
//    simulated board loads neither, opens no port and moves nothing;
//  - the real electron/main.cjs, loaded with a fake spawn: the exit code is not
//    respawned, only the operator's press passes the flag, and with several
//    UCCNC installs and none chosen it no longer picks the newest.
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import vm from 'node:vm'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { pathToFileURL } from 'node:url'
import { bridgeNotStartedSentence, restartBridge, startBridge } from '../../lib/machine/bridgeHost'

const BRIDGE = path.resolve('pendant/uccnc-bridge')
const SIM = path.resolve('src/tests/evidence/NATIVE-PROBE-REHEARSAL')
const PROFILE = path.resolve('docs/machine/profiles/LienCNCV2.pro')
const csc = path.join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
const canRun = process.platform === 'win32' && existsSync(csc)
const SOURCES = ['Bridge.cs', 'Machine.cs', 'Json.cs', 'Vfd.cs'].map((f) => path.join(BRIDGE, f))
  .concat(['SimUC100.cs', 'SimUC100Api.cs'].map((f) => path.join(SIM, f)))
const HOST = '[bridge] FOR THE CONTROL CONSOLE '
const PINS = 'liencam-bridge.dll-pins.json'

type Run = { exitCode: number | null, listening: boolean, stdout: string[], log: string, pins: string | null }
const runs: Record<string, Run> = {}
let root = '', kitDir = '', installA = '', installB = '', shaA = '', shaB = ''

function compile(out: string, args: string[]) {
  const r = spawnSync(csc, ['/nologo', `/out:${out}`, ...args], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`csc: ${r.stdout}\n${r.stderr}`)
}

/** A scratch UCCNC install whose UC100.dll is a stand-in library with a real file version. */
function install(name: string, fileVersion: string): string {
  const dir = path.join(root, name)
  mkdirSync(path.join(dir, 'API', 'DLL'), { recursive: true })
  mkdirSync(path.join(dir, 'Profiles'), { recursive: true })
  const cs = path.join(root, `${name}.cs`)
  writeFileSync(cs, `[assembly: System.Reflection.AssemblyFileVersion("${fileVersion}")]\nclass Uc100StandIn {}\n`)
  compile(path.join(dir, 'API', 'DLL', 'UC100.dll'), ['/target:library', cs])
  writeFileSync(path.join(dir, 'ftd2xx64.dll'), '')
  copyFileSync(PROFILE, path.join(dir, 'Profiles', 'LienCNCV2.pro'))
  return dir
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const sha256 = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex')

/** One hosted bridge start (electron/main.cjs sets LIENCAM_BRIDGE_HOST_CONSOLE=1). */
async function start(label: string, port: number, args: string[]): Promise<Run> {
  rmSync(path.join(kitDir, 'liencam-bridge.log'), { force: true })
  const child = spawn(path.join(kitDir, 'liencam-bridge-sim.exe'), ['--port', String(port), ...args],
    { cwd: kitDir, env: { ...process.env, LIENCAM_BRIDGE_HOST_CONSOLE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
  const stdout: string[] = []
  let pending = ''
  child.stdout.on('data', (d) => {
    pending += String(d)
    const lines = pending.split(/\r?\n/)
    pending = lines.pop() ?? ''
    stdout.push(...lines)
  })
  let exitCode: number | null = null
  let exited = false
  child.on('exit', (code) => { exitCode = code; exited = true })
  const logFile = path.join(kitDir, 'liencam-bridge.log')
  const log = () => (existsSync(logFile) ? readFileSync(logFile, 'utf8') : '')
  for (let i = 0; i < 160 && !exited && !/listening on ws/.test(log()); i++) await sleep(125)
  const listening = /listening on ws/.test(log())
  if (!exited) child.kill()
  for (let i = 0; i < 40 && !exited; i++) await sleep(50)
  if (pending) stdout.push(pending)
  const pinsFile = path.join(kitDir, PINS)
  const run: Run = { exitCode: listening ? null : exitCode, listening, stdout, log: log(), pins: existsSync(pinsFile) ? readFileSync(pinsFile, 'utf8') : null }
  runs[label] = run
  return run
}

const board = (run: Run) => JSON.parse(run.pins ?? '{"boards":[]}').boards.find((b: { serial: string }) => b.serial === '0x1E61')

beforeAll(async () => {
  if (!canRun) return
  // A failure here leaves `runs` empty (the bridge rows fail); the Electron
  // rows below are independent of it and still run.
  try { await runBridgeStarts() } catch (error) { console.log(String(error).slice(0, 2000)) }
}, 240_000)

async function runBridgeStarts() {
  // The long path: the bridge records Path.GetFullPath, never an 8.3 short name.
  root = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'liencam-wo2845-')))
  installA = install('UCCNC12115', '2.1.9.0')
  installB = install('UCCNC12120', '2.1.10.0')
  shaA = sha256(path.join(installA, 'API', 'DLL', 'UC100.dll'))
  shaB = sha256(path.join(installB, 'API', 'DLL', 'UC100.dll'))
  kitDir = path.join(root, 'bridge')
  mkdirSync(path.join(kitDir, 'boards'), { recursive: true })
  compile(path.join(kitDir, 'liencam-bridge-sim.exe'), ['/unsafe', '/platform:x64', '/target:exe', '/main:LienCAM.Bridge', ...SOURCES])
  cpSync(path.join(BRIDGE, 'boards'), path.join(kitDir, 'boards'), { recursive: true })
  copyFileSync(path.join(SIM, 'sim-board.example.json'), path.join(kitDir, 'sim-board.json'))
  writeFileSync(path.join(kitDir, 'liencam-bridge.config.json'), JSON.stringify({ installRoot: installA, profile: 'LienCNCV2.pro', board: 19 }))
  const A = ['--install-root', installA, '--board', '19']
  const B = ['--install-root', installB, '--board', '19']
  await start('first', 18451, A)
  await start('same', 18452, A)
  await start('changed', 18453, B)
  await start('respawn', 18454, B)
  await start('press', 18455, [...B, '--connect-with-changed-dll'])
  await start('unnamed', 18456, [...A, '--connect-with-changed-dll'])
  await start('back', 18458, B)
  await start('demo', 18457, ['--install-root', installA, '--board', '-19'])
}

afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }) })

describe.skipIf(!canRun)('WO-2845 the real bridge on the fake board', () => {
  it('no record: opens at once and records this board with its DLL and firmware', () => {
    const r = runs.first
    expect(r.listening).toBe(true)
    expect(r.log).toContain('[bridge] DLL pin: board serial 0x1E61 has no UC100.dll on record yet - connecting with UC100.dll 2.1.9.0')
    expect(board(r)).toMatchObject({
      serial: '0x1E61', deviceType: 19, dllSha256: shaA, dllFileVersion: '2.1.9.0', installRoot: installA,
      dllPath: path.join(installA, 'API', 'DLL', 'UC100.dll'), fw: 7777, pendingDllSha256: null,
    })
  })

  it('the same DLL opens at once and leaves the record as it was', () => {
    const r = runs.same
    expect(r.listening).toBe(true)
    expect(r.log).toContain('[bridge] DLL pin: board serial 0x1E61 connects with the same UC100.dll 2.1.9.0')
    expect(r.pins).toBe(runs.first.pins)
    expect(r.stdout.filter((l) => l.includes('UC100.DLL CHANGED'))).toEqual([])
  })

  it('a changed DLL does not open: one console line naming both, the firmware, both ways on; exit 12', () => {
    const r = runs.changed
    expect(r.listening).toBe(false)
    expect(r.exitCode).toBe(12)
    expect(r.log).not.toMatch(/\[sim-board\] Open board/)
    const line = '[bridge] UC100.DLL CHANGED - NOT CONNECTED YET: this AXBB-E (serial 0x1E61) last connected with '
      + `UC100.dll 2.1.9.0 from ${installA} (controller firmware 7777). LienCAM is now set to UC100.dll 2.1.10.0 from `
      + `${installB}, and connecting with it may update the controller from firmware 7777. Press Connect again to `
      + `connect with it, or set the UCCNC install on the Machine panel back to ${installA}.`
    expect(r.stdout.filter((l) => l.startsWith(HOST))).toEqual([`${HOST}warn ${line}`])
    expect(r.stdout.filter((l) => l === line)).toHaveLength(1)
    expect(r.stdout.at(-1)).toBe('[bridge] exiting: the UC100.dll changed since this controller last connected - '
      + 'the Control console says what changed. Press Connect again to connect with it.')
    expect(board(r)).toMatchObject({ dllSha256: shaA, installRoot: installA, pendingDllSha256: shaB })
  })

  it('a start that is not the press (a respawn, the next app launch) still waits', () => {
    expect(runs.respawn.listening).toBe(false)
    expect(runs.respawn.exitCode).toBe(12)
    expect(board(runs.respawn)).toMatchObject({ dllSha256: shaA, pendingDllSha256: shaB })
  })

  it('the second Connect press opens with the changed DLL, which becomes the record', () => {
    const r = runs.press
    expect(r.listening).toBe(true)
    expect(r.log).toContain('[bridge] DLL pin: Connect pressed again - board serial 0x1E61 connects with the changed UC100.dll 2.1.10.0')
    expect(board(r)).toMatchObject({
      dllSha256: shaB, dllFileVersion: '2.1.10.0', installRoot: installB, fw: 7777, pendingDllSha256: null, pendingSince: null,
    })
  })

  it('the press opens only the DLL the line named: another changed DLL gets its own line', () => {
    const r = runs.unnamed
    expect(r.listening).toBe(false)
    expect(r.exitCode).toBe(12)
    expect(r.stdout.filter((l) => l.startsWith(HOST))).toHaveLength(1)
    expect(r.stdout.find((l) => l.startsWith(HOST))).toContain(`last connected with UC100.dll 2.1.10.0 from ${installB}`)
    expect(board(r)).toMatchObject({ dllSha256: shaB, pendingDllSha256: shaA })
  })

  it('the way back - the install it last connected with, no press - opens at once and ends the wait', () => {
    const r = runs.back
    expect(r.listening).toBe(true)
    expect(r.stdout.filter((l) => l.startsWith(HOST))).toEqual([])
    expect(board(r)).toMatchObject({ dllSha256: shaB, installRoot: installB, pendingDllSha256: null, pendingSince: null })
  })

  it('a demo board has no serial and no firmware: nothing is pinned and nothing waits', () => {
    const r = runs.demo
    expect(r.listening).toBe(true)
    expect(r.pins).toBe(runs.back.pins)
    expect(r.log).not.toMatch(/DLL pin/)
  })
})

// ---- Browser route: bridgeHost.ts -> supervisor.mjs -> the real bridge ------
// Audit round 1 (astra, 10-21): the supervisor passed the browser's arguments
// unchanged, so after the changed-DLL exit every Connect/Start/Restart exited 12
// again, forever. Runs after the starts above: the record now holds DLL B.

type Supervisor = { listen: () => Promise<unknown>; close: () => Promise<void> }

describe.skipIf(!canRun)('WO-2845 browser route: the supervisor carries the second press', () => {
  const PORT = 18471
  let supervisor: Supervisor | null = null
  async function openSupervisor() {
    const { createBridgeSupervisor } = await import(pathToFileURL(path.resolve('pendant/uccnc-bridge/supervisor/supervisor.mjs')).href)
    supervisor = createBridgeSupervisor({ bridgePath: path.join(kitDir, 'liencam-bridge-sim.exe'), bridgePort: PORT, supervisorPort: PORT + 1 }) as Supervisor
    await supervisor.listen()
  }
  afterEach(async () => {
    if (supervisor) await supervisor.close()
    supervisor = null
    vi.unstubAllGlobals()
  })

  it("a new session's first press and the automatic start wait; the second press opens the changed DLL", async () => {
    vi.stubGlobal('window', globalThis)   // bridgeSupervisorClient's timers; no window.liencamHost = the browser route
    await openSupervisor()
    const toA = { installRoot: installA, board: 19 }
    // A press in a supervisor that has seen no changed-DLL exit is not the second Connect.
    expect(await startBridge(PORT, toA, { operatorPress: true })).toMatchObject({ ok: false, reason: 'exited', lastExit: { code: 12 } })
    // The automatic start when Control opens never accepts.
    expect(await startBridge(PORT, toA)).toMatchObject({ ok: false, reason: 'exited', lastExit: { code: 12 } })
    expect(board({ pins: readFileSync(path.join(kitDir, PINS), 'utf8') } as Run)).toMatchObject({ dllSha256: shaB, pendingDllSha256: shaA })
    // The second press opens A, which becomes the record.
    expect(await restartBridge(PORT, toA, { operatorPress: true })).toMatchObject({ ok: true, port: PORT })
    expect(board({ pins: readFileSync(path.join(kitDir, PINS), 'utf8') } as Run)).toMatchObject({ dllSha256: shaA, pendingDllSha256: null })
  }, 60_000)

  it("the browser hears why: exit 12 carries the bridge's own line, not a bare exit code", async () => {
    vi.stubGlobal('window', globalThis)
    await openSupervisor()
    const result = await startBridge(PORT, { installRoot: installB, board: 19 }, { operatorPress: true })
    expect(result).toMatchObject({ ok: false, reason: 'exited', lastExit: { code: 12 } })
    const line = '[bridge] UC100.DLL CHANGED - NOT CONNECTED YET: this AXBB-E (serial 0x1E61) last connected with '
      + `UC100.dll 2.1.9.0 from ${installA} (controller firmware 7777). LienCAM is now set to UC100.dll 2.1.10.0 from `
      + `${installB}, and connecting with it may update the controller from firmware 7777. Press Connect again to `
      + `connect with it, or set the UCCNC install on the Machine panel back to ${installA}.`
    expect((result as { lastExit: { error: string } }).lastExit.error).toBe(line)
    expect(bridgeNotStartedSentence(result as never)).toBe(`Not connected: the machine connection stopped at start (${line.replace(/[.]$/, '')}).`)
  }, 60_000)

  // Audit round 2 (astra, 10-21): the status-row Reconnect (ControlTransportBar
  // recoverBridge) is the normal recovery press when status shows failing. The
  // options are the ones its restartBridge call passes as written; the route
  // after that is the real one. Runs after the row above: B waits, pending.
  it('the status-row Reconnect after the line is the second press: Reconnect opens B', async () => {
    const source = readFileSync(path.resolve('src/components/machine/ControlTransportBar.tsx'), 'utf8')
    const call = source.match(/await restartBridge\(port, bridgeLaunchSettings(?:, (\{[^}]*\}))?\)/)
    expect(call, 'the Reconnect call in ControlTransportBar.tsx').not.toBeNull()
    const reconnectOptions = call![1] ? (new Function(`return (${call![1]})`)() as { operatorPress?: boolean }) : {}
    vi.stubGlobal('window', globalThis)
    await openSupervisor()
    const toB = { installRoot: installB, board: 19 }
    // A new session: its first start says the line and exits 12.
    expect(await startBridge(PORT, toB, { operatorPress: true })).toMatchObject({ ok: false, reason: 'exited', lastExit: { code: 12 } })
    // Reconnect opens B.
    expect(await restartBridge(PORT, toB, reconnectOptions)).toMatchObject({ ok: true, port: PORT })
    expect(board({ pins: readFileSync(path.join(kitDir, PINS), 'utf8') } as Run)).toMatchObject({ dllSha256: shaB, pendingDllSha256: null })
  }, 60_000)
})

// ---- Electron ---------------------------------------------------------------

class FakeChild extends EventEmitter {
  pid: number
  exitCode: number | null = null
  killed = false
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  kill = vi.fn(() => { queueMicrotask(() => this.exit(0)); return true })
  constructor(pid: number) { super(); this.pid = pid }
  exit(code: number | null): void {
    if (this.exitCode !== null) return
    this.exitCode = code
    this.emit('exit', code, null)
  }
  say(line: string): void { this.stdout.emit('data', `${line}\r\n`) }
}

interface MainApi {
  machineBridgeStatus: () => {
    running: boolean
    respawn: { attempts: number; gaveUp: boolean }
    consoleLines: Array<{ id: string; severity: string; text: string }>
    lastExit: { code: number | null; consoleLineId?: string } | null
    setup: { state: string; installRoot: string | null; error: string | null }
  }
  restartMachineBridge: (settings?: unknown, options?: { operatorPress?: boolean }) => Promise<{ ok: boolean; reason?: string }>
  startMachineBridge: () => FakeChild | null
  initializeMachineBridge: () => Promise<FakeChild | null>
}

type Handler = (event: unknown, ...args: unknown[]) => unknown

function loadMain(options: { env?: Record<string, string | undefined>; userData?: string } = {}) {
  const children: FakeChild[] = []
  const spawnArgs: string[][] = []
  const handlers = new Map<string, Handler>()
  const electron = {
    app: {
      isPackaged: false, on: vi.fn(), quit: vi.fn(),
      whenReady: () => ({ then: () => Promise.resolve() }),
      ...(options.userData ? { getPath: () => options.userData } : {}),
    },
    BrowserWindow: class { static getAllWindows = () => [] },
    ipcMain: { handle: vi.fn((name: string, fn: Handler) => { handlers.set(name, fn) }), on: vi.fn() },
    Menu: { setApplicationMenu: vi.fn() },
    powerSaveBlocker: { isStarted: vi.fn(() => false), start: vi.fn(() => 1), stop: vi.fn() },
    protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
  }
  const processValue = {
    ...process,
    argv: [],
    env: {
      ...process.env,
      LIENCAM_BRIDGE_EXECUTABLE: 'C:\\fake\\liencam-bridge.exe',
      LIENCAM_BRIDGE_ARGS_JSON: JSON.stringify(['--port', '8399']),
      ...options.env,
    },
    platform: 'win32',
    resourcesPath: path.resolve('.tmp-wo2845-resources'),
  }
  const moduleValue = { exports: {} as MainApi }
  // main.cjs's own relative requires (./agentChannel.cjs) resolve beside it.
  const realRequire = createRequire(path.resolve('electron/main.cjs'))
  vm.runInNewContext(readFileSync(path.resolve('electron/main.cjs'), 'utf8'), {
    AbortSignal, Buffer, Date, Promise, Response, URL,
    __dirname: path.resolve('electron'),
    clearTimeout, console, exports: moduleValue.exports, fetch,
    module: moduleValue, process: processValue, queueMicrotask, setTimeout,
    require: (id: string) => {
      if (id === 'electron') return electron
      if (id === 'node:child_process') {
        return {
          ...realRequire('node:child_process'),
          spawn: vi.fn((_executable: string, args: string[]) => {
            spawnArgs.push(args)
            const child = new FakeChild(4900 + children.length)
            children.push(child)
            return child
          }),
        }
      }
      if (id === 'node:net') {
        return {
          createConnection: () => {
            const socket = Object.assign(new EventEmitter(), { destroy: () => {}, setTimeout: () => {} })
            setImmediate(() => socket.emit('error', new Error('connection refused')))
            return socket
          },
        }
      }
      return realRequire(id)
    },
  })
  return { api: moduleValue.exports, children, spawnArgs, handlers }
}

const CHANGED = '[bridge] UC100.DLL CHANGED - NOT CONNECTED YET: this AXBB-E (serial 0x1E61) last connected with UC100.dll 2.1.9.0'
const FLAG = '--connect-with-changed-dll'

/** The bridge's own hosted refusal: its host line, its human copy, its exit line, exit 12. */
const EXITING = '[bridge] exiting: the UC100.dll changed since this controller last connected - the Control console says what changed. Press Connect again to connect with it.'
function refuse(child: FakeChild) {
  child.say(`${HOST}warn ${CHANGED}`)
  child.say(CHANGED)
  child.say(EXITING)
  child.exit(12)
}

describe('WO-2845 Electron: the changed-DLL exit waits for the operator', () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

  it('exit 12 is not respawned; its one line reaches the Control console, and the press says what the bridge said', async () => {
    vi.useFakeTimers()
    const m = loadMain()
    m.api.startMachineBridge()
    refuse(m.children[0])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(m.children).toHaveLength(1)
    const status = m.api.machineBridgeStatus()
    expect(status).toMatchObject({ running: false, respawn: { attempts: 0, gaveUp: true } })
    expect(status.consoleLines).toEqual([expect.objectContaining({ severity: 'warn', text: CHANGED })])
    expect(status.lastExit?.code).toBe(12)
    // Not linked as a firmware-update outcome: the press quotes the bridge's own last line.
    expect(status.lastExit?.consoleLineId).toBeUndefined()
    expect(bridgeNotStartedSentence({ ok: false, reason: 'exited', lastExit: status.lastExit } as never))
      .toBe('Not connected: the machine connection stopped at start ([bridge] exiting: the UC100.dll changed since '
        + 'this controller last connected - the Control console says what changed. Press Connect again to connect with it).')
  })

  it("the operator's Connect press after it passes the flag; the settings reconcile and a crash respawn never do", async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const m = loadMain()
    m.api.startMachineBridge()
    refuse(m.children[0])
    await vi.advanceTimersByTimeAsync(0)

    // The renderer's settings reconcile is not a press.
    const reconcile = m.api.restartMachineBridge(null)
    await vi.advanceTimersByTimeAsync(30_000)
    await reconcile
    expect(m.spawnArgs[1]).not.toContain(FLAG)
    refuse(m.children[1])
    await vi.advanceTimersByTimeAsync(0)

    // The Connect press arrives over the IPC channel the renderer uses.
    const press = m.handlers.get('liencam:machine-bridge-restart')
    expect(press).toBeTypeOf('function')
    const pressed = press!({ sender: null }, undefined) as Promise<unknown>
    await vi.advanceTimersByTimeAsync(30_000)
    await pressed
    expect(m.spawnArgs[2]).toEqual(['--port', '8399', FLAG])

    // That bridge opens and later crashes: the respawn carries no flag.
    m.children[2].exit(1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(m.spawnArgs[3]).toEqual(['--port', '8399'])
  })

  it('a press after any other exit carries no flag', async () => {
    vi.useFakeTimers()
    const m = loadMain()
    m.api.startMachineBridge()
    m.children[0].exit(2)
    await vi.advanceTimersByTimeAsync(0)
    const pressed = m.handlers.get('liencam:machine-bridge-restart')!({ sender: null }, undefined) as Promise<unknown>
    await vi.advanceTimersByTimeAsync(30_000)
    await pressed
    expect(m.spawnArgs.at(-1)).not.toContain(FLAG)
  })
})

describe('WO-2845 Electron: several UCCNC installs, none chosen', () => {
  let search = '', userData = ''
  afterEach(() => {
    vi.restoreAllMocks()
    for (const dir of [search, userData]) if (dir) rmSync(dir, { recursive: true, force: true })
  })

  function installs(names: string[]): string[] {
    search = mkdtempSync(path.join(tmpdir(), 'liencam-wo2845-search-'))
    userData = mkdtempSync(path.join(tmpdir(), 'liencam-wo2845-user-'))
    return names.map((name) => {
      const dir = path.join(search, name)
      mkdirSync(path.join(dir, 'API', 'Interface'), { recursive: true })
      writeFileSync(path.join(dir, 'API', 'Interface', 'UC100_wrapper.cs'), '// stand-in\n')
      return dir
    })
  }

  function pin(roots: string[]) {
    mkdirSync(path.join(userData, 'machine-bridge'), { recursive: true })
    writeFileSync(path.join(userData, 'machine-bridge', PINS), JSON.stringify({
      format: 'liencam-dll-pins', schemaVersion: 1,
      boards: roots.map((installRoot, i) => ({ serial: `0x${i + 1}`, dllSha256: 'a'.repeat(64), installRoot })),
    }))
  }

  async function setup() {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const m = loadMain({
      userData,
      env: {
        LIENCAM_BRIDGE_EXECUTABLE: '', LIENCAM_BRIDGE_ARGS_JSON: '', LIENCAM_USER_DATA_DIR: '',
        LIENCAM_UCCNC_SEARCH_ROOT: search, LIENCAM_CSC_EXECUTABLE: path.join(search, 'no-compiler-here.exe'),
      },
    })
    await m.api.initializeMachineBridge()
    return m.api.machineBridgeStatus().setup
  }

  it('does not pick the newest: with no record it builds nothing and asks for the install', async () => {
    const [older, newer] = installs(['UCCNC12115', 'UCCNC12120'])
    const s = await setup()
    expect(s.installRoot).toBeNull()
    expect(s.state).toBe('failed')
    expect(s.error).toBe(`Several UCCNC installs were found (${older}, ${newer}) and none is chosen. LienCAM does not `
      + "pick one for you, because a different UCCNC can update the controller's firmware. Choose the UCCNC install "
      + 'folder on the Machine page.')
  })

  it('uses the install the board last connected with, even when a newer one exists', async () => {
    const [older] = installs(['UCCNC12115', 'UCCNC12120'])
    pin([older.toUpperCase()])
    expect((await setup()).installRoot).toBe(older)
  })

  it('a record naming two installs, or one not present, is not a choice', async () => {
    const [a, b] = installs(['UCCNC12115', 'UCCNC12120'])
    pin([a, b])
    expect((await setup()).installRoot).toBeNull()
    rmSync(search, { recursive: true, force: true }); rmSync(userData, { recursive: true, force: true })
    installs(['UCCNC12115', 'UCCNC12120'])
    pin([path.join(search, 'UCCNC12000')])
    expect((await setup()).installRoot).toBeNull()
  })

  it('a single install is still found by itself', async () => {
    const [only] = installs(['UCCNC12115'])
    expect((await setup()).installRoot).toBe(only)
  })
})
