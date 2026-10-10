import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// WO-1734 - A VFD WITH A BIT-FIELD CONTROL WORD.
//
// Operator ruling 2026-09-19: "I don't want us to write things in a way that only works
// for my machine ... someone could set up a different configuration in the
// future for their particular application." His Huanyang GT states one whole
// word per command (1 CW, 2 CCW, 5 stop, 7 reset, 0 release). Other inverters
// state a CONTROL WORD whose BITS mean run, reverse, stop and fault reset, and
// a command is "clear these bits, set those" over the word last written. Until
// this order Vfd.cs refused the second kind outright and knew exactly one reset
// shape, two steps long, resetFault then releaseReset.
//
// EVERYTHING BELOW RUNS THE REAL BRIDGE SOURCE. Vfd.cs and Json.cs are compiled
// by Windows csc, each document goes through VfdDefinitionFile.Load, and the
// words are taken off a real VfdLink's polling thread through a loopback Modbus
// port that records every write to the command register. No hardware is touched
// and no claim about hardware is made here: the acceptance is what this master
// PUTS ON THE WIRE for a document, which is the thing that used to be wrong.
//
// Command words are read as a run-length list - consecutive duplicates
// collapsed - because the poll loop rewrites the standing command every pass.
// What the list shows is the sequence of DIFFERENT words a document produced.

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
using System.Threading;

namespace LienCAM {
class RecordingPort : IVfdPort {
  readonly object gate = new object();
  readonly Queue<byte> inbox = new Queue<byte>();
  readonly List<ushort> commandWords = new List<ushort>();
  readonly ushort runStateAddress;
  readonly ushort commandAddress;
  public ushort RunStateWord;

  public RecordingPort(VfdPlan plan, ushort word) {
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
        QueueReply(reply, reply.Length);
      } else if (function == 0x06) {
        ushort value = (ushort)((bytes[4] << 8) | bytes[5]);
        if (address == commandAddress) commandWords.Add(value);
        QueueReply(bytes, 6);
      } else if (function == 0x10) {
        ushort value = (ushort)((bytes[7] << 8) | bytes[8]);
        if (address == commandAddress) commandWords.Add(value);
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

  /** Every command word written, consecutive duplicates collapsed. */
  public string Sequence() {
    lock (gate) {
      List<string> parts = new List<string>();
      bool have = false;
      ushort last = 0;
      foreach (ushort word in commandWords) {
        if (!have || word != last) parts.Add(word.ToString("X4"));
        have = true;
        last = word;
      }
      return string.Join(",", parts.ToArray());
    }
  }

  public void Close() {}
}

public static class Wo1734BitfieldHarness {
  static VfdPlan Load(string label, string path) {
    string refusal;
    VfdPlan plan = VfdDefinitionFile.Load(path, out refusal);
    Console.WriteLine(label + ".refusal=" + (refusal ?? "none"));
    return plan;
  }

  static void Words(string label, VfdPlan plan) {
    Console.WriteLine(label + ".idle=" + plan.IdleWord.ToString("X4"));
    Console.WriteLine(label + ".stopWord=" + plan.StopWord.ToString("X4"));
    Console.WriteLine(label + ".runCwWord=" + plan.RunCwWord.ToString("X4"));
    Console.WriteLine(label + ".runCcwWord=" + plan.RunCcwWord.ToString("X4"));
    Console.WriteLine(label + ".hasRunCw=" + plan.HasRunCw);
    Console.WriteLine(label + ".hasRunCcw=" + plan.HasRunCcw);
    Console.WriteLine(label + ".hasReset=" + plan.HasReset);
    Console.WriteLine(label + ".resetSteps=" + plan.ResetSteps.Count);
  }

  static ushort StoppedWord(VfdPlan plan) {
    foreach (KeyValuePair<ushort, VfdPlan.RunStateMeaning> row in plan.RunStateMeanings)
      if (row.Value == VfdPlan.RunStateMeaning.Stopped) return row.Key;
    return 0;
  }

