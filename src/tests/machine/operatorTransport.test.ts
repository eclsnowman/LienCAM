import { describe, expect, it } from 'vitest'
import {
  deriveOperatorTransport,
  RE_ARM_LABEL,
  type OperatorTransportInput,
} from '../../lib/machine/operatorTransport'

const BASE_JOB: OperatorTransportInput['job'] = {
  phase: 'ready',
  name: 'part.nc',
  totalLines: 10,
  sentLines: 0,
  ackedLines: 0,
  ackedSourceLine: 0,
  sentSourceLine: 0,
  startedAt: null,
  pausedAt: null,
  error: null,
  toolChanges: [],
}

function input(overrides: Partial<OperatorTransportInput> = {}): OperatorTransportInput {
  return {
    connectionPhase: 'connected',
    machineState: 'idle',
    homed: true,
    activeWcs: 'G54',
    noHomeSwitches: false,
    job: BASE_JOB,
    programReadiness: { ready: true, reason: 'Program checks passed.' },
    singleBlock: false,
    fitTrace: null,
    toolChange: null,
    programText: 'G21 G90\nG0 X0 Y0\nM30',
    ...overrides,
  }
}

describe('operatorTransport canonical CYCLE START verdict', () => {
  it('suggests a checked homing cycle only on a fresh switched connection', () => {
    expect(deriveOperatorTransport(input({
      homed: false,
      job: { ...BASE_JOB, phase: 'empty', name: null },
      programText: null,
    }))).toMatchObject({
      action: 'none',
      cycleStartEnabled: false,
      nextAction:
        'No machine datum. Before using Home All, check each axis is off its home switch; '
        + 'then home the machine before choosing a work-coordinate action.',
    })
    expect(deriveOperatorTransport(input())).toMatchObject({
      action: 'start',
      cycleStartEnabled: true,
      nextAction: 'Program checks passed. CYCLE START begins the program.',
    })
  })

  it('keeps the normal fresh-connect guidance on a switchless machine', () => {
    const state = deriveOperatorTransport(input({
      homed: false,
      noHomeSwitches: true,
      job: { ...BASE_JOB, phase: 'empty', name: null },
      programText: null,
    }))
    expect(state.nextAction).toBe('Load a checked program or prepare a material-fit trace.')
    expect(state.nextAction).not.toMatch(/home/i)
  })

  it('offers nothing until a homed fresh connection has an active work offset', () => {
    const state = deriveOperatorTransport(input({
      activeWcs: null,
      job: { ...BASE_JOB, phase: 'empty', name: null },
      programText: null,
    }))
    expect(state).toMatchObject({ action: 'none', cycleStartEnabled: false, nextAction: '' })
  })

  it('keeps a loaded program\'s specific readiness explanation when unhomed', () => {
    const state = deriveOperatorTransport(input({
      homed: false,
      programReadiness: { ready: false, reason: 'Line 4 is invalid.' },
    }))
    expect(state).toMatchObject({ action: 'none', cycleStartEnabled: false })
    expect(state.nextAction).toBe('Program is not ready: Line 4 is invalid.')
  })

  it('keeps CYCLE START enabled while saying that program checks did not establish a datum', () => {
    const state = deriveOperatorTransport(input({ homed: false }))

    expect(state).toMatchObject({ action: 'start', cycleStartEnabled: true })
    expect(state.nextAction).toBe(
      'Program checks passed; no machine datum. CYCLE START begins.',
    )
  })

  it('fails closed when program validation has not armed the job', () => {
    const state = deriveOperatorTransport(
      input({ programReadiness: { ready: false, reason: 'Line 4 is invalid.' } }),
    )
    expect(state.cycleStartEnabled).toBe(false)
    expect(state.action).toBe('none')
    expect(state.nextAction).toContain('Line 4 is invalid.')
  })

  it('uses CYCLE START for continuous programs and one block in Single Block mode', () => {
    expect(deriveOperatorTransport(input())).toMatchObject({
      action: 'start',
      cycleStartEnabled: true,
    })
    expect(deriveOperatorTransport(input({ singleBlock: true }))).toMatchObject({
      action: 'single-block',
      cycleStartEnabled: true,
    })
  })

  it('routes held programs and reviewed fit traces through the same authority', () => {
    expect(
      deriveOperatorTransport(
        input({ machineState: 'hold', job: { ...BASE_JOB, phase: 'paused' } }),
      ),
    ).toMatchObject({ action: 'resume', cycleStartEnabled: true })

    expect(
      deriveOperatorTransport(
        input({
          fitTrace: {
            step: 'confirm',
            message: 'Review.',
            bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
            lines: ['G0 X0 Y0'],
          },
        }),
      ),
    ).toMatchObject({ action: 'trace', cycleStartEnabled: true })
  })

  it('re-enables Single Block CYCLE START from Hold after the first block (BUG-377)', () => {
    const heldJob = { ...BASE_JOB, phase: 'streaming' as const, sentLines: 4, ackedLines: 4 }
    expect(
      deriveOperatorTransport(
        input({ singleBlock: true, machineState: 'hold', job: heldJob }),
      ),
    ).toMatchObject({ action: 'single-block', cycleStartEnabled: true })

    const completeJob = { ...BASE_JOB, phase: 'complete' as const, sentLines: 4, ackedLines: 4 }
    expect(
      deriveOperatorTransport(
        input({ singleBlock: true, machineState: 'hold', job: completeJob }),
      ),
    ).toMatchObject({ action: 'single-block', cycleStartEnabled: true })

    const pausedJob = { ...BASE_JOB, phase: 'paused' as const, sentLines: 4, ackedLines: 4 }
    expect(
      deriveOperatorTransport(
        input({ singleBlock: true, machineState: 'hold', job: pausedJob }),
      ),
    ).toMatchObject({ action: 'single-block', cycleStartEnabled: true })
  })

  // WO-1530 on the board, 2026-09-14: UCCNC takes the WHOLE program at load, so
  // its progress reports every line sent from the start (uccncController.ts
  // jobProgress: sentLines = jobTotal). Single Block must still start the first
  // block and continue from Hold; Idle/Hold is what says nothing is in flight.
  it('Single Block starts and continues on a controller that queues the whole program at load (UCCNC)', () => {
    const armed = { ...BASE_JOB, phase: 'ready' as const, totalLines: 6, sentLines: 6, ackedLines: 0 }
    expect(deriveOperatorTransport(input({ singleBlock: true, job: armed }))).toMatchObject({
      action: 'single-block',
      cycleStartEnabled: true,
      nextAction: 'Single Block is ON. CYCLE START executes one block.',
    })

    const betweenBlocks = { ...BASE_JOB, phase: 'streaming' as const, totalLines: 6, sentLines: 6, ackedLines: 2 }
    expect(
      deriveOperatorTransport(input({ singleBlock: true, machineState: 'hold', job: betweenBlocks })),
    ).toMatchObject({ action: 'single-block', cycleStartEnabled: true })

    // Still honest: a moving machine or a finished program offers no block.
    expect(
      deriveOperatorTransport(input({ singleBlock: true, machineState: 'run', job: betweenBlocks })),
    ).toMatchObject({ cycleStartEnabled: false })
    const finished = { ...BASE_JOB, phase: 'complete' as const, totalLines: 6, sentLines: 6, ackedLines: 6 }
    expect(
      deriveOperatorTransport(input({ singleBlock: true, machineState: 'hold', job: finished })),
    ).toMatchObject({ cycleStartEnabled: false })
  })

  it('keeps the line streamer rule: a line sent but not yet acknowledged is still in flight (GRBL)', () => {
    const inFlight = { ...BASE_JOB, phase: 'streaming' as const, totalLines: 10, sentLines: 5, ackedLines: 4 }
    expect(
      deriveOperatorTransport(input({ singleBlock: true, machineState: 'hold', job: inFlight })),
    ).toMatchObject({ cycleStartEnabled: false })
  })

  it('blocks alarms, open doors, and non-idle fresh starts', () => {
    for (const machineState of ['alarm', 'door', 'run'] as const) {
      expect(deriveOperatorTransport(input({ machineState })).cycleStartEnabled).toBe(false)
    }
  })
})

