// INT-17A-R2: a minimal in-memory IndexedDB good enough to drive the REAL
// src/lib/modelBodyDisplayCache.ts under vitest's node environment.
//
// WHY NOT A vi.mock. The R1 round stood the cache on a `vi.mock` of its own
// module, which is exactly why the audit could say the cache "accepts a display
// for any ModelBodyRef version" - the mock had no version logic, so no test ever
// exercised the module's own accept rule. A cure whose only test replaces the
// module under test proves nothing. This fake replaces the IDB PRIMITIVE
// instead, so the cache's record envelope, version validation, bound and prune
// all run for real.
//
// Scope is deliberately the surface modelBodyDisplayCache uses and no more:
// open/onupgradeneeded, createObjectStore, transaction(readwrite|readonly),
// put/get/delete/getAll/getAllKeys, and tx.oncomplete/onerror. Anything else
// throws by name rather than silently returning undefined - an unimplemented
// primitive must not read as an empty cache.

type Handler = ((ev?: unknown) => void) | null

/** Shared, LATCHING delete-failure injection (INT-17A-R3 C3).
 *
 *  Deliberately NOT a per-transaction flag like failNextWrite. The whole point
 *  of the C3 injector is to fail whichever transaction performs the EVICTION,
 *  and the number of readwrite transactions between the caller's request and
 *  that eviction is exactly the thing under test - it is 2 before the cure and
 *  1 after. A per-transaction flag would be silently consumed by the payload
 *  write and the test would pass vacuously (it did, on the first RED run).
 *  A latch stays armed until a delete actually consumes it. */
const deleteFailLatch = { armed: false }

class FakeRequest<T> {
  onsuccess: Handler = null
  onerror: Handler = null
  onupgradeneeded: Handler = null
  result!: T
  error: unknown = null
  /** Settle SYNCHRONOUSLY inside the transaction's enqueued microtask.
   *
   *  INT-17A-R3 C3: this used to wrap the handler in a SECOND queueMicrotask,
   *  which broke the one IDB rule the atomic write path depends on - a request
   *  issued from inside a success handler must keep the transaction alive.
   *  With the extra hop the handler ran after `pending` had already fallen to
   *  zero, so `oncomplete` fired before those follow-on requests were enqueued
   *  and the transaction "completed" without them. Settling synchronously puts
   *  the handler back inside the pending accounting (FakeTransaction.enqueue
   *  increments for the new request before decrementing for this one), which is
   *  exactly the liveness real IndexedDB gives. */
  settle(value: T): void {
    this.result = value
    this.onsuccess?.()
  }
  fail(err: unknown): void {
    queueMicrotask(() => {
      this.error = err
      this.onerror?.()
    })
  }
}

class FakeObjectStore {
  private readonly data: Map<string, unknown>
  private readonly tx: FakeTransaction
  constructor(data: Map<string, unknown>, tx: FakeTransaction) {
    this.data = data
    this.tx = tx
  }

  put(value: unknown, key: string): FakeRequest<void> {
    const req = new FakeRequest<void>()
    this.tx.enqueue(() => {
      if (this.tx.failNextWrite) {
        this.tx.failNextWrite = false
        const err = new Error('QuotaExceededError (fake)')
        this.tx.abortWith(err)
        req.fail(err)
        return
      }
      this.data.set(key, value)
      req.settle(undefined)
    })
    return req
  }

  get(key: string): FakeRequest<unknown> {
    const req = new FakeRequest<unknown>()
    this.tx.enqueue(() => req.settle(this.data.get(key)))
    return req
  }

  delete(key: string): FakeRequest<void> {
    const req = new FakeRequest<void>()
    this.tx.enqueue(() => {
      // INT-17A-R3 C3: the eviction half must be failable on its own. A quota
      // rejection is not the only way bound enforcement dies; a delete that
      // errors mid-eviction is the case that decides whether the store can be
      // left committed OVER the advertised cap.
      if (deleteFailLatch.armed) {
        deleteFailLatch.armed = false
        const err = new Error('UnknownError: delete failed (fake)')
        this.tx.abortWith(err)
        req.fail(err)
        return
      }
      this.data.delete(key)
      req.settle(undefined)
    })
    return req
  }

  getAll(): FakeRequest<unknown[]> {
    const req = new FakeRequest<unknown[]>()
    this.tx.enqueue(() => req.settle([...this.data.values()]))
    return req
  }

  getAllKeys(): FakeRequest<string[]> {
    const req = new FakeRequest<string[]>()
    this.tx.enqueue(() => req.settle([...this.data.keys()]))
    return req
  }

  clear(): FakeRequest<void> {
    const req = new FakeRequest<void>()
    this.tx.enqueue(() => { this.data.clear(); req.settle(undefined) })
    return req
  }
}

class FakeTransaction {
  oncomplete: Handler = null
  onerror: Handler = null
  error: unknown = null
  failNextWrite = false
  private pending = 0
  private aborted = false

  private readonly db: FakeDB
  private readonly storeNames: string[]
  private readonly mode: 'readonly' | 'readwrite'
  /** Pre-transaction contents, for ROLLBACK on abort (INT-17A-R3 C3).
   *
   *  The fake used to mutate the live map directly and never undo it, so an
   *  aborted transaction left its partial writes committed - the single
   *  behaviour a test about ATOMIC bound enforcement most needs to observe. It
   *  would have reported the cured, one-transaction cache as still leaking.
   *  Real IndexedDB rolls an aborted transaction back in full; so does this now.
   *  Taken lazily on first objectStore() and only for readwrite, so read paths
   *  pay nothing. */
  private readonly snapshots = new Map<string, Map<string, unknown>>()

