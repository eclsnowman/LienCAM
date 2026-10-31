// WO-3125: pure Setup Load preparation and its single-use worker client.
// Only cloneable facts cross this boundary. Controllers and live safety verdicts
// never do. The source preview describes displayed bytes, not M6/mesh staging.
import { textProgramInsight, type ProgramInsightFacts } from '../gcode/programInsight'
import type { GcodeProgram } from '../gcode/parse'
import { prepareSimulatedProgram, type SimulatorParseInput, type PreparedSimulatedProgram } from './simulatedProgramPreparation'
import { yieldSetupLoadTask, programListingKinds, type ProgramListingKind } from '../gcode/text'
import { programToolCalls, type ProgramToolCall } from './programTools'
import type { MachineConfig, Project } from '../../types'
import { lintGcode, type LintFinding } from '../gcode'
import type { GcodeReaderOptions } from '../gcode/reader'
import { gcodeWordTable, useGcodeWordTable, type GcodeWordTable } from '../gcode/wordTable'
import { postProject } from '../post/postProject'
import type { PostConfig, PostInput } from '../post/types'
import { operationGenerationIsCurrent } from '../cam/generationFingerprint'
import { buildPreviewModel, setupLoadPreviewMatches, type PreviewModel } from './previewGeometry'
import { prepareTransferCheckGeometry, type TransferCheckGeometry } from './transferCheck'
import { transferCheckJobFromPreview } from './programContext'
import { programPathFromPreview, type ProgramPath } from './programPath'
import { prepareTextProgramRunEstimate, type PreparedProgramRunEstimate } from './programRunEstimate'
import {
  buildProgramContext, compareProgramContext, compareProgramContextPerSetup,
  programIntentIdentity, type ProgramContextV1, type ProgramContextComparison,
  type ProgramContextSetupVerdict,
} from './programContext'

export interface SetupLoadRequest {
  project: Project
  setupId: string
  post: PostConfig
  modelRefsVerifiedSinceLoad: Parameters<typeof postProject>[3]['modelRefsVerifiedSinceLoad']
  machine: MachineConfig
  reader: GcodeReaderOptions
  tables: GcodeWordTable[]
}

/**
 * The renderer may publish for a preference, selection, or no-op update while
 * Setup Load's worker is running.  A publication is not itself a new post
 * input.  Keep one detached witness for the actual inputs this request reads;
 * once an observed value changes it remains invalidated, including an
 * edit-away/edit-back sequence.  This deliberately complements (rather than
 * replaces) the session, parser, and request fences at the caller.
 */
export interface SetupLoadInputWitnessInput {
  project: Project
  toolLibrary: Project['toolLibrary']
  setupId: string
  machine: MachineConfig
  post: PostConfig
  modelRefsVerifiedSinceLoad: SetupLoadRequest['modelRefsVerifiedSinceLoad']
  parserIdentity: string
}

type DetachedSetupLoadInputs = {
  intent: readonly unknown[]
  setupId: string
  machine: MachineConfig
  post: PostConfig
  modelRefsVerifiedSinceLoad: SetupLoadRequest['modelRefsVerifiedSinceLoad']
  parserIdentity: string
}

function detachedSetupLoadInputs(input: SetupLoadInputWitnessInput): DetachedSetupLoadInputs {
  return structuredClone({
    intent: programIntentIdentity(input.project, input.toolLibrary),
    setupId: input.setupId,
    machine: input.machine,
    post: input.post,
    modelRefsVerifiedSinceLoad: input.modelRefsVerifiedSinceLoad,
    parserIdentity: input.parserIdentity,
  })
}

// The initial value must be detached so raw in-place edits remain observable.
// Later publications compare their live read-set against that one snapshot:
// cloning the same graph for every unrelated publication was renderer work,
// not additional invalidation coverage.
function currentSetupLoadInputs(input: SetupLoadInputWitnessInput): DetachedSetupLoadInputs {
  return {
    intent: programIntentIdentity(input.project, input.toolLibrary),
    setupId: input.setupId,
    machine: input.machine,
    post: input.post,
    modelRefsVerifiedSinceLoad: input.modelRefsVerifiedSinceLoad,
    parserIdentity: input.parserIdentity,
  }
}

