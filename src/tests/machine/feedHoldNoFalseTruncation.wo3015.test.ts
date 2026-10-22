// WO-3015 - FEED HOLD NO LONGER MAKES THE BRIDGE BLAME A SOFT LIMIT.
//
// the operator's board 10-03 (held park, then Cycle Start) and three desk runs 10-20:
// Feed Hold mid-move, and about half a second later the bridge printed THE
// MOVE WAS TRUNCATED ... The usual cause is a SOFT LIMIT. The move was only
// held. Machine.cs CheckMoveWatch took the counter sitting still under the
// hold for a move that had settled. Wording only - no motion or stop changes:
//  - during a hold the watch says nothing and stays armed;
//  - after Cycle Resume it watches the move as usual (a real clamp still gets
//    WO-934's line, judged by the whole distance);
//  - a Stop/Reset that ends a held move is named as what ended it (WO-2533's
//    THE MOVE STOPPED SHORT), however long the hold had kept it still.
//
// The REAL bridge built against the native kit's simulated board, driven by
// src/tests/evidence/WO-3015/bridge-cases.mjs in a plain Node process (the
// WO-2533 harness). Each case returns the bridge's own console frames, and the
// ones it sent while the move was held.

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import type { MachineVec3 } from '../../lib/machine/types'

const CSC = join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
const DRIVER = resolve('src/tests/evidence/WO-3015/bridge-cases.mjs')
const canBuild = process.platform === 'win32' && existsSync(CSC)

const TRUNCATED_LINE = '[bridge] THE MOVE WAS TRUNCATED AND IT REPORTED SUCCESS. a jog of 10 mm on Z at {feed} mm/min asked for 10 mm '
  + 'and the machine moved 3 mm - short by 7 mm. The usual cause is a SOFT LIMIT clamping the move instead of '
  + 'refusing it: the controller does exactly as much as it is allowed and reports ok. Measured 2026-08-23 on '
  + 'this machine, a 1 mm jog produced 0.1 mm and reported success. Do not read the earlier success as the full '
  + 'distance having happened.'

interface BridgeCase {
  console: Array<{ text: string; severity: string }>
  simBoard: string[]
  finalMachinePos: MachineVec3
  fromZ?: number
  sawHold?: boolean
  stateAtRelease?: string | null
  heldAt?: MachineVec3
  heldEndAt?: MachineVec3
  heldConsole?: Array<{ text: string; severity: string }>
  heldWatchLines: string[]
}

/** Built once per run, from this checkout's bridge sources. Asynchronous: a
 *  case runs for seconds, and a blocked worker misses vitest's own calls. */
let built = false
async function driver(which: string): Promise<BridgeCase> {
  if (which !== 'build' && !built) await driver('build')
  if (which === 'build') built = true
  const { stdout } = await promisify(execFile)(process.execPath, [DRIVER, which], { encoding: 'utf8', timeout: 240_000 })
  return JSON.parse(stdout.trim().split(/\r?\n/).at(-1)!) as BridgeCase
}

const text = (run: BridgeCase) => run.console.map((l) => l.text).join('\n')

/** The hold really held: the board said "hold" and the counter sat still for
 *  the whole 2 s - four times the watch's 0.5 s settle. */
function expectHeldStill(run: BridgeCase): void {
  expect(run.sawHold).toBe(true)
  expect(run.stateAtRelease).toBe('hold')
  expect(run.heldEndAt!.z).toBeCloseTo(run.heldAt!.z, 4)
  expect(run.heldAt!.z).toBeGreaterThan(run.fromZ!)
}

describe('WO-3015: the real bridge on the simulated board - a held move is not a soft limit', () => {
  it.skipIf(!canBuild)('builds the bridge with csc against the simulated board', async () => {
    expect(await driver('build')).toMatchObject({ built: expect.stringContaining('liencam-wo3015-kit') })
  }, 240_000)

  it.skipIf(!canBuild)('Feed Hold mid-jog, then Cycle Resume: nothing said during the hold, the jog completes, nothing said after', async () => {
    const run = await driver('held-resume')
    expectHeldStill(run)
    // The intended assertion: no soft-limit (or any shortfall) line while held.
    expect(run.heldWatchLines, run.heldWatchLines.join('\n')).toEqual([])
    expect(run.finalMachinePos.z).toBeCloseTo(run.fromZ! + 20, 2)
    expect(text(run), text(run)).not.toMatch(/TRUNCATED|SOFT LIMIT|STOPPED SHORT|DID NOT MAKE IT/)
  }, 240_000)

  it.skipIf(!canBuild)('Feed Hold mid-jog, then Stop/Reset: nothing said during the hold, then THE MOVE STOPPED SHORT naming Stop/Reset', async () => {
    const run = await driver('held-reset')
    expectHeldStill(run)
    expect(run.heldWatchLines, run.heldWatchLines.join('\n')).toEqual([])
    const said = text(run)
    expect(said, said).not.toMatch(/SOFT LIMIT|TRUNCATED|probe/i)
    expect(run.console, said).toHaveLength(1)
    expect(run.console[0].text).toMatch(
      /^\[bridge\] THE MOVE STOPPED SHORT\. a jog of 20 mm on Z at 300 mm\/min asked for 20\.00 mm and the machine moved \d+\.\d\d mm\. Stop\/Reset ended it\.$/,
    )
    expect(run.console[0].severity).toBe('info')
    // It stopped where the hold had it.
    expect(run.finalMachinePos.z).toBeCloseTo(run.heldEndAt!.z, 3)
  }, 240_000)

  it.skipIf(!canBuild)('a clamped jog held part way and resumed: silent while held, WO-934\'s line once it ends short', async () => {
    const run = await driver('held-clamped')
    expectHeldStill(run)
    expect(run.heldWatchLines, run.heldWatchLines.join('\n')).toEqual([])
    expect(run.simBoard.join('\n')).toMatch(/CLAMPED relative jog to 3\.000/)
    expect(run.console).toEqual([{ text: TRUNCATED_LINE.replace('{feed}', '300'), severity: 'warn' }])
  }, 240_000)

  it.skipIf(!canBuild)('control: a jog clamped with no hold keeps the existing truncation line, word for word', async () => {
    const run = await driver('clamped')
    expect(run.simBoard.join('\n')).toMatch(/CLAMPED relative jog to 3\.000/)
    expect(run.console).toEqual([{ text: TRUNCATED_LINE.replace('{feed}', '600'), severity: 'warn' }])
  }, 240_000)
})
