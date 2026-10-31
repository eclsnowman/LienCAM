// WO-2953: operation service, not a kernel or a store singleton. The adapter
// supplies CURRENT world/mm inputs on every access, including async settlement.
import { frameRef, sameFrame, pointMm, vectorMm, rigidMap, mapPoint, mapVector, type FrameRef } from '../geometry/coordinateFrames'
import type { ToolpathMove, Vec3 } from '../../types'
import { effectiveMoveRole, isStockCuttingRole } from './stockCuttingRoles'
import type { Box3 } from '../../cam3d/stock'
import {
  applyConservativeStockOperation, createConservativeStockColumns,
  highestConservativeStockOver, isConservativeStockRegionEmpty,
  type ConservativeStockColumns, type StockCut, type StockRegion,
} from './stockState'

export type StockRemoval =
  | { readonly status: 'missing' | 'computing' | 'cancelled'; readonly reason?: string }
  | { readonly status: 'error' | 'unsupported'; readonly reason: string }
  | { readonly status: 'ready'; readonly resultRevision: string; readonly inputRevision: string;
      readonly toolRevision: string; readonly frame: FrameRef<'world'>;
      /** Explicit [] means verified zero removal, not absent toolpath data.
       * Cuts must be upward-open, axis-aligned flat/ball linear sweeps in world
       * mm. Arcs must be conservatively enclosed by an adapter, not chorded
       * with an unreported error. This backend refuses XY+Z ramps. */
      readonly cuts: readonly StockCut[] }

export interface StockOperationInput {
  readonly id: string
  readonly enabled: boolean
  /** null is unresolved ownership, never infer membership from equal bounds. */
  readonly stockId: string | null
  /** Include geometry/content/placement/parameters/setup/generation inputs.
   * Revisions must change on edit-away/edit-back, even for identical content. */
  readonly inputRevision: string
  readonly toolRevision: string
  readonly removal: StockRemoval
}

export interface OperationStockInputs {
  readonly projectEpoch: string
  /** Monotonic semantic event serial, including undo/redo/reorder/reload. Do not
   * increment for names/visibility/progress/selection. Synchronous reads also
   * compare actual supplied content, but cannot observe an unreported ABA. */
  readonly changeRevision: number
  readonly setupId: string
  readonly stockId: string
  readonly frame: FrameRef<'world'>
  readonly initial: { readonly revision: string; readonly bounds: Readonly<Box3>;
    readonly resolutionMm: number; readonly maxColumns: number }
  readonly operations: readonly StockOperationInput[]
}

export interface StockBeforeRequest {
  readonly beforeOperationId: string
  readonly frame: FrameRef<'world'>
  readonly maxCellMm: number
  /** Upper envelopes have NO finite vertical over-retention guarantee at a
   * boundary/thin wall. A caller needing machining tolerance must say so. */
  readonly requireBoundedOverRetention?: boolean
}

export interface StockQuality {
  readonly capability: 'full-cell-upper-envelope-v1'
  readonly cellMm: number
  readonly roundingAllowanceMm: number
  readonly maxVerticalOverRetentionMm: null
  readonly warnings: readonly string[]
}

export interface StockToken {
  readonly authorityId: number
  readonly generation: number
  readonly projectEpoch: string
  readonly key: string
  readonly request: StockBeforeRequest
}
export type StockRead =
  | { readonly status: 'ready'; readonly token: StockToken; readonly snapshotId: number; readonly quality: StockQuality }
  | { readonly status: 'recomputing'; readonly token: StockToken; readonly waitingFor: readonly string[] }
  | { readonly status: 'unavailable' | 'error'; readonly token: StockToken; readonly reason: string; readonly operationId?: string }

export type StockQuery =
  | { readonly kind: 'highest-material'; readonly frame: FrameRef<'world'>; readonly bounds: Readonly<Box3> }
  | { readonly kind: 'is-empty'; readonly frame: FrameRef<'world'>; readonly region: StockRegion }
export type StockQueryResult =
  | { readonly status: 'ready'; readonly token: StockToken; readonly value: number | boolean | undefined }
  | { readonly status: 'unavailable'; readonly reason: string }