function sameDetachedValue(left: unknown, right: unknown, keys: WeakMap<object, readonly string[]>, pairs = new WeakMap<object, object>()): boolean {
  if (Object.is(left, right)) return true
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false
  if (pairs.get(left) === right) return true
  pairs.set(left, right)
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((value, index) => Object.is(value, right[index]) || sameDetachedValue(value, right[index], keys, pairs))
  }
  if (left instanceof Date || right instanceof Date) return left instanceof Date && right instanceof Date && left.getTime() === right.getTime()
  if (left instanceof Map || right instanceof Map) {
    if (!(left instanceof Map) || !(right instanceof Map) || left.size !== right.size) return false
    const a = [...left.entries()], b = [...right.entries()]
    return a.every(([key, value], index) => sameDetachedValue(key, b[index][0], keys, pairs) && sameDetachedValue(value, b[index][1], keys, pairs))
  }
  if (left instanceof Set || right instanceof Set) {
    if (!(left instanceof Set) || !(right instanceof Set) || left.size !== right.size) return false
    const a = [...left], b = [...right]
    return a.every((value, index) => sameDetachedValue(value, b[index], keys, pairs))
  }
  const a = left as Record<string, unknown>, b = right as Record<string, unknown>
  // Retain ordered shapes during the first required content check. A separate
  // eager traversal here added a measured 232 ms to the merged Full Suite click.
  let leftKeys = keys.get(a)
  if (!leftKeys) { leftKeys = Object.keys(a); keys.set(a, leftKeys) }
  let index = 0
  for (const key in b) {
    if (!Object.hasOwn(b, key)) continue
    if (key !== leftKeys[index++]) return false
    const value = a[key], other = b[key]
    if (!Object.is(value, other) && !sameDetachedValue(value, other, keys, pairs)) return false
  }
  return index === leftKeys.length
}

/**
 * `changed(current)` is the full raw/ABA scan of the read-set. WO-3292:
 * `changed(current, true)` is the adoption commit's recheck, one task after a
 * full scan that held: it skips only the program-intent graph, and only when
 * every intent member is the very reference that scan read. The caller keeps
 * its store subscription (a full scan per publication) live across that gap.
 * Every other read value is still compared in full, and the result stays sticky.
 */
export function observeSetupLoadInputs(input: SetupLoadInputWitnessInput): { changed(current: SetupLoadInputWitnessInput, recheck?: boolean): boolean } {
  let changed = false
  let initial: DetachedSetupLoadInputs | null
  let scanned: readonly unknown[] | null = null
  const keys = new WeakMap<object, readonly string[]>()
  try { initial = detachedSetupLoadInputs(input) }
  catch { initial = null }
  return {
    changed(current, recheck = false) {
      if (changed) return true
      try {
        const live = currentSetupLoadInputs(current)
        const held = recheck && initial !== null && scanned !== null && scanned.length === live.intent.length
          && live.intent.every((value, index) => Object.is(value, scanned![index]))
        changed = initial === null || !sameDetachedValue(initial, held ? { ...live, intent: initial.intent } : live, keys)
        if (!changed && !held) scanned = live.intent
      } catch { changed = true }
      return changed
    },
  }
}
export interface SourceProgramAnalysis {
  text: string
  parserIdentity: string
  motionDigest: string
  preview: PreviewModel
  insight?: ProgramInsightFacts
  path: ProgramPath
  timing: PreparedProgramRunEstimate | null
  timingIdentity: string
  listingKinds?: ProgramListingKind[]
  distance: { mode: 'source-line'; cursors: number[]; cumulative: number[]; total: number }
}
export type SetupLoadResult = {
  freshness?: Array<[string, boolean]>
  posted: ReturnType<typeof postProject>
  context: ProgramContextV1 | null
  analysis: SourceProgramAnalysis | null
  comparison: ProgramContextComparison | 'comparison-failed'
  perSetup: ReadonlyArray<ProgramContextSetupVerdict> | null
}
export interface SetupLoadMessage { request: SetupLoadRequest; messages: Record<string, string> }
export type SetupLoadReply = { ok: true; result: SetupLoadResult } | { ok: false; error: string }

export function setupLoadParserTables(): GcodeWordTable[] {
  return (['uccnc', 'grbl', 'linuxcnc', 'generic'] as const).map(gcodeWordTable)
}
export function setupLoadParserIdentity(): string { return JSON.stringify(setupLoadParserTables()) }
export function setupLoadTimingIdentity(machine: MachineConfig, reader: GcodeReaderOptions): string {
  // The reader/planner never reads the four operator-owned tool-record fields.
  // Filling the table at adoption must not force the UI to run the full reader
  // again. Every other machine/reader field, including offsets, stays keyed.
  return JSON.stringify({ machine: postedMachineIdentity(machine), reader: { ...reader,
    machineDefinition: reader.machineDefinition
      ? postedMachineIdentity(reader.machineDefinition as MachineConfig) : undefined,
  } })
}

