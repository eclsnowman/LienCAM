// @vitest-environment jsdom

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { interpretGcodeProgram, type GcodeStage } from '../../lib/gcode/interpret'
import { buildStraightLineProgram } from '../../lib/program/buildMachineProgram'
import { buildProgramParts } from '../../lib/program/programParts'
import {
  DEFAULT_MAX_PROGRAM_MOVES,
  type ControllerCapabilities,
  type MachineStatus,
  type QueuedMove,
} from '../../lib/machine/controller'
import type {
  BridgeCallMessage,
  BridgeMessage,
  BridgeTransportEvents,
} from '../../lib/machine/bridgeTransport'
import { isStagedMove } from '../../lib/program/programCapacity'
import { createDefaultControllerDefinition, type Project } from '../../types'
import { axisSoftLimitStatementKey } from '../../lib/machine/resolvedMachineMotion'
import { makeMachine, makeTool, makeWcs } from '../post/helpers'
import { typedMock } from '../support/typedMock'

const bridgeSockets: Array<{
  emit(message: BridgeMessage): void
}> = []

vi.mock('../../lib/machine/bridgeTransport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/bridgeTransport')>()
  class EvidenceBridgeTransport extends actual.BridgeTransport {
    // Not `events`: the base class declares its own private field of that
    // name, and two separate private declarations make the subclass
    // unassignable to its base. Vitest never sees it; tsc does.
    private evidenceEvents: BridgeTransportEvents | null = null

    constructor() {
      super()
      bridgeSockets.push(this)
    }

    async start(events: BridgeTransportEvents): Promise<void> {
      this.evidenceEvents = events
      const offsets = {
        G54: { ...WORK_OFFSETS.G54 },
        G55: { ...WORK_OFFSETS.G55 },
        G56: { x: 0, y: 0, z: 0 },
        G57: { x: 0, y: 0, z: 0 },
        G58: { x: 0, y: 0, z: 0 },
        G59: { x: 0, y: 0, z: 0 },
      }
      events.onMessage({
        t: 'hello',
        v: {
          protocol: 1,
          bridge: 'wo-1339-evidence 0.0',
          capabilities: PRODUCT_CAPABILITIES,
          readOnly: false,
          workOffsets: { current: offsets, profile: offsets },
        },
      } as BridgeMessage)
    }

    send(message: BridgeCallMessage): void {
      if (message.m === 'selectWcs') {
        this.evidenceEvents?.onMessage({ t: 'reply', seq: message.seq, ok: true, v: true })
      }
      if (message.m === 'setWorkOffset') {
        const value = message.a as { x?: number; y?: number; z?: number }
        this.evidenceEvents?.onMessage({
          t: 'reply',
          seq: message.seq,
          ok: true,
          v: { ok: true, offset: { x: value.x ?? 0, y: value.y ?? 0, z: value.z ?? 0 } },
        })
      }
    }

    async close(): Promise<void> {
      this.evidenceEvents?.onClose('closed')
    }

    emit(message: BridgeMessage): void {
      this.evidenceEvents?.onMessage(message)
    }
  }
  return typedMock<typeof import('../../lib/machine/bridgeTransport')>({
    ...actual,
    BridgeTransport: EvidenceBridgeTransport,
  })
})

const FILES = [
  {
    name: 'fusion-liencnc-v2-sample.nc',
    path: 'src/tests/fixtures/foreign-gcode/fusion-liencnc-v2-sample.nc',
  },
  {
    name: 'two-setup-combined-posted.nc',
    path: 'src/tests/evidence/WO-1312/two-setup-combined-posted.nc',
  },
] as const

const WORK_OFFSETS = {
  G54: { x: 400, y: 400, z: 60 },
  G55: { x: 500, y: 400, z: 60 },
}

const PRODUCT_CAPABILITIES: ControllerCapabilities = {
  geometryQueue: true,
  executingMoveId: true,
  bufferSeconds: true,
  gcodeText: false,
  machineProgram: true,
  perAxisHoming: true,
  ownsSpindle: false,
  spindleCommands: false,
}

const {
  __resetEstopInterlockForTest,
  connectMachine,
  disconnectMachine,
  getMachineController,
  loadGcodeTextToolpathProgram,
} = await import('../../lib/machine/machineSession')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useCamStore } = await import('../../store')

