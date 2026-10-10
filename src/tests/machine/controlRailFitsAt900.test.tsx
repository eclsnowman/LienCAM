// @vitest-environment jsdom
//
// WO-103: THE CONTROL RIGHT RAIL MUST FIT AT A 900px-TALL VIEWPORT.
//
// Operator, 2026-08-08, looking at his own 1913x903 window:
//   "it looks done, the only issue is macros spills of the page requiring
//    scroll."
//
// This is NOT a regression report. WO-068 found Macros UNREACHABLE (the rail
// was overflow:hidden with no scroll path) and gave each rail a sanctioned
// `.control-col-scroll` wrapper. That was the right fix for "unreachable" and
// it STAYS - see the scroller-retained block below, which re-asserts it from
// here as well as from controlPagePolish.test.tsx. Operator has now supplied a
// better requirement: it should not need reaching at all.
//
// THREE LAYERS, because jsdom does not lay out:
//
//   1. THE CSS DENSITY CONTRACT (this file). Every number recovered by WO-103
//      is pinned with the pixels it saves, so the 118px cannot silently
//      regrow one padding bump at a time - which is exactly how the rail got
//      to 1011px of content in a 791px box.
//
//   2. THE COMMITTED EVIDENCE (bottom of this file). The full harness run -
//      both viewports, both macro loads, the macro-count threshold and the
//      three rendered escalation options - lands in
//      src/tests/evidence/WO-103/measurements.json and is read back here, so
//      the shipped CSS and the recorded evidence cannot drift apart.
//      Regenerate with: node src/tests/evidence/WO-103/capture.mjs
//
//   3. THE LIVE MEASUREMENT (controlRailFitsAt900.live.test.ts, WO-119).
//      READ THAT FILE BEFORE TRUSTING THIS ONE. Layers 1 and 2 are both
//      stored numbers - WO-103's audit was right that neither proves the
//      CURRENT app fits:
//
//        > A green declared slice therefore still does not prove the current
//        > app fits at 900px.
//
//      WO-119 closed that: the declared slice now boots Vite and Chromium and
//      measures the rail on every normal run. This file is the regrowth
//      tripwire and the drift check around it, NOT the proof.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

