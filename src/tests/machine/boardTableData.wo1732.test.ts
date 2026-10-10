import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// WO-1732 - shipped board data must fit BoardPinTableFile's real schema. The
// C# harness calls that loader directly; this test does not maintain a second
// parser that could drift from the bridge.

const BRIDGE_DIR = resolve('pendant/uccnc-bridge')
const BOARDS_DIR = resolve(BRIDGE_DIR, 'boards')
const TABLE = resolve(BOARDS_DIR, 'uc100.json')
const FAKE_BOARD_SOURCE = resolve('src/tests/evidence/WO-1326/FakeUC100.cs')
const CSC = join(
  process.env.WINDIR ?? 'C:\\Windows',
  'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe',
)

type Pin = { port: number; pin: number; ucPin: number; direction: 'input' | 'output' }
type Table = {
  format: string
  schemaVersion: number
  name: string
  deviceType: number
  source: { document: string; pages: number[]; url: string; apiUrl: string }
  documentedLimits: Record<string, number>
  pins: Pin[]
}

const table = JSON.parse(readFileSync(TABLE, 'utf8')) as Table

const HARNESS = String.raw`
using System;
namespace LienCAM {
public static class Wo1732BoardDataHarness {
  static void Print(string key, object value) { Console.WriteLine(key + "=" + value); }
  public static void Main(string[] args) {
    string refusal;
    BoardPinTable table = BoardPinTableFile.Load(args[0], out refusal);
    Print("load", table == null ? "REFUSED:" + refusal : table.Name);
    if (table != null) {
      Print("type", table.DeviceType);
      Print("rows", table.RowCount);
      Print("out1", table.UcPin(1, 1, true));
      Print("out17", table.UcPin(1, 17, true));
      Print("in10", table.UcPin(1, 10, false));
      Print("in15", table.UcPin(1, 15, false));
      Print("wrongDirection", table.UcPin(1, 10, true));
      BoardPinTables.Register(table);
    }
    Print("known", BoardPinTables.ForDeviceType(1) == null ? "missing" : "UC100");
    Print("unknown", BoardPinTables.ForDeviceType(999) == null ? "refused" : "loaded");

    object invalid;
    Json.TryParse("{\"format\":\"liencam-board-pins\",\"schemaVersion\":1,"
      + "\"name\":\"INVALID\",\"deviceType\":-1,\"pins\":["
      + "{\"port\":1,\"pin\":1,\"ucPin\":1,\"direction\":\"output\"}]}", out invalid);
    BoardPinTable bad = BoardPinTableFile.FromDocument(invalid, out refusal);
    Print("invalid", bad == null ? refusal : "loaded");
  }
}}
`

function runLoader(): Map<string, string> {
  const root = mkdtempSync(join(tmpdir(), 'liencam-wo1732-'))
  const source = join(root, 'Harness.cs')
  const executable = join(root, 'Harness.exe')
  writeFileSync(source, HARNESS)
  try {
    execFileSync(CSC, [
      '/nologo', '/unsafe', `/out:${executable}`, '/main:LienCAM.Wo1732BoardDataHarness',
      resolve(BRIDGE_DIR, 'Bridge.cs'), resolve(BRIDGE_DIR, 'Machine.cs'),
      resolve(BRIDGE_DIR, 'Json.cs'), resolve(BRIDGE_DIR, 'Vfd.cs'),
      FAKE_BOARD_SOURCE, source,
    ], { stdio: 'inherit' })
    const output = execFileSync(executable, [TABLE], { encoding: 'utf8' })
    return new Map(output.trim().split(/\r?\n/).map((line) => {
      const separator = line.indexOf('=')
      return [line.slice(0, separator), line.slice(separator + 1)]
    }))
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

describe.skipIf(!existsSync(CSC))('WO-1732 UC-family board tables ship as sourced data', () => {
  it('ships only the completely sourced UC100 table', () => {
    expect(basename(TABLE)).toBe('uc100.json')
    expect(table.format).toBe('liencam-board-pins')
    expect(table.schemaVersion).toBe(1)
    expect(table.name).toBe('UC100')
    expect(table.deviceType).toBe(1)
    expect(table.source.pages).toEqual([7, 8])
    expect(table.source.url).toMatch(/^https:\/\/www\.cncdrive\.com\//)
    expect(table.source.apiUrl).toMatch(/^https:\/\/www\.cncdrive\.com\//)
  })

  it('preserves the manual pin roles and documented UC100 limits', () => {
    expect(table.pins).toHaveLength(17)
    expect(table.pins.filter(({ direction }) => direction === 'output').map(({ pin }) => pin))
      .toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 14, 16, 17])
    expect(table.pins.filter(({ direction }) => direction === 'input').map(({ pin }) => pin))
      .toEqual([10, 11, 12, 13, 15])
    expect(table.pins.every(({ port, pin, ucPin }) => port === 1 && pin === ucPin)).toBe(true)
    expect(table.documentedLimits).toEqual({
      axes: 6,
      maximumStepFrequencyHz: 100000,
      digitalOutputs: 12,
      digitalInputs: 5,
      outputCurrentMilliampMax: 20,
      inputPullupOhms: 4700,
    })
  })

  it('loads through the production schema while invalid and unknown IDs stay unavailable', () => {
    const rows = runLoader()
    expect(rows.get('load')).toBe('UC100')
    expect(rows.get('type')).toBe('1')
    expect(rows.get('rows')).toBe('17')
    expect(rows.get('out1')).toBe('1')
    expect(rows.get('out17')).toBe('17')
    expect(rows.get('in10')).toBe('10')
    expect(rows.get('in15')).toBe('15')
    expect(rows.get('wrongDirection')).toBe('0')
    expect(rows.get('known')).toBe('UC100')
    expect(rows.get('unknown')).toBe('refused')
    expect(rows.get('invalid')).toContain('states no deviceType')
  })
})
