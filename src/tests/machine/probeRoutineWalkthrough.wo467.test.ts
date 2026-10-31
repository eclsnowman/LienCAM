// WO-467: walk the probe routines in the simulator, ourselves. Operator declined
// this walkthrough (card Q-IN-THE-SIMULATOR-THE-REAL-MACHIN-1787187005746,
// STATUS 2026-08-22 RULING 5) - simulator and GRBL verification is ours, not
// his. This is the SAME walkthrough written for him, driven at the LOGIC
// level: the real (non-mocked) simulator, through machineSession's real
// connectMachine/runProbeRoutine/setWorkOffsetValue - no mocked
// sendCommandAwait (except G38.3, which the simulator does not speak yet -
// answered as GRBL does since WO-2065, see answerG383LikeGrbl), no faked
// [PRB] values. Per the WO's Method section, a
// logic-level proof of the emitted probe moves and the resulting work offset
// is stronger evidence than a screenshot that only shows a button was
// pressed, so it is used wherever it can replace one. The UI-level walk
// (same buttons Operator would click) is captured separately in
// src/tests/evidence/WO-467/.
//
// Do NOT change product behaviour to make this pass (the WO's own rule) -
// nothing here touches src/lib or src/components.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useMachineControl } from '../../store/machineControlStore'
import { useCamStore } from '../../store'
import {
  __resetEstopInterlockForTest,
  connectMachine,
  disconnectMachine,
  getMachineController,
  getSimulatedPart,
  PROBE_ROUTINE_PREVIEW_STALE,
  runProbeRoutine,
  setSimulatedPart,
  setWorkOffsetValue,
} from '../../lib/machine/machineSession'
import { deriveMachineEnvelopeFromConvention } from '../../lib/machine/machineEnvelope'
import { expandProbeRoutine } from '../../lib/machine/probeRoutineExpand'
import { FACTORY_BORE_CENTRE, FACTORY_EDGE_X_PLUS } from '../../lib/machine/probeRoutineFactory'
import { resolveProbeConfig, type ZProbeConfig } from '../../lib/machine/toolTable'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

// Operator's own machine (WO-377/WO-411's declared travel), machine zero at max
// on every axis - the same convention every prior probe-routine capture uses.
const envelope = deriveMachineEnvelopeFromConvention(
  {
    x: { homesToward: 'max', machineZeroAt: 'max' },
    y: { homesToward: 'max', machineZeroAt: 'max' },
    z: { homesToward: 'max', machineZeroAt: 'max' },
  },
  { x: 738, y: 724.5, z: 128.9 },
)
const rawConfig: ZProbeConfig = {
  positioningFeed: 1200,
  fastFeed: 1200,
  slowFeed: 300,
  retract: 2,
  maxTravel: 30,
  surfaceClearance: 5,
  overtravel: 5,
  crossOverLift: 10,
  padThickness: 10,
}
const config = resolveProbeConfig(null, rawConfig)
// Same default the Routines tab's "Tip radius" field starts at (ProbeRoutinesTab.tsx).
const TIP = 1.5

function selectProbeWalkthroughMachineFixture(): void {
  const machine = useCamStore.getState().project.machine
  useCamStore.getState().setProjectMachine({
    ...machine,
    id: 'wo467-negative-machine',
    name: 'WO-467 negative-frame fixture',
    controller: 'grbl',
    controllerDefinition: undefined,
    unsentSettings: undefined,
    travel: { x: 738, y: 724.5, z: 128.9 },
    rapidRate: 60000,
    homeConvention: {
      x: { homesToward: 'max', machineZeroAt: 'max' },
      y: { homesToward: 'max', machineZeroAt: 'max' },
      z: { homesToward: 'max', machineZeroAt: 'max' },
    },
  })
}

async function connectHomed() {
  useCamStore.getState().newProject()
  selectProbeWalkthroughMachineFixture()
  const connected = connectMachine('simulator', 115200)
  await vi.advanceTimersByTimeAsync(300)
  await connected
  __resetEstopInterlockForTest()
  await vi.advanceTimersByTimeAsync(50)
  getMachineController().home()
  await vi.advanceTimersByTimeAsync(3000)
  answerG383LikeGrbl()
}

