// WO-2530: the tool-reach check counts the holes a drill already made.
//
// Part 1 is the replay itself (remainingStockBefore): a drilled hole comes out
// of the remaining stock as a flat-bottomed cylinder of the drill's diameter,
// down to where the drill reaches full diameter - the tip cone below stays
// solid - and the tools a height field cannot follow are still not replayed.
//
// Part 2 is WO-2515's Fixture Plate (branch wo/WO-2515, attempt 1, exported
// project; the Contour and Chamfer that follow the Thread Mill are dropped, they
// cannot change what it sees): Face, Drill (explicit -8 mm + Break through
// 0.5 mm, 5 mm drill) and a full-depth Thread Mill with a 1.2 mm neck, each
// generated through the store's own computeOperationToolpath and the real
// toolpathWorker in-process. Before the fix the reach check stopped the Thread
// Mill at 12 places, 794.7 mm uncut, against pilot holes it did not know about.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { typedMock } from '../support/typedMock'
import type { Tool, ToolpathMove } from '../../types'
import type { StockState } from '../../lib/cam/stockState'

vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  cacheSTL: vi.fn(async () => {}), loadCachedSTL: vi.fn(async () => null), removeCachedSTL: vi.fn(async () => {}),
}))
vi.mock('../../lib/stepCache', () => typedMock<typeof import('../../lib/stepCache')>({
  cacheStep: vi.fn(async () => {}), loadCachedStep: vi.fn(async () => null), removeCachedStep: vi.fn(async () => {}),
}))

const mem = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    get length() { return mem.size },
    clear: () => mem.clear(),
    getItem: (k: string) => mem.get(k) ?? null,
    key: (i: number) => [...mem.keys()][i] ?? null,
    removeItem: (k: string) => { mem.delete(k) },
    setItem: (k: string, v: string) => { mem.set(k, String(v)) },
  },
  configurable: true,
})

const { remainingStockBefore } = await import('../../store/toolReachInputs')
const { drillPointCompensationMm } = await import('../../lib/cam/smartHeights/drillBore')
const { useCamStore, smartHeightStockBounds, setupProvenStockId } = await import('../../store')

// The worker runs in-process: the store posts to a Worker shim that hands the
// request straight to toolpathWorker's onmessage, exactly as the browser would.
type Handler = ((event: { data: unknown }) => void) | null
const g = globalThis as unknown as {
  window?: Record<string, unknown>
  self: { postMessage: (m: unknown) => void; onmessage: ((e: { data: unknown }) => unknown) | null }
  Worker: unknown
}
let activeShim: { onmessage: Handler } | null = null
if (g.window === undefined) g.window = {}
g.window.__cncViewport = {
  getStockBounds: (stockId?: string) => {
    const project = useCamStore.getState().project
    const setup = project.setups[0]
    return smartHeightStockBounds(project, stockId ?? setupProvenStockId(setup, project)!)
  },
}
g.self = { postMessage: (m: unknown) => { activeShim?.onmessage?.({ data: m }) }, onmessage: null }
await import('../../lib/cam/toolpathWorker')
const workerSelf = g.self
g.Worker = class {
  onmessage: Handler = null
  onerror: Handler = null
  postMessage(data: unknown) { activeShim = this; void workerSelf.onmessage?.({ data }) }
  terminate() { activeShim = null }
}

// ── Part 1: the replay ──────────────────────────────────────────────────────

/** A 20 x 20 x 10 mm block, world Z 0..10. */
const BLOCK = { min: { x: 0, y: 0, z: 0 }, max: { x: 20, y: 20, z: 10 } }
const TIP_Z = 2

function tool(overrides: Partial<Tool>): Tool {
  return {
    id: 't', name: 't', type: 'drill', diameter: 5, fluteLength: 20, shankDiameter: 5, overallLength: 50,
    numberOfFlutes: 2, angleFromAxisDeg: 59, material: 'hss', coating: 'none', notes: '', feedsAndSpeeds: {},
    ...overrides,
  } as Tool
}

/** One peck-free drill cycle at (10, 10): rapid down, plunge to the tip, rapid out. */
const DRILL_CYCLE: ToolpathMove[] = [
  { type: 'rapid', x: 10, y: 10, z: 15, role: 'rapid' },
  { type: 'feed', x: 10, y: 10, z: 12, feed: 300, role: 'rapid' },
  { type: 'feed', x: 10, y: 10, z: TIP_Z, feed: 150, role: 'plunge' },
  { type: 'rapid', x: 10, y: 10, z: 15, role: 'rapid' },
]

/** The material top of the column whose centre is nearest (x, y). */
function topAt(stock: StockState, x: number, y: number): number {
  const i = Math.floor((x - stock.bounds.minX) / stock.resolutionMm)
  const j = Math.floor((y - stock.bounds.minY) / stock.resolutionMm)
  return stock.topZ[j * stock.nx + i]
}

