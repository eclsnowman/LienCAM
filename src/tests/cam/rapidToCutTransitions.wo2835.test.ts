// WO-2835: rapid-to-cut transitions go through the lead-in; rapids over cleared floors hop.
//
// the operator 2026-10-15: "We never want to slam a rapid into material and only slow after
// engagement ... Also lifting slightly (z move) over clear floors during the rapid (3d move
// zup x/y move zdown) ... We would only need 0.2 to 0.5mm in most instances."
//
// Runs Full Suite Setup 1 / Adaptive Clearing 1 through the production compute (the store's
// computeOperationToolpath and the in-process toolpath worker), at the default hop, with the
// hop off (0, the legacy shapes) and at 0.5 mm. Round 2 adds the same rules on 3D adaptive and a
// 3D finish (Full Suite Setup 5, with the real cam3d kernel in-process), a small clearance
// height, and a contour after the adaptive.
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { typedMock } from '../support/typedMock'
import type { ToolpathMove } from '../../types'
import type { AirFeedOverRemovedStockInput, AirFeedOverRemovedStockResult } from '../../cam3d/integration/airFeedOverRemovedStock'
import { emitConnectionPass, type EmitContext } from '../../lib/cam/adaptiveClearing2d/engine/emit'
import type { AdaptivePass } from '../../lib/cam/adaptiveClearing2d/engine/processFeature'
import { effectiveMoveMotion } from '../../lib/cam/stockCuttingRoles'

import type { CachedStepDisplay, StepDisplayTessellation } from '../../lib/stepCache'
import type { BrepModelPayload } from '../../lib/cam/geometry/occt/model/types'

// In-memory binary caches so a File Open keeps every embedded STL/STEP byte.
const stlBytes = new Map<string, ArrayBuffer>()
const stepBytes = new Map<string, ArrayBuffer>()
const stepDisplay = new Map<string, CachedStepDisplay>()
vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  cacheSTL: vi.fn(async (id: string, buffer: ArrayBuffer) => { stlBytes.set(id, buffer) }),
  loadCachedSTL: vi.fn(async (id: string) => stlBytes.get(id) ?? null),
  removeCachedSTL: vi.fn(async (id: string) => { stlBytes.delete(id) }),
}))
vi.mock('../../lib/stepCache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/stepCache')>()
  return typedMock<typeof import('../../lib/stepCache')>({
    ...actual,
    cacheStep: vi.fn(async (id: string, buffer: ArrayBuffer) => { stepBytes.set(id, buffer) }),
    loadCachedStep: vi.fn(async (id: string) => stepBytes.get(id) ?? null),
    removeCachedStep: vi.fn(async (id: string) => { stepBytes.delete(id) }),
    cacheStepDisplay: vi.fn(async (
      id: string,
      payload: BrepModelPayload,
      sourceSha256: string,
      tessellation: StepDisplayTessellation | null,
    ) => {
      stepDisplay.set(id, {
        displayContractVersion: 1, sourceSha256, tessellation, payload, byteLength: 0, updatedAt: 0,
      })
    }),
    loadCachedStepDisplay: vi.fn(async (id: string) => stepDisplay.get(id) ?? null),
    removeCachedStepDisplay: vi.fn(async (id: string) => { stepDisplay.delete(id) }),
  })
})

// 3D families: the real BvhKernel + cam3d dispatcher in-process (no Worker here).
vi.mock('../../cam3d/integration/appClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../cam3d/integration/appClient')>()
  const { BvhKernel } = await import('../../cam3d/kernel/bvhKernel')
  const { Cam3dClient } = await import('../../cam3d/worker/client')
  const { Cam3dDispatcher } = await import('../../cam3d/worker/dispatcher')
  let client: InstanceType<typeof Cam3dClient> | null = null
  const make = () => {
    const kernel = new BvhKernel()
    const fakeWorker = {
      onmessage: null as ((event: MessageEvent) => void) | null,
      onerror: null,
      postMessage(message: unknown): void { dispatcher.handle(message as never) },
      terminate(): void {},
    }
    const dispatcher = new Cam3dDispatcher(kernel, (message: unknown) => {
      fakeWorker.onmessage?.({ data: message } as MessageEvent)
    })
    return new Cam3dClient(fakeWorker as never)
  }
  return typedMock<typeof import('../../cam3d/integration/appClient')>({
    ...actual,
    getCam3dClient: () => (client ??= make()),
    disposeCam3dClient: () => { client = null },
  })
})

// STEP parts tessellate through the in-process OCCT core instead of the browser model worker.
vi.mock('../../cam3d/input/stepTessellatorWorker', async () => {
  const { readFileSync } = await import('node:fs')
  const nodePath = await import('node:path')
  const { loadOcctModel } = await import('../../lib/cam/geometry/occt/model/loader')
  const { makeOcctCoreTessellator } = await import('../../cam3d/input/occtCoreTessellator')
  const wasmPath = nodePath.resolve(__dirname, '../../lib/cam/geometry/occt/model/vendor/occt-model.wasm')
  let tessellator: import('../../cam3d/input/types').StepTessellator | null = null
  const workerStepTessellator: import('../../cam3d/input/types').StepTessellator = async (bytes, params) => {
    tessellator ??= makeOcctCoreTessellator(await loadOcctModel({ wasmBinary: readFileSync(wasmPath) }))
    return tessellator(bytes, params)
  }
  return typedMock<typeof import('../../cam3d/input/stepTessellatorWorker')>({ workerStepTessellator })
})

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

// Test-only negative control: suppress this seam only while computing the clear
// positive fixture. Original Full Suite safety regressions always run real code.
const positiveControl = vi.hoisted(() => ({ active: false,
  suppress: process.env.WO2835_SUPPRESS_POSITIVE_CONVERSION === '1',
  calls: [] as { input: AirFeedOverRemovedStockInput; result: AirFeedOverRemovedStockResult }[],
  /** Every call's conversion counts (all fixtures), for the WO-2835 link-count record. */
  counts: [] as { candidates: number; rapided: number }[],
}))
vi.mock('../../cam3d/integration/airFeedOverRemovedStock', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../cam3d/integration/airFeedOverRemovedStock')>()
  return typedMock<typeof import('../../cam3d/integration/airFeedOverRemovedStock')>({
    ...actual,
    rapidAirFeedsOverRemovedStock: (input) => {
      const result = positiveControl.active && positiveControl.suppress
        ? { moves: [...input.moves], candidates: 0, rapided: 0 }
        : actual.rapidAirFeedsOverRemovedStock(input)
      if (positiveControl.active) positiveControl.calls.push({ input, result })
      positiveControl.counts.push({ candidates: result.candidates, rapided: result.rapided })
      return result
    },
  })
})

