// Command layer + replay-based undo/redo (DOC lane, WO DOC-2, WP2.2).
//
// Implements docs/3d-modeling-plan.md §3.4 "Undo/redo": every mutation is a
// Command {do, undo, serialize}. Undo/redo is REPLAY through the DAG, never a
// geometry snapshot -- do()/undo() mutate FeatureDag's plain structural state
// directly, so a command's serialize() output is always plain JSON (ids,
// kinds, consumes arrays, refs, opaque payload data). No command here ever
// stores or references a BodyHandle, TessBuffers, or ArrayBuffer -- that is
// the whole point of replay-based undo (plan: "keeps memory flat").
//
// History is capped at N=200 commands (plan §3.4): once the cap is exceeded
// the OLDEST applied command is permanently forgotten (it can no longer be
// undone), exactly like every mainstream CAD undo stack.

import { markerInsertIndex, type DagNodeInput, type DagNodeSnapshot, type FeatureDag, type RollbackMarker } from './dag'
import type { TreeFolderStore } from './folders'
import { BODY_IDENTITY_PAYLOAD_CARRIERS } from './persist/versioning'

export interface Command {
  readonly label: string
  do(dag: FeatureDag): void
  undo(dag: FeatureDag): void
  /** Plain-JSON description of this command's own data -- never geometry. */
  serialize(): unknown
}

/** Inserts a brand-new node. Undo removes it (mirrors FeatureDag.insertNode/removeNode). */
export class InsertNodeCommand implements Command {
  readonly label = 'insertNode'
  private readonly input: DagNodeInput
  constructor(input: DagNodeInput) {
    this.input = input
  }

  do(dag: FeatureDag): void {
    dag.insertNode(this.input)
  }

  undo(dag: FeatureDag): void {
    dag.removeNode(this.input.id)
  }

  serialize(): unknown {
    return { type: 'insertNode', input: this.input }
  }
}

/**
 * Removes an existing node (a feature-tree delete). Undo restores its exact
 * prior snapshot AT ITS ORIGINAL featureOrder() POSITION (WO UI-12-R1):
 * `removedIndex` is captured via featureOrder().indexOf(id) immediately
 * before do()'s own removeNode call, so undo's restoreNode(snapshot,
 * removedIndex) splices the node back into the exact slot it vacated rather
 * than appending it to the end (FeatureDag.restoreNode's own pre-R1
 * default) -- order is regen-meaningful in a parametric tree, so an
 * append-on-restore would silently change which upstream nodes a downstream
 * consumer's topoOrder position sits relative to.
 */
export class RemoveNodeCommand implements Command {
  readonly label = 'removeNode'
  private removed: DagNodeSnapshot | undefined
  private removedIndex: number | undefined
  private readonly id: string

  constructor(id: string) {
    this.id = id
  }

  do(dag: FeatureDag): void {
    this.removedIndex = dag.featureOrder().indexOf(this.id)
    this.removed = dag.removeNode(this.id)
  }

  undo(dag: FeatureDag): void {
    if (!this.removed || this.removedIndex === undefined) {
      throw new Error(`RemoveNodeCommand.undo: '${this.id}' was never removed (do() has not run yet).`)
    }
    dag.restoreNode(this.removed, this.removedIndex)
  }

  serialize(): unknown {
    return { type: 'removeNode', id: this.id, removed: this.removed }
  }
}

/**
 * Rewires which upstream nodes a node consumes -- the "reorder" mutation
 * (e.g. moving a feature to a different point in the dependency graph, which
 * changes its position in the derived topological order/timeline). Undo
 * restores the exact prior consumes list.
 */
export class SetConsumesCommand implements Command {
  readonly label = 'setConsumes'
  private prior: string[] | undefined
  private readonly id: string
  private readonly consumes: string[]

  constructor(id: string, consumes: string[]) {
    this.id = id
    this.consumes = consumes
  }

  do(dag: FeatureDag): void {
    this.prior = dag.setConsumes(this.id, this.consumes)
  }

  undo(dag: FeatureDag): void {
    if (this.prior === undefined) {
      throw new Error(`SetConsumesCommand.undo: '${this.id}' was never set (do() has not run yet).`)
    }
    dag.setConsumes(this.id, this.prior)
  }

  serialize(): unknown {
    return { type: 'setConsumes', id: this.id, consumes: this.consumes }
  }
}

