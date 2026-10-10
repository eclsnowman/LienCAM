// Regeneration scheduler (DOC lane, WO DOC-5, WP2.3).
//
// docs/3d-modeling-plan.md §3.4: "dirty-marking from the edited node downstream
// only (DAG reachability); regeneration runs in the geometry worker
// sequentially per body chain; UI shows per-feature status; cancellable (kernel
// calls are chunked per feature)."
//
// This is the parametric backbone's engine room. It WRAPS the existing regen
// code path -- FeatureDag.regenerate(map) -- rather than forking a second one
// (WO DOC-5 ruling 2). regenerate() is DOC-2's honest per-node ref-resolution +
// degraded-marking pass; the scheduler adds the four things it does not do:
//   1. dirty-marking   -- only the edited node's downstream closure re-executes
//   2. execution       -- driving each dirty feature's kernel op, in topo order,
//                         SEQUENTIALLY through the single-threaded worker seam
//   3. cancellation    -- a second edit mid-pass cancels + reschedules cleanly
//   4. per-feature status + failure isolation (failed / degraded)
//
// Determinism (AC #5): NO wall-clock read anywhere -- no clock/timestamp API is
// called in any scheduling decision (the AC #5 grep asserts this). Cancellation
// is driven by control flow (a newer run() cancels the older pass's token at a
// chunk boundary), never by a clock; ordering is the DAG's deterministic
// topoOrder. Two runs of the same edit script produce identical transition logs
// and identical final ID sets. Zero kernel dependency: only plain-data types
// cross this module; the kernel lives behind the injected FeatureOp seam.
//
// WO DOC-4-R1.1 rider (ownership note): this file is DOC-5's; DOC-4-R1 makes
// ONE pure addition here (firstMissingUpstream() + its call site in pass(),
// plus status.ts's sibling UPSTREAM_REMOVED diag code) rather than forking a
// second scheduler. It generalizes the EXISTING failed-upstream isolation
// (item 4 above) to a producer that no longer exists in the dag at all (e.g.
// undoing a parameter's genesis creation), so a feature/sketch/datum/body/
// import consuming a removed parameter is guaranteed to degrade -- never
// silently stay 'ok' on stale geometry -- regardless of what its own kernel
// op does or does not check. See params/table.ts's undo() for the caller.

import type { Diag, OpResult } from '../../geom/geom-service'
import type { DagNodeSnapshot, FeatureDag } from '../dag'
import type { ElementMap } from '../element-map'
import { applyFeatureDelta } from '../replay'
import { FeatureStatusStore } from './status'
import type { FeatureStatus, RegenDiagnostic, StatusTransition } from './status'

/**
 * The worker seam the scheduler drives (WO DOC-5 read-first #4 / ruling 5).
 * Given a node, execute its kernel op through the (mock or real) single-threaded
 * geometry worker and return the geom-service OpResult. The scheduler applies
 * the result's elementMap delta and never calls this concurrently -- it is the
 * ORDER/SKIP/CANCEL/REPORT layer, never a parallel kernel driver. The kernel
 * call is atomic per feature (the "chunk"); cancellation is checked at the
 * boundaries between chunks, not mid-call.
 */
export type FeatureOp = (node: DagNodeSnapshot) => Promise<OpResult>

/** Outcome of one run() pass. */
export interface RegenPassResult {
  /** Node ids whose kernel op actually executed this pass, in execution order. */
  executed: string[]
  /** true if a newer run() cancelled this pass before it drained the dirty set. */
  cancelled: boolean
}

/**
 * Caller-owned live publication used by create-capable prepared adoption.
 *
 * `publish` owns exactly one live create command. It may synchronously execute
 * that command through CommandHistory and publish the matching provisional
 * document/cache/scene state; JavaScript cannot interleave another pass before
 * commit/rollback closes this boundary. `commit` finalizes any remaining
 * caller-owned provisional transactions only after the scheduler has adopted
 * every prepared result. `commit` MUST NOT throw: no general inverse exists
 * for an already-applied ElementMap lineage update.
 * `rollback` must restore the exact pre-publication live state and is invoked
 * for any failure after the non-cancellable adoption boundary is entered.
 *
 * All three callbacks are synchronous by design: no other scheduler pass may
 * observe the provisional node between publish and commit/rollback.
 */
export interface PreparedAdoptionTransaction {
  publish(): void
  commit(): void
  rollback(): void
}

