import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// WO-1628. On the board 2026-09-14 a probe toward Z 70 reached Z 70 without
// touching and the bridge held the machine for the full five-minute deadline:
// the loop only ended on contact or an abort. The REAL Machine.cs is compiled
// with csc against the WO-1326 fake board and Machine.Probe is driven the way
// Bridge.cs's "probe" case drives it - a Long job on the board owner - by
// src/tests/evidence/WO-1628/ProbeHarness.cs.

const BRIDGE_DIR = resolve('pendant/uccnc-bridge')
const FAKE_BOARD_SOURCE = resolve('src/tests/evidence/WO-1326/FakeUC100.cs')
const HARNESS_SOURCE = resolve('src/tests/evidence/WO-1628/ProbeHarness.cs')
const CSC = join(
  process.env.WINDIR ?? 'C:\\Windows',
  'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe',
)

function runHarness(): Map<string, string> {
  const root = mkdtempSync(join(tmpdir(), 'liencam-wo1628-'))
  const executable = join(root, 'Harness.exe')
  try {
    execFileSync(CSC, [
      '/nologo', '/unsafe', `/out:${executable}`, '/main:LienCAM.Wo1628ProbeHarness',
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

describe.skipIf(!existsSync(CSC))('WO-1628 a probe that reaches its target without contact ends at once', () => {
  it('ran every scenario', () => {
    expect(row('harness.done')).toBe('True')
  }, 120_000)

  it('(a) comes to rest at the target with no contact -> ok:false within 2 s, machine released', () => {
    expect(row('a.ended')).toBe('True')
    expect(Number(row('a.msAfterRest'))).toBeLessThan(2000)
    expect(row('a.err')).toBe('none')
    expect(row('a.ok')).toBe('False')
    expect(row('a.at')).toBe('null')
    expect(Number(row('a.probeStops'))).toBeGreaterThanOrEqual(1)
    expect(row('a.jog')).toBe('accepted')
  })

  it('(b) contact mid-travel still returns ok:true with the touch position', () => {
    expect(row('b.ended')).toBe('True')
    expect(row('b.ok')).toBe('True')
    expect(row('b.at')).toBe('75.25')
  })

  it('(c) a slow probe still moving after 10 s is not ended', () => {
    expect(row('c.endedWhileMoving')).toBe('False')
  })

  it('a board reading idle while its counter still steps is not ended', () => {
    expect(row('c2.endedWhileCreeping')).toBe('False')
  })

  it('a probe paused under feed hold is not ended', () => {
    expect(row('c3.endedWhileHeld')).toBe('False')
  })

  it('(d) an abort from LienCAM ends it with the stopped message', () => {
    expect(row('d.ended')).toBe('True')
    expect(row('d.err')).toBe('the probe was stopped from LienCAM before it touched off.')
    expect(Number(row('d.probeStops'))).toBeGreaterThanOrEqual(1)
  })
})
