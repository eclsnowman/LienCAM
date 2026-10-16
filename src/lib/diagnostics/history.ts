// WO-2759: the local diagnostic history (design section 5). Bounded by seven
// days, five sessions and 5 MiB, whichever ends first, with 1 MiB of that held
// back for failures/refusals/transitions. Writes are batched and asynchronous;
// nothing here is awaited on a control path, and a storage failure is counted
// in memory, never logged back into the history it failed to write.
//
// Persistence is one record per session, so two tabs never overwrite each
// other's events. Clear bumps a generation number: a write that was queued
// before Clear finds the generation moved on and is thrown away instead of
// repopulating what the user just removed.

import {
  EVENT_SCHEMA_VERSION, MAX_EVENT_BYTES, PRIORITY_CODES, emptyOmissions, encodedSize,
  isFailureEvent, revalidateStoredEvent, validateEventFields,
  type DiagnosticEvent, type Omissions,
} from './schema'
import { applyKeep, newestActivity, planRetention, type RetentionLimits } from './retention'

export const HISTORY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
export const HISTORY_MAX_SESSIONS = 5
export const HISTORY_MAX_BYTES = 5 * 1024 * 1024
export const HISTORY_RESERVED_BYTES = 1024 * 1024
export const QUEUE_MAX_EVENTS = 256
export const QUEUE_MAX_BYTES = 512 * 1024
const FLUSH_DELAY_MS = 1500

export interface SessionRecord {
  id: string
  /** Local wall clock, used only for retention; never exported. */
  startedAt: number
  /** Local wall clock per event (retention only), parallel to `events`. */
  eventAt: number[]
  events: DiagnosticEvent[]
  /** False until the page is closed normally - the dirty-session marker. */
  endedCleanly: boolean
  dropped: number
  /** Last sequence number handed out; never reused, even after eviction. */
  lastSeq: number
  omissions: Omissions
  generation: number
  /** New on every write of this record, so another tab can tell its listed copy is out of date. */
  writeId?: string
}

/** What `HistoryStorage.update` decides: a replacement, null to delete, undefined to leave it. */
export type StoredDecision = SessionRecord | null | undefined

export interface HistoryStorage {
  loadAll(): Promise<SessionRecord[]>
  put(record: SessionRecord): Promise<void>
  /**
   * One atomic read-decide-write of a stored record. `decide` sees the record
   * as stored at that moment - never a copy read earlier - so a tab can only
   * trim or delete another tab's session on what that session holds now.
   * Resolves to the record stored afterwards (null when there is none).
   */
  update(id: string, decide: (stored: SessionRecord) => StoredDecision): Promise<SessionRecord | null>
  clear(): Promise<void>
}

/** In-memory storage: tests, and the fallback when the browser refuses storage. */
export class MemoryHistoryStorage implements HistoryStorage {
  records = new Map<string, SessionRecord>()
  async loadAll() { return [...this.records.values()].map((r) => structuredClone(r)) }
  async put(record: SessionRecord) { this.records.set(record.id, structuredClone(record)) }
  async update(id: string, decide: (stored: SessionRecord) => StoredDecision) {
    const stored = this.records.get(id)
    if (!stored) return null
    const next = decide(structuredClone(stored))
    if (next === undefined) return structuredClone(stored)
    if (next === null) { this.records.delete(id); return null }
    this.records.set(id, structuredClone(next))
    return structuredClone(next)
  }
  async clear() { this.records.clear() }
}

const DB_NAME = 'liencam-diagnostics'
const DB_STORE = 'sessions'

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

/** IndexedDB storage, used by the web app and by the desktop renderer (whose
 *  IndexedDB lives in the app's own userData folder). */