/**
 * WO UI-51A-R5 (audit MAJOR 2, seam contract): the scheduler's own
 * classification of what a dirty node's pass() turn will do, exposed as the
 * house runtime-const pattern (DAG_NODE_KINDS, src/doc/dag.ts:38-39;
 * DEFEATURE_CLASS_DISPOSITIONS, dialogs/DefeatureDialog.tsx) so a table-driven
 * test can iterate the CONST itself (derived completeness) rather than a
 * hand-copied list, and so a new value fails compilation at every
 * never-default exhaustive switch that consumes it. Precedence mirrors
 * pass()'s own branch order exactly: 'suppressed' > 'rolledBack' >
 * 'failedUpstream' > 'missingUpstream' -- with 'unsettledUpstream' added
 * after 'missingUpstream' for a use pass() itself never needs (see
 * dispositionOf's own doc comment) and 'executable' last, the fall-through
 * default that lets pass() proceed to call the kernel op.
 */
export const PASS_DISPOSITIONS = [
  'suppressed',
  'rolledBack',
  'failedUpstream',
  'missingUpstream',
  'unsettledUpstream',
  'executable',
] as const
export type PassDisposition = (typeof PASS_DISPOSITIONS)[number]

/** dispositionOf's result. `upstreamId` is set for the two upstream-relative
 *  kinds (failedUpstream/missingUpstream/unsettledUpstream), the same
 *  deterministically-smallest id firstFailedUpstream/firstMissingUpstream
 *  already picked -- feeding the UPSTREAM_FAILED/UPSTREAM_REMOVED
 *  diagnostics byte-identically to before this WO. */
export interface PassDispositionResult {
  kind: PassDisposition
  upstreamId?: string
}

/** Pass token. Prepared adoption is serialized through the same tail but cannot
 * be cancelled after its synchronous document/cache publication has started. */
interface PassToken {
  cancelled: boolean
  cancellable: boolean
}

export class RegenScheduler {
  private readonly dag: FeatureDag
  private readonly map: ElementMap
  private readonly store = new FeatureStatusStore()

  /** Nodes marked for regeneration but not yet (re)executed. */
  private readonly dirty = new Set<string>()

  /** WO-1402: nodes finalize() moved 'ok' -> 'degraded' for an unresolved
   *  reference, with the diagnostics it set and the 'ok' diagnostics to restore. */
  private readonly referenceDegraded = new Map<string, { set: RegenDiagnostic[]; prior: RegenDiagnostic[] }>()

  /** The in-flight pass's token (null when idle); a newer run() cancels it. */
  private current: PassToken | null = null
  /** Serializes passes: a newer run() waits for the older to fully unwind before
   *  touching the map/store, so the worker seam is never entered concurrently. */
  private tail: Promise<void> = Promise.resolve()

  constructor(dag: FeatureDag, map: ElementMap) {
    this.dag = dag
    this.map = map
  }

  // -----------------------------------------------------------------------
  // Dirty marking (AC #1: edited node -> its downstream closure only).
  // -----------------------------------------------------------------------

  /**
   * Mark a node (and its transitive DAG-downstream dependents -- the "consumes"
   * reachability closure) dirty. Untouched branches are never included, so they
   * never re-execute (AC #1's over-regeneration guard). Idempotent: re-marking
   * an already-dirty node adds nothing to the transition log.
   */
  markDirty(id: string): void {
    if (!this.dag.has(id)) {
      throw new Error(`RegenScheduler.markDirty: no such node '${id}'.`)
    }
    for (const nid of this.downstreamClosure([id])) {
      this.dirty.add(nid)
      this.store.set(nid, 'dirty', [])
    }
  }

  // -----------------------------------------------------------------------
  // The pass driver.
  // -----------------------------------------------------------------------

  /**
   * Regenerate the currently-dirty closure by driving `executor` once per dirty
   * node in topological order. If a pass is already in flight, it is cancelled
   * at its next chunk boundary and this call runs after it unwinds -- so the
   * combined edits regenerate as one clean pass and no worker call ever overlaps
   * another. Returns when this pass finishes (or is itself cancelled by a
   * still-newer run()).
   */
  async run(executor: FeatureOp): Promise<RegenPassResult> {
    // Cancel any in-flight pass; it unwinds at its next chunk boundary.
    if (this.current?.cancellable) this.current.cancelled = true

    // Serialize behind the prior pass's unwind (single-threaded worker seam).
    const prior = this.tail
    let release!: () => void
    this.tail = new Promise<void>((r) => {
      release = r
    })
    await prior

    const token: PassToken = { cancelled: false, cancellable: true }
    this.current = token
    try {
      return await this.pass(executor, token)
    } finally {
      if (this.current === token) this.current = null
      release()
    }
  }

