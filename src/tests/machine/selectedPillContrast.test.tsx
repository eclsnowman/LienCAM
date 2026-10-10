// @vitest-environment jsdom
//
// WO-102: selected-pill contrast (Operator note 2) — the measured contrast of
// the selected pill label against its fill, for the three pill groups Operator
// named: Position Auto (units selector), Work Offset G54/G55 (WCS chips),
// and Override percentage (rapid segments).
//
// WHY THIS TEST EXISTS (the bite): the fix (WO-067) changed
// .control-page .control-chip-active from `background: var(--surface-selected)`
// (blue #1a3a5c, 6.03:1 blue-on-blue) to `background: var(--surface-2)` (slate
// #1c2230, 8.23:1) AND added :disabled to the selector list so the disabled
// override (.control-chip-btn:disabled -> color: var(--text-muted)) cannot
// drop the selected label to 3.48:1 (--text-muted #7e8ea1 on the old
// --surface-selected #1a3a5c). The existing visualLanguage tests assert
// the TOKEN-level contrast (--text-active on --surface-2 >= 8) but do NOT tie
// the token to the CSS RULE — if someone reverts the rule back to
// --surface-selected, those tests still pass. THIS test reads the actual
// background token FROM the rule, resolves it, and asserts the contrast. It
// fails the moment the fill token changes.
//
// RED-first evidence: run against the pre-fix fill (var(--surface-selected))
// and the test reports 6.03:1 < 8 (FAIL). Restored to var(--surface-2) it
// reports 8.23:1 >= 8 (PASS). See the WO-102 result section for both transcripts.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'

const appCss = readFileSync('src/styles/app.css', 'utf8')
const tokensCss = readFileSync('src/theme/tokens.css', 'utf8')
const captureScript = readFileSync('src/tests/evidence/WO-102/capture.mjs', 'utf8')

// -- CSS rule extraction (full app.css, comments stripped) --

const cssNoComments = appCss.replace(/\/\*[\s\S]*?\*\//g, '')

/** Extract the body of a CSS rule whose selector list contains `selector`. */
function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`${escaped}[^{]*\\{([^}]*)\\}`, 'm').exec(cssNoComments)
  if (!match) throw new Error(`no CSS rule found for selector containing "${selector}"`)
  return match[1]
}

function decl(selector: string, property: string): string {
  const body = ruleBody(selector)
  const match = new RegExp(`(?:^|;)\\s*${property}\\s*:([^;]*)`, 'm').exec(body)
  if (!match) throw new Error(`"${selector}" has no ${property} declaration`)
  return match[1].trim()
}

// -- Token resolution (tokens.css var() chain -> hex) --

function resolveToken(css: string, token: string): string {
  const direct = new RegExp(`${token}:\\s*(#[0-9a-f]{6})`, 'i').exec(css)
  if (direct) return direct[1]
  const varMatch = new RegExp(`${token}:\\s*var\\((--[a-z0-9-]+)\\)`).exec(css)
  if (varMatch) return resolveToken(css, varMatch[1])
  throw new Error(`cannot resolve token ${token} in tokens.css`)
}

// -- WCAG contrast ratio --

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim())
  if (!m) throw new Error(`bad hex: ${hex}`)
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)]
}

function srgbToLinear(c: number): number {
  const s = c / 255
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
}

function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex)
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b)
}

function contrastRatio(fg: string, bg: string): number {
  const l1 = luminance(fg)
  const l2 = luminance(bg)
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
}

// -- The var() extractor: pulls the token name from a `var(--xxx)` value --

function extractVarToken(value: string): string {
  const m = /var\((--[a-z0-9-]+)\)/i.exec(value)
  if (!m) throw new Error(`expected a var() token, got: ${value}`)
  return m[1]
}

// -- The three pill groups Operator named all share .control-chip-active when
//    selected. The fill+label tokens are the same for all three, so one
//    measured ratio covers all three groups. --

const CHIP_ACTIVE_SELECTOR = '.control-page .control-chip-active'
const LABEL_TOKEN = '--text-active'

