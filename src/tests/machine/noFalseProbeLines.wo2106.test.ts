// @vitest-environment node

/**
 * WO-2106: a normal probing run prints only true lines.
 *
 * Rehearsal 2026-09-27 (native kit, .planning/rehearsal-2026-09-27/): after
 * almost every 2 mm retract between the fast and the fine pass the bridge
 * printed "THE MACHINE ACCEPTED A MOVE AND DID NOT MAKE IT". The retract ran;
 * the fine probe then went straight back down and touched where the fast pass
 * had, so the move watch - which judges a move by its distance from where it
 * started - saw the counter back on its mark and called the retract unmoved.
 *
 * This builds the REAL bridge (Bridge.cs, Machine.cs, Json.cs, Vfd.cs) against
 * the native rehearsal kit's simulated board, drives it over its WebSocket the
 * way the app's native probe route does, and reads the bridge's own console
 * frames back. A retract that truly never ran (sent during the board's
 * post-contact probe cycle, which the simulated board drops) must still print.
 */

import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BridgeCallMessage, BridgeMessage, BridgeTransportEvents } from '../../lib/machine/bridgeTransport'
import type { ControllerCapabilities, MachineStatus } from '../../lib/machine/controller'
import { typedMock } from '../support/typedMock'

const CSC = join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
const BRIDGE = resolve('pendant/uccnc-bridge')
const KIT = resolve('src/tests/evidence/NATIVE-PROBE-REHEARSAL')
// One fixed path of this order's own, never the shared rehearsal output or the desk path.
const OUT = join(tmpdir(), 'liencam-wo2106-kit')
const ROOT = join(tmpdir(), 'liencam-wo2106-kit-uccnc')
const EXE = join(OUT, 'liencam-bridge-sim.exe')
const BOARD = join(OUT, 'sim-board.json')
/** Test-only fault switch in this order's copy of the simulated board: while
 *  this file exists the next line move is accepted (rc 0) and never run. */
const DROP_NEXT = join(OUT, 'drop-next-move')

const DID_NOT_MAKE_IT = 'THE MACHINE ACCEPTED A MOVE AND DID NOT MAKE IT'
const TRUNCATED = 'THE MOVE WAS TRUNCATED AND IT REPORTED SUCCESS'

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms))

function buildKit(): void {
  mkdirSync(OUT, { recursive: true })
  mkdirSync(join(ROOT, 'API', 'DLL'), { recursive: true })
  mkdirSync(join(ROOT, 'Profiles'), { recursive: true })
  // The committed simulated board, plus one injected fault: a line move sent
  // while DROP_NEXT exists is dropped exactly as the board drops one inside its
  // probe cycle. The kit's own files are not edited.
  const sim = readFileSync(join(KIT, 'SimUC100.cs'), 'utf8')
  const gate = 'if (Now() < probeCycleUntilSec && dropDuringCycle)'
  const at = sim.indexOf('public static int Enqueue(')
  const hook = sim.indexOf(gate, at)
  if (at < 0 || hook < 0) throw new Error('the simulated board no longer has the Enqueue drop gate')
  const injected = `${sim.slice(0, hook)}if ((Now() < probeCycleUntilSec && dropDuringCycle) || (kind == "line" && Wo2106DropNext()))${sim.slice(hook + gate.length)}`
    .replace('public static int Enqueue(', 'static bool Wo2106DropNext() { string f = "drop-next-move"; if (!System.IO.File.Exists(f)) return false; System.IO.File.Delete(f); return true; }\n\n    public static int Enqueue(')
  const simCopy = join(OUT, 'SimUC100.wo2106.cs')
  writeFileSync(simCopy, injected, 'utf8')
  execFileSync(CSC, [
    '/nologo', '/unsafe', '/platform:x64', '/target:exe', '/main:LienCAM.Bridge', `/out:${EXE}`,
    join(BRIDGE, 'Bridge.cs'), join(BRIDGE, 'Machine.cs'), join(BRIDGE, 'Json.cs'), join(BRIDGE, 'Vfd.cs'),
    simCopy, join(KIT, 'SimUC100Api.cs'),
  ], { encoding: 'utf8', timeout: 120_000 })
  rmSync(DROP_NEXT, { force: true })
  rmSync(join(OUT, 'boards'), { recursive: true, force: true })
  cpSync(join(BRIDGE, 'boards'), join(OUT, 'boards'), { recursive: true })
  // The bridge's startup checks want these files; the simulated board never loads them.
  writeFileSync(join(ROOT, 'API', 'DLL', 'UC100.dll'), '')
  writeFileSync(join(ROOT, 'ftd2xx64.dll'), '')
  copyFileSync(resolve('docs/machine/profiles/LienCNCV2.pro'), join(ROOT, 'Profiles', 'LienCNCV2.pro'))
  writeFileSync(join(OUT, 'liencam-bridge.config.json'),
    JSON.stringify({ installRoot: ROOT, profile: 'LienCNCV2.pro', board: -19 }), 'utf8')
  rmSync(join(OUT, 'liencam-bridge.definition.json'), { force: true })
}

