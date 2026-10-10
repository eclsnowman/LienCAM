import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// WO-1990. The status pusher repeats an UNCHANGED frame on a timer, and it
// used to pick the slow 500 ms timer from "not moving" - read off the very
// frame whose truth was in doubt. A board that stopped answering GetStatus
// reports state=unknown, which is "not moving", so the operator's screen
// dropped to the idle cadence exactly when it knew least.
//
// Proved on the wire, through the shipping loop: the REAL Bridge.cs and
// Machine.cs are compiled with csc against the WO-1326 fake board, the real
// PushStatus thread runs over a loopback socket wrapped in the real WsFrames,
// and the harness times the status frames as a client receives them. The fake
// is patched in a temp dir only so GetStatus, GetAxisPosition and GetFeedHold
// can fail on demand - every frame is built by Machine.Status() from those
// answers. The harness names no WO-1990 symbol, so the same file compiles
// against main's Bridge.cs as the negative control.

const BRIDGE_DIR = resolve('pendant/uccnc-bridge')
const FAKE_BOARD_SOURCE = resolve('src/tests/evidence/WO-1326/FakeUC100.cs')
const CSC = join(
  process.env.WINDIR ?? 'C:\\Windows',
  'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe',
)

const SCENARIOS = [
  'idle', 'unknown', 'estopRc', 'estopInput', 'positionUnread',
  'holdUnread', 'hold', 'faultUnread', 'stalledRun', 'idleAgain',
  'probeIdle', 'probeUnread', 'softLimitLatched',
] as const
type Scenario = (typeof SCENARIOS)[number]

