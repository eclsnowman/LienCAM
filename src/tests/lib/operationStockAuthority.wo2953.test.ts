import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OperationStockAuthority, type OperationStockBackend, type OperationStockInputs,
  type StockBeforeRequest, type StockOperationInput, type StockRead, type StockToken } from '../../lib/cam/operationStockAuthority'
import { applyConservativeStockOperation, createConservativeStockColumns, type ConservativeStockColumns } from '../../lib/cam/stockState'
import { frameRef } from '../../lib/geometry/coordinateFrames'

const frame = frameRef({ kind: 'world', projectEpoch: 'session-1', entityId: 'world', revision: 'pose-1' })
const bounds = { minX: 0, minY: 0, minZ: 0, maxX: 10, maxY: 10, maxZ: 20 }
const request: StockBeforeRequest = { beforeOperationId: 'target', frame, maxCellMm: 1 }
function operation(id = 'A', z = 18): StockOperationInput {
  return { id, enabled: true, stockId: 'stock', inputRevision: 'inputs-1', toolRevision: 'tool-1',
    removal: { status: 'ready', resultRevision: `result-${z}`, inputRevision: 'inputs-1', toolRevision: 'tool-1', frame,
      cuts: [{ move: { x0: -20, y0: 5, z0: z, x1: 30, y1: 5, z1: z }, cutter: { kind: 'flat', diameter: 50 } }] } }
}
function inputs(): OperationStockInputs {
  return { projectEpoch: 'session-1', changeRevision: 1, setupId: 'setup', stockId: 'stock', frame,
    initial: { revision: 'stock-1', bounds, resolutionMm: 1, maxColumns: 1000 },
    operations: [operation(), operation('target', 0), operation('later', -1)] }
}
const backend = (): OperationStockBackend => ({
  create: vi.fn(i => createConservativeStockColumns(i.bounds, i.resolutionMm, i.maxColumns)),
  apply: vi.fn(applyConservativeStockOperation),
})
function fixture() {
  let latest = inputs()
  const engine = backend()
  const authority = new OperationStockAuthority(() => latest, engine)
  return { authority, engine, get latest() { return latest },
    set(next: Partial<OperationStockInputs>) { latest = { ...latest, ...next, changeRevision: latest.changeRevision + 1 } },
    raw(next: OperationStockInputs) { latest = next } }
}
// WO-3126: settlement leaves a 16 ms renderer frame around every backend step.
// Timers are fake here, so each settle round lets one frame pass.
async function settle(authority: OperationStockAuthority, req = request): Promise<StockRead> {
  let read = authority.readBefore(req)
  for (let i = 0; i < 30 && read.status === 'recomputing'; i++) {
    await vi.advanceTimersByTimeAsync(20)
    read = authority.readBefore(req)
  }
  return read
}
function token(read: StockRead): StockToken { expect(read.status).toBe('ready'); return read.token }
function top(authority: OperationStockAuthority, read: StockRead): number {
  const result = authority.query(token(read), { kind: 'highest-material', frame: read.token.request.frame, bounds })
  expect(result.status).toBe('ready')
  return result.status === 'ready' ? result.value as number : NaN
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

describe('WO-2953 enabled operation stock authority', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }) })
  afterEach(() => { vi.useRealTimers() })

  it('subtracts enabled predecessors only; suppress and unsuppress recalculate automatically', async () => {
    const f = fixture()
    const first = await settle(f.authority)
    expect(top(f.authority, first)).toBeCloseTo(18, 9)
    f.set({ operations: [{ ...operation(), enabled: false }, operation('target', 0)] })
    expect(f.authority.query(first.token, { kind: 'highest-material', frame, bounds }).status).toBe('unavailable')
    expect(top(f.authority, await settle(f.authority))).toBe(20)
    f.set({ operations: [operation(), operation('target', 0)] })
    expect(top(f.authority, await settle(f.authority))).toBeCloseTo(18, 9)
    expect(f.engine.apply).toHaveBeenCalledTimes(1) // same verified prefix reused
  })

  it('reuses unchanged reads and prefixes, excluding target and later operation edits', async () => {
    const f = fixture()
    const first = await settle(f.authority)
    expect(f.authority.readBefore(request)).toBe(first)
    expect(f.engine.create).toHaveBeenCalledTimes(1)
    f.set({ operations: [operation(), operation('target', 6), operation('later', 8)] })
    const second = await settle(f.authority)
    expect(top(f.authority, second)).toBeCloseTo(18, 9)
    expect(second.status === 'ready' && first.status === 'ready' && second.snapshotId).toBe(first.status === 'ready' && first.snapshotId)
    expect(f.engine.apply).toHaveBeenCalledTimes(1)
    // Global semantic revision deliberately renews tokens, but not stock replay.
    expect(f.authority.isCurrent(first.token)).toBe(false)
  })

  it('handles deletion, insertion, reorder and missing target without a partial-ready prefix', async () => {
    const f = fixture()
    await settle(f.authority)
    f.set({ operations: [operation('target')] })
    expect(top(f.authority, await settle(f.authority))).toBe(20)
    const missing: StockOperationInput = { ...operation('B'), removal: { status: 'missing' } }
    f.set({ operations: [operation(), missing, operation('target')] })
    expect(f.authority.readBefore(request)).toMatchObject({ status: 'recomputing', waitingFor: ['B'] })
    f.set({ operations: [operation('target'), missing, operation()] })
    expect(top(f.authority, await settle(f.authority))).toBe(20)
    f.set({ operations: [operation()] })
    expect(f.authority.readBefore(request)).toMatchObject({ status: 'unavailable', operationId: 'target' })
  })

  it('reuses the unchanged prefix when a suffix is edited or recomputing', async () => {
    const f = fixture()
    f.set({ operations: [operation('A', 18), operation('B', 17), operation('target')] })
    const first = await settle(f.authority)
    expect(f.engine.apply).toHaveBeenCalledTimes(2)
    f.set({ operations: [operation('A', 18), { ...operation('B', 17), removal: { status: 'computing' } }, operation('target')] })
    expect(f.authority.isCurrent(first.token)).toBe(false)
    expect(f.authority.readBefore(request)).toMatchObject({ status: 'recomputing', waitingFor: ['B'] })
    f.set({ operations: [operation('A', 18), operation('B', 16), operation('target')] })
    expect(top(f.authority, await settle(f.authority))).toBeCloseTo(16, 9)
    expect(f.engine.apply).toHaveBeenCalledTimes(3)
    expect(f.engine.create).toHaveBeenCalledTimes(1)
  })

  it('honors ordered identity even when the final material is equal', async () => {
    const f = fixture()
    f.set({ operations: [operation('A', 18), operation('B', 17), operation('target')] })
    const first = await settle(f.authority)
    f.set({ operations: [operation('B', 17), operation('A', 18), operation('target')] })
    const second = await settle(f.authority)
    expect(top(f.authority, second)).toBeCloseTo(17, 9)
    expect(first.token.key).not.toBe(second.token.key)
    expect(f.engine.apply).toHaveBeenCalledTimes(4)
  })

  it.each(['missing', 'computing', 'error', 'cancelled', 'unsupported'] as const)('does not treat %s removal as zero', async status => {
    const f = fixture()
    f.set({ operations: [operation(), { ...operation('B'), removal: { status, reason: 'specific reason' } }, operation('target')] })
    const read = await settle(f.authority)
    expect(read.status).toBe(status === 'missing' || status === 'computing' ? 'recomputing' : status === 'error' ? 'error' : 'unavailable')
    expect(f.authority.isCurrent(read.token)).toBe(false)
    expect(f.engine.apply).not.toHaveBeenCalled()
    f.set({ operations: [operation(), { ...operation('B'), enabled: false, removal: { status, reason: 'specific reason' } }, operation('target')] })
    expect(top(f.authority, await settle(f.authority))).toBeCloseTo(18, 9)
  })

  it('accepts explicitly verified no-removal and separates other-stock and unknown membership', async () => {
    const f = fixture()
    const a = operation()
    if (a.removal.status !== 'ready') throw new Error('fixture')
    const noCut = { ...a, removal: { ...a.removal, cuts: [] } }
    f.set({ operations: [noCut, { ...operation('foreign', 0), stockId: 'other' }, operation('target')] })
    expect(top(f.authority, await settle(f.authority))).toBe(20)
    f.set({ operations: [{ ...operation(), stockId: null }, operation('target')] })
    expect(f.authority.readBefore(request)).toMatchObject({ status: 'unavailable', operationId: 'A' })
  })

  it.each(['inputRevision', 'toolRevision'] as const)('refuses stale retained moves after %s changes', async field => {
    const f = fixture()
    const first = await settle(f.authority)
    f.set({ operations: [{ ...operation(), [field]: 'new' }, operation('target')] })
    expect(f.authority.isCurrent(first.token)).toBe(false)
    expect(f.authority.readBefore(request)).toMatchObject({ status: 'unavailable', reason: 'Predecessor result is stale.' })
  })

  it('notices equal-count in-place move edits synchronously even without a revision bump', async () => {
    const f = fixture()
    const first = await settle(f.authority)
    const op = f.latest.operations[0]
    if (op.removal.status !== 'ready') throw new Error('fixture')
    op.removal.cuts[0].move.z0 = 12
    op.removal.cuts[0].move.z1 = 12
    expect(f.authority.isCurrent(first.token)).toBe(false)
    expect(top(f.authority, await settle(f.authority))).toBeCloseTo(12, 9)
  })

  it('invalidates stock, setup and frame edits and enforces world/mm frame identity', async () => {
    const f = fixture()
    const first = await settle(f.authority)
    f.set({ initial: { ...f.latest.initial, bounds: { ...bounds, maxZ: 30 }, revision: 'new-stock' }, setupId: 'new-setup' })
    const second = await settle(f.authority)
    expect(f.engine.create).toHaveBeenCalledTimes(2)
    expect(f.authority.isCurrent(first.token)).toBe(false)
    expect(top(f.authority, second)).toBeCloseTo(18, 9)
    const newFrame = { ...frame, revision: 'pose-2' }
    f.set({ frame: newFrame })
    expect(f.authority.readBefore(request).status).toBe('unavailable')
    expect(f.authority.readBefore({ ...request, frame: newFrame })).toMatchObject({ status: 'unavailable', operationId: 'A' })
    expect(f.authority.query(second.token, { kind: 'highest-material', frame: newFrame, bounds }).status).toBe('unavailable')
  })

  it('requires requested fidelity and refuses a bound this backend cannot supply', async () => {
    const f = fixture()
    f.set({ initial: { ...f.latest.initial, resolutionMm: 0.01, maxColumns: 25 } })
    const coarse = await settle(f.authority)
    expect(coarse.status).toBe('unavailable')
    const permitted = await settle(f.authority, { ...request, maxCellMm: 3 })
    expect(permitted).toMatchObject({ status: 'ready', quality: { capability: 'full-cell-upper-envelope-v1', maxVerticalOverRetentionMm: null } })
    expect(f.authority.readBefore({ ...request, requireBoundedOverRetention: true }).status).toBe('unavailable')
  })

  it('notifies eager invalidation and settlement without semantic changes from UI reads', async () => {
    const f = fixture(), listener = vi.fn()
    const stop = f.authority.subscribe(listener)
    await settle(f.authority)
    const count = listener.mock.calls.length
    f.authority.reconcile()
    expect(listener).toHaveBeenCalledTimes(count)
    f.set({ operations: [{ ...operation(), enabled: false }, operation('target')] })
    f.authority.reconcile()
    expect(listener.mock.calls.length).toBeGreaterThan(count)
    await settle(f.authority)
    stop()
    const after = listener.mock.calls.length
    f.authority.disposeProject('session-1')
    expect(listener).toHaveBeenCalledTimes(after)
  })

  it('isolates backend-owned mutable data and does not expose snapshot arrays', async () => {
    let latest = inputs()
    const owned = { ...createConservativeStockColumns(bounds, 1), topZ: Array(100).fill(20) }
    const a = new OperationStockAuthority(() => latest, { create: () => owned, apply: s => s })
    latest = { ...latest, operations: [operation('target')] }
    const read = await settle(a)
    owned.topZ.fill(-100)
    expect(top(a, read)).toBe(20)
    expect('snapshot' in read).toBe(false)
    expect(Object.isFrozen(read.token.request.frame)).toBe(true)
    const alien = new OperationStockAuthority(() => latest)
    expect(alien.isCurrent(read.token)).toBe(false)
  })

  it.each(['success', 'error'] as const)('rejects a late %s after suppression without an explicit reconcile', async outcome => {
    let latest = inputs()
    const pending = deferred<ConservativeStockColumns>()
    const engine = backend()
    engine.apply = vi.fn(() => pending.promise)
    const a = new OperationStockAuthority(() => latest, engine)
    const old = a.readBefore(request)
    // Initial stock finishes; predecessor apply is pending.
    await vi.waitFor(() => expect(engine.apply).toHaveBeenCalledOnce())
    latest = { ...latest, changeRevision: 2, operations: [{ ...operation(), enabled: false }, operation('target')] }
    const removal = operation().removal
    if (removal.status !== 'ready') throw new Error('fixture')
    if (outcome === 'success') pending.resolve(applyConservativeStockOperation(createConservativeStockColumns(bounds, 1), removal.cuts))
    else pending.reject(new Error('old failure'))
    // Let settlement observe the new inputs itself, before any explicit read.
    await vi.advanceTimersByTimeAsync(20)
    const current = await settle(a)
    expect(top(a, current)).toBe(20)
    expect(a.isCurrent(old.token)).toBe(false)
    expect(current.status).toBe('ready')
  })

  it('rejects ABA and same-ID reload callbacks by semantic serial and epoch', async () => {
    let latest = inputs()
    const pending = deferred<ConservativeStockColumns>()
    const engine = backend()
    engine.apply = vi.fn().mockImplementationOnce(() => pending.promise).mockImplementation(applyConservativeStockOperation)
    const a = new OperationStockAuthority(() => latest, engine)
    const old = a.readBefore(request)
    await vi.waitFor(() => expect(engine.apply).toHaveBeenCalledOnce())
    // Unobserved edit-away/back must still advance the adapter's semantic serial.
    latest = { ...inputs(), changeRevision: 3 }
    const next = await settle(a)
    expect(top(a, next)).toBeCloseTo(18, 9)
    pending.reject(new Error('late ABA error'))
    await Promise.resolve()
    expect(a.readBefore(request)).toBe(next)
    expect(a.isCurrent(old.token)).toBe(false)
    a.disposeProject('session-1')
    expect(a.isCurrent(next.token)).toBe(false)
    expect(a.readBefore(request).status).toBe('unavailable')
    const newFrame = { ...frame, projectEpoch: 'session-2' }
    latest = { ...inputs(), projectEpoch: 'session-2', changeRevision: 1, frame: newFrame, operations: [operation('target')] }
    expect(top(a, await settle(a, { ...request, frame: newFrame }))).toBe(20)
  })

  it('keeps current backend errors non-ready, does not retry-loop, and recovers on valid inputs', async () => {
    const f = fixture()
    const apply = vi.mocked(f.engine.apply)
    apply.mockImplementationOnce(() => { throw new Error('backend failed') })
    expect(await settle(f.authority)).toMatchObject({ status: 'error', reason: 'Error: backend failed' })
    await settle(f.authority)
    expect(apply).toHaveBeenCalledTimes(1)
    f.set({ operations: [operation('A', 17), operation('target')] })
    expect(top(f.authority, await settle(f.authority))).toBeCloseTo(17, 9)
  })

  it('discards pending initial-stock acquisition after a same-ID project reload', async () => {
    let latest = inputs()
    const pending = deferred<ConservativeStockColumns>()
    const engine = backend()
    vi.mocked(engine.create).mockImplementationOnce(() => pending.promise)
    const a = new OperationStockAuthority(() => latest, engine)
    const old = a.readBefore(request)
    await vi.waitFor(() => expect(engine.create).toHaveBeenCalledOnce())
    a.disposeProject('session-1')
    const newFrame = { ...frame, projectEpoch: 'reopened' }
    latest = { ...inputs(), frame: newFrame, projectEpoch: 'reopened', operations: [operation('target')] }
    const current = await settle(a, { ...request, frame: newFrame })
    pending.resolve(createConservativeStockColumns(bounds, 1))
    await Promise.resolve()
    expect(a.isCurrent(old.token)).toBe(false)
    expect(top(a, current)).toBe(20)
    expect(a.readBefore({ ...request, frame: newFrame })).toBe(current)
  })

  it('rejects duplicate IDs, missing ownership, stale removal frame and unsupported geometry', async () => {
    const f = fixture()
    f.set({ operations: [operation(), operation(), operation('target')] })
    expect(f.authority.readBefore(request).status).toBe('unavailable')
    f.set({ operations: [operation(), { ...operation('target'), stockId: null }] })
    expect(f.authority.readBefore(request).status).toBe('unavailable')
    const op = operation()
    if (op.removal.status !== 'ready') throw new Error('fixture')
    f.set({ operations: [{ ...op, removal: { ...op.removal, frame: { ...frame, revision: 'old' } } }, operation('target')] })
    expect(f.authority.readBefore(request).status).toBe('unavailable')
    const cuts = [{ ...op.removal.cuts[0], move: { ...op.removal.cuts[0].move, z1: 17 } }]
    f.set({ operations: [{ ...op, removal: { ...op.removal, cuts } }, operation('target')] })
    expect(await settle(f.authority)).toMatchObject({ status: 'error', reason: expect.stringContaining('ramps') })
  })
})
