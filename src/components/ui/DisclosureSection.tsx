import { textFor, useText } from '../../i18n'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'

const shellText = textFor('app-shell-settings-menus')

// ============================================================
// DisclosureSection - the standard progressive-disclosure section
// (clutter-audit 2026-07, Phase 1: P5 / P6 / P7).
// ============================================================
// A collapsible form section with a header row showing:
//   [chevron in a boxed affordance]  TITLE            current-value summary
// Collapsed by default (progressive disclosure is the default,
// UI-STANDARD section 10.4). The expand affordance is deliberately
// UNMISSABLE per Operator's P6 verdict ("make it really clear this can be
// expanded... larger expand iconography to promote opening"): a large
// boxed chevron + an uppercase label at --text-secondary minimum
// (UI-STANDARD rule 9: interactive text never renders at the muted
// tier), with a hover lift to --text-primary.
//
// The one-line summary shows the section's CURRENT values while
// collapsed (e.g. Arcs: "IJK / 0.5 / 10000 / 2") so the user never has
// to open a section just to check what it is set to. It hides when the
// section is open - the live fields are the values then.
//
// Children UNMOUNT while collapsed (same pattern as the Properties
// panel CollapsibleGroup). Keep stateful hooks out of inline children
// or accept a state reset on collapse - form fields here bind to the
// parent's state, so nothing is lost.
//
// State is component-local and intentionally NOT persisted: every
// fresh open of a modal starts collapsed again (the approved at-rest
// layout), unlike the Properties panel groups which persist per group
// type in uiPrefs.
//
// ---- UI-BRAND-B1-4: disclosure/collapsible census (doc-only) ----------
// coordination/reports/UI-BRAND-PB-PLAN.md B1-4. The app has 4 hand-rolled
// "section that can be hidden" patterns; this records which should
// eventually PORT onto this component (B2-10) vs. which is a deliberately
// different, non-collapsible primitive that should stay that way:
//   1. THIS component (DisclosureSection) - modal form sections
//      (MachineLibraryModal, NewOperationModal, PostProcessModal).
//      Canonical target for the port.
//   2. src/components/panels/PropertiesPanel.tsx `CollapsibleGroup` -
//      visually near-identical row shape (chevron + title + optional
//      summary), but state persists PER GROUP TYPE in uiPrefs instead of
//      resetting on remount. PORTED (B2-10): `CollapsibleGroup` now
//      delegates to this component in CONTROLLED mode (`open`/`onToggle`
//      below) so the uiPrefs persistence is unchanged - only the header
//      markup/CSS moved. The `.props-disclosure` className restores the
//      sticky-while-scrolling header behavior the panel relied on (a real
//      functional affordance, not just styling) via scoped CSS.
//   3. src/components/modals/ToolLibraryModal.tsx tool-type group headers
//      (`collapsedTypes` local Set state) - chevron + type-name + count,
//      no "current value" summary line (a count badge instead). PORTED
//      (B2-10): also controlled mode, the `summary` slot carries the count
//      badge instead of a value string - no new variant needed, as the
//      B1-4 census predicted.
//   4. src/components/modals/SettingsModal.tsx `.mform-section-header` -
//      a plain, non-interactive `<div>` label (no chevron, no onClick, no
//      collapse state) marking a settings group. This is INTENTIONALLY a
//      different primitive ("static section label", not a disclosure) -
//      Settings sections are meant to stay fully visible for scanning, not
//      collapsed by default. NOT ported; stays static, per the census.
// Note: src/components/panels/DesignTree.tsx's setup/folder/layer
// expand-collapse (uiPrefs-backed: expandedSetupIds, expandedLayerKeys,
// treeStockExpanded, collapsedOperationFolderIds) is a TREE ROW toggle,
// not a form-section disclosure - different shape (no title/summary
// header row, arbitrary nesting depth) and stayed OUT of the census; it is
// its own primitive, not a DisclosureSection port candidate. (The B2-10
// dispatch briefly named "Design Tree" as a candidate; the B1-4 census this
// batch must follow explicitly excludes it, so it was skipped - not ported.)
export function DisclosureSection({
  title,
  summary,
  icon,
  defaultOpen = false,
  open: controlledOpen,
  onToggle,
  className,
  dataGroup,
  testId,
  children,
}: {
  title: ReactNode
  /** One-line current-value summary shown while collapsed. */
  summary?: ReactNode
  /** Optional leading icon rendered between the chevron and the title
   * (B2-10 port: PropertiesPanel's CollapsibleGroup `icon` prop). */
  icon?: ReactNode
  defaultOpen?: boolean
  /** Controlled mode (B2-10 port): pass BOTH `open` and `onToggle` to let
   * the caller own open/closed state instead of this component's own
   * local, resets-on-remount state - e.g. PropertiesPanel's uiPrefs-backed
   * collapsedPropsGroups (persists per group id) or ToolLibraryModal's
   * per-type collapsedTypes (persists across search/filter changes, resets
   * on modal remount like before). Omit both for the original uncontrolled
   * behavior (modal form sections, always starts at `defaultOpen`). */
  open?: boolean
  onToggle?: () => void
  /** Extra class(es) on the outer wrapper, for a ported site's own scoped
   * CSS (e.g. "props-disclosure" restores PropertiesPanel's sticky header
   * positioning, which this component does not provide by default). */
  className?: string
  /** data-group passthrough (PropertiesPanel's pre-port markup carried this;
   * nothing currently reads it, kept for parity). */
  dataGroup?: string
  /** data-testid for the toggle button (smoke tests + capture tools). */
  testId?: string
  children: ReactNode
}) {
  useText('app-shell-settings-menus')
  const [localOpen, setLocalOpen] = useState(defaultOpen)
  const controlled = controlledOpen !== undefined && onToggle !== undefined
  const open = controlled ? controlledOpen : localOpen
  const handleToggle = controlled ? onToggle! : () => setLocalOpen((o) => !o)
  return (
    <div className={className ? `disclosure-section ${className}` : 'disclosure-section'}>
      <button
        type="button"
        className="disclosure-header"
        // CVU-2 (overlay attach-guard REGIME 2, UI78_OVERLAY_ATTACH_GUARD_BOOTSTRAP):
        // this shared header is sticky (out-of-flow) chrome used app-wide (Properties
        // panel section headers etc.); already dispositioned COHESIVE in the UI-70
        // census. The real dev bootstrap runs REGIME 1 (JSX-site disposition) inert
        // (no jsx-dev-runtime aliasing plugin installed yet), so the ONLY live sanction
        // path is the REGIME 2 ownership marker -- this component vouching for its own
        // rendered output, same as the census's own data-ui70-census self-exclusion.
        data-ui78-sanctioned=""
        aria-expanded={open}
        data-testid={testId}
        data-group={dataGroup}
        data-tooltip={open ? shellText('DisclosureSection.collapseSection') : shellText('DisclosureSection.expandSection')}
        onClick={handleToggle}
      >
        <span className="disclosure-chevron" aria-hidden="true">
          {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
        </span>
        {icon}
        <span className="disclosure-title">{title}</span>
        {!open && summary != null && summary !== '' && (
          <span
            className="disclosure-summary"
            data-tooltip={typeof summary === 'string' ? summary : undefined}
          >
            {summary}
          </span>
        )}
      </button>
      {open && <div className="disclosure-body">{children}</div>}
    </div>
  )
}
