// WO-3031 (alpha.3 A3-13): unit tests for the kernel entry and leads service at parity -
// ladder-order, rated-plunge-flag-off (a non-rated tool never gets the slow-plunge rung,
// and at parity no tool does), single-helix-builder (bore / thread parity pitches),
// lead-library-parity, the policies all off, the entry reading, headless imports and no
// app caller.

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import type { ToolpathMove } from '../../types'
import * as todayMoves from '../../lib/cam/moves'
import * as todayThread from '../../lib/cam/threadHelix'
import * as kernel from '../../kernel/entry'

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

const NOT_RATED: kernel.EntryToolFacts[] = [{}, { centreCutting: false }, { plungeRated: false }, { centreCutting: false, plungeRated: false }]
const RATED: kernel.EntryToolFacts[] = [{ centreCutting: true }, { plungeRated: true }, { centreCutting: true, plungeRated: true }]
const A29: kernel.EntryPolicy = { ...kernel.PARITY_ENTRY_POLICY, slow_plunge_rung: 'rated_tools_only' }

describe('WO-3031 ladder-order', () => {
  it('the rungs run helix, ramp, open, pre-drilled, rated plunge, declared rest, ranked 1..6', () => {
    expect(kernel.ENTRY_RUNGS).toEqual(['helix', 'ramp', 'open', 'pre_drilled', 'rated_plunge', 'declared_rest'])
    kernel.ENTRY_RUNGS.forEach((rung, index) => expect(kernel.rungRank(rung)).toBe(index + 1))
  })

  it('the first fitting rung wins, in ladder order, and declared rest only when nothing fits', () => {
    const tool = RATED[0]
    for (const policy of [kernel.PARITY_ENTRY_POLICY, A29]) {
      expect(kernel.chooseEntry(policy, tool, { helix: true, ramp: true, open: true, pre_drilled: true, rated_plunge: true })).toBe('helix')
      expect(kernel.chooseEntry(policy, tool, { helix: false, ramp: true, open: true })).toBe('ramp')
      expect(kernel.chooseEntry(policy, tool, { open: true, pre_drilled: true })).toBe('open')
      expect(kernel.chooseEntry(policy, tool, { pre_drilled: true, rated_plunge: true })).toBe('pre_drilled')
      expect(kernel.chooseEntry(policy, tool, {})).toBe('declared_rest')
    }
    // Every subset of fitting rungs picks the earliest fitting one the policy offers.
    const offered = kernel.entryLadder(A29, tool)
    const fitting = offered.filter(r => r !== 'declared_rest') as Array<keyof kernel.RungFits>
    for (let mask = 0; mask < 1 << fitting.length; mask++) {
      const fits: kernel.RungFits = {}
      fitting.forEach((rung, bit) => { fits[rung] = (mask & (1 << bit)) !== 0 })
      const expected = fitting.find(rung => fits[rung]) ?? 'declared_rest'
      expect(kernel.chooseEntry(A29, tool, fits)).toBe(expected)
    }
  })

  it('the service asks the ladder under its own policy', () => {
    const service = kernel.createEntryService()
    expect(service.policy).toBe(kernel.PARITY_ENTRY_POLICY)
    expect(service.ladder(RATED[0])).toEqual(kernel.entryLadder(kernel.PARITY_ENTRY_POLICY, RATED[0]))
    expect(service.choose(RATED[0], { rated_plunge: true })).toBe('declared_rest')
    expect(kernel.createEntryService(A29).choose(RATED[0], { rated_plunge: true })).toBe('rated_plunge')
  })
})

