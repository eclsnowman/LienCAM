// @vitest-environment jsdom
//
// UI-CONTROL-PAGE-POLISH regressions (Operator bug 2026-08-05, full-page Control
// screenshot). Measured in the real app at 1916x904 and 1280x800 before the
// fix; see docs/qa/023-control-page-polish/README.md for the census.
//
// jsdom does not lay out, so structural facts are pinned two ways:
//   - the production CSS contract, parsed in application load order from the
//     base src/styles/app.css plus the owned src/app.css override;
//   - the rendered DOM shape of the panels that were re-rowed.
// Both are the things that actually regressed; a snapshot of pixels would not
// survive an honest restyle, and these do.

import { describe, it, expect, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'

const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  key: (i: number) => Array.from(mem.keys())[i] ?? null,
  removeItem: (k: string) => { mem.delete(k) },
  setItem: (k: string, v: string) => { mem.set(k, String(v)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

const { JogPanel } = await import('../../components/machine/JogPanel')
const { SpindlePanel } = await import('../../components/machine/SpindlePanel')
const { useUiPrefs } = await import('../../store/uiPrefs')

const appCss = [
  readFileSync('src/styles/app.css', 'utf8'),
  readFileSync('src/app.css', 'utf8'),
].join('\n')

/** The `--space-N` scale from src/theme/tokens.css, so padding assertions can
 *  talk in real pixels instead of matching a literal declaration string. */
const SPACE_PX: Record<string, number> = {
  '--space-0': 0,
  '--space-1': 4,
  '--space-2': 8,
  '--space-3': 12,
  '--space-4': 16,
  '--hit-target-min': 24,
}

/** Bodies of every matching CSS rule in cascade order. */
function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const matches = Array.from(appCss.matchAll(new RegExp(`^${escaped}\\s*\\{([^}]*)\\}`, 'gm')))
  if (matches.length === 0) throw new Error(`no CSS rule found for "${selector}"`)
  return matches.map((match) => match[1]).join('\n')
}

function decl(selector: string, property: string): string {
  const matches = Array.from(ruleBody(selector).matchAll(
    new RegExp(`(?:^|;)\\s*${property}\\s*:([^;]*)`, 'gm'),
  ))
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

afterEach(cleanup)

describe('UI-CONTROL-PAGE-POLISH: Control card padding contract', () => {
  it('gives every Control card body real padding on all four sides', () => {
    // Root defect: .panel-body ships no padding (CAM panels pad their own list
    // children), so all ten Control cards rendered flush to the 1px border -
    // measured content inset 0px, left and right, on both viewports.
    const sides = decl('.control-panel > .panel-body', 'padding').split(/\s+/).map(px)
    expect(sides.length).toBeGreaterThanOrEqual(2)
    for (const side of sides) expect(side).toBeGreaterThanOrEqual(8)
    // Side inset lines up with .panel-header's 12px title inset.
    expect(sides[1]).toBe(12)
  })

  it('keeps the console MDI row on the same side inset as the card body', () => {
    const mdi = decl('.control-mdi-row', 'padding').split(/\s+/).map(px)
    const body = decl('.control-panel > .panel-body', 'padding').split(/\s+/).map(px)
    expect(mdi[1]).toBe(body[1])
  })

  it('keeps the remaining panel headers spaced and the relocated program readouts flush', () => {
    // WO-115: the PROGRAM header strip is gone (Info/Lines/file name/skipped
    // moved into the controls row). The other Control panels still have a
    // header, so its gap contract stays; the relocated name/skipped readouts
    // inherit no left margin so they sit flush after the source controls.
    expect(px(decl('.control-page .panel-header', 'gap'))).toBeGreaterThanOrEqual(8)
    expect(ruleBody('.control-program-name')).not.toMatch(/margin-left/)
    expect(ruleBody('.control-program-skipped')).not.toMatch(/margin-left/)
    // The strip's CSS is fully gone - no orphaned header rule for the program panel.
    expect(() => ruleBody('.control-program-panel > .panel-header')).toThrow()
    expect(() => ruleBody('.control-program-status')).toThrow()
    expect(() => ruleBody('.control-lines-toggle')).toThrow()
  })
})

describe('UI-CONTROL-PAGE-POLISH: button borders and hit areas', () => {
  it('lets a text-labelled header action size to its label', () => {
    // "Clear" in the console header overflowed the shared 24x24 icon box by
    // 5px, so its own border clipped the word.
    expect(decl('.control-page .panel-action-btn', 'width')).toBe('auto')
    expect(px(decl('.control-page .panel-action-btn', 'min-width'))).toBe(24)
  })

  it('holds every chip button at the shared 24px hit target', () => {
    // 26 chips measured 22x22 or narrower across the units, jog, step,
    // override and transport rows.
    expect(px(decl('.control-chip-btn', 'min-height'))).toBe(24)
    expect(px(decl('.control-chip-btn', 'min-width'))).toBe(24)
  })

  it('never breaks the E-STOP label and keeps every operator control on one line', () => {
    expect(decl('.control-btn-estop', 'white-space')).toBe('nowrap')
    // Hold/Start measured 35px inside a 59px bar next to a 45px E-STOP.
    expect(decl('.control-safety-bar', 'align-items')).toBe('stretch')
    expect(decl('.control-safety-bar .control-state-chip', 'align-self')).toBe('center')
    // UI-CONTROL-DENSITY-CORRECTION: the strip now also carries the subview
    // nav, so it is allowed to wrap - but ONLY the trailing next-action
    // sentence may take that wrap. Every control is fixed-basis and sits
    // before it, so none can be pushed onto a hidden second line.
    expect(decl('.control-operator-bar', 'flex-wrap')).toBe('wrap')
    expect(decl('.control-operator-bar .control-btn-estop', 'flex')).toBe('0 0 auto')
    expect(decl('.control-operator-bar .control-safety-btn', 'flex')).toBe('0 0 auto')
    expect(decl('.control-single-block-mode', 'flex')).toBe('0 0 auto')
    expect(decl('.control-strip-nav', 'flex')).toBe('0 0 auto')
    expect(decl('.control-view-tab', 'white-space')).toBe('nowrap')
    // The sentence keeps a readable basis instead of ellipsizing to "Con...".
    expect(px(decl('.control-operator-bar .control-next-action', 'flex').split(/\s+/)[2]))
      .toBeGreaterThanOrEqual(200)
  })

  it('keeps adjacent override stepper chips visually separate', () => {
    expect(px(decl('.control-ovr-stepper', 'gap'))).toBeGreaterThanOrEqual(4)
    expect(px(decl('.control-ovr-segments', 'gap'))).toBeGreaterThanOrEqual(4)
  })
})

// UI-CONTROL-DENSITY-CORRECTION (Operator denial Q-95, annotated screenshot
// coordination/inbox/Q-95/chrome_oli9TDi3V5.png): the redesign at 2efa40df6
// stacked FOUR full-width tiers before any operator content - app toolbar,
// workspace mode tabs, Control transport bar, Control subview tab bar. The
// two Control-specific tiers are now one strip. Measured in the real app:
// content top 185 -> 145 at 1916x904 (40px recovered), 185 -> 163 at 1280x800.
// Census: docs/qa/025-control-density-correction/README.md.
describe('UI-CONTROL-DENSITY-CORRECTION: one Control-specific tier', () => {
  it('has no second Control bar left in the stylesheet', () => {
    // The subview nav's own full-width bar is gone, not merely restyled.
    expect(() => ruleBody('.control-view-tabs')).toThrow()
    // Its tabs now live as a group INSIDE the operator strip.
    expect(ruleBody('.control-strip-nav')).toBeTruthy()
  })

  it('sizes the one strip to its controls instead of a padded minimum', () => {
    // The old bar carried min-height:48px on top of 6px padding; the merged
    // strip is 47px tall and holds both former tiers (81px of bars before).
    expect(ruleBody('.control-operator-bar')).not.toMatch(/min-height/)
    const pad = decl('.control-operator-bar', 'padding').split(/\s+/).map(px)
    expect(pad[0]).toBeLessThanOrEqual(6)
    // One margin now spans the whole gap down to the columns; the second bar
    // no longer contributes margins of its own. (The 46px top clearance the
    // old position:absolute floating mode tabs needed left with WO-047 - the
    // tabs are header chrome now, so the strip sits at ordinary spacing.)
    const margin = decl('.control-operator-bar', 'margin').split(/\s+/).map(px)
    expect(margin[0]).toBeLessThanOrEqual(8)
    expect(margin[2] ?? margin[0]).toBeLessThanOrEqual(8)
  })

  it('keeps the subview tabs and Machine actions inline, not on their own row', () => {
    // margin-left:auto was what made "Machine actions" claim a whole bar.
    expect(px(decl('.control-view-actions', 'margin-left'))).toBeLessThanOrEqual(8)
    expect(decl('.control-strip-nav', 'display')).toBe('flex')
  })
})

describe('UI-CONTROL-PAGE-POLISH: nothing overruns its card', () => {
  it('keeps MAIN and its columns fixed instead of making page/card scroll traps', () => {
    expect(decl('.control-page', 'overflow')).toBe('hidden')
    expect(decl('.control-columns', 'overflow')).toBe('hidden')
    expect(decl('.control-col-right', 'overflow')).toBe('hidden')
    // WO-068 finding 1 (Operator-approved regrid): the side rails now stack more
    // content-sized panels than a 900px viewport holds, so each rail's
    // .control-col-scroll wrapper is the page's ONE sanctioned vertical
    // scroller - a real reach path to Macros, still never the page, a card,
    // or a horizontal drift.
    expect(decl('.control-col-scroll', 'overflow-y')).toBe('auto')
    expect(decl('.control-col-scroll', 'overflow-x')).toBe('hidden')
  })

  it('wraps the transport row instead of pushing the progress readout off-card', () => {
    // At 1280 the row overran the Program card by 62px and the progress text
    // sat 61.8px beyond its right border.
    expect(decl('.control-transport', 'flex-wrap')).toBe('wrap')
    expect(decl('.control-progress', 'flex')).toMatch(/^1 1 \d+px$/)
  })

  it('wraps the program source row and bounds the recent-program select', () => {
    expect(decl('.control-program-source', 'flex-wrap')).toBe('wrap')
    // Unbounded, the select sized to its longest option and ate the row.
    expect(decl('.control-recent-select', 'flex')).toMatch(/^0 1 \d+px$/)
    expect(decl('.control-setup-select', 'flex')).toMatch(/^1 1 \d+px$/)
  })

  it('wraps the macros empty-state prose rather than clipping it', () => {
    // Measured 13px of label clipped inside its own border and 12px of card
    // overrun - the label lost its first and last characters.
    expect(decl('.control-macro-empty', 'white-space')).toBe('normal')
    expect(decl('.control-macro-body', 'gap')).toBeTruthy()
  })

  it('stops the tool-number field collapsing under its own placeholder', () => {
    expect(decl('.control-tools-add-input', 'flex')).toBe('0 0 52px')
    expect(decl('.control-tools-addrow', 'flex-wrap')).toBe('wrap')
  })

  it('keeps the g-code rail from outgrowing the preview it annotates', () => {
    // PREVIEW-FIRST LAW: at 1280 the fixed 320px rail was wider than the
    // 274px preview.
    expect(decl('.control-program-main .control-gcode-list', 'flex')).toBe('0 1 320px')
    expect(decl('.control-program-main .control-gcode-list', 'max-width')).toBe('50%')
  })
})

describe('UI-CONTROL-PAGE-POLISH: re-rowed panels keep every control', () => {
  it('moves the three machine actions out of the jog cluster into their own row', () => {
    const { container } = render(<JogPanel />)
    const cluster = container.querySelector('.control-jog-cluster')!
    // WO-931 REPIN: there are TWO action rows now - the three explicit per-axis
    // Home buttons, then the machine actions. This test is about the CLUSTER
    // staying just the pad and the Z column, so it names the row it means
    // rather than taking the first one it finds.
    const actions = screen.getByTestId('control-home').closest('.control-jog-actions')!
    expect(cluster).toBeTruthy()
    expect(actions).toBeTruthy()
    // The cluster is the XY pad plus the Z column only.
    expect(cluster.children.length).toBe(2)
    expect(cluster.querySelector('.control-jog-pad')).toBeTruthy()
    expect(cluster.querySelector('.control-jog-zcol')).toBeTruthy()
    for (const id of ['control-home', 'control-safez', 'control-unlock']) {
      const btn = screen.getByTestId(id)
      expect(btn.closest('.control-jog-actions')).toBe(actions)
      expect(btn.closest('.control-jog-cluster')).toBeNull()
    }
    // All four XY wedges and both Z buttons survive the move.
    expect(cluster.querySelectorAll('.control-jog-wedge').length).toBe(4)
    expect(cluster.querySelectorAll('.control-jog-zbtn').length).toBe(2)

    // WO-354: differentiation is structural, never dependent on axis color.
    // Y has one rail, X has two, and Z has three on both directions.
    expect(cluster.querySelectorAll('.control-jog-plate').length).toBe(6)
    for (const [id, axis, count] of [
      ['control-jog-y-plus', 'Y', 1],
      ['control-jog-y-minus', 'Y', 1],
      ['control-jog-x-plus', 'X', 2],
      ['control-jog-x-minus', 'X', 2],
      ['control-jog-z-plus', 'Z', 3],
      ['control-jog-z-minus', 'Z', 3],
    ] as const) {
      const button = screen.getByTestId(id)
      const rails = button.querySelector(`.control-jog-rails[data-axis="${axis}"]`)!
      expect(rails).toBeTruthy()
      expect(rails.querySelectorAll('line').length).toBe(count)
      expect(button.querySelector('.control-jog-label')).toBeTruthy()
    }

    // The approved Gentle correction spreads Z rail centers by 6 SVG units
    // and nudges the stack inward, preventing the three marks merging.
    const zPlus = screen.getByTestId('control-jog-z-plus').querySelector('.control-jog-rails')!
    const zMinus = screen.getByTestId('control-jog-z-minus').querySelector('.control-jog-rails')!
    expect([...zPlus.querySelectorAll('line')].map((line) => line.getAttribute('y1'))).toEqual(['18', '24', '30'])
    expect([...zMinus.querySelectorAll('line')].map((line) => line.getAttribute('y1'))).toEqual(['82', '76', '70'])
    expect(zPlus.getAttribute('transform')).toBe('translate(0 -3.68)')
    expect(zMinus.getAttribute('transform')).toBe('translate(0 3.68)')
  })

  // WO-931 REPIN. This asserted the layout Operator replaced. The step sizes were
  // four chips on a row of their own; he ruled 2026-08-24: "regain some room by
  // changing the stepsize selector into a dropdown so it can fit next to
  // continuous. That will save vertical space." Three config rows became one,
  // which is what paid for the per-axis Home row above.
  //
  // The PROPERTY the old test defended - every step size still reachable and
  // still wired to the same preference - is kept, and checked through the
  // control that now carries it.
  it('puts the jog step sizes in a dropdown beside the mode chips, still wired', () => {
    const { container } = render(<JogPanel />)
    const rows = container.querySelectorAll('.control-jog-config-row')
    expect(rows.length).toBe(1)
    expect(container.querySelector('.control-jog-steps')).toBeNull()

    const select = screen.getByTestId('control-jog-step-select') as HTMLSelectElement
    // The mode chips and the size picker share the row, which was the point.
    expect(select.closest('.control-jog-config-row'))
      .toBe(screen.getByTestId('control-jog-continuous').closest('.control-jog-config-row'))
    // Every configured size is still an option - none was lost to save space.
    expect([...select.options].map((o) => o.value)).toEqual([
      '0.01', '0.1', '1', '10', '50', '100',
    ])

    useUiPrefs.setState({ machineJogStepMm: 1, machineJogContinuous: false })
    fireEvent.change(select, { target: { value: '10' } })
    expect(useUiPrefs.getState().machineJogStepMm).toBe(10)
    fireEvent.click(screen.getByTestId('control-jog-continuous'))
    expect(useUiPrefs.getState().machineJogContinuous).toBe(true)
  })

  // WO-957 RE-PIN: three-across became TWO-across when Operator removed the Off
  // buttons. The count moves; the property this test exists for does not - every
  // button still carries the shared sizing class so none can fall back to its
  // intrinsic width and wrap. (The original wrap this guarded was "Off" itself
  // going onto a ragged second line, which is now impossible for the happiest
  // of reasons.) Nothing is hidden: RPM and Coolant keep their labelled rows.
  // WO-964 RE-PIN: the two groups are NO LONGER equal - Operator kept Off on the
  // spindle and only the spindle, so it is three-across and coolant is
  // two-across. The property this test exists for is unchanged and is what is
  // still asserted: every button carries the shared sizing class, so none falls
  // back to its intrinsic width and wraps.
  it('spindle is three-across and coolant two-across, all sharing the sizing class', () => {
    const { container } = render(<SpindlePanel onOpenActions={() => {}} />)
    const groups = container.querySelectorAll('.control-spindle-btns')
    expect(groups.length).toBe(2)
    const counts = [...groups].map((g) => g.querySelectorAll('button').length)
    expect(counts).toEqual([3, 2])
    for (const group of groups) {
      const n = group.querySelectorAll('button').length
      expect(group.querySelectorAll('button.control-spindle-btn').length).toBe(n)
    }
    expect(screen.getByText('RPM')).toBeTruthy()
    // WO-1648: the "Coolant" label row over the Mist / Flood buttons is gone -
    // the panel title and the buttons' own words say what they are.
    expect(screen.queryByText('Coolant')).toBeNull()
    expect(screen.getByTestId('control-coolant-mist')).toBeTruthy()
    expect(screen.getByTestId('control-coolant-flood')).toBeTruthy()
    expect(screen.getByTestId('control-spindle-cw')).toBeTruthy()
    expect(screen.getByTestId('control-spindle-ccw')).toBeTruthy()
    expect(screen.getByTestId('control-spindle-off')).toBeTruthy()
  })
})