let originalProject: Project
let originalToolLibrary: ReturnType<typeof useCamStore.getState>['toolLibrary']

function evidenceMachine() {
  const definition = createDefaultControllerDefinition()
  for (const axis of definition.axes) {
    axis.softLimitMin = axis.axis === 'Z' ? -150 : 0
    axis.softLimitMax = axis.axis === 'X' ? 1200 : axis.axis === 'Y' ? 900 : 150
  }
  definition.stated = definition.axes.flatMap((axis) =>
    (['min', 'max'] as const).map((end) => ({
      controller: 'uccnc' as const,
      key: axisSoftLimitStatementKey(axis.axis, end),
    })),
  )
  return makeMachine({
    id: 'wo1339-machine',
    name: 'WO-1339 evidence machine',
    travel: { x: 1200, y: 900, z: 300 },
    homeConvention: {
      x: { homesToward: 'min', machineZeroAt: 'min' },
      y: { homesToward: 'min', machineZeroAt: 'min' },
      z: { homesToward: 'min', homePositionMm: -150 },
    },
    controllerDefinition: definition,
  })
}

function idleStatus(): MachineStatus {
  return {
    state: 'idle',
    subState: null,
    machinePos: { x: 400, y: 400, z: 60 },
    workPos: { x: 0, y: 0, z: 0 },
    feedMmMin: 0,
    spindleRpm: null,
    overrides: null,
    executingMoveId: 0,
    buffer: { moves: null, capacitySeconds: null },
    inputs: null,
    homed: null,
    spindle: null,
  }
}

beforeEach(async () => {
  vi.useFakeTimers()
  bridgeSockets.length = 0
  originalProject = useCamStore.getState().project
  originalToolLibrary = useCamStore.getState().toolLibrary
  const tools = [
    makeTool({ id: 't1', toolNumber: 1, name: '6 mm flat end mill' }),
    makeTool({ id: 't2', toolNumber: 2, name: '3 mm ball nose', diameter: 3 }),
    makeTool({ id: 't19', toolNumber: 19, name: 'Sample file tool' }),
  ]
  useCamStore.setState({
    project: { ...originalProject, machine: evidenceMachine(), toolLibrary: tools },
    toolLibrary: tools,
    machineWorkOffsets: {},
  })
  const pending = connectMachine('bridge')
  await vi.advanceTimersByTimeAsync(300)
  await pending
  __resetEstopInterlockForTest()
  const socket = bridgeSockets.at(-1)
  if (!socket) throw new Error('evidence bridge did not connect')
  socket.emit({ t: 'status', v: idleStatus() } as BridgeMessage)
  socket.emit({ t: 'homed', v: { axes: ['X', 'Y', 'Z'] } } as BridgeMessage)
})

afterEach(async () => {
  if (getMachineController().connectionPhase() !== 'disconnected') {
    const pending = disconnectMachine()
    await vi.advanceTimersByTimeAsync(300)
    await pending
  }
  useCamStore.setState({
    project: originalProject,
    toolLibrary: originalToolLibrary,
    machineWorkOffsets: {},
  })
  useMachineControl.setState({ consoleLines: [] })
  vi.useRealTimers()
})

interface CuttingStretch {
  count: number
  firstLine: number
  lastLine: number
  stageFirstLine: number
}

interface FileCapacityReading {
  moves: number
  stages: number
  parts: number | null
  refusal: { stageFirstLine: number; reason: string } | null
  longest: CuttingStretch
}

