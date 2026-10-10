// WO-1987: LinuxCNC as the third MachineController backend.
//
// The REAL LinuxCncController, through its REAL gateway socket
// (LinuxcncGatewayTransport, a real WebSocket), to the REAL gateway.py - which
// runs here on its FAKE `linuxcnc` module (pendant/linuxcnc-gateway/testing/),
// whose quirks were measured on the WO-1982 LinuxCNC 2.9.4 simulator. The
// gateway's own behaviour against real LinuxCNC is WO-1986's Tier 2; this file
// proves the backend drives it: connect, E-STOP reset, home, jog, continuous
// jog, work offsets, load/run, feed hold, stop, E-STOP, and the third outcome.
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { platform, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ControllerEvents, JobFault, MachineStatus, MessageChannel } from '../../lib/machine/controller'
import { LinuxcncGatewayTransport, linuxcncGatewayUrl } from '../../lib/machine/linuxcnc/gatewayTransport'
import { LINUXCNC_CALL_TIMEOUT_MS, LinuxCncController } from '../../lib/machine/linuxcnc/linuxcncController'
import { backendDefinitionFor, connectionKindsForController } from '../../lib/machine/backendRegistry'
import { controllerSurface } from '../../lib/machine/controllerSurface'

const GATEWAY_DIR = resolve(__dirname, '../../../pendant/linuxcnc-gateway')
const FAKE_DIR = join(GATEWAY_DIR, 'testing')
const PYTHON = process.env.LIENCAM_PYTHON || (platform() === 'win32' ? 'python' : 'python3')

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const running: ChildProcess[] = []
const controllers: LinuxCncController[] = []

afterEach(async () => {
  for (const c of controllers.splice(0)) await c.disconnect()
  for (const p of running.splice(0)) p.kill()
})

function startGateway(env: Record<string, string> = {}, args: string[] = []): Promise<number> {
  const programDir = mkdtempSync(join(tmpdir(), 'wo1987-'))
  const proc = spawn(PYTHON, [join(GATEWAY_DIR, 'gateway.py'), '--port', '0', '--program-dir', programDir, ...args], {
    env: { ...process.env, PYTHONPATH: FAKE_DIR, PYTHONDONTWRITEBYTECODE: '1', ...env },
    windowsHide: true,
  })
  running.push(proc)
  let err = ''
  proc.stderr!.on('data', (d) => (err += String(d)))
  return new Promise((ok, bad) => {
    let out = ''
    const timer = setTimeout(() => bad(new Error(`gateway did not start: ${err}`)), 10_000)
    proc.stdout!.on('data', (d) => {
      out += String(d)
      if (!out.includes('\n')) return
      clearTimeout(timer)
      ok(JSON.parse(out.split(/\r?\n/)[0]).listening)
    })
    proc.on('exit', (code) => bad(new Error(`gateway exited ${code}: ${err}`)))
  })
}

interface Recorded {
  statuses: MachineStatus[]
  console: string[]
  jobEvents: Array<[string, JobFault | null]>
  homed: Array<string[] | null>
  alarms: string[]
  offsets: Array<{ label: string; values: number[] }>
  closes: Array<string | null>
}

async function connectController(env: Record<string, string> = {}, args: string[] = []) {
  const port = await startGateway(env, args)
  const seen: Recorded = { statuses: [], console: [], jobEvents: [], homed: [], alarms: [], offsets: [], closes: [] }
  const events: ControllerEvents = {
    onStatus: (s) => seen.statuses.push(s),
    onConsole: (e) => seen.console.push(e.text),
    onJobEvent: (e, f) => seen.jobEvents.push([e, f]),
    onHomed: (axes) => seen.homed.push(axes),
    onAlarm: (_c, message) => seen.alarms.push(message),
    onOffset: (entry) => seen.offsets.push(entry),
    onClose: (reason) => seen.closes.push(reason),
  }
  const lcnc = new LinuxCncController(events)
  controllers.push(lcnc)
  await lcnc.connect({ kind: 'messages', transport: new LinuxcncGatewayTransport(linuxcncGatewayUrl(port)) })
  return { lcnc, seen }
}

