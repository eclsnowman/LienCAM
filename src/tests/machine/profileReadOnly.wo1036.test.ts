/**
 * WO-1036 / ADR-0044 requirement 1: NOTHING IN THE BRIDGE WRITES THE .pro.
 *
 * Operator, 2026-08-26, marked non-negotiable: "We do not write to the UCCNC .pro,
 * that is that softwares property... not ours. We READ ONLY the .pro."
 *
 * WHY THIS TEST IS A SOURCE SCAN AND NOT A BEHAVIOUR TEST. The write lived in
 * C# (`Machine.PersistWorkOffset`), and the thing being forbidden is a code
 * path existing at all - the order's own words: "The method is removed, not
 * flagged off - a disabled write is one edit away from being a live one." A
 * behavioural test can only prove the paths it happens to walk; it cannot prove
 * a write does not exist somewhere else in 4,500 lines of C# that vitest cannot
 * execute. Scanning the source proves the stronger claim, and it is the one the
 * order asks for.
 *
 * The measured sha256 of Operator's real profile across a full set-work-zero cycle
 * on the demo board is in `src/tests/evidence/WO-1036/`. That is the evidence
 * the write is gone; this is the armor that keeps it gone.
 */
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const BRIDGE_DIR = join(process.cwd(), 'pendant/uccnc-bridge')
const FAKE_BOARD_SOURCE = join(
  process.cwd(), 'src/tests/evidence/WO-1326/FakeUC100.cs',
)

const SOURCES = readdirSync(BRIDGE_DIR)
  .filter((f) => f.endsWith('.cs'))
  // UC100_wrapper.cs is CNCdrive's, copied in at build time from the UCCNC
  // install - not ours to police and not always present.
  .filter((f) => f !== 'UC100_wrapper.cs')

const MACHINE_SOURCE = readFileSync(join(BRIDGE_DIR, 'Machine.cs'), 'utf8')
const CSC = join(
  process.env.WINDIR ?? 'C:\\Windows',
  'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe',
)

