// The one live modeling session per model item (WO-2978, WO-2951 Order A).
//
// Before this order the live model -- the FeatureDag, its element map, the
// RegenScheduler, the CommandHistory, the ParameterTable and the touched-id
// stacks kept in lockstep with the history -- were six React refs inside
// SolidsWorkbenchPage, so nothing could reach them without going through the
// component. A ModelSession holds them as ONE object. The page builds one at
// mount and works through it; documentHolder.ts keeps it reachable by model
// item id (getModelSession) for as long as that mount holds the document, so
// a later headless caller (WO-2951 Order B: the modeling command registry)
// works on the very objects the screen does.
//
// Lifetime = one document generation's mount, exactly like the refs it
// replaces: a project load still remounts the page (documentHolder's
// generation key) and so still builds a fresh session from the new seed.
// Keeping it alive across remounts would carry undo history across a load,
// which is an operator-visible change this order must not make.
//
// revision() is CommandHistory's own counter (commands.ts, review D1), not a
// count kept here: the page still calls `history` directly at many sites
// (dialog Apply, coalesced follow-ups, Cancel restores), and every one of
// them must move the revision.
//
// Undo/redo come in two layers so the page and a headless caller share ONE
// code path for the history bookkeeping: undoStep()/redoStep() pop the
// history and the touched-id stacks in lockstep and say which roots need a
// rebuild; undo()/redo() add the plain scheduler rebuild for a caller with no
// viewport. The page calls the Step forms and rebuilds through its own
// fullResync (viewport, sketch session, console line), unchanged.
//
// G2 (WO-2951 finding G2; the operator's Mission Control card 2026-10-20 2:10 PM CT:
// "Yes - put parameter edits on Undo"): the ParameterTable commits on THIS
// session's history and pushes its touched ids onto THIS session's stacks, so
// a Parameters-table edit is one Undo/Redo step on the same stack as every
// other Model step, in order. Before this the table kept a private history
// nothing in the product ever undid.
//
// WO-3202 (WO-3170 Slice B): the session also owns the memo of feature
// recognition results for its bodies (partFeatureBinding.ts), so Resize Hole
// and the picked-wall Bore read ONE result per committed body revision. The
// page lends the session its committed body handles and kernel
// (setLiveBodySource); the memo dies with the session, and only results that
// are still true of the document at unmount are handed to the holder
// (committedFeatureResults, documentHolder.registerLiveDocument).

import { FeatureResultMemo, kernelSerial, type LiveBodySource, type ModelBodyFeatureResult } from '../lib/geometry/partFeatureBinding'
import { CommandHistory, CompositeCommand, HISTORY_CAP, type Command, type TouchedStack } from './commands'
import type { FeatureDag } from './dag'
import type { ElementMap } from './element-map'
import { ParameterTable } from './params/table'
import { RegenScheduler, type FeatureOp, type RegenPassResult } from './regen'

export interface ModelSessionInit<M extends ElementMap = ElementMap> {
  modelItemId: string
  dag: FeatureDag
  /** The page passes its RecordingElementMap (documentHolder.ts), seeded
   *  from the opened document; the type parameter keeps that type. */
  map: M
  /** The kernel op behind the parameter-aware executor (ParameterTable's own
   *  kernelOp argument). Default: the table's no-op. */
  kernelOp?: FeatureOp
}

/** One labelled model edit: the commands run as ONE history entry. */
export interface ModelEditStep {
  label: string
  commands: Command[]
  /** The node ids this step touches, re-dirtied on its undo/redo. */
  touched: string[]
}

/** What one undo/redo popped, before any rebuild. */
export interface HistoryStep {
  /** The history entry that was undone or redone. */
  command: Command
  /** The roots a rebuild must re-dirty: the step's touched ids that still
   *  exist, and for a touched id an undo removed (a genesis insert), the
   *  nodes that consumed it just before. */
  roots: string[]
}

export interface HistoryStepResult extends HistoryStep {
  pass: RegenPassResult
}

