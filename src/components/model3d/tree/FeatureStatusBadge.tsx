// WO UI-3: per-feature status badge, rendering DOC-5's FeatureStatus
// (ok/dirty/running/failed/degraded -- src/doc/regen/status.ts) with the SAME
// status hues + icon vocabulary the 2D design tree already uses (DesignTree.tsx's
// ProgressRing + CheckCircle2/AlertCircle/Clock/Loader2 from lucide-react, and
// tokens.css's --status-ready/--status-error/--status-outdated/--status-computing/
// --status-pending) -- this is the idiom-match surface acceptance criterion 6
// screenshots against.
//
// 'failed' maps to --status-error (red, own-op failure); 'degraded' maps to
// --status-outdated (amber, standing-but-stale -- matches the plan's "degraded,
// not deleted" framing and the 2D tree's own outdated/stale semantics, distinct
// from a hard error).

import { CheckCircle2, AlertCircle, Ban, Clock, Loader2, Rewind } from 'lucide-react'
import type { FeatureStatus } from '../../../doc'

export interface FeatureStatusBadgeProps {
  status: FeatureStatus
  /** Hover/focus hint (shared ThemedTooltip) -- e.g. a diagnostic summary. */
  tooltip?: string
}

const STATUS_LABEL: Record<FeatureStatus, string> = {
  ok: 'OK',
  dirty: 'Pending regeneration',
  running: 'Regenerating...',
  failed: 'Failed',
  degraded: 'Degraded',
  // WO UI-6 (BK-39, mission #2): deliberately NOT grouped with 'degraded' --
  // absent-by-design, not stale/erroring.
  suppressed: 'Suppressed',
  // WO UI-7 (BK-40, mission #1): its own label, distinct from 'Suppressed' --
  // a marker-position absence, not a per-feature user choice.
  rolledBack: 'Rolled back',
}

const STATUS_COLOR_VAR: Record<FeatureStatus, string> = {
  ok: 'var(--status-ready)',
  dirty: 'var(--status-pending)',
  running: 'var(--status-computing)',
  failed: 'var(--status-error)',
  degraded: 'var(--status-outdated)',
  suppressed: 'var(--text-muted)',
  rolledBack: 'var(--text-muted)',
}

export function FeatureStatusBadge({ status, tooltip }: FeatureStatusBadgeProps) {
  const color = STATUS_COLOR_VAR[status]
  const label = STATUS_LABEL[status]
  return (
    <span
      data-testid="feature-status-badge"
      data-status={status}
      data-tooltip={tooltip ?? label}
      style={{ display: 'inline-flex', alignItems: 'center', color, flexShrink: 0 }}
    >
      {status === 'ok' && <CheckCircle2 size={13} aria-label={label} />}
      {status === 'dirty' && <Clock size={13} aria-label={label} />}
      {status === 'running' && <Loader2 size={13} className="spin" aria-label={label} />}
      {status === 'failed' && <AlertCircle size={13} aria-label={label} />}
      {status === 'degraded' && <AlertCircle size={13} aria-label={label} />}
      {status === 'suppressed' && <Ban size={13} aria-label={label} />}
      {status === 'rolledBack' && <Rewind size={13} aria-label={label} />}
    </span>
  )
}
