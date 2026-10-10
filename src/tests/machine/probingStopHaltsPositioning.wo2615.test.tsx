// Production probing doors, real GRBL/simulator controllers. The scripted
// byte pipe is protocol evidence, never GRBL hardware evidence.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeBytePipe } from '../helpers/fakeBytePipe'
import type { TransportEvents } from '../../lib/machine/types'
import { typedMock } from '../support/typedMock'

let pipe: ProbePipe
class ProbePipe extends FakeBytePipe {
  z = -5
  moving = false
  hold = false
  suppressAcks = false
  async start(events: TransportEvents) {
    await super.start(events)
    queueMicrotask(() => this.feed("Grbl 1.1h ['$' for help]\r\n"))
  }
  report() { this.feed(`<${this.hold ? 'Hold:0' : this.moving ? 'Run' : 'Idle'}|MPos:50,50,${this.z}|WCO:0,0,0|FS:0,0>\r\n`) }
  async write(data: Uint8Array) {
    await super.write(data)
    const text = new TextDecoder().decode(data).trim()
    if (data.length === 1) {
      if (data[0] === 0x21) { this.moving = false; this.hold = true }
      if (data[0] === 0x18) { this.moving = false; this.hold = false; this.feed("Grbl 1.1h ['$' for help]\r\n") }
      if (data[0] === 0x3f) this.report()
      if (data[0] === 0x7e) { this.hold = false; this.moving = true; this.report() }
      return
    }
    if (/G38\.|\bG[01]\b/.test(text) && /[XYZ]/.test(text)) {
      this.moving = true; this.report()
      if (!/G38/.test(text)) this.feed('ok\r\n')
      return
    }
    if (this.suppressAcks) return
    if (text === '$$') this.feed('$13=0\r\n$100=200\r\n$101=200\r\n$102=200\r\n')
    if (text === '$G') this.feed('[GC:G0 G54 G17 G21 G90 G94 M5 M9 T0 F0 S0]\r\n')
    if (text === '$#') this.feed('[G54:0,0,0]\r\n[PRB:0,0,0:0]\r\n')
    this.feed('ok\r\n')
  }
}
vi.mock('../../lib/machine/webSerialTransport', async (original) => {
  const actual = await original<typeof import('../../lib/machine/webSerialTransport')>()
  return typedMock<typeof import('../../lib/machine/webSerialTransport')>({
    ...actual,
    WebSerialTransport: class extends actual.WebSerialTransport {
      async start(events: TransportEvents) { pipe = new ProbePipe(); await pipe.start(events) }
      async write(data: Uint8Array) { await pipe.write(data) }
      async close() { await pipe.close() }
      static isSupported() { return true }
      static async requestPort() { return {} as SerialPort }
      static async grantedPorts() { return [] as SerialPort[] }
    },
  })
})
// A scripted LinuxCNC socket, exercising the real session/controller route.
// Protocol evidence only: this is not an independent LinuxCNC readback.
const linux = vi.hoisted(() => ({
  moving: false, calls: [] as Array<{ m: string; a: Record<string, unknown> }>,
}))
vi.mock('../../lib/machine/linuxcnc/gatewayTransport', async original => {
  const actual = await original<typeof import('../../lib/machine/linuxcnc/gatewayTransport')>()
  return typedMock<typeof import('../../lib/machine/linuxcnc/gatewayTransport')>({ ...actual,
    LinuxcncGatewayTransport: class extends actual.LinuxcncGatewayTransport {
      private events: { onMessage: (m: unknown) => void; onClose: (r: string | null) => void } | null = null
      private report() {
        this.events?.onMessage({ t: 'status', v: { state: linux.moving ? 'run' : 'idle',
          machinePos: { x: 50, y: 50, z: -5 }, workPos: { x: 50, y: 50, z: -5 },
          inputs: { estop: false, probe: false }, homed: { X: true, Y: true, Z: true } } })
      }
      async start(events: { onMessage: (m: unknown) => void; onClose: (r: string | null) => void }) {
        this.events = events; linux.moving = false; linux.calls = []
        this.report()
        events.onMessage({ t: 'hello', v: { protocol: 1, bridge: 'WO-2615 scripted LinuxCNC',
          controller: 'linuxcnc', linuxcncVersion: '2.9.4', coordinates: 'XYZ', capabilities: { gcodeText: true } } })
      }
      send(message: unknown) {
        const call = message as { seq: number; m: string; a: Record<string, unknown> }
        linux.calls.push(call)
        if (call.m === 'sendCommandAwait' && /\bG[01]\b/.test(String(call.a.text)) && /[XYZ]/.test(String(call.a.text))) linux.moving = true
        if (call.m === 'reset') linux.moving = false
        this.report()
        const value = ['sendCommandAwait', 'loadJob', 'loadJobFrom'].includes(call.m) ? { ok: true, message: null } : true
        queueMicrotask(() => this.events?.onMessage({ t: 'reply', seq: call.seq, ok: true, outcome: 'accepted', v: value }))
      }
      async close() { this.events?.onClose('closed'); this.events = null }
    },
  })
})
const memory = new Map<string, string>()
vi.stubGlobal('localStorage', {
  get length() { return memory.size }, clear: () => memory.clear(),
  getItem: (k: string) => memory.get(k) ?? null, key: (i: number) => [...memory.keys()][i] ?? null,
  removeItem: (k: string) => { memory.delete(k) }, setItem: (k: string, v: string) => { memory.set(k, v) },
} satisfies Storage)
const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const session = await import('../../lib/machine/machineSession')
const { planFeatureProbeCycle } = await import('../../lib/machine/probeFeatureCycle')
const { deriveMachineEnvelopeFromConvention } = await import('../../lib/machine/machineEnvelope')
const { resolveProbeConfig } = await import('../../lib/machine/toolTable')
const CONFIG = { fastFeed: 60, slowFeed: 30, retract: 2, maxTravel: 50, padThickness: 0 }
const PROGRAM = 'G21 G90 G54\nG0 X5 Y5 Z-5\nG1 X10 F600\nM0\nG1 X15\nM30\n'
const seekLines = () => pipe.writtenItems().filter(l => /G38\./.test(l))