async function until(what: string, predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await sleep(10)
  }
  throw new Error(`timed out waiting for ${what}`)
}

async function readyAndHomed(env: Record<string, string> = {}, args: string[] = []) {
  const r = await connectController(env, args)
  await until('first status', () => r.lcnc.status().state !== 'unknown')
  expect(await r.lcnc.resetToIdle()).toEqual({ ok: true, reason: null, outcome: 'accepted' })
  expect(r.lcnc.homeAxes(['Z', 'X', 'Y'])).toBe(true)
  await until('homed', () => r.lcnc.homedThisSession() && r.lcnc.machineState() === 'idle')
  return r
}

describe('WO-1987 the LinuxCNC route is its own, and UCCNC is unchanged', () => {
  it('registers LinuxCNC gateway + simulator for a LinuxCNC machine, and never the UCCNC bridge', () => {
    expect(controllerSurface({ controller: 'linuxcnc' }).connectionKinds).toEqual(['gateway', 'simulator'])
    expect(controllerSurface({ controller: 'linuxcnc' }).defaultConnectionKind).toBe('gateway')
    expect(backendDefinitionFor('linuxcnc', 'gateway')).toMatchObject({
      backend: 'linuxcnc',
      sessionController: 'declared',
      capabilities: { physicalConnection: true, simulator: false, serialPermission: false, grblSettings: false },
      preferred: true,
    })
    expect(backendDefinitionFor('linuxcnc', 'bridge')).toBeNull()
    expect(backendDefinitionFor('linuxcnc', 'serial')).toBeNull()
  })

  it('pins a UCCNC machine exactly as before: bridge then simulator, UCCNC backend, no gateway', () => {
    expect(controllerSurface({ controller: 'uccnc' }).connectionKinds).toEqual(['bridge', 'simulator'])
    expect(controllerSurface({ controller: 'uccnc' }).defaultConnectionKind).toBe('bridge')
    expect(connectionKindsForController('uccnc')).toEqual(['simulator', 'bridge'])
    expect(backendDefinitionFor('uccnc', 'bridge')).toMatchObject({
      backend: 'uccnc', sessionController: 'uccnc', preferred: true,
    })
    for (const controller of ['uccnc', 'grbl', 'grblhal', 'generic']) {
      expect(backendDefinitionFor(controller, 'gateway'), controller).toBeNull()
    }
  })

  // WO-2101 turned this pin over: LienCAM reaches a gateway on another PC.
  it('takes a gateway address on another computer (WO-2101)', () => {
    expect(() => new LinuxcncGatewayTransport('ws://192.0.2.15:8327/', () => ({}) as WebSocket)).not.toThrow()
  })
})

