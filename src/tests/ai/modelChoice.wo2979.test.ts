import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  aiSendGate,
  initialAiModelChoiceState,
  reduceAiModelChoice,
  rememberedAiModel,
  sameAiModel,
  type AiModelChoiceState,
  type AiModelEvent,
} from '../../lib/ai/modelChoice'
import { readAiModelChoices, saveOperatorAiModelPick } from '../../store/aiModelChoice'
import {
  BACKED_UP_LOCAL_STORAGE_RECORDS,
  PERSISTED_USER_DATA_REGISTRY,
} from '../../store/persistedKeys'
import { createFakeHarness, fakeOffer } from './fakeHarness'

// The WO-2956 design's contract scenarios, loaded unchanged, so the design and the product cannot drift.
const SCENARIOS_FILE = fileURLToPath(new URL('../evidence/WO-2956/scenarios.json', import.meta.url))
const SOURCE_ROOT = fileURLToPath(new URL('../../', import.meta.url))

interface ScenarioStep { event: AiModelEvent; expect?: Record<string, unknown> }
interface Scenario { id: string; title: string; steps: ScenarioStep[] }

const { scenarios } = JSON.parse(readFileSync(SCENARIOS_FILE, 'utf8')) as { scenarios: Scenario[] }

/** The observable fields scenarios.json names, read from the product state. */
function view(s: AiModelChoiceState): Record<string, unknown> {
  const gate = aiSendGate(s)
  const turn = s.lastTurn
  return {
    requested: s.requested?.modelId ?? null,
    running: s.running.model?.modelId ?? null,
    source: s.running.source,
    pending: s.pending?.modelId ?? null,
    notice: s.notice,
    gate: gate.ok ? 'open' : gate.code,
    remembered: s.harness ? (rememberedAiModel(s.remembered, s.projectId, s.harness.id)?.modelId ?? null) : null,
    sentCount: s.sendCount,
    lastSent: s.sendCount > 0 ? (s.lastSentModel?.modelId ?? null) : null,
    lastTurn: turn ? `${turn.requested?.modelId ?? '-'}>${turn.running?.modelId ?? '?'}:${turn.source}` : null,
  }
}