/**
 * WO UI-6 (BK-39): toggles a node's OWN suppress flag ("root" suppression)
 * -- an ordinary undo/redo-safe DAG mutation, the same prior-return pattern
 * SetConsumesCommand uses. Cascade suppression (a downstream consumer
 * inheriting a suppressed upstream node's state) is NEVER stored anywhere,
 * including here -- FeatureDag.isEffectivelySuppressed derives it live from
 * the consumes graph on every read, so undoing this command automatically
 * un-cascades every dependent too, with no separate closure bookkeeping.
 */
export class SetSuppressedCommand implements Command {
  readonly label = 'setSuppressed'
  private prior: boolean | undefined
  private readonly id: string
  private readonly suppressed: boolean

  constructor(id: string, suppressed: boolean) {
    this.id = id
    this.suppressed = suppressed
  }

  do(dag: FeatureDag): void {
    this.prior = dag.setSuppressed(this.id, this.suppressed)
  }

  undo(dag: FeatureDag): void {
    if (this.prior === undefined) {
      throw new Error(`SetSuppressedCommand.undo: '${this.id}' was never set (do() has not run yet).`)
    }
    dag.setSuppressed(this.id, this.prior)
  }

  serialize(): unknown {
    return { type: 'setSuppressed', id: this.id, suppressed: this.suppressed }
  }
}

/**
 * WO UI-53: undoable persisted sketch visibility. Hidden is display-only,
 * so this command stores no cascade closure and performs no regeneration;
 * the workbench resyncs the outline surface with an empty dirty-root list.
 */
export class SetHiddenCommand implements Command {
  readonly label = 'setHidden'
  private prior: boolean | undefined
  private readonly id: string
  private readonly hidden: boolean

  constructor(id: string, hidden: boolean) {
    this.id = id
    this.hidden = hidden
  }

  do(dag: FeatureDag): void {
    this.prior = dag.setHidden(this.id, this.hidden)
  }

  undo(dag: FeatureDag): void {
    if (this.prior === undefined) {
      throw new Error(`SetHiddenCommand.undo: '${this.id}' was never set (do() has not run yet).`)
    }
    dag.setHidden(this.id, this.prior)
  }

  serialize(): unknown {
    return { type: 'setHidden', id: this.id, hidden: this.hidden }
  }
}

/**
 * WO UI-7 (BK-40): moves the rollback marker -- an ordinary undo/redo-safe
 * DAG mutation, the same prior-return pattern SetSuppressedCommand uses.
 * Which nodes flip rolled-back status is NEVER stored anywhere, including
 * here -- FeatureDag.isRolledBack derives it live from featureOrder() on
 * every read, so undoing this command automatically restores/re-suppresses
 * every affected node too, with no separate closure bookkeeping (mirrors
 * SetSuppressedCommand's own comment on cascade state).
 */
export class SetRollbackMarkerCommand implements Command {
  readonly label = 'setRollbackMarker'
  private prior: RollbackMarker | undefined
  private readonly marker: RollbackMarker

  constructor(marker: RollbackMarker) {
    this.marker = marker
  }

  do(dag: FeatureDag): void {
    this.prior = dag.setRollbackMarker(this.marker)
  }

  undo(dag: FeatureDag): void {
    if (this.prior === undefined) {
      throw new Error('SetRollbackMarkerCommand.undo: marker was never set (do() has not run yet).')
    }
    dag.setRollbackMarker(this.prior)
  }

  serialize(): unknown {
    return { type: 'setRollbackMarker', marker: this.marker }
  }
}

/**
 * WO UI-9 (BK-41): moves a feature to a new position in featureOrder() (the
 * drag-reorder mutation) -- an ordinary undo/redo-safe DAG mutation, the same
 * prior-return pattern SetRollbackMarkerCommand uses. do() calls
 * FeatureDag.reorderNode, which itself throws ReorderBlockedError (mutating
 * nothing) if the target position would violate the dependency guard -- this
 * command never re-checks that itself, so a refused reorder never reaches
 * CommandHistory.execute's push (do() throwing before returning means the
 * command is never added to the undo stack). Which nodes flip rolled-back
 * status as a SIDE EFFECT of the move is never stored here, same "derived
 * live" discipline SetRollbackMarkerCommand's own comment describes -- the
 * caller (SolidsWorkbenchPage) diffs dag.rolledBackIds() before/after to
 * decide what to re-dirty, exactly as it already does for a marker move.
 */
export class ReorderNodeCommand implements Command {
  readonly label = 'reorderNode'
  private prior: number | undefined
  private readonly id: string
  private readonly targetIndex: number

  constructor(id: string, targetIndex: number) {
    this.id = id
    this.targetIndex = targetIndex
  }

