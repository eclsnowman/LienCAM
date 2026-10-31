// WO-3031 (alpha.3 A3-13): the kernel entry and leads service at parity with today's entries.
//
// Oracle: today's engine, untouched. Shadows on today's entry code record every call the
// PRODUCTION path makes - the store's compute through the real toolpath worker
// (heightScenario.ts, the WO-1604..1622 harness) for every 2.5D family under each of the
// four linking entry types, and Adaptive 3D on an imported solid:
//   - the shared 2.5D helix / ramp builders and the helix floor (src/lib/cam/moves),
//   - Thread Mill's helix and lead arcs and Bore's helical arcs (src/lib/cam/threadHelix),
//   - the 3D rough level emitter (src/cam3d/rough/emit.ts emitLevelPasses), whose helix the
//     kernel rebuilds from the helix centres the planner handed it.
// Each recorded call is replayed through the kernel's one builder and must give today's
// moves exactly. Every entry of every production program is then read by class and must be
// one the parity table allows for its family and entry type; every lead run must be one the
// lead library rebuilds; the gate table must equal today's constants.

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { typedMock } from '../support/typedMock'
import type { LinkingParams, OperationType, ToolpathMove } from '../../types'
import type { IrMove } from '../../cam3d/ir/types'
import type { AdaptivePass } from '../../cam3d/rough/engineEntry'
import type { ThreadHelixSpec as TodayThreadSpec, LeadArcSpec as TodayLeadArcSpec } from '../../lib/cam/threadHelix'

type BuilderName = 'helixDescent' | 'rampTo'
interface BuilderCall { name: BuilderName; last?: ToolpathMove; args: unknown[]; pushed: ToolpathMove[]; ret: unknown }
interface RampCall { last?: ToolpathMove; visits: Array<{ point: { x: number; y: number }; traveled: number }>; args: [number, number, number, number]; pushed: ToolpathMove[] }
interface SpecCall<S> { spec: S; result?: ToolpathMove[]; error?: string; family?: string }
interface RoughCall {
  z: number; helixAngleDeg?: number; millingDirection?: string; minHelixRadius?: number
  centres: Array<{ x: number; y: number; radius: number }>; result: IrMove[]
}
const rec = vi.hoisted(() => ({
  linking: {
    entryType: 'ramp_linear', rampAngle: 3, rampLength: 10, leadInRadius: 0, leadOutRadius: 0,
    retractType: 'full', transitionType: 'safe_height',
  } as LinkingParams,
  builders: [] as BuilderCall[],
  ramps: [] as RampCall[],
  fits: [] as Array<{ args: unknown[]; ret: boolean }>,
  threads: [] as SpecCall<TodayThreadSpec>[],
  arcs: [] as SpecCall<TodayThreadSpec>[],
  leadArcs: [] as SpecCall<TodayLeadArcSpec>[],
  rough: [] as RoughCall[],
}))

// The dialog's linking defaults, made settable so one harness drives every entry type.
vi.mock('../../components/modals/newOperationModalDefaults', async (importOriginal) =>
  typedMock<typeof import('../../components/modals/newOperationModalDefaults')>({
    ...(await importOriginal<typeof import('../../components/modals/newOperationModalDefaults')>()),
    defaultLinking: rec.linking,
  }))
