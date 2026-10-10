// ControlPanelCollapseToggle - WO-116: every Control-tab rail panel gets the
// SAME collapse affordance WORK OFFSETS already had (Operator ruling 2026-08-09: "Infact
// allow all to be collapsed like work offsets"). The markup below copies
// OffsetsPanel's chevron button exactly - .panel-action-btn riding right in
// the .panel-header, 13px ChevronDown (collapsed) / ChevronUp (expanded),
// native button keyboard behavior - so there is ONE collapse mechanism on the
// page, not a second one that looks slightly different (COHESION-STANDARD).
//
// Persistence reuses the store's EXISTING collapsed-sections record
// (uiPrefs.collapsedPropsGroups + togglePropsGroup, key prefix "control-") -
// no new storage mechanism, and no uiPrefs.ts schema change (WO-116's
// owned-paths do not include src/store/). Absence = EXPANDED, so every panel
// keeps its current at-rest look on upgrade; the collapse is opt-in per panel
// and survives reload through the same persisted store the rest of the
// Control-tab UI setup already uses (liencam-ui-prefs).

import type { ReactNode } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { useUiPrefs } from '../../store/uiPrefs'

/** Persisted collapsed-state keys, one per collapsible Control-tab panel.
 *  WO-414 batch 3 (R41, Operator 2026-08-21 Approve): the Tool panel folds to its
 *  header line BY DEFAULT (the tool number is already in the Position header),
 *  so its key records EXPANDED - absence = folded - the same way batch 1's
 *  viewport cards remember their open state. */
export const CONTROL_PANEL_COLLAPSE_KEYS = {
  machine: 'control-machine',
  position: 'control-position',
  tool: 'control-tool-panel-expanded',
  jog: 'control-jog',
  overrides: 'control-overrides',
  spindle: 'control-spindle',
  macros: 'control-macros',
} as const

export type ControlPanelId = keyof typeof CONTROL_PANEL_COLLAPSE_KEYS

/** Panels whose persisted key means "expanded" (folded by default). */
export const CONTROL_PANEL_DEFAULT_COLLAPSED: ReadonlySet<ControlPanelId> = new Set<ControlPanelId>(['tool'])

/** Read one panel's collapsed state (default false = expanded, except the
 *  default-collapsed panels above where the key records the opposite). */
export function useControlPanelCollapsed(panel: ControlPanelId): boolean {
  const key = CONTROL_PANEL_COLLAPSE_KEYS[panel]
  const flagged = useUiPrefs((s) => !!s.collapsedPropsGroups[key])
  return CONTROL_PANEL_DEFAULT_COLLAPSED.has(panel) ? !flagged : flagged
}

/**
 * The ONE collapsed-summary slot (WO-184, Operator 2026-08-09T18:48Z: "Look into
 * minimum viable info still being diplay (if not controlled) while in the
 * collapsed state"). A collapsed panel is a SUMMARY state, not an off state:
 * folding removes the ability to ACT, never the ability to SEE. Every rail
 * panel hosts its live readout HERE - same slot in the .panel-header, same
 * .control-version class, same `control-<panel>-collapsed-values` testid - so
 * there is one collapsed-readout look on the page rather than seven
 * (COHESION-STANDARD). The shipped precedent this copies is OverridePanel's
 * `F100% R100% S100%`, which Operator graded good.
 *
 * Render it ONLY while collapsed, and feed it store values directly: the
 * readout has to keep ticking under the fold, and a frozen one lies mid-cycle.
 */
export function ControlCollapsedReadout({
  testId,
  children,
}: {
  testId: string
  children: ReactNode
}) {
  return (
    <span className="control-version" data-testid={testId}>
      {children}
    </span>
  )
}

export function ControlPanelCollapseToggle({
  panel,
  testId,
  collapseTip,
  expandTip,
}: {
  panel: ControlPanelId
  testId: string
  /** Tooltip/aria text, collapsed-first like the Work offsets button. */
  collapseTip: string
  expandTip: string
}) {
  const collapsed = useControlPanelCollapsed(panel)
  const toggle = useUiPrefs((s) => s.togglePropsGroup)
  return (
    <button
      className="panel-action-btn"
      data-testid={testId}
      onClick={() => toggle(CONTROL_PANEL_COLLAPSE_KEYS[panel])}
      data-tooltip={collapsed ? expandTip : collapseTip}
      aria-label={collapsed ? expandTip : collapseTip}
    >
      {collapsed ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
    </button>
  )
}
