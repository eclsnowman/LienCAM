// Quick-edit card feed resolution (Phase 7, P12 / 7.1) — headless coverage.
//
// The card shows the EFFECTIVE feed/plunge (tool default unless an enabled
// override exists) and, when edited, persists a feedrateOverride that flips
// enabled true and patches only the one field — never silently zeroing the
// other lead/ramp/finish feeds.

import { describe, it, expect } from 'vitest'
import { resolveOpFeeds, patchFeedOverride, toolDefaultFeeds } from '../../components/panels/PropertiesPanel'
import type { Operation, Tool } from '../../types'

const tool = {
  id: 't1', name: '6mm Flat', diameter: 6,
  feedsAndSpeeds: { default: { rpm: 18000, feedRate: 1200, plungeRate: 300, depthOfCut: 2, stepover: 3 } },
} as unknown as Tool

const baseOp = { id: 'o1', toolId: 't1' } as unknown as Operation

describe('toolDefaultFeeds', () => {
  it('reads the tool default feeds & speeds', () => {
    expect(toolDefaultFeeds(tool)).toEqual({ feedRate: 1200, plungeRate: 300 })
  })
  it('falls back to sane defaults with no tool', () => {
    expect(toolDefaultFeeds(undefined)).toEqual({ feedRate: 1000, plungeRate: 300 })
  })
})

describe('resolveOpFeeds', () => {
  it('uses the tool default when there is no override', () => {
    expect(resolveOpFeeds(baseOp, tool)).toEqual({ feedRate: 1200, plungeRate: 300 })
  })
  it('uses an ENABLED override over the tool default', () => {
    const op = { ...baseOp, feedrateOverride: { enabled: true, feedRate: 800, plungeRate: 200 } } as unknown as Operation
    expect(resolveOpFeeds(op, tool)).toEqual({ feedRate: 800, plungeRate: 200 })
  })
  it('ignores a DISABLED override (falls back to tool)', () => {
    const op = { ...baseOp, feedrateOverride: { enabled: false, feedRate: 800, plungeRate: 200 } } as unknown as Operation
    expect(resolveOpFeeds(op, tool)).toEqual({ feedRate: 1200, plungeRate: 300 })
  })
})

describe('patchFeedOverride', () => {
  it('seeds an enabled override from the tool when none exists, patching one field', () => {
    const fo = patchFeedOverride(baseOp, tool, 'feedRate', 950)
    expect(fo.enabled).toBe(true)
    expect(fo.feedRate).toBe(950)
    expect(fo.plungeRate).toBe(300)   // seeded from tool, not zeroed
    expect(fo.rpm).toBe(18000)
  })

  it('preserves the existing override and patches only the edited field', () => {
    const op = {
      ...baseOp,
      feedrateOverride: {
        enabled: true, rpm: 12000, feedRate: 800, plungeRate: 250,
        rampFeedrate: 400, leadInFeedrate: 800, leadOutFeedrate: 800,
        fastTraverseFeedrate: 3000, finishFeedrate: 800,
      },
    } as unknown as Operation
    const fo = patchFeedOverride(op, tool, 'plungeRate', 220)
    expect(fo.plungeRate).toBe(220)
    expect(fo.feedRate).toBe(800)         // untouched
    expect(fo.leadInFeedrate).toBe(800)   // untouched
    expect(fo.rpm).toBe(12000)            // untouched
  })
})
