import { operatorText } from '../i18n/locales/en/console-and-operator-messages'
import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import type { SerializedCamera } from '../lib/viewport/cameraPersist'
import type { AppSettings } from '../types'
import type { CameraProjectionMode } from '../components/model3d/sceneRuntime'
import {
  DEFAULT_VIEWPORT_THEME,
  type ViewportThemeId,
} from '../lib/viewport/lighting/viewportThemes'
import {
  DEFAULT_SELECTION_GLOW,
  type SelectionGlowCandidateId,
} from '../lib/viewport/lighting/selectionGlowTokens'
import {
  applyUiColorMode,
  DEFAULT_UI_COLOR_MODE,
  applyUiTheme,
  DEFAULT_UI_THEME,
  isUiColorMode,
  type UiColorMode,
  isUiThemeId,
  type UiThemeId,
} from '../theme/uiTheme'
import {
  PERSISTED_USER_DATA_REGISTRY,
  persistRegistered,
} from './persistedKeys'
import { isAvailableLanguage, SOURCE_LANGUAGE } from '../i18n/catalogs'
import {
  BRIDGE_DEFAULT_PORT,
  installVfdPortMemory,
  noteBridgeMachineId,
} from '../lib/machine/bridgeTransport'

// ---------------------------------------------------------------------------
// UI preferences slice (action-plan Phase 5, P8 + P9)
// ---------------------------------------------------------------------------
// A SEPARATE persisted store from the project (key "liencam-ui-prefs"). It
// holds browser-local UI setup and per-machine connection details that must
// SURVIVE RELOAD and follow the user across projects/sessions. Kept out of the
// project store on purpose - these settings are not part of a saved
// .camproject and must not travel with an exported project file.
//
// Today it carries:
//   - panel widths (P8 resizable panels)
//   - collapsed props groups, keyed by GROUP TYPE (P9 collapsible sections)
//   - design-tree row density (Phase 6, P10): 'default' | 'compact'
//   - per-machine controller link details (WO-997)
//   - the interface language (WO-2319; src/i18n applies it)
// Later phases reuse the same slice without a new storage key.

// Panel width bounds — MUST match the tier-3 tokens in src/theme/tokens.css
// (--panel-left-min/max, --panel-right-min/max). Defaults match the at-rest
// token widths (--panel-left-w 280, --panel-right-w 260).
export const PANEL_LEFT_MIN = 220
// WO-1494 (BUG-476 fix): raised from 460. The wide-screen default
// (PANEL_LEFT_WIDE_DEFAULT * uiScale, max auto-scale 1.5x) resolves to 480px
// — resolveEffectivePanelWidth reports that as the panel's real rendered
// width (criterion: PanelResizer's baseline must equal the actually-rendered
// width, never a smaller "customizable" ceiling), so the manual-resize max
// must clear it with room for at least one keyboard step, or a customizing
// drag/keypress from that baseline would clamp DOWN and shrink the panel —
// the same jump this WO exists to remove, just in the other direction.
// tokens.css's --panel-left-max mirror (currently still 460px) is out of
// this WO's owned paths; that CSS var has no consumer (grepped, unused for
// layout) so nothing regresses, but it is now stale and should be bumped to
// match in a follow-up.
export const PANEL_LEFT_MAX = 520
export const PANEL_LEFT_DEFAULT = 280
export const PANEL_RIGHT_MIN = 240
export const PANEL_RIGHT_MAX = 460
export const PANEL_RIGHT_DEFAULT = 260
export const PANEL_LEFT_WIDE_DEFAULT = 320
export const PANEL_RIGHT_WIDE_DEFAULT = 300

// Control-tab (machine control) column bounds. The left column must fit the
// operator DRO at full capacity (sign + 9999.999 / 999.9999 at 34px mono)
// plus the machine-coordinate column and the zero buttons.
export const MACHINE_PANEL_LEFT_MIN = 280
export const MACHINE_PANEL_LEFT_MAX = 560
export const MACHINE_PANEL_LEFT_DEFAULT = 350
export const MACHINE_PANEL_RIGHT_MIN = 240
export const MACHINE_PANEL_RIGHT_MAX = 520
export const MACHINE_PANEL_RIGHT_DEFAULT = 280

// WO-137: program preview/list divider default split (the preview pane's
// share of the control column, in percent). Measured and landed in WO-117
// (737.4px at 1913x903); declared here so the store owns its own field's
// default. Re-exported by ProgramDivider.tsx for its existing callers/tests.
export const PROGRAM_PREVIEW_DEFAULT_PERCENT = 60

export const UI_PREFS_STORAGE_KEY = PERSISTED_USER_DATA_REGISTRY.uiPreferences.key
/** v1 changes the workbench projection default from perspective to
 * orthographic. The version boundary is also the one-time marker that lets a
 * later, deliberate perspective choice survive future reloads. */
export const UI_PREFS_VERSION = 1

// Design-tree row density (Phase 6, P10). 'compact' switches the tree root to
// the tighter --row-compact rhythm (tokens.css); 'default' keeps --row-default.
export type TreeDensity = 'default' | 'compact'
export const TREE_DENSITY_DEFAULT: TreeDensity = 'compact'

// WO-1154: interface scale is browser-local UI setup. Auto deliberately keys
// off PHYSICAL width as well as DPR: a 4K display at Windows 150% scaling has
// enough physical pixels, but its OS scaling already makes the interface large
// enough and must therefore stay at 1.0.
export type UiScalePreference = 'auto' | 0.8 | 0.9 | 1 | 1.25 | 1.5
export const UI_SCALE_DEFAULT: UiScalePreference = 'auto'

export function isUiScalePreference(value: unknown): value is UiScalePreference {
  return value === 'auto' || value === 0.8 || value === 0.9 || value === 1 || value === 1.25 || value === 1.5
}

export function resolveUiScale(
  preference: UiScalePreference,
  viewportCssWidth: number,
  devicePixelRatio: number,
): number {
  if (preference !== 'auto') return preference
  const cssWidth = Number.isFinite(viewportCssWidth) ? Math.max(0, viewportCssWidth) : 0
  const dpr = Number.isFinite(devicePixelRatio) ? Math.max(0, devicePixelRatio) : 1
  return cssWidth * dpr >= 3200 && dpr <= 1.1 ? 1.5 : 1
}

// Design-tree SECTION expand/collapse (Stock / Geometry / Setups headers). These
// three top-level sections default to EXPANDED; lifting them out of component
// useState into the persisted store is what makes a page refresh return the tree
// to the user's last expand/collapse layout (was: every refresh sprang the
// Geometry section back open).
export type TreeSection = 'stock' | 'geometry' | 'setups'

// Last-used New Nest control values (P4.3). Structurally typed here so uiPrefs
// stays free of component imports; the modal owns the canonical NestSettings type
// + the validating mergeNestSettings() that reads this back. Stored as-is on
// Calculate, validated on read (never trusted blindly on rehydrate).
export interface NestSettingsPref {
  solver: string
  sheet: { width: number; height: number }
  style: string
  rotationCount: number
  spacing: { partGap: number; sheetMargin: number; windowGap: number }
  /** Last-used sheet Z thickness (mm). Validated on read by mergeNestSettings;
   *  absent for pre-thickness stored values (falls back to the app default). */
  thickness?: number
  /** Last-used multi-copy cut ordering (P7). Validated on read by
   *  mergeNestSettings; absent for pre-P7 stored values (falls back to
   *  'by-operation', the default). */
  machiningOrder?: string
  /** Auto-size ratio constraint (only used by solver 'fixQty-none'). Validated on
   *  read by mergeNestSettings; absent for pre-P4.3b stored values. */
  ratioLocked?: boolean
  ratioW?: number
  ratioH?: number
}

/** Per-computer connection details keyed by machine profile id. These settings
 * follow the physical machine on this browser but never travel in a project
 * file. Later controller-setup slices extend this shape. */
export interface MachineBridgeLaunchSettings {
  installRoot?: string
  profile?: string
  board?: number | 'auto'
  vfdDefinition?: string
}

export interface MachineLinkSettings extends MachineBridgeLaunchSettings {
  bridgePort?: number
  /** WO-1000: the serial port the operator chose for THIS machine's spindle
   *  (VFD) link on the bridge - MACHINE-SETTINGS-DESIGN.md 3.2 gate 4, "the app
   *  remembers the chosen port in `appSettings.machineLinks[machineId]` and
   *  re-sends it after `hello` on every connect".
   *
   *  It is the operator's standing CHOICE, never a reading: what the link is
   *  actually on only ever comes from the bridge's `vfd` push (gate 3). Absent
   *  means "never chosen", which is not the same as "no port" and is what keeps
   *  a fresh install from asking a bridge to move a link it is happy on. */
  vfdPort?: string
}

export const INVALID_BRIDGE_PORT_MESSAGE =
  operatorText('uiPrefs1')

