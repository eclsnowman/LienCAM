// GEO-25: ONE shared viewport DISPLAY THEME definition consumed by BOTH the
// Model workspace (SolidsWorkbenchPage.tsx) and the CAM viewport
// (CNCViewport.ts) -- Operator's Q-50 decision + the coordinator's consistent-feel
// ruling (docs/planning/POST-MERGE-WORKPLAN.md GEO-25 entry). Mirrors
// rigDescriptors.ts's "one source of truth, pure data, no `three` import"
// shape (sibling file, same directory) so both renderers read the identical
// numbers and can never drift apart, and so the Node vitest suite can import
// this module without pulling a WebGL-shaped dependency.
//
// Ported BY HAND from the wo/GEO-25 capture prototype (commits 0c03345af +
// 25c030369, never merged -- that branch's capture tooling stays dev-side)
// and the exact card Operator picked from
// (coordination/evidence/GEO-25/display-default-candidates.html). Operator's Q-50
// verbatim: "I like deep slate and brand blue. can we have multiple display
// themes? I like brand blue as the default.. but that deep slate is really
// sharp. i don't want to lose it."
//
// 'classic' is the ONE special case and is NOT a color override at all: both
// renderers keep their exact pre-existing default code path completely
// untouched (DEFAULT_HIGHLIGHT_COLORS / DEFAULT_EDGE_HIGHLIGHT_COLORS for the
// Model workspace's vertex-color attributes, this.colors.workpiece /
// workpieceEdge CSS tokens for the CAM viewport's part materials) -- so
// "classic" really is byte-identical to what shipped before this WO, not a
// re-derivation through hex parsing that could drift by a rounding step.

export type ViewportThemeId = 'classic' | 'cool-slate' | 'brand-blue' | 'deep-slate'

export const VIEWPORT_THEME_IDS: readonly ViewportThemeId[] = [
  'classic', 'cool-slate', 'brand-blue', 'deep-slate',
]

/** Operator, Q-50: "I like brand blue as the default". Unset/first-launch
 *  preference resolves here -- existing users' first launch after this WO
 *  SEES the new default (Operator's chosen outcome), one click back to 'classic'. */
export const DEFAULT_VIEWPORT_THEME: ViewportThemeId = 'brand-blue'

export const VIEWPORT_THEME_LABELS: Record<ViewportThemeId, string> = {
  classic: 'Classic',
  'cool-slate': 'Cool Slate',
  'brand-blue': 'Brand Blue',
  'deep-slate': 'Deep Slate',
}

/** Fat-line (three/examples LineSegments2 + LineMaterial) stroke width in
 *  SCREEN PIXELS (worldUnits:false), shared by every non-classic theme --
 *  GEO-25's capture study held this constant across candidates on purpose so
 *  the study isolated the color variable, not the technique. 'classic' has NO
 *  width here: THREE.LineBasicMaterial ignores linewidth in WebGL regardless
 *  (GEO-24 landing intel), so its edges stay the exact 1px path, untouched.
 *  Operator's edge-parity UAT tightened the resting topology stroke to an
 *  1.25 CSS px for legible edges. LineMaterial already interprets this value in
 *  screen pixels when worldUnits:false, so callers must not DPR-scale it.
 *  Hover/selection overlays deliberately use their separate heavier widths.
 *  ONE constant, both viewports (CNCViewport.ts CAM viewport +
 *  SolidsWorkbenchPage.tsx Model workspace), all non-classic themes -- never
 *  hardcode or scale this width at a call site. */
export const VIEWPORT_THEME_EDGE_WIDTH_PX = 1.25

export interface ViewportThemeColorDef {
  readonly id: Exclude<ViewportThemeId, 'classic'>
  readonly label: string
  /** Body base color, sRGB hex string. ALWAYS construct THREE.Color from this
   *  exact string (`new THREE.Color(hex)`) or from hexToNumber() below fed
   *  through the single-argument `new THREE.Color(number)` (setHex) path --
   *  NEVER from the 3-float `new THREE.Color(r, g, b)` constructor. That
   *  constructor treats its floats as already being in the LINEAR working
   *  color space; feeding it an sRGB-encoded triple (the hex-byte/255
   *  convention used throughout this codebase) silently re-interprets a dark
   *  color as linear, and the renderer's linear->sRGB output encode then
   *  re-brightens it back up -- root-caused on the wo/GEO-25 prototype:
   *  slate-700 (#2d3748, intended ~rgb(45,55,72)) rendered as roughly
   *  rgb(117,128,145), nearly invisible against the lit body. */
  readonly bodyHex: string
  readonly bodyTokens: readonly string[]
  /** Edge overlay color, sRGB hex string. Same sRGB-construction rule as
   *  bodyHex -- this is the color the original bug was found on (a fat-line
   *  LineMaterial.color uniform, a real material property that goes through
   *  color management, unlike a raw vertex-color buffer write). */
  readonly edgeHex: string
  readonly edgeTokens: readonly string[]
}

export const VIEWPORT_THEME_COLORS: Record<Exclude<ViewportThemeId, 'classic'>, ViewportThemeColorDef> = {
  'cool-slate': {
    id: 'cool-slate',
    label: 'Cool Slate',
    bodyHex: '#7e8ea1',
    bodyTokens: ['--slate-400'],
    edgeHex: '#2d3748',
    edgeTokens: ['--slate-700'],
  },
  'brand-blue': {
    id: 'brand-blue',
    label: 'Brand Blue',
    bodyHex: '#7ec0ff',
    bodyTokens: ['--blue-300'],
    edgeHex: '#1e4a7a',
    edgeTokens: ['--blue-700'],
  },
  'deep-slate': {
    id: 'deep-slate',
    label: 'Deep Slate',
    bodyHex: '#546070',
    bodyTokens: ['--slate-500'],
    edgeHex: '#e2e8f0',
    edgeTokens: ['--slate-100'],
  },
}

export function isViewportThemeId(value: unknown): value is ViewportThemeId {
  return typeof value === 'string' && (VIEWPORT_THEME_IDS as readonly string[]).includes(value)
}

/** classic is the only theme that keeps the 1px THREE.LineBasicMaterial edge
 *  path; every other theme renders its (shared, constant-width) fat-line
 *  edge overlay. Single predicate so both renderers branch on the same rule. */
export function viewportThemeUsesFatLineEdges(id: ViewportThemeId): boolean {
  return id !== 'classic'
}

/** '#rrggbb' -> 0xrrggbb. Pure string parse, no three.js dependency (keeps
 *  this module importable from the Node vitest suite, mirroring
 *  rigDescriptors.ts). Feed the result through `new THREE.Color(number)`
 *  (the setHex path) at the call site -- never the 3-float constructor. */
export function hexToNumber(hex: string): number {
  return parseInt(hex.replace('#', ''), 16)
}

/** '#rrggbb' -> [r,g,b] each 0-1 (hex-byte/255), the sRGB-encoded-float
 *  convention this codebase's vertex-color attributes already use
 *  (DEFAULT_HIGHLIGHT_COLORS/DEFAULT_EDGE_HIGHLIGHT_COLORS in
 *  src/viewport3d/highlight.ts). Safe for a RAW vertex-attribute write
 *  (no THREE.Color / color-management pass involved), which is how the Model
 *  workspace paints body-mesh and thin-edge vertex colors. */
export function hexToUnitRGB(hex: string): readonly [number, number, number] {
  const n = hexToNumber(hex)
  return [
    ((n >> 16) & 0xff) / 255,
    ((n >> 8) & 0xff) / 255,
    (n & 0xff) / 255,
  ]
}
