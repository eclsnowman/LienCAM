// @vitest-environment node
// WO-3060 / WO-1054: "a stop during execution must not become a completion".
// Tier 2: the unmodified Bridge.cs/Machine.cs compiled with csc against the
// stock timed SimUC100 kit, driven over its real loopback WebSocket. Never
// dials a hardware port. Windows/csc desk evidence; skipped where csc is absent.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const out = join(tmpdir(), 'liencam-wo3060-kit')
const root = join(out, 'uccnc')
const exe = join(out, 'liencam-bridge-sim.exe')
const kit = resolve('src/tests/evidence/NATIVE-PROBE-REHEARSAL')
const bridgeDir = resolve('pendant/uccnc-bridge')
const csc = join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
const wait = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))

type Frame = { t: string; seq?: number; ok?: boolean; error?: string; v?: any }
let child: ChildProcess | null = null
let ws: WebSocket | null = null
let frames: Array<{ at: number; frame: Frame }> = []
let seq = 0
let port = 0
// Fix round 1: the BOARD's own E-STOP. The stock SimUC100 never reports one, so
// the test builds a copy of its UC100 class whose GetStatus answers E-STOP
// while this file exists - "rc" as UC100_ESTOP (7), "stat" as rc 0 with
// Stat.Estop set - and stops the sim's motion the way the board does. Absent
// file, it is the stock class byte for byte in behaviour. The kit is untouched.
const estopInput = join(out, 'wo3060-estop-input.txt')

function build() {
  mkdirSync(join(root, 'API', 'DLL'), { recursive: true })
  mkdirSync(join(root, 'Profiles'), { recursive: true })
  execFileSync(csc, [
    '/nologo', '/unsafe', '/platform:x64', '/target:exe', '/main:LienCAM.Bridge', `/out:${exe}`,
    ...['Bridge.cs', 'Machine.cs', 'Json.cs', 'Vfd.cs'].map((name) => join(bridgeDir, name)),
    join(kit, 'SimUC100.cs'), simApiWithEstopInput(),
  ], { encoding: 'utf8', timeout: 120_000 })
  cpSync(join(bridgeDir, 'boards'), join(out, 'boards'), { recursive: true })
  writeFileSync(join(root, 'API', 'DLL', 'UC100.dll'), '')
  writeFileSync(join(root, 'ftd2xx64.dll'), '')
  copyFileSync(resolve('docs/machine/profiles/LienCNCV2.pro'), join(root, 'Profiles', 'LienCNCV2.pro'))
  writeFileSync(join(out, 'liencam-bridge.config.json'), JSON.stringify({ installRoot: root, profile: 'LienCNCV2.pro', board: -19 }))
  // An air run: no solids in the way, only the setter the kit always carries.
  const board = JSON.parse(readFileSync(join(kit, 'sim-board.example.json'), 'utf8'))
  board.boxes = board.boxes.filter((box: { name: string }) => box.name === 'setter')
  writeFileSync(join(out, 'sim-board.json'), JSON.stringify(board))
}

function simApiWithEstopInput() {
  const stock = readFileSync(join(kit, 'SimUC100Api.cs'), 'utf8').replace(/\r\n/g, '\n')
  const anchor = '        SStat.SpindleDir = spindleCcw;\n        return 0;\n'
  if (!stock.includes(anchor)) throw new Error('SimUC100Api.cs GetStatus changed shape - update the WO-3060 E-STOP input patch')
  const patched = stock.replace(anchor, [
    '        SStat.SpindleDir = spindleCcw;',
    '        // WO-3060 test-only: the board reports its own E-STOP input.',
    '        string wo3060 = System.IO.File.Exists("wo3060-estop-input.txt")',
    '            ? System.IO.File.ReadAllText("wo3060-estop-input.txt").Trim() : null;',
    '        if (wo3060 == "rc" || wo3060 == "stat")',
    '        {',
    '            SimBoard.StopAll();',
    '            SimBoard.Status(ref SStat);',
    '            if (wo3060 == "rc") return 7;',
    '            SStat.Estop = true;',
    '        }',
    '        return 0;',
    '',
  ].join('\n'))
  const file = join(out, 'SimUC100Api.wo3060.cs')
  writeFileSync(file, patched)
  return file
}

async function freePort(): Promise<number> {
  return new Promise((done) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const p = (server.address() as { port: number }).port
      server.close(() => done(p))
    })
  })
}

async function call(m: string, a?: unknown, timeoutMs = 60_000): Promise<Frame> {
  const s = ++seq
  ws!.send(JSON.stringify({ t: 'call', seq: s, m, ...(a === undefined ? {} : { a }) }))
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    const reply = frames.find((f) => f.frame.t === 'reply' && f.frame.seq === s)
    if (reply) return reply.frame
    await wait(10)
  }
  return { t: 'reply', ok: false, error: `timeout on ${m}` }
}