function requireBridgePort(port: unknown): asserts port is number {
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(INVALID_BRIDGE_PORT_MESSAGE)
  }
}

export const INVALID_VFD_PORT_MESSAGE =
  operatorText('uiPrefs2')

function requireVfdPort(port: unknown): asserts port is string {
  if (typeof port !== 'string' || port.trim() === '') {
    throw new Error(INVALID_VFD_PORT_MESSAGE)
  }
}

export function clampPanelWidth(side: 'left' | 'right', w: number): number {
  const [min, max] = side === 'left'
    ? [PANEL_LEFT_MIN, PANEL_LEFT_MAX]
    : [PANEL_RIGHT_MIN, PANEL_RIGHT_MAX]
  if (!Number.isFinite(w)) return side === 'left' ? PANEL_LEFT_DEFAULT : PANEL_RIGHT_DEFAULT
  return Math.min(max, Math.max(min, Math.round(w)))
}

// WO-1494 (BUG-475/BUG-476, shared cause): the .app-main width this reserves
// when both panels' preferred widths would not otherwise fit the viewport.
export const APP_MAIN_MIN_WIDTH = 240

export interface PanelWidthAuthorityInputs {
  panelLeftWidth: number
  panelLeftWidthCustomized: boolean
  panelRightWidth: number
  panelRightWidthCustomized: boolean
  /** window.innerWidth (CSS px), the same value App.tsx already tracks for wideDefaults/uiScale. */
  viewportCssWidth: number
  /** resolveUiScale(...)'s result — the SAME scale App.tsx applies to the root font-size. */
  uiScale: number
}

/** WO-1494: the ONE authority for "how wide is this panel right now, in real
 *  CSS pixels" — every input that used to be read separately by App.tsx's
 *  render style (raw preference, OR the wide-screen rem default scaled by
 *  --ui-scale) and by PanelResizer's drag baseline/aria-valuenow/keyboard math
 *  (the raw stored preference alone, BUG-476) now goes through this one
 *  function instead. It also reconciles BUG-475: a viewport too small for both
 *  panels' preferred widths compresses them (never below their own MIN)
 *  instead of leaving .app-main to collapse to 0 with no floor. Preferred
 *  widths pass through unchanged whenever the viewport can fit them. */
export function resolveEffectivePanelWidth(
  side: 'left' | 'right',
  inputs: PanelWidthAuthorityInputs,
): number {
  const {
    panelLeftWidth, panelLeftWidthCustomized,
    panelRightWidth, panelRightWidthCustomized,
    viewportCssWidth, uiScale,
  } = inputs
  const scale = Number.isFinite(uiScale) && uiScale > 0 ? uiScale : 1
  const wide = viewportCssWidth > 2560
  const leftPreferred = wide && !panelLeftWidthCustomized
    ? PANEL_LEFT_WIDE_DEFAULT * scale
    : panelLeftWidth
  const rightPreferred = wide && !panelRightWidthCustomized
    ? PANEL_RIGHT_WIDE_DEFAULT * scale
    : panelRightWidth

  const totalPreferred = leftPreferred + rightPreferred
  if (
    !Number.isFinite(viewportCssWidth) || viewportCssWidth <= 0 ||
    totalPreferred <= 0 ||
    totalPreferred + APP_MAIN_MIN_WIDTH <= viewportCssWidth
  ) {
    return side === 'left' ? leftPreferred : rightPreferred
  }

  // Too tight for both preferred widths — compress proportionally, but never
  // below each panel's own floor, so .app-main keeps its reserved minimum and
  // both panels stay visually present instead of one being squeezed to 0.
  const available = Math.max(PANEL_LEFT_MIN + PANEL_RIGHT_MIN, viewportCssWidth - APP_MAIN_MIN_WIDTH)
  const compression = available / totalPreferred
  const leftEffective = Math.max(PANEL_LEFT_MIN, Math.round(leftPreferred * compression))
  const rightEffective = Math.max(PANEL_RIGHT_MIN, Math.round(rightPreferred * compression))
  return side === 'left' ? leftEffective : rightEffective
}

/** WO-1494 fix round (audit FAIL): the exact inverse of
 *  resolveEffectivePanelWidth's compression branch. PanelResizer's drag
 *  baseline and keyboard math now operate in EFFECTIVE (rendered) space
 *  (criteria 2/3 require that), so a drag/keypress computes its next value as
 *  a target EFFECTIVE width — but `setPanelWidth` stores a PREFERENCE, and
 *  resolveEffectivePanelWidth compresses whatever preference it is given.
 *  Storing the target effective width verbatim as the preference therefore
 *  compresses it a SECOND time, so the panel renders narrower than the
 *  target the operator dragged/keyed to — including, when the target is
 *  BELOW the current stored preference's rendered size, narrower than
 *  before a widening ArrowRight/drag-right.
 *
 *  Given the other panel's own preferred width and the fixed `available`
 *  budget, resolveEffectivePanelWidth's compressed-branch formula is
 *  `target = P * available / (P + other)` for the preference P this
 *  function is solving for. Solved: `P = target * other / (available -
 *  target)`. When the target does not require compression at all (it and
 *  the other panel's preferred width both fit the viewport), the preference
 *  IS the target — no inversion needed. */
export function resolvePreferenceForEffectiveWidth(
  side: 'left' | 'right',
  targetEffectiveWidth: number,
  inputs: PanelWidthAuthorityInputs,
): number {
  const {
    panelLeftWidthCustomized,
    panelRightWidth, panelRightWidthCustomized,
    panelLeftWidth,
    viewportCssWidth, uiScale,
  } = inputs
  const scale = Number.isFinite(uiScale) && uiScale > 0 ? uiScale : 1
  const wide = viewportCssWidth > 2560
  // The side NOT being resized keeps its own current preferred width exactly
  // as resolveEffectivePanelWidth would read it — a resize never touches the
  // other panel's stored preference.
  const otherPreferred = side === 'left'
    ? (wide && !panelRightWidthCustomized ? PANEL_RIGHT_WIDE_DEFAULT * scale : panelRightWidth)
    : (wide && !panelLeftWidthCustomized ? PANEL_LEFT_WIDE_DEFAULT * scale : panelLeftWidth)

  if (!Number.isFinite(targetEffectiveWidth)) return targetEffectiveWidth

  const totalIfUncompressed = targetEffectiveWidth + otherPreferred
  if (
    !Number.isFinite(viewportCssWidth) || viewportCssWidth <= 0 ||
    totalIfUncompressed + APP_MAIN_MIN_WIDTH <= viewportCssWidth
  ) {
    // No compression applies at this target — the preference IS the target.
    return targetEffectiveWidth
  }

  const available = Math.max(PANEL_LEFT_MIN + PANEL_RIGHT_MIN, viewportCssWidth - APP_MAIN_MIN_WIDTH)
  let preference: number
  if (targetEffectiveWidth >= available) {
    // Unreachable even with the other panel floored — saturate high; the
    // caller's own clampPanelWidth ceilings this to the panel's real max.
    preference = side === 'left' ? PANEL_LEFT_MAX * 10 : PANEL_RIGHT_MAX * 10
  } else {
    preference = (targetEffectiveWidth * otherPreferred) / (available - targetEffectiveWidth)
  }

  // Audit FAIL (re-queue 2026-09-14): resolveEffectivePanelWidth floors this
  // side's effective width at its own MIN, so every preference at or below
  // the threshold that first reaches that floor maps to the SAME effective
  // width — the formula above always resolves to that threshold's UPPER
  // end, which is a jump UP whenever the panel is already sitting at (or
  // below) its floor. A narrowing gesture must never raise the stored
  // preference or disturb the other panel, so once the target would not
  // widen this panel past what it is already effectively rendering, cap the
  // result at the CURRENT stored preference instead of un-flooring it.
  const currentEffective = resolveEffectivePanelWidth(side, inputs)
  if (targetEffectiveWidth <= currentEffective) {
    preference = Math.min(preference, side === 'left' ? panelLeftWidth : panelRightWidth)
  }
  return Math.round(preference)
}

/** WO-2059: how a probing routine senses the face - the probe itself, or a
 *  plate held against it. Mirrors probeFeatureCycle.ts `ProbeSensing`. */
export type ProbeSensingChoice = 'probe' | 'plate'

function isProbeSensingChoice(value: unknown): value is ProbeSensingChoice {
  return value === 'probe' || value === 'plate'
}

/** Rehydrate guard: keep only string-keyed machines whose routines hold a
 *  recognised choice. A hand-edited or partial blob drops the bad entries,
 *  which reads as the first-time default (the probe). */
function validProbeSensingByMachine(value: unknown): Record<string, Record<string, ProbeSensingChoice>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, Record<string, ProbeSensingChoice>> = {}
  for (const [machineId, routines] of Object.entries(value)) {
    if (routines === null || typeof routines !== 'object' || Array.isArray(routines)) continue
    const kept = Object.fromEntries(Object.entries(routines)
      .filter((entry): entry is [string, ProbeSensingChoice] => isProbeSensingChoice(entry[1])))
    if (Object.keys(kept).length > 0) out[machineId] = kept
  }
  return out
}

