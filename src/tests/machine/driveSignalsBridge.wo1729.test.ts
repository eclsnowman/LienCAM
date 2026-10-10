import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// WO-1729. Compile the REAL production Machine.cs against an isolated board
// recorder. The recorder adds only the two charge-pump calls present in the
// real UC100 wrapper; drive-fault samples still come from FakeUC100's real
// GetInput word, so pin translation, polarity, latching and Stop all execute
// through the shipping bridge code.

const BRIDGE_DIR = resolve('pendant/uccnc-bridge')
const FAKE_BOARD_SOURCE = resolve('src/tests/evidence/WO-1326/FakeUC100.cs')
const CSC = join(
  process.env.WINDIR ?? 'C:\\Windows',
  'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe',
)

const CHARGE_PUMP_FAKE = `
public static class Wo1729ChargePumpBoard {
  public static int SetCalls, GetCalls;
  public static int Pin1, Pin2;
  public static bool Neg1, Neg2, AlwaysOn;
  public static void Reset() {
    SetCalls = GetCalls = 0; Pin1 = Pin2 = 0;
    Neg1 = Neg2 = AlwaysOn = false;
  }
}
public partial class UC100 {
  public static int SetChargePumpSetting(int pin1, bool neg1, int pin2, bool neg2, bool alwaysOn) {
    Wo1729ChargePumpBoard.SetCalls++;
    Wo1729ChargePumpBoard.Pin1 = pin1; Wo1729ChargePumpBoard.Neg1 = neg1;
    Wo1729ChargePumpBoard.Pin2 = pin2; Wo1729ChargePumpBoard.Neg2 = neg2;
    Wo1729ChargePumpBoard.AlwaysOn = alwaysOn;
    FakeBoard.Note("SetChargePumpSetting " + pin1 + "/" + neg1 + " " + pin2 + "/" + neg2 + " always=" + alwaysOn);
    return 0;
  }
  public static int GetChargePumpSetting(ref int pin1, ref bool neg1, ref int pin2, ref bool neg2, ref bool alwaysOn) {
    Wo1729ChargePumpBoard.GetCalls++;
    pin1 = Wo1729ChargePumpBoard.Pin1; neg1 = Wo1729ChargePumpBoard.Neg1;
    pin2 = Wo1729ChargePumpBoard.Pin2; neg2 = Wo1729ChargePumpBoard.Neg2;
    alwaysOn = Wo1729ChargePumpBoard.AlwaysOn;
    FakeBoard.Note("GetChargePumpSetting");
    return 0;
  }
}
`