describe('WO-102 note 2: measured contrast of selected pill text against its fill', () => {
  it('the chip-active fill token is --surface-2 (the WO-067 fix), not --surface-selected (the pre-fix blue glow)', () => {
    const bgDecl = decl(CHIP_ACTIVE_SELECTOR, 'background')
    expect(bgDecl).toBe('var(--surface-2)')
    // Document what the pre-fix rule (bare .control-chip-active at the top of
    // app.css) still carries — it is overridden by specificity on the Control
    // page, but its continued presence is why this test ties the token to the
    // .control-page-scoped rule, not the bare one.
    const bareBg = decl('.control-chip-active', 'background')
    expect(bareBg).toBe('var(--surface-selected)')
  })

  it('the :disabled selector is in the chip-active rule list (prevents the 3.48:1 muted override)', () => {
    const body = ruleBody('.control-page .control-chip-active:disabled')
    expect(body).toContain('var(--text-active)')
    expect(body).toContain('var(--surface-2)')
    expect(body).toContain('box-shadow')
  })

  it('MEASURED: --text-active on the ACTUAL rule fill meets 4.5:1 (WCAG AA)', () => {
    const bgDecl = decl(CHIP_ACTIVE_SELECTOR, 'background')
    const bgToken = extractVarToken(bgDecl)
    const bgHex = resolveToken(tokensCss, bgToken)
    const labelHex = resolveToken(tokensCss, LABEL_TOKEN)
    const ratio = contrastRatio(labelHex, bgHex)
    console.log(`WO-102 contrast: ${labelHex} on ${bgHex} (from ${bgToken}) = ${ratio.toFixed(2)}:1`)
    expect(ratio).toBeGreaterThanOrEqual(4.5)
  })

  it('MEASURED: --text-active on the ACTUAL rule fill meets 8:1 (WCAG AAA) — the threshold that bites on revert', () => {
    const bgDecl = decl(CHIP_ACTIVE_SELECTOR, 'background')
    const bgToken = extractVarToken(bgDecl)
    const bgHex = resolveToken(tokensCss, bgToken)
    const labelHex = resolveToken(tokensCss, LABEL_TOKEN)
    const ratio = contrastRatio(labelHex, bgHex)
    console.log(`WO-102 AAA check: ${labelHex} on ${bgHex} = ${ratio.toFixed(2)}:1 (threshold 8)`)
    expect(ratio).toBeGreaterThanOrEqual(8)
  })

  it('REGRESSION PROOF: the pre-fix fill (--surface-selected) gives only 6.03:1 (fails the 8:1 AAA threshold)', () => {
    const preFixFill = resolveToken(tokensCss, '--surface-selected')
    const labelHex = resolveToken(tokensCss, LABEL_TOKEN)
    const ratio = contrastRatio(labelHex, preFixFill)
    console.log(`WO-102 pre-fix proof: ${labelHex} on ${preFixFill} (--surface-selected) = ${ratio.toFixed(2)}:1`)
    expect(ratio).toBeLessThan(8)
    expect(ratio).toBeGreaterThanOrEqual(4.5) // still passes AA, but Operator's "colors too similar" is the hue issue
  })

  it('REGRESSION GUARD: --text-muted on --surface-selected stays AA at the new 4.64:1', () => {
    const mutedHex = resolveToken(tokensCss, '--text-muted')
    const preFixFill = resolveToken(tokensCss, '--surface-selected')
    const ratio = contrastRatio(mutedHex, preFixFill)
    // WO-1126 recorded this pairing at 3.48:1. WO-1151 lifted --slate-400,
    // so the old "must fail AA" premise is retired in the good direction;
    // the threshold remains and now fails if the pairing regresses below AA.
    console.log(`WO-1160 disabled guard: ${mutedHex} on ${preFixFill} = ${ratio.toFixed(2)}:1 (passes 4.5 AA)`)
    expect(ratio).toBeGreaterThanOrEqual(4.5)
  })
})

describe('WO-102 note 1: Back/Step buttons in the MOMENTARY family', () => {
  it('.control-step-btn uses --surface-2 fill (same family surface as transport neighbors)', () => {
    expect(decl('.control-page .control-step-btn', 'background')).toBe('var(--surface-2)')
  })

  it('.control-step-btn uses border-strong + 6px corner (MOMENTARY geometry)', () => {
    expect(decl('.control-page .control-step-btn', 'border-radius')).toBe('6px')
    expect(decl('.control-page .control-step-btn', 'border')).toContain('var(--border-strong)')
  })

  it('.control-step-btn uses text-secondary at rest (quiet, not lit)', () => {
    expect(decl('.control-page .control-step-btn', 'color')).toBe('var(--text-secondary)')
  })
})