  /**
   * Publish results already executed against an isolated candidate scheduler.
   * The synchronous callback is the single adoption boundary: a competing
   * run() queues behind it instead of cancelling a document/cache commit that
   * has already begun.
   */
  async adoptPrepared(
    executed: readonly string[],
    resultFor: (id: string) => OpResult,
    commitAndPublish: () => void,
  ): Promise<RegenPassResult> {
    const prepared = executed.map((id) => {
      const node = this.dag.getNode(id)
      if (node === undefined) {
        throw new Error(`RegenScheduler.adoptPrepared: no such node '${id}'.`)
      }
      return { id, node, result: resultFor(id) }
    })
    if (this.current?.cancellable) this.current.cancelled = true

    const prior = this.tail
    let release!: () => void
    this.tail = new Promise<void>((r) => {
      release = r
    })
    await prior

    const token: PassToken = { cancelled: false, cancellable: false }
    this.current = token
    try {
      commitAndPublish()
      for (const { id, node, result } of prepared) {
        if (result.ok) {
          if (result.elementMap) applyFeatureDelta(this.map, result.elementMap)
          this.dirty.delete(id)
          this.store.set(id, 'ok', warningDiags(result.diagnostics))
        } else {
          this.dirty.delete(id)
          this.store.set(id, 'failed', failedDiags(result.diagnostics, node.id))
        }
      }
      this.dag.regenerate(this.map)
      this.finalize([...executed])
      return { executed: [...executed], cancelled: false }
    } finally {
      if (this.current === token) this.current = null
      release()
    }
  }

  /**
   * Adopt prepared results for a transaction that creates a live feature.
   *
   * Unlike adoptPrepared(), node resolution deliberately happens inside the
   * serialized, non-cancellable boundary and after transaction.publish(). A
   * brand-new feature id therefore need not exist in the live DAG before this
   * call queues. The caller's transaction remains provisional until every
   * result has been validated and adopted without re-entering the executor.
   *
   * Result validation happens before the first scheduler/ElementMap mutation.
   * After validation, the remaining scheduler path is limited to deterministic
   * Set/Map updates, ElementMap delta application, and FeatureDag regeneration;
   * those operations contain no injected/caller callback seam. If any of them
   * nevertheless throws, rollback is still invoked before the boundary opens.
   */
  async adoptPreparedWithTransaction(
    executed: readonly string[],
    resultFor: (id: string) => OpResult,
    transaction: PreparedAdoptionTransaction,
  ): Promise<RegenPassResult> {
    // Snapshot caller-owned input before the first await. A mutable array must
    // not be able to change which ids are adopted while this call waits behind
    // an older pass.
    const adoptionIds = [...executed]
    if (new Set(adoptionIds).size !== adoptionIds.length) {
      throw new Error('RegenScheduler.adoptPreparedWithTransaction: executed ids must be unique.')
    }

    // Cancel an older cancellable pass, then serialize behind its complete
    // unwind before the caller is allowed to publish provisional live state.
    if (this.current?.cancellable) this.current.cancelled = true

    const prior = this.tail
    let release!: () => void
    this.tail = new Promise<void>((r) => {
      release = r
    })
    await prior

    const token: PassToken = { cancelled: false, cancellable: false }
    this.current = token
    let adoptionApplied = false
    try {
      transaction.publish()

      // Resolve only after publish: a create transaction's ids intentionally
      // do not exist in the live DAG before this boundary.
      const prepared = adoptionIds.map((id) => {
        const node = this.dag.getNode(id)
        if (node === undefined) {
          throw new Error(`RegenScheduler.adoptPreparedWithTransaction: no such node '${id}'.`)
        }
        const result = resultFor(id)
        assertPreparedResult(id, result)
        return { id, node, result }
      })

      for (const { id, node, result } of prepared) {
        if (result.ok) {
          if (result.elementMap) applyFeatureDelta(this.map, result.elementMap)
          this.dirty.delete(id)
          this.store.set(id, 'ok', warningDiags(result.diagnostics))
        } else {
          this.dirty.delete(id)
          this.store.set(id, 'failed', failedDiags(result.diagnostics, node.id))
        }
      }
      this.dag.regenerate(this.map)
      this.finalize(adoptionIds)
      adoptionApplied = true

      // Contractually non-throwing. If a defective caller does throw here, the
      // scheduler adoption is already complete and must not be contradicted by
      // rolling back only the caller-owned live publication.
      transaction.commit()
      return { executed: [...adoptionIds], cancelled: false }
    } catch (error) {
      if (!adoptionApplied) {
        try {
          transaction.rollback()
        } catch (rollbackError) {
          // Preserve the adoption failure as the primary error while retaining
          // the rollback failure for diagnostics. The finally block below must
          // still release the scheduler tail even when rollback is defective.
          if (error instanceof Error && Object.isExtensible(error)) {
            try {
              Object.defineProperty(error, 'rollbackError', {
                value: rollbackError,
                configurable: true,
              })
            } catch {
              // A hostile/frozen Error must not let a secondary rollback fault
              // replace the primary adoption failure.
            }
          }
        }
      }
      throw error
    } finally {
      if (this.current === token) this.current = null
      release()
    }
  }

