import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// WO-1733 bridge-consumer proof. Compile production Bridge.cs/Vfd.cs into a
// unique temporary executable, apply Operator's RTU definition through the real
// frame parser and fake RTU port, then swap through the same parser to a real
// loopback Modbus TCP endpoint. No canonical bridge binary or demo port exists.

const BRIDGE_DIR = resolve('pendant/uccnc-bridge')
const FAKE_BOARD_SOURCE = resolve('src/tests/evidence/WO-1326/FakeUC100.cs')
const SAMPLE_MACHINE_DEFINITION = resolve(BRIDGE_DIR, 'vfd/huanyang-gt.definition.json')
const CSC = join(
  process.env.WINDIR ?? 'C:\\Windows',
  'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe',
)

const HARNESS = String.raw`
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Text;
using System.Threading;

namespace LienCAM {
sealed class Wo1733TcpInverter : IDisposable {
  readonly TcpListener listener;
  readonly Thread thread;
  volatile bool stopping;
  public int Connections;
  public int Requests;
  public bool UnitSevenOnly = true;

  public Wo1733TcpInverter() {
    listener = new TcpListener(IPAddress.Loopback, 0);
    listener.Start();
    Port = ((IPEndPoint)listener.LocalEndpoint).Port;
    thread = new Thread(Serve);
    thread.IsBackground = true;
    thread.Start();
  }

  public int Port { get; private set; }

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

  static byte[] Frame(ushort transaction, byte unit, byte[] pdu) {
    byte[] frame = new byte[7 + pdu.Length];
    frame[0] = (byte)(transaction >> 8);
    frame[1] = (byte)transaction;
    frame[4] = (byte)((pdu.Length + 1) >> 8);
    frame[5] = (byte)(pdu.Length + 1);
    frame[6] = unit;
    Array.Copy(pdu, 0, frame, 7, pdu.Length);
    return frame;
  }

  static byte[] Reply(byte[] pdu) {
    byte function = pdu[0];
    if (function == 0x03 || function == 0x04) {
      int count = (pdu[3] << 8) | pdu[4];
      int address = (pdu[1] << 8) | pdu[2];
      byte[] reply = new byte[2 + count * 2];
      reply[0] = function;
      reply[1] = (byte)(count * 2);
      for (int i = 0; i < count; i++) {
        int word = address + i == 0x1001 ? 3 : 0;
        reply[2 + i * 2] = (byte)(word >> 8);
        reply[3 + i * 2] = (byte)word;
      }
      return reply;
    }
    if (function == 0x06) {
      byte[] reply = new byte[5];
      Array.Copy(pdu, reply, 5);
      return reply;
    }
    if (function == 0x10) {
      return new byte[] { function, pdu[1], pdu[2], pdu[3], pdu[4] };
    }
    return new byte[] { (byte)(function | 0x80), 0x01 };
  }

  void Serve() {
    while (!stopping) {
      TcpClient client = null;
      try {
        client = listener.AcceptTcpClient();
        Interlocked.Increment(ref Connections);
        NetworkStream stream = client.GetStream();
        stream.ReadTimeout = 2000;
        while (!stopping) {
          byte[] header = ReadExact(stream, 7);
          int following = (header[4] << 8) | header[5];
          byte[] pdu = ReadExact(stream, following - 1);
          Interlocked.Increment(ref Requests);
          if (header[2] != 0 || header[3] != 0 || header[6] != 7) UnitSevenOnly = false;
          ushort transaction = (ushort)((header[0] << 8) | header[1]);
          byte[] response = Frame(transaction, header[6], Reply(pdu));
          stream.Write(response, 0, response.Length);
        }
      } catch (Exception) {
        if (!stopping) Thread.Sleep(5);
      } finally {
        if (client != null) client.Close();
      }
    }
  }

  public void Dispose() {
    stopping = true;
    listener.Stop();
    if (!thread.Join(3000)) throw new Exception("loopback inverter did not stop");
  }
}

public static class Wo1733BridgeHarness {
  static readonly BindingFlags StaticPrivate = BindingFlags.Static | BindingFlags.NonPublic;

  sealed class ExchangeResult {
    public string Reply;
    public string Console;
  }

  static FieldInfo Field(string name) {
    FieldInfo field = typeof(Bridge).GetField(name, StaticPrivate);
    if (field == null) throw new Exception("Bridge has no field " + name);
    return field;
  }

  static object ReadDocument(string path) {
    object document;
    if (!Json.TryParse(File.ReadAllText(path), out document)) throw new Exception("definition JSON did not parse");
    return document;
  }

  static object TcpDocument(string path, int port) {
    object document = ReadDocument(path);
    Dictionary<string, object> link = Json.AsObj(Json.Get(document, "link"));
    link.Clear();
    link["transport"] = "tcp";
    link["host"] = "127.0.0.1";
    link["tcpPort"] = (double)port;
    link["slaveAddress"] = 7.0;
    link["pollIntervalMs"] = 40.0;
    link["retryCount"] = 1.0;
    link["timeoutMs"] = 350.0;
    return document;
  }

  static string CallFrame(int seq, string method, object args) {
    var call = new Json.Obj();
    call.Set("t", "call");
    call.Set("seq", seq);
    call.Set("m", method);
    call.Set("a", args);
    return Json.Write(call);
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

  static ExchangeResult Exchange(string frame) {
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
      handle.Invoke(null, new object[] { ws, frame });
      var result = new ExchangeResult();
      var console = new StringBuilder();
      for (int i = 0; i < 12; i++) {
        string text = ReadServerFrame(client.GetStream());
        if (text.IndexOf("\"t\":\"console\"") >= 0) console.Append(text);
        if (text.IndexOf("\"t\":\"reply\"") >= 0) {
          result.Reply = text;
          result.Console = console.ToString();
          return result;
        }
      }
      throw new Exception("no reply frame arrived");
    } finally {
      ws.CloseOutbox();
      client.Close();
      server.Close();
    }
  }

  static string ApplyFrame(int seq, object document) {
    var args = new Json.Obj();
    args.Set("definition", document);
    return CallFrame(seq, "applyVfdDefinition", args);
  }

  static string HelloJson() {
    MethodInfo method = typeof(Bridge).GetMethod("VfdHello", StaticPrivate);
    return Json.Write(method.Invoke(null, new object[0]));
  }

  static string StatusJson() {
    VfdLink link = Field("vfd").GetValue(null) as VfdLink;
    VfdPlan plan = Field("vfdPlan").GetValue(null) as VfdPlan;
    MethodInfo method = typeof(Bridge).GetMethod("VfdToJson", StaticPrivate);
    return Json.Write(method.Invoke(null, new object[] { plan, link.Sample() }));
  }

  static void Row(string name, object value) { Console.WriteLine(name + "=" + value); }

  public static void Main(string[] args) {
    Field("vfd").SetValue(null, null);
    Field("vfdPlan").SetValue(null, null);
    Field("vfdDocument").SetValue(null, null);
    Field("machine").SetValue(null, new Machine());

    Field("injectFakeInverter").SetValue(null, true);
    object rtu = ReadDocument(args[0]);
    ExchangeResult rtuApply = Exchange(ApplyFrame(1, rtu));
    Row("rtu.reply", rtuApply.Reply);
    Row("rtu.console", rtuApply.Console);
    Row("rtu.hello", HelloJson());
    Row("rtu.status", StatusJson());

    using (Wo1733TcpInverter fake = new Wo1733TcpInverter()) {
      Field("injectFakeInverter").SetValue(null, false);
      object tcp = TcpDocument(args[0], fake.Port);
      ExchangeResult tcpApply = Exchange(ApplyFrame(2, tcp));
      Row("tcp.reply", tcpApply.Reply);
      Row("tcp.console", tcpApply.Console);
      Row("tcp.hello", HelloJson());
      Row("tcp.status", StatusJson());
      Row("tcp.connections", fake.Connections);
      Row("tcp.requests", fake.Requests);
      Row("tcp.unitSevenOnly", fake.UnitSevenOnly);

      VfdLink before = Field("vfd").GetValue(null) as VfdLink;
      var portArgs = new Json.Obj();
      portArgs.Set("port", "COM99");
      ExchangeResult setPort = Exchange(CallFrame(3, "setVfdPort", portArgs));
      VfdLink after = Field("vfd").GetValue(null) as VfdLink;
      VfdPlan afterPlan = Field("vfdPlan").GetValue(null) as VfdPlan;
      Row("tcp.setPortReply", setPort.Reply);
      Row("tcp.sameLink", Object.ReferenceEquals(before, after));
      Row("tcp.afterTransport", afterPlan.Transport);
      Row("tcp.afterHost", afterPlan.TcpHost);
      Row("tcp.afterPort", afterPlan.TcpPort);

      var noneArgs = new Json.Obj();
      noneArgs.Set("definition", null);
      ExchangeResult closed = Exchange(CallFrame(4, "applyVfdDefinition", noneArgs));
      Row("close.reply", closed.Reply);
      Row("close.console", closed.Console);
      Row("close.link", Field("vfd").GetValue(null) == null ? "none" : "held");
    }
  }
}}
`

