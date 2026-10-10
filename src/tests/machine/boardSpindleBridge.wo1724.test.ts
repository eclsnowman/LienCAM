import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { uccncProfileOutputs } from '../../lib/machine/uccncProfileImport'
import type { ControllerDefinition, MachineBoardSpeedSpindleDrive } from '../../types'

// WO-1724 - THE BRIDGE DRIVES A BOARD SPINDLE.
//
// Before this order Bridge.cs said `ownsSpindle: false` and the UC100 spindle
// calls (SetSpindleSetting, SetSpindleSpeed, SpindleOn, SpindleOff) were
// declared and never called, so a machine whose spindle is a PWM/0-10V output
// or M3/M4 relays could not be driven at all. This compiles the REAL
// Machine.cs and Bridge.cs against the WO-1326 fake board and drives the
// board-spindle path on TWO definitions with no source edit between them:
//
//   Operator's LienCNCV2 definition (a Modbus VFD machine: no speed output, no
//     spindle relays) - the board path configures nothing and refuses a relay
//     start by name; his stop path never touches the board spindle.
//   A deliberately different machine: his axes, a PWM speed output, and M3/M4
//     relays produced by the app's OWN .pro importer (uccncProfileOutputs) from
//     UCCNC relay keys - so the .pro fills the same `outputs` field a hand-made
//     definition would (ADR-0044).
//
// The canonical desk smoke against the demo board (--board -19) repeats the
// PWM/relay checks through the websocket: src/tests/evidence/WO-1724/.
// NOT CLAIMED: a real spindle turning or a relay clicking. That is hardware
// check M11 in docs/machine/NEXT-HARDWARE-SESSION.md.

const BRIDGE_DIR = resolve('pendant/uccnc-bridge')
const FAKE_BOARD_SOURCE = resolve('src/tests/evidence/WO-1326/FakeUC100.cs')
const SAMPLE_MACHINE_DEFINITION = JSON.parse(readFileSync(
  resolve('docs/machine/profiles/LienCNCV2.definition.json'), 'utf8',
)).definition as ControllerDefinition
const CSC = join(
  process.env.WINDIR ?? 'C:\\Windows',
  'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe',
)

function uccncSetting(key: string, kind: 'number' | 'boolean', value: number | boolean) {
  return { controller: 'uccnc', key: `Spindlesetupsettings.${key}`, value: { kind, value } }
}

/** A machine that is not Operator's: its spindle relays come from UCCNC keys run
 *  through the app's own importer, on port 3 pins his machine does not use. */
function differentMachineDefinition(): ControllerDefinition {
  const profile = {
    ...structuredClone(SAMPLE_MACHINE_DEFINITION),
    settings: [
      ...(SAMPLE_MACHINE_DEFINITION.settings ?? []).filter((s) => !/relay/i.test(s.key)),
      uccncSetting('Spindlerelaysenabled', 'boolean', true),
      uccncSetting('M3relayport', 'number', 3),
      uccncSetting('M3relaypin', 'number', 2),
      uccncSetting('M3relaypinnegate', 'boolean', false),
      uccncSetting('M4relayport', 'number', 3),
      uccncSetting('M4relaypin', 'number', 5),
      uccncSetting('M4relaypinnegate', 'boolean', true),
    ],
  } as ControllerDefinition
  return { ...profile, outputs: uccncProfileOutputs(profile) }
}

const PWM_DRIVE: MachineBoardSpeedSpindleDrive = {
  kind: 'board-speed',
  signal: 'pwm',
  output: { port: 3, pin: 17, negate: null },
  frequencyHz: 1000,
  minimumRpm: 6000,
  maximumRpm: 24000,
  minimumPercent: 10,
  maximumPercent: 100,
}

