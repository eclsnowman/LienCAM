import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// WO-1632. On the board 2026-09-14 `inputs.probe` was st.Probe - the
// controller's probe-CYCLE flag - so it went true with the tool 70 mm in the
// air and touching the setter by hand never moved it. The REAL Machine.cs is
// compiled with csc against the WO-1326 fake board; the fake board scripts the
// raw input word (bit = UC pin - 1) and the cycle flag independently, and
// Machine.Status() is read the way Bridge.cs's status pusher reads it.

const BRIDGE_DIR = resolve('pendant/uccnc-bridge')
const FAKE_BOARD_SOURCE = resolve('src/tests/evidence/WO-1326/FakeUC100.cs')
const CSC = join(
  process.env.WINDIR ?? 'C:\\Windows',
  'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe',
)

const HARNESS = `
using System;
using System.Reflection;
namespace LienCAM {
public static class Wo1632ProbeInputHarness {
  static readonly BindingFlags Priv = BindingFlags.NonPublic | BindingFlags.Instance;
  static void Set(Machine m, string name, object v) {
    FieldInfo f = typeof(Machine).GetField(name, Priv);
    if (f == null) throw new Exception("Machine has no field '" + name + "' - the harness is stale");
    f.SetValue(m, v);
  }

  // The probe pin reaches Machine through the ProbePinConfigured call every
  // configuration path makes (profile open, definition apply).
  static Machine Primed(int ucPin, bool negate) {
    Machine m = new Machine();
    Set(m, "opened", true);
    Set(m, "sentinelPassed", true);
    m.LiveConsole = delegate(string text, string severity) { };
    m.ProbePinConfigured(ucPin, negate);
    return m;
  }

  static string Show(object v) { return v == null ? "null" : v.ToString(); }

  static void Case(string label, int ucPin, bool negate, long word, int rc, bool cycle) {
    FakeBoard.Reset();
    FakeBoard.InputWord = word;
    FakeBoard.InputRc = rc;
    FakeBoard.StatusProbeCycle = cycle;
    Machine m = Primed(ucPin, negate);
    Json.Obj s = m.Status();
    Json.Obj inp = (Json.Obj)s["inputs"];
    Console.WriteLine(label + ".probe=" + Show(inp == null ? null : inp["probe"]));
    Console.WriteLine(label + ".probeCycle=" + Show(s["probeCycle"]));
  }

  public static void Main(string[] args) {
    // UC pin 5 = bit 4, SampleMachine's machine.
    Case("touch", 5, false, 1L << 4, 0, false);
    Case("cycle", 5, false, 0L, 0, true);
    Case("invertedTouch", 5, true, 0L, 0, false);
    Case("invertedOpen", 5, true, 1L << 4, 0, false);
    Case("otherBit", 5, false, 1L << 3, 0, false);
    Case("unreadable", 5, false, 1L << 4, 7, true);
    Case("unconfigured", 0, false, 1L << 4, 0, true);
    Console.WriteLine("harness.done=True");
  }
}}
`

function runHarness(): Map<string, string> {
  const root = mkdtempSync(join(tmpdir(), 'liencam-wo1632-'))
  const source = join(root, 'Harness.cs')
  const executable = join(root, 'Harness.exe')
  writeFileSync(source, HARNESS)
  try {
    execFileSync(CSC, [
      '/nologo', '/unsafe', `/out:${executable}`, '/main:LienCAM.Wo1632ProbeInputHarness',
      resolve(BRIDGE_DIR, 'Bridge.cs'), resolve(BRIDGE_DIR, 'Machine.cs'),
      resolve(BRIDGE_DIR, 'Json.cs'), resolve(BRIDGE_DIR, 'Vfd.cs'),
      FAKE_BOARD_SOURCE, source,
    ], { stdio: 'pipe' })
    const out = execFileSync(executable, [], { encoding: 'utf8', timeout: 60_000 })
    const rows = new Map<string, string>()
    for (const line of out.split(/\r?\n/)) {
      const m = /^([A-Za-z0-9]+\.[A-Za-z]+)=(.*)$/.exec(line)
      if (m) rows.set(m[1], m[2])
    }
    return rows
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

let output: Map<string, string> | undefined
const row = (key: string): string | undefined => (output ??= runHarness()).get(key)

describe.skipIf(!existsSync(CSC))('WO-1632 inputs.probe is the probe pin, probeCycle is the cycle', () => {
  it('ran every scenario', () => {
    expect(row('harness.done')).toBe('True')
  }, 120_000)

  it('pin bit set, cycle flag clear -> probe true, probeCycle false', () => {
    expect(row('touch.probe')).toBe('True')
    expect(row('touch.probeCycle')).toBe('False')
  })

  it('pin bit clear, cycle flag set -> probe false, probeCycle true', () => {
    expect(row('cycle.probe')).toBe('False')
    expect(row('cycle.probeCycle')).toBe('True')
  })

  it('honours inverted polarity from the definition', () => {
    expect(row('invertedTouch.probe')).toBe('True')
    expect(row('invertedOpen.probe')).toBe('False')
  })

  it('reads the configured pin, not a neighbouring bit', () => {
    expect(row('otherBit.probe')).toBe('False')
  })

  it('an unreadable input word -> probe null, the cycle flag still reported', () => {
    expect(row('unreadable.probe')).toBe('null')
    expect(row('unreadable.probeCycle')).toBe('True')
  })

  it('no probe pin configured -> probe null', () => {
    expect(row('unconfigured.probe')).toBe('null')
    expect(row('unconfigured.probeCycle')).toBe('True')
  })
})