/** I1-I5 (WO-2956 PLAN.md section 3), checked on every step whatever the scenario expects. */
function invariantProblems(prev: AiModelChoiceState, next: AiModelChoiceState, e: AiModelEvent): string[] {
  const problems: string[] = []
  const loadsOwnPick = e.type === 'operator-select' || e.type === 'project-opened'
    || e.type === 'harness-connected' || e.type === 'ai-off'
  if (!loadsOwnPick && !sameAiModel(prev.requested, next.requested) && !(prev.requested === null && next.requested === null)) {
    problems.push('I1 requested changed without an operator choice')
  }
  if (loadsOwnPick && e.type !== 'operator-select' && e.type !== 'ai-off' && next.requested !== null
    && !sameAiModel(next.requested, rememberedAiModel(next.remembered, next.projectId, next.harness?.id))) {
    problems.push('I1 a load set a pick that is not this project\'s own')
  }
  if (next.sendCount > prev.sendCount && next.lastSentModel && !sameAiModel(next.lastSentModel, next.requested)) {
    problems.push('I2 a send named a model other than the operator\'s')
  }
  if (next.sendCount > prev.sendCount && next.harness?.route === 'endpoint' && !next.lastSentModel) {
    problems.push('I2 an endpoint send named no model')
  }
  if (e.type === 'agent-text' && JSON.stringify(prev) !== JSON.stringify(next)) problems.push('I3 a self-report changed state')
  if (!next.aiOn && (next.sendCount > prev.sendCount || next.listing.status !== 'not-listed')) {
    problems.push('I4 listed or sent while AI off')
  }
  if (JSON.stringify(prev.remembered) !== JSON.stringify(next.remembered) && e.type !== 'operator-select') {
    problems.push('I5 remembered changed without an operator choice')
  }
  return problems
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

class MemoryStorage {
  readonly values = new Map<string, string>()
  writes = 0
  getItem(name: string): string | null { return this.values.get(name) ?? null }
  setItem(name: string, value: string): void { this.writes += 1; this.values.set(name, value) }
  removeItem(name: string): void { this.values.delete(name) }
}

const KEY = PERSISTED_USER_DATA_REGISTRY.aiModelChoice.key
let storage: MemoryStorage

beforeEach(() => {
  storage = new MemoryStorage()
  vi.stubGlobal('localStorage', storage)
})
afterEach(() => { vi.unstubAllGlobals() })

/** Feeds events through the core and saves after each one, as the host will. */
function drive(events: AiModelEvent[], start = initialAiModelChoiceState(readAiModelChoices())): AiModelChoiceState {
  let s = start
  for (const e of events) {
    s = reduceAiModelChoice(s, e)
    saveOperatorAiModelPick(e, s)
  }
  return s
}

const AGENT = { id: 'acp:fake-agent', route: 'acp', name: 'Fake agent', canList: true, canSwitch: true } as const
const ENDPOINT = { id: 'endpoint:fake', route: 'endpoint', name: 'Fake endpoint', canList: true, canSwitch: true } as const
const alpha = { providerId: 'fake', modelId: 'fake/alpha' }
const beta = { providerId: 'fake', modelId: 'fake/beta' }

describe('WO-2979 AI model choice core against the WO-2956 contract scenarios', () => {
  it('loads all 18 scenarios and 134 steps unchanged', () => {
    expect(scenarios.map((sc) => sc.id)).toEqual(Array.from({ length: 18 }, (_, i) => `F${i + 1}`))
    expect(scenarios.reduce((n, sc) => n + sc.steps.length, 0)).toBe(134)
  })

  for (const scenario of scenarios) {
    it(`${scenario.id}: ${scenario.title}`, () => {
      let s = initialAiModelChoiceState()
      const failures: string[] = []
      scenario.steps.forEach((step, i) => {
        // The reducer returns a new state and never mutates the one it was given.
        const next = reduceAiModelChoice(deepFreeze(s), step.event)
        for (const p of invariantProblems(s, next, step.event)) failures.push(`step ${i + 1}: ${p}`)
        s = next
        const got = view(s)
        for (const [field, want] of Object.entries(step.expect ?? {})) {
          if (got[field] !== want) {
            failures.push(`step ${i + 1} (${step.event.type}): ${field} expected ${JSON.stringify(want)} got ${JSON.stringify(got[field])}`)
          }
        }
        // A closed gate always says why.
        if (!aiSendGate(s).ok) expect(s.notice).not.toBeNull()
      })
      expect(failures).toEqual([])
    })
  }
})

describe('WO-2979 remembered pick on this computer', () => {
  it('is declared once, kept out of backups, and stored under the registry key', () => {
    const definition = PERSISTED_USER_DATA_REGISTRY.aiModelChoice
    expect(definition.key).toBe('liencam-ai-model-choice')
    expect(definition.storage).toBe('local-storage')
    expect(definition.backup).toBe(false)
    expect(BACKED_UP_LOCAL_STORAGE_RECORDS.map((record) => record.key)).not.toContain(definition.key)
  })

  it('survives a reload round-trip and is applied to the new agent session', async () => {
    const agent = createFakeHarness({ info: AGENT, offers: [fakeOffer('fake/alpha'), fakeOffer('fake/beta')], current: alpha })
    drive([
      { type: 'ai-on' },
      { type: 'project-opened', projectId: 'P1' },
      agent.connectedEvent(),
      { type: 'listing', offers: [alpha, beta] },
      { type: 'operator-select', model: beta },
    ])
    expect(JSON.parse(storage.getItem(KEY)!)).toEqual({ P1: { [AGENT.id]: beta } })

    // Reload: a fresh core reads the stored pick; the agent starts on its own default.
    let s = drive([
      { type: 'ai-on' },
      { type: 'project-opened', projectId: 'P1' },
      agent.connectedEvent(),
    ], initialAiModelChoiceState(readAiModelChoices()))
    expect(view(s)).toMatchObject({ requested: 'fake/beta', running: 'fake/alpha', gate: 'requested-not-active' })

    const listed = await agent.listModels()
    if (!listed.ok) throw new Error(listed.message)
    s = drive([{ type: 'listing', offers: listed.offers }], s)
    expect(view(s)).toMatchObject({ pending: 'fake/beta', gate: 'switch-pending' })

    // Intent only: the host, not the core, calls the harness with the pending pick.
    expect(agent.calls.filter((c) => c.method === 'switchModel')).toEqual([])
    const answer = await agent.switchModel!(s.pending!)
    s = drive([answer.ok ? { type: 'switch-confirmed', current: answer.current } : { type: 'switch-refused', message: answer.message }], s)
    expect(view(s)).toMatchObject({ requested: 'fake/beta', running: 'fake/beta', source: 'harness', gate: 'open' })
  })

  it('is not erased when the pick is Unavailable after a reload', () => {
    drive([
      { type: 'ai-on' },
      { type: 'project-opened', projectId: 'P1' },
      { type: 'harness-connected', harness: AGENT, current: alpha },
      { type: 'operator-select', model: beta },
    ])
    const before = storage.getItem(KEY)
    const writes = storage.writes
    const s = drive([
      { type: 'ai-on' },
      { type: 'project-opened', projectId: 'P1' },
      { type: 'harness-connected', harness: AGENT, current: alpha },
      { type: 'listing', offers: [alpha] },
      { type: 'send' },
      { type: 'ai-off' },
    ], initialAiModelChoiceState(readAiModelChoices()))
    expect(s.sendCount).toBe(0)
    expect(storage.writes).toBe(writes)
    expect(storage.getItem(KEY)).toBe(before)
    expect(readAiModelChoices()).toEqual({ P1: { [AGENT.id]: beta } })
  })

  it('is written only by an accepted operator pick across every contract scenario', () => {
    for (const scenario of scenarios) {
      storage = new MemoryStorage()
      vi.stubGlobal('localStorage', storage)
      let s = initialAiModelChoiceState()
      let accepted = 0
      for (const { event } of scenario.steps) {
        const prev = s
        s = reduceAiModelChoice(s, event)
        const written = saveOperatorAiModelPick(event, s).saved
        expect(written, `${scenario.id} ${event.type}`).toBe(event.type === 'operator-select' && prev.remembered !== s.remembered)
        if (written) accepted += 1
      }
      expect(storage.writes, scenario.id).toBe(accepted)
    }
  })

  it('keeps picks per project and harness, merging rather than replacing', () => {
    drive([
      { type: 'ai-on' },
      { type: 'project-opened', projectId: 'P1' },
      { type: 'harness-connected', harness: ENDPOINT },
      { type: 'operator-select', model: alpha },
      { type: 'project-opened', projectId: 'P2' },
      { type: 'operator-select', model: beta },
      { type: 'harness-connected', harness: AGENT, current: alpha },
      { type: 'operator-select', model: alpha },
    ])
    expect(readAiModelChoices()).toEqual({
      P1: { [ENDPOINT.id]: alpha },
      P2: { [ENDPOINT.id]: beta, [AGENT.id]: alpha },
    })
    // A second core (another window) adding a pick keeps the first one's.
    const other = initialAiModelChoiceState({})
    drive([
      { type: 'ai-on' },
      { type: 'project-opened', projectId: 'P3' },
      { type: 'harness-connected', harness: ENDPOINT },
      { type: 'operator-select', model: beta },
    ], other)
    expect(Object.keys(readAiModelChoices()).sort()).toEqual(['P1', 'P2', 'P3'])
  })

  it('reads past malformed entries and never replaces an unreadable record', () => {
    storage.setItem(KEY, JSON.stringify({ P1: { good: beta, bad: { modelId: 7 } }, P2: 'nope' }))
    expect(readAiModelChoices()).toEqual({ P1: { good: beta } })

    storage.setItem(KEY, '{not json')
    expect(readAiModelChoices()).toEqual({})
    const s = drive([
      { type: 'ai-on' },
      { type: 'project-opened', projectId: 'P1' },
      { type: 'harness-connected', harness: ENDPOINT },
    ])
    const select: AiModelEvent = { type: 'operator-select', model: alpha }
    expect(saveOperatorAiModelPick(select, reduceAiModelChoice(s, select))).toEqual({ saved: false, reason: 'unreadable' })
    expect(storage.getItem(KEY)).toBe('{not json')
  })

  it('says so when the browser refuses the write, instead of dropping the pick silently', () => {
    const s = drive([
      { type: 'ai-on' },
      { type: 'project-opened', projectId: 'P1' },
      { type: 'harness-connected', harness: ENDPOINT },
    ])
    storage.setItem = () => { throw new Error('QuotaExceededError') }
    const select: AiModelEvent = { type: 'operator-select', model: alpha }
    expect(saveOperatorAiModelPick(select, reduceAiModelChoice(s, select))).toEqual({ saved: false, reason: 'write-failed' })
    expect(saveOperatorAiModelPick({ type: 'send' }, s)).toEqual({ saved: false, reason: 'not-a-pick' })
  })

  it('does not save a pick the core refused (a harness that cannot switch)', () => {
    const s = drive([
      { type: 'ai-on' },
      { type: 'project-opened', projectId: 'P1' },
      { type: 'harness-connected', harness: { id: 'mcp:client', route: 'mcp-client', name: 'Client', canList: false, canSwitch: false } },
      { type: 'operator-select', model: alpha },
    ])
    expect(s.notice).toBe('switch-not-offered')
    expect(storage.getItem(KEY)).toBeNull()
  })
})

describe('WO-2979 boundaries', () => {
  const read = (path: string) => readFileSync(`${SOURCE_ROOT}${path}`, 'utf8')
  const imports = (source: string) => ts.createSourceFile('probe.ts', source, ts.ScriptTarget.Latest, true).statements
    .flatMap((node) => (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) ? [node.moduleSpecifier.text] : [])

  it('keeps the core and the harness interface pure: no React, I/O, i18n, CAD session or machine imports', () => {
    expect(imports(read('lib/ai/modelChoice.ts'))).toEqual([])
    expect(imports(read('lib/ai/harness.ts'))).toEqual(['./modelChoice'])
    for (const file of ['lib/ai/modelChoice.ts', 'lib/ai/harness.ts']) {
      const code = read(file).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')
      expect(code, file).not.toMatch(/\b(?:fetch|XMLHttpRequest|WebSocket|ipcRenderer|localStorage|sessionStorage|require)\b/)
    }
  })

  it('touches storage only through the registry', () => {
    expect(imports(read('store/aiModelChoice.ts'))).toEqual(['../lib/ai/modelChoice', './persistedKeys'])
  })
})