// WO-1031: a terminal sentence may only name a control the operator can see.
// The complete/failed sentences name the re-arm control because WO-082 found
// them naming a way out with no way to take it; `deriveReArm` withdraws that
// control when there is no program TEXT to re-arm, which is exactly what a
// toolpath program has. These cases pin both halves of that pair together, so
// neither can be changed alone.
describe('operatorTransport terminal states name only rendered controls', () => {
  for (const phase of ['complete', 'failed'] as const) {
    // WO-2686 (the operator, 10-08): CYCLE START itself arms a loaded program from
    // line 1 and runs it; the re-arm control is still offered beside it.
    it(`offers CYCLE START from line 1 on a ${phase} TEXT program, with the re-arm control still offered`, () => {
      const state = deriveOperatorTransport(input({ job: { ...BASE_JOB, phase } }))
      expect(state.reArm.offered).toBe(true)
      expect(state.action).toBe('arm-start')
      expect(state.cycleStartEnabled).toBe(true)
      expect(state.nextAction).toBe(`${phase === 'complete' ? 'Cycle complete.' : 'The cycle failed.'} CYCLE START runs the program from line 1.`)
      expect(state.cycleStartDetail).toBe('Arm the program from line 1 and run it.')
    })

    it(`names no control on a ${phase} TOOLPATH program, and names the reload instead`, () => {
      // A toolpath program: loaded (the job has its name) with no program text,
      // which is what machineSession.loadGeometryProgram stores.
      const state = deriveOperatorTransport(
        input({ job: { ...BASE_JOB, phase, name: 'wo1031' }, programText: null }),
      )
      expect(state.reArm.offered).toBe(false)
      expect(state.nextAction).not.toContain(RE_ARM_LABEL)
      expect(state.cycleStartDetail).not.toContain(RE_ARM_LABEL)
      expect(state.nextAction).toContain('load the toolpath again')
      expect(state.cycleStartEnabled).toBe(false)
    })

    it(`names no control on a ${phase} job with nothing loaded at all`, () => {
      const state = deriveOperatorTransport(
        input({ job: { ...BASE_JOB, phase, name: null }, programText: null }),
      )
      expect(state.reArm.offered).toBe(false)
      expect(state.nextAction).not.toContain(RE_ARM_LABEL)
      expect(state.nextAction).toContain('Load a checked program')
      expect(state.cycleStartDetail).toBe('No program is armed.')
    })
  }
})
