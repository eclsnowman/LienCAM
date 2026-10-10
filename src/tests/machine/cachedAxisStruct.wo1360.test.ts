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
  const root = mkdtempSync(join(tmpdir(), 'liencam-wo1360-'))
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
    var axis = new Json.Obj(); axis.Set("axis", "A"); axis.Set("enabled", false);
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
  static UC100.AxisSetting ReadA() {
    var a = new UC100.AxisSetting(); a.Axis = 3; UC100.GetAxisSetting(ref a); return a;
  }
  static string Fields(UC100.AxisSetting a) {
    return a.CurrentHiLowPin + "," + a.CurrentHiLowPinNeg + ","
      + a.RotaryAxis + "," + a.RotaryRollover + "," + a.HomeBackOff;
  }
  public static void Main(string[] args) {
    BoardOwner.Start();
    string refusal = null;
    BoardOwner.Run(BoardOwner.Class.Normal, "WO-1360 cached-start harness", delegate {
      FakeBoard.Reset();
      var first = new Machine();
      bool firstOpen = first.Open(-19, args[0]);
      object parsed; Json.TryParse(Json.Write(Definition()), out parsed);
      Machine.DefinitionPlan plan; string parseError;
      bool planOk = Machine.ParseDefinition(parsed, out plan, out parseError);
      Machine.ApplyResult applied = first.ApplyDefinition(plan, "WO-1360 harness");
      Console.WriteLine("seed=" + firstOpen + "," + planOk + "," + applied.Ok
        + "|fields=" + Fields(ReadA()));
      string cacheText = File.ReadAllText(Machine.DefinitionCachePath());
      Console.WriteLine("cache-has-carry=" + cacheText.Contains("axisSettingCarry"));
      first.Close();

      FakeBoard.Reset();
      var cached = new Machine();
      bool cachedOpen = cached.Open(-19, args[0]);
      Console.WriteLine("cached=" + cachedOpen + "|writes=" + FakeBoard.AxisSettingWrites
        + "|fields=" + Fields(ReadA()));
      cached.Close();

      object cache; Json.TryParse(cacheText, out cache);
      var legacy = new Json.Obj();
      legacy.Set("definition", Json.Get(cache, "definition"));
      legacy.Set("profileBaseline", Json.Get(cache, "profileBaseline"));
      File.WriteAllText(Machine.DefinitionCachePath(), Json.Write(legacy));
      FakeBoard.Reset();
      var upgraded = new Machine();
      upgraded.Open(-19, args[0]);
      string upgradedText = File.ReadAllText(Machine.DefinitionCachePath());
      Console.WriteLine("legacy-upgrade-writes=" + FakeBoard.AxisSettingWrites
        + "|fields=" + Fields(ReadA()) + "|carry=" + upgradedText.Contains("axisSettingCarry"));
      upgraded.Close();

      File.WriteAllText(Machine.DefinitionCachePath(), Json.Write(legacy));
      FakeBoard.Reset();
      var refused = new Machine();
      refused.Open(-19, null);
      string named = "none";
      foreach (Machine.ReportLine line in refused.OpenReport())
        if (line.Text.IndexOf("no bridge-owned whole-struct seed", StringComparison.Ordinal) >= 0)
          named = line.Text;
      Console.WriteLine("legacy-writes=" + FakeBoard.AxisSettingWrites + "|named=" + named);
      refused.Close();
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
      .filter((line) => /^(seed|cache-has-carry|cached|legacy-upgrade-writes|legacy-writes)=/.test(line))
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

let output: string[] | undefined
const rows = (): string[] => (output ??= runHarness())

describe.skipIf(!existsSync(CSC))('WO-1360 cached-start whole-axis seed', () => {
  it('captures all five carried fields from the deliberate profile and definition writes', () => {
    expect(rows()).toContain('seed=True,True,True|fields=21,True,True,True,-4')
    expect(rows()).toContain('cache-has-carry=True')
  })

  it('restores the five fields before the first cached definition write', () => {
    expect(rows()).toContain('cached=True|writes=1|fields=21,True,True,True,-4')
  })

  it('makes no axis write when a legacy cache cannot supply the complete struct', () => {
    const row = rows().find((line) => line.startsWith('legacy-writes='))
    expect(row).toContain('legacy-writes=0|named=')
    expect(row).toContain('axis A has no bridge-owned whole-struct seed')
  })

  it('upgrades a legacy cache once when its configured profile is available', () => {
    expect(rows()).toContain(
      // WO-1555: the legacy upgrade now writes each described axis ONCE (the .pro overlaid with the cache),
      // not the .pro and then the cache. Same 21 fields, same carried settings.
      'legacy-upgrade-writes=1|fields=21,True,True,True,-4|carry=True',
    )
  })
})