// Exact operator wording from the production load door. A successful streaming
// load describes the program and does not present the controller ring as a
// program-length ceiling.
const EXPECTED = {
  'fusion-liencnc-v2-sample.nc': {
    moves: 110_615,
    // WO-2976 repin: 2fe053181c (WO-2478) gives the M9 after the M2001 macro
    // its own command-only stage, so coolant is commanded off explicitly.
    stages: 6,
    parts: 4,
    refusal: null,
    longest: { count: 104_422, firstLine: 4_908, lastLine: 109_329, stageFirstLine: 20 },
    operator: null,
  },
  'two-setup-combined-posted.nc': {
    moves: 147,
    stages: 5,
    parts: 4,
    refusal: null,
    longest: { count: 68, firstLine: 9, lastLine: 76, stageFirstLine: 3 },
    operator:
      'Program "two-setup-combined-posted.nc" loaded: 147 moves in 5 sections - G54, then G55, '
      + 'then G55, then G55, then G55 - the spindle at 18000 RPM CW, then 12000 RPM CW, which this machine '
      + 'has no link to drive - start it yourself before CYCLE START. It runs '
      + '2 tools: T1 (6 mm flat end mill), then T2 (3 mm ball nose) - it holds at each change. The '
      + 'file stops the spindle on line 81, 162 and starts it again on line 89 - the moves in between '
      + 'run with the spindle off. Read and carried by this route without changing it: G64 (path '
      + 'blending - a controller hint; this route stages the moves the file states and the board '
      + 'blends them by its own settings); G94 (feed per minute - the only feed mode this app has, '
      + 'so it changes nothing).',
  },
} as const

function readFileProgram(path: string) {
  const text = readFileSync(path, 'utf8')
  const result = interpretGcodeProgram(text, {
    dialect: 'uccnc',
    sessionWcs: 'G54',
    initialPosition: { x: 0, y: 0, z: 0 },
    machineUnits: 'mm',
    machineHome: { x: 0, y: 0, z: 0 },
    workOffsets: WORK_OFFSETS,
  })
  if (!result.ok) throw new Error(`${path}: ${result.refusal.message}`)
  return { text, program: result.program }
}

function builtStage(stage: GcodeStage, name: string) {
  const built = buildStraightLineProgram(stage.moves, makeWcs(), 5000, {
    opId: 'wo1339',
    setupId: name,
  })
  if (!built.ok) throw new Error(`${name}, line ${stage.firstLine}: ${built.reason}`)
  const steps = built.program.steps.filter(isStagedMove) as QueuedMove[]
  return {
    program: { ...built.program, steps },
    lines: stage.moveLines,
  }
}

function longestCuttingStretch(stages: readonly GcodeStage[], name: string): CuttingStretch {
  let longest: CuttingStretch = { count: 0, firstLine: 0, lastLine: 0, stageFirstLine: 0 }
  for (const stage of stages) {
    const built = builtStage(stage, name)
    let start = 0
    while (start < built.program.steps.length) {
      while (start < built.program.steps.length) {
        const step = built.program.steps[start]
        if (!(step.kind === 'line' && step.rapid === true)) break
        start += 1
      }
      let end = start
      while (end < built.program.steps.length) {
        const step = built.program.steps[end]
        if (step.kind === 'line' && step.rapid === true) break
        end += 1
      }
      if (end - start > longest.count) {
        longest = {
          count: end - start,
          firstLine: built.lines[start],
          lastLine: built.lines[end - 1],
          stageFirstLine: stage.firstLine,
        }
      }
      start = end + 1
    }
  }
  return longest
}

function capacityReading(name: string, path: string): FileCapacityReading {
    const { program } = readFileProgram(path)
    let parts = 0
    const refusals: { stageFirstLine: number; reason: string }[] = []
    for (const stage of program.stages) {
      const built = builtStage(stage, name)
      const result = buildProgramParts(built.program, DEFAULT_MAX_PROGRAM_MOVES)
      if (result.ok) parts += result.parts.length
      else refusals.push({ stageFirstLine: stage.firstLine, reason: result.reason })
    }
    return {
      moves: program.moveCount,
      stages: program.stages.length,
      parts: refusals.length === 0 ? parts : null,
      refusal: refusals[0] ?? null,
      longest: longestCuttingStretch(program.stages, name),
    }
}

