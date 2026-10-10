// WO-411 slice 3 - the probe ROUTINE runner (machineSession.runProbeRoutine).
// WO-1101 re-pins the runner to the controller contract's typed motion verbs.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { useMachineControl } from '../../store/machineControlStore'
import {
  __resetEstopInterlockForTest,
  getMachineController,
  isProbeCycleActive,
  PROBE_ROUTINE_PREVIEW_STALE,
  runProbeRoutine,
  triggerEmergencyStop,
} from '../../lib/machine/machineSession'
import { deriveMachineEnvelopeFromConvention } from '../../lib/machine/machineEnvelope'
import { expandProbeRoutine, type ExpandedRoutine } from '../../lib/machine/probeRoutineExpand'
import { FACTORY_BORE_CENTRE, FACTORY_EDGE_X_MINUS } from '../../lib/machine/probeRoutineFactory'
import type { ProbeRoutine, ProbeRoutineStep } from '../../lib/machine/probeRoutineFormat'
import { resolveProbeConfig } from '../../lib/machine/toolTable'
import type { JogAxis, MachineController } from '../../lib/machine/controller'
const envelope = deriveMachineEnvelopeFromConvention(
  {
    x: { homesToward: 'min', machineZeroAt: 'min' },
    y: { homesToward: 'min', machineZeroAt: 'min' },
    z: { homesToward: 'min', machineZeroAt: 'min' },
  },
  { x: 300, y: 300, z: 100 },
)
const rawConfig = {
  positioningFeed: 1200,
  fastFeed: 300,
  slowFeed: 40,
  retract: 2,
  maxTravel: 30,
  surfaceClearance: 5,
  overtravel: 5,
  crossOverLift: 10,
  padThickness: 10,
}
const config = resolveProbeConfig(null, rawConfig)
const TIP = 1.5
const start = { x: 100, y: 100, z: 20 }
const workOffset = { x: 10, y: 20, z: 0 }
const ctrl = getMachineController()
const originalCapabilities = ctrl.capabilities
const WIRE_EVIDENCE = resolve(__dirname, '../evidence/WO-2554/typed-wire-parity.txt')
let machinePos = { ...start }
let wire: string[] = []

/** WO-2065: the factory routines now find their depth from the top first (a
 *  top touch or the hole's top, a rise to safe height and a descent that stops
 *  on contact - pinned by routinesTabTopSafeDepth.wo2065 and
 *  routineGuardedDescent.wo2073). This file pins the runner's typed wire for
 *  the side touches, so it runs the routine's side steps from where the probe
 *  stands - the factory routines as they were before WO-2065. */
function atStartHeight(routine: ProbeRoutine): ProbeRoutine {
  const heightStep = (s: ProbeRoutineStep) =>
    (s.kind === 'touch' && s.name === 'top')
    || (s.kind === 'calc' && (s.name === 'safeZ' || s.name === 'depthZ'))
    || (s.kind === 'branch' && s.name === 'startHeight')
    || (s.kind === 'move' && s.to.z !== undefined)
    || (s.kind === 'check' && JSON.stringify(s.condition).includes('calc.depthZ'))
  return { ...routine, steps: routine.steps.filter((s) => !heightStep(s)) }
}

function expandBore(): ExpandedRoutine {
  const r = expandProbeRoutine(atStartHeight(FACTORY_BORE_CENTRE), { diameter: 40 }, { start, envelope, probe: config, tipRadiusMm: TIP, activeWcs: 'G54' })
  if (!r.ok) throw new Error(r.errors.map((e) => e.sentence).join('\n'))
  return r.expanded
}

