// WO-3026 (alpha.3 A3-12): the kernel linking service at parity with today's links.
//
// Oracle: today's engine, untouched. Shadows on today's link code record every call the
// PRODUCTION path makes - the store's compute through the real toolpath worker
// (heightScenario.ts, the WO-1604..1622 harness) for every 2.5D family and for Adaptive
// 3D / Parallel / Waterline / Drill on an imported solid - plus today's Scallop and Pencil
// strategies on a BL-281 procedural mesh (no scenario drives those two families):
//   - the shared 2.5D approach / retract primitives (src/lib/cam/moves),
//   - the 3D raster linker (src/cam3d/pathbuild buildLinkedPath, with every connector
//     surface sample it asked for),
//   - the waterline linker (src/cam3d/strategies/waterline/link.ts).
// Each recorded call is replayed through the kernel copy and must give today's moves
// exactly. The links of every production program are then classified by geometric case
// and outcome, and every one must be one the parity policy table allows for its family.
// The role vocabulary, the feed rows, the IR role mapping and the standoff table are
// compared with today's code.

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { typedMock } from '../support/typedMock'
import type { ToolpathMove } from '../../types'
import type { IrMove } from '../../cam3d/ir/types'
import type { PathBuildHeights, LinkPolicy, ConnectorSampler } from '../../cam3d/pathbuild'
import type { WaterlinePass } from '../../cam3d/strategies/waterline/loops'
import type { WaterlineLinkPolicy } from '../../cam3d/strategies/waterline/link'

type PrimitiveName = 'rapidEntryAt' | 'rapidEntry' | 'plungeTo' | 'retractFrom' | 'floorHop' | 'floorHopAlong'
interface PrimitiveCall { name: PrimitiveName; last?: ToolpathMove; args: unknown[]; pushed: ToolpathMove[]; ret: unknown }
interface RasterCall {
  passes: Float64Array[]; heights: PathBuildHeights; policy: LinkPolicy
  samples: Array<{ xy: Float64Array; z: Float64Array }>; result?: IrMove[]; error?: string
}
interface WaterlineCall {
  passes: WaterlinePass[]; heights: PathBuildHeights; policy: WaterlineLinkPolicy; result?: IrMove[]; error?: string
}
const rec = vi.hoisted(() => ({
  primitives: [] as PrimitiveCall[],
  hopSettings: [] as Array<{ input: unknown; ret: number }>,
  raster: [] as RasterCall[],
  waterline: [] as WaterlineCall[],
}))

