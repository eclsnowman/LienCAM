import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// WO-1646 - THE SPINDLE LINK COMES ENTIRELY FROM THE VFD DEFINITION.
//
// The REAL Vfd.cs and Json.cs are compiled with csc beside a recording serial
// port (VfdLink.OpenPort, the WO-1278 seam). Each definition goes through the
// production loader (VfdDefinitionFile.Load) and a real VfdLink that runs the
// spindle and stops it. What the port was opened with and every Modbus frame
// that reached the wire are read back:
//
//   - Operator's Huanyang GT file (pendant/uccnc-bridge/vfd/) must produce exactly
//     today's link: COM3, 19200 8-N-1, slave 1, 297 ms, poll 25, function 0x06
//     writes to 0x1000 / 0x2000 and 0x03 reads of 0x1001 / 0x3003 x5;
//   - a second definition with a different speed, framing, slave, registers,
//     command words and function codes (0x04 reads, 0x10 writes) must put its
//     own values on the wire and none of Operator's;
//   - a definition that omits link values is refused, naming each one.
//
// NOT CLAIMED: an inverter. The conversation with a real drive is Tier 1.

const BRIDGE_DIR = resolve('pendant/uccnc-bridge')
const SAMPLE_MACHINE_DEFINITION = resolve('pendant/uccnc-bridge/vfd/huanyang-gt.definition.json')
const CSC = join(
  process.env.WINDIR ?? 'C:\\Windows',
  'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe',
)

type Doc = Record<string, unknown>

/** A different drive: nothing about its link or protocol is Operator's. */
function otherDefinition(): Doc {
  const sampleMachine = JSON.parse(readFileSync(SAMPLE_MACHINE_DEFINITION, 'utf8')) as Doc
  return {
    ...sampleMachine,
    id: 'other-drive',
    name: 'Other drive',
    link: {
      transport: 'rtu', port: 'COM7', baud: 9600, dataBits: 8, parity: 'even',
      stopBits: 2, rs485: 'two-wire', slaveAddress: 9, pollIntervalMs: 60,
      retryCount: 2, timeoutMs: 150,
    },
    protocol: { readFunction: 4, writeFunction: 16, wordOrder: 'high-first' },
    registers: {
      command: { address: 0x0100, count: 1 },
      setpoint: { address: 0x0101, count: 1, scale: 'set.rpm', encode: { round: 'nearest', min: 0, max: 24000 } },
      runState: { address: 0x0200, count: 1 },
      status: { address: 0x0300, count: 3 },
    },
    commands: { style: 'value', values: { runCw: 0x12, runCcw: 0x22, stop: 0x40 } },
    resetSequence: [],
    status: [],
  }
}

const HARNESS = `
using System;
using System.Collections.Generic;
using System.IO.Ports;
using System.Threading;
namespace LienCAM {
class RecordingPort : IVfdPort {
  readonly object gate = new object();
  readonly Queue<byte> inbox = new Queue<byte>();
  public readonly List<string> Frames = new List<string>();
  static ushort Crc(byte[] b, int n) {
    ushort crc = 0xFFFF;
    for (int i = 0; i < n; i++) {
      crc ^= b[i];
      for (int k = 0; k < 8; k++) crc = (ushort)((crc & 1) != 0 ? (crc >> 1) ^ 0xA001 : crc >> 1);
    }
    return crc;
  }
  void Queue(byte[] reply, int n) {
    ushort c = Crc(reply, n);
    for (int i = 0; i < n; i++) inbox.Enqueue(reply[i]);
    inbox.Enqueue((byte)(c & 0xFF)); inbox.Enqueue((byte)(c >> 8));
  }
  public void Discard() { lock (gate) inbox.Clear(); }
  public void Write(byte[] b, int offset, int count) {
    lock (gate) {
      byte slave = b[0], fn = b[1];
      int addr = (b[2] << 8) | b[3];
      string frame = "slave " + slave + " fn 0x" + fn.ToString("x2") + " @0x" + addr.ToString("x4");
      if (fn == 0x03 || fn == 0x04) {
        int n = (b[4] << 8) | b[5];
        frame += " x" + n;
        byte[] reply = new byte[3 + n * 2];
        reply[0] = slave; reply[1] = fn; reply[2] = (byte)(n * 2);
        Queue(reply, reply.Length);
      } else if (fn == 0x06) {
        frame += " = 0x" + ((b[4] << 8) | b[5]).ToString("x4") + " len " + count;
        Queue(b, 6);
      } else if (fn == 0x10) {
        frame += " = 0x" + ((b[7] << 8) | b[8]).ToString("x4") + " qty " + ((b[4] << 8) | b[5])
          + " bytes " + b[6] + " len " + count;
        byte[] reply = new byte[6];
        Array.Copy(b, reply, 6);
        Queue(reply, 6);
      }
      if (!Frames.Contains(frame)) Frames.Add(frame);
    }
  }
  public int Read(byte[] buffer, int offset, int count, int timeoutMs) {
    lock (gate) {
      if (inbox.Count == 0) throw new TimeoutException();
      int got = 0;
      while (got < count && inbox.Count > 0) buffer[offset + got++] = inbox.Dequeue();
      return got;
    }
  }
  public void Close() {}
}
public static class Wo1646VfdHarness {
  static void Case(string label, string path) {
    string refusal;
    VfdPlan plan = VfdDefinitionFile.Load(path, out refusal);
    Console.WriteLine(label + ".refusal=" + (refusal ?? "none"));
    if (plan == null) return;
    var port = new RecordingPort();
    var link = new VfdLink(plan);
    string opened = "never";
    link.OpenPort = delegate(VfdPlan p) {
      opened = p.PortName + " " + p.Baud + " " + p.DataBits + "-" + p.SerialParity + "-" + p.SerialStopBits
        + " slave " + p.SlaveAddress + " timeout " + p.TimeoutMs + " poll " + p.PollIntervalMs
        + " retry " + p.RetryCount;
      return port;
    };
    Console.WriteLine(label + ".open=" + (link.Open() ?? "ok"));
    Console.WriteLine(label + ".port=" + opened);
    link.Heartbeat();
    Thread.Sleep(400);
    link.Heartbeat();
    Console.WriteLine(label + ".run=" + (link.Run(VfdDirection.Clockwise, 1234) ?? "ok"));
    Thread.Sleep(400);
    link.Heartbeat();
    link.Stop();
    link.Close();
    lock (port) foreach (string f in port.Frames) Console.WriteLine(label + ".frame=" + f);
  }
  public static void Main(string[] args) {
    Case("sampleMachine", args[0]);
    Case("other", args[1]);
    Case("unset", args[2]);
  }
}}
`