describe('WO-3031 rated-plunge-flag-off: a non-rated tool never gets the slow-plunge rung, and at parity no tool does', () => {
  it('at parity no tool, rated or not, is offered the rung, and a fitting slow plunge alone is never chosen', () => {
    for (const tool of [...NOT_RATED, ...RATED]) {
      expect(kernel.entryLadder(kernel.PARITY_ENTRY_POLICY, tool)).not.toContain('rated_plunge')
      expect(kernel.chooseEntry(kernel.PARITY_ENTRY_POLICY, tool, { rated_plunge: true })).toBe('declared_rest')
    }
    expect(kernel.PARITY_ENTRY_POLICY.slow_plunge_rung).toBe('off')
  })

  it('with A-29 on, a tool that is not documented centre-cutting or plunge-rated still never gets it; a rated tool does, after the open starts', () => {
    for (const tool of NOT_RATED) {
      expect(kernel.toolIsPlungeRated(tool)).toBe(false)
      expect(kernel.entryLadder(A29, tool)).not.toContain('rated_plunge')
      expect(kernel.chooseEntry(A29, tool, { rated_plunge: true })).toBe('declared_rest')
    }
    for (const tool of RATED) {
      expect(kernel.toolIsPlungeRated(tool)).toBe(true)
      const ladder = kernel.entryLadder(A29, tool)
      expect(ladder).toEqual(['helix', 'ramp', 'open', 'pre_drilled', 'rated_plunge', 'declared_rest'])
      expect(kernel.chooseEntry(A29, tool, { rated_plunge: true })).toBe('rated_plunge')
      expect(kernel.chooseEntry(A29, tool, { ramp: true, rated_plunge: true })).toBe('ramp')
    }
  })
})

