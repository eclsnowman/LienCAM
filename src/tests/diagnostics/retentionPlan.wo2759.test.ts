// WO-2759 fix round 4: every retention rule of REPORT-A-PROBLEM-V2 section 5,
// written as an invariant of the one planner and checked over random
// multi-session stores (alarms + ordinary events, ages, sizes, counts).
import { describe, expect, it } from 'vitest'
import { EVICT_TO, newestActivity, planRetention, type RetentionLimits, type RetentionRecord } from '../../lib/diagnostics/retention'
import { PRIORITY_CODES, encodedSize, type DiagnosticEvent } from '../../lib/diagnostics/schema'
import { HISTORY_MAX_AGE_MS } from '../../lib/diagnostics/history'

const DAY = 24 * 60 * 60 * 1000

function mulberry32(seed: number) {
  let t = seed >>> 0
  return () => {
    t = (t + 0x6d2b79f5) >>> 0
    let r = Math.imul(t ^ (t >>> 15), 1 | t)
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296
  }
}

const sizeOf = (events: DiagnosticEvent[]) => events.reduce((s, e) => s + encodedSize(e), 0)
const isReserved = (e: DiagnosticEvent) => PRIORITY_CODES.has(e.code)

function randomStore(rand: () => number, now: number) {
  const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)]
  const records: RetentionRecord[] = []
  const n = 1 + Math.floor(rand() * 9)
  for (let k = 0; k < n; k += 1) {
    const startedAt = now - Math.floor(rand() * 10 * DAY)
    const count = Math.floor(rand() * 40)
    const eventAt: number[] = []
    const events: DiagnosticEvent[] = []
    let t = startedAt
    for (let i = 0; i < count; i += 1) {
      t = Math.min(now, t + Math.floor(rand() * DAY / 2))
      eventAt.push(t)
      const roll = rand()
      const code = roll < 0.15 ? 'machine.alarm' : roll < 0.25 ? 'machine.connection' : 'machine.state'
      const fields: Record<string, string | number | boolean> = code === 'machine.alarm' ? { code: 1 + Math.floor(rand() * 9), positionLost: rand() < 0.5 }
        : code === 'machine.connection' ? { state: pick(['connected', 'disconnected']) }
        : { state: pick(['idle', 'run', 'hold']) }
      events.push({ v: 1, code, seq: i + 1, t: t - startedAt, fields } as DiagnosticEvent)
    }
    records.push({ id: `s${k}`, startedAt, eventAt, events })
  }
  return records
}