vi.mock('../../lib/cam/moves', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/cam/moves')>()
  const wrap = <F extends (moves: ToolpathMove[], ...rest: never[]) => unknown>(name: BuilderName, fn: F): F =>
    ((moves: ToolpathMove[], ...rest: never[]) => {
      const before = moves.length
      const last = before > 0 ? structuredClone(moves[before - 1]) : undefined
      const args = structuredClone(rest) as unknown[]
      const ret = fn(moves, ...rest)
      rec.builders.push({ name, last, args, pushed: structuredClone(moves.slice(before)), ret: structuredClone(ret) })
      return ret
    }) as F
  return typedMock<typeof import('../../lib/cam/moves')>({
    ...actual,
    helixDescent: wrap('helixDescent', actual.helixDescent),
    rampTo: wrap('rampTo', actual.rampTo),
    rampDescent: (moves, walk, fromZ, toZ, length, feed) => {
      const before = moves.length
      const call: RampCall = { last: before > 0 ? structuredClone(moves[before - 1]) : undefined, visits: [], args: [fromZ, toZ, length, feed], pushed: [] }
      actual.rampDescent(moves, (len, visit) => walk(len, (point, traveled) => {
        call.visits.push({ point: { x: point.x, y: point.y }, traveled })
        visit(point, traveled)
      }), fromZ, toZ, length, feed)
      call.pushed = structuredClone(moves.slice(before))
      rec.ramps.push(call)
    },
    helixFits: (...args: Parameters<typeof actual.helixFits>) => {
      const ret = actual.helixFits(...args)
      rec.fits.push({ args: [...args], ret })
      return ret
    },
  })
})
vi.mock('../../lib/cam/threadHelix', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/cam/threadHelix')>()
  const wrap = <S,>(list: SpecCall<S>[], fn: (spec: S) => ToolpathMove[]) => (spec: S): ToolpathMove[] => {
    const call: SpecCall<S> = { spec: structuredClone(spec) }
    list.push(call)
    try {
      const result = fn(spec)
      call.result = structuredClone(result)
      return result
    } catch (error) {
      call.error = (error as Error).message
      throw error
    }
  }
  return typedMock<typeof import('../../lib/cam/threadHelix')>({
    ...actual,
    generateThreadHelix: wrap(rec.threads, actual.generateThreadHelix),
    generateHelixArcs: wrap(rec.arcs, actual.generateHelixArcs),
    generateLeadArc: wrap(rec.leadArcs, actual.generateLeadArc),
  })
})
vi.mock('../../cam3d/rough/emit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../cam3d/rough/emit')>()
  return typedMock<typeof import('../../cam3d/rough/emit')>({
    ...actual,
    emitLevelPasses: (passes, z, heights, ctx, stockSection) => {
      const centres: RoughCall['centres'] = []
      for (const pass of passes as readonly AdaptivePass[]) {
        if (pass.type === 'entry' && pass.mode === 'helix') centres.push({ x: pass.point.x, y: pass.point.y, radius: pass.radius })
        if (pass.type === 'link') {
          for (const h of [pass.helixDescent, pass.fallbackHelix]) if (h) centres.push({ x: h.center.x, y: h.center.y, radius: h.radius })
        }
      }
      const result = actual.emitLevelPasses(passes, z, heights, ctx, stockSection)
      rec.rough.push({
        z, helixAngleDeg: ctx.helixAngleDeg, millingDirection: ctx.millingDirection, minHelixRadius: ctx.minHelixRadius,
        centres, result: structuredClone(result),
      })
      return result
    },
  })
})
// Browser transports only, exactly as heightsParity.wo3020.test.ts replaces them.
vi.mock('../../lib/stepCache', async (importOriginal) => typedMock<typeof import('../../lib/stepCache')>({
  ...(await importOriginal<typeof import('../../lib/stepCache')>()),
  loadCachedStep: async (geoId: string) => (await import('../helpers/heightScenario')).solidStepBytes(geoId),
}))
vi.mock('../../cam3d/integration/parallel3dOperation', async (importOriginal) =>
  typedMock<typeof import('../../cam3d/integration/parallel3dOperation')>({
    ...(await importOriginal<typeof import('../../cam3d/integration/parallel3dOperation')>()),
    acquirePartMesh: async (source, tolerance) =>
      (await import('../helpers/heightScenario')).tessellateSolid(source, tolerance),
  }))
