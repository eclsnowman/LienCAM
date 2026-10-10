import type { ToolType } from '../../types'

// ── Tool-type metadata: the single source of truth ────────────────────────────
// Tool-type facts (label, list grouping, angle-input convention, diagram
// profile) were previously scattered across ToolLibraryModal (a hand-ordered
// TOOL_TYPES array + inline angle-field OR-chains/ternaries) and the ToolDiagram
// tip-geometry switch. This table consolidates them so every consumer reads one
// authority.
//
// Angle convention (ADR-0029 / docs/tool_angle_conventions.md):
//   Canonical storage = Tool.angleFromAxisDeg, the HALF-angle (angle from the
//   tool axis). Two input styles map onto it:
//     - 'included': user enters the FULL INCLUDED tip angle; stored = included/2
//       (pointed tools: v-bit, drill, spot/center drill, chamfer, countersink,
//       dovetail).
//     - 'perSide':  user enters the PER-SIDE taper angle; stored as-is
//       (tapered endmill).
//     - 'none':     no angle field (the tool has no defining tip/taper angle).

// The silhouette family a tool type draws as. Named so field-relevance and
// other per-family metadata can key off it.
export type ProfileKind =
  | 'flat'
  | 'ball'
  | 'bull'
  | 'cone'
  | 'frustum'
  | 'dovetail'
  | 'disc'
  | 'lollipop'
  | 'drillpoint'
  | 'thread'
  | 'probe'

export interface ToolTypeMeta {
  value: ToolType
  label: string
  group: 'milling' | 'holemaking' | 'threading' | 'engraving' | 'probing'
  hasAngle: boolean
  angleInputStyle: 'included' | 'perSide' | 'none'
  // profileKind is consumed by ToolDiagram (a later commit wires it into the
  // tip-geometry switch). It names the silhouette family, not the exact draw.
  profileKind: ProfileKind
}

// Per-type metadata for ALL 19 tool types.
export const TOOL_TYPE_META: Record<ToolType, ToolTypeMeta> = {
  flat_end_mill:   { value: 'flat_end_mill',   label: 'Flat End Mill',   group: 'milling',    hasAngle: false, angleInputStyle: 'none',     profileKind: 'flat'       },
  ball_end_mill:   { value: 'ball_end_mill',   label: 'Ball End Mill',   group: 'milling',    hasAngle: false, angleInputStyle: 'none',     profileKind: 'ball'       },
  bull_nose:       { value: 'bull_nose',       label: 'Bull Nose',       group: 'milling',    hasAngle: false, angleInputStyle: 'none',     profileKind: 'bull'       },
  face_mill:       { value: 'face_mill',       label: 'Face Mill',       group: 'milling',    hasAngle: false, angleInputStyle: 'none',     profileKind: 'flat'       },
  chamfer_mill:    { value: 'chamfer_mill',    label: 'Chamfer Mill',    group: 'milling',    hasAngle: true,  angleInputStyle: 'included', profileKind: 'cone'       },
  tapered_endmill: { value: 'tapered_endmill', label: 'Tapered Endmill', group: 'milling',    hasAngle: true,  angleInputStyle: 'perSide',  profileKind: 'frustum'    },
  dovetail_mill:   { value: 'dovetail_mill',   label: 'Dovetail Mill',   group: 'milling',    hasAngle: true,  angleInputStyle: 'included', profileKind: 'dovetail'   },
  lollipop_mill:   { value: 'lollipop_mill',   label: 'Lollipop Mill',   group: 'milling',    hasAngle: false, angleInputStyle: 'none',     profileKind: 'lollipop'   },
  slitting_saw:    { value: 'slitting_saw',    label: 'Slitting Saw',    group: 'milling',    hasAngle: false, angleInputStyle: 'none',     profileKind: 'disc'       },
  v_bit:           { value: 'v_bit',           label: 'V-Bit / Chamfer', group: 'engraving',  hasAngle: true,  angleInputStyle: 'included', profileKind: 'cone'       },
  drill:           { value: 'drill',           label: 'Drill',           group: 'holemaking', hasAngle: true,  angleInputStyle: 'included', profileKind: 'drillpoint' },
  spot_drill:      { value: 'spot_drill',      label: 'Spot Drill',      group: 'holemaking', hasAngle: true,  angleInputStyle: 'included', profileKind: 'drillpoint' },
  center_drill:    { value: 'center_drill',    label: 'Center Drill',    group: 'holemaking', hasAngle: true,  angleInputStyle: 'included', profileKind: 'drillpoint' },
  countersink:     { value: 'countersink',     label: 'Countersink',     group: 'holemaking', hasAngle: true,  angleInputStyle: 'included', profileKind: 'cone'       },
  reamer:          { value: 'reamer',          label: 'Reamer',          group: 'holemaking', hasAngle: false, angleInputStyle: 'none',     profileKind: 'flat'       },
  boring_bar:      { value: 'boring_bar',      label: 'Boring Bar',      group: 'holemaking', hasAngle: false, angleInputStyle: 'none',     profileKind: 'flat'       },
  tap:             { value: 'tap',             label: 'Tap',             group: 'threading',  hasAngle: false, angleInputStyle: 'none',     profileKind: 'flat'       },
  thread_mill:     { value: 'thread_mill',     label: 'Thread Mill',     group: 'threading',  hasAngle: false, angleInputStyle: 'none',     profileKind: 'thread'     },
  probe:           { value: 'probe',           label: 'Probe',           group: 'probing',    hasAngle: false, angleInputStyle: 'none',     profileKind: 'probe'      },
}

