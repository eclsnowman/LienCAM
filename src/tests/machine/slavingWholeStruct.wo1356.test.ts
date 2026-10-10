import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const BRIDGE_DIR = resolve('pendant/uccnc-bridge')
const MACHINE_SOURCE = join(BRIDGE_DIR, 'Machine.cs')
const FAKE_BOARD_SOURCE = resolve('src/tests/evidence/WO-1326/FakeUC100.cs')
const CSC = join(
  process.env.WINDIR ?? 'C:\\Windows',
  'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe',
)

function replaceRequired(source: string, from: string, to: string): string {
  if (!source.includes(from)) throw new Error(`fake-board fixture no longer contains: ${from}`)
  return source.replace(from, to)
}

function instrumentFakeBoard(): string {
  let source = readFileSync(FAKE_BOARD_SOURCE, 'utf8').replace(/\r\n/g, '\n')
  source = replaceRequired(source, '    public static int AxisSettingWrites;\n', `    public static int AxisSettingWrites;
    public static int ReadbackTaggedWrites;
    public static string CorruptAxisSettingField;
`)
  source = replaceRequired(source, '            AxisSettingWrites = 0;\n', `            AxisSettingWrites = 0;
            ReadbackTaggedWrites = 0;
            CorruptAxisSettingField = null;
`)
  source = replaceRequired(
    source,
    '        FakeBoard.AxisSettingWrites++;\n        if (i >= 0 && i < 6) axes[i] = _AxisSetting;\n',
    `        FakeBoard.AxisSettingWrites++;
        if (_AxisSetting.CurrentHiLowPin == 1356) FakeBoard.ReadbackTaggedWrites++;
        if (i >= 0 && i < 6)
        {
            axes[i] = _AxisSetting;
            AxisSetting held = axes[i];
            // Operator's board normalizes comp acceleration to at least 1.2x
            // acceleration after every whole-struct write (WO-1348).
            if (held.CompAccel < held.MaxAccel * 1.2) held.CompAccel = held.MaxAccel * 1.2;
            if (FakeBoard.CorruptAxisSettingField == "softLimitMin") held.SoftLimitN -= 1;
            if (FakeBoard.CorruptAxisSettingField == "softLimitMax") held.SoftLimitP += 1;
            if (FakeBoard.CorruptAxisSettingField == "acceleration") held.MaxAccel += 1;
            if (FakeBoard.CorruptAxisSettingField == "stepsPerUnit") held.StepPer += 1;
            if (FakeBoard.CorruptAxisSettingField == "slaveAxis") held.SlaveAxis = 5;
            axes[i] = held;
        }
`,
  )
  source = replaceRequired(
    source,
    '        if (i >= 0 && i < 6) { AxisSetting a = axes[i]; a.Axis = i; _AxisSetting = a; }\n',
    `        if (i >= 0 && i < 6) {
            AxisSetting a = axes[i]; a.Axis = i;
            // A tag only a Get result can carry. Sending it back proves a
            // whole-struct read/modify/write reached SetAxisSetting.
            a.CurrentHiLowPin = 1356;
            _AxisSetting = a;
        }
`,
  )
  return source
}