const { useCamStore, smartHeightStockBounds, setupProvenStockId } = await import('../../store')
const { ensureClipperReady } = await import('../../lib/cam/face2d/clipperOffset')

// The worker runs in-process: the store posts to a Worker shim that hands the
// request straight to toolpathWorker's onmessage, exactly as the browser would.
type Handler = ((event: { data: unknown }) => void) | null
const g = globalThis as unknown as {
  window?: Record<string, unknown>
  self: { postMessage: (m: unknown) => void; onmessage: ((e: { data: unknown }) => unknown) | null }
  Worker: unknown
}
let activeShim: { onmessage: Handler } | null = null
/** The setup whose proven stock the viewport reports (the store asks with no id). */
let viewportSetup = 0
if (g.window === undefined) g.window = {}
g.window.__cncViewport = {
  getStockBounds: (stockId?: string) => {
    const project = useCamStore.getState().project
    const setup = project.setups[viewportSetup]
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

await ensureClipperReady()

const OP = 'Adaptive Clearing 1'
const CUTTING = new Set(['cut', 'wall_follow', 'finish', 'lead_in', 'lead_out', 'plunge', 'ramp', 'helix'])
const EPS = 1e-6

/** Adaptive Clearing 1 of Full Suite Setup 1 through the store's production compute, with
 *  the floor-hop setting written into the loaded operation's linking (undefined: as saved). */
async function generate(
  floorHopMm: number | undefined, name = OP, edit?: (fileOp: FileOperation) => void,
): Promise<{ moves: ToolpathMove[]; topZ: number; toolDia: number; clearanceZ: number }> {
  const file = JSON.parse(readFileSync(join(process.cwd(), 'Example Projects/Full Suite.camproject'), 'utf8'))
  const proj = file.project ?? file
  const fileOp = proj.setups[0].operations.find((o: { name: string }) => o.name === name)
  if (floorHopMm !== undefined) fileOp.linking.floorHopMm = floorHopMm
  edit?.(fileOp)
  await useCamStore.getState().loadProjectFromFile(JSON.stringify(file))
  viewportSetup = 0
  let project = useCamStore.getState().project
  const setup = project.setups[0]
  // Every operation before it first, so it sees what they left (the WO-1888 rest stock).
  for (const earlier of setup.operations.slice(0, setup.operations.findIndex(o => o.name === name))) {
    await useCamStore.getState().computeOperationToolpath(setup.id, earlier.id)
  }
  const adapt = setup.operations.find(o => o.name === name)!
  await useCamStore.getState().computeOperationToolpath(setup.id, adapt.id)
  project = useCamStore.getState().project
  const op = project.setups[0].operations.find(o => o.id === adapt.id)! as unknown as {
    errorMessage?: string; toolpathMoves?: ToolpathMove[]; toolId?: string
    resolvedHeights?: { wcs: { clearance: number } }
  }
  expect(op.errorMessage ?? '').toBe('')
  const originZ = project.setups[0].wcs.origin.z
  const moves = (op.toolpathMoves ?? []).map(m => ({ ...m, z: m.z - originZ }))
  const tool = project.toolLibrary.find(t => t.id === op.toolId)
  return {
    moves, topZ: Math.max(...moves.filter(m => m.type === 'feed').map(m => m.z)), toolDia: tool?.diameter ?? 0,
    clearanceZ: (op.resolvedHeights?.wcs.clearance ?? NaN),
  }
}

/** An operation as the .camproject file stores it (only the fields these tests edit). */
interface FileOperation {
  id: string; name: string; type: string; status?: string
  linking: { floorHopMm?: number }
  params: Record<string, unknown>
  passes: Record<string, unknown>
  smartHeight: { intent: {
    safety: Record<'clearance' | 'retract' | 'feed', unknown>
    machining: { end: { value: { plane: { offsetMm: number } } } }
    policy: { operationType: string; variant: string }
  } }
  [key: string]: unknown
}

interface Hop { start: number; end: number; floor: number; peak: number; landed: boolean }

/** Every run of rapids that leaves a fed move at depth and comes back to depth: the
 *  repositions over the floor, with where they start and end in the move list. */
function floorHops(moves: readonly ToolpathMove[], topZ: number): Hop[] {
  const hops: Hop[] = []
  for (let i = 1; i < moves.length; i++) {
    const prev = moves[i - 1]
    if (moves[i].type !== 'rapid' || prev.type !== 'feed' || prev.z > topZ + EPS) continue
    let j = i
    while (j < moves.length && moves[j].type === 'rapid') j++
    if (j >= moves.length) break
    const peak = Math.max(...moves.slice(i, j).map(m => m.z))
    if (peak - prev.z > 5) { i = j; continue } // a full retract, not a floor hop
    const last = moves[j - 1]
    hops.push({ start: i, end: j - 1, floor: prev.z, peak, landed: Math.abs(last.z - prev.z) <= EPS })
    i = j
  }
  return hops
}


/** Segments bucketed on an XY grid, for "is a point within r of a segment at or below z". */
class SegmentIndex {
  private cells = new Map<string, Array<[ToolpathMove, ToolpathMove]>>()
  private cell: number
  constructor(cell: number) { this.cell = cell }
  private key(i: number, j: number): string { return `${i},${j}` }
  add(a: ToolpathMove, b: ToolpathMove): void {
    const c = this.cell
    for (let i = Math.floor(Math.min(a.x, b.x) / c); i <= Math.floor(Math.max(a.x, b.x) / c); i++) {
      for (let j = Math.floor(Math.min(a.y, b.y) / c); j <= Math.floor(Math.max(a.y, b.y) / c); j++) {
        const k = this.key(i, j)
        const list = this.cells.get(k)
        if (list) list.push([a, b]); else this.cells.set(k, [[a, b]])
      }
    }
  }
  near(x: number, y: number, z: number, r: number): boolean {
    const c = this.cell
    for (let i = Math.floor((x - r) / c); i <= Math.floor((x + r) / c); i++) {
      for (let j = Math.floor((y - r) / c); j <= Math.floor((y + r) / c); j++) {
        for (const [a, b] of this.cells.get(this.key(i, j)) ?? []) {
          if (Math.max(a.z, b.z) > z + EPS) continue
          const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy
          const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / len2))
          if (Math.hypot(a.x + t * dx - x, a.y + t * dy - y) <= r) return true
        }
      }
    }
    return false
  }
}

