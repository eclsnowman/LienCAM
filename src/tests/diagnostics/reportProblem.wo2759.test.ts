// WO-2759: Help > Report a problem v1 - the privacy and consent contract of the
// diagnostic history and the report builder (docs/design/REPORT-A-PROBLEM-V2.md).
import { describe, expect, it } from 'vitest'
import { unzipSync, strFromU8 } from 'fflate'
import {
  DiagnosticHistory, HISTORY_MAX_AGE_MS, HISTORY_MAX_BYTES, HISTORY_MAX_SESSIONS, MemoryHistoryStorage, type SessionRecord,
} from '../../lib/diagnostics/history'
import { stackLocations } from '../../lib/diagnostics/schema'
import {
  CATEGORY_FILES, CATEGORY_IDS, DEFAULT_CHOICES, buildReport,
  type CategoryId, type ReportChoices, type ReportSources,
} from '../../lib/diagnostics/report'
import { issueFormUrl, prefillFields } from '../../lib/diagnostics/githubPrefill'
import { basicEnvironment, machineSnapshot, operationSettings, preciseEnvironment } from '../../lib/diagnostics/sources'
import type { Operation, Tool } from '../../types'

// Synthetic private values (design section 10, Privacy). None may survive.
const SECRETS = [
  'C:\\Profiles\\example', '/home/jdoe', '\\\\FILESERVER\\share', '203.0.113.44', 'fe80::1', '00:1A:2B:3C:4D:5E',
  'ghp_SECRETTOKEN123', 'https://evil.example/?key=abc', 'DESKTOP-JDOE', 'Customer Bracket Rev C', 'MySecretVendor',
]

const ALL_OFF = Object.fromEntries(CATEGORY_IDS.map((id) => [id, false])) as ReportChoices
const ALL_ON = Object.fromEntries(CATEGORY_IDS.map((id) => [id, true])) as ReportChoices

function newHistory(start = 1_000_000) {
  let now = start
  const storage = new MemoryHistoryStorage()
  const h = new DiagnosticHistory(storage, () => now)
  return { h, storage, advance: (ms: number) => { now += ms }, setNow: (t: number) => { now = t } }
}

const OP = {
  id: 'op-uuid-1', name: 'Customer Bracket Rev C', type: 'pocket_2d', enabled: true, status: 'ready', toolId: 'tool-1',
  geometrySelections: ['face-1'], params: { secretNote: 'C:\\Profiles\\example\\job.dxf', contour: [[1, 2], [3, 4]] },
  heights: {}, passes: { stepdown: 1.5, stepover: 3, stockToLeave: 0.2, finishPasses: 1, springPasses: 0 },
  linking: { entryType: 'ramp_helical', rampAngle: 2, rampLength: 0, leadInRadius: 1, leadOutRadius: 1, retractType: 'minimum', transitionType: 'safe_height' },
} as unknown as Operation
const TOOL = {
  id: 'tool-1', name: 'MySecretVendor 6mm', type: 'flat_endmill', diameter: 6, fluteLength: 20, numberOfFlutes: 3,
  notes: 'DESKTOP-JDOE', vendor: 'MySecretVendor', productId: 'X-1', feedsAndSpeeds: { 'Customer Alloy': {} },
} as unknown as Tool

const PROBE = {
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) DESKTOP-JDOE',
  deviceMemory: 8, devicePixelRatio: 1.25, hardwareConcurrency: 16, screen: { width: 2560, height: 1440 },
  gpu: { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11-31.0.15.3623)' },
}