vi.mock('../../lib/cam/moves', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/cam/moves')>()
  const wrap = <F extends (moves: ToolpathMove[], ...rest: never[]) => unknown>(name: PrimitiveName, fn: F): F =>
    ((moves: ToolpathMove[], ...rest: never[]) => {
      const before = moves.length
      const last = before > 0 ? structuredClone(moves[before - 1]) : undefined
      const args = structuredClone(rest) as unknown[]
      const ret = fn(moves, ...rest)
      rec.primitives.push({ name, last, args, pushed: structuredClone(moves.slice(before)), ret: structuredClone(ret) })
      return ret
    }) as F
  return typedMock<typeof import('../../lib/cam/moves')>({
    ...actual,
    rapidEntryAt: wrap('rapidEntryAt', actual.rapidEntryAt),
    rapidEntry: wrap('rapidEntry', actual.rapidEntry),
    plungeTo: wrap('plungeTo', actual.plungeTo),
    retractFrom: wrap('retractFrom', actual.retractFrom),
    floorHop: wrap('floorHop', actual.floorHop),
    floorHopAlong: wrap('floorHopAlong', actual.floorHopAlong),
    resolveFloorHopMm: (linking) => {
      const ret = actual.resolveFloorHopMm(linking)
      rec.hopSettings.push({ input: structuredClone(linking), ret })
      return ret
    },
  })
})
vi.mock('../../cam3d/pathbuild', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../cam3d/pathbuild')>()
  return typedMock<typeof import('../../cam3d/pathbuild')>({
    ...actual,
    buildLinkedPath: async (passes, heights, policy, sampleSurface) => {
      const call: RasterCall = {
        passes: passes.map(p => p.slice()), heights: structuredClone(heights), policy: structuredClone(policy), samples: [],
      }
      rec.raster.push(call)
      const sampler: ConnectorSampler = async (xy) => {
        const z = await sampleSurface(xy)
        call.samples.push({ xy: xy.slice(), z: z.slice() })
        return z
      }
      try {
        call.result = structuredClone(await actual.buildLinkedPath(passes, heights, policy, sampler))
        return call.result
      } catch (error) {
        call.error = (error as Error).message
        throw error
      }
    },
  })
})
vi.mock('../../cam3d/strategies/waterline/link', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../cam3d/strategies/waterline/link')>()
  return typedMock<typeof import('../../cam3d/strategies/waterline/link')>({
    ...actual,
    linkWaterlinePasses: (passes, heights, policy) => {
      const call: WaterlineCall = { passes: structuredClone(passes as WaterlinePass[]), heights: structuredClone(heights), policy: structuredClone(policy) }
      rec.waterline.push(call)
      try {
        call.result = structuredClone(actual.linkWaterlinePasses(passes, heights, policy))
        return call.result
      } catch (error) {
        call.error = (error as Error).message
        throw error
      }
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
import { TRAVERSE_STANDOFF_MM } from '../../cam3d/pathbuild'
import { ADAPTIVE_TRAVERSE_STANDOFF_MM } from '../../cam3d/integration/adaptive3dOperation'
import { LIFT_DISTANCE } from '../../lib/cam/adaptiveClearing2d/engine/processFeature'
import { LOW_TRAVEL_HEADROOM_MM } from '../../cam3d/rough/traverseSafety'
import { irToToolpathMoves } from '../../cam3d/ir/toToolpathMoves'
import { resolveMoveFeedrate, type ResolvedFeedrates } from '../../lib/cam/feedrates'
import { MOVE_MOTION_BY_ROLE, STOCK_CUTTING_BY_ROLE } from '../../lib/cam/stockCuttingRoles'
import { hemisphereOnSlab } from '../../cam3d/fixtures'
import { BvhKernel } from '../../cam3d/kernel/bvhKernel'
import { scallopFinish } from '../../cam3d/strategies/scallop'
import { pencilFinish } from '../../cam3d/strategies/pencil'
import type { OperationType } from '../../types'
import * as kernel from '../../kernel/linking'

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
const bottomMinus8 = { bottomRow: { reference: 'stock_top' as const, offsetMm: -8 } }
const retract20 = { safetyOverride: { plane: 'retract' as const, reference: 'wcs_plane' as const, offsetMm: 20 } }

const SCENARIOS_2D: Array<[string, HeightScenario]> = [
  ['face smart', raised('face')],
  ['face bottom -8', raised('face', bottomMinus8)],
  ['pocket smart', raised('pocket_2d')],
  ['pocket bottom -8', raised('pocket_2d', bottomMinus8)],
  ['pocket retract 20', raised('pocket_2d', retract20)],
  ['adaptive 2D smart', raised('adaptive_clearing_2d')],
  ['adaptive 2D bottom -8', raised('adaptive_clearing_2d', bottomMinus8)],
  ['contour smart', raised('contour_2d')],
  ['contour bottom -8', raised('contour_2d', bottomMinus8)],
  ['drill smart', raised('drill')],
  ['bore smart', raised('bore')],
  ['chamfer smart', raised('chamfer')],
  ['engrave depth 1', raised('engrave', { datumFormula: { depthMm: 1 } })],
  ['vcarve smart', raised('vcarve')],
  ['thread mill smart', onTable('thread_mill')],
]

const BOX_VISE: ScenarioWorkholding = { name: 'Vise', min: { x: 5, y: 5, z: 0 }, max: { x: 25, y: 15, z: RAISE } }
const BOX_STOCK = { kind: 'auto' as const, offsetXY: 5, offsetZTop: 3, offsetZBottom: 0 }

/** One program whose links are classified: family, moves (WCS), planes, tool. */
interface Program {
  label: string
  family: OperationType
  moves: ReadonlyArray<{ type: string; x: number; y: number; z: number; role?: string; feed?: number }>
  planes: kernel.SafetyPlanes
  toolDiameterMm: number
  /** Resolved rates for the role-feed check (2.5D and solid scenario tools). */
  rates?: ResolvedFeedrates
  status: string
}
const programs: Program[] = []

const FALLBACK_RATES: ResolvedFeedrates = {
  // The 2.5D scenario tool carries no feedsAndSpeeds: today's safety fallbacks (feedrates.ts).
  feedRate: 300, plungeRate: 100, rampRate: 150, leadInRate: 300, leadOutRate: 300, fastTraverseRate: 300, finishRate: 300,
}
const SOLID_RATES: ResolvedFeedrates = {
  feedRate: 1200, plungeRate: 400, rampRate: 600, leadInRate: 1200, leadOutRate: 1200, fastTraverseRate: 1200, finishRate: 1200,
}

function planesOf(plan: { safety: { clearance: { wcsMm: number }; retract: { wcsMm: number }; feed: { wcsMm: number } } } | undefined): kernel.SafetyPlanes {
  return plan
    ? { clearanceZ: plan.safety.clearance.wcsMm, retractZ: plan.safety.retract.wcsMm, feedZ: plan.safety.feed.wcsMm }
    : { clearanceZ: NaN, retractZ: NaN, feedZ: NaN }
}

async function production(): Promise<void> {
  for (const [label, scenario] of SCENARIOS_2D) {
    const reading = await runHeightScenario(scenario)
    programs.push({
      label, family: scenario.operation, moves: reading.moves, planes: planesOf(reading.plan),
      toolDiameterMm: scenario.toolDiameter ?? (scenario.operation === 'drill' ? 5 : 6), rates: FALLBACK_RATES,
      status: `${reading.status} ${reading.errorMessage ?? reading.authoringError ?? ''}`.trim(),
    })
  }
  const solids: Array<[string, Parameters<typeof runSolidScenario>[0]]> = [
    ['closed box raised: adaptive 3D, parallel, waterline', {
      part: 'closed_box', z: RAISE, stock: BOX_STOCK, workholding: BOX_VISE,
      operations: [
        { kind: 'adaptive_3d', source: 'current_material', toolDiameter: 6, axialStockToLeave: 0.5, params: { useStockBoundary: true } },
        { kind: 'parallel_3d', toolDiameter: 6 },
        { kind: 'waterline_3d', toolDiameter: 6 },
      ],
    }],
    ['plate with holes: drill on detected holes', {
      part: 'plate_holes', z: 0, stock: BOX_STOCK,
      operations: [{ kind: 'drill', toolDiameter: 5, holeDiameters: [6, 10] }],
    }],
  ]
  for (const [label, scenario] of solids) {
    const readings = await runSolidScenario(scenario)
    readings.forEach((reading, index) => {
      const op = scenario.operations[index]
      programs.push({
        label: `${label} #${index + 1} ${op.kind}`, family: op.kind, moves: reading.moves, planes: planesOf(reading.plan),
        toolDiameterMm: op.toolDiameter, rates: SOLID_RATES,
        status: `${reading.status}${reading.errorMessage ? ` (${reading.errorMessage})` : ''}`,
      })
    })
  }
}

/** Scallop and Pencil: today's strategies on the BL-281 hemisphere-on-slab mesh (builder level). */
async function strategyRuns(): Promise<void> {
  const HEIGHTS = { clearanceZ: 45, retractZ: 40, feedZ: 35 }
  const mesh = hemisphereOnSlab()
  const bvh = new BvhKernel()
  const handle = bvh.uploadMesh(mesh)
  try {
    const xyBounds = { minX: mesh.bounds.min[0], minY: mesh.bounds.min[1], maxX: mesh.bounds.max[0], maxY: mesh.bounds.max[1] }
    const cutter = { kind: 'ball' as const, diameter: 4 }
    const scallop = await scallopFinish(bvh, {
      mesh: handle, cutter, scallopHeight: 0.05, tolerance: 0.05, direction: 'climb', xyBounds, heights: HEIGHTS, zSeed: 0,
    })
    const pencil = await pencilFinish(bvh, {
      mesh: handle, cutter, tolerance: 0.05, direction: 'climb', xyBounds, heights: HEIGHTS, zSeed: 0,
    })
    for (const [family, ir] of [['scallop_3d', scallop], ['pencil_3d', pencil]] as const) {
      programs.push({
        label: `${family} on hemisphereOnSlab`, family, toolDiameterMm: 4, status: 'ready',
        moves: ir.moves.map(m => ({ type: m.t === 'arc' ? 'arc_cw' : m.t, x: m.x, y: m.y, z: m.z, role: m.role })),
        planes: HEIGHTS,
      })
    }
  } finally {
    bvh.releaseMesh(handle)
  }
}

// ─── replay helpers ──────────────────────────────────────────────────────────

function replayPrimitive(call: PrimitiveCall): { pushed: ToolpathMove[]; ret: unknown } {
  const moves: ToolpathMove[] = call.last ? [structuredClone(call.last)] : []
  const fn = kernel[call.name] as (moves: ToolpathMove[], ...args: unknown[]) => unknown
  const ret = fn(moves, ...structuredClone(call.args))
  return { pushed: moves.slice(call.last ? 1 : 0), ret }
}

async function replayRaster(call: RasterCall): Promise<{ result?: IrMove[]; error?: string }> {
  let k = 0
  const sampler = async (xy: Float64Array): Promise<Float64Array> => {
    const sample = call.samples[k++]
    if (!sample || sample.xy.length !== xy.length || sample.xy.some((v, i) => v !== xy[i])) {
      throw new Error(`kernel linker asked for connector sample ${k - 1} that today's did not`)
    }
    return sample.z.slice()
  }
  try {
    const result = await kernel.buildLinkedPath(call.passes, call.heights, call.policy, sampler)
    if (k !== call.samples.length) return { error: `kernel used ${k} of ${call.samples.length} connector samples` }
    return { result }
  } catch (error) {
    return { error: (error as Error).message }
  }
}

function replayWaterline(call: WaterlineCall): { result?: IrMove[]; error?: string } {
  try {
    return { result: kernel.linkWaterlinePasses(call.passes, call.heights, call.policy) }
  } catch (error) {
    return { error: (error as Error).message }
  }
}

const EVIDENCE = resolvePath('src/tests/evidence/WO-3026/parity.json')

// ─── the parity assertions ───────────────────────────────────────────────────

describe('WO-3026 kernel linking at parity with today\'s links', () => {
  // The harness swaps in its Worker shim per test, so the production runs live in the first test.
  it('the production runs linked every family through today\'s code', async () => {
    await production()
    await strategyRuns()
    const families = new Set(programs.map(p => p.family))
    for (const family of [
      'face', 'pocket_2d', 'adaptive_clearing_2d', 'contour_2d', 'drill', 'bore', 'chamfer', 'engrave', 'vcarve',
      'thread_mill', 'adaptive_3d', 'parallel_3d', 'waterline_3d', 'scallop_3d', 'pencil_3d',
    ] as const) expect(families.has(family), family).toBe(true)
    for (const program of programs) expect(program.moves.length, `${program.label}: ${program.status}`).toBeGreaterThan(0)
    expect(rec.primitives.length).toBeGreaterThan(0)
    expect(rec.raster.length).toBeGreaterThan(0)
    expect(rec.waterline.length).toBeGreaterThan(0)
  }, 600_000)

  it('approach / retract primitives: the kernel set equals today\'s on every recorded production call', () => {
    const mismatches: string[] = []
    for (const [index, call] of rec.primitives.entries()) {
      const out = replayPrimitive(call)
      if (JSON.stringify(out.pushed) !== JSON.stringify(call.pushed) || JSON.stringify(out.ret) !== JSON.stringify(call.ret)) {
        mismatches.push(`${index} ${call.name}`)
      }
    }
    expect(mismatches).toEqual([])
    for (const setting of rec.hopSettings) {
      expect(kernel.resolveFloorHopMm(structuredClone(setting.input) as { floorHopMm?: number })).toBe(setting.ret)
    }
    expect(kernel.DEFAULT_FLOOR_HOP_MM).toBe(todayMoves.DEFAULT_FLOOR_HOP_MM)
  })

  it('approach / retract primitives: the kernel set equals today\'s on a grid of heights, hops and paths', () => {
    const paths = [
      [{ x: 0, y: 0 }, { x: 10, y: 0 }],
      [{ x: 0, y: 0 }, { x: 0.2, y: 0.1 }],
      [{ x: 1, y: 1 }, { x: 4, y: 5 }, { x: 9, y: 5 }, { x: 9, y: 0 }],
      [{ x: 2, y: 2 }, { x: 2, y: 2 }],
    ]
    for (const path of paths) for (const z of [-3, 0, 4.25]) for (const hop of [0, 0.3, 0.5, 2]) for (const land of [true, false]) {
      const a: ToolpathMove[] = [], b: ToolpathMove[] = []
      todayMoves.floorHopAlong(a, path, z, hop, land); kernel.floorHopAlong(b, path, z, hop, land)
      expect(b).toEqual(a)
      const c: ToolpathMove[] = [], d: ToolpathMove[] = []
      todayMoves.floorHop(c, path[0], path[path.length - 1], z, hop, land); kernel.floorHop(d, path[0], path[path.length - 1], z, hop, land)
      expect(d).toEqual(c)
    }
    for (const [feedZ, retractZ, clearanceZ] of [[2, 5, 15], [0, 0, 0], [-1, 3, 3]]) {
      const a: ToolpathMove[] = [{ type: 'feed', x: 3, y: 4, z: -2, role: 'cut' }], b = structuredClone(a)
      todayMoves.rapidEntryAt(a, { x: 7, y: 8 }, feedZ, retractZ, clearanceZ); kernel.rapidEntryAt(b, { x: 7, y: 8 }, feedZ, retractZ, clearanceZ)
      todayMoves.retractFrom(a, retractZ, clearanceZ); kernel.retractFrom(b, retractZ, clearanceZ)
      todayMoves.plungeTo(a, [{ x: 1, y: 2 }], 0, -4, 120); kernel.plungeTo(b, [{ x: 1, y: 2 }], 0, -4, 120)
      todayMoves.plungeTo(a, [{ x: 1, y: 2 }], 0, -5, 90, 'ramp'); kernel.plungeTo(b, [{ x: 1, y: 2 }], 0, -5, 90, 'ramp')
      expect(b).toEqual(a)
    }
    const empty: ToolpathMove[] = [], emptyKernel: ToolpathMove[] = []
    todayMoves.retractFrom(empty, 5, 10); kernel.retractFrom(emptyKernel, 5, 10)
    expect(emptyKernel).toEqual(empty)
    for (const input of [undefined, {}, { floorHopMm: 0 }, { floorHopMm: 0.45 }, { floorHopMm: -1 }, { floorHopMm: Number.NaN }]) {
      expect(kernel.resolveFloorHopMm(input)).toBe(todayMoves.resolveFloorHopMm(input))
    }
  })

  it('3D raster linker (Parallel, Scallop, Pencil): the kernel copy equals today\'s on every recorded production call', async () => {
    const mismatches: string[] = []
    for (const [index, call] of rec.raster.entries()) {
      const out = await replayRaster(call)
      const same = call.error !== undefined
        ? out.error === call.error
        : JSON.stringify(out.result) === JSON.stringify(call.result)
      if (!same) mismatches.push(`${index}: ${out.error ?? 'moves differ'}`)
    }
    expect(mismatches).toEqual([])
  })

  it('waterline linker: the kernel copy equals today\'s on every recorded production call', () => {
    const mismatches: string[] = []
    for (const [index, call] of rec.waterline.entries()) {
      const out = replayWaterline(call)
      const same = call.error !== undefined ? out.error === call.error : JSON.stringify(out.result) === JSON.stringify(call.result)
      if (!same) mismatches.push(`${index}: ${out.error ?? 'moves differ'}`)
    }
    expect(mismatches).toEqual([])
  })

  it('every production link is one the parity policy table allows for its family, whatever the retract / transition fields say', () => {
    const observed: Record<string, Record<string, Record<string, number>>> = {}
    const outside: string[] = []
    for (const program of programs) {
      const row = kernel.PARITY_LINK_TABLE[program.family]
      for (const span of kernel.linkSpans(program.moves)) {
        const linkCase = kernel.classifyLinkCase(span, { toolDiameterMm: program.toolDiameterMm, levelled: row.levelled })
        const outcome = kernel.classifyLinkOutcome(span, program.planes)
        const cell = ((observed[program.family] ??= {})[linkCase] ??= {})
        cell[outcome] = (cell[outcome] ?? 0) + 1
        for (const retractType of kernel.RETRACT_TYPES) for (const transitionType of kernel.TRANSITION_TYPES) {
          const allowed = kernel.parityLinkOutcomes(program.family, { retractType, transitionType }, linkCase)
          if (!allowed.includes(outcome)) outside.push(`${program.label} link@${span.start} ${linkCase} -> ${outcome} (${retractType}/${transitionType})`)
        }
      }
    }
    // Evidence is written only on request (WO3026_WRITE_EVIDENCE=1), so a run never rewrites a tracked file.
    if (process.env.WO3026_WRITE_EVIDENCE) writeFileSync(EVIDENCE, JSON.stringify({
      order: 'WO-3026', kind: 'parity',
      programs: programs.map(p => ({ label: p.label, family: p.family, status: p.status, moves: p.moves.length, links: kernel.linkSpans(p.moves).length })),
      recordedCalls: { primitives: rec.primitives.length, floorHopSettings: rec.hopSettings.length, raster: rec.raster.length, waterline: rec.waterline.length },
      observedLinkOutcomes: observed,
    }, null, 1) + '\n')
    expect(outside.slice(0, 20)).toEqual([])
    // Every family the production runs drove has at least one observed link.
    for (const family of ['face', 'pocket_2d', 'adaptive_clearing_2d', 'bore', 'drill', 'vcarve', 'adaptive_3d', 'parallel_3d', 'scallop_3d'] as const) {
      expect(Object.keys(observed[family] ?? {}).length, family).toBeGreaterThan(0)
    }
  })

  it('role vocabulary: the 12 roles equal today\'s MoveRole tables; each production move\'s feed is its role\'s row', () => {
    expect([...kernel.MOVE_ROLES].sort()).toEqual(Object.keys(STOCK_CUTTING_BY_ROLE).sort())
    expect([...kernel.MOVE_ROLES].sort()).toEqual(Object.keys(MOVE_MOTION_BY_ROLE).sort())
    for (const role of kernel.MOVE_ROLES) {
      const row = kernel.ROLE_FEED_TABLE[role]
      expect(row.stockCutting).toBe(STOCK_CUTTING_BY_ROLE[role])
      expect(row.travel).toBe(MOVE_MOTION_BY_ROLE[role])
    }
    const offRow: string[] = []
    let checked = 0
    for (const program of programs) {
      if (!program.rates) continue
      for (const [index, move] of program.moves.entries()) {
        if (!move.role) continue
        const row = kernel.feedRowFor(move.role)
        const exceptions = row.parityExceptions.filter(e => e.family === program.family)
        const fedRapid = move.type !== 'rapid' && row.motion === 'rapid'
        if (fedRapid && !exceptions.some(e => e.motion === 'feed')) offRow.push(`${program.label} move ${index} ${move.role} fed as ${move.type}`)
        if (!fedRapid && (row.motion === 'rapid') !== (move.type === 'rapid')) offRow.push(`${program.label} move ${index} ${move.role} as ${move.type}`)
        if (move.type === 'rapid' || typeof move.feed !== 'number') continue
        checked++
        const rates = [...(row.rate ? [row.rate] : []), ...exceptions.map(e => e.rate)]
        if (!rates.some(rate => program.rates![rate] === move.feed)) offRow.push(`${program.label} move ${index} ${move.role} F${move.feed}`)
      }
    }
    expect(checked).toBeGreaterThan(0)
    expect(offRow.slice(0, 20)).toEqual([])
  })

  it('role feeds: the deferred rows and the 3D IR mapping equal today\'s output boundaries', () => {
    const feeds: ResolvedFeedrates = { feedRate: 1000, plungeRate: 200, rampRate: 300, leadInRate: 400, leadOutRate: 500, fastTraverseRate: 6000, finishRate: 700 }
    for (const role of kernel.MOVE_ROLES) {
      for (const move of [{ type: 'feed' as const, x: 0, y: 0, z: 0, role }, { type: 'feed' as const, x: 0, y: 0, z: 0, role, feed: 123 }]) {
        expect(kernel.resolveRoleFeed(move, feeds), role).toBe(resolveMoveFeedrate(move, feeds))
      }
    }
    // Every IR role through today's IR boundary, with and without resolved rates.
    const ir: IrMove[] = [{ t: 'rapid', x: 0, y: 0, z: 10, role: 'rapid' }]
    for (const role of Object.keys(kernel.IR_ROLE_TO_RATE) as Array<keyof typeof kernel.IR_ROLE_TO_RATE>) {
      ir.push({ t: 'feed', x: ir.length, y: 0, z: 0, role })
    }
    const converted = irToToolpathMoves({ moves: ir, meta: { strategyId: 's', cutterId: 'c' } }, feeds)
    converted.forEach((move, index) => {
      const irRole = ir[index].role!
      expect(move.role).toBe(kernel.IR_ROLE_TO_LINK_ROLE[irRole])
      if (irRole !== 'rapid') expect(move.feed).toBe(feeds[kernel.IR_ROLE_TO_RATE[irRole]])
    })
    expect(Object.keys(kernel.IR_ROLE_TO_LINK_ROLE).sort()).toEqual(['cut', 'finish', 'lead_in', 'lead_out', 'plunge', 'ramp', 'rapid', 'stepover'])
  })

  it('standoff table: each row equals today\'s local constant', () => {
    expect(kernel.STANDOFFS.finish_3d_traverse.valueMm).toBe(TRAVERSE_STANDOFF_MM)
    expect(kernel.STANDOFFS.adaptive_3d_traverse.valueMm).toBe(ADAPTIVE_TRAVERSE_STANDOFF_MM)
    expect(kernel.STANDOFFS.adaptive_2d_micro_lift.valueMm).toBe(LIFT_DISTANCE)
    expect(kernel.STANDOFFS.rough_3d_low_travel_headroom.valueMm).toBe(LOW_TRAVEL_HEADROOM_MM)
    // drill2d.ts keeps its constant private: read it from today's source text.
    const drill = /const PECK_REAPPROACH_CLEARANCE = ([0-9.]+)/.exec(readFileSync(resolvePath('src/lib/cam/drill2d.ts'), 'utf8'))
    expect(Number(drill?.[1])).toBe(kernel.STANDOFFS.drill_peck_reapproach.valueMm)
    expect(Object.keys(kernel.STANDOFFS)).toHaveLength(5)
  })
})
