// The reactive parameter table (DOC lane, WO DOC-4).
//
// docs/3d-modeling-plan.md §3.4 + Architect ruling 1 (2026-07-08): "The
// FeatureDag already defines the 'parameter' DagNodeKind -- use it.
// Parameters are DAG NODES; dependents consume them via ordinary DAG edges.
// Do not invent a parallel dependency mechanism." ParameterTable is the thin
// CRUD/orchestration layer over that: parsing an expression, wiring the
// parsed references as ordinary `consumes` edges, committing through DOC-2's
// Command layer (ruling 4), and driving DOC-5's RegenScheduler (ruling 3a --
// "a parameter edit committed ... MUST schedule a fresh regeneration through
// the DOC-5 scheduler") so parameters and features regenerate through
// exactly one engine.
//
// Cycle guard-by-construction (AC #2's FAILS-IF): FeatureDag.setConsumes/
// insertNode already refuse to create a cyclic consumes edge -- they throw
// DagCycleError SYNCHRONOUSLY, before any mutation. setExpression() below
// simply catches that and reports a typed PARAM_CYCLE diagnostic; a cyclic
// parameter reference can therefore never actually exist as a consumes edge,
// so evaluation (params/executor.ts) can never be asked to walk one. Self-
// reference is checked even earlier (a name appearing in its own parsed
// refs), before the DAG is touched at all, so it gets its own distinct
// PARAM_SELF_REFERENCE code rather than surfacing as a generic DAG_CYCLE.
//
// Undo/redo scope: ParameterTable owns a PRIVATE CommandHistory (ruling 4:
// "flows through the DOC-2 command layer" -- it is the real class, replay-
// based, capped at HISTORY_CAP, plain-JSON serialize()). It is scoped to
// parameter edits only, not shared with a document-wide feature-tree undo
// stack (no such shared orchestrator exists yet in this codebase for DOC-4 to
// integrate with -- SKC-4/a future document layer can construct its own
// CommandHistory over the SAME FeatureDag for feature commands; the two
// histories never conflict because a parameter command only ever touches the
// parameter nodes it created/edited). What "undo restores dependent feature
// state" means here: undoing a parameter edit reverts its DAG payload/
// consumes, then re-runs the SAME shared RegenScheduler, which regenerates
// every downstream feature against the restored value -- the shared
// scheduler+dag+map is what makes cross-cutting state "restored", not a
// shared undo stack.
//
// Genesis-undo cascade (WO DOC-4-R1.1, Architect ruling): undoing a
// parameter's very FIRST commit (an InsertNodeCommand) removes the node
// entirely, not just its value -- "restores dependent feature state
// together" therefore means every direct/transitive consumer of the removed
// parameter must ALSO re-evaluate and land in a real failed/degraded state,
// never keep stale 'ok' geometry against an input that no longer exists.
// undo() captures the removed node's direct consumers BEFORE the removal
// (dag.has(id) becomes false right after, and scheduler.markDirty requires
// an existing node) and drives each of them through the shared scheduler --
// see undo()'s own comment and regen/scheduler.ts's firstMissingUpstream for
// the mechanism.

import type { Diag } from '../../geom/geom-service'
import { CommandHistory, HISTORY_CAP, InsertNodeCommand, type Command } from '../commands'
import { DagCycleError, type FeatureDag } from '../dag'
import type { FeatureOp, FeatureStatus, RegenDiagnostic, RegenPassResult, RegenScheduler } from '../regen'
import { SetParameterExpressionCommand } from './commands'
import { asParameterPayload, makeParameterAwareExecutor, paramDiagFromDiag, type ParameterPayload } from './executor'
import { paramNameFromNodeId, paramNodeId } from './node-id'
import { parseExpression, type ParsedExpression } from './parser'
import { ParamParseError, type ParamDiag } from './types'

export type ParameterDiagnostic = ParamDiag | RegenDiagnostic

export interface SetExpressionOutcome {
  ok: boolean
  nodeId: string
  /** Present when ok:false -- the edit was rejected before touching the dag
   *  (syntax error, self-reference, cycle) or before scheduling (invalid name). */
  diag?: ParamDiag
  /** Present when ok:true -- the regeneration pass the commit triggered. */
  pass?: RegenPassResult
}

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
// "mm"/"in" are grammar-reserved unit suffixes and 'pi' is the reserved
// constant (params/parser.ts, WO DOC-4-R1.4.A) -- a parameter cannot be
// named any of them, so "5mm"/"pi" are never ambiguous with a parameter
// reference. Function names (sin, cos, ...) are NOT reserved: the grammar
// only treats an identifier as a call when immediately followed by '(', so a
// bare reference to a same-named parameter is never ambiguous.
const RESERVED_NAMES = new Set(['mm', 'in', 'pi'])