vi.mock('../../cam3d/integration/appClient', async (importOriginal) =>
  typedMock<typeof import('../../cam3d/integration/appClient')>({
    ...(await importOriginal<typeof import('../../cam3d/integration/appClient')>()),
    getCam3dClient: () => scenarioModule.inProcessCam3dClient(),
    disposeCam3dClient: () => {},
  }))
vi.mock('../../lib/cam/geometry/occt/model/modelClient', async (importOriginal) =>
  typedMock<typeof import('../../lib/cam/geometry/occt/model/modelClient')>({
    ...(await importOriginal<typeof import('../../lib/cam/geometry/occt/model/modelClient')>()),
    deriveHoles: async (geoId: string) =>
      (await import('../helpers/heightScenario')).deriveHolesInProcess(geoId),
  }))

import * as scenarioModule from '../helpers/heightScenario'
import {
  circleLoop, installRealToolpathWorker, rectLoop, runHeightScenario, runSolidScenario,
  type HeightScenario, type ScenarioWorkholding,
} from '../helpers/heightScenario'
import * as todayMoves from '../../lib/cam/moves'
import * as todayThread from '../../lib/cam/threadHelix'
import { MIN_DESCENT_HELIX_RADIUS } from '../../lib/cam/adaptiveClearing2d/engine/processFeature'
import { defaultLinking, defaultACParams, DEFAULT_ADAPTIVE3D_PARAMS } from '../../kernel/parameterDefaults'
import * as kernel from '../../kernel/entry'
import { ADAPTIVE_POLICY } from '../../kernel/ops/adaptive/policy'

installRealToolpathWorker()

// ─── the production runs ──────────────────────────────────────────────────────

const RAISE = 50
const OUTLINE = rectLoop('outline', 0, 0, 60, 40)
const POCKET = rectLoop('pocket', 15, 10, 35, 30)
const HOLE = circleLoop('hole', 48, 20, 4)
const VISE: ScenarioWorkholding = { name: 'Vise', min: { x: 40, y: 5, z: 0 }, max: { x: 56, y: 35, z: RAISE } }
const AUTO_STOCK = { kind: 'auto' as const, offsetXY: 5, offsetZTop: 12, offsetZBottom: 0 }
const LOOP_FOR: Record<HeightScenario['operation'], string[]> = {
  face: [], pocket_2d: ['pocket'], adaptive_clearing_2d: ['pocket'], contour_2d: ['outline'], drill: ['hole'],
  bore: ['hole'], chamfer: ['outline'], engrave: ['pocket'], vcarve: ['pocket'], thread_mill: ['hole'],
}
const raised = (operation: HeightScenario['operation'], extra: Partial<HeightScenario> = {}): HeightScenario => ({
  part: { kind: 'sketch_2d', loops: [OUTLINE, POCKET, HOLE], z: RAISE },
  stock: AUTO_STOCK, workholding: VISE, operation, loopIds: LOOP_FOR[operation], ...extra,
})
const onTable = (operation: HeightScenario['operation'], extra: Partial<HeightScenario> = {}): HeightScenario => ({
  part: { kind: 'sketch_2d', loops: [OUTLINE, POCKET, HOLE], z: 0 },
  stock: AUTO_STOCK, operation, loopIds: LOOP_FOR[operation], ...extra,
})
const SCENARIOS_2D: Array<[string, HeightScenario]> = [
  ['face', raised('face')],
  ['pocket', raised('pocket_2d')],
  ['pocket bottom -8', raised('pocket_2d', { bottomRow: { reference: 'stock_top', offsetMm: -8 } })],
  ['adaptive 2D', raised('adaptive_clearing_2d')],
  ['contour', raised('contour_2d')],
  ['drill', raised('drill')],
  ['bore', raised('bore')],
  ['chamfer', raised('chamfer')],
  ['engrave', raised('engrave', { datumFormula: { depthMm: 1 } })],
  ['vcarve', raised('vcarve')],
  ['thread mill', onTable('thread_mill')],
]