interface UiPrefsState {
  /** Left (DesignTree) panel width in px. */
  panelLeftWidth: number
  /** Right (Properties) panel width in px. */
  panelRightWidth: number
  /** True after the operator has deliberately resized this panel. */
  panelLeftWidthCustomized: boolean
  panelRightWidthCustomized: boolean
  /** Collapsed props groups, keyed by stable group type id. true = collapsed. */
  collapsedPropsGroups: Record<string, boolean>
  /** Design-tree row density (P10). 'compact' = tighter --row-compact rhythm. */
  treeDensity: TreeDensity
  /** MACHINE-CONTROL jog prefs: last-used step distance (mm), feed (mm/min),
   *  and step-vs-hold mode. UI setup that survives reload - never project
   *  data, and never live machine state (that lives in machineControlStore,
   *  which is deliberately unpersisted). */
  machineJogStepMm: number
  machineJogFeedMmMin: number
  machineJogContinuous: boolean
  /** Control-tab display units: 'default' follows Settings > Display units;
   *  'mm'/'inch' override it (and drive G20/G21 on the controller). */
  machineDisplayUnits: 'default' | 'mm' | 'inch'
  /** Per-machine connection settings stored on this computer. An absent bridge
   *  port deliberately means the shipping bridge default. */
  machineLinks: Record<string, MachineLinkSettings>
  /** WO-303: "do not ask again" for the DRO-readout goto confirm dialog.
   *  Default FALSE - the WO is explicit that the default is to ask. Once set,
   *  a typed coordinate rapids immediately with no confirm card; the store
   *  is the only way back to asking (there is no un-check control on the
   *  card itself, only the checkbox that sets it). */
  machineGotoSkipConfirm: boolean
  /** Control-tab console collapsed to its latest line only. Default TRUE -
   *  the g-code path preview is first-class (Operator rule 2026-07-31) and the
   *  console must not eat its vertical space unless deliberately expanded. */
  machineConsoleCollapsed: boolean
  /** Control-tab Work offsets panel collapsed to the ACTIVE system's row only.
   *  Default TRUE (Operator 2026-07-31): the full six-system table is a setup-time
   *  view; collapsed it leaves the left column room for the safety cluster and
   *  the tool table without scrolling. */
  machineOffsetsCollapsed: boolean
  /** Control-tab g-code line list rail collapsed (preview takes full width). */
  machineLineListCollapsed: boolean
  /** Control-tab Cycle log panel collapsed. Default TRUE - history is a
   *  glance-when-needed view; the left column's safety cluster comes first. */
  machineCycleLogCollapsed: boolean
  /** Control-tab manual spindle RPM (feeds the {rpm} action placeholder). */
  machineSpindleRpm: number
  /** Control-tab column widths (px), clamped by the MACHINE_PANEL_* bounds. */
  machineLeftPanelW: number
  machineRightPanelW: number
  /** True after the operator deliberately resizes a Control side column. */
  machineLeftPanelWCustomized: boolean
  machineRightPanelWCustomized: boolean
  /** Control-tab program preview/list divider position (percent of the
   *  control column the preview pane gets). WO-137: declared here so a build
   *  fails if it is dropped, and validated on rehydrate (merge) with a 60%
   *  fallback for non-number/out-of-range/absent values. Default 60 --
   *  measured, landed WO-117; the pane minimums live in ProgramDivider. */
  machineProgramPreviewPercent: number
  /** WO-2430: sizes (px) of the shared ResizableSplit panes, keyed by each
   *  screen's panel key (e.g. 'control-tools-jog'). Absent = that screen's
   *  declared default; the component clamps to the screen's bounds, so a
   *  stale value can never shrink a panel below its minimum. Validated on
   *  rehydrate (finite positive numbers only). */
  panelSizes: Record<string, number>
  /** Collapsed geometry-folder ids (Stage A). Folders default to EXPANDED, so we
   *  store only the COLLAPSED ones (presence = collapsed). Persisted + survives
   *  reload (UI setup, never in the project/undo). */
  collapsedFolderIds: string[]
  /** Collapsed nest-node ids (N1a). Nest nodes render folder-like inside the
   *  Geometry section and default to EXPANDED, so we store only the COLLAPSED
   *  ones (presence = collapsed). Persisted + survives reload, mirroring
   *  collapsedFolderIds. */
  collapsedNestIds: string[]
  /** Expanded nest-SEED child ids (seed layer eyes). The seed child row under a
   *  nest node is collapsed by DEFAULT (its layer rows only show on demand), so
   *  we store the EXPANDED ones (presence = expanded) — the inverse of
   *  collapsedNestIds. Keyed by the owned-seed geometry id. Persisted + survives
   *  reload, mirroring the other tree expand/collapse prefs. */
  expandedSeedIds: string[]
  /** Expanded "Derived geometry (N)" group ids (R5). A part's auto-generated
   *  projection layers (deriveBrepLayer: face/edges/holes/cylinder/section)
   *  collapse under a single group row that is COLLAPSED by default, so we store
   *  the EXPANDED ones (presence = expanded), mirroring expandedSeedIds. Keyed by
   *  the owning geometry id. Persisted + survives reload; never in project/undo.
   *  Tree-display only — does NOT affect a layer's `visible`/viewport state. */
  expandedDerivedGeoIds: string[]
  /** Design-tree SECTION expand state (refresh-persistence). The three top-level
   *  section headers default to EXPANDED (true); persisting them means a refresh
   *  restores exactly the user's last open/closed sections instead of springing
   *  the Geometry section back open. Mirrors the existing collapsed*Ids pattern
   *  but is stored as plain booleans (one flag per fixed section). */
  treeStockExpanded: boolean
  treeGeometryExpanded: boolean
  treeSetupsExpanded: boolean
  /** Expanded setup-node ids (operations sub-list). Setups default COLLAPSED, so
   *  presence = expanded. Persisted + survives reload, mirroring expandedSeedIds.
   *  Keyed by setup id (stale ids for a different project are harmless). */
  expandedSetupIds: string[]
  /** Operation folders default expanded, so presence means collapsed. */
  collapsedOperationFolderIds: string[]
  /** Expanded layer keys ("geoId:layerId") whose loop sub-list is open. Default
   *  COLLAPSED, so presence = expanded. Persisted + survives reload. */
  expandedLayerKeys: string[]
  /** Collapsed part ids (geoIds whose 2D layers are folded). Parts default
   *  EXPANDED, so presence = COLLAPSED — the inverse of the expanded* sets, but
   *  the same string[] storage shape. Persisted + survives reload. */
  collapsedPartIds: string[]
  /** Expanded stock node ids (fields open). Stock nodes default COLLAPSED (Tier 4
   *  declutter), so presence = expanded. Persisted + survives reload. */
  expandedStockIds: string[]
  /** Toolpath-legend expanded state (clutter-audit P10). The 11-toggle legend
   *  collapses to a single "Legend" chip at rest; Operator's verdict requires the
   *  expand/collapse state to PERSIST ("if you have it expanded it stays
   *  expanded"), so it lives here (UI setup, never in the project/undo).
   *  Default false = collapsed chip (the decluttered at-rest state). */
  tpLegendExpanded: boolean
  /** Last viewport camera pose (refresh-persistence). Restored on the Viewport
   *  MOUNT (a real page load/refresh) so the scene returns to the user's last
   *  framing; File>New/Open do not remount the viewport, so they keep their own
   *  framing. projectId is recorded for diagnostics only (this app regenerates
   *  project.id on every page load, so it cannot gate the restore). null until the
   *  first camera move. */
  savedCamera: { projectId: string; camera: SerializedCamera } | null
  /** Last-used New Nest CONTROL values (P4.3), prefilled on a fresh modal open so
   *  an iterating user does not retype. ONLY controls are remembered — part-picker
   *  selections are NOT (they depend on the current project geometry). Stored as a
   *  loose record; the modal validates/merges it (mergeNestSettings) on read. null
   *  until the first nest is calculated. */
  lastNestSettings: NestSettingsPref | null
  /** WO UI-17 (criterion 5, workbench): genesis rows (Origin / XY / XZ / YZ)
   *  whose always-on viewport glyph the user hid via the tree eye toggle.
   *  Default VISIBLE, so presence = hidden — the same inverse-set storage
   *  shape collapsedPartIds uses. Persisted + survives reload (view state
   *  goes through uiPrefs per COHESION-STANDARD/DESIGN-REVIEW-CHECKLIST item
   *  2 — never ad-hoc localStorage), and never in the document/undo. */
  workbenchHiddenGenesisIds: string[]
  /** WO UI-23 (C4), UI-34: workbench camera projection -- Perspective /
   *  Orthographic, set from the display-mode flyout. Default 'orthographic'.
   *  View state, not project data
   *  (COHESION-STANDARD item 2 — never ad-hoc localStorage), so it lives here
   *  alongside workbenchHiddenGenesisIds rather than in the document. */
  workbenchCameraProjection: CameraProjectionMode
  /** WO UI-18 (D1): collapsed workbench left-panel section ids (Model / Bodies /
   *  Parameters / Inspect). Sections default EXPANDED, so presence = collapsed —
   *  the same inverse-set storage shape collapsedFolderIds uses. Persisted +
   *  survives remount/reload (Operator's scrolling complaint: the panel should
   *  remember what the user folded). */
  workbenchCollapsedSections: string[]
  /** SKC-46 (T-SKC44-FILLETDRAG follow-up): the last COMMITTED sketch fillet radius / chamfer
   *  setback, or null before the user has ever applied one. Shared by BOTH sketcher hosts (CAM and
   *  the workbench) through this one persist surface -- per-tool, survives refresh and follows the
   *  user across projects, exactly like every other UI-setup field here. Never part of the saved
   *  project (a fresh document still remembers the user's last size). */
  lastFilletRadius: number | null
  lastChamferSetback: number | null
  // ── WO-270: brand identity, not a free for all ─────────────────────────────
  // Operator ruling 2026-08-12: "We should pick a look and stick with it, I want to
  // remove the UI theme, Viewport Theme, and selection glow settings. We need
  // brand identity, not a free for all."
  //
  // The two fields below are NO LONGER PREFERENCES. There is no setter, no
  // Settings control, and the persist `merge` below pins them to the shipped
  // constants so a value stored by the removed controls can never come back.
  //
  // WO-286 removed their LAST READER: CNCViewport.ts now imports
  // DEFAULT_VIEWPORT_THEME / DEFAULT_SELECTION_GLOW directly instead of
  // reading and subscribing to state that can never change. Nothing in the
  // app reads either field any more.
  //
  // They are still declared here ONLY because deleting them turns
  // src/tests/components/settingsThemeRemoval.wo270.test.tsx red (it asserts
  // these two fields resolve to the constants, lines 126-127) and that file is
  // outside WO-286's owned paths -- WO-286 names the STOP explicitly. Deleting
  // these four lines plus the two `merge` pins below, and retargeting those
  // two assertions at the resolved look, is the whole remaining follow-up.
  /** Frozen at DEFAULT_VIEWPORT_THEME ('brand-blue'). Read-only, and as of
   *  WO-286 read by nothing. */
  viewportTheme: ViewportThemeId
  /** Frozen at DEFAULT_SELECTION_GLOW ('signature'). Read-only, and as of
   *  WO-286 read by nothing. */
  selectionGlow: SelectionGlowCandidateId