function writeBoard(lingerMs: number): void {
  const board = JSON.parse(readFileSync(join(KIT, 'sim-board.example.json'), 'utf8')) as Record<string, unknown>
  board.probeCycleLingerMs = lingerMs
  board.dropMovesDuringProbeCycle = true
  writeFileSync(BOARD, `${JSON.stringify(board, null, 2)}\n`, 'utf8')
}

async function freePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') { server.close(); reject(new Error('no loopback port')); return }
      server.close(() => resolvePort(address.port))
    })
  })
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return
  child.kill()
  await Promise.race([new Promise((done) => child.once('exit', done)), wait(3_000)])
  if (child.exitCode === null) child.kill('SIGKILL')
}

interface Vec { x: number; y: number; z: number }
interface Reply { ok: boolean; v?: { ok?: boolean; at?: Vec | null } & Record<string, unknown>; error?: string }

/** The same frames the app's UccncController sends. */
class Link {
  private seq = 0
  private readonly replies = new Map<number, Reply>()
  status: { state?: string; machinePos?: Vec } | null = null
  readonly console: string[] = []
  private readonly ws: WebSocket
  private constructor(ws: WebSocket) {
    this.ws = ws
    ws.onmessage = (event) => {
      const m = JSON.parse(String(event.data)) as { t: string; seq?: number; v?: unknown } & Reply
      if (m.t === 'reply' && typeof m.seq === 'number') this.replies.set(m.seq, m)
      else if (m.t === 'status') this.status = m.v as Link['status']
      else if (m.t === 'console') this.console.push(String((m.v as { text?: string })?.text ?? JSON.stringify(m.v)))
    }
  }

