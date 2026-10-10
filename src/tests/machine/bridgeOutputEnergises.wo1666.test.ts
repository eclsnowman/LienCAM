import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// WO-1666 - THE BRIDGE ENERGISES THE OUTPUT PIN IT IS ASKED FOR.
//
// 2026-09-17 at the machine: typed M7 sent setOutput {port 3, pin 16} (UC pin
// 3 on the AXBB-E), the bridge called SetOutputBit(2), the board read the pin
// off and Operator's vacuum never started. The DLL's two numberings, measured in
// demo mode on both UC100.dll versions (src/tests/evidence/WO-1666/):
//
//   SetOutputBit(Num) / ClearOutputBit(Num): Num is the UC PIN, 1-based.
//     Num 2 sets bit 1, Num 4 sets bit 3, Num 0 is refused with rc 9.
//   GetOutput / SetOutput word: bit = UC pin - 1 (same as the GetInput word).
//
// The fake board now honours exactly those semantics, so this test drives the
// REAL Machine.cs and reads the level back through the same word the board
// reports: a bridge that passes UC pin - 1 lands on the wrong bit here, the
// readback says off, and the test fails - which is what the board said.
//
// NOT CLAIMED: the relay. Tier 1 is the machine seat's pin-16 test with Operator
// listening for the vacuum.

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
public static class Wo1666OutputHarness {
  static readonly BindingFlags Priv = BindingFlags.NonPublic | BindingFlags.Instance;
  static void Set(Machine m, string name, object v) {
    FieldInfo f = typeof(Machine).GetField(name, Priv);
    if (f == null) throw new Exception("Machine has no field '" + name + "' - the harness is stale");
    f.SetValue(m, v);
  }

  static Machine Primed() {
    Machine m = new Machine();
    Set(m, "opened", true);
    Set(m, "sentinelPassed", true);
    Set(m, "pinTable", BoardPinTables.AxbbE);
    Set(m, "readOnly", false);
    m.LiveConsole = delegate(string text, string severity) { };
    return m;
  }

  static string Show(object v) { return v == null ? "null" : v.ToString(); }

  static string Bits(long w) {
    string s = "";
    for (int i = 0; i < 64; i++) if (((w >> i) & 1L) == 1L) s += (s.Length > 0 ? "," : "") + i;
    return s.Length == 0 ? "none" : s;
  }

  static void Sw(string label, Machine m, int port, int pin, bool on, bool negate) {
    string err; Json.Obj rb;
    bool ok = m.SetOutput(port, pin, on, negate, out err, out rb);
    Console.WriteLine(label + ".ok=" + ok);
    Console.WriteLine(label + ".err=" + Show(err));
    Console.WriteLine(label + ".ucPin=" + Show(rb == null ? null : rb["ucPin"]));
    Console.WriteLine(label + ".level=" + Show(rb == null ? null : rb["level"]));
    Console.WriteLine(label + ".on=" + Show(rb == null ? null : rb["on"]));
    Console.WriteLine(label + ".wordBits=" + Bits(FakeBoard.OutputWord));
  }

  public static void Main(string[] args) {
    // 1. The fake board honours the DLL's measured semantics.
    FakeBoard.Reset();
    Console.WriteLine("fake.setZeroRc=" + UC100.SetOutputBit(0));
    Console.WriteLine("fake.setTwoRc=" + UC100.SetOutputBit(2));
    Console.WriteLine("fake.afterSetTwo=" + Bits(FakeBoard.OutputWord));
    UC100.ClearOutputBit(2);
    UC100.SetOutputBit(4);
    Console.WriteLine("fake.afterSetFour=" + Bits(FakeBoard.OutputWord));

    // 2. SampleMachine's M7 relay: port 3 pin 16 = UC pin 3 on the AXBB-E. On, then off.
    FakeBoard.Reset();
    UC100.SetOffline(false);
    Machine m = Primed();
    Sw("mistOn", m, 3, 16, true, false);
    Sw("mistOff", m, 3, 16, false, false);

    // 3. SampleMachine's M8 relay (port 3 pin 14 = UC pin 35) beside it: each keeps its own bit.
    FakeBoard.Reset();
    m = Primed();
    Sw("floodOn", m, 3, 14, true, false);
    Sw("bothOn", m, 3, 16, true, false);
    Sw("floodOff", m, 3, 14, false, false);

    // 4. A negated output: ON drives the terminal low and the readback says so.
    FakeBoard.Reset();
    m = Primed();
    Sw("negOn", m, 1, 16, true, true);
    Sw("negOff", m, 1, 16, false, true);

    Console.WriteLine("harness.done=True");
  }
}}
`

function runHarness(): Map<string, string> {
  const root = mkdtempSync(join(tmpdir(), 'liencam-wo1666-'))
  const source = join(root, 'Harness.cs')
  const executable = join(root, 'Harness.exe')
  writeFileSync(source, HARNESS)
  try {
    execFileSync(CSC, [
      '/nologo', '/unsafe', `/out:${executable}`, '/main:LienCAM.Wo1666OutputHarness',
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

describe.skipIf(!existsSync(CSC))('WO-1666 bridge: the output pin the definition names is the one energised', () => {
  it('ran every scenario', () => {
    expect(row('harness.done')).toBe('True')
  }, 120_000)

  it('the fake board holds the DLL semantics measured in demo mode', () => {
    // src/tests/evidence/WO-1666/demo-probe-*.txt: Num 0 -> rc 9, Num 2 -> bit 1, Num 4 -> bit 3.
    expect(row('fake.setZeroRc')).toBe('9')
    expect(row('fake.setTwoRc')).toBe('0')
    expect(row('fake.afterSetTwo')).toBe('1')
    expect(row('fake.afterSetFour')).toBe('3')
  })

  it("Operator's M7 relay (port 3 pin 16, UC pin 3): on sets bit 2 and reads back on; off clears it", () => {
    expect(row('mistOn.ok')).toBe('True')
    expect(row('mistOn.ucPin')).toBe('3')
    expect(row('mistOn.wordBits')).toBe('2')
    expect(row('mistOn.level')).toBe('True')
    expect(row('mistOn.on')).toBe('True')
    expect(row('mistOff.ok')).toBe('True')
    expect(row('mistOff.wordBits')).toBe('none')
    expect(row('mistOff.level')).toBe('False')
    expect(row('mistOff.on')).toBe('False')
  })

  it('two relays keep their own bits (UC pin 35 and UC pin 3)', () => {
    expect(row('floodOn.wordBits')).toBe('34')
    expect(row('floodOn.level')).toBe('True')
    expect(row('bothOn.wordBits')).toBe('2,34')
    expect(row('bothOn.level')).toBe('True')
    expect(row('floodOff.wordBits')).toBe('2')
    expect(row('floodOff.level')).toBe('False')
  })

  it('a negated output drives the terminal low for ON and the readback applies the polarity', () => {
    // port 1 pin 16 -> UC pin 11 -> bit 10.
    expect(row('negOn.ok')).toBe('True')
    expect(row('negOn.wordBits')).toBe('none')
    expect(row('negOn.level')).toBe('False')
    expect(row('negOn.on')).toBe('True')
    expect(row('negOff.wordBits')).toBe('10')
    expect(row('negOff.level')).toBe('True')
    expect(row('negOff.on')).toBe('False')
  })
})
