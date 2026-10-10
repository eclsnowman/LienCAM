import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// 2026-09-25 on machine PC. After a contact the board stays in its probe cycle
// (Stat.Probe true, running) for tens of ms. The bridge replied at the contact,
// the retract went into a board still probing and never ran (session frames
// 01:40:46.540 reply, 46.553 cycle still on, 46.588 idle). A ProbeStop after
// contact then released the rest of the probe move and drove the tool ~8.4 mm
// into Operator's setter. UCCNC 1.2115 waits `while (stat.Probe)` before reading the
// contact (Executer.cs ~10598). The REAL Machine.cs is compiled against the
// WO-1326 fake board by src/tests/evidence/SESSION-2026-09-25/probe-finish/.

const BRIDGE_DIR = resolve('pendant/uccnc-bridge')
const FAKE_BOARD_SOURCE = resolve('src/tests/evidence/WO-1326/FakeUC100.cs')
const HARNESS_SOURCE = resolve('src/tests/evidence/SESSION-2026-09-25/probe-finish/ProbeFinishHarness.cs')
const CSC = join(
  process.env.WINDIR ?? 'C:\\Windows',
  'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe',
)

function runHarness(): Map<string, string> {
  const root = mkdtempSync(join(tmpdir(), 'liencam-probe-finish-'))
  const executable = join(root, 'Harness.exe')
  try {
    execFileSync(CSC, [
      '/nologo', '/unsafe', `/out:${executable}`, '/main:LienCAM.ProbeFinishHarness',
      resolve(BRIDGE_DIR, 'Bridge.cs'), resolve(BRIDGE_DIR, 'Machine.cs'),
      resolve(BRIDGE_DIR, 'Json.cs'), resolve(BRIDGE_DIR, 'Vfd.cs'),
      FAKE_BOARD_SOURCE, HARNESS_SOURCE,
    ], { stdio: 'pipe' })
    const out = execFileSync(executable, [], { encoding: 'utf8', timeout: 120_000 })
    const rows = new Map<string, string>()
    for (const line of out.split(/\r?\n/)) {
      const m = /^([a-z0-9]+\.[A-Za-z]+)=(.*)$/.exec(line)
      if (m) rows.set(m[1], m[2])
    }
    return rows
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

let output: Map<string, string> | undefined
const row = (key: string): string | undefined => (output ??= runHarness()).get(key)

describe.skipIf(!existsSync(CSC))('a probe contact is answered only after the board leaves its probe cycle', () => {
  it('ran every scenario', () => {
    expect(row('harness.done')).toBe('True')
  }, 120_000)

  it('waits out a probe cycle that lasts past the contact, and never ProbeStops a contact', () => {
    expect(row('e.ended')).toBe('True')
    expect(row('e.repliedBeforeCycleEnd')).toBe('False')
    expect(Number(row('e.msAfterContact'))).toBeGreaterThanOrEqual(250)
    expect(row('e.ok')).toBe('True')
    expect(row('e.probeStops')).toBe('0')
  })

  it('the app\'s retract reaches a board that has left its probe cycle (the move the real board swallowed)', () => {
    expect(row('e.retractSent')).toBe('True')
    expect(row('e.retractWhileProbing')).toBe('False')
    expect(row('g.retractSent')).toBe('True')
    expect(row('g.retractWhileProbing')).toBe('False')
  })

  it('an operator Stop while the board is still in its probe cycle ends the probe: no position, no retract, no ProbeStop', () => {
    expect(row('h.ended')).toBe('True')
    expect(row('h.ok')).toBe('reply-null')
    // It DID touch - the pre-contact "stopped before it touched off" would be false.
    expect(row('h.err')).toBe(
      'the probe touched at machine Z 41.240, then was stopped from LienCAM before the controller finished '
      + 'its probe cycle; no retract was sent - jog up before the next move.',
    )
    expect(row('h.retractSent')).toBe('False')
    expect(row('h.probeStops')).toBe('0')
  })

  it('an E-STOP while the board is still in its probe cycle fails the probe: no position, no retract, no ProbeStop', () => {
    expect(row('i.ended')).toBe('True')
    expect(row('i.ok')).toBe('reply-null')
    expect(row('i.err')).toContain('at machine Z 41.240')
    expect(row('i.err')).toContain('went into alarm')
    expect(row('i.err')).toContain('Clear the alarm, then jog up.')
    expect(row('i.retractSent')).toBe('False')
    expect(row('i.probeStops')).toBe('0')
  })

  it('a feed hold while the board is still in its probe cycle fails with a sentence that names the hold', () => {
    expect(row('j.ended')).toBe('True')
    expect(Number(row('j.msAfterContact'))).toBeLessThan(7000)
    expect(row('j.ok')).toBe('reply-null')
    expect(row('j.err')).toContain('feed hold')
    expect(row('j.err')).toContain('Press Stop/Reset, then jog up.')
    expect(row('j.retractSent')).toBe('False')
    expect(row('j.probeStops')).toBe('0')
  })

  it('a cycle that never ends fails the probe with a sentence, sends no ProbeStop and no position', () => {
    expect(row('f.ended')).toBe('True')
    expect(Number(row('f.msAfterContact'))).toBeLessThan(7000)
    expect(row('f.ok')).toBe('reply-null')
    expect(row('f.err')).toContain('did not finish its probe cycle')
    expect(row('f.probeStops')).toBe('0')
  })

  it('a board already out of its cycle at the contact is answered promptly', () => {
    expect(row('g.ended')).toBe('True')
    expect(Number(row('g.msAfterContact'))).toBeLessThan(1000)
    expect(row('g.ok')).toBe('True')
    expect(row('g.probeStops')).toBe('0')
  })
})
