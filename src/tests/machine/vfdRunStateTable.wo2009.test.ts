// WO-2009 - THE APP NEVER PUSHES A SPINDLE DEFINITION THE BRIDGE REFUSES.
//
// Operator's saved definition predates WO-1721: registers.runState was
// {address: 4097, count: 1} with no values table. The app's check let it
// through, the bridge's ClassifyRunState answered every code "unrecognised"
// and closed the link, and the refusal named the inverter. Here:
//   - the app's check refuses a table that is absent or empty, naming the rows;
//   - a definition that names a shipped template is completed from it;
//   - the real Vfd.cs, compiled by Windows csc, agrees case by case: every
//     definition the app accepts keeps its link at its stopped code, and every
//     one the app refuses is one the bridge would have closed.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { VFD_MODEL_TEMPLATES, vfdLinkFromTemplate } from '../../lib/machine/vfd'
import { HUANYANG_GT } from '../../lib/machine/vfd/huanyangGt'
import {
  VFD_RUN_STATE_TABLE_MISSING_SENTENCE,
  completeVfdRunStateValues,
  validateVfdDefinition,
  type VfdDefinition,
} from '../../lib/machine/vfd/vfdDefinition'

const TEMPLATES = VFD_MODEL_TEMPLATES.map((template) => template.definition)

/** Operator's saved record: the template copy a machine owns, minus the table. */
function ericsSavedShape(): VfdDefinition {
  const link = vfdLinkFromTemplate('huanyang-gt', 'liencnc')! as unknown as VfdDefinition
  delete link.registers.runState.values
  expect(link.registers.runState).toEqual({ address: 4097, count: 1 })
  return link
}

/** A drive no template describes, with its own table. */
function otherDrive(): VfdDefinition {
  const other = structuredClone(HUANYANG_GT) as VfdDefinition
  other.id = 'other-drive'
  other.name = 'Other drive'
  other.registers.runState = {
    address: 0x0200,
    count: 1,
    values: [
      { value: 0, meaning: 'stopped' },
      { value: 1, meaning: 'running' },
      { value: 7, meaning: 'faulted' },
    ],
  }
  other.fault = { kind: 'equals', value: 7 }
  return other
}

function otherDriveWithout(values: 'absent' | 'empty'): VfdDefinition {
  const other = otherDrive()
  if (values === 'absent') delete other.registers.runState.values
  else other.registers.runState.values = []
  return other
}

const HUANYANG_ROWS = [
  { value: 1, meaning: 'runningForward' },
  { value: 2, meaning: 'runningReverse' },
  { value: 3, meaning: 'stopped' },
  { value: 4, meaning: 'faulted' },
  { value: 5, meaning: 'poweredOff' },
]

describe('WO-2009 the app check refuses a run-state register with no table, naming the rows', () => {
  it("refuses Operator's saved shape as it stands, at registers.runState.values", () => {
    const result = validateVfdDefinition(ericsSavedShape())
    expect(result.ok).toBe(false)
    expect(result.errors).toEqual([{
      code: 'E_VFD_FIELD',
      path: 'registers.runState.values',
      sentence: VFD_RUN_STATE_TABLE_MISSING_SENTENCE,
    }])
    expect(VFD_RUN_STATE_TABLE_MISSING_SENTENCE).toContain('the one that means stopped')
    for (const meaning of ['running', 'runningForward', 'runningReverse', 'stopped', 'faulted', 'poweredOff']) {
      expect(VFD_RUN_STATE_TABLE_MISSING_SENTENCE).toContain(meaning)
    }
  })

  it('refuses an empty table the same way, because the bridge treats it the same way', () => {
    const result = validateVfdDefinition(otherDriveWithout('empty'))
    expect(result.ok).toBe(false)
    expect(result.errors.map((fault) => fault.path)).toEqual(['registers.runState.values'])
  })

  it('still accepts the shipped template and a drive with its own table', () => {
    expect(validateVfdDefinition(HUANYANG_GT).ok).toBe(true)
    expect(validateVfdDefinition(otherDrive()).ok).toBe(true)
  })
})

describe('WO-2009 a definition that names a shipped template is completed by the app', () => {
  it("fills Operator's Huanyang GT rows from the template, and the result passes the app check", () => {
    const saved = ericsSavedShape()
    const before = structuredClone(saved)
    const { definition, filledFrom } = completeVfdRunStateValues(saved, TEMPLATES)
    expect(filledFrom).toBe('Huanyang GT')
    expect(definition.registers.runState).toEqual({ address: 4097, count: 1, values: HUANYANG_ROWS })
    expect(validateVfdDefinition(definition).ok).toBe(true)
    // Pure: the stored record is not written through.
    expect(saved).toEqual(before)
    // The copy is its own: editing it later cannot edit the shipped template.
    definition.registers.runState.values![0].value = 99
    expect(HUANYANG_GT.registers.runState.values![0].value).toBe(1)
  })

  it('leaves a definition that already states a table alone, even an empty one', () => {
    const own = otherDrive()
    expect(completeVfdRunStateValues(own, TEMPLATES)).toEqual({ definition: own, filledFrom: null })
    const emptySampleMachine = ericsSavedShape()
    emptySampleMachine.registers.runState.values = []
    expect(completeVfdRunStateValues(emptySampleMachine, TEMPLATES).filledFrom).toBeNull()
  })

  it('fills nothing when no template names the drive, so the app check refuses it', () => {
    const { definition, filledFrom } = completeVfdRunStateValues(otherDriveWithout('absent'), TEMPLATES)
    expect(filledFrom).toBeNull()
    expect(validateVfdDefinition(definition).errors.map((fault) => fault.path))
      .toEqual(['registers.runState.values'])
  })

  it("fills nothing when the template's id is kept but its run-state register was moved", () => {
    const moved = ericsSavedShape()
    moved.registers.runState = { address: 0x2001, count: 1 }
    expect(completeVfdRunStateValues(moved, TEMPLATES).filledFrom).toBeNull()
  })
})