const HARNESS = String.raw`
using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
namespace LienCAM {
public static class Wo1724SpindleHarness {
  static readonly BindingFlags Priv = BindingFlags.NonPublic | BindingFlags.Instance;
  static void Set(Machine m, string name, object v) {
    FieldInfo f = typeof(Machine).GetField(name, Priv);
    if (f == null) throw new Exception("Machine has no field '" + name + "' - the harness is stale");
    f.SetValue(m, v);
  }
  static object Load(string path) {
    object v;
    if (!Json.TryParse(File.ReadAllText(path), out v)) throw new Exception("unparseable " + path);
    return v;
  }
  static Machine Primed(object definition) {
    Machine m = new Machine();
    Set(m, "opened", true);
    Set(m, "sentinelPassed", true);
    Set(m, "pinTable", BoardPinTables.AxbbE);
    Set(m, "readOnly", false);
    Set(m, "resolvedDefinition", definition);
    m.LiveConsole = delegate(string text, string severity) { };
    return m;
  }
  static string Show(object v) { return v == null ? "null" : v.ToString(); }
  static string Bits(long w) {
    string s = "";
    for (int i = 0; i < 64; i++) if (((w >> i) & 1L) == 1L) s += (s.Length > 0 ? "," : "") + i;
    return s.Length == 0 ? "none" : s;
  }
  static string Relay(Json.Obj rb, string key) {
    Json.Obj r = rb == null ? null : rb[key] as Json.Obj;
    return r == null ? "null" : Show(r["on"]);
  }
  static void Print(string label, bool ok, string err, Json.Obj rb) {
    Console.WriteLine(label + ".ok=" + ok);
    Console.WriteLine(label + ".err=" + Show(err));
    Json.Obj set = rb == null ? null : rb["setting"] as Json.Obj;
    foreach (string k in new[] { "mode", "spPin", "spPinNeg", "pwmFreq", "minRpm", "maxRpm", "minPercent", "maxPercent" })
      Console.WriteLine(label + ".set_" + k + "=" + (set == null ? "null" : Show(set[k])));
    Console.WriteLine(label + ".on=" + Show(rb == null ? null : rb["on"]));
    Console.WriteLine(label + ".ccw=" + Show(rb == null ? null : rb["ccw"]));
    Console.WriteLine(label + ".speed=" + Show(rb == null ? null : rb["speed"]));
    Console.WriteLine(label + ".m3=" + Relay(rb, "m3Relay"));
    Console.WriteLine(label + ".m4=" + Relay(rb, "m4Relay"));
    Console.WriteLine(label + ".word=" + Bits(FakeBoard.OutputWord));
    Console.WriteLine(label + ".calls=" + string.Join("|", FakeBoard.SpindleCalls.ToArray()));
  }
  static void On(string label, Machine m, object drive, bool ccw, double rpm) {
    Machine.BoardSpindlePlan plan; string err;
    if (!Machine.ParseBoardSpindle(drive, m.ResolvedDefinition, out plan, out err)) {
      Print(label, false, "parse: " + err, null);
      return;
    }
    Json.Obj rb;
    bool ok = m.BoardSpindleOn(plan, ccw, rpm, out err, out rb);
    Print(label, ok, err, rb);
  }
  static void Off(string label, Machine m) {
    string err; Json.Obj rb;
    bool ok = m.BoardSpindleOff(true, out err, out rb);
    Print(label, ok, err, rb);
  }

  public static void Main(string[] args) {
    object sampleMachine = Load(args[0]);
    object different = Load(args[1]);
    object pwm = Load(args[2]);
    object relay = Load(args[3]);
    object unstated = Load(args[4]);

    // 1. The different machine, PWM drive: on at 12000 cw, stop, then ccw.
    FakeBoard.Reset();
    Machine m = Primed(different);
    Console.WriteLine("fresh.configured=" + m.BoardSpindleConfigured);
    On("pwmOn", m, pwm, false, 12000);
    Console.WriteLine("pwmOn.configured=" + m.BoardSpindleConfigured);
    FakeBoard.SpindleCalls.Clear();
    Off("pwmOff", m);
    FakeBoard.SpindleCalls.Clear();
    On("pwmCcw", m, pwm, true, 9000);
    FakeBoard.SpindleCalls.Clear();
    Off("pwmCcwOff", m);

    // 2. The same machine, relay drive: no speed output, the relay switches.
    FakeBoard.Reset();
    m = Primed(different);
    On("relayOn", m, relay, false, 12000);
    FakeBoard.SpindleCalls.Clear();
    Off("relayOff", m);

    // 3. A mapping the definition left unstated is named, not defaulted.
    FakeBoard.Reset();
    m = Primed(different);
    On("unstated", m, unstated, false, 12000);

    // 4. Stop is never refused: read-only, E-STOP and inhibited outputs at once.
    FakeBoard.Reset();
    m = Primed(different);
    On("gatedOn", m, relay, false, 12000);
    Set(m, "readOnly", true);
    FakeBoard.StatusEstop = true;
    UC100.SetOffline(true);
    FakeBoard.SpindleCalls.Clear();
    Off("gatedOff", m);
    On("readOnlyOn", m, relay, false, 12000);
    UC100.SetOffline(false);

    // 5. The E-STOP / socket-loss half, through Bridge's own helper.
    FakeBoard.Reset();
    m = Primed(different);
    On("estopOn", m, pwm, false, 12000);
    FieldInfo bm = Type.GetType("LienCAM.Bridge").GetField("machine", BindingFlags.NonPublic | BindingFlags.Static);
    bm.SetValue(null, m);
    FakeBoard.SpindleCalls.Clear();
    Type.GetType("LienCAM.Bridge").GetMethod("StopBoardSpindleAfter", BindingFlags.NonPublic | BindingFlags.Static)
        .Invoke(null, new object[] { "the E-STOP" });
    Console.WriteLine("estopAfter.calls=" + string.Join("|", FakeBoard.SpindleCalls.ToArray()));
    Console.WriteLine("estopAfter.word=" + Bits(FakeBoard.OutputWord));

    // 6. SampleMachine's VFD machine: nothing on the board; a relay start is refused by name.
    FakeBoard.Reset();
    m = Primed(sampleMachine);
    bm.SetValue(null, m);
    Type.GetType("LienCAM.Bridge").GetMethod("StopBoardSpindleAfter", BindingFlags.NonPublic | BindingFlags.Static)
        .Invoke(null, new object[] { "the E-STOP" });
    Console.WriteLine("sampleMachineStop.calls=" + string.Join("|", FakeBoard.SpindleCalls.ToArray()));
    Console.WriteLine("sampleMachineStop.configured=" + m.BoardSpindleConfigured);
    On("sampleMachineRelay", m, relay, false, 12000);
    Console.WriteLine("sampleMachineRelay.configured=" + m.BoardSpindleConfigured);

    // 7. Capabilities: the new key, and ownsSpindle unchanged.
    Json.Obj caps = (Json.Obj)Type.GetType("LienCAM.Bridge")
        .GetMethod("Capabilities", BindingFlags.NonPublic | BindingFlags.Static).Invoke(null, null);
    Console.WriteLine("caps.boardSpindleCommands=" + Show(caps["boardSpindleCommands"]));
    Console.WriteLine("caps.ownsSpindle=" + Show(caps["ownsSpindle"]));

    Console.WriteLine("harness.done=True");
  }
}}
`

