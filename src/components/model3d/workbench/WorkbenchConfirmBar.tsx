// WO UI-18 (D2, Operator's annotated confirm-bar screenshot retained with the order:
// "why is this all wedged in the corner and overlapping the view cube.
// change how this blue confirm bar looks and works to avoid this."): ONE
// shared compact confirm bar for every workbench pick-flow (pick-face,
// N-pick, push/pull, dress-up), replacing the four bespoke full-width
// position:absolute bottom:0 left:0 right:0 bars SolidsWorkbenchPage
// rendered before this WO (P2's enumeration). Family: .sketch-confirm-overlay
// (app.css:6279-6296) -- same centered/compact/rounded-card geometry -- but
// its OWN class family (.workbench-confirm-bar*) so this file never touches
// SKC-17's frozen .sketch-tool-btn rules.
//
// Centered near the viewport bottom and capped to a modest max-width so it
// NEVER spans full width and NEVER intersects .view-cube-wrap (bottom-left,
// 120x120 -- app.css:2825-2839): the confirm bar sits center-anchored
// (left:50%, translateX(-50%)), the cube sits pinned to the left edge, and
// the bar's own max-width keeps its left edge well clear of the cube's right
// edge on any viewport wide enough to render the workbench at all.

import type { ReactNode } from 'react'

export interface WorkbenchConfirmBarAction {
  testId: string
  label: string
  /** 'primary' renders the accent Done/Apply action; default is the ghost Cancel styling. */
  variant?: 'primary' | 'ghost'
  onClick(): void
}

export interface WorkbenchConfirmBarProps {
  /** Root data-testid -- callers keep their own existing per-flow ids (pick/npick/pushpull/dressup hint), unchanged by this WO. */
  testId: string
  message: ReactNode
  /** Push/pull's red refusal state (P2: rgba(214,69,69,0.9)) -- the ONLY per-flow visual variant this bar carries. */
  refusal?: boolean
  /** Per-flow extras between the message and the actions -- the hover readout span, or push/pull's live delta-mm input. */
  children?: ReactNode
  actions: WorkbenchConfirmBarAction[]
}

/** Shared compact confirm bar -- all four workbench pick-flows route through this ONE component (D2 acceptance: "no flow keeps a bespoke bar"). */
export function WorkbenchConfirmBar({ testId, message, refusal = false, children, actions }: WorkbenchConfirmBarProps) {
  return (
    <div
      data-testid={testId}
      role="dialog"
      className={refusal ? 'workbench-confirm-bar workbench-confirm-bar--refusal' : 'workbench-confirm-bar'}
    >
      {/* WO UI-18-R1 (Finding 3 / design-review B1): the message can now
          ellipsize (app.css .workbench-confirm-message) at narrow viewports
          or long refusal text -- `title` keeps the full text reachable
          (hover tooltip) exactly as the CSS comment promises. Every real
          caller passes a string; a non-string ReactNode (none exist today)
          just gets no tooltip rather than a broken one. */}
      <span className="workbench-confirm-message" data-tooltip={typeof message === 'string' ? message : undefined}>{message}</span>
      {children}
      <span className="workbench-confirm-actions">
        {actions.map((a) => (
          <button
            key={a.testId}
            type="button"
            data-testid={a.testId}
            className={a.variant === 'primary' ? 'modal-btn modal-btn-primary' : 'modal-btn modal-btn-ghost'}
            onClick={a.onClick}
          >
            {a.label}
          </button>
        ))}
      </span>
    </div>
  )
}
