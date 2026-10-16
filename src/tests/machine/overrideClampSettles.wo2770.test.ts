import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// WO-2770 - AN OVERRIDE THE BOARD ACCEPTS NEVER SAYS THE CONTROLLER CLAMPED IT.
//
// the owner's board, 2026-10-13 run 2 (WO-2669, origin wo/WO-2669 5ad85a8e1,
// machine-2026-10-13/run2/harness.log): 7 of 7 Feed override changes answered
// "the controller clamped the feed override to 100% (asked for 50%)" and the
// like. The board took every one - its status frames show the new percent
// 16-51 ms after the call. Machine.cs SetOverride read GetFRO back the instant
// SetFRO returned, which is the value from before the press.
//
// The REAL Machine.cs (and Bridge.cs, for the real BoardOwner) compiled with
// csc against the WO-1326 fake board. The fake is copied to a temp dir and its
// six override entry points patched so a set lands LAG ms later, exactly as the
// board measured; a ceiling/floor makes it hold a value away from the request,
// which is a GENUINE clamp. The harness names no WO-2770 symbol, so the same
// file compiles against main's Machine.cs as the negative control.

const BRIDGE_DIR = resolve('pendant/uccnc-bridge')
const FAKE_BOARD_SOURCE = resolve('src/tests/evidence/WO-1326/FakeUC100.cs')
const CSC = join(
  process.env.WINDIR ?? 'C:\\Windows',
  'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe',
)

/** The fake's six override entry points, each replaced by the lagging board. */
const OVERRIDE_ENTRY_POINTS: Array<[RegExp, string]> = [
  [/public static int SetFRO\(double FRO\) \{[^}]*\}/, 'public static int SetFRO(double FRO) { return LienCAM.Wo2770Board.Set(0, FRO); }'],
  [/public static int GetFRO\(ref double FRO\) \{[^}]*\}/, 'public static int GetFRO(ref double FRO) { FRO = LienCAM.Wo2770Board.Get(0); return 0; }'],
  [/public static int SetJRO\(double JRO\) \{[^}]*\}/, 'public static int SetJRO(double JRO) { return LienCAM.Wo2770Board.Set(1, JRO); }'],
  [/public static int GetJRO\(ref double JRO\) \{[^}]*\}/, 'public static int GetJRO(ref double JRO) { JRO = LienCAM.Wo2770Board.Get(1); return 0; }'],
  [/public static int SetSRO\(double SRO\) \{[^}]*\}/, 'public static int SetSRO(double SRO) { return LienCAM.Wo2770Board.Set(2, SRO); }'],
  [/public static int GetSRO\(ref double SRO\) \{[^}]*\}/, 'public static int GetSRO(ref double SRO) { SRO = LienCAM.Wo2770Board.Get(2); return 0; }'],
]

