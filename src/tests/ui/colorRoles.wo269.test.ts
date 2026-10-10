// WO-269: one blue, and every use of it means something.
//
// Operator ruling 2026-08-12: "We have several blues currently and sometimes they clash
// or look out of place to one another... the number of blues we have varies a
// lot and the meaning of the different glows and blue on black which with blue
// glow, etc can be confusing."
//
// The tidy-up itself is a one-time act. THIS FILE is what stops the sprawl
// growing back: the app chrome may not contain a blue/cyan literal anywhere
// except the seven identity-ramp declarations in src/theme/tokens.css, and
// every role has to keep clearing the contrast floor it met before.
//
// Node env, no DOM: it parses the shipped stylesheet TEXT, so it can never
// drift from what actually ships the way a hand-copied table could.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const TOKENS = 'src/theme/tokens.css'
const APP = 'src/styles/app.css'
const APP_OVERRIDE = 'src/app.css'
const HARD_CODED_THEME_FIXTURE = 'src/tests/ui/fixtures/hardCodedBlueTheme.fixture.css'

// ---------------------------------------------------------------------------
// What counts as "a blue"
// ---------------------------------------------------------------------------
// Hue 180-232 (cyan through indigo) with real chroma. The saturation floor
// deliberately excludes the neutral slate ramp (--slate-*, sat <= 33), which is
// a surface/text ramp rather than an accent, and the lightness floor excludes
// near-black page surfaces. This is the same rule the WO's own before/after
// count was measured with.
const HUE_MIN = 180
const HUE_MAX = 232
const SAT_MIN = 35
const LUM_MIN = 18
const LUM_MAX = 95

function toRgb(hex: string): [number, number, number] {
  let h = hex.replace('#', '')
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}

function toHsl(r: number, g: number, b: number): [number, number, number] {
  const R = r / 255, G = g / 255, B = b / 255
  const max = Math.max(R, G, B), min = Math.min(R, G, B)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l * 100]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h: number
  if (max === R) h = (G - B) / d + (G < B ? 6 : 0)
  else if (max === G) h = (B - R) / d + 2
  else h = (R - G) / d + 4
  return [(h / 6) * 360, s * 100, l * 100]
}

function isBlue(rgb: [number, number, number]): boolean {
  const [h, s, l] = toHsl(...rgb)
  return h >= HUE_MIN && h <= HUE_MAX && s >= SAT_MIN && l >= LUM_MIN && l <= LUM_MAX
}

/** Blank out CSS comments, preserving line numbering. */
function stripComments(src: string): string {
  let out = ''
  let inComment = false
  for (let i = 0; i < src.length; i++) {
    if (!inComment && src[i] === '/' && src[i + 1] === '*') { inComment = true; i++; out += '  '; continue }
    if (inComment && src[i] === '*' && src[i + 1] === '/') { inComment = false; i++; out += '  '; continue }
    out += inComment ? (src[i] === '\n' ? '\n' : ' ') : src[i]
  }
  return out
}

interface Literal { file: string; line: number; value: string; decl: string | null; text: string }

/** Every blue/cyan colour literal in a stylesheet, with the token it declares. */
function blueLiterals(file: string, opts: { skipFrom?: RegExp } = {}): Literal[] {
  const raw = readFileSync(file, 'utf8')
  const code = stripComments(raw).split(/\r?\n/)
  const original = raw.split(/\r?\n/)
  const cutoff = opts.skipFrom
    ? original.findIndex((l) => opts.skipFrom!.test(l))
    : -1
  const found: Literal[] = []
  code.forEach((line, i) => {
    if (cutoff >= 0 && i >= cutoff) return
    const declMatch = /^\s*(--[a-z0-9-]+)\s*:/.exec(line)
    const decl = declMatch ? declMatch[1] : null
    for (const m of line.matchAll(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g)) {
      if (isBlue(toRgb(m[0]))) found.push({ file, line: i + 1, value: m[0].toLowerCase(), decl, text: original[i].trim() })
    }
    for (const m of line.matchAll(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/g)) {
      const rgb: [number, number, number] = [+m[1], +m[2], +m[3]]
      if (isBlue(rgb)) found.push({ file, line: i + 1, value: `rgb(${rgb.join(',')})`, decl, text: original[i].trim() })
    }
  })
  return found
}

