import { operatorText } from '../i18n/locales/en/console-and-operator-messages'
// Durable cache for a modeled body's derived DISPLAY payload (INT-17A-R1 C1,
// version/bound/lifecycle hardening INT-17A-R2 C2).
//
// WHY THIS EXISTS (the B2a browser-refresh axis). A model-backed CAM entry draws
// from the tessellation persisted ON the entry. That payload rides the durable
// .camproject FILE, but it is STRIPPED from the localStorage rehydrate blob
// (persistPartialize) because dozens of bodies of tessellation would blow the
// ~5MB localStorage quota (browser headroom, D-014). Without a second durable
// home, a plain browser refresh landing in CAM with the Part tab never visited
// left every modeled card undrawable until the Model workspace mounted and
// re-derived - which is exactly the B2a invariant the entry is supposed to hold
// on its own.
//
// MECHANISM CHOICE. IndexedDB, not localStorage, because it is the SAME answer
// this codebase already reached for the same problem three times: stlCache.ts
// (mesh bytes), stepCache.ts (STEP bytes) and geometry2dCache.ts (projected
// loops) all keep heavy per-geometry payloads out of the ~5MB blob and re-load
// them during scene restore. restoreGeometryToViewport already awaits those
// caches in the very loop that draws each part, so the model branch loads from
// here in the same place, with NO Part-tab dependency and NO kernel call.
// localStorage keeps only the lightweight ref, so D-014 headroom is unchanged.
//
// Its own DB, mirroring stepCache's rationale: neither module then forces a
// version bump on the other (stlCache and geometry2dCache share a DB and must
// therefore create both stores in one onupgradeneeded - a coupling worth not
// joining).
//
// ─── R2: WHAT THE AUDIT FOUND, AND THE THREE RULES THAT ANSWER IT ────────────
//
// R1 stored a BARE ModelBodyDisplay under a BARE geometry id. Three consequences,
// all of them silent:
//
// 1. NOT VERSION-SAFE. ModelBodyRef.version is bumped on every re-derive, but
//    the record carried no version at all, so restoreScene patched whatever it
//    found onto whatever ref the entry currently held. A body re-derived while
//    the cache still held the previous tessellation restored the OLD SHAPE onto
//    the NEW ref - a wrong render with nothing to notice it by.
//    RULE: a record is a HIT only when projectId, geometryId, bodyId AND version
//    all match the caller's scope. Anything else is a MISS, and the stale record
//    is deleted on the way out rather than left to be re-rejected forever.
//    A miss is recoverable by construction (the Part workspace re-derives), so
//    this is refuse-and-recover, not refuse-and-fail.
//
// 2. NOT PROJECT-SCOPED. Entry ids are `modelbody:<bodyId>` and bodyIds restart
//    at F1 in every project, so project B could restore project A's tessellation.
//    RULE: the key is `<projectId> <geometryId>`, and projectId is re-checked on
//    read (a key collision must not be the only thing standing between two
//    projects' geometry).
//
// 3. NOT BOUNDED. Eviction happened only when a body was deleted in the open
//    project, so a long-lived browser profile accumulated every body of every
//    project it ever opened.
//    RULE: two explicit caps, enforced on every write, oldest-written first.
//    D-014(b) is the governing constraint - "explicit caps with loud coarsening
//    for anything unbounded" - and it is a MEMORY budget, so the primary cap is
//    BYTES; the entry cap is the cheap secondary that keeps the index itself
//    small. See the constants for the sizing argument.
//    Plus pruneModelBodyDisplayCache() at the project lifecycle boundary
//    (newProject / loadProjectFromFile), which is where this codebase already
//    flushes its other IDB cache: SolidsWorkbenchPage's doc-close effect flushes
//    pendingImportCacheEvictionRef into removeCachedStep (WO INT-6A-R1). Same
//    shape: reclaim at the close of the document that owned the bytes.
//
// The caps are LRW (least-recently-WRITTEN), not true LRU. Refreshing a record's
// recency on every read would turn each cache lookup into a readwrite
// transaction on the scene-restore hot path, which costs more than the eviction
// accuracy is worth here: a body that is read is a body of the OPEN project,
// and the project prune already protects the open project's whole working set.
// Named for what it is rather than labelled LRU.

import type { ModelBodyDisplay } from '../types'

export const MODEL_BODY_DISPLAY_CACHE_DB = 'lien-cam-model-body-cache'
export const MODEL_BODY_DISPLAY_CACHE_STORE = 'model-body-display'
const VERSION = 2   // v2 (INT-17A-R2): scoped, versioned record envelope

/** Record envelope schema. A record written by a different schema is a MISS -
 *  never coerced, never crashed on. Bumped when the envelope shape changes. */
