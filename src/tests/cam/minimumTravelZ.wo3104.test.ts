import { generationFingerprint, type GenerationFingerprintInput } from '../../lib/cam/generationFingerprint'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { evidenceOutDir } from '../helpers/evidenceScratch'
import type { ToolpathMove } from '../../types'
import { trimToolpathToToolReach } from '../../lib/cam/holderClearanceGate'
import { readGcodeProgram } from '../../lib/gcode/reader'
import { effectiveMoveRole, isStockCuttingRole } from '../../lib/cam/stockCuttingRoles'
import { buildDrillToolpath } from '../../lib/cam/drill2d'
import type { DrillParams, DrillWorkerPayload } from '../../lib/cam/types'
import { reconstructDrillCycles } from '../../lib/post/cannedCycle'
import { emitProgram } from '../../lib/post/emit'
import { UCCNC_CONFIG } from '../../lib/post/dialects/uccnc'
import { resolveCoolant, resolveSpindle } from '../../lib/post/resolve'
import { resolveFeedrates } from '../../lib/cam/feedrates'
import { makeMachine, makeOp, makeTool, makeWcs } from '../post/helpers'
import { typedMock } from '../support/typedMock'
import { planChain } from '../benchmark/chainRunner'
import { alpha3Chains, toolById, type BenchmarkChain } from '../benchmark/registry'

const noncut = (m: ToolpathMove) => !isStockCuttingRole(effectiveMoveRole(m))
function violations(moves: ToolpathMove[], floor: number) {
  return moves.flatMap((m, i) => i > 0 && noncut(m)
    && Math.hypot(m.x - moves[i - 1].x, m.y - moves[i - 1].y) > 1e-6
    && Math.min(m.z, moves[i - 1].z) < floor - 1e-6 ? [i] : [])
}
const move = (x: number, z: number, role: ToolpathMove['role'] = 'rapid'): ToolpathMove =>
  ({ type: role === 'rapid' ? 'rapid' : 'feed', x, y: 0, z, role, ...(role !== 'rapid' ? { feed: 400 } : {}) })

it('WO-3104 generation claim: checked matches legacy; unchecking invalidates the saved path', () => {
  const operation = makeOp()
  const fixture = { operation, setup: { id: 'setup', wcs: makeWcs(), stock: {} },
    geometry: [], stocks: [], machine: makeMachine() } as unknown as GenerationFingerprintInput
  const legacy = generationFingerprint(fixture)
  operation.heights.minimizeZTravel = true
  expect(generationFingerprint(fixture)).toBe(legacy)
  operation.heights.minimizeZTravel = false
  expect(generationFingerprint(fixture), 'unchecked must invalidate cached stay-down moves').not.toBe(legacy)
  operation.heights.minimizeZTravel = true
  expect(generationFingerprint(fixture)).toBe(legacy)
})