interface Result {
  one: Map<string, string>
  frames: Map<string, string[]>
}

function runHarness(): Result {
  const root = mkdtempSync(join(tmpdir(), 'liencam-wo1646-vfd-'))
  const source = join(root, 'Harness.cs')
  const executable = join(root, 'Harness.exe')
  const other = join(root, 'other.definition.json')
  const unset = join(root, 'unset.definition.json')
  writeFileSync(other, JSON.stringify(otherDefinition(), null, 2))
  const partial = otherDefinition()
  const link = { ...(partial.link as Doc) }
  delete link.baud
  delete link.parity
  delete link.timeoutMs
  writeFileSync(unset, JSON.stringify({ ...partial, link }, null, 2))
  writeFileSync(source, HARNESS)
  try {
    execFileSync(CSC, [
      '/nologo', `/out:${executable}`, '/main:LienCAM.Wo1646VfdHarness',
      resolve(BRIDGE_DIR, 'Vfd.cs'), resolve(BRIDGE_DIR, 'Json.cs'), source,
    ], { stdio: 'pipe' })
    const out = execFileSync(executable, [SAMPLE_MACHINE_DEFINITION, other, unset], { encoding: 'utf8' })
    const one = new Map<string, string>()
    const frames = new Map<string, string[]>()
    for (const line of out.split(/\r?\n/)) {
      const m = /^(\w+)\.(\w+)=(.*)$/.exec(line)
      if (!m) continue
      if (m[2] === 'frame') frames.set(m[1], [...(frames.get(m[1]) ?? []), m[3]])
      else one.set(`${m[1]}.${m[2]}`, m[3])
    }
    return { one, frames }
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

let result: Result | undefined
const run = (): Result => (result ??= runHarness())

describe.skipIf(!existsSync(CSC))('WO-1646 VFD link comes from the definition', () => {
  it("Operator's definition opens exactly today's link and speaks today's frames", () => {
    const { one, frames } = run()
    expect(one.get('sampleMachine.refusal')).toBe('none')
    expect(one.get('sampleMachine.open')).toBe('ok')
    expect(one.get('sampleMachine.port')).toBe('COM3 19200 8-None-One slave 1 timeout 297 poll 25 retry 1')
    expect(one.get('sampleMachine.run')).toBe('ok')
    expect(frames.get('sampleMachine')).toEqual(expect.arrayContaining([
      'slave 1 fn 0x06 @0x2000 = 0x04d2 len 8',
      'slave 1 fn 0x03 @0x1001 x1',
      'slave 1 fn 0x03 @0x3003 x5',
      'slave 1 fn 0x06 @0x1000 = 0x0001 len 8',
      'slave 1 fn 0x06 @0x1000 = 0x0005 len 8',
    ]))
  })

  it('a second definition drives the link with its own values and none of Operator\'s', () => {
    const { one, frames } = run()
    expect(one.get('other.refusal')).toBe('none')
    expect(one.get('other.open')).toBe('ok')
    expect(one.get('other.port')).toBe('COM7 9600 8-Even-Two slave 9 timeout 150 poll 60 retry 2')
    expect(one.get('other.run')).toBe('ok')
    const seen = frames.get('other') ?? []
    expect(seen).toEqual(expect.arrayContaining([
      'slave 9 fn 0x10 @0x0101 = 0x04d2 qty 1 bytes 2 len 11',
      'slave 9 fn 0x04 @0x0200 x1',
      'slave 9 fn 0x04 @0x0300 x3',
      'slave 9 fn 0x10 @0x0100 = 0x0012 qty 1 bytes 2 len 11',
      'slave 9 fn 0x10 @0x0100 = 0x0040 qty 1 bytes 2 len 11',
    ]))
    expect(seen.filter((f) => /slave 1 |@0x1000|@0x2000|@0x1001|@0x3003|fn 0x06|fn 0x03/.test(f))).toEqual([])
  })

  it('a definition that omits link values is refused, naming each one', () => {
    const { one } = run()
    expect(one.get('unset.refusal')).toBe(
      "the VFD definition's link leaves baud, parity, timeoutMs unset, so the spindle link was "
      + "not opened. Fill them in from the drive's own settings.",
    )
    expect(one.get('unset.open')).toBeUndefined()
  })
})
