// WO-2051: Adaptive floor finishing with floor stock cleans the true floor.
//
// With floor finishing ON and floor stock left, an Adaptive op roughs down to the
// floor plus that stock and then cleans the true floor once. Smart Height V2 used
// to raise the worker bottom by the floor stock and hand the engine floor stock 0,
// so the engine's floor pass never reached the true floor through the app.
//
// Runs Full Suite Setup 1 / Adaptive Clearing 1 through the production compute (the
// store's computeOperationToolpath, the same worker path the app uses). With
// WO2051_EVIDENCE=<label> set it also writes side-view SVGs and the numbers into
// src/tests/evidence/WO-2051/ (render.mjs there turns them into PNGs).
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { typedMock } from '../support/typedMock'
import type { ToolpathMove } from '../../types'
import { defaultHeightIntent } from '../../lib/cam/heightIntent'
import {
  buildPlanarRoughSmartHeightEvidenceContext,
  buildPlanarRoughSmartHeightIntent,
  resolvePlanarRoughSmartHeights,
  type PlanarRoughOperationType,
} from '../../lib/cam/smartHeights'

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

await ensureClipperReady()

const EVIDENCE = process.env.WO2051_EVIDENCE
const EVIDENCE_DIR = join(process.cwd(), 'src/tests/evidence/WO-2051')
const OP = 'Adaptive Clearing 1'

interface Variant { floorFinish: boolean; floorStock: number }
interface Generated { moves: ToolpathMove[]; cutTimeSec: number | null; bottomWcs: number | undefined }

/** Adaptive Clearing 1 of Full Suite Setup 1, generated through the store with the
 *  floor settings overridden in the loaded file (everything else is his). */
async function generate(v: Variant): Promise<Generated> {
  const file = JSON.parse(readFileSync(join(process.cwd(), 'Example Projects/Full Suite.camproject'), 'utf8'))
  const proj = file.project ?? file
  const fileOp = proj.setups[0].operations.find((o: { name: string }) => o.name === OP)
  fileOp.params.floorFinish = v.floorFinish
  fileOp.passes.floorStockToLeave = v.floorStock
  await useCamStore.getState().loadProjectFromFile(JSON.stringify(file))
  let project = useCamStore.getState().project
  const setup = project.setups[0]
  const adapt = setup.operations.find(o => o.name === OP)!
  await useCamStore.getState().computeOperationToolpath(setup.id, adapt.id)
  project = useCamStore.getState().project
  const op = project.setups[0].operations.find(o => o.id === adapt.id)! as unknown as {
    errorMessage?: string; toolpathMoves?: ToolpathMove[]; estimatedCutTimeMs?: number
    resolvedHeights?: { wcs?: { bottom?: number } }
  }
  expect(op.errorMessage ?? '').toBe('')
  const originZ = project.setups[0].wcs.origin.z
  return {
    moves: (op.toolpathMoves ?? []).map(m => ({ ...m, z: m.z - originZ })),
    cutTimeSec: op.estimatedCutTimeMs !== undefined ? +(op.estimatedCutTimeMs / 1000).toFixed(1) : null,
    bottomWcs: op.resolvedHeights?.wcs?.bottom,
  }
}

const r3 = (z: number): number => Math.round(z * 1000) / 1000
const CUTTING = new Set(['cut', 'wall_follow', 'finish'])
const cutting = (moves: readonly ToolpathMove[]): ToolpathMove[] => moves.filter(m => CUTTING.has(m.role ?? ''))
const xy = (m: ToolpathMove): string => `${m.x.toFixed(4)},${m.y.toFixed(4)}`
const deepest = (moves: readonly ToolpathMove[]): number => Math.min(...cutting(moves).map(m => r3(m.z)))
function isSubsequence(needle: readonly string[], hay: readonly string[]): boolean {
  let i = 0
  for (const item of hay) if (i < needle.length && item === needle[i]) i++
  return i === needle.length
}

/** Cutting moves per Z level. */
function perLevel(moves: readonly ToolpathMove[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const m of cutting(moves)) out[r3(m.z)] = (out[r3(m.z)] ?? 0) + 1
  return out
}

function summary(label: string, gen: Generated): Record<string, unknown> {
  return {
    label, moves: gen.moves.length, cuttingMoves: cutting(gen.moves).length, cutTimeSec: gen.cutTimeSec,
    deepestCutZ: deepest(gen.moves), perLevel: perLevel(gen.moves),
  }
}