  do(dag: FeatureDag): void {
    this.prior = dag.reorderNode(this.id, this.targetIndex)
  }

  undo(dag: FeatureDag): void {
    if (this.prior === undefined) {
      throw new Error(`ReorderNodeCommand.undo: '${this.id}' was never reordered (do() has not run yet).`)
    }
    dag.reorderNode(this.id, this.prior)
  }

  serialize(): unknown {
    return { type: 'reorderNode', id: this.id, targetIndex: this.targetIndex }
  }
}

/**
 * WO-2868 (sweep H2): a feature inserted at the marker that edits a body in
 * place (a Push/Pull, Fillet, Hole... names it `ownerId`; a Boolean or a
 * joining Extrude names it `targetFeatureId`) becomes that body's new tip. The
 * rolled-back features below it that worked on the same body - a Fillet whose
 * owner was the box - must then work on the new tip, or rolling forward finds
 * the box already consumed and fails "owner has no live body". Each such
 * consumer has its `consumes` edge and every body carrier
 * (BODY_IDENTITY_PAYLOAD_CARRIERS, the same census the v3->v4 push/pull
 * promotion rewires) that named the body moved onto the new feature. Only
 * features after the insert point are touched; a consumer naming the body by
 * no carrier (a face sketch) keeps its edge. Returns the prior state for undo.
 */
function rewireRolledBackConsumers(
  dag: FeatureDag,
  input: DagNodeInput,
): Array<{ id: string; consumes: string[]; payload: Record<string, unknown> }> {
  const payload = input.payload ?? {}
  const edited = typeof payload.ownerId === 'string' ? payload.ownerId : typeof payload.targetFeatureId === 'string' ? payload.targetFeatureId : undefined
  if (edited === undefined || !(input.consumes ?? []).includes(edited)) return []
  const order = dag.featureOrder()
  const after = order.slice(order.indexOf(input.id) + 1)
  const prior: Array<{ id: string; consumes: string[]; payload: Record<string, unknown> }> = []
  for (const id of after) {
    const node = dag.getNode(id)
    if (node === undefined || !node.consumes.includes(edited)) continue
    const carriers = BODY_IDENTITY_PAYLOAD_CARRIERS.filter((carrier) => node.payload[carrier] === edited)
    if (carriers.length === 0) continue
    const nextPayload: Record<string, unknown> = { ...node.payload }
    for (const carrier of carriers) nextPayload[carrier] = input.id
    const consumes = node.consumes.map((c) => (c === edited ? input.id : c))
    prior.push({ id, consumes: dag.setConsumes(id, [...new Set(consumes)]), payload: dag.setPayload(id, nextPayload) })
  }
  return prior
}

/**
 * WO UI-7 (BK-40 mission #3): inserts a brand-new node AT the rollback
 * marker's position in featureOrder() (not appended to the end), then moves
 * the marker to sit immediately after it -- the new feature becomes the
 * active tip; every feature that was already rolled back stays rolled back
 * below it. FeatureDag.insertNode itself refuses (plain Error) if `input`
 * consumes anything currently rolled back, so a below-marker producer is
 * never silently accepted. do()'s two effects (insert, then move marker)
 * undo in reverse order, same convention as every other multi-step command
 * in this file.
 */
export class InsertAtMarkerCommand implements Command {
  readonly label = 'insertAtMarker'
  private readonly input: DagNodeInput
  private priorMarker: RollbackMarker | undefined
  private rewired: Array<{ id: string; consumes: string[]; payload: Record<string, unknown> }> = []

  constructor(input: DagNodeInput) {
    this.input = input
  }

  do(dag: FeatureDag): void {
    const index = markerInsertIndex(dag.featureOrder(), dag.getRollbackMarker())
    dag.insertNode(this.input, index)
    this.rewired = rewireRolledBackConsumers(dag, this.input)
    this.priorMarker = dag.setRollbackMarker({ kind: 'after', nodeId: this.input.id })
  }

  undo(dag: FeatureDag): void {
    if (this.priorMarker === undefined) {
      throw new Error(`InsertAtMarkerCommand.undo: '${this.input.id}' was never inserted (do() has not run yet).`)
    }
    dag.setRollbackMarker(this.priorMarker)
    for (const prior of [...this.rewired].reverse()) {
      dag.setPayload(prior.id, prior.payload)
      dag.setConsumes(prior.id, prior.consumes)
    }
    this.rewired = []
    dag.removeNode(this.input.id)
  }

  serialize(): unknown {
    return { type: 'insertAtMarker', input: this.input }
  }
}