/** Rapid samples below the stock top that sit over ground neither swept nor approved: not
 *  within a quarter tool diameter of an earlier fed cutter-centre path at or below their Z,
 *  and not on the XY route of a traverse the legacy program already ran at or below their Z
 *  (the planner's proven keep-down routes, which this order raises and does not move). A
 *  rapid that ends against uncut stock is what `bad` counts. */
function rapidsOverUncut(
  run: { moves: ToolpathMove[]; topZ: number; toolDia: number },
  approved: readonly ToolpathMove[] = [],
): { atDepth: number; bad: number } {
  const band = run.toolDia / 4
  const routes = new SegmentIndex(2)
  for (let i = 1; i < approved.length; i++) {
    if (approved[i].role === 'fast_traverse') routes.add(approved[i - 1], approved[i])
  }
  const swept = new SegmentIndex(2)
  let bad = 0
  let atDepth = 0
  for (let i = 1; i < run.moves.length; i++) {
    const m = run.moves[i], prev = run.moves[i - 1]
    if (m.type === 'feed') { swept.add(prev, m); continue }
    if (m.z >= run.topZ - EPS) continue
    atDepth++
    for (let k = 1; k <= 8; k++) {
      const t = k / 8
      const x = prev.x + (m.x - prev.x) * t, y = prev.y + (m.y - prev.y) * t, z = prev.z + (m.z - prev.z) * t
      if (z >= run.topZ - EPS) continue
      if (!swept.near(x, y, z, band) && !routes.near(x, y, z, 1e-6)) { bad++; break }
    }
  }
  return { atDepth, bad }
}

let current: Awaited<ReturnType<typeof generate>>
let legacy: Awaited<ReturnType<typeof generate>>
let half: Awaited<ReturnType<typeof generate>>
let pocket: Awaited<ReturnType<typeof generate>>
let pocketLegacy: Awaited<ReturnType<typeof generate>>

beforeAll(async () => {
  current = await generate(undefined)
  legacy = await generate(0)
  half = await generate(0.5)
  pocket = await generate(undefined, 'Pocket 2')
  pocketLegacy = await generate(0, 'Pocket 2')
}, 600_000)

describe('WO-2835 2D adaptive: rapids hop over cleared floors and never end in a cut', () => {
  it('a reposition that kept the tool down now hops (rise while moving, hold, descend while moving)', () => {
    const hops = floorHops(current.moves, current.topZ)
    expect(hops.length).toBeGreaterThan(0)
    for (const hop of hops) {
      const from = current.moves[hop.start - 1]
      const rise = current.moves[hop.start]
      // Blended, not boxy: the first rapid already moves in XY while it rises.
      expect(Math.hypot(rise.x - from.x, rise.y - from.y)).toBeGreaterThan(EPS)
      expect(rise.z).toBeGreaterThan(from.z + EPS)
      // The setting's height (0.3 by default), never the old 2 mm.
      expect(hop.peak - hop.floor).toBeLessThanOrEqual(0.3 + EPS)
      const after = current.moves[hop.end + 1]
      // The move after the hop is fed: either the cut resumes from a landing in air, or a
      // plunge lands it.
      expect(after.type).toBe('feed')
      if (!hop.landed) expect(after.role).toBe('plunge')
    }
    // the operator's explicit fallback and the 8:31 AM repair assignment retain fed
    // portions wherever empty full-width clearance cannot be established.
    expect(legacy.moves.some(m => m.role === 'fast_traverse')).toBe(true)
    expect(current.moves.some(m => m.role === 'fast_traverse')).toBe(true)
    console.info('WO-2835 link counts', { fixture: 'Full Suite Setup 1 / Adaptive Clearing 1',
      convertedToHop: hops.length,
      keptFedRuns: current.moves.filter((m, i) => m.role === 'fast_traverse' && current.moves[i - 1]?.role !== 'fast_traverse').length })
    // Every retained/inserted fed point stays on an original fed travel segment;
    // the correction must not manufacture another XY route to get a green proof.
    const travel = legacy.moves.flatMap((m, i) => i > 0 && m.role === 'fast_traverse' ? [[legacy.moves[i - 1], m]] : [])
    for (const m of current.moves.filter(m => m.role === 'fast_traverse')) {
      expect(travel.some(([a, b]) => {
        if (Math.abs(m.z - b.z) > EPS) return false
        const dx = b.x - a.x, dy = b.y - a.y, d2 = dx * dx + dy * dy
        const t = d2 > 0 ? Math.max(0, Math.min(1, ((m.x - a.x) * dx + (m.y - a.y) * dy) / d2)) : 0
        return Math.hypot(m.x - a.x - t * dx, m.y - a.y - t * dy) < EPS
      }), 'Fed fallback leaves the original route').toBe(true)
    }
  })

  it('the hop height follows the operation setting', () => {
    const hops = floorHops(half.moves, half.topZ)
    expect(hops.length).toBeGreaterThan(0)
    expect(Math.max(...hops.map(h => h.peak - h.floor))).toBeCloseTo(0.5, 6)
    expect(hops.every(h => h.peak - h.floor <= 0.5 + EPS)).toBe(true)
  })

  it('no rapid ends inside material: every rapid at depth travels over ground a fed move already cleared', () => {
    const result = rapidsOverUncut(current, legacy.moves)
    expect(result.atDepth).toBeGreaterThan(0)
    expect(result.bad).toBe(0)
    // And a rapid never sits inside a lead-in: no rapid between two lead_in moves.
    const insideLead = current.moves.filter((m, i) => m.type === 'rapid'
      && current.moves[i - 1]?.role === 'lead_in' && current.moves[i + 1]?.role === 'lead_in').length
    expect(insideLead).toBe(0)
  })

  it('the cutting moves are unchanged; only the repositions between them moved', () => {
    const cuts = (moves: readonly ToolpathMove[]) => moves.filter(m => CUTTING.has(m.role ?? ''))
      .map(m => `${m.role} ${m.x.toFixed(4)} ${m.y.toFixed(4)} ${m.z.toFixed(4)} ${m.feed ?? ''}`)
    expect(cuts(current.moves)).toEqual(cuts(legacy.moves))
  })
})