function invalidNameDiag(name: string): ParamDiag {
  return {
    code: 'PARAM_SYNTAX_ERROR',
    severity: 'error',
    params: { name, detail: "parameter name must match [A-Za-z_][A-Za-z0-9_]* and not be reserved ('mm', 'in', 'pi')" },
  }
}

const NOOP_KERNEL_OP: FeatureOp = async () => ({ ok: true, diagnostics: [] })

export class ParameterTable {
  private readonly dag: FeatureDag
  private readonly scheduler: RegenScheduler
  /** The combined parameter+kernel executor to drive scheduler.run() with --
   *  public so an initial/external build of non-parameter nodes can share it. */
  readonly executor: FeatureOp
  private readonly history: CommandHistory
  // Parallel to `history`'s own private past/future stacks, kept in lockstep
  // (same cap, cleared-on-new-execute) because CommandHistory does not expose
  // WHICH node a popped command touched -- see module comment. Safe because
  // this table is the only thing that ever calls execute/undo/redo on `history`.
  private readonly touchedPast: string[] = []
  private readonly touchedFuture: string[] = []

  constructor(dag: FeatureDag, scheduler: RegenScheduler, kernelOp: FeatureOp = NOOP_KERNEL_OP) {
    this.dag = dag
    this.scheduler = scheduler
    this.executor = makeParameterAwareExecutor(dag, kernelOp)
    this.history = new CommandHistory(dag)
  }

  /** Wraps an already-populated dag (e.g. just restored from a save) --
   *  discovers existing parameter nodes generically; undo history starts
   *  fresh (undo stacks are session-only, never persisted -- matching
   *  CommandHistory itself, which DOC-3's format never serializes). A dag
   *  with zero 'parameter' nodes (a pre-DOC-4 save) yields an empty table. */
  static fromDag(dag: FeatureDag, scheduler: RegenScheduler, kernelOp?: FeatureOp): ParameterTable {
    return new ParameterTable(dag, scheduler, kernelOp)
  }

  // -----------------------------------------------------------------------
  // Reads.
  // -----------------------------------------------------------------------

  names(): string[] {
    const out: string[] = []
    for (const id of this.dag.nodeIds()) {
      const node = this.dag.getNode(id)
      if (node && node.kind === 'parameter') out.push(paramNameFromNodeId(id) ?? id)
    }
    return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  }

  has(name: string): boolean {
    return this.dag.getNode(paramNodeId(name))?.kind === 'parameter'
  }

  valueOf(name: string): number | undefined {
    return this.paramPayload(name)?.value
  }

  expressionOf(name: string): string | undefined {
    return this.paramPayload(name)?.expression
  }

  statusOf(name: string): FeatureStatus {
    return this.scheduler.statusOf(paramNodeId(name))
  }

  /** This parameter's OWN diagnostics (its evaluation failure, if any, as a
   *  typed ParamDiag) OR a scheduler-originated diagnostic on it as a
   *  dependent (e.g. UPSTREAM_FAILED), passed through unchanged. */
  diagnosticsOf(name: string): ParameterDiagnostic[] {
    return this.scheduler.diagnosticsOf(paramNodeId(name)).map((d) => paramDiagFromDiag(d as Diag) ?? d)
  }

  canUndo(): boolean {
    return this.touchedPast.length > 0
  }

  canRedo(): boolean {
    return this.touchedFuture.length > 0
  }

  private paramPayload(name: string): ParameterPayload | undefined {
    const node = this.dag.getNode(paramNodeId(name))
    if (!node || node.kind !== 'parameter') return undefined
    return asParameterPayload(node.payload)
  }

  // -----------------------------------------------------------------------
  // Mutation.
  // -----------------------------------------------------------------------