const HARNESS = `
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Reflection;
using System.Threading;
namespace LienCAM {
/** The board: a set is held LagMs after the call, then readback shows it,
 *  limited to [Floor, Ceiling]. Channel 0 feed, 1 jog ("rapid"), 2 spindle. */
public static class Wo2770Board {
  static readonly object gate = new object();
  static readonly Stopwatch clock = Stopwatch.StartNew();
  public static int LagMs;
  public static readonly double[] Value = new double[3];
  public static readonly double[] Ceiling = new double[3];
  public static readonly double[] Floor = new double[3];
  static readonly double[] pending = new double[3];
  static readonly bool[] hasPending = new bool[3];
  static readonly long[] pendingAt = new long[3];
  public static void Reset(int lagMs) {
    lock (gate) {
      LagMs = lagMs;
      for (int i = 0; i < 3; i++) { Value[i] = 100; Ceiling[i] = 250; Floor[i] = 1; hasPending[i] = false; }
    }
  }
  public static int Set(int ch, double v) {
    lock (gate) { pending[ch] = v; hasPending[ch] = true; pendingAt[ch] = clock.ElapsedMilliseconds; }
    return 0;
  }
  public static double Get(int ch) {
    lock (gate) {
      if (hasPending[ch] && clock.ElapsedMilliseconds - pendingAt[ch] >= LagMs) {
        Value[ch] = Math.Max(Floor[ch], Math.Min(Ceiling[ch], pending[ch]));
        hasPending[ch] = false;
      }
      return Value[ch];
    }
  }
}
public static class Wo2770OverrideHarness {
  static readonly BindingFlags Priv = BindingFlags.NonPublic | BindingFlags.Instance;
  static void SetField(Machine m, string name, object v) {
    FieldInfo f = typeof(Machine).GetField(name, Priv);
    if (f == null) throw new Exception("Machine has no field '" + name + "' - the harness is stale");
    f.SetValue(m, v);
  }
  static Machine Primed() {
    Machine m = new Machine();
    SetField(m, "opened", true);
    SetField(m, "sentinelPassed", true);
    SetField(m, "pinTable", BoardPinTables.AxbbE);
    SetField(m, "readOnly", false);
    m.LiveConsole = delegate(string text, string severity) { };
    return m;
  }
  static int Channel(string kind) { return kind == "feed" ? 0 : kind == "spindle" ? 2 : 1; }
  static Dictionary<string, object> Change(string kind, string to, double value) {
    var c = new Dictionary<string, object>();
    c["kind"] = kind; c["to"] = to;
    if (to == "percent") c["percent"] = value;
    if (to == "step") { c["direction"] = value; c["coarse"] = true; }
    return c;
  }
  static string Show(object v) { return v == null ? "null" : v.ToString(); }

  /** One press, as Bridge.cs's setOverride case makes it. */
  static void Press(string label, Machine m, string kind, string to, double value) {
    string err, note;
    var sw = Stopwatch.StartNew();
    bool ok = m.SetOverride(Change(kind, to, value), out err, out note);
    long ms = sw.ElapsedMilliseconds;
    Thread.Sleep(Wo2770Board.LagMs + 20);
    Console.WriteLine(label + ".ok=" + ok);
    Console.WriteLine(label + ".err=" + Show(err));
    Console.WriteLine(label + ".note=" + Show(note));
    Console.WriteLine(label + ".ms=" + ms);
    Console.WriteLine(label + ".held=" + Wo2770Board.Get(Channel(kind)).ToString("0.#", CultureInfo.InvariantCulture));
  }

  public static void Main(string[] args) {
    FakeBoard.Reset();
    Machine m = Primed();

    // 1. Accepted at the board's measured timing: 16, 35 and 51 ms.
    foreach (int lag in new[] { 16, 35, 51 }) {
      Wo2770Board.Reset(lag);
      Press("feed50lag" + lag, m, "feed", "percent", 50);
    }
    Wo2770Board.Reset(51);
    Press("feedStepDown", m, "feed", "step", -1);
    Wo2770Board.Reset(51); Wo2770Board.Value[0] = 50;
    Press("feedReset", m, "feed", "reset", 0);
    Wo2770Board.Reset(51);
    Press("rapid25", m, "rapid", "percent", 25);
    Wo2770Board.Reset(51);
    Press("spindle80", m, "spindle", "percent", 80);
    Wo2770Board.Reset(0);
    Press("feedAtOnce", m, "feed", "percent", 70);

    // 2. WO-2670's quick clicks: Feed -10 x5 then +10 x5, 60 ms apart.
    Wo2770Board.Reset(51);
    int notes = 0; string firstNote = "null";
    for (int i = 0; i < 10; i++) {
      string err, note;
      m.SetOverride(Change("feed", "step", i < 5 ? -1 : 1), out err, out note);
      if (note != null) { notes++; if (firstNote == "null") firstNote = note; }
      if (i == 4) { Thread.Sleep(60); Console.WriteLine("clicks.low=" + Wo2770Board.Get(0)); }
      else Thread.Sleep(60);
    }
    Console.WriteLine("clicks.notes=" + notes);
    Console.WriteLine("clicks.firstNote=" + firstNote);
    Console.WriteLine("clicks.end=" + Wo2770Board.Get(0));

    // 3. Genuine clamps: the board holds a value away from the request.
    Wo2770Board.Reset(35); Wo2770Board.Ceiling[0] = 150;
    Press("ceiling", m, "feed", "percent", 200);
    Wo2770Board.Reset(35); Wo2770Board.Ceiling[0] = 150; Wo2770Board.Value[0] = 150;
    Press("atCeiling", m, "feed", "percent", 200);
    Wo2770Board.Reset(35); Wo2770Board.Floor[2] = 10;
    Press("spindleFloor", m, "spindle", "percent", 5);
    Wo2770Board.Reset(0); Wo2770Board.Ceiling[0] = 150;
    Press("ceilingAtOnce", m, "feed", "percent", 200);

    // 4. A stop posted while the readback is still being judged runs first.
    BoardOwner.Start();
    Wo2770Board.Reset(35); Wo2770Board.Ceiling[0] = 150; Wo2770Board.Value[0] = 150;
    string stopNote = "unset"; long stopMs = -1; bool stopRan = false; string refusal;
    var posted = new ManualResetEvent(false);
    var poster = new Thread(delegate() {
      Thread.Sleep(10);
      string r;
      BoardOwner.Post(BoardOwner.Class.StopNow, "wo2770 stop", delegate { stopRan = true; }, out r);
      posted.Set();
    });
    poster.Start();
    BoardOwner.Run(BoardOwner.Class.Normal, "setOverride", delegate {
      string err, note;
      var sw = Stopwatch.StartNew();
      m.SetOverride(Change("feed", "percent", 200), out err, out note);
      stopMs = sw.ElapsedMilliseconds;
      stopNote = Show(note);
    }, 5000, out refusal);
    posted.WaitOne(2000);
    BoardOwner.Run(BoardOwner.Class.Normal, "drain", delegate { }, 2000, out refusal);
    Console.WriteLine("stop.note=" + stopNote);
    Console.WriteLine("stop.ms=" + stopMs);
    Console.WriteLine("stop.ran=" + stopRan);

    Console.WriteLine("harness.done=True");
  }
}}
`

