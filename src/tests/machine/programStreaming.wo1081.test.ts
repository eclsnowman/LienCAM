import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { interpretGcodeProgram } from '../../lib/gcode/interpret'
import { buildStraightLineProgram } from '../../lib/program/buildMachineProgram'
import { buildProgramParts } from '../../lib/program/programParts'
import { isStagedMove } from '../../lib/program/programCapacity'
import {
  DEFAULT_MAX_PROGRAM_MOVES,
  type ControllerCapabilities,
  type MachineStatus,
  type QueuedMove,
} from '../../lib/machine/controller'
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
import { makeWcs } from '../post/helpers'
import { deriveOperatorTransport } from '../../lib/machine/operatorTransport'

const CSC = 'C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe'
const OUT = path.join(process.env.TEMP ?? '.', 'liencam-wo1081-harness')
const EXE = path.join(OUT, 'wo1081-streaming-harness.exe')
const MOVES = path.join(OUT, 'sampleMachine-file-moves.json')
const ORIGINAL_ID_BASE = 1_000_001

const CAPS: ControllerCapabilities = {
  geometryQueue: true,
  executingMoveId: true,
  bufferSeconds: false,
  gcodeText: false,
  perAxisHoming: false,
  ownsSpindle: false,
  spindleCommands: false,
  pacedMoveStreaming: true,
}

class ProgressTransport implements UccncTransport {
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

function progressStatus(executingMoveId: number | null, bufferMoves: number): MachineStatus {
  return {
    state: 'run',
    subState: null,
    machinePos: { x: 0, y: 0, z: 0 },
    workPos: { x: 0, y: 0, z: 0 },
    feedMmMin: 600,
    spindleRpm: null,
    overrides: null,
    executingMoveId,
    buffer: { moves: bufferMoves, capacitySeconds: null },
    inputs: null,
    homed: null,
    spindle: null,
  }
}

function sampleMachineMoves() {
  const text = readFileSync('src/tests/fixtures/foreign-gcode/fusion-liencnc-v2-sample.nc', 'utf8')
  const read = interpretGcodeProgram(text, {
    dialect: 'uccnc',
    sessionWcs: 'G54',
    initialPosition: { x: 0, y: 0, z: 0 },
    machineUnits: 'mm',
    machineHome: { x: 0, y: 0, z: 0 },
    workOffsets: {
      G54: { x: 400, y: 400, z: 60 },
      G55: { x: 500, y: 400, z: 60 },
    },
  })
  if (!read.ok) throw new Error(read.refusal.message)

  const moves: QueuedMove[] = []
  let longestCut = 0
  let acceptedParts = 0
  for (const stage of read.program.stages) {
    const built = buildStraightLineProgram(stage.moves, makeWcs(), 5000, {
      opId: 'wo1081',
      setupId: 'fusion-liencnc-v2-sample.nc',
    })
    if (!built.ok) throw new Error(built.reason)
    const queued = built.program.steps.filter(isStagedMove) as QueuedMove[]
    const planned = buildProgramParts({ ...built.program, steps: queued }, DEFAULT_MAX_PROGRAM_MOVES)
    if (!planned.ok) throw new Error(planned.reason)
    acceptedParts += planned.parts.length

    let stretch = 0
    for (const move of queued) {
      if (move.kind === 'line' && move.rapid === true) stretch = 0
      else {
        stretch += 1
        longestCut = Math.max(longestCut, stretch)
      }
      moves.push({ ...move, id: ORIGINAL_ID_BASE + moves.length })
    }
  }
  return { moves, moveCount: read.program.moveCount, longestCut, acceptedParts }
}

describe.skipIf(!existsSync(CSC))('WO-1081 CurrentID move streaming', () => {
  it('streams Operator-sized continuous motion through one bounded recycled-id window', () => {
    mkdirSync(OUT, { recursive: true })
    const sampleMachine = sampleMachineMoves()
    expect(sampleMachine.moveCount).toBe(110_615)
    expect(sampleMachine.moves).toHaveLength(110_615)
    expect(sampleMachine.longestCut).toBe(104_422)
    expect(sampleMachine.acceptedParts).toBe(4)
    writeFileSync(MOVES, JSON.stringify(sampleMachine.moves))

    const source = (relative: string) => path.win32.resolve(process.cwd(), relative)
    const compile = spawnSync(CSC, [
      '/nologo', '/unsafe', '/platform:x64', '/target:exe',
      '/main:LienCAM.Wo1081StreamingHarness', `/out:${EXE}`,
      source('pendant/uccnc-bridge/Bridge.cs'),
      source('pendant/uccnc-bridge/Machine.cs'),
      source('pendant/uccnc-bridge/Json.cs'),
      source('pendant/uccnc-bridge/Vfd.cs'),
      source('src/tests/evidence/WO-1326/FakeUC100.cs'),
      source('src/tests/evidence/WO-1081/StreamingHarness.cs'),
    ], { cwd: process.cwd(), encoding: 'utf8' })
    expect(compile.status, `${compile.stdout}\n${compile.stderr}`).toBe(0)

    const run = spawnSync(EXE, [MOVES], { cwd: process.cwd(), encoding: 'utf8', timeout: 45_000 })
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0)
    expect(run.stdout).toContain('every move reaches the wire - accepted=110615 expected=110615')
    expect(run.stdout).toContain('outstanding never exceeds N - peak=2048 N=2048')
    expect(run.stdout).toContain(
      'next job rejects retained CurrentID credit - submitted=2048 retired=0 retained=1024 N=2048',
    )
    expect(run.stdout).toContain(
      'next job grants first credit only after its own move is reported - before own id=2048 after own id=2049',
    )
    expect(run.stdout).toContain(
      'step then Cycle Start rejects retained CurrentID credit - submitted=2048 retired=0 retained=1024 N=2048',
    )
    expect(run.stdout).toContain(
      'two STEP presses cannot spend retained CurrentID credit - submitted=2048 retired=0 retained=2 peak=2048 N=2048',
    )
    expect(run.stdout).toContain('wire ids recycle')
    expect(run.stdout).toContain('recycled CurrentID maps to whole-program progress')
    expect(run.stdout).toContain('ALL CHECKS PASSED')
  }, 60_000)
})