function runStartupAuthorityHarness(): string[] {
  const root = mkdtempSync(join(tmpdir(), 'liencam-wo1040-'))
  const source = join(root, 'Harness.cs')
  const executable = join(root, 'Harness.exe')
  const harness = `
using System;
using System.Collections.Generic;
namespace LienCAM {
public static class Harness {
  static Json.Obj Number(double value) { var v = new Json.Obj(); v.Set("kind", "number"); v.Set("value", value); return v; }
  static Json.Obj Boolean(bool value) { var v = new Json.Obj(); v.Set("kind", "boolean"); v.Set("value", value); return v; }
  static Json.Obj Text(string value) { var v = new Json.Obj(); v.Set("kind", "text"); v.Set("value", value); return v; }
  static Json.Obj Pin(double port, double pin) {
    var value = new Json.Obj(); value.Set("port", port); value.Set("pin", pin); value.Set("negate", false); return value;
  }
  static void Add(List<object> rows, string key, object value) {
    var row = new Json.Obj(); row.Set("controller", "uccnc"); row.Set("key", key); row.Set("value", value); rows.Add(row);
  }
  static Json.Obj Definition(List<object> settings, bool boardValid = false) {
    var axis = new Json.Obj(); axis.Set("axis", "X"); axis.Set("enabled", true);
    axis.Set("stepsPerUnit", 800.0); axis.Set("maxVelocity", 6000.0); axis.Set("acceleration", 1000.0);
    axis.Set("softLimitMin", -900.0); axis.Set("softLimitMax", 900.0); axis.Set("slaveAxis", "Y");
    axis.Set("stepPin", boardValid ? Pin(1, 15) : Pin(1, 2));
    axis.Set("dirPin", boardValid ? Pin(1, 16) : Pin(1, 3));
    axis.Set("homePin", boardValid ? Pin(2, 1) : Pin(1, 4));
    var home = new Json.Obj(); home.Set("direction", "positive"); home.Set("fastSpeed", 1500.0);
    home.Set("slowSpeed", 375.0); home.Set("backOff", 2.0); home.Set("homingValue", 7.0);
    var perAxis = new Json.Obj(); perAxis.Set("X", home); var homing = new Json.Obj(); homing.Set("perAxis", perAxis);
    var statedRow = new Json.Obj(); statedRow.Set("controller", "uccnc"); statedRow.Set("key", "axessettingscontrolX.Homebackoff");
    var statedSteps = new Json.Obj(); statedSteps.Set("controller", "uccnc"); statedSteps.Set("key", "axessettingscontrolX.Stepsperunit");
    var statedVelocity = new Json.Obj(); statedVelocity.Set("controller", "uccnc"); statedVelocity.Set("key", "axessettingscontrolX.Velocity");
    var statedAcceleration = new Json.Obj(); statedAcceleration.Set("controller", "uccnc"); statedAcceleration.Set("key", "axessettingscontrolX.Acceleration");
    var def = new Json.Obj(); def.Set("axes", new List<object> { axis }); def.Set("homing", homing);
    def.Set("stated", new List<object> { statedRow, statedSteps, statedVelocity, statedAcceleration });
    def.Set("settings", settings); return def;
  }
  static Json.Obj Baseline() {
    var trajectory = new Json.Obj();
    trajectory.Set("constantVelocity", true); trajectory.Set("stopAngle", 89.0);
    trajectory.Set("linearError", 0.03); trajectory.Set("cornerError", 0.03); trajectory.Set("usbBufferSeconds", 0.1);
    var comp = new Json.Obj(); comp.Set("X", 600.0);
    var fault = new Json.Obj(); fault.Set("enabled", true); fault.Set("activeLow", true);
    fault.Set("description", "drive fault"); fault.Set("port", 1.0); fault.Set("pin", 10.0);
    var offsets = new Json.Obj();
    foreach (string wcs in new [] { "G54", "G55", "G56", "G57", "G58", "G59" }) {
      // WO-2764: WO-1726 carries the rotary axes through offsets - a complete baseline states a/b/c too.
      var one = new Json.Obj(); one.Set("x", 0.0); one.Set("y", 0.0); one.Set("z", 0.0);
      one.Set("a", 0.0); one.Set("b", 0.0); one.Set("c", 0.0); offsets.Set(wcs, one);
    }
    var baseline = new Json.Obj(); baseline.Set("trajectory", trajectory); baseline.Set("softLimitsEnabled", true);
    baseline.Set("compAccel", comp); baseline.Set("faultSignal", fault); baseline.Set("workOffsets", offsets); return baseline;
  }
  static Json.Obj AxisSettingCarry() {
    var x = new Json.Obj(); x.Set("currentHiLowPin", 0.0); x.Set("currentHiLowPinNeg", false);
    x.Set("rotaryAxis", false); x.Set("rotaryRollover", false); x.Set("homeBackOff", -2.0);
    var all = new Json.Obj(); all.Set("X", x); return all;
  }
  static void Save(Json.Obj definition, object baseline) {
    var cache = new Json.Obj();
    if (definition != null) { cache.Set("definition", definition); cache.Set("axisSettingCarry", AxisSettingCarry()); }
    if (baseline != null) cache.Set("profileBaseline", baseline);
    System.IO.File.WriteAllText(Machine.DefinitionCachePath(), Json.Write(cache));
  }
  static void RunCachedStart(string label, Json.Obj definition, object baseline, string profile) {
    Save(definition, baseline);
    if (label != "legacy") FakeBoard.Reset();
    UC100.TrajParam cleared = new UC100.TrajParam();
    UC100.SetTrajParam(ref cleared);
    UC100.SoftLimitEnabled = false;
    UC100.SoftLimitWrites = 0;
    var bridgeMachine = new Machine();
    var opened = false;
    string refusal;
    var priorOut = Console.Out;
    bool ran;
    try {
      Console.SetOut(new System.IO.StringWriter());
      ran = BoardOwner.Run(BoardOwner.Class.Normal, "opening " + label + " cached bridge",
        delegate { opened = bridgeMachine.Open(-19, profile); }, 10000, out refusal);
    } finally { Console.SetOut(priorOut); }
    UC100.TrajParam boardTrajectory = new UC100.TrajParam();
    UC100.GetTrajParam(ref boardTrajectory);
    Console.WriteLine(label + "-open=" + (ran && opened));
    Console.WriteLine(label + "-trajectory=" + boardTrajectory.ConstantVel + "," + boardTrajectory.StopAngle
      + "," + boardTrajectory.LinearErr + "," + boardTrajectory.CornerError
      + ",usb=" + boardTrajectory.USBPufferSize);
    Console.WriteLine(label + "-soft-limit=" + UC100.SoftLimitEnabled + ",writes=" + UC100.SoftLimitWrites);
    if (label == "legacy") {
      Console.WriteLine("bridge-open=" + (ran && opened));
      Console.WriteLine("board-usb=" + boardTrajectory.USBPufferSize);
      UC100.AxisSetting boardX = new UC100.AxisSetting(); boardX.Axis = 0;
      UC100.GetAxisSetting(ref boardX);
      Console.WriteLine("board-x-steps=" + boardX.StepPer);
      Console.WriteLine("board-x-comp=" + boardX.CompAccel);
    }
  }
  public static void Main() {
    Save(null, Baseline());
    Console.WriteLine("baseline-only=" + Machine.CachedStartupSettingsSource());
    Save(Definition(new List<object>()), null);
    Console.WriteLine("empty-without-baseline=" + (Machine.CachedStartupSettingsSource() ?? "none"));
    var machine = new Machine();
    Console.WriteLine("empty-load=" + machine.LoadDefinitionSettings(Definition(new List<object>())));
    Console.WriteLine("empty-profile=" + Json.Write(machine.WorkOffsetsJson()));

    var priorRefusal = new Machine.ApplyResult(); priorRefusal.Ok = true; priorRefusal.Configured = false;
    Console.WriteLine("sticky-refusal=" + Machine.StartupConfigurationPassed(priorRefusal, true, 1));

    var rows = new List<object>();
    Add(rows, "Generalsettings.Constantvelocitymode", Boolean(true)); Add(rows, "Generalsettings.Stopatangle", Number(89));
    Add(rows, "Generalsettings.Linearerror", Number(0.03)); Add(rows, "Generalsettings.Cornerserror", Number(0.03));
    Add(rows, "Generalsettings.USBbuffersize", Number(0.1)); Add(rows, "Generalsettings.Softlimitsenable", Boolean(true));
    Add(rows, "axessettingscontrolX.Compaccel", Number(600));
    Add(rows, "FaultSignals.Enable1", Boolean(true)); Add(rows, "FaultSignals.ActiveLow1", Boolean(true));
    Add(rows, "FaultSignals.Description1", Text("drive fault")); Add(rows, "FaultSignals.Port1", Number(3)); Add(rows, "FaultSignals.Pin1", Number(13));
    foreach (string wcs in new [] { "G54", "G55", "G56", "G57", "G58", "G59" }) {
      Add(rows, "Workoffset_" + wcs + ".WorkoffsetX", Number(0));
      Add(rows, "Workoffset_" + wcs + ".WorkoffsetY", Number(0));
      Add(rows, "Workoffset_" + wcs + ".WorkoffsetZ", Number(0));
    }
    Save(Definition(rows), Baseline());
    Console.WriteLine("complete-settings=" + Machine.CachedStartupSettingsSource());

    var definition = Definition(rows); object parsedDefinition; Json.TryParse(Json.Write(definition), out parsedDefinition);
    Machine.DefinitionPlan plan; string parseError;
    bool parsed = Machine.ParseDefinition(parsedDefinition, out plan, out parseError);
    Console.WriteLine("parse=" + parsed + (parseError == null ? "" : ":" + parseError));
    machine.LoadDefinitionSettings(parsedDefinition); machine.ReconcileCacheWithProfile(plan, parsedDefinition);
    var x = plan.Axes[0];
    Console.WriteLine("sparse-preserves=" + x.Enabled + "," + x.StepsPerUnit + "," + x.Acceleration
      + "," + x.SoftLimitMin + "/" + x.SoftLimitMax + ",slave=" + x.SlaveAxis
      + ",step=" + x.StepPort + "/" + x.StepPinNo + ",home=" + x.HomePort + "/" + x.HomePinNo
      + ",backoff-stated=" + x.HomeBackOffStated);
    double parsedBuffer;
    Console.WriteLine("usb-valid=" + Machine.TryUsbBufferSeconds("0.2", out parsedBuffer));
    Console.WriteLine("usb-low=" + Machine.TryUsbBufferSeconds("0", out parsedBuffer));
    Console.WriteLine("usb-high=" + Machine.TryUsbBufferSeconds("5", out parsedBuffer));

    // Start the production Machine.Open path from three cache shapes, then ask
    // the fake board what actually reached it. Definition values win field by
    // field; only absent fields fall back to the bridge-owned profileBaseline.
    string profile = System.IO.Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "conflicting.pro");
    System.IO.File.WriteAllText(profile,
      "[Generalsettings]\\r\\nConstantvelocitymode=False\\r\\nStopatangle=45\\r\\nLinearerror=0.5\\r\\nCornerserror=0.5\\r\\nUSBbuffersize=0.2\\r\\nSoftlimitsenable=False\\r\\n"
      + "[axessettingscontrolX]\\r\\nAxisenable=True\\r\\nStepsperunit=1600\\r\\nAcceleration=1200\\r\\nCompaccel=1200\\r\\n");
    Save(Definition(rows, true), Baseline());
    FakeBoard.Reset();
    BoardOwner.Start();
    var opened = false;
    var bridgeMachine = new Machine();
    string refusal;
    var priorOut = Console.Out;
    bool ran;
    try {
      Console.SetOut(new System.IO.StringWriter());
      ran = BoardOwner.Run(BoardOwner.Class.Normal, "opening the conflicting-profile bridge",
        delegate { opened = bridgeMachine.Open(-19, profile); }, 10000, out refusal);
    } finally { Console.SetOut(priorOut); }
    UC100.TrajParam boardTrajectory = new UC100.TrajParam();
    UC100.GetTrajParam(ref boardTrajectory);
    UC100.AxisSetting boardX = new UC100.AxisSetting(); boardX.Axis = 0;
    UC100.GetAxisSetting(ref boardX);
    Console.WriteLine("bridge-open=" + (ran && opened));
    Console.WriteLine("board-usb=" + boardTrajectory.USBPufferSize);
    Console.WriteLine("board-x-steps=" + boardX.StepPer);
    Console.WriteLine("board-x-comp=" + boardX.CompAccel);

    RunCachedStart("absent", Definition(new List<object>(), true), Baseline(), profile);

    var partial = new List<object>();
    Add(partial, "Generalsettings.Constantvelocitymode", Boolean(false));
    Add(partial, "Generalsettings.Cornerserror", Number(0));
    Add(partial, "Generalsettings.Softlimitsenable", Boolean(false));
    RunCachedStart("partial", Definition(partial, true), Baseline(), profile);

    var complete = new List<object>();
    Add(complete, "Generalsettings.Constantvelocitymode", Boolean(false));
    Add(complete, "Generalsettings.Stopatangle", Number(45));
    Add(complete, "Generalsettings.Linearerror", Number(0.5));
    Add(complete, "Generalsettings.Cornerserror", Number(0));
    Add(complete, "Generalsettings.USBbuffersize", Number(0.2));
    Add(complete, "Generalsettings.Softlimitsenable", Boolean(false));
    Add(complete, "axessettingscontrolX.Compaccel", Number(600));
    Add(complete, "FaultSignals.Enable1", Boolean(true)); Add(complete, "FaultSignals.ActiveLow1", Boolean(true));
    Add(complete, "FaultSignals.Description1", Text("drive fault")); Add(complete, "FaultSignals.Port1", Number(3)); Add(complete, "FaultSignals.Pin1", Number(13));
    foreach (string wcs in new [] { "G54", "G55", "G56", "G57", "G58", "G59" }) {
      Add(complete, "Workoffset_" + wcs + ".WorkoffsetX", Number(0));
      Add(complete, "Workoffset_" + wcs + ".WorkoffsetY", Number(0));
      Add(complete, "Workoffset_" + wcs + ".WorkoffsetZ", Number(0));
    }
    RunCachedStart("complete", Definition(complete, true), Baseline(), profile);
  }
}}
`
  try {
    writeFileSync(source, harness)
    const fakeBoard = join(root, 'FakeUC100.cs')
    writeFileSync(fakeBoard, readFileSync(FAKE_BOARD_SOURCE, 'utf8').replace(
      'public static int SetSoftLimit(bool SoftLimitEnable) { return 0; }',
      'public static bool SoftLimitEnabled; public static int SoftLimitWrites; '
      + 'public static int SetSoftLimit(bool enabled) { SoftLimitEnabled = enabled; SoftLimitWrites++; return 0; }',
    ))
    try {
      execFileSync(CSC, [
        '/nologo', '/unsafe', `/out:${executable}`, '/main:LienCAM.Harness',
        resolve(BRIDGE_DIR, 'Bridge.cs'), resolve(BRIDGE_DIR, 'Machine.cs'),
        resolve(BRIDGE_DIR, 'Json.cs'), resolve(BRIDGE_DIR, 'Vfd.cs'),
        fakeBoard, source,
      ], { stdio: 'pipe' })
    } catch (error) {
      const compile = error as { stdout?: Buffer, stderr?: Buffer }
      throw new Error(`${compile.stdout?.toString() ?? ''}${compile.stderr?.toString() ?? ''}`)
    }
    try {
      return execFileSync(executable, { encoding: 'utf8' }).trim().split(/\r?\n/)
    } catch (error) {
      const run = error as { stdout?: Buffer | string, stderr?: Buffer | string }
      throw new Error(`${run.stdout?.toString() ?? ''}${run.stderr?.toString() ?? ''}`)
    }
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

let startupAuthorityOutput: string[] | undefined
function startupAuthorityHarnessOutput(): string[] {
  startupAuthorityOutput ??= runStartupAuthorityHarness()
  return startupAuthorityOutput
}

/** Strip // and block comments, so a comment ABOUT the removed write - and
 *  this order's own explanation of why it is gone - is not mistaken for one. */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
}

describe('WO-1036: the bridge never writes the operator\'s .pro', () => {
  it('has C# sources to scan', () => {
    expect(SOURCES.length).toBeGreaterThan(0)
  })

  it.each(SOURCES)('%s contains no write to a profile path', (file) => {
    const src = code(readFileSync(join(BRIDGE_DIR, file), 'utf8'))

    // Every .NET call that could put bytes into the operator's file. The one
    // legitimate write in this process is the bridge's OWN definition cache
    // beside the exe (DefinitionCachePath) - ours to write, so it is allowed
    // by target, not by absence.
    const writes = [
      ...src.matchAll(/\bFile\.(WriteAll\w+|AppendAll\w+|Create|OpenWrite|Replace|Move|Delete)\s*\(([^;]*)/g),
      ...src.matchAll(/\bnew\s+(StreamWriter|FileStream)\s*\(([^;]*)/g),
    ]

    for (const m of writes) {
      const target = m[2] ?? ''
      // 2026-08-29 (d841314c): the bridge's own LOG FILE, `liencam-bridge.log`
      // beside the exe. `TeeWriter.Emit` mirrors console output into it so the
      // log survives a start with no console window, and `StartLogFile()`
      // rotates/truncates it. Allowed by the enclosing code, not by absence: the
      // write sits inside `class TeeWriter` or `StartLogFile()` and its target
      // is that log's path, never a profile.
      const before = src.slice(Math.max(0, (m.index ?? 0) - 1200), m.index ?? 0)
      const insideLog = (/class\s+TeeWriter\b/.test(before) || /\bStartLogFile\s*\(\)/.test(before))
        && /\bpath\b/.test(target)
      // WO-2845: the per-board DLL record beside the exe, likewise ours.
      const allowed = target.includes('DefinitionCachePath') || target.includes('DllPin.PathBesideBridge()') || insideLog
      expect(
        allowed,
        `${file}: ${m[0].slice(0, 90)}\n`
        + 'A write whose target is not the bridge\'s own definition cache. If this is '
        + 'a new legitimate file of OURS, add it to the allow-list above with a reason. '
        + 'If its target is the .pro, it violates ADR-0044 requirement 1.',
      ).toBe(true)
    }
  })

  it.each(SOURCES)('%s no longer carries PersistWorkOffset', (file) => {
    // Named explicitly: this is the method WO-1027 added and WO-1036 removed.
    // A reappearance by that name is the regression, and it should fail loudly
    // rather than be caught only by the generic scan above.
    const src = code(readFileSync(join(BRIDGE_DIR, file), 'utf8'))
    expect(src).not.toContain('PersistWorkOffset')
  })

  it('still sets the work zero in memory - only the file write left', () => {
    const src = readFileSync(join(BRIDGE_DIR, 'Machine.cs'), 'utf8')
    // ZeroWorkAxis must still commit the value; removing the write must not
    // have removed the feature. The order: "ZeroWorkAxis still sets the work
    // zero in bridge memory and still answers the same way."
    expect(src).toContain('offsets[activeWcs, ax] = pos[ax];')
  })

  it('tells the operator the zero does NOT survive a restart', () => {
    // The regression is accepted, but only because it is stated. A zero that
    // quietly does not survive is what cuts a part in the wrong place; one that
    // says so is one the operator can plan around. WO-1041 and the durable
    // store restore the guarantee.
    const src = readFileSync(join(BRIDGE_DIR, 'Machine.cs'), 'utf8')
    expect(src).toMatch(/does NOT survive a[\s\S]{0,40}bridge restart/)
  })

  it('WO-1040: Open reads the profile only for the one-time legacy-cache upgrade', () => {
    expect(MACHINE_SOURCE).toMatch(
      /string cachedStartupSource = CachedStartupSettingsSource\(\);[\s\S]{0,240}if \(readProfileAtOpen\)[\s\S]{0,240}ReadIni\(profilePath\);/,
    )
    expect(MACHINE_SOURCE).toContain('the .pro was not consulted')
  })

  it('WO-1040: a cache-only start reports cache-baseline and reconciles only stated cached settings', () => {
    const applyCached = MACHINE_SOURCE.slice(MACHINE_SOURCE.indexOf('void ApplyCachedDefinition('))
    expect(applyCached).toContain('definitionSourceLabel = readProfileAtOpen ? "profile" : "cache-baseline";')
    const loaded = applyCached.indexOf('bool loadedSettings = LoadDefinitionSettings(definition);')
    const reconciled = applyCached.indexOf('ReconcileCacheWithProfile(plan, parsed);')
    const applied = applyCached.indexOf('r = ApplyDefinition(')
    expect(loaded).toBeGreaterThan(0)
    expect(reconciled).toBeGreaterThan(loaded)
    expect(applied).toBeGreaterThan(reconciled)
  })

  it('WO-1040: cached controller settings are applied and read back', () => {
    expect(MACHINE_SOURCE).toContain('bool ApplyCachedStartupSettings(DefinitionPlan plan)')
    expect(MACHINE_SOURCE).toContain('cached trajectory readback')
    expect(MACHINE_SOURCE).toContain('cached " + axisNames[ax] + " comp accel readback=')
    expect(MACHINE_SOURCE).toContain('LoadDefinitionSettings(definition)')
    expect(MACHINE_SOURCE).toContain('LoadProfileBaseline(Json.Get(parsed, "profileBaseline"), definition)')
    expect(MACHINE_SOURCE).toContain('nothing from the five required groups was applied')
  })

  it.skipIf(!existsSync(CSC))('WO-1040: a phase-A baseline-only cache prevents every later profile read', () => {
    expect(startupAuthorityHarnessOutput()).toEqual([
      'baseline-only=cached profile baseline',
      'empty-without-baseline=none',
      'empty-load=False',
      // WO-2764: WO-2186 reports the rotation each WCS holds beside its offset.
      'empty-profile={"current":{"G54":{"x":0,"y":0,"z":0},"G55":{"x":0,"y":0,"z":0},"G56":{"x":0,"y":0,"z":0},"G57":{"x":0,"y":0,"z":0},"G58":{"x":0,"y":0,"z":0},"G59":{"x":0,"y":0,"z":0}},"rotation":{"G54":0,"G55":0,"G56":0,"G57":0,"G58":0,"G59":0},"profile":null}',
      'sticky-refusal=False',
      'complete-settings=cached machine definition',
      'parse=True',
      '[bridge] WO-1048: the cached imported settings contain no definition-owned keys to compare; the cached machine definition remains the authority.',
      'sparse-preserves=True,800,1000,-900/900,slave=1,step=1/2,home=1/4,backoff-stated=True',
      'usb-valid=True',
      'usb-low=False',
      'usb-high=False',
      'bridge-open=True',
      'board-usb=0.1',
      'board-x-steps=800',
      'board-x-comp=1000',
      'absent-open=True',
      'absent-trajectory=True,89,0.03,0.03,usb=0.1',
      'absent-soft-limit=True,writes=1',
      'partial-open=True',
      'partial-trajectory=False,89,0.03,0,usb=0.1',
      'partial-soft-limit=False,writes=1',
      'complete-open=True',
      'complete-trajectory=False,45,0.5,0,usb=0.2',
      'complete-soft-limit=False,writes=1',
    ])
  })

  it.skipIf(!existsSync(CSC))('WO-1040: cached values reach the board despite a conflicting .pro at bridge start', () => {
    const output = startupAuthorityHarnessOutput()
    expect(output).toContain('absent-trajectory=True,89,0.03,0.03,usb=0.1')
    expect(output).toContain('absent-soft-limit=True,writes=1')
    expect(output).toContain('partial-trajectory=False,89,0.03,0,usb=0.1')
    expect(output).toContain('partial-soft-limit=False,writes=1')
    expect(output).toContain('complete-trajectory=False,45,0.5,0,usb=0.2')
    expect(output).toContain('complete-soft-limit=False,writes=1')
    expect(output).toContain('bridge-open=True')
    expect(output).toContain('board-usb=0.1')
    expect(output).toContain('board-x-steps=800')
    expect(output).toContain('board-x-comp=1000')
  })
})
