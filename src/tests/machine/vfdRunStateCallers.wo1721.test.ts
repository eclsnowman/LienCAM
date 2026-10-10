import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// WO-1721 - EVERY BRIDGE CALLER CLASSIFIES THE WORD WITH THE LINK THAT READ IT.
//
// The real Bridge.HandleFrame -> applyVfdDefinition path is compiled with the
// demo board and driven through real WebSocket replies. The in-process fake
// inverter reports the stopped value named by each definition, so a drive with
// stopped=0 cannot accidentally pass through Huanyang's stopped=3 assumption.
// This proves bridge wiring only; it makes no controller or hardware claim.

const BRIDGE_DIR = resolve('pendant/uccnc-bridge')
const BRIDGE_SOURCE = resolve(BRIDGE_DIR, 'Bridge.cs')
const VFD_SOURCE = resolve(BRIDGE_DIR, 'Vfd.cs')
const SAMPLE_MACHINE_DEFINITION = resolve(BRIDGE_DIR, 'vfd/huanyang-gt.definition.json')
const FAKE_BOARD_SOURCE = resolve('src/tests/evidence/WO-1326/FakeUC100.cs')
const CSC = join(
  process.env.WINDIR ?? 'C:\\Windows',
  'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe',
)

type Doc = Record<string, unknown>

const HARNESS = String.raw`
using System;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Text;

namespace LienCAM {
public static class Wo1721CallerHarness {
  static readonly BindingFlags StaticPrivate = BindingFlags.Static | BindingFlags.NonPublic;

  static FieldInfo Field(string name) {
    FieldInfo field = typeof(Bridge).GetField(name, StaticPrivate);
    if (field == null) throw new Exception("Bridge has no field " + name);
    return field;
  }

  static void ResetBridge() {
    VfdLink held = Field("vfd").GetValue(null) as VfdLink;
    if (held != null) held.Close();
    Field("vfd").SetValue(null, null);
    Field("vfdPlan").SetValue(null, null);
    Field("vfdDocument").SetValue(null, null);
    Field("machine").SetValue(null, new Machine());
    Field("injectFakeInverter").SetValue(null, true);
  }

  static byte[] ReadExact(NetworkStream stream, int count) {
    byte[] bytes = new byte[count];
    int got = 0;
    while (got < count) {
      int n = stream.Read(bytes, got, count - got);
      if (n <= 0) throw new EndOfStreamException();
      got += n;
    }
    return bytes;
  }

  static string ReadServerFrame(NetworkStream stream) {
    byte[] header = ReadExact(stream, 2);
    long length = header[1] & 0x7f;
    if (length == 126) {
      byte[] n = ReadExact(stream, 2);
      length = (n[0] << 8) | n[1];
    } else if (length == 127) {
      byte[] n = ReadExact(stream, 8);
      length = 0;
      for (int i = 0; i < 8; i++) length = (length << 8) | n[i];
    }
    return Encoding.UTF8.GetString(ReadExact(stream, (int)length));
  }

  static string SendFrame(string text) {
    TcpListener listener = new TcpListener(IPAddress.Loopback, 0);
    listener.Start();
    TcpClient client = new TcpClient();
    client.Connect(IPAddress.Loopback, ((IPEndPoint)listener.LocalEndpoint).Port);
    TcpClient server = listener.AcceptTcpClient();
    listener.Stop();
    client.ReceiveTimeout = 5000;
    WsFrames ws = new WsFrames(server.GetStream());
    try {
      MethodInfo handle = typeof(Bridge).GetMethod("HandleFrame", StaticPrivate);
      if (handle == null) throw new Exception("Bridge.HandleFrame is missing");
      handle.Invoke(null, new object[] { ws, text });
      for (int i = 0; i < 8; i++) {
        string frame = ReadServerFrame(client.GetStream());
        if (frame.IndexOf("\"t\":\"reply\"") >= 0) return frame;
      }
      throw new Exception("no reply frame arrived");
    } finally {
      ws.CloseOutbox();
      client.Close();
      server.Close();
    }
  }

  static VfdLink HeldLink() {
    VfdLink held = Field("vfd").GetValue(null) as VfdLink;
    if (held == null) throw new Exception("Bridge has no held VFD link");
    return held;
  }

  static string ClassifyHeld(ushort word) {
    MethodInfo classify = typeof(Bridge).GetMethod("ClassifyVfdRunState", StaticPrivate);
    if (classify == null) throw new Exception("Bridge.ClassifyVfdRunState is missing");
    object[] args = new object[] { HeldLink(), word, null };
    object verdict = classify.Invoke(null, args);
    return verdict + "|" + (string)args[2];
  }

  static void PrintHeld(string label) {
    VfdLink held = Field("vfd").GetValue(null) as VfdLink;
    Console.WriteLine(label + ".link=" + (held == null ? "none" : "open"));
    if (held != null) Console.WriteLine(label + ".id=" + held.Plan.Id);
  }

  public static void Main(string[] args) {
    Console.WriteLine("platform=" + Environment.OSVersion.Platform);

    ResetBridge();
    Console.WriteLine("otherFirst.reply=" + SendFrame(File.ReadAllText(args[1])));
    PrintHeld("otherFirst");
    Console.WriteLine("otherFirst.state0=" + ClassifyHeld(0));
    Console.WriteLine("otherFirst.state3=" + ClassifyHeld(3));
    Console.WriteLine("otherFirst.noneReply=" + SendFrame(File.ReadAllText(args[2])));
    PrintHeld("otherFirst.afterNone");

    ResetBridge();
    Console.WriteLine("swap.sampleMachineReply=" + SendFrame(File.ReadAllText(args[0])));
    PrintHeld("swap.sampleMachine");
    Console.WriteLine("swap.sampleMachineState3=" + ClassifyHeld(3));
    Console.WriteLine("swap.otherReply=" + SendFrame(File.ReadAllText(args[1])));
    PrintHeld("swap.other");
    Console.WriteLine("swap.otherState0=" + ClassifyHeld(0));
    Console.WriteLine("swap.otherState3=" + ClassifyHeld(3));
    ResetBridge();
  }
}}
`