function runHarness(): Map<string, string> {
  const root = mkdtempSync(join(tmpdir(), 'liencam-wo1724-'))
  const source = join(root, 'Harness.cs')
  const executable = join(root, 'Harness.exe')
  writeFileSync(source, HARNESS)
  const files = {
    sampleMachine: SAMPLE_MACHINE_DEFINITION,
    different: differentMachineDefinition(),
    pwm: PWM_DRIVE,
    relay: { kind: 'relay' },
    unstated: { ...PWM_DRIVE, frequencyHz: null, maximumRpm: null },
  }
  const paths = Object.entries(files).map(([name, value]) => {
    const path = join(root, `${name}.json`)
    writeFileSync(path, JSON.stringify(value))
    return path
  })
  try {
    execFileSync(CSC, [
      '/nologo', '/unsafe', `/out:${executable}`, '/main:LienCAM.Wo1724SpindleHarness',
      resolve(BRIDGE_DIR, 'Bridge.cs'), resolve(BRIDGE_DIR, 'Machine.cs'),
      resolve(BRIDGE_DIR, 'Json.cs'), resolve(BRIDGE_DIR, 'Vfd.cs'),
      FAKE_BOARD_SOURCE, source,
    ], { stdio: 'pipe' })
    const out = execFileSync(executable, paths, { encoding: 'utf8', timeout: 60_000 })
    const rows = new Map<string, string>()
    for (const line of out.split(/\r?\n/)) {
      const m = /^([A-Za-z0-9]+\.[A-Za-z0-9_]+)=(.*)$/.exec(line)
      if (m) rows.set(m[1], m[2])
    }
    return rows
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

let output: Map<string, string> | undefined
const row = (key: string): string | undefined => (output ??= runHarness()).get(key)

// AXBB-E UC pins (BoardPinTables.AxbbE): port 3 pin 17 -> UC 33, port 3 pin 2
// -> UC 34 (bit 33), port 3 pin 5 -> UC 43 (bit 42).
describe.skipIf(!existsSync(CSC))('WO-1724 bridge: a board spindle driven from the machine definition', () => {
  it('ran every scenario', () => {
    expect(row('harness.done')).toBe('True')
  }, 120_000)

  it("the .pro importer's relay keys land in the definition outputs the bridge reads", () => {
    const outputs = differentMachineDefinition().outputs ?? []
    expect(outputs.filter((o) => o.besideWord).map((o) => [o.onCode, o.pin.port, o.pin.pin, o.pin.negate]))
      .toEqual([['M3', 3, 2, false], ['M4', 3, 5, true]])
  })

  it('PWM: spindle on at 12000 puts the definition mapping on the board and switches M3', () => {
    expect(row('fresh.configured')).toBe('False')
    expect(row('pwmOn.ok')).toBe('True')
    expect(row('pwmOn.set_mode')).toBe('1')
    expect(row('pwmOn.set_spPin')).toBe('33')
    expect(row('pwmOn.set_spPinNeg')).toBe('False')
    expect(row('pwmOn.set_pwmFreq')).toBe('1000')
    expect(row('pwmOn.set_minRpm')).toBe('6000')
    expect(row('pwmOn.set_maxRpm')).toBe('24000')
    expect(row('pwmOn.set_minPercent')).toBe('10')
    expect(row('pwmOn.set_maxPercent')).toBe('100')
    expect(row('pwmOn.calls')).toBe('setting|speed 12000|on cw')
    expect(row('pwmOn.on')).toBe('True')
    expect(row('pwmOn.ccw')).toBe('False')
    expect(row('pwmOn.speed')).toBe('12000')
    // M3 on (bit 33); M4 is negated, so OFF holds its terminal high (bit 42).
    expect(row('pwmOn.m3')).toBe('True')
    expect(row('pwmOn.m4')).toBe('False')
    expect(row('pwmOn.word')).toBe('33,42')
    expect(row('pwmOn.configured')).toBe('True')
  })

  it('PWM: stop clears it - SpindleOff, both relays off', () => {
    expect(row('pwmOff.ok')).toBe('True')
    expect(row('pwmOff.calls')).toBe('off')
    expect(row('pwmOff.on')).toBe('False')
    expect(row('pwmOff.m3')).toBe('False')
    expect(row('pwmOff.m4')).toBe('False')
    expect(row('pwmOff.word')).toBe('42')
  })

  it('PWM counter-clockwise: M4 (negated) is energised and M3 is not', () => {
    expect(row('pwmCcw.ok')).toBe('True')
    expect(row('pwmCcw.calls')).toBe('setting|speed 9000|on ccw')
    expect(row('pwmCcw.ccw')).toBe('True')
    expect(row('pwmCcw.m3')).toBe('False')
    expect(row('pwmCcw.m4')).toBe('True')
    expect(row('pwmCcw.word')).toBe('none')
    expect(row('pwmCcwOff.m4')).toBe('False')
    expect(row('pwmCcwOff.word')).toBe('42')
  })

  it('relay: switches its M3 output, puts no speed output on the board, and stop releases it', () => {
    expect(row('relayOn.ok')).toBe('True')
    expect(row('relayOn.set_mode')).toBe('0')
    expect(row('relayOn.set_spPin')).toBe('0')
    expect(row('relayOn.calls')).toBe('setting')
    expect(row('relayOn.m3')).toBe('True')
    expect(row('relayOn.m4')).toBe('False')
    expect(row('relayOff.ok')).toBe('True')
    expect(row('relayOff.calls')).toBe('off')
    expect(row('relayOff.m3')).toBe('False')
    expect(row('relayOff.m4')).toBe('False')
  })

  it('a mapping value the definition left null is named, and nothing reaches the board', () => {
    expect(row('unstated.ok')).toBe('False')
    expect(row('unstated.err')).toMatch(/frequencyHz, maximumRpm/)
    expect(row('unstated.calls')).toBe('')
    expect(row('unstated.word')).toBe('none')
  })

  it('stop is never refused - read-only, E-STOP and inhibited outputs together - while a start is', () => {
    expect(row('gatedOn.ok')).toBe('True')
    expect(row('gatedOff.ok')).toBe('True')
    expect(row('gatedOff.calls')).toBe('off')
    expect(row('gatedOff.m3')).toBe('False')
    expect(row('readOnlyOn.ok')).toBe('False')
  })

  it("the E-STOP / socket-loss helper stops a configured board spindle", () => {
    expect(row('estopOn.ok')).toBe('True')
    expect(row('estopAfter.calls')).toBe('off')
    expect(row('estopAfter.word')).toBe('42')
  })

  it("Operator's VFD definition: the stop path touches no board spindle and a relay start is refused by name", () => {
    expect(row('sampleMachineStop.calls')).toBe('')
    expect(row('sampleMachineStop.configured')).toBe('False')
    expect(row('sampleMachineRelay.ok')).toBe('False')
    expect(row('sampleMachineRelay.err')).toMatch(/names no M3 spindle relay output/)
    expect(row('sampleMachineRelay.calls')).toBe('')
    expect(row('sampleMachineRelay.configured')).toBe('False')
  })

  it('capabilities declare boardSpindleCommands and leave ownsSpindle false', () => {
    expect(row('caps.boardSpindleCommands')).toBe('True')
    expect(row('caps.ownsSpindle')).toBe('False')
  })
})