describe('WO-2835 2D pocket: an uncertified level-link departure keeps its straight lift', () => {
  // Architect ruling 2026-10-20 (nine proof rounds): a link becomes a sideways rapid/hop only
  // where its clearance certificate passes; an unproven link keeps the motion main runs. No
  // continuous certificate exists for the pocket's blended departure (pocket-continuous-
  // findings.md: all six Pocket 2 departures unresolved), so every level link lifts straight
  // up inside its own cut and traverses at the entry clearance, exactly as with the hop off.
  it('no level link leaves the floor on a sideways rapid, and only certified repositions may change', () => {
    const levelLinks = (moves: readonly ToolpathMove[]) => moves.flatMap((m, i) => i > 0 && m.type === 'rapid'
      && moves[i - 1].type === 'feed' && moves[i - 1].z < pocket.topZ - EPS && m.z > moves[i - 1].z + EPS
      && m.z < pocket.topZ - EPS ? [i] : [])
    const sideways = (moves: readonly ToolpathMove[], i: number) =>
      Math.hypot(moves[i].x - moves[i - 1].x, moves[i].y - moves[i - 1].y)
    // A rise that stays below the stock top is the level link (a retract goes above it).
    const legacyLinks = levelLinks(pocketLegacy.moves)
    const links = levelLinks(pocket.moves)
    expect(legacyLinks.length).toBeGreaterThan(0)
    expect(legacyLinks.every(i => sideways(pocketLegacy.moves, i) <= EPS)).toBe(true)
    expect(links.length).toBe(legacyLinks.length)
    const blended = links.filter(i => sideways(pocket.moves, i) > EPS).length
    console.info('WO-2835 link counts', { fixture: 'Full Suite Setup 1 / Pocket 2', levelLinks: links.length,
      convertedToBlendedRapid: blended, keptStraightLift: links.length - blended })
    expect(blended, 'Uncertified pocket departure became a sideways rapid').toBe(0)
    // The whole link, from the floor to the fed entry, is the hop-off motion move for move.
    for (const [k, i] of links.entries()) {
      const j = legacyLinks[k]
      let end = i
      while (pocket.moves[end].type === 'rapid') end++
      expect(pocket.moves.slice(i - 1, end + 1)).toEqual(pocketLegacy.moves.slice(j - 1, j + end - i + 1))
    }
    const cuts = (moves: readonly ToolpathMove[]) => moves.filter(m => CUTTING.has(m.role ?? '') || m.role === 'stepover')
      .map(m => `${m.role} ${m.x.toFixed(4)} ${m.y.toFixed(4)} ${m.z.toFixed(4)} ${m.feed ?? ''}`)
    expect(cuts(pocket.moves)).toEqual(cuts(pocketLegacy.moves))
  })

  it('no rapid ends inside material, and the entry after each link is fed', () => {
    const result = rapidsOverUncut(pocket, pocketLegacy.moves)
    expect(result.atDepth).toBeGreaterThan(0)
    expect(result.bad).toBe(0)
    for (let i = 1; i < pocket.moves.length; i++) {
      const m = pocket.moves[i], prev = pocket.moves[i - 1]
      if (prev.type === 'rapid' && m.type === 'feed' && prev.z < pocket.topZ - EPS) {
        expect(['helix', 'ramp', 'plunge', 'lead_in']).toContain(m.role)
      }
    }
  })
})

