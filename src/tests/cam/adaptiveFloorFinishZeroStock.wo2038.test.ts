// WO-2038: Adaptive floor finish with no floor stock cuts nothing twice.
//
// Operator at the machine, 2026-09-26, during the air run: "why is it repeating the
// Adaptive at the final Z step down?" Full Suite Setup 1 / Adaptive Clearing 1 has
// floor finishing ON and floor stock 0, so the rough bottom already sat on the true
// floor and the floor replay cut the whole final level a second time, in air.
//
// Runs his file through the production compute (the store's computeOperationToolpath,
// the same worker path the app uses). With WO2038_EVIDENCE=<label> set it also writes
// a side-view SVG and the numbers into src/tests/evidence/WO-2038/.
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { typedMock } from '../support/typedMock'
import type { ToolpathMove } from '../../types'

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

const EVIDENCE = process.env.WO2038_EVIDENCE
const EVIDENCE_DIR = join(process.cwd(), 'src/tests/evidence/WO-2038')
const OP = 'Adaptive Clearing 1'

interface Variant { floorFinish: boolean; floorStock: number }
interface Generated { moves: ToolpathMove[]; cutTimeSec: number | null }

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
  }
  expect(op.errorMessage ?? '').toBe('')
  const originZ = project.setups[0].wcs.origin.z
  return {
    moves: (op.toolpathMoves ?? []).map(m => ({ ...m, z: m.z - originZ })),
    cutTimeSec: op.estimatedCutTimeMs !== undefined ? +(op.estimatedCutTimeMs / 1000).toFixed(1) : null,
  }
}

const r3 = (z: number): number => Math.round(z * 1000) / 1000
const CUTTING = new Set(['cut', 'wall_follow', 'finish'])
const cutting = (moves: readonly ToolpathMove[]): ToolpathMove[] => moves.filter(m => CUTTING.has(m.role ?? ''))

/** Cutting moves per Z level, deepest first. */
function perLevel(moves: readonly ToolpathMove[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const m of cutting(moves)) out[r3(m.z)] = (out[r3(m.z)] ?? 0) + 1
  return out
}

/** Adaptive cut XY at `z` (role cut) that is cut AGAIN at the same Z by a finish move:
 *  the replay signature. */
function replayedAt(moves: readonly ToolpathMove[], z: number): number {
  const key = (m: ToolpathMove): string => `${m.x.toFixed(4)},${m.y.toFixed(4)}`
  const rough = new Set(moves.filter(m => m.role === 'cut' && r3(m.z) === z).map(key))
  return moves.filter(m => m.role === 'finish' && r3(m.z) === z && rough.has(key(m))).length
}

function summary(label: string, gen: Generated): Record<string, unknown> {
  return { label, moves: gen.moves.length, cuttingMoves: cutting(gen.moves).length, cutTimeSec: gen.cutTimeSec, perLevel: perLevel(gen.moves) }
}