async function sources(): Promise<ReportSources> {
  const { h } = newHistory()
  await h.whenReady()
  h.record('session.start', { surface: 'web' })
  h.record('cam.generation.finished', { family: 'pocket_2d', operation: 1, outcome: 'error', ms: 12.5 })
  h.record('machine.alarm', { code: 2, positionLost: true })
  const snap = h.snapshot(h.currentSessionId)!
  return {
    appVersions: { appVersion: '0.36.0-alpha.2', build: 'abc1234', buildDate: '2026-10-13', surface: 'web' },
    basicEnvironment: basicEnvironment(PROBE),
    preciseEnvironment: preciseEnvironment(PROBE),
    incident: { label: 'this session', events: snap.events, dropped: 0, omissions: snap.omissions },
    machineState: machineSnapshot({
      connectionPhase: 'connected', connectionKind: 'bridge', machineState: 'alarm', grblVersion: '1.1h',
      alarm: { code: 2, positionLost: true }, job: { phase: 'failed', totalLines: 100, sentLines: 40, ackedLines: 38 },
      parserModal: { units: 'mm', distanceMode: 'absolute', motionMode: 'G1' },
    }),
    operationSettings: operationSettings(OP, TOOL, ['pocket_2d']),
    project: { bytes: new TextEncoder().encode('{"name":"Customer Bracket Rev C"}') },
    program: { bytes: new TextEncoder().encode('(Customer Bracket Rev C)\nG21\nG1 X10 Y20 F500\n') },
    image: { bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]), kind: 'png' },
  }
}

const zipNames = (zip: Uint8Array) => Object.keys(unzipSync(zip)).sort()

