// WO-1556: the bridge prints "[bridge] gantry skew cleared ..." only when it
// was actually holding a measurement.
//
// The re-scope (architect, 2026-09-15): `src/` now sends the connect-time
// `applySkew {offsetMm: null}` unconditionally, on purpose - a bridge process
// outlives an app reload, so the app cannot skip a clear on the strength of
// its own session memory without risking a stale skew left on the board. That
// makes "clear a measurement that was never set" a routine call, not
// something worth a console line. The bridge is the one place that actually
// knows whether `gantrySkewSet` was true before the call, so this drives the
// REAL `Machine.SetGantrySkew` (compiled with csc, the same way
// compAccelFloor.wo1348 drives `Machine.ApplyCachedStartupSettings`) and pins
// that line to only the case where something real was cleared.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const BRIDGE_DIR = resolve('pendant/uccnc-bridge')
const FAKE_BOARD_SOURCE = resolve('src/tests/evidence/WO-1326/FakeUC100.cs')
const CSC = join(
  process.env.WINDIR ?? 'C:\\Windows',
  'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe',
)

function runHarness(): string[] {
  const root = mkdtempSync(join(tmpdir(), 'liencam-wo1556-'))
  const harness = join(root, 'Harness.cs')
  const executable = join(root, 'Harness.exe')

  writeFileSync(harness, `
using System;
using System.Linq;
namespace LienCAM {
public static class SkewClearHarness {
  static void RunCase(string label, bool holdFirst, bool present, double offsetMm) {
    var machine = new Machine();
    string err;
    if (holdFirst) machine.SetGantrySkew(true, 0.12, out err);
    bool ok = machine.SetGantrySkew(present, offsetMm, out err);
    var cleared = machine.OpenReport()
      .Where(l => l.Text.IndexOf("gantry skew cleared", StringComparison.Ordinal) >= 0)
      .ToArray();
    var stored = machine.OpenReport()
      .Where(l => l.Text.IndexOf("gantry skew stored", StringComparison.Ordinal) >= 0)
      .ToArray();
    Console.WriteLine(label + "|ok=" + ok + "|cleared=" + cleared.Length + "|stored=" + stored.Length);
    foreach (var line in cleared) Console.WriteLine(label + "|clearedText|" + line.Text);
    foreach (var line in stored) Console.WriteLine(label + "|storedText|" + line.Text);
  }

  public static void Main(string[] args) {
    // Never held anything, then asked to clear: silent.
    RunCase("neverHeld", false, false, 0);
    // Held a measurement, then cleared: exactly one line, worded as today.
    RunCase("heldThenCleared", true, false, 0);
    // Cleared twice in a row: the second clear finds nothing held either.
    var machine = new Machine();
    string err;
    machine.SetGantrySkew(true, 0.12, out err);
    machine.SetGantrySkew(false, 0, out err);
    bool ok2 = machine.SetGantrySkew(false, 0, out err);
    var cleared2 = machine.OpenReport()
      .Where(l => l.Text.IndexOf("gantry skew cleared", StringComparison.Ordinal) >= 0)
      .ToArray();
    Console.WriteLine("clearedTwice|ok=" + ok2 + "|cleared=" + cleared2.Length);
    // A stored measurement still reports exactly as before.
    RunCase("stored", false, true, 0.12);
  }
}}
`)

  try {
    try {
      execFileSync(CSC, [
        '/nologo', '/unsafe', `/out:${executable}`, '/main:LienCAM.SkewClearHarness',
        resolve(BRIDGE_DIR, 'Bridge.cs'), resolve(BRIDGE_DIR, 'Machine.cs'),
        resolve(BRIDGE_DIR, 'Json.cs'), resolve(BRIDGE_DIR, 'Vfd.cs'),
        FAKE_BOARD_SOURCE, harness,
      ], { stdio: 'pipe' })
    } catch (error) {
      const compile = error as { stdout?: Buffer, stderr?: Buffer }
      throw new Error(`${compile.stdout?.toString() ?? ''}${compile.stderr?.toString() ?? ''}`)
    }
    try {
      return execFileSync(executable, [], { encoding: 'utf8' }).trim().split(/\r?\n/).filter(Boolean)
    } catch (error) {
      const run = error as { stdout?: Buffer | string, stderr?: Buffer | string }
      throw new Error(`${run.stdout?.toString() ?? ''}${run.stderr?.toString() ?? ''}`)
    }
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

let harnessOutput: string[] | undefined
function rows(label: string): string[] {
  harnessOutput ??= runHarness()
  return harnessOutput.filter((line) => line.startsWith(`${label}|`))
}

describe.skipIf(!existsSync(CSC))('WO-1556 the bridge reports a skew clear only when it held one', () => {
  it('says nothing when asked to clear a skew that was never set', () => {
    expect(rows('neverHeld')[0]).toBe('neverHeld|ok=True|cleared=0|stored=0')
  })

  it('prints exactly one line, worded as today, when a real measurement is cleared', () => {
    const actual = rows('heldThenCleared')
    expect(actual[0]).toBe('heldThenCleared|ok=True|cleared=1|stored=1')
    expect(actual).toContain(
      'heldThenCleared|clearedText|[bridge] gantry skew cleared - homing runs exactly as it did before '
        + 'any measurement was stored.',
    )
  })

  it('the second of two clears in a row does not print a second line', () => {
    // One real clear (held -> cleared) prints; the immediately following
    // clear finds nothing held and adds nothing more to the accumulated
    // report, so the total stays at one line, not two.
    expect(rows('clearedTwice')[0]).toBe('clearedTwice|ok=True|cleared=1')
  })

  it('a stored measurement still reports exactly as before', () => {
    const actual = rows('stored')
    expect(actual[0]).toBe('stored|ok=True|cleared=0|stored=1')
    expect(actual).toContain(
      'stored|storedText|[bridge] gantry skew stored: 0.120 mm. It is applied ONCE, after the homing '
        + 'cycle, to the slaved axis - nothing else in the machine changes.',
    )
  })
})
