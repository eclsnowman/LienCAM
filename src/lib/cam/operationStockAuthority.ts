// WO-2953: operation service, not a kernel or a store singleton. The adapter
// supplies CURRENT world/mm inputs on every access, including async settlement.
import { frameRef, sameFrame, type FrameRef } from '../geometry/coordinateFrames'
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

type Captured = { key: string; baseKey: string; inputs: OperationStockInputs;
  predecessors: readonly StockOperationInput[]; problem?: { status: 'unavailable' | 'error' | 'recomputing'; reason: string; operationId?: string }
  /** Every enabled predecessor whose removal is missing or computing, in execution order. */
  waiting: readonly string[] }
type Entry = { token: StockToken; read: StockRead; snapshot?: ConservativeStockColumns }
type Cached = { snapshot: ConservativeStockColumns; id: number }
let nextAuthorityId = 0

// JSON is a lossless content key for this finite, data-only contract (not a
// result count, array identity, hash collision or caller-provided digest).
function capture(latest: OperationStockInputs, request: StockBeforeRequest): Captured {
  const inputs = structuredClone(latest)
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
  const baseKey = JSON.stringify([1, inputs.projectEpoch, inputs.setupId, inputs.stockId, inputs.frame, inputs.initial])
  const key = JSON.stringify([baseKey, inputs.changeRevision, request, relevant, problem])
  return { key, baseKey, inputs, predecessors: relevant, problem, waiting }
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
  constructor(getLatest: () => OperationStockInputs, backend: OperationStockBackend = defaultBackend) {
    this.getLatest = getLatest
    this.backend = backend
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  private notify(): void { for (const listener of this.listeners) listener() }
  private scope(request: StockBeforeRequest): string { return JSON.stringify(request) }

  readBefore(request: StockBeforeRequest): StockRead {
    const immutableRequest = Object.freeze({ ...request, frame: frameRef(request.frame) })
    const captured = capture(this.getLatest(), immutableRequest)
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
      const prefixParts = [captured.baseKey]
      let prefix = captured.baseKey
      let cached = this.cache.get(prefix)
      if (!cached) {
        const snapshot = await this.backend.create(captured.inputs.initial)
        if (!this.current(entry)) return
        cached = this.remember(prefix, snapshot)
      }
      for (const op of captured.predecessors) {
        const removal = op.removal
        if (removal.status !== 'ready') return // capture already rejects unknown removal
        prefixParts.push(JSON.stringify(op))
        prefix = JSON.stringify(prefixParts)
        let next = this.cache.get(prefix)
        if (!next) {
          const snapshot = await this.backend.apply(cached.snapshot, removal.cuts)
          if (!this.current(entry)) return
          next = this.remember(prefix, snapshot)
        }
        cached = next
      }
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