// ---------------------------------------------------------------------------
// The role vocabulary
// ---------------------------------------------------------------------------
// One meaning each. docs/ui-ux/COLOR-ROLES.md is the prose version; this is the
// enforced version.
const ROLES = [
  '--role-identity',
  '--role-identity-light',
  '--role-identity-deep',
  '--role-primary-fill',
  '--role-selection',
  '--role-focus',
  '--role-live',
  '--role-inert',
] as const

/** The identity ramp: the ONLY declarations allowed to hold a blue literal. */
const IDENTITY_RAMP = [
  '--blue-300', '--blue-400', '--blue-500', '--blue-600',
  '--blue-800', '--blue-900', '--cyan-400',
]

// Out of WO-269's scope by the work order's own words ("Not in scope: ... the
// 3D viewport's own colours"): scene furniture, sketch entities and the
// toolpath role hues keep their own literals and are checked elsewhere.
// WO-1258: technical drawings have their own ink, separate from chrome.
// Only these exact declaration/value pairs join the census exceptions.
const DIAGRAM_INK = new Set([
  '--diagram-ground:#eaf0f5',
  '--diagram-profile-fill:rgb(55,91,117)',
  '--diagram-diameter-extension:#3578a8',
  '--diagram-diameter-line:#4af',
  '--diagram-diameter-label:#6bf',
  '--diagram-diameter-extension:#527c9c',
  '--diagram-diameter-line:#145e95',
  '--diagram-diameter-label:#125785',
  '--diagram-shank-dimension:#3d617c',
  '--diagram-outline:#375b75',
  '--diagram-coating-none-outline:#375b75',
])

const NON_CHROME_PALETTE = /^--(vp-|sketch-|hue-|loop-blue$|gold-|axis-)/

const tokensCss = readFileSync(TOKENS, 'utf8')

function resolve(token: string, seen = new Set<string>()): string {
  if (seen.has(token)) throw new Error(`token cycle at ${token}`)
  seen.add(token)
  // Base :root only - never the high-contrast override block.
  const base = tokensCss.slice(0, tokensCss.indexOf(':root[data-theme='))
  const direct = new RegExp(`${token}:\\s*(#[0-9a-fA-F]{6})`).exec(base)
  if (direct) return direct[1].toLowerCase()
  const chained = new RegExp(`${token}:\\s*var\\((--[a-z0-9-]+)\\)`).exec(base)
  if (chained) return resolve(chained[1], seen)
  throw new Error(`cannot resolve ${token} in ${TOKENS}`)
}

// ---- WCAG 2.1, the same formula as docs/ui-ux/identity-study/tools/contrast.mjs
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

function compositeOver(foreground: string, background: string, alpha: number): string {
  const foregroundRgb = toRgb(foreground)
  const backgroundRgb = toRgb(background)
  const mixed = foregroundRgb.map((channel, index) =>
    Math.round(channel * alpha + backgroundRgb[index] * (1 - alpha)),
  )
  return `#${mixed.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`
}

const SURFACE_1 = '#161b22' // --surface-1, the dominant panel background

