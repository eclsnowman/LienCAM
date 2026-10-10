import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// WO-1646 - THE BOARD'S PIN TABLE IS DATA, PER BOARD TYPE.
//
// Operator ruling 2026-09-17: "My machine is just the test bed. This needs to be able to
// be used by anyone." The REAL Bridge.cs / Machine.cs are compiled with csc
// against the WO-1326 fake board, whose DeviceInfo answers the board id as the
// board type. One machine definition (X step port 1 pin 15, dir port 1 pin 16,
// flood port 3 pin 14) is applied through Machine.Open + ApplyDefinition to:
//
//   - board 1 of type 19, the AXBB-E, whose table is built in - Operator's numbers
//     must come out exactly as today (step UCpin 10, dir 11, flood UCpin 35);
//   - board 8, a second board type whose table arrives as a boards/*.json file
//     beside the bridge - A TEST FIXTURE, not a transcription of a real UC400ETH;
//   - the demo boards -19 and -8, which emulate those same two types;
//   - boards of a type with no table (UC100, UC300-M44), refused by name.
//
// NOT CLAIMED: hardware. The readback is the fake board's stored AxisSetting.

const BRIDGE_DIR = resolve('pendant/uccnc-bridge')
const FAKE_BOARD_SOURCE = resolve('src/tests/evidence/WO-1326/FakeUC100.cs')
const CSC = join(
  process.env.WINDIR ?? 'C:\\Windows',
  'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe',
)

/** The second board type's table. Deliberately unlike the AXBB-E's. */
const FIXTURE_TABLE = {
  format: 'liencam-board-pins',
  schemaVersion: 1,
  name: 'FIXTURE-8',
  deviceType: 8,
  pins: [
    { port: 1, pin: 15, ucPin: 5, direction: 'output' },
    { port: 1, pin: 16, ucPin: 6, direction: 'output' },
    { port: 3, pin: 14, ucPin: 40, direction: 'output' },
    { port: 2, pin: 1, ucPin: 13, direction: 'input' },
  ],
}

const HARNESS = `
using System;
using System.Collections.Generic;
namespace LienCAM {
public static class Wo1646BoardHarness {
  static Json.Obj Pin(double port, double pin) {
    var value = new Json.Obj(); value.Set("port", port); value.Set("pin", pin);
    value.Set("negate", false); return value;
  }
  static Json.Obj Definition() {
    var axis = new Json.Obj(); axis.Set("axis", "X"); axis.Set("enabled", true);
    axis.Set("stepsPerUnit", 400.0); axis.Set("maxVelocity", 6000.0);
    axis.Set("acceleration", 800.0); axis.Set("softLimitMin", -10.0);
    axis.Set("softLimitMax", 800.0); axis.Set("slaveAxis", null);
    axis.Set("stepPin", Pin(1, 15)); axis.Set("dirPin", Pin(1, 16));
    var def = new Json.Obj(); def.Set("axes", new List<object> { axis });
    def.Set("settings", new List<object>());
    return def;
  }
  static string Find(IEnumerable<Machine.ReportLine> lines, string needle) {
    foreach (Machine.ReportLine line in lines)
      if (line.Text.IndexOf(needle, StringComparison.Ordinal) >= 0) return line.Text;
    return "MISSING";
  }
  static void Case(string label, int board, string profile) {
    FakeBoard.Reset();
    var machine = new Machine();
    bool open = machine.Open(board, profile);
    Console.WriteLine(label + ".open=" + open);
    Console.WriteLine(label + ".table=" + (machine.PinTableName ?? "none"));
    Console.WriteLine(label + ".refusal=" + Find(machine.OpenReport(), "REFUSING TO OPEN"));
    if (!open) return;
    object parsed; Json.TryParse(Json.Write(Definition()), out parsed);
    Machine.DefinitionPlan plan; string parseError;
    bool planOk = Machine.ParseDefinition(parsed, out plan, out parseError);
    Machine.ApplyResult applied = machine.ApplyDefinition(plan, "WO-1646 harness");
    Console.WriteLine(label + ".apply=" + planOk + "," + applied.Ok);
    UC100.AxisSetting x = new UC100.AxisSetting(); x.Axis = 0;
    UC100.GetAxisSetting(ref x);
    Console.WriteLine(label + ".step=" + x.StepPin);
    Console.WriteLine(label + ".dir=" + x.DirPin);
    FakeBoard.OutputCalls.Clear();
    string err; Json.Obj rb;
    bool switched = machine.SetOutput(3, 14, true, false, out err, out rb);
    Console.WriteLine(label + ".flood=" + switched + ":" + string.Join(",", FakeBoard.OutputCalls.ToArray()));
    machine.Close();
  }
  public static void Main(string[] args) {
    BoardOwner.Start();
    string refusal = null;
    BoardOwner.Run(BoardOwner.Class.Normal, "WO-1646 board harness", delegate {
      Case("axbb", 19, args[0]);
      Case("demoAxbb", -19, args[0]);
      Case("fixture", 8, args[0]);
      Case("demoFixture", -8, args[0]);
      Case("uc100", 1, args[0]);
      Case("uc300m44", 5, args[0]);
    }, 60000, out refusal);
    if (refusal != null) throw new Exception(refusal);
  }
}}
`

