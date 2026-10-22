// The agent's modeling command registry and its one runner
// (WO-2993, WO-2951 Order B; docs/design/WO-2951-modeling-mcp.md "The one runner").
//
// Each command is plain data (id, effect, input/output schema) plus a pure
// `prepare` that reads the live ModelSession and returns the commands to run, or
// a refusal in the app's own words. ONE function, runModelCommand(), runs every
// command: allow-list, schema, session, replay, revision, enabled, prepare, commit
// as ONE labelled step on the same history the Model page's Undo pops, rebuild,
// result. A command never receives the dag, history or scheduler (it gets the
// ModelSession's public API, like the page does), never writes store state, and
// imports nothing the ADR-0055 ban lists (eslint.config.mjs, registryBoundary test).
//
// What this file decides where WO-2978 left a question open: with no Model page
// mounted there is no ModelSession (documentHolder.getModelSession is undefined).
// The runner then refuses in one plain sentence that says what to do (LIENCAM.md
// rule 11), throws nothing, and creates no hidden session.
//
// Results are deterministic: no timestamps, no random ids, ids derived from the
// document (`param:<name>`). They are detached JSON copies, deep-frozen, so a
// caller mutating one cannot reach the model.

import { getModelSession, markDocumentDirty, LEGACY_MODEL_ITEM_ID } from '../../doc/documentHolder'
import type { Command } from '../../doc/commands'
import type { ModelChangeNotice, ModelSession } from '../../doc/modelSession'
import { paramNameFromNodeId } from '../../doc/params/node-id'
import { firstSchemaProblem, type JsonSchema } from './schema'

export type RefusalCode =
  | 'unknown-command'
  | 'invalid-arguments'
  | 'refused'
  | 'missing-target'
  | 'stale-revision'
  | 'no-model-open'

export interface Refusal {
  ok: false
  code: RefusalCode
  /** One plain sentence: what is wrong and what to do (LIENCAM.md rule 11). */
  message: string
  /** JSON path of the first bad argument, for invalid-arguments. */
  path?: string
}

export interface ChangedIds {
  created: string[]
  edited: string[]
  removed: string[]
}

export interface ModelDiagnostic {
  nodeId: string
  code: string
  message: string
}

export interface ModelCommandSuccess<O> {
  ok: true
  command: string
  /** The label of the one history step this call added (the Undo button's step),
   *  or null for a read and for an undo/redo with nothing to do. */
  step: string | null
  /** The model's edit counter after this call. */
  revision: number
  changed: ChangedIds
  /** Rebuild status of every node the call touched or rebuilt. */
  status: Record<string, string>
  diagnostics: ModelDiagnostic[]
  value: O
}

export type ModelCommandResult<O = unknown> = ModelCommandSuccess<O> | Refusal

export interface RunOptions {
  /** A retry of the same call returns the first result and changes nothing. */
  requestId?: string
  /** Opt-in guard: refuse when the model has moved on since the agent last looked. */
  expectRevision?: number
  /** Which model item. Default: the legacy single-model item. */
  modelItemId?: string
}

/** One edit, ready to commit as a single labelled history step. */
export interface Prepared<O> {
  label: string
  commands: Command[]
  touched: string[]
  changed: ChangedIds
  /** Reads the value for the result AFTER the commit and rebuild. */
  finish: (session: ModelSession) => O
}

interface SpecBase {
  id: `model.${string}`
  input: JsonSchema
  output: JsonSchema
}

/** Changes the model: one call, one history step. */
export interface ModelEditSpec<I = never, O = unknown> extends SpecBase {
  kind: 'edit'
  effect: 'edit'
  /** Only what the screen itself refuses for this command; null otherwise. */
  enabled: (session: ModelSession, input: I) => Refusal | null
  /** Pure: reads only, builds the commands -- or refuses in the screen's words. */
  prepare: (session: ModelSession, input: I) => Prepared<O> | Refusal
}

/** Reads the model; changes nothing and adds no step. */
export interface ModelReadSpec<I = never, O = unknown> extends SpecBase {
  kind: 'read'
  effect: 'read'
  read: (session: ModelSession, input: I) => O | Refusal
}

/** Undo / redo: exactly what the Undo / Redo button does on the shared history. */
export interface ModelHistorySpec extends SpecBase {
  kind: 'history'
  effect: 'edit'
  direction: 'undo' | 'redo'
  /** When another history owns the Undo / Redo button right now (an open Form session), steps that
   *  one exactly as the button does and returns the label of what it took back, or null when it had
   *  nothing to take back. Undefined when the Model history owns it. */
  otherHistory: () => { label: string | null } | undefined
}

export type ModelCommandSpec = ModelEditSpec<never, unknown> | ModelReadSpec<never, unknown> | ModelHistorySpec

const REPLAY_WINDOW = 64
// Keyed by requestId, holding the call's promise from the moment it starts: a
// retry that arrives while the first call is still rebuilding awaits that same
// call instead of committing again. A refusal is dropped once it settles, so the
// same id can be retried with good input.
const replayCaches = new WeakMap<ModelSession, Map<string, Promise<ModelCommandResult>>>()

function jsonCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

export function refuse(code: RefusalCode, message: string, path?: string): Refusal {
  return path === undefined ? { ok: false, code, message } : { ok: false, code, message, path }
}

export function isRefusal(value: unknown): value is Refusal {
  return typeof value === 'object' && value !== null && (value as { ok?: unknown }).ok === false
}

/** The frozen set of commands the agent may run, keyed by id. Data, so a new
 *  store action or doc command can never become an agent command by accident. */
export function createModelRegistry(specs: readonly ModelCommandSpec[]): ReadonlyMap<string, ModelCommandSpec> {
  const map = new Map<string, ModelCommandSpec>()
  for (const spec of specs) {
    if (map.has(spec.id)) throw new Error(`createModelRegistry: duplicate command id ${spec.id}.`)
    map.set(spec.id, spec)
  }
  return map
}

/** `ids` plus every node that consumes them, directly or not: what a rebuild of `ids` can change. */
function withDownstream(session: ModelSession, ids: readonly string[]): string[] {
  const out = new Set(ids)
  let grew = true
  while (grew) {
    grew = false
    for (const nid of session.dag.nodeIds()) {
      if (out.has(nid)) continue
      if (session.dag.getNode(nid)?.consumes.some((c) => out.has(c))) {
        out.add(nid)
        grew = true
      }
    }
  }
  return [...out]
}

function rebuiltNodes(session: ModelSession, ids: readonly string[]): { status: Record<string, string>; diagnostics: ModelDiagnostic[] } {
  const status: Record<string, string> = {}
  const diagnostics: ModelDiagnostic[] = []
  for (const id of withDownstream(session, ids).sort()) {
    if (!session.dag.has(id)) continue
    status[id] = session.scheduler.statusOf(id)
    // A parameter's own failure is a typed PARAM_* diagnostic only through the
    // table (the same words the Parameters table shows); every other node reports
    // the scheduler's.
    const paramName = paramNameFromNodeId(id)
    const found = paramName === undefined ? session.scheduler.diagnosticsOf(id) : session.params.diagnosticsOf(paramName)
    for (const d of found) {
      const detail = Object.entries(d.params ?? {})
        .map(([k, v]) => `${k}=${v}`)
        .join(', ')
      diagnostics.push({ nodeId: id, code: d.code, message: detail === '' ? d.code : `${d.code}: ${detail}` })
    }
  }
  return { status, diagnostics }
}

function emptyChanged(): ChangedIds {
  return { created: [], edited: [], removed: [] }
}

/** What one undo/redo did to the document: nodes it added or took away, and the
 *  nodes its step touched that exist on both sides. Rebuild roots are not the
 *  change set (a genesis undo's roots are the removed node's consumers). */
function documentChange(session: ModelSession, nodesBefore: ReadonlySet<string>, stepTouched: readonly string[]): ChangedIds {
  const nodesAfter = new Set(session.dag.nodeIds())
  return {
    created: [...nodesAfter].filter((id) => !nodesBefore.has(id)).sort(),
    edited: [...new Set(stepTouched)].filter((id) => nodesBefore.has(id) && nodesAfter.has(id)).sort(),
    removed: [...nodesBefore].filter((id) => !nodesAfter.has(id)).sort(),
  }
}

export const NO_MODEL_OPEN_MESSAGE =
  'No model is open. Open the Model page for the part you want to work on, then run this again.'

export async function runModelCommand(
  registry: ReadonlyMap<string, ModelCommandSpec>,
  id: string,
  args: unknown,
  options: RunOptions = {},
): Promise<ModelCommandResult> {
  // 1. Allow-list.
  const spec = registry.get(id)
  if (spec === undefined) {
    return refuse('unknown-command', `"${id}" is not a model command. Ask for the list of commands to see what is available.`)
  }

  // 2. Schema.
  const problem = firstSchemaProblem(spec.input, args === undefined ? {} : args)
  if (problem !== undefined) return refuse('invalid-arguments', problem.message, problem.path)
  if (options.expectRevision !== undefined && !Number.isInteger(options.expectRevision)) {
    return refuse('invalid-arguments', 'expectRevision must be a whole number.', 'expectRevision')
  }
  if (options.requestId !== undefined && typeof options.requestId !== 'string') {
    return refuse('invalid-arguments', 'requestId must be text.', 'requestId')
  }
  const input = (args === undefined ? {} : args) as never

  // The session: none while no Model page is mounted. Never create one here.
  const modelItemId = options.modelItemId ?? LEGACY_MODEL_ITEM_ID
  const session = getModelSession(modelItemId)
  if (session === undefined) return refuse('no-model-open', NO_MODEL_OPEN_MESSAGE)

  // 3. Replay.
  const isEdit = spec.effect === 'edit'
  let cache = replayCaches.get(session)
  if (cache === undefined) {
    cache = new Map()
    replayCaches.set(session, cache)
  }
  const requestId = isEdit ? options.requestId : undefined
  if (requestId !== undefined) {
    const inFlightOrDone = cache.get(requestId)
    if (inFlightOrDone !== undefined) return inFlightOrDone
  }

  // 4. Revision (the session's own edit counter, not the remount generation).
  if (options.expectRevision !== undefined && options.expectRevision !== session.revision()) {
    return refuse(
      'stale-revision',
      `The model has changed since you last looked (revision ${session.revision()}, you expected ${options.expectRevision}). Read it again, then repeat the change.`,
    )
  }

  // Anything below that throws (a parse that overflows the stack, a rebuild that
  // fails) is answered as a refusal, never as a raw exception to the caller.
  const revisionBefore = session.revision()
  const running = runChecked(spec, session, modelItemId, input).catch(() =>
    refuse(
      'refused',
      session.revision() === revisionBefore
        ? `${spec.id} could not be run on this input and nothing was changed. Check the arguments and try again.`
        : `${spec.id} was recorded but the model could not be rebuilt. Run model.undo to take it back, then try again.`,
    ),
  )
  if (requestId === undefined) return running
  // Registered before the first await, so an overlapping retry finds it.
  cache.set(requestId, running)
  if (cache.size > REPLAY_WINDOW) cache.delete(cache.keys().next().value as string)
  const result = await running
  if (!result.ok && cache.get(requestId) === running) cache.delete(requestId)
  return result
}

