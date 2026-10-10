import { textFor, useText } from '../../i18n'
// CollapsiblePanel - WO-2430: the ONE shared collapse affordance for a
// panel (Operator 2026-10-02: "Having collapsible and resizable panels allows
// users to make the interface their own"; COHESION-STANDARD s26).
//
// It is Control > Main's chevron (ControlPanelCollapseToggle) made general:
// the same .panel-action-btn riding right in the .panel-header, the same 13px
// ChevronUp (expanded) / ChevronDown (collapsed), the same native button
// keyboard behaviour, and the same persisted record
// (uiPrefs.collapsedPropsGroups) - so a panel folded here and a Main rail
// panel look, feel and survive a restart the same way.
//
// A collapsed panel keeps its header: title, any collapsed summary the screen
// supplies (folding removes the ability to act, never to see - WO-184) and
// the chevron to bring it back. Each screen gives the panel a key; an absent
// key means the panel's own default, so a panel folded by default can still
// remember "expanded".

import type { ReactNode } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { useUiPrefs } from '../../store/uiPrefs'
import './panels.css'

const shellText = textFor('app-shell-settings-menus')

/** A panel's collapsed state (persisted; absent = `defaultCollapsed`). */
export function usePanelCollapsed(panelKey: string, defaultCollapsed = false): boolean {
  return useUiPrefs((s) => s.collapsedPropsGroups[panelKey] ?? defaultCollapsed)
}

export function PanelCollapseToggle({
  panelKey,
  defaultCollapsed = false,
  testId,
  collapseTip,
  expandTip,
}: {
  panelKey: string
  defaultCollapsed?: boolean
  testId?: string
  /** Tooltip/aria text for each state, e.g. "Collapse the jog controls". */
  collapseTip: string
  expandTip: string
}) {
  useText('app-shell-settings-menus')
  const collapsed = usePanelCollapsed(panelKey, defaultCollapsed)
  const setPanelCollapsed = useUiPrefs((s) => s.setPanelCollapsed)
  const tip = collapsed ? expandTip : collapseTip
  return (
    <button
      type="button"
      className="panel-action-btn"
      data-testid={testId}
      aria-expanded={!collapsed}
      aria-label={tip}
      data-tooltip={tip}
      onClick={() => setPanelCollapsed(panelKey, !collapsed)}
    >
      {collapsed ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
    </button>
  )
}

export function CollapsiblePanel({
  panelKey,
  title,
  defaultCollapsed = false,
  collapsedSummary,
  headerExtra,
  collapseTip,
  expandTip,
  className,
  bodyClassName,
  testId,
  children,
}: {
  panelKey: string
  title: ReactNode
  defaultCollapsed?: boolean
  /** Live readout shown in the header only while collapsed. */
  collapsedSummary?: ReactNode
  /** Header content shown in both states (meta text, header buttons). */
  headerExtra?: ReactNode
  collapseTip?: string
  expandTip?: string
  className?: string
  bodyClassName?: string
  testId?: string
  children: ReactNode
}) {
  useText('app-shell-settings-menus')
  const collapsed = usePanelCollapsed(panelKey, defaultCollapsed)
  const name = typeof title === 'string' ? title.toLowerCase() : shellText('CollapsiblePanel.panel')
  return (
    <section
      className={`panel collapsible-panel${collapsed ? ' collapsible-panel-collapsed' : ''}${className ? ` ${className}` : ''}`}
      data-testid={testId}
      data-collapsed={collapsed ? 'true' : 'false'}
    >
      <div className="panel-header">
        <span className="panel-title">{title}</span>
        {headerExtra}
        {collapsed && collapsedSummary}
        <PanelCollapseToggle
          panelKey={panelKey}
          defaultCollapsed={defaultCollapsed}
          testId={testId ? `${testId}-collapse` : undefined}
          collapseTip={collapseTip ?? shellText('CollapsiblePanel.collapseThe', { name: name })}
          expandTip={expandTip ?? shellText('CollapsiblePanel.expandThe', { name: name })}
        />
      </div>
      {!collapsed && <div className={`panel-body${bodyClassName ? ` ${bodyClassName}` : ''}`}>{children}</div>}
    </section>
  )
}
