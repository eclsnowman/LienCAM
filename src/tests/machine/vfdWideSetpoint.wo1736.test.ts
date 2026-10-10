import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  compileVfdDefinition,
  HUANYANG_GT,
  validateVfdDefinition,
  vfdLinkFromTemplate,
  vfdSetpointCeiling,
  vfdSetpointRegisterWords,
  vfdSetpointWord,
  type VfdDefinition,
} from '../../lib/machine/vfd'

// WO-1736 - A VFD WITH A 32-BIT SPEED SETPOINT.
//
// Operator ruling 2026-09-19: "I don't want us to write things in a way that only works
// for my machine ... someone could set up a different configuration in the
// future for their particular application." His Huanyang GT takes its speed in
// ONE holding register, and until this order that was the only setpoint this
// bridge could write - one 16-bit word, always, at one address.
//
// Plenty of drives take the speed reference as a 32-bit value in a REGISTER
// PAIR, and which half goes first is a fact of the drive rather than of Modbus.
// 18,000 RPM high-first is 0x0000 0x4650; low-first is 0x4650 0x0000. An
// inverter handed the pair the wrong way round runs at a different speed, which
// is why the definition states the order and nothing here guesses it.
//
// EVERYTHING IN THE FIRST BLOCK RUNS THE REAL BRIDGE SOURCE. Vfd.cs and Json.cs
// are compiled by Windows csc, each document goes through VfdDefinitionFile.Load
// and the bytes are taken off a real VfdLink's polling thread through a loopback
// Modbus port that records every frame aimed at the setpoint register. No
// hardware is touched and no claim about hardware is made here: the acceptance
// is what this master PUTS ON THE WIRE for a document.
//
// The setpoint the master is asked for is not a number invented by this test:
// it is what LienCAM's own `vfdSetpointWord` computes from that same document's
// scale expression, handed to the harness as an argument. The two halves of the
// arithmetic are the same arithmetic.

const BRIDGE_DIR = resolve('pendant/uccnc-bridge')
const VFD_SOURCE = resolve(BRIDGE_DIR, 'Vfd.cs')
const JSON_SOURCE = resolve(BRIDGE_DIR, 'Json.cs')
const SAMPLE_MACHINE_DEFINITION = resolve(BRIDGE_DIR, 'vfd/huanyang-gt.definition.json')
const CSC = join(
  process.env.WINDIR ?? 'C:\\Windows',
  'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe',
)

type Doc = Record<string, unknown>

/** Operator's shipped document, read off the file the bridge is started with. */
const SAMPLE_MACHINE_DOC = JSON.parse(readFileSync(SAMPLE_MACHINE_DEFINITION, 'utf8')) as Doc

