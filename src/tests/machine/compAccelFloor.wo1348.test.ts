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
    public static readonly Dictionary<int, int> AxisSettingRc = new Dictionary<int, int>();
    public static readonly Dictionary<int, double> CompAccelHeld = new Dictionary<int, double>();
`)
  source = replaceRequired(source, '            AxisSettingWrites = 0;\n', `            AxisSettingWrites = 0;
            AxisSettingRc.Clear();
            CompAccelHeld.Clear();
`)
  source = replaceRequired(
    source,
    '        if (i >= 0 && i < 6) axes[i] = _AxisSetting;\n        return 0;\n',
    `        int injectedRc;
        if (FakeBoard.AxisSettingRc.TryGetValue(i, out injectedRc)) return injectedRc;
        if (i >= 0 && i < 6)
        {
            AxisSetting held = _AxisSetting;
            double injectedHeld;
            if (FakeBoard.CompAccelHeld.TryGetValue(i, out injectedHeld)) held.CompAccel = injectedHeld;
            axes[i] = held;
        }
        return 0;
`,
  )
  return source
}

function runHarness(): string[] {
  const root = mkdtempSync(join(tmpdir(), 'liencam-wo1348-'))
  const fakeBoard = join(root, 'FakeUC100.cs')
  const harness = join(root, 'Harness.cs')
  const executable = join(root, 'Harness.exe')
  const profile = join(root, 'comp-accel.pro')
  const axes = ['X', 'Y', 'Z', 'A', 'B', 'C']

  writeFileSync(fakeBoard, instrumentFakeBoard())
  writeFileSync(
    profile,
    axes.map((axis) => `[axessettingscontrol${axis}]\r\nCompaccel=600`).join('\r\n'),
  )
  writeFileSync(harness, `
using System;
using System.Collections;
using System.Reflection;
namespace LienCAM {
public static class Harness {
  static readonly string[] Axes = { "X", "Y", "Z", "A", "B", "C" };

  static void RunCase(string label, double? held, int setRc, string profile) {
    FakeBoard.Reset();
    var plan = new Machine.DefinitionPlan();
    for (int i = 0; i < Axes.Length; i++) {
      plan.Axes.Add(new Machine.AxisPlan { Index = i, Name = Axes[i] });
      var seed = new UC100.AxisSetting(); seed.Axis = i;
      seed.CompAccel = held.HasValue ? held.Value : 600;
      UC100.SetAxisSetting(ref seed);
      if (setRc != 0) FakeBoard.AxisSettingRc[i] = setRc;
    }
    int writesBefore = FakeBoard.AxisSettingWrites;

    var machine = new Machine();
    typeof(Machine).GetMethod("ReadIni", BindingFlags.Instance | BindingFlags.NonPublic)
      .Invoke(machine, new object[] { profile });
    bool ok = (bool)typeof(Machine).GetMethod("ApplyCachedStartupSettings",
      BindingFlags.Instance | BindingFlags.NonPublic).Invoke(machine, new object[] { plan });
    var refusals = (IList)typeof(Machine).GetField("profileRefusals",
      BindingFlags.Instance | BindingFlags.NonPublic).GetValue(machine);
    Console.WriteLine(label + "|ok=" + ok + "|refusals=" + refusals.Count
      + "|writes=" + (FakeBoard.AxisSettingWrites - writesBefore));
    foreach (object refusal in refusals) Console.WriteLine(label + "|refusal|" + refusal);
    foreach (Machine.ReportLine line in machine.OpenReport())
      if (line.Text.IndexOf("cached ", StringComparison.Ordinal) >= 0
          && line.Text.IndexOf(" comp accel readback=", StringComparison.Ordinal) >= 0)
        Console.WriteLine(label + "|" + line.Severity + "|" + line.Text);
  }

  public static void Main(string[] args) {
    RunCase("higher", 1200, 0, args[0]);
    RunCase("lower", 480, 0, args[0]);
    RunCase("exact", 600, 0, args[0]);
    RunCase("failed", null, 7, args[0]);
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
    try {
      return execFileSync(executable, [profile], { encoding: 'utf8' })
        .trim().split(/\r?\n/).filter((line) => /^(higher|lower|exact|failed)\|/.test(line))
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

describe.skipIf(!existsSync(CSC))('WO-1348 comp-acceleration readback policy through Machine.cs', () => {
  it('accepts a board-enforced floor and reports asked and held for all six axes', () => {
    const actual = rows('higher')
    expect(actual[0]).toBe('higher|ok=True|refusals=0|writes=0')
    expect(actual.slice(1)).toHaveLength(6)
    for (const axis of ['X', 'Y', 'Z', 'A', 'B', 'C']) {
      expect(actual).toContain(
        `higher|info|[bridge] cached ${axis} comp accel readback=1200: asked 600, held 1200 - the board enforces a comp-acceleration floor; motion remains allowed`,
      )
    }
  })

  it('accepts a board ceiling and plainly reports the acceleration each axis will use', () => {
    const actual = rows('lower')
    expect(actual[0]).toBe('lower|ok=True|refusals=0|writes=0')
    expect(actual.slice(1)).toHaveLength(6)
    for (const axis of ['X', 'Y', 'Z', 'A', 'B', 'C']) {
      expect(actual).toContain(
        `lower|warn|[bridge] cached ${axis} comp accel readback=480: asked 600, held 480 - the board capped it, so this axis will accelerate at the held value; motion remains allowed`,
      )
    }
  })

  it('accepts an exact readback and prints every per-axis pair', () => {
    const actual = rows('exact')
    expect(actual[0]).toBe('exact|ok=True|refusals=0|writes=0')
    expect(actual.slice(1)).toHaveLength(6)
    for (const axis of ['X', 'Y', 'Z', 'A', 'B', 'C']) {
      expect(actual).toContain(
        `exact|info|[bridge] cached ${axis} comp accel readback=600: asked 600, held 600; motion remains allowed`,
      )
    }
  })

  it('never reaches an injected SetAxisSetting refusal on the read-only cached path', () => {
    const actual = rows('failed')
    expect(actual[0]).toBe('failed|ok=True|refusals=0|writes=0')
    expect(actual.slice(1)).toHaveLength(6)
    expect(actual[1]).toBe(
      'failed|info|[bridge] cached X comp accel readback=600: asked 600, held 600; motion remains allowed',
    )
  })
})
