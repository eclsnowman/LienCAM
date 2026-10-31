// WO-3054: adaptive into a closed pocket enters by helix, or plunges only into a hole an earlier
// operation already cleared. The operator (10-21): "it has to do Helix entry for adaptive into a
// pocket ... the only viable option is a helix or entering in from a previously cleared hole
// (drilled, bored, etc)." Every row below runs through the production route (planChain = the
// store's computeOperationToolpath), so the earlier operations' moves reach adaptive the way the
// app hands them over: the remaining-stock replay of the setup (WO-1582).
// 0. The engine rule itself (processFeature): a plunge setting with no cleared hole plans exactly
//    what the default helix setting (90% of the tool) plans; with a cleared hole the entry is a
//    plunge into it.
// 1. The declared H-pocket (6 mm tool, 1 mm stepover, entry = plunge, no earlier operation) cut
//    nothing (WO-3024: status error, 0 moves). It now cuts, enters by helix, never plunges into
//    stock, stays under the 0.75-of-slot ceiling, and says once in the console what it did.
// 2. A closed pocket with a drilled hole inside it (the fixture plate's Drill, then adaptive with
//    entry = plunge): the first entry is a straight plunge into a drilled hole, and no helix runs.
//    The same pocket without the Drill enters by helix.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolpathMove } from '../../../types'
import { typedMock } from '../../support/typedMock'
import { diskPath, ensureEngineClipperReady } from '../../../lib/cam/adaptiveClearing2d/engine/clipperEngine'
import { processFeature, type Feature, type ProcessParams } from '../../../lib/cam/adaptiveClearing2d/engine/processFeature'
import { planChain, scoreChain } from '../../benchmark/chainRunner'
import { alpha3Chains, type BenchmarkChain, type BenchmarkStep } from '../../benchmark/registry'

// The engine's operator notices (they reach the app console through the worker), seen in every
// copy of the module planChain's fresh store loads.
const notices = vi.hoisted(() => [] as string[])
vi.mock('../../../lib/cam/adaptiveClearing2d/engine/operatorNotices', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../lib/cam/adaptiveClearing2d/engine/operatorNotices')>()
  return typedMock<typeof real>({ ...real, operatorNotice: (message: string) => { notices.push(message); real.operatorNotice(message) } })
})

const CEILING = 0.75 // AP.caps.slotCeilingDiameters: sustained width as a fraction of a full slot
const NOTE = 'Plunge entry into a closed pocket with no cleared hole - entered with a helix.'

const declaredHPocket = (): BenchmarkChain => {
  const chain = alpha3Chains().find(c => c.id === 'engagement-pocket-adaptive_clearing_2d-declared')!
  return { ...chain, steps: chain.steps.filter(step => step.id === 'adaptive_clearing_2d') }
}

// The fixture plate (ex01) with one more closed loop: a 25 x 18 mm pocket round the drilled
// hole at (-12.5, 0), off the pocket's own centre so only the hole can draw the entry there.
const GEO = 'bc6b2b69-2005-4af8-a791-105d1bf45653'
const POCKET = `${GEO}~wo3054-pocket`
const drilledPocket = (withDrill: boolean): BenchmarkChain => {
  const plate = alpha3Chains().find(c => c.id === 'ex01-fixture-plate-declared')!
  const project = structuredClone(plate.alpha3!.project!)
  const geometry = project.geometry.find(g => g.id === GEO)!
  geometry.loops = [...(geometry.loops ?? []), {
    id: POCKET, type: 'contour', closed: true, layerId: geometry.loops![0].layerId,
    points: [{ x: -30, y: -9 }, { x: -5, y: -9 }, { x: -5, y: 9 }, { x: -30, y: 9 }],
  } as NonNullable<typeof geometry.loops>[number]]
  const drill = plate.steps.find(step => step.type === 'drill')!
  const hPocket = declaredHPocket().steps[0]
  const authored = structuredClone(drill.authoredOperation!)
  delete (authored as { smartHeight?: unknown }).smartHeight
  const adaptive: BenchmarkStep = {
    ...hPocket,
    id: 'wo3054-adaptive',
    toolId: 'starter-metric-1',
    setupLabel: drill.setupLabel,
    authoredSetupId: drill.authoredSetupId,
    geometrySelections: [POCKET],
    params: { ...hPocket.params, geometryId: GEO, loopIds: [POCKET], planeOffset: -2 },
    authoredOperation: {
      ...authored,
      name: 'Adaptive into the drilled pocket',
      type: 'adaptive_clearing_2d',
      geometrySelections: [POCKET],
      heights: { ...authored.heights, bottomHeight: -2, heightIntent: undefined },
      passes: { ...authored.passes, stepdown: 2, stepover: 1, finishPasses: 0 },
      linking: { ...authored.linking, entryType: 'plunge' },
    } as BenchmarkStep['authoredOperation'],
  }
  return { ...plate, id: `wo3054-drilled-pocket-${withDrill ? 'drill' : 'no-drill'}`,
    steps: withDrill ? [drill, adaptive] : [adaptive], alpha3: { ...plate.alpha3!, project } }
}

// How the tool first goes down into the stock: the descent between the last rapid and the first
// cut. A helix entry's approach has a short 'plunge' through air to the level's start depth, so a
// descent holding any helix move is a helix; one holding only a plunge is a straight plunge.
const firstEntry = (moves: ToolpathMove[]): { kind: 'helix' | 'plunge' | 'none'; at: ToolpathMove | undefined } => {
  const cut = moves.findIndex(m => m.role === 'cut')
  let from = cut
  while (from > 0 && moves[from - 1].role !== 'rapid') from--
  const descent = moves.slice(from, cut)
  if (descent.some(m => m.role === 'helix')) return { kind: 'helix', at: descent.find(m => m.role === 'helix') }
  const plunge = descent.filter(m => m.role === 'plunge').pop()
  return { kind: plunge ? 'plunge' : 'none', at: plunge }
}

