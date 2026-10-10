// GEO-26 Stage A/B: unified selection/hover glow TOKEN ARCHITECTURE.
//
// Operator's binding scope-expansion (POST-MERGE-WORKPLAN.md GEO-26, second
// verbatim directive, 2026-07-22): "the trickiest part is going to be getting
// that to be consistent across sketch lines, nodes faces, model edges, etc."
// with four binding implications: (1) per-theme-aware / theme-proof --
// solves the shipped blue-on-brand-blue camouflage (sketch's under-defined
// default AND the Model workspace's `selected` highlight
// (src/viewport3d/highlight.ts DEFAULT_HIGHLIGHT_COLORS.selected = a BLUE,
// 0x268cff-ish) both land in the same blue hue family as the brand-blue
// theme's body/edge color -- confirmed by reading both files, not assumed);
// (2) ONE visual language across sketch line/node, model face/edge, B-rep
// edge -- every consumer resolves color from THIS module, never a private
// hex; (3) tokens, not magic numbers; (4) Stage A: dev-gated candidates,
// captured, verdict card. Stage B (Operator Q-53, verbatim): "i honestly like
// them all. don't make me choose just 1 make it a display option like the
// themes." -- promotes the three candidates + 'current' to a PERSISTED
// Settings > Display selector (src/store/uiPrefs.ts `selectionGlow`,
// src/components/modals/SettingsModal.tsx), replacing the dev-only
// ?glowCandidate= query param / localStorage gate this module used to own.
//
// Mirrors viewportThemes.ts's shape on purpose (sibling file, same
// directory): pure data, no `three` import, per-theme lookup table, so the
// Node vitest suite can import this module directly and so both renderers
// (CNCViewport.ts CAM viewport + SolidsWorkbenchPage.tsx / viewport3d
// Model workspace + the sketch layer) read the identical numbers.

import { PERSISTED_USER_DATA_REGISTRY } from '../../../store/persistedKeys'
//
// SHIPPED-DEFAULT GUARANTEE (Stage A, still true, now selectable rather than
// forced): candidate 'current' is not a color table at all -- resolving it
// returns null, and every call site's contract is "null means keep doing
// exactly what you already do" (own hardcoded hex, own CSS token, whatever it
// was before this WO). DEFAULT_SELECTION_GLOW below is 'signature', not
// 'current' -- Operator's Q-53 processing ruling (coordinator ruling, verbatim
// Operator reply: "great provisional call. you are exactly right") -- so a fresh
// install ships the fixed blue-on-brand-blue camouflage by default; 'current'
// stays selectable for anyone who wants the pre-GEO-26 look back.

import type { ViewportThemeId } from './viewportThemes'

export type SelectionGlowCandidateId =
  | 'current'
  | 'signature'
  | 'complementary'
  | 'brightness-halo'

export const SELECTION_GLOW_CANDIDATE_IDS: readonly SelectionGlowCandidateId[] = [
  'current',
  'signature',
  'complementary',
  'brightness-halo',
]

export const SELECTION_GLOW_CANDIDATE_LABELS: Record<SelectionGlowCandidateId, string> = {
  current: 'Current',
  signature: 'Orange Contrast',
  complementary: 'Complementary Pop',
  'brightness-halo': 'Brightness Halo',
}

/** Stage B (Q-53 processing, coordinator ruling Operator endorsed verbatim:
 *  "great provisional call. you are exactly right"): the sketch environment's
 *  own proven cyan/amber pair, applied everywhere, ships as the DEFAULT for
 *  every fresh install / unset preference. 'current' remains one click away
 *  in Settings > Display for anyone who wants the pre-GEO-26 look. */
export const DEFAULT_SELECTION_GLOW: SelectionGlowCandidateId = 'signature'

/** Hex numbers (THREE setHex convention, 0xRRGGBB) -- consuming code that
 *  needs the 0-1 vertex-color convention runs these through
 *  viewportThemes.ts's hexToUnitRGB() at the call site, same as every other
 *  theme color in this codebase. `haloOpacityMul`/`haloWidthMul` are
 *  OPTIONAL multipliers on top of each entity type's own existing
 *  halo/opacity constants (sketchLayer.ts HALO_OPACITY/HALO_WIDTH_PX,
 *  CNCViewport.ts hover opacity) -- present only on candidates whose
 *  differentiator is glow INTENSITY rather than hue; absent means "no
 *  change to the entity type's own constant" (multiplier of 1). */
export interface SelectionGlowColors {
  readonly hover: number
  readonly selected: number
  readonly haloOpacityMul?: number
  readonly haloWidthMul?: number
}

type CandidateTable = Record<ViewportThemeId, SelectionGlowColors>

/** The default CAD interaction family. Hover is intentionally lighter than
 *  selection while both remain visibly separate from the blue body palette. */
export const SELECTION_ORANGE_HOVER = 0xffbd5a
export const SELECTION_ORANGE_SELECTED = 0xffa21a

