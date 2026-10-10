// @vitest-environment node

/**
 * WO-2186: the AXBB-E bridge rotates the work offset, as LinuxCNC does.
 *
 * The spec is LinuxCNC 2.9.4 as MEASURED (docs/design/WCS-ROTATION.md,
 * .planning/research-linuxcnc-g10-rotation-2026-09-29.md):
 *     machine_xy = O_xy + Rot(R)(work_xy)      work_xy = Rot(-R)(machine_xy - O_xy)
 * Rotated: program moves, arc centres, jog-to-work, the work readout, a work
 * zero. Not rotated: G53 lines, jogs, the native probe call (a machine-axis
 * target - the board's ProbeStart drives one axis).
 *
 * This builds the REAL bridge (Bridge.cs, Machine.cs, Json.cs, Vfd.cs) against
 * the native rehearsal kit's simulated board, drives it over its WebSocket with
 * the frames the app's UccncController sends, and reads back what the bridge
 * handed the board: the kit records every motion call's exact arguments when
 * LIENCAM_SIM_RECORD names a file (SimUC100Api.cs).
 *
 * The LinuxCNC numbers were measured with G54 X10 Y20; this machine's soft
 * limits start at 0, so every case here shifts the offset by D = (300, 300) and
 * the expected machine point by the same D (the formula is linear in O).
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
// This order's own paths, never the shared rehearsal output or the desk path.
const BASE_OUT = join(tmpdir(), 'liencam-wo2186-kit')
const BRIDGE_FILES = ['Bridge.cs', 'Machine.cs', 'Json.cs', 'Vfd.cs'] as const

const D = { x: 300, y: 300 }
const OFFSET = { x: 10 + D.x, y: 20 + D.y, z: 60 }
const FEED = 6000

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms))

/** The board for this order: one conducting wall for the probe, at machine
 *  X 240..250, clear of every program point. */
const SIM_BOARD = {
  timeScale: 1,
  tipRadius: 0,
  probeCycleLingerMs: 250,
  dropMovesDuringProbeCycle: true,
  homeSeekMm: 5,
  start: { x: 300, y: 300, z: 100 },
  boxes: [{ name: 'wall', x0: 240, x1: 250, y0: 0, y1: 724, bottom: 0, top: 110, conducting: true }],
}

/** Compile one bridge (its four sources from `srcDir`) against the kit. */
function buildKit(label: string, srcDir: string): string {
  const out = join(BASE_OUT, label)
  const root = join(out, 'uccnc')
  mkdirSync(out, { recursive: true })
  mkdirSync(join(root, 'API', 'DLL'), { recursive: true })
  mkdirSync(join(root, 'Profiles'), { recursive: true })
  const exe = join(out, 'liencam-bridge-sim.exe')
  execFileSync(CSC, [
    '/nologo', '/unsafe', '/platform:x64', '/target:exe', '/main:LienCAM.Bridge', `/out:${exe}`,
    ...BRIDGE_FILES.map((f) => join(srcDir, f)),
    join(KIT, 'SimUC100.cs'), join(KIT, 'SimUC100Api.cs'),
  ], { encoding: 'utf8', timeout: 180_000 })
  rmSync(join(out, 'boards'), { recursive: true, force: true })
  cpSync(join(BRIDGE, 'boards'), join(out, 'boards'), { recursive: true })
  writeFileSync(join(root, 'API', 'DLL', 'UC100.dll'), '')
  writeFileSync(join(root, 'ftd2xx64.dll'), '')
  copyFileSync(resolve('docs/machine/profiles/LienCNCV2.pro'), join(root, 'Profiles', 'LienCNCV2.pro'))
  writeFileSync(join(out, 'liencam-bridge.config.json'),
    JSON.stringify({ installRoot: root, profile: 'LienCNCV2.pro', board: -19 }), 'utf8')
  writeFileSync(join(out, 'sim-board.json'), `${JSON.stringify(SIM_BOARD, null, 2)}\n`, 'utf8')
  return exe
}