  private async pass(executor: FeatureOp, token: PassToken): Promise<RegenPassResult> {
    const order = this.dag.topoOrder().filter((id) => this.dirty.has(id))
    const executed: string[] = []

    for (const id of order) {
      // Chunk boundary (before starting): a newer edit cancelled us.
      if (token.cancelled) return { executed, cancelled: true }

      const node = this.dag.getNode(id) as DagNodeSnapshot

      // WO UI-51A-R5 (audit MAJOR 2, seam contract): pass()'s four skip
      // branches (suppressed / rolled back / failed-upstream / missing-
      // upstream -- WO UI-6, WO UI-7, and WO DOC-4-R1.1 respectively, see
      // each branch's history in dispositionOf's own doc comment now) are
      // REPLACED here by one exhaustive switch over dispositionOf(id), the
      // SAME pure query SolidsWorkbenchPage's lookupLiveBody eligibility
      // gate calls (RegenScheduler.supersedesDuringPass below) -- a
      // structural relocation, not a behavior change: dispositionOf's
      // precedence and diagnostics are byte-identical to the four inline
      // checks this replaces (proven by the frozen scheduler suites --
      // scheduler.test.ts, suppress.test.ts, rollback.test.ts,
      // determinism.test.ts -- staying green untouched).
      const disposition = this.dispositionOf(id)
      switch (disposition.kind) {
        case 'suppressed':
          this.dirty.delete(id)
          this.store.set(id, 'suppressed', [])
          continue
        case 'rolledBack':
          this.dirty.delete(id)
          this.store.set(id, 'rolledBack', [])
          continue
        case 'failedUpstream':
          this.dirty.delete(id)
          this.store.set(id, 'degraded', [upstreamFailedDiag(id, disposition.upstreamId as string)])
          continue
        case 'missingUpstream':
          this.dirty.delete(id)
          this.store.set(id, 'degraded', [upstreamRemovedDiag(id, disposition.upstreamId as string)])
          continue
        case 'unsettledUpstream':
        case 'executable':
          // Both fall through to the kernel-op call below. 'unsettledUpstream'
          // is a state pass() itself never actually observes in ordinary
          // operation (see dispositionOf's doc comment on the mid-pass
          // markDirty window) -- mapping it to "proceed" is what keeps this
          // refactor zero-behavior-change: it is exactly what the four
          // original branches already did (none of them fired, so the loop
          // fell through to the kernel op) for any dirty node with a
          // currently-unsettled (but not yet failed/missing) upstream.
          break
        default: {
          const unhandled: never = disposition.kind
          throw new Error(`RegenScheduler.pass: unhandled disposition '${unhandled as string}' for '${id}'.`)
        }
      }

      this.store.set(id, 'running', [])

      // The kernel op is the atomic "chunk". It can settle two ways: return an
      // OpResult (ok, or ok:false for a graceful kernel failure) OR REJECT --
      // the worker RPC threw / the op promise rejected. A rejection is still a
      // kernel-op failure, not an escape hatch out of the scheduler: if we let
      // it propagate, the node stays stuck 'running', its dirty flag never
      // clears, its dependents never degrade, and dag.regenerate/finalize never
      // run. So we catch it here and fold it into the SAME failure-isolation
      // path as an ok:false OpResult (status 'failed' + a typed diagnostic;
      // dependents become 'degraded' via firstFailedUpstream on later chunks).
      let result: OpResult
      try {
        result = await executor(node)
      } catch (err) {
        // Chunk boundary first (uniform with the settled-result path below): if
        // a newer edit cancelled us while the op was in flight, DISCARD -- the
        // combined pass will re-run this node cleanly, so we must not record a
        // spurious 'failed' for a result we are throwing away.
        if (token.cancelled) {
          this.store.set(id, 'dirty', [])
          return { executed, cancelled: true }
        }
        executed.push(id)
        this.dirty.delete(id)
        this.store.set(id, 'failed', rejectionDiag(node.id, err))
        continue
      }

      // Chunk boundary (after the op settles, before committing): if a newer
      // edit arrived while this op was in flight, DISCARD this result (do not
      // apply its delta) and revert the node to 'dirty' so the combined pass
      // re-runs it cleanly. This is what makes the cancelled+rescheduled final
      // state equal a single clean regen (AC #2), with nothing stuck 'running'.
      if (token.cancelled) {
        this.store.set(id, 'dirty', [])
        return { executed, cancelled: true }
      }

      executed.push(id)
      if (result.ok) {
        if (result.elementMap) applyFeatureDelta(this.map, result.elementMap)
        this.dirty.delete(id)
        this.store.set(id, 'ok', warningDiags(result.diagnostics))
      } else {
        this.dirty.delete(id)
        this.store.set(id, 'failed', failedDiags(result.diagnostics, node.id))
      }
    }

    // Refresh ref-resolution-derived degraded state across the DAG through the
    // EXISTING regen path (ruling 2: build on regenerate, don't fork it). This
    // is pure ElementMap resolution -- no kernel op -- so it does not count as
    // re-execution and does not violate AC #1's over-regeneration guard.
    this.dag.regenerate(this.map)
    this.finalize(executed)

    return { executed, cancelled: false }
  }

