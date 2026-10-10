// @vitest-environment node

/**
 * WO-2151: a move that is already where it is going is not a move that
 * "did not make it".
 *
 * Rehearsal 2026-09-28 (native kit, .planning/rehearsal-2026-09-28/REPORT.md,
 * "Would bite Operator" item 6): starting Bore printed a yellow
 * "THE MACHINE ACCEPTED A MOVE AND DID NOT MAKE IT" for a first move whose
 * target was the position the machine already stood at. The bridge's move
 * watch (Machine.cs CheckMoveWatch) judged it by distance from its mark, found
 * none, and could not tell "asked for no distance" from "asked for distance
 * and got none".
 *
 * This builds the REAL bridge (Bridge.cs, Machine.cs, Json.cs, Vfd.cs) against
 * the native rehearsal kit's simulated board, drives it over its WebSocket with
 * the frames the app's UccncController sends, and reads the bridge's own
 * console frames back. A move that asked to go somewhere and was dropped by the
 * board must still print, word for word.
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
const OUT = join(tmpdir(), 'liencam-wo2151-kit')
const ROOT = join(tmpdir(), 'liencam-wo2151-kit-uccnc')
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
  const injected = `${sim.slice(0, hook)}if ((Now() < probeCycleUntilSec && dropDuringCycle) || (kind == "line" && Wo2151DropNext()))${sim.slice(hook + gate.length)}`
    .replace('public static int Enqueue(', 'static bool Wo2151DropNext() { string f = "drop-next-move"; if (!System.IO.File.Exists(f)) return false; System.IO.File.Delete(f); return true; }\n\n    public static int Enqueue(')
  const simCopy = join(OUT, 'SimUC100.wo2151.cs')
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
  const board = JSON.parse(readFileSync(join(KIT, 'sim-board.example.json'), 'utf8')) as Record<string, unknown>
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

/** Homed, then parked at machine X 300 Y 275 Z 60 - where the rehearsal's
 *  routines start - with every positioning move's watch settled out. */
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
    await link.settle(() => near(link!.pos().z, 128.9))
    await link.call('jogToMachineZ', { z: 60, feedMmMin: 3000 })
    await link.settle(() => near(link!.pos().z, 60))
    const w = link.status!
    const ox = w.machinePos!.x - (w.workPos?.x ?? w.machinePos!.x)
    const oy = w.machinePos!.y - (w.workPos?.y ?? w.machinePos!.y)
    await link.call('jogToWorkXY', { x: 300 - ox, y: 275 - oy, feedMmMin: 6000 })
    await link.settle(() => near(link!.pos().x, 300) && near(link!.pos().y, 275))
    // Past the positioning moves' 0.5 s settle window, so their watch is over.
    await wait(1_000)
    link.console.length = 0
    await run(link, log)
  } finally {
    link?.close()
    await stop(child)
  }
}

/** The work position the machine stands at now, as the app would send it. */
function workHere(link: Link): { x: number; y: number } {
  const s = link.status!
  return { x: s.workPos?.x ?? s.machinePos!.x, y: s.workPos?.y ?? s.machinePos!.y }
}

const canBuild = process.platform === 'win32' && existsSync(CSC)

describe('WO-2151 a move asked to go where the machine already is prints no "did not make it"', () => {
  it.skipIf(!canBuild)('zero-length absolute Z, absolute XY and a sub-resolution jog: no false line', async () => {
    buildKit()
    await withBridge(async (link, log) => {
      const here = link.pos()
      // A routine's first move to the Z it is already at (the Bore start).
      const z = await link.call('jogToMachineZ', { z: here.z, feedMmMin: 1000 })
      expect(z.ok, JSON.stringify(z)).toBe(true)
      // Past the watch's 1.5 s silence window.
      await wait(2_500)
      // A routine's first XY move to the XY it is already at.
      const xy = await link.call('jogToWorkXY', { ...workHere(link), feedMmMin: 6000 })
      expect(xy.ok, JSON.stringify(xy)).toBe(true)
      await wait(2_500)
      // A jog shorter than the watch can see: the board takes it, the counter cannot show it.
      const tiny = await link.call('jog', { axis: 'Z', deltaMm: 0.0005, feedMmMin: 1000 })
      expect(tiny.ok, JSON.stringify(tiny)).toBe(true)
      await wait(2_500)
      const lines = link.console.join('\n')
      expect(lines, lines).not.toContain(DID_NOT_MAKE_IT)
      expect(lines, lines).not.toContain(TRUNCATED)
      expect(log()).not.toContain(DID_NOT_MAKE_IT)
      // Nothing latched or refused: the next real move runs.
      const next = await link.call('jogToMachineZ', { z: here.z + 5, feedMmMin: 3000 })
      expect(next.ok, JSON.stringify(next)).toBe(true)
      expect(await link.settle(() => near(link.pos().z, here.z + 5))).toBe(true)
    })
  }, 300_000)

  it.skipIf(!canBuild)('a move that asked for distance and was dropped is still reported, word for word', async () => {
    buildKit()
    await withBridge(async (link, log) => {
      const here = link.pos()
      // The board accepts this move and never runs it.
      writeFileSync(DROP_NEXT, '')
      const down = await link.call('jogToMachineZ', { z: 55, feedMmMin: 1000 })
      expect(down.ok, JSON.stringify(down)).toBe(true)
      expect(log()).toMatch(/DROPPED line/)
      const until = Date.now() + 6_000
      while (Date.now() < until && !link.console.some((line) => line.includes(DID_NOT_MAKE_IT))) await wait(20)
      const said = link.console.find((line) => line.includes(DID_NOT_MAKE_IT)) ?? ''
      expect(said, link.console.join('\n')).toMatch(
        /^\[bridge\] THE MACHINE ACCEPTED A MOVE AND DID NOT MAKE IT\. an absolute Z move to Z55 was accepted by the controller \(rc=0\) and after \d+ ms nothing has moved/,
      )
      expect(near(link.pos().z, here.z)).toBe(true)
    })
  }, 300_000)
})
