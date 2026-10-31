// @vitest-environment node
// Real production bridge + the stock timed SimUC100. No hardware endpoint.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const out = join(tmpdir(), 'liencam-native-rehearsal')
const exe = join(out, 'liencam-bridge-sim.exe')
const evidence = resolve('src/tests/evidence/WO-3124')
const csc = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe'
const stall = join(out, 'wo3124-stall.txt')
const entered = join(out, 'wo3124-stall-entered.txt')
const wait = (ms: number) => new Promise<void>(done => setTimeout(done, ms))
type Frame = { t: string; seq?: number; ok?: boolean; error?: string; v?: any }
let child: ChildProcess | undefined
let ws: WebSocket
let port: number
let seq = 0
const frames: Frame[] = []
const wire: unknown[] = []
const machine = JSON.parse(readFileSync(resolve('docs/machine/profiles/LienCNCV2.machine.json'), 'utf8'))
const definition = machine.controllerDefinition
const provenance = definition.stated?.map((r: any) => r?.liencamProfileDriftProvenance)
  .find((r: unknown) => r && typeof r === 'object') ?? {}

async function until(predicate: () => boolean, ms = 10_000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) { if (predicate()) return; await wait(20) }
  expect(predicate(), 'timed simulator condition').toBe(true)
}
async function connect() {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/`)
  socket.onmessage = event => {
    const frame = JSON.parse(String(event.data)) as Frame
    frames.push(frame)
    wire.push({ direction: 'rx', frame })
  }
  await new Promise<void>((done, fail) => { socket.onopen = () => done(); socket.onerror = fail })
  ws = socket
  await until(() => frames.some(f => f.t === 'hello'))
  const hello = frames.findLast(f => f.t === 'hello')!
  expect(hello.v.uccnc.board).toBe(-19)
  // Confirm the actual process was built with the stock fake API BEFORE traffic.
  expect(readFileSync(join(out, 'liencam-bridge.log'), 'utf8')).toContain('SIMULATED UC100')
}
async function call(m: string, a?: unknown): Promise<Frame> {
  const s = ++seq
  const frame = { t: 'call', seq: s, m, ...(a === undefined ? {} : { a }) }
  wire.push({ direction: 'tx', frame })
  ws.send(JSON.stringify(frame))
  await until(() => frames.some(f => f.t === 'reply' && f.seq === s), 120_000)
  return frames.find(f => f.t === 'reply' && f.seq === s)!
}
async function ok(m: string, a?: unknown) {
  const reply = await call(m, a)
  expect(reply.ok, JSON.stringify(reply)).toBe(true)
  return reply
}
const apply = () => call('applyMachineDefinition', { definition, provenance })
const status = () => frames.findLast(f => f.t === 'status')?.v
async function idle() { await until(() => status()?.state === 'idle') }
const moves = [
  { id: 1, kind: 'line', feedMmMin: 3000, to: { x: 700, y: 700, z: 120 } },
  { id: 2, kind: 'line', feedMmMin: 60, to: { x: 690, y: 700, z: 120 } },
]
async function load() {
  const reply = await ok('loadMoves', { moves, frame: 'machine' })
  expect(reply.v?.ok, JSON.stringify(reply)).toBe(true)
}
async function acceptsApply() {
  const reply = await apply()
  expect(reply.ok && reply.v?.ok, JSON.stringify(reply)).toBe(true)
  // Apply's lines are generated from the simulated board Get* readbacks.
  expect(reply.v.lines.some((l: { text: string }) => /read.?back|held|verified/i.test(l.text)), JSON.stringify(reply)).toBe(true)
}
async function refusesApply() {
  const reply = await apply()
  expect(reply.ok && reply.v?.ok, JSON.stringify(reply)).toBe(false)
  expect(reply.v?.lines ?? []).toHaveLength(0)
}
async function reconnect() {
  const oldHelloCount = frames.filter(f => f.t === 'hello').length
  await new Promise<void>(done => { ws.onclose = () => done(); ws.close() })
  await wait(300)
  await connect()
  await until(() => frames.filter(f => f.t === 'hello').length > oldHelloCount)
  await idle()
}

describe.skipIf(process.platform !== 'win32' || !existsSync(csc))('WO-3124 stopped Apply, real bridge and timed SimUC100', () => {
  beforeAll(async () => {
    execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      resolve('src/tests/evidence/NATIVE-PROBE-REHEARSAL/build.ps1')], { encoding: 'utf8', timeout: 120_000 })
    // Test-only delayed board read, at the SAME established simulator output.
    // No product/stock-kit source is edited. Normally the API is unchanged.
    const stock = readFileSync(resolve('src/tests/evidence/NATIVE-PROBE-REHEARSAL/SimUC100Api.cs'), 'utf8')
    const anchor = 'public static int GetStatus(ref Stat SStat)'
    const at = stock.indexOf(anchor)
    expect(at).toBeGreaterThan(0)
    const brace = stock.indexOf('{', at)
    const api = join(evidence, 'SimUC100Api.delayed.cs')
    writeFileSync(api, stock.slice(0, brace + 1) + `
        if (System.IO.File.Exists("wo3124-stall.txt")) {
            System.IO.File.Delete("wo3124-stall.txt");
            System.IO.File.WriteAllText("wo3124-stall-entered.txt", "entered");
            System.Threading.Thread.Sleep(14000);
        }
` + stock.slice(brace + 1))
    execFileSync(csc, ['/nologo', '/unsafe', '/platform:x64', '/target:exe', '/main:LienCAM.Bridge', `/out:${exe}`,
      ...['Bridge.cs', 'Machine.cs', 'Json.cs', 'Vfd.cs'].map(name => resolve('pendant/uccnc-bridge', name)),
      resolve('src/tests/evidence/NATIVE-PROBE-REHEARSAL/SimUC100.cs'), api,
    ], { encoding: 'utf8', timeout: 120_000 })
    rmSync(stall, { force: true })
    rmSync(entered, { force: true })
    const board = JSON.parse(readFileSync(resolve('src/tests/evidence/NATIVE-PROBE-REHEARSAL/sim-board.example.json'), 'utf8'))
    board.boxes = board.boxes.filter((b: { name: string }) => b.name === 'setter')
    writeFileSync(join(out, 'sim-board.json'), JSON.stringify(board))
    port = await new Promise<number>(done => {
      const server = createServer()
      server.listen(0, '127.0.0.1', () => {
        const p = (server.address() as { port: number }).port
        server.close(() => done(p))
      })
    })
    if ([8325, 8326].includes(port)) throw new Error('hardware ports forbidden')
    child = spawn(exe, ['--board', '-19', '--port', String(port)], { cwd: out, windowsHide: true, stdio: 'ignore' })
    await wait(800)
    await connect()
    await idle()
  }, 150_000)
  afterAll(async () => {
    writeFileSync(join(evidence, process.env.WO3124_WIRE ?? 'wire.json'), JSON.stringify(wire))
    ws?.close()
    if (child && child.exitCode === null) {
      const ended = new Promise(done => child!.once('exit', done))
      child.kill()
      await ended
    }
  })
  it('fresh Apply reads settings back from the simulated board', async () => {
    await acceptsApply()
    await ok('homeAxes', { axes: ['Z', 'X', 'Y'] })
    await idle()
  }, 150_000)
  it('idle loaded program -> Reset -> Apply accepts the advertised remedy', async () => {
    await load()
    await refusesApply()
    await ok('reset')
    await idle()
    await acceptsApply()
  }, 150_000)
  it('idle rearmed program -> disconnect/reconnect -> Apply retires old session staging', async () => {
    await ok('stopJob')
    await load()
    await reconnect()
    await acceptsApply()
  }, 150_000)
  it('a new unrelated program survives refused Apply and late old teardown', async () => {
    await ok('stopJob')
    await load()
    await reconnect()
    await load()
    await wait(5500)
    await refusesApply()
    await refusesApply()
    await ok('stopJob')
    await acceptsApply()
  }, 150_000)
  it('running/draining and held Apply stay refused; Reset ends stopped, never completed', async () => {
    await load()
    const start = frames.length
    await ok('startJob')
    await until(() => frames.slice(start).some(f => f.t === 'jobEvent' && f.v.event === 'started'))
    await refusesApply()
    await ok('feedHold')
    await refusesApply()
    await ok('reset')
    await idle()
    await wait(2000)
    const events = frames.slice(start).filter(f => f.t === 'jobEvent').map(f => f.v.event)
    expect(events).toContain('stopped')
    expect(events).not.toContain('completed')
    await acceptsApply()
  }, 150_000)
  it('run -> Stop -> same-session rearm -> reconnect -> Reset -> Apply succeeds', async () => {
    await load()
    await ok('startJob')
    await ok('stopJob')
    await idle()
    await load() // production takeOperatorStop intentionally rearms the kept file
    await refusesApply()
    await reconnect()
    await ok('reset')
    await acceptsApply()
  }, 150_000)
  it('single-block remainder stays protected until explicit ResetToIdle', async () => {
    await ok('setSingleBlockMode', { on: true })
    await load()
    const start = frames.length
    await ok('startJob')
    await until(() => frames.slice(start).some(f => f.t === 'jobEvent' && f.v.event === 'paused'))
    await refusesApply()
    const reset = await ok('resetToIdle')
    expect(reset.v?.ok, JSON.stringify(reset)).toBe(true)
    await ok('setSingleBlockMode', { on: false })
    await acceptsApply()
  }, 150_000)
  it('timed-out old teardown cannot erase a newly connected session program', async () => {
    writeFileSync(stall, 'stall the simulated board owner only')
    await until(() => existsSync(entered))
    await new Promise<void>(done => { ws.onclose = () => done(); ws.close() })
    // Server sends the close only AFTER its 5 s panic-stop wait. Do not wait
    // that budget twice: the next session must arrive while the stop is queued.
    await wait(100)
    const before = frames.length
    await connect() // also exhausts the new session hold-clear wait
    await until(() => frames.slice(before).some(f => f.t === 'hello'))
    await load() // LoadMoves is answered on the frame reader, not board owner
    await wait(5000) // old queued PanicStop has now landed
    const active = await ok('hasActiveJob')
    expect(active.v, 'late old PanicStop must preserve the new session staging').toBe(true)
    await refusesApply()
    await ok('stopJob')
  }, 150_000)
  it('production session rejects a cancelled Apply receipt after reconnect and preserves the replacement load', async () => {
    // Real app modules, UccncController, WebSocket and timed board. Delay only
    // delivery of an actual successful receipt to exercise the stale await.
    const { createServer: createViteServer } = await import('vite')
    const { chromium } = await import('playwright')
    await new Promise<void>(done => { ws.onclose = () => done(); ws.close() })
    await wait(300)
    const server = await createViteServer({ server: { host: '127.0.0.1', port: 0, open: false } })
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
    try {
      await server.listen()
      browser = await chromium.launch({ headless: true })
      const page = await browser.newPage()
      page.on('websocket', socket => {
        if (new URL(socket.url()).port !== String(port)) return // Vite's own HMR socket.
        socket.on('framesent', event => wire.push({ route: 'production-session', direction: 'tx', frame: JSON.parse(String(event.payload)) }))
        socket.on('framereceived', event => wire.push({ route: 'production-session', direction: 'rx', frame: JSON.parse(String(event.payload)) }))
      })
      await page.goto(server.resolvedUrls!.local[0])
      const fixture = structuredClone(machine)
      fixture.spindleLinkDefinition.link.port = 'FAKE'
      const result = await page.evaluate(async ({ fixture, port }) => {
        const sessionPath = '/src/lib/machine/machineSession.ts'
        const storePath = '/src/store/index.ts'
        const prefsPath = '/src/store/uiPrefs.ts'
        // Keep Vitest's SSR transform outside this browser-side import.
        const loadModule = new Function('path', 'return import(path)')
        const session = await loadModule(sessionPath)
        const { useCamStore } = await loadModule(storePath)
        const { useUiPrefs } = await loadModule(prefsPath)
        useCamStore.setState({ machineLibrary: [fixture], project: { ...useCamStore.getState().project, machine: fixture } })
        useUiPrefs.setState({ machineLinks: { [fixture.id]: { bridgePort: port } } })
        await session.connectMachine('bridge')
        const old = session.getMachineController()
        if (old.connectionPhase() !== 'connected') throw new Error('isolated session did not connect')
        let release!: () => void
        let received!: () => void
        const arrived = new Promise<void>(resolve => { received = resolve })
        const held = new Promise<void>(resolve => { release = resolve })
        const apply = old.applyMachineDefinition.bind(old)
        old.applyMachineDefinition = async (...args: unknown[]) => {
          const reply = await apply(...args)
          if (!reply.ok) throw new Error(JSON.stringify(reply))
          received()
          await held
          return reply
        }
        const pending = session.applyActiveMachineDefinition()
        await Promise.race([arrived, pending.then(() => { throw new Error('Apply did not reach receipt delay') })])
        await session.disconnectMachine()
        await session.connectMachine('bridge')
        const current = session.getMachineController()
        release()
        const cancelled = await pending
        const fresh = await session.applyActiveMachineDefinition()
        const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
        const until = async (predicate: () => boolean) => {
          for (let i = 0; i < 200; i++) { if (predicate()) return; await pause(50) }
          throw new Error('production session condition timed out')
        }
        await session.resetEstop()
        current.homeAxes(['Z', 'X', 'Y'])
        await until(() => current.homedThisSession() && current.machineState() === 'idle')
        const mdiSent = session.sendMdiLine('G53 G1 Z110 F60')
        if (!mdiSent) throw new Error('production MDI was refused')
        await until(() => current.machineState() === 'run')
        const waitingLoad = session.loadGcodeFile('wo3124-cancelled.nc', 'G21 G90 G53\nG0 Z120\nM30\n', null)
        current.reset()
        await until(() => current.machineState() === 'idle')
        await pause(500)
        const controlPath = '/src/store/machineControlStore.ts'
        const { useMachineControl } = await loadModule(controlPath)
        const mdiCancelled = useMachineControl.getState().consoleLines.some((row: { text: string }) =>
          row.text.includes('wo3124-cancelled.nc') && row.text.includes('canceled:'))
        const jobAfterMdi = useMachineControl.getState().job.name
        // A real pending controller probe must settle on its old session,
        // never supply a successful touch to the replacement connection.
        let probeSettled = false
        const probe = current.probe('Z', 0, 60).then((reply: unknown) => { probeSettled = true; return reply })
        await pause(100)
        const pendingProbe = !probeSettled
        await session.disconnectMachine()
        await session.connectMachine('bridge')
        const probeResult = await probe
        const afterProbe = await session.applyActiveMachineDefinition()
        await session.disconnectMachine()
        return { replaced: current !== old, cancelled, fresh, waitingLoad, mdiCancelled, jobAfterMdi, pendingProbe, probeResult, afterProbe }
      }, { fixture, port })
      expect(result.replaced).toBe(true)
      expect(result.cancelled.ok).toBe(false)
      expect(result.cancelled.authorityRefusal).toMatch(/replaced|session/)
      expect(result.fresh.ok, JSON.stringify(result.fresh)).toBe(true)
      expect(result.waitingLoad.ok).toBe(true)
      expect(result.mdiCancelled).toBe(true)
      expect(result.jobAfterMdi).not.toBe('wo3124-cancelled.nc')
      expect(result.pendingProbe).toBe(true)
      expect(result.probeResult.ok).toBe(false)
      expect(result.afterProbe.ok, JSON.stringify(result.afterProbe)).toBe(true)
      writeFileSync(join(evidence, 'session-receipts.json'), JSON.stringify(result))
    } finally {
      await browser?.close()
      await server.close()
      await wait(300)
      await connect()
    }
    await load()
    await refusesApply()
    await ok('reset')
    await acceptsApply()
  }, 150_000)
})

