// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createElement } from 'react'
import { JogPanel } from '../../components/machine/JogPanel'
import type { MachineStatus } from '../../lib/machine/controller'
import {
  __resetEstopInterlockForTest,
  buildContractEvents,
  getMachineController,
} from '../../lib/machine/machineSession'
import { useCamStore } from '../../store'
import { useMachineControl } from '../../store/machineControlStore'

function statusFrame(softLimitLatched: boolean): MachineStatus {
  return {
    state: 'idle',
    subState: null,
    machinePos: { x: 0, y: 0, z: 0 },
    workPos: { x: 0, y: 0, z: 0 },
    feedMmMin: 0,
    spindleRpm: null,
    overrides: { feed: 100, rapid: null, spindle: 100 },
    executingMoveId: null,
    buffer: { moves: 0, capacitySeconds: 1 },
    inputs: {
      estop: false,
      hardLimit: false,
      softLimit: false,
      probe: false,
      limits: null,
      door: null,
      hold: false,
    },
    homed: { X: true, Y: true, Z: true },
    spindle: null,
    softLimitLatched,
  } as MachineStatus
}

describe('WO-932 soft-limit recovery', () => {
  beforeEach(() => {
    useCamStore.getState().newProject()
    buildContractEvents().onStatus?.(statusFrame(false))
    // Operator 2026-09-14 ("A: Flash, all motion off"): this suite is about the
    // soft-limit latch's own Unlock reachability, not the fresh-connect
    // E-STOP latch.
    __resetEstopInterlockForTest()
    useMachineControl.setState({
      connectionPhase: 'connected',
      connectionKind: 'bridge',
      machineState: 'idle',
      homed: true,
      alarm: null,
      consoleLines: [],
    })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('keeps Unlock reachable while the bridge latch remains true in idle', () => {
    const unlock = vi.spyOn(getMachineController(), 'unlock').mockReturnValue(true)
    render(createElement(JogPanel))
    const button = screen.getByTestId('control-unlock') as HTMLButtonElement

    expect(button.disabled).toBe(true)
    act(() => {
      buildContractEvents().onStatus?.(statusFrame(true))
      useMachineControl.setState({ homed: true })
    })
    expect(button.disabled).toBe(false)
    fireEvent.click(button)
    expect(unlock).toHaveBeenCalledTimes(1)

    act(() => {
      buildContractEvents().onStatus?.(statusFrame(false))
      useMachineControl.setState({ homed: true })
    })
    expect(button.disabled).toBe(true)
  })

  it('pins the two readback reset cycles and condition-specific safety handling', () => {
    const source = readFileSync('pendant/uccnc-bridge/Machine.cs', 'utf8')
    const bridgeSource = readFileSync('pendant/uccnc-bridge/Bridge.cs', 'utf8')
    const resetStart = source.indexOf('bool RunSoftLimitResetCycle(out string err)')
    const resetEnd = source.indexOf('// ---- WO-933:', resetStart)
    const resetCycle = source.slice(resetStart, resetEnd)
    expect(resetStart).toBeGreaterThan(0)
    expect(resetEnd).toBeGreaterThan(resetStart)
    expect(resetCycle).toContain('beforeRc == (int)UC100.ReturnVal.UC100_ESTOP || before.Estop')
    expect(resetCycle).toContain('bool hardLimitOverrideActive = before.HardLimit')
    expect(resetCycle).toContain('beforeRc == (int)UC100.ReturnVal.UC100_LIMIT')
    expect(resetCycle).toContain('if (hardLimitOverrideActive)')
    expect(resetCycle).toContain('lock (io.Api) overrideRc = UC100.LimitOverRide()')
    expect(resetCycle).toContain('if (readback.HardLimit && !hardLimitOverrideActive)')
    expect(resetCycle).toContain('for (int pass = 1; pass <= 2; pass++)')
    expect(resetCycle).toContain('lock (io.Api) stopRc = UC100.Stop()')
    expect(resetCycle).toContain('BoardOwner.Pump(250)')
    expect(resetCycle).toContain('if (BoardOwner.AbortRequested)')
    expect(resetCycle).toContain('lock (io.Api) statusRc = UC100.GetStatus(ref readback)')
    expect(resetCycle).not.toContain('Thread.Sleep')
    expect(resetCycle.indexOf('if (hardLimitOverrideActive)')).toBeLessThan(
      resetCycle.indexOf('UC100.LimitOverRide()'),
    )
    expect(bridgeSource).toMatch(
      /case "unlock":\s+PostCall\(ws, seq, BoardOwner\.Class\.Long, "unlock"/,
    )

    const unlockStart = source.indexOf('public bool Unlock(out string err)')
    const unlockEnd = source.indexOf('public bool ResetToIdle', unlockStart)
    const unlock = source.slice(unlockStart, unlockEnd)
    expect(unlockStart).toBeGreaterThan(0)
    expect(unlockEnd).toBeGreaterThan(unlockStart)
    expect(unlock).toContain('if (softLimitLatched)')
    expect(unlock).toContain('if (!RunSoftLimitResetCycle(out err)) return false')
    expect(unlock).toContain('AttemptSoftLimitRecovery("Unlock")')
  })
})

// WO-1332: THE SAME LATCH, REACHED THE OTHER WAY.
//
// On Operator's machine, parked at X 738 (the soft maximum), jog X+10 was accepted
// (rc=0) and moved 0.000 mm. A move clamped to ZERO length leaves no truncation
// for WO-934 to notice, so WO-932's latch never set, Unlock stayed greyed out,
// and every later move - including the legal one away from the limit - was
// swallowed through Stop/Reset and three full Home All cycles. Only a bridge
// restart brought motion back.
//
// The demo board has no soft limit to sit on, so the clamp cannot be asked for
// on any hardware this project can reach. It is scripted on the WO-1326 fake
// board instead. This test COMPILES AND RUNS that harness against the working
// tree's Bridge.cs / Machine.cs / Json.cs / Vfd.cs and reads the run it just
// produced - so what passes here is what the shipping bridge does today, and
// removing the fix turns these red. The committed recordings under
// src/tests/evidence/WO-1332/ are the before/after evidence, not the gate.
//
// By hand, the whole sweep instead of the three WO-1332 sections:
//
//   powershell> & src\tests\evidence\WO-1326\build.ps1
//   powershell> & "$env:TEMP\liencam-wo1326-harness\wo1326-harness.exe"

// The harness is C# and builds with the Windows .NET Framework compiler. On the
// Spark (Linux) there is no csc.exe, so it is skipped there rather than reported
// as a red the remote gate cannot act on (the WO-1306 precedent).
const CSC = path.join(
  process.env.WINDIR ?? 'C:\Windows',
  'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe',
)
const HAVE_CSC = existsSync(CSC)

const BRIDGE = 'pendant/uccnc-bridge'
const FAKE = 'src/tests/evidence/WO-1326'

interface HarnessRun {
  code: number
  stdout: string
}

/** Compile the fake-board harness against the REAL bridge sources and run the
 *  named sections. Same compiler flags as src/tests/evidence/WO-1326/build.ps1,
 *  into a temp directory of its own so a lane running this never collides with
 *  a hand build or another lane. */
function runFakeBoard(sections: string[]): HarnessRun {
  const root = mkdtempSync(path.join(tmpdir(), 'liencam-wo1332-'))
  const exe = path.join(root, 'harness.exe')
  try {
    execFileSync(
      CSC,
      [
        '/nologo', '/unsafe', '/platform:x64', '/target:exe',
        '/main:LienCAM.Wo1326Harness', `/out:${exe}`,
        path.join(BRIDGE, 'Bridge.cs'), path.join(BRIDGE, 'Machine.cs'),
        path.join(BRIDGE, 'Json.cs'), path.join(BRIDGE, 'Vfd.cs'),
        path.join(FAKE, 'FakeUC100.cs'), path.join(FAKE, 'Harness.cs'),
      ],
      { stdio: 'pipe' },
    )
    try {
      return { code: 0, stdout: execFileSync(exe, sections, { encoding: 'utf8' }) }
    } catch (error) {
      const failed = error as { status?: number; stdout?: string }
      return { code: failed.status ?? -1, stdout: failed.stdout ?? '' }
    }
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

function checks(run: string, prefix: string) {
  return run
    .split(/\r?\n/)
    .filter((line) => /^(PASS|FAIL) {2}/.test(line) && line.slice(6).startsWith(prefix))
    .map((line) => ({ ok: line.startsWith('PASS'), name: line.slice(6).split('  -  ')[0] }))
}

function failureDetail(run: string, prefix: string) {
  return run
    .split(/\r?\n/)
    .filter((line) => line.startsWith('FAIL  ') && line.slice(6).startsWith(prefix))
    .join('\n')
}

describe.skipIf(!HAVE_CSC)('WO-1332 a move clamped to zero at the limit', () => {
  let run: HarnessRun = { code: -1, stdout: '' }

  beforeAll(() => {
    run = runFakeBoard(['wo1332'])
  }, 180_000)

  it('latches, offers Unlock and clears on measured motion, on the fake board', () => {
    const section = checks(run.stdout, 'zerolength/')
    expect(section.length).toBeGreaterThanOrEqual(17)
    expect(failureDetail(run.stdout, 'zerolength/')).toBe('')
    const names = section.map((c) => c.name)
    expect(names).toContain('zerolength/THE LATCH SETS')
    expect(names).toContain('zerolength/and says the same sentence a truncated trip says')
    expect(names).toContain(
      'zerolength/the legal move away from the limit is refused in words, not swallowed',
    )
    expect(names).toContain('zerolength/the latch STAYS SET until the machine is seen to move')
    expect(names).toContain('zerolength/THE LATCH CLEARS ON THAT MOTION')
    expect(names).toContain('zerolength/a later legal move runs')
  })

  // THE OTHER FORM OF THE SAME CLAMP. The axis is NOT standing on the limit -
  // it is at X 100 - and the jog asks to end EXACTLY ON 738, the soft maximum.
  // The board clamps that to zero length just as it clamps a move asking to go
  // past the limit, so it must reach the same latch, the same sentence and the
  // same way out. Attempt 1 latched only the "already standing on it" form and
  // left this one falling through to WO-933's non-limit sentence.
  it('latches when the endpoint LANDS ON a limit, not only when it passes one', () => {
    const section = checks(run.stdout, 'endpointatlimit/')
    expect(section.length).toBeGreaterThanOrEqual(15)
    expect(failureDetail(run.stdout, 'endpointatlimit/')).toBe('')
    const names = section.map((c) => c.name)
    expect(names).toContain(
      'endpointatlimit/THE LATCH SETS - the axis need not already be standing on the limit',
    )
    expect(names).toContain('endpointatlimit/and says the same sentence a truncated trip says')
    expect(names).toContain('endpointatlimit/and says which limit and why')
    expect(names).toContain(
      'endpointatlimit/the legal move away from the limit is refused in words, not swallowed',
    )
    expect(names).toContain('endpointatlimit/Unlock is offered and runs the same recovery sequence')
    expect(names).toContain(
      'endpointatlimit/the latch STAYS SET until the machine is seen to move',
    )
    expect(names).toContain('endpointatlimit/THE LATCH CLEARS ON THAT MOTION')
    expect(names).toContain('endpointatlimit/a later legal move runs')
    expect(names).toContain('endpointatlimit/the negative side latches the same way')
  })

  it('leaves the accepted-and-not-made case that is not a limit exactly as it was', () => {
    const control = checks(run.stdout, 'notthelimit/')
    expect(control.length).toBeGreaterThanOrEqual(5)
    expect(failureDetail(run.stdout, 'notthelimit/')).toBe('')
  })

  it('keeps one latch with one sentence, however it is reached', () => {
    const both = checks(run.stdout, 'twowaysin/')
    expect(both.length).toBeGreaterThanOrEqual(3)
    expect(failureDetail(run.stdout, 'twowaysin/')).toBe('')
  })

  it('ran the bridge that is in the working tree, and the run itself passed', () => {
    expect(run.stdout).toContain('WO-1326 fake-board harness')
    expect(run.stdout).toContain('sections requested: wo1332')
    expect(run.stdout.trimEnd().endsWith('ALL CHECKS PASSED')).toBe(true)
    expect(run.code).toBe(0)
  })
})

// The before/after recordings are the order's Tier 2 evidence: this asserts the
// `main` column still shows the defect the fix removes, so the evidence cannot
// rot unnoticed. It is a reading of a frozen transcript and deliberately not the
// regression gate - the executing suite above is.
describe('WO-1332 the recorded main column', () => {
  it('is a defect the same harness measured on main', () => {
    const before = readFileSync(
      'src/tests/evidence/WO-1332/before-unmodified-machine.txt',
      'utf8',
    )
    const failed = checks(before, 'zerolength/')
      .filter((c) => !c.ok)
      .map((c) => c.name)
    expect(failed).toContain('zerolength/THE LATCH SETS')
    expect(failed).toContain(
      'zerolength/the legal move away from the limit is refused in words, not swallowed',
    )
    expect(failed).toContain('zerolength/the latch STAYS SET until the machine is seen to move')
  })
})