// Comments are stripped up front: this file's own rules are heavily commented,
// and a comment sitting between `}` and the next selector would otherwise be
// swept into that rule's selector list by the parser below.
const appCss = [
  readFileSync('src/styles/app.css', 'utf8'),
  readFileSync('src/app.css', 'utf8'),
].join('\n').replace(/\/\*[\s\S]*?\*\//g, '')

const measurements = JSON.parse(
  readFileSync('src/tests/evidence/WO-103/measurements.json', 'utf8'),
)

/** Space tokens from src/theme/tokens.css, so assertions talk in real px. */
const SPACE_PX: Record<string, number> = {
  '--space-0': 0,
  '--space-1': 4,
  '--space-2': 8,
  '--space-3': 12,
  '--space-4': 16,
  '--hit-target-min': 24,
}

/**
 * Bodies of every rule whose selector LIST contains `selector` exactly.
 *
 * controlPagePolish.test.tsx anchors its regex at the start of a line, which
 * silently misses a selector that appears as a non-final member of a grouped
 * rule (`a,\n b,\n c { ... }` - only `c` is followed by a brace). The WO-103
 * gap rules are written that way, so this splits rules properly instead.
 */
function ruleBodies(selector: string): string[] {
  const bodies: string[] = []
  for (const match of appCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = match[1].split(',').map((s) => s.trim().replace(/\s+/g, ' '))
    if (selectors.includes(selector)) bodies.push(match[2])
  }
  if (bodies.length === 0) throw new Error(`no CSS rule found for "${selector}"`)
  return bodies
}

/** Last-wins value of `property` across every rule matching `selector`. */
function decl(selector: string, property: string): string {
  const matches = ruleBodies(selector).flatMap((body) =>
    Array.from(body.matchAll(new RegExp(`(?:^|;)\\s*${property}\\s*:([^;]*)`, 'g'))),
  )
  const match = matches[matches.length - 1]
  if (!match) throw new Error(`"${selector}" has no ${property} declaration`)
  return match[1].trim()
}

/** px value of a length that may be a raw px or a var(--space-N). */
function px(value: string): number {
  const token = /var\((--[a-z0-9-]+)\)/.exec(value)
  if (token) {
    const resolved = SPACE_PX[token[1]]
    if (resolved === undefined) throw new Error(`unmapped token ${token[1]}`)
    return resolved
  }
  const raw = /^(-?[\d.]+)px$/.exec(value)
  if (!raw) throw new Error(`not a length: "${value}"`)
  return Number(raw[1])
}

const RAIL_HEADER = '.control-col-scroll > .control-panel > .panel-header'
const RAIL_BODY = '.control-col-scroll > .control-panel > .panel-body'

describe('WO-103: the right rail spends its height on controls, not chrome', () => {
  // Measured in the real app BEFORE this WO (1913x903, 8 custom macros + 2
  // parks): 1011px of content in a 791px rail. 316px of that - 31% - was
  // headers, body padding and gaps. Each assertion below names what it buys.

  it('gives rail panel headers 26px, not the app-wide 36px (saves 40px over four panels)', () => {
    // Four 36px headers carried 144px for four uppercase words. 26px still
    // clears the only control a rail header holds - the Macros gear, a 24px
    // square .panel-action-btn - with a pixel top and bottom.
    expect(px(decl(RAIL_HEADER, 'height'))).toBe(26)
    expect(px(decl(RAIL_HEADER, 'min-height'))).toBe(26)
    expect(px(decl('.panel-action-btn', 'height'))).toBe(24)
    expect(px(decl(RAIL_HEADER, 'height'))).toBeGreaterThanOrEqual(
      px(decl('.panel-action-btn', 'height')),
    )
    // Scoped to the rails: every other panel header in the app is untouched.
    expect(px(decl('.panel-header', 'height'))).toBe(36)
  })

  it('trims only the spare bottom gutter and keeps the 12px side inset (saves 16px)', () => {
    const sides = decl(RAIL_BODY, 'padding').split(/\s+/).map(px)
    const [top, side, bottom] = [sides[0], sides[1], sides[2] ?? sides[0]]
    expect(top).toBe(8)
    expect(bottom).toBe(8)
    // UI-CONTROL-PAGE-POLISH contract: the side inset lines the body up with
    // the header title and is NOT what WO-103 spends. Operator's 2026-08-05 defect
    // was content flush to the card border; that stays fixed.
    expect(side).toBe(12)
    for (const value of sides) expect(value).toBeGreaterThanOrEqual(8)
  })

  it('closes the intra-panel and inter-panel gaps to 6-8px (saves 22px)', () => {
    // The rails run one control block per row, so 10/8px between them was air,
    // not grouping.
    expect(px(decl('.control-col-scroll .control-jog-body', 'gap'))).toBe(8)
    for (const selector of [
      '.control-col-scroll .control-ovr-body',
      '.control-col-scroll .control-spindle-body',
      '.control-col-scroll .control-macro-body',
    ]) {
      expect(px(decl(selector, 'gap'))).toBe(6)
    }
    expect(px(decl('.control-col-scroll', 'gap'))).toBe(6)
  })

  it('densifies the macro buttons without dropping them near the hit-target floor (saves 40px)', () => {
    // The WO's own second suspect: "the macro buttons are large relative to
    // their information". 10px of vertical padding on a one-word label made
    // each button 41px tall, five rows of them. 6px takes them to 33px.
    const pad = decl('.control-col-scroll .control-macro-btn', 'padding').split(/\s+/).map(px)
    expect(pad[0]).toBe(6)
    // 6px padding + 2px border, top and bottom, around a 17px line box.
    const borderPx = px(decl('.control-macro-btn', 'border').split(/\s+/)[0])
    const measuredHeight = 2 * pad[0] + 2 * borderPx + 17
    expect(measuredHeight).toBe(33)
    // COHESION-STANDARD sections 2 and 9: >= 24x24 effective. Still 9px clear,
    // and still the tallest target in the rail.
    expect(measuredHeight).toBeGreaterThanOrEqual(SPACE_PX['--hit-target-min'])
    expect(pad[1]).toBeGreaterThanOrEqual(8)
  })

  it('shrinks NO machine control - jog, override and spindle targets are untouched', () => {
    // WO-103 forbids making it "fit" by making the controls too small to hit.
    // Nothing WO-103 changed touches a control's own box; these are the
    // pre-existing minimums, re-asserted here so a future density pass cannot
    // quietly take the next 20px out of the operator's fingers.
    expect(px(decl('.control-chip-btn', 'min-height'))).toBe(24)
    expect(px(decl('.control-chip-btn', 'min-width'))).toBe(24)
    expect(px(decl('.control-ovr-step', 'min-width'))).toBe(30)
    expect(px(decl('.control-ovr-value-btn', 'min-width'))).toBe(52)
    expect(decl('.control-jog-pad', 'aspect-ratio')).toBe('1 / 1')
    expect(px(decl('.control-jog-pad', 'max-width'))).toBe(176)
  })
})

describe('WO-103: the scroller is kept as the safety net, not deleted', () => {
  it('leaves the WO-068 sanctioned scroller exactly as it landed', () => {
    // Removing this would re-open the WO-068 defect where Macros became
    // unreachable ENTIRELY. WO-103 makes it not FIRE at 900px; at some
    // viewport, or some macro count, it will always be needed. Also asserted
    // in controlPagePolish.test.tsx - deliberately in both places, because
    // WO-103 is precisely the kind of change that would be tempted to drop it.
    expect(decl('.control-col-scroll', 'overflow-y')).toBe('auto')
    expect(decl('.control-col-scroll', 'overflow-x')).toBe('hidden')
    expect(decl('.control-col-right', 'overflow')).toBe('hidden')
    expect(decl('.control-page', 'overflow')).toBe('hidden')
    expect(decl('.control-columns', 'overflow')).toBe('hidden')
  })

  it('keeps rail panels content-sized so the column stays the ONE scroller', () => {
    expect(decl('.control-col-scroll > .control-panel', 'flex')).toBe('0 0 auto')
    expect(decl('.control-col-scroll > .control-panel', 'overflow')).toBe('visible')
  })
})

describe('WO-103: the committed pixel evidence agrees with the shipped CSS', () => {
  // src/tests/evidence/WO-103/measurements.json, written by the Playwright
  // harness against the live app. Read back here so the two cannot drift: a
  // CSS regrowth that is not re-measured leaves these stale, and a re-measure
  // that shows overflow turns them red.
  //
  // WO-119: these are STORED numbers and they are not the fit proof - see the
  // header. What they still buy that the live gate does not: the heavy 10-macro
  // load, the macro-count threshold and the three rendered escalation options,
  // none of which the live gate re-measures because none of them is asserted.
  // Keeping them here is what stops the escalation being quietly dropped.

  const byTag = (tag: string) =>
    measurements.viewports.find((viewport: { tag: string }) => viewport.tag === tag)

  it('was captured with no deliberate sabotage and no page exceptions', () => {
    expect(measurements.wo).toBe('WO-103')
    expect(measurements.deliberateBreak).toBe(false)
    for (const viewport of measurements.viewports) {
      expect(viewport.measurements.pageErrors).toEqual([])
    }
  })

  it.each([
    ['default-1913x903', 903],
    ['default-1440x900', 900],
  ])('fits the product-default rail inside %s without scrolling', (tag, height) => {
    const viewport = byTag(tag)
    expect(viewport).toBeTruthy()
    expect(viewport.measurements.viewport.h).toBe(height)
    expect(viewport.failures).toEqual([])

    const fit = viewport.measurements.fitAtRest
    // THE observable Operator reported, measured at scrollTop 0: the Macros card's
    // bottom edge against the rail's visible bottom. Negative = clearance.
    expect(fit.scrollTop).toBe(0)
    expect(fit.macrosOverflowPx).toBeLessThanOrEqual(0)
    expect(fit.macrosFitsWithoutScrolling).toBe(true)
    // ...and the scroller therefore never engages here.
    expect(fit.railIsScrolling).toBe(false)
    expect(fit.railOverflowPx).toBe(0)
  })

  it('records the four rail panels at the densified heights this CSS produces', () => {
    // Before WO-103 / after WO-103, measured at 1913x903:
    //   Jog 361 -> 343, Overrides 150 -> 132, Spindle 187 -> 167,
    //   Macros (8 customs + 2 parks) 289 -> 233, rail gaps 24 -> 18.
    //   Rail content 1011 -> 893.
    const heavy = byTag('heavy-1913x903')
    const heights = Object.fromEntries(
      heavy.measurements.budget.map((p: { title: string; panelHeight: number }) => [
        p.title, p.panelHeight,
      ]),
    )
    expect(heights).toEqual({
      Jog: 343,
      Overrides: 132,
      'Spindle / Coolant': 167,
      Macros: 233,
    })
    expect(heavy.measurements.gapSum).toBe(18)
    expect(heavy.measurements.spent).toBe(893)
    // Every rail header really did render at the 26px this CSS asks for.
    for (const panel of heavy.measurements.budget) expect(panel.headerHeight).toBe(26)
  })

  it('keeps every rail panel reachable by scrolling at the heavy load (WO-068)', () => {
    // The safety net is not theoretical: at 8 customs + 2 parks the rail DOES
    // overflow, and every panel must still be scrollable fully into view.
    for (const tag of ['heavy-1913x903', 'heavy-1440x900']) {
      const heavy = byTag(tag)
      expect(heavy.measurements.fitAtRest.railIsScrolling).toBe(true)
      expect(heavy.measurements.reach).toHaveLength(4)
      for (const panel of heavy.measurements.reach) {
        expect(panel.vertical).toBe(true)
        expect(panel.horizontal).toBe(true)
      }
      expect(heavy.failures).toEqual([])
    }
  })

  it('answers the OVERRIDES right-edge question: nothing is clipped', () => {
    // WO-103 "also observed, verify and report": Operator's screenshot appeared to
    // show Feed and Spindle reading "-10 -1 100% +1 +" with a truncated "+10"
    // at the window edge. Measured at his own 1913px width, all three rows
    // carry their full chip set INSIDE the card, with 12px of clearance to the
    // card border. The apparent truncation was the screenshot boundary, not a
    // clip. No WO needed - see the work order's result section.
    for (const tag of ['default-1913x903', 'heavy-1913x903']) {
      const rows = byTag(tag).measurements.overrides
      expect(rows).toHaveLength(3)
      expect(rows.map((r: { label: string }) => r.label)).toEqual(['Feed', 'Rapid', 'Spindle'])
      for (const row of rows) {
        expect(row.clippedByCard).toBe(false)
        expect(row.clippedByWindow).toBe(false)
        expect(row.stepperOverflowsItself).toBe(false)
        // Real clearance, not a rounding tie.
        expect(row.pastCardBorderPx).toBeLessThanOrEqual(-8)
      }
      expect(rows[0].buttonLabels).toEqual(['-10', '-1', '100%', '+1', '+10'])
      expect(rows[2].buttonLabels).toEqual(['-10', '-1', '100%', '+1', '+10'])
    }
  })

  it('carries the open escalation rather than silently capping the macro load', () => {
    // The heavy load still overflows by ~102px and closing it needs a layout
    // direction only Operator picks. That is recorded in the evidence with its
    // rendered options, not dropped - a silent cap reads as "covered".
    expect(measurements.escalation).toBeTruthy()
    expect(measurements.escalation.maxCustomMacrosThatFit).toEqual({
      withTwoParkPositions: 2,
      withNoParkPositions: 4,
    })
    // Three options, each rendered to a real PNG and each measured to fit.
    const renders = measurements.options.renders
    expect(renders.map((r: { key: string }) => r.key)).toEqual([
      'opt-b-collapsed', 'opt-c-two-column', 'opt-d-macros-subview',
    ])
    for (const render of renders) expect(render.fits).toBe(true)
  })
})