describe('WO-1987 LinuxCncController drives gateway.py (fake LinuxCNC, real socket)', () => {
  it('connects, reports LinuxCNC and its capabilities, and carries the joint vector', async () => {
    const { lcnc } = await connectController({ FAKE_LCNC_COORDINATES: 'XYYZ' })
    expect(lcnc.connectionPhase()).toBe('connected')
    expect(lcnc.firmwareVersion()).toMatch(/^LinuxCNC /)
    expect(lcnc.capabilities).toMatchObject({
      gcodeText: true, perAxisHoming: true, geometryQueue: false, ownsSpindle: true, spindleCommands: true,
      nonIdentityJoints: true,
    })
    await until('status', () => lcnc.status().state !== 'unknown')
    expect(lcnc.status().joints?.map((j) => j.axis)).toEqual(['X', 'Y', 'Y', 'Z'])
    // Booted in E-STOP, as LinuxCNC does: reported, not hidden.
    expect(lcnc.status().inputs?.estop).toBe(true)
    expect(lcnc.status().spindleRpm).toBeNull()
    expect(lcnc.linuxcncHello()?.coordinates).toBe('XYYZ')
  })

  it('resets E-STOP, homes every axis and reports the homed axes', async () => {
    const { lcnc, seen } = await readyAndHomed()
    expect(seen.homed.flat().sort()).toEqual(['X', 'Y', 'Z'])
    expect(lcnc.homedAxesThisSession()).toEqual({ X: true, Y: true, Z: true })
    // A revoked axis (a travel change) stays unhomed until LinuxCNC homes it again.
    lcnc.invalidateDatum(['X'])
    expect(lcnc.homedAxesThisSession().X).toBe(false)
    expect(lcnc.homedThisSession()).toBe(false)
  })

  it('jogs by a distance, jogs continuously while held, and a jogStop holds it still', async () => {
    const { lcnc } = await readyAndHomed()
    const x0 = lcnc.status().machinePos!.x
    expect(lcnc.jog('X', 2, 600)).toBe(true)
    await until('jog of 2 mm', () => Math.abs(lcnc.status().machinePos!.x - (x0 + 2)) < 1e-6 && lcnc.machineState() === 'idle')

    const started = lcnc.jogStartContinuous('X', 1, 600)
    lcnc.jogHold()
    const hold = setInterval(() => lcnc.jogHold(), 75)
    expect(await started).toBe(true)
    await until('jogging', () => lcnc.machineState() === 'jog')
    const moving = lcnc.status().machinePos!.x
    await sleep(300)
    expect(lcnc.status().machinePos!.x).toBeGreaterThan(moving)
    clearInterval(hold)
    lcnc.jogStop()
    await until('stopped', () => lcnc.machineState() === 'idle')
    const stopped = lcnc.status().machinePos!.x
    await sleep(300)
    expect(lcnc.status().machinePos!.x).toBe(stopped)
  })

  it('zeroes a work axis with a READBACK receipt, sets an offset, and selects a system', async () => {
    const { lcnc, seen } = await readyAndHomed()
    lcnc.jog('X', 3, 600)
    await until('jogged', () => lcnc.machineState() === 'idle' && lcnc.status().machinePos!.x !== 0)
    const machineX = lcnc.status().machinePos!.x
    const receipt = await lcnc.zeroWorkAxisAwait('X')
    expect(receipt).toMatchObject({ confirmed: true, wcs: 'G54', outcome: 'accepted' })
    expect(receipt!.offset!.x).toBeCloseTo(machineX, 6)
    await until('workPos X = 0', () => Math.abs(lcnc.status().workPos!.x) < 1e-6)
    expect(seen.offsets.at(-1)?.label).toBe('G54')

    const set = await lcnc.setWorkOffset('G55', { x: 10, z: -5 })
    expect(set).toMatchObject({ ok: true, reason: null, outcome: 'accepted' })
    expect(set.offset).toMatchObject({ x: 10, z: -5 })
    expect(await lcnc.selectWcsAwait('G55')).toBe(true)
    await until('G55 active', () => Math.abs(lcnc.status().workPos!.x - (machineX - 10)) < 1e-6)
  })

  it('loads a program, runs it, and reports started then completed', async () => {
    const { lcnc, seen } = await readyAndHomed()
    const loaded = lcnc.loadJob('G21 G90\nG0 X1\nG1 X2 F100\n')
    expect(loaded.ok).toBe(true)
    expect(loaded.ok && loaded.result.lines.map((l) => l.sourceLine)).toEqual([1, 2, 3])
    expect(await lcnc.stagedLoadVerdict()).toEqual({ ok: true, reason: null })
    expect(lcnc.startJob()).toBe(true)
    await until('completed', () => seen.jobEvents.some(([e]) => e === 'completed'))
    expect(seen.jobEvents.map(([e]) => e)).toEqual(['started', 'completed'])
    expect(lcnc.hasActiveJob()).toBe(false)
    expect(lcnc.jobProgress()).toMatchObject({ phase: 'complete', totalLines: 3, ackedLines: 3 })
    // The console says LinuxCNC's gateway ended the text with M2 - it did not refuse.
    expect(seen.console.join('\n')).toMatch(/ended it with M2/)
  })

  it('feed-holds and pauses a running program, resumes it and stops it - stopped, never completed', async () => {
    const { lcnc, seen } = await readyAndHomed({}, ['--call-timeout', '1.5'])
    lcnc.loadJob(Array.from({ length: 200 }, (_, i) => `G1 X${i % 10} F500`).join('\n') + '\nM2\n')
    expect(lcnc.startJob()).toBe(true)
    await until('run', () => lcnc.machineState() === 'run')
    lcnc.feedHold()
    await until('held', () => lcnc.machineState() === 'hold')
    const line = lcnc.linuxcncLines()!.currentLine
    await sleep(200)
    expect(lcnc.linuxcncLines()!.currentLine).toBe(line)
    expect(lcnc.resumeJob()).toBe(true)
    await until('run again', () => lcnc.machineState() === 'run')
    lcnc.pauseJob()
    await until('paused', () => lcnc.machineState() === 'hold' && seen.jobEvents.some(([e]) => e === 'paused'))
    expect(lcnc.cycleResume()).toBe(true)
    await until('run a third time', () => lcnc.machineState() === 'run')
    lcnc.stopJob()
    await until('stopped event', () => seen.jobEvents.some(([e]) => e === 'stopped'))
    await sleep(200)
    // The gateway raises `paused` for pauseJob (BRIDGE-PROTOCOL.md), not for a feed hold.
    expect(seen.jobEvents.map(([e]) => e)).toEqual(['started', 'resumed', 'paused', 'resumed', 'stopped'])
    expect(lcnc.stoppedJobProgress()?.totalLines).toBe(201)
  })

  it('an E-STOP during a program stops it and raises the alarm', async () => {
    const { lcnc, seen } = await readyAndHomed()
    lcnc.loadJob(Array.from({ length: 200 }, () => 'G4 P0').join('\n'))
    lcnc.startJob()
    await until('run', () => lcnc.machineState() === 'run')
    lcnc.emergencyStop()
    await until('alarm state', () => lcnc.machineState() === 'alarm' && lcnc.status().inputs?.estop === true, 2000)
    await until('stopped', () => seen.jobEvents.some(([e]) => e === 'stopped'), 2000)
    expect(seen.jobEvents.map(([e]) => e)).toEqual(['started', 'stopped'])
    expect(seen.alarms).toContain('LinuxCNC is in E-STOP.')
  })

  it('never starts a program LinuxCNC refused to load (it would run the previous file)', async () => {
    const { lcnc, seen } = await readyAndHomed()
    lcnc.loadJob(Array.from({ length: 200 }, () => 'G4 P0').join('\n'))
    lcnc.startJob()
    await until('run', () => lcnc.machineState() === 'run')
    // LinuxCNC refuses a load while its interpreter runs.
    lcnc.loadJob('G0 X5\n')
    expect(await lcnc.stagedLoadVerdict()).toMatchObject({ ok: false, reason: expect.stringMatching(/running/) })
    lcnc.stopJob()
    await until('stopped', () => lcnc.machineState() === 'idle' && seen.jobEvents.some(([e]) => e === 'stopped'))
    const before = seen.jobEvents.length
    expect(lcnc.startJob()).toBe(false)
    await sleep(300)
    expect(seen.jobEvents.slice(before)).toEqual([])
    expect(lcnc.machineState()).toBe('idle')
    expect(seen.console.join('\n')).toMatch(/refused the program load, so nothing was started/)
  })

  it('a call LinuxCNC has not answered is UNKNOWN - and an E-STOP still goes through', async () => {
    const { lcnc } = await readyAndHomed({ FAKE_LCNC_HANG: 'mdi' }, ['--call-timeout', '1'])
    const ack = lcnc.sendCommandAwait('G0 X1')!
    await sleep(100)
    lcnc.emergencyStop()
    await until('E-STOP while the MDI hangs', () => lcnc.status().inputs?.estop === true, 2000)
    const answer = await ack
    expect(answer).toMatchObject({ ok: false, outcome: 'unknown' })
    expect(answer.message).toMatch(/may still be doing it/)
  })

  it('a refusal carries LinuxCNC\'s own sentence', async () => {
    const { lcnc } = await readyAndHomed()
    const ack = await lcnc.sendCommandAwait('G99999')
    expect(ack).toMatchObject({ ok: false, outcome: 'refused' })
    expect(ack!.message).toMatch(/G-code out of range/)
  })

  it('says a refusal once - LinuxCNC\'s own sentence - not twice', async () => {
    const { lcnc, seen } = await readyAndHomed()
    const before = seen.console.length
    expect(lcnc.sendCommand('G99999')).toBe(true)
    await sleep(600)
    const said = seen.console.slice(before).filter((line) => line.includes('G-code out of range'))
    expect(said).toEqual(['G-code out of range'])
  })

  it('the Control page\'s units word on connect waits out E-STOP, then reaches LinuxCNC', async () => {
    const port = await startGateway()
    const sent: string[] = []
    const transport = new LinuxcncGatewayTransport(linuxcncGatewayUrl(port))
    const send = transport.send.bind(transport)
    transport.send = (message: unknown) => {
      const call = message as { m: string; a: { text?: string } }
      if (call.m === 'sendCommand') sent.push(call.a.text ?? '')
      send(message)
    }
    const console: string[] = []
    const lcnc = new LinuxCncController({ onConsole: (e) => console.push(e.text) })
    controllers.push(lcnc)
    await lcnc.connect({ kind: 'messages', transport })
    await until('E-STOP reported', () => lcnc.machineState() === 'alarm')
    // LinuxCNC boots in E-STOP and runs no MDI there: the word is held, not refused.
    expect(lcnc.sendCommand('G21')).toBe(true)
    await sleep(300)
    expect(sent).toEqual([])
    expect(console.join('\n')).not.toMatch(/MDI/)
    expect(await lcnc.resetToIdle()).toMatchObject({ ok: true })
    await until('G21 sent after the reset', () => sent.length === 1)
    expect(sent).toEqual(['G21'])
    await sleep(300)
    expect(console.join('\n')).not.toMatch(/refused/i)
  })

  it('disconnects cleanly, and a dropped gateway is reported as a close', async () => {
    const { lcnc, seen } = await connectController()
    await lcnc.disconnect()
    expect(lcnc.connectionPhase()).toBe('disconnected')
    expect(seen.closes).toEqual([])

    const second = await connectController()
    await until('status', () => second.lcnc.status().state !== 'unknown')
    for (const p of running) p.kill()
    await until('closed', () => second.lcnc.connectionPhase() === 'disconnected')
    expect(second.seen.closes.length).toBe(1)
    // Nothing moves on a dead link.
    expect(second.lcnc.jog('X', 1, 100)).toBe(false)
  })
})