/** Detached, immutable world-mm upper surface. An upper envelope proves absence
 * above it; it cannot prove material exists at its reported height. */
export interface StockSurface {
  readonly token: StockToken
  readonly frame: FrameRef<'world'>
  readonly bounds: Readonly<Box3>
  readonly cellMm: number
  readonly nx: number
  readonly ny: number
  readonly topZ: readonly number[]
  readonly quality: StockQuality
}
export type StockSurfaceRead =
  | { readonly status: 'ready'; readonly surface: StockSurface }
  | { readonly status: 'unavailable'; readonly reason: string }

/** Injection boundary for a future material backend. Async implementations must
 * return immutable full-cell envelopes with the same capability. No handles or
 * mutable worker buffers escape the authority. No separate kernel dependency. */
export interface OperationStockBackend {
  create(initial: OperationStockInputs['initial']): ConservativeStockColumns | Promise<ConservativeStockColumns>
  apply(stock: ConservativeStockColumns, cuts: readonly StockCut[]): ConservativeStockColumns | Promise<ConservativeStockColumns>
}
const defaultBackend: OperationStockBackend = {
  create: initial => createConservativeStockColumns(initial.bounds, initial.resolutionMm, initial.maxColumns),
  apply: applyConservativeStockOperation,
}

export type Captured = { key: string; baseKey: string; inputs: OperationStockInputs;
  predecessors: readonly StockOperationInput[]; problem?: { status: 'unavailable' | 'error' | 'recomputing'; reason: string; operationId?: string }
  /** Every enabled predecessor whose removal is missing or computing, in execution order. */
  waiting: readonly string[]; prefixKeys?: readonly string[] }
type Entry = { token: StockToken; read: StockRead; snapshot?: ConservativeStockColumns; revision?: string }
type Cached = { snapshot: ConservativeStockColumns; id: number }
let nextAuthorityId = 0

// JSON is a lossless content key for this finite, data-only contract (not a
// result count, array identity, hash collision or caller-provided digest).
export function captureStock(latest: OperationStockInputs, request: StockBeforeRequest, own = true, keys = true): Captured {
  const inputs = own ? structuredClone(latest) : latest
  let problem: Captured['problem']
  const fail = (reason: string, operationId?: string, status: 'unavailable' | 'error' | 'recomputing' = 'unavailable') => {
    problem ??= { status, reason, operationId }
  }
  if (!inputs.projectEpoch || !inputs.setupId || !inputs.stockId || !inputs.initial.revision ||
      !Number.isSafeInteger(inputs.changeRevision) || inputs.changeRevision < 0) fail('Explicit stock identity and semantic revision are required.')
  if (inputs.frame.kind !== 'world' || request.frame.kind !== 'world' ||
      inputs.frame.projectEpoch !== inputs.projectEpoch || !sameFrame(inputs.frame, request.frame)) fail('Stock query frame identity or revision mismatch.')
  frameRef(inputs.frame)
  frameRef(request.frame)
  if (!Number.isFinite(request.maxCellMm) || request.maxCellMm <= 0) fail('A positive finite maximum cell size is required.')
  if (request.requireBoundedOverRetention) fail('This backend cannot bound vertical over-retention; a finer capability is required.')
  const ids = inputs.operations.map(op => op.id)
  if (ids.some(id => !id) || new Set(ids).size !== ids.length) fail('Operation identities must be unique and explicit.')
  const end = inputs.operations.findIndex(op => op.id === request.beforeOperationId)
  if (end < 0) fail('Requested operation is missing.', request.beforeOperationId)
  if (end >= 0 && inputs.operations[end].stockId !== inputs.stockId) fail('Requested operation stock ownership is unresolved or different.', request.beforeOperationId)
  const predecessors = inputs.operations.slice(0, Math.max(0, end)).filter(op => op.enabled)
  const relevant: StockOperationInput[] = []
  const waiting: string[] = []
  for (const op of predecessors) {
    if (typeof op.stockId !== 'string' || !op.stockId) { fail('Predecessor stock ownership is unresolved.', op.id); relevant.push(op); continue }
    if (op.stockId !== inputs.stockId) continue
    relevant.push(op)
    if (!op.inputRevision || !op.toolRevision) fail('Predecessor input/tool revision is missing.', op.id)
    const removal = op.removal
    if (removal.status === 'ready') {
      if (!removal.resultRevision || removal.inputRevision !== op.inputRevision || removal.toolRevision !== op.toolRevision) fail('Predecessor result is stale.', op.id)
      if (removal.frame.kind !== 'world' || !sameFrame(removal.frame, inputs.frame)) fail('Predecessor removal frame mismatch.', op.id)
      if (!Array.isArray(removal.cuts)) fail('Missing removal is not verified zero removal.', op.id)
    } else if (removal.status === 'missing' || removal.status === 'computing') {
      fail('Predecessor removal is not ready.', op.id, 'recomputing')
      waiting.push(op.id)
    } else if (removal.status === 'error') {
      fail(removal.reason, op.id, 'error')
    } else {
      fail(removal.reason || 'Predecessor compute was cancelled.', op.id)
    }
  }
  const baseKey = keys ? JSON.stringify([1, inputs.projectEpoch, inputs.setupId, inputs.stockId, inputs.frame, inputs.initial]) : ''
  const key = keys ? JSON.stringify([baseKey, inputs.changeRevision, request, relevant, problem]) : ''
  return { key, baseKey, inputs, predecessors: relevant, problem, waiting }
}

