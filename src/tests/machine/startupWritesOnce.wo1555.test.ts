import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// WO-1555: every bridge start printed "RE-HOME REQUIRED for Z" because the
// one-time profile import wrote the .pro's Z min -0.1 and the cached operator
// edit (Z min 0) was then applied over it - a "change" the bridge made itself.

const BRIDGE_DIR = resolve('pendant/uccnc-bridge')
const FAKE_BOARD_SOURCE = resolve('src/tests/evidence/WO-1326/FakeUC100.cs')
const CSC = join(
  process.env.WINDIR ?? 'C:\\Windows',
  'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe',
)

function runHarness(): string {
  const root = mkdtempSync(join(tmpdir(), 'liencam-wo1555-'))
  const source = join(root, 'Harness.cs')
  const executable = join(root, 'Harness.exe')
  const profile = join(root, 'machine.pro')

  writeFileSync(profile, [
    '[Generalsettings]',
    'Constantvelocitymode=True', 'Stopatangle=89', 'Linearerror=0.03',
    'Cornerserror=0.03', 'USBbuffersize=0.1', 'Softlimitsenable=True',
    '[axessettingscontrolZ]',
    'Axisenabled=True', 'Stepsperunit=400', 'Velocity=6000', 'Acceleration=800',
    'Compaccel=800', 'Softlimitnegative=-0.1', 'Softlimitpositive=129.1',
    'Stepportnumber=1', 'Steppinnumber=15', 'Dirportnumber=1', 'Dirpinnumber=16',
    'Currhilowportnumber=1', 'Currhilowpinnumber=10', 'Currhilowpinnegate=True',
    'Homebackoff=4', 'Homedirectionpositive=True', 'Homingvalue=0',
    '',
  ].join('\r\n'))

  writeFileSync(source, `
using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
namespace LienCAM {
public static class Harness {
  static Json.Obj Pin(double port, double pin) {
    var value = new Json.Obj(); value.Set("port", port); value.Set("pin", pin);
    value.Set("negate", false); return value;
  }
  static Machine.DefinitionPlan Plan(double stepsPerUnit, double zMin) {
    var axis = new Json.Obj(); axis.Set("axis", "Z"); axis.Set("enabled", true);
    axis.Set("stepsPerUnit", stepsPerUnit); axis.Set("maxVelocity", 6000.0);
    axis.Set("acceleration", 800.0); axis.Set("softLimitMin", zMin);
    axis.Set("softLimitMax", 129.1); axis.Set("slaveAxis", null);
    axis.Set("stepPin", Pin(1, 15)); axis.Set("dirPin", Pin(1, 16));
    axis.Set("enablePin", Pin(1, 14));
    var home = new Json.Obj(); home.Set("direction", "positive");
    home.Set("fastSpeed", 1500.0); home.Set("slowSpeed", 375.0);
    home.Set("backOff", 4.0); home.Set("homingValue", 0.0); home.Set("autoZero", true);
    var perAxis = new Json.Obj(); perAxis.Set("Z", home);
    var homing = new Json.Obj(); homing.Set("perAxis", perAxis);
    var def = new Json.Obj(); def.Set("axes", new List<object> { axis });
    def.Set("homing", homing); def.Set("settings", new List<object>());
    object parsed; Json.TryParse(Json.Write(def), out parsed);
    Machine.DefinitionPlan plan; string err;
    if (!Machine.ParseDefinition(parsed, out plan, out err)) throw new Exception(err);
    return plan;
  }
  static UC100.AxisSetting ReadZ() {
    var a = new UC100.AxisSetting(); a.Axis = 2; UC100.GetAxisSetting(ref a); return a;
  }
  // A board that was just powered holds none of the bridge's settings.
  static void PowerCycleBoard() {
    var blank = new UC100.AxisSetting(); blank.Axis = 2; UC100.SetAxisSetting(ref blank);
    FakeBoard.Reset();
  }
  static bool[] Homed(Machine m) {
    return (bool[])typeof(Machine).GetField("homedThisSession",
      BindingFlags.NonPublic | BindingFlags.Instance).GetValue(m);
  }
  static string Opened(string label, Machine m, bool open) {
    var z = ReadZ();
    return label + "=" + open + "|writes=" + FakeBoard.AxisSettingWrites
      + "|zmin=" + z.SoftLimitN + "|zmax=" + z.SoftLimitP;
  }
  public static void Main(string[] args) {
    BoardOwner.Start();
    string refusal = null;
    BoardOwner.Run(BoardOwner.Class.Normal, "WO-1555 startup harness", delegate {
      // Seed: the operator's edit (Z min 0) cached on top of the .pro import.
      PowerCycleBoard();
      var seed = new Machine();
      seed.Open(-19, args[0]);
      Machine.ApplyResult edit = seed.ApplyDefinition(Plan(400, 0), "WO-1555 operator edit");
      Console.WriteLine("seed=" + edit.Ok);
      string cacheText = File.ReadAllText(Machine.DefinitionCachePath());
      seed.Close();

      // The one-time upgrade: a cache without the whole-struct seed makes Open
      // read the .pro once. The start must write Z once, as the cached 0.
      object cache; Json.TryParse(cacheText, out cache);
      var legacy = new Json.Obj();
      legacy.Set("definition", Json.Get(cache, "definition"));
      legacy.Set("profileBaseline", Json.Get(cache, "profileBaseline"));
      File.WriteAllText(Machine.DefinitionCachePath(), Json.Write(legacy));
      PowerCycleBoard();
      Console.WriteLine("===upgrade-start");
      var upgrade = new Machine();
      bool upgradeOpen = upgrade.Open(-19, args[0]);
      Console.WriteLine("===end");
      Console.WriteLine(Opened("upgrade", upgrade, upgradeOpen));
      upgrade.Close();

      // Every later start: the cache alone configures a blank board.
      PowerCycleBoard();
      Console.WriteLine("===cached-start");
      var cached = new Machine();
      bool cachedOpen = cached.Open(-19, args[0]);
      Console.WriteLine("===end");
      Console.WriteLine(Opened("cached", cached, cachedOpen));

      // A soft-limit change on a homed session moves no steps.
      Homed(cached)[2] = true;
      Machine.ApplyResult limit = cached.ApplyDefinition(Plan(400, 1), "WO-1555 limit edit");
      Console.WriteLine("limit=" + limit.Ok + "|rehome=" + string.Join(",", limit.ReHome.ToArray())
        + "|homed=" + Homed(cached)[2]);

      // Steps per unit changes what the counter means: the datum is revoked.
      Machine.ApplyResult steps = cached.ApplyDefinition(Plan(800, 1), "WO-1555 steps edit");
      Console.WriteLine("steps=" + steps.Ok + "|rehome=" + string.Join(",", steps.ReHome.ToArray())
        + "|homed=" + Homed(cached)[2]);
      cached.Close();
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
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

let output: string | undefined
const stdout = (): string => (output ??= runHarness())
const row = (key: string): string =>
  stdout().split(/\r?\n/).find((line) => line.startsWith(`${key}=`)) ?? `${key}: missing`
const section = (name: string): string => {
  const start = stdout().indexOf(`===${name}`)
  return start < 0 ? '' : stdout().slice(start, stdout().indexOf('===end', start))
}

describe.skipIf(!existsSync(CSC))('WO-1555 bridge start writes the definition once', () => {
  it('seeds the operator edit through a real apply', () => {
    expect(row('seed')).toBe('seed=True')
  })

  it('writes Z once, as the cached 0, on the start that imports the .pro', () => {
    expect(row('upgrade')).toBe('upgrade=True|writes=1|zmin=0|zmax=129.1')
    expect(section('upgrade-start')).not.toBe('')
    expect(section('upgrade-start')).not.toContain('RE-HOME')
  })

  it('writes Z once and demands no re-home on a cached start of a blank board', () => {
    expect(row('cached')).toBe('cached=True|writes=1|zmin=0|zmax=129.1')
    expect(section('cached-start')).not.toBe('')
    expect(section('cached-start')).not.toContain('RE-HOME')
  })

  it('keeps the datum when only a soft limit changes', () => {
    expect(row('limit')).toBe('limit=True|rehome=|homed=True')
  })

  it('revokes the datum when steps per unit change on a homed axis', () => {
    expect(row('steps')).toBe('steps=True|rehome=Z|homed=False')
  })
})