// A scripted gateway, in-process: what the backend SENDS, when nothing answers.
class SilentGateway implements MessageChannel {
  sent: Array<{ m: string; a: Record<string, unknown>; state: string }> = []
  private readonly greet: boolean
  private onMessage: ((m: unknown) => void) | null = null
  private state = 'idle'
  constructor(greet: boolean) {
    this.greet = greet
  }
  /** Report a machine state, as the gateway's status frame does. */
  status(state: string): void {
    this.state = state
    this.onMessage?.({ t: 'status', v: { state, homed: { X: true, Y: true, Z: true } } })
  }
  mdi(): string[] {
    return this.sent.filter((c) => c.m === 'sendCommand').map((c) => String(c.a.text))
  }
  /** The state LinuxCNC was in when each MDI line reached it. */
  mdiStates(): string[] {
    return this.sent.filter((c) => c.m === 'sendCommand').map((c) => `${String(c.a.text)}@${c.state}`)
  }
  async start(events: { onMessage: (m: unknown) => void; onClose: (r: string | null) => void }): Promise<void> {
    this.onMessage = events.onMessage
    if (!this.greet) return
    events.onMessage({ t: 'hello', v: { protocol: 1, bridge: 'silent', controller: 'linuxcnc', linuxcncVersion: '2.9.4', coordinates: 'XYZ', capabilities: { gcodeText: true }, readOnly: false } })
    events.onMessage({ t: 'status', v: { state: 'idle', homed: { X: true, Y: true, Z: true } } })
  }
  send(message: unknown): void {
    const call = message as { m: string; a: Record<string, unknown> }
    this.sent.push({ m: call.m, a: call.a, state: this.state })
  }
  async close(): Promise<void> {}
}