const RECORD_SCHEMA = 2

/**
 * BYTE budget (primary cap). D-014(b) requires explicit caps on anything
 * unbounded, and this is a memory-shaped resource, so it is capped in bytes
 * rather than only in rows.
 *
 * SIZING. A ModelBodyDisplay is plain number arrays; structured-clone stores
 * each as a float, so ~8 bytes per element is the honest per-element figure.
 * A typical Stage 1 body (the INT-17A perf fixture is 600 triangles) is on the
 * order of 100 KB; a heavy imported solid runs to a few MB. 64 MB therefore
 * holds hundreds of ordinary bodies or a couple of dozen heavy ones - a
 * comfortable multiple of any single project's working set, which is what the
 * cache actually needs to cover, while staying far below a browser origin quota
 * (typically hundreds of MB to GB). It is deliberately NOT sized to "every
 * project you ever opened": that is the growth the audit flagged, and the
 * project prune is what handles it.
 */
export const MODEL_BODY_DISPLAY_CACHE_MAX_BYTES = 64 * 1024 * 1024

/** ENTRY budget (secondary cap). Bounds the index scan and the eviction sort
 *  independently of payload size, so a pathological many-tiny-bodies project
 *  cannot make every write walk an unbounded key list. 512 is >> the body count
 *  of any project Stage 1 supports. */
export const MODEL_BODY_DISPLAY_CACHE_MAX_ENTRIES = 512

/** Identity a cached display is valid FOR. Every field is checked on read: the
 *  key alone is not allowed to be the thing that keeps two projects apart. */
export interface ModelBodyDisplayScope {
  /** Project.id of the project that owns the entry. */
  projectId: string
  /** CAM geometry entry id (`modelbody:<bodyId>`). */
  geometryId: string
  /** ModelBodyRef.bodyId the display was tessellated from. */
  bodyId: string
  /** ModelBodyRef.version the display was tessellated at. */
  version: number
}

interface CachedRecord extends ModelBodyDisplayScope {
  schema: number
  /** Write recency, for the LRW eviction order. */
  savedAt: number
  /** Estimated structured-clone footprint; stored so the bound check does not
   *  re-walk every payload on every write. */
  bytes: number
  display: ModelBodyDisplay
}

/** Records are keyed by project AND entry. A space separator is safe because
 *  neither a uuid projectId nor a `modelbody:<id>` entry id contains one.
 *
 *  Exported so a test asserts on keys through the SAME builder the module uses,
 *  rather than re-typing the separator - a re-typed key is a second source of
 *  truth, and one that fails in whichever direction hides the bug. */
export function modelBodyCacheKey(projectId: string, geometryId: string): string {
  return `${projectId} ${geometryId}`
}
const keyOf = modelBodyCacheKey

/** Honest estimate of a display's structured-clone footprint: ~8 bytes per
 *  numeric element plus a small constant for the bbox and envelope fields. */
export function estimateDisplayBytes(display: ModelBodyDisplay): number {
  const elements =
    display.positions.length + display.normals.length + display.indices.length +
    display.edgePositions.length + display.edgeOffsets.length
  return elements * 8 + 256
}

/**
 * PURE eviction policy: which keys must go for the index to satisfy both caps.
 *
 * Exported and pure so the BYTE cap is testable without allocating 64 MB of
 * fixture - the ENTRY cap is what the end-to-end write-path test drives, which
 * is what proves the policy is actually wired in.
 *
 * Oldest `savedAt` first. Ties break on key so the order is deterministic.
 */
