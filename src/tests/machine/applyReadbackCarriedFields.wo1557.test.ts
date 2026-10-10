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
  const root = mkdtempSync(join(tmpdir(), 'liencam-wo1557-'))
  const source = join(root, 'Harness.cs')
  const executable = join(root, 'Harness.exe')
  const profile = join(root, 'rotary.pro')

  writeFileSync(profile, [
    '[Generalsettings]',
    'Constantvelocitymode=True', 'Stopatangle=89', 'Linearerror=0.03',
    'Cornerserror=0.03', 'USBbuffersize=0.1', 'Softlimitsenable=True',
    '[axessettingscontrolA]',
    'Axisenabled=True', 'Stepsperunit=400', 'Velocity=6000', 'Acceleration=800',
    'Compaccel=800', 'Softlimitnegative=-180', 'Softlimitpositive=180',
    'Stepportnumber=1', 'Steppinnumber=15', 'Dirportnumber=1', 'Dirpinnumber=16',
    'Currhilowportnumber=1', 'Currhilowpinnumber=10', 'Currhilowpinnegate=True',
    'Rotaryaxis=True', 'Rotaryrollover=True',
    'Homebackoff=4', 'Homedirectionpositive=True',
    '',
  ].join('\r\n'))

  writeFileSync(source, `
using System;
using System.Collections.Generic;
using System.IO;
namespace LienCAM {
public static class Harness {
  static Json.Obj Pin(double port, double pin) {
    var value = new Json.Obj(); value.Set("port", port); value.Set("pin", pin);
    value.Set("negate", false); return value;
  }
  static Json.Obj Definition() {
    var axis = new Json.Obj(); axis.Set("axis", "A"); axis.Set("enabled", true);
    axis.Set("stepsPerUnit", 400.0); axis.Set("maxVelocity", 6000.0);
    axis.Set("acceleration", 800.0); axis.Set("softLimitMin", -180.0);
    axis.Set("softLimitMax", 180.0); axis.Set("slaveAxis", null);
    axis.Set("stepPin", Pin(1, 15)); axis.Set("dirPin", Pin(1, 16));
    axis.Set("enablePin", Pin(1, 14));
    var home = new Json.Obj(); home.Set("direction", "positive");
    home.Set("fastSpeed", 1500.0); home.Set("slowSpeed", 375.0);
    home.Set("backOff", 4.0); home.Set("homingValue", 0.0); home.Set("autoZero", true);
    var perAxis = new Json.Obj(); perAxis.Set("A", home);
    var homing = new Json.Obj(); homing.Set("perAxis", perAxis);
    var def = new Json.Obj(); def.Set("axes", new List<object> { axis });
    def.Set("homing", homing); def.Set("settings", new List<object>());
    return def;
  }
  static string Find(IEnumerable<Machine.ReportLine> lines, string needle) {
    foreach (Machine.ReportLine line in lines)
      if (line.Text.IndexOf(needle, StringComparison.Ordinal) >= 0) return line.Text;
    return "MISSING";
  }
  public static void Main(string[] args) {
    BoardOwner.Start();
    string refusal = null;
    BoardOwner.Run(BoardOwner.Class.Normal, "WO-1557 carried-fields harness", delegate {
      FakeBoard.Reset();
      var machine = new Machine();
      bool open = machine.Open(-19, args[0]);
      Console.WriteLine("open=" + open);
      Console.WriteLine("startup=" + Find(machine.OpenReport(), "axis A readback"));

      object parsed; Json.TryParse(Json.Write(Definition()), out parsed);
      Machine.DefinitionPlan plan; string parseError;
      bool planOk = Machine.ParseDefinition(parsed, out plan, out parseError);
      Machine.ApplyResult applied = machine.ApplyDefinition(plan, "WO-1557 harness");
      Console.WriteLine("seed=" + planOk + "," + applied.Ok);
      Console.WriteLine("apply=" + Find(applied.Lines, "axis A applied and read back"));
      machine.Close();
    }, 20000, out refusal);
    if (refusal != null) throw new Exception(refusal);
  }
}}
`)

  try {
    execFileSync(CSC, [
      '/nologo', '/unsafe', `/out:${executable}`, '/main:LienCAM.Harness',
      resolve(BRIDGE_DIR, 'Bridge.cs'), resolve(BRIDGE_DIR, 'Machine.cs'),
      resolve(BRIDGE_DIR, 'Json.cs'), resolve(BRIDGE_DIR, 'Vfd.cs'),
      FAKE_BOARD_SOURCE, source,
    ], { stdio: 'pipe' })
    return execFileSync(executable, [profile], { encoding: 'utf8' })
      .trim().split(/\r?\n/)
      .filter((line) => /^(open|startup|seed|apply)=/.test(line))
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

let output: string[] | undefined
const rows = (): string[] => (output ??= runHarness())

describe.skipIf(!existsSync(CSC))('WO-1557 definition-apply readback carries the axis fields', () => {
  it('prints all four carried fields on the applied A-axis readback', () => {
    const applyLine = rows().find((line) => line.startsWith('apply=')) ?? ''
    expect(applyLine).toContain('axis A applied and read back')
    expect(applyLine).toContain('currentHiLowPin=21')
    expect(applyLine).toContain('currentHiLowPinNeg=True')
    expect(applyLine).toContain('rotaryAxis=True')
    expect(applyLine).toContain('rotaryRollover=True')
  })

  it('prints all four carried fields on the startup A-axis readback', () => {
    const startupLine = rows().find((line) => line.startsWith('startup=')) ?? ''
    expect(startupLine).toContain('axis A readback')
    expect(startupLine).toContain('currentHiLowPin=21')
    expect(startupLine).toContain('currentHiLowPinNeg=True')
    expect(startupLine).toContain('rotaryAxis=True')
    expect(startupLine).toContain('rotaryRollover=True')
  })
})
