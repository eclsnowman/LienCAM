// @vitest-environment jsdom
//
// WO-326 (Operator, card Q-THE-AMBER-THEME-SEE-ALL-OF-IT-AN-1786569820206,
// 2026-08-12, "even in your screenshots there is some residual blue. Look
// to tweak those to improve the Amber theme."): two named causes, two
// guards below, plus a third finding surfaced while fixing the first two.
//
//   1. viewportColors.ts cached every CSS custom property on first read and
//      never re-read it -- once WO-324 made the theme switchable at
//      runtime, an operator switching theme got a stale viewport until
//      reload. Fixed by tracking the data-theme attribute in resolve() and
//      dropping the whole cache the instant it moves. Proven live below
//      (jsdom inline-style stands in for "whatever getComputedStyle would
//      currently report" -- the same technique
//      src/tests/model3d/PushPullGizmo.test.tsx already uses, since jsdom
//      cannot flatten a var() chain from an external stylesheet).
//
//   2. Most scene colours (stock/workpiece/grid/canvas) were literals no
//      theme could reach -- fixed in tokens.css's amber block. Proven below
//      by parsing tokens.css TEXT directly (the technique
//      src/tests/theme/amberContrast.wo324.test.ts already established),
//      so this can never silently drift from what actually ships.
//
//   3. UNREQUESTED FINDING while auditing every var() chain a vp-* token
//      touches: --vp-axis-z secretly chained through --axis-z ->
//      --blue-500, which the amber block deliberately overrides for the
//      identity ramp. Fixing cause 1 would have newly exposed a real axis
//      regression (the Z axis repainting amber), violating this WO's
//      explicit "do not theme the axis colours" instruction. Pinned
//      --axis-z back to its literal default in tokens.css's amber block;
//      guarded below so a future tidy-up can't quietly remove the pin.

import { describe, it, expect, afterEach, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { asHex, refreshViewportColors } from '../../theme/viewportColors'

const TOKENS_PATH = 'src/theme/tokens.css'
const PROBE_TOKEN = '--vp-stock'

afterEach(() => {
  document.documentElement.removeAttribute('data-theme')
  document.documentElement.style.removeProperty(PROBE_TOKEN)
  refreshViewportColors()
})

describe('WO-326 cause 1: viewport re-reads its colours when the theme attribute changes', () => {
  it('the same accessor returns the default value, then the amber value, without reloading the module', () => {
    document.documentElement.style.setProperty(PROBE_TOKEN, '#2a5c8a') // default value
    expect(asHex(PROBE_TOKEN)).toBe('#2a5c8a')

    // A live theme switch: WO-324's applyUiTheme sets this attribute; the
    // browser's cascade would now compute the amber override, represented
    // here by moving the inline value at the same instant.
    document.documentElement.setAttribute('data-theme', 'amber')
    document.documentElement.style.setProperty(PROBE_TOKEN, '#8a662a') // amber value

    expect(asHex(PROBE_TOKEN)).toBe('#8a662a') // same accessor, same module, no reload
  })

  it('does NOT re-read on an unrelated property mutation -- only a theme-attribute change invalidates the cache', () => {
    document.documentElement.style.setProperty(PROBE_TOKEN, '#2a5c8a')
    expect(asHex(PROBE_TOKEN)).toBe('#2a5c8a')

    // Change the property without touching data-theme: the old cached
    // answer should still be served, proving this is a theme-scoped
    // invalidation, not "never cache anything."
    document.documentElement.style.setProperty(PROBE_TOKEN, '#123456')
    expect(asHex(PROBE_TOKEN)).toBe('#2a5c8a')
  })

  it('refreshViewportColors() still works as a manual escape hatch alongside the automatic re-read', () => {
    document.documentElement.style.setProperty(PROBE_TOKEN, '#2a5c8a')
    expect(asHex(PROBE_TOKEN)).toBe('#2a5c8a')
    document.documentElement.style.setProperty(PROBE_TOKEN, '#123456')
    refreshViewportColors()
    expect(asHex(PROBE_TOKEN)).toBe('#123456')
  })
})

// ---- Static CSS-cascade resolution (mirrors what a real browser computes) --
// Parses tokens.css TEXT directly and follows var() chains through a MERGED
// base+amber table -- exactly how the cascade resolves a var() reference at
// :root, so these tests can never silently drift from the shipped file.

function parseDeclarations(blockBody: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of blockBody.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    out[m[1]] = m[2].trim()
  }
  return out
}