/** Prepared inputs are owned by the adapter, never live store arrays. Only
 * this adapter opts into asynchronous capture; raw service clients keep exact
 * synchronous capture on every access. revision MUST inspect actual content. */
export interface PreparedStockSource {
  revision(request: StockBeforeRequest): string
  prepare(): Promise<OperationStockInputs>
  capture(inputs: OperationStockInputs, request: StockBeforeRequest): Promise<Captured>
  /** Revoke adapter-internal scan reuse before arbitrary subscriber code. */
  beforeNotify?(): void
}

export interface PreparedMoveWitness { moves: readonly ToolpathMove[]; fieldCounts: readonly number[]; fieldKeys: readonly (readonly string[])[] }

/** Compare the native JSON value without serializing ordinary scalar moves.
 * The owned keys retain JSON property order; undefined/functions/symbols are
 * omitted, nonfinite numbers become null. Extensions use native JSON itself,
 * including callable toJSON and its property-key argument. */
export function stockMoveMatchesJson(move: ToolpathMove, before: ToolpathMove, keys: readonly string[]): boolean {
  const live = move as unknown as Record<string, unknown>
  const saved = before as unknown as Record<string, unknown>
  if (typeof live.toJSON === 'function') return JSON.stringify(move) === JSON.stringify(before)
  let count = 0
  for (const key in live) {
    if (!Object.prototype.hasOwnProperty.call(live, key)) continue
    const value = live[key]
    let normalized: unknown = value
    if (value !== null && (typeof value === 'object' || typeof value === 'function')) {
      const json = JSON.stringify({ [key]: value })
      if (json === '{}') continue
      if (keys[count++] !== key || json !== JSON.stringify({ [key]: saved[key] })) return false
      continue
    }
    if (value === undefined || typeof value === 'symbol') continue
    if (typeof value === 'number' && !Number.isFinite(value)) normalized = null
    if (keys[count++] !== key || normalized !== saved[key]) return false
  }
  return count === keys.length
}

/** Native JSON snapshots are built off-page for new results. Unchanged reads
 * compare the owned scalar fields in place without bulk JSON or cloning. */
export function* stockMoveWitnessSteps(moves: readonly ToolpathMove[]): Generator<undefined, PreparedMoveWitness> {
  const copies: ToolpathMove[] = [], fieldCounts: number[] = [], fieldKeys: string[][] = []
  for (let i = 0; i < moves.length; i++) {
    const copy = JSON.parse(JSON.stringify(moves[i])) as ToolpathMove
    const keys = Object.keys(copy)
    copies.push(copy)
    fieldCounts.push(keys.length)
    fieldKeys.push(keys)
    yield undefined
  }
  return { moves: copies, fieldCounts, fieldKeys }
}

