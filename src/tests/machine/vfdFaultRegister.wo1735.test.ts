import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { HUANYANG_GT } from '../../lib/machine/vfd/huanyangGt'
import {
  VFD_OPTIONAL_REGISTER_ROLES,
  VFD_REGISTER_ROLES,
  validateVfdDefinition,
  type VfdDefinition,
} from '../../lib/machine/vfd/vfdDefinition'

// WO-1735 - A VFD FAULT IS READ FROM THE DRIVE'S OWN REGISTER WHEN ITS
// DEFINITION STATES ONE.
//
// Two definitions, both real documents, neither one a source edit apart:
//   - Operator's shipped Huanyang GT, which states NO fault register. Its fault
//     still comes from the operating-state word (equals 4), the poll still
//     reads exactly the registers it read before, and nothing about the link
//     is different. That is the "unchanged" half of the acceptance and it is
//     measured here, not assumed.
//   - a drive that reports faults in its own register. Its run-state word says
//     stopped while the fault register says 12, and the bridge reports FAULTED
//     - which the run-state rule on its own cannot do, and the harness prints
//     both answers side by side to show it.
//
// The real Vfd.cs and Json.cs are compiled by Windows csc and driven through a
// real VfdLink with its polling thread over a loopback Modbus RTU port, so the
// register reads below are actual 0x03 transactions on the wire. No controller
// or hardware claim is made here; the physical check is M19.

const BRIDGE_DIR = resolve('pendant/uccnc-bridge')
const VFD_SOURCE = resolve(BRIDGE_DIR, 'Vfd.cs')
const JSON_SOURCE = resolve(BRIDGE_DIR, 'Json.cs')
const SAMPLE_MACHINE_DEFINITION = resolve(BRIDGE_DIR, 'vfd/huanyang-gt.definition.json')
const CSC = join(
  process.env.WINDIR ?? 'C:\\Windows',
  'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe',
)

type Doc = Record<string, unknown>

/** The fault register the alternative drives state. Not Operator's 0x5000 fault
 *  CODE by accident: a drive that HAS one usually puts it beside its status
 *  block, and picking a different address from the run-state word is the whole
 *  point of the case. */
const FAULT_REGISTER = 0x5000

const HARNESS = String.raw`
using System;
using System.Collections.Generic;
using System.IO.Ports;
using System.Threading;

namespace LienCAM {
/** A loopback Modbus RTU inverter with TWO readable words: the operating-state
 *  register and, at a different address, a fault register. Every read is
 *  counted by address, so "this definition never read that register" is a
 *  measurement rather than a claim. */
class FaultRegisterPort : IVfdPort {
  readonly object gate = new object();
  readonly Queue<byte> inbox = new Queue<byte>();
  readonly ushort runStateAddress;
  readonly ushort commandAddress;
  readonly ushort faultAddress;
  public ushort RunStateWord;
  public ushort FaultCodeWord;
  public readonly List<ushort> CommandWords = new List<ushort>();
  public int RunStateReads;
  public int FaultReads;

  public FaultRegisterPort(VfdPlan plan, ushort stopped, ushort faultAddressToServe) {
    runStateAddress = plan.RunStateRegister;
    commandAddress = plan.CommandRegister;
    faultAddress = faultAddressToServe;
    RunStateWord = stopped;
    FaultCodeWord = 0;
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
          ushort at = (ushort)(address + i);
          ushort value = at == runStateAddress ? RunStateWord
                       : at == faultAddress ? FaultCodeWord
                       : (ushort)0;
          reply[3 + i * 2] = (byte)(value >> 8);
          reply[4 + i * 2] = (byte)(value & 0xFF);
        }
        if (address == runStateAddress) RunStateReads++;
        if (address == faultAddress) FaultReads++;
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

public static class Wo1735FaultRegisterHarness {
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

  /** Drive the REAL poll loop over the loopback port, then report what the
   *  bridge says about each (run-state word, fault word) pair the drive shows
   *  it - beside what the run-state rule alone would have said. */
  static void LinkCase(string label, string path, ushort[][] cases) {
    VfdPlan plan = Load(label, path);
    if (plan == null) return;
    Console.WriteLine(label + ".hasFaultRegister=" + plan.HasFaultCodeRegister);
    Console.WriteLine(label + ".faultRegister=" + plan.FaultCodeRegister);
    Console.WriteLine(label + ".faultCodeKind=" + (plan.FaultCodeKind ?? "(none)"));
    Console.WriteLine(label + ".faultKind=" + plan.FaultKind);

    FaultRegisterPort port = new FaultRegisterPort(plan, StoppedWord(plan), FAULT_ADDRESS);
    VfdLink link = new VfdLink(plan);
    link.OpenPort = delegate(VfdPlan ignored) { return port; };
    Console.WriteLine(label + ".open=" + (link.Open() ?? "ok"));
    try {
      foreach (ushort[] one in cases) {
        lock (port) { }
        port.RunStateWord = one[0];
        port.FaultCodeWord = one[1];
        Thread.Sleep(Math.Max(150, plan.PollIntervalMs * 6));
        VfdReading reading = link.Sample();
        string key = label + ".case" + one[0] + "_" + one[1];
        Console.WriteLine(key + ".runStateWord=" + reading.RunStateWord);
        Console.WriteLine(key + ".faultCodeWord=" + reading.FaultCodeWord);
        Console.WriteLine(key + ".faulted=" + plan.IsFaulted(reading));
        Console.WriteLine(key + ".faultedFromRunState=" + plan.IsFaulted(reading.RunStateWord));
        Console.WriteLine(key + ".linkUp=" + reading.LinkUp);
        Console.WriteLine(key + ".failures=" + reading.ConsecutiveFailures);
        int before = port.CountCommand(plan.StopWord);
        link.Stop();
        Console.WriteLine(key + ".stopWrites=" + (port.CountCommand(plan.StopWord) - before));
      }
      Console.WriteLine(label + ".runStateReads=" + port.RunStateReads);
      Console.WriteLine(label + ".faultReads=" + port.FaultReads);
    } finally {
      link.Close();
    }
  }

  const ushort FAULT_ADDRESS = 0x5000;

  public static void Main(string[] args) {
    Console.WriteLine("platform=" + Environment.OSVersion.Platform);
    // SampleMachine's shipped document: no fault register, fault from the run-state
    // word, and the fault address never touched.
    LinkCase("sampleMachine", args[0], new ushort[][] {
      new ushort[] { 3, 0 }, new ushort[] { 3, 12 }, new ushort[] { 4, 0 },
    });
    // A drive with its own fault register and no rule of its own: the
    // definition's own nonZero rule, applied to THAT word.
    LinkCase("own", args[1], new ushort[][] {
      new ushort[] { 0, 0 }, new ushort[] { 0, 12 }, new ushort[] { 1, 0 }, new ushort[] { 1, 3 },
    });
    // The same drive stating its own mask rule on that register.
    LinkCase("mask", args[2], new ushort[][] {
      new ushort[] { 0, 4 }, new ushort[] { 0, 8 }, new ushort[] { 0, 0 },
    });
    Load("noAddress", args[3]);
    Load("badRule", args[4]);
  }
}}
`