/** Candidate A -- ORANGE CONTRAST. The chosen palette uses one
 *  warm interaction family across faces, edges, and bodies: a light preview
 *  followed by a darker committed selection. Keeping the pair theme-invariant
 *  also prevents the former cyan hover from disappearing into blue bodies. */
const SIGNATURE: SelectionGlowColors = {
  hover: SELECTION_ORANGE_HOVER,
  selected: SELECTION_ORANGE_SELECTED,
}
const SIGNATURE_TABLE: CandidateTable = {
  classic: SIGNATURE,
  'cool-slate': SIGNATURE,
  'brand-blue': SIGNATURE,
  'deep-slate': SIGNATURE,
}

/** Candidate B -- COMPLEMENTARY POP. A NEW brand accent family (violet
 *  hover / magenta selected) genuinely TUNED PER THEME against each theme's
 *  own body hue, engineered as this module's per-theme differentiator:
 *  classic/deep-slate have neutral (gray/near-white) bodies with no hue to
 *  complement, so they get the base violet/magenta pair; cool-slate and
 *  brand-blue both have blue-family bodies (~205-215deg hue) so they get a
 *  warmed, slightly more saturated variant pushed further from that hue
 *  than the base pair. Distinct hue family from candidate A on purpose (a
 *  genuinely different "brand feel" for Operator to compare, not a restyle of
 *  the same idea). */
const COMPLEMENTARY_TABLE: CandidateTable = {
  classic: { hover: 0xc084fc, selected: 0xf43f5e },
  'cool-slate': { hover: 0xd8b4fe, selected: 0xff2fb0 },
  'brand-blue': { hover: 0xd8b4fe, selected: 0xff2fb0 },
  'deep-slate': { hover: 0xc084fc, selected: 0xf43f5e },
}

/** Candidate C -- BRIGHTNESS HALO. Stays in the warm amber/gold hue family
 *  (the CAM viewport's existing --vp-brep-pick/--vp-brep-hover amber/gold
 *  pair, src/theme/tokens.css) but differentiates via LUMINANCE and glow
 *  INTENSITY rather than a novel hue: a paler, higher-opacity/wider hover
 *  halo and a hotter, more saturated selected ember. Theme-invariant like
 *  candidate A (a bloom effect reads the same regardless of body hue) --
 *  the haloOpacityMul/haloWidthMul let each entity type's existing glow
 *  technique (sketch's fat-line halo underlay, the CAM viewport's
 *  translucent hover overlay) turn up its own knobs instead of this module
 *  inventing a new rendering technique. */
const BRIGHTNESS_HALO: SelectionGlowColors = {
  hover: 0xffe9b3,
  selected: 0xff8a00,
  haloOpacityMul: 1.4,
  haloWidthMul: 1.5,
}
const BRIGHTNESS_HALO_TABLE: CandidateTable = {
  classic: BRIGHTNESS_HALO,
  'cool-slate': BRIGHTNESS_HALO,
  'brand-blue': BRIGHTNESS_HALO,
  'deep-slate': BRIGHTNESS_HALO,
}

const CANDIDATE_TABLES: Record<Exclude<SelectionGlowCandidateId, 'current'>, CandidateTable> = {
  signature: SIGNATURE_TABLE,
  complementary: COMPLEMENTARY_TABLE,
  'brightness-halo': BRIGHTNESS_HALO_TABLE,
}

/** ONE resolver every consumer (sketchLayer.ts SKETCH_COLORS, viewport3d/
 *  highlight.ts model hover/selected, CNCViewport.ts BREP_PICK_COLOR/
 *  BREP_HOVER_COLOR) calls through -- satisfies binding implication (2),
 *  "resolve from one token set". Returns null for 'current', meaning "keep
 *  your own pre-existing color" (see module header). */
export function resolveSelectionGlowColors(
  candidate: SelectionGlowCandidateId,
  theme: ViewportThemeId,
): SelectionGlowColors | null {
  if (candidate === 'current') return null
  return CANDIDATE_TABLES[candidate][theme]
}

export function isSelectionGlowCandidateId(value: unknown): value is SelectionGlowCandidateId {
  return typeof value === 'string' && (SELECTION_GLOW_CANDIDATE_IDS as readonly string[]).includes(value)
}

// ---- Stage B migration note ------------------------------------------------
//
// Stage A's dev-only runtime selector (?glowCandidate= query param +
// `localStorage['geo26.glowCandidate']` fallback, getActiveGlowCandidate()/
// setActiveGlowCandidate()) is KILLED by Stage B -- the persisted
// src/store/uiPrefs.ts `selectionGlow` preference (read through
// src/store/uiPrefs.ts's `getSelectionGlow()`) replaces it entirely for every
// consumer. LEGACY_GLOW_CANDIDATE_STORAGE_KEY is kept here (not deleted)
// purely so uiPrefs.ts's one-time migration -- "if the old localStorage key
// exists, honor it once as the initial preference then remove it" -- reads
// the exact same string a Stage-A developer's browser may still hold,
// without duplicating the literal across modules.
export const LEGACY_GLOW_CANDIDATE_STORAGE_KEY =
  PERSISTED_USER_DATA_REGISTRY.legacyGlowCandidate.key