const lastStatus = () => [...frames].reverse().find((f) => f.frame.t === 'status')?.frame.v
async function settleIdle(timeoutMs = 60_000) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) { if (lastStatus()?.state === 'idle') return; await wait(25) }
}
async function until(pred: () => boolean, timeoutMs: number) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) { if (pred()) return true; await wait(25) }
  return pred()
}
const since = (t0: number) => frames.filter((f) => f.at >= t0).map((f) => f.frame)
const jobEvents = (t0: number) => since(t0).filter((f) => f.t === 'jobEvent').map((f) => f.v.event as string)
const consoleText = (t0: number) => since(t0).filter((f) => f.t === 'console').map((f) => String(f.v?.text ?? ''))

/** `count` X moves of `stepMm` each at `feed`, Z already safe. Machine frame. */
function program(count: number, stepMm: number, feed: number) {
  const moves = [{ id: 1, kind: 'line', feedMmMin: 3000, to: { x: 700, y: 700, z: 120 } }]
  for (let i = 1; i < count; i++) moves.push({ id: i + 1, kind: 'line', feedMmMin: feed, to: { x: 700 - i * stepMm, y: 700, z: 120 } })
  return moves
}

/** Load and start a program; resolves once every move has been pushed, i.e.
 *  the run is DRAINING - the window WO-1054's completion watcher owns. */
async function startDraining(moves: ReturnType<typeof program>) {
  await settleIdle()
  const load = await call('loadMoves', { moves, frame: 'machine' })
  expect(load.ok && load.v?.ok, JSON.stringify(load)).toBe(true)
  const t0 = Date.now()
  const start = await call('startJob')
  expect(start.ok, JSON.stringify(start)).toBe(true)
  const pushed = await until(() => consoleText(t0).some((t) => t.includes(`program finished: ${moves.length} of ${moves.length} moves pushed`)), 10_000)
  expect(pushed, consoleText(t0).join('\n')).toBe(true)
  return t0
}

const canRun = process.platform === 'win32' && existsSync(csc)