// Controls on the emitter itself (not application truth): the micro-lift landings the Full
// Suite operation does not plan, each shape the hop can take.
describe('WO-2835 hop shapes at the 2D adaptive emitter', () => {
  const ctx = (floorHopMm: number | undefined): EmitContext => ({
    heights: { clearanceZ: 15, retractZ: 5, feedZ: 1, topZ: 0, bottomZ: -2 },
    feeds: { feedRate: 1000, plungeRate: 300, rampRate: 450, leadInRate: 800, leadOutRate: 1000, fastTraverseRate: 5000, finishRate: 1000 },
    stepdown: 5, helixAngleDeg: 3, floorHopMm,
  } as EmitContext)
  const level = { startZ: 0, z: -2, floorReplay: false }
  const run = (link: AdaptivePass, hop: number | undefined): ToolpathMove[] => {
    const moves: ToolpathMove[] = []
    emitConnectionPass(moves, [link], 0, level, ctx(hop))
    return moves
  }
  const runPasses = (passes: AdaptivePass[], hop: number | undefined): ToolpathMove[] => {
    const moves: ToolpathMove[] = [{ type: 'feed', x: 0, y: 0, z: -2, feed: 1000, role: 'cut' }]
    for (let i = 0; i < passes.length; i++) emitConnectionPass(moves, passes, i, level, ctx(hop))
    return moves.slice(1)
  }
  const a = { x: 0, y: 0 }, b = { x: 10, y: 0 }
  const r9 = (moves: ToolpathMove[]) => moves.map(m => ({ ...m, x: +m.x.toFixed(9), y: +m.y.toFixed(9), z: +m.z.toFixed(9) }))

  it('keep-down: rise while moving, hold at the hop height, descend while moving, all G0', () => {
    expect(r9(run({ type: 'link', points: [a, b], jumpType: 1 }, 0.3))).toEqual([
      { type: 'rapid', x: 0.3, y: 0, z: -1.7, role: 'rapid' },
      { type: 'rapid', x: 9.7, y: 0, z: -1.7, role: 'rapid' },
      { type: 'rapid', x: 10, y: 0, z: -2, role: 'rapid' },
    ])
  })

  it('a travel shorter than a rise and a descent is one peak at its midpoint', () => {
    const moves = run({ type: 'link', points: [a, { x: 0.4, y: 0 }], jumpType: 1 }, 0.3)
    expect(moves).toHaveLength(2)
    expect(moves[0].x).toBeCloseTo(0.2, 9)
    expect(moves[0].z).toBeCloseTo(-1.8, 9)
    expect(moves[1]).toMatchObject({ type: 'rapid', x: 0.4, z: -2 })
  })

  // attachMicroLift marks a corridor proven EMPTY at full tool width (non-enumerable).
  const emptyLift = (): { z: number; empty?: true } => {
    const lift = { z: 2 }
    Object.defineProperty(lift, 'empty', { value: true, enumerable: false })
    return lift
  }

  it('micro-lift onto a gated landing holds the hop to the landing and plunges fed', () => {
    const moves = run({ type: 'link', points: [a, b], jumpType: 2, microLift: emptyLift() }, 0.3)
    expect(r9(moves)).toEqual([
      { type: 'rapid', x: 0.3, y: 0, z: -1.7, role: 'rapid' },
      { type: 'rapid', x: 10, y: 0, z: -1.7, role: 'rapid' },
      { type: 'feed', x: 10, y: 0, z: -2, feed: 300, role: 'plunge' },
    ])
  })

  it('micro-lift onto a clear-air landing descends into air and the lead that follows is fed at leadInRate', () => {
    const link: AdaptivePass = { type: 'link', points: [a, b], jumpType: 2, microLift: emptyLift(), clearAirLanding: true }
    const lead: AdaptivePass = { type: 'lead', points: [b, { x: 11, y: 0 }] }
    const moves: ToolpathMove[] = []
    emitConnectionPass(moves, [link, lead], 0, level, ctx(0.3))
    emitConnectionPass(moves, [link, lead], 1, level, ctx(0.3))
    expect(moves.slice(-3)).toEqual([
      { type: 'rapid', x: 10, y: 0, z: -2, role: 'rapid' },
      { type: 'feed', x: 10, y: 0, z: -2, feed: 800, role: 'lead_in' },
      { type: 'feed', x: 11, y: 0, z: -2, feed: 800, role: 'lead_in' },
    ])
  })

  it('a micro-lift proven only to the sliver cap keeps its 2 mm hover, whatever the setting', () => {
    expect(run({ type: 'link', points: [a, b], jumpType: 2, microLift: { z: 2 } }, 0.3)).toEqual([
      { type: 'rapid', x: 0, y: 0, z: 0, role: 'rapid' },
      { type: 'rapid', x: 10, y: 0, z: 0, role: 'rapid' },
      { type: 'feed', x: 10, y: 0, z: -2, feed: 300, role: 'plunge' },
    ])
  })

  it('a routed keep-down hops along its own route and lands at its end', () => {
    const moves = r9(runPasses([{ type: 'loopback', points: [a, { x: 5, y: 0 }, { x: 5, y: 5 }] }], 0.3))
    expect(moves).toEqual([
      { type: 'rapid', x: 0.3, y: 0, z: -1.7, role: 'rapid' },
      { type: 'rapid', x: 5, y: 0, z: -1.7, role: 'rapid' },
      { type: 'rapid', x: 5, y: 4.7, z: -1.7, role: 'rapid' },
      { type: 'rapid', x: 5, y: 5, z: -2, role: 'rapid' },
    ])
  })

  it('no hop setting keeps the legacy shapes exactly', () => {
    expect(run({ type: 'link', points: [a, b], jumpType: 1 }, undefined)).toEqual([
      { type: 'feed', x: 10, y: 0, z: -2, role: 'fast_traverse' },
    ])
    expect(run({ type: 'link', points: [a, b], jumpType: 2, microLift: { z: 2 } }, 0)).toEqual([
      { type: 'rapid', x: 0, y: 0, z: 0, role: 'rapid' },
      { type: 'rapid', x: 10, y: 0, z: 0, role: 'rapid' },
      { type: 'feed', x: 10, y: 0, z: -2, feed: 300, role: 'plunge' },
    ])
  })
})

// Round 2 (architect 10-17, fix round 2 item 1): no floor hop, straight or routed, rises above
// the clearance height. Adaptive Clearing 1 cut 0.1 mm deep with the clearance 0.1 mm above the
// stock top: the floor is 0.2 mm under clearance, less than the 0.3 mm default hop.
describe('WO-2835 2D adaptive: no floor hop rises above the clearance height', () => {
  const lowClearance = (op: FileOperation) => {
    const own = { kind: 'user_override' }
    op.smartHeight.intent.safety.clearance = { reference: 'stock_top', offsetMm: 0.1, owner: own }
    op.smartHeight.intent.safety.retract = { reference: 'stock_top', offsetMm: 0.05, owner: own }
    op.smartHeight.intent.safety.feed = { reference: 'top', offsetMm: 0.05, owner: own }
    op.smartHeight.intent.machining.end.value.plane.offsetMm = -0.1
  }
  let low: Awaited<ReturnType<typeof generate>>
  let lowLegacy: Awaited<ReturnType<typeof generate>>
  beforeAll(async () => {
    low = await generate(undefined, OP, lowClearance)
    lowLegacy = await generate(0, OP, lowClearance)
  }, 600_000)

  it('caps every hop, straight and routed, at the clearance height', () => {
    expect(low.clearanceZ).toBeCloseTo(0.1, 6)
    const floor = Math.min(...low.moves.filter(m => m.type === 'feed').map(m => m.z))
    expect(floor).toBeCloseTo(-0.1, 6)
    // The routed keep-downs (WO-2787 loopbacks) exist in this program: legacy drags them at depth.
    expect(lowLegacy.moves.filter(m => m.role === 'fast_traverse').length).toBeGreaterThan(0)
    // Unproved frontiers retain fed travel; every emitted hop remains capped.
    expect(low.moves.some(m => m.role === 'fast_traverse')).toBe(true)
    const lowRapids = low.moves.filter(m => m.type === 'rapid' && m.z > floor + EPS)
    expect(lowRapids.length).toBeGreaterThan(0)
    expect(Math.max(...low.moves.map(m => m.z))).toBeLessThanOrEqual(low.clearanceZ + EPS)
  })
})