/** The bridge sources this branch started from, for the rotation-0 comparison. */
function baseSources(): string {
  const base = execFileSync('git', ['merge-base', 'HEAD', 'main'], { encoding: 'utf8' }).trim()
  const dir = join(BASE_OUT, 'base-src')
  mkdirSync(dir, { recursive: true })
  for (const f of BRIDGE_FILES) {
    const text = execFileSync('git', ['show', `${base}:pendant/uccnc-bridge/${f}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    writeFileSync(join(dir, f), text, 'utf8')
  }
  return dir
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
interface Status { state?: string; machinePos?: Vec; workPos?: Vec; workRotation?: number }

/** The same frames the app's UccncController sends. */
class Link {
  private seq = 0
  private readonly replies = new Map<number, Reply>()
  status: Status | null = null
  hello: Record<string, unknown> | null = null
  readonly jobEvents: { event: string; fault?: { message?: string } | null }[] = []
  private readonly ws: WebSocket
  private constructor(ws: WebSocket) {
    this.ws = ws
    ws.onmessage = (event) => {
      const m = JSON.parse(String(event.data)) as { t: string; seq?: number; v?: unknown } & Reply
      if (m.t === 'reply' && typeof m.seq === 'number') this.replies.set(m.seq, m)
      else if (m.t === 'status') this.status = m.v as Status
      else if (m.t === 'hello') this.hello = m.v as Record<string, unknown>
      else if (m.t === 'jobEvent') this.jobEvents.push(m.v as Link['jobEvents'][number])
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
  work(): Vec { return this.status?.workPos ?? { x: Number.NaN, y: Number.NaN, z: Number.NaN } }

  async settle(pred: () => boolean = () => true, timeoutMs = 30_000): Promise<boolean> {
    const end = Date.now() + timeoutMs
    let stable = 0
    let last = ''
    while (Date.now() < end) {
      const here = JSON.stringify(this.status?.machinePos ?? null)
      stable = this.status?.state === 'idle' && here === last ? stable + 1 : 0
      last = here
      if (stable >= 4 && pred()) return true
      await wait(30)
    }
    return false
  }

  async runProgram(moves: unknown[]): Promise<string> {
    this.jobEvents.length = 0
    const load = await this.call('loadMoves', { moves, frame: 'work' })
    const lv = load.v as { ok?: boolean; reason?: string } | undefined
    if (load.ok !== true || lv?.ok !== true) throw new Error(`load refused: ${JSON.stringify(load)}`)
    const start = await this.call('startJob', {})
    if (start.ok !== true) throw new Error(`start refused: ${JSON.stringify(start)}`)
    const end = Date.now() + 60_000
    while (Date.now() < end) {
      const done = this.jobEvents.find((e) => e.event === 'completed' || e.event === 'failed' || e.event === 'stopped')
      if (done) { await this.settle(); return done.event }
      await wait(20)
    }
    return 'timeout'
  }

  close(): void { this.ws.close() }
}

async function withBridge(exe: string, record: string, run: (link: Link, port: number) => Promise<void>): Promise<void> {
  const out = join(exe, '..')
  const port = await freePort()
  if (port === 8325 || port === 8326) throw new Error('the allocated port belongs to a real bridge')
  const logPath = join(out, 'liencam-bridge.log')
  rmSync(logPath, { force: true })
  rmSync(record, { force: true })
  rmSync(join(out, 'liencam-bridge.definition.json'), { force: true })
  // Homing runs at real time (the bridge must see the board's Home state);
  // everything after it at 10x. The sim re-reads this file every ~0.5 s.
  const boardFile = join(out, 'sim-board.json')
  writeFileSync(boardFile, `${JSON.stringify(SIM_BOARD, null, 2)}\n`, 'utf8')
  const log = () => existsSync(logPath) ? readFileSync(logPath, 'utf8') : ''
  const child = spawn(exe, ['--board', '-19', '--port', String(port)], {
    cwd: out, stdio: 'ignore', windowsHide: true, env: { ...process.env, LIENCAM_SIM_RECORD: record },
  })
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
    await link.settle(() => Math.abs(link!.pos().z - 128.9) < 0.01)
    writeFileSync(boardFile, `${JSON.stringify({ ...SIM_BOARD, timeScale: 10 }, null, 2)}\n`, 'utf8')
    await wait(1_200)
    await link.call('jogToMachineZ', { z: 100, feedMmMin: FEED })
    await link.settle(() => Math.abs(link!.pos().z - 100) < 0.01)
    const set = await link.call('setWorkOffset', { wcs: 'G54', ...OFFSET })
    if ((set.v as { ok?: boolean })?.ok !== true) throw new Error(`offset refused: ${JSON.stringify(set)}`)
    await run(link, port)
  } finally {
    link?.close()
    await stop(child)
  }
}

// ---- the record the simulated board kept --------------------------------

interface Rec { kind: string; fields: Record<string, string> }
function readRecord(path: string): Rec[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => {
    const parts = line.split(' ')
    const fields: Record<string, string> = {}
    for (let i = 1; i + 1 < parts.length; i += 2) fields[parts[i]] = parts[i + 1]
    return { kind: parts[0], fields }
  })
}
const num = (v: string | undefined) => (v === undefined || v === '-' ? Number.NaN : Number(v))
function recordFor(recs: Rec[], id: number): Rec {
  const r = recs.find((x) => (x.kind === 'line' || x.kind === 'arc') && x.fields.id === String(id))
  if (!r) throw new Error(`no board call recorded for move ${id}:\n${recs.map((x) => JSON.stringify(x)).join('\n')}`)
  return r
}

// ---- LinuxCNC's formulas (checked against the sim to 0.000005 mm) ---------

function rot(deg: number, x: number, y: number): { x: number; y: number } {
  const a = (deg * Math.PI) / 180
  return { x: x * Math.cos(a) - y * Math.sin(a), y: x * Math.sin(a) + y * Math.cos(a) }
}

const line = (id: number, to: Record<string, number>) => ({ id, kind: 'line', to, feedMmMin: FEED })
const arc = (id: number, to: Vec, centre: Vec, clockwise: boolean) =>
  ({ id, kind: 'arc', to, centre, clockwise, plane: 'xy', feedMmMin: FEED })

/** The program LinuxCNC ran (G54 X10 Y20 R5), plus a square and a G53 line. */
const Z = 40
const PROGRAM = [
  line(1, { x: 0, y: 0, z: Z }),
  line(2, { x: 100, y: 0, z: Z }),
  line(3, { x: 0, y: 50, z: Z }),
  line(4, { x: -30, y: 40, z: Z }),
  line(5, { x: -20 }), // names only X: work Y stays 40
  line(6, { x: 0, y: 0, z: Z }),
  arc(7, { x: 20, y: 0, z: Z }, { x: 10, y: 0, z: Z }, true), // G2 X20 Y0 I10 J0
  arc(8, { x: 0, y: 0, z: Z }, { x: 10, y: 0, z: Z }, false), // G3 X0 Y0 I-10 J0
  arc(9, { x: 10, y: 10, z: Z }, { x: 10, y: 0, z: Z }, true), // G2 X10 Y10 I10 J0
  line(10, { x: 0, y: 0, z: Z }),
  line(11, { x: 60, y: 0, z: Z }),
  line(12, { x: 60, y: 40, z: Z }),
  line(13, { x: 0, y: 40, z: Z }),
  line(14, { x: 0, y: 0, z: Z }),
  { ...line(15, { x: 350, y: 350 }), machineAbsolute: true }, // G53 G0 X50 Y50 (+D)
]

/** LinuxCNC's MEASURED machine XY (stat.actual_position) for these moves, +D. */
const MEASURED: Record<number, { x: number; y: number }> = {
  1: { x: 10, y: 20 },
  2: { x: 109.61947, y: 28.71557 },
  3: { x: 5.64221, y: 69.80973 },
  4: { x: -23.37207, y: 57.23312 },
  6: { x: 10, y: 20 },
  7: { x: 29.92389, y: 21.74311 },
  8: { x: 10, y: 20 },
  9: { x: 19.09039, y: 30.8335 },
}
/** The rotated arc centre LinuxCNC's 73 samples sat at radius 10.0000 about. */
const MEASURED_CENTRE = { x: 19.9619, y: 20.8716 }

const canBuild = process.platform === 'win32' && existsSync(CSC)

describe('WO-2186 the AXBB-E bridge rotates the work offset the way LinuxCNC does', () => {
  it.skipIf(!canBuild)('rotation 5 deg: program, arcs, jog-to-work, workPos and a work zero match LinuxCNC; G53, jogs and the probe call stay machine', async () => {
    const exe = buildKit('branch', BRIDGE)
    const record = join(BASE_OUT, 'branch', 'moves.rec')
    await withBridge(exe, record, async (link, port) => {
      // ---- set: moves nothing, reported in status and hello --------------
      const before = link.pos()
      const set = await link.call('setWorkRotation', { wcs: 'G54', degrees: 5 })
      expect(set.v, JSON.stringify(set)).toMatchObject({ ok: true, wcs: 'G54', rotation: 5 })
      await wait(500)
      expect(await link.settle(() => link.status?.workRotation === 5)).toBe(true)
      expect(link.pos().x).toBeCloseTo(before.x, 6)
      expect(link.pos().y).toBeCloseTo(before.y, 6)

      // ---- program moves and arcs: LinuxCNC's measured numbers -----------
      await link.call('jogToWorkXY', { x: 0, y: 0, feedMmMin: FEED })
      expect(await link.settle(() => Math.abs(link.pos().x - 310) < 0.001 && Math.abs(link.pos().y - 320) < 0.001)).toBe(true)
      rmSync(record, { force: true })
      expect(await link.runProgram(PROGRAM)).toBe('completed')
      copyFileSync(record, join(BASE_OUT, 'branch', 'rotated-program.rec'))
      const recs = readRecord(record)
      for (const [id, m] of Object.entries(MEASURED)) {
        const r = recordFor(recs, Number(id))
        expect(Math.abs(num(r.fields.x) - (m.x + D.x)), `move ${id} X`).toBeLessThan(0.001)
        expect(Math.abs(num(r.fields.y) - (m.y + D.y)), `move ${id} Y`).toBeLessThan(0.001)
        expect(num(r.fields.z), `move ${id} Z`).toBe(Z + OFFSET.z)
      }
      for (const id of [7, 9]) {
        const r = recordFor(recs, id)
        expect(Math.abs(num(r.fields.cx) - (MEASURED_CENTRE.x + D.x)), `arc ${id} centre X`).toBeLessThan(0.001)
        expect(Math.abs(num(r.fields.cy) - (MEASURED_CENTRE.y + D.y)), `arc ${id} centre Y`).toBeLessThan(0.001)
        expect(num(r.fields.cz)).toBe(Z + OFFSET.z)
      }
      // The block that named only X: work Y 40 kept, so machine X AND Y move.
      const partial = recordFor(recs, 5)
      const p5 = rot(5, -20, 40)
      expect(Math.abs(num(partial.fields.x) - (OFFSET.x + p5.x))).toBeLessThan(0.000001)
      expect(Math.abs(num(partial.fields.y) - (OFFSET.y + p5.y))).toBeLessThan(0.000001)
      expect(partial.fields.z).toBe('-')
      // THE SIGN, AS AN OUTCOME: every point on work X lies on the line through
      // the origin at +5 deg (the wrong sign puts them on -5 deg, 0.17 mm off
      // per 1 mm... 8.7 mm off at X 100).
      for (const id of [2, 11]) {
        const r = recordFor(recs, id)
        const dx = num(r.fields.x) - OFFSET.x
        const dy = num(r.fields.y) - OFFSET.y
        const offLine = Math.abs(-Math.sin((5 * Math.PI) / 180) * dx + Math.cos((5 * Math.PI) / 180) * dy)
        expect(offLine, `move ${id} off the rotated work X line`).toBeLessThan(0.001)
        expect(dx).toBeGreaterThan(0)
      }
      // The square keeps its shape: 60 x 40, square corners.
      const sq = [10, 11, 12, 13].map((id) => recordFor(recs, id)).map((r) => ({ x: num(r.fields.x), y: num(r.fields.y) }))
      expect(Math.hypot(sq[1].x - sq[0].x, sq[1].y - sq[0].y)).toBeCloseTo(60, 9)
      expect(Math.hypot(sq[2].x - sq[1].x, sq[2].y - sq[1].y)).toBeCloseTo(40, 9)
      expect((sq[1].x - sq[0].x) * (sq[2].x - sq[1].x) + (sq[1].y - sq[0].y) * (sq[2].y - sq[1].y)).toBeCloseTo(0, 9)
      // G53 is machine, unrotated.
      const g53 = recordFor(recs, 15)
      expect([num(g53.fields.x), num(g53.fields.y), g53.fields.z]).toEqual([350, 350, '-'])
      // The work DRO at machine (50, 50)+D: LinuxCNC's #5420/#5421.
      expect(Math.abs(link.work().x - 42.46246)).toBeLessThan(0.001)
      expect(Math.abs(link.work().y - 26.399611)).toBeLessThan(0.001)

      // ---- jog-to-work: G54 X30 Y0 -> LinuxCNC act (39.88584, 22.61467) ---
      rmSync(record, { force: true })
      await link.call('jogToWorkXY', { x: 30, y: 0, feedMmMin: FEED })
      expect(await link.settle(() => Math.abs(link.work().x - 30) < 0.001)).toBe(true)
      const jogTo = readRecord(record).find((r) => r.kind === 'line')!
      expect(Math.abs(num(jogTo.fields.x) - (39.88584 + D.x))).toBeLessThan(0.001)
      expect(Math.abs(num(jogTo.fields.y) - (22.61467 + D.y))).toBeLessThan(0.001)
      expect(Math.abs(link.work().y)).toBeLessThan(0.001)

      // ---- jogs are machine-axis moves (LinuxCNC: never rotated) --------
      const atJog = link.pos()
      await link.call('jog', { axis: 'X', deltaMm: 10, feedMmMin: FEED })
      expect(await link.settle(() => Math.abs(link.pos().x - (atJog.x + 10)) < 0.001)).toBe(true)
      expect(link.pos().y).toBeCloseTo(atJog.y, 6)

      // ---- the native probe call: a MACHINE-axis target, unrotated --------
      await link.call('jogToWorkXY', { x: 0, y: 0, feedMmMin: FEED })
      expect(await link.settle(() => Math.abs(link.pos().x - 310) < 0.001)).toBe(true)
      rmSync(record, { force: true })
      const probe = await link.call('probe', { axis: 'X', targetMm: 200, feedMmMin: 3000 }, 120_000)
      const touch = probe.v as { ok: boolean; at: Vec }
      expect(touch?.ok, JSON.stringify(probe)).toBe(true)
      expect(readRecord(record).find((r) => r.kind === 'probe')?.fields).toMatchObject({ axis: '0', to: '200' })
      expect(touch.at.x).toBeCloseTo(250, 3)
      expect(touch.at.y).toBeCloseTo(320, 3)
      // ... and the work readout of that contact is the rotated one.
      expect(await link.settle()).toBe(true)
      const contactWork = rot(-5, touch.at.x - OFFSET.x, touch.at.y - OFFSET.y)
      expect(Math.abs(link.work().x - contactWork.x)).toBeLessThan(0.001)
      expect(Math.abs(link.work().y - contactWork.y)).toBeLessThan(0.001)
      await link.call('jog', { axis: 'X', deltaMm: 5, feedMmMin: 3000 })
      expect(await link.settle(() => link.pos().x > 254)).toBe(true)

      // ---- a work zero on X keeps the Y readout (G10 L20 under R) ----------
      const wy = link.work().y
      const here = link.pos()
      const zero = await link.call('zeroWorkAxis', { axis: 'X' })
      const zv = zero.v as { ok: boolean; offset: Vec }
      expect(zv?.ok, JSON.stringify(zero)).toBe(true)
      const zr = rot(5, 0, wy)
      expect(Math.abs(zv.offset.x - (here.x - zr.x))).toBeLessThan(0.001)
      expect(Math.abs(zv.offset.y - (here.y - zr.y))).toBeLessThan(0.001)
      await wait(400)
      expect(Math.abs(link.work().x)).toBeLessThan(0.001)
      expect(Math.abs(link.work().y - wy)).toBeLessThan(0.001)

      // ---- LinuxCNC's second case: G54 -7,13,2 R-12.5, G0 X25 Y-15 Z3 ------
      await link.call('setWorkOffset', { wcs: 'G54', x: -7 + D.x, y: 13 + D.y, z: 62 })
      expect((await link.call('setWorkRotation', { degrees: -12.5 })).v).toMatchObject({ ok: true, rotation: -12.5 })
      rmSync(record, { force: true })
      expect(await link.runProgram([line(1, { x: 25, y: -15, z: 3 }), { ...line(2, { x: 260, y: 375 }), machineAbsolute: true }])).toBe('completed')
      const second2 = recordFor(readRecord(record), 1)
      expect(Math.abs(num(second2.fields.x) - (14.16081 + D.x))).toBeLessThan(0.001)
      expect(Math.abs(num(second2.fields.y) - (-7.05543 + D.y))).toBeLessThan(0.001)
      expect(num(second2.fields.z)).toBe(65)
      // G53 X-40 Y75 (+D) under that frame -> #5420/#5421 -45.637024, 53.387845
      expect(Math.abs(link.work().x - -45.637024)).toBeLessThan(0.001)
      expect(Math.abs(link.work().y - 53.387845)).toBeLessThan(0.001)

      // ---- a first XY block naming only X, resolved against where it stands --
      await link.call('setWorkOffset', { wcs: 'G54', ...OFFSET })
      await link.call('setWorkRotation', { wcs: 'G54', degrees: 5 })
      await link.call('jogToWorkXY', { x: 0, y: 0, feedMmMin: FEED })
      expect(await link.settle(() => Math.abs(link.pos().x - 310) < 0.001 && Math.abs(link.pos().y - 320) < 0.001)).toBe(true)
      rmSync(record, { force: true })
      expect(await link.runProgram([line(1, { x: 20 })])).toBe('completed')
      const first = recordFor(readRecord(record), 1)
      expect(Math.abs(num(first.fields.x) - (29.92389 + D.x))).toBeLessThan(0.001)
      expect(Math.abs(num(first.fields.y) - (21.74311 + D.y))).toBeLessThan(0.001)
      // ... and if the tool moves between load and start, nothing is sent.
      await link.call('jogToWorkXY', { x: 0, y: 0, feedMmMin: FEED })
      expect(await link.settle(() => Math.abs(link.pos().x - 310) < 0.001)).toBe(true)
      link.jobEvents.length = 0
      expect((await link.call('loadMoves', { moves: [line(1, { x: 20 })], frame: 'work' })).v).toMatchObject({ ok: true })
      await link.call('jog', { axis: 'Y', deltaMm: 2, feedMmMin: FEED })
      expect(await link.settle(() => Math.abs(link.pos().y - 322) < 0.001)).toBe(true)
      rmSync(record, { force: true })
      await link.call('startJob', {})
      const endFail = Date.now() + 10_000
      while (Date.now() < endFail && !link.jobEvents.some((e) => e.event === 'failed')) await wait(20)
      expect(link.jobEvents.find((e) => e.event === 'failed')?.fault?.message ?? JSON.stringify(link.jobEvents))
        .toContain('the tool has moved since it was loaded')
      expect(readRecord(record).filter((r) => r.kind === 'line' || r.kind === 'arc')).toEqual([])

      // ---- an XZ arc under a rotation cannot be cut: refused, nothing staged --
      const xz = await link.call('loadMoves', {
        moves: [{ id: 1, kind: 'arc', to: { x: 20, y: 0, z: 0 }, centre: { x: 10, y: 0, z: 0 }, clockwise: true, plane: 'xz', feedMmMin: FEED }],
        frame: 'work',
      })
      expect((xz.v as { ok: boolean; reason: string }).ok).toBe(false)
      expect((xz.v as { reason: string }).reason).toContain('XZ plane')

      // ---- clear -> identical to no rotation: O + work, to the bit ---------
      expect((await link.call('setWorkRotation', { wcs: 'G54', degrees: 0 })).v).toMatchObject({ ok: true, rotation: 0 })
      await link.call('jogToWorkXY', { x: 0, y: 0, feedMmMin: FEED })
      expect(await link.settle(() => Math.abs(link.pos().y - 320) < 0.001 && link.status?.workRotation === 0)).toBe(true)
      rmSync(record, { force: true })
      expect(await link.runProgram(PROGRAM)).toBe('completed')
      const cleared = readRecord(record)
      for (const step of PROGRAM) {
        const r = recordFor(cleared, step.id)
        const to = step.to as Partial<Vec>
        const g53 = 'machineAbsolute' in step
        expect(r.fields.x).toBe(to.x === undefined ? '-' : String(g53 ? to.x : to.x + OFFSET.x))
        expect(r.fields.y).toBe(to.y === undefined ? '-' : String(g53 ? to.y : to.y + OFFSET.y))
        expect(r.fields.z).toBe(to.z === undefined ? '-' : String(to.z + OFFSET.z))
      }
      // ---- hello reports every system's rotation beside its offsets --------
      expect((await link.call('setWorkRotation', { wcs: 'G54', degrees: 5 })).v).toMatchObject({ ok: true, wcs: 'G54' })
      expect((await link.call('setWorkRotation', { wcs: 'G55', degrees: -7.25 })).v).toMatchObject({ ok: true, wcs: 'G55', rotation: -7.25 })
      expect((await link.call('setWorkRotation', { wcs: 'G54', degrees: 'abc' })).v).toMatchObject({ ok: false })
      expect((await link.call('setWorkRotation', { wcs: 'G99', degrees: 1 })).v).toMatchObject({ ok: false })
      link.close()
      await wait(1_000)
      const next = await Link.open(port)
      try {
        const helloEnd = Date.now() + 10_000
        while ((!next.hello || !next.status) && Date.now() < helloEnd) await wait(20)
        const offsets = next.hello?.workOffsets as { current: Record<string, Vec>; rotation: Record<string, number> }
        expect(offsets.rotation).toEqual({ G54: 5, G55: -7.25, G56: 0, G57: 0, G58: 0, G59: 0 })
        expect(offsets.current.G54).toMatchObject({ x: OFFSET.x, y: OFFSET.y, z: OFFSET.z })
        expect(next.status?.workRotation).toBe(5)
      } finally { next.close() }
      writeFileSync(join(BASE_OUT, 'branch', 'rotated.pass'), new Date().toISOString())
    })
  }, 600_000)

  it.skipIf(!canBuild)('rotation 0: every board call byte-identical to the bridge this branch started from', async () => {
    const script = async (link: Link) => {
      await link.call('jogToWorkXY', { x: 0, y: 0, feedMmMin: FEED })
      await link.settle(() => Math.abs(link.pos().x - 310) < 0.001 && Math.abs(link.pos().y - 320) < 0.001)
      expect(await link.runProgram(PROGRAM)).toBe('completed')
      await link.call('jogToWorkXY', { x: 30, y: 0, feedMmMin: FEED })
      await link.settle(() => Math.abs(link.work().x - 30) < 0.001)
      await link.call('jog', { axis: 'X', deltaMm: 10, feedMmMin: FEED })
      await link.settle(() => Math.abs(link.work().x - 40) < 0.001)
      await link.call('jogToWorkXY', { x: 0, y: 0, feedMmMin: FEED })
      await link.settle(() => Math.abs(link.pos().x - 310) < 0.001)
      const probe = await link.call('probe', { axis: 'X', targetMm: 200, feedMmMin: 3000 }, 120_000)
      expect((probe.v as { ok: boolean }).ok).toBe(true)
      await link.settle()
      await link.call('jog', { axis: 'X', deltaMm: 5, feedMmMin: 3000 })
      await link.settle(() => link.pos().x > 254)
      expect((await link.call('zeroWorkAxis', { axis: 'X' })).v).toMatchObject({ ok: true })
      await link.call('jogToWorkXY', { x: 5, y: 5, feedMmMin: FEED })
      await link.settle(() => Math.abs(link.work().x - 5) < 0.001)
      return { work: link.work() }
    }
    const branchExe = buildKit('branch0', BRIDGE)
    const baseExe = buildKit('base0', baseSources())
    const branchRec = join(BASE_OUT, 'branch0', 'moves.rec')
    const baseRec = join(BASE_OUT, 'base0', 'moves.rec')
    let branchWork: Vec | null = null
    let baseWork: Vec | null = null
    await withBridge(branchExe, branchRec, async (link) => { branchWork = (await script(link)).work })
    await withBridge(baseExe, baseRec, async (link) => { baseWork = (await script(link)).work })
    const a = readFileSync(branchRec, 'utf8')
    const b = readFileSync(baseRec, 'utf8')
    expect(a.split('\n').filter((l) => l.startsWith('line') || l.startsWith('arc')).length).toBeGreaterThan(PROGRAM.length)
    expect(a).toBe(b)
    expect(branchWork).toEqual(baseWork)
    writeFileSync(join(BASE_OUT, 'branch0', 'identical.pass'), `${a.split('\n').length - 1} records\n`)
  }, 600_000)
})