const HARNESS = `
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Text;
using System.Threading;
namespace LienCAM {
public static class Wo1990Board { public static int StatusRc, PositionRc, HoldRc; }
public static class Wo1990CadenceHarness {
  static readonly object gate = new object();
  static readonly List<KeyValuePair<long, string>> frames = new List<KeyValuePair<long, string>>();
  static readonly Stopwatch clock = Stopwatch.StartNew();

  static bool ReadExact(NetworkStream n, byte[] buf, int count) {
    int got = 0;
    while (got < count) { int r = n.Read(buf, got, count - got); if (r <= 0) return false; got += r; }
    return true;
  }
  static void ReadLoop(NetworkStream n) {
    try {
      var head = new byte[2];
      while (ReadExact(n, head, 2)) {
        long len = head[1] & 0x7f;
        if (len == 126) { var b = new byte[2]; ReadExact(n, b, 2); len = (b[0] << 8) | b[1]; }
        else if (len == 127) { var b = new byte[8]; ReadExact(n, b, 8); len = 0; for (int i = 0; i < 8; i++) len = (len << 8) | b[i]; }
        byte[] mask = null;
        if ((head[1] & 0x80) != 0) { mask = new byte[4]; ReadExact(n, mask, 4); }
        var data = new byte[len];
        if (!ReadExact(n, data, (int)len)) return;
        if (mask != null) for (int i = 0; i < data.Length; i++) data[i] ^= mask[i % 4];
        if ((head[0] & 0x0f) != 1) continue;
        string text = Encoding.UTF8.GetString(data);
        if (!text.StartsWith("{\\"t\\":\\"status\\"")) continue;
        lock (gate) frames.Add(new KeyValuePair<long, string>(clock.ElapsedMilliseconds, text));
      }
    } catch { }
  }

  static void Quiet() {
    Wo1990Board.StatusRc = 0; Wo1990Board.PositionRc = 0; Wo1990Board.HoldRc = 0;
    FakeBoard.StatusIdle = true; FakeBoard.StatusEstop = false; FakeBoard.FeedHoldState = false;
    FakeBoard.InputRc = 0; FakeBoard.InputWord = 1L << 9;   // the fault input reads CLEAR
  }

  static void Measure(string name, Action setup) {
    Quiet(); setup();
    Thread.Sleep(400);
    long from = clock.ElapsedMilliseconds;
    Thread.Sleep(2000);
    long to = clock.ElapsedMilliseconds;
    List<KeyValuePair<long, string>> w;
    lock (gate) w = frames.FindAll(f => f.Key >= from && f.Key <= to);
    var repeats = new List<long>();
    var distinct = new HashSet<string>();
    for (int i = 0; i < w.Count; i++) {
      distinct.Add(w[i].Value);
      if (i > 0 && w[i].Value == w[i - 1].Value) repeats.Add(w[i].Key - w[i - 1].Key);
    }
    repeats.Sort();
    long median = repeats.Count == 0 ? -1 : repeats[repeats.Count / 2];
    Console.WriteLine(name + ".frames=" + w.Count);
    Console.WriteLine(name + ".distinct=" + distinct.Count);
    Console.WriteLine(name + ".repeats=" + repeats.Count);
    Console.WriteLine(name + ".medianRepeatMs=" + median);
    Console.WriteLine(name + ".frame=" + (w.Count == 0 ? "null" : w[w.Count - 1].Value));
  }

  // faultInput: one drive-fault input (port 3 pin 13, active low), so
  // "configured but unreadable" is a frame this machine can produce.
  // probe: a probe pin (port 3 pin 12) and NO drive-fault input - the audit's
  // route, where a failed input-word read shows only as inputs.probe = null.
  static void Apply(Machine machine, bool faultInput, bool probe) {
      var axis = new Json.Obj(); axis.Set("axis", "X"); axis.Set("enabled", true);
      axis.Set("stepsPerUnit", 400.0); axis.Set("maxVelocity", 6000.0);
      axis.Set("acceleration", 800.0); axis.Set("softLimitMin", -10.0);
      axis.Set("softLimitMax", 800.0); axis.Set("slaveAxis", null);
      var pin = new Json.Obj(); pin.Set("port", 3.0); pin.Set("pin", 13.0); pin.Set("negate", true);
      var def = new Json.Obj(); def.Set("axes", new List<object> { axis });
      def.Set("stated", new List<object>()); def.Set("settings", new List<object>());
      def.Set("driveFaultInputs", faultInput ? new List<object> { pin } : new List<object>());
      if (probe) {
        var probePin = new Json.Obj(); probePin.Set("port", 3.0); probePin.Set("pin", 12.0); probePin.Set("negate", false);
        var io = new Json.Obj(); io.Set("probe", probePin);
        def.Set("io", io);
      }
      object parsed; Json.TryParse(Json.Write(def), out parsed);
      Machine.DefinitionPlan plan; string planError;
      if (!Machine.ParseDefinition(parsed, out plan, out planError)) throw new Exception("definition did not plan: " + planError);
      Machine.ApplyResult applied = machine.ApplyDefinition(plan, "WO-1990 harness");
      if (!applied.Ok) throw new Exception("definition did not apply: " + applied.Error);
  }

  public static void Main(string[] args) {
    BoardOwner.Start();
    Machine machine = null; string refusal;
    BoardOwner.Run(BoardOwner.Class.Normal, "WO-1990 cadence harness open", delegate {
      if (File.Exists(Machine.DefinitionCachePath())) File.Delete(Machine.DefinitionCachePath());
      FakeBoard.Reset(); Quiet();
      machine = new Machine();
      if (!machine.Open(19, args[0])) throw new Exception("fake AXBB-E did not open");
      Apply(machine, true, false);
    }, 60000, out refusal);
    if (refusal != null) throw new Exception(refusal);
    typeof(Bridge).GetField("machine", BindingFlags.NonPublic | BindingFlags.Static).SetValue(null, machine);

    var listener = new TcpListener(IPAddress.Loopback, 0);
    listener.Start();
    var client = new TcpClient();
    client.Connect(IPAddress.Loopback, ((IPEndPoint)listener.LocalEndpoint).Port);
    var server = listener.AcceptTcpClient();
    var ws = new WsFrames(server.GetStream());
    var reader = new Thread(() => ReadLoop(client.GetStream())); reader.IsBackground = true; reader.Start();

    Type flagType = typeof(Bridge).GetNestedType("Flag", BindingFlags.NonPublic);
    object stop = Activator.CreateInstance(flagType, true);
    MethodInfo push = typeof(Bridge).GetMethod("PushStatus", BindingFlags.NonPublic | BindingFlags.Static);
    var pusher = new Thread(() => push.Invoke(null, new object[] { ws, stop })); pusher.IsBackground = true; pusher.Start();

    Measure("idle", delegate { });
    Measure("unknown", delegate { Wo1990Board.StatusRc = (int)UC100.ReturnVal.UC100_IO_ERROR; });
    Measure("estopRc", delegate { Wo1990Board.StatusRc = (int)UC100.ReturnVal.UC100_ESTOP; });
    Measure("estopInput", delegate { FakeBoard.StatusEstop = true; });
    Measure("positionUnread", delegate { Wo1990Board.PositionRc = (int)UC100.ReturnVal.UC100_IO_ERROR; });
    Measure("holdUnread", delegate { Wo1990Board.HoldRc = (int)UC100.ReturnVal.UC100_IO_ERROR; });
    Measure("hold", delegate { FakeBoard.FeedHoldState = true; });
    Measure("faultUnread", delegate { FakeBoard.InputRc = (int)UC100.ReturnVal.UC100_IO_ERROR; });
    Measure("stalledRun", delegate { FakeBoard.StatusIdle = false; });
    Measure("idleAgain", delegate { });
    // WO-1990 audit: the same machine re-defined with a probe pin and no
    // drive-fault input. The probe is read from the shared input word; when
    // that read fails, nothing but inputs.probe says so.
    BoardOwner.Run(BoardOwner.Class.Normal, "WO-1990 probe-only definition",
      delegate { Apply(machine, false, true); }, 60000, out refusal);
    if (refusal != null) throw new Exception(refusal);
    Measure("probeIdle", delegate { });
    Measure("probeUnread", delegate { FakeBoard.InputRc = (int)UC100.ReturnVal.UC100_IO_ERROR; });
    // LAST: the WO-932 latch outlives the board flag, so it would colour any
    // scenario after it. The flag rises and clears; the frame goes back to
    // state=idle while softLimitLatched stays true.
    Measure("softLimitLatched", delegate {
      FakeBoard.StatusSoftLimit = true; Thread.Sleep(300); FakeBoard.StatusSoftLimit = false;
    });

    flagType.GetField("Stopped").SetValue(stop, true);
    Console.WriteLine("harness.done=True");
    Console.Out.Flush();
    Environment.Exit(0);
  }
}}
`