describe('WO-1081 whole-program streamed progress', () => {
  it('uses the ring capacity as the same boundary as the bridge credit window', async () => {
    const transport = new ProgressTransport()
    const controller = new UccncController({})
    const connecting = controller.connect({ kind: 'messages', transport })
    transport.emit({
      t: 'hello',
      v: {
        protocol: SUPPORTED_BRIDGE_PROTOCOL,
        bridge: 'liencam-uccnc-bridge/wo1081-progress-boundary-test',
        capabilities: { ...CAPS, maxProgramMoves: DEFAULT_MAX_PROGRAM_MOVES },
        readOnly: false,
      },
    })
    await connecting

    const ringSized: QueuedMove[] = Array.from({ length: DEFAULT_MAX_PROGRAM_MOVES }, (_, ordinal) => ({
      id: ORIGINAL_ID_BASE + ordinal,
      kind: 'marker',
    }))
    expect(controller.loadMoves(ringSized)).toEqual({ ok: true, reason: null })
    expect(controller.startJob()).toBe(true)
    transport.emit({ t: 'status', v: progressStatus(ringSized[0].id, ringSized.length) })
    expect(controller.jobProgress().ackedLines).toBe(0)

    transport.emit({ t: 'jobEvent', v: { event: 'stopped', fault: null } })
    const firstPacedSize = DEFAULT_MAX_PROGRAM_MOVES + 1
    const paced: QueuedMove[] = Array.from({ length: firstPacedSize }, (_, ordinal) => ({
      id: ORIGINAL_ID_BASE + ordinal * 3,
      kind: 'marker',
    }))
    expect(controller.loadMoves(paced)).toEqual({ ok: true, reason: null })
    expect(controller.startJob()).toBe(true)
    transport.emit({ t: 'status', v: progressStatus(paced[0].id, 2048) })
    expect(controller.jobProgress().ackedLines).toBe(0)
    transport.emit({ t: 'status', v: progressStatus(paced[2048].id, 2048) })
    expect(controller.jobProgress().ackedLines).toBe(2048)

    await controller.disconnect()
  })

  // WO-1530 on the board, 2026-09-14 (build 3): a loaded, UNSTARTED 6-move job
  // reported every move acknowledged, because the empty board buffer (nothing
  // pushed until start) was read as "all drained", and the executing id (126)
  // was left over from the job before. Single Block then had no block to run.
  // This test feeds the frame the board actually sent.
  it('a loaded but unstarted job reports nothing done, so Single Block offers its first block', async () => {
    const transport = new ProgressTransport()
    const controller = new UccncController({})
    const connecting = controller.connect({ kind: 'messages', transport })
    transport.emit({
      t: 'hello',
      v: {
        protocol: SUPPORTED_BRIDGE_PROTOCOL,
        bridge: 'liencam-uccnc-bridge/wo1530-unstarted-progress-test',
        capabilities: { ...CAPS, maxProgramMoves: DEFAULT_MAX_PROGRAM_MOVES },
        readOnly: false,
      },
    })
    await connecting

    const moves: QueuedMove[] = Array.from({ length: 6 }, (_, ordinal) => ({
      id: ORIGINAL_ID_BASE + ordinal,
      kind: 'marker',
    }))
    expect(controller.loadMoves(moves)).toEqual({ ok: true, reason: null })
    controller.setSingleBlockMode(true)
    // The board's own frames at 20:06:46: idle, buffer 0, a stale executing id.
    transport.emit({ t: 'status', v: { ...progressStatus(126, 0), state: 'idle' } })

    const armed = controller.jobProgress()
    expect(armed).toMatchObject({ phase: 'ready', totalLines: 6, ackedLines: 0, ackedSourceLine: 0 })

    const job = {
      name: 'item8-singleblock-air.nc',
      startedAt: null,
      pausedAt: null,
      error: null,
      toolChanges: [],
      ...armed,
    }
    const verdict = deriveOperatorTransport({
      connectionPhase: 'connected',
      machineState: 'idle',
      homed: true,
      activeWcs: 'G54',
      noHomeSwitches: false,
      job,
      programReadiness: { ready: true, reason: 'Program checks passed.' },
      singleBlock: true,
      fitTrace: null,
      toolChange: null,
      programText: null,
    })
    expect(verdict).toMatchObject({ action: 'single-block', cycleStartEnabled: true })

    // Once the job has run to completion, every move is done and no block remains.
    expect(controller.stepJob()).toBe(true)
    transport.emit({ t: 'jobEvent', v: { event: 'completed', fault: null } })
    transport.emit({ t: 'status', v: { ...progressStatus(moves[5].id, 0), state: 'idle' } })
    expect(controller.jobProgress().ackedLines).toBe(6)

    await controller.disconnect()
  })

  it('is monotonic from 0 to 1 across at least three Puffer refills', async () => {
    const total = 110_615
    // Deliberately non-sequential ids prove progress comes from the loaded
    // whole-program ordering, not arithmetic on an id value.
    const idAt = (ordinal: number) => ORIGINAL_ID_BASE + ordinal * 3
    const moves: QueuedMove[] = Array.from({ length: total }, (_, ordinal) => ({
      id: idAt(ordinal),
      kind: 'marker',
    }))
    const transport = new ProgressTransport()
    const controller = new UccncController({})
    const connecting = controller.connect({ kind: 'messages', transport })
    transport.emit({
      t: 'hello',
      v: {
        protocol: SUPPORTED_BRIDGE_PROTOCOL,
        bridge: 'liencam-uccnc-bridge/wo1081-progress-test',
        capabilities: CAPS,
        readOnly: false,
      },
    })
    await connecting

    expect(controller.loadMoves(moves)).toEqual({ ok: true, reason: null })
    expect(controller.startJob()).toBe(true)
    expect(controller.jobProgress().ackedLines / total).toBe(0)

    const samples = [
      { ordinal: 0, puffer: 2048 },
      { ordinal: 1024, puffer: 1024 },
      { ordinal: 2047, puffer: 1 },
      { ordinal: 2048, puffer: 2048 }, // refill 1
      { ordinal: 4095, puffer: 1 },
      { ordinal: 4096, puffer: 2048 }, // refill 2
      { ordinal: 6143, puffer: 1 },
      { ordinal: 6144, puffer: 2048 }, // refill 3
      { ordinal: 80_000, puffer: 777 },
      { ordinal: total - 1, puffer: 1 },
    ]
    const progress = [0]
    for (const sample of samples) {
      transport.emit({ t: 'status', v: progressStatus(idAt(sample.ordinal), sample.puffer) })
      expect(controller.programProgress().queuedOnController).toBe(sample.puffer)
      expect(controller.jobProgress().ackedLines).toBe(sample.ordinal)
      progress.push(controller.jobProgress().ackedLines / total)
    }

    transport.emit({ t: 'jobEvent', v: { event: 'completed', fault: null } })
    progress.push(controller.jobProgress().ackedLines / total)
    expect(progress.at(-1)).toBe(1)
    for (let index = 1; index < progress.length; index++) {
      expect(progress[index]).toBeGreaterThanOrEqual(progress[index - 1])
    }

    await controller.disconnect()
  })
})