// --- the real bridge agrees -------------------------------------------------

const BRIDGE_DIR = resolve('pendant/uccnc-bridge')
const VFD_SOURCE = resolve(BRIDGE_DIR, 'Vfd.cs')
const JSON_SOURCE = resolve(BRIDGE_DIR, 'Json.cs')
const CSC = join(
  process.env.WINDIR ?? 'C:\\Windows',
  'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe',
)

const HARNESS = String.raw`
using System;

namespace LienCAM {
public static class Wo2009RunStateTableHarness {
  public static void Main(string[] args) {
    Console.WriteLine("platform=" + Environment.OSVersion.Platform);
    for (int i = 0; i + 2 < args.Length; i += 3) {
      string label = args[i];
      string refusal;
      VfdPlan plan = VfdDefinitionFile.Load(args[i + 1], out refusal);
      Console.WriteLine(label + ".refusal=" + (refusal ?? "none"));
      if (plan == null) continue;
      string words;
      VfdLink.RunStateVerdict verdict = VfdLink.ClassifyRunState(plan, ushort.Parse(args[i + 2]), out words);
      Console.WriteLine(label + ".stopped=" + verdict + "|" + words);
    }
  }
}}
`

interface BridgeCase {
  label: string
  /** What the app would hand the bridge: completed first, exactly as sent. */
  sent: VfdDefinition
  /** The code this drive reports when its spindle is stopped. */
  stoppedCode: number
}

function bridgeCases(): BridgeCase[] {
  return [
    { label: 'sampleMachineCompleted', sent: completeVfdRunStateValues(ericsSavedShape(), TEMPLATES).definition, stoppedCode: 3 },
    { label: 'sampleMachineUncompleted', sent: ericsSavedShape(), stoppedCode: 3 },
    { label: 'other', sent: otherDrive(), stoppedCode: 0 },
    { label: 'otherAbsent', sent: completeVfdRunStateValues(otherDriveWithout('absent'), TEMPLATES).definition, stoppedCode: 0 },
    { label: 'otherEmpty', sent: otherDriveWithout('empty'), stoppedCode: 0 },
  ]
}

function runBridge(cases: BridgeCase[]): Map<string, string> {
  if (!existsSync(CSC)) throw new Error(`Windows C# compiler did not exist at ${CSC}`)
  const root = mkdtempSync(join(tmpdir(), 'liencam-wo2009-run-state-'))
  const source = join(root, 'Harness.cs')
  const executable = join(root, 'Harness.exe')
  writeFileSync(source, HARNESS)
  const args: string[] = []
  for (const entry of cases) {
    const path = join(root, `${entry.label}.definition.json`)
    writeFileSync(path, JSON.stringify(entry.sent, null, 2))
    args.push(entry.label, path, String(entry.stoppedCode))
  }
  try {
    execFileSync(CSC, [
      '/nologo', '/warn:4', `/out:${executable}`, '/main:LienCAM.Wo2009RunStateTableHarness',
      VFD_SOURCE, JSON_SOURCE, source,
    ], { stdio: 'pipe' })
    const output = execFileSync(executable, args, { encoding: 'utf8', timeout: 30_000 })
    const rows = new Map<string, string>()
    for (const line of output.split(/\r?\n/)) {
      const match = /^([^=]+)=(.*)$/.exec(line)
      if (match) rows.set(match[1], match[2])
    }
    return rows
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

let bridgeRows: Map<string, string> | undefined
const bridge = (): Map<string, string> => (bridgeRows ??= runBridge(bridgeCases()))

// Windows C# harness; Linux reports skipped, never passed.
describe.skipIf(process.platform !== 'win32')('WO-2009 the app check and Vfd.cs accept and refuse the same definitions', () => {
  it('compiles and runs the real production bridge source', () => {
    expect(existsSync(CSC)).toBe(true)
    expect(bridge().get('platform')).toBe('Win32NT')
  }, 60_000)

  it("keeps the link for Operator's completed definition at his stopped code 3", () => {
    expect(bridge().get('sampleMachineCompleted.refusal')).toBe('none')
    expect(bridge().get('sampleMachineCompleted.stopped')).toBe('SafeToKeep|stopped')
  })

  it("closes the link for the uncompleted shape - the exact refusal Operator saw - which the app now refuses first", () => {
    expect(bridge().get('sampleMachineUncompleted.stopped')).toContain('Unusable|an unrecognised code (3)')
    expect(validateVfdDefinition(ericsSavedShape()).ok).toBe(false)
  })

  it('agrees case by case: app accepts <=> the bridge keeps the link at the stopped code', () => {
    for (const entry of bridgeCases()) {
      const appAccepts = validateVfdDefinition(entry.sent).ok
      const bridgeKeeps = bridge().get(`${entry.label}.stopped`)?.startsWith('SafeToKeep|') === true
      expect({ label: entry.label, appAccepts }).toEqual({ label: entry.label, appAccepts: bridgeKeeps })
    }
    expect(bridgeCases().filter((entry) => validateVfdDefinition(entry.sent).ok).map((entry) => entry.label))
      .toEqual(['sampleMachineCompleted', 'other'])
  })
})