// Cooperatively run pure generators on no-worker hosts too. A macrotask lets
// input, cancellation and paint run; a microtask-only yield cannot do that.
// Leave a paint/input frame between heavy currency/publication turns. A zero
// delay can run another ready planning task before the renderer services input.
function yieldStockTurn(): Promise<void> { return new Promise(resolve => setTimeout(resolve, 16)) }
export async function runStockSteps<T>(steps: Generator<unknown, T>): Promise<T> {
  await yieldStockTurn()
  for (;;) {
    const until = performance.now() + 4
    let step = steps.next()
    while (!step.done && performance.now() < until) step = steps.next()
    if (step.done) return step.value
    await new Promise<void>(resolve => setTimeout(resolve, 0))
  }
}

function* jsonSteps(value: unknown, parts: string[]): Generator<void> {
  if (value === null || typeof value !== 'object') { parts.push(JSON.stringify(value) ?? 'null'); yield; return }
  if (Array.isArray(value)) {
    parts.push('[')
    for (let i = 0; i < value.length; i++) { if (i) parts.push(','); yield* jsonSteps(value[i], parts) }
    parts.push(']')
  } else {
    parts.push('{')
    let first = true
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue
      if (!first) parts.push(',')
      first = false
      parts.push(JSON.stringify(key), ':')
      yield* jsonSteps(item, parts)
    }
    parts.push('}')
  }
}
async function stockJson(value: unknown): Promise<string> {
  const parts: string[] = []
  await runStockSteps(jsonSteps(value, parts))
  return parts.join('')
}
export async function prepareStockCapture(inputs: OperationStockInputs, request: StockBeforeRequest): Promise<Captured> {
  const captured = captureStock(inputs, request, false, false)
  captured.baseKey = await stockJson([1, inputs.projectEpoch, inputs.setupId, inputs.stockId, inputs.frame, inputs.initial])
  captured.key = await stockJson([captured.baseKey, inputs.changeRevision, request, captured.predecessors, captured.problem])
  const prefixParts = [captured.baseKey]
  const prefixKeys: string[] = []
  for (const op of captured.predecessors) {
    prefixParts.push(await stockJson(op))
    prefixKeys.push(await stockJson(prefixParts))
  }
  captured.prefixKeys = prefixKeys
  return captured
}

/** One identified setup/stock domain per instance. The store adapter MUST call
 * reconcile on semantic mutation for eager subscriber notification/scheduling.
 * Every read/query/publication also checks getLatest synchronously, so bypassed
 * subscriptions cannot expose a stale ready snapshot. Prerequisite generation
 * remains the adapter's job: waitingFor tells it which enabled operation to run. */
