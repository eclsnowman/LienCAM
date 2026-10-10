import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  SUPPORTED_BRIDGE_PROTOCOL,
  UccncController,
  type UccncTransport,
} from '../../lib/machine/uccncController'
import type {
  BridgeCallMessage,
  BridgeMessage,
  BridgeTransportEvents,
} from '../../lib/machine/bridgeTransport'
import type {
  ControllerCapabilities,
  MachineStatus,
  QueuedMove,
  StreamerProgress,
} from '../../lib/machine/controller'

const RECORDED_RUN = 'src/tests/evidence/CHORD-AB-2026-08-26/B-chord010-r100-run01.json'

interface RecordedRun {
  moves: number
  points: Array<{ b: number }>
}

const CAPS: ControllerCapabilities = {
  geometryQueue: true,
  executingMoveId: true,
  bufferSeconds: false,
  gcodeText: false,
  perAxisHoming: false,
  ownsSpindle: false,
  spindleCommands: false,
}

class FakeTransport implements UccncTransport {
  private events: BridgeTransportEvents | null = null

  async start(events: BridgeTransportEvents): Promise<void> {
    this.events = events
  }

  send(_message: BridgeCallMessage): void {}

  async close(): Promise<void> {}

  emit(message: BridgeMessage): void {
    this.events?.onMessage(message)
  }
}

function status(bufferMoves: number | null): MachineStatus {
  return {
    state: 'run',
    subState: null,
    machinePos: { x: 0, y: 0, z: 0 },
    workPos: { x: 0, y: 0, z: 0 },
    feedMmMin: 600,
    spindleRpm: null,
    overrides: null,
    executingMoveId: null,
    buffer: { moves: bufferMoves, capacitySeconds: null },
    inputs: null,
    homed: null,
    spindle: null,
  }
}

async function controllerWithJob(
  total: number,
): Promise<{ controller: UccncController; transport: FakeTransport }> {
  const transport = new FakeTransport()
  const controller = new UccncController({})
  const connecting = controller.connect({ kind: 'messages', transport })
  transport.emit({
    t: 'hello',
    v: {
      protocol: SUPPORTED_BRIDGE_PROTOCOL,
      bridge: 'liencam-uccnc-bridge/wo1018-test',
      capabilities: CAPS,
      readOnly: false,
    },
  })
  await connecting

  // This is the status held before the new queue arrives. It must not become
  // the first sample of the newly loaded program.
  transport.emit({ t: 'status', v: status(0) })
  const moves: QueuedMove[] = Array.from({ length: total }, (_, index) => ({
    id: index + 1,
    kind: 'marker',
  }))
  expect(controller.loadMoves(moves)).toEqual({ ok: true, reason: null })
  expect(controller.startJob()).toBe(true)
  return { controller, transport }
}

function legacyProgress(total: number, reported: number | null): StreamerProgress {
  return {
    phase: total === 0 ? 'empty' : 'streaming',
    totalLines: total,
    sentLines: total,
    ackedLines: reported === null ? 0 : Math.max(0, total - reported),
    ackedSourceLine: 0,
    sentSourceLine: 0,
    bytesInFlight: 0,
  }
}

describe('WO-1018 UCCNC Stat.Puffer wrap reconstruction', () => {
  it('replays the recorded 6284-move run from zero without progress going backwards', async () => {
    const capture = JSON.parse(fs.readFileSync(RECORDED_RUN, 'utf8')) as RecordedRun
    expect(capture.moves).toBe(6284)
    const firstLoaded = capture.points.findIndex((point) => point.b > 0)
    expect(firstLoaded).toBeGreaterThan(0)
    const recorded = capture.points.slice(firstLoaded).map((point) => point.b)
    const { controller, transport } = await controllerWithJob(capture.moves)

    // No status from the new queue yet: progress starts at zero instead of
    // interpreting the previous queue's 0 as "all 6284 acknowledged".
    expect(controller.jobProgress().ackedLines).toBe(0)

    const acknowledgements: number[] = []
    for (const reported of recorded) {
      transport.emit({ t: 'status', v: status(reported) })
      expect(controller.programProgress().queuedOnController).toBe(reported)
      acknowledgements.push(controller.jobProgress().ackedLines)
    }

    expect(acknowledgements[0]).toBe(0)
    expect(acknowledgements.at(-1)).toBe(2188)
    expect(acknowledgements.every((value) => value >= 0 && value <= capture.moves)).toBe(true)
    for (let i = 1; i < acknowledgements.length; i++) {
      expect(acknowledgements[i]).toBeGreaterThanOrEqual(acknowledgements[i - 1])
    }
  })

  it('decrements the wrap count when the remainder jumps up and reaches the real final ack', async () => {
    const { controller, transport } = await controllerWithJob(6284)
    const reported = [2188, 1, 0, 4095, 4000, 1, 0]
    const acknowledgements: number[] = []

    for (const sample of reported) {
      transport.emit({ t: 'status', v: status(sample) })
      acknowledgements.push(controller.jobProgress().ackedLines)
    }

    expect(acknowledgements).toEqual([0, 2187, 2188, 2189, 2284, 6283, 6284])
    transport.emit({ t: 'jobEvent', v: { event: 'completed', fault: null } })
    expect(controller.jobProgress().ackedLines).toBe(6284)
  })

  it('is byte-identical to the old progress for totals through exactly 4096, in either raw direction', async () => {
    const controls: Array<{ total: number; reported: Array<number | null> }> = [
      { total: 0, reported: [null, 0] },
      { total: 1, reported: [1, 0, 1] },
      { total: 4095, reported: [4095, 4094, 1, 0, 1, 4095] },
      { total: 4096, reported: [4096, 4095, 1, 0, 1, 4095, 4096] },
    ]

    for (const control of controls) {
      const { controller, transport } = await controllerWithJob(control.total)
      // The controller still holds the pre-load status(0) here. This brief
      // window is part of byte identity too, not only the frames below.
      expect(controller.jobProgress()).toEqual(legacyProgress(control.total, 0))
      for (const reported of control.reported) {
        transport.emit({ t: 'status', v: status(reported) })
        expect(controller.jobProgress()).toEqual(legacyProgress(control.total, reported))
      }
    }
  })

  it('preserves a correct non-wrapping occupancy when hardware reports values above 4095', async () => {
    const total = 6284
    const { controller, transport } = await controllerWithJob(total)
    for (const reported of [6284, 6000, 4096, 4095, 1, 0]) {
      transport.emit({ t: 'status', v: status(reported) })
      expect(controller.jobProgress()).toEqual(legacyProgress(total, reported))
    }
  })
})