/**
 * WO UI-8 (BK-42 mission #2): bundles multiple Commands into ONE undo/redo
 * step. do() runs sub-commands in order; undo() runs them in REVERSE order,
 * the standard composite-undo convention -- mirrors InsertAtMarkerCommand's
 * own two-step do/reverse-undo shape, just generalized to N steps. Not
 * folder-specific: any future caller needing "these N mutations are one undo
 * step" can reuse this directly.
 */
export class CompositeCommand implements Command {
  readonly label: string
  private readonly commands: Command[]

  constructor(commands: Command[], label = 'composite') {
    this.commands = commands
    this.label = label
  }

  /**
   * WO SKC-15C (audit major #3): ATOMIC. If any member's do() throws, every member that ALREADY ran
   * is rolled back (in reverse) before the throw is re-raised, so the document is left exactly as it
   * was before do() was called -- all members applied, or none.
   *
   * THE DEFECT THIS FIXES. A composite `[Remove F1, Remove datum:XY]` threw the named GenesisNodeError
   * on the second member but left F1 deleted, and CommandHistory.execute -- which pushes onto the undo
   * stack only AFTER do() returns -- recorded no undo entry for the half that DID apply. The result
   * was a silent, un-undoable partial mutation. It was reachable from the real folder-suppress path
   * (a folder holding a feature and a genesis id) before the folder JOIN point learned to refuse
   * genesis ids (folders.ts).
   *
   * WHY ROLL BACK RATHER THAN PRE-FLIGHT. The alternative the audit offered is "pre-flight the whole
   * composite" -- a `canExecute` probe per member. `Command` has no such method, and adding a truthful
   * one to every command type (and keeping it in sync with each do()) is a second, parallel copy of
   * the mutation logic that would drift. Every Command ALREADY has an `undo()` that inverts its do();
   * rolling back reuses that single contract and is correct for ANY future member without a
   * per-command predicate. The throwing member itself needs no rollback: a do() that throws is
   * required (like every mutator in dag.ts -- setSuppressed/removeNode refuse genesis BEFORE
   * mutating) to throw before it changes anything, so only the members that returned need inverting.
   *
   * CommandHistory is now correct AS-IS: it pushes only on a clean do(), and a clean do() is now
   * atomic, so "no undo entry when do() throws" pairs with "nothing was mutated".
   */
  do(dag: FeatureDag): void {
    const applied: Command[] = []
    try {
      for (const cmd of this.commands) {
        cmd.do(dag)
        applied.push(cmd)
      }
    } catch (err) {
      for (let i = applied.length - 1; i >= 0; i--) applied[i].undo(dag)
      throw err
    }
  }

  undo(dag: FeatureDag): void {
    for (let i = this.commands.length - 1; i >= 0; i--) this.commands[i].undo(dag)
  }

  serialize(): unknown {
    return { type: 'composite', commands: this.commands.map((c) => c.serialize()) }
  }
}

/**
 * WO UI-8 (mission #2): true if `folderId` has at least one member and every
 * member's OWN suppress flag (root suppression, not cascade) is set -- the
 * same "every child checked" tri-state a folder-suppress toggle button reads
 * to decide its own pressed state. An empty folder is never reported
 * suppressed (nothing to suppress).
 */
export function isFolderSuppressed(dag: FeatureDag, folders: TreeFolderStore, folderId: string): boolean {
  const members = folders.membersOf(folderId)
  if (members.length === 0) return false
  return members.every((id) => dag.getNode(id)?.suppressed === true)
}

/**
 * WO UI-8 (mission #2): "Folder suppress = suppress every member (rides the
 * UI-6 cascade machinery; folder unsuppress restores per the UI-6 rules)" --
 * this is the command surface for that toggle. Flips EVERY member's root
 * suppress flag to the opposite of the folder's current tri-state
 * (isFolderSuppressed): not-all-suppressed -> suppress every member;
 * all-suppressed -> unsuppress every member. One CompositeCommand, one undo
 * step. Cascade suppression of anything downstream of a member is NEVER
 * touched directly here -- exactly like a single SetSuppressedCommand,
 * FeatureDag.isEffectivelySuppressed derives that live on every read.
 */
export function folderSuppressCommand(dag: FeatureDag, folders: TreeFolderStore, folderId: string): CompositeCommand {
  const target = !isFolderSuppressed(dag, folders, folderId)
  const members = folders.membersOf(folderId)
  return new CompositeCommand(
    members.map((id) => new SetSuppressedCommand(id, target)),
    'folderSuppress',
  )
}

/** Undo/redo history cap (plan §3.4: "Cap history at N=200 commands"). */
export const HISTORY_CAP = 200