/** What a headless edit just did to the model: the page repaints from it. */
export interface ModelChangeNotice {
  kind: 'execute' | 'undo' | 'redo'
  /** The step's label. */
  label: string
  /** The node ids to re-dirty so a viewport follows the change. */
  roots: string[]
}

/** The page's Undo/Redo guard: a plain sentence when it refuses right now, else null. */
export type HistoryGuard = (direction: 'undo' | 'redo') => string | null

function directConsumersOf(dag: FeatureDag, id: string): string[] {
  const out: string[] = []
  for (const nid of dag.nodeIds()) {
    const node = dag.getNode(nid)
    if (node !== undefined && node.consumes.includes(id)) out.push(nid)
  }
  return out
}

export class ModelSession<M extends ElementMap = ElementMap> {
  readonly modelItemId: string
  readonly dag: FeatureDag
  readonly map: M
  readonly scheduler: RegenScheduler
  /** The ONE model history: the screen's Undo pops it. */
  readonly history: CommandHistory
  readonly params: ParameterTable
  /** Parallel to `history`'s past/future stacks: the node ids each entry
   *  touched (one array per entry; a rollback-marker move touches many). */
  readonly touchedPast: TouchedStack = { current: [] }
  readonly touchedFuture: TouchedStack = { current: [] }

  /** WO-3202: recognition results for this session's bodies, by token. */
  readonly featureResults = new FeatureResultMemo()

  private readonly changeListeners = new Set<(notice: ModelChangeNotice) => void>()
  private historyGuard: HistoryGuard | null = null
  private liveBodies: LiveBodySource | null = null

  constructor(init: ModelSessionInit<M>) {
    this.modelItemId = init.modelItemId
    this.dag = init.dag
    this.map = init.map
    this.scheduler = new RegenScheduler(init.dag, init.map)
    this.history = new CommandHistory(init.dag)
    // G2: the table commits on the model history, in lockstep with its stacks.
    this.params = new ParameterTable(init.dag, this.scheduler, init.kernelOp, {
      history: this.history,
      touchedPast: this.touchedPast,
      touchedFuture: this.touchedFuture,
    })
  }

  /** WO-3000: told when a headless caller (the agent registry) has finished
   *  an edit AND built its result, so a listener's repaint can never run
   *  inside the pass the result reports. The page's own edits call the
   *  history directly and repaint themselves, so they send no notice.
   *  Returns the unsubscribe. */
  subscribe(listener: (notice: ModelChangeNotice) => void): () => void {
    this.changeListeners.add(listener)
    return () => { this.changeListeners.delete(listener) }
  }

  /** WO-3000: the page installs its Undo/Redo guard here so a headless
   *  undo/redo obeys it. Pass null to remove it (the page's unmount). */
  setHistoryGuard(guard: HistoryGuard | null): void {
    this.historyGuard = guard
  }

  /** The guard's refusal sentence for `direction`, or null when allowed. */
  historyRefusal(direction: 'undo' | 'redo'): string | null {
    return this.historyGuard === null ? null : this.historyGuard(direction)
  }

  /** The headless caller says: this edit is done and its result is captured. */
  announce(notice: ModelChangeNotice): void {
    for (const listener of [...this.changeListeners]) {
      try { listener(notice) } catch (err) { console.warn('WO-3000: a model change listener threw', err) }
    }
  }

  /** WO-3202: the page lends its committed body handles and kernel here.
   *  Pass null to withdraw them (the page's unmount). Withdrawing drops
   *  every live result: the handles they name are going away. */
  setLiveBodySource(source: LiveBodySource | null): void {
    this.liveBodies = source
    if (source === null) this.featureResults.retain((token) => token.route !== 'live')
  }

  liveBodySource(): LiveBodySource | null {
    return this.liveBodies
  }