/** The production worker entry calls this exact pure method; the fallback does
 * the same work on hosts without module workers. No alternate post or parser. */
export function prepareSetupLoad(request: SetupLoadRequest): SetupLoadResult {
  const restores = request.tables.map(useGcodeWordTable)
  try {
    const setup = request.project.setups.find(s => s.id === request.setupId)
    if (!setup) throw new Error('Setup no longer exists.')
    let postInput: PostInput | undefined
    const posted = postProject(request.project, [setup], request.post, {
      mode: 'combined', pauseBetweenSetups: false, baseName: 'control', ext: 'nc',
      modelRefsVerifiedSinceLoad: request.modelRefsVerifiedSinceLoad,
    }, (_setup, input) => { postInput = input })
    // These are the results of buildPostInput's canonical downgrade, not
    // saved ready/status claims. A stale nest skips that predicate in the post
    // owner, so run it once here for staging's independent existing semantics.
    const freshness: Array<[string, boolean]> = setup.operations.filter(op => op.enabled).map(op => {
      const resolved = postInput?.setup.operations.find(section => section.op.id === op.id)?.op
      const geometryId = (op.params as { geometryId?: string } | undefined)?.geometryId
      const nestId = request.project.geometry.find(geometry => geometry.id === geometryId)?.ownerNestId
      const staleNest = nestId !== undefined && request.project.nests?.some(nest => nest.id === nestId && nest.needsRecompute)
      const current = op.status !== 'ready' ? false
        : staleNest ? operationGenerationIsCurrent(request.project, setup, op)
          : resolved ? resolved.status === 'ready'
            : postInput?.setup.nothingToCut?.some(entry => entry.opId === op.id)
              ? true : operationGenerationIsCurrent(request.project, setup, op)
      return [op.id, current]
    })
    if (!posted.ok || !posted.combined?.operationSpans) {
      return { posted, freshness, context: null, analysis: null, comparison: 'no-context', perSetup: null }
    }
    const text = posted.combined.gcode
    const context = buildProgramContext(request.project, setup, request.post, text, posted.combined.operationSpans, postInput)
    const intent = { project: request.project, setup, post: request.post, digest: context.projectFingerprint }
    let parsed: GcodeProgram | undefined
    const preview = buildPreviewModel(text, program => { parsed = program })
    const insight = textProgramInsight(text, parsed ? { model: preview, program: parsed } : undefined)
    const path = programPathFromPreview(preview)
    const distance: SourceProgramAnalysis['distance'] = { mode: 'source-line', cursors: [], cumulative: [], total: 0 }
    for (let index = 1; index < path.moves.length; index++) {
      const a = path.moves[index - 1], b = path.moves[index]
      distance.total += Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z)
      const line = path.moveLines[index]
      if (distance.cursors.at(-1) === line) distance.cumulative[distance.cumulative.length - 1] = distance.total
      else { distance.cursors.push(line); distance.cumulative.push(distance.total) }
    }
    let timing: PreparedProgramRunEstimate | null = null
    try { timing = prepareTextProgramRunEstimate(text, request.machine, request.reader) }
    catch { /* Existing display-only timing failure: never change Load. */ }
    let comparison: SetupLoadResult['comparison'] = 'comparison-failed'
    let perSetup: SetupLoadResult['perSetup'] = null
    try {
      comparison = compareProgramContext(context, request.project, text, request.post, context.motionDigest, intent)
      perSetup = compareProgramContextPerSetup(context, request.project, text, request.post, context.motionDigest, intent)
    } catch { /* WO-398: preserve comparison-failed, never dress up as drift. */ }
    return { posted, freshness, context, comparison, perSetup, analysis: {
      listingKinds: programListingKinds(text.split(/\r?\n/).map((text, index) => ({ text, moveId: index + 1, lineNumber: index + 1 }))),
      text, parserIdentity: JSON.stringify(request.tables), motionDigest: context.motionDigest, preview, insight, path, distance, timing,
      timingIdentity: setupLoadTimingIdentity(request.machine, request.reader),
    } }
  } finally { for (const restore of restores.reverse()) restore() }
}