function runHarness(): string[] {
  const root = mkdtempSync(join(tmpdir(), 'liencam-wo1356-'))
  const fakeBoard = join(root, 'FakeUC100.cs')
  const harness = join(root, 'Harness.cs')
  const executable = join(root, 'Harness.exe')
  const profile = join(root, 'slaving.pro')

  writeFileSync(fakeBoard, instrumentFakeBoard())
  writeFileSync(profile, '[axessettingscontrolX]\r\nAxisenabled=True\r\nStepsperunit=400\r\nVelocity=6000\r\nAcceleration=800\r\nSoftlimitnegative=-10\r\nSoftlimitpositive=700\r\nSlaveaxis=A\r\n')
  writeFileSync(harness, `
using System;
using System.Reflection;
namespace LienCAM {
public static class Harness {
  static readonly BindingFlags Priv = BindingFlags.Instance | BindingFlags.NonPublic;

  static Machine.AxisPlan Axis() {
    return new Machine.AxisPlan {
      Index = 0, Name = "X", Enabled = true, StepsPerUnit = 400,
      MaxVelPerMin = 6000, Acceleration = 800,
      SoftLimitMin = -10, SoftLimitMax = 700, SlaveAxis = 3,
      HasHoming = true, HomeDirectionPositive = false, HomeBackOff = 2,
      HomeFastPerMin = 1200, HomeSlowPerMin = 300
    };
  }

  static Machine ConfiguredMachine() {
    FakeBoard.Reset();
    var machine = new Machine();
    typeof(Machine).GetField("opened", Priv).SetValue(machine, true);
    var plan = new Machine.DefinitionPlan(); plan.Axes.Add(Axis());
    Machine.ApplyResult result = machine.ApplyDefinition(plan, "WO-1356 harness");
    if (!result.Ok) throw new Exception(result.Error ?? "definition apply failed");
    return machine;
  }

  static bool SetSlaving(Machine machine, int slave, out string error) {
    object[] args = { 0, slave, null };
    bool ok = (bool)typeof(Machine).GetMethod("SetSlaving", Priv).Invoke(machine, args);
    error = (string)args[2]; return ok;
  }

  static void ProfileCase(string profile) {
    FakeBoard.Reset();
    var machine = new Machine();
    typeof(Machine).GetMethod("ReadIni", Priv).Invoke(machine, new object[] { profile });
    typeof(Machine).GetMethod("ApplyProfile", Priv).Invoke(machine, null);
    Console.WriteLine("profile|writes=" + FakeBoard.AxisSettingWrites
      + "|tagged=" + FakeBoard.ReadbackTaggedWrites);
  }

  static void GoodCase() {
    Machine machine = ConfiguredMachine();
    int writesBefore = FakeBoard.AxisSettingWrites;
    int taggedBefore = FakeBoard.ReadbackTaggedWrites;
    string error; bool ok = SetSlaving(machine, 0, out error);
    Console.WriteLine("good|ok=" + ok + "|writes=" + (FakeBoard.AxisSettingWrites - writesBefore)
      + "|tagged=" + (FakeBoard.ReadbackTaggedWrites - taggedBefore) + "|error=" + (error ?? "none"));
    foreach (Machine.ReportLine line in machine.OpenReport())
      if (line.Text.IndexOf("after slaving ", StringComparison.Ordinal) >= 0)
        Console.WriteLine("dump|" + line.Severity + "|" + line.Text);
  }

  static void CorruptCase(string field) {
    Machine machine = ConfiguredMachine();
    FakeBoard.CorruptAxisSettingField = field;
    string error; bool ok = SetSlaving(machine, 0, out error);
    Console.WriteLine("corrupt-" + field + "|ok=" + ok + "|" + error);
  }

  public static void Main(string[] args) {
    ProfileCase(args[0]);
    GoodCase();
    foreach (string field in new[] { "softLimitMin", "softLimitMax", "acceleration", "stepsPerUnit", "slaveAxis" })
      CorruptCase(field);
  }
}}
`)

  try {
    try {
      execFileSync(CSC, [
        '/nologo', '/unsafe', `/out:${executable}`, '/main:LienCAM.Harness',
        resolve(BRIDGE_DIR, 'Bridge.cs'), MACHINE_SOURCE,
        resolve(BRIDGE_DIR, 'Json.cs'), resolve(BRIDGE_DIR, 'Vfd.cs'),
        fakeBoard, harness,
      ], { stdio: 'pipe' })
    } catch (error) {
      const compile = error as { stdout?: Buffer, stderr?: Buffer }
      throw new Error(`${compile.stdout?.toString() ?? ''}${compile.stderr?.toString() ?? ''}`)
    }
    return execFileSync(executable, [profile], { encoding: 'utf8' })
      .trim().split(/\r?\n/).filter((line) => /^(profile|good|dump|corrupt-)/.test(line))
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

let output: string[] | undefined
const rows = (): string[] => (output ??= runHarness())

describe.skipIf(!existsSync(CSC))('WO-1356 whole-struct slaving writes', () => {
  it('never sends a GetAxisSetting-tagged struct through any SetAxisSetting call site', () => {
    expect(rows()).toContain('profile|writes=1|tagged=0')
    expect(rows()).toContain('good|ok=True|writes=1|tagged=0|error=none')
  })

  it('prints the post-slaving axis dump with every field whose preservation is checked', () => {
    const dumps = rows().filter((line) => line.startsWith('dump|'))
    expect(dumps).toHaveLength(6)
    expect(dumps).toContain(
      'dump|info|[bridge] after slaving X: enabled=True stepsPerUnit=400 maxVel=100 acceleration=800 compAccel=960 softLimits=-10..700 slave=0 homeBackOff=2 step=0 dir=0 home=0',
    )
  })

  it('accepts a slaving change when the board applies its comp-acceleration floor', () => {
    expect(rows()).toContain('good|ok=True|writes=1|tagged=0|error=none')
    expect(rows()).toContain(
      'dump|info|[bridge] after slaving X: enabled=True stepsPerUnit=400 maxVel=100 acceleration=800 compAccel=960 softLimits=-10..700 slave=0 homeBackOff=2 step=0 dir=0 home=0',
    )
  })

  it.each(['softLimitMin', 'softLimitMax', 'acceleration', 'stepsPerUnit', 'slaveAxis'])(
    'refuses loudly when the slaving write disturbs %s',
    (field) => {
      const row = rows().find((line) => line.startsWith(`corrupt-${field}|`))
      expect(row).toContain('|ok=False|')
      expect(row).toContain(field)
    },
  )
})

describe('WO-1356 source contract for all three SetAxisSetting sites', () => {
  it('has exactly three sites and no outgoing struct seeded from a readback struct', () => {
    const source = readFileSync(MACHINE_SOURCE, 'utf8')
    expect(source.match(/UC100\.SetAxisSetting\(ref /g)).toHaveLength(3)
    expect(source).not.toMatch(/AxisSetting\s+\w+\s*=\s*before\s*;/)
    const setSlaving = source.slice(source.indexOf('bool SetSlaving('), source.indexOf('/** THE ONE-TIME OFFSET'))
    const beforeWrite = setSlaving.slice(0, setSlaving.indexOf('UC100.SetAxisSetting(ref'))
    expect(beforeWrite).not.toContain('GetAxisSetting(ref')
  })
})