describe('WO-1987 LinuxCncController when LinuxCNC does not answer', () => {
  afterEach(() => vi.useRealTimers())

  it('an unanswered load is not a refusal, and nothing is started on it', async () => {
    const gateway = new SilentGateway(true)
    const console: string[] = []
    const lcnc = new LinuxCncController({ onConsole: (e) => console.push(e.text) })
    controllers.push(lcnc)
    await lcnc.connect({ kind: 'messages', transport: gateway })
    vi.useFakeTimers()
    expect(lcnc.loadJob('G0 X1\n').ok).toBe(true)
    const verdict = lcnc.stagedLoadVerdict()!
    await vi.advanceTimersByTimeAsync(LINUXCNC_CALL_TIMEOUT_MS + 10)
    // machineSession takes an arm back only on an explicit refusal.
    expect(await verdict).toEqual({ ok: true, reason: null })
    expect(lcnc.startJob()).toBe(false)
    expect(gateway.sent.map((c) => c.m)).not.toContain('startJob')
    expect(console.join('\n')).toMatch(/No answer came back for the program load/)
  })

  it('a units word typed while an MDI move runs reaches LinuxCNC in the order it was typed', async () => {
    const gateway = new SilentGateway(true)
    const lcnc = new LinuxCncController({})
    controllers.push(lcnc)
    await lcnc.connect({ kind: 'messages', transport: gateway })
    gateway.status('run')
    expect(lcnc.sendCommand('G90')).toBe(true)
    expect(lcnc.sendCommand('G20')).toBe(true)
    expect(lcnc.sendCommand('G0 X1')).toBe(true)
    gateway.status('idle')
    expect(gateway.mdi()).toEqual(['G90', 'G20', 'G0 X1'])
  })

  it('a units word held through E-STOP is never sent into E-STOP, even when another line goes first', async () => {
    // Review round 2: a Flood press in E-STOP used to flush the held G21 into
    // E-STOP, where LinuxCNC refuses all MDI - and the word was lost.
    const gateway = new SilentGateway(true)
    const lcnc = new LinuxCncController({})
    controllers.push(lcnc)
    await lcnc.connect({ kind: 'messages', transport: gateway })
    gateway.status('alarm')
    expect(lcnc.sendCommand('G21')).toBe(true)
    expect(gateway.mdi()).toEqual([])
    expect(lcnc.sendCommand('M8')).toBe(true)
    expect(gateway.mdiStates()).toEqual(['M8@alarm'])
    gateway.status('idle')
    expect(lcnc.sendCommand('G0 X10')).toBe(true)
    expect(gateway.mdiStates()).toEqual(['M8@alarm', 'G21@idle', 'G0 X10@idle'])
  })

  it('a held units word goes before the next line once LinuxCNC can take MDI, typed or WCS', async () => {
    const gateway = new SilentGateway(true)
    const lcnc = new LinuxCncController({})
    controllers.push(lcnc)
    await lcnc.connect({ kind: 'messages', transport: gateway })
    gateway.status('alarm')
    expect(lcnc.sendCommand('G20')).toBe(true)
    // Reset then straight into homing: no idle frame in between.
    gateway.status('home')
    expect(lcnc.sendCommandAwait('G55 G0 X1')).not.toBeNull()
    expect(gateway.sent.map((c) => `${c.m}:${String(c.a.text)}@${c.state}`)).toEqual([
      'sendCommand:G20@home',
      'sendCommandAwait:G55 G0 X1@home',
    ])
  })

  it('an E-STOP is sent at once even before the gateway has said hello', async () => {
    const gateway = new SilentGateway(false)
    const lcnc = new LinuxCncController({})
    controllers.push(lcnc)
    const connecting = lcnc.connect({ kind: 'messages', transport: gateway }).catch(() => undefined)
    await Promise.resolve()
    expect(lcnc.connectionPhase()).toBe('connecting')
    lcnc.emergencyStop()
    expect(gateway.sent.map((c) => c.m)).toEqual(['emergencyStop'])
    // Motion is not sent on a link that is not connected.
    expect(lcnc.jog('X', 1, 100)).toBe(false)
    expect(gateway.sent.map((c) => c.m)).toEqual(['emergencyStop'])
    await lcnc.disconnect()
    await connecting
  })
})