const BOX_VISE: ScenarioWorkholding = { name: 'Vise', min: { x: 5, y: 5, z: 0 }, max: { x: 25, y: 15, z: RAISE } }
const BOX_STOCK = { kind: 'auto' as const, offsetXY: 5, offsetZTop: 3, offsetZBottom: 0 }

interface Program {
  label: string
  family: OperationType
  entryType: kernel.EntryType
  moves: ReadonlyArray<ToolpathMove>
  status: string
  feedRate?: number
}
const programs: Program[] = []
// The 2.5D scenario tool carries no feedsAndSpeeds: today's safety fallbacks (feedrates.ts).
const FALLBACK_FEED = 300
// Today's linking entry types (src/types LinkingParams['entryType']), independent of the kernel.
const TODAY_ENTRY_TYPES: LinkingParams['entryType'][] = ['plunge', 'ramp_linear', 'ramp_helical', 'arc']

async function production(): Promise<void> {
  for (const entryType of TODAY_ENTRY_TYPES) {
    rec.linking.entryType = entryType
    for (const [label, scenario] of SCENARIOS_2D) {
      const arcsBefore = rec.arcs.length
      const reading = await runHeightScenario(scenario)
      for (const call of rec.arcs.slice(arcsBefore)) call.family = scenario.operation
      programs.push({
        label: `${label} ${entryType}`, family: scenario.operation, entryType, moves: reading.moves, feedRate: FALLBACK_FEED,
        status: `${reading.status} ${reading.errorMessage ?? reading.authoringError ?? ''}`.trim(),
      })
    }
  }
  rec.linking.entryType = defaultLinking.entryType
  const readings = await runSolidScenario({
    part: 'closed_box', z: RAISE, stock: BOX_STOCK, workholding: BOX_VISE,
    operations: [
      { kind: 'adaptive_3d', source: 'current_material', toolDiameter: 6, axialStockToLeave: 0.5, params: { useStockBoundary: true } },
      { kind: 'adaptive_3d', source: 'current_material', toolDiameter: 6, axialStockToLeave: 0.5, params: { useStockBoundary: false } },
    ],
  })
  readings.forEach((reading, index) => programs.push({
    label: `closed box raised: adaptive 3D #${index + 1}`, family: 'adaptive_3d', entryType: defaultLinking.entryType,
    moves: reading.moves, status: `${reading.status}${reading.errorMessage ? ` (${reading.errorMessage})` : ''}`,
  }))
}

// ─── replay helpers ──────────────────────────────────────────────────────────

const json = (value: unknown) => JSON.stringify(value)

function replayBuilder(call: BuilderCall): { pushed: ToolpathMove[]; ret: unknown } {
  const moves: ToolpathMove[] = call.last ? [structuredClone(call.last)] : []
  const fn = (call.name === 'helixDescent' ? kernel.helixDescent : kernel.rampTo) as (moves: ToolpathMove[], ...args: unknown[]) => unknown
  const ret = fn(moves, ...structuredClone(call.args))
  return { pushed: moves.slice(call.last ? 1 : 0), ret }
}

function replayRamp(call: RampCall): ToolpathMove[] {
  const moves: ToolpathMove[] = call.last ? [structuredClone(call.last)] : []
  const [fromZ, toZ, length, feed] = call.args
  kernel.rampDescent(moves, (_len, visit) => { for (const v of call.visits) visit(v.point, v.traveled) }, fromZ, toZ, length, feed)
  return moves.slice(call.last ? 1 : 0)
}

function replaySpec<S>(call: SpecCall<S>, fn: (spec: S) => ToolpathMove[]): boolean {
  try {
    const result = fn(structuredClone(call.spec))
    return call.error === undefined && json(result) === json(call.result)
  } catch (error) {
    return call.error === (error as Error).message
  }
}

/** Every helix the 3D rough emitted in this level, rebuilt by the kernel's one builder from
 *  the helix centres the planner handed the emitter. Returns [helices found, rebuilt equal]. */
