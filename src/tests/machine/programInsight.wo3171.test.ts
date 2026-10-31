import { describe, expect, it } from 'vitest'
import { textProgramInsight, stagedProgramInsight } from '../../lib/gcode/programInsight'
import { buildPreviewModel } from '../../lib/machine/previewGeometry'
import { readGcodeProgram } from '../../lib/gcode/reader'
import type { ProgramStep } from '../../lib/machine/controller'

const header = 'G21 G90 G54 G94\nT1 M6\nM3 S12000\nG0 X0 Y0 Z5\n'
describe('WO-3171 program facts from cutting segments', () => {
  it('ignores merely set F/S words, rapids, comments and tool preselection', () => {
    const text = header + 'F9999 S30000\nF300 S12000\nG1 Z-2\nT9\nG1 X10 F600 S18000\nG0 Z5 F8888 S40000\n(T99 M6 F1 S1)\n; F2 S2\nM30'
    const facts = textProgramInsight(text)
    expect(facts.feedMmMin).toEqual({ min: 300, max: 600 })
    expect(facts.spindleRpm).toEqual({ min: 12000, max: 18000 })
    expect(facts.tools).toEqual([1])
    expect(facts.toolsUnknown).toBe(false)
    expect(facts.bounds).toEqual(buildPreviewModel(text).workBounds)
  })
  it('normalizes modal mm/inch changes, including F retained across a unit change', () => {
    const facts = textProgramInsight(header + 'G1 X10 F254\nG20\nG1 X1 F20\nG21\nG1 X40\nM30')
    expect(facts.feedMmMin).toEqual({ min: 254, max: 508 })
    expect(facts.bounds?.max.x).toBe(40)
  })
  it('records stopped spindle as zero and tracks a speed change while running', () => {
    const facts = textProgramInsight(header + 'G1 X10 F100\nS18000\nG1 X20\nM5\nS40000\nG1 X30\nM4 S6000\nG1 X40\nM30')
    expect(facts.spindleRpm).toEqual({ min: 0, max: 18000 })
  })
  it('only counts fitted tools used during cuts, in first-use order', () => {
    const facts = textProgramInsight(header + 'T3\nG1 X10 F100\nM6\nG1 X20\nT2 M6\nG0 X30\nT7\nM30')
    expect(facts.tools).toEqual([1, 3])
    expect(facts.toolsUnknown).toBe(false)
  })
  it('marks missing feed, spindle and active tool unknown without inventing zeros', () => {
    const facts = textProgramInsight('G21 G90 G54\nG1 X10')
    expect(facts.feedMmMin).toBeNull()
    expect(facts.spindleRpm).toBeNull()
    expect(facts.toolsUnknown).toBe(true)
  })
  it('has no range for an empty or setting-only program', () => {
    for (const text of ['', 'G21\nF500 S10000 T3\nM3\nG0 X5']) {
      const facts = textProgramInsight(text)
      expect(facts.feedMmMin).toBeNull()
      expect(facts.spindleRpm).toBeNull()
      expect(facts.tools).toEqual([])
    }
  })
  it('uses the preview canned-cycle expansion for plunge feeds', () => {
    const facts = textProgramInsight(header + 'G81 X10 Y5 Z-3 R2 F120\nX20\nG80\nM30')
    expect(facts.feedMmMin).toEqual({ min: 120, max: 120 })
    expect(facts.spindleRpm).toEqual({ min: 12000, max: 12000 })
    expect(facts.bounds?.min.z).toBe(-3)
  })
  it('keeps inverse-time feed unknown while retaining known RPM and active tools', () => {
    const facts = textProgramInsight(header + 'G93 G1 X10 F2\nM30')
    expect(facts.feedMmMin).toBeNull()
    expect(facts.spindleRpm).toEqual({ min: 12000, max: 12000 })
    expect(facts.tools).toEqual([1])
  })
  it('preserves RPM and tools in feed-per-revolution mode without inventing mm/min', () => {
    const facts = textProgramInsight(header + 'G95 G1 X10 F.2\nM30')
    expect(facts.feedMmMin).toBeNull()
    expect(facts.spindleRpm).toEqual({ min: 12000, max: 12000 })
    expect(facts.tools).toEqual([1])
  })
  it('preserves feed and tools in constant-surface-speed mode without inventing RPM', () => {
    const facts = textProgramInsight(header + 'G96 S200\nG1 X10 F300\nM30')
    expect(facts.feedMmMin).toEqual({ min: 300, max: 300 })
    expect(facts.spindleRpm).toBeNull()
    expect(facts.tools).toEqual([1])
  })
  it('does not revive inverse-time F as mm/min after G94', () => {
    const facts = textProgramInsight(header + 'G93 F2\nG94\nG1 X10\nM30')
    expect(facts.feedMmMin).toBeNull()
  })
  it.each(['G95 G1 X10 F.2', 'G96 S200\nG1 X10 F100', 'M2001\nG1 X10 F100', 'G1 X#1 F100'])('does not invent unsupported facts: %s', (body) => {
    const facts = textProgramInsight(header + body + '\nM30')
    expect(facts.feedMmMin === null || facts.spindleRpm === null).toBe(true)
  })
  it('excludes G53 machine targets from the shared work bounds', () => {
    const text = header + 'G1 X10 Y20 Z-2 F300\nG53 G0 Z100\nM30'
    expect(textProgramInsight(text).bounds).toEqual(buildPreviewModel(text).workBounds)
    expect(textProgramInsight(text).bounds?.max.z).toBe(5)
  })
  it('includes cutting values on return from a G53 retract to the same raw work endpoint', () => {
    const text = header + 'G1 Z-2 F300\nG53 G0 Z100\nM3 S18000\nG1 Z-2 F600\nM30'
    // G54 at machine zero makes both real cutting moves hand-calculable.
    // The production reader independently confirms their feeds and endpoints.
    const read = readGcodeProgram(text, { dialect: 'uccnc', sessionWcs: 'G54', initialPosition: { x: 0, y: 0, z: 0 }, machineUnits: 'mm', workOffsets: { G54: { x: 0, y: 0, z: 0 } } })
    expect(read.ok).toBe(true)
    if (!read.ok) throw new Error(read.refusal.message)
    expect(read.program.moves.filter((move) => move.type === 'feed').map((move) => ({ z: move.z, feed: move.feed }))).toEqual([{ z: -2, feed: 300 }, { z: -2, feed: 600 }])
    const facts = textProgramInsight(text)
    expect(facts.feedMmMin).toEqual({ min: 300, max: 600 })
    expect(facts.spindleRpm).toEqual({ min: 12000, max: 18000 })
    expect(facts.bounds).toEqual(buildPreviewModel(text).workBounds)
  })
  it('retains the G53 axis identity across cuts addressing only other axes', () => {
    const facts = textProgramInsight(header + 'G1 Z-2 F300\nG53 G0 Z100\nG1 X10 F400\nM3 S18000\nG1 Z-2 F600\nM30')
    expect(facts.feedMmMin).toEqual({ min: 300, max: 600 })
    expect(facts.spindleRpm).toEqual({ min: 12000, max: 18000 })
  })
  it('still excludes stationary cuts in a known frame and zero incremental moves after G53', () => {
    const facts = textProgramInsight(header + 'G1 Z-2 F300\nG53 G0 Z100\nG1 X0 F9999 S99999\nG91 G1 Z0\nG90 G1 Z-2 F600 S18000\nG1 Z-2 F8888 S88888\nM30')
    expect(facts.feedMmMin).toEqual({ min: 300, max: 600 })
    expect(facts.spindleRpm).toEqual({ min: 12000, max: 18000 })
  })
  it('does not include cutting values after program end', () => {
    expect(textProgramInsight(header + 'G1 X10 F100\nM30\nG1 X20 F900 S99999').feedMmMin).toEqual({ min: 100, max: 100 })
  })
  it('reads native staged intents without altering a single step', () => {
    const steps: ProgramStep[] = [
      { id: 1, kind: 'toolChange', toolNumber: 2, description: null },
      { id: 2, kind: 'spindle', direction: 'cw', rpm: 12000 },
      { id: 3, kind: 'line', to: { x: 0, y: 0, z: 5 }, rapid: true, feedMmMin: 6000 },
      { id: 4, kind: 'line', to: { x: 10, y: 0, z: -2 }, feedMmMin: 300 },
      { id: 5, kind: 'spindle', direction: 'off' },
      { id: 6, kind: 'line', to: { x: 20 }, feedMmMin: 600 },
      { id: 7, kind: 'spindle', direction: 'cw', rpm: 99999 },
      { id: 8, kind: 'line', to: { x: 20 }, feedMmMin: 9999 },
    ]
    const bytes = JSON.stringify(steps)
    const bounds = { min: { x: 0, y: 0, z: -2 }, max: { x: 20, y: 0, z: 5 } }
    expect(stagedProgramInsight(steps, bounds)).toEqual({ feedMmMin: { min: 300, max: 600 }, spindleRpm: { min: 0, max: 12000 }, tools: [2], toolsUnknown: false, bounds })
    expect(JSON.stringify(steps)).toBe(bytes)
  })
})