function patchFake(source: string): string {
  const swaps: Array<[RegExp, string]> = [
    [/(SStat\.SpindleDir = FakeBoard\.SpindleCcw;\s*)return 0;/, '$1return global::LienCAM.Wo1990Board.StatusRc;'],
    [/(Cpos = pc; )return 0; \}/, '$1return global::LienCAM.Wo1990Board.PositionRc; }'],
    [/(State = FakeBoard\.FeedHoldState; )return 0; \}/, '$1return global::LienCAM.Wo1990Board.HoldRc; }'],
  ]
  let out = source
  for (const [pattern, replacement] of swaps) {
    if (!pattern.test(out)) throw new Error(`WO-1326 fake changed shape; ${pattern} no longer matches`)
    out = out.replace(pattern, replacement)
  }
  return out
}

function runHarness(): Map<string, string> {
  const root = mkdtempSync(join(tmpdir(), 'liencam-wo1990-'))
  const source = join(root, 'Harness.cs')
  const fake = join(root, 'FakeUC100.cs')
  const executable = join(root, 'Harness.exe')
  const profile = join(root, 'machine.pro')
  writeFileSync(profile, [
    '[Generalsettings]',
    'Constantvelocitymode=True', 'Stopatangle=89', 'Linearerror=0.03',
    'Cornerserror=0.03', 'USBbuffersize=0.1', 'Softlimitsenable=True',
    '[axessettingscontrolX]',
    'Axisenabled=True', 'Stepsperunit=400', 'Velocity=6000', 'Acceleration=800',
    'Compaccel=800', 'Softlimitnegative=-10', 'Softlimitpositive=800',
    '[FaultSignals]',
    'Enable1=True', 'ActiveLow1=True', 'Description1=drive alarm', 'Port1=3', 'Pin1=13',
    '',
  ].join('\r\n'))
  writeFileSync(fake, patchFake(readFileSync(FAKE_BOARD_SOURCE, 'utf8')))
  writeFileSync(source, HARNESS)
  try {
    try {
      execFileSync(CSC, [
        '/nologo', '/unsafe', `/out:${executable}`, '/main:LienCAM.Wo1990CadenceHarness',
        resolve(BRIDGE_DIR, 'Bridge.cs'), resolve(BRIDGE_DIR, 'Machine.cs'),
        resolve(BRIDGE_DIR, 'Json.cs'), resolve(BRIDGE_DIR, 'Vfd.cs'), fake, source,
      ], { stdio: 'pipe' })
    } catch (error) {
      const stdout = String((error as { stdout?: Buffer }).stdout ?? '')
      throw new Error(`csc refused the WO-1990 harness:\n${stdout.split(/\r?\n/).filter((l) => / error /.test(l)).join('\n')}`)
    }
    const out = execFileSync(executable, [profile], { encoding: 'utf8', timeout: 90_000 })
    const rows = new Map<string, string>()
    for (const line of out.split(/\r?\n/)) {
      const match = /^([A-Za-z]+\.[A-Za-z]+)=(.*)$/.exec(line)
      if (match) rows.set(match[1], match[2])
    }
    rows.set('log', out)
    // Set WO1990_PRINT=1 to see every scenario's timings (the evidence rows).
    if (process.env.WO1990_PRINT) console.log(out.split(/\r?\n/).filter((l) => !/\.frame=/.test(l)).join('\n'))
    return rows
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

let output: Map<string, string> | undefined
const row = (key: string): string => (output ??= runHarness()).get(key) ?? ''
const median = (s: Scenario): number => Number(row(`${s}.medianRepeatMs`))
const status = (s: Scenario): Record<string, unknown> =>
  (JSON.parse(row(`${s}.frame`) || 'null') as { v: Record<string, unknown> } | null)?.v ?? {}

// The loop polls every ~25 ms. A 100 ms repeat lands near 100-125 ms and a
// 500 ms one near 500-525 ms; the thresholds sit well clear of both so load
// on the box moves neither verdict.
const FAST_MAX = 250
const IDLE_MIN = 400

describe.skipIf(!existsSync(CSC))('WO-1990 status cadence never downshifts on an uncertain frame', () => {
  it('a confidently idle board - every read answered - still earns the 500 ms repeat', () => {
    expect(row('harness.done')).toBe('True')
    expect(status('idle')).toMatchObject({ state: 'idle', inputs: { hold: false, estop: false } })
    expect(status('idle').machinePos).not.toBeNull()
    expect(status('idle').driveFault).toMatchObject({ configured: true, asserted: false })
    expect(Number(row('idle.repeats'))).toBeGreaterThan(0)
    // No probe pin on this definition: inputs.probe is null because there is
    // no such input, not because a read failed - it must not cost the idle rate.
    expect(status('idle')).toMatchObject({ inputs: { probe: null } })
    expect(median('idle')).toBeGreaterThanOrEqual(IDLE_MIN)
    expect(median('idleAgain')).toBeGreaterThanOrEqual(IDLE_MIN)
  }, 120_000)

  it('a board that stopped answering GetStatus (state unknown) repeats at 100 ms', () => {
    expect(status('unknown')).toMatchObject({ state: 'unknown', inputs: null })
    expect(Number(row('unknown.repeats'))).toBeGreaterThan(5)
    expect(median('unknown')).toBeLessThanOrEqual(FAST_MAX)
  })

  it('an alarm - e-stop by return code or by input - repeats at 100 ms', () => {
    expect(status('estopRc')).toMatchObject({ state: 'alarm', inputs: { estop: true, hold: null } })
    expect(median('estopRc')).toBeLessThanOrEqual(FAST_MAX)
    expect(status('estopInput')).toMatchObject({ state: 'alarm', inputs: { estop: true } })
    expect(median('estopInput')).toBeLessThanOrEqual(FAST_MAX)
  })

  it('an idle state built on a failed position or feed-hold read repeats at 100 ms', () => {
    expect(status('positionUnread')).toMatchObject({ state: 'idle', machinePos: null, workPos: null })
    expect(median('positionUnread')).toBeLessThanOrEqual(FAST_MAX)
    expect(status('holdUnread')).toMatchObject({ state: 'idle', inputs: { hold: null } })
    expect(median('holdUnread')).toBeLessThanOrEqual(FAST_MAX)
  })

  it('a configured drive-fault input that could not be read keeps the 100 ms repeat', () => {
    expect(status('faultUnread')).toMatchObject({ state: 'idle', driveFault: { configured: true, asserted: null } })
    expect(median('faultUnread')).toBeLessThanOrEqual(FAST_MAX)
  })

  it('a configured probe pin with no drive-fault input: 500 ms when read, 100 ms when its input word is unreadable', () => {
    expect(status('probeIdle')).toMatchObject({ state: 'idle', driveFault: { configured: false } })
    expect(typeof (status('probeIdle').inputs as Record<string, unknown>).probe).toBe('boolean')
    expect(median('probeIdle')).toBeGreaterThanOrEqual(IDLE_MIN)
    expect(status('probeUnread')).toMatchObject({ state: 'idle', inputs: { probe: null }, driveFault: { configured: false } })
    expect(median('probeUnread')).toBeLessThanOrEqual(FAST_MAX)
  })

  it('an idle frame still holding a soft-limit latch repeats at 100 ms', () => {
    expect(status('softLimitLatched')).toMatchObject({ state: 'idle', softLimitLatched: true })
    expect(median('softLimitLatched')).toBeLessThanOrEqual(FAST_MAX)
  })

  it('hold and a run whose position has frozen repeat at 100 ms', () => {
    expect(status('hold')).toMatchObject({ state: 'hold' })
    expect(median('hold')).toBeLessThanOrEqual(FAST_MAX)
    expect(status('stalledRun')).toMatchObject({ state: 'run' })
    expect(median('stalledRun')).toBeLessThanOrEqual(FAST_MAX)
  })
})