  /** WO-324 (Operator, verdict on card Q-THE-AMBER-THEME-SEE-ALL-OF-IT-AN-
   *  1786569820206, 2026-08-12: "Make it an alternate theme in settings. I
   *  will need to drive it for a while before I can decide."): the ONE
   *  appearance choice Settings exposes -- 'default' (unchanged look) or
   *  'amber' (the WO-307 identity-study palette, tokens.css). This is an
   *  evaluation switch Operator is actively driving, not a return to the
   *  free-for-all WO-270 removed -- exactly two ids exist (UI_THEME_IDS),
   *  and 'high-contrast' (the older THEME-HICONTRAST-BUILD block, still in
   *  tokens.css) is deliberately NOT one of them any more, so a value stored
   *  under that id resolves to 'default' via isUiThemeId, same as any other
   *  unrecognized string (see the persist `merge` below). View state, not
   *  project data (COHESION-STANDARD item 2), so it lives here. Default
   *  DEFAULT_UI_THEME ('default') -- opt-in only, current look never changes
   *  for a user who does not switch. */
  uiTheme: UiThemeId
  /** WO-1200: a persisted light/dark axis independent of uiTheme. */
  uiColorMode: UiColorMode

  /** WO-1154: Auto, or an explicit interface zoom chosen in Settings. */
  uiScale: UiScalePreference

  /** WO-1904: when true, importing a DXF keeps the drawing's own origin (the
   *  file's 0,0 is LienCAM's 0,0) instead of re-centring on the loops' bounding
   *  box. Default FALSE = today's re-centring, byte-identical to main. The one
   *  remembered preference both DXF import routes read; browser-local UI setup
   *  like every other field here, never project data. */
  dxfKeepOrigin: boolean

  /** WO-1904: set the DXF drawing-origin preference (a boolean has exactly two
   *  answers - a non-boolean write is a caller bug and writes nothing). */
  setDxfKeepOrigin: (keep: boolean) => void

  /** WO-2319: the interface language, a code with a catalog under
   *  src/i18n/locales/ ('en' unless the operator picked another). Browser-local
   *  like every field here; never project data. */
  language: string
  /** WO-2319: pick the interface language. A code without a catalog writes
   *  nothing (same refusal shape as setUiTheme). */
  setLanguage: (language: string) => void

  /** Live-set a panel width (clamped to its bounds). */
  setPanelWidth: (side: 'left' | 'right', width: number) => void
  /** Reset one panel to its default width (double-click handle). */
  resetPanelWidth: (side: 'left' | 'right') => void
  /** Flip the collapsed state of a props group by type id. */
  togglePropsGroup: (groupId: string) => void
  /** WO-2430: record a panel's collapsed state explicitly in the same
   *  collapsedPropsGroups record, so a panel that is folded by default can
   *  remember "expanded" (an absent key means the panel's own default). */
  setPanelCollapsed: (key: string, collapsed: boolean) => void
  /** WO-2430: store one ResizableSplit pane size (px). */
  setPanelSize: (key: string, size: number) => void
  /** WO-2430: forget one pane size, so the screen's default applies again. */
  resetPanelSize: (key: string) => void
  /** Read a group's collapsed state (default expanded). */
  isPropsGroupCollapsed: (groupId: string) => boolean
  /** Set the design-tree row density. */
  setTreeDensity: (density: TreeDensity) => void
  /** Flip between default and compact density. */
  toggleTreeDensity: () => void
  /** Flip a geometry folder's collapsed state (default expanded). */
  toggleFolderCollapsed: (folderId: string) => void
  /** Read a folder's collapsed state (default false = expanded). */
  isFolderCollapsed: (folderId: string) => boolean
  /** Flip a nest node's collapsed state (default expanded). */
  toggleNestCollapsed: (nestId: string) => void
  /** Read a nest node's collapsed state (default false = expanded). */
  isNestCollapsed: (nestId: string) => boolean
  /** Flip a nest seed child's expanded state (default false = collapsed). */
  toggleSeedExpanded: (seedId: string) => void
  /** Read a nest seed child's expanded state (default false = collapsed). */
  isSeedExpanded: (seedId: string) => boolean
  /** Flip a part's derived-geometry group expanded state (default collapsed). */
  toggleDerivedExpanded: (geoId: string) => void
  /** Read a part's derived-geometry group expanded state (default false = collapsed). */
  isDerivedExpanded: (geoId: string) => boolean
  /** Remember the last-used New Nest control values (P4.3). */
  setLastNestSettings: (settings: NestSettingsPref) => void
  /** Flip the toolpath legend's expanded state (P10; persisted). */
  toggleTpLegendExpanded: () => void

  /** Save the last camera pose for a project (debounced caller; refresh restore). */
  setSavedCamera: (projectId: string, camera: SerializedCamera) => void

  // ── Design-tree expand/collapse persistence (refresh restores last layout) ──
  /** Set one top-level section's expanded flag. */
  setTreeSectionExpanded: (section: TreeSection, expanded: boolean) => void
  /** Flip one top-level section's expanded flag. */
  toggleTreeSection: (section: TreeSection) => void
  /** Replace the expanded-setup id list (bulk expand/collapse all). */
  setExpandedSetupIds: (ids: string[]) => void
  /** Flip a single setup node's expanded state. */
  toggleExpandedSetup: (id: string) => void
  toggleOperationFolderCollapsed: (folderId: string) => void
  isOperationFolderCollapsed: (folderId: string) => boolean
  /** Replace the expanded-layer key list (bulk). */
  setExpandedLayerKeys: (keys: string[]) => void
  /** Flip a single layer's ("geoId:layerId") expanded state. */
  toggleExpandedLayer: (key: string) => void
  /** Replace the collapsed-part id list (bulk). */
  setCollapsedPartIds: (ids: string[]) => void
  /** Flip a single part's collapsed state. */
  toggleCollapsedPart: (id: string) => void
  /** Replace the expanded-stock id list (bulk). */
  setExpandedStockIds: (ids: string[]) => void
  /** Flip a single stock node's expanded state. */
  toggleExpandedStock: (id: string) => void
  /** Mark a stock node expanded (no-op if already expanded) — used when adding a
   *  new stock so its fields open for immediate editing. */
  addExpandedStock: (id: string) => void

