import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// WO-1733 - compile the production C# transport and drive it against a real
// loopback TCP listener. The fake endpoint records MBAP request bytes and makes
// the stream deliberately awkward: fragmented replies, a stale+current pair in
// one write, an exception, bad unit/function correlation, and a dropped socket
// that the retry must reconnect.

const BRIDGE_DIR = resolve('pendant/uccnc-bridge')
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
using System.Text;
using System.Threading;

namespace LienCAM {
sealed class FakeTcpInverter : IDisposable {
  readonly TcpListener listener;
  readonly Thread thread;
  readonly object gate = new object();
  readonly List<string> requests = new List<string>();
  volatile bool stopping;
  bool droppedReconnectProbe;
  int replies;

  public int Connections;
  public bool Fragmented;
  public bool Coalesced;

  public FakeTcpInverter() {
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

  static string Hex(byte[] bytes) {
    StringBuilder text = new StringBuilder();
    for (int i = 0; i < bytes.Length; i++) {
      if (i > 0) text.Append(" ");
      text.Append(bytes[i].ToString("x2", CultureInfo.InvariantCulture));
    }
    return text.ToString();
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

  static byte[] Join(byte[] first, byte[] second) {
    byte[] both = new byte[first.Length + second.Length];
    Array.Copy(first, both, first.Length);
    Array.Copy(second, 0, both, first.Length, second.Length);
    return both;
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
          byte[] request = Join(header, pdu);
          lock (gate) requests.Add(Hex(request));

          ushort tx = (ushort)((header[0] << 8) | header[1]);
          byte unit = header[6];
          byte function = pdu[0];
          ushort address = pdu.Length >= 3 ? (ushort)((pdu[1] << 8) | pdu[2]) : (ushort)0;

          if (address == 0x8888) {
            Thread.Sleep(350);
            continue;
          }
          if (address == 0x7777 && !droppedReconnectProbe) {
            droppedReconnectProbe = true;
            client.Close();
            client = null;
            break;
          }

          byte responseUnit = address == 0x5555 ? (byte)(unit + 1) : unit;
          byte[] responsePdu;
          if (address == 0x4444) responsePdu = new byte[] { (byte)(function | 0x80), 0x02 };
          else if (address == 0x6666) responsePdu = new byte[] { 0x04, 0x02, 0x00, 0x03 };
          else if (function == 0x03 || function == 0x04) responsePdu = new byte[] { function, 0x02, 0x00, 0x03 };
          else if (function == 0x06) responsePdu = new byte[] { function, pdu[1], pdu[2], pdu[3], pdu[4] };
          else responsePdu = new byte[] { function, pdu[1], pdu[2], pdu[3], pdu[4] };

          byte[] response = Frame(tx, responseUnit, responsePdu);
          int number = Interlocked.Increment(ref replies);
          if (number == 1) {
            stream.Write(response, 0, 2);
            Thread.Sleep(10);
            stream.Write(response, 2, response.Length - 2);
            Fragmented = true;
          } else if (number == 2) {
            byte[] stale = Frame((ushort)(tx - 1), unit, responsePdu);
            byte[] both = Join(stale, response);
            stream.Write(both, 0, both.Length);
            Coalesced = true;
          } else {
            stream.Write(response, 0, response.Length);
          }
        }
      } catch (Exception) {
        if (!stopping) Thread.Sleep(5);
      } finally {
        if (client != null) client.Close();
      }
    }
  }

  public bool SawWrite(byte function, ushort address, ushort value) {
    string needle = " " + function.ToString("x2") + " "
      + ((byte)(address >> 8)).ToString("x2") + " " + ((byte)address).ToString("x2");
    string tail = " " + ((byte)(value >> 8)).ToString("x2") + " " + ((byte)value).ToString("x2");
    lock (gate) {
      foreach (string request in requests) {
        if (request.IndexOf(needle, StringComparison.Ordinal) >= 0
            && request.EndsWith(tail, StringComparison.Ordinal)) return true;
      }
    }
    return false;
  }

  public bool SawMultipleWrite(ushort address, ushort value) {
    string body = " 10 " + ((byte)(address >> 8)).ToString("x2") + " "
      + ((byte)address).ToString("x2") + " 00 01 02 "
      + ((byte)(value >> 8)).ToString("x2") + " " + ((byte)value).ToString("x2");
    lock (gate) {
      foreach (string request in requests) if (request.EndsWith(body, StringComparison.Ordinal)) return true;
    }
    return false;
  }