  /**
   * Creates (if `name` is new) or edits (if it exists) a parameter's
   * expression, commits it through the command layer, and drives a fresh
   * regeneration of exactly its downstream closure through the shared
   * RegenScheduler (ruling 3a).
   *
   * ok:false set (edit-time; nothing is mutated, the table is left exactly
   * as it was): PARAM_SYNTAX_ERROR (invalid name, malformed expression, or a
   * function called with the wrong number of arguments), PARAM_UNKNOWN_FUNCTION
   * (an identifier called like a function, e.g. `foo(1)`, that isn't one of
   * the built-in functions -- params/parser.ts's FUNCTION_NAMES),
   * PARAM_SELF_REFERENCE, PARAM_CYCLE.
   *
   * ok:true set (the expression COMMITS even though it may go on to fail):
   * a dangling/forward parameter reference, a division by zero, or a
   * function domain error (sqrt of a negative number, asin/acos outside
   * [-1, 1], atan2(0, 0), or any overflow to Infinity/NaN) are all EVAL-TIME
   * diagnostics -- the edit still returns ok:true (this is deliberately a
   * legal CAD workflow: forward references and batch reordering stay legal),
   * and the failure surfaces afterward through statusOf(name)/diagnosticsOf(name)
   * as a typed PARAM_UNKNOWN_REFERENCE, PARAM_DIVISION_BY_ZERO, or
   * PARAM_MATH_DOMAIN respectively (never thrown, never silently NaN --
   * valueOf(name) always keeps the last-good value). This is the contract
   * SKC-4 is cut against; see the report's publicApiSurface for the full
   * read/mutation surface.
   */
  async setExpression(name: string, source: string): Promise<SetExpressionOutcome> {
    const id = paramNodeId(name)
    if (!NAME_RE.test(name) || RESERVED_NAMES.has(name)) {
      return { ok: false, nodeId: id, diag: invalidNameDiag(name) }
    }

    let parsed: ParsedExpression
    try {
      parsed = parseExpression(source)
    } catch (e) {
      if (e instanceof ParamParseError) return { ok: false, nodeId: id, diag: e.diagnostic }
      throw e
    }
    const { ast, refs } = parsed

    if (refs.includes(name)) {
      return { ok: false, nodeId: id, diag: { code: 'PARAM_SELF_REFERENCE', severity: 'error', params: { name } } }
    }

    const existed = this.dag.has(id)
    const priorValue = existed ? this.paramPayload(name)?.value : undefined
    const payload: ParameterPayload = { name, expression: source, ast, value: priorValue ?? 0 }
    const consumes = refs.map(paramNodeId)

    const cmd: Command = existed
      ? new SetParameterExpressionCommand(id, payload, consumes)
      : new InsertNodeCommand({ id, kind: 'parameter', consumes, payload })

    try {
      this.history.execute(cmd)
    } catch (e) {
      if (e instanceof DagCycleError) {
        return {
          ok: false,
          nodeId: id,
          diag: { code: 'PARAM_CYCLE', severity: 'error', params: { name, ...e.diagnostic.params } },
        }
      }
      throw e
    }

    this.recordTouch(id)
    this.scheduler.markDirty(id)
    const pass = await this.scheduler.run(this.executor)
    return { ok: true, nodeId: id, pass }
  }

  /** Undoes the last committed parameter edit (table value + everything
   *  downstream), or returns undefined if there is nothing to undo. */
  async undo(): Promise<RegenPassResult | undefined> {
    if (!this.history.canUndo()) return undefined
    const id = this.touchedPast.pop() as string
    // Capture WHO directly consumes `id` (other parameters via an ordinary
    // 'ref' in their expression, or features/sketches/etc. via a plain DAG
    // edge) BEFORE the undo runs -- if this undo removes the node entirely
    // (the genesis InsertNodeCommand), `id` is gone afterward and
    // scheduler.markDirty(id) would throw (it requires an existing node), so
    // there would be no other way to find them (Architect ruling R1.1).
    const directConsumers = this.directConsumersOf(id)
    this.history.undo()
    this.touchedFuture.push(id)
    if (!this.dag.has(id)) {
      // Genesis undo: the parameter node is gone. Drive its FORMER direct
      // consumers through the shared scheduler instead of returning early --
      // markDirty on each cascades to ITS OWN downstream closure exactly as
      // a live edit already does. What happens next depends on the
      // consumer's own kind (see scheduler.ts's firstMissingUpstream/pass()):
      // another PARAMETER re-evaluates its own expression and surfaces its
      // own typed PARAM_UNKNOWN_REFERENCE (the same eval-time path an
      // always-missing reference already takes); a FEATURE (or any other
      // non-parameter node) degrades via the scheduler's dangling-upstream
      // check, guaranteed BEFORE its kernel op runs -- never silently stays
      // 'ok' on stale geometry.
      if (directConsumers.length === 0) return { executed: [], cancelled: false }
      for (const consumerId of directConsumers) this.scheduler.markDirty(consumerId)
      return this.scheduler.run(this.executor)
    }
    this.scheduler.markDirty(id)
    return this.scheduler.run(this.executor)
  }

  /** Redoes the last undone parameter edit, or returns undefined if there is
   *  nothing to redo. */
  async redo(): Promise<RegenPassResult | undefined> {
    if (!this.history.canRedo()) return undefined
    const id = this.touchedFuture.pop() as string
    this.history.redo()
    this.touchedPast.push(id)
    this.scheduler.markDirty(id)
    return this.scheduler.run(this.executor)
  }

  /** Node ids whose OWN `consumes` array directly includes `id` right now --
   *  computed from FeatureDag's existing public API (nodeIds/getNode), no
   *  scheduler/dag change needed. Used by undo() (R1.1) to find who to
   *  re-drive when `id`'s node is about to be removed entirely. */
  private directConsumersOf(id: string): string[] {
    const out: string[] = []
    for (const nid of this.dag.nodeIds()) {
      const node = this.dag.getNode(nid)
      if (node && node.consumes.includes(id)) out.push(nid)
    }
    return out
  }

  private recordTouch(id: string): void {
    this.touchedPast.push(id)
    if (this.touchedPast.length > HISTORY_CAP) this.touchedPast.shift()
    this.touchedFuture.length = 0
  }
}