function resolveToHex(name: string, table: Record<string, string>, seen: Set<string> = new Set()): string {
  if (seen.has(name)) throw new Error(`WO-326 test: circular var() chain at ${name}`)
  seen.add(name)
  const raw = table[name]
  if (raw === undefined) throw new Error(`WO-326 test: token not declared: ${name}`)
  if (/^#[0-9a-fA-F]{6}$/.test(raw)) return raw.toLowerCase()
  const varMatch = raw.match(/^var\((--[a-z0-9-]+)\)$/)
  if (varMatch) return resolveToHex(varMatch[1], table, seen)
  throw new Error(`WO-326 test: cannot resolve non-hex/var value for ${name}: "${raw}"`)
}

let baseVars: Record<string, string>
let amberOverrides: Record<string, string>
let amberVars: Record<string, string>

beforeAll(() => {
  const css = readFileSync(TOKENS_PATH, 'utf8')

  const baseMatch = css.match(/:root\s*\{([\s\S]*?)\n\}/)
  expect(baseMatch, 'base :root block not found in tokens.css').not.toBeNull()
  baseVars = parseDeclarations(baseMatch![1])

  const amberMatch = css.match(/:root\[data-theme="amber"\]\s*\{([\s\S]*?)\n\}/)
  expect(amberMatch, ':root[data-theme="amber"] block not found in tokens.css').not.toBeNull()
  amberOverrides = parseDeclarations(amberMatch![1])
  amberVars = { ...baseVars, ...amberOverrides }
})

describe('WO-326 acceptance: X/Y/Z axis colours are IDENTICAL under default and amber', () => {
  it.each(['--vp-axis-x', '--vp-axis-y', '--vp-axis-z'] as const)(
    '%s resolves to the exact same hex under default and amber',
    (token) => {
      const defaultHex = resolveToHex(token, baseVars)
      const amberHex = resolveToHex(token, amberVars)
      expect(amberHex, `${token}: default=${defaultHex} amber=${amberHex}`).toBe(defaultHex)
    },
  )

  it('regression guard: --axis-z genuinely chains through --blue-500 (which the amber block DOES override) -- proving the axis-z pin is load-bearing, not a no-op', () => {
    expect(baseVars['--axis-z']).toBe('var(--blue-500)')
    expect(amberVars['--blue-500']).not.toBe(baseVars['--blue-500'])
    // ...yet --vp-axis-z resolves identically either way (proven above),
    // because tokens.css's amber block re-pins --axis-z to its literal
    // default value rather than letting it inherit --blue-500's override.
    expect(amberOverrides['--axis-z']).toBe(baseVars['--blue-500'])
  })

  it('--axis-x and --axis-y needed no pin: they read primitives the amber block never touches', () => {
    expect(baseVars['--axis-x']).toBe('var(--red-500)')
    expect(baseVars['--axis-y']).toBe('var(--green-600)')
    expect(amberOverrides['--red-500']).toBeUndefined()
    expect(amberOverrides['--green-600']).toBeUndefined()
  })
})

describe('WO-326 cause 2: decorative scene colours are now wired to the token system', () => {
  it.each([
    '--vp-grid',
    '--vp-stock', '--vp-stock-edge', '--vp-workpiece', '--vp-workpiece-edge',
  ] as const)('%s has an amber override distinct from its default value', (token) => {
    expect(amberOverrides[token], `${token}: no amber override found`).toBeDefined()
    expect(amberOverrides[token]).not.toBe(baseVars[token])
  })

  it('keeps amber canvas neutral while the default canvas uses the deeper page well', () => {
    // WO-1151 (6a697f93b) deepened only the default canvas. Amber intentionally
    // retains the previous neutral reference instead of inheriting that change.
    expect(amberOverrides['--vp-canvas']).toBe('#111418')
    expect(baseVars['--vp-canvas']).toBe('#0d1117')
    expect(amberOverrides['--vp-canvas']).not.toBe(baseVars['--vp-canvas'])
  })

  it('--vp-grid-plane keeps the neutral default value under amber', () => {
    expect(amberOverrides['--vp-grid-plane']).toBeDefined()
    expect(amberOverrides['--vp-grid-plane']).toBe(baseVars['--vp-grid-plane'])
  })

  it('pins the current default decorative values after WO-1151 deepened the canvas', () => {
    expect(baseVars['--vp-canvas']).toBe('#0d1117')
    expect(baseVars['--vp-grid']).toBe('#2a2f36')
    expect(baseVars['--vp-grid-plane']).toBe('#141a22')
    expect(baseVars['--vp-stock']).toBe('#2a5c8a')
    expect(baseVars['--vp-stock-edge']).toBe('#4a9cd4')
    expect(baseVars['--vp-workpiece']).toBe('#8ab4cc')
    expect(baseVars['--vp-workpiece-edge']).toBe('#bfd8ec')
  })

  it('--vp-grid-accent needed no new wiring -- it already chains to the identity ramp', () => {
    expect(baseVars['--vp-grid-accent']).toBe('var(--role-identity-deep)')
    expect(amberOverrides['--vp-grid-accent']).toBeUndefined()
    expect(resolveToHex('--vp-grid-accent', amberVars)).not.toBe(resolveToHex('--vp-grid-accent', baseVars))
  })
})