export interface TransferLoadRequest {
  sourceText: string
  stagedText: string
  simulator?: SimulatorParseInput
  tables: GcodeWordTable[]
  commentStyle: NonNullable<Parameters<typeof lintGcode>[1]>['commentStyle']
}
export interface PreparedTransferLoad {
  sourceResult?: SetupLoadResult
  sourceText: string
  stagedText: string
  parserIdentity: string
  commentStyle: TransferLoadRequest['commentStyle']
  preview: PreviewModel
  simulator?: PreparedSimulatedProgram
  lint: LintFinding[]
  toolCalls?: ProgramToolCall[]
  geometry?: TransferCheckGeometry
}
export interface TransferLoadMessage { kind: 'transfer'; transfer: TransferLoadRequest; messages: Record<string, string> }
export type TransferLoadReply = { ok: true; result: PreparedTransferLoad } | { ok: false; error: string }
export function prepareTransferLoad(request: TransferLoadRequest, source?: SourceProgramAnalysis): PreparedTransferLoad {
  const restores = request.tables.map(useGcodeWordTable)
  try {
    const preview = source?.text === request.sourceText && source.parserIdentity === JSON.stringify(request.tables)
      && setupLoadPreviewMatches(request.sourceText, request.stagedText) ? source.preview : buildPreviewModel(request.stagedText)
    return { sourceText: request.sourceText, stagedText: request.stagedText,
      parserIdentity: JSON.stringify(request.tables), commentStyle: request.commentStyle,
      preview, geometry: prepareTransferCheckGeometry(transferCheckJobFromPreview(preview)),
      toolCalls: programToolCalls(request.sourceText),
      simulator: request.simulator ? prepareSimulatedProgram(request.stagedText, request.simulator) : undefined,
      lint: lintGcode(request.sourceText, { commentStyle: request.commentStyle }) }
  } finally { for (const restore of restores.reverse()) restore() }
}

// Yield a real browser task, not just a microtask. Callers retain their revision
// guard through this boundary; no controller has been replaced yet.
export { yieldSetupLoadTask } from '../gcode/text'

// A rendering hint only: never a job phase, readiness verdict or control gate.
// Tokens avoid one cancelled/older request releasing a newer request's hint.
const preparingLoads = new Set<() => void>()
export function setupLoadInProgress(): boolean { return preparingLoads.size > 0 }

// WO-3292: also a rendering hint only. True from the adoption commit until the
// next real task, so the preview can draw the adopted program in that task
// instead of inside the store commit. Nothing about the program depends on it.
let adoptingLoads = 0
export function setupLoadAdoptionInProgress(): boolean { return adoptingLoads > 0 }
export function adoptSetupLoad<T>(commit: () => T): T {
  adoptingLoads++
  try { return commit() }
  finally { void yieldSetupLoadTask().then(() => { adoptingLoads-- }) }
}
export function invalidateSetupLoadActivity(): void {
  for (const finish of preparingLoads) finish()
}
export function beginSetupLoadActivity(signal: AbortSignal): () => void {
  const finish = () => {
    preparingLoads.delete(finish)
    signal.removeEventListener('abort', finish)
  }
  if (!signal.aborted) {
    preparingLoads.add(finish)
    signal.addEventListener('abort', finish, { once: true })
  }
  return finish
}

