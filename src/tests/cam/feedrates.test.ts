import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { resolveFeedrates } from '../../lib/cam/feedrates'
import type { Tool, FeedrateOverride } from '../../types'

function makeTool(overrides: Tool['feedsAndSpeeds'] = {}): Tool {
  return {
    id: 't1',
    name: 'Test Tool',
    type: 'flat_end_mill',
    diameter: 6,
    fluteLength: 25,
    shankDiameter: 6,
    overallLength: 60,
    numberOfFlutes: 3,
    material: 'carbide',
    coating: 'tialn',
    notes: '',
    feedsAndSpeeds: overrides,
  }
}

function makeOverride(fields: Partial<FeedrateOverride> = {}): FeedrateOverride {
  return {
    enabled: true,
    rpm: 0,
    feedRate:       2000,
    plungeRate:     400,
    rampFeedrate:   600,
    leadInFeedrate: 1800,
    leadOutFeedrate: 1800,
    fastTraverseFeedrate: 3500,
    finishFeedrate: undefined,
    ...fields,
  } as FeedrateOverride
}

describe('resolveFeedrates', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
  })

  // ── Override tier ─────────────────────────────────────────────────────────────

  it('override.enabled=true with all 5 fields: override wins, no warn', () => {
    const tool = makeTool()  // no feedsAndSpeeds.default
    const override = makeOverride()
    const result = resolveFeedrates(tool, override)
    expect(result.feedRate).toBe(2000)
    expect(result.plungeRate).toBe(400)
    expect(result.rampRate).toBe(600)
    expect(result.leadInRate).toBe(1800)
    expect(result.leadOutRate).toBe(1800)
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('override.enabled=true, no feedsAndSpeeds.default at all: override still wins, no safety fallback', () => {
    const tool: Tool = { ...makeTool(), feedsAndSpeeds: {} }
    const override = makeOverride()
    const result = resolveFeedrates(tool, override)
    expect(result.feedRate).toBe(2000)
    expect(result.plungeRate).toBe(400)
    expect(warnSpy).not.toHaveBeenCalled()
  })

  // ── Tool-defaults tier ────────────────────────────────────────────────────────

  it('no override, tool has all 5 rates in default: all 5 from tool, no warn', () => {
    const tool = makeTool({
      default: { rpm: 10000, feedRate: 1500, plungeRate: 250, rampFeedrate: 375, leadInFeedrate: 1400, leadOutFeedrate: 1400, depthOfCut: 3, stepover: 2 },
    })
    const result = resolveFeedrates(tool, undefined)
    expect(result.feedRate).toBe(1500)
    expect(result.plungeRate).toBe(250)
    expect(result.rampRate).toBe(375)
    expect(result.leadInRate).toBe(1400)
    expect(result.leadOutRate).toBe(1400)
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('no override, tool has only feedRate and plungeRate: derived rates computed, no warn', () => {
    const tool = makeTool({
      default: { rpm: 0, feedRate: 1000, plungeRate: 200, depthOfCut: 3, stepover: 2 },
    })
    const result = resolveFeedrates(tool, undefined)
    expect(result.feedRate).toBe(1000)
    expect(result.plungeRate).toBe(200)
    expect(result.rampRate).toBe(Math.round(200 * 1.5))   // 300
    expect(result.leadInRate).toBe(1000)
    expect(result.leadOutRate).toBe(1000)
    expect(warnSpy).not.toHaveBeenCalled()
  })

  // ── Safety-fallback tier ──────────────────────────────────────────────────────

  it('no override, no feedsAndSpeeds.default: safety fallback fires, warn called exactly twice', () => {
    const tool: Tool = { ...makeTool(), feedsAndSpeeds: {} }
    const result = resolveFeedrates(tool, undefined)
    expect(result.feedRate).toBe(300)
    expect(result.plungeRate).toBe(100)
    expect(result.rampRate).toBe(150)     // Math.round(100 * 1.5)
    expect(result.leadInRate).toBe(300)
    expect(result.leadOutRate).toBe(300)
    expect(warnSpy).toHaveBeenCalledTimes(2)
  })

  it('no override, default present but feedRate missing: only feedRate warn fires', () => {
    const tool = makeTool({
      default: { rpm: 0, plungeRate: 200, depthOfCut: 3, stepover: 2 } as any,
    })
    const result = resolveFeedrates(tool, undefined)
    expect(result.feedRate).toBe(300)    // safety fallback
    expect(result.plungeRate).toBe(200)  // from tool
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0][0]).toContain('feedRate')
  })

  it('no override, default present but plungeRate missing: only plungeRate warn fires', () => {
    const tool = makeTool({
      default: { rpm: 0, feedRate: 1200, depthOfCut: 3, stepover: 2 } as any,
    })
    const result = resolveFeedrates(tool, undefined)
    expect(result.feedRate).toBe(1200)   // from tool
    expect(result.plungeRate).toBe(100)  // safety fallback
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0][0]).toContain('plungeRate')
  })

  // ── Fast-traverse hierarchy (machine clamps, tool defaults, operation overrides) ──

  it('fast traverse: operation override wins, clamped to the machine rapid rate', () => {
    const tool = makeTool({ default: { rpm: 0, feedRate: 1000, plungeRate: 200, fastTraverseFeedrate: 2500, depthOfCut: 3, stepover: 2 } })
    // Override 3500 is below the 5000 machine ceiling -> used as-is, beating the tool's 2500.
    expect(resolveFeedrates(tool, makeOverride(), 5000).fastTraverseRate).toBe(3500)
    // Override above the ceiling is clamped down to the machine maximum.
    expect(resolveFeedrates(tool, makeOverride({ fastTraverseFeedrate: 9000 }), 5000).fastTraverseRate).toBe(5000)
  })

  it('fast traverse: tool default used when no override, clamped to the machine rapid rate', () => {
    const tool = makeTool({ default: { rpm: 0, feedRate: 1000, plungeRate: 200, fastTraverseFeedrate: 2500, depthOfCut: 3, stepover: 2 } })
    expect(resolveFeedrates(tool, undefined, 5000).fastTraverseRate).toBe(2500)
    // A tool default above the machine maximum is clamped.
    const fastTool = makeTool({ default: { rpm: 0, feedRate: 1000, plungeRate: 200, fastTraverseFeedrate: 8000, depthOfCut: 3, stepover: 2 } })
    expect(resolveFeedrates(fastTool, undefined, 5000).fastTraverseRate).toBe(5000)
  })

  it('fast traverse: defaults to the machine rapid rate when neither tool nor override specify it', () => {
    const tool = makeTool({ default: { rpm: 0, feedRate: 1000, plungeRate: 200, depthOfCut: 3, stepover: 2 } })
    expect(resolveFeedrates(tool, undefined, 5000).fastTraverseRate).toBe(5000)
  })

  it('fast traverse: with no machine ceiling (worker path) it is left unclamped, falling back to the cutting feed', () => {
    const tool = makeTool({ default: { rpm: 0, feedRate: 1000, plungeRate: 200, depthOfCut: 3, stepover: 2 } })
    expect(resolveFeedrates(tool, undefined).fastTraverseRate).toBe(1000)
  })

  // ── Finish feed (override -> tool default -> cutting-feed fallback) ──────────────

  it('finish: defaults to the resolved CUTTING feed when neither override nor tool specify it', () => {
    const tool = makeTool({ default: { rpm: 0, feedRate: 1000, plungeRate: 200, depthOfCut: 3, stepover: 2 } })
    expect(resolveFeedrates(tool, undefined).finishRate).toBe(1000) // = resolved cut feed
    // Override enabled but no finishFeedrate set -> uses the resolved override cut feed.
    expect(resolveFeedrates(tool, makeOverride()).finishRate).toBe(2000) // makeOverride feedRate
  })

  it('finish: tool default used when no override sets it', () => {
    const tool = makeTool({ default: { rpm: 0, feedRate: 1000, plungeRate: 200, finishFeedrate: 700, depthOfCut: 3, stepover: 2 } })
    expect(resolveFeedrates(tool, undefined).finishRate).toBe(700)
  })

  it('finish: operation override wins over tool default (and is NOT machine-clamped)', () => {
    const tool = makeTool({ default: { rpm: 0, feedRate: 1000, plungeRate: 200, finishFeedrate: 700, depthOfCut: 3, stepover: 2 } })
    expect(resolveFeedrates(tool, makeOverride({ finishFeedrate: 1200 }), 5000).finishRate).toBe(1200)
  })
})