/** WO-2978: one entry of node ids per history step, kept in lockstep with a
 *  CommandHistory's past (or future) stack by whoever executes on it -- the
 *  ids an undo/redo of that step must re-dirty. React's MutableRefObject
 *  shape, so the workbench page's `touchedPastRef.current = ...` sites work
 *  on a ModelSession's stacks unchanged. */
export interface TouchedStack {
  current: string[][]
}

/** In-memory checkpoint for a transaction that must be cancelled without
 * replaying a chain of user-visible undo operations. */
export interface CommandHistoryCheckpoint {
  past: Command[]
  future: Command[]
}

/**
 * Replay-based undo/redo stack over one FeatureDag. `execute` applies a new
 * command and clears any redo tail (standard undo-stack semantics: a fresh
 * action after undoing invalidates the redone future). `undo`/`redo` replay
 * the command's own do()/undo() -- there is no geometry snapshot anywhere in
 * this class, only Command instances and the plain data they hold.
 */
export class CommandHistory {
  private readonly past: Command[] = []
  private readonly future: Command[] = []
  private readonly dag: FeatureDag
  private readonly cap: number
  private rev = 0

  constructor(dag: FeatureDag, cap: number = HISTORY_CAP) {
    this.dag = dag
    this.cap = cap
  }

  /**
   * WO-2978 (WO-2951 review D1): the history's own edit counter. +1 on every
   * mutation that changes the document or the undo stacks -- execute, undo,
   * redo, coalesceIntoLast and restoreCheckpoint -- and never on a call that
   * changed nothing (an empty undo/redo, a refused coalesce, a do() that
   * threw). It lives HERE rather than in ModelSession because the workbench
   * page calls this class directly at many sites (dialog Apply, coalesced
   * follow-ups, Cancel restores); a counter kept one layer up would miss them.
   * Session-only, like the stacks: never serialized.
   */
  get revision(): number {
    return this.rev
  }

  execute(cmd: Command): void {
    cmd.do(this.dag)
    this.past.push(cmd)
    if (this.past.length > this.cap) this.past.shift()
    this.future.length = 0
    this.rev++
  }

  /**
   * Returns the exact command object currently at the undo tail. Callers may
   * retain this identity while an asynchronous validation/replay runs, then
   * use coalesceIntoLast() to add a follow-up mutation to the SAME undo step
   * only if no intervening undo/redo/execute changed the tail.
   */
  lastAppliedCommand(): Command | undefined {
    return this.past[this.past.length - 1]
  }

  /**
   * Applies `followUp` now and folds it into the current undo tail. The
   * expected-command identity makes this safe across asynchronous work: when
   * the user has changed history in the meantime, nothing is mutated and the
   * caller can conservatively skip the follow-up.
   *
   * The prior command has already run, so only followUp.do() runs here. The
   * resulting CompositeCommand subsequently undoes both in reverse order and
   * redoes both in forward order as one ordinary history entry.
   */
  coalesceIntoLast(expected: Command, followUp: Command): boolean {
    const lastIndex = this.past.length - 1
    if (lastIndex < 0 || this.past[lastIndex] !== expected) return false
    followUp.do(this.dag)
    this.past[lastIndex] = new CompositeCommand([expected, followUp], expected.label)
    this.future.length = 0
    this.rev++
    return true
  }

  canUndo(): boolean {
    return this.past.length > 0
  }

  canRedo(): boolean {
    return this.future.length > 0
  }

  undo(): boolean {
    const cmd = this.past.pop()
    if (!cmd) return false
    cmd.undo(this.dag)
    this.future.push(cmd)
    this.rev++
    return true
  }

  redo(): boolean {
    const cmd = this.future.pop()
    if (!cmd) return false
    cmd.do(this.dag)
    this.past.push(cmd)
    if (this.past.length > this.cap) this.past.shift()
    this.rev++
    return true
  }

  /** Number of currently-undoable commands (bounded by the cap). */
  size(): number {
    return this.past.length
  }

  checkpoint(): CommandHistoryCheckpoint {
    return { past: [...this.past], future: [...this.future] }
  }

  restoreCheckpoint(checkpoint: CommandHistoryCheckpoint): void {
    this.past.splice(0, this.past.length, ...checkpoint.past)
    this.future.splice(0, this.future.length, ...checkpoint.future)
    this.rev++
  }

  /** Plain-JSON serialization of the applied (undoable) command history -- geometry never appears here (AC #5). */
  serialize(): unknown[] {
    return this.past.map((c) => c.serialize())
  }
}