// Round 2 item 3: the two rules on 3D adaptive and a 3D finish, through the store. An
// independent oracle: a height field of the stock block, lowered by every fed move of the setup
// in order (flat cutters sweep a flat disc, ball cutters a ball). It is not a holder or
// workholding check, and its 0.5 mm grid reads cutter corners a little coarsely.
type Profile = (d: number) => number
const profileFor = (tool: { type?: string; diameter: number }): Profile => {
  const r = tool.diameter / 2
  return /ball/.test(tool.type ?? '') ? (d: number) => r - Math.sqrt(Math.max(0, r * r - d * d)) : () => 0
}

class StockField {
  private readonly h: Float64Array
  private readonly nx: number
  private readonly ny: number
  private readonly box: { min: { x: number; y: number }; max: { x: number; y: number } }
  readonly top: number
  private readonly cell = 0.5
  constructor(box: { min: { x: number; y: number }; max: { x: number; y: number } }, top: number) {
    this.box = box
    this.top = top
    this.nx = Math.ceil((box.max.x - box.min.x) / this.cell) + 1
    this.ny = Math.ceil((box.max.y - box.min.y) / this.cell) + 1
    this.h = new Float64Array(this.nx * this.ny).fill(top)
  }
  private each(x: number, y: number, r: number, f: (k: number, d: number) => void): void {
    const c = this.cell, b = this.box.min
    const i0 = Math.max(0, Math.ceil((x - r - b.x) / c)), i1 = Math.min(this.nx - 1, Math.floor((x + r - b.x) / c))
    const j0 = Math.max(0, Math.ceil((y - r - b.y) / c)), j1 = Math.min(this.ny - 1, Math.floor((y + r - b.y) / c))
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const d = Math.hypot(b.x + i * c - x, b.y + j * c - y)
        if (d <= r) f(i * this.ny + j, d)
      }
    }
  }
  /** Remove what the cutter sweeps along one fed segment. */
  cut(a: ToolpathMove, m: ToolpathMove, r: number, p: Profile): void {
    const n = Math.max(1, Math.ceil(Math.hypot(m.x - a.x, m.y - a.y) / (this.cell / 2)))
    for (let s = 0; s <= n; s++) {
      const t = s / n, x = a.x + (m.x - a.x) * t, y = a.y + (m.y - a.y) * t, z = a.z + (m.z - a.z) * t
      this.each(x, y, r, (k, d) => { if (z + p(d) < this.h[k]) this.h[k] = z + p(d) })
    }
  }
  /** The least gap between the cutter's underside and the stock along a rapid (its start
   *  excluded: that is where the previous move left the tool). Infinity above the stock top. */
  gap(a: ToolpathMove, m: ToolpathMove, r: number, p: Profile): number {
    let g = Infinity
    const n = Math.max(1, Math.ceil(Math.hypot(m.x - a.x, m.y - a.y, m.z - a.z) / (this.cell / 2)))
    for (let s = 1; s <= n; s++) {
      const t = s / n, x = a.x + (m.x - a.x) * t, y = a.y + (m.y - a.y) * t, z = a.z + (m.z - a.z) * t
      if (z >= this.top) continue
      this.each(x, y, r, (k, d) => { g = Math.min(g, z + p(d) - this.h[k]) })
    }
    return g
  }
}

interface RapidAudit {
  /** Rapid segments below the stock top. */
  below: number
  /** The least gap along any rapid: negative is a rapid through material. */
  minGap: number
  /** The least gap at the end of a rapid that hands over to a fed move. */
  minEndGap: number
  /** Level rapids that move in XY below the stock top, and the least gap among them. */
  level: number
  minLevelGap: number
  /** Roles of the fed moves that follow a rapid. */
  entries: Set<string>
}

/** Every operation of one Full Suite setup through the store, in order, with every rapid of
 *  each judged against the stock the fed moves before it left. */
async function generateSetup(setupIndex: number, floorHopMm: number | undefined, edit?: (op: FileOperation) => void): Promise<Map<string, { moves: ToolpathMove[]; audit: RapidAudit }>> {
  const file = JSON.parse(readFileSync(join(process.cwd(), 'Example Projects/Full Suite.camproject'), 'utf8'))
  const proj = file.project ?? file
  for (const op of proj.setups[setupIndex].operations as FileOperation[]) {
    if (floorHopMm !== undefined && op.linking) op.linking.floorHopMm = floorHopMm
    edit?.(op)
  }
  await useCamStore.getState().loadProjectFromFile(JSON.stringify(file))
  viewportSetup = setupIndex
  const setup = useCamStore.getState().project.setups[setupIndex]
  for (const op of setup.operations) await useCamStore.getState().computeOperationToolpath(setup.id, op.id)
  const project = useCamStore.getState().project
  const done = project.setups[setupIndex]
  const originZ = done.wcs.origin.z
  const box = smartHeightStockBounds(project, setupProvenStockId(done, project)!)!
  const field = new StockField(box, box.max.z - originZ)
  const out = new Map<string, { moves: ToolpathMove[]; audit: RapidAudit }>()
  for (const op of done.operations) {
    expect(op.errorMessage ?? '', op.name).toBe('')
    const moves = (op.toolpathMoves ?? []).map(m => ({ ...m, z: m.z - originZ }))
    const tool = project.toolLibrary.find(t => t.id === op.toolId)!
    const r = tool.diameter / 2, p = profileFor(tool)
    const audit: RapidAudit = { below: 0, minGap: Infinity, minEndGap: Infinity, level: 0, minLevelGap: Infinity, entries: new Set() }
    for (let i = 1; i < moves.length; i++) {
      const a = moves[i - 1], m = moves[i]
      if (m.type !== 'rapid') {
        if (a.type === 'rapid') audit.entries.add(m.role ?? m.type)
        field.cut(a, m, r, p)
        continue
      }
      const g = field.gap(a, m, r, p)
      if (g === Infinity) continue
      audit.below++
      audit.minGap = Math.min(audit.minGap, g)
      if (moves[i + 1] && moves[i + 1].type !== 'rapid') audit.minEndGap = Math.min(audit.minEndGap, field.gap(m, m, r, p))
      if (Math.abs(m.z - a.z) <= 1e-9 && Math.hypot(m.x - a.x, m.y - a.y) > 1e-6) {
        audit.level++
        audit.minLevelGap = Math.min(audit.minLevelGap, g)
      }
    }
    out.set(op.name, { moves, audit })
  }
  return out
}