describe('WO-2759 diagnostic history allowlist', () => {
  it('a non-allowlisted event never persists, and only its count is kept', async () => {
    const { h, storage } = newHistory()
    await h.whenReady()
    expect(h.record('console.line', { text: 'C:\\Profiles\\example\\secret.nc' })).toBe(false)
    expect(h.record('machine.state', { state: 'idle', detail: 'DESKTOP-JDOE 203.0.113.44' })).toBe(true)
    expect(h.record('machine.state', { state: 'C:\\Profiles\\example' })).toBe(false)
    expect(h.record('renderer.uncaught-error', { kind: 'error', frames: [{ file: 'C:/Profiles/example/x.js', line: 1, col: 1 }] })).toBe(false)
    await h.flush()
    const stored = JSON.stringify([...storage.records.values()])
    for (const secret of [...SECRETS, 'console.line', 'secret.nc']) expect(stored).not.toContain(secret)
    const snap = h.snapshot(h.currentSessionId)!
    expect(snap.events.map((e) => e.code)).toEqual(['machine.state'])
    expect(snap.events[0].fields).toEqual({ state: 'idle' })
    expect(snap.omissions).toEqual({ unknownCodes: 1, unknownFields: 1, invalidFields: 2, oversizeEvents: 0 })
  })

  it('a tampered stored record is re-checked on load, not trusted', async () => {
    const storage = new MemoryHistoryStorage()
    const forged: SessionRecord = {
      id: 'old', startedAt: 999_000, eventAt: [999_100, 999_200], endedCleanly: true, dropped: 0, lastSeq: 2, generation: 0,
      omissions: { unknownCodes: 0, unknownFields: 0, invalidFields: 0, oversizeEvents: 0 },
      events: [
        { v: 1, code: 'machine.state', seq: 1, t: 1, fields: { state: 'idle', note: 'ghp_SECRETTOKEN123' } } as never,
        { v: 1, code: 'raw.console' as never, seq: 2, t: 2, fields: { text: '/home/jdoe' } as never },
      ],
    }
    await storage.put(forged)
    const h = new DiagnosticHistory(storage, () => 1_000_000)
    await h.whenReady()
    const snap = h.snapshot('old')!
    expect(snap.events).toHaveLength(1)
    expect(JSON.stringify(snap.events)).not.toContain('SECRETTOKEN')
  })

  it('tampered stored metadata (counters, extra keys) is rebuilt from checked values and never exported (audit 6)', async () => {
    const storage = new MemoryHistoryStorage()
    const forged = {
      id: 'old', startedAt: 999_000, eventAt: [999_100], endedCleanly: 'ghp_META_ENDED', dropped: 'ghp_META_DROPPED', lastSeq: 1,
      generation: 'ghp_META_GEN', leak: 'ghp_META_EXTRA',
      omissions: { unknownCodes: 'ghp_META_COUNTER', unknownFields: -3, invalidFields: 1.5, oversizeEvents: 2, extra: 'ghp_META_KEY' },
      events: [{ v: 1, code: 'machine.state', seq: 1, t: 1, fields: { state: 'idle' } }],
    } as unknown as SessionRecord
    await storage.put(forged)
    const h = new DiagnosticHistory(storage, () => 1_000_000)
    await h.whenReady()
    const snap = h.snapshot('old')!
    expect(snap.omissions).toEqual({ unknownCodes: 0, unknownFields: 0, invalidFields: 0, oversizeEvents: 2 })
    expect(snap.dropped).toBe(0)
    const report = await buildReport({ ...ALL_OFF, eventHistory: true }, {
      appVersions: null, basicEnvironment: null, preciseEnvironment: null, machineState: null, operationSettings: null,
      project: null, program: null, image: null,
      incident: { label: 'earlier session', events: snap.events, dropped: snap.dropped, omissions: snap.omissions },
    } as unknown as ReportSources)
    const files = unzipSync(report.zip)
    const all = Object.values(files).map((b) => strFromU8(b)).join('\n')
    expect(all).not.toContain('ghp_META')
  })

  it('stack locations keep app-relative code positions only', () => {
    const stack = [
      'Error: C:\\Profiles\\example\\secret.camproject failed',
      '    at a (http://localhost:5173/src/lib/cam/x.ts?t=123:10:5)',
      '    at b (chrome-extension://abc/inject.js:1:1)',
      '    at c (file:///C:/Profiles/example/app.js:2:2)',
      '    at d (liencam://app/assets/app-XYZ.js:99:7)',
    ].join('\n')
    expect(stackLocations(stack, ['http://localhost:5173/', 'liencam://app/'])).toEqual([
      { file: 'src/lib/cam/x.ts', line: 10, col: 5 },
      { file: 'assets/app-XYZ.js', line: 99, col: 7 },
    ])
  })

  it('recording off stops new events; stored history stays until Clear', async () => {
    const { h, storage } = newHistory()
    await h.whenReady()
    h.record('machine.state', { state: 'idle' })
    h.setRecording(false)
    expect(h.record('machine.state', { state: 'run' })).toBe(false)
    expect(h.snapshot(h.currentSessionId)!.events).toHaveLength(1)
    await h.flush()
    await h.clear()
    expect(h.snapshot(h.currentSessionId)!.events).toHaveLength(0)
    expect(storage.records.size).toBe(0)
  })

  it('a write queued before Clear cannot repopulate the cleared history', async () => {
    const { h, storage } = newHistory()
    await h.whenReady()
    h.record('machine.state', { state: 'idle' })
    const cleared = h.clear()
    await h.flush()
    await cleared
    expect(storage.records.size).toBe(0)
  })

  it('expires by age and keeps at most five sessions', async () => {
    const storage = new MemoryHistoryStorage()
    const day = 24 * 60 * 60 * 1000
    for (let i = 0; i < 7; i += 1) {
      await storage.put({
        id: `s${i}`, startedAt: i * day, eventAt: [i * day], endedCleanly: true, dropped: 0, lastSeq: 1, generation: 0,
        omissions: { unknownCodes: 0, unknownFields: 0, invalidFields: 0, oversizeEvents: 0 },
        events: [{ v: 1, code: 'machine.state', seq: 1, t: 0, fields: { state: 'idle' } }],
      })
    }
    const h = new DiagnosticHistory(storage, () => 9 * day)
    await h.whenReady()
    const summaries = h.summaries()
    expect(summaries.length).toBeLessThanOrEqual(HISTORY_MAX_SESSIONS)
    // Sessions s0 and s1 are older than seven days: their events expired.
    for (const s of summaries) if (s.startedAt < 2 * day) expect(s.eventCount).toBe(0)
  })

  it('the five-session limit counts every tab\'s sessions in storage, not one tab\'s view', async () => {
    // Audit 2026-10-13 (round 2): six tabs started together each saw only its
    // own session, so their prunes left six stored sessions.
    const storage = new MemoryHistoryStorage()
    const tabs = Array.from({ length: 6 }, (_, i) => new DiagnosticHistory(storage, () => 1_000_000 + i))
    await Promise.all(tabs.map((h) => h.whenReady()))
    for (const h of tabs) { h.record('machine.state', { state: 'idle' }); await h.flush() }
    await Promise.all(tabs.map((h) => h.prune()))
    expect(storage.records.size).toBeLessThanOrEqual(HISTORY_MAX_SESSIONS)
    expect(storage.records.has(tabs[5].currentSessionId)).toBe(true)
    expect(storage.records.has(tabs[0].currentSessionId)).toBe(false)
  })

  it('the byte budget counts what other tabs stored too', async () => {
    const storage = new MemoryHistoryStorage()
    const limits = { maxBytes: 20_000, reservedBytes: 4_000 }
    const older = new DiagnosticHistory(storage, () => 1_000_000, limits)
    const newer = new DiagnosticHistory(storage, () => 1_000_001, limits)
    await Promise.all([older.whenReady(), newer.whenReady()])
    for (const h of [older, newer]) {
      for (let i = 0; i < 200; i += 1) h.record('machine.state', { state: i % 2 ? 'idle' : 'run' })
      await h.flush()
    }
    const stored = () => [...storage.records.values()].reduce((sum, r) => sum + r.events.reduce((s, e) => s + JSON.stringify(e).length, 0), 0)
    expect(stored()).toBeGreaterThan(limits.maxBytes)
    await newer.prune()
    expect(stored()).toBeLessThanOrEqual(limits.maxBytes)
    expect(storage.records.has(newer.currentSessionId)).toBe(true)
  })

  it('expiry also runs while the app stays open, on every read and write', async () => {
    // Audit 2026-10-13: a page left open past seven days must neither export
    // nor write back what has expired, even with recording switched off.
    const storage = new MemoryHistoryStorage()
    await storage.put({
      id: 'earlier', startedAt: 999_000, eventAt: [999_500], endedCleanly: true, dropped: 0, lastSeq: 1, generation: 0,
      omissions: { unknownCodes: 0, unknownFields: 0, invalidFields: 0, oversizeEvents: 0 },
      events: [{ v: 1, code: 'machine.state', seq: 1, t: 0, fields: { state: 'idle' } }],
    })
    let now = 1_000_000
    const h = new DiagnosticHistory(storage, () => now)
    const advance = (ms: number) => { now += ms }
    await h.whenReady()
    expect(h.snapshot('earlier')!.events).toHaveLength(1)
    h.record('machine.state', { state: 'idle' })
    await h.flush()
    h.setRecording(false)
    advance(HISTORY_MAX_AGE_MS + 1)
    expect(h.snapshot(h.currentSessionId)!.events).toHaveLength(0)
    expect(h.snapshot('earlier')).toBeNull()
    expect(h.summaries().map((s) => s.eventCount)).toEqual([0])
    h.setRecording(true)
    h.record('machine.state', { state: 'run' })
    await h.flush()
    expect([...storage.records.keys()]).toEqual([h.currentSessionId])
    expect(storage.records.get(h.currentSessionId)!.events.map((e) => e.fields)).toEqual([{ state: 'run' }])
  })

  it('ordinary events cannot evict the reserved failure share', async () => {
    // Same rule as the 5 MiB / 1 MiB default, at a size a test can fill fast.
    const h = new DiagnosticHistory(new MemoryHistoryStorage(), () => 1_000_000, { maxBytes: 20_000, reservedBytes: 4_000 })
    await h.whenReady()
    h.record('machine.alarm', { code: 9, positionLost: false })
    for (let i = 0; i < 2_000; i += 1) {
      h.record('machine.state', { state: i % 2 ? 'idle' : 'run' })
      if (i % 200 === 0) await h.flush()
    }
    expect(h.storedBytes()).toBeLessThanOrEqual(20_000)
    expect(h.summaries()[0].dropped).toBeGreaterThan(0)
    expect(h.snapshot(h.currentSessionId)!.events.some((e) => e.code === 'machine.alarm')).toBe(true)
    // Sequence numbers keep counting through eviction: a removed-event choice can never hit a reused number.
    const seqs = h.snapshot(h.currentSessionId)!.events.map((e) => e.seq)
    expect(new Set(seqs).size).toBe(seqs.length)
    expect(seqs.at(-1)).toBe(2_001)
  })

  it('the default budget is 5 MiB with 1 MiB reserved', () => {
    expect(HISTORY_MAX_BYTES).toBe(5 * 1024 * 1024)
  })

  it('the previous session that never closed is reported once', async () => {
    const storage = new MemoryHistoryStorage()
    const first = new DiagnosticHistory(storage, () => 1000)
    await first.whenReady()
    first.record('session.start', { surface: 'web' })
    await first.flush()
    const second = new DiagnosticHistory(storage, () => 2000)
    await second.whenReady()
    expect(second.previousEndedUnexpectedly).toBe(true)
    second.endSession()
    await second.flush()
    const third = new DiagnosticHistory(storage, () => 3000)
    await third.whenReady()
    expect(third.previousEndedUnexpectedly).toBe(false)
  })
})