  public bool AllRequestsHaveMbap(byte unit) {
    lock (gate) {
      if (requests.Count == 0) return false;
      foreach (string request in requests) {
        string[] b = request.Split(' ');
        if (b.Length < 8 || b[2] != "00" || b[3] != "00" || b[6] != unit.ToString("x2")) return false;
        int following = Convert.ToInt32(b[4] + b[5], 16);
        if (following != b.Length - 6) return false;
      }
      return true;
    }
  }

  public void Dispose() {
    stopping = true;
    listener.Stop();
    if (!thread.Join(2000)) throw new Exception("fake inverter did not stop");
  }
}

public static class Wo1733Harness {
  static VfdPlan Plan(string definitionPath, int port, byte writeFunction) {
    object parsed;
    if (!Json.TryParse(File.ReadAllText(definitionPath), out parsed)) throw new Exception("definition JSON did not parse");
    Dictionary<string, object> document = Json.AsObj(parsed);
    Dictionary<string, object> link = Json.AsObj(Json.Get(document, "link"));
    link.Clear();
    link["transport"] = "tcp";
    link["host"] = "127.0.0.1";
    link["tcpPort"] = (double)port;
    link["slaveAddress"] = 7.0;
    link["pollIntervalMs"] = 15.0;
    link["retryCount"] = 1.0;
    link["timeoutMs"] = 250.0;
    Dictionary<string, object> protocol = Json.AsObj(Json.Get(document, "protocol"));
    protocol["writeFunction"] = (double)writeFunction;
    Dictionary<string, object> registers = Json.AsObj(Json.Get(document, "registers"));
    Json.AsObj(Json.Get(registers, "status"))["count"] = 0.0;
    string refusal;
    VfdPlan plan = VfdDefinitionFile.FromDocument(document, "WO-1733 loopback definition", out refusal);
    if (plan == null) throw new Exception(refusal);
    plan.ClientHeartbeatMs = 0;
    return plan;
  }

  static bool WaitFor(Func<bool> test, int timeoutMs) {
    DateTime until = DateTime.UtcNow.AddMilliseconds(timeoutMs);
    while (DateTime.UtcNow < until) {
      if (test()) return true;
      Thread.Sleep(10);
    }
    return test();
  }

  static void Row(string name, object value) { Console.WriteLine(name + "=" + value); }