async function connect() {
  const end = Date.now() + 30_000
  while (Date.now() < end) {
    if (child?.exitCode !== null) throw new Error('sim bridge exited')
    try {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/`)
      socket.onmessage = (event) => frames.push({ at: Date.now(), frame: JSON.parse(String(event.data)) })
      await new Promise((done, fail) => { socket.onopen = done; socket.onerror = fail })
      return socket
    } catch { await wait(100) }
  }
  throw new Error('sim bridge did not listen')
}

/** The board's E-STOP input while the run DRAINS, then released and Stop/Reset
 *  pressed, as at the machine. Never COMPLETE; one line names the input. */
async function estopInputWhileDraining(mode: 'rc' | 'stat') {
  const t0 = await startDraining(program(11, 10, 300))
  await wait(1500)
  writeFileSync(estopInput, mode)
  try {
    expect(await until(() => lastStatus()?.state === 'alarm', 5000)).toBe(true)
    await wait(2000)
  } finally { rmSync(estopInput, { force: true }) }
  expect(await until(() => lastStatus()?.state === 'idle', 5000)).toBe(true)
  await wait(1500)
  const reset = await call('reset')
  expect(reset.ok, JSON.stringify(reset)).toBe(true)
  await wait(2000)
  const text = consoleText(t0)
  expect(text.some((t) => t.includes('program COMPLETE')), text.join('\n')).toBe(false)
  expect(jobEvents(t0)).toEqual(['started', 'stopped'])
  expect(text.filter((t) => /program STOPPED by the E-STOP input/.test(t)), text.join('\n')).toHaveLength(1)
  expect(text.some((t) => /program STOPPED by Stop\/Reset/.test(t)), text.join('\n')).toBe(false)
  expect(lastStatus()?.machinePos?.x).toBeGreaterThan(640)
}

describe.skipIf(!canRun)('WO-3060: a stop during execution never becomes a completion (real bridge, SimUC100 kit)', () => {
  beforeAll(async () => {
    rmSync(estopInput, { force: true })
    build()
    port = await freePort()
    if ([8325, 8326].includes(port)) throw new Error('refusing a hardware port')
    child = spawn(exe, ['--board', '-19', '--port', String(port)], { cwd: out, stdio: 'ignore', windowsHide: true })
    ws = await connect()
    await wait(500)
    const machine = JSON.parse(readFileSync(resolve('docs/machine/profiles/LienCNCV2.machine.json'), 'utf8'))
    const definition = machine.controllerDefinition
    const provenance = definition.stated?.map((row: any) => row?.liencamProfileDriftProvenance)
      .find((row: unknown) => row && typeof row === 'object') ?? {}
    const apply = await call('applyMachineDefinition', { definition, provenance }, 120_000)
    expect(apply.ok && apply.v?.ok, JSON.stringify(apply)).toBe(true)
    const home = await call('homeAxes', { axes: ['Z', 'X', 'Y'] }, 120_000)
    expect(home.ok, JSON.stringify(home)).toBe(true)
    await settleIdle()
  }, 240_000)

  afterAll(async () => {
    ws?.close()
    if (child && child.exitCode === null) {
      const ended = new Promise((done) => child!.once('exit', done))
      child.kill()
      await ended
    }
  })

  it('control: a clean run that drains still reports completed', async () => {
    const t0 = await startDraining(program(3, 1, 600))
    await until(() => jobEvents(t0).includes('completed'), 15_000)
    expect(jobEvents(t0)).toEqual(['started', 'completed'])
    expect(consoleText(t0).some((t) => t.includes('program COMPLETE'))).toBe(true)
  }, 60_000)

  it('control: Stop while draining ends stopped, never completed (WO-1054, unchanged)', async () => {
    const t0 = await startDraining(program(11, 10, 300))
    await wait(1500)
    const stop = await call('stopJob')
    expect(stop.ok, JSON.stringify(stop)).toBe(true)
    await wait(4000)
    expect(jobEvents(t0)).toEqual(['started', 'stopped'])
    expect(consoleText(t0).some((t) => t.includes('program COMPLETE'))).toBe(false)
  }, 60_000)

  it('Stop/Reset while draining ends stopped, never completed, and the console names it', async () => {
    const t0 = await startDraining(program(11, 10, 300))
    await wait(1500)
    const reset = await call('reset')
    expect(reset.ok, JSON.stringify(reset)).toBe(true)
    await wait(4000)
    expect(jobEvents(t0)).toEqual(['started', 'stopped'])
    const text = consoleText(t0)
    expect(text.some((t) => t.includes('program COMPLETE')), text.join('\n')).toBe(false)
    expect(text.some((t) => /program STOPPED by Stop\/Reset/.test(t)), text.join('\n')).toBe(true)
  }, 60_000)

  it('the board reports E-STOP (rc UC100_ESTOP) while draining: stopped, never completed, after release and reset', async () => {
    await estopInputWhileDraining('rc')
  }, 60_000)

  it('the board reports E-STOP (Stat.Estop) while draining: stopped, never completed, after release and reset', async () => {
    await estopInputWhileDraining('stat')
  }, 60_000)

  it('socket loss while draining, then reconnect: stopped, never completed, and the console names the connection-loss stop', async () => {
    const t0 = await startDraining(program(11, 10, 300))
    await wait(1500)
    const dropped = ws!
    await new Promise<void>((done) => { dropped.onclose = () => done(); dropped.close() })
    await wait(2000)
    ws = await connect()
    await wait(6000)
    const text = consoleText(t0)
    expect(text.some((t) => t.includes('program COMPLETE')), text.join('\n')).toBe(false)
    expect(jobEvents(t0)).toEqual(['started', 'stopped'])
    expect(text.some((t) => /program STOPPED by the connection-loss stop/.test(t)), text.join('\n')).toBe(true)
    expect(lastStatus()?.machinePos?.x).toBeGreaterThan(640)
  }, 60_000)

  it('E-STOP while draining ends stopped, never completed, and the console names the E-STOP', async () => {
    const t0 = await startDraining(program(11, 10, 300))
    await wait(1500)
    const xAtStop = lastStatus()?.machinePos?.x
    const estop = await call('emergencyStop')
    expect(estop.ok, JSON.stringify(estop)).toBe(true)
    await wait(4000)
    const text = consoleText(t0)
    // The kit's measured symptom: ~8 s after E-STOP "[bridge] program COMPLETE
    // ... all 11 move(s) have been executed" while the machine stood mid-program.
    expect(text.some((t) => t.includes('program COMPLETE')), text.join('\n')).toBe(false)
    expect(jobEvents(t0)).toEqual(['started', 'stopped'])
    expect(text.some((t) => /program STOPPED by E-STOP/.test(t)), text.join('\n')).toBe(true)
    // And it really did stop part way: nowhere near the last move's X 600.
    expect(typeof xAtStop).toBe('number')
    expect(lastStatus()?.machinePos?.x).toBeGreaterThan(640)
  }, 60_000)
})