describe('WO-3104 Retract segment contract', () => {
  let enforceMinimumTravelZ: typeof import('../../lib/cam/minimumTravelZ').enforceMinimumTravelZ
  let minimumTravelZInFrame: typeof import('../../lib/cam/minimumTravelZ').minimumTravelZInFrame
  beforeAll(async () => {
    // Lazy load only this describe: production negative controls run the complete
    // old source, where this new module does not exist, with these unit rows skipped.
    const source = '../../lib/cam/minimumTravelZ'
    const api = await import(/* @vite-ignore */ source)
    enforceMinimumTravelZ = api.enforceMinimumTravelZ
    minimumTravelZInFrame = api.minimumTravelZInFrame
  })
  it('checked and missing preserve stay-downs; unchecked uses Retract in the moves frame', () => {
    const moves = [move(0, -4), move(20, -4)]
    expect(enforceMinimumTravelZ(moves, undefined)).toBe(moves)
    expect(violations(enforceMinimumTravelZ(moves, 0), 0)).toEqual([])
    expect(violations(enforceMinimumTravelZ(moves, -2), -2)).toEqual([])
    for (const minimizeZTravel of [undefined, true]) {
      expect(minimumTravelZInFrame({ ...makeOp().heights, minimizeZTravel }, 100)).toBeUndefined()
    }
    expect(minimumTravelZInFrame({ ...makeOp().heights, minimizeZTravel: false, retractHeight: -2 }, 100, 70)).toBe(28)
    expect(minimumTravelZInFrame({ ...makeOp().heights, minimizeZTravel: false }, 100, 70, 33)).toBe(33)
    expect(() => minimumTravelZInFrame({ ...makeOp().heights, minimizeZTravel: false, retractHeight: NaN }, 0)).toThrow('finite')
  })
  for (const role of ['rapid', 'fast_traverse', 'loop_back'] as const) {
    it(`${role}: lift before XY and restore the entry, with higher clamp detours untouched`, () => {
      const moves = [move(0, 15), move(0, -5, 'plunge'), move(10, -5, role),
        move(15, -5, 'cut'), move(15, 25), move(40, 25), move(40, 15)]
      const out = enforceMinimumTravelZ(moves, 8)
      expect(violations(out, 8)).toEqual([])
      const cutAt = out.findIndex(m => m.role === 'cut')
      expect(out[cutAt - 1]).toEqual(move(10, -5))
      expect(out.filter(m => !noncut(m))).toEqual(moves.filter(m => !noncut(m)))
      expect(out[0]).toEqual(moves[0])
      expect(out.at(-1)).toEqual(moves.at(-1))
      expect(out.find(m => m.x === 40 && m.z === 25)).toEqual(moves[5])
      expect(enforceMinimumTravelZ(out, 8)).toBe(out)
    })
  }
  for (const mode of ['clearance', 'retract'] as const) {
    it(`native drill ${mode}: unchecked uses Feed R and controller-specific return in a translated WCS`, () => {
      const tool = makeTool({ type: 'drill' })
      const op = makeOp({ type: 'drill', heights: { ...makeOp().heights, clearanceHeight: 15, retractHeight: 8, feedHeight: 4.5, minimizeZTravel: false },
        params: { cycleType: 'simple', retractMode: mode, sortOrder: 'selection', holeSource: 'geometry', loopIds: [] } })
      const payload = { opId: op.id, setupId: 'su', heights: op.heights, tool, passes: op.passes,
        linking: op.linking, params: op.params as unknown as DrillParams,
        holes: [{ x: 0, y: 0 }, { x: 40, y: 0 }], loops: [], wcsOrigin: { x: 0, y: 0, z: 100 } } as unknown as DrillWorkerPayload
      // The builder uses selected loops; circles define the two drill centres.
      payload.loops = [0, 40].map((x, i) => ({ id: String(i), closed: true, type: 'circle',
        points: [{ x: x - 1, y: 0 }, { x: x + 1, y: 0 }, { x, y: 1 }, { x, y: -1 }] }))
      const moves = buildDrillToolpath(payload)
      expect(moves.length).toBeGreaterThan(0)
      expect(violations(moves, 108)).toEqual([])
      const recon = reconstructDrillCycles(op, moves, 100)
      expect(recon.ok).toBe(true)
      if (!recon.ok) return
      expect(recon.program.rPlaneZ, 'unchecked R must be resolved Feed, independently of Retract').toBe(104.5)
      expect(recon.program.initialZ).toBe(mode === 'clearance' ? 108 : 115)
      if (mode === 'retract') expect(recon.program.holes[1].liftZ).toBe(108)
      const machine = makeMachine()
      const posted = emitProgram({ machine, setup: { wcs: makeWcs({ origin: { x: 0, y: 0, z: 100 } }),
        operations: [{ op, tool, moves, feeds: resolveFeedrates(tool, undefined), spindle: resolveSpindle(op, tool, machine), coolant: resolveCoolant(tool, machine) }] } }, UCCNC_CONFIG)
      expect(posted.lines.some(l => l.startsWith(mode === 'clearance' ? 'G98 G81' : 'G99 G81'))).toBe(true)
      const read = readGcodeProgram(posted.lines.join('\n'), { dialect: 'uccnc', sessionWcs: 'G54',
        initialPosition: { x: 0, y: 0, z: 50 }, machineUnits: 'mm', workOffsets: { G54: { x: 0, y: 0, z: 0 } } })
      expect(read.ok).toBe(true)
      if (read.ok) {
        // Native G99 returns to R=Feed; expanded drilling still hops at Retract.
        expect(violations(read.program.moves as ToolpathMove[], mode === 'clearance' ? 8 : 4.5)).toEqual([])
        expect(read.program.moves.filter(m => m.role === 'plunge').at(-1)?.z).toBe(-5)
      }
    })
  }

it('WO-3104 assembly: the floor preserves a higher clamp crossing after reach trim', () => {
  const positions: number[] = [], indices: number[] = []
  for (const z of [0, 10]) for (const y of [-20, 20]) for (const x of [15, 25]) positions.push(x, y, z)
  for (const [a, b, c, d] of [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]]) indices.push(a, b, c, a, c, d)
  const tool = makeTool({ type: 'drill', diameter: 5, shankDiameter: 5, fluteLength: 30 })
  const built = [move(0, 15), move(0, -5, 'plunge'), move(0, 5), move(40, 5), move(40, -5, 'plunge'), move(40, 15)]
  const reach = trimToolpathToToolReach({ operation: 'Drill', tool, plungeRate: 400,
    moves: enforceMinimumTravelZ(built, 8), workholding: [{ positions: Float32Array.from(positions), indices: Uint32Array.from(indices) }] })
  const out = enforceMinimumTravelZ([...reach.moves], 8)
  const crossings = out.filter((m, i) => i > 0 && Math.abs(m.x - out[i - 1].x) > 30)
  expect(crossings.length).toBeGreaterThan(0)
  expect(crossings.every(m => m.z > 10)).toBe(true)
  expect(violations(out, 8)).toEqual([])
})

})

