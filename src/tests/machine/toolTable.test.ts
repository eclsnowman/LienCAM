// @vitest-environment jsdom
// MACHINE-CONTROL stage 10: tool table reference math + probe config
// validation (pure lib) and the persisted per-machine store CRUD.

import { beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_MACHINE_PROBE_DEFAULTS,
  DEFAULT_ZPROBE_CONFIG,
  EMPTY_TOOL_TABLE,
  newToolEntry,
  resolveProbeConfig,
  toolOffsetLine,
  validateZProbeConfig,
  type MachineToolTable,
} from '../../lib/machine/toolTable'
import { useMachineToolTable } from '../../store/machineToolTableStore'

function tableWith(entries: Array<[number, number | null]>, reference: number | null): MachineToolTable {
  return {
    reference,
    tools: entries.map(([tool, z]) => ({ ...newToolEntry(tool), probedMachineZ: z })),
  }
}

describe('toolOffsetLine reference math', () => {
  it('computes G43.1 as tool minus reference', () => {
    // T2 is 1.5mm LONGER than the reference T1 (contacts the pad higher).
    const table = tableWith([[1, -40], [2, -38.5]], 1)
    const out = toolOffsetLine(table, 2)
    expect(out).toEqual({ ok: true, line: 'G43.1 Z1.5', deltaMm: 1.5 })
    // Shorter tool -> negative offset.
    const short = toolOffsetLine(tableWith([[1, -40], [3, -42.25]], 1), 3)
    expect(short).toEqual({ ok: true, line: 'G43.1 Z-2.25', deltaMm: -2.25 })
    // The reference itself applies a zero offset.
    expect(toolOffsetLine(table, 1)).toEqual({ ok: true, line: 'G43.1 Z0', deltaMm: 0 })
  })

  it('fails loudly on missing reference or measurements', () => {
    expect(toolOffsetLine(tableWith([[1, -40]], null), 1).ok).toBe(false)
    expect(toolOffsetLine(tableWith([[1, null], [2, -38]], 1), 2).ok).toBe(false) // ref unmeasured
    expect(toolOffsetLine(tableWith([[1, -40], [2, null]], 1), 2).ok).toBe(false) // tool unmeasured
    expect(toolOffsetLine(tableWith([[1, -40]], 1), 9).ok).toBe(false) // unknown tool
  })
})

describe('validateZProbeConfig', () => {
  it('accepts the defaults and rejects unsafe values', () => {
    expect(validateZProbeConfig(DEFAULT_ZPROBE_CONFIG).ok).toBe(true)
    expect(validateZProbeConfig({ ...DEFAULT_ZPROBE_CONFIG, fastFeed: 0 }).ok).toBe(false)
    expect(validateZProbeConfig({ ...DEFAULT_ZPROBE_CONFIG, slowFeed: 9999 }).ok).toBe(false) // faster than fast
    expect(validateZProbeConfig({ ...DEFAULT_ZPROBE_CONFIG, retract: 0 }).ok).toBe(false)
    expect(validateZProbeConfig({ ...DEFAULT_ZPROBE_CONFIG, maxTravel: 1 }).ok).toBe(false) // <= retract
    expect(validateZProbeConfig({ ...DEFAULT_ZPROBE_CONFIG, padThickness: -1 }).ok).toBe(false)
    expect(validateZProbeConfig({ ...DEFAULT_ZPROBE_CONFIG, maxTravel: Number.NaN }).ok).toBe(false)
    expect(validateZProbeConfig({ ...DEFAULT_ZPROBE_CONFIG, positioningFeed: 0 }).ok).toBe(false)
    // A pre-WO-372 fixed-pad record with a short but otherwise valid search
    // remains usable. Feature planning applies its stricter combined limit.
    expect(validateZProbeConfig({
      fastFeed: 125,
      slowFeed: 25,
      retract: 1,
      maxTravel: 5,
      padThickness: 8,
    }).ok).toBe(true)
  })

  it('fills legacy configs and layers UI overrides over machine defaults', () => {
    const legacy = resolveProbeConfig(null, {
      fastFeed: 125,
      slowFeed: 25,
      retract: 1,
      maxTravel: 20,
      padThickness: 8,
    })
    expect(legacy.positioningFeed).toBe(DEFAULT_MACHINE_PROBE_DEFAULTS.positioningFeed)
    expect(legacy.surfaceClearance).toBe(DEFAULT_MACHINE_PROBE_DEFAULTS.surfaceClearance)

    const effective = resolveProbeConfig(
      { ...DEFAULT_MACHINE_PROBE_DEFAULTS, fastFeed: 240, slowFeed: 35 },
      { slowFeed: 18, overtravel: 3 },
    )
    expect(effective.fastFeed).toBe(240)
    expect(effective.slowFeed).toBe(18)
    expect(effective.overtravel).toBe(3)
  })
})

describe('machineToolTableStore', () => {
  const M = 'machine-a'

  beforeEach(() => {
    useMachineToolTable.setState({ byMachine: {} })
  })

  it('adds, edits, measures, and removes tools per machine', () => {
    const s = () => useMachineToolTable.getState()
    s().addTool(M, 3)
    s().addTool(M, 1)
    s().addTool(M, 1) // duplicate is a no-op
    expect(s().tableFor(M).tools.map((t) => t.tool)).toEqual([1, 3]) // sorted
    s().updateTool(M, 1, { dia: 6.35, note: 'quarter inch' })
    s().recordProbedZ(M, 1, -40.123, 1234)
    s().recordProbedZ(M, 7, -35, 5678) // auto-creates the row
    const t1 = s().tableFor(M).tools.find((t) => t.tool === 1)!
    expect(t1.dia).toBe(6.35)
    expect(t1.probedMachineZ).toBeCloseTo(-40.123)
    expect(t1.measuredAt).toBe(1234)
    expect(s().tableFor(M).tools.map((t) => t.tool)).toEqual([1, 3, 7])
    s().setReference(M, 1)
    expect(s().tableFor(M).reference).toBe(1)
    s().removeTool(M, 1)
    expect(s().tableFor(M).reference).toBeNull() // removing the reference clears it
    expect(s().tableFor(M).tools.map((t) => t.tool)).toEqual([3, 7])
    // Another machine is untouched.
    expect(s().tableFor('machine-b')).toEqual(EMPTY_TOOL_TABLE)
  })

  it('keeps probe config per machine with defaults', () => {
    const s = () => useMachineToolTable.getState()
    expect(s().probeConfigFor(M)).toEqual(DEFAULT_ZPROBE_CONFIG)
    s().setProbeConfig(M, { padThickness: 12.7, slowFeed: 40 })
    expect(s().probeConfigFor(M).padThickness).toBe(12.7)
    expect(s().probeConfigFor(M).slowFeed).toBe(40)
    expect(s().probeConfigFor(M).fastFeed).toBe(DEFAULT_ZPROBE_CONFIG.fastFeed)
    s().clearProbeConfig(M)
    expect(s().probeConfigFor(M)).toEqual(DEFAULT_ZPROBE_CONFIG)
    expect(s().tableFor(M).tools).toEqual([])
    expect(s().probeConfigFor('machine-b')).toEqual(DEFAULT_ZPROBE_CONFIG)
  })
})