interface Result {
  rows: Map<string, string>
  sourceSha256: string
}

/** A drive whose faults come off its own register. Everything else is Operator's
 *  document unchanged, so the fault path is the only thing that differs. */
function ownFaultRegisterDefinition(sampleMachine: Doc): Doc {
  const other = structuredClone(sampleMachine)
  other.id = 'own-fault-register-drive'
  other.name = 'Own fault register drive'
  const registers = other.registers as Doc
  registers.runState = {
    address: 0x0200,
    count: 1,
    values: [
      { value: 0, meaning: 'stopped' },
      { value: 1, meaning: 'running' },
    ],
  }
  registers.faultCode = { address: FAULT_REGISTER, count: 1 }
  // No rule on the register: the definition's own rule applies to its word.
  other.fault = { kind: 'nonZero' }
  return other
}

function runHarness(): Result {
  if (!existsSync(CSC)) throw new Error(`Windows C# compiler did not exist at ${CSC}`)
  const root = mkdtempSync(join(tmpdir(), 'liencam-wo1735-fault-register-'))
  const source = join(root, 'Harness.cs')
  const executable = join(root, 'Harness.exe')
  const ownPath = join(root, 'own.definition.json')
  const maskPath = join(root, 'mask.definition.json')
  const noAddressPath = join(root, 'no-address.definition.json')
  const badRulePath = join(root, 'bad-rule.definition.json')

  const sampleMachine = JSON.parse(readFileSync(SAMPLE_MACHINE_DEFINITION, 'utf8')) as Doc
  const own = ownFaultRegisterDefinition(sampleMachine)

  const mask = structuredClone(own)
  mask.id = 'mask-fault-register-drive'
  ;((mask.registers as Doc).faultCode as Doc).rule = { kind: 'mask', mask: 0x0008 }

  const noAddress = structuredClone(own)
  noAddress.id = 'half-stated-fault-register'
  ;(noAddress.registers as Doc).faultCode = { count: 1 }

  const badRule = structuredClone(own)
  badRule.id = 'unknown-fault-rule-kind'
  ;((badRule.registers as Doc).faultCode as Doc).rule = { kind: 'sometimes' }

  writeFileSync(source, HARNESS)
  writeFileSync(ownPath, JSON.stringify(own, null, 2))
  writeFileSync(maskPath, JSON.stringify(mask, null, 2))
  writeFileSync(noAddressPath, JSON.stringify(noAddress, null, 2))
  writeFileSync(badRulePath, JSON.stringify(badRule, null, 2))
  try {
    execFileSync(CSC, [
      '/nologo', '/warn:4', `/out:${executable}`, '/main:LienCAM.Wo1735FaultRegisterHarness',
      VFD_SOURCE, JSON_SOURCE, source,
    ], { stdio: 'pipe' })
    const output = execFileSync(executable, [
      SAMPLE_MACHINE_DEFINITION, ownPath, maskPath, noAddressPath, badRulePath,
    ], { encoding: 'utf8', timeout: 60_000 })
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

// --- the schema half, which runs everywhere ---------------------------------

describe('WO-1735 a definition may state a fault register, and Operator\'s does not', () => {
  it('keeps `faultCode` out of the roles every definition has', () => {
    // WO-1074 renamed 0x1001 fault -> runState. The new register is not that
    // one coming back: it is optional, it is called faultCode, and `fault` at
    // the top level is still the RULE.
    expect([...VFD_REGISTER_ROLES]).not.toContain('faultCode')
    expect([...VFD_REGISTER_ROLES]).not.toContain('fault')
    expect([...VFD_OPTIONAL_REGISTER_ROLES]).toEqual(['faultCode'])
  })

  it("leaves Operator's Huanyang GT with no fault register at all", () => {
    expect(HUANYANG_GT.registers.faultCode).toBeUndefined()
    expect(validateVfdDefinition(HUANYANG_GT).ok).toBe(true)
    const bridge = JSON.parse(readFileSync(SAMPLE_MACHINE_DEFINITION, 'utf8')) as Doc
    expect((bridge.registers as Doc).faultCode).toBeUndefined()
  })

  it('accepts a drive that states one, with or without a rule of its own', () => {
    const withFallbackRule = {
      ...structuredClone(HUANYANG_GT),
      registers: {
        ...structuredClone(HUANYANG_GT.registers),
        faultCode: { address: FAULT_REGISTER, count: 1 },
      },
    } as unknown as VfdDefinition
    expect(validateVfdDefinition(withFallbackRule).ok).toBe(true)

    const withOwnRule = structuredClone(withFallbackRule)
    withOwnRule.registers.faultCode = { address: FAULT_REGISTER, count: 1, rule: { kind: 'mask', mask: 8 } }
    expect(validateVfdDefinition(withOwnRule).ok).toBe(true)
  })

  it('refuses a half-stated fault register and an unknown rule kind', () => {
    const noAddress = structuredClone(HUANYANG_GT) as unknown as VfdDefinition
    noAddress.registers.faultCode = { count: 1 } as never
    const addressFaults = validateVfdDefinition(noAddress)
    expect(addressFaults.ok).toBe(false)
    expect(addressFaults.errors.map((fault) => fault.path)).toContain('registers.faultCode.address')

    const badRule = structuredClone(HUANYANG_GT) as unknown as VfdDefinition
    badRule.registers.faultCode = { address: FAULT_REGISTER, count: 1, rule: { kind: 'sometimes' } as never }
    const ruleFaults = validateVfdDefinition(badRule)
    expect(ruleFaults.ok).toBe(false)
    expect(ruleFaults.errors.map((fault) => fault.path)).toContain('registers.faultCode.rule.kind')

    const badMask = structuredClone(HUANYANG_GT) as unknown as VfdDefinition
    badMask.registers.faultCode = { address: FAULT_REGISTER, count: 1, rule: { kind: 'mask', mask: 0 } }
    expect(validateVfdDefinition(badMask).errors.map((fault) => fault.path))
      .toContain('registers.faultCode.rule.mask')
  })

  it("still refuses a definition whose own fault rule is broken", () => {
    // The shared checker did not lose the rule it already enforced.
    const broken = structuredClone(HUANYANG_GT) as unknown as VfdDefinition
    broken.fault = { kind: 'equals', value: -1 }
    expect(validateVfdDefinition(broken).errors.map((fault) => fault.path)).toContain('fault.value')
  })
})

// --- the bridge half, on Windows, against the real production source --------
// Execute these Windows C# harnesses on Windows; Linux reports skipped, never
// passed. The compiler-exists assertion remains mandatory on Windows.
describe.skipIf(process.platform !== 'win32')('WO-1735 the bridge reads the fault from the register the definition names', () => {
  it('actually compiles and runs the real production source on Windows', () => {
    expect(existsSync(CSC)).toBe(true)
    expect(run().rows.get('platform')).toBe('Win32NT')
    expect(run().sourceSha256).toMatch(/^[0-9a-f]{64}$/)
  }, 120_000)

  it("leaves Operator's inverter exactly as it was: the run-state word decides", () => {
    const rows = run().rows
    expect(rows.get('sampleMachine.refusal')).toBe('none')
    expect(rows.get('sampleMachine.hasFaultRegister')).toBe('False')
    expect(rows.get('sampleMachine.faultCodeKind')).toBe('(none)')
    expect(rows.get('sampleMachine.faultKind')).toBe('equals')
    // Standby (3) is not a fault; 4 is, and a 12 sitting in a register his
    // definition does not name changes nothing at all.
    expect(rows.get('sampleMachine.case3_0.faulted')).toBe('False')
    expect(rows.get('sampleMachine.case3_12.faulted')).toBe('False')
    expect(rows.get('sampleMachine.case4_0.faulted')).toBe('True')
    // Same answer from both entry points, because there is one rule and one
    // word in play for a definition with no fault register.
    for (const key of ['sampleMachine.case3_0', 'sampleMachine.case3_12', 'sampleMachine.case4_0']) {
      expect(rows.get(`${key}.faulted`), key).toBe(rows.get(`${key}.faultedFromRunState`))
      expect(rows.get(`${key}.faultCodeWord`), key).toBe('0')
      expect(rows.get(`${key}.linkUp`), key).toBe('True')
      expect(rows.get(`${key}.failures`), key).toBe('0')
    }
  })

  it("spends no transaction on a register Operator's definition does not name", () => {
    const rows = run().rows
    // THE MEASUREMENT BEHIND "his link is unchanged": the poll pass never
    // touched 0x5000, so his pass is the same length it was and the quiet
    // budget it is measured against is the same budget.
    expect(rows.get('sampleMachine.faultReads')).toBe('0')
    expect(Number(rows.get('sampleMachine.runStateReads'))).toBeGreaterThan(3)
  })

  it('reports a fault from the drive\'s own register while the run-state word says stopped', () => {
    const rows = run().rows
    expect(rows.get('own.refusal')).toBe('none')
    expect(rows.get('own.hasFaultRegister')).toBe('True')
    expect(rows.get('own.faultRegister')).toBe(String(FAULT_REGISTER))
    // No rule on the register, so the definition's own rule reads its word.
    expect(rows.get('own.faultCodeKind')).toBe('nonZero')

    expect(rows.get('own.case0_12.faultCodeWord')).toBe('12')
    expect(rows.get('own.case0_12.faulted')).toBe('True')
    // THE WHOLE POINT: the run-state word says stopped in that same pass, so
    // the run-state rule alone could not have reported this fault.
    expect(rows.get('own.case0_12.runStateWord')).toBe('0')
    expect(rows.get('own.case0_12.faultedFromRunState')).toBe('False')

    // And a clear fault register is not a fault, in either run state.
    expect(rows.get('own.case0_0.faulted')).toBe('False')
    expect(rows.get('own.case1_0.faulted')).toBe('False')
    expect(rows.get('own.case1_3.faulted')).toBe('True')
    expect(Number(rows.get('own.faultReads'))).toBeGreaterThan(3)
  })

  it('lets that register state its own rule, which wins over the definition\'s', () => {
    const rows = run().rows
    expect(rows.get('mask.refusal')).toBe('none')
    expect(rows.get('mask.faultCodeKind')).toBe('mask')
    // `nonZero` would have called 4 a fault; the register's own mask says the
    // fault is bit 3.
    expect(rows.get('mask.faultKind')).toBe('nonZero')
    expect(rows.get('mask.case0_4.faulted')).toBe('False')
    expect(rows.get('mask.case0_8.faulted')).toBe('True')
    expect(rows.get('mask.case0_0.faulted')).toBe('False')
  })

  it('still stops, on every definition and in every state', () => {
    const rows = run().rows
    // No gate, no new refusal: Stop writes the stop word whatever either
    // register reads, including from a faulted drive.
    for (const key of [
      'sampleMachine.case3_0', 'sampleMachine.case3_12', 'sampleMachine.case4_0',
      'own.case0_0', 'own.case0_12', 'own.case1_0', 'own.case1_3',
      'mask.case0_4', 'mask.case0_8', 'mask.case0_0',
    ]) {
      expect(Number(rows.get(`${key}.stopWrites`)), key).toBeGreaterThanOrEqual(1)
    }
  })

  it('refuses a fault register stated by halves, in plain words', () => {
    const rows = run().rows
    expect(rows.get('noAddress.refusal')).toBe('the VFD definition has no registers.faultCode.address.')
    expect(rows.get('badRule.refusal')).toBe(
      "the VFD definition's registers.faultCode.rule rule has to be 'equals', 'nonZero' or 'mask', not 'sometimes'.",
    )
  })
})