const HARNESS = String.raw`
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO.Ports;
using System.Threading;

namespace LienCAM {
/** A loopback Modbus slave that writes down every frame aimed at the setpoint
 *  register pair, grouped by poll pass. */
class SetpointRecordingPort : IVfdPort {
  readonly object gate = new object();
  readonly Queue<byte> inbox = new Queue<byte>();
  readonly List<string> groups = new List<string>();
  readonly ushort runStateAddress;
  readonly ushort setpointAddress;
  readonly int setpointWords;
  string pending;
  public ushort RunStateWord;

  public SetpointRecordingPort(VfdPlan plan, ushort word) {
    runStateAddress = plan.RunStateRegister;
    setpointAddress = plan.SetpointRegister;
    setpointWords = plan.SetpointWordCount;
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

  static string Hex(int value, int digits) {
    return value.ToString("X" + digits.ToString(CultureInfo.InvariantCulture));
  }

  void CloseGroup() {
    if (pending == null) return;
    if (groups.Count == 0 || groups[groups.Count - 1] != pending) groups.Add(pending);
    pending = null;
  }

  /** One frame aimed at the setpoint. A pass always writes the FIRST word
   *  first, so a write to the setpoint's own address opens a new group. */
  void RecordSetpointFrame(ushort address, string frame) {
    if (address == setpointAddress) { CloseGroup(); pending = frame; }
    else if (pending != null) pending = pending + "," + frame;
    else pending = frame;
  }

  bool IsSetpoint(ushort address) {
    return address >= setpointAddress && address < setpointAddress + Math.Max(1, setpointWords);
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
          ushort value = (ushort)(address + i) == runStateAddress ? RunStateWord : (ushort)0;
          reply[3 + i * 2] = (byte)(value >> 8);
          reply[4 + i * 2] = (byte)(value & 0xFF);
        }
        QueueReply(reply, reply.Length);
      } else if (function == 0x06) {
        ushort value = (ushort)((bytes[4] << 8) | bytes[5]);
        if (IsSetpoint(address))
          RecordSetpointFrame(address, "06@" + Hex(address, 4) + ":" + Hex(value, 4));
        QueueReply(bytes, 6);
      } else if (function == 0x10) {
        int quantity = (bytes[4] << 8) | bytes[5];
        if (IsSetpoint(address)) {
          string data = "";
          for (int i = 0; i < quantity; i++)
            data += Hex((bytes[7 + i * 2] << 8) | bytes[8 + i * 2], 4);
          RecordSetpointFrame(address,
            "10@" + Hex(address, 4) + "x" + quantity.ToString(CultureInfo.InvariantCulture) + ":" + data);
        }
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

  /** Every pass's setpoint frames, consecutive identical passes collapsed. */
  public string Sequence() {
    lock (gate) {
      CloseGroup();
      return string.Join(";", groups.ToArray());
    }
  }

  public void Close() {}
}

public static class Wo1736WideSetpointHarness {
  static VfdPlan Load(string label, string path) {
    string refusal;
    VfdPlan plan = VfdDefinitionFile.Load(path, out refusal);
    Console.WriteLine(label + ".refusal=" + (refusal ?? "none"));
    return plan;
  }

  static ushort StoppedWord(VfdPlan plan) {
    foreach (KeyValuePair<ushort, VfdPlan.RunStateMeaning> row in plan.RunStateMeanings)
      if (row.Value == VfdPlan.RunStateMeaning.Stopped) return row.Key;
    return 0;
  }

  /** Open, ask for one speed, stop - and print what the setpoint register saw. */
  static void Drive(string label, string path, string setpointText) {
    VfdPlan plan = Load(label, path);
    if (plan == null) return;
    Console.WriteLine(label + ".setpointWords=" + plan.SetpointWordCount);
    Console.WriteLine(label + ".highWordFirst=" + plan.SetpointHighWordFirst);
    Console.WriteLine(label + ".writeFunction=" + plan.WriteFunction.ToString("X2"));
    uint value = uint.Parse(setpointText, CultureInfo.InvariantCulture);
    SetpointRecordingPort port = new SetpointRecordingPort(plan, StoppedWord(plan));
    VfdLink link = new VfdLink(plan);
    link.OpenPort = delegate(VfdPlan ignored) { return port; };
    Console.WriteLine(label + ".open=" + (link.Open() ?? "ok"));
    int settle = Math.Max(200, plan.PollIntervalMs * 6);
    try {
      Thread.Sleep(settle);
      Console.WriteLine(label + ".run=" + (link.Run(VfdDirection.Clockwise, value) ?? "ok"));
      Thread.Sleep(settle);
      Console.WriteLine(label + ".reported=" + link.Sample().SetpointWord.ToString(CultureInfo.InvariantCulture));
      link.Stop();
      Thread.Sleep(settle);
      Console.WriteLine(label + ".sequence=" + port.Sequence());
    } finally {
      link.Close();
    }
  }

  public static void Main(string[] args) {
    Console.WriteLine("platform=" + Environment.OSVersion.Platform);
    Drive("sampleMachine", args[0], args[1]);
    Drive("wideHigh", args[2], args[3]);
    Drive("wideLow", args[4], args[5]);
    Drive("wideSingle", args[6], args[7]);
    Load("tooWide", args[8]);
    Load("noWordOrder", args[9]);
  }
}}
`

interface Result {
  rows: Map<string, string>
  sourceSha256: string
}