function replayRough(call: RoughCall): { found: number; equal: number; unmatched: string[] } {
  const moves = call.result
  const tan = Math.tan(((call.helixAngleDeg ?? kernel.ENTRY_CONVENTIONS.helix_angle_adaptive_3d.value) * Math.PI) / 180)
  const dir: 1 | -1 = call.millingDirection === 'conventional' ? -1 : 1
  const floor = call.minHelixRadius ?? kernel.ENTRY_GATES.helix_floor_adaptive.value
  let found = 0, equal = 0
  const unmatched: string[] = []
  for (let i = 0; i + 1 < moves.length; i++) {
    const start = moves[i], next = moves[i + 1]
    if (start.t !== 'rapid' || next.t !== 'feed' || next.role !== 'ramp' || !(next.z < start.z - 1e-9)) continue
    const centre = call.centres.find(c => {
      if (c.radius < floor) return false
      const r = kernel.helixOrbitRadius(c.radius)
      return start.x === c.x + r && start.y === c.y
    })
    // A ramp descent from a rapid that no helix centre explains is not a helix (or is a miss).
    const pts = moves.slice(i, Math.min(moves.length, i + 6))
    if (!centre) {
      if (kernel.onOneCircle(pts.map(m => ({ x: m.x, y: m.y })))) unmatched.push(`level z=${call.z} move ${i}`)
      continue
    }
    found++
    const rebuilt: ToolpathMove[] = []
    kernel.buildHelix(rebuilt, {
      centre: { x: centre.x, y: centre.y }, radius: kernel.helixOrbitRadius(centre.radius), fromZ: start.z, toZ: call.z,
      pitch: { kind: 'angle', tanAngle: tan },
      sampling: { kind: 'turns', segmentsPerTurn: kernel.ENTRY_GATES.helix_segments_per_turn_3d.value, cleanupTurn: true, maxPoints: kernel.ENTRY_GATES.helix_max_points.value },
      role: 'ramp', direction: dir,
    })
    const today = moves.slice(i + 1, i + 1 + rebuilt.length).map(m => ({ type: 'feed', x: m.x, y: m.y, z: m.z, role: m.role }))
    if (json(today) === json(rebuilt)) equal++
    else unmatched.push(`level z=${call.z} move ${i} differs`)
  }
  return { found, equal, unmatched }
}

const EVIDENCE = resolvePath('src/tests/evidence/WO-3031/parity.json')
const sourceConst = (path: string, name: string): number => {
  const source = readFileSync(resolvePath(path), 'utf8')
  const match = new RegExp(`const ${name}\\s*=\\s*([0-9.]+)`).exec(source)
  if (match) return Number(match[1])
  // WO-3018: an engine constant may now read the adaptive policy record (`= AP.group.key`);
  // today's value is then the record's value, read through the same object the engine imports.
  const record = new RegExp(`const ${name}\\s*=\\s*AP\\.([a-zA-Z]+)\\.([a-zA-Z]+)\\s*(?:\\/\\/.*)?$`, 'm').exec(source)
  if (!record) return Number.NaN
  return (ADAPTIVE_POLICY as unknown as Record<string, Record<string, number>>)[record[1]][record[2]]
}

// ─── the parity assertions ───────────────────────────────────────────────────

