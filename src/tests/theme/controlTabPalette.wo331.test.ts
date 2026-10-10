// WO-354: jog controls use one theme-derived family with structural axis
// differentiation. The later WO-331 section still protects the separate
// overrides-chip palette work that WO-354 did not supersede.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const TOKENS = 'src/theme/tokens.css'
const APP = 'src/styles/app.css'

const tokensCss = readFileSync(TOKENS, 'utf8')
const appCss = readFileSync(APP, 'utf8')

/** Resolve a token through its var() chain to a literal hex, base :root only
 *  (never the high-contrast/amber theme override blocks). */
function resolve(token: string, seen = new Set<string>()): string {
  if (seen.has(token)) throw new Error(`token cycle at ${token}`)
  seen.add(token)
  const base = tokensCss.slice(0, tokensCss.indexOf(':root[data-theme='))
  const direct = new RegExp(`${token}:\\s*(#[0-9a-fA-F]{6})`).exec(base)
  if (direct) return direct[1].toLowerCase()
  const chained = new RegExp(`${token}:\\s*var\\((--[a-z0-9-]+)\\)`).exec(base)
  if (chained) return resolve(chained[1], seen)
  throw new Error(`cannot resolve ${token} in ${TOKENS}`)
}

// ---- WCAG 2.1 contrast, the same formula colorRoles.wo269.test.ts uses ----
function toRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}
function srgbToLinear(byte: number): number {
  const c = byte / 255
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}
function luminance(hex: string): number {
  const [r, g, b] = toRgb(hex)
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b)
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}
/** Extract the FIRST `{...}` body following an exact selector pattern. The
 *  regex must not match a longer selector sharing the same prefix (e.g.
 *  `.control-jog-zbtn:hover...`) - callers rely on requiring `{` to follow
 *  immediately (only whitespace between), which a pseudo-class suffix
 *  breaks by construction. */
function ruleBody(pattern: RegExp): string {
  const m = pattern.exec(appCss)
  if (!m) throw new Error(`rule not found for pattern: ${pattern}`)
  return m[1]
}

const HEX_OR_RGB_LITERAL = /#[0-9a-fA-F]{3,6}\b|rgba?\(\s*\d/

describe('WO-354: jog differentiation is structural and theme-derived', () => {
  // There is an earlier layout-only .control-jog-cluster rule. Requiring the
  // first declaration to be the WO-354 variable selects the visual contract.
  const cluster = ruleBody(/\n\.control-jog-cluster\s*\{\s*(--jog-rest-fill:[^}]*)\}/)
  const face = ruleBody(/\n\.control-jog-face\s*\{([^}]*)\}/)
  const rails = ruleBody(/\n\.control-jog-rails\s*\{([^}]*)\}/)
  const wedge = ruleBody(/\n\.control-jog-wedge\s*\{([^}]*)\}/)
  const zButton = ruleBody(/\n\.control-jog-zbtn\s*\{([^}]*)\}/)

  it('derives rest, hover and pressed colors from semantic theme roles', () => {
    expect(cluster).toMatch(/--jog-rest-fill:\s*color-mix\([^;]*var\(--role-primary-fill\)/)
    expect(cluster).toMatch(/--jog-rest-edge:\s*var\(--role-identity\)/)
    expect(cluster).toMatch(/--jog-rest-rail:\s*var\(--role-identity-light\)/)
    expect(cluster).toMatch(/--jog-hover-edge:\s*var\(--role-focus\)/)
    expect(cluster).toMatch(/--jog-hover-rail:\s*var\(--role-live\)/)
    expect(cluster).toMatch(/--jog-active-fill:\s*var\(--role-primary-fill\)/)
    expect(cluster).toMatch(/--jog-active-label:\s*var\(--text-on-accent\)/)
  })

  it('paints every axis through the same face and rail variables', () => {
    expect(face).toMatch(/fill:\s*var\(--jog-fill\)/)
    expect(face).toMatch(/stroke:\s*var\(--jog-edge\)/)
    expect(rails).toMatch(/stroke:\s*var\(--jog-rail\)/)
    expect(rails).toMatch(/stroke-linecap:\s*round/)
    expect(wedge).toMatch(/background:\s*transparent/)
    expect(zButton).toMatch(/background:\s*transparent/)
    for (const body of [cluster, face, rails, wedge, zButton]) {
      expect(body).not.toMatch(/var\(--(?:axis-[xyz]|green-|violet-)/)
    }
  })

  it('keeps the approved rounded plates and optical Z label nudge', () => {
    const label = ruleBody(/\n\.control-jog-label\s*\{([^}]*)\}/)
    const zLabel = ruleBody(/\n\.control-jog-zbtn > \.control-jog-label\s*\{([^}]*)\}/)
    const zMinusLabel = ruleBody(/\n\.control-jog-zbtn\[data-testid="control-jog-z-minus"\] > \.control-jog-label\s*\{([^}]*)\}/)
    expect(label).toMatch(/border-radius:\s*6px/)
    expect(zButton).toMatch(/border-radius:\s*14px/)
    expect(zLabel).toMatch(/top:\s*calc\(50% \+ 1\.5px\)/)
    expect(zMinusLabel).toMatch(/top:\s*calc\(50% - 1\.5px\)/)
  })

  it('keeps the Z host transparent instead of inheriting shared motion-green states', () => {
    const zStates = ruleBody(/\n\.control-jog-zbtn:hover:not\(:disabled\),\s*\n\.control-jog-zbtn:active:not\(:disabled\),\s*\n\.control-jog-zbtn:disabled\s*\{([^}]*)\}/)
    expect(zStates).toMatch(/border:\s*0/)
    expect(zStates).toMatch(/background:\s*transparent/)
    expect(zStates).toMatch(/color:\s*var\(--jog-label\)/)
    expect(zStates).not.toMatch(/var\(--green-/)
  })

  it('contains no raw color or legacy motion-green declaration in the shipped jog-axis block', () => {
    const start = appCss.indexOf('/* WO-354: rounded theme-derived jog plates.')
    const end = appCss.indexOf('.control-jog-sidebtn {', start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const region = appCss.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, '')
    expect(region).not.toMatch(HEX_OR_RGB_LITERAL)
    expect(region).not.toMatch(/var\(--(?:axis-[xyz]|green-|violet-)/)
  })
})

