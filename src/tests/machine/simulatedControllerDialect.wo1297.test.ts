import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SimulatedController } from '../../lib/machine/simulatedController'
import type { ControllerEvents, MachineVec3 } from '../../lib/machine/controller'
import { GRBL_CONFIG } from '../../lib/post/dialects/grbl'
import { UCCNC_CONFIG } from '../../lib/post/dialects/uccnc'
import type { PostConfig } from '../../lib/post/types'
// WO-1298 extracted this program into a shared fixture so the simulator order
// and the GrblController order send exactly the same two-offset program.
import { postedTwoSetupProgram, TWO_SETUP_OFFSETS } from './support/twoSetupProgram'

const HOME_CONVENTION = {
  x: { homesToward: 'min' as const, machineZeroAt: 'min' as const },
  y: { homesToward: 'min' as const, machineZeroAt: 'min' as const },
  z: { homesToward: 'min' as const, machineZeroAt: 'min' as const },
}

function makeEvents(overrides: Partial<ControllerEvents> = {}): ControllerEvents {
  return {
    onStatus: vi.fn(),
    onParserState: vi.fn(),
    onConnectionPhase: vi.fn(),
    onConsole: vi.fn(),
    onClose: vi.fn(),
    onReady: vi.fn(),
    onJobEvent: vi.fn(),
    onJobProgress: vi.fn(),
    onHomed: vi.fn(),
    onAlarm: vi.fn(),
    onAccessories: vi.fn(),
    onSetting: vi.fn(),
    ...overrides,
  }
}

async function connected(config: PostConfig, events: ControllerEvents = makeEvents()): Promise<SimulatedController> {
  const controller = new SimulatedController(events, {
    dialect: config,
    travelMm: { x: 500, y: 500, z: 100 },
    homeConvention: HOME_CONVENTION,
    workOffsets: TWO_SETUP_OFFSETS,
  })
  await controller.connect({ kind: 'none' })
  return controller
}

async function advanceProgram(controller: SimulatedController, durationMs: number): Promise<void> {
  for (let elapsed = 0; elapsed < durationMs; elapsed += 50) {
    if (controller.machineState() === 'hold') controller.cycleResume()
    await vi.advanceTimersByTimeAsync(50)
  }
}

async function finishProgram(controller: SimulatedController): Promise<void> {
  for (let elapsed = 0; elapsed < 30_000 && controller.jobProgress().phase !== 'complete'; elapsed += 50) {
    await advanceProgram(controller, 50)
  }
  expect(controller.jobProgress().phase).toBe('complete')
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('WO-1297: SimulatedController executes the posted dialect', () => {
  it.each([
    ['UCCNC', UCCNC_CONFIG, [{ x: 40, y: 40, z: 5 }, { x: 140, y: 220, z: 5 }]],
    ['GRBL', GRBL_CONFIG, [{ x: 40, y: 40, z: 5 }, { x: 140, y: 220, z: 5 }]],
  ] as const)('runs one combined %s program and switches machine coordinates at its G54/G55 words', async (_name, config, expected) => {
    const dialect = { ...config, options: { ...config.options, dwellMs: 10_000 } }
    const posted = postedTwoSetupProgram(dialect)
    const reached = new Map<number, MachineVec3>()
    let controller: SimulatedController
    const events = makeEvents({
      onJobProgress: (progress) => {
        if (posted.cutLines.includes(progress.ackedSourceLine ?? -1)) {
          reached.set(progress.ackedSourceLine!, { ...controller.status().machinePos! })
        }
      },
    })
    controller = await connected(dialect, events)

    expect(controller.loadJob(posted.gcode).ok).toBe(true)
    expect(controller.startJob()).toBe(true)
    await advanceProgram(controller, 5_000)
    expect(controller.jobProgress().phase).toBe('streaming')
    expect(reached.size).toBe(0)
    await finishProgram(controller)

    expect(posted.cutLines.map((line) => reached.get(line))).toEqual(expected)
  })

  it.each([
    ['UCCNC', UCCNC_CONFIG, 'G4 P2000'],
    ['GRBL', GRBL_CONFIG, 'G4 P2'],
  ])('executes a two-second %s dwell in the units declared by its post config', async (_name, config, dwell) => {
    const controller = await connected(config as PostConfig)
    expect(controller.loadJob(`${dwell}\n`).ok).toBe(true)
    expect(controller.startJob()).toBe(true)

    await vi.advanceTimersByTimeAsync(1_000)
    expect(controller.jobProgress().phase).toBe('streaming')
    await vi.advanceTimersByTimeAsync(1_100)
    expect(controller.jobProgress().phase).toBe('complete')
  })

  it('refuses GRBL $H by name instead of silently treating homing as an executed marker', async () => {
    const controller = await connected(GRBL_CONFIG)
    const outcome = controller.loadJob('$H\n')
    expect(outcome).toEqual({
      ok: false,
      reason: "Line 1: $H is GRBL's homing command, which cannot be executed inside a loaded software-simulator program.",
    })
  })
})