interface HarnessResult {
  rows: Map<string, string>
}

function runHarness(): HarnessResult {
  const root = mkdtempSync(join(tmpdir(), 'liencam-wo1733-bridge-'))
  const source = join(root, 'Harness.cs')
  const executable = join(root, 'Harness.exe')
  writeFileSync(source, HARNESS)
  try {
    execFileSync(CSC, [
      '/nologo', '/unsafe', `/out:${executable}`, '/main:LienCAM.Wo1733BridgeHarness',
      resolve(BRIDGE_DIR, 'Bridge.cs'), resolve(BRIDGE_DIR, 'Machine.cs'),
      resolve(BRIDGE_DIR, 'Json.cs'), resolve(BRIDGE_DIR, 'Vfd.cs'),
      FAKE_BOARD_SOURCE, source,
    ], { stdio: 'pipe' })
    const output = execFileSync(executable, [SAMPLE_MACHINE_DEFINITION], {
      encoding: 'utf8', timeout: 30_000,
    })
    const rows = new Map<string, string>()
    for (const line of output.split(/\r?\n/)) {
      const match = /^([A-Za-z]+\.[A-Za-z]+)=(.*)$/.exec(line)
      if (match) rows.set(match[1], match[2])
    }
    return { rows }
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

let result: HarnessResult | undefined
const rows = (): Map<string, string> => (result ??= runHarness()).rows
const json = (name: string): Record<string, unknown> =>
  JSON.parse(rows().get(name) ?? 'null') as Record<string, unknown>

describe.skipIf(!existsSync(CSC))('WO-1733 production bridge consumes RTU and TCP definitions', () => {
  it("keeps Operator's RTU apply, hello and status vocabulary unchanged", () => {
    expect(json('rtu.reply')).toMatchObject({ ok: true, v: { ok: true } })
    expect(json('rtu.hello')).toMatchObject({
      present: true,
      endpoint: { transport: 'rtu', port: 'COM3', slaveAddress: 1 },
    })
    expect(json('rtu.status')).toMatchObject({
      endpoint: { transport: 'rtu', port: 'COM3', slaveAddress: 1 },
      port: 'COM3',
    })
  }, 30_000)

  it('swaps through production apply to a real loopback Modbus TCP endpoint', () => {
    expect(json('tcp.reply')).toMatchObject({ ok: true, v: { ok: true } })
    expect(rows().get('tcp.console')).toContain('reopened at 127.0.0.1:')
    expect(rows().get('tcp.console')).toContain('Modbus TCP unit 7')
    expect(Number(rows().get('tcp.connections'))).toBeGreaterThan(0)
    expect(Number(rows().get('tcp.requests'))).toBeGreaterThan(0)
    expect(rows().get('tcp.unitSevenOnly')).toBe('True')
  })

  it('reports TCP endpoint facts in hello and every status without a fake COM port', () => {
    expect(json('tcp.hello')).toMatchObject({
      present: true,
      endpoint: { transport: 'tcp', host: '127.0.0.1', slaveAddress: 7 },
    })
    expect(json('tcp.status')).toMatchObject({
      endpoint: { transport: 'tcp', host: '127.0.0.1', slaveAddress: 7 },
    })
    expect(json('tcp.status')).not.toHaveProperty('port')
  })

  it('refuses the serial-only setter before mutating or reopening a TCP link', () => {
    expect(json('tcp.setPortReply')).toMatchObject({ ok: false })
    expect(json('tcp.setPortReply').error).toContain('setVfdPort only moves a Modbus RTU serial link')
    expect(rows().get('tcp.sameLink')).toBe('True')
    expect(rows().get('tcp.afterTransport')).toBe('tcp')
    expect(rows().get('tcp.afterHost')).toBe('127.0.0.1')
    expect(Number(rows().get('tcp.afterPort'))).toBeGreaterThan(0)
  })

  it('closes a TCP definition through the shared apply door and names the real endpoint', () => {
    expect(json('close.reply')).toMatchObject({ ok: true, v: { ok: true, definition: null } })
    expect(rows().get('close.console')).toContain('spindle link at 127.0.0.1:')
    expect(rows().get('close.console')).toContain('Modbus TCP unit 7')
    expect(rows().get('close.link')).toBe('none')
  })
})
