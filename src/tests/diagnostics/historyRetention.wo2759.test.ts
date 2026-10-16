// WO-2759 fix round 3: no tab decides retention from its cached copy of another
// tab's session. Audit 2026-10-13 5:11 PM: tab B cached tab A's session, A then
// recorded an alarm, and B's prune deleted A's whole stored record - alarm and
// all - because B judged it by its stale event list.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DiagnosticHistory, HISTORY_MAX_AGE_MS, HISTORY_MAX_SESSIONS, MemoryHistoryStorage, type SessionRecord,
} from '../../lib/diagnostics/history'
import { encodedSize } from '../../lib/diagnostics/schema'

const DAY = 24 * 60 * 60 * 1000

beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] }) })
afterEach(() => { vi.useRealTimers() })

describe('WO-2759 retention across tabs', () => {
  it('a tab that cached another tab\'s session never deletes that session\'s newer events', async () => {
    // The auditor's sequence: A writes, B opens and caches A, A writes an alarm
    // a day later, B prunes just past seven days after A's first event.
    let now = 1_000_000
    const storage = new MemoryHistoryStorage()
    const a = new DiagnosticHistory(storage, () => now)
    await a.whenReady()
    a.record('machine.state', { state: 'idle' })
    await a.flush()
    now += 1
    const b = new DiagnosticHistory(storage, () => now)
    await b.whenReady()
    now += DAY
    a.record('machine.alarm', { code: 2, positionLost: false })
    await a.flush()
    now = 1_000_000 + HISTORY_MAX_AGE_MS + 100
    const alarmAt = storage.records.get(a.currentSessionId)!.eventAt.at(-1)!
    expect(now - alarmAt).toBeLessThan(HISTORY_MAX_AGE_MS)
    await b.prune()
    const after = storage.records.get(a.currentSessionId)
    expect(after?.events.map((e) => e.code) ?? null).toEqual(['machine.alarm'])
    // B's own flush cannot bring the stale copy back either.
    b.record('machine.state', { state: 'run' })
    await b.flush()
    expect(storage.records.get(a.currentSessionId)?.events.map((e) => e.code) ?? null).toEqual(['machine.alarm'])
    // What B shows for A is what A stored, not what B cached.
    expect(b.snapshot(a.currentSessionId)?.events.map((e) => e.code) ?? null).toEqual(['machine.alarm'])
  })

  it('a tab never writes back a trimmed stale copy of another tab\'s session', async () => {
    // Byte pressure used to trim B's cached copy of A and put it back,
    // overwriting everything A had stored since B opened.
    const limits = { maxBytes: 20_000, reservedBytes: 4_000 }
    const storage = new MemoryHistoryStorage()
    const a = new DiagnosticHistory(storage, () => 1_000_000, limits)
    await a.whenReady()
    a.record('machine.state', { state: 'idle' })
    await a.flush()
    const b = new DiagnosticHistory(storage, () => 1_000_001, limits)
    await b.whenReady()
    for (let i = 0; i < 120; i += 1) a.record('machine.alarm', { code: (i % 9) + 1, positionLost: false })
    await a.flush()
    const storedA = storage.records.get(a.currentSessionId)!.events
    for (let i = 0; i < 400; i += 1) b.record('machine.state', { state: i % 2 ? 'idle' : 'run' })
    await b.flush()
    await b.prune()
    const keptA = storage.records.get(a.currentSessionId)?.events ?? []
    // A's record is never replaced by B's one-event copy: what is left is a
    // subset of what A itself stored. Round 4: byte pressure takes ordinary
    // events first, oldest first, so all 120 of A's alarms survive.
    const storedSeqs = new Set(storedA.map((e) => e.seq))
    expect(keptA.every((e) => storedSeqs.has(e.seq))).toBe(true)
    expect(keptA.filter((e) => e.code === 'machine.alarm')).toHaveLength(120)
  })

  it('byte pressure from ordinary events never deletes another session\'s reserved alarm', async () => {
    // Audit 2026-10-13 6:12 PM (round 4): A stores one alarm, B and C only
    // ordinary state events. C's flush/prune deleted A whole, alarm and all,
    // while ordinary events survived - the reserve was bypassed.
    for (const [maxBytes, reservedBytes, n] of [[1_000, 200, 7], [20_000, 4_000, 145]]) {
      const limits = { maxBytes, reservedBytes }
      const storage = new MemoryHistoryStorage()
      let now = 1_000_000
      const a = new DiagnosticHistory(storage, () => now, limits)
      await a.whenReady()
      a.record('machine.alarm', { code: 2, positionLost: false })
      await a.flush()
      now += 1
      const b = new DiagnosticHistory(storage, () => now, limits)
      await b.whenReady()
      for (let i = 0; i < n; i += 1) b.record('machine.state', { state: 'idle' })
      await b.flush()
      now += 1
      const c = new DiagnosticHistory(storage, () => now, limits)
      await c.whenReady()
      for (let i = 0; i < n; i += 1) c.record('machine.state', { state: 'idle' })
      await c.flush()
      await c.prune()
      const remaining = [...storage.records.values()].flatMap((r) => r.events)
      const where = `maxBytes ${maxBytes}`
      expect(remaining.filter((e) => e.code === 'machine.alarm'), where).toHaveLength(1)
      expect(storage.records.get(a.currentSessionId)?.events.map((e) => e.code) ?? null, where).toEqual(['machine.alarm'])
      const bytes = remaining.reduce((s, e) => s + encodedSize(e), 0)
      expect(bytes, where).toBeLessThanOrEqual(maxBytes)
    }
  })
})