// Dropdown / list order: a logical milling -> holemaking -> threading grouping
// rather than the historical insertion order. This is THE order every tool-type
// selector renders in.
export const TOOL_TYPE_ORDER: ToolType[] = [
  'flat_end_mill',
  'ball_end_mill',
  'bull_nose',
  'face_mill',
  'chamfer_mill',
  'tapered_endmill',
  'dovetail_mill',
  'lollipop_mill',
  'slitting_saw',
  'v_bit',
  'drill',
  'spot_drill',
  'center_drill',
  'countersink',
  'reamer',
  'boring_bar',
  'tap',
  'thread_mill',
  'probe',
]

// Lookup helper: metadata for a tool type (falls back to flat_end_mill for a
// malformed/legacy type so callers never get undefined).
export function toolTypeMeta(type: ToolType): ToolTypeMeta {
  return TOOL_TYPE_META[type] ?? TOOL_TYPE_META.flat_end_mill
}

// ── Per-profileKind field relevance ───────────────────────────────────────────
// Which geometry fields each profileKind actually uses, so a UI can show only
// the relevant inputs. Data-only; no behaviour. For 'frustum', tipDiameter is a
// derived/display value (computed from diameter, taper and length) rather than a
// free input, but it is still relevant to show.
export interface ProfileFieldRelevance {
  tipDiameter: boolean
  neckDiameter: boolean
  cornerRadius: boolean
  angle: boolean
  // Thread-mill fields (only the 'thread' kind shows these); see Tool.thread*.
  threadFormAngle: boolean
  threadTeeth: boolean
  threadPitch: boolean
  // Thread-mill neck->shank transition cone angle (only the 'thread' kind).
  neckTransitionAngle: boolean
}

export const PROFILE_FIELD_RELEVANCE: Record<ProfileKind, ProfileFieldRelevance> = {
  flat:       { tipDiameter: false, neckDiameter: false, cornerRadius: false, angle: false, threadFormAngle: false, threadTeeth: false, threadPitch: false, neckTransitionAngle: false },
  ball:       { tipDiameter: false, neckDiameter: false, cornerRadius: false, angle: false, threadFormAngle: false, threadTeeth: false, threadPitch: false, neckTransitionAngle: false },
  bull:       { tipDiameter: false, neckDiameter: false, cornerRadius: true,  angle: false, threadFormAngle: false, threadTeeth: false, threadPitch: false, neckTransitionAngle: false },
  cone:       { tipDiameter: true,  neckDiameter: false, cornerRadius: false, angle: true,  threadFormAngle: false, threadTeeth: false, threadPitch: false, neckTransitionAngle: false },
  frustum:    { tipDiameter: true,  neckDiameter: false, cornerRadius: true,  angle: true,  threadFormAngle: false, threadTeeth: false, threadPitch: false, neckTransitionAngle: false }, // tipDiameter derived/display
  dovetail:   { tipDiameter: false, neckDiameter: true,  cornerRadius: false, angle: true,  threadFormAngle: false, threadTeeth: false, threadPitch: false, neckTransitionAngle: false },
  disc:       { tipDiameter: false, neckDiameter: true,  cornerRadius: false, angle: false, threadFormAngle: false, threadTeeth: false, threadPitch: false, neckTransitionAngle: false },
  lollipop:   { tipDiameter: false, neckDiameter: true,  cornerRadius: false, angle: false, threadFormAngle: false, threadTeeth: false, threadPitch: false, neckTransitionAngle: false },
  drillpoint: { tipDiameter: false, neckDiameter: false, cornerRadius: false, angle: true,  threadFormAngle: false, threadTeeth: false, threadPitch: false, neckTransitionAngle: false },
  thread:     { tipDiameter: false, neckDiameter: true,  cornerRadius: false, angle: false, threadFormAngle: true,  threadTeeth: true,  threadPitch: true,  neckTransitionAngle: true  },
  probe:      { tipDiameter: false, neckDiameter: true,  cornerRadius: false, angle: false, threadFormAngle: false, threadTeeth: false, threadPitch: false, neckTransitionAngle: false }, // neckDiameter = stylus stem
}

// Field relevance for a tool type (resolves type -> profileKind first).
export function fieldRelevanceForType(type: ToolType): ProfileFieldRelevance {
  return PROFILE_FIELD_RELEVANCE[toolTypeMeta(type).profileKind]
}