describe('WO-102 note 3: single-block explainer lives next to its button', () => {
  it('the explainer span carries data-testid="control-singleblock-explainer"', () => {
    // Code-level assertion: the ControlStepRow renders the explainer with
    // this testid immediately after the Step button. The pixel capture in
    // src/tests/evidence/WO-102/ confirms it visually.
    const tsx = readFileSync('src/components/machine/ControlTransportBar.tsx', 'utf8')
    expect(tsx).toContain('data-testid="control-singleblock-explainer"')
    expect(tsx).toContain('control-mode-explainer')
  })
})

describe('WO-122 capture contract: filenames bind exact named subjects and states', () => {
  it('binds Position Auto, Work Offset G54, and Override Rapid 100% by exact testid and label', () => {
    expect(captureScript).toContain("positionAuto: { selector: '[data-testid=\"control-units-auto\"]', text: 'Auto' }")
    expect(captureScript).toContain("workOffsetG54: { selector: '[data-testid=\"control-wcs-g54\"]', text: 'G54' }")
    expect(captureScript).toContain("overrideRapid100: { selector: '[data-testid=\"control-ovr-rapid-100\"]', text: '100%' }")
    expect(captureScript).not.toContain('[data-testid="control-units-chips"] button.control-chip-active')
    expect(captureScript).not.toContain('[data-testid="control-ovr-rapid"] button.control-chip-active')
  })

  it('binds and measures both Back and Step for note 1', () => {
    expect(captureScript).toContain("back: measure('[data-testid=\"control-step-back\"]')")
    expect(captureScript).toContain("step: measure('[data-testid=\"control-step-forward\"]')")
    expect(captureScript).toContain("buttonPasses(r.back, 'Back') && buttonPasses(r.step, 'Step')")
  })

  it('captures a genuine pre-fix/fixed pixel pair with distinct required fill tokens', () => {
    expect(captureScript).toContain("'note2-selected-pills-before.png'")
    expect(captureScript).toContain("backgroundToken: '--surface-selected'")
    expect(captureScript).toContain("'note2-selected-pills-after.png'")
    expect(captureScript).toContain("backgroundToken = '--surface-2'")
  })
})

// -- WO-102 note 2 (binding): the three named pill groups Operator named (Position
//    Auto, Work Offset G54/G55, Override percentage) must actually APPLY
//    control-chip-active when selected, and no later/higher-specificity CSS
//    rule may quietly redirect the selected fill/label. The token-level
//    contrast tests above tie the RULE to the tokens; these tests tie the
//    named COMPONENTS to that rule and guard the cascade. --

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

const { OverridePanel } = await import('../../components/machine/OverridePanel')
const { OffsetsPanel } = await import('../../components/machine/OffsetsPanel')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useUiPrefs } = await import('../../store/uiPrefs')

afterEach(cleanup)

describe('WO-102 note 2 (binding): the three named pill groups apply control-chip-active when selected', () => {
  beforeEach(() => {
    useUiPrefs.setState({ machineOffsetsCollapsed: false })
    useMachineControl.setState({
      connectionPhase: 'connected',
      machineState: 'idle',
      activeWcs: 'G54',
      overrides: { feed: 100, rapid: 100, spindle: 100 },
      offsets: { G54: [0, 0, 0] },
    })
  })

  it('Position Auto (units) chip binds control-chip-active for unitsPref==="default" inside the units-chips group', () => {
    // Code-level binding: ControlPage applies control-chip-active to the
    // Auto units chip when machineDisplayUnits === 'default'. Fails if a
    // later change stops applying the selected class to this named pill.
    const tsx = readFileSync('src/components/machine/ControlPage.tsx', 'utf8')
    expect(tsx).toContain('data-testid="control-units-chips"')
    expect(tsx).toContain('data-testid="control-units-auto"')
    expect(tsx).toContain("unitsPref === 'default' ? 'control-chip-active' : ''")
  })

  it('Work Offset G54 (WCS) chip carries control-chip-active when activeWcs==="G54"', () => {
    render(<OffsetsPanel />)
    const g54 = screen.getByTestId('control-wcs-g54')
    expect(g54.className).toContain('control-chip-active')
    // A non-active system does NOT carry it (exactly one selected).
    expect(screen.getByTestId('control-wcs-g55').className).not.toContain('control-chip-active')
  })

  it('Override rapid 100% segment carries control-chip-active when overrides.rapid===100', () => {
    render(<OverridePanel />)
    const rapid100 = screen.getByTestId('control-ovr-rapid-100')
    expect(rapid100.textContent).toBe('100%')
    expect(rapid100.className).toContain('control-chip-active')
    expect(screen.getByTestId('control-ovr-rapid-50').className).not.toContain('control-chip-active')
  })
})