  /** Open, run clockwise, run counter-clockwise, stop, clear a fault - the
   *  four things an operator does - and print what went on the wire. */
  static void Drive(string label, string path, int resetBudgetMs) {
    VfdPlan plan = Load(label, path);
    if (plan == null) return;
    Words(label, plan);
    RecordingPort port = new RecordingPort(plan, StoppedWord(plan));
    VfdLink link = new VfdLink(plan);
    link.OpenPort = delegate(VfdPlan ignored) { return port; };
    Console.WriteLine(label + ".open=" + (link.Open() ?? "ok"));
    int settle = Math.Max(200, plan.PollIntervalMs * 6);
    try {
      Thread.Sleep(settle);
      Console.WriteLine(label + ".runCw=" + (link.Run(VfdDirection.Clockwise, 1000) ?? "ok"));
      Thread.Sleep(settle);
      Console.WriteLine(label + ".runCcw=" + (link.Run(VfdDirection.CounterClockwise, 1000) ?? "ok"));
      Thread.Sleep(settle);
      link.Stop();
      Thread.Sleep(settle);
      link.RequestFaultReset();
      Thread.Sleep(resetBudgetMs + settle);
      Console.WriteLine(label + ".sequence=" + port.Sequence());
      Console.WriteLine(label + ".commandWord=" + link.Sample().CommandWord.ToString("X4"));
    } finally {
      link.Close();
    }
  }

  static void DefinitionOnly(string label, string path) {
    VfdPlan plan = Load(label, path);
    if (plan == null) return;
    Words(label, plan);
  }

  public static void Main(string[] args) {
    Console.WriteLine("platform=" + Environment.OSVersion.Platform);
    Drive("sampleMachine", args[0], 2400);
    Drive("bits", args[1], 200);
    Drive("threeStep", args[2], 200);
    DefinitionOnly("escapes", args[3]);
    Load("noStopBits", args[4]);
    Load("unknownStyle", args[5]);
    Load("noStopValue", args[6]);
  }
}}
`

interface Result {
  rows: Map<string, string>
  sourceSha256: string
}

/** A control-word drive, deliberately unlike Operator's. Its run bits and its
 *  direction bits sit in one word, and its STOP claims only the run bits - so a
 *  stop after a reverse leaves the direction bits exactly where they were,
 *  which is the behaviour a whole-word table cannot express at all. */
function bitfieldDefinition(sampleMachine: Doc): Doc {
  const doc = structuredClone(sampleMachine)
  doc.id = 'control-word-drive'
  doc.name = 'Control word drive'
  doc.commands = {
    style: 'bitfield',
    idle: 0x0000,
    commands: {
      runCw: { mask: 0x0033, value: 0x0012 },
      runCcw: { mask: 0x0033, value: 0x0022 },
      stop: { mask: 0x0003, value: 0x0001 },
      resetFault: { mask: 0x0080, value: 0x0080 },
      releaseReset: { mask: 0x0080, value: 0x0000 },
    },
  }
  doc.resetSequence = [
    { command: 'resetFault', delayMsAfter: 40 },
    { command: 'releaseReset', delayMsAfter: 0 },
  ]
  return doc
}

function runHarness(): Result {
  if (!existsSync(CSC)) throw new Error(`Windows C# compiler did not exist at ${CSC}`)
  const root = mkdtempSync(join(tmpdir(), 'liencam-wo1734-bitfield-'))
  const source = join(root, 'Harness.cs')
  const executable = join(root, 'Harness.exe')
  const sampleMachine = JSON.parse(readFileSync(SAMPLE_MACHINE_DEFINITION, 'utf8')) as Doc

  const bits = bitfieldDefinition(sampleMachine)

  // The same drive, clearing its fault a way the old loader could not play at
  // all: three steps rather than two. It is not a shape anybody has to use - it
  // is the proof that the step COUNT and ORDER come off the document.
  const threeStep = structuredClone(bits)
  threeStep.id = 'control-word-drive-three-step'
  threeStep.resetSequence = [
    { command: 'resetFault', delayMsAfter: 40 },
    { command: 'releaseReset', delayMsAfter: 40 },
    { command: 'resetFault', delayMsAfter: 0 },
  ]

  // A stop whose value sets a bit its mask does not claim. LienCAM's validator
  // refuses this document before it can be pushed; the bridge writes only the
  // bits the command claimed rather than inventing the rest.
  const escapes = structuredClone(bits)
  escapes.id = 'control-word-drive-escapes'
  ;((escapes.commands as Doc).commands as Doc).stop = { mask: 0x0003, value: 0x0081 }

  const noStopBits = structuredClone(bits)
  delete ((noStopBits.commands as Doc).commands as Doc).stop