  /**
   * After the execution loop + dag.regenerate(), reconcile reference-derived
   * degraded state across the WHOLE dag, not only this pass's executed nodes
   * (WO-1402 / BUG-488). A node is held down when its own ref went 'lost'
   * (dag snapshot degraded) or when anything it transitively consumes is --
   * an offset datum, its hosted sketch and the dependent solid all stand on a
   * support face that no longer resolves, whether or not they re-executed.
   * A held 'ok' node becomes 'degraded' carrying the unresolved-reference
   * diagnostics. A node this method degraded earlier returns to its prior
   * 'ok' diagnostics once nothing holds it. 'failed', upstream-failed/removed,
   * suppressed and rolled-back nodes keep their scheduler status.
   */
  private finalize(executed: string[]): void {
    for (const id of executed) this.referenceDegraded.delete(id)
    const carried = new Map<string, RegenDiagnostic[]>()
    for (const id of this.dag.topoOrder()) {
      const snap = this.dag.getNode(id) as DagNodeSnapshot
      const diags: RegenDiagnostic[] = snap.degraded ? [...(snap.diagnostics as RegenDiagnostic[])] : []
      const seen = new Set(diags.map((d) => JSON.stringify(d)))
      for (const producer of snap.consumes) {
        for (const d of carried.get(producer) ?? []) {
          const key = JSON.stringify(d)
          if (seen.has(key)) continue
          seen.add(key)
          diags.push(d)
        }
      }
      if (diags.length > 0) carried.set(id, diags)

      const status = this.store.statusOf(id)
      const mine = this.referenceDegraded.get(id)
      const stillMine = mine !== undefined && status === 'degraded' && sameDiags(this.store.diagnosticsOf(id), mine.set)
      if (mine !== undefined && !stillMine) this.referenceDegraded.delete(id)

      if (diags.length > 0) {
        if (status === 'ok') {
          this.referenceDegraded.set(id, { set: diags, prior: this.store.diagnosticsOf(id) })
          this.store.set(id, 'degraded', diags)
        } else if (stillMine && !sameDiags(diags, mine.set)) {
          this.referenceDegraded.set(id, { set: diags, prior: mine.prior })
          this.store.set(id, 'degraded', diags)
        }
      } else if (stillMine) {
        this.referenceDegraded.delete(id)
        this.store.set(id, 'ok', mine.prior)
      }
    }
  }

  // -----------------------------------------------------------------------
  // Read-only status surface (WP2.5 consumers: badges/panel live in UI-3).
  // -----------------------------------------------------------------------

  statusOf(id: string): FeatureStatus {
    return this.store.statusOf(id)
  }

  diagnosticsOf(id: string): RegenDiagnostic[] {
    return this.store.diagnosticsOf(id)
  }

  /**
   * WO UI-51A-R5 (audit MAJOR 2, seam contract): the ONE pure classification
   * of what `id`'s own pass() turn will do, callable from BOTH pass() itself
   * (via the exhaustive switch above) and from an outside eligibility check
   * (SolidsWorkbenchPage's lookupLiveBody, through supersedesDuringPass
   * below) -- so the two can never drift apart the way the page's former
   * hand-copied willBeSkippedThisPass did. Precedence mirrors pass()'s own
   * branch order exactly: suppressed > rolledBack > failedUpstream >
   * missingUpstream (the node.kind !== 'parameter' exemption on
   * missingUpstream is preserved, same reasoning as pass()'s own comment)
   * -- then, new for this WO, unsettledUpstream: a transitively-consumed
   * upstream id whose CURRENT status is still 'dirty' (has neither executed
   * nor been skipped yet this pass), so `id`'s own eventual disposition is
   * not yet decidable from currently-settled information alone. pass()
   * itself never actually observes 'unsettledUpstream' in ordinary
   * operation -- topo order guarantees every true upstream of `id` has
   * already been processed (and is therefore settled: ok/failed/degraded/
   * suppressed/rolledBack, never still 'dirty') by the time pass() reaches
   * `id`'s own turn in the SAME pass; the one exception is a node dirtied
   * MID-pass by another node's own executor (a dynamic dependency pass()
   * already tolerates today), where 'unsettledUpstream' can transiently
   * apply and pass()'s switch maps it to "proceed" -- zero behavior change,
   * because that is exactly what happens today (none of the four original
   * branches fire, so the loop falls through to the kernel op). Eligibility
   * DOES observe it routinely: a sibling's own turn runs before some other
   * consumer's failing upstream has settled (WO UI-51A-R5's governing
   * ruling, "second bounce") -- that is the state this WO's fix closes.
   * Only meaningful for a currently-'dirty' id; callers already gate on
   * that (pass()'s topo-filtered order; supersedesDuringPass below).
   */
  dispositionOf(id: string): PassDispositionResult {
    if (this.dag.isEffectivelySuppressed(id)) return { kind: 'suppressed' }
    if (this.dag.isRolledBack(id)) return { kind: 'rolledBack' }
    const failedUpstream = this.firstFailedUpstream(id)
    if (failedUpstream !== undefined) return { kind: 'failedUpstream', upstreamId: failedUpstream }
    const node = this.dag.getNode(id)
    if (node !== undefined && node.kind !== 'parameter') {
      const missingUpstream = this.firstMissingUpstream(id)
      if (missingUpstream !== undefined) return { kind: 'missingUpstream', upstreamId: missingUpstream }
    }
    const unsettledUpstream = this.firstUnsettledUpstream(id)
    if (unsettledUpstream !== undefined) return { kind: 'unsettledUpstream', upstreamId: unsettledUpstream }
    return { kind: 'executable' }
  }

