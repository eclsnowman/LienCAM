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
  report() { this.feed(`<${this.hold ? 'Hold:0' : this.moving ? 'Run' : 'Idle'}|MPos:0,0,${this.z}|WCO:0,0,0|FS:0,0>\r\n`) }
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
    if (/G38\./.test(text)) { this.moving = true; this.report(); return }
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
const memory = new Map<string, string>()
vi.stubGlobal('localStorage', {
  get length() { return memory.size }, clear: () => memory.clear(),
  getItem: (k: string) => memory.get(k) ?? null, key: (i: number) => [...memory.keys()][i] ?? null,
  removeItem: (k: string) => { memory.delete(k) }, setItem: (k: string, v: string) => { memory.set(k, v) },
} satisfies Storage)
const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const session = await import('../../lib/machine/machineSession')
const { currentOperatorTransport, executeOperatorCycleStart } = await import('../../lib/machine/operatorTransport')
const { SimulatedController } = await import('../../lib/machine/simulatedController')
const { GrblController } = await import('../../lib/machine/grbl/controller')
const { planFeatureProbeCycle } = await import('../../lib/machine/probeFeatureCycle')
const { deriveMachineEnvelopeFromConvention } = await import('../../lib/machine/machineEnvelope')
const { resolveProbeConfig } = await import('../../lib/machine/toolTable')
const CONFIG = { fastFeed: 60, slowFeed: 30, retract: 2, maxTravel: 50, padThickness: 0 }
const PROGRAM = 'G21 G90 G54\nG0 X5 Y5 Z-5\nG1 X10 F600\nM0\nG1 X15\nM30\n'
const seekLines = () => pipe.writtenItems().filter(l => /G38\./.test(l))