export class OperationStockAuthority {
  private readonly authorityId = ++nextAuthorityId
  private generation = 0
  private snapshotId = 0
  private readonly entries = new Map<string, Entry>()
  private readonly cache = new Map<string, Cached>()
  private cachedColumns = 0
  private readonly listeners = new Set<() => void>()
  private readonly disposedEpochs = new Set<string>()
  private readonly getLatest: () => OperationStockInputs
  private readonly backend: OperationStockBackend
  private readonly prepared?: PreparedStockSource
  constructor(getLatest: () => OperationStockInputs, backend: OperationStockBackend = defaultBackend, prepared?: PreparedStockSource) {
    this.getLatest = getLatest
    this.backend = backend
    this.prepared = prepared
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  private notify(): void {
    this.prepared?.beforeNotify?.()
    for (const listener of this.listeners) listener()
  }
  private scope(request: StockBeforeRequest): string { return JSON.stringify(request) }

  readBefore(request: StockBeforeRequest): StockRead {
    const immutableRequest = Object.freeze({ ...request, frame: frameRef(request.frame) })
    if (this.prepared) return this.readPrepared(immutableRequest)
    const captured = captureStock(this.getLatest(), immutableRequest)
    if (this.disposedEpochs.has(captured.inputs.projectEpoch)) {
      captured.problem = { status: 'unavailable', reason: 'Project epoch was disposed.' }
      captured.key += ':disposed'
    }
    const scope = this.scope(immutableRequest)
    const previous = this.entries.get(scope)
    if (previous?.token.key === captured.key) return previous.read
    const token: StockToken = Object.freeze({ authorityId: this.authorityId, generation: ++this.generation,
      projectEpoch: captured.inputs.projectEpoch, key: captured.key, request: immutableRequest })
    const p = captured.problem
    const read: StockRead = p?.status === 'error' || p?.status === 'unavailable'
      ? Object.freeze({ status: p.status, token, reason: p.reason, operationId: p.operationId })
      : Object.freeze({ status: 'recomputing', token, waitingFor: Object.freeze(p?.operationId ? [...captured.waiting] : []) })
    const entry: Entry = { token, read }
    // Old tokens become invalid on eviction; an on-demand read rebuilds them.
    // Keep abandoned/deleted operation requests from retaining grids forever.
    if (this.entries.size >= 128 && !this.entries.has(scope)) this.entries.delete(this.entries.keys().next().value!)
    this.entries.set(scope, entry)
    if (!p) void this.compute(captured, entry)
    return entry.read
  }

  private readPrepared(request: StockBeforeRequest): StockRead {
    const revision = this.prepared!.revision(request)
    const scope = this.scope(request)
    const previous = this.entries.get(scope)
    if (previous?.revision === revision) return previous.read
    const token: StockToken = Object.freeze({ authorityId: this.authorityId, generation: ++this.generation,
      projectEpoch: request.frame.projectEpoch, key: `preparing:${revision}`, request })
    const entry: Entry = { token, revision, read: Object.freeze({ status: 'recomputing', token, waitingFor: Object.freeze([]) }) }
    if (this.entries.size >= 128 && !this.entries.has(scope)) this.entries.delete(this.entries.keys().next().value!)
    this.entries.set(scope, entry)
    void this.prepareEntry(entry)
    return entry.read
  }
  private async prepareEntry(entry: Entry): Promise<void> {
    try {
      const inputs = await this.prepared!.prepare()
      if (!this.current(entry)) return
      const captured = await this.prepared!.capture(inputs, entry.token.request)
      if (!this.current(entry)) return
      entry.token = Object.freeze({ ...entry.token, key: captured.key })
      const p = captured.problem
      entry.read = p?.status === 'error' || p?.status === 'unavailable'
        ? Object.freeze({ status: p.status, token: entry.token, reason: p.reason, operationId: p.operationId })
        : Object.freeze({ status: 'recomputing', token: entry.token, waitingFor: Object.freeze(p?.operationId ? [...captured.waiting] : []) })
      if (!p) void this.compute(captured, entry)
      this.notify()
    } catch (error) {
      if (!this.current(entry)) return
      entry.read = Object.freeze({ status: 'error', token: entry.token, reason: String(error) })
      this.notify()
    }
  }

  /** Reconcile is synchronous invalidation; rebuild completes asynchronously. */
  reconcile(): void {
    let changed = false
    for (const entry of [...this.entries.values()]) {
      if (this.readBefore(entry.token.request).token !== entry.token) changed = true
    }
    if (changed) this.notify()
  }
  isCurrent(token: StockToken): boolean {
    if (token.authorityId !== this.authorityId || this.disposedEpochs.has(token.projectEpoch)) return false
    if (this.entries.get(this.scope(token.request))?.token !== token) return false
    const read = this.readBefore(token.request)
    return read.token === token && read.status === 'ready'
  }
  query(token: StockToken, query: StockQuery): StockQueryResult {
    if (!this.isCurrent(token)) return { status: 'unavailable', reason: 'Stock token is stale or not ready.' }
    return this.querySnapshot(token, query)
  }
  /** One synchronous read/query boundary: no caller or subscriber runs between
   * the verified ready reading and its query. Public token queries still
   * re-inspect live content, including unreported same-reference edits. */
  readBeforeAndQuery(request: StockBeforeRequest, query: StockQuery): { read: StockRead; query?: StockQueryResult } {
    const read = this.readBefore(request)
    return read.status === 'ready' ? { read, query: this.querySnapshot(read.token, query) } : { read }
  }
  private querySnapshot(token: StockToken, query: StockQuery): StockQueryResult {
    if (query.frame.kind !== 'world' || !sameFrame(query.frame, token.request.frame)) return { status: 'unavailable', reason: 'Stock query frame mismatch.' }
    const snapshot = this.entries.get(this.scope(token.request))!.snapshot!
    try {
      const value = query.kind === 'highest-material' ? highestConservativeStockOver(snapshot, query.bounds)
        : isConservativeStockRegionEmpty(snapshot, query.region)
      return Object.freeze({ status: 'ready', token, value })
    } catch (error) { return { status: 'unavailable', reason: String(error) } }
  }
  /** Never exposes backend/cache arrays. Recheck currency at publication too:
   * a copied surface remains immutable, but its token can become stale. */
  exportSurface(token: StockToken): StockSurfaceRead {
    if (!this.isCurrent(token)) return { status: 'unavailable', reason: 'Stock token is stale or not ready.' }
    const entry = this.entries.get(this.scope(token.request))!
    if (entry.read.status !== 'ready' || !entry.snapshot) return { status: 'unavailable', reason: 'Stock surface is not ready.' }
    const snapshot = entry.snapshot
    return Object.freeze({ status: 'ready', surface: Object.freeze({ token,
      frame: frameRef(token.request.frame), bounds: Object.freeze({ ...snapshot.bounds }),
      cellMm: snapshot.resolutionMm, nx: snapshot.nx, ny: snapshot.ny,
      topZ: Object.freeze([...snapshot.topZ]), quality: entry.read.quality }) })
  }
  disposeProject(epoch: string): void {
    this.disposedEpochs.add(epoch)
    for (const [scope, entry] of this.entries) if (entry.token.projectEpoch === epoch) this.entries.delete(scope)
    // Cached content may refer to native resources in future implementations.
    this.cache.clear()
    this.cachedColumns = 0
    this.notify()
  }
  private current(entry: Entry): boolean {
    return !this.disposedEpochs.has(entry.token.projectEpoch) &&
      this.entries.get(this.scope(entry.token.request)) === entry &&
      this.readBefore(entry.token.request).token === entry.token
  }
  private remember(key: string, snapshot: ConservativeStockColumns): Cached {
    const existing = this.cache.get(key)
    if (existing) return existing
    // Own the snapshot: async/custom backends cannot later mutate our material.
    const owned = Object.freeze({ ...snapshot, bounds: Object.freeze({ ...snapshot.bounds }),
      warnings: Object.freeze([...snapshot.warnings]), topZ: Object.freeze([...snapshot.topZ]) })
    const value = { snapshot: owned, id: ++this.snapshotId }
    // Bound cells as well as entry count: a default 4M-column snapshot cannot
    // be duplicated 64 times just because operation IDs differ.
    while (this.cache.size && (this.cache.size >= 64 || this.cachedColumns + owned.topZ.length > 8_000_000)) {
      const oldest = this.cache.keys().next().value!
      this.cachedColumns -= this.cache.get(oldest)!.snapshot.topZ.length
      this.cache.delete(oldest)
    }
    this.cache.set(key, value)
    this.cachedColumns += owned.topZ.length
    return value
  }
  private async compute(captured: Captured, entry: Entry): Promise<void> {
    try {
      // WO-3126: exact currency checks and immediate/cache-hit backend replies
      // otherwise concatenate with publication/retries in one microtask turn.
      await yieldStockTurn()
      if (!this.current(entry)) return
      const prefixParts = [captured.baseKey]
      let prefix = captured.baseKey
      let cached = this.cache.get(prefix)
      if (!cached) {
        const snapshot = await this.backend.create(captured.inputs.initial)
        await yieldStockTurn()
        if (!this.current(entry)) return
        cached = this.remember(prefix, snapshot)
      }
      for (const [index, op] of captured.predecessors.entries()) {
        const removal = op.removal
        if (removal.status !== 'ready') return // capture already rejects unknown removal
        if (captured.prefixKeys) prefix = captured.prefixKeys[index]
        else {
          prefixParts.push(JSON.stringify(op))
          prefix = JSON.stringify(prefixParts)
        }
        let next = this.cache.get(prefix)
        if (!next) {
          const snapshot = await this.backend.apply(cached.snapshot, removal.cuts)
          await yieldStockTurn()
          if (!this.current(entry)) return
          next = this.remember(prefix, snapshot)
        }
        cached = next
      }
      await yieldStockTurn()
      if (!this.current(entry)) return
      const snapshot = cached.snapshot
      if (snapshot.resolutionMm > entry.token.request.maxCellMm) {
        entry.read = Object.freeze({ status: 'unavailable', token: entry.token, reason: 'Effective cell size exceeds the requested fidelity.' })
      } else {
        entry.snapshot = snapshot
        entry.read = Object.freeze({ status: 'ready', token: entry.token, snapshotId: cached.id,
          quality: Object.freeze({ capability: snapshot.representation, cellMm: snapshot.resolutionMm,
            roundingAllowanceMm: snapshot.roundingAllowanceMm, maxVerticalOverRetentionMm: null, warnings: snapshot.warnings }) })
      }
      this.notify()
    } catch (error) {
      // Late failures are just as stale as late successes. Never replace newer
      // input readiness with an old exception, including edit-away/edit-back.
      if (!this.current(entry)) return
      entry.read = Object.freeze({ status: 'error', token: entry.token, reason: String(error) })
      this.notify()
    }
  }
}

export type StockReplay = { readonly cutter: import('./stockState').StockStateCutter; readonly liftMm: number }
/** A ramp piece may drop at most this far; each piece counts at its higher end. */
export const RAMP_PIECE_DROP_MM = 0.25
/** Largest chord sagitta an arc is split to (also capped at a tenth of the cutter radius). */
export const ARC_CHORD_SAGITTA_MM = 0.01
const MAX_PIECES_PER_MOVE = 4096

/** Stored world-mm moves to upward-open level/plunge sweeps that never remove
 * more than the real cut: retained stock can only be over-reported.
 * - A ramp (XY+Z together) is split into short level pieces, each swept at its
 *   HIGHER end, so no piece reaches below the cutter's real path.
 * - An arc (or helix) becomes chords. Each chord is swept by the cutter shrunk
 *   by the chord's sagitta s; a ball is also lifted by s so its centre height is
 *   unchanged. A disc/ball of radius R-s within s of the arc lies inside the real
 *   cutter of radius R there. An arc without a centre, or whose start and end
 *   coincide, removes nothing.
 * - A tool with no conservative removal shape (v-bit, chamfer, dovetail...)
 *   removes nothing, and so does a cutting move with no known start.
 * Only rotary endpoints are refused: the stock itself turns under them. */
export function* stockCutSteps(moves: readonly ToolpathMove[], replay: StockReplay | undefined, frame: FrameRef<'world'>): Generator<void, readonly StockCut[] | string> {
  if (!replay) return Object.freeze([])
  const shape = replay
  let result: readonly StockCut[] | string
  try {
    const cuts: StockCut[] = []
    // Stored endpoints already live in project world mm. The checked identity
    // ingress prevents applying geometry placement or WCS origin a second time.
    const ingress = rigidMap(frame, frame, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
    const axis = mapVector(ingress, vectorMm(frame, { x: 0, y: 0, z: 1 })).value
    if (axis.x !== 0 || axis.y !== 0 || axis.z !== 1) throw new Error('a tilted cutter')
    const radius = replay.cutter.diameter / 2
    function* sweep(from: Vec3, to: Vec3, shrinkMm: number): Generator<void> {
      const cutter = shrinkMm > 0 ? { ...shape.cutter, diameter: shape.cutter.diameter - 2 * shrinkMm } : shape.cutter
      const lift = shape.liftMm + (shape.cutter.kind === 'ball' ? shrinkMm : 0)
      const planar = to.x !== from.x || to.y !== from.y
      const drop = Math.abs(to.z - from.z)
      // A plunge (or a level move) keeps its own ends; float noise on a level
      // move is taken at the HIGHER end like any ramp.
      const pieces = !planar ? 1 : drop <= 1e-9 ? 1 : Math.min(MAX_PIECES_PER_MOVE, Math.ceil(drop / RAMP_PIECE_DROP_MM))
      for (let k = 0; k < pieces; k++) {
        const a = k === 0 ? from : lerp(from, to, k / pieces)
        const b = k === pieces - 1 ? to : lerp(from, to, (k + 1) / pieces)
        const z0 = planar ? Math.max(a.z, b.z) : a.z
        const z1 = planar ? z0 : b.z
        cuts.push({ cutter, move: { x0: a.x, y0: a.y, z0: z0 + lift, x1: b.x, y1: b.y, z1: z1 + lift } })
        yield
      }
    }
    let tip: Vec3 | undefined
    for (const raw of moves) {
      if (raw.a !== undefined || raw.b !== undefined || raw.c !== undefined) throw new Error('a rotary endpoint')
      const move = { ...raw, ...mapPoint(ingress, pointMm(frame, raw)).value }
      if (tip && isStockCuttingRole(effectiveMoveRole(move))) {
        if (move.type === 'arc_cw' || move.type === 'arc_ccw') {
          const chords = arcChords(tip, move, radius)
          for (let k = 1; chords && k < chords.points.length; k++) yield* sweep(chords.points[k - 1], chords.points[k], chords.sagittaMm)
        } else {
          yield* sweep(tip, move, 0)
        }
      }
      tip = { x: move.x, y: move.y, z: move.z }
      yield
    }
    result = Object.freeze(cuts)
  } catch (error) {
    result = `Material removal of ${error instanceof Error ? error.message : String(error)} is not supported.`
  }
  return result
}

function lerp(a: Vec3, b: Vec3, t: number): Vec3 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t }
}