  /**
   * WO UI-51A-R5 (audit MAJOR 1 fix + seam contract's "eligibility-only
   * downstream-of-running relativization", ALSO scheduler-owned so the page
   * retains zero predicate logic of its own). Answers exactly the question
   * lookupLiveBody's hasBody predicate needs for a currently-'dirty'
   * `candidateId` that already holds a retained body handle, relative to
   * `currentId` (the node whose own executor is running right now): does
   * `candidateId` still count as superseding its inputs this pass, or has
   * it (or will it) actually reach its own kernel op and re-derive its
   * `consumes` edge -- in which case its STALE edge must not be trusted yet?
   *
   * The rule (governing ruling, WO UI-51A-R5, "second bounce"): `candidateId`
   * KEEPS SUPERSEDING its inputs (returns true) unless EITHER
   *   (a) `candidateId` is transitively DOWNSTREAM of `currentId` via
   *       `consumes` edges -- any retention `candidateId` later does
   *       supersedes `currentId`'s own just-built result too, so two live
   *       consumers of the SAME target is impossible either way; this is
   *       what keeps deep replay chains (F1<-F2<-F3<-F4, replay F2) working,
   *       since every downstream link would otherwise look "unsettled" and
   *       wrongly block F2's own resolution of F1 -- checked FIRST, ahead of
   *       disposition, precisely to exempt this case regardless of what
   *       dispositionOf would say (a 'running' currentId only ever appears
   *       in candidateId's upstream walk when candidateId IS downstream of
   *       it, so 'running' never needs its own special case here); or
   *   (b) `candidateId`'s disposition, from CURRENTLY SETTLED statuses, is
   *       'executable' -- i.e. no failed/missing/suppressed/rolledBack
   *       upstream AND no transitively-dirty (unsettled) upstream either, so
   *       nothing can still change its outcome later in this pass. This is
   *       the ONLY case where `candidateId` is guaranteed to actually reach
   *       its kernel op and stops superseding (returns false).
   * Every other disposition (suppressed/rolledBack/failedUpstream/
   * missingUpstream -- guaranteed to be skipped -- or unsettledUpstream --
   * not yet decidable) keeps `candidateId` superseding: a guaranteed skip
   * never re-derives its edge, and an undecided one must be treated
   * conservatively until it settles, exactly the MAJOR 1 fix.
   */
  supersedesDuringPass(candidateId: string, currentId: string): boolean {
    if (this.isDownstreamOf(candidateId, currentId)) return false
    // Never-default exhaustive switch (preflight amendment 4, R5 audit major):
    // a NEW PassDisposition value must fail compilation HERE too, so its
    // eligibility meaning is classified deliberately - an inequality would
    // silently inherit the conservative default instead.
    const kind = this.dispositionOf(candidateId).kind
    switch (kind) {
      case 'executable':
        return false
      case 'suppressed':
      case 'rolledBack':
      case 'failedUpstream':
      case 'missingUpstream':
      case 'unsettledUpstream':
        return true
      default: {
        const unreachable: never = kind
        throw new Error(`supersedesDuringPass: unclassified PassDisposition ${String(unreachable)}`)
      }
    }
  }

  /** Deterministic, id-sorted snapshot of every tracked node's status. */
  statuses(): Array<[string, FeatureStatus]> {
    return this.store.entries()
  }

  /** The append-only status transition log (AC #5: identical across identical scripts). */
  transitions(): StatusTransition[] {
    return this.store.transitions()
  }

  /** True while any node is stuck 'running' (AC #2 asserts this is false once idle). */
  hasRunning(): boolean {
    return this.store.hasRunning()
  }