it('WO-3104 post approach: unchecked covers first/same-tool approaches and expanded-copy links at Retract', () => {
  const tool = makeTool(), machine = makeMachine()
  const operations = [40, 80].map(x => {
    const op = makeOp({ id: `op-${x}`, heights: { ...makeOp().heights, clearanceHeight: 35, retractHeight: 30, minimizeZTravel: false } })
    const moves = [move(x, 15), move(x, 1), move(x, -5, 'plunge'), move(x + 2, -5, 'cut'), move(x + 2, 15), move(x + 20, 15)]
    return { op, tool, moves, nestExpanded: true, feeds: resolveFeedrates(tool, undefined), spindle: resolveSpindle(op, tool, machine), coolant: resolveCoolant(tool, machine) }
  })
  const posted = emitProgram({ machine, setup: { wcs: makeWcs(), operations } }, UCCNC_CONFIG)
  const read = readGcodeProgram(posted.lines.join('\n'), { dialect: 'uccnc', sessionWcs: 'G54',
    initialPosition: { x: 0, y: 0, z: 50 }, machineUnits: 'mm', workOffsets: { G54: { x: 0, y: 0, z: 0 } } })
  expect(read.ok).toBe(true)
  if (read.ok) expect(violations(read.program.moves as ToolpathMove[], 30), 'approach or copy link below Retract').toEqual([])
})

it('WO-3104 typed entries: unchecked reaches Feed before feeding, with Clearance endpoints and identical XY cuts', () => {
  const tool = makeTool(), machine = makeMachine()
  const moves = [move(0, 15), move(0, 1), move(0, -5, 'plunge'), move(10, -5, 'cut'),
    move(10, 2), move(30, 2), move(30, 1), move(30, -5, 'plunge'), move(40, -5, 'cut'), move(40, 15)]
  const programs = [undefined, true, false].map(minimizeZTravel => {
    const op = makeOp({ heights: { ...makeOp().heights, clearanceHeight: 15, retractHeight: 5, feedHeight: 4.5, minimizeZTravel } })
    return emitProgram({ machine, setup: { wcs: makeWcs(), operations: [{ op, tool, moves,
      feeds: resolveFeedrates(tool, undefined), spindle: resolveSpindle(op, tool, machine), coolant: resolveCoolant(tool, machine) }] } }, UCCNC_CONFIG)
  })
  expect(programs[1].lines).toEqual(programs[0].lines)
  const posted = programs[2].lines.join('\n')
  expect(posted, 'unchecked rapid must stop at Feed before the first plunge').toMatch(/\n(?:G0 )?Z4\.5\nG1 Z1 F400/)
  const read = readGcodeProgram(posted, { dialect: 'uccnc', sessionWcs: 'G54', initialPosition: { x: 0, y: 0, z: 50 },
    machineUnits: 'mm', workOffsets: { G54: { x: 0, y: 0, z: 0 } } })
  expect(read.ok).toBe(true)
  if (read.ok) expect(violations(read.program.moves as ToolpathMove[], 5)).toEqual([])
  expect(programs[2].lines).toContain('G0 Z15')
})

