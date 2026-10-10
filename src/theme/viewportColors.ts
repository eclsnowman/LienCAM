// ============================================================
// Viewport color bridge
// ------------------------------------------------------------
// Single source of truth that lets the Three.js viewport and the CSS
// legend read the SAME design tokens (src/theme/tokens.css). Resolves
// CSS custom properties lazily via getComputedStyle and caches the result,
// so import order does not matter -- and re-resolves automatically the
// moment the data-theme attribute changes (WO-326), so a live theme switch
// (WO-324) repaints the viewport without a reload.
//
// SSR / worker / test safety: when `document` is undefined (Node test
// runner, web worker), or when a token resolves empty (jsdom does not
// flatten var() chains in getComputedStyle), we fall back to a built-in
// literal map. Every fallback value MUST equal the production token value
// in tokens.css (asserted by src/tests/theme/viewportColors.test.ts).
//
// Phase 1.3 invariant: ZERO visual change. Every color resolves EXACTLY
// to the hardcoded value it replaced.
// ============================================================

// ---- Fallback map (mirror of tokens.css; values are CURRENT production) --
//
// Keyed by the resolved hex string. Used when CSS resolution is
// unavailable. The unit test cross-checks these against the expected
// production hex, so this map IS the spec for the node/worker path.
const FALLBACK: Record<string, string> = {
  // toolpath roles
  '--role-cut': '#00e5ff',
  '--role-rapid': '#ff4444',
  '--role-fast-traverse': '#5ea0ff',
  '--role-helix': '#ff8c00',   // v3: merged with ramp (was #ffd700)
  '--role-ramp': '#ff8c00',
  '--role-plunge': '#ff44ff',
  '--role-finish': '#ff85a8',
  '--role-stepover': '#44ff88',
  '--role-wall-follow': '#00d0a0',
  '--role-lead-in': '#a78bfa',   // v3: merged with lead-out (was #aa44ff)
  '--role-lead-out': '#a78bfa',
  '--role-unknown': '#ffffff',

  // sketch entity palette
  '--sketch-under-defined': '#4a9eff',
  '--sketch-fully-defined': '#e2e8f0',
  '--sketch-conflict': '#ff4444',
  '--sketch-selected': '#ffaa00',
  '--sketch-badge': '#9fb0c2',
  '--sketch-dimension': '#8899aa',
  '--sketch-tool-preview': '#4a9eff',
  '--sketch-hover': '#00e5ff',

  '--vp-cube-face': '#1a2d40',
  '--vp-cube-hover': '#2d4a6e',
  '--vp-cube-edge': '#4a90d9',

  // scene furniture
  '--vp-canvas': '#111418',
  '--vp-grid': '#2a2f36',
  '--vp-grid-accent': '#1e4976',
  '--vp-grid-plane': '#141a22',
  '--vp-axis-x': '#e05252',
  '--vp-axis-y': '#5ca85c',
  '--vp-axis-z': '#4a90d9',
  '--vp-wcs-origin': '#ffd700',
  '--vp-machine-border': '#ffaa00',
  '--vp-construction-plane': '#4ea1ff',

  // stock + workpiece
  '--vp-stock': '#2a5c8a',
  '--vp-stock-edge': '#4a9cd4',
  '--vp-workpiece': '#8ab4cc',
  '--vp-workpiece-edge': '#bfd8ec',
  '--vp-stock-gizmo': '#4ac3ff',
  '--vp-sim-mesh': '#3a7ab0',

  // geometry-state
  '--vp-loop-default': '#4ac3ff',
  '--vp-select-part': '#ffaa00',  // Phase 2 (P6): amber object-selection doctrine
  '--vp-select-face': '#ff8c00',
  '--vp-select-amber': '#ffaa00',
  '--vp-seed': '#b06bff',   // ADR 0025 seed (nest-source) halo + tree badge

  // brep pick
  '--vp-brep-pick': '#ffaa00',
  '--vp-brep-hover': '#ffe080',
  // WO-351: dark, theme-invariant swap used when the highlighted body's own
  // fill is ALSO amber (see tokens.css's WO-351 comment for the measured
  // contrast ratios and why this cannot be the same value as the fill).
  '--vp-brep-hover-on-selected': '#331f00',
  '--vp-brep-pick-on-selected': '#1a0f00',

  // face cluster overlay
  '--vp-face-overlay': '#00a8ff',
  '--vp-face-overlay-hover': '#ff8800',

  // optimization preview
  '--vp-opt-before': '#4488ff',
  '--vp-opt-after': '#ff8800',

  // slice / section preview
  '--vp-slice-plane': '#00aaff',
  '--vp-slice-handle': '#ff8c00',
  '--vp-slice-preview': '#ffff00',

  // height planes
  '--vp-plane-clearance': '#4a90d9',
  '--vp-plane-retract': '#5a7ca6',
  '--vp-plane-feed': '#4caf50',
  '--vp-plane-top': '#aac8e0',
  '--vp-plane-bottom': '#e05252',

  // tool mesh
  '--vp-tool-flutes': '#33cc44',
  '--vp-tool-shoulder': '#5588aa',
  '--vp-tool-shank': '#cc3333',

  // scene lights
  '--vp-light-ambient': '#ffffff',
  '--vp-light-key': '#fff8f0',
  '--vp-light-fill': '#b0d4ff',
  '--vp-light-rim': '#ffffff',

  // snap / interaction feedback
  '--vp-snap-marker': '#ffaa00',
  '--vp-snap-guide': '#6fa8ff',
  '--vp-snap-badge': '#4a9eff',

  // sketch tool overlay channels
  '--vp-overlay-removal': '#ff5566',
  '--vp-overlay-ghost': '#9fb4c7',
  '--vp-overlay-warning': '#ff8800',

  // UI-BRAND-B2-9: not a scene token, but ViewportOverlay's mode badge
  // resolves all 4 mode colors through this same bridge (so the badge can
  // never drift from the tokens), and the Simulation entry now points here.
  '--accent-amber': '#e0a94f',
}