  /**
   * WO SKC-4-R1.2 (pure addition, read-only -- pass()/run() are otherwise
   * untouched). True if the currently in-flight pass has already been
   * superseded by a newer run() call (its token flagged cancelled at that
   * newer run()'s synchronous start, per run()'s own cancel-then-serialize
   * comment above). A FeatureOp whose own async work spans that cancellation
   * window (e.g. a slow kernel call, or a test's deterministic op-gate) can
   * poll this immediately before committing a side effect the pass()
   * boundary check would otherwise discard anyway (see sketch3d/regen.ts's
   * makeSketch3dExecutor) -- pass() only guards its OWN store/map/executed
   * bookkeeping at the chunk boundary; it has no way to know about (or undo)
   * a side effect a caller-supplied FeatureOp made directly to the dag
   * before returning. False while idle (no pass in flight) -- nothing to be
   * superseded. Reading `this.current` here is safe without extra
   * synchronization: only the pass that owns it ever calls this while it is
   * still `this.current` (run()'s finally clears it only after pass()
   * settles), so there is no ambiguity about whose cancellation flag this is.
   */
  isCurrentPassCancelled(): boolean {
    return this.current?.cancelled ?? false
  }

  /** Currently-dirty node ids, sorted (test/debug visibility). */
  dirtyIds(): string[] {
    return [...this.dirty].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  }

  // -----------------------------------------------------------------------
  // Internals.
  // -----------------------------------------------------------------------

  /**
   * Transitive downstream closure over "consumes" edges (reverse reachability):
   * `roots` plus every node that transitively consumes one of them. Built from
   * FeatureDag's public API only -- no edit to the DAG store is needed.
   */
  private downstreamClosure(roots: string[]): Set<string> {
    const consumers = new Map<string, string[]>()
    for (const nid of this.dag.nodeIds()) {
      const node = this.dag.getNode(nid) as DagNodeSnapshot
      for (const producer of node.consumes) {
        const list = consumers.get(producer)
        if (list) list.push(nid)
        else consumers.set(producer, [nid])
      }
    }
    const out = new Set<string>()
    const stack = [...roots]
    while (stack.length > 0) {
      const cur = stack.pop() as string
      if (out.has(cur)) continue
      out.add(cur)
      for (const c of consumers.get(cur) ?? []) stack.push(c)
    }
    return out
  }

  /**
   * The nearest transitive UPSTREAM node (walking `consumes`) whose current
   * status is 'failed', or undefined if none. Returns the deterministically
   * smallest such id so the recorded UPSTREAM_FAILED diagnostic is stable.
   */
  private firstFailedUpstream(id: string): string | undefined {
    const failed: string[] = []
    const visited = new Set<string>()
    const start = this.dag.getNode(id)
    const stack = start ? [...start.consumes] : []
    while (stack.length > 0) {
      const cur = stack.pop() as string
      if (visited.has(cur)) continue
      visited.add(cur)
      if (this.store.statusOf(cur) === 'failed') failed.push(cur)
      const node = this.dag.getNode(cur)
      if (node) for (const p of node.consumes) stack.push(p)
    }
    if (failed.length === 0) return undefined
    return failed.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))[0]
  }

  /**
   * WO DOC-4-R1.1 (pure addition -- see status.ts's UPSTREAM_REMOVED and the
   * pass() call site above). The nearest transitive upstream node id (walking
   * `consumes`) that no longer EXISTS in the dag at all, or undefined if
   * every transitively-consumed id is still a real node. Mirrors
   * firstFailedUpstream's own walk shape exactly (same dead-end-on-missing-
   * node behavior for the recursion itself), just checking existence instead
   * of 'failed' status.
   */
  private firstMissingUpstream(id: string): string | undefined {
    const missing: string[] = []
    const visited = new Set<string>()
    const start = this.dag.getNode(id)
    const stack = start ? [...start.consumes] : []
    while (stack.length > 0) {
      const cur = stack.pop() as string
      if (visited.has(cur)) continue
      visited.add(cur)
      const node = this.dag.getNode(cur)
      if (!node) {
        missing.push(cur)
        continue
      }
      for (const p of node.consumes) stack.push(p)
    }
    if (missing.length === 0) return undefined
    return missing.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))[0]
  }

  /**
   * WO UI-51A-R5 (dispositionOf's new branch). The nearest transitive
   * upstream node id (walking `consumes`) whose CURRENT status is still
   * 'dirty' -- i.e. has not yet reached its own pass() turn this pass, so
   * whether IT will execute, degrade, or skip is not yet decided. Mirrors
   * firstFailedUpstream's own walk shape exactly, checking 'dirty' status
   * instead of 'failed'. Deterministic smallest-id result, same as its two
   * siblings, though dispositionOf's 'unsettledUpstream' consumers
   * (dispositionOf itself, supersedesDuringPass) only need the id for the
   * same stable-diagnostic reasoning those siblings already established.
   */
  private firstUnsettledUpstream(id: string): string | undefined {
    const unsettled: string[] = []
    const visited = new Set<string>()
    const start = this.dag.getNode(id)
    const stack = start ? [...start.consumes] : []
    while (stack.length > 0) {
      const cur = stack.pop() as string
      if (visited.has(cur)) continue
      visited.add(cur)
      if (this.store.statusOf(cur) === 'dirty') unsettled.push(cur)
      const node = this.dag.getNode(cur)
      if (node) for (const p of node.consumes) stack.push(p)
    }
    if (unsettled.length === 0) return undefined
    return unsettled.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))[0]
  }

  /**
   * WO UI-51A-R5 (supersedesDuringPass's exemption (a)). True iff
   * `candidateId` is transitively DOWNSTREAM of `currentId` via `consumes`
   * edges -- i.e. `currentId` appears somewhere in candidateId's own
   * transitive upstream set. Same walk shape as firstFailedUpstream/
   * firstMissingUpstream/firstUnsettledUpstream, just testing membership
   * rather than collecting a diagnostic id.
   */
  private isDownstreamOf(candidateId: string, currentId: string): boolean {
    const visited = new Set<string>()
    const start = this.dag.getNode(candidateId)
    const stack = start ? [...start.consumes] : []
    while (stack.length > 0) {
      const cur = stack.pop() as string
      if (cur === currentId) return true
      if (visited.has(cur)) continue
      visited.add(cur)
      const node = this.dag.getNode(cur)
      if (node) for (const p of node.consumes) stack.push(p)
    }
    return false
  }
}