describe('WO-2759 retention planner (design section 5 invariants)', () => {
  it('holds every rule over random multi-session stores', () => {
    for (let seed = 1; seed <= 400; seed += 1) {
      const rand = mulberry32(seed)
      const now = 100 * DAY
      const records = randomStore(rand, now)
      const total = records.reduce((s, r) => s + sizeOf(r.events), 0)
      // Budgets from "everything fits" to "far too small", reserve 10-40%.
      const maxBytes = Math.max(200, Math.floor(total * (0.2 + rand() * 1.2)))
      const limits: RetentionLimits = {
        maxAgeMs: HISTORY_MAX_AGE_MS,
        maxSessions: 1 + Math.floor(rand() * 6),
        maxBytes,
        reservedBytes: Math.floor(maxBytes * (0.1 + rand() * 0.3)),
      }
      const ownId = rand() < 0.6 ? records[Math.floor(rand() * records.length)].id : undefined
      const where = `seed ${seed}`
      const plan = planRetention(records, now, limits, ownId)
      const cutoff = now - limits.maxAgeMs
      const ordinaryCap = limits.maxBytes - limits.reservedBytes

      // The result, and every event marked by why it could go.
      const kept = new Map<string, RetentionRecord>()
      type Ev = { r: RetentionRecord; i: number; e: DiagnosticEvent; at: number; kept: boolean }
      const evs: Ev[] = []
      for (const r of records) {
        const d = plan.get(r.id)
        if (d === null) expect(r.id, `${where}: own session deleted`).not.toBe(ownId)
        if (Array.isArray(d)) expect(d.length, `${where}: mask length`).toBe(r.events.length)
        const mask = d === undefined ? r.events.map(() => true) : d === null ? r.events.map(() => false) : d
        if (d !== null) kept.set(r.id, { ...r, events: r.events.filter((_, i) => mask[i]), eventAt: r.eventAt.filter((_, i) => mask[i]) })
        r.events.forEach((e, i) => evs.push({ r, i, e, at: r.eventAt[i], kept: mask[i] }))
      }
      for (const id of plan.keys()) expect(records.some((r) => r.id === id), `${where}: plan names an unknown record`).toBe(true)

      // Age: nothing past the limit is kept; a session whose newest event is past it goes whole.
      for (const ev of evs) if (ev.at < cutoff) expect(ev.kept, `${where}: aged event kept`).toBe(false)
      for (const r of records) {
        if (r.id !== ownId && newestActivity(r) < cutoff) expect(kept.has(r.id), `${where}: aged session kept`).toBe(false)
      }

      // Session count: at most the limit, own always kept, newest activity first.
      expect(kept.size, `${where}: sessions`).toBeLessThanOrEqual(limits.maxSessions)
      if (ownId) expect(kept.has(ownId), `${where}: own kept`).toBe(true)
      const young = records.filter((r) => r.id === ownId || newestActivity(r) >= cutoff)
      const countDropped = young.filter((r) => !kept.has(r.id))
      expect(countDropped.length, `${where}: count dropped only when over`).toBe(Math.max(0, young.length - limits.maxSessions))
      // Ranked on the sessions as given, before any byte trim.
      const keptOthers = records.filter((r) => kept.has(r.id) && r.id !== ownId)
      for (const r of countDropped) {
        for (const k of keptOthers) expect(newestActivity(r), `${where}: a newer session was dropped for the count`).toBeLessThanOrEqual(newestActivity(k))
      }

      // Bytes: both limits hold.
      const keptEvents = [...kept.values()].flatMap((r) => r.events)
      expect(sizeOf(keptEvents), `${where}: bytes`).toBeLessThanOrEqual(limits.maxBytes)
      expect(sizeOf(keptEvents.filter((e) => !isReserved(e))), `${where}: ordinary bytes`).toBeLessThanOrEqual(ordinaryCap)

      // What the byte limit judged: young events of the sessions the count kept.
      const judged = evs.filter((ev) => kept.has(ev.r.id) && ev.at >= cutoff)
      const judgedOrdinary = sizeOf(judged.filter((ev) => !isReserved(ev.e)).map((ev) => ev.e))
      const judgedTotal = sizeOf(judged.map((ev) => ev.e))
      // Nothing young is dropped unless a limit forces it.
      if (judgedOrdinary <= ordinaryCap && judgedTotal <= limits.maxBytes) {
        for (const ev of judged) expect(ev.kept, `${where}: young event dropped with no limit passed`).toBe(true)
      }
      // The reserve: a reserved event goes only once no ordinary event is left.
      const reservedDropped = judged.some((ev) => isReserved(ev.e) && !ev.kept)
      if (reservedDropped) expect(judged.some((ev) => !isReserved(ev.e) && ev.kept), `${where}: reserved event dropped while ordinary kept`).toBe(false)
      // Within a class, oldest first: every dropped event is no newer than every kept one.
      for (const reserved of [false, true]) {
        const cls = judged.filter((ev) => isReserved(ev.e) === reserved)
        const newestDropped = Math.max(-Infinity, ...cls.filter((ev) => !ev.kept).map((ev) => ev.at))
        const oldestKept = Math.min(Infinity, ...cls.filter((ev) => ev.kept).map((ev) => ev.at))
        expect(newestDropped, `${where}: ${reserved ? 'reserved' : 'ordinary'} newer dropped before older`).toBeLessThanOrEqual(oldestKept)
      }
      // Eviction stops at 90% of the limit it passed: no more is dropped than that needs.
      if (judged.some((ev) => !ev.kept) && !reservedDropped) {
        const keptOrdinary = sizeOf(judged.filter((ev) => !isReserved(ev.e) && ev.kept).map((ev) => ev.e))
        const keptTotal = sizeOf(judged.filter((ev) => ev.kept).map((ev) => ev.e))
        const lastDropped = Math.max(...judged.filter((ev) => !ev.kept).map((ev) => encodedSize(ev.e)))
        const overAfterOneLess = keptOrdinary + lastDropped > ordinaryCap * EVICT_TO || keptTotal + lastDropped > limits.maxBytes * EVICT_TO
        expect(overAfterOneLess, `${where}: evicted past the 90% mark`).toBe(true)
      }
    }
  })

  it('the auditor\'s A/B/C store: ordinary bytes go before the alarm', () => {
    // Audit 2026-10-13 6:12 PM: one alarm in A, ordinary state events in B and C.
    const ev = (code: string, seq: number, fields: Record<string, unknown>) => ({ v: 1, code, seq, t: 0, fields }) as DiagnosticEvent
    const a: RetentionRecord = { id: 'A', startedAt: 1_000_000, eventAt: [1_000_000], events: [ev('machine.alarm', 1, { code: 2, positionLost: false })] }
    const state = (id: string, at: number): RetentionRecord => ({
      id, startedAt: at, eventAt: Array.from({ length: 145 }, () => at),
      events: Array.from({ length: 145 }, (_, i) => ev('machine.state', i + 1, { state: 'idle' })),
    })
    const plan = planRetention([a, state('B', 1_000_001), state('C', 1_000_002)], 1_000_002,
      { maxAgeMs: HISTORY_MAX_AGE_MS, maxSessions: 5, maxBytes: 20_000, reservedBytes: 4_000 }, 'C')
    expect(plan.has('A')).toBe(false)
    expect(plan.get('B')).toBeTruthy()
    expect((plan.get('B') as boolean[]).filter((k) => !k).length).toBeGreaterThan(0)
  })
})