  constructor(db: FakeDB, storeName: string | string[], mode: 'readonly' | 'readwrite') {
    this.db = db
    this.storeNames = Array.isArray(storeName) ? storeName : [storeName]
    this.mode = mode
  }

  objectStore(name: string): FakeObjectStore {
    if (!this.storeNames.includes(name)) {
      throw new Error(`fakeIndexedDB: transaction was opened on "${this.storeNames.join(',')}", not "${name}"`)
    }
    const data = this.db.stores.get(name)
    if (!data) throw new Error(`fakeIndexedDB: no object store "${name}"`)
    if (this.mode === 'readwrite' && !this.snapshots.has(name)) {
      this.snapshots.set(name, new Map(data))
    }
    return new FakeObjectStore(data, this)
  }

  enqueue(work: () => void): void {
    this.pending++
    queueMicrotask(() => {
      if (!this.aborted) work()
      this.pending--
      if (this.pending === 0 && !this.aborted) queueMicrotask(() => this.oncomplete?.())
    })
  }

  abortWith(err: unknown): void {
    this.aborted = true
    this.error = err
    // Roll back every write this transaction made, exactly as an aborted IDB
    // transaction does. Without this an abort is indistinguishable from a
    // commit, and no test could tell an atomic write path from a leaky one.
    for (const [storeName, snapshot] of this.snapshots) {
      const data = this.db.stores.get(storeName)
      if (!data) continue
      data.clear()
      for (const [k, v] of snapshot) data.set(k, v)
    }
    queueMicrotask(() => this.onerror?.())
  }
}

class FakeDB {
  readonly stores = new Map<string, Map<string, unknown>>()
  version = 0
  get objectStoreNames() {
    return { contains: (n: string) => this.stores.has(n) }
  }
  createObjectStore(name: string): void {
    if (!this.stores.has(name)) this.stores.set(name, new Map())
  }
  transaction(name: string | string[], mode: 'readonly' | 'readwrite'): FakeTransaction {
    return new FakeTransaction(this, name, mode)
  }
  close(): void { /* no-op: the fake keeps one handle per db name */ }
}

export interface FakeIndexedDBHandle {
  /** Raw stored records, so a test can assert on what the cache actually wrote. */
  records(dbName: string, storeName: string): Map<string, unknown>
  /** Write a raw record WITHOUT going through the module under test - the only
   *  way to plant a record in a shape the current module would never write
   *  (e.g. a legacy row left behind by an earlier release). */
  seed(dbName: string, storeName: string, key: string, value: unknown): void
  /** Make the NEXT put in the next transaction fail like a quota rejection. */
  failNextWrite(): void
  /** Make the NEXT delete in the next readwrite transaction fail. This is the
   *  bound-ENFORCEMENT failure injector (INT-17A-R3 C3): it decides whether a
   *  failed eviction can leave the store committed over its advertised cap. */
  failNextDelete(): void
  /** How many times openDB() actually opened a database. */
  openCount(): number
  restore(): void
}

/**
 * Install the fake on globalThis.indexedDB. Returns a handle for inspection and
 * an explicit `restore`; call it in afterEach so suites cannot leak into
 * each other.
 */
export function installFakeIndexedDB(): FakeIndexedDBHandle {
  const dbs = new Map<string, FakeDB>()
  let opens = 0
  let failNext = false
  deleteFailLatch.armed = false

  const fake = {
    open(name: string, version: number) {
      opens++
      const req = new FakeRequest<FakeDB>()
      queueMicrotask(() => {
        let db = dbs.get(name)
        const isNew = db === undefined
        if (!db) { db = new FakeDB(); dbs.set(name, db) }
        if (isNew || version > db.version) {
          db.version = version
          req.result = db
          req.onupgradeneeded?.()
        }
        req.result = db
        req.onsuccess?.()
      })
      return req
    },
  }

  // Patch put-failure injection in: the transaction reads the flag at creation.
  const origTransaction = FakeDB.prototype.transaction
  FakeDB.prototype.transaction = function (this: FakeDB, name: string | string[], mode: 'readonly' | 'readwrite') {
    const tx = origTransaction.call(this, name, mode)
    if (failNext && mode === 'readwrite') { tx.failNextWrite = true; failNext = false }
    return tx
  }

  const prior = (globalThis as { indexedDB?: unknown }).indexedDB
  ;(globalThis as { indexedDB?: unknown }).indexedDB = fake

  return {
    records(dbName, storeName) {
      return dbs.get(dbName)?.stores.get(storeName) ?? new Map()
    },
    seed(dbName, storeName, key, value) {
      let db = dbs.get(dbName)
      if (!db) { db = new FakeDB(); dbs.set(dbName, db) }
      db.createObjectStore(storeName)
      db.stores.get(storeName)!.set(key, value)
    },
    failNextWrite() { failNext = true },
    failNextDelete() { deleteFailLatch.armed = true },
    openCount() { return opens },
    restore() {
      deleteFailLatch.armed = false
      FakeDB.prototype.transaction = origTransaction
      ;(globalThis as { indexedDB?: unknown }).indexedDB = prior
    },
  }
}