const cases = [
  ['2d-bore-drill', 'ex04-tool-storage-bar-declared'],
  ['2d-contour', 'ex01-fixture-plate-declared'],
  ['adaptive', 'engagement-pocket-adaptive_clearing_2d-declared'],
  ['3d', 'ex07-relief-medallion-declared'],
  ['vcarve', 'ex05-name-sign-declared'],
] as const
for (const [label, id] of cases) {
  it(`WO-3104 production ${label}: unchecked hops at Retract; checked and cutting geometry preserved`, async () => {
    const source = alpha3Chains().find(c => c.id === id)
    expect(source, id).toBeDefined()
    const chain = structuredClone(source!) as BenchmarkChain
    // One library variant per authored operation; preserve operation order and stock history.
    const seen = new Set<string>()
    chain.steps = chain.steps.filter(s => {
      const name = s.authoredOperation?.name ?? s.id
      if ((label === '3d' || label === 'vcarve') && s.type === 'contour_2d') return false
      if (seen.has(name)) return false
      seen.add(name); return true
    })
    const off = await planChain(chain)
    for (const s of chain.steps) if (s.authoredOperation) s.authoredOperation.heights.minimizeZTravel = false
    // Set the authored switch through the real store before Generate. The synthetic
    // adaptive chain constructs its operations internally, so it has no authoredOperation.
    const resolved = new Map<string, NonNullable<ReturnType<typeof makeOp>['resolvedHeights']>>()
    vi.doMock('../../store', async importOriginal => {
      const actual = await importOriginal<typeof import('../../store')>()
      const run = actual.useCamStore.getState().computeOperationToolpath
      actual.useCamStore.setState({ computeOperationToolpath: async (setupId, opId, batchId) => {
        const state = actual.useCamStore.getState()
        const op = state.project.setups.find(s => s.id === setupId)!.operations.find(o => o.id === opId)!
        state.updateOperation(setupId, opId, { heights: { ...op.heights, minimizeZTravel: false } })
        const result = await run(setupId, opId, batchId)
        const generated = actual.useCamStore.getState().project.setups.find(s => s.id === setupId)!.operations.find(o => o.id === opId)!
        if (generated.resolvedHeights) resolved.set(opId, structuredClone(generated.resolvedHeights))
        return result
      } })
      return typedMock<typeof import('../../store')>({ ...actual })
    })
    let on: Awaited<ReturnType<typeof planChain>>
    try { on = await planChain(chain) } finally { vi.doUnmock('../../store') }
    const phase = process.env.WO3104_PHASE ?? 'toggle-new'
    const dir = evidenceOutDir(`src/tests/evidence/WO-3104/${phase}`)
    mkdirSync(dir, { recursive: true })
    const errors: string[] = []
    const evidence: unknown[] = []
    for (let i = 0; i < chain.steps.length; i++) {
      const a = off.steps[i], b = on.steps[i]
      expect(a.status, `${label} Off ${a.stepId}: ${a.operatorText}`).toBe('ready')
      expect(b.status, `${label} On ${b.stepId}: ${b.operatorText}`).toBe('ready')
      const origin = b.sourceWcsOrigin?.z ?? 0
      const snapshot = resolved.get(b.stepId)
      const floor = snapshot?.machine.retract ?? origin + b.heights!.retractHeight
      const bad = violations(b.moves, floor)
      if (bad.length) errors.push(`${b.stepId}: ${bad.length} travels below Retract`)
      if (label === 'adaptive') writeFileSync(`${dir}/adaptive-diagnostic.json`, JSON.stringify({ off: a.moves, on: b.moves }))
      // Entries, passes, and operation approach/exit stay at their original coordinates.
      // Assembly trim introduces vertical feed re-entries after raised adaptive air
      // links. Compare every XY cutting segment (including its original start), and
      // every non-plunge cutting endpoint/feed. No changed or additional XY cut is allowed.
      // V-carve's proved air links were historically labelled stepover. Match
      // only the exact XY segments reclassified loop_back when the floor is On;
      // retain every other stepover in the cutting comparison.
      const xyKey = (moves: ToolpathMove[], j: number) => {
        const p = moves[j - 1], m = moves[j]
        return p ? [p.x, p.y, m.x, m.y].join(',') : ''
      }
      const airLinks = new Set(b.moves.flatMap((m, j) => m.role === 'loop_back' ? [xyKey(b.moves, j)] : []))
      const oldAirStep = (moves: ToolpathMove[], j: number) => moves === a.moves && label === 'vcarve'
        && moves[j].role === 'stepover' && airLinks.has(xyKey(moves, j))
      const xyCuts = (moves: ToolpathMove[]) => moves.flatMap((m, j) => {
        const prev = moves[j - 1]
        return prev && !noncut(m) && !oldAirStep(moves, j) && Math.hypot(m.x - prev.x, m.y - prev.y) > 1e-6
          ? [{ from: { x: prev.x, y: prev.y, z: prev.z }, to: m }] : []
      })
      expect(xyCuts(b.moves)).toEqual(xyCuts(a.moves))
      expect(b.moves.filter(m => !noncut(m) && m.role !== 'plunge'))
        .toEqual(a.moves.filter((m, j) => !noncut(m) && m.role !== 'plunge' && !oldAirStep(a.moves, j)))
      expect(b.moves[0]).toEqual(a.moves[0])
      expect(b.moves.at(-1)).toEqual(a.moves.at(-1))
      if (label === 'vcarve') {
        // Fixed ex05 fixture segment from linkTo's across < topZ/retractZ branch:
        // liftedLinkZ proves its cutter footprint clear. Historically it was
        // labelled stepover, so a role-only oracle would silently miss this air link.
        // XY endpoints identify the same production segment independently of its role.
        const airSegment = b.moves.findIndex((m, j) => j > 0
          && Math.abs(b.moves[j - 1].x - (-47.2886962890625)) < 1e-6
          && Math.abs(b.moves[j - 1].y - (-9.2886962890625)) < 1e-6
          && Math.abs(m.x - (-59.2412041019218)) < 1e-6
          && Math.abs(m.y - (-10.241141745626063)) < 1e-6)
        expect(airSegment, 'known cleared-air V-carve segment must remain present').toBeGreaterThan(0)
        if (Math.min(b.moves[airSegment - 1].z, b.moves[airSegment].z) < floor - 1e-6) {
          bad.push(airSegment)
          errors.push('unchecked V-carve cleared-air link below Retract (old stepover label)')
        }
      }
      const tool = toolById(chain.steps[i].toolId).libraryTool ?? makeTool()
      const machine = chain.alpha3?.project?.machine ?? makeMachine()
      for (const [which, step] of [['off', a], ['on', b]] as const) {
        const op = makeOp({ ...chain.steps[i].authoredOperation, ...step.settings, type: chain.steps[i].type,
          heights: step.heights ?? makeOp().heights, ...(which === 'on' ? { resolvedHeights: snapshot } : {}), params: chain.steps[i].params })
        const posted = emitProgram({ machine, setup: { wcs: step.sourceWcs ?? makeWcs(), operations: [{
          op, tool, moves: step.moves, feeds: resolveFeedrates(tool, op.feedrateOverride),
          spindle: resolveSpindle(op, tool, machine), coolant: resolveCoolant(tool, machine),
        }] } }, UCCNC_CONFIG)
        writeFileSync(`${dir}/${label}-${i}-${which}.nc`, posted.lines.join('\n') + '\n')
      }
      evidence.push({ name: chain.steps[i].authoredOperation?.name ?? chain.steps[i].id, type: chain.steps[i].type, tool: tool.id,
        floor: floor - origin, planes: snapshot?.wcs, wcsZ: origin, off: a.moves, on: b.moves, violations: bad })
    }
    writeFileSync(`${dir}/${label}.json`, JSON.stringify(evidence))
    expect(errors, 'unchecked Retract violated by production output').toEqual([])
  }, 900_000)
}