export function selectModelBodyCacheEvictions(
  index: ReadonlyArray<{ key: string; savedAt: number; bytes: number }>,
  caps: { maxEntries: number; maxBytes: number },
): string[] {
  const oldestFirst = [...index].sort((a, b) =>
    a.savedAt !== b.savedAt ? a.savedAt - b.savedAt : a.key < b.key ? -1 : 1)
  let entries = oldestFirst.length
  let bytes = oldestFirst.reduce((sum, r) => sum + r.bytes, 0)
  const evict: string[] = []
  for (const record of oldestFirst) {
    if (entries <= caps.maxEntries && bytes <= caps.maxBytes) break
    evict.push(record.key)
    entries--
    bytes -= record.bytes
  }
  return evict
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(MODEL_BODY_DISPLAY_CACHE_DB, VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(MODEL_BODY_DISPLAY_CACHE_STORE)) {
        db.createObjectStore(MODEL_BODY_DISPLAY_CACHE_STORE)
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

/** Run `work` inside one transaction and settle on the transaction, not on the
 *  individual requests - a put that "succeeded" in an aborted transaction did
 *  not persist, and resolving on it is how a caller comes to believe a payload
 *  is recoverable when it is not (the quota case the audit named). */
function withStore<T>(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore, done: (value: T) => void) => void,
): Promise<T> {
  return openDB().then((db) => new Promise<T>((resolve, reject) => {
    const tx = db.transaction(MODEL_BODY_DISPLAY_CACHE_STORE, mode)
    let result: T
    work(tx.objectStore(MODEL_BODY_DISPLAY_CACHE_STORE), (value) => { result = value })
    tx.oncomplete = () => resolve(result)
    tx.onerror = () => reject(tx.error)
  }))
}

/** One row of the store, classified. `record` is null for a row this schema does
 *  not own - an R1-era bare display, or anything a future/older build wrote.
 *  Those rows are NOT skipped: skipping them is how they become the unbounded
 *  growth the audit flagged, since nothing else would ever delete them. */
interface IndexRow {
  key: string
  record: CachedRecord | null
}

function readIndex(store: IDBObjectStore, done: (v: IndexRow[]) => void): void {
  const keys = store.getAllKeys()
  const values = store.getAll()
  values.onsuccess = () => {
    const keyList = (keys.result ?? []) as string[]
    const rows: IndexRow[] = ((values.result ?? []) as unknown[]).map((v, i) => {
      const r = v as CachedRecord | undefined
      return {
        key: keyList[i],
        record: r && r.schema === RECORD_SCHEMA ? r : null,
      }
    })
    done(rows)
  }
}

function loadIndex(): Promise<IndexRow[]> {
  return withStore<IndexRow[]>('readonly', (store, done) => readIndex(store, done))
}

/**
 * Store a display, scoped to the project/body/version it was derived from,
 * enforcing both caps IN THE SAME TRANSACTION as the write.
 *
 * ─── INT-17A-R3 C3: WHY ONE TRANSACTION ─────────────────────────────────────
 *
 * R2 committed the payload in one transaction and evicted in a second, on the
 * reasoning that "a bound failure can never roll back the payload the caller
 * just asked us to keep". The round-3 audit was right that this has it exactly
 * backwards. The caps are the ADVERTISED CONTRACT of this module - 64 MB and
 * 512 entries, cited in the constants above as the D-014(b) answer to unbounded
 * growth - and the payload is the discretionary part: a miss is recoverable by
 * construction, because the Part workspace re-derives. So when the two cannot
 * both hold, the BOUND wins and the payload goes, not the other way round.
 *
 * The two-transaction shape made that unenforceable. Between the commit and the
 * eviction there is a window in which the store is legitimately over cap, and
 * an enforcement failure, a page unload, or a rejected fire-and-forget batch
 * (the production call site launches writes without awaiting them and swallows
 * rejections, src/store/index.ts:3728) left it that way PERMANENTLY - nothing
 * re-runs enforcement for a record already in. The RED repro pins the number:
 * seeded at the 512 cap with the eviction forced to fail, the store committed
 * 513 rows.
 *
 * Putting the put and its evictions in one readwrite transaction makes the
 * failure mode atomic instead. If any eviction fails the transaction aborts,
 * the put rolls back with it, and this function REJECTS - loudly, per the
 * contract below. The store is never left committed over the cap by any path.
 *
 * Rejects (never silently resolves) when the transaction aborts - the call
 * site's fire-and-forget contract is the CALLER's choice, not something this
 * module should decide on its behalf.
 */
export async function cacheModelBodyDisplay(
  scope: ModelBodyDisplayScope,
  display: ModelBodyDisplay,
): Promise<void> {
  const record: CachedRecord = {
    schema: RECORD_SCHEMA,
    projectId: scope.projectId,
    geometryId: scope.geometryId,
    bodyId: scope.bodyId,
    version: scope.version,
    savedAt: Date.now(),
    bytes: estimateDisplayBytes(display),
    display,
  }
  await withStore<void>('readwrite', (store) => {
    store.put(record, keyOf(scope.projectId, scope.geometryId))
    // Read the index INSIDE this transaction and AFTER the put. IDB executes a
    // transaction's requests in order, so this index INCLUDES the record just
    // written - which is the whole point: the bound is evaluated against the
    // state that is about to be committed, not the state before it.
    //
    // Issuing these requests from within the transaction is also what keeps it
    // alive; a transaction stays open as long as its success handlers keep
    // queueing work.
    readIndex(store, (rows) => {
      // Unrecognised rows are DELETED here rather than merely counted. This is
      // the other half of the audit's C3: an R1-era or foreign-schema row is a
      // permanent MISS for this build (readIndex classifies it null, and the
      // read path re-rejects it forever), but R2 assigned it bytes=0, so the
      // BYTE cap - the primary cap - could not bound it at all. Anything the
      // byte policy cannot measure, it cannot bound, so the honest move is to
      // reclaim it. Safe by construction: openDB pins VERSION, so a newer
      // build's rows are unreachable from here (its higher version would fail
      // the open), and every row this build can actually use is schema-matched.
      for (const row of rows) if (row.record === null) store.delete(row.key)

      const index = rows
        .filter((row) => row.record !== null)
        .map((row) => ({ key: row.key, savedAt: row.record!.savedAt, bytes: row.record!.bytes }))
      const evict = selectModelBodyCacheEvictions(index, {
        maxEntries: MODEL_BODY_DISPLAY_CACHE_MAX_ENTRIES,
        maxBytes: MODEL_BODY_DISPLAY_CACHE_MAX_BYTES,
      })
      if (evict.length === 0) return
      // Named, not silent: D-014 calls for "loud coarsening", and a cache that
      // quietly drops a payload looks identical to one that never had it.
      //
      // Note the record just written is the NEWEST, so LRW evicts it LAST - it
      // is dropped only when it alone cannot fit the byte cap, which is the
      // correct outcome for an oversized payload and is still bounded rather
      // than committed over budget.
      console.info(
        operatorText('modelBodyDisplayCache1', { value1: String(evict.length), value2: String(evict.length === 1 ? operatorText('modelBodyDisplayCache2') : operatorText('modelBodyDisplayCache3')), value3: String(MODEL_BODY_DISPLAY_CACHE_MAX_ENTRIES), value4: String(Math.round(MODEL_BODY_DISPLAY_CACHE_MAX_BYTES / 1024 / 1024)) }),
      )
      for (const key of evict) store.delete(key)
    })
  })
}

/**
 * Load a display ONLY if the stored record was derived from exactly this
 * project, entry, body and ref version. Anything else is a miss, and the stale
 * record is deleted so it cannot accumulate.
 */
export async function loadCachedModelBodyDisplay(
  scope: ModelBodyDisplayScope,
): Promise<ModelBodyDisplay | null> {
  const key = keyOf(scope.projectId, scope.geometryId)
  const record = await withStore<CachedRecord | undefined>('readonly', (store, done) => {
    const req = store.get(key)
    req.onsuccess = () => done(req.result as CachedRecord | undefined)
  })
  if (!record) return null

  // Every field is re-checked. schema first: an R1-era bare ModelBodyDisplay has
  // no schema at all, and reading its (absent) fields must be a clean miss.
  const fresh = record.schema === RECORD_SCHEMA
    && record.projectId === scope.projectId
    && record.geometryId === scope.geometryId
    && record.bodyId === scope.bodyId
    && record.version === scope.version
  if (fresh) return record.display

  console.warn(
    operatorText('modelBodyDisplayCache4', { value1: String(scope.geometryId), value2: String(String(record.schema)), value3: String(String(record.bodyId)), value4: String(String(record.version)), value5: String(RECORD_SCHEMA), value6: String(scope.bodyId), value7: String(scope.version) }),
  )
  await withStore<void>('readwrite', (store) => { store.delete(key) }).catch(() => {})
  return null
}

/** Drop one entry's cached display. Project-scoped: deleting a body in one
 *  project must not evict the identically-named body in another. */
export async function removeCachedModelBodyDisplay(
  projectId: string,
  geometryId: string,
): Promise<void> {
  await withStore<void>('readwrite', (store) => {
    store.delete(keyOf(projectId, geometryId))
  })
}

/**
 * PROJECT LIFECYCLE cleanup: keep only records belonging to `projectId` whose
 * entry id is in `keepGeometryIds`; drop everything else, including every record
 * left behind by a project that is no longer open.
 *
 * Called where the CAM store swaps documents (newProject, loadProjectFromFile) -
 * the same "close of the document that owned the bytes" point SolidsWorkbenchPage
 * uses to flush stepCache (WO INT-6A-R1).
 */
export async function pruneModelBodyDisplayCache(
  projectId: string,
  keepGeometryIds: ReadonlySet<string>,
): Promise<void> {
  const doomed = (await loadIndex())
    // A row with no readable record belongs to no live project by definition,
    // so the project boundary is exactly where it gets reclaimed.
    .filter((row) => row.record === null
      || row.record.projectId !== projectId
      || !keepGeometryIds.has(row.record.geometryId))
    .map((row) => row.key)
  if (doomed.length === 0) return
  await withStore<void>('readwrite', (store) => {
    for (const key of doomed) store.delete(key)
  })
}