/** A drive whose speed reference is a 32-bit register pair - deliberately
 *  unlike Operator's, and nothing in the product was edited to make it work. */
function wideDefinition(sampleMachine: Doc, overrides: {
  id: string
  wordOrder: string
  writeFunction: number
  scale: string
}): Doc {
  const doc = structuredClone(sampleMachine)
  doc.id = overrides.id
  doc.name = `Wide setpoint drive (${overrides.wordOrder})`
  doc.protocol = {
    readFunction: 3,
    writeFunction: overrides.writeFunction,
    wordOrder: overrides.wordOrder,
  }
  doc.registers = {
    ...(doc.registers as Doc),
    setpoint: {
      address: 0x2000,
      count: 2,
      scale: overrides.scale,
      encode: { round: 'nearest', min: 0, max: 0xFFFFFFFF },
    },
  }
  return doc
}

/** The same 18,000 RPM the acceptance names, scaled by the document itself. */
function setpointFor(doc: Doc, rpm: number): number {
  const compiled = compileVfdDefinition(doc as unknown as VfdDefinition)
  if (!compiled.ok) throw new Error(`${String(doc.id)} did not compile: ${compiled.sentences.join('; ')}`)
  const result = vfdSetpointWord(compiled.definition, compiled.compiled, rpm)
  if (!result.ok) throw new Error(`${String(doc.id)} has no setpoint for ${rpm}: ${result.sentence}`)
  return result.word
}