describe('WO-3031 single-helix-builder: one builder, bore and thread pass their own pitch', () => {
  it('the 2.5D descent equals today\'s helixDescent on a grid of radii, spans, angles, senses and samplings', () => {
    const samplings = [undefined, { kind: 'even' as const, stepsPerRev: 36, minSteps: 12 }, { kind: 'fixed' as const, stepRad: Math.PI / 16, maxPoints: 5000 }, { kind: 'fixed' as const, stepRad: 0.3, maxPoints: 7 }]
    for (const radius of [0.2, 1.7, 6]) for (const [fromZ, toZ] of [[5, -3], [0, -0.4], [2, 2]]) for (const tanAngle of [Math.tan(3 * Math.PI / 180), Math.tan(Math.PI / 12)]) {
      for (const direction of [1, -1] as const) for (const sampling of samplings) for (const pitchRadius of [undefined, radius * 1.3]) {
        const h = { centre: { x: 3, y: -2 }, radius, fromZ, toZ, tanAngle, pitchRadius, feed: 150, startAngle: 0.7, direction, sampling }
        const a: ToolpathMove[] = [], b: ToolpathMove[] = []
        const endA = todayMoves.helixDescent(a, h), endB = kernel.helixDescent(b, h)
        expect(b).toEqual(a)
        expect(endB).toEqual(endA)
      }
    }
  })

  it('Bore\'s helix: its own pitch from orbit and ramp angle, as helical arcs, equal today\'s', () => {
    for (const orbit of [0.06, 0.5, 3]) for (const rampAngleDeg of [0.1, 2, 3, 15]) for (const dir of [1, -1] as const) {
      const pitch = kernel.borePitch(orbit, rampAngleDeg)
      // bore2d.ts:213-218, in today's words.
      expect(pitch).toBe(Math.max(1e-6, 2 * Math.PI * orbit * Math.tan(Math.max(0.25, rampAngleDeg) * Math.PI / 180)))
      const spec = { cx: 4, cy: 5, radius: orbit, pitch, bottomZ: -6, topZ: 1.5, dir, descend: true, feed: 90, role: 'helix' as const, startAngle: 1.1 }
      expect(kernel.helixArcs(spec)).toEqual(todayThread.generateHelixArcs(spec))
    }
  })

  it('Thread Mill\'s helix: the thread\'s own pitch (TPI wins), as a dense polyline, equal today\'s, both ways', () => {
    expect(kernel.threadPitch({ tpi: 20, pitch: 1.5 })).toBe(25.4 / 20)
    expect(kernel.threadPitch({ tpi: 0, pitch: 1.5 })).toBe(1.5)
    expect(kernel.threadPitch({ pitch: 0.8 })).toBe(0.8)
    for (const pitch of [kernel.threadPitch({ tpi: 20, pitch: 0 }), 1, 1.75]) for (const dir of [1, -1] as const) for (const descend of [false, true]) {
      for (const [bottomZ, topZ] of [[-10, 0], [-3, -2.5], [0, 2 * pitch]]) {
        const spec = { cx: 1, cy: 1, radius: 2.5, pitch, bottomZ, topZ, dir, feed: 400, startAngle: 0.25, role: 'helix' as const, descend }
        expect(kernel.threadHelix(spec)).toEqual(todayThread.generateThreadHelix(spec))
      }
    }
    // Today's input refusals, word for word.
    for (const bad of [{ radius: 0 }, { pitch: 0 }, { topZ: -10 }]) {
      const spec = { cx: 0, cy: 0, radius: 1, pitch: 1, bottomZ: -10, topZ: 0, dir: 1 as const, feed: 1, ...bad }
      expect(() => kernel.threadHelix(spec)).toThrow((() => { try { todayThread.generateThreadHelix(spec) } catch (e) { return (e as Error).message } return 'none' })())
      expect(() => kernel.helixArcs(spec)).toThrow((() => { try { todayThread.generateHelixArcs(spec) } catch (e) { return (e as Error).message } return 'none' })())
    }
  })

  it('Adaptive 3D\'s form: per-turn segments, at least one turn, a full turn at depth, today\'s point cap', () => {
    const moves: ToolpathMove[] = []
    const r = kernel.helixOrbitRadius(1.5)
    expect(r).toBe(Math.max(1.5 - 0.01, 0.75))
    kernel.buildHelix(moves, {
      centre: { x: 0, y: 0 }, radius: r, fromZ: 0, toZ: -1, pitch: { kind: 'angle', tanAngle: Math.tan(Math.PI / 18) },
      sampling: { kind: 'turns', segmentsPerTurn: 24, cleanupTurn: true, maxPoints: 5000 }, role: 'ramp',
    })
    const atDepth = moves.filter(m => m.z === -1)
    expect(atDepth.length).toBe(24 + 1)
    expect(moves.length).toBeGreaterThanOrEqual(48)
    for (const m of moves) expect(Math.hypot(m.x, m.y)).toBeCloseTo(r, 9)
    expect(moves.every(m => m.feed === undefined && m.role === 'ramp')).toBe(true)
    expect(() => kernel.buildHelix([], {
      centre: { x: 0, y: 0 }, radius: 0.1, fromZ: 0, toZ: -100, pitch: { kind: 'angle', tanAngle: 0.01 },
      sampling: { kind: 'turns', segmentsPerTurn: 24, cleanupTurn: true, maxPoints: 5000 },
    })).toThrow(/above the 5000-point safety limit/)
  })

  it('every helix the service builds goes through buildHelix: no second helix construction in the kernel', () => {
    const helixSource = readFileSync(resolve('src/kernel/entry/helix.ts'), 'utf8')
    for (const name of ['helixDescent', 'threadHelix', 'helixArcs']) {
      const body = new RegExp(`export function ${name}\\([^]*?\\n}\\n`).exec(helixSource)?.[0] ?? ''
      expect(body, name).toMatch(/buildHelix\(/)
    }
    expect(readFileSync(resolve('src/kernel/entry/leads.ts'), 'utf8')).toMatch(/export function helixLead[^]*?buildHelix\(/)
    // Only the builder's own file samples a helix (cos with a Z per point); leads.ts samples the lead semicircle at one Z.
    const others = files(resolve('src/kernel/entry')).filter(path => !/helix\.ts$|leads\.ts$/.test(path))
    for (const path of others) expect(readFileSync(path, 'utf8'), rel(path)).not.toMatch(/Math\.cos/)
  })
})

describe('WO-3031 lead-library-parity', () => {
  it('the tangent semicircle equals today\'s generateLeadArc, lead-in and lead-out, both senses', () => {
    for (const radius of [0.4, 2.5, 7]) for (const angle of [0, 0.3, Math.PI, -2.2, 7.1]) for (const dir of [1, -1] as const) {
      for (const kindRole of ['lead_in', 'lead_out'] as const) {
        const spec = { cx: 2, cy: -1, radius, angle, dir, z: -3.25, feed: 220, kindRole }
        expect(kernel.arcLead(spec)).toEqual(todayThread.generateLeadArc(spec))
      }
    }
    expect(() => kernel.arcLead({ cx: 0, cy: 0, radius: 0, angle: 0, dir: 1, z: 0, feed: 1, kindRole: 'lead_in' })).toThrow('generateLeadArc: radius must be > 0')
  })

  it('straight, polyline and G2 / G3 leads are the moves today\'s families write inline', () => {
    const a: ToolpathMove[] = []
    kernel.straightLead(a, { x: 1, y: 2 }, -4, 300, 'lead_in')
    kernel.polylineLead(a, [{ x: 2, y: 2 }, { x: 3, y: 2.5 }], -4, 300, 'lead_out')
    kernel.arcMoveLead(a, { x: 4, y: 3 }, { x: 4, y: 2 }, 'arc_ccw', -4, 1200, 'lead_in')
    expect(a).toEqual([
      // contour2d.ts:262-265 (lead_in onto the pass), engine/emit.ts:432 (lead points), cam3d IR arcs.
      { type: 'feed', x: 1, y: 2, z: -4, feed: 300, role: 'lead_in' },
      { type: 'feed', x: 2, y: 2, z: -4, feed: 300, role: 'lead_out' },
      { type: 'feed', x: 3, y: 2.5, z: -4, feed: 300, role: 'lead_out' },
      { type: 'arc_ccw', x: 4, y: 3, z: -4, cx: 4, cy: 2, feed: 1200, role: 'lead_in' },
    ])
  })

  it('a ramp lead is the one ramp builder carrying the lead role; a helix lead the one helix builder', () => {
    const path = [{ x: 1, y: 0 }, { x: 1, y: 3 }, { x: 4, y: 3 }]
    const lead: ToolpathMove[] = []
    kernel.rampLead(lead, { x: 0, y: 0 }, path, 2, -1, 180, 'lead_in')
    const today: ToolpathMove[] = []
    const cum = [1, 4, 7]
    todayMoves.rampDescent(today, (_l, visit) => path.forEach((p, i) => visit(p, cum[i])), 2, -1, 7, 180)
    expect(lead).toEqual(today.map(m => ({ ...m, role: 'lead_in' })))
    const viaLead: ToolpathMove[] = [], viaBuilder: ToolpathMove[] = []
    const spec = { centre: { x: 0, y: 0 }, radius: 2, fromZ: -1, toZ: 1, pitch: { kind: 'pitch' as const, mm: 1.25 }, sampling: { kind: 'dense' as const }, feed: 400 }
    kernel.helixLead(viaLead, spec, 'lead_out')
    kernel.buildHelix(viaBuilder, { ...spec, role: 'lead_out' })
    expect(viaLead).toEqual(viaBuilder)
  })

  it('reads a lead run\'s kind and rebuilds it through the library', () => {
    const from = { x: 0, y: 0, z: -2 }
    const straight: ToolpathMove[] = [{ type: 'feed', x: 0, y: 0, z: -3, feed: 100, role: 'lead_in' }]
    expect(kernel.classifyLeadRun(from, straight)).toBe('straight')
    expect(kernel.rebuildLeadRun(from, straight)).toEqual(straight)
    const poly: ToolpathMove[] = [{ type: 'feed', x: 1, y: 0, z: -2, feed: 100, role: 'lead_in' }, { type: 'feed', x: 2, y: 1, z: -2, feed: 100, role: 'lead_in' }]
    expect(kernel.classifyLeadRun(from, poly)).toBe('polyline')
    expect(kernel.rebuildLeadRun(from, poly)).toEqual(poly)
    const arc = kernel.arcLead({ cx: 0, cy: 0, radius: 3, angle: 0, dir: 1, z: -2, feed: 100, kindRole: 'lead_in' })
    expect(kernel.classifyLeadRun(from, arc)).toBe('arc')
    // A run that mixes feeds or roles is not one library lead.
    expect(kernel.rebuildLeadRun(from, [poly[0], { ...poly[1], feed: 50 }])).toBeUndefined()
  })
})

describe('WO-3031 ramp builder and gates', () => {
  it('rampDescent and rampTo equal today\'s on a grid of contours, spans and angles', () => {
    const contours = [
      [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 5 }, { x: 0, y: 5 }],
      [{ x: 0, y: 0 }, { x: 0.3, y: 0 }, { x: 0.3, y: 0.2 }],
    ]
    for (const path of contours) for (const fromIdx of [0, 2]) for (const [fromZ, toZ] of [[3, -2], [0, 0], [1, -0.5]]) for (const deg of [0.5, 3, 30]) {
      const tan = Math.tan(deg * Math.PI / 180)
      const a: ToolpathMove[] = [], b: ToolpathMove[] = []
      expect(kernel.rampTo(b, path, fromIdx, fromZ, toZ, tan, 150)).toBe(todayMoves.rampTo(a, path, fromIdx, fromZ, toZ, tan, 150))
      expect(b).toEqual(a)
      const walk: kernel.RampWalk = (length, visit) => { for (let s = 0.7; s < length + 0.7; s += 0.7) visit({ x: s, y: -s }, s) }
      const c: ToolpathMove[] = [], d: ToolpathMove[] = []
      todayMoves.rampDescent(c, walk, fromZ, toZ, 4.2, 150); kernel.rampDescent(d, walk, fromZ, toZ, 4.2, 150)
      expect(d).toEqual(c)
    }
  })

  it('the straight-descent rule: one free column, else at most 5 % of the cutter face', () => {
    expect(kernel.straightDescentAllowed({ uncutColumns: 1, fraction: 0.9 })).toBe(true)
    expect(kernel.straightDescentAllowed({ uncutColumns: 2, fraction: 0.05 })).toBe(true)
    expect(kernel.straightDescentAllowed({ uncutColumns: 2, fraction: 0.0501 })).toBe(false)
    expect(kernel.straightDescentAllowed({ uncutColumns: 0, fraction: 0 })).toBe(true)
  })

  it('every gate and convention row names the code that holds today\'s value', () => {
    for (const [name, row] of [...Object.entries(kernel.ENTRY_GATES), ...Object.entries(kernel.ENTRY_CONVENTIONS)]) {
      expect(row.source, name).toMatch(/src\/(lib|cam3d|kernel)\//)
    }
  })
})

describe('WO-3031 parity policy table and the policies', () => {
  it('every entry policy is at parity and each alternative names its operator decision and card', () => {
    expect(kernel.PARITY_ENTRY_POLICY).toEqual({
      slow_plunge_rung: 'off', full_feed_plunge_guard: 'plunge_rate_as_today', working_defaults: 'today',
      tool_approach_search: 'off', helix_form: 'per_family', lead_fields_honoured: 'off',
    })
    expect(Object.isFrozen(kernel.PARITY_ENTRY_POLICY)).toBe(true)
    expect(Object.keys(kernel.CARDED_ENTRY_ALTERNATIVES).sort()).toEqual(Object.keys(kernel.PARITY_ENTRY_POLICY).sort())
    expect(kernel.CARDED_ENTRY_ALTERNATIVES.slow_plunge_rung.named).toBe('A-29')
    expect(kernel.CARDED_ENTRY_ALTERNATIVES.working_defaults.named).toBe('A-30')
    expect(kernel.CARDED_ENTRY_ALTERNATIVES.tool_approach_search.named).toBe('A-34')
    expect(kernel.CARDED_ENTRY_ALTERNATIVES.lead_fields_honoured.card).toMatch(/MD-70/)
    expect(kernel.CARDED_ENTRY_ALTERNATIVES.helix_form.card).toMatch(/MD-68/)
  })

  it('every family has a row for every entry type, citing its code; helix forms and floors are real', () => {
    for (const [family, row] of Object.entries(kernel.PARITY_ENTRY_TABLE)) {
      expect(row.decidedBy, family).toMatch(/src\/|patterned/)
      for (const entryType of kernel.ENTRY_TYPES) {
        expect(row.byEntryType[entryType].length, `${family} ${entryType}`).toBeGreaterThan(0)
        for (const c of row.byEntryType[entryType]) expect(kernel.ENTRY_CLASSES).toContain(c)
        expect(kernel.parityEntryClasses(family as keyof typeof kernel.PARITY_ENTRY_TABLE, entryType)).toBe(row.byEntryType[entryType])
      }
      if (row.helixFloor) expect(kernel.ENTRY_GATES[row.helixFloor], family).toBeDefined()
      for (const lead of row.leads) expect(kernel.LEAD_KINDS).toContain(lead)
      // A family that helixes has a helix form; one that does not, none.
      const helixes = kernel.ENTRY_TYPES.some(t => row.byEntryType[t].includes('helix'))
      if (row.helixForm !== 'none') expect(helixes, family).toBe(true)
    }
    expect(kernel.PARITY_ENTRY_TABLE.bore.pitch).toBe('own_pitch')
    expect(kernel.PARITY_ENTRY_TABLE.thread_mill.pitch).toBe('own_pitch')
    expect(kernel.PARITY_ENTRY_TABLE.adaptive_3d.helixForm).toBe('turns')
  })
})

describe('WO-3031 entry reading', () => {
  const rapid = (x: number, y: number, z: number): ToolpathMove => ({ type: 'rapid', x, y, z, role: 'rapid' })
  const feed = (x: number, y: number, z: number, role: ToolpathMove['role'], f = 100): ToolpathMove => ({ type: 'feed', x, y, z, feed: f, role })
  it('reads plunge, ramp, helix and open entries, and a ramp round a rectangle is not a helix', () => {
    const helix: ToolpathMove[] = []
    kernel.helixDescent(helix, { centre: { x: 0, y: 0 }, radius: 2, fromZ: 0, toZ: -2, tanAngle: 0.1, feed: 150 })
    const rectRamp: ToolpathMove[] = []
    kernel.rampTo(rectRamp, [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 2 }, { x: 0, y: 2 }], 0, 0, -1, 0.05, 150)
    const moves: ToolpathMove[] = [
      rapid(0, 0, 10), rapid(0, 0, 1), feed(0, 0, -3, 'plunge'), feed(5, 0, -3, 'cut'),
      rapid(5, 0, 10), rapid(0, 0, 10), rapid(0, 0, 0), ...rectRamp, feed(1, 1, -1, 'cut'),
      rapid(1, 1, 10), rapid(2, 0, 10), rapid(2, 0, 0), ...helix, feed(3, 3, -2, 'cut'),
      rapid(3, 3, 10), rapid(9, 9, 10), rapid(9, 9, -2), feed(8, 8, -2, 'lead_in'),
    ]
    expect(kernel.entrySpans(moves).map(s => s.entryClass)).toEqual(['plunge', 'ramp', 'helix', 'open'])
    expect(kernel.entrySpans(moves)[0]).toMatchObject({ fromZ: 1, toZ: -3, feed: 100, roles: ['plunge'] })
  })
})

describe('WO-3031 kernel entry is headless, deterministic and called by no app path', () => {
  const pure = new Set(['src/types'])
  it('imports only its own kernel files and the pure type module (no engine, store, UI or package import)', () => {
    const offending = files(resolve('src/kernel/entry')).flatMap(path => imports(path)
      .filter(specifier => {
        const target = rel(resolve(dirname(path), specifier)).replace(/\.(ts|tsx)$/, '')
        return !(specifier.startsWith('.') && (target.startsWith('src/kernel/entry/') || pure.has(target)))
      })
      .map(specifier => `${rel(path)} -> ${specifier}`))
    expect(offending).toEqual([])
    for (const path of files(resolve('src/kernel/entry'))) {
      expect(readFileSync(path, 'utf8'), rel(path)).not.toMatch(/Math\.random|Date\.now|new Date\(|performance\.now|window\.|document\.|console\./)
    }
  })

  it('adds no operator text: no notice or warning string, and its only throws are today\'s', () => {
    const throws = files(resolve('src/kernel/entry')).flatMap(path =>
      [...readFileSync(path, 'utf8').matchAll(/throw new Error\(\s*[`'"]([^`'"$]*)/g)].map(m => m[1]))
    const todays = [
      readFileSync(resolve('src/lib/cam/threadHelix.ts'), 'utf8'),
      readFileSync(resolve('src/cam3d/rough/emit.ts'), 'utf8'),
    ].join('\n')
    for (const text of throws) expect(todays, text).toContain(text)
  })

  it('no file under src outside the service and src/tests imports src/kernel/entry', () => {
    const callers = files(resolve('src'))
      .filter(path => !rel(path).startsWith('src/kernel/entry/') && !rel(path).startsWith('src/tests/'))
      .flatMap(path => imports(path)
        .filter(specifier => specifier.startsWith('.') && rel(resolve(dirname(path), specifier)).startsWith('src/kernel/entry'))
        .map(specifier => `${rel(path)} -> ${specifier}`))
    expect(callers).toEqual([])
    // Negative control: the same check sees a store import of the service.
    expect(imports(resolve('src/store/negative-control.ts'), "import { createEntryService } from '../kernel/entry'")
      .filter(specifier => rel(resolve(resolve('src/store'), specifier)).startsWith('src/kernel/entry'))).toEqual(['../kernel/entry'])
  })

  it('is deterministic: the same inputs give the same moves', () => {
    const run = () => {
      const moves: ToolpathMove[] = []
      kernel.helixDescent(moves, { centre: { x: 1, y: 1 }, radius: 3, fromZ: 0, toZ: -4, tanAngle: 0.05, feed: 100 })
      moves.push(...kernel.helixArcs({ cx: 0, cy: 0, radius: 1, pitch: 0.5, bottomZ: -2, topZ: 0, dir: -1, feed: 50, descend: true }))
      return JSON.stringify(moves)
    }
    expect(run()).toBe(run())
  })
})
