// @vitest-environment node

/**
 * WO-2896: a stop that leaves the controller at 0% feed must not leave every
 * later move "accepted, ran nothing".
 *
 * UCCNC-Linux oracle 'panic' (DLL 2190 vs the fake board): after
 * SetFeedHold(true), JogOff(6), Stop() the DLL's RT thread can apply a pending
 * zero FRO after Stop restored it. GetFRO then reads 0, status is idle, and
 * every jog answers rc 0 and moves nothing - the operator's 2026-08-24 "jogs ok,
 * nothing moves".
 *
 * This builds the REAL bridge (Bridge.cs, Machine.cs, Json.cs, Vfd.cs) against
 * this order's copy of the native rehearsal kit's simulated board, with the
 * machine seat's measured board facts (review 2026-10-20) injected:
 *  - a Stop() armed by FRO_ZERO_AFTER_STOP leaves FRO at 0 (the race);
 *  - at 0% FRO the board accepts moves and runs none;
 *  - during a feed hold GetFRO reads 100 (real AXBB-E, 1972 hold frames);
 *  - with RELEASE_TRANSIENT armed, GetFRO reads 0 for a window after
 *    SetFeedHold(false) (real board: one ~20 ms frame; widened here so a
 *    restore on the resume path could not hide in it).
 * Every SetFRO and motion call the bridge makes is recorded in order
 * (LIENCAM_SIM_RECORD), which is how "SetFRO(operator) then the jog" is read.
 */

import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const CSC = join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
const BRIDGE = resolve('pendant/uccnc-bridge')
const KIT = resolve('src/tests/evidence/NATIVE-PROBE-REHEARSAL')
// One fixed path of this order's own, never the shared rehearsal output or the desk path.
const OUT = join(tmpdir(), 'liencam-wo2896-kit')
const ROOT = join(tmpdir(), 'liencam-wo2896-kit-uccnc')
const EXE = join(OUT, 'liencam-bridge-sim.exe')
const BOARD = join(OUT, 'sim-board.json')
const RECORD = join(OUT, 'sim-record.txt')
/** While this file exists the next Stop() leaves FRO at 0 (one shot). */
const FRO_ZERO_AFTER_STOP = join(OUT, 'fro-zero-after-stop')
/** While this file exists GetFRO reads 0 for 400 ms after SetFeedHold(false). */
const RELEASE_TRANSIENT = join(OUT, 'fro-release-transient')

const RESTORED = /^\[bridge\] the feed override read 0% after a stop; set it back to (\d+(?:\.\d)?)% \(your last setting\) before this move$/

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms))

function inject(source: string, from: string, to: string): string {
  if (!source.includes(from)) throw new Error(`the simulated board no longer has: ${from}`)
  return source.replace(from, to)
}

let built = false