export class IndexedDbHistoryStorage implements HistoryStorage {
  private db: Promise<IDBDatabase> | null = null
  private open(): Promise<IDBDatabase> {
    this.db ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1)
      req.onupgradeneeded = () => { req.result.createObjectStore(DB_STORE, { keyPath: 'id' }) }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    return this.db
  }
  private async store(mode: IDBTransactionMode) {
    return (await this.open()).transaction(DB_STORE, mode).objectStore(DB_STORE)
  }
  async loadAll() { return (await request((await this.store('readonly')).getAll())) as SessionRecord[] }
  async put(record: SessionRecord) { await request((await this.store('readwrite')).put(record)) }
  /** Read, decide and write inside one readwrite transaction, so no other tab's
   *  write can land between the read and the delete or replace. */
  async update(id: string, decide: (stored: SessionRecord) => StoredDecision): Promise<SessionRecord | null> {
    const store = await this.store('readwrite')
    return new Promise((resolve, reject) => {
      const get = store.get(id)
      get.onerror = () => reject(get.error)
      get.onsuccess = () => {
        const stored = get.result as SessionRecord | undefined
        if (!stored) { resolve(null); return }
        const next = decide(stored)
        if (next === undefined) { resolve(stored); return }
        const write = next === null ? store.delete(id) : store.put(next)
        write.onerror = () => reject(write.error)
        write.onsuccess = () => resolve(next)
      }
    })
  }
  async clear() { await request((await this.store('readwrite')).clear()) }
}

export interface SessionSummary {
  id: string
  current: boolean
  startedAt: number
  eventCount: number
  failureCount: number
  endedCleanly: boolean
  dropped: number
}

export interface HistoryStatus {
  available: boolean
  storageFailures: number
  queueDrops: number
}

function sessionId(): string {
  const bytes = new Uint8Array(8)
  globalThis.crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

function emptySession(id: string, now: number, generation: number): SessionRecord {
  return { id, startedAt: now, eventAt: [], events: [], endedCleanly: false, dropped: 0, lastSeq: 0, omissions: emptyOmissions(), generation }
}

function eventBytes(r: SessionRecord): { total: number; ordinary: number } {
  let total = 0
  let ordinary = 0
  for (const e of r.events ?? []) {
    const size = encodedSize(e)
    total += size
    if (!PRIORITY_CODES.has(e.code)) ordinary += size
  }
  return { total, ordinary }
}

/** Another tab's record as this tab may show it: re-checked, never trusted. */
function revalidate(raw: SessionRecord): SessionRecord {
  // Architect fix of astra audit 6 (history.ts:166): EVERY persisted field is rebuilt from a
  // checked value - counters are non-negative integers, unknown keys are dropped, nothing of
  // the stored record is spread through - so tampered metadata cannot reach the README.
  const count = (v: unknown): number => (Number.isSafeInteger(v) && (v as number) >= 0 ? (v as number) : 0)
  const time = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)
  const stored = (raw.omissions ?? {}) as Partial<Record<keyof Omissions, unknown>>
  const omissions: Omissions = {
    unknownCodes: count(stored.unknownCodes), unknownFields: count(stored.unknownFields),
    invalidFields: count(stored.invalidFields), oversizeEvents: count(stored.oversizeEvents),
  }
  const startedAt = time(raw.startedAt, 0)
  const events: DiagnosticEvent[] = []
  const eventAt: number[] = []
  ;(raw.events ?? []).forEach((e, i) => {
    const clean = revalidateStoredEvent(e, omissions)
    if (clean) { events.push(clean); eventAt.push(time(raw.eventAt?.[i], startedAt)) }
  })
  const lastSeq = Math.max(count(raw.lastSeq), ...events.map((e) => e.seq))
  return {
    id: String(raw.id),
    startedAt,
    eventAt,
    events,
    endedCleanly: raw.endedCleanly === true,
    dropped: count(raw.dropped),
    lastSeq,
    omissions,
    generation: count(raw.generation),
    ...(typeof raw.writeId === 'string' ? { writeId: raw.writeId } : {}),
  }
}

/**
 * The history of this page's session, plus a read-only view of the sessions
 * other tabs (open now, or closed earlier) have stored.
 *
 * Retention rule (audit fix round 3): this tab decides retention from memory
 * only for its own session. Another tab's session is aged, counted and sized
 * from storage as listed at prune time, and every trim or delete of it is
 * applied on the record as stored at that moment (`HistoryStorage.update`),
 * only if nothing was written to it since the listing. The view of other
 * sessions is never written back.
 *
 * Audit fix round 4: what to trim or delete is decided by ONE planner
 * (`planRetention`, retention.ts) on the write path, in flush and in prune.
 */