  static async open(port: number): Promise<Link> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`)
    await new Promise((done, fail) => { ws.onopen = done; ws.onerror = fail })
    return new Link(ws)
  }

  send(m: string, a?: Record<string, unknown>): number {
    const s = ++this.seq
    this.ws.send(JSON.stringify({ t: 'call', seq: s, m, ...(a ? { a } : {}) }))
    return s
  }

  async reply(s: number, timeoutMs = 60_000): Promise<Reply> {
    const end = Date.now() + timeoutMs
    while (Date.now() < end) {
      const r = this.replies.get(s)
      if (r) return r
      await wait(5)
    }
    return { ok: false, error: 'timeout' }
  }

  call(m: string, a?: Record<string, unknown>, timeoutMs?: number): Promise<Reply> {
    return this.reply(this.send(m, a), timeoutMs)
  }

  z(): number { return this.status?.machinePos?.z ?? Number.NaN }

  /** Idle and there - the app's waitForProbeRoutineMove, polled fast. */
  async settle(pred: () => boolean, timeoutMs = 30_000): Promise<boolean> {
    const end = Date.now() + timeoutMs
    while (Date.now() < end) {
      if (this.status?.state === 'idle' && pred()) return true
      await wait(5)
    }
    return false
  }

  close(): void { this.ws.close() }
}

const near = (a: number, b: number, tol = 0.01) => Math.abs(a - b) <= tol

async function withBridge(run: (link: Link, log: () => string) => Promise<void>): Promise<void> {
  const port = await freePort()
  if (port === 8325 || port === 8326) throw new Error('the allocated port belongs to a real bridge')
  const logPath = join(OUT, 'liencam-bridge.log')
  rmSync(logPath, { force: true })
  const log = () => existsSync(logPath) ? readFileSync(logPath, 'utf8') : ''
  const child = spawn(EXE, ['--board', '-19', '--port', String(port)], { cwd: OUT, stdio: 'ignore', windowsHide: true })
  let link: Link | null = null
  try {
    const end = Date.now() + 30_000
    while (Date.now() < end && !log().includes(`listening on ws://127.0.0.1:${port}/`)) {
      if (child.exitCode !== null) break
      await wait(50)
    }
    if (!log().includes(`listening on ws://127.0.0.1:${port}/`)) throw new Error(`bridge did not listen:\n${log()}`)
    link = await Link.open(port)
    const machine = JSON.parse(readFileSync(resolve('docs/machine/profiles/LienCNCV2.machine.json'), 'utf8'))
    const definition = machine.controllerDefinition
    const provenance = definition.stated
      ?.map((row: { liencamProfileDriftProvenance?: unknown }) => row?.liencamProfileDriftProvenance)
      .find((row: unknown) => row && typeof row === 'object') ?? {}
    const apply = await link.call('applyMachineDefinition', { definition, provenance }, 120_000)
    if (apply.ok !== true) throw new Error(`definition refused: ${JSON.stringify(apply)}`)
    const home = await link.call('homeAxes', { axes: ['Z', 'X', 'Y'] }, 120_000)
    if (home.ok !== true) throw new Error(`homing refused: ${JSON.stringify(home)}`)
    await link.settle(() => near(link!.z(), 128.9))
    // Over the conductive top pad (top Z 46.94), as the rehearsal's Z0 routine.
    await link.call('jogToMachineZ', { z: 60, feedMmMin: 3000 })
    await link.settle(() => near(link!.z(), 60))
    const w = link.status as { machinePos: Vec; workPos?: Vec }
    const ox = w.machinePos.x - (w.workPos?.x ?? w.machinePos.x)
    const oy = w.machinePos.y - (w.workPos?.y ?? w.machinePos.y)
    await link.call('jogToWorkXY', { x: 300 - ox, y: 275 - oy, feedMmMin: 6000 })
    await link.settle(() => near(link!.status?.machinePos?.x ?? 0, 300) && near(link!.status?.machinePos?.y ?? 0, 275))
    await run(link, log)
  } finally {
    link?.close()
    await stop(child)
  }
}

const canBuild = process.platform === 'win32' && existsSync(CSC)

describe('WO-2106 the bridge prints no false move report during normal probing', () => {
  it.skipIf(!canBuild)('fast pass, 2 mm retract, fine pass back onto the same contact: no "did not make it"', async () => {
    buildKit()
    writeBoard(250)
    await withBridge(async (link, log) => {
      // The Z0 recipe the rehearsal ran: 300 fast, 2 mm retract, 50 fine.
      const fast = await link.call('probe', { axis: 'Z', targetMm: -40, feedMmMin: 300 }, 120_000)
      expect(fast.v?.ok, JSON.stringify(fast)).toBe(true)
      expect(fast.v?.at?.z).toBeCloseTo(46.94, 2)
      const retract = await link.call('jogToMachineZ', { z: 48.94, feedMmMin: 1000 })
      expect(retract.ok).toBe(true)
      // The app starts the fine pass the moment the retract is idle at its target.
      expect(await link.settle(() => near(link.z(), 48.94))).toBe(true)
      const fine = await link.call('probe', { axis: 'Z', targetMm: 44.94, feedMmMin: 50 }, 120_000)
      expect(fine.v?.ok, JSON.stringify(fine)).toBe(true)
      expect(fine.v?.at?.z).toBeCloseTo(46.94, 2)
      // Past the watch's 1.5 s silence and 0.5 s settle windows.
      await wait(3_000)
      const lines = link.console.join('\n')
      expect(lines, lines).not.toContain(DID_NOT_MAKE_IT)
      expect(lines, lines).not.toContain(TRUNCATED)
      expect(log()).not.toContain(DID_NOT_MAKE_IT)
      expect(log()).toMatch(/ProbeStart Z toward 44\.940 at 50\.000 mm\/min from X 300\.000 Y 275\.000 Z 48\.940/)
    })
  }, 300_000)

  it.skipIf(!canBuild)('a retract the board truly dropped is still reported, word for word', async () => {
    buildKit()
    writeBoard(250)
    await withBridge(async (link, log) => {
      const fast = await link.call('probe', { axis: 'Z', targetMm: -40, feedMmMin: 300 }, 120_000)
      expect(fast.v?.at?.z).toBeCloseTo(46.94, 2)
      // The board accepts this retract and never runs it.
      writeFileSync(DROP_NEXT, '')
      const retract = await link.call('jogToMachineZ', { z: 48.94, feedMmMin: 1000 })
      expect(retract.ok, JSON.stringify(retract)).toBe(true)
      expect(log()).toMatch(/DROPPED line/)
      const until = Date.now() + 6_000
      while (Date.now() < until && !link.console.some((line) => line.includes(DID_NOT_MAKE_IT))) await wait(20)
      const said = link.console.find((line) => line.includes(DID_NOT_MAKE_IT)) ?? ''
      expect(said, link.console.join('\n')).toMatch(
        /^\[bridge\] THE MACHINE ACCEPTED A MOVE AND DID NOT MAKE IT\. an absolute Z move to Z48\.94 was accepted by the controller \(rc=0\) and after \d+ ms nothing has moved/,
      )
      expect(near(link.z(), 46.94)).toBe(true)
    })
  }, 300_000)
})