// ---- seeded property: tabs interleaving writes, flushes, prunes and time ----

function mulberry32(seed: number) {
  let t = seed >>> 0
  return () => {
    t = (t + 0x6d2b79f5) >>> 0
    let r = Math.imul(t ^ (t >>> 15), 1 | t)
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296
  }
}

const newestAt = (r: SessionRecord) => Math.max(r.startedAt, ...r.eventAt)
const youngBytes = (events: SessionRecord['events'], eventAt: number[], cutoff: number) =>
  events.reduce((sum, e, i) => sum + (eventAt[i] >= cutoff ? encodedSize(e) : 0), 0)

describe('WO-2759 retention property', () => {
  it('no stored event younger than the age limit is lost unless the session or byte limit forced it', async () => {
    for (let seed = 1; seed <= 40; seed += 1) {
      const rand = mulberry32(seed)
      const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)]
      const limits = pick([{ maxBytes: 3_000, reservedBytes: 800 }, { maxBytes: 8_000, reservedBytes: 2_000 }, { maxBytes: 1_000_000, reservedBytes: 100_000 }])
      let now = 1_000_000
      const clock = () => now
      const storage = new MemoryHistoryStorage()
      const live: DiagnosticHistory[] = []
      const open = async () => { const h = new DiagnosticHistory(storage, clock, limits); live.push(h); await h.whenReady() }
      await open()

      for (let step = 0; step < 150; step += 1) {
        const before = new Map([...storage.records].map(([id, r]) => [id, structuredClone(r)]))
        const roll = rand()
        const tab = pick(live)
        let op: string
        if (live.length === 0 || (roll < 0.08 && live.length < 7)) { op = 'open'; await open() }
        else if (roll < 0.45) {
          op = 'record'
          if (rand() < 0.2) tab.record('machine.alarm', { code: 1 + Math.floor(rand() * 9), positionLost: false })
          else tab.record('machine.state', { state: rand() < 0.5 ? 'idle' : 'run' })
        }
        else if (roll < 0.62) { op = 'flush'; await tab.flush() }
        else if (roll < 0.76) { op = 'prune'; await tab.prune() }
        else if (roll < 0.88) { op = 'advance'; now += Math.floor(rand() * 2 * DAY) }
        else if (roll < 0.94) { op = 'close'; tab.endSession(); await tab.flush(); live.splice(live.indexOf(tab), 1) }
        else { op = 'crash'; live.splice(live.indexOf(tab), 1) }

        const cutoff = now - HISTORY_MAX_AGE_MS
        const where = `seed ${seed} step ${step} ${op}`
        // Demand: every session still alive in storage or in an open tab, and the
        // young bytes each holds (the larger of its stored and in-memory copies).
        // A tab closed this step wrote its session on the way out: demand too.
        const writers = op === 'close' ? [...live, tab] : live
        const liveCopies = new Map(writers.map((h) => [h.currentSessionId, h.snapshot(h.currentSessionId)!]))
        const ids = new Set([...liveCopies.keys(), ...[...before.values()].filter((r) => newestAt(r) >= cutoff).map((r) => r.id)])
        let demandBytes = 0
        for (const id of ids) {
          const stored = before.get(id)
          const storedBytes = stored ? youngBytes(stored.events, stored.eventAt, cutoff) : 0
          const mem = liveCopies.get(id)
          const memBytes = mem ? mem.events.reduce((s, e) => s + encodedSize(e), 0) : 0
          demandBytes += Math.max(storedBytes, memBytes)
        }
        const pressed = ids.size > HISTORY_MAX_SESSIONS || demandBytes > limits.maxBytes
        if (!pressed) {
          for (const r of before.values()) {
            const after = storage.records.get(r.id)
            const kept = new Set(after?.events.map((e) => e.seq) ?? [])
            r.events.forEach((e, i) => {
              if (r.eventAt[i] >= cutoff) expect(kept.has(e.seq), `${where}: lost young event ${r.id}#${e.seq}`).toBe(true)
            })
          }
        }
        if (op === 'prune' || op === 'open') {
          expect(storage.records.size, `${where}: sessions`).toBeLessThanOrEqual(HISTORY_MAX_SESSIONS)
          const bytes = [...storage.records.values()].reduce((s, r) => s + r.events.reduce((t, e) => t + encodedSize(e), 0), 0)
          expect(bytes, `${where}: bytes`).toBeLessThanOrEqual(limits.maxBytes)
        }
      }
    }
  })
})