  /** WO UI-17: flip a workbench genesis row's glyph visibility (default visible). */
  toggleWorkbenchGenesisHidden: (id: string) => void
  /** WO UI-17: read a workbench genesis row's glyph-hidden state (default false). */
  isWorkbenchGenesisHidden: (id: string) => boolean

  /** WO UI-23 (C4): set the persisted workbench camera projection preference. */
  setWorkbenchCameraProjection: (mode: CameraProjectionMode) => void

  /** WO UI-18 (D1): flip a workbench left-panel section's collapsed state (default expanded). */
  toggleWorkbenchSectionCollapsed: (sectionId: string) => void
  /** WO UI-18 (D1): read a workbench left-panel section's collapsed state (default false = expanded). */
  isWorkbenchSectionCollapsed: (sectionId: string) => boolean

  /** SKC-46: remember the last COMMITTED fillet radius / chamfer setback. */
  setLastFilletRadius: (value: number) => void
  setLastChamferSetback: (value: number) => void

  /** Set the bridge port for one machine. Invalid input is refused instead of
   *  being replaced with a plausible but wrong default. */
  setMachineBridgePort: (machineId: string, port: number) => void

  /** Remember one launch-time bridge choice for this machine. An undefined
   * value removes the choice, returning that flag to the safe host default. */
  setMachineBridgeLaunchSetting: (
    machineId: string,
    key: keyof MachineBridgeLaunchSettings,
    value: string | number | undefined,
  ) => void

  /** WO-1000: remember the spindle link's serial port for one machine. Only a
   *  port the BRIDGE ACCEPTED is ever written here (bridgeTransport.ts), so a
   *  port that would not open never becomes a standing choice to be re-sent on
   *  every future connect. Invalid input is refused, not defaulted. */
  setMachineVfdPort: (machineId: string, port: string) => void

  /** WO-324: set the persisted UI theme (immediate apply via the
   *  module-level subscription below -- setting/removing the `data-theme`
   *  attribute on the document root re-flows every CSS custom property read
   *  on the next paint, no reload required). Rejects an unrecognized id
   *  (ADR-0003: never let a bad write corrupt the store). */
  setUiTheme: (theme: UiThemeId) => void
  /** WO-1263: select the Machine Definition page's used-only view. The legacy
   *  storage key is retained so existing operator preferences keep working.
   *  Default TRUE - "first order retrievability" is the landing state. */
  machineDefHideEmptySettings: boolean
  setMachineDefHideEmptySettings: (hide: boolean) => void
  /** WO-1263: catalog groups the operator explicitly classified as unused,
   *  keyed by machine. Empty by default: an import is not evidence that any
   *  valued setting is unused. */
  machineDefHiddenSettingGroups: Record<string, string[]>
  toggleMachineDefSettingGroupHidden: (machineId: string, group: string) => void
  /** WO-2059: each probing routine's sensing choice, keyed by machine then
   *  routine - 'probe' (the probe touches the part) or 'plate' (a plate held
   *  against it). Absent is the first-time default, the probe. It is setup on
   *  this computer, so an app reload must not quietly change a plate routine
   *  back to probe-on-part math. machineSession.ts owns the routine names. */
  probeSensingByMachine: Record<string, Record<string, ProbeSensingChoice>>
  setProbeSensingChoice: (machineId: string, routine: string, sensing: ProbeSensingChoice) => void

  /** Set the persisted interface scale preference. Invalid writes are refused. */
  setUiScale: (scale: UiScalePreference) => void
  setUiColorMode: (mode: UiColorMode) => void
}

/** WO-270: the ONE selection/hover glow the app ships. Kept as a function
 *  rather than inlined at each call site because the non-component consumers
 *  (CNCViewport.ts, sketchLayer.ts) already read the glow through it and both
 *  are outside this work order's owned paths. It no longer reads the store:
 *  there is nothing left to read, only the shipped constant. */
export function getSelectionGlow(): SelectionGlowCandidateId {
  return DEFAULT_SELECTION_GLOW
}

/** UI-34 one-time default migration. Version-0 blobs cannot distinguish an
 * explicit Perspective choice from UI-23's then-default Perspective value, so
 * every v0 blob adopts the new Orthographic default once. The rewritten v1
 * blob is the durable discriminator: a Perspective choice made after this
 * migration is v1 and passes through unchanged. */
function migrateUiPrefs(persistedState: unknown, version: number): UiPrefsState {
  const state = persistedState as UiPrefsState
  if (version < UI_PREFS_VERSION && state !== null && typeof state === 'object') {
    return { ...state, workbenchCameraProjection: 'orthographic' }
  }
  return state
}