// ---- the session: a guarded move that reaches its target is not a miss ----
//
// Rehearsal 2026-09-27: "[bridge] probe on Z toward 38.78 found no contact" on
// every descent to probing depth. The runs below go through the production
// probe routine runner (runProbeRoutine) on the real UccncController over a
// fake bridge board that prints Machine.cs ProbeCore's own miss line, before
// its reply, as the bridge does.

const mem = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    get length() { return mem.size },
    clear: () => mem.clear(),
    getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
    key: (i: number) => Array.from(mem.keys())[i] ?? null,
    removeItem: (k: string) => { mem.delete(k) },
    setItem: (k: string, v: string) => { mem.set(k, String(v)) },
  } satisfies Storage,
})

const BRIDGE_CAPABILITIES: ControllerCapabilities = {
  geometryQueue: true,
  executingMoveId: true,
  bufferSeconds: true,
  gcodeText: false,
  machineProgram: true,
  perAxisHoming: true,
  ownsSpindle: false,
  spindleCommands: false,
}

/** Machine.cs ProbeCore, the came-to-rest branch, word for word. */
const bridgeMiss = (axis: string, target: number) => `[bridge] probe on ${axis} toward ${target} found no contact: the machine `
  + 'came to rest without the probe input firing, so the probe ended and the machine is released.'

let bridgeEvents: BridgeTransportEvents | null = null
const g54: Vec = { x: 200, y: 200, z: 30 }
let boardPos: Vec = { x: 100, y: 100, z: 40 }
let frames: Array<{ state: 'run' | 'idle'; pos: Vec }> = []
/** Where a probe call comes to rest when it touches nothing; null = its target. */
let probeRestsAt: number | null = null

function boardStatus(state: 'run' | 'idle', pos: Vec): MachineStatus {
  return {
    state,
    subState: null,
    machinePos: { ...pos },
    workPos: { x: pos.x - g54.x, y: pos.y - g54.y, z: pos.z - g54.z },
    feedMmMin: 0,
    spindleRpm: 0,
    overrides: null,
    executingMoveId: null,
    buffer: { moves: 0, capacitySeconds: 0.1 },
    inputs: null,
    homed: { X: true, Y: true, Z: true },
    spindle: null,
  } as MachineStatus
}

function runTo(to: Vec): void {
  frames = [
    { state: 'run', pos: { x: (boardPos.x + to.x) / 2, y: (boardPos.y + to.y) / 2, z: (boardPos.z + to.z) / 2 } },
    { state: 'idle', pos: { ...to } },
    { state: 'idle', pos: { ...to } },
  ]
}

