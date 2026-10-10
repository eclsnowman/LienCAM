import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// WO-1721 - THE BRIDGE CLASSIFIES EACH INVERTER'S RUN-STATE WORD FROM THAT
// INVERTER'S DEFINITION, NOT FROM HUANYANG'S NUMBERS.
//
// The real Vfd.cs and Json.cs are compiled by Windows csc. Each JSON document
// goes through VfdDefinitionFile.Load, and Operator's and the alternative drive are
// exercised through a real VfdLink with its polling thread and a loopback
// Modbus port. The port records immediate STOP writes and commanded direction;
// no controller or hardware claim is made here.

const BRIDGE_DIR = resolve('pendant/uccnc-bridge')
const VFD_SOURCE = resolve(BRIDGE_DIR, 'Vfd.cs')
const JSON_SOURCE = resolve(BRIDGE_DIR, 'Json.cs')
const SAMPLE_MACHINE_DEFINITION = resolve(BRIDGE_DIR, 'vfd/huanyang-gt.definition.json')
const CSC = join(
  process.env.WINDIR ?? 'C:\\Windows',
  'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe',
)

type Doc = Record<string, unknown>

const HARNESS = String.raw`
using System;
using System.Collections.Generic;
using System.IO.Ports;
using System.Reflection;
using System.Threading;

namespace LienCAM {
class RunStatePort : IVfdPort {
  readonly object gate = new object();
  readonly Queue<byte> inbox = new Queue<byte>();
  readonly ushort runStateAddress;
  readonly ushort commandAddress;
  public ushort RunStateWord;
  public readonly List<ushort> CommandWords = new List<ushort>();
  public int RunStateReads;

  public RunStatePort(VfdPlan plan, ushort word) {
    runStateAddress = plan.RunStateRegister;
    commandAddress = plan.CommandRegister;
    RunStateWord = word;
  }

  static ushort Crc(byte[] bytes, int count) {
    ushort crc = 0xFFFF;
    for (int i = 0; i < count; i++) {
      crc ^= bytes[i];
      for (int bit = 0; bit < 8; bit++)
        crc = (ushort)((crc & 1) != 0 ? (crc >> 1) ^ 0xA001 : crc >> 1);
    }
    return crc;
  }

  void QueueReply(byte[] reply, int count) {
    ushort crc = Crc(reply, count);
    for (int i = 0; i < count; i++) inbox.Enqueue(reply[i]);
    inbox.Enqueue((byte)(crc & 0xFF));
    inbox.Enqueue((byte)(crc >> 8));
  }

  public void Discard() { lock (gate) inbox.Clear(); }

  public void Write(byte[] bytes, int offset, int count) {
    lock (gate) {
      byte slave = bytes[0], function = bytes[1];
      ushort address = (ushort)((bytes[2] << 8) | bytes[3]);
      if (function == 0x03 || function == 0x04) {
        int words = (bytes[4] << 8) | bytes[5];
        byte[] reply = new byte[3 + words * 2];
        reply[0] = slave; reply[1] = function; reply[2] = (byte)(words * 2);
        for (int i = 0; i < words; i++) {
          ushort value = address == runStateAddress && i == 0 ? RunStateWord : (ushort)0;
          reply[3 + i * 2] = (byte)(value >> 8);
          reply[4 + i * 2] = (byte)(value & 0xFF);
        }
        if (address == runStateAddress) RunStateReads++;
        QueueReply(reply, reply.Length);
      } else if (function == 0x06) {
        ushort value = (ushort)((bytes[4] << 8) | bytes[5]);
        if (address == commandAddress) CommandWords.Add(value);
        QueueReply(bytes, 6);
      } else if (function == 0x10) {
        ushort value = (ushort)((bytes[7] << 8) | bytes[8]);
        if (address == commandAddress) CommandWords.Add(value);
        byte[] reply = new byte[6];
        Array.Copy(bytes, reply, 6);
        QueueReply(reply, 6);
      }
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

  public int CountCommand(ushort word) {
    lock (gate) {
      int count = 0;
      foreach (ushort seen in CommandWords) if (seen == word) count++;
      return count;
    }
  }

  public void Close() {}
}

public static class Wo1721RunStateHarness {
  static VfdLink.RunStateVerdict Classify(VfdPlan plan, ushort word, out string words) {
    Type byRefString = typeof(string).MakeByRefType();
    MethodInfo withPlan = typeof(VfdLink).GetMethod(
      "ClassifyRunState", BindingFlags.Public | BindingFlags.Static, null,
      new Type[] { typeof(VfdPlan), typeof(ushort), byRefString }, null);
    object[] args;
    MethodInfo method;
    if (withPlan != null) {
      method = withPlan;
      args = new object[] { plan, word, null };
    } else {
      method = typeof(VfdLink).GetMethod(
        "ClassifyRunState", BindingFlags.Public | BindingFlags.Static, null,
        new Type[] { typeof(ushort), byRefString }, null);
      args = new object[] { word, null };
    }
    if (method == null) throw new Exception("VfdLink.ClassifyRunState is missing");
    VfdLink.RunStateVerdict verdict = (VfdLink.RunStateVerdict)method.Invoke(null, args);
    words = (string)args[args.Length - 1];
    return verdict;
  }

  static VfdPlan Load(string label, string path) {
    string refusal;
    VfdPlan plan = VfdDefinitionFile.Load(path, out refusal);
    Console.WriteLine(label + ".refusal=" + (refusal ?? "none"));
    return plan;
  }

  static void PrintState(string label, VfdPlan plan, ushort word) {
    string words;
    VfdLink.RunStateVerdict verdict = Classify(plan, word, out words);
    Console.WriteLine(label + ".state" + word + "=" + verdict + "|" + words);
    Console.WriteLine(label + ".fault" + word + "=" + plan.IsFaulted(word));
  }

  static int TableCount(VfdPlan plan) {
    FieldInfo field = typeof(VfdPlan).GetField("RunStateMeanings");
    if (field == null) return -1;
    object table = field.GetValue(plan);
    PropertyInfo count = table == null ? null : table.GetType().GetProperty("Count");
    return count == null ? -1 : (int)count.GetValue(table, null);
  }

  static void LinkCase(string label, string path, ushort[] words, VfdDirection direction, ushort reportedWhileRunning) {
    VfdPlan plan = Load(label, path);
    if (plan == null) return;
    Console.WriteLine(label + ".tableCount=" + TableCount(plan));
    RunStatePort port = new RunStatePort(plan, words[0]);
    VfdLink link = new VfdLink(plan);
    link.OpenPort = delegate(VfdPlan ignored) { return port; };
    Console.WriteLine(label + ".open=" + (link.Open() ?? "ok"));
    try {
      foreach (ushort expected in words) {
        port.RunStateWord = expected;
        ushort observed;
        string readRefusal;
        bool read = link.TryReadRunState(out observed, out readRefusal);
        Console.WriteLine(label + ".read" + expected + "=" + read + "|" + observed + "|" + (readRefusal ?? "none"));
        PrintState(label, plan, observed);
        int before = port.CountCommand(plan.StopWord);
        link.Stop();
        int after = port.CountCommand(plan.StopWord);
        Console.WriteLine(label + ".stop" + expected + "=" + (after - before));
      }

      port.RunStateWord = reportedWhileRunning;
      ushort primed;
      string primeRefusal;
      link.TryReadRunState(out primed, out primeRefusal);
      Console.WriteLine(label + ".run=" + (link.Run(direction, 1200) ?? "ok"));
      Thread.Sleep(Math.Max(100, plan.PollIntervalMs * 4));
      VfdReading running = link.Sample();
      ushort commanded = direction == VfdDirection.Clockwise ? plan.RunCwWord : plan.RunCcwWord;
      Console.WriteLine(label + ".commandedWordSeen=" + (port.CountCommand(commanded) > 0));
      Console.WriteLine(label + ".commandedRunning=" + running.Running);
      Console.WriteLine(label + ".linkUp=" + running.LinkUp);
      Console.WriteLine(label + ".failures=" + running.ConsecutiveFailures);
      Console.WriteLine(label + ".runStateReads=" + port.RunStateReads);
      link.Stop();
      Console.WriteLine(label + ".stoppedRunning=" + link.Sample().Running);
    } finally {
      link.Close();
    }
  }

  static void DefinitionOnly(string label, string path, ushort word) {
    VfdPlan plan = Load(label, path);
    if (plan == null) return;
    Console.WriteLine(label + ".tableCount=" + TableCount(plan));
    PrintState(label, plan, word);
  }

  public static void Main(string[] args) {
    Console.WriteLine("platform=" + Environment.OSVersion.Platform);
    LinkCase("sampleMachine", args[0], new ushort[] { 1, 2, 3, 4, 5, 99 }, VfdDirection.Clockwise, 2);
    LinkCase("other", args[1], new ushort[] { 0, 1, 7, 99 }, VfdDirection.CounterClockwise, 1);
    DefinitionOnly("absent", args[2], 3);
    DefinitionOnly("empty", args[3], 3);
    Load("duplicate", args[4]);
  }
}}
`