// Flat UTF-8 buffers avoid Chromium's synchronous cloning of the result graph.
// Records are bounded, decoded in task-sized batches, and retain aliasing (the
// simulator's Map/Set keys are the very moves in its moves array).
type GraphKind = 'object' | 'array' | 'map' | 'set'
type GraphValue = null | boolean | string | number | ['ref', number, GraphKind] | ['undefined'] | ['number', string]
type GraphRecord = [number, GraphKind, number, ...GraphValue[]]
export type PackedLoadReply = { ok: true; packed: Uint8Array[] } | { ok: false; error: string }
export function packSetupLoadResult(value: SetupLoadResult | PreparedTransferLoad): Uint8Array[] {
  const ids = new Map<object, number>()
  const queue: object[] = []
  const kindOf = (item: object): GraphKind => Array.isArray(item) ? 'array' : item instanceof Map ? 'map' : item instanceof Set ? 'set' : 'object'
  const encode = (item: unknown): GraphValue => {
    if (item === undefined) return ['undefined']
    if (typeof item === 'number' && (!Number.isFinite(item) || Object.is(item, -0))) return ['number', String(Object.is(item, -0) ? '-0' : item)]
    if (typeof item === 'function' || typeof item === 'symbol' || typeof item === 'bigint') throw new Error('Unsupported Setup Load result value.')
    if (item === null || typeof item !== 'object') return item as null | boolean | string | number
    if (!Array.isArray(item) && !(item instanceof Map) && !(item instanceof Set)
      && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw new Error('Unsupported Setup Load result object.')
    let id = ids.get(item)
    if (id === undefined) { id = queue.length; ids.set(item, id); queue.push(item) }
    return ['ref', id, kindOf(item)]
  }
  encode(value)
  const buffers: Uint8Array[] = []
  const encoder = new TextEncoder()
  let records: string[] = [], size = 0
  const flush = () => { if (records.length) buffers.push(encoder.encode('[' + records.join(',') + ']')); records = []; size = 0 }
  const emit = (record: GraphRecord) => {
    const json = JSON.stringify(record)
    if (size + json.length > 32768) flush()
    records.push(json); size += json.length
  }
  for (let id = 0; id < queue.length; id++) {
    const item = queue[id], kind = kindOf(item)
    const values = kind === 'map' ? [...(item as Map<unknown, unknown>)].flat()
      : kind === 'set' ? [...(item as Set<unknown>)]
      : kind === 'array' ? item as unknown[] : Object.entries(item).flat()
    // Empty containers still need a record; long arrays never form one giant
    // JSON.parse call. Large individual source strings stay exact UTF-8.
    for (let offset = 0; offset < Math.max(1, values.length); offset += 128) {
      emit([id, kind, offset, ...values.slice(offset, offset + 128).map(encode)])
    }
  }
  flush()
  return buffers
}
export async function unpackSetupLoadResult<T>(buffers: Uint8Array[], signal?: AbortSignal): Promise<T> {
  const nodes: Array<Record<string, unknown> | unknown[] | Map<unknown, unknown> | Set<unknown>> = []
  const node = (id: number, kind: GraphKind) => nodes[id] ??= kind === 'array' ? [] : kind === 'map' ? new Map() : kind === 'set' ? new Set() : {}
  const decode = (value: GraphValue): unknown => {
    if (!Array.isArray(value)) return value
    if (value[0] === 'ref') return node(value[1], value[2])
    if (value[0] === 'undefined') return undefined
    return value[1] === '-0' ? -0 : Number(value[1])
  }
  const decoder = new TextDecoder()
  let started = performance.now()
  let batch = 0
  for (const buffer of buffers) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    const records = JSON.parse(decoder.decode(buffer)) as GraphRecord[]
    for (const [id, kind, offset, ...values] of records) {
      const target = node(id, kind)
      if (kind === 'object') {
        for (let i = 0; i < values.length; i += 2) {
          const key = values[i] as string, value = decode(values[i + 1])
          if (key === '__proto__') Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true })
          else (target as Record<string, unknown>)[key] = value
        }
      } else if (kind === 'array') {
        for (let i = 0; i < values.length; i++) (target as unknown[])[offset + i] = decode(values[i])
      } else if (kind === 'map') {
        for (let i = 0; i < values.length; i += 2) (target as Map<unknown, unknown>).set(decode(values[i]), decode(values[i + 1]))
      } else for (const value of values) (target as Set<unknown>).add(decode(value))
    }
    if (++batch >= 64 || performance.now() - started >= 45 || (buffer === buffers.at(-1) && batch >= 4)) { await yieldSetupLoadTask(); started = performance.now(); batch = 0 }
  }
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  return nodes[0] as T
}