vi.mock('../../lib/machine/bridgeTransport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/bridgeTransport')>()
  return typedMock<typeof import('../../lib/machine/bridgeTransport')>({
    ...actual,
    BridgeTransport: class extends actual.BridgeTransport {
      static isSupported(): boolean { return true }
      async start(events: BridgeTransportEvents): Promise<void> {
        bridgeEvents = events
        const zero = { x: 0, y: 0, z: 0 }
        const offsets = { G54: { ...g54 }, G55: zero, G56: zero, G57: zero, G58: zero, G59: zero }
        events.onMessage({
          t: 'hello',
          v: {
            protocol: 1,
            bridge: 'liencam-uccnc-bridge/0.4',
            capabilities: BRIDGE_CAPABILITIES,
            readOnly: false,
            workOffsets: { current: offsets, profile: offsets },
          },
        } as BridgeMessage)
      }
      send(message: BridgeCallMessage): void {
        const reply = (v: unknown) => bridgeEvents?.onMessage({ t: 'reply', seq: message.seq, ok: true, v })
        switch (message.m) {
          case 'queryStatus': {
            const frame = frames.shift()
            if (frame) boardPos = { ...frame.pos }
            bridgeEvents?.onMessage({ t: 'status', v: boardStatus(frame?.state ?? 'idle', boardPos) } as BridgeMessage)
            reply(true)
            return
          }
          case 'jogToMachineZ': {
            reply(true)
            runTo({ ...boardPos, z: (message.a as { z: number }).z })
            return
          }
          case 'jogToWorkXY': {
            const a = message.a as { x: number; y: number }
            reply(true)
            runTo({ x: a.x + g54.x, y: a.y + g54.y, z: boardPos.z })
            return
          }
          case 'jog': {
            const a = message.a as { axis: 'X' | 'Y' | 'Z'; deltaMm: number }
            const key = a.axis.toLowerCase() as keyof Vec
            reply(true)
            runTo({ ...boardPos, [key]: boardPos[key] + a.deltaMm })
            return
          }
          case 'selectWcs':
            reply(true)
            return
          case 'probe': {
            // Nothing under this board: every probe call comes to rest untouched,
            // and the bridge says so before it replies.
            const a = message.a as { axis: 'X' | 'Y' | 'Z'; targetMm: number }
            const key = a.axis.toLowerCase() as keyof Vec
            boardPos = { ...boardPos, [key]: probeRestsAt ?? a.targetMm }
            frames = []
            bridgeEvents?.onMessage({ t: 'status', v: boardStatus('idle', boardPos) } as BridgeMessage)
            bridgeEvents?.onMessage({
              t: 'console',
              v: { dir: 'rx', text: bridgeMiss(a.axis, a.targetMm), severity: 'warn' },
            } as BridgeMessage)
            reply({ ok: false, at: null })
            return
          }
        }
      }
      async close(): Promise<void> {
        bridgeEvents?.onClose('closed')
        bridgeEvents = null
      }
    },
  })
})

const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const session = await import('../../lib/machine/machineSession')
const { deriveMachineEnvelopeFromConvention } = await import('../../lib/machine/machineEnvelope')
const { DEFAULT_ZPROBE_CONFIG, resolveProbeConfig } = await import('../../lib/machine/toolTable')
const { validateProbeRoutine } = await import('../../lib/machine/probeRoutineFormat')
const { expandProbeRoutine } = await import('../../lib/machine/probeRoutineExpand')

const CONFIG = resolveProbeConfig(null, DEFAULT_ZPROBE_CONFIG)
const ENVELOPE = deriveMachineEnvelopeFromConvention(
  {
    x: { homesToward: 'min', machineZeroAt: 'min' },
    y: { homesToward: 'min', machineZeroAt: 'min' },
    z: { homesToward: 'min', machineZeroAt: 'min' },
  },
  { x: 738, y: 724.5, z: 128.9 },
)

function routine(steps: unknown[]): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: 'user.wo2106',
    name: 'WO-2106',
    version: '1.0.0',
    provenance: { kind: 'user' },
    description: 'WO-2106 console lines.',
    requires: { homed: true, envelope: 'full', probe: 'touch' },
    inputs: [],
    steps,
    outputs: [],
  }
}

/** The descent to probing depth: a guarded move meant to reach machine Z 20. */
const DESCEND = routine([
  { kind: 'move', name: 'down', frame: 'machine', to: { z: 20 }, stopOnContact: true },
  { kind: 'move', name: 'up', frame: 'machine', to: { z: 45 } },
])
/** A probe that must touch, over nothing: a real miss. */
const MUST_TOUCH = routine([
  { kind: 'touch', name: 'top', axis: 'Z', direction: '-', searchMm: 10 },
])