const HARNESS = `
using System;
using System.Collections.Generic;
using System.IO;
namespace LienCAM {
public static class Wo1729DriveSignalsHarness {
  static Json.Obj Pin(double port, double pin, bool negate) {
    var value = new Json.Obj(); value.Set("port", port); value.Set("pin", pin);
    value.Set("negate", negate); return value;
  }
  static Json.Obj BaseDefinition() {
    var axis = new Json.Obj(); axis.Set("axis", "X"); axis.Set("enabled", false);
    axis.Set("stepsPerUnit", 400.0); axis.Set("maxVelocity", 6000.0);
    axis.Set("acceleration", 800.0); axis.Set("softLimitMin", -10.0);
    axis.Set("softLimitMax", 800.0); axis.Set("slaveAxis", null);
    var def = new Json.Obj(); def.Set("axes", new List<object> { axis });
    def.Set("stated", new List<object>()); def.Set("settings", new List<object>());
    return def;
  }
  static Json.Obj Pump(bool enabled, Json.Obj pin, double? frequency) {
    var pump = new Json.Obj(); pump.Set("enabled", enabled);
    if (pin != null) pump.Set("pin", pin);
    if (frequency.HasValue) pump.Set("frequencyHz", frequency.Value);
    return pump;
  }
  static Machine.ApplyResult Apply(Machine machine, Json.Obj definition, out Machine.DefinitionPlan plan) {
    object parsed; if (!Json.TryParse(Json.Write(definition), out parsed)) throw new Exception("definition JSON did not parse");
    string error; if (!Machine.ParseDefinition(parsed, out plan, out error)) throw new Exception("definition did not plan: " + error);
    return machine.ApplyDefinition(plan, "WO-1729 harness");
  }
  static Machine Open(string profile) {
    if (File.Exists(Machine.DefinitionCachePath())) File.Delete(Machine.DefinitionCachePath());
    FakeBoard.Reset(); Wo1729ChargePumpBoard.Reset();
    var machine = new Machine();
    if (!machine.Open(19, profile)) throw new Exception("fake AXBB-E did not open");
    FakeBoard.Calls.Clear(); FakeBoard.StopCalls = 0; FakeBoard.StopWithDeccelCalls = 0;
    Wo1729ChargePumpBoard.Reset();
    return machine;
  }
  static Json.Obj DriveFault(Machine machine) { return (Json.Obj)machine.Status()["driveFault"]; }
  static string Show(object value) { return value == null ? "null" : value.ToString(); }

  static void SampleMachine(string profile) {
    Machine machine = Open(profile);
    var definition = BaseDefinition();
    definition.Set("driveFaultInputs", new List<object> { Pin(3, 13, true) });
    definition.Set("chargePump", Pump(false, null, null));
    Wo1729ChargePumpBoard.Pin2 = 44; Wo1729ChargePumpBoard.Neg2 = true;
    Wo1729ChargePumpBoard.AlwaysOn = true;
    Machine.DefinitionPlan plan; Machine.ApplyResult applied = Apply(machine, definition, out plan);
    FakeBoard.InputWord = 1L << 9;
    Json.Obj fault = DriveFault(machine);
    Console.WriteLine("sampleMachine.apply=" + applied.Ok);
    Console.WriteLine("sampleMachine.fault=" + Json.Write(fault));
    Console.WriteLine("sampleMachine.pumpCalls=" + Wo1729ChargePumpBoard.SetCalls + "," + Wo1729ChargePumpBoard.GetCalls);
    Console.WriteLine("sampleMachine.pump=" + Wo1729ChargePumpBoard.Pin1 + "," + Wo1729ChargePumpBoard.Neg1 + "," + Wo1729ChargePumpBoard.Pin2 + "," + Wo1729ChargePumpBoard.AlwaysOn);
    machine.Close();
  }

  static void Different(string profile) {
    Machine machine = Open(profile);
    var definition = BaseDefinition();
    definition.Set("driveFaultInputs", new List<object> { Pin(2, 1, false), Pin(3, 10, true) });
    definition.Set("chargePump", Pump(true, Pin(3, 14, false), null));
    Wo1729ChargePumpBoard.Pin2 = 44; Wo1729ChargePumpBoard.Neg2 = true;
    Wo1729ChargePumpBoard.AlwaysOn = true;
    Machine.DefinitionPlan plan; Machine.ApplyResult applied = Apply(machine, definition, out plan);
    FakeBoard.StopCalls = 0; FakeBoard.StopWithDeccelCalls = 0; FakeBoard.Calls.Clear();
    FakeBoard.InputWord = 1L << 6;
    Json.Obj clear = DriveFault(machine);
    FakeBoard.InputWord = 0;
    DriveFault(machine); DriveFault(machine); Json.Obj tripped = DriveFault(machine);
    int stopBefore = FakeBoard.StopWithDeccelCalls;
    machine.StopJob();
    Console.WriteLine("different.apply=" + applied.Ok);
    Console.WriteLine("different.clear=" + Json.Write(clear));
    Console.WriteLine("different.tripped=" + Json.Write(tripped));
    Console.WriteLine("different.stop=" + FakeBoard.StopCalls + "," + (FakeBoard.StopWithDeccelCalls - stopBefore));
    Console.WriteLine("different.pumpCalls=" + Wo1729ChargePumpBoard.SetCalls + "," + Wo1729ChargePumpBoard.GetCalls);
    Console.WriteLine("different.pump=" + Wo1729ChargePumpBoard.Pin1 + "," + Wo1729ChargePumpBoard.Neg1 + "," + Wo1729ChargePumpBoard.Pin2 + "," + Wo1729ChargePumpBoard.AlwaysOn);
    machine.Close();
  }

  static void EmptyAndAbsent(string profile) {
    Machine machine = Open(profile);
    var first = BaseDefinition();
    first.Set("driveFaultInputs", new List<object> { Pin(3, 13, true) });
    first.Set("chargePump", Pump(false, null, null));
    Machine.DefinitionPlan ignored; Apply(machine, first, out ignored);
    int pumpSets = Wo1729ChargePumpBoard.SetCalls;
    var cleared = BaseDefinition(); cleared.Set("driveFaultInputs", new List<object>());
    Machine.ApplyResult applied = Apply(machine, cleared, out ignored);
    Json.Obj fault = DriveFault(machine);
    Console.WriteLine("empty.apply=" + applied.Ok);
    Console.WriteLine("empty.configured=" + Show(fault["configured"]));
    Console.WriteLine("empty.pumpSetDelta=" + (Wo1729ChargePumpBoard.SetCalls - pumpSets));
    Apply(machine, first, out ignored);
    pumpSets = Wo1729ChargePumpBoard.SetCalls;
    var absent = BaseDefinition();
    Machine.ApplyResult absentApplied = Apply(machine, absent, out ignored);
    Json.Obj absentFault = DriveFault(machine);
    Console.WriteLine("absent.apply=" + absentApplied.Ok);
    Console.WriteLine("absent.configured=" + Show(absentFault["configured"]));
    Console.WriteLine("absent.pumpSetDelta=" + (Wo1729ChargePumpBoard.SetCalls - pumpSets));
    machine.Close();
  }

  static void UnsupportedFrequency(string profile) {
    Machine machine = Open(profile);
    var definition = BaseDefinition();
    definition.Set("driveFaultInputs", new List<object>());
    definition.Set("chargePump", Pump(true, Pin(3, 14, false), 12500.0));
    FakeBoard.AxisSettingWrites = 0;
    Machine.DefinitionPlan plan; Machine.ApplyResult applied = Apply(machine, definition, out plan);
    Console.WriteLine("frequency.ok=" + applied.Ok);
    Console.WriteLine("frequency.error=" + (applied.Error ?? "null"));
    Console.WriteLine("frequency.writes=" + FakeBoard.AxisSettingWrites + "," + Wo1729ChargePumpBoard.SetCalls);
    machine.Close();
  }

  public static void Main(string[] args) {
    BoardOwner.Start(); string refusal = null;
    BoardOwner.Run(BoardOwner.Class.Normal, "WO-1729 drive signals harness", delegate {
      SampleMachine(args[0]); Different(args[0]); EmptyAndAbsent(args[0]); UnsupportedFrequency(args[0]);
    }, 60000, out refusal);
    if (refusal != null) throw new Exception(refusal);
    Console.WriteLine("harness.done=True");
  }
}}
`