async function until(what: string, predicate: () => boolean, ms = 6000) {
  for (let t = 0; t < ms && !predicate(); t += 50) await vi.advanceTimersByTimeAsync(50)
  expect(predicate(), what + '; console=' + JSON.stringify(useMachineControl.getState().consoleLines.slice(-5))).toBe(true)
}
async function finish<T>(p: Promise<T>, ms = 2000): Promise<T> {
  let result: T | undefined
  let done = false
  void p.then(v => { result = v; done = true })
  await until('the routine settles', () => done, ms)
  return result!
}
async function connect(kind: 'serial' | 'simulator' | 'gateway') {
  useCamStore.getState().newProject()
  const machine = useCamStore.getState().project.machine
  useCamStore.getState().setProjectMachine({ ...machine, id: 'wo2615-probe', controller: kind === 'gateway' ? 'linuxcnc' : 'grbl',
    controllerDefinition: undefined, unsentSettings: undefined,
    travel: { x: 100, y: 100, z: 100 }, rapidRate: 60,
    homeConvention: { x: { homesToward: 'min', machineZeroAt: 'min' }, y: { homesToward: 'min', machineZeroAt: 'min' }, z: { homesToward: 'max', machineZeroAt: 'max' } },
  })
  const pending = session.connectMachine(kind)
  await vi.advanceTimersByTimeAsync(1000)
  await pending
  session.__resetEstopInterlockForTest()
  await vi.advanceTimersByTimeAsync(1000)
  if (kind === 'simulator') {
    const ctrl = session.getMachineController()
    ctrl.home()
    await vi.advanceTimersByTimeAsync(3000)
    ctrl.jogToWorkXY(50, 50, 6000)
    await vi.advanceTimersByTimeAsync(1000)
    ctrl.jogToMachineZ(-5, 6000)
    await vi.advanceTimersByTimeAsync(1000)
  }
  if (kind === 'serial') session.getMachineController().home()
  session.loadMachineProgram('preserve-wo2609.nc', PROGRAM)
  await vi.advanceTimersByTimeAsync(100)
  const ctrl = session.getMachineController()
  expect(ctrl.jobProgress().totalLines).toBeGreaterThan(0)
  expect(useMachineControl.getState().job.name).toBe('preserve-wo2609.nc')
  return ctrl
}
beforeEach(() => { vi.useFakeTimers(); memory.clear() })
afterEach(async () => {
  session.stopProbing()
  await vi.advanceTimersByTimeAsync(2000)
  if (session.getMachineController().connectionPhase() !== 'disconnected') {
    const pending = session.disconnectMachine()
    await vi.advanceTimersByTimeAsync(100)
    await pending
  }
  vi.useRealTimers(); vi.restoreAllMocks()
})