async function runOnBoard(json: Record<string, unknown>) {
  const pending = session.connectMachine('bridge')
  await vi.advanceTimersByTimeAsync(300)
  await pending
  session.__resetEstopInterlockForTest()
  boardPos = { x: 100, y: 100, z: 40 }
  frames = []
  bridgeEvents?.onMessage({ t: 'status', v: boardStatus('idle', boardPos) } as BridgeMessage)
  await vi.advanceTimersByTimeAsync(50)
  useMachineControl.setState({ activeWcs: 'G54', consoleLines: [] })
  const valid = validateProbeRoutine(json)
  if (!valid.ok) throw new Error(valid.errors.map((e) => e.sentence).join('\n'))
  const expanded = expandProbeRoutine(valid.routine, {}, {
    start: { ...boardPos }, envelope: ENVELOPE, probe: CONFIG, tipRadiusMm: 1.5, activeWcs: 'G54',
  })
  if (!expanded.ok) throw new Error(expanded.errors.map((e) => e.sentence).join('\n'))
  const run = session.runProbeRoutine(expanded.expanded, CONFIG, true, expanded.expanded.hash, { envelope: ENVELOPE })
  let done = false
  let result: Awaited<typeof run> | undefined
  void run.then((value) => { result = value; done = true })
  for (let waited = 0; !done && waited < 120_000; waited += 100) await vi.advanceTimersByTimeAsync(100)
  expect(done, 'the routine never ended').toBe(true)
  const lines = useMachineControl.getState().consoleLines.map((l) => ({ text: l.text, severity: l.severity }))
  return { result: result!, lines }
}

describe('WO-2106 a guarded move that reaches its depth prints no miss line (native route)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    frames = []
    probeRestsAt = null
    mem.clear()
    useCamStore.getState().newProject()
    useCamStore.setState((state) => ({
      project: { ...state.project, machine: { ...state.project.machine, controller: 'uccnc' } },
    }))
    useCamStore.setState({ machineWorkOffsets: {} })
    useMachineControl.setState({ consoleLines: [], parserModal: null, offsets: {} })
  })

  afterEach(async () => {
    if (session.getMachineController().connectionPhase() !== 'disconnected') {
      const pending = session.disconnectMachine()
      await vi.advanceTimersByTimeAsync(300)
      await pending
    }
    vi.useRealTimers()
  })

  it('the descent to depth reaches machine Z 20: the routine carries on and no "found no contact" line is printed', async () => {
    const { result, lines } = await runOnBoard(DESCEND)
    expect(result.ok, JSON.stringify(result)).toBe(true)
    expect(boardPos.z).toBe(45)
    expect(lines.filter((l) => l.text.includes('found no contact')), JSON.stringify(lines)).toEqual([])
  })

  it('a descent that came to rest short of its depth still prints the bridge line word for word', async () => {
    probeRestsAt = 25
    const { result, lines } = await runOnBoard(DESCEND)
    expect(result.ok).toBe(false)
    expect(lines).toContainEqual({ text: bridgeMiss('Z', 20), severity: 'warn' })
  })

  it('a probe that must touch and misses still prints the bridge line word for word', async () => {
    const { result, lines } = await runOnBoard(MUST_TOUCH)
    expect(result.ok).toBe(false)
    expect(lines).toContainEqual({ text: bridgeMiss('Z', 30), severity: 'warn' })
  })
})

// ---- the page's process-status read: no refused connection every second ----

const bridgeHost = await import('../../lib/machine/bridgeHost')

