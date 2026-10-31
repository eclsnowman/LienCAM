import { describe, expect, it, beforeAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// The real board, 2026-10-30: with buffered motion dead, a G53 G0 X737 at X 738
// never moved and the bridge still said "program COMPLETE". A run whose moves
// needed motion and that came to rest where it started, never seen to move,
// ends FAILED and names the cause; zero-length and genuinely executed runs
// still complete. Same fake-board harness as softLimitRecovery.wo932, against
// the real sources.
const CSC = path.join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
const BRIDGE = 'pendant/uccnc-bridge'
const FAKE = 'src/tests/evidence/WO-1326'

function runSection(section: string): string {
  const root = mkdtempSync(path.join(tmpdir(), 'liencam-a32nomove-'))
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

describe.skipIf(!existsSync(CSC))('a run that never moved is not complete (the real board, 2026-10-30)', () => {
  let out = ''
  beforeAll(() => { out = runSection('falsecomplete') }, 180_000)
  const line = (name: string) => out.split(/\r?\n/).find((l) => l.slice(6).startsWith(`falsecomplete/${name}`)) ?? `MISSING falsecomplete/${name}`

  it('ends FAILED, not COMPLETE, and names the cause', () => {
    expect(line('A RUN THAT NEVER MOVED IS NOT COMPLETE')).toMatch(/^PASS/)
    expect(line('it ends FAILED')).toMatch(/^PASS/)
    expect(line('and names the cause')).toMatch(/^PASS/)
  })

  it('still completes a zero-length program and a run that moved', () => {
    expect(line('a zero-length program still completes')).toMatch(/^PASS/)
    expect(line('a run that moved still completes')).toMatch(/^PASS/)
    expect(out).toContain('ALL CHECKS PASSED')
  })
})
