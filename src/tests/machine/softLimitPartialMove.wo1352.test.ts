// @vitest-environment jsdom

// WO-1352: on Operator's board 2026-09-12 01:05:27Z the soft limit tripped and X
// then travelled 738.000 -> 724.500, while the console said "A move was
// refused by the controller's soft limits. Position was retained."
//
// The bridge half runs on the WO-1326 fake board against the REAL bridge
// sources (src/tests/evidence/WO-1352/Harness.cs replays the captured run).
// The app half is the alarm sentence the operator reads.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { buildContractEvents } from '../../lib/machine/machineSession'
import { useCamStore } from '../../store'
import { useMachineControl } from '../../store/machineControlStore'

const CSC = path.join(
  process.env.WINDIR ?? 'C:\\Windows',
  'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe',
)
const HAVE_CSC = existsSync(CSC)
const BRIDGE = 'pendant/uccnc-bridge'

interface HarnessRun {
  code: number
  stdout: string
}

function runHarness(): HarnessRun {
  const root = mkdtempSync(path.join(tmpdir(), 'liencam-wo1352-'))
  const exe = path.join(root, 'harness.exe')
  try {
    execFileSync(
      CSC,
      [
        '/nologo', '/unsafe', '/platform:x64', '/target:exe',
        '/main:LienCAM.Wo1352Harness', `/out:${exe}`,
        path.join(BRIDGE, 'Bridge.cs'), path.join(BRIDGE, 'Machine.cs'),
        path.join(BRIDGE, 'Json.cs'), path.join(BRIDGE, 'Vfd.cs'),
        // path.join, not a literal: csc drops the directories of a
        // forward-slash source path and then cannot find the file.
        path.join('src', 'tests', 'evidence', 'WO-1326', 'FakeUC100.cs'),
        path.join('src', 'tests', 'evidence', 'WO-1352', 'Harness.cs'),
      ],
      { stdio: 'pipe' },
    )
    try {
      return { code: 0, stdout: execFileSync(exe, ['wo1352'], { encoding: 'utf8' }) }
    } catch (error) {
      const failed = error as { status?: number; stdout?: string }
      return { code: failed.status ?? -1, stdout: failed.stdout ?? '' }
    }
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

function section(run: HarnessRun, prefix: string) {
  const lines = run.stdout.split(/\r?\n/).filter((line) => /^(PASS|FAIL) {2}/.test(line))
  const mine = lines.filter((line) => line.slice(6).startsWith(prefix))
  return {
    names: mine.map((line) => line.slice(6).split('  -  ')[0]),
    failures: mine.filter((line) => line.startsWith('FAIL')).join('\n'),
  }
}

describe.skipIf(!HAVE_CSC)('WO-1352 the 01:05:27Z trip, replayed on the fake board', () => {
  let run: HarnessRun = { code: -1, stdout: '' }

  beforeAll(() => {
    run = runHarness()
  }, 180_000)

  it('sends Operator\'s one move with every axis in its own argument', () => {
    const { names, failures } = section(run, 'crosstalk/')
    expect(failures).toBe('')
    expect(names).toContain('crosstalk/AddLinearMoveP got X 738, Y 724.5, Z 128 in their own positions')
  })

  it('names where the machine stood and the envelope the board was enforcing, and says the motion', () => {
    const { names, failures } = section(run, 'replay/')
    expect(failures).toBe('')
    expect(names).toEqual(expect.arrayContaining([
      'replay/THE LATCH SETS on the board\'s flag',
      'replay/the trip says where the machine stood',
      'replay/and names the envelope the board was really enforcing',
      'replay/and that X stood OUTSIDE it',
      'replay/the run ends FAILED, not waiting to complete',
      'replay/THE MOTION IS SAID WHILE IT HAPPENS, as an error',
      'replay/and the full distance once it stops',
      'replay/said once per rest, not once per poll',
      'replay/no completion is ever reported for the tripped run',
      'replay/Cycle Start is refused while latched, in words',
      'replay/and nothing more reached the controller',
    ]))
  })

  it('lets a program run after Unlock complete instead of ending it as tripped', () => {
    const { names, failures } = section(run, 'unlocked/')
    expect(failures).toBe('')
    expect(names).toEqual(expect.arrayContaining([
      'unlocked/Cycle Start is accepted after Unlock',
      'unlocked/the program reaches the controller',
      'unlocked/the run reports completed, not failed or stopped',
    ]))
  })

  it('claims no motion for a still trip, nor for the operator\'s own recovery, and a clean run still completes', () => {
    for (const prefix of ['still/', 'recovery/', 'clean/']) {
      const { names, failures } = section(run, prefix)
      expect(failures, prefix).toBe('')
      expect(names.length, prefix).toBeGreaterThanOrEqual(2)
    }
    expect(run.stdout).toContain('ALL CHECKS PASSED')
    expect(run.code).toBe(0)
  })
})

describe('WO-1352 the alarm sentence claims only what it knows', () => {
  beforeEach(() => {
    useCamStore.getState().newProject()
    useMachineControl.setState({ consoleLines: [], alarm: null })
  })

  it('does not tell the operator the position was retained after a soft-limit trip', () => {
    buildContractEvents().onAlarm?.(
      null,
      'The controller\'s soft limit tripped - the console says where the machine stood and whether it moved.',
      false,
    )
    const text = useMachineControl.getState().consoleLines.at(-1)?.text ?? ''
    expect(text).toContain('soft limit tripped')
    expect(text).not.toMatch(/retained/i)
    expect(text).toContain('the position readout shows where the machine is now')
  })

  it('still tells the operator to re-home when the position may be lost', () => {
    buildContractEvents().onAlarm?.(null, 'A hard limit switch was hit.', true)
    expect(useMachineControl.getState().consoleLines.at(-1)?.text)
      .toContain('Machine position may be lost - home again before moving.')
  })
})