/** Grid tolerance of the oracle: a 0.5 mm field reads a curved floor up to this far off. */
const GRID_TOL = 0.02
/** A level rapid over the stock must clear it by at least this: it hops, it does not ride. */
const MIN_LEVEL_GAP = 0.1

describe('WO-2835 3D: the same two rules through the store (Full Suite Setup 5)', () => {
  let setup5: Awaited<ReturnType<typeof generateSetup>>
  let setup5Off: Awaited<ReturnType<typeof generateSetup>>
  let seamCounts: { candidates: number; rapided: number }[] = []
  beforeAll(async () => {
    const before = positiveControl.counts.length
    setup5 = await generateSetup(3, undefined)
    seamCounts = positiveControl.counts.slice(before)
    setup5Off = await generateSetup(3, 0)
  }, 1_200_000)

  for (const name of ['3D Rough 1', '3D Finish 3']) {
    it(`${name}: no rapid goes through material, and every rapid hands over to a fed move in air`, () => {
      const { audit } = setup5.get(name)!
      expect(audit.below).toBeGreaterThan(0)
      expect(audit.minGap).toBeGreaterThanOrEqual(-GRID_TOL)
      expect(audit.minEndGap).toBeGreaterThanOrEqual(-GRID_TOL)
      // What follows a rapid is fed: a lead-in, ramp, plunge or helix, or a finish pass
      // that starts in the air the rapid ended in.
      for (const role of audit.entries) expect(['lead_in', 'ramp', 'plunge', 'helix', 'cut', 'stepover']).toContain(role)
    })

    it(`${name}: no level rapid rides the stock or a cleared floor`, () => {
      const { audit, moves } = setup5.get(name)!
      expect(moves.some(m => m.role === 'fast_traverse')).toBe(false)
      // Independent astra ruling, 2026-10-18: the original finish currently
      // retains its level candidates at feed. Keep every safety assertion here;
      // require finish conversion on the separately certified positive below.
      if (name === '3D Rough 1') expect(audit.level).toBeGreaterThan(0)
      else {
        console.info('WO-2835 link counts', { fixture: 'Full Suite Setup 5 / 3D Finish 3',
          airFeedCandidates: seamCounts.reduce((n, c) => n + c.candidates, 0),
          convertedToRapid: seamCounts.reduce((n, c) => n + c.rapided, 0),
          keptFed: seamCounts.reduce((n, c) => n + c.candidates - c.rapided, 0) })
      }
      expect(audit.minLevelGap).toBeGreaterThanOrEqual(MIN_LEVEL_GAP)
    })
  }

  it('3D Rough 1 keeps the tool down only on fed stepover moves, and the hop setting does not touch it', () => {
    const rough = setup5.get('3D Rough 1')!.moves
    expect(rough.some(m => m.role === 'stepover' && m.type === 'feed')).toBe(true)
    expect(rough).toEqual(setup5Off.get('3D Rough 1')!.moves)
  })
})

// Independent continuous sufficient condition, separate from the production
// stock grid/qualification code. A straight level flat-cutter sweep is a convex
// capsule. If both candidate centres lie inside its radius inset by the whole
// current cutter/shank radius plus 0.1 mm, the entire connecting capsule fits.
// Prior flute reach must also clear the original stock top. No sampled columns,
// production acceptance result, or current-operation removal grants this proof.
function clearHistoryCertificates(input: AirFeedOverRemovedStockInput) {
  const certificates: { from: ToolpathMove; to: ToolpathMove; floorZ: number; radialGap: number }[] = []
  const radius = Math.max(input.tool.diameter, input.tool.shankDiameter ?? input.tool.diameter) / 2
  const distance = (p: ToolpathMove, a: ToolpathMove, b: ToolpathMove) => {
    const dx = b.x - a.x, dy = b.y - a.y, length2 = dx * dx + dy * dy
    const t = length2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length2)) : 0
    return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy)
  }
  for (let i = 1; i < input.moves.length; i++) {
    const from = input.moves[i - 1], to = input.moves[i]
    if (to.type !== 'feed' || to.role !== 'cut' || Math.abs(to.z - from.z) > 1e-9
      || to.z >= input.remaining.bounds.maxZ || Math.hypot(to.x - from.x, to.y - from.y) <= EPS) continue
    for (const prior of input.preceding ?? []) {
      if (!prior.enabled || prior.status !== 'ready' || prior.tool?.type !== 'flat_end_mill') continue
      const moves = prior.toolpathMoves ?? []
      for (let j = 1; j < moves.length; j++) {
        const a = moves[j - 1], b = moves[j]
        if (b.type !== 'feed' || b.role !== 'cut' || Math.abs(a.z - b.z) > 1e-9) continue
        const radialGap = prior.tool.diameter / 2 - radius - Math.max(distance(from, a, b), distance(to, a, b))
        if (radialGap > 0.1 && Math.min(from.z, to.z) > a.z + 0.1
          && a.z + prior.tool.fluteLength > input.remaining.bounds.maxZ + 0.1) {
          certificates.push({ from, to, floorZ: a.z, radialGap })
          break
        }
      }
    }
  }
  return certificates
}