describe('WO-2759 basic environment buckets', () => {
  it('memory and scale are coarse groups; no device text survives', () => {
    expect(basicEnvironment({ ...PROBE, deviceMemory: 32 }).ram).toBe('<=32 GiB')
    expect(basicEnvironment({ ...PROBE, deviceMemory: 4 }).ram).toBe('<=8 GiB')
    expect(basicEnvironment({ ...PROBE, deviceMemory: 64 }).ram).toBe('>32 GiB')
    expect(basicEnvironment({ ...PROBE, deviceMemory: null }).ram).toBe('unavailable')
    const basic = basicEnvironment(PROBE)
    expect(basic).toEqual({ osFamily: 'windows', ram: '<=8 GiB', gpuFamily: 'nvidia', displayScale: '<=150%' })
    expect(JSON.stringify(basic)).not.toMatch(/DESKTOP|RTX|3060|31\.0/)
  })
})

describe('WO-2759 report ZIP', () => {
  it('all off is valid and holds only the format version and manifest', async () => {
    const src = await sources()
    const report = await buildReport(ALL_OFF, src)
    expect(report.problems).toEqual([])
    expect(zipNames(report.zip)).toEqual(['README.txt', 'manifest.json'])
    const files = unzipSync(report.zip)
    const manifest = JSON.parse(strFromU8(files['manifest.json']))
    expect(manifest.reportFormat).toBe(1)
    expect(manifest.files).toEqual([])
    const all = strFromU8(files['README.txt']) + strFromU8(files['manifest.json'])
    for (const leak of [...SECRETS, '0.36.0', 'abc1234', 'NVIDIA', 'windows', 'pocket_2d', 'Version 0.36']) expect(all).not.toContain(leak)
    expect(strFromU8(files['README.txt'])).toContain('Application build: not included')
  })

  it.each(CATEGORY_IDS)('turning on %s adds exactly its files', async (id: CategoryId) => {
    const src = await sources()
    const report = await buildReport({ ...ALL_OFF, [id]: true }, src)
    const added = zipNames(report.zip).filter((n) => n !== 'README.txt' && n !== 'manifest.json')
    expect(added).toHaveLength(1)
    expect(CATEGORY_FILES[id]).toContain(added[0])
  })

  it('the defaults are the recommended basics only', async () => {
    const report = await buildReport(DEFAULT_CHOICES, await sources())
    expect(zipNames(report.zip)).toEqual(['README.txt', 'app-versions.json', 'environment.json', 'events.jsonl', 'machine-state.json', 'manifest.json'])
  })

  it('the preview equals the ZIP contents byte for byte', async () => {
    const report = await buildReport(ALL_ON, await sources())
    const unzipped = unzipSync(report.zip)
    expect(Object.keys(unzipped).sort()).toEqual(report.files.map((f) => f.name).sort())
    for (const f of report.files) expect(Buffer.from(unzipped[f.name]).equals(Buffer.from(f.bytes))).toBe(true)
    const manifest = JSON.parse(strFromU8(unzipped['manifest.json']))
    for (const entry of manifest.files) {
      const shown = report.files.find((f) => f.name === entry.name)!
      expect(entry.sha256).toBe(shown.sha256)
      expect(entry.bytes).toBe(shown.size)
    }
  })

  it('the same choices build identical bytes (normalized timestamps)', async () => {
    const src = await sources()
    const a = await buildReport(DEFAULT_CHOICES, src)
    const b = await buildReport(DEFAULT_CHOICES, src)
    expect(Buffer.from(a.zip).equals(Buffer.from(b.zip))).toBe(true)
  })

  it('default categories carry no private value; originals keep their bytes', async () => {
    const src = await sources()
    const defaults = await buildReport({ ...DEFAULT_CHOICES, operationSettings: true }, src)
    const text = defaults.files.map((f) => f.text ?? '').join('\n')
    for (const leak of SECRETS) expect(text).not.toContain(leak)
    expect(text).not.toContain('X-1')
    const withProject = await buildReport({ ...ALL_OFF, originalProject: true }, src)
    expect(Buffer.from(unzipSync(withProject.zip)['project.camproject']).equals(Buffer.from(src.project!.bytes))).toBe(true)
  })

  it('a removed event leaves the export copy only', async () => {
    const src = await sources()
    const removed = src.incident!.events[1].seq
    const report = await buildReport({ ...ALL_OFF, eventHistory: true }, src, new Set([removed]))
    const lines = strFromU8(unzipSync(report.zip)['events.jsonl']).trim().split('\n').map((l) => JSON.parse(l))
    expect(lines.map((l) => l.seq)).not.toContain(removed)
    expect(lines).toHaveLength(src.incident!.events.length - 1)
  })

  it('an exported alarm keeps its event code and its alarm number (audit 5)', async () => {
    const src = await sources()
    const report = await buildReport({ ...ALL_OFF, eventHistory: true }, src)
    const lines = strFromU8(unzipSync(report.zip)['events.jsonl']).trim().split('\n').map((l) => JSON.parse(l))
    expect(lines.map((l) => l.code)).toEqual(src.incident!.events.map((e) => e.code))
    const alarm = lines.find((l) => l.code === 'machine.alarm')
    expect(alarm.fields).toEqual({ code: 2, positionLost: true })
  })

  it('an omitted attachment leaves no name, hash or value behind', async () => {
    const src = await sources()
    const on = await buildReport({ ...ALL_OFF, originalProgram: true }, src)
    const hash = on.files.find((f) => f.name === 'program.nc')!.sha256
    const off = await buildReport(ALL_OFF, src)
    const all = off.files.map((f) => f.text).join('\n')
    expect(all).not.toContain(hash)
    expect(all).not.toContain('program.nc')
  })

  it('an over-limit attachment blocks Save with a plain reason', async () => {
    const src = await sources()
    src.program = { bytes: new Uint8Array(26 * 1024 * 1024) }
    const report = await buildReport({ ...ALL_OFF, originalProgram: true }, src)
    expect(report.zip.length).toBe(0)
    expect(report.problems[0]).toMatch(/program\.nc is larger than 25 MiB/)
  })
})