describe('WO-3031 kernel entry at parity with today\'s entries', () => {
  // The harness swaps in its Worker shim per test, so the production runs live in the first test.
  it('the production runs entered every family through today\'s code under every entry type', async () => {
    await production()
    const families = new Set(programs.map(p => p.family))
    for (const family of [
      'face', 'pocket_2d', 'adaptive_clearing_2d', 'contour_2d', 'drill', 'bore', 'chamfer', 'engrave', 'vcarve',
      'thread_mill', 'adaptive_3d',
    ] as const) expect(families.has(family), family).toBe(true)
    for (const program of programs) expect(program.moves.length, `${program.label}: ${program.status}`).toBeGreaterThan(0)
    expect(rec.builders.some(c => c.name === 'helixDescent')).toBe(true)
    expect(rec.builders.some(c => c.name === 'rampTo')).toBe(true)
    // rampDescent is reached through rampTo on these rows (Pocket's inside-out default helixes);
    // any direct production call is replayed below, and the units file compares it on a grid.
    expect(rec.fits.length).toBeGreaterThan(0)
    // WO-3168 (35bb15a31d, found by bisect): Thread Mill's cutting helices ride Bore's
    // native helical arcs, so today's thread helix builder has no production caller left.
    expect(rec.arcs.some(call => call.family === 'thread_mill')).toBe(true)
    expect(rec.arcs.some(call => call.family === 'bore')).toBe(true)
    expect(rec.rough.length).toBeGreaterThan(0)
  }, 900_000)

  it('helix and ramp builders: the kernel\'s equal today\'s on every recorded production call', () => {
    expect(rec.builders.length).toBeGreaterThan(0)
    const mismatches: string[] = []
    for (const [index, call] of rec.builders.entries()) {
      const out = replayBuilder(call)
      if (json(out.pushed) !== json(call.pushed) || json(out.ret) !== json(call.ret)) mismatches.push(`${index} ${call.name}`)
    }
    for (const [index, call] of rec.ramps.entries()) {
      if (json(replayRamp(call)) !== json(call.pushed)) mismatches.push(`${index} rampDescent`)
    }
    expect(mismatches).toEqual([])
  })

  it('helix floor: the kernel\'s helix fit equals today\'s on every recorded production call and on a grid', () => {
    expect(rec.fits.length).toBeGreaterThan(0)
    const differ = rec.fits.filter(call => kernel.helixFits(...(call.args as [number, number?])) !== call.ret)
    expect(differ).toEqual([])
    for (const radius of [-1, 0, 0.1, 0.19, 0.199999, 0.2, 0.200001, 0.205, 0.21, 0.3, 1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(kernel.helixFits(radius), `r=${radius}`).toBe(todayMoves.helixFits(radius))
      expect(kernel.helixFits(radius, MIN_DESCENT_HELIX_RADIUS), `r=${radius}`).toBe(todayMoves.helixFits(radius, MIN_DESCENT_HELIX_RADIUS))
    }
  })

  it('bore and thread helices and the thread lead arcs: the one builder equals today\'s on every recorded production call', () => {
    // WO-3168: the thread helices are among the helical-arc calls (see the first test).
    expect(rec.arcs.some(call => call.family === 'thread_mill')).toBe(true)
    expect(rec.arcs.length * rec.leadArcs.length).toBeGreaterThan(0)
    const differ = [
      ...rec.threads.flatMap((call, i) => replaySpec(call, kernel.threadHelix) ? [] : [`thread ${i}`]),
      ...rec.arcs.flatMap((call, i) => replaySpec(call, kernel.helixArcs) ? [] : [`bore arcs ${i}`]),
      ...rec.leadArcs.flatMap((call, i) => replaySpec(call, kernel.arcLead) ? [] : [`lead arc ${i}`]),
    ]
    expect(differ).toEqual([])
  })

  it('Adaptive 3D helices: the one builder rebuilds every production helix exactly', () => {
    let found = 0, equal = 0
    const unmatched: string[] = []
    for (const call of rec.rough) {
      const out = replayRough(call)
      found += out.found; equal += out.equal; unmatched.push(...out.unmatched)
    }
    expect(unmatched.slice(0, 10)).toEqual([])
    expect(found).toBeGreaterThan(0)
    expect(equal).toBe(found)
  })

  it('every production entry is one the parity table allows for its family and entry type; every lead run is one the library rebuilds', () => {
    const observed: Record<string, Record<string, Record<string, number>>> = {}
    const outside: string[] = []
    const leadKinds: Record<string, Record<string, number>> = {}
    const leadMisses: string[] = []
    let fullFeedPlunges = 0
    for (const program of programs) {
      for (const span of kernel.entrySpans(program.moves)) {
        const cell = ((observed[program.family] ??= {})[program.entryType] ??= {})
        cell[span.entryClass] = (cell[span.entryClass] ?? 0) + 1
        if (!kernel.parityEntryClasses(program.family, program.entryType).includes(span.entryClass)) {
          outside.push(`${program.label} entry@${span.start} ${span.entryClass}`)
        }
        // M-ENTRY-1: a plunge move into the cut fed at the cutting feed. (Drill's approach down to
        // Feed Height above the stock is fed at the cutting feed with role rapid - drill2d.ts:180,
        // the WO-3026 parity exception - and is not a plunge.)
        const plungeMoves = program.moves.slice(span.start, span.end).filter(m => m.role === 'plunge')
        if (program.feedRate !== undefined && plungeMoves.some(m => m.feed === program.feedRate)) fullFeedPlunges++
      }
      // Lead runs: maximal runs of lead_in / lead_out moves.
      for (let i = 1; i < program.moves.length; i++) {
        const role = program.moves[i].role
        if (role !== 'lead_in' && role !== 'lead_out') continue
        let end = i
        while (end < program.moves.length && program.moves[end].role === role) end++
        const run = program.moves.slice(i, end)
        const from = program.moves[i - 1]
        const kind = kernel.classifyLeadRun(from, run)
        const kinds = (leadKinds[program.family] ??= {})
        kinds[kind] = (kinds[kind] ?? 0) + 1
        if (!kernel.PARITY_ENTRY_TABLE[program.family].leads.includes(kind)) leadMisses.push(`${program.label} lead@${i} ${kind} not in the row`)
        // Thread Mill's tangent semicircles are compared on their recorded calls (arcLead) above.
        if (kind !== 'helix' && !(kind === 'arc' && program.family === 'thread_mill')) {
          const rebuilt = kernel.rebuildLeadRun(from, run)
          if (!rebuilt || json(rebuilt) !== json(run)) leadMisses.push(`${program.label} lead@${i} ${kind} not rebuilt`)
        }
        i = end - 1
      }
    }
    // Evidence is written only on request (WO3031_WRITE_EVIDENCE=1), so a run never rewrites a tracked file.
    if (process.env.WO3031_WRITE_EVIDENCE) writeFileSync(EVIDENCE, JSON.stringify({
      order: 'WO-3031', kind: 'parity',
      programs: programs.map(p => ({ label: p.label, family: p.family, entryType: p.entryType, status: p.status, moves: p.moves.length, entries: kernel.entrySpans(p.moves).length })),
      recordedCalls: {
        helixDescent: rec.builders.filter(c => c.name === 'helixDescent').length, rampTo: rec.builders.filter(c => c.name === 'rampTo').length,
        rampDescent: rec.ramps.length, helixFits: rec.fits.length, threadHelix: rec.threads.length, boreHelixArcs: rec.arcs.length,
        leadArcs: rec.leadArcs.length, adaptive3dLevels: rec.rough.length,
      },
      observedEntryClasses: observed,
      observedLeadKinds: leadKinds,
      plungesAtCuttingFeed: fullFeedPlunges,
    }, null, 1) + '\n')
    expect(outside.slice(0, 20)).toEqual([])
    expect(leadMisses.slice(0, 20)).toEqual([])
    // M-ENTRY-1 on these rows: no plunge is fed at the cutting feed today.
    expect(fullFeedPlunges).toBe(0)
    for (const family of ['pocket_2d', 'adaptive_clearing_2d', 'contour_2d', 'bore', 'thread_mill', 'adaptive_3d'] as const) {
      expect(Object.keys(observed[family] ?? {}).length, family).toBeGreaterThan(0)
    }
  })

  it('gate and convention table: each row equals today\'s constant', () => {
    const g = kernel.ENTRY_GATES, c = kernel.ENTRY_CONVENTIONS
    expect(g.helix_floor_2d.value).toBe(todayMoves.MIN_HELIX_RADIUS_MM)
    expect(kernel.MIN_HELIX_RADIUS_MM).toBe(todayMoves.MIN_HELIX_RADIUS_MM)
    expect(g.helix_floor_adaptive.value).toBe(MIN_DESCENT_HELIX_RADIUS)
    expect(g.helix_floor_adaptive_2d_default.value).toBe(sourceConst('src/lib/cam/adaptiveClearing2d/engine/index.ts', 'DEFAULT_MIN_HELIX_RADIUS_MM'))
    expect(g.bore_helix_orbit_floor.value).toBe(sourceConst('src/lib/cam/bore2d.ts', 'MIN_HELIX_ORBIT_RADIUS_MM'))
    expect(g.straight_descent_allowance.value).toBe(sourceConst('src/cam3d/rough/emit.ts', 'DEFAULT_PLUNGE_UNCUT_ALLOWANCE'))
    expect(g.helix_edge_backoff.value).toBe(sourceConst('src/cam3d/rough/emit.ts', 'HELIX_EDGE_BACKOFF'))
    expect(g.helix_edge_backoff.value).toBe(sourceConst('src/lib/cam/adaptiveClearing2d/engine/emit.ts', 'HELIX_EDGE_BACKOFF'))
    expect(g.helix_max_points.value).toBe(sourceConst('src/cam3d/rough/emit.ts', 'MAX_HELIX_POINTS'))
    expect(g.helix_max_points.value).toBe(sourceConst('src/lib/cam/adaptiveClearing2d/engine/emit.ts', 'MAX_HELIX_POINTS'))
    expect(g.helix_segments_per_turn_3d.value).toBe(sourceConst('src/cam3d/rough/emit.ts', 'HELIX_SEGMENTS_PER_TURN'))
    expect(g.stock_aware_ramp_clearance_3d.value).toBe(sourceConst('src/cam3d/rough/emit.ts', 'STOCK_AWARE_RAMP_CLEARANCE_MM'))
    expect(c.helix_angle_adaptive_3d.value).toBe(sourceConst('src/cam3d/rough/emit.ts', 'DEFAULT_HELIX_ANGLE_DEG'))
    expect(kernel.HELIX_FI_STEP).toBe(todayThread.HELIX_FI_STEP)
    expect(kernel.HELIX_ARC_MIN_CHORD_MM).toBe(todayThread.HELIX_ARC_MIN_CHORD_MM)
    // The 3D rough's straight-descent rule: at most one uncut column, or a share within 5 %.
    expect(/const allowed = read\.uncutColumns <= 1 \|\| read\.fraction <= plungeAllowance;/.test(readFileSync(resolvePath('src/cam3d/rough/emit.ts'), 'utf8'))).toBe(true)
    expect(/assertStraightDescentIsClear/.test(readFileSync(resolvePath('src/cam3d/rough/emit.ts'), 'utf8'))).toBe(true)
    // Conventions: today's stored defaults.
    expect(c.linking_entry_type.value).toBe(defaultLinking.entryType)
    expect(c.ramp_angle_2d.value).toBe(defaultLinking.rampAngle)
    expect(c.ramp_length_2d.value).toBe(defaultLinking.rampLength)
    expect(c.lead_in_radius.value).toBe(defaultLinking.leadInRadius)
    expect(c.lead_out_radius.value).toBe(defaultLinking.leadOutRadius)
    expect(c.helix_diameter_adaptive_2d.value).toBe(defaultACParams.helixDiameter)
    expect(c.helix_diameter_adaptive_3d.value).toBe(DEFAULT_ADAPTIVE3D_PARAMS.helixDiameter)
    expect(c.helix_angle_adaptive_3d.value).toBe(DEFAULT_ADAPTIVE3D_PARAMS.helixAngleDeg)
  })
})