/** Chord points along an arc/helix and the largest distance (mm) any chord
 * strays from it, or undefined when the arc cannot be enclosed by a cutter at
 * least half the real radius (it then removes nothing). */
function arcChords(start: Vec3, move: ToolpathMove, cutterRadius: number): { points: Vec3[]; sagittaMm: number } | undefined {
  const { cx, cy } = move
  if (cx === undefined || cy === undefined || !Number.isFinite(cx) || !Number.isFinite(cy)) return undefined
  if (start.x === move.x && start.y === move.y) return undefined
  const r0 = Math.hypot(start.x - cx, start.y - cy)
  const r1 = Math.hypot(move.x - cx, move.y - cy)
  const rMax = Math.max(r0, r1)
  if (!(Math.min(r0, r1) > 0) || !Number.isFinite(rMax)) return undefined
  const a0 = Math.atan2(start.y - cy, start.x - cx)
  let span = Math.atan2(move.y - cy, move.x - cx) - a0
  if (move.type === 'arc_ccw') { while (span <= 0) span += 2 * Math.PI } else { while (span >= 0) span -= 2 * Math.PI }
  const tolerance = Math.min(ARC_CHORD_SAGITTA_MM, cutterRadius / 10)
  const halfStep = tolerance < rMax ? Math.acos(1 - tolerance / rMax) : Math.PI / 2
  const count = Math.min(MAX_PIECES_PER_MOVE, Math.max(1, Math.ceil(Math.abs(span) / (2 * halfStep))))
  // The chord sagitta, plus any start/end radius mismatch: the interpolated
  // spiral is within that of every reading of the arc's radius.
  const sagittaMm = rMax * (1 - Math.cos(Math.abs(span) / (2 * count))) + Math.abs(r1 - r0)
  if (!(sagittaMm < cutterRadius / 2)) return undefined
  const points: Vec3[] = [start]
  for (let k = 1; k < count; k++) {
    const t = k / count, angle = a0 + span * t, r = r0 + (r1 - r0) * t
    points.push({ x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle), z: start.z + (move.z - start.z) * t })
  }
  points.push({ x: move.x, y: move.y, z: move.z })
  return { points, sagittaMm }
}