// -- Cascade guard: the highest-specificity non-state rule that targets
//    .control-chip-active MUST keep the --surface-2 / --text-active fill, so
//    a later higher-specificity rule cannot quietly change the selected
//    contrast. --

function specificity(selector: string): [number, number] {
  // [idCount, classCount] - sufficient for these class-based selectors (no
  // element selectors appear in the control-chip-active rules).
  const idCount = (selector.match(/#[\w-]+/g) || []).length
  const classCount = (selector.match(/\.[\w-]+/g) || []).length
  return [idCount, classCount]
}

function allChipActiveSelectors(): Array<{ selector: string; body: string }> {
  // Parse flat rules (selector-list { body }), then split each selector list by
  // commas so a multi-selector rule (the WO-067 fix groups chip-active +
  // :disabled + latched) is evaluated per individual selector. The control-
  // chip-active rules are top-level (no @media nesting), so the flat regex is
  // sufficient.
  const out: Array<{ selector: string; body: string }> = []
  const re = /([^{}]+)\{([^{}]*)\}/g
  let m: RegExpExecArray | null
  while ((m = re.exec(cssNoComments))) {
    const list = m[1].trim()
    const body = m[2]
    for (const sel of list.split(',')) {
      const s = sel.trim()
      if (s.includes('control-chip-active')) out.push({ selector: s, body })
    }
  }
  return out
}

function winningChipActiveSelector() {
  // State variants (:hover, :disabled) only apply in those states; exclude
  // them so the winner is the rule that applies to a selected, non-hovered,
  // non-disabled pill.
  const base = allChipActiveSelectors().filter(
    (r) => !r.selector.includes(':hover') && !r.selector.includes(':disabled'),
  )
  if (base.length === 0) throw new Error('no non-state .control-chip-active selector found')
  let winner = base[0]
  for (const r of base) {
    if (specificity(r.selector) > specificity(winner.selector)) winner = r
  }
  return { winner, base }
}

describe('WO-102 note 2 (cascade guard): no higher-specificity rule redirects the selected fill/label', () => {
  it('the winning non-state selector for .control-chip-active is .control-page .control-chip-active', () => {
    const { winner } = winningChipActiveSelector()
    expect(winner.selector).toBe('.control-page .control-chip-active')
  })

  it('the winning rule fill is --surface-2 and label is --text-active (measured >= 8:1)', () => {
    const { winner } = winningChipActiveSelector()
    const bgMatch = /(?:^|;)\s*background\s*:([^;]*)/m.exec(winner.body)
    const colorMatch = /(?:^|;)\s*color\s*:([^;]*)/m.exec(winner.body)
    expect(bgMatch).toBeTruthy()
    expect(colorMatch).toBeTruthy()
    const bgToken = extractVarToken(bgMatch![1].trim())
    const colorToken = extractVarToken(colorMatch![1].trim())
    expect(bgToken).toBe('--surface-2')
    expect(colorToken).toBe('--text-active')
    const bgHex = resolveToken(tokensCss, bgToken)
    const labelHex = resolveToken(tokensCss, colorToken)
    const ratio = contrastRatio(labelHex, bgHex)
    console.log(`WO-102 cascade guard: winning ${winner.selector} -> ${labelHex} on ${bgHex} = ${ratio.toFixed(2)}:1`)
    expect(ratio).toBeGreaterThanOrEqual(8)
  })

  it('no non-state selector with specificity >= the winner declares a different background or label', () => {
    // A later/equal-specificity rule that redirects the selected fill or label
    // would change the computed contrast without flipping the token the
    // winner-level test reads. This guard fails in that case. The intentional
    // bare .control-chip-active pre-fix rule is LOWER specificity (0,1,0) so
    // it is allowed to keep --surface-selected as the overridden baseline.
    const { winner, base } = winningChipActiveSelector()
    const winSpec = specificity(winner.selector)
    for (const r of base) {
      if (specificity(r.selector) < winSpec) continue
      const bgMatch = /(?:^|;)\s*background\s*:([^;]*)/m.exec(r.body)
      const colorMatch = /(?:^|;)\s*color\s*:([^;]*)/m.exec(r.body)
      if (bgMatch) expect(extractVarToken(bgMatch[1].trim())).toBe('--surface-2')
      if (colorMatch) expect(extractVarToken(colorMatch[1].trim())).toBe('--text-active')
    }
  })
})
