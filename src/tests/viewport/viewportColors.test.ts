import { describe, it, expect, beforeEach } from 'vitest'
import {
  asHex,
  asNumber,
  roleColors,
  refreshViewportColors,
  ROLE_TOKENS,
} from '../../theme/viewportColors'

// In the vitest "node" environment `document` is undefined, so the bridge
// resolves every token through its built-in FALLBACK map. This test pins
// those fallback values to the CURRENT production hex (the literals that
// lived in CNCViewport.ts / sketchLayer.ts before Phase 1.3). Phase 1.3
// invariant: ZERO visual change -> these MUST match exactly.

// Expected production hex per docs/ui-ux/findings/02-viewport-semantics.md.
const EXPECTED: Record<string, string> = {
  // toolpath roles
  '--role-cut': '#00e5ff',
  '--role-rapid': '#ff4444',
  '--role-fast-traverse': '#5ea0ff',
  '--role-helix': '#ff8c00',   // v3: merged with ramp
  '--role-ramp': '#ff8c00',
  '--role-plunge': '#ff44ff',
  '--role-finish': '#ff85a8',
  '--role-stepover': '#44ff88',
  '--role-wall-follow': '#00d0a0',
  '--role-lead-in': '#a78bfa',   // v3: merged with lead-out
  '--role-lead-out': '#a78bfa',
  '--role-unknown': '#ffffff',

  // sketch palette
  '--sketch-under-defined': '#4a9eff',
  '--sketch-fully-defined': '#e2e8f0',
  '--sketch-conflict': '#ff4444',
  '--sketch-selected': '#ffaa00',
  '--sketch-badge': '#9fb0c2',
  '--sketch-dimension': '#8899aa',
  '--sketch-hover': '#00e5ff',

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
  '--vp-seed': '#b06bff',  // ADR 0025 seed (nest-source) halo + tree badge

  // brep pick
  '--vp-brep-pick': '#ffaa00',
  '--vp-brep-hover': '#ffe080',
  '--vp-brep-hover-on-selected': '#331f00',  // WO-351: dark swap vs a selected body's fill
  '--vp-brep-pick-on-selected': '#1a0f00',

  // face overlay
  '--vp-face-overlay': '#00a8ff',
  '--vp-face-overlay-hover': '#ff8800',

  // optimization preview
  '--vp-opt-before': '#4488ff',
  '--vp-opt-after': '#ff8800',

  // slice preview
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

  // lights
  '--vp-light-ambient': '#ffffff',
  '--vp-light-key': '#fff8f0',
  '--vp-light-fill': '#b0d4ff',
  '--vp-light-rim': '#ffffff',

  // snap / interaction
  '--vp-snap-marker': '#ffaa00',
  '--vp-snap-guide': '#6fa8ff',
  '--vp-snap-badge': '#4a9eff',

  // overlay channels
  '--vp-overlay-removal': '#ff5566',
  '--vp-overlay-ghost': '#9fb4c7',
  '--vp-overlay-warning': '#ff8800',

  // UI-BRAND-B2-9: ViewportOverlay's Simulation mode badge
  '--accent-amber': '#e0a94f',
}

describe('viewportColors bridge (node fallback path)', () => {
  beforeEach(() => refreshViewportColors())

  it('resolves every token to its exact production hex', () => {
    for (const [token, hex] of Object.entries(EXPECTED)) {
      expect(asHex(token), token).toBe(hex)
    }
  })

  it('asNumber returns the 0xRRGGBB form for THREE', () => {
    expect(asNumber('--role-cut')).toBe(0x00e5ff)
    expect(asNumber('--vp-canvas')).toBe(0x111418)
    expect(asNumber('--role-unknown')).toBe(0xffffff)
  })

  it('roleColors exposes all 11 roles plus unknown, matching ROLE_COLORS', () => {
    const expectedRoles: Record<string, string> = {
      rapid: '#ff4444',
      cut: '#00e5ff',
      helix: '#ff8c00',
      ramp: '#ff8c00',
      plunge: '#ff44ff',
      stepover: '#44ff88',
      fast_traverse: '#5ea0ff',
      wall_follow: '#00d0a0',
      finish: '#ff85a8',
      lead_in: '#a78bfa',
      lead_out: '#a78bfa',
      unknown: '#ffffff',
    }
    for (const [role, hex] of Object.entries(expectedRoles)) {
      expect(roleColors[role], role).toBe(hex)
    }
    expect(Object.keys(ROLE_TOKENS).sort()).toEqual(
      Object.keys(expectedRoles).sort(),
    )
  })

  it('refreshViewportColors clears the cache without changing values', () => {
    const before = asHex('--role-cut')
    refreshViewportColors()
    expect(asHex('--role-cut')).toBe(before)
  })
})