function runHarness(): Map<string, string> {
  const root = mkdtempSync(join(tmpdir(), 'liencam-wo1729-'))
  const source = join(root, 'Harness.cs')
  const fake = join(root, 'FakeUC100.cs')
  const executable = join(root, 'Harness.exe')
  const profile = join(root, 'machine.pro')
  writeFileSync(profile, [
    '[Generalsettings]',
    'Constantvelocitymode=True', 'Stopatangle=89', 'Linearerror=0.03',
    'Cornerserror=0.03', 'USBbuffersize=0.1', 'Softlimitsenable=True',
    '[axessettingscontrolX]',
    'Axisenabled=False', 'Stepsperunit=400', 'Velocity=6000', 'Acceleration=800',
    'Compaccel=800', 'Softlimitnegative=-10', 'Softlimitpositive=800',
    '[FaultSignals]',
    'Enable1=True', 'ActiveLow1=True', 'Description1=raw profile fallback must not win',
    'Port1=3', 'Pin1=13',
    '',
  ].join('\r\n'))
  const fakeSource = readFileSync(FAKE_BOARD_SOURCE, 'utf8')
    .replace('public class UC100\r\n', 'public partial class UC100\r\n')
    .replace('public class UC100\n', 'public partial class UC100\n')
  writeFileSync(fake, fakeSource + CHARGE_PUMP_FAKE)
  writeFileSync(source, HARNESS)
  try {
    execFileSync(CSC, [
      '/nologo', '/unsafe', `/out:${executable}`, '/main:LienCAM.Wo1729DriveSignalsHarness',
      resolve(BRIDGE_DIR, 'Bridge.cs'), resolve(BRIDGE_DIR, 'Machine.cs'),
      resolve(BRIDGE_DIR, 'Json.cs'), resolve(BRIDGE_DIR, 'Vfd.cs'), fake, source,
    ], { stdio: 'pipe' })
    const out = execFileSync(executable, [profile], { encoding: 'utf8', timeout: 60_000 })
    const rows = new Map<string, string>()
    for (const line of out.split(/\r?\n/)) {
      const match = /^([A-Za-z0-9]+\.[A-Za-z]+)=(.*)$/.exec(line)
      if (match) rows.set(match[1], match[2])
    }
    rows.set('log', out)
    return rows
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

let output: Map<string, string> | undefined
const row = (key: string): string | undefined => (output ??= runHarness()).get(key)
const jsonRow = (key: string): Record<string, unknown> => JSON.parse(row(key) ?? 'null') as Record<string, unknown>

describe.skipIf(!existsSync(CSC))('WO-1729 definition-owned drive faults and charge pump', () => {
  it("applies Operator's imported active-low input through the board table and explicitly turns the pump off", () => {
    expect(row('harness.done')).toBe('True')
    expect(row('sampleMachine.apply')).toBe('True')
    expect(jsonRow('sampleMachine.fault')).toMatchObject({
      configured: true,
      asserted: false,
      activeLow: true,
      inputs: [{ ucPin: 10, activeLow: true }],
    })
    expect(row('sampleMachine.pumpCalls')).toBe('1,2')
    expect(row('sampleMachine.pump')).toBe('0,False,44,True')
  }, 120_000)

  it('applies two differently polarised inputs and a pump, then faults and stops from the second input', () => {
    expect(row('different.apply')).toBe('True')
    expect(jsonRow('different.clear')).toMatchObject({
      configured: true,
      asserted: false,
      latched: false,
      inputs: [{ ucPin: 1, activeLow: false }, { ucPin: 7, activeLow: true }],
    })
    expect(jsonRow('different.tripped')).toMatchObject({ configured: true, asserted: true, latched: true, consecutive: 3 })
    expect(row('different.stop')).toBe('1,1')
    expect(row('different.pumpCalls')).toBe('1,2')
    expect(row('different.pump')).toBe('35,False,44,True')
  })

  it('an explicit empty fault list clears the raw profile input while an absent pump leaves its board state alone', () => {
    expect(row('empty.apply')).toBe('True')
    expect(row('empty.configured')).toBe('False')
    expect(row('empty.pumpSetDelta')).toBe('0')
    expect(row('absent.apply')).toBe('True')
    expect(row('absent.configured')).toBe('False')
    expect(row('absent.pumpSetDelta')).toBe('0')
  })

  it('reports the real wrapper frequency gap before any board write instead of inventing support', () => {
    expect(row('frequency.ok')).toBe('False')
    expect(row('frequency.error')).toContain('frequencyHz=12500')
    expect(row('frequency.error')).toContain('SetChargePumpSetting(int, bool, int, bool, bool)')
    expect(row('frequency.writes')).toBe('0,0')
  })
})
