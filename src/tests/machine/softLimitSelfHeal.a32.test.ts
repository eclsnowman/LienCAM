import { describe, expect, it, beforeAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// Operator ruling 2026-10-30 at the real board: a soft-limit trip must heal
// itself. Only a fresh UC100 Open restored buffered motion there, so Stop/Reset
// and Unlock reopen the controller connection; the board's own homing motion is
// never taken as proof that buffered motion came back.
// Same fake-board harness as softLimitRecovery.wo932, against the real sources.
const CSC = path.join(process.env.WINDIR ?? 'C:\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
const BRIDGE = 'pendant/uccnc-bridge'
const FAKE = 'src/tests/evidence/WO-1326'

function runSection(section: string): string {
  const root = mkdtempSync(path.join(tmpdir(), 'liencam-a32heal-'))
  const exe = path.join(root, 'harness.exe')
  try {
    execFileSync(CSC, [
      '/nologo', '/unsafe', '/platform:x64', '/target:exe', '/main:LienCAM.Wo1326Harness', `/out:${exe}`,
      path.join(BRIDGE, 'Bridge.cs'), path.join(BRIDGE, 'Machine.cs'), path.join(BRIDGE, 'Json.cs'),
      path.join(BRIDGE, 'Vfd.cs'), path.join(FAKE, 'FakeUC100.cs'), path.join(FAKE, 'Harness.cs'),
    ], { stdio: 'pipe' })
    try {
      return execFileSync(exe, [section], { encoding: 'utf8' })
    } catch (error) {
      return (error as { stdout?: string }).stdout ?? ''
    }
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

describe.skipIf(!existsSync(CSC))('soft-limit trip heals itself (operator ruling 2026-10-30)', () => {
  let out = ''
  beforeAll(() => { out = runSection('selfheal') }, 180_000)
  const line = (name: string) => out.split(/\r?\n/).find((l) => l.slice(6).startsWith(`selfheal/${name}`)) ?? `MISSING selfheal/${name}`

  it('Stop/Reset reopens the controller, clears the latch on that proof, unhomes, and the next jog moves', () => {
    for (const name of [
      'the trip latches',
      'Stop/Reset REOPENS THE CONTROLLER (Close, ListDevices, Open)',
      'the latch clears on the proved reopen',
      'the operator is told it was cleared and to Home All',
      'every axis is unhomed by the reopen',
      'no TRY ONE SHORT JOG advice',
      'THE NEXT JOG MOVES',
    ]) expect(line(name)).toMatch(/^PASS/)
  })

  it('Unlock reopens the same way; never in e-stop or under a running program; homing is not proof', () => {
    for (const name of [
      'Unlock reopens the controller too',
      'and the jog after Unlock moves',
      'NOT REOPENED IN E-STOP',
      'and says why',
      'NOT REOPENED WHILE A PROGRAM RUNS',
      'HOMING MOTION DOES NOT CLEAR THE LATCH',
    ]) expect(line(name)).toMatch(/^PASS/)
    expect(out).toContain('ALL CHECKS PASSED')
  })
})