type AwaitSend = (text: string) => Promise<{ ok: boolean; message: string | null }> | null

/** WO-2065: the factory routines descend to probing depth with G38.3, a probe
 *  move that stops on contact. The simulator's manual-command vocabulary has
 *  no G38.3 yet, so answer it as GRBL does (the WO-2055/WO-2073 shim): a G38.2
 *  when the placed part's top lies under the probe above the target, else a
 *  plain move that ends quietly at the target. Every other line goes to the
 *  real simulator untouched. */
function answerG383LikeGrbl(): void {
  const sim = getMachineController() as unknown as { sendCommandAwait: AwaitSend }
  const realAwait = sim.sendCommandAwait.bind(sim)
  sim.sendCommandAwait = (text) => {
    const m = /^G21 G91 G38\.3 Z-([\d.]+) F([\d.]+)$/.exec(text)
    if (!m) return realAwait(text)
    const at = useMachineControl.getState().mpos!
    const target = Number((at.z - Number(m[1])).toFixed(4))
    const part = getSimulatedPart()
    const inHole = !!part?.bore && Math.hypot(at.x - part.bore.cx, at.y - part.bore.cy) <= part.bore.diameter / 2
    const onPart = !!part && !inHole
      && at.x >= part.origin.x && at.x <= part.origin.x + part.sizeX
      && at.y >= part.origin.y && at.y <= part.origin.y + part.sizeY
    return onPart && part!.topZ >= target
      ? realAwait(`G21 G91 G38.2 Z-${m[1]} F${m[2]}`)
      : realAwait(`G21 G90 G53 G1 Z${target} F${m[2]}`)
  }
}

/** Fake timers never advance on their own - drive the awaited promise to
 *  completion by advancing while it is in flight. */
async function finish<T>(promise: Promise<T>, ms = 120_000): Promise<T> {
  let result: T | undefined
  let done = false
  void promise.then((value) => { result = value; done = true })
  await vi.advanceTimersByTimeAsync(ms)
  expect(done).toBe(true)
  return result!
}

/** Absolute machine-frame rapid, ack'd and then settled to Idle by POLLING -
 *  GRBL acks a move when it is QUEUED, not when it has finished (the same
 *  race machineSession.ts's runProbeRoutine now guards between its own
 *  steps), so a long rapid (the jog to table centre) needs the same
 *  poll-until-verifiedIdle loop the product code uses, not a fixed wait. */
async function jogTo(x: number, y: number, z: number) {
  const ctrl = getMachineController()
  const task = (async () => {
    const ack = await ctrl.sendCommandAwait(`G53 G90 G0 X${x} Y${y} Z${z}`)
    if (!ack?.ok) throw new Error(`jog refused: ${ack?.message}`)
    for (let i = 0; i < 400; i++) {
      ctrl.queryStatus()
      await new Promise((resolve) => setTimeout(resolve, 50))
      if (ctrl.verifiedIdle()) return
      if (ctrl.machineState() === 'alarm') throw new Error('alarm during jog')
    }
    throw new Error('jog did not settle to Idle')
  })()
  await finish(task, 60_000)
}

afterEach(async () => {
  const ctrl = getMachineController()
  if (ctrl.connectionPhase() === 'connected') ctrl.emergencyStop()
  const disconnected = disconnectMachine()
  await vi.advanceTimersByTimeAsync(200)
  await disconnected
})

// Table centre, at probing depth - same numbers WO-411's capture uses (the
// machine travels 738 x 724.5 x 128.9, machine zero at max on every axis, so
// a freshly-homed machine sits at the 0,0,0 corner and must be jogged to the
// middle before any of this - the bore/edge routines both need room on every
// side to approach from).
const CENTRE = { x: -369, y: -362.25, z: -50 }

