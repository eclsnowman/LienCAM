// WO-1298: can GrblController be asked where the machine ended up, and does it
// answer with a number it DERIVED rather than one this test typed?
//
// WO-1297 proved the posted program MEANS the right thing by running it through
// the software simulator. That says nothing about GrblController, which is
// different code speaking a real wire protocol, and CONVENTIONS 0b forbids
// inferring one from the other. Until now the question could not even be asked:
// the only GRBL device in these tests that carries position is `FakeGrbl`, and
// before this order its status reports said MPos:0,0,0 forever.
//
// So the device here computes its own position: an accepted line enters its
// planner, executes later, and lands at "work coordinate + the offset in force
// AT THAT MOMENT". Nothing in this file writes a position into a status line.
// The controller reads them off the wire through its own parser and derivation
// (grbl/lines.ts parseStatusReport, controller.ts handleStatus), and
// `controller.status().machinePos` is what gets asserted.
//
// Both of GRBL's `$10` position modes are driven, because they exercise
// different halves of the controller:
//   - MPos: the device states machine coordinates; the controller reports them.
//   - WPos + WCO: the device states WORK coordinates and the offset separately,
//     and the controller must add them back - which is the code that can be
//     wrong about an offset, and the reason the differential below exists.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GrblController, type GrblControllerEvents } from '../../lib/machine/grbl/controller'
import type { MachineVec3 } from '../../lib/machine/types'
import { GRBL_CONFIG } from '../../lib/post/dialects/grbl'
import { GRBLHAL_CONFIG } from '../../lib/post/dialects/grblhal'
import type { PostConfig } from '../../lib/post/types'
import { FAKE_TICK_MS, FakeGrbl } from './support/fakeGrbl'
import {
  postedTwoSetupProgram,
  TWO_SETUP_CUTS,
  TWO_SETUP_MACHINE_PATH,
  TWO_SETUP_OFFSET_TABLE,
} from './support/twoSetupProgram'

// WO-2023 adds one Z-only move after the program's initial tool load. The
// combined fixture keeps the same tool across setups, so this is the only new
// position: every later XY/cut position remains the pre-WO-2023 oracle.
const Z_FIRST_TWO_SETUP_MACHINE_PATH: MachineVec3[] = [
  TWO_SETUP_MACHINE_PATH[0],
  { x: 0, y: 0, z: 5 },
  ...TWO_SETUP_MACHINE_PATH.slice(1),
]

/** Long enough that the controller's 5Hz active poll lands inside every
 *  executed block, so no position the machine passes through is missed. */
const MS_PER_BLOCK = 250

function makeEvents(): GrblControllerEvents {
  return {
    onConnection: vi.fn(),
    onStatus: vi.fn(),
    onConsole: vi.fn(),
    onAlarm: vi.fn(),
    onJobProgress: vi.fn(),
    onJobEvent: vi.fn(),
    onWelcome: vi.fn(),
  } satisfies GrblControllerEvents
}

async function connectTo(device: FakeGrbl): Promise<GrblController> {
  const ctrl = new GrblController(makeEvents())
  // The banner arrives on the device's own tick, like a real MCU resetting on
  // DTR - so time has to run for the handshake to complete.
  const connecting = ctrl.connect({ kind: 'bytes', transport: device })
  await vi.advanceTimersByTimeAsync(FAKE_TICK_MS * 3)
  await connecting
  await vi.advanceTimersByTimeAsync(FAKE_TICK_MS * 3) // the first status report
  return ctrl
}

function deviceWithOffsets(reportPosition: 'mpos' | 'wpos'): FakeGrbl {
  const device = new FakeGrbl()
  device.offsets = { ...TWO_SETUP_OFFSET_TABLE }
  device.reportPosition = reportPosition
  device.msPerBlock = MS_PER_BLOCK
  return device
}

/** One readable line naming every machine position, in order. */
function pathText(path: MachineVec3[]): string {
  return path.map((p) => `(${p.x}, ${p.y}, ${p.z})`).join(' -> ')
}

/**
 * Compare the reported machine path against the expected one. Raises its own
 * error rather than deferring to `toEqual`, because a wrong position is the
 * whole finding and vitest elides a five-element array to "…(4)" - a failure
 * that does not say WHERE the machine went is not much of a report. The
 * differential tests below read this message back.
 */