function runHarness(): Result {
  if (!existsSync(CSC)) throw new Error(`Windows C# compiler did not exist at ${CSC}`)
  const root = mkdtempSync(join(tmpdir(), 'liencam-wo1736-wide-'))
  const source = join(root, 'Harness.cs')
  const executable = join(root, 'Harness.exe')
  const sampleMachine = SAMPLE_MACHINE_DOC

  // Plain RPM in a 32-bit pair, written as one block (0x10).
  const wideHigh = wideDefinition(SAMPLE_MACHINE_DOC, {
    id: 'wide-setpoint-high-first', wordOrder: 'high-first', writeFunction: 0x10, scale: 'set.rpm',
  })
  const wideLow = wideDefinition(SAMPLE_MACHINE_DOC, {
    id: 'wide-setpoint-low-first', wordOrder: 'low-first', writeFunction: 0x10, scale: 'set.rpm',
  })
  // Hundredths of an RPM, and a drive that can only be written one register at
  // a time (0x06). 18,000 RPM is 1,800,000 - which no 16-bit setpoint can
  // carry at all, and which used to come out of this bridge as 30,528.
  const wideSingle = wideDefinition(SAMPLE_MACHINE_DOC, {
    id: 'wide-setpoint-single-write', wordOrder: 'high-first', writeFunction: 6, scale: 'set.rpm * 100',
  })

  // Three registers is not a speed reference any inverter document describes,
  // and the bridge would have to invent the arithmetic for it.
  const tooWide = structuredClone(wideHigh)
  tooWide.id = 'setpoint-three-registers'
  ;((tooWide.registers as Doc).setpoint as Doc).count = 3

  // A pair with nothing saying which way round it goes. Guessing is the wrong
  // speed half the time, so it is refused BY NAME.
  const noWordOrder = structuredClone(wideHigh)
  noWordOrder.id = 'wide-setpoint-no-word-order'
  delete (noWordOrder.protocol as Doc).wordOrder

  const args: string[] = [
    SAMPLE_MACHINE_DEFINITION, String(setpointFor(sampleMachine, 18_000)),
  ]
  for (const doc of [wideHigh, wideLow, wideSingle]) {
    const path = join(root, `${String(doc.id)}.definition.json`)
    writeFileSync(path, JSON.stringify(doc, null, 2))
    args.push(path, String(setpointFor(doc, 18_000)))
  }
  for (const doc of [tooWide, noWordOrder]) {
    const path = join(root, `${String(doc.id)}.definition.json`)
    writeFileSync(path, JSON.stringify(doc, null, 2))
    args.push(path)
  }
  writeFileSync(source, HARNESS)

  try {
    execFileSync(CSC, [
      '/nologo', '/warn:4', `/out:${executable}`, '/main:LienCAM.Wo1736WideSetpointHarness',
      VFD_SOURCE, JSON_SOURCE, source,
    ], { stdio: 'pipe' })
    const output = execFileSync(executable, args, { encoding: 'utf8', timeout: 60_000 })
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
describe.skipIf(process.platform !== 'win32')('WO-1736 the bridge writes the setpoint shape each definition states', () => {
  it('actually compiles and runs the real production source on Windows', () => {
    expect(existsSync(CSC)).toBe(true)
    expect(run().rows.get('platform')).toBe('Win32NT')
    expect(run().sourceSha256).toMatch(/^[0-9a-f]{64}$/)
  }, 60_000)

  it("leaves Operator's one-register setpoint writing the single word it always did", () => {
    const rows = run().rows
    expect(rows.get('sampleMachine.refusal')).toBe('none')
    expect(rows.get('sampleMachine.open')).toBe('ok')
    expect(rows.get('sampleMachine.setpointWords')).toBe('1')
    expect(rows.get('sampleMachine.writeFunction')).toBe('06')
    expect(rows.get('sampleMachine.run')).toBe('ok')
    // 18,000 / 2.4 = 7,500 = 0x1D4C, one 0x06 frame at 0x2000. The pass before
    // the run writes a zero setpoint, the pass after the stop writes it again.
    const passes = (rows.get('sampleMachine.sequence') ?? '').split(';')
    expect(passes).toContain('06@2000:1D4C')
    expect(passes.every((pass) => /^06@2000:[0-9A-F]{4}$/.test(pass))).toBe(true)
    expect(rows.get('sampleMachine.reported')).toBe('7500')
  })

  it('writes 18,000 RPM as the two words a high-first 32-bit drive states', () => {
    const rows = run().rows
    expect(rows.get('wideHigh.refusal')).toBe('none')
    expect(rows.get('wideHigh.open')).toBe('ok')
    expect(rows.get('wideHigh.setpointWords')).toBe('2')
    expect(rows.get('wideHigh.highWordFirst')).toBe('True')
    expect(rows.get('wideHigh.run')).toBe('ok')
    // One 0x10 frame, two registers: 0x0000 then 0x4650. The pair arrives at
    // the inverter together, which is the only reason 0x10 is worth having.
    expect((rows.get('wideHigh.sequence') ?? '').split(';')).toContain('10@2000x2:00004650')
    expect(rows.get('wideHigh.reported')).toBe('18000')
  })

  it('writes the SAME speed the other way round when the document says low-first', () => {
    const rows = run().rows
    expect(rows.get('wideLow.refusal')).toBe('none')
    expect(rows.get('wideLow.highWordFirst')).toBe('False')
    const passes = (rows.get('wideLow.sequence') ?? '').split(';')
    expect(passes).toContain('10@2000x2:46500000')
    // THE CHECK THAT COULD NOT PASS IF THE ORDER CAME FROM THE BRIDGE: the two
    // documents differ in one word, and so do the wires.
    expect(passes).not.toContain('10@2000x2:00004650')
    expect(rows.get('wideLow.reported')).toBe('18000')
  })

  it('carries a speed no 16-bit register can hold, one register at a time', () => {
    const rows = run().rows
    expect(rows.get('wideSingle.refusal')).toBe('none')
    expect(rows.get('wideSingle.setpointWords')).toBe('2')
    expect(rows.get('wideSingle.writeFunction')).toBe('06')
    expect(rows.get('wideSingle.run')).toBe('ok')
    // 18,000 RPM in hundredths is 1,800,000 = 0x001B7740. A 0x06 drive has no
    // frame that carries a pair, so it is two writes at consecutive addresses,
    // high word first because this document says high-first.
    expect((rows.get('wideSingle.sequence') ?? '').split(';'))
      .toContain('06@2000:001B,06@2001:7740')
    // The 16-bit master would have truncated this to 0x7740 - 30,528 - and run
    // the spindle at 305 RPM while reporting 18,000.
    expect(rows.get('wideSingle.reported')).toBe('1800000')
  })

  it('refuses a setpoint wider than a register pair, by name', () => {
    expect(run().rows.get('tooWide.refusal')).toBe(
      "the VFD definition's speed setpoint is 3 registers wide; "
      + 'a speed setpoint is one register (16-bit) or two (32-bit).',
    )
  })

  it('refuses a 32-bit setpoint whose document never says which word goes first', () => {
    expect(run().rows.get('noWordOrder.refusal')).toBe(
      "the VFD definition's speed setpoint is two registers wide, so "
      + "protocol.wordOrder has to say 'high-first' or 'low-first'; this one says '(none)'. "
      + 'Writing the pair the wrong way round is a different speed.',
    )
  })
})

// The same arithmetic on the LienCAM side, which is where the setpoint is
// computed before it is ever sent. Pure functions, so they run everywhere.
describe('WO-1736 LienCAM splits a wide setpoint the way the definition states', () => {
  const wide = (wordOrder: string): VfdDefinition => wideDefinition(SAMPLE_MACHINE_DOC, {
    id: 'wide-setpoint-arith', wordOrder, writeFunction: 0x10, scale: 'set.rpm',
  }) as unknown as VfdDefinition

  it("leaves Operator's one-register setpoint as one word", () => {
    expect(vfdSetpointRegisterWords(SAMPLE_MACHINE_DOC as unknown as VfdDefinition, 7500)).toEqual([0x1D4C])
  })

  it("leaves the inverter the APP declares - Operator's, from the model picker - one register wide", () => {
    // The acceptance runs on two definitions, and this is the first of them
    // reached the way the product reaches it: choosing "Modbus VFD" copies this
    // template into the machine record. Not the bridge's copy of the file.
    const declared = vfdLinkFromTemplate(HUANYANG_GT.id, 'liencnc-v2')
    expect(declared).not.toBeNull()
    if (declared === null) return
    expect(declared.registers.setpoint.count).toBe(1)
    expect(declared.protocol.wordOrder).toBe('high-first')
    // The store's own cast: a machine record's provenance union is wider than
    // the format's, and every caller in machineSession.ts hands it over the
    // same way (machineSession.ts:9050).
    expect(validateVfdDefinition(declared as unknown as VfdDefinition).ok).toBe(true)
    expect(vfdSetpointRegisterWords(declared, 7500)).toEqual([0x1D4C])
  })

  it('splits 18,000 into the stated pair, either way round', () => {
    expect(vfdSetpointRegisterWords(wide('high-first'), 18_000)).toEqual([0x0000, 0x4650])
    expect(vfdSetpointRegisterWords(wide('low-first'), 18_000)).toEqual([0x4650, 0x0000])
  })

  it('splits a value above 16 bits without losing the top of it', () => {
    expect(vfdSetpointRegisterWords(wide('high-first'), 1_800_000)).toEqual([0x001B, 0x7740])
    expect(vfdSetpointRegisterWords(wide('low-first'), 4_294_967_295)).toEqual([0xFFFF, 0xFFFF])
  })

  it('clamps a wide setpoint to the whole width the document states, not to 16 bits', () => {
    const definition = wide('high-first')
    const compiled = compileVfdDefinition(definition)
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) return
    // 1,800,000 is far past 16 bits and is NOT clamped: this drive stated a
    // 32-bit setpoint, so that is where its ceiling is.
    const inRange = vfdSetpointWord(compiled.definition, compiled.compiled, 1_800_000)
    expect(inRange.ok && inRange.word).toBe(1_800_000)
    expect(inRange.ok && inRange.clamped).toBe(false)
    // And it still stops somewhere - at the document's own ceiling, reported
    // rather than wrapped, because a spindle that silently ran at a wrapped
    // number is the thing `clamped` exists to prevent.
    const absurd = vfdSetpointWord(compiled.definition, compiled.compiled, 5_000_000_000)
    expect(absurd.ok && absurd.word).toBe(0xFFFFFFFF)
    expect(absurd.ok && absurd.clamped).toBe(true)
    expect(vfdSetpointCeiling(2)).toBe(0xFFFFFFFF)
    expect(vfdSetpointCeiling(1)).toBe(0xFFFF)
  })

  it('accepts a 32-bit clamp on a pair and refuses one on a single register', () => {
    expect(validateVfdDefinition(wide('high-first')).ok).toBe(true)

    const narrow = structuredClone(wide('high-first'))
    narrow.registers.setpoint.count = 1
    const refused = validateVfdDefinition(narrow)
    expect(refused.ok).toBe(false)
    expect(refused.errors.map((e) => e.path)).toContain('registers.setpoint.encode.max')
    expect(refused.errors.find((e) => e.path === 'registers.setpoint.encode.max')?.sentence)
      .toBe('the largest setpoint word has to be a whole number from 0 to 65535.')
  })

  it('names a setpoint wider than a register pair', () => {
    const three = structuredClone(wide('high-first'))
    three.registers.setpoint.count = 3
    const refused = validateVfdDefinition(three)
    expect(refused.ok).toBe(false)
    expect(refused.errors.find((e) => e.path === 'registers.setpoint.count')?.sentence)
      .toBe('a speed setpoint is one register (16-bit) or two (32-bit).')
  })
})

// ADR-0044: no fact may be readable only from a hand-authored document. The two
// facts this order gave behaviour to - the setpoint's WIDTH
// (`registers.setpoint.count`) and the WORD ORDER (`protocol.wordOrder`) - are
// edited on the page the operator edits this inverter on, and no new control
// was added for either: both cells were already there, and a second box onto
// one stored field is two places to disagree. A row carries an edit BOX exactly
// when it carries a path (VfdReadout), so the paths below are what "editable in
// the common editor" means here.
describe('WO-1736 the width and the word order are edited in the machine definition', () => {
  it('gives the setpoint width its own edit box on the register table', async () => {
    const { vfdRegisterRows } = await import('../../components/machine/definition/SpindleLinkSection')
    const wide = wideDefinition(SAMPLE_MACHINE_DOC, {
      id: 'wide-setpoint-ui', wordOrder: 'low-first', writeFunction: 0x10, scale: 'set.rpm',
    }) as unknown as VfdDefinition
    expect(vfdRegisterRows(wide, 'setpoint')).toEqual([
      ['address', '8192', ['registers', 'setpoint', 'address']],
      ['words', '2', ['registers', 'setpoint', 'count']],
      ['scale', 'set.rpm', ['registers', 'setpoint', 'scale']],
      ['rounding', 'nearest', ['registers', 'setpoint', 'encode', 'round']],
      ['minimum', '0', ['registers', 'setpoint', 'encode', 'min']],
      ['maximum', '4294967295', ['registers', 'setpoint', 'encode', 'max']],
    ])
    // Operator's own document, on the same page, still says one register.
    expect(vfdRegisterRows(SAMPLE_MACHINE_DOC as unknown as VfdDefinition, 'setpoint')[1])
      .toEqual(['words', '1', ['registers', 'setpoint', 'count']])
  })

  it('gives the word order its own edit box on the protocol block', async () => {
    const { vfdProtocolRows } = await import('../../components/machine/definition/SpindleLinkSection')
    const wide = wideDefinition(SAMPLE_MACHINE_DOC, {
      id: 'wide-setpoint-ui', wordOrder: 'low-first', writeFunction: 0x10, scale: 'set.rpm',
    }) as unknown as VfdDefinition
    expect(vfdProtocolRows(wide)).toEqual([
      ['read function', '3', ['protocol', 'readFunction']],
      ['write function', '16', ['protocol', 'writeFunction']],
      ['word order', 'low-first', ['protocol', 'wordOrder']],
    ])
    expect(vfdProtocolRows(SAMPLE_MACHINE_DOC as unknown as VfdDefinition)[2])
      .toEqual(['word order', 'high-first', ['protocol', 'wordOrder']])
  })
})