describe('WO-467 step 1-6: Bore centre - connect, home, place the part, Check, Run, Confirm', () => {
  it('proposes the true hole centre and diameter, then Confirm moves the work offset to it', async () => {
    await connectHomed()
    await jogTo(CENTRE.x, CENTRE.y, CENTRE.z)
    const mpos = useMachineControl.getState().mpos!

    // "Diagnostics tab -> Simulated part -> Place under probe": the pretend
    // part's 20 mm hole parked with its centre at the probe's current XY.
    setSimulatedPart({
      origin: { x: mpos.x - 25, y: mpos.y - 20 },
      sizeX: 50,
      sizeY: 40,
      topZ: mpos.z - 10,
      height: 20,
      bowMm: 0,
      noiseMm: 0,
      bore: { cx: mpos.x, cy: mpos.y, diameter: 20, depth: 15 },
    })
    // The probe sits at probing depth over the bore before Run, same as a
    // real operator jogging down into the hole first.
    await jogTo(mpos.x, mpos.y, mpos.z - 15)
    const start = useMachineControl.getState().mpos!

    // "Routines tab -> Bore centre -> diameter 20 -> Check"
    const expanded = expandProbeRoutine(
      FACTORY_BORE_CENTRE,
      // WO-2065: the Bore works from its top (the Routines tab fills it from work Z0) - the block top
      { diameter: 20, topZ: mpos.z - 10 },
      { start, envelope, probe: config, tipRadiusMm: TIP, activeWcs: 'G54' },
    )
    if (!expanded.ok) throw new Error(expanded.errors.map((e) => e.sentence).join('\n'))

    // "tick -> Run"
    const result = await finish(runProbeRoutine(expanded.expanded, rawConfig, true, expanded.expanded.hash, { envelope }))
    expect(result.ok, result.message).toBe(true)
    expect(result.touches).toHaveLength(4)

    const offsetProposal = result.proposals.find((p) => p.kind === 'workOffset')
    const reportProposal = result.proposals.find((p) => p.kind === 'report')
    if (offsetProposal?.kind !== 'workOffset') throw new Error('no work-offset proposal')
    if (reportProposal?.kind !== 'report') throw new Error('no report proposal')

    // "READ THE PROPOSAL" - the acceptance numbers, recorded not narrated.
    console.log('[WO-467 bore] proposal', JSON.stringify({ offset: offsetProposal.axes, report: reportProposal.items }))
    expect(offsetProposal.axes.X).toBeCloseTo(mpos.x, 2)
    expect(offsetProposal.axes.Y).toBeCloseTo(mpos.y, 2)
    const diameterX = reportProposal.items.find((i) => i.label === 'Diameter (X)')!.value
    const diameterY = reportProposal.items.find((i) => i.label === 'Diameter (Y)')!.value
    // 23.000, exactly the WO's own acceptance number ("the 20 mm hole plus
    // the probe tip on both sides"). The routine's compensation
    // (probeRoutineFactory.ts:263-264) adds 2x tip radius to the raw
    // touch-to-touch span to CANCEL a real ball probe's own radius offset at
    // each wall - correct for a physical G38.2 trigger. But the simulator's
    // contact model (simulatedController.ts probeContactPoint, :757-795) has
    // no probe geometry at all: it reports the touch at the true modelled
    // surface directly, nothing to cancel. So on the simulator specifically
    // the correction adds a genuine 2x tip radius on top of the true 20 mm
    // bore -> 23.000. See README.md for the full writeup - this is the
    // number the software actually produces here, and the real-hardware
    // check beta testers need to make.
    expect(diameterX).toBeCloseTo(20 + 2 * TIP, 2)
    expect(diameterY).toBeCloseTo(20 + 2 * TIP, 2)

    // "Confirm. The work offset must move to the hole centre." - the same
    // write ProbeRoutineRunPanel's onConfirm performs.
    const wroteX = setWorkOffsetValue('G54', 'X', offsetProposal.axes.X!)
    const wroteY = setWorkOffsetValue('G54', 'Y', offsetProposal.axes.Y!)
    expect(wroteX && wroteY).toBe(true)
    getMachineController().refreshState()
    await vi.advanceTimersByTimeAsync(200)
    const g54 = useMachineControl.getState().offsets.G54
    expect(g54?.[0]).toBeCloseTo(mpos.x, 2)
    expect(g54?.[1]).toBeCloseTo(mpos.y, 2)
  })
})