function expectMachinePath(path: MachineVec3[], expected: MachineVec3[]): void {
  const actual = pathText(path)
  const want = pathText(expected)
  if (actual !== want) {
    throw new Error(`machine path reported: ${actual}
              expected: ${want}`)
  }
}

/**
 * Stream `gcode` through the controller and record every DISTINCT machine
 * position the CONTROLLER reported, in order. The sampling reads
 * `controller.status()` only - the device is never asked where it is.
 */
async function machinePathReportedBy(
  ctrl: GrblController,
  gcode: string,
): Promise<MachineVec3[]> {
  const seen: MachineVec3[] = []
  const sample = (): void => {
    const at = ctrl.status().machinePos
    if (!at) return
    const last = seen[seen.length - 1]
    if (last && last.x === at.x && last.y === at.y && last.z === at.z) return
    seen.push({ ...at })
  }

  sample()
  expect(ctrl.loadJob(gcode).ok).toBe(true)
  expect(ctrl.startJob()).toBe(true)
  for (let elapsed = 0; elapsed < 20_000; elapsed += 25) {
    await vi.advanceTimersByTimeAsync(25)
    sample()
    if (ctrl.jobProgress().phase === 'complete' && elapsed > 1_000) break
  }
  expect(ctrl.jobProgress().phase).toBe('complete')
  // The last block is still executing when its ok arrives (an ack is a parse,
  // not a move); keep polling until the machine has stopped reporting new
  // positions, exactly as an operator watching the DRO would.
  for (let elapsed = 0; elapsed < 4_000; elapsed += 25) {
    await vi.advanceTimersByTimeAsync(25)
    sample()
  }
  return seen
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('WO-1298: GrblController reports where a two-offset program put the machine', () => {
  it.each([
    ['GRBL', 'mpos', GRBL_CONFIG],
    ['GRBL', 'wpos', GRBL_CONFIG],
    ['grblHAL', 'mpos', GRBLHAL_CONFIG],
    ['grblHAL', 'wpos', GRBLHAL_CONFIG],
  ] as const)(
    'streams the combined %s program and reports each setup cutting at its own offset (device reports %s)',
    async (_name, reportPosition, config: PostConfig) => {
      const posted = postedTwoSetupProgram(config)
      const device = deviceWithOffsets(reportPosition)
      const ctrl = await connectTo(device)

      const path = await machinePathReportedBy(ctrl, posted.gcode)

      // Every machine position the program passes through, in order - so the
      // first setup's cut is at its G54 offset and the second at its G55 one,
      // and nothing landed anywhere else on the way.
      expectMachinePath(path, Z_FIRST_TWO_SETUP_MACHINE_PATH)
      expect(path).toContainEqual(TWO_SETUP_CUTS.first)
      expect(path).toContainEqual(TWO_SETUP_CUTS.second)
      expect(path.findIndex((p) => p.x === TWO_SETUP_CUTS.second.x)).toBeGreaterThan(
        path.findIndex((p) => p.x === TWO_SETUP_CUTS.first.x),
      )

      // The double did not silently skip a word that would have moved the
      // machine somewhere it does not compute.
      expect(device.unmodelled).toEqual([])
      await ctrl.disconnect()
    },
  )

  it('exercises the controller flow control rather than bypassing it: every line was acked before the machine finished moving', async () => {
    const posted = postedTwoSetupProgram(GRBL_CONFIG)
    const device = deviceWithOffsets('mpos')
    const ctrl = await connectTo(device)

    expect(ctrl.loadJob(posted.gcode).ok).toBe(true)
    expect(ctrl.startJob()).toBe(true)
    // One block in: GRBL has acked lines it has not run yet, which is the whole
    // point of character-counting flow control. A device that acked only on
    // completion would make these two numbers equal.
    await vi.advanceTimersByTimeAsync(MS_PER_BLOCK + 50)
    const progress = ctrl.jobProgress()
    expect(progress.ackedLines).toBeGreaterThan(device.executed.length)
    expect(device.planner.length).toBeGreaterThan(0)

    await machinePathReportedByRest(ctrl)
    expect(ctrl.jobProgress().ackedLines).toBe(ctrl.jobProgress().totalLines)
    expect(device.executed.length).toBe(ctrl.jobProgress().totalLines)
    await ctrl.disconnect()
  })

  // ---- the differential: this measurement can fail, and says what went wrong ----

  it('FAILS naming the wrong machine position when the program loses its G55', async () => {
    const posted = postedTwoSetupProgram(GRBL_CONFIG)
    const broken = posted.gcode.replace(/^G55$/m, '( G55 deliberately removed )')
    expect(broken).not.toContain('G55\n')
    const device = deviceWithOffsets('mpos')
    const ctrl = await connectTo(device)

    const path = await machinePathReportedBy(ctrl, broken)

    // The second setup ran under the FIRST setup's offset, so it cut 90mm and
    // 180mm away from where the part is. The controller reported that honestly.
    expect(path).toContainEqual({ x: 50, y: 40, z: 5 })
    expect(path).not.toContainEqual(TWO_SETUP_CUTS.second)

    // ...and the passing test's assertion, run against this, fails and names it.
    let message = ''
    try {
      expectMachinePath(path, Z_FIRST_TWO_SETUP_MACHINE_PATH)
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).not.toBe('')
    expect(message).toContain('(50, 40, 5)') // where it actually went
    expect(message).toContain('(140, 220, 5)') // where the part is
    await ctrl.disconnect()
  })

  it('FAILS naming the wrong machine position when the device stops refreshing WCO after the offset changes', async () => {
    const posted = postedTwoSetupProgram(GRBL_CONFIG)
    const device = deviceWithOffsets('wpos')
    // A device that announces its WCO once and never again. The controller
    // caches WCO (controller.ts lastWco) and adds it to WPos; a stale one puts
    // the whole second setup 90/180mm out.
    device.refreshWcoOnChange = false
    const ctrl = await connectTo(device)

    const path = await machinePathReportedBy(ctrl, posted.gcode)

    expect(path).toContainEqual({ x: 50, y: 40, z: 5 })
    expect(path).not.toContainEqual(TWO_SETUP_CUTS.second)

    let message = ''
    try {
      expectMachinePath(path, Z_FIRST_TWO_SETUP_MACHINE_PATH)
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).not.toBe('')
    expect(message).toContain('(50, 40, 5)')
    expect(message).toContain('(140, 220, 5)')
    await ctrl.disconnect()
  })

  // ---- what we checked about grblHAL, so nobody has to assume it ----

  it('sends grblHAL the same bytes as GRBL: the dialect difference never reaches the wire', async () => {
    const grbl = postedTwoSetupProgram(GRBL_CONFIG)
    const hal = postedTwoSetupProgram(GRBLHAL_CONFIG)
    // The only posted difference is a "( grblHAL )" comment line...
    expect(hal.gcode).not.toBe(grbl.gcode)
    expect(hal.gcode).toContain('( grblHAL )')

    // ...and the streamer strips comments, so both devices receive one
    // identical line stream. That is why the test above covers grblHAL: it is
    // the same controller (machineChoice.backendFor maps grblhal -> grbl)
    // driving an identical program, not an assumption that they behave alike.
    const streamed = async (gcode: string): Promise<string[]> => {
      const device = deviceWithOffsets('mpos')
      const ctrl = await connectTo(device)
      expect(ctrl.loadJob(gcode).ok).toBe(true)
      expect(ctrl.startJob()).toBe(true)
      await vi.advanceTimersByTimeAsync(10_000)
      const lines = device.executed.slice()
      await ctrl.disconnect()
      return lines
    }
    expect(await streamed(hal.gcode)).toEqual(await streamed(grbl.gcode))
  })
})

/** Drive the remaining blocks of an already-started job to completion. */
async function machinePathReportedByRest(ctrl: GrblController): Promise<void> {
  for (let elapsed = 0; elapsed < 20_000 && ctrl.jobProgress().phase !== 'complete'; elapsed += 25) {
    await vi.advanceTimersByTimeAsync(25)
  }
  await vi.advanceTimersByTimeAsync(4_000)
}