export class DiagnosticHistory {
  private current: SessionRecord
  /** Other sessions as last listed from storage (re-checked). Display and export only. */
  private others = new Map<string, SessionRecord>()
  /** Their sizes, measured once when listed, so a write never re-measures them. */
  private othersSize = new Map<string, { total: number; ordinary: number }>()
  private generation = 0
  private recording = true
  private dirty = false
  private pendingEvents = 0
  private pendingBytes = 0
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private pruning: Promise<void> | null = null
  private ready: Promise<void>
  private listeners = new Set<() => void>()
  readonly status: HistoryStatus = { available: true, storageFailures: 0, queueDrops: 0 }
  previousEndedUnexpectedly = false

  private limits: { maxBytes: number; reservedBytes: number }

  private storage: HistoryStorage
  private now: () => number

  constructor(
    storage: HistoryStorage,
    now: () => number = Date.now,
    limits: { maxBytes?: number; reservedBytes?: number } = {},
  ) {
    this.storage = storage
    this.now = now
    this.limits = { maxBytes: limits.maxBytes ?? HISTORY_MAX_BYTES, reservedBytes: limits.reservedBytes ?? HISTORY_RESERVED_BYTES }
    this.current = emptySession(sessionId(), now(), 0)
    this.ready = this.load()
  }

  /** Resolves once stored sessions are read and pruned. */
  whenReady(): Promise<void> { return this.ready }