function runHarness(): Map<string, string> {
  const root = mkdtempSync(join(tmpdir(), 'liencam-wo2770-'))
  const source = join(root, 'Harness.cs')
  const fake = join(root, 'FakeUC100.cs')
  const executable = join(root, 'Harness.exe')
  let fakeSource = readFileSync(FAKE_BOARD_SOURCE, 'utf8')
  for (const [pattern, replacement] of OVERRIDE_ENTRY_POINTS) {
    if (!pattern.test(fakeSource)) throw new Error(`WO-1326 fake board no longer has ${pattern}`)
    fakeSource = fakeSource.replace(pattern, replacement)
  }
  writeFileSync(fake, fakeSource)
  writeFileSync(source, HARNESS)
  try {
    try {
      execFileSync(CSC, [
        '/nologo', '/unsafe', `/out:${executable}`, '/main:LienCAM.Wo2770OverrideHarness',
        resolve(BRIDGE_DIR, 'Bridge.cs'), resolve(BRIDGE_DIR, 'Machine.cs'),
        resolve(BRIDGE_DIR, 'Json.cs'), resolve(BRIDGE_DIR, 'Vfd.cs'),
        fake, source,
      ], { stdio: 'pipe', encoding: 'utf8' })
    } catch (error) {
      throw new Error(`csc failed:\n${String((error as { stdout?: string }).stdout ?? error)}`)
    }
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

describe.skipIf(!existsSync(CSC))('WO-2770 bridge: an override the board accepts never says it was clamped', () => {
  it('ran every scenario', () => {
    expect(row('harness.done')).toBe('True')
  }, 120_000)

  it.each(['feed50lag16', 'feed50lag35', 'feed50lag51'])(
    '%s: Feed 50%% the board takes after that lag gets no clamp note and holds 50',
    (label) => {
      expect(row(`${label}.ok`)).toBe('True')
      expect(row(`${label}.note`)).toBe('null')
      expect(row(`${label}.held`)).toBe('50')
    },
  )

  it('Feed step, Feed reset, Rapid (jog) and Spindle presses at 51 ms: no clamp note', () => {
    expect(row('feedStepDown.note')).toBe('null')
    expect(row('feedStepDown.held')).toBe('90')
    expect(row('feedReset.note')).toBe('null')
    expect(row('feedReset.held')).toBe('100')
    expect(row('rapid25.note')).toBe('null')
    expect(row('rapid25.held')).toBe('25')
    expect(row('spindle80.note')).toBe('null')
    expect(row('spindle80.held')).toBe('80')
  })

  it('a board that applies at once still answers without a note', () => {
    expect(row('feedAtOnce.note')).toBe('null')
    expect(row('feedAtOnce.held')).toBe('70')
  })

  it("WO-2670's quick clicks (Feed -10 x5, +10 x5, 60 ms apart) reach 50 and 100 with no note", () => {
    expect(row('clicks.firstNote')).toBe('null')
    expect(row('clicks.notes')).toBe('0')
    expect(row('clicks.low')).toBe('50')
    expect(row('clicks.end')).toBe('100')
  })

  it('a genuine clamp names what the board holds and what was asked, once', () => {
    expect(row('ceiling.ok')).toBe('True')
    expect(row('ceiling.note')).toBe('the controller clamped the feed override to 150% (asked for 200%)')
    expect(row('atCeiling.note')).toBe('the controller clamped the feed override to 150% (asked for 200%)')
    expect(row('spindleFloor.note')).toBe('the controller clamped the spindle override to 10% (asked for 5%)')
    expect(row('ceilingAtOnce.note')).toBe('the controller clamped the feed override to 150% (asked for 200%)')
  })

  it('an accepted press answers as soon as the board shows it; a clamp within the settle window', () => {
    for (const label of ['feed50lag16', 'feed50lag35', 'feed50lag51', 'rapid25', 'spindle80']) {
      expect(Number(row(`${label}.ms`))).toBeLessThan(140)
    }
    expect(Number(row('ceiling.ms'))).toBeLessThan(400)
  })

  it('a stop posted while the readback is being judged is not held behind it, and no unjudged note goes out', () => {
    expect(row('stop.ran')).toBe('True')
    expect(row('stop.note')).toBe('null')
    expect(Number(row('stop.ms'))).toBeLessThan(140)
  })
})