function replay(drill: Tool) {
  return remainingStockBefore([{ enabled: true, status: 'ready', toolpathMoves: DRILL_CYCLE, tool: drill }], BLOCK)
}

describe('WO-2530 part 1: a drilled hole replays as a flat down to full diameter only', () => {
  it('removes a cylinder of the drill diameter down to the full-diameter depth, never the tip cone', () => {
    const drill = tool({})
    const pointLength = drillPointCompensationMm(drill)
    expect(pointLength).toBeCloseTo(2.5 / Math.tan(59 * Math.PI / 180), 9)
    const remaining = replay(drill)
    expect(remaining?.operationsReplayed).toBe(1)
    const stock = remaining!.stock
    const fullDiameterZ = TIP_Z + pointLength
    // At the centre the tip went to Z 2, but only the full-diameter depth is counted.
    expect(topAt(stock, 10.1, 10.1)).toBeCloseTo(fullDiameterZ, 4)
    expect(topAt(stock, 10.1, 10.1)).toBeGreaterThan(TIP_Z + 1)
    // The same flat reaches out toward the wall: 2 mm off centre is inside the 2.5 mm radius.
    expect(topAt(stock, 12.1, 10.1)).toBeCloseTo(fullDiameterZ, 4)
    // Outside the hole the block is untouched.
    expect(topAt(stock, 13.4, 10.1)).toBe(BLOCK.max.z)
    expect(topAt(stock, 2, 2)).toBe(BLOCK.max.z)
    // Nothing anywhere is taken below the full-diameter depth.
    expect(Math.min(...stock.topZ)).toBeCloseTo(fullDiameterZ, 4)
  })

  it('a 180 deg (flat) point counts the hole down to the tip; spot and center drills replay the same way', () => {
    const flat = replay(tool({ angleFromAxisDeg: 90 }))!.stock
    expect(topAt(flat, 10.1, 10.1)).toBeCloseTo(TIP_Z, 4)
    for (const type of ['spot_drill', 'center_drill'] as const) {
      const spot = tool({ type, diameter: 6, angleFromAxisDeg: 45 })
      const stock = replay(spot)!.stock
      expect(topAt(stock, 10.1, 10.1)).toBeCloseTo(TIP_Z + 3, 4)
    }
  })

  it('a drill whose point cannot be read, and the tools a height field cannot follow, are not replayed', () => {
    expect(replay(tool({ tipDiameter: 6 }))).toBeUndefined()
    for (const type of ['thread_mill', 'chamfer_mill', 'v_bit', 'countersink', 'lollipop_mill', 'dovetail_mill', 'slitting_saw', 'tap'] as const) {
      expect(replay(tool({ type })), type).toBeUndefined()
    }
  })
})

// ── Part 2: WO-2515's Fixture Plate through the production Generate ─────────

interface OperationReadback {
  name: string
  status: string
  errorMessage?: string
  toolpathMoves?: ToolpathMove[]
  reachShortfall?: { reachedZ: number; askedZ: number; uncutMm: number }
}

const PROJECT = join(process.cwd(), 'src', 'tests', 'evidence', 'WO-2530', 'fixture-plate-wo2515.camproject')

describe('WO-2530 part 2: the Fixture Plate Thread Mill is judged against its pilot holes', () => {
  let thread: OperationReadback
  let reachLines: string[]

  beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'info').mockImplementation(() => {})
    await useCamStore.getState().loadProjectFromFile(readFileSync(PROJECT, 'utf8'))
    const setup = useCamStore.getState().project.setups[0]
    for (const name of ['Face 1', 'Drill 2', 'Thread Mill 3']) {
      const op = setup.operations.find(o => o.name === name)!
      await useCamStore.getState().computeOperationToolpath(setup.id, op.id)
    }
    const ops = useCamStore.getState().project.setups[0].operations as unknown as OperationReadback[]
    for (const op of ops) expect(op.status, `${op.name}: ${op.errorMessage ?? ''}`).toBe('ready')
    thread = ops.find(o => o.name === 'Thread Mill 3')!
    reachLines = useCamStore.getState().consoleEvents
      .map(e => e.message)
      .filter(m => /left uncut|stopped short/i.test(m))
    console.warn('[WO-2530] Thread Mill 3', JSON.stringify({
      moves: thread.toolpathMoves?.length ?? 0,
      lowestZ: Math.min(...(thread.toolpathMoves ?? []).map(m => m.z)),
      reachShortfall: thread.reachShortfall ?? null,
      reachLines,
    }))
  }, 300_000)

  it('cuts the full-depth threads with nothing left uncut and no stop said', () => {
    expect(thread.reachShortfall).toBeUndefined()
    expect(reachLines).toEqual([])
    expect(Math.min(...thread.toolpathMoves!.map(m => m.z))).toBeCloseTo(-8, 3)
  })
})