interface Result {
  rows: Map<string, string>
  sourceSha256: string
}

function otherDefinition(sampleMachine: Doc): Doc {
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
  const root = mkdtempSync(join(tmpdir(), 'liencam-wo1721-run-state-'))
  const source = join(root, 'Harness.cs')
  const executable = join(root, 'Harness.exe')
  const otherPath = join(root, 'other.definition.json')
  const absentPath = join(root, 'absent.definition.json')
  const emptyPath = join(root, 'empty.definition.json')
  const duplicatePath = join(root, 'duplicate.definition.json')
  const sampleMachine = JSON.parse(readFileSync(SAMPLE_MACHINE_DEFINITION, 'utf8')) as Doc
  const other = otherDefinition(sampleMachine)
  const absent = structuredClone(other)
  delete ((absent.registers as Doc).runState as Doc).values
  const empty = structuredClone(other)
  const emptyRunState = (empty.registers as Doc).runState as Doc
  emptyRunState.values = []
  const duplicate = structuredClone(other)
  const duplicateRunState = (duplicate.registers as Doc).runState as Doc
  duplicateRunState.values = [
    { value: 1, meaning: 'running' },
    { value: 1, meaning: 'stopped' },
  ]

  writeFileSync(source, HARNESS)
  writeFileSync(otherPath, JSON.stringify(other, null, 2))
  writeFileSync(absentPath, JSON.stringify(absent, null, 2))
  writeFileSync(emptyPath, JSON.stringify(empty, null, 2))
  writeFileSync(duplicatePath, JSON.stringify(duplicate, null, 2))
  try {
    execFileSync(CSC, [
      '/nologo', '/warn:4', `/out:${executable}`, '/main:LienCAM.Wo1721RunStateHarness',
      VFD_SOURCE, JSON_SOURCE, source,
    ], { stdio: 'pipe' })
    const output = execFileSync(executable, [
      SAMPLE_MACHINE_DEFINITION, otherPath, absentPath, emptyPath, duplicatePath,
    ], { encoding: 'utf8', timeout: 30_000 })
    const rows = new Map<string, string>()
    for (const line of output.split(/\r?\n/)) {
      const match = /^([^=]+)=(.*)$/.exec(line)
      if (match) rows.set(match[1], match[2])
    }
    return {
      rows,
      sourceSha256: createHash('sha256').update(readFileSync(VFD_SOURCE)).digest('hex'),
    }
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

let result: Result | undefined
const run = (): Result => (result ??= runHarness())

// Execute these Windows C# harnesses on Windows; Linux reports skipped, never passed.
// The compiler-exists assertion remains mandatory on Windows.
describe.skipIf(process.platform !== 'win32')('WO-1721 bridge run-state meanings come from each VFD definition', () => {
  it('actually compiles and runs the real production source on Windows', () => {
    expect(existsSync(CSC)).toBe(true)
    expect(run().rows.get('platform')).toBe('Win32NT')
    expect(run().sourceSha256).toMatch(/^[0-9a-f]{64}$/)
  }, 30_000)

  it("preserves Operator's measured Huanyang meanings without using them as global defaults", () => {
    const rows = run().rows
    expect(rows.get('sampleMachine.refusal')).toBe('none')
    expect(rows.get('sampleMachine.state1')).toBe('Running|running forward')
    expect(rows.get('sampleMachine.state2')).toBe('Running|running in reverse')
    expect(rows.get('sampleMachine.state3')).toBe('SafeToKeep|stopped')
    expect(rows.get('sampleMachine.state4')).toContain('Unusable|FAULTED')
    expect(rows.get('sampleMachine.state5')).toContain('Unusable|powered off')
    expect(rows.get('sampleMachine.state99')).toContain('Unusable|an unrecognised code (99)')
    expect(rows.get('sampleMachine.fault3')).toBe('False')
    expect(rows.get('sampleMachine.fault4')).toBe('True')
    expect(rows.get('sampleMachine.tableCount')).toBe('5')
  })

  it('uses stopped 0, running 1, and faulted 7 from a different definition', () => {
    const rows = run().rows
    expect(rows.get('other.refusal')).toBe('none')
    expect(rows.get('other.state0')).toBe('SafeToKeep|stopped')
    expect(rows.get('other.state1')).toBe('Running|running')
    expect(rows.get('other.state7')).toContain('Unusable|FAULTED')
    expect(rows.get('other.state99')).toContain('Unusable|an unrecognised code (99)')
    expect(rows.get('other.fault1')).toBe('False')
    expect(rows.get('other.fault7')).toBe('True')
    expect(rows.get('other.tableCount')).toBe('3')
  })

  it('polls the fake inverter, keeps direction command-derived, and sends STOP in every state', () => {
    const rows = run().rows
    for (const word of [1, 2, 3, 4, 5, 99]) expect(Number(rows.get(`sampleMachine.stop${word}`))).toBeGreaterThanOrEqual(1)
    for (const word of [0, 1, 7, 99]) expect(Number(rows.get(`other.stop${word}`))).toBeGreaterThanOrEqual(1)
    expect(rows.get('sampleMachine.commandedWordSeen')).toBe('True')
    expect(rows.get('other.commandedWordSeen')).toBe('True')
    expect(rows.get('sampleMachine.commandedRunning')).toBe('True')
    expect(rows.get('other.commandedRunning')).toBe('True')
    expect(rows.get('sampleMachine.stoppedRunning')).toBe('False')
    expect(rows.get('other.stoppedRunning')).toBe('False')
    expect(rows.get('sampleMachine.linkUp')).toBe('True')
    expect(rows.get('other.linkUp')).toBe('True')
    expect(rows.get('sampleMachine.failures')).toBe('0')
    expect(rows.get('other.failures')).toBe('0')
    expect(Number(rows.get('sampleMachine.runStateReads'))).toBeGreaterThan(6)
    expect(Number(rows.get('other.runStateReads'))).toBeGreaterThan(4)
  })

  it('keeps absent, empty, and unmapped tables unknown and rejects explicit ambiguity', () => {
    const rows = run().rows
    expect(rows.get('absent.refusal')).toBe('none')
    expect(rows.get('absent.state3')).toContain('Unusable|an unrecognised code (3)')
    expect(rows.get('absent.tableCount')).toBe('0')
    expect(rows.get('empty.refusal')).toBe('none')
    expect(rows.get('empty.state3')).toContain('Unusable|an unrecognised code (3)')
    expect(rows.get('empty.tableCount')).toBe('0')
    expect(rows.get('duplicate.refusal')).toBe(
      'the VFD definition names run-state value 1 more than once; one value cannot mean two states.',
    )
  })
})