  public static void Main(string[] args) {
    using (FakeTcpInverter fake = new FakeTcpInverter()) {
      VfdPlan singlePlan = Plan(args[0], fake.Port, 0x06);
      VfdLink single = new VfdLink(singlePlan);
      string open = single.Open();
      Row("single.open", open ?? "ok");
      Row("single.up", WaitFor(delegate { return single.Sample().LinkUp; }, 3000));
      Row("single.run", single.Run(VfdDirection.Clockwise, 1234) ?? "ok");
      Row("single.speed", WaitFor(delegate { return fake.SawWrite(0x06, singlePlan.SetpointRegister, 1234); }, 3000));
      Row("single.runWord", WaitFor(delegate { return fake.SawWrite(0x06, singlePlan.CommandRegister, singlePlan.RunCwWord); }, 3000));
      single.Stop();
      Row("single.stop", WaitFor(delegate { return fake.SawWrite(0x06, singlePlan.CommandRegister, singlePlan.StopWord); }, 3000));

      ushort[] words;
      string refusal;
      bool exceptionOk = single.TryReadRegisters(0x4444, 1, out words, out refusal);
      Row("error.exceptionOk", exceptionOk);
      Row("error.exception", refusal ?? "none");
      bool unitOk = single.TryReadRegisters(0x5555, 1, out words, out refusal);
      Row("error.unitOk", unitOk);
      Row("error.unit", refusal ?? "none");
      bool functionOk = single.TryReadRegisters(0x6666, 1, out words, out refusal);
      Row("error.functionOk", functionOk);
      Row("error.function", refusal ?? "none");
      bool timeoutOk = single.TryReadRegisters(0x8888, 1, out words, out refusal);
      Row("error.timeoutOk", timeoutOk);
      Row("error.timeout", refusal ?? "none");
      bool reconnectOk = single.TryReadRegisters(0x7777, 1, out words, out refusal);
      Row("reconnect.ok", reconnectOk);
      Row("reconnect.word", reconnectOk ? words[0].ToString(CultureInfo.InvariantCulture) : refusal);
      single.Close();

      VfdPlan multiplePlan = Plan(args[0], fake.Port, 0x10);
      VfdLink multiple = new VfdLink(multiplePlan);
      Row("multiple.open", multiple.Open() ?? "ok");
      Row("multiple.up", WaitFor(delegate { return multiple.Sample().LinkUp; }, 3000));
      Row("multiple.run", multiple.Run(VfdDirection.Clockwise, 4321) ?? "ok");
      Row("multiple.speed", WaitFor(delegate { return fake.SawMultipleWrite(multiplePlan.SetpointRegister, 4321); }, 3000));
      Row("multiple.runWord", WaitFor(delegate { return fake.SawMultipleWrite(multiplePlan.CommandRegister, multiplePlan.RunCwWord); }, 3000));
      multiple.Stop();
      Row("multiple.stop", WaitFor(delegate { return fake.SawMultipleWrite(multiplePlan.CommandRegister, multiplePlan.StopWord); }, 3000));
      multiple.Close();

      Row("wire.mbap", fake.AllRequestsHaveMbap(7));
      Row("wire.fragmented", fake.Fragmented);
      Row("wire.coalesced", fake.Coalesced);
      Row("wire.connections", fake.Connections);
    }
  }
}}
`

function runHarness(): Map<string, string> {
  const root = mkdtempSync(join(tmpdir(), 'liencam-wo1733-tcp-'))
  const source = join(root, 'Harness.cs')
  const executable = join(root, 'Harness.exe')
  writeFileSync(source, HARNESS)
  try {
    execFileSync(CSC, [
      '/nologo', `/out:${executable}`, '/main:LienCAM.Wo1733Harness',
      resolve(BRIDGE_DIR, 'Json.cs'), resolve(BRIDGE_DIR, 'Vfd.cs'), source,
    ], { stdio: 'pipe' })
    const out = execFileSync(executable, [SAMPLE_MACHINE_DEFINITION], { encoding: 'utf8', timeout: 30_000 })
    return new Map(out.trim().split(/\r?\n/).map((line) => {
      const at = line.indexOf('=')
      return [line.slice(0, at), line.slice(at + 1)]
    }))
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

let result: Map<string, string> | undefined
const rows = (): Map<string, string> => (result ??= runHarness())

describe.skipIf(!existsSync(CSC))('WO-1733 production Modbus TCP transport', () => {
  it('runs and stops through the existing operations with single-register writes', () => {
    expect(rows().get('single.open')).toBe('ok')
    expect(rows().get('single.up')).toBe('True')
    expect(rows().get('single.run')).toBe('ok')
    expect(rows().get('single.speed')).toBe('True')
    expect(rows().get('single.runWord')).toBe('True')
    expect(rows().get('single.stop')).toBe('True')
  }, 30_000)

  it('uses the same operations with multiple-register writes', () => {
    expect(rows().get('multiple.open')).toBe('ok')
    expect(rows().get('multiple.up')).toBe('True')
    expect(rows().get('multiple.run')).toBe('ok')
    expect(rows().get('multiple.speed')).toBe('True')
    expect(rows().get('multiple.runWord')).toBe('True')
    expect(rows().get('multiple.stop')).toBe('True')
  })

  it('frames MBAP bytes across fragmented and coalesced socket delivery', () => {
    expect(rows().get('wire.mbap')).toBe('True')
    expect(rows().get('wire.fragmented')).toBe('True')
    expect(rows().get('wire.coalesced')).toBe('True')
  })

  it('reports Modbus exceptions and rejects mismatched unit and function replies', () => {
    expect(rows().get('error.exceptionOk')).toBe('False')
    expect(rows().get('error.exception')).toContain('Modbus exception 2')
    expect(rows().get('error.unitOk')).toBe('False')
    expect(rows().get('error.unit')).toContain('different unit identifier')
    expect(rows().get('error.functionOk')).toBe('False')
    expect(rows().get('error.function')).toContain('different function')
    expect(rows().get('error.timeoutOk')).toBe('False')
    expect(rows().get('error.timeout')).toContain('did not answer inside 250 ms')
  })

  it('reconnects after a dropped socket within the existing retry budget', () => {
    expect(rows().get('reconnect.ok')).toBe('True')
    expect(rows().get('reconnect.word')).toBe('3')
    expect(Number(rows().get('wire.connections'))).toBeGreaterThanOrEqual(3)
  })
})