function connectedIdleController() {
  const ctrl = getMachineController()
  const baseStatus = ctrl.status()
  vi.spyOn(ctrl, 'connectionPhase').mockReturnValue('connected')
  vi.spyOn(ctrl, 'hasActiveJob').mockReturnValue(false)
  vi.spyOn(ctrl, 'machineState').mockReturnValue('idle')
  vi.spyOn(ctrl, 'homedThisSession').mockReturnValue(true)
  vi.spyOn(
    ctrl as MachineController & { homedAxesThisSession(): Partial<Record<JogAxis, boolean>> },
    'homedAxesThisSession',
  ).mockReturnValue({ X: true, Y: true, Z: true })
  vi.spyOn(ctrl, 'sendCommand').mockImplementation((line) => {
    wire.push(`TEXT ${line}`)
    return true
  })
  vi.spyOn(ctrl, 'sendCommandAwait').mockImplementation((line) => {
    wire.push(`TEXT-AWAIT ${line}`)
    return Promise.resolve({ ok: true, message: 'ok' })
  })
  vi.spyOn(ctrl, 'refreshState').mockReturnValue(true)
  vi.spyOn(ctrl, 'queryStatus').mockReturnValue(undefined)
  vi.spyOn(ctrl, 'verifiedIdle').mockReturnValue(true)
  vi.spyOn(ctrl, 'status').mockImplementation(() => ({
    ...baseStatus,
    state: 'idle',
    machinePos: { ...machinePos },
    workPos: {
      x: machinePos.x - workOffset.x,
      y: machinePos.y - workOffset.y,
      z: machinePos.z - workOffset.z,
    },
  }))
  vi.spyOn(ctrl, 'jogToWorkXY').mockImplementation((x, y, feed) => {
    wire.push(`jogToWorkXY(${x},${y},${feed})`)
    machinePos = { ...machinePos, x: x + workOffset.x, y: y + workOffset.y }
    return true
  })
  vi.spyOn(ctrl, 'jogToMachineZ').mockImplementation((z, feed) => {
    wire.push(`jogToMachineZ(${z},${feed})`)
    machinePos = { ...machinePos, z }
    return true
  })
  vi.spyOn(ctrl, 'jog').mockImplementation((axis, delta, feed) => {
    wire.push(`jog(${axis},${delta},${feed})`)
    const key = axis.toLowerCase() as 'x' | 'y' | 'z'
    machinePos = { ...machinePos, [key]: machinePos[key] + delta }
    return true
  })
  return ctrl
}

function fakeWalls(contactsInOrder: Array<[number, number, number]>) {
  let pass = 0
  vi.spyOn(getMachineController(), 'probe').mockImplementation(async (axis, target, feed) => {
    wire.push(`probe(${axis},${target},${feed})`)
    const values = contactsInOrder[Math.floor(pass++ / 2)] ?? [0, 0, 0]
    machinePos = { x: values[0], y: values[1], z: values[2] }
    return { ok: true, at: { ...machinePos } }
  })
  return wire
}

beforeEach(() => {
  __resetEstopInterlockForTest()
  useMachineControl.setState({
    probe: null,
    parserModal: null,
    activeWcs: 'G54',
    offsets: { G54: [0, 0, 0] },
  })
  machinePos = { ...start }
  wire = []
  connectedIdleController()
})
afterEach(() => {
  vi.restoreAllMocks()
  Object.defineProperty(ctrl, 'capabilities', {
    configurable: true,
    value: originalCapabilities,
  })
})