describe('WO-2106 with no supervisor running, the status read does not ask every second', () => {
  const hadWindow = 'window' in globalThis
  let asked: string[] = []
  let supervisorUp = false

  beforeEach(() => {
    vi.useFakeTimers()
    asked = []
    supervisorUp = false
    // The browser: no desktop host, and fetch to a port nothing listens on is refused.
    if (!hadWindow) Object.defineProperty(globalThis, 'window', { configurable: true, value: globalThis })
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      asked.push(url)
      if (!supervisorUp) throw new TypeError('Failed to fetch')
      return new Response(JSON.stringify({ configured: true, running: true, pid: 1, lastExit: null,
        respawn: { attempts: 0, gaveUp: false, lastAttemptAt: null } }), { status: 200 })
    }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    if (!hadWindow) delete (globalThis as { window?: unknown }).window
    vi.useRealTimers()
  })

  it('the Control page\'s once-a-second read asks a missing supervisor a handful of times a minute, and finds one that starts later', async () => {
    const port = 8411
    const answers: Array<unknown> = []
    // The Control page's poll: once a second for a minute.
    for (let second = 0; second < 60; second++) {
      answers.push(await bridgeHost.bridgeProcessStatus(port))
      await vi.advanceTimersByTimeAsync(1_000)
    }
    expect(answers.every((answer) => answer === null)).toBe(true)
    expect(bridgeHost.bridgeHostCapability()).toBe('unhosted')
    // Today: 60 refused connections. Now: at 0, 5, 15 and 35 s.
    expect(asked).toHaveLength(4)
    expect(asked.every((url) => url === 'http://127.0.0.1:8412/status')).toBe(true)

    // A supervisor started later is found within the (capped) pause, and from
    // then on every read asks it again.
    supervisorUp = true
    let found: unknown = null
    for (let second = 0; second < 61 && found === null; second++) {
      found = await bridgeHost.bridgeProcessStatus(port)
      if (found === null) await vi.advanceTimersByTimeAsync(1_000)
    }
    expect(found).toMatchObject({ running: true })
    expect(bridgeHost.bridgeHostCapability()).toBe('supervisor')
    const before = asked.length
    await bridgeHost.bridgeProcessStatus(port)
    await bridgeHost.bridgeProcessStatus(port)
    expect(asked.length).toBe(before + 2)
  })

  it('a refusal that takes two seconds (Windows localhost) is one request, not one per poll', async () => {
    const port = 8431
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      asked.push(url)
      return new Promise((_resolve, reject) => setTimeout(() => reject(new TypeError('Failed to fetch')), 2_000))
    }))
    const reads: Array<Promise<unknown>> = []
    for (let second = 0; second < 3; second++) {
      reads.push(bridgeHost.bridgeProcessStatus(port))
      await vi.advanceTimersByTimeAsync(1_000)
    }
    expect(await Promise.all(reads)).toEqual([null, null, null])
    expect(asked).toEqual(['http://127.0.0.1:8432/status'])
  })
})

// ---- the two text slips the rehearsal listed ----
//
// Driven on the simulator through the production program route
// (loadGcodeTextToolpathProgram, CYCLE START) with the WO-2025 guided
// tool-change setup: a park macro marked for tool change, a safe Z and a
// measured reference tool.