async function runChecked(
  spec: ModelCommandSpec,
  session: ModelSession,
  modelItemId: string,
  input: never,
): Promise<ModelCommandResult> {
  let success: ModelCommandSuccess<unknown>
  // WO-3000: what the page is told, AFTER the result below is captured.
  let notice: ModelChangeNotice | null = null
  if (spec.kind === 'read') {
    const value = spec.read(session, input)
    if (isRefusal(value)) return value
    success = {
      ok: true,
      command: spec.id,
      step: null,
      revision: session.revision(),
      changed: emptyChanged(),
      status: {},
      diagnostics: [],
      value,
    }
  } else if (spec.kind === 'history') {
    const other = spec.otherHistory()
    if (other !== undefined) {
      // Not a Model step: the document, its revision and the Model history are untouched.
      const value = spec.direction === 'undo' ? { undone: other.label } : { redone: other.label }
      return deepFreeze(jsonCopy({ ok: true, command: spec.id, step: null, revision: session.revision(), changed: emptyChanged(), status: {}, diagnostics: [], value }))
    }
    // WO-3000: the page's own Undo/Redo guards (a pending chamfer / shell / hole adoption).
    const blocked = session.historyRefusal(spec.direction)
    if (blocked !== null) return refuse('refused', blocked)
    // The ids the step about to be popped touched, and the document's nodes, before it.
    const stack = spec.direction === 'undo' ? session.touchedPast.current : session.touchedFuture.current
    const stepTouched = [...(stack[stack.length - 1] ?? [])]
    const nodesBefore = new Set(session.dag.nodeIds())
    const result = spec.direction === 'undo' ? await session.undo() : await session.redo()
    const label = result === undefined ? null : result.command.label
    const touched = result?.roots ?? []
    const { status, diagnostics } = rebuiltNodes(session, [...touched, ...(result?.pass.executed ?? [])])
    if (result !== undefined) {
      markDocumentDirty(modelItemId)
      notice = { kind: spec.direction, label: result.command.label, roots: [...result.roots] }
    }
    success = {
      ok: true,
      command: spec.id,
      step: null,
      revision: session.revision(),
      changed: result === undefined ? emptyChanged() : documentChange(session, nodesBefore, stepTouched),
      status,
      diagnostics,
      value: spec.direction === 'undo' ? { undone: label } : { redone: label },
    }
  } else {
    // 5. Enabled: only what the screen itself refuses.
    const disabled = spec.enabled(session, input)
    if (disabled !== null) return disabled
    // 6. Prepare: pure; the screen's own rules, the screen's own words.
    const prepared = spec.prepare(session, input)
    if (isRefusal(prepared)) return prepared
    // 7 + 8. Commit once, then rebuild through the shared scheduler.
    const pass = await session.execute({ label: prepared.label, commands: prepared.commands, touched: prepared.touched })
    markDocumentDirty(modelItemId)
    notice = { kind: 'execute', label: prepared.label, roots: [...prepared.touched] }
    const { status, diagnostics } = rebuiltNodes(session, [...prepared.touched, ...pass.executed])
    success = {
      ok: true,
      command: spec.id,
      step: prepared.label,
      revision: session.revision(),
      changed: prepared.changed,
      status,
      diagnostics,
      value: prepared.finish(session),
    }
  }

  // 9. Result: a detached, frozen copy. Only then may a page repaint start (WO-3000).
  const frozen = deepFreeze(jsonCopy(success)) as ModelCommandSuccess<unknown>
  if (notice !== null) session.announce(notice)
  return frozen
}
