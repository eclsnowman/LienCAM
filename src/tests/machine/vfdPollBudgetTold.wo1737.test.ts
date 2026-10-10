import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// WO-1737 - A DEFINITION THAT CANNOT MEET THE BRIDGE'S QUIET-LINK STOP
// BUDGET IS TOLD SO WHEN ITS REAL applyVfdDefinition FRAME ARRIVES.
//
// The production Bridge.HandleFrame -> Dispatch -> VfdDefinitionFile path is
// compiled with the demo-board fake and driven through a real WsFrames reply.
// Operator's definition is the shipped transcription of LienCNCV2.pro. The slow
// definition differs only in its 2000 ms poll; it must never create a link or
// poll thread. A long timeout with Operator's fast poll is accepted as a separate
// control because timeoutMs is a maximum wait, not actual response latency.

const BRIDGE_DIR = resolve('pendant/uccnc-bridge')
const FAKE_BOARD_SOURCE = resolve('src/tests/evidence/WO-1326/FakeUC100.cs')
const SAMPLE_MACHINE_DEFINITION = resolve('pendant/uccnc-bridge/vfd/huanyang-gt.definition.json')
const CSC = join(
  process.env.WINDIR ?? 'C:\\Windows',
  'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe',
)

type JsonObject = Record<string, unknown>

const HARNESS = String.raw`
using System;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Text;
using System.Threading;

namespace LienCAM {
public static class Wo1737Harness {
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

  static void Case(string label, string framePath, int settleMs) {
    ResetBridge();
    string reply = SendFrame(File.ReadAllText(framePath));
    Console.WriteLine(label + ".reply=" + reply);
    Console.WriteLine(label + ".linkNow=" + (Field("vfd").GetValue(null) == null ? "none" : "open"));
    Thread.Sleep(settleMs);
    VfdLink held = Field("vfd").GetValue(null) as VfdLink;
    Console.WriteLine(label + ".linkLater=" + (held == null ? "none" : "open"));
    if (held != null) {
      VfdReading reading = held.Sample();
      Console.WriteLine(label + ".up=" + reading.LinkUp);
      Console.WriteLine(label + ".stop=" + reading.LastStopReason);
    }
  }

  public static void Main(string[] args) {
    Case("sampleMachine", args[0], 1200);
    Case("slow", args[1], 2200);
    Case("longTimeout", args[2], 1200);
    ResetBridge();
  }
}}
`

interface Result {
  rows: Map<string, string>
}

function applyFrame(definition: JsonObject): string {
  return JSON.stringify({ t: 'call', seq: 1, m: 'applyVfdDefinition', a: { definition } })
}

function runHarness(): Result {
  const root = mkdtempSync(join(tmpdir(), 'liencam-wo1737-'))
  const source = join(root, 'Harness.cs')
  const executable = join(root, 'Harness.exe')
  const sampleMachineFrame = join(root, 'operator-frame.json')
  const slowFrame = join(root, 'slow-frame.json')
  const longTimeoutFrame = join(root, 'long-timeout-frame.json')
  const sampleMachine = JSON.parse(readFileSync(SAMPLE_MACHINE_DEFINITION, 'utf8')) as JsonObject
  const slow = structuredClone(sampleMachine)
  const slowLink = slow.link as JsonObject
  slow.id = 'slow-polling-drive'
  slow.name = 'Slow polling drive'
  slowLink.pollIntervalMs = 2000
  const longTimeout = structuredClone(sampleMachine)
  const longTimeoutLink = longTimeout.link as JsonObject
  longTimeout.id = 'fast-reply-long-timeout-drive'
  longTimeout.name = 'Fast reply, long timeout drive'
  longTimeoutLink.timeoutMs = 5000

  writeFileSync(source, HARNESS)
  writeFileSync(sampleMachineFrame, applyFrame(sampleMachine))
  writeFileSync(slowFrame, applyFrame(slow))
  writeFileSync(longTimeoutFrame, applyFrame(longTimeout))
  try {
    execFileSync(CSC, [
      '/nologo', '/unsafe', `/out:${executable}`, '/main:LienCAM.Wo1737Harness',
      resolve(BRIDGE_DIR, 'Bridge.cs'), resolve(BRIDGE_DIR, 'Machine.cs'),
      resolve(BRIDGE_DIR, 'Json.cs'), resolve(BRIDGE_DIR, 'Vfd.cs'),
      FAKE_BOARD_SOURCE, source,
    ], { stdio: 'pipe' })
    const out = execFileSync(executable, [sampleMachineFrame, slowFrame, longTimeoutFrame], {
      encoding: 'utf8',
      timeout: 30_000,
    })
    const rows = new Map<string, string>()
    for (const line of out.split(/\r?\n/)) {
      const match = /^(sampleMachine|slow|longTimeout)\.([A-Za-z]+)=(.*)$/.exec(line)
      if (match) rows.set(`${match[1]}.${match[2]}`, match[3])
    }
    return { rows }
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

let result: Result | undefined
const rows = (): Map<string, string> => (result ??= runHarness()).rows
const reply = (label: string): { ok: boolean, v: { ok: boolean, reason?: string } } =>
  JSON.parse(rows().get(`${label}.reply`) ?? 'null') as { ok: boolean, v: { ok: boolean, reason?: string } }

describe.skipIf(!existsSync(CSC))('WO-1737 VFD poll interval must fit the spindle stop budget', () => {
  it("keeps Operator's imported-profile definition running without a safety stop", () => {
    expect(reply('sampleMachine')).toMatchObject({ ok: true, v: { ok: true } })
    expect(rows().get('sampleMachine.linkNow')).toBe('open')
    expect(rows().get('sampleMachine.linkLater')).toBe('open')
    expect(rows().get('sampleMachine.up')).toBe('True')
    expect(rows().get('sampleMachine.stop')).toBe('None')
  }, 30_000)

  it('refuses the 2000 ms poll in one plain sentence before any link or stop loop exists', () => {
    expect(reply('slow')).toEqual({
      t: 'reply',
      seq: 1,
      ok: true,
      v: {
        ok: false,
        definition: null,
        reason: 'the spindle link polls every 2000 ms; the spindle safety stop needs a reading within 1000 ms.',
      },
    })
    expect(rows().get('slow.linkNow')).toBe('none')
    expect(rows().get('slow.linkLater')).toBe('none')
  })

  it('accepts a long maximum timeout when the drive answers promptly', () => {
    expect(reply('longTimeout')).toMatchObject({ ok: true, v: { ok: true } })
    expect(rows().get('longTimeout.linkNow')).toBe('open')
    expect(rows().get('longTimeout.linkLater')).toBe('open')
    expect(rows().get('longTimeout.up')).toBe('True')
    expect(rows().get('longTimeout.stop')).toBe('None')
  })
})