describe('WO-3054 adaptive into a closed pocket: helix, or a plunge into an already-cleared hole', () => {
  beforeEach(() => { notices.length = 0 })

  it('engine: a plunge with no cleared hole plans the default helix; with one it plunges into the hole', async () => {
    await ensureEngineClipperReady()
    const pocket: Feature = { boundary: [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 24 }, { x: 0, y: 24 }] }
    const base: ProcessParams = { toolRadius: 3, stepOver: 1 / 6, tolerance: 0.05, helixDiameter: 0 }
    const plunged = processFeature(pocket, base)
    const helixed = processFeature(pocket, { ...base, helixDiameter: 0.9 * 6 })
    expect(plunged.passes.length).toBeGreaterThan(0)
    expect(plunged.entries[0].mode).toBe('helix')
    expect(JSON.stringify({ e: plunged.entries, p: plunged.passes })).toBe(JSON.stringify({ e: helixed.entries, p: helixed.passes }))
    expect(notices).toEqual([NOTE])
    notices.length = 0
    // An 8 mm hole drilled at (30, 12), away from the pocket's middle: the entry goes straight down into it.
    const holed = processFeature(pocket, { ...base, clearedHoles: diskPath({ x: 30, y: 12 }, 4, 0.01) })
    expect(holed.entries[0].mode).toBe('plunge')
    expect(Math.hypot(holed.entries[0].point.x - 30, holed.entries[0].point.y - 12)).toBeLessThan(0.5)
    expect(holed.passes.length).toBeGreaterThan(0)
    // A later re-seed into stock the hole does not reach takes the helix, and says so once.
    expect(holed.entries.slice(1).every(e => e.mode === 'helix')).toBe(true)
    expect(notices).toEqual(holed.entries.length > 1 ? [NOTE] : [])
    // A hole narrower than the tool is no way in: the helix again.
    const narrow = processFeature(pocket, { ...base, clearedHoles: diskPath({ x: 30, y: 12 }, 2.5, 0.01) })
    expect(narrow.entries[0].mode).toBe('helix')
    // A helix setting never reads the holes.
    const helixWithHole = processFeature(pocket, { ...base, helixDiameter: 0.9 * 6, clearedHoles: diskPath({ x: 30, y: 12 }, 4, 0.01) })
    expect(JSON.stringify(helixWithHole.passes)).toBe(JSON.stringify(helixed.passes))
  }, 120_000)

  it('the plunge-entry H-pocket cuts, entered by helix, under the ceiling, and says what it did', async () => {
    const chain = declaredHPocket()
    const planned = await planChain(chain)
    const step = planned.steps[0]
    expect({ status: step.status, text: step.operatorText }).toEqual({ status: 'ready', text: '' })
    expect(step.moves.filter(m => m.role === 'cut').length, 'plunge-entry H-pocket has cutting moves').toBeGreaterThan(0)
    // The first way into the stock is a helix, and the scorecard ranks no entry as a plunge.
    expect(firstEntry(step.moves).kind).toBe('helix')
    const row = (await scoreChain(chain, planned)).rows[0]
    expect(row.metrics['M-ENTRY-4.plunge'], 'entries ranked as plunges').toBe(0)
    expect(row.metrics.peakEngagementFraction as number, 'peak sustained engagement').toBeLessThanOrEqual(CEILING)
    // WO-3316: the pre-existing helix-entry row measured 2 mm of intrusion on a non-cutting
    // move; this path now measures 0 (no rapid or link reaches the material left). The bound
    // is the pre-existing row's, so the entry pattern is never worse than the one it replaces.
    expect(row.metrics['M-SAFE-2'], 'M-SAFE-2 no worse than the pre-existing WO-3030/3037 row').toBeLessThanOrEqual(2)
    expect(notices, 'the console line').toContain(NOTE)
  }, 600_000)

  it('a closed pocket with a drilled hole: the plunge goes straight down into the hole, no helix', async () => {
    const planned = await planChain(drilledPocket(true))
    const [drill, adaptive] = planned.steps
    expect(drill.status).toBe('ready')
    expect(adaptive.status).toBe('ready')
    expect(adaptive.moves.filter(m => m.role === 'cut').length, 'the pocket is cut').toBeGreaterThan(0)
    expect(adaptive.moves.some(m => m.role === 'helix'), 'no helix').toBe(false)
    const { kind, at: entry } = firstEntry(adaptive.moves)
    expect(kind).toBe('plunge')
    const holes = drill.moves.filter(m => m.role === 'plunge' || m.type === 'feed')
    const nearest = Math.min(...holes.map(h => Math.hypot(h.x - entry!.x, h.y - entry!.y)))
    expect(nearest, 'the plunge lands in a drilled hole').toBeLessThan(0.5)
    expect(notices).not.toContain(NOTE)
  }, 600_000)

  it('the same pocket without the Drill enters by helix', async () => {
    const planned = await planChain(drilledPocket(false))
    const adaptive = planned.steps[0]
    expect(adaptive.status).toBe('ready')
    expect(firstEntry(adaptive.moves).kind).toBe('helix')
    expect(notices).toContain(NOTE)
  }, 600_000)
})