describe('WO-2759 GitHub prefill', () => {
  it('holds only the shown fields, and nothing from a removed category', async () => {
    const src = await sources()
    const report = await buildReport(DEFAULT_CHOICES, src)
    const fields = prefillFields(report, src)
    expect(fields.map((f) => f.id)).toEqual(['version', 'os', 'controller'])
    const url = new URL(issueFormUrl(fields))
    expect(url.origin + url.pathname).toBe('https://github.com/eclsnowman/LienCAM/issues/new')
    expect([...url.searchParams.keys()].sort()).toEqual(['controller', 'os', 'template', 'version'])
    expect(url.searchParams.get('controller')).toBe('UCCNC with UC100')
    for (const leak of [...SECRETS, 'NVIDIA', 'pocket_2d', 'alarm']) expect(url.href).not.toContain(encodeURIComponent(leak))

    const without = await buildReport({ ...DEFAULT_CHOICES, appVersions: false, machineState: false }, src)
    const kept = prefillFields(without, src)
    expect(kept.map((f) => f.id)).toEqual(['os'])
    expect(issueFormUrl(kept)).not.toContain('0.36.0')

    // A field the user unticks leaves the URL too.
    const url2 = new URL(issueFormUrl(fields.filter((f) => f.id !== 'os')))
    expect(url2.searchParams.has('os')).toBe(false)
  })
})