describe('WO-331: the overrides "100%" indicators are one palette family', () => {
  const RAPID_ACTIVE_PATTERN =
    /\[data-testid="control-ovr-rapid"\] \.control-chip-active,\s*\n\[data-testid="control-ovr-rapid"\] \.control-chip-active:disabled\s*\{([^}]*)\}/

  it('the Rapid active segment is scoped to its data-testid group, never the bare LATCHING chip class', () => {
    // Must exist and must NOT be reachable through plain .control-chip-active
    // alone - that would repaint every other latched chip on the Control tab
    // (WCS, Step/Continuous, Single Block), which is out of this WO's scope.
    const body = ruleBody(RAPID_ACTIVE_PATTERN)
    // f94de6fc5 moved all three override readouts from live cyan onto the
    // standard DRO blue family; --accent is the current identity-family alias.
    expect(body, body).toMatch(/border-color:\s*var\(--accent\)/)
    expect(body, body).toMatch(/color:\s*var\(--accent\)/)
    expect(HEX_OR_RGB_LITERAL.test(body), body).toBe(false)
  })

  // AUDIT (attempt 1): the first shape of this rule scoped through
  // ".control-page .control-ovr-seg.control-chip-active" - stacking a class
  // directly onto .control-chip-active - which put it at 3 classes and
  // outranked WO-102's cascade guard (selectedPillContrast.test.tsx), whose
  // protected winner is ".control-page .control-chip-active" at 2 classes.
  // That guard file is not in this WO's owned-paths, so the fix has to hold
  // from this side: reproduce the guard's own [idCount, classCount]
  // specificity method here and pin that the Rapid rule stays below the
  // guarded winner's class count, so this is caught locally if it regresses.
  it('the Rapid active-segment selector does not outrank WO-102\'s cascade guard', () => {
    const specificity = (selector: string): [number, number] => {
      const idCount = (selector.match(/#[\w-]+/g) || []).length
      const classCount = (selector.match(/\.[\w-]+/g) || []).length
      return [idCount, classCount]
    }
    const [, guardedWinnerClasses] = specificity('.control-page .control-chip-active')
    const [, rapidClasses] = specificity('[data-testid="control-ovr-rapid"] .control-chip-active')
    expect(rapidClasses, 'must stay below the guarded winner\'s class count').toBeLessThan(guardedWinnerClasses)
  })

  it('Feed and Spindle use the same standard DRO blue alias as Rapid', () => {
    const body = ruleBody(/\.control-ovr-value-input\s*\{([^}]*)\}/)
    expect(body, body).toMatch(/border:\s*1px solid var\(--accent\)/)
    expect(body, body).toMatch(/color:\s*var\(--accent\)/)
  })

  it('the unified family colour clears the 3:1 non-text floor against --surface-2 (the chip fill)', () => {
    const live = resolve('--accent')
    const surface2 = resolve('--slate-850') // --surface-2
    const ratio = contrast(live, surface2)
    expect(ratio, `${live} on ${surface2} measured ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(3)
  })
})