// --------------------------- diagnostic helpers ----------------------------

/** Structural equality of two diagnostic lists (order-sensitive). */
function sameDiags(a: RegenDiagnostic[], b: RegenDiagnostic[]): boolean {
  return a.length === b.length && a.every((d, i) => JSON.stringify(d) === JSON.stringify(b[i]))
}

function upstreamFailedDiag(id: string, failedUpstream: string): RegenDiagnostic {
  return { code: 'UPSTREAM_FAILED', severity: 'warning', params: { id, failedUpstream } }
}

/** WO DOC-4-R1.1: an upstream producer this node consumes no longer exists in the dag at all. */
function upstreamRemovedDiag(id: string, removedUpstream: string): RegenDiagnostic {
  return { code: 'UPSTREAM_REMOVED', severity: 'warning', params: { id, removedUpstream } }
}

/** A rejected worker op carries no OpResult (and thus no op-supplied Diag[]), so
 *  synthesize a typed KERNEL_OP_FAILED that also records the rejection reason.
 *  Deterministic: given the same rejection it produces the same diagnostic, so
 *  the AC #5 transition/diagnostic logs stay identical across identical scripts. */
function rejectionDiag(id: string, err: unknown): RegenDiagnostic[] {
  const reason = err instanceof Error ? err.message : String(err)
  return [{ code: 'KERNEL_OP_FAILED', severity: 'error', params: { id, reason } }]
}

/** A failed op must surface a typed diagnostic (AC #3). If the executor returned
 *  none, synthesize a KERNEL_OP_FAILED so 'failed' is never diagnostic-less. */
function failedDiags(diagnostics: Diag[] | undefined, id: string): RegenDiagnostic[] {
  const errs = (diagnostics ?? []).filter((d) => d.severity === 'error' || d.severity === 'warning')
  if (errs.length > 0) return errs
  return [{ code: 'KERNEL_OP_FAILED', severity: 'error', params: { id } }]
}

/** Non-error diagnostics from a successful op (e.g. REFERENCE_FALLBACK warnings). */
function warningDiags(diagnostics: Diag[] | undefined): RegenDiagnostic[] {
  return (diagnostics ?? []).filter((d) => d.severity !== 'info')
}

/**
 * Fail before prepared adoption mutates the live ElementMap/status store.
 * TypeScript protects ordinary callers, but prepared results can cross worker
 * or persistence boundaries at runtime; malformed deltas must not strand a
 * half-published create transaction.
 */
function assertPreparedResult(id: string, result: OpResult): void {
  if (typeof result !== 'object' || result === null || typeof result.ok !== 'boolean') {
    throw new Error(`RegenScheduler.adoptPreparedWithTransaction: invalid result for '${id}'.`)
  }
  if (result.diagnostics !== undefined && !Array.isArray(result.diagnostics)) {
    throw new Error(`RegenScheduler.adoptPreparedWithTransaction: invalid diagnostics for '${id}'.`)
  }
  const delta = result.elementMap
  if (delta === undefined) return
  if (
    typeof delta !== 'object' || delta === null ||
    delta.featureId !== id ||
    !Array.isArray(delta.generated) ||
    !Array.isArray(delta.deleted) ||
    typeof delta.modified !== 'object' || delta.modified === null || Array.isArray(delta.modified) ||
    Object.values(delta.modified).some((children) => !Array.isArray(children))
  ) {
    throw new Error(`RegenScheduler.adoptPreparedWithTransaction: invalid element-map delta for '${id}'.`)
  }
}