// ---- Resolution cache ----------------------------------------------------
const cache = new Map<string, string>()

// WO-326: a cache entry is only correct for as long as the active theme
// hasn't changed underneath it -- getComputedStyle reflects whichever
// [data-theme="..."] cascade rule currently wins, so a value resolved under
// one theme is simply wrong once the operator switches to another. Track the
// DOM attribute the theme switch writes/removes (see src/theme/uiTheme.ts,
// outside this file's lane) and drop the whole cache the instant it moves,
// so the very next read re-resolves from CSS instead of serving the old
// theme's answer. `undefined` (not `null`) is the "never observed yet"
// sentinel, since `null` is itself a valid "no data-theme attribute" state.
let lastThemeAttr: string | null | undefined

/** Current theme attribute value, or null if unset/unavailable (SSR-safe). */
function currentThemeAttr(): string | null {
  if (typeof document === 'undefined' || !document.documentElement) return null
  const theme = document.documentElement.getAttribute('data-theme') ?? ''
  const mode = document.documentElement.getAttribute('data-color-mode') ?? ''
  return `${theme}|${mode}`
}

/** Normalize a resolved CSS color to a #rrggbb hex string. getComputedStyle
 *  may return "#rgb", "#rrggbb", or "rgb(r, g, b)" depending on the engine. */
function normalizeHex(raw: string): string | null {
  const v = raw.trim()
  if (v === '') return null
  if (/^#[0-9a-fA-F]{6}$/.test(v)) return v.toLowerCase()
  if (/^#[0-9a-fA-F]{3}$/.test(v)) {
    const r = v[1], g = v[2], b = v[3]
    return ('#' + r + r + g + g + b + b).toLowerCase()
  }
  const m = v.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/)
  if (m) {
    const h = (n: string) => Number(n).toString(16).padStart(2, '0')
    return ('#' + h(m[1]) + h(m[2]) + h(m[3])).toLowerCase()
  }
  return null
}

/** Resolve a CSS custom property name (with leading --) to a #rrggbb hex.
 *  Lazy + cached. Falls back to the built-in literal map when document is
 *  unavailable or the engine cannot flatten the var() chain. */
function resolve(name: string): string {
  const themeAttr = currentThemeAttr()
  if (themeAttr !== lastThemeAttr) {
    cache.clear()
    lastThemeAttr = themeAttr
  }

  const cached = cache.get(name)
  if (cached !== undefined) return cached

  let result: string | null = null
  if (typeof document !== 'undefined' && document.documentElement) {
    try {
      const raw = getComputedStyle(document.documentElement).getPropertyValue(name)
      result = normalizeHex(raw)
    } catch {
      result = null
    }
  }
  if (result === null) {
    const fb = FALLBACK[name]
    if (fb === undefined) {
      throw new Error(`viewportColors: no token or fallback for "${name}"`)
    }
    result = fb.toLowerCase()
  }
  cache.set(name, result)
  return result
}

// ---- Public helpers ------------------------------------------------------

/** Resolved #rrggbb hex string for a token (e.g. asHex('--role-cut')). */
export function asHex(name: string): string {
  return resolve(name)
}

/** Resolved color as a 0xRRGGBB number for THREE materials. */
export function asNumber(name: string): number {
  return parseInt(resolve(name).slice(1), 16)
}

/** Clear the resolution cache (call after a live theme switch). */
export function refreshViewportColors(): void {
  cache.clear()
}

// ---- Role colors ---------------------------------------------------------
//
// Map of toolpath role -> #rrggbb string. The 11 production roles plus the
// `unknown` fallback. Both the CSS legend (string form) and the THREE scene
// (via asNumber) read from this single definition.
export const ROLE_TOKENS: Record<string, string> = {
  cut: '--role-cut',
  rapid: '--role-rapid',
  fast_traverse: '--role-fast-traverse',
  helix: '--role-helix',
  ramp: '--role-ramp',
  plunge: '--role-plunge',
  finish: '--role-finish',
  stepover: '--role-stepover',
  wall_follow: '--role-wall-follow',
  lead_in: '--role-lead-in',
  lead_out: '--role-lead-out',
  unknown: '--role-unknown',
}

/** role -> #rrggbb string (lazily resolved on access). */
export const roleColors: Record<string, string> = new Proxy(
  {},
  {
    get(_t, prop: string) {
      const token = ROLE_TOKENS[prop]
      return token ? asHex(token) : undefined
    },
    has(_t, prop: string) {
      return prop in ROLE_TOKENS
    },
    ownKeys() {
      return Reflect.ownKeys(ROLE_TOKENS)
    },
    getOwnPropertyDescriptor() {
      return { enumerable: true, configurable: true }
    },
  },
) as Record<string, string>