describe('WO-2835 clear-history production positive', () => {
  it('converts independently clear level finish travel to rapid', async () => {
    // Real Full Suite geometry and earlier rough; only the finish allowance
    // and density differ. The 2 mm allowance leaves a genuinely empty corridor
    // above that rough's floor. Never seed a hand-built toolpath in the store.
    positiveControl.active = true
    const count = positiveControl.calls.length
    let generated: Awaited<ReturnType<typeof generateSetup>>
    try {
      generated = await generateSetup(3, undefined, op => {
        if (op.name === '3D Finish 3') op.params = { ...op.params, stepover: 4, stepdown: 4,
          scallopHeight: 0.2, surfaceStockToLeave: 2, stockToLeave: 2 }
      })
    } finally { positiveControl.active = false }
    const calls = positiveControl.calls.slice(count)
    expect(calls).toHaveLength(1)
    const { input, result } = calls[0]
    const { moves, audit } = generated!.get('3D Finish 3')!
    // Verify the observed seam result reaches the actual stored application
    // output. This fixture has a translation and no rotation; do not infer
    // success from a helper result the store might have discarded.
    const project = useCamStore.getState().project
    const setup = project.setups[3]
    const op = setup.operations.find(o => o.name === '3D Finish 3')!
    const part = project.geometry.find(g => g.id === op.geometrySelections[0])!
    expect(part.rotation).toEqual({ x: 0, y: 0, z: 0 })
    expect(moves).toHaveLength(result.moves.length)
    for (const [i, m] of result.moves.entries()) {
      expect(moves[i].type).toBe(m.type)
      expect(moves[i].x).toBeCloseTo(m.x + part.position.x, 8)
      expect(moves[i].y).toBeCloseTo(m.y + part.position.y, 8)
      expect(moves[i].z).toBeCloseTo(m.z + part.position.z - setup.wcs.origin.z, 8)
    }
    // Establish independent clearance before asking if any conversion occurred.
    const certificates = clearHistoryCertificates(input)
    expect(certificates.length, 'Actual earlier flat sweeps contain complete cutter/shank corridors').toBeGreaterThan(0)
    const sameXY = (a: ToolpathMove, b: ToolpathMove) => Math.hypot(a.x - b.x, a.y - b.y) < 1e-8
    const certifiedRapids = certificates.filter(c => result.moves.some((m, i, moves) => i > 0
      && m.type === 'rapid' && sameXY(moves[i - 1], c.from) && sameXY(m, c.to)
      && Math.abs(m.z - moves[i - 1].z) < 1e-9
      && Math.min(m.z, moves[i - 1].z) >= Math.max(c.from.z, c.to.z) - 1e-8
      && m.z < input.remaining.bounds.maxZ))
    expect(certifiedRapids.length, 'Independently certified clear-history travel must actually become rapid').toBeGreaterThan(0)
    expect(moves.length).toBeGreaterThan(0)
    expect(audit.level).toBeGreaterThan(0)
    expect(audit.minGap).toBeGreaterThanOrEqual(-GRID_TOL)
    expect(audit.minEndGap).toBeGreaterThanOrEqual(-GRID_TOL)
    expect(audit.minLevelGap).toBeGreaterThanOrEqual(MIN_LEVEL_GAP)
    // The default hop raises a certified level hold by 0.3 mm. The 3D store
    // does not forward linking.floorHopMm yet; this tests no setting override.
    expect(certifiedRapids.some(c => result.moves.some(m => sameXY(m, c.to)
      && m.type === 'rapid' && Math.abs(m.z - c.to.z - 0.3) < 1e-8))).toBe(true)
    console.info('WO-2835 positive clearance', {
      independentCorridors: certificates.length, certifiedRapids: certifiedRapids.length,
      airFeedCandidates: result.candidates, convertedToRapid: result.rapided, keptFed: result.candidates - result.rapided,
      minLevelGap: audit.minLevelGap })
  }, 300_000)
})

// Round 2 item 3, contour: its rest-air rule (restAir2d) runs a feed-rate LINK that is air at
// rapid, and that rapid is what hops. A contour emits no link-class move (no stepover, no
// loop-back), so the hop has nothing to act on: a contour inside Pocket 2's loops, placed after
// Adaptive Clearing 1 and Pocket 2 (with three finish passes, the most links a contour plans),
// comes out the same with the hop on and off, and no rapid of it travels sideways below the
// stock top. This proves the hop cannot fire on a contour; it does not show rest-air ran.
describe('WO-2835 contour: rest-air has no link to hop', () => {
  const contourAfterPocket = (hop: number | undefined) => async () => {
    const file = JSON.parse(readFileSync(join(process.cwd(), 'Example Projects/Full Suite.camproject'), 'utf8'))
    const proj = file.project ?? file
    const ops = proj.setups[0].operations as FileOperation[]
    const pocketOp = ops.find(o => o.name === 'Pocket 2')!
    const c = structuredClone(pocketOp)
    for (const k of ['toolpathMoves', 'resolvedHeights', 'resolvedHeightPlan', 'generationFingerprint', 'estimatedCutTimeMs', 'computeTimeMs']) delete c[k]
    Object.assign(c, { id: 'wo2835-contour', name: 'Contour WO-2835', type: 'contour_2d', status: 'pending' })
    c.params = {
      side: 'inner', direction: 'climb', geometryId: pocketOp.params.geometryId, loopIds: pocketOp.params.loopIds,
      tabs: false, tabWidth: 8, tabHeight: 2, tabCount: 4, heightReference: 'stock_bottom', planeOffset: -0.25,
    }
    c.passes = { ...pocketOp.passes, stockToLeave: 0, finishPasses: 3 }
    c.smartHeight.intent.policy = { operationType: 'contour_2d', variant: 'explicit_depth' }
    if (hop !== undefined) c.linking.floorHopMm = hop
    ops.splice(ops.indexOf(pocketOp) + 1, 0, c)
    await useCamStore.getState().loadProjectFromFile(JSON.stringify(file))
    viewportSetup = 0
    const setup = useCamStore.getState().project.setups[0]
    for (const op of setup.operations) {
      await useCamStore.getState().computeOperationToolpath(setup.id, op.id)
      if (op.id === 'wo2835-contour') break
    }
    const done = useCamStore.getState().project.setups[0]
    const op = done.operations.find(o => o.id === 'wo2835-contour')!
    expect(op.errorMessage ?? '').toBe('')
    return (op.toolpathMoves ?? []).map(m => ({ ...m, z: m.z - done.wcs.origin.z }))
  }
  let on: ToolpathMove[]
  let off: ToolpathMove[]
  beforeAll(async () => {
    on = await contourAfterPocket(undefined)()
    off = await contourAfterPocket(0)()
  }, 600_000)

  it('plans no link-class move, so the hop setting leaves it byte-identical', () => {
    expect(on.length).toBeGreaterThan(0)
    expect(on.some(m => m.type === 'feed' && effectiveMoveMotion(m) === 'link')).toBe(false)
    expect(on).toEqual(off)
    const top = Math.max(...on.filter(m => m.type === 'feed').map(m => m.z))
    expect(on.filter((m, i) => i > 0 && m.type === 'rapid' && m.z < top - EPS && on[i - 1].z < top - EPS
      && Math.hypot(m.x - on[i - 1].x, m.y - on[i - 1].y) > 1e-6)).toEqual([])
  })
})