const retainedPreparationWorkers = new WeakMap<object, { worker: Worker; release(): void; recoverSource(): SetupLoadResult }>()
function offThread<T>(message: SetupLoadMessage | TransferLoadMessage, signal: AbortSignal, fallback: () => T, previous?: object): Promise<T> {
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'))
  if (typeof Worker === 'undefined') return Promise.resolve().then(() => {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
    return fallback()
  })
  return new Promise((resolve, reject) => {
    let worker: Worker
    const retained = previous ? retainedPreparationWorkers.get(previous) : undefined
    if (previous) retainedPreparationWorkers.delete(previous)
    try {
      worker = retained?.worker ?? new Worker(new URL('./setupLoadPreparation.worker.ts', import.meta.url), { type: 'module', name: 'setup-load-preparation' })
      retained?.release()
    }
    catch { try { resolve(fallback()) } catch (error) { reject(error) }; return }
    let stopped = false
    let receiving = false
    const stop = (keep = false) => { stopped = true; signal.removeEventListener('abort', abort); if (!keep) worker.terminate() }
    const abort = () => { stop(); reject(new DOMException('Aborted', 'AbortError')) }
    const recover = () => {
      if (stopped || receiving) return
      stop()
      if (signal.aborted) { reject(new DOMException('Aborted', 'AbortError')); return }
      try { resolve(fallback()) } catch (error) { reject(error) }
    }
    signal.addEventListener('abort', abort, { once: true })
    worker.onmessage = (event: MessageEvent<PackedLoadReply | { ok: true; result: T }>) => {
      if (stopped || receiving) return
      receiving = true
      // Keep abort ownership until the incremental unpack has finished.
      if (signal.aborted) { stop(); reject(new DOMException('Aborted', 'AbortError')); return }
      if (event.data.ok) return ('packed' in event.data ? unpackSetupLoadResult<T>(event.data.packed, signal) : Promise.resolve(event.data.result)).then(
        result => {
          const keep = !('kind' in message) && result !== null && typeof result === 'object'
          stop(keep)
          if (keep) {
            const terminate = () => worker.terminate()
            signal.addEventListener('abort', terminate, { once: true })
            retainedPreparationWorkers.set(result, { worker, release: () => signal.removeEventListener('abort', terminate), recoverSource: fallback as () => SetupLoadResult })
          }
          resolve(result)
        }, error => { stop(); reject(error) },
      )
      else { stop(); reject(new Error(event.data.error)) }
    }
    worker.onerror = event => { event.preventDefault(); recover() }
    worker.onmessageerror = recover
    // Detaching the raw/ABA witness and cloning the input to a worker were
    // two expensive native operations in one task. Keep the same witness and
    // abort ownership, and send in the next real task without touching a job.
    void yieldSetupLoadTask().then(() => {
      if (stopped || signal.aborted) return
      try { worker.postMessage(message) } catch { recover() }
    })
  })
}
export function prepareSetupLoadOffThread(message: SetupLoadMessage, signal: AbortSignal): Promise<SetupLoadResult> {
  return offThread(message, signal, () => prepareSetupLoad(message.request))
}
export function prepareTransferLoadOffThread(request: TransferLoadRequest, signal: AbortSignal, messages: Record<string, string> = {}, source?: SetupLoadResult): Promise<PreparedTransferLoad> {
  const retained = source ? retainedPreparationWorkers.get(source) : undefined
  return offThread({ kind: 'transfer', transfer: request, messages }, signal, () => {
    const fullSource = source?.analysis ? source : retained?.recoverSource()
    return { ...prepareTransferLoad(request, fullSource?.analysis ?? undefined), ...(fullSource ? { sourceResult: fullSource } : {}) }
  }, source)
}

// At most one program's display facts. Exact text and parser configuration are
// always checked. A public file/re-arm path may reuse pure same-byte geometry;
// it cannot inherit a setup's context verdict or another machine's timing.
let sourceAnalysis: SourceProgramAnalysis | null = null
let comparisonBinding: {
  context: ProgramContextV1; text: string; identity: readonly unknown[];
  machine: string; post: string; comparison: SetupLoadResult['comparison'];
  perSetup: SetupLoadResult['perSetup'];
} | null = null
function postedMachineIdentity(machine: MachineConfig): string {
  const { toolTable: _table, probeOverrides: _probe, probePads: _pads, activeProbePadId: _pad, ...posted } = machine
  return JSON.stringify(posted)
}
export function publishSetupLoadAnalysis(analysis: SourceProgramAnalysis): void {
  sourceAnalysis = analysis
  comparisonBinding = null
}
export function preparedSourceProgram(text: string | null): SourceProgramAnalysis | null {
  return text !== null && sourceAnalysis?.text === text && sourceAnalysis.parserIdentity === setupLoadParserIdentity()
    ? sourceAnalysis : null
}
export function bindSetupLoadComparison(result: SetupLoadResult, context: ProgramContextV1, project: Project, post: PostConfig): void {
  if (!result.analysis || !result.context) return
  comparisonBinding = { context, text: result.analysis.text, identity: programIntentIdentity(project, project.toolLibrary),
    machine: postedMachineIdentity(project.machine), post: JSON.stringify(post), comparison: result.comparison, perSetup: result.perSetup }
}
export function preparedSetupLoadComparison(context: ProgramContextV1 | null, project: Project, text: string | null, post: PostConfig) {
  const saved = comparisonBinding
  if (!saved || saved.context !== context || saved.text !== text || saved.post !== JSON.stringify(post)) return null
  const identity = programIntentIdentity(project, project.toolLibrary)
  if (identity.some((value, index) => index !== 4 && value !== saved.identity[index])
    || postedMachineIdentity(project.machine) !== saved.machine) return null
  return saved
}