describe('WO-2106 the load and tool-change lines say what happens', () => {
  const SIM_ID = 'wo2106-simulator'

  async function simulator(reference: number): Promise<void> {
    const { positionMacroBody } = await import('../../types')
    const { useMachineActions } = await import('../../store/machineActionsStore')
    const { useMachineToolTable } = await import('../../store/machineToolTableStore')
    useMachineToolTable.setState({ byMachine: {} })
    useMachineActions.setState({ byMachine: {}, macroArrangementByMachine: {} })
    useCamStore.setState((s) => ({ control: { ...s.control, activeMachineId: null } }))
    const machine = useCamStore.getState().project.machine
    useCamStore.getState().setProjectMachine({
      ...machine,
      id: SIM_ID,
      name: 'WO-2106 simulator',
      controller: 'grbl',
      controllerDefinition: undefined,
      unsentSettings: undefined,
      travel: { x: 100, y: 100, z: 100 },
      rapidRate: 60000,
      homeConvention: {
        x: { homesToward: 'min', machineZeroAt: 'min' },
        y: { homesToward: 'min', machineZeroAt: 'min' },
        z: { homesToward: 'max', homePositionMm: 5 },
      },
      macros: [{
        id: 'm6-pad',
        name: 'Fixed tool probe',
        body: positionMacroBody({ x: 60, y: 70, z: -20, zFirst: true }),
        usedForToolChange: true,
      }],
      safeZMachine: -2,
    } as never)
    const connected = session.connectMachine('simulator', 115200)
    await vi.advanceTimersByTimeAsync(300)
    await connected
    session.__resetEstopInterlockForTest()
    session.getMachineController().home()
    await vi.advanceTimersByTimeAsync(2000)
    const tools = useMachineToolTable.getState()
    tools.recordProbedZ(SIM_ID, 1, -42, 1)
    tools.recordProbedZ(SIM_ID, 19, -40, 1)
    tools.setReference(SIM_ID, reference)
    tools.setProbeConfig(SIM_ID, { maxTravel: 50 })
    for (const axis of ['X', 'Y', 'Z'] as const) {
      expect(session.setWorkOffsetValue('G54', axis, 0)).toBe(true)
      await vi.advanceTimersByTimeAsync(50)
    }
    useMachineControl.getState().clearConsole()
  }

  const texts = () => useMachineControl.getState().consoleLines.map((l) => l.text)
  const holdLine = () => texts().find((l) => l.includes('is finished') && l.includes('retracted clear'))

  beforeEach(() => {
    vi.useFakeTimers()
    mem.clear()
    useCamStore.getState().newProject()
    useMachineControl.setState({ consoleLines: [], parserModal: null, toolChange: null })
  })

  afterEach(async () => {
    session.cancelGuidedToolChange()
    if (session.getMachineController().connectionPhase() !== 'disconnected') {
      const pending = session.disconnectMachine()
      await vi.advanceTimersByTimeAsync(300)
      await pending
    }
    vi.useRealTimers()
  })

  it('T19, T1, T19: the load line names the tools in the order they run', async () => {
    await simulator(19)
    const program = ['G21', 'G90', 'T19 M6', 'G1 X2 F6000', 'T1 M6', 'G1 X20 F6000', 'T19 M6', 'G1 X40 F6000', 'M30'].join('\n')
    expect(session.loadGcodeTextToolpathProgram('t19-t1-t19.nc', program).ok).toBe(true)
    const loaded = texts().find((l) => l.includes('It runs')) ?? ''
    expect(loaded, texts().join('\n')).toMatch(/ It runs 2 tools: T19\b.*, then T1\b.*, then T19\b.* - it holds at each change\./)
    // One tool that never comes back reads as before.
    useMachineControl.getState().clearConsole()
    expect(session.loadGcodeTextToolpathProgram('t1-t19.nc', ['G21', 'G90', 'T1 M6', 'G1 X2 F6000', 'T19 M6', 'G1 X40 F6000', 'M30'].join('\n')).ok).toBe(true)
    const plain = texts().find((l) => l.includes('It runs')) ?? ''
    expect(plain).toMatch(/ It runs 2 tools: T1\b.*, then T19\b.* - it holds at each change\./)
    expect(plain).not.toMatch(/then T19\b.*, then/)
  })

  it('fitting the reference tool: the hold says the work zero moves with its new reading', async () => {
    await simulator(19)
    const program = ['G21', 'G90', 'T1 M6', 'G1 X2 F6000', 'T19 M6', 'G1 X40 F6000', 'M30'].join('\n')
    expect(session.loadGcodeTextToolpathProgram('to-ref.nc', program).ok).toBe(true)
    expect(session.getMachineController().startJob()).toBe(true)
    await vi.advanceTimersByTimeAsync(4000)
    const hold = holdLine() ?? ''
    expect(hold, texts().join('\n')).toContain('fit T19')
    expect(hold).not.toContain('Z work zero is not changed')
    expect(hold).toContain('T19 is the reference tool: it is measured at the setter, and the G54 Z work zero moves with its new reading')
  })

  it('fitting any other tool: the hold still says the work zero is not changed', async () => {
    await simulator(1)
    const program = ['G21', 'G90', 'T1 M6', 'G1 X2 F6000', 'T19 M6', 'G1 X40 F6000', 'M30'].join('\n')
    expect(session.loadGcodeTextToolpathProgram('from-ref.nc', program).ok).toBe(true)
    expect(session.getMachineController().startJob()).toBe(true)
    await vi.advanceTimersByTimeAsync(4000)
    const hold = holdLine() ?? ''
    expect(hold, texts().join('\n')).toContain('fit T19')
    expect(hold).toContain('the G54 Z work zero is not changed; the new tool is measured at the setter.')
  })
})
