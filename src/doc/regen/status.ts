// Per-feature regeneration status + typed diagnostics (DOC lane, WO DOC-5, WP2.3).
//
// docs/3d-modeling-plan.md §3.4: "UI shows per-feature status (ok / computing /
// warning / error-degraded)." This module is the plain-data STATE MODEL those
// badges render from -- NOT the badge/panel UI itself (that is UI-3's dialog
// framework territory, WO DOC-5 ruling 4). The scheduler (scheduler.ts) is the
// only writer; everything here is pure, serializable, and kernel-free.
//
// Determinism (WO DOC-5 AC #5): a status transition is recorded ONLY when the
// scheduler processes a node, and the scheduler processes nodes in the DAG's
// deterministic topological order -- so two runs of the same edit script
// produce identical transition logs. There is no timestamp on a transition and
// no wall-clock read anywhere in this module or scheduler.ts (the AC #5 grep
// asserts it); a transition carries only which node moved and between which two
// states.

import type { Diag } from '../../geom/geom-service'

/**
 * Per-feature status (the plan's ok / computing / warning / error-degraded,
 * named for the scheduler's state machine):
 *  - 'ok'       : regenerated cleanly, all refs resolved.
 *  - 'dirty'    : marked for regeneration, not yet (re)executed.
 *  - 'running'  : currently executing its kernel op through the worker seam.
 *  - 'failed'   : its OWN kernel op failed (carries the op's typed Diag).
 *  - 'degraded' : standing but not freshly regenerated -- either an UPSTREAM
 *                 feature failed (this node kept its last-good geometry and was
 *                 skipped), one of its own refs resolved 'lost', or an
 *                 upstream node it directly/transitively consumes no longer
 *                 EXISTS in the dag at all (WO DOC-4-R1.1: e.g. undoing a
 *                 parameter's genesis creation removes its node entirely --
 *                 UPSTREAM_REMOVED is the same skip-the-op/degrade treatment
 *                 as UPSTREAM_FAILED, applied to a producer that is gone
 *                 rather than merely failed). The plan's "degraded, not
 *                 deleted": it stays in the tree with an error badge and its
 *                 last-known geometry; the error badge keeps failed
 *                 features visible.
 *  - 'suppressed' : WO UI-6 (BK-39) -- the node itself, or an upstream node
 *                 it transitively consumes, carries the suppress flag
 *                 (FeatureDag.isEffectivelySuppressed). Its kernel op is
 *                 skipped ENTIRELY -- zero engine calls -- deliberately, not
 *                 as a failure: mission #2's absent-not-error rule means
 *                 this is never conflated with 'degraded'/'failed'. Checked
 *                 before failure isolation in the scheduler's pass loop, so
 *                 a suppressed node downstream of an unrelated failure still
 *                 reports 'suppressed' (the more specific, deliberate state).
 *  - 'rolledBack' : WO UI-7 (BK-40) -- the node sits at or after the
 *                 document's rollback marker (FeatureDag.isRolledBack), a
 *                 DIFFERENT mechanism from 'suppressed' (order-position vs
 *                 per-node/cascade flag): moving the marker back restores it
 *                 with zero stored state, exactly like 'suppressed' restores
 *                 on unsuppress. Its kernel op is skipped ENTIRELY -- same
 *                 absent-not-error treatment -- checked in the SAME first
 *                 gate as 'suppressed' (right after it) so the two never get
 *                 conflated with each other either: a node that is BOTH
 *                 user-suppressed and rolled back reports 'suppressed' (the
 *                 more specific, individually-authored state), matching the
 *                 mission's "a user-suppressed feature stays suppressed when
 *                 the marker passes it" rule.
 */
export type FeatureStatus = 'ok' | 'dirty' | 'running' | 'failed' | 'degraded' | 'suppressed' | 'rolledBack'

/** A node whose status has never been set is treated as needing a first build. */
export const DEFAULT_STATUS: FeatureStatus = 'dirty'

/**
 * DOC-local structured diagnostic for scheduler-originated conditions.
 * geom-service.ts's DiagCode is frozen and cannot grow a scheduler-specific
 * code (same constraint dag.ts's DagDiag works around), so degraded-by-upstream
 * gets its own code union here. A 'failed' node instead carries the executor's
 * own geom-service Diag[] (e.g. KERNEL_OP_FAILED) verbatim -- both shapes share
 * the { code, severity, params } surface, unified as RegenDiagnostic below.
 * UPSTREAM_REMOVED (WO DOC-4-R1.1) is UPSTREAM_FAILED's sibling for a
 * producer that no longer exists in the dag at all (vs one that exists but
 * failed) -- see RegenScheduler.firstMissingUpstream.
 */
export type RegenDiagCode = 'UPSTREAM_FAILED' | 'UPSTREAM_REMOVED'

export interface RegenDiag {
  code: RegenDiagCode
  severity: 'warning' | 'error'
  params: Record<string, string>
}

/** Either a geom-service op diagnostic or a scheduler-originated one. */
export type RegenDiagnostic = Diag | RegenDiag

/** One recorded status change (AC #5's deterministic transition log entry). */
export interface StatusTransition {
  id: string
  from: FeatureStatus
  to: FeatureStatus
}

/**
 * The per-feature status store. Holds the current status + diagnostics for
 * every node the scheduler has touched, plus an append-only transition log used
 * by the determinism test. Pure data: no timers, no randomness, no kernel refs.
 */
export class FeatureStatusStore {
  private readonly status = new Map<string, FeatureStatus>()
  private readonly diags = new Map<string, RegenDiagnostic[]>()
  private readonly log: StatusTransition[] = []

  /** Current status of a node (DEFAULT_STATUS if never set). */
  statusOf(id: string): FeatureStatus {
    return this.status.get(id) ?? DEFAULT_STATUS
  }

  /** Structured diagnostics attached at the node's last status change (copy). */
  diagnosticsOf(id: string): RegenDiagnostic[] {
    // The clone preserves each element's own discriminated shape; the cast only
    // re-narrows the union that spreading a { code, severity, params } widens.
    return (this.diags.get(id) ?? []).map(
      (d) => ({ ...d, params: d.params ? { ...d.params } : d.params }) as RegenDiagnostic,
    )
  }

  /**
   * Set a node's status. Records a transition ONLY when the status actually
   * changes (a no-op re-set of the same status is not logged, so re-marking an
   * already-dirty node adds no noise to the deterministic log). `diagnostics`
   * replaces the node's stored diagnostics (pass [] to clear them on a return
   * to 'ok').
   */
  set(id: string, to: FeatureStatus, diagnostics: RegenDiagnostic[] = []): void {
    const from = this.statusOf(id)
    this.diags.set(id, diagnostics)
    if (from === to) return
    this.status.set(id, to)
    this.log.push({ id, from, to })
  }

  /** True if any tracked node is still 'running' (AC #2: none may be stuck). */
  hasRunning(): boolean {
    for (const s of this.status.values()) if (s === 'running') return true
    return false
  }

  /** Every tracked node's status, sorted by id (deterministic snapshot). */
  entries(): Array<[string, FeatureStatus]> {
    return [...this.status.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  }

  /** The append-only transition log (copy). Identical across two identical edit scripts. */
  transitions(): StatusTransition[] {
    return this.log.map((t) => ({ ...t }))
  }
}