async function until(what: string, predicate: () => boolean, ms = 6000) {
  for (let t = 0; t < ms && !predicate(); t += 50) await vi.advanceTimersByTimeAsync(50)
  expect(predicate(), what).toBe(true)
}
async function finish<T>(p: Promise<T>, ms = 2000): Promise<T> {
  let result: T | undefined
  let done = false
  void p.then(v => { result = v; done = true })
  await until('the routine settles', () => done, ms)
  return result!
}
async function connect(kind: 'serial' | 'simulator') {
  useCamStore.getState().newProject()
  const machine = useCamStore.getState().project.machine
  useCamStore.getState().setProjectMachine({ ...machine, id: 'wo2609-probe', controller: 'grbl',
    controllerDefinition: undefined, unsentSettings: undefined,
    travel: { x: 100, y: 100, z: 100 }, rapidRate: 60000,
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
    ctrl.jogToMachineZ(-5, 6000)
    await vi.advanceTimersByTimeAsync(1000)
    // WO-3189 seeds the setup's stock box at every simulator connect; these
    // touches run over the machine's flat pad, so the fixture says no part is
    // placed (a placed part replaces the pad by design, WO-416).
    session.setSimulatedPart(null)
  }
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

describe('WO-2609 probe cancellation preserves the armed program', () => {
  it.each(['Pause', 'Stop'] as const)('GRBL: failed %s cancellation keeps its reason visible and never replays', async action => {
    const ctrl = await connect('serial')
    const progress = ctrl.jobProgress()
    const job = { ...useMachineControl.getState().job }
    const reason = 'It did not answer the reset with its startup banner.'
    const resetToIdle = ctrl.resetToIdle.bind(ctrl)
    vi.spyOn(ctrl, 'resetToIdle').mockImplementation(async () => {
      await resetToIdle()
      return { ok: false, reason }
    })
    const pending = session.runDirectionalProbeTouch('Z', '-', CONFIG)
    await until('first seek sent', () => seekLines().length === 1)
    if (action === 'Pause') session.pauseProbing()
    else session.stopProbing()
    await vi.advanceTimersByTimeAsync(1600)
    session.resumeProbing()
    await vi.advanceTimersByTimeAsync(500)
    expect(seekLines(), 'an unverified cancel must never replay').toHaveLength(1)
    expect(await finish(pending)).toMatchObject({ ok: false, message: reason })
    expect(useMachineControl.getState().consoleLines).toContainEqual(expect.objectContaining({ text: reason, severity: 'error' }))
    await vi.advanceTimersByTimeAsync(1000)
    expect(seekLines()).toHaveLength(1)
    expect(session.isProbeCyclePaused()).toBe(false)
    expect(ctrl.jobProgress()).toEqual(progress)
    expect(useMachineControl.getState().job).toEqual(job)
    pipe.suppressAcks = true
    expect(ctrl.startJob(), 'failed probing cancellation did not replace or abandon the loaded streamer').toBe(true)
  })

  it.each([false, true])('simulator text/native=%s: operator Reset during a probe still clears the program and spindle and notifies listeners', async native => {
    const ctrl = await connect('simulator') as InstanceType<typeof SimulatedController>
    await ctrl.sendCommandAwait('M3 S6000')
    await vi.advanceTimersByTimeAsync(1000)
    expect(ctrl.status().spindleRpm).toBeGreaterThan(0)
    if (native) ctrl.capabilities.gcodeText = false
    const resetStates: boolean[] = []
    const unsubscribe = ctrl.subscribeResetInProgress(() => resetStates.push(ctrl.resetInProgress()))
    const pending = session.runDirectionalProbeTouch('Z', '-', CONFIG)
    await until('probe moving', () => ctrl.machineState() === 'run')
    ctrl.reset()
    expect(resetStates).toEqual([true, false])
    expect(ctrl.status().spindleRpm).toBe(0)
    expect(ctrl.jobProgress().totalLines).toBe(0)
    expect(ctrl.startJob()).toBe(false)
    expect(await finish(pending)).toMatchObject({ ok: false, stopped: true })
    const stopped = ctrl.status().machinePos
    await vi.advanceTimersByTimeAsync(1000)
    expect(ctrl.status().machinePos).toEqual(stopped)
    unsubscribe()
  })

  it('GRBL: controlled stop settles G38; repeated Resume shrinks the same absolute bound; program stays startable', async () => {
    const ctrl = await connect('serial')
    expect(ctrl).toBeInstanceOf(GrblController)
    const progress = ctrl.jobProgress()
    const job = { ...useMachineControl.getState().job }
    const pending = session.runDirectionalProbeTouch('Z', '-', CONFIG)
    await until('first seek sent', () => seekLines().length === 1)
    expect(seekLines()[0]).toContain('Z-50')
    for (const z of [-10, -20]) {
      const count = seekLines().length
      pipe.z = z; pipe.report()
      session.pauseProbing()
      await vi.advanceTimersByTimeAsync(1600)
      expect(pipe.moving, 'G38 halted, not merely jog-cancelled').toBe(false)
      expect(session.isProbeCyclePaused()).toBe(true)
      expect(ctrl.jobProgress()).toEqual(progress)
      expect(useMachineControl.getState().job).toEqual(job)
      expect(seekLines()).toHaveLength(count)
      session.resumeProbing()
      await until('same seek replayed', () => seekLines().length === count + 1)
      expect(seekLines().at(-1)).toContain(`Z${-55 - z}`)
    }
    session.stopProbing()
    expect(await finish(pending)).toMatchObject({ ok: false, stopped: true })
    await vi.advanceTimersByTimeAsync(1600)
    expect(pipe.moving).toBe(false)
    expect(seekLines()).toHaveLength(3)
    expect(useMachineControl.getState().job.name).toBe('preserve-wo2609.nc')
    expect(ctrl.jobProgress()).toEqual(progress)
    pipe.suppressAcks = true
    expect(ctrl.startJob(), 'original streamer is still startable').toBe(true)
    ctrl.pauseJob(); pipe.report()
    await vi.advanceTimersByTimeAsync(100)
    const held = currentOperatorTransport()
    const heldProgress = ctrl.jobProgress()
    session.pauseProbing(); session.stopProbing()
    expect(currentOperatorTransport()).toEqual(held)
    expect(ctrl.jobProgress()).toEqual(heldProgress)
    expect(ctrl.resumeJob(), 'held program resume eligibility is unchanged').toBe(true)
  })

  it.each([false, true])('simulator text/native=%s: reset settles seek, Pause/Resume/Stop retain program and held-program eligibility', async native => {
    const ctrl = await connect('simulator') as InstanceType<typeof SimulatedController>
    if (native) ctrl.capabilities.gcodeText = false
    const progress = ctrl.jobProgress()
    const job = { ...useMachineControl.getState().job }
    const text = vi.spyOn(ctrl, 'sendCommandAwait')
    const call = vi.spyOn(ctrl, 'probe')
    const pending = session.runDirectionalProbeTouch('Z', '-', CONFIG)
    await until('seek moving', () => ctrl.machineState() === 'run')
    await vi.advanceTimersByTimeAsync(500)
    const before = ctrl.status().machinePos!.z
    session.pauseProbing()
    await vi.advanceTimersByTimeAsync(1000)
    expect(ctrl.machineState()).toBe('idle')
    expect(ctrl.status().machinePos!.z).toBe(before)
    expect(ctrl.jobProgress()).toEqual(progress)
    expect(useMachineControl.getState().job).toEqual(job)
    session.resumeProbing()
    await until('seek resumes', () => ctrl.machineState() === 'run')
    if (native) expect(call.mock.calls.at(-1)?.[1]).toBe(-55)
    else expect(text.mock.calls.filter(c => /G38/.test(c[0])).at(-1)?.[0]).toContain(`Z${Number((-55 - before).toFixed(4))}`)
    session.stopProbing()
    expect(await finish(pending)).toMatchObject({ ok: false, stopped: true })
    const stopped = ctrl.status().machinePos
    await vi.advanceTimersByTimeAsync(1000)
    expect(ctrl.status().machinePos).toEqual(stopped)
    expect(ctrl.jobProgress()).toEqual(progress)
    expect(useMachineControl.getState().job.name).toBe('preserve-wo2609.nc')
    // Restore the text shape used to load this file, then actually start it.
    ctrl.capabilities.gcodeText = true
    expect(ctrl.startJob()).toBe(true)
    await until('program holds at M0', () => ctrl.machineState() === 'hold', 12000)
    const held = currentOperatorTransport()
    const heldProgress = ctrl.jobProgress()
    session.pauseProbing(); session.stopProbing()
    expect(currentOperatorTransport()).toEqual(held)
    expect(ctrl.jobProgress()).toEqual(heldProgress)
    expect(await executeOperatorCycleStart()).toBe(true)
  })

  it('a text seek already at its absolute bound sends no replay and reports a miss', async () => {
    const ctrl = await connect('serial')
    const before = ctrl.jobProgress()
    const pending = session.runDirectionalProbeTouch('Z', '-', CONFIG)
    await until('seek sent', () => seekLines().length === 1)
    pipe.z = -55; pipe.report()
    session.pauseProbing()
    await vi.advanceTimersByTimeAsync(1600)
    session.resumeProbing()
    const result = await finish(pending)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('never made contact')
    expect(seekLines()).toHaveLength(1)
    expect(ctrl.jobProgress()).toEqual(before)
  })

  it('simulator reset settles the direct text and native awaiters with controller reset', async () => {
    const ctrl = await connect('simulator') as InstanceType<typeof SimulatedController>
    const text = ctrl.sendCommandAwait('G21 G91 G38.3 Z-50 F60')!
    await vi.advanceTimersByTimeAsync(100)
    ctrl.reset()
    expect(await finish(text)).toMatchObject({ ok: false, message: 'controller reset' })
    expect(ctrl.jobProgress().totalLines, 'ordinary Reset still abandons the loaded file').toBe(0)
    session.loadMachineProgram('preserve-wo2609.nc', PROGRAM)
    const native = ctrl.probe('Z', -55, 60)
    await vi.advanceTimersByTimeAsync(100)
    ctrl.reset()
    expect(await finish(native)).toMatchObject({ ok: false, at: null, reason: 'controller reset' })
    expect(ctrl.jobProgress().totalLines).toBe(0)
    expect(ctrl.startJob()).toBe(false)
  })

  it.each([1, 2])('simulator text: Pause during seek %s completes the same fast/fine contact and keeps the loaded file', async pass => {
    const ctrl = await connect('simulator')
    const before = ctrl.jobProgress()
    const send = vi.spyOn(ctrl, 'sendCommandAwait')
    const seeks = () => send.mock.calls.filter(c => /G38/.test(c[0]))
    const pending = session.runDirectionalProbeTouch('Z', '-', { ...CONFIG, fastFeed: 600, slowFeed: 300 })
    await until('chosen seek starts', () => seeks().length === pass, 15000)
    await vi.advanceTimersByTimeAsync(100)
    const initial = seeks().at(-1)![0]
    const sentFrom = pass === 1 ? -5 : -38
    const target = sentFrom + Number(/Z([\d.+-]+)/.exec(initial)![1])
    session.pauseProbing()
    const stoppedAt = ctrl.status().machinePos!.z
    await vi.advanceTimersByTimeAsync(1000)
    expect(ctrl.status().machinePos!.z).toBe(stoppedAt)
    session.resumeProbing()
    await until('seek replay sent', () => seeks().length === pass + 1)
    expect(seeks().at(-1)![0]).toContain(`Z${Number((target - stoppedAt).toFixed(4))}`)
    const result = await finish(pending, 15000)
    expect(result.ok, result.message).toBe(true)
    expect(result.probedMachinePosition).toBeCloseTo(-40, 1)
    expect(ctrl.jobProgress()).toEqual(before)
    expect(useMachineControl.getState().job.name).toBe('preserve-wo2609.nc')
  })

  it('text G38.3 guarded descent replays its absolute depth and then continues to the side touch', async () => {
    const ctrl = await connect('simulator')
    ctrl.jogToWorkXY(50, 50, 6000)
    await vi.advanceTimersByTimeAsync(2000)
    const before = ctrl.jobProgress()
    const config = resolveProbeConfig(null, { ...CONFIG, positioningFeed: 60, surfaceClearance: 2 })
    const planned = planFeatureProbeCycle({ kind: 'bore', start: ctrl.status().machinePos!,
      envelope: deriveMachineEnvelopeFromConvention({ x: { homesToward: 'min', machineZeroAt: 'min' },
        y: { homesToward: 'min', machineZeroAt: 'min' }, z: { homesToward: 'max', machineZeroAt: 'max' } },
      { x: 100, y: 100, z: 100 }), config, tipRadiusMm: 1.5, nominalSizeXmm: 25,
      nominalSizeYmm: 25, rimTopMachineZMm: -5, depthBelowTopMm: 5 })
    expect(planned.ok).toBe(true)
    if (!planned.ok) throw new Error(planned.reason)
    const send = vi.spyOn(ctrl, 'sendCommandAwait')
    const seeks = () => send.mock.calls.filter(c => /G38/.test(c[0]))
    const pending = session.runFeatureProbeCycle(planned.plan, config, true)
    await until('guarded descent sent', () => seeks().some(c => /G38.3/.test(c[0])), 6000)
    await vi.advanceTimersByTimeAsync(200)
    session.pauseProbing()
    const at = ctrl.status().machinePos!.z
    await vi.advanceTimersByTimeAsync(1000)
    expect(ctrl.status().machinePos!.z).toBe(at)
    session.resumeProbing()
    await until('guarded descent replayed', () => seeks().filter(c => /G38.3/.test(c[0])).length === 2)
    expect(seeks().at(-1)![0]).toContain(`G38.3  Z${Number((-10 - at).toFixed(4))}`)
    await until('side touch after guarded bound', () => seeks().some(c => /G38.2/.test(c[0])), 15000)
    expect(ctrl.status().machinePos!.z).toBe(-10)
    session.stopProbing()
    expect(await finish(pending)).toMatchObject({ ok: false, stopped: true })
    expect(ctrl.jobProgress()).toEqual(before)
  })
})