function runHarness(): Map<string, string> {
  const root = mkdtempSync(join(tmpdir(), 'liencam-wo1646-'))
  const source = join(root, 'Harness.cs')
  const executable = join(root, 'Harness.exe')
  const profile = join(root, 'machine.pro')
  mkdirSync(join(root, 'boards'))
  writeFileSync(join(root, 'boards', 'fixture-8.json'), JSON.stringify(FIXTURE_TABLE, null, 2))
  writeFileSync(join(root, 'boards', 'broken.json'), '{ "format": "liencam-board-pins", ')
  writeFileSync(profile, [
    '[Generalsettings]',
    'Constantvelocitymode=True', 'Stopatangle=89', 'Linearerror=0.03',
    'Cornerserror=0.03', 'USBbuffersize=0.1', 'Softlimitsenable=True',
    '[axessettingscontrolX]',
    'Axisenabled=True', 'Stepsperunit=400', 'Velocity=6000', 'Acceleration=800',
    'Compaccel=800', 'Softlimitnegative=-10', 'Softlimitpositive=800',
    'Stepportnumber=1', 'Steppinnumber=15', 'Dirportnumber=1', 'Dirpinnumber=16',
    '',
  ].join('\r\n'))
  writeFileSync(source, HARNESS)
  try {
    execFileSync(CSC, [
      '/nologo', '/unsafe', `/out:${executable}`, '/main:LienCAM.Wo1646BoardHarness',
      resolve(BRIDGE_DIR, 'Bridge.cs'), resolve(BRIDGE_DIR, 'Machine.cs'),
      resolve(BRIDGE_DIR, 'Json.cs'), resolve(BRIDGE_DIR, 'Vfd.cs'),
      FAKE_BOARD_SOURCE, source,
    ], { stdio: 'pipe' })
    const out = execFileSync(executable, [profile], { encoding: 'utf8' })
    const rows = new Map<string, string>()
    for (const line of out.split(/\r?\n/)) {
      const m = /^([a-zA-Z0-9]+\.[a-z]+)=(.*)$/.exec(line)
      if (m) rows.set(m[1], m[2])
    }
    rows.set('log', out)
    return rows
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

let output: Map<string, string> | undefined
const row = (key: string): string | undefined => (output ??= runHarness()).get(key)

describe.skipIf(!existsSync(CSC))('WO-1646 per-board pin tables, one definition', () => {
  it("Operator's AXBB-E: the same numbers as before the change", () => {
    expect(row('axbb.open')).toBe('True')
    expect(row('axbb.table')).toBe('AXBB-E')
    expect(row('axbb.apply')).toBe('True,True')
    expect(row('axbb.step')).toBe('10')
    expect(row('axbb.dir')).toBe('11')
    // SetOutputBit takes the UC pin itself (WO-1666, measured); port 3 pin 14
    // is UCpin 35 on the AXBB-E.
    expect(row('axbb.flood')).toBe('True:set 35')
  })

  it('a second board type: the same definition pins reach that board\'s own numbers', () => {
    expect(row('fixture.open')).toBe('True')
    expect(row('fixture.table')).toBe('FIXTURE-8')
    expect(row('fixture.apply')).toBe('True,True')
    expect(row('fixture.step')).toBe('5')
    expect(row('fixture.dir')).toBe('6')
    expect(row('fixture.flood')).toBe('True:set 40')
  })

  it('demo boards use the table of the board they emulate', () => {
    expect(row('demoAxbb.table')).toBe('AXBB-E')
    expect(row('demoAxbb.step')).toBe('10')
    expect(row('demoFixture.table')).toBe('FIXTURE-8')
    expect(row('demoFixture.step')).toBe('5')
  })

  it.each([
    ['uc100', 1, 'UC100'],
    ['uc300m44', 5, 'UC300-M44'],
  ] as const)('a board with no table (%s) is refused by name, nothing opened', (label, type, name) => {
    expect(row(`${label}.open`)).toBe('False')
    expect(row(`${label}.table`)).toBe('none')
    const refusal = row(`${label}.refusal`) ?? ''
    expect(refusal).toContain(`board type ${type} (${name})`)
    expect(refusal).toContain('AXBB-E (type 19)')
    expect(refusal).toContain('FIXTURE-8 (type 8)')
  })

  it('an unreadable table file is skipped and says why', () => {
    expect(row('log')).toContain('board table broken.json skipped: is not readable as JSON.')
  })
})