  private async load() {
    const generation = this.generation
    let stored: SessionRecord[] | null = null
    try {
      stored = await this.storage.loadAll()
    } catch {
      this.status.available = false
      this.status.storageFailures += 1
    }
    // Clear pressed while the read was in flight: what was read is gone.
    if (generation !== this.generation) return
    if (stored) {
      const newest = stored.filter((r) => r.id !== this.current.id).sort((a, b) => b.startedAt - a.startedAt)[0]
      this.previousEndedUnexpectedly = newest !== undefined && newest.endedCleanly === false
    }
    await this.pruneWith(stored)
    this.emit()
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  private emit() { for (const l of this.listeners) l() }

  get currentSessionId() { return this.current.id }
  /** Moves on at every Clear (here or broadcast from another tab). */
  get clearGeneration() { return this.generation }
  get isRecording() { return this.recording }

  /** Off stops NEW persistent events; what is stored stays until Clear or expiry. */
  setRecording(on: boolean) { this.recording = on === true }

  /**
   * The one producer entry. Returns true when the event was accepted. A code
   * outside the allowlist, a field that fails its rule, or an oversize event
   * is dropped and counted; recording off drops silently.
   */
  record(code: string, fields: Record<string, unknown> = {}): boolean {
    if (!this.recording) return false
    const session = this.current
    const checked = validateEventFields(code, fields, session.omissions)
    if (!checked) { this.markDirty(0); return false }
    const event: DiagnosticEvent = {
      v: EVENT_SCHEMA_VERSION,
      code: checked.code,
      seq: session.lastSeq + 1,
      t: Math.max(0, Math.round(this.now() - session.startedAt)),
      fields: checked.fields,
    }
    const size = encodedSize(event)
    if (size > MAX_EVENT_BYTES) { session.omissions.oversizeEvents += 1; this.markDirty(0); return false }
    const priority = PRIORITY_CODES.has(event.code)
    if (!priority && (this.pendingEvents >= QUEUE_MAX_EVENTS || this.pendingBytes + size > QUEUE_MAX_BYTES)) {
      this.status.queueDrops += 1
      session.dropped += 1
      return false
    }
    session.lastSeq = event.seq
    session.events.push(event)
    session.eventAt.push(this.now())
    this.totalBytes += size
    if (!priority) this.ordinaryBytes += size
    this.pendingEvents += 1
    this.markDirty(size)
    // Hot path: running totals make the common case free; only this tab's own
    // session is planned here, never by a cached copy of another tab's.
    if (this.ordinaryBytes > this.limits.maxBytes - this.limits.reservedBytes || this.totalBytes > this.limits.maxBytes) this.trimOwn()
    this.emit()
    return true
  }

  private markDirty(bytes: number) {
    this.dirty = true
    this.pendingBytes += bytes
    if (this.flushTimer === null) this.flushTimer = setTimeout(() => { void this.flush() }, FLUSH_DELAY_MS)
  }

  /**
   * Write this tab's session now. Queued writes from before a Clear are
   * discarded. When another session looks expired here, or this session plus
   * what other tabs stored may pass a byte limit, a prune decides on a fresh
   * listing - this tab never trims or deletes another session from its view.
   */
  async flush(): Promise<void> {
    this.trimOwn()
    if (this.flushTimer !== null) { clearTimeout(this.flushTimer); this.flushTimer = null }
    const write = this.dirty
    this.dirty = false
    this.pendingEvents = 0
    this.pendingBytes = 0
    const generation = this.generation
    const cutoff = this.now() - HISTORY_MAX_AGE_MS
    const others = this.othersBytes()
    const needsPrune = [...this.others.values()].some((v) => newestActivity(v) < cutoff)
      || this.totalBytes + others.total > this.limits.maxBytes
      || this.ordinaryBytes + others.ordinary > this.limits.maxBytes - this.limits.reservedBytes
    if (write && this.current.generation === generation) {
      this.current.writeId = sessionId()
      try {
        await this.storage.put(this.current)
      } catch {
        this.status.storageFailures += 1
        this.status.available = false
      }
      if (this.generation !== generation) {
        // Clear ran while this write was in flight: undo it.
        await this.storage.clear().catch(() => { this.status.storageFailures += 1 })
        return
      }
    }
    if (this.pruning === null && needsPrune) await this.prune()
  }

  /** The page is closing normally: mark the session clean and flush. */
  endSession() {
    this.current.endedCleanly = true
    this.dirty = true
    void this.flush()
  }

  /** A page restored from the back/forward cache is running again. */
  resumeSession() {
    this.current.endedCleanly = false
    this.markDirty(0)
  }

  /** Clear removes stored history and incident data; recording stays as set. */
  async clear(): Promise<void> {
    this.generation += 1
    this.dirty = false
    this.pendingEvents = 0
    this.pendingBytes = 0
    this.current = emptySession(this.current.id, this.current.startedAt, this.generation)
    this.others = new Map()
    this.othersSize = new Map()
    this.totalBytes = 0
    this.ordinaryBytes = 0
    this.previousEndedUnexpectedly = false
    // Tell an open report now, not after the disk answers: its pending copy ends here.
    this.emit()
    try { await this.storage.clear() } catch { this.status.storageFailures += 1 }
    this.emit()
  }

  private retentionLimits(): RetentionLimits {
    return { maxAgeMs: HISTORY_MAX_AGE_MS, maxSessions: HISTORY_MAX_SESSIONS, ...this.limits }
  }

  /** Apply the planner's keep mask for this tab's own session, in memory. */
  private applyOwn(mask: boolean[] | null | undefined) {
    if (!mask) return
    this.current = applyKeep(this.current, mask)
    this.markDirty(0)
    this.recountBytes()
  }

  /**
   * The retention plan for this tab's own session alone (age and bytes).
   * Every read and every write runs it, so a page left open past the limit -
   * recording on or off - can neither show, export nor write back what has
   * expired (design section 5). Other sessions are filtered by age when read,
   * and trimmed or deleted only by a prune, on their stored copy.
   */
  private trimOwn() {
    const cutoff = this.now() - HISTORY_MAX_AGE_MS
    const over = this.ordinaryBytes > this.limits.maxBytes - this.limits.reservedBytes || this.totalBytes > this.limits.maxBytes
    if (!over && !this.current.eventAt.some((t) => t < cutoff)) return
    const id = this.current.id
    this.applyOwn(planRetention([this.current], this.now(), this.retentionLimits(), id).get(id))
  }

  /**
   * One retention plan (retention.ts) over this tab's own session and every
   * other session as stored right now: age, session count and bytes decided
   * together, per event. Runs at startup, periodically, on report open and
   * when a write may have passed a limit.
   *
   * The own session's share of the plan is applied in memory and written.
   * Another session's share is applied inside one atomic read-decide-write,
   * and only if nothing was written to it since the listing (compare-and-
   * delete); a session written to since then is left for the next prune.
   */
  prune(): Promise<void> { return this.pruneWith(null) }

  private pruneWith(listing: SessionRecord[] | null): Promise<void> {
    this.pruning ??= this.runPrune(listing).finally(() => { this.pruning = null })
    return this.pruning
  }

  private async runPrune(listing: SessionRecord[] | null): Promise<void> {
    const generation = this.generation
    let stored = listing
    if (!stored) {
      try { stored = await this.storage.loadAll() } catch { this.status.storageFailures += 1 }
    }
    // Clear ran while storage was being listed: there is nothing left to prune.
    if (generation !== this.generation) return
    if (!stored) {
      this.trimOwn()
    } else {
      const ownId = this.current.id
      const listed = stored.filter((r) => r.id !== ownId)
      const plan = planRetention([this.current, ...listed], this.now(), this.retentionLimits(), ownId)
      this.applyOwn(plan.get(ownId))
      const failed = (fallback: SessionRecord) => () => { this.status.storageFailures += 1; return fallback }
      const kept: SessionRecord[] = []
      for (const r of listed) {
        const decision = plan.get(r.id)
        if (decision === undefined) { kept.push(r); continue }
        const unchanged = (s: SessionRecord) => s.writeId === r.writeId && (s.events ?? []).length === (r.events ?? []).length
        const after = await this.storage.update(r.id, (s) => {
          if (!unchanged(s)) return undefined
          return decision === null ? null : { ...applyKeep(s, decision), writeId: sessionId() }
        }).catch(failed(r))
        if (generation !== this.generation) return
        if (after) kept.push(after)
      }
      this.others = new Map()
      this.othersSize = new Map()
      for (const r of kept) this.setOther(r.id, r)
    }
    if (this.dirty) await this.flush()
    this.emit()
  }

  private totalBytes = 0
  private ordinaryBytes = 0

  private recountBytes() {
    const b = eventBytes(this.current)
    this.totalBytes = b.total
    this.ordinaryBytes = b.ordinary
  }

  private setOther(id: string, stored: SessionRecord | null) {
    if (!stored) { this.others.delete(id); this.othersSize.delete(id); return }
    const view = revalidate(stored)
    this.others.set(id, view)
    this.othersSize.set(id, eventBytes(view))
  }

  /** What the other sessions held when last listed. */
  private othersBytes(): { total: number; ordinary: number } {
    let total = 0
    let ordinary = 0
    for (const b of this.othersSize.values()) { total += b.total; ordinary += b.ordinary }
    return { total, ordinary }
  }

  /** Another session's events within the age limit, as last listed. */
  private visibleOther(r: SessionRecord, cutoff: number) {
    const keep = r.eventAt.map((t) => t >= cutoff)
    return { events: r.events.filter((_, i) => keep[i]), dropped: r.dropped + keep.filter((k) => !k).length }
  }

  summaries(): SessionSummary[] {
    this.trimOwn()
    const cutoff = this.now() - HISTORY_MAX_AGE_MS
    const rows = [{ s: this.current, events: this.current.events, dropped: this.current.dropped }]
    for (const r of this.others.values()) {
      if (newestActivity(r) >= cutoff) rows.push({ s: r, ...this.visibleOther(r, cutoff) })
    }
    return rows
      .sort((a, b) => b.s.startedAt - a.s.startedAt)
      .map(({ s, events, dropped }) => ({
        id: s.id,
        current: s.id === this.current.id,
        startedAt: s.startedAt,
        eventCount: events.length,
        failureCount: events.filter(isFailureEvent).length,
        endedCleanly: s.endedCleanly,
        dropped,
      }))
  }

  /** Design section 2: default to the latest session holding a failure. */
  defaultIncidentSessionId(): string {
    return this.summaries().find((s) => s.failureCount > 0)?.id ?? this.current.id
  }

  /** A frozen copy of one session for a report. */
  snapshot(id: string): { events: DiagnosticEvent[]; dropped: number; omissions: Omissions; current: boolean } | null {
    this.trimOwn()
    if (id === this.current.id) {
      const s = this.current
      return { events: structuredClone(s.events), dropped: s.dropped, omissions: { ...s.omissions }, current: true }
    }
    const r = this.others.get(id)
    const cutoff = this.now() - HISTORY_MAX_AGE_MS
    if (!r || newestActivity(r) < cutoff) return null
    const { events, dropped } = this.visibleOther(r, cutoff)
    return { events: structuredClone(events), dropped, omissions: { ...r.omissions }, current: false }
  }

  /** Bytes currently held, for the settings readout. */
  storedBytes(): number {
    this.trimOwn()
    return this.totalBytes + this.othersBytes().total
  }
}