  /** WO-3202: completed live results still true of the document as it
   *  stands right now -- same revision, the handle each names is still the
   *  committed one, and no rebuild pending (a dirty or running node means a
   *  handle about to be replaced). The holder carries only these across an
   *  unmount, so a Bore read after the Model tab closes needs no replay. */
  committedFeatureResults(): ModelBodyFeatureResult[] {
    const source = this.liveBodies
    if (source === null) return []
    if (this.scheduler.dirtyIds().length > 0 || this.scheduler.hasRunning()) return []
    const kernel = source.kernel()
    if (kernel === null) return []
    const revision = this.revision()
    const kernelId = kernelSerial(kernel)
    return this.featureResults.completedResults().filter((result) =>
      result.token.route === 'live' &&
      result.token.revision === revision &&
      result.token.kernel === kernelId &&
      source.handleOf(result.token.bodyId) === result.token.handle,
    )
  }

  /** The model's edit counter: CommandHistory's own revision. */
  revision(): number {
    return this.history.revision
  }

  /** Runs `step` as one history entry (a CompositeCommand when it has more
   *  than one command, which undoes the members already run if a later one
   *  throws -- so a throw leaves no change and no entry), keeps the touched
   *  stacks in lockstep, and rebuilds the touched closure. */
  async execute(step: ModelEditStep): Promise<RegenPassResult> {
    if (step.commands.length === 0) throw new Error('ModelSession.execute: a step needs at least one command.')
    const command = step.commands.length === 1 ? step.commands[0] : new CompositeCommand(step.commands, step.label)
    this.history.execute(command)
    this.touchedPast.current.push([...step.touched])
    if (this.touchedPast.current.length > HISTORY_CAP) this.touchedPast.current.shift()
    this.touchedFuture.current = []
    for (const id of step.touched) if (this.dag.has(id)) this.scheduler.markDirty(id)
    return this.scheduler.run(this.params.executor)
  }

  /** Undoes the last history entry and moves its touched ids to the redo
   *  side. No rebuild. Undefined when there is nothing to undo. */
  undoStep(): HistoryStep | undefined {
    const command = this.history.lastAppliedCommand()
    if (command === undefined) return undefined
    const ids = this.touchedPast.current.pop()
    // Captured BEFORE the undo: a genesis undo removes the node, and its
    // former consumers are what must rebuild (params/table.ts's undo()).
    const priorConsumers = new Map((ids ?? []).map((id) => [id, directConsumersOf(this.dag, id)] as const))
    if (!this.history.undo()) return undefined
    if (ids !== undefined) this.touchedFuture.current.push(ids)
    const roots = (ids ?? []).flatMap((id) => (this.dag.has(id) ? [id] : (priorConsumers.get(id) ?? [])))
    return { command, roots }
  }

  /** Redoes the last undone entry and moves its touched ids back. No
   *  rebuild. Undefined when there is nothing to redo. */
  redoStep(): HistoryStep | undefined {
    const ids = this.touchedFuture.current.pop()
    if (!this.history.redo()) return undefined
    if (ids !== undefined) this.touchedPast.current.push(ids)
    return { command: this.history.lastAppliedCommand() as Command, roots: ids ?? [] }
  }

  /** undoStep() plus the scheduler rebuild of its roots (no viewport). */
  async undo(): Promise<HistoryStepResult | undefined> {
    const step = this.undoStep()
    return step === undefined ? undefined : { ...step, pass: await this.rebuild(step.roots) }
  }

  /** redoStep() plus the scheduler rebuild of its roots (no viewport). */
  async redo(): Promise<HistoryStepResult | undefined> {
    const step = this.redoStep()
    return step === undefined ? undefined : { ...step, pass: await this.rebuild(step.roots) }
  }

  private rebuild(roots: readonly string[]): Promise<RegenPassResult> {
    for (const id of roots) if (this.dag.has(id)) this.scheduler.markDirty(id)
    return this.scheduler.run(this.params.executor)
  }
}

export function createModelSession<M extends ElementMap>(init: ModelSessionInit<M>): ModelSession<M> {
  return new ModelSession(init)
}