export const useUiPrefs = create<UiPrefsState>()(
  // subscribeWithSelector gives non-React consumers (a plain TS class, not a
  // React component) a `subscribe(selector, listener)` overload the plain
  // zustand `subscribe(listener)` API does not have. GEO-25 added it for
  // CNCViewport.ts's `viewportTheme` subscription; WO-286 removed that
  // subscription and no selector subscriber is left in src/. Kept because
  // dropping the middleware narrows this store's public subscribe API, which
  // is a change of its own -- it belongs with the field deletion WO-286 had to
  // leave behind (see the field docs above), not smuggled in beside it.
  subscribeWithSelector(
  persistRegistered('uiPreferences',
    (set, get) => ({
      panelLeftWidth: PANEL_LEFT_DEFAULT,
      panelRightWidth: PANEL_RIGHT_DEFAULT,
      panelLeftWidthCustomized: false,
      panelRightWidthCustomized: false,
      collapsedPropsGroups: {},
      treeDensity: TREE_DENSITY_DEFAULT,
      machineJogStepMm: 1,
      machineJogFeedMmMin: 1000,
      machineJogContinuous: false,
      machineDisplayUnits: 'default',
      machineLinks: {},
      machineGotoSkipConfirm: false,
      machineConsoleCollapsed: true,
      machineOffsetsCollapsed: true,
      machineCycleLogCollapsed: true,
      machineLineListCollapsed: false,
      machineSpindleRpm: 10000,
      machineLeftPanelW: MACHINE_PANEL_LEFT_DEFAULT,
      machineRightPanelW: MACHINE_PANEL_RIGHT_DEFAULT,
      machineLeftPanelWCustomized: false,
      machineRightPanelWCustomized: false,
      machineProgramPreviewPercent: PROGRAM_PREVIEW_DEFAULT_PERCENT,
      panelSizes: {},
      collapsedFolderIds: [],
      collapsedNestIds: [],
      expandedSeedIds: [],
      expandedDerivedGeoIds: [],
      treeStockExpanded: true,
      treeGeometryExpanded: true,
      treeSetupsExpanded: true,
      expandedSetupIds: [],
      collapsedOperationFolderIds: [],
      expandedLayerKeys: [],
      collapsedPartIds: [],
      expandedStockIds: [],
      tpLegendExpanded: false,
      savedCamera: null,
      lastNestSettings: null,
      workbenchHiddenGenesisIds: [],
      workbenchCameraProjection: 'orthographic',
      workbenchCollapsedSections: [],
      lastFilletRadius: null,
      lastChamferSetback: null,
      // WO-270: frozen, not defaults-with-alternatives. See the field docs.
      viewportTheme: DEFAULT_VIEWPORT_THEME,
      selectionGlow: DEFAULT_SELECTION_GLOW,
      // WO-324: a real, validated, opt-in default. See the field doc above.
      uiTheme: DEFAULT_UI_THEME,
      // WO-1263: used-only view by default. The key name is persistence ABI.
      machineDefHideEmptySettings: true,
      machineDefHiddenSettingGroups: {},
      probeSensingByMachine: {},
      uiScale: UI_SCALE_DEFAULT,
      uiColorMode: DEFAULT_UI_COLOR_MODE,
      dxfKeepOrigin: false,
      language: SOURCE_LANGUAGE,

      setPanelWidth: (side, width) =>
        set(side === 'left'
          ? { panelLeftWidth: clampPanelWidth('left', width), panelLeftWidthCustomized: true }
          : { panelRightWidth: clampPanelWidth('right', width), panelRightWidthCustomized: true }),

      resetPanelWidth: (side) =>
        set(side === 'left'
          ? { panelLeftWidth: PANEL_LEFT_DEFAULT, panelLeftWidthCustomized: false }
          : { panelRightWidth: PANEL_RIGHT_DEFAULT, panelRightWidthCustomized: false }),

      togglePropsGroup: (groupId) =>
        set((s) => ({
          collapsedPropsGroups: {
            ...s.collapsedPropsGroups,
            [groupId]: !s.collapsedPropsGroups[groupId],
          },
        })),

      isPropsGroupCollapsed: (groupId) => !!get().collapsedPropsGroups[groupId],

      setPanelCollapsed: (key, collapsed) =>
        set((s) => ({ collapsedPropsGroups: { ...s.collapsedPropsGroups, [key]: collapsed } })),

      setPanelSize: (key, size) =>
        set((s) => (Number.isFinite(size) && size > 0
          ? { panelSizes: { ...s.panelSizes, [key]: Math.round(size) } }
          : {})),

      resetPanelSize: (key) =>
        set((s) => {
          if (!(key in s.panelSizes)) return {}
          const rest = { ...s.panelSizes }
          delete rest[key]
          return { panelSizes: rest }
        }),

      setTreeDensity: (density) => set({ treeDensity: density }),

      toggleTreeDensity: () =>
        set((s) => ({ treeDensity: s.treeDensity === 'compact' ? 'default' : 'compact' })),

      toggleFolderCollapsed: (folderId) =>
        set((s) => ({
          collapsedFolderIds: s.collapsedFolderIds.includes(folderId)
            ? s.collapsedFolderIds.filter((id) => id !== folderId)
            : [...s.collapsedFolderIds, folderId],
        })),

      isFolderCollapsed: (folderId) => get().collapsedFolderIds.includes(folderId),

      toggleNestCollapsed: (nestId) =>
        set((s) => ({
          collapsedNestIds: s.collapsedNestIds.includes(nestId)
            ? s.collapsedNestIds.filter((id) => id !== nestId)
            : [...s.collapsedNestIds, nestId],
        })),

      isNestCollapsed: (nestId) => get().collapsedNestIds.includes(nestId),

      toggleSeedExpanded: (seedId) =>
        set((s) => ({
          expandedSeedIds: s.expandedSeedIds.includes(seedId)
            ? s.expandedSeedIds.filter((id) => id !== seedId)
            : [...s.expandedSeedIds, seedId],
        })),

      isSeedExpanded: (seedId) => get().expandedSeedIds.includes(seedId),

      toggleDerivedExpanded: (geoId) =>
        set((s) => ({
          expandedDerivedGeoIds: s.expandedDerivedGeoIds.includes(geoId)
            ? s.expandedDerivedGeoIds.filter((id) => id !== geoId)
            : [...s.expandedDerivedGeoIds, geoId],
        })),

      isDerivedExpanded: (geoId) => get().expandedDerivedGeoIds.includes(geoId),

      setLastNestSettings: (settings) => set({ lastNestSettings: settings }),

      toggleTpLegendExpanded: () =>
        set((s) => ({ tpLegendExpanded: !s.tpLegendExpanded })),

      setSavedCamera: (projectId, camera) => set({ savedCamera: { projectId, camera } }),

      // ── Design-tree expand/collapse persistence ──────────────────────────
      setTreeSectionExpanded: (section, expanded) =>
        set(
          section === 'stock'
            ? { treeStockExpanded: expanded }
            : section === 'geometry'
              ? { treeGeometryExpanded: expanded }
              : { treeSetupsExpanded: expanded },
        ),

      toggleTreeSection: (section) =>
        set((s) =>
          section === 'stock'
            ? { treeStockExpanded: !s.treeStockExpanded }
            : section === 'geometry'
              ? { treeGeometryExpanded: !s.treeGeometryExpanded }
              : { treeSetupsExpanded: !s.treeSetupsExpanded },
        ),

      setExpandedSetupIds: (ids) => set({ expandedSetupIds: ids }),
      toggleExpandedSetup: (id) =>
        set((s) => ({
          expandedSetupIds: s.expandedSetupIds.includes(id)
            ? s.expandedSetupIds.filter((x) => x !== id)
            : [...s.expandedSetupIds, id],
        })),

      toggleOperationFolderCollapsed: (folderId) =>
        set((s) => ({
          collapsedOperationFolderIds: s.collapsedOperationFolderIds.includes(folderId)
            ? s.collapsedOperationFolderIds.filter((id) => id !== folderId)
            : [...s.collapsedOperationFolderIds, folderId],
        })),

      isOperationFolderCollapsed: (folderId) =>
        get().collapsedOperationFolderIds.includes(folderId),

      setExpandedLayerKeys: (keys) => set({ expandedLayerKeys: keys }),
      toggleExpandedLayer: (key) =>
        set((s) => ({
          expandedLayerKeys: s.expandedLayerKeys.includes(key)
            ? s.expandedLayerKeys.filter((x) => x !== key)
            : [...s.expandedLayerKeys, key],
        })),

      setCollapsedPartIds: (ids) => set({ collapsedPartIds: ids }),
      toggleCollapsedPart: (id) =>
        set((s) => ({
          collapsedPartIds: s.collapsedPartIds.includes(id)
            ? s.collapsedPartIds.filter((x) => x !== id)
            : [...s.collapsedPartIds, id],
        })),

      setExpandedStockIds: (ids) => set({ expandedStockIds: ids }),
      toggleExpandedStock: (id) =>
        set((s) => ({
          expandedStockIds: s.expandedStockIds.includes(id)
            ? s.expandedStockIds.filter((x) => x !== id)
            : [...s.expandedStockIds, id],
        })),
      addExpandedStock: (id) =>
        set((s) => (s.expandedStockIds.includes(id)
          ? {}
          : { expandedStockIds: [...s.expandedStockIds, id] })),

      toggleWorkbenchGenesisHidden: (id) =>
        set((s) => ({
          workbenchHiddenGenesisIds: s.workbenchHiddenGenesisIds.includes(id)
            ? s.workbenchHiddenGenesisIds.filter((x) => x !== id)
            : [...s.workbenchHiddenGenesisIds, id],
        })),

      setWorkbenchCameraProjection: (mode) => set({ workbenchCameraProjection: mode }),

      isWorkbenchGenesisHidden: (id) => get().workbenchHiddenGenesisIds.includes(id),

      toggleWorkbenchSectionCollapsed: (sectionId) =>
        set((s) => ({
          workbenchCollapsedSections: s.workbenchCollapsedSections.includes(sectionId)
            ? s.workbenchCollapsedSections.filter((x) => x !== sectionId)
            : [...s.workbenchCollapsedSections, sectionId],
        })),

      isWorkbenchSectionCollapsed: (sectionId) => get().workbenchCollapsedSections.includes(sectionId),

      setLastFilletRadius: (value) =>
        set(Number.isFinite(value) && value > 0 ? { lastFilletRadius: value } : {}),
      setLastChamferSetback: (value) =>
        set(Number.isFinite(value) && value > 0 ? { lastChamferSetback: value } : {}),

      setMachineBridgePort: (machineId, port) => {
        requireBridgePort(port)
        set((state) => ({
          machineLinks: {
            ...state.machineLinks,
            [machineId]: { ...state.machineLinks[machineId], bridgePort: port },
          },
        }))
      },

      setMachineBridgeLaunchSetting: (machineId, key, value) => {
        set((state) => {
          const next = { ...state.machineLinks[machineId] }
          if (value === undefined || (typeof value === 'string' && value.trim() === '')) {
            delete next[key]
          } else {
            Object.assign(next, { [key]: value })
          }
          return {
            machineLinks: {
              ...state.machineLinks,
              [machineId]: next,
            },
          }
        })
      },

      setMachineVfdPort: (machineId, port) => {
        requireVfdPort(port)
        set((state) => ({
          machineLinks: {
            ...state.machineLinks,
            [machineId]: { ...state.machineLinks[machineId], vfdPort: port },
          },
        }))
      },

      setUiTheme: (theme) =>
        set(isUiThemeId(theme) ? { uiTheme: theme } : {}),
      setUiColorMode: (mode) =>
        set(isUiColorMode(mode) ? { uiColorMode: mode } : {}),

      // WO-1122: a boolean has exactly two answers, so there is nothing to
      // validate - anything else arriving here is a caller bug and writing
      // nothing is the safe refusal (mirrors setUiTheme's shape).
      setMachineDefHideEmptySettings: (hide) =>
        set(typeof hide === 'boolean' ? { machineDefHideEmptySettings: hide } : {}),

      toggleMachineDefSettingGroupHidden: (machineId, group) =>
        set((state) => {
          if (typeof machineId !== 'string' || machineId.length === 0
            || typeof group !== 'string' || group.length === 0) return {}
          const current = state.machineDefHiddenSettingGroups[machineId] ?? []
          const next = current.includes(group)
            ? current.filter((entry) => entry !== group)
            : [...current, group]
          return {
            machineDefHiddenSettingGroups: {
              ...state.machineDefHiddenSettingGroups,
              [machineId]: next,
            },
          }
        }),

      setProbeSensingChoice: (machineId, routine, sensing) =>
        set((state) => {
          if (typeof machineId !== 'string' || machineId.length === 0
            || typeof routine !== 'string' || routine.length === 0
            || !isProbeSensingChoice(sensing)) return {}
          return {
            probeSensingByMachine: {
              ...state.probeSensingByMachine,
              [machineId]: { ...state.probeSensingByMachine[machineId], [routine]: sensing },
            },
          }
        }),

      setUiScale: (scale) =>
        set(isUiScalePreference(scale) ? { uiScale: scale } : {}),

      // WO-1904: same two-answer refusal shape as setMachineDefHideEmptySettings.
      setDxfKeepOrigin: (keep) =>
        set(typeof keep === 'boolean' ? { dxfKeepOrigin: keep } : {}),

      setLanguage: (language) =>
        set(isAvailableLanguage(language) ? { language } : {}),

    }),
    {
      version: UI_PREFS_VERSION,
      migrate: migrateUiPrefs,
      // The registry resolves browser storage on every call. This keeps the
      // store constructible when storage is absent at import time and lets
      // tests install a shim before persist.rehydrate().
      // Clamp persisted widths on rehydrate — guards against a stale/tampered
      // localStorage value or a future bounds change leaving a panel off-screen.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<UiPrefsState>
        return {
          ...current,
          ...p,
          panelLeftWidth: clampPanelWidth('left', p.panelLeftWidth ?? PANEL_LEFT_DEFAULT),
          panelRightWidth: clampPanelWidth('right', p.panelRightWidth ?? PANEL_RIGHT_DEFAULT),
          // Old blobs did not carry the explicit flag. A non-default width can
          // only have come from a resize, so preserve it; exact defaults remain
          // eligible for the new wide-screen default until the operator drags.
          panelLeftWidthCustomized:
            typeof p.panelLeftWidthCustomized === 'boolean'
              ? p.panelLeftWidthCustomized
              : p.panelLeftWidth !== undefined && p.panelLeftWidth !== PANEL_LEFT_DEFAULT,
          panelRightWidthCustomized:
            typeof p.panelRightWidthCustomized === 'boolean'
              ? p.panelRightWidthCustomized
              : p.panelRightWidth !== undefined && p.panelRightWidth !== PANEL_RIGHT_DEFAULT,
          // Old blobs predate the explicit Control-column flag. A non-default
          // width can only have come from an operator drag, matching the CAM
          // panel migration directly above.
          machineLeftPanelWCustomized:
            typeof p.machineLeftPanelWCustomized === 'boolean'
              ? p.machineLeftPanelWCustomized
              : p.machineLeftPanelW !== undefined && p.machineLeftPanelW !== MACHINE_PANEL_LEFT_DEFAULT,
          machineRightPanelWCustomized:
            typeof p.machineRightPanelWCustomized === 'boolean'
              ? p.machineRightPanelWCustomized
              : p.machineRightPanelW !== undefined && p.machineRightPanelW !== MACHINE_PANEL_RIGHT_DEFAULT,
          collapsedPropsGroups: p.collapsedPropsGroups ?? {},
          // Preserve configured values verbatim so the connection boundary can
          // REFUSE a tampered port. Sanitizing it away here would silently dial
          // the default, which is precisely the operator trap WO-997 prevents.
          machineLinks:
            p.machineLinks !== null && typeof p.machineLinks === 'object' && !Array.isArray(p.machineLinks)
              ? p.machineLinks
              : {},
          treeDensity: (p.treeDensity === 'compact' || p.treeDensity === 'default') ? p.treeDensity : TREE_DENSITY_DEFAULT,
          collapsedFolderIds: Array.isArray(p.collapsedFolderIds) ? p.collapsedFolderIds : [],
          collapsedNestIds: Array.isArray(p.collapsedNestIds) ? p.collapsedNestIds : [],
          expandedSeedIds: Array.isArray(p.expandedSeedIds) ? p.expandedSeedIds : [],
          expandedDerivedGeoIds: Array.isArray(p.expandedDerivedGeoIds) ? p.expandedDerivedGeoIds : [],
          // Tree section flags default to EXPANDED (true) when absent in old
          // stored prefs, so existing users see no behavior change on upgrade.
          treeStockExpanded: typeof p.treeStockExpanded === 'boolean' ? p.treeStockExpanded : true,
          treeGeometryExpanded: typeof p.treeGeometryExpanded === 'boolean' ? p.treeGeometryExpanded : true,
          treeSetupsExpanded: typeof p.treeSetupsExpanded === 'boolean' ? p.treeSetupsExpanded : true,
          expandedSetupIds: Array.isArray(p.expandedSetupIds) ? p.expandedSetupIds : [],
          collapsedOperationFolderIds: Array.isArray(p.collapsedOperationFolderIds)
            ? p.collapsedOperationFolderIds
            : [],
          expandedLayerKeys: Array.isArray(p.expandedLayerKeys) ? p.expandedLayerKeys : [],
          collapsedPartIds: Array.isArray(p.collapsedPartIds) ? p.collapsedPartIds : [],
          expandedStockIds: Array.isArray(p.expandedStockIds) ? p.expandedStockIds : [],
          // Legend chip (P10) defaults to COLLAPSED when absent in old prefs.
          tpLegendExpanded: typeof p.tpLegendExpanded === 'boolean' ? p.tpLegendExpanded : false,
          // Pass the saved camera through untouched (validated at restore time by
          // deserializeCamera); absent in old prefs -> null -> default framing.
          savedCamera: (p.savedCamera ?? null) as UiPrefsState['savedCamera'],
          lastNestSettings: (p.lastNestSettings ?? null) as NestSettingsPref | null,
          workbenchHiddenGenesisIds: Array.isArray(p.workbenchHiddenGenesisIds) ? p.workbenchHiddenGenesisIds : [],
          // WO UI-34: missing or unrecognized values use the current
          // Orthographic default. A valid v1 Perspective value is preserved.
          workbenchCameraProjection:
            p.workbenchCameraProjection === 'orthographic' || p.workbenchCameraProjection === 'perspective'
              ? p.workbenchCameraProjection
              : 'orthographic',
          workbenchCollapsedSections: Array.isArray(p.workbenchCollapsedSections) ? p.workbenchCollapsedSections : [],
          // SKC-46: a stale/tampered value (non-finite, zero, negative) falls back to null -- the
          // derived grabbable default -- rather than staging an unusable size (charter item 3: no
          // NaN/invalid value sails through unvalidated).
          lastFilletRadius:
            typeof p.lastFilletRadius === 'number' && Number.isFinite(p.lastFilletRadius) && p.lastFilletRadius > 0
              ? p.lastFilletRadius
              : null,
          lastChamferSetback:
            typeof p.lastChamferSetback === 'number' && Number.isFinite(p.lastChamferSetback) && p.lastChamferSetback > 0
              ? p.lastChamferSetback
              : null,
          // WO-270: THE case that bites -- the controls are gone but the value
          // a user picked before is still sitting in their browser. Pin both
          // to the shipped constant AFTER the `...p` spread so a stored
          // 'deep-slate'/'brightness-halo' is IGNORED rather than leaving that
          // user stuck on a look they can no longer change. Nothing is deleted
          // from their storage here (Operator did not ask for that, and deleting
          // data is a separate, riskier act); the value simply stops being
          // read. `uiTheme` is a DIFFERENT case as of WO-324 -- Operator asked for
          // it back as a real, validated switch, not frozen like these two;
          // see its own merge line below.
          viewportTheme: DEFAULT_VIEWPORT_THEME,
          selectionGlow: DEFAULT_SELECTION_GLOW,
          // WO-324, mirroring the WO-137 pattern just below and the pre-WO-270
          // validation this field used to have: an absent or unrecognized/
          // tampered value (including a stored 'high-contrast', no longer a
          // member of UiThemeId) resolves to DEFAULT_UI_THEME -- never throws,
          // and every existing user's first launch after this WO keeps the
          // current look, not a regression.
          uiTheme: isUiThemeId(p.uiTheme) ? p.uiTheme : DEFAULT_UI_THEME,
          uiScale: isUiScalePreference(p.uiScale) ? p.uiScale : UI_SCALE_DEFAULT,
          uiColorMode: isUiColorMode(p.uiColorMode) ? p.uiColorMode : DEFAULT_UI_COLOR_MODE,
          // WO-1904: absent/tampered falls back to the shipped default (false
          // = re-centre), so every pre-WO blob keeps today's DXF behaviour.
          dxfKeepOrigin:
            typeof p.dxfKeepOrigin === 'boolean' ? p.dxfKeepOrigin : false,
          // WO-2319: absent, or a language whose catalog is gone, shows English.
          language: isAvailableLanguage(p.language) ? p.language : SOURCE_LANGUAGE,
          // WO-137: a non-number, out-of-range, or absent persisted value
          // falls back to the 60% default -- the trap WO-117's audit named
          // (an undeclared field survived only because merge spreads ...p).
          machineProgramPreviewPercent:
            typeof p.machineProgramPreviewPercent === 'number' &&
            Number.isFinite(p.machineProgramPreviewPercent) &&
            p.machineProgramPreviewPercent >= 0 &&
            p.machineProgramPreviewPercent <= 100
              ? p.machineProgramPreviewPercent
              : PROGRAM_PREVIEW_DEFAULT_PERCENT,
          // WO-2430: keep only finite positive sizes; anything else falls back
          // to the screen's default by being absent.
          panelSizes:
            p.panelSizes !== null && typeof p.panelSizes === 'object' && !Array.isArray(p.panelSizes)
              ? Object.fromEntries(Object.entries(p.panelSizes)
                .filter((entry): entry is [string, number] =>
                  typeof entry[1] === 'number' && Number.isFinite(entry[1]) && entry[1] > 0))
              : {},
          // WO-1122: absent or tampered values fall back to the shipped
          // default (hidden) - the state Operator asked to land on. Anything
          // else in storage was written by this store's own set, so this
          // line only guards a hand-edited or partially-written blob.
          machineDefHideEmptySettings:
            typeof p.machineDefHideEmptySettings === 'boolean'
              ? p.machineDefHideEmptySettings
              : true,
          machineDefHiddenSettingGroups:
            p.machineDefHiddenSettingGroups !== null
            && typeof p.machineDefHiddenSettingGroups === 'object'
              ? Object.fromEntries(Object.entries(p.machineDefHiddenSettingGroups)
                .filter((entry): entry is [string, string[]] => Array.isArray(entry[1])
                  && entry[1].every((key) => typeof key === 'string')))
              : {},
          probeSensingByMachine: validProbeSensingByMachine(p.probeSensingByMachine),
        }
      },
    },
  ),
  ),
)