describe('WO-467 step 7: Edge routine, the same way', () => {
  it('one touch on a real face proposes that face as work X, Confirm writes it', async () => {
    await connectHomed()
    await jogTo(CENTRE.x, CENTRE.y, CENTRE.z)
    const mpos = useMachineControl.getState().mpos!
    const blockOriginX = mpos.x - 10 // the face the probe will touch, moving +X
    const blockOriginY = mpos.y - 20
    setSimulatedPart({
      origin: { x: blockOriginX, y: blockOriginY },
      sizeX: 50,
      sizeY: 40,
      topZ: mpos.z - 10,
      height: 20,
      bowMm: 0,
      noiseMm: 0,
    })
    // WO-2065: parked OVER the block, 5 mm in from its left face and 5 mm
    // above its top - the routine touches the top, steps out past the face
    // and descends to probing depth itself.
    await jogTo(blockOriginX + 5, blockOriginY + 20, mpos.z - 5)
    const start = useMachineControl.getState().mpos!

    const expanded = expandProbeRoutine(
      FACTORY_EDGE_X_PLUS,
      {},
      { start, envelope, probe: config, tipRadiusMm: TIP, activeWcs: 'G54' },
    )
    if (!expanded.ok) throw new Error(expanded.errors.map((e) => e.sentence).join('\n'))

    const result = await finish(runProbeRoutine(expanded.expanded, rawConfig, true, expanded.expanded.hash, { envelope }))
    expect(result.ok, result.message).toBe(true)
    expect(result.touches.map((t) => t.name)).toEqual(['top', 'face'])

    const offsetProposal = result.proposals.find((p) => p.kind === 'workOffset')
    if (offsetProposal?.kind !== 'workOffset') throw new Error('no work-offset proposal')
    console.log('[WO-467 edge] proposal', JSON.stringify(offsetProposal.axes))
    // Same simulator characteristic as the bore's 23.000 above, single-sided
    // here: the touch reports the true face directly, so the routine's
    // "+ tip radius" correction (faceExpr, probeRoutineFactory.ts:36) is a
    // genuine +1x tip radius against the modelled part, not a cancellation.
    expect(offsetProposal.axes.X).toBeCloseTo(blockOriginX + TIP, 2)

    const wrote = setWorkOffsetValue('G54', 'X', offsetProposal.axes.X!)
    expect(wrote).toBe(true)
    getMachineController().refreshState()
    await vi.advanceTimersByTimeAsync(200)
    expect(useMachineControl.getState().offsets.G54?.[0]).toBeCloseTo(blockOriginX + TIP, 2)
  })
})