function buildKit(): void {
  if (built) return
  mkdirSync(OUT, { recursive: true })
  mkdirSync(join(ROOT, 'API', 'DLL'), { recursive: true })
  mkdirSync(join(ROOT, 'Profiles'), { recursive: true })
  // The committed kit's files are not edited; this order compiles copies.
  const sim = inject(readFileSync(join(KIT, 'SimUC100.cs'), 'utf8'),
    'if (!FeedHold) Tick(dt);',
    // At 0% feed the board takes moves and runs none.
    'if (!FeedHold && Fro >= 0.5) Tick(dt);')
  let api = readFileSync(join(KIT, 'SimUC100Api.cs'), 'utf8')
  api = inject(api,
    'public static int Stop() { SimBoard.StopAll(); return 0; }',
    'public static int Stop() { SimBoard.StopAll(); if (System.IO.File.Exists("fro-zero-after-stop")) '
    + '{ System.IO.File.Delete("fro-zero-after-stop"); SimBoard.Fro = 0; Record("Stop left FRO 0"); } return 0; }\n'
    + '    static readonly System.Diagnostics.Stopwatch wo2896Clock = System.Diagnostics.Stopwatch.StartNew();\n'
    + '    static long wo2896ReleasedMs = -100000;')
  api = inject(api,
    'public static int SetFeedHold(bool State) { SimBoard.FeedHold = State; return 0; }',
    'public static int SetFeedHold(bool State) { SimBoard.FeedHold = State; '
    + 'if (!State && System.IO.File.Exists("fro-release-transient")) wo2896ReleasedMs = wo2896Clock.ElapsedMilliseconds; '
    + 'Record("SetFeedHold " + State); return 0; }')
  api = inject(api,
    'public static int SetFRO(double FRO) { SimBoard.Fro = FRO; return 0; }',
    'public static int SetFRO(double FRO) { Record("SetFRO " + R(FRO)); SimBoard.Fro = FRO; return 0; }')
  api = inject(api,
    'public static int GetFRO(ref double FRO) { FRO = SimBoard.Fro; return 0; }',
    'public static int GetFRO(ref double FRO) { FRO = SimBoard.FeedHold ? 100 '
    + ': wo2896Clock.ElapsedMilliseconds - wo2896ReleasedMs < 400 ? 0 : SimBoard.Fro; return 0; }')
  const simCopy = join(OUT, 'SimUC100.wo2896.cs')
  const apiCopy = join(OUT, 'SimUC100Api.wo2896.cs')
  writeFileSync(simCopy, sim, 'utf8')
  writeFileSync(apiCopy, api, 'utf8')
  execFileSync(CSC, [
    '/nologo', '/unsafe', '/platform:x64', '/target:exe', '/main:LienCAM.Bridge', `/out:${EXE}`,
    join(BRIDGE, 'Bridge.cs'), join(BRIDGE, 'Machine.cs'), join(BRIDGE, 'Json.cs'), join(BRIDGE, 'Vfd.cs'),
    simCopy, apiCopy,
  ], { encoding: 'utf8', timeout: 120_000 })
  rmSync(FRO_ZERO_AFTER_STOP, { force: true })
  rmSync(RELEASE_TRANSIENT, { force: true })
  rmSync(join(OUT, 'boards'), { recursive: true, force: true })
  cpSync(join(BRIDGE, 'boards'), join(OUT, 'boards'), { recursive: true })
  // The bridge's startup checks want these files; the simulated board never loads them.
  writeFileSync(join(ROOT, 'API', 'DLL', 'UC100.dll'), '')
  writeFileSync(join(ROOT, 'ftd2xx64.dll'), '')
  copyFileSync(resolve('docs/machine/profiles/LienCNCV2.pro'), join(ROOT, 'Profiles', 'LienCNCV2.pro'))
  writeFileSync(join(OUT, 'liencam-bridge.config.json'),
    JSON.stringify({ installRoot: ROOT, profile: 'LienCNCV2.pro', board: -19 }), 'utf8')
  rmSync(join(OUT, 'liencam-bridge.definition.json'), { force: true })
  const board = JSON.parse(readFileSync(join(KIT, 'sim-board.example.json'), 'utf8')) as Record<string, unknown>
  writeFileSync(BOARD, `${JSON.stringify(board, null, 2)}\n`, 'utf8')
  built = true
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
interface Reply { ok: boolean; v?: unknown; error?: string }

/** The same frames the app's UccncController sends. */
class Link {
  private seq = 0
  private readonly replies = new Map<number, Reply>()
  status: { state?: string; machinePos?: Vec; workPos?: Vec } | null = null
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

  async call(m: string, a?: Record<string, unknown>, timeoutMs = 60_000): Promise<Reply> {
    const s = ++this.seq
    this.ws.send(JSON.stringify({ t: 'call', seq: s, m, ...(a ? { a } : {}) }))
    const end = Date.now() + timeoutMs
    while (Date.now() < end) {
      const r = this.replies.get(s)
      if (r) return r
      await wait(5)
    }
    return { ok: false, error: 'timeout' }
  }

  pos(): Vec { return this.status?.machinePos ?? { x: Number.NaN, y: Number.NaN, z: Number.NaN } }

  async settle(pred: () => boolean, timeoutMs = 30_000): Promise<boolean> {
    const end = Date.now() + timeoutMs
    while (Date.now() < end) {
      if (this.status?.state === 'idle' && pred()) return true
      await wait(5)
    }
    return false
  }

  async closed(): Promise<void> {
    await new Promise((done) => { this.ws.onclose = done; this.ws.close() })
  }
}

const near = (a: number, b: number, tol = 0.01) => Math.abs(a - b) <= tol

/** The calls the board saw since the last clear, in order. */
const record = () => (existsSync(RECORD) ? readFileSync(RECORD, 'utf8') : '').split('\n').filter(Boolean)
const clearRecord = () => writeFileSync(RECORD, '', 'utf8')

interface Session { link: Link; port: number; log: () => string; relink: () => Promise<Link> }

/** Configured, homed, parked at machine Z 60. */
async function withBridge(run: (session: Session) => Promise<void>): Promise<void> {
  const port = await freePort()
  if (port === 8325 || port === 8326) throw new Error('the allocated port belongs to a real bridge')
  const logPath = join(OUT, 'liencam-bridge.log')
  rmSync(logPath, { force: true })
  clearRecord()
  const log = () => existsSync(logPath) ? readFileSync(logPath, 'utf8') : ''
  const child = spawn(EXE, ['--board', '-19', '--port', String(port)], {
    cwd: OUT, stdio: 'ignore', windowsHide: true, env: { ...process.env, LIENCAM_SIM_RECORD: RECORD },
  })
  const session: Session = { link: null as unknown as Link, port, log, relink: async () => session.link }
  try {
    const end = Date.now() + 30_000
    while (Date.now() < end && !log().includes(`listening on ws://127.0.0.1:${port}/`)) {
      if (child.exitCode !== null) break
      await wait(50)
    }
    if (!log().includes(`listening on ws://127.0.0.1:${port}/`)) throw new Error(`bridge did not listen:\n${log()}`)
    const link = await Link.open(port)
    session.link = link
    session.relink = async () => {
      await session.link.closed()
      session.link = await Link.open(port)
      // The new session's first status frame.
      const until = Date.now() + 10_000
      while (Date.now() < until && !session.link.status) await wait(10)
      return session.link
    }
    const machine = JSON.parse(readFileSync(resolve('docs/machine/profiles/LienCNCV2.machine.json'), 'utf8'))
    const definition = machine.controllerDefinition
    const provenance = definition.stated
      ?.map((row: { liencamProfileDriftProvenance?: unknown }) => row?.liencamProfileDriftProvenance)
      .find((row: unknown) => row && typeof row === 'object') ?? {}
    const apply = await link.call('applyMachineDefinition', { definition, provenance }, 120_000)
    if (apply.ok !== true) throw new Error(`definition refused: ${JSON.stringify(apply)}`)
    const home = await link.call('homeAxes', { axes: ['Z', 'X', 'Y'] }, 120_000)
    if (home.ok !== true) throw new Error(`homing refused: ${JSON.stringify(home)}`)
    await link.settle(() => near(link.pos().z, 128.9))
    await link.call('jogToMachineZ', { z: 60, feedMmMin: 3000 })
    await link.settle(() => near(link.pos().z, 60))
    link.console.length = 0
    clearRecord()
    await run(session)
  } finally {
    await session.link?.closed().catch(() => undefined)
    await stop(child)
  }
}

/** A 2 mm Z jog; true when the counter got there. */
async function jogZ(link: Link, deltaMm: number): Promise<{ ok: boolean; moved: boolean }> {
  const from = link.pos().z
  const reply = await link.call('jog', { axis: 'Z', deltaMm, feedMmMin: 1000 })
  const moved = reply.ok === true && await link.settle(() => near(link.pos().z, from + deltaMm), 4_000)
  return { ok: reply.ok === true, moved }
}

const canBuild = process.platform === 'win32' && existsSync(CSC)

describe('WO-2896 a stop that left the board at 0% feed does not swallow the next move', () => {
  it.skipIf(!canBuild)('race 0 after Stop/Reset: the next jog sends SetFRO(operator) first, then the jog, and it moves', async () => {
    buildKit()
    await withBridge(async ({ link }) => {
      writeFileSync(FRO_ZERO_AFTER_STOP, '')
      expect((await link.call('reset')).ok).toBe(true)
      expect(record()).toContain('Stop left FRO 0')
      clearRecord()
      const jog = await jogZ(link, -2)
      expect(jog.ok).toBe(true)
      const calls = record()
      const setAt = calls.indexOf('SetFRO 100')
      const jogAt = calls.findIndex((line) => line.startsWith('rel axis 2 '))
      expect(setAt, calls.join('\n')).toBeGreaterThanOrEqual(0)
      expect(jogAt, calls.join('\n')).toBeGreaterThan(setAt)
      expect(jog.moved, calls.join('\n')).toBe(true)
      const said = link.console.filter((line) => RESTORED.test(line))
      expect(said, link.console.join('\n')).toEqual([
        '[bridge] the feed override read 0% after a stop; set it back to 100% (your last setting) before this move',
      ])
      // One event, one line: the next jog finds the override where it belongs.
      clearRecord()
      expect((await jogZ(link, 2)).moved).toBe(true)
      expect(record().filter((line) => line.startsWith('SetFRO'))).toEqual([])
      expect(link.console.filter((line) => RESTORED.test(line))).toHaveLength(1)
    })
  }, 300_000)

  it.skipIf(!canBuild)('operator at 60% before the stop: restored to 60, not 100', async () => {
    buildKit()
    await withBridge(async ({ link }) => {
      expect((await link.call('setOverride', { change: { kind: 'feed', to: 'percent', percent: 60 } })).ok).toBe(true)
      writeFileSync(FRO_ZERO_AFTER_STOP, '')
      expect((await link.call('reset')).ok).toBe(true)
      clearRecord()
      const jog = await jogZ(link, -2)
      const calls = record()
      expect(calls.filter((line) => line.startsWith('SetFRO')), calls.join('\n')).toEqual(['SetFRO 60'])
      expect(jog.moved, calls.join('\n')).toBe(true)
      expect(link.console).toContain(
        '[bridge] the feed override read 0% after a stop; set it back to 60% (your last setting) before this move')
    })
  }, 300_000)

  it.skipIf(!canBuild)('feed hold, socket drop, reconnect, jog (the operator 08-24): the jog moves', async () => {
    buildKit()
    await withBridge(async (session) => {
      expect((await session.link.call('feedHold')).ok).toBe(true)
      writeFileSync(FRO_ZERO_AFTER_STOP, '')
      const link = await session.relink()
      const until = Date.now() + 5_000
      while (Date.now() < until && !record().includes('Stop left FRO 0')) await wait(20)
      expect(record()).toContain('Stop left FRO 0')
      clearRecord()
      const jog = await jogZ(link, -2)
      const calls = record()
      expect(calls.filter((line) => line.startsWith('SetFRO')), calls.join('\n')).toEqual(['SetFRO 100'])
      expect(jog.moved, calls.join('\n')).toBe(true)
    })
  }, 300_000)

  it.skipIf(!canBuild)('a live feed hold reads 100: a jog during it sends no SetFRO', async () => {
    buildKit()
    await withBridge(async ({ link }) => {
      expect((await link.call('feedHold')).ok).toBe(true)
      clearRecord()
      expect((await link.call('jog', { axis: 'Z', deltaMm: -1, feedMmMin: 1000 })).ok).toBe(true)
      await wait(300)
      const calls = record()
      expect(calls.some((line) => line.startsWith('rel axis 2 ')), calls.join('\n')).toBe(true)
      expect(calls.filter((line) => line.startsWith('SetFRO')), calls.join('\n')).toEqual([])
      expect(link.console.filter((line) => RESTORED.test(line))).toEqual([])
      // Held: the jog waits for the operator; the guard released nothing.
      expect(calls).not.toContain('SetFeedHold False')
      expect((await link.call('reset')).ok).toBe(true)
    })
  }, 300_000)

  it.skipIf(!canBuild)('the transient 0 right after Cycle Resume: the resume path restores nothing', async () => {
    buildKit()
    await withBridge(async ({ link }) => {
      expect((await link.call('feedHold')).ok).toBe(true)
      writeFileSync(RELEASE_TRANSIENT, '')
      clearRecord()
      expect((await link.call('cycleResume')).ok).toBe(true)
      // Inside and past the transient window.
      await wait(600)
      rmSync(RELEASE_TRANSIENT, { force: true })
      const calls = record()
      expect(calls, calls.join('\n')).toContain('SetFeedHold False')
      expect(calls.filter((line) => line.startsWith('SetFRO')), calls.join('\n')).toEqual([])
      expect(link.console.filter((line) => RESTORED.test(line))).toEqual([])
      // After it, the board reads its own 100 again and a jog needs nothing.
      clearRecord()
      expect((await jogZ(link, -2)).moved).toBe(true)
      expect(record().filter((line) => line.startsWith('SetFRO'))).toEqual([])
    })
  }, 300_000)
})