interface MachineBridgeBootHost {
  machineBridgeReady?: (settings?: MachineBridgeLaunchSettings) => void
  machineBridgeRemember?: (settings?: MachineBridgeLaunchSettings) => void
}

let machineBridgeSettingsSyncInstalled = false

/**
 * Electron cannot read this renderer-owned localStorage record or know which
 * durable project machine is active. Supply the active record after project
 * hydration to refresh the next-boot mirror and reconcile an old one once.
 */
export async function supplyMachineBridgeSettingsOnBoot(): Promise<void> {
  const initialHost = (globalThis as typeof globalThis & { liencamHost?: MachineBridgeBootHost }).liencamHost
  if (typeof initialHost?.machineBridgeReady !== 'function') return

  // Dynamic import avoids the uiPrefs <-> root-store module cycle: the root
  // store already imports this module and is complete before this resolves.
  const { controlMachine, useCamStore } = await import('./index')
  if (!useCamStore.persist.hasHydrated()) {
    await new Promise<void>((resolve) => {
      let unsubscribe = () => {}
      const finish = () => {
        unsubscribe()
        resolve()
      }
      unsubscribe = useCamStore.persist.onFinishHydration(finish)
      if (useCamStore.persist.hasHydrated()) finish()
    })
  }

  const host = (globalThis as typeof globalThis & { liencamHost?: MachineBridgeBootHost }).liencamHost
  if (typeof host?.machineBridgeReady !== 'function') return
  const activeSettings = () => {
    const machineId = controlMachine(useCamStore.getState()).id
    return useUiPrefs.getState().machineLinks[machineId]
  }
  host.machineBridgeReady(activeSettings())

  if (machineBridgeSettingsSyncInstalled) return
  machineBridgeSettingsSyncInstalled = true
  const remember = () => {
    const currentHost = (globalThis as typeof globalThis & { liencamHost?: MachineBridgeBootHost }).liencamHost
    currentHost?.machineBridgeRemember?.(activeSettings())
  }
  useUiPrefs.subscribe((state) => state.machineLinks, remember)
  useCamStore.subscribe((state, previous) => {
    if (controlMachine(state).id !== controlMachine(previous).id) remember()
  })
}

