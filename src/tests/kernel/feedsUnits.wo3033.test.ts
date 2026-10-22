// WO-3033 (alpha.3 A3-15): unit tests for the kernel feed/speed service at parity -
// rule-data keying (each key dimension selects the documented row; an unmatched key
// falls back exactly as today), one cutting-data entry for feed and spindle, the
// carded flags off (MD-75 / MD-77), role coverage (every WO-3026 role has a feed row),
// the ruleset schema, provenance and one-line reports, headless imports, no app caller.

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import type { FeedsAndSpeeds, Tool } from '../../types'
import { MOVE_ROLES, ROLE_FEED_TABLE } from '../../kernel/linking/roles'
import * as feeds from '../../kernel/feeds'
import type { FeedRule, FeedRuleKey, FeedRuleset } from '../../kernel/feeds'

const root = process.cwd()
const rel = (path: string) => relative(root, path).split(sep).join('/')
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(dir, entry.name)
    return entry.isDirectory() ? files(path) : /\.[cm]?tsx?$/.test(path) ? [path] : []
  })
}
function imports(path: string, text = readFileSync(path, 'utf8')): string[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  const found: string[] = []
  const visit = (node: ts.Node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) found.push(node.moduleSpecifier.text)
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      const arg = node.arguments[0]
      found.push(arg && ts.isStringLiteral(arg) ? arg.text : '<nonliteral-import>')
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

const entry = (feedRate: number, rpm: number, extra: Partial<FeedsAndSpeeds> = {}): FeedsAndSpeeds =>
  ({ rpm, feedRate, plungeRate: feedRate / 4, depthOfCut: 1, stepover: 1, ...extra })
const tool = (feedsAndSpeeds: Tool['feedsAndSpeeds'], over: Partial<Tool> = {}): Tool => ({
  id: 't', name: 'T6', type: 'flat_end_mill', diameter: 6, fluteLength: 20, shankDiameter: 6,
  overallLength: 50, numberOfFlutes: 2, material: 'carbide', coating: 'none', notes: '', feedsAndSpeeds, ...over,
})
const OPEN: Omit<FeedRuleKey, 'role'> = { material: '*', toolType: '*', diameterMm: '*', coating: '*', rigidity: '*' }
const rule = (id: string, key: Partial<FeedRuleKey>, rate: FeedRule['rate']): FeedRule => ({
  id, key: { role: 'cut', ...OPEN, ...key }, rate, units: 'mm/min',
  source: [{ kind: 'maker-publication', cite: 'https://example.invalid/fixture' }], confidence: 'EXT-starting-window',
})
// The keying fixture: one row per key dimension, each naming a rate the parity row does not.
const KEYED: FeedRuleset = feeds.validateRuleset({
  ...feeds.PARITY_RULESET,
  id: 'fixture.keying', version: '0.0.1',
  rules: [
    ...feeds.PARITY_RULESET.rules,
    rule('by-material', { material: 'aluminium' }, 'leadInRate'),
    rule('by-tool-type', { toolType: 'ball_end_mill' }, 'finishRate'),
    rule('by-diameter', { diameterMm: [2, 3] }, 'rampRate'),
    rule('by-coating', { coating: 'tialn' }, 'plungeRate'),
    rule('by-rigidity', { rigidity: 'light' }, 'leadOutRate'),
    rule('by-role', { role: 'stepover', toolType: 'ball_end_mill' }, 'fastTraverseRate'),
  ],
})

describe('WO-3033 rule-data keying', () => {
  const at = (q: Partial<feeds.RuleQuery>) => feeds.roleFeed(KEYED, { role: 'cut', toolType: 'flat_end_mill', diameterMm: 6, coating: 'none', ...q })
  it.each([
    ['material', { material: 'aluminium' }, 'by-material', 'leadInRate'],
    ['tool type', { toolType: 'ball_end_mill' as const }, 'by-tool-type', 'finishRate'],
    ['diameter interval (inside, both ends)', { diameterMm: 2 }, 'by-diameter', 'rampRate'],
    ['diameter interval (upper end)', { diameterMm: 3 }, 'by-diameter', 'rampRate'],
    ['coating', { coating: 'tialn' as const }, 'by-coating', 'plungeRate'],
    ['rigidity', { rigidity: 'light' as const }, 'by-rigidity', 'leadOutRate'],
  ])('the %s dimension selects its row', (_name, q, id, rate) => {
    expect(at(q)).toEqual({ role: 'cut', rate, provenance: { ruleId: id, version: '0.0.1' } })
  })
  it('the role dimension: a row for one role never feeds another, and the more specific row wins', () => {
    expect(feeds.roleFeed(KEYED, { role: 'stepover', toolType: 'ball_end_mill' }).provenance).toEqual({ ruleId: 'by-role', version: '0.0.1' })
    expect(feeds.roleFeed(KEYED, { role: 'stepover', toolType: 'ball_end_mill' }).rate).toBe('fastTraverseRate')
    expect(feeds.roleFeed(KEYED, { role: 'plunge', toolType: 'ball_end_mill' }).rate).toBe('plungeRate')
  })
  it('an unmatched key falls back to the open parity row: just outside the interval, other material, absent rigidity', () => {
    for (const q of [{ diameterMm: 3.0001 }, { diameterMm: 1.9999 }, { material: 'steel' }, { rigidity: 'rigid' as const }, {}]) {
      expect(at(q)).toEqual({ role: 'cut', rate: 'feedRate', provenance: { ruleId: 'parity.role.cut', version: '0.0.1' } })
    }
  })
  it('a key matched by no row at all proceeds exactly as today: the WO-3026 row, "tool library, no rule"', () => {
    const empty = feeds.validateRuleset({ ...feeds.PARITY_RULESET, rules: [] })
    for (const role of MOVE_ROLES) {
      expect(feeds.roleFeed(empty, { role })).toEqual({ role, rate: ROLE_FEED_TABLE[role].rate, provenance: 'tool library, no rule' })
    }
    const svc = feeds.createFeedSpeedService(empty)
    expect(svc.resolve({ tool: tool({ default: entry(1000, 18000) }) }).roles.finish.provenance).toBe('tool library, no rule')
  })
  it('equal specificity: the earlier row wins', () => {
    const tie = feeds.validateRuleset({ ...KEYED, rules: [rule('first', { coating: 'tin' }, 'leadInRate'), rule('second', { material: 'pine' }, 'leadOutRate')] })
    expect(feeds.matchRule(tie, { role: 'cut', coating: 'tin', material: 'pine' })?.id).toBe('first')
  })
})

describe('WO-3033 one cutting-data entry for feed and spindle', () => {
  const t = tool({ default: entry(1000, 18000), aluminium: entry(700, 12000, { rampFeedrate: 222 }) })
  const md75 = feeds.createFeedSpeedService(feeds.PARITY_RULESET, { md75_material_entry: true, md77_chip_thinning: false })
  it('parity: the material is never consulted; feed and spindle both read "default"', () => {
    const r = feeds.createFeedSpeedService().resolve({ tool: t, material: 'aluminium' })
    expect(r.selection).toEqual({ key: 'default', entry: t.feedsAndSpeeds.default, how: 'default', materialAsked: 'aluminium' })
    expect([r.feedEntryKey, r.rates.feedRate, r.spindle.requestedRpm]).toEqual(['default', 1000, 18000])
  })
  it('MD-75 on: a material hit feeds both from that entry; a miss takes default; no default takes the first - for both', () => {
    const hit = md75.resolve({ tool: t, material: 'aluminium' })
    expect([hit.selection.how, hit.feedEntryKey, hit.rates.feedRate, hit.rates.rampRate, hit.spindle.requestedRpm]).toEqual(['material', 'aluminium', 700, 222, 12000])
    const miss = md75.resolve({ tool: t, material: 'oak' })
    expect([miss.selection.how, miss.rates.feedRate, miss.spindle.requestedRpm]).toEqual(['default', 1000, 18000])
    const noDefault = md75.resolve({ tool: tool({ brass: entry(500, 9000), pine: entry(2000, 20000) }) })
    expect([noDefault.selection.key, noDefault.rates.feedRate, noDefault.spindle.requestedRpm]).toEqual(['brass', 500, 9000])
  })
  it('parity keeps RC-019: with no "default" entry the spindle reads the first entry and the feed stage reads none (today)', () => {
    const r = feeds.createFeedSpeedService().resolve({ tool: tool({ brass: entry(500, 9000) }) })
    expect([r.selection.key, r.feedEntryKey, r.spindle.requestedRpm, r.rates.feedRate, r.rates.plungeRate]).toEqual(['brass', null, 9000, 300, 100])
  })
  it('a tool with no entries proceeds on the fallbacks at 0 rpm requested, as today', () => {
    const r = feeds.createFeedSpeedService().resolve({ tool: tool({}) })
    expect([r.selection.how, r.spindle.requestedRpm, r.spindle.provenance, r.rates.feedRate]).toEqual(['none', 0, 'no cutting data', 300])
  })
})

describe('WO-3033 carded flags ship off', () => {
  it('the parity policy is frozen with MD-75 and MD-77 off, and is the service default', () => {
    expect(feeds.PARITY_FEED_POLICY).toEqual({ md75_material_entry: false, md77_chip_thinning: false })
    expect(Object.isFrozen(feeds.PARITY_FEED_POLICY)).toBe(true)
    expect(feeds.createFeedSpeedService().policy).toBe(feeds.PARITY_FEED_POLICY)
    expect(feeds.createFeedSpeedService().ruleset).toBe(feeds.PARITY_RULESET)
  })
  it('MD-77 off ignores a stated engagement; on, it applies the A.4.1 relation (ae 0.10 D -> Kr 0.60)', () => {
    const t = tool({ default: entry(1200, 18000) })
    expect(feeds.createFeedSpeedService().resolve({ tool: t, aeOverD: 0.1 }).rates.feedRate).toBe(1200)
    const on = feeds.createFeedSpeedService(feeds.PARITY_RULESET, { md75_material_entry: false, md77_chip_thinning: true }).resolve({ tool: t, aeOverD: 0.1 })
    expect(on.rates.feedRate).toBeCloseTo(2000, 9)
    expect(on.reports).toHaveLength(1)
    expect(feeds.chipThinningFactor(0.1)).toBeCloseTo(0.6, 12)
    expect(feeds.chipThinningFactor(0.5)).toBe(1)
    expect(feeds.chipThinningFactor(0.8)).toBe(1)
  })
})

describe('WO-3033 role coverage and ruleset schema', () => {
  it('every WO-3026 role has exactly one parity feed row, at the WO-3026 rate', () => {
    for (const role of MOVE_ROLES) {
      const rows = feeds.PARITY_RULESET.rules.filter(r => r.key.role === role)
      expect(rows, role).toHaveLength(1)
      expect(rows[0].rate, role).toBe(ROLE_FEED_TABLE[role].rate)
      expect(Object.values(rows[0].key).filter(v => v === '*'), role).toHaveLength(5)
    }
    expect(feeds.PARITY_RULESET.rules).toHaveLength(MOVE_ROLES.length)
  })
  it('every stage and rule has a source and units; the parity data cites only today\'s code', () => {
    for (const x of [...feeds.PARITY_RULESET.stages, ...feeds.PARITY_RULESET.rules]) {
      expect(x.units).toBe('mm/min')
      expect(x.source.length).toBeGreaterThan(0)
      for (const s of x.source) expect(s).toMatchObject({ kind: 'liencam-current', cite: expect.stringMatching(/^src\//) })
    }
    expect(feeds.PARITY_RULESET.rules.every(r => r.confidence === 'current-behaviour')).toBe(true)
  })
  it('the schema check rejects a sourceless, unitless, mis-ordered or badly cited ruleset', () => {
    const p = feeds.PARITY_RULESET
    const bad: [string, FeedRuleset][] = [
      ['no source', { ...p, rules: [{ ...p.rules[0], source: [] }] }],
      ['no units', { ...p, rules: [{ ...p.rules[0], units: 'in/min' as 'mm/min' }] }],
      ['repeated id', { ...p, rules: [p.rules[0], p.rules[0]] }],
      ['interval', { ...p, rules: [rule('x', { diameterMm: [3, 2] }, 'feedRate')] }],
      ['http maker source', { ...p, rules: [{ ...rule('x', {}, 'feedRate'), source: [{ kind: 'maker-publication', cite: 'http://x' }] }] }],
      ['stage order', { ...p, stages: [p.stages[2], p.stages[0], p.stages[1]] }],
      ['version', { ...p, version: 'v1' }],
    ]
    for (const [name, ruleset] of bad) expect(() => feeds.validateRuleset(ruleset), name).toThrow(/feeds ruleset/)
    expect(feeds.validateRuleset(p)).toBe(p)
  })
})

describe('WO-3033 provenance and reports (rule 11: proceeds, says so, refuses nothing)', () => {
  it('each rate says where it came from; a missing tool feed proceeds on today\'s fallback with one line', () => {
    const r = feeds.createFeedSpeedService().resolve({ tool: tool({ default: { rpm: 18000 } as FeedsAndSpeeds }), machineRapidRate: 5000 })
    expect(r.rateProvenance).toEqual({
      feedRate: { from: 'safety-fallback', value: 300 }, plungeRate: { from: 'safety-fallback', value: 100 },
      rampRate: { from: 'derived', stage: 'plungeRate' }, leadInRate: { from: 'derived', stage: 'feedRate' },
      leadOutRate: { from: 'derived', stage: 'feedRate' }, fastTraverseRate: { from: 'machine-rapid' },
      finishRate: { from: 'derived', stage: 'feedRate' },
    })
    expect(r.reports).toEqual(['Tool "T6" has no feedRate; using 300 mm/min.', 'Tool "T6" has no plungeRate; using 100 mm/min.'])
    expect(r.roles.cut.provenance).toEqual({ ruleId: 'parity.role.cut', version: '1.0.0' })
  })
  it('an rpm outside the machine range proceeds clamped, in one line', () => {
    const r = feeds.createFeedSpeedService().resolve({ tool: tool({ default: entry(1000, 30000) }), machine: { minSpindleRpm: 6000, maxSpindleRpm: 24000 } })
    expect([r.spindle.requestedRpm, r.spindle.rpm, r.reports]).toEqual([30000, 24000, ["Spindle asked 30000 rpm; posted 24000 within the machine's range."]])
  })
  it('feedForMove: own feed wins, deferred roles take their row, others stay feed-less', () => {
    const r = feeds.createFeedSpeedService().resolve({ tool: tool({ default: entry(1000, 18000, { finishFeedrate: 640 }) }), machineRapidRate: 4000 })
    expect(feeds.feedForMove({ feed: 77, role: 'finish' }, r)).toBe(77)
    expect(feeds.feedForMove({ role: 'finish' }, r)).toBe(640)
    expect(feeds.feedForMove({ role: 'fast_traverse' }, r)).toBe(4000)
    expect(feeds.feedForMove({ role: 'cut' }, r)).toBeUndefined()
    expect(feeds.feedForMove({}, r)).toBeUndefined()
    expect(feeds.feedForMove({ role: 'bogus' }, r)).toBeUndefined()
  })
})

describe('WO-3033 kernel feeds are headless, deterministic and called by no app path', () => {
  it('imports only its own files, the WO-3026 role table and src/types', () => {
    const offending = files(resolve('src/kernel/feeds')).flatMap(path => imports(path)
      .filter(specifier => {
        const target = rel(resolve(dirname(path), specifier)).replace(/\.(ts|tsx)$/, '')
        return !(specifier.startsWith('.') && (target.startsWith('src/kernel/feeds/') || target === 'src/kernel/linking/roles' || target === 'src/types'))
      })
      .map(specifier => `${rel(path)} -> ${specifier}`))
    expect(offending).toEqual([])
    for (const path of files(resolve('src/kernel/feeds'))) {
      expect(readFileSync(path, 'utf8'), rel(path)).not.toMatch(/Math\.random|Date\.now|new Date\(|performance\.now|window\.|document\.|console\./)
    }
  })
  it('the same request gives a byte-identical result', () => {
    const run = () => feeds.createFeedSpeedService().resolve({ tool: tool({ default: entry(1000, 18000) }), machineRapidRate: 5000, material: 'x' })
    expect(JSON.stringify(run())).toBe(JSON.stringify(run()))
  })
  it('no file under src outside the service and src/tests imports src/kernel/feeds (negative control included)', () => {
    const callers = files(resolve('src'))
      .filter(path => !rel(path).startsWith('src/kernel/feeds/') && !rel(path).startsWith('src/tests/'))
      .flatMap(path => imports(path)
        .filter(specifier => specifier.startsWith('.') && rel(resolve(dirname(path), specifier)).startsWith('src/kernel/feeds'))
        .map(specifier => `${rel(path)} -> ${specifier}`))
    expect(callers).toEqual([])
    expect(imports(resolve('src/store/negative-control.ts'), "import { createFeedSpeedService } from '../kernel/feeds'")
      .filter(specifier => rel(resolve(resolve('src/store'), specifier)).startsWith('src/kernel/feeds'))).toEqual(['../kernel/feeds'])
  })
})