// The serial pipe below is protocol evidence, not board readback.
describe('WO-2615 Stop owns every probing motion phase', () => {
  it('a completed text touch accepts reported Idle without verifiedIdle and releases its lock', async () => {
    const ctrl = await connect('simulator')
    vi.spyOn(ctrl, 'verifiedIdle').mockReturnValue(false)
    vi.spyOn(ctrl, 'sendCommandAwait').mockImplementation(async line => {
      if (/G38\.2/.test(line)) {
        useMachineControl.setState({ probe: { values: [55, 50, -5], success: true } })
      }
      return { ok: true, message: 'ok' }
    })
    expect(ctrl.machineState()).toBe('idle')
    expect(ctrl.verifiedIdle()).toBe(false)
    for (let touch = 0; touch < 2; touch++) {
      const pending = session.runDirectionalProbeTouch('X', '+', CONFIG)
      expect(session.isProbeCycleActive()).toBe(true)
      expect(await finish(pending, 200)).toMatchObject({ ok: true, probedMachinePosition: 55 })
      expect(session.isProbeCycleActive()).toBe(false)
    }
  })

  it.each([false, true])('simulator native=%s: Stop halts ordinary positioning and preserves the staged file', async native => {
    const ctrl = await connect('simulator')
    if (native) ctrl.capabilities.gcodeText = false
    const config = resolveProbeConfig(null, { ...CONFIG, positioningFeed: 60 })
    const planned = planFeatureProbeCycle({ kind: 'bore', start: ctrl.status().machinePos!,
      envelope: deriveMachineEnvelopeFromConvention({ x: { homesToward: 'min', machineZeroAt: 'min' },
        y: { homesToward: 'min', machineZeroAt: 'min' }, z: { homesToward: 'max', machineZeroAt: 'max' } },
      { x: 100, y: 100, z: 100 }), config, tipRadiusMm: 1.5, nominalSizeXmm: 25,
      nominalSizeYmm: 25, rimTopMachineZMm: -5, depthBelowTopMm: 5 })
    expect(planned.ok, !planned.ok ? planned.reason : '').toBe(true)
    if (!planned.ok) throw new Error(planned.reason)
    const send = vi.spyOn(ctrl, 'sendCommandAwait')
    const probe = vi.spyOn(ctrl, 'probe')
    const progress = ctrl.jobProgress()
    const job = { ...useMachineControl.getState().job }
    const pending = session.runFeatureProbeCycle(planned.plan, config, true)
    await until('initial positioning moves', () => ['jog', 'run'].includes(ctrl.machineState()))
    await vi.advanceTimersByTimeAsync(100)
    const at = ctrl.status().machinePos
    const commands = send.mock.calls.length
    const probes = probe.mock.calls.length
    session.stopProbing()
    expect(await finish(pending)).toMatchObject({ ok: false, stopped: true })
    await vi.advanceTimersByTimeAsync(30000)
    expect(ctrl.status().machinePos).toEqual(at)
    expect(ctrl.machineState()).toBe('idle')
    expect(send.mock.calls.slice(commands).filter(c => /G38|G0|G1\b/.test(c[0]))).toEqual([])
    expect(probe.mock.calls).toHaveLength(probes)
    expect(ctrl.jobProgress()).toEqual(progress)
    expect(useMachineControl.getState().job).toEqual(job)
    ctrl.capabilities.gcodeText = true
    expect(ctrl.startJob()).toBe(true)
  })

  it.each([false, true])('simulator native=%s: Stop between fast and fine seeks halts the retract, with no re-touch', async native => {
    const ctrl = await connect('simulator')
    if (native) ctrl.capabilities.gcodeText = false
    const send = vi.spyOn(ctrl, 'sendCommandAwait')
    const probe = vi.spyOn(ctrl, 'probe')
    const jog = vi.spyOn(ctrl, 'jogToMachineZ')
    const progress = ctrl.jobProgress()
    const pending = session.runDirectionalProbeTouch('Z', '-', { ...CONFIG, fastFeed: 600, positioningFeed: 60 })
    await until('back-off sent', () => native ? jog.mock.calls.length > 0 : send.mock.calls.some(c => /G91 G0/.test(c[0])), 15000)
    await vi.advanceTimersByTimeAsync(50)
    const at = ctrl.status().machinePos
    const commands = send.mock.calls.length
    const probes = probe.mock.calls.length
    session.stopProbing()
    expect(await finish(pending)).toMatchObject({ ok: false, stopped: true })
    await vi.advanceTimersByTimeAsync(30000)
    expect(ctrl.status().machinePos).toEqual(at)
    expect(send.mock.calls.slice(commands).filter(c => /G38|G0|G1\b/.test(c[0]))).toEqual([])
    expect(probe.mock.calls).toHaveLength(probes)
    expect(ctrl.jobProgress()).toEqual(progress)
    expect(session.estopNeedsReset()).toBe(false)
  })

  it.each([false, true].flatMap(native => (native ? ['fine pass', 'final retract'] : ['fine pass', 'final retract', 'final park']).map(phase => ({ native, phase }))))(
    'simulator native=$native: Stop halts $phase while the routine still owns motion', async ({ native, phase }) => {
    const ctrl = await connect('simulator')
    if (native) ctrl.capabilities.gcodeText = false
    const send = vi.spyOn(ctrl, 'sendCommandAwait')
    const probe = vi.spyOn(ctrl, 'probe')
    const jog = vi.spyOn(ctrl, 'jogToMachineZ')
    const progress = ctrl.jobProgress()
    const config = { ...CONFIG, fastFeed: 600, slowFeed: 60, positioningFeed: 60, surfaceClearance: 10 }
    // Native simulator has no work-offset writer; its directional entry runs
    // the same final retract without a synthetic work-Z0 fixture.
    const pending: Promise<{ ok: boolean; message: string; stopped?: true }> = native ? session.runDirectionalProbeTouch('Z', '-', config) : session.runZProbeCycle('workZero', config)
    await until(phase + ' starts', () => {
      if (phase === 'fine pass') return native ? probe.mock.calls.length === 2 : send.mock.calls.filter(c => /G38.2/.test(c[0])).length === 2
      if (native) return jog.mock.calls.length >= (phase === 'final retract' ? 2 : 3)
      return phase === 'final retract' ? send.mock.calls.filter(c => /G91 G0/.test(c[0])).length === 2
        : send.mock.calls.some(c => /G53 G0 Z/.test(c[0]))
    }, 20000)
    expect(session.isProbeCycleActive(), 'Stop remains live until the final motion settles').toBe(true)
    const at = ctrl.status().machinePos
    const commands = send.mock.calls.length
    const probes = probe.mock.calls.length
    session.stopProbing()
    expect(await finish(pending)).toMatchObject({ ok: false, stopped: true })
    await vi.advanceTimersByTimeAsync(30000)
    expect(ctrl.status().machinePos).toEqual(at)
    expect(send.mock.calls.slice(commands).filter(c => /G38|G0|G1\b/.test(c[0]))).toEqual([])
    expect(probe.mock.calls).toHaveLength(probes)
    expect(ctrl.jobProgress()).toEqual(progress)
  })

  it('LinuxCNC: Stop during text positioning sends abort rather than a jog stop and retains the file', async () => {
    const ctrl = await connect('gateway')
    const config = resolveProbeConfig(null, { ...CONFIG, positioningFeed: 60 })
    const planned = planFeatureProbeCycle({ kind: 'bore', start: ctrl.status().machinePos!,
      envelope: deriveMachineEnvelopeFromConvention({ x: { homesToward: 'min', machineZeroAt: 'min' },
        y: { homesToward: 'min', machineZeroAt: 'min' }, z: { homesToward: 'max', machineZeroAt: 'max' } },
      { x: 100, y: 100, z: 100 }), config, tipRadiusMm: 1.5, nominalSizeXmm: 25,
      nominalSizeYmm: 25, rimTopMachineZMm: -5, depthBelowTopMm: 5 })
    expect(planned.ok, !planned.ok ? planned.reason : '').toBe(true)
    if (!planned.ok) throw new Error(planned.reason)
    const progress = ctrl.jobProgress()
    const job = { ...useMachineControl.getState().job }
    const pending = session.runFeatureProbeCycle(planned.plan, config, true)
    await until('LinuxCNC positioning in flight', () => linux.moving)
    const sent = linux.calls.length
    session.stopProbing()
    expect(await finish(pending)).toMatchObject({ ok: false, stopped: true })
    await vi.advanceTimersByTimeAsync(30000)
    expect(linux.moving).toBe(false)
    expect(linux.calls.slice(sent).map(c => c.m)).toContain('reset')
    expect(linux.calls.slice(sent).filter(c => /G38|G0|G1\b/.test(String(c.a.text)))).toEqual([])
    expect(ctrl.jobProgress()).toEqual(progress)
    expect(useMachineControl.getState().job).toEqual(job)
    expect(ctrl.startJob()).toBe(true)
  })

  it.each([false, true])('GRBL: positioning Stop uses controlled reset and keeps the file (cancel failure=%s)', async failed => {
    const ctrl = await connect('serial')
    const reason = 'Positioning cancel did not verify Idle.'
    if (failed) {
      const reset = ctrl.resetToIdle.bind(ctrl)
      vi.spyOn(ctrl, 'resetToIdle').mockImplementation(async () => {
        await reset()
        return { ok: false, reason }
      })
    }
    const config = resolveProbeConfig(null, { ...CONFIG, positioningFeed: 60 })
    const planned = planFeatureProbeCycle({ kind: 'bore', start: ctrl.status().machinePos!,
      envelope: deriveMachineEnvelopeFromConvention({ x: { homesToward: 'min', machineZeroAt: 'min' },
        y: { homesToward: 'min', machineZeroAt: 'min' }, z: { homesToward: 'max', machineZeroAt: 'max' } },
      { x: 100, y: 100, z: 100 }), config, tipRadiusMm: 1.5, nominalSizeXmm: 25,
      nominalSizeYmm: 25, rimTopMachineZMm: -5, depthBelowTopMm: 5 })
    expect(planned.ok, !planned.ok ? planned.reason : '').toBe(true)
    if (!planned.ok) throw new Error(planned.reason)
    const progress = ctrl.jobProgress()
    const job = { ...useMachineControl.getState().job }
    const pending = session.runFeatureProbeCycle(planned.plan, config, true)
    await until('positioning starts before a seek', () => pipe.moving)
    expect(seekLines()).toHaveLength(0)
    const sent = pipe.writtenItems().length
    session.stopProbing()
    const result = await finish(pending)
    expect(result).toMatchObject({ ok: false, stopped: true })
    if (failed) expect(result.message).toBe(reason)
    await vi.advanceTimersByTimeAsync(2000)
    expect(pipe.moving).toBe(false)
    expect(pipe.writtenItems().slice(sent).filter(l => /G38|G0|G1\b/.test(l))).toEqual([])
    expect(pipe.writtenItems().slice(sent)).toContain('[0x18]')
    expect(useMachineControl.getState().consoleLines.some(l => /during the reset settle/.test(l.text))).toBe(false)
    expect(ctrl.jobProgress()).toEqual(progress)
    expect(useMachineControl.getState().job).toEqual(job)
    pipe.suppressAcks = true
    expect(ctrl.startJob()).toBe(true)
  })
})
