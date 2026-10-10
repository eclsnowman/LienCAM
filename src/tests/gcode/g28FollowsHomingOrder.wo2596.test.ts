import { writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { readGcodeProgram, type GcodeReaderOptions } from '../../lib/gcode/reader'
import { interpretGcodeProgram } from '../../lib/gcode/interpret'
import { buildStraightLineProgram } from '../../lib/program/buildMachineProgram'
import { resolveHomingOrder } from '../../lib/machine/controller'
import { UccncController, SUPPORTED_BRIDGE_PROTOCOL, type UccncTransport } from '../../lib/machine/uccncController'
import type { BridgeCallMessage, BridgeTransportEvents } from '../../lib/machine/bridgeTransport'
import { createDefaultControllerDefinition, type AxisName, type WCS } from '../../types'

const HOME = { x: 738, y: 724.5, z: 128.9 }
const OFFSET = { x: 450, y: 450, z: 60 }
const START = { x: 1, y: 2, z: 3 }
const OPTIONS: GcodeReaderOptions = {
  dialect: 'uccnc', sessionWcs: 'G55', machineUnits: 'mm',
  initialPosition: START, machineHome: HOME, workOffsets: { G55: OFFSET },
}
const FRAME: WCS = {
  id: 'gcode-text-work-frame', label: 'G55', fixtureOffset: 55,
  origin: { x: 0, y: 0, z: 0 }, xAxis: { x: 1, y: 0, z: 0 },
  yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
}

function definition(order: AxisName[]): GcodeReaderOptions['machineDefinition'] {
  const controllerDefinition = createDefaultControllerDefinition()
  controllerDefinition.homing.order = order
  return { controller: 'uccnc', controllerDefinition }
}
function read(block = 'G28', options: Partial<GcodeReaderOptions> = {}) {
  const result = readGcodeProgram(`G21 G90 G55\n${block}\nM30`, { ...OPTIONS, ...options })
  if (!result.ok) throw new Error(result.refusal.message)
  return result.program
}
function targets(block = 'G28', options: Partial<GcodeReaderOptions> = {}) {
  return read(block, options).moves.map((move) => move.machineAbsolute)
}

// Captures production UccncController serialization. This is a protocol fake,
// NOT the native SimUC100 desk kit or a hardware readback.
class WireCapture implements UccncTransport {
  events: BridgeTransportEvents | null = null
  calls: BridgeCallMessage[] = []
  async start(events: BridgeTransportEvents) {
    this.events = events
    events.onMessage({ t: 'hello', v: {
      protocol: SUPPORTED_BRIDGE_PROTOCOL, bridge: 'wo2596-protocol-fake', readOnly: false,
      capabilities: { geometryQueue: true, executingMoveId: true, bufferSeconds: true,
        gcodeText: false, perAxisHoming: true, ownsSpindle: false, spindleCommands: false, machineProgram: true },
    } })
  }
  send(message: BridgeCallMessage) {
    this.calls.push(JSON.parse(JSON.stringify(message)))
    this.events?.onMessage({ t: 'reply', seq: message.seq, ok: true, v: { ok: true, reason: null } })
  }
  async close() {}
}

describe('WO-2596 G28 home leg follows the machine homing order', () => {
  it('bare G28 raises Z alone before either horizontal axis; preview endpoints hold the other axes', () => {
    const program = read()
    expect(program.moves.map((move) => move.machineAbsolute)).toEqual([
      { z: HOME.z }, { x: HOME.x }, { y: HOME.y },
    ])
    expect(program.moves[0]).toMatchObject({ type: 'rapid', x: START.x, y: START.y, z: HOME.z - OFFSET.z })
    expect(program.moves[1]).toMatchObject({ x: HOME.x - OFFSET.x, y: START.y, z: HOME.z - OFFSET.z })
    expect(program.moves[2]).toMatchObject({ x: HOME.x - OFFSET.x, y: HOME.y - OFFSET.y, z: HOME.z - OFFSET.z })
    expect(program.moveLines).toEqual([2, 2, 2])
  })

  it('uses the shared fallback when the machine definition names no order', () => {
    expect(targets('G28', { machineDefinition: definition([]) })).toEqual(
      resolveHomingOrder(undefined).map((axis) => ({ [axis.toLowerCase()]: HOME[axis.toLowerCase() as keyof typeof HOME] })),
    )
  })

  it('follows a different machine-defined sequence', () => {
    expect(targets('G28', { machineDefinition: definition(['Y', 'Z', 'X']) })).toEqual([
      { y: HOME.y }, { z: HOME.z }, { x: HOME.x },
    ])
  })

  it('G28 G91 Z0 sends only Z home and emits no intermediate move', () => {
    expect(targets('G28 G91 Z0')).toEqual([{ z: HOME.z }])
  })

  it('G28 X0 sends its unchanged work intermediate point, then only machine X', () => {
    const program = read('G28 X0')
    expect(program.moves[0]).toMatchObject({ x: 0, y: START.y, z: START.z })
    expect(program.moves[0].machineAbsolute).toBeUndefined()
    expect(program.moves[1].machineAbsolute).toEqual({ x: HOME.x })
    expect(program.moves).toHaveLength(2)
  })

  it('preserves the incremental intermediate leg before ordered home steps', () => {
    const program = read('G28 G91 X5 Z10')
    expect(program.moves[0]).toMatchObject({ x: 6, y: 2, z: 13 })
    expect(program.moves.map((move) => move.machineAbsolute)).toEqual([undefined, { z: HOME.z }, { x: HOME.x }])
  })

  it('skips an axis already home without commanding it in another step', () => {
    expect(targets('G28', { initialPosition: { ...START, z: HOME.z - OFFSET.z } })).toEqual([
      { x: HOME.x }, { y: HOME.y },
    ])
    expect(targets('G28', { initialPosition: { x: HOME.x - OFFSET.x, y: HOME.y - OFFSET.y, z: HOME.z - OFFSET.z } })).toEqual([])
  })

  it('skips unnamed and rotary entries without adding axes missing from the definition order', () => {
    expect(targets('G28 G91 X0 Z0', { machineDefinition: definition(['A', 'Y', 'X', 'Z']) })).toEqual([
      { x: HOME.x }, { z: HOME.z },
    ])
    expect(targets('G28', { machineDefinition: definition(['Z']) })).toEqual([{ z: HOME.z }])
  })

  it('updates the rotated work equivalent after every step while holding unnamed machine axes', () => {
    const radians = Math.PI / 6
    const c = Math.cos(radians), s = Math.sin(radians)
    const program = read('G28\nG91 G0 X1', { workOffsets: { G55: { ...OFFSET, rotationDeg: 30 } } })
    const machinePoint = (point: { x: number; y: number; z: number }) => ({
      x: OFFSET.x + c * point.x - s * point.y,
      y: OFFSET.y + s * point.x + c * point.y, z: OFFSET.z + point.z,
    })
    const start = machinePoint(START)
    const [z, x, y, after] = program.moves
    expect(machinePoint(z).x).toBeCloseTo(start.x, 9)
    expect(machinePoint(z).y).toBeCloseTo(start.y, 9)
    expect(machinePoint(z).z).toBeCloseTo(HOME.z, 9)
    expect(machinePoint(x).x).toBeCloseTo(HOME.x, 9)
    expect(machinePoint(x).y).toBeCloseTo(start.y, 9)
    expect(machinePoint(y).x).toBeCloseTo(HOME.x, 9)
    expect(machinePoint(y).y).toBeCloseTo(HOME.y, 9)
    expect(after.x).toBeCloseTo(y.x + 1, 9)
    expect(after.y).toBeCloseTo(y.y, 9)
    expect(after.z).toBeCloseTo(y.z, 9)
    expect(program.moves.slice(0, 3).map((move) => move.machineAbsolute)).toEqual([{ z: HOME.z }, { x: HOME.x }, { y: HOME.y }])
  })

  it('skips a rotated machine axis already home even when both work coordinates change on the next step', () => {
    const dx = HOME.x - OFFSET.x, dy = 2
    const angle = Math.PI / 6
    const initialPosition = { x: Math.cos(angle) * dx + Math.sin(angle) * dy,
      y: -Math.sin(angle) * dx + Math.cos(angle) * dy, z: START.z }
    expect(targets('G28', { initialPosition, workOffsets: { G55: { ...OFFSET, rotationDeg: 30 } } })).toEqual([
      { z: HOME.z }, { y: HOME.y },
    ])
  })

  it('leaves G30 as machine Z followed by grouped machine X/Y regardless of homing order', () => {
    expect(targets('G30', { referencePositions: { 1: HOME }, machineDefinition: definition(['Y', 'Z', 'X']) })).toEqual([
      { z: HOME.z }, { x: HOME.x, y: HOME.y },
    ])
  })

  it('passes the real interpreter/builder output through UccncController as separate machine-absolute wire frames', async () => {
    const interpreted = interpretGcodeProgram('G21 G90 G55\nG28\nM30', OPTIONS)
    if (!interpreted.ok) throw new Error(interpreted.refusal.message)
    const built = buildStraightLineProgram(interpreted.program.stages[0].moves, FRAME, 3000, { opId: 'gcode-file', setupId: 'wo2596' })
    if (!built.ok) throw new Error(built.reason)
    const transport = new WireCapture()
    const controller = new UccncController({})
    try {
      await controller.connect({ kind: 'messages', transport })
      expect(controller.loadProgram(built.program).ok).toBe(true)
      expect(await controller.stagedLoadVerdict()).toEqual({ ok: true, reason: null })
      const call = transport.calls.find((frame) => frame.m === 'loadMoves')!
      expect(call).toBeDefined()
      const args = call.a as { moves: unknown[] }
      expect(args.moves).toEqual([
        { id: 1, kind: 'line', to: { z: HOME.z }, feedMmMin: 3000, rapid: true, machineAbsolute: true },
        { id: 2, kind: 'line', to: { x: HOME.x }, feedMmMin: 3000, rapid: true, machineAbsolute: true },
        { id: 3, kind: 'line', to: { y: HOME.y }, feedMmMin: 3000, rapid: true, machineAbsolute: true },
      ])
      if (process.env.WO2596_CAPTURE === '1') writeFileSync('src/tests/evidence/WO-2596/protocol-wire.json', JSON.stringify({
        evidence: 'Real interpreter, builder and UccncController; protocol fake, no native kit or board readback', calls: transport.calls,
      }, null, 2) + '\n')
    } finally { await controller.disconnect() }
  })
})