  const unknownStyle = structuredClone(bits)
  ;(unknownStyle.commands as Doc).style = 'ladder'

  const noStopValue = structuredClone(sampleMachine)
  delete ((noStopValue.commands as Doc).values as Doc).stop

  const paths: string[] = [SAMPLE_MACHINE_DEFINITION]
  for (const [name, doc] of [
    ['bits', bits], ['three-step', threeStep], ['escapes', escapes],
    ['no-stop-bits', noStopBits], ['unknown-style', unknownStyle], ['no-stop-value', noStopValue],
  ] as [string, Doc][]) {
    const path = join(root, `${name}.definition.json`)
    writeFileSync(path, JSON.stringify(doc, null, 2))
    paths.push(path)
  }
  writeFileSync(source, HARNESS)

  try {
    execFileSync(CSC, [
      '/nologo', '/warn:4', `/out:${executable}`, '/main:LienCAM.Wo1734BitfieldHarness',
      VFD_SOURCE, JSON_SOURCE, source,
    ], { stdio: 'pipe' })
    const output = execFileSync(executable, paths, { encoding: 'utf8', timeout: 60_000 })
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

// Execute this Windows C# harness on Windows; Linux reports skipped, never
// passed. The compiler-exists assertion remains mandatory on Windows.
describe.skipIf(process.platform !== 'win32')('WO-1734 the bridge writes the command words each definition states', () => {
  it('actually compiles and runs the real production source on Windows', () => {
    expect(existsSync(CSC)).toBe(true)
    expect(run().rows.get('platform')).toBe('Win32NT')
    expect(run().sourceSha256).toMatch(/^[0-9a-f]{64}$/)
  }, 60_000)

  it("leaves Operator's whole-word table writing 1, 2, 5, 7 and 0 exactly as before", () => {
    const rows = run().rows
    expect(rows.get('sampleMachine.refusal')).toBe('none')
    expect(rows.get('sampleMachine.open')).toBe('ok')
    expect(rows.get('sampleMachine.stopWord')).toBe('0005')
    expect(rows.get('sampleMachine.runCwWord')).toBe('0001')
    expect(rows.get('sampleMachine.runCcwWord')).toBe('0002')
    expect(rows.get('sampleMachine.hasRunCw')).toBe('True')
    expect(rows.get('sampleMachine.hasRunCcw')).toBe('True')
    expect(rows.get('sampleMachine.resetSteps')).toBe('2')
    // stop, run forward, run reverse, stop, reset, release, stop.
    expect(rows.get('sampleMachine.sequence')).toBe('0005,0001,0002,0005,0007,0000,0005')
  })

  it('runs, reverses and stops a control-word drive on the bits it declares', () => {
    const rows = run().rows
    expect(rows.get('bits.refusal')).toBe('none')
    expect(rows.get('bits.open')).toBe('ok')
    expect(rows.get('bits.idle')).toBe('0000')
    expect(rows.get('bits.runCwWord')).toBe('0012')
    expect(rows.get('bits.runCcwWord')).toBe('0022')
    expect(rows.get('bits.stopWord')).toBe('0001')
    expect(rows.get('bits.hasRunCw')).toBe('True')
    expect(rows.get('bits.hasRunCcw')).toBe('True')
    const sequence = (rows.get('bits.sequence') ?? '').split(',')
    // Idle stop, forward, reverse, then the stop OVER the reverse word. Its
    // mask claims only the run pair, so the DIRECTION bits it never claimed
    // (0x0020, reverse) are still standing in 0x0021 afterwards - which is the
    // whole difference between a control word and a table of whole words.
    expect(sequence.slice(0, 4)).toEqual(['0001', '0012', '0022', '0021'])
    // The reset sets its own bit over that stopped word and clears it again.
    expect(sequence.slice(4)).toEqual(['00A1', '0021'])
    expect(rows.get('bits.commandWord')).toBe('0021')
  })

  it('never writes a whole-word stop at a control-word drive', () => {
    // The old loader refused this document; the failure this pins is the other
    // shape of the same bug - treating its `stop` value as the whole word and
    // wiping the bits the document said to leave alone.
    const sequence = (run().rows.get('bits.sequence') ?? '').split(',')
    expect(sequence).not.toContain('0000')
    expect(sequence.filter((word) => word === '0001')).toHaveLength(1)
  })

  it('plays the reset the document states, at the length and in the order it states it', () => {
    const rows = run().rows
    expect(rows.get('threeStep.refusal')).toBe('none')
    expect(rows.get('threeStep.hasReset')).toBe('True')
    expect(rows.get('threeStep.resetSteps')).toBe('3')
    const sequence = (rows.get('threeStep.sequence') ?? '').split(',')
    expect(sequence.slice(0, 4)).toEqual(['0001', '0012', '0022', '0021'])
    // Set, clear, set. The third step leaves the reset bit up, and the poll
    // loop's standing stop then writes 0x00A1 rather than 0x0021 - because
    // that is what this document asked for, not what Operator's asks for.
    expect(sequence.slice(4)).toEqual(['00A1', '0021', '00A1'])
  })

  it('writes only the bits a command claims when its value escapes its mask', () => {
    const rows = run().rows
    expect(rows.get('escapes.refusal')).toBe('none')
    expect(rows.get('escapes.stopWord')).toBe('0001')
  })

  it('refuses any table that cannot stop the spindle, in either style', () => {
    const rows = run().rows
    expect(rows.get('noStopBits.refusal')).toBe(
      "the VFD definition's control word has no 'stop' bits; "
      + 'a definition that cannot stop the spindle is refused.',
    )
    expect(rows.get('noStopValue.refusal')).toBe(
      "the VFD definition's command table has no 'stop' word; "
      + 'a definition that cannot stop the spindle is refused.',
    )
  })

  it('says plainly which two command styles a definition may be written in', () => {
    expect(run().rows.get('unknownStyle.refusal')).toBe(
      "the VFD definition's command table is 'value' (one word per command) "
      + "or 'bitfield' (bits inside one control word); this one says 'ladder'.",
    )
  })
})

// The same two facts on the page an operator edits this inverter on. A control
// word's `idle` and the table's `style` are facts of the document like every
// mask is, and until this order neither appeared anywhere in the editor - the
// idle word could be set only by hand-authoring JSON, which ADR-0044 is about.
// A row carries an edit BOX exactly when it carries a path (VfdReadout), so the
// paths below are what "editable in the common editor" means here.
describe('WO-1734 the command table states its style, and a control word its idle word', () => {
  it('names the style and makes the idle word editable on a control-word table', async () => {
    const { vfdCommandRows } = await import('../../components/machine/definition/SpindleLinkSection')
    const rows = vfdCommandRows({
      style: 'bitfield',
      idle: 0x0000,
      commands: {
        runCw: { mask: 0x0033, value: 0x0012 },
        stop: { mask: 0x0003, value: 0x0001 },
      },
    })
    expect(rows[0]).toEqual(['style', 'bitfield'])
    expect(rows[1]).toEqual(['idle word', '0', ['commands', 'idle']])
    expect(rows.slice(2)).toEqual([
      ['runCw mask', '51', ['commands', 'commands', 'runCw', 'mask']],
      ['runCw value', '18', ['commands', 'commands', 'runCw', 'value']],
      ['stop mask', '3', ['commands', 'commands', 'stop', 'mask']],
      ['stop value', '1', ['commands', 'commands', 'stop', 'value']],
    ])
  })

  it("names the style on Operator's whole-word table too, and leaves its rows alone", async () => {
    const { vfdCommandRows } = await import('../../components/machine/definition/SpindleLinkSection')
    const rows = vfdCommandRows({ style: 'value', values: { runCw: 1, stop: 5 } })
    expect(rows).toEqual([
      ['style', 'value'],
      ['runCw', '1', ['commands', 'values', 'runCw']],
      ['stop', '5', ['commands', 'values', 'stop']],
    ])
  })

  it('gives the style row no edit path, so it renders as a readout and not a box', async () => {
    const { vfdCommandRows } = await import('../../components/machine/definition/SpindleLinkSection')
    // Typing `bitfield` over `value` would leave a document with no masks and
    // no idle word - one the bridge refuses whole, spindle stop included.
    for (const table of [
      { style: 'value' as const, values: { stop: 5 } },
      { style: 'bitfield' as const, idle: 0, commands: { stop: { mask: 3, value: 1 } } },
    ]) {
      expect(vfdCommandRows(table)[0][2]).toBeUndefined()
    }
  })
})