describe('WO-467 refusal paths: what happens when it should not just work', () => {
  it('Check not run (a stale/mismatched preview hash) refuses before any motion', async () => {
    await connectHomed()
    await jogTo(CENTRE.x, CENTRE.y, CENTRE.z)
    const mpos = useMachineControl.getState().mpos!
    setSimulatedPart({
      origin: { x: mpos.x - 25, y: mpos.y - 20 },
      sizeX: 50,
      sizeY: 40,
      topZ: mpos.z - 10,
      height: 20,
      bore: { cx: mpos.x, cy: mpos.y, diameter: 20, depth: 15 },
    })
    await jogTo(mpos.x, mpos.y, mpos.z - 15)
    const start = useMachineControl.getState().mpos!
    const expanded = expandProbeRoutine(
      FACTORY_BORE_CENTRE,
      // WO-2065: the Bore works from its top (the Routines tab fills it from work Z0) - the block top
      { diameter: 20, topZ: mpos.z - 10 },
      { start, envelope, probe: config, tipRadiusMm: TIP, activeWcs: 'G54' },
    )
    if (!expanded.ok) throw new Error(expanded.errors.map((e) => e.sentence).join('\n'))

    // This is exactly the gate the UI's Run button enforces by not existing
    // until a fresh Check (ProbeRoutinePreview.tsx: RUN_NEEDS_CHECK /
    // ProbeRoutineRunPanel's `stale` prop) - proven here at the layer that
    // actually refuses: a hash that does not match the current preview.
    const result = await finish(runProbeRoutine(expanded.expanded, rawConfig, true, 'a-stale-hash-from-before-you-changed-the-input', { envelope }))
    expect(result.ok).toBe(false)
    expect(result.message).toBe(PROBE_ROUTINE_PREVIEW_STALE)
    expect(result.touches).toHaveLength(0)
    expect(useMachineControl.getState().mpos).toMatchObject({ x: start.x, y: start.y, z: start.z })
  })

  it('diameter badly wrong for the real hole - all four walls are sought without nominal positioning (WO-2554)', async () => {
    await connectHomed()
    await jogTo(CENTRE.x, CENTRE.y, CENTRE.z)
    const mpos = useMachineControl.getState().mpos!
    // A real 20 mm bore, but Check is run with 60 mm entered by mistake -
    // same block as the bore-centre walkthrough above.
    const blockOriginX = mpos.x - 25
    const blockOriginY = mpos.y - 20
    setSimulatedPart({
      origin: { x: blockOriginX, y: blockOriginY },
      sizeX: 50,
      sizeY: 40,
      topZ: mpos.z - 10,
      height: 20,
      bowMm: 0,
      noiseMm: 0,
      bore: { cx: mpos.x, cy: mpos.y, diameter: 20, depth: 15 },
    })
    await jogTo(mpos.x, mpos.y, mpos.z - 15)
    const start = useMachineControl.getState().mpos!
    const expanded = expandProbeRoutine(
      FACTORY_BORE_CENTRE,
      { diameter: 60, topZ: mpos.z - 10 },
      { start, envelope, probe: config, tipRadiusMm: TIP, activeWcs: 'G54' },
    )
    if (!expanded.ok) throw new Error(expanded.errors.map((e) => e.sentence).join('\n'))

    const result = await finish(runProbeRoutine(expanded.expanded, rawConfig, true, expanded.expanded.hash, { envelope }))
    console.log('[WO-467 refusal: wrong diameter]', JSON.stringify({ ok: result.ok, message: result.message, touches: result.touches, stoppedAt: result.stoppedAt }))
    // WO-2554: a wrong nominal no longer positions into the wall. The same
    // real simulator runner seeks and records all four walls instead.
    expect(result.ok, result.message).toBe(true)
    expect(result.touches).toHaveLength(4)
    expect(result.stoppedAt).toBeNull()
  })

  it('the probe does not trip (no part under it) - the run stops at the named step, nothing written', async () => {
    await connectHomed()
    await jogTo(CENTRE.x, CENTRE.y, CENTRE.z)
    const mpos = useMachineControl.getState().mpos!
    // Nothing to touch: WO-3189 seeds a part at simulator connect, so the empty
    // table has to be stated explicitly or this is not the no-contact case.
    setSimulatedPart(null)
    await jogTo(mpos.x, mpos.y, mpos.z - 15)
    const start = useMachineControl.getState().mpos!
    const expanded = expandProbeRoutine(
      FACTORY_BORE_CENTRE,
      // WO-2065: the Bore works from its top (the Routines tab fills it from work Z0) - the block top
      { diameter: 20, topZ: mpos.z - 10 },
      { start, envelope, probe: config, tipRadiusMm: TIP, activeWcs: 'G54' },
    )
    if (!expanded.ok) throw new Error(expanded.errors.map((e) => e.sentence).join('\n'))

    const result = await finish(runProbeRoutine(expanded.expanded, rawConfig, true, expanded.expanded.hash, { envelope }))
    console.log('[WO-467 refusal: no contact]', JSON.stringify({ ok: result.ok, message: result.message, stoppedAt: result.stoppedAt }))
    expect(result.ok).toBe(false)
    expect(result.stoppedAt?.label).toMatch(/left/i)
    expect(result.proposals).toHaveLength(0)
    // Nothing written: no offset proposal ever reached Confirm.
  })
})