/** Side view (X across, Z up) of the cutting moves, one colour per role. */
function sideViewSvg(title: string, gen: Generated): string {
  const W = 1200, H = 520, pad = 60
  const cuts = cutting(gen.moves)
  const xs = cuts.map(m => m.x), zs = cuts.map(m => m.z)
  const x0 = Math.min(...xs), x1 = Math.max(...xs)
  const z0 = Math.min(...zs) - 0.5, z1 = Math.max(0.5, Math.max(...zs) + 0.5)
  const sx = (x: number): number => pad + (x - x0) / (x1 - x0 || 1) * (W - 2 * pad)
  const sz = (z: number): number => pad + (z1 - z) / (z1 - z0 || 1) * (H - 2 * pad)
  const colour: Record<string, string> = { cut: '#1f77b4', wall_follow: '#2ca02c', finish: '#d62728' }
  const levels = perLevel(gen.moves)
  const rows = Object.entries(levels).sort((a, b) => Number(b[0]) - Number(a[0]))
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="sans-serif">`,
    `<rect width="${W}" height="${H}" fill="#fff"/>`,
    `<text x="${pad}" y="28" font-size="18">${title}</text>`,
    `<text x="${pad}" y="48" font-size="13">moves ${gen.moves.length}, cut time ${gen.cutTimeSec ?? '?'} s. Blue = adaptive cut, green = wall follow, red = finish (floor replay / wall finish). Side view: X across, Z up.</text>`,
  ]
  for (const [z, n] of rows) {
    const y = sz(Number(z))
    parts.push(`<line x1="${pad}" y1="${y}" x2="${W - pad}" y2="${y}" stroke="#ccc" stroke-dasharray="4 4"/>`)
    parts.push(`<text x="4" y="${y + 4}" font-size="12">Z ${z}</text>`)
    parts.push(`<text x="${W - pad + 4}" y="${y + 4}" font-size="11">${n}</text>`)
  }
  // Each role on its own vertical nudge so a replay at one Z is visible as a second band.
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

describe('WO-2038: Full Suite Setup 1 Adaptive Clearing 1 floor finishing through the production compute', () => {
  let zeroStock: Generated
  let floorOff: Generated
  let withStock: Generated
  const FLOOR = -5

  beforeAll(async () => {
    zeroStock = await generate({ floorFinish: true, floorStock: 0 })
    floorOff = await generate({ floorFinish: false, floorStock: 0 })
    withStock = await generate({ floorFinish: true, floorStock: 0.3 })
    const report = [
      summary('floorFinish ON, floor stock 0 (his file)', zeroStock),
      summary('floorFinish OFF, floor stock 0', floorOff),
      summary('floorFinish ON, floor stock 0.3', withStock),
    ]
    console.info('[WO-2038]', JSON.stringify(report))
    if (EVIDENCE) {
      writeFileSync(join(EVIDENCE_DIR, `${EVIDENCE}-numbers.json`), JSON.stringify(report, null, 2) + '\n')
      writeFileSync(join(EVIDENCE_DIR, `${EVIDENCE}-zero-stock-side.svg`),
        sideViewSvg(`WO-2038 ${EVIDENCE}: Adaptive Clearing 1, floor finishing ON, floor stock 0`, zeroStock))
      writeFileSync(join(EVIDENCE_DIR, `${EVIDENCE}-stock-0.3-side.svg`),
        sideViewSvg(`WO-2038 ${EVIDENCE}: Adaptive Clearing 1, floor finishing ON, floor stock 0.3`, withStock))
    }
  }, 900_000)

  it('his settings cut to the floor at -5', () => {
    const deepest = Math.min(...cutting(zeroStock.moves).map(m => r3(m.z)))
    expect(deepest).toBe(FLOOR)
    expect(zeroStock.moves.filter(m => m.role === 'cut' && r3(m.z) === FLOOR).length).toBeGreaterThan(0)
  })

  it('with floor stock 0 the floor level is cleared once: no replay of the adaptive stream at -5', () => {
    expect(replayedAt(zeroStock.moves, FLOOR)).toBe(0)
    // Nothing left on the floor means nothing to replay: the op is the one the same
    // settings produce with floor finishing off, move for move.
    expect(zeroStock.moves).toEqual(floorOff.moves)
  })

  it('with floor stock 0.3 the op roughs to -4.7 once and cleans the floor at -5', () => {
    // WO-2051: Smart Height V2 now hands the engine the true floor plus the floor
    // stock when floor finishing is on, so the rough levels stop at -4.7 and the one
    // floor pass cleans -5. The -4.7 level is still cut once, never replayed in air.
    const deepest = Math.min(...cutting(withStock.moves).map(m => r3(m.z)))
    expect(deepest).toBe(FLOOR)
    expect(withStock.moves.filter(m => m.role === 'cut' && r3(m.z) === -4.7).length).toBeGreaterThan(0)
    expect(replayedAt(withStock.moves, -4.7)).toBe(0)
  })
})

// When real floor stock DOES reach the engine, the rough levels stop above the floor
// and the one floor pass cleans the true floor, exactly as before.
describe('WO-2038: engine floor replay with floor stock still cleans the true floor once', () => {
  it('rough to -4.7, replay the stream at -5', async () => {
    const { buildAdaptiveClearingToolpath } = await import('../../lib/cam/adaptiveClearing2d/engine')
    const { ensureEngineClipperReady } = await import('../../lib/cam/adaptiveClearing2d/engine/clipperEngine')
    await ensureEngineClipperReady()
    const moves = await buildAdaptiveClearingToolpath({
      opId: 'op1', setupId: 's1',
      params: {
        geometryId: 'g1', loopIds: [], targetEngagement: 0.4, maxEngagement: 0.6,
        stepDistance: 1, thetaMax: Math.PI / 3, climb: true, rampAngle: 3, completionTolerance: 1,
        helixDiameter: 90, tolerance: 0.02, floorFinish: true,
      },
      heights: {
        clearanceHeight: 15, clearanceHeightMode: 'absolute', retractHeight: 5, feedHeight: 1,
        topHeight: 0, topHeightMode: 'absolute', bottomHeight: -5, bottomHeightMode: 'absolute',
      },
      passes: { stepdown: 2, stepover: 1.2, stockToLeave: 0, finishPasses: 0, springPasses: 0, floorStockToLeave: 0.3 },
      linking: { entryType: 'ramp_helical', rampAngle: 3, rampLength: 10, leadInRadius: 1, leadOutRadius: 1,
        retractType: 'full', transitionType: 'safe_height' },
      tool: {
        id: 't1', name: 'flat', type: 'flat_end_mill', diameter: 6, fluteLength: 20, shankDiameter: 6,
        overallLength: 60, numberOfFlutes: 2, material: 'carbide', coating: 'none', notes: '',
        feedsAndSpeeds: { default: { rpm: 10000, feedRate: 1000, plungeRate: 300, rampFeedrate: 600, depthOfCut: 2, stepover: 1.5 } },
      } as unknown as import('../../types').Tool,
      loops: [{ id: 'L0', closed: true, type: 'contour',
        points: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 }] }],
      wcsOrigin: { x: 0, y: 0, z: 0 },
    } as import('../../lib/cam/types').ACWorkerPayload)
    const levels = perLevel(moves)
    expect(Object.keys(levels).map(Number).sort((a, b) => b - a)).toEqual([-2, -4, -4.7, -5])
    expect(moves.filter(m => m.role === 'cut' && r3(m.z) === -5)).toHaveLength(0)
    // The floor pass is the -4.7 rough stream's own XY, replayed once at -5.
    const xy = (m: ToolpathMove): string => `${m.x.toFixed(4)},${m.y.toFixed(4)}`
    const rough = moves
      .filter(m => (m.role === 'cut' || m.role === 'wall_follow') && r3(m.z) === -4.7).map(xy)
    const floor = moves.filter(m => m.role === 'finish' && r3(m.z) === -5).map(xy)
    expect(rough.length).toBeGreaterThan(0)
    expect(floor).toEqual(rough)
  }, 120_000)
})