describe('WO-269: the blue sprawl cannot grow back', () => {
  it('src/styles/app.css contains no blue/cyan literal at all - every blue is a role', () => {
    const strays = blueLiterals(APP)
    expect(
      strays.map((s) => `${s.file}:${s.line}  ${s.value}  ${s.text}`),
      'a raw blue was reintroduced; use a --role-* token (docs/ui-ux/COLOR-ROLES.md)',
    ).toEqual([])
  })

  it('src/app.css contains no blue/cyan literal at all', () => {
    const strays = blueLiterals(APP_OVERRIDE)
    expect(strays.map((s) => `${s.file}:${s.line}  ${s.value}  ${s.text}`)).toEqual([])
  })

  it('in tokens.css every chrome blue literal, including theme overrides, stays in the identity ramp', () => {
    // Scan the WHOLE file. Theme blocks live below the viewport palette, so
    // stopping at the VIEWPORT SCENE marker made the old guard blind to the
    // exact failure WO-1126 names: a theme hard-coding a semantic role.
    const strays = blueLiterals(TOKENS).filter(
      (s) => !(s.decl && (IDENTITY_RAMP.includes(s.decl) || NON_CHROME_PALETTE.test(s.decl) || DIAGRAM_INK.has(`${s.decl}:${s.value}`))),
    )
    expect(
      strays.map((s) => `${s.file}:${s.line}  ${s.value}  ${s.text}`),
      'a blue literal escaped the identity ramp; give it a role instead',
    ).toEqual([])
  })

  it('rejects the fixture theme that hard-codes a semantic blue', () => {
    const strays = blueLiterals(HARD_CODED_THEME_FIXTURE)
    expect(strays.map(({ decl, value }) => ({ decl, value }))).toEqual([
      { decl: '--role-identity', value: '#2388ff' },
    ])
  })

  it('every identity-ramp step is declared exactly once per theme context', () => {
    // The mode axis adds contexts, not duplicate declarations within a context.
    const blocks = [...stripComments(tokensCss).matchAll(/(:root[^{}]*)\{([^{}]*)\}/g)]
    expect(blocks.length).toBeGreaterThanOrEqual(5)
    for (const [ , selector, body] of blocks) {
      for (const step of IDENTITY_RAMP) {
        const hits = body.match(new RegExp(`^\\s*${step}\\s*:`, 'gm')) ?? []
        expect(hits.length, `${selector.trim()}: ${step}`).toBeLessThanOrEqual(1)
        if (selector.includes('data-color-mode="light"')) {
          expect(hits.length, `${selector.trim()}: missing light identity value ${step}`).toBe(1)
        }
      }
    }
  })
})