void supplyMachineBridgeSettingsOnBoot()

/** Resolve the active machine's bridge port at the connection boundary. Only
 * absence selects the old default; a configured invalid value is an error. */
export function machineBridgePort(machineId: string): number {
  // WO-1000 gate 4. This is the ONE call in the product that resolves a machine
  // profile id at the connection boundary - `machineSession.connectMachine`
  // does `bridgeUrl(machineBridgePort(machineId))` and then constructs the
  // BridgeTransport on the same tick. The transport is handed a URL and nothing
  // else, so without this it cannot know whose `machineLinks` record the
  // remembered spindle port belongs to, and would have to key the memory by
  // endpoint - which is exactly the not-machine-scoped storage the attempt-1
  // audit rejected. Said before the port is validated on purpose: if the port
  // below throws, no transport is built, so the noted id is simply never read.
  noteBridgeMachineId(machineId)
  const configured = useUiPrefs.getState().machineLinks[machineId]?.bridgePort
  if (configured === undefined) return BRIDGE_DEFAULT_PORT
  requireBridgePort(configured)
  return configured
}

/** WO-1000 gate 4, the read half: the spindle-link serial port this computer
 * remembers for one machine, or null when it has never chosen one.
 *
 * Unlike `machineBridgePort`, a stored value that is not a usable port name
 * reads as null rather than throwing. The two are not the same risk: a bad
 * bridge port would be DIALLED, so refusing is the only honest answer, whereas
 * a bad VFD port name is simply never re-sent - the picker goes on showing the
 * port the bridge itself reports (gate 3) and the operator picks again. Failing
 * the whole connect over a stale spindle preference would be the larger harm.
 */
export function machineVfdPort(machineId: string): string | null {
  const configured = useUiPrefs.getState().machineLinks[machineId]?.vfdPort
  return typeof configured === 'string' && configured.trim() !== '' ? configured : null
}

// WO-1000 gate 4: hand `bridgeTransport` the durable, machine-scoped memory the
// design specifies. The dependency arrow runs uiPrefs -> bridgeTransport (this
// module already imports BRIDGE_DEFAULT_PORT from it, and nothing under
// src/store/ imports src/store/index.ts), so the transport cannot import the
// store back without closing a cycle - it takes the memory injected instead.
// `machineSession.ts` imports `machineBridgePort` above to build the bridge
// URL, so this line has run before any bridge connection can exist.
installVfdPortMemory({
  read: (machineId) => machineVfdPort(machineId),
  write: (machineId, port) => { useUiPrefs.getState().setMachineVfdPort(machineId, port) },
})

// WO-270 removed the module-level `applyUiTheme(...)` call + `uiTheme`
// subscription that used to live here; WO-324 brings back exactly that (not
// a redesign) now that `uiTheme` is a real field again. Lives at MODULE
// scope (not inside a React effect) so it applies before any app shell
// mounts -- the normal App tree, the ?lab3d=1 / ?cam3dDev standalone dev
// pages (src/main.tsx), and any future entry point all import this one store
// module and share the one application step. Reading `uiTheme` here is safe
// synchronously: persist's storage.getItem returns a plain value, not a
// Promise, so zustand's persist middleware rehydrates synchronously during
// `create()`, before this line runs. Mirrors CNCViewport.ts's pre-WO-286
// `useUiPrefs.subscribe((s) => s.viewportTheme, ...)` shape, one level up (a
// document attribute instead of a Three.js material update).
applyUiTheme(useUiPrefs.getState().uiTheme)
useUiPrefs.subscribe((s) => s.uiTheme, (theme) => applyUiTheme(theme))
applyUiColorMode(useUiPrefs.getState().uiColorMode)
useUiPrefs.subscribe((s) => s.uiColorMode, (mode) => applyUiColorMode(mode))

// ---------------------------------------------------------------------------
// WO-2421 (ADR-0057): the user's settings profile leaves as documented JSON.
// Format: docs/formats/user-profile.md + user-profile.schema.json.
// ---------------------------------------------------------------------------
export const USER_PROFILE_SCHEMA = 'liencam-user-profile'
export const USER_PROFILE_VERSION = 1
export const USER_PROFILE_FILENAME = 'LienCAM-settings-profile.json'

export interface UserProfileExport {
  schema: typeof USER_PROFILE_SCHEMA
  schemaVersion: typeof USER_PROFILE_VERSION
  exportedAt: string
  /** The app-level settings (Settings modal values), exactly as stored. */
  appSettings: AppSettings
  /** The persisted UI-preference record: every stored value, no actions. */
  uiPreferences: Record<string, unknown>
}

/** Build the profile from the two stores' current values. Pure. */
export function buildUserProfile(
  appSettings: AppSettings,
  now: Date = new Date(),
): UserProfileExport {
  const state = useUiPrefs.getState() as unknown as Record<string, unknown>
  const uiPreferences: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(state)) {
    if (typeof value !== 'function') uiPreferences[key] = value
  }
  return {
    schema: USER_PROFILE_SCHEMA,
    schemaVersion: USER_PROFILE_VERSION,
    exportedAt: now.toISOString(),
    appSettings: JSON.parse(JSON.stringify(appSettings)) as AppSettings,
    uiPreferences: JSON.parse(JSON.stringify(uiPreferences)) as Record<string, unknown>,
  }
}

/** The text the "Export settings" button saves. */
export function exportUserProfileText(appSettings: AppSettings, now?: Date): string {
  return JSON.stringify(buildUserProfile(appSettings, now), null, 2)
}