/** Side view (X across, Z up) of the cutting moves, one colour per role. */
function sideViewSvg(title: string, gen: Generated): string {
  const W = 1200, H = 520, pad = 60
  const cuts = cutting(gen.moves)
  const xs = cuts.map(m => m.x), zs = cuts.map(m => m.z)
  const x0 = Math.min(...xs), x1 = Math.max(...xs)
  const z0 = Math.min(-5.5, Math.min(...zs) - 0.5), z1 = Math.max(0.5, Math.max(...zs) + 0.5)
  const sx = (x: number): number => pad + (x - x0) / (x1 - x0 || 1) * (W - 2 * pad)
  const sz = (z: number): number => pad + (z1 - z) / (z1 - z0 || 1) * (H - 2 * pad)
  const colour: Record<string, string> = { cut: '#1f77b4', wall_follow: '#2ca02c', finish: '#d62728' }
  const rows = Object.entries(perLevel(gen.moves)).sort((a, b) => Number(b[0]) - Number(a[0]))
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="sans-serif">`,
    `<rect width="${W}" height="${H}" fill="#fff"/>`,
    `<text x="${pad}" y="28" font-size="18">${title}</text>`,
    `<text x="${pad}" y="48" font-size="13">moves ${gen.moves.length}, cut time ${gen.cutTimeSec ?? '?'} s, deepest cut Z ${deepest(gen.moves)}. Blue = adaptive cut, green = wall follow, red = finish (floor clean / wall finish). Side view: X across, Z up.</text>`,
  ]
  // The true floor of the op (-5), drawn whether or not the path reaches it.
  const yFloor = sz(-5)
  parts.push(`<line x1="${pad}" y1="${yFloor}" x2="${W - pad}" y2="${yFloor}" stroke="#000" stroke-width="1.5"/>`)
  parts.push(`<text x="${pad}" y="${yFloor + 18}" font-size="12">true floor Z -5</text>`)
  for (const [z, n] of rows) {
    const y = sz(Number(z))
    parts.push(`<line x1="${pad}" y1="${y}" x2="${W - pad}" y2="${y}" stroke="#ccc" stroke-dasharray="4 4"/>`)
    parts.push(`<text x="4" y="${y + 4}" font-size="12">Z ${z}</text>`)
    parts.push(`<text x="${W - pad + 4}" y="${y + 4}" font-size="11">${n}</text>`)
  }
  const nudge: Record<string, number> = { cut: -4, wall_follow: 0, finish: 4 }
  for (const role of ['cut', 'wall_follow', 'finish']) {
    const pts = cuts.filter(m => m.role === role)
    if (pts.length === 0) continue
    const d = pts.map(m => `M${sx(m.x).toFixed(1)} ${(sz(m.z) + nudge[role]).toFixed(1)}h0.01`).join('')
    parts.push(`<path d="${d}" stroke="${colour[role]}" stroke-width="2.5" stroke-linecap="round" fill="none"/>`)
  }
  parts.push('</svg>')
  return parts.join('\n')
}

describe('WO-2051: Full Suite Setup 1 Adaptive Clearing 1 floor finishing with floor stock, production compute', () => {
  let finishWithStock: Generated
  let offWithStock: Generated
  let finishNoStock: Generated
  let offNoStock: Generated
  const FLOOR = -5
  const ROUGH = -4.7

  beforeAll(async () => {
    finishWithStock = await generate({ floorFinish: true, floorStock: 0.3 })
    offWithStock = await generate({ floorFinish: false, floorStock: 0.3 })
    finishNoStock = await generate({ floorFinish: true, floorStock: 0 })
    offNoStock = await generate({ floorFinish: false, floorStock: 0 })
    const report = [
      summary('floorFinish ON, floor stock 0.3', finishWithStock),
      summary('floorFinish OFF, floor stock 0.3', offWithStock),
      summary('floorFinish ON, floor stock 0 (his file)', finishNoStock),
      summary('floorFinish OFF, floor stock 0', offNoStock),
    ]
    console.info('[WO-2051]', JSON.stringify(report))
    if (EVIDENCE) {
      writeFileSync(join(EVIDENCE_DIR, `${EVIDENCE}-numbers.json`), JSON.stringify(report, null, 2) + '\n')
      writeFileSync(join(EVIDENCE_DIR, `${EVIDENCE}-finish-on-stock-0.3-side.svg`),
        sideViewSvg(`WO-2051 ${EVIDENCE}: Adaptive Clearing 1, floor finishing ON, floor stock 0.3`, finishWithStock))
      writeFileSync(join(EVIDENCE_DIR, `${EVIDENCE}-finish-off-stock-0.3-side.svg`),
        sideViewSvg(`WO-2051 ${EVIDENCE}: Adaptive Clearing 1, floor finishing OFF, floor stock 0.3`, offWithStock))
    }
  }, 900_000)

  it('floor finishing ON with floor stock 0.3 roughs to -4.7, then cleans the true floor once at -5', () => {
    expect(deepest(finishWithStock.moves)).toBe(FLOOR)
    // Roughing stops at floor + stock; nothing roughs at the floor itself.
    expect(finishWithStock.moves.filter(m => m.role === 'cut' && r3(m.z) === ROUGH).length).toBeGreaterThan(0)
    expect(finishWithStock.moves.filter(m => m.role === 'cut' && r3(m.z) === FLOOR)).toHaveLength(0)
    // The floor clean is the -4.7 rough stream's own XY, cut once at -5, with the
    // final wall-finish contour (which belongs to the true floor) woven in.
    const rough = finishWithStock.moves
      .filter(m => (m.role === 'cut' || m.role === 'wall_follow') && r3(m.z) === ROUGH).map(xy)
    const floor = finishWithStock.moves.filter(m => m.role === 'finish' && r3(m.z) === FLOOR).map(xy)
    const wallFinishOff = offWithStock.moves.filter(m => m.role === 'finish' && r3(m.z) === ROUGH).length
    expect(rough.length).toBeGreaterThan(0)
    expect(isSubsequence(rough, floor)).toBe(true)
    expect(floor.length).toBe(rough.length + wallFinishOff)
    // No air replay at the rough bottom (WO-2038).
    expect(finishWithStock.moves.filter(m => m.role === 'finish' && r3(m.z) === ROUGH)).toHaveLength(0)
    // The op's recorded bottom is the floor it cuts to.
    expect(finishWithStock.bottomWcs).toBeCloseTo(FLOOR, 6)
  })

  it('floor finishing OFF with floor stock 0.3 still stops at -4.7 and leaves the stock', () => {
    expect(deepest(offWithStock.moves)).toBe(ROUGH)
    expect(offWithStock.moves.filter(m => r3(m.z) < ROUGH - 1e-3 && CUTTING.has(m.role ?? ''))).toHaveLength(0)
    expect(offWithStock.bottomWcs).toBeCloseTo(ROUGH, 6)
    // Floor finishing ON roughs exactly as OFF does; it adds the floor clean below.
    const roughing = (moves: readonly ToolpathMove[]): string[] => moves
      .filter(m => m.role === 'cut' || m.role === 'wall_follow').filter(m => r3(m.z) >= ROUGH)
      .map(m => `${xy(m)},${r3(m.z)}`)
    expect(roughing(finishWithStock.moves)).toEqual(roughing(offWithStock.moves))
  })

  it('floor finishing ON with floor stock 0 is the single pass at -5 (WO-2038 unchanged)', () => {
    expect(deepest(finishNoStock.moves)).toBe(FLOOR)
    expect(finishNoStock.moves).toEqual(offNoStock.moves)
  })
})

// The resolver contract itself: floor finishing hands the worker the physical
// floor and the allowance; everything else keeps the raised bottom and zero.
describe('WO-2051: planar rough Smart Height worker handoff with floor finishing', () => {
  function resolve(operationType: PlanarRoughOperationType, floorStock: number, floorFinish: boolean) {
    const operationId = `${operationType}-1`
    const intent = buildPlanarRoughSmartHeightIntent({
      setupId: 'setup-1', operationType, safetyIntent: defaultHeightIntent(operationType),
      mode: 'explicit_depth', geometryIds: ['part-1'], explicitTargetWcsMm: -5,
    })
    const evidence = buildPlanarRoughSmartHeightEvidenceContext({
      revision: { projectRevision: 'p1', setupRevision: 's1', operationRevision: 'o1' },
      wcsOriginMachineMm: 0, operationId, operationType, geometryIds: ['part-1'],
      owningStocks: [{
        stockId: 'stock-1', artifactId: 'stock-artifact-1',
        boundsMachineMm: { minX: 0, minY: 0, minZ: -20, maxX: 100, maxY: 80, maxZ: 0 },
        fingerprint: 'stock-fp-1', representation: 'axis-aligned-stock-box',
      }],
      floorStockToLeaveMm: floorStock,
    })
    return resolvePlanarRoughSmartHeights({
      intent, evidence, geometryIds: ['part-1'], stockId: 'stock-1', floorFinish,
    })
  }

  it('Adaptive, floor finishing ON, floor stock 0.3: worker bottom -5 with 0.3 floor stock', () => {
    const r = resolve('adaptive_clearing_2d', 0.3, true)
    expect(r.workerHeights.bottomHeight).toBeCloseTo(-5, 9)
    expect(r.workerFloorStockToLeaveMm).toBeCloseTo(0.3, 9)
    expect(r.snapshotIntent.bottom.offset).toBeCloseTo(-5, 9)
    // The plan still names the physical floor and the raised cutter end.
    expect(r.plan.machining.physicalTarget?.wcsMm).toBeCloseTo(-5, 9)
    expect(r.plan.machining.cutterCenterEnd?.wcsMm).toBeCloseTo(-4.7, 9)
  })

  it('Adaptive, floor finishing OFF, floor stock 0.3: worker bottom -4.7 with zero floor stock', () => {
    const r = resolve('adaptive_clearing_2d', 0.3, false)
    expect(r.workerHeights.bottomHeight).toBeCloseTo(-4.7, 9)
    expect(r.workerFloorStockToLeaveMm).toBe(0)
  })

  it('Adaptive, floor finishing ON, floor stock 0: worker bottom -5 with zero floor stock', () => {
    const r = resolve('adaptive_clearing_2d', 0, true)
    expect(r.workerHeights.bottomHeight).toBeCloseTo(-5, 9)
    expect(r.workerFloorStockToLeaveMm).toBe(0)
  })

  it('Pocket has no floor finishing: the flag changes nothing', () => {
    const r = resolve('pocket_2d', 0.3, true)
    expect(r.workerHeights.bottomHeight).toBeCloseTo(-4.7, 9)
    expect(r.workerFloorStockToLeaveMm).toBe(0)
  })
})