interface Result {
  rows: Map<string, string>
  bridgeSha256: string
  vfdSha256: string
}

function applyFrame(definition: Doc | null): string {
  return JSON.stringify({ t: 'call', seq: 1, m: 'applyVfdDefinition', a: { definition } })
}

function alternativeDefinition(sampleMachine: Doc): Doc {
  const other = structuredClone(sampleMachine)
  other.id = 'other-drive'
  other.name = 'Other drive'
  const registers = other.registers as Doc
  registers.runState = {
    address: 0x0200,
    count: 1,
    values: [
      { value: 0, meaning: 'stopped' },
      { value: 1, meaning: 'running' },
      { value: 7, meaning: 'faulted' },
    ],
  }
  other.fault = { kind: 'equals', value: 7 }
  const commands = other.commands as Doc
  commands.values = { runCw: 0x12, runCcw: 0x22, stop: 0x40 }
  return other
}

function runHarness(): Result {
  if (!existsSync(CSC)) throw new Error(`Windows C# compiler did not exist at ${CSC}`)
  const root = mkdtempSync(join(tmpdir(), 'liencam-wo1721-callers-'))
  const source = join(root, 'Harness.cs')
  const executable = join(root, 'Harness.exe')
  const sampleMachineFrame = join(root, 'operator-frame.json')
  const otherFrame = join(root, 'other-frame.json')
  const noneFrame = join(root, 'none-frame.json')
  const sampleMachine = JSON.parse(readFileSync(SAMPLE_MACHINE_DEFINITION, 'utf8')) as Doc
  const other = alternativeDefinition(sampleMachine)

  writeFileSync(source, HARNESS)
  writeFileSync(sampleMachineFrame, applyFrame(sampleMachine))
  writeFileSync(otherFrame, applyFrame(other))
  writeFileSync(noneFrame, applyFrame(null))
  try {
    execFileSync(CSC, [
      '/nologo', '/unsafe', '/warn:4', `/out:${executable}`,
      '/main:LienCAM.Wo1721CallerHarness',
      BRIDGE_SOURCE, resolve(BRIDGE_DIR, 'Machine.cs'),
      resolve(BRIDGE_DIR, 'Json.cs'), VFD_SOURCE,
      FAKE_BOARD_SOURCE, source,
    ], { stdio: 'pipe' })
    const output = execFileSync(executable, [sampleMachineFrame, otherFrame, noneFrame], {
      encoding: 'utf8',
      timeout: 30_000,
    })
    const rows = new Map<string, string>()
    for (const line of output.split(/\r?\n/)) {
      const match = /^([^=]+)=(.*)$/.exec(line)
      if (match) rows.set(match[1], match[2])
    }
    return {
      rows,
      bridgeSha256: createHash('sha256').update(readFileSync(BRIDGE_SOURCE)).digest('hex'),
      vfdSha256: createHash('sha256').update(readFileSync(VFD_SOURCE)).digest('hex'),
    }
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

let result: Result | undefined
const run = (): Result => (result ??= runHarness())
const reply = (key: string): { ok: boolean, v: { ok: boolean, reason?: string } } =>
  JSON.parse(run().rows.get(key) ?? 'null') as { ok: boolean, v: { ok: boolean, reason?: string } }

// Execute these Windows C# harnesses on Windows; Linux reports skipped, never passed.
// The compiler-exists assertion remains mandatory on Windows.
describe.skipIf(process.platform !== 'win32')('WO-1721 bridge callers use the current or candidate VFD plan', () => {
  it('actually compiles and runs the real production bridge on Windows', () => {
    expect(existsSync(CSC)).toBe(true)
    expect(run().rows.get('platform')).toBe('Win32NT')
    expect(run().bridgeSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(run().vfdSha256).toMatch(/^[0-9a-f]{64}$/)
  }, 30_000)

  it('opens the alternative drive from no seed using its stopped=0 definition', () => {
    expect(reply('otherFirst.reply')).toMatchObject({ ok: true, v: { ok: true } })
    expect(run().rows.get('otherFirst.link')).toBe('open')
    expect(run().rows.get('otherFirst.id')).toBe('other-drive')
    expect(run().rows.get('otherFirst.state0')).toBe('SafeToKeep|stopped')
    expect(run().rows.get('otherFirst.state3')).toContain('Unusable|an unrecognised code (3)')
    expect(reply('otherFirst.noneReply')).toMatchObject({ ok: true, v: { ok: true } })
    expect(run().rows.get('otherFirst.afterNone.link')).toBe('none')
  })

  it('classifies the existing Huanyang link and replacement link from their own plans', () => {
    expect(reply('swap.sampleMachineReply')).toMatchObject({ ok: true, v: { ok: true } })
    expect(run().rows.get('swap.sampleMachine.id')).toBe('huanyang-gt')
    expect(run().rows.get('swap.sampleMachineState3')).toBe('SafeToKeep|stopped')

    expect(reply('swap.otherReply')).toMatchObject({ ok: true, v: { ok: true } })
    expect(run().rows.get('swap.other.id')).toBe('other-drive')
    expect(run().rows.get('swap.otherState0')).toBe('SafeToKeep|stopped')
    expect(run().rows.get('swap.otherState3')).toContain('Unusable|an unrecognised code (3)')
  })

  it('routes all four apply boundaries through the link-scoped classifier', () => {
    const bridge = readFileSync(BRIDGE_SOURCE, 'utf8')
    expect(bridge).toContain('ClassifyVfdRunState(vfd, last.RunStateWord, out lastWords)')
    expect(bridge).toContain('ClassifyVfdRunState(vfd, sample.RunStateWord, out stateWords)')
    expect(bridge).toContain('ClassifyVfdRunState(swapped, swWord, out swWords)')
    expect(bridge).toContain('ClassifyVfdRunState(candidate, word, out words2)')
    expect(bridge.match(/ClassifyVfdRunState\(/g)).toHaveLength(5)

    const vfd = readFileSync(VFD_SOURCE, 'utf8')
    expect(vfd.match(/public static RunStateVerdict ClassifyRunState\(/g)).toHaveLength(1)
  })
})