function evidenceReport(
  readings: Record<(typeof FILES)[number]['name'], FileCapacityReading>,
  operator: Record<(typeof FILES)[number]['name'], string>,
): string {
  const sampleMachine = readings['fusion-liencnc-v2-sample.nc']
  const known = readings['two-setup-combined-posted.nc']
  return [
    '# WO-1339 - Can the operator press Cycle Start?',
    '',
    'Generated by `src/tests/gcode/operatorFileRuns.wo1339.test.ts` (`WRITE_EVIDENCE=1`).',
    'Both files went through `loadGcodeTextToolpathProgram`, the product load door.',
    'The quoted operator sentences are exact output from the production load door.',
    '',
    '## fusion-liencnc-v2-sample.nc',
    '',
    `- File reading: ${sampleMachine.moves.toLocaleString('en-US')} moves in ${sampleMachine.stages} sections.`,
    `- Parts: ${sampleMachine.parts}; the 110,316-move section stays whole because its cut has no stationary rapid handoff.`,
    `- Longest cutting stretch with no rapid: ${sampleMachine.longest.count.toLocaleString('en-US')} moves, lines ${sampleMachine.longest.firstLine.toLocaleString('en-US')}-${sampleMachine.longest.lastLine.toLocaleString('en-US')}. This is streamed through the bridge's 2,048-move live window.`,
    '- What LienCAM currently shows the operator (exact observed output, not endorsed):',
    '',
    `> ${operator['fusion-liencnc-v2-sample.nc']}`,
    '',
    'The operator can press Cycle Start: all 110,615 moves stage, and the longest no-rapid cutting stretch remains one continuous program.',
    '',
    '## two-setup-combined-posted.nc (known-good comparison)',
    '',
    `- File reading: ${known.moves.toLocaleString('en-US')} moves in ${known.stages} sections.`,
    `- Parts: ${known.parts} parts, one for each section.`,
    `- Longest cutting stretch with no rapid: ${known.longest.count.toLocaleString('en-US')} moves, lines ${known.longest.firstLine}-${known.longest.lastLine}. This is streamed through the bridge's 2,048-move live window.`,
    '- What LienCAM currently shows the operator (exact observed output, not endorsed):',
    '',
    `> ${operator['two-setup-combined-posted.nc']}`,
    '',
    'LienCAM stages this known-good file as 4 parts and offers Cycle Start.',
    '',
  ].join('\n')
}

describe('WO-1339: real posted files say whether Cycle Start is available', () => {
  it('pins both capacity readings and writes the operator evidence from the product load door', async () => {
    const readings = Object.fromEntries(
      FILES.map(({ name, path }) => [name, capacityReading(name, path)]),
    ) as Record<(typeof FILES)[number]['name'], FileCapacityReading>
    const { operator: _ericOperator, ...expectedSampleMachine } = EXPECTED['fusion-liencnc-v2-sample.nc']
    const { operator: _knownOperator, ...expectedKnown } = EXPECTED['two-setup-combined-posted.nc']
    expect(readings['fusion-liencnc-v2-sample.nc']).toEqual(expectedSampleMachine)
    expect(readings['two-setup-combined-posted.nc']).toEqual(expectedKnown)

    const operator = {} as Record<(typeof FILES)[number]['name'], string>
    for (const { name, path } of FILES) {
      const loaded = loadGcodeTextToolpathProgram(name, readFileSync(path, 'utf8'))
      await vi.advanceTimersByTimeAsync(20)
      const readiness = useMachineControl.getState().programReadiness
      operator[name] = readiness.reason ?? ''
      if (name === 'fusion-liencnc-v2-sample.nc') {
        expect(loaded.ok).toBe(true)
        expect(readiness.ready).toBe(true)
        expect(operator[name]).toContain('Program "fusion-liencnc-v2-sample.nc" loaded: 110615 moves')
        expect(operator[name]).not.toMatch(/4,?09[56]|board holds|board can only hold/i)
        expect(operator[name]).not.toMatch(/cannot be broken up|shorten the toolpath/i)
      } else {
        expect(operator[name]).toBe(EXPECTED[name].operator)
        expect(loaded.ok).toBe(true)
        expect(readiness.ready).toBe(true)
      }
    }

    const report = evidenceReport(readings, operator)
    const evidencePath = 'src/tests/evidence/WO-2586/operator-file-streaming.md'
    if (process.env.WRITE_EVIDENCE === '1') {
      mkdirSync('src/tests/evidence/WO-2586', { recursive: true })
      writeFileSync(evidencePath, report)
    }
    // LINE ENDINGS, NOT CONTENT. The generated report is LF; a Windows
    // checkout hands this file back as CRLF, so a byte comparison fails on a
    // machine where nothing is wrong. This is a recorded trap in this repo
    // and it put a red on main the moment WO-1081 landed. Compare the text.
    const onDisk = readFileSync(evidencePath, 'utf8').replace(/\r\n/g, '\n')
    expect(onDisk).toBe(report.replace(/\r\n/g, '\n'))
  })
})