describe('WO-269: the roles exist and each one means exactly one thing', () => {
  it('every role is declared once in the base palette and resolves to a real colour', () => {
    for (const role of ROLES) {
      const hits = tokensCss.match(new RegExp(`^\\s*${role}\\s*:`, 'gm')) ?? []
      expect(hits.length, `${role} must be declared exactly once`).toBe(1)
      expect(resolve(role)).toMatch(/^#[0-9a-f]{6}$/)
    }
  })

  it('no two roles resolve to the same colour - a duplicate role is sprawl with a new name', () => {
    const byValue = new Map<string, string[]>()
    for (const role of ROLES) {
      const v = resolve(role)
      byValue.set(v, [...(byValue.get(v) ?? []), role])
    }
    const collisions = [...byValue.entries()].filter(([, names]) => names.length > 1)
    expect(collisions.map(([v, names]) => `${v}: ${names.join(' == ')}`)).toEqual([])
  })

  it('the semantic tokens the app already consumed now point at roles, not at their own hex', () => {
    // These are the names ~200 call sites use. If any of them grows its own
    // literal again, the single source of truth is gone.
    const consumers: Record<string, string> = {
      '--accent': '--role-identity',
      '--accent-strong': '--role-primary-fill',
      '--focus-ring': '--role-focus',
      '--text-active': '--role-identity-light',
      '--border-accent': '--role-identity-deep',
      '--surface-selected': '--role-selection',
      '--status-computing': '--role-live',
    }
    for (const [token, role] of Object.entries(consumers)) {
      expect(tokensCss, `${token} must reference ${role}`).toMatch(
        new RegExp(`${token}:\\s*var\\(${role}\\)`),
      )
    }
  })
})

describe('WO-269: no contrast regression (measured, not eyeballed)', () => {
  it('roles used as small text clear the 4.5:1 body floor on --surface-1', () => {
    for (const role of ['--role-identity', '--role-identity-light', '--role-focus', '--role-live']) {
      const ratio = contrast(resolve(role), SURFACE_1)
      expect(ratio, `${role} = ${resolve(role)} is ${ratio.toFixed(2)}:1 on --surface-1`)
        .toBeGreaterThanOrEqual(4.5)
    }
  })

  it('white text on --role-primary-fill clears the 4.5:1 body floor', () => {
    const ratio = contrast('#ffffff', resolve('--role-primary-fill'))
    expect(ratio, `white on primary fill is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5)
  })

  it('--role-identity-light stays readable on the two blue fills it is used over', () => {
    const light = resolve('--role-identity-light')
    // Active tab label on the selected-row wash, and the toolbar primary hover.
    expect(contrast(light, resolve('--role-selection'))).toBeGreaterThanOrEqual(4.5)
    expect(contrast(light, resolve('--role-identity-deep'))).toBeGreaterThanOrEqual(4.5)
  })

  it('--role-identity-deep is an EDGE colour: it must never be bright enough to pass as text', () => {
    // Stated as a floor test in reverse - this is what stops a future edit
    // "fixing" the deep step by brightening it into the base step's job.
    expect(contrast(resolve('--role-identity-deep'), SURFACE_1)).toBeLessThan(3)
  })

  it('focus stays visually distinguishable from selection (accessibility, not taste)', () => {
    const focus = resolve('--role-focus')
    const selection = resolve('--role-selection')
    // They differ in form (a ring vs a background wash) AND in luminance.
    expect(focus).not.toBe(selection)
    expect(contrast(focus, selection), 'focus ring against the selected-row wash')
      .toBeGreaterThanOrEqual(3)
  })

  it('live data is the brightest role, so "this is real, right now" still reads as the loudest thing on the page', () => {
    const live = contrast(resolve('--role-live'), SURFACE_1)
    for (const role of ROLES) {
      if (role === '--role-live') continue
      expect(live, `--role-live must out-shout ${role}`)
        .toBeGreaterThanOrEqual(contrast(resolve(role), SURFACE_1))
    }
  })
})

describe('WO-1126: the text-vs-fill ruling is checked on its real surfaces', () => {
  const SURFACE_2 = '#1c2230'
  const SURFACE_HOVER = '#1e2736'
  const SURFACE_INPUT = '#111827'
  const SURFACE_CANVAS = '#111418'

  it('records every passing default-theme surface used by identity readout text', () => {
    const identity = resolve('--role-identity')
    for (const [surface, value] of Object.entries({
      '--surface-1': SURFACE_1,
      '--surface-2': SURFACE_2,
      '--surface-input': SURFACE_INPUT,
      '--surface-canvas': SURFACE_CANVAS,
    })) {
      expect(contrast(identity, value), `--role-identity on ${surface}`)
        .toBeGreaterThanOrEqual(4.5)
    }
  })

  it('records every surface where the identity base requires the readability fallback', () => {
    const identity = resolve('--role-identity')
    const selected = contrast(identity, resolve('--role-selection'))
    const hover = contrast(identity, SURFACE_HOVER)
    const tintedReadout = contrast(identity, compositeOver(identity, SURFACE_1, 0.12))

    expect(selected).toBeCloseTo(3.48, 2)
    expect(selected).toBeLessThan(4.5)
    expect(hover).toBeCloseTo(4.49, 2)
    expect(hover).toBeLessThan(4.5)
    expect(tintedReadout).toBeCloseTo(4.41, 2)
    expect(tintedReadout).toBeLessThan(4.5)
  })

  it('keeps a highlighted readout readable when its tint follows currentColor', () => {
    const light = resolve('--role-identity-light')
    const tintedReadout = compositeOver(light, SURFACE_1, 0.12)
    expect(contrast(light, tintedReadout)).toBeCloseTo(7.05, 2)
    expect(contrast(light, tintedReadout)).toBeGreaterThanOrEqual(4.5)
  })

  it('keeps label text readable on every dark chrome surface it uses', () => {
    const label = resolve('--role-identity-light')
    for (const [surface, value] of Object.entries({
      '--surface-1': SURFACE_1,
      '--surface-2': SURFACE_2,
      '--surface-hover': SURFACE_HOVER,
      '--surface-input': SURFACE_INPUT,
      '--surface-canvas': SURFACE_CANVAS,
      '--role-selection': resolve('--role-selection'),
      '--role-identity-deep': resolve('--role-identity-deep'),
    })) {
      expect(contrast(label, value), `--role-identity-light on ${surface}`)
        .toBeGreaterThanOrEqual(4.5)
    }
  })

  it('keeps cyan status text readable on every dark chrome surface it uses', () => {
    const live = resolve('--role-live')
    for (const [surface, value] of Object.entries({
      '--surface-1': SURFACE_1,
      '--surface-2': SURFACE_2,
      '--surface-canvas': SURFACE_CANVAS,
      '--role-selection': resolve('--role-selection'),
    })) {
      expect(contrast(live, value), `--role-live on ${surface}`)
        .toBeGreaterThanOrEqual(4.5)
    }
  })
})

describe('WO-269: cyan means one thing now', () => {
  const appCss = stripComments(readFileSync(APP, 'utf8'))

  it('--cyan-400 is only reached through --role-live, or through the user-picked macro palette', () => {
    // The macro palette is a colour the USER picks for a macro button (one of
    // green/amber/red/cyan/neutral) - it is a label, not a semantic role, and
    // sits on the raw primitive on purpose, exactly like macro-green sits on
    // --green-600. Every other reach for the raw cyan primitive is the sprawl
    // coming back: it must go through --role-live so the meaning is stated.
    const strays: string[] = []
    let selector = ''
    let pending = ''
    let depth = 0
    appCss.split(/\r?\n/).forEach((line, i) => {
      for (const ch of line) {
        if (ch === '{') { if (depth === 0) selector = pending.trim().replace(/\s+/g, ' '); depth++; pending = '' }
        else if (ch === '}') { depth = Math.max(0, depth - 1); if (depth === 0) selector = ''; pending = '' }
        else pending += ch
      }
      if (/var\(--cyan-400\)/.test(line) && !/macro-cyan/.test(selector) && !/macro-cyan/.test(line)) {
        strays.push(`${APP}:${i + 1}  [${selector}]  ${line.trim()}`)
      }
    })
    expect(strays).toEqual([])
  })

  it('applies the readout, label, and highlighted-surface boundary on Control', () => {
    const ruleFor = (selector: string) => {
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const rule = new RegExp(`${escaped}\\s*\\{[^}]*\\}`).exec(appCss)
      expect(rule, `${selector} rule not found in ${APP}`).not.toBeNull()
      return rule![0]
    }

    // Normal-surface machine values stay in the DRO identity family.
    for (const selector of [
      '.control-tool-num-active',
      '.control-tool-glance-current',
    ]) {
      const rule = ruleFor(selector)
      expect(rule, `${selector} must use the identity base`).toMatch(/var\(--role-identity\)/)
      expect(rule, `${selector} must not return to cyan`).not.toMatch(/var\(--role-live\)/)
    }

    // Labels always use the light identity step.
    expect(ruleFor('.control-jog-step-readout')).toMatch(/color:\s*var\(--role-identity-light\)/)
    const home = ruleFor('.control-home-outline')
    expect(home).toMatch(/border-color:\s*var\(--role-identity\)/)
    expect(home).toMatch(/color:\s*var\(--role-identity-light\)/)
    const rearm = ruleFor('.control-btn-rearm')
    expect(rearm).toMatch(/border-color:\s*var\(--role-identity\)/)
    expect(rearm).toMatch(/color:\s*var\(--role-identity-light\)/)
    const gizmoHover = ruleFor('.display-mode-gizmo-btn:hover')
    expect(gizmoHover).toMatch(/color:\s*var\(--role-identity-light\)/)
    expect(gizmoHover).not.toMatch(/var\(--role-focus\)/)

    // The base identity fails 4.5:1 on selection and hover surfaces, so the
    // same readout switches to the light step while highlighted.
    expect(ruleFor('.control-offsets-active'))
      .toMatch(/color:\s*var\(--role-identity-light\)/)
    expect(ruleFor('.control-wcs-active'))
      .toMatch(/color:\s*var\(--role-identity-light\)/)
    expect(ruleFor('.control-tools-selected .control-tool-num-active'))
      .toMatch(/color:\s*var\(--role-identity-light\)/)
    const rapidHover = ruleFor('[data-testid="control-ovr-rapid"] .control-chip-active:hover:not(:disabled)')
    expect(rapidHover).toMatch(/border-color:\s*var\(--role-identity\)/)
    expect(rapidHover).toMatch(/color:\s*var\(--role-identity-light\)/)
    expect(rapidHover).not.toMatch(/var\(--role-live\)/)
    const inputHover = ruleFor('.control-ovr-value-input:hover:not(:disabled)')
    expect(inputHover).toMatch(/background:\s*var\(--surface-hover\)/)
    expect(inputHover).toMatch(/color:\s*var\(--role-identity-light\)/)
    expect(ruleFor('.control-ovr-value-input:hover:not(:disabled) + .control-ovr-percent'))
      .toMatch(/color:\s*var\(--role-identity-light\)/)

    // WO-993 is an explicit Operator reversal: the work DRO is a machine readout,
    // and he moved it from cyan to the shared identity blue.
    const workDro = /\.control-dro-work\s*\{[^}]*\}/.exec(appCss)
    expect(workDro, `.control-dro-work rule not found in ${APP}`).not.toBeNull()
    expect(workDro![0]).toMatch(/var\(--accent\)/)
    expect(workDro![0]).not.toMatch(/var\(--role-live\)/)

    // WO-1123 is the SECOND HALF of that same reversal. Operator, 2026-08-29 at the
    // machine: "the jog commands are still the different color teal blue than
    // our default blue. we've implemented everywhere else like the Dro blue."
    // The override group followed the DRO onto --accent.
    //
    // Pinned as a GROUP on purpose. These four are one visual set, and the
    // reason they were unified on cyan in the first place was Operator reporting
    // "overrides clash in color of blue to thier neighbors". Splitting them
    // again - even onto two legitimate blues - recreates that complaint, so the
    // test fails if any ONE of them drifts away from the others.
    for (const selector of [
      '.control-ovr-value',
      '.control-ovr-value-input',
      '.control-ovr-percent',
    ]) {
      const rule = new RegExp(`^\\s*\\${selector}\\s*\\{[^}]*\\}`, 'm').exec(appCss)
      expect(rule, `${selector} rule not found in ${APP}`).not.toBeNull()
      expect(rule![0], `${selector} must match the DRO on --accent (WO-1123)`).toMatch(/var\(--accent\)/)
      expect(rule![0], `${selector} must not drift back to cyan`).not.toMatch(/var\(--role-live\)/)
    }
    const rapid = /\[data-testid="control-ovr-rapid"\][^{]*\{[^}]*\}/.exec(appCss)
    expect(rapid, 'the Rapid override segment rule was not found').not.toBeNull()
    expect(rapid![0], 'Rapid must stay with Feed and Spindle (WO-1123)').toMatch(/var\(--accent\)/)
    expect(rapid![0]).not.toMatch(/var\(--role-live\)/)
  })

  it('reserves cyan for actual live-status markers', () => {
    for (const selector of [
      '.pendant-status-connected .pendant-status-dot',
      '.control-state-home',
      '.control-operation[data-state="running"]',
    ]) {
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const rule = new RegExp(`${escaped}\\s*\\{[^}]*\\}`).exec(appCss)
      expect(rule, `${selector} rule not found in ${APP}`).not.toBeNull()
      expect(rule![0], `${selector} must remain a cyan live marker`).toMatch(/var\(--role-live\)/)
    }
  })

  it('an ACTIVE label is never painted in the live-status colour', () => {
    // This is the specific confusion Operator named: on the Control tab the tool
    // readout and the selected chip beside it once shared cyan for two meanings.
    for (const selector of ['.control-view-tab-active', '.control-tool-glance-chip-active']) {
      const rule = new RegExp(`${selector.replace('.', '\\.')}\\s*\\{[^}]*\\}`).exec(appCss)
      expect(rule, `${selector} rule not found in ${APP}`).not.toBeNull()
      expect(rule![0], `${selector} must not use --role-live`).not.toMatch(/var\(--role-live\)/)
    }
  })
})