describe('WO-411/1101: runProbeRoutine executes the expanded bore through typed verbs', () => {
  // WO-2554: seeks start at the starting line, not a nominal approach point.
  const walls: Array<[number, number, number]> = [[84.5, 100, 20], [115.5, 100, 20], [100, 84.5, 20], [100, 115.5, 20]]

  it('uses typed XY/probe/jog calls in order and sends zero G-code text', async () => {
    Object.defineProperty(ctrl, 'capabilities', {
      configurable: true,
      value: { ...originalCapabilities, gcodeText: false },
    })
    const expanded = expandBore()
    const calls = fakeWalls(walls)
    const b = await runProbeRoutine(expanded, rawConfig, true, expanded.hash, { envelope })
    expect(b.ok).toBe(true)
    expect(calls.slice(0, 5)).toEqual([
      'probe(X,70,300)',
      'jog(X,2,1200)',
      'probe(X,82.5,40)',
      'jog(X,2,1200)',
      'jogToWorkXY(90,80,1200)',
    ])
    expect(calls.filter((line) => line.startsWith('TEXT'))).toEqual([])
    expect(isProbeCycleActive()).toBe(false)
  })

  it('returns a byte-identical result record for gcodeText false and true', async () => {
    const expanded = expandBore()
    Object.defineProperty(ctrl, 'capabilities', {
      configurable: true,
      value: { ...originalCapabilities, gcodeText: false },
    })
    fakeWalls(walls)
    const axbbShape = await runProbeRoutine(expanded, rawConfig, true, expanded.hash, { envelope })
    const axbbWire = [...wire]

    vi.restoreAllMocks()
    machinePos = { ...start }
    wire = []
    connectedIdleController()
    Object.defineProperty(ctrl, 'capabilities', {
      configurable: true,
      value: { ...originalCapabilities, gcodeText: true },
    })
    fakeWalls(walls)
    const textShape = await runProbeRoutine(expanded, rawConfig, true, expanded.hash, { envelope })
    const textWire = [...wire]

    expect(JSON.stringify(axbbShape)).toBe(JSON.stringify(textShape))
    expect(axbbWire).toEqual(textWire)
    const expectedEvidence = [
      '# WO-2554 seek-only typed routine wire parity',
      '# AXBB shape (gcodeText:false) | text shape (gcodeText:true)',
      ...axbbWire.map((line, index) => `${index + 1}. ${line} | ${textWire[index]}`),
    ].join('\n')
    expect(readFileSync(WIRE_EVIDENCE, 'utf8').replace(/\r\n/g, '\n').trimEnd()).toBe(expectedEvidence)
  })

  it('does not issue the next verb until the previous move reaches target and is stable idle twice', async () => {
    const expanded = expandBore()
    let idle = false
    // The first plain move is now the retract after the first fast seek.
    const workMove = vi.mocked(ctrl.jog)
    const ordinaryMove = workMove.getMockImplementation()!
    let first = true
    workMove.mockImplementation((axis, delta, feed) => {
      if (!first) return ordinaryMove(axis, delta, feed)
      first = false
      wire.push(`jog(${axis},${delta},${feed})`)
      return true
    })
    vi.mocked(ctrl.verifiedIdle).mockImplementation(() => idle)
    const calls = fakeWalls(walls)

    const pending = runProbeRoutine(expanded, rawConfig, true, expanded.hash, { envelope })
    await new Promise((resolve) => setTimeout(resolve, 125))
    expect(calls).toEqual(['probe(X,70,300)', 'jog(X,2,1200)'])

    machinePos = { x: 86.5, y: 100, z: 20 }
    idle = true
    const result = await pending
    expect(result.ok).toBe(true)
    expect(calls[2]).toBe('probe(X,82.5,40)')
  })

  it('returns the real touches, the calcs and the EVALUATED proposals - and writes nothing', async () => {
    const expanded = expandBore()
    const lines = fakeWalls(walls)
    const events: string[] = []
    const r = await runProbeRoutine(expanded, rawConfig, true, expanded.hash, {
      envelope,
      onStep: (e) => events.push(e.kind),
    })
    expect(r.ok).toBe(true)
    expect(r.touches.map((t) => [t.name, t.positionMm])).toEqual([['left', 84.5], ['right', 115.5], ['front', 84.5], ['back', 115.5]])
    expect(r.calcs.centreX).toBeCloseTo(100, 6)
    expect(r.calcs.centreY).toBeCloseTo(100, 6)
    expect(r.calcs.diameterX).toBeCloseTo(31 + 3, 6) // 115.5 - 84.5 + 2 * 1.5
    expect(r.proposals[0]).toMatchObject({ kind: 'workOffset', wcs: 'active', activeWcs: 'G54', axes: { X: 100, Y: 100 } })
    expect(r.proposals[1]).toMatchObject({ kind: 'report', items: [{ label: 'Diameter (X)', value: 34 }, { label: 'Diameter (Y)', value: 34 }] })
    expect(lines.some((l) => /G10|G92|\$#/.test(l))).toBe(false)
    expect(events.filter((k) => k === 'touch')).toHaveLength(4)
    expect(r.message).toContain('Nothing has been written')
  })

  it('a missed contact stops the run at the NAMED step with no proposal; the lock is released', async () => {
    const expanded = expandBore()
    vi.spyOn(getMachineController(), 'probe').mockImplementation(async (axis, target, feed) => {
      wire.push(`probe(${axis},${target},${feed})`)
      return { ok: false, at: null, reason: 'ALARM:4 probe fail' }
    })
    const r = await runProbeRoutine(expanded, rawConfig, true, expanded.hash, { envelope })
    expect(r.ok).toBe(false)
    expect(r.stoppedAt?.label).toBe('left')
    expect(r.message).toContain('left stopped')
    expect(r.proposals).toEqual([])
    expect(r.touches).toEqual([])
    expect(wire).toEqual(['probe(X,70,300)']) // no approach or later motion
    expect(isProbeCycleActive()).toBe(false)
  })

  it('a stale preview hash is refused before ANY line', async () => {
    const expanded = expandBore()
    const lines = fakeWalls(walls)
    const r = await runProbeRoutine(expanded, rawConfig, true, 'deadbeef', { envelope })
    expect(r.ok).toBe(false)
    expect(r.message).toBe(PROBE_ROUTINE_PREVIEW_STALE)
    expect(lines).toEqual([])
  })

  it('the path-clear tick and the E-stop latch refuse before any line', async () => {
    const expanded = expandBore()
    const lines = fakeWalls(walls)
    const unticked = await runProbeRoutine(expanded, rawConfig, false, expanded.hash, { envelope })
    expect(unticked.ok).toBe(false)
    expect(unticked.message).toContain('Confirm that the positioning path')
    vi.spyOn(getMachineController(), "emergencyStop").mockImplementation(() => undefined)
    triggerEmergencyStop()
    const latched = await runProbeRoutine(expanded, rawConfig, true, expanded.hash, { envelope })
    expect(latched.ok).toBe(false)
    expect(latched.message).toContain('software stop')
    expect(lines).toEqual([])
  })

  it('re-checks the E-stop latch after a retract and issues no fine probe or later verb', async () => {
    const expanded = expandBore()
    const calls = fakeWalls(walls)
    vi.spyOn(ctrl, 'emergencyStop').mockImplementation(() => undefined)
    let idleFrames = 0
    vi.mocked(ctrl.verifiedIdle).mockImplementation(() => {
      idleFrames++
      if (idleFrames === 2) triggerEmergencyStop()
      return true
    })

    const result = await runProbeRoutine(expanded, rawConfig, true, expanded.hash, { envelope })

    expect(result.ok).toBe(false)
    expect(result.message).toBe('The software stop is latched. Press CLEAR to reset it.')
    expect(result.stoppedAt?.label).toBe('left')
    expect(calls).toEqual([
      'probe(X,70,300)',
      'jog(X,2,1200)',
    ])
  })

  it("restores the operator's inch modal on a text controller", async () => {
    useMachineControl.setState({
      parserModal: { units: 'inch', distanceMode: 'absolute', motionMode: 'G0' },
    })
    Object.defineProperty(ctrl, 'capabilities', {
      configurable: true,
      value: { ...originalCapabilities, gcodeText: true },
    })
    const expanded = expandBore()
    const calls = fakeWalls(walls)

    const result = await runProbeRoutine(expanded, rawConfig, true, expanded.hash, { envelope })

    expect(result.ok).toBe(true)
    expect(calls.filter((line) => line.startsWith('TEXT'))).toEqual(['TEXT G20'])
  })

  it('a failed check with the REAL contacts stops the run with the check sentence (walls the wrong way round)', async () => {
    const expanded = expandBore()
    // right wall reported LEFT of the left wall -> diameterX negative -> the final check fails
    fakeWalls([[84.5, 100, 20], [80, 100, 20], [100, 84.5, 20], [100, 115.5, 20]])
    const r = await runProbeRoutine(expanded, rawConfig, true, expanded.hash, { envelope })
    expect(r.ok).toBe(false)
    expect(r.message).toContain('do not describe a positive diameter')
    expect(r.touches).toHaveLength(4)
    expect(r.proposals).toEqual([])
  })

  it('a touch-dependent move is re-evaluated with the real contact and refused when it would leave the table', async () => {
    // an edge routine whose follow-up move is relative to the contact
    const routine = {
      ...FACTORY_EDGE_X_MINUS,
      id: 'user.edge-then-jump',
      provenance: { kind: 'user' as const },
      steps: [
        ...atStartHeight(FACTORY_EDGE_X_MINUS).steps,
        { kind: 'move' as const, name: 'jump', frame: 'machine' as const, to: { x: 'touch.face.x - 5' } },
      ],
    }
    const r0 = expandProbeRoutine(routine, {}, { start: { x: 30, y: 100, z: 20 }, envelope, probe: config, tipRadiusMm: TIP })
    if (!r0.ok) throw new Error(r0.errors.map((e) => e.sentence).join('\n'))
    let pass = 0
    vi.spyOn(getMachineController(), 'probe').mockImplementation(async (axis, target, feed) => {
      wire.push(`probe(${axis},${target},${feed})`)
      pass++
      machinePos = { x: 2, y: 100, z: 20 }
      return { ok: true, at: { ...machinePos } }
    })
    const r = await runProbeRoutine(r0.expanded, rawConfig, true, r0.expanded.hash, { envelope })
    expect(r.ok).toBe(false)
    expect(r.stoppedAt?.label).toBe('jump')
    expect(r.message).toContain('outside the table')
    expect(wire.some((line) => line.includes('(-13,') || line.includes('X-3'))).toBe(false)
  })
})
