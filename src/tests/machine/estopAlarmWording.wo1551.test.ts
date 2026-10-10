import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// WO-1551. After the ON-SCREEN E-STOP the red row told the operator to
// "release" a button that does not exist. The status word cannot tell the two
// E-stops apart - both arrive as inputs.estop - but this bridge issued the
// software one itself, so it can say which one it was.
//
// The wording decision is exercised against the REAL Bridge.cs compiled with
// csc against the WO-1326 fake board, the same way cachedAxisStruct.wo1360
// does. The socket handler cannot be driven without a websocket, so the
// binding from the `emergencyStop` command to the record it sets is pinned by
// reading the two source positions the compiled decision depends on.

const BRIDGE_DIR = resolve('pendant/uccnc-bridge')
const FAKE_BOARD_SOURCE = resolve('src/tests/evidence/WO-1326/FakeUC100.cs')
const CSC = join(
  process.env.WINDIR ?? 'C:\\Windows',
  'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe',
)

function runHarness(): string[] {
  const root = mkdtempSync(join(tmpdir(), 'liencam-wo1551-'))
  const source = join(root, 'Harness.cs')
  const executable = join(root, 'Harness.exe')

  writeFileSync(source, `
using System;
namespace LienCAM {
public static class EstopAlarmHarness {
  public static void Main(string[] args) {
    bool was = false;
    Console.WriteLine("physical=" + Bridge.EstopRisingAlarmText(true, ref was));
    Console.WriteLine("repeat=" + (Bridge.EstopRisingAlarmText(true, ref was) == null));
    Console.WriteLine("cleared=" + (Bridge.EstopRisingAlarmText(false, ref was) == null));
    Bridge.NoteSoftwareEstop();
    Console.WriteLine("software=" + Bridge.EstopRisingAlarmText(true, ref was));
    Bridge.EstopRisingAlarmText(false, ref was);
    Console.WriteLine("after=" + Bridge.EstopRisingAlarmText(true, ref was));
    // WO-1564: a poll read before the stop reached the board is processed
    // after the record is set; it must not erase the record.
    Bridge.NoteSoftwareEstop();
    Console.WriteLine("inflight=" + (Bridge.EstopRisingAlarmText(false, ref was) == null));
    Console.WriteLine("inflightSoftware=" + Bridge.EstopRisingAlarmText(true, ref was));
    // WO-1564: a record no rising edge claimed within the window is dropped.
    Bridge.NoteSoftwareEstop();
    Console.WriteLine("expiryInflight=" + (Bridge.EstopRisingAlarmText(false, ref was) == null));
    System.Threading.Thread.Sleep(2300);
    Console.WriteLine("expired=" + Bridge.EstopRisingAlarmText(true, ref was));
  }
}}
`)

  try {
    execFileSync(CSC, [
      '/nologo', '/unsafe', `/out:${executable}`, '/main:LienCAM.EstopAlarmHarness',
      resolve(BRIDGE_DIR, 'Bridge.cs'), resolve(BRIDGE_DIR, 'Machine.cs'),
      resolve(BRIDGE_DIR, 'Json.cs'), resolve(BRIDGE_DIR, 'Vfd.cs'),
      FAKE_BOARD_SOURCE, source,
    ], { stdio: 'pipe' })
    return execFileSync(executable, [], { encoding: 'utf8' })
      .trim().split(/\r?\n/)
      .filter((line) => /^(physical|repeat|cleared|software|after|inflight|inflightSoftware|expiryInflight|expired)=/.test(line))
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

let output: string[] | undefined
const rows = (): string[] => (output ??= runHarness())

function row(prefix: string): string {
  return rows().find((line) => line.startsWith(prefix)) ?? ''
}

describe.skipIf(!existsSync(CSC))('WO-1551 E-STOP alarm wording', () => {
  it('names a physical E-stop as one to release', () => {
    expect(row('physical=')).toBe(
      'physical=Emergency stop is active. Release it, then re-home before moving.',
    )
  })

  it('after the on-screen stop tells him to press CLEAR, with nothing to release', () => {
    const software = row('software=')
    expect(software).toBe(
      'software=Emergency stop pressed on screen. Press CLEAR, then re-home before moving.',
    )
    expect(software).not.toContain('Release')
  })

  it('fires only on the rising edge and does not repeat an active alarm', () => {
    expect(row('repeat=')).toBe('repeat=True')
    expect(row('cleared=')).toBe('cleared=True')
  })

  it('consumes the software record, so a later physical trip keeps its own wording', () => {
    expect(row('after=')).toBe(
      'after=Emergency stop is active. Release it, then re-home before moving.',
    )
  })

  // WO-1564. The status thread may process a poll that still read no stop
  // after the record was set. It must survive that poll and word the stop
  // that follows as the on-screen one.
  it('keeps the on-screen wording across a status poll that read no stop yet', () => {
    expect(row('inflight=')).toBe('inflight=True')
    expect(row('inflightSoftware=')).toBe(
      'inflightSoftware=Emergency stop pressed on screen. Press CLEAR, then re-home before moving.',
    )
  })

  // WO-1564. A record nothing claimed inside the window is dropped, so a
  // much later physical trip is never coloured by a stale on-screen stop.
  it('drops an on-screen record no rising edge claimed within the window', () => {
    expect(row('expiryInflight=')).toBe('expiryInflight=True')
    expect(row('expired=')).toBe(
      'expired=Emergency stop is active. Release it, then re-home before moving.',
    )
  })

  it('binds the emergencyStop command to that record and the pusher to that decision', () => {
    const bridge = readFileSync(resolve(BRIDGE_DIR, 'Bridge.cs'), 'utf8')
    const dispatch = bridge.slice(
      bridge.indexOf('case "emergencyStop":'),
      bridge.indexOf('case "resetToIdle":'),
    )
    expect(dispatch).toContain('NoteSoftwareEstop()')
    expect(dispatch).toContain('machine.EmergencyStop()')

    const pusher = bridge.slice(
      bridge.indexOf('static void PushStatus('),
      bridge.indexOf('// ---- homing: axes that became homed'),
    )
    expect(pusher).toContain('EstopRisingAlarmText(estop, ref wasEstop)')
    expect(pusher).not.toContain('Release it, then re-home before moving.')
  })
})
